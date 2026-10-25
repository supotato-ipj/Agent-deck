// 任务栏条带渲染入口（工单49/52/53/54/55/56/57/58/159/162/190/192/195）：状态经 taskbar/get-state 拉取 +
// taskbar/changed 订阅；右组 1Hz 数据帧（时钟 + 硬件仪表，工单55）经 taskbar/status 订阅。
// 四组布局（工单192 推荐组独立拆出、工单190 应用组中心锚定）：开始组 pill 钉条带左缘
// （系统按钮，工单54）、推荐组 pill 漂浮于开始组右侧应用组左侧（positionRecPill 落位，
// 显隐按推荐位有无与开始组解耦，工单192）、应用组（手钉 + 运行中合并，工单52，右键菜单/
// 中键/多窗口选窗属工单53）pill 中心对齐屏幕水平中心线（appsPillLeft——不随两侧内容漂移，
// 空带 [左邻组右缘, 右组左缘] 只作容量与夹取围栏）、右组（硬件摘要 + 托盘图标（溢出收进
// 「⋯」，工单162）+ 音量 + 时钟，工单55/56）与显示桌面细条位置不变。
// 各 pill、按钮/推荐位/应用组条目/右组单元格与细条矩形经宿主面声明为热区并落存证——
// 验收电池据此取点击坐标。视图模型是纯函数（taskbar-view.ts）；本文件只是它的 DOM 呈现端
// + 弹窗菜单开层/转达收层（工单193/196，ADR-0013：全部右键菜单与多窗选窗迁独立浮层窗
// 竖排呈现，条带内横排菜单形态整体退役——条带只发开层请求携身份，行集由浮层页自足推导）
// 与托盘溢出浮层开合。窗口标题与托盘 tooltip 随状态帧即时进出，渲染层不落任何存储。
// 工单195 全量拖拽三断点：①所有应用组条目（含未钉运行）可起拖可落（before 语义、
// 落点条目化——落在仅运行图标上被容器守卫静默吞掉的老病根除）；②拖拽会话活动期整树
// 重渲冻结合帧（requestRender 单一入口，dragend 补渲——被拖节点被重建即中止 Chromium
// OLE 拖拽会话）；③拖拽会话活动期热区持门（host.setDragSession → 穿透轮询抑制关门，
// 跨组/缝隙松手不丢）；拖拽失败（服务层拒返）条带内 toast 可见反馈不静默。
import { APPS_INSET, appIconFallbackText, appsBand, appsBandFromSpans, appsBandLeft, appsPillLeft, appsSlotsFor, dispatchAppClick, dispatchAppNewInstance, dispatchRecClick, dispatchTaskbarButton, dispatchTaskbarDragDrop, dispatchTrayClick, fetchTrayIcon, formatClock, formatMetric, GROUP_GAP, splitAppsOverflow, splitTrayOverflow, summaryViewModel, taskbarViewModel, toggleMetric, trayIconPixelated } from './taskbar-view.js'
import type { AppsBand, GroupPillSpan, TaskbarAppViewEntry } from './taskbar-view.js'
import { trayDataUrl } from './tray-pixels.js'
import { applyOverlayState, clickStrip, planSummonGeometry, reconcilePointer, stripZoneId, summonHotZones, summonRiseKeyframes, SUMMON_RISE_MS, SUMMON_SHIFTED_GROUPS, tickSummon } from './taskbar-summon.js'
import type { SummonRect, SummonStripGeometry } from './taskbar-summon.js'
import { initialSummonState, summonedGroups } from '../shared/retract.js'
import type { SummonState } from '../shared/retract.js'
import type { HardwareGauges, TaskbarBarModeState, TaskbarDragGroup, TaskbarMetric, TaskbarRecommendation, TaskbarState, TaskbarStatus, TaskbarTrayButton, TaskbarTrayEntry, TaskbarTrayPixels } from '../shared/contract'

const pillStart = document.getElementById('pill-start') as HTMLElement
const pillRecs = document.getElementById('pill-recs') as HTMLElement
const pillApps = document.getElementById('pill-apps') as HTMLElement
const rightPill = document.getElementById('right-pill') as HTMLElement
const sliver = document.getElementById('show-desktop') as HTMLElement
/** 唤出条层（工单242）：收栏态下逐组一条窄横条的宿主（条元素挂在它下面） */
const summonLayer = document.getElementById('summon-strips') as HTMLElement | null

// 换位拖拽（工单57）是本窗唯一的原生拖拽语义，且只长在 .tb-app/.tb-rec 上（makeDraggable）。
// 别处的 img（托盘图标、推荐位图标）默认可拖：一起手就起 OLE 会话，会话收不掉时满屏 Ghost
// 幽灵窗跟着光标走、渲染主线程进模态循环，整条常驻任务栏就此停摆（同面板那份守卫）。
document.addEventListener('dragstart', (e) => {
  if ((e.target as HTMLElement | null)?.closest('.tb-app, .tb-rec')) return
  e.preventDefault()
})

/** 应用组几何常量已随工单159 纯函数化迁至 taskbar-view（APPS_INSET/PILL_PAD_X/CELL_W/
 * GROUP_GAP，与 taskbar.html CSS 同源）——空带/容量/居中算式在那侧单测钉住 */

/** 最近一次渲染的状态：几何重排（resize）时按它重声明热区 */
let current: TaskbarState | null = null
/** 右组 1Hz 数据帧的最近值：重渲染（勾选变更）时按它立即填字，不等下一拍 */
let latestStatus: TaskbarStatus | null = null
/** 硬件摘要编辑态（工单55，右键进入勾选子集，再右键/点格外退出） */
let editing = false
/** 托盘溢出菜单浮层（工单162）请求态：「⋯」左键发起，宿主浮层窗随请求开合；
 * 条带内任意点击即请求收层（浮层窗 blur 收「栏外」点击，条带窗 focusable:false 收不到 blur） */
let trayPopupRequested = false
/** 应用组溢出浮层开合（工单58）：⋯ 钮拨动、点浮层条目收、数量回落自动收 */
let overflowOpen = false
/**
 * 弹窗菜单浮层请求态（工单193/196，ADR-0013 全家迁通路）：条带只持「已请求开层」
 * 标记供条带内点击/右键转达收层（浮层窗 blur 收「栏外」点击，条带窗 focusable:false
 * 点了不夺焦——托盘溢出浮层同款纪律）。五面各自一扇常驻浮层窗（每面独立标题/事件
 * 家族），开层请求只携带寻址身份（行集由浮层页自足推导），条带内不再渲染任何菜单
 * 行——pill 内横排形态整体退役。
 */
let appMenuRequested = false // 应用组图标右键（工单193 首迁）
let recMenuRequested = false // 推荐组条目右键三行菜单
let blankMenuRequested = false // 开始组/推荐组空白右键（系统按钮显隐+恢复段）
let tierMenuRequested = false // 右组空白/「⋯」右键托盘档位
let winsListRequested = false // 多窗应用左键选窗列表
/** 拖拽源（工单57）：dragstart 记录，落位判定全在渲染层，落位裁决在内核。
 * 工单195：dragSource 活动期即 OLE 拖拽会话活动期——渲染冻结（②）与热区持门（③）
 * 都以它为闸。 */
let dragSource: { group: TaskbarDragGroup; id: string } | null = null
/** 拖拽期合帧挂起（工单195 断点②）：dragSource 活动期收到的 taskbar/changed 只留最新
 * 一帧，dragend 补渲一次——被拖节点被重建即中止 Chromium OLE 拖拽会话（真机上窗口
 * 标题变化/托盘事件/快照刷新每几秒推一帧，~75% 偶发弹回的根因）。 */
let dragHeld: TaskbarState | null = null
/** 拖拽期被跳过的 resize 重渲（工单195 断点②）：dragend 补渲凭它决定是否补一帧 */
let dragResized = false
/** 图标 dataURL 缓存（iconKey → dataURL；仅内存——桌面 dock 同款本地缓存纪律） */
const iconCache = new Map<string, string>()

/**
 * 栏三态（工单241 主进程编排下发）：visible = 栏面常驻；maximize-retract = **最大化收栏**
 * （栏面退场、唤出条待命——唤出条本体由工单242 落）；fullscreen-yield = 全屏让位
 * （整窗退场，渲染层无事——窗口已隐藏）。
 *
 * 收栏态的栏面退场由 body[data-bar-mode] 的 CSS 承担（重渲不丢、不与视图模型的
 * 组显隐打架）；热区在收栏态清空（栏面不在场，无可点之物——唤出条命中区由工单242
 * 沿同一热区通路声明）。
 */
let barMode: TaskbarBarModeState['mode'] = 'visible'

