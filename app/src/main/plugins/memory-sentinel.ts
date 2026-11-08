import {
  MEMORY_SENTINEL_CONFIRM_ROUNDS,
  MEMORY_SENTINEL_INTERVAL_MS,
  PACKAGE_MARGINAL_MEMORY_BUDGET_BYTES,
} from './budget'

/**
 * 包内存哨兵（工单344，ADR-0027 内存半边的运行时闸门）——纯逻辑判账账本。
 *
 * 预算目录里「每包 128MB」此前只有数量半边有运行时处置（第 17 个包当场拒绝），
 * 内存半边只是挂墙上的尺子。本模块把内存半边变成闸门：某个在场投放包**首次**越过
 * 预算线 → 告警（用户可见 toast + 存证事件，留给用户自己动手的窗口）；**连续 3 轮**
 * 仍超线（10s×3 ≈ 30 秒滞回确认窗）→ 显式停用（停用补偿在 PluginHostService
 * disableDroppedPackageForMemory：包进错误态、渲染进程销毁、账/包文件不动、不自动重挂）。
 *
 * 模块形态（identity 一线既有样式）：只吃数字不碰 Electron——
 * - `PackagePidRegistry`：pid↔包对照表的纯逻辑半边（宿主层事实，不进 identity 登记表）；
 * - `projectSample`：采样投影（pid 对照 + 读数函数 → 每包每轮读数；pid 缺失/读数缺失
 *   → bytes=null **放行留证**，宁可漏报不误杀）；
 * - `PackageMemorySentinelLedger`：阈值滞回判账（首次超限=告警、连续 N 轮=停用、
 *   中断回落=重新计数）；
 * - `PackageMemorySentinel`：采样薄壳（定时器 + 动作分发），生产装配注入真实读数。
 *
 * **唯一新缝 = 内存读数函数注入**（与「包数上限可注入」同族，ADR-0027 本就写了测试
 * 可注入）：生产 = `app.getAppMetrics()` 按 pid 读工作集（与 diag/memory 同一事实源），
 * 测试 = 罐头读数。本文件不 import Electron（硬规矩）。
 */

/** 一条 pid↔包对照（宿主层事实：webContents → OS pid，换代即换 pid） */
export interface PackagePidEntry {
  packageId: string
  pid: number
}

/** 一包一轮的内存读数（bytes=null = 读数缺失：放行留证，不处置） */
export interface MemoryReading {
  packageId: string
  bytes: number | null
}

/** 一轮判账吐出的动作（告警/停用；载荷含读数与阈值——全程不静默） */
export type SentinelAction =
  | { type: 'alert'; packageId: string; bytes: number; thresholdBytes: number }
  | { type: 'deactivate'; packageId: string; bytes: number; thresholdBytes: number; rounds: number }

/** 采样留证注记（读数缺失时的放行凭据） */
export interface MemorySentinelSampleNote {
  packageId: string
  /** pid 缺失（对照表没登记/已摘除）= null；有 pid 但读不到工作集也是 bytes=null */
  pid: number | null
  bytes: null
}

/**
 * pid↔包对照表（纯逻辑半边；宿主层持有实例，激活登记、换代覆盖、停用摘除）。
 * Map 查表防原型链（09 踩坑 1 的纪律）。
 */
export class PackagePidRegistry {
  private readonly pids = new Map<string, number>()

  /** 登记（同包重复登记 = 换代换 pid，覆盖旧值） */
  record(packageId: string, pid: number): void {
    this.pids.set(packageId, pid)
  }

  /** 摘除（停用/消失时；幂等） */
  remove(packageId: string): void {
    this.pids.delete(packageId)
  }

  /** 反查单包 pid（未登记 = null） */
  pidOf(packageId: string): number | null {
    return this.pids.get(packageId) ?? null
  }

  /** 全量对照快照（采样投影的事实源） */
  entries(): PackagePidEntry[] {
    return [...this.pids].map(([packageId, pid]) => ({ packageId, pid }))
  }

