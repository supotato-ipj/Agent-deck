// 唤出条渲染与交互的渲染层纯逻辑（工单242，spec #236 用户故事 12–22、24、31–33）。
//
// 决策逻辑本体在 shared/retract.ts（工单237 的单一来源：planSummonStrips 出几何、
// reduceSummon 出交互归约）——本模块**不另写一份实现**，只做渲染层的接线与对账：
// - 几何：把「收栏前缓存的各组 pill 矩形」翻译成唤出条的视觉条（3px）与命中区（9px）两个口径；
// - 对账：把「光标此刻落在哪个热区」这一条事实翻译成 reduceSummon 的事件序列
//   （**不采信浏览器 enter/leave 事件序列**——原型在这上面翻过车，静止指针会「弹出→收→弹」振荡）；
// - 热区：收栏态下条命中区与已弹出 pill 的命中区一并声明（沿用既有 declareHotZones 通路，
//   id 编码供对账还原「指针在哪」）；
// - 浮层：自绘浮层家族 → 所属组的钉组映射（浮层在场只钉住所属组，其余组照常收）。
//
// 纯度纪律：零 DOM、零全局时钟（now 一律由调用方注入）、零 IPC——时刻与光标事实都是
// 调用方采好的快照，本模块只裁决（与 shared/retract 同族纪律）。
import { planSummonStrips, reduceSummon, SUMMON_STRIP_HIT_HEIGHT, SUMMON_STRIP_VISUAL_HEIGHT } from '../shared/retract.js'
import type { SummonPillRect, SummonState } from '../shared/retract.js'

/** 栏分组标识（与 shared/retract 的 SummonPillRect.group 同口径：渲染层自定组名） */
export const SUMMON_GROUPS = ['start', 'recs', 'apps', 'right', 'showdesk'] as const
export type SummonGroup = (typeof SUMMON_GROUPS)[number]

/** 热区 id 前缀：条命中区与弹出 pill 命中区分开编码——对账靠它还原「指针此刻在哪」 */
export const STRIP_ZONE_PREFIX = 'summon:strip:'
export const PILL_ZONE_PREFIX = 'summon:pill:'

/** 条命中区的热区 id（收栏态声明用；对账解析用同一编码） */
export function stripZoneId(group: string): string {
  return `${STRIP_ZONE_PREFIX}${group}`
}

/** 已弹出 pill 的热区 id（指针压在 pill 上 → 该组保持弹出） */
export function pillZoneId(group: string): string {
  return `${PILL_ZONE_PREFIX}${group}`
}

/** 唤出命中区的种类 */
export type SummonZoneKind = 'strip' | 'pill'

/** 解析后的唤出命中区 */
export interface SummonZone {
  /** 所属组 */
  group: string
  /** 命中的是条还是已弹出的 pill */
  kind: SummonZoneKind
}

/**
 * 热区 id → 唤出命中区。非唤出热区（常态栏面 pill 矩形等）解析为 null——
 * 「解析不出」即「指针不在任何唤出命中区上」，对账据此清悬停态。
 */
export function parseSummonZone(id: string | null | undefined): SummonZone | null {
  if (!id) return null
  if (id.startsWith(STRIP_ZONE_PREFIX)) return { group: id.slice(STRIP_ZONE_PREFIX.length), kind: 'strip' }
  if (id.startsWith(PILL_ZONE_PREFIX)) return { group: id.slice(PILL_ZONE_PREFIX.length), kind: 'pill' }
  return null
}

/**
 * 自绘浮层家族 → 所属组（钉组映射）。
 *
 * 六面对应主进程 popupHosts 登记的六面自绘浮层（工单162/193/196）：托盘溢出与档位菜单
 * 属右组、应用组右键菜单与多窗选窗列表属应用组、推荐条目菜单属推荐组、空白右键菜单
 * （系统按钮显隐）属开始组。浮层在场时只钉住所属组，其余组照常收（spec 用户故事 21）。
 */
export const OVERLAY_OWNER_GROUP: Readonly<Record<string, SummonGroup>> = {
  'taskbar-tray-overflow': 'right',
  'taskbar-tier-menu': 'right',
  'taskbar-app-menu': 'apps',
  'taskbar-wins-menu': 'apps',
  'taskbar-rec-menu': 'recs',
  'taskbar-blank-menu': 'start',
}

