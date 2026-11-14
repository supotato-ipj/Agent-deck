// 常驻事件日志（工单473，ADR-0032 韧性基线三件套之一）：面板生产运行期默认开启的
// 技术事件滚动记录——启动各阶段耗时戳、渲染层哨兵族存证、超时、点击吞没、拉回与
// 逃生口动作等落进 userData，滚动轮转有界（约 5MB × 3 份），不含敏感内容（对齐
// 活动日志口径：不记窗口标题/路径/查询词/文件名）。
//
// 与验收侧事件观测同源：同一 JSONL 行形（{t, ...event}），事件磁带
// （app/accept/lib/event-tape.js）可直接读。DECK_EVENT_LOG 环境开关不变——电池注入
// 时面板照旧写指定事件档（验收断言零改动）；本模块只在**零注入**时接管（生产默认）。
//
// 分层（与仓库既有纯函数域先例同构：render-sentinel.ts / panel-quit.ts）：
//   - 纯函数域（本文件上半，零 Electron 零 IO）：轮转裁决 planRotation、
//     常驻投影 projectResidentEvent（脱敏 + 高频数据帧滤除）、落点解析
//     resolveResidentLogFile、启动阶段族投影 projectBootPhases——离线可穷举；
//   - fs 写入器（本文件下半，纯 node:fs 无 Electron）：createResidentEventLog——
//     追加前过投影、按裁决执行轮转、appendFileSync 逐行落盘。
//
// 多进程并写（外层守卫 + 面板同写一份）：与验收模式既有形态一致（guard 与面板
// 本就共写 DECK_EVENT_LOG），半行自愈由读侧（事件磁带）承担；轮转竞态最坏多转
// 一档（自愈、不丢数据），写入全程尽力而为、失败静默（存证不影响面板运行）。

import fs from 'node:fs'
import path from 'node:path'

/** 单档上限（字节）：约 5MB（票面口径） */
export const RESIDENT_LOG_MAX_FILE_BYTES = 5 * 1024 * 1024

/** 链上总档数（含现役）：5MB × 3 = 磁盘总量上界约 15MB */
export const RESIDENT_LOG_MAX_FILES = 3

/** 生产默认档名（相对 userData） */
export const RESIDENT_LOG_FILE = 'events.jsonl'

/** 轮转档命名：现役名在末段扩展名前插序号（events.jsonl → events.1.jsonl） */
export function rotatedLogName(activeName: string, shift: number): string {
  const dir = path.dirname(activeName)
  const base = path.basename(activeName)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  return path.join(dir, `${stem}.${shift}${ext}`)
}

/** 轮转裁决的输出：要删的最老档序号 + 改名搬迁表（from→to；0 代表现役档） */
export interface RotationPlan {
  readonly removeShifts: readonly number[]
  readonly shift: ReadonlyArray<{ from: number; to: number }>
}

/**
 * 轮转裁决（纯函数，票面验收标准④的「轮转裁决」半边）：
 * 现役档**达到**上限即轮转一轮——链上各档向老方向顺移一位、现役让位为 1 号、
 * 超出 maxFiles-1 的最老档删除。未达上限返回 null（不动作）。
 *
 * @param activeBytes 现役档当前字节数（调用方 stat 所得）
 * @param presentShifts 在盘轮转档序号集（如 [1,2]），顺序不限
 * @param maxFileBytes 单档上限
 * @param maxFiles 链上总档数（含现役）——<2 无轮转槽位，属配置错误，拒绝而非静默删数据
 */
export function planRotation(
  activeBytes: number,
  presentShifts: readonly number[],
  maxFileBytes: number,
  maxFiles: number,
): RotationPlan | null {
  if (maxFiles < 2) throw new Error(`常驻事件日志：maxFiles=${maxFiles} 无轮转槽位（至少 2）`)
  if (!(activeBytes >= maxFileBytes)) return null
  const present = [...new Set(presentShifts)].filter((n) => Number.isInteger(n) && n >= 1)
  const removeShifts = present.filter((n) => n >= maxFiles - 1).sort((a, b) => a - b)
  const keep = present
    .filter((n) => n < maxFiles - 1)
    .sort((a, b) => b - a) // 从最老的可保留档开始顺移，避免同档覆盖
  const shift: Array<{ from: number; to: number }> = keep.map((n) => ({ from: n, to: n + 1 }))
  shift.push({ from: 0, to: 1 })
  return { removeShifts, shift }
}

// —— 常驻投影（入口滤除，票面验收标准⑤「无敏感内容」的实现位）——

