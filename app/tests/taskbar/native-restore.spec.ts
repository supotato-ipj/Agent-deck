// 原生任务栏还原的兜底策略（工单248）：「瞬时缺位」不能等于「永久放弃」。
// 纯策略单测——FFI 查找与 ShowWindow 是效果层（taskbar/native.ts），接缝由真机验收
// 50-taskbar-carry 的 B1 段覆盖（同 tray-yield 口径：纯逻辑进单测，效果层进验收）。
import { describe, expect, it } from 'vitest'
import {
  planAppBarStateRestore,
  planRestore,
  RESTORE_MAX_ATTEMPTS,
  RESTORE_RETRY_BACKOFF_MS,
  RESTORE_RETRY_TOTAL_MS,
} from '../../src/main/taskbar/native-restore'

describe('原生任务栏还原兜底策略（工单248）', () => {
  it('退避表有界且递增——终局有界：暗窗期不超过 3s', () => {
    expect(RESTORE_RETRY_BACKOFF_MS.length).toBeGreaterThan(0)
    for (let i = 1; i < RESTORE_RETRY_BACKOFF_MS.length; i++) {
      expect(RESTORE_RETRY_BACKOFF_MS[i]).toBeGreaterThan(RESTORE_RETRY_BACKOFF_MS[i - 1])
    }
    expect(RESTORE_RETRY_TOTAL_MS).toBeLessThan(3_000)
    expect(RESTORE_MAX_ATTEMPTS).toBe(RESTORE_RETRY_BACKOFF_MS.length + 1)
  })

  it('首拍命中即终局（不重试）', () => {
    expect(planRestore(1, 'restored')).toEqual({ action: 'done', outcome: 'restored', attempt: 1 })
    expect(planRestore(1, 'already-visible')).toEqual({ action: 'done', outcome: 'already-visible', attempt: 1 })
  })

  it('瞬时缺位不一次就放弃——按退避表重试（这是工单248 的修复本体）', () => {
    const d = planRestore(1, 'not-found')
    if (d.action !== 'retry') throw new Error(`expected retry, got ${JSON.stringify(d)}`)
    expect(d.delayMs).toBe(RESTORE_RETRY_BACKOFF_MS[0])
    expect(d.attempt).toBe(2)
  })

  it('退避表走完 = 终局降级（有限次，不无限重试）', () => {
    expect(planRestore(RESTORE_MAX_ATTEMPTS, 'not-found')).toEqual({
      action: 'done', outcome: 'skipped', attempt: RESTORE_MAX_ATTEMPTS,
    })
  })

  it('句柄在但翻回不生效 → 终局 failed（与「窗口缺位」的降级分族）', () => {
    expect(planRestore(RESTORE_MAX_ATTEMPTS, 'still-hidden')).toEqual({
      action: 'done', outcome: 'failed', attempt: RESTORE_MAX_ATTEMPTS,
    })
  })

  it('重试途中命中即成功（attempt 单调递增，账目可审计）', () => {
    expect(planRestore(3, 'restored')).toEqual({ action: 'done', outcome: 'restored', attempt: 3 })
    const d = planRestore(2, 'still-hidden')
    if (d.action !== 'retry') throw new Error(`expected retry, got ${JSON.stringify(d)}`)
    expect(d.attempt).toBe(3)
    expect(d.delayMs).toBe(RESTORE_RETRY_BACKOFF_MS[1])
  })

  it('非法拍号（≤0）按首拍处理——不越界取退避表', () => {
    const d = planRestore(0, 'not-found')
    if (d.action !== 'retry') throw new Error(`expected retry, got ${JSON.stringify(d)}`)
    expect(d.attempt).toBe(2)
    expect(d.delayMs).toBe(RESTORE_RETRY_BACKOFF_MS[0])
  })
})

describe('appbar 状态复原的兜底策略（工单260 原生栏托管：还原路径①扩展）', () => {
  it('复原到位即终局（读回与原状态相等——首拍命中不重试）', () => {
    expect(planAppBarStateRestore(1, 'restored')).toEqual({ action: 'done', outcome: 'restored', attempt: 1 })
    expect(planAppBarStateRestore(4, 'restored')).toEqual({ action: 'done', outcome: 'restored', attempt: 4 })
  })

  it('读回不一致不一次就放弃——按同一张退避表重试（与可见性复原共享节奏）', () => {
    const d = planAppBarStateRestore(1, 'mismatch')
    if (d.action !== 'retry') throw new Error(`expected retry, got ${JSON.stringify(d)}`)
    expect(d.delayMs).toBe(RESTORE_RETRY_BACKOFF_MS[0])
    expect(d.attempt).toBe(2)
    const d2 = planAppBarStateRestore(3, 'mismatch')
    if (d2.action !== 'retry') throw new Error(`expected retry, got ${JSON.stringify(d2)}`)
    expect(d2.delayMs).toBe(RESTORE_RETRY_BACKOFF_MS[2])
    expect(d2.attempt).toBe(4)
  })

  it('退避表走完 = 终局失败（有限次，终局有界——不无限重试）', () => {
    expect(planAppBarStateRestore(RESTORE_MAX_ATTEMPTS, 'mismatch')).toEqual({
      action: 'done', outcome: 'failed', attempt: RESTORE_MAX_ATTEMPTS,
    })
  })

  it('非法拍号（≤0）按首拍处理——不越界取退避表', () => {
    const d = planAppBarStateRestore(0, 'mismatch')
    if (d.action !== 'retry') throw new Error(`expected retry, got ${JSON.stringify(d)}`)
    expect(d.attempt).toBe(2)
    expect(d.delayMs).toBe(RESTORE_RETRY_BACKOFF_MS[0])
  })
})
