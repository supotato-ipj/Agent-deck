import { Service } from 'cordis'
import type { Context } from 'cordis'
import type { ClockState, PanelSnapshot } from '../../shared/contract'

/** 时钟服务：面板快照的时钟状态来源（02 唯一数据面，后续工单扩展会话/硬件/桌面项）。 */
export class ClockService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'clock')
  }

  now(): ClockState {
    const d = new Date()
    return { iso: d.toISOString(), epochMs: d.getTime() }
  }

  snapshot(): PanelSnapshot {
    return { clock: this.now() }
  }
}
