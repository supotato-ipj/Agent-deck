// 报告状态机（工单110 三态记账）的类型声明：report.js 是 CJS 纯状态机，
// 本声明服务 tests/*.spec.ts 的类型检查与后续 TS 消费方。
export declare interface ExclusionEntry {
  msg: string
  reason: string
  attribution: string
  inWindow: boolean
}

export declare interface SegmentLedger {
  seg: string
  title: string
  passes: number
  fails: number
  excluded: number
}

export declare interface VerdictResult {
  verdict: string
  exitCode: 0 | 1 | 2
  passes: number
  fails: number
  excluded: number
  exclusions: ExclusionEntry[]
  envWindowOpen: boolean
  scope: string[]
  scopeUnknown: string[]
  file: string | null
}

export declare const EXIT_CODES: { PASS: 0; 'FAIL-CODE': 1; 'FAIL-ENV': 2 }

export declare class Report {
  name: string
  file: string | null
  passes: number
  fails: number
  excluded: number
  exclusions: ExclusionEntry[]
  envWindow: { reason: string; attribution: string; openedAt: number; openedIndex: number } | null
  declaredScope: string[]
  segments: SegmentLedger[]
  currentSegment: SegmentLedger | null
  constructor(name: string, opts?: { file?: string | null; scope?: string[] })
  log(msg: string): void
  pass(msg: string): void
  fail(msg: string): void
  note(msg: string): void
  exclude(msg: string, reason?: string, attribution?: string): void
  beginEnvWindow(reason?: string, attribution?: string): void
  endEnvWindow(how?: string): boolean
  beginSegment(seg: string | number, title?: string): SegmentLedger
  triVerdict(): { verdict: 'PASS' | 'FAIL-CODE' | 'FAIL-ENV'; exitCode: 0 | 1 | 2 }
  verdict(explicit?: string): VerdictResult
}

export declare function parseAcceptScope(argv: unknown[]): string[]
export declare function normalizeScope(list: unknown): string[]
export declare const EVIDENCE_DIR: string
