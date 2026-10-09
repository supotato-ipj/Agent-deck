// stall-duel 离线分析（工单132 第一阶段）的类型声明：CJS 纯函数模块，服务
// tests/accept/stall-duel-analyze.spec.ts 的类型检查与 harness 消费。
export declare interface ProbeSample {
  /** 探针发起时刻（epoch ms） */
  t: number
  /** WM_NULL 是否在超时内应答 */
  ok: boolean
}

export declare interface ProbeStallEvent {
  onsetMs: number
  endMs: number
  durationMs: number
  /** 整轮以冻结收场（样本流结尾仍超时） */
  terminal: boolean
  probes: number
}

export declare interface CouplingStats {
  total: number
  withinWindow: number
  fraction: number
  medianAbsDeltaMs: number | null
}

export declare interface OrderClass {
  onset: number
  order: 'renderer-first' | 'main-first' | 'isolated'
  deltaMs: number | null
}

export declare interface ArmFacts {
  stallCount: number
  activeMinutes: number
  couplingWithin: number
  couplingTotal: number
  labels: string[]
  windCouplingWithin?: number
  windCouplingTotal?: number
}

export declare interface DuelVerdict {
  verdict: 'H1' | 'H7' | 'H4' | 'inconclusive' | 'ambiguous'
  reasons: string[]
}

export declare function dedupeProbeStalls(samples: ProbeSample[], opts?: {
  mergeGapMs?: number
  timeoutMs?: number
  minDurationMs?: number
}): ProbeStallEvent[]

export declare function nearestDeltaMs(t: number, triggerTimes: number[]): number | null

export declare function couplingStats(stallOnsets: number[], triggerTimes: number[], opts?: {
  windowMs?: number
}): CouplingStats

export declare function classifyOrder(mainStallOnsets: number[], rendererQuietOnsets: number[], opts?: {
  windowMs?: number
}): OrderClass[]

export declare function labelDistribution(mainLagEvents: { liveLabels?: string[] }[]): { label: string; count: number }[]

export declare function duelVerdict(input: {
  a: ArmFacts
  b: ArmFacts
  orderClasses?: string[]
  terminalSpanLabels?: string[]
  wind?: boolean
}): DuelVerdict
