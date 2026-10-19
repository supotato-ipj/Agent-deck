import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WinDRestorer, WIN_D_DEBOUNCE_MS, WIN_D_POLL_MS } from '../src/main/wind-restore'

describe('WinDRestorer（Win+D 防抖自动恢复）', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('收起态首次命中触发 onMinimized（重复轮询不重复触发），防抖期满且仍收起则恢复', () => {
    let down: 'minimized' | 'hidden' | null = 'minimized'
    const minimized = vi.fn()
    const restore = vi.fn()
    const r = new WinDRestorer(() => down, { onMinimized: minimized, onRestore: restore }, WIN_D_DEBOUNCE_MS, WIN_D_POLL_MS)

    vi.advanceTimersByTime(250)
    expect(minimized).toHaveBeenCalledTimes(1)
    expect(minimized).toHaveBeenCalledWith('minimized')

    vi.advanceTimersByTime(1250) // 1.5s 未满
    expect(restore).not.toHaveBeenCalled()

    vi.advanceTimersByTime(250) // 期满，仍收起
    expect(restore).toHaveBeenCalledTimes(1)
    expect(restore).toHaveBeenCalledWith('minimized', WIN_D_DEBOUNCE_MS)
    r.dispose()
  })

  it('防抖期内解除收起（再按一次 Win+D / 托盘唤回）则取消恢复，再收起开启新防抖期', () => {
    let down: 'minimized' | 'hidden' | null = 'minimized'
    const minimized = vi.fn()
    const restore = vi.fn()
    const r = new WinDRestorer(() => down, { onMinimized: minimized, onRestore: restore }, WIN_D_DEBOUNCE_MS, WIN_D_POLL_MS)

    vi.advanceTimersByTime(250)
    down = null // shell 还原了面板
    vi.advanceTimersByTime(2500)
    expect(restore).not.toHaveBeenCalled()

    down = 'hidden' // 再次收起 → 新的最小化期
    vi.advanceTimersByTime(250)
    expect(minimized).toHaveBeenCalledTimes(2)
    expect(minimized).toHaveBeenLastCalledWith('hidden')
    vi.advanceTimersByTime(1500)
    expect(restore).toHaveBeenCalledTimes(1)
    expect(restore).toHaveBeenCalledWith('hidden', WIN_D_DEBOUNCE_MS)
    r.dispose()
  })

  it('挂起期间重复命中不重置防抖计时（iconic 期间每轮都命中，重置将永不恢复）', () => {
    let down: 'minimized' | 'hidden' | null = 'minimized'
    const minimized = vi.fn()
    const restore = vi.fn()
    const r = new WinDRestorer(() => down, { onMinimized: minimized, onRestore: restore }, WIN_D_DEBOUNCE_MS, WIN_D_POLL_MS)

    vi.advanceTimersByTime(1000) // 4 次轮询全部命中
    expect(minimized).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(750) // 距首次命中 1.75s ≥ 1.5s
    expect(restore).toHaveBeenCalledTimes(1)
    r.dispose()
  })

  it('从未收起则无任何事件', () => {
    const minimized = vi.fn()
    const restore = vi.fn()
    const r = new WinDRestorer(() => null, { onMinimized: minimized, onRestore: restore }, WIN_D_DEBOUNCE_MS, WIN_D_POLL_MS)

    vi.advanceTimersByTime(5000)
    expect(minimized).not.toHaveBeenCalled()
    expect(restore).not.toHaveBeenCalled()
    r.dispose()
  })

  it('dispose 后彻底停摆', () => {
    let down: 'minimized' | 'hidden' | null = null
    const minimized = vi.fn()
    const restore = vi.fn()
    const r = new WinDRestorer(() => down, { onMinimized: minimized, onRestore: restore }, WIN_D_DEBOUNCE_MS, WIN_D_POLL_MS)

    down = 'minimized'
    r.dispose()
    vi.advanceTimersByTime(5000)
    expect(minimized).not.toHaveBeenCalled()
    expect(restore).not.toHaveBeenCalled()
  })
})
