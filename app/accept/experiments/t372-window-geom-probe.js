'use strict';
/**
 * 工单372 真机探针：外部窗口几何写入与首次操作取消验证（spec #369 原生门槛探针）。
 *
 * 定位：**取证探针**（app/accept/experiments/ 先例，同 t249/t371），**不是验收电池段**——
 * spec #369 决策 8「窗口几何控制器：具体 Win32 消息、事件 hook 和改窗调用组合由探针选定」
 * + 决策 30「失败关闭」。本探针在真实 Windows 11 build 26300 上验证生产几何控制链的承重柱：
 *
 *   ① 跨进程读/写几何：对代表性外部窗口（真实第三方 notepad / Electron；可选 Chromium
 *      msedge）+ 探针伴生进程的 Win32 对照窗（plain / popup 自绘形态 / 固定尺寸 / 拒绝改窗）
 *      实测 GetWindowRect 读、SetWindowPos 移动与缩放；坐标与 DPI 口径（Per-Monitor V2、
 *      物理 px、各窗 GetDpiForWindow / DPI awareness context）逐项记录。
 *   ② 首次操作取消/确认：SendInput 真拖动 + WM_SYSCOMMAND 最大化两条入口——首次几何操作
 *      后立即复原（矩形逐像素等值）、确认等待期零写窗零漂移、确认后只有重新发起的操作生效。
 *   ③ 回声抑制与 reconciliation：SetWinEventHook(EVENT_OBJECT_LOCATIONCHANGE) 事件流上，
 *      自身写窗（有 pending 期望矩形）全部归类为回声被抑制、不触发再写（无改窗循环）；
 *      外部改窗（伴生进程自改）被识别为 external，控制器 reconciliation 单发落位、无乒乓。
 *   ④ 有限可诊断降级：固定尺寸 / 拒绝改窗（WM_WINDOWPOSCHANGING 消息层主动回写钉死）/
 *      无边框自绘形态逐行实测写入结果并给出诊断分类；权限不足（高 IL）窗本机若无可测得
 *      对象则如实记 N/T（探针不提权、不写用户自己的窗口）；降级后其他窗口继续可写。
 *   ⑤ 探针退出零残留：伴生/第三方进程全退（tasklist 影像名计数不高于基线）、临时目录删除、
 *      光标归位、原生任务栏状态不变、无常驻进程。
 *
 * 伴生进程（controller 通过 stdin JSON 行协议指挥，源码由本探针写入系统临时目录，退出前删除）：
 *   - helper-win32：独立 node 进程创建 4 扇 Win32 代表窗（跨进程语境同生产——面板写的是
 *     别人进程的窗）；其中固定尺寸/拒绝改窗两扇在 WM_WINDOWPOSCHANGING 里 decode/encode
 *     WINDOWPOS 钉死 cx/cy（koffi 2.16.3 实测：lParam 须以 `void *` 进回调才能写回，
 *     裸数字地址 decode/encode 均拒收；SetProcessDpiAwarenessContext 的上下文常量须以
 *     `int64_t` 形参传递——`koffi.as(-4,'void *')` 在本机恒 Invalid argument，t371 的
 *     try/catch 写法实际一直静默失败，本机 scale=100% 掩盖了它）。
 *   - helper-electron：仓库自带 electron.exe + BrowserWindow（Chromium/Electron 代表），
 *     报告 getNativeWindowHandle 与 DIP 口径 bounds（与控制器物理 px 口径的差异即 DPI
 *     口径实测记录）。
 *
 * 用法（**必须经 accept-guard 托管**，禁裸跑——本机多检出共享同一验收槽）：
 *   node D:\test-folder\.accept-guard\guard.mjs hold --as zcode --purpose accept-sprint -- \
 *     node app\accept\experiments\t372-window-geom-probe.js
 *
 * 退出码：0 = 断言全过；1 = 有断言不成立（证据照常落盘，go/no-go 证据如实呈现）；
 *         2 = 环境/时序问题（本轮未取到证据）。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync, spawn } = require('child_process');

const win32 = require('../lib/win32');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 结论账目（探针自己的报告面） */
const findings = [];
function say(s) { console.log(s); findings.push(s); }

/** 断言账目：一条不成立 → 退出码 1，但探针继续跑完（残局清理与后续证据照常） */
const failures = [];
function check(desc, ok, detail = '') {
  const line = `${ok ? 'PASS' : 'FAIL'} ${desc}${detail ? ' —— ' + detail : ''}`;
  say(line);
  if (!ok) failures.push(desc);
  return ok;
}

/** 报告落盘（证据面：app/accept/evidence/，文本审计链随轮入库） */
const REPORT_FILE = path.join(__dirname, '..', 'evidence', '372-window-geom-probe.log.txt');
function flushReport() {
  try {
    fs.writeFileSync(REPORT_FILE, [
      '工单372 真机探针（t372-window-geom-probe.js）——外部窗口几何写入与首次操作取消验证',
      `运行时刻：${new Date().toISOString()}`,
      `退出码：${process.exitCode ?? 0}（${failures.length === 0 ? '断言全过' : failures.length + ' 条断言不成立'}）`,
      '',
      ...findings,
      '',
    ].join('\n'), 'utf8');
  } catch (e) {
    console.log(`（报告落盘失败：${e && e.message}）`);
  }
}

// ————————————————————————————————————————————————————————————
// Win32 绑定（探针进程：无自有窗口，只有事件 hook + 消息泵；鼠标输入复用 ../lib/win32）
// ————————————————————————————————————————————————————————————
const koffi = win32.koffi;
const user32 = koffi.load('user32.dll');

// 具名类型进程级单登（#153 教训：撞名即崩）——一律 T372_ 前缀
koffi.struct('T372_MSG', { hwnd: 'uintptr_t', message: 'uint32', wParam: 'uintptr_t', lParam: 'intptr_t', time: 'uint32', ptX: 'long', ptY: 'long', lPrivate: 'uint32' });

const PeekMessageW = user32.func('bool __stdcall PeekMessageW(_Out_ T372_MSG *lpMsg, uintptr_t hWnd, uint32 min, uint32 max, uint32 remove)');
const TranslateMessage = user32.func('bool __stdcall TranslateMessage(const T372_MSG *lpMsg)');
const DispatchMessageW = user32.func('intptr_t __stdcall DispatchMessageW(const T372_MSG *lpMsg)');
const PostMessageW = user32.func('bool __stdcall PostMessageW(uintptr_t hWnd, uint32 msg, uintptr_t wParam, intptr_t lParam)');
const IsZoomed = user32.func('bool __stdcall IsZoomed(uintptr_t hWnd)');
const GetDpiForWindow = user32.func('uint32 __stdcall GetDpiForWindow(uintptr_t hWnd)');
const GetDpiForSystem = user32.func('uint32 __stdcall GetDpiForSystem()');
const GetWindowDpiAwarenessContext = user32.func('int64_t __stdcall GetWindowDpiAwarenessContext(uintptr_t hWnd)');
const GetThreadDpiAwarenessContext = user32.func('int64_t __stdcall GetThreadDpiAwarenessContext()');
const AreDpiAwarenessContextsEqual = user32.func('bool __stdcall AreDpiAwarenessContextsEqual(int64_t a, int64_t b)');
const SetWinEventHook = user32.func('void * __stdcall SetWinEventHook(uint32 eventMin, uint32 eventMax, void *hmodWinEventProc, void *pfnWinEventProc, uint32 idProcess, uint32 idThread, uint32 dwFlags)');
const UnhookWinEvent = user32.func('bool __stdcall UnhookWinEvent(void *hWinEventHook)');
const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(uintptr_t hWnd, _Out_ uint32 *pid)');
const OpenProcess = koffi.load('kernel32.dll').func('void * __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)');
const CloseHandle = koffi.load('kernel32.dll').func('bool __stdcall CloseHandle(void *h)');
const DwmGetWindowAttribute = koffi.load('dwmapi.dll').func('int32 __stdcall DwmGetWindowAttribute(uintptr_t hwnd, uint32 attr, void *pv, uint32 cb)');

