// 全屏让位（工单51，ADR-0007「工作区」决策）：检测到前台应用全屏（游戏、视频、演示）
// 时任务栏条带自动隐藏，退出全屏即恢复。
// 判定是纯谓词 shouldYieldToFullscreen（单测见 tests/taskbar/yield.spec.ts）；
// FFI 前台探针 lazy-bind（syskeys.ts 先例：模块加载不触 FFI，纯谓词测试不引 koffi）。
// 让位动作（条带 hide/show）由 taskbar/window.ts 控制器轮询驱动。

/** 物理像素矩形（GetWindowRect / 屏物理尺寸口径，非 DIP） */
export interface PhysRect {
  left: number
  top: number
  right: number
  bottom: number
}

/** 前台窗探针快照（FFI 采集，喂给纯谓词） */
export interface ForegroundProbe {
  hwnd: number
  pid: number
  className: string
  rect: PhysRect
}

/** 覆盖判定容差（px）：边框/圆角让全屏矩形与屏矩形有 1–2px 出入 */
const COVER_TOLERANCE = 2

/** 永不触发让位的桌面宿主类：桌面本体与原生任务栏的矩形常态即全屏/通栏 */
const DESKTOP_HOST_CLASSES: readonly string[] = [
  'Progman',
  'WorkerW',
  'Shell_TrayWnd',
  'Shell_SecondaryTrayWnd',
]

/**
 * 全屏让位判定：前台窗完整覆盖给定屏矩形（容差内）、非自家进程（面板本体被点击
 * 成前台时矩形即全屏）、非桌面宿主类。最大化窗在 AppBar 占位生效后底边停在栏上方，
 * 天然不满足覆盖——AppBar 注册失败的降级档由调用方整段关掉让位（最大化窗会
 * 覆盖全屏造成误判）。
 */
export function shouldYieldToFullscreen(
  probe: ForegroundProbe | null,
  screen: PhysRect,
  ownPid: number,
): boolean {
  if (!probe) return false
  if (probe.pid === ownPid) return false
  if (DESKTOP_HOST_CLASSES.includes(probe.className)) return false
  const r = probe.rect
  return r.left <= screen.left + COVER_TOLERANCE
    && r.top <= screen.top + COVER_TOLERANCE
    && r.right >= screen.right - COVER_TOLERANCE
    && r.bottom >= screen.bottom - COVER_TOLERANCE
}

interface KoffiFunc {
  (...args: unknown[]): unknown
}

interface Bound {
  getForegroundWindow: KoffiFunc
  getWindowRect: KoffiFunc
  getClassNameW: KoffiFunc
  getWindowThreadProcessId: KoffiFunc
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
  }
  return bound
}

/** 前台窗探针：句柄缺位/矩形读取失败返回 null（视同不让位——还原是安全方向） */
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
  return { hwnd, pid: pidBuf.readUInt32LE(0), className, rect }
}
