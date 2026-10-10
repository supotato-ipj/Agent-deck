// 工单119 取证分析器的类型声明：CJS 纯函数模块，服务
// tests/accept/uia-tray-analyze.spec.ts 的类型检查与 harness 消费。
export declare interface HostInfo {
  hwnd: number
  class: string
  pid: number
  exe: string
}

export declare interface ElementFields {
  name: string
  aid?: string
  class?: string
  type?: string
  hwnd?: number
  pid?: number
  exe?: string
  error?: string
  note?: string
}

export declare interface DumpLine {
  kind: 'dump'
  when: 'pre' | 'post'
  host: HostInfo
  itemCount: number
  truncated: boolean
  error: string | null
  items: ElementFields[]
}

/** summarizeDump 只读 when/host/items/truncated/error，入参取最小结构类型 */
export declare type DumpInput = Partial<Omit<DumpLine, 'items'>> & { items?: unknown }

export declare interface StepLine {
  kind: 'step'
  i: number
  focus: ElementFields
  fg: HostInfo
}

export declare interface ProbeParsed {
  hosts: HostInfo[]
  dumps: DumpLine[]
  steps: StepLine[]
  summary: Record<string, unknown> | null
  fatal?: { message: string }
  badLines: number
}

/** 三签名：A 全空串 / B 焦点冻住 / C 真托盘可导航（含夹空步） */
export declare type Signature = 'A-all-empty' | 'B-frozen' | 'C-navigating' | 'no-steps'

export declare interface TreeSummary {
  when: string
  host: HostInfo | null
  itemCount: number
  truncated: boolean
  error: string | null
  emptyNames: number
  agentDeckPresent: boolean
  agentDeckName: string | null
  tailEmptyItem: boolean
}

export declare interface RoundRecord {
  signature: Signature
  distinctNames: number
  frozenName: string | null
  stepCount: number
  emptySteps: number
  firstMatch: number
  fgClasses: string[]
  fgOnTrayHost: boolean
  agentDeckInWalk: boolean
  hostCount: number
  hosts: HostInfo[]
  trees: TreeSummary[]
  probeSummary: Record<string, unknown> | null
  badLines: number
  fatal: { message: string } | null
  tag?: string
  t0?: number
  t1?: number
  probeStatus?: number | null
  probeTimedOut?: boolean
  panelEvents?: Array<Record<string, unknown>>
}

export declare interface ArmStats {
  rounds: number
  signatureCounts: Record<string, number>
  frozenNames: Record<string, number>
  stepsTotal: number
  stepEmptyRate: number | null
  roundEmptyStepRate: number | null
  emptyObsRoundRate: number | null
  matchRate: number | null
  walkAgentDeckRate: number | null
  treeAgentDeckRate: number | null
  treeTailEmptyRate: number | null
  hostCountHistogram: Record<string, number>
  fgClassHistogram: Record<string, number>
}

/** 判读行：R1 Windows 本底 / R2 独立于停摆 / R3 迁移窗口 / R4 仅重启 / R5 全零 */
export declare type VerdictRow =
  | 'R1-windows-floor'
  | 'R2-independent-of-stall'
  | 'R3-migration-window-linked'
  | 'R4-relaunch-only'
  | 'R5-no-repro-fallback'

export declare interface Verdict {
  observations: { baseline: boolean; idle: boolean; broadcast: boolean; relaunch: boolean; allZero: boolean }
  batteryPathConfirmed: boolean
  row: VerdictRow
}

export declare function parseProbeOutput(text: string): ProbeParsed
/** classifySteps 只读 focus.name，入参取最小结构类型（测试 fixture 与 StepLine 均可） */
export declare function classifySteps(steps: Array<{ focus?: { name?: string | null } }>): { signature: Signature; distinctNames: number; frozenName: string | null }
export declare function summarizeDump(dump: DumpInput, needle: string): TreeSummary
export declare function classifyRound(parsed: ProbeParsed, needle?: string): RoundRecord
export declare function roundHasEmptyNameObservation(round: RoundRecord): boolean
export declare function aggregateRounds(rounds: RoundRecord[]): ArmStats
/** verdictRows 只读 rounds 与三个率字段，入参取最小结构类型 */
export declare type ArmStatsInput = { rounds: number } & Partial<Pick<ArmStats, 'emptyObsRoundRate' | 'stepEmptyRate' | 'treeTailEmptyRate'>>
export declare function verdictRows(statsByArm: Partial<Record<'baseline' | 'idle' | 'broadcast' | 'relaunch', ArmStatsInput>>): Verdict
