// 电池 config 读写共通 helper（工单124）的类型声明：battery-config.js 是 CJS 纯 fs 模块，
// 本声明服务 tests/*.spec.ts 的类型检查与后续 TS 消费方。
export declare const CONFIG_FILE: string

export declare interface BatteryConfig {
  /** 绑定的 config.json 绝对路径 */
  configFile: string
  /** 原文；缺位返回 null（不抛 ENOENT） */
  readConfigRaw(): string | null
  /**
   * 覆写 taskbar 段字段（保留其余字段原文档位），落盘后返回原文供 restoreConfig 还原；
   * 文件缺位落最小桩 {}（面板 loadConfig 按默认值补齐其余段）。
   */
  patchTaskbar(patch: Record<string, unknown>): string | null
  /** 三态还原：null → unlink 桩；有原文 → 逐字节写回 */
  restoreConfig(raw: string | null): void
}

/** 建绑定指定 config 路径的 helper（真机电池用模块级缺省实例；单测经此注入临时目录） */
export declare function createBatteryConfig(configFile: string): BatteryConfig

/** 缺省实例（绑定 app/config.json）导出的三件套 */
export declare function readConfigRaw(): string | null
export declare function patchTaskbar(patch: Record<string, unknown>): string | null
export declare function restoreConfig(raw: string | null): void
