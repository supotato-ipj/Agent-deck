// 任务栏条带渲染入口（工单49/54）：状态经 taskbar/get-state 拉取 + taskbar/changed 订阅；
// pill 矩形（含各按钮/推荐位矩形）经宿主面声明为热区并落存证——验收电池据此取点击坐标。
// 中组视图模型是纯函数（taskbar-view.ts）；本文件只是它的 DOM 呈现端 + 右键菜单开合。
import { dispatchTaskbarButton, dispatchTaskbarVisibility, taskbarViewModel } from './taskbar-view.js'
import type { TaskbarState } from '../shared/contract'

const pill = document.getElementById('pill') as HTMLElement

/** 最近一次渲染的状态：几何重排（resize）时按它重声明热区 */
let current: TaskbarState | null = null
/** 系统按钮显隐菜单开合（工单54）：右键开、点菜/点 pill 空白/状态回推收 */
let menuOpen = false
let menuTimer: ReturnType<typeof setTimeout> | null = null

/** pill 与按钮/推荐位矩形（CSS px 相对客户区）：热区声明与验收存证共用同一份测量 */
function measure() {
  const pr = pill.getBoundingClientRect()
  const buttons = [...pill.querySelectorAll<HTMLElement>('.tb-btn')].map((el) => {
    const r = el.getBoundingClientRect()
    return { id: el.dataset.id ?? '', x: r.x, y: r.y, w: r.width, h: r.height }
  })
  const recommendations = [...pill.querySelectorAll<HTMLElement>('.tb-rec')].map((el) => {
    const r = el.getBoundingClientRect()
    return { name: el.dataset.name ?? '', x: r.x, y: r.y, w: r.width, h: r.height }
  })
  return { pill: { x: pr.x, y: pr.y, w: pr.width, h: pr.height }, buttons, recommendations }
}

/** 热区声明：中组不渲染（禁用/全隐藏且无推荐）即清空——条带整幅恢复穿透 */
function declareHotZones(visible: boolean): void {
  if (!visible) {
    window.deck.host.setHotZones([])
    return
  }
  const { pill: p } = measure()
  window.deck.host.setHotZones([{ id: 'pill', ...p }])
}

function closeMenu(): void {
  if (menuTimer !== null) {
    clearTimeout(menuTimer)
    menuTimer = null
  }
  menuOpen = false
}

function render(state: TaskbarState): void {
  current = state
  const vm = taskbarViewModel(state)
  pill.hidden = !vm.visible
  pill.textContent = ''
  if (!vm.visible) {
    closeMenu()
    declareHotZones(false)
    return
  }
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
  declareHotZones(true)
}

function boot(): void {
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
    const state = await window.deck.bridge.invoke('taskbar/get-state', null)
    render(state)
    const m = measure()
    window.deck.host.notify('taskbar-ready', { enabled: state.enabled, pill: m.pill, buttons: m.buttons, recommendations: m.recommendations })
    window.deck.bridge.on('taskbar/changed', (next) => {
      closeMenu() // 状态回推即收菜单（点菜成功的收层路径）
      render(next)
    })
    // 几何重排重声明热区：主进程在 display-metrics-changed 时 setBounds 重排条带
    // （换分辨率/换主屏），pill 居中坐标随客户区宽度变化，旧热区矩形会落空
    window.addEventListener('resize', () => {
      if (current) declareHotZones(taskbarViewModel(current).visible)
    })
  })()
}

boot()
