// 定向验收轮选择器（工单207，spec #201 A2）的类型声明：area-selector.js 是 CJS 纯函数模块。
// 纯函数核心：变更文件集 → 命中域 → 运行计划；CLI 只打印计划与拼好的 guard hold 命令行。

/** 受影响电池在计划中的跑法 */
export declare type PlanMode = 'full' | 'scoped'

export declare interface PlanBattery {
  /** 电池 id（清单 battery.id） */
  id: string
  title: string
  /** npm run 别名（清单 battery.script） */
  script: string
  /** full=整块跑；scoped=按 --accept-scope 段号跑 */
  mode: PlanMode
  /** scoped 时的范围段号（清单登记序） */
  segments: string[]
  /** 计划理由（命中域 / 接线原因 / 保守原因） */
  reason: string
}

export declare interface AcceptPlan {
  /** 命中的域标签（保序去重） */
  areas: string[]
  /** 保守计划（未收窄，多跑不少跑） */
  conservative: boolean
  /** 计划理由（保守触发原因与接线说明） */
  reasons: string[]
  /** 受影响电池（哪几块整块跑、哪几块按 scope 跑） */
  batteries: PlanBattery[]
  /** 未被 path→area 映射表覆盖的源码文件 */
  unmapped: string[]
  /** 非面板域的改动（文档等，不进验收计划） */
  ignored: string[]
  /** 归一后的变更文件集 */
  changedFiles: string[]
}

export declare interface SelectPlanRequest {
  /** 变更文件集（仓库相对路径） */
  changedFiles?: string[]
  /** 段级清单（report.loadManifest() 的产物） */
  manifest?: unknown
}

/** 选段：变更文件集 → 运行计划（纯函数，零 I/O） */
export declare function selectPlan(req: SelectPlanRequest): AcceptPlan

export declare interface GuardCommandOptions {
  /** guard 命令前缀（如 node D:\test-folder\.accept-guard\guard.mjs） */
  guard?: string
  /** 持锁身份（--as） */
  holder?: string
  /** 用途（--purpose：selftest | accept-sprint） */
  purpose?: string
}

/** 拼 accept-guard hold 命令行（只拼不跑——多检出并行安全，不占验收槽） */
export declare function buildGuardCommands(plan: AcceptPlan, opts?: GuardCommandOptions): string[]

/** 段/电池的有效域标签：段级优先，缺则取电池级 */
export declare function effectiveAreas(
  battery: { areas?: string[] } | null | undefined,
  segment: { areas?: string[] } | null | undefined,
): string[]

export declare const ACCEPT_AREA: string
export declare const CROSS_DOMAIN_THRESHOLD: number