/** 栏三态落地：栏面显隐（CSS 属性位）+ 重排。幂等——同档位重复下发空转。 */
function applyBarMode(next: TaskbarBarModeState['mode']): void {
  if (barMode === next) return
  barMode = next
  document.body.dataset.barMode = next
  // 唤出态随档位归零（工单242）：进收栏态重置（各组唤出条待命），出收栏态清空
  // （栏面复现，没有"弹出的组"这回事）。光标锚点一并作废——档位一变，热区集合全换，
  // 下一拍光标轮询自会报新的命中区。
  summonState = initialSummonState(next === 'maximize-retract' ? summonPillCache.map((p) => p.group) : [])
  cursorZone = null
  poppedSig = ''
  hoverSig = ''
  // 唤出态归零要与 DOM **同拍**（工单249）：只清签名会留下「签名说没弹出、DOM 还带着
  // .summon-popped」的残态——下次 applySummonView 的早退逻辑（签名没变就不碰 DOM）
  // 于是跳过 toggle，残态再也抹不掉：下次进收栏态时该组 pill 整组复现，却不在热区集内
  // （看得见、点不着）。clearPoppedClasses 与上面两行同拍落地，不许分拍。
  clearPoppedClasses()
  // 唤出条几何存证帧的去重签名（工单249）：档位一变就清空——几何未变（栏布局没动）
  // 时再次进收栏态也**要再发一帧**，否则验收侧「等收栏后的新帧」会超时。
  lastSummonStripsJson = ''
  // 重排：收栏态栏面退场量不到宽度（应用组落位按 offsetWidth 算），复现时必须按可见
  // 几何重算落位——否则复现的栏面位置是收栏态的残值。render 内含热区与几何帧重声明。
  if (current) requestRender(current)
}

/**
 * 各组 pill 矩形缓存（工单241 裁决 (b)：唤出条几何在渲染层算——pill 矩形只有渲染层量得到，
 * 主进程控制器从不回读 taskbar-geometry 帧）。
 *
 * 收栏后栏面退场、pill 量不到矩形——**收栏前最后一帧**的各组横向区间即唤出条镜像的来源
 * （原型同款 groupRectsCache 口径）。缓存形状 = `planSummonStrips` 的输入形状
 * （{group, x, width}；x 为客户区左缘、width 为组宽——条带窗通栏，客户区 x 即屏幕 x）。
 */
let summonPillCache: Array<{ group: string; x: number; width: number }> = []

/** 缓存各组 pill 矩形（只收在场组——与热区声明同口径：组不在场不出条） */
function cacheSummonPills(state: TaskbarState): void {
  // 收栏态：栏面退场量不到矩形——保留收栏前最后一帧的缓存，不覆写
  if (barMode === 'maximize-retract') return
  // 让位态（工单253）：整窗退场（隐藏）⇒ 同样量不到矩形。缓存是收栏态布局的**唯一来源**
  // （空带两侧边界与唤出条几何都取它）——被零值覆写会让「全屏退出回到最大化窗」
  // （spec 用户故事 28）这条接力路径上的唤出条与已唤出的组全废（条宽 0、组容量 0）。
  if (barMode === 'fullscreen-yield') return
  const vm = taskbarViewModel(state)
  const m = measure()
  const pills: Array<{ group: string; x: number; width: number }> = []
  if (vm.visible) pills.push({ group: 'start', x: m.startPill.x, width: m.startPill.w })
  if (vm.recsVisible) pills.push({ group: 'recs', x: m.recPill.x, width: m.recPill.w })
  if (vm.apps.length > 0) pills.push({ group: 'apps', x: m.appsPill.x, width: m.appsPill.w })
  pills.push({ group: 'right', x: m.rightPill.x, width: m.rightPill.w })
  pills.push({ group: 'showdesk', x: m.sliver.x, width: m.sliver.w })
  summonPillCache = pills
}

/* ================================================================
 * 唤出条（工单242，spec #236 用户故事 12–22、24、31–33）
 * ================================================================ */

/** 组 → 栏面元素（被唤出时该元素复现；未唤出时退场） */
const SUMMON_GROUP_ELEMENT: Record<string, HTMLElement> = {
  start: pillStart,
  recs: pillRecs,
  apps: pillApps,
  right: rightPill,
  showdesk: sliver,
}

/** 组的可读名（唤出条 title——不靠图标猜是哪一组） */
const SUMMON_GROUP_LABEL: Record<string, string> = {
  start: '开始组',
  recs: '推荐组',
  apps: '应用组',
  right: '右组',
  showdesk: '显示桌面',
}

/**
 * 撤掉全部组的 .summon-popped（唤出态归零的 DOM 那一半）。
 *
 * 与 poppedSig 归零**同拍**调用（applyBarMode 内，两行紧邻）：两者分拍就留下残态——
 * 签名已清、DOM 还带着类，下次 applySummonView 的早退逻辑（签名没变就不碰 DOM）
 * 跳过 toggle，残态再也抹不掉：收栏态里该组 pill 整组可见、却不在热区集内。
 *
 * 与 applySummonView 里的 toggle 循环是同一件事的两面：那边按「弹出的组」逐组置位，
 * 这边按「唤出态归零」整体清场——两者合起来保证「签名说没弹出」与「DOM 没带类」恒等。
 */
function clearPoppedClasses(): void {
  for (const el of Object.values(SUMMON_GROUP_ELEMENT)) el.classList.remove('summon-popped')
}

/** 唤出交互状态（归约体在 shared/retract 的 reduceSummon——本层只喂事件与对账事实） */
let summonState: SummonState = initialSummonState([])
/** 当前唤出条几何（收栏态：由收栏前缓存的各组 pill 矩形算出） */
let summonStrips: SummonStripGeometry[] = []
/**
 * 光标此刻落在哪个热区——**唤出悬停态的唯一事实来源**。
 * 主进程 HotzoneTracker 25ms 光标轮询按光标坐标 hit-test 后下发（taskbar/cursor-zone）。
 * 不用浏览器 enter/leave 事件序列（原型教训：静止指针会「弹出→收→弹」振荡）。
 */
let cursorZone: string | null = null
/** 已落到 DOM 的视图签名（弹出的组 / 悬停的条）——没变就不碰 DOM */
let poppedSig = ''
let hoverSig = ''

/** 对账拍间隔（ms）：与主进程 HotzoneTracker 的 25ms 光标轮询同频 */
const SUMMON_TICK_MS = 25

/**
 * 唤出条几何：收栏前缓存的各组 pill 矩形 → 逐组一条（镜像 pill 横向区间与宽度）。
 * 屏幕底边 = 条带窗客户区底边（条带窗通栏且贴屏底）——故取 innerHeight。
 */
function planSummonStripsNow(): SummonStripGeometry[] {
  return planSummonGeometry(summonPillCache, window.innerHeight)
}

/** 唤出条元素：视觉条 3px 贴屏底，命中区 9px 垫在条元素上（两个口径分离） */
function makeSummonStripEl(group: string): HTMLElement {
  const el = document.createElement('div')
  el.className = 'tb-summon-strip'
  el.dataset.group = group
  el.title = `唤出${SUMMON_GROUP_LABEL[group] ?? group}`
  const bar = document.createElement('div')
  bar.className = 'tb-summon-bar'
  el.appendChild(bar)
  el.addEventListener('click', () => {
    if (barMode !== 'maximize-retract') return
    const now = Date.now()
    // 点击即证据：指针此刻在这条上——顺手把对账锚点拨正（不等光标轮询那一拍）
    cursorZone = stripZoneId(group)
    summonState = clickStrip(summonState, group, now)
    applySummonView()
  })
  return el
}

/**
 * 条 DOM 与几何 1:1 跟随（组增删即增删条；相叠已被 planSummonGeometry 夹取过）。
 *
 * 只写**横向**几何（左缘 + 宽度）：条的高度是定值口径（命中区 9px / 视觉条 3px），
 * 归样式表所有——与「挤撞守卫只收窄宽度、绝不改高度」同一纪律（工单238）。
 */
function syncSummonStrips(strips: SummonStripGeometry[]): void {
  const layer = summonLayer
  if (!layer) return
  const seen = new Set<string>()
  for (const s of strips) {
    seen.add(s.group)
    let el = layer.querySelector<HTMLElement>(`.tb-summon-strip[data-group="${s.group}"]`)
    if (!el) {
      el = makeSummonStripEl(s.group)
      layer.appendChild(el)
    }
    el.style.left = `${Math.round(s.x)}px`
    el.style.width = `${Math.round(s.width)}px`
  }
  for (const el of [...layer.querySelectorAll<HTMLElement>('.tb-summon-strip')]) {
    if (!seen.has(el.dataset.group ?? '')) el.remove()
  }
}

/**
 * 唤出上滑淡入（140ms，进有方向感）：走 Web Animations API 而非 CSS @keyframes——
 * 条带页样式表是平铺规则集（工单238 的样式表守卫不容块内嵌套开括号）。
 * 收起**瞬时**：动画只管进，退场时元素直接退场，无退场动画。
 */
function animateSummonRise(group: string, el: HTMLElement): void {
  el.animate(summonRiseKeyframes(SUMMON_SHIFTED_GROUPS.includes(group)), {
    duration: SUMMON_RISE_MS,
    easing: 'ease-out',
  })
}

