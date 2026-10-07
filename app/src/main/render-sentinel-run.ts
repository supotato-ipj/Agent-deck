// 渲染层哨兵的采数与接线（工单94，#92 spec 的哨兵接线这一半）。面板本体永不激活、恒在
// 普通窗之下，渲染层失能（崩或卡）没有任何用户可见征兆——面板只是「不响应了」，而常驻件
// 不重启就是永久失去交互（工单59 真机验收挖出）。哨兵因此常驻采心跳：渲染层死了就没有心跳，
// 「静默了多久」是这条链唯一的可观测信号。
//
// 这一层只做三件事：记心跳、记时间、按拍子把采到的快照交给 silenceVerdict 裁决。「该不该报、
// 报哪一级」不在这里判——那是 render-sentinel.ts 纯函数的单点职责（工单93），离线可穷举，
// 不必每改一版就占用真机跑一轮。分工同构于仓库既有两处先例：WindDRestorer 只喂 isDown
// 采样、还原动作留给宿主；nextKeyboardGate 只归约通道变化沿。
//
// 两个口径本轮一个数不动：静默判据 5 秒、采样 2 秒；不改任何控制流，不参与面板运行时的任何
// 决策（工单94 AC：只修观测，不修失能本身）。
//
// 上报态口径记档——此处与 render-sentinel.ts 里那句建议**相反**，取舍如下：该处建议 reportedQuiet
// 跨心跳保留，理由是「收到心跳即复位」的写法会让升级失能档永不可达。本接线按工单94 的验收口径
// 取后者：让上报态随心跳复位，故「升级失能」档在接线上不可达。这样取舍是因为工单94 要求面板
// 运行时行为零影响——存证的条数与落点必须与改前逐条可比（Phase 0 基线与既有 57 条 fail 基线
// 照此口径重跑）；代价是失能档连同上报态口径一起等 #91 定下发射判据再打开，届时本段与 escalate
// 分支一并作废。
//
// 恢复标记能讲清什么：按 render-sentinel.ts 的输入口径，recovered 是「落定存证以来收到过
// 心跳」。心跳一到静默时长即归零，故「本轮静默期间收到过心跳」与「落定存证之后收到过心跳」
// 本是同一件事——标记为 true 读作「渲染层活过来之后又静默了一轮」，首条则说明哨兵起至今没
// 见过任何上行。它讲不了「这条存证落定之后又恢复了没有」：那是落定之后才发生的事，只能靠
// 后续存证与日志对读（属 #91 的验收口径）。

import { silenceVerdict } from './render-sentinel'

/** 静默判据阈值（ms）：既有口径，工单94 一个数不动 */
export const RENDER_SENTINEL_QUIET_MS = 5000

/** 采样拍（ms）：既有口径，哨兵按此拍子看一眼渲染层还有没有心跳 */
export const RENDER_SENTINEL_POLL_MS = 2000

/** 一轮静默落定的存证内容（宿主侧补 crashed / pid 后落盘） */
export interface SilentRecord {
  /** 实测静默时长（ms），不是阈值本身 */
  readonly quietMs: number
  /** 这一轮后来恢复了没有：落定存证之后又收到过心跳即为 true */
  readonly recovered: boolean
}

export interface RenderSentinelRunOptions {
  /** 落定一条静默存证时调用（本轮只有静默一档会走到这里） */
  onQuiet: (record: SilentRecord) => void
  /** 静默判据阈值（ms），默认既有 5 秒口径 */
  thresholdMs?: number
  /** 采样拍（ms） */
  pollMs?: number
  /** 面板窗已销毁（Electron 侧喂，纯函数据此判不动作） */
  isWindowDestroyed?: () => boolean
  /** 渲染进程已销毁 */
  isRendererDestroyed?: () => boolean
}

/**
 * 哨兵本体：2s 一拍采一次「已静默多久」，把快照交给分级裁决纯函数，落定才记一条存证。
 * 生命周期由宿主管（面板窗 closed 即 dispose），它自己不认 Electron。
 */
export class RenderSentinelRun {
  private lastBeat = Date.now()
  /** 本轮静默是否已上报过：收到心跳即复位，故一轮一条、不刷屏（与改前行为逐条一致） */
  private reportedQuiet = false
  /** 自上次落定存证以来是否收到过心跳——即「这一轮后来恢复了没有」 */
  private recovered = false
  private disposed = false
  private readonly pollTimer: NodeJS.Timeout

  constructor(private readonly options: RenderSentinelRunOptions) {
    this.pollTimer = setInterval(() => this.pump(), options.pollMs ?? RENDER_SENTINEL_POLL_MS)
  }

  /** 收到渲染层上行即调：心跳只证明渲染层还活着，级别由裁决去判 */
  beat(): void {
    this.lastBeat = Date.now()
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
      windowDestroyed: this.options.isWindowDestroyed?.() ?? false,
      rendererDestroyed: this.options.isRendererDestroyed?.() ?? false,
    })
    // 升级失能那一档本轮不落存证：发射判据属 #91 验收口径（工单94 明写不落代码），
    // 且按上面的上报态口径它在接线上本就不可达。此处只消费静默一档，其余一律不动作。
    if (verdict.action !== 'report-quiet') return
    // 先落状态再落存证：存证钩子抛异常不该把这一轮重新变成「未上报过」而反复重报。
    this.reportedQuiet = true
    this.recovered = false
    this.options.onQuiet({ quietMs, recovered: verdict.recovered })
  }
}