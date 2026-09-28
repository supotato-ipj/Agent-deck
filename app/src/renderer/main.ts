// 面板渲染层（经典脚本，无模块语法——刻意的边界，见 02 注记）。
// 数据一律经桥接契约自内核而来（初始 snapshot + panel/changed 订阅）；
// 天气卡是唯一例外：纯前端直连 Open-Meteo（沿用 patched 壁纸先例），坐标经快照下发。
// 渲染层向宿主声明交互热区（各卡片矩形）；字体就绪后再声明一次，免字体换挡挪动矩形。

const TOOL_TAGS: Record<string, string> = { qoder: 'QD', kimicode: 'KC', kimiwork: 'KW', zcode: 'ZC', hermes: 'HM' }
const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
const CAL_WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
const WEATHER_REFRESH_MS = 10 * 60 * 1000
const WEATHER_CODES: Record<number, string> = {
  0: 'Clear', 1: 'Mainly Clear', 2: 'Partly Cloudy', 3: 'Cloudy',
  45: 'Foggy', 48: 'Rime Fog',
  51: 'Light Drizzle', 53: 'Drizzle', 55: 'Heavy Drizzle',
  56: 'Light Freezing Drizzle', 57: 'Freezing Drizzle',
  61: 'Light Rain', 63: 'Rain', 65: 'Heavy Rain',
  66: 'Light Freezing Rain', 67: 'Freezing Rain',
  71: 'Slight Snow', 73: 'Snow', 75: 'Heavy Snow', 77: 'Snow Grains',
  80: 'Light Showers', 81: 'Showers', 82: 'Heavy Showers',
  85: 'Light Snow Showers', 86: 'Snow Showers',
  95: 'Thunderstorm', 96: 'Light Thunderstorm With Hail', 99: 'Thunderstorm With Hail',
}

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T
}
function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0')
}
function pad3(n: number): string {
  return String(n).padStart(3, '0')
}
function pct(x: number | null | undefined): string {
  return x == null ? '---' : pad3(Math.round(x))
}
function kbps(x: number | undefined): string {
  return x == null ? '----' : x.toFixed(2).padStart(6, '0') + 'KB/s'
}
function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))
}

// ---- 存证上报（前 3 次渲染；验收电池断言数据到达与刷新） ----

function notify(type: string, payload?: Record<string, unknown>): void {
  window.deck.host.notify(type, payload)
}

// ---- 时钟卡 ----

const clockTime = el('clock-time')
const clockDate = el('clock-date')
let clockRendered = 0

