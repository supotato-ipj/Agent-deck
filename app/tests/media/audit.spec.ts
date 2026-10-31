import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MediaAuditService } from '../../src/main/media/audit'

/**
 * 媒体审计（工单336，ADR-0025）：完整存取记录按包+权限+时间窗聚合（不含任何媒体元数据）；
 * 完整记录仅可信 UI 可见（独立 JSONL，与控制面审计 DECK_EVENT_LOG 分离），保留 90 天。
 */

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `deck-media-audit-${prefix}-`))
}

let dir: string
let file: string

const NOW = 1_700_000_000_000
const HOUR = 3_600_000

beforeEach(() => {
  dir = tmpDir('f')
  file = path.join(dir, 'media-audit.jsonl')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function boot(now = () => NOW): MediaAuditService & { events: Record<string, unknown>[] } {
  const events: Record<string, unknown>[] = []
  const svc = new MediaAuditService({ file, now, log: (e) => events.push(e) })
  return Object.assign(svc, { events })
}

describe('媒体审计：聚合键 = 包+权限+时间窗', () => {
  it('同包同权限同窗多次读取聚合一桶（计数按 kind 分列）', () => {
    const svc = boot()
    svc.record({ packageId: 'dsh-media', permission: 'media.read', kind: 'snapshot', outcome: 'ok' })
    svc.record({ packageId: 'dsh-media', permission: 'media.read', kind: 'snapshot', outcome: 'ok' })
    svc.record({ packageId: 'dsh-media', permission: 'media.read', kind: 'thumbnail', outcome: 'ok' })
    const buckets = svc.aggregate()
    expect(buckets).toHaveLength(1)
    expect(buckets[0]).toMatchObject({
      packageId: 'dsh-media', permission: 'media.read',
      counts: { snapshot: 2, thumbnail: 1 }, denied: 0,
    })
    expect(buckets[0].windowMs).toBe(HOUR)
    expect(NOW - buckets[0].windowStart).toBeLessThan(HOUR)
  })

  it('不同包/不同窗分桶（时间窗推进即新桶）', () => {
    let t = NOW
    const svc = boot(() => t)
    svc.record({ packageId: 'a', permission: 'media.read', kind: 'snapshot', outcome: 'ok' })
    svc.record({ packageId: 'b', permission: 'media.read', kind: 'snapshot', outcome: 'ok' })
    t = NOW + HOUR + 1
    svc.record({ packageId: 'a', permission: 'media.read', kind: 'snapshot', outcome: 'ok' })
    const buckets = svc.aggregate()
    expect(buckets).toHaveLength(3)
  })

  it('被拒/不可用的读取也进账（denied 计数）——审计对失败读取不静默', () => {
    const svc = boot()
    svc.record({ packageId: 'dsh-media', permission: 'media.read', kind: 'snapshot', outcome: 'denied' })
    svc.record({ packageId: 'dsh-media', permission: 'media.read', kind: 'thumbnail', outcome: 'unavailable' })
    const buckets = svc.aggregate()
    expect(buckets[0].denied).toBe(2)
    expect(buckets[0].counts.snapshot).toBe(0)
  })

  it('聚合不含媒体元数据（桶形状只有计数与键，无 title/artist/key 级内容）', () => {
    const svc = boot()
    svc.record({ packageId: 'dsh-media', permission: 'media.read', kind: 'snapshot', sessionKey: 'edge#1', outcome: 'ok' })
    const raw = JSON.stringify(svc.aggregate())
    expect(raw).not.toContain('sessionKey')
    expect(raw).not.toContain('edge#1')
    expect(raw).not.toContain('title')
  })

  it('每笔读取落聚合事件（DECK_EVENT_LOG 权限审计族出口，含桶形状）', () => {
    const svc = boot()
    svc.record({ packageId: 'dsh-media', permission: 'media.read', kind: 'snapshot', outcome: 'ok' })
    const evt = svc.events.find((e) => e.type === 'media-audit-aggregate')
    expect(evt).toMatchObject({ packageId: 'dsh-media', permission: 'media.read', counts: { snapshot: 1, thumbnail: 0 } })
  })
})

describe('媒体审计：完整记录落盘与 90 天保留', () => {
  it('完整记录写独立 JSONL（含包/权限/kind/结果/时刻；与控制面审计分离的事实文件）', () => {
    const svc = boot()
    svc.record({ packageId: 'dsh-media', permission: 'media.read', kind: 'snapshot', sessionKey: 'edge#1', outcome: 'ok' })
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toMatchObject({
      packageId: 'dsh-media', permission: 'media.read', kind: 'snapshot', outcome: 'ok',
    })
  })

  it('载入时修剪 >90 天旧行（保留窗口硬约束；修剪落事件）', () => {
    const old = NOW - 91 * 24 * HOUR
    const recent = NOW - 1 * HOUR
    fs.writeFileSync(file, [
      JSON.stringify({ at: old, packageId: 'old-pkg', permission: 'media.read', kind: 'snapshot', outcome: 'ok' }),
      JSON.stringify({ at: recent, packageId: 'new-pkg', permission: 'media.read', kind: 'snapshot', outcome: 'ok' }),
    ].join('\n') + '\n', 'utf8')
    const svc = boot()
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]).packageId).toBe('new-pkg')
    // 聚合也不再含 90 天外的旧桶
    expect(svc.aggregate().some((b) => b.packageId === 'old-pkg')).toBe(false)
  })

  it('跨重启重载：旧记录仍在保留窗内 → 聚合延续（审计不随进程断档）', () => {
    const first = boot()
    first.record({ packageId: 'dsh-media', permission: 'media.read', kind: 'thumbnail', outcome: 'ok' })
    const reborn = boot()
    expect(reborn.aggregate()[0].counts.thumbnail).toBe(1)
  })

  it('坏行跳过（不抛异常、不污染聚合）', () => {
    fs.writeFileSync(file, '{ broken json\n', 'utf8')
    const svc = boot()
    expect(svc.aggregate()).toHaveLength(0)
    svc.record({ packageId: 'a', permission: 'media.read', kind: 'snapshot', outcome: 'ok' })
    expect(svc.aggregate()).toHaveLength(1)
  })
})
