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
// 上报态口径记档——此处与 render-sentinel.ts 里那句建议**相反**。该处的建议是让 reportedQuiet
// 跨心跳保留，理由是「收到心跳即复位」的写法会让升级失能档永不可达。本接线按工单94 的验收口径
// 取后者：上报态随心跳复位，一轮静默一条存证，条数与落点与改前逐条可比（工单94 要求面板运行时
// 行为零影响，Phase 0 基线与既有 57 条 fail 基线照此口径重跑）。代价是失能档的存证判据要等 #91
// 的验收口径定下来再写，届时本段与 pump() 里的 escalate 分支一并打开。
//
// 「失能档不落存证」要说准，别被后人当死代码删掉：升级失能档在裁决里**是命中的**——落定第一条
// 静默存证后，上报态为真、恢复标记为假，连续静默的每一拍都会判成 escalate。接线本轮只是不把这一
// 档落成存证（判据属 #91），不是它不会来。
//
// 恢复标记能讲清什么：落盘值 = 落定那一刻「自上次落定以来是否收到过心跳」。心跳一到静默时长即归
// 零，故「本轮静默期间收到过心跳」与「落定存证之后收到过心跳」本是同一件事——标记为 true 读作
// 「渲染层活过来之后又静默了一轮」，首条则说明哨兵起至今没见过任何上行。它讲不了「这条存证落定
// 之后又恢复了没有」：那是落定之后才发生的事，只能靠后续存证与日志对读（属 #91 的验收口径）。

import { silenceVerdict } from './render-sentinel'

/** 静默判据阈值（ms）：既有口径，工单94 一个数不动 */
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

export interface RenderSentinelSamplerOptions {
  /** 落定一条静默存证时调用（本轮只有静默一档会走到这里） */
  onQuiet: (record: SilentRecord) => void
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
  private disposed = false
  private readonly pollTimer: NodeJS.Timeout

  constructor(private readonly options: RenderSentinelSamplerOptions) {
    this.pollTimer = setInterval(() => this.pump(), RENDER_SENTINEL_POLL_MS)
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
    // 升级失能那一档本轮不落存证：它的发射判据属 #91 验收口径（工单94 明写不落代码）。注意它
    // 在这里是命中的（连续静默的每一拍都判成 escalate），不是不可达——别把这条分支当死代码删。
    if (verdict.action !== 'report-quiet') return
    // 先落状态再落存证：存证钩子抛异常不该把这一轮重新变成「未上报过」而反复重报。
    this.reportedQuiet = true
    this.recovered = false
    this.options.onQuiet({ quietMs, recovered: verdict.recovered })
  }
}