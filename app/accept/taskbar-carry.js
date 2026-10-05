'use strict';
// 工单50 任务栏显隐验收（原生任务栏隐藏/还原 + 逃生开关）：控制器以
// --accept-taskbar-carry 身份运行，分两阶段覆盖验收标准三条还原路径与自救开关：
//   阶段A（守卫链默认入口 spawn '.'，真 guard + watchdog 全链路）：
//     A1 接管开启 → 原生任务栏隐藏（taskbar-hidden 存证 + Shell_TrayWnd 不可见），
//        条带落屏底（净空归零，49 的让位净空仅剩降级档）
//     A2 正常退出（WM_CLOSE 面板主窗）→ 原生任务栏还原
//     A3 崩溃路径（taskkill /F /T 面板树，守卫存活）→ 守卫以 panel-exit 还原
//     A4 进程被杀路径（守卫 + 面板先后强杀，控制台信号同杀的等价现场）→
//        还原守护（icon-restore-watch）以 guard-dead 翻回，随后自退
//   阶段B（--panel-accept + CDP，逃生开关真机链路）：
//     B1 设置浮层关开关 → 原生任务栏即还原、条带销毁、config 落盘
//     B2 再开 → 原生任务栏再隐、条带回来
//   阶段C 偏好不扰：全程比对 StuckRects3 Settings（自动隐藏等任务栏偏好）字节不变。
// 运行：npm run accept:taskbar-carry（= electron . --accept-taskbar-carry）。
// 与其他验收同一铁律：必须经 accept-guard 托管（守卫链抢单实例锁，与常驻面板互斥）。
const { app, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const win32 = require('./lib/win32');
const { Report } = require('./lib/report');

const APP_ROOT = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(APP_ROOT, 'config.json');
const EVENTS_FILE = path.join(__dirname, 'evidence', '50-taskbar-carry-events.jsonl');
const CDP_PORT = 9224;
const TASKBAR_TITLE = 'DECK-TASKBAR';
const PANEL_TITLE = 'AGENT DECK';
const TASKBAR_HEIGHT_DIP = 48; // src/main/taskbar/window.ts TASKBAR_HEIGHT
const WM_CLOSE = 0x0010;

const koffi = win32.koffi;
const user32 = koffi.load('user32.dll');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(uintptr_t hWnd, uint16 *buf, int nMax)');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 原生任务栏视图事实/兜底还原共用 accept/lib/win32.js 导出（评审收口：四电池同一判据单点维护）
const { nativeTaskbarVisible, ensureNativeTaskbarVisible } = win32;

function titleOf(hwnd) {
  const buf = Buffer.alloc(512);
  const n = GetWindowTextW(hwnd, buf, 256);
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(buf.readUInt16LE(i * 2));
  return s;
}

function findWindow(pid, title) {
  for (const h of win32.topLevelWindows()) {
    if (win32.threadIdOf(h).pid === pid && titleOf(h) === title) return h;
  }
  return null;
}

function isTopmost(hwnd) {
  return (win32.GetWindowLongW(hwnd, win32.GWL_EXSTYLE) & win32.WS_EX_TOPMOST) !== 0;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
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

/** 等原生任务栏可见性到达期望态（还原/隐藏都有 explorer 动画与时序，轮询不赌单拍） */
async function waitNativeVisible(want, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (nativeTaskbarVisible() === want) return true;
    await sleep(120);
  }
  return nativeTaskbarVisible() === want;
}

/** 任务栏偏好取证（自动隐藏等）：StuckRects3 Settings 二进制原文；缺键记错误文本 */
function stuckRectsSettings() {
  const r = spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StuckRects3', '/v', 'Settings'],
    { encoding: 'utf8', timeout: 8000 });
  return r.status === 0 ? r.stdout : `ERR:${r.status}:${(r.stderr || '').trim()}`;
}

/** 覆写 config.json 的 taskbar.enabled（保留其余字段原文档位） */
function writeTaskbarEnabled(enabled) {
  const json = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  json.taskbar = { ...(json.taskbar ?? {}), enabled };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(json, null, 2) + '\n', 'utf8');
}

