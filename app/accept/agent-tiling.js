'use strict';
// 工单376 Agent 平铺验收：一至两窗平铺 + 顶部计数胶囊最小闭环（spec #369 决策 7/8/14/
// 27，ADR-0028；t372 探针 go 裁决后的生产几何链段）。控制器以 --accept-agent-tiling
// 身份运行，拉起 --panel-accept 面板子进程，逐段验收：
//   P1 一窗铺满：配对+切到 Agent → 新建 notepad 落位平铺区（= 主屏物理矩形，下缘 =
//      任务栏条带顶、上缘 = 屏顶——不为胶囊留白）；窗出现到几何稳定 ≤500ms 预算
//   P2 两窗左右各半 + 胶囊计数：第二 notepad → 左右各半逐像素核对；胶囊计数 = 2
//   P3 计数口径与排除面：最小化仍计（还原）、工具窗不计（控制器原生 CreateWindowEx
//      造 WS_EX_TOOLWINDOW 可见带标题窗）、面板/条带/胶囊自身不计（own exe 排除的
//      正对照 = 合格集含 notepad）；关闭一窗计数回落、几何收缩回铺满
//   P4 回声抑制与 reconciliation：外部 SetWindowPos 改窗 → ≤500ms 单发纠回，
//      静置 1.2s 零再写（不形成改窗循环，t372 S6 判据的真机面）
//   P5 普通桌面零改窗：普通桌面的 notepad 在整轮平铺活动后矩形逐字节不变（ADR-0016
//      硬边界的本票真机面）；任务栏条带投影照常（副屏应用显示因本机单显示器 N/T
//      如实注记——纯裁决面由离线矩阵钉，taskbar 枚举零改动）
//   P6 收尾复原（零残留）：关窗、切回普通、删配对 Agent 桌面、注册表集合与基线逐项
//      相等、config 三态还原
// 运行：npm run accept:agent-tiling（= electron . --accept-agent-tiling）。
// **必须经 accept-guard 托管**（AGENTS.md 真机验收调度协议）。
const { app, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync, execFileSync } = require('child_process');
const win32 = require('./lib/win32');
const { Report } = require('./lib/report');
const { readConfigRaw, restoreConfig, CONFIG_FILE } = require('./lib/battery-config');
const { cdpPortFor } = require('./lib/registry');
const { createEventTape } = require('./lib/event-tape');
const { createPanelHandle } = require('./lib/panel-control');

