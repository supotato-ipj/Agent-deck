import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MediaBroker, type MediaSnapshotDTO } from '../../src/main/media/broker'
import type { MediaBridgePort, BridgeSessionSnapshot } from '../../src/main/media/bridge-client'
import { PluginAuthorizationLedger } from '../../src/main/plugins/authorization-ledger'

/**
 * 媒体 Broker（工单336，ADR-0025 媒体节 + t329 探针配方）：桥协议 fake（真桥真机验）。
 * 白名单脱敏 DTO（WinRT 概念/多余字段一律不出、字段串有界）、缩略图类型/大小校验、
 * 授权门（media.read 在账才供货，撤销即断供）、无会话/桥缺席明确态。
 */

function session(over: Partial<BridgeSessionSnapshot> = {}): BridgeSessionSnapshot {
  return {
    key: 'edge#1',
    aumid: 'Microsoft.MicrosoftEdge_8wekyb3d8bbwe!App',
    status: 'PLAYING',
    caps: { play: true, pause: true, next: true, previous: false, stop: false },
    timeline: { positionMs: 1200, endTimeMs: 40000, minSeekMs: 0, maxSeekMs: 40000, lastUpdatedTimeMs: 1_700_000_000_000 },
    media: { title: 'T336 Track', artist: 'Deck Artist', albumTitle: '', subtitle: '', genres: [], trackNumber: 1, albumTrackCount: 0, thumbPresent: true },
    ...over,
  }
}

/** 桥事件形状（与 MediaBridgePort.onEvent 一致） */
type FakeEvent = { event: string; key?: string }

/** 桥协议 fake：脚本化会话清单/缩略图/事件（Broker vitest 全覆盖的事实边界） */
function fakeBridge(opts: { sessions?: BridgeSessionSnapshot[]; currentKey?: string | null; available?: boolean } = {}): MediaBridgePort & {
  emitEvent(e: FakeEvent): void
  setSessions(sessions: BridgeSessionSnapshot[], currentKey?: string | null): void
  setAvailable(v: boolean): void
  watchCalls: boolean[]
} {
  const listeners = new Set<(e: FakeEvent) => void>()
  const downListeners = new Set<(available: boolean) => void>()
  const state: { sessions: BridgeSessionSnapshot[]; currentKey: string | null; available: boolean } = {
    sessions: opts.sessions ?? [],
    currentKey: opts.currentKey ?? (opts.sessions?.length ? opts.sessions[0].key : null),
    available: opts.available ?? true,
  }
  return {
    watchCalls: [],
    start() { /* fake 即刻就绪 */ },
    stop() { /* fake */ },
    watch(on) { this.watchCalls.push(on) },
    async list() {
      if (!state.available) return { ok: false, error: 'bridge down' }
      return { ok: true, data: { sessions: state.sessions, currentKey: state.currentKey } }
    },
    async thumb() {
      if (!state.available) return { ok: false, error: 'bridge down' }
      return { ok: true, data: { contentType: 'image/png', readBytes: 4, bytesBase64: Buffer.from([1, 2, 3, 4]).toString('base64'), ms: 1 } }
    },
    onEvent(cb) { listeners.add(cb); return () => { listeners.delete(cb) } },
    onAvailability(cb) { downListeners.add(cb); return () => { downListeners.delete(cb) } },
    emitEvent(e) { for (const l of [...listeners]) l(e) },
    setAvailable(v) { state.available = v; for (const l of [...downListeners]) l(v) },
    setSessions(sessions, currentKey) {
      state.sessions = sessions
      state.currentKey = currentKey ?? (sessions.length ? sessions[0].key : null)
    },
  }
}

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `deck-media-broker-${prefix}-`))
}

let dir: string

beforeEach(() => { dir = tmpDir('f') })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

