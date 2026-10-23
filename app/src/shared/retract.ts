// 收栏决策纯函数域模块（工单237，spec #236 用户故事 34）：「最大化收栏」的全部决策逻辑
// 集中在这一份模块——三态裁决（resolveBarMode）、唤出条几何规划（planSummonStrips）、
// 唤出交互归约（reduceSummon）。与既有编排纯函数同族（shared/overflow 的 planAppsOverflow、
// main/taskbar/yield 的 shouldYieldToFullscreen、main/taskbar/tray-yield 的 TrayYieldMachine）。
//
// 落 shared 而非 main/taskbar：收栏态横跨两个进程——三态裁决与前台探针在主进程，
// 唤出条几何（pill 矩形只有渲染层量得到，见 renderer/taskbar.ts 的 measure()）与唤出交互
// （指针事件在渲染层）在渲染层。渲染层引用主进程模块会让浏览器 ESM 解析失败
// （shared/overflow 头注释的同款理由，见 tests/renderer-boundary.spec.ts），故**单一实现**
// 住在 shared/，两侧各引同一份——不许拆成两份实现各自判一次（工单237 修正 A2：
// 主进程侧只做转发导出，见 main/taskbar/retract.ts）。
//
// 本模块同时是**任务栏前台探针形状**与**桌面宿主排除名单**的单一来源：
// main/taskbar/yield.ts 由此引用同一份（工单237 修正 A4：形状不许复制第二份定义）。
//
// 纯度纪律：零引用语句 / 零 FFI / 不读全局时钟 / 不碰 DOM——时刻一律由调用方以 now 参数
// 注入（TrayYieldMachine 同形：begin(…, now) / poll({…, now})），探针采集与渲染是效果层。

/* ================================================================
 * 一、前台窗探针形状与桌面宿主排除名单（单一来源）
 * ================================================================ */

