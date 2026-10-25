// 会话列表卡（工单10 内置桌面组件 3/5）：五工具活跃会话按最近活跃混排 + 两字母工具标签；
// 点击会话行 → session/focus（工单09）→ 对应工具窗口置前，未运行则启动。
// 失败一律静默：面板不崩、不弹窗（会话行是轻交互，失败不该打断桌面）。
import type { PluginApi, PluginHost } from '../../plugins.js'
import type { SessionInfo } from '../../../shared/contract'

const TOOL_TAGS: Record<string, string> = { qoder: 'QD', kimicode: 'KC', kimiwork: 'KW', zcode: 'ZC', hermes: 'HM' }

let rows: HTMLElement
let standby: HTMLElement
let count: HTMLElement
let rendered = 0

function focusSessionRow(host: PluginHost, tool: string, id: string): void {
  host.notify('session-focus-clicked', { tool, id })
  void host.invoke('session/focus', { tool }).then(
    (r) => host.notify('session-focus-result', {
      tool, id, ok: Boolean(r && r.ok), action: String((r && r.action) || 'degraded'),
      error: (r && r.error) ? String(r.error) : null,
      hwnd: r && typeof r.hwnd === 'number' ? r.hwnd : null,
    }),
    (err: unknown) => host.notify('session-focus-failed', { tool, id, message: String(err) }),
  )
}

function render(host: PluginHost, sessions: SessionInfo[]): void {
  if (!rows) return
  const { pad3, esc } = host.util
  rows.textContent = ''
  standby.style.display = sessions.length ? 'none' : 'block'
  count.textContent = pad3(sessions.length)
  for (const s of sessions.slice(0, 9)) {
    const row = document.createElement('div')
    row.className = 'srow'
    const tasks = s.tasks_done == null || s.tasks_total == null
      ? '' : `${pad3(s.tasks_done)}/${pad3(s.tasks_total)}`
    const state = String(s.state || 'IDLE')
    row.innerHTML =
      `<span class="tag">${esc(TOOL_TAGS[s.tool] || '??')}</span>` +
      `<span class="state ${esc(state.toLowerCase())}">${esc(state)}</span>` +
      `<span class="name">${esc(String(s.project || ''))}</span>` +
      `<span class="tasks">${esc(tasks)}</span>`
    row.title = '点击直达该工具窗口'
    row.dataset.tool = s.tool
    row.addEventListener('click', () => focusSessionRow(host, s.tool, s.id))
    rows.appendChild(row)
  }
  rendered += 1
  if (rendered <= 3) {
    // 存证：前 3 拍带各行矩形（电池按 tool/project 定位点击落点，desktop-rendered rects 同法）
    const items = Array.from(rows.children).map((child) => {
      const node = child as HTMLElement
      const r = node.getBoundingClientRect()
      const name = node.querySelector('.name')
      return {
        tool: node.dataset.tool || '',
        project: name ? String(name.textContent || '') : '',
        rect: { x: r.left, y: r.top, w: r.width, h: r.height },
      }
    })
    host.notify('sessions-rendered', { n: rendered, count: sessions.length, rows: items })
  }
}

export default {
  mount(host: PluginHost): void {
    const card = document.createElement('div')
    card.className = 'card'
    card.id = 'sessions-card'
    card.innerHTML =
      '<h2>SESSIONS <span id="sessions-head-count">000</span></h2>'
      + '<div id="session-rows"></div>'
      + '<div id="sessions-standby">NO ACTIVE SESSIONS</div>'
    host.el.appendChild(card)
    rows = card.querySelector('#session-rows') as HTMLElement
    standby = card.querySelector('#sessions-standby') as HTMLElement
    count = card.querySelector('#sessions-head-count') as HTMLElement
    rendered = 0
    this.update?.(host)
  },

  update(host: PluginHost): void {
    render(host, host.view.sessions ?? [])
  },
} satisfies PluginApi
