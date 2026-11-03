// Agent 会话预览渲染层（工单381）：桥事件 'session-preview/changed' → 横向卡片流。
//
// 只读呈现（spec 用户故事 69）：卡片无点击/双击处理器、无会话直达动作；唯一交互是
// 横向滚动与 Esc 收起（Esc 经 host.notify 上行，主进程 before-input-event 亦有兜底）。
// 诚实分态（决策 22）：执行中 / 最近活跃 / 等待询问 / 疑似等待 / 未知——文案由服务端
// 投影给的状态值直接映射，渲染层不做推断。标题分列：真实标题（缺省「未命名会话」）、
// 项目名、短会话 ID 各占一行次级槽位（决策 23）。
//
// 指针进出气泡经 host.notify 上行，供主进程的 400ms 移入宽限状态机消费；气泡尺寸按
// 内容实测上行（主进程按此定窗，避免大片透明区域挡住下方窗口）。
import type { SessionPreviewCard, SessionPreviewState } from '../shared/contract'
import { cardView } from './session-preview-view.js'

const bubbleEl = document.querySelector<HTMLDivElement>('#sp-bubble')!
const streamEl = document.querySelector<HTMLDivElement>('#sp-stream')!

let lastSizeKey = ''

function makeCard(card: SessionPreviewCard): HTMLElement {
  const view = cardView(card)
  const el = document.createElement('div')
  el.className = 'sp-card'
  el.dataset.tool = card.tool
  el.dataset.id = card.id
  el.dataset.status = card.status
  el.dataset.readonly = 'true' // 只读卡片：无点击直达

  const head = document.createElement('div')
  head.className = 'sp-head'
  const tool = document.createElement('span')
  tool.className = 'sp-tool'
  tool.textContent = view.toolLabel
  tool.title = view.toolName
  const status = document.createElement('span')
  status.className = 'sp-status'
  status.dataset.status = card.status
  const dot = document.createElement('i')
  dot.className = 'sp-dot'
  status.appendChild(dot)
  status.appendChild(document.createTextNode(view.statusLabel))
  head.appendChild(tool)
  head.appendChild(status)

  const title = document.createElement('div')
  title.className = 'sp-title'
  title.textContent = view.title
  if (view.unnamed) {
    title.classList.add('unnamed')
    title.dataset.titleMissing = 'true'
  } else {
    title.title = view.title
  }

  const meta = document.createElement('div')
  meta.className = 'sp-meta'
  const project = document.createElement('span')
  project.className = 'sp-project'
  project.textContent = view.project
  if (view.projectMissing) project.dataset.projectMissing = 'true'
  const id = document.createElement('span')
  id.className = 'sp-id'
  id.textContent = view.shortId
  meta.appendChild(project)
  meta.appendChild(id)

  el.appendChild(head)
  el.appendChild(title)
  el.appendChild(meta)
  return el
}

/** 气泡尺寸按内容实测上行（主进程据此定窗；宽度上限 1000，超过即单行横向滚动） */
function reportSize(): void {
  if (bubbleEl.hidden) return
  const natural = streamEl.scrollWidth + 16
  const w = Math.max(220, Math.min(1000, Math.ceil(natural)))
  bubbleEl.style.width = `${w}px`
  const h = Math.max(72, Math.ceil(bubbleEl.offsetHeight))
  const key = `${w}x${h}`
  if (key === lastSizeKey) return
  lastSizeKey = key
  window.deck.host.notify('session-preview-size', { w, h })
}

function render(state: SessionPreviewState | null): void {
  if (!state || !state.available || !state.open) {
    bubbleEl.hidden = true
    return
  }
  streamEl.textContent = ''
  const total = state.groups.reduce((n, g) => n + g.cards.length, 0)
  if (total === 0) {
    // 空态：没有任何活动会话（完成/空闲均被过滤；空工具本就不占位）
    const empty = document.createElement('div')
    empty.id = 'sp-empty'
    empty.textContent = '暂无活动会话'
    streamEl.appendChild(empty)
    bubbleEl.hidden = false
    requestAnimationFrame(reportSize)
    return
  }
  state.groups.forEach((group, gi) => {
    // 组间竖分隔条：工具相对顺序固定、组内最近活跃（组内序由服务端投影排好）
    if (gi > 0) {
      const sep = document.createElement('div')
      sep.className = 'sp-sep'
      sep.dataset.between = `${state.groups[gi - 1].tool}:${group.tool}`
      streamEl.appendChild(sep)
    }
    for (const card of group.cards) streamEl.appendChild(makeCard(card))
  })
  bubbleEl.hidden = false
  requestAnimationFrame(reportSize)
}

// 指针进出气泡：400ms 移入宽限的对账事实（主进程状态机消费）
document.documentElement.addEventListener('pointerenter', () => {
  window.deck.host.notify('session-preview-pointer', { inside: true })
})
document.documentElement.addEventListener('pointerleave', () => {
  window.deck.host.notify('session-preview-pointer', { inside: false })
})

// Esc 收起（主进程 before-input-event 亦有兜底；两条都上行同一意图）
window.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return
  ev.preventDefault()
  window.deck.host.notify('session-preview-esc', {})
})

window.deck.bridge.on('session-preview/changed', (state) => render(state))

// 首帧自取（打开推送可能早于本页订阅——承载窗预建常热，但先到先得的自证面要留住）
void window.deck.bridge
  .invoke('session-preview/get-state', null)
  .then((state) => render(state))
  .catch((err) => console.error('[session-preview] get-state failed', err))

window.addEventListener('resize', () => requestAnimationFrame(reportSize))
