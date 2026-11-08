/**
 * 托盘自有图标对账测试（工单437）：纯状态机缝——事件订阅/pid 判定/重注动作全注入，
 * 假时钟驱动。口径取自取证定谳（.scratch/issue437-rounds/forensics-notes.md）：
 * 健康定律 = 每次宿主 ready 后自家应答（add/update）0.1-2.5s 到达，健康轮零重注；
 * miss 路径 = 等待窗耗尽无应答 → recreate；坏态粘住 = 连续重注触顶后转降频兜底。
 */
import { describe, expect, it } from 'vitest'
import { startTrayOwnReconcile } from '../src/main/tray-own-reconcile'

interface Harness {
  reinjections: number[]
  logs: { type: string; attempt: number }[]
  /** 推进时钟并跑完当拍对账（含定时器触发的拍） */
  advance: (ms: number) => void
  hostReady: () => void
  hostStopped: () => void
  ownEvent: (kind?: string) => void
  otherEvent: () => void
  dispose: () => void
}

const OWN_PID = 4242
const OTHER_PID = 1111
const INTERVAL = 3000
const SETTLE = 5000

function makeHarness(options: { maxConsecutive?: number; backoffMs?: number } = {}): Harness {
  let t = 0
  const reinjections: number[] = []
  const logs: { type: string; attempt: number }[] = []
  let eventCb: ((e: { kind: string; hwnd: string }) => void) | null = null
  let hostCb: ((e: { type: string }) => void) | null = null
  let tick: (() => void) | null = null
  const h: Harness = {
    reinjections,
    logs,
    advance: (ms) => { t += ms; tick?.() },
    hostReady: () => hostCb?.({ type: 'tray-host-ready' }),
    hostStopped: () => hostCb?.({ type: 'tray-host-stopped' }),
    ownEvent: (kind = 'add') => eventCb?.({ kind, hwnd: '777' }),
    otherEvent: () => eventCb?.({ kind: 'add', hwnd: '888' }),
    dispose: () => {},
  }
  h.dispose = startTrayOwnReconcile({
    subscribeTrayEvent: (cb) => { eventCb = cb; return () => { eventCb = null } },
    subscribeTrayHost: (cb) => { hostCb = cb; return () => { hostCb = null } },
    windowPidOf: (hwnd) => (hwnd === '777' ? OWN_PID : OTHER_PID),
    ownPid: OWN_PID,
    reinject: () => { reinjections.push(t) },
    log: (e) => logs.push(e),
    now: () => t,
    schedule: (fn) => { tick = fn; return 1 },
    cancel: () => { tick = null },
  }, { intervalMs: INTERVAL, settleMs: SETTLE, maxConsecutive: options.maxConsecutive ?? 3, backoffMs: options.backoffMs ?? 30000 })
  return h
}

describe('tray-own-reconcile 健康路径（零增量）', () => {
  it('宿主 ready 后自家应答在等待窗内到达——不重注不存证', () => {
    const h = makeHarness()
    h.hostReady()
    h.advance(1000)
    h.ownEvent('add')
    h.advance(60000)
    expect(h.reinjections).toEqual([])
    expect(h.logs).toEqual([])
  })

  it('他者图标的事件不构成自家应答证据', () => {
    const h = makeHarness()
    h.hostReady()
    h.advance(1000)
    h.otherEvent()
    h.advance(INTERVAL + SETTLE)
    expect(h.reinjections.length).toBeGreaterThan(0)
  })

  it('delete/version 事件不算应答（只有 add/update 是证据）', () => {
    const h = makeHarness()
    h.hostReady()
    h.advance(1000)
    h.ownEvent('delete')
    h.ownEvent('version')
    h.advance(INTERVAL + SETTLE)
    expect(h.reinjections.length).toBeGreaterThan(0)
  })
})

describe('tray-own-reconcile miss 路径', () => {
  it('等待窗耗尽无应答 → 一拍重注 → 应答到达即 recovered 复位', () => {
    const h = makeHarness()
    h.hostReady()
    h.advance(INTERVAL + SETTLE) // 首拍判 miss（ready 后 8s）
    expect(h.reinjections).toEqual([INTERVAL + SETTLE])
    expect(h.logs).toEqual([{ type: 'tray-own-reinject', attempt: 1 }])
    h.advance(1000)
    h.ownEvent('add') // 新 Tray 的应答到达
    expect(h.logs[1]).toEqual({ type: 'tray-own-reinject-recovered', attempt: 1 })
    h.advance(120000)
    expect(h.reinjections).toHaveLength(1) // 复位后不再动手
  })

  it('重注后仍未应答 → 逐拍续注；禁用态（stopped）整环静默', () => {
    const h = makeHarness()
    h.hostReady()
    h.advance(INTERVAL + SETTLE)
    h.advance(INTERVAL + SETTLE)
    h.advance(INTERVAL + SETTLE)
    expect(h.reinjections).toHaveLength(3)
    h.hostStopped()
    const at = h.reinjections.length
    h.advance(300000)
    expect(h.reinjections).toHaveLength(at) // 宿主不在场不对账
  })

  it('连续重注触顶后转降频兜底（backoffMs 内不再动手，越线续拍）', () => {
    const h = makeHarness({ maxConsecutive: 3, backoffMs: 30000 })
    h.hostReady()
    for (let i = 0; i < 3; i++) h.advance(INTERVAL + SETTLE)
    expect(h.reinjections).toHaveLength(3)
    h.advance(5000) // 触顶后 5s：backoff 窗内，静默
    expect(h.reinjections).toHaveLength(3)
    h.advance(26000) // 距上次重注 31s：兜底续拍
    expect(h.reinjections).toHaveLength(4)
  })

  it('宿主 ready 重开等待窗：旧应答位作废，miss 从新窗起算', () => {
    const h = makeHarness()
    h.hostReady()
    h.advance(1000)
    h.ownEvent('add') // 上一届宿主里应答过
    h.hostReady() // 宿主重建（P11 同款）：旧登记作废，自家须重新应答
    h.advance(INTERVAL + SETTLE)
    expect(h.reinjections).toHaveLength(1) // 未重新应答 → 判 miss
  })
})
