/**
 * 键盘门控纯逻辑测试（工单31——ADR-0006 收官，#19 spec 三缝之三）：三件套直测——
 * 键盘模式归一仲裁（选区×浮层状态矩阵与变化沿）、Esc 全局定序（浮层>菜单>选区）、
 * 选区六键路由。每类语义的端到端代表用例归验收电池 P5.17（同相硬断言在真机事件流上做）。
 *
 * 键盘模式是多方共用的单通道（工单02 起 9 处调用点 + 工单31 选区生灭）：归一仲裁
 * 的核心契约是「后开优先不互相踩」——浮层关而选区仍非空保持 on、选区清空而浮层
 * 仍开保持 on，变化沿只在合成开态翻转时产生（通道不重发同向消息）。
 */
import { describe, expect, it } from 'vitest'
import {
  GATE_INITIAL,
  desiredKeyboardMode,
  escapePlan,
  keyRoutingContextOf,
  nextKeyboardGate,
  pasteFailureNotice,
  routeSelectionKey,
} from '../../src/renderer/keyboard-gate'
import type { KeyboardGateEvent, KeyboardGateState, KeyboardModeEdge } from '../../src/renderer/keyboard-gate'

/** 事件序列折叠：返回终态与沿序列（沿序列断言用字面量，独立于实现口径） */
function feed(state: KeyboardGateState, ...events: KeyboardGateEvent[]): { state: KeyboardGateState; edges: KeyboardModeEdge[] } {
  const edges: KeyboardModeEdge[] = []
  let s = state
  for (const e of events) {
    const r = nextKeyboardGate(s, e)
    s = r.state
    edges.push(r.edge)
  }
  return { state: s, edges }
}

const birth = { type: 'selection', nonEmpty: true } as const
const death = { type: 'selection', nonEmpty: false } as const
const openSearch = { type: 'overlay-opened', name: 'search' } as const
const closeSearch = { type: 'overlay-closed', name: 'search' } as const

// 工单100 通用键盘档：插件档声明走自己的事件种类进同一归约器（名字带插件 id 命名空间）
const tierA = { type: 'tier-acquired', name: 'plugin:search:search' } as const
const tierAOff = { type: 'tier-released', name: 'plugin:search:search' } as const
const tierB = { type: 'tier-acquired', name: 'plugin:note:input' } as const
const tierBOff = { type: 'tier-released', name: 'plugin:note:input' } as const

describe('desiredKeyboardMode 归一合成（唯一出处）', () => {
  it('选区空 + 无浮层 + 无插件档 = off', () => {
    expect(desiredKeyboardMode(false, [], [])).toBe(false)
  })
  it('选区非空 = on（无论浮层/插件档）', () => {
    expect(desiredKeyboardMode(true, [], [])).toBe(true)
    expect(desiredKeyboardMode(true, ['search'], [])).toBe(true)
    expect(desiredKeyboardMode(true, [], ['plugin:x:t'])).toBe(true)
  })
  it('任一浮层开 = on（无论选区/插件档）', () => {
    expect(desiredKeyboardMode(false, ['search'], [])).toBe(true)
    expect(desiredKeyboardMode(false, ['search', 'settings', 'rename'], [])).toBe(true)
    expect(desiredKeyboardMode(false, ['search'], ['plugin:x:t'])).toBe(true)
  })
  // 工单100 通用键盘档：插件档声明进同一归一合成（desired 第三项）——不是第二条通道
  it('任一插件档在持 = on（无论选区/浮层）', () => {
    expect(desiredKeyboardMode(false, [], ['plugin:search:search'])).toBe(true)
    expect(desiredKeyboardMode(false, [], ['plugin:a:input', 'plugin:b:input'])).toBe(true)
    expect(desiredKeyboardMode(false, ['settings'], ['plugin:search:search'])).toBe(true)
  })
  it('插件档全释放且无浮层无选区 = off', () => {
    expect(desiredKeyboardMode(false, [], [])).toBe(false)
  })
})

