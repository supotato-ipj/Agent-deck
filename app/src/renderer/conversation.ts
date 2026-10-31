// 对话窗渲染层（工单332 聊天型 / 工单333 管理型叠加）：纯呈现与输入（GLOSSARY「对话窗」）。
// 状态唯一来源是 conversation/changed 推送的全量会话视图；动作全部经内核桥接契约
// （create/prompt/cancel/permission/end/resume），渲染层不解释协议方言——工具与权限条目
// 按原样载荷呈现，权限裁决只回用户点中的 optionId（绝不超时自动拒绝，ADR-0018）。
// 管理型（工单333）：「管理」勾选 = 用户显式授权（逐会话、不持久化）；创建失败在窗内
// 显式报错并给「以聊天型创建」按钮——绝不静默降级（ADR-0018 全有或全无）。
import type { ConversationSessionView, ConversationTranscriptEntry } from '../shared/contract'

const transcriptEl = document.getElementById('transcript') as HTMLElement
const selectEl = document.getElementById('session-select') as HTMLSelectElement
const inputEl = document.getElementById('prompt-input') as HTMLTextAreaElement
const statusEl = document.getElementById('status-line') as HTMLElement
const btnNew = document.getElementById('btn-new') as HTMLButtonElement
const btnSend = document.getElementById('btn-send') as HTMLButtonElement
const btnCancel = document.getElementById('btn-cancel') as HTMLButtonElement
const btnEnd = document.getElementById('btn-end') as HTMLButtonElement
const chkManaged = document.getElementById('chk-managed') as HTMLInputElement
const managedToggle = document.getElementById('managed-toggle') as HTMLLabelElement

let sessions: ConversationSessionView[] = []
let activeId: string | null = null

function active(): ConversationSessionView | null {
  return sessions.find((s) => s.id === activeId) ?? null
}

function current(): ConversationSessionView | null {
  return active() ?? sessions[0] ?? null
}

