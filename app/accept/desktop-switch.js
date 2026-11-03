'use strict';
// 工单375 桌面工作区验收：真实双桌面切换最小闭环（spec #369 决策 2/4/17/29/30，
// ADR-0028；t371 探针 go 裁决后的生产实现段）。控制器以 --accept-desktop-switch
// 身份运行，拉起 --panel-accept 面板子进程，逐段验收：
//   P0 默认开放（工单384 发布门，spec #369 决策 24/29）：本轮 config **不写 agentDesktop
//      段**——整条链跑在产品默认上。断言默认值本身让功能在场：available=true/paired=false、
//      模式组两枚在渲染、未配对不高亮且入口可用、仅在场零桌面创建
//   P1 模式切换组在场：两枚互斥图标位于开始组右侧（taskbar-geometry 存证帧），未配对
//      态两枚均不高亮（第三桌面不高亮在 P6 验）；开关关闭整组不渲染由离线渲染层测试钉
//   P2 首次启用配对：点 Agent 图标 → 普通 = 启用当下所在桌面（既有窗口不动——合格
//      窗口桌面归属逐窗核对）、新建 Agent 桌面（注册表集合 +1）首次为空、配对落盘
//   P3 切换确认：只有系统目标桌面 ID 回读匹配才提交 UI（往返 ≤1s 预算）；高亮翻转
//   P4 单飞连点：在途期间第二击被忽略（回执 ok:false + 「在途」提示），无第二次提交
//   P5 跟随与排除：面板/条带窗在 Agent 桌面在场（IsOnCurrent + 未 shell cloak——
//      NOACTIVATE 弹窗原生跨桌面在场，t371 实证机制）；面板进程不进合格应用窗口集合
//   P6 reconciliation：系统侧切到非托管桌面（电池经系统事实源直切，与快捷键/TaskView
//      同一观察面）→ 模式组两枚均不高亮回推、**不抢回**；热键切回后高亮对齐系统事实
//   P7 新窗口归属：Agent 桌面启动的 csc WinForms 探针窗归属 Agent（工单380 夹具调整：
//      Win11 Store 记事本激活不再可靠落在活动桌面，P18 同款原生探针替代，断言不变）；
//      切回普通后该窗 shell cloak（桌面绑定）；普通桌面零改窗（本票无几何写入路径——离线
//      守卫 retract-orchestration.spec.ts 钉边界，ADR-0016 硬门的真机专段仍归 51 电池 P16）
//   P8 收尾复原（零残留）：切回普通、删除配对 Agent 桌面、注册表集合与基线逐项相等、
//      config 三态还原
//   P9 任务栏按桌面过滤与跨桌面点击（工单380，spec #369 决策 6/19）：运行图标按当前
//      桌面过滤（手钉共享在位 running=false、另一配对桌面专属应用不上普通栏、普通桌
//      面正对照）；点击仅另一桌面有窗的手钉应用 → 切过去激活（单窗不重复启动；多窗
//      切过去复用选窗菜单并精确到达）
// 运行：npm run accept:desktop-switch（= electron . --accept-desktop-switch）。
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
const EVENTS_FILE = path.join(__dirname, 'evidence', '375-desktop-switch-events.jsonl');
// 工单384：布局持久化（工单383）落在共享 userData——本电池不验重启恢复，布局文档
// 重定向到本电池证据目录并在起止清掉（前置 = 恢复态 none，不继承他轮的 crash/桌面 ID 标记）。
const LAYOUT_FILE = path.join(__dirname, 'evidence', '375-desktop-switch-layout.json');
const tape = createEventTape(EVENTS_FILE, { defaultTimeoutMs: 8000 });
const handle = createPanelHandle({
  execPath: process.execPath, appRoot: APP_ROOT, eventLogPath: EVENTS_FILE,
  archivePath: path.join(__dirname, 'evidence', '375-desktop-switch-panel-handle-child.log'),
});
const CDP_PORT = cdpPortFor('375-desktop-switch');
const TASKBAR_TITLE = 'DECK-TASKBAR';
const PANEL_TITLE = 'AGENT DECK';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const koffi = win32.koffi;
koffi.load('user32.dll');

// ————————————————————————————————————————————————————————————
// 系统事实源（t371 探针同款：注册表单查询原子读 + COM 双源；桌面身份一律系统 ID）
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
  // 原子读（t371 教训：分两次查询会撞 explorer 中途更新产生错配快照）
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

/** DWM cloak 原始分位（win32.isCloaked 只回布尔；SHELL 分位 2 = 其他虚拟桌面） */
const dwmapi375 = koffi.load('dwmapi.dll');
const DwmGetWindowAttribute375 = dwmapi375.func('int32 __stdcall DwmGetWindowAttribute(uintptr_t hwnd, uint32 attr, void *pv, uint32 cb)');
function cloakValue375(hwnd) {
  const buf = Buffer.alloc(4);
  if (DwmGetWindowAttribute375(Number(hwnd), 14, buf, 4) !== 0) return -1;
  return buf.readUInt32LE(0);
}

const ole32 = koffi.load('ole32.dll');
koffi.struct('T375_GUID', { d1: 'uint32', d2: 'uint16', d3: 'uint16', d4: 'uint8[8]' });
const CoInitializeEx375 = ole32.func('int32 __stdcall CoInitializeEx(void *reserved, uint32 dwCoInit)');
const CLSIDFromString375 = ole32.func('int32 __stdcall CLSIDFromString(const char16_t *lpsz, _Out_ T375_GUID *clsid)');
const CoCreateInstance375 = ole32.func('int32 __stdcall CoCreateInstance(const T375_GUID *clsid, void *outer, uint32 clsCtx, const T375_GUID *iid, _Out_ void **outObj)');
const PTRSZ375 = koffi.sizeof(koffi.pointer('void'));
const protoRelease375 = koffi.proto('__stdcall', 'T375_Release', 'uint32', ['void *']);
const protoQueryService375 = koffi.proto('__stdcall', 'T375_QueryService', 'int32', ['void *', 'const T375_GUID *', 'const T375_GUID *', koffi.out('void **')]);
const protoGetDesktops375 = koffi.proto('__stdcall', 'T375_VdmiGetDesktops', 'int32', ['void *', koffi.out('void **')]);
const protoGetCurrent375 = koffi.proto('__stdcall', 'T375_VdmiGetCurrent', 'int32', ['void *', koffi.out('void **')]);
const protoSwitch375 = koffi.proto('__stdcall', 'T375_VdmiSwitch', 'int32', ['void *', 'void *']);
const protoCreate375 = koffi.proto('__stdcall', 'T375_VdmiCreate', 'int32', ['void *', koffi.out('void **')]);
const protoRemove375 = koffi.proto('__stdcall', 'T375_VdmiRemove', 'int32', ['void *', 'void *', 'void *']);
const protoVdGetId375 = koffi.proto('__stdcall', 'T375_VdGetId', 'int32', ['void *', koffi.out('T375_GUID *')]);
const protoObjArrCount375 = koffi.proto('__stdcall', 'T375_ObjArrCount', 'int32', ['void *', koffi.out('int32 *')]);
const protoObjArrGetAt375 = koffi.proto('__stdcall', 'T375_ObjArrGetAt', 'int32', ['void *', 'int32', 'const T375_GUID *', koffi.out('void **')]);
const protoIsOnCurrent375 = koffi.proto('__stdcall', 'T375_IsOnCurrent', 'int32', ['void *', 'uintptr_t', koffi.out('int32 *')]);
const protoGetWinDesktopId375 = koffi.proto('__stdcall', 'T375_GetWinDesktopId', 'int32', ['void *', 'uintptr_t', koffi.out('T375_GUID *')]);
const protoMoveWindow375 = koffi.proto('__stdcall', 'T375_MoveWindowToDesktop', 'int32', ['void *', 'uintptr_t', 'const T375_GUID *']);

