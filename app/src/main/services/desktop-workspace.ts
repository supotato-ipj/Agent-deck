// 桌面工作区服务（工单375，spec #369 决策 2 桌面工作区服务 + 决策 4 切换事务）：
// 持有桌面配对（系统桌面 ID）、当前模式（normal/agent/unmanaged 三值）、切换在途状态。
// 单飞串行切换 + 系统 ID 回读确认 + 系统侧切换的 reconciliation 观察（不抢回用户）+
// 面板/任务栏跟随兜底（公开 MoveWindowToDesktop，t371 实证路径）。
//
// 分层：FFI 采集在 desktop/virtual-desktop.ts（不可注入即失败关闭），纯裁决在
// desktop/workspace-plan.ts（vitest 矩阵），本服务只做编排、持久化与事件回推——
// 离线测试经 deps 注入假源（TaskbarService 同款纪律），零 FFI/Electron。
//
// 实验开关（spec #369 决策 29）：config agentDesktop.enabled 默认 false——开关关闭时
// 本服务 available=false，模式组不渲染、切换命令拒绝、不建桌面、不起轮询。
import { Service } from 'cordis'
import type { Context, Inject } from 'cordis'
import type { DesktopMode, DesktopWorkspaceState } from '../../shared/contract'
import { saveConfig } from '../config'
import type { AgentDesktopConfig, AppConfig } from '../config'
import {
  canPairNow,
  decideSwitch,
  firstPairing,
  modeOfCurrent,
  resolvePairing,
  switchConfirmed,
} from '../desktop/workspace-plan'
import type { DesktopSetFacts, StoredPairing } from '../desktop/workspace-plan'

export interface DesktopWorkspaceServiceOptions {
  /** 实验开关（config agentDesktop.enabled 下发；缺省 = 关，spec #369 决策 29） */
  enabled?: boolean
  /** 已存配对（config agentDesktop 两枚桌面 ID；空串按未存处理） */
  pairing?: StoredPairing | null
  /** config.json 绝对路径（缺省 = 不落盘，仅内存态——离线测试省配置桩） */
  file?: string | null
  /** 已加载的 config（可变引用：配对落盘即整份回写该对象，taskbar 同款） */
  config?: AppConfig | null
  /** reconciliation 轮询间隔（ms）；0 = 不起轮询（离线测试手动驱动） */
  pollMs?: number
  /** 切换确认预算（ms；spec #369 决策 17 预算 ≤1000，缺省 1000） */
  confirmTimeoutMs?: number
  /** 确认轮询步进（ms；缺省 60，t371 实测确认 161-360ms，步进足够密） */
  confirmPollMs?: number
  /** 依赖缝：真源缺省延迟绑定 desktop/virtual-desktop（离线测试注入假源后零 FFI） */
  deps?: {
    /** 绑定可用性（缺省延迟绑定 virtual-desktop.internalAvailable） */
    internalAvailable?: () => boolean
    /** 注册表桌面事实（单查询原子读；缺省延迟绑定，异步不阻塞主线程） */
    facts?: () => Promise<DesktopSetFacts>
    /** 新建虚拟桌面（缺省延迟绑定 CreateDesktop；失败抛错） */
    createDesktop?: () => string
    /** 切换（缺省延迟绑定 SwitchDesktop；只报告调用成败，失败抛错） */
    switchDesktop?: (id: string) => void
    /** 删除虚拟桌面（缺省延迟绑定 RemoveDesktop——零残留回收口） */
    removeDesktop?: (id: string, fallbackId?: string) => void
    /** 窗口是否在当前桌面（缺省延迟绑定公开 IsOnCurrent；null = 不可判） */
    isWindowOnCurrent?: (hwnd: number) => boolean | null
    /** 窗口迁移（缺省延迟绑定公开 MoveWindowToDesktop——跟随兜底） */
    moveWindowToDesktop?: (hwnd: number, id: string) => boolean
    /** 系统当前桌面 ID 同步口（跟随兜底的目标；缺省延迟绑定内部 COM 直读） */
    currentId?: () => string | null
    /** 跟随窗清单（面板/任务栏/（后续）胶囊；生产装配按当前 hwnd 惰性供给） */
    followTargets?: () => Array<{ hwnd: number; label: string }>
  }
}

