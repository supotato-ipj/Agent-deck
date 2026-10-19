/**
 * 停用→卸载→键盘档回收链（工单101 验收标准：停用正在持有键盘档的卡，键盘档被宿主回收）。
 *
 * 链路全走真件：插件清单失去该包（工单101 停用集过滤后的清单形状）→ syncPlugins 卸载
 * （plugins.ts unmountOne）→ reclaimPlugin 强制回收未释放的档 → 事件进真归约器
 * （keyboard-gate.ts，main.ts pluginDeps 同款 `plugin:<id>:<tier>` 命名空间）→ desired 翻转。
 * 插件模块用 tmp 目录真 .mjs（vitest 动态 import 走真装载），DOM 以最小桩替身
 * （vitest node 环境无 document；卸载链只触 createElement/remove，桩即充分）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PanelSnapshot, PluginInfo } from '../../src/shared/contract'
import { syncPlugins, type PluginRuntimeDeps } from '../../src/renderer/plugins'
import { GATE_INITIAL, nextKeyboardGate, type KeyboardGateState, type KeyboardModeEdge } from '../../src/renderer/keyboard-gate'

const SNAP = {} as PanelSnapshot // 停用集链不读快照段（探针包 capabilities 为空）

function stubDom(): void {
  vi.stubGlobal('document', {
    createElement: () => ({ className: '', dataset: {} as Record<string, string>, appendChild() { /* 桩 */ }, remove() { /* 桩 */ } }),
    getElementById: () => null,
    body: { appendChild() { /* 桩 */ } },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/** mount 即持键盘档的真模块（tmp .mjs；vitest 动态 import 真装载路径） */
function writeTierPlugin(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-tier-'))
  const file = path.join(dir, 'card.mjs')
  fs.writeFileSync(file, 'export default { mount(h) { h.holdKeyboardTier("input") } }', 'utf8')
  return file
}

function probeInfo(entry: string): PluginInfo {
  return { id: 'tierprobe', name: '档位探针', version: '1.0.0', entry, capabilities: [], order: 1, status: 'ok', error: null, revision: 1 }
}

/** 与 main.ts pluginDeps 同款命名空间进真归约器，收集事件与沿 */
function gateDeps() {
  const gate: { state: KeyboardGateState } = { state: GATE_INITIAL }
  const edges: Array<KeyboardModeEdge> = []
  const notes: Array<{ type: string; payload?: Record<string, unknown> }> = []
  const deps: PluginRuntimeDeps = {
    notify: (type, payload) => { notes.push({ type, payload }) },
    invoke: (() => { throw new Error('本链不触桥') }) as PluginRuntimeDeps['invoke'],
    on: () => () => { /* 退订桩 */ },
    onKeyboardTier: (id, tier, held) => {
      const result = nextKeyboardGate(gate.state, held
        ? { type: 'tier-acquired', name: `plugin:${id}:${tier}` }
        : { type: 'tier-released', name: `plugin:${id}:${tier}` })
      gate.state = result.state
      edges.push(result.edge)
    },
    onDomChanged: () => { /* 热区重声明不在本链断言面 */ },
  }
  return { deps, gate, edges, notes }
}

/**
 * 等真实挂载存证（挂载走 vite 首次转换，耗时随机器负载抖动——固定延时在全量并行下
 * 会在续体落地前超卖，改轮询 plugin-mounted 到达为止，与电池「先等再判」同一纪律）。
 */
async function waitForMounted(notes: Array<{ type: string }>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (notes.some((n) => n.type === 'plugin-mounted')) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`等待 plugin-mounted 超时（${timeoutMs}ms），已收到：${JSON.stringify(notes)}`)
}

describe('停用持有键盘档的插件包 → 宿主回收档位（工单101 × 工单100 衔接）', () => {
  it('清单含包 → 挂载持档（归约器翻 on）；清单剔除该包（停用集过滤后形状）→ 卸载强制回收（归约器翻 off）', async () => {
    stubDom()
    const entry = writeTierPlugin()
    const { deps, gate, edges, notes } = gateDeps()

    // 装载：插件 mount 即 holdKeyboardTier，档位进归一仲裁（desired on）
    syncPlugins([probeInfo(entry)], SNAP, deps)
    await waitForMounted(notes)
    expect(gate.state.tiers).toEqual(['plugin:tierprobe:input'])
    expect(edges).toEqual(['on'])
    expect(gate.state.on).toBe(true)

    // 停用：包被停用集过滤出清单（syncPlugins 收到的就是过滤后的名单）→ 卸载强制回收
    syncPlugins([], SNAP, deps)
    expect(gate.state.tiers).toEqual([])
    expect(edges).toEqual(['on', 'off'])
    expect(gate.state.on).toBe(false) // desired 翻转：键盘模式归零，无档位残留
  })

  it('插件自己释放过的档，卸载回收不再重复发释放沿（幂等噪声不进归约器）', async () => {
    stubDom()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-tier-clean-'))
    const entry = path.join(dir, 'card.mjs')
    // mount 持档后立即自行释放（插件守纪律的正道路径）
    fs.writeFileSync(entry, 'export default { mount(h) { h.holdKeyboardTier("input"); h.releaseKeyboardTier("input") } }', 'utf8')
    const { deps, gate, edges, notes } = gateDeps()

    syncPlugins([probeInfo(entry)], SNAP, deps)
    await waitForMounted(notes)
    expect(gate.state.tiers).toEqual([])
    expect(edges).toEqual(['on', 'off']) // acquire 沿 + 释放沿各一，卸载回收零补偿

    syncPlugins([], SNAP, deps)
    expect(edges).toEqual(['on', 'off'])
    expect(gate.state.on).toBe(false)
  })
})
