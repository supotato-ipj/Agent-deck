// 面板渲染层（原生 ESM 模块，工单10 起：插件资产同源经 deck-plugin:// 协议动态 import）。
// 数据一律经桥接契约自内核而来（初始 snapshot + panel/changed 订阅）；
// 天气卡是唯一例外：纯前端直连 Open-Meteo（沿用 patched 壁纸先例），坐标经快照下发。
// 渲染层向宿主声明交互热区（各卡片矩形）；字体就绪后再声明一次，免字体换挡挪动矩形。
import { syncPlugins } from './plugins.js'
import type { PluginRuntimeDeps } from './plugins.js'
import { pad, pad3 } from './format.js'
import { EMPTY_SELECTION, itemMenuPlan, launchListOf, nextSelection } from './selection.js'
import type { SelectionEvent, SelectionModel } from './selection.js'

const CAL_WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T
}

// ---- 存证上报（前 3 次渲染；验收电池断言数据到达与刷新） ----

function notify(type: string, payload?: Record<string, unknown>): void {
  window.deck.host.notify(type, payload)
}

// ---- 日历卡（纯前端，自快照时钟推导） ----

const calTitle = el('cal-title')
const calGrid = el('cal-grid')

function renderCalendar(epochMs: number): void {
  const d = new Date(epochMs)
  calTitle.textContent = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
  calGrid.textContent = ''
  for (const wd of CAL_WEEKDAYS) {
    const head = document.createElement('div')
    head.className = 'head'
    head.textContent = wd
    calGrid.appendChild(head)
  }
  const first = new Date(d.getFullYear(), d.getMonth(), 1)
  const lead = (first.getDay() + 6) % 7 // 周一为首列
  const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
  for (let i = 0; i < lead; i++) {
    const blank = document.createElement('div')
    calGrid.appendChild(blank)
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const cell = document.createElement('div')
    cell.className = day === d.getDate() ? 'day today' : 'day'
    cell.textContent = String(day)
    calGrid.appendChild(cell)
  }
}

let calendarMonth = -1

// ---- 桌面承载（工单05 扫描/图标/启动 + 工单06 编排/摆位 + 工单20 选区）：dock 应用区 + 文档区分组列 ----
// 条目池随 1Hz 快照下发，按指纹 diff——集合未变不重建 DOM；图标经 desktop/icon
// 懒取（dataURL 本地缓存，键含 mtime，lnk 指向变更自然换图标）。
// 工单06 起 dock 按 plan.dock 序铺条（手钉→摆位→推荐），文档区按 plan.docs 的
// 组序/组内序铺分组列；拖拽摆位经 desktop/move 落内核并持久化。
// 工单20 起选区是名字集合（跨分区、瞬态、按名存续）：迁移全部走 selection.ts
// 纯状态机，本文件只消费其输出——快照重建后按名恢复，消失条目自动剔除。
// 工单21 起分区空白可框选（band=替换 / ctrl+band=并集，起笔阈值与拖拽共用）。
// 工单22 起批量拖拽：起笔于选中集内且集合多条 = 整组按选区插入序迁移，ghost 带
// 「N 项」徽标（N = 实际拖动条数，不含手钉——渲染层按 plan.dock 的 pinned 段预测，
// 内核回报的 skipped 是权威口径，经 desktop-moved-batch 存证如实上报）。
// 工单23 起分区空白右键弹上下文菜单：shell 是 cordis 插件（cards/context-menu，
// 随清单热插拔），触发与收起裁决在面板——右键分区空白（热区内、非条目上）把内置
// 两项交给 shell；开层期间热区换全窗，任何菜单外按下即收起并吞掉那一击。
// 工单24 起条目右键弹单项菜单（打开/打开所在位置/复制路径）：弹/切裁决经
// selection.itemMenuPlan，动作走 desktop/launch（via=ctx-menu）/desktop/reveal/
// desktop/copy-path 三个契约，收起与吞没共用 23 的面板裁决。
// 工单25 起单项菜单第 4 行按目标条目手钉态条件显隐：手钉见【取消手钉】
// （desktop/unpin）、非手钉见【钉到应用区】（desktop/pin）——改摆位存储的手钉
// 清单并即时重编排，文档类条目取消后按归类+显式摆位裁决回文档区。
// 工单26 起右键命中选中集内条目（选区多于一条）弹多选菜单：条目集收敛为
// 【打开全部 / 复制路径（多行 \n）】（desktop/launch 逐项 + desktop/copy-paths 整份），
// 动作作用于整个选区且选区不动；右键非选中条目仍走单项菜单（先切单选）。

const dockZone = el('dock-zone')
const docZone = el('doc-zone')
const docGroups = el('doc-groups')
const GROUP_ORDER = ['folders', 'office', 'pdf', 'image', 'archive', 'other'] as const
const GROUP_LABELS: Record<string, string> = {
  folders: 'FOLDERS', office: 'OFFICE', pdf: 'PDF', image: 'IMAGE', archive: 'ARCHIVE', other: 'OTHER',
}
const localIcons = new Map<string, string>()
let desktopFingerprintSeen = ''
let desktopRenderCount = 0
let selection: SelectionModel = EMPTY_SELECTION
/** 最近一拍条目名 → 条目（双击全开按名取 path；快照未变时同样有效） */
let itemByName = new Map<string, DesktopItem>()
/** 手钉名集（plan.dock 的 pinned 段；批量拖拽的「N 项」徽标据此预测 skipped） */
let pinnedNames = new Set<string>()
let layoutApplied = ''

function itemGlyph(item: DesktopItem): string {
  return item.kind === 'folder' ? 'DIR' : item.kind === 'url' ? 'URL' : 'DOC'
}

function markSelection(): void {
  const sel = new Set(selection.names)
  for (const d of document.querySelectorAll<HTMLElement>('.ditem')) {
    d.classList.toggle('sel', sel.has(d.dataset.name ?? ''))
  }
}

/** 选区事件入口：状态机迁移 → DOM 标记 → 生灭存证（desktop-* 族；#19 存证约定）。
 * band/ctrl-band 不在此发事件——框选的生灭与结果存证归框选生命周期事件
 * （desktop-marquee-started/updated/finished/cancelled，含矩形与最终名单）。 */
function applySelection(event: SelectionEvent): void {
  const prev = selection.names
  selection = nextSelection(selection, event)
  markSelection()
  if (event.type === 'click') {
    notify('desktop-selected', { name: event.name, names: [...selection.names] })
  } else if (event.type === 'ctrl-click') {
    notify('desktop-selection-toggled', {
      name: event.name,
      names: [...selection.names],
      selected: selection.names.includes(event.name),
    })
  } else if (event.type === 'blank-click') {
    if (prev.length) notify('desktop-selection-cleared', { had: [...prev] })
  } else if (event.type === 'reconcile') {
    const removed = prev.filter((n) => !selection.names.includes(n))
    if (removed.length) notify('desktop-selection-pruned', { removed, names: [...selection.names] })
  } else if (event.type === 'select-all') {
    notify('desktop-selection-all', { names: [...selection.names] })
  }
}

/** 双击启动名单逐项经 desktop/launch（走既有启动校验），结果逐项存证；via 记来源
 * （双击 / 工单24 单项菜单「打开」——同一启动链路，存证可分） */
function launchNames(names: readonly string[], via: 'dblclick' | 'ctx-menu' = 'dblclick'): void {
  for (const name of names) {
    const target = itemByName.get(name)
    if (!target) {
      // 渲染层快照落后于内核池：按同名拒绝存证（与内核「不在当前扫描池内」同语义）
      notify('desktop-launch-rejected', { name, ok: false, error: '桌面项不在当前扫描池内' })
      continue
    }
    notify('desktop-launch-clicked', { name: target.name, path: target.path, via })
    void window.deck.bridge.invoke('desktop/launch', { path: target.path }).then(
      (r) => notify(r.ok ? 'desktop-launched' : 'desktop-launch-rejected', {
        name: target.name, ok: r.ok, error: r.error ?? null,
      }),
      (err: unknown) => notify('desktop-launch-failed', { name: target.name, message: String(err) }),
    )
  }
}