interface WorkspaceDeps {
  internalAvailable: () => boolean
  facts: () => Promise<DesktopSetFacts>
  createDesktop: () => string
  switchDesktop: (id: string) => void
  removeDesktop: (id: string, fallbackId?: string) => void
  isWindowOnCurrent: (hwnd: number) => boolean | null
  moveWindowToDesktop: (hwnd: number, id: string) => boolean
  currentId: () => string | null
  followTargets: () => Array<{ hwnd: number; label: string }>
}

const DEFAULT_POLL_MS = 500
const DEFAULT_CONFIRM_TIMEOUT_MS = 1000
const DEFAULT_CONFIRM_POLL_MS = 60

/**
 * 桌面工作区服务（工单375）：shared state 的持有者。事件回推 'workspace/changed'——
 * 面板、任务栏与（后续）胶囊订阅同一份，不为两个桌面复制面板内容（spec 决策 5）。
 * 切换事务（spec 决策 4）：单飞串行（在途忽略连点）→ COM SwitchDesktop → 系统 ID
 * 回读确认（注册表 + 内部 COM 双源，预算 ≤1s）→ 命中才提交 UI；失败保持现状并携带
 * 提示。系统快捷键/TaskView 造成的切换经 reconciliation 轮询观察回推，绝不因此调
 * SwitchDesktop 抢回（用户故事 11）。
 */
export class DesktopWorkspaceService extends Service {
  static inject: Inject = {} // 无内核服务依赖（事件广播走 ctx.emit）

  private readonly file: string | null
  private readonly appConfig: AppConfig | null
  private readonly deps: WorkspaceDeps
  private readonly pollMs: number
  private readonly confirmTimeoutMs: number
  private readonly confirmPollMs: number
  private readonly enabledFlag: boolean
  private pairing: StoredPairing | null
  private currentMode: DesktopMode = 'unmanaged'
  private switching = false
  private target: 'normal' | 'agent' | null = null
  private lastError: string | null = null
  private startPromise: Promise<void> | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private reconciling = false

  constructor(ctx: Context, options: DesktopWorkspaceServiceOptions = {}) {
    super(ctx, 'desktopWorkspace')
    this.enabledFlag = options.enabled ?? false
    this.file = options.file ?? null
    this.appConfig = options.config ?? null
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS
    this.confirmTimeoutMs = options.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS
    this.confirmPollMs = options.confirmPollMs ?? DEFAULT_CONFIRM_POLL_MS
    this.pairing = options.pairing?.normalId || options.pairing?.agentId ? { ...options.pairing } : null
    this.deps = {
      internalAvailable: options.deps?.internalAvailable
        ?? (() => (require('../desktop/virtual-desktop') as typeof import('../desktop/virtual-desktop')).internalAvailable()),
      facts: options.deps?.facts
        ?? (async () => {
          const vd = require('../desktop/virtual-desktop') as typeof import('../desktop/virtual-desktop')
          const reg = await vd.registryDesktopFacts()
          return { ids: reg.ids, current: reg.current, internalCurrent: vd.internalCurrentDesktopId() }
        }),
      createDesktop: options.deps?.createDesktop
        ?? (() => (require('../desktop/virtual-desktop') as typeof import('../desktop/virtual-desktop')).createDesktop()),
      switchDesktop: options.deps?.switchDesktop
        ?? ((id) => (require('../desktop/virtual-desktop') as typeof import('../desktop/virtual-desktop')).switchDesktop(id)),
      removeDesktop: options.deps?.removeDesktop
        ?? ((id, fallbackId) => (require('../desktop/virtual-desktop') as typeof import('../desktop/virtual-desktop')).removeDesktop(id, fallbackId)),
      isWindowOnCurrent: options.deps?.isWindowOnCurrent
        ?? ((hwnd) => (require('../desktop/virtual-desktop') as typeof import('../desktop/virtual-desktop')).isWindowOnCurrentDesktop(hwnd)),
      moveWindowToDesktop: options.deps?.moveWindowToDesktop
        ?? ((hwnd, id) => (require('../desktop/virtual-desktop') as typeof import('../desktop/virtual-desktop')).moveWindowToDesktop(hwnd, id)),
      currentId: options.deps?.currentId
        ?? (() => (require('../desktop/virtual-desktop') as typeof import('../desktop/virtual-desktop')).internalCurrentDesktopId()),
      followTargets: options.deps?.followTargets ?? (() => []),
    }
    // 装配即起跑（幂等）：开关关闭 = 零桌面零轮询（start 内失败关闭）；重复调用共用
    // 同一在途 Promise（离线测试 await svc.start() 即可对齐装配期已起跑的那一轮）。
    void this.start()
  }

