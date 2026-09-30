import { spawn } from 'node:child_process'
import { Service } from 'cordis'
import type { Context } from 'cordis'
import type { SearchUiState } from '../../shared/contract'
import {
  BASE_PORT,
  DEFAULT_LIMIT,
  Debouncer,
  EVERYTHING_DEFAULT_PORT,
  OFFLINE_RETRY_MS,
  backoffDelay,
  classifyFailure,
  parseResponse,
  type SearchEngineChoice,
  type SearchResults,
} from '../search/engine'
import { createEngineSearch } from '../search/selector'
import { shellOpen } from '../desktop/adapter'

/** 搜索承载依赖束：主进程真源 / 测试假源共用一个服务状态机（desktop/hardware 同法） */
export interface SearchDeps {
  /** 搜索引擎查询 I/O（真源 = selector.createEngineSearch 装配；测试假源注入） */
  search(query: string, limit: number, offset: number): Promise<unknown>
  /** Enter 打开（'' = 成功；desktop/launch 同源语义） */
  open(path: string): Promise<string>
  /** Ctrl+Enter 资源管理器定位（fire-and-forget；explorer 自带窗口生命周期） */
  reveal(path: string): void
  /** 单调时钟（防抖/退避判定；测试注入合成时间） */
  now(): number
}

/** Ctrl+Enter 资源管理器定位真源（Python 先例同形：explorer /select,<path>）。
 * 不带 windowsHide——它经 STARTUPINFO 传 SW_HIDE，会把 explorer 的文件夹窗口一起藏掉
 * （电池实测：reveal ok=true 但 CabinetWClass 永不出现）；GUI 应用无控制台可闪。 */
function defaultReveal(path: string): void {
  try {
    spawn('explorer', ['/select,', path], { stdio: 'ignore' })
  } catch {
    // 定位失败静默：explorer 缺席属环境异常，不打断面板
  }
}

export interface SearchServiceOptions {
  /** Listary 本地 API 端口（config.json search.port 下发；默认 38431） */
  port?: number
  /** 搜索引擎（config.json search.engine 下发；工单13 显式锁定，auto 过渡期回落 listary） */
  engine?: SearchEngineChoice
  /** Everything http_server 插件端口（config.json search.everythingPort 下发；默认 80） */
  everythingPort?: number
  /** 单页结果数（旧引擎 DEFAULT_LIMIT 先例） */
  limit?: number
  deps?: Partial<SearchDeps>
}

/**
 * 搜索服务（工单07）：待机/活动机器态 + 引擎链路策略全部收口在内核——
 * 渲染层喂词（search/query），这里防抖 ~200ms 后直连本地搜索引擎
 * （Listary/Everything 经选择器装配，渲染层永不直连），结果经 search/results
 * 事件回推；连接失败推引擎离线态并每 3s 静默重试，限流按退避曲线静默重发，
 * 引擎在线但行为异常不冒充离线也不重试。
 * Enter/Ctrl+Enter 动作由内核执行，path 护栏 = 最近一次结果集成员。
 * 查询词只发往本机搜索引擎 API，不落任何盘（ADR-0002 精神；隐私守卫测试盯源码与行为）。
 */
export class SearchService extends Service {
  private readonly port: number
  private readonly limit: number
  private readonly deps: SearchDeps
  /** 机器态（PanelStateMachine 移植）：待机 ⇄ 活动；offline 是活动态的派生显示 */
  private machine: 'idle' | 'active' = 'idle'
  private offlineShown = false
  private query = ''
  private readonly debouncer = new Debouncer()
  /** 单飞行代际：新查询/退待机作废旧响应（旧 _search_gen 语义） */
  private gen = 0
  private rateAttempt = 0
  private retryAt: number | null = null
  private lastResults: SearchResults | null = null
  /** 已推送的派生态：初值 idle（服务以待机出生，无需开机推送） */
  private pushed: SearchUiState | null = 'idle'

  constructor(ctx: Context, options: SearchServiceOptions = {}) {
    super(ctx, 'search')
    this.port = options.port ?? BASE_PORT
    this.limit = options.limit ?? DEFAULT_LIMIT
    // 默认查询真源 = 引擎选择器装配（工单13）；服务状态机保持引擎无感
    const engineSearch = createEngineSearch({
      engine: options.engine ?? 'listary',
      listaryPort: this.port,
      everythingPort: options.everythingPort ?? EVERYTHING_DEFAULT_PORT,
    })
    this.deps = {
      search: options.deps?.search ?? engineSearch,
      open: options.deps?.open ?? shellOpen,
      reveal: options.deps?.reveal ?? defaultReveal,
      now: options.deps?.now ?? (() => performance.now()),
    }
    ctx.on('dispose', () => {
      this.gen += 1 // 内核拆卸：在途响应作废
    })
  }

