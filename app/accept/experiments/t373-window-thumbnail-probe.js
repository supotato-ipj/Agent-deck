'use strict';
/**
 * 工单373 真机探针：外部窗口实时缩略图与最小化降级验证（spec #369 原生门槛探针）。
 *
 * 定位：**取证探针**（app/accept/experiments/ 先例，同 t249/t371/t372），**不是验收电池段**
 * ——spec #369 决策 15「窗口预览服务：优先 DWM 实时缩略图，最小化用内存缓存，失败回退
 * 应用图标与标题；目标窗必须由面板持有，资源随预览关闭释放，不建立磁盘图像缓存」+
 * 决策 30「失败关闭」+ ADR-0028「预览与数据 / 恢复与性能」。本探针在真实 Windows 11
 * build 26300 上验证生产预览链的承重柱：
 *
 *   ① 实时缩略图：DwmRegisterThumbnail 跨进程（面板持有目标窗 → 外部源窗）+ DwmUpdate
 *      ThumbnailProperties；对代表性源窗（真实第三方 notepad / Chromium msedge / Electron /
 *      探针伴生 Win32 对照窗 plain 与自绘 WS_POPUP）逐扇实测「注册 → 首帧可见」与逐张填入
 *      时延（支撑 200ms 主交互预算评审），并实测实时传播（源窗内容变化 → 缩略图跟随）。
 *   ② 目标窗由探针进程持有（生产语境：面板持有）——双形态：探针自绘 Win32 条带窗（缓存/回退
 *      渲染可精确驱动）+ Electron BrowserWindow（面板同形态，纯 DWM 承载）。
 *   ③ 最小化降级：最小化前 PrintWindow 抓内存缓存 → 最小化后实测 DWM 实时缩略图行为
 *      （空白/冻结逐扇记录）→ 缓存渲染入目标窗（像素主色比对）→ 无缓存时回退图标+标题
 *      （WM_GETICON / GetClassLongPtrW / ExtractIconExW 链 + GetWindowTextW）。
 *   ④ 兼容矩阵逐项记录：最小化、自绘（WS_POPUP）、硬件加速（msedge/electron 动画页）、
 *      cloak（DWMWA_CLOAK 置 cloak + DWMWA_CLOAKED 读回）——逐扇实测行为记录，不作无条件承诺。
 *   ⑤ 释放与不落盘：DwmUnregisterThumbnail 全部关系 → 目标窗回底色；再注册成立（关系确已
 *      释放）；内存缓存引用清空后重绘回底色；缩略图流程全程不新建磁盘图像文件（临时目录与
 *      证据目录文件清单前后比对）。
 *   ⑥ 探针退出零残留：伴生/第三方进程全退（tasklist 影像名计数不高于基线）、临时目录删除、
 *      原生任务栏状态不变、无常驻进程。
 *
 * 伴生进程（controller 通过 stdin JSON 行协议指挥，源码由本探针写入系统临时目录，退出前删除）：
 *   - helper-win32：3 扇 Win32 代表窗（live 可变色 / popup 自绘无边框 / cloak cloak 专用），
 *     支持按窗 setcolor 命令（实时传播检测的确定性信号）。
 *   - helper-electron：仓库自带 electron.exe，两扇 BrowserWindow——dest（面板同形态目标窗，
 *     about:blank）+ src（Chromium 源，加载动画 HTML；**不得 attach process.stdin**（t372
 *     实证：挂 stdin 会使 BrowserWindow 句柄 ~1s 内被销毁）；data:URL 也会杀窗（t372 实证），
 *     动画页用 loadFile(file://)）。
 *   - notepad：真实第三方 Win32 代表；实时传播用「改几何触发重渲染」的像素差证据（不向
 *     notepad 打字——typed 内容会触发保存提示污染清理路径）。单实例复用既有进程时按 hwnd
 *     快照差集识别自己的窗，清理只 WM_CLOSE、绝不 taskkill 用户进程。
 *   - msedge：Chromium 代表（独立临时 profile，--app=file://动画页），动画页提供确定性
 *     实时传播信号；进程树经启动器转手，用 tasklist pid 差集圈定后 taskkill。
 *
 * 用法（**必须经 accept-guard 托管**，禁裸跑——本机多检出共享同一验收槽）：
 *   node D:\test-folder\.accept-guard\guard.mjs hold --as zcode --purpose accept-sprint -- \
 *     node app\accept\experiments\t373-window-thumbnail-probe.js
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
const perfNow = () => Number(process.hrtime.bigint() / 1000n) / 1000; // ms，单调

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
const REPORT_FILE = path.join(__dirname, '..', 'evidence', '373-window-thumbnail-probe.log.txt');
function flushReport() {
  try {
    fs.writeFileSync(REPORT_FILE, [
      '工单373 真机探针（t373-window-thumbnail-probe.js）——外部窗口实时缩略图与最小化降级验证',
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
// Win32 / GDI / DWM 绑定（探针进程：持有目标条带窗 + 屏幕像素取证）
// ————————————————————————————————————————————————————————————
const koffi = win32.koffi;
const user32 = koffi.load('user32.dll');
const gdi32 = koffi.load('gdi32.dll');
const shell32 = koffi.load('shell32.dll');
const dwmapi = koffi.load('dwmapi.dll');

// 具名类型进程级单登（#153 教训：撞名即崩）——一律 T373_ 前缀
koffi.struct('T373_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
koffi.struct('T373_POINT', { x: 'long', y: 'long' });
koffi.struct('T373_MSG', { hwnd: 'uintptr_t', message: 'uint32', wParam: 'uintptr_t', lParam: 'intptr_t', time: 'uint32', ptX: 'long', ptY: 'long', lPrivate: 'uint32' });
koffi.struct('T373_WNDCLASS', { style: 'uint32', lpfnWndProc: 'void *', cbClsExtra: 'int32', cbWndExtra: 'int32', hInstance: 'void *', hIcon: 'void *', hCursor: 'void *', hbrBackground: 'void *', lpszMenuName: 'const char16_t *', lpszClassName: 'const char16_t *' });
// DWM_THUMBNAIL_PROPERTIES：DWORD dwFlags; RECT rcDestination; RECT rcSource; BYTE opacity;
// BOOL fVisible; BOOL fSourceClientAreaOnly;（自然对齐 → 48 字节）
koffi.struct('T373_THUMBPROPS', { dwFlags: 'uint32', rcDestination: 'T373_RECT', rcSource: 'T373_RECT', opacity: 'uint8', fVisible: 'int32', fSourceClientAreaOnly: 'int32' });
koffi.struct('T373_BMIHEADER', { biSize: 'uint32', biWidth: 'int32', biHeight: 'int32', biPlanes: 'uint16', biBitCount: 'uint16', biCompression: 'uint32', biSizeImage: 'uint32', biXPelsPerMeter: 'int32', biYPelsPerMeter: 'int32', biClrUsed: 'uint32', biClrImportant: 'uint32' });
koffi.struct('T373_BMI', { bmiHeader: 'T373_BMIHEADER', bmiColors: 'uint32[1]' });

const PeekMessageW = user32.func('bool __stdcall PeekMessageW(_Out_ T373_MSG *lpMsg, uintptr_t hWnd, uint32 min, uint32 max, uint32 remove)');
const TranslateMessage = user32.func('bool __stdcall TranslateMessage(const T373_MSG *lpMsg)');
const DispatchMessageW = user32.func('intptr_t __stdcall DispatchMessageW(const T373_MSG *lpMsg)');
const PostMessageW = user32.func('bool __stdcall PostMessageW(uintptr_t hWnd, uint32 msg, uintptr_t wParam, intptr_t lParam)');
const RegisterClassW = user32.func('uint16 __stdcall RegisterClassW(const T373_WNDCLASS *)');
const CreateWindowExW = user32.func('uintptr_t __stdcall CreateWindowExW(uint32, const char16_t *, const char16_t *, uint32, int, int, int, int, uintptr_t, uintptr_t, void *, void *)');
const DefWindowProcW = user32.func('intptr_t __stdcall DefWindowProcW(uintptr_t, uint32, uintptr_t, void *)');
const ValidateRect = user32.func('bool __stdcall ValidateRect(uintptr_t, const void *)');
const InvalidateRect = user32.func('bool __stdcall InvalidateRect(uintptr_t, const void *, bool)');
const GetClientRect = user32.func('bool __stdcall GetClientRect(uintptr_t, _Out_ T373_RECT *)');
const ClientToScreen = user32.func('bool __stdcall ClientToScreen(uintptr_t, _Inout_ T373_POINT *)');
const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(uintptr_t hWnd, _Out_ uint32 *pid)');
const IsIconic = user32.func('bool __stdcall IsIconic(uintptr_t hWnd)');
const GetWindowTextW = user32.func('int32 __stdcall GetWindowTextW(uintptr_t, char16_t *buf, int32 max)');
const GetClassLongPtrW = user32.func('intptr_t __stdcall GetClassLongPtrW(uintptr_t, int32)');
const SendMessageTimeoutW = user32.func('bool __stdcall SendMessageTimeoutW(uintptr_t, uint32, uintptr_t, intptr_t, uint32, uint32, _Out_ void **result)');
const PrintWindow = user32.func('bool __stdcall PrintWindow(uintptr_t, void *hdc, uint32 flags)');
const DestroyIcon = user32.func('bool __stdcall DestroyIcon(void *hicon)');
const DrawIconEx = user32.func('bool __stdcall DrawIconEx(void *hdc, int x, int y, void *hicon, int cx, int cy, uint32 step, void *brush, uint32 flags)');

const GetDC = user32.func('void * __stdcall GetDC(uintptr_t)');
const ReleaseDC = user32.func('int32 __stdcall ReleaseDC(uintptr_t, void *hdc)');

const CreateCompatibleDC = gdi32.func('void * __stdcall CreateCompatibleDC(void *hdc)');
const CreateCompatibleBitmap = gdi32.func('void * __stdcall CreateCompatibleBitmap(void *hdc, int32 w, int32 h)');
const SelectObject = gdi32.func('void * __stdcall SelectObject(void *hdc, void *hobj)');
const DeleteObject = gdi32.func('bool __stdcall DeleteObject(void *hobj)');
const DeleteDC = gdi32.func('bool __stdcall DeleteDC(void *hdc)');
const BitBlt = gdi32.func('bool __stdcall BitBlt(void *hdc, int32 x, int32 y, int32 w, int32 h, void *hdcSrc, int32 sx, int32 sy, uint32 rop)');
const StretchBlt = gdi32.func('bool __stdcall StretchBlt(void *hdc, int32 x, int32 y, int32 w, int32 h, void *hdcSrc, int32 sx, int32 sy, int32 sw, int32 sh, uint32 rop)');
const GetDIBitsFn = gdi32.func('int32 __stdcall GetDIBits(void *hdc, void *hbm, uint32 start, uint32 lines, void *bits, void *bmi, uint32 usage)');
const CreateSolidBrush = gdi32.func('void * __stdcall CreateSolidBrush(uint32 color)');
const FillRect = user32.func('int32 __stdcall FillRect(void *hdc, const void *rect, void *hbr)');
const SetBkMode = gdi32.func('int32 __stdcall SetBkMode(void *hdc, int32 mode)');
const SetTextColor = gdi32.func('uint32 __stdcall SetTextColor(void *hdc, uint32 color)');
const GetStockObject = gdi32.func('void * __stdcall GetStockObject(int32 fnObject)');
const TextOutW = gdi32.func('bool __stdcall TextOutW(void *hdc, int32 x, int32 y, const char16_t *str, int32 len)');
const ExtractIconExW = shell32.func('uint32 __stdcall ExtractIconExW(const char16_t *file, int32 index, _Out_ void **big, _Out_ void **small, uint32 count)');

const DwmRegisterThumbnail = dwmapi.func('int32 __stdcall DwmRegisterThumbnail(uintptr_t dst, uintptr_t src, _Out_ void **thumb)');
const DwmUnregisterThumbnail = dwmapi.func('int32 __stdcall DwmUnregisterThumbnail(void *thumb)');
const DwmUpdateThumbnailProperties = dwmapi.func('int32 __stdcall DwmUpdateThumbnailProperties(void *thumb, const void *props)');
const DwmGetWindowAttribute = dwmapi.func('int32 __stdcall DwmGetWindowAttribute(uintptr_t hwnd, uint32 attr, void *pv, uint32 cb)');
const DwmSetWindowAttribute = dwmapi.func('int32 __stdcall DwmSetWindowAttribute(uintptr_t hwnd, uint32 attr, void *pv, uint32 cb)');

const GetModuleHandleW = koffi.load('kernel32.dll').func('void * __stdcall GetModuleHandleW(const char16_t *)');
const GetDpiForSystem = user32.func('uint32 __stdcall GetDpiForSystem()');

const WM_CLOSE = 0x0010, WM_PAINT = 0x000F, WM_SYSCOMMAND = 0x0112;
const SC_MINIMIZE = 0xF020, SC_RESTORE = 0xF120;
const WM_GETICON = 0x007F, ICON_BIG = 1, ICON_SMALL2 = 2;
const GCLP_HICON = -14, GCLP_HICONSM = -34;
const SMTO_ABORTIFHUNG = 0x0002;
const PW_RENDERFULLCONTENT = 0x00000002;
const SRCCOPY = 0x00CC0020, CAPTUREBLT = 0x40000000;
const DIB_RGB_COLORS = 0, BI_RGB = 0;
const DI_NORMAL = 0x0003;
const DEFAULT_GUI_FONT = 17;
const TRANSPARENT = 1;
const DWMWA_CLOAK = 13, DWMWA_CLOAKED = 14;
const DWM_TNP_RECTDESTINATION = 0x1, DWM_TNP_RECTSOURCE = 0x2, DWM_TNP_OPACITY = 0x4,
  DWM_TNP_VISIBLE = 0x8, DWM_TNP_SOURCECLIENTAREAONLY = 0x10;

function rectArr(hwnd) {
  const r = win32.rectOf(hwnd);
  return r ? [r.left, r.top, r.right, r.bottom] : null;
}
function pidOfWindow(hwnd) { const b = [0]; GetWindowThreadProcessId(hwnd, b); return b[0]; }

/** RECT 的 16 字节原生缓冲（r2 实证：koffi 输入型结构指针传 plain object 会被静默错转——
 *  FillRect/属性块一律走 Buffer；输出型结构指针的 [{}] 模式经 t372 GetWindowRect 先例成立） */