function fetchItemIcon(img: HTMLImageElement, item: DesktopItem): void {
  void window.deck.bridge.invoke('desktop/icon', { key: item.iconKey }).then((r) => {
    const dataUrl = r && r.dataUrl
    if (!dataUrl) {
      // 提取失败/未就绪：落位字形占位（不重试——内核侧已有按尝试上限的退避）
      const glyph = document.createElement('div')
      glyph.className = 'glyph'
      glyph.textContent = itemGlyph(item)
      img.replaceWith(glyph)
      return
    }
    localIcons.set(item.iconKey, dataUrl)
    img.src = dataUrl
  }, () => { /* 图标是观感项，失败不阻塞承载 */ })
}

function buildItem(item: DesktopItem): HTMLElement {
  const d = document.createElement('div')
  d.className = 'ditem'
  d.dataset.name = item.name
  const img = document.createElement('img')
  img.className = 'icon'
  img.alt = ''
  img.draggable = false
  const cached = localIcons.get(item.iconKey)
  if (cached) img.src = cached
  else fetchItemIcon(img, item)
  const label = document.createElement('div')
  label.className = 'label'
  label.textContent = item.display
  d.append(img, label)
  // 单击选中（启动前确认目标；Ctrl+单击切换）；双击全开（集内任一条=整集，肌肉记忆
  // 原样保留）；拖拽摆位（工单06）。双击序列的第二击（e.detail≥2）不做选区迁移——
  // 整集语义由 dblclick 分支经状态机裁决（selection.ts 注记的时间无关实现）。
  d.addEventListener('click', (e) => {
    if (dragState.suppressed || marqueeState.suppressed) return // 拖拽/框选结束的那一下点击不算选中
    if (e.detail > 1) return
    applySelection(e.ctrlKey
      ? { type: 'ctrl-click', name: item.name }
      : { type: 'click', name: item.name })
  })
  d.addEventListener('dblclick', () => {
    if (dragState.suppressed) return
    const launch = launchListOf(selection, item.name)
    selection = nextSelection(selection, { type: 'dblclick', name: item.name })
    notify('desktop-launch-set-clicked', { names: [...launch] })
    launchNames(launch)
  })
  // 条目上下文菜单（工单24 单项 / 工单26 多选）：弹/切裁决在状态机（selection.itemMenuPlan）
  // ——选中集内条目（选区多于一条）弹多选菜单，动作作用于整集、选区不动；非选中条目
  // 先发 click 把选区切为该条（desktop-selected 存证随之自然产生）再弹单项菜单。
  // 手势进行中不弹（native 惯例，分区空白菜单同法）。
  d.addEventListener('contextmenu', (e) => {
    if (dragState.active || marqueeState.active) return
    e.preventDefault() // 自绘世界观没有原生菜单，右键只属于上下文菜单
    const plan = itemMenuPlan(selection, item.name)
    if (plan.kind === 'multi') {
      window.deckCtxMenu?.open(e.clientX, e.clientY, multiItemMenuItems(selection.names))
      return
    }
    if (plan.switchTo) applySelection({ type: 'click', name: plan.switchTo })
    window.deckCtxMenu?.open(e.clientX, e.clientY, itemMenuItems(item))
  })
  wireDrag(d, item)
  return d
}

// ---- 拖拽摆位（工单06；工单22 批量）：指针事件自实现（非 HTML5 DnD——合成输入驱不动
// OLE 拖拽，且自绘世界要的是「排在谁前面」语义）。拖拽期间声明全窗热区：跨分区拖动会
// 路过非热区空档，若不临时全窗接收，中途面板转穿透、pointer 流即断（拖拽死在中途）。
// 批量（工单22）：起笔于选中集内且集合多条 = 整组按选区插入序迁移（desktop/move-batch，
// 手钉组员由内核跳过并回报 skipped）；起笔于集合外 = 单选拖拽（desktop/move，现状不变）。

interface DragState {
  name: string | null
  fromZone: string | null
  /** 批量拖拽组（选区插入序）；单选拖拽为 null。含手钉组员——可动性由内核裁决 */
  group: string[] | null
  startX: number
  startY: number
  active: boolean
  suppressed: boolean
  ghost: HTMLElement | null
  target: { zone: 'app' | 'doc'; beforeName: string | null } | null
}

const dragState: DragState = {
  name: null, fromZone: null, group: null, startX: 0, startY: 0, active: false, suppressed: false, ghost: null, target: null,
}

const DRAG_THRESHOLD_PX = 6

function zoneOfContainer(node: Node | null): 'app' | 'doc' | null {
  for (let n = node; n; n = (n as HTMLElement).parentElement) {
    const id = (n as HTMLElement).id
    if (id === 'dock-zone') return 'app'
    if (id === 'doc-groups' || id === 'doc-zone') return 'doc'
  }
  return null
}

function itemUnder(exclude: readonly string[]): string | null {
  const ex = new Set(exclude)
  const hit = document.elementFromPoint(lastPointer.x, lastPointer.y)
  const item = hit && (hit as HTMLElement).closest ? (hit as HTMLElement).closest<HTMLElement>('.ditem') : null
  if (!item || !item.dataset.name) return null
  if (ex.has(item.dataset.name)) return null
  return item.dataset.name
}

const lastPointer = { x: 0, y: 0 }

function markDropTarget(): void {
  for (const d of document.querySelectorAll<HTMLElement>('.ditem.drop-before')) d.classList.remove('drop-before')
  if (!dragState.target || dragState.target.beforeName === null) return
  const node = document.querySelector<HTMLElement>(`.ditem[data-name="${CSS.escape(dragState.target.beforeName)}"]`)
  if (node) node.classList.add('drop-before')
}

function wireDrag(d: HTMLElement, item: DesktopItem): void {
  d.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    dragState.name = item.name
    dragState.fromZone = item.zone
    // 批量拖拽判定（工单22）：起笔于选中集内且集合多条 = 整组拖。起笔于集合外仍是
    // 单选拖拽——此刻的旧选区原样保留（收束语义归尾随 click），不在此抢先改选区。
    dragState.group = selection.names.length >= 2 && selection.names.includes(item.name)
      ? [...selection.names]
      : null
    dragState.startX = e.clientX
    dragState.startY = e.clientY
    dragState.active = false
    dragState.suppressed = false
    try { d.setPointerCapture(e.pointerId) } catch { /* 旧环境退化：窗口内拖拽仍可用 */ }
  })
  d.addEventListener('pointermove', (e) => {
    if (dragState.name !== item.name) return
    lastPointer.x = e.clientX
    lastPointer.y = e.clientY
    if (!dragState.active) {
      if (Math.hypot(e.clientX - dragState.startX, e.clientY - dragState.startY) < DRAG_THRESHOLD_PX) return
      dragState.active = true
      dragState.suppressed = true
      beginGhost(item)
      // 全窗热区：拖拽途中经过非热区空档也不转穿透
      window.deck.host.setHotZones([{ id: 'drag', x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }])
    }
    if (dragState.ghost) {
      dragState.ghost.style.left = `${e.clientX - 24}px`
      dragState.ghost.style.top = `${e.clientY - 24}px`
    }
    const zone = zoneOfContainer(document.elementFromPoint(e.clientX, e.clientY))
    if (zone === null) {
      dragState.target = null
    } else {
      // 落点参照不取被拖组员（批量整组都走，以组外条目为锚；单选即自身）
      dragState.target = { zone, beforeName: itemUnder(dragState.group ?? [item.name]) }
    }
    markDropTarget()
  })
  const finish = () => {
    if (dragState.name !== item.name) return
    const { active, target, fromZone, group } = dragState
    const name = dragState.name
    endDrag()
    if (!active || !target) return
    if (group) {
      if (batchDropUnchanged(group, target.zone, target.beforeName)) return // 整组原地：不落盘
      notify('desktop-move-batch-clicked', { names: [...group], zone: target.zone, beforeName: target.beforeName })
      void window.deck.bridge.invoke('desktop/move-batch', { names: [...group], zone: target.zone, beforeName: target.beforeName }).then(
        (r) => notify(r.ok ? 'desktop-moved-batch' : 'desktop-move-batch-rejected', {
          names: [...group], zone: target.zone, beforeName: target.beforeName,
          moved: r.moved, skipped: r.skipped, ok: r.ok, error: r.error ?? null,
        }),
        (err: unknown) => notify('desktop-move-batch-failed', { names: [...group], message: String(err) }),
      )
      return
    }
    if (target.zone === fromZone && target.beforeName === nextSiblingName(name)) return // 位置未变，不落盘
    notify('desktop-move-clicked', { name, zone: target.zone, beforeName: target.beforeName })
    void window.deck.bridge.invoke('desktop/move', { name, zone: target.zone, beforeName: target.beforeName }).then(
      (r) => notify(r.ok ? 'desktop-moved' : 'desktop-move-rejected', {
        name, zone: target.zone, beforeName: target.beforeName, ok: r.ok, error: r.error ?? null,
      }),
      (err: unknown) => notify('desktop-move-failed', { name, message: String(err) }),
    )
  }
  d.addEventListener('pointerup', finish)
  d.addEventListener('pointercancel', () => {
    if (dragState.name === item.name) endDrag()
  })
}

