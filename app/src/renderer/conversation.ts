// 对话窗渲染层（工单332 聊天型 / 工单333 管理型叠加；工单364 初始化门禁与发送反馈）：
// 纯呈现与输入（GLOSSARY「对话窗」）。状态唯一来源是 conversation/changed 推送的全量会话视图；
// 动作全部经内核桥接契约（create/prompt/cancel/permission/end/resume），渲染层不解释协议方言——
// 工具与权限条目按原样载荷呈现，权限裁决只回用户点中的 optionId（绝不超时自动拒绝，ADR-0018）。
// 管理型（工单333）：「管理」勾选 = 用户显式授权（逐会话、不持久化）；创建失败在窗内
// 显式报错并给「以聊天型创建」按钮——绝不静默降级（ADR-0018 全有或全无）。
//
// 工单364（初始化门禁 + 发送反馈）：
// - 静态初始态禁用输入与发送（HTML 层）；初始化成功后才按当前会话状态开放。初始化失败
//   （preload 未装配/桥接拒绝/回执形状异常）有可见诊断——绝不退化成无存证的「什么都没发生」
//   （现场根因：preload 缺席时模块在 window.deck 处抛错中止，页面留下能点却无反应的按钮）。
// - 无会话：明确指导「请先创建会话」，输入与按钮状态与指导一致；发送尝试不静默。
// - 有会话：点发送与按 Enter 都立即回显用户输入并进入「回复中」；权威转写仍经既有变化推送
//   刷新（不建第二条发送链）。桥接拒绝/同步异常/后端回合失败一律可见报错并恢复草稿；
//   不自动重试、不自动新建会话、不切换后端、不动 DSH 数据目录。
import type { AuthorizationGrantView, ConversationSessionView, ConversationTranscriptEntry, CredentialView, InstallProposalView, MediaAuditBucketView, NetworkAuditBucketView } from '../shared/contract'

const transcriptEl = document.getElementById('transcript') as HTMLElement
const selectEl = document.getElementById('session-select') as HTMLSelectElement
const inputEl = document.getElementById('prompt-input') as HTMLTextAreaElement
const statusEl = document.getElementById('status-line') as HTMLElement
// 诊断位（可缺——旧构建产物没有它时诊断仍落在转写横幅上，不因缺元素而崩）
const initErrorEl = document.getElementById('init-error') as HTMLElement | null
const btnNew = document.getElementById('btn-new') as HTMLButtonElement
const btnSend = document.getElementById('btn-send') as HTMLButtonElement
const btnCancel = document.getElementById('btn-cancel') as HTMLButtonElement
const btnEnd = document.getElementById('btn-end') as HTMLButtonElement
const chkManaged = document.getElementById('chk-managed') as HTMLInputElement
const managedToggle = document.getElementById('managed-toggle') as HTMLLabelElement
const btnFreshDir = document.getElementById('btn-fresh-dir') as HTMLButtonElement

let sessions: ConversationSessionView[] = []
let activeId: string | null = null

/**
 * 工单364：初始化门禁三态。
 * pending = 静态初始态（输入与发送禁用）；ready = 按当前会话状态开放；failed = 可见诊断。
 */
type InitState = 'pending' | 'ready' | 'failed'
let initState: InitState = 'pending'
let initError: string | null = null
/** 工单364：发送失败可见（状态行每次 render 覆写——只写那里等于没写） */
let sendError: string | null = null
/** 工单364：受理前的本地乐观回显（权威转写到达后自动让位，不重复显示） */
let pendingSend: { sessionId: string; text: string; expectedUserCount: number } | null = null
/**
 * 工单364：已受理但未收束的回合（回合失败时据此恢复草稿——失败可见且草稿不丢）。
 * 判据用计数而非时序：权威转写里的 agent 条目变多 = 回合有回复；view.error 变新 = 回合失败。
 */
let awaitingTurn: { sessionId: string; text: string; expectedAgentCount: number; errorAtSend: string | null } | null = null
/** 工单364：无会话时点发送的明确指导（不静默） */
let noSessionNotice = false

function active(): ConversationSessionView | null {
  return sessions.find((s) => s.id === activeId) ?? null
}

function current(): ConversationSessionView | null {
  return active() ?? sessions[0] ?? null
}

/** 桥接面是否在位（preload 未装配时如实缺席——绝不假装能调） */
function bridgeAvailable(): boolean {
  const bridge = window.deck?.bridge
  return !!bridge && typeof bridge.invoke === 'function'
}

