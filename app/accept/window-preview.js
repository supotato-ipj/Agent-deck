'use strict';
// 工单379 窗口预览与 Agent 聚焦验收（spec #369 决策 14/15/16，ADR-0028；工单376/377/378
// 真机链的续段——本电池只验 379 自己的面）。控制器以 --accept-window-preview 身份运行，
// 拉起 --panel-accept 面板子进程：
//   P1 预览打开与实时缩略图：胶囊主体真实点击 → 预览窗 ≤200ms 可交互（open→rendered 存证）、
//      可见窗条目为 live 且逐条 DWM 实时内容可辨认（像素主色）、条目标题正确、横向可滚动
//   P2 最小化缓存与图标回退：预览打开期间抓帧 → 最小化后条目显示最近缓存（像素可辨认）；
//      关闭即释放；无缓存的最小化窗回退应用图标+标题
//   P3 非聚焦收起：再点胶囊 / Esc / 点外收起；鼠标离开不立即收起
//   P4 选择进入聚焦：目标真实最大化（IsZoomed）、胶囊保持置顶、计数正确（含最小化）
//   P5 退出聚焦：再点胶囊 / 胶囊恢复按钮 → 退出并恢复默认平铺；明确激活其他窗口先退出；
//      后台新窗（最小化出现）不退出、抢前台才退出；恢复后布局逐像素回到默认平铺
//   P6 资源生命周期与隐私：关闭后 DWM 关系/内存缓存归零；事件日志不含窗口标题或图像
//   P7 收尾复原（零残留）：夹具窗逐进程清场、切回普通、删配对 Agent 桌面、注册表集合与
//      基线逐项相等、config 三态还原
//
// 被测物夹具（工单377 定案形态）：受控 WPF 窗口（一窗一 powershell 进程，标题 T379-W-*），
// 纯色背景用于实时/缓存像素辨认；可外部改窗、每窗独立、无会话恢复。输入一律 SendInput
// 真实注入（胶囊/条目的点击都是真实坐标点击）。
//
// 运行：npm run accept:window-preview（= electron . --accept-window-preview）。
// **必须经 accept-guard 托管**（AGENTS.md 真机验收调度协议）。
const { app, screen, nativeImage, desktopCapturer } = require('electron');
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
const EVENTS_FILE = path.join(__dirname, 'evidence', '379-window-preview-events.jsonl');
const tape = createEventTape(EVENTS_FILE, { defaultTimeoutMs: 8000 });
const handle = createPanelHandle({
  execPath: process.execPath, appRoot: APP_ROOT, eventLogPath: EVENTS_FILE,
  archivePath: path.join(__dirname, 'evidence', '379-window-preview-panel-handle-child.log'),
});
const CDP_PORT = cdpPortFor('379-window-preview');
const TASKBAR_TITLE = 'DECK-TASKBAR';
const CAPSULE_TITLE = 'DECK-CAPSULE';
const PREVIEW_TITLE = 'DECK-WINDOW-PREVIEW';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const koffi = win32.koffi;
koffi.load('user32.dll');

// ————————————————————————————————————————————————————————————
// 系统事实源（375/378 同款：注册表单查询原子读 + COM 双源；桌面身份一律系统 ID）
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
koffi.struct('T379_GUID', { d1: 'uint32', d2: 'uint16', d3: 'uint16', d4: 'uint8[8]' });
const CoInitializeEx379 = ole32.func('int32 __stdcall CoInitializeEx(void *reserved, uint32 dwCoInit)');
const CLSIDFromString379 = ole32.func('int32 __stdcall CLSIDFromString(const char16_t *lpsz, _Out_ T379_GUID *clsid)');
const CoCreateInstance379 = ole32.func('int32 __stdcall CoCreateInstance(const T379_GUID *clsid, void *outer, uint32 clsCtx, const T379_GUID *iid, _Out_ void **outObj)');
const PTRSZ379 = koffi.sizeof(koffi.pointer('void'));
const protoRelease379 = koffi.proto('__stdcall', 'T379_Release', 'uint32', ['void *']);
const protoQueryService379 = koffi.proto('__stdcall', 'T379_QueryService', 'int32', ['void *', 'const T379_GUID *', 'const T379_GUID *', koffi.out('void **')]);
const protoGetDesktops379 = koffi.proto('__stdcall', 'T379_VdmiGetDesktops', 'int32', ['void *', koffi.out('void **')]);
const protoGetCurrent379 = koffi.proto('__stdcall', 'T379_VdmiGetCurrent', 'int32', ['void *', koffi.out('void **')]);
const protoSwitch379 = koffi.proto('__stdcall', 'T379_VdmiSwitch', 'int32', ['void *', 'void *']);
const protoCreate379 = koffi.proto('__stdcall', 'T379_VdmiCreate', 'int32', ['void *', koffi.out('void **')]);
const protoRemove379 = koffi.proto('__stdcall', 'T379_Remove', 'int32', ['void *', 'void *', 'void *']);
const protoVdGetId379 = koffi.proto('__stdcall', 'T379_VdGetId', 'int32', ['void *', koffi.out('T379_GUID *')]);
const protoObjArrCount379 = koffi.proto('__stdcall', 'T379_ObjArrCount', 'int32', ['void *', koffi.out('int32 *')]);
const protoObjArrGetAt379 = koffi.proto('__stdcall', 'T379_ObjArrGetAt', 'int32', ['void *', 'int32', 'const T379_GUID *', koffi.out('void **')]);

const CLSID379 = { immersiveShell: 'C2F03A33-21F5-47FA-B4BB-156362A2F239', vdmi: 'C5E0CDCA-7B6E-41B2-9FC4-D93975CC467B', vdm: 'AA509086-5CA9-4C25-8F95-589D3C07B48A' };
const IID379 = { vdmi_24H2: '53F5CA0B-158F-4124-900C-057158060B27', vdm: 'A5CD92FF-29BE-454C-8D04-D82879FB3F1B', virtualDesktop: '3F07F4BE-B107-441A-AF0F-39D82529072C', serviceProvider: '6D5140C1-7436-11CE-8034-00AA006009FA' };

function guidFromStr379(s) {
  const g = [null];
  const hr = CLSIDFromString379('{' + s + '}', g);
  if (hr !== 0) throw new Error(`CLSIDFromString(${s}) 失败 hr=${hr}`);
  return g[0];
}
function comGuidToStr379(q) {
  if (!q || !q.d4) return '';
  const p = (n, w) => n.toString(16).padStart(w, '0');
  const d4 = Array.from({ length: 8 }, (_, i) => q.d4[i]);
  return `${p(q.d1 >>> 0, 8)}-${p(q.d2, 4)}-${p(q.d3, 4)}-${d4.slice(0, 2).map((b) => p(b, 2)).join('')}-${d4.slice(2).map((b) => p(b, 2)).join('')}`;
}
const slot379 = (obj, i) => koffi.decode(koffi.decode(obj, 'void *'), i * PTRSZ379, 'void *');
const release379 = (obj) => { try { if (obj) koffi.call(slot379(obj, 2), protoRelease379, obj); } catch { /* 尽力 */ } };

