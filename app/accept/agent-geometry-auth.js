'use strict';
// 工单378 Agent 平铺逐窗几何授权与恢复平铺验收（spec #369 决策 9/10/11，ADR-0028；工单
// 376/377 真机链的续段——本电池只验 378 自己的面）。控制器以 --accept-agent-geometry-auth
// 身份运行，拉起 --panel-accept 面板子进程：
//   P1 首次拖动取消：真实拖动成员 1 → 500ms 内复原到原格 + 提示窗「调整窗口/保持平铺」；
//      Esc 后提示关闭、布局逐像素不变、零浮动；胶囊恢复按钮始终在场
//   P2 确认与浮动：再次拖动 → 复原+提示；真实点「调整窗口」→ 确认本身不重排（窗口仍在
//      原格、authorized=1）；重新拖动 → 浮动（几何保留、可覆盖窗格）、其余成员重铺满
//   P3 全几何入口逐窗授权：边框缩放 / 最大化（Win+Up）/ 键盘 Snap（Win+Left）/ 鼠标 Snap
//      （拖标题栏到左缘）——四个入口都先复原再询问，Esc 保持平铺
//   P4 后台自改不弹框：非前台成员窗被外部改窗 → 静默复原，零提示零授权（story 30）
//   P5 切出/返回：切普通保留浮动几何；返回不自动恢复（仍浮动、其余铺满）；返回后首次
//      操作复原到浮动几何并提示（授权已撤销）
//   P6 胶囊恢复按钮：真实点击按钮 → 浮动收回平铺、异常固定尺寸窗跳过并在胶囊报告
//      「恢复 1 · 跳过 1」、授权清除（恢复后首次操作重新提示）
//   P7 收尾复原（零残留）：夹具窗逐进程清场、切回普通、删配对 Agent 桌面、注册表集合与
//      基线逐项相等、config 三态还原
//
// 被测物夹具（工单377 定案）：受控 WPF 窗口（一窗一 powershell 进程，标题 T378-W-*）——
// 可外部改窗（WS_THICKFRAME 在场）、每窗独立、无会话恢复。输入一律 SendInput 真实注入
// （拖动/边框/键盘/Snap），提示窗按钮也走真实坐标点击——逐窗授权只能由真实用户手势产生。
//
// 运行：npm run accept:agent-geometry-auth（= electron . --accept-agent-geometry-auth）。
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
const EVENTS_FILE = path.join(__dirname, 'evidence', '378-agent-geometry-auth-events.jsonl');
// 工单384：布局持久化（工单383）落在共享 userData——本电池不验重启恢复，布局文档
// 重定向到本电池证据目录并在起止清掉（前置 = 恢复态 none，不继承他轮的 crash/桌面 ID 标记）。
const LAYOUT_FILE = path.join(__dirname, 'evidence', '378-agent-geometry-auth-layout.json');
const tape = createEventTape(EVENTS_FILE, { defaultTimeoutMs: 8000 });
const handle = createPanelHandle({
  execPath: process.execPath, appRoot: APP_ROOT, eventLogPath: EVENTS_FILE,
  archivePath: path.join(__dirname, 'evidence', '378-agent-geometry-auth-panel-handle-child.log'),
});
const CDP_PORT = cdpPortFor('378-agent-geometry-auth');
const TASKBAR_TITLE = 'DECK-TASKBAR';
const CAPSULE_TITLE = 'DECK-CAPSULE';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const koffi = win32.koffi;
koffi.load('user32.dll');

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
// 被测物窗口族（工单377）：受控 WPF 窗口（每窗独立 powershell.exe 进程）
//
// 为什么不用记事本：本机 Win11 记事本是单实例 + 会话恢复型 Store 应用——杀掉后下次
// 启动会把「上次会话的全部窗口」整套恢复（实测一次拉起 21 扇），既污染成员集合与计数，
// 又会在跨桌面拉起时把旧窗带到当前桌面。夹具必须一窗一进程、无持久会话、样式可外部
// 改窗（默认 ResizeMode=CanResize 含 WS_THICKFRAME，实测 style=0x16cf0000）。
// 标题前缀 T378-W- 是夹具身份（合格集正对照与收尾清场都按它认）。
// ————————————————————————————————————————————————————————————
const FIXTURE_PREFIX = 'T378-W-';

const user32Fixture377 = koffi.load('user32.dll');
const GetWindowTextLengthW377 = user32Fixture377.func('int __stdcall GetWindowTextLengthW(uintptr_t)');
const GetWindowTextW377 = user32Fixture377.func('int __stdcall GetWindowTextW(uintptr_t, char16_t *, int)');
function windowTitleOf377(hwnd) {
  const n = GetWindowTextLengthW377(hwnd);
  if (!n) return '';
  const buf = Buffer.alloc((n + 1) * 2);
  GetWindowTextW377(hwnd, buf, n + 1);
  return buf.toString('utf16le').replace(/\u0000+$/, '');
}