/** 批量同位守卫（单选「位置未变，不落盘」的整组版）：组员已全部在目标分区、且按
 * 选区插入序紧贴参照之前（参照 null = 紧贴末尾）——整组原地，不落盘不发存证。 */
function batchDropUnchanged(group: readonly string[], zone: 'app' | 'doc', beforeName: string | null): boolean {
  const container = zone === 'app' ? dockZone : docGroups
  const order = [...container.querySelectorAll<HTMLElement>('.ditem')].map((d) => d.dataset.name ?? '')
  if (!group.every((n) => order.includes(n))) return false // 有组员在另一分区：跨区必变
  const at = beforeName === null ? order.length : order.indexOf(beforeName)
  if (at < group.length) return false // 参照之前装不下整组
  return order.slice(at - group.length, at).join('\u0000') === group.join('\u0000')
}

function nextSiblingName(name: string): string | null {
  const node = document.querySelector<HTMLElement>(`.ditem[data-name="${CSS.escape(name)}"]`)
  let n = node ? node.nextElementSibling : null
  while (n && !(n as HTMLElement).classList.contains('ditem')) n = n.nextElementSibling
  return n ? (n as HTMLElement).dataset.name ?? null : null
}

function beginGhost(item: DesktopItem): void {
  const group = dragState.group ?? [item.name]
  // 只把「实际会动的」条目变半透明：批量组里的手钉组员原地不动（内核会跳过），
  // 不参与拖拽观感。N 项徽标 = 实际拖动条数（不含 skipped）——渲染层按 pinned 名集
  // 预测，权威 skipped 口径由内核回报、desktop-moved-batch 存证上报。
  const movers = group.filter((n) => !pinnedNames.has(n))
  for (const n of movers) {
    document.querySelector<HTMLElement>(`.ditem[data-name="${CSS.escape(n)}"]`)?.classList.add('dragging')
  }
  const source = document.querySelector<HTMLElement>(`.ditem[data-name="${CSS.escape(item.name)}"]`)
  const ghost = document.createElement('div')
  ghost.id = 'drag-ghost'
  const img = source ? source.querySelector('img') : null
  if (img) {
    const g = document.createElement('img')
    g.src = img.src
    g.style.width = '40px'
    g.style.height = '40px'
    ghost.appendChild(g)
  }
  const label = document.createElement('div')
  label.className = 'label'
  label.textContent = item.display
  ghost.appendChild(label)
  if (dragState.group) {
    const badge = document.createElement('div')
    badge.className = 'badge'
    badge.textContent = `${movers.length} 项`
    ghost.appendChild(badge)
    notify('desktop-batch-drag-started', { names: [...dragState.group], count: movers.length })
  }
  document.body.appendChild(ghost)
  dragState.ghost = ghost
}

function endDrag(): void {
  if (dragState.ghost) {
    dragState.ghost.remove()
    dragState.ghost = null
  }
  for (const d of document.querySelectorAll<HTMLElement>('.ditem.dragging')) d.classList.remove('dragging')
  for (const d of document.querySelectorAll<HTMLElement>('.ditem.drop-before')) d.classList.remove('drop-before')
  dragState.name = null
  dragState.fromZone = null
  dragState.group = null
  dragState.active = false
  dragState.target = null
  declareHotZones()
  // suppressed 在下一拍放开：pointerup 后浏览器还会补发一次 click（拖拽尾-click 不算选中）
  setTimeout(() => { dragState.suppressed = false }, 0)
}

// ---- 框选（工单21，CONTEXT.md「框选」）：从分区热区内的空白起笔拖出半透明矩形，
// 凡与矩形相交的桌面项即时高亮；松手普通=替换选区、Ctrl=并集（迁移入 selection.ts
// 状态机，本文件只消费输出）。与拖拽摆位共用起笔阈值：阈值内松手就是普通空白单击
// （清空语义走既有 click 冒泡，suppressed 不置位）；越过阈值后声明全窗热区续接指针流
// （拖拽同法）——指针流出分区包围盒框选不中断。热区外空白桌面不经过面板（穿透照旧）。

interface MarqueeState {
  zone: HTMLElement | null
  pointerId: number | null
  startX: number
  startY: number
  /** 起笔瞬间的 Ctrl 态：「按住 Ctrl 框选」——预演与提交同源，不随途中/松手修饰键漂移 */
  ctrl: boolean
  active: boolean
  suppressed: boolean
  rect: HTMLElement | null
  hits: readonly string[]
  rectNow: { x: number; y: number; w: number; h: number } | null
}

const marqueeState: MarqueeState = {
  zone: null, pointerId: null, startX: 0, startY: 0, ctrl: false, active: false, suppressed: false,
  rect: null, hits: [], rectNow: null,
}

/** 框选命中：与「起笔 → 现位」矩形相交的桌面项名（DOM 序 = 并集插入序） */
function marqueeHits(x: number, y: number): string[] {
  const left = Math.min(marqueeState.startX, x)
  const top = Math.min(marqueeState.startY, y)
  const right = Math.max(marqueeState.startX, x)
  const bottom = Math.max(marqueeState.startY, y)
  const names: string[] = []
  for (const d of document.querySelectorAll<HTMLElement>('.ditem')) {
    const r = d.getBoundingClientRect()
    if (r.left < right && r.right > left && r.top < bottom && r.bottom > top) {
      const name = d.dataset.name ?? ''
      if (name) names.push(name)
    }
  }
  return names
}

/** 框选高亮预演：普通=命中集（替换预览）、Ctrl=现选区∪命中（并集预览，与状态机
 * ctrl-band 同式——语义唯一出处仍是状态机，这里只是提交前的显示层同构覆写），
 * 松手后 markSelection 按状态机输出重刷。 */
function markMarqueePreview(hits: readonly string[], ctrl: boolean): void {
  const set = new Set(ctrl ? [...selection.names, ...hits] : hits)
  for (const d of document.querySelectorAll<HTMLElement>('.ditem')) {
    d.classList.toggle('sel', set.has(d.dataset.name ?? ''))
  }
}

