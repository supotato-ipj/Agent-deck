/**
 * 五工具扫描器的 fixture 构造（tests/scanners/* 的共用件）——
 * 逐条对应 Python 侧 tests/test_agent_sessions.py 与 tests/test_scanner_*.py 的 fixture，
 * 是判定语义平移的回归网（spec 辅缝：假文件树/假 SQLite，不碰真实数据）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** 构造 jsonl 记录：kind ∈ text/tool/user */
export function rec(role: 'assistant' | 'user', kind: 'text' | 'tool' | 'user' = 'text', cwd?: string): Record<string, unknown> {
  let r: Record<string, unknown>
  if (role === 'user') {
    r = { type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } }
  } else if (kind === 'tool') {
    r = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }
  } else {
    r = { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }
  }
  if (cwd) r['cwd'] = cwd
  return r
}

/** 在临时目录里造一个 .qoder-cn 形态的数据根 */
export class QoderFx {
  now = 0

  constructor(public readonly root: string) {}

  addSession(sid: string, age: number, records: Array<Record<string, unknown>>, projDir = 'proj-a', cwd?: string): string {
    const d = path.join(this.root, 'projects', projDir)
    fs.mkdirSync(d, { recursive: true })
    const jf = path.join(d, `${sid}.jsonl`)
    fs.writeFileSync(jf, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
    const t = this.now - age
    fs.utimesSync(jf, t, t)
    return jf
  }

  addTask(sid: string, taskId: string, status: string, subject = 'task'): void {
    const d = path.join(this.root, 'tasks', sid)
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, `${taskId}.json`), JSON.stringify({ id: taskId, subject, status }), 'utf8')
  }
}

const HERMES_SCHEMA = `
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    cwd TEXT,
    title TEXT,
    started_at REAL,
    ended_at REAL,
    end_reason TEXT,
    last_activity_at REAL,
    archived INTEGER DEFAULT 0
);`

/** hermes 数据根：真实 SQLite（node:sqlite 建库）+ 租约 JSON */
export class HermesFx {
  private readonly db: DatabaseSync

  constructor(public readonly root: string, public readonly now: number) {
    fs.mkdirSync(root, { recursive: true })
    this.db = new DatabaseSync(path.join(root, 'state.db'))
    this.db.exec(HERMES_SCHEMA)
  }

  add(sid: string, age: number, options: { ended?: boolean; archived?: number; cwd?: string; lastAct?: number } = {}): void {
    const act = options.lastAct ?? this.now - age
    const ended = options.ended ?? false
    this.db.prepare(
      'INSERT INTO sessions (id, cwd, title, started_at, ended_at, end_reason, last_activity_at, archived) VALUES (?,?,?,?,?,?,?,?)',
    ).run(
      sid,
      options.cwd ?? 'D:/work/gamma',
      `t-${sid}`,
      act - 100,
      ended ? act + 1 : null,
      ended ? 'cli_close' : null,
      act,
      options.archived ?? 0,
    )
  }

  setLeases(sessionIds: string[]): void {
    const runtime = path.join(this.root, 'runtime')
    fs.mkdirSync(runtime, { recursive: true })
    const entries = sessionIds.map((sid, i) => ({
      lease_id: `l${i}`, session_id: sid, pid: 1000 + i, updated_at: this.now,
    }))
    fs.writeFileSync(path.join(runtime, 'active_sessions.json'), JSON.stringify({ entries }), 'utf8')
  }

  close(): void {
    this.db.close()
  }
}

const ZCODE_SCHEMA = `
CREATE TABLE session (
    id TEXT PRIMARY KEY,
    directory TEXT,
    title TEXT,
    time_created INTEGER,
    time_updated INTEGER,
    time_archived INTEGER
);
CREATE TABLE todo (
    session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
    content TEXT,
    status TEXT,
    position INTEGER,
    PRIMARY KEY (session_id, position)
);`

