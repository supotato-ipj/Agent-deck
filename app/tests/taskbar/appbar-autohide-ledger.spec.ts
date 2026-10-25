// 面板侧还原路径① 的落盘接线（工单261，spec #258 还原账全路径扩展）：
// appbar-autohide（thide RAII 内存账）× appbar-ledger（持久账）双账一致——
//   - engage 置位生效（读回确认）→ 记账落盘（守卫/守护的复原目标来源）；
//   - 置位未生效 → 不记账（账不许凭空欠出）；
//   - 复原到位 → 清账（义务履行完毕，不留陈旧账误导守护）；
//   - 复原终局失败 → 清账（与内存账同判：账已尽力 discharged）；
//   - 复原退避中途进程死亡 → 账仍在盘（守卫/守护接力，50 电池 A3/A4 的真实现场）。
// FFI 面（getAppBarState/setAppBarState）mock 在模块边界（appbar.ts 是效果层公开面，
// 同「纯逻辑进单测」口径）；账本走真 fs（APPDATA 注入临时目录）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// FFI 模块边界 mock（工厂内的可编程状态面：ignoreSets>0 时 SETSTATE 不生效——
// 模拟 explorer 忙/竞态下的读回不一致）
const ff = vi.hoisted(() => ({
  state: 0,
  ignoreSets: 0,
}))
vi.mock('../../src/main/taskbar/appbar', () => ({
  getAppBarState: () => ff.state,
  setAppBarState: (s: number) => {
    if (ff.ignoreSets > 0) {
      ff.ignoreSets -= 1
      return
    }
    ff.state = s
  },
}))

type Append = { events: Array<Record<string, unknown>>; log: { append: (e: Record<string, unknown>) => void } }
function tapeLog(): Append {
  const events: Array<Record<string, unknown>> = []
  return { events, log: { append: (e) => { events.push(e) } } }
}

const ledgerFileOf = (dir: string): string => path.join(dir, 'agent-deck-panel', 'appbar-ledger.json')

