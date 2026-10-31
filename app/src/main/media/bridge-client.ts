import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'

/**
 * GSMTC 窄桥客户端（工单336，t329 探针配方拍板）：.NET 桥 exe（stdio JSON-lines）的
 * 主进程侧传输。桥面收敛 5 动词：list / snap / thumb / control / watch；stdout 三类行
 * （ready|fatal / result / event）。桥进程是**独立 helper**——COM/WinRT 崩溃与 Windows
 * API 漂移不进面板主进程；崩溃重启廉价（探针实测 spawn→ready 140-182ms，重启后按 list
 * 重水合）。会话键 = 桥内造的不透明键 `aumid#gen`（带代次；控制/缩略图按当下解析）。
 *
 * Vitest 不 spawn 真桥：MediaBridgePort 接口供 fake（tests/media/broker.spec.ts），真桥
 * 真机验（电池 C6）。本文件的进程边缘由 fake-child 单测覆盖行解析/关联。
 */

/** 桥侧单会话快照（原始形状；Broker 负责白名单脱敏后才出包） */
export interface BridgeSessionSnapshot {
  key: string
  aumid: string | null
  status: string
  caps: Record<string, boolean>
  timeline: Record<string, number>
  media: Record<string, unknown>
}

export interface BridgeListData {
  sessions: BridgeSessionSnapshot[]
  currentKey: string | null
}

/** 结构化回复（错误是值不是异常——桥协议对齐） */
export type BridgeReply<T = Record<string, unknown>> =
  | { ok: true; data: T }
  | { ok: false; error: string }

/** 媒体桥端口（Broker 依赖面；fake 同形状） */
export interface MediaBridgePort {
  start(): void
  stop(): void
  list(): Promise<BridgeReply<BridgeListData>>
  thumb(key: string): Promise<BridgeReply<{ contentType: string; readBytes: number; bytesBase64: string; ms: number }>>
  /** 工单337：控制命令——能力位检查+投递+真实结果复核在桥内（t329：投递 bool≠已执行，桥轮询复核） */
  control(key: string, action: string): Promise<BridgeReply>
  watch(on: boolean): void
  /** 桥事件（会话/播放/时间线变化）：只作重取快照触发器（t329：时延爆发式 17ms-6.4s） */
  onEvent(cb: (e: { event: string; key?: string; sessions?: string[] }) => void): () => void
  /** 桥可用性翻转（崩溃/退出/恢复） */
  onAvailability(cb: (available: boolean) => void): () => void
}

interface PendingRequest {
  resolve: (reply: BridgeReply) => void
  timer: NodeJS.Timeout
}

export interface MediaBridgeClientOptions {
  /** 桥 exe 绝对路径（生产 = app/resources/gsmtc-bridge/bridge.exe） */
  exePath: string
  log(event: Record<string, unknown>): void
  /** 单请求超时（ms；缺省 8s——桥内 WinRT 轮询上限 2s + 余量） */
  requestTimeoutMs?: number
  /** 崩溃重启退避（ms；缺省 500，指数 ×2 封顶 8s） */
  restartBackoffMs?: number
  /** 注入 spawn（测试 fake child；缺省 node:child_process.spawn） */
  spawnFn?: typeof spawn
}

const DEFAULT_TIMEOUT_MS = 8_000

/**
 * 真桥客户端：行缓冲解析（readline）、id 关联、崩溃重启 + list 重水合。
 * 可用性语义：进程退出 = down（pending 全拒）；ready 行 = up。
 */
export class MediaBridgeClient implements MediaBridgePort {
  private readonly opts: MediaBridgeClientOptions
  private child: ChildProcess | null = null
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private readonly eventListeners = new Set<(e: { event: string; key?: string; sessions?: string[] }) => void>()
  private readonly availabilityListeners = new Set<(available: boolean) => void>()
  private available = false
  private stopped = false
  private restartAttempts = 0

  constructor(opts: MediaBridgeClientOptions) {
    this.opts = opts
  }

  start(): void {
    this.stopped = false
    this.spawnBridge()
  }

  stop(): void {
    this.stopped = true
    this.killChild()
  }

  private killChild(): void {
    const child = this.child
    this.child = null
    if (child && child.exitCode === null && !child.killed) {
      try { child.kill() } catch { /* 尽力 */ }
    }
    this.markDown('bridge-stopped')
  }

