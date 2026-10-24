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
//   P10 收栏态原生栏重申轮询（工单262，段位垫底——explorer 重启断基线）：可见性翻转压回
//      （SW_SHOWNOACTIVATE 注入 → reason=visible 重申 + 压回）；explorer 重启重挂（Stop-Process
//      explorer + AutoRestartShell 归位 → 新 Shell_TrayWnd → reason=rebuild 重申 + 隐藏及时
//      ≤4s + 置位终态 ≤25s（新 explorer 约 15s 不接受窗，逐拍重试）→ 工作区回屏底）；
//      非收栏态休止（退收栏后翻开原生栏 2.6s 零重申存证且保持可见）
//   P11 分屏收栏单窗最小闭环（工单269）：Win+Left 键盘合成建立真 Snap（IsWindowArranged
//      直读互证）→ 会话存证 taskbar-snap-session(active) + 收栏（注销+置位：工作区=屏底±2）
//      且前台钉中性 holder（后台事实，普通前台不打断）；Snap 窗上下贴边（Windows 自动重排，
//      工单268 定谳——面板零改窗）；唤出条悬停弹出且 Snap 窗矩形逐字不变；Win+Down 解除
//      → 会话结束 + 重注册复原（工作区回一栏高）；SetWindowPos 摆半屏几何伪分屏阴性
//      （2+ 轮询拍零收栏/零会话存证、工作区不动——矩形不得成为身份兜底）
//   P12 分屏会话集合生命周期与代表性布局（工单270）：左右双窗统一进入分屏收栏并上下
//      贴边；普通前台切换不打断（矩形逐字不变、工作区保持屏底）；解除其一仍维持、最后
//      一个解除结束（cause=unsnapped）并复原（解除相在新近 Snap 窗上做——Win+Down 对
//      自最小化恢复的 Snap 窗有最小化歧义，R1 实测）；重 Snap 后最小化其一仍维持、最后
//      一个最小化结束（cause=minimized 存证）且恢复即按当前事实重建；三分之一加三分之
//      二布局经 Win+Z 布局浮出数字键通道定位，同一真 Snap 判定收栏贴边（无布局专用分支）
//   P13 虚拟桌面切换隔离与收栏理由接续（工单270）：四角布局统一判定；Win+Ctrl+D 切到
//      新桌面 → 会话结束（cause=desktop-switched）+ 工作区复原；切回原桌面按该桌面实际
//      布局重建会话；真最大化前台期间关闭全部 Snap 窗 → 会话结束（cause=closed +
//      retractHeldByZoomed=true、无 retract-lifted、工作区保持屏底——理由接续不先恢复
//      再收栏），解除最大化才单次复原
// 运行：npm run accept:taskbar-appbar（= electron . --accept-taskbar-appbar）。
// 与其他验收同一铁律：必须经 accept-guard 托管（真机分辨率切换与前台注入，互斥）。
const { app, screen, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawnSync, spawn } = require('child_process');
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
// 工单269 分屏收栏：真 Snap 判据直读（验收侧第三档直绑先例——电池自绑自证）
const IsWindowArrangedFn = user32.func('bool __stdcall IsWindowArranged(uintptr_t hWnd)');
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
    // 外部宿主进程（工单269 P11 的 powershell WinForms Snap 参照窗）：finally 强杀兜底
    const extProcs = [];
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
    // 工单269 起分屏收栏上真机：桌面若有他方真 Snap 布局（分屏会话是**后台事实**，与
    // 前台无关），面板合法进收栏档，P1/P2/P6/P7/P9/P10/P11 的常驻态与收栏触发断言会被
    // 翻掉。开跑前先清场：枚举真 Snap 窗（IsWindowArranged 直读）→ SW_MINIMIZE（最小化
    // 的 Snap 窗不建会话——用户点任务栏图标即原样回 Snap 态，可逆不打扰布局）；清不掉
    // 的残留报环境现场 fail-fast（与「原生任务栏已隐藏」同款纪律）。
    const ownPid11 = process.pid;
    const liveSnapWindows = () => win32.topLevelWindows().filter((h) => {
      try {
        return Boolean(IsWindowArrangedFn(h)) && !win32.IsIconic(h) && win32.threadIdOf(h).pid !== ownPid11;
      } catch { return false; }
    });
    let preSnaps = liveSnapWindows();
    if (preSnaps.length) {
      for (const h of preSnaps) win32.ShowWindow(h, 6 /* SW_MINIMIZE */);
      await waitMs(() => liveSnapWindows().length === 0, 4000);
      const left11 = liveSnapWindows();
      if (left11.length) {
        throw new Error(`开跑前桌面有 ${left11.length} 扇无法最小化的真 Snap 窗（他方现场，最小化清场后仍在）`
          + '——分屏会话会合法触发收栏，本电池无从断言常驻态，先人工清理再跑');
      }
      rep.note(`P 前置清场：桌面有他方真 Snap 窗 ${preSnaps.length} 扇，已 SW_MINIMIZE（最小化 Snap 窗不建会话；用户点任务栏图标即原样回 Snap 态）`);
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

    // —— P11：分屏收栏单窗最小闭环（工单269 新增）——
    // 断言面（票面验收判据的真机观测；条件性补齐路径按 #268 定谳不存在——面板零改窗）：
    //   ① 单窗进入：Win+Left 键盘合成（系统通道，#268 探针同款）建立真 Snap（电池侧
    //      IsWindowArranged 直读互证）→ 会话存证 taskbar-snap-session(active=true) +
    //      收栏存证 taskbar-retract（appBar=removed）→ 工作区底边=屏底±2（占位与原生
    //      保留带双释放，与 P6 同一不变式——分屏收栏复用同一效果层）；
    //   ② 后台事实：前台钉在中性 holder（普通前台切换不打断会话，spec 用户故事 8/9）；
    //   ③ 上下贴边：Snap 窗顶≈屏顶、底≈屏底（Windows 自动重排贴新工作区——工单268
    //      三轮定谳；DWM 7px 不可见边容差同 P6 装饰边口径）；
    //   ④ 唤出：taskbar-summon-strips 存证 + 悬停弹出该组（hotzones 里 summon:pill:*）
    //      且弹出前后 Snap 窗矩形逐字不变（唤出不改窗尺寸）；
    //   ⑤ 解除恢复：Win+Down 解除 → IsWindowArranged=false + 会话存证(active=false) +
    //      taskbar-retract-lifted(appBar=registered) → 工作区回一栏高（占位+置位双复原）；
    //   ⑥ 伪分屏阴性：SetWindowPos 摆出半屏几何（非 Snap）→ 3+ 轮询拍零收栏存证、
    //      零会话存证、工作区不动（矩形不得成为身份兜底）。
    rep.beginSegment('P11');
    const phys11 = primaryPhys();
    const expectBottom11 = phys11.height - Math.round(TASKBAR_HEIGHT_DIP * phys11.scale);
    // 出发态回常驻（P8 只读不断态；此处等占位生效档落定再开测）
    await waitMs(() => {
      const wa = workArea();
      return wa && Math.abs(wa.bottom - expectBottom11) <= 2;
    }, 5000);
    // 键盘和弦：LWIN 压下 → 方向 tap → LWIN 抬起（Win+Left 建 Snap / Win+Down 解除）
    const VK_LWIN = 0x5b, VK_LEFT = 0x25, VK_DOWN = 0x28;
    const chord11 = (vk) => {
      win32.send([win32.keyInput(VK_LWIN, win32.KEYDOWN)]);
      win32.send([win32.keyInput(vk, win32.KEYDOWN)]);
      win32.send([win32.keyInput(vk, win32.KEYUP)]);
      win32.send([win32.keyInput(VK_LWIN, win32.KEYUP)]);
    };
    // 前台强制 + 和弦 + 逐拍核验（前台锁下合成和弦只对前台窗生效——不赌时序，失败重试）
    const chordUntil = async (hwnd, vk, wantArranged) => {
      for (let i = 0; i < 5; i++) {
        forceForeground(hwnd);
        await sleep(150);
        if (Number(win32.GetForegroundWindow()) !== hwnd) continue;
        chord11(vk);
        await sleep(400);
        if (Boolean(IsWindowArrangedFn(hwnd)) === wantArranged) return true;
      }
      return false;
    };
    // Snap 参照窗：分屏会话成员资格按 exe 归一排除自家（shouldShowOnTaskbar 既有口径，
    // R1 实证：电池与面板子进程同用 electron.exe ⇒ 电池自建窗被判「自家」不建会话）——
    // 换宿主进程开窗：powershell.exe 起一枚 WinForms 普通顶层窗（exe 不同、可被系统 Snap）。
    const psScript11 = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$f = New-Object System.Windows.Forms.Form",
      "$f.Text = 'DECK-ACCEPT-SNAP-PS'",
      "$f.Width = 900; $f.Height = 700",
      "$f.Add_FormClosed({ [Environment]::Exit(0) })",
      "[System.Windows.Forms.Application]::Run($f)",
    ].join('; ');
    const snapPs11 = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', psScript11], { stdio: 'ignore' });
    extProcs.push(snapPs11);
    const snapHwnd11 = await (async () => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (snapPs11.exitCode !== null) return 0;
        const h = win32.findWindowByPid(snapPs11.pid);
        if (h) return h;
        await sleep(120);
      }
      return 0;
    })();
    const since11 = Date.now(); // 时间门在触发动作（Snap 和弦）之前
    if (!snapHwnd11) {
      rep.fail('P11 Snap 参照窗未出现（powershell WinForms 宿主 10s 内无可见顶层窗——环境异常）');
    } else {
    const snapped11 = await chordUntil(snapHwnd11, VK_LEFT, true);
    if (!snapped11) {
      rep.fail('P11 Snap 建立失败：Win+Left 合成 5 次后 IsWindowArranged 恒 false（环境注入异常——和弦只对前台窗生效，见磁带前台读数）');
    } else {
      // ② 后台事实：前台钉中性 holder——会话与收栏都必须在「前台不是 Snap 窗」时成立
      forceForeground(hwndOf(neutralWin));
      const sessionEv11 = await tape.wait('taskbar-snap-session',
        (e) => e.active === true, { since: since11, timeoutMs: 6000 });
      const retractEv11 = await tape.wait('taskbar-retract',
        (e) => e.mode === 'maximize-retract' && e.appBar === 'removed', { since: since11, timeoutMs: 6000 });
      const waMs11 = await waitMs(() => {
        const wa = workArea();
        return wa && Math.abs(wa.bottom - phys11.height) <= 2;
      }, 5000);
      const waRetract11 = workArea();
      // ③ 上下贴边：自动重排（#268：窗底=屏底+7px DWM 边、顶=-7px——容差 [-10,+8])
      const edgeMs11 = await waitMs(() => {
        const r = win32.rectOf(snapHwnd11);
        return r && r.top >= -10 && r.top <= 8 && r.bottom >= phys11.height - 10 && r.bottom <= phys11.height + 8;
      }, 5000);
      const snapRect11 = win32.rectOf(snapHwnd11);
      // ④ 唤出：条几何存证 → 悬停弹出该组 → Snap 窗矩形逐字不变。
      //    条几何存证按 JSON 去重（renderer/taskbar.ts notifySummonStrips）——与前一轮
      //    收栏（P6/P7）pill 几何一致时**不发新条**（49 电池 P22 前置容忍同款）：
      //    since 门等不到就回取最近一条几何做悬停落点；「条此刻在场」由弹出断言
      //    （summon:pill 热区声明是本段新鲜事实）互证。
      let stripsEv11 = await tape.wait('taskbar-summon-strips',
        (e) => Array.isArray(e.strips) && e.strips.length > 0, { since: since11, timeoutMs: 3000 });
      if (!stripsEv11) {
        stripsEv11 = tape.latest('taskbar-summon-strips',
          (e) => Array.isArray(e.strips) && e.strips.length > 0, {});
      }
      let popOk11 = false;
      let rectStable11 = false;
      let stripInfo11 = '无条几何存证';
      if (stripsEv11) {
        const strip11 = stripsEv11.strips.find((s) => s.group === 'start') || stripsEv11.strips[0];
        stripInfo11 = `${strip11.group}@x=${Math.round(strip11.x)}w=${Math.round(strip11.width)}`;
        const tbRect11 = win32.rectOf(tbHwnd);
        const pt11 = {
          x: Math.round(tbRect11.left + (strip11.x + strip11.width / 2) * phys11.scale),
          y: Math.round(tbRect11.top + (strip11.top + strip11.height / 2) * phys11.scale),
        };
        const rectBefore11 = win32.rectOf(snapHwnd11);
        win32.moveMousePhys(pt11.x, pt11.y);
        const popDeadline11 = Date.now() + 4000;
        while (Date.now() < popDeadline11) {
          const evs = tape.all('hotzones',
            (e) => Array.isArray(e.rects) && e.rects.some((r) => String(r.id || '').startsWith('summon:pill:')),
            { since: since11 });
          if (evs.length) { popOk11 = true; break; }
          await sleep(50);
        }
        const rectAfter11 = win32.rectOf(snapHwnd11);
        rectStable11 = !!(rectBefore11 && rectAfter11 && rectAfter11.left === rectBefore11.left
          && rectAfter11.top === rectBefore11.top && rectAfter11.right === rectBefore11.right
          && rectAfter11.bottom === rectBefore11.bottom);
        // 光标回中性点（越过 400ms 宽限再解除——弹出组收干净，不与下一拍断言互踩）
        win32.moveMousePhys(Math.round(phys11.width / 2), Math.round(phys11.height / 4));
        await sleep(700);
      }
      // ⑤ 解除恢复：Win+Down → 真 Snap 消失 + 会话结束 + 占位/置位双复原
      const tUnsnap11 = Date.now();
      const unsnapped11 = await chordUntil(snapHwnd11, VK_DOWN, false);
      forceForeground(hwndOf(neutralWin));
      const sessionEnd11 = await tape.wait('taskbar-snap-session',
        (e) => e.active === false, { since: tUnsnap11, timeoutMs: 6000 });
      const liftedEv11 = await tape.wait('taskbar-retract-lifted',
        (e) => e.appBar === 'registered', { since: tUnsnap11, timeoutMs: 6000 });
      const restoreMs11 = await waitMs(() => {
        const wa = workArea();
        return wa && Math.abs(wa.bottom - expectBottom11) <= 2;
      }, 5000);
      const waRestored11 = workArea();
      // ⑥ 伪分屏阴性：同款半屏几何（SetWindowPos，非 Snap）→ 3+ 拍零收栏/零会话、工作区不动
      const fakeAt11 = Date.now();
      win32.SetWindowPos(snapHwnd11, 0, 0, 0, Math.round(phys11.width / 2), expectBottom11, 0x0004 /* SWP_NOZORDER */);
      await sleep(900); // 3+ 个 250ms 轮询拍
      const retractAfterFake11 = tape.all('taskbar-retract', undefined, { since: fakeAt11 });
      const sessionAfterFake11 = tape.all('taskbar-snap-session', (e) => e.active === true, { since: fakeAt11 });
      const waFake11 = workArea();
      const fakeRect11 = win32.rectOf(snapHwnd11);
      const negativeOk11 = retractAfterFake11.length === 0 && sessionAfterFake11.length === 0
        && !!waFake11 && Math.abs(waFake11.bottom - expectBottom11) <= 2;
      const arrangedFake11 = Boolean(IsWindowArrangedFn(snapHwnd11));
      if (sessionEv11 && retractEv11 && waMs11 >= 0 && edgeMs11 >= 0 && popOk11 && rectStable11
        && unsnapped11 && sessionEnd11 && liftedEv11 && restoreMs11 >= 0 && negativeOk11 && !arrangedFake11) {
        rep.pass(`P11 分屏收栏单窗闭环：Win+Left 真 Snap（IsWindowArranged 直读互证）→ 会话存证在流 + 收栏（taskbar-retract appBar=removed）`
          + `→ 工作区底边 ${waRetract11.bottom}/${phys11.height} = 屏底（±2，${waMs11}ms 到位；前台=中性 holder，后台事实成立）；`
          + `Snap 窗上下贴边 [${snapRect11.top},${snapRect11.bottom}]（自动重排，#${268} 定谳零改窗）；`
          + `唤出条 ${stripInfo11} 悬停弹出（summon:pill 热区声明在流）且 Snap 窗矩形逐字不变；`
          + `Win+Down 解除 → 会话结束存证 + taskbar-retract-lifted appBar=registered → 工作区回一栏高 ${waRestored11.bottom}（${restoreMs11}ms 收敛）；`
          + `伪分屏阴性：同款半屏几何（arranged=${arrangedFake11}）3+ 拍零收栏/零会话存证、工作区 ${waFake11.bottom} 不动（矩形不是身份）`);
      } else {
        rep.fail(`P11 会话存证=${!!sessionEv11} 收栏存证=${!!retractEv11} 工作区到屏底=${waMs11}ms（${waRetract11 && waRetract11.bottom}/${phys11.height}） `
          + `贴边=${edgeMs11}ms（矩形=${JSON.stringify(snapRect11)}） 唤出弹出=${popOk11} 尺寸不变=${rectStable11}（条=${stripInfo11}） `
          + `解除=${unsnapped11} 会话结束存证=${!!sessionEnd11} 恢复存证=${!!liftedEv11} 工作区复原=${restoreMs11}ms（${waRestored11 && waRestored11.bottom}/${expectBottom11}） `
          + `伪分屏阴性=${negativeOk11}（几何=${JSON.stringify(fakeRect11)} arranged=${arrangedFake11} 收栏存证=${retractAfterFake11.length} 会话存证=${sessionAfterFake11.length} 工作区=${waFake11 && waFake11.bottom}）`);
      }
    }
    }
    // P11 收尾：Win+Down 已解除；参照窗由 FormClosed/Exit 退出，进程兜底强杀在 finally
    if (snapHwnd11) win32.PostMessageW(snapHwnd11, WM_CLOSE, 0, 0);

    // —— P12/P13 公共器具（工单270）——
    const phys12 = primaryPhys();
    const expectBottom12 = phys12.height - Math.round(TASKBAR_HEIGHT_DIP * phys12.scale);
    const wsBottomOk12 = () => { const wa = workArea(); return !!wa && Math.abs(wa.bottom - phys12.height) <= 2; };
    const wsBarOk12 = () => { const wa = workArea(); return !!wa && Math.abs(wa.bottom - expectBottom12) <= 2; };
    /** 全屏上下贴边判据（DWM 7px 不可见边容差，P11/P6 同口径） */
    const edgesFullOk = (r) => !!r && r.top >= -10 && r.top <= 8 && r.bottom >= phys12.height - 10 && r.bottom <= phys12.height + 8;
    const sameRect12 = (a, b) => !!a && !!b && a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
    // Snap 参照窗宿主（P11 同款：powershell WinForms 普通顶层窗——exe 不同于面板/电池，
    // 不被 shouldShowOnTaskbar 自家排除；FormClosed 即进程退出，finally 兜底强杀）
    const spawnSnapPs = async (title) => {
      const psScript = [
        'Add-Type -AssemblyName System.Windows.Forms',
        "$f = New-Object System.Windows.Forms.Form",
        `$f.Text = '${title}'`,
        '$f.Width = 900; $f.Height = 700',
        '$f.Add_FormClosed({ [Environment]::Exit(0) })',
        '[System.Windows.Forms.Application]::Run($f)',
      ].join('; ');
      const proc = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', psScript], { stdio: 'ignore' });
      extProcs.push(proc);
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (proc.exitCode !== null) return { proc, hwnd: 0 };
        const h = win32.findWindowByPid(proc.pid);
        if (h) return { proc, hwnd: h };
        await sleep(120);
      }
      return { proc, hwnd: 0 };
    };
    // 多修饰键和弦（Ctrl+Win+D / Ctrl+Win+Left / Ctrl+Win+F4——虚拟桌面操作是全局的，
    // 不需要目标窗前台）
    const VK_CONTROL = 0x11, VK_UP = 0x26, VK_RIGHT = 0x27;
    const chordMods = (mods, vk) => {
      for (const m of mods) win32.send([win32.keyInput(m, win32.KEYDOWN)]);
      win32.send([win32.keyInput(vk, win32.KEYDOWN)]);
      win32.send([win32.keyInput(vk, win32.KEYUP)]);
      for (let i = mods.length - 1; i >= 0; i--) win32.send([win32.keyInput(mods[i], win32.KEYUP)]);
    };
    // 目标宽度自适应 Snap（工单270 三分之一/三分之二布局）：Win+Z 打开 Snap Layouts
    // 浮出 → 数字键选布局 → 数字键选分区（微软文档键盘通道）。布局编号随版本排列
    // 不同——候选组合逐试，IsWindowArranged+实测宽度命中即停（有界，不赌编号次序）
    const snapZoneByWidth = async (hwnd, targetW, tol, candidates) => {
      for (const [lk, zk] of candidates) {
        forceForeground(hwnd);
        await sleep(150);
        if (Number(win32.GetForegroundWindow()) !== hwnd) continue;
        chord11(0x5a /* Z：Win+Z 打开布局浮出 */);
        await sleep(700);
        win32.send([win32.keyInput(lk, win32.KEYDOWN)]);
        win32.send([win32.keyInput(lk, win32.KEYUP)]);
        await sleep(350);
        win32.send([win32.keyInput(zk, win32.KEYDOWN)]);
        win32.send([win32.keyInput(zk, win32.KEYUP)]);
        await sleep(600);
        if (!Boolean(IsWindowArrangedFn(hwnd))) continue;
        const r = win32.rectOf(hwnd);
        if (r && Math.abs((r.right - r.left) - targetW) <= tol) return true;
      }
      return false;
    };

    // —— P12：分屏会话集合生命周期与代表性布局（工单270 新增）——
    // 断言面（票面验收判据的真机观测）：
    //   ① 左右双窗统一判定：两窗各 Win+Left/Right → 会话+收栏+工作区屏底+两窗上下贴边；
    //   ② 普通前台切换不打断：中性 holder/Snap 窗轮换前台 1.3s（5+ 拍）零会话结束、零
    //      retract-lifted、工作区保持屏底、两 Snap 窗矩形逐字不变（不反复变化）；
    //   ③ 解除集合生命周期（在**新近 Snap** 的窗上——Win+Down 对自最小化恢复回来的
    //      Snap 窗有最小化歧义，R1 实测）：解除其一 → 会话由剩余成员维持；解除最后一
    //      个 → 会话结束（cause=unsnapped 可区分存证）+ 复原；
    //   ④⑤ 最小化集合生命周期：重 Snap 后最小化其一 → 会话维持（a1 矩形不变）；最小化
    //      其一（剩余维持拍）→ 最后一个最小化 → 会话结束（cause=minimized）+ 复原；
    //   ⑥ 恢复最后一个 → 按当前事实重建会话；
    //   ⑦ 三分之一加三分之二：Win+Z 布局浮出数字键通道定位 1/3 宽 + 互补 2/3 →
    //      同一判定进分屏收栏贴边。
    rep.beginSegment('P12');
    await waitMs(wsBarOk12, 5000); // 出发态回常驻（P11 收尾已复原，此处等占位生效档落定）
    const r12 = {
      dual: false, fgStable: false, minOne: false, minLast: false, rebuild: false, unsnapEnd: false, thirds: false,
    };
    const diag12 = [];
    const a1 = await spawnSnapPs('DECK-ACCEPT-SNAP-A1');
    const a2 = await spawnSnapPs('DECK-ACCEPT-SNAP-A2');
    if (!a1.hwnd || !a2.hwnd) {
      rep.fail(`P12 Snap 参照窗未出现（a1=${!!a1.hwnd} a2=${!!a2.hwnd}——powershell WinForms 宿主 10s 内无可见顶层窗，环境异常）`);
    } else {
    // ① 左右双窗
    const sinceDual = Date.now();
    const dualChord = await chordUntil(a1.hwnd, VK_LEFT, true) && await chordUntil(a2.hwnd, VK_RIGHT, true);
    forceForeground(hwndOf(neutralWin));
    if (!dualChord) diag12.push('和弦建 Snap 失败');
    const sessEv12 = await tape.wait('taskbar-snap-session', (e) => e.active === true, { since: sinceDual, timeoutMs: 6000 });
    const retractEv12 = await tape.wait('taskbar-retract',
      (e) => e.mode === 'maximize-retract' && e.appBar === 'removed', { since: sinceDual, timeoutMs: 6000 });
    const waDual12 = await waitMs(wsBottomOk12, 5000);
    const rects12 = [a1.hwnd, a2.hwnd].map((h) => win32.rectOf(h));
    const dualEdges = rects12.every(edgesFullOk);
    r12.dual = !!(dualChord && sessEv12 && retractEv12) && waDual12 >= 0 && dualEdges;
    if (!r12.dual) diag12.push(`双窗=${r12.dual}（和弦=${dualChord} 会话=${!!sessEv12} 收栏=${!!retractEv12} 屏底=${waDual12}ms 贴边=${dualEdges} ${JSON.stringify(rects12)}）`);
    // ② 普通前台切换不打断（后台 Snap 窗与工作区不反复变化）
    const sinceFg12 = Date.now();
    forceForeground(hwndOf(neutralWin));
    await sleep(400);
    forceForeground(a2.hwnd); // Snap 窗自己成前台（普通前台切换的另一形态）
    await sleep(400);
    forceForeground(hwndOf(neutralWin));
    await sleep(1300); // 5+ 个 250ms 轮询拍
    const noLift12 = tape.all('taskbar-retract-lifted', undefined, { since: sinceFg12 }).length === 0;
    const noEnd12 = tape.all('taskbar-snap-session', (e) => e.active === false, { since: sinceFg12 }).length === 0;
    const rectsAfterFg = [a1.hwnd, a2.hwnd].map((h) => win32.rectOf(h));
    const rectStable12 = rectsAfterFg.every((r, i) => sameRect12(r, rects12[i]));
    r12.fgStable = noLift12 && noEnd12 && wsBottomOk12() && rectStable12;
    if (!r12.fgStable) diag12.push(`前台稳定=${r12.fgStable}（零lift=${noLift12} 零结束=${noEnd12} 屏底=${wsBottomOk12()} 矩形不变=${rectStable12}）`);
    // ③ 最后解除（在**新近 Snap** 的窗上做——Win+Down 对「自最小化恢复回来的 Snap 窗」
    //    语义有最小化歧义（R1 实测），本相先用两枚新 Snap 窗验解除因果，再重 Snap 验最小化）：
    //    解除其一（a2）→ 会话由 a1 维持；解除最后一个（a1）→ 结束（cause=unsnapped）+ 复原
    const tUnsnapA = Date.now();
    const unsnapOneOk = await chordUntil(a2.hwnd, VK_DOWN, false);
    await sleep(1200);
    const unsnapOneHeld = tape.all('taskbar-snap-session', (e) => e.active === false, { since: tUnsnapA }).length === 0
      && tape.all('taskbar-retract-lifted', undefined, { since: tUnsnapA }).length === 0 && wsBottomOk12();
    const unsnapLastOk = await chordUntil(a1.hwnd, VK_DOWN, false);
    forceForeground(hwndOf(neutralWin));
    const unEndEv12 = await tape.wait('taskbar-snap-session',
      (e) => e.active === false && e.cause === 'unsnapped', { since: tUnsnapA, timeoutMs: 6000 });
    const unLiftEv12 = await tape.wait('taskbar-retract-lifted',
      (e) => e.appBar === 'registered', { since: tUnsnapA, timeoutMs: 6000 });
    const unWa12 = await waitMs(wsBarOk12, 5000);
    r12.unsnapEnd = !!(unsnapOneOk && unsnapOneHeld && unsnapLastOk && unEndEv12 && unLiftEv12) && unWa12 >= 0;
    if (!r12.unsnapEnd) diag12.push(`解除结束=${r12.unsnapEnd}（其一解除=${unsnapOneOk} 其一维持=${unsnapOneHeld} 最后解除=${unsnapLastOk} 结束存证=${!!unEndEv12} lift=${!!unLiftEv12} 复原=${unWa12}ms）`);
    // ④ 重 Snap 双窗（最小化集合生命周期相位从新鲜 Snap 出发）
    const tResnap = Date.now();
    const resnapOk = await chordUntil(a1.hwnd, VK_LEFT, true) && await chordUntil(a2.hwnd, VK_RIGHT, true);
    forceForeground(hwndOf(neutralWin));
    const resnapWa = await waitMs(wsBottomOk12, 5000);
    if (!resnapOk || resnapWa < 0) diag12.push(`重Snap=${resnapOk} 屏底=${resnapWa}ms`);
    // ⑤ 最小化其一（a2）→ 会话由 a1 维持
    const tMin1 = Date.now();
    win32.ShowWindow(a2.hwnd, 6 /* SW_MINIMIZE */);
    const iconicA2 = await waitMs(() => win32.IsIconic(a2.hwnd), 3000);
    await sleep(1300);
    const minOneNoEnd = tape.all('taskbar-snap-session', (e) => e.active === false, { since: tMin1 }).length === 0;
    const minOneNoLift = tape.all('taskbar-retract-lifted', undefined, { since: tMin1 }).length === 0;
    const a1RectAfterMin = win32.rectOf(a1.hwnd);
    r12.minOne = iconicA2 >= 0 && minOneNoEnd && minOneNoLift && wsBottomOk12() && sameRect12(a1RectAfterMin, rects12[0]);
    if (!r12.minOne) diag12.push(`最小化其一=${r12.minOne}（iconic=${iconicA2 >= 0} 零结束=${minOneNoEnd} 零lift=${minOneNoLift} 屏底=${wsBottomOk12()} a1矩形不变=${sameRect12(a1RectAfterMin, rects12[0])}）`);
    // 恢复 a2（会话持续，不打断）
    win32.ShowWindow(a2.hwnd, 9 /* SW_RESTORE */);
    await sleep(800);
    // ⑥ 最小化最后一个：先 a1（a2 维持拍）→ 再 a2（结束拍，cause=minimized）
    const tMin2 = Date.now();
    win32.ShowWindow(a1.hwnd, 6);
    await waitMs(() => win32.IsIconic(a1.hwnd), 3000);
    await sleep(1200);
    const heldA2 = tape.all('taskbar-snap-session', (e) => e.active === false, { since: tMin2 }).length === 0 && wsBottomOk12();
    win32.ShowWindow(a2.hwnd, 6);
    await waitMs(() => win32.IsIconic(a2.hwnd), 3000);
    const minEndEv12 = await tape.wait('taskbar-snap-session',
      (e) => e.active === false && e.cause === 'minimized', { since: tMin2, timeoutMs: 6000 });
    const minLiftEv12 = await tape.wait('taskbar-retract-lifted',
      (e) => e.appBar === 'registered', { since: tMin2, timeoutMs: 6000 });
    const minWa12 = await waitMs(wsBarOk12, 5000);
    r12.minLast = heldA2 && !!minEndEv12 && !!minLiftEv12 && minWa12 >= 0;
    if (!r12.minLast) diag12.push(`最后最小化=${r12.minLast}（a2维持=${heldA2} 结束存证=${!!minEndEv12} lift=${!!minLiftEv12} 复原=${minWa12}ms）`);
    // ⑦ 恢复最后一个（a1）→ 按当前事实重建会话
    const tRebuild = Date.now();
    win32.ShowWindow(a1.hwnd, 9);
    const rebuildEv12 = await tape.wait('taskbar-snap-session',
      (e) => e.active === true, { since: tRebuild, timeoutMs: 6000 });
    const rebuildWa12 = await waitMs(wsBottomOk12, 5000);
    r12.rebuild = !!rebuildEv12 && rebuildWa12 >= 0;
    if (!r12.rebuild) diag12.push(`重建=${r12.rebuild}（存证=${!!rebuildEv12} 屏底=${rebuildWa12}ms）`);
    // A 相收尾：a1 恢复后仍是成员、a2 最小化非成员——关掉两宿主（会话随 a1 关闭结束，
    // 落一条 cause=closed 事件在 B 相 since 门之前，不与 B 相断言互踩）
    win32.PostMessageW(a1.hwnd, WM_CLOSE, 0, 0);
    win32.PostMessageW(a2.hwnd, WM_CLOSE, 0, 0);
    await sleep(500);
    // ⑧ 三分之一加三分之二（统一真 Snap 判定，无布局专用分支）：Win+Z 布局浮出的
    //    数字键通道（微软文档）自适应定位 1/3 宽；互补 2/3 先试 Win+Right 补位、
    //    不中再走 Win+Z 分区
    const b1 = await spawnSnapPs('DECK-ACCEPT-SNAP-B1');
    const b2 = await spawnSnapPs('DECK-ACCEPT-SNAP-B2');
    const thirdW = phys12.width / 3;
    const tolW = phys12.width * 0.05;
    // 数字键 VK：'1'..'6' = 0x31..0x36；布局编号随版本排列不同——候选组合逐试
    const NUM = (n) => 0x30 + n;
    let thirdsDetail = '';
    if (!b1.hwnd || !b2.hwnd) {
      diag12.push(`1/3 参照窗未出现（b1=${!!b1.hwnd} b2=${!!b2.hwnd}——环境异常）`);
    } else {
      const sinceB = Date.now();
      const b1Ok = await snapZoneByWidth(b1.hwnd, thirdW, tolW, [
        [NUM(2), NUM(1)], [NUM(3), NUM(1)], [NUM(4), NUM(1)], [NUM(5), NUM(1)], [NUM(6), NUM(1)],
        [NUM(2), NUM(3)], [NUM(3), NUM(3)], [NUM(6), NUM(3)],
      ]);
      // b2 互补 2/3：先 Win+Right（另一侧被占时的补位），不中再走 Win+Z 分区
      let b2Ok = false;
      if (b1Ok) {
        b2Ok = await chordUntil(b2.hwnd, VK_RIGHT, true);
        const r = win32.rectOf(b2.hwnd);
        if (!(r && Math.abs((r.right - r.left) - 2 * thirdW) <= tolW)) b2Ok = false;
      }
      if (b1Ok && !b2Ok) {
        b2Ok = await snapZoneByWidth(b2.hwnd, 2 * thirdW, tolW, [
          [NUM(2), NUM(2)], [NUM(3), NUM(2)], [NUM(4), NUM(2)], [NUM(5), NUM(2)], [NUM(6), NUM(2)],
        ]);
      }
      forceForeground(hwndOf(neutralWin));
      const bSess12 = await tape.wait('taskbar-snap-session', (e) => e.active === true, { since: sinceB, timeoutMs: 6000 });
      const bWa12 = await waitMs(wsBottomOk12, 5000);
      const b1r = win32.rectOf(b1.hwnd);
      const b2r = win32.rectOf(b2.hwnd);
      const widthsOk = !!b1r && !!b2r
        && Math.abs((b1r.right - b1r.left) - thirdW) <= tolW
        && Math.abs((b2r.right - b2r.left) - 2 * thirdW) <= tolW;
      const bEdges = [b1r, b2r].every(edgesFullOk);
      r12.thirds = !!(b1Ok && b2Ok && bSess12) && bWa12 >= 0 && widthsOk && bEdges;
      thirdsDetail = `1/3定位=${b1Ok} 2/3互补=${b2Ok} 会话=${!!bSess12} 屏底=${bWa12}ms `
        + `宽=${b1r ? Math.round(b1r.right - b1r.left) : '?'}/${b2r ? Math.round(b2r.right - b2r.left) : '?'}/3=${Math.round(thirdW)} 贴边=${bEdges}`;
      if (!r12.thirds) diag12.push(`1/3+2/3=${r12.thirds}（${thirdsDetail}）`);
      // B 相收尾：关宿主（会话随之结束、工作区复原——留给 P13 从常驻出发）
      win32.PostMessageW(b1.hwnd, WM_CLOSE, 0, 0);
      win32.PostMessageW(b2.hwnd, WM_CLOSE, 0, 0);
      await waitMs(wsBarOk12, 5000);
    }
    if (r12.dual && r12.fgStable && r12.minOne && r12.minLast && r12.rebuild && r12.unsnapEnd && r12.thirds) {
      rep.pass(`P12 分屏会话集合生命周期与代表性布局：左右双窗统一进分屏收栏（会话+注销收栏存证在流、工作区屏底、两窗上下贴边）；`
        + `普通前台轮换 5+ 拍零会话结束/零复原、Snap 窗矩形逐字不变；`
        + `解除其一仍维持、最后一个解除结束（cause=unsnapped）→ 复原；重 Snap 后最小化其一仍维持（a1 矩形不变）、`
        + `最后一个最小化结束（cause=minimized）→ 复原；恢复即按当前事实重建；`
        + `1/3+2/3 布局经同一判定收栏贴边（${thirdsDetail}）`);
    } else {
      rep.fail(`P12 集合生命周期/布局未全绿：${JSON.stringify(r12)}；${diag12.join('；')}`);
    }
    }

    // —— P13：虚拟桌面切换隔离与收栏理由接续（工单270 新增）——
    // 断言面：
    //   ① 四角布局统一判定（4 窗 Win+Left/Right × Win+Up/Down）→ 会话+收栏+四象限贴边；
    //   ② 桌面切换隔离：Win+Ctrl+D 建新桌面并切过去 → 会话结束（cause=desktop-switched
    //      可区分存证）+ 工作区复原（其他虚拟桌面的 cloaked Snap 窗不影响当前工作区）；
    //      Ctrl+Win+Left 回原桌面 → 按该桌面实际布局重建会话（工作区回屏底）；
    //      桌面清理：回新桌面 Win+Ctrl+F4 关掉，回原桌面（不留残留桌面）；
    //   ③ 收栏理由接续：真最大化前台 + 会话 → 逐窗关闭（前三窗关闭维持）→ 最后一窗关闭
    //      → 会话结束（cause=closed + retractHeldByZoomed=true、无 retract-lifted、工作区
    //      保持屏底——不先恢复再收栏）；解除最大化 → 最后理由消失，单次复原。
    rep.beginSegment('P13');
    await waitMs(wsBarOk12, 5000);
    const r13 = { corners: false, dkEnd: false, dkBack: false, reasonHeld: false, reasonLift: false };
    const diag13 = [];
    const cornerTitles = ['DECK-ACCEPT-SNAP-C1', 'DECK-ACCEPT-SNAP-C2', 'DECK-ACCEPT-SNAP-C3', 'DECK-ACCEPT-SNAP-C4'];
    const cornerProcs = cornerTitles.map((t) => spawnSnapPs(t)); // 并发起进程，逐个等句柄
    const cw = [];
    for (const p of cornerProcs) cw.push(await p);
    const hw = cw.map((x) => x.hwnd);
    if (hw.some((h) => !h)) {
      rep.fail(`P13 四角参照窗未出现（${hw.map((h) => !!h).join(',')}——环境异常）`);
    } else {
    // ① 四角：Left/Right 定列 + Up/Down 定行
    const sinceC = Date.now();
    const chords13 = [
      [VK_LEFT, VK_UP], [VK_RIGHT, VK_UP], [VK_LEFT, VK_DOWN], [VK_RIGHT, VK_DOWN],
    ];
    let cornerChordOk = true;
    for (let i = 0; i < 4; i++) {
      const ok = await chordUntil(hw[i], chords13[i][0], true) && await chordUntil(hw[i], chords13[i][1], true);
      if (!ok) cornerChordOk = false;
    }
    forceForeground(hwndOf(neutralWin));
    const cSess13 = await tape.wait('taskbar-snap-session', (e) => e.active === true, { since: sinceC, timeoutMs: 6000 });
    const cWa13 = await waitMs(wsBottomOk12, 5000);
    const cr = hw.map((h) => win32.rectOf(h));
    const W13 = phys12.width, H13 = phys12.height, MID = 14;
    const quadOk = cr.every((r) => !!r)
      && cr[0].left >= -10 && cr[0].left <= 8 && Math.abs(cr[0].right - W13 / 2) <= MID && cr[0].top >= -10 && cr[0].top <= 8 && Math.abs(cr[0].bottom - H13 / 2) <= MID
      && Math.abs(cr[1].left - W13 / 2) <= MID && cr[1].right >= W13 - 8 && cr[1].right <= W13 + 10 && cr[1].top >= -10 && cr[1].top <= 8 && Math.abs(cr[1].bottom - H13 / 2) <= MID
      && cr[2].left >= -10 && cr[2].left <= 8 && Math.abs(cr[2].right - W13 / 2) <= MID && Math.abs(cr[2].top - H13 / 2) <= MID && cr[2].bottom >= H13 - 10 && cr[2].bottom <= H13 + 8
      && Math.abs(cr[3].left - W13 / 2) <= MID && cr[3].right >= W13 - 8 && cr[3].right <= W13 + 10 && Math.abs(cr[3].top - H13 / 2) <= MID && cr[3].bottom >= H13 - 10 && cr[3].bottom <= H13 + 8;
    r13.corners = cornerChordOk && !!cSess13 && cWa13 >= 0 && quadOk;
    if (!r13.corners) diag13.push(`四角=${r13.corners}（和弦=${cornerChordOk} 会话=${!!cSess13} 屏底=${cWa13}ms 象限=${quadOk} ${JSON.stringify(cr)}）`);
    // ② 桌面切换隔离 + 重建 + 清理（只在四角建起后做——四角窗是「原桌面布局」的标记）
    if (r13.corners) {
      const tDk = Date.now();
      chordMods([VK_LWIN, VK_CONTROL], 0x44 /* D：建新桌面并切过去 */);
      const dkEndEv13 = await tape.wait('taskbar-snap-session',
        (e) => e.active === false && e.cause === 'desktop-switched', { since: tDk, timeoutMs: 8000 });
      const dkWa13 = await waitMs(wsBarOk12, 6000);
      r13.dkEnd = !!dkEndEv13 && dkWa13 >= 0;
      if (!r13.dkEnd) diag13.push(`桌面结束=${r13.dkEnd}（存证=${!!dkEndEv13} 复原=${dkWa13}ms）`);
      // 回原桌面：Ctrl+Win+Left 循环直到四角窗 C1 非 cloak（标记窗可见=回到原桌面）
      let backPresses = 0;
      let atHome = false;
      for (let i = 0; i < 12; i++) {
        chordMods([VK_LWIN, VK_CONTROL], VK_LEFT);
        backPresses += 1;
        await sleep(600);
        if (!win32.isCloaked(hw[0])) { atHome = true; break; }
      }
      const dkReWa13 = atHome ? await waitMs(wsBottomOk12, 6000) : -1;
      const lastSess13 = atHome ? tape.latest('taskbar-snap-session', () => true, {}) : null;
      r13.dkBack = atHome && dkReWa13 >= 0 && !!(lastSess13 && lastSess13.active === true);
      if (!r13.dkBack) diag13.push(`回桌重建=${r13.dkBack}（到家=${atHome} 按数=${backPresses} 屏底=${dkReWa13}ms 末次会话存证=${lastSess13 ? lastSess13.active : '无'}）`);
      // 桌面清理：Right×backPresses 回我们建的新桌面（C1 又 cloak）→ Win+Ctrl+F4 关掉 → 回原桌面
      try {
        if (atHome) {
          for (let i = 0; i < backPresses; i++) {
            chordMods([VK_LWIN, VK_CONTROL], VK_RIGHT);
            await sleep(500);
          }
          if (win32.isCloaked(hw[0])) {
            chordMods([VK_LWIN, VK_CONTROL], 0x73 /* F4：关闭当前（我们建的空）桌面 */);
            await sleep(700);
          }
          for (let i = 0; i < 12 && win32.isCloaked(hw[0]); i++) {
            chordMods([VK_LWIN, VK_CONTROL], VK_LEFT);
            await sleep(600);
          }
        }
      } catch { /* 清理尽力而为——残留空桌面不构成断言面 */ }
    }
    // ③ 收栏理由接续：真最大化前台在场时结束会话——收栏由 zoomed 接续（不先恢复再收栏）
    if (r13.corners) {
      const maxWin13 = new BrowserWindow({ width: 900, height: 600, title: 'DECK-ACCEPT-MAX-13', backgroundColor: '#101010' });
      refWins.push(maxWin13);
      await maxWin13.loadURL('about:blank');
      maxWin13.maximize();
      forceForeground(hwndOf(maxWin13));
      const fg13 = await waitMs(() => Number(win32.GetForegroundWindow()) === hwndOf(maxWin13), 4000);
      await sleep(1000); // 等轮询拍吃进「zoomed+会话并存」（同档零迁移）
      const tClose13 = Date.now();
      // 前三窗逐个关闭：会话由剩余成员维持（工作区保持屏底）
      for (const h of [hw[0], hw[1], hw[2]]) {
        win32.PostMessageW(h, WM_CLOSE, 0, 0);
        await sleep(900);
      }
      const midHeld13 = wsBottomOk12();
      // 最后一窗关闭：会话结束（cause=closed）+ retractHeldByZoomed（zoomed 接续持有收栏档）
      win32.PostMessageW(hw[3], WM_CLOSE, 0, 0);
      const endEv13 = await tape.wait('taskbar-snap-session',
        (e) => e.active === false && e.cause === 'closed' && e.retractHeldByZoomed === true, { since: tClose13, timeoutMs: 6000 });
      const noLift13 = tape.all('taskbar-retract-lifted', undefined, { since: tClose13 }).length === 0;
      const noRe13 = tape.all('taskbar-retract', undefined, { since: tClose13 }).length === 0;
      const wsHeld13 = wsBottomOk12();
      r13.reasonHeld = fg13 >= 0 && midHeld13 && !!endEv13 && noLift13 && noRe13 && wsHeld13;
      if (!r13.reasonHeld) diag13.push(`理由接续持有=${r13.reasonHeld}（前台=${fg13 >= 0} 三关后屏底=${midHeld13} 结束存证=${!!endEv13} 零lift=${noLift13} 零re-收栏=${noRe13} 屏底保持=${wsHeld13}）`);
      // 解除最大化 → 最后理由消失 → 单次复原
      const tUnmax13 = Date.now();
      maxWin13.unmaximize();
      const liftEv13 = await tape.wait('taskbar-retract-lifted',
        (e) => e.appBar === 'registered', { since: tUnmax13, timeoutMs: 6000 });
      const liftWa13 = await waitMs(wsBarOk12, 5000);
      r13.reasonLift = !!liftEv13 && liftWa13 >= 0;
      if (!r13.reasonLift) diag13.push(`最后复原=${r13.reasonLift}（lift存证=${!!liftEv13} 复原=${liftWa13}ms）`);
      maxWin13.destroy();
    }
    if (r13.corners && r13.dkEnd && r13.dkBack && r13.reasonHeld && r13.reasonLift) {
      rep.pass(`P13 虚拟桌面切换隔离与收栏理由接续：四角布局统一进分屏收栏（四象限贴边、工作区屏底）；`
        + `Win+Ctrl+D 切新桌面 → 会话结束（cause=desktop-switched）+ 工作区复原；Ctrl+Win+Left 回原桌面 → 按该桌面布局重建（工作区回屏底）；桌面已清理；`
        + `真最大化前台期间逐窗关闭 → 会话结束（cause=closed + retractHeldByZoomed=true）且零 retract-lifted、工作区保持屏底（不先恢复再收栏）；`
        + `解除最大化 → 最后理由消失单次复原`);
    } else {
      rep.fail(`P13 桌面隔离/理由接续未全绿：${JSON.stringify(r13)}；${diag13.join('；')}`);
    }
    // P13 收尾：四角宿主已关（理由接续相位）；进程兜底强杀在 finally
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

    // —— P10：收栏态原生栏重申轮询（工单262 新增）：explorer 重启 → 看门狗重挂 ——
    // 段位在 P9 之后：explorer 重启会把 appbar 状态按注册表原态复活，起跑基线自此断裂
    // （R1 实测教训：本段曾插在 P5 前，P5/P9 的基线比对全被打断）——重启段必须垫底，
    // P5/P9 的基线断言跑在原 explorer 上。
    // 三拍断言（票面验收标准 1/2/3 各一拍；裁决逻辑在 native-watch.ts 纯机器单测钉住，
    // 本段只验 FFI 效果面——真机行为存证，章法增段三条件之 1/2）：
    //   拍 A 可见性翻转压回（标准 2）：SW_SHOWNOACTIVATE 翻开原生栏显示位（不夺前台——
    //      SW_SHOW 会激活任务栏，前台被夺把收栏档合法翻掉、看门狗停表，R1 实测教训）
    //      → reason=visible 重申 + 压回不可见（1s 轮询拍 + 容差）；
    //   拍 B explorer 重启重挂（标准 1）：Stop-Process explorer（AutoRestartShell 归位，
    //      10s 未归自起 explorer.exe 兜底）→ 新 Shell_TrayWnd → reason=rebuild 重申 +
    //      重挂。⚠️ R1 实测：新起 explorer 约 15s 内不接受 ABM_SETSTATE/ABM_NEW（看门狗
    //      逐拍重试全部落 failed，过了接受窗一发即中）——隐藏按「及时」断言（≤4s，重挂的
    //      隐藏动作只走 user32 不等 shell），置位按「终态」断言（≤25s 内 AUTOHIDE 位在场
    //      + 工作区回屏底；轮询拍 1s 属设计参数，由单测钉在 1–2s 档）；
    //   拍 C 非收栏态休止（标准 3）：解除最大化退收栏后翻开原生栏 → 2.6s（2+ 轮询拍）
    //      零重申存证且原生栏保持可见（休止 = 不轮询，控制器不代压）。
    rep.beginSegment('P10');
    // 重拉面板（P9 已关）：前台先钉中性 holder（boot 期不进收栏），就绪后交给最大化
    // 参照窗（P9 尾它仍最大化——直接夺前台即进收栏，不走最大化动画的空前台拍）。
    forceForeground(hwndOf(neutralWin));
    handle.launch({ mode: 'accept', stdio: 'ignore' });
    const boot10 = await tape.wait('boot', null, { timeoutMs: 20000 });
    if (!boot10) throw new Error('P10 面板未上报 boot');
    panelPid = boot10.pid;
    if (!(await handle.waitWindow({ title: TASKBAR_TITLE, timeoutMs: 12000 }))) throw new Error('P10 条带窗未出现');
    const sinceP10 = Date.now();
    forceForeground(hwndOf(retractWin));
    const retractEv10 = await tape.wait('taskbar-retract',
      (e) => e.mode === 'maximize-retract' && e.appBar === 'removed', { since: sinceP10, timeoutMs: 6000 });
    const retractWa10 = await waitMs(() => {
      const wa = workArea();
      return wa && Math.abs(wa.bottom - phys6.height) <= 2;
    }, 5000);
    // 前台再钉 + 静置两拍（250ms 档位轮询），以工作区事实核收栏在场——最大化动画期的
    // 空前台拍会合法翻档（R1 实测：retract 后 440ms 被 null probe 翻掉），各拍出发前必核。
    forceForeground(hwndOf(retractWin));
    await sleep(600);
    const waPreA = workArea();
    if (!retractEv10 || retractWa10 < 0 || !waPreA || Math.abs(waPreA.bottom - phys6.height) > 2) {
      rep.fail(`P10 前置失败：进收栏未成立（收栏存证=${!!retractEv10} 到屏底=${retractWa10}ms 拍前工作区=${waPreA && waPreA.bottom}/${phys6.height}）`);
    } else {
      // —— 拍 A：可见性翻转压回 ——
      const hwndA = win32.nativeTrayHwnd();
      if (!hwndA) {
        rep.fail('P10a 出发态异常：收栏态下找不到 explorer 的 Shell_TrayWnd');
      } else {
        const tA = Date.now();
        win32.ShowWindow(hwndA, 4 /* SW_SHOWNOACTIVATE：翻开显示位不夺前台 */);
        const reassertA = await tape.wait('taskbar-native-reassert',
          (e) => e.reason === 'visible', { since: tA, timeoutMs: 4000 });
        const hiddenA = await waitMs(() => !win32.nativeTaskbarVisible(), 4000);
        const latencyA = reassertA ? reassertA.t - tA : -1;
        if (reassertA && hiddenA >= 0 && latencyA <= 2500) {
          rep.pass(`P10a 可见性翻转压回：SW_SHOWNOACTIVATE 翻开后 ${latencyA}ms 重申命中（reason=visible）→ 压回不可见（${hiddenA}ms 到位）`);
        } else {
          rep.fail(`P10a 重申存证=${!!reassertA}（时延=${latencyA}ms） 压回不可见=${hiddenA >= 0}ms`);
        }
      }

      // —— 拍 B：explorer 重启重挂 ——
      const tKill = Date.now();
      spawnSync('powershell.exe',
        ['-NoProfile', '-Command', 'Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue'],
        { encoding: 'utf8', timeout: 15000, windowsHide: true });
      forceForeground(hwndOf(retractWin)); // 杀完即钉（前台漂移会合法翻档停表）
      const goneB = await waitMs(() => win32.nativeTrayHwnd() === 0, 8000);
      // 等 explorer 归位（AutoRestartShell 常规 1–3s；10s 未归自起兜底，20s 上限）
      let spawnedExplorer = false;
      let firstSeenAt = 0;
      let hwndAfter = 0;
      const tWaitB = Date.now();
      for (;;) {
        hwndAfter = win32.nativeTrayHwnd();
        if (hwndAfter) { firstSeenAt = Date.now(); break; }
        if (Date.now() - tWaitB > 10000 && !spawnedExplorer) {
          spawn('explorer.exe', [], { detached: true, stdio: 'ignore' }).unref();
          spawnedExplorer = true;
          rep.note('P10 AutoRestartShell 未归位，已自起 explorer.exe 兜底');
        }
        if (Date.now() - tWaitB > 20000) break;
        await sleep(150);
      }
      if (!goneB || !firstSeenAt) {
        rep.fail(`P10b explorer 重启未成立：旧窗退场=${goneB >= 0}ms 新窗归位=${firstSeenAt ? '是' : '否（20s 上限）'}（自起兜底=${spawnedExplorer}）——环境异常，本拍不可判`);
      } else {
        forceForeground(hwndOf(retractWin)); // 新 shell 起后再钉一次（重启搅动前台）
        // 重挂两动作分开断言：隐藏及时（只走 user32）；置位终态（新 explorer 有 ~15s 不接受窗）
        const reassertB = await tape.wait('taskbar-native-reassert',
          (e) => e.reason === 'rebuild', { since: tKill, timeoutMs: 9000 });
        const hideEvB = await tape.wait('taskbar-hidden', undefined, { since: tKill, timeoutMs: 9000 });
        const hideLatencyB = hideEvB ? hideEvB.t - firstSeenAt : -1;
        const hiddenB = await waitMs(() => !win32.nativeTaskbarVisible(), 4000);
        // 置位终态：逐拍重试由看门狗自转（1s 拍），此处等终态——长等期间持续钉前台
        // （前台被夺会停表断掉重试）；R1 实测接受窗 ~15s（P9 曾在新 explorer 上置位成功
        // 佐证），界 25s。
        const tStateB = Date.now();
        let stateMsB = -1;
        while (Date.now() - tStateB <= 25000) {
          if ((appbarState() & 0x1) !== 0) { stateMsB = Date.now() - tStateB; break; }
          forceForeground(hwndOf(retractWin));
          await sleep(400);
        }
        const stateB = appbarState();
        const waB = stateMsB >= 0 ? await waitMs(() => {
          const wa = workArea();
          return wa && Math.abs(wa.bottom - phys6.height) <= 2;
        }, 8000) : -1;
        if (reassertB && hideEvB && hideLatencyB >= 0 && hideLatencyB <= 4000 && hiddenB >= 0
          && stateMsB >= 0 && waB >= 0) {
          rep.pass(`P10b explorer 重启重挂：新窗 ${hwndAfter}（${firstSeenAt - tKill}ms 归位）→ ${hideLatencyB}ms 重挂隐藏（taskbar-hidden 在流，只走 user32 不等 shell）`
            + ` + reason=rebuild 重申存证在流；置位经 ${stateMsB}ms 终态到场（新 explorer 接受窗内看门狗逐拍重试）`
            + ` → 工作区底边 ${workArea().bottom}/${phys6.height} 回屏底（${waB}ms）`);
        } else {
          rep.fail(`P10b rebuild重申=${!!reassertB} 重挂隐藏=${hideEvB ? `${hideLatencyB}ms` : '缺'} 不可见=${hiddenB >= 0}ms `
            + `置位终态=${stateMsB}ms（state=${stateB}） 工作区=${waB >= 0 ? `${waB}ms` : '未到'}（现值 ${workArea() && workArea().bottom}/${phys6.height}） `
            + `新窗=${hwndAfter} 归位=${firstSeenAt - tKill}ms 自起兜底=${spawnedExplorer}`);
        }
      }

      // —— 拍 C：非收栏态休止 ——
      const tLift = Date.now();
      retractWin.unmaximize();
      forceForeground(hwndOf(neutralWin));
      const lifted10 = await tape.wait('taskbar-retract-lifted',
        (e) => e.mode === 'visible' && e.appBar === 'registered', { since: tLift, timeoutMs: 8000 });
      if (!lifted10) {
        rep.fail('P10c 前置失败：退收栏未成立（重注册失败或收栏态残留——见磁带 appBar 字段）');
      } else {
        const tC = Date.now();
        const hwndC = win32.nativeTrayHwnd();
        if (!hwndC) {
          rep.fail('P10c 出发态异常：找不到 explorer 的 Shell_TrayWnd');
        } else {
          win32.ShowWindow(hwndC, 4 /* SW_SHOWNOACTIVATE */); // 非收栏态翻开原生栏（休止 = 无人代压）
          await sleep(2600); // 2+ 轮询拍：休止若被打破，1s 拍内必有重申存证
          const reassertC = tape.all('taskbar-native-reassert', undefined, { since: tC });
          const stillVisibleC = win32.nativeTaskbarVisible();
          if (reassertC.length === 0 && stillVisibleC) {
            rep.pass('P10c 非收栏态休止：退收栏后翻开原生栏，2.6s（2+ 轮询拍）内零重申存证且保持可见'
              + '（不轮询——系统行为与现状一致，压回不代劳）');
          } else {
            rep.fail(`P10c 休止被打破：重申存证 ${reassertC.length} 条（2.6s 窗内） 原生栏保持可见=${stillVisibleC}`);
          }
        }
      }
    }
  } catch (err) {
    rep.fail(`电池异常: ${err && err.stack || err}`);
  } finally {
    // 清场（容错同 carry 电池：任何抛错都不能拦住 finish()）：关参照窗 → 杀面板 →
    // 还原分辨率 → --icon-restore 自救 → 还原 config。
    try {
      for (const w of refWins) { try { if (!w.isDestroyed()) w.destroy(); } catch { /* 尽力 */ } }
      for (const p of extProcs) { try { p.kill(); } catch { /* 尽力 */ } }
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