describe('appbar 还原账：路径① 面板侧接线（工单261）', () => {
  let dir: string
  const realAppdata = process.env.APPDATA

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'deck-autohide-'))
    process.env.APPDATA = dir
    ff.state = 0
    ff.ignoreSets = 0
    vi.resetModules()
  })
  afterEach(() => {
    process.env.APPDATA = realAppdata
    rmSync(dir, { recursive: true, force: true })
    vi.useRealTimers()
  })

  async function importModule() {
    return import('../../src/main/taskbar/appbar-autohide')
  }

  it('置位生效 → 记账落盘（previous=置位前原状态）；重复 engage 幂等不重记', async () => {
    const m = await importModule()
    const { events, log } = tapeLog()
    m.engageRetractAutoHide(log as never)
    const file = ledgerFileOf(dir)
    expect(existsSync(file)).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ previous: 0 })
    expect(events.map((e) => e.type)).toEqual(['taskbar-autohide-set', 'taskbar-autohide-ledger-written'])
    // 幂等：已置位 = 未动作（不重记）
    m.engageRetractAutoHide(log as never)
    expect(events).toHaveLength(2)
    expect(m.retractAutoHideEngaged()).toBe(true)
  })

  it('置位未生效（读回仍无 AUTOHIDE 位）→ 不记账（账不许凭空欠出）', async () => {
    ff.ignoreSets = 1 // SETSTATE 落空：读回仍是 0
    const m = await importModule()
    const { events, log } = tapeLog()
    m.engageRetractAutoHide(log as never)
    expect(existsSync(ledgerFileOf(dir))).toBe(false)
    expect(events.map((e) => e.type)).toEqual(['taskbar-autohide-set-failed'])
    expect(m.retractAutoHideEngaged()).toBe(false)
  })

  it('复原到位 → 清账 + restored 存证；再复原（未置位）静默空转', async () => {
    const m = await importModule()
    const { events, log } = tapeLog()
    m.engageRetractAutoHide(log as never)
    m.restoreRetractAutoHide(log as never, 'dispose')
    expect(existsSync(ledgerFileOf(dir))).toBe(false)
    const types = events.map((e) => e.type)
    expect(types).toContain('taskbar-autohide-restored')
    expect(events.find((e) => e.type === 'taskbar-autohide-restored')).toMatchObject({ reason: 'dispose', attempts: 1 })
    // 未置位 = 静默空转（不为常态路径造噪声）
    const before = events.length
    m.restoreRetractAutoHide(log as never, 'dispose')
    expect(events).toHaveLength(before)
  })

  it('复原退避中途进程死亡 → 账仍在盘上（守卫/守护接力复原的现场）；退避走完终局 → 清账 + 失败存证', async () => {
    vi.useFakeTimers()
    const m = await importModule()
    const { events, log } = tapeLog()
    m.engageRetractAutoHide(log as never)
    ff.ignoreSets = Number.MAX_SAFE_INTEGER // 此后 SETSTATE 恒落空（explorer 死现场）
    m.restoreRetractAutoHide(log as never, 'dispose')
    // 第一拍失败已排下退避重试：此刻「进程死亡」= 定时器随进程蒸发，账必须仍在盘上
    expect(existsSync(ledgerFileOf(dir))).toBe(true)
    await vi.runAllTimersAsync() // 退避表走完（若进程活着）→ 终局清账 + 失败存证
    expect(existsSync(ledgerFileOf(dir))).toBe(false)
    expect(events.find((e) => e.type === 'taskbar-autohide-restore-failed')).toMatchObject({ reason: 'dispose' })
  })

  it('退避途中读到一致（第二拍到）→ 清账 + attempts=2 存证', async () => {
    vi.useFakeTimers()
    const m = await importModule()
    const { events, log } = tapeLog()
    m.engageRetractAutoHide(log as never)
    ff.ignoreSets = 1 // 第一拍落空，第二拍到
    m.restoreRetractAutoHide(log as never, 'dispose')
    await vi.runAllTimersAsync()
    expect(existsSync(ledgerFileOf(dir))).toBe(false)
    expect(events.find((e) => e.type === 'taskbar-autohide-restored')).toMatchObject({ attempts: 2 })
  })

  it('复原退避在途再置位 → 账不投毒：previous 仍是用户原状态（非未复原的置位态），旧重试作废', async () => {
    vi.useFakeTimers()
    const m = await importModule()
    const { events, log } = tapeLog()
    ff.state = 0x2 // 用户原状态：ALWAYSONTOP（无自动隐藏位）
    m.engageRetractAutoHide(log as never) // 置位 → 0x3，账 { previous: 2 }
    ff.ignoreSets = 1 // 复原第一拍 SETSTATE 落空 → 读回仍 0x3 → 排退避重试（在途）
    m.restoreRetractAutoHide(log as never, 'dispose')
    // 退避窗内快速再收栏：此刻系统态 0x3（尚未复原成功）——记账必须仍取账面 0x2
    m.engageRetractAutoHide(log as never)
    expect(JSON.parse(readFileSync(ledgerFileOf(dir), 'utf8'))).toMatchObject({ previous: 2 })
    expect(events.filter((e) => e.type === 'taskbar-autohide-set').map((e) => e.previous)).toEqual([2, 2])
    expect(m.retractAutoHideEngaged()).toBe(true)
    // 旧复原重试必须已作废：退避表走完也不得把新置位翻回去（0x3 保持、无 restored 存证）
    await vi.runAllTimersAsync()
    expect(events.find((e) => e.type === 'taskbar-autohide-restored')).toBeUndefined()
    expect(ff.state).toBe(0x3)
    // 终局复原照账面 0x2 兑付（用户原状态未因再置位丢失）
    m.restoreRetractAutoHide(log as never, 'dispose')
    expect(events.find((e) => e.type === 'taskbar-autohide-restored')).toMatchObject({ state: 0x2 })
  })
})