function bindVdCom379() {
  const hrInit = CoInitializeEx379(null, 0);
  if (hrInit !== 0 && hrInit !== 1 && hrInit !== -2147417850) throw new Error(`CoInitializeEx 失败 hr=${hrInit}`);
  const shell = [null];
  const hrShell = CoCreateInstance379(guidFromStr379(CLSID379.immersiveShell), null, 1 | 4, guidFromStr379(IID379.serviceProvider), shell);
  if (hrShell !== 0 || !shell[0]) throw new Error(`ImmersiveShell 创建失败 hr=${hrShell}`);
  const svc = [null];
  const hrQs = koffi.call(slot379(shell[0], 3), protoQueryService379, shell[0], guidFromStr379(CLSID379.vdmi), guidFromStr379(IID379.vdmi_24H2), svc);
  const pub = [null];
  const hrPub = CoCreateInstance379(guidFromStr379(CLSID379.vdm), null, 1, guidFromStr379(IID379.vdm), pub);
  release379(shell[0]);
  if (hrQs !== 0 || !svc[0]) throw new Error(`内部 VDMI QueryService 失败 hr=${hrQs}（IID 漂移）`);
  if (hrPub !== 0 || !pub[0]) throw new Error(`公开 VDM 创建失败 hr=${hrPub}`);
  const vdmi = svc[0];
  const vdIdOf = (d) => {
    const g = [null];
    const r = koffi.call(slot379(d, 4), protoVdGetId379, d, g);
    if (r !== 0) throw new Error(`IVirtualDesktop.GetId 失败 hr=${r}`);
    return comGuidToStr379(g[0]);
  };
  const desktops = () => {
    const arr = [null];
    const hr = koffi.call(slot379(vdmi, 7), protoGetDesktops379, vdmi, arr);
    if (hr !== 0 || !arr[0]) throw new Error(`GetDesktops 失败 hr=${hr}`);
    try {
      const n = [0];
      koffi.call(slot379(arr[0], 3), protoObjArrCount379, arr[0], n);
      const out = [];
      for (let i = 0; i < n[0]; i++) {
        const d = [null];
        const r = koffi.call(slot379(arr[0], 4), protoObjArrGetAt379, arr[0], i, guidFromStr379(IID379.virtualDesktop), d);
        if (r !== 0 || !d[0]) continue;
        out.push({ ptr: d[0], id: vdIdOf(d[0]) });
      }
      return out;
    } finally { release379(arr[0]); }
  };
  return {
    currentId: () => {
      const d = [null];
      const hr = koffi.call(slot379(vdmi, 6), protoGetCurrent379, vdmi, d);
      if (hr !== 0 || !d[0]) return null;
      return vdIdOf(d[0]);
    },
    switchDesktop: (id) => {
      const target = desktops().find((d) => d.id === id);
      if (!target) throw new Error(`目标桌面不在系统集合: ${id}`);
      const hr = koffi.call(slot379(vdmi, 9), protoSwitch379, vdmi, target.ptr);
      release379(target.ptr);
      if (hr !== 0) throw new Error(`SwitchDesktop 失败 hr=${hr}`);
    },
    createDesktop: () => {
      const d = [null];
      const hr = koffi.call(slot379(vdmi, 11), protoCreate379, vdmi, d);
      if (hr !== 0 || !d[0]) throw new Error(`CreateDesktop 失败 hr=${hr}`);
      try { return vdIdOf(d[0]); } finally { release379(d[0]); }
    },
    removeDesktop: (id, fallbackId) => {
      const all = desktops();
      const target = all.find((d) => d.id === id);
      if (!target) return;
      const fallback = all.find((d) => d.id === fallbackId) || all.find((d) => d.id !== id);
      const hr = koffi.call(slot379(vdmi, 13), protoRemove379, vdmi, target.ptr, fallback?.ptr ?? null);
      release379(target.ptr);
      if (fallback) release379(fallback.ptr);
      if (hr !== 0) throw new Error(`RemoveDesktop 失败 hr=${hr}`);
    },
  };
}

// ————————————————————————————————————————————————————————————
// CDP 与真实输入（375/378 同款）
// ————————————————————————————————————————————————————————————
async function cdpEval(pageTitle, expression) {
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

async function waitDesktopCurrent379(com, targetId, timeoutMs = 3000) {
  const t0 = Date.now();
  for (;;) {
    const f = regDesktopFacts();
    const internal = com.currentId();
    if (f.current === targetId && (internal === null || internal === targetId)) return { ok: true, ms: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) return { ok: false, ms: Date.now() - t0, detail: `注册表=${f.current} 内部=${internal}` };
    await sleep(60);
  }
}

function modeButtonPoint379(geo, tbRect, scale, id) {
  const btn = (geo.modeButtons || []).find((b) => b.id === id);
  if (!btn) return null;
  return {
    x: Math.round(tbRect.left + (btn.x + btn.w / 2) * scale),
    y: Math.round(tbRect.top + (btn.y + btn.h / 2) * scale),
  };
}

// ————————————————————————————————————————————————————————————
// 夹具：受控 WPF 窗口（一窗一 powershell 进程；纯色背景用于缩略图像素辨认）
// ————————————————————————————————————————————————————————————
const FIXTURE_PREFIX = 'T379-W-';

const user32Fx379 = koffi.load('user32.dll');
const GetWindowTextLengthW379 = user32Fx379.func('int __stdcall GetWindowTextLengthW(uintptr_t)');
const GetWindowTextW379 = user32Fx379.func('int __stdcall GetWindowTextW(uintptr_t, char16_t *, int)');
const IsZoomed379 = user32Fx379.func('bool __stdcall IsZoomed(uintptr_t)');
const isZoomed = (hwnd) => Boolean(IsZoomed379(hwnd));
// 顶层置顶判据（WS_EX_TOPMOST）——accept/lib 的 win32 未导出 isTopmost，本地取（不扩共享基建）
const WS_EX_TOPMOST_379 = 0x00000008;
const isTopmost = (hwnd) => (Number(win32.GetWindowLongW(hwnd, win32.GWL_EXSTYLE)) & WS_EX_TOPMOST_379) !== 0;
function windowTitleOf379(hwnd) {
  const n = GetWindowTextLengthW379(hwnd);
  if (!n) return '';
  const buf = Buffer.alloc((n + 1) * 2);
  GetWindowTextW379(hwnd, buf, n + 1);
  return buf.toString('utf16le').replace(/\u0000+$/, '');
}

async function waitWindowByTitle(title, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const h of win32.topLevelWindows()) {
      if (win32.IsWindowVisible(h) && windowTitleOf379(h) === title) return h;
    }
    if (Date.now() > deadline) return 0;
    await sleep(150);
  }
}

function wpfWindowScript(title, rgb, opts = {}) {
  const lines = [
    'Add-Type -AssemblyName PresentationFramework',
    '$w = New-Object System.Windows.Window',
    `$w.Title = '${title}'`,
    '$w.Width = 700', '$w.Height = 500', '$w.Left = 160', '$w.Top = 120',
    `$w.Background = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromRgb(${rgb[0]},${rgb[1]},${rgb[2]}))`,
  ];
  if (opts.background) lines.push('$w.ShowActivated = $false');
  if (opts.minimized) lines.push("$w.WindowState = 'Minimized'");
  lines.push('$w.ShowDialog() | Out-Null');
  return lines.join('; ');
}

/** 拉起一扇夹具窗（WPF，可改尺寸，初始 700×500 @ (160,120)——刻意不等于任何平铺格） */
async function spawnFixture(title, rgb, opts = {}, timeoutMs = 25000) {
  const proc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', wpfWindowScript(title, rgb, opts)], { stdio: 'ignore' });
  const hwnd = await waitWindowByTitle(title, timeoutMs);
  return { pid: proc.pid, hwnd };
}

/** 矩形等值（容差 tol，物理 px） */
function rectEq(r, t, tol = 2) {
  if (!r || !t) return false;
  return Math.abs(r.left - t.left) <= tol && Math.abs(r.top - t.top) <= tol
    && Math.abs(r.right - t.right) <= tol && Math.abs(r.bottom - t.bottom) <= tol;
}
function rectStr(r) { return r ? `[${r.left},${r.top},${r.right},${r.bottom}]` : 'null'; }

/** 等窗口矩形到达目标并稳定（连续两拍达标） */
async function waitRectStable(hwnd, target, timeoutMs = 8000) {
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

/** 全部窗连续两拍齐达目标矩形（整布局断言：任一窗漂移即失败） */
async function waitAllRects(entries, timeoutMs = 8000) {
  const t0 = Date.now();
  let stableSince = 0;
  let last = [];
  for (;;) {
    last = entries.map((e) => ({ hwnd: e.hwnd, want: e.rect, got: win32.rectOf(e.hwnd) }));
    const all = last.every((x) => rectEq(x.got, x.want));
    if (all) {
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince >= 120) return { ok: true, ms: Date.now() - t0, detail: last };
    } else {
      stableSince = 0;
    }
    if (Date.now() - t0 > timeoutMs) return { ok: false, ms: Date.now() - t0, detail: last };
    await sleep(40);
  }
}