/** zcode 数据根：真实 SQLite（session + todo 两表） */
export class ZcodeFx {
  private readonly db: DatabaseSync

  constructor(public readonly root: string, public readonly now: number) {
    fs.mkdirSync(path.join(root, 'cli', 'db'), { recursive: true })
    this.db = new DatabaseSync(path.join(root, 'cli', 'db', 'db.sqlite'))
    this.db.exec(ZCODE_SCHEMA)
  }

  add(sid: string, ageMs: number, options: { archived?: boolean; directory?: string } = {}): void {
    const upd = Math.trunc((this.now - ageMs / 1000.0) * 1000)
    this.db.prepare(
      'INSERT INTO session (id, directory, title, time_created, time_updated, time_archived) VALUES (?,?,?,?,?,?)',
    ).run(sid, options.directory ?? 'D:/work/delta', `t-${sid}`, upd - 100000, upd, options.archived ? 1 : null)
  }

  addTodo(sid: string, position: number, status: string): void {
    this.db.prepare('INSERT INTO todo (session_id, content, status, position) VALUES (?,?,?,?)').run(sid, 'todo', status, position)
  }

  close(): void {
    this.db.close()
  }
}

/** kimicode 数据根：sessions 下 工作区/会话 两级目录形态 */
export class KimiCodeFx {
  constructor(public readonly root: string, public readonly now: number) {}

  addSession(sid: string, age: number, options: { workDir?: string; title?: string; wireAge?: number } = {}): string {
    const d = path.join(this.root, 'sessions', 'wd_an-w_hash', sid)
    fs.mkdirSync(path.join(d, 'agents', 'main'), { recursive: true })
    const state = {
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      title: options.title ?? 'sess title',
      workDir: options.workDir ?? 'D:/work/eps',
    }
    const sf = path.join(d, 'state.json')
    fs.writeFileSync(sf, JSON.stringify(state), 'utf8')
    fs.utimesSync(sf, this.now - age, this.now - age)
    const wf = path.join(d, 'agents', 'main', 'wire.jsonl')
    const wa = options.wireAge ?? age
    fs.writeFileSync(wf, '{"type":"config.update"}\n', 'utf8')
    fs.utimesSync(wf, this.now - wa, this.now - wa)
    return d
  }
}

const KIMIWORK_KEY = (cid: string) => `agent:main:main:conversation:${cid}`

function iso(epoch: number): string {
  return new Date(epoch * 1000).toISOString().replace(/\.\d+Z$/, '.000Z')
}

/** kimiwork 数据根：状态 map + 上下文用量两文件 */
export class KimiWorkFx {
  private statuses: Record<string, string> = {}
  private usage: Record<string, { contextUsage: number; updatedAt: string }> = {}

  constructor(public readonly root: string, public readonly now: number) {}

  add(cid: string, age: number, status = 'completed'): void {
    this.statuses[KIMIWORK_KEY(cid)] = status
    this.usage[KIMIWORK_KEY(cid)] = { contextUsage: 0.1, updatedAt: iso(this.now - age) }
  }

  dropUsage(cid: string): void {
    delete this.usage[KIMIWORK_KEY(cid)]
  }

  dropStatus(cid: string): void {
    delete this.statuses[KIMIWORK_KEY(cid)]
  }

  write(): void {
    fs.mkdirSync(this.root, { recursive: true })
    fs.writeFileSync(path.join(this.root, 'conversation-statuses.json'), JSON.stringify(this.statuses), 'utf8')
    fs.writeFileSync(path.join(this.root, 'conversation-context-usage.json'), JSON.stringify(this.usage), 'utf8')
  }
}

const MINIMAX_SCHEMA = `
CREATE TABLE local_runtime_sessions (
    session_id TEXT,
    record_json TEXT,
    updated_at_ms INTEGER,
    agent_name TEXT,
    runtime TEXT,
    session_type TEXT,
    status TEXT,
    archived INTEGER,
    workspace_dir TEXT,
    project_workspace_dir TEXT,
    title TEXT,
    created_at_ms INTEGER,
    error_message TEXT
);`

