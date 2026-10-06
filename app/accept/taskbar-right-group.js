'use strict';
// 工单55 任务栏右组验收：控制器以 --accept-taskbar-right-group 身份运行，
// 拉起 --panel-accept 面板子进程（绕开单实例锁，与常驻面板共存），逐项验收：
//   P1 右组 pill 在场（摘要+音量+时钟三格）、显示桌面细条钉屏幕最右端（撑满条带高）
//   P2 硬件摘要五项数值与硬件卡口径一致（紧邻双读 + 容差重试——两边同拍 1Hz，
//      读取跨拍允许小幅波动；GPU/网络源缺位时两边同落占位符）
//   P3 时钟格点击 → 原生通知中心前台（Win+N）
//   P4 音量格点击 → 原生快速设置前台（Win+A）
//   P5 显示桌面细条点击 → ToggleDesktop（notepad 探针：一点全最小化、再点还原）
//   P6 勾选子集持久化：set-metrics 落盘 config.json、任务栏页即时收敛、
//      面板重拉（重启保持）后摘要仍只有勾选子集
// 运行：npm run accept:taskbar-right-group（= electron . --accept-taskbar-right-group）。
const { app, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const win32 = require('./lib/win32');
const { Report } = require('./lib/report');

const APP_ROOT = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(APP_ROOT, 'config.json');
const EVENTS_FILE = path.join(__dirname, 'evidence', '55-taskbar-right-group-events.jsonl');
const CDP_PORT = 9225;
const TASKBAR_TITLE = 'DECK-TASKBAR';
const PANEL_TITLE = 'AGENT DECK';
const VK_ESC = 0x1b;

const { nativeTaskbarVisible, ensureNativeTaskbarVisible } = win32;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findWindow(pid, title) {
  for (const h of win32.topLevelWindows()) {
    if (win32.threadIdOf(h).pid === pid && titleOf(h) === title) return h;
  }
  return null;
}

const koffi = win32.koffi;
const user32 = koffi.load('user32.dll');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(uintptr_t hWnd, uint16 *buf, int nMax)');

function titleOf(hwnd) {
  const buf = Buffer.alloc(512);
  const n = GetWindowTextW(hwnd, buf, 256);
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(buf.readUInt16LE(i * 2));
  return s;
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

async function waitWindow(pid, title, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const h = findWindow(pid, title);
    if (h) return h;
    await sleep(120);
  }
  return null;
}

/** 按归属 exe basename 等窗口在台（探针类无标题/多窗口的进程用） */
async function waitWindowByExe(exe, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const h of win32.topLevelWindows()) {
      if (win32.IsWindowVisible(h) && String(win32.exeNameOfWindow(h) || '').toLowerCase() === exe) return h;
    }
    await sleep(120);
  }
  return null;
}

/** 前台窗口取证：hwnd + 类名 + 归属 exe basename */
function foregroundInfo() {
  const h = Number(win32.GetForegroundWindow());
  if (!h) return null;
  return { hwnd: h, cls: win32.className(h), exe: win32.exeNameOfWindow(h) };
}

async function waitForeground(pred, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = foregroundInfo();
    if (info && pred(info)) return info;
    await sleep(100);
  }
  return null;
}

/** 浮层前台判据（工单55 探针实证，Win11 25H2）：
 * 通知中心（Win+N）= shellexperiencehost 承载的 CoreWindow（原生 Win11 为 explorer
 * CoreWindow，两形态都认）；快速设置（Win+A）= shellhost 的 ControlCenterWindow
 * （原生 Win11 同为 explorer CoreWindow，作回退形态）。 */
const isNotificationCenter = (i) => i.cls === 'Windows.UI.Core.CoreWindow' && (i.exe === 'shellexperiencehost' || i.exe === 'explorer');
const isQuickSettings = (i) => (i.cls === 'ControlCenterWindow' && i.exe === 'shellhost')
  || (i.cls === 'Windows.UI.Core.CoreWindow' && i.exe === 'explorer');
const isDesktop = (i) => i.cls === 'Progman' || i.cls === 'WorkerW';

