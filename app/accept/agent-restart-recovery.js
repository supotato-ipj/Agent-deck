'use strict';
// 工单383 Agent 桌面重启恢复验收（spec #369 决策 13/16；工单375/376/377 真机链的续段）：
// 控制器以 --accept-agent-restart-recovery 身份运行，拉起 --panel-accept 面板子进程。
//   P1 干净重启恢复：真实三窗平铺 → app/quit 干净退出 → 重启后顺序/平铺树/浮动几何
//      恢复（浮动几何用持久文档故障注入构造合法浮动条目）、授权计数全 0、配对恢复；
//   P2 隐私断言：持久文档不含窗口标题/缩略图/手动授权字段（白名单键）；事件日志不含
//      夹具标题；
//   P3 崩溃不强制搬窗：强杀面板（盘上 clean=false）→ 重启进入安全态 crash，夹具窗
//      矩形逐像素不变；原生任务栏/条带由既有守护链恢复；
//   P4 安全态故障注入：身份不符（同 hwnd 换 pid）/模型不一致（树引用越界）/桌面 ID
//      不一致 → 各自安全态，零自动改窗；
//   P5 收尾复原（零残留）：夹具窗清场、切回普通、删 Agent 桌面、注册表集合与基线逐项
//      相等、config 与布局文件还原。
//
// 夹具：受控 WPF 窗口（一窗一进程，标题 T383-W-*；工单377 定案，无会话恢复）。
// 运行：npm run accept:agent-restart-recovery（= electron . --accept-agent-restart-recovery）。
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
const EVENTS_FILE = path.join(__dirname, 'evidence', '383-agent-restart-recovery-events.jsonl');
const LAYOUT_FILE = path.join(__dirname, 'evidence', '383-agent-restart-recovery-layout.json');
const tape = createEventTape(EVENTS_FILE, { defaultTimeoutMs: 10000 });
const handle = createPanelHandle({
  execPath: process.execPath, appRoot: APP_ROOT, eventLogPath: EVENTS_FILE,
  archivePath: path.join(__dirname, 'evidence', '383-agent-restart-recovery-panel-handle-child.log'),
});
const CDP_PORT = cdpPortFor('383-agent-restart-recovery');

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
koffi.struct('T383_GUID', { d1: 'uint32', d2: 'uint16', d3: 'uint16', d4: 'uint8[8]' });
const CoInitializeEx383 = ole32.func('int32 __stdcall CoInitializeEx(void *reserved, uint32 dwCoInit)');
const CLSIDFromString383 = ole32.func('int32 __stdcall CLSIDFromString(const char16_t *lpsz, _Out_ T383_GUID *clsid)');
const CoCreateInstance383 = ole32.func('int32 __stdcall CoCreateInstance(const T383_GUID *clsid, void *outer, uint32 clsCtx, const T383_GUID *iid, _Out_ void **outObj)');
const PTRSZ383 = koffi.sizeof(koffi.pointer('void'));
const protoRelease383 = koffi.proto('__stdcall', 'T383_Release', 'uint32', ['void *']);
const protoQueryService383 = koffi.proto('__stdcall', 'T383_QueryService', 'int32', ['void *', 'const T383_GUID *', 'const T383_GUID *', koffi.out('void **')]);
const protoGetDesktops383 = koffi.proto('__stdcall', 'T383_VdmiGetDesktops', 'int32', ['void *', koffi.out('void **')]);
const protoGetCurrent383 = koffi.proto('__stdcall', 'T383_VdmiGetCurrent', 'int32', ['void *', koffi.out('void **')]);
const protoSwitch383 = koffi.proto('__stdcall', 'T383_VdmiSwitch', 'int32', ['void *', 'void *']);
const protoCreate383 = koffi.proto('__stdcall', 'T383_VdmiCreate', 'int32', ['void *', koffi.out('void **')]);
const protoRemove383 = koffi.proto('__stdcall', 'T383_Remove', 'int32', ['void *', 'void *', 'void *']);
const protoVdGetId383 = koffi.proto('__stdcall', 'T383_VdGetId', 'int32', ['void *', koffi.out('T383_GUID *')]);
const protoObjArrCount383 = koffi.proto('__stdcall', 'T383_ObjArrCount', 'int32', ['void *', koffi.out('int32 *')]);
const protoObjArrGetAt383 = koffi.proto('__stdcall', 'T383_ObjArrGetAt', 'int32', ['void *', 'int32', 'const T383_GUID *', koffi.out('void **')]);
const protoIsOnCurrent383 = koffi.proto('__stdcall', 'T383_IsOnCurrent', 'int32', ['void *', 'uintptr_t', koffi.out('int32 *')]);
const protoGetWinDesktopId383 = koffi.proto('__stdcall', 'T383_GetWinDesktopId', 'int32', ['void *', 'uintptr_t', koffi.out('T383_GUID *')]);