/** 已唤出组的 pill 矩形（收栏态下唤出的组复现在同一条 48px 带内——不改变最大化窗尺寸） */
function poppedPillRects(): Record<string, SummonRect> {
  const out: Record<string, SummonRect> = {}
  for (const group of summonedGroups(summonState)) {
    const el = SUMMON_GROUP_ELEMENT[group]
    if (!el) continue
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    out[group] = { x: r.x, y: r.y, w: r.width, h: r.height }
  }
  return out
}

/**
 * 唤出态落到 DOM：唤出的组复现（140ms 上滑淡入）、已唤出组的条隐藏（条与 pill 同位，
 * 露出会闪）、悬停中的条亮起（延迟反馈）。
 *
 * 返回「唤出的组是否变了」——变了才要重声明热区（该组的命中区从条换成 pill）。
 */
function applySummonView(): boolean {
  const popped = summonedGroups(summonState).slice().sort()
  const hover = Object.entries(summonState.groups)
    .filter(([, g]) => g.onStrip)
    .map(([k]) => k)
    .sort()
  const nextPopped = popped.join(',')
  const nextHover = hover.join(',')
  const poppedChanged = nextPopped !== poppedSig
  if (!poppedChanged && nextHover === hoverSig) return false
  const before = poppedSig ? poppedSig.split(',') : []
  poppedSig = nextPopped
  hoverSig = nextHover
  // 唤出的组复现（其余组保持退场）
  for (const [group, el] of Object.entries(SUMMON_GROUP_ELEMENT)) {
    el.classList.toggle('summon-popped', popped.includes(group))
  }
  // 新唤出的组走 140ms 上滑淡入（重渲不重放——只有「新唤出」这一拍才放）
  for (const group of popped) {
    if (before.includes(group)) continue
    const el = SUMMON_GROUP_ELEMENT[group]
    if (el) animateSummonRise(group, el)
  }
  // 条：已唤出组的条隐藏；悬停中的条亮起（亮条只是预告，弹出仍等 150ms）
  for (const el of summonLayer?.querySelectorAll<HTMLElement>('.tb-summon-strip') ?? []) {
    const group = el.dataset.group ?? ''
    const g = summonState.groups[group]
    el.style.display = g && !g.stripVisible ? 'none' : ''
    el.classList.toggle('hover', hover.includes(group))
  }
  // 唤出的组换了 → 命中区换了（该组的条退场、pill 顶上）——热区必须重声明，
  // 否则条带窗的热区仍指向已退场的条，弹出组的上半截点不动。
  if (poppedChanged && current) declareHotZones(current)
  return poppedChanged
}

/** 唤出条渲染（收栏态）：几何重算 + 条 DOM 同步 + 唤出态落 DOM */
function renderSummon(): void {
  if (barMode !== 'maximize-retract') {
    summonStrips = []
    if (summonLayer) summonLayer.textContent = ''
    applySummonView()
    return
  }
  summonStrips = planSummonStripsNow()
  syncSummonStrips(summonStrips)
  notifySummonStrips(summonStrips)
  applySummonView()
}

/**
 * 唤出条几何存证（工单242）：验收侧据此断言「逐组一条、镜像 pill 横向区间、
 * 组间空隙不出条、显示桌面细条在最右端独立一条」。
 *
 * 与 taskbar-geometry 同款纪律：几何未变不重复刷事件流。事件名与既有的
 * taskbar-retract / taskbar-yield 同族（taskbar-<名>）。
 */
let lastSummonStripsJson = ''
function notifySummonStrips(strips: SummonStripGeometry[]): void {
  const payload = {
    strips: strips.map((s) => ({
      group: s.group,
      x: s.x,
      width: s.width,
      top: s.hitTop,
      height: s.hitHeight,
      visualTop: s.visualTop,
      visualHeight: s.visualHeight,
    })),
  }
  const json = JSON.stringify(payload)
  if (json === lastSummonStripsJson) return
  lastSummonStripsJson = json
  window.deck.host.notify('taskbar-summon-strips', payload)
}

/**
 * 唤出对账拍（25ms，与主进程光标轮询同频）：按光标坐标校正悬停态 + 推进逻辑时钟
 * （到点的悬停弹出、到点的宽限收起）。**不采信浏览器 enter/leave 事件序列**。
 */
function summonTick(): void {
  if (barMode !== 'maximize-retract') return
  if (dragSource) return // 拖拽会话持门期（工单195）：热区轮询暂停，对账一并暂停
  const now = Date.now()
  summonState = reconcilePointer(summonState, cursorZone, now)
  summonState = tickSummon(summonState, now)
  applySummonView() // 唤出的组变了 → 命中区跟着重声明（在本函数内收口）
}

interface Rect { id: string; x: number; y: number; w: number; h: number }

function rectOf(el: HTMLElement, id: string): Rect {
  const r = el.getBoundingClientRect()
  return { id, x: r.x, y: r.y, w: r.width, h: r.height }
}

/** 各 pill、按钮/推荐位/应用组条目/右组单元格与细条矩形（CSS px 相对客户区）：
 * 热区声明与验收存证共用同一份测量。推荐位矩形量测出处随工单192 拆出迁到 #pill-recs
 * （字段名与语义不变——taskbar-geometry 的 recommendations 断言存活前提） */
function measure() {
  return {
    startPill: rectOf(pillStart, 'pill-start'),
    recPill: rectOf(pillRecs, 'pill-recs'),
    buttons: [...pillStart.querySelectorAll<HTMLElement>('.tb-btn')].map((el) => rectOf(el, el.dataset.id ?? '')),
    recommendations: [...pillRecs.querySelectorAll<HTMLElement>('.tb-rec')].map((el) => ({
      name: el.dataset.name ?? '', ...rectOf(el, ''),
    })).map(({ name, ...r }) => ({ name, x: r.x, y: r.y, w: r.w, h: r.h })),
    appsPill: rectOf(pillApps, 'pill-apps'),
    apps: [...pillApps.querySelectorAll<HTMLElement>('.tb-app')].map((el) => rectOf(el, el.dataset.exe ?? '')),
    overflow: (() => { const el = pillApps.querySelector<HTMLElement>('.tb-overflow'); return el ? rectOf(el, 'overflow') : null })(),
    rightPill: rectOf(rightPill, 'right-pill'),
    rightCells: [...rightPill.querySelectorAll<HTMLElement>('[data-id]')].map((el) => rectOf(el, el.dataset.id ?? '')),
    trayIcons: [...rightPill.querySelectorAll<HTMLElement>('.tb-tray-icon')].map((el) => ({
      key: el.dataset.key ?? '', ...rectOf(el, el.dataset.key ?? ''),
    })).map(({ key, ...r }) => ({ key, x: r.x, y: r.y, w: r.w, h: r.h })),
    trayOverflow: (() => { const el = rightPill.querySelector<HTMLElement>('.tb-tray-overflow'); return el ? rectOf(el, 'tray-overflow') : null })(),
    sliver: rectOf(sliver, 'show-desktop'),
  }
}

/** 热区声明（工单52/54/55 并集，工单192 推荐组独立 pill 入列）：开始组不渲染（两按钮全
 * 隐藏）不含其矩形、推荐组不渲染（无推荐位）不含其矩形（两组显隐解耦，各自缺席各自裁）；
 * 应用组装了条目才报应用组矩形（空组不渲染 pill，缝隙保持穿透）；右组（摘要+音量+时钟）
 * 与显示桌面细条随 enabled 声明；三组皆无即清空——条带整幅恢复穿透 */
function declareHotZones(state: TaskbarState): void {
  if (!state.enabled) {
    window.deck.host.setHotZones([])
    return
  }
  // 收栏态（工单241/242）：栏面退场；热区 = 唤出条命中区 + 已唤出 pill 的命中区
  // （沿用同一热区通路：declareHotZones → setHotZones → preload → 主进程 tracker；
  //  id 编码供主进程按光标坐标 hit-test 后回报，渲染层据此对账悬停态）
  if (barMode === 'maximize-retract') {
    window.deck.host.setHotZones(summonHotZones(summonState, summonStrips, poppedPillRects()))
    return
  }
  const vm = taskbarViewModel(state)
  const m = measure()
  const zones = [m.rightPill, m.sliver]
  if (vm.visible) zones.unshift(m.startPill)
  if (vm.recsVisible) zones.unshift(m.recPill)
  if (vm.apps.length > 0) zones.unshift(m.appsPill)
  window.deck.host.setHotZones(zones)
}

/** 最近一次几何存证签名：几何未变的重渲（窗口标题刷新等无位移帧）不重复刷事件流 */
let lastGeometryJson = ''

/** 几何存证（验收电池点击坐标来源）：pill/按钮/推荐位/应用组/右组矩形任一变化即补发一帧——
 * 推荐位随数据面快照后到位会推推荐组/开始组 pill 移位，电池按 settle 后的最新帧取坐标 */