/** 浮层家族 → 所属组；域外家族返回 null（噪声不生事，不钉任何组） */
export function overlayOwnerGroup(family: string): SummonGroup | null {
  return OVERLAY_OWNER_GROUP[family] ?? null
}

/** 一条唤出条的几何（视觉条与命中区两个口径分离） */
export interface SummonStripGeometry {
  /** 所属组 */
  group: string
  /** 左缘（镜像所属 pill 的左缘） */
  x: number
  /** 宽度（镜像所属 pill 的宽度；相叠时已被夹取到互不重叠） */
  width: number
  /** 命中区上缘（= 屏底 − 命中区高） */
  hitTop: number
  /** 命中区高（恒 9px） */
  hitHeight: number
  /** 视觉条上缘（= 屏底 − 视觉条高） */
  visualTop: number
  /** 视觉条高（恒 3px） */
  visualHeight: number
}

/**
 * 唤出条几何：逐组一条，镜像所属 pill 的横向区间与宽度。
 *
 * 输入 = 收栏前缓存的各组 pill 矩形（{group, x, width}）+ 屏幕底边（与 pill 矩形同坐标系；
 * 条带窗通栏且贴屏底，客户区底边即屏底）。输出 = 逐组一条的几何——命中区（9px）与
 * 视觉条（3px）两个口径分开给出，视觉条贴屏底、命中区垫高到好摸。
 *
 * 组间空隙不出条（空隙不在输入矩形集里）；显示桌面细条是最右端独立一条；pill 相叠时
 * 条被夹取到互不重叠（夹取裁决在 planSummonStrips 内，本函数只翻译口径）。
 */
export function planSummonGeometry(
  pills: readonly SummonPillRect[],
  screenBottom: number,
): SummonStripGeometry[] {
  const strips = planSummonStrips({ pills, screenBottom })
  return strips.map((s) => ({
    group: s.group,
    x: s.x,
    width: s.width,
    hitTop: s.top,
    hitHeight: s.height,
    visualTop: screenBottom - SUMMON_STRIP_VISUAL_HEIGHT,
    visualHeight: SUMMON_STRIP_VISUAL_HEIGHT,
  }))
}

/**
 * 指针对账：光标此刻落在哪个热区（唯一事实来源）→ 下一状态。
 *
 * **不采信浏览器 enter/leave 事件序列**（原型教训：静止指针会「弹出→收→弹」振荡）。
 * zoneId 由调用方按光标坐标 hit-test 得出（主进程 HotzoneTracker 25ms 光标轮询那条通路），
 * 本函数据此把悬停态**校正**成事实，再翻译成 reduceSummon 的事件序列。
 *
 * 事件顺序要紧：**进入类先落、离开类后落**。反了就坏——指针从 pill 移到同组的条时，
 * 若先落 pill-leave，此刻 onStrip 仍为 false → 宽限起算 → 400ms 后仍在条上的组被误收。
 */
export function reconcilePointer(state: SummonState, zoneId: string | null, now: number): SummonState {
  const zone = parseSummonZone(zoneId)
  let next = state
  // ① 进入类
  if (zone) {
    const g = next.groups[zone.group]
    if (g) {
      if (zone.kind === 'strip' && !g.onStrip) {
        next = reduceSummon(next, { type: 'strip-enter', group: zone.group, now })
      } else if (zone.kind === 'pill' && !g.onPill) {
        next = reduceSummon(next, { type: 'pill-enter', group: zone.group, now })
      }
    }
  }
  // ② 离开类（进入类已落，故此刻判定的是「指针确实不在那儿」）
  for (const group of Object.keys(next.groups)) {
    if (!next.groups[group].onStrip) continue
    if (zone && zone.kind === 'strip' && zone.group === group) continue
    next = reduceSummon(next, { type: 'strip-leave', group, now })
  }
  for (const group of Object.keys(next.groups)) {
    if (!next.groups[group].onPill) continue
    if (zone && zone.kind === 'pill' && zone.group === group) continue
    next = reduceSummon(next, { type: 'pill-leave', group, now })
  }
  return next
}

/**
 * 逻辑时钟推进拍：到点的悬停弹出、到点的宽限收起（各组互不影响）。
 *
 * 事件载体取已登记的第一个组——tick 事件本身无副作用，reduceSummon 随后按 now 推进
 * 全体组的时钟；用已存在的组名可避免凭空在状态里长出一个空组。
 */