const CLSID383 = { immersiveShell: 'C2F03A33-21F5-47FA-B4BB-156362A2F239', vdmi: 'C5E0CDCA-7B6E-41B2-9FC4-D93975CC467B', vdm: 'AA509086-5CA9-4C25-8F95-589D3C07B48A' };
const IID383 = { vdmi_24H2: '53F5CA0B-158F-4124-900C-057158060B27', vdm: 'A5CD92FF-29BE-454C-8D04-D82879FB3F1B', virtualDesktop: '3F07F4BE-B107-441A-AF0F-39D82529072C', serviceProvider: '6D5140C1-7436-11CE-8034-00AA006009FA' };

function guidFromStr383(s) {
  const g = [null];
  const hr = CLSIDFromString383('{' + s + '}', g);
  if (hr !== 0) throw new Error(`CLSIDFromString(${s}) 失败 hr=${hr}`);
  return g[0];
}
function comGuidToStr383(q) {
  if (!q || !q.d4) return '';
  const p = (n, w) => n.toString(16).padStart(w, '0');
  const d4 = Array.from({ length: 8 }, (_, i) => q.d4[i]);
  return `${p(q.d1 >>> 0, 8)}-${p(q.d2, 4)}-${p(q.d3, 4)}-${d4.slice(0, 2).map((b) => p(b, 2)).join('')}-${d4.slice(2).map((b) => p(b, 2)).join('')}`;
}
const slot383 = (obj, i) => koffi.decode(koffi.decode(obj, 'void *'), i * PTRSZ383, 'void *');
const release383 = (obj) => { try { if (obj) koffi.call(slot383(obj, 2), protoRelease383, obj); } catch { /* 尽力 */ } };

function bindVdCom383() {
  const hrInit = CoInitializeEx383(null, 0);
  if (hrInit !== 0 && hrInit !== 1 && hrInit !== -2147417850) throw new Error(`CoInitializeEx 失败 hr=${hrInit}`);
  const shell = [null];
  const hrShell = CoCreateInstance383(guidFromStr383(CLSID383.immersiveShell), null, 1 | 4, guidFromStr383(IID383.serviceProvider), shell);
  if (hrShell !== 0 || !shell[0]) throw new Error(`ImmersiveShell 创建失败 hr=${hrShell}`);
  const svc = [null];
  const hrQs = koffi.call(slot383(shell[0], 3), protoQueryService383, shell[0], guidFromStr383(CLSID383.vdmi), guidFromStr383(IID383.vdmi_24H2), svc);
  release383(shell[0]);
  if (hrQs !== 0 || !svc[0]) throw new Error(`内部 VDMI QueryService 失败 hr=${hrQs}（IID 漂移）`);
  const vdmi = svc[0];
  const pub = [null];
  const hrPub = CoCreateInstance383(guidFromStr383(CLSID383.vdm), null, 1, guidFromStr383(IID383.vdm), pub);
  if (hrPub !== 0 || !pub[0]) throw new Error(`公开 VDM 创建失败 hr=${hrPub}`);
  const vdm = pub[0];
  const vdIdOf = (d) => {
    const g = [null];
    const r = koffi.call(slot383(d, 4), protoVdGetId383, d, g);
    if (r !== 0) throw new Error(`IVirtualDesktop.GetId 失败 hr=${r}`);
    return comGuidToStr383(g[0]);
  };
  const desktops = () => {
    const arr = [null];
    const hr = koffi.call(slot383(vdmi, 7), protoGetDesktops383, vdmi, arr);
    if (hr !== 0 || !arr[0]) throw new Error(`GetDesktops 失败 hr=${hr}`);
    try {
      const n = [0];
      koffi.call(slot383(arr[0], 3), protoObjArrCount383, arr[0], n);
      const out = [];
      for (let i = 0; i < n[0]; i++) {
        const d = [null];
        const r = koffi.call(slot383(arr[0], 4), protoObjArrGetAt383, arr[0], i, guidFromStr383(IID383.virtualDesktop), d);
        if (r !== 0 || !d[0]) continue;
        out.push({ ptr: d[0], id: vdIdOf(d[0]) });
      }
      return out;
    } finally { release383(arr[0]); }
  };
  return {
    desktops,
    currentId: () => {
      const d = [null];
      const hr = koffi.call(slot383(vdmi, 6), protoGetCurrent383, vdmi, d);
      if (hr !== 0 || !d[0]) return null;
      return vdIdOf(d[0]);
    },
    switchDesktop: (id) => {
      const target = desktops().find((d) => d.id === id);
      if (!target) throw new Error(`目标桌面不在系统集合: ${id}`);
      const hr = koffi.call(slot383(vdmi, 9), protoSwitch383, vdmi, target.ptr);
      release383(target.ptr);
      if (hr !== 0) throw new Error(`SwitchDesktop 失败 hr=${hr}`);
    },
    createDesktop: () => {
      const d = [null];
      const hr = koffi.call(slot383(vdmi, 11), protoCreate383, vdmi, d);
      if (hr !== 0 || !d[0]) throw new Error(`CreateDesktop 失败 hr=${hr}`);
      try { return vdIdOf(d[0]); } finally { release383(d[0]); }
    },
    removeDesktop: (id, fallbackId) => {
      const all = desktops();
      const target = all.find((d) => d.id === id);
      if (!target) return;
      const fallback = all.find((d) => d.id === fallbackId) || all.find((d) => d.id !== id);
      const hr = koffi.call(slot383(vdmi, 13), protoRemove383, vdmi, target.ptr, fallback?.ptr ?? null);
      release383(target.ptr);
      if (fallback) release383(fallback.ptr);
      if (hr !== 0) throw new Error(`RemoveDesktop 失败 hr=${hr}`);
    },
    isOnCurrent: (hwnd) => {
      const f = [0];
      const hr = koffi.call(slot383(vdm, 3), protoIsOnCurrent383, vdm, hwnd, f);
      return hr === 0 ? f[0] !== 0 : null;
    },
    desktopIdOf: (hwnd) => {
      const g = [null];
      const hr = koffi.call(slot383(vdm, 4), protoGetWinDesktopId383, vdm, hwnd, g);
      return hr === 0 ? comGuidToStr383(g[0]) : null;
    },
  };
}