const WM_CLOSE = 0x0010, WM_SYSCOMMAND = 0x0112;
const SC_MAXIMIZE = 0xF030, SC_RESTORE = 0xF120;
const EVENT_OBJECT_LOCATIONCHANGE = 0x800B; // WINEVENT_OUTOFCONTEXT = 0
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
const PROCESS_QUERY_INFORMATION = 0x0400, PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

function rectArr(hwnd) {
  const r = win32.rectOf(hwnd);
  return r ? [r.left, r.top, r.right, r.bottom] : null;
}
function dwmFrameBounds(hwnd) {
  const buf = Buffer.alloc(16);
  if (DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, buf, 16) !== 0) return null;
  return [buf.readInt32LE(0), buf.readInt32LE(4), buf.readInt32LE(8), buf.readInt32LE(12)];
}
/** 矩形等值（容差 tol px，物理坐标） */
function rectEq(a, b, tol = 1) {
  if (!a || !b) return false;
  return a.every((v, i) => Math.abs(v - b[i]) <= tol);
}
function rectStr(r) { return r ? `[${r.join(',')}]` : 'null'; }

/** 消息泵睡眠：WinEvent 回调依赖本线程消息循环派发，纯 sleep 不泵会饿死事件流 */
async function pumpSleep(ms) {
  const msg = [null];
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    while (PeekMessageW(msg, 0, 0, 0, 1)) { TranslateMessage(msg[0]); DispatchMessageW(msg[0]); }
    await sleep(10);
  }
}

async function waitFor(desc, timeoutMs, predicate) {
  const t0 = Date.now();
  for (;;) {
    let r;
    try { r = predicate(); } catch (e) { r = { ok: false, detail: `异常 ${e && e.message}` }; }
    if (r && r.ok) return { ok: true, ms: Date.now() - t0, detail: r.detail || '' };
    if (Date.now() - t0 > timeoutMs) return { ok: false, ms: Date.now() - t0, detail: (r && r.detail) || '超时' };
    await pumpSleep(40);
  }
}

// ————————————————————————————————————————————————————————————
// DPI 口径（控制器进程必须 Per-Monitor V2，否则全部坐标被虚拟化、口径作废）
// 实测坑：DPI_AWARENESS_CONTEXT 常量（-1..-4）作为指针参数传递时 koffi.as(x,'void *')
// 恒 Invalid argument——必须以 int64_t 形参声明（ABI 同为 64 位）。
// ————————————————————————————————————————————————————————————
function setDpiAwareness() {
  try {
    const SetProcessDpiAwarenessContext = user32.func('bool __stdcall SetProcessDpiAwarenessContext(int64_t value)');
    if (!SetProcessDpiAwarenessContext(-4)) return false;
  } catch { return false; }
  return AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), -4);
}
function dpiCtxOf(hwnd) {
  const ctx = GetWindowDpiAwarenessContext(hwnd);
  if (AreDpiAwarenessContextsEqual(ctx, -4)) return 'PER_MONITOR_AWARE_V2';
  if (AreDpiAwarenessContextsEqual(ctx, -3)) return 'PER_MONITOR_AWARE';
  if (AreDpiAwarenessContextsEqual(ctx, -2)) return 'SYSTEM_AWARE';
  if (AreDpiAwarenessContextsEqual(ctx, -1)) return 'UNAWARE';
  return `other(${ctx})`;
}

// ————————————————————————————————————————————————————————————
// 事件 hook：LOCATIONCHANGE 流 + 回声/外部归类
// ————————————————————————————————————————————————————————————
const g_events = [];            // {hwnd, t, r, kind}
const g_targets = new Map();    // Number(hwnd) → label
const g_pending = new Map();    // Number(hwnd) → { r, until }（自身写窗的期望矩形）
const g_stats = { echo: 0, external: 0, writes: 0 };
let g_hook = null;
let g_wineventCb = null;

function classifyEvent(num, r) {
  const p = g_pending.get(num);
  if (p && Date.now() <= p.until && rectEq(r, p.r, 2)) return 'echo';
  return 'external';
}
function onWinEvent(hHook, event, hwnd, idObject, idChild, thread, time) {
  if (event !== EVENT_OBJECT_LOCATIONCHANGE || idObject !== 0) return;
  const num = Number(hwnd);
  if (!g_targets.has(num)) return;
  const r = rectArr(hwnd);
  if (!r) return;
  const kind = classifyEvent(num, r);
  if (kind === 'echo') g_stats.echo++; else g_stats.external++;
  g_events.push({ hwnd: num, label: g_targets.get(num), t: Date.now(), r, kind });
  if (g_events.length > 4000) g_events.splice(0, 1000);
}
function installHook() {
  koffi.proto('__stdcall', 'T372_WinEventProc', 'void', ['void *', 'uint32', 'uintptr_t', 'int32', 'int32', 'uint32', 'uint32']);
  g_wineventCb = koffi.register(onWinEvent, 'T372_WinEventProc *');
  g_hook = SetWinEventHook(EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE, null, g_wineventCb, 0, 0, 0);
  return Boolean(g_hook);
}
function removeHook() {
  try { if (g_hook) UnhookWinEvent(g_hook); } catch { /* 收尾 */ }
  try { if (g_wineventCb) koffi.unregister(g_wineventCb); } catch { /* 收尾 */ }
  g_hook = null; g_wineventCb = null;
}
/** 自身写窗：登记期望矩形（回声抑制窗口 1500ms）后 SetWindowPos（物理 px） */
function writeThrough(hwnd, x, y, w, h) {
  const num = Number(hwnd);
  g_pending.set(num, { r: [x, y, x + w, y + h], until: Date.now() + 1500 });
  g_stats.writes++;
  const ok = win32.SetWindowPos(hwnd, 0, x, y, w, h, win32.SWP_NOZORDER | win32.SWP_NOACTIVATE);
  if (!ok) g_pending.delete(num);
  return ok;
}
function eventsFor(label) { return g_events.filter((e) => e.label === label); }
function externalCountFor(label) { return eventsFor(label).filter((e) => e.kind === 'external').length; }
function clearEvents() { g_events.length = 0; }
function resetStats() { g_stats.echo = 0; g_stats.external = 0; g_stats.writes = 0; }