/** 物理像素矩形（GetWindowRect / 屏物理尺寸口径，非 DIP） */
export interface PhysRect {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * 前台窗探针快照（FFI 采集，喂给纯谓词）。形状与排除名单同处本模块——全屏让位的判定
 * （main/taskbar/yield.ts）与最大化收栏的判定共用同一份，不许各抄一份。
 */
export interface ForegroundProbe {
  hwnd: number
  pid: number
  className: string
  rect: PhysRect
  /**
   * 是否**真最大化**（Win32 IsZoomed 族）——真值由探针负责喂（收栏编排票的探针负责），
   * 不是矩形覆盖法的推断。手工四角拉满的窗恒为 false（宁可遗漏，不用矩形法误触发）。
   */
  zoomed: boolean
}

/** 覆盖判定容差（px）：边框/圆角让全屏矩形与屏矩形有 1–2px 出入 */
export const COVER_TOLERANCE = 2

/** 永不触发让位/收栏的桌面宿主类：桌面本体与原生任务栏的矩形常态即全屏/通栏 */
export const DESKTOP_HOST_CLASSES: readonly string[] = [
  'Progman',
  'WorkerW',
  'Shell_TrayWnd',
  'Shell_SecondaryTrayWnd',
]

/**
 * 前台窗是否完整覆盖给定屏矩形（容差内）——全屏让位与收栏共用一份覆盖判定。
 * 收栏会注销 AppBar 释放工作区占位，故「覆盖」本身不足以判全屏：真最大化窗在收栏后
 * 同样覆盖整屏，由调用方用 zoomed 位把两态分开（见 resolveBarMode）。
 */
export function coversScreenRect(rect: PhysRect, screen: PhysRect): boolean {
  return rect.left <= screen.left + COVER_TOLERANCE
    && rect.top <= screen.top + COVER_TOLERANCE
    && rect.right >= screen.right - COVER_TOLERANCE
    && rect.bottom >= screen.bottom - COVER_TOLERANCE
}

/* ================================================================
 * 二、resolveBarMode：三态裁决
 * ================================================================ */

/** 任务栏三态：visible = 常驻可见；maximize-retract = 最大化收栏（有唤出条）；fullscreen-yield = 全屏让位（无任何条） */
export type BarMode = 'visible' | 'maximize-retract' | 'fullscreen-yield'

/** 三态裁决的输入快照（全部由调用方采数所得，纯函数只管裁决） */
export interface BarModeInput {
  /** 前台窗探针快照（缺位 = null） */
  probe: ForegroundProbe | null
  /** 主屏矩形（物理像素口径，与探针矩形同坐标系） */
  screen: PhysRect
  /** 自家进程 pid（面板本体成前台时不收栏、不让位） */
  ownPid: number
  /** 收栏开关（设置浮层的 taskbar.maximizeRetract，默认开）——关则永不为 maximize-retract */
  retractEnabled: boolean
  /** 降级档标记（AppBar 注册失败）——降级档下收栏整体禁用（与全屏让位同待遇） */
  appBarDegraded: boolean
}

/**
 * 三态裁决（优先级从高到低）：
 * ① 真最大化窗（zoom 位）→ 最大化收栏，再受「开关关断」与「降级档禁用」两道闸门约束；
 * ② 非真最大化的全屏覆盖窗（游戏 / 视频这类全屏应用通常不上 IsZoomed 态）→ 全屏让位；
 * ③ 其余 → 常驻可见。
 *
 * ① 先于 ② 是「两态不互咬」的闸门（工单237 修正 A1）：收栏注销 AppBar 释放工作区占位后，
 * 最大化窗的矩形**正好覆盖整屏**——若按矩形覆盖判全屏，收栏刚生效就被优先级最高的
 * 全屏让位翻掉，栏隐藏且没有唤出条，收栏功能等于没做。既有实现下最大化窗从不触发全屏
 * 让位（AppBar 占着 48px，矩形不满足覆盖），这条排除把全屏让位的既有语义保住。
 * 真最大化窗因此**永不**落 fullscreen-yield：闸门没过时落 visible，不落让位。
 */
export function resolveBarMode(input: BarModeInput): BarMode {
  const { probe, screen, ownPid, retractEnabled, appBarDegraded } = input
  if (!probe) return 'visible'
  if (probe.pid === ownPid) return 'visible'
  if (DESKTOP_HOST_CLASSES.includes(probe.className)) return 'visible'
  // ① 真最大化 → 收栏档（开关关断 / 降级档禁用两道闸门）
  if (probe.zoomed) {
    return retractEnabled && !appBarDegraded ? 'maximize-retract' : 'visible'
  }
  // ② 非真最大化的全屏覆盖窗 → 全屏让位（优先级高于收栏，收栏不得翻它）
  if (coversScreenRect(probe.rect, screen)) return 'fullscreen-yield'
  // ③ 其余 → 常驻可见
  return 'visible'
}

/* ================================================================
 * 三、planSummonStrips：唤出条几何规划
 * ================================================================ */

/** 唤出条命中区高度（px）：视觉条约 3px，命中区垫高到 9px（好摸又不碍眼） */
export const SUMMON_STRIP_HIT_HEIGHT = 9
/** 唤出条视觉高度（px）：贴屏幕底边的窄横条——渲染层的事，本模块只出命中区矩形 */
export const SUMMON_STRIP_VISUAL_HEIGHT = 3
/** 夹取后条宽的保底（px）：被完全压掉时宁窄不重叠——每条仍可独立命中 */
export const SUMMON_STRIP_MIN_WIDTH = 1

/** 收栏前缓存的各组 pill 矩形（渲染层量得；组间空隙不在列，故空隙天然不出条） */
export interface SummonPillRect {
  /** 组标识（'start' / 'recs' / 'apps' / 'right' / 'showdesk'，由调用方定） */
  group: string
  /** pill 左缘（与屏幕底边同坐标系） */
  x: number
  /** pill 宽度 */
  width: number
}

/** 唤出条规划的输入 */
export interface SummonStripPlanInput {
  /** 各组 pill 矩形集（有 pill 的组才在列；空组与组间空隙都不在列） */
  pills: readonly SummonPillRect[]
  /** 屏幕底边（与 pill 矩形同坐标系；唤出条命中区贴底） */
  screenBottom: number
}

/** 一条唤出条的命中区矩形（视觉条高 3px 是渲染层的事，此处只给命中区） */
export interface SummonStrip {
  /** 组标识（与输入 1:1） */
  group: string
  /** 命中区左缘 */
  x: number
  /** 命中区宽度 */
  width: number
  /** 命中区上缘（= 屏幕底边 − 命中区高度） */
  top: number
  /** 命中区高度（恒 9px） */
  height: number
}

/**
 * 唤出条几何规划：逐组一条，镜像所属 pill 的横向区间与宽度（1:1）。
 *
 * - 组间空隙不出条：空隙不在输入的 pill 集里，故不会被任何条覆盖；
 * - 显示桌面细条在最右端各出一条（它本身就是一个组，规则对它一视同仁）；
 * - pill 相叠（挤撞守卫生效的窄屏边界）时条**夹取到互不重叠**：按左缘升序扫掠，
 *   后者的左缘被夹到前者的右缘，被夹掉的量从其宽度里扣（右缘因此守在 pill 的右缘），
 *   扣到零则保底 1px——宁窄不重叠，每条仍可独立命中；
 * - 栏分组增删时 1:1 跟随：纯函数按输入矩形集重算，不留历史态。
 */
export function planSummonStrips(input: SummonStripPlanInput): SummonStrip[] {
  const top = input.screenBottom - SUMMON_STRIP_HIT_HEIGHT
  // 空组（零宽 pill）不出条——与「组间空隙不出条」同一口径
  const usable = input.pills.filter((p) => p.width > 0)
  // 扫掠序：左缘升序（同左缘按入列序）；输出序仍是入列序（与输入 1:1）
  const order = usable
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (a.p.x - b.p.x) || (a.i - b.i))
  const placed = new Array<{ group: string; x: number; width: number }>(usable.length)
  let cursor = Number.NEGATIVE_INFINITY
  for (const { p, i } of order) {
    const x = Math.max(p.x, cursor) // 左缘夹到前一条的右缘——互不重叠
    const width = Math.max(SUMMON_STRIP_MIN_WIDTH, p.width - (x - p.x)) // 被夹掉的量从宽度里扣
    placed[i] = { group: p.group, x, width }
    cursor = x + width
  }
  return placed.map((r) => ({ ...r, top, height: SUMMON_STRIP_HIT_HEIGHT }))
}

