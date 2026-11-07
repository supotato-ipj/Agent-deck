/**
 * TrayHost 账本层回收（工单423）：合成 NIM_ADD 建账 → 注入宿主句柄死亡 → 断言
 * `reaped` 发出、条目摘除；注入存活句柄 → 断言零回收。走 host 的 koffi 函数表注入缝
 * （票面既定，不建新缝）：WM_COPYDATA 字节负载经 onCopyData（wndproc 同一路径）喂入，
 * Win32 函数逐个换假源；只断言对外的 TrayWireEvent 流与回放/像素账可见的外部面，
 * 不测内部 Map 结构与监视线程实现（监视线程随真机电池段验收）。
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import { beforeEach, describe, expect, it } from 'vitest'
import { TrayHost } from '../src/main/trayhost/host'
import {
  encodeTrayPayload,
  NIF_MESSAGE,
  NIF_TIP,
  reapedTrayEvent,
} from '../src/main/trayhost/protocol'
import type { TrayIconPixels, TrayWireEvent } from '../src/main/trayhost/protocol'
import { TaskbarService } from '../src/main/services/taskbar'

const SYNCHRONIZE = 0x00100000
const COPYDATA_TRAY = 1
const WAIT_OBJECT_0 = 0
const WAIT_TIMEOUT = 0x102

const PIX: TrayIconPixels = { width: 16, height: 16, bgraBase64: 'AAAA' }

/* eslint-disable @typescript-eslint/no-explicit-any */
/** koffi 函数表缝的形参面（host.ts 同款 AnyFn——各函数形参互异，统一按 any 收口） */
type AnyFn = (...args: any[]) => any

/** 离线夹具：koffi 函数表注入缝 + 假内存（readProcessMemory 服务 WM_COPYDATA 读） */
function makeFixture(pidsByHwnd: Map<number, number>) {
  const events: TrayWireEvent[] = []
  const logs: Array<Record<string, unknown>> = []
  const calls = {
    openProcess: [] as Array<[number, number, number]>,
    closeHandle: [] as number[],
  }
  /** 句柄 signaled 集（宿主死亡注入面） */
  const signaled = new Set<number>()
  const mem = new Map<number, Buffer>()
  let nextAddr = 0x10000
  const alloc = (b: Buffer): number => {
    const addr = nextAddr
    nextAddr += (b.length + 15) & ~15
    mem.set(addr, b)
    return addr
  }
  const host = new TrayHost({ onEvent: (e) => events.push(e), log: (e) => logs.push(e) })
  const f = (host as unknown as { f: Record<string, AnyFn> }).f
  f.readProcessMemory = (_h: number, addr: number, buf: Buffer, len: number) => {
    const src = mem.get(Number(addr))
    if (!src) return false
    src.subarray(0, Number(len)).copy(buf, 0, 0, Number(len))
    return true
  }
  f.getLastError = () => 0
  f.getWindowThreadProcessId = (hwnd: number, out: Buffer) => {
    out.writeUInt32LE(pidsByHwnd.get(Number(hwnd)) ?? 0, 0)
    return 1
  }
  f.openProcess = (access: number, inherit: number, pid: number) => {
    calls.openProcess.push([Number(access), inherit, Number(pid)]) // inherit 原样记录（koffi bool 形参传 boolean）
    return 0xabc00000 + Number(pid)
  }
  f.closeHandle = (h: number) => {
    calls.closeHandle.push(Number(h))
    return true
  }
  f.waitMultiple = (n: number, buf: Buffer, _any: boolean, _ms: number) => {
    void n
    return signaled.has(Number(buf.readBigUInt64LE(0))) ? WAIT_OBJECT_0 : WAIT_TIMEOUT
  }
  const send = (payload: Buffer): number => {
    const cds = Buffer.alloc(24) // COPYDATASTRUCT x64
    cds.writeBigUInt64LE(BigInt(COPYDATA_TRAY), 0)
    cds.writeUInt32LE(payload.length, 8)
    cds.writeBigUInt64LE(BigInt(alloc(payload)), 16)
    return (host as unknown as { onCopyData(w: number, l: number | bigint): number }).onCopyData(0, alloc(cds))
  }
  const add = (hwnd: number, uid: number, tooltip = '探针'): number => {
    send(encodeTrayPayload({
      arch: 'x64', version: 3, hwnd, uid,
      flags: NIF_MESSAGE | NIF_TIP, callbackMessage: 0x8001, hicon: 0, tooltip,
      dwMessage: 0 /* NIM_ADD */,
    }))
    return 0xabc00000 + (pidsByHwnd.get(hwnd) ?? 0)
  }
  const notify = (dwMessage: number, hwnd: number, uid: number): void => {
    send(encodeTrayPayload({
      arch: 'x64', version: 3, hwnd, uid,
      flags: NIF_MESSAGE | NIF_TIP, callbackMessage: 0x8001, hicon: 0, tooltip: '探针',
      dwMessage,
    }))
  }
  /** 监视线程死亡上报 → 主线程回收入口（既有主线程调度回账本的同一条路） */
  const reportDead = (keys: string[]): void => {
    ;(host as unknown as { onReapDead(keys: string[]): void }).onReapDead(keys)
  }
  const keyOf = (hwnd: number, uid: number): string => `${hwnd}:${uid}`
  return { host, events, logs, calls, signaled, send, add, notify, reportDead, keyOf, pids: pidsByHwnd }
}

