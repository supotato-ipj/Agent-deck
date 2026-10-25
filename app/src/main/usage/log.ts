// 应用使用日志（工单06，usage_log.py 平移）：只记进程可执行路径与时间戳，
// 绝不记窗口标题（ADR-0002：标题里的案号/项目名对「哪个应用常用」毫无贡献，
// 采集路径上根本不获取标题文本）。两类事件各写各的按天 JSONL（start-/focus-），
// 每条记录只有 ts 与 exe 两个字段；90 天滚动清理。
import fs from 'node:fs'
import path from 'node:path'

export const RETENTION_DAYS = 90
export const PRUNE_INTERVAL_MS = 3600_000

export type UsageKind = 'start' | 'focus'

export interface UsageEvent {
  tsMs: number
  exe: string
}

/** 按 pid 差分识别真启动：新出现的 pid 所属可执行路径各计一次（同路径第二实例与退出重启都数得到） */
export function detectStarts(previous: Map<number, string>, current: Map<number, string>): string[] {
  const out = new Set<string>()
  for (const pid of current.keys()) {
    if (!previous.has(pid)) out.add(current.get(pid)!)
  }
  return [...out].sort()
}

/** 前台切换到不同可执行路径时返回它，否则 null */
export function detectFocus(last: string | null, current: string | null): string | null {
  if (current === null || current === last) return null
  return current
}

function dayTag(tsMs: number): string {
  const d = new Date(tsMs)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
}

function dayFile(dir: string, kind: UsageKind, tsMs: number): string {
  return path.join(dir, `${kind}-${dayTag(tsMs)}.jsonl`)
}

/** 追加一条 {ts, exe} 记录。任何写入失败都吞掉：日志不能拖死服务。 */
export function appendEvent(dir: string, kind: UsageKind, exe: string, tsMs: number): void {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const ts = new Date(tsMs).toISOString().replace(/\.\d{3}Z$/, 'Z') // 秒精度，与 Python isoformat(timespec="seconds") 对齐
    fs.appendFileSync(dayFile(dir, kind, tsMs), JSON.stringify({ ts, exe }) + '\n', 'utf8')
  } catch {
    /* 尽力而为 */
  }
}

/** 读 start 日志为事件清单；坏行跳过、未来时间戳忽略（Python read_start_events 同义） */
export function readStartEvents(dir: string, nowMs: number): UsageEvent[] {
  const events: UsageEvent[] = []
  let files: string[]
  try {
    files = fs.readdirSync(dir).filter((f) => /^start-\d{8}\.jsonl$/.test(f)).sort()
  } catch {
    return events
  }
  for (const file of files) {
    let lines: string[]
    try {
      lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n')
    } catch {
      continue
    }
    for (const line of lines) {
      if (!line) continue
      try {
        const record = JSON.parse(line) as { ts?: unknown; exe?: unknown }
        const tsMs = Date.parse(String(record.ts))
        if (typeof record.exe !== 'string' || !Number.isFinite(tsMs) || tsMs > nowMs) continue
        events.push({ tsMs, exe: record.exe })
      } catch {
        /* 坏行跳过 */
      }
    }
  }
  return events
}

/** 删除超过保留期的按天文件（start/focus 一并）；当天文件由日标签自然豁免 */
export function pruneOldDays(dir: string, nowMs: number, days = RETENTION_DAYS): void {
  const cutoffMs = nowMs - days * 86400_000
  let files: string[]
  try {
    files = fs.readdirSync(dir)
  } catch {
    return
  }
  for (const file of files) {
    const m = /^(?:start|focus)-(\d{8})\.jsonl$/.exec(file)
    if (!m) continue
    const dayMs = Date.parse(`${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}T00:00:00Z`)
    if (Number.isFinite(dayMs) && dayMs < cutoffMs) {
      try {
        fs.unlinkSync(path.join(dir, file))
      } catch {
        /* 尽力而为 */
      }
    }
  }
}
