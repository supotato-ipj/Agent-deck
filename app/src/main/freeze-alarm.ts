// 冻结告警一次裁决（工单479，ADR-0032 韧性基线）：渲染层哨兵判出冻结失能（escalate-
// unresponsive，活性心跳武装态）时，面板主进程记账 + 托盘告警**恰好一次**；冻结**不自动
// 杀拉**——自动处置是 ADR-0032 明示的暂缓项，待常驻事件日志积累冻结形态数据后另立决策，
// 本模块只做「告警一次」的裁决半边，绝不触发任何进程处置。
//
// 分层（与仓库纯函数域先例同构）：本文件零 Electron 零 IO，只出裁决；托盘气球与记账
// 落盘在接线侧（index.ts 的 FreezeAlarmController 宿主薄壳）。裁决自带闩：哨兵发射判据
// 已保证 renderer-frozen 一轮一条（render-sentinel-sampler.ts 的 frozenReported），闩是
// 防双源重复的第二道闸——同一冻结 episode 告警义务只尽一次；episode 由恢复
// （renderer-unfrozen）闭合，闭合后再冻是新的一轮、可再告警（用户对复发保有知情权）。

/** 一次冻结/恢复上行（接线侧自哨兵 onFrozen/onUnfrozen 直译） */
export type FreezeAlarmEvent = 'frozen' | 'unfrozen'

export interface FreezeAlarmState {
  /** 本冻结 episode 是否已告警过（恢复即复位） */
  readonly alarmed: boolean
}

export interface FreezeAlarmVerdict {
  /** 本拍是否该执行托盘告警 */
  readonly alarm: boolean
  /** 裁决后的新状态（调用方原样持有，下一拍喂回） */
  readonly state: FreezeAlarmState
}

const OPEN: FreezeAlarmState = { alarmed: false }

/**
 * 一次裁决（纯函数，离线矩阵穷举见 tests/freeze-alarm.spec.ts）：
 * - frozen 且未告警过 → alarm=true，闩落下。
 * - frozen 且已告警过 → 不重复（episode 内告警恰好一次）。
 * - unfrozen → 闩抬起（无论此前是否告警过），本拍不告警。
 */
export function nextFreezeAlarm(state: FreezeAlarmState, event: FreezeAlarmEvent): FreezeAlarmVerdict {
  if (event === 'frozen') {
    if (state.alarmed) return { alarm: false, state }
    return { alarm: true, state: { alarmed: true } }
  }
  return { alarm: false, state: OPEN }
}
