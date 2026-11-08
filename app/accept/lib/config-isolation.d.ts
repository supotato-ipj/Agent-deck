// 验收电池 config 隔离落点（工单402）的类型声明：config-isolation.js 是 CJS 纯 fs 模块，
// 本声明服务 tests/*.spec.ts 的类型检查与控制器侧消费。
import type { ConfigDrift, ConfigSnapshot } from './battery-cleanup'

/** prepareIsolation 注入面（全部可缺省走真机路径；单测注入沙箱） */
export declare interface PrepareIsolationDeps {
  /** 用户生产配置（缺省 app/config.json）——只读播种，轮内零写入 */
  userConfigFile?: string
  /** 一次性产物的根目录（缺省 os.tmpdir()） */
  tmpRoot?: string
  /** 隔离文件名标签（缺省 pid-时间-序号） */
  tag?: string
  /** guard 目录显式覆盖（缺省按用户配置路径取短哈希） */
  guardDir?: string
}

/** 本轮隔离句柄 */
export declare interface ConfigIsolation {
  /** 本轮生效落点：控制器把它写进 DECK_CONFIG_FILE，面板子进程继承 */
  isolatedFile: string
  /** 快照与隔离文件所在的一次性目录 */
  guardDir: string
  /** 本轮起跑时的用户配置快照（sha256 + 原文；缺位 raw=null） */
  snapshot: ConfigSnapshot
  /** 上一轮崩溃残留检出并已还原用户配置 */
  residueRestored: boolean
  /** 残留轮结束时用户配置的 sha256（留痕用） */
  residueBeforeSha: string | null
  /** 轮内/轮末比对用户配置漂移：命中即还原 */
  checkDrift(): ConfigDrift
  /** 删隔离文件与轮快照（幂等） */
  dispose(): void
}

/** 控制器分发时调用一次：播种隔离文件、落盘本轮快照、检出上轮崩溃残留 */
export declare function prepareIsolation(deps?: PrepareIsolationDeps): ConfigIsolation

/** 崩溃守卫的 process 最小结构面（单测注入假 EventEmitter + exit） */
export declare interface CrashGuardProc {
  once(event: 'SIGINT' | 'SIGTERM' | 'uncaughtException', listener: (...args: unknown[]) => void): unknown
  exit(code: number): unknown
}

/**
 * 挂 SIGINT/SIGTERM/uncaughtException 守卫：先判漂移还原、再清隔离落点、最后退出。
 * 监听器随控制器进程生灭，正常收尾后无需卸载。
 */
export declare function installCrashGuard(
  handle: ConfigIsolation,
  proc?: CrashGuardProc,
  log?: Pick<Console, 'error'>,
): void
