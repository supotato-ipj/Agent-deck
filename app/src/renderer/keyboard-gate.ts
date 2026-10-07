// 键盘门控全套（工单31，ADR-0006 收官，纯逻辑）：三件套——键盘模式归一仲裁、
// Esc 全局定序、选区六键路由。不含 DOM：渲染层只消费其输出（main.ts 单点接线），
// 离线直测 tests/renderer/keyboard-gate.spec.ts，真机端到端归验收电池 P5.17。
//
// 键盘模式是多方共用的单通道（工单02 起：搜索/设置浮层、删除确认层、重命名编辑
// 共 9 处调用点；工单31 增选区生灭）：归一仲裁把「开」的意图合成一处——
// 键盘模式 = 选区非空 OR 任一浮层开。ADR-0006 的「与浮层同一把开关、后开优先」
// 由此按构造成立：浮层关而选区仍非空 → 保持 on（不互相踩）；选区清空而浮层仍开
// → 键盘归浮层。变化沿只在合成开态翻转时产生，通道不重发同向消息——
// keyboard-mode-on/off 存证与选区生灭严格同相（电池硬断言口径）。

/** 门控状态：on = 已发送给宿主通道的开态（启动即 off，面板 focusable:false）；
 * selectionNonEmpty = 选区是否非空（applySelection 单点喂入，band 框选同过此口）；
 * overlays = 打开中的浮层名集（trash-confirm / rename / settings / search）；
 * tiers = 插件持拿中的键盘档名集（工单100 通用 API，宿主转交时已带插件 id 命名空间）。 */
export interface KeyboardGateState {
  readonly on: boolean
  readonly selectionNonEmpty: boolean
  readonly overlays: readonly string[]
  readonly tiers: readonly string[]
}

export const GATE_INITIAL: KeyboardGateState = { on: false, selectionNonEmpty: false, overlays: [], tiers: [] }

export type KeyboardGateEvent =
  /** 选区生灭（applySelection 单点：只看 names 空否，事件种类无关——生灭判定出口唯一） */
  | { type: 'selection'; nonEmpty: boolean }
  /** 浮层开（重命名编辑会话跨快照重锚不经历事件——键盘模式保持开） */
  | { type: 'overlay-opened'; name: string }
  /** 浮层关 */
  | { type: 'overlay-closed'; name: string }
  /** 插件键盘档请求占用（工单100 通用 API：具名声明进同一归一仲裁，不是第二条模式通道） */
  | { type: 'tier-acquired'; name: string }
  /** 插件键盘档释放（含宿主对未释放插件的强制回收——crash 安全） */
  | { type: 'tier-released'; name: string }

/** 通道变化沿：'on'/'off' = 需要发送 setKeyboardMode；null = 无沿（不重发同向消息） */
export type KeyboardModeEdge = 'on' | 'off' | null

export interface KeyboardGateResult {
  state: KeyboardGateState
  edge: KeyboardModeEdge
}

/** 期望开态的归一合成（唯一出处）：选区非空 OR 任一浮层开 OR 任一插件档在持（工单100） */
export function desiredKeyboardMode(
  selectionNonEmpty: boolean,
  overlays: readonly string[],
  tiers: readonly string[],
): boolean {
  return selectionNonEmpty || overlays.length > 0 || tiers.length > 0
}

const edgeOf = (prev: boolean, desired: boolean): KeyboardModeEdge =>
  desired === prev ? null : desired ? 'on' : 'off'

/** 门控归约器：一个事件一次合成，沿只在 on 态翻转时产生（离线穷举见 spec） */
export function nextKeyboardGate(state: KeyboardGateState, event: KeyboardGateEvent): KeyboardGateResult {
  switch (event.type) {
    case 'selection': {
      const desired = desiredKeyboardMode(event.nonEmpty, state.overlays, state.tiers)
      return {
        state: { ...state, selectionNonEmpty: event.nonEmpty, on: desired },
        edge: edgeOf(state.on, desired),
      }
    }
    case 'overlay-opened': {
      if (state.overlays.includes(event.name)) return { state, edge: null } // 重复开：幂等噪声
      const overlays = [...state.overlays, event.name]
      const desired = desiredKeyboardMode(state.selectionNonEmpty, overlays, state.tiers)
      return { state: { ...state, overlays, on: desired }, edge: edgeOf(state.on, desired) }
    }
    case 'overlay-closed': {
      if (!state.overlays.includes(event.name)) return { state, edge: null } // 未知名：噪声
      const overlays = state.overlays.filter((n) => n !== event.name)
      const desired = desiredKeyboardMode(state.selectionNonEmpty, overlays, state.tiers)
      return { state: { ...state, overlays, on: desired }, edge: edgeOf(state.on, desired) }
    }
    case 'tier-acquired': {
      if (state.tiers.includes(event.name)) return { state, edge: null } // 重复持拿：幂等噪声
      const tiers = [...state.tiers, event.name]
      const desired = desiredKeyboardMode(state.selectionNonEmpty, state.overlays, tiers)
      return { state: { ...state, tiers, on: desired }, edge: edgeOf(state.on, desired) }
    }
    case 'tier-released': {
      if (!state.tiers.includes(event.name)) return { state, edge: null } // 未持拿：噪声
      const tiers = state.tiers.filter((n) => n !== event.name)
      const desired = desiredKeyboardMode(state.selectionNonEmpty, state.overlays, tiers)
      return { state: { ...state, tiers, on: desired }, edge: edgeOf(state.on, desired) }
    }
  }
}

