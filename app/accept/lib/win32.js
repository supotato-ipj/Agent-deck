'use strict';
// Win32 绑定（koffi/NAPI）——自工单01 探针原样复用（12/12 与 6/6 实证过的调用形态）。
// 验收电池专用，不是生产代码；生产侧钉扎见 src/main/win32.ts。
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
let imm32 = null;
try { imm32 = koffi.load('imm32.dll'); } catch { /* imm32 缺失则 IME 探针降级为渲染层事件断言 */ }

koffi.struct('POINT', { x: 'long', y: 'long' });
koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const MOUSEINPUT = koffi.struct('PROBE01_MOUSEINPUT', {
  dx: 'long', dy: 'long', mouseData: 'uint32', dwFlags: 'uint32',
  time: 'uint32', dwExtraInfo: 'uintptr_t',
});
const KEYBDINPUT = koffi.struct('PROBE01_KEYBDINPUT', {
  wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32',
  time: 'uint32', dwExtraInfo: 'uintptr_t',
});
const INPUTUNION = koffi.union('PROBE01_INPUT_U', { mi: MOUSEINPUT, ki: KEYBDINPUT });
const INPUT = koffi.struct('PROBE01_INPUT', { type: 'uint32', u: INPUTUNION });

const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;
const MOVER = 0x0001, LEFTDOWN = 0x0002, LEFTUP = 0x0004,
  RIGHTDOWN = 0x0008, RIGHTUP = 0x0010, ABSOLUTE = 0x8000;
const KEYDOWN = 0x0000, KEYUP = 0x0002, KEYUNICODE = 0x0004;
const SWP_NOSIZE = 0x0001, SWP_NOMOVE = 0x0002, SWP_NOACTIVATE = 0x0010,
  SWP_NOOWNERZORDER = 0x0200;
const HWND_BOTTOM = 1, HWND_TOP = 0, HWND_TOPMOST = -1, HWND_NOTOPMOST = -2;
const GW_HWNDNEXT = 2;
const GWL_EXSTYLE = -20;
const WS_EX_TRANSPARENT = 0x00000020, WS_EX_LAYERED = 0x00080000,
  WS_EX_NOACTIVATE = 0x08000000, WS_EX_TOPMOST = 0x00000008;
const GCS_COMPSTR = 0x0008, GCS_RESULTSTR = 0x0800;
const LWA_ALPHA = 0x00000002;

const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int nIndex)');
const GetCursorPos = user32.func('bool __stdcall GetCursorPos(_Out_ POINT *pt)');
const SetCursorPos = user32.func('bool __stdcall SetCursorPos(int x, int y)');
const SendInput = user32.func('int __stdcall SendInput(int cInputs, PROBE01_INPUT *pInputs, int cbSize)');
const WindowFromPoint = user32.func('uintptr_t __stdcall WindowFromPoint(POINT pt)');
const GetAncestor = user32.func('uintptr_t __stdcall GetAncestor(uintptr_t hWnd, uint32 gaFlags)');
const GetForegroundWindow = user32.func('uintptr_t __stdcall GetForegroundWindow()');
const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(uintptr_t hWnd)');
const BringWindowToTop = user32.func('bool __stdcall BringWindowToTop(uintptr_t hWnd)');
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(uintptr_t hWnd, _Out_ RECT *r)');
const SetWindowPos = user32.func('bool __stdcall SetWindowPos(uintptr_t hWnd, uintptr_t hWndInsertAfter, int x, int y, int cx, int cy, uint32 uFlags)');
const SetLayeredWindowAttributes = user32.func('bool __stdcall SetLayeredWindowAttributes(uintptr_t hWnd, uint32 crKey, uint8 bAlpha, uint32 dwFlags)');
const GetWindowLongW = user32.func('long __stdcall GetWindowLongW(uintptr_t hWnd, int nIndex)');
const SetWindowLongW = user32.func('long __stdcall SetWindowLongW(uintptr_t hWnd, int nIndex, long dwNewLong)');
const GetClassNameW = user32.func('int __stdcall GetClassNameW(uintptr_t hWnd, uint16 *buf, int nMax)');
const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(uintptr_t hWnd, _Out_ uint32 *pid)');
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(uintptr_t hWnd)');
const IsWindow = user32.func('bool __stdcall IsWindow(uintptr_t hWnd)');
const ShowWindow = user32.func('bool __stdcall ShowWindow(uintptr_t hWnd, int nCmdShow)');
const GetTopWindow = user32.func('uintptr_t __stdcall GetTopWindow(uintptr_t hWnd)');
const GetWindow = user32.func('uintptr_t __stdcall GetWindow(uintptr_t hWnd, uint32 uCmd)');
const PostMessageW = user32.func('bool __stdcall PostMessageW(uintptr_t hWnd, uint32 msg, uintptr_t wp, intptr_t lp)');
const FindWindowExW = user32.func('uintptr_t __stdcall FindWindowExW(uintptr_t hWndParent, uintptr_t hWndChildAfter, const char16_t *lpszClass, const char16_t *lpszWindow)');
const IsIconic = user32.func('bool __stdcall IsIconic(uintptr_t hWnd)');
// 工单05 桌面承载：DefView/SysListView32 探针（探测逻辑与 src/main/icon-carry.ts 互链不互引——
// 电池不得 import 生产代码）。WM_COMMAND=0x0111 与 0x7402 为 explorer「查看→显示桌面图标」命令。
const SendMessageTimeoutW = user32.func('bool __stdcall SendMessageTimeoutW(uintptr_t, uint32, uintptr_t, intptr_t, uint32, uint32, void *)');