/** 守卫链（默认入口）：守卫 + 还原守护 + 面板全链路。返回 { child, guardPid }。 */
function launchGuardChain() {
  const child = spawn(process.execPath, ['.'], {
    cwd: APP_ROOT,
    env: { ...process.env, DECK_EVENT_LOG: EVENTS_FILE },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {}); // 排干管道防堵
  return child;
}

/** 验收面板（--panel-accept + CDP）：逃生开关阶段用（绕开单实例锁，无守卫）。 */
function launchPanelAccept() {
  return spawn(process.execPath, ['.', '--panel-accept'], {
    cwd: APP_ROOT,
    env: { ...process.env, DECK_EVENT_LOG: EVENTS_FILE, DECK_CDP_PORT: String(CDP_PORT) },
    stdio: 'ignore',
  });
}

function killTree(pid) {
  if (pid) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
}

/** 等子进程退出（守卫链正常退场 = 守卫随面板退出而 exit） */
async function waitExit(child, timeoutMs = 10000) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    await sleep(120);
  }
  return false;
}

/** CDP 驱动面板渲染层（逃生开关的 DOM 真机通道）：在面板页执行表达式并取回值 */
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

async function main() {
  const rep = new Report('50-taskbar-carry');
  const originalConfig = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, 'utf8') : null;
  const prefsBefore = stuckRectsSettings();
  let child = null;   // 当前阶段子进程（守卫链或 --panel-accept）
  let panelPid = 0;   // 面板真实主进程 pid（boot 自报）
  const finish = () => {
    const v = rep.verdict(rep.fails === 0 ? 'PASS' : 'FAIL');
    app.exit(v.fails === 0 ? 0 : 1);
  };

  try {
    fs.writeFileSync(EVENTS_FILE, '', 'utf8');
    writeTaskbarEnabled(true);
    if (!nativeTaskbarVisible()) {
      throw new Error('开跑前原生任务栏已隐藏（他方现场）——先还原再跑，电池不从脏现场出发');
    }

    // —— 阶段A：守卫链全链路（隐藏 + 三条还原路径）——
    // A1 接管开启 → 原生任务栏隐藏，条带落屏底
    child = launchGuardChain();
    const boot1 = await waitEvent('boot', null, 20000);
    if (!boot1) throw new Error('A1 守卫链面板未上报 boot');
    panelPid = boot1.pid;
    rep.note(`A1 守卫 pid=${child.pid} 面板 pid=${panelPid}`);
    const tbHwnd = await waitWindow(panelPid, TASKBAR_TITLE, 12000);
    if (!tbHwnd) throw new Error('A1 任务栏条带窗未出现');
    const hiddenEv = await waitEvent('taskbar-hidden', null, 5000);
    const nativeGone = await waitNativeVisible(false, 5000);
    // 条带几何：净空归零 → 底边 = 屏底（49 P1 同款物理↔DIP 换算）
    const dip = screen.getPrimaryDisplay().bounds;
    const rect = win32.rectOf(tbHwnd);
    const scale = (rect.right - rect.left) / dip.width;
    const heightDip = (rect.bottom - rect.top) / scale;
    const bottomDip = rect.bottom / scale;
    const geomOk = Math.abs(heightDip - TASKBAR_HEIGHT_DIP) <= 2 && Math.abs(bottomDip - dip.height) <= 2;
    if (hiddenEv && nativeGone && geomOk && isTopmost(tbHwnd)) {
      rep.pass(`A1 接管开启：原生任务栏隐藏（taskbar-hidden 存证 + 视图事实），条带落屏底（底边 DIP ${Math.round(bottomDip)}/${dip.height}）`);
    } else {
      rep.fail(`A1 隐藏存证=${!!hiddenEv} 视图已隐=${nativeGone} 几何=${JSON.stringify({ heightDip, bottomDip, dip: dip.height })} 置顶=${isTopmost(tbHwnd)}`);
    }

    // A2 正常退出（WM_CLOSE 面板主窗 → app.quit）→ 原生任务栏还原
    const sinceA2 = Date.now();
    const panelHwnd = await waitWindow(panelPid, PANEL_TITLE, 8000);
    if (!panelHwnd) throw new Error('A2 面板主窗未找到');
    win32.PostMessageW(panelHwnd, WM_CLOSE, 0, 0);
    const guardExited = await waitExit(child, 15000);
    const restoredA2 = await waitNativeVisible(true, 8000);
    const restoredEvA2 = await waitEvent('taskbar-restored', (e) => e.t >= sinceA2, 5000);
    if (guardExited && restoredA2 && restoredEvA2) {
      rep.pass(`A2 正常退出路径：原生任务栏还原（reason=${restoredEvA2.reason}，守卫随退=${guardExited}）`);
    } else {
      rep.fail(`A2 守卫退=${guardExited} 视图还原=${restoredA2} 存证=${JSON.stringify(restoredEvA2)}`);
    }
    child = null;

    // A3 崩溃路径（taskkill /F /T 面板树，守卫存活）→ 守卫 panel-exit 还原
    const sinceA3 = Date.now();
    child = launchGuardChain();
    const boot3 = await waitEvent('boot', (e) => e.t >= sinceA3, 20000);
    if (!boot3) throw new Error('A3 守卫链面板未上报 boot');
    panelPid = boot3.pid;
    if (!(await waitWindow(panelPid, TASKBAR_TITLE, 12000))) throw new Error('A3 条带窗未出现');
    if (!(await waitNativeVisible(false, 5000))) throw new Error('A3 原生任务栏未被隐藏（前置不成立）');
    killTree(panelPid); // 模拟崩溃/强杀：面板整树死，守卫存活
    const guardExited3 = await waitExit(child, 15000);
    const restoredA3 = await waitNativeVisible(true, 8000);
    const restoredEvA3 = await waitEvent('taskbar-restored', (e) => e.t >= sinceA3 && e.reason === 'panel-exit', 5000);
    if (restoredA3 && restoredEvA3) {
      rep.pass(`A3 崩溃路径：面板被 taskkill /F 后守卫还原原生任务栏（reason=panel-exit，守卫随退=${guardExited3}）`);
    } else {
      rep.fail(`A3 视图还原=${restoredA3} panel-exit 存证=${JSON.stringify(restoredEvA3)} 守卫退=${guardExited3}`);
    }
    child = null;

    // A4 进程被杀路径：守卫 + 面板先后强杀（控制台信号同杀的等价现场——守卫进程内
    // 还原钩子全灭），还原守护（detached 出生、无控制台收信号）以 guard-dead 翻回。
    const sinceA4 = Date.now();
    child = launchGuardChain();
    const boot4 = await waitEvent('boot', (e) => e.t >= sinceA4, 20000);
    if (!boot4) throw new Error('A4 守卫链面板未上报 boot');
    panelPid = boot4.pid;
    const guardPid4 = child.pid;
    const watchEv = await waitEvent('restore-watch-spawned', (e) => e.t >= sinceA4, 5000);
    const watchPid = watchEv ? watchEv.pid : 0;
    if (!(await waitWindow(panelPid, TASKBAR_TITLE, 12000))) throw new Error('A4 条带窗未出现');
    if (!(await waitNativeVisible(false, 5000))) throw new Error('A4 原生任务栏未被隐藏（前置不成立）');
    // 先杀守卫（不带 /T：守护是守卫的子进程，/T 会把它一起带走——守护的存活前提
    // 正是「控制台信号只同杀有控制台的进程」，这里用不带 /T 复刻该现场），再杀面板树。
    spawnSync('taskkill', ['/PID', String(guardPid4), '/F'], { stdio: 'ignore' });
    killTree(panelPid);
    const restoredA4 = await waitNativeVisible(true, 10000);
    const restoredEvA4 = await waitEvent('taskbar-restored', (e) => e.t >= sinceA4 && e.reason === 'guard-dead', 8000);
    let watchDead = false;
    for (let i = 0; i < 50 && !watchDead && watchPid; i++) { await sleep(200); watchDead = !pidAlive(watchPid); }
    if (restoredA4 && restoredEvA4 && watchPid && watchDead) {
      rep.pass(`A4 进程被杀路径：守卫+面板同杀后还原守护以 guard-dead 翻回原生任务栏（守护 pid=${watchPid} 已自退）`);
    } else {
      rep.fail(`A4 视图还原=${restoredA4} guard-dead 存证=${JSON.stringify(restoredEvA4)} 守护 pid=${watchPid} 自退=${watchDead}`);
    }
    child = null;

    // —— 阶段B：逃生开关真机链路（--panel-accept + CDP 驱动设置浮层真实 DOM）——
    const sinceB = Date.now();
    child = launchPanelAccept();
    const bootB = await waitEvent('boot', (e) => e.t >= sinceB, 20000);
    if (!bootB) throw new Error('B 验收面板未上报 boot');
    panelPid = bootB.pid;
    if (!(await waitWindow(panelPid, TASKBAR_TITLE, 12000))) throw new Error('B 条带窗未出现');
    if (!(await waitNativeVisible(false, 5000))) throw new Error('B 原生任务栏未被隐藏（前置不成立）');

    // B1 设置浮层关开关（真实 DOM 点击链：settings-btn → taskbar-toggle）→ 原生即还原
    await cdpEval(`document.getElementById('settings-btn').click()`);
    const openedEv = await waitEvent('settings-opened', (e) => e.t >= sinceB, 5000);
    if (!openedEv) throw new Error('B1 设置浮层未开（settings-opened 存证缺失）');
    if (!openedEv.taskbarToggle) throw new Error('B1 开层存证缺 taskbarToggle 矩形（渲染层未上报）');
    const toggleState = await cdpEval(`document.getElementById('taskbar-toggle').checked`);
    await cdpEval(`document.getElementById('taskbar-toggle').click()`);
    const setEvOff = await waitEvent('settings-taskbar-set', (e) => e.t >= sinceB && e.enabled === false, 6000);
    const nativeBackB1 = await waitNativeVisible(true, 8000);
    const diskOff = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    let stripGoneB1 = false;
    for (let i = 0; i < 25 && !stripGoneB1; i++) { await sleep(200); stripGoneB1 = !findWindow(panelPid, TASKBAR_TITLE); }
    if (toggleState === true && setEvOff && nativeBackB1 && stripGoneB1 && diskOff.taskbar?.enabled === false) {
      rep.pass('B1 逃生开关关闭：原生任务栏即还原、条带销毁、config 落盘（自救通道成立）');
    } else {
      rep.fail(`B1 初始勾选=${toggleState} 回执=${JSON.stringify(setEvOff)} 视图还原=${nativeBackB1} 条带销=${stripGoneB1} 落盘=${JSON.stringify(diskOff.taskbar)}`);
    }

    // B2 再开 → 原生再隐、条带回来（开关双向可用，非一次性自救）
    await cdpEval(`document.getElementById('taskbar-toggle').click()`);
    const setEvOn = await waitEvent('settings-taskbar-set', (e) => e.t >= sinceB && e.enabled === true, 6000);
    const nativeGoneB2 = await waitNativeVisible(false, 8000);
    const tbBackB2 = await waitWindow(panelPid, TASKBAR_TITLE, 8000);
    if (setEvOn && nativeGoneB2 && tbBackB2) {
      rep.pass('B2 逃生开关再开：原生任务栏再隐、条带恢复（开关双向可用）');
    } else {
      rep.fail(`B2 回执=${JSON.stringify(setEvOn)} 视图已隐=${nativeGoneB2} 条带回=${!!tbBackB2}`);
    }
  } catch (err) {
    rep.fail(`电池异常: ${err && err.stack || err}`);
  } finally {
    // 清场（自带容错：清场内部任何抛错都不能拦住 finish()，否则控制器不退、
    // accept-guard 租约被挂死——首轮实证教训）：杀子进程 → --icon-restore 自救通道
    // （工单50 起同通道还原图标 + 原生任务栏）→ 还原 config → 核验用户任务栏偏好
    // （自动隐藏等）字节级不变。
    try {
      try { killTree(panelPid); } catch { /* 尽力 */ }
      try { child && child.kill(); } catch { /* 尽力 */ }
      await sleep(800);
      try {
        spawnSync(process.execPath, ['.', '--icon-restore'], {
          cwd: APP_ROOT, env: { ...process.env, DECK_EVENT_LOG: EVENTS_FILE }, stdio: 'ignore', timeout: 20000,
        });
      } catch { /* 尽力 */ }
      await sleep(500);
      try { ensureNativeTaskbarVisible(); } catch { /* 兜底中的兜底也不许抛 */ }
      if (originalConfig !== null) { try { fs.writeFileSync(CONFIG_FILE, originalConfig, 'utf8'); } catch { /* 尽力 */ } }
      const prefsAfter = stuckRectsSettings();
      if (prefsAfter === prefsBefore) {
        rep.pass('C1 用户既有任务栏偏好未被改写（StuckRects3 Settings 全程字节不变）');
      } else {
        rep.fail(`C1 任务栏偏好被扰动：before=${JSON.stringify(prefsBefore)} after=${JSON.stringify(prefsAfter)}`);
      }
      try {
        (await waitNativeVisible(true, 5000))
          ? rep.note('清场核验：原生任务栏可见')
          : rep.note('清场核验：原生任务栏仍隐藏（ensure 兜底已尝试，需人工核查）');
      } catch (e) { rep.note(`清场核验异常: ${e && e.message || e}`); }
    } catch (e) {
      rep.note(`清场段异常（不拦截收尾）: ${e && e.message || e}`);
    }
  }

  finish();
}

module.exports = function carryBattery() {
  app.whenReady().then(() => main()).catch((e) => {
    // main 自带 try/finally 与内部 finish()，正常不会到这；真到了也要让控制器退出（租约不挂死）
    console.error('CARRY BATTERY CRASH:', e && e.stack || e);
    app.exit(2);
  });
};