// ---- Esc 全局定序（ADR-0006 Consequences 定稿）----
// 浮层 > 菜单 > 选区。浮层开时不参与（浮层既有自处理保持不动——按键落在浮层聚焦
// 元素上，编排不拦不抢先）；菜单开 → 只关菜单不清选区；否则选区非空 → 清空选区
// （并经仲裁还原键盘模式）。都否 → 双否（不拦键，放行给默认行为）。

/** 键盘路由上下文（评审结构项：Esc 定序与六键路由共用的裁决输入，main.ts keydown
 * 捕获段单点装配）：overlayOpen = 任一浮层开或任一插件档在持（浮层优先，按键归浮层
 * 聚焦元素/档位持有者）；menuOpen = 菜单开层；selectionNonEmpty = 选区非空。
 * 装配口径的纯逻辑出处 = keyRoutingContextOf（main.ts 只消费其输出）。 */
export interface KeyRoutingContext {
  overlayOpen: boolean
  menuOpen: boolean
  selectionNonEmpty: boolean
}

export interface EscapePlan {
  closeMenu: boolean
  clearSelection: boolean
}

export function escapePlan(ctx: KeyRoutingContext): EscapePlan {
  if (ctx.overlayOpen) return { closeMenu: false, clearSelection: false }
  if (ctx.menuOpen) return { closeMenu: true, clearSelection: false }
  if (ctx.selectionNonEmpty) return { closeMenu: false, clearSelection: true }
  return { closeMenu: false, clearSelection: false }
}

/** 键盘路由上下文合成（工单31 起窗口 keydown 捕获段单点装配的纯逻辑出处）：浮层与插件
 * 键盘档（工单100）任一在即 overlayOpen——档位持有期间键盘归档位（Esc 归档位自处理、
 * 六键不接管），与浮层优先同构；menuOpen/selectionNonEmpty 直通透传。 */
export function keyRoutingContextOf(gate: KeyboardGateState, menuOpen: boolean): KeyRoutingContext {
  return {
    overlayOpen: gate.overlays.length > 0 || gate.tiers.length > 0,
    menuOpen,
    selectionNonEmpty: gate.selectionNonEmpty,
  }
}

// ---- 选区六键路由（ADR-0006：选区存在期间 Del/Enter/Ctrl+A/Ctrl+C/X/V 可用）----
// 接管条件（三者同时成立，否则放行返回 null）：选区非空 + 无浮层（浮层优先：搜索/
// 设置激活期间选区快捷键不接管，按键落在浮层聚焦元素上）+ 无菜单开层。Ctrl 组合
// 键名不分大小写（大写锁定态同判）；Ctrl+Enter / Ctrl+Delete 等修饰外组合不接管。

export type KeyboardActionType = 'delete' | 'open' | 'select-all' | 'copy' | 'cut' | 'paste'

/** 键盘 Ctrl+V 的失败观感（评审 c2 定音）：键路只存证不上浮提示条——与票面及
 * pasteFromClipboard 注释一致（提示条是菜单层的观感语义，键盘路径静默，失败
 * 真相在 desktop-paste-rejected/failed 存证里）；菜单路保持提示条。null = 静默。 */
export function pasteFailureNotice(via: 'ctx-menu' | 'keyboard', error: string): string | null {
  return via === 'ctx-menu' ? error : null
}

export function routeSelectionKey(
  key: string,
  ctrl: boolean,
  ctx: KeyRoutingContext,
): KeyboardActionType | null {
  if (!ctx.selectionNonEmpty || ctx.overlayOpen || ctx.menuOpen) return null
  if (!ctrl) {
    if (key === 'Delete') return 'delete'
    if (key === 'Enter') return 'open'
    return null
  }
  switch (key.toUpperCase()) {
    case 'A': return 'select-all'
    case 'C': return 'copy'
    case 'X': return 'cut'
    case 'V': return 'paste'
    default: return null
  }
}
