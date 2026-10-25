// 原生栏托管（工单260 起步；ADR-0016 修订记 2026-10-25 双缺陷复审 Q1=A / Q2=A 扩为
// **全接管期**）：面板接管任务栏期间，原生任务栏的 appbar 状态由本模块以**单账**管理。
//
// 三个目标态由同一份用户原状态（userState = 接管建立时的 ABM_GETSTATE 读回）派生：
// - 普通栏态 → normalBarAutoHideState(userState)：清 ABS_AUTOHIDE、留 ALWAYSONTOP。
//   自动隐藏协议本身就是唤出通路（底边悬停、Win 键、通知都能把屏外的原生栏拉出来），
//   不清位则「屏外装夹 + visible=true」照样被叫出（复审对照：保留 auto-hide 且装夹
//   visible=true 时 Win 键 215ms 后完整弹出；清位后底边与 Win 键各自 3.5s 观察均不弹）。
// - 收栏态 → retractAutoHideState(userState)：置 ABS_AUTOHIDE，shell 由此释放原生
//   48px 保留带（spike 取证 docs/audit/2026-10-24-t257-autohide-setstate-probe.md：
//   工作区底边 1392→1440）。
// - 退场（禁用 / 正常退出 / 死路径兜底）→ userState 原值。
//
// 三条纪律（ADR-0016 决策 1/2/3，勿改口径）：
// - **单一账本**：全接管期只持一份 userState；普通↔收栏切换只换目标，**不重记用户
//   原值**——中间态不是用户原值，拿它记账就是账目投毒（此后复原/守卫/守护会把用户
//   任务栏永久翻成自动隐藏）。
// - **读回裁决**：每次 SETSTATE 都读回判成败并落存证；失败不静默，交重申轮询下一拍
//   重试（501 电池 P10 面）。
// - **离场才复原原值**：普通↔收栏互相回落到清位/收栏目标；只有退场写回 userState。
//
// 复原走还原路径①（退避重试）：读回不一致按 native-restore 的同一张退避表重试
// （有限次、终局有界），异步推进不拖住条带销毁/退收栏；timer unref 不吊住进程退出。
// 落盘账（appbar-ledger，userData/appbar-ledger.json）自**接管建立**即写——守卫
// （before-quit/panel-exit）与 guard-dead 还原守护不持面板内存账，落盘账是它们的复原
// 目标来源；复原到位/终局失败即清账（不留陈旧账误导守护），退避中途进程死亡则账留
// 盘上由下一层接力（50 电池 A3/A4 现场由验真机）。
//
// 本模块与 native.ts 的可见性账各自独立（ShowWindow 与 appbar 状态是两个系统事实），
// 互不代偿：清位不代替隐藏，隐藏也不代替清位。
//
// 效果层（FFI 效果面，离线不可测）：接缝由真机验收 50/51 电池覆盖（工作区数值与
// StuckRects3 字节是外部可观测面）；同 tray-yield/native 口径——纯逻辑进单测
// （retractAutoHideState / normalBarAutoHideState / planAppBarStateRestore），效果层进验收。
import type { EventLog } from '../panel-ipc'
import { getAppBarState, setAppBarState } from './appbar'
import { clearAppBarLedger, writeAppBarLedger } from './appbar-ledger'
import { planAppBarStateRestore } from './native-restore'
import { ABS_AUTOHIDE, normalBarAutoHideState, retractAutoHideState } from './retract'

/** 托管的档位：普通栏态（已清位）/ 收栏态（已置位） */
export type TakeoverAutoHideMode = 'normal' | 'retracted'

/** 接管期单账（RAII 账本）：null = 未接管（无复原义务）。模块级单账——原生栏 appbar
 *  状态是会话级事实，与哪扇条带窗现任无关（同 hidNative 的控制器级口径）。 */
let engaged: { userState: number; mode: TakeoverAutoHideMode } | null = null

