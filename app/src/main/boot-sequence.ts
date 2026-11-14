// 启动序列编排（工单481，ADR-0032「启动重排为骨架屏形态」）：纯函数域——
// 面板启动链的先后序与上界在这里单点可读、离线可穷举；index.ts 的 bootPanel
// 按本计划分发执行（每步的相位戳、阻塞语义与外部等待上界都以计划为准）。
//
// 零 Electron 依赖（与 resident-event-log.ts / panel-quit.ts 同构分层）。
//
// 修序依据（#478 诊断轮实锤，见 docs/audit/2026-11-14-t478-diagnostic-round.md §一）：
//   - 自启项维护每次启动同步 spawnSync PowerShell（热态 1.19s、上界 20s、开机窗口
//     冷态放大）→ autostart-apply 是「发起不等待」的后补步（④去同步化）；
//   - `await kernel.desktopWorkspace?.start()` 裸 await 无显式上界 → workspace-start
//     后补步带显式上界，超时降级放行 + 迟到补拍（③一切外部等待有界）。
//
// 骨架屏语义（GLOSSARY「骨架屏」）：面板窗与任务栏条带尽早出现并可交互，桌面组件
// 位置先以轻量占位呈现、数据到达后原位填充——它把「面板活着」与「数据齐了」两件事
// 在时间上拆开。主线（mainline）只做纯内存步与异步任务发起；一切外部等待都在后补链
// （backfill）里带显式上界执行。

/** 外部等待上界常量：启动链一切外部等待显式上界（票面验收③），超时降级放行 */
/** 自启项 PowerShell helper 单次调用上界（与退役的 spawnSync timeout 同值——异步化不改预算） */
export const AUTOSTART_HELPER_BOUND_MS = 20_000
/** 内核装配等待上界：热态实测 0.19~0.83s（#478 两轮），冷态放大留 10 倍裕量 */
export const KERNEL_START_BOUND_MS = 10_000
/** 数据面首拍等待上界：DataplaneService whenReady 内建同值（15s 超时放行先起空数据面）——计划显式记录 */
export const PANEL_DATA_BOUND_MS = 15_000
/** 桌面工作区首轮对账上界：FFI 直读热态毫秒级、reg.exe 兜底百毫秒级；开机窗口 COM/注册表
 * 冷态放大留裕量。超时降级：先按当前模式起 Agent 服务族，工作区迟到对账完成后补拍激活。 */
export const WORKSPACE_START_BOUND_MS = 5_000

/** #473 相位名（常驻事件日志 boot-phase 族；验收电池 P473 段 EXPECTED_PHASES 同源契约） */
export type BootPhaseName =
  | 'config-loaded'
  | 'autostart-applied'
  | 'kernel-started'
  | 'panel-data-ready'
  | 'window-wired'
  | 'panel-visible'

export interface BootStep {
  /** 编排步名：执行器（index.ts bootPanel）按它分发动作 */
  readonly label: string
  /** 相位戳：本步完成时落 {type:'boot-phase'} 的相位名；null = 不落戳 */
  readonly phase: BootPhaseName | null
  /**
   * 主线是否等待本步完成才继续。true 仅限纯内存步（窗口/控制器装配、订阅接线——
   * 毫秒级、无外部等待）；异步任务发起步（自启项/内核装配）与首显事件步为 false——
   * 首帧与首交互不等它们（骨架屏语义）。
   */
  readonly blocking: boolean
  /**
   * 外部等待显式上界（ms）：异步任务步记录其等待/内建上界；纯内存步为 null。
   * 后补链的外部等待步必填——超时按 timeoutEvent 降级放行，不悬挂。
   */
  readonly boundMs: number | null
  /** 上界超时的降级存证事件名；null = 无独立超时路径（任务自带上界或纯内存步） */
  readonly timeoutEvent: string | null
}

export interface BootSequencePlan {
  /**
   * 主线：bootPanel 同步走完的步序（顺序即执行序）。blocking 步逐个等待；
   * 非 blocking 步发起即继续（骨架窗接线不等装配与数据）。
   */
  readonly mainline: readonly BootStep[]
  /**
   * 后补链：主线走完（骨架已可交互）后按依赖序执行的异步链。逐步推进，
   * 外部等待一律经 boundWait 上界竞速，超时降级记录后继续。
   */
  readonly backfill: readonly BootStep[]
}

/**
 * 面板启动序列计划（纯函数；无 config 分支——功能开关的启停由各控制器/服务自裁决，
 * 编排不因开关变形：任务栏禁用时条带控制器随 taskbar/changed 自拆，工作区关闭时
 * start() 原样退回禁用态投影）。
 */
