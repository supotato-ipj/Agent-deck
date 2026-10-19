// 面板控制模块（工单112，spec #109 seam②）：强退序列「优雅终止 → 整树强杀 → 有界等待
// 验证消失 → 仍存活报需重启清障」的四路径决策与中止信号。杀灭/探询/时钟全经注入——
// 假进程世界直测决策，不碰真机；真机行为归验收电池。
import { describe, expect, it, vi } from 'vitest'
import { createPanelControl, findPanelWindows } from '../../accept/lib/panel-control'
import type { PanelStopResult } from '../../accept/lib/panel-control'
import { Report } from '../../accept/lib/report'

/** 假进程世界：gracefulKills/forceKills 控制两类杀灭是否生效（forceKillPids 可只杀部分）；
 *  dieAt 给「杀灭无效但进程稍后自行消失」的延迟死亡时刻（验证窗内轮询才能发现）。
 *  时钟为假：sleep 推进 now，deadline 有界性可精确断言。 */
function fakeWorld(opts: {
  pids?: number[]
  gracefulKills?: boolean
  forceKills?: boolean
  forceKillPids?: number[]
  dieAt?: Record<number, number>
} = {}) {
  const pids = opts.pids ?? [4101, 4102]
  const dieAt = opts.dieAt ?? {}
  const forceKillPids = opts.forceKillPids ?? pids
  let now = 0
  const alive = new Set(pids)
  const log = { gracefulKills: 0, forceKills: [] as number[], sleeps: [] as number[] }
  const ctl = createPanelControl({
    isAlive: (pid) => {
      if (!alive.has(pid)) return false
      const t = dieAt[pid]
      return t === undefined || now < t
    },
    gracefulKill: () => {
      log.gracefulKills++
      if (opts.gracefulKills) for (const p of pids) alive.delete(p)
    },
    forceKillTree: (pid) => {
      log.forceKills.push(pid)
      if (opts.forceKills && forceKillPids.includes(pid)) alive.delete(pid)
    },
    sleep: async (ms) => { log.sleeps.push(ms); now += ms },
    now: () => now,
  })
  return { ctl, log, now: () => now }
}

describe('强退序列四路径决策（注入假杀灭/假探询）', () => {
  it('路径一·优雅退成功：宽限期内全消失 → gone、未强杀、零 taskkill', async () => {
    const w = fakeWorld({ gracefulKills: true })
    const res = await w.ctl.stop({ pids: [4101, 4102], child: { pid: 4101 } })
    expect(res).toEqual({ gone: true, graceful: true, forced: false, pidsLeft: [], outcome: 'graceful-gone' })
    expect(w.log.gracefulKills).toBe(1)
    expect(w.log.forceKills).toEqual([])
  })

  it('路径二·需强退：优雅退无效 → 逐 pid 整树强杀 → 强杀即生效 → gone（forced 形态）', async () => {
    const w = fakeWorld({ gracefulKills: false, forceKills: true })
    const res = await w.ctl.stop({ pids: [4101, 4102] })
    expect(res).toEqual({ gone: true, graceful: false, forced: true, pidsLeft: [], outcome: 'forced-gone' })
    expect(w.log.gracefulKills).toBe(1) // 优雅终止先试过
    expect(w.log.forceKills).toEqual([4101, 4102]) // 每个 pid 各一次 /T /F
  })

  it('路径三·强退后消失：强杀手段无效但进程延迟退出 → 验证窗内轮询发现消失 → gone', async () => {
    // 强杀在 now=800（优雅宽限后）落地但杀不动；两进程分别在 +400/+500 后自行消失
    const w = fakeWorld({ gracefulKills: false, forceKills: false, dieAt: { 4101: 1200, 4102: 1300 } })
    const res = await w.ctl.stop({ pids: [4101, 4102] })
    expect(res).toEqual({ gone: true, graceful: false, forced: true, pidsLeft: [], outcome: 'forced-gone' })
    expect(w.now()).toBeLessThan(800 + 5000) // 有界等待内解决，未耗满验证窗
  })

  it('路径四·强退后仍存活：验证窗耗尽仍有幸存者 → 需重启清障信号（pidsLeft 指认钉子户）', async () => {
    const w = fakeWorld({ gracefulKills: false, forceKills: false })
    const res = await w.ctl.stop({ pids: [4101, 4102] })
    expect(res).toEqual({ gone: false, graceful: false, forced: true, pidsLeft: [4101, 4102], outcome: 'restart-clear-required' })
    // 有界：恰好耗满验证窗（800 宽限 + 5000 验证），既不提前放弃也不无限轮询
    expect(w.now()).toBe(800 + 5000)
  })

  it('路径四部分存活：一个被杀掉一个钉住 → pidsLeft 只列幸存者', async () => {
    const w = fakeWorld({ gracefulKills: false, forceKills: true, forceKillPids: [4101] })
    const res = await w.ctl.stop({ pids: [4101, 4102] })
    expect(res.gone).toBe(false)
    expect(res.pidsLeft).toEqual([4102])
    expect(res.outcome).toBe('restart-clear-required')
  })
})

