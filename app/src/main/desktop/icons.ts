// 图标缓存（工单05，纯逻辑）：注入提取器（生产为 Electron app.getFileIcon），
// 语义——并发同键去重（单次提取）、成功即缓存、失败按尝试上限退避后缓存 null。
export interface IconExtractor {
  (filePath: string): Promise<string | null>
}

export class IconCache {
  private readonly cache = new Map<string, string | null>()
  private readonly inflight = new Map<string, Promise<string | null>>()
  private readonly attempts = new Map<string, number>()

  constructor(
    private readonly extract: IconExtractor,
    /** 同键失败尝试上限：达到后缓存 null 不再重试（防毒键每拍重提取） */
    private readonly maxAttempts = 3,
  ) {}

  /** 已解析值；undefined = 尚未解析（可能仍在提取或待重试） */
  peek(key: string): string | null | undefined {
    return this.cache.get(key)
  }

  /** 本键是否还有提取工作可做（预热闹用：未解析且尝试未耗尽） */
  needsWork(key: string): boolean {
    return !this.cache.has(key) && (this.attempts.get(key) ?? 0) < this.maxAttempts
  }

  /** 取图标：缓存命中即回；进行中共用同一 Promise；否则发起一次提取。
   * Promise.resolve().then 包裹使同步抛错的提取器也走失败计数而非穿透调用方。 */
  fetch(key: string, filePath: string): Promise<string | null> {
    if (this.cache.has(key)) return Promise.resolve(this.cache.get(key) ?? null)
    let p = this.inflight.get(key)
    if (!p) {
      p = Promise.resolve()
        .then(() => this.extract(filePath))
        .then(
          (value) => {
            this.cache.set(key, value)
            this.inflight.delete(key)
            return value
          },
          () => {
            const n = (this.attempts.get(key) ?? 0) + 1
            this.attempts.set(key, n)
            if (n >= this.maxAttempts) this.cache.set(key, null)
            this.inflight.delete(key)
            // 未达上限的失败不缓存：下一拍扫描重试（文件可能正在写入）
            return null
          },
        )
      this.inflight.set(key, p)
    }
    return p
  }
}