export function planBootSequence(): BootSequencePlan {
  const mainline: BootStep[] = [
    // ① 配置装载：同步 loadConfig（本地小文件，#478 实测 11~30ms）——落 config-loaded 戳
    { label: 'config-load', phase: 'config-loaded', blocking: true, boundMs: null, timeoutEvent: null },
    // ② 自启项维护发起（④去同步化）：异步 PowerShell helper（内建 AUTOSTART_HELPER_BOUND_MS
    //    上界、超时杀进程降级），完成（或降级）时落 autostart-applied 戳——主线不等它
    { label: 'autostart-apply', phase: 'autostart-applied', blocking: false, boundMs: AUTOSTART_HELPER_BOUND_MS, timeoutEvent: null },
    // ③ 内核装配发起（②装配后补化）：cordis start 在后台装配服务（含数据面子进程拉起），
    //    完成时落 kernel-started 戳；等待上界在后补链 kernel-await 步
    { label: 'kernel-start', phase: 'kernel-started', blocking: false, boundMs: null, timeoutEvent: null },
    // ④ 骨架窗接线（①尽早创建尽早可交互）：面板窗 + 任务栏条带 + 各承载窗控制器 + 桥接
    //    IPC——纯内存步，桌面组件以空数据占位呈现（数据面首拍在后补链填充）
    { label: 'skeleton-windows', phase: 'window-wired', blocking: true, boundMs: null, timeoutEvent: null },
    // ⑤ 托盘入口与二次拉起钩子（⑤boot 早期接活）：托盘图标在场、second-instance 钩子
    //    接管 showPanel——半开机点击有可见反馈，不再静默吞没
    { label: 'tray-and-hooks', phase: null, blocking: true, boundMs: null, timeoutEvent: null },
    // ⑥ 骨架首显：skeleton 页面装载完成后 ready-to-show 显示（事件驱动，无外部等待）——
    //    落 panel-visible 戳；此刻数据面多半未首拍，桌面组件正处占位态
    { label: 'skeleton-reveal', phase: 'panel-visible', blocking: false, boundMs: null, timeoutEvent: null },
  ]
  const backfill: BootStep[] = [
    // 内核装配等待（显式上界）：超时记 kernel-start-timeout 降级放行——装配继续后台收敛，
    // 服务就绪后事件自然回推；kernel-started 戳由装配完成时落（可能晚于本步的降级放行）
    { label: 'kernel-await', phase: null, blocking: false, boundMs: KERNEL_START_BOUND_MS, timeoutEvent: 'kernel-start-timeout' },
    // 数据面首拍（whenReady 内建 15s 超时放行，PANEL_DATA_BOUND_MS 显式记录）：首拍到达
    // 后桥接层自然推送，桌面组件原位填充——落 panel-data-ready 戳
    { label: 'panel-data', phase: 'panel-data-ready', blocking: false, boundMs: PANEL_DATA_BOUND_MS, timeoutEvent: null },
    // 桌面工作区首轮对账（③实锤点收口）：超时记 workspace-start-timeout 降级放行 +
    // 迟到补拍激活（t383 时序语义由迟到 .then 保住）——workspace-start-gate 事件照常在档
    { label: 'workspace-start', phase: null, blocking: false, boundMs: WORKSPACE_START_BOUND_MS, timeoutEvent: 'workspace-start-timeout' },
    // Agent 服务族启动（平铺/聚焦/预览 + 激活对齐）：纯内存步，依赖上一步的模式态
    { label: 'agent-services', phase: null, blocking: false, boundMs: null, timeoutEvent: null },
  ]
  return { mainline, backfill }
}

/** boundWait 的结果：上界内落定（携带值）或超时降级 */
export type BoundOutcome<T> = { kind: 'settled'; value: T } | { kind: 'timeout' }

/**
 * 外部等待上界原语（票面验收③的执行件）：承诺与上界计时竞速——
 * 上界内 resolve → {kind:'settled', value}；上界内 reject → 拒绝原样传播
 * （真失败不冒充超时降级）；超出上界 → {kind:'timeout'} 并吞掉原承诺后续的
 * 落定/拒绝（迟到拒绝不得炸成 unhandledRejection）。计时器 unref：
 * 降级路径不拖住进程退出。
 */
export function boundWait<T>(promise: Promise<T>, boundMs: number): Promise<BoundOutcome<T>> {
  let timer: NodeJS.Timeout | null = null
  const timedOut = new Promise<BoundOutcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), boundMs)
    timer.unref?.()
  })
  const tracked = promise.then(
    (value) => {
      if (timer) clearTimeout(timer)
      return { kind: 'settled', value } as BoundOutcome<T>
    },
    (err) => {
      if (timer) clearTimeout(timer)
      throw err
    },
  )
  // 超时后原承诺的迟到落定/拒绝被本竞速分支吞掉（拒绝尤其要吞——unhandledRejection 防线）
  void promise.catch(() => {})
  return Promise.race([tracked, timedOut])
}