function findDefView() {
  const progman = FindWindowExW(0, 0, 'Progman', null);
  if (progman) {
    const view = FindWindowExW(progman, 0, 'SHELLDLL_DefView', null);
    if (view) return view;
  }
  let h = GetTopWindow(0);
  let guard = 0;
  while (h && guard++ < 2048) {
    if (className(h) === 'WorkerW') {
      const view = FindWindowExW(h, 0, 'SHELLDLL_DefView', null);
      if (view) return view;
    }
    h = GetWindow(h, 2 /* GW_HWNDNEXT */);
  }
  return 0;
}

// 原生桌面图标当前是否显示（SysListView32 事实，非注册表偏好）
function desktopIconsVisible() {
  const view = findDefView();
  const lv = view ? FindWindowExW(view, 0, 'SysListView32', null) : 0;
  return Boolean(lv && IsWindowVisible(lv));
}
const AttachThreadInput = user32.func('bool __stdcall AttachThreadInput(uint32 idAttach, uint32 idAttachTo, bool fAttach)');
const GetKeyboardLayout = user32.func('uintptr_t __stdcall GetKeyboardLayout(uint32 idThread)');
const GetCurrentThreadId = kernel32.func('uint32 __stdcall GetCurrentThreadId()');

let ImmGetContext = null, ImmReleaseContext = null, ImmGetOpenStatus = null,
  ImmSetOpenStatus = null, ImmGetCompositionStringW = null;
if (imm32) {
  ImmGetContext = imm32.func('uintptr_t __stdcall ImmGetContext(uintptr_t hWnd)');
  ImmReleaseContext = imm32.func('bool __stdcall ImmReleaseContext(uintptr_t hWnd, uintptr_t himc)');
  ImmGetOpenStatus = imm32.func('bool __stdcall ImmGetOpenStatus(uintptr_t himc)');
  ImmSetOpenStatus = imm32.func('bool __stdcall ImmSetOpenStatus(uintptr_t himc, bool fOpen)');
  ImmGetCompositionStringW = imm32.func('long __stdcall ImmGetCompositionStringW(uintptr_t himc, uint32 dwIndex, void *lpBuf, uint32 dwBufLen)');
}

function rectOf(hwnd) {
  const r = {};
  if (!GetWindowRect(hwnd, r)) return null;
  return r;
}

// WindowFromPoint 会返回最深的子窗口（Chromium 的 RenderWidgetHostHWND、
// 记事本的 RichEdit 等）；断言一律映射到顶层根窗口再比对。
function windowFromPointRoot(pt) {
  const h = WindowFromPoint(pt);
  if (!h) return 0;
  const root = GetAncestor(h, 2 /* GA_ROOT */);
  return root || h;
}

function className(hwnd) {
  const buf = Buffer.alloc(512);
  const n = GetClassNameW(hwnd, buf, 256);
  if (n <= 0) return '';
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(buf.readUInt16LE(i * 2));
  return s;
}

function threadIdOf(hwnd) {
  // GetWindowThreadProcessId 返回线程 id，pid 经 out 指针取回
  const buf = Buffer.alloc(4);
  const tid = GetWindowThreadProcessId(hwnd, buf);
  return { tid, pid: buf.readUInt32LE(0) };
}

// 自顶向下枚举全部顶层可见窗口（避免回调），供按 PID 找窗与 z 序取证
function topLevelWindows() {
  const list = [];
  let h = GetTopWindow(0);
  let guard = 0;
  while (h && guard++ < 2048) {
    if (IsWindowVisible(h)) list.push(h);
    h = GetWindow(h, GW_HWNDNEXT);
  }
  return list;
}

function findWindowByPid(pid) {
  for (const h of topLevelWindows()) {
    if (threadIdOf(h).pid === pid) return h;
  }
  return null;
}

const cursor = () => {
  const pt = {};
  GetCursorPos(pt);
  return { x: pt.x, y: pt.y };
};

// —— SendInput 封装（绝对坐标为虚拟屏归一化 0..65535，与 DPI 无关）——
function virtualScreen() {
  const SM_XV = 76, SM_YV = 77, SM_WV = 78, SM_HV = 79;
  const vs = {
    x: GetSystemMetrics(SM_XV), y: GetSystemMetrics(SM_YV),
    w: GetSystemMetrics(SM_WV), h: GetSystemMetrics(SM_HV),
  };
  return vs;
}

let VS = null;
function norm16(physX, physY) {
  if (!VS) VS = virtualScreen();
  const nx = Math.min(65535, Math.max(0, Math.round((physX - VS.x) * 65535 / (VS.w - 1))));
  const ny = Math.min(65535, Math.max(0, Math.round((physY - VS.y) * 65535 / (VS.h - 1))));
  return { nx, ny };
}

