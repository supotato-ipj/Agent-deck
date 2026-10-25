// 使用日志迁移（工单11）：把 Python 数据服务时代的历史日志搬进新 userData。
//
// 为什么搬而不是声明「重新积累」：两侧格式逐字段相同（`{ts, exe}` 的按天 JSONL
// start-/focus-，见 usage/log.ts 与 Python usage_log.append），搬过去的新日志立刻
// 就能参与使用频次打分；而重新积累意味着 dock 推荐位要在 90 天里慢慢长回来。
//
// 为什么是纯文件搬运而不是逐行解析重写：重写只会制造新旧两种格式漂移的机会，
// 而两侧本来就是同一套约定（isoformat(timespec="seconds") ↔ toISOString 去毫秒）。
//
// 幂等：迁移跑在启动路径上，可能被中途打断。标记文件逐个记名而非「跑完写个 done」，
// 于是重跑只补没搬过的文件，不会让同一条记录出现两次。失败的文件不记账，留给下次。
import fs from 'node:fs'
import path from 'node:path'
import { RETENTION_DAYS } from './log'

const DAY_FILE = /^(?:start|focus)-(\d{8})\.jsonl$/

/** Python 数据服务时代的使用日志目录（%LOCALAPPDATA%\qoder-deck\usage） */
export function legacyUsageDir(env: NodeJS.ProcessEnv = process.env): string {
  const localAppData = env.LOCALAPPDATA
  if (!localAppData) throw new Error('LOCALAPPDATA 未设置，无法定位旧使用日志目录')
  return path.join(localAppData, 'qoder-deck', 'usage')
}

function dayMs(file: string): number {
  const m = DAY_FILE.exec(file)
  if (!m) return Number.NaN
  return Date.parse(`${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}T00:00:00Z`)
}

export interface MigrationPlan {
  /** 该搬的文件名 */
  files: string[]
  /** 不搬的文件名及原因分类：非日志文件、已超保留期 */
  skipped: string[]
}

export function planUsageMigration(input: { legacyFiles: string[]; nowMs: number }): MigrationPlan {
  const cutoffMs = input.nowMs - RETENTION_DAYS * 86400_000
  const files: string[] = []
  const skipped: string[] = []
  for (const file of input.legacyFiles) {
    const ms = dayMs(file)
    // 非按天日志文件（layout.json 之类）不碰；超保留期的搬进去也只会被滚动清理立刻删掉
    if (!Number.isFinite(ms) || ms < cutoffMs) skipped.push(file)
    else files.push(file)
  }
  return { files, skipped }
}

export interface MigrationResult {
  /** 本次实际搬走的文件名 */
  migrated: string[]
  /** 搬失败、留待下次重试的文件名 */
  failed: string[]
  skipped: string[]
}

interface Marker {
  migratedAt: string
  files: string[]
}

function readMarker(file: string): Marker {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Marker>
    // 标记损坏 = 不知道搬过什么：按没搬过处理，重跑由按行去重兜住（宁可重搬也不丢历史）
    return { migratedAt: String(raw.migratedAt ?? ''), files: Array.isArray(raw.files) ? raw.files.filter((f): f is string => typeof f === 'string') : [] }
  } catch {
    return { migratedAt: '', files: [] }
  }
}

export function migrateUsageLog(options: {
  legacyDir: string
  targetDir: string
  markerFile: string
  nowMs: number
  log?: (event: Record<string, unknown>) => void
}): MigrationResult {
  const log = options.log ?? (() => {})
  const result: MigrationResult = { migrated: [], failed: [], skipped: [] }

  let legacyFiles: string[]
  try {
    legacyFiles = fs.readdirSync(options.legacyDir)
  } catch {
    // 旧目录不存在 = 没有历史可搬。照样记账，免得每次启动都去 stat 一个不存在的目录。
    writeMarker(options.markerFile, { migratedAt: new Date(options.nowMs).toISOString(), files: [] })
    return result
  }

  const plan = planUsageMigration({ legacyFiles, nowMs: options.nowMs })
  result.skipped = plan.skipped

  const marker = readMarker(options.markerFile)
  const done = new Set(marker.files)
  const pending = plan.files.filter((f) => !done.has(f))
  if (pending.length === 0) return result

  for (const file of pending) {
    try {
      fs.mkdirSync(options.targetDir, { recursive: true })
      const from = path.join(options.legacyDir, file)
      const to = path.join(options.targetDir, file)
      const body = fs.readFileSync(from, 'utf8')
      if (!fs.existsSync(to)) {
        fs.writeFileSync(to, body, 'utf8')
      } else {
        // 同名当日文件已存在 = 当天新面板已写过自己的记录，须合并而非覆盖。
        // 按行去重后追加：目标里已有的行一律不再写第二次——即便上一轮是在
        // 「append 成功、标记未落盘」之间被杀（append 与写标记之间存在窗口），
        // 重跑也不会让同一条记录翻倍，进而歪掉 dock 的使用频次排序。
        // 去重只比对**目标原有**内容，故源文件里合法的重复行（同应用同秒两次启动）照搬不丢。
        const existingLines = new Set(fs.readFileSync(to, 'utf8').split('\n'))
        const additions = body.split('\n').filter((line) => line !== '' && !existingLines.has(line))
        if (additions.length > 0) fs.appendFileSync(to, additions.join('\n') + '\n', 'utf8')
      }
      result.migrated.push(file)
    } catch (err) {
      result.failed.push(file)
      log({ type: 'usage-migrate-failed', file, message: (err as Error).message })
    }
  }

  // 有失败就不落账：下次启动重试；全成功才写标记（含「无事可做」的记账）
  if (result.failed.length === 0) {
    writeMarker(options.markerFile, {
      migratedAt: new Date(options.nowMs).toISOString(),
      files: [...done, ...result.migrated].sort(),
    })
  }
  if (result.migrated.length > 0 || result.failed.length > 0) {
    log({ type: 'usage-migrated', migrated: result.migrated, failed: result.failed, skipped: result.skipped.length })
  }
  return result
}

function writeMarker(file: string, marker: Marker): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(marker, null, 2) + '\n', 'utf8')
  } catch {
    /* 尽力而为：标记写不进去只会导致下次重搬，不会丢数据 */
  }
}
