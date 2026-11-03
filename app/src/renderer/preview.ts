// 窗口预览渲染层（工单379）：桥事件 'preview/changed' → 横向条目流。
// - live：条目缩略图区只留空位（DWM 实时缩略图由主进程按条目矩形合成在窗面上）；
// - cached：内存缓存帧（dataURL）直接上屏；
// - icon：应用图标 + 标题回退。
// 条目矩形（CSS px，相对视口）经 host.previewLayout 上行，主进程换算物理 px 后注册/更新
// DWM 关系（滚动时随 rAF 重报）。Esc 收起；点击条目选择进入聚焦；鼠标离开不收起。
// 自诊断（条带/胶囊同款）：桥接失败页内可见，真机轮能分辨「没跑」与「跑崩」。
import type { WindowPreviewItem, WindowPreviewState } from '../shared/contract'

const stripEl = document.querySelector<HTMLDivElement>('#pv-strip')!
const countEl = document.querySelector<HTMLSpanElement>('#pv-count')!

let lastOpen = false
let currentItems: WindowPreviewItem[] = []
let rafPending = false
let lastLayoutKey = ''

/** 把 live 条目的缩略图区矩形上报主进程（DWM 目标矩形）；滚动/尺寸变化都要重报 */
function reportLayout(): void {
  const live = new Set(currentItems.filter((x) => x.mode === 'live').map((x) => x.hwnd))
  const rects: Array<{ hwnd: number; x: number; y: number; w: number; h: number }> = []
  for (const item of stripEl.querySelectorAll<HTMLDivElement>('.pv-item')) {
    const hwnd = Number(item.dataset.hwnd)
    if (!live.has(hwnd)) continue
    const thumb = item.querySelector<HTMLDivElement>('.pv-thumb')
    if (!thumb) continue
    const r = thumb.getBoundingClientRect()
    rects.push({
      hwnd,
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
    })
  }
  const key = JSON.stringify(rects)
  if (key === lastLayoutKey) return
  lastLayoutKey = key
  window.deck.host.previewLayout(rects)
}

function scheduleLayout(): void {
  if (rafPending) return
  rafPending = true
  requestAnimationFrame(() => {
    rafPending = false
    reportLayout()
  })
}

function makeItem(item: WindowPreviewItem): HTMLDivElement {
  const el = document.createElement('div')
  el.className = 'pv-item'
  el.dataset.hwnd = String(item.hwnd)
  el.title = item.title

  const thumb = document.createElement('div')
  thumb.className = 'pv-thumb'
  if (item.mode === 'live') {
    thumb.classList.add('live')
  } else if (item.mode === 'cached' && item.image) {
    const img = document.createElement('img')
    img.className = 'pv-img'
    img.alt = ''
    img.src = item.image
    thumb.appendChild(img)
  } else {
    const fallback = document.createElement('div')
    fallback.className = 'pv-fallback'
    const icon = document.createElement('img')
    icon.className = 'pv-icon'
    icon.alt = ''
    if (item.icon) icon.src = item.icon
    else icon.hidden = true
    const fbTitle = document.createElement('div')
    fbTitle.className = 'pv-fb-title'
    fbTitle.textContent = item.title
    fallback.append(icon, fbTitle)
    thumb.appendChild(fallback)
  }

  const title = document.createElement('div')
  title.className = 'pv-title'
  title.textContent = item.title
  el.append(thumb, title)
  el.addEventListener('click', () => {
    void window.deck.bridge
      .invoke('preview/select', { hwnd: item.hwnd })
      .catch((err) => console.error('[preview] select failed', err))
  })
  return el
}

function render(state: WindowPreviewState | null): void {
  if (!state || !state.open) {
    currentItems = []
    stripEl.replaceChildren()
    countEl.textContent = '0'
    lastLayoutKey = ''
    lastOpen = false
    return
  }
  const items = state.items
  currentItems = items
  lastLayoutKey = ''
  countEl.textContent = String(items.length)
  const frag = document.createDocumentFragment()
  if (!items.length) {
    const empty = document.createElement('div')
    empty.className = 'pv-empty'
    empty.textContent = '当前没有可预览的窗口'
    frag.appendChild(empty)
  } else {
    for (const item of items) frag.appendChild(makeItem(item))
  }
  stripEl.replaceChildren(frag)
  scheduleLayout()
  if (!lastOpen) {
    lastOpen = true
    // 可交互存证（验收 200ms 预算）：首帧条目已上屏
    window.deck.host.notify('preview-rendered', { count: items.length })
  }
}

stripEl.addEventListener('scroll', scheduleLayout, { passive: true })
window.addEventListener('resize', scheduleLayout)

// 鼠标滚轮 → 横向滚动（鼠标只有纵向滚轮时也能浏览条目）
stripEl.addEventListener(
  'wheel',
  (ev) => {
    if (Math.abs(ev.deltaY) <= Math.abs(ev.deltaX)) return
    stripEl.scrollLeft += ev.deltaY
    ev.preventDefault()
  },
  { passive: false },
)

window.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return
  ev.preventDefault()
  void window.deck.bridge.invoke('preview/close', null).catch((err) => console.error('[preview] close failed', err))
})

// 初始一拍拉现值（建窗先于首帧推送的窗口期——先渲染再等推）
void (async () => {
  try {
    const initial = await window.deck.bridge.invoke('preview/get-state', null)
    render(initial as WindowPreviewState)
  } catch (err) {
    console.error('[preview] initial get-state failed', err)
    render(null)
  }
})()
window.deck.bridge.on('preview/changed', (payload) => {
  // 接收时刻存证（验收 200ms 预算拆账：主进程上屏→渲染层收到→首帧）
  window.deck.host.notify('preview-recv', { open: Boolean((payload as WindowPreviewState | null)?.open) })
  render(payload as WindowPreviewState)
})
window.deck.host.beat()
setInterval(() => window.deck.host.beat(), 1000)
