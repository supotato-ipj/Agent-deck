// 任务栏条带渲染入口（工单49/52/53/54/55/56/57/58）：状态经 taskbar/get-state 拉取 +
// taskbar/changed 订阅；右组 1Hz 数据帧（时钟 + 硬件仪表，工单55）经 taskbar/status 订阅。
// 三组布局：中组（系统按钮 + 推荐位，工单54）、左组（手钉 + 运行中合并，工单52，右键菜单/
// 中键/多窗口选窗属工单53）、右组（硬件摘要 + 托盘图标 + 音量 + 时钟，工单55/56）。
// 各 pill、按钮/推荐位/左组条目/右组单元格与细条矩形经宿主面声明为热区并落存证——
// 验收电池据此取点击坐标。视图模型是纯函数（taskbar-view.ts）；本文件只是它的 DOM 呈现端
// + 右键菜单/溢出浮层开合。窗口标题与托盘 tooltip 随状态帧即时进出，渲染层不落任何存储。
import { dispatchActivateWindow, dispatchAppClick, dispatchAppMenuAction, dispatchAppNewInstance, dispatchTaskbarButton, dispatchTaskbarDragDrop, dispatchTaskbarVisibility, dispatchTrayClick, fetchTrayIcon, formatClock, formatMetric, splitLeftOverflow, summaryViewModel, taskbarAppMenuRows, taskbarViewModel, toggleMetric } from './taskbar-view.js'
import type { TaskbarAppMenuRow, TaskbarLeftViewEntry } from './taskbar-view.js'
import type { HardwareGauges, TaskbarDragGroup, TaskbarMetric, TaskbarState, TaskbarStatus, TaskbarTrayButton, TaskbarTrayEntry, TaskbarTrayPixels, TaskbarWindowRef } from '../shared/contract'

const pill = document.getElementById('pill') as HTMLElement
const pillLeft = document.getElementById('pill-left') as HTMLElement
const rightPill = document.getElementById('right-pill') as HTMLElement
const sliver = document.getElementById('show-desktop') as HTMLElement

// 换位拖拽（工单57）是本窗唯一的原生拖拽语义，且只长在 .tb-app/.tb-rec 上（makeDraggable）。
// 别处的 img（托盘图标、推荐位图标）默认可拖：一起手就起 OLE 会话，会话收不掉时满屏 Ghost
// 幽灵窗跟着光标走、渲染主线程进模态循环，整条常驻任务栏就此停摆（同面板那份守卫）。
document.addEventListener('dragstart', (e) => {
  if ((e.target as HTMLElement | null)?.closest('.tb-app, .tb-rec')) return
  e.preventDefault()
})

/** 左组几何常量（与 taskbar.html CSS 同源：左缘 8px、padding 6+6、图标格 32+2 间距、组间距 8）。
 * 容量格数宁保守不少让——多留缝也不与中组 pill 重叠（中组居中、左组绝定位贴左）。 */
const LEFT_INSET = 8
const PILL_PAD_X = 12
const CELL_W = 34
const GROUP_GAP = 8

/** 最近一次渲染的状态：几何重排（resize）时按它重声明热区 */
let current: TaskbarState | null = null
/** 右组 1Hz 数据帧的最近值：重渲染（勾选变更）时按它立即填字，不等下一拍 */
let latestStatus: TaskbarStatus | null = null
/** 硬件摘要编辑态（工单55，右键进入勾选子集，再右键/点格外退出） */
let editing = false
/** 系统按钮显隐菜单开合（工单54）：右键开、点菜/点 pill 空白/状态回推收 */
let menuOpen = false
let menuTimer: ReturnType<typeof setTimeout> | null = null
/** 左组溢出浮层开合（工单58）：⋯ 钮拨动、点浮层条目收、数量回落自动收 */
let overflowOpen = false
/** 应用图标右键菜单（工单53）：手钉/解除手钉、关闭窗口、打开文件位置三行随条目形态变化 */
let appMenu: { exe: string; rows: TaskbarAppMenuRow[] } | null = null
/** 多窗口选窗列表（工单53）：app-click 回 window-list 时在 pill 内横排列出，标题仅即时呈现 */
let windowList: { exe: string; windows: TaskbarWindowRef[] } | null = null
/** 拖拽源（工单57）：dragstart 记录，落位判定全在渲染层，落位裁决在内核 */
let dragSource: { group: TaskbarDragGroup; id: string } | null = null
/** 图标 dataURL 缓存（iconKey → dataURL；仅内存——桌面 dock 同款本地缓存纪律） */
const iconCache = new Map<string, string>()