function renderClock(epochMs: number): void {
  const d = new Date(epochMs)
  clockTime.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  clockDate.textContent =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${WEEKDAYS[d.getDay()]}`
  clockRendered += 1
  if (clockRendered <= 3) notify('clock-rendered', { n: clockRendered, epochMs })
}

// ---- 会话列表卡（最近活跃混排 + 两字母工具标签 + 工单09 会话块直达）----
// 点击会话块 → session/focus → 对应工具窗口置前，未运行则启动（内核决策，渲染层只发工具名）。
// 失败一律静默：面板不崩、不弹窗（会话块是轻交互，失败不该打断桌面）。

const sessionRows = el('session-rows')
const sessionStandby = el('sessions-standby')
const sessionCount = el('sessions-head-count')
let sessionsRendered = 0

function focusSessionBlock(tool: string, id: string): void {
  notify('session-focus-clicked', { tool, id })
  void window.deck.bridge.invoke('session/focus', { tool }).then(
    (r) => notify('session-focus-result', {
      tool, id, ok: Boolean(r && r.ok), action: String((r && r.action) || 'degraded'),
      error: (r && r.error) ? String(r.error) : null,
      hwnd: r && typeof r.hwnd === 'number' ? r.hwnd : null,
    }),
    (err: unknown) => notify('session-focus-failed', { tool, id, message: String(err) }),
  )
}

function renderSessions(sessions: SessionInfo[]): void {
  sessionRows.textContent = ''
  sessionStandby.style.display = sessions.length ? 'none' : 'block'
  sessionCount.textContent = pad3(sessions.length)
  for (const s of sessions.slice(0, 9)) {
    const row = document.createElement('div')
    row.className = 'srow'
    const tasks = s.tasks_done == null || s.tasks_total == null
      ? '' : `${pad3(s.tasks_done)}/${pad3(s.tasks_total)}`
    const state = String(s.state || 'IDLE')
    row.innerHTML =
      `<span class="tag">${esc(TOOL_TAGS[s.tool] || '??')}</span>` +
      `<span class="state ${esc(state.toLowerCase())}">${esc(state)}</span>` +
      `<span class="name">${esc(String(s.project || ''))}</span>` +
      `<span class="tasks">${esc(tasks)}</span>`
    row.title = '点击直达该工具窗口'
    row.dataset.tool = s.tool
    row.addEventListener('click', () => focusSessionBlock(s.tool, s.id))
    sessionRows.appendChild(row)
  }
  sessionsRendered += 1
  if (sessionsRendered <= 3) {
    // 存证：前 3 拍带各行矩形（电池按 tool/project 定位点击落点，desktop-rendered rects 同法）
    const rows = Array.from(sessionRows.children).map((child) => {
      const node = child as HTMLElement
      const r = node.getBoundingClientRect()
      const name = node.querySelector('.name')
      return {
        tool: node.dataset.tool || '',
        project: name ? String(name.textContent || '') : '',
        rect: { x: r.left, y: r.top, w: r.width, h: r.height },
      }
    })
    notify('sessions-rendered', { n: sessionsRendered, count: sessions.length, rows })
  }
}

// ---- Qoder 状态卡 ----

const qoderBody = el('qoder-body')
const qoderTask = el('qoder-task')
const qoderFill = el('qoder-progress-fill')
let qoderRendered = 0

function renderQoder(q: PanelSnapshot['qoder']): void {
  const s = q.session
  if (!s) {
    qoderBody.innerHTML = `PROJECT <span class="bright">----</span> · ACTIVE <span class="bright">${pad3(q.active_sessions)}</span>`
    qoderTask.textContent = 'NO CURRENT TASK'
    qoderFill.style.width = '0%'
  } else {
    const state = s.running ? 'RUNNING' : 'STANDBY'
    qoderBody.innerHTML =
      `PROJECT <span class="bright">${esc(s.project || '----')}</span>` +
      ` · <span class="bright">${state}</span>` +
      ` · TASKS <span class="bright">${pad3(s.tasks_done)}/${pad3(s.tasks_total)}</span>` +
      ` · ACTIVE <span class="bright">${pad3(q.active_sessions)}</span>`
    qoderTask.textContent = s.current_task ? `> ${s.current_task}` : '> NO CURRENT TASK'
    qoderFill.style.width = s.tasks_total > 0 ? `${Math.round((s.tasks_done / s.tasks_total) * 100)}%` : '0%'
  }
  qoderRendered += 1
  if (qoderRendered <= 3) notify('qoder-rendered', { n: qoderRendered, active: q.active_sessions })
}

// ---- 硬件指标卡（两行定长仪表 + 300 点历史曲线） ----

const hwLine1 = el('hw-line1')
const hwLine2 = el('hw-line2')
const sparks: Record<string, HTMLCanvasElement> = {
  cpu: el<HTMLCanvasElement>('spark-cpu'),
  gpu: el<HTMLCanvasElement>('spark-gpu'),
  dl: el<HTMLCanvasElement>('spark-dl'),
  up: el<HTMLCanvasElement>('spark-up'),
}
let hardwareRendered = 0

function drawSpark(canvas: HTMLCanvasElement, series: Array<number | null>): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (w === 0 || h === 0) return
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  const points = series.filter((v): v is number => v != null)
  if (points.length < 2) return
  const max = Math.max(...points, 1)
  const stepX = w / Math.max(1, series.length - 1)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)'
  ctx.lineWidth = 1
  ctx.beginPath()
  let drawing = false
  series.forEach((v, i) => {
    if (v == null) {
      drawing = false
      return
    }
    const x = i * stepX
    const y = h - 2 - (v / max) * (h - 4)
    if (!drawing) {
      ctx.moveTo(x, y)
      drawing = true
    } else {
      ctx.lineTo(x, y)
    }
  })
  ctx.stroke()
}

function renderHardware(hw: PanelSnapshot['hardware']): void {
  const g = hw.gauges
  hwLine1.innerHTML =
    `CPU <span class="v">${pct(g.cpu)}%</span> · GPU <span class="v">${pct(g.gpu_usage)}% ${pct(g.gpu_temp)}&deg;C</span>` +
    ` · VRAM <span class="v">${pct(g.vram_usage)}%</span>`
  hwLine2.innerHTML =
    `RAM <span class="v">${pct(g.memory)}% ${esc(g.memory_gb)}</span>` +
    ` · DL <span class="v">${kbps(g.download_speed)}</span> · UP <span class="v">${kbps(g.upload_speed)}</span>`
  drawSpark(sparks.cpu, hw.history.cpu)
  drawSpark(sparks.gpu, hw.history.gpu)
  drawSpark(sparks.dl, hw.history.dl)
  drawSpark(sparks.up, hw.history.up)
  hardwareRendered += 1
  if (hardwareRendered <= 3) notify('hardware-rendered', {
    n: hardwareRendered,
    cpu: g.cpu,
    historyLen: hw.history.cpu.length,
  })
  // 历史曲线滚动窗口存证：一枪式，累计 ≥5 点即上报（电池等待此事件断言曲线在积累）
  if (!historyLiveNotified && hw.history.cpu.length >= 5) {
    historyLiveNotified = true
    notify('history-live', { len: hw.history.cpu.length })
  }
}

let historyLiveNotified = false

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

// ---- 天气卡（纯前端取数，Open-Meteo 先例平移） ----

const weatherTemp = el('weather-temp')
const weatherDesc = el('weather-desc')
const weatherDetail = el('weather-detail')
let weatherLocation: { latitude: number; longitude: number } | null = null
let weatherFetching = false

async function fetchWeather(): Promise<void> {
  if (!weatherLocation || weatherFetching) return
  weatherFetching = true
  const { latitude, longitude } = weatherLocation
  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${latitude}&longitude=${longitude}`
    + '&current=temperature_2m,precipitation,wind_speed_10m,weather_code,relative_humidity_2m'
    + '&timezone=auto'
  const abort = new AbortController()
  const abortTimer = setTimeout(() => { abort.abort() }, 10000)
  try {
    const r = await fetch(url, { cache: 'no-store', signal: abort.signal })
    if (!r.ok) throw new Error(String(r.status))
    const data = await r.json()
    const c = data.current
    if (!c) throw new Error('no current block')
    const temp = Math.round(c.temperature_2m)
    weatherTemp.innerHTML = `${temp}&deg;C`
    weatherDesc.textContent = WEATHER_CODES[c.weather_code] ?? `CODE ${c.weather_code}`
    weatherDetail.textContent =
      `WIND ${Number(c.wind_speed_10m).toFixed(1)} M/S · RH ${Math.round(c.relative_humidity_2m)}%`
      + ` · PREC ${Number(c.precipitation).toFixed(1)} MM`
    notify('weather-rendered', { code: c.weather_code, temp })
  } catch (err) {
    weatherDesc.textContent = 'FETCH FAILED'
    notify('weather-error', { message: String(err) })
  } finally {
    clearTimeout(abortTimer)
    weatherFetching = false
  }
}

