// 夹具窗清扫收口（工单486）：注入假 win32/spawn/pidAlive 断言三段语义——
// ① 优雅关闭（WM_CLOSE→有界等）；② 强杀兜底（窗不退或宿主 pid 残留时 taskkill）；
// ③ 认领纪律（preSet 外唯一新窗才认领、多扇新窗不动）。真机探测的合理性归电池。
import { describe, expect, it } from 'vitest'
import { createFixtureClose, launchAppFixture, attachFixtureWindow } from '../../accept/lib/fixture-close'
import type { FixtureHandle } from '../../accept/lib/fixture-close'

/** 假 win32：按句柄记账 IsWindow/IsWindowVisible/topLevelWindows/threadIdOf/exeNameOfWindow/className/PostMessageW */
function fakeWin32(seed: Array<{ hwnd: number; cls?: string; exe?: string; pid?: number; stubborn?: boolean }> = []) {
  const wins = new Map<number, { visible: boolean; cls: string; exe: string; pid: number; stubborn: boolean }>()
  for (const s of seed) wins.set(s.hwnd, { visible: true, cls: s.cls || 'Notepad', exe: s.exe || 'notepad.exe', pid: s.pid || 100, stubborn: !!s.stubborn })
  return {
    topLevelWindows: () => [...wins.keys()].filter((h) => wins.get(h)!.visible),
    IsWindow: (h: number) => wins.has(Number(h)),
    IsWindowVisible: (h: number) => wins.get(Number(h))?.visible ?? false,
    className: (h: number) => wins.get(Number(h))?.cls || '',
    exeNameOfWindow: (h: number) => wins.get(Number(h))?.exe || '',
    threadIdOf: (h: number) => ({ tid: 1, pid: wins.get(Number(h))?.pid ?? 0 }),
    PostMessageW: (h: number, msg: number) => {
      const w = wins.get(Number(h))
      // WM_CLOSE=0x10：非 stubborn 窗当场销毁（打包版记事本静默关）；stubborn 窗无视（模态框/卡死形态）
      if (w && msg === 0x10 && !w.stubborn) wins.delete(Number(h))
      return true
    },
    /** 测试钩子：模拟进程被强杀后窗销毁 */
    destroy: (h: number) => { wins.delete(Number(h)) },
  }
}

const fastSleep = () => Promise.resolve()
const noSpawn = () => ({ pid: 0 })

describe('fixtureClose.close 三段语义（工单486）', () => {
  it('① 优雅关闭：WM_CLOSE 后窗消失 → closed=true、forced=false、不动 taskkill', async () => {
    const kills: number[] = []
    const close = createFixtureClose({
      win32: fakeWin32([{ hwnd: 50, pid: 300 }]),
      sleep: fastSleep, spawnFn: (cmd, args) => { kills.push(Number((args as string[])[1])); return undefined },
      pidAlive: () => false, graceMs: 100, killWaitMs: 100,
    })
    const out = await close.close({ hwnd: 50, hostPid: 300, child: { pid: 200 } })
    expect(out.closed).toBe(true)
    expect(out.forced).toBe(false)
    expect(out.hostPid).toBe(300)
    expect(kills).toEqual([])
  })

  it('② 窗不退（模态框/卡死形态）→ 按宿主 pid 强杀兜底 → forced=true、closed=true', async () => {
    const kills: number[] = []
    const w32 = fakeWin32([{ hwnd: 51, pid: 310, stubborn: true }])
    const close = createFixtureClose({
      win32: w32,
      sleep: fastSleep,
      spawnFn: (_cmd, args) => { kills.push(Number((args as string[])[1])); return undefined },
      pidAlive: (pid) => pid === 310, // 宿主在强杀后仍报活 → 走满 killWaitMs 后如实报未净
      graceMs: 100, killWaitMs: 100,
    })
    const out = await close.close({ hwnd: 51, hostPid: 310, child: { pid: 210 } })
    expect(out.forced).toBe(true)
    expect(kills).toContain(310) // 宿主 pid（不是 spawn pid）
    expect(kills).toContain(210) // 存根顺手清
    expect(out.closed).toBe(false) // pidAlive 恒真 → 如实报「未净」给轮末断言判红
    expect(out.hostAlive).toBe(true)
  })

  it('②b 强杀奏效：窗与宿主随后退场 → closed=true', async () => {
    const kills: number[] = []
    const w32 = fakeWin32([{ hwnd: 52, pid: 320, stubborn: true }])
    const close = createFixtureClose({
      win32: w32,
      sleep: fastSleep,
      // 假 taskkill 奏效：杀完窗销毁、进程退场（真机 TerminateProcess 同效）
      spawnFn: (_cmd, args) => { kills.push(Number((args as string[])[1])); w32.destroy(52); return undefined },
      pidAlive: () => false, // 强杀后 pid 立即不可见
      graceMs: 30, killWaitMs: 100,
    })
    const out = await close.close({ hwnd: 52, hostPid: 320, child: { pid: 220 } })
    expect(out.forced).toBe(true)
    expect(out.closed).toBe(true)
  })

  it('③ 无窗残留形态（关停卡死：hwnd 已销毁、宿主 pid 残留）→ 直奔强杀', async () => {
    const kills: number[] = []
    let hostDown = false
    const close = createFixtureClose({
      win32: fakeWin32([]),
      sleep: fastSleep,
      spawnFn: (_cmd, args) => { kills.push(Number((args as string[])[1])); hostDown = true; return undefined },
      pidAlive: () => !hostDown, // 强杀前宿主存活、强杀后退场
      graceMs: 100, killWaitMs: 100,
    })
    const out = await close.close({ hwnd: 99, hostPid: 330, child: { pid: 230 } }) // hwnd 99 不存在=窗已没
    expect(out.forced).toBe(true)
    expect(kills).toContain(330)
    expect(out.closed).toBe(true)
  })

  it('④ 宿主 pid 未知且存根仍活（非分裂模型）→ 强杀存根兜底', async () => {
    const kills: number[] = []
    let stubDown = false
    const close = createFixtureClose({
      win32: fakeWin32([]),
      sleep: fastSleep,
      spawnFn: (_cmd, args) => { kills.push(Number((args as string[])[1])); stubDown = true; return undefined },
      pidAlive: () => !stubDown,
      graceMs: 100, killWaitMs: 100,
    })
    const out = await close.close({ hwnd: 0, hostPid: 0, child: { pid: 240 } })
    expect(out.forced).toBe(true)
    expect(kills).toContain(240)
    expect(out.closed).toBe(true)
  })
})