/** 待决的复原重试：携带账面 userState（尚未复原完成的用户原状态）。新一次接管到场即
 *  作废上一次待决的复原——旧重试不得在新接管之后把状态翻回去（快速禁用/重启用即再
 *  接管的**分叉账**；同 native.ts 的 pendingRestoreCancel 纪律）。且退避窗内的**再接管**
 *  必须取这里的 userState 而非当前读回——退避窗内读回可能是尚未复原成功的中间态，
 *  拿它记账 = 账目投毒。 */
let pendingRestore: { userState: number; cancel: () => void } | null = null

function cancelPendingRestore(): void {
  pendingRestore?.cancel()
  pendingRestore = null
}

/** 接管是否在场（「本次由我托管」的账面事实；未接管 = 无复原义务） */
export function takeoverAutoHideEngaged(): boolean {
  return engaged !== null
}

/** 当前托管的档位（未接管 = null；验收/存证判读用） */
export function takeoverAutoHideMode(): TakeoverAutoHideMode | null {
  return engaged?.mode ?? null
}

/** 把目标写进系统并读回裁决；返回读回值。SETSTATE 与 GETSTATE 都在 appbar.ts 效果面 */
function writeAndRead(target: number): number {
  setAppBarState(target)
  return getAppBarState()
}

/**
 * 建立接管（任务栏接管建立时调用一次，幂等）：记用户接管前原状态 → 落盘记账 →
 * 压到普通栏态的清位目标 → 读回裁决。
 *
 * 记账**先于**置位：复原义务自接管建立即成立（置位失败也欠着「把用户原值还回去」），
 * 与收栏置位的旧口径（置位生效才记账）不同——那是「无接管则无义务」，这里接管本身就是
 * 义务来源。置位失败只落存证，交重申轮询下一拍重试。
 */
export function engageTakeoverAutoHide(log: EventLog | null): void {
  if (engaged !== null) return
  // 复原退避在途的再接管：原状态是 pendingRestore 账面的 userState（复原义务尚未
  // 履行完，账不许投毒）——不得取当前读回，那可能是尚未复原成功的中间态。
  const pending = pendingRestore
  const userState = pending !== null ? pending.userState : getAppBarState()
  engaged = { userState, mode: 'normal' }
  cancelPendingRestore()
  try {
    writeAppBarLedger(userState, log)
  } catch (err) {
    // 尽力语义：盘写不进（权限/磁盘满）不破接管流程——路径①（内存账）仍在，失败存证可见
    log?.append({ type: 'taskbar-autohide-ledger-write-failed', message: String(err) })
  }
  const state = writeAndRead(normalBarAutoHideState(userState))
  log?.append({ type: 'taskbar-autohide-takeover', userState, state })
  if ((state & ABS_AUTOHIDE) === 0) {
    log?.append({ type: 'taskbar-autohide-cleared', reason: 'takeover', userState, state })
  } else {
    log?.append({ type: 'taskbar-autohide-clear-failed', reason: 'takeover', userState, state })
  }
}

/**
 * 进入收栏：把目标切到收栏态（置 ABS_AUTOHIDE，保留 ALWAYSONTOP）。**不重记**用户
 * 原值；未接管时先建立接管（防御路径，记账照 engage 纪律）。档位先落、再读回裁决——
 * 意图随档位走，成败只影响存证与重试，不改档位。
 */
export function enterRetractAutoHide(log: EventLog | null): void {
  if (engaged === null) engageTakeoverAutoHide(log)
  const e = engaged
  if (e === null || e.mode === 'retracted') return
  e.mode = 'retracted'
  const state = writeAndRead(retractAutoHideState(e.userState))
  if ((state & ABS_AUTOHIDE) !== 0) {
    log?.append({ type: 'taskbar-autohide-set', previous: e.userState, state })
  } else {
    log?.append({ type: 'taskbar-autohide-set-failed', previous: e.userState, state })
  }
}

