/**
 * Agent 会话预览服务（工单381，spec #369 决策 20-24/27）：只读投影的打开/1Hz 刷新/收起、
 * 锚点不在场拒绝展开、单工具失败隔离、日志不含对话标题。deps 全假源，零 Electron/FFI。
 */
import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context } from 'cordis'
import { SessionPreviewService, readPreviewRows } from '../../src/main/session-preview/service'
import type { SessionPreviewServiceDeps } from '../../src/main/session-preview/service'
import type { SessionPreviewState } from '../../src/shared/contract'
import { MinimaxFx, QoderFx, rec } from '../scanners/fixtures'

interface Harness {
  svc: SessionPreviewService
  ctx: Context
  states: SessionPreviewState[]
  log: Array<Record<string, unknown>>
  available: { value: boolean }
  nowMs: { value: number }
  builds: { value: number }
}

function harness(depsOver: Partial<SessionPreviewServiceDeps> = {}, rootsOver: Record<string, string> = {}): Harness {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-spsvc-'))
  const qoder = new QoderFx(path.join(tmp, 'qoder'))
  qoder.now = Date.now() / 1000
  qoder.addSession('q-probe', 5, [rec('assistant', 'tool', 'D:/work/alpha')])
  const states: SessionPreviewState[] = []
  const log: Array<Record<string, unknown>> = []
  const available = { value: true }
  const nowMs = { value: qoder.now * 1000 }
  const builds = { value: 0 }
  const ctx = new Context()
  ctx.on('session-preview/changed', (s: SessionPreviewState) => states.push(s))
  const svc = new SessionPreviewService(ctx, {
    enabled: true,
    roots: { qoder: qoder.root, zcode: path.join(tmp, 'zcode'), kimicode: path.join(tmp, 'kimi'), ...rootsOver },
    deps: {
      available: () => available.value,
      dshSessions: () => [],
      now: () => nowMs.value,
      log: (e) => log.push(e),
      readRows: (roots, at) => {
        builds.value += 1
        return defaultReadRows(roots, at, (e) => log.push(e))
      },
      ...depsOver,
    },
  })
  return { svc, ctx, states, log, available, nowMs, builds }
}

/** 默认行读取的测试等价物（与 service 的缺省接线同源：逐工具隔离） */
function defaultReadRows(roots: Record<string, string>, nowMs: number, log: (e: Record<string, unknown>) => void) {
  return readPreviewRows(roots, nowMs, log)
}

