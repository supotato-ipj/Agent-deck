/**
 * 单一心跳调度器（工单477 束④）：采集族多个周期任务合并到单一 setInterval——
 * 每拍对「到期」任务派发（fire-if-due 按注入时钟判定，任务各按自身 everyMs 周期）。
 * 周期语义与被替换的独立 setInterval 对齐：首次运行在 start 后一个周期、停摆错过的
 * 多拍合并为一拍一次（不按错拍数连跑）。任务抛错只上报名，不中断其余任务派发。
 *
 * 时钟与拍进均可注入：离线测试用合成钟 + 手动 beat() 驱动（不等真钟）；
 * 生产装配真实 start()，一进程一拍（数据面子进程内 4 个定时器归 1）。
 */
export interface HeartbeatTask {
  /** 派发周期 ms */
  everyMs: number
  run: () => void
  /** 上报/诊断用任务名（缺省匿名） */
  label?: string
}

export class Heartbeat {
  private readonly tasks: HeartbeatTask[] = []
  private readonly nextDue = new Map<HeartbeatTask, number>()
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly nowFn: () => number
  private readonly onError: (task: HeartbeatTask, err: unknown) => void

  constructor(
    /** 心跳拍长 ms（= setInterval 周期；须不大于最快任务的 everyMs） */
    private readonly beatMs: number,
    now: () => number = Date.now,
    onError: (task: HeartbeatTask, err: unknown) => void = (task, err) => {
      console.warn(`heartbeat: 任务 ${task.label ?? '匿名'} 派发失败：${err instanceof Error ? err.message : String(err)}`)
    },
  ) {
    this.nowFn = now
    this.onError = onError
  }

  /** 登记一个周期任务（重复登记同一任务对象以最后一次为准）；到期点自登记时刻起算
   * （= 旧 setInterval 首拍语义：add 后一个周期首次派发，不随首次 beat 漂移） */
  add(task: HeartbeatTask): void {
    this.remove(task)
    this.tasks.push(task)
    this.nextDue.set(task, this.nowFn() + task.everyMs)
  }

  /** 撤销登记 */
  remove(task: HeartbeatTask): void {
    const i = this.tasks.indexOf(task)
    if (i >= 0) this.tasks.splice(i, 1)
    this.nextDue.delete(task)
  }

  /** 起跳（幂等）：真实定时器驱动 beat()；无任务不起 */
  start(): void {
    if (this.timer !== null || this.tasks.length === 0) return
    this.timer = setInterval(() => this.beat(), this.beatMs)
  }

  /** 停跳（幂等）：beat 不再派发（再 start 重计到期） */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.nextDue.clear()
  }

  /** 一拍：对所有登记任务做到期判定并派发（手动驱动缝，测试/主循环共用同一判定） */
  beat(): void {
    const t = this.nowFn()
    for (const task of [...this.tasks]) {
      let due = this.nextDue.get(task)
      if (due === undefined) {
        due = t + task.everyMs // 首次见：一个周期后到期（旧 setInterval 首拍语义）
        this.nextDue.set(task, due)
        continue
      }
      if (t < due) continue
      this.nextDue.set(task, t + task.everyMs) // 到期即重计：错拍合并为一拍一次
      try {
        task.run()
      } catch (err) {
        this.onError(task, err)
      }
    }
  }
}