function ledgerWith(pkgId = 'dsh-media'): PluginAuthorizationLedger {
  const led = new PluginAuthorizationLedger({
    file: path.join(dir, 'auth.json'), now: () => 1, log: () => {},
  })
  led.grant(pkgId, ['media.read'], 'hash-1')
  return led
}

function boot(bridge: MediaBridgePort, opts: { authorization?: PluginAuthorizationLedger | null } = {}) {
  const events: Record<string, unknown>[] = []
  const ledger: PluginAuthorizationLedger | null = opts.authorization === undefined ? ledgerWith() : opts.authorization
  const broker = new MediaBroker({
    bridge,
    authorization: ledger,
    audit: null,
    log: (e) => events.push(e),
    now: () => 1_700_000_000_000,
    refreshSettleMs: 1,
  })
  broker.start()
  return { broker, events, ledger }
}

describe('媒体 Broker：白名单脱敏 DTO', () => {
  it('快照 DTO 只含白名单字段（key/aumid/status/caps/timeline/media）——桥侧多余字段一律不出', async () => {
    const bridge = fakeBridge({ sessions: [session()] })
    const { broker } = boot(bridge)
    bridge.emitEvent({ event: 'session-updated', key: 'edge#1' })
    await new Promise((r) => setTimeout(r, 10))
    const snap = broker.snapshot()
    expect(snap.available).toBe(true)
    expect(snap.sessions).toHaveLength(1)
    const s = snap.sessions[0] as unknown as Record<string, unknown>
    expect(Object.keys(s).sort()).toEqual(['aumid', 'caps', 'key', 'media', 'status', 'timeline'])
    const media = s.media as unknown as Record<string, unknown>
    expect(Object.keys(media).sort()).toEqual(['albumTitle', 'albumTrackCount', 'artist', 'genres', 'subtitle', 'thumbPresent', 'title', 'trackNumber'])
    const tl = s.timeline as Record<string, unknown>
    expect(Object.keys(tl).sort()).toEqual(['endTimeMs', 'lastUpdatedTimeMs', 'maxSeekMs', 'minSeekMs', 'positionMs'])
  })

  it('字段串有界（超长 title 截断；快照序列化 ≤ snapshotBytes 上限）', async () => {
    const bridge = fakeBridge({ sessions: [session({ media: { title: 'x'.repeat(500_000), artist: 'y'.repeat(300_000), albumTitle: '', subtitle: '', genres: [], trackNumber: 1, albumTrackCount: 0, thumbPresent: false } })] })
    const { broker } = boot(bridge)
    bridge.emitEvent({ event: 'session-added' })
    await new Promise((r) => setTimeout(r, 10))
    const snap = broker.snapshot()
    expect((snap.sessions[0].media.title as string).length).toBeLessThanOrEqual(300)
    expect(JSON.stringify(snap).length).toBeLessThanOrEqual(64 * 1024)
  })

  it('status 归一到封闭词表（未知值不出原串）', async () => {
    const bridge = fakeBridge({ sessions: [session({ status: 'WEIRD_VALUE' })] })
    const { broker } = boot(bridge)
    bridge.emitEvent({ event: 'session-updated' })
    await new Promise((r) => setTimeout(r, 10))
    expect(broker.snapshot().sessions[0].status).toBe('UNKNOWN')
  })

  it('快照代次随刷新递增（插件只见代次变化，不接触桥事件名）', async () => {
    const bridge = fakeBridge({ sessions: [session()] })
    const { broker } = boot(bridge)
    bridge.emitEvent({ event: 'session-updated' })
    await new Promise((r) => setTimeout(r, 10))
    const gen1 = broker.snapshot().generation
    bridge.setSessions([session({ key: 'edge#2' })])
    bridge.emitEvent({ event: 'sessions-changed' })
    await new Promise((r) => setTimeout(r, 10))
    expect(broker.snapshot().generation).toBeGreaterThan(gen1)
    expect(broker.snapshot().sessions[0].key).toBe('edge#2')
  })
})

