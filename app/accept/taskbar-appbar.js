'use strict';
// 工单51 任务栏 AppBar 工作区占位 + 全屏让位验收：控制器以 --accept-taskbar-appbar
// 身份运行，拉起 --panel-accept 面板子进程（绕单实例锁），逐项验收：
//   P1 AppBar 占位生效：taskbar-appbar-registered 存证 + SPI_GETWORKAREA 底边
//      = 屏底 - 48DIP（物理像素口径；工单238 栏高回归 48），条带几何与占位同矩形
//   P2 最大化让位：控制器自开参照窗 maximize → 底边停在栏上方不被遮挡
//      （工单244 改段：参照窗**不占前台**——前台真最大化窗会触发工单241 的
//        「最大化收栏」（方向相反）；中性前台 holder 把前台挪开，占位语义不变）
//   P3 分辨率变化重算：切到另一受支持分辨率 → taskbar-appbar-setpos
//      （reason=display-metrics-changed）存证 + 条带与工作区随新分辨率重算 → 还原
//   P4 全屏让位：控制器自开全屏参照窗并置前台 → 条带隐藏（taskbar-yield 存证 +
//      视图事实）；销毁全屏窗 → 1 秒内恢复（taskbar-yield-lifted 存证 + 时延断言）
//   P5 卸载归还：面板正常退出（WM_CLOSE）→ AppBar 注销（taskbar-appbar-removed
//      存证）+ 工作区归还基线
//   P6 最大化收栏（工单244；工单260 改段不变式）：前台真最大化窗 → 注销 AppBar
//      （taskbar-retract 存证 appBar=removed + taskbar-appbar-removed 存证）+ 置位
//      ABS_AUTOHIDE（原生栏托管）→ 占位与原生保留带双释放，工作区底边 = 屏底（±2）、
//      参照窗铺满整屏；解除最大化 → 重注册（taskbar-retract-lifted appBar=registered
//      + taskbar-appbar-registered）+ 复原原状态 → 占位恢复（底边回一栏高）
//   P7 三态优先级（工单244；工单260 随动不变式）：全屏让位压过收栏（全屏态条带整窗
//      退场 + 占位恢复 + 复原置位 + 全屏期间无收栏存证）；退出全屏回到最大化窗 →
//      收栏态自动回来（taskbar-retract 再落，底边回屏底）
//   P8 降级档禁用（工单244）：AppBar 注册失败 ⇒ 收栏整体禁用——降级档在场则断
//      「无占位 + 无收栏让位存证 + 条带在场」三后果；健康档则断收栏存证的 appBar
//      字段（removed/registered ⇒ 占位在场才谈得上收栏；降级档恒为 kept）
//   P9 收栏态退出双复原（工单260）：重拉面板进收栏（置位 ABS_AUTOHIDE、工作区到屏底）
//      → 收栏态下 WM_CLOSE 正常退出 → 可见性与 appbar 状态双复原（还原路径①；控制器
//      独立读数为主——置位态 explorer 翻开 Shell_TrayWnd 的 WS_VISIBLE 位，面板侧
//      showNativeTaskbar 走「已可见静默」不发存证，可见性不依赖面板自证）
// 运行：npm run accept:taskbar-appbar（= electron . --accept-taskbar-appbar）。
// 与其他验收同一铁律：必须经 accept-guard 托管（真机分辨率切换与前台注入，互斥）。
const { app, screen, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const win32 = require('./lib/win32');
const { Report } = require('./lib/report');
// config 读写/还原共通 helper（工单124）：缺位读不抛、缺位落桩、三态还原——四电池单点维护
const { readConfigRaw, patchTaskbar, restoreConfig } = require('./lib/battery-config');
// 工单210：事件磁带（app/accept/lib/event-tape）——等待/读事件收口到一份正典实现；
// 超时档 8000（taskbar 族五块档，母票 #201 决策 8）
const { createEventTape } = require('./lib/event-tape');
// 工单211：面板句柄（app/accept/lib/panel-control 的 createPanelHandle）——发射/就绪/
// 重启/清场四段样板归句柄；清场走**验证强退**（优雅终止 → 整树强杀 → 有界等待并验证消失）
const { createPanelHandle } = require('./lib/panel-control');

const APP_ROOT = path.resolve(__dirname, '..');
const EVENTS_FILE = path.join(__dirname, 'evidence', '51-taskbar-appbar-events.jsonl');
const tape = createEventTape(EVENTS_FILE, { defaultTimeoutMs: 8000 });
// 工单211：句柄装配——发射形态 accept（['.','--panel-accept']；本电池不注入 CDP 端口，
// 与现行 spawn 的 env 逐字同形）；证据档按电池注入专属档名（裁决 10）
const handle = createPanelHandle({
  execPath: process.execPath, appRoot: APP_ROOT, eventLogPath: EVENTS_FILE,
  archivePath: path.join(__dirname, 'evidence', '51-taskbar-appbar-panel-handle-child.log'),
});
const TASKBAR_TITLE = 'DECK-TASKBAR';
const PANEL_TITLE = 'AGENT DECK';
const TASKBAR_HEIGHT_DIP = 48; // src/main/taskbar/window.ts TASKBAR_HEIGHT（工单238 起 48）
const WM_CLOSE = 0x0010;
const SPI_GETWORKAREA = 0x0030;
const ENUM_CURRENT_SETTINGS = -1;
const DISP_CHANGE_SUCCESSFUL = 0;
// DEVMODEW 字段偏移（220 字节定长布局）：dmSize@68, dmPelsWidth@172, dmPelsHeight@176
const DEVMODE_SIZE = 220;
const OFF_PELS_WIDTH = 172;
const OFF_PELS_HEIGHT = 176;

const koffi = win32.koffi;
const user32 = koffi.load('user32.dll');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(uintptr_t hWnd, uint16 *buf, int nMax)');
const SystemParametersInfoW = user32.func('bool __stdcall SystemParametersInfoW(uint32 uiAction, uint32 uiParam, _Out_ RECT *pvParam, uint32 fWinIni)');
const EnumDisplaySettingsW = user32.func('bool __stdcall EnumDisplaySettingsW(void *lpszDeviceName, int32 iModeNum, void *lpDevMode)');
const ChangeDisplaySettingsW = user32.func('int32 __stdcall ChangeDisplaySettingsW(void *lpDevMode, uint32 dwFlags)');

const { nativeTaskbarVisible, ensureNativeTaskbarVisible, appbarState } = win32;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hwndOf(win) {
  const v = koffi.decode(win.getNativeWindowHandle(), 'uintptr_t');
  return typeof v === 'bigint' ? Number(v) : v;
}

/** 强制前台（前台锁下 focus() 会静默失败）：AttachThreadInput 链到当前前台线程再 SetForegroundWindow */
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

/** 当前工作区（物理像素）：AppBar 占位的系统侧事实 */
function workArea() {
  const r = {};
  if (!SystemParametersInfoW(SPI_GETWORKAREA, 0, r, 0)) return null;
  return r;
}

/** 主屏物理尺寸（GetWindowRect/AppBar 同口径） */
function primaryPhys() {
  const d = screen.getPrimaryDisplay();
  return {
    width: Math.round(d.bounds.width * d.scaleFactor),
    height: Math.round(d.bounds.height * d.scaleFactor),
    scale: d.scaleFactor,
  };
}

/** 等谓词成立，返回达成时刻距起点的毫秒；超时返回 -1 */
async function waitMs(pred, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return Date.now() - t0;
    await sleep(60);
  }
  return -1;
}

