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

// ---- 会话列表卡（最近活跃混排 + 两字母工具标签） ----

const sessionRows = el('session-rows')
const sessionStandby = el('sessions-standby')
const sessionCount = el('sessions-head-count')
let sessionsRendered = 0

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
    sessionRows.appendChild(row)
  }
  sessionsRendered += 1
  if (sessionsRendered <= 3) notify('sessions-rendered', { n: sessionsRendered, count: sessions.length })
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
const resetBtn = el('reset-layout')
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

// ---- 恢复出厂布局（工单06）：一键清除摆位，回归类 + 频次推荐的出厂编排 ----

resetBtn.addEventListener('click', () => {
  notify('desktop-reset-clicked', {})
  void window.deck.bridge.invoke('desktop/reset-layout', null).then(
    (r) => notify('desktop-layout-reset', { ok: r.ok, cleared: r.cleared }),
    (err: unknown) => notify('desktop-reset-failed', { message: String(err) }),
  )
})

// ---- 总渲染（快照到达即刷新全部卡片） ----

function render(snap: PanelSnapshot): void {
  renderClock(snap.clock.epochMs)
  renderSessions(snap.sessions)
  renderQoder(snap.qoder)
  renderHardware(snap.hardware)
  renderDesktop(snap.desktop, snap.layout)
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
  const rb = resetBtn.getBoundingClientRect()
  if (rb.width > 0) rects.push({ id: 'reset-layout', x: rb.left, y: rb.top, w: rb.width, h: rb.height })
  window.deck.host.setHotZones(rects)
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
