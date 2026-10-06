// 全屏让位判定（工单51，ADR-0007「工作区」决策）：前台窗覆盖主屏全矩形、非自家进程、
// 非桌面宿主类时，任务栏条带让位隐藏。纯谓词单测——FFI 探针与让位动作是效果层，
// 由真机验收（accept/taskbar-appbar.js）覆盖，不进单测（工单46 Testing Decisions）。
import { describe, expect, it } from 'vitest'
import { shouldYieldToFullscreen } from '../../src/main/taskbar/yield'
import type { ForegroundProbe, PhysRect } from '../../src/main/taskbar/yield'

/** 主屏物理矩形（1920×1080 @ 原点 0,0） */
const SCREEN: PhysRect = { left: 0, top: 0, right: 1920, bottom: 1080 }
const OWN_PID = 1000

function probe(over: Partial<ForegroundProbe> = {}): ForegroundProbe {
  return { hwnd: 42, pid: 2000, className: 'GameWindow', rect: { ...SCREEN }, ...over }
}

describe('shouldYieldToFullscreen（全屏让位判定）', () => {
  it('前台窗完整覆盖主屏 → 让位', () => {
    expect(shouldYieldToFullscreen(probe(), SCREEN, OWN_PID)).toBe(true)
  })

  it('无前台窗（探针缺位）→ 不让位', () => {
    expect(shouldYieldToFullscreen(null, SCREEN, OWN_PID)).toBe(false)
  })

  it('自家进程窗口覆盖全屏（面板本体被点击成前台）→ 不让位', () => {
    expect(shouldYieldToFullscreen(probe({ pid: OWN_PID }), SCREEN, OWN_PID)).toBe(false)
  })

  it.each(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd'])(
    '桌面宿主类 %s 覆盖全屏 → 不让位', (className) => {
      expect(shouldYieldToFullscreen(probe({ className }), SCREEN, OWN_PID)).toBe(false)
    },
  )

  it('最大化窗底边停在栏上方（AppBar 占位生效后的工作区矩形）→ 不让位', () => {
    const maximized = { left: 0, top: 0, right: 1920, bottom: 1080 - 96 } // 48DIP × 2x
    expect(shouldYieldToFullscreen(probe({ rect: maximized }), SCREEN, OWN_PID)).toBe(false)
  })

  it('边缘少量过冲（边框/圆角误差 ≤2px）仍判覆盖 → 让位', () => {
    const overshoot = { left: -2, top: -1, right: 1922, bottom: 1082 }
    expect(shouldYieldToFullscreen(probe({ rect: overshoot }), SCREEN, OWN_PID)).toBe(true)
  })

  it('底边差 10px 未覆盖（超容差）→ 不让位', () => {
    const near = { left: 0, top: 0, right: 1920, bottom: 1070 }
    expect(shouldYieldToFullscreen(probe({ rect: near }), SCREEN, OWN_PID)).toBe(false)
  })

  it('普通小窗 → 不让位', () => {
    const small = { left: 300, top: 200, right: 1100, bottom: 800 }
    expect(shouldYieldToFullscreen(probe({ rect: small }), SCREEN, OWN_PID)).toBe(false)
  })

  it('屏矩形原点非 0（虚拟屏坐标）按给定屏矩形判定', () => {
    const shifted: PhysRect = { left: -1920, top: 0, right: 0, bottom: 1080 }
    expect(shouldYieldToFullscreen(probe({ rect: { ...shifted } }), shifted, OWN_PID)).toBe(true)
    expect(shouldYieldToFullscreen(probe({ rect: { ...SCREEN } }), shifted, OWN_PID)).toBe(false)
  })
})
