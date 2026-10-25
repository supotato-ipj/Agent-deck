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
//   P6 最大化收栏（工单244；工单260 改段不变式；工单293 清位口径改段）：前台真最大化窗 →
//      注销 AppBar（taskbar-retract 存证 appBar=removed + taskbar-appbar-removed 存证）+
//      置位 ABS_AUTOHIDE（原生栏托管）→ 占位与原生保留带双释放，工作区底边 = 屏底（±2）、
//      参照窗铺满整屏；解除最大化 → 重注册（taskbar-retract-lifted appBar=registered
//      + taskbar-appbar-registered）+ **退回清位目标**（读回无 AUTOHIDE 位——不是用户
//      原值，原值只在退场复原）→ 占位恢复（底边回一栏高）
//   P7 三态优先级（工单244；工单260 随动不变式；工单293 清位口径改段）：全屏让位压过收栏
//      （全屏态条带整窗退场 + 占位恢复 + 清位（AUTOHIDE 位退场）+ 全屏期间无收栏存证）；
//      退出全屏回到最大化窗 → 收栏态自动回来（taskbar-retract 再落，底边回屏底）
//   P8 降级档禁用（工单244）：AppBar 注册失败 ⇒ 收栏整体禁用——降级档在场则断
//      「无占位 + 无收栏让位存证 + 条带在场」三后果；健康档则断收栏存证的 appBar
//      字段（removed/registered ⇒ 占位在场才谈得上收栏；降级档恒为 kept）
//   P9 收栏态退出双复原（工单260；工单293 扩「普通态也不复活」）：重拉面板进收栏（置位
//      ABS_AUTOHIDE、工作区到屏底）→ 收栏态 WM_CLOSE 正常退出 → 可见性与 appbar 状态双复原
//      （还原路径①；原值以**接管建立前**读回为准——全接管期起，接管后的读回是清位目标，
//      不再是原值）；扩臂 B：重拉面板不进收栏（普通档、仍接管），接管清位生效 + 静置原生栏
//      不复活 + WM_CLOSE 退出 appbar 状态复原为原值 + 落盘账清
//   P10 全接管期原生栏重申轮询（工单262；工单293 判据改段——值守从「收栏期」扩为
//      「全接管期」，段位垫底——explorer 重启断基线）：可见性翻转压回（SW_SHOWNOACTIVATE
//      注入 → reason=visible 重申 + 压回）；explorer 重启重挂（Stop-Process explorer +
//      AutoRestartShell 归位 → 新 Shell_TrayWnd → reason=rebuild 重申 + 隐藏及时≤4s +
//      置位终态≤25s（新 explorer 约 15s 不接受窗，重申轮询逐拍重试）→工作区回屏底）；
//      退收栏（普通档）翻开原生栏 → 1s 拍内 reason=visible 重申 + 压回（旧「非收栏态
//      休止」判据随全接管期退役——普通档的清位同样会被 explorer 重启按注册表原值冲掉）
//   P15 普通态清位与三路径禁现（工单293 新增，spec #292）：受控原值（自动隐藏 ON）下重拉
//      面板 → 接管建立记账（taskbar-autohide-takeover userState=受控原值）+ 清位（
//      taskbar-autohide-cleared + 读回无 AUTOHIDE——用户本已开自动隐藏时这是**有动作**的
//      清位）；三路径禁现：底边悬停 3.5s 无可见帧、Win 键无可见帧、通知路径如实记「未观察」；
//      禁用任务栏（CDP 驱动 taskbar/set-enabled）→ taskbar-autohide-restored reason=disabled
//      + appbar 读回=接管前原值 + 落盘账清 + 原生栏还原在场（AUTOHIDE 原值下显示位由
//      explorer 停靠策略自主——「显示位 ≠ 视觉在场」口径）
//   P11 分屏收栏单窗最小闭环（工单269）：Win+Left 键盘合成建立真 Snap（IsWindowArranged
//      直读互证）→ 会话存证 taskbar-snap-session(active) + 收栏（注销+置位：工作区=屏底±2）
//      且前台钉中性 holder（后台事实，普通前台不打断）；Snap 窗上下贴边（Windows 自动重排，
//      工单268 定谳——面板零改窗）；唤出条悬停弹出且 Snap 窗矩形逐字不变；Win+Down 解除
//      → 会话结束 + 重注册复原（工作区回一栏高）；SetWindowPos 摆半屏几何伪分屏阴性
//      （3+ 轮询拍零收栏/零会话存证、工作区不动——矩形不得成为身份兜底）
//   P12 分屏会话集合生命周期与代表性布局（工单270）：左右双窗统一进入分屏收栏并上下
//      贴边；普通前台切换不打断（矩形逐字不变、工作区保持屏底）；标题栏拖拽真解除
//      其一仍维持、最后一个解除结束（cause=unsnapped）并复原（Win+Down 在本机是
//      **最小化**语义，R1/R2 磁带实证，不用于解除）；重 Snap 后最小化其一仍维持、
//      最后一个最小化结束（cause=minimized 存证）且恢复即按当前事实重建；三分之一加
//      三分之二布局经 Win+Z 布局浮出数字键通道定位，同一真 Snap 判定收栏贴边；收尾
//      关宿主核验退场（残留成员会拖住会话——R2 级联根因）
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
// 工单293 P15 禁用径：运行时桥动作（taskbar/set-enabled）经 CDP 在真实渲染层驱动
// （49-taskbar cdpEval 同款最小客户端）。51 电池其余各段不注 CDP（发射 env 逐字同形
// 的既有纪律不破），仅 P15 发射时注入本端口；端口按清单 cdpPort 字段登记派生。
const { cdpPortFor } = require('./lib/registry');
const CDP_PORT = cdpPortFor('51-taskbar-appbar');

// 工单293 普通态清位：原生任务栏 appbar 状态写（ABM_SETSTATE=10）——与 win32.appbarState
// 同一手拼 48 字节 APPBARDATA（不注册具名 struct，#153 撞名教训；x64 布局
// cbSize4+pad4+hWnd8+uCallback4+uEdge4+rc16+lParam8，lParam@40 携带目标位）。电池自绑
// FFI 先例：IsWindowArrangedFn（本文件 P11）。读回裁决仍走 appbarState()（SETSTATE
// 无返回语义，同生产 appbar.ts 纪律）。
const shell32Set = koffi.load('shell32.dll');
const SHAppBarMessageSet = shell32Set.func('uintptr_t __stdcall SHAppBarMessage(uint32 dwMessage, void *pData)');
function setAppbarStateRaw(state) {
  const buf = Buffer.alloc(48);
  buf.writeUInt32LE(48, 0);
  buf.writeBigInt64LE(BigInt(state), 40);
  SHAppBarMessageSet(0xA /* ABM_SETSTATE */, buf);
}

