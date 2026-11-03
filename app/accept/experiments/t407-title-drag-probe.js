'use strict';
/**
 * 工单407 真机探针：标题栏原生拖动起止、源窗口归属与松手落点的可靠识别
 * （spec #403 决策「原生拖动手势先探针后接入」，#407 验收标准①）。
 *
 * 定位：**取证探针**（app/accept/experiments/ 先例，同 t371/t372/t373），**不是验收
 * 电池段**。要证明的生产假设：
 *
 *   ① EVENT_SYSTEM_MOVESIZESTART / MOVESIZEEND（SetWinEventHook 全局钩子）对**真实
 *      标题栏拖动**可靠起止：起止各恰好一帧、hwnd 即被拖窗口的根窗（GA_ROOT 同一）；
 *   ② 源窗口归属可识别：hwnd 属主进程的 exe 身份可读、且拖动期间 GetWindowRect 跟随
 *      变化（是真实窗口移动，不是 Chromium OLE 图标拖拽——后者不发 MOVESIZE 族事件，
 *      「拖拽身份」永远不会混入本判定路径，负对照③补证）；
 *   ③ 负对照：对非标题栏区域做同款按下-拖动-松开 → 零 MOVESIZE 事件（普通鼠标拖拽
 *      不产生拖动会话——事件源只认标题栏移动手势）；
 *   ④ 松手落点可识别：拖动期间 GetCursorPos 25ms 采样持续更新（模态移动循环不清空
 *      光标事实），松手时刻采样点与目标落点一致（容差内）——落点判定与任务栏热区
 *      跟踪器同一光标事实源（hotzone.ts 25ms GetCursorPos 轮询）。
 *
 * 方法：被拖窗用 csc 现编译 WinForms 探针窗（工单380/378 电池既有夹具形态——**他进程
 * 真实窗口**；自建窗口属本线程时 DefWindowProc 模态拖动循环重入 koffi 回调不可信）。
 * SendInput 真实按下标题栏 → 分步移动 → 目标点松开；全程 25ms 光标采样 + MOVESIZE
 * 事件记录；消息泵照 t371 pumpDuring（WinEvent OUTOFCONTEXT 回调依赖本线程消息循环
 * 派发）。
 *
 * 用法（**必须经 accept-guard 托管**，禁裸跑——SendInput 移动真实光标，本机多检出
 * 共享同一验收槽）：
 *   node D:\test-folder\.accept-guard\guard.mjs hold --as zcode --purpose selftest -- \
 *     node app\accept\experiments\t407-title-drag-probe.js
 *
 * 退出码：0 = 断言全过；1 = 有断言不成立（证据照常打印）；2 = 环境/时序问题。
 */
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const win32 = require('../lib/win32');
const { mouseInput, LEFTDOWN, LEFTUP, send, moveMousePhys, exeOfPid, threadIdOf,
  SetForegroundWindow, BringWindowToTop, windowFromPointRoot } = win32;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const findings = [];
function say(s) { console.log(s); findings.push(s); }
const failures = [];
function check(desc, ok, detail = '') {
  const line = `${ok ? 'PASS' : 'FAIL'} ${desc}${detail ? ' —— ' + detail : ''}`;
  say(line);
  if (!ok) failures.push(desc);
  return ok;
}