function notifyGeometry(): void {
  // 收栏态（工单241）：栏面不在场（各组 pill 全部退场），几何帧无内容可报——不发。
  // 避免验收侧读到全零矩形误判「栏跑位」；栏面复现时按常态几何再发一帧。
  if (barMode === 'maximize-retract') return
  const m = measure()
  const payload: Record<string, unknown> = {
    startPill: m.startPill,
    recPill: m.recPill,
    buttons: m.buttons,
    recommendations: m.recommendations,
    appsPill: m.appsPill,
    apps: m.apps,
    overflow: m.overflow,
    rightPill: m.rightPill,
    rightCells: m.rightCells,
    trayIcons: m.trayIcons,
    trayOverflow: m.trayOverflow,
    sliver: m.sliver,
  }
  const json = JSON.stringify(payload)
  if (json === lastGeometryJson) return
  lastGeometryJson = json
  window.deck.host.notify('taskbar-geometry', payload)
}

/** 系统动作格点击分发 + 存证（开始组按钮与右组格同一通道） */
function wireAction(el: HTMLElement, id: string): void {
  el.addEventListener('click', () => {
    void dispatchTaskbarButton(window.deck.bridge, id)
      .then((r) => {
        if (r.action) window.deck.host.notify('taskbar-action', { action: r.action })
        window.deck.host.notify('taskbar-action-result', { action: r.action, ok: r.ok, ...(r.error ? { error: r.error } : {}) })
      })
  })
}

/** 右组硬件摘要格（工单55）：常态按勾选子集呈现数值段；编辑态五项全呈现、点击段即
 * 切换勾选（经 taskbar/set-metrics 持久化——重启保持的勾选通道），再右键/点格外退出编辑。 */
function renderSummary(metrics: TaskbarState['metrics'], gauges: HardwareGauges | null): HTMLElement | null {
  const segments = summaryViewModel(metrics, editing)
  if (!segments.some((s) => s.visible)) return null
  const cell = document.createElement('div')
  cell.className = 'tb-cell'
  cell.id = 'hw-summary'
  cell.dataset.id = 'hw-summary'
  if (editing) cell.classList.add('editing')
  for (const seg of segments) {
    if (!seg.visible) continue
    const el = document.createElement('span')
    el.className = `tb-seg${seg.on ? ' on' : ' off'}`
    el.dataset.metric = seg.id
    // 常态呈现数值；编辑态呈现指标名（勾选语义一目了见，数值被勾选态取代）
    el.textContent = editing ? seg.label : formatMetric(seg.id, gauges ?? { cpu: 0, memory: 0, memory_gb: '--' })
    if (editing) {
      el.addEventListener('click', (ev) => {
        ev.stopPropagation()
        const next = toggleMetric(current?.metrics ?? [], seg.id)
        void window.deck.bridge.invoke('taskbar/set-metrics', { metrics: next })
      })
    }
    cell.appendChild(el)
  }
  // 右键进出编辑态（勾选显示子集的唯一入口）
  cell.addEventListener('contextmenu', (ev) => {
    ev.preventDefault()
    editing = !editing
    if (current) requestRender(current)
  })
  return cell
}

/**
 * 弹窗菜单面转达收层（工单196）：条带窗 focusable:false 点了不夺焦，浮层收不到
 * blur——栏面点击/右键由本页显式转达宿主（托盘溢出浮层工单162 同款纪律）。各域只认
 * 自家 notify 名；请求不在册（浮层本未开）不发 notify（宿主 hide 对不可见窗本就
 * no-op，省空转）。reason=strip-click 落各域 closed 存证。
 */
function relayClose(face: 'app' | 'rec' | 'blank' | 'tier' | 'wins'): void {
  const map = {
    app: { get: () => appMenuRequested, set: (v: boolean) => { appMenuRequested = v }, close: 'taskbar-app-menu-close' },
    rec: { get: () => recMenuRequested, set: (v: boolean) => { recMenuRequested = v }, close: 'taskbar-rec-menu-close' },
    blank: { get: () => blankMenuRequested, set: (v: boolean) => { blankMenuRequested = v }, close: 'taskbar-blank-menu-close' },
    tier: { get: () => tierMenuRequested, set: (v: boolean) => { tierMenuRequested = v }, close: 'taskbar-tier-menu-close' },
    wins: { get: () => winsListRequested, set: (v: boolean) => { winsListRequested = v }, close: 'taskbar-wins-menu-close' },
  } as const
  const f = map[face]
  if (!f.get()) return
  f.set(false)
  window.deck.host.notify(f.close, { reason: 'strip-click' })
}

/** 条带内左键点击的转达收层全集（「⋯」豁免由调用面裁决——左键点它开的是托盘溢出
 * 浮层而非档位菜单，横排时代点「⋯」不收档位菜单的行为随豁免保留） */
function relayCloseAllPopups(keepTrayOverflow: boolean): void {
  relayClose('app')
  relayClose('rec')
  relayClose('blank')
  if (!keepTrayOverflow) relayClose('tier')
  relayClose('wins')
}

/** 应用组图标装载（工单52）：缓存命中即贴；未命中经 desktop/icon 契约提取（内核侧按
 * iconKey 反解路径）。回填前核对元素仍代表同一图标键（重渲染后旧回填不贴错位）。 */
function applyIcon(img: HTMLImageElement, iconKey: string | null): void {
  if (!iconKey) return
  const cached = iconCache.get(iconKey)
  if (cached) {
    img.src = cached
    return
  }
  void window.deck.bridge.invoke('desktop/icon', { key: iconKey }).then((r) => {
    const dataUrl = r?.dataUrl
    if (!dataUrl) return
    iconCache.set(iconKey, dataUrl)
    if (img.dataset.iconKey === iconKey) img.src = dataUrl
  })
}

/** 托盘图标像素缓存（工单56：身份键 → dataURL；仅内存，与桌面图标缓存同款纪律——
 * 同一图标每次状态帧都被重渲，重复 canvas 编码是纯浪费）。px = 源尺寸小于显示档
 * （工单240：档 16px，源更小时才需最近邻放大保持锐利——16px 源 1:1 直渲不挂）
 * ——重渲直接复用，不再重判。 */
const trayIconUrls = new Map<string, { url: string; px: boolean }>()

/** 托盘图标格（工单56）：像素按需取（缓存命中即贴），左键/右键各自回放到所属应用。
 * 回填前核对元素仍代表同一身份（重渲后旧回填不贴错位）。工单240：图标统一按 16px
 * 原生直渲（源图本就 16px——不放大不拉伸，1:1 直渲），更小的源才挂 .tb-tray-px
 * 最近邻放大；32px 源降采样平滑插值
 * （挂靠判据 = taskbar-view trayIconPixelated 纯函数，离线单测钉住）。 */
function makeTrayEl(entry: TaskbarTrayEntry): HTMLElement {
  const el = document.createElement('div')
  el.className = 'tb-cell tb-tray-icon'
  el.dataset.key = entry.key
  el.title = entry.tooltip
  const img = document.createElement('img')
  img.dataset.key = entry.key
  img.alt = entry.tooltip || entry.key
  el.appendChild(img)
  const cached = trayIconUrls.get(entry.key)
  if (cached) {
    img.src = cached.url
    img.classList.toggle('tb-tray-px', cached.px)
  } else {
    void fetchTrayIcon(window.deck.bridge, entry.key).then((pixels) => {
      if (!pixels) return
      const url = trayDataUrl(pixels)
      const px = trayIconPixelated(pixels.width)
      trayIconUrls.set(entry.key, { url, px })
      if (img.dataset.key === entry.key) {
        img.src = url
        img.classList.toggle('tb-tray-px', px)
      }
    })
  }
  const click = (button: TaskbarTrayButton) => () => {
    window.deck.host.notify('taskbar-tray-click', { key: entry.key, button })
    void dispatchTrayClick(window.deck.bridge, entry.key, button)
      .then((r) => window.deck.host.notify('taskbar-tray-click-result', { key: entry.key, button, ok: r.ok, ...(r.error ? { error: r.error } : {}) }))
  }
  el.addEventListener('click', click('left'))
  el.addEventListener('contextmenu', (ev) => {
    ev.preventDefault()
    ev.stopPropagation()
    click('right')()
  })
  return el
}

/**
 * 栏面是否在场（工单253）：收栏态（maximize-retract）**栏面退场**——各组 pill 与显示桌面
 * 细条全部 display:none（只剩被唤出的组复现）。
 *
 * 退场邻组的几何对当前布局**无意义**（实测宽度 0）：挤撞守卫若照量，会把已唤出的组按 0 宽
 * 裁剪（开始/推荐组被裁成 18px 空壳、应用组只剩「⋯」溢出钮 ⇒ 应用图标与推荐条目点不到，
 * 工单243 真机取证）。收栏态的处置：**布局冻结在收栏那一刻**——挤撞守卫与落位都不重算
 * （已唤出的组沿用收栏前的几何），唤出条镜像的也是同一份收栏前矩形 ⇒ 条与组同宽同位
 * （用户故事 13「位置记忆不打架」）。
 */