function updateMarquee(x: number, y: number, ctrl: boolean): void {
  const box = {
    x: Math.min(marqueeState.startX, x),
    y: Math.min(marqueeState.startY, y),
    w: Math.abs(x - marqueeState.startX),
    h: Math.abs(y - marqueeState.startY),
  }
  marqueeState.rectNow = box
  if (marqueeState.rect) {
    marqueeState.rect.style.left = `${box.x}px`
    marqueeState.rect.style.top = `${box.y}px`
    marqueeState.rect.style.width = `${box.w}px`
    marqueeState.rect.style.height = `${box.h}px`
  }
  const hits = marqueeHits(x, y)
  const changed = hits.join('\u0000') !== marqueeState.hits.join('\u0000')
  marqueeState.hits = hits
  markMarqueePreview(hits, ctrl)
  // 存证只随命中集变化发（矩形本身每拍都重绘；命中不变时事件无信息量）
  if (changed) notify('desktop-marquee-updated', { rect: box, hits: [...hits] })
}

function resetMarquee(): void {
  if (marqueeState.rect) {
    marqueeState.rect.remove()
    marqueeState.rect = null
  }
  marqueeState.zone = null
  marqueeState.pointerId = null
  marqueeState.active = false
  marqueeState.hits = []
  marqueeState.rectNow = null
  markSelection()
  declareHotZones()
  // suppressed 在下一拍放开：pointerup 后浏览器还会补发一次 click（框选尾-click 不算空白清空）
  setTimeout(() => { marqueeState.suppressed = false }, 0)
}

// ---- 分区空白清空选区（工单20）+ 框选起笔（工单21）：条目之外的分区容器面单击即清空
// （CONTEXT.md「选区」）；同一起笔面按住拖动即框选。条目自身的点击会冒泡上来，按
// closest 滤掉（各走各的语义）；分区热区只覆盖条目包围盒+边距，热区之外的空白本来
// 就不进面板（透传真桌面，不到这里）。

for (const zone of [dockZone, docZone]) {
  zone.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('.ditem')) return // 起笔于条目：点选/拖拽摆位路径，不进框选
    // 上一笔框选若因指针流中断而残留（up/cancel 未达，矩形/吞点击态悬空），起笔时静默收尸
    if (marqueeState.active || marqueeState.rect) resetMarquee()
    marqueeState.zone = zone
    marqueeState.pointerId = e.pointerId
    marqueeState.startX = e.clientX
    marqueeState.startY = e.clientY
    marqueeState.ctrl = e.ctrlKey
    marqueeState.active = false
    try { zone.setPointerCapture(e.pointerId) } catch { /* 旧环境退化：窗口内框选仍可用 */ }
  })
  zone.addEventListener('pointermove', (e) => {
    if (marqueeState.pointerId !== e.pointerId || marqueeState.zone !== zone) return
    if (!marqueeState.active) {
      if (Math.hypot(e.clientX - marqueeState.startX, e.clientY - marqueeState.startY) < DRAG_THRESHOLD_PX) return
      marqueeState.active = true
      marqueeState.suppressed = true
      const rect = document.createElement('div')
      rect.id = 'marquee-rect'
      document.body.appendChild(rect)
      marqueeState.rect = rect
      // 全窗热区：框选途中流出分区包围盒也不转穿透（拖拽同法）
      window.deck.host.setHotZones([{ id: 'marquee', x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }])
      notify('desktop-marquee-started', { from: { x: marqueeState.startX, y: marqueeState.startY } })
    }
    updateMarquee(e.clientX, e.clientY, marqueeState.ctrl)
  })
  zone.addEventListener('pointerup', (e) => {
    if (marqueeState.pointerId !== e.pointerId) return
    if (!marqueeState.active) {
      resetMarquee() // 阈值内松手：尾随 click 走空白清空语义（普通点击）
      return
    }
    const ctrl = marqueeState.ctrl
    const hits = [...marqueeState.hits]
    const rectNow = marqueeState.rectNow
    applySelection(ctrl ? { type: 'ctrl-band', names: hits } : { type: 'band', names: hits })
    notify('desktop-marquee-finished', { rect: rectNow, ctrl, hits, names: [...selection.names] })
    resetMarquee()
  })
  zone.addEventListener('pointercancel', (e) => {
    if (marqueeState.pointerId !== e.pointerId) return
    if (marqueeState.active) notify('desktop-marquee-cancelled', {}) // 生灭存证的 abort 半边
    resetMarquee() // 取消即作废：不提交命中，选区保持框选前原样
  })
  zone.addEventListener('click', (e) => {
    if (dragState.suppressed || marqueeState.suppressed) return
    if ((e.target as HTMLElement).closest('.ditem')) return
    applySelection({ type: 'blank-click' })
  })
  // 右键分区空白（工单23）：热区内的分区面本来就只在这里可达（热区外穿透传真桌面），
  // 到达即「热区内」。条目右键归条目自己的 contextmenu 监听（工单24 单项菜单），此处
  // closest 滤掉不重复弹；手势进行中不弹（native 惯例）。
  zone.addEventListener('contextmenu', (e) => {
    if (dragState.active || marqueeState.active) return
    if ((e.target as HTMLElement).closest('.ditem')) return
    e.preventDefault() // 自绘世界观没有原生菜单，右键只属于上下文菜单
    window.deckCtxMenu?.open(e.clientX, e.clientY, ctxMenuItems())
  })
}

// ---- 上下文菜单（工单23，CONTEXT.md 词条）：shell 是 cordis 插件（cards/context-menu，
// 卸载即摘 window.deckCtxMenu，这里的触发与收起全部 ?. 空转 = 热插拔自动生效）。
// 触发在上面的分区监听里；收起裁决在面板：开层期间的任何菜单外按下（含热区外全窗
// 范围——全窗热区承接）在捕获段拦下，尾随 click/contextmenu 由 suppressed 捕获段
// 恰吞一笔——菜单外一击只收菜单：不产生选区副作用，右键也不立刻复弹。
// suppressed 是消费制而非定时制（工单23 复审修正）：置位于 pointerdown，复位只发生在
// 「吞掉首笔尾随事件」或「下一笔按下」——尾随事件是 down/up 之后的独立输入任务，
// setTimeout(0) 会抢在它前面复位（拖拽/框选的 suppressed 置位于 pointerup，无此问题）。
// 条目集是 contributor 注册位（open(x,y,items)）：本票两项内置，注册机制后续工单接入。

const menuState = { suppressed: false }

function menuOpen(): boolean {
  return window.deckCtxMenu?.isOpen() === true
}

/** 内置两项：全选走选区状态机（select-all），恢复出厂布局复用 06 契约（与设置浮层入口同链路） */
function ctxMenuItems(): DeckCtxMenuItem[] {
  return [
    {
      id: 'select-all',
      label: 'SELECT ALL',
      run: () => applySelection({ type: 'select-all', names: [...itemByName.keys()] }),
    },
    { id: 'reset-layout', label: 'RESET LAYOUT', run: () => resetLayout('ctx-menu') },
  ]
}

window.addEventListener('pointerdown', (e) => {
  if (!menuOpen()) {
    menuState.suppressed = false // 新一笔按下先清上一笔的吞没态（其尾随事件可能没来）
    return
  }
  if ((e.target as HTMLElement).closest('#ctx-menu')) return // 菜单内按下：行自己处理
  e.stopPropagation() // 分区框选/条目拖拽的起笔监听不再看到这次按下
  e.preventDefault()
  window.deckCtxMenu?.close()
  menuState.suppressed = true
}, { capture: true })

for (const type of ['click', 'contextmenu'] as const) {
  window.addEventListener(type, (e) => {
    if (!menuState.suppressed) return
    e.stopPropagation()
    e.preventDefault()
    menuState.suppressed = false // 恰吞一笔：收起那一击的尾随事件到此为止
  }, { capture: true })
}

