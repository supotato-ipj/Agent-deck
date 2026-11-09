/**
 * 条带置顶重申让位裁决纯函数测试（工单450，popup-plan.spec 同形态）：重申动作三分支
 * 零 Electron/FFI——效果层（setTopmost/moveBelow/ownWindowsAbove）由真机验收覆盖
 * （popup-z-forensics 取证工具双形态判据：浮层/tooltip 全程无一拍被条带反压）。
 * 语义锚点：「对世界照抢、对自家让位」——无自家窗在条带上方时行为必须与旧版逐字一致。
 */
import { describe, expect, it } from 'vitest'
import { planTopmostReassert } from '../../src/main/taskbar/topmost-plan'

describe('置顶重申让位裁决（工单450）', () => {
  it('条带上方无自家窗：全量抢回（旧行为逐字不变），不插队', () => {
    expect(planTopmostReassert({ topmost: true, ownAbove: [] }))
      .toEqual({ jump: true, below: null })
  })

  it('走查不可判（null，极深链/条带销毁）：按无自家窗处理——退回旧版全量重申，安全方向', () => {
    expect(planTopmostReassert({ topmost: true, ownAbove: null }))
      .toEqual({ jump: true, below: null })
    expect(planTopmostReassert({ topmost: false, ownAbove: null }))
      .toEqual({ jump: true, below: null })
  })

  it('自家浮层在条带上方且置顶位在：不抢带顶，插到最低一枚自家窗正下方', () => {
    expect(planTopmostReassert({ topmost: true, ownAbove: [0x620b72] }))
      .toEqual({ jump: false, below: 0x620b72 })
  })

  it('多枚自家窗（浮层+tooltip 同场）：插最低位（走查序末位），其余自家窗全部仍在条带之上', () => {
    expect(planTopmostReassert({ topmost: true, ownAbove: [0xaaa, 0xbbb, 0xccc] }))
      .toEqual({ jump: false, below: 0xccc })
  })

  it('自家窗在上方但置顶位丢失（让位恢复竞态等）：先回带再插队——两动作都执行', () => {
    expect(planTopmostReassert({ topmost: false, ownAbove: [0x620b72] }))
      .toEqual({ jump: true, below: 0x620b72 })
  })
})