const CLSID375 = { immersiveShell: 'C2F03A33-21F5-47FA-B4BB-156362A2F239', vdmi: 'C5E0CDCA-7B6E-41B2-9FC4-D93975CC467B', vdm: 'AA509086-5CA9-4C25-8F95-589D3C07B48A' };
const IID375 = { vdmi_24H2: '53F5CA0B-158F-4124-900C-057158060B27', vdm: 'A5CD92FF-29BE-454C-8D04-D82879FB3F1B', virtualDesktop: '3F07F4BE-B107-441A-AF0F-39D82529072C', serviceProvider: '6D5140C1-7436-11CE-8034-00AA006009FA' };

function guidFromStr375(s) {
  const g = [null];
  const hr = CLSIDFromString375('{' + s + '}', g);
  if (hr !== 0) throw new Error(`CLSIDFromString(${s}) 失败 hr=${hr}`);
  return g[0];
}
function comGuidToStr375(q) {
  if (!q || !q.d4) return '';
  const p = (n, w) => n.toString(16).padStart(w, '0');
  const d4 = Array.from({ length: 8 }, (_, i) => q.d4[i]);
  return `${p(q.d1 >>> 0, 8)}-${p(q.d2, 4)}-${p(q.d3, 4)}-${d4.slice(0, 2).map((b) => p(b, 2)).join('')}-${d4.slice(2).map((b) => p(b, 2)).join('')}`;
}
const slot375 = (obj, i) => koffi.decode(koffi.decode(obj, 'void *'), i * PTRSZ375, 'void *');
const release375 = (obj) => { try { if (obj) koffi.call(slot375(obj, 2), protoRelease375, obj); } catch { /* 尽力 */ } };

/** COM 桥（t371 实证形态：ImmersiveShell 直接以 IID_IServiceProvider 创建再 QueryService） */
function bindVdCom375() {
  const hrInit = CoInitializeEx375(null, 0);
  if (hrInit !== 0 && hrInit !== 1 && hrInit !== -2147417850) throw new Error(`CoInitializeEx 失败 hr=${hrInit}`);
  const shell = [null];
  const hrShell = CoCreateInstance375(guidFromStr375(CLSID375.immersiveShell), null, 1 | 4, guidFromStr375(IID375.serviceProvider), shell);
  if (hrShell !== 0 || !shell[0]) throw new Error(`ImmersiveShell 创建失败 hr=${hrShell}`);
  const svc = [null];
  const hrQs = koffi.call(slot375(shell[0], 3), protoQueryService375, shell[0], guidFromStr375(CLSID375.vdmi), guidFromStr375(IID375.vdmi_24H2), svc);
  const pub = [null];
  const hrPub = CoCreateInstance375(guidFromStr375(CLSID375.vdm), null, 1, guidFromStr375(IID375.vdm), pub);
  release375(shell[0]);
  if (hrQs !== 0 || !svc[0]) throw new Error(`内部 VDMI QueryService 失败 hr=${hrQs}（IID 漂移）`);
  if (hrPub !== 0 || !pub[0]) throw new Error(`公开 VDM 创建失败 hr=${hrPub}`);
  const vdmi = svc[0];
  const vdm = pub[0];
  const vdIdOf = (d) => {
    const g = [null];
    const r = koffi.call(slot375(d, 4), protoVdGetId375, d, g);
    if (r !== 0) throw new Error(`IVirtualDesktop.GetId 失败 hr=${r}`);
    return comGuidToStr375(g[0]);
  };
  const desktops = () => {
    const arr = [null];
    const hr = koffi.call(slot375(vdmi, 7), protoGetDesktops375, vdmi, arr);
    if (hr !== 0 || !arr[0]) throw new Error(`GetDesktops 失败 hr=${hr}`);
    try {
      const n = [0];
      koffi.call(slot375(arr[0], 3), protoObjArrCount375, arr[0], n);
      const out = [];
      for (let i = 0; i < n[0]; i++) {
        const d = [null];
        const r = koffi.call(slot375(arr[0], 4), protoObjArrGetAt375, arr[0], i, guidFromStr375(IID375.virtualDesktop), d);
        if (r !== 0 || !d[0]) continue;
        out.push({ ptr: d[0], id: vdIdOf(d[0]) });
      }
      return out;
    } finally { release375(arr[0]); }
  };
  return {
    desktops,
    currentId: () => {
      const d = [null];
      const hr = koffi.call(slot375(vdmi, 6), protoGetCurrent375, vdmi, d);
      if (hr !== 0 || !d[0]) return null;
      return vdIdOf(d[0]);
    },
    switchDesktop: (id) => {
      const target = desktops().find((d) => d.id === id);
      if (!target) throw new Error(`目标桌面不在系统集合: ${id}`);
      const hr = koffi.call(slot375(vdmi, 9), protoSwitch375, vdmi, target.ptr);
      release375(target.ptr);
      if (hr !== 0) throw new Error(`SwitchDesktop 失败 hr=${hr}`);
    },
    createDesktop: () => {
      const d = [null];
      const hr = koffi.call(slot375(vdmi, 11), protoCreate375, vdmi, d);
      if (hr !== 0 || !d[0]) throw new Error(`CreateDesktop 失败 hr=${hr}`);
      try { return vdIdOf(d[0]); } finally { release375(d[0]); }
    },
    removeDesktop: (id, fallbackId) => {
      const all = desktops();
      const target = all.find((d) => d.id === id);
      if (!target) return; // 已不在集合 = 无残留（幂等）
      const fallback = all.find((d) => d.id === fallbackId) || all.find((d) => d.id !== id);
      const hr = koffi.call(slot375(vdmi, 13), protoRemove375, vdmi, target.ptr, fallback?.ptr ?? null);
      release375(target.ptr);
      if (fallback) release375(fallback.ptr);
      if (hr !== 0) throw new Error(`RemoveDesktop 失败 hr=${hr}`);
    },
    isOnCurrent: (hwnd) => {
      const f = [0];
      const hr = koffi.call(slot375(vdm, 3), protoIsOnCurrent375, vdm, hwnd, f);
      return hr === 0 ? f[0] !== 0 : null;
    },
    desktopIdOf: (hwnd) => {
      const g = [null];
      const hr = koffi.call(slot375(vdm, 4), protoGetWinDesktopId375, vdm, hwnd, g);
      return hr === 0 ? comGuidToStr375(g[0]) : null;
    },
    /** 系统 TaskView 同款搬家（公开 MoveWindowToDesktop）：仅测试夹具摆位用，P7 归属断言不调用 */
    moveWindowToDesktop: (hwnd, id) => {
      const hr = koffi.call(slot375(vdm, 5), protoMoveWindow375, vdm, hwnd, guidFromStr375(id));
      return hr === 0;
    },
  };
}

/** 合格应用窗口集合（win-facts.ts 投影同口径最小谓词；自家进程排除 = 不参与窗口计数
 *  的生产语义——shouldShowOnTaskbar 按 exe 归一身份排除自家，面板/条带与控制器共享
 *  electron exe，故按 exe 集排除而非 pid：传 ownExes = [面板 exe]（控制器自身窗口再按
 *  pid 排除兜底）。 */
const DWM_CLOAKED_SHELL375 = 0x2;
/** exe 归一（shouldShowOnTaskbar.normalizeExe 同款口径：斜杠归一 + 小写比较） */
function normalizeExePath(x) {
  return String(x).split('/').join('\\').toLowerCase();
}
function qualifiedAppWindows375(ownExes) {
  const myPid = process.pid;
  const excludedExe = new Set((ownExes || []).map((x) => normalizeExePath(x)));
  const WS_EX_TOOLWINDOW = 0x80, WS_EX_APPWINDOW = 0x40000;
  const out = [];
  for (const h of win32.topLevelWindows()) {
    const ex = Number(win32.GetWindowLongW(h, -20)) | 0;
    if (ex & WS_EX_TOOLWINDOW) continue;
    if (ex & WS_EX_APPWINDOW) continue;
    if (!win32.IsWindowVisible(h)) continue;
    if (cloakValue375(h) === DWM_CLOAKED_SHELL375) continue;
    if (Number(win32.GetWindowLongW(h, -8 /* GWL_HWNDPARENT */)) !== 0) continue;
    const pid = win32.threadIdOf(h).pid;
    if (pid === myPid) continue; // 控制器进程排除（探针工具自身兜底）
    const exePath = normalizeExePath(win32.exeOfPid(pid) || '');
    if (exePath && excludedExe.has(exePath)) continue; // 面板进程排除（生产 ownExe 同款语义）
    out.push({ hwnd: h, pid });
  }
  return out;
}