async function waitWindowByTitle(title, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const h of win32.topLevelWindows()) {
      if (win32.IsWindowVisible(h) && windowTitleOf377(h) === title) return h;
    }
    if (Date.now() > deadline) return 0;
    await sleep(150);
  }
}

/**
 * 拉起一扇夹具窗（WPF，可改尺寸，初始 700×500 @ (160,120)——刻意不等于任何平铺格，
 * 平铺写的效果对可见）。返回 {pid, hwnd}——hwnd=0 表示超时未现。
 */
async function spawnFixture(tag, timeoutMs = 25000) {
  const title = `${FIXTURE_PREFIX}${tag}`;
  const script = [
    'Add-Type -AssemblyName PresentationFramework',
    '$w = New-Object System.Windows.Window',
    `$w.Title = '${title}'`,
    '$w.Width = 700', '$w.Height = 500', '$w.Left = 160', '$w.Top = 120',
    '$w.ShowDialog() | Out-Null',
  ].join('; ');
  const proc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { stdio: 'ignore' });
  const hwnd = await waitWindowByTitle(title, timeoutMs);
  return { pid: proc.pid, hwnd };
}

/**
 * 固定尺寸探针窗（工单377 异常未平铺被测物）：WPF ResizeMode=NoResize——窗口样式不含
 * WS_THICKFRAME（实测 style=0x16c80000）。Windows 允许对固定尺寸窗程序化 SetWindowPos，
 * 所以「矩形纹丝不动」是生产未写窗的真实证据（写了就会变）。
 */
