'use strict';
// 工单49 任务栏验收（tracer bullet）：控制器以 --accept-taskbar 身份运行，
// 拉起 --panel-accept 面板子进程（绕开单实例锁，与常驻面板共存），逐项验收：
//   P1 任务栏窗口在场：置顶（WS_EX_TOPMOST）+ 主屏底部通栏几何（工单50 起隐藏
//      原生任务栏后落屏底；49 的让位净空仅剩隐藏失败的降级档）
//   P2 面板本体钉底不受影响（面板窗在场、非置顶、pin 存证在流）
//   P3 pill 缝隙点击穿透、pill 热区命中（WindowFromPoint 双向往返）
//   P4 开始按钮弹出原生开始菜单（前台窗归 StartMenuExperienceHost）
//   P5 TaskView 按钮弹出原生任务视图（前台 CoreWindow 归 explorer）
//   P6 运行时禁用（CDP 驱动 taskbar/set-enabled）→ 窗口即销毁、原生任务栏还原、
//      config 落盘、面板不受影响
//   P7 运行时重新启用 → 窗口恢复（仍置顶）
//   P8 启动态禁用（config 门禁）→ 窗口不建，面板照常
//   P9 启动态恢复启用 → 窗口回来
//   P10 关-开连发竞态（#103 缺陷①）双触发：(a) 单次 evaluate 内两桥写毫秒级串联
//      （真实 agent 路径回归面）；(b) DECK_TASKBAR_BURST=1 重拉面板、主进程同一
//      JS 任务连发两次 setEnabled（destroy/create 零轮转、旧窗 closed 确定性迟到，
//      2026-10-11 红轮实证 renderer 双写够不到竞态窗）→ 两种连发后各断言：条带恰
//      一扇、随后完整禁用归零（孤儿检测器）、再启用恰一扇且新窗占位存证在场、
//      无乱序注销（新窗 registered 后冒 removed 即迟到 closed 误注销的直接证据）
//   P11 运行时交还（#153）：禁用即交还托盘宿主（竞争窗按属主归零 + stopped 存证），
//      重启用即收编（宿主重建 + 名单回填），停→起→停整周期（类注销对称性）
//   P12 宿主守恒（#153）：禁用态数据面强杀重启不复活宿主（respawn 按期望态）、
//      启态禁用（config 门禁）不建宿主
//   P13 栏高与图标尺寸（工单158）：条带 48→64DIP；应用组图标 32px/格位 44px；
//      托盘图标 24px（16px 源最近邻放大档、32px 源平滑降采样）——CDP computed
//      style 与几何存证帧互证；应用格位用 notepad 探针（栏上无应用时 1Hz 编排轮
//      1–2s 内上栏）
// 运行：npm run accept:taskbar（= electron . --accept-taskbar）。
const { app, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const win32 = require('./lib/win32');
const { Report } = require('./lib/report');
// config 读写/还原共通 helper（工单124）：缺位读不抛、缺位落桩、三态还原——四电池单点维护
const { readConfigRaw, patchTaskbar, restoreConfig, CONFIG_FILE } = require('./lib/battery-config');

const APP_ROOT = path.resolve(__dirname, '..');
const EVENTS_FILE = path.join(__dirname, 'evidence', '49-taskbar-events.jsonl');
const CDP_PORT = 9223;
const TASKBAR_TITLE = 'DECK-TASKBAR';
const PANEL_TITLE = 'AGENT DECK';
const TASKBAR_HEIGHT_DIP = 64; // src/main/taskbar/window.ts TASKBAR_HEIGHT（工单158 起 64）
const VK_ESC = 0x1b;

const koffi = win32.koffi;
const user32 = koffi.load('user32.dll');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(uintptr_t hWnd, uint16 *buf, int nMax)');
// 按类名走 Z 序枚举（nativeTrayWnd 同法）：Shell_TrayWnd 竞争窗是 0×0 隐藏窗，
// topLevelWindows() 只收可见窗永远看不见它（红轮实证枚举=0 而宿主在场收编 23 条）
const FindWindowExW = user32.func('uintptr_t __stdcall FindWindowExW(uintptr_t hWndParent, uintptr_t hWndChildAfter, const char16_t *lpszClass, const char16_t *lpszWindow)');

// 原生任务栏视图事实/兜底还原（工单50：本电池的面板会真实隐藏原生任务栏；
// 判据共用 accept/lib/win32.js 导出，四电池单点维护）
const { nativeTaskbarVisible, ensureNativeTaskbarVisible } = win32;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function titleOf(hwnd) {
  const buf = Buffer.alloc(512);
  const n = GetWindowTextW(hwnd, buf, 256);
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(buf.readUInt16LE(i * 2));
  return s;
}

/** 按 pid + 标题找顶层窗口；找不到返回 null */
function findWindow(pid, title) {
  for (const h of win32.topLevelWindows()) {
    if (win32.threadIdOf(h).pid === pid && titleOf(h) === title) return h;
  }
  return null;
}

function isTopmost(hwnd) {
  return (win32.GetWindowLongW(hwnd, win32.GWL_EXSTYLE) & win32.WS_EX_TOPMOST) !== 0;
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

/** 最新一帧几何存证（渲染层在 pill/按钮/推荐位/左组矩形变化时补发 taskbar-geometry） */
function latestGeometry(fallback) {
  const evs = readEvents().filter((e) => e.type === 'taskbar-geometry');
  return evs.length ? evs[evs.length - 1] : fallback;
}

/** 等几何安静窗口再取点击坐标：推荐位随 1Hz 数据面快照后到位会推中组 pill 移位，
 * 按 boot 存证的初始矩形点击会落空/点错按钮（54 并入后实测）。窗口取 1.3s > 数据面拍。 */
async function waitGeometrySettled(fallback, timeoutMs = 9000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const a = latestGeometry(fallback);
    await sleep(1300);
    const b = latestGeometry(fallback);
    if (a.t === b.t || Date.now() >= deadline) return b;
  }
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

/** 开始菜单是否占据前台（DWM cloak 会让 IsWindowVisible 撒谎，只能以前台判定） */
function shellMenuForeground() {
  const i = foregroundInfo();
  return !!i && i.cls === 'Windows.UI.Core.CoreWindow'
    && (i.exe === 'startmenuexperiencehost' || i.exe === 'searchhost');
}

/** 关闭开始菜单并等前台让出；消散动画仍可能盖住条带，调用方自行再静置 */
async function dismissShellMenu() {
  for (let attempt = 0; attempt < 3; attempt++) {
    win32.tapKeys([VK_ESC]);
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (!shellMenuForeground()) return true;
      await sleep(150);
    }
  }
  return false;
}

/** 点击并等存证，未达重试一次（shell 浮层消散时序敏感） */
async function clickWithEvidence(pt, actionType, rep) {
  for (let attempt = 0; attempt < 2; attempt++) {
    win32.clickPhys(pt.x, pt.y, 'left');
    const ev = await waitEvent('taskbar-action', (e) => e.action === actionType && e.t >= Date.now() - 6000, 3000);
    if (ev) return ev;
    rep.note(`${actionType} 第 ${attempt + 1} 次点击无回执，重试`);
    await sleep(500);
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

function launchPanel(extraEnv = {}) {
  return spawn(process.execPath, ['.', '--panel-accept'], {
    cwd: APP_ROOT,
    env: { ...process.env, DECK_EVENT_LOG: EVENTS_FILE, DECK_CDP_PORT: String(CDP_PORT), ...extraEnv },
    stdio: 'ignore',
  });
}

/** CDP 驱动面板渲染层（运行时桥动作的真机通道）：在指定标题的页执行表达式并取回值
 * （默认面板页；P13 传 'DECK-TASKBAR' 直读任务栏页 DOM/computed style——同属面板
 * 子进程的 targets，right-group 电池 P6 同款先例） */
async function cdpEval(expression, pageTitle = PANEL_TITLE) {
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

function killTree(child, panelPid) {
  // 面板真实主进程 pid 以 boot 自报为准（spawn 的 child.pid 在 Electron 父进程下不可靠——battery 先例）
  if (panelPid) spawnSync('taskkill', ['/PID', String(panelPid), '/T', '/F'], { stdio: 'ignore' });
  try { child.kill(); } catch { /* 已退出 */ }
}

// —— 残留任务视图清场（49 实测）——
// 本机 Win11 25H2 的任务视图宿主是顶层 XamlExplorerHostIslandWindow：P5 开过任务视图后
// 若没收净，残留的岛窗口仍可见可命中、且盖在条带区域上，会毒死本轮 P3/P4 的命中判定
// （点击落在它上面，连原生开始菜单都不弹）。Esc 语义依赖前台，不可靠；Win+Tab 反 toggle
// 才是确定性关闭。开它与关它同键，故循环到岛窗消失为止（有界 8 拍）。
const VK_LWIN = 0x5b;
const VK_TAB = 0x09;

function taskViewIsland() {
  for (const h of win32.topLevelWindows()) {
    if (win32.className(h) === 'XamlExplorerHostIslandWindow') {
      const r = win32.rectOf(h);
      if (r.right > r.left && r.bottom > r.top) return h;
    }
  }
  return null;
}

async function ensureTaskViewClosed(rep) {
  for (let i = 0; i < 8 && taskViewIsland(); i++) {
    win32.send([
      win32.keyInput(VK_LWIN, win32.KEYDOWN),
      win32.keyInput(VK_TAB, win32.KEYDOWN),
      win32.keyInput(VK_TAB, win32.KEYUP),
      win32.keyInput(VK_LWIN, win32.KEYUP),
    ]);
    await sleep(600);
  }
  const left = taskViewIsland();
  if (left && rep) rep.note(`任务视图残留清场未净 hwnd=${left}`);
  return !left;
}

async function main() {
  const rep = new Report('49-taskbar');
  let child = null;
  let panelPid = 0;
  const originalConfig = readConfigRaw();
  const finish = () => {
    const v = rep.verdict(rep.fails === 0 ? 'PASS' : 'FAIL');
    app.exit(v.fails === 0 ? 0 : 1);
  };

  try {
    fs.writeFileSync(EVENTS_FILE, '', 'utf8');
    patchTaskbar({ enabled: true });
    await ensureTaskViewClosed(rep); // 上一轮 P5 的任务视图残留会盖住条带，先清场

    // —— 拉起面板子进程（任务栏启用态）——
    child = launchPanel();
    const boot = await waitEvent('boot', null, 15000);
    if (!boot) throw new Error('面板子进程未上报 boot 事件');
    panelPid = boot.pid;
    rep.note(`面板 pid=${panelPid}`);

    const tbHwnd = await waitWindow(panelPid, TASKBAR_TITLE, 12000);
    if (!tbHwnd) throw new Error('P1 任务栏窗口未出现');

    // P1 置顶 + 底部通栏几何（rectOf 回 {left,top,right,bottom} 物理像素，宽高换算后归一 DIP）。
    // 底边判据 = 屏底（工单50：建窗先隐藏原生任务栏，净空归零条带落底；49 的让位净空
    // 只剩隐藏失败的降级档）。同时断言原生任务栏确已隐藏（隐藏失败则降级几何会在此暴露）。
    rep.beginSegment('P1');
    const dip = screen.getPrimaryDisplay().bounds;
    const rect = win32.rectOf(tbHwnd);
    const wPhys = rect.right - rect.left;
    const hPhys = rect.bottom - rect.top;
    const scale = wPhys / dip.width;
    const widthDip = wPhys / scale;
    const heightDip = hPhys / scale;
    const bottomDip = rect.bottom / scale; // 主屏原点恒 (0,0)（v1 仅主屏），物理底边/缩放即 DIP 底边
    const topmost = isTopmost(tbHwnd);
    const nativeHidden = !nativeTaskbarVisible();
    const geomOk = Math.abs(widthDip - dip.width) <= 2
      && Math.abs(heightDip - TASKBAR_HEIGHT_DIP) <= 2
      && Math.abs(bottomDip - dip.height) <= 2;
    if (topmost && geomOk && nativeHidden) {
      rep.pass(`P1 任务栏窗口在场：置顶 + 底部通栏落屏底（${Math.round(widthDip)}x${Math.round(heightDip)}），原生任务栏已隐藏`);
    } else {
      rep.fail(`P1 置顶=${topmost} 原生已隐=${nativeHidden} 几何=${JSON.stringify({ rect, dip, widthDip, heightDip, bottomDip })}`);
    }

    // P2 面板本体钉底不受影响
    rep.beginSegment('P2');
    const panelHwnd = await waitWindow(panelPid, PANEL_TITLE, 10000);
    const pinEvidence = await waitEvent('pin', null, 8000);
    if (panelHwnd && !isTopmost(panelHwnd) && pinEvidence) {
      rep.pass('P2 面板本体在场、非置顶、钉底存证在流');
    } else {
      rep.fail(`P2 面板窗=${!!panelHwnd} 置顶=${panelHwnd ? isTopmost(panelHwnd) : 'n/a'} pin存证=${!!pinEvidence}`);
    }

    // pill 与按钮矩形（渲染层 ready 存证，CSS px 相对客户区）
    const ready = await waitEvent('taskbar-ready', (e) => e.pill && e.buttons, 10000);
    if (!ready) throw new Error('taskbar-ready 存证缺失（无法取 pill 点击坐标）');
    // 几何稳定帧：推荐位后到位会推 pill 移位，点击坐标一律取 settle 后的最新几何
    const geom = await waitGeometrySettled(ready);
    rep.note(`几何帧: boot pill.w=${Math.round(ready.pill.w)} → settled pill.w=${Math.round(geom.pill.w)}`);
    const toPhys = (cssX, cssY) => ({
      x: Math.round(rect.left + cssX * scale),
      y: Math.round(rect.top + cssY * scale),
    });
    const btnOf = (id) => {
      const b = geom.buttons.find((x) => x.id === id);
      return toPhys(b.x + b.w / 2, b.y + b.h / 2);
    };
    // 缝隙探针（工单52 适配）：左组有条目时取「左组 pill 右缘与中组 pill 左缘的中点」
    // （固定在 x=40 会落进左组 pill 热区）；左组空（pill-left 不渲染）回退条带左端 40
    const gapCssX = geom.apps && geom.apps.length > 0
      ? (geom.leftPill.x + geom.leftPill.w + geom.pill.x) / 2
      : 40;
    const gapPt = toPhys(gapCssX, TASKBAR_HEIGHT_DIP / 2); // 条带缝隙（两组 pill 之间/左端）
    const pillCenter = toPhys(geom.pill.x + geom.pill.w / 2, geom.pill.y + geom.pill.h / 2);

    // z 序收敛（ADR-0007 已知风险）：原生任务栏同在 TOPMOST 带，建窗瞬间可能压在我们之上；
    // keepalive 定时重申会赢下稳态——电池等收敛再断言，不赌建窗瞬时序（49 实测两态都出现过）。
    win32.moveMousePhys(pillCenter.x, pillCenter.y);
    let converged = false;
    for (let i = 0; i < 32 && !converged; i++) {
      await sleep(250);
      converged = win32.windowFromPointRoot(pillCenter) === tbHwnd;
    }
    rep.note(`置顶收敛=${converged}`);
    if (!converged) {
      const hit = win32.windowFromPointRoot(pillCenter);
      rep.note(`pill 上方窗口: hwnd=${hit} cls=${win32.className(hit)} exe=${win32.exeNameOfWindow(hit)}`);
    }

    // P3 缝隙穿透 + pill 热区命中（双向往返）
    rep.beginSegment('P3');
    win32.moveMousePhys(gapPt.x, gapPt.y);
    await sleep(400); // 热区轮询 25ms + 离开确认 2 拍，400ms 足够收敛
    const gapHit = win32.windowFromPointRoot(gapPt);
    win32.moveMousePhys(pillCenter.x, pillCenter.y);
    await sleep(400);
    const pillHit = win32.windowFromPointRoot(pillCenter);
    win32.moveMousePhys(gapPt.x, gapPt.y); // 复位出热区
    if (gapHit !== tbHwnd && pillHit === tbHwnd) {
      rep.pass('P3 pill 缝隙点击穿透到下方窗口，pill 内热区命中任务栏窗');
    } else {
      rep.fail(`P3 缝隙命中=${gapHit === tbHwnd ? '任务栏窗(应穿透)' : gapHit} pill命中=${pillHit === tbHwnd ? '任务栏窗' : pillHit}`);
    }

    // P4 开始按钮 → 原生开始菜单（先断言按键合成成功回执，再等前台易主）。
    // 前台宿主因 Win11 版本而异：StartMenuExperienceHost（≤23H2）或 SearchHost（24H2+，
    // 开始菜单前台 CoreWindow 由 SearchHost 承载——49 真机实证）；两者都是 shell CoreWindow。
    rep.beginSegment('P4');
    const isStartMenu = (i) => i.cls === 'Windows.UI.Core.CoreWindow'
      && (i.exe === 'startmenuexperiencehost' || i.exe === 'searchhost');
    const before = foregroundInfo();
    const startPt = btnOf('start');
    win32.clickPhys(startPt.x, startPt.y, 'left');
    const actionEv = await waitEvent('taskbar-action', (e) => e.action === 'start-menu', 5000);
    const resultEv = await waitEvent('taskbar-action-result', (e) => e.action === 'start-menu', 5000);
    const startFg = await waitForeground(isStartMenu, 6000);
    if (actionEv && resultEv && resultEv.ok && startFg && (!before || before.hwnd !== startFg.hwnd)) {
      rep.pass(`P4 开始按钮弹出原生开始菜单（前台 ${startFg.exe} / ${startFg.cls}）`);
    } else {
      rep.fail(`P4 点击存证=${!!actionEv} 合成回执=${JSON.stringify(resultEv)} 前台=${JSON.stringify(startFg)}`);
    }
    // 关开始菜单并等前台让出——消散动画期间它仍可能盖住条带，故再静置一拍（49 实测）
    const dismissed = await dismissShellMenu();
    rep.note(`开始菜单收起=${dismissed}`);
    await sleep(800);

    // P5 TaskView 按钮 → 原生任务视图。前台宿主同样是版本相关：explorer 的
    // ForegroundStaging / CoreWindow / XamlIsland 都见过；判据 = 前台易主为 explorer
    // 的非桌面窗口（Progman/WorkerW 是桌面宿主，不算）。
    rep.beginSegment('P5');
    const beforeTv = foregroundInfo();
    const tasksPt = btnOf('tasks');
    // 光标重新入场刷新热区（菜单开阖期间的热区状态不赌）
    win32.moveMousePhys(gapPt.x, gapPt.y);
    await sleep(300);
    win32.moveMousePhys(tasksPt.x, tasksPt.y);
    await sleep(400);
    // z 序再收敛（P4 同纪律）：开始菜单开阖触发 shell 重申原生任务栏置顶（49 实测
    // P4→P5 间命中变 Shell_TrayWnd），keepalive 重申会赢回——等收敛再点，不赌菜单
    // 收起后的瞬时空窗。
    let convergedTv = false;
    for (let i = 0; i < 32 && !convergedTv; i++) {
      await sleep(250);
      convergedTv = win32.windowFromPointRoot(tasksPt) === tbHwnd;
    }
    rep.note(`P5 点击前: fg=${JSON.stringify(beforeTv)} tasks点收敛=${convergedTv}`);
    if (!convergedTv) {
      const hit = win32.windowFromPointRoot(tasksPt);
      const tbEx = win32.GetWindowLongW(tbHwnd, win32.GWL_EXSTYLE);
      const transparent = (tbEx & win32.WS_EX_TRANSPARENT) !== 0;
      rep.note(`tasks 点上方窗口: hwnd=${hit} cls=${win32.className(hit)} exe=${win32.exeNameOfWindow(hit)}`
        + ` | 我方 transparent=${transparent} topmost=${(tbEx & win32.WS_EX_TOPMOST) !== 0}`);
    }
    const isTaskView = (i) => i.exe === 'explorer' && i.cls !== 'Progman' && i.cls !== 'WorkerW'
      && (!beforeTv || i.hwnd !== beforeTv.hwnd);
    const actionEv2 = await clickWithEvidence(tasksPt, 'task-view', rep);
    const resultEv2 = await waitEvent('taskbar-action-result', (e) => e.action === 'task-view', 5000);
    const tvFg = await waitForeground(isTaskView, 6000);
    if (actionEv2 && resultEv2 && resultEv2.ok && tvFg) {
      rep.pass(`P5 TaskView 按钮弹出原生任务视图（前台 ${tvFg.exe} / ${tvFg.cls}）`);
    } else {
      rep.fail(`P5 点击存证=${!!actionEv2} 合成回执=${JSON.stringify(resultEv2)} 前台=${JSON.stringify(tvFg)}`);
    }
    win32.tapKeys([VK_ESC]); // 退出任务视图
    await sleep(600);
    await ensureTaskViewClosed(rep); // Esc 依赖前台，收不净则用 Win+Tab 反 toggle 兜底（残留会毒死后续轮次）

    // P6 运行时禁用（插件热切换真机链路）：CDP 在面板页驱动 taskbar/set-enabled →
    // taskbar/changed → 控制器销毁窗口；config.json 同步落盘；面板本体不受影响。
    rep.beginSegment('P6');
    const r6 = await cdpEval(`window.deck.bridge.invoke('taskbar/set-enabled', { enabled: false })`);
    let tbAfterDisable = null;
    for (let i = 0; i < 25 && !tbAfterDisable; i++) {
      await sleep(200);
      if (!findWindow(panelPid, TASKBAR_TITLE)) tbAfterDisable = true;
    }
    const diskOff = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const panelAlive = !!findWindow(panelPid, PANEL_TITLE);
    const nativeBackP6 = nativeTaskbarVisible(); // 工单50：禁用即还原原生任务栏（逃生方向）
    if (r6 && r6.enabled === false && tbAfterDisable && diskOff.taskbar && diskOff.taskbar.enabled === false && panelAlive && nativeBackP6) {
      rep.pass('P6 运行时禁用：任务栏窗口即销毁、原生任务栏还原、config 落盘、面板本体不受影响');
    } else {
      rep.fail(`P6 响应=${JSON.stringify(r6)} 窗已销=${!!tbAfterDisable} 原生还原=${nativeBackP6} 落盘=${JSON.stringify(diskOff.taskbar)} 面板在=${panelAlive}`);
    }

    // P7 运行时重新启用 → 窗口恢复（仍置顶）
    rep.beginSegment('P7');
    const r7 = await cdpEval(`window.deck.bridge.invoke('taskbar/set-enabled', { enabled: true })`);
    const tbBackLive = await waitWindow(panelPid, TASKBAR_TITLE, 8000);
    if (r7 && r7.enabled === true && tbBackLive && isTopmost(tbBackLive)) {
      rep.pass('P7 运行时重新启用：任务栏窗口恢复（仍置顶）');
    } else {
      rep.fail(`P7 响应=${JSON.stringify(r7)} 窗恢复=${!!tbBackLive}`);
    }

    // P8 启动态禁用（config 门禁）：禁用配置下拉起 → 窗口不建，面板照常
    rep.beginSegment('P8');
    patchTaskbar({ enabled: false });
    killTree(child, panelPid);
    child = null;
    await sleep(1200);
    const since8 = Date.now(); // boot 事件按时间戳门禁——存证文件跨阶段累积，旧 boot 会误配
    child = launchPanel();
    const boot2 = await waitEvent('boot', (e) => e.t >= since8, 15000);
    if (!boot2) throw new Error('P8 禁用态面板子进程未上报 boot');
    panelPid = boot2.pid;
    await sleep(2500); // 给窗口创建留出时间（应不发生）
    const tbGone = !findWindow(panelPid, TASKBAR_TITLE);
    const panelUp = await waitWindow(panelPid, PANEL_TITLE, 10000);
    if (tbGone && panelUp) {
      rep.pass('P8 启动态禁用：任务栏窗口不建，面板本体照常');
    } else {
      rep.fail(`P8 任务栏窗不建=${tbGone} 面板窗=${!!panelUp}`);
    }

    // P9 启动态恢复启用 → 窗口回来
    rep.beginSegment('P9');
    patchTaskbar({ enabled: true });
    killTree(child, panelPid);
    child = null;
    await sleep(1200);
    const since9 = Date.now();
    child = launchPanel();
    const boot3 = await waitEvent('boot', (e) => e.t >= since9, 15000);
    if (!boot3) throw new Error('P9 启用态面板子进程未上报 boot');
    panelPid = boot3.pid;
    const tbBack = await waitWindow(panelPid, TASKBAR_TITLE, 12000);
    if (tbBack && isTopmost(tbBack)) {
      rep.pass('P9 启动态重新启用后任务栏窗口恢复（仍置顶）');
    } else {
      rep.fail(`P9 任务栏窗恢复=${!!tbBack}`);
    }

    // P13 栏高与图标尺寸（工单158）：条带 64DIP + 应用组图标 32px/格位 44px + 托盘 24px。
    //   读数两路互证：(1) 任务栏页 CDP computed style（CSS px——浏览器层落的尺寸事实）；
    //   (2) taskbar-geometry 存证帧（渲染层量出的矩形，电池既有点击坐标来源）。
    //   应用格位若栏上暂无应用，spawn notepad 探针（运行中应用经 1Hz 编排轮 1–2s 上栏）；
    //   托盘名单收编后面板自家图标恒在栏（#153 链路，P11 同款确定性来源）。
    //   最近邻放大档交叉核验：已装载像素的托盘图标（naturalWidth>0）源尺寸 <24px 必须
    //   挂 .tb-tray-px（image-rendering: pixelated），≥24px 不得挂——像素未到齐的图标
    //   只断 24px 显示尺寸（像素链路另有 tray 族电池收口，不在本段重复设卡）。
    rep.beginSegment('P13');
    const tbH13 = await waitWindow(panelPid, TASKBAR_TITLE, 8000);
    let notepad13 = null;
    try {
      // 栏上无应用格时铺一枚探针（有则直接用——断言的是格位/图标尺寸，与应用身份无关）
      let geom13 = latestGeometry(null);
      if (!geom13 || !geom13.apps || geom13.apps.length === 0) {
        notepad13 = spawn('notepad.exe', [], { stdio: 'ignore' });
        const deadline13 = Date.now() + 12000;
        while (Date.now() < deadline13) {
          geom13 = latestGeometry(null);
          if (geom13 && geom13.apps && geom13.apps.length > 0) break;
          await sleep(300);
        }
      }
      // 条带窗口高度（物理像素 → DIP，P1 同口径；本段自带一份证据不依赖 P1 现场）
      const rect13 = tbH13 ? win32.rectOf(tbH13) : null;
      const dip13 = screen.getPrimaryDisplay().bounds;
      const scale13 = rect13 ? (rect13.right - rect13.left) / dip13.width : 0;
      const heightDip13 = rect13 ? (rect13.bottom - rect13.top) / scale13 : 0;
      // 等托盘像素到齐（自家图标 dataURL 装载后 naturalWidth>0；5s 内未到齐走软核验）
      const probe13 = async () => cdpEval(`(() => {
        const cell = document.querySelector('.tb-app');
        const icon = document.querySelector('.tb-app img');
        const tray = [...document.querySelectorAll('.tb-tray-icon img')];
        const cs = (el, p) => (el ? getComputedStyle(el)[p] : null);
        return {
          cell: cell ? { w: cs(cell, 'width'), h: cs(cell, 'height') } : null,
          icon: icon ? { w: cs(icon, 'width'), h: cs(icon, 'height') } : null,
          tray: tray.map((t) => ({ w: cs(t, 'width'), h: cs(t, 'height'), nat: t.naturalWidth, px: t.classList.contains('tb-tray-px'), rendering: cs(t, 'imageRendering') })),
        };
      })()`, TASKBAR_TITLE);
      let sizes13 = null;
      for (let i = 0; i < 10; i++) {
        sizes13 = await probe13();
        if (sizes13.tray.some((t) => t.nat > 0)) break;
        await sleep(500);
      }
      const stripOk13 = Math.abs(heightDip13 - TASKBAR_HEIGHT_DIP) <= 2;
      const cellOk13 = sizes13.cell && sizes13.cell.w === '44px' && sizes13.cell.h === '44px';
      const iconOk13 = sizes13.icon && sizes13.icon.w === '32px' && sizes13.icon.h === '32px';
      const trayLen13 = sizes13.tray.length;
      const traySizeOk13 = trayLen13 > 0 && sizes13.tray.every((t) => t.w === '24px' && t.h === '24px');
      const loaded13 = sizes13.tray.filter((t) => t.nat > 0);
      const trayPxOk13 = loaded13.every((t) => t.px === (t.nat < 24) && (t.px ? t.rendering === 'pixelated' : t.rendering !== 'pixelated'));
      // 几何存证互证：应用格位 h≈44（cell）；托盘格 h≈38（24 图标 + 7+7 padding）
      const geo13 = latestGeometry(null);
      const geoAppsOk13 = !!(geo13 && geo13.apps && geo13.apps.length > 0 && Math.abs(geo13.apps[0].h - 44) <= 2);
      const geoTrayOk13 = !!(geo13 && geo13.trayIcons && geo13.trayIcons.length > 0 && Math.abs(geo13.trayIcons[0].h - 38) <= 2);
      if (stripOk13 && cellOk13 && iconOk13 && traySizeOk13 && geoAppsOk13 && geoTrayOk13
        && (loaded13.length === 0 || trayPxOk13)) {
        rep.pass(`P13 栏高与图标尺寸：条带 ${Math.round(heightDip13)}DIP；应用格位 44px/图标 32px；`
          + `托盘 ${trayLen13} 枚均 24px（已装载 ${loaded13.length} 枚放大档核验`
          + `${loaded13.length === 0 ? '未及（像素未到齐，软核验跳过）' : trayPxOk13 ? '通过' : '不符'}）`
          + `；几何存证互证（格位 h=${geo13.apps[0].h.toFixed(1)}、托盘格 h=${geo13.trayIcons[0].h.toFixed(1)}）`);
      } else {
        rep.fail(`P13 条带=${Math.round(heightDip13)}DIP 格位=${JSON.stringify(sizes13.cell)} 图标=${JSON.stringify(sizes13.icon)}`
          + ` 托盘=${trayLen13} 枚尺寸全24=${traySizeOk13} 放大档核验=${trayPxOk13}（装载 ${loaded13.length}）`
          + ` 几何互证(格位=${geoAppsOk13}/托盘=${geoTrayOk13}) 几何帧=${JSON.stringify(geo13 && { apps: geo13.apps, trayIcons: geo13.trayIcons })}`);
      }
    } finally {
      if (notepad13) spawnSync('taskkill', ['/PID', String(notepad13.pid), '/T', '/F'], { stdio: 'ignore' });
    }

    // P10(a) 关-开连发竞态（#103 缺陷①）：单次 evaluate 内串联两桥写（await 第一写
    // 返回即发第二写，毫秒级）——真实 agent 路径的回归面。取证判读（2026-10-11 并案
    // 取证 D 相）CDP 两独立调用间隔 ~313ms；红轮实证毫秒级串联在未修代码上竞态仍
    // 进不了场（closed 在 ~2-5ms 内先落地）——确定性的缺陷①触发在 (b) 进程内连发，
    // 本段断言面 (a)/(b) 同款：孤儿检测器（连发后完整禁用，条带必须归零——迟到的
    // closed 若抹掉控制器共享账，destroy() 因 win=null 空转、条带永不清）；乱序注销
    // 存证（新窗 registered 之后再冒 appbar-removed 即迟到 closed 拿新窗句柄误注销）。
    rep.beginSegment('P10');
    const sinceP10 = Date.now();
    const burst = await cdpEval(`(async () => {
      const a = await window.deck.bridge.invoke('taskbar/set-enabled', { enabled: false });
      const b = await window.deck.bridge.invoke('taskbar/set-enabled', { enabled: true });
      return { first: a && a.enabled, second: b && b.enabled };
    })()`);
    await sleep(1500); // 竞态窗：旧窗 closed 充分落地 + 新窗建窗稳定
    const stripsAfterBurst = [];
    for (const h of win32.topLevelWindows()) {
      if (titleOf(h) === TASKBAR_TITLE && win32.threadIdOf(h).pid === panelPid) stripsAfterBurst.push(h);
    }
    const burstEnd = Date.now();
    // 竞态窗内合法事件序：destroyed(旧,disabled) → removed(旧,destroy 路径) → created(新)
    // → registered(新)；registered(新) 之后再冒 removed 即乱序注销（迟到 closed 误注销新窗占位）
    const evsBurst = readEvents().filter((e) => e.t >= sinceP10 && e.t <= burstEnd);
    const regsBurst = evsBurst.filter((e) => e.type === 'taskbar-appbar-registered');
    const lastRegT = regsBurst.length ? regsBurst[regsBurst.length - 1].t : 0;
    const spuriousRemoved = evsBurst.filter((e) => e.type === 'taskbar-appbar-removed' && e.t > lastRegT);
    // 孤儿检测器：完整禁用后条带必须归零
    const r10off = await cdpEval(`window.deck.bridge.invoke('taskbar/set-enabled', { enabled: false })`);
    let stripGone = false;
    for (let i = 0; i < 25 && !stripGone; i++) {
      await sleep(200);
      stripGone = !findWindow(panelPid, TASKBAR_TITLE);
    }
    // 再启用：恰一扇 + 仍置顶 + 新窗占位存证在场
    const r10on = await cdpEval(`window.deck.bridge.invoke('taskbar/set-enabled', { enabled: true })`);
    const tbFinal = await waitWindow(panelPid, TASKBAR_TITLE, 8000);
    const regFinal = await waitEvent('taskbar-appbar-registered', (e) => e.t > burstEnd, 8000);
    if (burst && burst.first === false && burst.second === true
      && stripsAfterBurst.length === 1 && spuriousRemoved.length === 0
      && stripGone && r10off && r10off.enabled === false
      && r10on && r10on.enabled === true && tbFinal && isTopmost(tbFinal) && regFinal) {
      rep.pass(`P10(a) 桥写连发：条带恰一扇、禁用归零（无孤儿）、再启用占位在场（hwnd=${regFinal.hwnd}）、无乱序注销`);
    } else {
      rep.fail(`P10(a) 连发=${JSON.stringify(burst)} 条带数=${stripsAfterBurst.length} 乱序注销=${spuriousRemoved.length}`
        + ` 禁用归零=${stripGone} 禁用响应=${JSON.stringify(r10off)} 再启用窗=${!!tbFinal} 新窗占位=${!!regFinal}`);
    }

    // P10(b) 进程内同任务连发（取证判读的确定性触发）：renderer 双桥写跨 IPC 任务、
    // 未修代码上竞态进不了场（(a) 的红轮实证）——带 DECK_TASKBAR_BURST=1 重拉面板，
    // 主进程在同一 JS 任务内连发两次 setEnabled（destroy/create 零事件循环轮转，
    // 旧窗 closed 确定性迟到），这才是缺陷①的完整触发形态。断言面与 (a) 同款。
    patchTaskbar({ enabled: true });
    killTree(child, panelPid);
    child = null;
    await sleep(1200);
    const sinceBurst = Date.now();
    child = launchPanel({ DECK_TASKBAR_BURST: '1' });
    const bootBurst = await waitEvent('boot', (e) => e.t >= sinceBurst, 15000);
    if (!bootBurst) throw new Error('P10(b) 连发面板子进程未上报 boot');
    panelPid = bootBurst.pid;
    const burstDone = await waitEvent('taskbar-burst-done', (e) => e.t >= sinceBurst, 20000);
    await sleep(1500); // 竞态窗：迟到 closed 充分落地
    const stripsBurst = [];
    for (const h of win32.topLevelWindows()) {
      if (titleOf(h) === TASKBAR_TITLE && win32.threadIdOf(h).pid === panelPid) stripsBurst.push(h);
    }
    const burstEnd2 = Date.now();
    const evsInProc = readEvents().filter((e) => e.t >= sinceBurst && e.t <= burstEnd2);
    const regsInProc = evsInProc.filter((e) => e.type === 'taskbar-appbar-registered');
    const lastRegT2 = regsInProc.length ? regsInProc[regsInProc.length - 1].t : 0;
    const spuriousRemoved2 = evsInProc.filter((e) => e.type === 'taskbar-appbar-removed' && e.t > lastRegT2);
    // 孤儿检测器：完整禁用后条带必须归零
    const rOff2 = await cdpEval(`window.deck.bridge.invoke('taskbar/set-enabled', { enabled: false })`);
    let stripGone2 = false;
    for (let i = 0; i < 25 && !stripGone2; i++) {
      await sleep(200);
      stripGone2 = !findWindow(panelPid, TASKBAR_TITLE);
    }
    const rOn2 = await cdpEval(`window.deck.bridge.invoke('taskbar/set-enabled', { enabled: true })`);
    const tbFinal2 = await waitWindow(panelPid, TASKBAR_TITLE, 8000);
    const regFinal2 = await waitEvent('taskbar-appbar-registered', (e) => e.t > burstEnd2, 8000);
    if (burstDone && stripsBurst.length === 1 && spuriousRemoved2.length === 0
      && stripGone2 && rOff2 && rOff2.enabled === false
      && rOn2 && rOn2.enabled === true && tbFinal2 && isTopmost(tbFinal2) && regFinal2) {
      rep.pass(`P10(b) 进程内连发：条带恰一扇、禁用归零（无孤儿）、再启用占位在场（hwnd=${regFinal2.hwnd}）、无乱序注销`);
    } else {
      rep.fail(`P10(b) 连发存证=${!!burstDone} 条带数=${stripsBurst.length} 乱序注销=${spuriousRemoved2.length}`
        + ` 禁用归零=${stripGone2} 禁用响应=${JSON.stringify(rOff2)} 再启用窗=${!!tbFinal2} 新窗占位=${!!regFinal2}`);
    }

    // P11 运行时交还（#153 原子性契约的交还环）：禁用必须把托盘宿主还给 explorer——
    // 竞争窗（Shell_TrayWnd 同名窗，属主=我方进程树）拆净 + tray-host-stopped 存证在流；
    // 重启用反向对称：宿主重建（新 tray-host-ready 帧）+ 收编名单回填（真机真应用响应
    // 广播回注册，面板自家图标即其一）。枚举一律按属主过滤（#103 缺陷②教训：裸
    // FindWindow 首命是我方竞争窗；本电池、面板主进程、数据面子进程同 electron.exe——
    // 按 exe 名圈我方树，explorer 真栏按属主天然排除在外）。
    rep.beginSegment('P11');
    // exeNameOfWindow 返回去 .exe 后缀的小写名（electron）；竞争窗隐藏故走类名 Z 序枚举
    const ourTrayHosts = () => {
      const out = [];
      let after = 0;
      for (;;) {
        const h = Number(FindWindowExW(0, after, 'Shell_TrayWnd', null));
        if (!h) break;
        after = h;
        if (win32.exeNameOfWindow(h) === 'electron') out.push(h);
      }
      return out;
    };
    const baseHosts = ourTrayHosts();
    if (baseHosts.length >= 1) {
      rep.pass(`P11 基线：启用态我方托盘竞争窗在场（hwnd=${baseHosts[0]}）`);
    } else {
      rep.fail(`P11 基线：启用态应有我方托盘竞争窗（枚举=${baseHosts.length}）`);
    }
    // 禁用 → 交还（红轮预期红：stop 死代码无存证、竞争窗残留即图标被扣的死账形态）
    const t11off = Date.now();
    const r11off = await cdpEval(`window.deck.bridge.invoke('taskbar/set-enabled', { enabled: false })`);
    const stopEv = await waitEvent('tray-host-stopped', (e) => e.t >= t11off, 8000);
    await sleep(500);
    const hostsOff = ourTrayHosts();
    if (r11off && r11off.enabled === false && stopEv && hostsOff.length === 0) {
      rep.pass('P11 禁用即交还：tray-host-stopped 存证在流、我方 Shell_TrayWnd 归零');
    } else {
      rep.fail(`P11 禁用响应.enabled=${r11off && r11off.enabled} stopped存证=${!!stopEv} 残留竞争窗=${hostsOff.length}`);
    }
    // 重启用 → 收编回填：宿主重建 + 条带恢复 + 名单非空（面板自家图标响应广播）。
    // 状态满帧太长（断言失败时刷屏），再启用断言只回显 enabled 位。
    const t11on = Date.now();
    const r11on = await cdpEval(`window.deck.bridge.invoke('taskbar/set-enabled', { enabled: true })`);
    const readyEv = await waitEvent('tray-host-ready', (e) => e.t >= t11on, 8000);
    const stripBack11 = await waitWindow(panelPid, TASKBAR_TITLE, 8000);
    let rosterLen = 0;
    for (let i = 0; i < 12 && rosterLen === 0; i++) {
      await sleep(700);
      const st = await cdpEval(`window.deck.bridge.invoke('taskbar/get-state', {})`);
      rosterLen = st && st.tray ? st.tray.length : 0;
    }
    // 宿主窗在场时取数据面子进程 pid（P12(a) 的击杀目标；dataplane-spawn 存证不带 pid
    // ——utilityProcess.pid 在落存证时点尚未就绪，红轮实证字段缺席；窗亡后 hwnd 取不到 pid，
    // 必须趁在场这一拍留档）
    const hostsOn = ourTrayHosts();
    const dpPid = hostsOn.length ? win32.threadIdOf(hostsOn[0]).pid : 0;
    if (r11on && r11on.enabled === true && readyEv && stripBack11 && isTopmost(stripBack11)
      && hostsOn.length >= 1 && rosterLen >= 1) {
      rep.pass(`P11 重启用即收编：宿主重建（新 ready 帧）、条带恢复置顶、名单回填（${rosterLen} 条）`);
    } else {
      rep.fail(`P11 再启用响应.enabled=${r11on && r11on.enabled} 新ready=${!!readyEv} 条带=${!!stripBack11}`
        + ` 竞争窗=${hostsOn.length} 名单=${rosterLen}`);
    }
    // 二次禁用（停→起→停整周期：类注销对称性的真机实证——重启后的宿主必须还能停）
    const t11off2 = Date.now();
    await cdpEval(`window.deck.bridge.invoke('taskbar/set-enabled', { enabled: false })`);
    const stopEv2 = await waitEvent('tray-host-stopped', (e) => e.t >= t11off2, 8000);
    await sleep(500);
    if (stopEv2 && ourTrayHosts().length === 0) {
      rep.pass('P11 二次禁用（重启后停）：竞争窗再次归零');
    } else {
      rep.fail(`P11 二次禁用 stopped存证=${!!stopEv2} 残留=${ourTrayHosts().length}`);
    }

    // P12 宿主守恒（#153）：禁用态下托盘宿主不得以任何路径复活——
    //   (a) 数据面子进程被强杀后按退避重启：respawn 的 init 必须按「当前期望态」重算，
    //       静态重放会再偷图标（红轮预期红：宿主随 respawn 复活）；
    //   (b) 启态禁用（config 门禁）拉起：宿主根本不该起（红轮预期红：init 无条件）。
    rep.beginSegment('P12');
    // (a) 禁用态崩溃重启（沿用 P11 二次禁用后的禁用态现场；dpPid = P11 宿主窗在场时留档）
    if (!dpPid) {
      rep.fail('P12(a) 无在位宿主窗可定位数据面子进程（dpPid=0）');
    } else {
      const t12kill = Date.now();
      spawnSync('taskkill', ['/PID', String(dpPid), '/F'], { stdio: 'ignore' });
      const respawn = await waitEvent('dataplane-spawn', (e) => e.t >= t12kill && e.reason === 'restart', 15000);
      await sleep(2500);
      const hostRevived = readEvents().some((e) => e.type === 'tray-host-ready' && e.t >= t12kill);
      if (respawn && !hostRevived && ourTrayHosts().length === 0) {
        rep.pass('P12(a) 禁用态数据面重启：宿主不复活（respawn 按期望态重算，竞争窗仍归零）');
      } else {
        rep.fail(`P12(a) 重启存证=${!!respawn} 宿主复活=${hostRevived} 竞争窗=${ourTrayHosts().length}`);
      }
    }
    // (b) 启态禁用：config 门禁下拉起，宿主不起
    patchTaskbar({ enabled: false });
    killTree(child, panelPid);
    child = null;
    await sleep(1200);
    const since12 = Date.now();
    child = launchPanel();
    const boot12 = await waitEvent('boot', (e) => e.t >= since12, 15000);
    if (!boot12) throw new Error('P12(b) 禁用态面板子进程未上报 boot');
    panelPid = boot12.pid;
    await sleep(3000); // 宿主若要起，init 即起（等数据面就绪线即过）
    const hostBooted = readEvents().some((e) => e.type === 'tray-host-ready' && e.t >= since12);
    if (!hostBooted && ourTrayHosts().length === 0) {
      rep.pass('P12(b) 启态禁用：托盘宿主不建（不偷图标），面板照常');
    } else {
      rep.fail(`P12(b) 宿主起了=${hostBooted} 竞争窗=${ourTrayHosts().length}`);
    }
  } catch (err) {
    rep.fail(`电池异常: ${err && err.stack || err}`);
  } finally {
    killTree(child, panelPid);
    restoreConfig(originalConfig); // 三态还原（工单124：缺位来、缺位去——补齐 null → unlink 分支）
    // 工单50 清场：本电池无守卫兜底（--panel-accept 直跑），面板被 /F 清杀时原生
    // 任务栏可能留隐藏态——电池不得给用户留无系统入口的桌面
    ensureNativeTaskbarVisible();
    nativeTaskbarVisible()
      ? rep.note('清场核验：原生任务栏可见')
      : rep.note('清场核验：原生任务栏仍隐藏（兜底已尝试，需人工核查）');
  }

  finish();
}

module.exports = main;