describe('nextKeyboardGate 选区生灭变化沿（同相的构造保证）', () => {
  it('off 起点：选区生 → 沿 on，状态翻 true', () => {
    const { state, edges } = feed(GATE_INITIAL, birth)
    expect(edges).toEqual(['on'])
    expect(state.on).toBe(true)
    expect(state.selectionNonEmpty).toBe(true)
  })
  it('选区保持非空再报（Ctrl 点选追加第二条）→ 无沿不重发', () => {
    const { edges } = feed(GATE_INITIAL, birth, birth)
    expect(edges).toEqual(['on', null])
  })
  it('选区灭 → 沿 off', () => {
    const { state, edges } = feed(GATE_INITIAL, birth, death)
    expect(edges).toEqual(['on', 'off'])
    expect(state.on).toBe(false)
  })
  it('空上报空（reconcile 无剔除）→ 无沿', () => {
    const { edges } = feed(GATE_INITIAL, death)
    expect(edges).toEqual([null])
  })
})

describe('nextKeyboardGate 浮层开合（后开优先不互相踩）', () => {
  it('空选区浮层开 → 沿 on；浮层关 → 沿 off', () => {
    const { edges } = feed(GATE_INITIAL, openSearch, closeSearch)
    expect(edges).toEqual(['on', 'off'])
  })
  it('关键反踩：浮层关而选区仍非空 → 保持 on（无沿）', () => {
    const { state, edges } = feed(GATE_INITIAL, birth, openSearch, closeSearch)
    expect(edges).toEqual(['on', null, null])
    expect(state.on).toBe(true)
    expect(state.overlays).toEqual([])
  })
  it('关键反踩：选区生而浮层开着 → 键盘已在浮层手上（无沿）', () => {
    const { state, edges } = feed(GATE_INITIAL, openSearch, birth)
    expect(edges).toEqual(['on', null])
    expect(state.on).toBe(true)
  })
  it('选区灭而浮层开着 → 键盘归浮层（无沿）；浮层随后关 → 沿 off', () => {
    const { edges } = feed(GATE_INITIAL, birth, openSearch, death, closeSearch)
    expect(edges).toEqual(['on', null, null, 'off'])
  })
  it('重复开同名浮层是幂等噪声（无沿不重发），关闭即正常 off', () => {
    const { edges } = feed(GATE_INITIAL, openSearch, openSearch, closeSearch)
    expect(edges).toEqual(['on', null, 'off'])
  })
  it('关未知名的浮层是噪声（无沿）', () => {
    const { edges } = feed(GATE_INITIAL, { type: 'overlay-closed', name: 'ghost' })
    expect(edges).toEqual([null])
  })
  it('双浮层叠开：关掉一个键盘仍在（无沿），关掉最后一个才 off', () => {
    const { edges, state } = feed(
      GATE_INITIAL,
      openSearch,
      { type: 'overlay-opened', name: 'settings' },
      closeSearch,
      { type: 'overlay-closed', name: 'settings' },
    )
    expect(edges).toEqual(['on', null, null, 'off'])
    expect(state.on).toBe(false)
  })
})

describe('nextKeyboardGate 真机序列（重命名全程，工单28 既有流程过新仲裁）', () => {
  it('右键切单选生 → 开编辑（保持 on）→ 关编辑（选区仍在，保持 on）→ 空白清空灭 → off', () => {
    const { edges } = feed(
      GATE_INITIAL,
      birth,
      { type: 'overlay-opened', name: 'rename' },
      { type: 'overlay-closed', name: 'rename' },
      death,
    )
    expect(edges).toEqual(['on', null, null, 'off'])
  })
  it('删除确认层关（确认执行）后选区仍非空 → 保持 on；快照剔除条目灭 → off', () => {
    const { edges } = feed(
      GATE_INITIAL,
      birth,
      { type: 'overlay-opened', name: 'trash-confirm' },
      { type: 'overlay-closed', name: 'trash-confirm' },
      death,
    )
    expect(edges).toEqual(['on', null, null, 'off'])
  })
})

