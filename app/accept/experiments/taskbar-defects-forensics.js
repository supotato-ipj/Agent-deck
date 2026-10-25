'use strict';
// 工单142+#103 并案取证 harness（spec #145 定案：一轮跑全 #103 五步 + 溢出堆积量化）。
// 用法（纯 node；须先 npm run build）：node accept/experiments/taskbar-defects-forensics.js [--out=<dir>]
//
// 六相（固定此序，判读依赖）：
//   A 宿主常驻   普通启动（无 --tray-spike）：boot + tray-host-ready + 同名竞争窗在场（#103 步①）
//   B 属主枚举   全量 Shell_TrayWnd 按属主 PID 区分 explorer/面板（koffi 通道；#103 步②）
//   C 禁用/启用  CDP 驱动 taskbar/set-enabled：各稳态拍快照——explorer 真任务栏可见态、
//               条带窗在场、矩形重叠、工作区收缩；裸 FindWindow 首命归属（#103 步③/缺陷②）
//   D 关-开连发  禁用→启用间隔 ~30ms（抢在 closed 事件落地前），稳后核：条带恰一扇、
//               再来一轮禁/启可达（句柄未被 closed 抹掉）、工作区占位随启停伸缩（#103 步④/缺陷①）
//   E 禁用态托盘 任务栏禁用（原生还原）时识别色在 explorer 托盘区在场性（#103 步⑤：原子性
//               契约——收编图标应随交还回原生）
//   F 溢出量化   溢出浮层 dump（Win+B→ENTER 于 Show Hidden Icons）计数：重启面板 ×3 前后，
//               本面板 exe 条目与 Wallpaper Engine 条目的增量（#142：堆积率 vs 启动次数）
//
// 纪律：面板 stdout 必须排空（工单132 根因）；本 harness 是取证工具不是验收段——不进
// manifest、不产 verdict；退出码 0=完成 3=机器脏。碰真桌面（键鼠注入+真面板+CDP），一律经
// accept-guard 托管。宿主枚举必须在 harness 侧 koffi 做（PS FindWindowExW 看不见隐藏竞争窗）。
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const win32 = require('../lib/win32');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_OUT = 'D:\\test-folder\\.agent-notes\\t142-103-forensics';
const PROBE_PATH = path.join(__dirname, '..', 'lib', 'uia-probe2.ps1');
const PANEL_TITLE = 'AGENT DECK';
const CDP_PORT = 9223;
const VK_LWIN = 0x5b, VK_B = 0x42, VK_ESCAPE = 0x1b, VK_RETURN = 0x0d;
const SETTLE_MS = 1800;           // 禁用/启用后窗建销与 AppBar 协商的稳态等待
const BURST_GAP_MS = 30;          // 缺陷①：关-开连发间隔（远小于 closed 事件落地）
const RELAUNCH_ROUNDS = 3;        // F 相：重启次数（堆积率分子）

const user32Local = win32.koffi.load('user32.dll');
const GetWindowTextW = user32Local.func('int __stdcall GetWindowTextW(uintptr_t hWnd, uint16 *buf, int nMax)');
const FindWindowW = user32Local.func('uintptr_t __stdcall FindWindowW(const char16_t* cls, const char16_t* title)');
const SystemParametersInfoW = user32Local.func('int __stdcall SystemParametersInfoW(uint32_t action, uint32_t uiParam, void *pvParam, uint32_t winIni)');
const RegisterWindowMessageW = user32Local.func('uint32 __stdcall RegisterWindowMessageW(const char16_t* lpString)');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function windowTitle(hwnd) {
  const buf = Buffer.alloc(1024);
  const n = GetWindowTextW(hwnd, buf, 512);
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(buf.readUInt16LE(i * 2));
  return s;
}

/** 工作区（AppBar 占位的直接可观测量：启用时底边收缩、禁用时归还） */
function workarea() {
  const rect = Buffer.alloc(16);
  if (!SystemParametersInfoW(0x0030 /* SPI_GETWORKAREA */, 0, rect, 0)) return null;
  return { left: rect.readInt32LE(0), top: rect.readInt32LE(4), right: rect.readInt32LE(8), bottom: rect.readInt32LE(12) };
}

function describeWindows(cls) {
  const out = [];
  let after = 0;
  for (;;) {
    const h = Number(win32.FindWindowExW(0, after, cls, null));
    if (!h) break;
    const pid = win32.threadIdOf(h).pid;
    out.push({ hwnd: h, class: cls, pid, exe: win32.exeOfPid(pid), visible: !!win32.IsWindowVisible(h), rect: win32.rectOf(h), title: windowTitle(h) });
    after = h;
  }
  return out;
}