/* ================================================================
 * 四、reduceSummon：唤出交互归约（逻辑时钟由调用方注入）
 * ================================================================ */

/** 悬停唤出条到弹出的延迟（ms）：快速扫过不误触发 */
export const SUMMON_HOVER_DELAY_MS = 150
/** 离开已弹出的组到收起的宽限（ms）：短距离滑向菜单时不塌 */
export const SUMMON_GRACE_MS = 400

/** 唤出交互事件类型 */
export type SummonEventType =
  /** 指针进入某组的唤出条（悬停延迟起算） */
  | 'strip-enter'
  /** 指针离开某组的唤出条（悬停作废；已弹出的组起 400ms 宽限） */
  | 'strip-leave'
  /** 点击某组的唤出条（立即弹出，不吃 150ms 延迟） */
  | 'strip-click'
  /** 指针进入某组已弹出的 pill（宽限作废——静止指针压在 pill 上时该组保持弹出） */
  | 'pill-enter'
  /** 指针离开某组已弹出的 pill（已弹出的组起 400ms 宽限） */
  | 'pill-leave'
  /** 自绘浮层在场（钉住所属组，如托盘溢出菜单钉右组） */
  | 'overlay-open'
  /** 自绘浮层离场（解除钉住） */
  | 'overlay-close'
  /** 定时对账拍（只推进逻辑时钟，无其他效果） */
  | 'tick'

/** 一次唤出交互事件（时刻由调用方注入，本模块不读全局时钟） */
export interface SummonEvent {
  type: SummonEventType
  /** 事件所属组（浮层事件为浮层所属组） */
  group: string
  /** 事件时刻（注入的逻辑时钟，ms） */
  now: number
}

/** 单组的唤出状态 */
export interface SummonGroupState {
  /** 该组是否已弹出 */
  popped: boolean
  /** 唤出条是否可见（已弹出组的唤出条隐藏——条与 pill 同位，露出会闪） */
  stripVisible: boolean
  /** 指针是否在唤出条上（对账结论，不采信浏览器事件序列） */
  onStrip: boolean
  /** 指针是否在已弹出的 pill 上 */
  onPill: boolean
  /** 是否被自绘浮层钉住 */
  pinned: boolean
  /** 悬停起算时刻（null = 未悬停） */
  hoverSince: number | null
  /** 离开起算时刻（宽限倒计时；null = 未起算） */
  leaveSince: number | null
}

/** 全体组的唤出状态 */
export interface SummonState {
  /** 各组状态（键 = 组标识） */
  groups: Record<string, SummonGroupState>
}

function freshGroup(): SummonGroupState {
  return {
    popped: false,
    stripVisible: true,
    onStrip: false,
    onPill: false,
    pinned: false,
    hoverSince: null,
    leaveSince: null,
  }
}

/** 初始状态（各组均在收（未弹出）态，唤出条待命） */
export function initialSummonState(groups: readonly string[] = []): SummonState {
  const out: Record<string, SummonGroupState> = {}
  for (const g of groups) out[g] = freshGroup()
  return { groups: out }
}

