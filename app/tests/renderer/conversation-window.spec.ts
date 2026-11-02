// 对话窗发送反馈（工单364）：真实控件 → 渲染层 → 桥接 → 会话服务 → 确定性 ACP fake →
// 变化推送 → 转写更新。既有「直接调 conversation/prompt」的测试保留在
// tests/conversation/service.spec.ts，本文件补的是它没覆盖的那条路：真实控件。
//
// 缝说明：对话方法全走真 BridgeService.dispatch（真契约），变化推送经
// BridgeService.subscribe('conversation/changed') 同一路转发；与本票无关的
// install/*、credentials/* 方法在桩里回空形状（不另造插件/凭证实现）。
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { installConversationDomStub, textOf, type ConversationDomStub } from './conversation-dom-stub'
import { makeConversationBridgeHarness, until, type ConversationBridgeHarness } from '../conversation/bridge-harness'

const HTML_PATH = path.resolve(__dirname, '../../src/renderer/conversation.html')

/** 桥接实现：对话方法走真 BridgeService，其余走桩的默认空形状 */
function bridgeInvoke(harness: ConversationBridgeHarness, overrides: Record<string, (payload: unknown) => Promise<unknown>> = {}) {
  return async (method: string, payload: unknown): Promise<unknown> => {
    const override = overrides[method]
    if (override) return override(payload)
    if (method.startsWith('conversation/')) {
      // 真机里请求经 IPC 往返（主进程在后续任务里才处理），变化推送也是之后才到。
      // 这里同样错一拍——否则推送同步到达会让「立即回显」被假象盖住（改动前也过）。
      await new Promise((r) => setTimeout(r, 0))
      return harness.bridge.invoke(method as never, payload as never)
    }
    return undefined
  }
}

/** 装 DOM 桩并加载对话窗渲染层（模块级副作用即页面启动）；变化推送按窗转发 */
async function mountWindow(
  harness: ConversationBridgeHarness,
  overrides: Record<string, (payload: unknown) => Promise<unknown>> = {},
): Promise<ConversationDomStub> {
  const dom = installConversationDomStub({ invoke: bridgeInvoke(harness, overrides) })
  harness.bridge.subscribe('conversation/changed', (payload) => dom.emit('conversation/changed', payload))
  vi.resetModules()
  await import('../../src/renderer/conversation')
  return dom
}

/** 装 DOM 桩并加载对话窗渲染层（不接内核——页面自身状态） */
async function loadConversationWindow(options: {
  invoke?: (method: string, payload: unknown) => Promise<unknown>
  withDeck?: boolean
} = {}): Promise<ConversationDomStub> {
  const dom = installConversationDomStub(options)
  vi.resetModules()
  await import('../../src/renderer/conversation')
  return dom
}

/** 转写里某段文本出现几次（乐观回显让位＝不重复显示） */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

afterEach(() => {
  vi.resetModules()
})