describe('launchAppFixture / attachFixtureWindow 认领纪律（工单486）', () => {
  it('spawn 前不存在的唯一新窗被认领并回填宿主 pid；存量窗永不认领', async () => {
    const w32 = fakeWin32([
      { hwnd: 10, pid: 999, exe: 'notepad.exe' }, // 用户存量记事本
    ])
    let spawned = false
    const fx = await launchAppFixture({ timeoutMs: 50 }, {
      win32: w32,
      spawnFn: () => { spawned = true; return { pid: 400 } },
      sleep: fastSleep,
    })
    expect(spawned).toBe(true)
    expect(fx.child.pid).toBe(400)
    expect(fx.preSet.has(10)).toBe(true) // 存量窗在 preSet 里，永不认领
    // 窗未出 → hwnd=0（追认失败不抛，断言面自行处置）
    expect(fx.hwnd).toBe(0)
    expect(fx.hostPid).toBe(0)
  })

  it('追认：preSet 外唯一新窗回填 hwnd/hostPid；两扇新窗无法唯一认领时不动', async () => {
    const w32 = fakeWin32([{ hwnd: 10, pid: 999 }])
    const fx: FixtureHandle = {
      exeBase: 'notepad', windowClass: '', child: { pid: 400 }, hwnd: 0, hostPid: 0,
      preSet: new Set([10]), spawnedAt: 0,
    }
    // 一扇新窗 → 认领
    const wins1 = new Map([[20, { visible: true, cls: 'Notepad', exe: 'notepad.exe', pid: 410, stubborn: false }]])
    const w32WithNew = {
      ...w32,
      topLevelWindows: () => [...wins1.keys()],
      IsWindow: (h: number) => wins1.has(Number(h)),
      IsWindowVisible: (h: number) => wins1.get(Number(h))?.visible ?? false,
      className: (h: number) => wins1.get(Number(h))?.cls || '',
      exeNameOfWindow: (h: number) => wins1.get(Number(h))?.exe || '',
      threadIdOf: (h: number) => ({ tid: 1, pid: wins1.get(Number(h))?.pid ?? 0 }),
    }
    expect(await attachFixtureWindow(fx, { timeoutMs: 0 }, { win32: w32WithNew, sleep: fastSleep })).toBe(true)
    expect(fx.hwnd).toBe(20)
    expect(fx.hostPid).toBe(410)
    // 两扇新窗 → 不认领（宁漏不误领用户窗），注记留痕
    fx.hwnd = 0; fx.hostPid = 0
    wins1.set(21, { visible: true, cls: 'Notepad', exe: 'notepad.exe', pid: 411, stubborn: false })
    expect(await attachFixtureWindow(fx, { timeoutMs: 0 }, { win32: w32WithNew, sleep: fastSleep })).toBe(false)
    expect(fx.attachNote).toContain('无法唯一认领')
    expect(fx.hwnd).toBe(0)
  })

  it('窗类名等价匹配（windowClass）：exe 前缀不中时按类名认领', async () => {
    const wins = new Map([[30, { visible: true, cls: 'Notepad', exe: 'WeirdHost.exe', pid: 500, stubborn: false }]])
    const w32 = {
      topLevelWindows: () => [...wins.keys()],
      IsWindow: (h: number) => wins.has(Number(h)),
      IsWindowVisible: (h: number) => wins.get(Number(h))?.visible ?? false,
      className: (h: number) => wins.get(Number(h))?.cls || '',
      exeNameOfWindow: (h: number) => wins.get(Number(h))?.exe || '',
      threadIdOf: (h: number) => ({ tid: 1, pid: wins.get(Number(h))?.pid ?? 0 }),
    }
    const fx: FixtureHandle = {
      exeBase: 'notepad', windowClass: 'Notepad', child: { pid: 401 }, hwnd: 0, hostPid: 0,
      preSet: new Set([]), spawnedAt: 0,
    }
    expect(await attachFixtureWindow(fx, { timeoutMs: 0 }, { win32: w32, sleep: fastSleep })).toBe(true)
    expect(fx.hostPid).toBe(500)
  })
})
