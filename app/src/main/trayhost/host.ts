// 托盘宿主效果层（工单48 路线 C spike）：注册与系统同名的 Shell_TrayWnd 竞争窗口
// 并维持置顶赢下 WM_COPYDATA 投递，PeekMessage 非阻塞泵挂在定时器上（与热区轮询
// 同模式），广播 TaskbarCreated 收编存量图标，解析真实 NIM_* 流量并提取图标像素。
// 压成无分支薄壳：字节 → trayhost/protocol 纯解码；像素修复 → trayhost/pixels。
// 本文件只在数据面子进程加载（koffi 延迟绑定，离线测试不触）。
import { COPYDATA_TRAY, decodeTrayPayload, packTrayClick, toTrayEvent, type TrayClickButton, type TrayIconPixels, type TrayWireEvent } from './protocol'
import { fixIconAlpha, maskRowStride } from './pixels'

const WM_COPYDATA = 0x004a
const PM_REMOVE = 0x0001
const HWND_TOPMOST = -1
const HWND_BROADCAST = 0xffff
const SWP_NOMOVE = 0x0002
const SWP_NOSIZE = 0x0001
const SWP_NOACTIVATE = 0x0010
const SWP_NOOWNERZORDER = 0x0200
const WS_POPUP = 0x80000000
const WS_EX_TOOLWINDOW = 0x80
const WS_EX_NOACTIVATE = 0x08000000
const DIB_RGB_COLORS = 0

export interface TrayCorpusEntry {
  t: number
  dwData: number
  cbData: number
  hex: string
}

export interface TrayHostOptions {
  /** 规范化托盘事件出口（数据面入口转发 parentPort） */
  onEvent: (e: TrayWireEvent) => void
  /** 原始字节语料（真机捕获 → 测试夹具） */
  corpus?: (entry: TrayCorpusEntry) => void
  /** 生命周期/竞争态势存证 */
  log?: (e: Record<string, unknown>) => void
  /** PeekMessage 泵间隔（默认 25ms，与热区轮询同量级） */
  pumpIntervalMs?: number
  /** 置顶维持间隔（默认 2000ms；Z 序竞争需定时重申，ADR-0007 残余风险） */
  topmostIntervalMs?: number
}

export interface TrayHostInfo {
  hwnd: number
  /** 我们注册前的原 Shell_TrayWnd（explorer 真托盘；转发不消费消息用） */
  realTrayHwnd: number | null
  taskbarCreatedMsg: number
}

/** 托盘条目登记（工单56 点击回放用）：回调负载的地址与版本由图标所属应用的
 * NIM_ADD 协商决定，回放时必须原样复现——缓存随事件流维护，不重新解析 */
interface TrayEntry {
  hwnd: number
  uid: number
  guid: string | null
  callbackMessage: number
  /** 应用协商的 NOTIFYICON_VERSION（未协商为 0，按旧版负载语义回放） */
  version: number
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyFn = (...args: any[]) => any

export class TrayHost {
  private f: Record<string, AnyFn> = {}
  private hwnd = 0
  private realTrayHwnd: number | null = null
  private taskbarCreatedMsg = 0
  private wndproc: unknown = null // 持住防 GC
  private pumpTimer: NodeJS.Timeout | null = null
  private topmostTimer: NodeJS.Timeout | null = null
  private msgBuf: Buffer | null = null
  private hdc = 0
  private stopped = false
  /** 托盘条目登记（工单56）：key → 回放所需的地址与协商版本；删除事件同步摘除 */
  private readonly entries = new Map<string, TrayEntry>()

  constructor(private readonly options: TrayHostOptions) {}

