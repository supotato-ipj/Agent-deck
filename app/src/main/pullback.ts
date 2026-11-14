// 拉回裁决纯函数域（工单479，ADR-0032 韧性基线三件套之「拉回」）：外层守卫检测到
// 面板子进程异常退出后，按退避策略自动重新拉起、重拉次数有界。「该不该重拉、第几次、
// 隔多久」在此单点裁决；守卫进程的 spawn/定时器是宿主薄壳（index.ts 默认分支），离线
// 不可穷举故不测，裁决本体离线矩阵可穷举。先例同构：render-sentinel.ts 的
// silenceVerdict（采样在外、裁决单点）、resident-event-log.ts 的 planRotation。
//
// 词汇纪律：本机制正名「拉回」（GLOSSARY）——「看门狗」为已退役词条不复用，行文
// 勿再称看门狗、守卫、守护。冻结（渲染层哨兵判出）不在拉回处置范围：冻结只记账并
// 告警一次，自动杀拉为 ADR-0032 明示暂缓项（freeze-alarm.ts 承接告警半边）。

/**
 * 生产退避表（ms）：第 N 次重拉前等待 delaysMs[N-1]；超出表长夹取末档。
 * 口径：首拉 1s（快恢复）、逐次 2s/5s 升级——连崩说明系统性问题，升级退避压住
 * 崩溃循环的转速，同时总量有界（3 次 ≈ 8s 等待）不拖住守卫终局。
 */
export const PULLBACK_DELAYS_MS: readonly number[] = [1000, 2000, 5000]

/**
 * 重拉上限（次）：连续异常退出达到此数即停止重拉（第 4 崩放弃，不做无限循环）。
 * 3 次连崩 = 系统性故障（坏更新/盘满/依赖损坏），守卫的义务到此为止——还原原生
 * 界面、落 pullback-exhausted 存证、随面板退场等用户处置。
 */
export const PULLBACK_MAX_RESPAWNS = PULLBACK_DELAYS_MS.length

/**
 * 稳定性重置窗（ms）：面板存活越过此窗再崩，连崩账清零重计——偶发一崩永远只值
 * 一次快速重拉，不被数月前的旧账拖进「放弃」终局。
 */
export const PULLBACK_STABLE_RESET_MS = 60_000

/**
 * 面板启动期失败专用退出码（2026-11-14 双轴评审 H1）：bootPanel 拒绝径（kernel-start
 * 超时等装配死锁级故障）不走 app.quit()——quit 的完整退出链以 exit 0 收场，守卫把
 * 0 判干净退出（restoreAndExit 随面板双双退场），启动链注释承诺的「干净失败交拉回」
 * 实际落空。改以本专用码 app.exit：以异常退出身份过守卫的拉回裁决，进入有界重拉 +
 * 逃生口自动还原。取值沿用 sysexits 的 EX_TEMPFAIL(75)——「临时性失败、重试可解」
 * 的进程退出惯例码，与 spawn 失败的 exit(1)、用户干净退出的 exit(0) 三径分立可辨。
 */
export const PANEL_BOOT_FAILED_EXIT_CODE = 75

/**
 * 守卫侧干净退出判定（纯函数，宿主薄壳 handlePanelExit 的裁决缝——离线可测的单点）：
 * 只有 code === 0 算干净退出（托盘退出/退出信使的 app.quit 完整退出链）。null（信号
 * 终止/宿主强杀，无退出码）与一切非零码（含 PANEL_BOOT_FAILED_EXIT_CODE）都是异常
 * 退出、走拉回裁决——对齐本文件头注「异常退出（非零/信号）」的词汇（2026-11-14
 * 双轴评审 L1：旧 `code ?? 0` 把信号终止误判成干净退出）。
 */
export function isCleanPanelExit(code: number | null): boolean {
  return code === 0
}

/** 退避查表（纯函数）：attempt 从 1 起；超出表长夹取最后一档；空表属配置错误，拒绝。 */
export function backoffDelayMs(delaysMs: readonly number[], attempt: number): number {
  if (!Array.isArray(delaysMs) || delaysMs.length === 0) {
    throw new Error(`拉回：退避表为空（至少一档）`)
  }
  if (!(attempt >= 1)) throw new Error(`拉回：attempt=${attempt} 非法（从 1 起）`)
  const idx = Math.min(attempt - 1, delaysMs.length - 1)
  return delaysMs[idx]
}

/** 裁决输出：action=respawn 重拉（attempt 第几次、delayMs 退避）；give-up 放弃（延迟 0） */
export interface PullbackVerdict {
  readonly action: 'respawn' | 'give-up'
  readonly attempt: number
  readonly delayMs: number
}

export interface PullbackAdjudicationInput {
  /** 本次退出前的连续异常退出计数（稳定性重置窗外的旧账不计入——见 stableMs） */
  readonly crashesSoFar: number
  /** 重拉上限：连续异常退出次数达到上限即放弃（maxRespawns 次崩 → maxRespawns 次重拉后，第 maxRespawns+1 次崩放弃） */
  readonly maxRespawns: number
  /** 本次面板存活时长（ms）：调用方以发射时点起算实测 */
  readonly stableMs: number
  /** 稳定性重置窗（ms）：存活 ≥ 此值即清连崩账 */
  readonly stableResetMs: number
  /** 退避表（ms） */
  readonly delaysMs: readonly number[]
}

/**
 * 拉回裁决（纯函数）：一次面板异常退出后，守卫该重拉还是放弃。
 * - 稳定性重置：本次存活 ≥ stableResetMs → 连崩账视为 0（上次链已愈合，新链新账）。
 * - 本次是第 crashes+1 次连续异常退出：≤ maxRespawns → respawn（attempt=次数，
 *   退避按 attempt 查表）；> maxRespawns → give-up（终局有界，守卫还原后随面板退场）。
 */
export function adjudicatePullback(input: PullbackAdjudicationInput): PullbackVerdict {
  const stableEnough = input.stableMs >= input.stableResetMs
  const crashes = stableEnough ? 0 : input.crashesSoFar
  const attempt = crashes + 1
  if (attempt > input.maxRespawns) {
    return { action: 'give-up', attempt, delayMs: 0 }
  }
  return { action: 'respawn', attempt, delayMs: backoffDelayMs(input.delaysMs, attempt) }
}