function barSurfaceOnStage(): boolean {
  return barMode !== 'maximize-retract'
}

/** 开始组钉条带左缘（工单159 布局重排）：位置由 CSS（#pill-start left:8px）钉死——旧
 * positionStartPill 的屏幕居中 + [应用组右缘, 右组左缘] 夹取随布局反转退役。唯一守卫 =
 * 极端拥挤（26+ 托盘右组宽出）时 maxWidth 收窄到右组左缘前——系统钮 flex:none 永不裁切
 * （工单158 P5 真机红回归钉的守卫保留；推荐位图标格已随工单192 拆出，让位面迁 clampRecPillWidth）。
 * 只在结构性重渲落位：右组 1Hz 指标文本宽度抖动（±45px）不传导（applyStatus 不动 pill），
 * 电池的 settle 几何因此跨拍稳定。
 *
 * 工单253：收栏态栏面退场 ⇒ 右组量不到（宽度 0）⇒ 守卫不跑（退场邻组不参与裁剪），
 * 已唤出的组沿用收栏前的收窄结果。 */
function clampStartPillWidth(): void {
  if (pillStart.hidden) return
  if (!barSurfaceOnStage()) return // 工单253：退场邻组不参与裁剪（守卫不按 0 宽裁已唤出的组）
  const avail = rightPill.getBoundingClientRect().left - GROUP_GAP - APPS_INSET
  pillStart.style.maxWidth = `${Math.max(0, Math.round(avail))}px`
}

/** 推荐组落位（工单192 独立拆出）：开始组右缘+组间距（开始组整组不渲染时退条带左缘内衬
 * ——两组显隐解耦后推荐组可独自在场）。内容装配完同步落位——无中间帧闪烁；推荐组不渲染
 * （无推荐位）不落位。
 *
 * 工单253：收栏态不落位（栏面退场、开始组量不到，落位会漂到条带左缘）——沿用收栏前的
 * 落位（唤出条镜像同一份矩形 ⇒ 条与组同位）。 */
function positionRecPill(): void {
  if (pillRecs.hidden) return
  if (!barSurfaceOnStage()) return // 工单253：布局冻结在收栏那一刻
  const left = pillStart.hidden ? APPS_INSET : pillStart.getBoundingClientRect().right + GROUP_GAP
  pillRecs.style.left = `${Math.round(left)}px`
}

/** 推荐组拥挤守卫（工单158 守卫语义随工单192 拆出随迁）：极端拥挤（26+ 托盘右组宽出）
 * 时 maxWidth 收窄到右组左缘前——推荐位图标格随 pill 整体裁剪（定宽格不吃文字收缩档，
 * overflow hidden），与 clampStartPillWidth 同族。
 *
 * 工单253：收栏态不跑（退场的右组量不到 ⇒ 收窄值是 0 ⇒ 推荐位被裁成空壳、点不到）。 */
function clampRecPillWidth(): void {
  if (pillRecs.hidden) return
  if (!barSurfaceOnStage()) return // 工单253：退场邻组不参与裁剪
  const avail = rightPill.getBoundingClientRect().left - GROUP_GAP - pillRecs.getBoundingClientRect().left
  pillRecs.style.maxWidth = `${Math.max(0, Math.round(avail))}px`
}

/** 收栏前缓存的各组 pill 区间（收栏态的布局来源——与唤出条镜像的**同一份**矩形） */
function cachedSpan(group: string): GroupPillSpan | undefined {
  const p = summonPillCache.find((r) => r.group === group)
  return p ? { x: p.x, width: p.width } : undefined
}

/** 应用组空带（工单159，工单192 左邻随推荐组拆出随迁）：[左邻组右缘, 右组左缘] —— 居中
 * 参照系与两侧容量边界同源。左邻按推荐组优先（appsBandLeft 纯函数裁决：推荐组在场取其
 * 右缘，缺席回退开始组右缘，都不在场退条带左缘内衬）
 *
 * 工单253：收栏态栏面退场、活邻组量不到（实测宽度 0）⇒ 常态口径算出的空带是零宽带（容量
 * 0 格 ⇒ 应用条目全被塞进「⋯」溢出，组被压成 54px 的溢出钮）。收栏态改取**收栏前缓存的
 * 区间**（唤出条镜像的同一份）⇒ 容量与收栏前一致，已唤出的组拿到可点击的宽度。 */
function currentAppsBand(): AppsBand {
  if (!barSurfaceOnStage()) {
    // 收栏态：两侧边界取收栏前缓存（退场邻组不参与裁剪；右组缺位 ⇒ 右界不设限）
    return appsBandFromSpans({
      start: cachedSpan('start'),
      recs: cachedSpan('recs'),
      right: cachedSpan('right'),
    })
  }
  return appsBand(
    appsBandLeft(
      pillRecs.hidden ? null : pillRecs.getBoundingClientRect().right,
      pillStart.hidden ? null : pillStart.getBoundingClientRect().right,
    ),
    rightPill.getBoundingClientRect().left,
  )
}

/** 应用组落位（工单190）：pill 中心对齐屏幕水平中心线（appsPillLeft 纯函数——中心锚定
 * 不随开始组/推荐组/右组宽度漂移，推荐增删/托盘档位切换后结构性重渲自动回正；带外夹取
 * 维持现状、带宽不足钉带左缘）。锚点取 innerWidth/2：条带窗横跨主屏全宽且窗 x = 屏 x
 * （stripBounds 通栏口径，降级净空只让纵向），视口中线即屏幕水平中心线。pill 宽度按
 * offsetWidth 实测（border-box，含内衬边框），内容装配完同步落位——无中间帧闪烁
 *
 * 工单253：收栏态不落位（沿用收栏前的落位——与唤出条镜像的矩形同位）。 */
function positionAppsPill(band: AppsBand): void {
  if (pillApps.style.display === 'none') return
  if (!barSurfaceOnStage()) return // 工单253：布局冻结在收栏那一刻
  pillApps.style.left = `${appsPillLeft(band, pillApps.offsetWidth, window.innerWidth / 2)}px`
}

/** 应用组图标点击（工单53）：裁决在内核（app-click 三态 + 多窗口列表），此处只做
 * 分发与呈现——launch/activate/minimize 无需回显，window-list 即请求选窗浮层开层
 * （工单196 迁浮层窗：行集由浮层页按 exe 即席经 taskbar/app-windows 拉取，条带内
 * 不再横排列窗口；标题仅即时呈现不落存储，ADR-0002）。 */
async function onAppClick(e: TaskbarAppViewEntry, inOverflow: boolean): Promise<void> {
  window.deck.host.notify('taskbar-app-action', { exe: e.exe })
  const r = await dispatchAppClick(window.deck.bridge, e.exe)
  window.deck.host.notify('taskbar-app-result', {
    exe: e.exe,
    action: r.action,
    ok: r.ok,
    ...(r.error ? { error: r.error } : {}),
  })
  if (r.ok && r.action === 'window-list' && r.windows?.length) {
    winsListRequested = true
    window.deck.host.notify('taskbar-wins-menu-open', { exe: e.exe })
  } else if (winsListRequested) {
    // 非列表回执（多窗化退为单窗等）：转达收层——原生同语义，点图标未出列表即收旧列表
    relayClose('wins')
  }
  if (inOverflow) overflowOpen = false
  if (current) requestRender(current)
}

/** 拖拽接线（工单57，工单195 全量拖拽语义）：拖到某个条目上 = 落该条目之前（亮条指示
 * ——before 语义，所有条目都可落）；拖到组内空白 = 落源条目所属段末尾（before=null）。
 * 跨组同款：推荐→应用升手钉、应用→推荐解除手钉回推荐池。落点裁决与落盘在内核
 * （taskbar/drag-drop），渲染层只负责源记录与落点反馈。 */
function makeDraggable(el: HTMLElement, group: TaskbarDragGroup, id: string): void {
  el.draggable = true
  el.addEventListener('dragstart', (ev) => {
    dragSource = { group, id }
    el.classList.add('dragging')
    window.deck.host.notify('taskbar-drag-start', { group, id })
    // 断点③（工单195）：热区持门开门——OLE 拖拽活动期穿透轮询不关门，跨组/缝隙松手不丢
    window.deck.host.setDragSession(true)
    if (ev.dataTransfer) {
      ev.dataTransfer.effectAllowed = 'move'
      ev.dataTransfer.setData('text/plain', id)
    }
  })
  el.addEventListener('dragend', () => {
    dragSource = null
    window.deck.host.setDragSession(false)
    el.classList.remove('dragging')
    document.querySelectorAll('.tb-drop-before').forEach((n) => n.classList.remove('tb-drop-before'))
    // 断点②（工单195）补渲：会话已结束，挂起的最新一帧（无则 resize 跳拍时的现态）一次补上
    const held = dragHeld
    dragHeld = null
    if (dragResized && current) render(held ?? current)
    else if (held) render(held)
    dragResized = false
  })
  el.addEventListener('dragover', (ev) => {
    ev.preventDefault()
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move'
    el.classList.add('tb-drop-before')
  })
  el.addEventListener('dragleave', () => el.classList.remove('tb-drop-before'))
  el.addEventListener('drop', (ev) => {
    ev.preventDefault()
    ev.stopPropagation()
    el.classList.remove('tb-drop-before')
    if (!dragSource) return
    void onDrop(dragSource, group, id)
  })
}