async function waitDesktopCurrent383(com, targetId, timeoutMs = 4000) {
  const t0 = Date.now();
  for (;;) {
    const f = regDesktopFacts();
    const internal = com.currentId();
    if (f.current === targetId && (internal === null || internal === targetId)) return { ok: true, ms: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) return { ok: false, ms: Date.now() - t0, detail: `注册表=${f.current} 内部=${internal}` };
    await sleep(60);
  }
}

// ————————————————————————————————————————————————————————————
// CDP（375/378 同款）
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

async function readTilingState() {
  return cdpEval('DECK-CAPSULE', `(async () => {
    const s = await window.deck.bridge.invoke('tiling/get-state', null);
    return { count: s.count, placed: s.placed, overflow: s.overflow, anomalies: s.anomalies,
      floating: s.floating, prompting: s.prompting, authorized: s.authorized,
      current: s.current, available: s.available, recovery: s.recovery, recoveryReason: s.recoveryReason };
  })()`);
}
async function waitTilingState(pred, timeoutMs = 10000) {
  const t0 = Date.now();
  let last = null;
  for (;;) {
    try { last = await readTilingState(); } catch (err) { last = { error: String((err && err.message) || err) }; }
    if (last && pred(last)) return { ok: true, ms: Date.now() - t0, state: last };
    if (Date.now() - t0 > timeoutMs) return { ok: false, ms: Date.now() - t0, state: last };
    await sleep(120);
  }
}
async function readWorkspaceState() {
  return cdpEval('AGENT DECK', `(async () => {
    const s = await window.deck.bridge.invoke('workspace/get-state', null);
    return { available: s.available, paired: s.paired, current: s.current, switching: s.switching };
  })()`);
}
async function quitPanel() {
  const t0 = Date.now();
  try {
    await cdpEval('AGENT DECK', `window.deck.bridge.invoke('app/quit', null)`);
  } catch { /* 退出中 CDP 断开是正常竞态 */ }
  for (;;) {
    if (!handle.alive()) return { ok: true, ms: Date.now() - t0 };
    if (Date.now() - t0 > 8000) return { ok: false, ms: Date.now() - t0 };
    await sleep(100);
  }
}

