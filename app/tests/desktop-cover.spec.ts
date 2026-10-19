import { describe, expect, it } from 'vitest'
import { coverDecision } from '../src/main/desktop-cover'

/** 桌面遮罩守望裁决（工单07）：Progman 压顶 engage / 回底 release 的状态机矩阵。
 * 纯函数缝——z 序侦察由调用方完成，这里只裁决。 */
describe('coverDecision', () => {
  // 常态：面板钉底、Progman 恰在其下（最底）、无 TOPMOST
  const normal = {
    panelVisible: true, panelMinimized: false, panelTopmost: false,
    progmanFound: true, progmanAbovePanel: false, progmanBottomMost: true,
  }

  it('常态（Progman 在面板之下）→ 不动作', () => {
    expect(coverDecision(normal)).toBeNull()
  })

  it('show desktop 态（Progman 抬到面板之上）→ engage 提入 TOPMOST', () => {
    expect(coverDecision({ ...normal, progmanAbovePanel: true, progmanBottomMost: false })).toBe('engage')
  })

  it('TOPMOST 中且 Progman 仍抬顶（show desktop 进行中）→ 维持', () => {
    expect(coverDecision({
      ...normal, panelTopmost: true, progmanAbovePanel: false, progmanBottomMost: false,
    })).toBeNull()
  })

  it('TOPMOST 中且 Progman 回底（show desktop 结束）→ release 撤出', () => {
    expect(coverDecision({ ...normal, panelTopmost: true })).toBe('release')
  })

  it('面板最小化/隐藏：不参与遮罩博弈，TOPMOST 残留即撤', () => {
    expect(coverDecision({ ...normal, panelTopmost: true, panelMinimized: true })).toBe('release')
    expect(coverDecision({ ...normal, panelTopmost: true, panelVisible: false })).toBe('release')
    expect(coverDecision({ ...normal, panelMinimized: true })).toBeNull()
    expect(coverDecision({ ...normal, panelVisible: false })).toBeNull()
    // 最小化但 Progman 抬顶：不 engage（防抖恢复器接管，回显后再议）
    expect(coverDecision({ ...normal, panelMinimized: true, progmanAbovePanel: true, progmanBottomMost: false })).toBeNull()
  })

  it('无 Progman（异形 shell）：不 engage；TOPMOST 残留即撤', () => {
    expect(coverDecision({ ...normal, progmanFound: false, progmanAbovePanel: true, progmanBottomMost: false })).toBeNull()
    expect(coverDecision({ ...normal, progmanFound: false, panelTopmost: true })).toBe('release')
  })
})