function systemEntry(text: string): HTMLElement {
  const div = document.createElement('div')
  div.className = 'entry system'
  div.textContent = text
  return div
}

function errorEntry(text: string): HTMLElement {
  const div = document.createElement('div')
  div.className = 'entry error-banner'
  div.textContent = text
  return div
}

/** 转写里的用户消息条数（乐观回显让位的判据：权威条目已到就别再显示本地那份） */
function userEntryCount(view: ConversationSessionView | null): number {
  if (!view) return 0
  return view.transcript.filter((e) => e.kind === 'user').length
}

/** 权威转写已含本次用户消息 → 本地乐观回显让位（不重复显示，也不吞掉权威条目） */
function syncPendingSend(view: ConversationSessionView | null): void {
  if (!pendingSend || !view || view.id !== pendingSend.sessionId) return
  if (userEntryCount(view) >= pendingSend.expectedUserCount) pendingSend = null
}

/** 转写里的 agent 回复条数（回合是否已有回复的判据） */
function agentEntryCount(view: ConversationSessionView | null): number {
  if (!view) return 0
  return view.transcript.filter((e) => e.kind === 'agent').length
}

/**
 * 工单364：回合收束判定——回合失败（新出现的 view.error）→ 恢复草稿；回合有回复 → 正常收束。
 * 失败原因本身由 view.error 呈现（既有错误横幅），此处只负责把草稿放回输入框。
 */