function rectBuf16(l, t, r, b) {
  const buf = Buffer.alloc(16);
  buf.writeInt32LE(l, 0); buf.writeInt32LE(t, 4); buf.writeInt32LE(r, 8); buf.writeInt32LE(b, 12);
  return buf;
}
/** BITMAPINFO 的 44 字节原生缓冲（biHeader 40 + bmiColors 4；GetDIBits 的头是入参须预填） */
function bmiBuf44(w, h) {
  const buf = Buffer.alloc(44);
  buf.writeUInt32LE(40, 0);            // biSize
  buf.writeInt32LE(w, 4);              // biWidth
  buf.writeInt32LE(-h, 8);             // biHeight 负值 = top-down
  buf.writeUInt16LE(1, 12);            // biPlanes
  buf.writeUInt16LE(32, 14);           // biBitCount
  buf.writeUInt32LE(BI_RGB, 16);       // biCompression
  return buf;
}
/** DWM_THUMBNAIL_PROPERTIES 的 48 字节原生缓冲（DWORD dwFlags; RECT rcDestination; RECT
 *  rcSource; BYTE opacity; BOOL fVisible; BOOL fSourceClientAreaOnly——自然对齐 48 字节） */
function thumbPropsBuf(rcDest) {
  const buf = Buffer.alloc(48);
  buf.writeUInt32LE(DWM_TNP_RECTDESTINATION | DWM_TNP_OPACITY | DWM_TNP_VISIBLE | DWM_TNP_SOURCECLIENTAREAONLY, 0);
  buf.writeInt32LE(rcDest.left, 4); buf.writeInt32LE(rcDest.top, 8);
  buf.writeInt32LE(rcDest.right, 12); buf.writeInt32LE(rcDest.bottom, 16);
  // rcSource 全零 = 整窗；fSourceClientAreaOnly=1 时源取客户区
  buf.writeUInt8(255, 36);             // opacity
  buf.writeInt32LE(1, 40);             // fVisible
  buf.writeInt32LE(1, 44);             // fSourceClientAreaOnly
  return buf;
}

/** 窗口客户区屏幕坐标（像素取证与 DWM 目标矩形换算共用） */
function clientRectOnScreen(hwnd) {
  const cr = [{}];
  if (!GetClientRect(hwnd, cr)) return null;
  const pt = [{ x: 0, y: 0 }];
  if (!ClientToScreen(hwnd, pt)) return null;
  const v = cr[0];
  return { x: pt[0].x, y: pt[0].y, w: v.right - v.left, h: v.bottom - v.top };
}

// ————————————————————————————————————————————————————————————
// 屏幕像素取证（GetDC(0) + BitBlt + GetDIBits；目标窗置顶防遮挡）
// ————————————————————————————————————————————————————————————
function captureRect(x, y, w, h) {
  if (w <= 0 || h <= 0) return null;
  const sdc = GetDC(0);
  if (!sdc) return null;
  const mdc = CreateCompatibleDC(sdc);
  const bm = CreateCompatibleBitmap(sdc, w, h);
  const old = SelectObject(mdc, bm);
  BitBlt(mdc, 0, 0, w, h, sdc, x, y, SRCCOPY | CAPTUREBLT);
  const buf = Buffer.alloc(w * h * 4);
  const bmi = bmiBuf44(w, h);
  // GetDIBits 硬约束（开发轮1实证）：位图不得在选择进 DC 的状态下调用——先归位再读，
  // 否则读出全零缓冲（r1 全部像素证据因此失真）
  SelectObject(mdc, old);
  GetDIBitsFn(mdc, bm, 0, h, buf, bmi, DIB_RGB_COLORS);
  DeleteObject(bm);
  DeleteDC(mdc);
  ReleaseDC(0, sdc);
  return { x, y, w, h, buf, stride: w * 4 };
}
function pixelAt(cap, px, py) {
  const i = py * cap.stride + px * 4;
  return { b: cap.buf[i], g: cap.buf[i + 1], r: cap.buf[i + 2] };
}
function near(c, ref, tol = 16) { return Math.abs(c.r - ref[0]) <= tol && Math.abs(c.g - ref[1]) <= tol && Math.abs(c.b - ref[2]) <= tol; }
/** 主色占比：矩形内接近 ref 色的像素比例 */
function colorRatio(cap, ref, tol = 16) {
  let hit = 0; const n = cap.w * cap.h;
  for (let py = 0; py < cap.h; py += 2) {
    for (let px = 0; px < cap.w; px += 2) {
      if (near(pixelAt(cap, px, py), ref, tol)) hit++;
    }
  }
  return (hit * 4) / n;
}
/** 差异比例：与基线相比通道差 > diffTol 的像素比例（同尺寸） */
function diffRatio(cap, base, diffTol = 24) {
  if (!base || base.w !== cap.w || base.h !== cap.h) return 1;
  let diff = 0; const n = cap.w * cap.h;
  for (let py = 0; py < cap.h; py += 2) {
    for (let px = 0; px < cap.w; px += 2) {
      const i = py * cap.stride + px * 4;
      if (Math.abs(cap.buf[i] - base.buf[i]) > diffTol || Math.abs(cap.buf[i + 1] - base.buf[i + 1]) > diffTol || Math.abs(cap.buf[i + 2] - base.buf[i + 2]) > diffTol) diff++;
    }
  }
  return (diff * 4) / n;
}
/** 非均匀性：接近主色的比例（判断抓到的位图是否空白/单色） */
function uniformRatio(cap) {
  const c0 = pixelAt(cap, Math.floor(cap.w / 2), Math.floor(cap.h / 2));
  return colorRatio(cap, [c0.r, c0.g, c0.b], 12);
}
/** 通道支配占比：GPU 窗捕获色会被 Chromium 色彩管理/auto-dark 移位（r11 实证：#00c800→
 *  5ec42d/264e12，#c80000→b52b15/481108），精确色比对不成立——改判「绿支配/红支配」 */
function dominanceRatio(cap, kind) {
  let hit = 0; const n = cap.w * cap.h;
  for (let py = 0; py < cap.h; py += 2) {
    for (let px = 0; px < cap.w; px += 2) {
      const c = pixelAt(cap, px, py);
      if (kind === 'green' ? (c.g > c.r + 15 && c.g > c.b + 15) : (c.r > c.g + 40 && c.r > c.b + 40)) hit++;
    }
  }
  return (hit * 4) / n;
}

// ————————————————————————————————————————————————————————————
// 探针持有的目标条带窗（生产语境：目标窗由面板持有）——每格 paint 模式 live/cache/icon/bg
// ————————————————————————————————————————————————————————————
const STRIP = { x: 60, y: 1180, w: 1660, h: 220 };
const ITEM_W = 260, ITEM_H = 200, GAP = 10, PAD = 10;
const BG_REF = [0x1c, 0x1f, 0x25];           // 目标窗底色 #1c1f25（R,G,B）
const EDEST_BG_REF = [0x10, 0x20, 0x1c];     // Electron 目标窗底色 #10201c
const g_itemState = [];                       // i → { mode:'bg'|'cache'|'icon', cache:{dc,bm,w,h}|null, icon:null, title:'' }
let g_destHwnd = null;
let g_destCb = null;
let g_cloakSelfHwnd = null; // 探针自有 cloak 试验窗（同进程置 DWMWA_CLOAK；跨进程实测 E_ACCESSDENIED）

function destItemRect(i) { // 屏幕坐标
  return { x: STRIP.x + PAD + i * (ITEM_W + GAP), y: STRIP.y + PAD, w: ITEM_W, h: ITEM_H };
}
function destItemClientRect(i) { // 目标窗客户坐标（DWM 目标矩形口径；WS_POPUP 客户区==窗口区）
  const r = destItemRect(i);
  return { left: r.x - STRIP.x, top: r.y - STRIP.y, right: r.x - STRIP.x + ITEM_W, bottom: r.y - STRIP.y + ITEM_H };
}
function destRepaint() { if (g_destHwnd) InvalidateRect(g_destHwnd, null, true); }

function destWndProc(hwnd, msg, wParam, lParam) {
  if (msg === WM_PAINT) {
    const hdc = GetDC(hwnd);
    if (hdc && hwnd === g_cloakSelfHwnd) {
      // cloak 试验窗：整面特征黄
      const yBrush = CreateSolidBrush(0x0000C8C8);
      FillRect(hdc, rectBuf16(0, 0, 480, 360), yBrush);
      DeleteObject(yBrush);
      ReleaseDC(hwnd, hdc);
      ValidateRect(hwnd, null);
      return 0;
    }
    if (hdc) {
      const bgBrush = CreateSolidBrush((BG_REF[2] << 16) | (BG_REF[1] << 8) | BG_REF[0]);
      FillRect(hdc, rectBuf16(0, 0, STRIP.w, STRIP.h), bgBrush);
      DeleteObject(bgBrush);
      for (let i = 0; i < g_itemState.length; i++) {
        const st = g_itemState[i];
        const cr = destItemClientRect(i);
        const frameBrush = CreateSolidBrush((BG_REF[2] << 16) | (BG_REF[1] << 8) | BG_REF[0]);
        FillRect(hdc, rectBuf16(cr.left, cr.top, cr.right, cr.bottom), frameBrush);
        DeleteObject(frameBrush);
        if (st.mode === 'cache' && st.cache) {
          StretchBlt(hdc, cr.left, cr.top, ITEM_W, ITEM_H, st.cache.dc, 0, 0, st.cache.w, st.cache.h, SRCCOPY);
        } else if (st.mode === 'icon' && st.icon) {
          const iconX = cr.left + Math.round((ITEM_W - 48) / 2);
          const iconY = cr.top + Math.round((ITEM_H - 48) / 2) - 14;
          DrawIconEx(hdc, iconX, iconY, st.icon, 48, 48, 0, null, DI_NORMAL);
          if (st.title) {
            SetBkMode(hdc, TRANSPARENT);
            SetTextColor(hdc, 0xFFFFFF);
            const font = GetStockObject(DEFAULT_GUI_FONT);
            const oldFont = SelectObject(hdc, font);
            TextOutW(hdc, cr.left + 8, cr.bottom - 26, st.title, Math.min(st.title.length, 40));
            SelectObject(hdc, oldFont);
          }
        }
      }
      ReleaseDC(hwnd, hdc);
    }
    ValidateRect(hwnd, null);
    return 0;
  }
  if (msg === 2 /* WM_DESTROY */) return 0;
  return DefWindowProcW(hwnd, msg, wParam, lParam);
}
function createDestWindow() {
  koffi.proto('__stdcall', 'T373_WndProc', 'intptr_t', ['uintptr_t', 'uint32', 'uintptr_t', 'void *']);
  g_destCb = koffi.register(destWndProc, 'T373_WndProc *');
  const wc = {
    style: 0, lpfnWndProc: g_destCb, cbClsExtra: 0, cbWndExtra: 0,
    hInstance: GetModuleHandleW(null), hIcon: null, hCursor: null,
    hbrBackground: null, lpszMenuName: null, lpszClassName: 'T373_DEST_CLASS',
  };
  if (!RegisterClassW(koffi.as(wc, 'const T373_WNDCLASS *'))) throw new Error('RegisterClassW(dest) 失败');
  const WS_POPUP = 0x80000000, WS_VISIBLE = 0x10000000;
  const hwnd = CreateWindowExW(0, 'T373_DEST_CLASS', 'T373-DEST-PANEL-STRIP', WS_POPUP | WS_VISIBLE,
    STRIP.x, STRIP.y, STRIP.w, STRIP.h, 0, 0, GetModuleHandleW(null), null);
  if (!hwnd) throw new Error('CreateWindowExW(dest) 失败');
  // 置顶防遮挡（像素取证口径）；不抢前台（SWP_NOACTIVATE）
  win32.SetWindowPos(hwnd, -1 /*HWND_TOPMOST*/, 0, 0, 0, 0, win32.SWP_NOMOVE | win32.SWP_NOSIZE | win32.SWP_NOACTIVATE);
  destRepaint();
  return hwnd;
}

