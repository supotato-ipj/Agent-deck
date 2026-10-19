'use strict';
// 工单156 应用组枚举过滤验收：控制器以 --accept-taskbar-apps-filter 身份运行，
// 拉起 --panel-accept 面板子进程（绕开单实例锁，与常驻面板共存），一段两断言面：
//   P1 垃圾窗不上栏：
//     (a) 探针在场取证（system-state）——notepad 正常主窗 + powershell 宿主三扇垃圾形态
//         窗（可见空标题 / WS_EX_TOOLWINDOW 工具窗 / 有属主无 APPWINDOW 弹窗，
//         lib/garbage-window-probe.ps1）全部可见在场且特征属实——阴性断言的输入自证，
//         防「机器恰好干净所以断言空洞」；
//     (b) 栏面名单裁决（event-evidence）——CDP taskbar/get-state：notepad 收（running
//         条目）、powershell 拒（探针宿主不在名单）、全部 running 条目 title 非空
//         （无图标后台条目在栏面上的形态断言——旧缺陷条目形态即 running+无标题）。
// 纯名单断言（1Hz refresh 反映），无点击无像素，运行快。
// 运行：npm run accept:taskbar-apps-filter（= electron . --accept-taskbar-apps-filter）。
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const win32 = require('./lib/win32');
const { Report } = require('./lib/report');
// config 读写/还原共通 helper（工单124）：缺位读不抛、缺位落桩、三态还原——电池单点维护
const { readConfigRaw, patchTaskbar, restoreConfig } = require('./lib/battery-config');

const APP_ROOT = path.resolve(__dirname, '..');
const EVENTS_FILE = path.join(__dirname, 'evidence', '156-taskbar-apps-filter-events.jsonl');
const CDP_PORT = 9226; // 9223-9225 已被 49/battery/carry/right-group 占用
const TASKBAR_TITLE = 'DECK-TASKBAR';
const PANEL_TITLE = 'AGENT DECK';

const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_APPWINDOW = 0x00040000;
const GWL_EXSTYLE = -20;
const GW_OWNER = 4;

const koffi = win32.koffi;
const user32 = koffi.load('user32.dll');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(uintptr_t hWnd, uint16 *buf, int nMax)');
const GetWindowW = user32.func('uintptr_t __stdcall GetWindow(uintptr_t hWnd, uint32 uCmd)');

const { nativeTaskbarVisible, ensureNativeTaskbarVisible } = win32;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function titleOf(hwnd) {
  const buf = Buffer.alloc(512);
  const n = GetWindowTextW(hwnd, buf, 256);
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(buf.readUInt16LE(i * 2));
  return s;
}

function exStyleOf(hwnd) {
  return Number(win32.GetWindowLongW(hwnd, GWL_EXSTYLE)) | 0;
}

function ownerOf(hwnd) {
  return Number(GetWindowW(hwnd, GW_OWNER));
}

/** 按 pid 收该进程的可见顶层窗（探针窗按宿主进程圈定，不按类名全机扫） */
function visibleWindowsOfPid(pid) {
  return win32.topLevelWindows().filter((h) => win32.threadIdOf(h).pid === pid);
}

function readEvents() {
  try {
    return fs.readFileSync(EVENTS_FILE, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

async function waitEvent(type, pred, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = readEvents().find((e) => e.type === type && (!pred || pred(e)));
    if (hit) return hit;
    await sleep(60);
  }
  return null;
}

function findWindowByPidTitle(pid, title) {
  for (const h of visibleWindowsOfPid(pid)) {
    if (titleOf(h) === title) return h;
  }
  return null;
}

async function waitWindow(pid, title, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const h = findWindowByPidTitle(pid, title);
    if (h) return h;
    await sleep(120);
  }
  return null;
}

function launchPanel() {
  return spawn(process.execPath, ['.', '--panel-accept'], {
    cwd: APP_ROOT,
    env: { ...process.env, DECK_EVENT_LOG: EVENTS_FILE, DECK_CDP_PORT: String(CDP_PORT) },
    stdio: 'ignore',
  });
}

/** CDP 驱动面板渲染层（桥动作真机通道，同 taskbar.js）：在面板页执行表达式并取回值 */
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
  } finally {
    ws.close();
  }
}

function killTree(child, panelPid) {
  if (panelPid) spawnSync('taskkill', ['/PID', String(panelPid), '/T', '/F'], { stdio: 'ignore' });
  try { child.kill(); } catch { /* 已退出 */ }
}

