// 桌面组件摆位（工单310，ADR-0024）：宿主统一网格、占用与落点。
//
// 这一处是摆位逻辑的唯一出处：20px 双轴格点、可用区、尺寸量化、占用冲突、最近空位、
// 默认位表与手势状态机都在这里。插件只决定内容与尺寸，不再自决位置——宿主把位置与
// 量化尺寸写进内联样式并独占所有权；插件把自己的自算位发布到 data-placement-auto-*
// （见 doc-group-cards 的 layoutRow），宿主只把它当默认位来源。重排由 1Hz 快照、
// 插件 onDomChanged、展开/收起与 resize 显式驱动，不用 MutationObserver 盯 style/class
// （宿主写样式会反过来触发观察者，形成同步空转——真机首轮实证渲染层被钉死）。
//
// 领域词汇见 GLOSSARY.md：摆位 / 摆位模式 / 点阵网格 / 格点 / 默认位 / 手定位。
// 取舍见 docs/adr/0024-host-placement-grid.md。
import type { BridgeMethod, BridgeMethods, CardSlot } from '../shared/contract'

// ---- 网格常量（唯一出处） ----
export const GRID_PX = 20
/** 可用区四周留白（面板全屏减四周 40px） */
export const AREA_MARGIN_PX = 40
/** 底边任务栏带（可用区排除底边 64px；任务栏收栏时仍保留同高，版面不漂移） */
export const TASKBAR_BAND_PX = 64
/** 长按成立时长 */
export const LONG_PRESS_MS = 400
/** 长按前位移取消阈值（手抖不误判） */
export const PRESS_CANCEL_PX = 6
/** 吸附/回弹动画时长 */
export const SETTLE_MS = 180

/** 桌面组件尺寸（工单310 的量化表；均为 20px 整数倍——plugin 卡取整后同表） */
export const CARD_SIZES: Record<string, { w: number; h: number }> = {
  'clock-card': { w: 320, h: 180 },
  'weather-card': { w: 320, h: 180 },
  'calendar-card': { w: 320, h: 300 },
  'sessions-card': { w: 420, h: 520 },
  'search-card': { w: 420, h: 100 },
}

/** 组卡两态尺寸（与 plugins/doc-group-cards/geometry.js 同值） */
export const GROUP_COLLAPSED = { w: 320, h: 240 }
export const GROUP_EXPANDED = { w: 640, h: 980 }

/** 默认位锚点（出厂版面按格点量化后的结果；文档区原点来自 config，其余为代码表） */
export interface DefaultAnchor {
  /** 绝对 DIP 横向锚点（left）；缺省与 right 二选一 */
  left?: number
  /** 右列：贴可用区右缘 */
  right?: boolean
  /** 绝对 DIP 纵向锚点（top） */
  top: number
}

export const DEFAULT_ANCHORS: Record<string, DefaultAnchor> = {
  'clock-card': { left: AREA_MARGIN_PX, top: 40 },
  'weather-card': { left: AREA_MARGIN_PX, top: 240 },
  'calendar-card': { left: AREA_MARGIN_PX, top: 440 },
  'search-card': { right: true, top: 40 },
  'sessions-card': { right: true, top: 160 },
  'doc-zone': { left: 400, top: 40 },
}

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** 可用区：面板全屏减四周留白与底边任务栏带 */
export function usableAreaOf(viewportW: number, viewportH: number): Box {
  return {
    x: AREA_MARGIN_PX,
    y: AREA_MARGIN_PX,
    w: Math.max(0, viewportW - 2 * AREA_MARGIN_PX),
    h: Math.max(0, viewportH - 2 * AREA_MARGIN_PX - TASKBAR_BAND_PX),
  }
}

/** 尺寸向上取整到 20px 整数倍（插件卡：取插件渲染值） */
export function quantizeSize(w: number, h: number): { w: number; h: number } {
  const ceil = (v: number) => Math.max(GRID_PX, Math.ceil(Math.max(0, v) / GRID_PX) * GRID_PX)
  return { w: ceil(w), h: ceil(h) }
}

/** 格点 → 像素盒（可用区原点 + 20px 步长） */
export function boxOfSlot(slot: CardSlot, size: { w: number; h: number }, area: Box): Box {
  return { x: area.x + slot.col * GRID_PX, y: area.y + slot.row * GRID_PX, w: size.w, h: size.h }
}

/** 格点夹取进可用区（分辨率缩小后手定位保留、裁回可用范围） */
export function clampSlot(slot: CardSlot, size: { w: number; h: number }, area: Box): CardSlot {
  const maxCol = Math.max(0, Math.floor((area.w - size.w) / GRID_PX))
  const maxRow = Math.max(0, Math.floor((area.h - size.h) / GRID_PX))
  return {
    col: Math.min(Math.max(0, Math.trunc(slot.col)), maxCol),
    row: Math.min(Math.max(0, Math.trunc(slot.row)), maxRow),
  }
}

/** 像素落点 → 最近的合法格点（四舍五入后夹取） */
export function snapSlotFromPoint(px: number, py: number, size: { w: number; h: number }, area: Box): CardSlot {
  return clampSlot({ col: Math.round((px - area.x) / GRID_PX), row: Math.round((py - area.y) / GRID_PX) }, size, area)
}

