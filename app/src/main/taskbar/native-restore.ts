// 原生任务栏还原的兜底策略（工单248）：「瞬时缺位」不能等于「永久放弃」。
//
// 现象（工单248 真机取证，50-taskbar-carry 的 B1 段）：逃生开关关掉后原生任务栏
// 停在隐藏态，直到清场的 taskbar-restored reason=force 才翻回；事件档是
// `taskbar-restore-skipped reason=disabled note=not-found`——一次性还原调用在
// Shell_TrayWnd 瞬时缺位那一刻被跳过，原生任务栏遂留在隐藏态（用户永久失去
// 系统入口，逃生开关反而成了单向阀）。
//
// 缺位为什么是瞬时的（禁用交还环的同拍竞态，工单153 起就有的形状）：禁用路径
// **先** setTray(false) **再** destroy('disabled')（window.ts 的「禁用三件套」）——
// setTray(false) 让数据面子进程的 TrayHost.stop() 拆掉自家那扇**同名**
// 'Shell_TrayWnd' 竞争窗并广播 TaskbarCreated 交还真托盘；这两下与主进程随后的
// showNativeTaskbar() 查找**同拍并发**：
//   ① 竞争窗被拆 → FindWindowEx 枚举链的 hWndChildAfter 变陈旧（从死句柄续找 = 找不到）；
//   ② explorer 收到 TaskbarCreated 广播 → 重建自家任务栏，真 Shell_TrayWnd 短暂缺位。
// 两者都会让「一次查找」返回 0——**查找失手 ≠ 任务栏没了**（同一次运行里查找在
// 1.4s 前命中过、8.9s 后又命中且仍是隐藏态，见工单248 交付报告的取证链）。
//
// 本模块只裁决「这一拍没翻回之后怎么办」：按退避表重试（有限次，终局有界）还是
// 终局降级。FFI 查找与 ShowWindow 是效果层（taskbar/native.ts），接缝由真机验收
// 覆盖（同 tray-yield 口径：纯逻辑进单测，效果层进验收）。

/**
 * 重试退避表（ms）：有限次 + 退避——终局有界，不无限重试。
 * 逐拍翻倍到 1.28s：总暗窗期 2.52s（< 3s，可断言），覆盖 explorer 重建任务栏的
 * 典型时长；再久则「原生任务栏消失」的观感代价超过一次竞态重试的收益。
 */
export const RESTORE_RETRY_BACKOFF_MS: readonly number[] = [40, 80, 160, 320, 640, 1280]

/** 尝试总次数上限 = 首试 + 退避表长度（终局有界的口径值，可断言） */
export const RESTORE_MAX_ATTEMPTS = RESTORE_RETRY_BACKOFF_MS.length + 1

/** 退避总预算（ms）——暗窗期上限（可断言：< 3s） */
export const RESTORE_RETRY_TOTAL_MS = RESTORE_RETRY_BACKOFF_MS.reduce((a, b) => a + b, 0)

/**
 * 一拍还原尝试的结果（视图事实裁决，效果层喂入）：
 * - restored：翻回成功（句柄在、翻回后可见）
 * - already-visible：本来可见（用户/系统先一步翻回）——不抢功
 * - not-found：Shell_TrayWnd 瞬时缺位（句柄没找到）——**可重试**
 * - still-hidden：句柄在，但翻回后仍不可见——可重试（翻回动作可能落在重建窗口上）
 */
export type RestoreAttemptOutcome = 'restored' | 'already-visible' | 'not-found' | 'still-hidden'

/** 终局形态：还原成功 / 本就可见 / 窗口始终缺位降级 / 翻回不生效失败 */
export type RestoreTerminal = 'restored' | 'already-visible' | 'skipped' | 'failed'

export type RestoreDecision =
  | { action: 'retry'; delayMs: number; attempt: number }
  | { action: 'done'; outcome: RestoreTerminal; attempt: number }

/**
 * 一拍之后的裁决。命中即终局；未命中按退避表重试；退避表走完 = 终局降级
 * （窗口始终缺位 → skipped：explorer 死时它自建可见任务栏，无还原义务；
 *   句柄在却不翻回 → failed：真失败，与缺位降级分族）。
 * attempt 从 1 起（首试），返回值里的 attempt 是**下一拍**的拍号（retry 时）。
 */
export function planRestore(attempt: number, outcome: RestoreAttemptOutcome): RestoreDecision {
  if (outcome === 'restored') return { action: 'done', outcome: 'restored', attempt }
  if (outcome === 'already-visible') return { action: 'done', outcome: 'already-visible', attempt }
  const current = attempt < 1 ? 1 : attempt
  const terminal: RestoreTerminal = outcome === 'not-found' ? 'skipped' : 'failed'
  const next = current + 1
  if (next > RESTORE_MAX_ATTEMPTS) return { action: 'done', outcome: terminal, attempt: current }
  return { action: 'retry', delayMs: RESTORE_RETRY_BACKOFF_MS[current - 1], attempt: next }
}

/* ================================================================
 * appbar 状态复原的兜底裁决（工单260 原生栏托管：还原路径①扩展）
 * ================================================================ */

/**
 * 一拍 appbar 状态复原尝试的结果（读回事实裁决，效果层喂入）：
 * - restored：ABM_SETSTATE 后读回与原状态相等——复原到位；
 * - mismatch：读回仍不一致（explorer 忙/重建窗口竞态等）——可重试。
 */
export type AppBarStateRestoreOutcome = 'restored' | 'mismatch'

/** appbar 状态复原的裁决（与可见性复原同一张退避表、同形决策面） */
export type AppBarStateRestoreDecision =
  | { action: 'retry'; delayMs: number; attempt: number }
  | { action: 'done'; outcome: 'restored' | 'failed'; attempt: number }

/**
 * 一拍之后的裁决（工单260）：读回一致即终局；不一致按退避表重试（有限次、终局有界
 * ——与可见性复原共享节奏，两笔账同拍推进不各走各的表）；退避表走完 = 终局失败。
 * attempt 从 1 起，返回值里的 attempt 是**下一拍**的拍号（retry 时）。
 */
export function planAppBarStateRestore(attempt: number, outcome: AppBarStateRestoreOutcome): AppBarStateRestoreDecision {
  if (outcome === 'restored') return { action: 'done', outcome: 'restored', attempt }
  const current = attempt < 1 ? 1 : attempt
  const next = current + 1
  if (next > RESTORE_MAX_ATTEMPTS) return { action: 'done', outcome: 'failed', attempt: current }
  return { action: 'retry', delayMs: RESTORE_RETRY_BACKOFF_MS[current - 1], attempt: next }
}