/**
 * 退出收栏：把目标切回**普通栏态的清位目标**（不是用户原值——原值只由退场复原）。
 * 未接管或已在普通档 = 静默空转。
 */
export function clearRetractAutoHide(log: EventLog | null, reason: string): void {
  const e = engaged
  if (e === null || e.mode === 'normal') return
  e.mode = 'normal'
  const state = writeAndRead(normalBarAutoHideState(e.userState))
  if ((state & ABS_AUTOHIDE) === 0) {
    log?.append({ type: 'taskbar-autohide-cleared', reason, userState: e.userState, state })
  } else {
    log?.append({ type: 'taskbar-autohide-clear-failed', reason, userState: e.userState, state })
  }
}

/**
 * 重申当前目标（原生栏重申轮询的重挂动作，工单262）：explorer 重启/可见性翻转后把
 * **当前档位**的目标压回去——账不动（userState 不变、复原义务照旧，目标恒从账派生；
 * explorer 重启按注册表原态复活 ⇒ userState 恰是注册表里用户原态，账面无需也不许换）。
 * 无账（接管建立曾失败/未走过）时按完整接管走。成败以读回事实为准；读回仍不符只落
 * 失败存证、**不退避**——重申由轮询的下一拍天然重试。
 */
export function reassertTakeoverAutoHide(log: EventLog | null): void {
  if (engaged === null) {
    engageTakeoverAutoHide(log)
    return
  }
  const e = engaged
  const retracted = e.mode === 'retracted'
  const state = writeAndRead(retracted ? retractAutoHideState(e.userState) : normalBarAutoHideState(e.userState))
  const ok = retracted ? (state & ABS_AUTOHIDE) !== 0 : (state & ABS_AUTOHIDE) === 0
  log?.append({
    type: ok ? 'taskbar-autohide-reattached' : 'taskbar-autohide-reattach-failed',
    previous: e.userState,
    mode: e.mode,
    state,
  })
}

/**
 * 退场（禁用 / 退役 / dispose / 面板退出——还原路径①）：把**用户接管前原值**写回。
 * 退避重试（有限次、终局有界，与可见性复原同表）：读回不一致按表重试，每拍重新
 * SETSTATE；重试是异步的（销窗/退役流程不被拖住），timer unref（不吊住进程退出）。
 * 未接管 = 静默空转（不为常态路径造噪声）。存证两路：复原到位 →
 * taskbar-autohide-restored；终局仍不一致 → taskbar-autohide-restore-failed。
 */
export function restoreTakeoverAutoHide(log: EventLog | null, reason: string): void {
  if (engaged === null) return
  const userState = engaged.userState
  engaged = null

  /** 排下一拍重试（退避有界；unref：不因待决重试吊住进程退出） */
  const schedule = (delayMs: number, next: number): void => {
    cancelPendingRestore()
    let cancelled = false
    const cancel = (): void => { cancelled = true }
    pendingRestore = { userState, cancel }
    const timer = setTimeout(() => {
      if (pendingRestore?.cancel === cancel) pendingRestore = null
      if (cancelled) return
      run(next)
    }, delayMs)
    timer.unref?.()
  }

  const run = (attempt: number): void => {
    const state = writeAndRead(userState)
    if (state === userState) {
      clearAppBarLedger() // 复原到位：清账（义务履行完毕，不留陈旧账误导守护）
      log?.append({ type: 'taskbar-autohide-restored', reason, state, attempts: attempt })
      return
    }
    const d = planAppBarStateRestore(attempt, 'mismatch')
    if (d.action === 'retry') {
      schedule(d.delayMs, d.attempt)
      return
    }
    clearAppBarLedger() // 终局失败：清账（与内存账同判 discharged；账尽力后不留在盘上误导后续会话）
    log?.append({ type: 'taskbar-autohide-restore-failed', reason, state, attempts: d.attempt })
  }

  run(1)
}
