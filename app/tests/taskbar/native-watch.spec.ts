// 原生栏重申轮询（工单262，spec #258；工单308 M1 收紧——目标态恒 autohide-on）：每拍
// 检测 Shell_TrayWnd 重建（explorer 重启/热插拔）、可见性翻转，或置位读回丢失，命中即
// 重挂——压回 SW_HIDE 并重申置位目标。本测试钉的是纯裁决缝（NativeReassertMachine，
// 零 FFI——同 tray-yield 状态机与 yield 谓词的离线测法）；效果层（FFI 观察 + 重挂动作）
// 离线不可测，接线以源码级守卫钉住（retract-orchestration.spec.ts 控制器接线组同形），
// 真机走 51 电池 P10。
// M1（工单308，spec #306）：NativeWatchWant 的 'autohide-off' 支退役（托管期 auto-hide
// 恒置位，无「清位目标」这一态），poll 收敛单参签名；'clear' 分支随之退役。
import { describe, expect, it } from 'vitest'
import { NATIVE_WATCH_POLL_MS, NativeReassertMachine } from '../../src/main/taskbar/native-watch'

/** 探针快照构造（hwnd / 可见 / 置位在读回里） */
const P = (hwnd: number, visible: boolean, autoHideOn: boolean) => ({ hwnd, visible, autoHideOn })

describe('原生栏重申轮询（工单262 纯裁决缝；M1 目标态恒置位）', () => {
  it('轮询间隔落在 1–2s 低频档（1000ms——检测时延 ≤1 拍 + 动作耗时）', () => {
    expect(NATIVE_WATCH_POLL_MS).toBeGreaterThanOrEqual(1000)
    expect(NATIVE_WATCH_POLL_MS).toBeLessThanOrEqual(2000)
  })

  it('起拍基线：begin 以当拍观察为基线，随后同貌一拍不动作（不误报重建/翻转）', () => {
    const m = new NativeReassertMachine()
    m.begin(P(0x111, false, true))
    expect(m.poll(P(0x111, false, true))).toEqual({ action: 'none' })
  })

  it('未起拍先 poll（防御路径）：以当拍为基线，不动作', () => {
    const m = new NativeReassertMachine()
    expect(m.poll(P(0x111, false, true))).toEqual({ action: 'none' })
    expect(m.poll(P(0x111, false, true))).toEqual({ action: 'none' })
  })

  it('窗口重建（hwnd 变了）：重挂——reason=rebuild，可见即压、置位丢失即补', () => {
    const m = new NativeReassertMachine()
    m.begin(P(0x111, false, true))
    // explorer 重启后的新窗：可见 + 置位丢失（注册表原态，spike：SETSTATE 不回写）
    expect(m.poll(P(0x222, true, false))).toEqual({
      action: 'reattach', reason: 'rebuild', hide: true, autoHide: 'engage',
    })
  })

  it('重建后同貌一拍：回清净（重挂是一次性动作，不逐拍重复）', () => {
    const m = new NativeReassertMachine()
    m.begin(P(0x111, false, true))
    m.poll(P(0x222, true, false)) // 重挂
    expect(m.poll(P(0x222, false, true))).toEqual({ action: 'none' })
  })

  it('explorer 缺位间隙（hwnd=0）：不动作（无从压无从置），窗口归位（任意 hwnd，含复用旧值）算重建', () => {
    const m = new NativeReassertMachine()
    m.begin(P(0x111, false, true))
    expect(m.poll(P(0, false, false))).toEqual({ action: 'none' })
    // 归位窗口即使复用旧句柄值（基线已被间隙清零）也算重建：新窗按事实重挂
    expect(m.poll(P(0x111, true, false))).toEqual({
      action: 'reattach', reason: 'rebuild', hide: true, autoHide: 'engage',
    })
  })

  it('可见性翻转（同 hwnd、窗被翻开）：压回——reason=visible，置位已在位则只压不重置', () => {
    const m = new NativeReassertMachine()
    m.begin(P(0x111, false, true))
    expect(m.poll(P(0x111, true, true))).toEqual({
      action: 'reattach', reason: 'visible', hide: true, autoHide: null,
    })
  })

  it('置位丢失（同 hwnd、窗仍隐、读回无 AUTOHIDE）：重申置位——reason=autohide-mismatch', () => {
    const m = new NativeReassertMachine()
    m.begin(P(0x111, false, true))
    expect(m.poll(P(0x111, false, false))).toEqual({
      action: 'reattach', reason: 'autohide-mismatch', hide: false, autoHide: 'engage',
    })
  })

  it('同貌（窗隐、置位在位）：不动作（值守不制造常态动作——M1 目标态唯一，无清位值守面）', () => {
    const m = new NativeReassertMachine()
    m.begin(P(0x111, false, true))
    expect(m.poll(P(0x111, false, true))).toEqual({ action: 'none' })
    expect(m.poll(P(0x111, false, true))).toEqual({ action: 'none' })
  })

  it('重申动作只有 engage 一档（M1：autoHide 决策不存在 clear 支）', () => {
    const m = new NativeReassertMachine()
    m.begin(P(0x111, false, false))
    const d = m.poll(P(0x111, false, false))
    if (d.action === 'reattach') {
      expect(d.autoHide === 'engage' || d.autoHide === null).toBe(true)
    }
    // 置位丢失拍必带 engage
    expect(m.poll(P(0x111, false, false))).toMatchObject({ autoHide: 'engage' })
  })

  it('归因优先级：重建 > 可见 > 置位不符（三者同拍命中时报最重的因）', () => {
    const m = new NativeReassertMachine()
    m.begin(P(0x111, false, true))
    const d1 = m.poll(P(0x222, true, true))
    expect(d1.action === 'reattach' && d1.reason).toBe('rebuild')
    // 间隙清零后再起：同 hwnd 翻开 + 置位不符 → 归因可见（重挂动作两样都做）
    expect(m.poll(P(0, false, true))).toEqual({ action: 'none' })
    expect(m.poll(P(0x333, true, false))).toMatchObject({ reason: 'rebuild', hide: true, autoHide: 'engage' })
  })

  it('reset 回未武装态（拆场）：此后 poll 重立基线不动作（值守停表后的机内面）', () => {
    const m = new NativeReassertMachine()
    m.begin(P(0x111, false, true))
    m.reset()
    expect(m.poll(P(0x222, true, false))).toEqual({ action: 'none' }) // 重立基线，不重挂
    expect(m.poll(P(0x222, true, true))).toEqual({
      action: 'reattach', reason: 'visible', hide: true, autoHide: null,
    })
  })
})
