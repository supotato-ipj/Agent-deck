// 搜索面板（工单100 成包，GLOSSARY「搜索面板」三态）：待机/活动/引擎离线整体进包——
// 宿主页面的搜索 DOM 与渲染层三态逻辑随本包迁出（工单07 → 插件包，时钟/天气/会话同款纪律）。
// 观感与改造前一致：卡片几何与配色仍由面板样式表（.card / #search-card 族）承担，本插件只建
// DOM（结构与改造前 index.html 宿主 DOM 一致，id 一一对应，热区通用扫掠自动声明不变）。
// 检索走既有桥接契约（search/activate|query|deactivate|action，contract.ts 三方法不变），
// 结果/离线经 search/results|state 事件回推（host.on 订阅，工单100 扩充）。
// 键盘档（工单100 通用 API）：激活请求占用、退回释放——宿主单点仲裁与选区/浮层同源，
// keyboard-mode-on/off 存证流与时机同相位不变（电池 P7/P5.17 断言）。
// 隐私边界：本文件与全部存证 notify 一律不含查询词内容（只带 qlen 长度，旧 QD_PANEL_TRACE 惯例）。
import type { PluginApi, PluginHost } from '../../plugins.js'
import type { SearchResultItem } from '../../../shared/contract'

const SEARCH_LIMIT = 8
const SEARCH_NAME_CHARS = 26
const SEARCH_PATH_CHARS = 24
/** 键盘档名（插件内自取；宿主按插件 id 加命名空间后进归一仲裁） */
const SEARCH_TIER = 'search'

let host: PluginHost
let searchCard: HTMLElement
let searchHint: HTMLElement
let searchInput: HTMLInputElement
let searchPlaceholder: HTMLElement
let searchResultsBox: HTMLElement
let searchActive = false
let searchItems: SearchResultItem[] = []
let searchSel = -1
let searchDeactivating = false // 程序化失焦护栏：deactivate 主动 blur 不再触发失焦转移
let offs: Array<() => void> = []

