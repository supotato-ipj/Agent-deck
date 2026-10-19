// 日历卡（工单99 内置桌面组件成包）：月历网格，纯自快照时钟段推导，无内核调用。
// 观感与改造前一致：卡片几何与配色仍由面板样式表（#calendar-card / #cal-grid / .day）承担，
// 本插件只建 DOM——结构照搬宿主页面原 513-517 行（时钟卡成包先例，工单10）。
// 月份网格换月才重绘（宿主 render 的 calendarMonth 语义平移进来，内部记 lastMonth）。
import type { PluginApi, PluginHost } from '../../plugins.js'

const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']

let title: HTMLElement
let grid: HTMLElement
let lastMonth = -1
let rendered = 0

function render(host: PluginHost): void {
  const clock = host.view.clock
  if (!clock || !grid) return
  const d = new Date(clock.epochMs)
  const month = d.getMonth()
  if (month === lastMonth) return // 未换月不重绘（既有行为：仅换月才重建网格）
  lastMonth = month
  const pad = host.util.pad
  title.textContent = `${d.getFullYear()}-${pad(month + 1)}`
  grid.textContent = ''
  for (const wd of WEEKDAYS) {
    const head = document.createElement('div')
    head.className = 'head'
    head.textContent = wd
    grid.appendChild(head)
  }
  const first = new Date(d.getFullYear(), month, 1)
  const lead = (first.getDay() + 6) % 7 // 周一为首列
  const daysInMonth = new Date(d.getFullYear(), month + 1, 0).getDate()
  for (let i = 0; i < lead; i++) {
    const blank = document.createElement('div')
    grid.appendChild(blank)
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const cell = document.createElement('div')
    cell.className = day === d.getDate() ? 'day today' : 'day'
    cell.textContent = String(day)
    grid.appendChild(cell)
  }
  // 挂载存证（时钟卡 clock-rendered 先例）：前 3 次重绘各报一条，载荷带足月网格
  // 抽验所需的推导结果（真机电池无 DOM 通道，按 epochMs 独立重算对照）。
  rendered += 1
  if (rendered <= 3) {
    host.notify('calendar-rendered', {
      n: rendered, epochMs: clock.epochMs, ym: title.textContent, lead, days: daysInMonth,
    })
  }
}

export default {
  mount(host: PluginHost): void {
    const card = document.createElement('div')
    card.className = 'card'
    card.id = 'calendar-card'
    card.innerHTML = '<h2>CALENDAR</h2><div id="cal-title">---- --</div><div id="cal-grid"></div>'
    host.el.appendChild(card)
    title = card.querySelector('#cal-title') as HTMLElement
    grid = card.querySelector('#cal-grid') as HTMLElement
    lastMonth = -1
    rendered = 0
    render(host)
  },

  update(host: PluginHost): void {
    render(host)
  },

  unmount(): void {
    // 宿主会移除容器；这里只清模块级状态，重挂（热插拔换代）从干净起点开始
    title = undefined as unknown as HTMLElement
    grid = undefined as unknown as HTMLElement
    lastMonth = -1
    rendered = 0
  },
} satisfies PluginApi