/** 判定宽限是否该起算：已弹出、未被浮层钉住、指针既不在唤出条也不在 pill 上 */
function graceApplies(g: SummonGroupState): boolean {
  return g.popped && !g.pinned && !g.onStrip && !g.onPill
}

function applyEvent(g: SummonGroupState, ev: SummonEvent): void {
  switch (ev.type) {
    case 'strip-enter':
      // 重复触发（对账与真实事件可能都发一次）不重启悬停计时
      if (g.onStrip) break
      g.onStrip = true
      g.hoverSince = ev.now
      break
    case 'strip-leave':
      g.onStrip = false
      g.hoverSince = null // 悬停作废——快速扫过不误触发
      g.leaveSince = graceApplies(g) ? ev.now : null
      break
    case 'strip-click':
      g.onStrip = true
      g.hoverSince = null
      g.popped = true // 立即弹出，不吃 150ms 延迟
      g.leaveSince = null
      break
    case 'pill-enter':
      if (g.onPill) break
      g.onPill = true
      g.hoverSince = null
      g.leaveSince = null // 指针压在 pill 上——宽限作废（静止指针保持弹出）
      break
    case 'pill-leave':
      g.onPill = false
      g.leaveSince = graceApplies(g) ? ev.now : null
      break
    case 'overlay-open':
      g.pinned = true
      g.leaveSince = null
      g.hoverSince = null
      g.popped = true // 浮层属该组——该组弹出在场（原型同款）
      break
    case 'overlay-close':
      g.pinned = false
      g.leaveSince = graceApplies(g) ? ev.now : null
      break
    case 'tick':
      break
  }
}

/** 把逻辑时钟推进到 now：到点的悬停弹出、到点的宽限收起（各组互不影响） */
function advance(groups: Record<string, SummonGroupState>, now: number): void {
  for (const g of Object.values(groups)) {
    if (!g.popped) {
      if (g.hoverSince !== null && now - g.hoverSince >= SUMMON_HOVER_DELAY_MS) {
        g.popped = true
        g.hoverSince = null
        g.leaveSince = null
      }
    } else if (g.leaveSince !== null && now - g.leaveSince >= SUMMON_GRACE_MS) {
      g.popped = false
      g.hoverSince = null
      g.leaveSince = null
    }
    g.stripVisible = !g.popped
  }
}

/**
 * 唤出交互归约（一步）：事件 + 注入的时刻 → 各组弹出/收起状态。纯函数，不改入参。
 *
 * 语义要点：
 * - 悬停唤出条 150ms 后弹出该组；点击唤出条立即弹出；
 * - 离开已弹出的组后 400ms 宽限才收起；指针压在已弹出的 pill 上则宽限作废
 *   （静止指针压在 pill 上时该组保持弹出）；
 * - 自绘浮层在场只钉住所属组，其余组照常收；
 * - 各组唤出与收起互相独立，多组可同时在场；
 * - 收栏态下已弹出组的唤出条隐藏（stripVisible=false，条与 pill 同位，露出会闪）。
 *
 * 振荡防御（原型教训）：静止指针会「弹出→收→弹」振荡——浏览器补发的 enter/leave 不可靠。
 * 防线有二：其一，指针在 pill 上时宽限不起算（对账纠正后的悬停态压得住收势）；
 * 其二，宽限只在指针**既不在唤出条也不在 pill** 时起算。调用方须按光标坐标 hit-test
 * 对账后喂事件（既有 HotzoneTracker 25ms 轮询的通路），不采信浏览器事件序列。
 */
export function reduceSummon(state: SummonState, event: SummonEvent): SummonState {
  const groups: Record<string, SummonGroupState> = {}
  for (const [key, value] of Object.entries(state.groups)) groups[key] = { ...value }
  const target = groups[event.group] ?? (groups[event.group] = freshGroup())
  // 先落事件、后推时钟：到点的那一拍上，若事件本身纠正了悬停态（如对账命中 pill），
  // 纠正优先于到点收起——否则「指针恰在宽限到点那一拍落到 pill 上」会被误收。
  applyEvent(target, event)
  advance(groups, event.now)
  return { groups }
}

/** 事件序列折叠口径（票面「事件序列 + 逻辑时钟」的直译；与逐步归约同解） */
export function reduceSummonSequence(
  events: readonly SummonEvent[],
  initial?: SummonState,
): SummonState {
  let state = initial ?? initialSummonState()
  for (const event of events) state = reduceSummon(state, event)
  return state
}

