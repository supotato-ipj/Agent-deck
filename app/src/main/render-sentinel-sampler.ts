// 渲染层哨兵的采数与接线（工单94 建，#91 定案判据）。面板本体永不激活、恒在
// 普通窗之下，渲染层失能（崩或卡）没有任何用户可见征兆——面板只是「不响应了」，而
// 常驻件不重启就是永久失去交互（工单59 真机验收挖出）。哨兵因此常驻采心跳：渲染层死了
// 就没有心跳，「静默了多久」是这条链唯一的可观测信号。
//
// 这一层只做三件事：记心跳、记时间、按拍子把采到的快照交给 silenceVerdict 裁决。「该不该报、
// 报哪一级」不在这里判——那是 render-sentinel.ts 纯函数的单点职责（工单93），离线可穷举，
// 不必每改一版就占用真机跑一轮。分工同构于仓库既有两处先例：WindDRestorer 只喂 isDown
// 采样、还原动作留给宿主；nextKeyboardGate 只归约通道变化沿。
//
// 心跳口径（#91 定案）：心跳 = 渲染层活性信号，两条来源——①真实上行（热区声明/存证等，
// wc 'ipc-message' 全收）②面板渲染层 2s 一拍的活性心跳（deck:host-beat，渲染层 main.ts 起拍，
// 任务栏条带不接）。#92 之前的口径只认真实上行，而空闲期天然静默（时钟分钟沿之间渲染层
// 无话可说）：2026-10-09 基线轮两条 renderer-stall 全部落在空闲档（前后交互正常），静默档
// 存证因此读不出「失能嫌疑」。活性心跳把「静默」从「没话说」收紧成「活性信号断流」——
// 渲染层主线程阻塞时定时器不再走针，心跳即断；空闲面板心跳照常，不再产伪档。
//
// 失能档发射判据（#91 定案，工单94 明写留给本票的那一格）：静默存证落定后，下一采样拍仍无
// 心跳（活性静默 ≥ 5s 阈值 + 2s 拍距 ≈ 7s）→ 发射 renderer-frozen 存证，一轮只发一条。发射后
// episode 由心跳闭合：心跳回归即落 renderer-unfrozen（frozenMs = 冻结全程时长）。「失能是
// 不自愈的终态」由闭合记录讲清——有闭合 = 7s 级真冻结但自愈（发射点不可能预知后续，事后账
// 只能这么记）；无闭合直到窗毁/退出 = 真失能。发射武装是显式的（heartbeatArmed）：任务栏
// 条带不接活性心跳，其哨兵维持工单94 口径（失能档只裁决不发射）——它的静默依旧没有失能语义。
//
// 静默判据 5 秒、采样 2 秒的既有口径一个数不动（5s ≈ 2 拍心跳丢失 + 调度抖动余量）。
//
// 归因边界（读存证前先看这条）：哨兵定时器跑在面板主线程上——主线程自身长滞（>5s 的同步
// 调用，如 spawnSync 类）期间 pump 不走针，恢复后 quietMs 会把主线程滞时刻进静默里。分辨
// 靠主进程滞后哨兵（lag-sentinel.ts 的 main-lag 事件，阈值 2s 对齐）：renderer-stall 与同窗
// main-lag 并现时先读主线程账，别急着记渲染层头上。

import { silenceVerdict } from './render-sentinel'

/** 静默判据阈值（ms）：既有口径，工单94 定死、#91 不动 */
export const RENDER_SENTINEL_QUIET_MS = 5000

/** 采样拍（ms）：既有口径，哨兵按此拍子看一眼渲染层还有没有心跳 */
export const RENDER_SENTINEL_POLL_MS = 2000

/** 一轮静默落定的存证内容（宿主侧补 crashed / pid 后落盘） */
export interface SilentRecord {
  /** 实测静默时长（ms），不是阈值本身 */
  readonly quietMs: number
  /** 落定这一刻，渲染层自上次落定以来是否活过来过 */
  readonly recovered: boolean
}

/** 失能档发射的存证内容（#91）：宿主侧补 crashed / pid 后落盘为 renderer-frozen */
export interface FrozenRecord {
  /** 实测静默时长（ms）：自最后心跳起算，发射点 ≥ 阈值 + 一拍 */
  readonly quietMs: number
}

