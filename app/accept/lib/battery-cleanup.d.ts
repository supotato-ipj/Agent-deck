// 验收电池自清场（工单402 漂移检查并入）的类型声明：battery-cleanup.js 是 CJS 纯 fs 模块，
// 本声明服务 tests/*.spec.ts 的类型检查。

/** 自清场账目（各字段是清掉了什么，供电池日志留痕） */
export declare interface CleanupReport {
  packages: string[]
  grants: number
  configs: string[]
  backups: string[]
  sessions: number
  audits: string[]
  dshPatchReset: boolean
}

/**
 * 清场主入口：投放包/授权账/私有配置/备份/待装载区/会话/DSH 补丁/审计档。
 * @param userData 面板 userData 根
 */
export declare function cleanupBatteryArtifacts(userData: string): CleanupReport

/** 是否电池自有投放包 id（包名单或 bulk-<n> 批量测量包） */
export declare function isBatteryPackageId(id: string): boolean

/** 电池自有投放包 id 名单 */
export declare const BATTERY_PACKAGE_IDS: string[]

/** config 漂移检查·轮前快照：缺位来 raw=null，在位带原文与 sha256 */
export declare interface ConfigSnapshot {
  file: string
  sha256: string | null
  raw: string | null
}

/**
 * 轮前快照（缺省目标＝生产落点 app/config.json，不受 DECK_CONFIG_FILE 覆盖影响）
 * @param configFile 可选目标（单测注入临时文件）
 */
export declare function snapshotConfig(configFile?: string): ConfigSnapshot

/** 漂移比对结论：drifted 即判红（调用方记降责账），restored 表示已还原 */
export declare interface ConfigDrift {
  drifted: boolean
  restored: boolean
  beforeSha: string | null
  afterSha: string | null
}

/** 轮后比对：sha256 不等即还原（缺位来、缺位去） */
export declare function checkConfigDrift(snapshot: ConfigSnapshot): ConfigDrift
