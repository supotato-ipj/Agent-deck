// appbar 状态还原账落盘（工单261，spec #258）：三还原路径共享的持久账本。
//
// 接缝（离线可测的公开边界）：
//   ① 编解码纯函数（encode/parse）：账本字节格式与「腐账不认」纪律；
//   ② 落盘生命周期（write/clear/read 对真实 fs，APPDATA 注入临时目录）：
//      位置 = userData（面板/守卫 Electron 侧）≡ %APPDATA%\agent-deck-panel（守护
//      ELECTRON_RUN_AS_NODE 侧的推导路径）——两侧同址是还原守护能读到账的前提；
//   ③ 复原编排（restoreAppBarStateFromLedger，依赖注入）：读账→SETSTATE→读回裁决→
//      成功清账 / 终局清账并落失败存证 / 缺账静默（与 restoreNativeTaskbarIfHidden
//      同款「不为常态路径造噪声」纪律）。
// 效果层（真 FFI 置位/读回、守卫与守护进程接线）由真机验收 50-taskbar-carry
// A2/A3/A4 覆盖（同 tray-yield/native 口径）。
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  APPBAR_LEDGER_FILE,
  appbarLedgerPath,
  clearAppBarLedger,
  encodeAppBarLedger,
  parseAppBarLedger,
  readAppBarLedger,
  restoreAppBarStateFromLedger,
  writeAppBarLedger,
  type AppBarLedgerEntry,
  type AppBarLedgerRestoreDeps,
} from '../../src/main/taskbar/appbar-ledger'
import { RESTORE_MAX_ATTEMPTS, RESTORE_RETRY_BACKOFF_MS } from '../../src/main/taskbar/native-restore'

/** 存证收集器（事件面断言用） */
function tapeLog() {
  const events: Array<Record<string, unknown>> = []
  return { events, log: { append: (e: Record<string, unknown>) => { events.push(e) } } }
}

/** 依赖注入工厂：内存 FFI（按脚本翻转状态）+ 内存账本 + 记录型 sleep */
function fakeDeps(script: { previous: number; readBacks: number[]; present?: boolean }): {
  deps: AppBarLedgerRestoreDeps
  calls: { set: number[]; cleared: number; sleeps: number[] }
  ledger: { entry: AppBarLedgerEntry | null }
} {
  const calls = { set: [] as number[], cleared: 0, sleeps: [] as number[] }
  let readIdx = 0
  const ledger = { entry: script.present === false ? null : ({ previous: script.previous, pid: 1, t: 1 } as AppBarLedgerEntry) }
  const deps: AppBarLedgerRestoreDeps = {
    read: () => ledger.entry,
    clear: () => { calls.cleared += 1; ledger.entry = null },
    setState: (s) => { calls.set.push(s) },
    getState: () => script.readBacks[Math.min(readIdx++, script.readBacks.length - 1)] ?? script.readBacks[script.readBacks.length - 1],
    sleep: async (ms) => { calls.sleeps.push(ms) },
  }
  return { deps, calls, ledger }
}

const ENTRY: AppBarLedgerEntry = { previous: 0, pid: 4321, t: 1761180000000 }

describe('appbar 还原账：编解码纯函数（工单261）', () => {
  it('账目 round-trip：encode → parse 全等', () => {
    expect(parseAppBarLedger(encodeAppBarLedger(ENTRY))).toEqual(ENTRY)
  })

  it('腐账不认：非 JSON / 缺字段 / previous 越界或非整数 / 非对象 → null（账不许凭空欠出）', () => {
    expect(parseAppBarLedger('not json {')).toBeNull()
    expect(parseAppBarLedger('null')).toBeNull()
    expect(parseAppBarLedger('[]')).toBeNull()
    expect(parseAppBarLedger(JSON.stringify({ pid: 1, t: 1 }))).toBeNull() // 缺 previous
    expect(parseAppBarLedger(JSON.stringify({ previous: 4, pid: 1, t: 1 }))).toBeNull() // previous 越界（ABS 位掩码 0x3）
    expect(parseAppBarLedger(JSON.stringify({ previous: 1.5, pid: 1, t: 1 }))).toBeNull() // 非整数
    expect(parseAppBarLedger(JSON.stringify({ previous: -1, pid: 1, t: 1 }))).toBeNull()
    expect(parseAppBarLedger(JSON.stringify({ previous: '0', pid: 1, t: 1 }))).toBeNull() // 字符串状态位不认
  })

  it('previous 合法域 = ABS 位掩码 0..3（GETSTATE 读回域）', () => {
    for (const previous of [0, 1, 2, 3]) {
      expect(parseAppBarLedger(encodeAppBarLedger({ previous, pid: 1, t: 1 }))?.previous).toBe(previous)
    }
  })
})