// ---- 单项菜单（工单24，CONTEXT.md「上下文菜单」）：右键单个桌面项的三动作条目集，
// 触发在 buildItem 的条目 contextmenu 监听里（弹/切裁决 = selection.itemMenuPlan）；
// 收起与吞没共用工单23 的面板裁决（开层全窗热区、菜单外一击即收）。三个动作都走
// 内核契约：打开=双击同款 desktop/launch（via 标 ctx-menu）；打开所在位置=desktop/reveal
// （explorer /select, 内核执行，搜索 reveal 同机制）；复制路径=desktop/copy-path——
// 主进程剪贴板写，面板永不激活（focusable:false），渲染层 navigator.clipboard 因文档
// 无焦点不可用。路径校验（扫描池护栏）在内核，与 launch 同款。

/** 单项动作条目集（contributor 注册位形状，同工单23 分区空白内置两项）：三动作之外，
 * 第 4 行按目标条目手钉态条件显隐（工单25）——手钉只见【取消手钉】、非手钉只见
 * 【钉到应用区】；手钉态读最近一拍 plan.dock 的 pinned 段（pinnedNames） */
function itemMenuItems(item: DesktopItem): DeckCtxMenuItem[] {
  return [
    { id: 'open', label: 'OPEN', run: () => launchNames([item.name], 'ctx-menu') },
    { id: 'reveal', label: 'OPEN LOCATION', run: () => revealItem(item) },
    { id: 'copy-path', label: 'COPY PATH', run: () => copyItemPath(item) },
    pinnedNames.has(item.name)
      ? { id: 'unpin', label: 'UNPIN', run: () => unpinItemToStore(item) }
      : { id: 'pin', label: 'PIN TO DOCK', run: () => pinItemToDock(item) },
  ]
}

/** 打开所在位置：desktop/reveal 结果存证（rejected/failed 分名，电池按名断言） */
function revealItem(item: DesktopItem): void {
  notify('desktop-reveal-clicked', { name: item.name, path: item.path, via: 'ctx-menu' })
  void window.deck.bridge.invoke('desktop/reveal', { path: item.path }).then(
    (r) => notify(r.ok ? 'desktop-revealed' : 'desktop-reveal-rejected', {
      name: item.name, ok: r.ok, error: r.error ?? null,
    }),
    (err: unknown) => notify('desktop-reveal-failed', { name: item.name, message: String(err) }),
  )
}

/** 复制路径：desktop/copy-path 结果存证（同上分名） */
function copyItemPath(item: DesktopItem): void {
  notify('desktop-path-copy-clicked', { name: item.name, via: 'ctx-menu' })
  void window.deck.bridge.invoke('desktop/copy-path', { path: item.path }).then(
    (r) => notify(r.ok ? 'desktop-path-copied' : 'desktop-path-copy-rejected', {
      name: item.name, ok: r.ok, error: r.error ?? null,
    }),
    (err: unknown) => notify('desktop-path-copy-failed', { name: item.name, message: String(err) }),
  )
}

/** 钉到应用区（工单25）：desktop/pin 结果存证（rejected/failed 分名，电池按名断言） */
function pinItemToDock(item: DesktopItem): void {
  notify('desktop-pin-clicked', { name: item.name, via: 'ctx-menu' })
  void window.deck.bridge.invoke('desktop/pin', { name: item.name }).then(
    (r) => notify(r.ok ? 'desktop-pinned' : 'desktop-pin-rejected', {
      name: item.name, ok: r.ok, error: r.error ?? null,
    }),
    (err: unknown) => notify('desktop-pin-failed', { name: item.name, message: String(err) }),
  )
}

/** 取消手钉（工单25）：desktop/unpin 结果存证（同上分名） */
function unpinItemToStore(item: DesktopItem): void {
  notify('desktop-unpin-clicked', { name: item.name, via: 'ctx-menu' })
  void window.deck.bridge.invoke('desktop/unpin', { name: item.name }).then(
    (r) => notify(r.ok ? 'desktop-unpinned' : 'desktop-unpin-rejected', {
      name: item.name, ok: r.ok, error: r.error ?? null,
    }),
    (err: unknown) => notify('desktop-unpin-failed', { name: item.name, message: String(err) }),
  )
}

// ---- 多选菜单（工单26）：右键命中选中集内条目（选区多于一条）时弹，动作作用于
// 整个选区（选区不动、无 desktop-selected 副作用），条目集收敛为两动作——复制/剪切/
// 删除全部等二期条目随后续工单补入同一骨架。名单以开层当拍选区为准（插入序 =
// 逐项启动顺序）；收起与吞没共用工单23 的面板裁决。

/** 多选动作条目集（contributor 注册位形状，同工单23/24）：打开全部 = 双击全开同款
 * 整集逐项经 desktop/launch（launchNames，via 标 ctx-menu，逐项存证）；复制路径 =
 * desktop/copy-paths 整集多行。 */
function multiItemMenuItems(names: readonly string[]): DeckCtxMenuItem[] {
  return [
    { id: 'open-all', label: 'OPEN ALL', run: () => launchNames(names, 'ctx-menu') },
    { id: 'copy-path', label: 'COPY PATH', run: () => copyItemPaths(names) },
  ]
}

/** 复制路径（多行，工单26）：desktop/copy-paths 结果存证（desktop-paths-* 族，分名同
 * 单项 desktop-path-* 惯例）。名单路径经 itemByName 解析（launchNames 同款）——渲染层
 * 快照落后于内核池时整份拒绝（与内核「不在当前扫描池内」同语义，剪贴板不写半份名单）；
 * 多行拼接与逐条池内校验在内核（copyPaths）。 */
function copyItemPaths(names: readonly string[]): void {
  const resolved = names.map((name) => itemByName.get(name)?.path)
  if (resolved.some((p) => !p)) {
    notify('desktop-paths-copy-rejected', { names: [...names], ok: false, error: '桌面项不在当前扫描池内' })
    return
  }
  const paths = resolved as string[]
  notify('desktop-paths-copy-clicked', { names: [...names], via: 'ctx-menu' })
  void window.deck.bridge.invoke('desktop/copy-paths', { paths }).then(
    (r) => notify(r.ok ? 'desktop-paths-copied' : 'desktop-paths-copy-rejected', {
      names: [...names], ok: r.ok, error: r.error ?? null,
    }),
    (err: unknown) => notify('desktop-paths-copy-failed', { names: [...names], message: String(err) }),
  )
}

// ---- 编排应用：dock 序 / 文档分组列 / 几何（config 下发） ----

function applyLayout(layout: PanelSnapshot['layout']): void {
  const key = JSON.stringify(layout)
  if (key === layoutApplied) return
  layoutApplied = key
  docZone.style.left = `${layout.docZone.left}px`
  docZone.style.top = `${layout.docZone.top}px`
  docZone.style.maxWidth = `${layout.docZone.maxWidth}px`
  dockZone.style.maxWidth = `${layout.dockMaxWidth}px`
  for (const grid of document.querySelectorAll<HTMLElement>('.doc-group .ggrid')) {
    grid.style.gridTemplateRows = `repeat(${layout.docMaxRows}, auto)`
  }
}