  start(): TrayHostInfo {
    const koffi = require('koffi')
    const user32 = koffi.load('user32.dll')
    const gdi32 = koffi.load('gdi32.dll')
    const kernel32 = koffi.load('kernel32.dll')

    koffi.proto('__stdcall', 'TrayWndProc', 'intptr_t', ['uintptr_t', 'uint32', 'uintptr_t', 'intptr_t'])
    const WNDCLASSEXW = koffi.struct('WNDCLASSEXW', {
      cbSize: 'uint32', style: 'uint32', lpfnWndProc: 'TrayWndProc *',
      cbClsExtra: 'int32', cbWndExtra: 'int32', hInstance: 'uintptr_t',
      hIcon: 'uintptr_t', hCursor: 'uintptr_t', hbrBackground: 'uintptr_t',
      lpszMenuName: 'uintptr_t', lpszClassName: 'char16_t *', hIconSm: 'uintptr_t',
    })

    this.f = {
      registerClass: user32.func('uint16 __stdcall RegisterClassExW(WNDCLASSEXW *wc)'),
      createWindow: user32.func('uintptr_t __stdcall CreateWindowExW(uint32 ex, const char16_t *cls, const char16_t *name, uint32 style, int x, int y, int w, int h, uintptr_t parent, uintptr_t menu, uintptr_t hinst, uintptr_t param)'),
      destroyWindow: user32.func('bool __stdcall DestroyWindow(uintptr_t hWnd)'),
      findWindow: user32.func('uintptr_t __stdcall FindWindowW(const char16_t *cls, const char16_t *name)'),
      setWindowPos: user32.func('bool __stdcall SetWindowPos(uintptr_t hWnd, intptr_t after, int x, int y, int cx, int cy, uint32 flags)'),
      peekMessage: user32.func('bool __stdcall PeekMessageW(void *msg, uintptr_t hWnd, uint32 min, uint32 max, uint32 remove)'),
      translateMessage: user32.func('bool __stdcall TranslateMessage(const void *msg)'),
      dispatchMessage: user32.func('intptr_t __stdcall DispatchMessageW(const void *msg)'),
      defWindowProc: user32.func('intptr_t __stdcall DefWindowProcW(uintptr_t hWnd, uint32 msg, uintptr_t wp, intptr_t lp)'),
      registerWindowMessage: user32.func('uint32 __stdcall RegisterWindowMessageW(const char16_t *name)'),
      postMessage: user32.func('bool __stdcall PostMessageW(uintptr_t hWnd, uint32 msg, uintptr_t wp, intptr_t lp)'),
      sendMessage: user32.func('intptr_t __stdcall SendMessageW(uintptr_t hWnd, uint32 msg, uintptr_t wp, intptr_t lp)'),
      // GDI 句柄是 32 位值（x64 上也是），但高位可能置 1；koffi 的 uintptr_t 通道会把
      // ≥2^31 的 JS number 符号扩展成 0xFFFFFFFF… 遭 GDI 拒绝（真机实证 error 87）——
      // 句柄参数/返回值一律声明 uint32，强制零扩展
      getDC: user32.func('uint32 __stdcall GetDC(uintptr_t hWnd)'),
      releaseDC: user32.func('int __stdcall ReleaseDC(uintptr_t hWnd, uint32 hdc)'),
      getIconInfo: user32.func('bool __stdcall GetIconInfo(uint32 hIcon, void *ii)'),
      copyIcon: user32.func('uint32 __stdcall CopyIcon(uint32 hIcon)'),
      destroyIcon: user32.func('bool __stdcall DestroyIcon(uint32 hIcon)'),
      getObject: gdi32.func('int __stdcall GetObjectW(uint32 h, int cb, void *out)'),
      getDIBits: gdi32.func('int __stdcall GetDIBits(uint32 hdc, uint32 hbm, uint32 start, uint32 lines, void *bits, void *bi, uint32 usage)'),
      deleteObject: gdi32.func('bool __stdcall DeleteObject(uint32 h)'),
      getModuleHandle: kernel32.func('uintptr_t __stdcall GetModuleHandleW(uintptr_t name)'),
      // 点击回放（工单56）：AllowSetForegroundWindow 放行图标所属应用弹自己的菜单
      // （我们抢了托盘前台权，应用默认收不到 SetForegroundWindow 许可）；GetCursorPos
      // 取光标位置供 v4 负载的 MAKELPARAM 语义。
      allowSetForegroundWindow: user32.func('bool __stdcall AllowSetForegroundWindow(uintptr_t hWnd)'),
      getCursorPos: user32.func('bool __stdcall GetCursorPos(void *pt)'),
      // 外来指针的安全读取：ReadProcessMemory 读失败返回 false 而非访问违例崩溃——
      // WM_COPYDATA 被 Post/SendNotify 投递时 lpData 是发送方地址空间的悬垂指针
      // （真机实证：HRMAINTRAY 类应用的投递即如此），memcpy 直读即 0xC0000005。
      readProcessMemory: kernel32.func('bool __stdcall ReadProcessMemory(intptr_t hProcess, uintptr_t addr, void *buf, size_t n, void *read)'),
      getLastError: kernel32.func('uint32 __stdcall GetLastError()'),
    }

    // 注册前先记下真托盘（转发不消费消息 + 互斥侦察）：此刻 FindWindow 命中的是现役宿主
    const prior = Number(this.f.findWindow('Shell_TrayWnd', null))
    this.realTrayHwnd = prior || null

    this.wndproc = koffi.register((h: number, msg: number, wp: number, lp: number | bigint) => this.onWndProc(h, msg, wp, lp), 'TrayWndProc *')
    const hinst = Number(this.f.getModuleHandle(0))
    const atom = this.f.registerClass({
      cbSize: koffi.sizeof(WNDCLASSEXW), style: 0, lpfnWndProc: this.wndproc,
      cbClsExtra: 0, cbWndExtra: 0, hInstance: hinst,
      hIcon: 0, hCursor: 0, hbrBackground: 0,
      lpszMenuName: 0, lpszClassName: 'Shell_TrayWnd', hIconSm: 0,
    })
    if (!atom) throw new Error('RegisterClassExW(Shell_TrayWnd) 失败')

    // 必须是非消息窗的顶层窗（HWND_MESSAGE 不被 FindWindow 枚举）；0 尺寸、隐藏、不激活
    this.hwnd = Number(this.f.createWindow(
      WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, 'Shell_TrayWnd', 'Shell_TrayWnd', WS_POPUP,
      0, 0, 0, 0, 0, 0, hinst, 0,
    ))
    if (!this.hwnd) throw new Error('CreateWindowExW(Shell_TrayWnd) 失败')

    this.taskbarCreatedMsg = Number(this.f.registerWindowMessage('TaskbarCreated'))
    this.msgBuf = Buffer.alloc(48) // MSG x64
    this.hdc = this.f.getDC(0)

    this.assertTopmost('start')
    // 广播 TaskbarCreated 收编存量图标（响应此广播的应用会重发 NIM_ADD 到我们）
    this.f.postMessage(HWND_BROADCAST, this.taskbarCreatedMsg, 0, 0)

    this.pumpTimer = setInterval(() => this.pump(), this.options.pumpIntervalMs ?? 25)
    this.topmostTimer = setInterval(() => this.assertTopmost('keepalive'), this.options.topmostIntervalMs ?? 2000)
    this.options.log?.({ type: 'tray-host-ready', hwnd: this.hwnd, realTrayHwnd: this.realTrayHwnd, taskbarCreatedMsg: this.taskbarCreatedMsg })
    return { hwnd: this.hwnd, realTrayHwnd: this.realTrayHwnd, taskbarCreatedMsg: this.taskbarCreatedMsg }
  }

