// 任务栏系统动作（工单49/55）：按键合成触发原生系统 UI——开始菜单 = Win 单击，
// 任务视图 = Win+Tab，通知中心 = Win+N（时钟格），快速设置 = Win+A（音量格），
// 显示桌面 = Win+D（屏幕最右端细条）。一律不自绘系统浮层（ADR-0007「系统动作」决策）。
// koffi 延迟绑定（focus/adapter.ts 先例）：模块加载不触 FFI，契约测试注入假源后
// 本模块从不被 require。INPUT 结构体形态与 accept/lib/win32.js 的实证定义同形
// （x64 sizeof(INPUT)=40）；结构体名带 TASKBAR_ 前缀避免与电池进程内的定义撞名。
import type { TaskbarSystemAction } from '../../shared/contract'

const INPUT_KEYBOARD = 1
const KEYDOWN = 0x0000
const KEYUP = 0x0002
const VK_LWIN = 0x5b
const VK_TAB = 0x09
const VK_A = 0x41
const VK_D = 0x44
const VK_N = 0x4e

interface KoffiFunc {
  (...args: unknown[]): unknown
}

interface Bound {
  sendInput: KoffiFunc
  sizeofInput: number
  keyInput: (vk: number, flags: number) => unknown
}

let bound: Bound | null = null

function bind(): Bound {
  if (bound) return bound
  const koffi = require('koffi')
  const user32 = koffi.load('user32.dll')
  // 联合必须带 MOUSEINPUT（32B 成员）——缺它 sizeof(INPUT)=32 ≠ 系统期望的 40，
  // SendInput 直接拒收全序列（49 首跑实证：P4/P5 点击到达但系统无动作）。
  const MOUSEINPUT = koffi.struct('TASKBAR_MOUSEINPUT', {
    dx: 'long', dy: 'long', mouseData: 'uint32', dwFlags: 'uint32',
    time: 'uint32', dwExtraInfo: 'uintptr_t',
  })
  const KEYBDINPUT = koffi.struct('TASKBAR_KEYBDINPUT', {
    wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32',
    time: 'uint32', dwExtraInfo: 'uintptr_t',
  })
  const INPUTUNION = koffi.union('TASKBAR_INPUT_U', { mi: MOUSEINPUT, ki: KEYBDINPUT })
  const INPUT = koffi.struct('TASKBAR_INPUT', { type: 'uint32', u: INPUTUNION })
  const sizeofInput = koffi.sizeof(INPUT) as number
  const expect = process.arch === 'x64' ? 40 : 24
  if (sizeofInput !== expect) throw new Error(`INPUT 结构尺寸异常: ${sizeofInput} != ${expect}`)
  bound = {
    sendInput: user32.func('int __stdcall SendInput(int cInputs, TASKBAR_INPUT *pInputs, int cbSize)'),
    sizeofInput,
    keyInput: (vk, flags) => ({
      type: INPUT_KEYBOARD,
      u: { ki: { wVk: vk, wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    }),
  }
  return bound
}

/** 按键合成真源：一次 SendInput 提交完整序列。返回 false = 系统拒收（UIPI/注入锁）。
 * 未知动作同样返回 false——上游 SYSTEM_ACTIONS 已校验，真源再设一道防，不把
 * 未识别值默认成 Win+Tab。 */
export function sendSystemAction(action: TaskbarSystemAction): boolean {
  const b = bind()
  const chord = (vk: number) => [
    b.keyInput(VK_LWIN, KEYDOWN), b.keyInput(vk, KEYDOWN), b.keyInput(vk, KEYUP), b.keyInput(VK_LWIN, KEYUP),
  ]
  let seq: unknown[]
  if (action === 'start-menu') {
    seq = [b.keyInput(VK_LWIN, KEYDOWN), b.keyInput(VK_LWIN, KEYUP)]
  } else if (action === 'task-view') {
    seq = chord(VK_TAB)
  } else if (action === 'notification-center') {
    seq = chord(VK_N)
  } else if (action === 'quick-settings') {
    seq = chord(VK_A)
  } else if (action === 'toggle-desktop') {
    seq = chord(VK_D)
  } else {
    return false
  }
  const sent = b.sendInput(seq.length, seq, b.sizeofInput) as number
  return sent === seq.length
}