describe('强退序列边界与注入参数', () => {
  it('空进程表：只做一次尽力优雅终止，不强杀不等待，视作已消失', async () => {
    const w = fakeWorld({})
    const res = await w.ctl.stop({ pids: [], child: null })
    expect(res).toEqual({ gone: true, graceful: true, forced: false, pidsLeft: [], outcome: 'graceful-gone' })
    expect(w.log.gracefulKills).toBe(1)
    expect(w.log.forceKills).toEqual([])
    expect(w.log.sleeps).toEqual([])
  })

  it('pid 归一：去重、丢弃 0/负数/非数值', async () => {
    const w = fakeWorld({ pids: [4101], gracefulKills: false, forceKills: true })
    const res = await w.ctl.stop({ pids: [4101, '4101', 0, -7, Number.NaN] as unknown as number[] })
    expect(res.gone).toBe(true)
    expect(w.log.forceKills).toEqual([4101]) // 同 pid 不重复强杀
  })

  it('graceMs/verifyMs/pollMs 经注入生效（时钟可整定）', async () => {
    const w = fakeWorld({ gracefulKills: false, forceKills: false })
    const res = await w.ctl.stop({ pids: [4101], graceMs: 50, verifyMs: 300, pollMs: 100 })
    expect(res.gone).toBe(false)
    expect(w.log.sleeps[0]).toBe(50) // 优雅宽限
    expect(w.now()).toBe(50 + 300) // 验证窗恰好耗满
    expect(w.log.sleeps.slice(1).every((ms) => ms === 100)).toBe(true)
  })
})

describe('遗留面板窗核验（收尾清场取证；#113 preflight 复用同函数）', () => {
  it('只认面板本体窗：Chrome_WidgetWin_1 + 标题 AGENT DECK；提示条/任务栏条带/他人窗全不入列', () => {
    const rows = [
      { cls: 'Chrome_WidgetWin_1', title: 'AGENT DECK', pid: 4101, selfPid: 400 }, // 面板本体
      { cls: 'Chrome_WidgetWin_1', title: 'AGENT DECK ACCEPT HINT', pid: 400, selfPid: 400 }, // 提示条（刻意异名）
      { cls: 'Chrome_WidgetWin_1', title: 'DECK-TASKBAR', pid: 4101, selfPid: 400 }, // 面板副窗（标题甄别排除）
      { cls: 'Progman', title: '', pid: 940, selfPid: 400 }, // 桌面层
      { cls: 'Ghost', title: '主人窗', pid: 4102, selfPid: 400 }, // OLE 幽灵
    ]
    expect(findPanelWindows(rows)).toEqual([{ cls: 'Chrome_WidgetWin_1', title: 'AGENT DECK', pid: 4101, selfPid: 400 }])
  })

  it('控制器自身的同款窗（pid=selfPid）不入列；selfPid 缺省不排除任何 pid', () => {
    const own = [{ cls: 'Chrome_WidgetWin_1', title: 'AGENT DECK', pid: 400, selfPid: 400 }]
    expect(findPanelWindows(own)).toEqual([])
    const noSelf = [{ cls: 'Chrome_WidgetWin_1', title: 'AGENT DECK', pid: 4101 }]
    expect(findPanelWindows(noSelf)).toHaveLength(1)
  })

  it('双面板并存：末代面板 + 上一代遗留面板 → 两扇都指认（pid 列表供取证）', () => {
    const rows = [
      { cls: 'Chrome_WidgetWin_1', title: 'AGENT DECK', pid: 4101, selfPid: 400 },
      { cls: 'Chrome_WidgetWin_1', title: 'AGENT DECK', pid: 3900, selfPid: 400 },
    ]
    expect(findPanelWindows(rows).map((c) => c.pid).sort((a, b) => a - b)).toEqual([3900, 4101])
  })
})