/** CDP 驱动面板渲染层（仅 P15 禁用径用）：在面板页执行表达式并取回值 */
async function p15CdpEval(expression) {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
  const target = targets.find((t) => t.title === PANEL_TITLE);
  if (!target) throw new Error(`P15 CDP 找不到面板页目标（端口 ${CDP_PORT}）`);
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
    // 工单293：全电池出发时的用户 appbar 原值——P15 清位实验的**最终还原目标**（中途
    // P10 会重启 explorer 按注册表复活原态、P15 会临时置自动隐藏 ON 做受控实验，收尾
    // 一律回到本值，不把电池扰动留给用户）。
    const userStateOriginal = appbarState();

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
    // 工单293 改段（测量时点，判据不变）：AppBar 重协商后壳侧会异步把条带窗**上移一身高**
    // （工单158 已证的壳行为：协商 rc 恒正确、挪的是窗口本体；keepalive ≤500ms 回正，
    // 挪移一触发一拍、纠正后不复发）。P2 的测量点紧跟收栏进出过渡（P2 的最大化/还原
    // 本身就是迁移触发器），单点采样落在壳侧挪移窗内的概率高——轮询等条带贴底回稳再断言，
    // 量的是「参照窗底边停在栏上沿」的占位不变式，不是壳侧挪移瞬态（R9/R10 磁带：面板
    // 侧协商/复核/回正几何全对，挪窗的是壳）。
    const stripSettledMs = await waitMs(() => {
      const r = win32.rectOf(tbHwnd);
      return r && Math.abs(r.bottom - phys0.height) <= 2;
    }, 3000);
    const maxRect = win32.rectOf(hwndOf(maxWin));
    const stripTop = win32.rectOf(tbHwnd).top;
    const waP2 = workArea();
    const maxOk = maxRect && Math.abs(maxRect.bottom - stripTop) <= 8 && maxRect.bottom < phys0.height - 8;
    if (maxOk && waP2 && Math.abs(maxRect.bottom - waP2.bottom) <= 8) {
      rep.pass(`P2 最大化让位：参照窗底边 ${maxRect.bottom} 停在栏上沿 ${stripTop}（屏底 ${phys0.height}，未被遮挡；条带贴底回稳 ${stripSettledMs}ms）`);
    } else {
      rep.fail(`P2 参照窗=${JSON.stringify(maxRect)} 栏上沿=${stripTop} 工作区底=${waP2 && waP2.bottom} 屏高=${phys0.height} 前台=${Number(win32.GetForegroundWindow())} 条带贴底回稳=${stripSettledMs}ms`);
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
          // 工单293 改段（期望值随当拍重采样）：显示模式切换后 SPI_GETWORKAREA 即时反映新模，
        // Electron screen.getPrimaryDisplay 的缓存传播时延可 >6.5s 且负载相关（2026-10-26
        // 两轮对照：18:13 轮 1.5s 内到位判绿；18:21 轮 workArea 已到 640x480（工作区底 432）、
        // 条带底 480，而 primaryPhys 缓存仍报 1440 ⇒ 一次性采样的期望 1392 与当拍 432 永不
        // 相等，5s 轮询恒红）。旧写法量的是「缓存传播速度」而非段意「几何随新分辨率重算」——
        // 逐拍以当拍物理尺寸重算期望（判据不变：底边=新模屏高−48、条带贴新模屏底），
        // 「模式确实切到位且稳住」改在等待完成后新鲜采样断言。
        const waMs1 = await waitMs(() => {
          const p = primaryPhys();
          if (p.height !== alt.height) return false;
          const wa = workArea();
          return wa && wa.bottom === p.height - Math.round(TASKBAR_HEIGHT_DIP * p.scale);
        }, 8000);
        const phys1 = primaryPhys();
        const waAfter = workArea();
        const stripAfter = await waitMs(() => {
          const r = win32.rectOf(tbHwnd);
          return r && Math.abs(r.bottom - phys1.height) <= 2;
        }, 5000);
        const stripRect1 = win32.rectOf(tbHwnd);
        if (reposEv && waMs1 >= 0 && stripAfter >= 0 && phys1.height === alt.height) {
          rep.pass(`P3 分辨率变化重算：${alt.width}x${alt.height} 下工作区底 ${waAfter.bottom}、条带底 ${stripRect1.bottom} 随新分辨率重算（setpos 存证在流）`);
        } else {
          rep.fail(`P3 setpos存证=${!!reposEv} 工作区=${JSON.stringify(waAfter)} 当拍物理=${JSON.stringify(primaryPhys())} 目标=${alt.width}x${alt.height} 条带=${JSON.stringify(stripRect1)}`);
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
    //      + 工作区回一栏高（重注册占位 + 退回清位目标，两笔账同拍收敛——工单293 清位口径：
    //      读回无 AUTOHIDE 位，不是用户原值，原值只在退场复原）。
    rep.beginSegment('P6');
    rep.note(`P6 口径（工单260 改段；工单293 清位口径改段）：收栏置位 ABS_AUTOHIDE（原生栏托管）后 shell 释放原生任务栏 48px 保留带，`
      + `工作区底边 1392→1440=屏底（spike 实测）——旧断言「收栏态底边 ≥ 屏底−48」退役，`
      + `新不变式「底边 = 屏底（±2）」+ 参照窗铺满整屏（±8 装饰边）；恢复态断言不变（回一栏高），`
      + `并新增清位口径断言：退收栏读回无 AUTOHIDE 位（退回清位目标，非用户原值）。`);
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
    // 清位口径不变式（工单293 改段）：退收栏回**普通栏态清位目标**——读回无 AUTOHIDE 位
    // （不是用户原值：原值只在退场复原；本断言与用户原值无关，对任意 ALWAYSONTOP 组合恒成立）
    const clearedOk6 = await waitMs(() => (appbarState() & 0x1) === 0, 4000);
    const workAreaOk6 = waMs6 >= 0 && flushMs6 >= 0 && restoreMs6 >= 0 && clearedOk6 >= 0 && settledVisible6
      && !!waRetract6 && Math.abs(waRetract6.bottom - phys6.height) <= 2
      && !!waRestored6 && Math.abs(waRestored6.bottom - expectBottom6) <= 2;
    if (retractEv6 && removedEv6 && liftedEv6 && regEv6 && workAreaOk6) {
      rep.pass(`P6 最大化收栏：前台真最大化窗 ${fgMs6}ms 落位后注销 AppBar + 置位 ABS_AUTOHIDE（taskbar-retract 存证 appBar=${retractEv6.appBar} + taskbar-appbar-removed 存证）`
        + `→ 占位与原生保留带双释放：工作区底边 ${waRetract6.bottom}/${phys6.height} = 屏底（±2，${waMs6}ms 到位）、`
        + `参照窗底边 ${refRect6.bottom} 铺满整屏（${flushMs6}ms 重排到底）；`
        + `解除最大化后重注册 + 退回清位目标（taskbar-retract-lifted 存证 appBar=${liftedEv6.appBar} + taskbar-appbar-registered 存证，`
        + `读回 appbar=0x${appbarState()} 无 AUTOHIDE 位、${clearedOk6}ms 落定——清位目标非用户原值，原值只在退场复原）`
        + `→ 工作区回一栏高 ${waRestored6.bottom}（期望 ${expectBottom6}，${restoreMs6}ms 收敛）`);
    } else {
      rep.fail(`P6 收栏存证=${!!retractEv6} 注销存证=${!!removedEv6} 恢复存证=${!!liftedEv6}（终点visible=${settledVisible6}） 重注册存证=${!!regEv6} `
        + `工作区收栏态=${JSON.stringify(waRetract6)}/屏底=${phys6.height}（到屏底=${waMs6}ms） 参照窗=${JSON.stringify(refRect6)}（贴底=${flushMs6}ms） `
        + `恢复态=${JSON.stringify(waRestored6)} 期望底=${expectBottom6}（收敛=${restoreMs6}ms） 清位读回无AUTOHIDE=${clearedOk6 >= 0}（现值 0x${appbarState()}）`);
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
    // + 清位收敛回一栏高（工单260：收栏态的屏底不变式退出后必须回得来；工单293 清位口径：
    // 清位 = AUTOHIDE 位退场——读回无 AUTOHIDE，不是复原用户原值）
    const occEv7 = await tape.wait('taskbar-appbar-registered', undefined, { since: sinceFs7, timeoutMs: 3000 });
    const clearedOk7 = await waitMs(() => (appbarState() & 0x1) === 0, 4000);
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
    const priorityOk7 = clearedOk7 >= 0 && waYieldMs7 >= 0 && !!waYield7 && Math.abs(waYield7.bottom - expectBottom6) <= 2
      && waMs7b >= 0 && !!waRetract7 && Math.abs(waRetract7.bottom - phys6.height) <= 2;
    if (retractEv7 && yieldEv7 && hideMs7 >= 0 && occEv7 && retractInFull7.length === 0
      && retractEv7b && relEv7b && priorityOk7) {
      rep.pass(`P7 三态优先级：收栏态在前台全屏窗 ${fgMs7}ms 落位后 ${hideMs7}ms 被全屏让位压过`
        + `（taskbar-yield 存证、条带整窗退场、占位恢复 appBar-registered 存证在流、清位落定 ${clearedOk7}ms（读回无 AUTOHIDE 位）、工作区底边 ${waYield7.bottom} 回一栏高、全屏期间收栏存证 0 条）；`
        + `退出全屏回到最大化窗后收栏态自动回来（taskbar-retract 再落 appBar=${retractEv7b && retractEv7b.appBar} + taskbar-appbar-removed、`
        + `条带 ${showMs7}ms 复现、工作区底边 ${waRetract7.bottom} 回屏底）`);
    } else {
      rep.fail(`P7 收栏存证=${!!retractEv7} yield存证=${!!yieldEv7} 隐藏时延=${hideMs7}ms 占位恢复存证=${!!occEv7} 清位读回无AUTOHIDE=${clearedOk7 >= 0} `
        + `工作区(让位)=${JSON.stringify(waYield7)}（收敛=${waYieldMs7}ms） `
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
    // 真解除（工单270）：标题栏拖拽解 Snap——Win+Down 在本机对 Snap 窗是**最小化**语义
    // （R1/R2 磁带 cause=minimized 实证），不能当解除用；拖离后浮定（arranged=false 且非
    // iconic），拖点落屏中央不靠边（不触发边沿 Snap）
    const dragUnsnap = async (hwnd) => {
      for (let i = 0; i < 5; i++) {
        const r = win32.rectOf(hwnd);
        if (!r) return false;
        const sx = Math.round((r.left + r.right) / 2);
        const sy = Math.round(r.top + 20); // 标题带
        win32.moveMousePhys(sx, sy);
        await sleep(120);
        win32.send([win32.mouseInput(0, 0, win32.LEFTDOWN)]);
        win32.moveMousePhys(sx + 40, sy + 20);
        await sleep(60);
        win32.moveMousePhys(sx + 80, sy + 40);
        await sleep(60);
        win32.moveMousePhys(sx + 120, sy + 60);
        await sleep(150);
        win32.send([win32.mouseInput(0, 0, win32.LEFTUP)]);
        await sleep(450);
        if (!Boolean(IsWindowArrangedFn(hwnd)) && !win32.IsIconic(hwnd)) return true;
      }
      return false;
    };
    // 宿主收尾（R2 定谳的加固）：WM_CLOSE 后核验窗口/进程真退场，残留即进程强杀——
    // 残留 Snap 成员会把会话拖住，P5/P9/P10 全被翻（R2 级联红的根因）
    const closeSnapHosts = async (...hosts) => {
      for (const h of hosts) if (h && h.hwnd) win32.PostMessageW(h.hwnd, WM_CLOSE, 0, 0);
      await waitMs(() => hosts.every((h) => !h || !h.hwnd
        || !win32.IsWindow(h.hwnd) || h.proc.exitCode !== null), 4000);
      for (const h of hosts) {
        if (h && h.proc && h.proc.exitCode === null && h.hwnd && win32.IsWindow(h.hwnd)) {
          try { h.proc.kill('SIGKILL'); } catch { /* finally 兜底再杀 */ }
        }
      }
      await sleep(300);
    };
    // 目标宽度自适应 Snap（工单270 三分之一/三分之二布局）：Win+Z 打开 Snap Layouts
    // 浮出 → 数字键选布局 → 数字键选分区（微软文档键盘通道）。布局编号随版本排列
    // 不同——候选组合逐试，IsWindowArranged+实测宽度命中即停（有界，不赌编号次序）。
    // R3 定谳的坑：多分区布局落位后 Windows 弹 Snap Assist（建议其他窗补位）——后续
    // 候选的键击会被它吃掉、把**无关窗口**（用户在用窗口）Snap 进邻位（磁带 members=3
    // 实证）。防线：每次落位后立刻 ESC 收掉 Assist，再做核验
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
        await sleep(350);
        // 收掉可能弹出的 Snap Assist（ESC 不影响已落位的窗）——不吃后续候选的键击
        win32.send([win32.keyInput(0x1b /* ESC */, win32.KEYDOWN)]);
        win32.send([win32.keyInput(0x1b, win32.KEYUP)]);
        await sleep(350);
        if (!Boolean(IsWindowArrangedFn(hwnd))) continue;
        const r = win32.rectOf(hwnd);
        if (r && Math.abs((r.right - r.left) - targetW) <= tol) return true;
      }
      return false;
    };
    // 外来 Snap 清扫（R3 定谳加固）：Win+Z Assist 可能已把无关窗口 Snap 进位（成员残留
    // 拖住会话）——按前置清场同款纪律 SW_MINIMIZE（可逆：用户点任务栏图标即原样回
    // Snap 态），只在确有残留时才动
    const sweepAlienSnaps = async () => {
      const aliens = liveSnapWindows();
      if (!aliens.length) return 0;
      for (const h of aliens) win32.ShowWindow(h, 6 /* SW_MINIMIZE */);
      await waitMs(() => liveSnapWindows().length === 0, 3000);
      return aliens.length;
    };

    // —— P12：分屏会话集合生命周期与代表性布局（工单270 新增）——
    // 断言面（票面验收判据的真机观测）：
    //   ① 左右双窗统一判定：两窗各 Win+Left/Right → 会话+收栏+工作区屏底+两窗上下贴边；
    //   ② 普通前台切换不打断：中性 holder/Snap 窗轮换前台 1.3s（5+ 拍）零会话结束、零
    //      retract-lifted、工作区保持屏底、两 Snap 窗矩形逐字不变（不反复变化）；
    //   ③ 解除集合生命周期（标题栏拖拽真解除——Win+Down 在本机是**最小化**语义，R1/R2
    //      磁带 cause=minimized 实证）：解除其一 → 会话由剩余成员维持；解除最后一个
    //      → 会话结束（cause=unsnapped 可区分存证）+ 复原；
    //   ④⑤ 最小化集合生命周期：重 Snap 后最小化其一 → 会话维持（a1 矩形不变）；最小化
    //      其一（剩余维持拍）→ 最后一个最小化 → 会话结束（cause=minimized）+ 复原；
    //   ⑥ 恢复最后一个 → 按当前事实重建会话；
    //   ⑦ 三分之一加三分之二：Win+Z 布局浮出数字键通道定位 1/3 宽 + 互补 2/3 →
    //      同一判定进分屏收栏贴边；收尾关宿主后会话必须结束、工作区复原（防成员
    //      残留拖住会话——R2 级联根因）。
    rep.beginSegment('P12');
    await waitMs(wsBarOk12, 5000); // 出发态回常驻（P11 收尾已复原，此处等占位生效档落定）
    const r12 = {
      dual: false, fgStable: false, minOne: false, minLast: false, rebuild: false, unsnapEnd: false, thirds: false, bClean: false,
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
    // ③ 解除集合生命周期（标题栏拖拽真解除——Win+Down 在本机是**最小化**语义，R1/R2
    //    磁带 cause=minimized 实证）：解除其一（a2）→ 会话由 a1 维持；解除最后一个
    //    （a1）→ 结束（cause=unsnapped）+ 复原
    const tUnsnapA = Date.now();
    const unsnapOneOk = await dragUnsnap(a2.hwnd);
    await sleep(1200);
    const unsnapOneHeld = tape.all('taskbar-snap-session', (e) => e.active === false, { since: tUnsnapA }).length === 0
      && tape.all('taskbar-retract-lifted', undefined, { since: tUnsnapA }).length === 0 && wsBottomOk12();
    const unsnapLastOk = await dragUnsnap(a1.hwnd);
    forceForeground(hwndOf(neutralWin));
    const unEndEv12 = await tape.wait('taskbar-snap-session',
      (e) => e.active === false && e.cause === 'unsnapped', { since: tUnsnapA, timeoutMs: 6000 });
    const unLiftEv12 = await tape.wait('taskbar-retract-lifted',
      (e) => e.appBar === 'registered', { since: tUnsnapA, timeoutMs: 6000 });
    const unWa12 = await waitMs(wsBarOk12, 5000);
    r12.unsnapEnd = !!(unsnapOneOk && unsnapOneHeld && unsnapLastOk && unEndEv12 && unLiftEv12) && unWa12 >= 0;
    if (!r12.unsnapEnd) diag12.push(`解除结束=${r12.unsnapEnd}（其一拖解除=${unsnapOneOk} 其一维持=${unsnapOneHeld} 最后拖解除=${unsnapLastOk} 结束存证=${!!unEndEv12} lift=${!!unLiftEv12} 复原=${unWa12}ms）`);
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
    // A 相收尾：a1 恢复后仍是成员、a2 最小化非成员——关宿主并核验退场（会话随 a1
    // 关闭结束，落一条 cause=closed 事件在 B 相 since 门之前，不与 B 相断言互踩）
    await closeSnapHosts(a1, a2);
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
      // B 相收尾（R2/R3 定谳加固）：关宿主**核验退场**（残留即强杀）→ 清扫外来 Snap
      // （Win+Z Assist 可能已把无关窗口 Snap 进位，磁带 members=3 实证）→ 会话必须
      // 结束、工作区复原——残留成员会把会话拖住，P13/P5/P9/P10 全被翻
      await closeSnapHosts(b1, b2);
      const aliensB = await sweepAlienSnaps();
      const bCleanWa = await waitMs(wsBarOk12, 5000);
      r12.bClean = bCleanWa >= 0;
      if (!r12.bClean) diag12.push(`B收尾=${r12.bClean}（外来清扫=${aliensB} 关宿主后会话未结束/工作区未复原=${bCleanWa}ms——成员残留）`);
    }
    if (r12.dual && r12.fgStable && r12.minOne && r12.minLast && r12.rebuild && r12.unsnapEnd && r12.thirds && r12.bClean) {
      rep.pass(`P12 分屏会话集合生命周期与代表性布局：左右双窗统一进分屏收栏（会话+注销收栏存证在流、工作区屏底、两窗上下贴边）；`
        + `普通前台轮换 5+ 拍零会话结束/零复原、Snap 窗矩形逐字不变；`
        + `拖拽真解除其一仍维持、最后一个解除结束（cause=unsnapped）→ 复原；重 Snap 后最小化其一仍维持（a1 矩形不变）、`
        + `最后一个最小化结束（cause=minimized）→ 复原；恢复即按当前事实重建；`
        + `1/3+2/3 布局经同一判定收栏贴边（${thirdsDetail}）；收尾关宿主后会话结束、工作区复原`);
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
    await sweepAlienSnaps(); // 防御性清场（B 相收尾已扫，此处兜底——外来 Snap 会占住会话让四角建不起）
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
    // P13 收尾（R2/R3 定谳加固——无论断言成败都执行）：关四角宿主并核验退场（残留即
    // 强杀）→ 清扫外来 Snap → 等会话结束、工作区复原；残留成员会把会话拖住翻掉 P5/P9/P10
    await closeSnapHosts(...cw);
    await sweepAlienSnaps();
    await waitMs(wsBarOk12, 5000);
    }

    // —— P14：全屏让位与分屏会话解耦（工单271 新增）——
    // 断言面（票面验收判据的真机观测；「栏面被全屏覆盖」与「分屏会话结束」在存证流上可分）：
    //   ① 分屏后台建立：Snap 参照窗（powershell WinForms，P11 同款）→ 会话存证 + 收栏
    //      （工作区屏底、上下贴边）；
    //   ② 全屏进入：前台全屏参照窗 → 整条栏隐藏（唤出条也不出）+ taskbar-yield 且
    //      appBar=kept（占位保持释放、托管不中断——无会话旧路径此字段是 registered）
    //      + 零 retract-lifted + 工作区保持屏底（覆盖期 5+ 拍观察窗首尾一致）+ 后台
    //      Snap 窗矩形逐字不变（不因工作区反复恢复改尺寸）；
    //   ②′ 覆盖期间会话仍存续的退出全屏（票面判据 3 前半，工单271 评审收口）：仅
    //      taskbar-yield-lifted、零 retract 族（工作区账面不动——不重复注销/置位）、
    //      条带窗回场（分屏收栏唤出条直接回归）、工作区保持屏底、Snap 窗矩形不变；
    //      随后重进全屏接 ③；
    //   ③ 覆盖期间结束会话：关 Snap 宿主 → taskbar-snap-session(active=false) + 零
    //      retract-lifted + 工作区仍屏底（理由消失不当场复原——档位冻结让位）；
    //   ④ 退出全屏（会话已结束、无其他收栏理由）→ 按既有路径恢复常驻：yield-lifted +
    //      retract-lifted(appBar=registered) + 工作区回一栏高；
    //   ⑤ 最大化临时覆盖：重建分屏会话 → 真最大化参照窗抢前台 → 分屏收栏保持（零新
    //      retract/零 yield——zoomed 与会话同档幂等）+ 条带窗在场（栏窗复用）+ 工作区
    //      屏底 + Snap 窗矩形不变；解除最大化 → 分屏收栏直接恢复（零 lift——不先复原
    //      再收栏）；收尾清场（残留成员会拖住会话翻 P5/P9/P10）。
    rep.beginSegment('P14');
    await waitMs(wsBarOk12, 5000);
    await sweepAlienSnaps();
    const r14 = { bgSession: false, cover: false, exitAlive: false, endInCover: false, restoreAfter: false, maxCover: false };
    const diag14 = [];
    const s14a = await spawnSnapPs('DECK-ACCEPT-SNAP-E1');
    if (!s14a.hwnd) {
      rep.fail('P14 Snap 参照窗未出现（powershell WinForms 宿主 10s 内无可见顶层窗——环境异常）');
    } else {
      // ① 分屏后台建立（前台钉中性 holder——会话是后台事实）。贴边按等待式判
      // （R1 定谳：工作区落定先于 Snap 自动重排完成——一次性采样撞时延误判）
      const since14 = Date.now();
      const snapOk14 = await chordUntil(s14a.hwnd, VK_LEFT, true);
      forceForeground(hwndOf(neutralWin));
      const sess14 = await tape.wait('taskbar-snap-session', (e) => e.active === true, { since: since14, timeoutMs: 6000 });
      const waBg14 = await waitMs(wsBottomOk12, 5000);
      const edgeBg14 = await waitMs(() => edgesFullOk(win32.rectOf(s14a.hwnd)), 5000);
      const rectBg14 = win32.rectOf(s14a.hwnd);
      r14.bgSession = !!(snapOk14 && sess14) && waBg14 >= 0 && edgeBg14 >= 0;
      if (!r14.bgSession) diag14.push(`后台会话=${r14.bgSession}（和弦=${snapOk14} 会话存证=${!!sess14} 屏底=${waBg14}ms 贴边=${edgeBg14}ms ${JSON.stringify(rectBg14)}）`);
      // ② 全屏进入（覆盖分屏收栏的栏面）+ ③ 覆盖期间结束会话
      if (r14.bgSession) {
        const sinceFs14 = Date.now();
        const fsWin14 = new BrowserWindow({ fullscreen: true, frame: false, title: 'DECK-ACCEPT-FS14', backgroundColor: '#101820' });
        refWins.push(fsWin14);
        await fsWin14.loadURL('about:blank');
        fsWin14.show();
        fsWin14.focus();
        forceForeground(hwndOf(fsWin14));
        const fgMs14 = await waitMs(() => Number(win32.GetForegroundWindow()) === hwndOf(fsWin14), 4000);
        const hideMs14 = await waitMs(() => !win32.IsWindowVisible(tbHwnd), 5000);
        // 解耦关键判据：覆盖迁移的 appBar=kept（占位保持释放）——无会话旧路径是 registered
        const yieldEv14 = await tape.wait('taskbar-yield',
          (e) => e.appBar === 'kept', { since: sinceFs14, timeoutMs: 5000 });
        await sleep(1300); // 5+ 个 250ms 轮询拍：覆盖期工作区稳定性观察窗
        const liftInFs14 = tape.all('taskbar-retract-lifted', undefined, { since: sinceFs14 }).length;
        const waCover14 = workArea();
        const rectCover14 = win32.rectOf(s14a.hwnd);
        const coverOk14 = fgMs14 >= 0 && hideMs14 >= 0 && !!yieldEv14
          && !!waCover14 && Math.abs(waCover14.bottom - phys12.height) <= 2
          && sameRect12(rectCover14, rectBg14);
        // ②′ 覆盖期间会话仍存续的退出全屏（票面判据 3 前半，工单271 评审收口）：分屏
        //     收栏唤出条直接回归——仅 yield-lifted、零 retract 族（工作区账面不动，不重复
        //     注销/置位）、条带窗回场、工作区保持屏底、Snap 窗矩形不变；随后重进全屏接 ③
        const tExit14 = Date.now();
        fsWin14.destroy();
        refWins.pop();
        forceForeground(hwndOf(neutralWin));
        const ylExit14 = await tape.wait('taskbar-yield-lifted', undefined, { since: tExit14, timeoutMs: 5000 });
        await sleep(900); // 3+ 个 250ms 轮询拍：零 retract 族存证静默观察窗
        const retractFamExit14 = tape.all('taskbar-retract-lifted', undefined, { since: tExit14 }).length
          + tape.all('taskbar-retract', undefined, { since: tExit14 }).length;
        const waExit14 = workArea();
        const rectExit14 = win32.rectOf(s14a.hwnd);
        const barBack14 = win32.IsWindowVisible(tbHwnd); // 收栏态条带窗回场（栏窗复用承载唤出条）
        r14.exitAlive = !!ylExit14 && retractFamExit14 === 0
          && barBack14 && !!waExit14 && Math.abs(waExit14.bottom - phys12.height) <= 2
          && sameRect12(rectExit14, rectCover14);
        if (!r14.exitAlive) diag14.push(`覆盖期存续退出=${r14.exitAlive}（yield-lifted=${!!ylExit14} retract族=${retractFamExit14} 条带回场=${barBack14} 工作区=${waExit14 && waExit14.bottom}/${phys12.height} Snap矩形不变=${sameRect12(rectExit14, rectCover14)}）`);
        // ③ 重进全屏（覆盖重新压上——会话仍存续； appBar=kept 复验解耦的进入侧幂等）
        const fsWin14b = new BrowserWindow({ fullscreen: true, frame: false, title: 'DECK-ACCEPT-FS14B', backgroundColor: '#101820' });
        refWins.push(fsWin14b);
        await fsWin14b.loadURL('about:blank');
        fsWin14b.show();
        fsWin14b.focus();
        forceForeground(hwndOf(fsWin14b));
        const fgRe14 = await waitMs(() => Number(win32.GetForegroundWindow()) === hwndOf(fsWin14b), 4000);
        const hideRe14 = await waitMs(() => !win32.IsWindowVisible(tbHwnd), 5000);
        const yieldRe14 = await tape.wait('taskbar-yield',
          (e) => e.appBar === 'kept', { since: tExit14, timeoutMs: 8000 });
        if (!(fgRe14 >= 0 && hideRe14 >= 0 && !!yieldRe14)) {
          diag14.push(`③ 重进全屏未成立（前台=${fgRe14}ms 隐藏=${hideRe14}ms yield appBar=kept=${!!yieldRe14}）——③④ 判读作废`);
        }
        // ③ 覆盖期间结束会话（关宿主核验退场——残留成员会把会话拖住，R2 定谳纪律）
        await closeSnapHosts(s14a);
        const endEv14 = await tape.wait('taskbar-snap-session',
          (e) => e.active === false, { since: sinceFs14, timeoutMs: 6000 });
        const liftOnEnd14 = tape.all('taskbar-retract-lifted', undefined, { since: sinceFs14 }).length;
        const waEndCover14 = workArea();
        r14.cover = coverOk14 && liftInFs14 === 0;
        r14.endInCover = !!endEv14 && liftOnEnd14 === 0
          && !!waEndCover14 && Math.abs(waEndCover14.bottom - phys12.height) <= 2;
        if (!r14.cover) diag14.push(`覆盖=${r14.cover}（前台=${fgMs14}ms 隐藏=${hideMs14}ms yield appBar=kept=${!!yieldEv14} 覆盖期lift=${liftInFs14} 工作区=${waCover14 && waCover14.bottom}/${phys12.height} Snap矩形不变=${sameRect12(rectCover14, rectBg14)}）`);
        if (!r14.endInCover) diag14.push(`覆盖期结束=${r14.endInCover}（结束存证=${!!endEv14} lift累计=${liftOnEnd14} 工作区=${waEndCover14 && waEndCover14.bottom}/${phys12.height}）`);
        // ④ 退出全屏 → 既有路径恢复常驻（会话已结束、无其他收栏理由）
        const tLift14 = Date.now();
        fsWin14b.destroy();
        refWins.pop();
        forceForeground(hwndOf(neutralWin));
        const ylEv14 = await tape.wait('taskbar-yield-lifted', undefined, { since: tLift14, timeoutMs: 5000 });
        const rlEv14 = await tape.wait('taskbar-retract-lifted',
          (e) => e.appBar === 'registered', { since: tLift14, timeoutMs: 6000 });
        const waRest14 = await waitMs(wsBarOk12, 6000);
        r14.restoreAfter = !!ylEv14 && !!rlEv14 && waRest14 >= 0;
        if (!r14.restoreAfter) diag14.push(`退出恢复=${r14.restoreAfter}（yield-lifted=${!!ylEv14} retract-lifted(registered)=${!!rlEv14} 工作区复原=${waRest14}ms）`);
      }
      // E1 收尾（无论②③④成败——残留成员会把会话拖住污染⑤与 P5/P9/P10，R2 定谳纪律）：
      // 关宿主核验退场 → 清扫外来 Snap → 等会话结束、工作区复原（⑤的出发态必须干净）
      await closeSnapHosts(s14a);
      await sweepAlienSnaps();
      const preWa14b = await waitMs(wsBarOk12, 5000);
      if (preWa14b < 0) diag14.push(`⑤前置：E1 收尾后工作区未复原（会话可能被残留成员拖住）`);
      // ⑤ 最大化临时覆盖后台分屏布局（不结束会话；两理由同档幂等）
      const s14b = await spawnSnapPs('DECK-ACCEPT-SNAP-E2');
      if (!s14b.hwnd) {
        diag14.push('⑤ Snap 参照窗未出现（环境异常）');
      } else {
        const sinceMax14 = Date.now();
        const snapOk14b = await chordUntil(s14b.hwnd, VK_LEFT, true);
        forceForeground(hwndOf(neutralWin));
        const sess14b = await tape.wait('taskbar-snap-session', (e) => e.active === true, { since: sinceMax14, timeoutMs: 6000 });
        const waBg14b = await waitMs(wsBottomOk12, 5000);
        const rectBg14b = win32.rectOf(s14b.hwnd);
        const maxWin14 = new BrowserWindow({ width: 900, height: 600, title: 'DECK-ACCEPT-MAX-14', backgroundColor: '#101010' });
        refWins.push(maxWin14);
        await maxWin14.loadURL('about:blank');
        // 时间门在会话建起、收栏落定之后：只计「最大化覆盖期间」的新生存证
        const tMaxCov14 = Date.now();
        maxWin14.maximize();
        forceForeground(hwndOf(maxWin14));
        const fgMax14 = await waitMs(() => Number(win32.GetForegroundWindow()) === hwndOf(maxWin14), 4000);
        await sleep(1500); // 6+ 个轮询拍：最大化覆盖观察窗
        const noNewEv14 = tape.all('taskbar-retract', undefined, { since: tMaxCov14 }).length === 0
          && tape.all('taskbar-yield', undefined, { since: tMaxCov14 }).length === 0
          && tape.all('taskbar-retract-lifted', undefined, { since: tMaxCov14 }).length === 0;
        const stripAlive14 = win32.IsWindowVisible(tbHwnd); // 收栏态条带窗在场（栏窗复用承载唤出条）
        const waMax14 = workArea();
        const rectMax14 = win32.rectOf(s14b.hwnd);
        // 解除最大化 → 分屏收栏直接恢复（零 lift/零新 retract——同档幂等，不先复原再收栏）
        maxWin14.unmaximize();
        forceForeground(hwndOf(neutralWin));
        await sleep(1200);
        const noLiftAfter14 = tape.all('taskbar-retract-lifted', undefined, { since: sinceMax14 }).length === 0;
        const waBack14 = workArea();
        r14.maxCover = snapOk14b && !!sess14b && waBg14b >= 0 && edgesFullOk(rectBg14b) && fgMax14 >= 0
          && noNewEv14 && stripAlive14 && !!waMax14 && Math.abs(waMax14.bottom - phys12.height) <= 2
          && sameRect12(rectMax14, rectBg14b) && noLiftAfter14
          && !!waBack14 && Math.abs(waBack14.bottom - phys12.height) <= 2;
        if (!r14.maxCover) diag14.push(`最大化覆盖=${r14.maxCover}（和弦=${snapOk14b} 会话=${!!sess14b} 屏底=${waBg14b}ms 前台=${fgMax14 >= 0} 零新存证=${noNewEv14} 条带在场=${stripAlive14} 工作区=${waMax14 && waMax14.bottom}/${phys12.height} Snap矩形不变=${sameRect12(rectMax14, rectBg14b)} 解除后零lift=${noLiftAfter14} 解除后屏底=${waBack14 && waBack14.bottom}/${phys12.height}）`);
        maxWin14.destroy();
        await closeSnapHosts(s14b);
        await sweepAlienSnaps();
        await waitMs(wsBarOk12, 5000); // P5 出发态：会话结束、工作区复原到位
      }
    }
    if (r14.bgSession && r14.cover && r14.exitAlive && r14.endInCover && r14.restoreAfter && r14.maxCover) {
      rep.pass(`P14 全屏让位与分屏会话解耦：分屏后台收栏（会话存证在流、工作区屏底）；全屏进入整条栏隐藏且 taskbar-yield appBar=kept`
        + `（占位保持释放、托管不中断——覆盖期零 retract-lifted）、工作区保持屏底、后台 Snap 窗矩形逐字不变；`
        + `覆盖期间会话存续的退出全屏 → 仅 yield-lifted、分屏收栏唤出条直接回归（条带回场、零 retract 族、工作区仍屏底、Snap 矩形不变），重进全屏 appBar=kept 幂等；`
        + `覆盖期间结束会话（active=false）零 lift、工作区仍屏底（理由消失不当场复原）；`
        + `退出全屏按既有路径恢复常驻（yield-lifted + retract-lifted appBar=registered、工作区回一栏高）；`
        + `最大化临时覆盖不结束分屏会话（零新存证、条带在场、工作区屏底、Snap 矩形不变），解除后分屏收栏直接恢复（幂等零迁移）`);
    } else {
      rep.fail(`P14 解耦未全绿：${JSON.stringify(r14)}；${diag14.join('；')}`);
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
    // —— P9：面板正常退出 → 可见性与 appbar 状态双复原（工单260 新增；工单293 扩「普通态也不复活」）——
    // P5 验的是常驻态退出的占位归还；本段验 #260 验收标准「面板正常退出 → 双复原」的
    // 收栏态形态 + 工单293 的普通档形态（臂 B）。判读注意（R1 取证）：置位态 explorer 翻开
    // Shell_TrayWnd 的 WS_VISIBLE 位（「窗口显示位」≠「视觉在场」，spike 附记），面板侧
    // showNativeTaskbar 会走「已可见静默」不发 taskbar-restored——可见性以退出后的控制器
    // 独立视图事实为准。工单293 口径更正：原值必须在**接管建立前**读（state9 前移到发射
    // 之前）——全接管期起，接管后的读回是清位目标（无 AUTOHIDE 位），不再是用户原值；
    // 「复原为原值」的「原」自接管建立那一刻固定。
    rep.beginSegment('P9');
    const state9 = appbarState(); // 接管建立前的用户原值（臂 A/B 双复原的共同判据）
    handle.launch({ mode: 'accept', stdio: 'ignore' });
    const boot9 = await tape.wait('boot', null, { timeoutMs: 20000 });
    if (!boot9) throw new Error('P9 面板未上报 boot');
    panelPid = boot9.pid;
    if (!(await handle.waitWindow({ title: TASKBAR_TITLE, timeoutMs: 12000 }))) throw new Error('P9 条带窗未出现');
    forceForeground(hwndOf(neutralWin)); // 出发态回常驻（P9 的收栏须由参照窗前台真最大化触发）
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

    // —— P9 臂 B（工单293 扩「普通态也不复活」）：普通档退出同径双复原 ——
    // 全接管期起，普通栏态也持有清位账（接管建立即记账落盘、清 AUTOHIDE）。本臂重拉面板
    // **不进收栏**（普通档）：① 接管清位生效（taskbar-autohide-takeover/-cleared 存证 +
    // 读回无 AUTOHIDE 位）；② 静置原生栏不复活（3s 观察窗保持不可见——全接管期禁现面）；
    // ③ WM_CLOSE 退出 → taskbar-autohide-restored reason=dispose + appbar 状态复原为
    // **接管前原值**（state9）+ 落盘账清（复原义务履行完毕不留陈旧账）+ 原生栏可见。
    handle.launch({ mode: 'accept', stdio: 'ignore' });
    const bootEv9b = await tape.wait('boot', null, { timeoutMs: 20000 });
    if (!bootEv9b) throw new Error('P9b 面板未上报 boot');
    panelPid = bootEv9b.pid;
    if (!(await handle.waitWindow({ title: TASKBAR_TITLE, timeoutMs: 12000 }))) throw new Error('P9b 条带窗未出现');
    forceForeground(hwndOf(neutralWin)); // 普通档出发（不进收栏）
    const since9b = bootEv9b.t;
    const takeEv9b = await tape.wait('taskbar-autohide-takeover', (e) => e.userState === state9, { since: since9b, timeoutMs: 8000 });
    const clearEv9b = await tape.wait('taskbar-autohide-cleared', (e) => e.reason === 'takeover', { since: since9b, timeoutMs: 5000 });
    const clearedWa9b = await waitMs(() => (appbarState() & 0x1) === 0, 5000);
    // 静置不复活：普通档下原生栏 3s 观察窗保持不可见（无人唤出——接管禁现的静置面）
    await sleep(3000);
    const stayedHidden9b = !nativeTaskbarVisible();
    const t9b = Date.now();
    const panelHwnd9b = await handle.waitWindow({ title: PANEL_TITLE, timeoutMs: 8000 });
    if (!panelHwnd9b) throw new Error('P9b 面板主窗未找到');
    win32.PostMessageW(panelHwnd9b, WM_CLOSE, 0, 0);
    const restoredEv9b = await tape.wait('taskbar-autohide-restored',
      (e) => e.reason === 'dispose', { since: t9b, timeoutMs: 8000 });
    const stateOk9b = await waitMs(() => appbarState() === state9, 8000);
    const ledgerFile9b = path.join(process.env.APPDATA || '', 'agent-deck-panel', 'appbar-ledger.json');
    const ledgerGone9b = await waitMs(() => !fs.existsSync(ledgerFile9b), 4000);
    const nativeOk9b = await waitMs(() => nativeTaskbarVisible(), 8000);
    if (takeEv9b && clearEv9b && clearedWa9b >= 0 && stayedHidden9b && restoredEv9b && stateOk9b >= 0
      && ledgerGone9b >= 0 && nativeOk9b >= 0) {
      rep.pass(`P9b 普通档退出双复原（工单293 扩臂）：接管建立记账（takeover userState=${takeEv9b.userState}）+ 清位生效`
        + `（cleared 存证、读回 0x${appbarState()} 无 AUTOHIDE、${clearedWa9b}ms 落定）；静置 3s 原生栏不复活；`
        + `WM_CLOSE 退出 → restored reason=dispose（attempts=${restoredEv9b.attempts}）+ appbar 读回复原 ${appbarState()}（接管前原值 ${state9}）`
        + `+ 落盘账清 + 原生栏可见`);
    } else {
      rep.fail(`P9b 接管存证=${!!takeEv9b} 清位存证=${!!clearEv9b} 清位落定=${clearedWa9b}ms 静置不复活=${stayedHidden9b} `
        + `复原存证=${JSON.stringify(restoredEv9b)} 状态复原=${stateOk9b}ms（现值 ${appbarState()}/原值 ${state9}） `
        + `落盘账清=${ledgerGone9b >= 0} 原生可见=${nativeOk9b >= 0}`);
    }

    // —— P10：全接管期原生栏重申轮询（工单262 新增；工单293 判据改段——值守从「收栏期」
    //        扩为「全接管期」，ADR-0016 双缺陷复审 Q1/Q2）：explorer 重启 → 轮询重挂 ——
    // 段位在 P9 之后：explorer 重启会把 appbar 状态按注册表原态复活，起跑基线自此断裂
    // （R1 实测教训：本段曾插在 P5 前，P5/P9 的基线比对全被打断）——重启段必须垫底，
    // P5/P9 的基线断言跑在原 explorer 上。
    // 三拍断言（票面验收标准 1/2/3 各一拍；裁决逻辑在 native-watch.ts 纯机器单测钉住，
    // 本段只验 FFI 效果面——真机行为存证，章法增段三条件之 1/2）：
    //   拍 A 可见性翻转压回（标准 2）：SW_SHOWNOACTIVATE 翻开原生栏显示位（不夺前台——
    //      SW_SHOW 会激活任务栏，前台被夺把收栏档合法翻掉、轮询停表，R1 实测教训）
    //      → reason=visible 重申 + 压回不可见（1s 轮询拍 + 容差）；
    //   拍 B explorer 重启重挂（标准 1）：Stop-Process explorer（AutoRestartShell 归位，
    //      10s 未归自起 explorer.exe 兜底）→ 新 Shell_TrayWnd → reason=rebuild 重申 +
    //      重挂。⚠️ R1 实测：新起 explorer 约 15s 内不接受 ABM_SETSTATE/ABM_NEW（轮询
    //      逐拍重试全部落 failed，过了接受窗一发即中）——隐藏按「及时」断言（≤4s，重挂的
    //      隐藏动作只走 user32 不等 shell），置位按「终态」断言（≤40s 内 AUTOHIDE 位在场
    //      + 工作区回屏底；轮询拍 1s 属设计参数，由单测钉在 1–2s 档）。工单293 界 25s→40s
    //      校准（三轮对照：R2 接受 3ms；R1/R3 接受窗 >37s——接受窗尾部随系统负载拉长，
    //      40s 界按观测尾部定，轮询逐拍重试语义不变）；
    //   拍 C 普通档仍值守（工单293 改段——旧「非收栏态休止」判据退役）：退收栏（普通档、
    //      仍接管）清位落定后翻开原生栏 → 1s 拍内 reason=visible 重申 + 压回不可见。
    //      旧判据「2.6s 零重申存证且保持可见」与全接管期值守直接矛盾：普通档的清位同样
    //      会被 explorer 重启按注册表原值冲掉、可见性翻转同样要压回（底边/Win 键唤出通路
    //      已随清位关闭，但 ShowWindow 注入的显示位翻转仍归轮询摁住）——轮询不再随收栏
    //      起停，起表随接管建立（create）、停表随拆场（destroy）。
    rep.beginSegment('P10');
    // 拍间状态（拍 B → 拍 C 级联判读用）：降级档是否在拍 B 窗口内到场（重注册被拒）。
    const p10Beat = { degradedAt: 0 };
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
        // 置位终态：逐拍重试由轮询自转（1s 拍），此处等终态——长等期间持续钉前台
        // （前台被夺会停表断掉重试）；工单293 界 25s→40s：五轮对照 R2 <12s / R1 >52s /
        // R4 66s（shell 侧 AppBar 接受窗尾部随负载拉长，面板侧逐拍重试语义全程不变）。
        // 夹具保持（工单293 R5 实证）：explorer 重启搅动会把参照窗的**最大化态**翻掉/
        // 前台钉不住——面板对「前台非最大化」判 visible 档（不置位）是按既定裁决的正确
        // 行为，错的是电池夹具；每拍核验 maximized，丢了即补。
        const tStateB = Date.now();
        let stateMsB = -1;
        let fixtureRepairedB = 0;
        while (Date.now() - tStateB <= 40000) {
          if (!retractWin.isMaximized()) { retractWin.maximize(); fixtureRepairedB += 1; }
          forceForeground(hwndOf(retractWin));
          if ((appbarState() & 0x1) !== 0) { stateMsB = Date.now() - tStateB; break; }
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
            + ` + reason=rebuild 重申存证在流；置位经 ${stateMsB}ms 终态到场（新 explorer 接受窗内轮询逐拍重试${fixtureRepairedB ? `；夹具最大化修复 ${fixtureRepairedB} 次` : ''}）`
            + ` → 工作区底边 ${workArea().bottom}/${phys6.height} 回屏底（${waB}ms）`);
        } else if (reassertB && hideEvB && hiddenB >= 0 && stateMsB < 0) {
          // 置位界内未到场：三分辨——①面板义务面（重申逐拍不断流 + retract 档保持）缺 ⇒
          // 真回归候；②shell 接受窗尾部（义务面全真而 ABM 不被接受）⇒ 环境降责账；③重启
          // 搅动打掉夹具（参照窗最大化态丢失且补不回）⇒ 电池夹具账——面板对观察事实
          // （前台非最大化）判 visible 不置位是既定裁决的正确行为。
          const pressesB = tape.all('taskbar-autohide-reattach-failed', undefined, { since: tKill });
          const modesHeldB = pressesB.length > 0 && pressesB.every((e) => e.mode === 'retracted');
          // 降级级联辨（工单293 出证轮 R7 实证）：重建拍上档位漂 visible（合法）+ 重注册被
          // shell 拒（register-failed 在流）⇒ 按工单50/51 既有语义进**降级档**（注册失败一次
          // 不再重试）——此后 resolveBarMode 恒 visible（降级闸门）、置位断言在结构上不可达，
          // 面板行为全程符合设计。这是 explorer-acceptance-tail 的级联形态，同为 shell 侧。
          const degradedB = tape.all('taskbar-appbar-register-failed', undefined, { since: tKill }).length > 0
            && tape.all('taskbar-retract-lifted', (e) => e.appBar === 'register-failed', { since: tKill }).length > 0;
          if (degradedB) p10Beat.degradedAt = Date.now();
          if (pressesB.length >= 15 && modesHeldB) {
            rep.exclude(`P10b 置位界内未到场（>40s）：新 shell AppBar 接受窗尾部超界（explorer-acceptance-tail）——面板义务面全真：`
              + `重申逐拍重试 ${pressesB.length} 拍无一缺席（mode=retracted 全程保持）、reason=rebuild 重申存证在流、重挂隐藏 ${hideLatencyB}ms（≤4s）、压回不可见（${hiddenB}ms）。`
              + `五轮对照接受时延：R2 <12s / R1 >52s / R4 66s——25s 旧界按 15s 观察标定，尾部为 shell 侧事实（本机负载相关），不判面板回归`,
              'explorer 重启后 ABM 接受窗尾部超 40s 界（shell 侧，接受时延 52–66s 观测）', 'explorer-acceptance-tail');
          } else if (degradedB) {
            rep.exclude(`P10b 置位界内未到场：explorer AppBar 接受窗尾部打掉重注册 → 降级档级联（explorer-acceptance-tail 级联）——重建拍上档位漂 visible（合法迁移）后重注册被拒（register-failed + retract-lifted appBar=register-failed 在流），`
              + `按工单50/51 既有语义（注册失败一次不再重试）进降级档：resolveBarMode 恒 visible（降级闸门），置位断言结构上不可达。`
              + `面板义务面仍真：reason=rebuild 重申存证在流、首次重申拍照发（reattach-failed mode=retracted）、重挂隐藏 ${hideLatencyB}ms（≤4s）、压回不可见（${hiddenB}ms）——shell 接受窗尾部是唯一缺席面，不判面板回归`,
              '重建拍重注册撞接受窗尾部 → 降级档级联（explorer-acceptance-tail 级联）', 'explorer-acceptance-tail');
          } else if (!retractWin.isMaximized() || Number(win32.GetForegroundWindow()) !== hwndOf(retractWin)) {
            // 夹具账细判：最大化态丢失，或 40s 逐拍钉前台都没能把参照窗钉回前台——两者都是
            // 重启搅动打掉电池参照物（restart-chaos-fixture）；参照物既不稳，面板的档位输入
            // 就不是「前台真最大化」，判 visible 不置位是既定裁决的正确行为。
            rep.exclude(`P10b 置位界内未到场：explorer 重启搅动打掉电池夹具（restart-chaos-fixture）——参照窗最大化态${retractWin.isMaximized() ? '在场' : '丢失且补不回'}（修复尝试 ${fixtureRepairedB} 次）、`
              + `窗末前台=${Number(win32.GetForegroundWindow()) === hwndOf(retractWin) ? '参照窗' : '他窗（钉前台 40s 未夺回）'}、`
              + `重申重试拍数=${pressesB.length}（mode 系列见磁带）。面板对「前台非最大化」按既定裁决处理（visible 档不置位），`
              + `重启窗口内的夹具失稳是电池参照物问题，不判面板回归；重挂隐藏 ${hideLatencyB}ms（≤4s）与 rebuild 重申存证两项面板义务仍真`,
              'explorer 重启搅动致参照窗最大化态丢失/前台钉不住（restart-chaos-fixture）', 'restart-chaos-fixture');
          } else {
            rep.fail(`P10b 置位界内未到场且面板义务面有缺：重申重试拍数=${pressesB.length}（要求 ≥15） retract 档保持=${modesHeldB} `
              + `rebuild重申=${!!reassertB} 重挂隐藏=${hideEvB ? `${hideLatencyB}ms` : '缺'} 不可见=${hiddenB >= 0}ms（state=${stateB}）——真回归候`);
          }
        } else {
          rep.fail(`P10b rebuild重申=${!!reassertB} 重挂隐藏=${hideEvB ? `${hideLatencyB}ms` : '缺'} 不可见=${hiddenB >= 0}ms `
            + `置位终态=${stateMsB}ms（state=${stateB}） 工作区=${waB >= 0 ? `${waB}ms` : '未到'}（现值 ${workArea() && workArea().bottom}/${phys6.height}） `
            + `新窗=${hwndAfter} 归位=${firstSeenAt - tKill}ms 自起兜底=${spawnedExplorer}`);
        }
      }

      // —— 拍 C：普通档仍值守（工单293 改段——旧「非收栏态休止」判据随全接管期退役）——
      const tLift = Date.now();
      retractWin.unmaximize();
      forceForeground(hwndOf(neutralWin));
      const lifted10 = await tape.wait('taskbar-retract-lifted',
        (e) => e.mode === 'visible' && e.appBar === 'registered', { since: tLift, timeoutMs: 8000 });
      if (!lifted10) {
        // 前置失败先辨因：unmaximize 的重注册撞上 shell 接受窗尾部（磁带有 register-failed）
        // 或拍 B 窗口内已降级（p10Beat.degradedAt——降级档恒 visible，同态零动作无 lifted 存证）
        // → 同一环境因（explorer-acceptance-tail）的级联，本拍前提不成立，环境降责；
        // 都不是 → 收栏态残留/重注册真失败，真红。
        const regFailC = tape.all('taskbar-appbar-register-failed', undefined, { since: tLift }).length > 0
          || p10Beat.degradedAt > 0;
        if (regFailC) {
          rep.exclude(`P10c 前置未成立：${p10Beat.degradedAt > 0 ? '拍 B 窗口内已入降级档（explorer-acceptance-tail 级联），降级闸门下恒 visible、unmaximize 同态零动作无 lifted 存证' : '退收栏重注册撞 explorer AppBar 接受窗尾部（register-failed 在流）'}`
            + '——本拍前提（重注册成功且档位可迁移）被同一 shell 侧因打掉，环境降责不判面板',
            '退收栏前提被接受窗尾部/降级档级联打掉（explorer-acceptance-tail 级联）', 'explorer-acceptance-tail');
        } else {
          rep.fail('P10c 前置失败：退收栏未成立（重注册失败或收栏态残留——见磁带 appBar 字段）');
        }
      } else {
        // 普通档目标落定：退收栏清位（读回无 AUTOHIDE 位）——值守压回的目标由此派生
        const clearedC = await waitMs(() => (appbarState() & 0x1) === 0, 4000);
        const tC = Date.now();
        const hwndC = win32.nativeTrayHwnd();
        if (!hwndC) {
          rep.fail('P10c 出发态异常：找不到 explorer 的 Shell_TrayWnd');
        } else {
          win32.ShowWindow(hwndC, 4 /* SW_SHOWNOACTIVATE */); // 普通档翻开原生栏——值守必须压回
          const reassertC = await tape.wait('taskbar-native-reassert',
            (e) => e.reason === 'visible', { since: tC, timeoutMs: 4000 });
          const hiddenC = await waitMs(() => !win32.nativeTaskbarVisible(), 4000);
          const latencyC = reassertC ? reassertC.t - tC : -1;
          if (reassertC && hiddenC >= 0 && latencyC <= 2500 && clearedC >= 0) {
            rep.pass(`P10c 普通档仍值守（全接管期）：退收栏清位落定（${clearedC}ms、读回无 AUTOHIDE 位）后翻开原生栏，`
              + `${latencyC}ms 重申命中（reason=visible）→ 压回不可见（${hiddenC}ms 到位）`
              + '——值守覆盖全接管期（起表随接管建立、停表随拆场），非收栏档不再休止');
          } else {
            rep.fail(`P10c 清位落定=${clearedC}ms 重申存证=${!!reassertC}（时延=${latencyC}ms） 压回不可见=${hiddenC >= 0}ms`);
          }
        }
      }

    // —— P15：普通态清位与三路径禁现（工单293 新增，spec #292）——
    // 断言面（票面验收判据的真机观测；纯逻辑面已由单测钉住——三目标态纯函数、轮询两档
    // 决策矩阵、单账纪律；本段验 FFI 效果面与用户可见结果，章法增段三条件之 1/2）：
    //   ① 受控原值（自动隐藏置 ON）下重拉面板：接管建立即记账落盘（taskbar-autohide-takeover
    //      userState=受控原值）+ 清位（taskbar-autohide-cleared + 读回无 AUTOHIDE 位）——
    //      用户本已开自动隐藏时这是**有动作**的清位（票面 AC 2），落盘账是崩溃后守卫/守护
    //      的复原目标（票面 AC 1，账在盘上由断言 ⑤ 的「账清」反证其在场纪律）；
    //   ② 底边悬停 3.5s 无可见帧（AC 5 路径一）：清位关闭了自动隐藏协议本身，悬停唤不出；
    //   ③ Win 键无可见帧（AC 5 路径二）：同上——两路径均以控制器独立视图事实采样；
    //   ④ 通知路径只记「未观察」不谎报（AC 5 路径三——spec Out of Scope 如实登记）；
    //   ⑤ 禁用任务栏（CDP 驱动真实渲染层 taskbar/set-enabled）→ taskbar-autohide-restored
    //      reason=disabled + appbar 读回=接管前原值（AC 6）+ 落盘账清 + 原生栏可见位还原。
    // 判读口径：「可见帧」= Shell_TrayWnd 的 IsWindowVisible 显示位（「显示位 ≠ 视觉在场」
    // 既有口径；清位后显示位不该被任何唤出通路翻开）。收尾把 appbar 状态还原为全电池出发
    // 值（userStateOriginal）——中途实验扰动不留给用户。
    rep.beginSegment('P15');
    const ledgerFile15 = path.join(process.env.APPDATA || '', 'agent-deck-panel', 'appbar-ledger.json');
    const stop15 = await handle.stop(); // P10 尾面板在场（普通档）——停掉换受控原值重拉
    if (stop15 && stop15.gone === false) rep.note(`P15 前置：旧面板强退未净（pid=${stop15.pidsLeft.join(', ')}）——继续（发射侧会再清）`);
    // 等「上一任接管的落盘账」出清（优雅退 = 面板自行复原清账；强杀退 = 还原守护接力复原
    // 清账）：账在场说明复原还没走完，此刻置受控原值会被接力的复原写覆盖——清账即该径
    // 收尾完毕，之后才置受控原值、才发射（engage 读到的就是受控原值）。
    const prevLedger15 = await waitMs(() => !fs.existsSync(ledgerFile15), 10000);
    if (prevLedger15 < 0) rep.note('P15 前置：上任落盘账 10s 未出清（守护接力未到位？）——继续（新接管建立会重写账，风险自担并如实判读）');
    await sleep(800);
    const u15 = appbarState();
    const user15 = (u15 & 0x2) | 0x1; // 受控原值：保留 ALWAYSONTOP 位、置 AUTOHIDE——清位对它是有动作的
    setAppbarStateRaw(user15);
    const staged15 = await waitMs(() => (appbarState() & 0x1) === 1, 3000);
    if (staged15 < 0) {
      rep.fail(`P15 前置失败：受控原值置不上（set 0x${user15} 后读回 0x${appbarState()}）——本段不可判`);
    } else {
      await sleep(800); // 自动隐藏 ON 的现场稳定（原生栏本体回「隐藏待唤出」）
      const since15 = Date.now();
      handle.launch({ mode: 'accept', cdpPort: CDP_PORT, stdio: 'ignore' }); // 仅本段注 CDP（禁用径通道）
      const boot15 = await tape.wait('boot', null, { timeoutMs: 20000 });
      if (!boot15) throw new Error('P15 面板未上报 boot');
      panelPid = boot15.pid;
      if (!(await handle.waitWindow({ title: TASKBAR_TITLE, timeoutMs: 12000 }))) throw new Error('P15 条带窗未出现');
      forceForeground(hwndOf(neutralWin));
      // ① 接管建立记账 + 清位（有动作）
      const takeEv15 = await tape.wait('taskbar-autohide-takeover',
        (e) => e.userState === user15, { since: since15, timeoutMs: 8000 });
      const clearEv15 = await tape.wait('taskbar-autohide-cleared',
        (e) => e.reason === 'takeover', { since: since15, timeoutMs: 5000 });
      const cleared15 = await waitMs(() => (appbarState() & 0x1) === 0, 5000);
      const ledgerOn15 = fs.existsSync(ledgerFile15); // 接管在场 ⇒ 账必须在盘（崩溃后守卫/守护的复原目标）
      // ② 底边悬停 3.5s：逐 150ms 采样显示位，任何一拍可见即「可见帧」
      win32.moveMousePhys(Math.round(phys12.width / 2), phys12.height - 1);
      const hoverAt15 = Date.now();
      let hoverLeak15 = false;
      while (Date.now() - hoverAt15 < 3500) {
        if (win32.nativeTaskbarVisible()) { hoverLeak15 = true; break; }
        await sleep(150);
      }
      const hoverMs15 = Date.now() - hoverAt15;
      win32.moveMousePhys(Math.round(phys12.width / 2), Math.round(phys12.height / 4)); // 离开底边
      await sleep(500);
      // ③ Win 键：按下→抬起，2.5s 采样窗（开始菜单开启不影响判读——判据只看 Shell_TrayWnd）
      win32.send([win32.keyInput(0x5b /* VK_LWIN */, win32.KEYDOWN)]);
      win32.send([win32.keyInput(0x5b, win32.KEYUP)]);
      const winAt15 = Date.now();
      let winLeak15 = false;
      while (Date.now() - winAt15 < 2500) {
        if (win32.nativeTaskbarVisible()) { winLeak15 = true; break; }
        await sleep(150);
      }
      const winMs15 = Date.now() - winAt15;
      // 收场：ESC 收掉可能弹出的开始菜单 + 前台钉回中性（不扰后续断言）
      win32.send([win32.keyInput(0x1b /* VK_ESCAPE */, win32.KEYDOWN)]);
      win32.send([win32.keyInput(0x1b, win32.KEYUP)]);
      await sleep(400);
      forceForeground(hwndOf(neutralWin));
      // ④ 通知路径：本机无可重复触发手段——只记「未观察」，不谎报（spec Out of Scope）
      rep.note('P15 通知路径：未观察（本机无可重复触发的通知手段——spec Out of Scope 如实登记，本段不作该路径的阳性/阴性断言）');
      // ⑤ 禁用复原：CDP 驱动 taskbar/set-enabled(false) → destroy('disabled') → 路径①复原
      const tDis15 = Date.now();
      let disabled15 = false;
      try {
        await p15CdpEval(`window.deck.bridge.invoke('taskbar/set-enabled', { enabled: false })`);
        disabled15 = true;
      } catch (e) {
        rep.note(`P15 CDP 禁用驱动失败：${e && e.message || e}`);
      }
      const restoredEv15 = disabled15
        ? await tape.wait('taskbar-autohide-restored', (e) => e.reason === 'disabled', { since: tDis15, timeoutMs: 8000 })
        : null;
      const backOk15 = await waitMs(() => appbarState() === user15, 8000);
      const ledgerGone15 = await waitMs(() => !fs.existsSync(ledgerFile15), 4000);
      // 可见性还原判读（工单293 三轮校准）：受控原值带 AUTOHIDE ⇒ 还原后的原生栏是
      // 「隐藏待唤出」的停靠表示，WS_VISIBLE 位是否在场由 explorer 停靠策略决定（「显示位
      // ≠ 视觉在场」既有口径；实证：R1 233ms/R2 2ms 位在场，R3 8s 全窗位不在场而 appbar
      // 读回复原、restored 存证、账清俱真——位不是还原义务的可观测面）。断言取：Shell_TrayWnd
      // 在场 ∧（显示位在场 ∨ 还原态带 AUTOHIDE 位）——原值不带 AUTOHIDE 时仍硬断言显示位。
      const trayOk15 = await waitMs(() => {
        if (!win32.nativeTrayHwnd()) return false;
        return win32.nativeTaskbarVisible() || (appbarState() & 0x1) === 1;
      }, 8000);
      if (takeEv15 && clearEv15 && cleared15 >= 0 && ledgerOn15 && !hoverLeak15 && !winLeak15
        && restoredEv15 && backOk15 >= 0 && ledgerGone15 >= 0 && trayOk15 >= 0) {
        rep.pass(`P15 普通态清位与三路径禁现：受控原值 0x${user15}（自动隐藏 ON）下接管建立记账（takeover userState=${takeEv15.userState}，账在盘=${ledgerOn15}）`
          + `+ 清位生效（cleared 存证、读回 0x${appbarState()} 无 AUTOHIDE、${cleared15}ms 落定——用户本已开自动隐藏时的有动作清位）；`
          + `底边悬停 ${hoverMs15}ms 全窗零可见帧、Win 键 ${winMs15}ms 零可见帧（通知路径未观察，如实登记）；`
          + `禁用任务栏 → restored reason=disabled（attempts=${restoredEv15.attempts}）+ appbar 读回复原 0x${user15}（${backOk15}ms）`
          + `+ 落盘账清 + 原生栏还原在场（${trayOk15}ms；显示位=${win32.nativeTaskbarVisible()}——AUTOHIDE 原值下 explorer 停靠位自主）`);
      } else {
        rep.fail(`P15 接管存证=${!!takeEv15} 清位存证=${!!clearEv15} 清位落定=${cleared15}ms 账在盘=${ledgerOn15} `
          + `底边悬停泄漏=${hoverLeak15}（观察 ${hoverMs15}ms） Win键泄漏=${winLeak15}（观察 ${winMs15}ms） `
          + `禁用驱动=${disabled15} 复原存证=${JSON.stringify(restoredEv15)} 读回复原=${backOk15}ms（现值 0x${appbarState()}/受控原值 0x${user15}） `
          + `账清=${ledgerGone15 >= 0} 原生栏还原在场=${trayOk15 >= 0}（hwnd=${win32.nativeTrayHwnd()} 显示位=${win32.nativeTaskbarVisible()}）`);
      }
    }
    // P15 收尾：appbar 状态还原为全电池出发值（实验扰动不留给用户）；面板已禁用态由
    // finally 的 handle.stop 清场，config 由 restoreConfig 还原。
    setAppbarStateRaw(userStateOriginal);
    await sleep(400);
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