/** 高频数据帧族（整体不入常驻日志）：它们是 1Hz 现势数据，不是关键事件——
 * 放进来只会把启动耗时戳/哨兵存证/拉回动作挤出轮转窗（5MB 两天就翻一轮），
 * 且 desktop-rendered 每帧携带全量桌面文件名。数据本体仍在渲染层与快照里。 */
const DROP_EVENT_TYPES: ReadonlySet<string> = new Set([
  'taskbar-right-status', // 右组 1Hz 时钟+硬件摘要帧（renderer/taskbar.ts applyStatus）
  'desktop-rendered', // 桌面 1Hz 重建帧，载荷含全量文件名（renderer/main.ts render）
])

/** 字段级抹除名单（值整体换 '[redacted]'）：对齐活动日志口径——不含文件名、路径、
 * 窗口标题、项目名或查询词。宁多抹不少记（少记不伤取证，错记才是事故）：同名键
 * 语义随事件族漂移（`name` 既可以是插件名也可以是文件名），按字段一刀切最稳。 */
const REDACT_KEYS: ReadonlySet<string> = new Set([
  'name', 'names', 'title', 'tooltip', 'query',
  'path', 'paths', 'file', 'files', 'cwd', 'dir', 'link',
  'url', 'href',
])

export const RESIDENT_LOG_REDACTED = '[redacted]'
export const RESIDENT_LOG_PATH_PLACEHOLDER = '<path>'
export const RESIDENT_LOG_URL_PLACEHOLDER = '<url>'

// 字符串值兜底网：字段名对不上的路径形态（报错 message 里内嵌的路径最常见）。
// 只抹「长得像路径」的子串，不动普通文案。
const WIN_DRIVE_PATH_RE = /[A-Za-z]:[\\/][^\s'"`<>|]*/g
const UNC_PATH_RE = /\\\\[^\s'"`<>|]*[\\/][^\s'"`<>|]*/g
const FILE_URL_RE = /file:\/\/\/?\S*/gi

function scrubString(s: string): string {
  let out = s.replace(FILE_URL_RE, RESIDENT_LOG_URL_PLACEHOLDER)
  out = out.replace(WIN_DRIVE_PATH_RE, RESIDENT_LOG_PATH_PLACEHOLDER)
  out = out.replace(UNC_PATH_RE, RESIDENT_LOG_PATH_PLACEHOLDER)
  return out
}

function deepProject(value: unknown): unknown {
  if (typeof value === 'string') return scrubString(value)
  if (Array.isArray(value)) return value.map(deepProject)
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(src)) {
      out[k] = REDACT_KEYS.has(k) ? RESIDENT_LOG_REDACTED : deepProject(v)
    }
    return out
  }
  return value
}

/**
 * 常驻投影（纯函数）：一个事件进常驻日志前要过的三道网——
 * ① 高频数据帧族整体丢弃（返回 null）；② 抹除名单字段整值换 '[redacted]'；
 * ③ 其余字符串值里的路径形态子串抹占位符。技术事件（type/数值/矩形/布尔）原样通过。
 */
export function projectResidentEvent(event: Record<string, unknown>): Record<string, unknown> | null {
  if (!event || typeof event !== 'object') return null
  const type = typeof event.type === 'string' ? event.type : ''
  if (type && DROP_EVENT_TYPES.has(type)) return null
  return deepProject(event) as Record<string, unknown>
}

/** 常驻日志落点解析（纯函数）：DECK_RESIDENT_EVENT_LOG 三态——'off' 显式关闭
 * （测试清场用）；非空路径 = 测试/验收隔离落点（只改落点，不改默认开启）；
 * 未设 = 生产默认 userData/events.jsonl（票面验收标准①：零环境变量注入即开启）。 */
export function resolveResidentLogFile(envValue: string | undefined, userDataDir: string): string | null {
  if (envValue === 'off') return null
  if (envValue) return envValue
  return path.join(userDataDir, RESIDENT_LOG_FILE)
}

// —— 启动阶段耗时戳事件族（票面验收标准①：含启动各阶段耗时戳事件族）——

/** 一条启动阶段戳的投影形状 */
export interface BootPhaseStamp {
  readonly phase: string
  readonly elapsedMs: number
  readonly t: number
}

/** 从混排事件磁带投影出 boot-phase 族（保序；畸形行剔除不抛错） */
export function projectBootPhases(events: ReadonlyArray<Record<string, unknown>>): BootPhaseStamp[] {
  const out: BootPhaseStamp[] = []
  for (const e of events ?? []) {
    if (!e || e.type !== 'boot-phase') continue
    if (typeof e.phase !== 'string' || !e.phase) continue
    if (typeof e.elapsedMs !== 'number' || !Number.isFinite(e.elapsedMs)) continue
    out.push({ phase: e.phase, elapsedMs: e.elapsedMs, t: typeof e.t === 'number' ? e.t : 0 })
  }
  return out
}

