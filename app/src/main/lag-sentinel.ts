// 主进程滞后哨兵（工单117，spec #109 第四缝：注入时钟的哨兵核）。#107 的停摆至今只有
// 一个观测点——电池侧 WM_NULL 2s 超时（accept/battery.js），它只说「主线程 ≥2s 没泵消息」，
// 说不出手停在哪。本哨兵是第二观测点：面板主进程自己按短拍子看表，拍间距一旦越过阈值
// 就落一条 main-lag 存证，带上「滞后窗口内动过手的同步调用点」——#111 审计
// （docs/audit/2026-10-07-t111-stall-call-site-audit.md）排好的嫌疑子系统从此有了仪表读数。
//
// 与渲染层哨兵（render-sentinel.ts）的分工：那边盯渲染进程上行静默，这边盯主线程自身
// 的消息泵滞后。审计结论（H1-H7）的预期观测信号全挂在本哨兵的事件字段上。
//
// 关键机理一——为什么标签要记区间而不是只记「当前在录集合」：主线程单线程，自己卡住时
// 自己的定时器回调跑不了，lag 只能在卡顿结束后（迟到的这一拍）被察觉；此刻肇事调用的
// finally 清标早已执行，「当前在录」必是空集。故 CallLabels 置标记 sinceMs、清标记
// untilMs，lag 事件取「区间与滞后窗口 [上拍, 本拍] 相交」的标签——已清场的肇事标签照样
// 在场（它的 untilMs ≈ 本拍），正在卡死未清的标签（untilMs 为空）也在场。这是本模块
// 与直觉最容易拧开的地方：liveLabels 读作「滞后窗口内有活动的调用点」，不是「回调这一刻
// 还挂着的调用点」。
//
// 关键机理二——终末冻结的归因要靠「进场即落盘」：#107 的停摆形态是**永不恢复**的冻结
// （电池 heal 强杀前主线程再没泵过消息）——迟到的察觉拍永远等不到，lag 事件不存在，
// 区间记账全在内存里随进程死掉。唯一能在冻结前落盘的归因事实是「冻结时哪个标签在录」：
// run 进场先写 span-open 行（同步 IO，尽力而为），finally 写 span-close 行（带实测时长）。
// 终末冻结后 sidecar 文件以无 close 的 span-open 结尾——最后一行就是卡死的调用点。
// 这是 #111 审计 H1 实验①「lag 时 liveLabels 含 keyboard-mode/pin/hotzone-toggle 之一」
// 在终末冻结形态下的唯一可落地球。sidecar 与事件文件分离（电池 readEvents 与取证 dump
// 的事件流不被 span 行淹没）；量级：常态下 ~10 行/s（150ms cover-scan 主导），一轮电池
// 数千行，可接受。
//
// 零开销口径（工单117 AC）：DECK_LAG_SENTINEL 未设时 attachLagSentinel 原样退回同一个
// EventLog 引用（可证零改动），哨兵体、定时器、区间记账、sidecar 落盘一律不构造；调用点
// 经 panelLabels.run 的直通路径只是一次可被内联的函数调用，无分配、无状态、无行为变化，
// 存证事件流与改前逐字节一致。诊断开关在场时才 enable 记账并起采样。
//
// 口径对齐：阈值缺省 2000ms——与电池 WM_NULL 探针（SMTO_ABORTIFHUNG 2000ms）同数，
// 两侧事件才能直接对读（lagMs 即「主线程 ≥lagMs 没回到定时器回调」的下界，跨进程可比）；
// lastEvents 深度 14——对齐电池取证 dump 的 slice(-14) 事件尾口径（审计 3.1 节即按此读）。
import fs from 'node:fs'
import path from 'node:path'
import type { EventLog } from './panel-ipc'

/** 采样拍（ms）：拍距远小于阈值，滞后察觉粒度 ≈ 一拍 */
export const LAG_SENTINEL_POLL_MS = 250