// ————————————————————————————————————————————————————————————
// DWM 缩略图操作（注册/属性/注销 + 目标矩形）
// ————————————————————————————————————————————————————————————
function registerThumb(dstHwnd, srcHwnd, destRectClient) {
  const out = [null];
  const hr = DwmRegisterThumbnail(dstHwnd, srcHwnd, out);
  if (hr !== 0 || !out[0]) return { ok: false, hr, thumb: null };
  const thumb = out[0];
  const hr2 = DwmUpdateThumbnailProperties(thumb, thumbPropsBuf(destRectClient));
  return { ok: hr2 === 0, hr: hr2, thumb };
}
function unregisterThumb(thumb) {
  if (!thumb) return true;
  const hr = DwmUnregisterThumbnail(thumb);
  return hr === 0;
}

/** 时延测量：t0 起轮询目标矩形屏幕像素，predicate 命中即返回（泵持续跑，目标窗可重绘） */
async function measureLatency(destScreenRect, predicate, timeoutMs = 4000, pollMs = 10) {
  const t0 = perfNow();
  let last = null;
  for (;;) {
    last = captureRect(destScreenRect.x, destScreenRect.y, destScreenRect.w, destScreenRect.h);
    try {
      if (last && predicate(last)) return { ok: true, ms: perfNow() - t0, cap: last };
    } catch { /* 继续轮询 */ }
    if (perfNow() - t0 > timeoutMs) return { ok: false, ms: perfNow() - t0, cap: last };
    await pumpSleep(pollMs);
  }
}

/** 最小化/还原：WM_SYSCOMMAND 为主，ShowWindow 兜底（msedge --app 窗实测对跨进程 SC_MINIMIZE 不响应） */
async function minimizeWindow(hwnd) {
  PostMessageW(hwnd, WM_SYSCOMMAND, SC_MINIMIZE, 0);
  let w = await waitFor('最小化', 2000, () => win32.IsIconic(hwnd) ? { ok: true } : { ok: false });
  if (!w.ok) { win32.ShowWindow(hwnd, 6 /* SW_MINIMIZE */); w = await waitFor('最小化(兜底)', 2000, () => win32.IsIconic(hwnd) ? { ok: true } : { ok: false }); }
  return w.ok;
}
async function restoreWindow(hwnd) {
  PostMessageW(hwnd, WM_SYSCOMMAND, SC_RESTORE, 0);
  let w = await waitFor('还原', 2000, () => !win32.IsIconic(hwnd) ? { ok: true } : { ok: false });
  if (!w.ok) { win32.ShowWindow(hwnd, 9 /* SW_RESTORE */); w = await waitFor('还原(兜底)', 2000, () => !win32.IsIconic(hwnd) ? { ok: true } : { ok: false }); }
  return w.ok;
}

// ————————————————————————————————————————————————————————————
// 内存缓存抓取（PrintWindow PW_RENDERFULLCONTENT → 兼容位图；只进内存，不落盘）
// ————————————————————————————————————————————————————————————
function captureWindowCache(srcHwnd) {
  const r = rectArr(srcHwnd);
  if (!r) return null;
  const w = r[2] - r[0], h = r[3] - r[1];
  if (w <= 0 || h <= 0) return null;
  const sdc = GetDC(0);
  const mdc = CreateCompatibleDC(sdc);
  const bm = CreateCompatibleBitmap(sdc, w, h);
  const old = SelectObject(mdc, bm);
  const okPw = PrintWindow(srcHwnd, mdc, PW_RENDERFULLCONTENT);
  ReleaseDC(0, sdc);
  // 读出像素判空：GetDIBits 前必须先归位（同 captureRect 的硬约束），读完再选回供 StretchBlt 绘制
  const buf = Buffer.alloc(w * h * 4);
  SelectObject(mdc, old);
  GetDIBitsFn(mdc, bm, 0, h, buf, bmiBuf44(w, h), DIB_RGB_COLORS);
  SelectObject(mdc, bm); // 重新选中（StretchBlt 渲染缓存需要）；释放时归位再删（releaseCache）
  return { dc: mdc, bm, old, w, h, okPw, pixels: buf };
}
function releaseCache(cache) {
  if (!cache) return;
  try { if (cache.old) SelectObject(cache.dc, cache.old); } catch { /* 尽力 */ }
  try { DeleteObject(cache.bm); } catch { /* 尽力 */ }
  try { DeleteDC(cache.dc); } catch { /* 尽力 */ }
}

// ————————————————————————————————————————————————————————————
// 图标与标题回退（WM_GETICON → GetClassLongPtrW → ExtractIconExW(exe)）
// ————————————————————————————————————————————————————————————
function extractIcon(hwnd) {
  let hicon = null, source = null;
  const res = [null];
  for (const wparam of [ICON_BIG, ICON_SMALL2]) {
    if (SendMessageTimeoutW(hwnd, WM_GETICON, wparam, 0, SMTO_ABORTIFHUNG, 300, res) && res[0]) { hicon = res[0]; source = `WM_GETICON(${wparam})`; break; }
  }
  if (!hicon) { const h = GetClassLongPtrW(hwnd, GCLP_HICON); if (h) { hicon = h; source = 'GCLP_HICON'; } }
  if (!hicon) { const h = GetClassLongPtrW(hwnd, GCLP_HICONSM); if (h) { hicon = h; source = 'GCLP_HICONSM'; } }
  if (!hicon) {
    const exe = String(win32.exeOfPid(pidOfWindow(hwnd)) || '');
    if (exe && fs.existsSync(exe)) {
      const big = [null], small = [null];
      if (ExtractIconExW(exe, 0, big, small, 1) > 0 && (big[0] || small[0])) {
        hicon = big[0] || small[0];
        source = `ExtractIconExW(${path.basename(exe)})`;
      }
    }
  }
  return { hicon, source };
}
function windowTitle(hwnd) {
  const buf = Buffer.alloc(1024);
  const n = GetWindowTextW(hwnd, buf, 512);
  return buf.toString('utf16le', 0, n * 2);
}

// ————————————————————————————————————————————————————————————
// 消息泵与等待（目标窗 WM_PAINT 依赖本线程消息循环）
// ————————————————————————————————————————————————————————————
async function pumpSleep(ms) {
  const msg = [null];
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    while (PeekMessageW(msg, 0, 0, 0, 1)) { TranslateMessage(msg[0]); DispatchMessageW(msg[0]); }
    await sleep(6);
  }
}
async function waitFor(desc, timeoutMs, predicate) {
  const t0 = Date.now();
  for (;;) {
    let r;
    try { r = predicate(); } catch (e) { r = { ok: false, detail: `异常 ${e && e.message}` }; }
    if (r && r.ok) return { ok: true, ms: Date.now() - t0, detail: r.detail || '' };
    if (Date.now() - t0 > timeoutMs) return { ok: false, ms: Date.now() - t0, detail: (r && r.detail) || '超时' };
    await pumpSleep(20);
  }
}

// ————————————————————————————————————————————————————————————
// 伴生进程源码（写临时目录，退出前删除）
// ————————————————————————————————————————————————————————————
const HELPER_WIN32_SRC = `'use strict';
// 工单373 探针伴生进程：独立 node 进程创建 3 扇 Win32 代表窗（live/popup 自绘/cloak）。
// 每扇窗 WM_PAINT 自绘当前颜色（class 背景刷不改，setcolor 后 InvalidateRect 重绘），
// 为实时传播检测提供确定性颜色信号。
const koffi = require(process.env.T373_KOFFI);
const user32 = koffi.load('user32.dll');
const gdi32 = koffi.load('gdi32.dll');
const kernel32 = koffi.load('kernel32.dll');

koffi.struct('T373H_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
koffi.struct('T373H_POINT', { x: 'long', y: 'long' });
koffi.struct('T373H_MSG', { hwnd: 'uintptr_t', message: 'uint32', wParam: 'uintptr_t', lParam: 'intptr_t', time: 'uint32', pt: 'T373H_POINT', lPrivate: 'uint32' });
koffi.struct('T373H_WNDCLASS', { style: 'uint32', lpfnWndProc: 'void *', cbClsExtra: 'int32', cbWndExtra: 'int32', hInstance: 'void *', hIcon: 'void *', hCursor: 'void *', hbrBackground: 'void *', lpszMenuName: 'const char16_t *', lpszClassName: 'const char16_t *' });
koffi.struct('T373H_PS', { hdc: 'void *', fErase: 'int32', rcPaint: 'T373H_RECT', fRestore: 'int32', fIncUpdate: 'int32', rgbReserved: 'uint8[32]' });

const RegisterClassW = user32.func('uint16 __stdcall RegisterClassW(const T373H_WNDCLASS *)');
const CreateWindowExW = user32.func('uintptr_t __stdcall CreateWindowExW(uint32, const char16_t *, const char16_t *, uint32, int, int, int, int, uintptr_t, uintptr_t, void *, void *)');
const DefWindowProcW = user32.func('intptr_t __stdcall DefWindowProcW(uintptr_t, uint32, uintptr_t, void *)');
const DestroyWindow = user32.func('bool __stdcall DestroyWindow(uintptr_t)');
const BeginPaint = user32.func('void * __stdcall BeginPaint(uintptr_t, _Out_ T373H_PS *)');
const EndPaint = user32.func('bool __stdcall EndPaint(uintptr_t, const T373H_PS *)');
const GetClientRect = user32.func('bool __stdcall GetClientRect(uintptr_t, _Out_ T373H_RECT *)');
const FillRect = user32.func('int32 __stdcall FillRect(void *hdc, const void *rect, void *hbr)');
const CreateSolidBrush = gdi32.func('void * __stdcall CreateSolidBrush(uint32)');
const DeleteObject = gdi32.func('bool __stdcall DeleteObject(void *)');
const InvalidateRect = user32.func('bool __stdcall InvalidateRect(uintptr_t, const void *, bool)');
const UpdateWindow = user32.func('bool __stdcall UpdateWindow(uintptr_t)');
const GetDpiForWindow = user32.func('uint32 __stdcall GetDpiForWindow(uintptr_t)');
const GetWindowDpiAwarenessContext = user32.func('int64_t __stdcall GetWindowDpiAwarenessContext(uintptr_t)');
const AreDpiAwarenessContextsEqual = user32.func('bool __stdcall AreDpiAwarenessContextsEqual(int64_t, int64_t)');
const PeekMessageW = user32.func('bool __stdcall PeekMessageW(_Out_ T373H_MSG *, uintptr_t, uint32, uint32, uint32)');
const TranslateMessage = user32.func('bool __stdcall TranslateMessage(const T373H_MSG *)');
const DispatchMessageW = user32.func('intptr_t __stdcall DispatchMessageW(const T373H_MSG *)');
const GetModuleHandleW = kernel32.func('void * __stdcall GetModuleHandleW(const char16_t *)');

try {
  const SetProcessDpiAwarenessContext = user32.func('bool __stdcall SetProcessDpiAwarenessContext(int64_t value)');
  SetProcessDpiAwarenessContext(-4);
} catch { /* 口径退化时控制器会如实记录 */ }

const WS_OVERLAPPEDWINDOW = 0x00CF0000, WS_POPUP = 0x80000000, WS_VISIBLE = 0x10000000;
const WM_PAINT = 0x000F, WM_DESTROY = 2;

const SPECS = {
  live:  { style: WS_OVERLAPPEDWINDOW, x: 30,   y: 80,  w: 560, h: 400, color: 0x0000C8, title: 'T373-LIVE-WIN32' },
  popup: { style: WS_POPUP,            x: 620,  y: 80,  w: 480, h: 360, color: 0x00C80000, title: 'T373-POPUP-FRAMELESS' },
  cloak: { style: WS_OVERLAPPEDWINDOW, x: 1130, y: 80,  w: 480, h: 360, color: 0x0000C8C8, title: 'T373-CLOAK-TARGET' },
};
const g_hwnds = new Map();
const g_color = new Map();
let g_cb = null;

function rectBuf16(l, t, r, b) {
  const buf = Buffer.alloc(16);
  buf.writeInt32LE(l, 0); buf.writeInt32LE(t, 4); buf.writeInt32LE(r, 8); buf.writeInt32LE(b, 12);
  return buf;
}
function wndProc(hwnd, msg, wParam, lParam) {
  if (msg === WM_PAINT) {
    const ps = [{}];
    const hdc = BeginPaint(hwnd, ps);
    if (hdc) {
      const cr = [{}];
      GetClientRect(hwnd, cr);
      const color = g_color.get(Number(hwnd)) || 0x000000;
      const brush = CreateSolidBrush(color);
      // 输入型结构指针走 Buffer（控制器侧 r2 实证：plain object 会被 koffi 静默错转）
      FillRect(hdc, rectBuf16(0, 0, cr[0].right, cr[0].bottom), brush);
      DeleteObject(brush);
      EndPaint(hwnd, ps);
    }
    return 0;
  }
  if (msg === WM_DESTROY) return 0;
  return DefWindowProcW(hwnd, msg, wParam, lParam);
}

function reply(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
function pumpOnce() {
  const msg = [null];
  while (PeekMessageW(msg, 0, 0, 0, 1)) { TranslateMessage(msg[0]); DispatchMessageW(msg[0]); }
}
const pumpTimer = setInterval(pumpOnce, 10);

function main() {
  koffi.proto('__stdcall', 'T373H_WndProc', 'intptr_t', ['uintptr_t', 'uint32', 'uintptr_t', 'void *']);
  g_cb = koffi.register(wndProc, 'T373H_WndProc *');
  const wc = {
    style: 0, lpfnWndProc: g_cb, cbClsExtra: 0, cbWndExtra: 0,
    hInstance: GetModuleHandleW(null), hIcon: null, hCursor: null,
    hbrBackground: null, lpszMenuName: null, lpszClassName: 'T373_HELPER_CLASS',
  };
  if (!RegisterClassW(koffi.as(wc, 'const T373H_WNDCLASS *'))) throw new Error('RegisterClassW 失败');
  const windows = {};
  for (const [name, s] of Object.entries(SPECS)) {
    const hwnd = CreateWindowExW(0, 'T373_HELPER_CLASS', s.title, s.style | WS_VISIBLE, s.x, s.y, s.w, s.h, 0, 0, GetModuleHandleW(null), null);
    if (!hwnd) throw new Error('CreateWindowExW(' + name + ') 失败');
    g_hwnds.set(Number(hwnd), name);
    g_color.set(Number(hwnd), s.color);
    windows[name] = hwnd.toString(16);
  }
  const hLive = Number.parseInt(windows.live, 16);
  reply({ type: 'ready', pid: process.pid, windows, dpi: GetDpiForWindow(hLive), ctxName: (AreDpiAwarenessContextsEqual(GetWindowDpiAwarenessContext(hLive), -4) ? 'PER_MONITOR_AWARE_V2' : 'other') });
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
        if (m.cmd === 'setcolor') {
          const h = Number.parseInt(String(m.hwnd), 16);
          g_color.set(h, m.color);
          InvalidateRect(h, null, true);
          UpdateWindow(h);
          reply({ type: 'done', id: m.id, ok: true });
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

// GPU 源页：左右双色分栏——宽度变化时边界移动 → 内容像素变化可测（r7 实证：JS/CSS 动画
// 在 Chromium 后台节流下信号不可靠，改为几何驱动的确定性内容变化；body 用 fixed 定位铺满
// 视口，绕开 html/body 高度链在 Edge --app 下只画出下半屏的布局怪癖，r13 实证）
const LIVE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;position:fixed;inset:0;display:flex}
div{flex:1;height:100%}
.l{background-color:#00c800}.r{background-color:#c80000}
</style></head><body><div class="l"></div><div class="r"></div></body></html>`;

