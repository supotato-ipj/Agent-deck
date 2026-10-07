// 有界 settle 等待 helper（工单123）的类型声明：bounded-wait.js 是 CJS 纯逻辑模块
// （时钟/轮询可注入），本声明服务 tests/*.spec.ts 的类型检查与后续 TS 消费方。
export declare interface ProbeResult<T = unknown> {
  /** probe 产出非空值（非 null/undefined）即收敛 */
  ok: boolean
  /** 命中值；未收敛时为最后一次未命中值（null 归一） */
  value: T | null
  /** 实际探测次数（含抛错按未命中的次数） */
  attempts: number
  /** 注入时钟下的墙钟（真机 = 真实毫秒；单测 = 虚拟毫秒） */
  elapsedMs: number
}

export declare interface WaitForProbeOptions {
  /** 有界上限（毫秒）：超界即返回 ok=false，不抛、不无界 */
  timeoutMs: number
  /** 轮询间隔（毫秒），缺省 150 */
  intervalMs?: number
  /** 注入式等待（单测打虚拟时钟），缺省真 setTimeout */
  sleep?: (ms: number) => Promise<void>
  /** 注入式时钟（单测打虚拟时钟），缺省 Date.now */
  now?: () => number
}

/**
 * 轮询 probe 直到产出非空值或有界超时：probe 抛错按未命中处置（瞬态抖动界内重试）；
 * 等待必须有界——超界失败由调用方抓现场证据，本 helper 只回报未收敛事实。
 */
export declare function waitForProbe<T = unknown>(
  probe: () => Promise<T | null | undefined> | T | null | undefined,
  options: WaitForProbeOptions,
): Promise<ProbeResult<T>>