// ————————————————————————————————————————————————————————————
// CDP 与点击（55 电池同款纪律：几何存证帧取坐标 + converge 收敛 + WindowFromPoint 复核）
// ————————————————————————————————————————————————————————————
async function cdpEval375(pageTitle, expression) {
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

async function convergeAt375(pt, tbHwnd) {
  win32.moveMousePhys(pt.x, pt.y);
  for (let i = 0; i < 32; i++) {
    await sleep(250);
    if (win32.windowFromPointRoot(pt) === tbHwnd) return true;
  }
  return false;
}

/** 等系统当前桌面 = 目标 ID（注册表 + 内部 COM 双源回读，t371 判定口径） */
async function waitDesktopCurrent375(com, targetId, timeoutMs = 3000) {
  const t0 = Date.now();
  for (;;) {
    const f = regDesktopFacts();
    const internal = com.currentId();
    if (f.current === targetId && (internal === null || internal === targetId)) {
      return { ok: true, ms: Date.now() - t0, detail: `注册表=${f.current.slice(0, 8)}… 内部=${internal ? internal.slice(0, 8) + '…' : 'null'}` };
    }
    if (Date.now() - t0 > timeoutMs) return { ok: false, ms: Date.now() - t0, detail: `注册表=${f.current} 内部=${internal}` };
    await sleep(60);
  }
}

/** 模式按钮几何（taskbar-geometry 存证帧 → 屏幕物理坐标） */
function modeButtonPoint375(geo, tbRect, scale, id) {
  const btn = (geo.modeButtons || []).find((b) => b.id === id);
  if (!btn) return null;
  return {
    x: Math.round(tbRect.left + (btn.x + btn.w / 2) * scale),
    y: Math.round(tbRect.top + (btn.y + btn.h / 2) * scale),
  };
}

// —— 工单380 探针窗（P7 新窗归属与 P9 任务栏跨桌面夹具）——
// 选型沿 P18 结论（app/accept/taskbar.js）：Win11 Store 记事本的激活走存根/Store 宿主，
// 新窗不再可靠落在「打开时所在桌面」（本轮实测落在调用方桌面），窗口身份/桌面归属都不可
// 作为系统语义证据；csc 现编译 WinForms 最小窗是按当前活动桌面创建的原生 Win32 窗。
const PROBE380_CS = `
using System;
using System.Drawing;
using System.Windows.Forms;
static class Probe {
  [STAThread]
  static void Main() {
    string img = AppDomain.CurrentDomain.FriendlyName;
    Form f = new Form();
    f.Text = img + " deck380 probe";
    f.StartPosition = FormStartPosition.Manual;
    f.Bounds = new Rectangle(120, 120, 320, 180);
    Application.Run(f);
  }
}
`;
function seedProbe380(rep, tag) {
  try {
    const sysRoot = process.env.SystemRoot || 'C:\\Windows';
    const csc = path.join(sysRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    if (!fs.existsSync(csc)) {
      rep.note('工单380 探针前置失败：csc.exe 缺失（.NET Framework4.x）');
      return null;
    }
    const tmpDir = fs.mkdtempSync(path.join(fs.realpathSync.native(require('os').tmpdir()), 'deck-t380-'));
    const csFile = path.join(tmpDir, 'probe.cs');
    fs.writeFileSync(csFile, PROBE380_CS, 'utf8');
    const exe = path.join(tmpDir, `DECK-${tag}.exe`);
    const built = spawnSync(csc, ['/nologo', '/target:winexe', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
      `/out:${exe}`, csFile], { encoding: 'utf8' });
    if (built.status !== 0 || !fs.existsSync(exe)) {
      rep.note(`工单380 探针编译失败：status=${built.status} ${(built.stderr || '').trim().slice(0, 200)}`);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 尽力 */ }
      return null;
    }
    return { tmpDir, exe, img: path.basename(exe) };
  } catch (err) {
    rep.note(`工单380 探针种入失败: ${err && err.message}`);
    return null;
  }
}
/** 同源码副本 → 唯一镜像名（各自独立 exe 身份，供「Agent 专属/普通桌面正对照」两枚夹具） */
function copyProbe380(probe, tag) {
  const exe = path.join(probe.tmpDir, `DECK-${tag}.exe`);
  fs.copyFileSync(probe.exe, exe);
  return { tmpDir: probe.tmpDir, exe, img: path.basename(exe) };
}

/** 按 exe 路径找可见顶层窗（探针窗身份唯一，无需标题判据） */
function probeWindows380(exe) {
  const target = normalizeExePath(exe);
  const out = [];
  for (const h of win32.topLevelWindows()) {
    if (!win32.IsWindowVisible(h)) continue;
    const wExe = normalizeExePath(win32.exeOfPid(win32.threadIdOf(h).pid) || '');
    if (wExe === target) out.push(h);
  }
  return out;
}
function probeWindow380(exe) {
  return probeWindows380(exe)[0] || 0;
}
async function waitProbeWindow380(exe, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const h = probeWindow380(exe);
    if (h) return h;
    await sleep(120);
  }
  return 0;
}

