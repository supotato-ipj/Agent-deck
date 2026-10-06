// 任务栏条带渲染入口（工单49/52/54）：状态经 taskbar/get-state 拉取 + taskbar/changed 订阅；
// pill 矩形（含各按钮/推荐位/左组条目矩形）经宿主面声明为热区并落存证——验收电池据此
// 取点击坐标。视图模型是纯函数（taskbar-view.ts）；本文件只是它的 DOM 呈现端 + 右键菜单开合。
// 左组（工单52）只做显示：图标 + 运行态指示 + 窗口标题 tooltip（标题随状态帧即时进出，
// 渲染层不落任何存储）；点击/右键交互语义属工单53，本票预留挂点（条目元素 data-exe = 身份，
// 视图模型 id 同值）。
import { dispatchTaskbarButton, dispatchTaskbarVisibility, taskbarViewModel } from './taskbar-view.js'
import type { TaskbarLeftViewEntry } from './taskbar-view.js'
import type { TaskbarState } from '../shared/contract'

const pill = document.getElementById('pill') as HTMLElement
const pillLeft = document.getElementById('pill-left') as HTMLElement

/** 最近一次渲染的状态：几何重排（resize）时按它重声明热区 */
let current: TaskbarState | null = null
/** 系统按钮显隐菜单开合（工单54）：右键开、点菜/点 pill 空白/状态回推收 */
let menuOpen = false
let menuTimer: ReturnType<typeof setTimeout> | null = null
/** 图标 dataURL 缓存（iconKey → dataURL；仅内存——桌面 dock 同款本地缓存纪律） */
const iconCache = new Map<string, string>()

/** pill 与按钮/推荐位/左组条目矩形（CSS px 相对客户区）：热区声明与验收存证共用同一份测量 */
function measure() {
  const rectOf = (el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  }
  return {
    pill: rectOf(pill),
    buttons: [...pill.querySelectorAll<HTMLElement>('.tb-btn')].map((el) => ({ id: el.dataset.id ?? '', ...rectOf(el) })),
    recommendations: [...pill.querySelectorAll<HTMLElement>('.tb-rec')].map((el) => ({ name: el.dataset.name ?? '', ...rectOf(el) })),
    leftPill: rectOf(pillLeft),
    apps: [...pillLeft.querySelectorAll<HTMLElement>('.tb-app')].map((el) => ({ id: el.dataset.exe ?? '', ...rectOf(el) })),
  }
}

/** 热区声明：中组不渲染（禁用/全隐藏且无推荐）即不报中组矩形；左组装了条目才报左组
 * 矩形（空组不渲染 pill，缝隙保持穿透）；两组皆空即清空——条带整幅恢复穿透 */
function declareHotZones(visible: boolean, leftApps: number): void {
  const m = measure()
  const zones = []
  if (visible) zones.push({ id: 'pill', ...m.pill })
  if (leftApps > 0) zones.push({ id: 'pill-left', ...m.leftPill })
  window.deck.host.setHotZones(zones)
}

/** 最近一次几何存证签名：几何未变的重渲（窗口标题刷新等无位移帧）不重复刷事件流 */
let lastGeometryJson = ''

/** 几何存证（验收电池点击坐标来源）：pill/按钮/推荐位/左组矩形任一变化即补发一帧——
 * 推荐位随数据面快照后到位会推中组 pill 移位，电池按 settle 后的最新帧取坐标 */
function notifyGeometry(): void {
  const m = measure()
  const payload: Record<string, unknown> = {
    pill: m.pill,
    buttons: m.buttons,
    recommendations: m.recommendations,
    leftPill: m.leftPill,
    apps: m.apps,
  }
  const json = JSON.stringify(payload)
  if (json === lastGeometryJson) return
  lastGeometryJson = json
  window.deck.host.notify('taskbar-geometry', payload)
}

function closeMenu(): void {
  if (menuTimer !== null) {
    clearTimeout(menuTimer)
    menuTimer = null
  }
  menuOpen = false
}

/** 左组图标装载（工单52）：缓存命中即贴；未命中经 desktop/icon 契约提取（内核侧按
 * iconKey 反解路径）。回填前核对元素仍代表同一图标键（重渲染后旧回填不贴错位）。 */
function applyIcon(img: HTMLImageElement, iconKey: string | null): void {
  if (!iconKey) return
  const cached = iconCache.get(iconKey)
  if (cached) {
    img.src = cached
    return
  }
  void window.deck.bridge.invoke('desktop/icon', { key: iconKey }).then((r) => {
    const dataUrl = r?.dataUrl
    if (!dataUrl) return
    iconCache.set(iconKey, dataUrl)
    if (img.dataset.iconKey === iconKey) img.src = dataUrl
  })
}

/** 左组渲染（工单52）：手钉+运行中合并条目；空组整组不渲染（display:none） */
function renderLeft(entries: TaskbarLeftViewEntry[]): void {
  pillLeft.textContent = ''
  pillLeft.style.display = entries.length ? '' : 'none'
  for (const e of entries) {
    const el = document.createElement('div')
    el.className = e.running ? 'tb-app running' : 'tb-app'
    el.dataset.exe = e.exe // 工单53 交互挂点（点击/右键按 exe 身份分发）
    el.title = e.tooltip // 窗口标题 tooltip：仅即时显示，渲染层不持久化
    const img = document.createElement('img')
    img.dataset.iconKey = e.iconKey ?? ''
    img.alt = e.label
    el.appendChild(img)
    applyIcon(img, e.iconKey)
    pillLeft.appendChild(el)
  }
}

function render(state: TaskbarState): void {
  current = state
  const vm = taskbarViewModel(state)
  renderLeft(vm.left)
  pill.hidden = !vm.visible
  pill.textContent = ''
  if (!vm.visible) {
    closeMenu()
    declareHotZones(false, vm.left.length)
    notifyGeometry()
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
  declareHotZones(true, vm.left.length)
  notifyGeometry()
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
    window.deck.host.notify('taskbar-ready', {
      enabled: state.enabled,
      pill: m.pill,
      buttons: m.buttons,
      recommendations: m.recommendations,
      leftPill: m.leftPill,
      apps: m.apps,
    })
    window.deck.bridge.on('taskbar/changed', (next) => {
      closeMenu() // 状态回推即收菜单（点菜成功的收层路径）
      render(next)
    })
    // 几何重排重声明热区：主进程在 display-metrics-changed 时 setBounds 重排条带
    // （换分辨率/换主屏），pill 居中坐标随客户区宽度变化，旧热区矩形会落空
    window.addEventListener('resize', () => {
      if (current) {
        const vm = taskbarViewModel(current)
        declareHotZones(vm.visible, vm.left.length)
        notifyGeometry()
      }
    })
  })()
}

boot()
