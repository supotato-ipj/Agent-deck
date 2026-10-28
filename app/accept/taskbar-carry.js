'use strict';
// 工单50 任务栏显隐验收（原生任务栏隐藏/还原 + 逃生开关）→ 工单261 还原账全路径扩展；
// 工单308 M1 覆盖式普通档改写（spec #306）：控制器以 --accept-taskbar-carry 身份运行，
// 分三阶段覆盖三条还原路径（可见性 + appbar 状态双复原）、逃生开关与偏好不扰。
// M1 语义基座：接管建立=置位一次（takeover+set）、托管期恒置位、运行期零 appbar 状态
// 写入（旧普通↔收栏切换的 enter/clear 中间态退役）、退场写回用户原值一次。
//   阶段A（守卫链默认入口 spawn '.'，真 guard + watchdog 全链路；中性 holder 前台钉住
//         防环境最大化搅局——51 电池 P1 同款）：
//     A1 接管开启 → 原生任务栏隐藏（taskbar-hidden 存证 + Shell_TrayWnd 不可见），
//        条带落屏底覆盖式常驻——置位随接管建立即发生（M1 恒置位；holder 非最大化只影响档位）
//     A2 正常退出（WM_CLOSE 面板主窗，收栏档出发）→ 原生任务栏还原 + appbar 状态复原
//        （路径①：面板 dispose 还账清账；可见性以退出后的控制器独立视图事实为准
//        ——置位后 WS_VISIBLE 位被翻开且退出置位不回落，可见性复原由 appbar 复原
//        本身达成、taskbar-restored 事件确证静默，R1 轮磁带 + spike 附记 + P9 判读）
//     A3 崩溃路径（taskkill /F /T 面板树，守卫存活）→ 守卫以 panel-exit 双兜底
//        （appbar 从落盘账复原——守卫不持面板内存账；可见性同上以视图事实为准）
//     A4 进程被杀路径（守卫 + 面板先后强杀，控制台信号同杀的等价现场）→
//        还原守护（icon-restore-watch）以 guard-dead 双兜底（appbar 从落盘账复原）
//        后自退
//     A5/A6/A7 普通档出发的对应轮（工单296，spec #292 退场复原扩全接管期；工单308 M1
//        置位口径改写）：与 A2/A3/A4 同构的三条路径（正常退出/崩溃/强杀），出发态改
//        **普通档**——接管建立即置位（takeover/set 存证 + 读回含 AUTOHIDE 位 + 零收栏档），
//        不进收栏；退场复原一律以系统读回事实裁决（appbarState() === 基线）。
//        普通档的禁用径由 B1（off 口径 destroy('disabled')）+ C2（restored 仅
//        disabled/force 径）把关。
//   阶段B（--panel-accept + CDP，逃生开关真机链路；config 钉 maximizeRetract=off——
//         M1 下 off 只关收栏档，托管恒置位照走，off 口径由 C2 段把关）：
//     B1 设置浮层关开关 → 原生任务栏即还原、条带销毁、config 落盘
//     B2 再开 → 原生任务栏再隐、条带回来
//   阶段C 偏好不扰（工单260 措辞收口）：首末两点比对 StuckRects3 Settings（自动隐藏等
//      任务栏偏好）——断言「面板生命周期结束后字节复原」（C1 纪律口径，spec #258：
//      实现本为首末两点比对，措辞与实现对齐）。
//   C2 off 口径（工单260；工单293 全接管期改段；工单308 M1 改写）：off 只关收栏档、
//      托管恒置位照走——B 相位两次接管生命周期（B1 开、B2 再开）每次恰**两次状态写入**
//      （建立置位一次 set + 退场复原一次 restored），运行期零其他写入（无 enter/clear/
//      reattach 中间态——M1 恒置位单账）+ 退出后 appbar 状态 = 开跑前基线（控制器独立
//      读数，不依赖面板自证）。
// 运行：npm run accept:taskbar-carry（= electron . --accept-taskbar-carry）。
// 与其他验收同一铁律：必须经 accept-guard 托管（守卫链抢单实例锁，与常驻面板互斥）。
// 置位态判读注意（R1 取证 + spike 附记）：置位后 explorer 翻开 Shell_TrayWnd 的
// WS_VISIBLE 位（「窗口显示位」≠「视觉在场」）——A2/A3/A4 在置位态出发，可见性断言以
// **存证事件**（SW_SHOW 真做了工作）与**退出后的控制器独立视图事实**为准；托管置位/
// 复原本身不改注册表（spike：StuckRects3 三点全等），C1 字节复原不受 A 相位置位影响。
const { app, screen, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const win32 = require('./lib/win32');
const { Report } = require('./lib/report');
// config 读写/还原共通 helper（工单124）：缺位读不抛、缺位落桩、三态还原——四电池单点维护
const { readConfigRaw, patchTaskbar, restoreConfig, CONFIG_FILE } = require('./lib/battery-config');
const { cdpPortFor } = require('./lib/registry');
// 工单210：事件磁带（app/accept/lib/event-tape）——等待/读事件收口到一份正典实现；
// 超时档 8000（taskbar 族五块档，母票 #201 决策 8）
const { createEventTape } = require('./lib/event-tape');
// 工单211：面板句柄（app/accept/lib/panel-control 的 createPanelHandle）——发射/就绪/
// 重启/清场四段样板归句柄；清场走**验证强退**（优雅终止 → 整树强杀 → 有界等待并验证消失）
const { createPanelHandle } = require('./lib/panel-control');

const APP_ROOT = path.resolve(__dirname, '..');
const EVENTS_FILE = path.join(__dirname, 'evidence', '50-taskbar-carry-events.jsonl');
const tape = createEventTape(EVENTS_FILE, { defaultTimeoutMs: 8000 });
// 工单211：句柄装配——守卫链形态 full（['.']，真 guard + watchdog 全链路，stdio 排空
// 管道防堵）与验收面板形态 accept（['.','--panel-accept'] ＋ CDP）；证据档按电池注入
// 专属档名（裁决 10：缺省是八块电池共用的同一文件，混批会让红轮归因变难）
const handle = createPanelHandle({
  execPath: process.execPath, appRoot: APP_ROOT, eventLogPath: EVENTS_FILE,
  archivePath: path.join(__dirname, 'evidence', '50-taskbar-carry-panel-handle-child.log'),
});
// 工单214：CDP 端口自电池接入表取（manifest 的 cdpPort 字段）——端口分配不再靠注释接力。
const CDP_PORT = cdpPortFor('50-taskbar-carry');
const TASKBAR_TITLE = 'DECK-TASKBAR';
const PANEL_TITLE = 'AGENT DECK';
const TASKBAR_HEIGHT_DIP = 48; // src/main/taskbar/window.ts TASKBAR_HEIGHT（工单238 栏高回归 48 DIP）
const ABS_AUTOHIDE_BIT = 0x1;  // ABS_AUTOHIDE（appbar 状态位；src/shared/retract 同值）
const WM_CLOSE = 0x0010;

const koffi = win32.koffi;
const user32 = koffi.load('user32.dll');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(uintptr_t hWnd, uint16 *buf, int nMax)');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 原生任务栏视图事实/兜底还原共用 accept/lib/win32.js 导出（评审收口：四电池同一判据单点维护）
const { nativeTaskbarVisible, ensureNativeTaskbarVisible, appbarState } = win32;

/** 等谓词成立，返回达成时刻距起点的毫秒；超时返回 -1（51 电池同款） */
async function waitMs(pred, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return Date.now() - t0;
    await sleep(60);
  }
  return -1;
}

