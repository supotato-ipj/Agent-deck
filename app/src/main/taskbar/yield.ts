// 全屏让位（工单51，ADR-0007「工作区」决策）：检测到前台应用全屏（游戏、视频、演示）
// 时任务栏条带自动隐藏，退出全屏即恢复。
// 判定谓词 shouldYieldToFullscreen **已退役**（工单249）：档位归 shared/retract 的
// resolveBarMode（单一裁决）；它只按矩形覆盖判、不排除真最大化窗，接回主进程即重引入
// 「两态互咬」。覆盖判定语义（容差/原点偏移）改由 shared/retract 的 coversScreenRect
// 钉住（单测见 tests/taskbar/retract.spec.ts）。FFI 前台探针 lazy-bind（syskeys.ts 先例：
// 模块加载不触 FFI，纯谓词测试不引 koffi）；让位动作由 taskbar/window.ts 控制器轮询驱动。
// 探针形状、桌面宿主排除名单与覆盖判定已搬进 shared/retract（工单237）——单一来源，
// 不许各抄一份；此处转出形状保持主进程侧引用路径不变（apps-plan.ts 同款先例）。

import { coversScreenRect, DESKTOP_HOST_CLASSES } from '../../shared/retract'
import type { ForegroundProbe, PhysRect } from '../../shared/retract'

export type { ForegroundProbe, PhysRect } from '../../shared/retract'

/**
 * **已退役**（工单249）：档位归 shared/retract 的 resolveBarMode（单一裁决）。最大化窗
 * 在 AppBar 占位生效后底边停在栏上方，天然不满足覆盖（AppBar 注册失败的降级档由调用方
 * 整段关掉让位）。**但它只按矩形覆盖判、不排除真最大化窗**——正是工单237 修正 A1 要防
 * 的那条：接回主进程即重引入「两态互咬」。保留导出只为覆盖判定语义仍有单测可依。
 */
export function shouldYieldToFullscreen(
  probe: ForegroundProbe | null,
  screen: PhysRect,
  ownPid: number,
): boolean {
  if (!probe) return false
  if (probe.pid === ownPid) return false
  if (DESKTOP_HOST_CLASSES.includes(probe.className)) return false
  return coversScreenRect(probe.rect, screen)
}

interface KoffiFunc {
  (...args: unknown[]): unknown
}

interface Bound {
  getForegroundWindow: KoffiFunc
  getWindowRect: KoffiFunc
  getClassNameW: KoffiFunc
  getWindowThreadProcessId: KoffiFunc
  /** 真最大化判据（工单241）：单次 user32 调用、语义精确——不用矩形覆盖法（手拉铺满误触发） */
  isZoomed: KoffiFunc
}

let bound: Bound | null = null

function bind(): Bound {
  if (bound) return bound
  const koffi = require('koffi')
  const user32 = koffi.load('user32.dll')
  koffi.struct('TASKBAR_YIELD_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' })
  bound = {
    getForegroundWindow: user32.func('uintptr_t __stdcall GetForegroundWindow()'),
    getWindowRect: user32.func('bool __stdcall GetWindowRect(uintptr_t hWnd, _Out_ TASKBAR_YIELD_RECT *r)'),
    getClassNameW: user32.func('int __stdcall GetClassNameW(uintptr_t hWnd, uint16 *buf, int nMax)'),
    getWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(uintptr_t hWnd, _Out_ uint32 *pid)'),
    isZoomed: user32.func('bool __stdcall IsZoomed(uintptr_t hWnd)'),
  }
  return bound
}

/**
 * 前台窗探针：句柄缺位/矩形读取失败返回 null（视同不让位——还原是安全方向）。
 *
 * zoomed = **真最大化**（Win32 IsZoomed 族，工单241 接真值）：单次 user32 调用、语义精确。
 * 不用矩形覆盖法——手拉四角铺满的窗不触发收栏（spec #236 用户故事 26「宁可遗漏，不用
 * 矩形法误触发」）；也不用 WS_MAXIMIZE 样式位——Win11 贴靠（snap）窗的语义与之不一致。
 * 已知边界：少数自绘边框应用最大化不上 IsZoomed 样式 ⇒ 这类窗**不触发**收栏（spec 明示接受）。
 *
 * 探针只供事实，不判两态关系——档位归 shared/retract 的 resolveBarMode（单一裁决）。
 */
export function probeForegroundWindow(): ForegroundProbe | null {
  const b = bind()
  const hwnd = Number(b.getForegroundWindow())
  if (!hwnd) return null
  const rect: PhysRect = { left: 0, top: 0, right: 0, bottom: 0 }
  if (!b.getWindowRect(hwnd, rect)) return null
  const buf = Buffer.alloc(512)
  const n = b.getClassNameW(hwnd, buf, 256) as number
  let className = ''
  for (let i = 0; i < n; i++) className += String.fromCharCode(buf.readUInt16LE(i * 2))
  const pidBuf = Buffer.alloc(4)
  b.getWindowThreadProcessId(hwnd, pidBuf)
  return { hwnd, pid: pidBuf.readUInt32LE(0), className, rect, zoomed: Boolean(b.isZoomed(hwnd)) }
}