/** 拖拽失败可见反馈（工单195）：服务层拒返（ok:false）与契约异常都不静默——条带内
 * toast 逐字透出错误文案，5s 兜底自收；#drag-toast 是 body 直挂节点，整树重渲不触碰，
 * 验收电池按 DOM 在场 + 文案断言。 */
let dragToastTimer: ReturnType<typeof setTimeout> | null = null
function showDragError(message: string): void {
  let el = document.getElementById('drag-toast')
  if (!el) {
    el = document.createElement('div')
    el.id = 'drag-toast'
    document.body.appendChild(el)
  }
  el.textContent = message
  el.dataset.on = '1'
  if (dragToastTimer !== null) clearTimeout(dragToastTimer)
  dragToastTimer = setTimeout(() => {
    const t = document.getElementById('drag-toast')
    if (t) {
      t.textContent = ''
      delete t.dataset.on
    }
    dragToastTimer = null
  }, 5000)
}

/** 落位一次拖拽：同组换位与跨组语义同一道分发，落点 before 恒为条目身份。
 * dragSource 不在此清（drop 后 dragend 恒尾随，清场+补渲统一在 dragend——成功换位
 * 的 taskbar/changed 回推若赶在 dragend 之前到达，冻结闸还开着，正好由 dragend 补渲）。
 * 失败（拒返/契约异常）走可见反馈，不静默（工单195）。 */
async function onDrop(src: { group: TaskbarDragGroup; id: string }, to: TaskbarDragGroup, before: string | null): Promise<void> {
  window.deck.host.notify('taskbar-drag-drop', { from: src.group, to, id: src.id, before })
  let r: { ok: boolean; error?: string }
  try {
    r = await dispatchTaskbarDragDrop(window.deck.bridge, { from: src.group, to, id: src.id, before })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    window.deck.host.notify('taskbar-drag-result', { ok: false, error: message })
    showDragError(`拖拽落位失败：${message}`)
    return
  }
  window.deck.host.notify('taskbar-drag-result', { ok: r.ok, ...(r.error ? { error: r.error } : {}) })
  if (!r.ok) showDragError(`拖拽落位失败：${r.error ?? '服务层拒收'}`)
}

/** 组容器落尾（拖到组内空白处）：before = null = 源条目所属段末尾（工单195：应用组按源
 * 归属落手钉段/运行段末尾——段位收敛裁决在内核；条目自身的 drop 已 stopPropagation，
 * 本容器处理器只接真空白） */
function makeGroupDropTarget(container: HTMLElement, group: TaskbarDragGroup): void {
  container.addEventListener('dragover', (ev) => {
    if (!dragSource) return
    ev.preventDefault()
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move'
  })
  container.addEventListener('drop', (ev) => {
    if (!dragSource) return
    ev.preventDefault()
    if ((ev.target as HTMLElement).closest('.tb-app, .tb-rec, .tb-drop-before')) return // 条目自身已接
    void onDrop(dragSource, group, null)
  })
}

/** 应用组图标元素（栏内与溢出浮层同一构建路径——同 .tb-app 形态、同 data-exe 挂点、
 * 同点击分发；工单53 的全交互在同一挂点上扩展后两边自然一致）。inOverflow = 点在浮层
 * 里：分发后收层（Win11 溢出浮层同款——点完即收）。 */
function makeAppEl(e: TaskbarAppViewEntry, inOverflow: boolean): HTMLElement {
  const el = document.createElement('div')
  el.className = e.running ? 'tb-app running' : 'tb-app'
  el.dataset.exe = e.exe // 交互挂点（点击/右键按 exe 身份分发）
  el.title = e.tooltip // 窗口标题 tooltip：仅即时显示，渲染层不持久化
  if (e.iconKey) {
    const img = document.createElement('img')
    img.draggable = false // 手钉拖拽的宿主是 .tb-app 本身：图标默认可拖会把手势截成原生图片拖拽
    img.dataset.iconKey = e.iconKey
    img.alt = e.label
    el.appendChild(img)
    applyIcon(img, e.iconKey)
  } else {
    // 工单156：无图标键条目渲染首字母占位（应用组统一，含仅运行条目），不出空白格
    const fb = document.createElement('div')
    fb.className = 'tb-app-letter'
    fb.textContent = appIconFallbackText(e)
    el.appendChild(fb)
  }
  // 工单195 断点①全条目接线：所有应用组条目（含未钉运行）可起拖可落——运行段拖位是
  // 会话态（reorderRunOrder），手钉段拖位落盘；任何条目都是 before 落点（不再被容器
  // 守卫静默吞掉）
  makeDraggable(el, 'apps', e.exe)
  el.addEventListener('click', () => { void onAppClick(e, inOverflow) })
  el.addEventListener('auxclick', (ev) => {
    if (ev.button !== 1) return
    ev.preventDefault() // 中键开新实例：Win11 任务栏同款
    window.deck.host.notify('taskbar-app-new-instance', { exe: e.exe })
    void dispatchAppNewInstance(window.deck.bridge, e.exe)
    if (inOverflow) {
      overflowOpen = false
      if (current) requestRender(current)
    }
  })
  el.addEventListener('contextmenu', (ev) => {
    ev.preventDefault()
    ev.stopPropagation() // 不让冒泡到 pill 的空白右键菜单（工单54）
    // 右键菜单迁浮层窗（工单193）：开层请求只携带 exe 身份（行集由浮层页自足推导，
    // 与条带视图永不各判一次）；鼠标位置即锚点（宿主开层拍取光标）
    appMenuRequested = true
    window.deck.host.notify('taskbar-app-menu-open', { exe: e.exe })
  })
  return el
}

/** 推荐组条目元素（工单160 图标化）：只呈现应用图标（无名称文字，显示名即时进出
 * tooltip），图标经 desktop/icon 契约同款管线（iconKey → dataURL 本地缓存，应用组
 * applyIcon 同源）；无图标键条目首字母占位（工单156 appIconFallbackText 复用）。
 * 左键启动经 taskbar/rec-click（exe 身份寻址）；右键三行菜单（手钉/移除/打开位置，工单161）；
 * 拖拽宿主 .tb-rec 本身（组内换位 / 拖应用组升手钉，工单57 内核已接线）。 */
function makeRecEl(rec: TaskbarRecommendation): HTMLElement {
  const el = document.createElement('div')
  el.className = 'tb-rec'
  el.dataset.name = rec.name // 几何存证与拖拽挂点按桌面项 name（既有口径）
  el.dataset.exe = rec.exe // 交互挂点（点击/右键按富化 exe 身份分发）
  el.title = rec.display
  if (rec.iconKey) {
    const img = document.createElement('img')
    img.draggable = false // 拖拽宿主是 .tb-rec 本身：图标默认可拖会把手势截成原生图片拖拽
    img.dataset.iconKey = rec.iconKey
    img.alt = rec.display
    el.appendChild(img)
    applyIcon(img, rec.iconKey)
  } else {
    // 无图标键条目首字母占位（工单156 同款），不出空白格
    const fb = document.createElement('div')
    fb.className = 'tb-rec-letter'
    fb.textContent = appIconFallbackText({ label: rec.display, exe: rec.exe })
    el.appendChild(fb)
  }
  makeDraggable(el, 'recs', rec.name) // 推荐位可拖：组内换位 / 拖应用组升手钉
  el.addEventListener('click', () => {
    window.deck.host.notify('taskbar-rec-click', { name: rec.name, exe: rec.exe })
    void dispatchRecClick(window.deck.bridge, rec.exe)
      .then((r) => window.deck.host.notify('taskbar-rec-click-result', { name: rec.name, exe: rec.exe, ok: r.ok, ...(r.error ? { error: r.error } : {}) }))
  })
  el.addEventListener('contextmenu', (ev) => {
    ev.preventDefault()
    ev.stopPropagation() // 不让冒泡到 pill 的空白右键菜单（工单54）
    // 推荐条目三行菜单迁浮层窗（工单196，ADR-0013）：开层请求携带 exe/name 身份
    // （行集由浮层页自足推导；name 随动作事件原样回传——事件载荷保持既有口径）；
    // 鼠标位置即锚点
    recMenuRequested = true
    window.deck.host.notify('taskbar-rec-menu-open', { exe: rec.exe, name: rec.name })
  })
  return el
}

