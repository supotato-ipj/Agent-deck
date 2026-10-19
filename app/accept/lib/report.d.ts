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
  ticket: number | null
  surfaces: string[]
  passes: number
  fails: number
  excluded: number
  startedAt: number
  durationMs: number | null
}

/** 段级清单条目（工单114，app/accept/manifest.json；工单204 起带 areas 域标签） */
export declare interface ManifestSegment {
  seg: string
  ticket: number
  title: string
  surfaces: string[]
  /** 段耦合的域标签（工单204）：须落在清单 areas 封闭词表内；缺省时取电池级 */
  areas?: string[]
  estSeconds: number
}

/** path→area 映射表的一条规则（工单204） */
export declare interface ManifestPathArea {
  /** 仓库相对路径前缀（目录或文件名前缀） */
  path: string
  /** 域标签（须落在清单 areas 封闭词表内） */
  area: string
  /** 缺省=该路径由电池自身代码决定接线；'*'=共享验收基建（全部电池接线） */
  wires?: string
}

export declare interface ManifestBattery {
  id: string
  title: string
  entry: string
  /** 控制器身份旗标（工单214，电池接入表）：全表唯一；npm script 名由它派生（--accept-tray → accept:tray） */
  flag: string
  /** 验收提示条挂条条件（工单214）：布尔——挂条条件由表派生，不再手维护布尔式 */
  hintBar: boolean
  /** CDP 端口（工单214）：可空；全表唯一（无端口的电池留空） */
  cdpPort: number | null
  /** 工单214：'experiment' = 取证工具（段级治理豁免，接线四项仍受校验）；缺省/null = 普通电池 */
  kind?: string | null
  budgetSeconds?: number
  lastMeasuredSeconds: number | null
  lastMeasuredAt: string | null
  /** 电池级域标签（工单204）：副电池单域覆盖口径 */
  areas?: string[]
  /** 该电池代码解析 --accept-scope（可按段声明范围段，工单204） */
  scope?: boolean
  /** 段条目（工单214：experiment 条目无段——段级治理豁免） */
  segments?: ManifestSegment[]
}

export declare interface AcceptManifest {
  version: number
  surfaces: Record<string, string>
  /** 段耦合的域标签封闭词表（工单204）：14 域 */
  areas: Record<string, string>
  /** 公共底座域（工单204）：命中即给保守计划（波及面未知，多跑不少跑） */
  wideAreas?: string[]
  /** 完备性校验的源码树根目录（工单204） */
  sourceRoots?: string[]
  /** 声明式 path→area 映射表（工单204） */
  pathAreas?: ManifestPathArea[]
  batteries: ManifestBattery[]
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
  manifest: AcceptManifest | null
  manifestBattery: ManifestBattery | null
  segments: SegmentLedger[]
  currentSegment: SegmentLedger | null
  constructor(name: string, opts?: { file?: string | null; scope?: string[]; manifest?: AcceptManifest | null })
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
export declare function loadManifest(): AcceptManifest | null
export declare const MANIFEST_FILE: string
export declare const EVIDENCE_DIR: string