/** 裸 FindWindowW 首命（z 序）：nativeTrayWnd() 的真实行为形态——命中属主即答案 */
function bareFindWindowFirst() {
  const h = Number(FindWindowW('Shell_TrayWnd', null));
  if (!h) return { hwnd: 0 };
  const pid = win32.threadIdOf(h).pid;
  return { hwnd: h, pid, exe: win32.exeOfPid(pid), visible: !!win32.IsWindowVisible(h) };
}

/** 面板条带窗（DECK-TASKBAR 题）与面板本体窗，按属主 pid 过滤 */
function panelWindows(panelPid) {
  return win32.topLevelWindows()
    .filter((w) => win32.threadIdOf(w).pid === panelPid)
    .map((w) => ({ hwnd: w, title: windowTitle(w), class: win32.className(w), visible: !!win32.IsWindowVisible(w), rect: win32.rectOf(w) }));
}

function readEvents(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function launchPanel(eventsFile) {
  const electronExe = require('electron');
  const c = spawn(electronExe, ['.', '--panel-accept'], {
    cwd: APP_ROOT,
    env: { ...process.env, DECK_EVENT_LOG: eventsFile, DECK_LAG_SENTINEL: '1', DECK_CDP_PORT: String(CDP_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  c.stdout.on('data', () => {});
  let stderrTail = '';
  c.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-4000); });
  c.stderrTail = () => stderrTail;
  return c;
}

async function waitPanelReady(eventsFile, child) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const evs = readEvents(eventsFile);
    const boot = evs.filter((e) => e.type === 'boot').pop();
    const ready = evs.filter((e) => e.type === 'tray-host-ready').pop();
    if (boot && ready) {
      const hwnd = win32.topLevelWindows().find((w) =>
        win32.threadIdOf(w).pid === boot.pid && win32.className(w) === 'Chrome_WidgetWin_1' && windowTitle(w) === PANEL_TITLE);
      if (hwnd) return { panelPid: boot.pid, hwnd, ready };
    }
    if (child.exitCode !== null) throw new Error(`面板提前退出（code=${child.exitCode}）stderr尾：${child.stderrTail()}`);
    await sleep(200);
  }
  throw new Error(`面板 25s 未就绪 stderr尾：${child.stderrTail()}`);
}

async function stopPanel(child) {
  if (child && isAlive(child.pid)) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  }
  await sleep(600);
  const msg = RegisterWindowMessageW('TaskbarCreated');
  win32.PostMessageW(0xffff, msg, 0, 0); // 交还广播：图标回注册 explorer（F 相计数的卫生动作）
  await sleep(2500);
}

/** CDP 驱动面板页（taskbar.js 同款：原生 WebSocket + Runtime.evaluate） */
async function cdpEval(expression) {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
  const target = targets.find((t) => t.title === PANEL_TITLE);
  if (!target) throw new Error('CDP 找不到面板页目标');
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
  } finally { ws.close(); }
}

/** 禁用/启用快照：同名窗分属、裸 FindWindow 首命、条带在场、explorer 可见、工作区 */
function snapshot(label) {
  const hosts = describeWindows('Shell_TrayWnd');
  const explorerHost = hosts.find((x) => path.basename(x.exe || '').toLowerCase() === 'explorer.exe') || null;
  const strips = win32.topLevelWindows()
    .filter((w) => windowTitle(w) === 'DECK-TASKBAR')
    .map((w) => ({ hwnd: w, pid: win32.threadIdOf(w).pid, visible: !!win32.IsWindowVisible(w), rect: win32.rectOf(w) }));
  const overlap = explorerHost && strips.length
    ? !(explorerHost.rect.bottom <= strips[0].rect.top || strips[0].rect.bottom <= explorerHost.rect.top)
    : false;
  return {
    label, hosts, bareFirst: bareFindWindowFirst(), strips,
    explorerTaskbarVisible: explorerHost ? explorerHost.visible : false,
    explorerRect: explorerHost ? explorerHost.rect : null,
    workarea: workarea(), overlapStripExplorer: overlap,
  };
}

/** 溢出浮层 dump：Win+B（焦点落 Show Hidden Icons）→ ENTER 开浮层 → 稳 → probe2 dump
 *  全部托盘相关顶层窗（含浮层）→ ESC。返回 { windows, dumpRaw }。 */
