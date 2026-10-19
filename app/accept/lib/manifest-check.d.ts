// 清单校验器（工单115）的类型声明：manifest-check.js 是 CJS 纯静态分析模块。
// 工单204（spec #201 A1）起增：域标签封闭词表 + path→area 映射表。
export declare const SEGMENT_CALL_RE: RegExp

/** 从电池源码提取段号字集（rep.beginSegment('...')，保序去重） */
export declare function extractCodeSegments(source: string): string[]

/** 仓库相对路径归一（反斜杠转正斜杠、去 './'、去尾部斜杠） */
export declare function normalizeRepoPath(p: unknown): string

/** path→area 映射表的一条规则 */
export declare interface PathAreaRule {
  /** 仓库相对路径前缀（目录或文件名前缀） */
  path: string
  /** 域标签（须落在清单 areas 封闭词表内） */
  area: string
  /** 缺省=该路径由电池自身代码决定接线；'*'=共享验收基建（全部电池接线） */
  wires?: string
}

/** path→area 映射命中：最长前缀命中；未命中返回 null */
export declare function matchPathArea(path: string, pathAreas: PathAreaRule[] | undefined): PathAreaRule | null

/** 域标签封闭词表：清单 areas 键集 */
export declare function areaVocabulary(manifest: unknown): Set<string>

/** 文件级例外规则识别（工单220）：path 末段带扩展名＝文件级规则 */
export declare function isFileLevelRulePath(path: string): boolean

/** 必须存在的文件级例外规则台账条目（工单220） */
export declare interface RequiredFileRule {
  /** 仓库相对路径（文件级规则） */
  path: string
  /** 域标签（须与映射表同条规则一致） */
  area: string
  /** 缺省=该路径由电池自身代码决定接线；'*'=共享验收基建 */
  wires?: string
}

/**
 * 文件级例外规则白名单校验（工单220，spec #201 A 链 P1 机制补强）：三道——
 * 白名单条目在映射表在场且域一致、映射表里的文件级规则都登记在案、白名单整份缺位判红。
 * 返回错误列表（空数组＝判绿）。
 */
export declare function validateRequiredFileRules(manifest: unknown): string[]

export declare interface ManifestCheckRequest {
  manifest: unknown
  /** batteryId → 源码全文；缺某电池判红（登记处指向的电池必须可扫描） */
  sources: Record<string, string>
  /** accept 目录在场电池脚本路径表（反向核对：清单外的在场脚本判红）；缺省不核 */
  presentEntries?: string[]
  /** 源码树枚举（工单204：path→area 完备性校验的输入）；缺省不核 */
  sourceTree?: { dirs: string[]; files: string[] }
}

export declare interface ManifestCheckResult {
  ok: boolean
  errors: string[]
}

/** 清单 ↔ 源码双向校验：段号字集双向比对 + 字段完备 + 分电池时长预算 + 域标签与映射表完备性 */
export declare function validateManifest(req: ManifestCheckRequest): ManifestCheckResult

/** --accept-scope 硬交叉校验：声明的段号必须在本电池清单条目内 */
export declare function validateScopeSegments(
  scope: string[],
  manifest: unknown,
  batteryId: string,
): { ok: boolean; unknown: string[] }

/**
 * 电池接入表接线五字段（工单214，spec #203 决策 2）：flag/entry/hintBar/cdpPort/kind。
 * 段级管段、电池级管接线——新电池的登记面就这五个字段 ＋ 一个 npm script。
 */
export declare const REGISTRY_FIELDS: string[]

/** npm run 别名由 flag 派生（工单214：script 名不存表）：--accept-tray → accept:tray */
export declare function deriveScriptName(flag: string): string

export declare interface RegistryCheckRequest {
  manifest: unknown
  /** accept 目录递归枚举的在场文件（仓库根相对路径）——entry 存在性事实 */
  acceptFiles?: string[]
  /** 顶层电池脚本全集（仓库根相对路径）——「在场必入表」事实 */
  presentEntries?: string[]
  /** package.json 的 scripts 对象——script 派生一致与孤儿旗标事实 */
  scripts?: Record<string, string>
}

/**
 * 电池接入表校验（工单214）：六项接线校验——flag 唯一、entry 文件存在、script 派生一致、
 * cdpPort 唯一、experiment 条目豁免段级校验（落在 validateManifest 内）、双向完备。
 */
export declare function validateRegistry(req: RegistryCheckRequest): ManifestCheckResult
