// 任务栏条带渲染入口（工单49/54/55）：状态经 taskbar/get-state 拉取 + taskbar/changed 订阅；
// 右组 1Hz 数据帧（时钟 + 硬件仪表，工单55）经 taskbar/status 订阅。各 pill、按钮/推荐位
// 矩形与细条矩形经宿主面声明为热区并落存证——验收电池据此取点击坐标。
// 视图模型是纯函数（taskbar-view.ts）；本文件只是它的 DOM 呈现端 + 右键菜单开合（中组
// 显隐菜单属工单54，摘要勾选编辑态属工单55）。
import { dispatchTaskbarButton, dispatchTaskbarVisibility, formatClock, formatMetric, summaryViewModel, taskbarViewModel, toggleMetric } from './taskbar-view.js'
import type { HardwareGauges, TaskbarMetric, TaskbarState, TaskbarStatus } from '../shared/contract'

const pill = document.getElementById('pill') as HTMLElement
const rightPill = document.getElementById('right-pill') as HTMLElement
const sliver = document.getElementById('show-desktop') as HTMLElement

/** 最近一次渲染的状态：几何重排（resize）时按它重声明热区 */
let current: TaskbarState | null = null
/** 右组 1Hz 数据帧的最近值：重渲染（勾选变更）时按它立即填字，不等下一拍 */
let latestStatus: TaskbarStatus | null = null
/** 硬件摘要编辑态（工单55，右键进入勾选子集，再右键/点格外退出） */
let editing = false
/** 系统按钮显隐菜单开合（工单54）：右键开、点菜/点 pill 空白/状态回推收 */
let menuOpen = false
let menuTimer: ReturnType<typeof setTimeout> | null = null

interface Rect { id: string; x: number; y: number; w: number; h: number }

function rectOf(el: HTMLElement, id: string): Rect {
  const r = el.getBoundingClientRect()
  return { id, x: r.x, y: r.y, w: r.width, h: r.height }
}

/** 各 pill、按钮/推荐位/单元格与细条矩形（CSS px 相对客户区）：热区声明与验收存证共用同一份测量 */
function measure() {
  return {
    pill: rectOf(pill, 'pill'),
    buttons: [...pill.querySelectorAll<HTMLElement>('.tb-btn')].map((el) => rectOf(el, el.dataset.id ?? '')),
    recommendations: [...pill.querySelectorAll<HTMLElement>('.tb-rec')].map((el) => ({
      name: el.dataset.name ?? '', ...rectOf(el, ''),
    })).map(({ name, ...r }) => ({ name, x: r.x, y: r.y, w: r.w, h: r.h })),
    rightPill: rectOf(rightPill, 'right-pill'),
    rightCells: [...rightPill.querySelectorAll<HTMLElement>('[data-id]')].map((el) => rectOf(el, el.dataset.id ?? '')),
    sliver: rectOf(sliver, 'show-desktop'),
  }
}

/** 热区声明（工单54/55 并集）：中组不渲染（禁用/全隐藏且无推荐）不含 pill；
 * 右组（摘要+音量+时钟）与显示桌面细条随 enabled 声明；两皆无即清空——条带整幅恢复穿透 */
function declareHotZones(state: TaskbarState): void {
  if (!state.enabled) {
    window.deck.host.setHotZones([])
    return
  }
  const m = measure()
  const zones = [m.rightPill, m.sliver]
  if (taskbarViewModel(state).visible) zones.unshift(m.pill)
  window.deck.host.setHotZones(zones)
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

function render(state: TaskbarState): void {
  current = state
  const vm = taskbarViewModel(state)
  // 中组（工单54 边界条件：两按钮全隐藏且无推荐 → 整组不渲染，只剩左右两组）
  pill.hidden = !vm.visible
  pill.textContent = ''
  if (!vm.visible) {
    closeMenu()
  } else {
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
  }
  // 右组（工单55）：硬件摘要 →（托盘位 #56 占位）→ 音量 → 时钟
  rightPill.textContent = ''
  if (state.enabled) {
    const summary = renderSummary(vm.metrics, latestStatus?.hardware ?? null)
    if (summary) rightPill.appendChild(summary)
    const traySlot = document.createElement('div')
    traySlot.id = 'tray-slot' // #56 托盘入栏的接入锚位
    rightPill.appendChild(traySlot)
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
    window.deck.host.notify('taskbar-ready', {
      enabled: state.enabled, pill: m.pill, buttons: m.buttons, recommendations: m.recommendations,
      rightPill: m.rightPill, rightCells: m.rightCells, sliver: m.sliver,
    })
    window.deck.bridge.on('taskbar/changed', (next) => {
      closeMenu() // 状态回推即收菜单（点菜成功的收层路径）
      render(next)
    })
    window.deck.bridge.on('taskbar/status', (status) => applyStatus(status))
    // 几何重排重声明热区：主进程在 display-metrics-changed 时 setBounds 重排条带
    // （换分辨率/换主屏），pill 坐标随客户区宽度变化，旧热区矩形会落空
    window.addEventListener('resize', () => {
      if (current) declareHotZones(current)
    })
  })()
}

boot()
