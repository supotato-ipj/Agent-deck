/**
 * 执行上下文登记表（工单331，ADR-0025）：主进程唯一的包身份源。
 *
 * 每个投放包一个独立 webContents；装载时登记 `webContents.id → {包 id、代次、包根、origin}`。
 * 一切 IPC handler（host.config、未来的 host.media/host.network broker）推导身份**只查本表**，
 * 永不读调用参数自报的 pluginId——登记表在案即身份，摘除即 unknown_context。
 *
 * 纯逻辑：无 Electron（webContentsId 是一个 number 键），Vitest 全覆盖。
 * 查表用 Map（09 踩坑 1 的纪律：外部键查表一律防原型链）。
 */

/** 一条执行上下文登记：只读（外部拿不到可变引用） */
export interface ExecutionContext {
  readonly webContentsId: number
  readonly packageId: string
  /** 代码代次（内容变化即递增；授权/日志按代次绑定） */
  readonly generation: number
  /** 包根绝对路径（协议资产服务的事实来源） */
  readonly root: string
  /** 独立 origin（`deck-pkg://<id>`） */
  readonly origin: string
}

export interface ExecutionContextInput {
  packageId: string
  generation: number
  root: string
  origin: string
}

export class ExecutionContextRegistry {
  private readonly byWc = new Map<number, ExecutionContext>()
  /** 包 id → 上下文键集合（反查/清算索引；命名避开同名方法——类字段会遮蔽原型方法） */
  private readonly packageIndex = new Map<string, Set<number>>()

  /** 登记（同 webContentsId 重复登记 = 换代重建，覆盖旧条目） */
  register(webContentsId: number, input: ExecutionContextInput): void {
    this.remove(webContentsId)
    const entry: ExecutionContext = Object.freeze({
      webContentsId,
      packageId: input.packageId,
      generation: input.generation,
      root: input.root,
      origin: input.origin,
    })
    this.byWc.set(webContentsId, entry)
    let keys = this.packageIndex.get(input.packageId)
    if (!keys) {
      keys = new Set()
      this.packageIndex.set(input.packageId, keys)
    }
    keys.add(webContentsId)
  }

  /** 身份推导的唯一入口：未登记（未装载/已崩溃摘除）即 null → unknown_context */
  lookup(webContentsId: number): ExecutionContext | null {
    return this.byWc.get(webContentsId) ?? null
  }

  /** 摘除单条（webContents 销毁/崩溃时） */
  remove(webContentsId: number): void {
    const entry = this.byWc.get(webContentsId)
    if (!entry) return
    this.byWc.delete(webContentsId)
    this.packageIndex.get(entry.packageId)?.delete(webContentsId)
  }

  /** 按包清算：停用/卸载/换代时摘掉该包全部上下文，不动他包 */
  removePackage(packageId: string): void {
    const keys = this.packageIndex.get(packageId)
    if (!keys) return
    for (const wcId of [...keys]) this.byWc.delete(wcId)
    this.packageIndex.delete(packageId)
  }

  /** 按包反查全部在册上下文（崩溃处置/审计读数） */
  byPackage(packageId: string): ExecutionContext[] {
    const keys = this.packageIndex.get(packageId)
    if (!keys) return []
    return [...keys].map((wcId) => this.byWc.get(wcId)!).filter(Boolean)
  }

  /** 在册总数（验收/审计读数） */
  size(): number {
    return this.byWc.size
  }
}