async function main() {
  const rep = new Report('375-desktop-switch');
  let probeChildren = [];
  let lastProbeHwnd = 0;
  let probe7 = null; // 工单380 新窗归属/P9 夹具的 WinForms 探针（P7 编译一次）
  let probe7Exe = null;
  let base = null; // 启动期注册表基线（P1-P7 采集、P8 finally 零残留断言共用）
  let normalId = null; // 普通 = 启用时所在桌面（系统 ID）
  const originalConfig = readConfigRaw();
  const finish = () => {
    const v = rep.verdict(rep.fails === 0 ? 'PASS' : 'FAIL');
    rep.writeLedger();
    app.exit(v.fails === 0 ? 0 : 1);
  };

  try {
    fs.writeFileSync(EVENTS_FILE, '', 'utf8');
    try { fs.unlinkSync(LAYOUT_FILE); } catch { /* 无旧布局 */ }
    // config 补丁（三态还原见 finally）：**不写 agentDesktop 段**（工单384 发布门：整条
    // 链跑在产品默认上——默认开放、未配对；默认值拿不到时 P0 立判）+ 任务栏启用（模式组宿主）
    {
      const json = originalConfig !== null ? JSON.parse(originalConfig) : {};
      delete json.agentDesktop;
      json.taskbar = { ...(json.taskbar ?? {}), enabled: true };
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(json, null, 2) + '\n', 'utf8');
    }
    const com = bindVdCom375();
    base = regDesktopFacts();
    rep.note(`基线注册表事实：桌面数=${base.count} 集合=[${base.ids.map((x) => x.slice(0, 8)).join(', ')}] 当前=${base.current ? base.current.slice(0, 8) : 'null'}`);
    if (!base.count || !base.current) throw new Error('注册表桌面事实不可读——环境问题，本轮未取证');
    normalId = base.current;

    // —— 拉起面板子进程（产品默认：功能开关未显式写——见 P0）——
    handle.launch({ mode: 'accept', cdpPort: CDP_PORT, stdio: 'ignore', extraEnv: { DECK_AGENT_LAYOUT_FILE: LAYOUT_FILE } });
    const boot = await tape.wait('boot', null, { timeoutMs: 15000 });
    if (!boot) throw new Error('面板子进程未上报 boot 事件');
    rep.note(`面板 pid=${boot.pid}`);
    const tbHwnd = await handle.waitWindow({ title: TASKBAR_TITLE, timeoutMs: 12000 });
    if (!tbHwnd) throw new Error('任务栏窗口未出现');
    const tbRect = win32.rectOf(tbHwnd);
    const dip = screen.getPrimaryDisplay().bounds;
    const scale = (tbRect.right - tbRect.left) / dip.width;

    // —— P0 默认开放（工单384 发布门，spec #369 决策 29/24）——
    // 本轮 config 无 agentDesktop 段：产品默认路径（不写开关、不写配对）。断言默认值本身
    // 让功能在场：workspace available=true / paired=false、模式组按默认渲染两枚入口、
    // 未配对两枚均不高亮而不禁用、仅在场不建桌面（配对动作仍归首次切换请求——P2）。
    // 模式组几何帧是 P1..P9 的共同前提，故 P0 同时持有该等待（超时即默认开放未成立）。
    rep.beginSegment('P0');
    let ready = null;
    try {
      ready = await tape.wait('taskbar-geometry', (e) => e.modePill && e.modePill.w > 0
        && Array.isArray(e.modeButtons) && e.modeButtons.length === 2, { timeoutMs: 12000 });
      const cfgRaw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      const noSection = cfgRaw.agentDesktop === undefined;
      const ws = await cdpEval375(TASKBAR_TITLE, `window.deck.bridge.invoke('workspace/get-state', null)`);
      const defaultOpen = Boolean(ws) && ws.available === true && ws.paired === false;
      const idsOk = Boolean(ready) && ready.modeButtons.map((b) => b.id).join(',') === 'normal,agent';
      const cls = ready ? await cdpEval375(TASKBAR_TITLE, MODE_CLASS_EXPR) : [];
      const noneActive = cls.length === 2 && cls.every((e) => !e.active && !e.disabled);
      const f0 = regDesktopFacts();
      const noCreate = f0.count === base.count && base.ids.every((x) => f0.ids.includes(x));
      if (noSection && defaultOpen && idsOk && noneActive && noCreate) {
        rep.pass(`P0 默认开放：config 无 agentDesktop 段 → available=true/paired=false（默认值成立）、模式组两枚在渲染（normal,agent）、未配对不高亮且入口可用、仅在场零桌面创建（${f0.count} 桌面与基线逐项相等）`);
      } else {
        rep.fail(`P0 无段=${noSection} 状态=${JSON.stringify(ws)} 按钮=${idsOk} 高亮=${JSON.stringify(cls)} 桌面=${f0.count}/${base.count} 帧=${Boolean(ready)}`);
      }
    } catch (err) { rep.fail(`P0 异常: ${err.message}`); }
    if (!ready) throw new Error('默认开放未成立：taskbar-geometry 缺模式组矩形（模式组未渲染或几何帧未到——见 P0）');
    const latestGeo = () => tape.latest('taskbar-geometry', (e) => e.modePill && e.modePill.w > 0
      && Array.isArray(e.modeButtons) && e.modeButtons.length === 2) || ready;
    // 面板 exe 身份（合格窗口排除的「自家」= 生产 ownExe 同源——shouldShowOnTaskbar 按它排除）
    const panelExePath = String(win32.exeOfPid(win32.threadIdOf(tbHwnd).pid) || '');
    if (!panelExePath) throw new Error('面板 exe 身份不可读——合格窗口排除无从谈起');

    // —— P1 模式切换组在场（开始组右侧、互斥两枚、未配对不高亮）——
    rep.beginSegment('P1');
    try {
      const geo = latestGeo();
      const startRight = geo.startPill ? geo.startPill.x + geo.startPill.w : null;
      const rightOk = startRight !== null
        && geo.modePill.x >= startRight
        && geo.modePill.x <= startRight + 24; // 组间距 8 + 容差（开始组右缘紧邻）
      const idsOk = geo.modeButtons.map((b) => b.id).join(',') === 'normal,agent';
      const cls = await cdpEval375(TASKBAR_TITLE, MODE_CLASS_EXPR);
      const noneActive = cls.every((e) => !e.active);
      const bothEnabled = cls.every((e) => !e.disabled);
      if (rightOk && idsOk && noneActive && bothEnabled) {
        rep.pass(`P1 模式组两枚互斥图标（normal/agent）位于开始组右侧（modePill.x=${geo.modePill.x} ∈ [${startRight}, ${startRight + 24}]），未配对两枚均不高亮`);
      } else {
        rep.fail(`P1 右邻=${rightOk} 按钮序=${idsOk} 高亮=${JSON.stringify(cls)} 几何=${JSON.stringify({ modePill: geo.modePill, startPill: geo.startPill })}`);
      }
      const f1 = regDesktopFacts();
      if (f1.count === base.count && f1.ids.every((x) => base.ids.includes(x))) {
        rep.note('P1 观察面：开关开但未配对期零桌面创建（配对动作归首次切换请求——收尾 P8 据此零残留）');
      } else {
        rep.fail(`P1 未配对期桌面集合变化：基线=${base.count} 现在=${f1.count}`);
      }
    } catch (err) { rep.fail(`P1 异常: ${err.message}`); }

    // —— P2 首次启用配对（点 Agent 图标）——
    rep.beginSegment('P2');
    let agentId = null;
    try {
      const pt = modeButtonPoint375(latestGeo(), tbRect, scale, 'agent');
      if (!pt) throw new Error('agent 模式按钮几何缺位');
      await convergeAt375(pt, tbHwnd);
      const t0 = Date.now();
      win32.clickPhys(pt.x, pt.y, 'left');
      // 配对 = 注册表集合 +1（新建 Agent）且双 ID 落盘 config（普通 = 启用时所在桌面）
      const paired = await (async () => {
        const deadline = Date.now() + 8000;
        let lastDetail = '无桌面创建观察';
        for (;;) {
          const f = regDesktopFacts();
          const created = f.ids.find((x) => !base.ids.includes(x));
          if (f.count === base.count + 1 && created) {
            let cfg = null;
            try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { cfg = null; }
            lastDetail = `落盘=${JSON.stringify(cfg && cfg.agentDesktop)} 新ID=${created.slice(0, 8)}…`;
            // 建桌在注册表先可见、面板配对落盘随后（同一事务内）——等到落盘匹配，
            // 不在「刚见到新桌面」的一瞬判失败（工单375 首跑即此竞态）。
            if (cfg && cfg.agentDesktop && cfg.agentDesktop.agentDesktopId === created
              && cfg.agentDesktop.normalDesktopId === normalId) {
              return { ok: true, created };
            }
          } else {
            lastDetail = `集合数=${f.count}（基线 ${base.count}）`;
          }
          if (Date.now() - t0 > deadline) return { ok: false, detail: lastDetail };
          await sleep(80);
        }
      })();
      agentId = paired.ok ? paired.created : null;
      // 点 Agent = 配对后即切换：系统当前回读为 Agent（确认耗时如实记录；≤1s 预算的
      // 硬断言在 P3 纯切换面——首启用含建桌不在预算口径内）
      const conf = agentId ? await waitDesktopCurrent375(com, agentId, 3000) : { ok: false, detail: paired.detail };
      // Agent 首次为空：合格窗口无一归属 Agent 桌面（正对照 = 合格集非空）
      let agentEmpty = true;
      const qualP2 = qualifiedAppWindows375([panelExePath]);
      for (const w of qualP2) {
        if (com.desktopIdOf(w.hwnd) === agentId) { agentEmpty = false; break; }
      }
      if (conf.ok && paired.ok && agentEmpty && qualP2.length > 0) {
        rep.pass(`P2 首次启用配对：普通=启用时所在桌面（既有窗口不动，合格集 ${qualP2.length} 窗无一属 Agent）、新建 Agent 桌面（集合 ${base.count}→${base.count + 1}）首次为空、双 ID 落盘；点击→系统确认 ${Date.now() - t0}ms（含建桌）`);
      } else {
        rep.fail(`P2 配对=${JSON.stringify(paired.detail ?? paired.ok)} 切换确认=${JSON.stringify(conf)} Agent空=${agentEmpty} 合格集=${qualP2.length}`);
      }
    } catch (err) { rep.fail(`P2 异常: ${err.message}`); }

    // —— P3 切换往返确认 + 高亮翻转（≤1s 预算，spec 决策 17）——
    rep.beginSegment('P3');
    try {
      if (!agentId) throw new Error('P2 未取得 Agent 桌面 ID——本段无法执行');
      // 点「普通」图标回普通 → ID 回读确认 → 高亮翻转
      const ptN = modeButtonPoint375(latestGeo(), tbRect, scale, 'normal');
      await convergeAt375(ptN, tbHwnd);
      const t0 = Date.now();
      win32.clickPhys(ptN.x, ptN.y, 'left');
      const confN = await waitDesktopCurrent375(com, normalId, 3000);
      const msN = Date.now() - t0;
      const resN = await tape.wait('taskbar-mode-action-result', (e) => e.mode === 'normal' && e.t >= t0, { timeoutMs: 6000 });
      const clsN = await cdpEval375(TASKBAR_TITLE, MODE_CLASS_EXPR);
      const hlNormal = clsN.find((c) => c.id === 'normal')?.active === true && clsN.find((c) => c.id === 'agent')?.active === false;
      // 再回 Agent
      const ptA = modeButtonPoint375(latestGeo(), tbRect, scale, 'agent');
      await convergeAt375(ptA, tbHwnd);
      const t1 = Date.now();
      win32.clickPhys(ptA.x, ptA.y, 'left');
      const confA = await waitDesktopCurrent375(com, agentId, 3000);
      const msA = Date.now() - t1;
      const resA = await tape.wait('taskbar-mode-action-result', (e) => e.mode === 'agent' && e.t >= t1, { timeoutMs: 6000 });
      const clsA = await cdpEval375(TASKBAR_TITLE, MODE_CLASS_EXPR);
      const hlAgent = clsA.find((c) => c.id === 'agent')?.active === true && clsA.find((c) => c.id === 'normal')?.active === false;
      if (confN.ok && confA.ok && hlNormal && hlAgent && resN && resA.ok === true
        && msN <= 1000 && msA <= 1000) {
        rep.pass(`P3 往返切换均以系统 ID 回读确认后提交 UI（→普通 ${msN}ms、→Agent ${msA}ms，预算 ≤1000ms），高亮随当前桌面翻转`);
      } else {
        rep.fail(`P3 普通确认=${JSON.stringify(confN)}/${msN}ms Agent确认=${JSON.stringify(confA)}/${msA}ms 高亮N=${JSON.stringify(clsN)} 高亮A=${JSON.stringify(clsA)} 回执N=${JSON.stringify(resN && { ok: resN.ok, error: resN.error })} 回执A=${JSON.stringify(resA && { ok: resA.ok, error: resA.error })}`);
      }
    } catch (err) { rep.fail(`P3 异常: ${err.message}`); }

    // —— P4 单飞连点：在途忽略 ——
    rep.beginSegment('P4');
    try {
      if (!agentId) throw new Error('P2 未取得 Agent 桌面 ID——本段无法执行');
      // 干净起点：回普通
      com.switchDesktop(normalId);
      await waitDesktopCurrent375(com, normalId, 3000);
      // 系统事实已是普通，但渲染层桌面状态经 reconciliation（≤500ms）才回推——在回推前
      // 模式组仍把 Agent 判为「当前模式」而禁用入口（连点臂会点在禁用格上零回执）。
      // 有界等入口恢复可点（normal 高亮 / agent 未禁用），再做真连点（阈值与断言不变）。
      for (let i = 0; i < 30; i++) {
        const cls = await cdpEval375(TASKBAR_TITLE, MODE_CLASS_EXPR);
        if (cls.find((c) => c.id === 'normal')?.active === true && cls.find((c) => c.id === 'agent')?.disabled === false) break;
        await sleep(100);
      }
      const ptA = modeButtonPoint375(latestGeo(), tbRect, scale, 'agent');
      await convergeAt375(ptA, tbHwnd);
      // 两连点（间隔 40ms < 确认窗）：在途入口禁用（workspace/changed switching=true 即推
      // 重渲）→ 第二击不产生新回执；系统恰好一次切换、终态唯一（spec 决策 4「在途禁用
      // 入口并忽略后续连点」；服务层 ok:false 单飞回执由离线测试 tests/desktop/
      // workspace-service.spec.ts 钉——两条路都不产生第二次提交）
      const t0 = Date.now();
      win32.clickPhys(ptA.x, ptA.y, 'left');
      await sleep(40);
      win32.clickPhys(ptA.x, ptA.y, 'left');
      const deadline = Date.now() + 6000;
      let results = [];
      for (;;) {
        results = tape.all('taskbar-mode-action-result', (e) => e.mode === 'agent' && e.t >= t0)
          .map((e) => ({ ok: e.ok, error: e.error }));
        if (results.length >= 1 && Date.now() > deadline) break;
        if (results.length >= 1) {
          // 首回执已到：再宽限 1.5s 收可能存在的第二回执（若入口未被禁用则会有）
          await sleep(1500);
          results = tape.all('taskbar-mode-action-result', (e) => e.mode === 'agent' && e.t >= t0)
            .map((e) => ({ ok: e.ok, error: e.error }));
          break;
        }
        if (Date.now() > deadline) break;
        await sleep(60);
      }
      // 系统事实：恰好完成一次切换（当前=Agent），连点没有产生桌面分裂
      const finalFacts = await waitDesktopCurrent375(com, agentId, 3000);
      const singleCommit = results.length === 1 && results[0].ok === true;
      if (finalFacts.ok && singleCommit) {
        rep.pass(`P4 连点在途忽略：在途入口禁用（第二击零回执，回执=${JSON.stringify(results)}），无第二次提交，系统最终=${finalFacts.detail}`);
      } else {
        rep.fail(`P4 最终事实=${JSON.stringify(finalFacts)} 回执=${JSON.stringify(results)}（期望恰一回执 ok:true——在途第二击被入口禁用吞掉）`);
      }
    } catch (err) { rep.fail(`P4 异常: ${err.message}`); }

    // —— P5 跟随与排除（面板/条带在 Agent 桌面在场；面板进程不进合格窗口集合）——
    rep.beginSegment('P5');
    try {
      if (!agentId) throw new Error('P2 未取得 Agent 桌面 ID——本段无法执行');
      // 当前应已在 Agent（P4 末态）；静置 800ms 后读跟随窗事实（t371 机制判定口径）
      await sleep(800);
      if (regDesktopFacts().current !== agentId) throw new Error('P5 前置失守：系统当前不在 Agent 桌面');
      const panelHwnd = await handle.waitWindow({ title: PANEL_TITLE, timeoutMs: 8000 });
      const onPanel = panelHwnd ? com.isOnCurrent(panelHwnd) : null;
      const cloakPanel = panelHwnd ? cloakValue375(panelHwnd) : null;
      const onStrip = com.isOnCurrent(tbHwnd);
      const cloakStrip = cloakValue375(tbHwnd);
      // 自家不进合格窗口集合（面板子进程的窗口全家族；合格集非空 = 正对照）
      const qual = qualifiedAppWindows375([panelExePath]);
      let panelPidInSet = false;
      try {
        const panelWinPid = panelHwnd ? win32.threadIdOf(panelHwnd).pid : 0;
        panelPidInSet = qual.some((w) => w.pid === panelWinPid);
      } catch { /* 取不到 pid 按「未排除」处理 */ }
      if (onPanel === true && cloakPanel === 0 && onStrip === true && cloakStrip === 0 && !panelPidInSet && qual.length > 0) {
        rep.pass(`P5 面板/条带窗在 Agent 桌面在场（IsOnCurrent=true + 未 shell cloak——NOACTIVATE 弹窗原生跨桌面跟随）；面板进程窗口不进合格应用窗口集合（合格集 ${qual.length} 窗全为他进程，正对照非空）`);
      } else {
        rep.fail(`P5 面板 on=${onPanel} cloak=${cloakPanel} 条带 on=${onStrip} cloak=${cloakStrip} 面板进程入合格集=${panelPidInSet} 合格集=${qual.length}`);
      }
    } catch (err) { rep.fail(`P5 异常: ${err.message}`); }

    // —— P6 reconciliation：系统侧切换观察（不抢回）——
    rep.beginSegment('P6');
    try {
      if (!agentId) throw new Error('P2 未取得 Agent 桌面 ID——本段无法执行');
      // 系统事实源直切到基线中的非配对桌面（= 第三桌面；与快捷键/TaskView 同一观察面：
      // 面板只能从注册表 CurrentVirtualDesktop 观察到「背后有人切了」）
      const third = base.ids.find((x) => x !== normalId && x !== agentId);
      if (!third) throw new Error('基线无非配对桌面可作第三桌面（基线仅 1 桌面）——环境裁剪');
      com.switchDesktop(third);
      const confT = await waitDesktopCurrent375(com, third, 3000);
      // reconciliation 轮询（2Hz）应把共享状态回推：模式组两枚均不高亮
      const clsT = await (async () => {
        const deadline = Date.now() + 4000;
        for (;;) {
          const cls = await cdpEval375(TASKBAR_TITLE, MODE_CLASS_EXPR);
          if (cls.every((c) => !c.active)) return { ok: true, cls };
          if (Date.now() > deadline) return { ok: false, cls };
          await sleep(120);
        }
      })();
      // 不抢回：静置 1.2s 后系统当前仍在第三桌面
      await sleep(1200);
      const stillThird = regDesktopFacts().current === third && com.currentId() === third;
      // 热键 Win+Ctrl+← 离开第三桌面（系统快捷键路径）：reconciliation 高亮对齐系统事实
      win32.send([
        win32.keyInput(0x5b, win32.KEYDOWN), win32.keyInput(0xa2, win32.KEYDOWN),
        win32.keyInput(0x25, win32.KEYDOWN), win32.keyInput(0x25, win32.KEYUP),
        win32.keyInput(0xa2, win32.KEYUP), win32.keyInput(0x5b, win32.KEYUP),
      ]);
      await sleep(900);
      const afterHotkey = regDesktopFacts().current;
      const clsBack = await cdpEval375(TASKBAR_TITLE, MODE_CLASS_EXPR);
      const backMatches = afterHotkey === normalId ? clsBack.find((c) => c.id === 'normal')?.active === true
        : afterHotkey === agentId ? clsBack.find((c) => c.id === 'agent')?.active === true
          : clsBack.every((c) => !c.active); // 落到其他邻位 → 不高亮也是对齐
      if (confT.ok && clsT.ok && stillThird && backMatches) {
        rep.pass(`P6 reconciliation：系统侧切第三桌面 → 模式组两枚均不高亮回推、静置 1.2s 不抢回（当前仍在第三桌面）；热键切走后高亮与系统事实对齐（当前=${String(afterHotkey).slice(0, 8)}…）`);
      } else {
        rep.fail(`P6 第三桌面切换=${JSON.stringify(confT)} 高亮回推=${JSON.stringify(clsT.cls)} 不抢回=${stillThird} 热键后=${String(afterHotkey).slice(0, 8)} 高亮对齐=${JSON.stringify(clsBack)}`);
      }
    } catch (err) { rep.fail(`P6 异常: ${err.message}`); }

    // —— P7 新窗口归属 ——
    rep.beginSegment('P7');
    try {
      if (!agentId) throw new Error('P2 未取得 Agent 桌面 ID——本段无法执行');
      // 回 Agent 桌面再开 notepad：归属应为 Agent 桌面（新窗口归属打开时所在桌面）
      com.switchDesktop(agentId);
      let toAgent7 = await waitDesktopCurrent375(com, agentId, 3000);
      if (!toAgent7.ok) {
        com.switchDesktop(agentId); // P6 热键末态邻位抖动：一次重试（仍不成就判红，不盲开窗）
        toAgent7 = await waitDesktopCurrent375(com, agentId, 3000);
      }
      if (!toAgent7.ok) throw new Error(`P7 前置失守：系统未切到 Agent 桌面（${toAgent7.detail}）`);
      // 工单380：改用 csc 现编译 WinForms 探针窗（见 PROBE380_CS 注——Store 记事本激活
      // 不再可靠落在打开时所在桌面，不能作为「新窗归属」的系统证据）。断言保持：新窗
      // 归属 = 打开时所在桌面；切回普通后 shell cloak。
      probe7 = seedProbe380(rep, 'P7-PROBE');
      if (!probe7) throw new Error('P7 探针前置失败（见 note）');
      probe7Exe = probe7.exe;
      const probeChild7 = spawn(probe7.exe, [], { stdio: 'ignore' });
      probeChildren.push(probeChild7);
      const npHwnd = await waitProbeWindow380(probe7.exe, 10000);
      lastProbeHwnd = npHwnd;
      const zeroGuid = (id) => !id || /^0{8}-/.test(String(id));
      // 新建窗的桌面 ID 可能在窗口落定前读到零 GUID（实测：cloak=2 证明在另一桌面，
      // 但 GetWindowDesktopId 首读全零）——有界重读到非零（≤3s），切回后再以系统事实复核。
      let npId = npHwnd ? com.desktopIdOf(npHwnd) : null;
      for (let i = 0; i < 15 && zeroGuid(npId); i++) {
        await sleep(200);
        npId = npHwnd ? com.desktopIdOf(npHwnd) : null;
      }
      // 切回普通：探针窗桌面绑定（shell cloak=2）——系统语义原样，面板零干预
      com.switchDesktop(normalId);
      const toNormal7 = await waitDesktopCurrent375(com, normalId, 3000);
      if (!toNormal7.ok) throw new Error(`P7 收尾失守：系统未切回普通桌面（${toNormal7.detail}）`);
      await sleep(500);
      const npCloak = npHwnd ? cloakValue375(npHwnd) : null;
      // 切回后再读一次桌面 ID（cloak 已证明是非当前桌面；此处只把归属钉到 Agent ID）
      const npIdAfter = npHwnd ? com.desktopIdOf(npHwnd) : null;
      if (!zeroGuid(npIdAfter)) npId = npIdAfter;
      if (npHwnd && npId === agentId && npCloak === DWM_CLOAKED_SHELL375) {
        rep.pass(`P7 新窗口归属打开时所在桌面（探针窗桌面 ID=${String(npId).slice(0, 8)}… = Agent）；切回普通后该窗 shell cloak（桌面绑定，系统语义原样、面板零干预）`);
      } else {
        rep.fail(`P7 探针窗 hwnd=${npHwnd} 归属=${npId === agentId}（${npId}） cloak=${npCloak}`);
      }
    } catch (err) { rep.fail(`P7 异常: ${err.message}`); }

    // —— P9 任务栏按当前桌面过滤 + 跨桌面应用点击（工单380，spec #369 决策 6/19）——
    // 三臂：①运行图标按当前桌面过滤（Agent 桌面的仅运行应用不上普通桌面栏，手钉共享
    // 在位但 running=false）；②仅另一配对桌面有单窗 → 点击切过去并激活原窗口（不重复
    // 启动）；③仅另一配对桌面有多窗 → 切过去后复用选窗菜单，点行精确到达。
    // 全臂真鼠标点击栏面图标（坐标取 taskbar-geometry 存证帧）+ 系统桌面 ID/前台 hwnd 事实。
    rep.beginSegment('P9');
    let p9ProbeAgent = null;
    let p9ProbeNormal = null;
    let p9PinnedExe = null;
    try {
      if (!agentId) throw new Error('P2 未取得 Agent 桌面 ID——本段无法执行');
      const norm9 = (s) => String(s || '').replace(/\//g, '\\').toLowerCase();
      const state9 = () => cdpEval375(TASKBAR_TITLE, `window.deck.bridge.invoke('taskbar/get-state', null)`);
      const waitState9 = async (pred, timeoutMs = 8000) => {
        const deadline = Date.now() + timeoutMs;
        let last = null;
        while (Date.now() < deadline) {
          last = await state9();
          if (last && pred(last)) return last;
          await sleep(200);
        }
        return last;
      };
      const onDesktop9 = (hwnd, id) => com.desktopIdOf(hwnd) === id;
      const strip9 = () => tbHwnd; // 条带窗跨桌面跟随，句柄不变（P1 起持有）
      const goto9 = async (id) => {
        com.switchDesktop(id);
        let r = await waitDesktopCurrent375(com, id, 3000);
        if (!r.ok) { com.switchDesktop(id); r = await waitDesktopCurrent375(com, id, 3000); }
        return r;
      };
      // 夹具摆位：原生窗按创建时活动桌面归属；若新窗落在别处（宿主/激活路径差异），
      // 用系统 TaskView 同款 MoveWindowToDesktop 摆到目标桌面（只用于夹具，不改产品断言）。
      const ensureDesktop9 = async (hwnd, id) => {
        if (!hwnd) return false;
        if (onDesktop9(hwnd, id)) return true;
        com.moveWindowToDesktop(hwnd, id);
        for (let i = 0; i < 20; i++) {
          if (onDesktop9(hwnd, id)) return true;
          await sleep(120);
        }
        return false;
      };
      const probeWinsOn9 = (exe, id) => probeWindows380(exe).filter((h) => onDesktop9(h, id));

      // Agent 桌面：钉住 P7 的探针窗（手钉共享前置），并开一个不钉的探针副本作隔离对照
      const toAgent9 = await goto9(agentId);
      if (!toAgent9.ok) throw new Error(`P9 前置失守：系统未切到 Agent 桌面（${toAgent9.detail}）`);
      if (!probe7 || !probe7Exe) throw new Error('P9 前置：P7 探针未就绪（P7 未成就）');
      const np9 = probeWinsOn9(probe7Exe, agentId);
      if (!np9.length) throw new Error('P9 前置：Agent 桌面无 P7 探针窗（P7 未成就）');
      p9PinnedExe = probe7Exe;
      const npExe9 = p9PinnedExe;
      let stAgent9 = null;
      for (let i = 0; i < 30; i++) {
        stAgent9 = await state9();
        if (stAgent9 && (stAgent9.apps || []).some((a) => norm9(a.exe) === norm9(npExe9) && a.running)) break;
        await sleep(300);
      }
      await cdpEval375(TASKBAR_TITLE, `window.deck.bridge.invoke('taskbar/set-app-pinned', { exe: ${JSON.stringify(npExe9)}, pinned: true })`);
      const pinnedState9 = await waitState9((st) => (st.apps || []).some((a) => norm9(a.exe) === norm9(npExe9) && a.pinned));
      const pinnedOk9 = !!(pinnedState9 && (pinnedState9.apps || []).some((a) => norm9(a.exe) === norm9(npExe9) && a.pinned));
      // Agent 专属、未手钉的探针副本（普通桌面栏不得出现其运行条目）
      const probeAgent9 = copyProbe380(probe7, 'P9-AGENT');
      p9ProbeAgent = spawn(probeAgent9.exe, [], { stdio: 'ignore' });
      probeChildren.push(p9ProbeAgent);
      const agentProbeHwnd9 = await waitProbeWindow380(probeAgent9.exe, 8000);
      const agentProbeOnAgent9 = await ensureDesktop9(agentProbeHwnd9, agentId);
      const agentProbeExe9 = agentProbeHwnd9 ? probeAgent9.exe : '';

      // 回普通桌面：开一个普通桌面专属探针副本作正对照（运行条目应在场）
      const toNorm9 = await goto9(normalId);
      if (!toNorm9.ok) throw new Error(`P9 前置失守：系统未切回普通桌面（${toNorm9.detail}）`);
      const probeNormal9 = copyProbe380(probe7, 'P9-NORMAL');
      p9ProbeNormal = spawn(probeNormal9.exe, [], { stdio: 'ignore' });
      probeChildren.push(p9ProbeNormal);
      const normalProbeHwnd9 = await waitProbeWindow380(probeNormal9.exe, 8000);
      const normalProbeOnNormal9 = await ensureDesktop9(normalProbeHwnd9, normalId);
      const normalProbeExe9 = normalProbeHwnd9 ? probeNormal9.exe : '';
      const stNorm9 = await waitState9((st) => {
        const apps = st.apps || [];
        const pinned = apps.find((a) => norm9(a.exe) === norm9(npExe9));
        return !!(pinned && pinned.pinned && pinned.running === false)
          && apps.some((a) => norm9(a.exe) === norm9(normalProbeExe9) && a.running === true);
      }, 12000);
      const appsNorm9 = (stNorm9 && stNorm9.apps) || [];
      const pinnedNorm9 = appsNorm9.find((a) => norm9(a.exe) === norm9(npExe9));
      const agentOnlyVisible9 = !!agentProbeExe9 && appsNorm9.some((a) => norm9(a.exe) === norm9(agentProbeExe9));
      const normalProbeVisible9 = !!normalProbeExe9 && appsNorm9.some((a) => norm9(a.exe) === norm9(normalProbeExe9) && a.running === true);
      const probesOk9 = agentProbeOnAgent9 && normalProbeOnNormal9;
      const filterOk9 = pinnedOk9 && probesOk9 && !!pinnedNorm9 && pinnedNorm9.pinned === true && pinnedNorm9.running === false
        && !agentOnlyVisible9 && normalProbeVisible9;
      if (filterOk9) {
        rep.pass(`P9① 运行图标按当前桌面过滤：普通桌面栏上手钉探针共享在位（running=false——窗口在 Agent）、`
          + `Agent 专属探针副本不上栏、普通桌面正对照 running=true`);
      } else {
        rep.fail(`P9① 手钉=${pinnedOk9} 探针=${probesOk9}(agent=${agentProbeHwnd9}/${agentProbeOnAgent9} normal=${normalProbeHwnd9}/${normalProbeOnNormal9}) `
          + `手钉共享=${JSON.stringify(pinnedNorm9 || null)} Agent专属上栏=${agentOnlyVisible9} 正对照=${normalProbeVisible9} `
          + `apps=${JSON.stringify(appsNorm9.map((a) => ({ exe: a.exe, pinned: a.pinned, running: a.running })))}`);
      }

      // 栏面图标几何（当前普通桌面）：手钉 notepad 的点击坐标
      const iconPoint9 = async (exe) => {
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          const geo = latestGeo();
          const entry = geo && Array.isArray(geo.apps) ? geo.apps.find((a) => norm9(a.id) === norm9(exe)) : null;
          if (entry) {
            const strip = strip9();
            const rect = strip ? win32.rectOf(strip) : tbRect;
            const scale9 = (rect.right - rect.left) / dip.width;
            return {
              x: Math.round(rect.left + (entry.x + entry.w / 2) * scale9),
              y: Math.round(rect.top + (entry.y + entry.h / 2) * scale9),
              entry,
            };
          }
          await sleep(200);
        }
        return null;
      };
      const clickApp9 = async (exe) => {
        const pt = await iconPoint9(exe);
        if (!pt) return null;
        const strip = strip9();
        if (strip) await convergeAt375(pt, strip);
        const t0 = Date.now();
        win32.clickPhys(pt.x, pt.y, 'left');
        const result = await tape.wait('taskbar-app-result', (e) => e.t >= t0 && norm9(e.exe) === norm9(exe), { timeoutMs: 8000 });
        return { result, t0, pt };
      };
      const fgHwnd9 = () => Number(win32.GetForegroundWindow()) || 0;

      // —— ② 仅另一配对桌面有单窗：点击切过去激活原窗口（不重复启动） ——
      let singleOk9 = false;
      let singleNote9 = '';
      let singleWin9 = probeWinsOn9(npExe9, agentId);
      if (singleWin9.length === 1) {
        const target = singleWin9[0];
        const clk = await clickApp9(npExe9);
        const conf9 = await waitDesktopCurrent375(com, agentId, 4000);
        let fgOk9 = false;
        for (let i = 0; i < 20 && !fgOk9; i++) {
          fgOk9 = fgHwnd9() === target;
          if (!fgOk9) await sleep(100);
        }
        const afterWins9 = probeWinsOn9(npExe9, agentId);
        const noNew9 = afterWins9.length === singleWin9.length;
        singleOk9 = !!(clk && clk.result && clk.result.ok === true && clk.result.action === 'activated'
          && conf9.ok && fgOk9 && noNew9);
        singleNote9 = `action=${clk && clk.result && clk.result.action} 桌面确认=${conf9.ok} 前台=${fgHwnd9()}/${target} 窗口数=${singleWin9.length}→${afterWins9.length}`;
        if (!singleOk9) rep.fail(`P9② 单窗跨桌面激活失败：${singleNote9}`);
      } else {
        singleNote9 = `Agent 桌面已有 ${singleWin9.length} 个探针窗口（单窗臂未行使，多窗臂覆盖）`;
      }

      // —— ③ 仅另一配对桌面有多窗：切过去后复用选窗菜单，点行精确到达 ——
      // 回 Agent 补一个同身份探针窗口（若②后已在 Agent 直接开）
      if (com.currentId() !== agentId) {
        const toA9 = await goto9(agentId);
        if (!toA9.ok) throw new Error(`P9③ 前置失守：系统未切到 Agent 桌面（${toA9.detail}）`);
      }
      let beforeMulti9 = probeWinsOn9(npExe9, agentId);
      if (beforeMulti9.length < 2) {
        const second9 = spawn(probe7.exe, [], { stdio: 'ignore' });
        probeChildren.push(second9);
        const want9 = beforeMulti9.length + 1;
        const deadline9 = Date.now() + 10000;
        while (Date.now() < deadline9 && probeWindows380(probe7Exe).length < want9) await sleep(200);
        // 同镜像第二窗若落在别处，摆回 Agent（夹具摆位；窗口身份仍是同 exe）
        for (const h of probeWindows380(probe7Exe)) await ensureDesktop9(h, agentId);
        beforeMulti9 = probeWinsOn9(npExe9, agentId);
      }
      const multiWins9 = probeWinsOn9(npExe9, agentId);
      // 回普通桌面再点击
      const toN9 = await goto9(normalId);
      if (!toN9.ok) throw new Error(`P9③ 前置失守：系统未切回普通桌面（${toN9.detail}）`);
      await sleep(800);
      const clkM9 = await clickApp9(npExe9);
      const confM9 = await waitDesktopCurrent375(com, agentId, 4000);
      const menuEvent9 = clkM9
        ? await tape.wait('taskbar-wins-menu-open', (e) => e.t >= clkM9.t0, { timeoutMs: 6000 })
        : null;
      let pickOk9 = false;
      let pickHwnd9 = 0;
      if (multiWins9.length >= 2) {
        pickHwnd9 = multiWins9[multiWins9.length - 1];
        const pickRes9 = await cdpEval375(TASKBAR_TITLE, `window.deck.bridge.invoke('taskbar/activate-window', { hwnd: ${pickHwnd9} })`);
        for (let i = 0; i < 20 && !pickOk9; i++) {
          pickOk9 = fgHwnd9() === pickHwnd9;
          if (!pickOk9) await sleep(100);
        }
        if (!(pickRes9 && pickRes9.ok === true) || !pickOk9) {
          rep.fail(`P9③ 选窗行精确到达失败：回执=${JSON.stringify(pickRes9)} 前台=${fgHwnd9()}/${pickHwnd9}`);
        }
      } else {
        rep.fail(`P9③ 多窗前置未成就：Agent 桌面探针窗口数=${multiWins9.length}`);
      }
      const multiOk9 = !!(clkM9 && clkM9.result && clkM9.result.action === 'window-list'
        && confM9.ok && !!menuEvent9 && pickOk9 && multiWins9.length >= 2);
      if (multiOk9) {
        rep.pass(`P9③ 仅另一配对桌面多窗：点击切到 Agent 并复用选窗菜单（${multiWins9.length} 行），`
          + `点行精确到达 hwnd=${pickHwnd9}（前台命中）`);
      } else if (!pickOk9) {
        // 明细已在上方失败记录（不重复判红）
      } else {
        rep.fail(`P9③ 多窗跨桌面：action=${clkM9 && clkM9.result && clkM9.result.action} 桌面确认=${confM9.ok} `
          + `菜单事件=${!!menuEvent9} 选中=${pickOk9}`);
      }
      if (singleOk9) {
        rep.pass(`P9② 仅另一配对桌面单窗：点击切到 Agent 并激活原窗口（${singleNote9}）`);
      }
      if (!singleOk9 && singleWin9.length > 1) rep.note(`P9② ${singleNote9}`);
    } catch (err) { rep.fail(`P9 异常: ${err.message}`); }
    finally {
      // 手钉复原（栏布局共享存储不留本轮身份），探针清场；回普通桌面交 P8 收尾
      try {
        if (p9PinnedExe) {
          await cdpEval375(TASKBAR_TITLE, `window.deck.bridge.invoke('taskbar/set-app-pinned', { exe: ${JSON.stringify(p9PinnedExe)}, pinned: false })`);
        }
      } catch { /* 条带已不在场 */ }
      for (const p of [p9ProbeAgent, p9ProbeNormal]) {
        if (p) spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
      }
      try {
        const com9 = bindVdCom375();
        if (normalId && com9.currentId() !== normalId) com9.switchDesktop(normalId);
      } catch { /* 尽力 */ }
    }
  } catch (err) {
    rep.fail(`电池异常: ${err && err.stack || err}`);
  } finally {
    // —— P8 收尾复原（零残留）：切回普通 → 删配对 Agent 桌面 → 注册表与基线逐项相等 ——
    rep.beginSegment('P8');
    try {
      const com2 = bindVdCom375();
      // 基线与配对身份从外层账取（P2 起点前的注册表基线 + config 落盘的配对）
      const cfg = (() => { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return null; } })();
      const agentId = cfg?.agentDesktop?.agentDesktopId || null;
      const normalId = cfg?.agentDesktop?.normalDesktopId || null;
      const baseNow = regDesktopFacts();
      const extraNow = baseNow.ids.filter((x) => !base.ids.includes(x));
      rep.note(`P8 收尾起点：基线=${base.count} 当前集合=${baseNow.count} 本轮多余=${extraNow.length}`);
      if (agentId) {
        try {
          if (baseNow.current === agentId && normalId) {
            com2.switchDesktop(normalId);
            await waitDesktopCurrent375(com2, normalId, 3000);
          }
          com2.removeDesktop(agentId, normalId ?? undefined);
        } catch (e) { rep.note(`P8 RemoveDesktop 异常（热键兜底前记录）：${e.message}`); }
      }
      // 热键兜底（t371 S11 同款）：若桌面数仍多于基线，逐个收掉多余桌面
      for (let guard = 0; guard < 6; guard++) {
        const f = regDesktopFacts();
        if (f.count <= base.count) break;
        const extra = f.ids.filter((x) => !base.ids.includes(x));
        if (!extra.length) break;
        if (extra.includes(f.current)) {
          // Win+Ctrl+F4 关闭当前桌面
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
        rep.pass(`P8 零残留：注册表桌面集合与基线逐项相等（${f2.count} 桌面）、当前不在已删 Agent 桌面`);
      } else {
        rep.fail(`P8 集合=${JSON.stringify(f2.ids.map((x) => x.slice(0, 8)))} 基线=${JSON.stringify(base.ids.map((x) => x.slice(0, 8)))} 当前=${f2.current}`);
      }
    } catch (err) { rep.fail(`P8 异常: ${err.message}`); }

    for (const np of probeChildren) spawnSync('taskkill', ['/PID', String(np.pid), '/T', '/F'], { stdio: 'ignore' });
    // 探针窗宿主（WinForms 探针为单进程；按句柄属主补杀兜底）
    if (lastProbeHwnd) {
      try {
        const hostPid = win32.threadIdOf(lastProbeHwnd).pid;
        if (hostPid) spawnSync('taskkill', ['/PID', String(hostPid), '/T', '/F'], { stdio: 'ignore' });
      } catch { /* 尽力清场 */ }
    }
    try { if (probe7) fs.rmSync(probe7.tmpDir, { recursive: true, force: true }); } catch { /* 尽力清场 */ }
    const cleared = await handle.stop();
    if (cleared && cleared.gone === false) {
      rep.exclude(`清场核验：面板强退失败：强杀后有界等待内仍存活（pid=${cleared.pidsLeft.join(', ')})——需重启清障`,
        '清场后仍有面板进程存活', 'panel-forcekill');
    }
    // config 三态还原（工单124）：原本无文件则删掉电池落的最小桩
    try { fs.unlinkSync(LAYOUT_FILE); } catch { /* 已删/未生成 */ }
    restoreConfig(originalConfig);
    win32.ensureNativeTaskbarVisible();
  }

  finish();
}

module.exports = main;
