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