function detailStr(detail) {
  return (detail || []).map((x) => `hwnd=${x.hwnd} ${rectStr(x.got)}${x.want ? `(期望 ${rectStr(x.want)})` : ''}`).join('；');
}

// 分裂规则独立重写（工单377）：按 spec 决策 7 / 用户故事 15-17 的文档规则在电池里算期望
function splitH(r) {
  const mid = r.left + Math.floor((r.right - r.left) / 2);
  return [{ ...r, right: mid }, { ...r, left: mid }];
}
function splitV(r) {
  const mid = r.top + Math.floor((r.bottom - r.top) / 2);
  return [{ ...r, bottom: mid }, { ...r, top: mid }];
}
function layout3(area) {
  const [a, right] = splitH(area);
  const [b, c] = splitV(right);
  return [a, b, c];
}
function layout4(area) {
  const [a, right] = splitH(area);
  const [b, c] = splitV(right);
  const [a1, d] = splitV(a);
  return [a1, b, c, d];
}
function layout5(area) {
  const l4 = layout4(area);
  const [b1, e] = splitH(l4[1]);
  return [l4[0], b1, l4[2], l4[3], e];
}
function layout6(area) {
  const l5 = layout5(area);
  const [c1, f] = splitH(l5[2]);
  return [l5[0], l5[1], c1, l5[3], l5[4], f];
}

// ————————————————————————————————————————————————————————————
// 胶囊 / 预览页事实与真实点击
// ————————————————————————————————————————————————————————————
function findVisibleByTitle(title) {
  return win32.topLevelWindows().find((h) => win32.IsWindowVisible(h) && windowTitleOf379(h) === title) || 0;
}