describe('会话预览服务：打开与投影', () => {
  it('打开即重建投影并推送（Qoder CONFIRM = 疑似等待，标题降级 null）', () => {
    const h = harness()
    expect(h.svc.open()).toBe(true)
    const last = h.states.at(-1)!
    expect(last.open).toBe(true)
    expect(last.groups.map((g) => g.tool)).toEqual(['qodercn'])
    expect(last.groups[0].cards[0]).toMatchObject({
      id: 'q-probe', title: null, project: 'alpha', status: 'suspected-waiting',
    })
    h.svc.dispose()
  })

  it('锚点不在场（普通档也要求模式组可用）：open 如实拒绝，不建空气泡', () => {
    const h = harness()
    h.available.value = false
    expect(h.svc.open()).toBe(false)
    expect(h.states).toHaveLength(0)
    expect(h.svc.state().available).toBe(false)
    h.svc.dispose()
  })

  it('收起重播关闭态并清空卡片（不留陈旧卡片）', () => {
    const h = harness()
    h.svc.open()
    expect(h.svc.close('esc')).toBe(true)
    const last = h.states.at(-1)!
    expect(last.open).toBe(false)
    expect(last.groups).toEqual([])
    expect(h.svc.close('esc')).toBe(false) // 重复收起幂等
    h.svc.dispose()
  })

  it('minimaxcode 进入同一投影：真实标题/最近活跃，顺序在 dsh 之前（第五工具接入）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-spmx-'))
    const mx = new MinimaxFx(path.join(tmp, 'minimax'), Date.now())
    mx.add('mvs_aaaaaaaa4f2c4a67b2d9a6c1e8f0d123', { ageMin: 2, project: 'mu', title: 'MiniMax 真标题' })
    try {
      const h = harness({}, { minimaxcode: mx.root })
      expect(h.svc.open()).toBe(true)
      const groups = h.svc.state().groups
      expect(groups.map((g) => g.tool)).toEqual(['qodercn', 'minimaxcode'])
      const card = groups[1].cards[0]
      expect(card).toMatchObject({
        id: 'mvs_aaaaaaaa4f2c4a67b2d9a6c1e8f0d123',
        title: 'MiniMax 真标题',
        project: 'mu',
        shortId: 'mvs_aaaa',
        status: 'active',
      })
      h.svc.dispose()
    } finally {
      mx.close()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('minimaxcode 读取失败只清空自身：其余四工具预览不受影响', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-spmxbad-'))
    const badRoot = path.join(tmp, 'minimax')
    fs.mkdirSync(path.join(badRoot, 'v2', 'sqlite'), { recursive: true })
    fs.writeFileSync(path.join(badRoot, 'v2', 'sqlite', 'runtime-state.sqlite'), 'not a database', 'utf8')
    try {
      const h = harness({}, { minimaxcode: badRoot })
      expect(h.svc.open()).toBe(true)
      expect(h.svc.state().groups.map((g) => g.tool)).toEqual(['qodercn'])
      h.svc.dispose()
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('单工具读取失败隔离：坏 SQLite 只让 zcode 空集，qodercn 卡片照常', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-spbad-'))
    const badRoot = path.join(tmp, 'zcode')
    fs.mkdirSync(path.join(badRoot, 'cli', 'db'), { recursive: true })
    fs.writeFileSync(path.join(badRoot, 'cli', 'db', 'db.sqlite'), 'not a database', 'utf8')
    try {
      const h = harness({}, { zcode: badRoot })
      expect(h.svc.open()).toBe(true)
      expect(h.svc.state().groups.map((g) => g.tool)).toEqual(['qodercn'])
      expect(h.log.some((e) => e.type === 'session-preview-scan-failed' && e.tool === 'zcode')).toBe(true)
      h.svc.dispose()
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('会话预览服务：1Hz 刷新（fake timers）', () => {
  it('打开期间每 1000ms 重建一次并推送；收起即停表（静止画面零轮询）', () => {
    vi.useFakeTimers()
    try {
      const h = harness()
      expect(h.svc.open()).toBe(true)
      expect(h.builds.value).toBe(1)
      vi.advanceTimersByTime(999)
      expect(h.builds.value).toBe(1)
      vi.advanceTimersByTime(1)
      expect(h.builds.value).toBe(2)
      vi.advanceTimersByTime(2000)
      expect(h.builds.value).toBe(4)
      expect(h.states.filter((s) => s.open)).toHaveLength(4)
      expect(h.log.filter((e) => e.type === 'session-preview-refresh')).toHaveLength(3)
      h.svc.close('esc')
      vi.advanceTimersByTime(5000)
      expect(h.builds.value).toBe(4) // 收起后不再扫描
      h.svc.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('会话预览服务：隐私边界', () => {
  it('日志只含工具名/计数/原因，不含对话标题', () => {
    const h = harness({
      dshSessions: () => [{
        id: 'd1', backend: 'dsh', backendSessionId: null, backendPid: null, backendAgent: null,
        backendAgentVersion: null, runtimeUnaccepted: null, runtimeSmoke: null, cwd: 'D:\\work\\omega',
        label: '绝不能进日志的标题', managed: false, status: 'busy', createdAt: Date.now(),
        endedAt: null, transcript: [], usage: { used: null, size: null }, error: null,
        promptFailure: null, pendingPermission: null,
      }],
    })
    h.svc.open()
    expect(h.svc.state().groups.some((g) => g.tool === 'dsh')).toBe(true)
    const text = JSON.stringify(h.log)
    expect(text).not.toContain('绝不能进日志的标题')
    expect(h.log.some((e) => e.type === 'session-preview-open')).toBe(true)
    h.svc.dispose()
  })
})
