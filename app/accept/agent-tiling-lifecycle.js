'use strict';
// 工单377 Agent 平铺完整生命周期与容量降级验收（spec #369 决策 7/12，ADR-0028；工单376
// 一至两窗最小闭环的真机续段——本电池只验 377 自己的面，376 的 P1-P6 归 376 电池）。
// 控制器以 --accept-agent-tiling-lifecycle 身份运行，拉起 --panel-accept 面板子进程：
//   P1 一至三窗：配对+切 Agent → 首窗铺满、两窗左右各半、三窗裂 B（A 左半/B 右上/C 右下）
//   P2 四窗裂 A：A/D 左列、B/C 右列，逐像素；计数 4
//   P3 五窗再裂 B：B 窗格横裂、其余窗格不动；计数 5
//   P4 六窗裂 C + 确定性重放：六窗精确几何；清空全部成员后以同序重建六窗 → 逐像素同布局
//   P5 最小化保留窗格与顺序：最小化成员 2 → 其余五窗零移动、计数与 placed 不变；还原回格
//   P6 关闭收缩由兄弟吸收：关成员 4 → 兄弟（成员 1）吸收整左列，其余四窗不动
//   P7 移出/移回主屏：移出最新成员 → 兄弟吸收整右下格、计数回落；移回按最新窗口加入
//      （裂变当前队首、其余窗格不动）
//   P8 固定尺寸异常未平铺：WPF ResizeMode=NoResize 探针窗（无 WS_THICKFRAME）→ 生产零写窗
//      （矩形纹丝不动）、其余窗几何不动、计数仍含它、anomalies=1 且 fixedSize 分类在案、
//      静置无重试
//   P10 屏外滚动带与双向 fit（工单405）：第 33 扇触发带（列矩形/露边/缩窄区）→ 露边真
//      点击整组最小滑入、普通激活整组回位（双向）→ 胶囊/预览计数含带成员 → 关 28 扇带
//      收拢补入（377 定案「溢出不设真机段」的代价顾虑由 405 验收标准承接——并行拉起
//      压墙钟，见段内注记）
//   P9 收尾复原（零残留）：夹具窗逐进程清场、切回普通、删配对 Agent 桌面、注册表集合与
//      基线逐项相等、config 三态还原
//
// 被测物夹具（工单377 定案）：受控 WPF 窗口（一窗一 powershell 进程，标题 T377-W-*）。
// 不用记事本：本机 Win11 记事本是会话恢复型 Store 应用，杀掉后下次启动整套恢复旧窗
// （实测 21 扇），成员集合与计数不可判——夹具必须是每窗独立、无持久会话、样式可外部
// 改窗的进程。容量溢出不设真机段（本机 2560×1392 平铺区约需 33 扇窗才触发，代价不成
// 比例；几何/状态机由纯函数矩阵钉——battery-governance 增段条件②）。
//
// 运行：npm run accept:agent-tiling-lifecycle（= electron . --accept-agent-tiling-lifecycle）。
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
const EVENTS_FILE = path.join(__dirname, 'evidence', '377-agent-tiling-lifecycle-events.jsonl');
// 工单384：布局持久化（工单383）落在共享 userData——本电池不验重启恢复，布局文档
// 重定向到本电池证据目录并在起止清掉（前置 = 恢复态 none，不继承他轮的 crash/桌面 ID 标记）。
const LAYOUT_FILE = path.join(__dirname, 'evidence', '377-agent-tiling-lifecycle-layout.json');
const tape = createEventTape(EVENTS_FILE, { defaultTimeoutMs: 8000 });
const handle = createPanelHandle({
  execPath: process.execPath, appRoot: APP_ROOT, eventLogPath: EVENTS_FILE,
  archivePath: path.join(__dirname, 'evidence', '377-agent-tiling-lifecycle-panel-handle-child.log'),
});
const CDP_PORT = cdpPortFor('377-agent-tiling-lifecycle');
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
// 标题前缀 T377-W- 是夹具身份（合格集正对照与收尾清场都按它认）。
// ————————————————————————————————————————————————————————————
const FIXTURE_PREFIX = 'T377-W-';

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
    return { count: s.count, placed: s.placed, overflow: s.overflow, anomalies: s.anomalies, anomalyDetail: s.anomalyDetail, current: s.current, available: s.available };
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
// 主流程
// ————————————————————————————————————————————————————————————
async function main() {
  const rep = new Report('377-agent-tiling-lifecycle');
  const fixtures = []; // { pid, hwnd } —— P9 收尾逐进程清场
  const tiles = []; // 成员窗（加入序——事件序列的唯一依据）
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
    // config 补丁（P9 三态还原）：功能开关开 + 清配对（首启用语义从本轮起算）+ 任务栏启用
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
    // 工单384：几何前置收紧——首个含 modePill 的帧可能早于 workspace/get-state 回执
    // （modeButtons 还是空数组），必须等到「两枚按钮且矩形非零」的帧（375 同口径）。
    const ready = await tape.wait('taskbar-geometry', (e) => e.modePill && e.modePill.w > 0
      && Array.isArray(e.modeButtons) && e.modeButtons.length === 2, { timeoutMs: 12000 });
    if (!ready) throw new Error('taskbar-geometry 存证缺失模式组矩形');
    const latestGeo = () => tape.latest('taskbar-geometry', (e) => e.modePill && e.modePill.w > 0
      && Array.isArray(e.modeButtons) && e.modeButtons.length === 2) || ready;
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
    rep.note(`平铺区期望：${rectStr(AREA)}（主屏 ${d.bounds.width}×${d.bounds.height} @${d.scaleFactor}x，条带顶=${taskbarTop}）`);

    const layoutFor = (n) => (n === 3 ? layout3(AREA) : n === 4 ? layout4(AREA) : n === 5 ? layout5(AREA) : layout6(AREA));
    const expectEntries = (layout) => tiles.map((h, i) => ({ hwnd: h, rect: layout[i] }));
    const spawnTile = async () => {
      fixtureSeq += 1;
      const s = await spawnFixture(`W${fixtureSeq}`);
      fixtures.push({ pid: s.pid, hwnd: s.hwnd });
      if (!s.hwnd) throw new Error(`夹具窗 T377-W-W${fixtureSeq} 未出现`);
      await sleep(250); // 窗出现 → 生产批处理（80ms 合并）起一拍
      tiles.push(s.hwnd);
      return s.hwnd;
    };

    // —— P1 一至三窗裂变 B（配对/切换 + 铺满/各半 + 三窗布局）——
    rep.beginSegment('P1');
    try {
      const ptA = modeButtonPoint376(latestGeo(), tbRect, scale, 'agent');
      if (!ptA) throw new Error('agent 模式按钮几何缺位');
      await convergeAt376(ptA, tbHwnd);
      win32.clickPhys(ptA.x, ptA.y, 'left');
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
        rep.note(`P1 注记：首次切换未在 4s 内确认（${JSON.stringify(conf)}），重试一次点击`);
        win32.clickPhys(ptA.x, ptA.y, 'left');
        conf = await waitDesktopCurrent376(com, agentId, 4000);
      }
      if (!conf.ok) throw new Error('切换 Agent 未确认');
      await spawnTile();
      const [left, right] = splitH377(AREA);
      const full = await waitAllRects([{ hwnd: tiles[0], rect: AREA }], 10000);
      await spawnTile();
      const halves = await waitAllRects([{ hwnd: tiles[0], rect: left }, { hwnd: tiles[1], rect: right }], 10000);
      await spawnTile();
      const settle = await waitAllRects(expectEntries(layout3(AREA)), 12000);
      const cap = await waitCapsuleCount(3);
      const st = await waitTilingState((x) => x.count === 3 && x.placed === 3);
      if (full.ok && halves.ok && settle.ok && cap.ok && st.ok) {
        rep.pass(`P1 一至三窗：首窗铺满 ${rectStr(AREA)}、两窗左右各半（${rectStr(left)} / ${rectStr(right)}）、三窗裂 B [${detailStr(settle.detail)}]（A 左半、B 右上、C 右下）；胶囊计数 3、count/placed=3`);
      } else {
        rep.fail(`P1 配对=${JSON.stringify(paired)} 切换=${JSON.stringify(conf)} 铺满=${JSON.stringify({ ok: full.ok, detail: detailStr(full.detail) })} 各半=${JSON.stringify({ ok: halves.ok, detail: detailStr(halves.detail) })} 三窗=${JSON.stringify({ ok: settle.ok, detail: detailStr(settle.detail) })} 计数=${JSON.stringify(cap)} 状态=${JSON.stringify(st.state)}`);
      }
    } catch (err) { rep.fail(`P1 异常: ${err.message}`); }

    // —— P2 四窗裂变 A ——
    rep.beginSegment('P2');
    try {
      if (tiles.length !== 3) throw new Error(`P1 未达三窗（当前 ${tiles.length}）`);
      await spawnTile();
      const settle = await waitAllRects(expectEntries(layout4(AREA)), 12000);
      const cap = await waitCapsuleCount(4);
      const st = await waitTilingState((x) => x.count === 4 && x.placed === 4);
      if (settle.ok && cap.ok && st.ok) {
        rep.pass(`P2 四窗裂 A：${detailStr(settle.detail)}（A/D 左列、B/C 右列，合计铺满）；计数 4、count/placed=4`);
      } else {
        rep.fail(`P2 布局=${JSON.stringify({ ok: settle.ok, detail: detailStr(settle.detail) })} 计数=${JSON.stringify(cap)} 状态=${JSON.stringify(st.state)}`);
      }
    } catch (err) { rep.fail(`P2 异常: ${err.message}`); }

    // —— P3 五窗再裂 B ——
    rep.beginSegment('P3');
    try {
      if (tiles.length !== 4) throw new Error(`P2 未达四窗（当前 ${tiles.length}）`);
      await spawnTile();
      const settle = await waitAllRects(expectEntries(layout5(AREA)), 12000);
      const cap = await waitCapsuleCount(5);
      const st = await waitTilingState((x) => x.count === 5 && x.placed === 5);
      if (settle.ok && cap.ok && st.ok) {
        rep.pass(`P3 五窗再裂 B：${detailStr(settle.detail)}（B 窗格横裂、其余窗格逐像素不动）；计数 5、count/placed=5`);
      } else {
        rep.fail(`P3 布局=${JSON.stringify({ ok: settle.ok, detail: detailStr(settle.detail) })} 计数=${JSON.stringify(cap)} 状态=${JSON.stringify(st.state)}`);
      }
    } catch (err) { rep.fail(`P3 异常: ${err.message}`); }

    // —— P4 六窗裂变 C + 清空后同序重放确定性 ——
    rep.beginSegment('P4');
    try {
      if (tiles.length !== 5) throw new Error(`P3 未达五窗（当前 ${tiles.length}）`);
      await spawnTile();
      const first = await waitAllRects(expectEntries(layout6(AREA)), 12000);
      const cap6 = await waitCapsuleCount(6);
      const st6 = await waitTilingState((x) => x.count === 6 && x.placed === 6);
      // 确定性重放：清空全部成员（逐窗 WM_CLOSE）→ 同序重建六窗 → 逐像素同布局
      for (const h of tiles) win32.PostMessageW(h, 0x0010, 0, 0);
      const empty = await waitTilingState((x) => x.count === 0 && x.placed === 0, 12000);
      tiles.length = 0;
      const replayStart = Date.now();
      for (let i = 0; i < 6; i++) await spawnTile();
      const replay = await waitAllRects(expectEntries(layout6(AREA)), 15000);
      const capReplay = await waitCapsuleCount(6);
      const replayMs = Date.now() - replayStart;
      if (first.ok && cap6.ok && st6.ok && empty.ok && replay.ok && capReplay.ok) {
        rep.pass(`P4 六窗与重放确定性：首建 ${detailStr(first.detail)}（窗 3 窗格裂 C——右下再横裂）；清空后同序重建六窗与首建逐像素相同（重放 ${replayMs}ms）；两轮计数=6`);
      } else {
        rep.fail(`P4 首建=${JSON.stringify({ ok: first.ok, detail: detailStr(first.detail) })} 计数=${JSON.stringify(cap6)} 清空=${JSON.stringify(empty)} 重放=${JSON.stringify({ ok: replay.ok, detail: detailStr(replay.detail) })} 重放计数=${JSON.stringify(capReplay)}`);
      }
    } catch (err) { rep.fail(`P4 异常: ${err.message}`); }

    // —— P5 最小化保留窗格与顺序（用户故事 19）——
    rep.beginSegment('P5');
    try {
      if (tiles.length !== 6) throw new Error(`P4 未达六窗（当前 ${tiles.length}）`);
      const l6 = layout6(AREA);
      const minIdx = 1;
      const others = tiles.map((h, i) => ({ hwnd: h, i })).filter((x) => x.i !== minIdx)
        .map((x) => ({ hwnd: x.hwnd, rect: l6[x.i] }));
      win32.ShowWindow(tiles[minIdx], 6); // SW_MINIMIZE
      await sleep(900);
      const held = await waitAllRects(others, 4000);
      const capMin = await readCapsuleCount();
      const stMin = await readTilingState();
      win32.ShowWindow(tiles[minIdx], 9); // SW_RESTORE
      const restored = await waitRectStable(tiles[minIdx], l6[minIdx], 500, 8000);
      if (held.ok && capMin === 6 && stMin && stMin.count === 6 && stMin.placed === 6 && restored.ok) {
        rep.pass(`P5 最小化保留：最小化成员 2 后其余五窗几何逐像素不动（${detailStr(held.detail)}）、计数保持 6、placed=6（窗格未丢）；还原回原格 ${rectStr(restored.rect)}`);
      } else {
        rep.fail(`P5 其余窗=${JSON.stringify({ ok: held.ok, detail: detailStr(held.detail) })} 计数=${capMin} 状态=${JSON.stringify(stMin)} 还原=${JSON.stringify(restored)} 期望=${rectStr(l6[minIdx])}`);
      }
    } catch (err) { rep.fail(`P5 异常: ${err.message}`); }

    // —— P6 关闭收缩由兄弟吸收（用户故事 20）——
    rep.beginSegment('P6');
    try {
      if (tiles.length !== 6) throw new Error(`P5 未达六窗（当前 ${tiles.length}）`);
      const l6 = layout6(AREA);
      const leftCol = splitH377(AREA)[0];
      win32.PostMessageW(tiles[3], 0x0010, 0, 0); // 关成员 4（左下格）
      const expect = new Map([[0, leftCol], [1, l6[1]], [2, l6[2]], [4, l6[4]], [5, l6[5]]]);
      const entries = tiles.filter((_, i) => i !== 3).map((h) => ({ hwnd: h, rect: expect.get(tiles.indexOf(h)) }));
      const settle = await waitAllRects(entries, 10000);
      const cap = await waitCapsuleCount(5);
      const st = await waitTilingState((x) => x.count === 5 && x.placed === 5);
      if (settle.ok && cap.ok && st.ok) {
        rep.pass(`P6 关闭兄弟吸收：关成员 4 后兄弟（成员 1）吸收整左列 ${rectStr(leftCol)}，其余四窗几何逐像素不动（${detailStr(settle.detail)}）；计数回落 5`);
      } else {
        rep.fail(`P6 布局=${JSON.stringify({ ok: settle.ok, detail: detailStr(settle.detail) })} 计数=${JSON.stringify(cap)} 状态=${JSON.stringify(st.state)}`);
      }
      tiles.splice(3, 1);
    } catch (err) { rep.fail(`P6 异常: ${err.message}`); }

    // —— P7 移出主屏由兄弟吸收、移回按最新窗口加入（用户故事 21）——
    rep.beginSegment('P7');
    try {
      if (tiles.length !== 5) throw new Error(`P6 未达五窗（当前 ${tiles.length}）`);
      const [leftCol, rightCol] = splitH377(AREA);
      const [rightTop, rightBottom] = splitV377(rightCol);
      const [rTopLeft, rTopRight] = splitH377(rightTop);
      const moved = tiles[4]; // 移出的是最新成员
      const movedOut = win32.SetWindowPos(moved, 0, AREA.right + 200, 120, 800, 600, win32.SWP_NOZORDER | win32.SWP_NOACTIVATE);
      const afterOut = await waitAllRects([
        { hwnd: tiles[0], rect: leftCol },
        { hwnd: tiles[1], rect: rTopLeft },
        { hwnd: tiles[2], rect: rightBottom },
        { hwnd: tiles[3], rect: rTopRight },
      ], 10000);
      const capOut = await waitCapsuleCount(4);
      const stOut = await waitTilingState((x) => x.count === 4);
      // 移回主屏：按最新窗口加入 → 裂变当前队首（成员 1 窗格上下对分）
      const movedBack = win32.SetWindowPos(moved, 0, 240, 240, 800, 600, win32.SWP_NOZORDER | win32.SWP_NOACTIVATE);
      const [lTop, lBottom] = splitV377(leftCol);
      const back = await waitAllRects([
        { hwnd: tiles[0], rect: lTop },
        { hwnd: tiles[1], rect: rTopLeft },
        { hwnd: tiles[2], rect: rightBottom },
        { hwnd: tiles[3], rect: rTopRight },
        { hwnd: tiles[4], rect: lBottom },
      ], 10000);
      const capBack = await waitCapsuleCount(5);
      if (movedOut && afterOut.ok && capOut.ok && stOut.ok && movedBack && back.ok && capBack.ok) {
        rep.pass(`P7 移出/移回主屏：移出最新成员后兄弟吸收整右下格 ${rectStr(rightBottom)}、其余三窗不动（${detailStr(afterOut.detail)}）、计数回落 4；移回后按最新窗口加入——队首成员 1 窗格上下对分（${rectStr(lTop)} / ${rectStr(lBottom)}），其余窗格不动（${detailStr(back.detail)}）、计数回到 5`);
      } else {
        rep.fail(`P7 移出=${movedOut} 移出后=${JSON.stringify({ ok: afterOut.ok, detail: detailStr(afterOut.detail) })} 计数=${JSON.stringify(capOut)} 状态=${JSON.stringify(stOut.state)} 移回=${movedBack} 移回后=${JSON.stringify({ ok: back.ok, detail: detailStr(back.detail) })} 计数=${JSON.stringify(capBack)}`);
      }
    } catch (err) { rep.fail(`P7 异常: ${err.message}`); }

    // —— P8 固定尺寸窗异常未平铺（用户故事 27 / spec 决策 12）——
    rep.beginSegment('P8');
    try {
      if (tiles.length !== 5) throw new Error(`P7 未达五窗（当前 ${tiles.length}）`);
      const before = tiles.map((h) => ({ hwnd: h, rect: win32.rectOf(h) }));
      const probe = await spawnFixedSizeWindow37x('T377-FIXED');
      fixtures.push({ pid: probe.pid, hwnd: probe.hwnd });
      if (!probe.hwnd) throw new Error('固定尺寸探针窗未出现');
      const frect0 = win32.rectOf(probe.hwnd);
      await sleep(1500);
      const frect1 = win32.rectOf(probe.hwnd);
      const held = await waitAllRects(before, 4000);
      const st = await waitTilingState((x) => x.count === 6 && x.anomalies === 1 && x.placed === 5);
      const cap = await waitCapsuleCount(6);
      await sleep(1000); // 静置：再确认无重试/无再写
      const frect2 = win32.rectOf(probe.hwnd);
      const st2 = await readTilingState();
      const sameRect = (a, b) => a && b && a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
      const fixedStill = sameRect(frect1, frect0) && sameRect(frect2, frect0);
      const kindOk = st2 && st2.anomalyDetail && st2.anomalyDetail.fixedSize === 1 && st2.anomalies === 1;
      if (held.ok && st.ok && cap.ok && fixedStill && kindOk && st2.placed === 5) {
        rep.pass(`P8 固定尺寸异常未平铺：探针窗（无 WS_THICKFRAME）矩形全程不动 ${rectStr(frect0)}（生产零写窗——若写会变）；其余五窗几何逐像素不动（${detailStr(held.detail)}）；计数仍含它（6）、placed=5、anomalies=1 且分类 fixedSize=1；静置 1s 无重试再写`);
      } else {
        rep.fail(`P8 其他窗=${JSON.stringify({ ok: held.ok, detail: detailStr(held.detail) })} 状态=${JSON.stringify(st.state)} 计数=${JSON.stringify(cap)} 探针矩形 初=${rectStr(frect0)} 后=${rectStr(frect1)} 再后=${rectStr(frect2)} 终态=${JSON.stringify(st2)}`);
      }
      win32.PostMessageW(probe.hwnd, 0x0010, 0, 0); // 关探针窗
      const back = await waitCapsuleCount(5);
      const stBack = await waitTilingState((x) => x.count === 5 && x.anomalies === 0);
      if (!back.ok || !stBack.ok) rep.fail(`P8 收尾：探针窗关闭后计数未回落（计数=${JSON.stringify(back)} 状态=${JSON.stringify(stBack.state)}）`);
    } catch (err) { rep.fail(`P8 异常: ${err.message}`); }

    rep.note(`正对照：面板 exe=${panelExePath}（胶囊/条带/面板自身不进计数）`);

    // —— P10 屏外滚动带与双向 fit（工单405，spec #403 用户故事 10-21）——
    // 本机 2560×1392 平铺区容量 32 扇（带空树满区），第 33 扇触发屏外滚动带——
    // 377 定案「溢出不设真机段」的代价顾虑由本票验收标准（带成员真机行为证据）承接：
    // 并行拉起把 28 扇夹具的墙钟压到 ~10s，代价与证据重新成比例（工单405 登记）。
    rep.beginSegment('P10');
    try {
      if (tiles.length !== 5) throw new Error(`P8 未达五窗（当前 ${tiles.length}）`);
      const REVEAL = Math.round(32 * (scale || 1));
      const AREA_W = AREA.right - AREA.left;
      const COL_W = Math.min(AREA_W, Math.max(Math.round(320 * (scale || 1)), Math.floor(AREA_W / 2)));
      // 并行拉起 28 扇夹具（5+28=33）→ 第 33 扇入带
      const spawnN = 28;
      const pend = [];
      for (let i = 0; i < spawnN; i++) {
        fixtureSeq += 1;
        const title = `${FIXTURE_PREFIX}W${fixtureSeq}`;
        const script = [
          'Add-Type -AssemblyName PresentationFramework',
          '$w = New-Object System.Windows.Window',
          `$w.Title = '${title}'`,
          '$w.Width = 700', '$w.Height = 500', '$w.Left = 160', '$w.Top = 120',
          '$w.ShowDialog() | Out-Null',
        ].join('; ');
        const proc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { stdio: 'ignore' });
        pend.push({ title, pid: proc.pid });
      }
      for (const p of pend) {
        const hwnd = await waitWindowByTitle(p.title, 25000);
        fixtures.push({ pid: p.pid, hwnd });
        if (!hwnd) throw new Error(`夹具窗 ${p.title} 未出现`);
        tiles.push(hwnd);
      }
      // 带触发：33 = 32 屏内 + 1 屏外带成员
      const stBand = await waitTilingState((x) => x.count === 33 && x.placed === 32 && x.overflow === 1, 15000);
      // 带成员识别：唯一左缘落在露边位（区右 − 32）的夹具窗
      const revealLeft = AREA.right - REVEAL;
      const bandHwnd = tiles.find((h) => Math.abs(win32.rectOf(h).left - revealLeft) <= 2) || 0;
      const bandExpect = { left: revealLeft, top: AREA.top, right: revealLeft + COL_W, bottom: AREA.bottom };
      const bandOk = !!bandHwnd && rectEq(win32.rectOf(bandHwnd), bandExpect);
      // 不再按原矩形覆盖（用户故事 10）：33 扇无一保持初始 700×500@(160,120)
      const SPAWN_RECT = { left: 160, top: 120, right: 860, bottom: 620 };
      const keptOriginal = tiles.filter((h) => rectEq(win32.rectOf(h), SPAWN_RECT));
      // 屏内 32 扇全部在缩窄区内（右缘 ≤ 区右 − 露边；树区让位露边，零重叠）
      const inScreenOk = tiles.filter((h) => h !== bandHwnd).every((h) => {
        const r = win32.rectOf(h);
        return r.right <= revealLeft + 2 && r.left >= AREA.left - 2 && r.top >= AREA.top - 2 && r.bottom <= AREA.bottom + 2;
      });
      if (!stBand.ok || !bandOk || keptOriginal.length > 0 || !inScreenOk) {
        rep.fail(`P10 带触发：状态=${JSON.stringify(stBand.state)} 带成员=${bandHwnd} 带矩形=${rectStr(bandHwnd ? win32.rectOf(bandHwnd) : null)}（期望 ${rectStr(bandExpect)}）保原矩形=${keptOriginal.length} 扇 屏内越界=${inScreenOk ? 0 : tiles.filter((h) => h !== bandHwnd && win32.rectOf(h).right > revealLeft + 2).length} 扇`);
      }
      // 露边点击（真鼠标输入，用户故事 15/16/17）→ 前台变化 → 整组最小滑动：
      // 带成员滑到贴右缘完整可见；屏内窗整组左移（部分推出左屏外）
      let fitIn = { ok: false };
      let slid = false;
      if (bandHwnd) {
        const px = AREA.right - Math.max(2, Math.round(REVEAL / 2));
        const py = AREA.top + 300;
        win32.clickPhys(px, py, 'left');
        fitIn = await waitRectStable(bandHwnd, { left: AREA.right - COL_W, top: AREA.top, right: AREA.right, bottom: AREA.bottom }, 500, 8000);
        slid = win32.rectOf(tiles[0]).left < AREA.left; // 成员 1（最左窗格）被整组滑动推出左屏外
      }
      // 反向（用户故事 18/19）：普通激活屏内窗 → 同一 fit 入口整组回位。
      // 激活源用 SetForegroundWindow——生产中任务栏激活/露边点击都表现为同一系统前台
      // 事件（EVENT_SYSTEM_FOREGROUND）汇入同一 fit；真鼠标面已由露边点击臂承证。
      let fitBack = { ok: false };
      let backIn = false;
      if (bandHwnd) {
        win32.SetForegroundWindow(tiles[0]);
        fitBack = await waitRectStable(bandHwnd, bandExpect, 500, 8000);
        backIn = win32.rectOf(tiles[0]).left >= AREA.left - 2;
      }
      // 验收标准 5：屏外成员计入顶部胶囊与窗口预览（真机证据——真面板桥 + 真成员集）
      const cap = await waitCapsuleCount(33);
      const pv = await cdpEval376(CAPSULE_TITLE, `(async () => {
        const t = await window.deck.bridge.invoke('preview/toggle', null);
        const s = await window.deck.bridge.invoke('preview/get-state', null);
        return { ok: !!(t && t.ok), n: s.items.length, hasBand: s.items.some((x) => x.hwnd === ${bandHwnd}) };
      })()`);
      await cdpEval376(CAPSULE_TITLE, `(async () => { await window.deck.bridge.invoke('preview/close', null); return true; })()`);
      // 空间释放按序补入 + 带收拢 + 视口回位（用户故事 4/28）：关 28 扇（保留带成员）
      // → 空位释放后带成员按进入序补入屏内、overflow=0
      for (let i = 5; i < tiles.length; i++) {
        if (tiles[i] === bandHwnd) continue; // 带成员保留——补入臂的被测物
        win32.PostMessageW(tiles[i], 0x0010, 0, 0);
      }
      const drain = await waitTilingState((x) => x.count === 6 && x.placed === 6 && x.overflow === 0, 15000);
      const drained = drain.ok && (() => {
        const r = win32.rectOf(bandHwnd);
        return r.left >= AREA.left - 2 && r.right <= AREA.right + 2 && r.top >= AREA.top - 2 && r.bottom <= AREA.bottom + 2;
      })();
      // P10 收尾：28 扇已自退；tiles 回到 P1-P8 口径（band 成员窗进程归 P9 taskkill 兜底）
      tiles.length = 5;
      if (stBand.ok && bandOk && keptOriginal.length === 0 && inScreenOk && fitIn.ok && slid && fitBack.ok && backIn && cap.ok && pv && pv.n === 33 && pv.hasBand && drain.ok && drained) {
        rep.pass(`P10 屏外滚动带与双向 fit：第 33 扇入带（列矩形 ${rectStr(bandExpect)} = 半屏宽 ${COL_W} × 全平铺高 × 露边 ${REVEAL}px 露在屏内右缘，32 扇屏内窗全部缩窄区内、无一保原矩形）；露边真点击 → 整组最小滑动（带成员贴右缘完整可见 ${rectStr(fitIn.rect)}、成员 1 推出左屏外 left=${win32.rectOf(tiles[0]).left}）；SetForeground 激活屏内窗 → 整组回位（带成员回露边位、成员 1 回屏内）；胶囊计数=33、预览 ${pv.n} 条含带成员；关 28 扇后带收拢补入（placed=6 overflow=0、带成员回屏内）`);
      } else {
        rep.fail(`P10 带触发=${JSON.stringify(stBand)} 带矩形 ok=${bandOk} 保原矩形=${keptOriginal.length} 屏内越界=${!inScreenOk} 滑入=${JSON.stringify(fitIn)} 整组左移=${slid} 滑回=${JSON.stringify(fitBack)} 回位=${backIn} 胶囊=${JSON.stringify(cap)} 预览=${JSON.stringify(pv)} 补入=${JSON.stringify(drain)} 收拢回屏内=${drained}`);
      }
    } catch (err) { rep.fail(`P10 异常: ${err.message}`); }
  } catch (err) {
    rep.fail(`电池异常: ${err && err.stack || err}`);
  } finally {
    // —— P9 收尾复原（零残留）——
    rep.beginSegment('P9');
    try {
      const com2 = bindVdCom376();
      const cfg = (() => { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return null; } })();
      const agentIdNow = cfg?.agentDesktop?.agentDesktopId || agentId || null;
      const normalIdNow = cfg?.agentDesktop?.normalDesktopId || normalId || null;
      const baseNow = regDesktopFacts();
      const extraNow = baseNow.ids.filter((x) => !base.ids.includes(x));
      rep.note(`P9 收尾起点：基线=${base.count} 当前集合=${baseNow.count} 本轮多余=${extraNow.length} 夹具窗=${fixtures.length}`);
      // 夹具窗逐进程清场（一窗一 powershell 进程——/T 连子树）
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
        } catch (e) { rep.note(`P9 RemoveDesktop 异常（热键兜底前记录）：${e.message}`); }
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
        rep.pass(`P9 零残留：注册表桌面集合与基线逐项相等（${f2.count} 桌面）、当前不在已删 Agent 桌面、夹具窗进程已清场`);
      } else {
        rep.fail(`P9 集合=${JSON.stringify(f2.ids.map((x) => x.slice(0, 8)))} 基线=${JSON.stringify(base.ids.map((x) => x.slice(0, 8)))} 当前=${f2.current}`);
      }
    } catch (err) { rep.fail(`P9 异常: ${err.message}`); }

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