/** 当前在场的组（已弹出的组） */
export function summonedGroups(state: SummonState): string[] {
  return Object.keys(state.groups).filter((g) => state.groups[g].popped)
}

/* ================================================================
 * 五、planBarTransition：三态迁移的动作计划（工单241）
 * ================================================================ */

/** 三态迁移落下的存证事件名（与既有 taskbar-yield / taskbar-yield-lifted 同族） */
export type BarEvidenceEvent =
  | 'taskbar-yield'
  | 'taskbar-yield-lifted'
  | 'taskbar-retract'
  | 'taskbar-retract-lifted'

/**
 * 一次三态迁移的动作计划（纯函数产出，效果层照单执行）。
 *
 * 字段语义（工单241 的裁决，勿改口径）：
 * - releaseAppBar：注销 AppBar —— 释放**我方那份**占位登记（**只在收栏态**为真）；
 *   ⚠️ 工单250 实测：系统工作区不随之变化（原生任务栏的 48px 保留带由 shell 自算、
 *   不在 AppBar 登记表里）⇒ 「最大化窗铺满整屏」在本机不发生——本字段的语义是
 *   「占位**登记**释放」，不是「工作区归还整屏」。取证见
 *   docs/audit/2026-10-23-t250-native-taskbar-reserved-band.md；
 * - claimAppBar：工作区占位必须生效 —— 已占位则空转，未占位则重注册 + 重协商（占位恢复）；
 * - hideWindow：整窗退场（隐藏）—— 只在全屏让位态（栏窗复用的收栏态不隐藏，唤出条要贴屏底可见）；
 * - showWindow：整窗复现 —— 从全屏让位态出来时；
 * - closePopups：关闭全部自绘浮层（不留无锚孤儿浮层）；
 * - evidence：本次迁移应落的存证事件，顺序 = 落盘顺序（先退出旧态、再进入新态）。
 */
export interface BarTransitionPlan {
  releaseAppBar: boolean
  claimAppBar: boolean
  hideWindow: boolean
  showWindow: boolean
  closePopups: boolean
  evidence: BarEvidenceEvent[]
}

/**
 * 三态迁移的动作计划（纯函数）：旧态 → 新态 → 该做哪些动作。
 *
 * 三条不变量（工单241 修正 E1/E3/E4 的落点）：
 * ① **占位只在收栏态释放**：其余两态占位必须生效——全屏让位态沿用既有语义（占位不断、
 *    只藏条带窗），收栏态才注销 AppBar 交还整屏；
 * ② **整窗只在让位态退场**：收栏态条带窗仍在场（承载形态 = 栏窗复用——唤出条贴屏底、
 *    在最大化窗之上、命中区可点，弹出的组就落在同一条 48px 带内）；
 * ③ **同态迁移零动作**：250ms 轮询每拍都过一次，重复落账会刷爆存证流。
 *
 * 本函数**不重判档位**——档位归 resolveBarMode（真最大化优先）。收栏态因占位已释放而
 * 让最大化窗「看起来」覆盖整屏，那是副作用不是档位变化（修正 E4：不得因此翻成让位态）。
 */
export function planBarTransition(prev: BarMode, next: BarMode): BarTransitionPlan {
  const plan: BarTransitionPlan = {
    releaseAppBar: false,
    claimAppBar: false,
    hideWindow: false,
    showWindow: false,
    closePopups: false,
    evidence: [],
  }
  if (prev === next) return plan
  // ① 工作区占位：收栏态释放，其余两态占位必须生效
  if (next === 'maximize-retract') plan.releaseAppBar = true
  else plan.claimAppBar = true
  // ② 整窗显隐：让位态退场（唤出条也不出现），其余态条带窗在场
  if (next === 'fullscreen-yield') plan.hideWindow = true
  if (prev === 'fullscreen-yield') plan.showWindow = true
  // ③ 浮层收拢：收栏与让位两态都不留无锚孤儿浮层（用户故事 29）
  if (next === 'maximize-retract' || next === 'fullscreen-yield') plan.closePopups = true
  // 存证：两族各按「进入/退出」落一条（退出旧态在前、进入新态在后）
  if (prev === 'fullscreen-yield') plan.evidence.push('taskbar-yield-lifted')
  if (prev === 'maximize-retract') plan.evidence.push('taskbar-retract-lifted')
  if (next === 'fullscreen-yield') plan.evidence.push('taskbar-yield')
  if (next === 'maximize-retract') plan.evidence.push('taskbar-retract')
  return plan
}