  /** 点击热区激活：待机 → 活动；活动态重复激活幂等（渲染层只重摆光标） */
  activate(): SearchUiState {
    if (this.machine === 'idle') {
      this.machine = 'active'
      this.query = ''
      this.pushState()
    }
    return this.derivedState()
  }

  /** ESC/失焦退回待机：清查询词、作废在途响应、清退避与离线显示——下次激活从空查询开始
   * （离线徽标只在真实查询失败后出现，不跨激活残留——旧面板语义） */
  deactivate(): SearchUiState {
    this.machine = 'idle'
    this.gen += 1
    this.debouncer.reset()
    this.rateAttempt = 0
    this.retryAt = null
    this.query = ''
    this.lastResults = null
    this.offlineShown = false
    this.pushState()
    return this.derivedState()
  }

  /** 渲染层喂词（每次 input 事件一发）；空查询取消在途。返回是否被接受 */
  setQuery(text: string): boolean {
    if (this.machine !== 'active') return false
    this.query = text
    this.debouncer.feed(text, this.deps.now())
    if (!text) this.lastResults = null // 空查询：动作无结果可依
    return true
  }

  /** 引擎链路泵（生产 50ms 定时驱动，kernel searchPumpMs；测试合成时钟手动驱动） */
  tick(now: number = this.deps.now()): void {
    if (this.machine !== 'active') return
    if (this.retryAt !== null && now >= this.retryAt) {
      this.retryAt = null
      this.debouncer.feedDue(this.query) // 重试 = 立即重发同词
    }
    const due = this.debouncer.due(now)
    if (due !== null) void this.runSearch(due)
  }

  /** Enter 打开（reveal=false）/ Ctrl+Enter 资源管理器定位（reveal=true） */
  async action(path: string, reveal: boolean): Promise<{ ok: boolean; error?: string }> {
    if (!this.lastResults?.items.some((i) => i.path === path)) {
      return { ok: false, error: '动作路径不在最近一次搜索结果内' }
    }
    if (reveal) {
      this.deps.reveal(path)
      return { ok: true }
    }
    const error = await this.deps.open(path)
    return error ? { ok: false, error } : { ok: true }
  }

  /** 测试观察缝：派生态 */
  stateForTest(): SearchUiState {
    return this.derivedState()
  }

  private derivedState(): SearchUiState {
    if (this.machine === 'idle') return 'idle'
    return this.offlineShown ? 'offline' : 'active'
  }

  private pushState(): void {
    const state = this.derivedState()
    if (state === this.pushed) return
    this.pushed = state
    this.ctx.emit('search/state', { state })
  }

  private stale(myGen: number): boolean {
    return myGen !== this.gen || this.machine !== 'active'
  }

  private async runSearch(query: string): Promise<void> {
    const myGen = ++this.gen
    let payload: unknown
    try {
      payload = await this.deps.search(query, this.limit, 0)
    } catch (failure) {
      this.onFailure(myGen, failure)
      return
    }
    this.onPayload(myGen, payload)
  }

  private onPayload(myGen: number, payload: unknown): void {
    if (this.stale(myGen)) return
    const kind = classifyFailure(payload)
    if (kind === null) {
      this.rateAttempt = 0
      this.offlineShown = false
      this.retryAt = null
      this.lastResults = parseResponse(payload)
      this.pushState()
      this.ctx.emit('search/results', { total: this.lastResults.total, items: this.lastResults.items })
    } else if (kind === 'rate_limited') {
      // 限流静默退避：保持现有展示，按退避曲线重试当前词（spec：TOO_MANY_REQUESTS 静默退避）
      this.rateAttempt += 1
      this.retryAt = this.deps.now() + backoffDelay(this.rateAttempt)
    } else if (kind === 'offline') {
      this.enterOffline()
    } else {
      // 引擎在线但响应异常：不冒充离线也不自动重试，等下次输入
      console.warn('deck-search: 引擎响应异常，等下次输入')
    }
  }

  private onFailure(myGen: number, failure: unknown): void {
    if (this.stale(myGen)) return
    if (classifyFailure(failure) === 'offline') this.enterOffline()
    else console.warn('deck-search: 引擎请求异常，等下次输入')
  }

  private enterOffline(): void {
    if (!this.offlineShown) {
      this.offlineShown = true
      this.pushState()
    }
    this.retryAt = this.deps.now() + OFFLINE_RETRY_MS
  }
}
