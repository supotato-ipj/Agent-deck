import { Service } from 'cordis'
import type { Context } from 'cordis'
import { appendEvent, detectFocus, detectStarts, pruneOldDays, readStartEvents, type UsageEvent } from '../usage/log'
import { fuseScores, type PriorEntry, type ScoreItem } from '../usage/score'
import { nativeForegroundExe, nativeRunningPidExes } from '../usage/native'
import { readUserAssistPrior } from '../usage/userassist'
import { userDataPath } from '../paths'

/** 使用日志依赖束：主进程真源 / 测试假源共用一个服务状态机（hardware sources 同法） */
export interface UsageDeps {
  runningPidExes(): Map<number, string>
  foregroundExe(): string | null
  /** 冷启动先验（UserAssist，异步——reg 导出不堵 boot 关键路径）；空表 = 先验缺位 */
  readPrior(): Promise<Map<string, PriorEntry>>
}

export interface UsageServiceOptions {
  /** 日志目录（默认 userData/usage） */
  dir?: string
  deps?: Partial<UsageDeps>
}

/**
 * 应用使用日志服务（工单06，usage_log.py 的 Collector/run_loop 平移）：
 * 一轮 collect() = 前台轮询 + pid 差分；start/focus 各写各的按天 JSONL（只有 ts 与 exe，
 * 绝无窗口标题——ADR-0002），90 天滚动清理（boot 一轮 + 内核每小时一轮）。
 * 频次打分按需拉取（fuseScores 纯函数，事件常驻内存，只有 start 事件进打分）。
 * 采集轮询与滚动清理由内核定时器驱动（kernel.ts）。
 */
export class UsageService extends Service {
  private readonly dir: string
  private readonly deps: UsageDeps
  private events: UsageEvent[] = []
  private prior: ReadonlyMap<string, PriorEntry> = new Map()
  private previous: Map<number, string> | null = null
  private lastFocus: string | null = null

  constructor(ctx: Context, options: UsageServiceOptions = {}) {
    super(ctx, 'usage')
    this.dir = options.dir ?? userDataPath('usage')
    this.deps = {
      runningPidExes: options.deps?.runningPidExes ?? nativeRunningPidExes,
      foregroundExe: options.deps?.foregroundExe ?? nativeForegroundExe,
      readPrior: options.deps?.readPrior ?? readUserAssistPrior,
    }
    this.events = readStartEvents(this.dir, Date.now())
    pruneOldDays(this.dir, Date.now())
    // 冷启动先验异步就位：自建日志尚空时它撑起初版 dock 推荐序；晚到几百 ms
    // 只影响首拍后的排序初值，1Hz 重算自然收敛（不得堵 boot——05「首绘就位」教训）
    void this.deps.readPrior().then(
      (prior) => {
        this.prior = prior
      },
      (err: unknown) => {
        console.warn(`deck-usage: 冷启动先验读取失败（按无先验继续）：${err instanceof Error ? err.message : err}`)
      },
    )
  }

  /** 滚动清理（boot 已清一轮；内核每小时驱动——常驻面板的保留期不能只靠重启收敛） */
  prune(): void {
    pruneOldDays(this.dir, Date.now())
  }

  /** 一轮采集：pid 差分识别启动 + 前台切换识别聚焦，两类事件各写各的按天文件。返回本轮事件。 */
  collect(nowMs = Date.now()): UsageEvent[] {
    const starts: UsageEvent[] = []
    const focuses: UsageEvent[] = []
    const current = this.deps.runningPidExes()
    if (this.previous !== null) {
      for (const exe of detectStarts(this.previous, current)) starts.push({ tsMs: nowMs, exe })
    }
    this.previous = current
    const switched = detectFocus(this.lastFocus, this.deps.foregroundExe())
    if (switched !== null) {
      focuses.push({ tsMs: nowMs, exe: switched })
      this.lastFocus = switched
    }
    for (const e of starts) appendEvent(this.dir, 'start', e.exe, e.tsMs)
    for (const e of focuses) appendEvent(this.dir, 'focus', e.exe, e.tsMs)
    this.events.push(...starts) // 打分只吃 start 事件（07 的「真启动次数」同源）
    return [...starts, ...focuses]
  }

  /** 端到端打分：桌面条目（含目标解析）→ {显示名: 使用频次分数}（先验与日志在条目层面融合） */
  iconScores(
    items: ScoreItem[],
    resolve: (lnkPath: string) => string | null,
    exists: (lnkPath: string) => boolean,
    nowMs = Date.now(),
  ): Map<string, number> {
    return fuseScores(this.prior, this.events, nowMs, items, resolve, exists)
  }

  /** 测试观察缝：当前 start 事件数与先验规模 */
  snapshotForTest(): { events: number; priorSize: number } {
    return { events: this.events.length, priorSize: this.prior.size }
  }
}
