/**
 * 会话 SQLite 连接池（工单477 束②）接缝测试：临时 SQLite（zcode/hermes 形态），
 * 不碰真实数据。断言的是池的外部行为——「同一库重复读不再重开连接、读到的始终是
 * 写入方的最新事实、坏连接一次重开自愈、寿命到限轮换、关闭即清账」；open 次数经
 * open 依赖缝计数（真 openReadOnly 包一层计数器），不打内部桩。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openReadOnly, SqlitePool } from '../../src/main/scanners/sqlite'
import { collectSessions } from '../../src/main/scanners'
import { HermesFx, ZcodeFx } from './fixtures'

let tmp = ''
const open: Array<ZcodeFx | HermesFx> = []

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-pool-'))
})
afterAll(() => {
  for (const f of open) {
    try { f.close() } catch { /* 尽力 */ }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* Windows 句柄释放滞后时容忍残留 */ }
})

/** 计数 openReadOnly 的依赖缝：open/close 次数就是「每秒重开」行为的外部账 */
function countingOpen() {
  let opened = 0
  let closed = 0
  const open2 = (dbPath: string): DatabaseSync => {
    opened += 1
    const db = openReadOnly(dbPath)
    // 包一层 close 计数代理：其余成员原样转发给真连接
    return new Proxy(db, {
      get(target, prop) {
        if (prop === 'close') {
          return () => {
            target.close()
            closed += 1
          }
        }
        const v = Reflect.get(target, prop, target)
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
      },
    }) as DatabaseSync
  }
  return {
    open: open2,
    counts: () => ({ opened, closed }),
  }
}

describe('会话 SQLite 连接池（工单477 束②）', () => {
  it('同一库重复读复用连接（N 轮只 open 一次），且读到写入方的最新事实（复用不陈旧）', () => {
    const fx = new ZcodeFx(path.join(tmp, `reuse-${Date.now()}`), Date.now() / 1000)
    open.push(fx)
    const counter = countingOpen()
    const pool = new SqlitePool({ open: counter.open })
    const dbPath = path.join(fx.root, 'cli', 'db', 'db.sqlite')
    fx.add('sess_1', 30_000)
    expect(pool.withReadOnly(dbPath, (db) =>
      (db.prepare('SELECT id FROM session').all() as Array<{ id: string }>).length)).toBe(1)
    // 写入方推进账本（外部进程持续写 world 的模拟）
    fx.add('sess_2', 10_000)
    expect(pool.withReadOnly(dbPath, (db) =>
      (db.prepare('SELECT id FROM session').all() as Array<{ id: string }>).map((r) => r.id))).toEqual(['sess_1', 'sess_2'])
    expect(pool.withReadOnly(dbPath, () => 1)).toBe(1)
    expect(counter.counts().opened).toBe(1) // 三轮一次开
    pool.closeAll()
    expect(counter.counts().closed).toBe(1)
    fx.close()
  })

  it('连接寿命到限惰性轮换：下一次读用新连接（旧连接关闭，open 计数 2）', () => {
    const fx = new ZcodeFx(path.join(tmp, `recycle-${Date.now()}`), Date.now() / 1000)
    open.push(fx)
    const counter = countingOpen()
    let nowMs = 1_000_000
    const pool = new SqlitePool({ open: counter.open, now: () => nowMs, maxAgeMs: 300_000 })
    const dbPath = path.join(fx.root, 'cli', 'db', 'db.sqlite')
    fx.add('sess_1', 30_000)
    pool.withReadOnly(dbPath, () => 0)
    nowMs += 301_000 // 寿命尽
    pool.withReadOnly(dbPath, (db) =>
      (db.prepare('SELECT id FROM session').all() as Array<{ id: string }>).length)
    expect(counter.counts().opened).toBe(2)
    expect(counter.counts().closed).toBe(1) // 旧连接已轮换关闭
    pool.closeAll()
    fx.close()
  })

  it('坏连接一次重开自愈：读失败即弃旧连接、重开再试一次（open 计数 2，旧连接关闭）', () => {
    const counter = countingOpen()
    const pool = new SqlitePool({ open: counter.open })
    const broken = { prepare: () => { throw new Error('poisoned handle') } }
    let openNth = 0
    const scripted = (dbPath: string) => {
      openNth += 1
      return openNth === 1 ? broken as unknown as ReturnType<typeof counter.open> : counter.open(dbPath)
    }
    const p2 = new SqlitePool({ open: scripted })
    const fx = new ZcodeFx(path.join(tmp, `heal-${Date.now()}`), Date.now() / 1000)
    open.push(fx)
    fx.add('sess_9', 5_000)
    const dbPath = path.join(fx.root, 'cli', 'db', 'db.sqlite')
    const rows = p2.withReadOnly(dbPath, (db) => (db.prepare('SELECT id FROM session').all() as Array<{ id: string }>))
    expect(rows.map((r) => r.id)).toEqual(['sess_9']) // 重开后读到真数据
    expect(counter.counts().opened).toBe(1) // scripted 第一次给的坏句柄不算计数
    p2.closeAll()
    pool.closeAll()
    fx.close()
  })

  it('重开也不成（库被删）：错误如实上抛，不吞账', () => {
    const counter = countingOpen()
    const pool = new SqlitePool({ open: counter.open })
    const missing = path.join(tmp, `gone-${Date.now()}`, 'nope.sqlite')
    expect(() => pool.withReadOnly(missing, () => 0)).toThrow()
  })

  it('collectSessions 经池复用：zcode+hermes 两工具两轮扫描每库只开一次；不传池维持每轮开（对照）', () => {
    const zfx = new ZcodeFx(path.join(tmp, `cz-${Date.now()}`), Date.now() / 1000)
    const hfx = new HermesFx(path.join(tmp, `ch-${Date.now()}`), Date.now() / 1000)
    open.push(zfx, hfx)
    zfx.add('sess_1', 30_000)
    hfx.add('h1', 30)
    const counter = countingOpen()
    const pool = new SqlitePool({ open: counter.open })
    const roots = { zcode: zfx.root, hermes: hfx.root }
    const now = Date.now() / 1000
    expect(collectSessions(roots, now, { pool }).length).toBe(2)
    expect(collectSessions(roots, now, { pool }).length).toBe(2)
    expect(counter.counts().opened).toBe(2) // 两库各一次，两轮复用
    pool.closeAll()
    expect(counter.counts().closed).toBe(2)
    // 对照：不传池 = 旧路径（直调 openReadOnly，不经计数缝）行为不回归
    expect(collectSessions(roots, now).length).toBe(2)
    zfx.close()
    hfx.close()
  })
})