  /** 生产装配注册跟随窗清单（面板/任务栏 hwnd 惰性供给——窗随启停生灭，不能建服务时定死） */
  registerFollowTargets(fn: () => Array<{ hwnd: number; label: string }>): void {
    this.deps.followTargets = fn
  }

  /** 只读投影（面板/任务栏/胶囊共享；BridgeService workspace/get-state 与回推共用） */
  state(): DesktopWorkspaceState {
    return {
      available: this.available(),
      paired: Boolean(this.pairing?.normalId && this.pairing?.agentId),
      current: this.currentMode,
      switching: this.switching,
      target: this.target,
      lastError: this.lastError,
    }
  }

  /** 功能在场 = 实验开关开 + 内部 COM 绑定可用（失败关闭，spec 决策 30） */
  private available(): boolean {
    return this.enabledFlag && this.deps.internalAvailable()
  }

  /**
   * 启动（构造期自起跑；重复调用共用同一在途 Promise）：开关关闭 = 不做任何事
   * （零桌面、零轮询、投影 available:false）。开启则核对手上配对与系统事实、对账
   * 当前模式、起 reconciliation 轮询。
   */
  start(): Promise<void> {
    if (!this.startPromise) this.startPromise = this.doStart()
    return this.startPromise
  }

  private async doStart(): Promise<void> {
    if (!this.available()) {
      this.ctx.emit('workspace/changed', this.state())
      return
    }
    await this.reconcileNow()
    if (this.pollMs > 0) this.pollTimer = setInterval(() => void this.reconcileNow(), this.pollMs)
    this.ctx.emit('workspace/changed', this.state())
  }

  /** 测试观察缝：当前持有的配对（工单52 storeForTest 同款） */
  pairingForTest(): StoredPairing | null {
    return this.pairing ? { ...this.pairing } : null
  }

