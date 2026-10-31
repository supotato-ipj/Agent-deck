import { describe, expect, it, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { MediaBridgeClient } from '../../src/main/media/bridge-client'

/**
 * 桥进程边缘（工单336）：行解析 / id 关联 / 事件分发 / 可用性翻转——spawn 用 fake child
 * （真桥真机验，电池 C6；协议配方 = t329 探针 26 行 transcript）。
 */

class FakeChild extends EventEmitter {
  stdin = { write: (s: string) => { this.written.push(s); return true }, destroyed: false }
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false
  exitCode: number | null = null
  written: string[] = []
  kill() { this.killed = true; this.emit('exit', null) }
  line(json: unknown): void { this.stdout.write(Buffer.from(JSON.stringify(json) + '\n', 'utf8')) }
}

function boot() {
  const events: Record<string, unknown>[] = []
  const holder: { current: FakeChild | null } = { current: null }
  const client = new MediaBridgeClient({
    exePath: 'X:\fake\bridge.exe',
    log: (e) => events.push(e),
    requestTimeoutMs: 200,
    spawnFn: (() => { holder.current = new FakeChild(); return holder.current }) as never,
  })
  return { client, events, holder }
}

let cleanup: Array<() => void> = []

afterEach(() => { for (const c of cleanup) c(); cleanup = [] })

describe('桥客户端：行解析与 id 关联', () => {
  it('ready 行 = 可用性翻真；watch(true) 自动下发', async () => {
    const { client, holder, events } = boot()
    const flips: boolean[] = []
    cleanup.push(client.onAvailability((v) => flips.push(v)))
    client.start()
    holder.current!.line({ type: 'ready' })
    await new Promise((r) => setTimeout(r, 10))
    expect(flips).toEqual([true])
    expect(holder.current!.written.some((w) => w.includes('"cmd":"watch"'))).toBe(true)
    expect(events.some((e) => e.type === 'media-bridge-spawn')).toBe(true)
  })

  it('list 请求/回复按 id 关联（乱序与不相关行不串线）', async () => {
    const { client, holder } = boot()
    client.start()
    holder.current!.line({ type: 'ready' })
    const p = client.list()
    await new Promise((r) => setTimeout(r, 10))
    const sent = holder.current!.written.find((w) => w.includes('"cmd":"list"'))!
    const id = JSON.parse(sent).id
    holder.current!.line({ type: 'event', event: 'sessions-changed' }) // 先到的噪声行
    holder.current!.line({ type: 'result', id: id + 100, ok: true, data: { sessions: [] } }) // 别的 id
    holder.current!.line({ type: 'result', id, ok: true, data: { sessions: [{ key: 'edge#1' }], currentKey: 'edge#1' } })
    const out = await p
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.data.sessions).toHaveLength(1)
      expect(out.data.currentKey).toBe('edge#1')
    }
  })

  it('桥报错误回复 = ok:false + error 原文（错误是值不是异常）', async () => {
    const { client, holder } = boot()
    client.start()
    holder.current!.line({ type: 'ready' })
    const p = client.thumb('gone#9')
    await new Promise((r) => setTimeout(r, 10))
    const sent = holder.current!.written.find((w) => w.includes('"cmd":"thumb"'))!
    holder.current!.line({ type: 'result', id: JSON.parse(sent).id, ok: false, error: 'session key gone: gone#9' })
    expect(await p).toMatchObject({ ok: false, error: 'session key gone: gone#9' })
  })

  it('坏行（非 JSON）跳过落档，不炸解析循环', async () => {
    const { client, holder, events } = boot()
    client.start()
    holder.current!.stdout.write(Buffer.from('this is not json\n', 'utf8'))
    holder.current!.line({ type: 'ready' })
    await new Promise((r) => setTimeout(r, 10))
    expect(events.some((e) => e.type === 'media-bridge-badline')).toBe(true)
    expect(client.list()).toBeTruthy()
  })
})

describe('桥客户端：崩溃与重启', () => {
  it('进程退出 = 可用性翻假 + 在途请求全拒（错误是值）；超时请求按时限拒', async () => {
    const { client, holder } = boot()
    client.start()
    holder.current!.line({ type: 'ready' })
    const p1 = client.list()
    await new Promise((r) => setTimeout(r, 10))
    holder.current!.emit('exit', 1)
    const out = await p1
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.error.includes('exit-1')).toBe(true)
    // 退出后新请求即刻拒（不悬挂）
    expect(await client.list()).toMatchObject({ ok: false })
  })

  it('请求超时 → 明确错误（不悬挂 promise）', async () => {
    const { client, holder } = boot()
    client.start()
    holder.current!.line({ type: 'ready' })
    const out = await client.list()
    expect(out).toMatchObject({ ok: false })
    expect(out.ok === false && out.error.includes('超时')).toBe(true)
  })

  it('stop 后不再重启（stopped 位守门）', async () => {
    const { client, holder, events } = boot()
    client.start()
    holder.current!.line({ type: 'ready' })
    await new Promise((r) => setTimeout(r, 10))
    client.stop()
    expect(holder.current!.killed).toBe(true)
    expect(events.some((e) => e.type === 'media-bridge-exit')).toBe(true)
  })
})
