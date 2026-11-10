// 托盘溢出菜单浮层页（工单162；工单458 网格化）：自绘纯图标网格面板——固定 5 列、
// 格 36×36px、16px 图标居中，不渲名称文字、悬停出原生 title 名称提示。格内容自足于
// 内核契约——自取 taskbar/get-state，用与条带同一条溢出拆分纯函数（splitTrayOverflow）
// 切尾段，与栏面永不各判一次。格左键 = 该应用默认动作、格右键 = 该应用自带菜单：
// 与栏内图标共用同一道 taskbar/tray-click 回放分发（dispatchTrayClick），存证事件同型
// （surface: 'overflow' 区分落点）。收层路径：点格（回放已发出，浮层不遮应用响应窗）、
// 点面板空白、名单拆空（宿主 changed 推进重拆后为空）、点面板外（宿主 blur 收）。
import { dispatchTrayClick, fetchTrayIcon, splitTrayOverflow, taskbarViewModel, trayIconPixelated, trayOverflowMenuRows } from './taskbar-view.js'
import type { TaskbarState, TaskbarTrayButton, TaskbarTrayEntry } from '../shared/contract'
import { trayDataUrl } from './tray-pixels.js'

const list = document.getElementById('overflow-list') as HTMLElement

// 视口帽随宿主 query 下发（工作区高留边距）：名单超帽才滚动，帽内格全部可点
const maxH = Number(new URLSearchParams(location.search).get('maxH')) || 560
if (Number.isFinite(maxH) && maxH > 100) list.style.maxHeight = `${maxH}px`

/** 图标像素缓存（身份键 → dataURL；条带页同款纪律，仅内存） */
const pxCache = new Map<string, { url: string; px: boolean }>()

function requestClose(reason: string, extra: Record<string, unknown> = {}): void {
  window.deck.host.notify('taskbar-tray-overflow-close', { reason, ...extra })
}

/** 菜单格：左键/右键各自回放到所属应用（与栏内图标同一回放分发），点格即收。
 * 名称提示走原生 title（工单458：格不渲名称文字）。 */
function makeCell(entry: TaskbarTrayEntry): HTMLElement {
  const cell = document.createElement('div')
  cell.className = 'ov-cell'
  cell.dataset.key = entry.key
  cell.title = entry.tooltip || entry.key
  const img = document.createElement('img')
  img.alt = entry.tooltip || entry.key
  cell.appendChild(img)
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
      if (cell.dataset.key === entry.key) {
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
      .finally(() => requestClose('cell', { key: entry.key, button }))
  }
  cell.addEventListener('click', () => act('left'))
  cell.addEventListener('contextmenu', (ev) => {
    ev.preventDefault()
    act('right')
  })
  return cell
}

/** 状态 → 格渲染（5 列行优先排布）；返回当拍溢出段（空 = 收层判据）。 */
function render(state: TaskbarState): TaskbarTrayEntry[] {
  const vm = taskbarViewModel(state)
  const { overflow } = splitTrayOverflow(vm.tray, vm.trayOverflowLimit)
  list.textContent = ''
  for (const entry of overflow) list.appendChild(makeCell(entry))
  return overflow
}

/** 内容实测回报：宿主据此定窗并锚光标弹出；rows 携带格矩形（相对客户区，坐标语义 =
 * 格——工单458 由「行」改「格」，电池据此取格点击坐标；格序 = 名单序行优先排布）与
 * key/label（电池据此对账回放身份；labels 数组维持既有回报口径）。 */
function reportReady(overflow: TaskbarTrayEntry[]): void {
  const rect = list.getBoundingClientRect()
  const rows = overflow.map((e, i) => {
    const el = list.children[i] as HTMLElement | undefined
    const r = el?.getBoundingClientRect()
    return r
      ? { key: e.key, label: e.tooltip || e.key, x: r.x, y: r.y, w: r.width, h: r.height }
      : { key: e.key, label: e.tooltip || e.key, x: 0, y: 0, w: 0, h: 0 }
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
  // 红轮实测不可靠：重开后 6s 无 ready，浮层格悬空；隐藏拍渲染本就廉价）；拆空即收
  // （数量回落「⋯」消失同拍语义），格数变化重回报（宿主重定窗，浮层已在场不再 show）
  window.deck.bridge.on('taskbar/changed', (next) => {
    const nextOverflow = render(next)
    if (!nextOverflow.length) {
      requestClose('empty')
      return
    }
    reportReady(nextOverflow)
  })
})()

// 点面板空白（非格）即收：原生菜单同语义（面板内非可点区不算「面板外」，但仍收——
// 菜单不留空点悬置态）
document.addEventListener('click', (ev) => {
  if (ev.target instanceof HTMLElement && ev.target.closest('.ov-cell')) return
  requestClose('outside')
})
