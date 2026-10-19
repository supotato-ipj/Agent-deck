// 托盘溢出菜单浮层页（工单162）：自绘竖排菜单面板（每行图标+名称）。行内容自足于
// 内核契约——自取 taskbar/get-state，用与条带同一条溢出拆分纯函数（splitTrayOverflow）
// 切尾段，与栏面永不各判一次。行左键 = 该应用默认动作、行右键 = 该应用自带菜单：
// 与栏内图标共用同一道 taskbar/tray-click 回放分发（dispatchTrayClick），存证事件同型
// （surface: 'overflow' 区分落点）。收层路径：点行（回放已发出，浮层不遮应用响应窗）、
// 点面板空白、名单拆空（宿主 changed 推进重拆后为空）、点面板外（宿主 blur 收）。
import { dispatchTrayClick, fetchTrayIcon, splitTrayOverflow, taskbarViewModel, trayIconPixelated, trayOverflowMenuRows } from './taskbar-view.js'
import type { TaskbarState, TaskbarTrayButton, TaskbarTrayEntry } from '../shared/contract'
import { trayDataUrl } from './tray-pixels.js'

const list = document.getElementById('overflow-list') as HTMLElement

// 视口帽随宿主 query 下发（工作区高留边距）：名单超帽才滚动，帽内行全部可点
const maxH = Number(new URLSearchParams(location.search).get('maxH')) || 560
if (Number.isFinite(maxH) && maxH > 100) list.style.maxHeight = `${maxH}px`

/** 图标像素缓存（身份键 → dataURL；条带页同款纪律，仅内存） */
const pxCache = new Map<string, { url: string; px: boolean }>()

function requestClose(reason: string, extra: Record<string, unknown> = {}): void {
  window.deck.host.notify('taskbar-tray-overflow-close', { reason, ...extra })
}

/** 菜单行：左键/右键各自回放到所属应用（与栏内图标同一回放分发），点行即收。 */
function makeRow(entry: TaskbarTrayEntry): HTMLElement {
  const row = document.createElement('div')
  row.className = 'ov-row'
  row.dataset.key = entry.key
  const img = document.createElement('img')
  img.alt = entry.tooltip || entry.key
  row.appendChild(img)
  const label = document.createElement('span')
  label.className = 'ov-label'
  label.textContent = entry.tooltip || entry.key
  row.appendChild(label)
  const cached = pxCache.get(entry.key)
  if (cached) {
    img.src = cached.url
    img.classList.toggle('ov-px', cached.px)
  } else {
    void fetchTrayIcon(window.deck.bridge, entry.key).then((pixels) => {
      if (!pixels) return
      const url = trayDataUrl(pixels)
      const px = trayIconPixelated(pixels.width)
      pxCache.set(entry.key, { url, px })
      if (row.dataset.key === entry.key) {
        img.src = url
        img.classList.toggle('ov-px', px)
      }
    })
  }
  const act = (button: TaskbarTrayButton): void => {
    // 存证与分发同条带 makeTrayEl 同型（surface 区分落点）。顺序=回执存证先行、收层殿后
    //（红轮实证：先收层后回执时窗已销、pending .then 随渲染进程一起死——result 存证永不落）；
    // 回放已发出，浮层稍收不遮应用的响应窗（左键开窗/右键应用自带菜单都在浮层收起后浮现）
    window.deck.host.notify('taskbar-tray-click', { key: entry.key, button, surface: 'overflow' })
    void dispatchTrayClick(window.deck.bridge, entry.key, button)
      .then((r) => window.deck.host.notify('taskbar-tray-click-result', { key: entry.key, button, surface: 'overflow', ok: r.ok, ...(r.error ? { error: r.error } : {}) }))
      .finally(() => requestClose('row', { key: entry.key, button }))
  }
  row.addEventListener('click', () => act('left'))
  row.addEventListener('contextmenu', (ev) => {
    ev.preventDefault()
    act('right')
  })
  return row
}

/** 状态 → 行渲染；返回当拍溢出段（空 = 收层判据）。 */
function render(state: TaskbarState): TaskbarTrayEntry[] {
  const vm = taskbarViewModel(state)
  const { overflow } = splitTrayOverflow(vm.tray, vm.trayOverflowLimit)
  list.textContent = ''
  for (const entry of overflow) list.appendChild(makeRow(entry))
  return overflow
}

/** 内容实测回报：宿主据此定窗并锚光标弹出；rows 携带行矩形（相对客户区，电池据此取
 * 行点击坐标）与 key/label（电池据此对账回放身份）。 */
function reportReady(overflow: TaskbarTrayEntry[]): void {
  const rect = list.getBoundingClientRect()
  const rows = overflow.map((e, i) => {
    const el = list.children[i] as HTMLElement | undefined
    const r = el?.getBoundingClientRect()
    return { key: e.key, label: e.tooltip || e.key, y: r ? r.y : 0, h: r ? r.height : 0 }
  })
  window.deck.host.notify('taskbar-tray-overflow-ready', {
    w: rect.width,
    h: rect.height,
    rows,
    labels: trayOverflowMenuRows(overflow).map((r) => r.label),
  })
}

void (async () => {
  let state: TaskbarState
  try {
    state = await window.deck.bridge.invoke('taskbar/get-state', null)
  } catch (err) {
    window.deck.host.notify('taskbar-boot-error', { stage: 'tray-overflow-get-state', message: String(err) })
    requestClose('boot-failed')
    return
  }
  const overflow = render(state)
  if (!overflow.length) {
    requestClose('empty')
    return
  }
  reportReady(overflow)
  // 名单/档位变化：重拆重渲（不做隐藏拍跳渲——show 拍 visibilitychange 补渲染在真机
  // 红轮实测不可靠：重开后 6s 无 ready，浮层行悬空；隐藏拍渲染本就廉价）；拆空即收
  // （数量回落「⋯」消失同拍语义），行数变化重回报（宿主重定窗，浮层已在场不再 show）
  window.deck.bridge.on('taskbar/changed', (next) => {
    const nextOverflow = render(next)
    if (!nextOverflow.length) {
      requestClose('empty')
      return
    }
    reportReady(nextOverflow)
  })
})()

// 点面板空白（非行）即收：原生菜单同语义（面板内非可点区不算「面板外」，但仍收——
// 菜单不留空点悬置态）
document.addEventListener('click', (ev) => {
  if (ev.target instanceof HTMLElement && ev.target.closest('.ov-row')) return
  requestClose('outside')
})
