// 清单校验器（工单115）的类型声明：manifest-check.js 是 CJS 纯静态分析模块。
export declare const SEGMENT_CALL_RE: RegExp

/** 从电池源码提取段号字集（rep.beginSegment('...')，保序去重） */
export declare function extractCodeSegments(source: string): string[]

export declare interface ManifestCheckRequest {
  manifest: unknown
  /** batteryId → 源码全文；缺某电池判红（登记处指向的电池必须可扫描） */
  sources: Record<string, string>
}

export declare interface ManifestCheckResult {
  ok: boolean
  errors: string[]
}

/** 清单 ↔ 源码双向校验：段号字集双向比对 + 字段完备 + 分电池时长预算 */
export declare function validateManifest(req: ManifestCheckRequest): ManifestCheckResult

/** --accept-scope 硬交叉校验：声明的段号必须在本电池清单条目内 */
export declare function validateScopeSegments(
  scope: string[],
  manifest: unknown,
  batteryId: string,
): { ok: boolean; unknown: string[] }