function hwndOf(win) {
  const v = koffi.decode(win.getNativeWindowHandle(), 'uintptr_t');
  return typeof v === 'bigint' ? Number(v) : v;
}

/** 强制前台（前台锁下 focus() 会静默失败）：AttachThreadInput 链到当前前台线程再 SetForegroundWindow（51 电池同款） */
function forceForeground(hwnd) {
  const fg = Number(win32.GetForegroundWindow());
  const curTid = win32.GetCurrentThreadId();
  const fgTid = fg ? win32.threadIdOf(fg).tid : 0;
  if (fgTid && fgTid !== curTid) win32.AttachThreadInput(curTid, fgTid, true);
  try {
    win32.SetForegroundWindow(hwnd);
    win32.BringWindowToTop(hwnd);
  } finally {
    if (fgTid && fgTid !== curTid) win32.AttachThreadInput(curTid, fgTid, false);
  }
}

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

/**
 * 定点杀面板树（**只杀面板，不杀守卫**）：A3 崩溃路径的段前提就是「面板整树死、守卫存活」，
 * 守卫才能以 panel-exit 还原原生任务栏。**故此处不迁句柄 stop()**——句柄 stop() 会连带
 * 终结发射子进程（＝守卫载体），段前提不成立。「验证消失」由 A3 既有 waitExit(child, 15000)
 * 承担（守卫随面板死亡而退＝面板已死的证据）。
 */
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

