// Qoder 状态卡（工单10 内置桌面组件 4/5）：最近活跃会话的项目、任务进度与当前任务。
import type { PluginApi, PluginHost } from '../../plugins.js'
import type { QoderStatus } from '../../../shared/contract'

let body: HTMLElement
let task: HTMLElement
let fill: HTMLElement
let rendered = 0

function render(host: PluginHost, q: QoderStatus): void {
  if (!body) return
  const { pad3, esc } = host.util
  const s = q.session
  if (!s) {
    body.innerHTML = `PROJECT <span class="bright">----</span> · ACTIVE <span class="bright">${pad3(q.active_sessions)}</span>`
    task.textContent = 'NO CURRENT TASK'
    fill.style.width = '0%'
  } else {
    const state = s.running ? 'RUNNING' : 'STANDBY'
    body.innerHTML =
      `PROJECT <span class="bright">${esc(s.project || '----')}</span>` +
      ` · <span class="bright">${state}</span>` +
      ` · TASKS <span class="bright">${pad3(s.tasks_done)}/${pad3(s.tasks_total)}</span>` +
      ` · ACTIVE <span class="bright">${pad3(q.active_sessions)}</span>`
    task.textContent = s.current_task ? `> ${s.current_task}` : '> NO CURRENT TASK'
    fill.style.width = s.tasks_total > 0 ? `${Math.round((s.tasks_done / s.tasks_total) * 100)}%` : '0%'
  }
  rendered += 1
  if (rendered <= 3) host.notify('qoder-rendered', { n: rendered, active: q.active_sessions })
}

export default {
  mount(host: PluginHost): void {
    const card = document.createElement('div')
    card.className = 'card'
    card.id = 'qoder-card'
    card.innerHTML =
      '<h2>QODER STATUS</h2>'
      + '<div id="qoder-body">PROJECT ---- &middot; ACTIVE 0</div>'
      + '<div id="qoder-task">NO CURRENT TASK</div>'
      + '<div id="qoder-progress"><div id="qoder-progress-fill"></div></div>'
    host.el.appendChild(card)
    body = card.querySelector('#qoder-body') as HTMLElement
    task = card.querySelector('#qoder-task') as HTMLElement
    fill = card.querySelector('#qoder-progress-fill') as HTMLElement
    rendered = 0
    this.update?.(host)
  },

  update(host: PluginHost): void {
    const q = host.view.qoder
    if (q) render(host, q)
  },
} satisfies PluginApi