/** 当前主屏模式快照（ENUM_CURRENT_SETTINGS，完整 DEVMODE 原文供还原） */
function currentDisplayMode() {
  const buf = Buffer.alloc(DEVMODE_SIZE);
  if (!EnumDisplaySettingsW(null, ENUM_CURRENT_SETTINGS, buf)) return null;
  return buf;
}

/** 枚举一个与当前分辨率不同的受支持模式（供 P3 切换）；找不到返回 null */
function alternateDisplayMode(cur) {
  const curW = cur.readUInt32LE(OFF_PELS_WIDTH);
  const curH = cur.readUInt32LE(OFF_PELS_HEIGHT);
  const buf = Buffer.alloc(DEVMODE_SIZE);
  for (let i = 0; EnumDisplaySettingsW(null, i, buf); i++) {
    const w = buf.readUInt32LE(OFF_PELS_WIDTH);
    const h = buf.readUInt32LE(OFF_PELS_HEIGHT);
    if (w !== curW && h !== curH) return { buf: Buffer.from(buf), width: w, height: h };
  }
  return null;
}

function setDisplayMode(buf) {
  return ChangeDisplaySettingsW(buf, 0) === DISP_CHANGE_SUCCESSFUL;
}

/** 电池主体（工单214 导出归一：原 main 改名 runSegments，导出面收归 main） */
async function runSegments() {
  const rep = new Report('51-taskbar-appbar');
  const originalConfig = readConfigRaw();
  const originalMode = currentDisplayMode();
  let panelPid = 0;
  let modeSwitched = false;
  const refWins = [];
  const finish = () => {
    const v = rep.verdict(rep.fails === 0 ? 'PASS' : 'FAIL');
    app.exit(v.fails === 0 ? 0 : 1);
  };

  try {
    fs.writeFileSync(EVENTS_FILE, '', 'utf8');
    patchTaskbar({ enabled: true });
    // guard 拿槽时会强杀常驻面板，其藏下的原生任务栏由还原守护在数秒内翻回——
    // 先等守护/兜底把现场收干净，再校验出发态（不从不属于自己的隐藏态出发）。
    await waitMs(() => nativeTaskbarVisible(), 10000);
    ensureNativeTaskbarVisible();
    await sleep(500);
    if (!nativeTaskbarVisible()) {
      throw new Error('开跑前原生任务栏已隐藏（他方现场，等待+兜底后仍未还原）——先人工核查再跑');
    }
    // 工作区基线（原生任务栏可见、我方未占位的出发态）：P5 归还断言对标它——
    // 可见的原生任务栏自身就占底边一档，「归还」= 回到基线而非满屏。
    const waBaseline = workArea();
    if (!waBaseline) throw new Error('开跑前读不到工作区（SPI_GETWORKAREA）');
    if (!originalMode) throw new Error('读取当前显示模式失败（EnumDisplaySettingsW）');

    // —— P1：AppBar 占位生效 ——
    rep.beginSegment('P1');
    // 工单260 起常驻态断言需要受控前台：环境里真最大化的前台窗（如常驻开发工具）会
    // 合法触发收栏置位 ABS_AUTOHIDE（工作区底边到屏底），P1 的「底边=屏高−48」从此只在
    // 非收栏前台成立——把 P2 的中性前台 holder 前移到开测前立起，钉住前台不被环境夺走
    // （旧 P1 无前台控制：#260 前收栏不动工作区数值，故当时无害；R2 实测 ZCode 最大化
    // 前台使 P1 红段，磁带 taskbar-autohide-set/restore 成对干净——产品行为正确，电池缺受控）。
    const neutralWin = new BrowserWindow({ width: 240, height: 160, title: 'DECK-ACCEPT-NEUTRAL', backgroundColor: '#101010' });
    refWins.push(neutralWin);
    await neutralWin.loadURL('about:blank');
    forceForeground(hwndOf(neutralWin));
    // 工单211：发射归面板句柄（mode='accept' ＝ ['.','--panel-accept']，本电池不带 CDP 端口）
    handle.launch({ mode: 'accept', stdio: 'ignore' });
    const boot = await tape.wait('boot', null, { timeoutMs: 20000 });
    if (!boot) throw new Error('P1 面板未上报 boot');
    panelPid = boot.pid;
    const tbHwnd = await handle.waitWindow({ title: TASKBAR_TITLE, timeoutMs: 12000 });
    if (!tbHwnd) throw new Error('P1 任务栏条带窗未出现');
    forceForeground(hwndOf(neutralWin)); // 再钉一次：boot 等待期间环境可能夺回前台（最大化窗会翻收栏档）;
    const regEv = await tape.wait('taskbar-appbar-registered', null, { timeoutMs: 5000 });
    const setposEv = await tape.wait('taskbar-appbar-setpos', (e) => e.reason === 'create', { timeoutMs: 5000 });
    // 工作区收缩有生效时延，轮询到期望值
    const phys0 = primaryPhys();
    const expectBottom0 = phys0.height - Math.round(TASKBAR_HEIGHT_DIP * phys0.scale);
    const waMs = await waitMs(() => {
      const wa = workArea();
      return wa && Math.abs(wa.bottom - expectBottom0) <= 2;
    }, 5000);
    const wa1 = workArea();
    const stripRect = win32.rectOf(tbHwnd);
    const stripOk = stripRect && Math.abs(stripRect.bottom - phys0.height) <= 2;
    if (regEv && setposEv && waMs >= 0 && stripOk) {
      rep.pass(`P1 AppBar 占位生效：工作区底边 ${wa1.bottom}/${phys0.height}（让出 ${phys0.height - wa1.bottom}px ≈ ${TASKBAR_HEIGHT_DIP}DIP×${phys0.scale}），条带底边 ${stripRect.bottom} 贴屏底`);
    } else {
      rep.fail(`P1 注册存证=${!!regEv} setpos=${!!setposEv} 工作区=${JSON.stringify(wa1)} 期望底=${expectBottom0} 条带=${JSON.stringify(stripRect)} 屏高=${phys0.height}`);
    }

    // —— P2：最大化让位（参照窗 maximize → 底边停在栏上方）——
    // 工单244 改段（理由见 PR 描述）：工单241「最大化收栏」落地后，**前台**真最大化窗
    // 会触发收栏（栏给窗让位：注销我方 AppBar 占位登记 → 栏面退场；系统工作区数值不变），与本段测的
    // 旧语义「最大化让位」（窗给栏让位：占位收缩 → 窗底边停在栏上沿）方向相反。本段
    // 断言逐字不改，但要成立必须让参照窗**不占前台**——否则被测的是收栏语义而非让位
    // 语义。故控制器自建一枚中性前台 holder 把前台从参照窗挪开：占位仍生效 ⇒ 参照窗
    // （即便非前台）照样被工作区约束在栏上沿，测量对象与旧语义一致。
    rep.beginSegment('P2');
    // 中性前台 holder 已在 P1 前立起（工单260 前移，见 P1 段注）——本段只建最大化参照窗
    const maxWin = new BrowserWindow({ width: 800, height: 600, title: 'DECK-ACCEPT-MAX', backgroundColor: '#203040' });
    refWins.push(maxWin);
    await maxWin.loadURL('about:blank');
    maxWin.maximize();
    await sleep(1200); // 等最大化落定
    forceForeground(hwndOf(neutralWin)); // 前台挪离参照窗（否则触发工单241 收栏，方向相反）
    await sleep(500); // 等 250ms 轮询过一拍
    // 占位回稳（若收栏已触发过，此等待把它等回来）——测量前占位必须生效
    const expectBottom2 = phys0.height - Math.round(TASKBAR_HEIGHT_DIP * phys0.scale);
    await waitMs(() => {
      const wa = workArea();
      return wa && Math.abs(wa.bottom - expectBottom2) <= 2;
    }, 5000);
    const maxRect = win32.rectOf(hwndOf(maxWin));
    const stripTop = win32.rectOf(tbHwnd).top;
    const waP2 = workArea();
    const maxOk = maxRect && Math.abs(maxRect.bottom - stripTop) <= 8 && maxRect.bottom < phys0.height - 8;
    if (maxOk && waP2 && Math.abs(maxRect.bottom - waP2.bottom) <= 8) {
      rep.pass(`P2 最大化让位：参照窗底边 ${maxRect.bottom} 停在栏上沿 ${stripTop}（屏底 ${phys0.height}，未被遮挡）`);
    } else {
      rep.fail(`P2 参照窗=${JSON.stringify(maxRect)} 栏上沿=${stripTop} 工作区底=${waP2 && waP2.bottom} 屏高=${phys0.height} 前台=${Number(win32.GetForegroundWindow())}`);
    }

    // —— P3：分辨率变化重算（切到另一受支持模式 → setpos 存证 + 几何重算 → 还原）——
    rep.beginSegment('P3');
    const alt = alternateDisplayMode(originalMode);
    if (!alt) {
      rep.fail('P3 找不到与当前不同的受支持分辨率（本机显示模式枚举异常）');
    } else {
      const sinceP3 = Date.now();
      if (!setDisplayMode(alt.buf)) {
        rep.fail(`P3 ChangeDisplaySettingsW 切到 ${alt.width}x${alt.height} 被拒`);
      } else {
        modeSwitched = true;
        await sleep(1500); // 等显示器重同步 + display-metrics-changed 投递
        const reposEv = await tape.wait('taskbar-appbar-setpos',
          (e) => e.reason === 'display-metrics-changed', { since: sinceP3, timeoutMs: 8000 });
        const phys1 = primaryPhys();
        const expectBottom1 = phys1.height - Math.round(TASKBAR_HEIGHT_DIP * phys1.scale);
        const waMs1 = await waitMs(() => {
          const wa = workArea();
          return wa && wa.bottom === expectBottom1;
        }, 5000);
        const waAfter = workArea();
        const stripAfter = await waitMs(() => {
          const r = win32.rectOf(tbHwnd);
          return r && Math.abs(r.bottom - phys1.height) <= 2;
        }, 5000);
        const stripRect1 = win32.rectOf(tbHwnd);
        if (reposEv && waMs1 >= 0 && stripAfter >= 0 && phys1.height === alt.height) {
          rep.pass(`P3 分辨率变化重算：${alt.width}x${alt.height} 下工作区底 ${waAfter.bottom}、条带底 ${stripRect1.bottom} 随新分辨率重算（setpos 存证在流）`);
        } else {
          rep.fail(`P3 setpos存证=${!!reposEv} 工作区=${JSON.stringify(waAfter)} 期望=${expectBottom1} 条带=${JSON.stringify(stripRect1)} 物理=${JSON.stringify(phys1)} 目标=${alt.width}x${alt.height}`);
        }
        if (setDisplayMode(originalMode)) {
          modeSwitched = false;
          await sleep(1500);
          rep.note('P3 分辨率已还原');
        } else {
          rep.note('P3 分辨率还原失败（finally 再试）');
        }
      }
    }

    // —— P4：全屏让位（全屏参照窗前台 → 条带隐藏；退出 → 1 秒内恢复）——
    // 最大化参照窗先还原，避免它 fullscreen 退出后占前台干扰让位判定（它不覆盖
    // 全屏，判定本就为否——还原只为现场干净）。
    rep.beginSegment('P4');
    maxWin.restore();
    const sinceP4 = Date.now();
    const fsWin = new BrowserWindow({ fullscreen: true, frame: false, title: 'DECK-ACCEPT-FULLSCREEN', backgroundColor: '#101820' });
    refWins.push(fsWin);
    await fsWin.loadURL('about:blank');
    fsWin.show();
    fsWin.focus();
    forceForeground(hwndOf(fsWin)); // 前台锁下 focus() 静默失败（第3轮实证），强制链入
    const fgMs = await waitMs(() => Number(win32.GetForegroundWindow()) === hwndOf(fsWin), 4000);
    if (fgMs < 0) rep.note(`P4 前台强制未达（fg=${Number(win32.GetForegroundWindow())} fsHwnd=${hwndOf(fsWin)}），让位判定以前台事实为准`);
    const hideMs = await waitMs(() => !win32.IsWindowVisible(tbHwnd), 5000);
    const yieldEv = await tape.wait('taskbar-yield', undefined, { since: sinceP4, timeoutMs: 3000 });
    if (hideMs >= 0 && yieldEv) {
      rep.pass(`P4a 全屏让位：前台全屏参照窗 ${fgMs}ms 落位前台后 ${hideMs}ms 条带隐藏（taskbar-yield 存证 + 视图事实）`);
    } else {
      rep.fail(`P4a 隐藏时延=${hideMs}ms yield存证=${!!yieldEv} 前台落位=${fgMs}ms 条带可见=${win32.IsWindowVisible(tbHwnd)}`);
    }
    const t0 = Date.now();
    fsWin.destroy();
    refWins.pop();
    const liftMs = await waitMs(() => win32.IsWindowVisible(tbHwnd), 5000);
    const liftedEv = await tape.wait('taskbar-yield-lifted', undefined, { since: t0, timeoutMs: 3000 });
    if (liftMs >= 0 && liftMs <= 1000 && liftedEv) {
      rep.pass(`P4b 退出全屏恢复：${liftMs}ms 内条带恢复（≤1 秒口径，taskbar-yield-lifted 存证）`);
    } else {
      rep.fail(`P4b 恢复时延=${liftMs}ms lifted存证=${!!liftedEv} 条带可见=${win32.IsWindowVisible(tbHwnd)}`);
    }

    // —— P6：最大化收栏（工单244 新增；工单260 改段不变式）：收栏注销 AppBar + 置位
    //        ABS_AUTOHIDE（原生栏托管）→ 占位与原生保留带双释放；恢复双还 → 占位恢复 ——
    // 术语：「收栏」= 栏给窗让位（与 P2 的「最大化让位」= 窗给栏让位方向相反，两词不混用）。
    // 断言面（真机可观测）：
    //   ① 收栏存证 taskbar-retract（mode=maximize-retract，appBar=removed）+ AppBar 注销存证
    //      taskbar-appbar-removed —— 「占位释放」在 **AppBar 注册层**可观测；
    //   ② 工作区不变式（工单260 改段）：收栏态底边 = 屏底（±2）——置位 ABS_AUTOHIDE 后
    //      shell 释放原生任务栏 48px 保留带（spike 取证 docs/audit/2026-10-24-t257-
    //      autohide-setstate-probe.md：1392→1440），「还回整屏」自此可观测（旧断言
    //      「底边 ≥ 屏底−48」是保留带不可释放时代（t250 取证）的口径）；
    //   ③ 参照窗铺满整屏（票面验收）：工作区扩张后最大化窗重排，底边贴屏底（±8——
    //      最大化窗 8px 装饰边，spike 判据 2 同容差）；
    //   ④ 恢复：taskbar-retract-lifted（mode=visible，appBar=registered）+ taskbar-appbar-registered
    //      + 工作区回一栏高（重注册占位 + 复原置位，两笔账同拍收敛）。
    rep.beginSegment('P6');
    rep.note(`P6 口径（工单260 改段）：收栏置位 ABS_AUTOHIDE（原生栏托管）后 shell 释放原生任务栏 48px 保留带，`
      + `工作区底边 1392→1440=屏底（spike 实测）——旧断言「收栏态底边 ≥ 屏底−48」退役，`
      + `新不变式「底边 = 屏底（±2）」+ 参照窗铺满整屏（±8 装饰边）；恢复态断言不变（回一栏高）。`);
    const phys6 = primaryPhys();
    const expectBottom6 = phys6.height - Math.round(TASKBAR_HEIGHT_DIP * phys6.scale);
    const retractWin = new BrowserWindow({ width: 800, height: 600, title: 'DECK-ACCEPT-RETRACT', backgroundColor: '#203040' });
    refWins.push(retractWin);
    await retractWin.loadURL('about:blank');
    const sinceP6 = Date.now(); // 时间门必须在触发动作之前（收栏存证落在最大化之后）
    retractWin.maximize();
    await sleep(600);
    forceForeground(hwndOf(retractWin)); // 前台锁下 focus() 静默失败，必须走强制链入
    const fgMs6 = await waitMs(() => Number(win32.GetForegroundWindow()) === hwndOf(retractWin), 4000);
    // 收栏存证：mode=maximize-retract 且 appBar=removed（占位确实被注销）
    const retractEv6 = await tape.wait('taskbar-retract',
      (e) => e.mode === 'maximize-retract' && e.appBar === 'removed', { since: sinceP6, timeoutMs: 6000 });
    const removedEv6 = await tape.wait('taskbar-appbar-removed', undefined, { since: sinceP6, timeoutMs: 3000 });
    // 工作区不变式（工单260）：轮询到屏底（±2）——置位生效（保留带释放）有生效时延
    const waMs6 = await waitMs(() => {
      const wa = workArea();
      return wa && Math.abs(wa.bottom - phys6.height) <= 2;
    }, 5000);
    // 参照窗铺满整屏：工作区扩张后已最大化的窗重排到底（±8 装饰边，spike 判据 2 同容差）
    const retractHwnd6 = hwndOf(retractWin);
    const flushMs6 = await waitMs(() => {
      const r = win32.rectOf(retractHwnd6);
      return r && r.bottom >= phys6.height - 8;
    }, 5000);
    const waRetract6 = workArea();
    const refRect6 = win32.rectOf(retractHwnd6);
    // 恢复：解除最大化（前台不再是真最大化窗）→ 重注册 AppBar + 复原置位 → 栏面复现
    const t6 = Date.now();
    retractWin.unmaximize();
    forceForeground(hwndOf(neutralWin));
    // 退收栏存证（工单260 起容忍两跳路径）：收栏态最大化窗铺满整屏（底边 1448），解最大化
    // 动画期 250ms 轮询可能拍到「zoomed=false + 矩形仍全屏」→ 合法走 retract→yield→visible
    // 两跳（R3 磁带实证：retract-lifted mode=fullscreen-yield + yield-lifted mode=visible，
    // 中间 yield 态占位重注册/复原置位照做）；直达路径 retract-lifted 直接带 mode=visible。
    // 谓词只放宽「终点 visible 的到达方式」，断言面不降：退收栏必带 appBar=registered。
    const liftedEv6 = await tape.wait('taskbar-retract-lifted',
      (e) => e.appBar === 'registered', { since: t6, timeoutMs: 6000 });
    let settledVisible6 = !!liftedEv6 && liftedEv6.mode === 'visible';
    if (liftedEv6 && liftedEv6.mode !== 'visible') {
      const ylEv6 = await tape.wait('taskbar-yield-lifted', undefined, { since: t6, timeoutMs: 6000 });
      settledVisible6 = !!ylEv6 && ylEv6.mode === 'visible';
    }
    const regEv6 = await tape.wait('taskbar-appbar-registered', undefined, { since: t6, timeoutMs: 3000 });
    const restoreMs6 = await waitMs(() => {
      const wa = workArea();
      return wa && Math.abs(wa.bottom - expectBottom6) <= 2;
    }, 5000);
    const waRestored6 = workArea();
    const workAreaOk6 = waMs6 >= 0 && flushMs6 >= 0 && restoreMs6 >= 0 && settledVisible6
      && !!waRetract6 && Math.abs(waRetract6.bottom - phys6.height) <= 2
      && !!waRestored6 && Math.abs(waRestored6.bottom - expectBottom6) <= 2;
    if (retractEv6 && removedEv6 && liftedEv6 && regEv6 && workAreaOk6) {
      rep.pass(`P6 最大化收栏：前台真最大化窗 ${fgMs6}ms 落位后注销 AppBar + 置位 ABS_AUTOHIDE（taskbar-retract 存证 appBar=${retractEv6.appBar} + taskbar-appbar-removed 存证）`
        + `→ 占位与原生保留带双释放：工作区底边 ${waRetract6.bottom}/${phys6.height} = 屏底（±2，${waMs6}ms 到位）、`
        + `参照窗底边 ${refRect6.bottom} 铺满整屏（${flushMs6}ms 重排到底）；`
        + `解除最大化后重注册 + 复原（taskbar-retract-lifted 存证 appBar=${liftedEv6.appBar} + taskbar-appbar-registered 存证）`
        + `→ 工作区回一栏高 ${waRestored6.bottom}（期望 ${expectBottom6}，${restoreMs6}ms 收敛）`);
    } else {
      rep.fail(`P6 收栏存证=${!!retractEv6} 注销存证=${!!removedEv6} 恢复存证=${!!liftedEv6}（终点visible=${settledVisible6}） 重注册存证=${!!regEv6} `
        + `工作区收栏态=${JSON.stringify(waRetract6)}/屏底=${phys6.height}（到屏底=${waMs6}ms） 参照窗=${JSON.stringify(refRect6)}（贴底=${flushMs6}ms） `
        + `恢复态=${JSON.stringify(waRestored6)} 期望底=${expectBottom6}（收敛=${restoreMs6}ms）`);
    }

    // —— P7：三态优先级（工单244 新增；工单260 随动不变式）：全屏让位压过收栏；退出全屏
    //        回到最大化窗时收栏态自动回来 ——
    rep.beginSegment('P7');
    // 前置：回到收栏态（最大化参照窗在前台）
    const sinceP7 = Date.now();
    retractWin.maximize();
    await sleep(600);
    forceForeground(hwndOf(retractWin));
    const retractEv7 = await tape.wait('taskbar-retract',
      (e) => e.mode === 'maximize-retract' && e.appBar === 'removed', { since: sinceP7, timeoutMs: 6000 });
    // 全屏让位压过收栏：前台切到全屏参照窗 → 条带整窗退场 + 占位恢复（重注册 + 复原置位）
    const sinceFs7 = Date.now();
    const fsWin7 = new BrowserWindow({ fullscreen: true, frame: false, title: 'DECK-ACCEPT-FS7', backgroundColor: '#101820' });
    refWins.push(fsWin7);
    await fsWin7.loadURL('about:blank');
    fsWin7.show();
    fsWin7.focus();
    forceForeground(hwndOf(fsWin7));
    const fgMs7 = await waitMs(() => Number(win32.GetForegroundWindow()) === hwndOf(fsWin7), 4000);
    const hideMs7 = await waitMs(() => !win32.IsWindowVisible(tbHwnd), 5000);
    const yieldEv7 = await tape.wait('taskbar-yield',
      (e) => e.mode === 'fullscreen-yield', { since: sinceFs7, timeoutMs: 5000 });
    // 让位态占位必须生效（重注册 AppBar）——收栏被全屏压住的可观测口径；工作区随重注册
    // + 复原置位收敛回一栏高（工单260：收栏态的屏底不变式退出后必须回得来）
    const occEv7 = await tape.wait('taskbar-appbar-registered', undefined, { since: sinceFs7, timeoutMs: 3000 });
    const waYieldMs7 = await waitMs(() => {
      const wa = workArea();
      return wa && Math.abs(wa.bottom - expectBottom6) <= 2;
    }, 5000);
    const waYield7 = workArea();
    // 全屏期间不得有收栏存证（收栏被全屏压住）——取「全屏窗销毁前」的窗口快照
    const t7 = Date.now();
    const retractInFull7 = tape.all('taskbar-retract', (e) => e.mode === 'maximize-retract', { since: sinceFs7 })
      .filter((e) => e.t < t7);
    // 退出全屏 → 回到最大化窗 → 收栏态自动回来
    fsWin7.destroy();
    refWins.pop();
    forceForeground(hwndOf(retractWin)); // 回到最大化参照窗（前台）
    const showMs7 = await waitMs(() => win32.IsWindowVisible(tbHwnd), 5000);
    const retractEv7b = await tape.wait('taskbar-retract',
      (e) => e.mode === 'maximize-retract' && e.appBar === 'removed', { since: t7, timeoutMs: 6000 });
    const relEv7b = await tape.wait('taskbar-appbar-removed', undefined, { since: t7, timeoutMs: 3000 });
    // 回程收栏态工作区（工单260）：再置位生效 → 底边回屏底（±2）
    const waMs7b = await waitMs(() => {
      const wa = workArea();
      return wa && Math.abs(wa.bottom - phys6.height) <= 2;
    }, 5000);
    const waRetract7 = workArea();
    const priorityOk7 = waYieldMs7 >= 0 && !!waYield7 && Math.abs(waYield7.bottom - expectBottom6) <= 2
      && waMs7b >= 0 && !!waRetract7 && Math.abs(waRetract7.bottom - phys6.height) <= 2;
    if (retractEv7 && yieldEv7 && hideMs7 >= 0 && occEv7 && retractInFull7.length === 0
      && retractEv7b && relEv7b && priorityOk7) {
      rep.pass(`P7 三态优先级：收栏态在前台全屏窗 ${fgMs7}ms 落位后 ${hideMs7}ms 被全屏让位压过`
        + `（taskbar-yield 存证、条带整窗退场、占位恢复 appBar-registered 存证在流、工作区底边 ${waYield7.bottom} 回一栏高、全屏期间收栏存证 0 条）；`
        + `退出全屏回到最大化窗后收栏态自动回来（taskbar-retract 再落 appBar=${retractEv7b && retractEv7b.appBar} + taskbar-appbar-removed、`
        + `条带 ${showMs7}ms 复现、工作区底边 ${waRetract7.bottom} 回屏底）`);
    } else {
      rep.fail(`P7 收栏存证=${!!retractEv7} yield存证=${!!yieldEv7} 隐藏时延=${hideMs7}ms 占位恢复存证=${!!occEv7} 工作区(让位)=${JSON.stringify(waYield7)}（收敛=${waYieldMs7}ms） `
        + `全屏期间收栏存证=${retractInFull7.length} 条 回程收栏存证=${!!retractEv7b} 注销存证=${!!relEv7b} 条带复现=${showMs7}ms 工作区(回程收栏)=${JSON.stringify(waRetract7)}（到屏底=${waMs7b}ms） 期望底=${expectBottom6}/屏底=${phys6.height}`);
    }

    // P7 收尾：面板回常驻（解除最大化 + 前台挪开 + 等恢复存证落地）——P5「卸载归还」段
    // 要求 AppBar 在场（收栏态下占位已注销，退出时不会有 taskbar-appbar-removed 存证）
    const t7end = Date.now();
    retractWin.unmaximize();
    forceForeground(hwndOf(neutralWin));
    const backEv7 = await tape.wait('taskbar-retract-lifted',
      (e) => e.mode === 'visible' && e.appBar === 'registered', { since: t7end, timeoutMs: 5000 });
    if (!backEv7) rep.note('P7 收尾：面板未回常驻（收栏态残留）——P5 的卸载归还段将受影响');

    // —— P8：降级档禁用（工单244 新增）：AppBar 注册失败 ⇒ 收栏整体禁用 ——
    // 降级档的机器可观测锚点 = 面板报「AppBar 注册失败」（taskbar-appbar-register-failed）。
    // 该前提由系统 AppBar 服务是否拒绝注册决定——真机无法从外部让系统拒绝（面板走的是
    // 同一条 SHAppBarMessage(ABM_NEW) 通路，产品侧无外部注入点），故本段立「条件式
    // 不变量」：降级档在场 ⇒ 断三后果（无占位 / 无收栏与让位存证 / 条带在场）；
    // 降级档不在场（注册成功，本机常态）⇒ 断收栏存证的 appBar 字段（removed/registered
    // ⇒ 占位在场才谈得上收栏；降级档下该字段恒为 kept——占位不在场 ⇒ 无从释放），
    // 即「降级档禁用」的可观测反面：收栏整体依赖占位在场。
    rep.beginSegment('P8');
    const regEv8 = tape.latest('taskbar-appbar-registered', undefined, {});
    const failEv8 = tape.latest('taskbar-appbar-register-failed', undefined, {});
    if (failEv8) {
      // 降级档在场：断三后果
      const retractAll8 = tape.all('taskbar-retract', undefined, {});
      const yieldAll8 = tape.all('taskbar-yield', undefined, {});
      const wa8 = workArea();
      const noOcc8 = !!wa8 && wa8.bottom >= phys6.height - 2; // 无工作区占位
      const noEv8 = retractAll8.length === 0 && yieldAll8.length === 0; // 收栏与让位整体禁用
      const stripAlive8 = win32.IsWindowVisible(tbHwnd); // 降级档只禁收栏，不禁栏本身
      if (noOcc8 && noEv8 && stripAlive8) {
        rep.pass(`P8 降级档禁用：AppBar 注册失败存证在流 ⇒ 无工作区占位（底边 ${wa8.bottom}/屏高 ${phys6.height}）、`
          + `无收栏与让位存证（retract ${retractAll8.length} 条 / yield ${yieldAll8.length} 条）、条带窗在场可见（收栏整体禁用）`);
      } else {
        rep.fail(`P8 降级档在场但后果不符：无占位=${noOcc8} 无收栏让位存证=${noEv8} 条带在场=${stripAlive8} 工作区=${JSON.stringify(wa8)}`);
      }
    } else {
      // 健康档（注册成功）：断收栏存证的 appBar 字段——占位在场才谈得上收栏/恢复
      const retractAll8 = tape.all('taskbar-retract', (e) => e.mode === 'maximize-retract');
      const liftedAll8 = tape.all('taskbar-retract-lifted', (e) => e.mode === 'visible');
      const removedOk8 = retractAll8.length > 0 && retractAll8.every((e) => e.appBar === 'removed');
      const registeredOk8 = liftedAll8.length > 0 && liftedAll8.every((e) => e.appBar === 'registered');
      if (regEv8 && removedOk8 && registeredOk8) {
        rep.pass(`P8 降级档禁用（健康档对照）：AppBar 注册成功（非降级档，降级档在本机不可复现——系统不拒绝注册）；`
          + `收栏存证 ${retractAll8.length} 条 appBar 全为 removed（占位释放到位）、恢复存证 ${liftedAll8.length} 条 appBar 全为 registered`
          + `（占位重注册到位）——降级档下该字段恒为 kept（占位不在场 ⇒ 无从释放），故收栏整体依赖占位在场`);
      } else {
        rep.fail(`P8 注册存证=${!!regEv8} 收栏存证=${JSON.stringify(retractAll8.map((e) => e.appBar))} 恢复存证=${JSON.stringify(liftedAll8.map((e) => e.appBar))}`);
      }
    }

    // —— P5：卸载归还（面板正常退出 → AppBar 注销 + 工作区归还全屏）——
    rep.beginSegment('P5');
    const sinceP5 = Date.now();
    const panelHwnd = await handle.waitWindow({ title: PANEL_TITLE, timeoutMs: 8000 });
    if (!panelHwnd) throw new Error('P5 面板主窗未找到');
    win32.PostMessageW(panelHwnd, WM_CLOSE, 0, 0);
    const removeEv = await tape.wait('taskbar-appbar-removed', undefined, { since: sinceP5, timeoutMs: 8000 });
    // 归还判据 = 回到开跑前基线（原生任务栏还原后自身占底边一档，不是满屏）
    const restoreMs = await waitMs(() => {
      const wa = workArea();
      return wa && Math.abs(wa.bottom - waBaseline.bottom) <= 2 && Math.abs(wa.top - waBaseline.top) <= 2;
    }, 8000);
    const waEnd = workArea();
    if (removeEv && restoreMs >= 0) {
      rep.pass(`P5 卸载归还：面板退出即注销 AppBar（存证在流），工作区归还基线（底边 ${waEnd.bottom}/基线 ${waBaseline.bottom}）`);
    } else {
      rep.fail(`P5 removed存证=${!!removeEv} 归还时延=${restoreMs}ms 工作区=${JSON.stringify(waEnd)} 基线=${JSON.stringify(waBaseline)}`);
    }

    // —— P9：收栏态面板正常退出 → 可见性与 appbar 状态双复原（工单260 新增，还原路径①）——
    // P5 验的是常驻态退出的占位归还；本段验 #260 验收标准「面板正常退出 → 双复原」的
    // 收栏态形态。判读注意（R1 取证）：置位态 explorer 翻开 Shell_TrayWnd 的 WS_VISIBLE 位
    // （「窗口显示位」≠「视觉在场」，spike 附记），面板侧 showNativeTaskbar 会走「已可见
    // 静默」不发 taskbar-restored——可见性以退出后的控制器独立视图事实为准。
    rep.beginSegment('P9');
    handle.launch({ mode: 'accept', stdio: 'ignore' });
    const boot9 = await tape.wait('boot', null, { timeoutMs: 20000 });
    if (!boot9) throw new Error('P9 面板未上报 boot');
    panelPid = boot9.pid;
    if (!(await handle.waitWindow({ title: TASKBAR_TITLE, timeoutMs: 12000 }))) throw new Error('P9 条带窗未出现');
    forceForeground(hwndOf(neutralWin)); // 出发态回常驻（P9 的收栏须由参照窗前台真最大化触发）
    const state9 = appbarState();
    const sinceP9 = Date.now();
    retractWin.maximize();
    await sleep(600);
    forceForeground(hwndOf(retractWin));
    const retractEv9 = await tape.wait('taskbar-retract',
      (e) => e.mode === 'maximize-retract' && e.appBar === 'removed', { since: sinceP9, timeoutMs: 6000 });
    const setEv9 = await tape.wait('taskbar-autohide-set', undefined, { since: sinceP9, timeoutMs: 3000 });
    const retractWa9 = await waitMs(() => {
      const wa = workArea();
      return wa && Math.abs(wa.bottom - phys6.height) <= 2;
    }, 5000);
    // 收栏态下正常退出（WM_CLOSE 主窗 → app.quit → dispose：置位复原走路径①）
    const t9 = Date.now();
    const panelHwnd9 = await handle.waitWindow({ title: PANEL_TITLE, timeoutMs: 8000 });
    if (!panelHwnd9) throw new Error('P9 面板主窗未找到');
    win32.PostMessageW(panelHwnd9, WM_CLOSE, 0, 0);
    const restoredEv9 = await tape.wait('taskbar-autohide-restored',
      (e) => e.reason === 'dispose', { since: t9, timeoutMs: 8000 });
    // 双复原断言（控制器独立读数）：appbar 状态回出发值 + 工作区回基线 + 原生栏可见
    const stateOk9 = await waitMs(() => appbarState() === state9, 8000);
    const waOk9 = await waitMs(() => {
      const wa = workArea();
      return wa && Math.abs(wa.bottom - waBaseline.bottom) <= 2;
    }, 8000);
    const nativeOk9 = await waitMs(() => nativeTaskbarVisible(), 8000);
    if (retractEv9 && setEv9 && retractWa9 >= 0 && restoredEv9 && stateOk9 >= 0 && waOk9 >= 0 && nativeOk9 >= 0) {
      rep.pass(`P9 收栏态退出双复原：收栏（taskbar-retract + taskbar-autohide-set previous=${setEv9.previous}）工作区到屏底 ${phys6.height}；`
        + `收栏态 WM_CLOSE 退出 → taskbar-autohide-restored reason=dispose（attempts=${restoredEv9.attempts}，路径①）；`
        + `控制器独立读数三复原：appbar 状态回 ${appbarState()}（出发 ${state9}）、工作区回基线 ${waBaseline.bottom}、原生栏可见`);
    } else {
      rep.fail(`P9 收栏存证=${!!retractEv9} 置位存证=${!!setEv9} 到屏底=${retractWa9}ms 复原存证=${JSON.stringify(restoredEv9)} `
        + `状态复原=${stateOk9}ms 工作区复原=${waOk9}ms 原生可见=${nativeOk9 >= 0} 状态现值=${appbarState()}/${state9} 工作区基线=${waBaseline.bottom}`);
    }
  } catch (err) {
    rep.fail(`电池异常: ${err && err.stack || err}`);
  } finally {
    // 清场（容错同 carry 电池：任何抛错都不能拦住 finish()）：关参照窗 → 杀面板 →
    // 还原分辨率 → --icon-restore 自救 → 还原 config。
    try {
      for (const w of refWins) { try { if (!w.isDestroyed()) w.destroy(); } catch { /* 尽力 */ } }
      // 工单211：面板清场归句柄**验证强退**（优雅终止 → 整树强杀 → 有界等待并验证消失；
      // gone=false 只入环境降责账、**不中止**——清场段抛错会拦住 finish() → 控制器不退）
      const cleared = await handle.stop();
      if (cleared && cleared.gone === false) {
        rep.exclude(`清场核验：面板强退失败：强杀后有界等待内仍存活（pid=${cleared.pidsLeft.join(', ')}）——需重启清障`,
          '清场后仍有面板进程存活', 'panel-forcekill');
      }
      await sleep(800);
      if (modeSwitched) {
        try { if (setDisplayMode(originalMode)) rep.note('清场：分辨率已还原'); } catch { /* 尽力 */ }
      }
      try {
        require('child_process').spawnSync(process.execPath, ['.', '--icon-restore'], {
          cwd: APP_ROOT, env: { ...process.env, DECK_EVENT_LOG: EVENTS_FILE }, stdio: 'ignore', timeout: 20000,
        });
      } catch { /* 尽力 */ }
      await sleep(500);
      try { ensureNativeTaskbarVisible(); } catch { /* 兜底中的兜底也不许抛 */ }
      try { restoreConfig(originalConfig); } catch { /* 尽力（三态还原，工单124） */ }
      try {
        (await waitMs(() => nativeTaskbarVisible(), 5000)) >= 0
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
    console.error('APPBAR BATTERY CRASH:', e && e.stack || e);
    app.exit(2);
  }
}

module.exports = main;
