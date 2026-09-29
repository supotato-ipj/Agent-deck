/** 300 点滚动历史（Python collections.deque(maxlen=300) 的语义平移）。 */
export class HistoryRing {
  private readonly items: (number | null)[] = []

  constructor(private readonly maxLen: number) {}

  /** 入环前取整 1 位小数（Python round(x, 1)）；不可用点为 null */
  push(value: number | null): void {
    if (this.items.length === this.maxLen) this.items.shift()
    this.items.push(value === null ? null : Math.round(value * 10) / 10)
  }

  toArray(): (number | null)[] {
    return [...this.items]
  }
}

export function round1(value: number): number {
  return Math.round(value * 10) / 10
}