/** 滞后判据缺省阈值（ms）：与电池 WM_NULL 探针 2000ms 同数，两侧观测点直接对读 */
export const LAG_SENTINEL_THRESHOLD_MS = 2000

/** env 显式阈值可接受的下限：低于两拍即落在调度抖动带里（常态拍距就有 ±几十 ms），一律按缺省处理 */
export const LAG_SENTINEL_MIN_THRESHOLD_MS = LAG_SENTINEL_POLL_MS * 2

/** lastEvents 环深度：对齐电池取证 dump 的 slice(-14) 事件尾口径 */
export const LAG_SENTINEL_LAST_EVENTS = 14

/** 已闭合区间保留上限：滚动丢弃最旧区间（热区 25ms 拍下约数秒历史，覆盖滞后窗口足够） */
const FINISHED_SPANS_CAP = 512

/** 一次标签置/清的区间：置标（进入同步调用点）记 sinceMs，清标（finally）记 untilMs；
 * untilMs 为空 = 仍在调用点内（主线程正卡在这里，永远等不到清标后的察觉拍）。 */
interface LabelSpan {
  readonly label: string
  sinceMs: number
  untilMs: number | null
}

/**
 * 标签置/清落盘器（终末冻结的归因通道，见模块头「关键机理二」）：进场即写 span-open、
 * 出场写 span-close。run 在边界统一吞异常——落盘器再怎么坏也伤不到调用点本身
 * （fileSpanRecorder 自身也兜一层，双保险）。
 */
export interface SpanRecorder {
  open(label: string, sinceMs: number): void
  close(label: string, untilMs: number, ms: number): void
}

/** sidecar JSONL 落盘器：span-open / span-close 逐行追加（含 pid，跨面板代次可分）。 */
export function fileSpanRecorder(file: string): SpanRecorder {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
  } catch { /* 尽力而为 */ }
  return {
    open(label, sinceMs) {
      try {
        fs.appendFileSync(file, JSON.stringify({ type: 'span-open', pid: process.pid, label, t: sinceMs }) + '\n')
      } catch { /* 尽力而为，不影响面板运行 */ }
    },
    close(label, untilMs, ms) {
      try {
        fs.appendFileSync(file, JSON.stringify({ type: 'span-close', pid: process.pid, label, t: untilMs, ms }) + '\n')
      } catch { /* 尽力而为，不影响面板运行 */ }
    },
  }
}

/**
 * 同步调用点标签注册表：调用点入口置标、finally 清标（run 一手包办）。
 * enabled=false（哨兵不在场）时 run 直通——这就是「开关关闭零开销」的落点：
 * 全部调用点无差别挂着 run，关闭态下它只是一个转发。
 */
export class CallLabels {
  private active: LabelSpan[] = []
  private finished: LabelSpan[] = []
  /** 哨兵构造时置 true；进程生命周期内不回落（哨兵在场即记账在录） */
  enabled = false
  private recorder: SpanRecorder | null = null

  constructor(private readonly nowMs: () => number = Date.now) {}

  /** 接线（attachLagSentinel）在诊断模式挂 sidecar 落盘器；null 摘除 */
  attachRecorder(recorder: SpanRecorder | null): void {
    this.recorder = recorder
  }

  /** 同步调用点包装器：置标 → 执行 → finally 清标。fn 的返回值/异常原样透传。
   * 进场先写 span-open（此刻落盘的是「接下来要执行哪个同步调用点」——终末冻结时
   * sidecar 以无 close 的它收尾，正是肇事者签名）。落盘器调用在边界统一吞异常。 */
  run<T>(label: string, fn: () => T): T {
    if (!this.enabled) return fn()
    const sinceMs = this.nowMs()
    try {
      this.recorder?.open(label, sinceMs)
    } catch { /* 落盘尽力而为，不影响调用点 */ }
    const span: LabelSpan = { label, sinceMs, untilMs: null }
    this.active.push(span)
    try {
      return fn()
    } finally {
      const untilMs = this.nowMs()
      span.untilMs = untilMs
      try {
        this.recorder?.close(label, untilMs, untilMs - sinceMs)
      } catch { /* 落盘尽力而为，不影响调用点 */ }
      const i = this.active.indexOf(span)
      if (i >= 0) this.active.splice(i, 1)
      this.finished.push(span)
      if (this.finished.length > FINISHED_SPANS_CAP) this.finished.shift()
    }
  }