/** 电池主体（工单214 导出归一：原 main 改名 runSegments，导出面收归 main） */
async function runSegments() {
  const rep = new Report('50-taskbar-carry');
  const originalConfig = readConfigRaw();
  const prefsBefore = stuckRectsSettings();
  const appbarBaseline = appbarState(); // C2 基线（工单260：off 口径下全程应恒等此值）
  let child = null;   // 当前阶段子进程（守卫链或 --panel-accept）
  let panelPid = 0;   // 面板真实主进程 pid（boot 自报）
  const refWins = []; // 控制器自持参照窗（中性 holder + 收栏触发窗），清场统一销毁
  let sinceOff = 0;   // off 口径时间门（B 相位起；0 = 未到 A4 收尾即异常，C2 按全程严格判）
  const finish = () => {
    const v = rep.verdict(rep.fails === 0 ? 'PASS' : 'FAIL');
    app.exit(v.fails === 0 ? 0 : 1);
  };

  try {
    fs.writeFileSync(EVENTS_FILE, '', 'utf8');
    // 工单261：A 相位改**真置位形态**（A2/A3/A4 断言 appbar 状态复原，出发态必须是
    // 置位在场）——maximizeRetract 钉 on；非收栏的 off 口径由 B 相位（下钉 off）+ C2 把关
    patchTaskbar({ enabled: true, maximizeRetract: true });
    if (!nativeTaskbarVisible()) {
      throw new Error('开跑前原生任务栏已隐藏（他方现场）——先还原再跑，电池不从脏现场出发');
    }

    // —— 阶段A：守卫链全链路（隐藏 + 三条还原路径，收栏置位态出发）——
    // A1 接管开启 → 原生任务栏隐藏，条带落屏底
    rep.beginSegment('A1');
    // 工单261 受控前台（51 电池 P1 同款）：环境里真最大化的前台窗（如常驻开发工具）会
    // 合法触发收栏置位（R1/R2 实测），A1 的「隐藏 + 条带落屏底」只在非收栏前台成立——
    // 中性前台 holder 先立起，钉住前台不被环境夺走；A2 起才由本 holder 主动最大化触发收栏。
    const holder = new BrowserWindow({ width: 240, height: 160, title: 'DECK-CARRY-HOLDER', backgroundColor: '#101010' });
    refWins.push(holder);
    await holder.loadURL('about:blank');
    forceForeground(hwndOf(holder));
    // 工单211：发射归面板句柄——守卫链形态 full（['.']，stdio 排空管道防堵，工单132）
    child = handle.launch({ mode: 'full', stdio: 'drain' }).child;
    const boot1 = await tape.wait('boot', null, { timeoutMs: 20000 });
    if (!boot1) throw new Error('A1 守卫链面板未上报 boot');
    panelPid = boot1.pid;
    rep.note(`A1 守卫 pid=${child.pid} 面板 pid=${panelPid}`);
    forceForeground(hwndOf(holder)); // 再钉一次：boot 等待期间环境可能夺回前台（51 P1 同款纪律）
    const tbHwnd = await handle.waitWindow({ title: TASKBAR_TITLE, timeoutMs: 12000 });
    if (!tbHwnd) throw new Error('A1 任务栏条带窗未出现');
    const hiddenEv = await tape.wait('taskbar-hidden', null, { timeoutMs: 5000 });
    const nativeGone = await waitNativeVisible(false, 5000);
    // 条带几何：净空归零 → 底边 = 屏底（49 P1 同款物理↔DIP 换算）
    // 工单247 栏高口径随动：条带高 = 48DIP（工单238 栏高回归 48，src/main/taskbar/window.ts
    // TASKBAR_HEIGHT）——旧口径 64 是工单158 从 48 升上来的，本票随新排版回归 Win11 原生 48。
    const dip = screen.getPrimaryDisplay().bounds;
    const rect = win32.rectOf(tbHwnd);
    const scale = (rect.right - rect.left) / dip.width;
    const heightDip = (rect.bottom - rect.top) / scale;
    const bottomDip = rect.bottom / scale;
    const geomOk = Math.abs(heightDip - TASKBAR_HEIGHT_DIP) <= 2 && Math.abs(bottomDip - dip.height) <= 2;
    if (hiddenEv && nativeGone && geomOk && isTopmost(tbHwnd)) {
      rep.pass(`A1 接管开启：原生任务栏隐藏（taskbar-hidden 存证 + 视图事实），条带落屏底（条带高 ${Math.round(heightDip)}DIP，底边 DIP ${Math.round(bottomDip)}/${dip.height}）`);
    } else {
      rep.fail(`A1 隐藏存证=${!!hiddenEv} 视图已隐=${nativeGone} 几何=${JSON.stringify({ heightDip, bottomDip, dip: dip.height })} 置顶=${isTopmost(tbHwnd)}`);
    }

    // A2 正常退出（WM_CLOSE 面板主窗 → app.quit）→ 原生任务栏还原 + appbar 状态复原
    rep.beginSegment('A2');
    // M1 置位形态出发：holder 真最大化 + 前台 → 面板进收栏档（收栏拍零 appbar 写入——
    // 置位只在接管建立拍，A1 boot 已落，原状态入还原账，A3/A4 的守卫/守护靠它读复原目标）。
    const sinceA2 = Date.now();
    holder.maximize();
    await sleep(600); // 等最大化落定
    forceForeground(hwndOf(holder));
    const retractEvA2 = await tape.wait('taskbar-retract',
      (e) => e.mode === 'maximize-retract', { since: sinceA2, timeoutMs: 6000 });
    const engagedA2 = await waitMs(() => (appbarState() & ABS_AUTOHIDE_BIT) !== 0, 5000);
    if (!retractEvA2 || engagedA2 < 0) throw new Error('A2 收栏档未达成（前置不成立）');
    const panelHwnd = await handle.waitWindow({ title: PANEL_TITLE, timeoutMs: 8000 });
    if (!panelHwnd) throw new Error('A2 面板主窗未找到');
    win32.PostMessageW(panelHwnd, WM_CLOSE, 0, 0);
    const guardExited = await waitExit(child, 15000);
    // 可见性证据（置位形态，R1/P9 判读）：置位后 explorer 翻开 Shell_TrayWnd 的 WS_VISIBLE
    // 位且退出置位后不回落——可见性复原由 appbar 复原本身达成，taskbar-restored 事件
    // 确证静默（R1 轮磁带实证三段均无该事件，B1 非置位态照常在），断言以退出后的
    // 控制器独立视图事实为准。
    const restoredA2 = await waitNativeVisible(true, 8000);
    // 工单261 断言：appbar 状态复原（控制器独立读数回开跑前基线）+ 复原存证——路径①
    // dispose 还账清账；退避首拍未中则守卫 panel-exit 从落盘账接手（两 reason 都是真实路径）
    const appbarOkA2 = await waitMs(() => appbarState() === appbarBaseline, 8000);
    const autohideEvA2 = await tape.wait('taskbar-autohide-restored',
      (e) => e.reason === 'dispose' || e.reason === 'panel-exit', { since: sinceA2, timeoutMs: 8000 });
    if (guardExited && restoredA2 && appbarOkA2 >= 0 && autohideEvA2) {
      rep.pass(`A2 正常退出路径：原生任务栏还原（控制器独立视图事实，守卫随退=${guardExited}）`
        + `＋appbar 状态复原（reason=${autohideEvA2.reason}，attempts=${autohideEvA2.attempts}，读数 ${appbarState()}＝基线 ${appbarBaseline}，控制器独立读数）`);
    } else {
      rep.fail(`A2 守卫退=${guardExited} 视图还原=${restoredA2} `
        + `appbar复原=${appbarOkA2}ms 状态=${appbarState()}/${appbarBaseline} autohide存证=${JSON.stringify(autohideEvA2)}`);
    }
    child = null;

    // A3 崩溃路径（taskkill /F /T 面板树，守卫存活）→ 守卫 panel-exit 还原
    rep.beginSegment('A3');
    const sinceA3 = Date.now();
    forceForeground(hwndOf(holder)); // holder 仍最大化——钉回前台，收栏在开拍即成立
    child = handle.launch({ mode: 'full', stdio: 'drain' }).child;
    const boot3 = await tape.wait('boot', undefined, { since: sinceA3, timeoutMs: 20000 });
    if (!boot3) throw new Error('A3 守卫链面板未上报 boot');
    panelPid = boot3.pid;
    if (!(await handle.waitWindow({ title: TASKBAR_TITLE, timeoutMs: 12000 }))) throw new Error('A3 条带窗未出现');
    // 工单261 置位形态前置（M1 口径）：置位态下 explorer 翻开 Shell_TrayWnd 的 WS_VISIBLE
    // 位，旧「原生任务栏未被隐藏」前置不可判读（R1 取证）——改以收栏档存证 + AUTOHIDE 位
    // 读数（控制器独立）为前置。收栏拍零 appbar 写入——置位在 boot 拍已落。
    const retractEvA3 = await tape.wait('taskbar-retract',
      (e) => e.mode === 'maximize-retract', { since: sinceA3, timeoutMs: 6000 });
    const engagedA3 = await waitMs(() => (appbarState() & ABS_AUTOHIDE_BIT) !== 0, 5000);
    if (!retractEvA3 || engagedA3 < 0) throw new Error('A3 收栏档未达成（前置不成立）');
    killTree(panelPid); // 模拟崩溃/强杀：面板整树死，守卫存活（**不迁句柄**——见 killTree 注）
    const guardExited3 = await waitExit(child, 15000);
    const restoredA3 = await waitNativeVisible(true, 8000); // 可见性以控制器独立视图事实为准（置位形态，R1/P9 判读）
    // 工单261 断言：appbar 状态复原——面板被强杀（路径① 未走），守卫从**落盘账**读
    // 复原目标（不持面板内存账，票面「还原账全路径扩展」的路径② 现场证据）
    const appbarOkA3 = await waitMs(() => appbarState() === appbarBaseline, 8000);
    const autohideEvA3 = await tape.wait('taskbar-autohide-restored',
      (e) => e.reason === 'panel-exit', { since: sinceA3, timeoutMs: 8000 });
    if (restoredA3 && appbarOkA3 >= 0 && autohideEvA3) {
      rep.pass(`A3 崩溃路径：面板被 taskkill /F 后守卫双兜底（可见性=控制器独立视图事实 + appbar 落盘账复原`
        + ` reason=panel-exit attempts=${autohideEvA3.attempts}，读数 ${appbarState()}＝基线 ${appbarBaseline}，守卫随退=${guardExited3}）`);
    } else {
      rep.fail(`A3 视图还原=${restoredA3} `
        + `appbar复原=${appbarOkA3}ms 状态=${appbarState()}/${appbarBaseline} autohide存证=${JSON.stringify(autohideEvA3)} 守卫退=${guardExited3}`);
    }
    child = null;

    // A4 进程被杀路径：守卫 + 面板先后强杀（控制台信号同杀的等价现场——守卫进程内
    // 还原钩子全灭），还原守护（detached 出生、无控制台收信号）以 guard-dead 翻回。
    rep.beginSegment('A4');
    const sinceA4 = Date.now();
    forceForeground(hwndOf(holder)); // holder 仍最大化——钉回前台，收栏在开拍即成立
    child = handle.launch({ mode: 'full', stdio: 'drain' }).child;
    const boot4 = await tape.wait('boot', undefined, { since: sinceA4, timeoutMs: 20000 });
    if (!boot4) throw new Error('A4 守卫链面板未上报 boot');
    panelPid = boot4.pid;
    const guardPid4 = child.pid;
    const watchEv = await tape.wait('restore-watch-spawned', undefined, { since: sinceA4, timeoutMs: 5000 });
    const watchPid = watchEv ? watchEv.pid : 0;
    if (!(await handle.waitWindow({ title: TASKBAR_TITLE, timeoutMs: 12000 }))) throw new Error('A4 条带窗未出现');
    // 工单261 置位形态前置（同 A3：置位态 WS_VISIBLE 位被翻开，改以存证 + 位读数为前置）
    const retractEvA4 = await tape.wait('taskbar-retract',
      (e) => e.mode === 'maximize-retract', { since: sinceA4, timeoutMs: 6000 });
    const engagedA4 = await waitMs(() => (appbarState() & ABS_AUTOHIDE_BIT) !== 0, 5000);
    if (!retractEvA4 || engagedA4 < 0) throw new Error('A4 收栏档未达成（前置不成立）');
    // 先杀守卫（不带 /T：守护是守卫的子进程，/T 会把它一起带走——守护的存活前提
    // 正是「控制台信号只同杀有控制台的进程」，这里用不带 /T 复刻该现场），再杀面板树。
    spawnSync('taskkill', ['/PID', String(guardPid4), '/F'], { stdio: 'ignore' });
    // 工单211：面板树清场归句柄**验证强退**（守卫已死，句柄的整树强杀落在死 pid 上是
    // 空操作——还原守护的「不带 /T」前提不受影响；gone=false 即中止信号）
    const stoppedA4 = await handle.stop();
    if (!stoppedA4.gone) {
      rep.exclude(`面板强退失败：强杀后有界等待内仍存活（pid=${stoppedA4.pidsLeft.join(', ')}）——需重启清障`,
        '面板强退序列未能终结面板进程', 'panel-forcekill');
      throw new Error('面板强退失败：需重启清障——后续段中止');
    }
    const restoredA4 = await waitNativeVisible(true, 10000); // 可见性以控制器独立视图事实为准（置位形态，R1/P9 判读）
    // 工单261 断言：appbar 状态复原——守卫与面板同灭（路径①② 全灭），还原守护从
    // **落盘账**读复原目标（路径③ 现场证据：守护不持任何面板/守卫内存账）
    const appbarOkA4 = await waitMs(() => appbarState() === appbarBaseline, 10000);
    const autohideEvA4 = await tape.wait('taskbar-autohide-restored',
      (e) => e.reason === 'guard-dead', { since: sinceA4, timeoutMs: 8000 });
    let watchDead = false;
    for (let i = 0; i < 50 && !watchDead && watchPid; i++) { await sleep(200); watchDead = !pidAlive(watchPid); }
    if (restoredA4 && appbarOkA4 >= 0 && autohideEvA4 && watchPid && watchDead) {
      rep.pass(`A4 进程被杀路径：守卫+面板同杀后还原守护以 guard-dead 双兜底（可见性=控制器独立视图事实 + appbar 落盘账复原`
        + ` reason=guard-dead attempts=${autohideEvA4.attempts}，读数 ${appbarState()}＝基线 ${appbarBaseline}；守护 pid=${watchPid} 已自退）`);
    } else {
      rep.fail(`A4 视图还原=${restoredA4} `
        + `appbar复原=${appbarOkA4}ms 状态=${appbarState()}/${appbarBaseline} autohide存证=${JSON.stringify(autohideEvA4)} `
        + `守护 pid=${watchPid} 自退=${watchDead}`);
    }
    child = null;

    // —— 普通态出发的对应轮（工单296，spec #292 退场复原扩全接管期）：A5/A6/A7 与
    // A2/A3/A4 同构（正常退出/崩溃/强杀），出发态改普通栏态。holder 退出最大化钉回
    // 非收栏前台（A1 同款现场）——普通态的前提就是「接管在场、清位在场、未进收栏」，
    // 段前置以 takeover 清位存证 + 读回无 AUTOHIDE 位 + 零置位事件钉住，取代 A2-A4
    // 的收栏置位前置。复原成败一律以系统读回事实裁决（appbarState() === 基线），
    // 「发过复原请求」不算数（spec 用户故事 14）。
    holder.unmaximize();
    await sleep(600); // 等还原落定：普通态出发的前提是非最大化前台
    forceForeground(hwndOf(holder));

    // A5 正常退出（WM_CLOSE 面板主窗，普通态出发）→ appbar 读回复原基线 + 原生任务栏还原
    rep.beginSegment('A5');
    const sinceA5 = Date.now();
    child = handle.launch({ mode: 'full', stdio: 'drain' }).child;
    const boot5 = await tape.wait('boot', undefined, { since: sinceA5, timeoutMs: 20000 });
    if (!boot5) throw new Error('A5 守卫链面板未上报 boot');
    panelPid = boot5.pid;
    if (!(await handle.waitWindow({ title: TASKBAR_TITLE, timeoutMs: 12000 }))) throw new Error('A5 条带窗未出现');
    // 普通档前置（M1 置位口径）：接管建立即置位（takeover+set 存证 + 读回含 AUTOHIDE 位），
    // 且零收栏档（holder 非最大化前台——retract 存证零条）
    const takeEvA5 = await tape.wait('taskbar-autohide-takeover', undefined, { since: sinceA5, timeoutMs: 5000 });
    const setEvA5 = await tape.wait('taskbar-autohide-set', undefined, { since: sinceA5, timeoutMs: 5000 });
    const engagedA5 = await waitMs(() => (appbarState() & ABS_AUTOHIDE_BIT) !== 0, 5000);
    const straysA5 = tape.all('taskbar-retract', undefined, { since: sinceA5 });
    if (!takeEvA5 || !setEvA5 || engagedA5 < 0 || straysA5.length > 0) {
      throw new Error(`A5 普通档前置不成立（接管=${!!takeEvA5} 置位=${!!setEvA5} 读回=${appbarState()} 收栏档=${straysA5.length}）`);
    }
    const panelHwndA5 = await handle.waitWindow({ title: PANEL_TITLE, timeoutMs: 8000 });
    if (!panelHwndA5) throw new Error('A5 面板主窗未找到');
    win32.PostMessageW(panelHwndA5, WM_CLOSE, 0, 0);
    const guardExitedA5 = await waitExit(child, 15000);
    const restoredA5 = await waitNativeVisible(true, 8000);
    const appbarOkA5 = await waitMs(() => appbarState() === appbarBaseline, 8000);
    const autohideEvA5 = await tape.wait('taskbar-autohide-restored',
      (e) => e.reason === 'dispose' || e.reason === 'panel-exit', { since: sinceA5, timeoutMs: 8000 });
    if (guardExitedA5 && restoredA5 && appbarOkA5 >= 0 && autohideEvA5) {
      rep.pass(`A5 正常退出路径（普通档出发）：appbar 读回复原（reason=${autohideEvA5.reason}，attempts=${autohideEvA5.attempts}，`
        + `读数 ${appbarState()}＝基线 ${appbarBaseline}，控制器独立读数；出发置位读数 userState=${takeEvA5.userState}）`
        + `＋原生任务栏还原（视图事实，守卫随退=${guardExitedA5}）——退场复原不随档位缩水（spec #292/#306）`);
    } else {
      rep.fail(`A5 守卫退=${guardExitedA5} 视图还原=${restoredA5} appbar复原=${appbarOkA5}ms 状态=${appbarState()}/${appbarBaseline} `
        + `autohide存证=${JSON.stringify(autohideEvA5)} 接管存证=${JSON.stringify(takeEvA5)}`);
    }
    child = null;

    // A6 崩溃路径（taskkill /F /T 面板树，守卫存活，普通态出发）→ 守卫 panel-exit 从落盘账复原
    rep.beginSegment('A6');
    const sinceA6 = Date.now();
    child = handle.launch({ mode: 'full', stdio: 'drain' }).child;
    const boot6 = await tape.wait('boot', undefined, { since: sinceA6, timeoutMs: 20000 });
    if (!boot6) throw new Error('A6 守卫链面板未上报 boot');
    panelPid = boot6.pid;
    if (!(await handle.waitWindow({ title: TASKBAR_TITLE, timeoutMs: 12000 }))) throw new Error('A6 条带窗未出现');
    const takeEvA6 = await tape.wait('taskbar-autohide-takeover', undefined, { since: sinceA6, timeoutMs: 5000 });
    const setEvA6 = await tape.wait('taskbar-autohide-set', undefined, { since: sinceA6, timeoutMs: 5000 });
    const engagedA6 = await waitMs(() => (appbarState() & ABS_AUTOHIDE_BIT) !== 0, 5000);
    const straysA6 = tape.all('taskbar-retract', undefined, { since: sinceA6 });
    if (!takeEvA6 || !setEvA6 || engagedA6 < 0 || straysA6.length > 0) {
      throw new Error(`A6 普通档前置不成立（接管=${!!takeEvA6} 置位=${!!setEvA6} 读回=${appbarState()} 收栏档=${straysA6.length}）`);
    }
    killTree(panelPid);
    const guardExitedA6 = await waitExit(child, 15000);
    const restoredA6 = await waitNativeVisible(true, 8000);
    const appbarOkA6 = await waitMs(() => appbarState() === appbarBaseline, 8000);
    const autohideEvA6 = await tape.wait('taskbar-autohide-restored',
      (e) => e.reason === 'panel-exit', { since: sinceA6, timeoutMs: 8000 });
    if (restoredA6 && appbarOkA6 >= 0 && autohideEvA6 && guardExitedA6) {
      rep.pass(`A6 崩溃路径（普通态出发）：面板被 taskkill /F 后守卫 panel-exit 从落盘账复原（attempts=${autohideEvA6.attempts}，`
        + `读数 ${appbarState()}＝基线 ${appbarBaseline}，控制器独立读数；账记于普通态接管建立拍）`
        + `＋原生任务栏还原（视图事实，守卫随退=${guardExitedA6}）`);
    } else {
      rep.fail(`A6 视图还原=${restoredA6} appbar复原=${appbarOkA6}ms 状态=${appbarState()}/${appbarBaseline} `
        + `autohide存证=${JSON.stringify(autohideEvA6)} 守卫退=${guardExitedA6} 接管存证=${JSON.stringify(takeEvA6)}`);
    }
    child = null;

    // A7 进程被杀路径（守卫 + 面板先后强杀，普通态出发）→ 还原守护以 guard-dead 从落盘账复原后自退
    rep.beginSegment('A7');
    const sinceA7 = Date.now();
    forceForeground(hwndOf(holder)); // 普通态前提再钉（A4 同款纪律：开拍即钉回前台）
    child = handle.launch({ mode: 'full', stdio: 'drain' }).child;
    const boot7 = await tape.wait('boot', undefined, { since: sinceA7, timeoutMs: 20000 });
    if (!boot7) throw new Error('A7 守卫链面板未上报 boot');
    panelPid = boot7.pid;
    const guardPid7 = child.pid;
    const watchEv7 = await tape.wait('restore-watch-spawned', undefined, { since: sinceA7, timeoutMs: 5000 });
    const watchPid7 = watchEv7 ? watchEv7.pid : 0;
    if (!(await handle.waitWindow({ title: TASKBAR_TITLE, timeoutMs: 12000 }))) throw new Error('A7 条带窗未出现');
    const takeEvA7 = await tape.wait('taskbar-autohide-takeover', undefined, { since: sinceA7, timeoutMs: 5000 });
    const setEvA7 = await tape.wait('taskbar-autohide-set', undefined, { since: sinceA7, timeoutMs: 5000 });
    const engagedA7 = await waitMs(() => (appbarState() & ABS_AUTOHIDE_BIT) !== 0, 5000);
    const straysA7 = tape.all('taskbar-retract', undefined, { since: sinceA7 });
    if (!takeEvA7 || !setEvA7 || engagedA7 < 0 || straysA7.length > 0) {
      throw new Error(`A7 普通档前置不成立（接管=${!!takeEvA7} 置位=${!!setEvA7} 读回=${appbarState()} 收栏档=${straysA7.length}）`);
    }
    // 同 A4：先杀守卫（不带 /T——守护是守卫子进程，/T 会把它一起带走），再强退面板树
    spawnSync('taskkill', ['/PID', String(guardPid7), '/F'], { stdio: 'ignore' });
    const stoppedA7 = await handle.stop();
    if (!stoppedA7.gone) {
      rep.exclude(`面板强退失败：强杀后有界等待内仍存活（pid=${stoppedA7.pidsLeft.join(', ')}）——需重启清障`,
        '面板强退序列未能终结面板进程', 'panel-forcekill');
      throw new Error('A7 面板强退失败：需重启清障——后续段中止');
    }
    const restoredA7 = await waitNativeVisible(true, 10000);
    const appbarOkA7 = await waitMs(() => appbarState() === appbarBaseline, 10000);
    const autohideEvA7 = await tape.wait('taskbar-autohide-restored',
      (e) => e.reason === 'guard-dead', { since: sinceA7, timeoutMs: 8000 });
    let watchDead7 = false;
    for (let i = 0; i < 50 && !watchDead7 && watchPid7; i++) { await sleep(200); watchDead7 = !pidAlive(watchPid7); }
    if (restoredA7 && appbarOkA7 >= 0 && autohideEvA7 && watchPid7 && watchDead7) {
      rep.pass(`A7 进程被杀路径（普通态出发）：守卫+面板同杀后还原守护以 guard-dead 从落盘账复原（attempts=${autohideEvA7.attempts}，`
        + `读数 ${appbarState()}＝基线 ${appbarBaseline}，控制器独立读数；账记于普通态接管建立拍；守护 pid=${watchPid7} 已自退）`);
    } else {
      rep.fail(`A7 视图还原=${restoredA7} appbar复原=${appbarOkA7}ms 状态=${appbarState()}/${appbarBaseline} `
        + `autohide存证=${JSON.stringify(autohideEvA7)} 守护 pid=${watchPid7} 自退=${watchDead7} 接管存证=${JSON.stringify(takeEvA7)}`);
    }
    child = null;

    // A 相位收尾（工单261）：holder 退出最大化、钉回普通档前台；B 相位钉 maximizeRetract
    // =off——M1 下 off 只关收栏档（托管恒置位照走），off 口径由 C2 把关。
    holder.unmaximize();
    forceForeground(hwndOf(holder));
    sinceOff = Date.now(); // C2 的 off 口径时间门：B 相位起的置位事件应恒零
    patchTaskbar({ maximizeRetract: false });

    // —— 阶段B：逃生开关真机链路（--panel-accept + CDP 驱动设置浮层真实 DOM）——
    const sinceB = Date.now();
    child = handle.launch({ mode: 'accept', cdpPort: CDP_PORT, stdio: 'ignore' }).child;
    const bootB = await tape.wait('boot', undefined, { since: sinceB, timeoutMs: 20000 });
    if (!bootB) throw new Error('B 验收面板未上报 boot');
    panelPid = bootB.pid;
    if (!(await handle.waitWindow({ title: TASKBAR_TITLE, timeoutMs: 12000 }))) throw new Error('B 条带窗未出现');
    if (!(await waitNativeVisible(false, 5000))) throw new Error('B 原生任务栏未被隐藏（前置不成立）');

    // B1 设置浮层关开关（真实 DOM 点击链：settings-btn → taskbar-toggle）→ 原生即还原
    rep.beginSegment('B1');
    await cdpEval(`document.getElementById('settings-btn').click()`);
    const openedEv = await tape.wait('settings-opened', undefined, { since: sinceB, timeoutMs: 5000 });
    if (!openedEv) throw new Error('B1 设置浮层未开（settings-opened 存证缺失）');
    if (!openedEv.taskbarToggle) throw new Error('B1 开层存证缺 taskbarToggle 矩形（渲染层未上报）');
    const toggleState = await cdpEval(`document.getElementById('taskbar-toggle').checked`);
    await cdpEval(`document.getElementById('taskbar-toggle').click()`);
    const setEvOff = await tape.wait('settings-taskbar-set', (e) => e.enabled === false, { since: sinceB, timeoutMs: 6000 });
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
    rep.beginSegment('B2');
    await cdpEval(`document.getElementById('taskbar-toggle').click()`);
    const setEvOn = await tape.wait('settings-taskbar-set', (e) => e.enabled === true, { since: sinceB, timeoutMs: 6000 });
    const nativeGoneB2 = await waitNativeVisible(false, 8000);
    const tbBackB2 = await handle.waitWindow({ title: TASKBAR_TITLE, timeoutMs: 8000 });
    if (setEvOn && nativeGoneB2 && tbBackB2) {
      rep.pass('B2 逃生开关再开：原生任务栏再隐、条带恢复（开关双向可用）');
    } else {
      rep.fail(`B2 回执=${JSON.stringify(setEvOn)} 视图已隐=${nativeGoneB2} 条带回=${!!tbBackB2}`);
    }
  } catch (err) {
    rep.fail(`电池异常: ${err && err.stack || err}`);
  } finally {
    // 清场（自带容错：清场内部任何抛错都不能拦住 finish()，否则控制器不退、
    // accept-guard 租约被挂死——首轮实证教训）：销参照窗 → 杀子进程 → --icon-restore
    // 自救通道（工单50 起同通道还原图标 + 原生任务栏；工单261 起兼收 appbar 落盘账）
    // → 还原 config → 核验用户任务栏偏好（自动隐藏等）字节级不变。
    try {
      // 工单261：参照窗先销（holder 最大化在场会干扰清场后的现场核读）
      for (const w of refWins) { try { if (!w.isDestroyed()) w.destroy(); } catch { /* 尽力 */ } }
      // 工单211：收尾清场归句柄验证强退（gone=false 只入环境降责账、**不中止**——
      // 清场段任何抛错都会拦住 finish() → 控制器不退 → 验收槽租约挂死）
      const cleared = await handle.stop();
      if (cleared && cleared.gone === false) {
        rep.exclude(`清场核验：面板强退失败：强杀后有界等待内仍存活（pid=${cleared.pidsLeft.join(', ')}）——需重启清障`,
          '清场后仍有面板进程存活', 'panel-forcekill');
      }
      await sleep(800);
      try {
        spawnSync(process.execPath, ['.', '--icon-restore'], {
          cwd: APP_ROOT, env: { ...process.env, DECK_EVENT_LOG: EVENTS_FILE }, stdio: 'ignore', timeout: 20000,
        });
      } catch { /* 尽力 */ }
      await sleep(500);
      try { ensureNativeTaskbarVisible(); } catch { /* 兜底中的兜底也不许抛 */ }
      try { restoreConfig(originalConfig); } catch { /* 尽力（三态还原，工单124：缺位来、缺位去） */ }
      // C1 偏好不扰（工单50；工单260 措辞收口）：清场收尾时首末两点比对用户既有任务栏
      // 偏好——断言「面板生命周期结束后字节复原」（收栏置位 ABS_AUTOHIDE 不回写注册表，
      // spike 取证 StuckRects3 三点全等，docs/audit/2026-10-24-t257-autohide-setstate-probe.md）
      rep.beginSegment('C1');
      const prefsAfter = stuckRectsSettings();
      if (prefsAfter === prefsBefore) {
        rep.pass('C1 用户任务栏偏好退出后字节复原（StuckRects3 Settings 首末两点一致——「面板生命周期结束后字节复原」口径）');
      } else {
        rep.fail(`C1 任务栏偏好未被复原：before=${JSON.stringify(prefsBefore)} after=${JSON.stringify(prefsAfter)}`);
      }
      // C2 off 口径（工单260；工单293 全接管期改段；工单308 M1 改写，spec #306）：M1 下
      // off 只关收栏档、托管恒置位照走——「接管期全程仅建立/退场两次状态写入」的计数式
      // 断言：B 相位两次接管生命周期（B1 boot 开、B2 再开），每次恰**两次写入**（建立置位
      // 一次 set + 退场复原一次 restored——B1 禁用径 reason=disabled、收尾自救径
      // reason=force），运行期零其他写入（无 set-failed/reattach 中间态——恒置位单账，
      // 旧「收栏置位零条」判据随「off=清位」语义退役）；退出后 appbar 状态 = 开跑前基线
      // （控制器独立读数，不依赖面板自证）。
      rep.beginSegment('C2');
      const setEvents = tape.all('taskbar-autohide-set', undefined, { since: sinceOff });
      const restoredEvents = tape.all('taskbar-autohide-restored', undefined, { since: sinceOff });
      const otherWrites = tape.all('taskbar-autohide-set-failed', undefined, { since: sinceOff }).length
        + tape.all('taskbar-autohide-reattached', undefined, { since: sinceOff }).length
        + tape.all('taskbar-autohide-reattach-failed', undefined, { since: sinceOff }).length;
      const restoredOk = restoredEvents.length >= 2
        && restoredEvents.every((e) => e.reason === 'disabled' || e.reason === 'force');
      const stateAfter = appbarState();
      if (setEvents.length === 2 && restoredOk && otherWrites === 0 && stateAfter === appbarBaseline) {
        rep.pass(`C2 off 口径（M1：off 只关收栏档，托管恒置位）：B 相位两次接管生命周期各恰两次状态写入——`
          + `建立置位 set ${setEvents.length} 次（B1 boot + B2 再开各一）＋退场复原 ${restoredEvents.length} 条全为禁用/自救径`
          + `（reason=${restoredEvents.map((e) => e.reason).join('/') || '无'}——禁用/退出把用户原值还回去是设计行为）、`
          + `运行期其他写入（set-failed/reattach 族）${otherWrites} 条（恒置位单账无中间态）`
          + `＋退出后 appbar 状态 ${stateAfter} = 开跑前基线 ${appbarBaseline}（控制器独立读数）`);
      } else {
        rep.fail(`C2 off 口径被破（M1 计数式）：建立置位 set ${setEvents.length} 条（期望恰 2——两次接管各一） `
          + `退场复原 ${restoredEvents.length} 条（期望 ≥2）reason 异常 ${restoredEvents.filter((e) => e.reason !== 'disabled' && e.reason !== 'force').length} 条 `
          + `其他写入 ${otherWrites} 条（期望 0） appbar 状态=${stateAfter} 基线=${appbarBaseline}`);
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

/**
 * 导出归一（工单214，spec #203 决策 6）：控制器已在 whenReady 内调起 → 直接导出 main
 * （消双重 whenReady 包装）；崩溃兜底在此收口，机械等价于原 wrapper 的 catch。
 */
async function main() {
  try {
    await runSegments();
  } catch (e) {
    // 主体自带 try/finally 与内部 finish()，正常不会到这；真到了也要让控制器退出（租约不挂死）
    console.error('CARRY BATTERY CRASH:', e && e.stack || e);
    app.exit(2);
  }
}

module.exports = main;