describe('battery.js 接线的可执行规格：强退决策 → 环境降责账与中止信号（工单112）', () => {
  /** 接线规格：gone=false 即「需重启清障」——入环境降责账（归因=面板强退失败）；
   *  heal 自愈段借中止信号停掉后续段，收尾清场只记账绝不抛（清场不掩盖真结局）。 */
  function wireStopDecision(rep: Report, res: PanelStopResult, phase: 'heal' | 'cleanup') {
    if (res.gone) return { aborted: false }
    rep.exclude(
      `${phase === 'cleanup' ? '清场核验：' : ''}面板强退失败：强杀后有界等待内仍存活（pid=${res.pidsLeft.join(', ')}）——需重启清障`,
      '面板强退序列未能终结面板进程（#107 遗留进程形态）',
      'panel-forcekill',
    )
    return { aborted: phase === 'heal' }
  }

  it('heal 段强退失败（停摆窗已开）：入账 panel-forcekill 且中止信号置位 → 轮末 FAIL-ENV', () => {
    const rep = new Report('t', { file: null })
    rep.beginEnvWindow('面板主线程假死（WM_NULL 超时）', 'panel-stall')
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    let r: ReturnType<Report['verdict']>
    try {
      const { aborted } = wireStopDecision(rep, { gone: false, graceful: false, forced: true, pidsLeft: [4101], outcome: 'restart-clear-required' }, 'heal')
      expect(aborted).toBe(true)
      r = rep.verdict()
    } finally {
      spy.mockRestore()
    }
    expect(rep.fails).toBe(0)
    expect(rep.exclusions[0]).toMatchObject({ attribution: 'panel-forcekill', inWindow: true })
    expect(r).toMatchObject({ verdict: 'FAIL-ENV', exitCode: 2, envWindowOpen: true })
  })

  it('收尾清场强退失败（窗外）：入账不中止 → 无未定责失败，verdict FAIL-ENV(2)', () => {
    const rep = new Report('t', { file: null })
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    let r: ReturnType<Report['verdict']>
    try {
      const { aborted } = wireStopDecision(rep, { gone: false, graceful: false, forced: true, pidsLeft: [4102], outcome: 'restart-clear-required' }, 'cleanup')
      expect(aborted).toBe(false)
      r = rep.verdict()
    } finally {
      spy.mockRestore()
    }
    expect(rep.fails).toBe(0)
    expect(rep.exclusions[0]).toMatchObject({ attribution: 'panel-forcekill', inWindow: false })
    expect(r).toMatchObject({ verdict: 'FAIL-ENV', exitCode: 2 })
  })

  it('强退验证消失：不产生任何排除条目——行为不变量（无停摆时不引入新账目）', () => {
    const rep = new Report('t', { file: null })
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    let r: ReturnType<Report['verdict']>
    try {
      rep.pass('P2 面板出现')
      const { aborted } = wireStopDecision(rep, { gone: true, graceful: true, forced: false, pidsLeft: [], outcome: 'graceful-gone' }, 'heal')
      expect(aborted).toBe(false)
      r = rep.verdict()
    } finally {
      spy.mockRestore()
    }
    expect(rep.excluded).toBe(0)
    expect(r).toMatchObject({ verdict: 'PASS', exitCode: 0 })
  })
})

describe('battery.js ensurePanelHit 命中分支接线规格（评审 P0 回归钉）', () => {
  /** 接线规格：命中面板后按探活与自愈结局三分支——heal 失败（重启后新窗未现）时
   *  绝不调 onPanelHealthy（排除窗必须保持开启→FAIL-ENV），也绝不返回 ok:true。 */
  function wireHitBranch(live: string, healed: boolean, calls: { healthy: number }) {
    if (live.startsWith('主线程假死')) {
      if (healed) return { ok: false, why: '落点命中面板但主线程假死→已重启面板，本段跳过' }
      return { ok: false, why: '面板假死且重启失败，后续段无面板可用' }
    }
    calls.healthy++ // onPanelHealthy()：仅探活健康时闭窗
    return { ok: true }
  }
  const calls = () => ({ healthy: 0 })

  it('探活健康：闭窗一次 + ok:true（现状不变量）', () => {
    const c = calls()
    expect(wireHitBranch('主线程在', false, c)).toEqual({ ok: true })
    expect(c.healthy).toBe(1)
  })

  it('假死+自愈成功：不闭窗 + ok:false（本段跳过，等落点重验）', () => {
    const c = calls()
    const r = wireHitBranch('主线程假死(WM_NULL 超时)', true, c)
    expect(r.ok).toBe(false)
    expect(c.healthy).toBe(0)
  })

  it('假死+自愈失败：不闭窗 + ok:false（排除窗保持开启，其后失败全数环境降责）', () => {
    const rep = new Report('t', { file: null })
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      rep.beginEnvWindow('面板主线程假死（WM_NULL 超时）', 'panel-stall')
      const c = calls()
      const r = wireHitBranch('主线程假死(WM_NULL 超时)', false, c)
      expect(r.ok).toBe(false)
      expect(c.healthy).toBe(0)
      rep.fail('P2 面板出现') // 窗仍在开：失败必须入排除账而非失败账
      const v = rep.verdict()
      expect(v).toMatchObject({ verdict: 'FAIL-ENV', exitCode: 2, envWindowOpen: true })
    } finally {
      spy.mockRestore()
    }
  })
})