  /** 滞后窗口 [fromMs, toMs] 内有活动的标签（去重、按首次置标时序）。
   * 在录未清（untilMs=null，sinceMs ≤ toMs）与已闭合（untilMs ≥ fromMs 且 sinceMs ≤ toMs）都算。 */
  overlapping(fromMs: number, toMs: number): string[] {
    const byLabel = new Map<string, number>()
    for (const s of this.active) {
      if (s.sinceMs > toMs) continue
      if (!byLabel.has(s.label) || byLabel.get(s.label)! > s.sinceMs) byLabel.set(s.label, s.sinceMs)
    }
    for (const s of this.finished) {
      if (s.untilMs === null || s.untilMs < fromMs || s.sinceMs > toMs) continue
      if (!byLabel.has(s.label) || byLabel.get(s.label)! > s.sinceMs) byLabel.set(s.label, s.sinceMs)
    }
    return [...byLabel.entries()].sort((a, b) => a[1] - b[1]).map(([label]) => label)
  }
}

/** 面板主进程同步调用点共用注册表（进程单例）：win32/hotzone/desktop-cover/tray 等调用点
 * 都挂它；哨兵不在场时全链路直通。诊断模式由 attachLagSentinel 置 enabled。 */
export const panelLabels = new CallLabels()

/** lag 事件载荷（宿主落盘时再补 type/pid/t） */
export interface LagEventPayload {
  /** 实测滞后时长（ms）：距上一拍过去了多久——「主线程 ≥lagMs 没回到定时器回调」的下界，非阈值本身 */
  readonly lagMs: number
  /** 滞后窗口内有活动的同步调用点标签（区间相交口径，见模块头） */
  readonly liveLabels: string[]
  /** 滞后察觉前的最近存证事件类型（事件尾，对齐电池 dump 的 slice(-14) 口径） */
  readonly lastEvents: string[]
}

export interface LagSentinelOptions {
  /** 落一条 lag 事件时调用（宿主决定落点：事件文件/控制台） */
  readonly onLag: (event: LagEventPayload) => void
  /** 滞后判据阈值（ms），缺省 2000 */
  readonly thresholdMs?: number
  /** 采样拍（ms），缺省 250 */
  readonly pollMs?: number
  /** 注入时钟（spec #109 第四缝）：缺省 Date.now，vitest 假时钟/手动时钟可替换 */
  readonly nowMs?: () => number
  /** 标签注册表，缺省进程单例 panelLabels；测试传独立实例避免全局串味 */
  readonly labels?: CallLabels
  /** lastEvents 环深度，缺省 14 */
  readonly lastEventsDepth?: number
  /** 标签置/清 sidecar 落盘器（终末冻结归因通道），提供即挂到注册表上 */
  readonly recorder?: SpanRecorder
}

/**
 * 哨兵采样体：递归 setTimeout 自排程（不用 setInterval——卡顿期间错过的多拍会被合并，
 * 递归排程让一段卡顿恰好产出一条 lag 事件），每拍看「距上拍多久」，越过阈值即把
 * lagMs + 标签区间快照 + 事件尾交给 onLag。零 Electron、零 IO、不持阈值裁决以外的策略。
 */
export class LagSentinel {
  private readonly thresholdMs: number
  private readonly pollMs: number
  private readonly nowMs: () => number
  private readonly labels: CallLabels
  private readonly lastEventsDepth: number
  private readonly ring: string[] = []
  private lastTickMs: number
  private timer: NodeJS.Timeout | null = null
  private disposed = false