function syncAwaitingTurn(view: ConversationSessionView | null): void {
  if (!awaitingTurn || !view || view.id !== awaitingTurn.sessionId) return
  if (view.error && view.error !== awaitingTurn.errorAtSend) {
    const text = awaitingTurn.text
    awaitingTurn = null
    if (!inputEl.value.trim()) inputEl.value = text
    return
  }
  if (agentEntryCount(view) >= awaitingTurn.expectedAgentCount) awaitingTurn = null
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
  syncPendingSend(view)
  syncAwaitingTurn(view)
  transcriptEl.textContent = ''
  if (initState === 'pending') {
    transcriptEl.appendChild(systemEntry('对话窗正在初始化——初始化完成前输入与发送不可用。'))
  }
  if (initState === 'failed') {
    transcriptEl.appendChild(errorEntry(`对话窗初始化失败：${initError ?? '未知原因'}——输入与发送保持禁用；请重开对话窗。`))
  }
  if (!view) {
    // 工单364：无会话的明确指导（不是静默死按钮）
    transcriptEl.appendChild(systemEntry('尚无会话——请先创建会话（点「新会话」创建 DSH 聊天会话）。'))
    if (noSessionNotice) {
      transcriptEl.appendChild(errorEntry('当前没有可发送的会话——请先创建会话（点「新会话」）后再发送。'))
    }
  } else {
    for (const e of view.transcript) transcriptEl.appendChild(entryNode(e))
    // 工单364：受理前的本地回显（点了发送立刻看见自己的消息，不等内核回执）
    if (pendingSend && pendingSend.sessionId === view.id) {
      const echo = document.createElement('div')
      echo.className = 'entry user'
      echo.textContent = pendingSend.text
      transcriptEl.appendChild(echo)
    }
    if (view.error) {
      transcriptEl.appendChild(errorEntry(view.error))
    }
    if (sendError) {
      transcriptEl.appendChild(errorEntry(`发送失败：${sendError}`))
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

  // 工单364：控件状态与「当前能不能发」严格一致——初始化未成/无会话/会话不可发都禁用
  const initialized = initState === 'ready'
  const busy = view?.status === 'busy' || (pendingSend != null && pendingSend.sessionId === view?.id)
  const canSend = initialized && view != null && view.status === 'ready' && pendingSend == null
  btnSend.disabled = !canSend
  btnCancel.disabled = !busy
  btnEnd.disabled = view == null || view.status === 'ended'
  inputEl.disabled = !(initialized && view != null && (view.status === 'ready' || view.status === 'busy'))
  const usage = view && (view.usage.used != null || view.usage.size != null)
    ? `｜上下文 ${view.usage.used ?? '?'} / ${view.usage.size ?? '?'}`
    : ''
  const backend = view?.backendAgent ? `｜${view.backendAgent} ${view.backendAgentVersion ?? ''}` : ''
  // 工单340（ADR-0026）：浮动运行时未验收标记 + 冒烟结果如实呈现（accepted 恒 false，无转绿路径）
  const runtimeMark = view?.runtimeUnaccepted
    ? `｜未验收版本${view.runtimeSmoke && view.runtimeSmoke !== 'pending' ? `（冒烟 ${view.runtimeSmoke}）` : ''}`
    : ''
  statusEl.textContent = view
    ? `${view.cwd}${backend}${runtimeMark}${usage}${busy ? '｜回复中…' : ''}`
    : initialized
      ? '后端：DSH（对话通道 ACP v1）｜尚无会话——请先创建会话'
      : '对话窗初始化中……'
}

/** 管理型创建失败态（工单333）：窗内显式呈现错误 + 「以聊天型创建」按钮——绝不静默降级 */
let managedFailed = false

async function createSession(): Promise<void> {
  if (!bridgeAvailable()) {
    setInitFailed('内核桥接未就绪（preload 未装配）')
    render()
    return
  }
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
// 工单340（ADR-0026）：显式创建全新 DSH 数据目录——用户手势，旧目录原样保留、新目录不继承旧会话
btnFreshDir.addEventListener('click', () => {
  void window.deck.bridge.invoke('conversation/new-data-dir', null).then((res) => {
    statusEl.textContent = res.ok
      ? `已切换全新数据目录：${res.dshHome}（旧目录 ${res.previous} 原样保留）`
      : res.error ?? '全新数据目录创建失败'
  })
})

/**
 * 工单364：发送——点按钮与按 Enter 共用这一条路（不建第二条发送链）。
 * 受理前先本地回显并进入「回复中」；受理失败（桥接拒绝/同步异常）可见报错 + 恢复草稿。
 */
async function send(): Promise<void> {
  const s = current()
  const text = inputEl.value
  if (!s) {
    // 无会话：不静默返回——明确指导（此刻输入与发送本就禁用，这里兜住任何越界点击）
    noSessionNotice = true
    render()
    return
  }
  if (!text.trim()) return
  if (initState !== 'ready') {
    sendError = '对话窗尚未初始化完成——请重开对话窗后再发送'
    render()
    return
  }
  inputEl.value = ''
  sendError = null
  noSessionNotice = false
  pendingSend = { sessionId: s.id, text, expectedUserCount: userEntryCount(s) + 1 }
  render()
  try {
    const res = await window.deck.bridge.invoke('conversation/prompt', { sessionId: s.id, text })
    if (!res.ok) {
      failSend(text, res.error ?? '内核未受理本次发送')
      return
    }
    // 受理成功：权威转写经既有变化推送到达，本地回显届时让位；
    // 记下本回合——回合失败时据此恢复草稿（失败可见、草稿不丢）
    awaitingTurn = {
      sessionId: s.id,
      text,
      expectedAgentCount: agentEntryCount(s) + 1,
      errorAtSend: s.error,
    }
    render()
  } catch (err) {
    failSend(text, err instanceof Error ? err.message : String(err))
  }
}

/** 工单364：发送失败可见 + 恢复草稿（不静默丢失；绝不自动重试） */
function failSend(text: string, message: string): void {
  pendingSend = null
  sendError = message
  if (!inputEl.value.trim()) inputEl.value = text
  render()
}

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    void send()
  }
})

// ---------------------------------------------------------------------------
// 工单364：页面启动门禁——静态初始态先渲染（输入与发送禁用），再拉会话清单；
// 失败即显式诊断（preload 未装配/桥接拒绝/回执形状异常都算失败），输入与发送保持禁用。
// ---------------------------------------------------------------------------

/** 初始化失败：可见诊断（写进独立诊断位，不被下一次 render 覆写） */
function setInitFailed(message: string): void {
  initState = 'failed'
  initError = message
  if (initErrorEl) {
    initErrorEl.style.display = 'block'
    initErrorEl.textContent = `对话窗初始化失败：${message}——输入与发送保持禁用；请重开对话窗。`
  }
}

function clearInitFailed(): void {
  initError = null
  if (initErrorEl) {
    initErrorEl.style.display = 'none'
    initErrorEl.textContent = ''
  }
}

