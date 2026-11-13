// 对话窗渲染层（工单332 聊天型 / 工单333 管理型叠加；工单364 初始化门禁与发送反馈）：
// 纯呈现与输入（GLOSSARY「对话窗」）。动作全部经内核桥接契约（create/prompt/cancel/permission/
// end/resume），渲染层不解释协议方言——工具与权限条目按原样载荷呈现，权限裁决只回用户点中的
// optionId（绝不超时自动拒绝，ADR-0018）。
// 管理型（工单333）：「管理」勾选 = 用户显式授权（逐会话、不持久化）；创建失败在窗内
// 显式报错并给「以聊天型创建」按钮——绝不静默降级（ADR-0018 全有或全无）。
//
// **权威视图 vs UI 本地态**（工单364 复审：头注释此前与实现脱节，此处写准）：
//   · 权威视图 = conversation/changed 推送过来的**全量会话视图**（会话列表、转写、状态、
//     usage、会话级 error、回合级 promptFailure）。它是唯一的事实来源。
//   · UI 本地态 = 只活在本渲染层、**不冒充事实**的三样东西：
//       ① initState/initError —— 初始化门禁（页面尚未与内核接上时输入与发送保持禁用）；
//       ② pendingSend     —— 受理前的**乐观回显**（点了发送立刻看见自己的消息）；
//       ③ awaitingTurn    —— 在途回合的账（回合失败时据此恢复草稿）。
//   · 本地态如何让位于权威推送：乐观回显在权威转写里出现同一条用户消息时自动退场
//     （syncPendingSend）；在途回合在权威视图出现 agent 回复或回合失败标记时收束
//     （syncAwaitingTurn）；初始化门禁在首份推送到达时转为 ready（推送到达即证明桥接在位）。
//   · 本地态**不改写**权威视图：回合失败落在权威视图的独立字段 promptFailure 上，
//     会话级失败原因仍在 view.error（两者不是一件事，渲染层不拿回合的成败改写会话的结局）。
//
// 工单364（初始化门禁 + 发送反馈）：
// - 静态初始态禁用输入与发送（HTML 层）；初始化成功后才按当前会话状态开放。初始化失败
//   （preload 未装配/桥接拒绝/回执形状异常）有可见诊断——绝不退化成无存证的「什么都没发生」
//   （现场根因：preload 缺席时模块在 window.deck 处抛错中止，页面留下能点却无反应的按钮）。
// - 无会话：明确指导「请先创建会话」，输入与按钮状态与指导一致；发送尝试不静默。
// - 有会话：点发送与按 Enter 都立即回显用户输入并进入「回复中」；权威转写仍经既有变化推送
//   刷新（不建第二条发送链）。桥接拒绝/同步异常/后端回合失败一律可见报错并恢复草稿；
//   不自动重试、不自动新建会话、不切换后端、不动 DSH 数据目录。
import type { AuthorizationGrantView, BridgeMethod, BridgeMethods, ConversationSessionView, ConversationTranscriptEntry, CredentialView, InstallProposalView, MediaAuditBucketView, NetworkAuditBucketView } from '../shared/contract'

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
/**
 * 工单364：动作失败可见（**统一呈现口**）。
 *
 * 此前只有 sendError 一处，且创建失败写状态行——状态行每次 render 都被覆写，写那里等于没写
 * （创建失败其实是无声的）。故归一为一个字段，消息在**调用点**带上自己的前缀
 * （发送失败／创建失败／取消失败……），转写里一条错误横幅呈现。
 */
let actionError: string | null = null
/** 工单364：受理前的本地乐观回显（权威转写到达后自动让位，不重复显示） */
let pendingSend: { sessionId: string; text: string; expectedUserCount: number } | null = null
/**
 * 工单364：已受理但未收束的回合（回合失败时据此恢复草稿——失败可见且草稿不丢）。
 *
 * 判据用**计数与序号**，不靠文案相等：权威转写里的 agent 条目变多 = 回合有回复；
 * 权威视图的 promptFailure.seq 变大 = **新一轮**回合失败（同一句话连来两次时，
 * 文案相等判据会漏判，草稿就此丢失——故用单调递增的序号）。
 */
