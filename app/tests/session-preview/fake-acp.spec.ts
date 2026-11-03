/**
 * fake ACP → 会话预览投影的整链回归（工单381 验收第 5 条的「fake ACP」面）：
 * 用 tests/conversation/fake-acp-agent.mjs 的真实 ACP 帧驱动 ConversationService，
 * 再把它的 ConversationSessionView 喂进 dshCards——证明 DSH 的 label 是真名、
 * busy 是真执行、pendingPermission 是真等待，且结束/空闲后被过滤。
 */
import { afterAll, describe, expect, it } from 'vitest'
import { makeConversationBridgeHarness, until } from '../conversation/bridge-harness'
import type { ConversationBridgeHarness } from '../conversation/bridge-harness'
import { dshCards } from '../../src/main/session-preview/projection'

const harnesses: ConversationBridgeHarness[] = []

async function open(scenario: string): Promise<ConversationBridgeHarness> {
  const h = await makeConversationBridgeHarness(scenario)
  harnesses.push(h)
  return h
}

afterAll(async () => {
  for (const h of harnesses) {
    try { await h.cleanup() } catch { /* 尽力 */ }
  }
})

describe('DSH 投影 × fake ACP（真实 ACP 帧、真实 pendingPermission）', () => {
  it('创建后 label 原样进入投影；权限请求在途 = 等待询问（真名真等待）', async () => {
    const h = await open('permission')
    const { id } = await h.createSession('等待确认的会话')
    const promptDone = h.service.prompt(id, 'escalate')
    const pending = await until(() => h.service.sessions().find((s) => s.id === id)?.pendingPermission ?? null)
    expect(pending.options.map((o) => o.optionId)).toEqual(['allow-once', 'reject-once'])

    const cards = dshCards(h.service.sessions(), Date.now())
    const card = cards.find((c) => c.id === id)
    expect(card).toBeDefined()
    expect(card).toMatchObject({
      tool: 'dsh',
      title: '等待确认的会话',
      project: expect.any(String),
      status: 'waiting',
    })

    // 裁决后回到 ready = 空闲 → 不占卡片（完成/空闲过滤）
    const resolved = await h.service.respondPermission(id, 'allow-once')
    expect(resolved.ok).toBe(true)
    await promptDone
    await until(() => h.service.sessions().find((s) => s.id === id)?.status === 'ready')
    expect(dshCards(h.service.sessions(), Date.now()).some((c) => c.id === id)).toBe(false)
  })

  it('turn 在途 = 执行中（busy 是真执行信号）；取消后回空闲被过滤', async () => {
    const h = await open('slow')
    const { id } = await h.createSession('执行中的会话')
    const promptDone = h.service.prompt(id, 'count')
    await until(() => h.service.sessions().find((s) => s.id === id)?.status === 'busy')
    const card = dshCards(h.service.sessions(), Date.now()).find((c) => c.id === id)
    expect(card).toMatchObject({ title: '执行中的会话', status: 'running' })

    await h.service.cancel(id)
    await promptDone
    await until(() => h.service.sessions().find((s) => s.id === id)?.status === 'ready')
    expect(dshCards(h.service.sessions(), Date.now()).some((c) => c.id === id)).toBe(false)
  })

  it('投影标题取会话真实 label（不拿 backend id 或项目名顶替）', async () => {
    const h = await open('slow')
    const { id } = await h.createSession('')
    const promptDone = h.service.prompt(id, 'count')
    await until(() => h.service.sessions().find((s) => s.id === id)?.status === 'busy')
    const view = h.service.sessions().find((s) => s.id === id)!
    const card = dshCards(h.service.sessions(), Date.now()).find((c) => c.id === id)
    expect(card?.title).toBe(view.label)
    expect(card?.title).not.toBe(id)
    await h.service.cancel(id)
    await promptDone
  })
})