/** 应用组渲染（工单52/58/159）：手钉+运行中合并条目按容量拆分——容量按空带两侧边界
 * 裁决（appsSlotsFor——闭合形态恒在带内，不与邻组重叠）；栏内满员即出 ⋯ 钮，浮层开着时
 * 尾部条目横排进 pill（条带窗只有 48px 高（工单238），竖排浮层出不了窗口矩形，54 右键
 * 菜单同款先例）；数量回落浮层自动收、图标回栏。装配完就地居中落位（positionAppsPill
 * ——开合/增删后的结构性重渲即回正）。空组整组不渲染（display:none） */
function renderApps(entries: TaskbarAppViewEntry[]): void {
  pillApps.textContent = ''
  pillApps.style.display = entries.length ? '' : 'none'
  if (!entries.length) {
    overflowOpen = false
    return
  }
  const band = currentAppsBand()
  const { bar, overflow } = splitAppsOverflow(entries, appsSlotsFor(band))
  if (!overflow.length) overflowOpen = false // 数量回落自动收层（图标全部回栏）
  for (const e of bar) pillApps.appendChild(makeAppEl(e, false))
  if (overflow.length) {
    const toggle = document.createElement('div')
    toggle.className = 'tb-overflow'
    toggle.textContent = '⋯'
    toggle.title = `更多应用（${overflow.length}）`
    toggle.addEventListener('click', () => {
      overflowOpen = !overflowOpen
      if (current) requestRender(current)
    })
    pillApps.appendChild(toggle)
    if (overflowOpen) {
      const sep = document.createElement('div')
      sep.className = 'tb-apps-sep'
      pillApps.appendChild(sep)
      for (const e of overflow) pillApps.appendChild(makeAppEl(e, true))
    }
  }
  positionAppsPill(band)
}

function render(state: TaskbarState): void {
  current = state
  const vm = taskbarViewModel(state)
  pillStart.hidden = !vm.visible
  pillRecs.hidden = !vm.recsVisible // 两组显隐解耦（工单192）：推荐组按推荐位有无独立裁决
  pillStart.textContent = ''
  pillRecs.textContent = ''
  // 菜单开合态不驻条带（工单196 五面全迁浮层窗）：条带内无菜单 DOM，宿主 pill 缺席/
  // 条目退场等空态由浮层页按 changed 重推导自收（行集空=empty）
  // 开始组 pill（工单54；工单192 边界收窄：两按钮全隐藏 → 整组不渲染，推荐位已拆出不随其显隐）
  for (const b of vm.buttons) {
    const el = document.createElement('div')
    el.className = 'tb-btn'
    el.dataset.id = b.id
    el.textContent = b.label
    // 工单240：开始组图标化（字面即图标）——可见名退到 title/aria-label
    el.title = b.title
    el.setAttribute('aria-label', b.title)
    el.addEventListener('click', () => {
      window.deck.host.notify('taskbar-action', { action: b.action })
      void dispatchTaskbarButton(window.deck.bridge, b.id)
        .then((r) => window.deck.host.notify('taskbar-action-result', { action: r.action, ok: r.ok, ...(r.error ? { error: r.error } : {}) }))
    })
    pillStart.appendChild(el)
  }
  // 推荐组 pill（工单192 独立拆出）：推荐位图标渲染迁入独立容器，推荐位非空即独立在场
  for (const rec of vm.recommendations) {
    pillRecs.appendChild(makeRecEl(rec))
  }
  // 菜单行不再渲染进任何 pill（工单196，ADR-0013 全家迁通路）：应用组图标菜单（工单193
  // 首迁）、推荐条目三行、空白右键（系统显隐+恢复段）、托盘档位、多窗选窗五行全在
  // 浮层窗 DECK-TASKBAR-*-MENU 竖排呈现——条带 48px 高从此不约束菜单形态；开层/收层
  // 走 taskbar-*-menu-open/-close 请求，行渲染在浮层页 taskbar-menu.ts（域适配器）。
  // 右组（工单55）：硬件摘要 →（托盘位 #56 占位）→ 音量 → 时钟
  rightPill.textContent = ''
  if (state.enabled) {
    const summary = renderSummary(vm.metrics, latestStatus?.hardware ?? null)
    if (summary) rightPill.appendChild(summary)
    // 托盘入栏（工单56）+ 溢出收口（工单162）：按档位拆分——名单序前 N 枚平铺在摘要与
    // 音量格之间，超量尾部收进「⋯」（档位是用户声明的可见数，「⋯」不吃名额）；数量回落
    // 重拆即图标回栏、「⋯」消失。名单空即整段不渲染（无 ⋯ 亦无图标）。
    const { bar: trayBar, overflow: trayOverflow } = splitTrayOverflow(vm.tray, vm.trayOverflowLimit)
    if (!trayOverflow.length) trayPopupRequested = false // 溢出清空：浮层请求随之失效（宿主侧由 changed/空拆分自收）
    for (const entry of trayBar) rightPill.appendChild(makeTrayEl(entry))
    if (trayOverflow.length) {
      const more = document.createElement('div')
      more.className = 'tb-tray-overflow'
      more.dataset.id = 'tray-overflow'
      more.textContent = '⋯'
      more.title = `托盘溢出菜单（${trayOverflow.length}）`
      // 左键：请求宿主在鼠标位置开自绘竖排菜单面板（行交互与栏内图标同一回放分发）
      more.addEventListener('click', () => {
        trayPopupRequested = true
        window.deck.host.notify('taskbar-tray-overflow-open', { count: trayOverflow.length })
      })
      // 右键：档位菜单挂点一（挂点二 = 右组空白处右键，接线在 boot）——迁浮层窗
      //（工单196）：开层请求恒发（右键恒重开，横排时代右键拨动收层随通路语义退役）
      more.addEventListener('contextmenu', (ev) => {
        ev.preventDefault()
        ev.stopPropagation()
        tierMenuRequested = true
        window.deck.host.notify('taskbar-tier-menu-open', {})
      })
      rightPill.appendChild(more)
    }
    const volume = document.createElement('div')
    volume.className = 'tb-cell'
    volume.dataset.id = 'volume'
    volume.textContent = '♪ VOL'
    wireAction(volume, 'volume')
    rightPill.appendChild(volume)
    const clock = document.createElement('div')
    clock.className = 'tb-cell'
    clock.dataset.id = 'clock'
    clock.textContent = latestStatus ? formatClock(latestStatus.clock) : '--:--'
    wireAction(clock, 'clock')
    rightPill.appendChild(clock)
  }
  // 工单159 布局重排（工单192 推荐组拆出随迁）：右组先行落位 → 开始组钉左（CSS）+ 拥挤
  // 守卫收窄 → 推荐组落位（开始组右缘+组间距）+ 拥挤守卫收窄 → 应用组按空带（左邻=推荐组
  // 优先回退开始组，右邻=右组）裁容量并居中落位——依赖序自左向右，左邻矩形先于应用组成壳
  clampStartPillWidth()
  positionRecPill()
  clampRecPillWidth()
  renderApps(vm.apps)
  renderSummon() // 唤出条（工单242）：收栏态下逐组一条（几何重算 + 条 DOM + 唤出态）
  declareHotZones(state)
  cacheSummonPills(state)
  notifyGeometry()
}

/** 整树重渲的单一入口（工单195 断点②拖拽期渲染冻结）：dragSource 活动期（OLE 会话
 * 进行中）合帧挂起——只留最新一帧，dragend 补渲一次。被拖节点被重建即中止 Chromium
 * 拖拽会话（真机上标题变化/托盘事件/快照刷新每几秒推一帧 → ~75% 偶发弹回）。
 * taskbar/changed 回推、resize、8s 兜底定时器等一切可能撞上拖拽窗口的重渲都走这里；
 * dragend 补渲直接调 render（会话已终，无需再冻结）。 */
function requestRender(state: TaskbarState): void {
  if (dragSource) {
    dragHeld = state
    return
  }
  render(state)
}

/** 右组 1Hz 数据帧（工单55）：数值就地更新（不重排 DOM——段清单不变，避免每拍重建丢编辑态） */
function applyStatus(status: TaskbarStatus): void {
  latestStatus = status
  const clockEl = rightPill.querySelector<HTMLElement>('[data-id="clock"]')
  if (clockEl) clockEl.textContent = formatClock(status.clock)
  const values: Record<string, string> = {}
  for (const el of rightPill.querySelectorAll<HTMLElement>('#hw-summary .tb-seg')) {
    const id = (el.dataset.metric ?? '') as TaskbarMetric
    const text = formatMetric(id, status.hardware)
    values[id] = text
    if (!editing) el.textContent = text
  }
  // 验收存证：渲染出的右组数值（电池与硬件卡文本比对口径一致性）
  window.deck.host.notify('taskbar-right-status', { clock: clockEl?.textContent ?? '', values })
}

// 显示桌面细条（工单55）：点击 = Win+D ToggleDesktop
sliver.addEventListener('click', () => {
  void dispatchTaskbarButton(window.deck.bridge, 'show-desktop')
    .then((r) => {
      if (r.action) window.deck.host.notify('taskbar-action', { action: r.action })
      window.deck.host.notify('taskbar-action-result', { action: r.action, ok: r.ok, ...(r.error ? { error: r.error } : {}) })
    })
})