async function boot(): Promise<void> {
  try {
    if (!bridgeAvailable()) throw new Error('内核桥接未就绪（preload 未装配）')
    window.deck.bridge.on('conversation/changed', (payload) => {
      sessions = payload.sessions
      if (!activeId && sessions.length) activeId = sessions[0].id
      if (activeId && !sessions.some((s) => s.id === activeId)) activeId = null
      // 推送到达即证明桥接在位——初始化失败态在此自愈（诊断撤下）
      if (initState === 'failed') {
        initState = 'ready'
        clearInitFailed()
      }
      render()
    })
    // 启动：拉一次清单（重启面板后转写为空属预期——正文归 DSH 权威）
    const res = await window.deck.bridge.invoke('conversation/list', null)
    if (!res || !Array.isArray(res.sessions)) throw new Error('会话清单回执形状异常')
    sessions = res.sessions
    if (sessions.length) activeId = sessions[0].id
    initState = 'ready'
    clearInitFailed()
  } catch (err) {
    setInitFailed(err instanceof Error ? err.message : String(err))
  }
  render()
}

// 静态初始态先落地（脚本没跑起来时 HTML 层也已禁用输入与发送）
render()
void boot()

// ---------------------------------------------------------------------------
// 待批准安装条（工单334，ADR-0025 批准面）：可信内核 UI 的真实用户手势——批准前代码
// 不执行；零权限包权限栏显示「无（零权限）」；终态提案留痕（activated/rejected/failed+错误）
// ---------------------------------------------------------------------------
const installBar = document.getElementById('install-bar') as HTMLElement
let proposals: InstallProposalView[] = []

function renderInstalls(): void {
  installBar.textContent = ''
  if (!proposals.length) {
    installBar.style.display = 'none'
    return
  }
  installBar.style.display = 'block'
  for (const p of proposals) {
    const row = document.createElement('div')
    row.className = `install-row ${p.status}`
    const summary = document.createElement('div')
    summary.className = 'install-summary'
    const src = `${p.source.label ?? p.source.sessionId.slice(0, 8)}・${p.source.backend}`
    const perms = p.pkg.permissions.length ? p.pkg.permissions.join(', ') : '无（零权限）'
    const kindLabel = p.update ? `更新 ${p.update.oldVersion}→${p.update.newVersion}` : '安装'
    const origins = p.pkg.networkOrigins ?? []
    const originNote = origins.length ? `・联网 origin：${origins.join(', ')}` : ''
    summary.textContent = `${kindLabel} ${p.pkg.id}@${p.pkg.version}〔${p.status}〕来源 ${src}・${p.files.length} 文件・权限：${perms}${originNote}・hash ${p.hash.slice(0, 12)}`
    row.appendChild(summary)
    // 工单335 更新提案：旧→新 diff 与权限变化（批准 UI 数据面）
    if (p.update) {
      const diff = document.createElement('div')
      diff.className = 'install-diff'
      const f = p.update.files
      const permParts: string[] = []
      if (p.update.permissions.added.length) permParts.push(`+${p.update.permissions.added.join(', ')}`)
      if (p.update.permissions.removed.length) permParts.push(`-${p.update.permissions.removed.join(', ')}`)
      const fileParts: string[] = []
      if (f.changed.length) fileParts.push(`改 ${f.changed.join(', ')}`)
      if (f.added.length) fileParts.push(`增 ${f.added.join(', ')}`)
      if (f.removed.length) fileParts.push(`删 ${f.removed.join(', ')}`)
      diff.textContent = `变化：${fileParts.length ? fileParts.join('；') : '无文件变化'}・权限变化：${permParts.length ? permParts.join(' ') : '无'}`
      row.appendChild(diff)
    }
    // 工单335 旧数据继承：独立用户手势（不与代码批准合并）；未决时批准代码 = 新配置起步
    if (p.dataInheritance) {
      const inherit = document.createElement('div')
      inherit.className = 'install-inherit'
      const label = document.createElement('span')
      label.textContent = `旧数据继承（卸载残留配置）：${
        p.dataInheritance.decision === 'inherited' ? '继承——重装后读回旧数据'
          : p.dataInheritance.decision === 'fresh' ? '不继承——新配置起步' : '未决（批准代码=新配置起步）'} `
      inherit.appendChild(label)
      if (p.status === 'pending') {
        const yes = document.createElement('button')
        yes.className = 'install-inherit-yes'
        yes.textContent = '继承旧数据'
        yes.addEventListener('click', () => { void window.deck.bridge.invoke('install/inherit', { proposalId: p.proposalId, inherit: true }) })
        const no = document.createElement('button')
        no.className = 'install-inherit-no'
        no.textContent = '不继承'
        no.addEventListener('click', () => { void window.deck.bridge.invoke('install/inherit', { proposalId: p.proposalId, inherit: false }) })
        inherit.append(yes, no)
      }
      row.appendChild(inherit)
    }
    if (p.status === 'pending') {
      const ok = document.createElement('button')
      ok.className = 'install-approve'
      ok.textContent = '批准'
      ok.addEventListener('click', () => { void window.deck.bridge.invoke('install/approve', { proposalId: p.proposalId }) })
      const no = document.createElement('button')
      no.className = 'install-reject'
      no.textContent = '拒绝'
      no.addEventListener('click', () => { void window.deck.bridge.invoke('install/reject', { proposalId: p.proposalId }) })
      row.append(ok, no)
    }
    if (p.status === 'failed' && p.error) {
      const err = document.createElement('div')
      err.className = 'install-err'
      err.textContent = p.error.stateUnknown ? `${p.error.message}（结果未知，不自动重试）` : p.error.message
      row.appendChild(err)
    }
    installBar.appendChild(row)
  }
}