export function tickSummon(state: SummonState, now: number): SummonState {
  const groups = Object.keys(state.groups)
  if (!groups.length) return state
  return reduceSummon(state, { type: 'tick', group: groups[0], now })
}

/** 点击某组的唤出条：立即弹出（不吃 150ms 悬停延迟） */
export function clickStrip(state: SummonState, group: string, now: number): SummonState {
  return reduceSummon(state, { type: 'strip-click', group, now })
}

/**
 * 自绘浮层开合 → 钉组：在场时钉住所属组（该组保持弹出），离场时解除钉住。
 * 域外浮层家族（无归属组）原样返回——噪声不生事。
 */
export function applyOverlayState(
  state: SummonState,
  family: string,
  open: boolean,
  now: number,
): SummonState {
  const group = overlayOwnerGroup(family)
  if (!group) return state
  return reduceSummon(state, { type: open ? 'overlay-open' : 'overlay-close', group, now })
}

/** 一块矩形（相对条带窗客户区左上角，CSS px = DIP） */
export interface SummonRect {
  x: number
  y: number
  w: number
  h: number
}

/** 唤出上滑淡入的时长（ms）：进有方向感（spec 用户故事 22，原型 rise 动画） */
export const SUMMON_RISE_MS = 140
/** 唤出上滑的位移（px）：自下方 8px 处升起 */
export const SUMMON_RISE_DY = 8

/**
 * 哪些组的栏面元素靠 translateY(-50%) 垂直居中——上滑动画带位移；
 * 满高竖条（显示桌面细条）无处可滑，只淡入。
 */
export const SUMMON_SHIFTED_GROUPS: readonly string[] = ['start', 'recs', 'apps', 'right']

/** 唤出动画关键帧（WAAPI 形状；索引签名与 DOM 的 Keyframe 对齐，渲染层可直接 animate） */
export interface SummonKeyframe {
  opacity: number
  transform?: string
  [property: string]: string | number | null | undefined
}

/**
 * 唤出上滑淡入的关键帧。
 *
 * 位移写成 translateY(calc(-50% + 8px)) —— 栏面元素本就靠 translateY(-50%) 垂直居中，
 * 直接写 translateY 会把居中打掉。hasShift=false（满高竖条）时只淡入。
 *
 * 关键帧走 Web Animations API 而非 CSS @keyframes：条带页样式表是**平铺规则集**
 * （工单238 的样式表守卫不容块内嵌套开括号），@keyframes 的嵌套块过不了那道守卫。
 * 收起仍瞬时——元素退场即止，无退场动画。
 */
export function summonRiseKeyframes(hasShift: boolean): SummonKeyframe[] {
  if (!hasShift) return [{ opacity: 0 }, { opacity: 1 }]
  return [
    { opacity: 0, transform: `translateY(calc(-50% + ${SUMMON_RISE_DY}px))` },
    { opacity: 1, transform: 'translateY(-50%)' },
  ]
}

/** 一条热区声明（id 编码供对账还原「指针在哪」） */
export interface SummonHotZone extends SummonRect {
  id: string
}

/**
 * 收栏态的热区声明：唤出条命中区 + 已弹出 pill 的命中区（沿用既有 declareHotZones 通路）。
 *
 * - 已弹出组的唤出条隐藏（条与 pill 同位，露出会闪）→ 该组不出条命中区，改出 pill 命中区；
 * - 弹出 pill 的命中区排在前面（浮起的组在视觉之上，命中优先）；
 * - 零尺寸矩形不出命中区（未渲染的元素不占位）。
 */
export function summonHotZones(
  state: SummonState,
  strips: readonly SummonStripGeometry[],
  pillRects: Readonly<Record<string, SummonRect>>,
): SummonHotZone[] {
  const zones: SummonHotZone[] = []
  for (const [group, g] of Object.entries(state.groups)) {
    if (!g.popped) continue
    const r = pillRects[group]
    if (!r || r.w <= 0 || r.h <= 0) continue
    zones.push({ id: pillZoneId(group), x: r.x, y: r.y, w: r.w, h: r.h })
  }
  for (const s of strips) {
    const g = state.groups[s.group]
    if (g && !g.stripVisible) continue // 已弹出组的条隐藏 → 不出命中区
    zones.push({ id: stripZoneId(s.group), x: s.x, y: s.hitTop, w: s.width, h: s.hitHeight })
  }
  return zones
}