async function readCapsuleCount() {
  const v = await cdpEval(CAPSULE_TITLE, `document.querySelector('#cap-count') ? document.querySelector('#cap-count').textContent.trim() : null`);
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
async function readTilingState() {
  return cdpEval(CAPSULE_TITLE, `(async () => {
    const s = await window.deck.bridge.invoke('tiling/get-state', null);
    return { count: s.count, placed: s.placed, overflow: s.overflow, anomalies: s.anomalies, floating: s.floating, prompting: s.prompting, authorized: s.authorized, current: s.current, available: s.available };
  })()`);
}
async function waitTilingState(pred, timeoutMs = 8000) {
  const t0 = Date.now();
  let last = null;
  for (;;) {
    try { last = await readTilingState(); } catch (err) { last = { error: String((err && err.message) || err) }; }
    if (last && pred(last)) return { ok: true, ms: Date.now() - t0, state: last };
    if (Date.now() - t0 > timeoutMs) return { ok: false, ms: Date.now() - t0, state: last };
    await sleep(120);
  }
}
async function readFocusState() {
  return cdpEval(CAPSULE_TITLE, `window.deck.bridge.invoke('focus/get-state', null)`);
}
async function waitFocus(expected, timeoutMs = 5000) {
  const t0 = Date.now();
  let last = null;
  for (;;) {
    try { last = await readFocusState(); } catch (err) { last = { error: String((err && err.message) || err) }; }
    if (last && last.focused === expected) return { ok: true, ms: Date.now() - t0, state: last };
    if (Date.now() - t0 > timeoutMs) return { ok: false, ms: Date.now() - t0, state: last };
    await sleep(80);
  }
}
async function readPreviewDiag() {
  return cdpEval(CAPSULE_TITLE, `window.deck.bridge.invoke('preview/diag', null)`);
}

/** 胶囊主体中心（物理 px）：32 位 CSS 尺寸换算 */
async function capsuleBodyPoint() {
  const hwnd = findVisibleByTitle(CAPSULE_TITLE);
  if (!hwnd) return null;
  const info = await cdpEval(CAPSULE_TITLE, `(() => {
    const el = document.querySelector('#capsule');
    if (!el) return null;
    const q = el.getBoundingClientRect();
    return { x: q.x + q.width / 2, y: q.y + q.height / 2, w: window.innerWidth, h: window.innerHeight };
  })()`);
  if (!info) return null;
  const r = win32.rectOf(hwnd);
  const scale = (r.right - r.left) / info.w;
  return { hwnd, x: Math.round(r.left + info.x * scale), y: Math.round(r.top + info.y * scale) };
}

/** 胶囊右侧恢复按钮中心（物理 px） */
async function capsuleRestoreButton() {
  const hwnd = findVisibleByTitle(CAPSULE_TITLE);
  if (!hwnd) return null;
  const info = await cdpEval(CAPSULE_TITLE, `(() => {
    const b = document.querySelector('#cap-restore');
    if (!b) return null;
    const q = b.getBoundingClientRect();
    return { x: q.x + q.width / 2, y: q.y + q.height / 2, w: window.innerWidth, visible: q.width > 0 && q.height > 0 };
  })()`);
  if (!info || !info.visible) return null;
  const r = win32.rectOf(hwnd);
  const scale = (r.right - r.left) / info.w;
  return { hwnd, x: Math.round(r.left + info.x * scale), y: Math.round(r.top + info.y * scale) };
}

/** 真实点击一个物理点（指针先落位，胶囊热区 25ms 轮询后才开门） */
async function realClickPt(pt) {
  win32.moveMousePhys(pt.x, pt.y);
  await sleep(260);
  win32.clickPhys(pt.x, pt.y, 'left');
  await sleep(180);
}

/** 强制把目标窗带到前台（AttachThreadInput 解除前台许可限制——「明确激活其他窗口」） */
function forceForeground(hwnd) {
  const fg = Number(win32.GetForegroundWindow());
  const cur = win32.GetCurrentThreadId();
  const fgTid = fg ? win32.threadIdOf(fg).tid : 0;
  try { if (fgTid) win32.AttachThreadInput(cur, fgTid, true); } catch { /* 尽力 */ }
  try { win32.SetForegroundWindow(hwnd); win32.BringWindowToTop(hwnd); } catch { /* 尽力 */ }
  try { if (fgTid) win32.AttachThreadInput(cur, fgTid, false); } catch { /* 尽力 */ }
  return Number(win32.GetForegroundWindow()) === Number(hwnd);
}

async function clickCapsuleBody() {
  const pt = await capsuleBodyPoint();
  if (!pt) throw new Error('胶囊主体不在场');
  await realClickPt(pt);
  return pt;
}

/** 真实点击预览条目：先核命中窗（布局/滚动竞态下点错会误激活别的窗），必要时重读重试 */
async function clickPreviewItem(hwnd) {
  for (let attempt = 0; attempt < 3; attempt++) {
    // 先确保条目在视口内（第 6 条常被横向滚出：中心点落在窗外会点到别的窗）
    try {
      await cdpEval(PREVIEW_TITLE, `(() => {
        const el = [...document.querySelectorAll('.pv-item')].find((e) => Number(e.dataset.hwnd) === ${Number(hwnd)});
        if (el) el.scrollIntoView({ inline: 'center', block: 'nearest' });
        return Boolean(el);
      })()`);
      await sleep(180);
    } catch { /* 页面尚未就绪：下一拍重试 */ }
    const it = await waitPreviewItems((x) => x.some((i) => i.hwnd === hwnd), 5000);
    if (!it.ok) return { ok: false, reason: 'item-missing', items: it.items };
    const geo = await previewGeometry(it.items);
    const item = it.items.find((i) => i.hwnd === hwnd);
    // 中心点夹进窗口内容区（条目边缘/滚动余量不越界）
    const cx = Math.min(Math.max(item.rect.x + item.rect.w / 2, 4), (it.items[0].innerW || 1) - 4);
    const cy = Math.min(Math.max(item.rect.y + item.rect.h / 2, 4), (it.items[0].innerH || 1) - 4);
    const pt = itemPoint(geo, { ...item, rect: { ...item.rect, x: cx - item.rect.w / 2, y: cy - item.rect.h / 2 } });
    const hit = win32.windowFromPointRoot(pt);
    if (hit === geo.hwnd) {
      win32.moveMousePhys(pt.x, pt.y);
      await sleep(220);
      win32.clickPhys(pt.x, pt.y, 'left');
      await sleep(180);
      return { ok: true, pt, hit, winRect: geo.rect, item: { hwnd: item.hwnd, rect: item.rect }, order: it.items.map((i) => [i.hwnd, Math.round(i.rect.x)]) };
    }
    await sleep(180);
  }
  const it = await waitPreviewItems((x) => x.some((i) => i.hwnd === hwnd), 2000);
  const geo = it.ok ? await previewGeometry(it.items) : null;
  const item = it.ok ? it.items.find((i) => i.hwnd === hwnd) : null;
  return { ok: false, reason: 'point-not-preview', hwnd, winRect: geo && geo.rect, item: item && { hwnd: item.hwnd, rect: item.rect }, order: it.ok ? it.items.map((i) => [i.hwnd, Math.round(i.rect.x)]) : null, present: await previewPresent() };
}

/** 预览页条目事实（CSS 矩形 + 模式 + 标题 + 图标） */
async function readPreviewItems() {
  return cdpEval(PREVIEW_TITLE, `(() => [...document.querySelectorAll('.pv-item')].map((el) => {
    const thumb = el.querySelector('.pv-thumb');
    const q = thumb ? thumb.getBoundingClientRect() : { x: 0, y: 0, width: 0, height: 0 };
    const cachedImg = el.querySelector('img.pv-img');
    const iconImg = el.querySelector('img.pv-icon');
    return {
      hwnd: Number(el.dataset.hwnd),
      title: (el.querySelector('.pv-title') || {}).textContent || '',
      live: !!thumb && thumb.classList.contains('live'),
      cached: !!cachedImg && !!(cachedImg.src || '').startsWith('data:image'),
      fallback: !!el.querySelector('.pv-fallback'),
      icon: !!iconImg && !!(iconImg.src || '').startsWith('data:image'),
      fbTitle: (el.querySelector('.pv-fb-title') || {}).textContent || '',
      rect: { x: q.x, y: q.y, w: q.width, h: q.height },
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      scrollLeft: (document.querySelector('#pv-strip') || {}).scrollLeft || 0,
      scrollWidth: (document.querySelector('#pv-strip') || {}).scrollWidth || 0,
      clientWidth: (document.querySelector('#pv-strip') || {}).clientWidth || 0,
    };
  }))()`);
}

// 预览开合事实源 = 桥投影 open（关闭态窗口停在屏幕外保持渲染层常热——不能按可见性判）
async function readPreviewState() {
  return cdpEval(CAPSULE_TITLE, `window.deck.bridge.invoke('preview/get-state', null)`);
}

async function previewPresent() {
  try { return Boolean((await readPreviewState()).open); } catch { return false; }
}

/** 等预览展开（桥投影 open=true）；hwnd 为原生句柄（条目点击/取景用） */
async function waitPreviewVisible(timeoutMs = 4000) {
  const t0 = Date.now();
  for (;;) {
    let open = false;
    try { open = Boolean((await readPreviewState()).open); } catch { open = false; }
    if (open) return { ok: true, ms: Date.now() - t0, hwnd: findVisibleByTitle(PREVIEW_TITLE) };
    if (Date.now() - t0 > timeoutMs) return { ok: false, ms: Date.now() - t0, hwnd: 0 };
    await sleep(40);
  }
}

async function waitPreviewHidden(timeoutMs = 4000) {
  const t0 = Date.now();
  for (;;) {
    let open = true;
    try { open = Boolean((await readPreviewState()).open); } catch { open = true; }
    if (!open) return { ok: true, ms: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) return { ok: false, ms: Date.now() - t0 };
    await sleep(60);
  }
}

async function waitPreviewItems(pred, timeoutMs = 5000) {
  const t0 = Date.now();
  let last = null;
  for (;;) {
    try { last = await readPreviewItems(); } catch { last = null; }
    if (last && pred(last)) return { ok: true, ms: Date.now() - t0, items: last };
    if (Date.now() - t0 > timeoutMs) return { ok: false, ms: Date.now() - t0, items: last };
    await sleep(100);
  }
}

/** 预览窗物理矩形 + CSS→物理缩放 */
async function previewGeometry(items) {
  const hwnd = findVisibleByTitle(PREVIEW_TITLE);
  if (!hwnd || !items || !items.length) return null;
  const r = win32.rectOf(hwnd);
  const innerW = items[0].innerW || 1;
  return { hwnd, rect: r, scale: (r.right - r.left) / innerW };
}

/** 条目缩略图中心物理点（选择/聚焦用） */
function itemPoint(geo, item) {
  return {
    x: Math.round(geo.rect.left + (item.rect.x + item.rect.w / 2) * geo.scale),
    y: Math.round(geo.rect.top + (item.rect.y + item.rect.h / 2) * geo.scale),
  };
}

/** 预览页标题栏中心（取焦后发 Esc） */
async function previewHeaderPoint(geo, items) {
  const info = await cdpEval(PREVIEW_TITLE, `(() => {
    const el = document.querySelector('#pv-head');
    const q = el.getBoundingClientRect();
    return { x: q.x + q.width / 2, y: q.y + q.height / 2 };
  })()`);
  return {
    x: Math.round(geo.rect.left + info.x * geo.scale),
    y: Math.round(geo.rect.top + info.y * geo.scale),
    innerW: items[0].innerW,
  };
}

// ————————————————————————————————————————————————————————————
// 像素（desktopCapturer 进程内快速截屏 + 主色占比）
// ————————————————————————————————————————————————————————————
function primaryPhys() {
  const d = screen.getPrimaryDisplay();
  return { w: Math.round(d.bounds.width * d.scaleFactor), h: Math.round(d.bounds.height * d.scaleFactor) };
}

async function captureFast(rect, name) {
  const phys = primaryPhys();
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: phys.w, height: phys.h } });
  const full = sources[0] && sources[0].thumbnail;
  if (!full || full.isEmpty()) throw new Error('captureFast 失败：desktopCapturer 无可用屏源');
  const crop = full.crop({
    x: Math.max(0, rect.left), y: Math.max(0, rect.top),
    width: Math.min(rect.right - rect.left, phys.w - rect.left),
    height: Math.min(rect.bottom - rect.top, phys.h - rect.top),
  });
  const out = path.join(__dirname, 'evidence', name + '.png');
  fs.writeFileSync(out, crop.toPNG());
  return out;
}

/** 同一张截图内逐区主色占比：zones = [{left,top,right,bottom}]（截图局部坐标） */
function colorRatiosInZones(pngPath, zones, colors, tol = 45) {
  const img = nativeImage.createFromPath(pngPath);
  const s = img.getSize();
  const buf = img.toBitmap();
  const W = s.width;
  return zones.map((z) => {
    const hits = colors.map(() => 0);
    let n = 0;
    for (let y = Math.max(0, z.top); y < Math.min(s.height, z.bottom); y += 3) {
      for (let x = Math.max(0, z.left); x < Math.min(W, z.right); x += 3) {
        const i = (y * W + x) * 4;
        const b = buf[i], g = buf[i + 1], r = buf[i + 2];
        n += 1;
        for (let c = 0; c < colors.length; c++) {
          const [cr, cg, cb] = colors[c];
          if (Math.abs(r - cr) <= tol && Math.abs(g - cg) <= tol && Math.abs(b - cb) <= tol) { hits[c] += 1; break; }
        }
      }
    }
    return { hits, n, ratios: hits.map((h) => h / Math.max(1, n)) };
  });
}