/** 两个矩形是否相交（边贴边不算） */
export function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/** 默认位：id 有锚点用锚点；否则 null（由调用方走「最近的空位」） */
export function defaultSlotFor(id: string, size: { w: number; h: number }, area: Box, docZone?: { left: number; top: number }): CardSlot | null {
  const anchor = DEFAULT_ANCHORS[id]
  if (id === 'doc-zone') {
    const left = docZone ? docZone.left : anchor?.left ?? area.x
    const top = docZone ? docZone.top : anchor?.top ?? area.y
    return snapSlotFromPoint(left, top, size, area)
  }
  if (!anchor) return null
  const x = anchor.right ? area.x + area.w - size.w : anchor.left ?? area.x
  return snapSlotFromPoint(x, anchor.top, size, area)
}

/** 最近的空位：preferred 本身可用即用；否则全格点按到 preferred 中心的距离取最近空闲位。
 * 这是「新卡/新组卡从屏幕中心向外找最近空位」与「撞车后挪最近空位」共用的一道裁决。 */
export function nearestFreeSlot(
  preferred: CardSlot,
  size: { w: number; h: number },
  occupied: readonly Box[],
  area: Box,
): CardSlot | null {
  const start = clampSlot(preferred, size, area)
  const fits = (slot: CardSlot) => !occupied.some((box) => intersects(boxOfSlot(slot, size, area), box))
  if (fits(start)) return start
  if (size.w > area.w || size.h > area.h) return null
  const maxCol = Math.max(0, Math.floor((area.w - size.w) / GRID_PX))
  const maxRow = Math.max(0, Math.floor((area.h - size.h) / GRID_PX))
  const px = area.x + start.col * GRID_PX
  const py = area.y + start.row * GRID_PX
  let best: CardSlot | null = null
  let bestD = Infinity
  for (let col = 0; col <= maxCol; col++) {
    for (let row = 0; row <= maxRow; row++) {
      const d = (area.x + col * GRID_PX - px) ** 2 + (area.y + row * GRID_PX - py) ** 2
      if (d >= bestD) continue
      if (!fits({ col, row })) continue
      best = { col, row }
      bestD = d
    }
  }
  return best
}

/** 屏幕中心（可用区中心）附近的首个空位：新插件卡/新组卡的默认落点 */
export function centerFreeSlot(size: { w: number; h: number }, occupied: readonly Box[], area: Box): CardSlot | null {
  const center = {
    col: Math.max(0, Math.floor((area.w / 2 - size.w / 2) / GRID_PX)),
    row: Math.max(0, Math.floor((area.h / 2 - size.h / 2) / GRID_PX)),
  }
  return nearestFreeSlot(center, size, occupied, area)
}

// ---- 宿主装配 ----

export interface PlacementDeps {
  notify(type: string, payload?: Record<string, unknown>): void
  invoke<M extends BridgeMethod>(method: M, payload: BridgeMethods[M]['request']): Promise<BridgeMethods[M]['response']>
  /** 热区重申报（每次落位、尺寸变化、展开/收起后立即调用） */
  declareHotZones(): void
  /** 无空位拒绝的可见提示 */
  notice(message: string): void
}

export interface PlacementSyncInput {
  /** 手定位格点表（快照 desktop.cards；只含用户拖过的卡） */
  cards: Record<string, CardSlot>
  /** config 下发的文档区原点（默认位量化来源） */
  docZone: { left: number; top: number; maxWidth: number }
}

interface CardState {
  id: string
  el: HTMLElement
  group: boolean
  /** 当前视觉尺寸（宿主量取/表定） */
  size: { w: number; h: number }
  /** 组卡/搜索卡的基准尺寸（非临时形态） */
  baseSize: { w: number; h: number }
  /** 最终格点 */
  slot: CardSlot
  /** 基准格点（组卡折叠位；展开态由它推导） */
  baseSlot: CardSlot
  hand: boolean
  frozen: boolean
  expanded: boolean
  searchActive: boolean
  rejected: boolean
  rect: Box
  /** 最近一次宿主写入的 left/top（判定插件是否又写了新的自算位置） */
  applied: { left: number; top: number } | null
  appliedSize: { w: number; h: number } | null
}

interface PressState {
  id: string
  el: HTMLElement
  pointerId: number
  startX: number
  startY: number
  timer: ReturnType<typeof setTimeout> | null
  mode: 'press' | 'drag'
  originalRect: Box
  originalSlot: CardSlot
  originalBase: CardSlot
  expanded: boolean
  candidate: CardSlot | null
  lastX: number
  lastY: number
  moved: boolean
}

const EXEMPT_IDS = new Set(['settings-card', 'settings-btn', 'trash-confirm', 'trash-notice', 'ctx-menu', 'marquee-rect', 'drag-ghost'])

export interface PlacementHost {
  /** 快照到达/插件 DOM 变化后对齐位置（幂等） */
  sync(input: PlacementSyncInput): void
  /** 手势进行中（热区保持全窗） */
  dragging(): boolean
  /** 摆位模式中（热区 id） */
  activeHotzoneId(): string | null
  /** 长按计时中且按在文档区上（body 级框选让位：长按拖文档区不触发框选） */
  armedOnDocZone(): boolean
  /** 恢复出厂：清掉冻结的组卡默认位 */
  resetFrozen(): void
  /** 落位后重算（插件展开/收起、搜索态切换由 MutationObserver 自动触发） */
  refresh(): void
}