let awaitingTurn: { sessionId: string; text: string; expectedAgentCount: number; failureSeqAtSend: number } | null = null
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

/**
 * 桥接调用的统一包装（工单364）：三处「bridgeAvailable() + catch 静默」形状归一。
 *
 * 返回两态：{ ok: true, value } / { ok: false, error }——**调用方**决定这条失败要不要呈现：
 *   · 初始化链与发送链：一律呈现（绝不静默吞掉——ADR-0018「绝不静默降级」）；
 *   · install/credentials 面（工单334/335/336/339 的地盘，与本票无关）：沿用既有行为面——
 *     失败即安静退场，**不改变**它们既有的用户可见行为（守卫非留不可：面板未装配该面时
 *     调用必然失败，抛出去只会变成未处理拒绝＝另一种静默）。
 */
async function bridgeCall<M extends BridgeMethod>(
  method: M,
  payload: BridgeMethods[M]['request'],
): Promise<{ ok: true; value: BridgeMethods[M]['response'] } | { ok: false; error: string }> {
  if (!bridgeAvailable()) return { ok: false, error: '内核桥接未就绪（preload 未装配）' }
  try {
    const value = await window.deck.bridge.invoke(method, payload)
    return { ok: true, value }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
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
 * 工单364：回合收束判定——回合失败（权威视图的回合级失败序号变大）→ 恢复草稿；
 * 回合有回复 → 正常收束。失败原因本身由权威视图呈现（错误横幅），此处只负责把草稿放回输入框。
 */
function syncAwaitingTurn(view: ConversationSessionView | null): void {
  if (!awaitingTurn || !view || view.id !== awaitingTurn.sessionId) return
  const failureSeq = view.promptFailure?.seq ?? 0
  if (failureSeq > awaitingTurn.failureSeqAtSend) {
    const text = awaitingTurn.text
    awaitingTurn = null
    restoreDraft(text)
    return
  }
  if (agentEntryCount(view) >= awaitingTurn.expectedAgentCount) awaitingTurn = null
}

/**
 * 草稿恢复（工单364）：失败的一轮**不丢**用户输入。
 *
 * 输入框此刻可能已有用户在等待期敲下的新内容——那是要**并入**，不是覆盖：直接覆盖等于把
 * 用户新敲的字抹掉（那才是真的静默丢失）。空框时原样放回，非空时追加在后面。
 */
function restoreDraft(text: string): void {
  const cur = inputEl.value
  inputEl.value = cur.trim() ? `${cur}\n${text}` : text
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
          if (!s) return
          void bridgeCall('conversation/permission', { sessionId: s.id, optionId: opt.optionId }).then((r) => {
            if (r.ok) return
            actionError = `权限裁决失败：${r.error}`
            render()
          })
        })
        actions.appendChild(b)
      }
      const cancelBtn = document.createElement('button')
      cancelBtn.textContent = '取消本回合'
      cancelBtn.addEventListener('click', () => {
        const s = current()
        if (!s) return
        void bridgeCall('conversation/cancel', { sessionId: s.id }).then((r) => {
          if (r.ok) return
          actionError = `取消失败：${r.error}`
          render()
        })
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
    // 工单364：回合级失败走**独立字段**（会话级原因 view.error 原义不动，两者不是一件事）
    if (view.promptFailure) {
      transcriptEl.appendChild(errorEntry(view.promptFailure.message))
    }
    if (view.status === 'failed') {
      const resumeBtn = document.createElement('button')
      resumeBtn.textContent = '续接本会话'
      resumeBtn.addEventListener('click', () => {
        void bridgeCall('conversation/resume', { sessionId: view.id }).then((r) => {
          if (r.ok) return
          actionError = `续接失败：${r.error}`
          render()
        })
      })
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
  // 工单364：动作失败统一呈现口（发送/创建/取消/裁决……的失败都在这里，不静默消失）
  if (actionError) {
    transcriptEl.appendChild(errorEntry(actionError))
    transcriptEl.scrollTop = transcriptEl.scrollHeight
  }
  if (managedFailed) {
    const banner = document.createElement('div')
    banner.className = 'entry error-banner'
    banner.textContent = `管理型创建失败${managedError ? `：${managedError}` : ''}（全有或全无，未创建会话）。可显式选择以聊天型创建：`
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
/** 管理型创建失败的原因（横幅上要看得见，不能只有一句「创建失败」） */
let managedError: string | null = null

async function createSession(): Promise<void> {
  if (!bridgeAvailable()) {
    setInitFailed('内核桥接未就绪（preload 未装配）')
    render()
    return
  }
  const managed = chkManaged.checked
  const called = await bridgeCall('conversation/create', { managed })
  // 工单364：初始化链上的失败必须**可见**——此前桥接拒绝是未处理拒绝（等于无声），
  // 而「创建失败」写状态行也会被下一次 render 覆写。两处都改成转写里的错误横幅。
  if (!called.ok) {
    actionError = `创建失败：${called.error}`
    render()
    return
  }
  const res = called.value
  if (res.ok && res.session) {
    managedFailed = false
    managedError = null
    actionError = null
    activeId = res.session.id
  } else if (managed && res.canRetryAsChat) {
    managedFailed = true
    managedError = res.error ?? '管理型创建失败'
  } else {
    actionError = `创建失败：${res.error ?? '内核未受理本次创建'}`
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
  if (!s) return
  void bridgeCall('conversation/cancel', { sessionId: s.id }).then((r) => {
    if (r.ok) return
    actionError = `取消失败：${r.error}`
    render()
  })
})
btnEnd.addEventListener('click', () => {
  const s = current()
  if (!s) return
  void bridgeCall('conversation/end', { sessionId: s.id }).then((r) => {
    if (r.ok) return
    actionError = `结束会话失败：${r.error}`
    render()
  })
})
// 工单340（ADR-0026）：显式创建全新 DSH 数据目录——用户手势，旧目录原样保留、新目录不继承旧会话
btnFreshDir.addEventListener('click', () => {
  void bridgeCall('conversation/new-data-dir', null).then((r) => {
    if (!r.ok) {
      actionError = `切换全新数据目录失败：${r.error}`
      render()
      return
    }
    const res = r.value
    if (res.ok) {
      statusEl.textContent = `已切换全新数据目录：${res.dshHome}（旧目录 ${res.previous} 原样保留）`
    } else {
      actionError = `切换全新数据目录失败：${res.error ?? '全新数据目录创建失败'}`
      render()
    }
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
    actionError = '发送失败：对话窗尚未初始化完成——请重开对话窗后再发送'
    render()
    return
  }
  inputEl.value = ''
  actionError = null
  noSessionNotice = false
  pendingSend = { sessionId: s.id, text, expectedUserCount: userEntryCount(s) + 1 }
  render()
  const called = await bridgeCall('conversation/prompt', { sessionId: s.id, text })
  if (!called.ok) {
    failSend(text, called.error)
    return
  }
  const res = called.value
  if (!res || !res.ok) {
    failSend(text, res?.error ?? '内核未受理本次发送')
    return
  }
  // 受理成功：权威转写经既有变化推送到达，本地回显届时让位；
  // 记下本回合——回合失败时据此恢复草稿（失败可见、草稿不丢）
  awaitingTurn = {
    sessionId: s.id,
    text,
    expectedAgentCount: agentEntryCount(s) + 1,
    // 回合失败判据的基准：发送那一刻的回合失败序号（之后序号变大 = 新一轮失败）
    failureSeqAtSend: s.promptFailure?.seq ?? 0,
  }
  render()
}

/** 工单364：发送失败可见 + 恢复草稿（不静默丢失；绝不自动重试） */
function failSend(text: string, message: string): void {
  pendingSend = null
  actionError = `发送失败：${message}`
  // 草稿**并入**输入框（等待期用户新敲的内容不被覆盖，两份都在）
  restoreDraft(text)
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
    const called = await bridgeCall('conversation/list', null)
    if (!called.ok) throw new Error(called.error)
    if (!called.value || !Array.isArray(called.value.sessions)) throw new Error('会话清单回执形状异常')
    sessions = called.value.sessions
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
  // install 面（工单334/335/336/338 的地盘，与本票无关）：失败安静退场——既有行为面不变，
  // 这里只把「catch 静默」形状归一到统一包装（守卫非留不可：面板未装配该面时调用必失败）
  void bridgeCall('install/list', null).then((r) => {
    if (!r.ok) return
    proposals = r.value.proposals
    renderInstalls()
  })
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
  // 授权面（与本票无关）：失败安静退场——既有行为面不变，只归一调用形状
  void bridgeCall('install/grants', null).then((r) => {
    if (!r.ok) return
    grantRows = r.value.grants
    auditBuckets = r.value.buckets
    auditBucketsNet = r.value.networkBuckets ?? []
    renderGrants()
  })
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
    summary.innerHTML = `<span class="cred-name">凭证 ${c.name}</span>〔${c.type === 'oauth' ? 'oauth 自动刷新' : c.headerName}〕<span class="cred-bind">${binds}</span>`
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
  // 新建/轮换（同名 = 轮换，不触发代码重批）；类型选择（工单348：静态值/oauth 自动刷新）——
  // oauth 型切换出 tokenEndpoint/clientId/scope 字段（clientSecret 复用 secret 输入，只写不读）；
  // headerName/valuePrefix 不上表单（走缺省，与静态面现状对称）。校验与单块加密归凭证库。
  const form = document.createElement('div')
  form.className = 'cred-form'
  const name = document.createElement('input')
  name.name = 'cred-name'
  name.placeholder = '凭证名'
  const kind = document.createElement('select')
  kind.name = 'cred-type'
  kind.className = 'cred-type'
  for (const [v, label] of [['static', '静态值'], ['oauth', 'OAuth（自动刷新）']] as const) {
    const opt = document.createElement('option')
    opt.value = v
    opt.textContent = label
    kind.appendChild(opt)
  }
  const secret = document.createElement('input')
  secret.name = 'cred-secret'
  secret.type = 'password'
  secret.placeholder = 'secret（只写不读）'
  const tokenEndpoint = document.createElement('input')
  tokenEndpoint.name = 'cred-token-endpoint'
  tokenEndpoint.placeholder = '发证地址（如 https://issuer.example.com/oauth/token）'
  const clientId = document.createElement('input')
  clientId.name = 'cred-client-id'
  clientId.placeholder = 'clientId'
  const scope = document.createElement('input')
  scope.name = 'cred-scope'
  scope.placeholder = 'scope（可选）'
  const oauthFields = [tokenEndpoint, clientId, scope]
  const syncKind = (): void => {
    const oauth = kind.value === 'oauth'
    for (const f of oauthFields) f.style.display = oauth ? '' : 'none'
    secret.placeholder = oauth ? 'clientSecret（只写不读）' : 'secret（只写不读）'
  }
  kind.addEventListener('change', syncKind)
  syncKind()
  const save = document.createElement('button')
  save.className = 'cred-save'
  save.textContent = '保存/轮换'
  save.addEventListener('click', () => {
    if (!name.value.trim() || !secret.value) return
    const payload = kind.value === 'oauth'
      ? { name: name.value.trim(), secret: secret.value, type: 'oauth' as const, tokenEndpoint: tokenEndpoint.value.trim(), clientId: clientId.value.trim(), scope: scope.value.trim() }
      : { name: name.value.trim(), secret: secret.value }
    void window.deck.bridge.invoke('credentials/set', payload)
      .then(() => {
        secret.value = ''
        tokenEndpoint.value = ''
        clientId.value = ''
        scope.value = ''
        return refreshCreds()
      })
      .catch((err) => appendCredError(err))
  })
  form.append(name, kind, secret, ...oauthFields, save)
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
  // 凭证面（与本票无关）：失败安静退场——既有行为面不变，只归一调用形状
  return bridgeCall('credentials/list', null)
    .then((r) => {
      if (!r.ok) return
      credRows = r.value.credentials
      renderCreds()
    })
}
void refreshCreds()
