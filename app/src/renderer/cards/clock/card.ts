// 时钟卡（工单10 内置桌面组件 1/5）：时间 + 日期，纯自快照时钟推导，无内核调用。
// 观感与改造前一致：卡片几何与配色仍由面板样式表（.card / #clock-card）承担，
// 本插件只负责内容——内置组件与面板同源，共用面板的设计系统是既有纪律。
// 工单477 束③（时钟去秒，用户拍板）：呈现只显时分，且同值不重写 DOM——
// 1Hz 快照推送期间时钟卡不再产生任何文本变化（无秒级重绘），分钟沿才落笔一次。
import type { PluginApi, PluginHost } from '../../plugins.js'
import { hhmmOf } from '../../clock-text.js'

const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

let rendered = 0
let clicks = 0
let time: HTMLElement
let date: HTMLElement

/** 同值不落笔（去重绘的核心一守）：呈现文本没变就不碰 DOM */
function writeIfChanged(el: HTMLElement, text: string): void {
  if (el.textContent === text) return
  el.textContent = text
}

function render(host: PluginHost): void {
  const clock = host.view.clock
  if (!clock || !time) return
  const d = new Date(clock.epochMs)
  writeIfChanged(time, hhmmOf(clock.epochMs))
  const dateText = `${d.getFullYear()}-${host.util.pad(d.getMonth() + 1)}-${host.util.pad(d.getDate())} ${WEEKDAYS[d.getDay()]}`
  writeIfChanged(date, dateText)
  rendered += 1
  if (rendered <= 3) host.notify('clock-rendered', { n: rendered, epochMs: clock.epochMs })
}

export default {
  mount(host: PluginHost): void {
    const card = document.createElement('div')
    card.className = 'card'
    card.id = 'clock-card'
    card.innerHTML = '<div id="clock-time">--:--</div><div id="clock-date">---- -- --</div>'
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
