// 面板侧还原路径① 的落盘接线（工单261，spec #258；工单308 M1 覆盖式普通档改钉
// **恒置位单账**的纪律）：接管建立即**置位**（SET retractAutoHideState——保留
// ALWAYSONTOP、加 ABS_AUTOHIDE，取代旧「接管即清位」）并记账落盘，此后**整个托管期
// 零 appbar 状态写入**（运行期无 enter/clear 中间态——旧普通↔收栏切换语义随 M1 退役）；
//   - 接管建立即记账落盘（previous=用户原状态，复原义务自接管开始成立）；
//   - 置位失败不中止接管：账仍在盘、交重申轮询下一拍重试；
//   - 重申恒置位：explorer 重启按注册表复活原值 / 置位丢失，轮询一律压回置位目标；
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

describe('appbar 还原账：M1 恒置位单账（工单261 落盘接线；工单308 置位语义）', () => {
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

  it('接管建立即置位（retractAutoHideState：留 ALWAYSONTOP、加 AUTOHIDE）+ 记账落盘；重复接管幂等不重记', async () => {
    const m = await importModule()
    const { events, log } = tapeLog()
    ff.state = 0x2 // 用户原状态：仅置顶（spike 基线 0 的有顶变体——置位对它是有动作的）
    m.engageTakeoverAutoHide(log as never)
    const file = ledgerFileOf(dir)
    expect(existsSync(file)).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ previous: 2 })
    expect(events.map((e) => e.type)).toEqual([
      'taskbar-autohide-ledger-written',
      'taskbar-autohide-takeover',
      'taskbar-autohide-set',
    ])
    // 置位目标：留 ALWAYSONTOP、加 ABS_AUTOHIDE（M1：不再是清位目标 0x2）
    expect(ff.state).toBe(0x3)
    // 幂等：已接管 = 未动作（不重记、不重复置位）
    m.engageTakeoverAutoHide(log as never)
    expect(events).toHaveLength(3)
    expect(m.takeoverAutoHideEngaged()).toBe(true)
  })

  it('用户原值=0（未开自动隐藏）：接管置位是**有动作**的写（0→0x1）——M1 行为变化的核心面', async () => {
    const m = await importModule()
    const { events, log } = tapeLog()
    ff.state = 0
    m.engageTakeoverAutoHide(log as never)
    expect(ff.state).toBe(0x1)
    expect(events.find((e) => e.type === 'taskbar-autohide-takeover')).toMatchObject({ userState: 0, state: 0x1 })
    expect(JSON.parse(readFileSync(ledgerFileOf(dir), 'utf8'))).toMatchObject({ previous: 0 })
  })

  it('用户本已开自动隐藏：置位是无操作写入（结果不变、记账与复原照走，不特判）', async () => {
    const m = await importModule()
    const { events, log } = tapeLog()
    ff.state = 0x3
    m.engageTakeoverAutoHide(log as never)
    expect(ff.state).toBe(0x3)
    expect(events.map((e) => e.type)).toEqual([
      'taskbar-autohide-ledger-written',
      'taskbar-autohide-takeover',
      'taskbar-autohide-set',
    ])
    expect(JSON.parse(readFileSync(ledgerFileOf(dir), 'utf8'))).toMatchObject({ previous: 3 })
  })

  it('置位未生效 → 不中止接管：账仍在盘（义务成立）、落 set-failed', async () => {
    ff.state = 0x2
    ff.ignoreSets = 1 // SETSTATE 落空：读回仍 0x2
    const m = await importModule()
    const { events, log } = tapeLog()
    m.engageTakeoverAutoHide(log as never)
    expect(events.map((e) => e.type)).toContain('taskbar-autohide-set-failed')
    // 义务自接管开始成立：账必须已落盘（否则崩溃后用户任务栏永久停在中间态）
    expect(existsSync(ledgerFileOf(dir))).toBe(true)
    expect(m.takeoverAutoHideEngaged()).toBe(true)
  })

  it('重申恒置位（M1：托管期目标态唯一）：置位被冲掉/丢失即压回置位目标，账不重记', async () => {
    ff.state = 0x2
    const m = await importModule()
    const { events, log } = tapeLog()
    m.engageTakeoverAutoHide(log as never)
    expect(ff.state).toBe(0x3)
    ff.state = 0x2 // explorer 重启：注册表原值复活，置位被冲掉
    m.reassertTakeoverAutoHide(log as never)
    expect(ff.state).toBe(0x3)
    expect(events.find((e) => e.type === 'taskbar-autohide-reattached')).toMatchObject({ previous: 2 })
    // 同貌拍再重申：幂等写（目标已在位仍是等值写、存证照落）——值守语义不变
    m.reassertTakeoverAutoHide(log as never)
    expect(ff.state).toBe(0x3)
    expect(events.filter((e) => e.type === 'taskbar-autohide-reattached')).toHaveLength(2)
    // 账全程只有一份、且仍是用户原状态（不因重申换账）
    expect(JSON.parse(readFileSync(ledgerFileOf(dir), 'utf8'))).toMatchObject({ previous: 2 })
    expect(events.filter((e) => e.type === 'taskbar-autohide-takeover')).toHaveLength(1)
  })

  it('重申读回不符只落失败存证、不退避（重试归轮询下一拍）', async () => {
    ff.state = 0x2
    ff.ignoreSets = 2 // engage 与重申两拍 SETSTATE 都落空：读回仍 0x2（M1 下重申与建立同目标，两拍各写一次）
    const m = await importModule()
    const { events, log } = tapeLog()
    m.engageTakeoverAutoHide(log as never) // engage 的置位被吞（ignoreSets=1）
    expect(events.map((e) => e.type)).toContain('taskbar-autohide-set-failed')
    m.reassertTakeoverAutoHide(log as never)
    expect(ff.state).toBe(0x2)
    expect(events.find((e) => e.type === 'taskbar-autohide-reattach-failed')).toMatchObject({ previous: 2 })
  })

  it('无账重申按完整接管走（engage 置位一次到位）', async () => {
    ff.state = 0x2
    const m = await importModule()
    const { events, log } = tapeLog()
    m.reassertTakeoverAutoHide(log as never)
    expect(ff.state).toBe(0x3) // 终态=置位目标
    expect(m.takeoverAutoHideEngaged()).toBe(true)
    expect(events.map((e) => e.type)).toEqual([
      'taskbar-autohide-ledger-written',
      'taskbar-autohide-takeover',
      'taskbar-autohide-set',
    ])
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

  it('用户原值=0（未开自动隐藏）的退场：置位后被复原回 0——托管期置位不遗留（M1 口径收窄的退场面）', async () => {
    ff.state = 0
    const m = await importModule()
    const { events, log } = tapeLog()
    m.engageTakeoverAutoHide(log as never)
    expect(ff.state).toBe(0x1) // 托管期恒置位
    m.restoreTakeoverAutoHide(log as never, 'disabled')
    expect(ff.state).toBe(0) // 读回复原 = 接管前原值
    expect(events.find((e) => e.type === 'taskbar-autohide-restored')).toMatchObject({ reason: 'disabled', state: 0, attempts: 1 })
  })

  it('复原退避中途进程死亡 → 账仍在盘上（守卫/守护接力）；退避走完终局 → 清账 + 失败存证', async () => {
    vi.useFakeTimers()
    ff.state = 0x3
    const m = await importModule()
    const { events, log } = tapeLog()
    m.engageTakeoverAutoHide(log as never)
    ff.state = 0x0 // M1 前提补齐：engage 置位后读回漂成中间态（explorer 忙/竞态现场）——否则复原首拍读回即等原值、退避不可达
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
    ff.state = 0x0 // M1 前提补齐：读回漂成中间态（同上——第一拍落空才可判退避）
    ff.ignoreSets = 1 // 第一拍落空，第二拍到
    m.restoreTakeoverAutoHide(log as never, 'dispose')
    await vi.runAllTimersAsync()
    expect(existsSync(ledgerFileOf(dir))).toBe(false)
    expect(events.find((e) => e.type === 'taskbar-autohide-restored')).toMatchObject({ attempts: 2 })
  })

  it('接管后未进收栏直接退场（disabled / dispose）：读回复原用户原值、清账、存证按 reason 透传（工单296：复原义务不随档位缩水）', async () => {
    for (const reason of ['disabled', 'dispose']) {
      ff.state = 0x3
      vi.resetModules()
      const m = await importModule()
      const { events, log } = tapeLog()
      m.engageTakeoverAutoHide(log as never) // M1：置位对已开用户是无操作写入
      expect(ff.state).toBe(0x3)
      m.restoreTakeoverAutoHide(log as never, reason)
      expect(ff.state).toBe(0x3) // 读回复原 = 接管前原值（成败以读回事实裁决）
      expect(existsSync(ledgerFileOf(dir))).toBe(false)
      expect(events.find((e) => e.type === 'taskbar-autohide-restored')).toMatchObject({ reason, state: 3, attempts: 1 })
    }
  })

  it('两条退场路径共用同一份账、同一套义务（工单296 随 M1 收敛为单一出发态）：两幕的退场复原同读回、同清账、同存证形态', async () => {
    // 第一幕：engage（置位）→ 直接退场
    ff.state = 0x3
    const m = await importModule()
    const first = tapeLog()
    m.engageTakeoverAutoHide(first.log as never)
    expect(JSON.parse(readFileSync(ledgerFileOf(dir), 'utf8'))).toMatchObject({ previous: 3 })
    m.restoreTakeoverAutoHide(first.log as never, 'dispose')
    // 第二幕：engage → 重申压回（M1 托管期唯一动作族）→ 退场
    vi.resetModules()
    ff.state = 0x3
    const m2 = await importModule()
    const second = tapeLog()
    m2.engageTakeoverAutoHide(second.log as never)
    m2.reassertTakeoverAutoHide(second.log as never)
    expect(JSON.parse(readFileSync(ledgerFileOf(dir), 'utf8'))).toMatchObject({ previous: 3 }) // 同一份账：重申不重记
    m2.restoreTakeoverAutoHide(second.log as never, 'dispose')
    // 两幕的义务兑现完全同形：读回同到原值、attempts 同拍、账同清（盘上只剩一个终点）
    const firstEv = first.events.find((e) => e.type === 'taskbar-autohide-restored')
    const secondEv = second.events.find((e) => e.type === 'taskbar-autohide-restored')
    expect(firstEv).toMatchObject({ reason: 'dispose', state: 3, attempts: 1 })
    expect(secondEv).toMatchObject(firstEv!)
    expect(existsSync(ledgerFileOf(dir))).toBe(false)
  })

  it('死路径消费同一份落盘账（工单296）：接管的账由守卫/守护径（panel-exit / guard-dead）从盘上还原并清账——复原目标只认账不认读回', async () => {
    const ledger = await import('../../src/main/taskbar/appbar-ledger')
    for (const reason of ['panel-exit', 'guard-dead']) {
      vi.resetModules()
      ff.state = 0x3
      const m = await importModule()
      const { log } = tapeLog()
      m.engageTakeoverAutoHide(log as never) // 接管：置位 + 账落盘（previous=3）
      expect(ff.state).toBe(0x3)
      expect(existsSync(ledgerFileOf(dir))).toBe(true)
      // 面板崩溃/被强杀：路径①（内存账退避复原）随进程蒸发——不调 restoreTakeoverAutoHide；
      // 守卫/守护到场时系统读回停在中间残留态（≠原值），复原目标只能来自账
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
    m.engageTakeoverAutoHide(log as never) // 账 { previous: 2 }、置位后 0x3
    expect(ff.state).toBe(0x3)
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