describe('对话窗发送反馈（工单364）', () => {
  it('页面静态初始态：输入与发送在 HTML 层即禁用（脚本没跑起来也不留死按钮）', () => {
    const html = fs.readFileSync(HTML_PATH, 'utf8')
    const input = html.match(/<textarea[^>]*id="prompt-input"[^>]*>/)?.[0] ?? ''
    const send = html.match(/<button[^>]*id="btn-send"[^>]*>/)?.[0] ?? ''
    expect(input).not.toBe('')
    expect(send).not.toBe('')
    expect(input).toMatch(/\sdisabled\b/)
    expect(send).toMatch(/\sdisabled\b/)
  })

  it('桥接不可用（preload 未装配）：初始化失败有可见诊断，输入与发送保持禁用', async () => {
    const dom = await loadConversationWindow({ withDeck: false })
    const input = dom.element('prompt-input')
    const send = dom.element('btn-send')
    expect(input.disabled).toBe(true)
    expect(send.disabled).toBe(true)
    const diagnostic = textOf(dom.element('init-error'))
    expect(diagnostic).toContain('初始化失败')
    expect(diagnostic).not.toBe('')
  })

  it('无会话：输入与发送禁用且给出「请先创建会话」的明确指导；点发送不静默（不发请求）', async () => {
    const harness = await makeConversationBridgeHarness('fullchain')
    try {
      const dom = await mountWindow(harness)
      await until(() => textOf(dom.element('transcript')).includes('请先创建会话'))
      expect(dom.element('prompt-input').disabled).toBe(true)
      expect(dom.element('btn-send').disabled).toBe(true)
      // 点发送：不发起任何对话请求（绝不静默死按钮），且给出可见指导
      dom.element('btn-send').dispatch('click')
      expect(dom.calls('conversation/prompt').length).toBe(0)
      expect(textOf(dom.element('transcript'))).toContain('当前没有可发送的会话')
    } finally {
      await harness.cleanup()
    }
  })

  it('有会话：点发送立即回显用户输入并进入回复中；变化推送后转写含权威条目（不重复）', async () => {
    const harness = await makeConversationBridgeHarness('fullchain')
    try {
      await harness.createSession('验收会话')
      const dom = await mountWindow(harness)
      await until(() => !dom.element('btn-send').disabled)
      const input = dom.element('prompt-input')
      input.value = '你好'
      dom.element('btn-send').dispatch('click')
      // 立即：不等内核回执，先看见自己的消息 + 回复中
      expect(textOf(dom.element('transcript'))).toContain('你好')
      expect(dom.element('status-line').textContent).toContain('回复中')
      // 变化推送到达：权威转写（含后端回复）
      await until(() => textOf(dom.element('transcript')).includes('FAKE HELLO'))
      const transcript = textOf(dom.element('transcript'))
      expect(transcript).toContain('你好')
      expect(transcript).toContain('FAKE HELLO')
      // 乐观回显让位：不重复显示同一条用户消息
      expect(occurrences(transcript, '你好')).toBe(1)
    } finally {
      await harness.cleanup()
    }
  })

  it('按 Enter 发送（与点按钮同一条路）；Shift+Enter 不发送（换行行为不变）', async () => {
    const harness = await makeConversationBridgeHarness('fullchain')
    try {
      await harness.createSession()
      const dom = await mountWindow(harness)
      await until(() => !dom.element('btn-send').disabled)
      const input = dom.element('prompt-input')
      input.value = '换行测试'
      const shifted = dom.element('prompt-input').dispatch('keydown', { key: 'Enter', shiftKey: true })
      expect(shifted.defaultPrevented).toBe(false)
      expect(dom.calls('conversation/prompt').length).toBe(0)
      const entered = dom.element('prompt-input').dispatch('keydown', { key: 'Enter' })
      expect(entered.defaultPrevented).toBe(true)
      expect(dom.calls('conversation/prompt').length).toBe(1)
      await until(() => textOf(dom.element('transcript')).includes('FAKE HELLO'))
    } finally {
      await harness.cleanup()
    }
  })

  it('桥接拒绝：可见错误 + 草稿恢复 + 不自动重试', async () => {
    const harness = await makeConversationBridgeHarness('fullchain')
    try {
      await harness.createSession()
      const dom = await mountWindow(harness, {
        'conversation/prompt': async () => { throw new Error('bridge refused: 内核未受理') },
      })
      await until(() => !dom.element('btn-send').disabled)
      dom.element('prompt-input').value = '要发的内容'
      dom.element('btn-send').dispatch('click')
      await until(() => textOf(dom.element('transcript')).includes('发送失败'))
      expect(textOf(dom.element('transcript'))).toContain('bridge refused')
      expect(dom.element('prompt-input').value).toBe('要发的内容')
      // 不自动重试：只发起过一次
      expect(dom.calls('conversation/prompt').length).toBe(1)
    } finally {
      await harness.cleanup()
    }
  })

  it('同步异常（invoke 抛错）：可见错误 + 草稿恢复', async () => {
    const harness = await makeConversationBridgeHarness('fullchain')
    try {
      await harness.createSession()
      const dom = await mountWindow(harness, {
        'conversation/prompt': async () => { throw new Error('同步异常：内核通道炸了') },
      })
      await until(() => !dom.element('btn-send').disabled)
      dom.element('prompt-input').value = '同步异常用例'
      dom.element('btn-send').dispatch('click')
      await until(() => textOf(dom.element('transcript')).includes('发送失败'))
      expect(textOf(dom.element('transcript'))).toContain('同步异常')
      expect(dom.element('prompt-input').value).toBe('同步异常用例')
    } finally {
      await harness.cleanup()
    }
  })

  it('后端回合失败：可见错误 + 草稿恢复（真链：ACP fake 回错误回执）', async () => {
    const harness = await makeConversationBridgeHarness('prompt-error')
    try {
      await harness.createSession()
      const dom = await mountWindow(harness)
      await until(() => !dom.element('btn-send').disabled)
      dom.element('prompt-input').value = '会失败的一轮'
      dom.element('btn-send').dispatch('click')
      await until(() => textOf(dom.element('transcript')).includes('发送失败'))
      expect(textOf(dom.element('transcript'))).toContain('发送失败')
      // 主进程侧的事实：这轮确实是在后端失败的（不是桥接拒绝）
      expect(harness.logs.some((e) => e.type === 'conversation-prompt-error')).toBe(true)
      // 草稿恢复：失败的一轮不静默丢失
      await until(() => dom.element('prompt-input').value === '会失败的一轮')
      // 不自动重试
      expect(dom.calls('conversation/prompt').length).toBe(1)
    } finally {
      await harness.cleanup()
    }
  })

  it('后端等待期间取消入口可用；取消后回合收束（不新增固定超时自动判失败）', async () => {
    const harness = await makeConversationBridgeHarness('slow')
    try {
      await harness.createSession()
      const dom = await mountWindow(harness)
      await until(() => !dom.element('btn-send').disabled)
      dom.element('prompt-input').value = '数到很久'
      dom.element('btn-send').dispatch('click')
      // 后端确实在等（权威状态 busy），此时取消入口可用
      await until(() => harness.service.sessions()[0]?.status === 'busy')
      expect(dom.element('btn-cancel').disabled).toBe(false)
      dom.element('btn-cancel').dispatch('click')
      await until(() => textOf(dom.element('transcript')).includes('(cut)'))
      expect(dom.calls('conversation/cancel').length).toBe(1)
      // 收束后回到可发送态
      await until(() => dom.element('btn-send').disabled === false)
    } finally {
      await harness.cleanup()
    }
  })
})
