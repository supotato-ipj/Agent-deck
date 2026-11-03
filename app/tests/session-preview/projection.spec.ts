/**
 * Agent 会话预览投影回归网（工单381，spec #369 决策 20-23）：
 *  - 三工具预览行读取（真实标题 / 项目名 / 最近活跃）与 Qoder 无标题降级；
 *  - 五态诚实分派（running/active/waiting/suspected-waiting/unknown）与完成/空闲过滤；
 *  - 工具固定相对顺序、组内最近活跃、空工具不占位；
 *  - 短会话 ID 与「未命名会话」降级；DSH 真实 label 与 pendingPermission。
 * 全部夹具合成（tests/scanners/fixtures.ts），零真实会话内容。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConversationSessionView, SessionPreviewCard } from '../../src/shared/contract'
import { SESSION_PREVIEW_TOOL_ORDER } from '../../src/shared/contract'
import { kimicodePreviewRows } from '../../src/main/scanners/kimicode'
import { minimaxcodePreviewRows } from '../../src/main/scanners/minimaxcode'
import { qoderPreviewRows } from '../../src/main/scanners/qoder'
import { zcodePreviewRows } from '../../src/main/scanners/zcode'
import {
  buildSessionPreviewGroups,
  dshCards,
  kimicodeCards,
  minimaxcodeCards,
  qoderCards,
  shortSessionId,
  zcodeCards,
} from '../../src/main/session-preview/projection'
import { KimiCodeFx, MinimaxFx, QoderFx, ZcodeFx, rec } from '../scanners/fixtures'

let tmp = ''
const fixtures: Array<{ close?: () => void } | object> = []

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-sp-'))
})
afterAll(() => {
  for (const f of fixtures) {
    const c = f as { close?: () => void }
    try { c.close?.() } catch { /* 尽力 */ }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* Windows 句柄滞后容忍残留 */ }
})