/** 失能 episode 的闭合存证（#91）：宿主侧补 pid 后落盘为 renderer-unfrozen */
export interface UnfrozenRecord {
  /** 冻结全程时长（ms）：自冻结前最后心跳起算，到闭合心跳为止 */
  readonly frozenMs: number
}

export interface RenderSentinelSamplerOptions {
  /** 落定一条静默存证时调用（本轮只有静默一档会走到这里） */
  onQuiet: (record: SilentRecord) => void
  /** 发射失能档时调用（仅 heartbeatArmed 在场才会发生；#91 发射判据） */
  onFrozen?: (record: FrozenRecord) => void
  /** 冻结 episode 闭合时调用（心跳回归即自愈；#91 闭合记录） */
  onUnfrozen?: (record: UnfrozenRecord) => void
  /**
   * 失能档发射武装：渲染层活性心跳在场（面板窗 true，任务栏条带缺省 false）。
   * 未武装时失能档维持工单94 口径——裁决照判、存证不发（静默没有失能语义，发了全是伪档）。
   */
  heartbeatArmed?: boolean
  /** 静默判据阈值（ms），默认既有 5 秒口径 */
  thresholdMs?: number
  /** 面板窗已销毁（Electron 侧喂，纯函数据此判不动作） */
  isWindowDestroyed?: () => boolean
  /** 渲染进程已销毁 */
  isRendererDestroyed?: () => boolean
}

/**
 * 哨兵的采样体：2s 一拍采一次「已静默多久」，把快照交给分级裁决纯函数，落定才记一条存证。
 * 常驻而非一轮一拍——所以叫采样体，不叫 run。生命周期由宿主管（面板窗 closed 即 dispose），
 * 它自己不认 Electron。
 */
export class RenderSentinelSampler {
  private lastBeat = Date.now()
  /** 本轮静默是否已上报过：收到心跳即复位，故一轮一条、不刷屏（与改前行为逐条一致） */
  private reportedQuiet = false
  /** 自上次落定存证以来是否收到过心跳 */
  private recovered = false
  /** 本轮静默是否已发射过失能档（#91）：发射后等心跳闭合，不重复发射 */
  private frozenReported = false
  private disposed = false
  private readonly pollTimer: NodeJS.Timeout

  constructor(private readonly options: RenderSentinelSamplerOptions) {
    this.pollTimer = setInterval(() => this.pump(), RENDER_SENTINEL_POLL_MS)
  }

  /** 收到渲染层上行即调：心跳只证明渲染层还活着，级别由裁决去判 */
  beat(): void {
    const now = Date.now()
    // 先闭合失能 episode 再复位心跳账（#91）：闭合记录要的是「冻结前最后心跳 → 本拍」的
    // 全程时长，必须用复位前的 lastBeat 算。frozenReported 只在武装态会置真，这里不必再看武装位。
    if (this.frozenReported) {
      this.frozenReported = false
      this.options.onUnfrozen?.({ frozenMs: now - this.lastBeat })
    }
    this.lastBeat = now
    this.reportedQuiet = false
    this.recovered = true
  }

  dispose(): void {
    this.disposed = true
    clearInterval(this.pollTimer)
  }

  private pump(): void {
    if (this.disposed) return
    const quietMs = Date.now() - this.lastBeat
    const verdict = silenceVerdict({
      quietMs,
      thresholdMs: this.options.thresholdMs ?? RENDER_SENTINEL_QUIET_MS,
      reportedQuiet: this.reportedQuiet,
      recovered: this.recovered,
      frozenReported: this.frozenReported,
      windowDestroyed: this.options.isWindowDestroyed?.() ?? false,
      rendererDestroyed: this.options.isRendererDestroyed?.() ?? false,
    })
    // 先落状态再落存证：存证钩子抛异常不该把这一轮重新变成「未上报过」而反复重报。
    if (verdict.action === 'report-quiet') {
      this.reportedQuiet = true
      this.recovered = false
      this.options.onQuiet({ quietMs, recovered: verdict.recovered })
      return
    }
    // 失能档发射（#91）：一轮一条。未武装（任务栏条带）时裁决照判、存证不发——工单94 口径。
    if (verdict.action === 'escalate-unresponsive' && this.options.heartbeatArmed) {
      this.frozenReported = true
      this.options.onFrozen?.({ quietMs })
    }
  }
}