function renderDesktop(state: DesktopState, layout: PanelSnapshot['layout']): void {
  applyLayout(layout)
  itemByName = new Map(state.items.map((i) => [i.name, i]))
  pinnedNames = new Set(state.plan.dock.filter((e) => e.source === 'pinned').map((e) => e.name))
  if (state.fingerprint === desktopFingerprintSeen) return
  desktopFingerprintSeen = state.fingerprint
  const byName = itemByName
  // dock：按编排序铺条；池内 app 条目若不在计划（理论不可达）兜底追加，承载一个不漏
  dockZone.textContent = ''
  const dockNames: string[] = []
  for (const entry of state.plan.dock) {
    const item = byName.get(entry.name)
    if (!item) continue
    dockZone.appendChild(buildItem(item))
    dockNames.push(entry.name)
  }
  for (const item of state.items.filter((i) => i.zone === 'app' && !dockNames.includes(i.name))) {
    dockZone.appendChild(buildItem(item))
    dockNames.push(item.name)
  }
  // 文档区：按组序铺分组列（组内序即 plan.docs 的 rank 序）
  docGroups.textContent = ''
  for (const group of GROUP_ORDER) {
    const entries = state.plan.docs.filter((d) => d.group === group)
    if (!entries.length) continue
    const block = document.createElement('div')
    block.className = 'doc-group'
    const glabel = document.createElement('div')
    glabel.className = 'glabel'
    glabel.textContent = GROUP_LABELS[group]
    const grid = document.createElement('div')
    grid.className = 'ggrid'
    grid.style.gridTemplateRows = `repeat(${layout.docMaxRows}, auto)`
    for (const entry of entries) {
      const item = byName.get(entry.name)
      if (item) grid.appendChild(buildItem(item))
    }
    block.append(glabel, grid)
    docGroups.appendChild(block)
  }
  // 快照重建后按名恢复选区、消失条目剔除（工单20：选区是渲染层瞬态，1Hz 重建不丢）
  applySelection({ type: 'reconcile', liveNames: state.items.map((i) => i.name) })
  declareHotZones()
  desktopRenderCount += 1
  // 存证：条目集合 + 编排序 + 各条目矩形（电池按名定位探针落点/拖放源坐标）+ 当前选区
  notify('desktop-rendered', {
    n: desktopRenderCount,
    fingerprint: state.fingerprint,
    apps: dockNames.length,
    docs: state.plan.docs.length,
    names: state.items.map((i) => i.name),
    sel: [...selection.names],
    dock: state.plan.dock,
    docEntries: state.plan.docs,
    rects: state.items.map((item) => {
      const node = document.querySelector<HTMLElement>(`.ditem[data-name="${CSS.escape(item.name)}"]`)
      if (!node) return { name: item.name, zone: item.zone, rect: null }
      const r = node.getBoundingClientRect()
      return { name: item.name, zone: item.zone, rect: { x: r.left, y: r.top, w: r.width, h: r.height } }
    }),
  })
}

// ---- 设置浮层（工单08）：卡片底色透明度全局滑杆 + 恢复出厂布局入口 ----
// 滑杆 input 即时改 CSS 变量 --card-alpha（.card 与 #dock-zone 的底色，文字全部
// 实色不动）；持久化经内核契约 settings/set-card-opacity（内核整份回写 config.json），
// 回推经 settings/changed 与快照 reconcile（applyCardAlpha 幂等）。
// 浮层开关：点击 settings-btn 切换；ESC 关闭；失焦关闭 = focusout 且焦点未落回浮层
// 内（面板穿透之下「点外部」根本到不了渲染层，与 07 失焦退待机同一语义边界）。
// 恢复出厂布局动作本体属 06，这里接入口（存证 notify 名沿用 06 电池契约）。

const settingsBtn = el('settings-btn')
const settingsCard = el('settings-card')
const opacitySlider = el('opacity-slider') as HTMLInputElement
const opacityValue = el('opacity-value')
const settingsReset = el('settings-reset')
const taskbarToggle = el('taskbar-toggle') as HTMLInputElement
const taskbarToggleState = el('taskbar-toggle-state')
let settingsOpen = false
let appliedOpacity: number | null = null

/** 应用透明度：CSS 变量 + 滑杆/数值 reconcile + 变化存证（boot/滑杆/回推三路共用，幂等） */
function applyCardAlpha(alpha: number): void {
  const clamped = Math.min(1, Math.max(0, alpha))
  document.documentElement.style.setProperty('--card-alpha', clamped.toFixed(3))
  const value = Math.round(clamped * 100)
  opacityValue.textContent = `${pad3(value)}%`
  // 滑杆正被拖拽（持焦点）时不回写位置——用户是唯一来源；其余路径照常 reconcile
  if (document.activeElement !== opacitySlider) opacitySlider.value = String(value)
  if (appliedOpacity !== clamped) {
    appliedOpacity = clamped
    notify('settings-opacity-applied', { value })
  }
}

function renderSettings(s: SettingsState): void {
  applyCardAlpha(s.cardOpacity)
}

/** 任务栏逃生开关（工单50）：勾选态 reconcile——开层拉取、切换回执、taskbar/changed
 * 回推三路共用，幂等。开关关 = 还原原生任务栏的自救通道（内核落盘 config 并销条带窗）。 */
function applyTaskbarEnabled(enabled: boolean): void {
  taskbarToggle.checked = enabled
  taskbarToggleState.textContent = enabled ? 'ON' : 'OFF'
}

type SettingsCloseReason = 'esc' | 'blur' | 'toggle'

function openSettings(): void {
  if (settingsOpen) return
  settingsOpen = true
  // 键盘模式开（工单02）：浮层要接 ESC/滑杆拖拽后的键盘路径，临时取得键盘焦点
  window.deck.host.setKeyboardMode(true)
  settingsCard.style.display = 'block'
  settingsCard.focus()
  // 逃生开关与内核态对齐（工单50）：每次开层拉一手真值，不等回推
  void window.deck.bridge.invoke('taskbar/get-state', null).then(
    (s) => applyTaskbarEnabled(s.enabled),
    () => { /* 拉取失败保持现状，回推会补齐 */ },
  )
  // 滑杆/开关矩形随开层存证（电池按它们定位拖拽/点击落点，desktop-rendered rects 同法）
  const sr = opacitySlider.getBoundingClientRect()
  const tr = taskbarToggle.getBoundingClientRect()
  notify('settings-opened', {
    slider: { x: sr.left, y: sr.top, w: sr.width, h: sr.height },
    taskbarToggle: { x: tr.left, y: tr.top, w: tr.width, h: tr.height },
    value: appliedOpacity == null ? null : Math.round(appliedOpacity * 100),
  })
  declareHotZones()
}

function closeSettings(reason: SettingsCloseReason): void {
  if (!settingsOpen) return
  settingsOpen = false
  // 键盘模式关（工单02）：恢复不可聚焦+钉底；焦点悬空不还原（spec 拍板）。
  // 失焦引发的 focusout 再入被 settingsOpen 早退拦住。
  window.deck.host.setKeyboardMode(false)
  settingsCard.style.display = 'none'
  notify('settings-closed', { reason })
  declareHotZones()
}

settingsBtn.addEventListener('mousedown', (e) => {
  // 点击按钮不转移焦点：浮层开着时点按钮只走 click 开关，不触发 focusout 误关
  e.preventDefault()
})
settingsBtn.addEventListener('click', () => {
  if (settingsOpen) closeSettings('toggle')
  else openSettings()
})

settingsCard.addEventListener('mousedown', (e) => {
  // 滑杆/逃生开关要收焦点（拖拽/键盘切换中渲染层不抢位）；其余区域保焦点，点击不触发失焦关层
  if (e.target !== opacitySlider && e.target !== taskbarToggle) e.preventDefault()
})

settingsCard.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault()
    closeSettings('esc')
  }
})

settingsCard.addEventListener('focusout', (e) => {
  const to = e.relatedTarget as Node | null
  if (to && settingsCard.contains(to)) return // 焦点仍在浮层内（如滑杆）
  closeSettings('blur')
})

opacitySlider.addEventListener('input', () => {
  const value = Math.round(Number(opacitySlider.value))
  applyCardAlpha(value / 100) // 滑杆持焦点，applyCardAlpha 不会回写滑杆位
  notify('settings-opacity-input', { value })
  void window.deck.bridge.invoke('settings/set-card-opacity', { opacity: value / 100 }).then(
    (s) => notify('settings-opacity-set', { value: Math.round(s.cardOpacity * 100) }),
    (err: unknown) => notify('settings-opacity-failed', { message: String(err) }),
  )
})

// 逃生开关切换（工单50）：先存证意图，再经内核落盘生效；失败回滚勾选态（内核未变）。
taskbarToggle.addEventListener('change', () => {
  const enabled = taskbarToggle.checked
  notify('settings-taskbar-toggle', { enabled })
  void window.deck.bridge.invoke('taskbar/set-enabled', { enabled }).then(
    (s) => {
      applyTaskbarEnabled(s.enabled)
      notify('settings-taskbar-set', { enabled: s.enabled })
    },
    (err: unknown) => {
      applyTaskbarEnabled(!enabled)
      notify('settings-taskbar-failed', { message: String(err) })
    },
  )
})