function freshDir(tag: string): string {
  return path.join(tmp, `${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
}

function newQoder(): QoderFx {
  const f = new QoderFx(freshDir('q'))
  f.now = Date.now() / 1000
  fixtures.push(f)
  return f
}

function newZcode(): ZcodeFx {
  const f = new ZcodeFx(freshDir('z'), Date.now() / 1000)
  fixtures.push(f)
  return f
}

function newKimi(): KimiCodeFx {
  const f = new KimiCodeFx(freshDir('k'), Date.now() / 1000)
  fixtures.push(f)
  return f
}

function newMinimax(): MinimaxFx {
  const f = new MinimaxFx(freshDir('mx'), Date.now())
  fixtures.push(f)
  return f
}

/** DSH 视图最小完整构造（其余字段按契约缺省；只列投影读取的字段有语义） */
function dshView(over: Partial<ConversationSessionView> = {}): ConversationSessionView {
  return {
    id: 'dsh-1',
    backend: 'dsh',
    backendSessionId: 'backend-1',
    backendPid: 100,
    backendAgent: 'dsh',
    backendAgentVersion: '1.0',
    runtimeUnaccepted: null,
    runtimeSmoke: null,
    cwd: 'D:\\work\\omega',
    label: '真实标签',
    managed: false,
    status: 'ready',
    createdAt: Date.now(),
    endedAt: null,
    transcript: [],
    usage: { used: null, size: null },
    error: null,
    promptFailure: null,
    pendingPermission: null,
    ...over,
  }
}

describe('qodercn 预览行与诚实分态', () => {
  it('末条 assistant 以 tool_use 收尾 = 疑似等待；无标题降级 null；项目名来自 cwd', () => {
    const f = newQoder()
    f.addSession('q_confirm', 20, [rec('user', 'user'), rec('assistant', 'tool', 'D:/work/alpha')])
    const nowMs = f.now * 1000
    const rows = qoderPreviewRows(f.root, nowMs)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'q_confirm', project: 'alpha', lastKind: 'tool' })
    const [card] = qoderCards(rows, nowMs)
    expect(card.status).toBe('suspected-waiting')
    expect(card.title).toBeNull()
    expect(card.shortId).toBe('q_confir')
  })

  it('assistant 文本收尾 = 完成被过滤；末条 user = 最近活跃；无可解析尾 = 未知', () => {
    const f = newQoder()
    f.addSession('q_done', 10, [rec('assistant', 'text', 'D:/work/alpha')])
    f.addSession('q_user', 20, [rec('user', 'user', 'D:/work/beta')])
    f.addSession('q_unknown', 30, [])
    const nowMs = f.now * 1000
    const cards = qoderCards(qoderPreviewRows(f.root, nowMs), nowMs)
    const byId = new Map(cards.map((c) => [c.id, c.status]))
    expect(byId.get('q_done')).toBeUndefined() // 完成被过滤
    expect(byId.get('q_user')).toBe('active')
    expect(byId.get('q_unknown')).toBe('unknown')
  })

  it('Qoder CONFIRM 绝不升级成 running 或 waiting（只配疑似等待）', () => {
    const f = newQoder()
    f.addSession('q_confirm', 5, [rec('assistant', 'tool', 'D:/work/alpha')])
    const nowMs = f.now * 1000
    const [card] = qoderCards(qoderPreviewRows(f.root, nowMs), nowMs)
    expect(card.status).not.toBe('running')
    expect(card.status).not.toBe('waiting')
  })
})

describe('zcode / kimicode 真实标题与最近活跃', () => {
  it('zcode 读 session.title；空标题降级 null；执行/等待不推断（active）', () => {
    const f = newZcode()
    f.add('sess_title', 20_000, { title: ' 我的会话 ', directory: 'D:/work/delta' })
    f.add('sess_blank', 40_000, { title: '   ', directory: 'D:/work/eps' })
    const nowMs = f.now * 1000
    const cards = zcodeCards(zcodePreviewRows(f.root, nowMs), nowMs)
    expect(cards.map((c) => [c.id, c.title, c.project, c.status])).toEqual([
      ['sess_title', '我的会话', 'delta', 'active'],
      ['sess_blank', null, 'eps', 'active'],
    ])
  })

  it('kimicode 读 state.json title 与 workDir 末段', () => {
    const f = newKimi()
    f.addSession('k1', 20, { title: 'kimi 真标题', workDir: 'D:/work/zeta' })
    f.addSession('k2', 40, { title: '' })
    const nowMs = f.now * 1000
    const cards = kimicodeCards(kimicodePreviewRows(f.root, nowMs), nowMs)
    expect(cards.map((c) => [c.id, c.title, c.status])).toEqual([
      ['k1', 'kimi 真标题', 'active'],
      ['k2', null, 'active'],
    ])
    expect(cards[0].project).toBe('zeta')
  })

  it('超出 10 分钟活跃池的会话不进卡片流（空闲过滤）', () => {
    const f = newZcode()
    f.add('sess_old', 11 * 60_000)
    const nowMs = f.now * 1000
    expect(zcodeCards(zcodePreviewRows(f.root, nowMs), nowMs)).toHaveLength(0)
  })
})

describe('minimaxcode 第五工具（工单382：真实标题与最近活跃，不伪造执行/等待）', () => {
  it('真实标题/项目/短 ID 原样透传；状态只落「最近活跃」，DB status 不冒充执行', () => {
    const f = newMinimax()
    f.add('mvs_aaaaaaaa4f2c4a67b2d9a6c1e8f0d123', { ageMin: 2, project: 'mu', title: 'MiniMax 真标题', status: 'started' })
    f.add('mvs_bbbbbbbb4f2c4a67b2d9a6c1e8f0d456', { ageMin: 3, title: null, status: 'error' })
    const nowMs = f.nowMs
    const cards = minimaxcodeCards(minimaxcodePreviewRows(f.root, nowMs), nowMs)
    expect(cards.map((c) => [c.id, c.title, c.project, c.shortId, c.status])).toEqual([
      ['mvs_aaaaaaaa4f2c4a67b2d9a6c1e8f0d123', 'MiniMax 真标题', 'mu', 'mvs_aaaa', 'active'],
      ['mvs_bbbbbbbb4f2c4a67b2d9a6c1e8f0d456', null, 'zulu', 'mvs_bbbb', 'active'],
    ])
    f.close()
  })

  it('绝不产出 running/waiting/suspected-waiting：执行与等待一律不推断', () => {
    const f = newMinimax()
    f.add('mvs_cccccccc4f2c4a67b2d9a6c1e8f0d789', { ageMin: 1, status: 'started' })
    const nowMs = f.nowMs
    const cards = minimaxcodeCards(minimaxcodePreviewRows(f.root, nowMs), nowMs)
    expect(cards).toHaveLength(1)
    expect(['running', 'waiting', 'suspected-waiting']).not.toContain(cards[0].status)
    expect(cards[0].status).toBe('active')
    f.close()
  })

  it('超出活跃池的 MiniMax 会话被过滤（活动过滤）', () => {
    const f = newMinimax()
    f.add('mvs_dddddddd4f2c4a67b2d9a6c1e8f0d111', { ageMin: 11 })
    const nowMs = f.nowMs
    expect(minimaxcodeCards(minimaxcodePreviewRows(f.root, nowMs), nowMs)).toEqual([])
    f.close()
  })
})

describe('DSH 真实信号分态', () => {
  it('busy = 执行中；pendingPermission = 等待询问；label 原样、cwd 末段作项目名', () => {
    const busy = dshView({ id: 'd-busy', label: '修 bug', status: 'busy', cwd: 'D:\\work\\omega\\' })
    const waiting = dshView({
      id: 'd-wait',
      label: '等确认',
      status: 'busy',
      pendingPermission: { options: [{ optionId: 'allow-once', name: '允许一次', kind: 'allow_once' }] },
    })
    const cards = dshCards([busy, waiting], Date.now())
    expect(cards.map((c) => [c.id, c.title, c.project, c.status])).toEqual([
      ['d-busy', '修 bug', 'omega', 'running'],
      ['d-wait', '等确认', 'omega', 'waiting'],
    ])
  })

  it('ready/ended/failed 被过滤（空闲/完成）；starting = 未知；无 label = 未命名', () => {
    const now = Date.now()
    const cards = dshCards([
      dshView({ id: 'd-ready', status: 'ready' }),
      dshView({ id: 'd-ended', status: 'ended', endedAt: now }),
      dshView({ id: 'd-failed', status: 'failed' }),
      dshView({ id: 'd-starting', status: 'starting', label: '' }),
    ], now)
    expect(cards.map((c) => [c.id, c.status, c.title])).toEqual([
      ['d-starting', 'unknown', null],
    ])
  })

  it('真实等待与疑似等待是不同状态值（不共用「等待」）', () => {
    const now = Date.now()
    const [dsh] = dshCards([dshView({ id: 'd-wait', status: 'busy', pendingPermission: { options: [] } })], now)
    const q = newQoder()
    q.addSession('q_confirm', 5, [rec('assistant', 'tool', 'D:/work/alpha')])
    const nowMs = q.now * 1000
    const [qoder] = qoderCards(qoderPreviewRows(q.root, nowMs), nowMs)
    expect(dsh.status).toBe('waiting')
    expect(qoder.status).toBe('suspected-waiting')
    expect(dsh.status).not.toBe(qoder.status)
  })
})

describe('投影组集（固定工具序 / 组内最近活跃 / 空工具不占位）', () => {
  it('工具相对顺序固定、空工具整组不出现、组内按最近活跃降序', () => {
    const qf = newQoder()
    qf.addSession('q1', 30, [rec('assistant', 'tool', 'D:/work/alpha')])
    const zf = newZcode()
    zf.add('z_old', 90_000)
    zf.add('z_new', 10_000)
    const nowMs = Math.max(qf.now, zf.now) * 1000
    const groups = buildSessionPreviewGroups({
      qoder: qoderPreviewRows(qf.root, nowMs),
      zcode: zcodePreviewRows(zf.root, nowMs),
      kimicode: [],
      minimaxcode: [],
      dsh: [dshView({ id: 'd-busy', status: 'busy' })],
    }, nowMs)
    expect(groups.map((g) => g.tool)).toEqual(['qodercn', 'zcode', 'dsh'])
    expect(groups[1].cards.map((c) => c.id)).toEqual(['z_new', 'z_old'])
    expect(groups.some((g) => g.tool === 'kimicode')).toBe(false)
  })

  it('五工具相对顺序固定为 qodercn→zcode→kimicode→minimaxcode→dsh（spec #369 用户故事 58）', () => {
    expect(SESSION_PREVIEW_TOOL_ORDER).toEqual(['qodercn', 'zcode', 'kimicode', 'minimaxcode', 'dsh'])
    const mf = newMinimax()
    mf.add('mvs_eeeeeeee4f2c4a67b2d9a6c1e8f0d222', { ageMin: 1, project: 'nu', title: '五工具同场' })
    const qf = newQoder()
    qf.addSession('q1', 30, [rec('assistant', 'tool', 'D:/work/alpha')])
    const zf = newZcode()
    zf.add('z_1', 20_000)
    const kf = newKimi()
    kf.addSession('k_1', 20, { title: 'kimi' })
    const nowMs = Math.min(qf.now, zf.now, kf.now) * 1000
    const groups = buildSessionPreviewGroups({
      qoder: qoderPreviewRows(qf.root, nowMs),
      zcode: zcodePreviewRows(zf.root, nowMs),
      kimicode: kimicodePreviewRows(kf.root, nowMs),
      minimaxcode: minimaxcodePreviewRows(mf.root, mf.nowMs),
      dsh: [dshView({ id: 'd-busy', status: 'busy' })],
    }, nowMs)
    expect(groups.map((g) => g.tool)).toEqual(['qodercn', 'zcode', 'kimicode', 'minimaxcode', 'dsh'])
    // 组内各一张：五工具同场时顺序只由固定工具序决定，不被活跃时间混排
    expect(groups.every((g) => g.cards.length === 1)).toBe(true)
    mf.close()
  })

  it('minimaxcode 空集时整组不占位（空工具不占位）', () => {
    const now = Date.now()
    const groups = buildSessionPreviewGroups({
      qoder: [], zcode: [], kimicode: [], minimaxcode: [],
      dsh: [dshView({ id: 'd-busy', status: 'busy' })],
    }, now)
    expect(groups.map((g) => g.tool)).toEqual(['dsh'])
  })

  it('短会话 ID：前 8 字符；短 id 原样', () => {
    expect(shortSessionId('0123456789abcdef')).toBe('01234567')
    expect(shortSessionId('abc')).toBe('abc')
    const cards: SessionPreviewCard[] = qoderCards([], Date.now())
    expect(cards).toEqual([])
  })
})
