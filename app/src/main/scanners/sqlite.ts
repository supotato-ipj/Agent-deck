/**
 * SQLite 只读打开的共用形态（ADR-0003：一律只读；库被写方独占时快速失败走静默跳过）。
 * node:sqlite 无 URI 形态，readOnly 选项即 Python `file:...?mode=ro` 的等价物；
 * busy_timeout 调短对应 Python timeout=0.5——不拖住面板轮询。
 *
 * 连接池（工单477 束②）：会话扫描降到 3~5 秒后仍每轮重开连接就是白烧的进程创建/
 * 页缓存成本——池按库路径持久复用只读连接。寿命上限（缺省 5 分钟）惰性轮换：
 * 长持只读连接会钉住 WAL 库（MiniMax runtime-state.sqlite 是活跃 WAL）的检查点回收，
 * 定期重开一次让写方有机会收 WAL；同时把「库被工具整体替换后读到旧影」的窗口有界化。
 * 读失败一次重开自愈：坏连接（库被替换/句柄失真）即弃即换，重试再失败如实上抛——
 * 上层 collectSessions 的「单工具失败静默跳过」语义不变。
 */
import { DatabaseSync } from 'node:sqlite'

export function openReadOnly(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout = 500')
  } catch {
    db.close()
    throw new Error(`busy_timeout 设置失败: ${dbPath}`)
  }
  return db
}

export interface SqlitePoolOptions {
  /** 只读打开真源（缺省 openReadOnly；测试注入计数/剧本桩） */
  open?: (dbPath: string) => DatabaseSync
  /** 单调钟（缺省 Date.now；测试注入合成钟驱动轮换判定） */
  now?: () => number
  /** 连接寿命上限 ms（缺省 300_000；到限惰性轮换，不占定时器） */
  maxAgeMs?: number
}

interface PoolEntry {
  db: DatabaseSync
  openedAt: number
}

export const SQLITE_POOL_MAX_AGE_MS = 300_000

export class SqlitePool {
  private readonly conns = new Map<string, PoolEntry>()
  private readonly openFn: (dbPath: string) => DatabaseSync
  private readonly nowFn: () => number
  private readonly maxAgeMs: number

  constructor(options: SqlitePoolOptions = {}) {
    this.openFn = options.open ?? openReadOnly
    this.nowFn = options.now ?? Date.now
    this.maxAgeMs = options.maxAgeMs ?? SQLITE_POOL_MAX_AGE_MS
  }

  /** 在池化只读连接上跑一段读取：复用为主，坏连接一次重开自愈，重试再败如实上抛 */
  withReadOnly<T>(dbPath: string, fn: (db: DatabaseSync) => T): T {
    let entry = this.entryFor(dbPath)
    try {
      return fn(entry.db)
    } catch {
      this.drop(dbPath) // 毒连接即弃
      entry = this.openEntry(dbPath) // 重开一次再试
      return fn(entry.db)
    }
  }

  /** 在场连接数（测试/诊断观察缝） */
  get size(): number {
    return this.conns.size
  }

  /** 全量关闭（内核拆卸/轮末清账） */
  closeAll(): void {
    for (const dbPath of [...this.conns.keys()]) this.drop(dbPath)
  }

  /** 取连接：寿命到限先轮换，缺则新开 */
  private entryFor(dbPath: string): PoolEntry {
    const held = this.conns.get(dbPath)
    if (held && this.nowFn() - held.openedAt > this.maxAgeMs) {
      this.drop(dbPath)
      return this.openEntry(dbPath)
    }
    return held ?? this.openEntry(dbPath)
  }

  private openEntry(dbPath: string): PoolEntry {
    const entry: PoolEntry = { db: this.openFn(dbPath), openedAt: this.nowFn() }
    this.conns.set(dbPath, entry)
    return entry
  }

  private drop(dbPath: string): void {
    const held = this.conns.get(dbPath)
    if (!held) return
    this.conns.delete(dbPath)
    try {
      held.db.close()
    } catch {
      /* 已关/失真句柄：清账优先，关不动的交给 GC */
    }
  }
}