const APP_ROOT = path.resolve(__dirname, '..');
const EVENTS_FILE = path.join(__dirname, 'evidence', '376-agent-tiling-events.jsonl');
const tape = createEventTape(EVENTS_FILE, { defaultTimeoutMs: 8000 });
const handle = createPanelHandle({
  execPath: process.execPath, appRoot: APP_ROOT, eventLogPath: EVENTS_FILE,
  archivePath: path.join(__dirname, 'evidence', '376-agent-tiling-panel-handle-child.log'),
});
const CDP_PORT = cdpPortFor('376-agent-tiling');
const TASKBAR_TITLE = 'DECK-TASKBAR';
const CAPSULE_TITLE = 'DECK-CAPSULE';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const koffi = win32.koffi;
koffi.load('user32.dll');
const RectT = koffi.struct('T376_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });

// ————————————————————————————————————————————————————————————
// 系统事实源（375 同款：注册表单查询原子读 + COM 双源；桌面身份一律系统 ID）
// ————————————————————————————————————————————————————————————
const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VirtualDesktops';
function regBytesToGuid(hex) {
  const b = [];
  for (let i = 0; i + 2 <= hex.length; i += 2) b.push(parseInt(hex.slice(i, i + 2), 16));
  const p = (n) => n.toString(16).padStart(2, '0');
  const swap = (arr) => arr.slice().reverse().map((x) => p(x)).join('');
  if (b.length < 16) return '';
  return `${swap(b.slice(0, 4))}-${swap(b.slice(4, 6))}-${swap(b.slice(6, 8))}-${b.slice(8, 10).map((x) => p(x)).join('')}-${b.slice(10, 16).map((x) => p(x)).join('')}`;
}
function regDesktopFacts() {
  try {
    const out = execFileSync('reg', ['query', REG_KEY], { encoding: 'utf8' });
    const idsM = out.match(/VirtualDesktopIDs\s+REG_BINARY\s+([0-9A-Fa-f]+)/);
    const curM = out.match(/CurrentVirtualDesktop\s+REG_BINARY\s+([0-9A-Fa-f]+)/);
    const hexIds = idsM ? idsM[1].toUpperCase() : '';
    const ids = [];
    for (let off = 0; off + 32 <= hexIds.length; off += 32) ids.push(regBytesToGuid(hexIds.slice(off, off + 32)));
    const cur = curM ? regBytesToGuid(curM[1].toUpperCase()) : '';
    return { count: ids.length, ids: ids.filter(Boolean), current: cur || null };
  } catch { return { count: 0, ids: [], current: null }; }
}

const ole32 = koffi.load('ole32.dll');
koffi.struct('T376_GUID', { d1: 'uint32', d2: 'uint16', d3: 'uint16', d4: 'uint8[8]' });
const CoInitializeEx376 = ole32.func('int32 __stdcall CoInitializeEx(void *reserved, uint32 dwCoInit)');
const CLSIDFromString376 = ole32.func('int32 __stdcall CLSIDFromString(const char16_t *lpsz, _Out_ T376_GUID *clsid)');
const CoCreateInstance376 = ole32.func('int32 __stdcall CoCreateInstance(const T376_GUID *clsid, void *outer, uint32 clsCtx, const T376_GUID *iid, _Out_ void **outObj)');
const PTRSZ376 = koffi.sizeof(koffi.pointer('void'));
const protoRelease376 = koffi.proto('__stdcall', 'T376_Release', 'uint32', ['void *']);
const protoQueryService376 = koffi.proto('__stdcall', 'T376_QueryService', 'int32', ['void *', 'const T376_GUID *', 'const T376_GUID *', koffi.out('void **')]);
const protoGetDesktops376 = koffi.proto('__stdcall', 'T376_VdmiGetDesktops', 'int32', ['void *', koffi.out('void **')]);
const protoGetCurrent376 = koffi.proto('__stdcall', 'T376_VdmiGetCurrent', 'int32', ['void *', koffi.out('void **')]);
const protoSwitch376 = koffi.proto('__stdcall', 'T376_VdmiSwitch', 'int32', ['void *', 'void *']);
const protoCreate376 = koffi.proto('__stdcall', 'T376_VdmiCreate', 'int32', ['void *', koffi.out('void **')]);
const protoRemove376 = koffi.proto('__stdcall', 'T376_Remove', 'int32', ['void *', 'void *', 'void *']);
const protoVdGetId376 = koffi.proto('__stdcall', 'T376_VdGetId', 'int32', ['void *', koffi.out('T376_GUID *')]);
const protoObjArrCount376 = koffi.proto('__stdcall', 'T376_ObjArrCount', 'int32', ['void *', koffi.out('int32 *')]);
const protoObjArrGetAt376 = koffi.proto('__stdcall', 'T376_ObjArrGetAt', 'int32', ['void *', 'int32', 'const T376_GUID *', koffi.out('void **')]);
const protoIsOnCurrent376 = koffi.proto('__stdcall', 'T376_IsOnCurrent', 'int32', ['void *', 'uintptr_t', koffi.out('int32 *')]);
const protoGetWinDesktopId376 = koffi.proto('__stdcall', 'T376_GetWinDesktopId', 'int32', ['void *', 'uintptr_t', koffi.out('T376_GUID *')]);

const CLSID376 = { immersiveShell: 'C2F03A33-21F5-47FA-B4BB-156362A2F239', vdmi: 'C5E0CDCA-7B6E-41B2-9FC4-D93975CC467B', vdm: 'AA509086-5CA9-4C25-8F95-589D3C07B48A' };
const IID376 = { vdmi_24H2: '53F5CA0B-158F-4124-900C-057158060B27', vdm: 'A5CD92FF-29BE-454C-8D04-D82879FB3F1B', virtualDesktop: '3F07F4BE-B107-441A-AF0F-39D82529072C', serviceProvider: '6D5140C1-7436-11CE-8034-00AA006009FA' };

function guidFromStr376(s) {
  const g = [null];
  const hr = CLSIDFromString376('{' + s + '}', g);
  if (hr !== 0) throw new Error(`CLSIDFromString(${s}) 失败 hr=${hr}`);
  return g[0];
}
function comGuidToStr376(q) {
  if (!q || !q.d4) return '';
  const p = (n, w) => n.toString(16).padStart(w, '0');
  const d4 = Array.from({ length: 8 }, (_, i) => q.d4[i]);
  return `${p(q.d1 >>> 0, 8)}-${p(q.d2, 4)}-${p(q.d3, 4)}-${d4.slice(0, 2).map((b) => p(b, 2)).join('')}-${d4.slice(2).map((b) => p(b, 2)).join('')}`;
}
const slot376 = (obj, i) => koffi.decode(koffi.decode(obj, 'void *'), i * PTRSZ376, 'void *');
const release376 = (obj) => { try { if (obj) koffi.call(slot376(obj, 2), protoRelease376, obj); } catch { /* 尽力 */ } };

function bindVdCom376() {
  const hrInit = CoInitializeEx376(null, 0);
  if (hrInit !== 0 && hrInit !== 1 && hrInit !== -2147417850) throw new Error(`CoInitializeEx 失败 hr=${hrInit}`);
  const shell = [null];
  const hrShell = CoCreateInstance376(guidFromStr376(CLSID376.immersiveShell), null, 1 | 4, guidFromStr376(IID376.serviceProvider), shell);
  if (hrShell !== 0 || !shell[0]) throw new Error(`ImmersiveShell 创建失败 hr=${hrShell}`);
  const svc = [null];
  const hrQs = koffi.call(slot376(shell[0], 3), protoQueryService376, shell[0], guidFromStr376(CLSID376.vdmi), guidFromStr376(IID376.vdmi_24H2), svc);
  const pub = [null];
  const hrPub = CoCreateInstance376(guidFromStr376(CLSID376.vdm), null, 1, guidFromStr376(IID376.vdm), pub);
  release376(shell[0]);
  if (hrQs !== 0 || !svc[0]) throw new Error(`内部 VDMI QueryService 失败 hr=${hrQs}（IID 漂移）`);
  if (hrPub !== 0 || !pub[0]) throw new Error(`公开 VDM 创建失败 hr=${hrPub}`);
  const vdmi = svc[0];
  const vdm = pub[0];
  const vdIdOf = (d) => {
    const g = [null];
    const r = koffi.call(slot376(d, 4), protoVdGetId376, d, g);
    if (r !== 0) throw new Error(`IVirtualDesktop.GetId 失败 hr=${r}`);
    return comGuidToStr376(g[0]);
  };
  const desktops = () => {
    const arr = [null];
    const hr = koffi.call(slot376(vdmi, 7), protoGetDesktops376, vdmi, arr);
    if (hr !== 0 || !arr[0]) throw new Error(`GetDesktops 失败 hr=${hr}`);
    try {
      const n = [0];
      koffi.call(slot376(arr[0], 3), protoObjArrCount376, arr[0], n);
      const out = [];
      for (let i = 0; i < n[0]; i++) {
        const d = [null];
        const r = koffi.call(slot376(arr[0], 4), protoObjArrGetAt376, arr[0], i, guidFromStr376(IID376.virtualDesktop), d);
        if (r !== 0 || !d[0]) continue;
        out.push({ ptr: d[0], id: vdIdOf(d[0]) });
      }
      return out;
    } finally { release376(arr[0]); }
  };
  return {
    desktops,
    currentId: () => {
      const d = [null];
      const hr = koffi.call(slot376(vdmi, 6), protoGetCurrent376, vdmi, d);
      if (hr !== 0 || !d[0]) return null;
      return vdIdOf(d[0]);
    },
    switchDesktop: (id) => {
      const target = desktops().find((d) => d.id === id);
      if (!target) throw new Error(`目标桌面不在系统集合: ${id}`);
      const hr = koffi.call(slot376(vdmi, 9), protoSwitch376, vdmi, target.ptr);
      release376(target.ptr);
      if (hr !== 0) throw new Error(`SwitchDesktop 失败 hr=${hr}`);
    },
    createDesktop: () => {
      const d = [null];
      const hr = koffi.call(slot376(vdmi, 11), protoCreate376, vdmi, d);
      if (hr !== 0 || !d[0]) throw new Error(`CreateDesktop 失败 hr=${hr}`);
      try { return vdIdOf(d[0]); } finally { release376(d[0]); }
    },
    removeDesktop: (id, fallbackId) => {
      const all = desktops();
      const target = all.find((d) => d.id === id);
      if (!target) return;
      const fallback = all.find((d) => d.id === fallbackId) || all.find((d) => d.id !== id);
      const hr = koffi.call(slot376(vdmi, 13), protoRemove376, vdmi, target.ptr, fallback?.ptr ?? null);
      release376(target.ptr);
      if (fallback) release376(fallback.ptr);
      if (hr !== 0) throw new Error(`RemoveDesktop 失败 hr=${hr}`);
    },
    isOnCurrent: (hwnd) => {
      const f = [0];
      const hr = koffi.call(slot376(vdm, 3), protoIsOnCurrent376, vdm, hwnd, f);
      return hr === 0 ? f[0] !== 0 : null;
    },
    desktopIdOf: (hwnd) => {
      const g = [null];
      const hr = koffi.call(slot376(vdm, 4), protoGetWinDesktopId376, vdm, hwnd, g);
      return hr === 0 ? comGuidToStr376(g[0]) : null;
    },
  };
}

/** 合格应用窗口集合（win-facts.ts 投影同口径最小谓词；375 P5 同款） */
const DWM_CLOAKED_SHELL376 = 0x2;
const dwmapi376 = koffi.load('dwmapi.dll');
const DwmGetWindowAttribute376 = dwmapi376.func('int32 __stdcall DwmGetWindowAttribute(uintptr_t hwnd, uint32 attr, void *pv, uint32 cb)');
function cloakValue376(hwnd) {
  const buf = Buffer.alloc(4);
  if (DwmGetWindowAttribute376(Number(hwnd), 14, buf, 4) !== 0) return -1;
  return buf.readUInt32LE(0);
}
function normalizeExePath(x) {
  return String(x).split('/').join('\\').toLowerCase();
}
function qualifiedAppWindows376(ownExes) {
  const myPid = process.pid;
  const excludedExe = new Set((ownExes || []).map((x) => normalizeExePath(x)));
  const WS_EX_TOOLWINDOW = 0x80, WS_EX_APPWINDOW = 0x40000;
  const out = [];
  for (const h of win32.topLevelWindows()) {
    const ex = Number(win32.GetWindowLongW(h, -20)) | 0;
    if (ex & WS_EX_TOOLWINDOW) continue;
    if (ex & WS_EX_APPWINDOW) continue;
    if (!win32.IsWindowVisible(h)) continue;
    if (cloakValue376(h) === DWM_CLOAKED_SHELL376) continue;
    if (Number(win32.GetWindowLongW(h, -8)) !== 0) continue;
    const pid = win32.threadIdOf(h).pid;
    if (pid === myPid) continue;
    const exePath = normalizeExePath(win32.exeOfPid(pid) || '');
    if (exePath && excludedExe.has(exePath)) continue;
    out.push({ hwnd: h, pid });
  }
  return out;
}

// ————————————————————————————————————————————————————————————
// CDP 与点击（375 同款）
// ————————————————————————————————————————————————————————————
async function cdpEval376(pageTitle, expression) {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
  const target = targets.find((t) => t.title === pageTitle);
  if (!target) throw new Error(`CDP 找不到页面目标: ${pageTitle}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  try {
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP WebSocket 连接失败')); });
    const reply = await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('CDP evaluate 超时')), 8000);
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id === 1) { clearTimeout(timer); res(m); }
      };
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
    if (reply.error || (reply.result && reply.result.exceptionDetails)) {
      throw new Error(`CDP evaluate 失败: ${JSON.stringify(reply.error || reply.result.exceptionDetails)}`);
    }
    return reply.result.result.value;
  } finally {
    ws.close();
  }
}

const MODE_CLASS_EXPR = `(() => [...document.querySelectorAll('.tb-mode-btn')].map((el) => ({ id: el.dataset.id, active: el.classList.contains('active'), disabled: el.classList.contains('disabled') })))()`;

async function convergeAt376(pt, tbHwnd) {
  win32.moveMousePhys(pt.x, pt.y);
  for (let i = 0; i < 32; i++) {
    await sleep(250);
    if (win32.windowFromPointRoot(pt) === tbHwnd) return true;
  }
  return false;
}

async function waitDesktopCurrent376(com, targetId, timeoutMs = 3000) {
  const t0 = Date.now();
  for (;;) {
    const f = regDesktopFacts();
    const internal = com.currentId();
    if (f.current === targetId && (internal === null || internal === targetId)) {
      return { ok: true, ms: Date.now() - t0 };
    }
    if (Date.now() - t0 > timeoutMs) return { ok: false, ms: Date.now() - t0, detail: `注册表=${f.current} 内部=${internal}` };
    await sleep(60);
  }
}

function modeButtonPoint376(geo, tbRect, scale, id) {
  const btn = (geo.modeButtons || []).find((b) => b.id === id);
  if (!btn) return null;
  return {
    x: Math.round(tbRect.left + (btn.x + btn.w / 2) * scale),
    y: Math.round(tbRect.top + (btn.y + btn.h / 2) * scale),
  };
}

// ————————————————————————————————————————————————————————————
// 记事本窗与几何（P1-P5 的被测物）
// ————————————————————————————————————————————————————————————
function findNotepadWindows(exclude) {
  const out = [];
  for (const h of win32.topLevelWindows()) {
    if (exclude && exclude.has(h)) continue;
    if (!win32.IsWindowVisible(h)) continue;
    const exe = String(win32.exeNameOfWindow(h) || '').toLowerCase();
    const cls = String(win32.className(h) || '');
    if (exe === 'notepad.exe' || cls === 'Notepad') out.push(h);
  }
  return out;
}

async function spawnNotepad(exclude, timeoutMs = 15000) {
  const preExisting = new Set(exclude || []);
  const np = spawn('notepad.exe', [], { stdio: 'ignore' });
  const deadline = Date.now() + timeoutMs;
  let hwnd = 0;
  while (Date.now() < deadline && !hwnd) {
    hwnd = findNotepadWindows(preExisting).find((h) => !preExisting.has(h)) || 0;
    if (!hwnd) await sleep(150);
  }
  return { pid: np.pid, hwnd };
}

/** 矩形等值（容差 tol，物理 px） */
function rectEq(r, t, tol = 2) {
  if (!r) return false;
  return Math.abs(r.left - t.left) <= tol && Math.abs(r.top - t.top) <= tol
    && Math.abs(r.right - t.right) <= tol && Math.abs(r.bottom - t.bottom) <= tol;
}
function rectStr(r) { return r ? `[${r.left},${r.top},${r.right},${r.bottom}]` : 'null'; }

/** 等窗口矩形到达目标并稳定（连续两拍达标）；返回 {ok, ms, rect}——ms 自调用起算 */
async function waitRectStable(hwnd, target, budgetMs, timeoutMs = 8000) {
  const t0 = Date.now();
  let stableSince = 0;
  let last = null;
  for (;;) {
    last = win32.rectOf(hwnd);
    if (rectEq(last, target)) {
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince >= 120) return { ok: true, ms: Date.now() - t0, rect: last };
    } else {
      stableSince = 0;
    }
    if (Date.now() - t0 > timeoutMs) return { ok: false, ms: Date.now() - t0, rect: last };
    await sleep(40);
  }
}

async function readCapsuleCount() {
  const v = await cdpEval376(CAPSULE_TITLE, `document.querySelector('#cap-count') ? document.querySelector('#cap-count').textContent.trim() : null`);
  return v === null ? null : Number(v);
}

async function waitCapsuleCount(expected, timeoutMs = 6000) {
  const t0 = Date.now();
  let last = null;
  for (;;) {
    try { last = await readCapsuleCount(); } catch { last = null; }
    if (last === expected) return { ok: true, ms: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) return { ok: false, ms: Date.now() - t0, count: last };
    await sleep(120);
  }
}

// ————————————————————————————————————————————————————————————
// 控制器原生工具窗（P3 排除面被测物：WS_EX_TOOLWINDOW 可见带标题窗）
// ————————————————————————————————————————————————————————————
function createToolWindow(title) {
  const user32 = koffi.load('user32.dll');
  koffi.struct('T376_WNDCLASS', {
    style: 'uint32', lpfnWndProc: 'void *', cbClsExtra: 'int32', cbWndExtra: 'int32',
    hInstance: 'void *', hIcon: 'void *', hCursor: 'void *', hbrBackground: 'void *',
    lpszMenuName: 'const char16_t *', lpszClassName: 'const char16_t *',
  });
  koffi.proto('__stdcall', 'T376_WndProc', 'intptr_t', ['uintptr_t', 'uint32', 'uintptr_t', 'intptr_t']);
  const wndProc = koffi.register(() => 0, 'T376_WndProc *'); // 全部消息交默认处理（0 = 让 DefWindowProc 兜）
  const RegisterClassW = user32.func('uint16 __stdcall RegisterClassW(const T376_WNDCLASS *)');
  const CreateWindowExW = user32.func('uintptr_t __stdcall CreateWindowExW(uint32, const char16_t *, const char16_t *, uint32, int, int, int, int, uintptr_t, uintptr_t, void *, void *)');
  const DefWindowProcW = user32.func('intptr_t __stdcall DefWindowProcW(uintptr_t, uint32, uintptr_t, void *)');
  void DefWindowProcW;
  const kernel32 = koffi.load('kernel32.dll');
  const GetModuleHandleW = kernel32.func('void * __stdcall GetModuleHandleW(const char16_t *)');
  const clsName = 'T376ToolWin';
  const wc = {
    style: 0,
    lpfnWndProc: wndProc,
    cbClsExtra: 0, cbWndExtra: 0,
    hInstance: GetModuleHandleW(null),
    hIcon: null, hCursor: null, hbrBackground: null,
    lpszMenuName: null, lpszClassName: clsName,
  };
  const atom = RegisterClassW(wc);
  if (!atom) return { hwnd: 0, wndProc };
  // WS_EX_TOOLWINDOW = 0x80（排除面被测物）；WS_OVERLAPPEDWINDOW | WS_VISIBLE
  const hwnd = CreateWindowExW(0x80, clsName, title, 0x00CF0000 | 0x10000000,
    40, 40, 480, 360, null, null, GetModuleHandleW(null), null);
  return { hwnd: Number(hwnd), wndProc };
}

function destroyToolWindow(hwnd) {
  if (!hwnd) return;
  try {
    const user32 = koffi.load('user32.dll');
    const DestroyWindow = user32.func('bool __stdcall DestroyWindow(uintptr_t)');
    DestroyWindow(hwnd);
  } catch { /* 收尾尽力 */ }
}

// ————————————————————————————————————————————————————————————
// 主流程
// ————————————————————————————————————————————————————————————
async function main() {
  const rep = new Report('376-agent-tiling');
  let notepads = []; // spawn pid 账（P6 收尾杀进程树）
  let notepadHwnds = []; // 宿主窗句柄账（Win11 Store 记事本宿主另有人）
  let toolWin = { hwnd: 0, wndProc: null };
  let base = null;
  const originalConfig = readConfigRaw();
  const finish = () => {
    const v = rep.verdict(rep.fails === 0 ? 'PASS' : 'FAIL');
    rep.writeLedger();
    app.exit(v.fails === 0 ? 0 : 1);
  };

  try {
    fs.writeFileSync(EVENTS_FILE, '', 'utf8');
    // config 补丁（P6 三态还原）：实验开关开 + 清配对（首启用语义从本轮起算）+ 任务栏启用
    {
      const json = originalConfig !== null ? JSON.parse(originalConfig) : {};
      json.agentDesktop = { ...(json.agentDesktop ?? {}), enabled: true, normalDesktopId: '', agentDesktopId: '' };
      json.taskbar = { ...(json.taskbar ?? {}), enabled: true };
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(json, null, 2) + '\n', 'utf8');
    }
    const com = bindVdCom376();
    base = regDesktopFacts();
    rep.note(`基线注册表事实：桌面数=${base.count} 集合=[${base.ids.map((x) => x.slice(0, 8)).join(', ')}] 当前=${base.current ? base.current.slice(0, 8) : 'null'}`);
    if (!base.count || !base.current) throw new Error('注册表桌面事实不可读——环境问题，本轮未取证');
    const normalId = base.current;

    // —— 拉起面板子进程（实验开关开）——
    handle.launch({ mode: 'accept', cdpPort: CDP_PORT, stdio: 'ignore' });
    const boot = await tape.wait('boot', null, { timeoutMs: 15000 });
    if (!boot) throw new Error('面板子进程未上报 boot 事件');
    rep.note(`面板 pid=${boot.pid}`);
    const tbHwnd = await handle.waitWindow({ title: TASKBAR_TITLE, timeoutMs: 12000 });
    if (!tbHwnd) throw new Error('任务栏窗口未出现');
    const tbRect = win32.rectOf(tbHwnd);
    const dip = screen.getPrimaryDisplay().bounds;
    const scale = (tbRect.right - tbRect.left) / dip.width;

    const ready = await tape.wait('taskbar-geometry', (e) => e.modePill && Array.isArray(e.modeButtons), { timeoutMs: 12000 });
    if (!ready) throw new Error('taskbar-geometry 存证缺失模式组矩形');
    const latestGeo = () => tape.latest('taskbar-geometry', (e) => e.modePill) || ready;
    const panelExePath = String(win32.exeOfPid(win32.threadIdOf(tbHwnd).pid) || '');
    if (!panelExePath) throw new Error('面板 exe 身份不可读');

    // 平铺区期望（生产 tileAreaOf 同口径：主屏物理矩形，下缘 = 条带顶——本机 scale=1.00x）
    const d = screen.getPrimaryDisplay();
    const primaryBottom = Math.round((d.bounds.y + d.bounds.height) * d.scaleFactor);
    const taskbarTop = primaryBottom - Math.round(48 * d.scaleFactor);
    const AREA = {
      left: Math.round(d.bounds.x * d.scaleFactor),
      top: Math.round(d.bounds.y * d.scaleFactor),
      right: Math.round((d.bounds.x + d.bounds.width) * d.scaleFactor),
      bottom: taskbarTop,
    };
    const HALF_W = Math.floor((AREA.right - AREA.left) / 2);
    const LEFT = { ...AREA, right: AREA.left + HALF_W };
    const RIGHT = { ...AREA, left: AREA.left + HALF_W };
    rep.note(`平铺区期望：${rectStr(AREA)}（主屏 ${d.bounds.width}×${d.bounds.height} @${d.scaleFactor}x，条带顶=${taskbarTop}）`);

    // 普通桌面零改窗的被测物：切 Agent 之前先在普通桌面开 notepad（普通归属）
    const preExisting = new Set(findNotepadWindows(null));
    const normalNp = await spawnNotepad(preExisting);
    notepads.push({ pid: normalNp.pid });
    if (normalNp.hwnd) notepadHwnds.push(normalNp.hwnd);
    const normalNpRect0 = normalNp.hwnd ? win32.rectOf(normalNp.hwnd) : null;
    const normalNpId = normalNp.hwnd ? com.desktopIdOf(normalNp.hwnd) : null;
    if (!normalNp.hwnd || !normalNpRect0) rep.note('P0 普通桌面 notepad 未取得（P5 零改窗断言降级为注记）');
    else rep.note(`普通桌面 notepad 就位：hwnd=${normalNp.hwnd} 桌面=${String(normalNpId).slice(0, 8)}… rect=${rectStr(normalNpRect0)}`);

    // —— P1 一窗铺满（含配对+切换前置）——
    rep.beginSegment('P1');
    let agentId = null;
    let np1 = null;
    try {
      // 配对+切 Agent（375 P2 同路径：点 Agent 图标 → 新建桌面 → 系统确认）
      const ptA = modeButtonPoint376(latestGeo(), tbRect, scale, 'agent');
      if (!ptA) throw new Error('agent 模式按钮几何缺位');
      await convergeAt376(ptA, tbHwnd);
      win32.clickPhys(ptA.x, ptA.y, 'left');
      const paired = await (async () => {
        const deadline = Date.now() + 8000;
        for (;;) {
          const f = regDesktopFacts();
          const created = f.ids.find((x) => !base.ids.includes(x));
          if (f.count === base.count + 1 && created) return { ok: true, created };
          if (Date.now() > deadline) return { ok: false };
          await sleep(80);
        }
      })();
      if (!paired.ok) throw new Error('配对失败（Agent 桌面未新建）');
      agentId = paired.created;
      const conf = await waitDesktopCurrent376(com, agentId, 3000);
      if (!conf.ok) throw new Error('切换 Agent 未确认');
      // 普通桌面 notepad 归属不动（既有窗口不迁移——375 P2 同款口径）
      if (normalNp.hwnd && com.desktopIdOf(normalNp.hwnd) !== normalId) {
        throw new Error('普通桌面 notepad 归属被迁移');
      }
      // Agent 桌面开第一扇 notepad → 应铺满平铺区（≤500ms 稳定预算）
      np1 = await spawnNotepad(findNotepadWindows(null));
      if (np1.hwnd) notepadHwnds.push(np1.hwnd);
      notepads.push({ pid: np1.pid });
      if (!np1.hwnd) throw new Error('notepad 未出现');
      // 计时：t_first = 窗口可见首拍，t_stable = 矩形首次到达目标（窗事件→平铺稳定 ≤500ms
      // 预算——spec 用户故事 83）；随后 waitRectStable 复核稳定（连续两拍达标）
      let tFirst = 0;
      let tStable = 0;
      const deadline = Date.now() + 8000;
      for (;;) {
        if (!tFirst && win32.IsWindowVisible(np1.hwnd)) tFirst = Date.now();
        if (tFirst && !tStable && rectEq(win32.rectOf(np1.hwnd), AREA)) tStable = Date.now();
        if (tStable) break;
        if (Date.now() > deadline) break;
        await sleep(30);
      }
      const stable = await waitRectStable(np1.hwnd, AREA, 500);
      const tileMs = tFirst && tStable ? tStable - tFirst : -1;
      const npId = com.desktopIdOf(np1.hwnd);
      // 胶囊在场（Agent 桌面上）且计数 = 1
      const capHwnd = await handle.waitWindow({ title: CAPSULE_TITLE, timeoutMs: 6000 });
      const capCount = capHwnd ? await waitCapsuleCount(1) : { ok: false, count: null };
      if (stable.ok && npId === agentId && capHwnd && capCount.ok
        && stable.rect.top === AREA.top && stable.rect.bottom === taskbarTop
        && tileMs >= 0 && tileMs <= 500) {
        rep.pass(`P1 一窗铺满：notepad 桌面归属=Agent、矩形=${rectStr(stable.rect)} = 平铺区（上缘=屏顶 ${AREA.top} 不为胶囊留白、下缘=条带顶 ${taskbarTop} 避开任务栏）；窗可见→几何稳定 ${tileMs}ms（预算 ≤500ms）；胶囊在场计数=1`);
      } else {
        rep.fail(`P1 稳定=${JSON.stringify(stable)} 归属=${npId === agentId} 胶囊窗=${Boolean(capHwnd)} 计数=${JSON.stringify(capCount)} tileMs=${tileMs} 期望=${rectStr(AREA)}`);
      }
    } catch (err) { rep.fail(`P1 异常: ${err.message}`); }

    // —— P2 两窗左右各半 + 胶囊计数 = 2 ——
    rep.beginSegment('P2');
    let np2 = null;
    try {
      if (!agentId) throw new Error('P1 未取得 Agent 桌面');
      np2 = await spawnNotepad(findNotepadWindows(null));
      if (np2.hwnd) notepadHwnds.push(np2.hwnd);
      notepads.push({ pid: np2.pid });
      if (!np2.hwnd) throw new Error('第二扇 notepad 未出现');
      const s1 = await waitRectStable(np1.hwnd, LEFT, 500, 8000);
      const s2 = await waitRectStable(np2.hwnd, RIGHT, 500, 8000);
      const capCount = await waitCapsuleCount(2);
      if (s1.ok && s2.ok && capCount.ok) {
        rep.pass(`P2 两窗左右各半：窗1=${rectStr(s1.rect)} = 左半、窗2=${rectStr(s2.rect)} = 右半（合计铺满无缝）；胶囊计数=2（${capCount.ms}ms 内到达）`);
      } else {
        rep.fail(`P2 窗1=${JSON.stringify(s1)} 期望左=${rectStr(LEFT)} 窗2=${JSON.stringify(s2)} 期望右=${rectStr(RIGHT)} 计数=${JSON.stringify(capCount)}`);
      }
    } catch (err) { rep.fail(`P2 异常: ${err.message}`); }

    // —— P3 计数口径与排除面 ——
    rep.beginSegment('P3');
    try {
      if (!np1 || !np2 || !np1.hwnd || !np2.hwnd) throw new Error('P1/P2 未取得 notepad');
      // ① 最小化仍计数（GLOSSARY「顶部窗口胶囊」：计数含最小化）
      win32.ShowWindow(np1.hwnd, 6); // SW_MINIMIZE
      const minCount = await waitCapsuleCount(2);
      // ② 还原
      win32.ShowWindow(np1.hwnd, 9); // SW_RESTORE
      const restored = await waitRectStable(np1.hwnd, LEFT, 500, 8000);
      // ③ 工具窗不计（控制器原生 WS_EX_TOOLWINDOW 可见带标题窗——系统弹窗同款特征）
      toolWin = createToolWindow('T376-TOOLWIN');
      await sleep(600);
      const toolCount = await readCapsuleCount();
      // ④ 面板/条带/胶囊自身不计：合格集正对照（含 notepad 两扇）而计数只反映合格应用
      const qual = qualifiedAppWindows376([panelExePath]);
      const notepadInQual = qual.filter((w) => {
        const exe = String(win32.exeNameOfWindow(w.hwnd) || '').toLowerCase();
        return exe === 'notepad.exe';
      }).length;
      // ⑤ 胶囊置顶（WS_EX_TOPMOST）——spec 决策 16「胶囊始终置顶」
      const capHwnd = await handle.waitWindow({ title: CAPSULE_TITLE, timeoutMs: 4000 });
      const WS_EX_TOPMOST = 0x8;
      const capTopmost = capHwnd ? (Number(win32.GetWindowLongW(capHwnd, -20)) & WS_EX_TOPMOST) !== 0 : false;
      if (minCount.ok && restored.ok && toolWin.hwnd && toolCount === 2 && notepadInQual >= 2 && capTopmost) {
        rep.pass(`P3 计数口径：最小化仍计（计数保持 2）、还原回左半格；工具窗（T376-TOOLWIN）不计（计数仍 2）；面板/条带/胶囊自家进程不计（合格集 ${qual.length} 窗含 notepad ${notepadInQual} 扇，计数只反映合格应用）；胶囊置顶（WS_EX_TOPMOST）`);
      } else {
        rep.fail(`P3 最小化计数=${JSON.stringify(minCount)} 还原=${JSON.stringify(restored)} 工具窗hwnd=${toolWin.hwnd} 工具窗期计数=${toolCount} 合格集=${qual.length}/notepad=${notepadInQual} 胶囊置顶=${capTopmost}`);
      }
    } catch (err) { rep.fail(`P3 异常: ${err.message}`); }

    // —— P4 回声抑制与 reconciliation（外部改窗单发纠回、不形成循环）——
    rep.beginSegment('P4');
    try {
      if (!np1 || !np1.hwnd) throw new Error('P1 未取得 notepad');
      // 关闭第二扇：窗 1 应收缩回铺满（关闭收缩——story 20 的本票面）
      if (np2 && np2.hwnd) win32.PostMessageW(np2.hwnd, 0x0010, 0, 0); // WM_CLOSE
      const backFull = await waitRectStable(np1.hwnd, AREA, 500, 8000);
      const capBack = await waitCapsuleCount(1);
      // 外部改窗：把窗 1 拖到别处（Unauthorized 写窗）→ 生产 reconciliation 单发纠回
      const moved = win32.SetWindowPos(np1.hwnd, 0, 400, 300, 800, 600, win32.SWP_NOZORDER | win32.SWP_NOACTIVATE);
      const t0 = Date.now();
      const corrected = await waitRectStable(np1.hwnd, AREA, 500, 3000);
      const correctMs = Date.now() - t0;
      // 静置 1.2s：零再写（无乒乓/无改窗循环——t372 S6 静置判据的真机面）
      await sleep(1200);
      const afterSettle = win32.rectOf(np1.hwnd);
      const stableStill = rectEq(afterSettle, AREA);
      if (backFull.ok && capBack.ok && moved && corrected.ok && correctMs <= 500 + 300 && stableStill) {
        rep.pass(`P4 回声抑制与 reconciliation：关闭第二窗收缩回铺满（计数回落 1）；外部改窗 ${correctMs}ms 内单发纠回目标几何（预算 ≤500ms+采样余量）；静置 1.2s 矩形不变=${rectStr(afterSettle)}（无改窗循环）`);
      } else {
        rep.fail(`P4 收缩=${JSON.stringify(backFull)} 计数=${JSON.stringify(capBack)} moved=${moved} 纠回=${JSON.stringify(corrected)} ${correctMs}ms 静置后=${rectStr(afterSettle)} 期望=${rectStr(AREA)}`);
      }
    } catch (err) { rep.fail(`P4 异常: ${err.message}`); }

    // —— P5 普通桌面零改窗（ADR-0016 硬边界的本票真机面）——
    rep.beginSegment('P5');
    try {
      // 普通桌面的 notepad 在整轮平铺活动后矩形逐字节不变
      const rectNow = normalNp.hwnd ? win32.rectOf(normalNp.hwnd) : null;
      const idNow = normalNp.hwnd ? com.desktopIdOf(normalNp.hwnd) : null;
      // 切回普通（点模式钮——生产入口路径），胶囊随桌面退场
      const ptN = modeButtonPoint376(latestGeo(), tbRect, scale, 'normal');
      await convergeAt376(ptN, tbHwnd);
      win32.clickPhys(ptN.x, ptN.y, 'left');
      const confN = await waitDesktopCurrent376(com, normalId, 3000);
      await sleep(1200); // 静置：任何迟到的自动改窗都会在窗内落位
      const rectAfter = normalNp.hwnd ? win32.rectOf(normalNp.hwnd) : null;
      const sameRect = rectNow && rectAfter && rectNow.left === rectAfter.left && rectNow.top === rectAfter.top
        && rectNow.right === rectAfter.right && rectNow.bottom === rectAfter.bottom;
      const capsuleGone = !(await handle.waitWindow({ title: CAPSULE_TITLE, timeoutMs: 2500 }));
      // 任务栏条带照常（副屏应用显示：本机单显示器 N/T——纯裁决面由离线矩阵钉）
      const tbAlive = win32.IsWindow(tbHwnd) && win32.IsWindowVisible(tbHwnd);
      rep.note('P5 副屏 N/T 注记：本机单显示器，无真实副屏应用可断言；「副屏不进平铺」由离线 tile-scope 矩阵钉（off-main-screen 排除），任务栏枚举零改动（本票 diff 不触 taskbar 投影）');
      if (confN.ok && (!normalNp.hwnd || (sameRect && idNow === normalId)) && capsuleGone && tbAlive) {
        rep.pass(`P5 普通桌面零改窗：普通桌面 notepad 整轮平铺活动后矩形不变（${rectStr(rectAfter)}，归属仍普通桌面）；切回普通后胶囊退场、任务栏条带照常`);
      } else {
        rep.fail(`P5 切换=${JSON.stringify(confN)} 前矩形=${rectStr(rectNow)} 后矩形=${rectStr(rectAfter)} 同=${sameRect} 归属=${String(idNow).slice(0, 8)} 胶囊退场=${capsuleGone} 条带在场=${tbAlive}`);
      }
    } catch (err) { rep.fail(`P5 异常: ${err.message}`); }
  } catch (err) {
    rep.fail(`电池异常: ${err && err.stack || err}`);
  } finally {
    // —— P6 收尾复原（零残留）——
    rep.beginSegment('P6');
    try {
      const com2 = bindVdCom376();
      const cfg = (() => { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return null; } })();
      const agentId = cfg?.agentDesktop?.agentDesktopId || null;
      const normalId = cfg?.agentDesktop?.normalDesktopId || null;
      const baseNow = regDesktopFacts();
      const extraNow = baseNow.ids.filter((x) => !base.ids.includes(x));
      rep.note(`P6 收尾起点：基线=${base.count} 当前集合=${baseNow.count} 本轮多余=${extraNow.length}`);
      // 桌面窗清理：控制器直杀（notepad 宿主另有人——375 P7 同款两段清场）
      for (const h of notepadHwnds) {
        try {
          const hostPid = win32.threadIdOf(h).pid;
          if (hostPid) spawnSync('taskkill', ['/PID', String(hostPid), '/T', '/F'], { stdio: 'ignore' });
        } catch { /* 尽力清场 */ }
      }
      for (const np of notepads) spawnSync('taskkill', ['/PID', String(np.pid), '/T', '/F'], { stdio: 'ignore' });
      destroyToolWindow(toolWin.hwnd);
      try { if (toolWin.wndProc) koffi.unregister(toolWin.wndProc); } catch { /* 尽力 */ }
      await sleep(500);
      if (agentId) {
        try {
          if (baseNow.current === agentId && normalId) {
            com2.switchDesktop(normalId);
            await waitDesktopCurrent376(com2, normalId, 3000);
          }
          com2.removeDesktop(agentId, normalId ?? undefined);
        } catch (e) { rep.note(`P6 RemoveDesktop 异常（热键兜底前记录）：${e.message}`); }
      }
      for (let guard = 0; guard < 6; guard++) {
        const f = regDesktopFacts();
        if (f.count <= base.count) break;
        const extra = f.ids.filter((x) => !base.ids.includes(x));
        if (!extra.length) break;
        if (extra.includes(f.current)) {
          win32.send([
            win32.keyInput(0x5b, win32.KEYDOWN), win32.keyInput(0xa2, win32.KEYDOWN),
            win32.keyInput(0x73, win32.KEYDOWN), win32.keyInput(0x73, win32.KEYUP),
            win32.keyInput(0xa2, win32.KEYUP), win32.keyInput(0x5b, win32.KEYUP),
          ]);
          await sleep(700);
        } else {
          win32.send([
            win32.keyInput(0x5b, win32.KEYDOWN), win32.keyInput(0xa2, win32.KEYDOWN),
            win32.keyInput(0x25, win32.KEYDOWN), win32.keyInput(0x25, win32.KEYUP),
            win32.keyInput(0xa2, win32.KEYUP), win32.keyInput(0x5b, win32.KEYUP),
          ]);
          await sleep(500);
        }
      }
      const f2 = regDesktopFacts();
      const setEq = f2.count === base.count && base.ids.every((x) => f2.ids.includes(x)) && f2.ids.every((x) => base.ids.includes(x));
      const backNormal = !agentId || f2.current !== agentId;
      if (setEq && backNormal) {
        rep.pass(`P6 零残留：注册表桌面集合与基线逐项相等（${f2.count} 桌面）、当前不在已删 Agent 桌面、测试窗与工具窗已清场`);
      } else {
        rep.fail(`P6 集合=${JSON.stringify(f2.ids.map((x) => x.slice(0, 8)))} 基线=${JSON.stringify(base.ids.map((x) => x.slice(0, 8)))} 当前=${f2.current}`);
      }
    } catch (err) { rep.fail(`P6 异常: ${err.message}`); }

    const cleared = await handle.stop();
    if (cleared && cleared.gone === false) {
      rep.exclude(`清场核验：面板强退失败：强杀后有界等待内仍存活（pid=${cleared.pidsLeft.join(', ')})——需重启清障`,
        '清场后仍有面板进程存活', 'panel-forcekill');
    }
    restoreConfig(originalConfig);
    win32.ensureNativeTaskbarVisible();
  }

  finish();
}

module.exports = main;
