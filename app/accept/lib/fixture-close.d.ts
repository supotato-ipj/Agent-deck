// 夹具窗清扫（工单486）的类型声明：fixture-close.js 是 CJS 模块（依赖 koffi 的 win32 单例），
// 本声明服务 accept 调用点与 tests/accept/fixture-close.spec.ts 的类型检查。

/** 夹具账目：spawn 别名应用（notepad/mspaint）与追认到的窗/宿主进程 */
export declare interface FixtureHandle {
  /** 窗口匹配用：宿主 exe 名前缀（小写，如 'notepad'/'mspaint'） */
  exeBase: string
  /** 可选的窗口类名等价匹配（如 'Notepad'） */
  windowClass: string
  /** spawn 返回的子进程（打包版下是秒退的存根；非分裂模型下就是宿主） */
  child: { pid: number; killed?: boolean } & Record<string, unknown>
  /** 追认到的夹具窗句柄（启动期未出窗为 0） */
  hwnd: number | 0
  /** 夹具窗宿主进程 pid（未追认为 0） */
  hostPid: number | 0
  /** spawn 前的全量顶层窗集合（认领纪律：只认 preSet 之外的新窗） */
  preSet: Set<unknown>
  spawnedAt: number
  /** 追认失败的原因注记（多扇新窗无法唯一认领时） */
  attachNote?: string
}

/** closeFixture 的清扫结论（供调用点注记/断言） */
export declare interface FixtureCloseOutcome {
  /** 窗与进程均不再存活 */
  closed: boolean
  /** 是否动用了强杀兜底（优雅关闭失灵） */
  forced: boolean
  hostPid: number
  windowStill: boolean
  hostAlive: boolean
  notes: string[]
}

export declare interface FixtureCloseDeps {
  win32?: Record<string, unknown>
  spawnFn?: (...args: unknown[]) => unknown
  sleep?: (ms: number) => Promise<void>
  pidAlive?: (pid: number) => boolean
  graceMs?: number
  killWaitMs?: number
}

export declare function launchAppFixture(
  opts?: { exe?: string; windowClass?: string; timeoutMs?: number },
  deps?: Record<string, unknown>,
): Promise<FixtureHandle>

export declare function attachFixtureWindow(
  fixture: FixtureHandle,
  opts?: { timeoutMs?: number },
  deps?: Record<string, unknown>,
): Promise<boolean>

/** 夹具清扫 API（createFixtureClose 的产物 / fixtureClose 默认实例） */
export declare interface FixtureCloseApi {
  /** 优雅关闭→有界等→宿主 pid 强杀兜底；结论供调用点注记/断言 */
  close(fixture?: Partial<FixtureHandle>): Promise<FixtureCloseOutcome>
}

export declare function createFixtureClose(deps?: FixtureCloseDeps): FixtureCloseApi

export declare const fixtureClose: FixtureCloseApi