interface Rect { id: string; x: number; y: number; w: number; h: number }

function rectOf(el: HTMLElement, id: string): Rect {
  const r = el.getBoundingClientRect()
  return { id, x: r.x, y: r.y, w: r.width, h: r.height }
}

/** 各 pill、按钮/推荐位/左组条目/右组单元格与细条矩形（CSS px 相对客户区）：
 * 热区声明与验收存证共用同一份测量 */
function measure() {
  return {
    pill: rectOf(pill, 'pill'),
    buttons: [...pill.querySelectorAll<HTMLElement>('.tb-btn')].map((el) => rectOf(el, el.dataset.id ?? '')),
    recommendations: [...pill.querySelectorAll<HTMLElement>('.tb-rec')].map((el) => ({
      name: el.dataset.name ?? '', ...rectOf(el, ''),
    })).map(({ name, ...r }) => ({ name, x: r.x, y: r.y, w: r.w, h: r.h })),
    leftPill: rectOf(pillLeft, 'pill-left'),
    apps: [...pillLeft.querySelectorAll<HTMLElement>('.tb-app')].map((el) => rectOf(el, el.dataset.exe ?? '')),
    overflow: (() => { const el = pillLeft.querySelector<HTMLElement>('.tb-overflow'); return el ? rectOf(el, 'overflow') : null })(),
    rightPill: rectOf(rightPill, 'right-pill'),
    rightCells: [...rightPill.querySelectorAll<HTMLElement>('[data-id]')].map((el) => rectOf(el, el.dataset.id ?? '')),
    trayIcons: [...rightPill.querySelectorAll<HTMLElement>('.tb-tray-icon')].map((el) => ({
      key: el.dataset.key ?? '', ...rectOf(el, el.dataset.key ?? ''),
    })).map(({ key, ...r }) => ({ key, x: r.x, y: r.y, w: r.w, h: r.h })),
    sliver: rectOf(sliver, 'show-desktop'),
  }
}

/** 热区声明（工单52/54/55 并集）：中组不渲染（禁用/全隐藏且无推荐）不含 pill；左组装了
 * 条目才报左组矩形（空组不渲染 pill，缝隙保持穿透）；右组（摘要+音量+时钟）与显示桌面
 * 细条随 enabled 声明；三组皆无即清空——条带整幅恢复穿透 */
function declareHotZones(state: TaskbarState): void {
  if (!state.enabled) {
    window.deck.host.setHotZones([])
    return
  }
  const vm = taskbarViewModel(state)
  const m = measure()
  const zones = [m.rightPill, m.sliver]
  if (vm.visible) zones.unshift(m.pill)
  if (vm.left.length > 0) zones.unshift(m.leftPill)
  window.deck.host.setHotZones(zones)
}

/** 最近一次几何存证签名：几何未变的重渲（窗口标题刷新等无位移帧）不重复刷事件流 */
let lastGeometryJson = ''

/** 几何存证（验收电池点击坐标来源）：pill/按钮/推荐位/左组/右组矩形任一变化即补发一帧——
 * 推荐位随数据面快照后到位会推中组 pill 移位，电池按 settle 后的最新帧取坐标 */
function notifyGeometry(): void {
  const m = measure()
  const payload: Record<string, unknown> = {
    pill: m.pill,
    buttons: m.buttons,
    recommendations: m.recommendations,
    leftPill: m.leftPill,
    apps: m.apps,
    overflow: m.overflow,
    rightPill: m.rightPill,
    rightCells: m.rightCells,
    trayIcons: m.trayIcons,
    sliver: m.sliver,
  }
  const json = JSON.stringify(payload)
  if (json === lastGeometryJson) return
  lastGeometryJson = json
  window.deck.host.notify('taskbar-geometry', payload)
}