// ————————————————————————————————————————————————————————————
// Win32 绑定（T407_ 前缀具名单登，#153 教训）
// ————————————————————————————————————————————————————————————
const koffi = win32.koffi;
const user32 = koffi.load('user32.dll');
koffi.struct('T407_POINT', { x: 'long', y: 'long' });
koffi.struct('T407_MSG', { hwnd: 'uintptr_t', message: 'uint32', wParam: 'uintptr_t', lParam: 'intptr_t', time: 'uint32', pt: 'T407_POINT', lPrivate: 'uint32' });
koffi.struct('T407_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });

const SetWinEventHook = user32.func('void * __stdcall SetWinEventHook(uint32 eventMin, uint32 eventMax, void *hmodWinEventProc, void *pfnWinEventProc, uint32 idProcess, uint32 idThread, uint32 dwFlags)');
const UnhookWinEvent = user32.func('bool __stdcall UnhookWinEvent(void *hWinEventHook)');
const GetCursorPosU = user32.func('bool __stdcall GetCursorPos(_Out_ T407_POINT *pt)');
const GetAncestorU = user32.func('uintptr_t __stdcall GetAncestor(uintptr_t hwnd, uint32 gaFlags)');
const GetWindowRectU = user32.func('bool __stdcall GetWindowRect(uintptr_t hwnd, _Out_ T407_RECT *r)');
const PeekMessageW = user32.func('bool __stdcall PeekMessageW(_Out_ T407_MSG *lpMsg, uintptr_t hWnd, uint32 min, uint32 max, uint32 remove)');
const TranslateMessage = user32.func('bool __stdcall TranslateMessage(const T407_MSG *lpMsg)');
const DispatchMessageW = user32.func('intptr_t __stdcall DispatchMessageW(const T407_MSG *lpMsg)');

const WINEVENTPROC = koffi.proto('__stdcall', 'T407_WineventProc', 'void', ['void *', 'uint32', 'uintptr_t', 'int32', 'int32', 'uint32', 'uint32']);
const EVENT_SYSTEM_MOVESIZESTART = 0x000A, EVENT_SYSTEM_MOVESIZEEND = 0x000B;
const WINEVENT_OUTOFCONTEXT = 0, GA_ROOT = 2, PM_REMOVE = 1;

function cursorPoint() {
  const pt = { x: 0, y: 0 };
  if (!GetCursorPosU(pt)) return null;
  return { x: pt.x, y: pt.y };
}
function windowRect(hwnd) {
  const r = { left: 0, top: 0, right: 0, bottom: 0 };
  return GetWindowRectU(hwnd, r) ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null;
}

// 消息泵（t371 pumpDuring 同款：Peek 非阻塞自旋）
async function pumpDuring(during) {
  const msg = [null];
  let stop = false;
  const tick = async () => {
    while (PeekMessageW(msg, 0, 0, 0, PM_REMOVE)) {
      TranslateMessage(msg[0]);
      DispatchMessageW(msg[0]);
    }
    if (!stop) setTimeout(tick, 10);
  };
  setTimeout(tick, 0);
  try { await during(); } finally { stop = true; }
}

// ————————————————————————————————————————————————————————————
// 被拖窗：csc 现编译 WinForms 探针（他进程真实窗口，desktop-switch.js seedProbe380 同款）
// ————————————————————————————————————————————————————————————
const PROBE_CS = `
using System;
using System.Drawing;
using System.Windows.Forms;
static class Probe {
  [STAThread]
  static void Main() {
    Form f = new Form();
    f.Text = "t407 title-drag probe";
    f.StartPosition = FormStartPosition.Manual;
    f.Bounds = new Rectangle(100, 100, 360, 240);
    Application.Run(f);
  }
}
`;
function seedProbe() {
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  const csc = path.join(sysRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  if (!fs.existsSync(csc)) throw new Error('csc.exe 缺失（.NET Framework4.x）——环境问题');
  const tmpDir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'deck-t407-'));
  const csFile = path.join(tmpDir, 'probe.cs');
  fs.writeFileSync(csFile, PROBE_CS, 'utf8');
  const exe = path.join(tmpDir, 'DECK-T407-PROBE.exe');
  const built = spawnSync(csc, ['/nologo', '/target:winexe', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
    `/out:${exe}`, csFile], { encoding: 'utf8' });
  if (built.status !== 0 || !fs.existsSync(exe)) {
    throw new Error(`探针编译失败：status=${built.status} ${(built.stderr || '').trim().slice(0, 200)}`);
  }
  return { tmpDir, exe };
}
function probeWindow(exe) {
  const target = String(exe).replace(/\//g, '\\').toLowerCase();
  for (const h of win32.topLevelWindows()) {
    if (!win32.IsWindowVisible(h)) continue;
    const wExe = String(exeOfPid(threadIdOf(h).pid) || '').replace(/\//g, '\\').toLowerCase();
    if (wExe === target) return h;
  }
  return 0;
}

async function main() {
  let exitCode = 0;
  let probe = null;
  let probeChild = null;
  let hookHandle = null;
  try {
    probe = seedProbe();
    probeChild = spawn(probe.exe, [], { stdio: 'ignore' });
    let probeHwnd = 0;
    for (let i = 0; i < 50 && !probeHwnd; i++) { probeHwnd = probeWindow(probe.exe); if (!probeHwnd) await sleep(120); }
    if (!probeHwnd) throw new Error('探针窗未出现——环境问题');
    // 前台（SendInput 点击进模态移动循环要求目标窗可收鼠标；模态循环在被拖窗自己的线程）
    try { BringWindowToTop(probeHwnd); SetForegroundWindow(probeHwnd); } catch { /* 尽力 */ }
    await sleep(300);
    const probeExe = String(exeOfPid(threadIdOf(probeHwnd).pid) || '');

    // MOVESIZE 事件记录（起止 hwnd + 时间戳）
    const movesizeEvents = [];
    const wineventCb = koffi.register((_hHook, event, hwnd, idObject, idChild) => {
      if (idObject !== 0 /* OBJID_WINDOW */ || idChild !== 0) return;
      movesizeEvents.push({ event, hwnd: Number(hwnd), t: Date.now() });
    }, 'T407_WineventProc *');
    hookHandle = SetWinEventHook(EVENT_SYSTEM_MOVESIZESTART, EVENT_SYSTEM_MOVESIZEEND, null, wineventCb, 0, 0, WINEVENT_OUTOFCONTEXT);
    if (!hookHandle) throw new Error('SetWinEventHook 失败');

    // 拖动期间 25ms 光标采样（与生产 hotzone.ts 同频同源）
    const samples = [];
    const sampler = setInterval(() => { const p = cursorPoint(); if (p) samples.push({ ...p, t: Date.now() }); }, 25);

    const rectBefore = windowRect(probeHwnd);
    const titleBar = { x: Math.round((rectBefore.left + rectBefore.right) * 0.3), y: rectBefore.top + 14 }; // 标题栏内 14px（378 电池同款 30% 横位）
    // 前置复核：按下点必须真落在探针窗（z 序被盖时 SendInput 点击落到别的窗）
    const pressOwner = windowFromPointRoot(titleBar);
    say(`探针窗 hwnd=${probeHwnd} exe=${probeExe} 起始矩形=${JSON.stringify(rectBefore)}`);
    say(`按下点 (${titleBar.x},${titleBar.y}) 归属复核：WindowFromPoint=${pressOwner} 命中=${pressOwner === probeHwnd}`);
    if (pressOwner !== probeHwnd) throw new Error('按下点未被探针窗持有（前置失守，本轮未取证）');
    const dropTarget = { x: rectBefore.right + 160, y: rectBefore.bottom + 60 };
    say(`计划：按下标题栏 → 拖到 (${dropTarget.x},${dropTarget.y}) 松开`);

    await pumpDuring(async () => {
      moveMousePhys(titleBar.x, titleBar.y);
      await sleep(120);
      send([mouseInput(0, 0, LEFTDOWN)]);
      await sleep(120);
      // 分步真实拖动（14 步 ≈ 700ms）——模态移动循环在被拖窗线程，采样器持续工作
      const STEPS = 14;
      for (let i = 1; i <= STEPS; i++) {
        const x = Math.round(titleBar.x + ((dropTarget.x - titleBar.x) * i) / STEPS);
        const y = Math.round(titleBar.y + ((dropTarget.y - titleBar.y) * i) / STEPS);
        moveMousePhys(x, y);
        await sleep(50);
      }
      moveMousePhys(dropTarget.x, dropTarget.y);
      await sleep(150);
      send([mouseInput(0, 0, LEFTUP)]);
      await sleep(400); // MOVESIZEEND 派发余量
    });
    clearInterval(sampler);

    // —— 断言①：起止恰好各一帧、hwnd 即被拖窗根窗 ——
    const starts = movesizeEvents.filter((e) => e.event === EVENT_SYSTEM_MOVESIZESTART);
    const ends = movesizeEvents.filter((e) => e.event === EVENT_SYSTEM_MOVESIZEEND);
    const rootOf = (h) => Number(GetAncestorU(h, GA_ROOT)) || h;
    check('① 标题栏拖动 MOVESIZESTART 恰好一帧', starts.length === 1, `事件=${JSON.stringify(movesizeEvents)}`);
    check('① MOVESIZEEND 恰好一帧且晚于 START', ends.length === 1 && starts.length === 1 && ends[0].t >= starts[0].t, `end=${JSON.stringify(ends)}`);
    check('① 起/止 hwnd = 被拖探针窗（GA_ROOT 同一）',
      starts.length === 1 && ends.length === 1
      && rootOf(starts[0].hwnd) === probeHwnd && rootOf(ends[0].hwnd) === probeHwnd,
      `start hwnd=${starts[0] && starts[0].hwnd} end hwnd=${ends[0] && ends[0].hwnd} probe=${probeHwnd}`);

    // —— 断言②：源窗口归属可识别（exe 身份 + 真实移动） ——
    let dragExe = '';
    try { dragExe = starts.length === 1 ? (exeOfPid(threadIdOf(starts[0].hwnd).pid) || '') : ''; } catch { /* 身份读失败照实呈现 */ }
    check('② 事件 hwnd 的 exe 身份可读且与被拖窗同源（归属来自 MOVESIZE hwnd，非拖拽通道）',
      !!dragExe && probeExe.toLowerCase() === dragExe.toLowerCase(),
      `probeExe=${probeExe} dragExe=${dragExe}`);
    const rectAfter = windowRect(probeHwnd);
    const moved = rectBefore && rectAfter && (rectBefore.left !== rectAfter.left || rectBefore.top !== rectAfter.top);
    check('② 拖动是真实窗口移动（GetWindowRect 前后变化——非 OLE 图标拖拽形态）', moved,
      `before=${JSON.stringify(rectBefore)} after=${JSON.stringify(rectAfter)}`);

    // —— 断言③：负对照——非标题栏按下-拖动-松开不产生 MOVESIZE 事件 ——
    const beforeNeg = movesizeEvents.length;
    await pumpDuring(async () => {
      const p = cursorPoint();
      const ny = p.y - 200 > 0 ? p.y - 200 : p.y + 200;
      moveMousePhys(p.x, ny); // 桌面空白处（远离任何标题栏）
      await sleep(150);
      send([mouseInput(0, 0, LEFTDOWN)]);
      await sleep(80);
      for (let i = 1; i <= 6; i++) { moveMousePhys(p.x + i * 12, ny + i * 8); await sleep(40); }
      send([mouseInput(0, 0, LEFTUP)]);
      await sleep(300);
    });
    const negEvents = movesizeEvents.slice(beforeNeg);
    check('③ 负对照：桌面空白处拖拽零 MOVESIZE 事件（事件源只认标题栏移动手势）', negEvents.length === 0,
      `负对照事件=${JSON.stringify(negEvents)}`);

    // —— 断言④：松手落点可识别（模态循环期间光标事实持续更新，终点 = 松手点） ——
    const t0 = starts.length === 1 ? starts[0].t : -1;
    const t1 = ends.length === 1 ? ends[0].t : -1;
    const duringDrag = samples.filter((s) => t0 > 0 && s.t > t0 && s.t < t1);
    const tracking = duringDrag.length >= 3 && new Set(duringDrag.map((s) => `${s.x},${s.y}`)).size >= 3;
    const afterSamples = samples.filter((s) => t1 > 0 && s.t >= t1 - 25);
    const finalSample = afterSamples.length ? afterSamples[0] : (duringDrag.length ? duringDrag[duringDrag.length - 1] : null);
    const dropOk = finalSample && Math.abs(finalSample.x - dropTarget.x) <= 24 && Math.abs(finalSample.y - dropTarget.y) <= 24;
    check('④ 拖动期间 GetCursorPos 采样持续更新（≥3 个不同点）', tracking,
      `拖动中采样=${duringDrag.length} 不同点=${new Set(duringDrag.map((s) => `${s.x},${s.y}`)).size}`);
    check('④ 松手时刻采样点 = 目标落点（容差 24px）', dropOk,
      `终采样=${JSON.stringify(finalSample)} 目标=${JSON.stringify(dropTarget)}`);

    say('');
    say(`事件账目：${JSON.stringify(movesizeEvents)}`);
    say(`采样账目：${samples.length} 点（首=${JSON.stringify(samples[0] || null)} 末=${JSON.stringify(samples[samples.length - 1] || null)}）`);

    exitCode = failures.length === 0 ? 0 : 1;
  } catch (err) {
    say(`探针异常（本轮未取到证据，按环境问题处理）: ${err && err.stack || err}`);
    exitCode = 2;
  } finally {
    if (hookHandle) { try { UnhookWinEvent(hookHandle); } catch { /* 尽力 */ } }
    if (probeChild) spawnSync('taskkill', ['/PID', String(probeChild.pid), '/T', '/F'], { stdio: 'ignore' });
    if (probe) { try { fs.rmSync(probe.tmpDir, { recursive: true, force: true }); } catch { /* 尽力清场 */ } }
  }
  say(`—— t407 探针结论：${exitCode === 0 ? 'GO（原生能力成立）' : exitCode === 1 ? 'NO-GO（有断言不成立）' : '环境问题（未取证）'} ——`);
  return exitCode;
}

Promise.resolve(main()).then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(2); });
