// 面板侧还原路径① 的落盘接线（工单261，spec #258；ADR-0016 修订记 2026-10-25 双缺陷复审
// Q1/Q2 把托管扩为全接管期后，本文件改钉**全接管期单账**的纪律）：
//   - 接管建立即记账落盘（清位已改系统状态，复原义务自接管开始成立）；
//   - 普通↔收栏切换只换目标，不重记用户原状态（中间态绝不是用户原值）；
//   - 清位失败不中止接管：账仍在盘、档位照走、交重申轮询重试；
//   - 退场复原到位 → 清账；终局失败 → 清账；退避中途进程死亡 → 账仍在盘（守卫/守护接力）；
//   - 退避窗内再接管 → 取账面原状态记账，不取当前读回（防账目投毒）。
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

describe('appbar 还原账：全接管期单账（工单261；双缺陷复审 Q1/Q2 口径）', () => {
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

  it('接管建立即记账落盘（previous=用户原状态）+ 清位存证；重复接管幂等不重记', async () => {
    const m = await importModule()
    const { events, log } = tapeLog()
    ff.state = 0x3 // 用户原状态：自动隐藏 + 置顶
    m.engageTakeoverAutoHide(log as never)
    const file = ledgerFileOf(dir)
    expect(existsSync(file)).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ previous: 3 })
    expect(events.map((e) => e.type)).toEqual([
      'taskbar-autohide-ledger-written',
      'taskbar-autohide-takeover',
      'taskbar-autohide-cleared',
    ])
    // 清位目标：清 AUTOHIDE、留 ALWAYSONTOP
    expect(ff.state).toBe(0x2)
    // 幂等：已接管 = 未动作（不重记、不重复清位）
    m.engageTakeoverAutoHide(log as never)
    expect(events).toHaveLength(3)
    expect(m.takeoverAutoHideEngaged()).toBe(true)
    expect(m.takeoverAutoHideMode()).toBe('normal')
  })

  it('清位未生效 → 不中止接管：账仍在盘（义务成立）、档位照走、落 clear-failed', async () => {
    ff.state = 0x3
    ff.ignoreSets = 1 // SETSTATE 落空：读回仍 0x3
    const m = await importModule()
    const { events, log } = tapeLog()
    m.engageTakeoverAutoHide(log as never)
    expect(events.map((e) => e.type)).toContain('taskbar-autohide-clear-failed')
    // 义务自接管开始成立：账必须已落盘（否则崩溃后用户任务栏永久停在中间态）
    expect(existsSync(ledgerFileOf(dir))).toBe(true)
    expect(m.takeoverAutoHideEngaged()).toBe(true)
    expect(m.takeoverAutoHideMode()).toBe('normal')
  })

  it('普通↔收栏切换只换目标、不重记原状态；退收栏回清位目标而非原值', async () => {
    ff.state = 0x3 // 用户原状态：自动隐藏 + 置顶
    const m = await importModule()
    const { events, log } = tapeLog()
    m.engageTakeoverAutoHide(log as never)
    expect(ff.state).toBe(0x2) // 清位
    m.enterRetractAutoHide(log as never)
    expect(ff.state).toBe(0x3) // 收栏置位
    expect(m.takeoverAutoHideMode()).toBe('retracted')
    m.clearRetractAutoHide(log as never, 'retract-lifted')
    expect(ff.state).toBe(0x2) // 回清位目标，**不是**原值 0x3
    expect(m.takeoverAutoHideMode()).toBe('normal')
    // 账全程只有一份、且仍是用户原状态
    expect(JSON.parse(readFileSync(ledgerFileOf(dir), 'utf8'))).toMatchObject({ previous: 3 })
    expect(events.filter((e) => e.type === 'taskbar-autohide-takeover')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'taskbar-autohide-cleared')).toHaveLength(2)
  })

  it('重申按当前档位压回：普通档清位、收栏档置位', async () => {
    ff.state = 0x3
    const m = await importModule()
    const { events, log } = tapeLog()
    m.engageTakeoverAutoHide(log as never)
    ff.state = 0x3 // explorer 重启：注册表原值复活，清位被冲掉
    m.reassertTakeoverAutoHide(log as never)
    expect(ff.state).toBe(0x2)
    expect(events.find((e) => e.type === 'taskbar-autohide-reattached')).toMatchObject({ mode: 'normal', previous: 3 })
    m.enterRetractAutoHide(log as never)
    ff.state = 0x2 // 置位丢失
    m.reassertTakeoverAutoHide(log as never)
    expect(ff.state).toBe(0x3)
    expect(events.filter((e) => e.type === 'taskbar-autohide-reattached').map((e) => e.mode)).toEqual(['normal', 'retracted'])
  })

  it('退场复原用户原值 → 清账 + restored 存证；再复原（未接管）静默空转', async () => {
    ff.state = 0x3
    const m = await importModule()
    const { events, log } = tapeLog()
    m.engageTakeoverAutoHide(log as never)
    m.restoreTakeoverAutoHide(log as never, 'dispose')
    expect(ff.state).toBe(0x3) // 原值还回去
    expect(existsSync(ledgerFileOf(dir))).toBe(false)
    expect(events.find((e) => e.type === 'taskbar-autohide-restored')).toMatchObject({ reason: 'dispose', attempts: 1 })
    // 未接管 = 静默空转（不为常态路径造噪声）
    const before = events.length
    m.restoreTakeoverAutoHide(log as never, 'dispose')
    expect(events).toHaveLength(before)
    expect(m.takeoverAutoHideEngaged()).toBe(false)
  })

  it('复原退避中途进程死亡 → 账仍在盘上（守卫/守护接力）；退避走完终局 → 清账 + 失败存证', async () => {
    vi.useFakeTimers()
    ff.state = 0x3
    const m = await importModule()
    const { events, log } = tapeLog()
    m.engageTakeoverAutoHide(log as never)
    ff.ignoreSets = Number.MAX_SAFE_INTEGER // 此后 SETSTATE 恒落空（explorer 死现场）
    m.restoreTakeoverAutoHide(log as never, 'dispose')
    // 第一拍失败已排下退避重试：此刻「进程死亡」= 定时器随进程蒸发，账必须仍在盘上
    expect(existsSync(ledgerFileOf(dir))).toBe(true)
    await vi.runAllTimersAsync() // 退避表走完（若进程活着）→ 终局清账 + 失败存证
    expect(existsSync(ledgerFileOf(dir))).toBe(false)
    expect(events.find((e) => e.type === 'taskbar-autohide-restore-failed')).toMatchObject({ reason: 'dispose' })
  })

  it('退避途中读到一致（第二拍到）→ 清账 + attempts=2 存证', async () => {
    vi.useFakeTimers()
    ff.state = 0x3
    const m = await importModule()
    const { events, log } = tapeLog()
    m.engageTakeoverAutoHide(log as never)
    ff.ignoreSets = 1 // 第一拍落空，第二拍到
    m.restoreTakeoverAutoHide(log as never, 'dispose')
    await vi.runAllTimersAsync()
    expect(existsSync(ledgerFileOf(dir))).toBe(false)
    expect(events.find((e) => e.type === 'taskbar-autohide-restored')).toMatchObject({ attempts: 2 })
  })

  it('普通态出发路径①退场（禁用 disabled / 正常退出 dispose）：读回复原用户原值、清账、存证按 reason 透传（工单296：复原义务不随档位缩水）', async () => {
    for (const reason of ['disabled', 'dispose']) {
      ff.state = 0x3
      vi.resetModules()
      const m = await importModule()
      const { events, log } = tapeLog()
      m.engageTakeoverAutoHide(log as never) // 普通栏态建立接管（清位在场），全程不进收栏
      expect(ff.state).toBe(0x2)
      expect(m.takeoverAutoHideMode()).toBe('normal')
      m.restoreTakeoverAutoHide(log as never, reason)
      expect(ff.state).toBe(0x3) // 读回复原 = 接管前原值（成败以读回事实裁决）
      expect(existsSync(ledgerFileOf(dir))).toBe(false)
      expect(events.find((e) => e.type === 'taskbar-autohide-restored')).toMatchObject({ reason, state: 3, attempts: 1 })
    }
  })

  it('普通态退场与收栏态退场共用同一份账、同一套义务（工单296）：两档位出发的退场复原同读回、同清账、同存证形态', async () => {
    // 普通态出发：engage（清位）→ 直接退场
    ff.state = 0x3
    const m = await importModule()
    const normal = tapeLog()
    m.engageTakeoverAutoHide(normal.log as never)
    expect(JSON.parse(readFileSync(ledgerFileOf(dir), 'utf8'))).toMatchObject({ previous: 3 })
    m.restoreTakeoverAutoHide(normal.log as never, 'dispose')
    // 收栏态出发：engage → 进收栏（置位）→ 退场
    vi.resetModules()
    ff.state = 0x3
    const m2 = await importModule()
    const retracted = tapeLog()
    m2.engageTakeoverAutoHide(retracted.log as never)
    m2.enterRetractAutoHide(retracted.log as never)
    expect(JSON.parse(readFileSync(ledgerFileOf(dir), 'utf8'))).toMatchObject({ previous: 3 }) // 同一份账：置位不重记
    m2.restoreTakeoverAutoHide(retracted.log as never, 'dispose')
    // 两幕的义务兑现完全同形：读回同到原值、attempts 同拍、账同清（盘上只剩一个终点）
    const normEv = normal.events.find((e) => e.type === 'taskbar-autohide-restored')
    const retrEv = retracted.events.find((e) => e.type === 'taskbar-autohide-restored')
    expect(normEv).toMatchObject({ reason: 'dispose', state: 3, attempts: 1 })
    expect(retrEv).toMatchObject(normEv!)
    expect(existsSync(ledgerFileOf(dir))).toBe(false)
  })

  it('死路径消费同一份落盘账（工单296）：普通态接管的账由守卫/守护径（panel-exit / guard-dead）从盘上还原并清账——复原目标只认账不认读回', async () => {
    const ledger = await import('../../src/main/taskbar/appbar-ledger')
    for (const reason of ['panel-exit', 'guard-dead']) {
      vi.resetModules()
      ff.state = 0x3
      const m = await importModule()
      const { log } = tapeLog()
      m.engageTakeoverAutoHide(log as never) // 普通态接管：清位 + 账落盘（previous=3）
      expect(ff.state).toBe(0x2)
      expect(existsSync(ledgerFileOf(dir))).toBe(true)
      // 面板崩溃/被强杀：路径①（内存账退避复原）随进程蒸发——不调 restoreTakeoverAutoHide；
      // 守卫/守护到场时系统读回停在清位残留态（≠原值），复原目标只能来自账
      ff.state = 0x0
      const verdict = await ledger.restoreAppBarStateFromLedger(null, reason)
      expect(verdict).toBe('restored')
      expect(ff.state).toBe(0x3) // 读回复原 = 接管前原值
      expect(existsSync(ledgerFileOf(dir))).toBe(false) // 义务履行即清账
    }
  })

  it('复原退避在途再接管 → 账不投毒：仍取账面原状态，旧重试作废', async () => {
    vi.useFakeTimers()
    ff.state = 0x2 // 用户原状态：ALWAYSONTOP（无自动隐藏位）
    const m = await importModule()
    const { events, log } = tapeLog()
    m.engageTakeoverAutoHide(log as never) // 账 { previous: 2 }、清位后仍 0x2
    m.enterRetractAutoHide(log as never) // 置位 → 0x3
    ff.ignoreSets = 1 // 复原第一拍 SETSTATE 落空 → 读回仍 0x3 → 排退避重试（在途）
    m.restoreTakeoverAutoHide(log as never, 'dispose')
    // 退避窗内快速再接管：此刻系统态 0x3（尚未复原成功）——记账必须仍取账面 0x2
    m.engageTakeoverAutoHide(log as never)
    expect(JSON.parse(readFileSync(ledgerFileOf(dir), 'utf8'))).toMatchObject({ previous: 2 })
    expect(events.filter((e) => e.type === 'taskbar-autohide-takeover').map((e) => e.userState)).toEqual([2, 2])
    // 旧复原重试必须已作废：退避表走完也不得把新接管翻回去（无 restored 存证）
    await vi.runAllTimersAsync()
    expect(events.find((e) => e.type === 'taskbar-autohide-restored')).toBeUndefined()
    // 终局复原照账面 0x2 兑付（用户原状态未因再接管丢失）
    m.restoreTakeoverAutoHide(log as never, 'dispose')
    expect(events.find((e) => e.type === 'taskbar-autohide-restored')).toMatchObject({ state: 0x2 })
  })
})