  /** 拆窗 + 广播 TaskbarCreated 交还真托盘（响应广播的应用重新注册回 explorer） */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    if (this.pumpTimer) clearInterval(this.pumpTimer)
    if (this.topmostTimer) clearInterval(this.topmostTimer)
    try {
      if (this.hwnd) this.f.destroyWindow(this.hwnd)
      if (this.taskbarCreatedMsg) this.f.postMessage(HWND_BROADCAST, this.taskbarCreatedMsg, 0, 0)
      if (this.hdc) this.f.releaseDC(0, this.hdc)
    } catch { /* 尽力拆 */ }
    this.options.log?.({ type: 'tray-host-stopped', hwnd: this.hwnd })
    this.hwnd = 0
    this.entries.clear() // 交还真托盘后登记全部作废（图标将向 explorer 重新注册）
  }

  private assertTopmost(why: string): void {
    if (!this.hwnd) return
    this.f.setWindowPos(this.hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER)
    const win = Number(this.f.findWindow('Shell_TrayWnd', null)) === this.hwnd
    this.options.log?.({ type: 'tray-competition', why, win })
  }

  /** 非阻塞泵：抽干**本窗**队列即返回；跨进程 SendMessage（WM_COPYDATA）在 PeekMessage
   * 内被派发到 WndProc。hWnd 必须传本窗：传 0 会连 Chromium 自己那条线程队列一起抽干，
   * 把 Electron 的窗口消息、线程消息乃至 WM_QUIT 都从它的泵里抢走（真机征候：面板
   * 主线程停摆不再回消息、退出段收不到 quit 存证）。托盘窗是本进程唯一要自己泵的窗。 */
  private pump(): void {
    if (!this.msgBuf || !this.hwnd) return
    try {
      while (this.f.peekMessage(this.msgBuf, this.hwnd, 0, 0, PM_REMOVE)) {
        this.f.translateMessage(this.msgBuf)
        this.f.dispatchMessage(this.msgBuf)
      }
    } catch (err) {
      this.options.log?.({ type: 'tray-pump-error', message: (err as Error).message })
    }
  }