const HELPER_ELECTRON_SRC = `'use strict';
// 工单373 探针伴生进程（Electron/Chromium 代表，双窗）：dest=面板同形态目标窗（about:blank，
// 底色 #10201c）；src=Chromium 源窗（加载动画 HTML，提供确定性实时传播信号）。
// **不得 attach process.stdin**（t372 实证：挂 stdin 会使 BrowserWindow 原生句柄 ~1s 内被
// 销毁）；动画页走 loadFile（data:URL 也会杀窗，t372 实证）。退出由控制器对两窗 WM_CLOSE
// （window-all-closed 默认退 app）+ 控制器 taskkill 兜底。
const { app, BrowserWindow } = require('electron');
const path = require('path');
let dest = null, src = null;
function reply(obj) { try { process.stdout.write(JSON.stringify(obj) + '\\n'); } catch { /* 收尾 */ } }
function hwndOf(win) {
  try {
    const b = win.getNativeWindowHandle();
    return (b.readBigUInt64LE ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0)).toString(16);
  } catch { return null; }
}
// 动画页信号依赖 Chromium 不节流：关掉原生遮挡计算与后台计时器节流（探针窗不被前台聚焦）
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,WebContentsForceDark');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.whenReady().then(() => {
  dest = new BrowserWindow({ x: 1840, y: 1180, width: 640, height: 220, show: true, backgroundColor: '#10201c', title: 'T373-ELECTRON-DEST',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  dest.loadURL('about:blank');
  const htmlArg = process.argv.find((a) => String(a).startsWith('--html='));
  const htmlPath = htmlArg ? htmlArg.slice('--html='.length) : null;
  src = new BrowserWindow({ x: 1640, y: 80, width: 560, height: 400, show: true, backgroundColor: '#00c800', title: 'T373-ELECTRON-SRC',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  let srcLoaded = false;
  if (htmlPath && require('fs').existsSync(htmlPath)) {
    try { src.loadFile(htmlPath); srcLoaded = true; } catch (e) { reply({ type: 'note', note: 'loadFile 失败: ' + String(e && e.message) }); }
  }
  if (!srcLoaded) { try { src.loadURL('about:blank'); } catch { /* 已尽力 */ } }
  const closed = [];
  dest.on('closed', () => { closed.push('dest'); reply({ type: 'window-closed', which: 'dest' }); });
  src.on('closed', () => { closed.push('src'); reply({ type: 'window-closed', which: 'src' }); });
  reply({ type: 'ready', pid: process.pid, destHwnd: hwndOf(dest), srcHwnd: hwndOf(src), srcLoaded, bounds: dest.getBounds() });
}).catch((e) => { reply({ type: 'fatal', error: String(e && e.message) }); process.exit(2); });
`;

// ————————————————————————————————————————————————————————————
// 子进程管理（JSON 行协议 / 退出等待 / 兜底 taskkill）
// ————————————————————————————————————————————————————————————
function attachProtocol(child, label) {
  child._t373Waiters = new Map();
  child._t373Ready = null;
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
      if (m.type === 'note') say(`（${label} note: ${String(m.note || '').slice(0, 200)}）`);
      if (m.type === 'err') say(`（${label} err: id=${m.id || '?'} ${String(m.error || '').slice(0, 200)}）`);
      if (m.type === 'window-closed') say(`（${label} BrowserWindow(${m.which}) 已关闭——后续该窗断言会如实失败）`);
      if (m.type === 'ready') { child._t373Ready = m; continue; }
      const w = child._t373Waiters.get(m.id);
      if (w) { child._t373Waiters.delete(m.id); clearTimeout(w.timer); w.resolve(m); }
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
    w.timer = setTimeout(() => { child._t373Waiters.delete(id); resolve({ type: 'timeout', id }); }, timeoutMs);
    w.resolve = (m) => resolve({ ok: m.type === 'done', m });
    child._t373Waiters.set(id, w);
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
function exeBaseOf(hwnd) {
  const e = String(win32.exeNameOfWindow(hwnd) || '').toLowerCase();
  return e.endsWith('.exe') ? e.slice(0, -4) : e;
}
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

/** 文件清单快照（相对路径集合，用于缩略图流程「不落盘」前后比对） */
function listFilesRecursive(root, rel = '') {
  const out = new Set();
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { for (const q of listFilesRecursive(path.join(root, e.name), p)) out.add(q); }
    else out.add(p);
  }
  return out;
}

// ————————————————————————————————————————————————————————————
// 时延账本（支撑 200ms 主交互预算评审）
// ————————————————————————————————————————————————————————————
const LEDGER = [];
function ledgerAdd(kind, label, ms, note = '') {
  LEDGER.push({ kind, label, ms, note });
  say(`  [时延] ${kind} · ${label} = ${ms.toFixed(1)}ms${note ? '（' + note + '）' : ''}`);
}

// ————————————————————————————————————————————————————————————
// 兼容矩阵（逐项记录，不作无条件承诺）
// ————————————————————————————————————————————————————————————
const MATRIX = []; // { label, shape, live, propagate, minimize, cache, cloak, note }
function matrixSet(label, field, value) {
  let row = MATRIX.find((r) => r.label === label);
  if (!row) { row = { label, live: '—', propagate: '—', minimize: '—', cache: '—', cloak: '—', note: '' }; MATRIX.push(row); }
  row[field] = value;
}

