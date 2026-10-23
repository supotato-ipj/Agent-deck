// 覆盖判定语义（工单249）：全屏让位谓词 shouldYieldToFullscreen **退役**后，覆盖判定的
// 语义钉在它的真正归属处——shared/retract 的 coversScreenRect。
//
// 为什么单开一份文件（不并进 retract.spec.ts）：retract.spec.ts 的行号被 ADR-0015 引着
// （「穷举矩阵见 app/tests/taskbar/retract.spec.ts:66-77」）——往它头部加一行 import 就把
// 那条引用挤走一格。覆盖语义的用例放这里，retract.spec.ts 一行不动。
//
// 退役理由（守卫断言在 retract.spec.ts）：旧谓词只按矩形覆盖判、**不排除真最大化窗**
// ——收栏释放占位后最大化窗同样覆盖整屏，接回主进程即重引入「两态互咬」。
import { describe, expect, it } from 'vitest'
import { COVER_TOLERANCE, coversScreenRect, resolveBarMode } from '../../src/shared/retract'
import type { PhysRect } from '../../src/shared/retract'

/** 主屏物理矩形（1920×1080 @ 原点 0,0） */
const SCREEN: PhysRect = { left: 0, top: 0, right: 1920, bottom: 1080 }
const OWN_PID = 1000
const OTHER_PID = 2000

describe('coversScreenRect 覆盖判定（覆盖语义的真正归属处）', () => {
  it('前台窗完整覆盖主屏 → 覆盖', () => {
    expect(coversScreenRect({ left: 0, top: 0, right: 1920, bottom: 1080 }, SCREEN)).toBe(true)
  })

  it('边缘少量过冲（边框/圆角误差 ≤ 容差）仍判覆盖', () => {
    expect(coversScreenRect({ left: -2, top: -1, right: 1922, bottom: 1082 }, SCREEN)).toBe(true)
  })

  it('底边差 10px 未覆盖（超容差）→ 不覆盖', () => {
    expect(coversScreenRect({ left: 0, top: 0, right: 1920, bottom: 1070 }, SCREEN)).toBe(false)
  })

  it('普通小窗 → 不覆盖', () => {
    expect(coversScreenRect({ left: 300, top: 200, right: 1100, bottom: 800 }, SCREEN)).toBe(false)
  })

  it('屏矩形原点非 0（虚拟屏坐标）按给定屏矩形判定', () => {
    const shifted: PhysRect = { left: -1920, top: 0, right: 0, bottom: 1080 }
    expect(coversScreenRect({ ...shifted }, shifted)).toBe(true)
    expect(coversScreenRect({ ...SCREEN }, shifted)).toBe(false)
  })

  it('容差是覆盖判定的唯一放宽口（容差外一像素即不覆盖）', () => {
    expect(coversScreenRect({ left: 0, top: 0, right: 1920, bottom: 1080 - COVER_TOLERANCE }, SCREEN)).toBe(true)
    expect(coversScreenRect({ left: 0, top: 0, right: 1920, bottom: 1080 - COVER_TOLERANCE - 1 }, SCREEN)).toBe(false)
  })

  it('真最大化窗铺满整屏 ⇒ 覆盖判定为真——两态必须靠 zoomed 位分开（退役谓词的陷阱）', () => {
    const maximized = { left: 0, top: 0, right: 1920, bottom: 1080 }
    expect(coversScreenRect(maximized, SCREEN)).toBe(true)
    // 真最大化 ⇒ 收栏档（不判让位）：靠 zoomed 位把两态分开，而不是靠覆盖判定
    expect(resolveBarMode({
      probe: { hwnd: 1, pid: OTHER_PID, className: 'App', rect: maximized, zoomed: true },
      screen: SCREEN,
      ownPid: OWN_PID,
      retractEnabled: true,
      appBarDegraded: false,
    })).toBe('maximize-retract')
    // 同矩形但非真最大化（手拉铺满）⇒ 让位档
    expect(resolveBarMode({
      probe: { hwnd: 2, pid: OTHER_PID, className: 'App', rect: maximized, zoomed: false },
      screen: SCREEN,
      ownPid: OWN_PID,
      retractEnabled: true,
      appBarDegraded: false,
    })).toBe('fullscreen-yield')
  })
})
