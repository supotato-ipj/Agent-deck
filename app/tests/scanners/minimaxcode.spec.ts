/**
 * MiniMax Code 只读来源探针的回归网（工单374 spike）：
 * 确定性合成夹具（MinimaxFx），不读不写用户真实会话存储。
 * 只读性两道锁：① 全树 sha256+mtime 清单在探针前后逐字节一致；② readOnly 连接拒绝写入。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openReadOnly } from '../../src/main/scanners/sqlite'
import {
  minimaxHistoryDirName,
  minimaxSessionsDb,
  minimaxcodePreviewRows,
  probeMinimaxSessions,
  probeMinimaxTail,
} from '../../src/main/scanners/minimaxcode'
import { MinimaxFx } from './fixtures'

let tmp = ''
const open: MinimaxFx[] = []

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-minimax-'))
})
afterAll(() => {
  for (const f of open) {
    try { f.close() } catch { /* 尽力 */ }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* Windows 句柄释放滞后时容忍残留 */ }
})

function fresh(): MinimaxFx {
  const f = new MinimaxFx(path.join(tmp, `mx-${Date.now()}-${Math.random()}`), 1_800_000_000_000)
  open.push(f)
  return f
}

/** 全树逐文件 (相对路径 → sha256+mtimeMs) 清单，作为只读性证明的比对件 */
function snapshot(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        walk(p)
        continue
      }
      const st = fs.statSync(p)
      const h = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
      out.push(`${path.relative(root, p)}|${st.size}|${h}|${st.mtimeMs}`)
    }
  }
  walk(root)
  return out.sort()
}

describe('minimaxcode 主账本探针', () => {
  it('读取身份/标题/项目/最近活跃/status，按最近活跃降序', () => {
    const f = fresh()
    f.add('mvs_aaaaaaaa4f2c4a67b2d9a6c1e8f0d123', { ageMin: 5, project: 'kappa' })
    f.add('mvs_bbbbbbbb4f2c4a67b2d9a6c1e8f0d456', { ageMin: 90, title: 'fx 自定名', status: 'started' })
    const rows = probeMinimaxSessions(f.root)
    expect(rows.map((r) => r.id)).toEqual(['mvs_aaaaaaaa4f2c4a67b2d9a6c1e8f0d123', 'mvs_bbbbbbbb4f2c4a67b2d9a6c1e8f0d456'])
    const [newer, older] = rows
    expect(newer.title).toBe('fx-title-mvs_aaaaaaaa4f2c4a67b2d9a6c1e8f0d123')
    expect(newer.project).toBe('kappa')
    expect(newer.status).toBe('idle')
    expect(newer.lastActivityMs).toBe(1_800_000_000_000 - 5 * 60_000)
    expect(older.title).toBe('fx 自定名')
    expect(older.status).toBe('started')
    expect(older.lastActivityMs).toBe(1_800_000_000_000 - 90 * 60_000)
    f.close()
  })

  it('title 空/缺与 workspace_dir 空都给 null，不拿目录名或 id 顶替', () => {
    const f = fresh()
    f.add('mvs_cccccccc4f2c4a67b2d9a6c1e8f0d789', { title: null, project: null })
    const [r] = probeMinimaxSessions(f.root)
    expect(r.title).toBeNull()
    expect(r.project).toBeNull()
    expect(r.id).toBe('mvs_cccccccc4f2c4a67b2d9a6c1e8f0d789')
    f.close()
  })

  it('归档会话排除、空 id 行跳过', () => {
    const f = fresh()
    f.add('mvs_dddddddd4f2c4a67b2d9a6c1e8f0d111', { archived: 1 })
    f.add('mvs_eeeeeeee4f2c4a67b2d9a6c1e8f0d222')
    const rows = probeMinimaxSessions(f.root)
    expect(rows.map((r) => r.id)).toEqual(['mvs_eeeeeeee4f2c4a67b2d9a6c1e8f0d222'])
    f.close()
  })

  it('缺库与坏库都整工具空集（静默跳过语义）', () => {
    const empty = path.join(tmp, 'mx-missing')
    fs.mkdirSync(empty, { recursive: true })
    expect(probeMinimaxSessions(empty)).toEqual([])
    const broken = path.join(tmp, 'mx-broken')
    fs.mkdirSync(path.join(broken, 'v2', 'sqlite'), { recursive: true })
    fs.writeFileSync(minimaxSessionsDb(broken), 'not a sqlite file at all')
    expect(probeMinimaxSessions(broken)).toEqual([])
  })
})