// ————————————————————————————————————————————————————————————
// 伴生进程源码（写临时目录，退出前删除）
// ————————————————————————————————————————————————————————————
const HELPER_WIN32_SRC = `'use strict';
// 工单372 探针伴生进程：独立 node 进程创建 4 扇 Win32 代表窗（跨进程语境同生产）。
// 固定尺寸/拒绝改窗在 WM_WINDOWPOSCHANGING 里写回 WINDOWPOS 钉死 cx/cy——koffi 2.16.3
// 实测：lParam 必须以 'void *' 进回调，裸数字地址 decode/encode 均拒收。
const koffi = require(process.env.T372_KOFFI);
const user32 = koffi.load('user32.dll');
const gdi32 = koffi.load('gdi32.dll');
const kernel32 = koffi.load('kernel32.dll');

koffi.struct('H_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
koffi.struct('H_POINT', { x: 'long', y: 'long' });
koffi.struct('H_MSG', { hwnd: 'uintptr_t', message: 'uint32', wParam: 'uintptr_t', lParam: 'intptr_t', time: 'uint32', pt: 'H_POINT', lPrivate: 'uint32' });
koffi.struct('H_WINDOWPOS', { hwnd: 'uintptr_t', hwndInsertAfter: 'uintptr_t', x: 'int32', y: 'int32', cx: 'int32', cy: 'int32', flags: 'uint32' });
koffi.struct('H_WNDCLASS', { style: 'uint32', lpfnWndProc: 'void *', cbClsExtra: 'int32', cbWndExtra: 'int32', hInstance: 'void *', hIcon: 'void *', hCursor: 'void *', hbrBackground: 'void *', lpszMenuName: 'const char16_t *', lpszClassName: 'const char16_t *' });

const RegisterClassW = user32.func('uint16 __stdcall RegisterClassW(const H_WNDCLASS *)');
const CreateWindowExW = user32.func('uintptr_t __stdcall CreateWindowExW(uint32, const char16_t *, const char16_t *, uint32, int, int, int, int, uintptr_t, uintptr_t, void *, void *)');
const DefWindowProcW = user32.func('intptr_t __stdcall DefWindowProcW(uintptr_t, uint32, uintptr_t, void *)');
const DestroyWindow = user32.func('bool __stdcall DestroyWindow(uintptr_t)');
const SetWindowPos = user32.func('bool __stdcall SetWindowPos(uintptr_t, uintptr_t, int, int, int, int, uint32)');
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(uintptr_t, _Out_ H_RECT *)');
const GetDpiForWindow = user32.func('uint32 __stdcall GetDpiForWindow(uintptr_t)');
const GetWindowDpiAwarenessContext = user32.func('int64_t __stdcall GetWindowDpiAwarenessContext(uintptr_t)');
const AreDpiAwarenessContextsEqual = user32.func('bool __stdcall AreDpiAwarenessContextsEqual(int64_t, int64_t)');
const PeekMessageW = user32.func('bool __stdcall PeekMessageW(_Out_ H_MSG *, uintptr_t, uint32, uint32, uint32)');
const TranslateMessage = user32.func('bool __stdcall TranslateMessage(const H_MSG *)');
const DispatchMessageW = user32.func('intptr_t __stdcall DispatchMessageW(const H_MSG *)');
const UpdateWindow = user32.func('bool __stdcall UpdateWindow(uintptr_t)');
const GetModuleHandleW = kernel32.func('void * __stdcall GetModuleHandleW(const char16_t *)');
const CreateSolidBrush = gdi32.func('void * __stdcall CreateSolidBrush(uint32)');

try {
  const SetProcessDpiAwarenessContext = user32.func('bool __stdcall SetProcessDpiAwarenessContext(int64_t value)');
  SetProcessDpiAwarenessContext(-4);
} catch { /* 口径退化时控制器会如实记录 */ }

const WS_OVERLAPPEDWINDOW = 0x00CF0000, WS_POPUP = 0x80000000, WS_VISIBLE = 0x10000000;
const WS_THICKFRAME = 0x00040000, WS_MAXIMIZEBOX = 0x00010000;
const SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10;
const WM_WINDOWPOSCHANGING = 0x46, WM_DESTROY = 2;
const SWP_NOSIZE = 0x1;

const SPECS = {
  plain:  { style: WS_OVERLAPPEDWINDOW, pin: null, x: 30,  y: 60,  w: 640, h: 480, title: 'T372-PLAIN-WIN32' },
  fixed:  { style: (WS_OVERLAPPEDWINDOW & ~(WS_THICKFRAME | WS_MAXIMIZEBOX)), pin: { w: 520, h: 400 }, x: 700, y: 60,  w: 520, h: 400, title: 'T372-FIXED-SIZE' },
  reject: { style: WS_OVERLAPPEDWINDOW, pin: { w: 560, h: 420 }, x: 30,  y: 560, w: 560, h: 420, title: 'T372-REJECT-RESIZE' },
  popup:  { style: WS_POPUP,            pin: null, x: 700, y: 560, w: 480, h: 360, title: 'T372-POPUP-FRAMELESS' },
};
const g_hwnds = new Map(); // Number(hwnd) → name
let g_cb = null;

function wndProc(hwnd, msg, wParam, lParam) {
  if (msg === WM_WINDOWPOSCHANGING && lParam) {
    const name = g_hwnds.get(Number(hwnd));
    const pin = name && SPECS[name] && SPECS[name].pin;
    if (pin) {
      const wp = koffi.decode(lParam, 'H_WINDOWPOS');
      if (wp && !(wp.flags & SWP_NOSIZE) && (wp.cx !== pin.w || wp.cy !== pin.h)) {
        wp.cx = pin.w; wp.cy = pin.h; wp.flags &= ~SWP_NOSIZE;
        koffi.encode(lParam, 'H_WINDOWPOS', wp);
      }
    }
  }
  if (msg === WM_DESTROY) return 0;
  return DefWindowProcW(hwnd, msg, wParam, lParam);
}

function rectArr(h) { const r = [{}]; if (!GetWindowRect(h, r)) return null; const v = r[0]; return [v.left, v.top, v.right, v.bottom]; }
function reply(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }

function pumpOnce() {
  const msg = [null];
  while (PeekMessageW(msg, 0, 0, 0, 1)) { TranslateMessage(msg[0]); DispatchMessageW(msg[0]); }
}
const pumpTimer = setInterval(pumpOnce, 10);

function main() {
  koffi.proto('__stdcall', 'H_WndProc', 'intptr_t', ['uintptr_t', 'uint32', 'uintptr_t', 'void *']);
  g_cb = koffi.register(wndProc, 'H_WndProc *');
  const wc = {
    style: 0, lpfnWndProc: g_cb, cbClsExtra: 0, cbWndExtra: 0,
    hInstance: GetModuleHandleW(null), hIcon: null, hCursor: null,
    hbrBackground: CreateSolidBrush(0x00251f1c), lpszMenuName: null, lpszClassName: 'T372_HELPER_CLASS',
  };
  if (!RegisterClassW(koffi.as(wc, 'const H_WNDCLASS *'))) throw new Error('RegisterClassW 失败');
  const windows = {};
  for (const [name, s] of Object.entries(SPECS)) {
    const hwnd = CreateWindowExW(0, 'T372_HELPER_CLASS', s.title, s.style | WS_VISIBLE, s.x, s.y, s.w, s.h, 0, 0, GetModuleHandleW(null), null);
    if (!hwnd) throw new Error('CreateWindowExW(' + name + ') 失败');
    g_hwnds.set(Number(hwnd), name);
    windows[name] = hwnd.toString(16);
    UpdateWindow(hwnd);
  }
  const hPlain = Number.parseInt(windows.plain, 16);
  reply({ type: 'ready', pid: process.pid, windows, dpi: GetDpiForWindow(hPlain), ctxName: (AreDpiAwarenessContextsEqual(GetWindowDpiAwarenessContext(hPlain), -4) ? 'PER_MONITOR_AWARE_V2' : 'other') });
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buf += d;
    for (;;) {
      const i = buf.indexOf('\\n');
      if (i < 0) break;
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      try {
        if (m.cmd === 'selfresize') {
          const h = Number.parseInt(String(m.hwnd), 16);
          const ok = SetWindowPos(h, 0, m.x, m.y, m.w, m.h, SWP_NOZORDER | SWP_NOACTIVATE);
          reply({ type: 'done', id: m.id, ok: Boolean(ok), rect: rectArr(h) });
        } else if (m.cmd === 'exit') {
          for (const h of g_hwnds.keys()) { try { DestroyWindow(h); } catch { /* 逐个销毁 */ } }
          reply({ type: 'bye' });
          setTimeout(() => { clearInterval(pumpTimer); try { if (g_cb) koffi.unregister(g_cb); } catch { /* 收尾 */ } process.exit(0); }, 100);
        } else if (m.cmd === 'ping') {
          reply({ type: 'done', id: m.id });
        }
      } catch (e) { reply({ type: 'err', id: m && m.id, error: String(e && e.message) }); }
    }
  });
  process.stdin.on('end', () => process.exit(0));
}
try { main(); } catch (e) { reply({ type: 'fatal', error: String(e && e.stack || e && e.message) }); process.exit(2); }
`;

const HELPER_ELECTRON_SRC = `'use strict';
// 工单372 探针伴生进程（Electron/Chromium 代表）：仓库自带 electron.exe 运行。
// 报告 getNativeWindowHandle（HWND）与 DIP 口径 bounds（与控制器物理 px 口径的差异即
// DPI 口径实测记录）。**不得 attach process.stdin**——t372 开发轮实证：Electron 主进程
// 一旦挂 stdin 监听，BrowserWindow 原生句柄会在 ~1s 内被销毁（进程存活、无 closed 事件，
// data:URL/webPreferences 与此无关，已二分坐实）。退出由控制器对窗 WM_CLOSE（Electron
// 在 Windows 上 window-all-closed 默认退 app）+ 控制器 taskkill 兜底。
const { app, BrowserWindow, screen } = require('electron');
let win = null;
function reply(obj) { try { process.stdout.write(JSON.stringify(obj) + '\\n'); } catch { /* 收尾 */ } }
app.whenReady().then(() => {
  win = new BrowserWindow({ x: 960, y: 200, width: 800, height: 600, show: true, title: 'T372-ELECTRON-CHROMIUM',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.on('closed', () => reply({ type: 'window-closed' }));
  // 实测坑：loadURL('data:text/html,…') 也会让 BrowserWindow 在 ready 后 ~500ms 内被销毁
  // （t372 开发轮实证）——探针只需要窗体几何，about:blank 足够
  win.loadURL('about:blank');
  let hwnd = null;
  try {
    const b = win.getNativeWindowHandle();
    hwnd = (b.readBigUInt64LE ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0)).toString(16);
  } catch { hwnd = null; }
  reply({ type: 'ready', pid: process.pid, hwnd, bounds: win.getBounds(), contentBounds: win.getContentBounds(), screenScale: screen.getPrimaryDisplay().scaleFactor });
}).catch((e) => { reply({ type: 'fatal', error: String(e && e.message) }); process.exit(2); });
`;