/**
 * 启动阶段打点器：bind 一个追加出口与启动锚点 t0，逐相位落
 * {type:'boot-phase', phase, elapsedMs}（elapsedMs 以锚点起算）。
 */
export function createBootPhaseLogger(
  append: (event: Record<string, unknown>) => void,
  t0: number,
  now: () => number = Date.now,
): (phase: string) => void {
  return (phase: string) => {
    append({ type: 'boot-phase', phase, elapsedMs: now() - t0 })
  }
}

// —— fs 写入器（纯 node:fs，无 Electron；离线测试以临时目录实盘断言）——

/** 常驻事件日志出口（与 panel-ipc.ts 的 EventLog 结构同形——该处类型 import electron，
 * 本模块保持零 Electron，结构相容即可互换） */
export interface ResidentEventLog {
  append(event: Record<string, unknown>): void
}

export interface ResidentEventLogOptions {
  /** 现役档绝对路径（生产 = resolveResidentLogFile 的解析结果） */
  file: string
  /** 单档上限（字节），缺省 5MB */
  maxFileBytes?: number
  /** 链上总档数（含现役），缺省 3 */
  maxFiles?: number
  /** 时钟（测试注入） */
  now?: () => number
}

/** 扫描现役档同目录的在盘轮转档序号（events.N.jsonl → N） */
function presentShiftsOf(activeFile: string): number[] {
  const dir = path.dirname(activeFile)
  const base = path.basename(activeFile)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  const prefix = `${stem}.`
  let names: string[] = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const shifts: number[] = []
  for (const n of names) {
    if (!n.startsWith(prefix) || !n.endsWith(ext)) continue
    const mid = n.slice(prefix.length, n.length - ext.length)
    const k = Number(mid)
    if (Number.isInteger(k) && k >= 1 && String(k) === mid) shifts.push(k)
  }
  return shifts
}

/**
 * 常驻事件日志写入器：append 逐事件过投影（高频帧滤除 + 脱敏）→ 达上限按裁决轮转 →
 * JSONL 追加一行（{t, ...event}，与验收侧事件观测同源）。全程尽力而为——存证失败
 * 静默吞掉，绝不影响面板运行。每次 append 一次 stat + 事件频度低（关键事件非数据帧），
 * 开销可忽略；轮转是罕见的重活（改名/删除），由纯函数裁决单点出操作表。
 */
export function createResidentEventLog(options: ResidentEventLogOptions): ResidentEventLog {
  const file = options.file
  const maxFileBytes = options.maxFileBytes ?? RESIDENT_LOG_MAX_FILE_BYTES
  const maxFiles = options.maxFiles ?? RESIDENT_LOG_MAX_FILES
  const now = options.now ?? (() => Date.now())
  let dirReady = false

  function rotate(plan: NonNullable<ReturnType<typeof planRotation>>): void {
    const dir = path.dirname(file)
    const nameFor = (shiftNo: number) => (shiftNo === 0 ? file : rotatedLogName(file, shiftNo))
    for (const s of plan.removeShifts) {
      try { fs.rmSync(nameFor(s), { force: true }) } catch { /* 尽力而为 */ }
    }
    for (const mv of plan.shift) {
      const from = nameFor(mv.from)
      const to = nameFor(mv.to)
      try {
        try { fs.rmSync(to, { force: true }) } catch { /* Windows rename 不覆盖，先清位 */ }
        fs.renameSync(from, to)
      } catch { /* 尽力而为：轮转竞态最坏多转一档，下轮自愈 */ }
    }
    void dir
  }

  return {
    append(event: Record<string, unknown>): void {
      try {
        const projected = projectResidentEvent(event)
        if (!projected) return
        const line = JSON.stringify({ t: now(), ...projected }) + '\n'
        if (!dirReady) {
          fs.mkdirSync(path.dirname(file), { recursive: true })
          dirReady = true
        }
        let bytes = 0
        try {
          bytes = fs.statSync(file).size
        } catch {
          bytes = 0 // 首启无档
        }
        if (bytes >= maxFileBytes) {
          const plan = planRotation(bytes, presentShiftsOf(file), maxFileBytes, maxFiles)
          if (plan) rotate(plan)
        }
        fs.appendFileSync(file, line)
      } catch { /* 存证尽力而为，不影响面板运行 */ }
    },
  }
}