  /** 在册总数（诊断读数） */
  size(): number {
    return this.pids.size
  }
}

/**
 * 采样投影（单测矩阵 1）：在场包 id 集 + pid 对照 + 读数函数 → 每包每轮读数。
 * pid 缺失（对照表没登记）或读数函数拿不到工作集（进程刚崩、时序缝隙）→ bytes=null
 * 放行留证——不处置，宁可漏报不误杀。
 */
export function projectSample(
  liveIds: readonly string[],
  entries: readonly PackagePidEntry[],
  read: (pid: number) => number | null,
): MemoryReading[] {
  const pidByPackage = new Map(entries.map((e) => [e.packageId, e.pid]))
  return liveIds.map((packageId) => {
    const pid = pidByPackage.get(packageId)
    if (pid === undefined) return { packageId, bytes: null }
    const raw = read(pid)
    const bytes = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null
    return { packageId, bytes }
  })
}

/** 哨兵参数（缺省 = budget.ts 单一正典：128MB / 3 轮） */
export interface PackageMemorySentinelParams {
  /** 预算线（字节；哨兵与契约 resourceLimits 共用同一常量，不出现第二把尺） */
  thresholdBytes?: number
  /** 连续超线停用轮数 */
  rounds?: number
}

/**
 * 阈值滞回判账（单测矩阵 3）：输入「每包每轮读数」，输出「告警/停用动作」。
 * - 首次超线 = 告警不处置（留给用户自己动手的窗口）；
 * - 连续 rounds 轮超线 = 停用（确认窗走满）；
 * - 回落到线内 = 重新计数（再超线即新 episode，重新告警）；
 * - 读数缺失 = 放行（不动计数——宁可漏报不误杀）。
 */
export class PackageMemorySentinelLedger {
  readonly thresholdBytes: number
  readonly rounds: number
  /** 包 id → 当前连续超线轮数（未超线/已停用即出表） */
  private readonly streaks = new Map<string, number>()

  constructor(params: PackageMemorySentinelParams = {}) {
    this.thresholdBytes = params.thresholdBytes ?? PACKAGE_MARGINAL_MEMORY_BUDGET_BYTES
    this.rounds = params.rounds ?? MEMORY_SENTINEL_CONFIRM_ROUNDS
  }

  /** 停用/离场后清账（防旧计数串到重新投放的新 episode） */
  forget(packageId: string): void {
    this.streaks.delete(packageId)
  }

  /** 一轮判账：吃投影读数，吐动作（每包每轮至多一个动作） */
  observe(readings: readonly MemoryReading[]): SentinelAction[] {
    const actions: SentinelAction[] = []
    for (const reading of readings) {
      if (reading.bytes === null) continue // 读数缺失放行（留证在采样壳）
      if (reading.bytes > this.thresholdBytes) {
        const n = (this.streaks.get(reading.packageId) ?? 0) + 1
        this.streaks.set(reading.packageId, n)
        if (n === 1) {
          actions.push({ type: 'alert', packageId: reading.packageId, bytes: reading.bytes, thresholdBytes: this.thresholdBytes })
        }
        if (n >= this.rounds) {
          actions.push({ type: 'deactivate', packageId: reading.packageId, bytes: reading.bytes, thresholdBytes: this.thresholdBytes, rounds: n })
          this.streaks.delete(reading.packageId) // 停用即出表：重投是新 episode
        }
      } else {
        this.streaks.delete(reading.packageId) // 回落即重计（滞回）
      }
    }
    return actions
  }
}

/** 采样薄壳的端口（生产装配喂真源；测试喂罐头） */
export interface MemorySentinelPorts {
  /** 在场投放包 id（status=ok 的 dropped 清单；空 = 无包停表） */
  livePackageIds: () => readonly string[]
  /** pid 对照快照（宿主层 PackagePidRegistry.entries） */
  pidEntries: () => readonly PackagePidEntry[]
  /** 内存读数函数（唯一新缝）：pid → 工作集字节；读不到 = null 放行 */
  readWorkingSetBytes: (pid: number) => number | null
}