describe('媒体 Broker：状态面（无会话/桥缺席/默认选择）', () => {
  it('无会话 = 明确可表示状态（available + sessions 空 + selectedKey null）', async () => {
    const bridge = fakeBridge({ sessions: [] })
    const { broker } = boot(bridge)
    bridge.emitEvent({ event: 'sessions-changed' })
    await new Promise((r) => setTimeout(r, 10))
    const snap = broker.snapshot()
    expect(snap.available).toBe(true)
    expect(snap.sessions).toEqual([])
    expect(snap.selectedKey).toBeNull()
  })

  it('桥缺席 = available=false 明确态（media_unavailable 语义），恢复后回真', async () => {
    const bridge = fakeBridge({ available: false })
    const { broker, events } = boot(bridge)
    bridge.setAvailable(false)
    await new Promise((r) => setTimeout(r, 10))
    bridge.emitEvent({ event: 'sessions-changed' })
    await new Promise((r) => setTimeout(r, 10))
    expect(broker.snapshot().available).toBe(false)
    expect(events.some((e) => e.type === 'media-bridge-down')).toBe(true)
    bridge.setAvailable(true)
    bridge.setSessions([session()])
    bridge.emitEvent({ event: 'sessions-changed' })
    await new Promise((r) => setTimeout(r, 10))
    expect(broker.snapshot().available).toBe(true)
    expect(broker.snapshot().sessions).toHaveLength(1)
  })

  it('默认选择：currentKey 优先，缺省第一个会话，皆无 = null', async () => {
    const bridge = fakeBridge({ sessions: [session({ key: 'a#1' }), session({ key: 'b#1' })], currentKey: 'b#1' })
    const { broker } = boot(bridge)
    bridge.emitEvent({ event: 'session-added' })
    await new Promise((r) => setTimeout(r, 10))
    expect(broker.snapshot().selectedKey).toBe('b#1')
    bridge.setSessions([session({ key: 'a#1' }), session({ key: 'b#1' })], null)
    bridge.emitEvent({ event: 'session-updated' })
    await new Promise((r) => setTimeout(r, 10))
    expect(broker.snapshot().selectedKey).toBe('a#1')
  })
})

describe('媒体 Broker：授权门（media.read 在账才供货）', () => {
  it('获批包拿到快照；未授权包 null（宿主不投 media 段）', async () => {
    const bridge = fakeBridge({ sessions: [session()] })
    const { broker } = boot(bridge)
    bridge.emitEvent({ event: 'session-updated' })
    await new Promise((r) => setTimeout(r, 10))
    expect(broker.viewForPackage('dsh-media')).not.toBeNull()
    expect(broker.viewForPackage('no-auth-pkg')).toBeNull()
  })

  it('撤销即断供：账撤销后 viewForPackage 立即 null（授权门同步查询，零窗口）', async () => {
    const bridge = fakeBridge({ sessions: [session()] })
    const { broker, ledger } = boot(bridge)
    if (!ledger) throw new Error('boot 未装配账面')
    bridge.emitEvent({ event: 'session-updated' })
    await new Promise((r) => setTimeout(r, 10))
    expect(broker.viewForPackage('dsh-media')).not.toBeNull()
    ledger.revoke('dsh-media')
    expect(broker.viewForPackage('dsh-media')).toBeNull()
  })
})

