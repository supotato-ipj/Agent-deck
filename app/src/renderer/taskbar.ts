// 任务栏条带渲染入口（工单49）：状态经 taskbar/get-state 拉取 + taskbar/changed 订阅；
// pill 矩形（含各按钮矩形）经宿主面声明为热区并落存证——验收电池据此取点击坐标。
import { dispatchTaskbarButton, taskbarViewModel } from './taskbar-view.js'
import type { TaskbarState } from '../shared/contract'

const pill = document.getElementById('pill') as HTMLElement

/** 最近一次渲染的状态：几何重排（resize）时按它重声明热区 */
let current: TaskbarState | null = null

/** pill 与按钮矩形（CSS px 相对客户区）：热区声明与验收存证共用同一份测量 */
function measure() {
  const pr = pill.getBoundingClientRect()
  const buttons = [...pill.querySelectorAll<HTMLElement>('.tb-btn')].map((el) => {
    const r = el.getBoundingClientRect()
    return { id: el.dataset.id ?? '', x: r.x, y: r.y, w: r.width, h: r.height }
  })
  return { pill: { x: pr.x, y: pr.y, w: pr.width, h: pr.height }, buttons }
}

function declareHotZones(enabled: boolean): void {
  if (!enabled) {
    window.deck.host.setHotZones([])
    return
  }
  const { pill: p } = measure()
  window.deck.host.setHotZones([{ id: 'pill', ...p }])
}

function render(state: TaskbarState): void {
  current = state
  const { buttons } = taskbarViewModel(state)
  pill.textContent = ''
  for (const b of buttons) {
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
  declareHotZones(state.enabled)
}

async function boot(): Promise<void> {
  const state = await window.deck.bridge.invoke('taskbar/get-state', null)
  render(state)
  const m = measure()
  window.deck.host.notify('taskbar-ready', { enabled: state.enabled, pill: m.pill, buttons: m.buttons })
  window.deck.bridge.on('taskbar/changed', (next) => render(next))
  // 几何重排重声明热区：主进程在 display-metrics-changed 时 setBounds 重排条带
  // （换分辨率/换主屏），pill 居中坐标随客户区宽度变化，旧热区矩形会落空
  window.addEventListener('resize', () => {
    if (current) declareHotZones(current.enabled)
  })
}

void boot()