  /**
   * 模式切换（spec #369 决策 4 切换事务）：未配对先配对（普通 = 当下所在桌面，
   * Agent 新建首次为空）→ 单飞串行 → COM 切换 → 系统 ID 回读确认（双源，预算 ≤1s）
   * → 命中才提交 UI。在途请求被忽略（ok:false，验收③连点口径）；失败保持现状并提示。
   */
  async switchTo(mode: 'normal' | 'agent'): Promise<{ ok: boolean; state: DesktopWorkspaceState; error?: string }> {
    if (!this.available()) {
      const error = '桌面工作区未启用（实验开关关闭或平台能力不可用）'
      this.lastError = error
      this.ctx.emit('workspace/changed', this.state())
      return { ok: false, state: this.state(), error }
    }
    // 在途单飞：本轮请求直接忽略，不动在途账（验收③连点口径——界面与实际桌面不分裂）
    if (this.switching) {
      return { ok: false, state: this.state(), error: '切换在途，已忽略连点' }
    }
    const decision = decideSwitch({ switching: false, pairing: this.pairing, current: this.currentMode }, mode)
    if (decision.action === 'no-op') return { ok: true, state: this.state() }
    this.switching = true
    this.target = mode
    this.lastError = null
    this.ctx.emit('workspace/changed', this.state()) // 在途态即时上屏（入口禁用/忽略连点的 UI 事实）
    try {
      if (!this.pairing?.normalId || !this.pairing?.agentId) {
        const paired = await this.pairNow()
        if (!paired.ok) {
          this.lastError = paired.error ?? '配对失败'
          return { ok: false, state: this.state(), error: this.lastError }
        }
      }
      const targetId = mode === 'agent' ? this.pairing!.agentId : this.pairing!.normalId
      try {
        this.deps.switchDesktop(targetId)
      } catch (err) {
        const error = `切换失败：${err instanceof Error ? err.message : String(err)}`
        this.lastError = error
        return { ok: false, state: this.state(), error }
      }
      const confirmed = await this.confirmSwitch(targetId)
      if (!confirmed.ok) {
        // 失败保持现状（current 不动——UI 与实际桌面不分裂的前提），仅提示
        this.lastError = confirmed.error ?? '切换未确认——已保持原桌面'
        return { ok: false, state: this.state(), error: this.lastError }
      }
      this.currentMode = mode
      this.lastError = null
      this.ensureFollow()
      return { ok: true, state: this.state() }
    } finally {
      this.switching = false
      this.target = null
      this.ctx.emit('workspace/changed', this.state())
    }
  }

  /** 确认轮询：注册表当前 + 内部 COM 双源都命中目标才算确认（workspace-plan 判据） */
  private async confirmSwitch(targetId: string): Promise<{ ok: boolean; error?: string }> {
    const deadline = Date.now() + this.confirmTimeoutMs
    let lastDetail = '系统桌面 ID 不可读'
    for (;;) {
      const facts = await this.deps.facts()
      if (facts.current) {
        if (switchConfirmed(facts, targetId)) return { ok: true }
        lastDetail = `系统桌面 ID 不匹配（当前=${facts.current} 目标=${targetId}）`
      }
      if (Date.now() > deadline) return { ok: false, error: `切换未确认：${lastDetail}——已保持原桌面` }
      await sleep(this.confirmPollMs)
    }
  }

  /**
   * 首次配对（验收①）：普通 = 启用当下所在桌面（既有窗口不迁移），Agent = 新建
   * （首次为空）。新建即持有回收义务（t371 残差纪律）：配对成功必须落盘——写盘失败
   * 按失败处理并尽力回收新建桌面，不留孤儿。
   */
  private async pairNow(): Promise<{ ok: boolean; error?: string }> {
    const facts = await this.deps.facts()
    if (!canPairNow(facts)) {
      return { ok: false, error: '系统桌面事实不可读——无法建立配对（失败关闭）' }
    }
    const normalId = facts.current!
    let agentId: string
    try {
      agentId = this.deps.createDesktop()
    } catch (err) {
      return { ok: false, error: `创建 Agent 桌面失败：${err instanceof Error ? err.message : String(err)}` }
    }
    // 新建回读核验：Agent ID 必须进入系统集合（乐观创建不认账——t371 判定纪律）
    const after = await this.deps.facts()
    if (!after.ids.includes(agentId)) {
      this.tryRemoveDesktop(agentId, normalId)
      return { ok: false, error: '新建 Agent 桌面未进入系统集合（回读核验失败），已回收' }
    }
    const previous = this.pairing
    this.pairing = firstPairing(normalId, agentId)
    if (!this.persistPairing()) {
      // 落盘失败：回滚内存配对并尽力回收新建桌面（不留孤儿、不假装配对成功）
      this.pairing = previous
      this.tryRemoveDesktop(agentId, normalId)
      return { ok: false, error: '配对落盘失败——已回收新建桌面（下次重试配对）' }
    }
    this.currentMode = modeOfCurrent(facts, this.pairing)
    return { ok: true }
  }

  /** 回收尽力口（配对失败路径的孤儿桌面清理；删除失败如实留在提示外——探针纪律） */
  private tryRemoveDesktop(id: string, fallbackId: string): void {
    try {
      this.deps.removeDesktop(id, fallbackId)
    } catch { /* 删除失败：不留谎话（零残留断言在真机轮兜底） */ }
  }

