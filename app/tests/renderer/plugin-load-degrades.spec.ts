/**
 * 插件装载失败的静默降级（工单179 验收标准：插件装载失败时面板静默降级、照常工作）。
 *
 * 组卡是投放型插件包——投放目录可能被删成半截（拷贝中途断、manifest 落空、entry 语法错）。
 * 那时面板不得跟着坏：宿主只留存证（plugin-load-failed）、不建容器、不抛，面板其余部分照旧。
 * 本例用真动态 import（不存在的 deck-plugin:// 入口必然失败）走真失败路径，不桩 import。
 */
import { describe, expect, it, vi } from 'vitest'
import type { PanelSnapshot, PluginInfo } from '../../src/shared/contract'
import { syncPlugins, type PluginRuntimeDeps } from '../../src/renderer/plugins'

const SNAP = { desktop: { fingerprint: 'f', items: [], plan: { docs: [] } } } as unknown as PanelSnapshot

/** 面板其余部分照旧 = 失败路径不碰 document（本例根本不提供 document，碰了就会炸） */
function deps() {
  const notes: Array<{ type: string; payload?: Record<string, unknown> }> = []
  const d: PluginRuntimeDeps = {
    notify: (type, payload) => { notes.push({ type, payload }) },
    invoke: (() => { throw new Error('本例不触桥') }) as PluginRuntimeDeps['invoke'],
    on: () => () => { /* 退订桩 */ },
    onKeyboardTier: () => { /* 键盘档不在本例断言面 */ },
    onDomChanged: () => { /* 热区不在本例断言面 */ },
  }
  return { deps: d, notes }
}

function brokenInfo(entry: string): PluginInfo {
  return { id: 'doc-group-cards', name: 'DOC GROUPS', version: '0.1.0', entry, capabilities: ['desktop'], order: 70, status: 'ok', error: null, revision: 1 }
}

describe('组卡装载失败 → 面板静默降级（工单179）', () => {
  it('入口装载不了：只留 plugin-load-failed 存证，不抛、不建容器，面板其余部分照常', async () => {
    vi.stubGlobal('document', undefined) // 失败路径若误碰 DOM，这里会直接炸出来
    const { deps: d, notes } = deps()

    expect(() => syncPlugins([brokenInfo('deck-plugin://doc-group-cards/gone.js?v=1')], SNAP, d)).not.toThrow()
    // import 失败是异步落地的：等存证到达为止（与 plugin-unmount-reclaim 同一纪律）
    for (let i = 0; i < 200 && !notes.some((n) => n.type === 'plugin-load-failed'); i += 1) {
      await new Promise((r) => setTimeout(r, 10))
    }
    // 断言到 id 上：id 只可能由内核装载失败那条 catch 分支写进 payload，
    // 故本断言不可能空过——真跑到失败路径才有这条存证
    expect(notes.filter((n) => n.type === 'plugin-load-failed')).toEqual([
      { type: 'plugin-load-failed', payload: { id: 'doc-group-cards', message: expect.any(String) } },
    ])
    expect(notes.some((n) => n.type === 'plugin-mounted')).toBe(false)
    vi.unstubAllGlobals()
  })
})
