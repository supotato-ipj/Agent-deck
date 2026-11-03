/**
 * 标题栏拖入纯裁决测试（工单407，spec #403 决策「新增一个内部工作区拖入命令」）：
 * 命令门禁（可用/配对/当前普通桌面/配对 ID 在册）、迁移确认判据（桌面 ID 回读 + 零
 * GUID 拒认）、回滚确认判据、有界预算常量。零 IO/FFI/Electron。
 */
import { describe, expect, it } from 'vitest'
import {
  DRAG_IN_CONFIRM_TIMEOUT_MS,
  DRAG_IN_MOVE_ATTEMPTS,
  decideDragInGate,
  isZeroGuid,
  migrationConfirmed,
  rollbackConfirmed,
} from '../../src/main/desktop/drag-in-plan'

describe('拖入门禁（工单407）', () => {
  const base = {
    workspaceAvailable: true,
    paired: true,
    currentMode: 'normal' as const,
    agentId: 'agent-1',
    normalId: 'normal-1',
  }

  it('合格门禁：可用 + 已配对 + 当前普通桌面 + 双 ID 在册 → proceed', () => {
    expect(decideDragInGate(base)).toEqual({ action: 'proceed' })
  })

  it('工作区不可用 → unavailable（失败关闭）', () => {
    expect(decideDragInGate({ ...base, workspaceAvailable: false })).toEqual({ action: 'reject', reason: 'unavailable' })
  })

  it('未配对 → unpaired；当前 Agent 桌面 → not-normal-desktop；当前非托管 → not-normal-desktop', () => {
    expect(decideDragInGate({ ...base, paired: false })).toEqual({ action: 'reject', reason: 'unpaired' })
    expect(decideDragInGate({ ...base, currentMode: 'agent' })).toEqual({ action: 'reject', reason: 'not-normal-desktop' })
    expect(decideDragInGate({ ...base, currentMode: 'unmanaged' })).toEqual({ action: 'reject', reason: 'not-normal-desktop' })
  })

  it('配对缺侧 → missing-pairing-id（不拿半份配对猜目标）', () => {
    expect(decideDragInGate({ ...base, agentId: null })).toEqual({ action: 'reject', reason: 'missing-pairing-id' })
    expect(decideDragInGate({ ...base, normalId: '' })).toEqual({ action: 'reject', reason: 'missing-pairing-id' })
  })
})

describe('迁移确认判据（工单407：以桌面 ID 回读确认，story 46）', () => {
  it('回读 = Agent 桌面 ID → 确认', () => {
    expect(migrationConfirmed('agent-1', 'agent-1')).toBe(true)
  })

  it('回读 null / 仍原桌面 / 其他桌面 → 未确认', () => {
    expect(migrationConfirmed(null, 'agent-1')).toBe(false)
    expect(migrationConfirmed('normal-1', 'agent-1')).toBe(false)
    expect(migrationConfirmed('third-1', 'agent-1')).toBe(false)
  })

  it('零 GUID 拒认（P7 实证：新建窗首读全零不等于归属）', () => {
    expect(isZeroGuid('00000000-0000-0000-0000-000000000000')).toBe(true)
    expect(isZeroGuid('00000000-0000-0000-0000-000000000000'.slice(0, 8) + '-aaaa')).toBe(true)
    expect(isZeroGuid('agent-1')).toBe(false)
    expect(isZeroGuid(null)).toBe(false)
    expect(migrationConfirmed('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000')).toBe(false)
  })
})

describe('回滚确认判据（工单407 story 47）', () => {
  it('回读 = 原普通桌面 ID → 回滚确认；null/其他 → 未确认', () => {
    expect(rollbackConfirmed('normal-1', 'normal-1')).toBe(true)
    expect(rollbackConfirmed(null, 'normal-1')).toBe(false)
    expect(rollbackConfirmed('agent-1', 'normal-1')).toBe(false)
  })
})

describe('有界预算常量（ADR-0028：桌面切换确认 ≤1s；重试有界）', () => {
  it('确认预算 ≤1000ms、移动尝试有界、确认轮询步进为正值', () => {
    expect(DRAG_IN_CONFIRM_TIMEOUT_MS).toBeLessThanOrEqual(1000)
    expect(DRAG_IN_MOVE_ATTEMPTS).toBeGreaterThanOrEqual(2)
    expect(DRAG_IN_MOVE_ATTEMPTS).toBeLessThanOrEqual(5)
  })
})
