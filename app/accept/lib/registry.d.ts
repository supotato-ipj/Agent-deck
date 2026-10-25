// 电池接入表运行端读取器（工单214，spec #203 决策 1/2/5/6）的类型声明：
// registry.js 是 CJS 读取器（读段级清单的电池级接线字段，零判红职责）。

/** 电池接入表的一条接线条目（段级清单的电池级条目） */
export declare interface BatteryRegistryEntry {
  /** 电池 id（清单 battery.id） */
  id: string
  /** 控制器身份旗标（全表唯一，如 --accept-taskbar） */
  flag: string
  /** 电池模块路径（仓库根相对，如 app/accept/battery.js） */
  entry: string
  /** 验收提示条挂条条件（布尔——挂条由表派生） */
  hintBar: boolean
  /** CDP 端口（可空；全表唯一） */
  cdpPort: number | null
  /** 'experiment' = 取证工具（段级治理豁免）；null = 普通电池 */
  kind: string | null
}

/** 段级清单路径（电池接入表住在它的电池级条目里） */
export declare const MANIFEST_FILE: string
/** 仓库根（表内 entry 是仓库根相对路径） */
export declare const REPO_ROOT: string

/** 读表（进程内一次）→ 接线条目数组 */
export declare function loadRegistry(): BatteryRegistryEntry[]

/** 控制器身份匹配（表派生）：表内 flag 命中 argv → 该条目；未命中即 null */
export declare function matchByFlag(argv: string[]): BatteryRegistryEntry | null

/** 挂条条件（表派生）：命中条目的 hintBar 为真即挂条 */
export declare function hintBarRequired(entry: BatteryRegistryEntry | null | undefined): boolean

/** 电池的 CDP 端口（表派生）：无端口的电池留空（返回 null） */
export declare function cdpPortFor(id: string): number | null

/** 电池模块的绝对路径（表派生）：表内 entry 是仓库根相对路径 */
export declare function modulePathFor(entry: string): string