/** 完整路径 → (名称, 父目录) 两段展示（listary_engine.display_parts 平移，含盘根反斜杠语义） */
function displayParts(path: string): { name: string; parent: string } {
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  if (cut < 0) return { name: path, parent: '' }
  let parent = path.slice(0, cut)
  if (parent.endsWith(':')) parent += '\\' // 盘根：C:\ 而非 C:（PureWindowsPath 语义）
  return { name: path.slice(cut + 1), parent }
}
/** 超长时保留尾部（路径的辨识段在结尾） */
function elideLeft(s: string, max: number): string {
  return s.length <= max ? s : '…' + s.slice(-(max - 1))
}
/** 超长时保留头部（文件名的辨识段在开头） */
function elideRight(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

/** 面板按键 → 动作（listary_engine.decide_action 平移；其余键不接） */
function searchDecideAction(key: string, ctrl: boolean): 'prev' | 'next' | 'open' | 'reveal' | null {
  if (key === 'ArrowUp') return 'prev'
  if (key === 'ArrowDown') return 'next'
  if (key === 'Enter') return ctrl ? 'reveal' : 'open'
  return null
}

function applySearchSelection(): void {
  const rows = searchResultsBox.querySelectorAll<HTMLElement>('.qrow')
  rows.forEach((row, i) => row.classList.toggle('sel', i === searchSel))
}

/** 选中项移动：首尾 clamp 不环绕（SelectionModel 语义）；结果刷新重置回首项 */
function searchMove(delta: number): void {
  if (!searchItems.length) return
  searchSel = Math.max(0, Math.min(searchItems.length - 1, searchSel + delta))
  applySearchSelection()
  host.notify('search-selection-moved', { index: searchSel })
}

function clearSearchResultsDom(): void {
  searchResultsBox.textContent = ''
  searchResultsBox.style.display = 'none'
  searchItems = []
  searchSel = -1
}

function renderSearchRows(total: number, items: SearchResultItem[]): void {
  searchItems = items.slice(0, SEARCH_LIMIT)
  searchSel = searchItems.length ? 0 : -1
  searchResultsBox.textContent = ''
  if (!searchItems.length) {
    const empty = document.createElement('div')
    empty.id = 'search-empty'
    empty.textContent = 'NO RESULTS'
    searchResultsBox.appendChild(empty)
  } else {
    searchItems.forEach((item, idx) => {
      const row = document.createElement('div')
      row.className = 'qrow'
      const parts = displayParts(item.path)
      const name = document.createElement('span')
      name.className = 'qname'
      name.textContent = elideRight(parts.name, SEARCH_NAME_CHARS)
      const dir = document.createElement('span')
      dir.className = 'qpath'
      dir.textContent = elideLeft(parts.parent, SEARCH_PATH_CHARS)
      row.append(name, dir)
      // mousedown preventDefault：行点击不夺输入框焦点（失焦即收层，点击会落空）
      row.addEventListener('mousedown', (e) => e.preventDefault())
      row.addEventListener('click', () => { void searchAct(idx, false) })
      searchResultsBox.appendChild(row)
    })
  }
  const foot = document.createElement('div')
  foot.id = 'search-total'
  foot.textContent = `TOTAL ${total}`
  searchResultsBox.appendChild(foot)
  searchResultsBox.style.display = 'block'
  applySearchSelection()
  host.onDomChanged()
}

function renderSearchOffline(): void {
  searchResultsBox.textContent = ''
  const badge = document.createElement('div')
  badge.id = 'search-offline'
  badge.textContent = 'ENGINE OFFLINE'
  searchResultsBox.appendChild(badge)
  searchResultsBox.style.display = 'block'
  searchItems = []
  searchSel = -1
  host.onDomChanged()
}

async function searchAct(idx: number, reveal: boolean): Promise<void> {
  const item = searchItems[idx]
  if (!item) return
  host.notify('search-action', { index: idx, reveal, qlen: searchInput.value.length })
  try {
    const r = await host.invoke('search/action', { path: item.path, reveal })
    host.notify(r.ok ? (reveal ? 'search-revealed' : 'search-opened') : 'search-action-rejected', {
      index: idx, reveal, ok: r.ok, error: r.error ?? null,
    })
  } catch (err) {
    host.notify('search-action-failed', { index: idx, reveal, message: String(err) })
  }
  searchDeactivate('action') // 动作完成即收起（旧 _act → _deactivate('esc') 惯例）
}

function searchActivate(): void {
  if (searchActive) {
    searchInput.focus() // 活动态重复点击 = 摆放光标，不重置查询
    return
  }
  searchActive = true
  // 键盘档开（工单100 通用 API，宿主单点仲裁）：面板永不激活，这里临时取得键盘焦点再聚焦输入框
  host.holdKeyboardTier(SEARCH_TIER)
  searchHint.style.display = 'none'
  searchInput.style.display = 'block'
  searchPlaceholder.style.display = searchInput.value ? 'none' : 'block'
  void host.invoke('search/activate', null).then((r) => {
    if (r.state === 'offline' && searchActive) renderSearchOffline()
  }, () => { /* 内核未就绪：下次交互再试 */ })
  searchInput.focus()
  host.notify('search-activated', {})
  host.onDomChanged()
}

/** 退待机触发源（存证 reason 字段的契约：电池按 reason 断言） */
type SearchDeactivateReason = 'esc' | 'blur' | 'action'

function searchDeactivate(reason: SearchDeactivateReason): void {
  if (!searchActive) return
  searchDeactivating = true
  searchActive = false
  // 键盘档关（工单100 通用 API，宿主单点仲裁）：恢复不可聚焦+钉底。窗口随之失活会再触发一次
  // input blur，由 searchDeactivating 护栏与上方 searchActive 早退双保险拦住，不会打架。
  // 选区仍非空则仲裁保持 on。
  host.releaseKeyboardTier(SEARCH_TIER)
  void host.invoke('search/deactivate', null).catch(() => {})
  searchInput.value = ''
  searchInput.style.display = 'none'
  searchPlaceholder.style.display = 'none'
  searchHint.style.display = 'block'
  clearSearchResultsDom()
  searchInput.blur()
  setTimeout(() => { searchDeactivating = false }, 0)
  host.notify('search-deactivated', { reason })
  host.onDomChanged()
}

export default {
  mount(h: PluginHost): void {
    host = h
    searchActive = false
    searchItems = []
    searchSel = -1
    searchDeactivating = false
    offs = []
    const card = document.createElement('div')
    card.className = 'card'
    card.id = 'search-card'
    // 结构与改造前 index.html 的宿主 DOM 一致（id 与样式表一一对应，观感不变；热区通用扫掠
    // 按 .card + id 自动声明，热区标识仍是 search-card）
    card.innerHTML =
      '<h2>SEARCH</h2>' +
      '<div id="search-row">' +
      '<div id="search-hint">CLICK TO SEARCH_</div>' +
      '<input id="search-input" type="text" autocomplete="off" spellcheck="false">' +
      '<div id="search-placeholder">TYPE TO SEARCH FILES_</div>' +
      '</div>' +
      '<div id="search-sep"></div>' +
      '<div id="search-results"></div>'
    h.el.appendChild(card)
    searchCard = card
    searchHint = card.querySelector('#search-hint') as HTMLElement
    searchInput = card.querySelector('#search-input') as HTMLInputElement
    searchPlaceholder = card.querySelector('#search-placeholder') as HTMLElement
    searchResultsBox = card.querySelector('#search-results') as HTMLElement

    // 卡片任意位置点击激活；mousedown preventDefault 保输入框焦点（点击卡片他处不触发失焦转移）
    searchCard.addEventListener('mousedown', (e) => {
      if (e.target !== searchInput) e.preventDefault()
    })
    searchCard.addEventListener('click', () => searchActivate())

    searchInput.addEventListener('input', () => {
      if (!searchActive) return
      const text = searchInput.value
      searchPlaceholder.style.display = text ? 'none' : 'block'
      if (!text) clearSearchResultsDom() // 空查询即收结果（旧 _on_text_changed 惯例）
      void host.invoke('search/query', { query: text }).catch(() => {})
    })

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        searchDeactivate('esc')
        return
      }
      const action = searchDecideAction(e.key, e.ctrlKey)
      if (!action) return
      e.preventDefault() // ↑↓ 不移动光标（旧 Tk "break" 惯例）
      if (action === 'prev') searchMove(-1)
      else if (action === 'next') searchMove(1)
      else void searchAct(searchSel, action === 'reveal')
    })

    // 失焦回退随插件生命周期挂载（DOM 随容器销毁即摘；退订兜底见 unmount 与运行时）
    searchInput.addEventListener('blur', () => {
      if (searchDeactivating) return
      searchDeactivate('blur')
    })

    // 结果/离线事件订阅（工单100 host.on）：退订函数在 unmount 时摘除（运行时另兜底）
    offs = [
      h.on('search/results', (r) => {
        if (!searchActive) return // 迟到响应（已退待机）：丢弃
        renderSearchRows(r.total, r.items)
        h.notify('search-results-rendered', {
          qlen: searchInput.value.length, total: r.total, count: Math.min(SEARCH_LIMIT, r.items.length),
        })
      }),
      h.on('search/state', (s) => {
        if (s.state === 'offline' && searchActive) {
          renderSearchOffline()
          h.notify('search-offline-shown', {})
        }
        // 'active' 恢复由随后到达的 search/results 重绘（离线徽标被结果行替换）；'idle' 由本地转移处理
      }),
    ]
  },

  unmount(): void {
    // 订阅随生命周期摘除（运行时兜底再清一次）；活动态先走既有退回链——键盘档释放
    //（宿主仲裁还原键盘模式）+ 内核退待机。宿主侧回收双保险见 plugins.ts reclaimPlugin。
    for (const off of offs.splice(0)) off()
    if (searchActive) searchDeactivate('blur')
  },
} satisfies PluginApi
