import { Service } from 'cordis'
import type { Context } from 'cordis'
import type { ClockState } from '../../shared/contract'

/** 时钟服务：面板快照的时钟状态来源（02 起的第一个数据面，快照组装在 BridgeService）。 */
export class ClockService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'clock')
  }

  now(): ClockState {
    const d = new Date()
    return { iso: d.toISOString(), epochMs: d.getTime() }
  }
}