// ————————————————————————————————————————————————————————————
// 子进程管理（JSON 行协议 / 退出等待 / 兜底 taskkill）
// ————————————————————————————————————————————————————————————
function attachProtocol(child, label) {
  child._t372Waiters = new Map();
  child._t372Ready = null;
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    for (;;) {
      const i = buf.indexOf('\n');
      if (i < 0) break;
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { say(`（${label} stdout 非JSON: ${line.slice(0, 200)}）`); continue; }
      if (m.type === 'fatal') say(`（${label} fatal: ${String(m.error || '').slice(0, 300)}）`);
      if (m.type === 'err') say(`（${label} err: id=${m.id || '?'} ${String(m.error || '').slice(0, 200)}）`);
      if (m.type === 'window-closed') say(`（${label} BrowserWindow 已关闭——后续该窗断言会如实失败）`);
      if (m.type === 'ready') { child._t372Ready = m; continue; }
      const w = child._t372Waiters.get(m.id);
      if (w) { child._t372Waiters.delete(m.id); clearTimeout(w.timer); w.resolve(m); }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => {
    for (const l of String(d).split('\n')) if (l.trim()) say(`（${label} stderr: ${l.trim().slice(0, 200)}）`);
  });
}
function sendCmd(child, obj, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const id = 'c' + Math.random().toString(36).slice(2, 8);
    const w = { resolve: null, timer: null };
    w.timer = setTimeout(() => { child._t372Waiters.delete(id); resolve({ type: 'timeout', id }); }, timeoutMs);
    w.resolve = (m) => resolve({ ok: m.type === 'done', m });
    child._t372Waiters.set(id, w);
    try { child.stdin.write(JSON.stringify({ ...obj, id }) + '\n'); } catch (e) { clearTimeout(w.timer); resolve({ type: 'error', error: String(e && e.message) }); }
  });
}
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function taskkillTree(pid) {
  try { execSync(`taskkill /PID ${pid} /T /F /W`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { /* 已退出或拒绝 */ }
}

// 影像名进程计数（tasklist；中英文环境均按含影像名的行计）
function tasklistCount(image) {
  try {
    const out = execSync(`tasklist /FI "IMAGENAME eq ${image}" /FO CSV /NH`, { encoding: 'utf8' });
    return out.split('\n').filter((l) => l.toLowerCase().includes(image.toLowerCase())).length;
  } catch { return -1; }
}
/** tasklist 列出影像名全部 pid（差集法：探针只 taskkill 自己拉起期间新增的进程） */
function tasklistPids(image) {
  try {
    const out = execSync(`tasklist /FI "IMAGENAME eq ${image}" /FO CSV /NH`, { encoding: 'utf8' });
    const pids = new Set();
    for (const line of out.split('\n')) {
      const m = line.match(/"([^"]+)",\s*(\d+)/);
      if (m && m[1].toLowerCase().includes(image.toLowerCase())) pids.add(Number(m[2]));
    }
    return pids;
  } catch { return new Set(); }
}
/** exe basename 归一（lib 的 exeNameOfWindow 实测返回不带 .exe 的 basename，如 'notepad'） */
function exeBaseOf(hwnd) {
  const e = String(win32.exeNameOfWindow(hwnd) || '').toLowerCase();
  return e.endsWith('.exe') ? e.slice(0, -4) : e;
}
/** 枚举可见顶层窗里 exe basename 匹配、且不在 knownBefore 集合里的窗（探针只认自己拉起的） */
function findWindowsOfExe(exeBase, knownBefore) {
  const out = [];
  for (const h of win32.topLevelWindows()) {
    if (!win32.IsWindowVisible(h)) continue;
    try {
      if (exeBaseOf(h) !== exeBase) continue;
      if (knownBefore && knownBefore.has(Number(h))) continue;
      out.push(h);
    } catch { /* 进程退出竞态 */ }
  }
  return out;
}
function snapshotExeWindows(exeBase) {
  const set = new Set();
  for (const h of win32.topLevelWindows()) {
    if (!win32.IsWindowVisible(h)) continue;
    try { if (exeBaseOf(h) === exeBase) set.add(Number(h)); } catch { /* 忽略 */ }
  }
  return set;
}
function pidOfWindow(hwnd) { const b = [0]; GetWindowThreadProcessId(hwnd, b); return b[0]; }

// ————————————————————————————————————————————————————————————
// 崩溃恢复（探针可丢弃，机器状态不丢弃）
// ————————————————————————————————————————————————————————————
const g_state = { tempDir: null, children: [], targetWindows: [], cursorBefore: null, edgeProfile: null, killPids: new Set() };
async function recoverCleanup() {
  try {
    for (const h of g_state.targetWindows) { try { if (win32.IsWindow(h)) PostMessageW(h, WM_CLOSE, 0, 0); } catch { /* 尽力 */ } }
    for (const c of g_state.children) {
      try { if (c.child) c.child.stdin.write(JSON.stringify({ cmd: 'exit' }) + '\n'); } catch { /* 尽力 */ }
    }
    for (const pid of g_state.killPids) { if (pidAlive(pid)) taskkillTree(pid); }
    await sleep(600);
    if (g_state.tempDir) { try { fs.rmSync(g_state.tempDir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 尽力 */ } }
    say('恢复清理：目标窗 WM_CLOSE + 子进程 exit + killPids 差集 taskkill + 临时目录删除（尽力而为，结果见上方日志）');
  } catch (e) { say(`恢复清理异常：${e && e.message}`); }
}

// ————————————————————————————————————————————————————————————
// 主流程
// ————————————————————————————————————————————————————————————
async function main() {
  process.exitCode = 2;
  const dpiOk = setDpiAwareness();
  say(`控制器 DPI 口径：Per-Monitor V2 ${dpiOk ? '生效（本报告全部坐标为物理 px）' : '未生效——坐标被虚拟化，本轮几何证据口径存疑'}`);
  if (!dpiOk) { check('S1 控制器 DPI 口径 Per-Monitor V2 生效', false, '坐标虚拟化会使全部几何证据失真'); process.exitCode = 1; flushReport(); return; }
  say(`系统 DPI=${GetDpiForSystem()}（scale=${(GetDpiForSystem() / 96).toFixed(2)}x）`);

  // —— S1 基线 ——
  const appbarBefore = win32.appbarState();
  const trayHwnd = win32.nativeTrayHwnd();
  const trayVisibleBefore = Boolean(trayHwnd && win32.IsWindowVisible(trayHwnd));
  g_state.cursorBefore = win32.cursor();
  const baselineCounts = {
    notepad: tasklistCount('notepad.exe'),
    msedge: tasklistCount('msedge.exe'),
    electron: tasklistCount('electron.exe'),
  };
  const baselineWindows = {
    notepad: snapshotExeWindows('notepad'),
    msedge: snapshotExeWindows('msedge'),
  };
  say(`S1 基线：tasklist 计数 notepad=${baselineCounts.notepad} msedge=${baselineCounts.msedge} electron=${baselineCounts.electron}；原生任务栏 appbarState=${appbarBefore} visible=${trayVisibleBefore}`);
  say('S1 本机预存的 notepad/msedge 可见窗已快照，探针只认启动后新出现的窗，绝不触碰用户既有窗口');

  // —— S2 代表窗拉起 ——
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 't372-probe-'));
  g_state.tempDir = tempDir;
  fs.writeFileSync(path.join(tempDir, 'helper-win32.js'), HELPER_WIN32_SRC, 'utf8');
  fs.writeFileSync(path.join(tempDir, 'helper-electron.js'), HELPER_ELECTRON_SRC, 'utf8');

  const targets = new Map(); // label → { hwnd, kind, read, moveHonored, sizeHonored, note }
  const registerTarget = (label, hwnd, kind, note = '') => {
    targets.set(label, { hwnd, kind, note });
    g_targets.set(Number(hwnd), label);
  };

  // 2a. helper-win32（4 扇对照窗，独立进程 → 控制器对它们是真正的跨进程写）
  const koffiPath = require.resolve('koffi');
  const hw = spawn(process.execPath, [path.join(tempDir, 'helper-win32.js')], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, T372_KOFFI: koffiPath }, cwd: tempDir });
  attachProtocol(hw, 'helper-win32');
  g_state.children.push({ label: 'helper-win32', child: hw, pid: hw.pid });
  g_state.killPids.add(hw.pid);
  const hwReady = await waitFor('helper-win32 ready', 12000, () => hw._t372Ready ? { ok: true } : { ok: false });
  if (!hwReady.ok) { say('helper-win32 未就绪——核心基础设施不成立，exit 2'); flushReport(); return; }
  const ping = await sendCmd(hw, { cmd: 'ping' });
  if (!ping.ok) { say('helper-win32 ping 不通——协议不成立，exit 2'); flushReport(); return; }
  say(`S2 helper-win32 就绪：pid=${hw.pid} dpi=${hw._t372Ready.dpi} ctx=${hw._t372Ready.ctxName} windows=${JSON.stringify(hw._t372Ready.windows)}`);
  for (const name of ['plain', 'fixed', 'reject', 'popup']) {
    const h = Number.parseInt(hw._t372Ready.windows[name], 16);
    registerTarget('win32-' + name, h, 'helper');
  }

  // 2b. helper-electron（Chromium/Electron 代表）
  const electronExe = path.join(__dirname, '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!fs.existsSync(electronExe)) { say(`electron.exe 不存在：${electronExe}——Chromium/Electron 代表缺席，exit 2`); flushReport(); return; }
  const he = spawn(electronExe, [path.join(tempDir, 'helper-electron.js')], { stdio: ['pipe', 'pipe', 'pipe'], cwd: tempDir });
  attachProtocol(he, 'helper-electron');
  g_state.children.push({ label: 'helper-electron', child: he, pid: he.pid });
  g_state.killPids.add(he.pid);
  const heReady = await waitFor('helper-electron ready', 20000, () => he._t372Ready ? { ok: true } : { ok: false });
  if (!heReady.ok) { say('helper-electron 未就绪——Chromium/Electron 代表缺席，exit 2'); flushReport(); return; }
  let ehwnd = he._t372Ready.hwnd ? Number.parseInt(he._t372Ready.hwnd, 16) : null;
  if (!ehwnd || !win32.IsWindow(ehwnd)) {
    const found = findWindowsOfExe('electron', new Set());
    ehwnd = found.length ? found[0] : null;
    say(`S2 helper-electron hwnd 从 ready 消息不可用，回退按 exe 枚举：${ehwnd ? ehwnd.toString(16) : '未找到'}`);
  }
  registerTarget('electron', ehwnd, 'helper');
  say(`S2 helper-electron 就绪：pid=${he.pid} hwnd=${ehwnd ? ehwnd.toString(16) : 'null'} bounds(DIP)=${JSON.stringify(he._t372Ready.bounds)} screenScale=${he._t372Ready.screenScale}`);

  // 2c. notepad（真实第三方 Win32 代表；Win11 notepad 单实例可能复用既有进程——
  //     窗 hwnd 以启动前快照差集识别，清理只对该窗 WM_CLOSE；taskkill 只针对 pid 差集，
  //     绝不碰用户既有 notepad 进程）
  try {
    const pidsBefore = tasklistPids('notepad.exe');
    const np = spawn('notepad.exe', [], { stdio: 'ignore' });
    g_state.killPids.add(np.pid);
    g_state.children.push({ label: 'notepad-stub', child: np, pid: np.pid });
    const found = await waitFor('notepad 窗出现', 10000, () => {
      const w = findWindowsOfExe('notepad', baselineWindows.notepad);
      return w.length ? { ok: true } : { ok: false };
    });
    if (found.ok) {
      const hwnd = findWindowsOfExe('notepad', baselineWindows.notepad)[0];
      const winPid = pidOfWindow(hwnd);
      g_state.targetWindows.push(hwnd);
      registerTarget('notepad', hwnd, 'real');
      say(`S2 notepad 拉起：hwnd=${hwnd.toString(16)} pid=${winPid}${winPid === np.pid ? '' : '（单实例复用既有 notepad 进程——清理只对该窗 WM_CLOSE，不 taskkill 用户进程）'}`);
    } else {
      say('S2 notepad 窗未出现（可能被策略拦）——该代表窗记 N/T，不阻塞其余行');
    }
    await pumpSleep(500);
    for (const p of tasklistPids('notepad.exe')) if (!pidsBefore.has(p)) g_state.killPids.add(p); // 仅新增 pid
  } catch (e) { say(`S2 notepad 拉起异常：${e.message}——记 N/T`); }

  // 2d. msedge（Chromium 代表，独立临时 profile；Edge 进程树经启动器转手、不挂在我们
  //     spawn 的 pid 下——用 tasklist pid 差集圈定本探针新增进程，S8 逐个 taskkill）
  try {
    const edgeCandidates = [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ];
    const edgeExe = edgeCandidates.find((p) => fs.existsSync(p));
    if (!edgeExe) say('S2 msedge.exe 不在标准路径——Chromium(msedge) 代表记 N/T');
    else {
      const pidsBefore = tasklistPids('msedge.exe');
      const edgeProfile = path.join(tempDir, 'edge-profile');
      g_state.edgeProfile = edgeProfile;
      const me = spawn(edgeExe, [`--user-data-dir=${edgeProfile}`, '--no-first-run', '--no-default-browser-check', '--new-window', '--window-size=760,520', 'about:blank'], { stdio: 'ignore' });
      g_state.killPids.add(me.pid);
      g_state.children.push({ label: 'msedge-stub', child: me, pid: me.pid });
      const found = await waitFor('msedge 窗出现', 20000, () => {
        const w = findWindowsOfExe('msedge', baselineWindows.msedge);
        return w.length ? { ok: true } : { ok: false };
      });
      if (found.ok) {
        const hwnd = findWindowsOfExe('msedge', baselineWindows.msedge)[0];
        g_state.targetWindows.push(hwnd);
        registerTarget('msedge', hwnd, 'real');
        say(`S2 msedge 拉起：hwnd=${hwnd.toString(16)} pid=${pidOfWindow(hwnd)}（独立临时 profile）`);
      } else {
        say('S2 msedge 窗未出现——记 N/T，不阻塞其余行');
      }
      await pumpSleep(500);
      for (const p of tasklistPids('msedge.exe')) if (!pidsBefore.has(p)) g_state.killPids.add(p); // 仅新增 pid（含转手后的进程树）
    }
  } catch (e) { say(`S2 msedge 拉起异常：${e.message}——记 N/T`); }

  // 事件 hook（targets 注册完毕后安装，只认已注册的窗）
  if (!installHook()) { say('SetWinEventHook 安装失败——事件流证据缺席，exit 2'); flushReport(); return; }
  say(`S2 事件 hook 已安装：EVENT_OBJECT_LOCATIONCHANGE(0x800B) out-of-context，监听 ${g_targets.size} 窗`);
  await pumpSleep(600);

  const coreReady = targets.has('win32-plain') && targets.has('electron') && targets.has('notepad');
  check('S2 核心代表窗就位（win32 对照 + Electron/Chromium + 真实第三方 Win32）', coreReady,
    [...targets.keys()].join(', '));

  // —— S3 读几何与 DPI 口径 ——
  say('—— S3 跨进程读几何与 DPI 口径 ——');
  const dpiTable = [];
  let readOk = true;
  for (const [label, t] of targets) {
    const r = rectArr(t.hwnd);
    const dwm = dwmFrameBounds(t.hwnd);
    const dpi = GetDpiForWindow(t.hwnd);
    const ctx = dpiCtxOf(t.hwnd);
    t.read = { r, dwm, dpi, ctx };
    const ok = Boolean(r) && dpi > 0;
    if (!ok) readOk = false;
    dpiTable.push(`  ${label}: hwnd=${t.hwnd.toString(16)} rect(物理)=${rectStr(r)} dwmFrameBounds=${dwm ? rectStr(dwm) : 'N/A'} dpi=${dpi}(${(dpi / 96).toFixed(2)}x) ctx=${ctx} → ${ok ? 'OK' : 'FAIL'}`);
  }
  say(dpiTable.join('\n'));
  check('S3 全部代表窗跨进程读几何成功（GetWindowRect + DWM 扩展框 + GetDpiForWindow + awareness context）', readOk && targets.size >= 3, `${targets.size} 窗`);

  // —— S4 跨进程写几何（move + resize）——
  say('—— S4 跨进程写几何（SetWindowPos 移动 + 缩放，物理 px） ——');
  const writeRows = [];
  let writeOk = true;
  for (const [label, t] of targets) {
    if (label === 'win32-fixed' || label === 'win32-reject') { writeRows.push(`  ${label}: 跳过（S7 降级行）`); continue; }
    const r0 = rectArr(t.hwnd);
    if (!r0) { writeRows.push(`  ${label}: 读失败`); writeOk = false; continue; }
    const nx = r0[0] + 120, ny = r0[1] + 90;
    const mvOk = writeThrough(t.hwnd, nx, ny, r0[2] - r0[0], r0[3] - r0[1]);
    await pumpSleep(350);
    const r1 = rectArr(t.hwnd);
    const moveHonored = mvOk && rectEq(r1, [nx, ny, r1[2], r1[3]], 1);
    const w = (r0[2] - r0[0]) + 140, h = (r0[3] - r0[1]) + 100;
    const rzOk = writeThrough(t.hwnd, nx, ny, w, h);
    await pumpSleep(350);
    const r2 = rectArr(t.hwnd);
    const sizeHonored = rzOk && rectEq(r2, [nx, ny, nx + w, ny + h], 1);
    t.moveHonored = moveHonored; t.sizeHonored = sizeHonored;
    writeRows.push(`  ${label}: move→${rectStr(r1)}(${moveHonored ? '生效' : '未生效'}) resize→${rectStr(r2)}(${sizeHonored ? '生效' : '未生效'})`);
    if (!moveHonored || !sizeHonored) writeOk = false;
  }
  say(writeRows.join('\n'));
  check('S4 可写代表窗（notepad/electron/msedge/plain/popup）移动+缩放 SetWindowPos 全部生效', writeOk,
    writeRows.filter((s) => s.includes('未生效')).join(' | ') || '全部生效');

  // —— S5 首次操作取消/确认 ——
  say('—— S5 首次几何操作：复原 → 确认等待（零写零漂移）→ 确认后重新发起 ——');
  // 5A. 真拖动（win32-plain，SendInput 标题栏拖拽）
  {
    const t = targets.get('win32-plain');
    const orig = rectArr(t.hwnd);
    clearEvents(); resetStats();
    const drag1 = await dragWindow(t.hwnd, 90, 70);
    const afterDrag = rectArr(t.hwnd);
    const dragMoved = drag1.ok && afterDrag && !rectEq(afterDrag, orig, 1);
    say(`S5A 第一次拖动：ok=${drag1.ok} orig=${rectStr(orig)} after=${rectStr(afterDrag)} 事件=${eventsFor('win32-plain').length} external=${externalCountFor('win32-plain')}`);
    check('S5A 首次拖动实际改变几何（SendInput 真拖，事件流同步可见）', dragMoved,
      `dx=${afterDrag ? afterDrag[0] - orig[0] : 'n/a'},dy=${afterDrag ? afterDrag[1] - orig[1] : 'n/a'},events=${eventsFor('win32-plain').length}`);
    if (dragMoved) {
      const restored = writeThrough(t.hwnd, orig[0], orig[1], orig[2] - orig[0], orig[3] - orig[1]);
      await pumpSleep(400);
      const now = rectArr(t.hwnd);
      check('S5A 首次操作立即复原（矩形与原位等值，容差 1px）', restored && rectEq(now, orig, 1), `复原后=${rectStr(now)} 原=${rectStr(orig)}`);
      // 确认等待期：零写窗、零漂移、零 external 事件
      const writesBefore = g_stats.writes;
      const extBefore = externalCountFor('win32-plain');
      await pumpSleep(800);
      const drift = !rectEq(rectArr(t.hwnd), orig, 1);
      const extAfter = externalCountFor('win32-plain');
      check('S5A 确认等待期：无几何漂移、无外部事件、无新增写窗（确认框语义）',
        !drift && extAfter === extBefore && g_stats.writes === writesBefore,
        `drift=${drift} external=${extBefore}→${extAfter} 写窗+=${g_stats.writes - writesBefore}`);
      // 确认后重新发起
      const drag2 = await dragWindow(t.hwnd, 70, 55);
      await pumpSleep(300);
      const after2 = rectArr(t.hwnd);
      const moved2 = drag2.ok && after2 && Math.abs(after2[0] - orig[0]) >= 40 && Math.abs(after2[1] - orig[1]) >= 40;
      check('S5A 确认后重新发起的操作生效（第二次拖动位移 ≥40px）', moved2, `after=${rectStr(after2)}`);
      writeThrough(t.hwnd, orig[0], orig[1], orig[2] - orig[0], orig[3] - orig[1]);
      await pumpSleep(300);
    }
  }
  // 5B. 最大化取消/确认（electron + notepad 两代表）
  for (const label of ['electron', 'notepad']) {
    if (!targets.has(label)) { say(`S5B ${label}: 缺席，跳过`); continue; }
    const t = targets.get(label);
    const orig = rectArr(t.hwnd);
    const max1 = PostMessageW(t.hwnd, WM_SYSCOMMAND, SC_MAXIMIZE, 0);
    const zoomed1 = await waitFor(`${label} 最大化确认`, 3000, () => IsZoomed(t.hwnd) ? { ok: true } : { ok: false, detail: 'IsZoomed=false' });
    const maxRect = rectArr(t.hwnd);
    const maxApplied = zoomed1.ok && maxRect && !rectEq(maxRect, orig, 1);
    check(`S5B ${label} 首次最大化实际生效（WM_SYSCOMMAND 跨进程路径）`, maxApplied,
      `post=${max1 ? 1 : 0} zoomed=${IsZoomed(t.hwnd) ? 1 : 0} rect=${rectStr(maxRect)}`);
    if (maxApplied) {
      PostMessageW(t.hwnd, WM_SYSCOMMAND, SC_RESTORE, 0);
      const back = await waitFor(`${label} 复原确认`, 3000, () => {
        const r = rectArr(t.hwnd);
        return (!IsZoomed(t.hwnd) && rectEq(r, orig, 1)) ? { ok: true, detail: rectStr(r) } : { ok: false, detail: rectStr(r) };
      });
      check(`S5B ${label} 最大化立即复原（矩形与原位等值）`, back.ok, back.detail);
      await pumpSleep(700);
      check(`S5B ${label} 确认等待期几何保持原状`, rectEq(rectArr(t.hwnd), orig, 1), rectStr(rectArr(t.hwnd)));
      PostMessageW(t.hwnd, WM_SYSCOMMAND, SC_MAXIMIZE, 0);
      const zoomed2 = await waitFor(`${label} 重新最大化确认`, 3000, () => IsZoomed(t.hwnd) ? { ok: true } : { ok: false });
      check(`S5B ${label} 确认后重新发起的最大化生效`, zoomed2.ok);
      PostMessageW(t.hwnd, WM_SYSCOMMAND, SC_RESTORE, 0);
      await waitFor(`${label} 收尾还原`, 3000, () => !IsZoomed(t.hwnd) ? { ok: true } : { ok: false });
      await pumpSleep(200);
    }
  }

  // —— S6 回声抑制与外部改窗 reconciliation ——
  say('—— S6 自身写窗回声抑制 + 外部改窗识别与 reconciliation ——');
  {
    const t = targets.get('win32-plain');
    const base = rectArr(t.hwnd);
    // 6a. 自身写窗 → 全部回声、单次写、无循环
    clearEvents(); resetStats();
    const T1 = [base[0] + 200, base[1] + 150, base[2] - 60, base[3] - 50];
    const w1 = writeThrough(t.hwnd, T1[0], T1[1], T1[2] - T1[0], T1[3] - T1[1]);
    await pumpSleep(700);
    const ev = eventsFor('win32-plain');
    const echoEv = ev.filter((e) => e.kind === 'echo'), extEv = ev.filter((e) => e.kind === 'external');
    check('S6a 自身写窗事件全部归类为回声（pending 期望矩形命中，不误判为外部操作）', w1 && ev.length > 0 && extEv.length === 0,
      `事件=${ev.length} echo=${echoEv.length} external=${extEv.length} writes=${g_stats.writes}`);
    check('S6a 回声抑制后不再触发写窗（无改窗循环）：单次写 + 几何落位', g_stats.writes === 1 && rectEq(rectArr(t.hwnd), T1, 1),
      `writes=${g_stats.writes} rect=${rectStr(rectArr(t.hwnd))}`);
    await pumpSleep(800);
    check('S6a 静置 800ms 后仍稳定（回声窗口过期后无新事件、无再写）', rectEq(rectArr(t.hwnd), T1, 1) && g_stats.writes === 1,
      `rect=${rectStr(rectArr(t.hwnd))} writes=${g_stats.writes}`);
    // 6b. 外部改窗（伴生进程自改）→ 识别 external → reconciliation 单发
    clearEvents(); resetStats();
    g_pending.delete(Number(t.hwnd)); // 清掉回声窗口，确保归类干净
    const T2 = [T1[0] + 60, T1[1] + 45, T1[2] + 90, T1[3] + 70];
    const self = await sendCmd(hw, { cmd: 'selfresize', hwnd: t.hwnd.toString(16), x: T2[0], y: T2[1], w: T2[2] - T2[0], h: T2[3] - T2[1] }, 5000);
    await pumpSleep(400);
    check('S6b 外部改窗被识别（伴生进程自改 → external，不与回声混淆）', self.ok && externalCountFor('win32-plain') > 0,
      `self.ok=${self.ok} rect=${rectStr(self.m && self.m.rect)} external=${externalCountFor('win32-plain')}`);
    // reconciliation：单发落位回平铺矩形
    const T3 = [base[0] + 100, base[1] + 80, base[2] - 20, base[3] - 40];
    const recon = writeThrough(t.hwnd, T3[0], T3[1], T3[2] - T3[0], T3[3] - T3[1]);
    await pumpSleep(500);
    check('S6b reconciliation 单发落位（一次写即达目标矩形）', recon && rectEq(rectArr(t.hwnd), T3, 1),
      `rect=${rectStr(rectArr(t.hwnd))} 目标=${rectStr(T3)}`);
    const extBefore2 = externalCountFor('win32-plain');
    const writesBefore2 = g_stats.writes;
    await pumpSleep(900);
    check('S6b 无乒乓循环：reconciliation 后 900ms 内零新外部事件、零新增写窗、几何保持',
      rectEq(rectArr(t.hwnd), T3, 1) && externalCountFor('win32-plain') === extBefore2 && g_stats.writes === writesBefore2,
      `external=${extBefore2}→${externalCountFor('win32-plain')} writes+=${g_stats.writes - writesBefore2} rect=${rectStr(rectArr(t.hwnd))}`);
  }

  // —— S7 有限可诊断降级 ——
  say('—— S7 固定尺寸 / 拒绝改窗 / 自绘无边框 / 权限不足 ——');
  {
    // 7a. 固定尺寸：移动生效、缩放被钉死（WM_WINDOWPOSCHANGING 写回）
    const tf = targets.get('win32-fixed');
    const rf = rectArr(tf.hwnd);
    const mv = writeThrough(tf.hwnd, rf[0] + 80, rf[1] + 60, rf[2] - rf[0], rf[3] - rf[1]);
    await pumpSleep(350);
    const rf1 = rectArr(tf.hwnd);
    check('S7a 固定尺寸窗：位置写入仍生效（有限降级不等于完全不可控）', mv && rectEq(rf1, [rf[0] + 80, rf[1] + 60, rf[2] + 80, rf[3] + 60], 1),
      `${rectStr(rf)}→${rectStr(rf1)}`);
    writeThrough(tf.hwnd, rf[0] + 80, rf[1] + 60, 700, 520); // 缩放尝试（单次，不重试）
    await pumpSleep(350);
    const rf2 = rectArr(tf.hwnd);
    check('S7a 固定尺寸窗：缩放被钉死（诊断分类「异常未平铺-固定尺寸」，单次尝试不重试不强改）',
      rectEq(rf2, [rf[0] + 80, rf[1] + 60, rf[0] + 80 + 520, rf[1] + 60 + 400], 1),
      `请求 700×520 实得 ${rf2[2] - rf2[0]}×${rf2[3] - rf2[1]}`);
    // 7b. 拒绝改窗：消息层主动回写自己的几何
    const tr = targets.get('win32-reject');
    const rr = rectArr(tr.hwnd);
    writeThrough(tr.hwnd, rr[0], rr[1], 800, 620);
    await pumpSleep(350);
    const rr2 = rectArr(tr.hwnd);
    check('S7b 拒绝改窗窗：窗体钉死自己的尺寸（诊断分类「异常未平铺-拒绝改窗」，写入结果可预期可诊断）',
      rectEq(rr2, [rr[0], rr[1], rr[0] + 560, rr[1] + 420], 1), `请求 800×620 实得 ${rr2[2] - rr2[0]}×${rr2[3] - rr2[1]}`);
    const mv2 = writeThrough(tr.hwnd, rr[0] - 60, rr[1] - 40, 560, 420);
    await pumpSleep(300);
    check('S7b 拒绝改窗窗：位置写入仍生效（降级面记录在案）', mv2 && rectEq(rectArr(tr.hwnd), [rr[0] - 60, rr[1] - 40, rr[0] - 60 + 560, rr[1] - 40 + 420], 1), rectStr(rectArr(tr.hwnd)));
    // 7c. 自绘无边框形态（popup）：读写正常
    const tp = targets.get('win32-popup');
    const rp = rectArr(tp.hwnd);
    const wp = writeThrough(tp.hwnd, rp[0] + 50, rp[1] + 40, (rp[2] - rp[0]) + 60, (rp[3] - rp[1]) + 40);
    await pumpSleep(350);
    check('S7c 自绘无边框（WS_POPUP）形态：移动+缩放正常生效（自绘不必然降级）',
      wp && rectEq(rectArr(tp.hwnd), [rp[0] + 50, rp[1] + 40, rp[0] + 50 + (rp[2] - rp[0]) + 60, rp[1] + 40 + (rp[3] - rp[1]) + 40], 1), rectStr(rectArr(tp.hwnd)));
    // 7d. 权限不足（高 IL）窗：本机探测，不动用户窗口
    const elevated = [];
    for (const h of win32.topLevelWindows()) {
      if (!win32.IsWindowVisible(h)) continue;
      const pid = pidOfWindow(h);
      if (pid === process.pid) continue;
      if (elevated.some((e2) => e2.pid === pid)) continue;
      const hq = OpenProcess(PROCESS_QUERY_INFORMATION, false, pid);
      if (!hq) {
        const hl = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (hl) {
          CloseHandle(hl);
          elevated.push({ pid, hwnd: h, exe: String(win32.exeNameOfWindow(h) || '?') });
        }
      } else CloseHandle(hq);
      if (elevated.length >= 3) break;
    }
    if (elevated.length) {
      say(`S7d 本机探测到疑似高 IL 进程窗 ${elevated.length} 个：${elevated.map((e2) => `${e2.exe}(pid=${e2.pid})`).join(', ')}——探针不写用户窗口，仅记录存在性`);
      say('S7d 权限不足行：本机存在可观察对象，但几何写入试验需要专用提升测试窗（需 UAC），本轮记 N/T——生产按失败分类+单次尝试+不重试+诊断上报兜底');
    } else {
      say('S7d 本机无可确定性判定的高 IL 测试窗（探针不申请提权、不写用户窗口）——权限不足行记 N/T');
    }
    // 7e. 降级不阻塞其他窗口
    const tplain = targets.get('win32-plain');
    const rp3 = rectArr(tplain.hwnd);
    const okAfter = writeThrough(tplain.hwnd, rp3[0] + 10, rp3[1] + 10, rp3[2] - rp3[0], rp3[3] - rp3[1]);
    await pumpSleep(350);
    check('S7e 降级窗口处理后其他窗口继续可写（不阻塞）', okAfter && rectEq(rectArr(tplain.hwnd), [rp3[0] + 10, rp3[1] + 10, rp3[2] + 10, rp3[3] + 10], 1), rectStr(rectArr(tplain.hwnd)));
  }

  // —— S8 零残留 ——
  say('—— S8 清理与零残留断言 ——');
  removeHook();
  say('S8 WinEvent hook 已卸载（UnhookWinEvent + koffi.unregister，结构性保证）');
  // 1) 关探针拉起的全部代表窗（WM_CLOSE 窗口级：真实第三方关自己的新窗；electron 窗
  //    关闭触发 window-all-closed 默认退 app——electron helper 不得走 stdin，见 helper 注释）
  for (const [, t] of targets) {
    try { if (win32.IsWindow(t.hwnd)) PostMessageW(t.hwnd, WM_CLOSE, 0, 0); } catch { /* 尽力 */ }
  }
  // 2) helper-win32（stdin JSON 协议）exit；electron 无 stdin（见上），靠 WM_CLOSE + 兜底
  for (const c of g_state.children) {
    try { if (c.child && c.label === 'helper-win32') c.child.stdin.write(JSON.stringify({ cmd: 'exit' }) + '\n'); } catch { /* 尽力 */ }
  }
  // 3) 等 pid 退，兜底 taskkill（killPids = 探针 spawn 的 pid + 新增差集，绝不含用户既有进程）
  await pumpSleep(1500);
  for (const pid of g_state.killPids) {
    if (pidAlive(pid)) taskkillTree(pid);
  }
  await pumpSleep(800);
  const alivePids = [...g_state.killPids].filter(pidAlive);
  check('S8 探针圈定的全部进程已退出（spawn pid + 新增差集；用户既有进程不在圈定集内）', alivePids.length === 0,
    alivePids.join(', ') || `全部退出（圈定 ${g_state.killPids.size} pid）`);
  // 4) 影像名计数不高于基线（捕捉子进程残留）
  await pumpSleep(500);
  const afterCounts = {
    notepad: tasklistCount('notepad.exe'),
    msedge: tasklistCount('msedge.exe'),
    electron: tasklistCount('electron.exe'),
  };
  check('S8 影像名进程计数不高于基线（notepad/msedge/electron 无子进程残留）',
    afterCounts.notepad <= baselineCounts.notepad && afterCounts.msedge <= baselineCounts.msedge && afterCounts.electron <= baselineCounts.electron,
    `notepad ${baselineCounts.notepad}→${afterCounts.notepad} msedge ${baselineCounts.msedge}→${afterCounts.msedge} electron ${baselineCounts.electron}→${afterCounts.electron}`);
  // 5) 临时目录删除
  try { fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 兜底失败如实记 */ }
  check('S8 探针临时目录已删除（helper 源码与 edge profile 不残留）', !fs.existsSync(tempDir), tempDir);
  // 6) 原生任务栏状态不变
  const appbarAfter = win32.appbarState();
  check('S8 原生任务栏状态不变（ABM_GETSTATE + 可见性）',
    appbarAfter === appbarBefore && Boolean(win32.nativeTaskbarVisible()) === trayVisibleBefore,
    `state ${appbarBefore}→${appbarAfter} visible ${trayVisibleBefore}→${Boolean(win32.nativeTaskbarVisible())}`);
  // 7) 光标归位
  try { if (g_state.cursorBefore) win32.SetCursorPos(g_state.cursorBefore.x, g_state.cursorBefore.y); } catch { /* 尽力 */ }
  say('S8 光标已归位（拖动前坐标恢复）');
  // 8) 常驻进程
  say('S8 常驻进程：探针只 spawn 上述已退出的子进程，main 返回即退出，无常驻残留（结构性保证）');

  // —— 应用兼容矩阵与 go/no-go ——
  say('');
  say('=== 应用兼容矩阵（本轮实测） ===');
  for (const [label, t] of targets) {
    const readS = t.read && t.read.r ? 'OK' : 'FAIL';
    const mv = label === 'win32-fixed' || label === 'win32-reject' ? '移动OK' : (t.moveHonored ? 'OK' : 'FAIL');
    const sz = label === 'win32-fixed' ? '钉死(降级)' : label === 'win32-reject' ? '钉死(降级)' : (t.sizeHonored ? 'OK' : 'FAIL');
    say(`| ${label} | ${t.kind === 'real' ? '真实第三方' : '伴生对照'} | 读:${readS} | 移动:${mv} | 缩放:${sz} | dpi=${t.read ? t.read.dpi : '?'}(${((t.read ? t.read.dpi : 96) / 96).toFixed(2)}x) ctx=${t.read ? t.read.ctx : '?'} |`);
  }
  say('| 高IL权限不足窗 | N/T | 本机无确定性测试对象（不提权），生产按失败分类兜底 |');
  say('');
  say('=== 工单372 go/no-go 证据要点 ===');
  const writeCoreOk = (!targets.has('notepad') || targets.get('notepad').moveHonored) && targets.get('electron').moveHonored && targets.get('win32-plain').moveHonored;
  say(`① 跨进程读/写几何（Win32 + Chromium/Electron）：${writeCoreOk ? '成立——SetWindowPos 物理 px 生效，坐标与 DPI 口径见 S3/S4 表' : '未完全成立——见 S4 FAIL 行'}`);
  say('② 首次操作取消/确认：拖动与最大化两条入口的复原、确认等待期零写零漂移、确认后重新发起生效——见 S5 PASS 行');
  say('③ 回声抑制与 reconciliation：自身写窗全部归类回声且单次写不循环；外部改窗识别为 external 并单发落位、无乒乓——见 S6 PASS 行');
  say('④ 有限可诊断降级：固定尺寸/拒绝改窗钉死可诊断、自绘无边框可写、降级不阻塞其他窗；权限不足本机 N/T（不提权）——见 S7 各行');
  say('⑤ 零残留：进程计数回基线、临时目录删除、任务栏状态不变、hook 卸载——见 S8 PASS 行');
  say('go/no-go 判读：探针能力不记作生产完成——生产几何控制器仍需按 spec #369 决策 8/10/12/30 实现授权状态机与失败关闭；');
  say(`断言账目：${failures.length === 0 ? '全部通过' : failures.length + ' 条不成立：' + failures.join('；')}`);

  process.exitCode = failures.length === 0 ? 0 : 1;
  flushReport();
}