describe('minimaxcode dated 历史（身份与尾部启发式）', () => {
  it('目录名 = session_<base64(session_id)>，双向可逆', () => {
    const id = 'mvs_01422619ee77496586a2b55253e956b1'
    expect(minimaxHistoryDirName(id)).toBe('session_' + Buffer.from(id, 'utf8').toString('base64'))
    expect(Buffer.from(minimaxHistoryDirName(id).slice('session_'.length), 'base64').toString('utf8')).toBe(id)
  })

  it('末条 assistant stopReason=toolUse → 疑似在途工具；toolResult 收尾 → 否', () => {
    const f = fresh()
    const pending = f.addHistory('mvs_111111114f2c4a67b2d9a6c1e8f0d001', 3, [
      { role: 'user' },
      { role: 'assistant', stopReason: 'toolUse' },
    ])
    expect(probeMinimaxTail(pending)).toEqual({ lastRole: 'assistant', lastStopReason: 'toolUse', suspectedPendingTool: true })
    const settled = f.addHistory('mvs_222222224f2c4a67b2d9a6c1e8f0d002', 4, [
      { role: 'user' },
      { role: 'assistant', stopReason: 'toolUse' },
      { role: 'toolResult' },
    ])
    expect(probeMinimaxTail(settled)).toEqual({ lastRole: 'toolResult', lastStopReason: null, suspectedPendingTool: false })
    f.close()
  })

  it('messages.jsonl 缺失/坏行不推断：全 null/false', () => {
    const f = fresh()
    const missing = path.join(f.root, 'v2', 'sessions', 'nope', 'messages.jsonl')
    expect(probeMinimaxTail(missing)).toEqual({ lastRole: null, lastStopReason: null, suspectedPendingTool: false })
    const bad = f.addHistory('mvs_333333334f2c4a67b2d9a6c1e8f0d003', 5, [{ role: 'user' }])
    fs.appendFileSync(bad, 'not-json\n')
    expect(probeMinimaxTail(bad).lastRole).toBe('user')
    f.close()
  })
})

describe('minimaxcode 会话预览行（工单382：只读身份/标题/活动，不伪造执行或等待）', () => {
  it('读取真实身份/标题/项目/最近活跃；空标题给 null；行内不含状态字段（无执行/等待可伪造）', () => {
    const f = fresh()
    f.add('mvs_aaaaaaaa4f2c4a67b2d9a6c1e8f0d123', { ageMin: 2, project: 'kappa', title: '修构建脚本' })
    f.add('mvs_bbbbbbbb4f2c4a67b2d9a6c1e8f0d456', { ageMin: 3, title: null, status: 'started' })
    const rows = minimaxcodePreviewRows(f.root, f.nowMs)
    expect(rows.map((r) => [r.id, r.title, r.project, r.lastActivityMs])).toEqual([
      ['mvs_aaaaaaaa4f2c4a67b2d9a6c1e8f0d123', '修构建脚本', 'kappa', f.nowMs - 2 * 60_000],
      ['mvs_bbbbbbbb4f2c4a67b2d9a6c1e8f0d456', null, 'zulu', f.nowMs - 3 * 60_000],
    ])
    // 输入契约只有四个字段：DB status 不进入预览行（否则上层可能把它当执行信号）
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(['id', 'lastActivityMs', 'project', 'title'])
    f.close()
  })

  it('超出 10 分钟活跃池与 archived 会话不进预览行（空闲过滤/归档排除）', () => {
    const f = fresh()
    f.add('mvs_cccccccc4f2c4a67b2d9a6c1e8f0d789', { ageMin: 11 })
    f.add('mvs_dddddddd4f2c4a67b2d9a6c1e8f0d111', { ageMin: 2, archived: 1 })
    expect(minimaxcodePreviewRows(f.root, f.nowMs)).toEqual([])
    f.close()
  })

  it('来源不可读（缺库/坏库）→ 空集，不抛、不编造', () => {
    const missing = path.join(tmp, 'mx-preview-missing')
    fs.mkdirSync(missing, { recursive: true })
    expect(minimaxcodePreviewRows(missing, 1_800_000_000_000)).toEqual([])
    const broken = path.join(tmp, 'mx-preview-broken')
    fs.mkdirSync(path.join(broken, 'v2', 'sqlite'), { recursive: true })
    fs.writeFileSync(minimaxSessionsDb(broken), 'not a sqlite file at all')
    expect(minimaxcodePreviewRows(broken, 1_800_000_000_000)).toEqual([])
  })
})

describe('minimaxcode 只读性证明（源存储零修改）', () => {
  it('探针前后 fixture 全树 sha256+mtime 清单逐字节一致', () => {
    const f = fresh()
    f.add('mvs_444444444f2c4a67b2d9a6c1e8f0d004', { ageMin: 2 })
    const messages = f.addHistory('mvs_444444444f2c4a67b2d9a6c1e8f0d004', 2, [
      { role: 'user' },
      { role: 'assistant', stopReason: 'toolUse' },
    ])
    const before = snapshot(f.root)
    probeMinimaxSessions(f.root)
    probeMinimaxTail(messages)
    minimaxcodePreviewRows(f.root, f.nowMs)
    expect(snapshot(f.root)).toEqual(before)
    f.close()
  })

  it('readOnly 连接拒绝写入（写入即抛）', () => {
    const f = fresh()
    f.add('mvs_555555554f2c4a67b2d9a6c1e8f0d005')
    const db = openReadOnly(minimaxSessionsDb(f.root))
    try {
      expect(() => db.prepare('INSERT INTO local_runtime_sessions (session_id) VALUES (?)').run('mvs_xxx')).toThrow()
    } finally {
      db.close()
    }
    f.close()
  })
})