describe('nextKeyboardGate 插件键盘档（工单100：同一归约器，档位事件不另开通道）', () => {
  it('档位请求 → 沿 on；释放 → 沿 off（空选区无浮层）', () => {
    const { state, edges } = feed(GATE_INITIAL, tierA, tierAOff)
    expect(edges).toEqual(['on', 'off'])
    expect(state.on).toBe(false)
    expect(state.tiers).toEqual([])
  })
  it('同向不重发：重复请求同名档是幂等噪声（无沿），未持拿就释放也是噪声', () => {
    const { edges } = feed(GATE_INITIAL, tierA, tierA, tierAOff, tierAOff)
    expect(edges).toEqual(['on', null, 'off', null])
  })
  it('多插件并存：两档同持只产生一次 on 沿；释放其一键盘仍在，全释放才 off', () => {
    const { state, edges } = feed(GATE_INITIAL, tierA, tierB, tierAOff, tierBOff)
    expect(edges).toEqual(['on', null, null, 'off'])
    expect(state.tiers).toEqual([])
  })
  it('关键反踩（与浮层同构）：档位释放而选区仍非空 → 保持 on（无沿不互踩）', () => {
    const { state, edges } = feed(GATE_INITIAL, birth, tierA, tierAOff)
    expect(edges).toEqual(['on', null, null])
    expect(state.on).toBe(true)
    expect(state.tiers).toEqual([])
  })
  it('关键反踩（与浮层同构）：选区清空而档位在持 → 键盘归档位（无沿）；档位随后释放 → off', () => {
    const { edges, state } = feed(GATE_INITIAL, birth, tierA, death, tierAOff)
    expect(edges).toEqual(['on', null, null, 'off'])
    expect(state.on).toBe(false)
  })
  it('与浮层组合矩阵：浮层关而档位在持 → 保持 on；档位关而浮层开 → 保持 on', () => {
    const { edges } = feed(GATE_INITIAL, openSearch, tierA, closeSearch)
    expect(edges).toEqual(['on', null, null])
    const { edges: edges2 } = feed(GATE_INITIAL, tierA, openSearch, tierAOff)
    expect(edges2).toEqual(['on', null, null])
  })
  it('档位与浮层互不顶替：同名异种各行其账（浮层 search 与档位 plugin:search:search 同时在册）', () => {
    const { state, edges } = feed(GATE_INITIAL, openSearch, tierA, closeSearch)
    expect(edges).toEqual(['on', null, null])
    expect(state.overlays).toEqual([])
    expect(state.tiers).toEqual(['plugin:search:search'])
    expect(state.on).toBe(true)
  })
})

describe('keyRoutingContextOf 键盘路由上下文合成（工单31 捕获段装配的纯逻辑出处；工单100 档位并入）', () => {
  const GATE_WITH_TIER: KeyboardGateState = { ...GATE_INITIAL, tiers: ['plugin:search:search'] }

  it('档位在持等同浮层开：Esc 归档位自处理、六键不接管（浮层优先同构）', () => {
    expect(keyRoutingContextOf(GATE_WITH_TIER, false)).toEqual({
      overlayOpen: true,
      menuOpen: false,
      selectionNonEmpty: false,
    })
    // 档位在持期间六键放行（按键落在档位持有者聚焦元素上）
    const ctx = keyRoutingContextOf(GATE_WITH_TIER, false)
    ctx.selectionNonEmpty = true
    expect(routeSelectionKey('a', true, ctx)).toBeNull()
    expect(routeSelectionKey('v', true, ctx)).toBeNull()
  })
  it('浮层与档位任一在即 overlayOpen；全空则否', () => {
    expect(keyRoutingContextOf({ ...GATE_INITIAL, overlays: ['rename'] }, false).overlayOpen).toBe(true)
    expect(keyRoutingContextOf(GATE_INITIAL, true).overlayOpen).toBe(false)
    expect(keyRoutingContextOf(GATE_INITIAL, false)).toEqual({
      overlayOpen: false,
      menuOpen: false,
      selectionNonEmpty: false,
    })
  })
  it('菜单与选区字段直通透传', () => {
    const gate: KeyboardGateState = { ...GATE_INITIAL, selectionNonEmpty: true }
    expect(keyRoutingContextOf(gate, true)).toEqual({
      overlayOpen: false,
      menuOpen: true,
      selectionNonEmpty: true,
    })
  })
})