  private onWndProc(hwnd: number, msg: number, wparam: number, lparam: number | bigint): number {
    if (msg !== WM_COPYDATA) return Number(this.f.defWindowProc(hwnd, msg, wparam, lparam))
    try {
      return this.onCopyData(wparam, lparam)
    } catch (err) {
      this.options.log?.({ type: 'tray-copydata-error', message: (err as Error).message })
      return 0
    }
  }

  /**
   * 外来指针的安全读取（ReadProcessMemory，伪句柄 -1 = 本进程）：读失败返回 null
   * 而非访问违例崩溃——WM_COPYDATA 被 Post/SendNotify 投递时 lpData 是发送方地址
   * 空间的悬垂指针（真机实证：HRMAINTRAY 类应用的投递即如此），memcpy 直读即
   * 0xC0000005 崩掉整个数据面子进程。
   */
  private safeRead(addr: number | bigint, len: number): Buffer | null {
    const buf = Buffer.alloc(len)
    return this.f.readProcessMemory(-1, addr, buf, len, 0) ? buf : null
  }

  private onCopyData(wparam: number, lparam: number | bigint): number {
    // COPYDATASTRUCT x64：dwData(8) + cbData(4+4pad) + lpData(8) = 24 字节
    const cds = this.safeRead(lparam, 24)
    if (!cds) {
      // 读不到说明是 Post 来的悬垂指针（Send 会被系统编组进本进程，必然可读），
      // Post 调用方不等返回值——与 payload 不可读同语义报「已处理」，不当黑洞也不报错
      this.options.log?.({ type: 'tray-copydata-unreadable', what: 'cds', wparam })
      return 1
    }
    const dwData = Number(cds.readBigUInt64LE(0))
    const cbData = cds.readUInt32LE(8)
    const lpData = cds.readBigUInt64LE(16)
    if (dwData !== COPYDATA_TRAY) {
      // 不消费的消息（AppBar dwData=3 等）原样转发给真托盘——竞争窗口不当黑洞
      if (this.realTrayHwnd) return Number(this.f.sendMessage(this.realTrayHwnd, WM_COPYDATA, wparam, lparam))
      return 0
    }
    if (cbData <= 0 || cbData > 4096) return 1
    const payload = this.safeRead(lpData, cbData)
    if (!payload) {
      this.options.log?.({ type: 'tray-copydata-unreadable', what: 'payload', wparam, cbData })
      return 1
    }
    this.options.corpus?.({ t: Date.now(), dwData, cbData, hex: payload.toString('hex') })
    const decoded = decodeTrayPayload(payload)
    if (!decoded) {
      this.options.log?.({ type: 'tray-payload-unparsed', cbData, cbSizeX86: payload.length >= 8 ? payload.readUInt32LE(4) : null, cbSizeX64: payload.length >= 12 ? payload.readUInt32LE(8) : null })
      return 1
    }
    const event = toTrayEvent(decoded)
    if ((event.kind === 'add' || event.kind === 'update') && event.hicon) {
      event.icon = this.extractIcon(Number(event.hicon))
    }
    this.remember(event)
    this.options.onEvent(event)
    return 1 // Shell_NotifyIcon 的成功语义：WM_COPYDATA 返回 TRUE
  }