/** Esc 关浮层并等前台让出（前台语义判据，同 taskbar.js 纪律） */
async function dismissFlyout() {
  for (let attempt = 0; attempt < 3; attempt++) {
    win32.tapKeys([VK_ESC]);
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const fg = foregroundInfo();
      if (!fg || (!isNotificationCenter(fg) && !isQuickSettings(fg))) return true;
      await sleep(150);
    }
  }
  return false;
}

function launchPanel() {
  return spawn(process.execPath, ['.', '--panel-accept'], {
    cwd: APP_ROOT,
    env: { ...process.env, DECK_EVENT_LOG: EVENTS_FILE, DECK_CDP_PORT: String(CDP_PORT) },
    stdio: 'ignore',
  });
}

/** CDP 在指定标题的页里执行表达式并取回值（任务栏页与面板页同属面板子进程的 targets） */
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

/** 点真机坐标前的 z 序/热区收敛（taskbar.js 同款纪律：移入刷新热区 + WindowFromPoint 轮询） */
async function convergeAt(pt, tbHwnd) {
  win32.moveMousePhys(pt.x, pt.y);
  for (let i = 0; i < 32; i++) {
    await sleep(250);
    if (win32.windowFromPointRoot(pt) === tbHwnd) return true;
  }
  return false;
}

function killTree(child, panelPid) {
  if (panelPid) spawnSync('taskkill', ['/PID', String(panelPid), '/T', '/F'], { stdio: 'ignore' });
  try { child.kill(); } catch { /* 已退出 */ }
}

/** 覆写 config.json 的 taskbar 段字段（保留其余字段原文档位；文件缺位先落最小桩——
 * 面板 loadConfig 会按默认值补齐其余段）。返回原文供 finally 还原（null = 原本无文件） */
function writeTaskbarFields(patch) {
  const raw = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, 'utf8') : null;
  const json = raw ? JSON.parse(raw) : {};
  json.taskbar = { ...(json.taskbar ?? {}), ...patch };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(json, null, 2) + '\n', 'utf8');
  return raw;
}

/** 硬件卡五项文本解析（#hw-line1/line2 innerText）→ {cpu,gpu,ram,dl,up}（缺位 = null） */
function parseCardText(t1, t2) {
  const num = (m) => (m ? Number(m[1]) : null);
  return {
    cpu: num(/CPU\s+(\d+)%/.exec(t1)),
    gpu: num(/GPU\s+(\d+)%/.exec(t1)),
    ram: num(/RAM\s+(\d+)%/.exec(t2)),
    dl: num(/DL\s+([\d.]+)KB\/s/.exec(t2)),
    up: num(/UP\s+([\d.]+)KB\/s/.exec(t2)),
  };
}

/** 任务栏摘要文本解析（「CPU 12% GPU 79% RAM 46% DL 1.23KB/s UP 0.00KB/s」，缺位 = ---） */
function parseSummaryText(t) {
  const num = (m) => (m ? Number(m[1]) : null);
  return {
    cpu: num(/CPU\s+(\d+)%/.exec(t)),
    gpu: num(/GPU\s+(\d+)%/.exec(t)),
    ram: num(/RAM\s+(\d+)%/.exec(t)),
    dl: num(/DL\s+([\d.]+)KB\/s/.exec(t)),
    up: num(/UP\s+([\d.]+)KB\/s/.exec(t)),
  };
}