async function dumpOverflow(h, tag, outDir) {
  const pre = [...describeWindows('Shell_TrayWnd'), ...describeWindows('NotifyIconOverflowWindow'),
    ...describeWindows('TopLevelWindowForOverflowXamlExplorer'), ...describeWindows('TopLevelWindowForOverflowXamlIsland')];
  win32.send([
    win32.keyInput(VK_LWIN, win32.KEYDOWN), win32.keyInput(VK_B, win32.KEYDOWN),
    win32.keyInput(VK_B, win32.KEYUP), win32.keyInput(VK_LWIN, win32.KEYUP),
  ]);
  await sleep(1200);
  win32.send([win32.keyInput(VK_RETURN, win32.KEYDOWN), win32.keyInput(VK_RETURN, win32.KEYUP)]);
  await sleep(1500);
  const opened = [...describeWindows('NotifyIconOverflowWindow'), ...describeWindows('TopLevelWindowForOverflowXamlExplorer'), ...describeWindows('TopLevelWindowForOverflowXamlIsland')];
  const dumpHwnds = [...pre.map((t) => t.hwnd), ...opened.map((t) => t.hwnd)]
    .filter((v, i, a) => a.indexOf(v) === i).join(',');
  const probe = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', PROBE_PATH, '-Needle', 'AGENT DECK', '-MaxSteps', '1', '-DumpHwnds', dumpHwnds],
  { encoding: 'utf8', timeout: 120000, windowsHide: true });
  win32.tapKeys([VK_ESCAPE]);
  await sleep(800);
  const raw = probe.stdout || '';
  fs.writeFileSync(path.join(outDir, `overflow-${tag}.jsonl`), raw + `\n# status=${probe.status}\n# opened=${JSON.stringify(opened.map((o) => ({ hwnd: o.hwnd, class: o.class, pid: o.pid, exe: o.exe })))}\n`);
  // 计数：dump 行（DETAIL 无关，probe2 输出裸 JSON 行）里 name 含关键词的条目数
  const countName = (needle) => raw.split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((o) => o && o.kind === 'dump' && Array.isArray(o.items))
    .reduce((acc, d) => acc + d.items.filter((it) => (it.name || '').includes(needle)).length, 0);
  const counts = { panel: countName('AGENT DECK'), wallpaperEngine: countName('Wallpaper Engine') };
  h({ type: 'overflow-dump', tag, flyoutWindows: opened.length, counts });
  return { opened, counts, raw };
}

/** config taskbar.enabled 覆写与还原 */
function configTaskbar(enabled) {
  const configFile = path.join(APP_ROOT, 'config.json');
  const backup = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : null;
  const cfg = backup ? JSON.parse(backup) : {};
  fs.writeFileSync(configFile, JSON.stringify({ ...cfg, taskbar: { ...(cfg.taskbar ?? {}), enabled } }, null, 2) + '\n');
  return () => {
    try {
      if (backup === null) { try { fs.unlinkSync(configFile); } catch { /* 本就无 */ } }
      else fs.writeFileSync(configFile, backup);
    } catch { /* 尽力 */ }
  };
}

async function setTaskbar(enabled) {
  const r = await cdpEval(`window.deck.bridge.invoke('taskbar/set-enabled', { enabled: ${enabled} })`);
  await sleep(SETTLE_MS);
  return r;
}

