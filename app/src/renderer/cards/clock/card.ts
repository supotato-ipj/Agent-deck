// 时钟卡（工单10 内置桌面组件 1/5）：时间 + 日期，纯自快照时钟推导，无内核调用。
// 观感与改造前一致：卡片几何与配色仍由面板样式表（.card / #clock-card）承担，
// 本插件只负责内容——内置组件与面板同源，共用面板的设计系统是既有纪律。
import type { PluginApi, PluginHost } from '../../plugins.js'

const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

let rendered = 0
let clicks = 0
let time: HTMLElement
let date: HTMLElement

function render(host: PluginHost): void {
  const clock = host.view.clock
  if (!clock || !time) return
  const pad = host.util.pad
  const d = new Date(clock.epochMs)
  time.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  date.textContent = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${WEEKDAYS[d.getDay()]}`
  rendered += 1
  if (rendered <= 3) host.notify('clock-rendered', { n: rendered, epochMs: clock.epochMs })
}

export default {
  mount(host: PluginHost): void {
    const card = document.createElement('div')
    card.className = 'card'
    card.id = 'clock-card'
    card.innerHTML = '<div id="clock-time">--:--:--</div><div id="clock-date">---- -- --</div>'
    // 点击存证沿用改造前的事件名与载荷（电池按它证面板仍可交互）
    card.addEventListener('click', () => {
      clicks += 1
      host.notify('clock-card-clicked', { count: clicks })
    })
    host.el.appendChild(card)
    time = card.querySelector('#clock-time') as HTMLElement
    date = card.querySelector('#clock-date') as HTMLElement
    rendered = 0
    clicks = 0
    render(host)
  },

  update(host: PluginHost): void {
    render(host)
  },
} satisfies PluginApi