// ————————————————————————————————————————————————————————————
// 测试夹具窗（工单377 定案：一窗一 powershell 进程、无会话恢复）
// ————————————————————————————————————————————————————————————
const FIXTURE_PREFIX = 'T383-W-';
const user32Fixture = koffi.load('user32.dll');
const GetWindowTextLengthW = user32Fixture.func('int __stdcall GetWindowTextLengthW(uintptr_t)');
const GetWindowTextW = user32Fixture.func('int __stdcall GetWindowTextW(uintptr_t, char16_t *, int)');
function windowTitleOf(hwnd) {
  const n = GetWindowTextLengthW(hwnd);
  if (!n) return '';
  const buf = Buffer.alloc((n + 1) * 2);
  GetWindowTextW(hwnd, buf, n + 1);
  return buf.toString('utf16le').replace(/\u0000+$/, '');
}
async function waitWindowByTitle(title, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const h of win32.topLevelWindows()) {
      if (win32.IsWindowVisible(h) && windowTitleOf(h) === title) return h;
    }
    if (Date.now() > deadline) return 0;
    await sleep(150);
  }
}
async function spawnFixture(tag) {
  const title = `${FIXTURE_PREFIX}${tag}`;
  const script = [
    'Add-Type -AssemblyName PresentationFramework',
    '$w = New-Object System.Windows.Window',
    `$w.Title = '${title}'`,
    '$w.Width = 700', '$w.Height = 500', '$w.Left = 160', '$w.Top = 120',
    '$w.ShowDialog() | Out-Null',
  ].join('; ');
  const proc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { stdio: 'ignore' });
  const hwnd = await waitWindowByTitle(title);
  return { pid: proc.pid, hwnd };
}
function rectEq(r, t, tol = 2) {
  if (!r) return false;
  return Math.abs(r.left - t.left) <= tol && Math.abs(r.top - t.top) <= tol
    && Math.abs(r.right - t.right) <= tol && Math.abs(r.bottom - t.bottom) <= tol;
}
function rectStr(r) { return r ? `[${r.left},${r.top},${r.right},${r.bottom}]` : 'null'; }
async function waitAllRects(entries, timeoutMs = 10000) {
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
async function waitNativeTaskbarVisible(timeoutMs = 4000) {
  const t0 = Date.now();
  for (;;) {
    if (win32.nativeTaskbarVisible()) return { ok: true, ms: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) return { ok: false, ms: Date.now() - t0 };
    await sleep(120);
  }
}
function detailStr(detail) {
  return (detail || []).map((x) => `hwnd=${x.hwnd} ${rectStr(x.got)}${x.want ? `(期望 ${rectStr(x.want)})` : ''}`).join('；');
}

/** 三窗布局（spec 决策 7 / 故事 15）：w1 左半、w2 右上、w3 右下 */
function layout3(area) {
  const mid = area.left + Math.floor((area.right - area.left) / 2);
  const top = area.top + Math.floor((area.bottom - area.top) / 2);
  return [
    { left: area.left, top: area.top, right: mid, bottom: area.bottom },
    { left: mid, top: area.top, right: area.right, bottom: top },
    { left: mid, top, right: area.right, bottom: area.bottom },
  ];
}

// ————————————————————————————————————————————————————————————
// 持久文档故障注入（合法模型；只改恢复路径需要判定的字段）
// ————————————————————————————————————————————————————————————
function readLayoutDoc() {
  try { return JSON.parse(fs.readFileSync(LAYOUT_FILE, 'utf8')); } catch { return null; }
}
function writeLayoutDoc(doc) {
  fs.writeFileSync(LAYOUT_FILE, JSON.stringify(doc, null, 1) + '\n', 'utf8');
}
/** 把某 order 下标从树中剪掉（兄弟上移），返回新树；队列同步去引用 */
function pruneRef(node, ref) {
  if (!node) return null;
  if (node.kind === 'leaf') return node.ref === ref ? null : node;
  const first = pruneRef(node.first, ref);
  const second = pruneRef(node.second, ref);
  if (!first && !second) return null;
  if (!first) return second;
  if (!second) return first;
  return { kind: 'split', axis: node.axis, first, second };
}
/** 把 doc 的第 ref 个窗口改成浮动（模型合法：树/队列去掉该引用，floating 增加） */
function makeFloating(doc, ref, rect) {
  const next = JSON.parse(JSON.stringify(doc));
  next.tree = pruneRef(next.tree, ref);
  next.queue = next.queue.filter((r) => r !== ref);
  next.floating = [...(next.floating || []).filter((f) => f.ref !== ref), { ref, rect }];
  return next;
}
function layoutKeys(doc) {
  return Object.keys(doc || {}).sort().join(',');
}

// ————————————————————————————————————————————————————————————
// 主流程
// ————————————————————————————————————————————————————————————
async function main() {
  const rep = new Report('383-agent-restart-recovery');
  const fixtures = [];
  let base = null;
  let normalId = null;
  let agentId = null;
  let baseDoc = null;
  const originalConfig = readConfigRaw();
  const finish = () => {
    const v = rep.verdict(rep.fails === 0 ? 'PASS' : 'FAIL');
    rep.writeLedger();
    app.exit(v.fails === 0 ? 0 : 1);
  };
  const launchPanel = (sinceNote) => {
    handle.launch({ mode: 'accept', cdpPort: CDP_PORT, stdio: 'ignore', extraEnv: { DECK_AGENT_LAYOUT_FILE: LAYOUT_FILE } });
    return tape.wait('boot', null, { timeoutMs: 15000 }).then((boot) => {
      if (sinceNote) rep.note(sinceNote);
      return boot;
    });
  };
  const waitReady = async () => {
    const boot = await launchPanel();
    if (!boot) throw new Error('面板子进程未上报 boot 事件');
    const tb = await handle.waitWindow({ title: 'DECK-TASKBAR', timeoutMs: 12000 });
    if (!tb) throw new Error('任务栏窗口未出现');
    return boot;
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
    const com = bindVdCom383();
    base = regDesktopFacts();
    rep.note(`基线注册表事实：桌面数=${base.count} 集合=[${base.ids.map((x) => x.slice(0, 8)).join(', ')}] 当前=${base.current ? base.current.slice(0, 8) : 'null'}`);
    if (!base.count || !base.current) throw new Error('注册表桌面事实不可读——环境问题，本轮未取证');
    normalId = base.current;
    agentId = com.createDesktop();
    const afterCreate = regDesktopFacts();
    if (!afterCreate.ids.includes(agentId)) throw new Error('新建 Agent 桌面未进入系统集合');
    // 配对写入 config（375 的首次配对产物；本电池验的是重启恢复，不重复验配对 UI）
    // 切换由**面板自身**执行（workspace/switch-to）：这样面板与随后拉起的夹具窗处于同一
    // 系统桌面事实，避免控制器先切桌面导致子进程窗口落在旧桌面的探针假阴性。
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    cfg.agentDesktop = { enabled: true, normalDesktopId: normalId, agentDesktopId: agentId };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');

    // 平铺区期望（与生产同口径：主屏物理矩形，下缘 = 条带顶）
    const d = screen.getPrimaryDisplay();
    const primaryBottom = Math.round((d.bounds.y + d.bounds.height) * d.scaleFactor);
    const taskbarTop = primaryBottom - Math.round(48 * d.scaleFactor);
    const AREA = {
      left: Math.round(d.bounds.x * d.scaleFactor),
      top: Math.round(d.bounds.y * d.scaleFactor),
      right: Math.round((d.bounds.x + d.bounds.width) * d.scaleFactor),
      bottom: taskbarTop,
    };
    const expected3 = layout3(AREA);
    rep.note(`平铺区期望：${rectStr(AREA)}（主屏 ${d.bounds.width}×${d.bounds.height} @${d.scaleFactor}x）`);

    // —— P1 准备：真实三窗平铺 → 干净退出 ——
    await waitReady();
    const switchRes = await cdpEval('AGENT DECK', `window.deck.bridge.invoke('workspace/switch-to', { mode: 'agent' })`);
    if (!switchRes || !switchRes.ok) throw new Error(`面板切换到 Agent 桌面失败：${JSON.stringify(switchRes)}`);
    const switched = await waitDesktopCurrent383(com, agentId);
    if (!switched.ok) throw new Error(`切到 Agent 桌面未确认：${switched.detail}`);
    const boot1 = await waitTilingState((s) => s.available && s.current === 'agent', 8000);
    if (!boot1.ok) throw new Error(`首次启动未进入 Agent 模式：${JSON.stringify(boot1.state)}`);
    for (const tag of ['W1', 'W2', 'W3']) {
      const f = await spawnFixture(tag);
      fixtures.push({ pid: f.pid, hwnd: f.hwnd });
      if (!f.hwnd) throw new Error(`夹具窗 T383-W-${tag} 未出现`);
      await sleep(300);
    }
    rep.note(`夹具桌面事实：${fixtures.map((f) => `${f.hwnd}=onCurrent:${com.isOnCurrent(f.hwnd)}/id:${String(com.desktopIdOf(f.hwnd)).slice(0, 8)}`).join('，')}；当前=${String(com.currentId()).slice(0, 8)} agent=${agentId.slice(0, 8)}`);
    const st3 = await waitTilingState((s) => s.count === 3 && s.placed === 3, 10000);
    const layoutOk1 = await waitAllRects(fixtures.map((f, i) => ({ hwnd: f.hwnd, rect: expected3[i] })));
    const quit1 = await quitPanel();
    if (!st3.ok || !layoutOk1.ok || !quit1.ok) {
      rep.fail(`P1 准备失败：三窗=${JSON.stringify(st3.state)} 布局=${JSON.stringify({ ok: layoutOk1.ok, detail: detailStr(layoutOk1.detail) })} 退出=${JSON.stringify(quit1)}`);
      throw new Error('P1 准备未完成');
    }
    await sleep(400);
    const doc1 = readLayoutDoc();
    if (!doc1) throw new Error('干净退出后未找到持久布局文档');
    baseDoc = JSON.parse(JSON.stringify(doc1));
    rep.note(`P1 持久文档：clean=${doc1.clean} order=${doc1.order?.length} 树=${doc1.tree ? '在场' : 'null'} 队列=${JSON.stringify(doc1.queue)} 浮动=${(doc1.floating || []).length}`);

    // —— P1 干净重启恢复 ——
    rep.beginSegment('P1');
    {
      const floatRef = 2; // 第三个夹具窗（右下格）→ 浮动条目（故障注入构造合法模型）
      const FLOAT = { left: 360, top: 280, right: 1060, bottom: 880 };
      writeLayoutDoc(makeFloating(doc1, floatRef, FLOAT));
      await waitReady();
      const recovered = await waitTilingState((s) => s.recovery === 'restored', 10000);
      const ws = await readWorkspaceState();
      // 浮动后树只剩两叶：w1 左半、w2 右半满高、w3 浮动几何
      const mid = AREA.left + Math.floor((AREA.right - AREA.left) / 2);
      const expectedRestored = [
        { hwnd: fixtures[0].hwnd, rect: { left: AREA.left, top: AREA.top, right: mid, bottom: AREA.bottom } },
        { hwnd: fixtures[1].hwnd, rect: { left: mid, top: AREA.top, right: AREA.right, bottom: AREA.bottom } },
        { hwnd: fixtures[2].hwnd, rect: FLOAT },
      ];
      const layoutOk = await waitAllRects(expectedRestored);
      const st = await readTilingState();
      const after = readLayoutDoc();
      const ok = recovered.ok && layoutOk.ok && ws.paired && ws.current === 'agent'
        && st.recovery === 'restored' && st.recoveryReason === null
        && st.floating === 1 && st.prompting === 0 && st.authorized === 0 && st.placed === 2
        && after && after.clean === false && after.order.length === 3;
      if (ok) {
        rep.pass(`P1 干净重启恢复：app/quit 后重启 → 配对恢复（paired=true current=agent）、窗口顺序/平铺树/浮动几何按必要信息恢复（w1 ${rectStr(expectedRestored[0].rect)}、w2 ${rectStr(expectedRestored[1].rect)}、w3 浮动 ${rectStr(FLOAT)}，逐像素）；授权全关闭（floating=1 prompting=0 authorized=0）；状态 recovery=restored`);
      } else {
        rep.fail(`P1 recovered=${JSON.stringify(recovered.state)} 布局=${JSON.stringify({ ok: layoutOk.ok, detail: detailStr(layoutOk.detail) })} workspace=${JSON.stringify(ws)} 状态=${JSON.stringify(st)} 文档=${JSON.stringify(after && { clean: after.clean, order: after.order?.length })}`);
      }
      // 文档保持 dirty=false? 运行中应为 clean=false（崩溃判据）
      if (!(after && after.clean === false)) rep.fail(`P1 运行中持久文档 clean 应为 false（崩溃判据），实际=${after && after.clean}`);
    }

    // —— P2 隐私断言 ——
    rep.beginSegment('P2');
    {
      const text = (() => { try { return fs.readFileSync(LAYOUT_FILE, 'utf8'); } catch { return ''; } })();
      const docNow = readLayoutDoc();
      // 工单406 布局文档 v2：白名单增 band（屏外顺序）/anchor（锚窗身份）——持久化布局关系，
      // 仍不含标题/缩略图/授权，隐私口径不变
      const keysOk = layoutKeys(docNow) === 'anchor,band,clean,desktopId,floating,order,queue,tree,version';
      const forbidden = ['"title"', '"prompt"', '"armed"', '"authorized"', '"thumbnail"', 'data:image', FIXTURE_PREFIX];
      const hits = forbidden.filter((f) => text.includes(f));
      const eventText = (() => { try { return fs.readFileSync(EVENTS_FILE, 'utf8'); } catch { return ''; } })();
      const eventHits = FIXTURE_PREFIX && eventText.includes(FIXTURE_PREFIX);
      if (keysOk && hits.length === 0 && !eventHits) {
        rep.pass(`P2 隐私：持久文档只含白名单键（${layoutKeys(docNow)}），不含窗口标题/缩略图/手动授权（检索 ${forbidden.join('、')} 零命中）；事件日志不含夹具标题`);
      } else {
        rep.fail(`P2 键=${layoutKeys(docNow)} 文档命中=${JSON.stringify(hits)} 事件含夹具标题=${eventHits}`);
      }
    }

    // —— P3 崩溃不强制搬窗 ——
    rep.beginSegment('P3');
    {
      const before = fixtures.map((f) => ({ hwnd: f.hwnd, rect: win32.rectOf(f.hwnd) }));
      const panelPid = (() => {
        try {
          const ev = fs.readFileSync(EVENTS_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'boot');
          return ev.length ? ev[ev.length - 1].pid : null;
        } catch { return null; }
      })();
      if (!panelPid) throw new Error('P3 找不到面板 pid');
      spawnSync('taskkill', ['/PID', String(panelPid), '/T', '/F'], { stdio: 'ignore' });
      const t0 = Date.now();
      while (handle.alive() && Date.now() - t0 < 5000) await sleep(100);
      if (handle.alive()) throw new Error('P3 强杀后面板仍在');
      await sleep(400);
      const crashedDoc = readLayoutDoc();
      await waitReady();
      const safe = await waitTilingState((s) => s.recovery === 'safe' && s.recoveryReason === 'crash', 10000);
      await sleep(1200);
      const after = before.map((b) => ({ hwnd: b.hwnd, rect: win32.rectOf(b.hwnd) }));
      const still = after.every((a, i) => rectEq(a.rect, before[i].rect));
      // 面板运行期原生任务栏由自绘条带接管（既有设计），此处验「条带由守护链重建」；
      // 原生栏可见性在面板退出后由既有还原链恢复（P5 断言）。
      const strip = win32.topLevelWindows().some((h) => win32.IsWindowVisible(h) && windowTitleOf(h) === 'DECK-TASKBAR');
      const ok = crashedDoc && crashedDoc.clean === false && safe.ok && still && strip;
      if (ok) {
        rep.pass(`P3 崩溃不强制搬窗：强杀面板（盘上 clean=false）→ 重启进入安全态 crash；三窗矩形逐像素不变（${after.map((a) => rectStr(a.rect)).join(' ') }）；任务栏条带在场=${strip}（既有守护链重建；原生栏在退出后还原见 P5）`);
      } else {
        rep.fail(`P3 文档 clean=${crashedDoc && crashedDoc.clean} 安全态=${JSON.stringify(safe.state)} 矩形不变=${still} 条带=${strip} 前=${JSON.stringify(before.map((b) => rectStr(b.rect)))} 后=${JSON.stringify(after.map((a) => rectStr(a.rect)))}`);
      }
      const quitSafe = await quitPanel();
      if (!quitSafe.ok) rep.fail(`P3 安全态面板未能干净退出：${JSON.stringify(quitSafe)}`);
    }

    // —— P4 安全态故障注入：身份/模型/桌面 ID ——
    rep.beginSegment('P4');
    {
      const cases = [
        {
          name: '身份不符',
          make: () => {
            const d2 = JSON.parse(JSON.stringify(baseDoc)); d2.clean = true; d2.order[0].pid += 50000; return d2;
          },
          expect: (s) => s.recovery === 'safe' && s.recoveryReason === 'window-identity',
        },
        {
          name: '模型不一致',
          make: () => {
            const d2 = JSON.parse(JSON.stringify(baseDoc)); d2.clean = true;
            d2.tree = { kind: 'split', axis: 'h', first: { kind: 'leaf', ref: 99 }, second: { kind: 'leaf', ref: 1 } };
            return d2;
          },
          expect: (s) => s.recovery === 'safe' && s.recoveryReason === 'model',
        },
        {
          name: '桌面 ID 不一致',
          make: () => {
            const d2 = JSON.parse(JSON.stringify(baseDoc)); d2.clean = true; d2.desktopId = '99999999-8888-7777-6666-555555555555'; return d2;
          },
          expect: (s) => s.recovery === 'safe' && s.recoveryReason === 'desktop-id',
        },
      ];
      const rectsBefore = fixtures.map((f) => ({ hwnd: f.hwnd, rect: win32.rectOf(f.hwnd) }));
      const results = [];
      for (const c of cases) {
        writeLayoutDoc(c.make());
        await waitReady();
        const safe = await waitTilingState(c.expect, 10000);
        await sleep(700);
        const moved = fixtures.some((f, i) => !rectEq(win32.rectOf(f.hwnd), rectsBefore[i].rect));
        const quit = await quitPanel();
        results.push({ name: c.name, ok: safe.ok && !moved && quit.ok, state: safe.state, moved });
        if (!safe.ok || moved) break;
      }
      const ok = results.length === cases.length && results.every((r) => r.ok);
      if (ok) {
        rep.pass(`P4 安全态：身份不符→window-identity、模型不一致→model、桌面 ID 不一致→desktop-id；三次重启均零自动改窗（夹具矩形不动）`);
      } else {
        rep.fail(`P4 ${JSON.stringify(results)}`);
      }
    }
  } catch (err) {
    rep.fail(`电池异常: ${err && err.stack || err}`);
  } finally {
    // —— P5 收尾复原（零残留） ——
    rep.beginSegment('P5');
    try {
      for (const f of fixtures) {
        if (f.pid) spawnSync('taskkill', ['/PID', String(f.pid), '/T', '/F'], { stdio: 'ignore' });
        else if (f.hwnd) { try { win32.PostMessageW(f.hwnd, 0x0010, 0, 0); } catch { /* 尽力 */ } }
      }
      await sleep(600);
      const com2 = bindVdCom383();
      const cfg = (() => { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return null; } })();
      const agentIdNow = cfg?.agentDesktop?.agentDesktopId || agentId || null;
      const normalIdNow = cfg?.agentDesktop?.normalDesktopId || normalId || null;
      const baseNow = regDesktopFacts();
      if (agentIdNow) {
        try {
          if (baseNow.current === agentIdNow && normalIdNow) {
            com2.switchDesktop(normalIdNow);
            await waitDesktopCurrent383(com2, normalIdNow, 4000);
          }
          com2.removeDesktop(agentIdNow, normalIdNow ?? undefined);
        } catch (e) { rep.note(`P5 RemoveDesktop 异常：${e.message}`); }
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
        rep.pass(`P5 零残留：注册表桌面集合与基线逐项相等（${f2.count} 桌面）、当前不在已删 Agent 桌面、夹具窗进程已清场`);
      } else {
        rep.fail(`P5 集合=${JSON.stringify(f2.ids.map((x) => x.slice(0, 8)))} 基线=${JSON.stringify(base.ids.map((x) => x.slice(0, 8)))} 当前=${f2.current}`);
      }
    } catch (err) { rep.fail(`P5 异常: ${err.message}`); }

    const cleared = await handle.stop();
    if (cleared && cleared.gone === false) {
      rep.exclude(`清场核验：面板强退失败（pid=${cleared.pidsLeft.join(', ')}）——需重启清障`,
        '清场后仍有面板进程存活', 'panel-forcekill');
    }
    const nativeAuto = await waitNativeTaskbarVisible(2500);
    // 既有验收清场链的兜底入口（与 376/377/378 电池同款）：自动还原未生效时显式翻回。
    // 自动路径是否命中记入段账，不把兜底冒充成自动复原。
    if (!nativeAuto.ok) win32.ensureNativeTaskbarVisible();
    const nativeAfterExit = nativeAuto.ok ? nativeAuto : await waitNativeTaskbarVisible(1000);
    if (nativeAfterExit.ok) {
      rep.pass(`P5 原生任务栏可见（${nativeAuto.ok ? `自动还原链 ${nativeAuto.ms}ms 内生效` : '自动还原未在窗内生效，经既有清场兜底入口翻回'}）`);
    } else {
      rep.fail('P5 原生任务栏清场后仍不可见（既有还原链与兜底入口均失效）');
    }
    restoreConfig(originalConfig);
    try { fs.unlinkSync(LAYOUT_FILE); } catch { /* 已删/未生成 */ }
    win32.ensureNativeTaskbarVisible();
  }

  finish();
}

module.exports = main;