describe('媒体 Broker：受控缩略图（类型/大小校验后交字节副本）', () => {
  it('获批包按会话键取缩略图：类型在白名单 → dataUrl 字节副本 + 审计 kind=thumbnail', async () => {
    const bridge = fakeBridge({ sessions: [session()] })
    const records: Array<{ kind: string; outcome: string }> = []
    const audit = { record: (r: { kind: string; outcome: string }) => { records.push(r) }, aggregate: () => [] } as never
    const broker = new MediaBroker({
      bridge, authorization: ledgerWith(), audit, log: () => {}, now: () => 1, refreshSettleMs: 1,
    })
    broker.start()
    bridge.emitEvent({ event: 'session-updated' })
    await new Promise((r) => setTimeout(r, 10))
    const out = await broker.thumbnailForPackage('dsh-media', 'edge#1')
    expect(out).toMatchObject({ ok: true, contentType: 'image/png' })
    if (out.ok) {
      expect(out.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
      expect(out.bytes).toBe(4)
    }
    expect(records.some((r) => r.kind === 'thumbnail' && r.outcome === 'ok')).toBe(true)
  })

  it('未授权包取缩略图 → denied 明确错误（media_permission_denied），审计 denied 在案', async () => {
    const bridge = fakeBridge({ sessions: [session()] })
    const records: Array<{ kind: string; outcome: string }> = []
    const audit = { record: (r: { kind: string; outcome: string }) => { records.push(r) }, aggregate: () => [] } as never
    const broker = new MediaBroker({
      bridge, authorization: null, audit, log: () => {}, now: () => 1, refreshSettleMs: 1,
    })
    broker.start()
    const out = await broker.thumbnailForPackage('rogue-pkg', 'edge#1')
    expect(out).toMatchObject({ ok: false, code: 'media_permission_denied' })
    expect(records[0]).toMatchObject({ kind: 'thumbnail', outcome: 'denied' })
  })

  it('类型越界（image/gif）→ media_thumbnail_rejected 拒付（一个字节不出）', async () => {
    const bridge = fakeBridge({ sessions: [session()] })
    const broker = new MediaBroker({
      bridge, authorization: ledgerWith(), audit: null, log: () => {}, now: () => 1, refreshSettleMs: 1,
    })
    broker.start()
    const rawThumb = (bridge as unknown as { thumb: () => Promise<unknown> })
    rawThumb.thumb = async () => ({ ok: true, data: { contentType: 'image/gif', readBytes: 10, bytesBase64: Buffer.alloc(10, 1).toString('base64'), ms: 1 } })
    const out = await broker.thumbnailForPackage('dsh-media', 'edge#1')
    expect(out).toMatchObject({ ok: false, code: 'media_thumbnail_rejected' })
  })

  it('大小越界（>2MB）→ media_thumbnail_rejected 拒付', async () => {
    const bridge = fakeBridge({ sessions: [session()] })
    const broker = new MediaBroker({
      bridge, authorization: ledgerWith(), audit: null, log: () => {}, now: () => 1, refreshSettleMs: 1,
    })
    broker.start()
    const big = Buffer.alloc(2 * 1024 * 1024 + 10, 1)
    const rawThumb = (bridge as unknown as { thumb: () => Promise<unknown> })
    rawThumb.thumb = async () => ({ ok: true, data: { contentType: 'image/png', readBytes: big.length, bytesBase64: big.toString('base64'), ms: 1 } })
    const out = await broker.thumbnailForPackage('dsh-media', 'edge#1')
    expect(out).toMatchObject({ ok: false, code: 'media_thumbnail_rejected' })
  })

  it('会话键失效（桥报 gone）→ media_session_gone 明确错误；桥缺席 → media_unavailable', async () => {
    const bridge = fakeBridge({ sessions: [session()] })
    const broker = new MediaBroker({
      bridge, authorization: ledgerWith(), audit: null, log: () => {}, now: () => 1, refreshSettleMs: 1,
    })
    broker.start()
    const rawThumb = (bridge as unknown as { thumb: () => Promise<unknown> })
    rawThumb.thumb = async () => ({ ok: false, error: 'session key gone: edge#1' })
    expect(await broker.thumbnailForPackage('dsh-media', 'edge#1')).toMatchObject({ ok: false, code: 'media_session_gone' })
    rawThumb.thumb = async () => ({ ok: false, error: 'bridge down' })
    expect(await broker.thumbnailForPackage('dsh-media', 'edge#1')).toMatchObject({ ok: false, code: 'media_unavailable' })
  })
})