function fmtTime(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function entryNode(entry: ConversationTranscriptEntry): HTMLElement {
  const div = document.createElement('div')
  div.className = `entry ${entry.kind}`
  if (entry.kind === 'permission') {
    const title = document.createElement('div')
    title.textContent = `工具审批：${entry.toolCallId ?? ''}`
    div.appendChild(title)
    for (const opt of entry.options ?? []) {
      const line = document.createElement('div')
      line.textContent = `· ${opt.name}（${opt.optionId} / ${opt.kind}）`
      div.appendChild(line)
    }
    if (entry.resolvedOptionId) {
      const done = document.createElement('div')
      done.className = 'resolved'
      done.textContent = `已裁决：${entry.resolvedOptionId}`
      div.appendChild(done)
    } else {
      const actions = document.createElement('div')
      actions.className = 'perm-actions'
      for (const opt of entry.options ?? []) {
        const b = document.createElement('button')
        b.textContent = opt.name
        b.addEventListener('click', () => {
          const s = current()
          if (s) void window.deck.bridge.invoke('conversation/permission', { sessionId: s.id, optionId: opt.optionId })
        })
        actions.appendChild(b)
      }
      const cancelBtn = document.createElement('button')
      cancelBtn.textContent = '取消本回合'
      cancelBtn.addEventListener('click', () => {
        const s = current()
        if (s) void window.deck.bridge.invoke('conversation/cancel', { sessionId: s.id })
      })
      actions.appendChild(cancelBtn)
      div.appendChild(actions)
    }
    return div
  }
  const body = document.createElement('div')
  if (entry.kind === 'tool') {
    const status = entry.status ? `［${entry.status}］` : ''
    body.textContent = `工具 ${entry.toolCallId ?? ''}${status} ${entry.text}`
    if (entry.status === 'failed') div.classList.add('failed-status')
  } else {
    body.textContent = entry.text
  }
  body.title = fmtTime(entry.at)
  div.appendChild(body)
  return div
}

function render(): void {
  // 会话下拉
  const prev = selectEl.value
  selectEl.textContent = ''
  for (const s of sessions) {
    const opt = document.createElement('option')
    opt.value = s.id
    const stateMark = s.status === 'busy' ? '（回复中）' : s.status === 'starting' ? '（连接中）' : s.status === 'failed' ? '（已中断）' : s.status === 'ended' ? '（已结束）' : ''
    const managedMark = s.managed ? '［管理］' : ''
    opt.textContent = `${managedMark}${s.label}${stateMark}`
    selectEl.appendChild(opt)
  }
  if (sessions.some((s) => s.id === prev)) selectEl.value = prev
  else if (current()) selectEl.value = current()!.id

  const view = current()
  transcriptEl.textContent = ''
  if (!view) {
    const empty = document.createElement('div')
    empty.className = 'entry system'
    empty.textContent = '尚无会话——点「新会话」创建 DSH 聊天会话。'
    transcriptEl.appendChild(empty)
  } else {
    for (const e of view.transcript) transcriptEl.appendChild(entryNode(e))
    if (view.error) {
      const banner = document.createElement('div')
      banner.className = 'entry error-banner'
      banner.textContent = view.error
      transcriptEl.appendChild(banner)
    }
    if (view.status === 'failed') {
      const resumeBtn = document.createElement('button')
      resumeBtn.textContent = '续接本会话'
      resumeBtn.addEventListener('click', () => { void window.deck.bridge.invoke('conversation/resume', { sessionId: view.id }) })
      transcriptEl.appendChild(resumeBtn)
    }
    if (view.managed) {
      const badge = document.createElement('div')
      badge.className = 'entry managed-badge'
      badge.textContent = '管理型会话：DSH 可经只读 MCP 读取面板快照/插件清单/用户根源码/契约目录（凭证仅内存，会话结束即失效）'
      transcriptEl.appendChild(badge)
    }
    transcriptEl.scrollTop = transcriptEl.scrollHeight
  }
  if (managedFailed) {
    const banner = document.createElement('div')
    banner.className = 'entry error-banner'
    banner.textContent = '管理型创建失败（全有或全无，未创建会话）。可显式选择以聊天型创建：'
    const retryBtn = document.createElement('button')
    retryBtn.className = 'chat-retry'
    retryBtn.textContent = '以聊天型创建'
    retryBtn.addEventListener('click', () => retryAsChat())
    banner.appendChild(retryBtn)
    transcriptEl.appendChild(banner)
  }

  const busy = view?.status === 'busy'
  const running = view != null && (view.status === 'ready' || busy)
  btnSend.disabled = !running
  btnCancel.disabled = !busy
  btnEnd.disabled = view == null || view.status === 'ended'
  inputEl.disabled = !running
  const usage = view && (view.usage.used != null || view.usage.size != null)
    ? `｜上下文 ${view.usage.used ?? '?'} / ${view.usage.size ?? '?'}`
    : ''
  const backend = view?.backendAgent ? `｜${view.backendAgent} ${view.backendAgentVersion ?? ''}` : ''
  statusEl.textContent = view
    ? `${view.cwd}${backend}${usage}${busy ? '｜回复中…' : ''}`
    : '后端：DSH（对话通道 ACP v1）'
}

/** 管理型创建失败态（工单333）：窗内显式呈现错误 + 「以聊天型创建」按钮——绝不静默降级 */
let managedFailed = false

async function createSession(): Promise<void> {
  const managed = chkManaged.checked
  const res = await window.deck.bridge.invoke('conversation/create', { managed })
  if (res.ok && res.session) {
    managedFailed = false
    activeId = res.session.id
  } else {
    if (managed && res.canRetryAsChat) {
      managedFailed = true
      statusEl.textContent = res.error ?? '管理型创建失败'
    } else {
      statusEl.textContent = res.error ?? '创建失败'
    }
  }
  render()
}

/** 管理型失败后的显式聊天型选择：清勾选、按聊天型建（用户点按钮才降级，绝不自动） */
function retryAsChat(): void {
  chkManaged.checked = false
  managedToggle.classList.remove('checked')
  managedFailed = false
  void createSession()
}

chkManaged.addEventListener('change', () => {
  managedToggle.classList.toggle('checked', chkManaged.checked)
})

selectEl.addEventListener('change', () => { activeId = selectEl.value || null; render() })
btnNew.addEventListener('click', () => { void createSession() })
btnSend.addEventListener('click', send)
btnCancel.addEventListener('click', () => {
  const s = current()
  if (s) void window.deck.bridge.invoke('conversation/cancel', { sessionId: s.id })
})
btnEnd.addEventListener('click', () => {
  const s = current()
  if (s) void window.deck.bridge.invoke('conversation/end', { sessionId: s.id })
})

async function send(): Promise<void> {
  const s = current()
  const text = inputEl.value
  if (!s || !text.trim()) return
  inputEl.value = ''
  const res = await window.deck.bridge.invoke('conversation/prompt', { sessionId: s.id, text })
  if (!res.ok) {
    statusEl.textContent = res.error ?? '发送失败'
    inputEl.value = text
  }
}

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    void send()
  }
})

window.deck.bridge.on('conversation/changed', (payload) => {
  sessions = payload.sessions
  if (!activeId && sessions.length) activeId = sessions[0].id
  if (activeId && !sessions.some((s) => s.id === activeId)) activeId = null
  render()
})

// 启动：拉一次清单（重启面板后转写为空属预期——正文归 DSH 权威）
void window.deck.bridge.invoke('conversation/list', null).then((res) => {
  sessions = res.sessions
  if (sessions.length) activeId = sessions[0].id
  render()
})
render()
