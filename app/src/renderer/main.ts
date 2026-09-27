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

// ---- 总渲染（快照到达即刷新全部卡片） ----

function render(snap: PanelSnapshot): void {
  renderClock(snap.clock.epochMs)
  renderSessions(snap.sessions)
  renderQoder(snap.qoder)
  renderHardware(snap.hardware)
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

// ---- 热区声明（全部卡片） ----

function declareHotZones(): void {
  const rects = Array.from(document.querySelectorAll<HTMLElement>('.card')).map((card) => {
    const r = card.getBoundingClientRect()
    return { id: card.id, x: r.left, y: r.top, w: r.width, h: r.height }
  })
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
