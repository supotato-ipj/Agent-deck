// 时钟卡：02 的第一个桌面组件。
// 数据经桥接契约自内核而来（初始 snapshot + panel/changed 订阅），
// 渲染层向宿主声明交互热区；字体就绪后再声明一次，免字体换挡挪动矩形。
// 注意：本文件经 tsc 产出为无 import/export 的经典脚本（类型经 global.d.ts 别名），
// 一旦引入运行时模块语法，经典脚本加载即报 SyntaxError——是刻意的边界。

const card = document.getElementById('clock-card') as HTMLElement
const timeEl = document.getElementById('clock-time') as HTMLElement
const dateEl = document.getElementById('clock-date') as HTMLElement

let clickCount = 0

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

let rendered = 0

function render(snap: PanelSnapshot): void {
  const d = new Date(snap.clock.epochMs)
  timeEl.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  dateEl.textContent =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${WEEKDAYS[d.getDay()]}`
  // 存证：前三次渲染上报内核数据到达（验收电池断言走时推送用）
  rendered += 1
  if (rendered <= 3) window.deck.host.notify('clock-rendered', { n: rendered, epochMs: snap.clock.epochMs })
}

function declareHotZones(): void {
  const r = card.getBoundingClientRect()
  window.deck.host.setHotZones([{ id: 'clock-card', x: r.left, y: r.top, w: r.width, h: r.height }])
}

card.addEventListener('click', () => {
  clickCount += 1
  window.deck.host.notify('clock-card-clicked', { count: clickCount })
})

void window.deck.bridge.invoke('panel/snapshot', null).then(render, (err: unknown) => {
  window.deck.host.notify('clock-snapshot-error', { message: String(err) })
})
window.deck.bridge.on('panel/changed', render)

declareHotZones()
if (document.fonts) document.fonts.ready.then(declareHotZones)