(async () => {
  const outDir = process.argv.find((a) => a.startsWith('--out='))?.slice(6) || DEFAULT_OUT;
  fs.mkdirSync(outDir, { recursive: true });
  const hlog = [];
  const h = (ev) => { hlog.push({ t: Date.now(), ...ev }); console.log(`[t142-103-forensics] ${JSON.stringify(ev)}`); };
  h({ type: 'run-start', out: outDir });
  const eventsFile = path.join(outDir, 'panel-events.jsonl');
  let restoreConfig = configTaskbar(true); // 本 harness 需要任务栏条带在场（对齐生产形态）
  let child = null;
  let dirty = false;
  try {
    // —— A 宿主常驻（#103 步①）——
    child = launchPanel(eventsFile);
    const state = await waitPanelReady(eventsFile, child);
    h({ type: 'A-host-ready', panelPid: state.panelPid, trayHostReady: state.ready });
    await sleep(3000); // 条带建窗与 AppBar 协商稳定

    // —— B 属主枚举（#103 步②）——
    const snapB = snapshot('B-initial');
    h({ type: 'B-hosts', hosts: snapB.hosts.map((x) => ({ pid: x.pid, exe: x.exe, visible: x.visible, w: x.rect.w, h: x.rect.h })), bareFirst: snapB.bareFirst });

    // —— C 禁用/启用逐拍（#103 步③，缺陷②观测面）——
    const cBefore = snapshot('C-before-disable');
    const rOff = await setTaskbar(false);
    const cDisabled = snapshot('C-disabled');
    const rOn = await setTaskbar(true);
    const cEnabled = snapshot('C-re-enabled');
    h({ type: 'C-cycle', disableResult: rOff, enableResult: rOn,
      before: { explorerVisible: cBefore.explorerTaskbarVisible, strips: cBefore.strips.length, workareaBottom: cBefore.workarea?.bottom },
      disabled: { explorerVisible: cDisabled.explorerTaskbarVisible, strips: cDisabled.strips.length, workareaBottom: cDisabled.workarea?.bottom, bareFirst: cDisabled.bareFirst },
      enabled: { explorerVisible: cEnabled.explorerTaskbarVisible, strips: cEnabled.strips.length, workareaBottom: cEnabled.workarea?.bottom, overlap: cEnabled.overlapStripExplorer } });
    fs.writeFileSync(path.join(outDir, 'snapshots.json'), JSON.stringify({ cBefore, cDisabled, cEnabled }, null, 2));

    // —— D 关-开连发（#103 步④，缺陷①）——
    const t0 = Date.now();
    await cdpEval(`window.deck.bridge.invoke('taskbar/set-enabled', { enabled: false })`);
    await sleep(BURST_GAP_MS);
    await cdpEval(`window.deck.bridge.invoke('taskbar/set-enabled', { enabled: true })`);
    h({ type: 'D-burst-sent', gapMs: Date.now() - t0 - 0 });
    await sleep(SETTLE_MS + 1500); // 让 closed 事件充分落地
    const dAfterBurst = snapshot('D-after-burst');
    h({ type: 'D-after-burst', strips: dAfterBurst.strips.map((s) => ({ pid: s.pid, visible: s.visible, w: s.rect.right - s.rect.left })), explorerVisible: dAfterBurst.explorerTaskbarVisible, workareaBottom: dAfterBurst.workarea?.bottom });
    // 可达性证明：再来一轮完整禁/启能走通 + 条带恰一扇
    const rOff2 = await setTaskbar(false);
    const dOff2 = snapshot('D-disable-2');
    const rOn2 = await setTaskbar(true);
    const dOn2 = snapshot('D-enable-2');
    const panelOwnedStrips = dOn2.strips.filter((s) => s.pid === state.panelPid).length;
    h({ type: 'D-reachable', offResult: rOff2, onResult: rOn2, stripsAfterSecondCycle: dOn2.strips.length, panelOwnedStrips, workareaBottomDisabled: dOff2.workarea?.bottom, workareaBottomEnabled: dOn2.workarea?.bottom });

    // —— E 禁用态托盘（#103 步⑤）：禁用态下 explorer 原生托盘里本面板图标的在场性 ——
    await setTaskbar(false);
    const eDisabled = snapshot('E-disabled');
    const eDump = await dumpOverflow(h, 'E-disabled-state', outDir);
    h({ type: 'E-disabled-tray', explorerVisible: eDisabled.explorerTaskbarVisible, overflowCounts: eDump.counts });

    // —— F 溢出量化（#142）：全程禁用态观测（对齐 t119 浮层观测条件），重启 ×3 前后条目增量 ——
    restoreConfig();
    restoreConfig = configTaskbar(false); // 重启后的面板也以禁用态起（观测条件一致）
    const fBefore = await dumpOverflow(h, 'F-before-relaunch', outDir);
    for (let i = 1; i <= RELAUNCH_ROUNDS; i++) {
      await stopPanel(child);
      child = launchPanel(eventsFile);
      await waitPanelReady(eventsFile, child);
      await sleep(2500);
      h({ type: 'F-relaunch', round: i });
    }
    const fAfter = await dumpOverflow(h, 'F-after-relaunch', outDir);
    h({ type: 'F-quantify', relaunches: RELAUNCH_ROUNDS,
      panelDelta: fAfter.counts.panel - fBefore.counts.panel,
      wallpaperEngineDelta: fAfter.counts.wallpaperEngine - fBefore.counts.wallpaperEngine,
      before: fBefore.counts, after: fAfter.counts });
  } catch (e) {
    dirty = true;
    h({ type: 'fatal', message: e && e.message });
  } finally {
    await stopPanel(child);
    restoreConfig();
    fs.writeFileSync(path.join(outDir, 'harness-log.json'), JSON.stringify(hlog, null, 2));
    const leftovers = win32.topLevelWindows().filter((w) => windowTitle(w) === 'DECK-TASKBAR');
    if (leftovers.length) { dirty = true; h({ type: 'leftover-strips', count: leftovers.length }); }
    h({ type: 'run-end', dirty });
    process.exit(dirty ? 3 : 0);
  }
})();