// 点摘要格外退出编辑态（窗口永不聚焦，键盘 Esc 不可靠——点空白即收）
document.addEventListener('click', (ev) => {
  if (editing && !(ev.target instanceof HTMLElement && ev.target.closest('#hw-summary'))) {
    editing = false
    if (current) requestRender(current)
  }
  // 托盘溢出浮层（工单162）：条带内任意点击（非「⋯」自身——那是开层钮）即请求收层。
  // 浮层窗 focusable:true 自收「栏外」点击（blur）；条带窗 focusable:false 点了不夺焦，
  // 浮层收不到 blur——栏面点击由本页显式转达宿主。
  if (trayPopupRequested && !(ev.target instanceof HTMLElement && ev.target.closest('.tb-tray-overflow'))) {
    trayPopupRequested = false
    window.deck.host.notify('taskbar-tray-overflow-close', { reason: 'strip-click' })
  }
  // 弹窗菜单五面（工单193/196）：条带内任意左键点击即转达收层（点应用图标也是——原生
  // 同语义：激活应用即收菜单；选窗列表同此理，同应用再点由回执 window-list 重开=重锚
  // 定。转达纪律与托盘溢出浮层同款。冒泡相即可——条带内唯一 stopPropagation 的点击
  // 挂点是摘要编辑段，而进编辑态的右键已被下方 contextmenu 捕获相转达收层，两态不并存）
  relayCloseAllPopups(ev.target instanceof HTMLElement && !!ev.target.closest('.tb-tray-overflow'))
})

/** 托盘档位菜单右键挂点谓词（spec188 评审收口：捕获相转达收层判据与 boot 内 rightPill
 * 开层守卫两处异形收一，恒等锁步防漂移）——右键落「⋯」（挂点一，自带接线）或右组
 * pill 自身与缝隙（挂点二）即属档位菜单域；格/托盘图标各有自家右键语义不属。挂点一
 * 与托盘图标自带 stopPropagation，开层守卫在可达输入上只放行 pill 自身与缝隙。 */
function isTierMenuSpot(el: Element | null): boolean {
  return !!el && (!!el.closest('.tb-tray-overflow')
    || (!!el.closest('#right-pill') && !el.closest('.tb-cell') && !el.closest('.tb-tray-icon')))
}

// 弹窗菜单互斥（工单193/196）：条带内右键 = 开某面（挂点上——原生菜单语义：右键开
// 新菜单收旧菜单）或开原生菜单（托盘图标回放等非挂点）——无论如何都把「非本拍挂点」
// 的面转达收层。捕获相先行（各挂点 preventDefault/stopPropagation 之前）；各挂点豁免
// 判据与其开层接线一一对应（应用图标/推荐条目/两组 pill 空白/「⋯」与右组缝隙）。
document.addEventListener('contextmenu', (ev) => {
  const el = ev.target instanceof HTMLElement ? ev.target : null
  const inSel = (sel: string): boolean => !!(el && el.closest(sel))
  const keepApp = inSel('.tb-app')
  const keepRec = inSel('.tb-rec')
  const keepBlank = inSel('#pill-start') || inSel('#pill-recs')
  const keepTier = isTierMenuSpot(el)
  if (appMenuRequested && !keepApp) relayClose('app')
  if (recMenuRequested && !keepRec) relayClose('rec')
  if (blankMenuRequested && !keepBlank) relayClose('blank')
  if (tierMenuRequested && !keepTier) relayClose('tier')
  if (winsListRequested) relayClose('wins') // 选窗列表无右键挂点：右键一律收
}, true)

function boot(): void {
  makeGroupDropTarget(pillApps, 'apps') // 拖到应用组空白 = 落源条目所属段末尾（工单195 段位收敛裁决在内核）
  makeGroupDropTarget(pillRecs, 'recs') // 拖到推荐组空白 = 落推荐位末尾（工单192 宿主随拆出随迁）
  // 右键（开始组/推荐组空白）= 空白菜单（系统按钮显隐+恢复段，工单54/161）迁浮层窗
  // （工单196）：开层请求恒发（右键恒重开——同 URL show 重锚定；横排时代右键拨动收层
  // 与 8s 兜底定时器随通路语义退役：blur/点空白/条目退场/条带转达收层全 Family 由通用
  // 浮层承载）。应用图标右键菜单是 #53（工单193 迁浮层）、推荐条目右键菜单是 #160
  // （工单196 迁浮层），各自 stopPropagation 不落到这里。
  const wireBlankMenu = (pill: HTMLElement) => {
    pill.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      blankMenuRequested = true
      window.deck.host.notify('taskbar-blank-menu-open', {})
    })
  }
  wireBlankMenu(pillStart)
  wireBlankMenu(pillRecs)
  // 右组空白处右键 = 托盘档位菜单挂点二（工单162，工单196 迁浮层）：格/托盘图标/「⋯」
  // 都有自己的右键语义（托盘图标回放、摘要编辑态切换等），只认 pill 自身与缝隙——
  // 豁免判据与捕获相收层判据同一谓词（isTierMenuSpot，spec188 评审收口恒等锁步）
  rightPill.addEventListener('contextmenu', (e) => {
    if (!isTierMenuSpot(e.target as HTMLElement)) return
    e.preventDefault()
    tierMenuRequested = true
    window.deck.host.notify('taskbar-tier-menu-open', {})
  })
  void (async () => {
    // 启动期失败不留痕的病（真机实证：条带静默不执行时电池只报「存证缺失」）——
    // 失败即落存证，验收与排障都能看见「是没跑还是跑崩了」
    let state: TaskbarState
    try {
      state = await window.deck.bridge.invoke('taskbar/get-state', null)
    } catch (err) {
      window.deck.host.notify('taskbar-boot-error', { stage: 'get-state', message: String(err) })
      return
    }
    try {
      render(state)
    } catch (err) {
      window.deck.host.notify('taskbar-boot-error', { stage: 'render', message: String(err), stack: (err as Error)?.stack ?? '' })
      return
    }
    // 三态下发（工单241）：主进程裁决后推当前档位——栏面退场/复现（唤出条待命）。
    // 订阅先于 ready 上报：主进程收到 taskbar-ready 即补发当前档位（握手补发不漏首推）。
    window.deck.bridge.on('taskbar/bar-mode', (p) => applyBarMode(p.mode))
    // 唤出条指针对账（工单242）：主进程 25ms 光标轮询按光标坐标 hit-test 的结论——
    // 悬停态只认这条事实（**不采信浏览器 enter/leave 事件序列**，原型振荡教训）。
    window.deck.bridge.on('taskbar/cursor-zone', (p) => {
      cursorZone = p.id
    })
    // 自绘浮层在场 → 钉住所属组（托盘溢出菜单钉右组，其余组照常收）；离场 → 解除钉住。
    window.deck.bridge.on('taskbar/popup-state', (p) => {
      if (barMode !== 'maximize-retract') return
      summonState = applyOverlayState(summonState, p.family, p.open, Date.now())
      applySummonView()
    })
    // 对账拍：25ms 一拍，与主进程光标轮询同频（校正悬停态 + 推进逻辑时钟）
    setInterval(() => summonTick(), SUMMON_TICK_MS)
    const m = measure()
    window.deck.host.notify('taskbar-ready', {
      enabled: state.enabled, startPill: m.startPill, recPill: m.recPill, buttons: m.buttons, recommendations: m.recommendations,
      appsPill: m.appsPill, apps: m.apps, overflow: m.overflow,
      rightPill: m.rightPill, rightCells: m.rightCells, trayIcons: m.trayIcons, trayOverflow: m.trayOverflow, sliver: m.sliver,
    })
    window.deck.bridge.on('taskbar/changed', (next) => {
      // 菜单不随 changed 收（工单161，工单162 档位菜单同款纪律：托盘 churn 每几秒推一帧，
      // 红轮实证回推即收会抢走刚开的菜单）——收层只走点行显式/点空白/8s 兜底三路径。
      // 工单195 断点②：经 requestRender 单一入口——拖拽会话活动期合帧挂起，dragend 补渲。
      requestRender(next)
    })
    // 硬件摘要 1Hz 数据帧（工单55）：勾选变更后按最近值立即填字，不等下一拍
    window.deck.bridge.on('taskbar/status', (status) => applyStatus(status))
    // 几何重排重渲染并重声明热区（工单58/55）：主进程在 display-metrics-changed 时
    // setBounds 重排条带（换分辨率/换主屏），pill 坐标随客户区宽度变化——旧热区矩形会落空。
    // 工单195 断点②：拖拽会话活动期跳过重建（会中止 OLE 会话），dragend 凭 dragResized 补渲。
    window.addEventListener('resize', () => {
      if (!current) return
      if (dragSource) {
        dragResized = true
        return
      }
      render(current)
      declareHotZones(current)
      notifyGeometry()
    })
  })()
}

boot()
