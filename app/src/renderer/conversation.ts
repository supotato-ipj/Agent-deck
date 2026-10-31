// 对话窗渲染层（工单332）：纯呈现与输入（GLOSSARY「对话窗」）。状态唯一来源是
// conversation/changed 推送的全量会话视图；动作全部经内核桥接契约（create/prompt/
// cancel/permission/end/resume），渲染层不解释协议方言——工具与权限条目按原样载荷
// 呈现，权限裁决只回用户点中的 optionId（绝不超时自动拒绝，ADR-0018）。
import type { ConversationSessionView, ConversationTranscriptEntry } from '../shared/contract'

const transcriptEl = document.getElementById('transcript') as HTMLElement
const selectEl = document.getElementById('session-select') as HTMLSelectElement
const inputEl = document.getElementById('prompt-input') as HTMLTextAreaElement
const statusEl = document.getElementById('status-line') as HTMLElement
const btnNew = document.getElementById('btn-new') as HTMLButtonElement
const btnSend = document.getElementById('btn-send') as HTMLButtonElement
const btnCancel = document.getElementById('btn-cancel') as HTMLButtonElement
const btnEnd = document.getElementById('btn-end') as HTMLButtonElement

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
    opt.textContent = `${s.label}${stateMark}`
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
    transcriptEl.scrollTop = transcriptEl.scrollHeight
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

async function createSession(): Promise<void> {
  const res = await window.deck.bridge.invoke('conversation/create', {})
  if (res.ok && res.session) activeId = res.session.id
  else statusEl.textContent = res.error ?? '创建失败'
}

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