  /** 配对落盘（config agentDesktop 段整份回写；写失败返回 false 由调用方处置） */
  private persistPairing(): boolean {
    if (!this.file || !this.appConfig) return true // 无落盘面（离线测试）：内存态即真源
    const section: AgentDesktopConfig = {
      enabled: this.enabledFlag,
      normalDesktopId: this.pairing?.normalId ?? '',
      agentDesktopId: this.pairing?.agentId ?? '',
    }
    try {
      saveConfig(this.file, { ...this.appConfig, agentDesktop: section })
      this.appConfig.agentDesktop = section
      return true
    } catch {
      return false
    }
  }

  /**
   * reconciliation 一拍（spec #369 决策 4「系统快捷键造成的切换也经同一事实
   * reconciliation，不抢回用户」）：读系统事实 → 核对配对 → 映射当前模式 → 变化即
   * 回推。绝不调 SwitchDesktop——用户经 Win+Ctrl+方向/TaskView 去哪个桌面都尊重。
   * 配对身份失效（桌面被删）→ 未配对安全态（不自动重建、不吞并残留桌面）。
   */
  async reconcileNow(): Promise<void> {
    if (!this.available() || this.reconciling) return
    this.reconciling = true
    try {
      const facts = await this.deps.facts()
      if (!facts.ids.length) return // 本拍事实不可读：沿用上一拍（不猜）
      const resolution = resolvePairing(this.pairing, facts)
      const prevMode = this.currentMode
      const prevPaired = Boolean(this.pairing?.normalId && this.pairing?.agentId)
      if (resolution.kind === 'ok') {
        this.pairing = resolution.pairing
      } else if (resolution.kind === 'partial') {
        // 单侧失效：保留在册侧，等下次显式配对补齐；当前模式按余下配对映射
        this.pairing = resolution.pairing.normalId || resolution.pairing.agentId ? resolution.pairing : null
      } else {
        this.pairing = null
      }
      this.currentMode = modeOfCurrent(facts, this.pairing)
      if (this.currentMode !== prevMode || prevPaired !== Boolean(this.pairing?.normalId && this.pairing?.agentId)) {
        this.ensureFollow()
        this.ctx.emit('workspace/changed', this.state())
      }
    } finally {
      this.reconciling = false
    }
  }

  /**
   * 跟随兜底（t371 生产待验证项的收敛口）：NOACTIVATE 弹窗（面板/任务栏常态形态）
   * 原生跨桌面在场、无需动作；键盘模式 focusable 翻转后窗口退化为 desktop-bound 时，
   * 经公开 MoveWindowToDesktop 迁到系统当前桌面。只迁自家窗（followTargets 由生产装配
   * 供给），系统 ID 不可读时不动（不猜目标）。
   */
  ensureFollow(): void {
    // 同步快照口：facts 是异步的——跟随兜底走内部 COM 直读（同步、廉价）
    let currentId: string | null = null
    try {
      currentId = this.deps.currentId()
    } catch { /* 不可判不动 */ }
    if (!currentId) return
    for (const t of this.deps.followTargets()) {
      if (!t.hwnd) continue
      let on: boolean | null = null
      try {
        on = this.deps.isWindowOnCurrent(t.hwnd)
      } catch { on = null }
      if (on === false) {
        try {
          this.deps.moveWindowToDesktop(t.hwnd, currentId)
        } catch { /* 迁移失败不动——自动跟随常态兜底，失败不追 */ }
      }
    }
  }

  /** 停表（插件卸载/测试收尾）：轮询停，状态清零回推一帧禁用态 */
  protected stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    this.switching = false
    this.target = null
    this.ctx.emit('workspace/changed', this.state())
  }

  /** 测试驱动口（离线矩阵手动触发 reconciliation，refreshRecommendations 同款纪律） */
  testPollMs(): number {
    return this.pollMs
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
