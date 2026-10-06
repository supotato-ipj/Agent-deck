// 任务栏条带渲染入口（工单49/52）：状态经 taskbar/get-state 拉取 + taskbar/changed 订阅；
// 左组 pill（手钉+运行中合并，工单52）与中组 pill 的矩形（含各条目矩形）经宿主面
// 声明为热区并落存证——验收电池据此取点击坐标。左组条目只做显示：图标 + 运行态 +
// 窗口标题 tooltip（标题随状态帧即时进出，渲染层不落任何存储）；点击/右键交互语义
// 属工单53，本票预留挂点（条目元素 data-exe = 身份，视图模型 id 同值）。
import { dispatchTaskbarButton, taskbarViewModel } from './taskbar-view.js'
import type { TaskbarLeftViewEntry } from './taskbar-view.js'
import type { TaskbarState } from '../shared/contract'

const pill = document.getElementById('pill') as HTMLElement
const pillLeft = document.getElementById('pill-left') as HTMLElement

/** 最近一次渲染的状态：几何重排（resize）时按它重声明热区 */
let current: TaskbarState | null = null
/** 图标 dataURL 缓存（iconKey → dataURL；仅内存——桌面 dock 同款本地缓存纪律） */
const iconCache = new Map<string, string>()

/** pill 与条目矩形（CSS px 相对客户区）：热区声明与验收存证共用同一份测量 */
function measure() {
  const rectOf = (el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  }
  return {
    pill: rectOf(pill),
    buttons: [...pill.querySelectorAll<HTMLElement>('.tb-btn')].map((el) => ({ id: el.dataset.id ?? '', ...rectOf(el) })),
    leftPill: rectOf(pillLeft),
    apps: [...pillLeft.querySelectorAll<HTMLElement>('.tb-app')].map((el) => ({ id: el.dataset.exe ?? '', ...rectOf(el) })),
  }
}

function declareHotZones(state: TaskbarState): void {
  if (!state.enabled) {
    window.deck.host.setHotZones([])
    return
  }
  const m = measure()
  const zones = [{ id: 'pill', ...m.pill }]
  // 左组装了条目才占热区（空组不渲染 pill，缝隙保持穿透）
  if (m.apps.length) zones.push({ id: 'pill-left', ...m.leftPill })
  window.deck.host.setHotZones(zones)
}

/** 图标装载：缓存命中即贴；未命中经 desktop/icon 契约提取（内核侧按 iconKey 反解路径）。
 * 回填前核对元素仍代表同一图标键（重渲染后旧回填不贴错位）。 */
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
  pill.textContent = ''
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
  declareHotZones(state)
}

async function boot(): Promise<void> {
  const state = await window.deck.bridge.invoke('taskbar/get-state', null)
  render(state)
  const m = measure()
  window.deck.host.notify('taskbar-ready', { enabled: state.enabled, pill: m.pill, buttons: m.buttons, leftPill: m.leftPill, apps: m.apps })
  window.deck.bridge.on('taskbar/changed', (next) => render(next))
  // 几何重排重声明热区：主进程在 display-metrics-changed 时 setBounds 重排条带
  // （换分辨率/换主屏），pill 居中坐标随客户区宽度变化，旧热区矩形会落空
  window.addEventListener('resize', () => {
    if (current) declareHotZones(current)
  })
}

void boot()