if (bridgeAvailable()) {
  window.deck.bridge.on('install/changed', (payload) => {
    proposals = payload.proposals
    renderInstalls()
  })
  void window.deck.bridge.invoke('install/list', null).then((res) => {
    proposals = res.proposals
    renderInstalls()
  }).catch(() => { /* 安装面未装配：静默隐藏 */ })
}

// ---------------------------------------------------------------------------
// 授权账（工单336，ADR-0025）：在册授权（含已撤销行）+ 近窗媒体读取聚合——可信内核 UI
// 的撤销手势（撤销即停：账撤销 → rescan 停用缝拆上下文；媒体 Broker 同步断供零窗口）。
// 审计聚合只有包+权限+时间窗计数（不含媒体元数据）。
// ---------------------------------------------------------------------------
const grantBar = document.getElementById('grant-bar') as HTMLElement
let grantRows: AuthorizationGrantView[] = []
let auditBuckets: MediaAuditBucketView[] = []
let auditBucketsNet: NetworkAuditBucketView[] = []

function renderGrants(): void {
  grantBar.textContent = ''
  if (!grantRows.length) {
    grantBar.style.display = 'none'
    return
  }
  grantBar.style.display = 'block'
  const hourAgo = Date.now() - 3_600_000
  for (const g of grantRows) {
    const row = document.createElement('div')
    row.className = `grant-row ${g.revokedAt ? 'revoked' : 'active'}`
    const reads = auditBuckets
      .filter((b) => b.packageId === g.packageId && b.permission === 'media.read' && b.windowStart * 1 >= hourAgo - b.windowMs)
      .reduce((acc, b) => acc + b.counts.snapshot + b.counts.thumbnail, 0)
    const summary = document.createElement('div')
    summary.className = 'grant-summary'
    const nets = auditBucketsNet.filter((b) => b.packageId === g.packageId && b.permission === 'network.request')
    const netCount = nets.reduce((acc, b) => acc + b.counts.request + b.counts.redirect + b.denied, 0)
    const originNote = (g.networkOrigins ?? []).length ? `・origin ${(g.networkOrigins ?? []).join(', ')}` : ''
    summary.textContent = `授权 ${g.packageId}〔${g.revokedAt ? '已撤销' : '生效中'}〕权限 ${g.permissions.join(', ')}${originNote}・hash ${g.codeHash.slice(0, 12)}・媒体读取（近1h）${reads} 次・网络请求（近1h）${netCount} 次`
    row.appendChild(summary)
    if (!g.revokedAt) {
      const no = document.createElement('button')
      no.className = 'grant-revoke'
      no.textContent = '撤销'
      no.addEventListener('click', () => {
        void window.deck.bridge.invoke('install/revoke', { packageId: g.packageId }).then(() => {
          void refreshGrants()
        })
      })
      row.appendChild(no)
    }
    grantBar.appendChild(row)
  }
}

function refreshGrants(): void {
  if (!bridgeAvailable()) return
  void window.deck.bridge.invoke('install/grants', null).then((res) => {
    grantRows = res.grants
    auditBuckets = res.buckets
    auditBucketsNet = res.networkBuckets ?? []
    renderGrants()
  }).catch(() => { /* 授权面未装配：静默隐藏 */ })
}
refreshGrants()