/** 建立宿主摆位。DOM 元素（网格/预览）随第一次 sync 惰性创建。 */
export function createPlacement(deps: PlacementDeps): PlacementHost {
  let handCards: Record<string, CardSlot> = {}
  let pendingCards: Record<string, CardSlot> = {}
  let docZoneCfg = { left: 400, top: 40, maxWidth: 640 }
  let area = usableAreaOf(window.innerWidth, window.innerHeight)
  let states = new Map<string, CardState>()
  let groupBase = new Map<string, CardSlot>()
  let frozenSlots = new Map<string, CardSlot>()
  let frozen = false
  let press: PressState | null = null
  let suppressNextClick = false
  let grid: HTMLElement | null = null
  let preview: HTMLElement | null = null
  let syncing = false
  let scheduled = false
  let lastRenderedKey = ''
  let disposed = false
  let generatedSeq = 0
  let lastDraggedId: string | null = null
  const rejectedNotice = new Set<string>()

  const viewport = () => ({ w: window.innerWidth, h: window.innerHeight })
  const isGroupCard = (el: HTMLElement) => el.classList.contains('dgc-card')
  const isExpanded = (el: HTMLElement) => el.classList.contains('dgc-expanded')
  const isSearchActive = (el: HTMLElement) => el.dataset.placementSearch === 'active'

  function ensureOverlays(): void {
    if (grid) return
    grid = document.createElement('div')
    grid.id = 'placement-grid'
    grid.setAttribute('aria-hidden', 'true')
    document.body.appendChild(grid)
    preview = document.createElement('div')
    preview.id = 'placement-preview'
    preview.setAttribute('aria-hidden', 'true')
    document.body.appendChild(preview)
  }

  function updateOverlays(): void {
    ensureOverlays()
    if (grid) {
      const set = (prop: 'left' | 'top' | 'width' | 'height', value: number) => {
        const cur = parseFloat(grid!.style[prop])
        if (!Number.isFinite(cur) || Math.abs(cur - value) > 0.5) grid!.style[prop] = `${value}px`
      }
      set('left', area.x)
      set('top', area.y)
      set('width', area.w)
      set('height', area.h)
    }
  }

  function setGrid(on: boolean): void {
    ensureOverlays()
    grid?.classList.toggle('on', on)
    if (!on && preview) {
      preview.classList.remove('ok', 'bad')
      preview.style.display = 'none'
    }
  }

  function showPreview(slot: CardSlot, size: { w: number; h: number }, conflict: boolean, baseSlot: CardSlot): void {
    if (!preview) return
    const box = boxOfSlot(slot, size, area)
    // 展开卡拖拽：预览落在基准格点（折叠尺寸）上，用户看到的是「这张卡会落到哪一格」
    const raw = press && press.expanded ? boxOfSlot(baseSlot, { w: GROUP_COLLAPSED.w, h: GROUP_COLLAPSED.h }, area) : box
    preview.style.display = 'block'
    preview.style.left = `${raw.x}px`
    preview.style.top = `${raw.y}px`
    preview.style.width = `${raw.w}px`
    preview.style.height = `${raw.h}px`
    preview.classList.toggle('ok', !conflict)
    preview.classList.toggle('bad', conflict)
  }

  function discover(): { id: string; el: HTMLElement; group: boolean }[] {
    const out: { id: string; el: HTMLElement; group: boolean }[] = []
    const nodes = [...document.querySelectorAll<HTMLElement>('.card')]
    const doc = document.getElementById('doc-zone')
    if (doc) nodes.push(doc)
    for (const el of nodes) {
      if (EXEMPT_IDS.has(el.id)) continue
      if (el.dataset.placementExempt !== undefined) continue
      if (el.id === 'settings-card' || el.id === 'trash-confirm') continue
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) continue // 隐藏浮层/收起卡不登记、不占位
      let id = el.dataset.cardId ?? ''
      if (!id && el.id) id = el.id
      if (!id) {
        id = el.dataset.placementId ?? ''
        if (!id) {
          id = `placement-card-${++generatedSeq}`
          el.dataset.placementId = id
          deps.notify('placement-unstable-id', { id, marker: 'generated' })
        }
      }
      out.push({ id, el, group: isGroupCard(el) })
    }
    return out
  }

  /** 插件卡自然尺寸：读取内联宽高（插件自定），否则量 DOM；量化向上取整。
   * 宿主自己写过的宽高不当自然尺寸（避免把量化结果再量化）。 */
  function naturalSize(el: HTMLElement, prev: CardState | undefined): { w: number; h: number } {
    const inlineW = parseFloat(el.style.width)
    const inlineH = parseFloat(el.style.height)
    const hostW = prev?.appliedSize?.w
    const hostH = prev?.appliedSize?.h
    let w = Number.isFinite(inlineW) ? inlineW : el.getBoundingClientRect().width
    let h = Number.isFinite(inlineH) ? inlineH : el.getBoundingClientRect().height
    // 内联值恰是宿主上次写入的量化尺寸：回退到上次记录的自然尺寸（不重复取整）
    if (Number.isFinite(inlineW) && hostW !== undefined && Math.abs(inlineW - hostW) < 0.5 && prev) {
      w = prev.baseSize.w
    }
    if (Number.isFinite(inlineH) && hostH !== undefined && Math.abs(inlineH - hostH) < 0.5 && prev) {
      h = prev.baseSize.h
    }
    return quantizeSize(w, h)
  }

  function sizeOf(id: string, el: HTMLElement, group: boolean, prev: CardState | undefined): { size: { w: number; h: number }; baseSize: { w: number; h: number }; expanded: boolean; searchActive: boolean } {
    const searchActive = id === 'search-card' && isSearchActive(el)
    if (group) {
      const expanded = isExpanded(el)
      return {
        size: expanded ? { ...GROUP_EXPANDED } : { ...GROUP_COLLAPSED },
        baseSize: { ...GROUP_COLLAPSED },
        expanded,
        searchActive: false,
      }
    }
    const fixed = CARD_SIZES[id]
    if (fixed) {
      if (id === 'search-card' && searchActive) {
        // 活动态高度由内容定：清掉宿主写的 idle 高（一次性），之后高度交给 CSS auto；
        // 量当前矩形作为占位/方向计算依据，不把量出的高写回内联（否则内容变化被钉死）
        if (el.style.height) el.style.height = ''
        const h = Math.max(100, Math.ceil(el.getBoundingClientRect().height / GRID_PX) * GRID_PX)
        return { size: { w: fixed.w, h }, baseSize: { w: fixed.w, h: fixed.h }, expanded: false, searchActive: true }
      }
      return { size: { ...fixed }, baseSize: { ...fixed }, expanded: false, searchActive: false }
    }
    const natural = naturalSize(el, prev)
    return { size: natural, baseSize: natural, expanded: false, searchActive: false }
  }

  function pluginAutoSlot(el: HTMLElement, prev: CardState | undefined, size: { w: number; h: number }): CardSlot | null {
    // 插件卡默认登记契约（ADR-0024）：宿主在树时，插件把自己的自算位写进 data-placement-auto-*，
    // 不写内联 left/top（宿主独占位置与尺寸，插件重绘不闪位）。旧插件仍按内联值回读。
    const autoLeft = parseFloat(el.dataset.placementAutoLeft ?? '')
    const autoTop = parseFloat(el.dataset.placementAutoTop ?? '')
    const left = Number.isFinite(autoLeft) ? autoLeft : parseFloat(el.style.left)
    const top = Number.isFinite(autoTop) ? autoTop : parseFloat(el.style.top)
    if (!Number.isFinite(left) || !Number.isFinite(top)) return null
    // 宿主上次写入的值不算插件新算法：不更新基准
    if (prev?.applied && Math.abs(left - prev.applied.left) < 0.5 && Math.abs(top - prev.applied.top) < 0.5) return null
    return snapSlotFromPoint(left, top, size, area)
  }

  function apply(el: HTMLElement, box: Box, size: { w: number; h: number } | null, st: CardState): void {
    if (el.dataset.placementId !== st.id) el.dataset.placementId = st.id
    if (el.style.right !== 'auto') el.style.right = 'auto'
    if (el.style.bottom !== 'auto') el.style.bottom = 'auto'
    const curL = parseFloat(el.style.left)
    if (!Number.isFinite(curL) || Math.abs(curL - box.x) > 0.5) el.style.left = `${box.x}px`
    const curT = parseFloat(el.style.top)
    if (!Number.isFinite(curT) || Math.abs(curT - box.y) > 0.5) el.style.top = `${box.y}px`
    if (size) {
      const curW = parseFloat(el.style.width)
      const curH = parseFloat(el.style.height)
      if (!Number.isFinite(curW) || Math.abs(curW - size.w) > 0.5) el.style.width = `${size.w}px`
      if (!Number.isFinite(curH) || Math.abs(curH - size.h) > 0.5) el.style.height = `${size.h}px`
      st.appliedSize = { w: size.w, h: size.h }
    }
    st.applied = { left: box.x, top: box.y }
  }

  function occupiedBoxes(list: readonly CardState[], excludeId?: string): Box[] {
    const out: Box[] = []
    for (const st of list) {
      if (st.id === excludeId || st.rejected) continue
      // 占用按基准形态：搜索活动态盖别人不算占位，组卡展开是临时模态
      out.push(boxOfSlot(st.baseSlot, st.baseSize, area))
    }
    return out
  }

  function sync(input: PlacementSyncInput): void {
    if (syncing || disposed) return
    // 手势进行中不重排：拖拽本身就是位置来源，同步会把卡片拽回基准格点/污染组卡基准
    if (press) return
    syncing = true
    try {
      // 乐观手定位（尚未落盘回执）与本拍快照合并：写盘在途时卡片不回跳
      handCards = { ...input.cards, ...pendingCards }
      docZoneCfg = input.docZone
      area = usableAreaOf(window.innerWidth, window.innerHeight)
      updateOverlays()
      const discovered = discover()
      const prev = states
      const next = new Map<string, CardState>()

      // 第一遍：身份、尺寸、基准格点
      for (const d of discovered) {
        const before = prev.get(d.id)
        const info = sizeOf(d.id, d.el, d.group, before)
        let baseSlot: CardSlot
        const hand = handCards[d.id]
        if (hand) {
          baseSlot = clampSlot(hand, info.baseSize, area)
        } else if (d.group) {
          if (frozen) {
            const fixed = frozenSlots.get(d.id)
            if (fixed) baseSlot = clampSlot(fixed, info.baseSize, area)
            else {
              // 冻结后新增的组卡：落最近的空位。既有卡（上一拍的全表）全部计入占用——
              // 新卡不得盖住任何已摆好的卡，也不许把旧卡挤走。
              const existing: Box[] = [...prev.values()].filter((s) => !s.rejected).map((s) => boxOfSlot(s.baseSlot, s.baseSize, area))
              const seen: Box[] = [...existing, ...occupiedBoxes([...next.values()], d.id)]
              baseSlot = centerFreeSlot(info.baseSize, seen, area) ?? { col: 0, row: 0 }
              frozenSlots.set(d.id, baseSlot)
            }
          } else {
            // 未冻结：维持插件按视口自动居中的位置（按格点量化）；插件重绘后的新位置照跟。
            // 展开态的视觉位置是宿主推出来的，不是插件算法——不得回读成基准位。
            const auto = info.expanded ? null : pluginAutoSlot(d.el, before, info.baseSize)
            const remembered = groupBase.get(d.id)
            baseSlot = auto ?? remembered ?? centerFreeSlot(info.baseSize, occupiedBoxes([...next.values()], d.id), area) ?? { col: 0, row: 0 }
            groupBase.set(d.id, baseSlot)
          }
        } else {
          baseSlot = defaultSlotFor(d.id, info.baseSize, area, docZoneCfg) ?? centerFreeSlot(info.baseSize, occupiedBoxes([...next.values()], d.id), area) ?? { col: 0, row: 0 }
        }
        next.set(d.id, {
          id: d.id,
          el: d.el,
          group: d.group,
          size: info.size,
          baseSize: info.baseSize,
          slot: baseSlot,
          baseSlot,
          hand: !!hand,
          frozen: frozenSlots.has(d.id),
          expanded: info.expanded,
          searchActive: info.searchActive,
          rejected: false,
          rect: boxOfSlot(baseSlot, info.baseSize, area),
          applied: before?.applied ?? null,
          appliedSize: before?.appliedSize ?? null,
        })
      }

      // 第二遍：占用裁决（手定位优先占用；默认位撞车挪最近空位；无空位拒绝）
      const all = [...next.values()]
      const reserved = new Set<string>()
      const occupied: Box[] = []
      // 手定位先占：用户摆过的卡位置最优先，不被默认位挤走
      for (const st of all) {
        if (!st.hand) continue
        let slot = st.baseSlot
        let box = boxOfSlot(slot, st.baseSize, area)
        if (occupied.some((o) => intersects(o, box))) {
          const free = nearestFreeSlot(slot, st.baseSize, occupied, area)
          if (!free) { st.rejected = true; continue }
          slot = free
          st.baseSlot = slot
          st.slot = slot
          st.rect = boxOfSlot(slot, st.baseSize, area)
          box = st.rect
          deps.notify('placement-clamped', { id: st.id, reason: 'collision' })
        }
        occupied.push(box)
        reserved.add(st.id)
      }
      // 冻结的组卡次之（默认位但已冻结），再其余默认位
      for (const pass of [true, false]) {
        for (const st of all) {
          if (reserved.has(st.id) || st.hand) continue
          if (st.group !== pass) continue
          const preferred = st.baseSlot
          const free = nearestFreeSlot(preferred, st.baseSize, occupied, area)
          if (!free) {
            st.rejected = true
            if (!rejectedNotice.has(st.id)) {
              rejectedNotice.add(st.id)
              deps.notify('placement-rejected', { id: st.id, reason: 'no-space', w: st.baseSize.w, h: st.baseSize.h })
              deps.notice('桌面放不下这张卡：没有可用格点，已拒绝摆放')
            }
            continue
          }
          if (free.col !== preferred.col || free.row !== preferred.row) {
            st.baseSlot = free
            deps.notify('placement-clamped', { id: st.id, reason: 'no-space' })
          }
          st.slot = st.baseSlot
          st.rect = boxOfSlot(st.baseSlot, st.baseSize, area)
          if (st.group && frozen) frozenSlots.set(st.id, st.baseSlot)
          if (st.group && !frozen) groupBase.set(st.id, st.baseSlot)
          occupied.push(st.rect)
          reserved.add(st.id)
        }
      }

      // 第三遍：写位置（搜索活动态方向、组卡展开临时模态在此推导）
      for (const st of all) {
        if (st.rejected) {
          st.el.classList.add('placement-rejected')
          if (st.el.style.display !== 'none') st.el.style.display = 'none'
          continue
        }
        st.el.classList.remove('placement-rejected')
        if (st.el.style.display !== '') st.el.style.display = ''
        let box = boxOfSlot(st.baseSlot, st.baseSize, area)
        if (st.expanded) {
          // 展开是临时模态：不写手定位，保中心放大、越界夹取
          const centered = {
            x: box.x + (GROUP_COLLAPSED.w - GROUP_EXPANDED.w) / 2,
            y: box.y + (GROUP_COLLAPSED.h - GROUP_EXPANDED.h) / 2,
          }
          const clampedX = Math.min(Math.max(area.x, centered.x), area.x + Math.max(0, area.w - GROUP_EXPANDED.w))
          const clampedY = Math.min(Math.max(area.y, centered.y), area.y + Math.max(0, area.h - GROUP_EXPANDED.h))
          box = { x: clampedX, y: clampedY, w: GROUP_EXPANDED.w, h: GROUP_EXPANDED.h }
          st.size = { ...GROUP_EXPANDED }
          st.rect = box
          st.slot = st.baseSlot
          apply(st.el, box, st.size, st)
          if (!prev.get(st.id)?.expanded) {
            deps.notify('placement-expanded', {
              id: st.id, clamped: clampedX !== centered.x || clampedY !== centered.y,
              rect: { x: box.x, y: box.y, w: box.w, h: box.h },
            })
          }
          continue
        }
        if (st.searchActive) {
          // 活动态：优先向下展开；下方空间不足向上展开，始终留在可用区内
          const h = st.size.h
          let top = box.y
          let direction: 'down' | 'up' = 'down'
          if (top + h > area.y + area.h) {
            top = Math.max(area.y, box.y + CARD_SIZES['search-card'].h - h)
            direction = 'up'
          }
          st.rect = { x: box.x, y: top, w: box.w, h }
          // 活动态高度交给 CSS auto：不写内联高（否则结果区增删被钉死）
          apply(st.el, st.rect, null, st)
          const wasSearch = prev.get(st.id)
          if (!wasSearch?.searchActive || wasSearch.size.h !== h) {
            deps.notify('placement-search-expanded', { id: st.id, direction, rect: { ...st.rect } })
          }
          continue
        }
        st.rect = box
        // 文档区尺寸随内容：宿主不写宽高（只写位置）
        apply(st.el, box, st.id === 'doc-zone' ? null : st.size, st)
        if (st.group && prev.get(st.id)?.expanded) {
          deps.notify('placement-collapsed', { id: st.id, rect: { x: box.x, y: box.y, w: box.w, h: box.h } })
        }
      }

      states = next
      // 清理：已消失的卡不删手定位（存储长期保留）；冻结表也不删（卡回来了回原位）
      for (const id of [...groupBase.keys()]) if (!next.has(id) && !frozenSlots.has(id)) groupBase.delete(id)
      emitRendered()
    } finally {
      syncing = false
    }
  }

  /** 第一遍里为「冻结后新增的组卡」估算占用：只取已算出的同批卡，避免数组未就绪的空窗 */
  function emitRendered(): void {
    const list = [...states.values()].map((st) => ({
      id: st.id,
      slot: { ...st.slot },
      base: { ...st.baseSlot },
      rect: { ...st.rect },
      hand: st.hand,
      frozen: st.frozen,
      group: st.group,
      expanded: st.expanded,
      search: st.searchActive,
      rejected: st.rejected,
    }))
    const key = JSON.stringify(list)
    if (key === lastRenderedKey) return
    lastRenderedKey = key
    deps.notify('placement-rendered', {
      area: { ...area }, grid: GRID_PX, count: list.length,
      cards: list,
    })
    // 位置/尺寸真变了才重申报热区（1Hz 快照不产生空转申报；手势与插件 DOM 变更另走显式调用）
    deps.declareHotZones()
  }

  function schedule(): void {
    if (scheduled || syncing || disposed) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      if (disposed) return
      sync({ cards: currentHandSnapshot(), docZone: docZoneCfg })
    })
  }

  function currentHandSnapshot(): Record<string, CardSlot> {
    return { ...handCards, ...pendingCards }
  }

  // ---- 手势 ----

  function entryOf(target: EventTarget | null): CardState | null {
    if (!(target instanceof Element)) return null
    const card = target.closest<HTMLElement>('.card, #doc-zone')
    if (!card) return null
    for (const st of states.values()) if (st.el === card) return st
    return null
  }

  function targetBlocked(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return true
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return true
    if (target.closest('.ditem')) return true // 桌面项：长按不拖文档区
    if (target.closest('[data-placement-exempt]')) return true
    return false
  }

  function anyExpandedExcept(id: string): boolean {
    for (const st of states.values()) if (st.group && st.expanded && st.id !== id) return true
    return false
  }

  function currentCandidate(e: PointerEvent): { slot: CardSlot; conflict: boolean; baseSlot: CardSlot } | null {
    if (!press) return null
    const st = states.get(press.id)
    if (!st) return null
    const dx = e.clientX - press.startX
    const dy = e.clientY - press.startY
    const size = st.baseSize
    // 展开卡拖的是**折叠基准位**：以基准格点的矩形为起点算位移，不拿视觉上的展开矩形
    const baseRect = boxOfSlot(press.originalBase, size, area)
    const rawX = baseRect.x + dx
    const rawY = baseRect.y + dy
    const slot = snapSlotFromPoint(rawX, rawY, size, area)
    const conflict = occupiedBoxes([...states.values()], st.id).some((box) => intersects(boxOfSlot(slot, size, area), box))
    return { slot, conflict, baseSlot: slot }
  }

  function beginDrag(st: CardState, e: PointerEvent): void {
    if (!press) return
    press.mode = 'drag'
    press.originalRect = { ...st.rect }
    press.originalSlot = { ...st.slot }
    press.originalBase = { ...st.baseSlot }
    press.expanded = st.expanded
    st.el.classList.add('placement-lifted')
    setGrid(true)
    deps.declareHotZones()
    const cand = currentCandidate(e)
    if (cand) {
      press.candidate = cand.slot
      showPreview(cand.slot, st.baseSize, cand.conflict, cand.baseSlot)
    }
    deps.notify('placement-mode-entered', { id: st.id, slot: { ...st.slot } })
  }

  function moveDrag(e: PointerEvent): void {
    if (!press) return
    const st = states.get(press.id)
    if (!st) return
    const dx = e.clientX - press.startX
    const dy = e.clientY - press.startY
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) press.moved = true
    const cand = currentCandidate(e)
    if (cand) {
      const changed = !press.candidate || press.candidate.col !== cand.slot.col || press.candidate.row !== cand.slot.row
      press.candidate = cand.slot
      showPreview(cand.slot, st.baseSize, cand.conflict, cand.baseSlot)
      if (changed) deps.notify('placement-dragged', { id: st.id, slot: { ...cand.slot }, conflict: cand.conflict })
      // 跟手：卡片随指针走（非格点），预览与松手落点按格点
      st.el.style.left = `${press.originalRect.x + dx}px`
      st.el.style.top = `${press.originalRect.y + dy}px`
    }
  }

  /** 视觉落位盒：组卡展开态按基准格点推「保中心 + 夹取」后的矩形；其余按格点尺寸 */
  function visualBoxOf(st: CardState, slot: CardSlot): Box {
    if (!st.expanded) return boxOfSlot(slot, st.baseSize, area)
    const base = boxOfSlot(slot, st.baseSize, area)
    const centered = {
      x: base.x + (GROUP_COLLAPSED.w - GROUP_EXPANDED.w) / 2,
      y: base.y + (GROUP_COLLAPSED.h - GROUP_EXPANDED.h) / 2,
    }
    return {
      x: Math.min(Math.max(area.x, centered.x), area.x + Math.max(0, area.w - GROUP_EXPANDED.w)),
      y: Math.min(Math.max(area.y, centered.y), area.y + Math.max(0, area.h - GROUP_EXPANDED.h)),
      w: GROUP_EXPANDED.w,
      h: GROUP_EXPANDED.h,
    }
  }

  function settle(success: boolean, reason: 'placed' | 'rebound' | 'cancel' | 'zero'): void {
    if (!press) return
    const p = press
    const st = states.get(p.id)
    press = null
    lastDraggedId = p.id
    if (p.timer !== null) clearTimeout(p.timer)
    setGrid(false)
    if (st) st.el.classList.remove('placement-lifted')
    deps.declareHotZones()
    // 尾随 click 在 pointerup 之后、下一任务之前到达；此拍末清吞没态，不误伤后续点击
    setTimeout(() => { suppressNextClick = false }, 0)
    if (!st) return
    if (reason !== 'cancel') {
      const box = reason === 'placed' && p.candidate ? visualBoxOf(st, p.candidate) : p.originalRect
      st.el.style.transition = `left ${SETTLE_MS}ms ease, top ${SETTLE_MS}ms ease`
      st.el.classList.add('placement-settling')
      st.el.style.left = `${box.x}px`
      st.el.style.top = `${box.y}px`
      setTimeout(() => {
        st.el.style.transition = ''
        st.el.classList.remove('placement-settling')
        // 落位动画结束后按最终格点重排一次（组卡展开态下的基准位同步）
        schedule()
        // 热区必须在动画落定后按**最终矩形**重申报：动画期间 getBoundingClientRect 还是中间值，
        // 若只在起手时申报，松手后的卡片热区会停在拖动落点（真机实证：回弹后再也按不住卡）
        deps.declareHotZones()
      }, SETTLE_MS)
    } else {
      // 取消：直接回原位，不做吸附动画（误操作可撤销，不拖泥带水）
      st.el.style.left = `${p.originalRect.x}px`
      st.el.style.top = `${p.originalRect.y}px`
      schedule()
    }
  }

  function place(st: CardState, slot: CardSlot): void {
    // 先本地乐观更新（快照到达前不回跳），再落盘；失败回滚
    pendingCards[st.id] = { ...slot }
    st.hand = true
    st.baseSlot = slot
    st.slot = slot
    if (!frozen) {
      frozen = true
      for (const s of states.values()) {
        if (!s.group) continue
        frozenSlots.set(s.id, { ...s.baseSlot })
      }
      deps.notify('placement-frozen', { ids: [...frozenSlots.keys()] })
    }
    deps.notify('placement-placed', {
      id: st.id, col: slot.col, row: slot.row,
      rect: boxOfSlot(slot, st.baseSize, area),
      hand: true,
    })
    void deps.invoke('desktop/set-card-slot', { id: st.id, col: slot.col, row: slot.row }).then(
      (r) => {
        if (r.ok) {
          delete pendingCards[st.id]
          handCards = { ...r.cards }
        } else {
          delete pendingCards[st.id]
          deps.notify('placement-persist-failed', { id: st.id, error: r.error ?? null })
          deps.notice(r.error ?? '摆位落盘失败')
        }
        schedule()
      },
      (err: unknown) => {
        delete pendingCards[st.id]
        deps.notify('placement-persist-failed', { id: st.id, error: String(err) })
        deps.notice(`摆位落盘失败：${String(err)}`)
        schedule()
      },
    )
  }

  function onPointerDown(e: PointerEvent): void {
    if (e.button !== 0 || press) return
    if (targetBlocked(e.target)) return
    const st = entryOf(e.target)
    if (!st || st.rejected) return
    if (st.searchActive) return // 搜索活动态不长按
    if (anyExpandedExcept(st.id)) return // 展开模态期间邻卡不响应摆位
    const p: PressState = {
      id: st.id, el: st.el, pointerId: e.pointerId,
      startX: e.clientX, startY: e.clientY,
      timer: null, mode: 'press',
      originalRect: { ...st.rect }, originalSlot: { ...st.slot }, originalBase: { ...st.baseSlot },
      expanded: st.expanded, candidate: null, lastX: e.clientX, lastY: e.clientY, moved: false,
    }
    press = p
    p.timer = setTimeout(() => {
      if (!press || press !== p) return
      suppressNextClick = true
      beginDrag(st, e)
    }, LONG_PRESS_MS)
  }

  function onPointerMove(e: PointerEvent): void {
    if (!press || e.pointerId !== press.pointerId) return
    if (press.mode === 'press') {
      const dist = Math.hypot(e.clientX - press.startX, e.clientY - press.startY)
      if (dist > PRESS_CANCEL_PX) {
        if (press.timer !== null) clearTimeout(press.timer)
        press = null
        setGrid(false)
      }
      return
    }
    press.lastX = e.clientX
    press.lastY = e.clientY
    moveDrag(e)
  }

  function onPointerUp(e: PointerEvent): void {
    if (!press || e.pointerId !== press.pointerId) return
    deps.notify('placement-pointerup', { id: press.id, mode: press.mode, candidate: press.candidate })
    if (press.mode === 'press') {
      if (press.timer !== null) clearTimeout(press.timer)
      press = null
      return
    }
    const st = states.get(press.id)
    const p = press
    const cand = p.candidate
    if (!st || !cand) { settle(false, 'cancel'); return }
    const conflict = occupiedBoxes([...states.values()], st.id).some((box) => intersects(boxOfSlot(cand, st.baseSize, area), box))
    if (conflict) {
      deps.notify('placement-rebound', { id: st.id, slot: { ...cand } })
      settle(false, 'rebound')
      return
    }
    if (cand.col === p.originalBase.col && cand.row === p.originalBase.row) {
      settle(true, 'zero')
      return
    }
    place(st, cand)
    settle(true, 'placed')
  }

  function cancel(reason: 'esc' | 'blur' | 'pointercancel'): void {
    if (!press) return
    const id = press.id
    deps.notify('placement-cancelled', { id, reason })
    settle(false, 'cancel')
  }

  function onPointerCancel(e: PointerEvent): void {
    if (!press || e.pointerId !== press.pointerId) return
    cancel('pointercancel')
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || !press) return
    e.preventDefault()
    e.stopPropagation()
    cancel('esc')
  }

  function onBlur(): void {
    if (press) cancel('blur')
  }

  function onClickCapture(e: MouseEvent): void {
    if (!suppressNextClick) return
    suppressNextClick = false
    e.preventDefault()
    e.stopPropagation()
    deps.notify('placement-click-suppressed', { id: lastDraggedId })
  }

  function onPointerDownCapture(): void {
    // 新一笔按下先清吞没态（尾随 click 可能没来）
    suppressNextClick = false
  }

  function onResize(): void {
    area = usableAreaOf(window.innerWidth, window.innerHeight)
    updateOverlays()
    // 分辨率/面板尺寸变化：手定位保留并夹取进可用区；相撞的卡挪最近空位
    schedule()
    deps.notify('placement-viewport', { area: { ...area } })
  }

  function setupObservers(): void {
    // 位置重排只由显式信号驱动（1Hz 快照 render、插件 onDomChanged、展开/收起、搜索态切换、
    // resize）——不用 MutationObserver 盯 style/class：宿主自己写位置会反过来触发观察者，
    // 是「同步 → 写 DOM → 再同步」空转的典型成因（真机首轮实证：渲染层被钉死）。
    // 插件卡据此知道自己不是位置的所有者（doc-group-cards 的布局计算改走 data-placement-auto-*）。
    document.documentElement.dataset.placementHost = 'grid'
    window.addEventListener('resize', onResize)
    window.addEventListener('blur', onBlur)
    document.addEventListener('pointerdown', onPointerDownCapture, true)
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerCancel)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('click', onClickCapture, true)
  }

  setupObservers()

  return {
    sync,
    dragging: () => press?.mode === 'drag',
    activeHotzoneId: () => (press?.mode === 'drag' ? 'placement' : null),
    armedOnDocZone: () => press !== null && press.id === 'doc-zone',
    resetFrozen() {
      frozen = false
      frozenSlots = new Map()
      groupBase = new Map()
      deps.notify('placement-factory', {})
    },
    refresh: () => sync({ cards: currentHandSnapshot(), docZone: docZoneCfg }),
    dispose() {
      disposed = true
      window.removeEventListener('resize', onResize)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('pointerdown', onPointerDownCapture, true)
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerCancel)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('click', onClickCapture, true)
    },
  } as PlacementHost & { dispose(): void }
}