/** 恢复出厂布局（06 契约复用）：设置浮层入口与上下文菜单（工单23）共用同一链路与存证名 */
function resetLayout(from: 'settings' | 'ctx-menu'): void {
  notify('desktop-reset-clicked', { from })
  void window.deck.bridge.invoke('desktop/reset-layout', null).then(
    (r) => notify('desktop-layout-reset', { ok: r.ok, cleared: r.cleared }),
    (err: unknown) => notify('desktop-reset-failed', { message: String(err) }),
  )
}

settingsReset.addEventListener('click', () => resetLayout('settings'))

window.deck.bridge.on('settings/changed', (s) => applyCardAlpha(s.cardOpacity))
// 逃生开关状态回推（工单50）：他端切换（如条带侧动作、插件卸载终态帧）即时对齐勾选态
window.deck.bridge.on('taskbar/changed', (s) => applyTaskbarEnabled(s.enabled))

// ---- 搜索面板（工单07，CONTEXT.md「搜索面板」三态）----
// 待机（SEARCH 头 + CLICK TO SEARCH_ 提示）/ 活动（原生输入框 + 实时结果）/ 引擎离线
// （ENGINE OFFLINE 徽标）。引擎链路全在内核：这里只喂词（search/query，每次 input 事件
// 一发，内核防抖 ~200ms 后直连 Listary），结果/离线经事件回推；↑/↓ 选择、Enter 打开、
// Ctrl+Enter 定位经 search/action 由内核执行。01 探针结论落地：点击激活后渲染层 JS 聚焦
// 输入框（中文输入法可输入，composition 事件照常喂词 = 拼音实时检索）。
// 隐私边界：本文件与全部存证 notify 一律不含查询词内容（只带 qlen 长度，旧 QD_PANEL_TRACE 惯例）。

const searchCard = el('search-card')
const searchHint = el('search-hint')
const searchInput = el('search-input') as HTMLInputElement
const searchPlaceholder = el('search-placeholder')
const searchResultsBox = el('search-results')
const SEARCH_LIMIT = 8
const SEARCH_NAME_CHARS = 26
const SEARCH_PATH_CHARS = 24
let searchActive = false
let searchItems: SearchResultItem[] = []
let searchSel = -1
let searchDeactivating = false // 程序化失焦护栏：deactivate 主动 blur 不再触发失焦转移

/** 完整路径 → (名称, 父目录) 两段展示（listary_engine.display_parts 平移，含盘根反斜杠语义） */
function displayParts(path: string): { name: string; parent: string } {
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  if (cut < 0) return { name: path, parent: '' }
  let parent = path.slice(0, cut)
  if (parent.endsWith(':')) parent += '\\' // 盘根：C:\ 而非 C:（PureWindowsPath 语义）
  return { name: path.slice(cut + 1), parent }
}
/** 超长时保留尾部（路径的辨识段在结尾） */
function elideLeft(s: string, max: number): string {
  return s.length <= max ? s : '…' + s.slice(-(max - 1))
}
/** 超长时保留头部（文件名的辨识段在开头） */
function elideRight(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

/** 面板按键 → 动作（listary_engine.decide_action 平移；其余键不接） */
function searchDecideAction(key: string, ctrl: boolean): 'prev' | 'next' | 'open' | 'reveal' | null {
  if (key === 'ArrowUp') return 'prev'
  if (key === 'ArrowDown') return 'next'
  if (key === 'Enter') return ctrl ? 'reveal' : 'open'
  return null
}

function applySearchSelection(): void {
  const rows = searchResultsBox.querySelectorAll<HTMLElement>('.qrow')
  rows.forEach((row, i) => row.classList.toggle('sel', i === searchSel))
}

/** 选中项移动：首尾 clamp 不环绕（SelectionModel 语义）；结果刷新重置回首项 */
function searchMove(delta: number): void {
  if (!searchItems.length) return
  searchSel = Math.max(0, Math.min(searchItems.length - 1, searchSel + delta))
  applySearchSelection()
  notify('search-selection-moved', { index: searchSel })
}

function clearSearchResultsDom(): void {
  searchResultsBox.textContent = ''
  searchResultsBox.style.display = 'none'
  searchItems = []
  searchSel = -1
}

function renderSearchRows(total: number, items: SearchResultItem[]): void {
  searchItems = items.slice(0, SEARCH_LIMIT)
  searchSel = searchItems.length ? 0 : -1
  searchResultsBox.textContent = ''
  if (!searchItems.length) {
    const empty = document.createElement('div')
    empty.id = 'search-empty'
    empty.textContent = 'NO RESULTS'
    searchResultsBox.appendChild(empty)
  } else {
    searchItems.forEach((item, idx) => {
      const row = document.createElement('div')
      row.className = 'qrow'
      const parts = displayParts(item.path)
      const name = document.createElement('span')
      name.className = 'qname'
      name.textContent = elideRight(parts.name, SEARCH_NAME_CHARS)
      const dir = document.createElement('span')
      dir.className = 'qpath'
      dir.textContent = elideLeft(parts.parent, SEARCH_PATH_CHARS)
      row.append(name, dir)
      // mousedown preventDefault：行点击不夺输入框焦点（失焦即收层，点击会落空）
      row.addEventListener('mousedown', (e) => e.preventDefault())
      row.addEventListener('click', () => { void searchAct(idx, false) })
      searchResultsBox.appendChild(row)
    })
  }
  const foot = document.createElement('div')
  foot.id = 'search-total'
  foot.textContent = `TOTAL ${total}`
  searchResultsBox.appendChild(foot)
  searchResultsBox.style.display = 'block'
  applySearchSelection()
  declareHotZones()
}

function renderSearchOffline(): void {
  searchResultsBox.textContent = ''
  const badge = document.createElement('div')
  badge.id = 'search-offline'
  badge.textContent = 'ENGINE OFFLINE'
  searchResultsBox.appendChild(badge)
  searchResultsBox.style.display = 'block'
  searchItems = []
  searchSel = -1
  declareHotZones()
}

async function searchAct(idx: number, reveal: boolean): Promise<void> {
  const item = searchItems[idx]
  if (!item) return
  notify('search-action', { index: idx, reveal, qlen: searchInput.value.length })
  try {
    const r = await window.deck.bridge.invoke('search/action', { path: item.path, reveal })
    notify(r.ok ? (reveal ? 'search-revealed' : 'search-opened') : 'search-action-rejected', {
      index: idx, reveal, ok: r.ok, error: r.error ?? null,
    })
  } catch (err) {
    notify('search-action-failed', { index: idx, reveal, message: String(err) })
  }
  searchDeactivate('action') // 动作完成即收起（旧 _act → _deactivate('esc') 惯例）
}

function searchActivate(): void {
  if (searchActive) {
    searchInput.focus() // 活动态重复点击 = 摆放光标，不重置查询
    return
  }
  searchActive = true
  // 键盘模式开（工单02）：面板永不激活，这里临时取得键盘焦点再聚焦输入框
  window.deck.host.setKeyboardMode(true)
  searchHint.style.display = 'none'
  searchInput.style.display = 'block'
  searchPlaceholder.style.display = searchInput.value ? 'none' : 'block'
  void window.deck.bridge.invoke('search/activate', null).then((r) => {
    if (r.state === 'offline' && searchActive) renderSearchOffline()
  }, () => { /* 内核未就绪：下次交互再试 */ })
  searchInput.focus()
  notify('search-activated', {})
  declareHotZones()
}


/** 退待机触发源（存证 reason 字段的契约：电池按 reason 断言） */
type SearchDeactivateReason = 'esc' | 'blur' | 'action'

function searchDeactivate(reason: SearchDeactivateReason): void {
  if (!searchActive) return
  searchDeactivating = true
  searchActive = false
  // 键盘模式关（工单02）：恢复不可聚焦+钉底。窗口随之失活会再触发一次 input blur，
  // 由 searchDeactivating 护栏与下方 searchActive 早退双保险拦住，不会打架。
  window.deck.host.setKeyboardMode(false)
  void window.deck.bridge.invoke('search/deactivate', null).catch(() => {})
  searchInput.value = ''
  searchInput.style.display = 'none'
  searchPlaceholder.style.display = 'none'
  searchHint.style.display = 'block'
  clearSearchResultsDom()
  searchInput.blur()
  setTimeout(() => { searchDeactivating = false }, 0)
  notify('search-deactivated', { reason })
  declareHotZones()
}

// 卡片任意位置点击激活；mousedown preventDefault 保输入框焦点（点击卡片他处不触发失焦转移）
searchCard.addEventListener('mousedown', (e) => {
  if (e.target !== searchInput) e.preventDefault()
})
searchCard.addEventListener('click', () => searchActivate())

searchInput.addEventListener('input', () => {
  if (!searchActive) return
  const text = searchInput.value
  searchPlaceholder.style.display = text ? 'none' : 'block'
  if (!text) clearSearchResultsDom() // 空查询即收结果（旧 _on_text_changed 惯例）
  void window.deck.bridge.invoke('search/query', { query: text }).catch(() => {})
})

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault()
    searchDeactivate('esc')
    return
  }
  const action = searchDecideAction(e.key, e.ctrlKey)
  if (!action) return
  e.preventDefault() // ↑↓ 不移动光标（旧 Tk "break" 惯例）
  if (action === 'prev') searchMove(-1)
  else if (action === 'next') searchMove(1)
  else void searchAct(searchSel, action === 'reveal')
})