/**
 * MiniMax Code 数据根（工单374 spike 夹具）：`v2/sqlite/runtime-state.sqlite` 主账本 +
 * `v2/sessions/YYYY/MM/DD/…` dated 历史目录两件套。内容全部合成、确定性（同参必得同树），
 * 不复制任何用户真实会话内容；列集是真实表的子集，只含探针读取的列（真实表列更多，
 * 探针不得依赖缺列）。
 */
export class MinimaxFx {
  private readonly db: DatabaseSync

  /** nowMs 为 epoch 毫秒（与真实 updated_at_ms 同单位） */
  constructor(public readonly root: string, public readonly nowMs: number) {
    fs.mkdirSync(path.join(root, 'v2', 'sqlite'), { recursive: true })
    this.db = new DatabaseSync(path.join(root, 'v2', 'sqlite', 'runtime-state.sqlite'))
    this.db.exec(MINIMAX_SCHEMA)
  }

  /** 主账本一行；title/project 传 null 模拟缺真值，status 原样入库（不校验值域） */
  add(
    id: string,
    options: { ageMin?: number; title?: string | null; project?: string | null; status?: string; archived?: number } = {},
  ): void {
    const updated = Math.trunc(this.nowMs - (options.ageMin ?? 5) * 60_000)
    this.db.prepare(
      'INSERT INTO local_runtime_sessions (session_id, updated_at_ms, status, archived, workspace_dir, title) VALUES (?,?,?,?,?,?)',
    ).run(
      id,
      updated,
      options.status ?? 'idle',
      options.archived ?? 0,
      options.project === null ? null : `D:/work/${options.project ?? 'zulu'}`,
      options.title === undefined ? `fx-title-${id}` : options.title,
    )
  }

  /**
   * dated 历史目录 + messages.jsonl 尾部夹具（目录时间取 nowMs-ageMin*60000 的本地时间）。
   * tail 依序为记录序列；每条 {role, stopReason?} 合成为真实行形态
   * `{message_id, turn_id, message:{role, content, timestamp, stopReason?}}`。
   * 返回 messages.jsonl 路径。
   */
  addHistory(
    id: string,
    ageMin: number,
    tail: Array<{ role: 'user' | 'assistant' | 'toolResult' | 'custom'; stopReason?: string }>,
  ): string {
    const t = this.nowMs - ageMin * 60_000
    const d = new Date(t)
    const p2 = (n: number) => String(n).padStart(2, '0')
    const p3 = (n: number) => String(n).padStart(3, '0')
    const dir = path.join(
      this.root, 'v2', 'sessions',
      String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate()),
      `${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}-${p3(d.getMilliseconds())}-session_${Buffer.from(id, 'utf8').toString('base64')}`,
    )
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      schemaVersion: 1,
      sessionId: id,
      createdAtMs: t,
      updatedAtMs: t,
      source: 'local-runtime',
      layout: 'v2-final-dated-session',
      paths: {
        sessionDir: dir,
        ledger: path.join(dir, 'ledger.ndjson'),
        display: path.join(dir, 'display.ndjson'),
        snapshot: path.join(dir, 'snapshot.ndjson'),
        reports: path.join(dir, 'reports'),
        messages: path.join(dir, 'messages.jsonl'),
      },
    }), 'utf8')
    const lines = tail.map((m, i) => JSON.stringify({
      message_id: `fx-msg-${i}`,
      turn_id: 'fx-turn-0',
      message: {
        role: m.role,
        content: [{ type: 'text', text: `fx-content-${i}` }],
        timestamp: t + i,
        ...(m.stopReason === undefined ? {} : { stopReason: m.stopReason }),
      },
    }))
    const mf = path.join(dir, 'messages.jsonl')
    fs.writeFileSync(mf, lines.join('\n') + '\n', 'utf8')
    return mf
  }

  close(): void {
    this.db.close()
  }
}
