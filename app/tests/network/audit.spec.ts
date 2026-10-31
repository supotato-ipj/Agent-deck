// 网络审计（工单338）：两层账——完整记录 JSONL（仅可信 UI）+ 聚合桶（可投影面）。
// 脱敏红线：只有 origin/方法/结果码/状态/重定向目标，无头、无正文、无 query。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NetworkAuditService } from '../../src/main/network/audit'

let dir: string
let file: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-net-audit-'))
  file = path.join(dir, 'network-audit.jsonl')
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

function service(events: Record<string, unknown>[] = [], now = () => 1_000) {
  return new NetworkAuditService({ file, now, log: (e) => { events.push(e) } })
}

describe('网络审计两层账（工单338）', () => {
  it('逐笔落 JSONL + 聚合桶按包/权限/窗口计数，并发 network-audit-aggregate 事件', () => {
    const events: Record<string, unknown>[] = []
    const audit = service(events)
    audit.record({ packageId: 'pkg-net', origin: 'http://127.0.0.1:1', method: 'GET', outcome: 'ok', status: 200 })
    const bucket = audit.record({ packageId: 'pkg-net', origin: 'http://127.0.0.1:1', method: 'POST', outcome: 'ok', status: 201 })
    expect(bucket.counts.request).toBe(2)
    expect(bucket.denied).toBe(0)
    expect(bucket.origins).toEqual(['http://127.0.0.1:1'])
    const agg = events.filter((e) => e.type === 'network-audit-aggregate')
    expect(agg).toHaveLength(2)
    expect(agg[1]).toMatchObject({ packageId: 'pkg-net', permission: 'network.request', counts: { request: 2 } })
    // 事件里没有 origin 路径/正文位置以外的东西——只有聚合形状
    expect(JSON.stringify(agg[1])).not.toContain('http://127.0.0.1:1/api')
  })

  it('拒绝与重定向分列：denied 计数 vs redirect 计数（互不混账）', () => {
    const audit = service()
    audit.record({ packageId: 'pkg-net', origin: 'http://a.test', method: 'GET', outcome: 'denied', code: 'network_permission_denied' })
    audit.record({ packageId: 'pkg-net', origin: 'http://a.test', method: 'GET', outcome: 'error', code: 'network_redirect_blocked', status: 302, redirectTo: 'http://b.test' })
    const [bucket] = audit.aggregate()
    expect(bucket).toMatchObject({ counts: { request: 0, redirect: 1 }, denied: 1, origins: ['http://a.test'] })
  })

  it('跨重启重载：完整记录在案，超保留窗行载入即修剪', () => {
    const old = new NetworkAuditService({ file, now: () => 1, log: () => {} })
    old.record({ packageId: 'pkg-old', origin: 'http://a.test', method: 'GET', outcome: 'ok', status: 200 })
    const DAY = 24 * 3_600_000
    const later = new NetworkAuditService({ file, now: () => 1 + 91 * DAY, log: () => {} })
    expect(later.aggregate()).toHaveLength(0)
    expect(fs.readFileSync(file, 'utf8').trim()).toBe('')
    // 保留期内保留
    const kept = new NetworkAuditService({ file, now: () => 1 + 89 * DAY, log: () => {} })
    kept.record({ packageId: 'pkg-new', origin: 'http://a.test', method: 'GET', outcome: 'ok', status: 200 })
    expect(kept.aggregate()).toHaveLength(1)
  })

  it('坏行跳过（账不因单行损坏整份失效）', () => {
    fs.writeFileSync(file, '{"at":1,"packageId":"p","permission":"network.request","kind":"request","origin":"http://a","method":"GET","outcome":"ok"}\nnot-json\n', 'utf8')
    const audit = service()
    expect(audit.aggregate()).toHaveLength(1)
  })
})