  /**
   * 条目登记（工单56）：点击回放的负载由应用协商版本决定，登记随事件流维护——
   * add/update 覆盖（version 协商事件同样覆盖，只改版本字段），delete 摘除，
   * 其余事件（setfocus/unknown）不动。stop 清空（交还真托盘后登记全部作废）。
   */
  private remember(event: TrayWireEvent): void {
    if (event.kind === 'delete') {
      this.entries.delete(event.key)
      return
    }
    if (event.kind === 'version') {
      const prev = this.entries.get(event.key)
      if (prev) this.entries.set(event.key, { ...prev, version: event.version })
      return
    }
    if (event.kind !== 'add' && event.kind !== 'update') return
    const prev = this.entries.get(event.key)
    this.entries.set(event.key, {
      hwnd: Number(event.hwnd),
      uid: event.uid,
      guid: event.guid,
      // 未带 NIF_MESSAGE 的部分更新不覆盖既有回调消息（部分更新语义同 tooltip）
      callbackMessage: event.callbackMessage || (prev?.callbackMessage ?? 0),
      version: event.version || (prev?.version ?? 0),
    })
  }

  /**
   * 点击回放（工单56）：按登记的协商版本合成回调负载，投递到图标所属窗口。
   * 投递前放行前台权——应用靠它弹菜单（我们持托盘前台权时系统默认拒收）。
   * 未知 key = 图标已退场或登记缺失，按普通失败回报不抛（点击语义不需 try/catch）。
   */
  replay(key: string, button: TrayClickButton): { ok: boolean; error?: string } {
    const entry = this.entries.get(key)
    if (!entry || !entry.callbackMessage) {
      const error = '托盘图标不在场（未登记或未协商回调消息）'
      this.options.log?.({ type: 'tray-replay-miss', key, button, known: this.entries.size })
      return { ok: false, error }
    }
    const pt = Buffer.alloc(8) // POINT x64：两个 LONG，无填充
    if (!this.f.getCursorPos(pt)) {
      const error = '取光标位置失败，托盘点击未回放'
      this.options.log?.({ type: 'tray-replay-fail', stage: 'GetCursorPos', key, button, lastError: this.f.getLastError() })
      return { ok: false, error }
    }
    const pack = packTrayClick(entry, button, { x: pt.readInt32LE(0), y: pt.readInt32LE(4) })
    this.f.allowSetForegroundWindow(entry.hwnd)
    const posted = Boolean(this.f.postMessage(entry.hwnd, pack.message, pack.wparam, pack.lparam))
    this.options.log?.({ type: 'tray-replay', key, button, hwnd: entry.hwnd, uid: entry.uid, version: entry.version, ...pack, posted })
    return posted ? { ok: true } : { ok: false, error: '回调投递被系统拒收' }
  }