// ---- 桌面承载（工单05 扫描/图标/启动 + 工单06 编排/摆位）：dock 应用区 + 文档区分组列 ----
// 条目池随 1Hz 快照下发，按指纹 diff——集合未变不重建 DOM；图标经 desktop/icon
// 懒取（dataURL 本地缓存，键含 mtime，lnk 指向变更自然换图标）。
// 工单06 起 dock 按 plan.dock 序铺条（手钉→摆位→推荐），文档区按 plan.docs 的
// 组序/组内序铺分组列；拖拽摆位经 desktop/move 落内核并持久化。

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
let selectedName: string | null = null
let layoutApplied = ''

function itemGlyph(item: DesktopItem): string {
  return item.kind === 'folder' ? 'DIR' : item.kind === 'url' ? 'URL' : 'DOC'
}

function markSelection(): void {
  for (const d of document.querySelectorAll<HTMLElement>('.ditem')) {
    d.classList.toggle('sel', d.dataset.name === selectedName)
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
  // 单击选中（启动前确认目标）；双击启动（肌肉记忆原样保留）；拖拽摆位（工单06）
  d.addEventListener('click', () => {
    if (dragState.suppressed) return // 拖拽结束的那一下点击不算选中
    selectedName = item.name
    markSelection()
    notify('desktop-selected', { name: item.name })
  })
  d.addEventListener('dblclick', () => {
    if (dragState.suppressed) return
    notify('desktop-launch-clicked', { name: item.name, path: item.path })
    void window.deck.bridge.invoke('desktop/launch', { path: item.path }).then(
      (r) => notify(r.ok ? 'desktop-launched' : 'desktop-launch-rejected', {
        name: item.name, ok: r.ok, error: r.error ?? null,
      }),
      (err: unknown) => notify('desktop-launch-failed', { name: item.name, message: String(err) }),
    )
  })
  wireDrag(d, item)
  return d
}

// ---- 拖拽摆位（工单06）：指针事件自实现（非 HTML5 DnD——合成输入驱不动 OLE 拖拽，
// 且自绘世界要的是「排在谁前面」语义）。拖拽期间声明全窗热区：跨分区拖动会路过
// 非热区空档，若不临时全窗接收，中途面板转穿透、pointer 流即断（拖拽死在中途）。

interface DragState {
  name: string | null
  fromZone: string | null
  startX: number
  startY: number
  active: boolean
  suppressed: boolean
  ghost: HTMLElement | null
  target: { zone: 'app' | 'doc'; beforeName: string | null } | null
}

const dragState: DragState = {
  name: null, fromZone: null, startX: 0, startY: 0, active: false, suppressed: false, ghost: null, target: null,
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

function itemUnder(excludeName: string | null): string | null {
  const hit = document.elementFromPoint(lastPointer.x, lastPointer.y)
  const item = hit && (hit as HTMLElement).closest ? (hit as HTMLElement).closest<HTMLElement>('.ditem') : null
  if (!item || !item.dataset.name) return null
  if (excludeName && item.dataset.name === excludeName) return null
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
      dragState.target = { zone, beforeName: itemUnder(item.name) }
    }
    markDropTarget()
  })
  const finish = () => {
    if (dragState.name !== item.name) return
    const { active, target, fromZone } = dragState
    const name = dragState.name
    endDrag()
    if (!active || !target) return
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

function nextSiblingName(name: string): string | null {
  const node = document.querySelector<HTMLElement>(`.ditem[data-name="${CSS.escape(name)}"]`)
  let n = node ? node.nextElementSibling : null
  while (n && !(n as HTMLElement).classList.contains('ditem')) n = n.nextElementSibling
  return n ? (n as HTMLElement).dataset.name ?? null : null
}

function beginGhost(item: DesktopItem): void {
  const source = document.querySelector<HTMLElement>(`.ditem[data-name="${CSS.escape(item.name)}"]`)
  if (source) source.classList.add('dragging')
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
  dragState.active = false
  dragState.target = null
  declareHotZones()
  // suppressed 在下一拍放开：pointerup 后浏览器还会补发一次 click（拖拽尾-click 不算选中）
  setTimeout(() => { dragState.suppressed = false }, 0)
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
  if (state.fingerprint === desktopFingerprintSeen) return
  desktopFingerprintSeen = state.fingerprint
  const byName = new Map(state.items.map((i) => [i.name, i]))
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
  if (selectedName && !state.items.some((i) => i.name === selectedName)) selectedName = null
  markSelection()
  declareHotZones()
  desktopRenderCount += 1
  // 存证：条目集合 + 编排序 + 各条目矩形（电池按名定位探针落点/拖放源坐标）
  notify('desktop-rendered', {
    n: desktopRenderCount,
    fingerprint: state.fingerprint,
    apps: dockNames.length,
    docs: state.plan.docs.length,
    names: state.items.map((i) => i.name),
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

type SettingsCloseReason = 'esc' | 'blur' | 'toggle'

function openSettings(): void {
  if (settingsOpen) return
  settingsOpen = true
  settingsCard.style.display = 'block'
  settingsCard.focus()
  // 滑杆矩形随开层存证（电池按它定位拖拽落点，desktop-rendered rects 同法）
  const sr = opacitySlider.getBoundingClientRect()
  notify('settings-opened', {
    slider: { x: sr.left, y: sr.top, w: sr.width, h: sr.height },
    value: appliedOpacity == null ? null : Math.round(appliedOpacity * 100),
  })
  declareHotZones()
}

function closeSettings(reason: SettingsCloseReason): void {
  if (!settingsOpen) return
  settingsOpen = false
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
  // 滑杆要收焦点（拖拽中渲染层不抢滑杆位）；其余区域保焦点，点击不触发失焦关层
  if (e.target !== opacitySlider) e.preventDefault()
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

settingsReset.addEventListener('click', () => {
  notify('desktop-reset-clicked', {})
  void window.deck.bridge.invoke('desktop/reset-layout', null).then(
    (r) => notify('desktop-layout-reset', { ok: r.ok, cleared: r.cleared }),
    (err: unknown) => notify('desktop-reset-failed', { message: String(err) }),
  )
})

window.deck.bridge.on('settings/changed', (s) => applyCardAlpha(s.cardOpacity))

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

// ---- 总渲染（快照到达即刷新全部卡片） ----

function render(snap: PanelSnapshot): void {
  renderClock(snap.clock.epochMs)
  renderSessions(snap.sessions)
  renderQoder(snap.qoder)
  renderHardware(snap.hardware)
  renderDesktop(snap.desktop, snap.layout)
  renderSettings(snap.settings)
  const month = new Date(snap.clock.epochMs).getMonth()
  if (month !== calendarMonth) {
    calendarMonth = month
    renderCalendar(snap.clock.epochMs)
  }
  const loc = snap.weather
  const moved = !weatherLocation
    || weatherLocation.latitude !== loc.latitude || weatherLocation.longitude !== loc.longitude
  weatherLocation = { latitude: loc.latitude, longitude: loc.longitude }
  if (moved) void fetchWeather()
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
let clickCount = 0

el('clock-card').addEventListener('click', () => {
  clickCount += 1
  notify('clock-card-clicked', { count: clickCount })
})

setInterval(() => { void fetchWeather() }, WEATHER_REFRESH_MS)

void window.deck.bridge.invoke('panel/snapshot', null).then(render, (err: unknown) => {
  notify('snapshot-error', { message: String(err) })
})
window.deck.bridge.on('panel/changed', render)

declareHotZones()
if (document.fonts) document.fonts.ready.then(declareHotZones)
