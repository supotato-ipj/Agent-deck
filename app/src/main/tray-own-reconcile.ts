// 托盘自有图标对账（工单437）：面板自有 Electron Tray 的 NIM_ADD 会被 OS 托盘管线间歇
// 路由进 explorer 真托盘（#325 路由族 own-icon 变体），且坏态按发送方身份粘住——取证
// （.scratch/issue437-rounds/forensics-notes.md）：红轮自家图标重注应答在第 2 次收编后
// 断流，连续 11 次宿主重建零语料，roster 从此缺自家键（P27 臂3 红签名）；健康定律是
// Chromium 对每次 TaskbarCreated 广播可靠重注（DEL+ADD 对，宿主 ready 后 0.1-2.5s 到达）。
//
// 修法 = 面板周期对账（票面选项 A，与 #430 探针「miss 回收重注一拍」同一纪律族）：
// 宿主在场且自家图标在等待窗内未应答即判 miss → destroy + recreate Tray。recreate 的
// destroy 发 NIM_DELETE——按持位路由会清掉 explorer 侧副本（粘态自清）；新回调窗 =
// 新身份 = 退出粘态重抽路由签。健康轮零增量（只在 miss 路径动手，重试只走 miss 路径）。
// 触顶后转降频兜底（面板长寿命，保底最终恢复），不再抬频骚扰。
//
// 本模块是纯状态机：事件订阅、pid 判定、重注动作全部注入——离线测试零 koffi 零 Electron。

/** 对账存证（事件磁带取证口径；battery 可后续断言）。type 而非 interface——
 * EventLog.append 入参是 Record<string, unknown>，interface 没有隐式索引签名 */
export type TrayOwnReconcileEvent = {
  type: 'tray-own-reinject' | 'tray-own-reinject-recovered'
  /** 本轮 miss 的连续重注拍数（recovered 携带恢复前拍数） */
  attempt: number
}

export interface TrayOwnReconcileDeps {
  /** 订阅宿主托盘事件流（dataplane/tray-event）：自家身份的 add/update = 应答证据 */
  subscribeTrayEvent: (cb: (event: { kind: string; hwnd: string }) => void) => () => void
  /** 订阅宿主生命周期（dataplane/tray-host）：ready 开等待窗，stopped/failed 摘在场位 */
  subscribeTrayHost: (cb: (event: { type: string }) => void) => () => void
  /** 窗口属主 pid（句柄亡/读不出 = 0，宁可漏判不误判） */
  windowPidOf: (hwnd: string) => number
  /** 面板主进程 pid（自家 Tray 回调窗的属主） */
  ownPid: number
  /** 重注动作：destroy + recreate 自家 Tray */
  reinject: () => void
  /** 对账存证（缺省静默） */
  log?: (event: TrayOwnReconcileEvent) => void
  /** 测试缝：时钟（缺省 Date.now） */
  now?: () => number
  /** 测试缝：对账拍调度（缺省真定时器） */
  schedule?: (fn: () => void, ms: number) => unknown
  cancel?: (handle: unknown) => void
}

export interface TrayOwnReconcileOptions {
  /** 宿主启动后等自家应答的窗口（健康到达 0.1-2.5s，留裕量取 5s——健康轮零触发） */
  settleMs?: number
  /** 对账拍间隔（缺省 3s） */
  intervalMs?: number
  /** 连续重注上限（缺省 3）；触顶后同拍间隔改走 backoffMs */
  maxConsecutive?: number
  /** 降频兜底重注间隔（缺省 30s） */
  backoffMs?: number
}

/**
 * 起对账环。订阅必须先于宿主首拍 ready 安装（内核 start 前接线）——首拍 ready 漏订
 * 会让开机 miss 无人对账。返回 dispose（测试用；面板进程生命周期内可不拆）。
 */
export function startTrayOwnReconcile(
  deps: TrayOwnReconcileDeps,
  options: TrayOwnReconcileOptions = {},
): () => void {
  const settleMs = options.settleMs ?? 5000
  const intervalMs = options.intervalMs ?? 3000
  const maxConsecutive = options.maxConsecutive ?? 3
  const backoffMs = options.backoffMs ?? 30000
  const now = deps.now ?? ((): number => Date.now())
  const schedule = deps.schedule ?? ((fn: () => void, ms: number): unknown => setInterval(fn, ms))
  const cancel = deps.cancel ?? ((handle: unknown): void => clearInterval(handle as ReturnType<typeof setInterval>))

  // 状态：宿主在场位 / 自家应答位 / 等待窗起点 / 连续重注拍数
  let hostInField = false
  let ownAlive = false
  let pendingSince: number | null = null
  let attempt = 0
  let lastAttemptAt = 0
  let stopped = false

  const unsubscribeEvent = deps.subscribeTrayEvent((event) => {
    if (stopped) return
    // 只有 add/update 是「宿主见过自家身份」的证据（delete/reaped/version/focus 不算）
    if (event.kind !== 'add' && event.kind !== 'update') return
    if (deps.windowPidOf(event.hwnd) !== deps.ownPid) return
    if (!ownAlive && attempt > 0) {
      deps.log?.({ type: 'tray-own-reinject-recovered', attempt })
    }
    ownAlive = true
    pendingSince = null
  })

  const unsubscribeHost = deps.subscribeTrayHost((event) => {
    if (stopped) return
    if (event.type === 'tray-host-ready') {
      // 新宿主上场：旧登记全作废（stop 清账不发光），自家图标须重新应答
      hostInField = true
      ownAlive = false
      pendingSince = now()
      return
    }
    if (event.type === 'tray-host-stopped' || event.type === 'tray-host-failed') {
      hostInField = false
      pendingSince = null
      ownAlive = false
    }
  })

  const tick = (): void => {
    if (stopped) return
    if (!hostInField || ownAlive || pendingSince === null) return
    const t = now()
    if (t - pendingSince < settleMs) return
    // 触顶降频：同拍仍判 miss，但重注间隔放宽到 backoffMs（保底恢复，不抬频骚扰）
    if (attempt >= maxConsecutive && t - lastAttemptAt < backoffMs) return
    attempt += 1
    lastAttemptAt = t
    deps.log?.({ type: 'tray-own-reinject', attempt })
    try {
      deps.reinject()
    } catch {
      // 重注失败不炸对账环——下一拍按 miss 续拍（面板 Tray 销毁态的竞态尽力而为）
      return
    }
    pendingSince = t // 新 Tray 的应答重新开等待窗
  }

  const handle = schedule(tick, intervalMs)

  return () => {
    stopped = true
    unsubscribeEvent()
    unsubscribeHost()
    cancel(handle)
  }
}