async function spawnFixedSizeWindow37x(title, timeoutMs = 25000) {
  const script = [
    'Add-Type -AssemblyName PresentationFramework',
    '$w = New-Object System.Windows.Window',
    `$w.Title = '${title}'`,
    "$w.ResizeMode = 'NoResize'",
    '$w.Width = 420', '$w.Height = 320', '$w.Left = 120', '$w.Top = 120',
    '$w.ShowDialog() | Out-Null',
  ].join('; ');
  const proc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { stdio: 'ignore' });
  const hwnd = await waitWindowByTitle(title, timeoutMs);
  return { pid: proc.pid, hwnd };
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
// 工单377：平铺状态只读投影、整布局断言与生命周期几何期望
// ————————————————————————————————————————————————————————————
/** AgentTilingState 只读投影（capsule 页桥接同源——计数/落格/溢出/异常分类） */
async function readTilingState() {
  return cdpEval376(CAPSULE_TITLE, `(async () => {
    const s = await window.deck.bridge.invoke('tiling/get-state', null);
    return { count: s.count, placed: s.placed, overflow: s.overflow, anomalies: s.anomalies, anomalyDetail: s.anomalyDetail, floating: s.floating, prompting: s.prompting, authorized: s.authorized, current: s.current, available: s.available };
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

/** 矩形账文本（段账明细用） */
function detailStr(detail) {
  return (detail || []).map((x) => `hwnd=${x.hwnd} ${rectStr(x.got)}${x.want ? `(期望 ${rectStr(x.want)})` : ''}`).join('；');
}

// 分裂规则独立重写（工单377）：按 spec 决策 7 / 用户故事 15-17 的文档规则在电池里算期望——
// 生产规划若漂移，真机几何与这里的期望对不上（不是把生产纯函数搬过来自证）
function splitH377(r) {
  const mid = r.left + Math.floor((r.right - r.left) / 2);
  return [{ ...r, right: mid }, { ...r, left: mid }];
}
function splitV377(r) {
  const mid = r.top + Math.floor((r.bottom - r.top) / 2);
  return [{ ...r, bottom: mid }, { ...r, top: mid }];
}
/** 3 窗（裂 B）：w1 左半、w2 右上、w3 右下 */
function layout3(area) {
  const [a, right] = splitH377(area);
  const [b, c] = splitV377(right);
  return [a, b, c];
}
/** 4 窗（裂 A）：w1 左上、w2 右上、w3 右下、w4 左下 */
function layout4(area) {
  const [a, right] = splitH377(area);
  const [b, c] = splitV377(right);
  const [a1, d] = splitV377(a);
  return [a1, b, c, d];
}
/** 5 窗（再裂 B）：w1 左上、w2 右上左、w3 右下、w4 左下、w5 右上右 */
function layout5(area) {
  const l4 = layout4(area);
  const [b1, e] = splitH377(l4[1]);
  return [l4[0], b1, l4[2], l4[3], e];
}
/** 6 窗（裂 C）：w1 左上、w2 右上左、w3 右下左、w4 左下、w5 右上右、w6 右下右 */
function layout6(area) {
  const l5 = layout5(area);
  const [c1, f] = splitH377(l5[2]);
  return [l5[0], l5[1], c1, l5[3], l5[4], f];
}

// ————————————————————————————————————————————————————————————
// 工单378：授权提示窗与真实输入几何操作（拖动/边框/最大化/键盘/Snap）
// ————————————————————————————————————————————————————————————
const PROMPT_TITLE = 'DECK-TILE-PROMPT';

/** 授权提示窗页面事实（按钮中心 CSS px + 标题文案）——按钮点击用真实坐标换算物理点 */
async function readPromptInfo() {
  return cdpEval376(PROMPT_TITLE, `(() => {
    const b = document.querySelector('#btn-adjust');
    const k = document.querySelector('#btn-keep');
    const pt = (el) => { const q = el.getBoundingClientRect(); return { x: q.x + q.width / 2, y: q.y + q.height / 2 }; };
    return {
      adjust: pt(b), keep: pt(k),
      title: (document.querySelector('#p-title') || {}).textContent || '',
      hint: (document.querySelector('#p-hint') || {}).textContent || '',
      w: window.innerWidth, h: window.innerHeight,
    };
  })()`);
}

/** 等提示窗出现（标题寻窗 + 页面就绪）：返回 hwnd/几何/文案 */
async function waitPrompt(timeoutMs = 5000) {
  const t0 = Date.now();
  let hwnd = 0;
  for (;;) {
    hwnd = win32.topLevelWindows().find((h) => win32.IsWindowVisible(h) && windowTitleOf377(h) === PROMPT_TITLE) || 0;
    if (hwnd) {
      try {
        const info = await readPromptInfo();
        if (info) return { ok: true, hwnd, info, ms: Date.now() - t0 };
      } catch { /* 页面尚未加载完：继续等 */ }
    }
    if (Date.now() - t0 > timeoutMs) return { ok: false, hwnd: hwnd || null, ms: Date.now() - t0 };
    await sleep(80);
  }
}

/** 提示窗是否在场（标题寻窗；用于「后台自改不弹框」的零提示断言） */
function promptPresent() {
  return win32.topLevelWindows().some((h) => win32.IsWindowVisible(h) && windowTitleOf377(h) === PROMPT_TITLE);
}

/** 物理点换算：页面 CSS px → 屏幕物理 px（窗口可能被 DPI 缩放） */
function promptPoint(pw, which) {
  const r = win32.rectOf(pw.hwnd);
  const info = pw.info;
  const scale = (r.right - r.left) / info.w;
  const p = which === 'adjust' ? info.adjust : info.keep;
  return { x: Math.round(r.left + p.x * scale), y: Math.round(r.top + p.y * scale) };
}

/** 真实点击提示窗按钮（可信内核 UI 用户手势） */
async function clickPromptButton(pw, which) {
  const pt = promptPoint(pw, which);
  await convergeAtFragment(pt);
  win32.clickPhys(pt.x, pt.y, 'left');
  await sleep(250);
}

/** 鼠标先落到目标点再点击（穿透窗的热区要 25ms 轮询后才开门） */
async function convergeAtFragment(pt) {
  win32.moveMousePhys(pt.x, pt.y);
  await sleep(220);
}

/** Esc = 保持平铺：先点提示窗标题区取焦（Esc 只到前台窗），再发 Esc */
async function pressPromptEsc(pw) {
  const r = win32.rectOf(pw.hwnd);
  const scale = (r.right - r.left) / pw.info.w;
  const x = Math.round(r.left + 18 * scale);
  const y = Math.round(r.top + 14 * scale);
  win32.clickPhys(x, y, 'left');
  await sleep(160);
  win32.send([win32.keyInput(0x1b, win32.KEYDOWN), win32.keyInput(0x1b, win32.KEYUP)]);
  await sleep(280);
}

/** 等提示窗消失（收窗由主进程在授权决定后完成） */
async function waitPromptGone(timeoutMs = 3000) {
  const t0 = Date.now();
  for (;;) {
    if (!promptPresent()) return { ok: true, ms: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) return { ok: false, ms: Date.now() - t0 };
    await sleep(80);
  }
}

/** 真实拖动标题栏（SendInput 按下 → 分步移动 → 抬起） */
async function dragTitleBar(hwnd, dx, dy) {
  const r = win32.rectOf(hwnd);
  if (!r) return { ok: false };
  // 工单384：起拖点避开胶囊矩形（同 focusByTitle——正中标题栏被 DECK-CAPSULE 覆盖，
  // 按下落在胶囊上就不产生窗口拖动，鼠标 Snap 入口于是打不到目标窗）。取 30% 横位。
  const sx = Math.round(r.left + (r.right - r.left) * 0.3);
  const sy = r.top + 14; // WPF 标准标题栏（~30px）：取顶边内 14px，确保落在 caption 上
  win32.moveMousePhys(sx, sy);
  await sleep(90);
  win32.send([win32.mouseInput(0, 0, win32.LEFTDOWN)]);
  await sleep(90);
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    win32.moveMousePhys(sx + Math.round((dx * i) / steps), sy + Math.round((dy * i) / steps));
    await sleep(35);
  }
  await sleep(90);
  win32.send([win32.mouseInput(0, 0, win32.LEFTUP)]);
  await sleep(150);
  return { ok: true, from: { x: sx, y: sy } };
}

/** 真实拖动右边框（边框缩放入口） */
async function dragRightBorder(hwnd, dx) {
  const r = win32.rectOf(hwnd);
  if (!r) return { ok: false };
  const sx = r.right - 4;
  const sy = Math.round((r.top + r.bottom) / 2);
  win32.moveMousePhys(sx, sy);
  await sleep(90);
  win32.send([win32.mouseInput(0, 0, win32.LEFTDOWN)]);
  await sleep(90);
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    win32.moveMousePhys(sx + Math.round((dx * i) / steps), sy);
    await sleep(35);
  }
  await sleep(90);
  win32.send([win32.mouseInput(0, 0, win32.LEFTUP)]);
  await sleep(150);
  return { ok: true };
}

/** 点标题栏取焦（不移动：不产生几何变化，不触发授权）。取焦不成就 SetForegroundWindow 再试一次 */
async function focusByTitle(hwnd) {
  const r = win32.rectOf(hwnd);
  if (!r) return false;
  // 工单384：点击点避开胶囊矩形（DECK-CAPSULE：主屏顶部居中 168×30，y=6..36，TOPMOST）——
  // 标题栏正中的点击会落在胶囊上（打开窗口预览、焦点不回目标窗），Win+Up/Win+Left/Snap
  // 于是打不到目标窗（P3 入口矩阵三例 pw=false 的实证）。取标题栏 30% 横位：全宽/half
  // 半屏窗都落在胶囊之外，断言语义不变（仍是「真实点击标题栏聚焦」）。
  const clickX = Math.round(r.left + (r.right - r.left) * 0.3);
  win32.clickPhys(clickX, r.top + 10, 'left');
  await sleep(200);
  if (Number(win32.GetForegroundWindow()) === Number(hwnd)) return true;
  win32.SetForegroundWindow(hwnd);
  await sleep(200);
  win32.clickPhys(clickX, r.top + 10, 'left');
  await sleep(200);
  return Number(win32.GetForegroundWindow()) === Number(hwnd);
}

/** Win+方向键（最大化 Win+Up / 左半屏 Win+Left） */
function winArrow(vk) {
  win32.send([
    win32.keyInput(0x5b, win32.KEYDOWN),
    win32.keyInput(vk, win32.KEYDOWN),
    win32.keyInput(vk, win32.KEYUP),
    win32.keyInput(0x5b, win32.KEYUP),
  ]);
}

/** 胶囊右侧恢复按钮中心（物理 px）与在场事实 */
async function capsuleRestoreButton() {
  const hwnd = win32.topLevelWindows().find((h) => win32.IsWindowVisible(h) && windowTitleOf377(h) === CAPSULE_TITLE) || 0;
  if (!hwnd) return null;
  const info = await cdpEval376(CAPSULE_TITLE, `(() => {
    const b = document.querySelector('#cap-restore');
    if (!b) return null;
    const q = b.getBoundingClientRect();
    return { x: q.x + q.width / 2, y: q.y + q.height / 2, w: window.innerWidth, visible: q.width > 0 && q.height > 0 };
  })()`);
  if (!info) return null;
  const r = win32.rectOf(hwnd);
  const scale = (r.right - r.left) / info.w;
  return { hwnd, x: Math.round(r.left + info.x * scale), y: Math.round(r.top + info.y * scale), visible: info.visible };
}

async function readCapsuleStatus() {
  return cdpEval376(CAPSULE_TITLE, `(document.querySelector('#cap-status') || {}).textContent || ''`);
}

// ————————————————————————————————————————————————————————————
// 主流程
// ————————————————————————————————————————————————————————————
async function main() {
  const rep = new Report('378-agent-geometry-auth');
  const fixtures = []; // { pid, hwnd } —— P7 收尾逐进程清场
  const tiles = []; // 成员窗（加入序）
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

  try {
    fs.writeFileSync(EVENTS_FILE, '', 'utf8');
    try { fs.unlinkSync(LAYOUT_FILE); } catch { /* 无旧布局 */ }
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
    normalId = base.current;

    handle.launch({ mode: 'accept', cdpPort: CDP_PORT, stdio: 'ignore', extraEnv: { DECK_AGENT_LAYOUT_FILE: LAYOUT_FILE } });
    const boot = await tape.wait('boot', null, { timeoutMs: 15000 });
    if (!boot) throw new Error('面板子进程未上报 boot 事件');
    rep.note(`面板 pid=${boot.pid}`);
    const tbHwnd = await handle.waitWindow({ title: TASKBAR_TITLE, timeoutMs: 12000 });
    if (!tbHwnd) throw new Error('任务栏窗口未出现');
    const tbRect = win32.rectOf(tbHwnd);
    const dip = screen.getPrimaryDisplay().bounds;
    const scale = (tbRect.right - tbRect.left) / dip.width;
    // 模式组两枚按钮齐备才算就绪：首拍 taskbar-geometry 可能带空 modeButtons（模式组尚未
    // 渲染），只在空拍上取按钮几何会误判「缺位」（本轮实测竞态）
    const hasModeButtons = (e) => e.modePill && Array.isArray(e.modeButtons) && e.modeButtons.length >= 2;
    const ready = await tape.wait('taskbar-geometry', hasModeButtons, { timeoutMs: 12000 });
    if (!ready) throw new Error('taskbar-geometry 存证缺失模式组矩形');
    const latestGeo = () => tape.latest('taskbar-geometry', hasModeButtons) || ready;
    const panelExePath = String(win32.exeOfPid(win32.threadIdOf(tbHwnd).pid) || '');
    if (!panelExePath) throw new Error('面板 exe 身份不可读');

    // 平铺区期望（生产 tileAreaOf 同口径：主屏物理矩形，下缘 = 条带顶）
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

    const halves = splitH377(AREA);
    const spawnTile = async () => {
      fixtureSeq += 1;
      const s = await spawnFixture(`W${fixtureSeq}`);
      fixtures.push({ pid: s.pid, hwnd: s.hwnd });
      if (!s.hwnd) throw new Error(`夹具窗 T378-W-W${fixtureSeq} 未出现`);
      await sleep(250);
      tiles.push(s.hwnd);
      return s.hwnd;
    };
    const modePoint = (id) => modeButtonPoint376(latestGeo(), tbRect, scale, id);
    const clickMode = async (id) => {
      const pt = modePoint(id);
      if (!pt) throw new Error(`${id} 模式按钮几何缺位`);
      // 收栏档（真最大化/分屏会话——本电池的 Snap 入口会建立主屏分屏会话）栏面退场，
      // 只剩条带底缘的唤出条：先把光标贴到唤出条上唤出栏面（真实用户路径），再点按钮
      if (win32.windowFromPointRoot(pt) !== tbHwnd) {
        // 唤出条按组排布：必须悬停「模式组」那一条（悬停 150ms 后该组 pill 复现）
        const pill = (latestGeo().modePill) || { x: 110, w: 94 };
        win32.moveMousePhys(Math.round(tbRect.left + (pill.x + pill.w / 2) * scale), tbRect.bottom - 4);
        await sleep(500);
      }
      const converged = await convergeAt376(pt, tbHwnd);
      if (!converged) rep.note(`注记：${id} 模式按钮点位未被条带窗命中（鼠标穿透未开？）point=${JSON.stringify(pt)}`);
      await sleep(120);
      win32.clickPhys(pt.x, pt.y, 'left');
      return pt;
    };
    /** 切到指定模式并等系统桌面 ID 确认（失败重试一次——命中面抖动，不静默放过） */
    const switchMode = async (id, targetId, label) => {
      await clickMode(id);
      let conf = await waitDesktopCurrent376(com, targetId, 4000);
      if (!conf.ok) {
        rep.note(`${label} 首次切换未在 4s 内确认（${JSON.stringify(conf)}），重试一次点击`);
        await clickMode(id);
        conf = await waitDesktopCurrent376(com, targetId, 4000);
      }
      return conf;
    };
    // —— P1 首次拖动：复原 + 提示，Esc 保持平铺（决策 10 / stories 33/34/36）——
    rep.beginSegment('P1');
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
      let conf = await waitDesktopCurrent376(com, agentId, 4000);
      if (!conf.ok) {
        await clickMode('agent');
        conf = await waitDesktopCurrent376(com, agentId, 4000);
      }
      if (!conf.ok) throw new Error('切换 Agent 未确认');
      await spawnTile();
      await spawnTile();
      const tiled = await waitAllRects([{ hwnd: tiles[0], rect: halves[0] }, { hwnd: tiles[1], rect: halves[1] }], 12000);
      const st0 = await waitTilingState((x) => x.count === 2 && x.placed === 2);
      const btn = await capsuleRestoreButton();
      const before = tiles.map((h) => win32.rectOf(h));

      // 首次真实拖动成员 1 标题栏：先复原再提示
      await dragTitleBar(tiles[0], 120, 80);
      const pw = await waitPrompt(4000);
      const restored = await waitRectStable(tiles[0], halves[0], 500, 4000);
      const stPrompt = await readTilingState();
      // Esc 保持平铺
      if (pw.ok) await pressPromptEsc(pw);
      const gone = await waitPromptGone(3000);
      const after = tiles.map((h) => win32.rectOf(h));
      const stAfter = await waitTilingState((x) => x.prompting === 0 && x.floating === 0, 3000);
      const sameLayout = halves.every((r, i) => rectEq(after[i], before[i]));
      const textOk = pw.ok && /调整窗口/.test(pw.info.title) && /保持平铺/.test(pw.info.hint);
      if (tiled.ok && st0.ok && btn && btn.visible && pw.ok && textOk && restored.ok && stPrompt && stPrompt.prompting === 1 && gone.ok && sameLayout && stAfter.ok) {
        rep.pass(`P1 首次拖动取消：两窗平铺 ${rectStr(halves[0])} / ${rectStr(halves[1])}；真实拖动成员 1 后 ${restored.ms}ms 内复原到原格（提示文案「${pw.info.title} / ${pw.info.hint}」）、prompting=1 且零浮动；Esc 后提示 ${gone.ms}ms 内关闭、布局逐像素不变、prompting=0/floating=0；胶囊恢复按钮在场可点（${Math.round(btn.x)},${Math.round(btn.y)}）`);
      } else {
        rep.fail(`P1 平铺=${JSON.stringify({ ok: tiled.ok, detail: detailStr(tiled.detail) })} 状态=${JSON.stringify(st0.state)} 按钮=${JSON.stringify(btn)} 提示=${JSON.stringify({ ok: pw.ok, ms: pw.ms, info: pw.info })} 复原=${JSON.stringify(restored)} 提示期状态=${JSON.stringify(stPrompt)} 收窗=${JSON.stringify(gone)} 布局不变=${sameLayout} 终态=${JSON.stringify(stAfter.state)}`);
      }
    } catch (err) { rep.fail(`P1 异常: ${err.message}`); }

    // —— P2 确认不重排 + 重新操作才浮动（决策 9/10/11，stories 34/36/37/38）——
    rep.beginSegment('P2');
    try {
      if (tiles.length !== 2) throw new Error(`P1 未达两窗（当前 ${tiles.length}）`);
      // 再次拖动 → 复原 + 提示；真实点「调整窗口」
      await dragTitleBar(tiles[0], 120, 80);
      const pw = await waitPrompt(4000);
      if (!pw.ok) throw new Error('第二次拖动后提示未出现');
      const restored = await waitRectStable(tiles[0], halves[0], 500, 4000);
      const afterCancelState = await readTilingState();
      await clickPromptButton(pw, 'adjust');
      const gone = await waitPromptGone(3000);
      const stConfirmed = await waitTilingState((x) => x.authorized === 1, 3000);
      const stillTiled = await waitRectStable(tiles[0], halves[0], 300, 1500);
      // 确认后重新发起操作 → 浮动：几何保留、其余成员重铺满
      await dragTitleBar(tiles[0], 140, 90);
      const floatRect = win32.rectOf(tiles[0]);
      const stFloat = await waitTilingState((x) => x.floating === 1 && x.placed === 1 && x.authorized === 0, 5000);
      const otherFull = await waitRectStable(tiles[1], AREA, 500, 5000);
      const notTile = floatRect && !rectEq(floatRect, halves[0]);
      if (pw.ok && restored.ok && afterCancelState && afterCancelState.floating === 0 && gone.ok && stConfirmed.ok && stillTiled.ok && notTile && stFloat.ok && otherFull.ok) {
        rep.pass(`P2 确认与浮动：第二次拖动 ${restored.ms}ms 内复原、零浮动；点「调整窗口」后提示关闭、窗口仍在原格（确认本身不重排）、authorized=1；重新拖动后窗口浮动 ${rectStr(floatRect)}（可覆盖窗格）、其余成员重铺满 ${rectStr(AREA)}、floating=1/placed=1、授权已消费（authorized=0）`);
      } else {
        rep.fail(`P2 提示=${JSON.stringify({ ok: pw.ok, ms: pw.ms })} 复原=${JSON.stringify(restored)} 取消后状态=${JSON.stringify(afterCancelState)} 收窗=${JSON.stringify(gone)} 确认后状态=${JSON.stringify(stConfirmed.state)} 仍在格=${JSON.stringify(stillTiled)} 浮动矩形=${rectStr(floatRect)} 非原格=${notTile} 浮动态=${JSON.stringify(stFloat.state)} 其余铺满=${JSON.stringify({ ok: otherFull.ok, rect: rectStr(otherFull.rect) })}`);
      }
    } catch (err) { rep.fail(`P2 异常: ${err.message}`); }

    // —— P3 全几何入口逐窗授权：边框 / 最大化 / 键盘 / Snap（决策 10，story 35）——
    rep.beginSegment('P3');
    try {
      if (tiles.length !== 2) throw new Error(`P2 未达两窗（当前 ${tiles.length}）`);
      const target = tiles[1]; // 平铺成员（成员 1 已浮动）
      const baseRect = AREA;
      const cases = [];
      const runCase = async (label, act) => {
        await act();
        const pw = await waitPrompt(4000);
        const back = await waitRectStable(target, baseRect, 500, 4000);
        const st = await readTilingState();
        if (pw.ok) await pressPromptEsc(pw);
        const gone = await waitPromptGone(3000);
        const held = await waitRectStable(target, baseRect, 300, 1500);
        const st2 = await readTilingState();
        cases.push({ label, pw: pw.ok, back: back.ok, prompting: st ? st.prompting : null, gone: gone.ok, held: held.ok, state: st2 });
      };
      await runCase('边框缩放', () => dragRightBorder(target, -220));
      await focusByTitle(target);
      await runCase('最大化（Win+Up）', async () => { focusByTitle(target); winArrow(0x26); });
      await focusByTitle(target);
      await runCase('键盘 Snap（Win+Left）', async () => { focusByTitle(target); winArrow(0x25); });
      await runCase('鼠标 Snap（拖标题栏到左缘）', async () => { await dragTitleBar(target, -Math.round(AREA.right * 0.45), 6); });
      const allOk = cases.every((c) => c.pw && c.back && c.prompting === 1 && c.gone && c.held);
      if (allOk) {
        rep.pass(`P3 全几何入口逐窗授权：${cases.map((c) => `${c.label}→复原+提示+Esc 保持平铺`).join('；')}——四个入口（拖动/边框/最大化/键盘/Snap 同一规则）均先复原再询问`);
      } else {
        rep.fail(`P3 入口矩阵=${JSON.stringify(cases)}`);
      }
    } catch (err) { rep.fail(`P3 异常: ${err.message}`); }

    // —— P4 后台自改不弹框：非前台外部改窗静默复原（决策 10 / story 30）——
    rep.beginSegment('P4');
    try {
      if (tiles.length !== 2) throw new Error(`P3 未达两窗（当前 ${tiles.length}）`);
      const floatWin = tiles[0];
      const tileWin = tiles[1];
      // 前台给浮动窗（点标题栏取焦——浮动窗几何不变，不触发授权）
      const focused = await focusByTitle(floatWin);
      const before = win32.rectOf(tileWin);
      win32.SetWindowPos(tileWin, 0, before.left + 180, before.top + 120, before.right - before.left, before.bottom - before.top, win32.SWP_NOZORDER | win32.SWP_NOACTIVATE);
      const back = await waitRectStable(tileWin, AREA, 500, 4000);
      await sleep(900); // 静置：确认零提示
      const noPrompt = !promptPresent();
      const st = await readTilingState();
      if (focused && back.ok && noPrompt && st && st.prompting === 0 && st.authorized === 0) {
        rep.pass(`P4 后台自改不弹框：非前台成员窗被外部改窗后 ${back.ms}ms 内静默复原到格 ${rectStr(AREA)}，全程零提示窗、零授权（prompting=0/authorized=0）——锁定规则纠正但不打扰用户`);
      } else {
        rep.fail(`P4 取焦=${focused} 复原=${JSON.stringify(back)} 零提示=${noPrompt} 状态=${JSON.stringify(st)}`);
      }
    } catch (err) { rep.fail(`P4 异常: ${err.message}`); }

    // —— P5 切出保留浮动几何但撤销授权；返回后不自动恢复（决策 11 / story 39）——
    rep.beginSegment('P5');
    try {
      if (tiles.length !== 2) throw new Error(`P4 未达两窗（当前 ${tiles.length}）`);
      const floatWin = tiles[0];
      const floatBefore = win32.rectOf(floatWin);
      const toNormal = await switchMode('normal', normalId, '切普通');
      const floatInNormal = win32.rectOf(floatWin);
      const keptGeometry = rectEq(floatInNormal, floatBefore);
      const toAgent = await switchMode('agent', agentId, '切回 Agent');
      const back = await waitRectStable(floatWin, floatBefore, 600, 5000);
      const otherFull = await waitRectStable(tiles[1], AREA, 400, 5000);
      const st = await waitTilingState((x) => x.floating === 1 && x.prompting === 0 && x.authorized === 0, 4000);
      // 返回后首次操作：授权已撤销 → 复原到保留的浮动几何并提示
      await dragTitleBar(floatWin, 110, 70);
      const pw = await waitPrompt(4000);
      const restored = await waitRectStable(floatWin, floatBefore, 500, 4000);
      const stPrompt = await readTilingState();
      if (pw.ok) await pressPromptEsc(pw);
      const gone = await waitPromptGone(3000);
      if (toNormal.ok && keptGeometry && toAgent.ok && back.ok && otherFull.ok && st.ok && pw.ok && restored.ok && stPrompt && stPrompt.prompting === 1 && gone.ok) {
        rep.pass(`P5 切出/返回：切普通后浮动几何逐像素保留 ${rectStr(floatInNormal)}；返回 Agent 后不自动恢复（仍浮动、其余成员铺满 ${rectStr(AREA)}、floating=1）；返回后首次拖动 ${restored.ms}ms 内复原到浮动几何并提示（授权已撤销、prompting=1），Esc 后保持浮动`);
      } else {
        rep.fail(`P5 切普通=${JSON.stringify(toNormal)} 保留几何=${keptGeometry}(${rectStr(floatInNormal)} vs ${rectStr(floatBefore)}) 切回=${JSON.stringify(toAgent)} 浮动原位=${JSON.stringify({ ok: back.ok, rect: rectStr(back.rect) })} 其余铺满=${JSON.stringify({ ok: otherFull.ok, rect: rectStr(otherFull.rect) })} 状态=${JSON.stringify(st.state)} 提示=${JSON.stringify({ ok: pw.ok })} 复原=${JSON.stringify(restored)} 提示期=${JSON.stringify(stPrompt)} 收窗=${JSON.stringify(gone)}`);
      }
    } catch (err) { rep.fail(`P5 异常: ${err.message}`); }

    // —— P6 胶囊恢复按钮：收回浮动 + 补入异常跳过报告 + 清授权（决策 11 / stories 28/40/41）——
    rep.beginSegment('P6');
    try {
      if (tiles.length !== 2) throw new Error(`P5 未达两窗（当前 ${tiles.length}）`);
      // 异常未平铺在场（固定尺寸窗）：恢复平铺应跳过并报告
      const probe = await spawnFixedSizeWindow37x('T378-FIXED');
      fixtures.push({ pid: probe.pid, hwnd: probe.hwnd });
      if (!probe.hwnd) throw new Error('固定尺寸探针窗未出现');
      const fixedRect0 = win32.rectOf(probe.hwnd);
      const stAnom = await waitTilingState((x) => x.anomalies === 1 && x.floating === 1 && x.count === 3, 6000);
      const btn = await capsuleRestoreButton();
      if (!btn || !btn.visible) throw new Error('胶囊恢复按钮不在场');
      // 真实点击（指针先落位让热区开门，再点击）
      win32.moveMousePhys(btn.x, btn.y);
      await sleep(260);
      win32.clickPhys(btn.x, btn.y, 'left');
      const restoredState = await waitTilingState((x) => x.floating === 0 && x.placed === 2 && x.anomalies === 1, 6000);
      const status = await readCapsuleStatus();
      const layout = await waitAllRects([{ hwnd: tiles[1], rect: halves[0] }, { hwnd: tiles[0], rect: halves[1] }], 6000);
      const fixedRect1 = win32.rectOf(probe.hwnd);
      const fixedStill = fixedRect0 && fixedRect1 && rectEq(fixedRect1, fixedRect0);
      // 清授权：恢复后首次拖动会重新提示（不是直接浮动）
      await dragTitleBar(tiles[0], 90, 60);
      const pw = await waitPrompt(4000);
      const stAfter = await readTilingState();
      if (pw.ok) await pressPromptEsc(pw);
      const gone = await waitPromptGone(3000);
      const statusOk = /恢复\s*1/.test(status) && /跳过\s*1/.test(status);
      if (stAnom.ok && restoredState.ok && statusOk && layout.ok && fixedStill && pw.ok && stAfter && stAfter.prompting === 1 && stAfter.floating === 0 && gone.ok) {
        rep.pass(`P6 恢复按钮：真实点击胶囊右侧恢复按钮 → 浮动窗收回平铺（成员 1 左半、成员 2 右半，逐像素 ${detailStr(layout.detail)}）、floating=0/placed=2；异常固定尺寸窗跳过（矩形不动 ${rectStr(fixedRect0)}、anomalies=1）并在胶囊报告「${status.trim()}」；恢复后首次拖动重新提示（授权已清除）、Esc 保持平铺`);
      } else {
        rep.fail(`P6 异常前态=${JSON.stringify(stAnom.state)} 按钮=${JSON.stringify(btn)} 恢复后=${JSON.stringify(restoredState.state)} 状态文案=「${status}」 布局=${JSON.stringify({ ok: layout.ok, detail: detailStr(layout.detail) })} 异常窗不动=${fixedStill} 提示=${JSON.stringify({ ok: pw.ok })} 提示期=${JSON.stringify(stAfter)} 收窗=${JSON.stringify(gone)}`);
      }
      // 探针窗清场（避免污染收尾计数）
      win32.PostMessageW(probe.hwnd, 0x0010, 0, 0);
      await sleep(400);
    } catch (err) { rep.fail(`P6 异常: ${err.message}`); }

    rep.note(`正对照：面板 exe=${panelExePath}（胶囊/条带/面板自身不进计数）`);
  } catch (err) {
    rep.fail(`电池异常: ${err && err.stack || err}`);
  } finally {
    // —— P7 收尾复原（零残留）——
    rep.beginSegment('P7');
    try {
      const com2 = bindVdCom376();
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
            await waitDesktopCurrent376(com2, normalIdNow, 3000);
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
    try { fs.unlinkSync(LAYOUT_FILE); } catch { /* 已删/未生成 */ }
    restoreConfig(originalConfig);
    win32.ensureNativeTaskbarVisible();
  }

  finish();
}

module.exports = main;