/** 系统动作格点击分发 + 存证（中组按钮与右组格同一通道） */
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
    if (current) render(current)
  })
  return cell
}

function closeMenu(): void {
  if (menuTimer !== null) {
    clearTimeout(menuTimer)
    menuTimer = null
  }
  menuOpen = false
}

/** 左组图标装载（工单52）：缓存命中即贴；未命中经 desktop/icon 契约提取（内核侧按
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
 * 同一图标每次状态帧都被重渲，重复 canvas 编码是纯浪费） */
const trayIconUrls = new Map<string, string>()

/** BGRA → RGBA（canvas putImageData 像素序；与 trayhost/pixels 的 alpha 修复同算法，这里只换序） */
function bgraToRgba(bgra: Uint8Array): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(new ArrayBuffer(bgra.length))
  for (let i = 0; i < bgra.length; i += 4) {
    out[i] = bgra[i + 2]; out[i + 1] = bgra[i + 1]; out[i + 2] = bgra[i]; out[i + 3] = bgra[i + 3]
  }
  return out
}

/** 托盘像素 → dataURL（编码在渲染层：主进程只搬字节，tray-spike 验收页同款做法） */
function trayDataUrl(pixels: TaskbarTrayPixels): string {
  const bgra = Uint8Array.from(atob(pixels.bgraBase64), (c) => c.charCodeAt(0))
  const canvas = document.createElement('canvas')
  canvas.width = pixels.width
  canvas.height = pixels.height
  canvas.getContext('2d')?.putImageData(new ImageData(bgraToRgba(bgra), pixels.width, pixels.height), 0, 0)
  return canvas.toDataURL()
}