  private markDown(reason: string): void {
    this.available = false
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.resolve({ ok: false, error: `桥不可用（${reason}）` })
    }
    this.pending.clear()
    for (const l of [...this.availabilityListeners]) l(false)
  }

  private markUp(): void {
    const wasDown = !this.available
    this.available = true
    this.restartAttempts = 0
    if (wasDown) for (const l of [...this.availabilityListeners]) l(true)
  }

  private spawnBridge(): void {
    if (this.stopped) return
    let child: ChildProcess
    try {
      const spawnFn = this.opts.spawnFn ?? spawn
      child = spawnFn(this.opts.exePath, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (err) {
      this.opts.log({ type: 'media-bridge-spawn-failed', message: err instanceof Error ? err.message : String(err) })
      this.markDown('spawn-failed')
      this.scheduleRestart()
      return
    }
    this.child = child
    child.on('error', (err) => {
      this.opts.log({ type: 'media-bridge-error', message: err.message })
      this.markDown('spawn-error')
      this.scheduleRestart()
    })
    child.on('exit', (code) => {
      if (this.child === child) this.child = null
      this.opts.log({ type: 'media-bridge-exit', code })
      this.markDown(`exit-${code ?? 'signal'}`)
      this.scheduleRestart()
    })
    // stderr 只留档（桥 fatal 走 stdout JSON 行）
    child.stderr?.on('data', (buf: Buffer) => {
      this.opts.log({ type: 'media-bridge-stderr', message: buf.toString('utf8').slice(0, 300) })
    })
    const rl = createInterface({ input: child.stdout! })
    rl.on('line', (line) => {
      const t = line.trim()
      if (!t) return
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(t) as Record<string, unknown>
      } catch {
        this.opts.log({ type: 'media-bridge-badline', message: t.slice(0, 200) })
        return
      }
      this.handleMessage(msg)
    })
    this.opts.log({ type: 'media-bridge-spawn', pid: child.pid })
  }

  private handleMessage(msg: Record<string, unknown>): void {
    const type = msg.type
    if (type === 'ready') {
      this.markUp()
      this.watch(true)
      // 重水合交给 Broker（监听 availability 翻转后拉 list）
      return
    }
    if (type === 'fatal') {
      this.opts.log({ type: 'media-bridge-fatal', message: String(msg.error ?? '') })
      return
    }
    if (type === 'event') {
      const e = { event: String(msg.event ?? ''), key: typeof msg.key === 'string' ? msg.key : undefined, sessions: Array.isArray(msg.sessions) ? (msg.sessions as string[]) : undefined }
      for (const l of [...this.eventListeners]) l(e)
      return
    }
    if (type === 'result') {
      // 桥侧 id 是字符串（探针 C#5 Esc(id) 输出）——两端口径都以数字关联
      const rawId = typeof msg.id === 'string' ? Number(msg.id) : msg.id
      const id = typeof rawId === 'number' && Number.isFinite(rawId) ? rawId : -1
      const pending = this.pending.get(id)
      if (!pending) return
      this.pending.delete(id)
      clearTimeout(pending.timer)
      if (msg.ok === true) pending.resolve({ ok: true, data: (msg.data ?? {}) as Record<string, unknown> })
      else pending.resolve({ ok: false, error: String(msg.error ?? 'bridge error') })
    }
  }

  private scheduleRestart(): void {
    if (this.stopped) return
    const delay = Math.min((this.opts.restartBackoffMs ?? 500) * 2 ** this.restartAttempts, 8_000)
    this.restartAttempts += 1
    setTimeout(() => this.spawnBridge(), delay)
  }

  private async request(cmd: Record<string, unknown>): Promise<BridgeReply> {
    const child = this.child
    if (!child || !this.available || !child.stdin || child.stdin.destroyed) {
      return { ok: false, error: '桥不可用（未就绪）' }
    }
    const id = this.nextId++
    const payload = JSON.stringify({ id, ...cmd })
    const reply = new Promise<BridgeReply>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ ok: false, error: `桥请求超时（${this.opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS}ms）` })
      }, this.opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS)
      this.pending.set(id, { resolve, timer })
    })
    child.stdin.write(payload + '\n')
    return reply
  }

  async list(): Promise<BridgeReply<BridgeListData>> {
    const out = await this.request({ cmd: 'list' })
    if (!out.ok) return out
    const data = out.data as { sessions?: unknown; currentKey?: unknown }
    if (!Array.isArray(data.sessions)) return { ok: false, error: '桥 list 回复形状不符' }
    return {
      ok: true,
      data: {
        sessions: data.sessions as BridgeSessionSnapshot[],
        currentKey: typeof data.currentKey === 'string' ? data.currentKey : null,
      },
    }
  }

  async thumb(key: string): Promise<BridgeReply<{ contentType: string; readBytes: number; bytesBase64: string; ms: number }>> {
    const out = await this.request({ cmd: 'thumb', key })
    if (!out.ok) return out
    return { ok: true, data: out.data as { contentType: string; readBytes: number; bytesBase64: string; ms: number } }
  }

  /** 工单337：控制命令（能力位检查/投递/结果复核都在桥内；result.data.status=复核后的真实播放态） */
  async control(key: string, action: string): Promise<BridgeReply<{ status?: string }>> {
    const out = await this.request({ cmd: 'control', key, action })
    if (!out.ok) return out
    return { ok: true, data: out.data as { status?: string } }
  }

  watch(on: boolean): void {
    void this.request({ cmd: 'watch', on })
  }

  onEvent(cb: (e: { event: string; key?: string; sessions?: string[] }) => void): () => void {
    this.eventListeners.add(cb)
    return () => { this.eventListeners.delete(cb) }
  }

  onAvailability(cb: (available: boolean) => void): () => void {
    this.availabilityListeners.add(cb)
    return () => { this.availabilityListeners.delete(cb) }
  }
}
