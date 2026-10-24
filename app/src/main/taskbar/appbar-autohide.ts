// 原生栏托管（工单260，spec #258）：最大化收栏态临时置位原生任务栏 appbar 状态
// ABS_AUTOHIDE（保留 ALWAYSONTOP 位，目标值出自纯函数 retractAutoHideState）——shell
// 在自动隐藏态释放原生任务栏 48px 保留带（spike 取证 docs/audit/2026-10-24-
// t257-autohide-setstate-probe.md：工作区底边 1392→1440=屏底），最大化窗铺满整屏；
// 退出收栏即复原原状态（thide RAII 蓝本：记原状态 → 置位 → 退出复原）。
//
// 生命周期纪律：置位/复原挂进三态机（planBarTransition 的 engageAutoHide /
// restoreAutoHide 旗帜，效果层在 taskbar/window.ts 的 applyBarMode/destroy 照单执行），
// 与唤出条同生命周期——仅收栏态置位，非收栏时段系统行为与现状一致；用户本已开启
// 自动隐藏时置位为无操作（retractAutoHideState 结果不变）、记账照走、复原照走，逻辑
// 不特判。降级档与 taskbar.maximizeRetract=off 下裁决器永不进收栏档（resolveBarMode
// 两道闸门），故本模块不会被调到——置位与收栏整体同开关。
//
// 复原走还原路径①（退避重试）：读回不一致按 native-restore 的同一张退避表重试
// （有限次、终局有界），异步推进不拖住条带销毁/退收栏；timer unref 不吊住进程退出。
// 工单261（还原账全路径扩展）：置位生效即**记账落盘**（appbar-ledger，userData/
// appbar-ledger.json）——守卫（before-quit/panel-exit）与 guard-dead 还原守护不持
// 面板内存账，落盘账是它们的复原目标来源；复原到位/终局失败即**清账**（不留陈旧账
// 误导守护），退避中途进程死亡则账留盘上由下一层接力（50 电池 A3/A4 现场由验真机）。
// 本模块与 native.ts 的可见性账各自独立（ShowWindow 与 appbar 状态是两个系统事实），
// 互不代偿。
//
// 效果层（FFI 效果面，离线不可测）：接缝由真机验收 50/51 电池覆盖（工作区数值与
// StuckRects3 字节是外部可观测面）；同 tray-yield/native 口径——纯逻辑进单测
// （retractAutoHideState / planAppBarStateRestore），效果层进验收。
import type { EventLog } from '../panel-ipc'
import { getAppBarState, setAppBarState } from './appbar'
import { clearAppBarLedger, writeAppBarLedger } from './appbar-ledger'
import { planAppBarStateRestore } from './native-restore'
import { ABS_AUTOHIDE, retractAutoHideState } from './retract'

/** 原状态记账（RAII 账本）：null = 未置位（无复原义务）。模块级单账——原生栏 appbar
 *  状态是会话级事实，与哪扇条带窗现任无关（同 hidNative 的控制器级口径）。 */
let engaged: { previous: number } | null = null

/** 待决的复原重试：新一次置位到场即作废上一次待决的复原——旧重试不得在新置位之后
 *  把状态翻回去（快速退收栏/再收栏的分叉账；同 native.ts 的 pendingRestoreCancel 纪律）。 */
let pendingRestoreCancel: (() => void) | null = null

function cancelPendingRestore(): void {
  pendingRestoreCancel?.()
  pendingRestoreCancel = null
}

/** 置位是否在场（「本次由我置位」的账面事实；未置位 = 无复原义务） */
export function retractAutoHideEngaged(): boolean {
  return engaged !== null
}

/**
 * 进入收栏：记原 appbar 状态（ABM_GETSTATE）→ 置 ABS_AUTOHIDE（ABM_SETSTATE）。
 * 幂等：已置位 = 未动作。成败以读回事实为准（spike：置位后读回含 AUTOHIDE 位）——
 * 置位未生效则**不记账**（无复原义务，账不许凭空欠出），存证落失败供验收判读。
 */
export function engageRetractAutoHide(log: EventLog | null): void {
  if (engaged !== null) return
  const previous = getAppBarState()
  setAppBarState(retractAutoHideState(previous))
  const state = getAppBarState()
  if ((state & ABS_AUTOHIDE) !== 0) {
    engaged = { previous }
    // 置位生效 = 本次确由我置 → 作废上一次待决的复原重试（账换人了，旧账不赖新账）
    cancelPendingRestore()
    log?.append({ type: 'taskbar-autohide-set', previous, state })
    // 落盘记账（工单261）：置位生效 = 本次确由我置 → 守卫/守护的复原目标入账。
    // 尽力语义：盘写不进（权限/磁盘满）不破置位流程——路径①（内存账）仍在，失败存证可见。
    try {
      writeAppBarLedger(previous, log)
    } catch (err) {
      log?.append({ type: 'taskbar-autohide-ledger-write-failed', message: String(err) })
    }
    return
  }
  log?.append({ type: 'taskbar-autohide-set-failed', previous, state })
}

/**
 * 退出收栏 / 条带销毁（面板退出、禁用、退役——还原路径①）：复原原 appbar 状态。
 * 退避重试（有限次、终局有界，与可见性复原同表）：读回不一致按表重试，每拍重新
 * SETSTATE；重试是异步的（退收栏迁移与销窗流程不被拖住），timer unref（不吊住进程
 * 退出）。未置位 = 静默空转（不为常态路径造噪声）。存证两路：复原到位 →
 * taskbar-autohide-restored；终局仍不一致 → taskbar-autohide-restore-failed。
 */
export function restoreRetractAutoHide(log: EventLog | null, reason: string): void {
  if (engaged === null) return
  const previous = engaged.previous
  engaged = null

  /** 排下一拍重试（退避有界；unref：不因待决重试吊住进程退出） */
  const schedule = (delayMs: number, next: number): void => {
    cancelPendingRestore()
    let cancelled = false
    const cancel = (): void => { cancelled = true }
    pendingRestoreCancel = cancel
    const timer = setTimeout(() => {
      if (pendingRestoreCancel === cancel) pendingRestoreCancel = null
      if (cancelled) return
      run(next)
    }, delayMs)
    timer.unref?.()
  }

  const run = (attempt: number): void => {
    setAppBarState(previous)
    const state = getAppBarState()
    if (state === previous) {
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
