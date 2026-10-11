// 渲染层静默的分级裁决（工单93，#92 spec 的纯函数缝之一）。面板本体永不激活、恒在
// 普通窗之下，渲染层失能（崩或卡）没有任何用户可见征兆——面板只是「不响应了」，而
// 常驻件不重启就是永久失去交互（工单59 真机验收挖出）。哨兵采心跳与时间戳，「该不该
// 报、报哪一级」在这里单点裁决；先例同构：桌面遮罩守望的 coverDecision（外部完成 z
// 序侦察、纯函数只裁决 engage/release）与键盘模式门控的 nextKeyboardGate（外部喂事件、
// 纯函数归约出通道变化沿）。
//
// 分级语义（#92 spec）：静默 = 渲染层一段时间无上行但可能自行恢复；失能 = 静默且不自愈
// 的终态。因此 recovered 是裁决的必要输入而非可选注释——2026-10-06 15:19:15 那次 4 秒
// 自愈（quietMs=5213，4 秒后 clock-card-clicked 到达）曾与真失能共用一个事件名落进存证，
// 读的人无从分辨。此后「静默了但自己恢复了」是常态，必须由裁决产出自己讲清级别。
//
// 本模块零 Electron、零 IO（连依赖声明都没有）：只吃调用方采好的快照，故离线矩阵可穷举，
// 不必每改一版就占用真机跑一轮。阈值由调用方原样传入，模块内不持阈值——调阈值是观测口径
// 的决定，不该藏在一个纯函数里。

/**
 * 一次裁决的输入快照（全部由调用方采数所得，纯函数只管裁决）
 */
export interface SilenceSnapshot {
  /** 已静默时长（ms）：距上一次渲染层上行过去了多久 */
  readonly quietMs: number
  /** 静默判据阈值（ms）——由调用方原样传入，本模块不持有该数 */
  readonly thresholdMs: number
  /**
   * 同一形态是否已上报过静默。
   * 接线约定（接线实现在 render-sentinel-sampler.ts，本模块只消费不维护）：上报态随心跳复位，
   * 一轮静默一条静默存证（工单94 口径，条数与落点逐条可比）。升级失能只在「已报过静默且仍未
   * 收到心跳」时成立；同一轮内失能档只发射一条，是否已发射由 frozenReported 讲。
   */
  readonly reportedQuiet: boolean
  /**
   * 期间是否收到过心跳（渲染层还活着）。以「自上次落定存证以来收到过心跳」为口径，
   * 故它与 reportedQuiet 同期复位：两者一起把静默切成一轮一轮的 episode，
   * 使「已报静默后再次静默」与「同一轮内尚未恢复」两种形态在数据上分得开。
   */
  readonly recovered: boolean
  /**
   * 本轮静默是否已发射过失能档（#91 定案）：失能档一轮只发射一条，发射后其余各拍不再重复
   * （发射后等心跳闭合 episode，闭合记账在采样体）。false = 还没发过，达「已报静默且仍未
   * 收到心跳」即判升级。
   */
  readonly frozenReported: boolean
  /** 面板窗口已销毁 */
  readonly windowDestroyed: boolean
  /** 渲染进程已销毁 */
  readonly rendererDestroyed: boolean
}

/** 裁决出的级别：none = 不动作；report-quiet = 报静默；escalate-unresponsive = 升级失能 */
export type SilenceAction = 'none' | 'report-quiet' | 'escalate-unresponsive'

export interface SilenceVerdict {
  /** 本次该不该落存证、落哪一级 */
  readonly action: SilenceAction
  /** 仅 report-quiet 时承载「这一轮后来恢复了没有」；其余档一律 false */
  readonly recovered: boolean
}

const NONE: SilenceVerdict = Object.freeze({ action: 'none', recovered: false })

/**
 * 裁决（离线矩阵穷举见 tests/render-sentinel.spec.ts）：
 * - 窗口销毁或渲染进程已销毁：哨兵已无观测对象，一律不动作。
 * - 未达阈值：静默未成形，不动作。
 * - 达阈值且该形态未上报过：报静默，并把「期间是否曾恢复」原样带出——恢复过就是
 *   「静默 + 已恢复」，这正是 15:19:15 那次的读法，绝不与失能混同。
 * - 达阈值、已报静默且期间无心跳、失能档尚未发射：升级失能（#91 发射判据，采样体据此
 *   落失能档存证）。
 * - 达阈值、已报静默且期间无心跳、失能档已发射：不再动作——失能档一轮一条，episode
 *   等心跳闭合（闭合记账在采样体），重复发射只会把同一轮冻结刷成存证瀑布。
 */
export function silenceVerdict(s: SilenceSnapshot): SilenceVerdict {
  if (s.windowDestroyed || s.rendererDestroyed) return NONE
  if (s.quietMs < s.thresholdMs) return NONE
  if (!s.reportedQuiet) return { action: 'report-quiet', recovered: s.recovered }
  if (s.recovered || s.frozenReported) return NONE
  return { action: 'escalate-unresponsive', recovered: false }
}