  constructor(private readonly options: LagSentinelOptions) {
    this.thresholdMs = options.thresholdMs ?? LAG_SENTINEL_THRESHOLD_MS
    this.pollMs = options.pollMs ?? LAG_SENTINEL_POLL_MS
    this.nowMs = options.nowMs ?? Date.now
    this.labels = options.labels ?? panelLabels
    this.lastEventsDepth = options.lastEventsDepth ?? LAG_SENTINEL_LAST_EVENTS
    // 哨兵在场即记账在录：调用点的置/清从构造起生效（进程生命周期内不回落）
    this.labels.enabled = true
    if (options.recorder) this.labels.attachRecorder(options.recorder)
    this.lastTickMs = this.nowMs()
    this.schedule()
  }

  /** 宿主把存证事件类型喂进来（attachLagSentinel 的 tee 接线）：lag 事件的 lastEvents 由此而来 */
  noteEvent(type: string): void {
    this.ring.push(type)
    if (this.ring.length > this.lastEventsDepth) this.ring.shift()
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(): void {
    if (this.disposed) return
    this.timer = setTimeout(() => this.tick(), this.pollMs)
    // unref：哨兵是观测者不是活命理由，面板退出不该被它拖延（desktop-cover 同款）
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  private tick(): void {
    if (this.disposed) return
    const now = this.nowMs()
    const lagMs = now - this.lastTickMs
    this.lastTickMs = now
    if (lagMs >= this.thresholdMs) {
      this.options.onLag({
        lagMs,
        liveLabels: this.labels.overlapping(now - lagMs, now),
        lastEvents: [...this.ring],
      })
    }
    this.schedule()
  }
}

/** 解析 DECK_LAG_SENTINEL 的阈值语义：数字且 ≥ 下限才当阈值，其余（含 '1'/'on'）一律缺省 2000 */
export function parseLagThresholdMs(raw: string | undefined): number {
  const n = raw === undefined ? NaN : Number(raw)
  if (!Number.isFinite(n) || n < LAG_SENTINEL_MIN_THRESHOLD_MS) return LAG_SENTINEL_THRESHOLD_MS
  return Math.round(n)
}

/** 无事件文件时的 lag 落点兜底：控制台尽力而为（诊断开关通常与 DECK_EVENT_LOG 同设） */
function consoleEventLog(): EventLog {
  return {
    append(event) {
      try {
        console.log('[deck] main-lag', JSON.stringify(event))
      } catch { /* 兜底落点不影响面板运行 */ }
    },
  }
}

/**
 * 接线（bootPanel 专用，一行换一行）：DECK_LAG_SENTINEL 未设 → 原样退回同一个 log 引用
 * （常规模式零改动，可引用相等性证明）；设了 → 构造哨兵（起采样、置记账 enabled、
 * spansFile 给出时挂 sidecar 落盘器），返回 tee 过的 EventLog——存证照常落原文件，
 * 事件类型顺手喂给哨兵的 lastEvents 环；lag 事件以 type='main-lag' 落同一文件，
 * 电池侧 readEvents 按 type 过滤不受打扰，取证 dump 的事件尾反而多出这条读数。
 * log 为空（未设 DECK_EVENT_LOG）时 lag 落控制台。
 */
export function attachLagSentinel(log: EventLog | null, envValue: string | undefined, spansFile?: string): EventLog | null {
  if (envValue === undefined || envValue === '') return log
  const sink = log ?? consoleEventLog()
  const sentinel = new LagSentinel({
    thresholdMs: parseLagThresholdMs(envValue),
    ...(spansFile ? { recorder: fileSpanRecorder(spansFile) } : {}),
    onLag: (e) => sink.append({ type: 'main-lag', pid: process.pid, ...e }),
  })
  if (!log) return sink
  return {
    append(event) {
      log.append(event)
      if (event && typeof event.type === 'string') sentinel.noteEvent(event.type)
    },
  }
}