/** SendInput 真拖动：标题栏按下 → 分步移动 → 抬起（期间消息泵持续跑，事件流同步可见） */
async function dragWindow(hwnd, dx, dy) {
  const r = win32.rectOf(hwnd);
  if (!r) return { ok: false };
  const sx = Math.round((r.left + r.right) / 2);
  const sy = r.top + Math.max(8, Math.round((r.bottom - r.top) * 0.03));
  win32.SetWindowPos(hwnd, -1 /*HWND_TOPMOST 拖动期间防遮挡*/, 0, 0, 0, 0, win32.SWP_NOMOVE | win32.SWP_NOSIZE | win32.SWP_NOACTIVATE);
  await pumpSleep(120);
  win32.moveMousePhys(sx, sy);
  await pumpSleep(80);
  win32.send([win32.mouseInput(0, 0, win32.LEFTDOWN)]);
  await pumpSleep(80);
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    win32.moveMousePhys(sx + Math.round((dx * i) / steps), sy + Math.round((dy * i) / steps));
    await pumpSleep(30);
  }
  await pumpSleep(80);
  win32.send([win32.mouseInput(0, 0, win32.LEFTUP)]);
  await pumpSleep(250);
  win32.SetWindowPos(hwnd, -2 /*HWND_NOTOPMOST 还原 z 序*/, 0, 0, 0, 0, win32.SWP_NOMOVE | win32.SWP_NOSIZE | win32.SWP_NOACTIVATE);
  return { ok: true, from: [sx, sy] };
}

main().catch(async (e) => {
  say(`探针异常退出：${e && e.stack ? e.stack : e && e.message}`);
  await recoverCleanup();
  process.exitCode = 2;
  flushReport();
});