async function main() {
  const rep = new Report('55-taskbar-right-group');
  let child = null;
  let panelPid = 0;
  let notepad = null;
  const originalConfig = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, 'utf8') : null;
  const finish = () => {
    const v = rep.verdict(rep.fails === 0 ? 'PASS' : 'FAIL');
    app.exit(v.fails === 0 ? 0 : 1);
  };

  try {
    fs.writeFileSync(EVENTS_FILE, '', 'utf8');
    writeTaskbarFields({ enabled: true, metrics: ['cpu', 'gpu', 'ram', 'net-down', 'net-up'] });

    // —— 拉起面板子进程（任务栏启用态）——
    child = launchPanel();
    const boot = await waitEvent('boot', null, 15000);
    if (!boot) throw new Error('面板子进程未上报 boot 事件');
    panelPid = boot.pid;
    rep.note(`面板 pid=${panelPid}`);

    const tbHwnd = await waitWindow(panelPid, TASKBAR_TITLE, 12000);
    if (!tbHwnd) throw new Error('任务栏窗口未出现');
    const tbRect = win32.rectOf(tbHwnd);
    const dip = screen.getPrimaryDisplay().bounds;
    const scale = (tbRect.right - tbRect.left) / dip.width;
    const toPhys = (cssX, cssY) => ({
      x: Math.round(tbRect.left + cssX * scale),
      y: Math.round(tbRect.top + cssY * scale),
    });

    // 等右组渲染就绪 + 首个 1Hz 数据帧（摘要数值就位）
    const ready = await waitEvent('taskbar-ready', (e) => e.rightPill && e.sliver, 10000);
    if (!ready) throw new Error('taskbar-ready 存证缺失右组矩形（无法取点击坐标）');
    const statusEv = await waitEvent('taskbar-right-status', (e) => e.values && e.values.cpu, 10000);
    if (!statusEv) throw new Error('taskbar-right-status 存证缺失（右组 1Hz 数据帧未到达）');
    const cellOf = (id) => {
      const c = ready.rightCells.find((x) => x.id === id);
      if (!c) throw new Error(`rightCells 缺 ${id} 格`);
      return toPhys(c.x + c.w / 2, c.y + c.h / 2);
    };

    // P1 右组 pill 在场 + 细条钉屏幕最右端（右缘贴屏右、撑满条带高）
    const sliver = ready.sliver;
    const sliverRightPhys = tbRect.left + (sliver.x + sliver.w) * scale;
    const sliverHPhys = sliver.h * scale;
    const stripHPhys = tbRect.bottom - tbRect.top;
    const cellIds = ready.rightCells.map((c) => c.id);
    const cellsOk = ['hw-summary', 'volume', 'clock'].every((id) => cellIds.includes(id));
    const screenRightPhys = (dip.x + dip.width) * scale; // 屏右缘（物理像素；条带恒通栏）
    const sliverOk = Math.abs(sliverRightPhys - screenRightPhys) <= 4 * scale
      && Math.abs(sliverRightPhys - tbRect.right) <= 4 * scale
      && Math.abs(sliverHPhys - stripHPhys) <= 2 * scale;
    if (cellsOk && sliverOk) {
      rep.pass(`P1 右组 pill 在场（${cellIds.join('/')}），显示桌面细条钉屏幕最右端（右缘≈屏右、撑满条带高）`);
    } else {
      rep.fail(`P1 格清单=${JSON.stringify(cellIds)} 细条=${JSON.stringify({ sliverRightPhys, tbRight: tbRect.right, sliverHPhys, stripHPhys })}`);
    }

    // P2 摘要五项数值与硬件卡口径一致：紧邻双读（任务栏页摘要 DOM ↔ 面板页硬件卡 DOM），
    // 容差重试——两边同拍 1Hz 推送，读取跨拍允许小幅波动。
    let p2ok = false;
    let p2detail = '';
    for (let round = 0; round < 8 && !p2ok; round++) {
      await sleep(300);
      const sumText = await cdpEval(TASKBAR_TITLE, `document.getElementById('hw-summary').innerText`);
      const card = await cdpEval(PANEL_TITLE, `document.getElementById('hw-line1').innerText + '\\n' + document.getElementById('hw-line2').innerText`);
      const [c1, c2] = String(card).split('\n');
      const sum = parseSummaryText(String(sumText));
      const ref = parseCardText(c1 ?? '', c2 ?? '');
      const pctClose = (a, b) => (a === null && b === null) || (a !== null && b !== null && Math.abs(a - b) <= 5);
      const rateClose = (a, b) => (a === null && b === null) || (a !== null && b !== null && Math.abs(a - b) <= Math.max(50, Math.abs(b) * 0.5));
      p2ok = pctClose(sum.cpu, ref.cpu) && pctClose(sum.gpu, ref.gpu) && pctClose(sum.ram, ref.ram)
        && rateClose(sum.dl, ref.dl) && rateClose(sum.up, ref.up);
      p2detail = `摘要=${JSON.stringify(sum)} 硬件卡=${JSON.stringify(ref)}`;
    }
    if (p2ok) rep.pass(`P2 硬件摘要五项与硬件卡口径一致（${p2detail}）`);
    else rep.fail(`P2 口径比对 8 轮未收敛：${p2detail}`);

    // —— 系统动作三格（P3/P4/P5）：点击前统一收敛 z 序/热区 ——
    // P3 时钟格 → 原生通知中心（Win+N）
    const beforeP3 = foregroundInfo();
    const clockPt = cellOf('clock');
    const convP3 = await convergeAt(clockPt, tbHwnd);
    rep.note(`P3 点击前收敛=${convP3}`);
    win32.clickPhys(clockPt.x, clockPt.y, 'left');
    const evP3 = await waitEvent('taskbar-action-result', (e) => e.action === 'notification-center' && e.t >= Date.now() - 6000, 5000);
    const fgP3 = await waitForeground((i) => isNotificationCenter(i) && (!beforeP3 || i.hwnd !== beforeP3.hwnd), 6000);
    if (convP3 && evP3 && evP3.ok && fgP3) {
      rep.pass(`P3 时钟格弹出原生通知中心（前台 ${fgP3.exe} / ${fgP3.cls}）`);
    } else {
      rep.fail(`P3 收敛=${convP3} 合成回执=${JSON.stringify(evP3)} 前台=${JSON.stringify(fgP3)}`);
    }
    const closedP3 = await dismissFlyout();
    rep.note(`通知中心收起=${closedP3}`);
    await sleep(600);

    // P4 音量格 → 原生快速设置（Win+A）
    const beforeP4 = foregroundInfo();
    const volPt = cellOf('volume');
    const convP4 = await convergeAt(volPt, tbHwnd);
    rep.note(`P4 点击前收敛=${convP4}`);
    win32.clickPhys(volPt.x, volPt.y, 'left');
    const evP4 = await waitEvent('taskbar-action-result', (e) => e.action === 'quick-settings' && e.t >= Date.now() - 6000, 5000);
    const fgP4 = await waitForeground((i) => isQuickSettings(i) && (!beforeP4 || i.hwnd !== beforeP4.hwnd), 6000);
    if (convP4 && evP4 && evP4.ok && fgP4) {
      rep.pass(`P4 音量格弹出原生快速设置（前台 ${fgP4.exe} / ${fgP4.cls}）`);
    } else {
      rep.fail(`P4 收敛=${convP4} 合成回执=${JSON.stringify(evP4)} 前台=${JSON.stringify(fgP4)}`);
    }
    const closedP4 = await dismissFlyout();
    rep.note(`快速设置收起=${closedP4}`);
    await sleep(600);

    // P5 显示桌面细条 → ToggleDesktop：notepad 探针（一点全最小化落桌面、再点还原回前台）
    notepad = spawn('notepad.exe', [], { stdio: 'ignore' });
    // 新窗口能不能自抢前台取决于启动方此刻是否持前台：本控制器刚做完 P4 的浮层收势，
    // 前台在原生任务栏（explorer）手里，spawn 出来的 notepad 会被 Win 前台锁挡在台外
    // （实测冷启 371ms 就有窗口，却始终等不到前台）。显式提前台，探针起点才干净。
    const noteHwnd = await waitWindowByExe('notepad', 8000);
    if (noteHwnd) {
      win32.SetForegroundWindow(noteHwnd);
      await sleep(300);
    }
    const fgNote = await waitForeground((i) => i.exe === 'notepad', 8000);
    const sliverPt = toPhys(sliver.x + sliver.w / 2, sliver.y + sliver.h / 2);
    let p5min = null;
    let p5restore = null;
    let evP5a = null;
    let evP5b = null;
    if (fgNote) {
      const convP5 = await convergeAt(sliverPt, tbHwnd);
      rep.note(`P5 点击前收敛=${convP5}`);
      win32.clickPhys(sliverPt.x, sliverPt.y, 'left');
      evP5a = await waitEvent('taskbar-action-result', (e) => e.action === 'toggle-desktop' && e.t >= Date.now() - 6000, 5000);
      p5min = await waitForeground(isDesktop, 6000);
      await sleep(400);
      // 再点一次：Win+D 反 toggle 还原 notepad 前台（对齐 Win11 右下角肌肉记忆）
      await convergeAt(sliverPt, tbHwnd);
      win32.clickPhys(sliverPt.x, sliverPt.y, 'left');
      evP5b = await waitEvent('taskbar-action-result', (e) => e.action === 'toggle-desktop' && e.t >= Date.now() - 4000, 5000);
      p5restore = await waitForeground((i) => i.exe === 'notepad', 6000);
    }
    if (fgNote && p5min && p5restore && evP5a && evP5a.ok && evP5b && evP5b.ok) {
      rep.pass('P5 显示桌面细条 ToggleDesktop：一点全最小化落桌面、再点 notepad 还原前台');
    } else {
      rep.fail(`P5 探针前台=${!!fgNote} 最小化=${JSON.stringify(p5min)} 还原=${JSON.stringify(p5restore)} 回执=${JSON.stringify([evP5a, evP5b])}`);
    }

    // P6 勾选子集持久化：CDP 面板页 set-metrics → 落盘 + 任务栏页即时收敛 + 重拉重启保持
    const r6 = await cdpEval(PANEL_TITLE, `window.deck.bridge.invoke('taskbar/set-metrics', { metrics: ['ram', 'cpu'] })`);
    await sleep(800); // 等 taskbar/changed 抵达任务栏页重渲染
    const disk6 = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const sumText6 = await cdpEval(TASKBAR_TITLE, `document.getElementById('hw-summary').innerText`);
    const live6 = /CPU/.test(String(sumText6)) && /RAM/.test(String(sumText6))
      && !/GPU/.test(String(sumText6)) && !/DL/.test(String(sumText6)) && !/UP/.test(String(sumText6));
    // 重拉面板（重启保持判据）
    killTree(child, panelPid);
    child = null;
    panelPid = 0;
    await sleep(1200);
    const since6 = Date.now();
    child = launchPanel();
    const boot6 = await waitEvent('boot', (e) => e.t >= since6, 15000);
    if (!boot6) throw new Error('P6 重拉面板子进程未上报 boot');
    panelPid = boot6.pid;
    await waitWindow(panelPid, TASKBAR_TITLE, 12000);
    const ready6 = await waitEvent('taskbar-ready', (e) => e.t >= since6 && e.rightCells, 10000);
    const ids6 = ready6 ? ready6.rightCells.map((c) => c.id) : [];
    const sumText6b = ready6 ? await cdpEval(TASKBAR_TITLE, `document.getElementById('hw-summary').innerText`) : '';
    const persist6 = /CPU/.test(String(sumText6b)) && /RAM/.test(String(sumText6b)) && !/GPU/.test(String(sumText6b));
    if (r6 && JSON.stringify(r6.metrics) === JSON.stringify(['cpu', 'ram'])
      && JSON.stringify(disk6.taskbar?.metrics) === JSON.stringify(['cpu', 'ram'])
      && live6 && persist6) {
      rep.pass('P6 勾选子集持久化：落盘 config.json、任务栏即时收敛为 CPU/RAM、重拉后保持（重启保持）');
    } else {
      rep.fail(`P6 响应=${JSON.stringify(r6)} 落盘=${JSON.stringify(disk6.taskbar)} 即时=${live6}(${sumText6}) 重拉=${persist6}(${sumText6b}) 格=${JSON.stringify(ids6)}`);
    }
  } catch (err) {
    rep.fail(`电池异常: ${err && err.stack || err}`);
  } finally {
    if (notepad) spawnSync('taskkill', ['/PID', String(notepad.pid), '/T', '/F'], { stdio: 'ignore' });
    killTree(child, panelPid);
    // config 还原：原本无文件则删掉电池落的最小桩（worktree 首跑场景）
    if (originalConfig !== null) fs.writeFileSync(CONFIG_FILE, originalConfig, 'utf8');
    else fs.rmSync(CONFIG_FILE, { force: true });
    // 工单50 清场：本电池无守卫兜底（--panel-accept 直跑），面板被 /F 清杀时原生
    // 任务栏可能留隐藏态——电池不得给用户留无系统入口的桌面
    ensureNativeTaskbarVisible();
    await dismissFlyout(); // 浮层残留不留给用户
    nativeTaskbarVisible()
      ? rep.note('清场核验：原生任务栏可见')
      : rep.note('清场核验：原生任务栏仍隐藏（兜底已尝试，需人工核查）');
  }

  finish();
}

module.exports = main;