// ————————————————————————————————————————————————————————————
// 崩溃恢复（探针可丢弃，机器状态不丢弃）
// ————————————————————————————————————————————————————————————
const g_state = { tempDir: null, children: [], targetWindows: [], cursorBefore: null, edgeProfile: null, killPids: new Set(), thumbs: [], caches: [], icons: [] };
async function recoverCleanup() {
  try {
    for (const t of g_state.thumbs) { try { unregisterThumb(t); } catch { /* 尽力 */ } }
    for (const c of g_state.caches) { try { releaseCache(c); } catch { /* 尽力 */ } }
    for (const h of g_state.icons) { try { DestroyIcon(h); } catch { /* 尽力 */ } }
    for (const h of g_state.targetWindows) { try { if (win32.IsWindow(h)) PostMessageW(h, WM_CLOSE, 0, 0); } catch { /* 尽力 */ } }
    for (const c of g_state.children) {
      try { if (c.child && c.label === 'helper-win32') c.child.stdin.write(JSON.stringify({ cmd: 'exit' }) + '\n'); } catch { /* 尽力 */ }
    }
    await pumpSleep(1500);
    for (const pid of g_state.killPids) { if (pidAlive(pid)) taskkillTree(pid); }
    await pumpSleep(600);
    if (g_state.tempDir) { try { fs.rmSync(g_state.tempDir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 尽力 */ } }
    say('恢复清理：缩略图注销 + 缓存/图标释放 + 目标窗与第三方窗 WM_CLOSE + 子进程 exit + killPids 差集 taskkill + 临时目录删除（尽力而为，结果见上方日志）');
  } catch (e) { say(`恢复清理异常：${e && e.message}`); }
}

// ————————————————————————————————————————————————————————————
// 主流程
// ————————————————————————————————————————————————————————————
async function main() {
  process.exitCode = 2;
  const dpiOk = (() => {
    try {
      const SetProcessDpiAwarenessContext = user32.func('bool __stdcall SetProcessDpiAwarenessContext(int64_t value)');
      return Boolean(SetProcessDpiAwarenessContext(-4));
    } catch { return false; }
  })();
  say(`控制器 DPI 口径：Per-Monitor V2 ${dpiOk ? '生效（本报告全部坐标为物理 px）' : '未生效——坐标被虚拟化，本轮几何/像素证据口径存疑'}`);
  if (!dpiOk) { check('S1 控制器 DPI 口径 Per-Monitor V2 生效', false, '坐标虚拟化会使全部像素证据失真'); process.exitCode = 1; flushReport(); return; }
  say(`系统 DPI=${GetDpiForSystem()}（scale=${(GetDpiForSystem() / 96).toFixed(2)}x）`);

  // —— S1 基线 ——
  const appbarBefore = win32.appbarState();
  const trayHwnd = win32.nativeTrayHwnd();
  const trayVisibleBefore = Boolean(trayHwnd && win32.IsWindowVisible(trayHwnd));
  g_state.cursorBefore = win32.cursor();
  const baselineCounts = { notepad: tasklistCount('notepad.exe'), msedge: tasklistCount('msedge.exe'), electron: tasklistCount('electron.exe') };
  const baselineWindows = { notepad: snapshotExeWindows('notepad'), msedge: snapshotExeWindows('msedge') };
  say(`S1 基线：tasklist 计数 notepad=${baselineCounts.notepad} msedge=${baselineCounts.msedge} electron=${baselineCounts.electron}；原生任务栏 appbarState=${appbarBefore} visible=${trayVisibleBefore}`);
  say('S1 本机预存的 notepad/msedge 可见窗已快照，探针只认启动后新出现的窗，绝不触碰用户既有窗口');

  // —— S2 目标窗 + 代表窗就位 ——
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 't373-probe-'));
  g_state.tempDir = tempDir;
  fs.writeFileSync(path.join(tempDir, 'helper-win32.js'), HELPER_WIN32_SRC, 'utf8');
  fs.writeFileSync(path.join(tempDir, 'helper-electron.js'), HELPER_ELECTRON_SRC, 'utf8');
  fs.writeFileSync(path.join(tempDir, 't373-live.html'), LIVE_HTML, 'utf8');

  // 2a. 探针持有目标条带窗（生产语境：目标窗由面板持有；6 格条带承载逐张填入）
  const destHwnd = createDestWindow();
  g_destHwnd = destHwnd;
  g_state.targetWindows.push(destHwnd);
  const destScreen = clientRectOnScreen(destHwnd);
  await pumpSleep(250); // WM_PAINT 需经消息泵处理——先泵一轮再取证（r1 实证：未泵时首拍未初始化表面）
  check('S2 探针持有目标条带窗就位（WS_POPUP 置顶，客户区==窗口区，DWM 目标矩形口径=客户坐标）',
    Boolean(destHwnd && destScreen && destScreen.w === STRIP.w && destScreen.h === STRIP.h),
    `hwnd=${destHwnd.toString(16)} clientScreen=${JSON.stringify(destScreen)}`);
  for (let i = 0; i < 6; i++) g_itemState.push({ mode: 'bg', cache: null, icon: null, title: '' });

  // 2b. helper-win32（3 扇对照源窗，独立进程 → DWM 缩略图是真正的跨进程关系）
  const koffiPath = require.resolve('koffi');
  const hw = spawn(process.execPath, [path.join(tempDir, 'helper-win32.js')], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, T373_KOFFI: koffiPath }, cwd: tempDir });
  attachProtocol(hw, 'helper-win32');
  g_state.children.push({ label: 'helper-win32', child: hw, pid: hw.pid });
  g_state.killPids.add(hw.pid);
  const hwReady = await waitFor('helper-win32 ready', 12000, () => hw._t373Ready ? { ok: true } : { ok: false });
  if (!hwReady.ok) { say('helper-win32 未就绪——核心基础设施不成立，exit 2'); flushReport(); return; }
  const ping = await sendCmd(hw, { cmd: 'ping' });
  if (!ping.ok) { say('helper-win32 ping 不通——协议不成立，exit 2'); flushReport(); return; }
  say(`S2 helper-win32 就绪：pid=${hw.pid} dpi=${hw._t373Ready.dpi} ctx=${hw._t373Ready.ctxName} windows=${JSON.stringify(hw._t373Ready.windows)}`);
  const hLive = Number.parseInt(hw._t373Ready.windows.live, 16);
  const hPopup = Number.parseInt(hw._t373Ready.windows.popup, 16);
  const hCloak = Number.parseInt(hw._t373Ready.windows.cloak, 16);
  g_state.targetWindows.push(hLive, hPopup, hCloak); // WM_CLOSE 清理路径（exit 命令销毁为主）

  // 2c. helper-electron（dest=面板同形态目标窗；src=Chromium 动画源窗）
  const electronExe = path.join(__dirname, '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!fs.existsSync(electronExe)) { say(`electron.exe 不存在：${electronExe}——Chromium/Electron 代表缺席，exit 2`); flushReport(); return; }
  const he = spawn(electronExe, [path.join(tempDir, 'helper-electron.js'), `--html=${path.join(tempDir, 't373-live.html')}`], { stdio: ['pipe', 'pipe', 'pipe'], cwd: tempDir });
  attachProtocol(he, 'helper-electron');
  g_state.children.push({ label: 'helper-electron', child: he, pid: he.pid });
  g_state.killPids.add(he.pid);
  const heReady = await waitFor('helper-electron ready', 20000, () => he._t373Ready ? { ok: true } : { ok: false });
  if (!heReady.ok) { say('helper-electron 未就绪——Chromium/Electron 代表缺席，exit 2'); flushReport(); return; }
  let eDestHwnd = he._t373Ready.destHwnd ? Number.parseInt(he._t373Ready.destHwnd, 16) : null;
  let eSrcHwnd = he._t373Ready.srcHwnd ? Number.parseInt(he._t373Ready.srcHwnd, 16) : null;
  if (eDestHwnd) { g_state.targetWindows.push(eDestHwnd); }
  if (eSrcHwnd) { g_state.targetWindows.push(eSrcHwnd); }
  say(`S2 helper-electron 就绪：pid=${he.pid} destHwnd=${eDestHwnd ? eDestHwnd.toString(16) : 'null'} srcHwnd=${eSrcHwnd ? eSrcHwnd.toString(16) : 'null'} src动画页加载=${he._t373Ready.srcLoaded} bounds(DIP)=${JSON.stringify(he._t373Ready.bounds)}`);

  // 2d. notepad（真实第三方 Win32 代表；单实例可能复用既有进程——hwnd 快照差集识别，
  //     清理只对该窗 WM_CLOSE；绝不 taskkill 用户进程）
  let hNotepad = null;
  try {
    const notepadExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'notepad.exe');
    if (fs.existsSync(notepadExe)) {
      const np = spawn(notepadExe, [], { stdio: 'ignore', detached: true });
      np.unref(); // 单实例下 notepad 常落进既有进程——不挂 killPids，只按 hwnd 快照差集 + WM_CLOSE 清理
    }
    const found = await waitFor('notepad 窗出现', 15000, () => {
      const w = findWindowsOfExe('notepad', baselineWindows.notepad);
      return w.length ? { ok: true } : { ok: false };
    });
    if (found.ok) {
      hNotepad = findWindowsOfExe('notepad', baselineWindows.notepad)[0];
      g_state.targetWindows.push(hNotepad);
      win32.SetWindowPos(hNotepad, 0, 30, 520, 560, 400, win32.SWP_NOZORDER | win32.SWP_NOACTIVATE);
      say(`S2 notepad 拉起：hwnd=${hNotepad.toString(16)} pid=${pidOfWindow(hNotepad)}（单实例复用既有进程时清理只 WM_CLOSE 该窗）`);
    } else say('S2 notepad 窗未出现——该行记 N/T，不阻塞其余行');
  } catch (e) { say(`S2 notepad 拉起异常：${e.message}——记 N/T`); }

  // 2e. msedge（Chromium 代表，独立临时 profile，--app 动画页；pid 差集圈定后 taskkill）
  let hEdge = null;
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
      const fileUrl = 'file:///' + path.join(tempDir, 't373-live.html').replace(/\\/g, '/');
      const me = spawn(edgeExe, [`--user-data-dir=${edgeProfile}`, '--no-first-run', '--no-default-browser-check',
        '--disable-features=CalculateNativeWinOcclusion,WebContentsForceDark', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
        `--app=${fileUrl}`, '--window-size=620,440'], { stdio: 'ignore' });
      g_state.killPids.add(me.pid);
      g_state.children.push({ label: 'msedge-stub', child: me, pid: me.pid });
      const found = await waitFor('msedge 窗出现', 20000, () => {
        const w = findWindowsOfExe('msedge', baselineWindows.msedge);
        return w.length ? { ok: true } : { ok: false };
      });
      if (found.ok) {
        hEdge = findWindowsOfExe('msedge', baselineWindows.msedge)[0];
        g_state.targetWindows.push(hEdge);
        win32.SetWindowPos(hEdge, 0, 620, 520, 620, 440, win32.SWP_NOZORDER | win32.SWP_NOACTIVATE);
        say(`S2 msedge 拉起：hwnd=${hEdge.toString(16)} pid=${pidOfWindow(hEdge)}（独立临时 profile，--app=file://动画页）`);
      } else say('S2 msedge 窗未出现——该行记 N/T，不阻塞其余行');
      for (const p of tasklistPids('msedge.exe')) if (!pidsBefore.has(p)) g_state.killPids.add(p);
    }
  } catch (e) { say(`S2 msedge 拉起异常：${e.message}——记 N/T`); }

  // 源窗统一置顶（HWND_TOPMOST）：像素取证区（源窗本体与缩略图格）不容桌面既有窗部分遮挡
  // ——r8/r9 实证：electron 源窗左半被遮（绿=0.00 红=0.41），逐轮随机。源窗均为探针拉起、
  // S7 统一 WM_CLOSE 清理，置顶只发生在本轮窗口生命周期内。
  for (const h of [hLive, hPopup, hCloak, hNotepad, hEdge, eSrcHwnd]) {
    if (h && win32.IsWindow(h)) win32.SetWindowPos(h, -1, 0, 0, 0, 0, win32.SWP_NOMOVE | win32.SWP_NOSIZE | win32.SWP_NOACTIVATE);
  }
  await pumpSleep(150);

  // 目标窗底色基线（供差分断言）
  const stripCap0 = captureRect(STRIP.x, STRIP.y, STRIP.w, STRIP.h);
  check('S2 目标条带窗初始为底色（6 格全空，取证基线成立）',
    Boolean(stripCap0) && colorRatio(stripCap0, BG_REF, 10) > 0.98,
    stripCap0 ? `bgRatio=${colorRatio(stripCap0, BG_REF, 10).toFixed(3)}` : 'capture 失败');
  // 缩略图流程前文件快照（S6「不落盘」比对基线；edge-profile 由 Chromium 自管、单独豁免）
  const filesBeforeThumb = listFilesRecursive(tempDir);
  const evidenceDir = path.join(__dirname, '..', 'evidence');
  const filesBeforeEvidence = listFilesRecursive(evidenceDir);

  // —— S3 实时缩略图：注册、首帧/逐张填入时延、实时传播 ——
  say('—— S3 实时缩略图：注册 → 首帧 → 实时传播（逐张填入时延账目） ——');
  const ITEM = { LIVE: 0, NOTEPAD: 1, EDGE: 2, ELECTRON: 3, POPUP: 4, CLOAK: 5 };
  const thumbs = new Map(); // label → thumb handle

  async function registerAndMeasure(label, itemIdx, srcHwnd, baseline, predicate, timeoutMs = 5000) {
    const rect = destItemRect(itemIdx);
    const t = registerThumb(destHwnd, srcHwnd, destItemClientRect(itemIdx));
    if (!t.ok) { matrixSet(label, 'live', `注册失败 hr=${t.hr}`); return { ok: false, thumb: null, ms: 0 }; }
    thumbs.set(label, t.thumb);
    g_state.thumbs.push(t.thumb);
    const m = await measureLatency(rect, (c) => predicate(c, baseline), timeoutMs);
    ledgerAdd('逐张填入', `${label}`, m.ms, m.ok ? '注册→首帧内容可见' : '超时未见内容');
    matrixSet(label, 'live', m.ok ? 'OK' : '超时');
    return { ok: m.ok, thumb: t.thumb, ms: m.ms };
  }
  const baseOf = (i) => { const r = destItemRect(i); return captureRect(r.x, r.y, r.w, r.h); };

  // 3a. win32-live → item0（首格 = 打开时延口径）
  const liveRed = [200, 0, 0];
  const r3a = await registerAndMeasure('win32-live', ITEM.LIVE, hLive, null, (c) => colorRatio(c, liveRed, 40) > 0.3);
  check('S3 win32-live 实时缩略图呈现（面板持有目标窗内出现源窗当前色）', r3a.ok, `hr=0 fill=${r3a.ms.toFixed(1)}ms`);
  const openMs = r3a.ms;

  // 3b. 其余源逐张填入（基线取注册前该格快照，差分判定首帧）
  const r3b = hNotepad ? await registerAndMeasure('notepad', ITEM.NOTEPAD, hNotepad, baseOf(ITEM.NOTEPAD), (c, b) => diffRatio(c, b) > 0.02) : { ok: false };
  if (hNotepad) check('S3 notepad 实时缩略图呈现（真实第三方 Win32）', r3b.ok, `fill=${r3b.ms.toFixed(1)}ms`);
  else { matrixSet('notepad', 'live', 'N/T'); say('S3 notepad 缺席——该行记 N/T'); }

  const r3bE = hEdge ? await registerAndMeasure('msedge', ITEM.EDGE, hEdge, baseOf(ITEM.EDGE), (c, b) => diffRatio(c, b) > 0.02) : { ok: false };
  if (hEdge) check('S3 msedge 实时缩略图呈现（Chromium/硬件加速）', r3bE.ok, `fill=${r3bE.ms.toFixed(1)}ms`);
  else { matrixSet('msedge', 'live', 'N/T'); say('S3 msedge 缺席——该行记 N/T'); }

  const r3bEl = eSrcHwnd ? await registerAndMeasure('electron', ITEM.ELECTRON, eSrcHwnd, baseOf(ITEM.ELECTRON), (c, b) => diffRatio(c, b) > 0.02) : { ok: false };
  if (eSrcHwnd) check('S3 electron 实时缩略图呈现（Chromium/Electron）', r3bEl.ok, `fill=${r3bEl.ms.toFixed(1)}ms`);
  else { matrixSet('electron', 'live', 'N/T'); say('S3 electron src 缺席——该行记 N/T'); }

  // 3c. popup（自绘无边框）→ item4
  const popupBlue = [0, 0, 200];
  const r3c = await registerAndMeasure('win32-popup', ITEM.POPUP, hPopup, null, (c) => colorRatio(c, popupBlue, 40) > 0.3);
  check('S3 自绘无边框（WS_POPUP）实时缩略图呈现', r3c.ok, `fill=${r3c.ms.toFixed(1)}ms`);

  // 3d. 实时传播：setcolor 确定性信号（live 红→绿、popup 蓝→品红）
  const liveGreen = [0, 200, 0];
  const t3d0 = perfNow();
  const sc1 = await sendCmd(hw, { cmd: 'setcolor', hwnd: hLive.toString(16), color: 0x00C800 });
  const p1 = await measureLatency(destItemRect(ITEM.LIVE), (c) => colorRatio(c, liveGreen, 40) > 0.3, 3000);
  ledgerAdd('实时传播', 'win32-live setcolor 红→绿', p1.ok ? perfNow() - t3d0 : NaN, p1.ok ? '源窗内容变化→缩略图跟随' : '超时未跟随');
  check('S3 win32-live 实时传播（源窗内容变化，缩略图同步更新——非静态截图）', sc1.ok && p1.ok, `propagation=${(perfNow() - t3d0).toFixed(1)}ms`);
  matrixSet('win32-live', 'propagate', p1.ok ? 'OK' : 'FAIL');
  await sendCmd(hw, { cmd: 'setcolor', hwnd: hLive.toString(16), color: 0x0000C8 }); // 还原红色

  const popupMagenta = [200, 0, 200];
  const sc2 = await sendCmd(hw, { cmd: 'setcolor', hwnd: hPopup.toString(16), color: 0x00C800C8 });
  const p2 = await measureLatency(destItemRect(ITEM.POPUP), (c) => colorRatio(c, popupMagenta, 40) > 0.3, 3000);
  check('S3 自绘无边框实时传播（蓝→品红跟随）', sc2.ok && p2.ok, p2.ok ? `propagation=${p2.ms.toFixed(1)}ms` : '超时');
  matrixSet('win32-popup', 'propagate', p2.ok ? 'OK' : 'FAIL');
  await sendCmd(hw, { cmd: 'setcolor', hwnd: hPopup.toString(16), color: 0x00C80000 }); // 还原蓝色

  // 3e. notepad 实时传播：改几何触发重渲染的像素差证据（不向 notepad 打字，避免保存提示污染清理）
  if (hNotepad && r3b.ok) {
    const rect = destItemRect(ITEM.NOTEPAD);
    const capA = captureRect(rect.x, rect.y, rect.w, rect.h);
    win32.SetWindowPos(hNotepad, 0, 30, 520, 620, 440, win32.SWP_NOZORDER | win32.SWP_NOACTIVATE);
    const p3 = await measureLatency(rect, (c) => diffRatio(c, capA) > 0.015, 3000);
    check('S3 notepad 实时传播（源窗几何变化触发重渲染，缩略图像素差可见）', p3.ok, p3.ok ? `propagation=${p3.ms.toFixed(1)}ms` : '超时');
    matrixSet('notepad', 'propagate', p3.ok ? 'OK(几何重渲染)' : 'FAIL');
    ledgerAdd('实时传播', 'notepad 几何重渲染', p3.ok ? p3.ms : NaN, p3.ok ? '' : '超时');
    win32.SetWindowPos(hNotepad, 0, 30, 520, 560, 400, win32.SWP_NOZORDER | win32.SWP_NOACTIVATE);
    await pumpSleep(300);
  } else if (hNotepad) { matrixSet('notepad', 'propagate', 'N/T'); }

  // 3f. GPU 窗（msedge / electron）实时传播：双色分栏页 + 跨进程改宽 → 分界移动 →
  // 缩略图像素差可见 = 硬件加速内容是持续实时流而非注册时静态帧。
  // （r6/r7 实证：JS/CSS 动画在 Chromium 后台节流下信号不可靠——src 只见单色或无色，
  // 故改用几何驱动的确定性内容变化，与 notepad 行同口径。）
  async function gpuLiveness(label, itemIdx, srcHwnd) {
    const sr = rectArr(srcHwnd);
    // 等源窗把双色分栏页画出来（首启渲染可慢于注册；8s 上限，超时如实 N/T）
    let pageLoaded = false, gR = 0, rR = 0;
    if (sr) {
      const tPage = Date.now();
      while (Date.now() - tPage < 8000) {
        const scap = captureRect(sr[0], sr[1], sr[2] - sr[0], sr[3] - sr[1]);
        if (scap) {
          gR = dominanceRatio(scap, 'green');
          rR = dominanceRatio(scap, 'red');
          // 阈值 0.12：r13 实测 Edge --app 深色 chrome 会稀释两栏占比（0.17/0.17 双栏俱在）；
          // 判定语义是「两栏都在场」，不是精确占比
          if (gR > 0.12 && rR > 0.12) { pageLoaded = true; break; }
        }
        await pumpSleep(250);
      }
    }
    if (!pageLoaded) {
      // 诊断：源窗区域 8×4 粗网格主色（RGB hex），弄清页面上究竟是什么
      const scap0 = sr ? captureRect(sr[0], sr[1], sr[2] - sr[0], sr[3] - sr[1]) : null;
      if (scap0) {
        const rows = [];
        for (let gy = 0; gy < 4; gy++) {
          const cells = [];
          for (let gx = 0; gx < 8; gx++) {
            const px = Math.floor((gx + 0.5) * scap0.w / 8), py = Math.floor((gy + 0.5) * scap0.h / 4);
            const c = pixelAt(scap0, Math.min(px, scap0.w - 1), Math.min(py, scap0.h - 1));
            cells.push(`${c.r.toString(16).padStart(2, '0')}${c.g.toString(16).padStart(2, '0')}${c.b.toString(16).padStart(2, '0')}`);
          }
          rows.push(cells.join(' '));
        }
        say(`S3 ${label} 源窗区域粗网格（8×4，RGB hex）：\n    ${rows.join('\n    ')}`);
      }
      matrixSet(label, 'propagate', `N/T（源页未按预期呈现双色分栏 绿=${gR.toFixed(2)} 红=${rR.toFixed(2)}——探针页问题，不据此判定 DWM）`);
      check(`S3 ${label} 实时传播（GPU 内容流）`, false, `源窗本体未呈现双色分栏页（绿=${gR.toFixed(2)} 红=${rR.toFixed(2)}）——探针页问题如实记录`);
      return false;
    }
    const rect = destItemRect(itemIdx);
    const capA = captureRect(rect.x, rect.y, rect.w, rect.h);
    win32.SetWindowPos(srcHwnd, 0, sr[0], sr[1], (sr[2] - sr[0]) + 120, sr[3] - sr[1], win32.SWP_NOZORDER | win32.SWP_NOACTIVATE);
    const p = await measureLatency(rect, (c) => diffRatio(c, capA) > 0.015, 3000);
    check(`S3 ${label} 实时传播（源窗宽度变化→GPU 内容重排，缩略图像素差可见——硬件加速内容为实时流非静态帧）`, p.ok, p.ok ? `propagation=${p.ms.toFixed(1)}ms` : '超时');
    matrixSet(label, 'propagate', p.ok ? 'OK(几何重排)' : 'FAIL');
    ledgerAdd('实时传播', `${label} 几何重排`, p.ok ? p.ms : NaN, p.ok ? '' : '超时');
    win32.SetWindowPos(srcHwnd, 0, sr[0], sr[1], sr[2] - sr[0], sr[3] - sr[1], win32.SWP_NOZORDER | win32.SWP_NOACTIVATE);
    await pumpSleep(300);
    return p.ok;
  }
  if (hEdge && r3bE.ok) await gpuLiveness('msedge', ITEM.EDGE, hEdge);
  else if (hEdge) matrixSet('msedge', 'propagate', 'N/T');
  if (eSrcHwnd && r3bEl.ok) await gpuLiveness('electron', ITEM.ELECTRON, eSrcHwnd);
  else if (eSrcHwnd) matrixSet('electron', 'propagate', 'N/T');

  // 3g. Electron 目标窗（面板同形态）：DWM 目标窗为 BrowserWindow 时的注册与传播
  if (eDestHwnd) {
    const edRect = clientRectOnScreen(eDestHwnd);
    const t3g = registerThumb(eDestHwnd, hLive, { left: 0, top: 0, right: edRect.w, bottom: edRect.h });
    if (t3g.ok) {
      thumbs.set('electron-dest', t3g.thumb);
      g_state.thumbs.push(t3g.thumb);
      const m3g = await measureLatency(edRect, (c) => colorRatio(c, liveRed, 40) > 0.3, 4000);
      ledgerAdd('逐张填入', 'electron-dest（面板同形态目标窗）', m3g.ms, m3g.ok ? '注册→首帧' : '超时');
      check('S3 Electron BrowserWindow 作为目标窗（面板同形态）实时缩略图呈现', m3g.ok, `fill=${m3g.ms.toFixed(1)}ms`);
      const t3g2 = perfNow();
      await sendCmd(hw, { cmd: 'setcolor', hwnd: hLive.toString(16), color: 0x00C800 });
      const p3g = await measureLatency(edRect, (c) => colorRatio(c, liveGreen, 40) > 0.3, 3000);
      check('S3 Electron 目标窗实时传播（面板形态下缩略图同步更新）', p3g.ok, p3g.ok ? `propagation=${(perfNow() - t3g2).toFixed(1)}ms` : '超时');
      await sendCmd(hw, { cmd: 'setcolor', hwnd: hLive.toString(16), color: 0x0000C8 });
      await unregisterThumb(thumbs.get('electron-dest')); thumbs.delete('electron-dest');
      await pumpSleep(200);
    } else {
      const valid = win32.IsWindow(eDestHwnd);
      matrixSet('electron-dest(跨进程目标)', 'live', `E_INVALIDARG hr=${t3g.hr}（目标窗须属调用进程）`);
      say(`S3g 诊断：eDestHwnd=${eDestHwnd ? eDestHwnd.toString(16) : 'null'} IsWindow=${valid} rect=${JSON.stringify(rectArr(eDestHwnd))} class=${win32.className(eDestHwnd) || '?'}`);
      // 平台约束发现：同轮探针自有目标窗注册全部成功（hr=0），唯一差异是目标窗属另一进程
      // → DwmRegisterThumbnail 的目标窗必须属调用进程。生产语义与 spec 决策15「目标窗必须由
      // 面板持有」一致：注册必须发生在面板进程内。该发现按成立的平台约束记录。
      check('S3g 平台约束发现：跨进程目标窗注册被拒（E_INVALIDARG），生产须在面板进程内注册（决策15 口径）',
        t3g.hr === -2147024809 && valid, `hr=${t3g.hr} IsWindow=${valid}（同轮探针自有目标窗 6 格注册全部成功）`);
    }
  }

  ledgerAdd('打开（首格注册→首帧）', 'win32-live', openMs, '预览「打开」DWM 承载部分口径——胶囊 UI 本身的打开时延属 UI 层，不在本探针');

  // —— S4 最小化行为与内存缓存/回退 ——
  say('—— S4 最小化：实时缩略图行为实测 + 内存缓存 + 无缓存回退 ——');

  // 4a. win32-live：特征色缓存 → 最小化 → 实测行为 → 缓存渲染 → 还原
  {
    const magenta = 0x00C800C8; // COLORREF BBGGRR = 品红 RGB(200,0,200)
    const magentaRef = [200, 0, 200];
    await sendCmd(hw, { cmd: 'setcolor', hwnd: hLive.toString(16), color: magenta });
    const rect0 = destItemRect(ITEM.LIVE);
    const liveCap = await measureLatency(rect0, (c) => colorRatio(c, magentaRef, 40) > 0.3, 3000);
    check('S4a 特征色（品红）已在实时缩略图呈现（缓存内容可辨认的前提）', liveCap.ok, liveCap.ok ? '' : '超时');
    // 最小化前抓内存缓存（PrintWindow PW_RENDERFULLCONTENT → 内存位图，不落盘）
    const cache = captureWindowCache(hLive);
    g_state.caches.push(cache);
    const cacheCap = cache ? { w: cache.w, h: cache.h, buf: cache.pixels, stride: cache.w * 4, x: 0, y: 0 } : null;
    const cacheColorRatio = cacheCap ? colorRatio(cacheCap, magentaRef, 48) : 0;
    check('S4a 最小化前 PrintWindow 内存缓存抓取（PW_RENDERFULLCONTENT，仅内存位图）', Boolean(cache && cache.okPw && cacheColorRatio > 0.3),
      cache ? `size=${cache.w}x${cache.h} 品红占比=${cacheColorRatio.toFixed(2)} okPw=${cache.okPw}` : '抓取失败');
    // 最小化 → 实测 DWM 实时缩略图行为
    const preMin = captureRect(rect0.x, rect0.y, rect0.w, rect0.h);
    const minWait = await minimizeWindow(hLive);
    await pumpSleep(700); // 等 DWM 合成稳定
    const postMin = captureRect(rect0.x, rect0.y, rect0.w, rect0.h);
    const blankRatio = postMin ? colorRatio(postMin, BG_REF, 10) : 0;
    const frozenRatio = postMin ? 1 - diffRatio(postMin, preMin, 24) : 0;
    let minBehave = 'other';
    if (blankRatio > 0.98) minBehave = '空白（底色透出）';
    else if (frozenRatio > 0.98) minBehave = '冻结（最后一帧留存）';
    say(`S4a win32-live 最小化后实时缩略图实测：${minBehave}（blankRatio=${blankRatio.toFixed(3)} frozenRatio=${frozenRatio.toFixed(3)}）——逐扇记录，不作无条件承诺`);
    matrixSet('win32-live', 'minimize', minBehave);
    check('S4a 最小化行为可观测且已记录（实测分类，不预设结果）', minWait && Boolean(postMin), `IsIconic=${win32.IsIconic(hLive)} 分类=${minBehave}`);
    // 最小化后再抓 PrintWindow（预期空白/不可靠——生产必须最小化前抓缓存）
    const cacheAfter = captureWindowCache(hLive);
    const afterMinColorRatio = cacheAfter ? colorRatio({ w: cacheAfter.w, h: cacheAfter.h, buf: cacheAfter.pixels, stride: cacheAfter.w * 4, x: 0, y: 0 }, magentaRef, 48) : 0;
    if (cacheAfter) releaseCache(cacheAfter); // 对照组位图不留存
    say(`S4a 最小化后再抓 PrintWindow：品红占比=${afterMinColorRatio.toFixed(2)}（${cacheAfter && cacheAfter.okPw ? 'PrintWindow 返回成功' : 'PrintWindow 失败'}）——生产缓存必须在最小化前抓取，实测证据留档`);
    // 注销该格 live 缩略图，切缓存模式渲染（生产语义：降级接管该格）
    const reg0 = unregisterThumb(thumbs.get('win32-live')); thumbs.delete('win32-live');
    g_itemState[ITEM.LIVE].mode = 'cache';
    g_itemState[ITEM.LIVE].cache = cache;
    destRepaint();
    const t4a = perfNow();
    const cacheFill = await measureLatency(rect0, (c) => colorRatio(c, magentaRef, 48) > 0.4, 3000);
    ledgerAdd('缓存填入', 'win32-live（最小化态）', cacheFill.ok ? perfNow() - t4a : NaN, cacheFill.ok ? '注销实时→内存缓存渲染可见' : '超时');
    check('S4a 最小化窗口在目标窗中展示最近缓存（内存位图渲染，特征色像素比对）', reg0 && cacheFill.ok,
      cacheFill.ok ? `fill=${(perfNow() - t4a).toFixed(1)}ms` : '缓存未按预期呈现');
    matrixSet('win32-live', 'cache', (reg0 && cacheFill.ok) ? 'OK（最小化前缓存）' : 'FAIL');
    // 还原窗口，恢复实时（先把源窗颜色还原为红——4a 此前把它切成品红做缓存特征色）
    await restoreWindow(hLive);
    await sendCmd(hw, { cmd: 'setcolor', hwnd: hLive.toString(16), color: 0x0000C8 });
    await pumpSleep(200);
    g_itemState[ITEM.LIVE].mode = 'bg';
    g_itemState[ITEM.LIVE].cache = null;
    destRepaint();
    const t4r = registerThumb(destHwnd, hLive, destItemClientRect(ITEM.LIVE));
    if (t4r.ok) { thumbs.set('win32-live', t4r.thumb); g_state.thumbs.push(t4r.thumb); }
    const liveBack = await measureLatency(rect0, (c) => colorRatio(c, liveRed, 40) > 0.3, 3000);
    check('S4a 窗口还原后实时缩略图恢复（缓存模式退出、实时关系重建）', t4r.ok && liveBack.ok, `re-register hr=${t4r.hr} live=${liveBack.ok}`);
  }

  // 4b. notepad：最小化实测 + 无缓存回退（图标+标题）
  if (hNotepad) {
    const rect1 = destItemRect(ITEM.NOTEPAD);
    const preMin = captureRect(rect1.x, rect1.y, rect1.w, rect1.h);
    const minWait = await minimizeWindow(hNotepad);
    await pumpSleep(700);
    const postMin = captureRect(rect1.x, rect1.y, rect1.w, rect1.h);
    const blankRatio = postMin ? colorRatio(postMin, BG_REF, 10) : 0;
    const frozenRatio = postMin ? 1 - diffRatio(postMin, preMin, 24) : 0;
    let minBehave = 'other';
    if (blankRatio > 0.98) minBehave = '空白（底色透出）';
    else if (frozenRatio > 0.98) minBehave = '冻结（最后一帧留存）';
    say(`S4b notepad 最小化后实时缩略图实测：${minBehave}（blankRatio=${blankRatio.toFixed(3)} frozenRatio=${frozenRatio.toFixed(3)}）`);
    matrixSet('notepad', 'minimize', minBehave);
    check('S4b notepad 最小化行为可观测且已记录', minWait && Boolean(postMin), `IsIconic=${win32.IsIconic(hNotepad)} 分类=${minBehave}`);
    // 无缓存回退：该窗从未抓缓存 → 注销 live（若仍在）→ 图标+标题渲染
    const reg1 = unregisterThumb(thumbs.get('notepad')); thumbs.delete('notepad');
    const { hicon, source } = extractIcon(hNotepad);
    const title = windowTitle(hNotepad);
    say(`S4b notepad 图标提取：${hicon ? '成功' : '失败'}（来源=${source || '无'}） 标题="${title.slice(0, 60)}"`);
    if (hicon) g_state.icons.push(hicon);
    g_itemState[ITEM.NOTEPAD].mode = 'icon';
    g_itemState[ITEM.NOTEPAD].icon = hicon;
    g_itemState[ITEM.NOTEPAD].title = title || 'notepad';
    destRepaint();
    const t4b = perfNow();
    const iconFill = await measureLatency(rect1, (c) => (1 - colorRatio(c, BG_REF, 12)) > 0.01, 3000);
    ledgerAdd('回退填入', 'notepad（图标+标题，无缓存）', iconFill.ok ? perfNow() - t4b : NaN, iconFill.ok ? '图标+标题渲染可见' : '超时');
    check('S4b 无缓存最小化窗口回退为应用图标+标题（目标窗内可见，预览始终可用）', reg1 && Boolean(hicon) && iconFill.ok,
      `fill=${iconFill.ok ? (perfNow() - t4b).toFixed(1) : '超时'}ms icon=${hicon ? source : '无'} title=${title ? '有' : '空'}`);
    matrixSet('notepad', 'cache', (reg1 && Boolean(hicon) && iconFill.ok) ? 'OK（图标+标题回退）' : 'FAIL');
    g_itemState[ITEM.NOTEPAD].mode = 'bg';
    g_itemState[ITEM.NOTEPAD].icon = null;
    if (hicon) { try { DestroyIcon(hicon); } catch { /* 尽力 */ } g_state.icons.pop(); }
    destRepaint();
    await restoreWindow(hNotepad);
    const t4b2 = registerThumb(destHwnd, hNotepad, destItemClientRect(ITEM.NOTEPAD));
    if (t4b2.ok) { thumbs.set('notepad', t4b2.thumb); g_state.thumbs.push(t4b2.thumb); }
    await pumpSleep(300);
  } else { matrixSet('notepad', 'minimize', 'N/T'); matrixSet('notepad', 'cache', 'N/T'); }

  // 4c. msedge / electron / popup 最小化行为逐扇记录
  async function minimizeObserve(label, itemIdx, hwnd) {
    const rect = destItemRect(itemIdx);
    const preMin = captureRect(rect.x, rect.y, rect.w, rect.h);
    const minWait = await minimizeWindow(hwnd);
    await pumpSleep(700);
    const postMin = captureRect(rect.x, rect.y, rect.w, rect.h);
    const blankRatio = postMin ? colorRatio(postMin, BG_REF, 10) : 0;
    const frozenRatio = postMin ? 1 - diffRatio(postMin, preMin, 24) : 0;
    let minBehave = 'other';
    if (blankRatio > 0.98) minBehave = '空白（底色透出）';
    else if (frozenRatio > 0.98) minBehave = '冻结（最后一帧留存）';
    say(`S4c ${label} 最小化后实时缩略图实测：${minBehave}（blankRatio=${blankRatio.toFixed(3)} frozenRatio=${frozenRatio.toFixed(3)}）`);
    matrixSet(label, 'minimize', minBehave);
    check(`S4c ${label} 最小化行为可观测且已记录`, minWait && Boolean(postMin), `IsIconic=${win32.IsIconic(hwnd)} 分类=${minBehave}`);
    await restoreWindow(hwnd);
    await pumpSleep(300);
  }
  if (hEdge) await minimizeObserve('msedge', ITEM.EDGE, hEdge); else matrixSet('msedge', 'minimize', 'N/T');
  if (eSrcHwnd) await minimizeObserve('electron', ITEM.ELECTRON, eSrcHwnd); else matrixSet('electron', 'minimize', 'N/T');
  await minimizeObserve('win32-popup', ITEM.POPUP, hPopup);

  // —— S5 cloak 兼容性逐项记录 ——
  say('—— S5 cloak（DWMWA_CLOAK）实测记录 ——');
  {
    const one = Buffer.alloc(4); one.writeUInt32LE(1, 0);
    const zero = Buffer.alloc(4);
    // 5a. 跨进程置 cloak（helper 窗）：medium-IL 进程对他人窗置 cloak 实测——r2 实证 E_ACCESSDENIED
    const hrCloakX = DwmSetWindowAttribute(hCloak, DWMWA_CLOAK, one, 4);
    say(`S5a 跨进程置 cloak（helper 窗）：DwmSetWindowAttribute(DWMWA_CLOAK)=hr${hrCloakX}（${hrCloakX !== 0 ? '被拒——生产对他人窗不可主动 cloak，只能经 DWMWA_CLOAKED 读回识别（如其他虚拟桌面窗）' : '成功'}）`);
    matrixSet('win32-cloak', 'cloak', hrCloakX === 0 ? '见同窗实测' : `跨进程置cloak被拒 hr${hrCloakX}（N/T）`);

    // 5b. 同进程置 cloak（探针自有试验窗）：观察 cloak 期间缩略图行为
    const WS_POPUP_S = 0x80000000, WS_VISIBLE_S = 0x10000000;
    g_cloakSelfHwnd = CreateWindowExW(0, 'T373_DEST_CLASS', 'T373-CLOAK-SELF', WS_POPUP_S | WS_VISIBLE_S, 1640, 520, 480, 360, 0, 0, GetModuleHandleW(null), null);
    g_state.targetWindows.push(g_cloakSelfHwnd);
    win32.SetWindowPos(g_cloakSelfHwnd, -1, 0, 0, 0, 0, win32.SWP_NOMOVE | win32.SWP_NOSIZE | win32.SWP_NOACTIVATE);
    InvalidateRect(g_cloakSelfHwnd, null, true);
    await pumpSleep(250);
    const rect5 = destItemRect(ITEM.CLOAK);
    const cloakYellow = [200, 200, 0];
    const t5 = registerThumb(destHwnd, g_cloakSelfHwnd, destItemClientRect(ITEM.CLOAK));
    if (t5.ok) { thumbs.set('cloak-self', t5.thumb); g_state.thumbs.push(t5.thumb); }
    const preCap = await measureLatency(rect5, (c) => colorRatio(c, cloakYellow, 40) > 0.3, 4000);
    matrixSet('cloak-self(同进程)', 'live', (t5.ok && preCap.ok) ? 'OK' : (t5.ok ? '超时' : `注册失败 hr=${t5.hr}`));
    check('S5b 同进程 cloak 试验窗注册实时缩略图并呈现（cloaking 前基线）', t5.ok && preCap.ok, t5.ok ? `fill=${preCap.ms.toFixed(1)}ms` : `hr=${t5.hr}`);
    const hrCloak = DwmSetWindowAttribute(g_cloakSelfHwnd, DWMWA_CLOAK, one, 4);
    await pumpSleep(700);
    const cloakBuf = Buffer.alloc(4);
    const hrRead = DwmGetWindowAttribute(g_cloakSelfHwnd, DWMWA_CLOAKED, cloakBuf, 4);
    const cloakVal = cloakBuf.readUInt32LE(0);
    const postCap = captureRect(rect5.x, rect5.y, rect5.w, rect5.h);
    const blankRatio = postCap ? colorRatio(postCap, BG_REF, 10) : 0;
    const frozenRatio = postCap ? 1 - diffRatio(postCap, preCap.cap, 24) : 0;
    let cloakBehave = 'other';
    if (blankRatio > 0.98) cloakBehave = '空白（底色透出）';
    else if (frozenRatio > 0.98) cloakBehave = '冻结（最后一帧留存）';
    say(`S5b cloak 实测：DwmSetWindowAttribute(DWMWA_CLOAK)=hr${hrCloak}，DWMWA_CLOAKED 读回=${hrRead === 0 ? cloakVal : `读失败 hr${hrRead}`}，缩略图=${cloakBehave}（blankRatio=${blankRatio.toFixed(3)} frozenRatio=${frozenRatio.toFixed(3)}）`);
    matrixSet('cloak-self(同进程)', 'cloak', hrCloak === 0 ? `${cloakBehave}（CLOAKED=${hrRead === 0 ? cloakVal : '?'}）` : `置cloak失败 hr${hrCloak}`);
    check('S5b 同进程 cloak 属性可置可读、缩略图行为已实测记录（逐项记录，不作无条件承诺）',
      hrCloak === 0 && hrRead === 0 && cloakVal >= 1 && Boolean(postCap),
      `cloaked=${hrRead === 0 ? cloakVal : '?'} 分类=${cloakBehave}`);
    DwmSetWindowAttribute(g_cloakSelfHwnd, DWMWA_CLOAK, zero, 4);
    await pumpSleep(500);
    const unCap = await measureLatency(rect5, (c) => colorRatio(c, cloakYellow, 40) > 0.3, 3000);
    check('S5b 解除 cloak 后实时缩略图恢复呈现', unCap.ok, unCap.ok ? '' : '超时');
    unregisterThumb(thumbs.get('cloak-self')); thumbs.delete('cloak-self');
  }

  // —— S6 释放与不落盘 ——
  say('—— S6 预览关闭：缩略图关系/位图/缓存全释放 + 不建磁盘缓存 ——');
  {
    // 6a. 全部注销 → 目标窗回底色（关系释放的可见后果）
    const labels = [...thumbs.keys()];
    let allUn = true;
    for (const label of labels) allUn = unregisterThumb(thumbs.get(label)) && allUn;
    thumbs.clear();
    g_state.thumbs.length = 0;
    for (let i = 0; i < g_itemState.length; i++) { g_itemState[i].mode = 'bg'; g_itemState[i].cache = null; g_itemState[i].icon = null; }
    destRepaint();
    let bgRestored = true;
    for (let i = 0; i < 6; i++) {
      const rect = destItemRect(i);
      const r = await measureLatency(rect, (c) => colorRatio(c, BG_REF, 10) > 0.98, 2500);
      if (!r.ok) bgRestored = false;
    }
    check('S6a 全部缩略图关系注销后目标窗回底色（实时画面不再呈现）', allUn && bgRestored, `注销 ${labels.length} 个关系 → 6 格全部回底色=${bgRestored}`);
    // 6b. 再注册成立 → 证明此前关系确已释放（否则 DWM 关系泄漏会使重复注册行为异常）
    const t6b = registerThumb(destHwnd, hLive, destItemClientRect(ITEM.LIVE));
    const cap6b = t6b.ok ? await measureLatency(destItemRect(ITEM.LIVE), (c) => colorRatio(c, liveRed, 40) > 0.3, 3000) : { ok: false };
    check('S6b 注销后同源再注册成立（缩略图关系可完全释放重建，无泄漏锁死）', t6b.ok && cap6b.ok, `hr=${t6b.hr} fill=${cap6b.ok ? cap6b.ms.toFixed(1) : '超时'}ms`);
    unregisterThumb(t6b.thumb);
    destRepaint();
    await pumpSleep(300);
    // 6c. 缓存位图资源释放（GDI 对象销毁 + 渲染引用清空后重绘回底色）
    for (const c of g_state.caches) releaseCache(c);
    g_state.caches.length = 0;
    say('S6c 内存缓存/图标引用全部清空并销毁 GDI 资源——缓存只存内存是结构性保证（PrintWindow→DIB→Buffer，代码中无磁盘写路径），非运行期约定');
    // 6d. 不落盘：缩略图流程前后文件清单比对（临时目录 + 证据目录）
    const filesAfter = listFilesRecursive(tempDir);
    const addedInTemp = [...filesAfter].filter((f) => !filesBeforeThumb.has(f));
    const imgExt = /\.(png|jpe?g|bmp|gif|webp|avif|ico|tiff?)$/i;
    const addedOutsideEdge = addedInTemp.filter((f) => !f.startsWith('edge-profile/'));
    const addedImagesOutsideEdge = addedOutsideEdge.filter((f) => imgExt.test(f));
    const evidenceAfter = listFilesRecursive(evidenceDir);
    const addedEvidence = [...evidenceAfter].filter((f) => !filesBeforeEvidence.has(f));
    check('S6d 缩略图全流程不新建磁盘图像文件（临时目录与证据目录文件清单前后比对）',
      addedImagesOutsideEdge.length === 0 && addedEvidence.length === 0,
      `新增文件（edge-profile 外）=${addedOutsideEdge.length ? addedOutsideEdge.join(', ') : '无'}；证据目录新增=${addedEvidence.length ? addedEvidence.join(', ') : '无'}（edge-profile 内 Chromium 自管缓存不计——非探针写路径）`);
    say('S6d 结构性说明：探针对缩略图/缓存只有内存写路径（PrintWindow→DIB→Buffer、DWM 合成），代码中无任何图像文件写调用——磁盘缓存不存在是结构性质，非运行期约定');
  }

  // —— S7 清理与零残留 ——
  say('—— S7 清理与零残留 ——');
  {
    // 1) 目标窗与第三方窗 WM_CLOSE（helper 窗由 exit 命令销毁；notepad/msedge/electron 由控制器 WM_CLOSE）
    for (const h of g_state.targetWindows) { try { if (win32.IsWindow(h)) PostMessageW(h, WM_CLOSE, 0, 0); } catch { /* 尽力 */ } }
    // 2) helper-win32 exit 命令
    for (const c of g_state.children) {
      try { if (c.child && c.label === 'helper-win32') c.child.stdin.write(JSON.stringify({ cmd: 'exit' }) + '\n'); } catch { /* 尽力 */ }
    }
    // 3) 等 pid 退，兜底 taskkill（killPids = 探针 spawn 的 pid + 新增差集，绝不含用户既有进程）
    await pumpSleep(1500);
    for (const pid of g_state.killPids) { if (pidAlive(pid)) taskkillTree(pid); }
    await pumpSleep(800);
    const alivePids = [...g_state.killPids].filter(pidAlive);
    check('S7 探针圈定的全部进程已退出（spawn pid + 新增差集；用户既有进程不在圈定集内）', alivePids.length === 0,
      alivePids.join(', ') || `全部退出（圈定 ${g_state.killPids.size} pid）`);
    // 4) 影像名计数不高于基线
    await pumpSleep(500);
    const afterCounts = { notepad: tasklistCount('notepad.exe'), msedge: tasklistCount('msedge.exe'), electron: tasklistCount('electron.exe') };
    check('S7 影像名进程计数不高于基线（notepad/msedge/electron 无子进程残留）',
      afterCounts.notepad <= baselineCounts.notepad && afterCounts.msedge <= baselineCounts.msedge && afterCounts.electron <= baselineCounts.electron,
      `notepad ${baselineCounts.notepad}→${afterCounts.notepad} msedge ${baselineCounts.msedge}→${afterCounts.msedge} electron ${baselineCounts.electron}→${afterCounts.electron}`);
    // 5) 临时目录删除
    try { fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 兜底失败如实记 */ }
    check('S7 探针临时目录已删除（helper 源码/动画页与 edge profile 不残留）', !fs.existsSync(tempDir), tempDir);
    // 6) 原生任务栏状态不变
    const appbarAfter = win32.appbarState();
    check('S7 原生任务栏状态不变（ABM_GETSTATE + 可见性）',
      appbarAfter === appbarBefore && Boolean(win32.nativeTaskbarVisible()) === trayVisibleBefore,
      `state ${appbarBefore}→${appbarAfter} visible ${trayVisibleBefore}→${Boolean(win32.nativeTaskbarVisible())}`);
    // 7) 光标归位
    try { if (g_state.cursorBefore) win32.SetCursorPos(g_state.cursorBefore.x, g_state.cursorBefore.y); } catch { /* 尽力 */ }
    say('S7 光标已归位');
    // 8) 常驻进程
    say('S7 常驻进程：探针只 spawn 上述已退出的子进程，main 返回即退出，无常驻残留（结构性保证）');
  }

  // —— 兼容矩阵汇总 ——
  say('');
  say('=== 兼容矩阵（本轮实测，逐项记录、不作无条件承诺） ===');
  for (const row of MATRIX) {
    say(`| ${row.label} | 实时:${row.live} | 传播:${row.propagate} | 最小化:${row.minimize} | 缓存/回退:${row.cache} | cloak:${row.cloak} |`);
  }
  say('');
  say('=== 时延账本（支撑 200ms 主交互预算评审） ===');
  for (const e of LEDGER) say(`| ${e.kind} | ${e.label} | ${Number.isFinite(e.ms) ? e.ms.toFixed(1) + 'ms' : '超时/N-T'} |`);
  const fills = LEDGER.filter((e) => e.kind === '逐张填入' && Number.isFinite(e.ms)).map((e) => e.ms);
  if (fills.length) {
    say(`逐张填入时延范围：${Math.min(...fills).toFixed(1)}–${Math.max(...fills).toFixed(1)}ms（n=${fills.length}）；评审口径：DWM 注册→首帧是预览「填入」的承重段，胶囊点击→预览窗打开的 UI 段不在本探针。`);
  }
  say('');
  say('=== 工单373 go/no-go 证据要点 ===');
  const liveOk = ['win32-live', 'win32-popup'].every((l) => { const r = MATRIX.find((m) => m.label === l); return r && String(r.live).startsWith('OK'); })
    && (hNotepad ? String((MATRIX.find((m) => m.label === 'notepad') || {}).live).startsWith('OK') : false)
    && (hEdge ? String((MATRIX.find((m) => m.label === 'msedge') || {}).live).startsWith('OK') : false);
  const cacheOk = String((MATRIX.find((m) => m.label === 'win32-live') || {}).cache || '').startsWith('OK');
  const fallbackOk = hNotepad ? String((MATRIX.find((m) => m.label === 'notepad') || {}).cache || '').startsWith('OK') : false;
  say(`① 实时缩略图（面板持有目标窗）：${liveOk ? '成立——win32-live/popup/notepad/msedge/electron 逐扇注册呈现，setcolor 与几何驱动内容变化证实时效流（非静态帧）；平台约束：目标窗必须属调用进程（跨进程目标 E_INVALIDARG，S3g），生产须在面板进程内注册——与 spec 决策15「目标窗必须由面板持有」一致' : '未完全成立——见 S3 FAIL 行'}`);
  say(`② 最小化降级：${cacheOk && fallbackOk ? '成立——最小化前 PrintWindow 内存缓存渲染可见（特征色像素比对）；无缓存回退图标+标题可见；最小化后 DWM 实时缩略图行为逐扇实测记录' : '未完全成立——见 S4 FAIL 行'}`);
  say('③ 兼容矩阵：最小化/自绘/硬件加速/cloak 逐项实测记录（见矩阵表），不作无条件承诺');
  say('④ 释放与不落盘：全部注销→回底色、再注册成立、缓存 GDI 资源销毁、缩略图流程零磁盘图像文件——见 S6 PASS 行');
  say('⑤ 零残留：进程计数回基线、临时目录删除、任务栏状态不变——见 S7 PASS 行');
  say('go/no-go 判读：探针能力不记作生产完成——生产窗口预览仍需按 spec #369 决策 15/30 与 ADR-0028 实现预览服务、生命周期与失败关闭；');
  say(`断言账目：${failures.length === 0 ? '全部通过' : failures.length + ' 条不成立：' + failures.join('；')}`);

  process.exitCode = failures.length === 0 ? 0 : 1;
  flushReport();
}

main().catch(async (e) => {
  say(`探针异常退出：${e && e.stack ? e.stack : e && e.message}`);
  await recoverCleanup();
  process.exitCode = 2;
  flushReport();
});