describe('TrayHost 账本层回收（工单423）', () => {
  let fx: ReturnType<typeof makeFixture>
  let events: TrayWireEvent[]

  beforeEach(() => {
    fx = makeFixture(new Map([[0x1234, 5001], [0x5678, 5002]]))
    events = fx.events
  })

  it('合成 NIM_ADD 建账：add 照发，OpenProcess(SYNCHRONIZE) 对宿主 pid 开回收句柄', () => {
    fx.add(0x1234, 1)
    expect(events.map((e) => e.kind)).toEqual(['add'])
    expect(events[0].key).toBe(fx.keyOf(0x1234, 1))
    expect(fx.calls.openProcess).toEqual([[SYNCHRONIZE, false, 5001]])
    expect(events.every((e) => e.kind !== 'reaped')).toBe(true)
  })

  it('宿主句柄死亡：reaped 发出（key/ownerPid/回收时刻）、条目摘除、句柄即用即关', () => {
    const handle = fx.add(0x1234, 1)
    const key = fx.keyOf(0x1234, 1)
    fx.signaled.add(handle) // 注入宿主句柄死亡
    const t0 = Date.now()
    fx.reportDead([key])
    const t1 = Date.now()
    const reaps = events.filter((e) => e.kind === 'reaped')
    expect(reaps).toHaveLength(1)
    expect(reaps[0].key).toBe(key)
    expect(reaps[0].ownerPid).toBe(5001)
    expect(reaps[0].reapedAt).toBeGreaterThanOrEqual(t0)
    expect(reaps[0].reapedAt).toBeLessThanOrEqual(t1)
    // 条目摘除的外部面：回放寻不回该图标（托盘图标不在场）
    const replay = fx.host.replay(key, 'left')
    expect(replay.ok).toBe(false)
    expect(replay.error).toContain('不在场')
    // 句柄即用即关
    expect(fx.calls.closeHandle).toEqual([handle])
  })

  it('存活句柄：死亡上报经主线程复验否决，零回收、句柄不关', () => {
    const handle = fx.add(0x1234, 1) // 未注入 signaled = 存活
    fx.reportDead([fx.keyOf(0x1234, 1)])
    expect(events.every((e) => e.kind !== 'reaped')).toBe(true)
    expect(fx.calls.closeHandle).toEqual([])
    expect(handle).toBe(0xabc00000 + 5001) // 夹具自洽哨兵
  })

  it('NIM_DELETE 摘账并关句柄，其后迟到的死亡通知幂等（不回收、不重复关）', () => {
    const handle = fx.add(0x1234, 1)
    fx.notify(2 /* NIM_DELETE */, 0x1234, 1)
    expect(fx.calls.closeHandle).toEqual([handle])
    fx.signaled.add(handle)
    fx.reportDead([fx.keyOf(0x1234, 1)])
    expect(events.every((e) => e.kind !== 'reaped')).toBe(true)
    expect(fx.calls.closeHandle).toEqual([handle]) // 不重复关
  })

  it('同宿主重复收编：同 key 重复 add 不重复开句柄（句柄仍指向同一进程对象）', () => {
    fx.add(0x1234, 1)
    fx.add(0x1234, 1, '重启实例')
    expect(fx.calls.openProcess).toEqual([[SYNCHRONIZE, false, 5001]])
    expect(fx.calls.closeHandle).toEqual([])
  })

  it('guid 键换宿主（应用重启）：同 key 旧句柄关闭，新宿主 pid 另开句柄', () => {
    const GUID = '00112233-4455-6677-8899-aabbccddeeff'
    const guidAdd = (hwnd: number): number => {
      const payload = encodeTrayPayload({
        arch: 'x64', version: 3, hwnd, uid: 1,
        flags: NIF_MESSAGE | NIF_TIP | 0x20 /* NIF_GUID */, callbackMessage: 0x8001, hicon: 0,
        tooltip: '重启实例', guid: GUID, dwMessage: 0 /* NIM_ADD */,
      })
      fx.send(payload)
      return 0xabc00000 + (fx.pids.get(hwnd) ?? 0) // 夹具句柄约定：0xabc00000 + pid
    }
    const oldHandle = guidAdd(0x1234) // pid 5001
    expect(fx.calls.openProcess).toEqual([[SYNCHRONIZE, false, 5001]])
    const newHandle = guidAdd(0x5678) // 同 guid key、新宿主 pid 5002
    expect(fx.calls.openProcess).toEqual([[SYNCHRONIZE, false, 5001], [SYNCHRONIZE, false, 5002]])
    expect(fx.calls.closeHandle).toEqual([oldHandle]) // 旧句柄先关，不泄漏
    // 新宿主死亡 → 回收照常，ownerPid 取新宿主
    fx.signaled.add(newHandle)
    fx.reportDead([`guid:${GUID}`])
    expect(events.filter((e) => e.kind === 'reaped')).toHaveLength(1)
    expect(events.find((e) => e.kind === 'reaped')?.ownerPid).toBe(5002)
  })

  it('重复死亡上报：只回收一次（单条 reaped），不重复关句柄', () => {
    const handle = fx.add(0x1234, 1)
    fx.signaled.add(handle)
    const key = fx.keyOf(0x1234, 1)
    fx.reportDead([key])
    fx.reportDead([key])
    expect(events.filter((e) => e.kind === 'reaped')).toHaveLength(1)
    expect(fx.calls.closeHandle).toEqual([handle])
  })

  it('stop：全部回收句柄幂等释放，二次 stop 不重复关', () => {
    const h1 = fx.add(0x1234, 1)
    const h2 = fx.add(0x5678, 2)
    fx.host.stop()
    expect(fx.calls.closeHandle.sort()).toEqual([h1, h2].sort())
    fx.host.stop()
    expect(fx.calls.closeHandle).toHaveLength(2)
    // 作废后回放全部寻不回（交还真托盘后登记全部作废，含回收句柄）
    expect(fx.host.replay(fx.keyOf(0x1234, 1), 'left').ok).toBe(false)
  })

  it('OpenProcess 拒收（权限/已死）：宁可漏收——不开监视、add 照发、不误报', () => {
    fx.calls.openProcess.length = 0
    const f = (fx.host as unknown as { f: Record<string, AnyFn> }).f
    f.openProcess = () => 0 // OpenProcess 失败返回 0
    fx.add(0x1234, 1)
    expect(events.map((e) => e.kind)).toEqual(['add'])
    fx.reportDead([fx.keyOf(0x1234, 1)])
    expect(events.every((e) => e.kind !== 'reaped')).toBe(true)
    expect(fx.calls.closeHandle).toEqual([])
  })
})

describe('TaskbarService 像素账（工单423：reaped 消费后条目与像素账同步清除）', () => {
  it('reaped 进服务：名单剔除、按条目像素取值清空（溢出重排随名单收敛）', () => {
    const svc = new TaskbarService(new Context(), {
      storeFile: join(tmpdir(), `deck-t423-${Date.now()}.json`),
      deps: { readStoreText: () => null, writeStoreText: () => {}, desktopItems: () => [], resolveShortcutTarget: () => null },
    })
    const addEvent: TrayWireEvent = {
      kind: 'add', key: '100:1', hwnd: '100', uid: 1, guid: null, tooltip: '探针',
      callbackMessage: 0x8001, version: 3, flags: NIF_MESSAGE | NIF_TIP, hicon: null,
      ownerPid: null, reapedAt: null, icon: PIX,
    }
    svc.onTrayEvent(addEvent)
    expect(svc.state().tray.map((i) => i.key)).toEqual(['100:1'])
    expect(svc.trayIconOf('100:1')).toEqual(PIX)
    svc.onTrayEvent(reapedTrayEvent('100:1', 5001, Date.now()))
    expect(svc.state().tray).toEqual([])
    expect(svc.trayIconOf('100:1')).toBeNull()
  })
})