// ---------------------------------------------------------------------------
// 命名凭证（工单339，ADR-0025「凭证只发给精确匹配目标」）：可信 UI 的唯一配置面——
// 名称/头名/绑定可见，secret 只写不读（列表出口没有密文也没有明文）；绑定/解绑是
// 「包 + 凭证 + 精确 origin」三元组的显式手势；删除是销毁凭证本体的唯一入口。
// ---------------------------------------------------------------------------
const credBar = document.getElementById('cred-bar') as HTMLElement
let credRows: CredentialView[] = []

function credError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function renderCreds(): void {
  credBar.textContent = ''
  credBar.style.display = 'block'
  for (const c of credRows) {
    const row = document.createElement('div')
    row.className = 'cred-row'
    const summary = document.createElement('div')
    summary.className = 'cred-summary'
    const binds = c.bindings.length
      ? c.bindings.map((b) => `${b.packageId}@${b.origin}`).join('、')
      : '未绑定任何包'
    summary.innerHTML = `<span class="cred-name">凭证 ${c.name}</span>〔${c.headerName}〕<span class="cred-bind">${binds}</span>`
    row.appendChild(summary)
    for (const b of c.bindings) {
      const un = document.createElement('button')
      un.className = 'cred-unbind'
      un.textContent = `解绑 ${b.packageId}`
      un.addEventListener('click', () => {
        void window.deck.bridge.invoke('credentials/unbind', { packageId: b.packageId, credentialName: c.name, origin: b.origin })
          .then(() => refreshCreds())
          .catch((err) => appendCredError(err))
      })
      row.appendChild(un)
    }
    const del = document.createElement('button')
    del.className = 'cred-del'
    del.textContent = '删除凭证'
    del.addEventListener('click', () => {
      void window.deck.bridge.invoke('credentials/delete', { name: c.name })
        .then(() => refreshCreds())
        .catch((err) => appendCredError(err))
    })
    row.appendChild(del)
    credBar.appendChild(row)
  }
  // 新建/轮换（同名 = 轮换，不触发代码重批）
  const form = document.createElement('div')
  form.className = 'cred-form'
  const name = document.createElement('input')
  name.name = 'cred-name'
  name.placeholder = '凭证名'
  const secret = document.createElement('input')
  secret.name = 'cred-secret'
  secret.type = 'password'
  secret.placeholder = 'secret（只写不读）'
  const save = document.createElement('button')
  save.className = 'cred-save'
  save.textContent = '保存/轮换'
  save.addEventListener('click', () => {
    if (!name.value.trim() || !secret.value) return
    void window.deck.bridge.invoke('credentials/set', { name: name.value.trim(), secret: secret.value })
      .then(() => { secret.value = ''; return refreshCreds() })
      .catch((err) => appendCredError(err))
  })
  form.append(name, secret, save)
  credBar.appendChild(form)
  // 绑定（包 id + 凭证 + 精确 origin）
  const bindForm = document.createElement('div')
  bindForm.className = 'cred-form'
  const pkg = document.createElement('input')
  pkg.name = 'cred-package'
  pkg.placeholder = '包 id'
  const pick = document.createElement('select')
  pick.name = 'cred-pick'
  for (const c of credRows) {
    const opt = document.createElement('option')
    opt.value = c.name
    opt.textContent = c.name
    pick.appendChild(opt)
  }
  const origin = document.createElement('input')
  origin.name = 'cred-origin'
  origin.placeholder = 'http://127.0.0.1:PORT'
  const bindBtn = document.createElement('button')
  bindBtn.className = 'cred-bind-btn'
  bindBtn.textContent = '绑定'
  bindBtn.addEventListener('click', () => {
    if (!pkg.value.trim() || !pick.value || !origin.value.trim()) return
    void window.deck.bridge.invoke('credentials/bind', { packageId: pkg.value.trim(), credentialName: pick.value, origin: origin.value.trim() })
      .then(() => refreshCreds())
      .catch((err) => appendCredError(err))
  })
  bindForm.append(pkg, pick, origin, bindBtn)
  credBar.appendChild(bindForm)
}

function appendCredError(err: unknown): void {
  const line = document.createElement('div')
  line.className = 'cred-err'
  line.textContent = `凭证操作失败：${credError(err)}`
  credBar.appendChild(line)
}

function refreshCreds(): Promise<void> {
  if (!bridgeAvailable()) return Promise.resolve()
  return window.deck.bridge.invoke('credentials/list', null)
    .then((res) => { credRows = res.credentials; renderCreds() })
    .catch(() => { /* 凭证面未装配：静默隐藏 */ })
}
void refreshCreds()
