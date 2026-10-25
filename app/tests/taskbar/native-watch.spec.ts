// 原生栏重申轮询（工单262，spec #258；ADR-0016 修订记 2026-10-25 双缺陷复审 Q1/Q2 把
// 值守扩为**全接管期**）：每拍检测 Shell_TrayWnd 重建（explorer 重启/热插拔）、可见性
// 翻转，或 appbar 目标档位与读回不符，命中即重挂——压回 SW_HIDE 并把当前档位的目标压回
// （普通档清位、收栏档置位）。本测试钉的是纯裁决缝（NativeReassertMachine，零 FFI——
// 同 tray-yield 状态机与 yield 谓词的离线测法）；效果层（FFI 观察 + 重挂动作）离线不可测，
// 接线以源码级守卫钉住（retract-orchestration.spec.ts 控制器接线组同形），真机走 51 电池。
import { describe, expect, it } from 'vitest'
import { NATIVE_WATCH_POLL_MS, NativeReassertMachine } from '../../src/main/taskbar/native-watch'

/** 探针快照构造（hwnd / 可见 / 置位在读回里） */
const P = (hwnd: number, visible: boolean, autoHideOn: boolean) => ({ hwnd, visible, autoHideOn })
/** 收栏档目标：appbar 状态应置位（自动隐藏开） */
const ON = 'autohide-on' as const
/** 普通档目标：appbar 状态应清位（自动隐藏关） */
const OFF = 'autohide-off' as const

describe('原生栏重申轮询（工单262 纯裁决缝；双缺陷复审扩为全接管期）', () => {
  it('轮询间隔落在 1–2s 低频档（1000ms——检测时延 ≤1 拍 + 动作耗时）', () => {
    expect(NATIVE_WATCH_POLL_MS).toBeGreaterThanOrEqual(1000)
    expect(NATIVE_WATCH_POLL_MS).toBeLessThanOrEqual(2000)
  })

  it('起拍基线：begin 以当拍观察为基线，随后同貌一拍不动作（不误报重建/翻转）', () => {
    const m = new NativeReassertMachine()
    m.begin(P(0x111, false, true))
    expect(m.poll(P(0x111, false, true), ON)).toEqual({ action: 'none' })
  })

  it('未起拍先 poll（防御路径）：以当拍为基线，不动作', () => {
    const m = new NativeReassertMachine()
    expect(m.poll(P(0x111, false, true), ON)).toEqual({ action: 'none' })
    expect(m.poll(P(0x111, false, true), ON)).toEqual({ action: 'none' })
  })

  it('窗口重建（hwnd 变了）：重挂——reason=rebuild，可见即压、档位不符即补', () => {
    const m = new NativeReassertMachine()
    m.begin(P(0x111, false, true))
    // explorer 重启后的新窗：可见 + 置位丢失（注册表原态，spike：SETSTATE 不回写）
    expect(m.poll(P(0x222, true, false), ON)).toEqual({
      action: 'reattach', reason: 'rebuild', hide: true, autoHide: 'engage',
    })
  })

  it('重建后同貌一拍：回清净（重挂是一次性动作，不逐拍重复）', () => {
    const m = new NativeReassertMachine()
    m.begin(P(0x111, false, true))
    m.poll(P(0x222, true, false), ON) // 重挂
    expect(m.poll(P(0x222, false, true), ON)).toEqual({ action: 'none' })
  })

  it('explorer 缺位间隙（hwnd=0）：不动作（无从压无从置），窗口归位（任意 hwnd，含复用旧值）算重建', () => {
    const m = new NativeReassertMachine()
    m.begin(P(0x111, false, true))
    expect(m.poll(P(0, false, false), ON)).toEqual({ action: 'none' })
    // 归位窗口即使复用旧句柄值（基线已被间隙清零）也算重建：新窗按事实重挂
    expect(m.poll(P(0x111, true, false), ON)).toEqual({
      action: 'reattach', reason: 'rebuild', hide: true, autoHide: 'engage',
    })
  })

  it('可见性翻转（同 hwnd、窗被翻开）：压回——reason=visible，档位已在位则只压不重置', () => {
    const m = new NativeReassertMachine()
    m.begin(P(0x111, false, true))
    expect(m.poll(P(0x111, true, true), ON)).toEqual({
      action: 'reattach', reason: 'visible', hide: true, autoHide: null,
    })
  })

  it('收栏档置位丢失（同 hwnd、窗仍隐）：重申置位——reason=autohide-mismatch', () => {
    const m = new NativeReassertMachine()
    m.begin(P(0x111, false, true))
    expect(m.poll(P(0x111, false, false), ON)).toEqual({
      action: 'reattach', reason: 'autohide-mismatch', hide: false, autoHide: 'engage',
    })
  })

  it('普通档清位被冲掉（explorer 按注册表复活用户自动隐藏）：重申清位——autoHide=clear', () => {
    const m = new NativeReassertMachine()
    m.begin(P(0x111, false, false))
    expect(m.poll(P(0x111, false, true), OFF)).toEqual({
      action: 'reattach', reason: 'autohide-mismatch', hide: false, autoHide: 'clear',
    })
  })

  it('普通档同貌（窗隐、清位在位）：不动作（全接管期值守不制造常态动作）', () => {
    const m = new NativeReassertMachine()
    m.begin(P(0x111, false, false))
    expect(m.poll(P(0x111, false, false), OFF)).toEqual({ action: 'none' })
    expect(m.poll(P(0x111, false, false), OFF)).toEqual({ action: 'none' })
  })

  it('归因优先级：重建 > 可见 > 档位不符（三者同拍命中时报最重的因）', () => {
    const m = new NativeReassertMachine()
    m.begin(P(0x111, false, true))
    const d1 = m.poll(P(0x222, true, true), ON)
    expect(d1.action === 'reattach' && d1.reason).toBe('rebuild')
    // 间隙清零后再起：同 hwnd 翻开 + 档位不符 → 归因可见（重挂动作两样都做）
    expect(m.poll(P(0, false, true), ON)).toEqual({ action: 'none' })
    expect(m.poll(P(0x333, true, false), ON)).toMatchObject({ reason: 'rebuild', hide: true, autoHide: 'engage' })
  })

  it('reset 回未武装态（拆场）：此后 poll 重立基线不动作（值守停表后的机内面）', () => {
    const m = new NativeReassertMachine()
    m.begin(P(0x111, false, true))
    m.reset()
    expect(m.poll(P(0x222, true, false), ON)).toEqual({ action: 'none' }) // 重立基线，不重挂
    expect(m.poll(P(0x222, true, true), ON)).toEqual({
      action: 'reattach', reason: 'visible', hide: true, autoHide: null,
    })
  })
})