/** 采样薄壳的动作出口（判账结果的事实消费端） */
export interface MemorySentinelHandlers {
  /** 读数缺失留证（放行凭据；生产落 DECK_EVENT_LOG） */
  onSampleMissing?: (notes: readonly MemorySentinelSampleNote[]) => void
  /** 告警（首次超线） */
  onAlert: (action: { packageId: string; bytes: number; thresholdBytes: number }) => void
  /** 显式停用（连续确认窗走满） */
  onDeactivate: (action: { packageId: string; bytes: number; thresholdBytes: number; rounds: number }) => void
}

/**
 * 采样薄壳：定时器 + 投影 + 判账 + 动作分发。**仅在有在场投放包时跑**——
 * `refresh()` 由 dropped-plugins/changed 驱动启停（无包停表，开销有界）；
 * `sampleOnce()` 是定时器与测试共用的一轮采样入口（测试注罐头读数，不开定时器）。
 */
export class PackageMemorySentinel {
  private readonly ledger: PackageMemorySentinelLedger
  private readonly intervalMs: number
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly ports: MemorySentinelPorts,
    private readonly handlers: MemorySentinelHandlers,
    params: PackageMemorySentinelParams & { intervalMs?: number } = {},
  ) {
    this.ledger = new PackageMemorySentinelLedger(params)
    this.intervalMs = params.intervalMs ?? MEMORY_SENTINEL_INTERVAL_MS
  }

  /** 预算线读数（诊断/验收对照用；与契约 resourceLimits 同源） */
  get thresholdBytes(): number {
    return this.ledger.thresholdBytes
  }

  /** 在场包数驱动启停（无包停表）：dropped-plugins/changed 即调，幂等 */
  refresh(): void {
    if (this.ports.livePackageIds().length > 0) this.startTimer()
    else this.stopTimer()
  }

  /**
   * 离场清账透传（工单344 评审）：包经非哨兵路径离场（渲染进程崩溃、用户停用、
   * 权限撤销、移除）时 streak 若不清，换代/重投回来后旧计数串到新 episode——新代次
   * 首轮超线即二轮（静默跳过告警）甚至当场停用，违反「首次超线=告警不处置」。
   * 生产装配在 dropped-plugins/changed 拍上对「上一轮在场、本轮不在场」的 id 调用；
   * 哨兵自己停用的路径账本已出表，此处幂等不重放。
   */
  forget(packageId: string): void {
    this.ledger.forget(packageId)
  }

  /** 一轮采样：投影 → 判账 → 分发（定时器与测试共用入口） */
  sampleOnce(): void {
    const live = this.ports.livePackageIds()
    if (live.length === 0) return // 无包不采样（停表由 refresh 驱动，此处兜底）
    const entries = this.ports.pidEntries()
    const readings = projectSample(live, entries, this.ports.readWorkingSetBytes)
    const missing = readings
      .filter((r) => r.bytes === null)
      .map((r) => ({ packageId: r.packageId, pid: entries.find((e) => e.packageId === r.packageId)?.pid ?? null, bytes: null as null }))
    if (missing.length > 0) this.handlers.onSampleMissing?.(missing)
    for (const action of this.ledger.observe(readings)) {
      if (!live.includes(action.packageId)) continue // 判账与处置之间离场（停用/换代）的不再动手
      if (action.type === 'alert') this.handlers.onAlert(action)
      else this.handlers.onDeactivate(action)
    }
  }

  dispose(): void {
    this.stopTimer()
  }

  private startTimer(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => this.sampleOnce(), this.intervalMs)
  }

  private stopTimer(): void {
    if (this.timer === null) return
    clearInterval(this.timer)
    this.timer = null
  }
}
