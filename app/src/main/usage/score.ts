// 使用频次打分（工单06，usage_score.py 平移）：真启动次数 × 指数衰减（半衰期 14 天），
// 叠加 UserAssist 冷启动先验。「当前时间」一律由参数传入（衰减数学可断言）。
// 融合在桌面条目层面做而非路径层面：日志与先验各自先映射到条目，再按
// 1/(1+该条目的日志启动次数) 让先验退位——路径大小写差异不会把同一应用裂成两条，
// 任务栏 .lnk 先验也不会因为日志只记 .exe 而永远不退位。
import type { DesktopItemKind } from '../../shared/contract'
import type { UsageEvent } from './log'

export const HALF_LIFE_DAYS = 14.0

/** 冷启动先验条目：系统启动记录只给「总次数 + 最后执行时间」 */
export interface PriorEntry {
  count: number
  lastMs: number
}

export function decay(ageDays: number): number {
  return 0.5 ** (ageDays / HALF_LIFE_DAYS)
}

function ageDays(nowMs: number, thenMs: number): number {
  return (nowMs - thenMs) / 86400_000
}

/** 事件 → {exe(小写): 衰减加权和} */
export function scoreStarts(events: UsageEvent[], nowMs: number): Map<string, number> {
  const scores = new Map<string, number>()
  for (const { tsMs, exe } of events) {
    const key = exe.toLowerCase()
    scores.set(key, (scores.get(key) ?? 0) + decay(ageDays(nowMs, tsMs)))
  }
  return scores
}

/** 事件 → {exe(小写): 启动次数} */
export function countStarts(events: UsageEvent[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const { exe } of events) {
    const key = exe.toLowerCase()
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

/** 先验条目折算成分数：count × decay(age(last)) */
export function priorScores(prior: ReadonlyMap<string, PriorEntry>, nowMs: number): Map<string, number> {
  const out = new Map<string, number>()
  for (const [pathKey, entry] of prior) {
    out.set(pathKey.toLowerCase(), entry.count * decay(ageDays(nowMs, entry.lastMs)))
  }
  return out
}

// —— UserAssist 值解析（usage_score.py parse_userassist 同义）——
// 值布局（实机确认）：dword0 是常量 145 的会话/版本字段，不是次数；运行次数在
// COUNT_OFFSET，FILETIME 在 FILETIME_OFFSET。勿把次数「修正」到 0:4。
export const UA_COUNT_OFFSET = 4
export const UA_FILETIME_OFFSET = 60
export const UA_MIN_LEN = 68
const FILETIME_EPOCH_OFFSET_MS = 116444736000000000 / 1e4 // 100ns 刻度 → ms

export function rot13(s: string): string {
  let out = ''
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    if (c >= 65 && c <= 90) out += String.fromCharCode(((c - 65 + 13) % 26) + 65)
    else if (c >= 97 && c <= 122) out += String.fromCharCode(((c - 97 + 13) % 26) + 97)
    else out += ch
  }
  return out
}

/** 解析一条 UserAssist 值：ROT13 值名 + 二进制值。不可用（过短/零时间戳/坏刻度）返回 null。 */
export function parseUserAssistEntry(rotatedName: string, data: Uint8Array): { path: string; count: number; lastMs: number } | null {
  if (data.length < UA_MIN_LEN) return null
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const count = dv.getUint32(UA_COUNT_OFFSET, true)
  const filetime = Number(dv.getBigUint64(UA_FILETIME_OFFSET, true))
  if (filetime === 0) return null // 没有最后执行时间就无法衰减，先验无从谈起
  const ms = (filetime - 116444736000000000) / 1e4
  if (!Number.isFinite(ms) || ms < 0) return null
  return { path: rot13(rotatedName), count, lastMs: ms }
}

/** 打分的桌面条目（显示名 + 目标解析结果由调用方注入） */
export interface ScoreItem {
  display: string
  kind: DesktopItemKind
  path: string
  /** 快捷方式目标（lnk 解析；文件/文件夹为 null） */
  target: string | null
}

/**
 * 把路径分数挂到桌面条目：{显示名: 分数}。
 * .exe 经条目目标反查；.lnk 先验条目若能解析出目标，则目标必须与条目目标一致才认
 * （防止任务栏同名快捷方式指到别的 exe）。解析不出时：路径在磁盘上存在则**不**回退
 * stem（usage_score.py 同义——盘上却解不出目标的 lnk 宁可不认，防错挂），不存在
 * （shell 别名/任务栏虚拟路径）才退而按 stem 对齐。映射不上的路径不出现在结果里。
 */
export function mapScoresToItems(
  scores: ReadonlyMap<string, number>,
  items: ScoreItem[],
  resolve: (lnkPath: string) => string | null,
  exists: (lnkPath: string) => boolean,
): Map<string, number> {
  const byTarget = new Map<string, string>()
  const byStem = new Map<string, string>()
  for (const item of items) {
    if (item.kind !== 'shortcut') continue
    const targetKey = item.target?.toLowerCase()
    if (targetKey && !byTarget.has(targetKey)) byTarget.set(targetKey, item.display)
    if (!byStem.has(item.display.toLowerCase())) byStem.set(item.display.toLowerCase(), item.display)
  }
  const out = new Map<string, number>()
  for (const [rawPath, score] of scores) {
    const low = rawPath.toLowerCase()
    let display: string | undefined
    if (low.endsWith('.exe')) {
      display = byTarget.get(low)
    } else if (low.endsWith('.lnk')) {
      const target = resolve(low)
      if (target) {
        display = byTarget.get(target.toLowerCase())
      } else if (!exists(low)) {
        display = byStem.get(stemOf(low))
      }
    }
    if (display === undefined) continue
    out.set(display, (out.get(display) ?? 0) + score)
  }
  return out
}

function stemOf(p: string): string {
  const base = p.replace(/\\/g, '/').split('/').pop() ?? p
  return base.replace(/\.lnk$/i, '').toLowerCase()
}

/**
 * 先验与自建日志在条目层面融合：{显示名: 分数}。纯函数（resolve 除外）。
 * 先验权重 1/(1+该条目的日志启动次数)：日志为空时权重 1（排名来自先验），
 * 日志积累后权重趋于 0（先验退位）。
 */
export function fuseScores(
  prior: ReadonlyMap<string, PriorEntry>,
  events: UsageEvent[],
  nowMs: number,
  items: ScoreItem[],
  resolve: (lnkPath: string) => string | null,
  exists: (lnkPath: string) => boolean,
): Map<string, number> {
  const logCounts = mapScoresToItems(countStarts(events), items, resolve, exists)
  const logScores = mapScoresToItems(scoreStarts(events, nowMs), items, resolve, exists)
  const priorIcon = mapScoresToItems(priorScores(prior, nowMs), items, resolve, exists)
  const fused = new Map(logScores)
  for (const [display, priorScore] of priorIcon) {
    const n = logCounts.get(display) ?? 0
    fused.set(display, (fused.get(display) ?? 0) + priorScore / (1 + n))
  }
  for (const [display, score] of fused) {
    if (score <= 0) fused.delete(display)
  }
  return fused
}
