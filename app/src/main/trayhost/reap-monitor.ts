// 回收监视线程（工单423）：单一工作线程对所有在场宿主句柄做零超时**分批**等待
// （单次等待句柄数上限 MAXIMUM_WAIT_OBJECTS=64 内切批），signaled 者上报主线程——
// 经既有主线程调度（worker postMessage）回账本执行回收，账本操作不跨线程（票面既定
// 形态）。判据=宿主进程句柄（OpenProcess SYNCHRONIZE）signaled：句柄指向注册时刻的
// 进程对象，天然免疫 PID 复用；无超时兜底、无启发式——宁可漏收（宿主僵死但进程对象
// 存活）不误收。
// 本文件一文件两栖：主线程侧是 spawn/驱动缝（startReapMonitor）；工作线程侧（tsc 编译
// 产物被 Worker 以本文件加载时）跑等待循环。工作线程自带 koffi（经 workerData 传绝对
// 路径 require——eval 场景模块解析不稳），不注册任何 koffi 具名类型（进程级单登约束）。
import { isMainThread, parentPort, workerData, Worker } from 'node:worker_threads'

export interface ReapWatchRef {
  /** 图标身份键（TrayEntry 键，回放与回收同源） */
  key: string
  /** 宿主进程句柄（OpenProcess SYNCHRONIZE；本进程内全线程有效） */
  handle: number
}

export interface ReapMonitor {
  /** 监视集同步（条目增删时全量替换快照） */
  setHandles(handles: ReapWatchRef[]): void
  /** 终止监视线程 */
  stop(): void
}

/** 轮询拍距：零超时等待的节拍——回收时限（建议 ≤3s）与系统调用负载的折中 */
const REAP_POLL_MS = 200
/** 单次 WaitForMultipleObjects 句柄上限（MAXIMUM_WAIT_OBJECTS=64，留 1 余量） */
const MAXIMUM_WAIT_OBJECTS = 63

/** 主线程侧：spawn 监视线程。spawn 失败不阻断宿主（监视缺位 = 宁可漏收），返回 null。 */
export function startReapMonitor(opts: {
  onDead: (keys: string[]) => void
  log?: (e: Record<string, unknown>) => void
}): ReapMonitor | null {
  // 嵌套守卫用 workerData 而非 isMainThread——utilityProcess（Electron）的脚本本就跑在
  // 非主线程上，isMainThread 在数据面子进程恒 false（真机实证 r5：守卫误判 → 监视线程
  // 静默缺位）；workerData 只在本模块 spawn 的 Worker 里非空，才是真正的「已在监视线程」。
  if (workerData) return null
  try {
    const worker = new Worker(__filename, { workerData: { koffiPath: require.resolve('koffi') } })
    worker.unref() // 监视线程不阻止数据面子进程退出（stop 链另有 terminate）
    worker.on('message', (m: { dead?: string[]; synced?: number; loopError?: string }) => {
      if (Array.isArray(m?.dead) && m.dead.length > 0) opts.onDead(m.dead)
      if (typeof m?.synced === 'number') opts.log?.({ type: 'tray-reap-monitor-synced', handles: m.synced })
      if (typeof m?.loopError === 'string') opts.log?.({ type: 'tray-reap-monitor-loop-error', message: m.loopError })
    })
    worker.on('online', () => opts.log?.({ type: 'tray-reap-monitor-ready', threadId: worker.threadId }))
    worker.on('error', (err) => opts.log?.({ type: 'tray-reap-monitor-error', message: err.message }))
    worker.on('exit', (code) => opts.log?.({ type: 'tray-reap-monitor-exit', exitCode: code }))
    return {
      setHandles: (handles) => worker.postMessage({ type: 'set', handles }),
      stop: () => worker.terminate(),
    }
  } catch (err) {
    opts.log?.({ type: 'tray-reap-monitor-spawn-fail', message: (err as Error).message })
    return null
  }
}

/** 工作线程侧：等待循环。返回值判读（bWaitAll=false）：
 * WAIT_OBJECT_0+idx（idx<63）= 该 idx 句柄已 signaled（每批每拍只报首个，其余下拍
 * 续报直到主线程摘除——回收幂等，收敛不受影响）；0x102=本批全未决；0xFFFFFFFF=
 * 调用失败（无效句柄等，忽略——宁可漏收）；abandon 段（≥0x80）不适用进程句柄。 */
function monitorLoop(): void {
  const { koffiPath } = workerData as { koffiPath: string }
  const koffi = require(koffiPath) as { load(name: string): { func(sig: string): (...args: unknown[]) => unknown } }
  const wait = koffi.load('kernel32.dll').func('uint32 __stdcall WaitForMultipleObjects(uint32 n, void *handles, bool any, uint32 ms)') as (n: number, buf: Buffer, any: boolean, ms: number) => number
  let snapshot: ReapWatchRef[] = []
  let stopped = false
  let syncedOnce = false
  parentPort!.on('message', (m: { type: string; handles?: ReapWatchRef[] }) => {
    if (m.type === 'set') {
      snapshot = m.handles ?? []
      if (!syncedOnce && snapshot.length > 0) {
        syncedOnce = true
        parentPort!.postMessage({ synced: snapshot.length }) // 首次同步回执（真机诊断面）
      }
    } else if (m.type === 'stop') {
      stopped = true
    }
  })
  const tick = (): void => {
    try {
      const dead: string[] = []
      for (let i = 0; i < snapshot.length; i += MAXIMUM_WAIT_OBJECTS) {
        const batch = snapshot.slice(i, i + MAXIMUM_WAIT_OBJECTS)
        const buf = Buffer.alloc(batch.length * 8)
        batch.forEach((it, j) => buf.writeBigUInt64LE(BigInt.asUintN(64, BigInt(it.handle)), j * 8))
        // bWaitAll=false：任一 signaled 即回——真机实证（工单423 r6）传 true 时整批
        // 全 signaled 才回，混批恒 WAIT_TIMEOUT（n=1 离线预验掩盖了该错）。
        const r = wait(batch.length, buf, false, 0)
        if (typeof r === 'number' && r < MAXIMUM_WAIT_OBJECTS) dead.push(batch[r].key)
      }
      if (dead.length > 0) parentPort!.postMessage({ dead })
    } catch (err) {
      // 等待循环异常（koffi 缺席/类型问题）：报回主线程留证，续拍照跑——宁可漏收
      parentPort!.postMessage({ loopError: (err as Error).message })
    }
    if (!stopped) setTimeout(tick, REAP_POLL_MS)
  }
  tick()
}

// 两栖分派：仅当作为本模块 spawn 的 Worker 被加载（workerData 携带 koffiPath）时跑
// 循环；主线程 import（host.ts）与 vitest/tinypool 的 worker 线程（workerData 无
// koffiPath）都不触发。
const workerBoot = workerData as { koffiPath?: string } | null | undefined
if (!isMainThread && parentPort && workerBoot && typeof workerBoot.koffiPath === 'string') monitorLoop()