describe('escapePlan Esc 全局定序（ADR-0006：浮层 > 菜单 > 选区）', () => {
  it('浮层开着不参与（双否）：既有浮层自处理保持不动，Esc 不在此吞', () => {
    expect(escapePlan({ overlayOpen: true, menuOpen: true, selectionNonEmpty: true })).toEqual({
      closeMenu: false,
      clearSelection: false,
    })
  })
  it('菜单开 + 选区非空 → 只关菜单不清选区（关键定序）', () => {
    expect(escapePlan({ overlayOpen: false, menuOpen: true, selectionNonEmpty: true })).toEqual({
      closeMenu: true,
      clearSelection: false,
    })
  })
  it('菜单开 + 选区空 → 关菜单（分区空白菜单同语义）', () => {
    expect(escapePlan({ overlayOpen: false, menuOpen: true, selectionNonEmpty: false })).toEqual({
      closeMenu: true,
      clearSelection: false,
    })
  })
  it('无菜单 + 选区非空 → 清空选区', () => {
    expect(escapePlan({ overlayOpen: false, menuOpen: false, selectionNonEmpty: true })).toEqual({
      closeMenu: false,
      clearSelection: true,
    })
  })
  it('无事可做 → 双否（不拦键，放行给默认行为）', () => {
    expect(escapePlan({ overlayOpen: false, menuOpen: false, selectionNonEmpty: false })).toEqual({
      closeMenu: false,
      clearSelection: false,
    })
  })
})

describe('pasteFailureNotice 键盘粘贴失败观感（评审 c2：键路静默只存证）', () => {
  it('菜单路保持提示条（error 原样上浮）', () => {
    expect(pasteFailureNotice('ctx-menu', '剪贴板没有文件')).toBe('剪贴板没有文件')
    expect(pasteFailureNotice('ctx-menu', '读取剪贴板失败')).toBe('读取剪贴板失败')
  })
  it('键路静默（null = 不弹提示条，仅 rejected/failed 存证）', () => {
    expect(pasteFailureNotice('keyboard', '剪贴板没有文件')).toBeNull()
    expect(pasteFailureNotice('keyboard', '读取剪贴板失败')).toBeNull()
  })
})

describe('routeSelectionKey 选区六键路由', () => {
  const READY = { selectionNonEmpty: true, overlayOpen: false, menuOpen: false }

  it('六键各就各位', () => {
    expect(routeSelectionKey('Delete', false, READY)).toBe('delete')
    expect(routeSelectionKey('Enter', false, READY)).toBe('open')
    expect(routeSelectionKey('a', true, READY)).toBe('select-all')
    expect(routeSelectionKey('c', true, READY)).toBe('copy')
    expect(routeSelectionKey('x', true, READY)).toBe('cut')
    expect(routeSelectionKey('v', true, READY)).toBe('paste')
  })
  it('大写键名同判（大写锁定态）', () => {
    expect(routeSelectionKey('C', true, READY)).toBe('copy')
    expect(routeSelectionKey('V', true, READY)).toBe('paste')
  })
  it('空选区不接管（六键全放行）', () => {
    const ctx = { ...READY, selectionNonEmpty: false }
    expect(routeSelectionKey('Delete', false, ctx)).toBeNull()
    expect(routeSelectionKey('Enter', false, ctx)).toBeNull()
    expect(routeSelectionKey('a', true, ctx)).toBeNull()
    expect(routeSelectionKey('c', true, ctx)).toBeNull()
    expect(routeSelectionKey('x', true, ctx)).toBeNull()
    expect(routeSelectionKey('v', true, ctx)).toBeNull()
  })
  it('浮层开着不接管（浮层优先：搜索/设置激活期间键盘归浮层）', () => {
    const ctx = { ...READY, overlayOpen: true }
    expect(routeSelectionKey('Delete', false, ctx)).toBeNull()
    expect(routeSelectionKey('a', true, ctx)).toBeNull()
    expect(routeSelectionKey('v', true, ctx)).toBeNull()
  })
  it('菜单开层期间不接管（菜单时刻键盘不归桌面）', () => {
    const ctx = { ...READY, menuOpen: true }
    expect(routeSelectionKey('Delete', false, ctx)).toBeNull()
    expect(routeSelectionKey('c', true, ctx)).toBeNull()
  })
  it('组合外按键放行：Ctrl+Enter / Ctrl+Delete / Ctrl+D / 无修饰字母', () => {
    expect(routeSelectionKey('Enter', true, READY)).toBeNull()
    expect(routeSelectionKey('Delete', true, READY)).toBeNull()
    expect(routeSelectionKey('d', true, READY)).toBeNull()
    expect(routeSelectionKey('a', false, READY)).toBeNull()
  })
})