async function main() {
  const rep = new Report('156-taskbar-apps-filter');
  let child = null;
  let panelPid = 0;
  let notepad = null;
  let probe = null;
  const originalConfig = readConfigRaw();
  const finish = () => {
    const v = rep.verdict(rep.fails === 0 ? 'PASS' : 'FAIL');
    app.exit(v.fails === 0 ? 0 : 1);
  };

  try {
    fs.writeFileSync(EVENTS_FILE, '', 'utf8');
    patchTaskbar({ enabled: true });

    // —— 拉起面板子进程（任务栏启用态）——
    child = launchPanel();
    const boot = await waitEvent('boot', null, 15000);
    if (!boot) throw new Error('面板子进程未上报 boot 事件');
    panelPid = boot.pid;
    rep.note(`面板 pid=${panelPid}`);
    const tbHwnd = await waitWindow(panelPid, TASKBAR_TITLE, 12000);
    if (!tbHwnd) throw new Error('任务栏窗口未出现');

    // —— 探针就位：notepad 正常主窗 + powershell 三扇垃圾形态窗 ——
    notepad = spawn('notepad.exe', [], { stdio: 'ignore' });
    const sinceNp = Date.now();
    const npHwnd = await (async () => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        for (const h of win32.topLevelWindows()) {
          if (win32.IsWindowVisible(h) && String(win32.exeNameOfWindow(h) || '').toLowerCase() === 'notepad') {
            return h;
          }
        }
        await sleep(120);
      }
      return null;
    })();
    const PROBE_DIAG = path.join(__dirname, 'evidence', '156-probe-diag.txt');
    try { fs.rmSync(PROBE_DIAG, { force: true }); } catch { /* 无旧档 */ }
    probe = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(__dirname, 'lib', 'garbage-window-probe.ps1')], {
      stdio: 'ignore',
      env: { ...process.env, DECK_PROBE_DIAG: PROBE_DIAG },
    });
    // 等三扇垃圾窗可见在场（按宿主 pid 圈定，最多 12s）
    let probeWins = [];
    for (let i = 0; i < 40 && probeWins.length < 3; i++) {
      await sleep(300);
      probeWins = visibleWindowsOfPid(probe.pid);
    }
    // 红轮定责出口（首红轮实证：stdio ignore 吞错时探针无声缺席）：退出码 + 诊断档
    const probeExit = probe.exitCode;
    let probeDiag = null;
    try { probeDiag = fs.readFileSync(PROBE_DIAG, 'utf8').trim(); } catch { /* 探针没来得及写 */ }
    rep.note(`垃圾窗探针: exit=${probeExit} diag=${probeDiag === null ? '(无诊断档)' : probeDiag}`);
    // 取证每扇特征（探针自证——阴性断言的输入必须真实在场）
    const forensics = probeWins.map((h) => ({
      hwnd: h,
      title: titleOf(h),
      toolWindow: (exStyleOf(h) & WS_EX_TOOLWINDOW) !== 0,
      appWindow: (exStyleOf(h) & WS_EX_APPWINDOW) !== 0,
      owned: ownerOf(h) !== 0,
    }));
    rep.note(`垃圾窗探针取证: ${JSON.stringify(forensics)}`);
    rep.note(`notepad 探针: hwnd=${npHwnd} title=${npHwnd ? titleOf(npHwnd) : 'n/a'} 起于 ${Date.now() - sinceNp}ms 前`);

    // —— P1(a) 探针在场与特征（system-state）——
    rep.beginSegment('P1');
    const emptyTitle = forensics.find((f) => f.title === '' && !f.toolWindow && !f.owned && !f.appWindow);
    const toolWin = forensics.find((f) => f.toolWindow && f.title !== '');
    const ownedWin = forensics.find((f) => f.owned && !f.appWindow && !f.toolWindow && f.title !== '');
    if (npHwnd && emptyTitle && toolWin && ownedWin) {
      rep.pass(`P1(a) 探针在场属实：notepad 主窗 + 空标题窗(${emptyTitle.hwnd}) + 工具窗(${toolWin.hwnd}) + 有属主无 APPWINDOW 窗(${ownedWin.hwnd})`);
    } else {
      rep.fail(`P1(a) 探针不完整: notepad=${!!npHwnd} 三扇取证=${JSON.stringify(forensics)}`);
    }

    // —— P1(b) 栏面名单裁决（event-evidence；1Hz refresh，等 notepad 进名单）——
    let state = null;
    let notepadIn = false;
    for (let i = 0; i < 20 && !notepadIn; i++) {
      await sleep(600);
      state = await cdpEval(`window.deck.bridge.invoke('taskbar/get-state', {})`);
      notepadIn = !!(state && state.apps && state.apps.some((e) => e.running && /notepad\.exe$/i.test(e.exe)));
    }
    const runningEntries = (state && state.apps ? state.apps : []).filter((e) => e.running);
    const psEntries = (state && state.apps ? state.apps : []).filter((e) => /powershell\.exe$/i.test(e.exe));
    const untitled = runningEntries.filter((e) => !e.title);
    rep.note(`栏面名单: running=${runningEntries.length} 条 [${runningEntries.map((e) => `${e.exe.split(/[\\/]/).pop()}(${e.title ? '有题' : '无题'})`).join(', ')}]`);
    if (notepadIn && psEntries.length === 0 && untitled.length === 0) {
      rep.pass(`P1(b) 过滤裁决：notepad 收、powershell 三扇垃圾窗拒、running 条目全部有标题（${runningEntries.length} 条）`);
    } else {
      rep.fail(`P1(b) notepad收=${notepadIn} powershell拒=${psEntries.length === 0} 无标题running=${untitled.length} 名单=${JSON.stringify(runningEntries.map((e) => ({ exe: e.exe, title: e.title })))}`);
    }
  } catch (err) {
    rep.fail(`电池异常: ${err && err.stack || err}`);
  } finally {
    try { if (notepad) notepad.kill(); } catch { /* 已退出 */ }
    try { if (probe) spawnSync('taskkill', ['/PID', String(probe.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ }
    killTree(child, panelPid);
    restoreConfig(originalConfig);
    // 同 49 清场纪律：不留无系统入口的桌面
    ensureNativeTaskbarVisible();
    nativeTaskbarVisible()
      ? rep.note('清场核验：原生任务栏可见')
      : rep.note('清场核验：原生任务栏仍隐藏（兜底已尝试，需人工核查）');
  }

  finish();
}

module.exports = main;