  /** HICON → 32bpp 顶向下 BGRA 像素（alpha 修复走纯函数）。GetIconInfo 位图归我们销毁。 */
  private extractIcon(hicon: number): TrayIconPixels | null {
    const fail = (stage: string, extra?: Record<string, unknown>): null => {
      this.options.log?.({ type: 'tray-icon-extract-fail', stage, hicon, hCopy, lastError: this.f.getLastError(), ...extra })
      return null
    }
    const ii = Buffer.alloc(32) // ICONINFO x64：fIcon/xHotspot/yHotspot(12+4pad) + hbmMask + hbmColor
    // 共享图标（LR_SHARED，Electron 托盘图标即此类）的位图句柄属发送方进程，
    // 直接 GetObject 遭拒（真机实证 error 5）——先 CopyIcon 换一份本进程副本再取信息
    const hCopy = this.f.copyIcon(hicon)
    const hUse = hCopy || hicon
    try {
      if (!this.f.getIconInfo(hUse, ii)) return fail('GetIconInfo')
      // ICONINFO x64：fIcon(0) xHotspot(4) yHotspot(8) pad(12) hbmMask(16) hbmColor(24)。
      // GDI 句柄 32 位，x64 结构里可能符号扩展，取低 32 位（真机实证 0xFFFFF… 高位垃圾）
      const hbmMask = Number(ii.readBigUInt64LE(16) & 0xffffffffn)
      const hbmColor = Number(ii.readBigUInt64LE(24) & 0xffffffffn)
      try {
        const hbm = hbmColor || hbmMask
        if (!hbm) return fail('no-bitmap')
        const bm = Buffer.alloc(32) // BITMAP x64
        if (!this.f.getObject(hbm, 32, bm)) return fail('GetObject', { hbm, hbmMask, hbmColor, hdc: this.hdc })
        const width = bm.readInt32LE(4)
        const height = bm.readInt32LE(8)
        if (width <= 0 || height <= 0 || width > 256 || height > 256) return fail(`bad-dims-${width}x${height}`)
        if (!hbmColor) return fail('mono') // 单色图标（掩码内含 XOR）spike 不做，如实缺席
        const bi = this.bitmapInfoHeader(width, -height, 32)
        const pixels = Buffer.alloc(width * height * 4)
        if (this.f.getDIBits(this.hdc, hbmColor, 0, height, pixels, bi, DIB_RGB_COLORS) !== height) return fail('GetDIBits-color', { hbmColor, hdc: this.hdc, width, height })
        let mask: Buffer | null = null
        if (hbmMask) {
          const stride = maskRowStride(width)
          mask = Buffer.alloc(stride * height)
          const biMask = this.bitmapInfoHeader(width, -height, 1)
          if (this.f.getDIBits(this.hdc, hbmMask, 0, height, mask, biMask, DIB_RGB_COLORS) !== height) mask = null
        }
        fixIconAlpha(pixels, width, height, mask)
        return { width, height, bgraBase64: pixels.toString('base64') }
      } finally {
        if (hbmColor) this.f.deleteObject(hbmColor)
        if (hbmMask) this.f.deleteObject(hbmMask)
      }
    } finally {
      if (hCopy) this.f.destroyIcon(hCopy)
    }
  }

  private bitmapInfoHeader(width: number, height: number, bitCount: number): Buffer {
    const bi = Buffer.alloc(40 + 8) // 1bpp 需随带 2 项调色板
    bi.writeUInt32LE(40, 0)
    bi.writeInt32LE(width, 4)
    bi.writeInt32LE(height, 8) // 负 = 顶向下
    bi.writeUInt16LE(1, 12)
    bi.writeUInt16LE(bitCount, 14)
    return bi
  }
}