function mouseInput(dx, dy, flags) {
  return {
    type: INPUT_MOUSE,
    u: { mi: { dx, dy, mouseData: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
  };
}

function keyInput(vk, flags) {
  return {
    type: INPUT_KEYBOARD,
    u: { ki: { wVk: vk, wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
  };
}

function send(inputs) {
  const n = SendInput(inputs.length, inputs, koffi.sizeof(INPUT));
  if (n !== inputs.length) throw new Error(`SendInput 失败: sent ${n}/${inputs.length} (sizeof(INPUT)=${koffi.sizeof(INPUT)})`);
  return n;
}

function moveMousePhys(x, y) {
  const { nx, ny } = norm16(x, y);
  send([mouseInput(nx, ny, MOVER | ABSOLUTE)]);
}

function clickPhys(x, y, button = 'left') {
  moveMousePhys(x, y);
  const down = button === 'left' ? LEFTDOWN : RIGHTDOWN;
  const up = button === 'left' ? LEFTUP : RIGHTUP;
  send([mouseInput(0, 0, down)]);
  send([mouseInput(0, 0, up)]);
}

function tapKeys(vks) {
  for (const vk of vks) {
    send([keyInput(vk, KEYDOWN)]);
    send([keyInput(vk, KEYUP)]);
  }
}

// KEYEVENTF_UNICODE 直注字符（绕过 IME，用于 unicode 到达性验证）
function sendUnicode(str) {
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (code > 0xffff) continue; // 探针场景只注 BMP 字符
    send([{ type: INPUT_KEYBOARD, u: { ki: { wVk: 0, wScan: code, dwFlags: KEYUNICODE, time: 0, dwExtraInfo: 0 } } }]);
    send([{ type: INPUT_KEYBOARD, u: { ki: { wVk: 0, wScan: code, dwFlags: KEYUNICODE | KEYUP, time: 0, dwExtraInfo: 0 } } }]);
  }
}

// —— IME 辅助（仅当窗口线程与调用线程一致时可靠）——
function imeStatus(hwnd) {
  if (!ImmGetContext) return { available: false };
  const himc = ImmGetContext(hwnd);
  if (!himc) return { available: true, gotContext: false };
  const open = ImmGetOpenStatus(himc);
  ImmReleaseContext(hwnd, himc);
  return { available: true, gotContext: true, open };
}

function imeSetOpen(hwnd, open) {
  if (!ImmSetOpenStatus) return false;
  const himc = ImmGetContext(hwnd);
  if (!himc) return false;
  const ok = ImmSetOpenStatus(himc, open);
  ImmReleaseContext(hwnd, himc);
  return ok;
}

function imeString(hwnd, gcs) {
  if (!ImmGetCompositionStringW) return null;
  const himc = ImmGetContext(hwnd);
  if (!himc) return null;
  const buf = Buffer.alloc(256);
  const n = ImmGetCompositionStringW(himc, gcs, buf, 256);
  ImmReleaseContext(hwnd, himc);
  if (n < 0) return '';
  let s = '';
  for (let i = 0; i + 2 <= n; i += 2) s += String.fromCharCode(buf.readUInt16LE(i));
  return s;
}

const INPUT_SIZE_EXPECT = process.arch === 'x64' ? 40 : 24;
if (koffi.sizeof(INPUT) !== INPUT_SIZE_EXPECT) {
  throw new Error(`INPUT 结构尺寸异常: ${koffi.sizeof(INPUT)} != ${INPUT_SIZE_EXPECT}`);
}

module.exports = {
  koffi, INPUT, INPUT_MOUSE, INPUT_KEYBOARD,
  MOVER, LEFTDOWN, LEFTUP, RIGHTDOWN, RIGHTUP, ABSOLUTE,
  SWP_NOSIZE, SWP_NOMOVE, SWP_NOACTIVATE, SWP_NOOWNERZORDER,
  HWND_BOTTOM, HWND_TOP, HWND_TOPMOST, HWND_NOTOPMOST, GWL_EXSTYLE,
  WS_EX_TRANSPARENT, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOPMOST,
  GCS_COMPSTR, GCS_RESULTSTR, KEYDOWN, KEYUP, KEYUNICODE, LWA_ALPHA,
  GetSystemMetrics, cursor, moveMousePhys, clickPhys, tapKeys, send, mouseInput, keyInput,
  rectOf, className, threadIdOf, topLevelWindows, findWindowByPid,
  imeStatus, imeSetOpen, imeString, virtualScreen, windowFromPointRoot,
  GetForegroundWindow, SetForegroundWindow, BringWindowToTop, SetWindowPos,
  SetLayeredWindowAttributes,
  GetWindowLongW, WindowFromPoint, IsWindow, PostMessageW, AttachThreadInput,
  FindWindowExW, IsIconic, findDefView, desktopIconsVisible, SendMessageTimeoutW,
  GetCurrentThreadId, GetKeyboardLayout, SetCursorPos, SetWindowLongW, sendUnicode,
  ShowWindow,
};