searchInput.addEventListener('blur', () => {
  if (searchDeactivating) return
  searchDeactivate('blur')
})

window.deck.bridge.on('search/results', (r) => {
  if (!searchActive) return // 迟到响应（已退待机）：丢弃
  renderSearchRows(r.total, r.items)
  notify('search-results-rendered', {
    qlen: searchInput.value.length, total: r.total, count: Math.min(SEARCH_LIMIT, r.items.length),
  })
})

window.deck.bridge.on('search/state', (s) => {
  if (s.state === 'offline' && searchActive) {
    renderSearchOffline()
    notify('search-offline-shown', {})
  }
  // 'active' 恢复由随后到达的 search/results 重绘（离线徽标被结果行替换）；'idle' 由本地转移处理
})

// ---- 总渲染（快照到达即刷新全部卡片 + 桌面组件） ----

/** 插件运行时的宿主依赖：存证与桥接沿用面板同一条通道，DOM 变了重声明热区 */
const pluginDeps: PluginRuntimeDeps = {
  notify,
  invoke: (method, payload) => window.deck.bridge.invoke(method, payload),
  onDomChanged: declareHotZones,
}

/** 最近一拍快照：插件清单变化时复用（渲染层只保留这一份，不另建缓存） */
let lastSnapshot: PanelSnapshot | null = null

function render(snap: PanelSnapshot): void {
  lastSnapshot = snap
  renderDesktop(snap.desktop, snap.layout)
  renderSettings(snap.settings)
  // 桌面组件（工单10）：时钟/天气/会话/硬件四卡各由插件自己渲染（Qoder 状态卡随工单03 退役），
  // 宿主只负责把清单与裁剪后的视图喂过去；日历仍在宿主页面内。
  syncPlugins(snap.plugins, snap, pluginDeps)
  const month = new Date(snap.clock.epochMs).getMonth()
  if (month !== calendarMonth) {
    calendarMonth = month
    renderCalendar(snap.clock.epochMs)
  }
}

// ---- 热区声明（全部卡片 + 桌面承载区） ----
// 桌面分区按「条目包围盒 + 10px 边距」声明：空分区不占热区（不产生点击死区），
// dock 条的内边距随包围盒带进（光标在条边停留仍可交互）。

function zoneItemRect(zone: HTMLElement, id: string): HotzoneRect | null {
  const items = zone.querySelectorAll<HTMLElement>('.ditem')
  if (!items.length) return null
  const box = zone.getBoundingClientRect() // 容器即可见边界（overflow: hidden 裁掉溢出条目）
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const it of items) {
    const r = it.getBoundingClientRect()
    minX = Math.min(minX, r.left)
    minY = Math.min(minY, r.top)
    maxX = Math.max(maxX, r.right)
    maxY = Math.max(maxY, r.bottom)
  }
  // 包围盒与可见容器求交：被裁剪的溢出条目不占热区（不留点击死区），条内边距随包围盒带进
  const pad = 10
  const x = Math.max(minX - pad, box.left)
  const y = Math.max(minY - pad, box.top)
  const right = Math.min(maxX + pad, box.right)
  const bottom = Math.min(maxY + pad, box.bottom)
  if (right <= x || bottom <= y) return null
  return { id, x, y, w: right - x, h: bottom - y }
}

function declareHotZones(): void {
  // 手势进行中（拖拽摆位/框选）或菜单开层（工单23）保持全窗热区：1Hz 快照重建会走到
  // 这里重声明常规热区，若中途覆写回小矩形，指针恰在分区包围盒外时面板转穿透、指针流
  // 即断（矩形残留屏上/菜单外一击收不到）。菜单开层由 shell 的 isOpen 判定（热插拔：
  // 插件卸载即 undefined，自动恢复常规热区）。
  if (dragState.active || marqueeState.active || menuOpen()) {
    const id = menuOpen() ? 'menu' : dragState.active ? 'drag' : 'marquee'
    window.deck.host.setHotZones([{
      id, x: 0, y: 0, w: window.innerWidth, h: window.innerHeight,
    }])
    return
  }
  const rects: HotzoneRect[] = Array.from(document.querySelectorAll<HTMLElement>('.card')).map((card) => {
    const r = card.getBoundingClientRect()
    return { id: card.id, x: r.left, y: r.top, w: r.width, h: r.height }
  })
  const dock = zoneItemRect(dockZone, 'dock-zone')
  if (dock) rects.push(dock)
  const doc = zoneItemRect(docZone, 'doc-zone')
  if (doc) rects.push(doc)
  const sb = settingsBtn.getBoundingClientRect()
  if (sb.width > 0) rects.push({ id: 'settings-btn', x: sb.left, y: sb.top, w: sb.width, h: sb.height })
  // 浮层内的复位按钮自带矩形热区（电池按 id 定位点击，旧独立按钮同法）；随浮层显隐
  const sr = settingsReset.getBoundingClientRect()
  if (sr.width > 0) rects.push({ id: 'settings-reset', x: sr.left, y: sr.top, w: sr.width, h: sr.height })
  // 关闭中的设置浮层矩形为 0（display:none），与一切零尺寸矩形一起不进热区（不留死区）
  window.deck.host.setHotZones(rects.filter((r) => r.w > 0 && r.h > 0))
}

// 插件清单变化即时对齐（放入/移除/改资产即生效，不等 1Hz 快照）：
// 复用最近一拍快照——插件只关心自己能力内的段，无需为此多问内核一次。
window.deck.bridge.on('plugins/changed', (list) => {
  notify('plugins-changed', { ids: list.map((p) => p.id), status: list.map((p) => `${p.id}:${p.status}`) })
  if (!lastSnapshot) return // 快照还没到（启动瞬间）：下一拍 render 自会带上 plugins 段
  syncPlugins(list, { ...lastSnapshot, plugins: list }, pluginDeps)
  declareHotZones()
})

void window.deck.bridge.invoke('panel/snapshot', null).then(render, (err: unknown) => {
  notify('snapshot-error', { message: String(err) })
})
window.deck.bridge.on('panel/changed', render)

declareHotZones()
if (document.fonts) document.fonts.ready.then(declareHotZones)