/** 托盘图标格（工单56）：像素按需取（缓存命中即贴），左键/右键各自回放到所属应用。
 * 回填前核对元素仍代表同一身份（重渲后旧回填不贴错位） */
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
    img.src = cached
  } else {
    void fetchTrayIcon(window.deck.bridge, entry.key).then((pixels) => {
      if (!pixels) return
      const url = trayDataUrl(pixels)
      trayIconUrls.set(entry.key, url)
      if (img.dataset.key === entry.key) img.src = url
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

/** 左组容量（工单58）：pill 实测几何 → 图标格数（含 ⋯ 钮位）。右限 = 中组 pill 左缘
 * （中组整组不渲染时 = 条带右缘）；中组绝定位不参与左组布局，其矩形只作边界。 */
function leftSlots(): number {
  const rightLimit = pill.hidden
    ? document.body.clientWidth - GROUP_GAP
    : pill.getBoundingClientRect().left - GROUP_GAP
  const avail = rightLimit - LEFT_INSET - PILL_PAD_X
  return Math.max(0, Math.floor(avail / CELL_W))
}

/** 左组图标点击（工单53）：裁决在内核（app-click 三态 + 多窗口列表），此处只做
 * 分发与呈现——launch/activate/minimize 无需回显，window-list 才在 pill 内横排
 * 列出窗口标题供精确选窗（条带窗 48px 高，竖排浮层出不了窗口矩形，54 菜单同款先例）。
 * 标题仅即时进出 DOM，不落任何存储（ADR-0002）。 */
async function onAppClick(e: TaskbarLeftViewEntry, inOverflow: boolean): Promise<void> {
  window.deck.host.notify('taskbar-app-action', { exe: e.exe })
  const r = await dispatchAppClick(window.deck.bridge, e.exe)
  window.deck.host.notify('taskbar-app-result', {
    exe: e.exe,
    action: r.action,
    ok: r.ok,
    ...(r.error ? { error: r.error } : {}),
  })
  windowList = r.ok && r.action === 'window-list' && r.windows?.length
    ? { exe: e.exe, windows: r.windows }
    : null
  if (inOverflow) overflowOpen = false
  if (current) render(current)
}

/** 拖拽接线（工单57）：拖到某个条目上 = 落该条目之前（亮条指示）；拖到组内空白 =
 * 落可编辑段末尾（before=null）。跨组同款：中→左升手钉、左→中解除手钉回推荐池。
 * 落点裁决与落盘在内核（taskbar/drag-drop），渲染层只负责源记录与落点反馈。 */
function makeDraggable(el: HTMLElement, group: TaskbarDragGroup, id: string): void {
  el.draggable = true
  el.addEventListener('dragstart', (ev) => {
    dragSource = { group, id }
    el.classList.add('dragging')
    window.deck.host.notify('taskbar-drag-start', { group, id })
    if (ev.dataTransfer) {
      ev.dataTransfer.effectAllowed = 'move'
      ev.dataTransfer.setData('text/plain', id)
    }
  })
  el.addEventListener('dragend', () => {
    dragSource = null
    el.classList.remove('dragging')
    document.querySelectorAll('.tb-drop-before').forEach((n) => n.classList.remove('tb-drop-before'))
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

/** 落位一次拖拽：同组换位与跨组语义同一道分发，落点 before 恒为条目身份 */
async function onDrop(src: { group: TaskbarDragGroup; id: string }, to: TaskbarDragGroup, before: string | null): Promise<void> {
  window.deck.host.notify('taskbar-drag-drop', { from: src.group, to, id: src.id, before })
  const r = await dispatchTaskbarDragDrop(window.deck.bridge, { from: src.group, to, id: src.id, before })
  window.deck.host.notify('taskbar-drag-result', { ok: r.ok, ...(r.error ? { error: r.error } : {}) })
  dragSource = null
}

/** 组容器落尾（拖到组内空白处）：before = null = 可编辑段末尾 */
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

/** 左组图标元素（栏内与溢出浮层同一构建路径——同 .tb-app 形态、同 data-exe 挂点、
 * 同点击分发；工单53 的全交互在同一挂点上扩展后两边自然一致）。inOverflow = 点在浮层
 * 里：分发后收层（Win11 溢出浮层同款——点完即收）。 */
function makeAppEl(e: TaskbarLeftViewEntry, inOverflow: boolean): HTMLElement {
  const el = document.createElement('div')
  el.className = e.running ? 'tb-app running' : 'tb-app'
  el.dataset.exe = e.exe // 交互挂点（点击/右键按 exe 身份分发）
  el.title = e.tooltip // 窗口标题 tooltip：仅即时显示，渲染层不持久化
  const img = document.createElement('img')
  img.draggable = false // 手钉拖拽的宿主是 .tb-app 本身：图标默认可拖会把手势截成原生图片拖拽
  img.dataset.iconKey = e.iconKey ?? ''
  img.alt = e.label
  el.appendChild(img)
  applyIcon(img, e.iconKey)
  if (e.pinned) makeDraggable(el, 'left', e.exe) // 仅手钉可拖（内核只接受手钉段内换位）
  el.addEventListener('click', () => { void onAppClick(e, inOverflow) })
  el.addEventListener('auxclick', (ev) => {
    if (ev.button !== 1) return
    ev.preventDefault() // 中键开新实例：Win11 任务栏同款
    window.deck.host.notify('taskbar-app-new-instance', { exe: e.exe })
    void dispatchAppNewInstance(window.deck.bridge, e.exe)
    if (inOverflow) {
      overflowOpen = false
      if (current) render(current)
    }
  })
  el.addEventListener('contextmenu', (ev) => {
    ev.preventDefault()
    ev.stopPropagation() // 不让冒泡到 pill 的系统按钮菜单（工单54）
    windowList = null
    appMenu = { exe: e.exe, rows: taskbarAppMenuRows(e) }
    if (current) render(current)
  })
  return el
}

/** 左组渲染（工单52/58）：手钉+运行中合并条目按容量拆分——栏内满员即出 ⋯ 钮，
 * 浮层开着时尾部条目横排进 pill（条带窗只有 48px 高，竖排浮层出不了窗口矩形，
 * 54 右键菜单同款先例）；数量回落浮层自动收、图标回栏。空组整组不渲染（display:none） */
function renderLeft(entries: TaskbarLeftViewEntry[]): void {
  pillLeft.textContent = ''
  pillLeft.style.display = entries.length ? '' : 'none'
  if (!entries.length) {
    overflowOpen = false
    return
  }
  const { bar, overflow } = splitLeftOverflow(entries, leftSlots())
  if (!overflow.length) overflowOpen = false // 数量回落自动收层（图标全部回栏）
  for (const e of bar) pillLeft.appendChild(makeAppEl(e, false))
  if (overflow.length) {
    const toggle = document.createElement('div')
    toggle.className = 'tb-overflow'
    toggle.textContent = '⋯'
    toggle.title = `更多应用（${overflow.length}）`
    toggle.addEventListener('click', () => {
      overflowOpen = !overflowOpen
      if (current) render(current)
    })
    pillLeft.appendChild(toggle)
    if (overflowOpen) {
      const sep = document.createElement('div')
      sep.className = 'tb-left-sep'
      pillLeft.appendChild(sep)
      for (const e of overflow) pillLeft.appendChild(makeAppEl(e, true))
    }
  }
}

function render(state: TaskbarState): void {
  current = state
  const vm = taskbarViewModel(state)
  pill.hidden = !vm.visible
  pill.textContent = ''
  if (!vm.visible) {
    closeMenu()
    renderLeft(vm.left) // 中组不渲染 ≠ 左组不渲染（两按钮全隐藏且无推荐的边界）
    declareHotZones(state) // 中组不渲染：热区只留左组/右组/细条（declareHotZones 内按 vm.visible 裁决）
    notifyGeometry()
    return
  }
  // 中组（工单54 边界条件：两按钮全隐藏且无推荐 → 整组不渲染，只剩左右两组）
  if (vm.visible) {
    for (const b of vm.buttons) {
      const el = document.createElement('div')
      el.className = 'tb-btn'
      el.dataset.id = b.id
      el.textContent = b.label
      el.addEventListener('click', () => {
        window.deck.host.notify('taskbar-action', { action: b.action })
        void dispatchTaskbarButton(window.deck.bridge, b.id)
          .then((r) => window.deck.host.notify('taskbar-action-result', { action: r.action, ok: r.ok, ...(r.error ? { error: r.error } : {}) }))
      })
      pill.appendChild(el)
    }
    for (const rec of vm.recommendations) {
      const el = document.createElement('div')
      el.className = 'tb-rec'
      el.dataset.name = rec.name
      el.textContent = rec.display
      makeDraggable(el, 'mid', rec.name) // 推荐位可拖：组内换位 / 拖左组升手钉
      pill.appendChild(el)
    }
    if (menuOpen) {
      const sep = document.createElement('div')
      sep.className = 'tb-menu-sep'
      pill.appendChild(sep)
      for (const row of vm.menu) {
        const el = document.createElement('div')
        el.className = 'tb-menu-item'
        el.dataset.id = row.id
        el.textContent = row.label
        el.addEventListener('click', (e) => {
          e.stopPropagation()
          window.deck.host.notify('taskbar-menu-action', { id: row.id, hidden: !row.hidden })
          // 回推的 taskbar/changed 驱动重渲收层；回执只为存证对齐
          void dispatchTaskbarVisibility(window.deck.bridge, row.id, !row.hidden)
            .then((s) => window.deck.host.notify('taskbar-menu-result', { id: row.id, hiddenButtons: s?.hiddenButtons ?? null }))
        })
        pill.appendChild(el)
      }
    }
  } else {
    closeMenu()
  }
  if (appMenu) {
    const sep = document.createElement('div')
    sep.className = 'tb-menu-sep'
    pill.appendChild(sep)
    for (const row of appMenu.rows) {
      const el = document.createElement('div')
      el.className = 'tb-menu-item'
      el.dataset.action = row.action
      el.textContent = row.label
      el.addEventListener('click', (ev) => {
        ev.stopPropagation()
        const exe = appMenu?.exe ?? ''
        window.deck.host.notify('taskbar-app-menu-action', { exe, action: row.action })
        // 回推的 taskbar/changed 驱动重渲收层（手钉变更即刻反映在左组）
        void dispatchAppMenuAction(window.deck.bridge, exe, row.action)
        appMenu = null
        if (current) render(current)
      })
      pill.appendChild(el)
    }
  }
  if (windowList) {
    const sep = document.createElement('div')
    sep.className = 'tb-menu-sep'
    pill.appendChild(sep)
    for (const w of windowList.windows) {
      const el = document.createElement('div')
      el.className = 'tb-win-item'
      el.dataset.hwnd = String(w.hwnd)
      el.textContent = w.title || '（无标题窗口）'
      el.addEventListener('click', (ev) => {
        ev.stopPropagation()
        window.deck.host.notify('taskbar-window-pick', { exe: windowList?.exe ?? '', hwnd: w.hwnd })
        void dispatchActivateWindow(window.deck.bridge, w.hwnd)
        windowList = null
        if (current) render(current)
      })
      pill.appendChild(el)
    }
  }
  renderLeft(vm.left) // 中组内容先行：左组容量按中组 pill 的当前矩形裁决溢出
  declareHotZones(current)
  // 右组（工单55）：硬件摘要 →（托盘位 #56 占位）→ 音量 → 时钟
  rightPill.textContent = ''
  if (state.enabled) {
    const summary = renderSummary(vm.metrics, latestStatus?.hardware ?? null)
    if (summary) rightPill.appendChild(summary)
    // 托盘入栏（工单56）：系统托盘图标平铺在摘要与音量格之间；名单空即整段不渲染
    for (const entry of vm.tray) rightPill.appendChild(makeTrayEl(entry))
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
  declareHotZones(state)
  notifyGeometry()
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
    if (current) render(current)
  }
})

function boot(): void {
  makeGroupDropTarget(pillLeft, 'left') // 拖到左组空白 = 落手钉段末尾
  makeGroupDropTarget(pill, 'mid') // 拖到中组空白 = 落推荐位末尾
  // 右键 = 系统按钮显隐菜单（工单54 自绘最小菜单；应用图标右键菜单是 #53 的领域，不依赖它）
  pill.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    if (menuOpen) closeMenu()
    else {
      menuOpen = true
      // 无焦点窗收不到 Esc、窗外点击穿透不可达——兜底自动收层
      menuTimer = setTimeout(() => {
        closeMenu()
        if (current) render(current)
      }, 8000)
    }
    if (current) render(current)
  })
  // 点 pill 空白（非按钮/推荐位/菜单项）收菜单
  pill.addEventListener('click', (e) => {
    if (!menuOpen) return
    if ((e.target as HTMLElement).closest('.tb-btn, .tb-rec, .tb-menu-item')) return
    closeMenu()
    if (current) render(current)
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
    const m = measure()
    window.deck.host.notify('taskbar-ready', {
      enabled: state.enabled, pill: m.pill, buttons: m.buttons, recommendations: m.recommendations,
      leftPill: m.leftPill, apps: m.apps, overflow: m.overflow,
      rightPill: m.rightPill, rightCells: m.rightCells, trayIcons: m.trayIcons, sliver: m.sliver,
    })
    window.deck.bridge.on('taskbar/changed', (next) => {
      closeMenu() // 状态回推即收菜单（点菜成功的收层路径）
      render(next)
    })
    // 硬件摘要 1Hz 数据帧（工单55）：勾选变更后按最近值立即填字，不等下一拍
    window.deck.bridge.on('taskbar/status', (status) => applyStatus(status))
    // 几何重排重渲染并重声明热区（工单58/55）：主进程在 display-metrics-changed 时
    // setBounds 重排条带（换分辨率/换主屏），pill 坐标随客户区宽度变化——旧热区矩形会落空
    window.addEventListener('resize', () => {
      if (!current) return
      render(current)
      declareHotZones(current)
      notifyGeometry()
    })
  })()
}

boot()