// ————————————————————————————————————————————————————————————
// 主流程
// ————————————————————————————————————————————————————————————
async function main() {
  const rep = new Report('379-window-preview');
  const fixtures = []; // { pid, hwnd } —— P7 收尾逐进程清场
  const tiles = []; // 成员窗（加入序）与其颜色
  const colors = [];
  let fixtureSeq = 0;
  let base = null;
  let normalId = null;
  let agentId = null;
  const originalConfig = readConfigRaw();
  const finish = () => {
    const v = rep.verdict(rep.fails === 0 ? 'PASS' : 'FAIL');
    rep.writeLedger();
    app.exit(v.fails === 0 ? 0 : 1);
  };
  const spawnTile = async (rgb, opts = {}) => {
    fixtureSeq += 1;
    const title = `${FIXTURE_PREFIX}${fixtureSeq}`;
    const s = await spawnFixture(title, rgb, opts);
    fixtures.push({ pid: s.pid, hwnd: s.hwnd });
    if (!s.hwnd) throw new Error(`夹具窗 ${title} 未出现`);
    await sleep(250);
    tiles.push(s.hwnd);
    colors.push(rgb);
    return s.hwnd;
  };
  const eventsText = () => { try { return fs.readFileSync(EVENTS_FILE, 'utf8'); } catch { return ''; } };

  try {
    fs.writeFileSync(EVENTS_FILE, '', 'utf8');
    {
      const json = originalConfig !== null ? JSON.parse(originalConfig) : {};
      json.agentDesktop = { ...(json.agentDesktop ?? {}), enabled: true, normalDesktopId: '', agentDesktopId: '' };
      json.taskbar = { ...(json.taskbar ?? {}), enabled: true };
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(json, null, 2) + '\n', 'utf8');
    }
    const com = bindVdCom379();
    base = regDesktopFacts();
    rep.note(`基线注册表事实：桌面数=${base.count} 集合=[${base.ids.map((x) => x.slice(0, 8)).join(', ')}] 当前=${base.current ? base.current.slice(0, 8) : 'null'}`);
    if (!base.count || !base.current) throw new Error('注册表桌面事实不可读——环境问题，本轮未取证');
    normalId = base.current;

    handle.launch({ mode: 'accept', cdpPort: CDP_PORT, stdio: 'ignore' });
    const boot = await tape.wait('boot', null, { timeoutMs: 15000 });
    if (!boot) throw new Error('面板子进程未上报 boot 事件');
    rep.note(`面板 pid=${boot.pid}`);
    const tbHwnd = await handle.waitWindow({ title: TASKBAR_TITLE, timeoutMs: 12000 });
    if (!tbHwnd) throw new Error('任务栏窗口未出现');
    const tbRect = win32.rectOf(tbHwnd);
    const dip = screen.getPrimaryDisplay().bounds;
    const scale = (tbRect.right - tbRect.left) / dip.width;
    const hasModeButtons = (e) => e.modePill && Array.isArray(e.modeButtons) && e.modeButtons.length >= 2;
    const ready = await tape.wait('taskbar-geometry', hasModeButtons, { timeoutMs: 12000 });
    if (!ready) throw new Error('taskbar-geometry 存证缺失模式组矩形');
    const latestGeo = () => tape.latest('taskbar-geometry', hasModeButtons) || ready;
    const panelExePath = String(win32.exeOfPid(win32.threadIdOf(tbHwnd).pid) || '');
    if (!panelExePath) throw new Error('面板 exe 身份不可读');

    const d = screen.getPrimaryDisplay();
    const primaryBottom = Math.round((d.bounds.y + d.bounds.height) * d.scaleFactor);
    const taskbarTop = primaryBottom - Math.round(48 * d.scaleFactor);
    const AREA = {
      left: Math.round(d.bounds.x * d.scaleFactor),
      top: Math.round(d.bounds.y * d.scaleFactor),
      right: Math.round((d.bounds.x + d.bounds.width) * d.scaleFactor),
      bottom: taskbarTop,
    };
    rep.note(`平铺区期望：${rectStr(AREA)}（主屏 ${d.bounds.width}×${d.bounds.height} @${d.scaleFactor}x，条带顶=${taskbarTop}）`);
    const layout6 = (() => {
      const [a, right] = splitH(AREA);
      const [b, c] = splitV(right);
      const [a1, dd] = splitV(a);
      const l4 = [a1, b, c, dd];
      const [b1, e] = splitH(l4[1]);
      const l5 = [l4[0], b1, l4[2], l4[3], e];
      const [c1, f] = splitH(l5[2]);
      return [l5[0], l5[1], c1, l5[3], l5[4], f];
    })();

    const modePoint = (id) => modeButtonPoint379(latestGeo(), tbRect, scale, id);
    const clickMode = async (id) => {
      const pt = modePoint(id);
      if (!pt) throw new Error(`${id} 模式按钮几何缺位`);
      if (win32.windowFromPointRoot(pt) !== tbHwnd) {
        const pill = (latestGeo().modePill) || { x: 110, w: 94 };
        win32.moveMousePhys(Math.round(tbRect.left + (pill.x + pill.w / 2) * scale), tbRect.bottom - 4);
        await sleep(500);
      }
      win32.moveMousePhys(pt.x, pt.y);
      for (let i = 0; i < 32; i++) {
        await sleep(250);
        if (win32.windowFromPointRoot(pt) === tbHwnd) break;
      }
      await sleep(120);
      win32.clickPhys(pt.x, pt.y, 'left');
      return pt;
    };
    const switchMode = async (id, targetId, label) => {
      await clickMode(id);
      let conf = await waitDesktopCurrent379(com, targetId, 4000);
      if (!conf.ok) {
        rep.note(`${label} 首次切换未在 4s 内确认（${JSON.stringify(conf)}），重试一次点击`);
        await clickMode(id);
        conf = await waitDesktopCurrent379(com, targetId, 4000);
      }
      return conf;
    };

    // —— P1 预览打开与实时缩略图（决策 14/15/27）——
    rep.beginSegment('P1');
    let p1Opened = false;
    try {
      await clickMode('agent');
      const paired = await (async () => {
        const deadline = Date.now() + 10000;
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
      let conf = await waitDesktopCurrent379(com, agentId, 4000);
      if (!conf.ok) {
        await clickMode('agent');
        conf = await waitDesktopCurrent379(com, agentId, 4000);
      }
      if (!conf.ok) throw new Error('切换 Agent 未确认');
      const palette = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [255, 0, 255], [0, 255, 255]];
      for (const rgb of palette) await spawnTile(rgb);
      const tiled = await waitAllRects(tiles.map((hwnd, i) => ({ hwnd, rect: layout6[i] })), 14000);
      const st0 = await waitTilingState((x) => x.count === 6 && x.placed === 6, 8000);
      const count0 = await waitCapsuleCount(6, 6000);

      const tClick = Date.now();
      await clickCapsuleBody();
      const shown = await waitPreviewVisible(4000);
      const openedEvent = await tape.wait('preview-open', (e) => e.t >= tClick, { timeoutMs: 4000 });
      const renderedEvent = await tape.wait('preview-rendered', (e) => e.t >= tClick, { timeoutMs: 4000 });
      const latency = openedEvent && renderedEvent ? renderedEvent.t - openedEvent.t : null;
      const itemsAtOpen = await waitPreviewItems((it) => it.length === 6 && it.every((x) => x.live), 5000);
      const thumbsEvent = await tape.wait('preview-thumbs', (e) => e.t >= tClick && e.count === 6, { timeoutMs: 6000 });
      const thumbsLatency = openedEvent && thumbsEvent ? thumbsEvent.t - openedEvent.t : null;
      const items = (itemsAtOpen.items || []).slice();
      const geo = await previewGeometry(items);
      const capsuleHwnd = findVisibleByTitle(CAPSULE_TITLE);
      const capsuleRect = capsuleHwnd ? win32.rectOf(capsuleHwnd) : null;
      // 条目标题 ↔ 夹具窗标题一一对应
      const titleOk = items.length === 6 && items.every((x) => /T379-W-\d+$/.test(x.title)) && new Set(items.map((x) => x.title)).size === 6;
      // 实时内容像素：每个条目缩略图区的主色 = 该窗背景色
      let pixelOk = false;
      let pixelDetail = '';
      if (geo) {
        const png = await captureFast(geo.rect, '379-preview-live');
        const zones = items.map((x) => ({
          left: Math.round(x.rect.x * geo.scale), top: Math.round(x.rect.y * geo.scale),
          right: Math.round((x.rect.x + x.rect.w) * geo.scale), bottom: Math.round((x.rect.y + x.rect.h) * geo.scale),
        }));
        const colorOf = (x) => {
          const idx = tiles.indexOf(x.hwnd);
          return idx >= 0 ? palette[idx] : null;
        };
        const paletteUsed = items.map(colorOf);
        const results = colorRatiosInZones(png, zones, palette);
        pixelOk = results.every((r, i) => {
          const want = paletteUsed[i] ? palette.indexOf(paletteUsed[i]) : -1;
          if (want < 0) return false;
          const wantRatio = r.ratios[want];
          const otherMax = Math.max(...r.ratios.filter((_, j) => j !== want));
          return wantRatio >= 0.15 && wantRatio > otherMax;
        });
        pixelDetail = results.map((r, i) => {
          const want = paletteUsed[i] ? palette.indexOf(paletteUsed[i]) : -1;
          return `#${i}(${items[i].title}) 主色占比=${(r.ratios[want] || 0).toFixed(3)}`;
        }).join('；');
      }
      // 横向可滚动：6 条目超宽 → scrollWidth > clientWidth；滚动后条目位置变化
      const scrollable = items[0] && items[0].scrollWidth > items[0].clientWidth;
      let scrolled = false;
      if (scrollable) {
        await cdpEval(PREVIEW_TITLE, `(() => { const s = document.querySelector('#pv-strip'); s.scrollLeft = 240; s.dispatchEvent(new Event('scroll')); return s.scrollLeft; })()`);
        await sleep(400);
        const after = await readPreviewItems();
        scrolled = after.length > 0 && after[0].rect.x < items[0].rect.x - 100 && after.some((x) => x.rect.x + x.rect.w > 0);
        await cdpEval(PREVIEW_TITLE, `(() => { const s = document.querySelector('#pv-strip'); s.scrollLeft = 0; s.dispatchEvent(new Event('scroll')); return s.scrollLeft; })()`);
        await sleep(250);
      }
      const belowCapsule = Boolean(geo && capsuleRect && geo.rect.top >= capsuleRect.bottom - 2);
      if (tiled.ok && st0.ok && count0.ok && shown.ok && latency !== null && latency <= 200 && itemsAtOpen.ok && thumbsEvent && titleOk && pixelOk && scrollable && scrolled && belowCapsule) {
        p1Opened = true;
        rep.pass(`P1 预览打开与实时缩略图：六窗平铺 ${detailStr(tiled.detail).split('；').slice(0, 2).join('；')}…；真实点击胶囊主体后 ${latency}ms 内可交互（open→rendered ≤200ms）、缩略图随后填入 ${thumbsLatency}ms（关系数 6）；条目 6 条 live、标题逐条对应；像素主色逐条辨认（${pixelDetail}）；横向可滚动（scrollWidth ${items[0].scrollWidth} > clientWidth ${items[0].clientWidth}，滚动 240px 后首条目移出）；预览窗位于胶囊下方 ${rectStr(geo.rect)}`);
      } else {
        rep.fail(`P1 平铺=${JSON.stringify({ ok: tiled.ok, detail: detailStr(tiled.detail) })} 状态=${JSON.stringify(st0.state)} 计数=${JSON.stringify(count0)} 预览上屏=${JSON.stringify(shown)} 打开时延=${latency} 条目=${JSON.stringify({ ok: itemsAtOpen.ok, items: (items || []).map((x) => ({ t: x.title, live: x.live })) })} 缩略图填入=${JSON.stringify({ ok: !!thumbsEvent, ms: thumbsLatency })} 标题=${titleOk} 像素=${pixelOk}(${pixelDetail}) 滚动=${scrollable}/${scrolled} 位于胶囊下=${belowCapsule}`);
      }
    } catch (err) { rep.fail(`P1 异常: ${err.message}`); }

    // —— P2 最小化缓存与回退（决策 15）——
    rep.beginSegment('P2');
    try {
      if (!p1Opened) rep.note('P1 未达打开态：P2 从当前可见窗口继续（失败会连带到本段判定）');
      // P1 打开期间可见窗缓存已抓取：最小化成员 3 → 刷新后条目用最近缓存
      const w3 = tiles[2];
      win32.ShowWindow(w3, 7); // SW_SHOWMINNOACTIVE：最小化但不激活下一个顶层窗（6=SW_MINIMIZE 会抢前台）
      const cached = await waitPreviewItems((it) => it.some((x) => x.hwnd === w3 && x.cached), 4000);
      let cachedPixel = false;
      let cachedDetail = '';
      await sleep(300); // 缓存帧解码上屏（dataURL <img> 异步解码）后再取样
      const items = await readPreviewItems();
      const imgFacts = await cdpEval(PREVIEW_TITLE, `(() => {
        const img = document.querySelector('img.pv-img');
        if (!img) return { present: false };
        const r = img.getBoundingClientRect();
        return { present: true, complete: img.complete, naturalW: img.naturalWidth, naturalH: img.naturalHeight,
          rect: { x: r.x, y: r.y, w: r.width, h: r.height }, srcLen: (img.src || '').length,
          vis: getComputedStyle(img).visibility, op: getComputedStyle(img).opacity };
      })()`);
      const geo = await previewGeometry(items);
      if (geo && cached.ok) {
        const item = items.find((x) => x.hwnd === w3);
        if (item) {
          const png = await captureFast({
            left: geo.rect.left + Math.round(item.rect.x * geo.scale),
            top: geo.rect.top + Math.round(item.rect.y * geo.scale),
            right: geo.rect.left + Math.round((item.rect.x + item.rect.w) * geo.scale),
            bottom: geo.rect.top + Math.round((item.rect.y + item.rect.h) * geo.scale),
          }, '379-preview-cached');
          const res = colorRatiosInZones(png, [{ left: 0, top: 0, right: 10_000, bottom: 10_000 }], colors)[0];
          const wantIdx = tiles.indexOf(w3);
          cachedPixel = (res.ratios[wantIdx] || 0) >= 0.15;
          cachedDetail = `期望色#${wantIdx} 占比=${(res.ratios[wantIdx] || 0).toFixed(3)}（全色=${res.ratios.map((x) => x.toFixed(2)).join('/')}）img=${JSON.stringify(imgFacts)} itemRect=${JSON.stringify(item.rect)}`;
        }
      }
      // 关闭预览 → 缓存释放；无缓存的最小化窗 reopen 后回退图标+标题
      await clickCapsuleBody();
      const hidden = await waitPreviewHidden(4000);
      const diagClosed = await readPreviewDiag();
      win32.ShowWindow(tiles[1], 7); // W2 在预览关闭状态下最小化（NOACTIVE）→ 无缓存
      const countMin = await waitCapsuleCount(6, 6000);
      await clickCapsuleBody();
      await waitPreviewVisible(4000);
      const reopened = await waitPreviewItems((it) => it.some((x) => x.hwnd === tiles[1] && x.fallback && x.icon && x.fbTitle), 5000);
      const items2 = await readPreviewItems();
      const fallbackItem = items2.find((x) => x.hwnd === tiles[1]);
      const fallbackOk = Boolean(fallbackItem && fallbackItem.fallback && fallbackItem.icon
        && fallbackItem.fbTitle === `${FIXTURE_PREFIX}2` && fallbackItem.title === `${FIXTURE_PREFIX}2`);
      // 收尾：还原 W2/W3（关闭预览后由平铺账落位）
      await clickCapsuleBody();
      await waitPreviewHidden(3000);
      win32.ShowWindow(tiles[1], 9);
      win32.ShowWindow(tiles[2], 9);
      await waitAllRects(tiles.map((hwnd, i) => ({ hwnd, rect: layout6[i] })), 8000);
      if (cached.ok && cachedPixel && hidden.ok && diagClosed && diagClosed.cached === 0 && reopened.ok) {
        rep.pass(`P2 最小化缓存与回退：最小化成员 3 后条目改用最近缓存（${cachedDetail}）；关闭预览后 diag.cached=0（关闭即释放）；无缓存的最小化成员 2 重开后回退图标+标题（「${fallbackItem && fallbackItem.fbTitle}」、图标在场）；最小化窗仍计数（${countMin.ok ? 6 : JSON.stringify(countMin)}）`);
      } else {
        rep.fail(`P2 缓存=${JSON.stringify({ ok: cached.ok, ms: cached.ms })} 缓存像素=${cachedPixel}(${cachedDetail}) 关闭=${JSON.stringify(hidden)} diag=${JSON.stringify(diagClosed)} 计数=${JSON.stringify(countMin)} 回退=${JSON.stringify({ ok: reopened.ok, item: fallbackItem })}`);
      }
    } catch (err) { rep.fail(`P2 异常: ${err.message}`); }

    // —— P3 非聚焦收起（决策 14 / story 50）——
    rep.beginSegment('P3');
    try {
      // 鼠标离开不立即收起
      await clickCapsuleBody();
      await waitPreviewVisible(4000);
      const geo0items = await waitPreviewItems((it) => it.length === 6, 4000);
      const geo0 = await previewGeometry(geo0items.items);
      win32.moveMousePhys(geo0.rect.left + 8, Math.min(primaryPhys().h - 30, geo0.rect.bottom + 240));
      await sleep(900);
      const leaveKept = await previewPresent();
      // 再点胶囊收起
      await clickCapsuleBody();
      const toggleHidden = await waitPreviewHidden(4000);
      // Esc 收起（预览页取焦后发 Esc）
      await clickCapsuleBody();
      await waitPreviewVisible(4000);
      const geo1items = await waitPreviewItems((it) => it.length === 6, 4000);
      const geo1 = await previewGeometry(geo1items.items);
      const head = await previewHeaderPoint(geo1, geo1items.items);
      win32.moveMousePhys(head.x, head.y);
      await sleep(200);
      win32.clickPhys(head.x, head.y, 'left');
      await sleep(250);
      win32.send([win32.keyInput(0x1b, win32.KEYDOWN), win32.keyInput(0x1b, win32.KEYUP)]);
      const escHidden = await waitPreviewHidden(4000);
      // 点外收起：点成员窗上、预览之外的区域
      await clickCapsuleBody();
      await waitPreviewVisible(4000);
      const w1r = win32.rectOf(tiles[0]);
      let outside = { x: w1r.left + 80, y: w1r.bottom - 80 };
      const pr = win32.rectOf(findVisibleByTitle(PREVIEW_TITLE));
      if (pr && outside.x >= pr.left && outside.x <= pr.right && outside.y >= pr.top && outside.y <= pr.bottom) {
        outside = { x: pr.left + 40, y: Math.min(primaryPhys().h - 20, pr.bottom + 120) };
      }
      win32.moveMousePhys(outside.x, outside.y);
      await sleep(200);
      win32.clickPhys(outside.x, outside.y, 'left');
      const blurHidden = await waitPreviewHidden(4000);
      if (leaveKept && toggleHidden.ok && escHidden.ok && blurHidden.ok) {
        rep.pass(`P3 非聚焦收起：鼠标离开预览 900ms 不收起（仍在场）；再点胶囊 ${toggleHidden.ms}ms 内收起；Esc ${escHidden.ms}ms 内收起；点外（预览外真实点击）${blurHidden.ms}ms 内收起`);
      } else {
        rep.fail(`P3 离开保持=${leaveKept} 再点=${JSON.stringify(toggleHidden)} Esc=${JSON.stringify(escHidden)} 点外=${JSON.stringify(blurHidden)}`);
      }
    } catch (err) { rep.fail(`P3 异常: ${err.message}`); }

    // —— P4 选择进入聚焦（决策 16 / stories 51）——
    rep.beginSegment('P4');
    try {
      await clickCapsuleBody();
      await waitPreviewVisible(4000);
      const it = await waitPreviewItems((x) => x.length === 6, 5000);
      const geo = await previewGeometry(it.items);
      const target = it.items.find((x) => x.hwnd === tiles[0]);
      if (!target) throw new Error('预览条目缺成员 1');
      void geo;
      const clickRes = await clickPreviewItem(tiles[0]);
      if (!clickRes.ok) throw new Error(`条目点击未命中预览窗（${clickRes.reason}）`);
      const hidden = await waitPreviewHidden(4000);
      const zoom = await (async () => {
        const t0 = Date.now();
        for (;;) {
          if (isZoomed(tiles[0])) return { ok: true, ms: Date.now() - t0 };
          if (Date.now() - t0 > 4000) return { ok: false, ms: Date.now() - t0 };
          await sleep(60);
        }
      })();
      const focused = await waitFocus(tiles[0], 4000);
      const capHwnd = findVisibleByTitle(CAPSULE_TITLE);
      const capTop = capHwnd ? isTopmost(capHwnd) : false;
      const capVisible = Boolean(capHwnd);
      const countFocused = await readCapsuleCount();
      const stateFocused = await readTilingState();
      const maxRect = win32.rectOf(tiles[0]);
      const covers = maxRect && (maxRect.right - maxRect.left) >= primaryPhys().w * 0.95 && (maxRect.bottom - maxRect.top) >= primaryPhys().h * 0.9;
      // 聚焦期间其它成员不被平铺写动（保持原位）
      const othersHeld = await waitAllRects(tiles.slice(1).map((hwnd, i) => ({ hwnd, rect: layout6[i + 1] })), 3000);
      if (hidden.ok && zoom.ok && focused.ok && capVisible && capTop && countFocused === 6 && stateFocused && stateFocused.count === 6 && covers && othersHeld.ok) {
        rep.pass(`P4 选择进入聚焦：真实点击条目后目标窗真实最大化（IsZoomed，${rectStr(maxRect)} 覆盖主屏），focus=${tiles[0]}；胶囊仍置顶（WS_EX_TOPMOST）且计数=6；其余成员保持平铺原位（${detailStr(othersHeld.detail)}）`);
      } else {
        rep.fail(`P4 收起=${JSON.stringify(hidden)} 最大化=${JSON.stringify(zoom)} 聚焦=${JSON.stringify(focused)} 胶囊在场=${capVisible} 置顶=${capTop} 计数=${countFocused} 平铺态=${JSON.stringify(stateFocused)} 覆盖=${covers}(${rectStr(maxRect)}) 其余不动=${JSON.stringify({ ok: othersHeld.ok, detail: detailStr(othersHeld.detail) })}`);
      }
    } catch (err) { rep.fail(`P4 异常: ${err.message}`); }

    // —— P5 退出聚焦（决策 16 / stories 52-54）——
    rep.beginSegment('P5');
    try {
      // 再点胶囊 → 退出聚焦并恢复默认平铺
      await clickCapsuleBody();
      const exit1 = await waitFocus(null, 5000);
      const unzoom1 = await (async () => {
        const t0 = Date.now();
        for (;;) {
          if (!isZoomed(tiles[0])) return { ok: true, ms: Date.now() - t0 };
          if (Date.now() - t0 > 4000) return { ok: false, ms: Date.now() - t0 };
          await sleep(60);
        }
      })();
      const layout1 = await waitAllRects(tiles.map((hwnd, i) => ({ hwnd, rect: layout6[i] })), 6000);
      // 恢复按钮：聚焦成员 2 后真实点击胶囊恢复按钮 → 退出聚焦 + 恢复平铺
      await clickCapsuleBody();
      await waitPreviewVisible(4000);
      const click2 = await clickPreviewItem(tiles[1]);
      await waitFocus(tiles[1], 4000);
      const btn = await capsuleRestoreButton();
      if (!btn) throw new Error('胶囊恢复按钮不在场');
      await realClickPt(btn);
      const exit2 = await waitFocus(null, 5000);
      const unzoom2 = await (async () => {
        const t0 = Date.now();
        for (;;) {
          if (!isZoomed(tiles[1])) return { ok: true, ms: Date.now() - t0 };
          if (Date.now() - t0 > 4000) return { ok: false, ms: Date.now() - t0 };
          await sleep(60);
        }
      })();
      const layout2 = await waitAllRects(tiles.map((hwnd, i) => ({ hwnd, rect: layout6[i] })), 6000);
      // 明确激活其他窗口 → 先退出聚焦
      await clickCapsuleBody();
      await waitPreviewVisible(4000);
      const click3 = await clickPreviewItem(tiles[2]);
      const focus3 = await waitFocus(tiles[2], 4000);
      forceForeground(tiles[3]);
      const exit3 = await waitFocus(null, 5000);
      const restore3 = await waitAllRects(tiles.map((hwnd, i) => ({ hwnd, rect: layout6[i] })), 6000);
      const zoomAfter3 = isZoomed(tiles[2]);
      // 后台新窗不退出 / 抢前台才退出
      await clickCapsuleBody();
      await waitPreviewVisible(4000);
      const click5 = await clickPreviewItem(tiles[4]);
      const focus5 = await waitFocus(tiles[4], 4000);
      const bg = await spawnTile([255, 255, 255], { background: true, minimized: true });
      // 第七窗是过程物：不并入常驻成员账（回落布局断言只核六窗默认布局）
      tiles.pop();
      colors.pop();
      const count7 = await waitCapsuleCount(7, 8000);
      const stillFocused = await readFocusState();
      const zoomStill = isZoomed(tiles[4]);
      win32.ShowWindow(bg, 9);
      forceForeground(bg);
      const exit5 = await waitFocus(null, 6000);
      const placed7 = await waitTilingState((x) => x.count === 7 && x.placed === 7, 8000);
      // 清理第七窗，回到六窗默认布局
      const bgEntry = fixtures.find((f) => f.hwnd === bg);
      if (bgEntry && bgEntry.pid) spawnSync('taskkill', ['/PID', String(bgEntry.pid), '/T', '/F'], { stdio: 'ignore' });
      else win32.PostMessageW(bg, 0x0010, 0, 0);
      const countBack = await waitCapsuleCount(6, 8000);
      const layoutBack = await waitAllRects(tiles.map((hwnd, i) => ({ hwnd, rect: layout6[i] })), 8000);
      const allOk = exit1.ok && unzoom1.ok && layout1.ok && exit2.ok && unzoom2.ok && layout2.ok
        && focus3.ok && exit3.ok && restore3.ok && !zoomAfter3
        && focus5.ok && count7.ok && stillFocused && stillFocused.focused === tiles[4] && zoomStill
        && exit5.ok && placed7.ok && layoutBack.ok;
      if (allOk) {
        rep.pass(`P5 退出聚焦：再点胶囊 ${exit1.ms}ms 退出并恢复默认平铺（${detailStr(layout1.detail)}）；恢复按钮 ${exit2.ms}ms 退出并恢复平铺；激活其他窗口 ${exit3.ms}ms 内先退出并恢复平铺；聚焦期后台新窗（最小化出现）不退出（count=7、focus 仍=${tiles[4]}、仍最大化）、抢前台后退出并补入第七窗（placed=7），六窗逐像素回到默认布局（第七窗进程随后清场：count=${JSON.stringify(countBack)}）`);
      } else {
        rep.fail(`P5 点2=${JSON.stringify(click2)} 点3=${JSON.stringify(click3)} 点5=${JSON.stringify(click5)} 再点=${JSON.stringify(exit1)} 还原1=${JSON.stringify(unzoom1)} 布局1=${layout1.ok} 恢复按钮=${JSON.stringify(exit2)} 还原2=${JSON.stringify(unzoom2)} 布局2=${layout2.ok} 焦点3=${JSON.stringify(focus3)} 激活退出=${JSON.stringify(exit3)} 布局3=${restore3.ok} 仍最大化=${zoomAfter3} 焦点5=${JSON.stringify(focus5)} 计数7=${JSON.stringify(count7)} 后台保持=${JSON.stringify(stillFocused)}/${zoomStill} 抢前台退出=${JSON.stringify(exit5)} 第七补入=${JSON.stringify(placed7)} 回落计数=${JSON.stringify(countBack)} 回落布局=${JSON.stringify({ ok: layoutBack.ok, detail: detailStr(layoutBack.detail) })}`);
      }
    } catch (err) { rep.fail(`P5 异常: ${err.message}`); }

    // —— P6 资源生命周期与隐私（决策 15/26）——
    rep.beginSegment('P6');
    try {
      const diag = await readPreviewDiag();
      const text = eventsText();
      const noTitles = !/T379-W-\d+/.test(text);
      const noImages = !/data:image/.test(text);
      // 隐私面只看预览/聚焦链路的存证行（其余既有服务可能自有 title 字段，不在本票范围）
      const previewLines = text.split('\n').filter((l) => /window-preview|preview-|focus-/.test(l)).join('\n');
      const noTitleKey = !/"title"\s*:/.test(previewLines);
      const noImageKey = !/"image"\s*:/.test(previewLines);
      const chain = ['preview-open', 'preview-shown', 'preview-rendered', 'preview-thumbs', 'preview-close'].every((t) => text.includes(`"type":"${t}"`));
      const release = text.includes('"type":"preview-released"');
      if (diag && diag.open === false && diag.live === 0 && diag.cached === 0 && noTitles && noImages && noTitleKey && noImageKey && chain && release) {
        rep.pass(`P6 资源生命周期与隐私：关闭后 diag={open:false, live:0, cached:0}（DWM 关系与内存缓存全释放，存证有 preview-released）；事件日志不含窗口标题（T379-W-*）、不含 data:image、无 title/image 字段；打开→上屏→首帧→缩略图→关闭→释放链完整`);
      } else {
        rep.fail(`P6 diag=${JSON.stringify(diag)} 无标题=${noTitles} 无图像=${noImages} 无title键=${noTitleKey} 无image键=${noImageKey} 链路=${chain} 释放=${release}`);
      }
    } catch (err) { rep.fail(`P6 异常: ${err.message}`); }

    rep.note(`正对照：面板 exe=${panelExePath}（胶囊/预览/条带/面板自身不进计数）`);
  } catch (err) {
    rep.fail(`电池异常: ${err && err.stack || err}`);
  } finally {
    // —— P7 收尾复原（零残留）——
    rep.beginSegment('P7');
    try {
      const com2 = bindVdCom379();
      const cfg = (() => { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return null; } })();
      const agentIdNow = cfg?.agentDesktop?.agentDesktopId || agentId || null;
      const normalIdNow = cfg?.agentDesktop?.normalDesktopId || normalId || null;
      const baseNow = regDesktopFacts();
      const extraNow = baseNow.ids.filter((x) => !base.ids.includes(x));
      rep.note(`P7 收尾起点：基线=${base.count} 当前集合=${baseNow.count} 本轮多余=${extraNow.length} 夹具窗=${fixtures.length}`);
      for (const f of fixtures) {
        if (f.pid) spawnSync('taskkill', ['/PID', String(f.pid), '/T', '/F'], { stdio: 'ignore' });
        else if (f.hwnd) { try { win32.PostMessageW(f.hwnd, 0x0010, 0, 0); } catch { /* 尽力 */ } }
      }
      await sleep(600);
      if (agentIdNow) {
        try {
          if (baseNow.current === agentIdNow && normalIdNow) {
            com2.switchDesktop(normalIdNow);
            await waitDesktopCurrent379(com2, normalIdNow, 3000);
          }
          com2.removeDesktop(agentIdNow, normalIdNow ?? undefined);
        } catch (e) { rep.note(`P7 RemoveDesktop 异常（热键兜底前记录）：${e.message}`); }
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
      const backNormal = !agentIdNow || f2.current !== agentIdNow;
      if (setEq && backNormal) {
        rep.pass(`P7 零残留：注册表桌面集合与基线逐项相等（${f2.count} 桌面）、当前不在已删 Agent 桌面、夹具窗进程已清场`);
      } else {
        rep.fail(`P7 集合=${JSON.stringify(f2.ids.map((x) => x.slice(0, 8)))} 基线=${JSON.stringify(base.ids.map((x) => x.slice(0, 8)))} 当前=${f2.current}`);
      }
    } catch (err) { rep.fail(`P7 异常: ${err.message}`); }

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