describe('appbar 还原账：落盘生命周期（工单261）', () => {
  let dir: string
  const realAppdata = process.env.APPDATA

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'deck-ledger-'))
    process.env.APPDATA = dir // 守护侧（ELECTRON_RUN_AS_NODE）的推导路径同此根
  })
  afterEach(() => {
    process.env.APPDATA = realAppdata
    rmSync(dir, { recursive: true, force: true })
  })

  it('记账落 userData/appbar-ledger.json（面板/守卫与还原守护同址）', () => {
    const t0 = Date.now()
    writeAppBarLedger(ENTRY.previous, null)
    const file = path.join(dir, 'agent-deck-panel', APPBAR_LEDGER_FILE)
    expect(existsSync(file)).toBe(true)
    expect(appbarLedgerPath()).toBe(file)
    // 取证面：pid/t 是记账进程自己的事实（不是调用方转述）
    expect(parseAppBarLedger(readFileSync(file, 'utf8'))).toMatchObject({ previous: ENTRY.previous, pid: process.pid })
    const onDisk = parseAppBarLedger(readFileSync(file, 'utf8'))
    expect(onDisk?.t ?? 0).toBeGreaterThanOrEqual(t0)
  })

  it('清账 = 文件消失（面板清场清除，不留陈旧账误导守护）；缺账清账不抛', () => {
    writeAppBarLedger(ENTRY.previous, null)
    clearAppBarLedger()
    expect(existsSync(appbarLedgerPath())).toBe(false)
    expect(() => clearAppBarLedger()).not.toThrow()
  })

  it('腐账即清：认不了的账从盘上移除（不留给后续会话），返回 null', () => {
    const file = path.join(dir, 'agent-deck-panel', APPBAR_LEDGER_FILE)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, '{corrupt', 'utf8')
    const { events, log } = tapeLog()
    expect(readAppBarLedger(log)).toBeNull()
    expect(existsSync(file)).toBe(false)
    expect(events.filter((e) => e.type === 'taskbar-autohide-ledger-corrupt')).toHaveLength(1)
  })
})

describe('appbar 还原账：复原编排 restoreAppBarStateFromLedger（工单261，路径②③共用）', () => {
  it('缺账 → absent：不动 FFI、不落存证（守卫每次退出一调，不为常态路径造噪声）', async () => {
    const { deps, calls } = fakeDeps({ previous: 0, readBacks: [0], present: false })
    const { events, log } = tapeLog()
    await expect(restoreAppBarStateFromLedger(log, 'panel-exit', deps)).resolves.toBe('absent')
    expect(calls.set).toHaveLength(0)
    expect(calls.cleared).toBe(0)
    expect(events).toHaveLength(0)
  })

  it('读回一致 → restored：清账 + taskbar-autohide-restored（reason 透传，attempts=1）', async () => {
    const { deps, calls, ledger } = fakeDeps({ previous: 0, readBacks: [0] })
    const { events, log } = tapeLog()
    await expect(restoreAppBarStateFromLedger(log, 'panel-exit', deps)).resolves.toBe('restored')
    expect(calls.set).toEqual([0])
    expect(calls.cleared).toBe(1)
    expect(ledger.entry).toBeNull()
    expect(events).toEqual([{ type: 'taskbar-autohide-restored', reason: 'panel-exit', state: 0, attempts: 1 }])
  })

  it('读回不一致 → 按 native-restore 同一张退避表重试，命中即清账（attempts=3）', async () => {
    const { deps, calls } = fakeDeps({ previous: 2, readBacks: [1, 1, 2] }) // 前两拍不一致，第三拍到
    const { events, log } = tapeLog()
    await expect(restoreAppBarStateFromLedger(log, 'guard-dead', deps)).resolves.toBe('restored')
    expect(calls.set).toEqual([2, 2, 2]) // 每拍重新 SETSTATE
    expect(calls.sleeps).toEqual([RESTORE_RETRY_BACKOFF_MS[0], RESTORE_RETRY_BACKOFF_MS[1]]) // 40/80
    expect(calls.cleared).toBe(1)
    expect(events.at(-1)).toEqual({ type: 'taskbar-autohide-restored', reason: 'guard-dead', state: 2, attempts: 3 })
  })

  it('退避表走完仍不一致 → 终局 failed：**清账**（不欠陈旧账给后续会话）+ 失败存证（attempts 有界）', async () => {
    const { deps, calls } = fakeDeps({ previous: 0, readBacks: [1] }) // 恒不一致
    const { events, log } = tapeLog()
    await expect(restoreAppBarStateFromLedger(log, 'outer-quit', deps)).resolves.toBe('failed')
    expect(calls.set).toHaveLength(RESTORE_MAX_ATTEMPTS)
    expect(calls.sleeps).toHaveLength(RESTORE_MAX_ATTEMPTS - 1)
    expect(calls.cleared).toBe(1) // 终局清账：账已尽力，不留在盘上误导下一会话的守护
    expect(events.at(-1)).toEqual({ type: 'taskbar-autohide-restore-failed', reason: 'outer-quit', state: 1, attempts: RESTORE_MAX_ATTEMPTS })
  })
})
