'use strict';
// 工单51 任务栏托管与三态验收（工单308 M1 覆盖式普通档改写；spec #306）：控制器以
// --accept-taskbar-appbar 身份运行，拉起 --panel-accept 面板子进程（绕单实例锁），
// 逐项验收。M1 语义基座：接管建立=置位一次（taskbar-autohide-takeover + -set）、
// 此后整个托管期 auto-hide 恒置位、工作区恒整屏（保留带恒释放）、运行期零 appbar
// 状态拍动；自绘栏覆盖式常驻（条带恒贴屏底、任何窗口尺寸不被托管改变）。
//   P1 接管建立=置位（工单308 改写）：taskbar-autohide-takeover（userState=开跑前原值）
//      + taskbar-autohide-set 存证 + 读回含 AUTOHIDE 位 + 工作区底边=屏底（保留带释放）
//      + 条带贴屏底（AppBar 注册存证族随占位链退役）
//   P2 覆盖式常驻（工单308 改写，主诉不变式的静态面）：后台真最大化参照窗底边=屏底
//      （不因托管收窄）、条带覆盖其上贴屏底、读回恒含 AUTOHIDE——「最大化让位」（窗给
//      栏让位）语义随占位退役，窗尺寸永不被改变
//   P3 分辨率变化重算（工单308 改写）：切到另一受支持分辨率 → 条带随新分辨率重贴新屏底
//      + 工作区随新屏恒整屏 → 还原（setpos 存证断言随占位链退役）
//   P4 全屏让位：控制器自开全屏参照窗并置前台 → 条带隐藏（taskbar-yield 存证 +
//      视图事实）；销毁全屏窗 → 1 秒内恢复（taskbar-yield-lifted 存证 + 时延断言）
//   P5 退场复原（工单308 改写）：面板正常退出（WM_CLOSE）→ taskbar-autohide-restored
//      （路径①）+ appbar 读回=开跑前原值 + 工作区归还基线 + 原生栏可见
//   P6 最大化收栏（工单244；工单308 M1 改写）：前台真最大化窗 → 栏面退场出唤出条
//      （taskbar-retract 存证；条带窗在场承载、零 appbar 状态拍动——收栏进出无置位/注销）+
//      工作区恒屏底（M1：托管期不变式，非收栏动作的效果）+ 读回恒含 AUTOHIDE；解除最大化
//      → taskbar-retract-lifted → 栏面复现（覆盖式常驻）+ 读回仍含 AUTOHIDE（不再有清位）
//      + 原生栏零可见帧
//   P7 三态优先级（工单244；工单308 M1 改写）：全屏让位压过收栏（全屏态条带整窗退场 +
//      全屏期间无收栏存证 + 读回恒置位）；退出全屏回到最大化窗 → 收栏态自动回来
//      （taskbar-retract 再落）；解除 → 回常驻
//   P9 收栏态退出双复原（工单260；工单293 扩全接管期；工单308 M1 改写）：重拉面板进收栏
//      （收栏档零置位拍——置位只在接管建立）→ 收栏态 WM_CLOSE 正常退出 → appbar 状态复原为
//      接管前原值 + 工作区回基线 + 原生栏可见（还原路径①）；扩臂 B：普通档退出同径复原
//      （M1：接管即置位——读回含 AUTOHIDE、静置原生栏不复活、退场复原原值、落盘账清）
//   P10 全接管期原生栏重申轮询（工单262；工单293 判据改段；工单308 M1 改写——目标态恒
//      置位，段位垫底——explorer 重启断基线）：可见性翻转压回（SW_SHOWNOACTIVATE 注入 →
//      reason=visible 重申 + 压回）；explorer 重启重挂（Stop-Process explorer +
//      AutoRestartShell 归位 → 新 Shell_TrayWnd → reason=rebuild 重申 + 隐藏及时≤4s +
//      置位终态≤40s（新 explorer 约 15s 不接受窗，重申轮询逐拍重试）→ 工作区回屏底）；
//      普通档（收栏解除后、仍接管）翻开原生栏 → 1s 拍内 reason=visible 重申 + 压回
//      （M1：值守目标恒置位，无清位落定前置）
//   P15 受控原值下的接管置位与三路径禁现（工单293 新增；工单308 M1 改写）：受控原值
//      （自动隐藏 ON）下重拉面板 → 接管建立记账（taskbar-autohide-takeover userState=
//      受控原值）+ 置位（taskbar-autohide-set——对已开用户是无操作写入，结果不变、记账
//      照走）；三路径禁现：底边悬停 3.5s 无可见帧、Win 键无可见帧、通知路径证据单列
//      （工单292 F3 审计 docs/audit/2026-10-26-spec292-notification-center-path.md；
//      spike 背书：SW_HIDE + 置位态唤出 0 帧不闪现 docs/audit/2026-10-24-t257-
//      autohide-setstate-probe.md）；禁用任务栏（CDP 驱动 taskbar/set-enabled）→
//      taskbar-autohide-restored reason=disabled + appbar 读回=接管前原值 + 落盘账清
//      + 原生栏还原在场（AUTOHIDE 原值下显示位由 explorer 停靠策略自主——「显示位 ≠
//      视觉在场」口径）
//   P16 覆盖式主诉专项段（工单308 新增，spec #306）：后台真最大化窗 + 普通窗夺前台——
//      全程 appbar 读回恒置位、零 appbar 状态族存证（takeover/set 之后零拍动）、最大化窗
//      尺寸采样逐点不变、条带覆盖常驻屏底；再进收栏（前台最大化）→ 退回普通前台 → 栏回
//      常驻、最大化窗尺寸仍不变（运行期任何档位迁移不改窗尺寸）
//   P11 分屏收栏单窗最小闭环（工单269；工单308 M1 改写）：Win+Left 键盘合成建立真 Snap
//      （IsWindowArranged 直读互证）→ 会话存证 taskbar-snap-session(active) + 收栏档
//      （taskbar-retract；零 appbar 拍动、工作区恒屏底）且前台钉中性 holder（后台事实，
//      普通前台不打断）；Snap 窗上下贴边（Windows 自动重排，工单268 定谳——面板零改窗）；
//      唤出条悬停弹出且 Snap 窗矩形逐字不变；Win+Down 解除 → 会话结束 + retract-lifted
//      （栏面回常驻、工作区恒屏底）；SetWindowPos 摆半屏几何伪分屏阴性（3+ 轮询拍零收栏/
//      零会话存证——矩形不得成为身份兜底）
//   P12 分屏会话集合生命周期与代表性布局（工单270；工单308 M1 随动——工作区断言恒屏底）：
//      左右双窗统一进入分屏收栏并上下贴边；普通前台切换不打断（矩形逐字不变）；标题栏
//      拖拽真解除其一仍维持、最后一个解除结束（cause=unsnapped）并回常驻（Win+Down 在本机
//      是**最小化**语义，R1/R2 磁带实证，不用于解除）；重 Snap 后最小化其一仍维持、
//      最后一个最小化结束（cause=minimized 存证）且恢复即按当前事实重建；三分之一加
//      三分之二布局经 Win+Z 布局浮出数字键通道定位，同一真 Snap 判定收栏贴边；收尾
//      关宿主核验退场（残留成员会拖住会话——R2 级联根因）
//   P13 虚拟桌面切换隔离与收栏理由接续（工单270；工单308 M1 随动）：四角布局统一判定；
//      Win+Ctrl+D 切到新桌面 → 会话结束（cause=desktop-switched）；切回原桌面按该桌面
//      实际布局重建会话；真最大化前台期间关闭全部 Snap 窗 → 会话结束（cause=closed +
//      retractHeldByZoomed=true、无 retract-lifted——理由接续不先恢复再收栏），解除最大化
//      才单次回常驻
//   P14 全屏让位与分屏会话解耦（工单271；工单308 M1 改写——「占位保持释放」叙事改「托管
//      恒置位不中断」）：分屏后台建立 → 全屏进入整条栏隐藏（零 retract-lifted + 读回恒
//      置位）+ 工作区恒屏底 + 后台 Snap 窗矩形不变；覆盖期间退出全屏 → 分屏收栏直接回归
//      （仅 yield-lifted、零 retract 族）；覆盖期间结束会话零 lift；退出全屏按既有路径回
//      常驻（yield-lifted + retract-lifted）；最大化临时覆盖不结束会话（同档幂等）
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

    // —— P1：接管建立=置位（工单308 M1 改写）——
    rep.beginSegment('P1');
    // 受控前台（工单260 前移的既有纪律）：环境里真最大化的前台窗会合法触发收栏档（M1 下
    // 收栏只翻栏面不写系统状态，但 P1 要断的是普通档出发态）——中性前台 holder 先立起，
    // 钉住前台不被环境夺走。
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
    forceForeground(hwndOf(neutralWin)); // 再钉一次：boot 等待期间环境可能夺回前台
    // M1 接管建立：记账（takeover userState=开跑前原值）+ 置位（set）+ 读回含 AUTOHIDE
    const takeEv1 = await tape.wait('taskbar-autohide-takeover',
      (e) => e.userState === userStateOriginal, { timeoutMs: 8000 });
    const setEv1 = await tape.wait('taskbar-autohide-set', null, { timeoutMs: 5000 });
    const setReadMs1 = await waitMs(() => (appbarState() & 0x1) === 1, 5000);
    // 保留带释放有生效时延，轮询到屏底（±2）——M1 托管期恒整屏的基线拍
    const phys0 = primaryPhys();
    const waMs = await waitMs(() => {
      const wa = workArea();
      return wa && Math.abs(wa.bottom - phys0.height) <= 2;
    }, 5000);
    const wa1 = workArea();
    const stripRect = win32.rectOf(tbHwnd);
    const stripOk = stripRect && Math.abs(stripRect.bottom - phys0.height) <= 2;
    if (takeEv1 && setEv1 && setReadMs1 >= 0 && waMs >= 0 && stripOk) {
      rep.pass(`P1 接管建立=置位：takeover userState=${takeEv1.userState}/原值 ${userStateOriginal} + set 存证在流，读回含 AUTOHIDE（${setReadMs1}ms 落定）`
        + `；保留带释放——工作区底边 ${wa1.bottom}/${phys0.height} = 屏底（±2，${waMs}ms 到位），条带底边 ${stripRect.bottom} 贴屏底（覆盖式常驻；AppBar 注册族随占位链退役）`);
    } else {
      rep.fail(`P1 takeover=${JSON.stringify(takeEv1)} set=${!!setEv1} 置位读回=${setReadMs1}ms 工作区=${JSON.stringify(wa1)}/屏底=${phys0.height}（${waMs}ms） 条带=${JSON.stringify(stripRect)}`);
    }

    // —— P2：覆盖式常驻（工单308 M1 主诉不变式的静态面）——
    // 后台真最大化参照窗：底边=屏底（工作区恒整屏，不因托管收窄一身高）、条带覆盖其上
    // （贴屏底）、读回恒含 AUTOHIDE——「最大化让位」（窗给栏让位）语义随 AppBar 占位链
    // 退役，托管期任何窗口尺寸永不被改变（尺寸动态面在 P16 专项段逐点采样）。
    rep.beginSegment('P2');
    const maxWin = new BrowserWindow({ width: 800, height: 600, title: 'DECK-ACCEPT-MAX', backgroundColor: '#203040' });
    refWins.push(maxWin);
    await maxWin.loadURL('about:blank');
    maxWin.maximize();
    await sleep(1200); // 等最大化落定（M1：后台最大化窗直接铺到屏底——工作区已恒整屏）
    forceForeground(hwndOf(neutralWin)); // 前台钉回中性 holder（参照窗保持后台）
    await sleep(600); // 等 250ms 轮询过两拍
    const maxRect2 = win32.rectOf(hwndOf(maxWin));
    const stripRect2 = win32.rectOf(tbHwnd);
    const overlayOk2 = maxRect2 && stripRect2
      && Math.abs(maxRect2.bottom - phys0.height) <= 8   // 最大化窗底边=屏底（±8 装饰边，P6 同口径）
      && Math.abs(stripRect2.bottom - phys0.height) <= 2 // 条带贴屏底
      && stripRect2.top <= maxRect2.bottom;              // 条带与窗底带重叠=覆盖关系
    const autoOk2 = (appbarState() & 0x1) === 1;
    if (overlayOk2 && autoOk2) {
      rep.pass(`P2 覆盖式常驻：后台最大化窗底边 ${maxRect2.bottom} = 屏底 ${phys0.height}（±8，尺寸不被托管收窄），`
        + `条带 [${stripRect2.top},${stripRect2.bottom}] 贴屏底覆盖其上，读回恒含 AUTOHIDE（0x${appbarState()}）`);
    } else {
      rep.fail(`P2 参照窗=${JSON.stringify(maxRect2)} 条带=${JSON.stringify(stripRect2)} 屏高=${phys0.height} 读回=0x${appbarState()}（AUTOHIDE=${autoOk2}）`);
    }

    // —— P3：分辨率变化重算（工单308 M1 改写：几何随新分辨率重贴，setpos 存证随占位链退役）——
    rep.beginSegment('P3');
    const alt = alternateDisplayMode(originalMode);
    if (!alt) {
      rep.fail('P3 找不到与当前不同的受支持分辨率（本机显示模式枚举异常）');
      } else {
        if (!setDisplayMode(alt.buf)) {
          rep.fail(`P3 ChangeDisplaySettingsW 切到 ${alt.width}x${alt.height} 被拒`);
        } else {
          modeSwitched = true;
          await sleep(1500); // 等显示器重同步 + display-metrics-changed 投递
          // 期望值随当拍重采样（工单293 既定纪律：Electron 缓存传播时延可 >6.5s，逐拍以
          // 当拍物理尺寸重算）。M1 判据：条带贴新模屏底（display-metrics 重排照走）、工作区
          // 随新模恒整屏（托管置位在新模式下同样释放保留带）。
          const stripMs3 = await waitMs(() => {
            const p = primaryPhys();
            if (p.height !== alt.height) return false;
            const r = win32.rectOf(tbHwnd);
            return r && Math.abs(r.bottom - p.height) <= 2;
          }, 8000);
          const phys1 = primaryPhys();
          const waAfter = workArea();
          const stripRect1 = win32.rectOf(tbHwnd);
          const waOk3 = !!waAfter && phys1.height === alt.height && Math.abs(waAfter.bottom - phys1.height) <= 2;
          if (stripMs3 >= 0 && waOk3) {
            rep.pass(`P3 分辨率变化重算：${alt.width}x${alt.height} 下条带底 ${stripRect1 ? stripRect1.bottom : '?'} 贴新屏底、工作区底 ${waAfter.bottom} = 新屏高（保留带恒释放——setpos 存证随占位链退役，display-metrics 重排照走）`);
          } else {
            rep.fail(`P3 条带回稳=${stripMs3}ms 工作区=${JSON.stringify(waAfter)} 当拍物理=${JSON.stringify(phys1)} 目标=${alt.width}x${alt.height} 条带=${JSON.stringify(stripRect1)}`);
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

    // —— P6：最大化收栏（工单244；工单308 M1 改写）：栏面退场出唤出条、零 appbar 拍动 ——
    // 术语：「收栏」= 栏给窗让位（与 P2 的覆盖式常驻方向相反，两词不混用）。
    // 断言面（真机可观测）：
    //   ① 收栏存证 taskbar-retract（mode=maximize-retract；M1：payload 无 appBar 字段——
    //      占位维度随占位链退役）+ 条带窗在场（栏窗复用，工单241 修正 E3——唤出条承载）；
    //   ② 零 appbar 状态拍动（M1 主不变式）：收栏进出全程磁带零 taskbar-autohide-set/
    //      -set-failed/-reattached/-reattach-failed 族（置位只在接管建立拍）+ 读回恒含
    //      AUTOHIDE 位；
    //   ③ 工作区不变式（M1）：收栏态底边 = 屏底（±2）——托管期恒整屏，收栏不再改变它；
    //   ④ 栏面复现：解除最大化 → taskbar-retract-lifted（两跳路径容忍，R3 实证）→
    //      条带窗在场（覆盖式常驻）+ 读回仍含 AUTOHIDE（M1 无清位目标——旧「退回清位」
    //      断言随占位链退役）+ 工作区恒屏底；
    //   ⑤ 原生栏零可见帧：退收栏后 2s 采样窗零可见拍（SW_HIDE + 置位态唤出 0 帧不闪现，
    //      t257 spike；显示位翻转归 1s 值守压回）。收栏期中的显示位不作判读（autohide
    //      「滑出屏」态的窗口位标记非确定，native-watch 头注 spike 附记）。
    rep.beginSegment('P6');
    const phys6 = primaryPhys();
    const retractWin = new BrowserWindow({ width: 800, height: 600, title: 'DECK-ACCEPT-RETRACT', backgroundColor: '#203040' });
    refWins.push(retractWin);
    await retractWin.loadURL('about:blank');
    const sinceP6 = Date.now(); // 时间门必须在触发动作之前（收栏存证落在最大化之后）
    retractWin.maximize();
    await sleep(600);
    forceForeground(hwndOf(retractWin)); // 前台锁下 focus() 静默失败，必须走强制链入
    const fgMs6 = await waitMs(() => Number(win32.GetForegroundWindow()) === hwndOf(retractWin), 4000);
    // 收栏存证：mode=maximize-retract（M1：零 appbar 动作随档位迁移）
    const retractEv6 = await tape.wait('taskbar-retract',
      (e) => e.mode === 'maximize-retract', { since: sinceP6, timeoutMs: 6000 });
    // 五组唤出条存证（条几何渲染层自算；JSON 去重——与前轮几何一致时不出新条，回取最近）
    let stripsEv6 = await tape.wait('taskbar-summon-strips',
      (e) => Array.isArray(e.strips) && e.strips.length > 0, { since: sinceP6, timeoutMs: 3000 });
    if (!stripsEv6) {
      stripsEv6 = tape.latest('taskbar-summon-strips',
        (e) => Array.isArray(e.strips) && e.strips.length > 0, {});
    }
    const SUMMON_GROUPS_ALL6 = ['start', 'recs', 'apps', 'right', 'showdesk'];
    const fiveStripsOk6 = !!stripsEv6 && SUMMON_GROUPS_ALL6.every((g) => stripsEv6.strips.some((s) => s.group === g));
    const stripAlive6 = win32.IsWindowVisible(tbHwnd); // 栏窗复用：收栏态条带窗在场（承载唤出条）
    // 零 appbar 拍动（M1 主不变式）：sinceP6 起状态写入族存证零条
    const flapCount6 = () => tape.all('taskbar-autohide-set', undefined, { since: sinceP6 }).length
      + tape.all('taskbar-autohide-set-failed', undefined, { since: sinceP6 }).length
      + tape.all('taskbar-autohide-reattached', undefined, { since: sinceP6 }).length
      + tape.all('taskbar-autohide-reattach-failed', undefined, { since: sinceP6 }).length;
    const flapEvents6 = flapCount6();
    // 工作区恒屏底（M1 托管期不变式）+ 读回恒置位
    const waRetract6 = workArea();
    const wsOk6 = !!waRetract6 && Math.abs(waRetract6.bottom - phys6.height) <= 2;
    const autoOn6 = (appbarState() & 0x1) === 1;
    // 恢复：解除最大化（前台不再是真最大化窗）→ 栏面复现
    const t6 = Date.now();
    retractWin.unmaximize();
    forceForeground(hwndOf(neutralWin));
    // 退收栏存证（既有两跳容忍）：解最大化动画期 250ms 轮询可能拍到「zoomed=false + 矩形
    // 仍全屏」→ 合法走 retract→yield→visible 两跳（R3 磁带实证）；谓词只放宽「终点
    // visible 的到达方式」，断言面不降。
    const liftedEv6 = await tape.wait('taskbar-retract-lifted', undefined, { since: t6, timeoutMs: 6000 });
    let settledVisible6 = !!liftedEv6 && liftedEv6.mode === 'visible';
    if (liftedEv6 && liftedEv6.mode !== 'visible') {
      const ylEv6 = await tape.wait('taskbar-yield-lifted', undefined, { since: t6, timeoutMs: 6000 });
      settledVisible6 = !!ylEv6 && ylEv6.mode === 'visible';
    }
    const stripBack6 = win32.IsWindowVisible(tbHwnd); // 覆盖式常驻：条带复现
    const flapAfter6 = flapCount6();
    // 退收栏零可见帧：原生栏显示位 2s 采样窗零可见拍（150ms 采样，P15 同口径）
    const hiddenAt6 = Date.now();
    let leakFrames6 = false;
    while (Date.now() - hiddenAt6 < 2000) {
      if (nativeTaskbarVisible()) { leakFrames6 = true; break; }
      await sleep(150);
    }
    const hiddenMs6 = Date.now() - hiddenAt6;
    const waRestored6 = workArea();
    const wsRestoredOk6 = !!waRestored6 && Math.abs(waRestored6.bottom - phys6.height) <= 2;
    const autoStill6 = (appbarState() & 0x1) === 1;
    if (retractEv6 && stripAlive6 && flapEvents6 === 0 && wsOk6 && autoOn6
      && liftedEv6 && settledVisible6 && stripBack6 && flapAfter6 === 0
      && wsRestoredOk6 && autoStill6 && !leakFrames6 && fiveStripsOk6) {
      rep.pass(`P6 最大化收栏：前台真最大化窗 ${fgMs6}ms 落位 → 栏面退场出唤出条（taskbar-retract 存证 + 条带窗在场 + 五组条存证齐 ${stripsEv6 ? stripsEv6.strips.length : 0} 条）`
        + `，收栏态零 appbar 拍动（状态族存证 ${flapEvents6} 条）+ 读回恒含 AUTOHIDE（0x${appbarState()}）+ 工作区底边 ${waRetract6.bottom}/${phys6.height} 恒屏底；`
        + `解除最大化 → retract-lifted（终点 visible=${settledVisible6}，两跳容忍）→ 条带复现（覆盖式常驻）`
        + `，恢复态零拍动（累计 ${flapAfter6} 条）+ 读回仍置位（0x${appbarState()}——M1 无清位目标）+ 工作区 ${waRestored6.bottom} 恒屏底；`
        + `退收栏零可见帧：原生栏 ${hiddenMs6}ms 采样窗零可见拍`);
    } else {
      rep.fail(`P6 收栏存证=${!!retractEv6} 条带在场=${stripAlive6} 五组条=${fiveStripsOk6} 收栏态拍动=${flapEvents6} 工作区=${JSON.stringify(waRetract6)}/屏底=${phys6.height} 读回=0x${appbarState()} `
        + `恢复存证=${!!liftedEv6}（终点visible=${settledVisible6}） 条带复现=${stripBack6} 累计拍动=${flapAfter6} 恢复态工作区=${JSON.stringify(waRestored6)} 读回仍置位=${autoStill6} 零可见帧=${!leakFrames6}（${hiddenMs6}ms）`);
    }

    // —— P7：三态优先级（工单244；工单308 M1 改写）：全屏让位压过收栏；退出全屏回到
    //        最大化窗时收栏态自动回来 ——
    rep.beginSegment('P7');
    // 前置：回到收栏态（最大化参照窗在前台）
    const sinceP7 = Date.now();
    retractWin.maximize();
    await sleep(600);
    forceForeground(hwndOf(retractWin));
    const retractEv7 = await tape.wait('taskbar-retract',
      (e) => e.mode === 'maximize-retract', { since: sinceP7, timeoutMs: 6000 });
    // 全屏让位压过收栏：前台切到全屏参照窗 → 条带整窗退场（唤出条也不出）
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
    // M1：让位态托管恒置位不中断——读回含 AUTOHIDE、工作区恒屏底（旧「占位恢复/清位」
    // 断言随占位链退役：档位迁移零 appbar 写入）
    const autoYield7 = (appbarState() & 0x1) === 1;
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
      (e) => e.mode === 'maximize-retract', { since: t7, timeoutMs: 6000 });
    // 回程收栏态：工作区恒屏底 + 读回恒置位
    const waRetract7 = workArea();
    const priorityOk7 = autoYield7 && !!waYield7 && Math.abs(waYield7.bottom - phys6.height) <= 2
      && !!waRetract7 && Math.abs(waRetract7.bottom - phys6.height) <= 2
      && (appbarState() & 0x1) === 1;
    if (retractEv7 && yieldEv7 && hideMs7 >= 0 && retractInFull7.length === 0
      && retractEv7b && showMs7 >= 0 && priorityOk7) {
      rep.pass(`P7 三态优先级：收栏态在前台全屏窗 ${fgMs7}ms 落位后 ${hideMs7}ms 被全屏让位压过`
        + `（taskbar-yield 存证、条带整窗退场、全屏期间收栏存证 0 条；M1 托管恒置位不中断——读回含 AUTOHIDE、`
        + `工作区底边 ${waYield7.bottom} 恒屏底）；退出全屏回到最大化窗后收栏态自动回来`
        + `（taskbar-retract 再落、条带 ${showMs7}ms 复现、工作区底边 ${waRetract7.bottom} 恒屏底、读回 0x${appbarState()}）`);
    } else {
      rep.fail(`P7 收栏存证=${!!retractEv7} yield存证=${!!yieldEv7} 隐藏时延=${hideMs7}ms 读回恒置位=${autoYield7} `
        + `工作区(让位)=${JSON.stringify(waYield7)} 全屏期间收栏存证=${retractInFull7.length} 条 `
        + `回程收栏存证=${!!retractEv7b} 条带复现=${showMs7}ms 工作区(回程收栏)=${JSON.stringify(waRetract7)} 屏底=${phys6.height} 读回=0x${appbarState()}`);
    }

    // P7 收尾：面板回常驻（解除最大化 + 前台挪开 + 等恢复存证落地）——P5「退场复原」段
    // 要求普通档出发（M1：收栏态退出也复原，但普通档出发让 P5 的基线判读干净）
    const t7end = Date.now();
    retractWin.unmaximize();
    forceForeground(hwndOf(neutralWin));
    let backEv7 = await tape.wait('taskbar-retract-lifted', undefined, { since: t7end, timeoutMs: 5000 });
    if (backEv7 && backEv7.mode !== 'visible') {
      const ylBack7 = await tape.wait('taskbar-yield-lifted', undefined, { since: t7end, timeoutMs: 5000 });
      backEv7 = ylBack7 && ylBack7.mode === 'visible' ? ylBack7 : null;
    }
    if (!backEv7) rep.note('P7 收尾：面板未回常驻（收栏态残留）——P5 的退场复原段将受影响');

    // —— P11：分屏收栏单窗最小闭环（工单269 新增）——
    // 断言面（票面验收判据的真机观测；条件性补齐路径按 #268 定谳不存在——面板零改窗）：
    //   ① 单窗进入：Win+Left 键盘合成（系统通道，#268 探针同款）建立真 Snap（电池侧
    //      IsWindowArranged 直读互证）→ 会话存证 taskbar-snap-session(active=true) +
    //      收栏存证 taskbar-retract（M1 零 appbar 拍动）→ 工作区底边=屏底±2（托管恒置位
    //      保留带双释放，与 P6 同一不变式——分屏收栏复用同一效果层）；
    //   ② 后台事实：前台钉在中性 holder（普通前台切换不打断会话，spec 用户故事 8/9）；
    //   ③ 上下贴边：Snap 窗顶≈屏顶、底≈屏底（Windows 自动重排贴新工作区——工单268
    //      三轮定谳；DWM 7px 不可见边容差同 P6 装饰边口径）；
    //   ④ 唤出：taskbar-summon-strips 存证 + 悬停弹出该组（hotzones 里 summon:pill:*）
    //      且弹出前后 Snap 窗矩形逐字不变（唤出不改窗尺寸）；
    //   ⑤ 解除恢复：Win+Down 解除 → IsWindowArranged=false + 会话存证(active=false) +
    //      taskbar-retract-lifted → 栏面回常驻（覆盖式）、工作区恒屏底（M1：档位迁移零
    //      appbar 写入，工作区不随解除变化）；
    //   ⑥ 伪分屏阴性：SetWindowPos 摆出半屏几何（非 Snap）→ 3+ 轮询拍零收栏存证、
    //      零会话存证、工作区不动（矩形不得成为身份兜底）。
    rep.beginSegment('P11');
    const phys11 = primaryPhys();
    // 出发态：M1 托管期工作区恒整屏——等保留带释放落定再开测（P10 刚重启过 explorer）
    await waitMs(() => {
      const wa = workArea();
      return wa && Math.abs(wa.bottom - phys11.height) <= 2;
    }, 8000);
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
        (e) => e.mode === 'maximize-retract', { since: since11, timeoutMs: 6000 });
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
      // 五组条存证齐（工单242 面随收栏在场；落点只入存证——M1 下条带恒贴屏底，
      // 旧「宿主矩形复核」判据随复核机制特征退役，几何漂移归 keepalive 回正守卫）
      const fiveStripsOk11 = !!stripsEv11 && ['start', 'recs', 'apps', 'right', 'showdesk'].every((g) => stripsEv11.strips.some((s) => s.group === g));
      // ⑤ 解除恢复：Win+Down → 真 Snap 消失 + 会话结束 + 栏面回常驻（零 appbar 写入）
      const tUnsnap11 = Date.now();
      const unsnapped11 = await chordUntil(snapHwnd11, VK_DOWN, false);
      forceForeground(hwndOf(neutralWin));
      const sessionEnd11 = await tape.wait('taskbar-snap-session',
        (e) => e.active === false, { since: tUnsnap11, timeoutMs: 6000 });
      let liftedEv11 = await tape.wait('taskbar-retract-lifted', undefined, { since: tUnsnap11, timeoutMs: 6000 });
      if (liftedEv11 && liftedEv11.mode !== 'visible') {
        const yl11 = await tape.wait('taskbar-yield-lifted', undefined, { since: tUnsnap11, timeoutMs: 6000 });
        liftedEv11 = yl11 && yl11.mode === 'visible' ? yl11 : null;
      }
      const stripBack11 = win32.IsWindowVisible(tbHwnd); // 栏面回常驻（覆盖式承载）
      const waRestored11 = workArea();
      const wsStable11 = !!waRestored11 && Math.abs(waRestored11.bottom - phys11.height) <= 2;
      // ⑥ 伪分屏阴性：同款半屏几何（SetWindowPos，非 Snap）→ 3+ 拍零收栏/零会话、工作区不动
      const fakeAt11 = Date.now();
      win32.SetWindowPos(snapHwnd11, 0, 0, 0, Math.round(phys11.width / 2), phys11.height, 0x0004 /* SWP_NOZORDER */);
      await sleep(900); // 3+ 个 250ms 轮询拍
      const retractAfterFake11 = tape.all('taskbar-retract', undefined, { since: fakeAt11 });
      const sessionAfterFake11 = tape.all('taskbar-snap-session', (e) => e.active === true, { since: fakeAt11 });
      const waFake11 = workArea();
      const fakeRect11 = win32.rectOf(snapHwnd11);
      const negativeOk11 = retractAfterFake11.length === 0 && sessionAfterFake11.length === 0
        && !!waFake11 && Math.abs(waFake11.bottom - phys11.height) <= 2;
      const arrangedFake11 = Boolean(IsWindowArrangedFn(snapHwnd11));
      if (sessionEv11 && retractEv11 && waMs11 >= 0 && edgeMs11 >= 0 && popOk11 && rectStable11
        && unsnapped11 && sessionEnd11 && liftedEv11 && stripBack11 && wsStable11 && negativeOk11 && !arrangedFake11
        && fiveStripsOk11) {
        rep.pass(`P11 分屏收栏单窗闭环：Win+Left 真 Snap（IsWindowArranged 直读互证）→ 会话存证在流 + 收栏档（taskbar-retract，零 appbar 拍动）`
          + `→ 工作区底边 ${waRetract11.bottom}/${phys11.height} = 屏底（±2，${waMs11}ms 到位；前台=中性 holder，后台事实成立）；`
          + `Snap 窗上下贴边 [${snapRect11.top},${snapRect11.bottom}]（自动重排，#${268} 定谳零改窗）；`
          + `唤出条 ${stripInfo11} 悬停弹出（summon:pill 热区声明在流）且 Snap 窗矩形逐字不变、五组条存证齐（${stripsEv11 ? stripsEv11.strips.length : 0} 条）；`
          + `Win+Down 解除 → 会话结束存证 + taskbar-retract-lifted → 栏面回常驻（条带在场）、工作区 ${waRestored11 ? waRestored11.bottom : '?'} 恒屏底；`
          + `伪分屏阴性：同款半屏几何（arranged=${arrangedFake11}）3+ 拍零收栏/零会话存证、工作区 ${waFake11.bottom} 不动（矩形不是身份）`);
      } else {
        rep.fail(`P11 会话存证=${!!sessionEv11} 收栏存证=${!!retractEv11} 工作区到屏底=${waMs11}ms（${waRetract11 && waRetract11.bottom}/${phys11.height}） `
          + `贴边=${edgeMs11}ms（矩形=${JSON.stringify(snapRect11)}） 唤出弹出=${popOk11} 尺寸不变=${rectStable11}（条=${stripInfo11}） 五组条=${fiveStripsOk11} `
          + `解除=${unsnapped11} 会话结束存证=${!!sessionEnd11} 恢复存证=${!!liftedEv11} 条带回场=${stripBack11} 工作区恒屏底=${wsStable11}（${waRestored11 && waRestored11.bottom}） `
          + `伪分屏阴性=${negativeOk11}（几何=${JSON.stringify(fakeRect11)} arranged=${arrangedFake11} 收栏存证=${retractAfterFake11.length} 会话存证=${sessionAfterFake11.length} 工作区=${waFake11 && waFake11.bottom}）`);
      }
    }
    }
    // P11 收尾：Win+Down 已解除；参照窗由 FormClosed/Exit 退出，进程兜底强杀在 finally
    if (snapHwnd11) win32.PostMessageW(snapHwnd11, WM_CLOSE, 0, 0);

    // —— P12/P13 公共器具（工单270；工单308 M1 随动）——
    const phys12 = primaryPhys();
    // M1：托管期工作区恒整屏（保留带恒释放）——工作区判据只剩「屏底」一档；旧
    // 「回一栏高」判据（wsBarOk12）随占位链退役，「栏面回常驻」改由 retract-lifted
    // 存证 + 条带在场判读（档位迁移不写工作区）。
    const wsBottomOk12 = () => { const wa = workArea(); return !!wa && Math.abs(wa.bottom - phys12.height) <= 2; };
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
    await waitMs(wsBottomOk12, 8000); // 出发态：M1 托管期工作区恒整屏（P11 收尾已在常驻档）
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
      (e) => e.mode === 'maximize-retract', { since: sinceDual, timeoutMs: 6000 });
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
    const unLiftEv12 = await tape.wait('taskbar-retract-lifted', undefined, { since: tUnsnapA, timeoutMs: 6000 });
    const unWa12 = await waitMs(wsBottomOk12, 5000); // M1：工作区恒屏底（「复原」是栏面语义，工作区不动）
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
    const minLiftEv12 = await tape.wait('taskbar-retract-lifted', undefined, { since: tMin2, timeoutMs: 6000 });
    const minWa12 = await waitMs(wsBottomOk12, 5000); // M1：工作区恒屏底
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
      // 结束——残留成员会把会话拖住，P13/P5/P9/P10 全被翻
      // B 相收尾（R2/R3 定谳加固）：关宿主**核验退场**（残留即强杀）→ 清扫外来 Snap
      // （Win+Z Assist 可能已把无关窗口 Snap 进位，磁带 members=3 实证）→ 会话必须
      // 结束——M1 下工作区不随会话结束变化，「收尾干净」改判会话结束存证（成员残留会
      // 拖住会话，翻掉 P13/P5/P9/P10）
      const tCloseB = Date.now();
      await closeSnapHosts(b1, b2);
      const aliensB = await sweepAlienSnaps();
      const bCleanEnd = await waitMs(() => tape.all('taskbar-snap-session',
        (e) => e.active === false, { since: tCloseB }).length > 0, 5000);
      r12.bClean = bCleanEnd >= 0 && wsBottomOk12();
      if (!r12.bClean) diag12.push(`B收尾=${r12.bClean}（外来清扫=${aliensB} 关宿主后会话未结束=${bCleanEnd < 0}——成员残留）`);
    }
    if (r12.dual && r12.fgStable && r12.minOne && r12.minLast && r12.rebuild && r12.unsnapEnd && r12.thirds && r12.bClean) {
      rep.pass(`P12 分屏会话集合生命周期与代表性布局：左右双窗统一进分屏收栏（会话+收栏存证在流、工作区恒屏底、两窗上下贴边）；`
        + `普通前台轮换 5+ 拍零会话结束/零复原、Snap 窗矩形逐字不变；`
        + `拖拽真解除其一仍维持、最后一个解除结束（cause=unsnapped）→ 栏面回常驻；重 Snap 后最小化其一仍维持（a1 矩形不变）、`
        + `最后一个最小化结束（cause=minimized）→ 栏面回常驻；恢复即按当前事实重建；`
        + `1/3+2/3 布局经同一判定收栏贴边（${thirdsDetail}）；收尾关宿主后会话结束（M1：工作区恒屏底不随会话变化）`);
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
    await waitMs(wsBottomOk12, 5000);
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
      const dkWa13 = await waitMs(wsBottomOk12, 6000); // M1：工作区恒屏底（会话结束不改工作区）
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
      const liftEv13 = await tape.wait('taskbar-retract-lifted', undefined, { since: tUnmax13, timeoutMs: 6000 });
      const liftWa13 = await waitMs(wsBottomOk12, 5000); // M1：工作区恒屏底
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
    await waitMs(wsBottomOk12, 5000);
    }

    // —— P14：全屏让位与分屏会话解耦（工单271 新增；工单308 M1 改写）——
    // 断言面（票面验收判据的真机观测；M1 证据族随**栏面**收敛——覆盖进出的栏面迁移各落
    // 一条存证，「解耦」不变式改钉 appbar 零拍动 + 工作区恒屏底 + Snap 矩形不变；旧
    // 「零 retract 族」是工作区面证据，随工作区面退役）：
    //   ① 分屏后台建立：Snap 参照窗（powershell WinForms，P11 同款）→ 会话存证 + 收栏
    //      （工作区屏底、上下贴边）；
    //   ② 全屏进入：前台全屏参照窗 → 整条栏隐藏（唤出条也不出）+ taskbar-yield 且
    //      retract-lifted 恰一条（栏面离收栏）+ 全程 appbar 零拍动（托管恒置位不中断）
    //      + 工作区保持屏底（覆盖期 5+ 拍观察窗首尾一致）+ 后台 Snap 窗矩形逐字不变；
    //   ②′ 覆盖期间会话仍存续的退出全屏（票面判据 3 前半，工单271 评审收口）：yield-lifted
    //      + retract 再落恰一条（栏面回收栏档）、零 retract-lifted（未离收栏）、零 appbar
    //      拍动、条带窗回场（分屏收栏唤出条直接回归）、工作区保持屏底、Snap 窗矩形不变；
    //      随后重进全屏接 ③；
    //   ③ 覆盖期间结束会话：关 Snap 宿主 → taskbar-snap-session(active=false) + 零新生
    //      栏面存证（档位冻结让位）+ 工作区仍屏底；
    //   ④ 退出全屏（会话已结束、无其他收栏理由）→ 恢复常驻：yield-lifted + 条带复现
    //      （栏面 yield→visible，无 retract-lifted）+ 工作区恒屏底 + 零拍动；
    //   ⑤ 最大化临时覆盖：重建分屏会话 → 真最大化参照窗抢前台 → 分屏收栏保持（零新
    //      retract/零 yield——zoomed 与会话同档幂等）+ 条带窗在场（栏窗复用）+ 工作区
    //      屏底 + Snap 窗矩形不变；解除最大化 → 分屏收栏直接恢复（零 lift——不先复原
    //      再收栏）；收尾清场（残留成员会拖住会话翻 P5/P9/P10）。
    rep.beginSegment('P14');
    await waitMs(wsBottomOk12, 5000);
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
        // M1 解耦判据（工单308 改段）：证据族随**栏面**收敛——覆盖进出 retract↔yield 的栏面
        // 迁移各落一条存证（retract-lifted/yield 进、yield-lifted/retract 出）；解耦不变式
        // 改钉 **appbar 零拍动 + 工作区恒屏底 + Snap 矩形不变**（旧「零 retract 族」是工作区
        // 面证据，随工作区面退役）。
        const yieldEv14 = await tape.wait('taskbar-yield',
          (e) => e.mode === 'fullscreen-yield', { since: sinceFs14, timeoutMs: 5000 });
        await sleep(1300); // 5+ 个 250ms 轮询拍：覆盖期工作区稳定性观察窗
        const flapCount14 = (since) => tape.all('taskbar-autohide-set', undefined, { since }).length
          + tape.all('taskbar-autohide-set-failed', undefined, { since }).length
          + tape.all('taskbar-autohide-reattached', undefined, { since }).length
          + tape.all('taskbar-autohide-reattach-failed', undefined, { since }).length;
        const liftInFs14 = tape.all('taskbar-retract-lifted', undefined, { since: sinceFs14 }).length;
        const waCover14 = workArea();
        const rectCover14 = win32.rectOf(s14a.hwnd);
        const coverOk14 = fgMs14 >= 0 && hideMs14 >= 0 && !!yieldEv14
          && !!waCover14 && Math.abs(waCover14.bottom - phys12.height) <= 2
          && sameRect12(rectCover14, rectBg14);
        // ②′ 覆盖期间会话仍存续的退出全屏（票面判据 3 前半，工单271 评审收口；M1 栏面语义）：
        //     分屏收栏唤出条直接回归——yield-lifted + retract 再落恰一条（栏面回收栏档）、零
        //     retract-lifted（未离收栏）、零 appbar 拍动、条带窗回场、工作区保持屏底、Snap
        //     窗矩形不变；随后重进全屏接 ③。retract 再落用等待式断言（计数窗会漏拍：探针
        //     失败拍按「无会话」全交割把栏面先收 visible、会话重建后才落 retract——工单271
        //     在案取舍的单拍交割语义，等待窗覆盖到重建拍）。
        const tExit14 = Date.now();
        fsWin14.destroy();
        refWins.pop();
        forceForeground(hwndOf(neutralWin));
        const ylExit14 = await tape.wait('taskbar-yield-lifted', undefined, { since: tExit14, timeoutMs: 5000 });
        const reEntryEv14 = await tape.wait('taskbar-retract', undefined, { since: tExit14, timeoutMs: 8000 });
        const liftExit14 = tape.all('taskbar-retract-lifted', undefined, { since: tExit14 }).length;
        const waExit14 = workArea();
        const rectExit14 = win32.rectOf(s14a.hwnd);
        const barBack14 = win32.IsWindowVisible(tbHwnd); // 收栏态条带窗回场（栏窗复用承载唤出条）
        r14.exitAlive = !!ylExit14 && !!reEntryEv14 && liftExit14 === 0 && flapCount14(tExit14) === 0
          && barBack14 && !!waExit14 && Math.abs(waExit14.bottom - phys12.height) <= 2
          && sameRect12(rectExit14, rectCover14);
        if (!r14.exitAlive) diag14.push(`覆盖期存续退出=${r14.exitAlive}（yield-lifted=${!!ylExit14} retract再落=${!!reEntryEv14} retract-lifted=${liftExit14} 拍动=${flapCount14(tExit14)} 条带回场=${barBack14} 工作区=${waExit14 && waExit14.bottom}/${phys12.height} Snap矩形不变=${sameRect12(rectExit14, rectCover14)}）`);
        // ③ 重进全屏（覆盖重新压上——会话仍存续；复验解耦的进入侧幂等）
        const fsWin14b = new BrowserWindow({ fullscreen: true, frame: false, title: 'DECK-ACCEPT-FS14B', backgroundColor: '#101820' });
        refWins.push(fsWin14b);
        await fsWin14b.loadURL('about:blank');
        fsWin14b.show();
        fsWin14b.focus();
        forceForeground(hwndOf(fsWin14b));
        const fgRe14 = await waitMs(() => Number(win32.GetForegroundWindow()) === hwndOf(fsWin14b), 4000);
        const hideRe14 = await waitMs(() => !win32.IsWindowVisible(tbHwnd), 5000);
        const yieldRe14 = await tape.wait('taskbar-yield',
          (e) => e.mode === 'fullscreen-yield', { since: tExit14, timeoutMs: 8000 });
        if (!(fgRe14 >= 0 && hideRe14 >= 0 && !!yieldRe14)) {
          diag14.push(`③ 重进全屏未成立（前台=${fgRe14}ms 隐藏=${hideRe14}ms yield=${!!yieldRe14}）——③④ 判读作废`);
        }
        // ③ 覆盖期间结束会话（关宿主核验退场——残留成员会把会话拖住，R2 定谳纪律）。
        // 时间门在重进全屏的栏面迁移落定之后（yield 观察到即 retract-lifted 已同批落盘）：
        // 只计「结束会话拍」的新生存证。
        const tCover3_14 = Date.now();
        await closeSnapHosts(s14a);
        const endEv14 = await tape.wait('taskbar-snap-session',
          (e) => e.active === false, { since: sinceFs14, timeoutMs: 6000 });
        const liftOnEnd14 = tape.all('taskbar-retract-lifted', undefined, { since: tCover3_14 }).length;
        const waEndCover14 = workArea();
        r14.cover = coverOk14 && liftInFs14 === 1 && flapCount14(sinceFs14) === 0;
        r14.endInCover = !!endEv14 && liftOnEnd14 === 0
          && !!waEndCover14 && Math.abs(waEndCover14.bottom - phys12.height) <= 2;
        if (!r14.cover) diag14.push(`覆盖=${r14.cover}（前台=${fgMs14}ms 隐藏=${hideMs14}ms yield=${!!yieldEv14} 覆盖期lift=${liftInFs14}（M1 期望恰 1——栏面离收栏） 拍动=${flapCount14(sinceFs14)} 工作区=${waCover14 && waCover14.bottom}/${phys12.height} Snap矩形不变=${sameRect12(rectCover14, rectBg14)}）`);
        if (!r14.endInCover) diag14.push(`覆盖期结束=${r14.endInCover}（结束存证=${!!endEv14} 结束拍lift=${liftOnEnd14} 工作区=${waEndCover14 && waEndCover14.bottom}/${phys12.height}）`);
        // ④ 退出全屏 → 恢复常驻（会话已结束、无其他收栏理由；M1：栏面 yield→visible，
        // 证据只有 yield-lifted——栏面从未在收栏档，无 retract-lifted）
        const tLift14 = Date.now();
        fsWin14b.destroy();
        refWins.pop();
        forceForeground(hwndOf(neutralWin));
        const ylEv14 = await tape.wait('taskbar-yield-lifted', undefined, { since: tLift14, timeoutMs: 5000 });
        const stripBack14 = win32.IsWindowVisible(tbHwnd); // 覆盖式常驻：条带复现
        const waRest14 = await waitMs(wsBottomOk12, 6000); // M1：工作区恒屏底
        r14.restoreAfter = !!ylEv14 && stripBack14 && waRest14 >= 0 && flapCount14(tLift14) === 0;
        if (!r14.restoreAfter) diag14.push(`退出恢复=${r14.restoreAfter}（yield-lifted=${!!ylEv14} 条带复现=${stripBack14} 工作区=${waRest14}ms 拍动=${flapCount14(tLift14)}）`);
      }
      // E1 收尾（无论②③④成败——残留成员会把会话拖住污染⑤与 P5/P9/P10，R2 定谳纪律）：
      // 关宿主核验退场 → 清扫外来 Snap → 等会话结束、工作区复原（⑤的出发态必须干净）
      await closeSnapHosts(s14a);
      await sweepAlienSnaps();
      const preWa14b = await waitMs(wsBottomOk12, 5000);
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
        await waitMs(wsBottomOk12, 5000); // P5 出发态：会话结束、工作区恒屏底到位
      }
    }
    if (r14.bgSession && r14.cover && r14.exitAlive && r14.endInCover && r14.restoreAfter && r14.maxCover) {
      rep.pass(`P14 全屏让位与分屏会话解耦：分屏后台收栏（会话存证在流、工作区恒屏底）；全屏进入整条栏隐藏且 taskbar-yield（M1 证据族随栏面：覆盖进落 retract-lifted+yield 各一条）`
        + `、全程 appbar 零拍动（托管恒置位不中断）、工作区恒屏底、后台 Snap 窗矩形逐字不变；`
        + `覆盖期间会话存续的退出全屏 → yield-lifted + retract 再落恰一条（栏面回收栏档、零 retract-lifted、零拍动）、分屏收栏唤出条直接回归（条带回场、工作区仍屏底、Snap 矩形不变），重进全屏幂等；`
        + `覆盖期间结束会话（active=false）零新生存证、工作区仍屏底（理由消失不当场翻栏面）；`
        + `退出全屏恢复常驻（yield-lifted、条带复现、工作区恒屏底、零拍动）；`
        + `最大化临时覆盖不结束分屏会话（零新存证、条带在场、工作区屏底、Snap 矩形不变），解除后分屏收栏直接恢复（幂等零迁移）`);
    } else {
      rep.fail(`P14 解耦未全绿：${JSON.stringify(r14)}；${diag14.join('；')}`);
    }

    // —— P5：退场复原（工单308 M1 改写：面板正常退出 → 用户原值写回 + 工作区归还基线）——
    rep.beginSegment('P5');
    const sinceP5 = Date.now();
    const panelHwnd = await handle.waitWindow({ title: PANEL_TITLE, timeoutMs: 8000 });
    if (!panelHwnd) throw new Error('P5 面板主窗未找到');
    win32.PostMessageW(panelHwnd, WM_CLOSE, 0, 0);
    // 复原存证（还原路径① dispose 径）+ 三复原判读（控制器独立读数）：appbar 读回=开跑前
    // 原值、工作区归还基线（原生任务栏还原后自身占底边一档，不是满屏）、原生栏可见
    const restoredEv5 = await tape.wait('taskbar-autohide-restored',
      (e) => e.reason === 'dispose', { since: sinceP5, timeoutMs: 8000 });
    const stateOk5 = await waitMs(() => appbarState() === userStateOriginal, 8000);
    const restoreMs = await waitMs(() => {
      const wa = workArea();
      return wa && Math.abs(wa.bottom - waBaseline.bottom) <= 2 && Math.abs(wa.top - waBaseline.top) <= 2;
    }, 8000);
    const nativeOk5 = await waitMs(() => nativeTaskbarVisible(), 8000);
    const waEnd = workArea();
    if (restoredEv5 && stateOk5 >= 0 && restoreMs >= 0 && nativeOk5 >= 0) {
      rep.pass(`P5 退场复原：面板退出 → taskbar-autohide-restored reason=dispose（attempts=${restoredEv5.attempts}，路径①）`
        + `，appbar 读回 ${appbarState()} = 开跑前原值 ${userStateOriginal}（${stateOk5}ms）、工作区归还基线（底边 ${waEnd.bottom}/基线 ${waBaseline.bottom}，${restoreMs}ms）、原生栏可见`);
    } else {
      rep.fail(`P5 复原存证=${JSON.stringify(restoredEv5)} 读回复原=${stateOk5}ms（现值 ${appbarState()}/原值 ${userStateOriginal}） 归还时延=${restoreMs}ms 工作区=${JSON.stringify(waEnd)} 基线=${JSON.stringify(waBaseline)} 原生可见=${nativeOk5 >= 0}`);
    }

    // —— P9：收栏态退出双复原（工单260；工单293 扩「普通态也不复活」；工单308 M1 改写）——
    // P5 验的是常驻态退出的复原；本段验收收标准「面板正常退出 → 双复原」的收栏态形态 +
    // 普通档形态（臂 B）。判读注意（R1 取证）：置位态 explorer 翻开 Shell_TrayWnd 的
    // WS_VISIBLE 位（「窗口显示位」≠「视觉在场」，spike 附记），面板侧 showNativeTaskbar
    // 会走「已可见静默」不发 taskbar-restored——可见性以退出后的控制器独立视图事实为准。
    // 原值必须在**接管建立前**读（state9 前移到发射之前）——M1 起接管后的读回是置位目标，
    // 不再是用户原值；「复原为原值」的「原」自接管建立那一刻固定。
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
    // 收栏档成立（M1：收栏拍零 appbar 写入——置位只在接管建立，本臂不再等 set 存证）
    const retractEv9 = await tape.wait('taskbar-retract',
      (e) => e.mode === 'maximize-retract', { since: sinceP9, timeoutMs: 6000 });
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
    if (retractEv9 && retractWa9 >= 0 && restoredEv9 && stateOk9 >= 0 && waOk9 >= 0 && nativeOk9 >= 0) {
      rep.pass(`P9 收栏态退出双复原：收栏档成立（taskbar-retract 存证、工作区到屏底 ${phys6.height}——收栏拍零 appbar 写入，M1）；`
        + `收栏态 WM_CLOSE 退出 → taskbar-autohide-restored reason=dispose（attempts=${restoredEv9.attempts}，路径①）；`
        + `控制器独立读数三复原：appbar 状态回 ${appbarState()}（出发 ${state9}）、工作区回基线 ${waBaseline.bottom}、原生栏可见`);
    } else {
      rep.fail(`P9 收栏存证=${!!retractEv9} 到屏底=${retractWa9}ms 复原存证=${JSON.stringify(restoredEv9)} `
        + `状态复原=${stateOk9}ms 工作区复原=${waOk9}ms 原生可见=${nativeOk9 >= 0} 状态现值=${appbarState()}/${state9} 工作区基线=${waBaseline.bottom}`);
    }

    // —— P9 臂 B（工单293 扩「普通态也不复活」；工单308 M1 置位口径改写）：普通档退出同径双复原 ——
    // M1 起接管即**置位**（无清位动作）。本臂重拉面板**不进收栏**（普通档）：① 接管建立
    // 记账落盘（takeover userState=state9）+ 置位存证（set——对未开自动隐藏的原值是有动作
    // 的写，对已开是无操作写入，两形态同落 set）+ 读回含 AUTOHIDE 位；② 静置原生栏不复活
    // （3s 观察窗保持不可见——SW_HIDE + 置位态唤出 0 帧，t257 spike）；③ WM_CLOSE 退出 →
    // taskbar-autohide-restored reason=dispose + appbar 状态复原为**接管前原值**（state9）
    // + 落盘账清（复原义务履行完毕不留陈旧账）+ 原生栏可见。
    handle.launch({ mode: 'accept', stdio: 'ignore' });
    const bootEv9b = await tape.wait('boot', null, { timeoutMs: 20000 });
    if (!bootEv9b) throw new Error('P9b 面板未上报 boot');
    panelPid = bootEv9b.pid;
    if (!(await handle.waitWindow({ title: TASKBAR_TITLE, timeoutMs: 12000 }))) throw new Error('P9b 条带窗未出现');
    forceForeground(hwndOf(neutralWin)); // 普通档出发（不进收栏）
    const since9b = bootEv9b.t;
    const takeEv9b = await tape.wait('taskbar-autohide-takeover', (e) => e.userState === state9, { since: since9b, timeoutMs: 8000 });
    const setEv9b = await tape.wait('taskbar-autohide-set', undefined, { since: since9b, timeoutMs: 5000 });
    const setRead9b = await waitMs(() => (appbarState() & 0x1) === 1, 5000);
    const stateAtRead9b = appbarState(); // 读回落定拍的状态快照（pass 消息用——退出复原后 appbarState() 已回原值）
    // 静置不复活：普通档下原生栏 3s 观察窗保持不可见（无人唤出——SW_HIDE + 置位的禁现面）
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
    if (takeEv9b && setEv9b && setRead9b >= 0 && stayedHidden9b && restoredEv9b && stateOk9b >= 0
      && ledgerGone9b >= 0 && nativeOk9b >= 0) {
      rep.pass(`P9b 普通档退出双复原（工单293 扩臂；M1 置位口径）：接管建立记账（takeover userState=${takeEv9b.userState}）+ 置位存证（set）`
        + `+ 读回含 AUTOHIDE（0x${stateAtRead9b}，${setRead9b}ms 落定——M1 接管即置位，无清位动作）；静置 3s 原生栏不复活；`
        + `WM_CLOSE 退出 → restored reason=dispose（attempts=${restoredEv9b.attempts}）+ appbar 读回复原 ${appbarState()}（接管前原值 ${state9}）`
        + `+ 落盘账清 + 原生栏可见`);
    } else {
      rep.fail(`P9b 接管存证=${JSON.stringify(takeEv9b)} 置位存证=${!!setEv9b} 读回含AUTOHIDE=${setRead9b}ms（现值 0x${appbarState()}） 静置不复活=${stayedHidden9b} `
        + `复原存证=${JSON.stringify(restoredEv9b)} 状态复原=${stateOk9b}ms（现值 ${appbarState()}/原值 ${state9}） `
        + `落盘账清=${ledgerGone9b >= 0} 原生可见=${nativeOk9b >= 0}`);
    }

    // —— P10：全接管期原生栏重申轮询（工单262；工单293 判据改段；工单308 M1 改写——
    //        目标态恒置位，段位垫底——explorer 重启断基线）：explorer 重启 → 轮询重挂 ——
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
    //      重挂。⚠️ R1 实测：新起 explorer 约 15s 内不接受 ABM_SETSTATE（轮询逐拍重试
    //      全部落 failed，过了接受窗一发即中）——隐藏按「及时」断言（≤4s，重挂的隐藏动作
    //      只走 user32 不等 shell），置位按「终态」断言（≤40s 内 AUTOHIDE 位在场 + 工作
    //      区回屏底；工单293 界 25s→40s 校准，轮询逐拍重试语义不变）；
    //   拍 C 普通档仍值守（工单293 改段；工单308 M1——目标恒置位）：退收栏（普通档、仍
    //      接管）后翻开原生栏 → 1s 拍内 reason=visible 重申 + 压回不可见（M1 无「清位
    //      落定」前置——托管期目标态唯一）。
    rep.beginSegment('P10');
    // 拍间状态（拍 B → 拍 C 级联判读用）：explorer 接受窗尾部是否在拍 B 窗口内到场
    // （EXENV 排除时点——尾部未闭合则拍 C 的置位读回结构上不可达，同因环境降责）。
    const p10Beat = { tailAt: 0 };
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
      (e) => e.mode === 'maximize-retract', { since: sinceP10, timeoutMs: 6000 });
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
          // 置位界内未到场：三分辨——①面板义务面（重申逐拍不断流）缺 ⇒ 真回归候；
          // ②shell 接受窗尾部（义务面全真而 ABM 不被接受）⇒ 环境降责账；③重启搅动打掉
          // 夹具（参照窗最大化态丢失且补不回）⇒ 电池夹具账——面板对观察事实（前台非最大化）
          // 判 visible 档是既定裁决的正确行为（工单293 R5 实证：错的是电池夹具不是面板）。
          // M1（工单308）：档位迁移零 appbar 写入、无降级档——旧「降级级联」排除径随占位链
          // 退役，重申义务面只剩连流计数。
          const pressesB = tape.all('taskbar-autohide-reattach-failed', undefined, { since: tKill });
          if (pressesB.length >= 15) {
            p10Beat.tailAt = Date.now();
            rep.exclude(`P10b 置位界内未到场（>40s）：新 shell AppBar 接受窗尾部超界（explorer-acceptance-tail）——面板义务面全真：`
              + `重申逐拍重试 ${pressesB.length} 拍无一缺席（reattach-failed 连流，M1 恒置位目标）、reason=rebuild 重申存证在流、重挂隐藏 ${hideLatencyB}ms（≤4s）、压回不可见（${hiddenB}ms）。`
              + `五轮对照接受时延：R2 <12s / R1 >52s / R4 66s——尾部为 shell 侧事实（本机负载相关），不判面板回归`,
              'explorer 重启后 ABM 接受窗尾部超 40s 界（shell 侧，接受时延 52–66s 观测）', 'explorer-acceptance-tail');
          } else if (!retractWin.isMaximized() || Number(win32.GetForegroundWindow()) !== hwndOf(retractWin)) {
            // 夹具账细判：最大化态丢失，或 40s 逐拍钉前台都没能把参照窗钉回前台——两者都是
            // 重启搅动打掉电池参照物（restart-chaos-fixture）；参照物既不稳，面板的档位输入
            // 就不是「前台真最大化」，判 visible 档是既定裁决的正确行为。
            rep.exclude(`P10b 置位界内未到场：explorer 重启搅动打掉电池夹具（restart-chaos-fixture）——参照窗最大化态${retractWin.isMaximized() ? '在场' : '丢失且补不回'}（修复尝试 ${fixtureRepairedB} 次）、`
              + `窗末前台=${Number(win32.GetForegroundWindow()) === hwndOf(retractWin) ? '参照窗' : '他窗（钉前台 40s 未夺回）'}、`
              + `重申重试拍数=${pressesB.length}（系列见磁带）。面板对「前台非最大化」按既定裁决处理（visible 档），`
              + `重启窗口内的夹具失稳是电池参照物问题，不判面板回归；重挂隐藏 ${hideLatencyB}ms（≤4s）与 rebuild 重申存证两项面板义务仍真`,
              'explorer 重启搅动致参照窗最大化态丢失/前台钉不住（restart-chaos-fixture）', 'restart-chaos-fixture');
          } else {
            rep.fail(`P10b 置位界内未到场且面板义务面有缺：重申重试拍数=${pressesB.length}（要求 ≥15） `
              + `rebuild重申=${!!reassertB} 重挂隐藏=${hideEvB ? `${hideLatencyB}ms` : '缺'} 不可见=${hiddenB >= 0}ms（state=${stateB}）——真回归候`);
          }
        } else {
          rep.fail(`P10b rebuild重申=${!!reassertB} 重挂隐藏=${hideEvB ? `${hideLatencyB}ms` : '缺'} 不可见=${hiddenB >= 0}ms `
            + `置位终态=${stateMsB}ms（state=${stateB}） 工作区=${waB >= 0 ? `${waB}ms` : '未到'}（现值 ${workArea() && workArea().bottom}/${phys6.height}） `
            + `新窗=${hwndAfter} 归位=${firstSeenAt - tKill}ms 自起兜底=${spawnedExplorer}`);
        }
      }

      // —— 拍 C：普通档仍值守（工单293 改段；工单308 M1——目标态恒置位，无「清位落定」前置）——
      const tLift = Date.now();
      retractWin.unmaximize();
      forceForeground(hwndOf(neutralWin));
      let lifted10 = await tape.wait('taskbar-retract-lifted', undefined, { since: tLift, timeoutMs: 8000 });
      if (lifted10 && lifted10.mode !== 'visible') {
        const yl10 = await tape.wait('taskbar-yield-lifted', undefined, { since: tLift, timeoutMs: 8000 });
        lifted10 = yl10 && yl10.mode === 'visible' ? yl10 : null;
      }
      if (!lifted10) {
        rep.fail('P10c 前置失败：退收栏未成立（收栏态残留——见磁带 retract 族存证）');
      } else {
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
          // 普通档目标落定：M1 恒置位——读回仍含 AUTOHIDE 位（旧「清位落定」前置随清位退役）。
          // 环境级联辨（工单308 首轮实证）：拍 B 的 explorer AppBar 接受窗尾部未闭合时，
          // 新 shell 仍不接受 ABM_SETSTATE——恒置位读回在结构上不可达（重申命中+压回两项
          // 义务面全真），同因环境降责不判面板。
          const autoOnC = await waitMs(() => (appbarState() & 0x1) === 1, 4000);
          const tailOpen = p10Beat.tailAt > 0
            && tape.all('taskbar-autohide-reattach-failed', undefined, { since: p10Beat.tailAt - 1000 }).length > 0;
          if (reassertC && hiddenC >= 0 && latencyC <= 2500 && autoOnC >= 0) {
            rep.pass(`P10c 普通档仍值守（全接管期）：退收栏落定（读回恒含 AUTOHIDE 位 ${autoOnC}ms——M1 目标态唯一）后翻开原生栏，`
              + `${latencyC}ms 重申命中（reason=visible）→ 压回不可见（${hiddenC}ms 到位）`
              + '——值守覆盖全接管期（起表随接管建立、停表随拆场），目标态恒置位');
          } else if (reassertC && hiddenC >= 0 && latencyC <= 2500 && autoOnC < 0 && tailOpen) {
            rep.exclude(`P10c 恒置位读回未到场：拍 B 的 explorer AppBar 接受窗尾部未闭合（explorer-acceptance-tail 级联）——新 shell 仍不接受 ABM_SETSTATE，置位读回结构上不可达；`
              + `面板义务面全真：翻开原生栏后 ${latencyC}ms 重申命中（reason=visible）→ 压回不可见（${hiddenC}ms 到位）——同因环境降责不判面板`,
              '接受窗尾部未闭合致置位读回不可达（explorer-acceptance-tail 级联）', 'explorer-acceptance-tail');
          } else {
            rep.fail(`P10c 恒置位读回=${autoOnC}ms（现值 0x${appbarState()}，尾部级联在案=${tailOpen}） 重申存证=${!!reassertC}（时延=${latencyC}ms） 压回不可见=${hiddenC >= 0 ? `${hiddenC}ms` : '未到'}`);
          }
        }
      }

    // —— P15：受控原值下的接管置位与三路径禁现（工单293 新增；工单308 M1 改写，spec #306）——
    // 断言面（票面验收判据的真机观测；纯逻辑面已由单测钉住——恒置位目标纯函数、轮询
    // 决策、单账纪律；本段验 FFI 效果面与用户可见结果，章法增段三条件之 1/2）：
    //   ① 受控原值（自动隐藏置 ON）下重拉面板：接管建立即记账落盘（taskbar-autohide-takeover
    //      userState=受控原值）+ 置位（taskbar-autohide-set + 读回含 AUTOHIDE 位）——M1 下
    //      接管即置位，对本已开自动隐藏的受控原值是**无操作写入**（结果不变、记账与复原
    //      照走、不特判），落盘账是崩溃后守卫/守护的复原目标（账在盘上由断言 ⑤ 的「账清」
    //      反证其在场纪律）；
    //   ② 底边悬停 3.5s 无可见帧（AC 5 路径一）：SW_HIDE + 置位态唤出 0 帧不闪现（t257
    //      spike 实证），显示位翻转归 1s 值守压回；
    //   ③ Win 键无可见帧（AC 5 路径二）：同上——两路径均以控制器独立视图事实采样；
    //   ④ 通知路径证据单列不作断言（AC 5 路径三——工单292 F3 探针轮在证，审计
    //      docs/audit/2026-10-26-spec292-notification-center-path.md；环境稳定性风险探针留痕）；
    //   ⑤ 禁用任务栏（CDP 驱动真实渲染层 taskbar/set-enabled）→ taskbar-autohide-restored
    //      reason=disabled + appbar 读回=接管前原值（AC 6）+ 落盘账清 + 原生栏可见位还原。
    // 判读口径：「可见帧」= Shell_TrayWnd 的 IsWindowVisible 显示位（「显示位 ≠ 视觉在场」
    // 既有口径；托管期显示位不该被任何唤出通路翻开——翻开也由值守压回）。收尾把 appbar
    // 状态还原为全电池出发值（userStateOriginal）——中途实验扰动不留给用户。
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
      // ① 接管建立记账 + 置位（M1：对本已开自动隐藏的受控原值是无操作写入——结果不变、记账照走）
      const takeEv15 = await tape.wait('taskbar-autohide-takeover',
        (e) => e.userState === user15, { since: since15, timeoutMs: 8000 });
      const setEv15 = await tape.wait('taskbar-autohide-set',
        undefined, { since: since15, timeoutMs: 5000 });
      const setRead15 = await waitMs(() => (appbarState() & 0x1) === 1, 5000);
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
      // ④ 通知路径：证据单列（工单292 F3 探针轮在证——接管+清位在场下 Win+N 开通知中心、
      //    150ms 采样原生栏零可见帧）；本段仍不作该路径的断言——通知中心 UI 自动化有环境
      //    稳定性风险（探针四轮迭代留痕），spec 只要证据单列不要断言段
      rep.note('P15 通知路径：证据单列 docs/audit/2026-10-26-spec292-notification-center-path.md（工单292 F3 探针轮：面板接管+清位在场下 Win+N 开通知中心、150ms 采样原生栏零可见帧；本段仍不作该路径的阳性/阴性断言——通知中心 UI 自动化有环境稳定性风险）');
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
      if (takeEv15 && setEv15 && setRead15 >= 0 && ledgerOn15 && !hoverLeak15 && !winLeak15
        && restoredEv15 && backOk15 >= 0 && ledgerGone15 >= 0 && trayOk15 >= 0) {
        rep.pass(`P15 受控原值下的接管置位与三路径禁现：受控原值 0x${user15}（自动隐藏 ON）下接管建立记账（takeover userState=${takeEv15.userState}，账在盘=${ledgerOn15}）`
          + `+ 置位生效（set 存证、读回 0x${appbarState()} 含 AUTOHIDE、${setRead15}ms 落定——M1 接管即置位，对已开用户是无操作写入）；`
          + `底边悬停 ${hoverMs15}ms 全窗零可见帧、Win 键 ${winMs15}ms 零可见帧（SW_HIDE + 置位态唤出 0 帧，t257 spike；通知路径证据单列：docs/audit/2026-10-26-spec292-notification-center-path.md）；`
          + `禁用任务栏 → restored reason=disabled（attempts=${restoredEv15.attempts}）+ appbar 读回复原 0x${user15}（${backOk15}ms）`
          + `+ 落盘账清 + 原生栏还原在场（${trayOk15}ms；显示位=${win32.nativeTaskbarVisible()}——AUTOHIDE 原值下 explorer 停靠位自主）`);
      } else {
        rep.fail(`P15 接管存证=${JSON.stringify(takeEv15)} 置位存证=${!!setEv15} 读回含AUTOHIDE=${setRead15}ms 账在盘=${ledgerOn15} `
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

    // —— P16：覆盖式主诉专项段（工单308 新增，spec #306 主诉场景；一段绑定一工单）——
    // 断言面（主诉复现链的真机观测）：
    //   ① 出发：面板接管在场（置位恒在）、后台真最大化参照窗（铺到屏底）、中性 holder
    //      占前台——采样最大化窗矩形基线；
    //   ② 夺前台：普通窗开立并夺前台（主诉触发动作）→ 3s 观察窗逐 250ms 采样：
    //      appbar 读回恒含 AUTOHIDE、最大化窗矩形逐点不变、条带覆盖常驻屏底；
    //   ③ 零拍动：takeover/set 之外状态族存证零条（运行期任何档位迁移不写 appbar 状态）；
    //   ④ 档位循环不改尺寸：前台切最大化窗 → 收栏档（taskbar-retract）→ 切回普通窗 →
    //      栏回常驻（retract-lifted）→ 最大化窗矩形仍与基线逐字一致。
    rep.beginSegment('P16');
    {
      const phys16 = primaryPhys();
      // 面板复用 P15 的 CDP 通道重开接管（P15 尾面板在场、任务栏禁用态）——禁用径 destroy
      // 已把 RAII 账清场（engaged=null），重开即完整走一遍「接管建立=置位」
      const sinceEnable16 = Date.now();
      await p15CdpEval(`window.deck.bridge.invoke('taskbar/set-enabled', { enabled: true })`);
      const takeEv16 = await tape.wait('taskbar-autohide-takeover', null, { since: sinceEnable16, timeoutMs: 8000 });
      const setEv16 = await tape.wait('taskbar-autohide-set', null, { since: sinceEnable16, timeoutMs: 5000 });
      const tbHwnd16 = await handle.waitWindow({ title: TASKBAR_TITLE, timeoutMs: 12000 });
      if (!tbHwnd16) throw new Error('P16 条带窗未出现');
      forceForeground(hwndOf(neutralWin));
      // 后台最大化参照窗（铺到屏底——M1 工作区恒整屏）
      const maxWin16 = new BrowserWindow({ width: 800, height: 600, title: 'DECK-ACCEPT-MAX16', backgroundColor: '#203040' });
      refWins.push(maxWin16);
      await maxWin16.loadURL('about:blank');
      maxWin16.maximize();
      await sleep(1200); // 等最大化落定
      forceForeground(hwndOf(neutralWin)); // 参照窗保持后台
      await sleep(600);
      const baseRect16 = win32.rectOf(hwndOf(maxWin16));
      // ② 夺前台：普通窗开立并夺前台——主诉触发动作；观察窗内逐 250ms 双采样
      const since16 = Date.now();
      const stealWin16 = new BrowserWindow({ width: 640, height: 480, title: 'DECK-ACCEPT-STEAL16', backgroundColor: '#102030' });
      refWins.push(stealWin16);
      await stealWin16.loadURL('about:blank');
      stealWin16.show();
      forceForeground(hwndOf(stealWin16));
      const fg16 = await waitMs(() => Number(win32.GetForegroundWindow()) === hwndOf(stealWin16), 4000);
      let rectStable16 = !!baseRect16;
      let autoSteady16 = true;
      const samples16 = [];
      for (let i = 0; i < 12; i++) { // 3s 观察窗（12 × 250ms）——覆盖档位轮询多拍
        const r = win32.rectOf(hwndOf(maxWin16));
        samples16.push(r ? `${r.bottom}` : '?');
        if (!r || !baseRect16 || r.left !== baseRect16.left || r.top !== baseRect16.top
          || r.right !== baseRect16.right || r.bottom !== baseRect16.bottom) rectStable16 = false;
        if ((appbarState() & 0x1) !== 1) autoSteady16 = false;
        await sleep(250);
      }
      const stripRect16 = win32.rectOf(tbHwnd16);
      const stripOk16 = stripRect16 && Math.abs(stripRect16.bottom - phys16.height) <= 2;
      // ③ 零拍动（takeover/set 之外零状态族存证）
      const flapCount16 = (since) => tape.all('taskbar-autohide-set', undefined, { since }).length
        + tape.all('taskbar-autohide-set-failed', undefined, { since }).length
        + tape.all('taskbar-autohide-reattached', undefined, { since }).length
        + tape.all('taskbar-autohide-reattach-failed', undefined, { since }).length;
      const flap16 = flapCount16(since16);
      // ④ 档位循环：前台切最大化窗 → 收栏档；切回普通窗 → 栏回常驻
      const sinceCyc16 = Date.now();
      forceForeground(hwndOf(maxWin16));
      const retractEv16 = await tape.wait('taskbar-retract',
        (e) => e.mode === 'maximize-retract', { since: sinceCyc16, timeoutMs: 6000 });
      forceForeground(hwndOf(stealWin16));
      let liftEv16 = await tape.wait('taskbar-retract-lifted', undefined, { since: sinceCyc16, timeoutMs: 6000 });
      if (liftEv16 && liftEv16.mode !== 'visible') {
        const yl16 = await tape.wait('taskbar-yield-lifted', undefined, { since: sinceCyc16, timeoutMs: 6000 });
        liftEv16 = yl16 && yl16.mode === 'visible' ? yl16 : null;
      }
      const endRect16 = win32.rectOf(hwndOf(maxWin16));
      const cycStable16 = !!endRect16 && !!baseRect16 && endRect16.left === baseRect16.left
        && endRect16.top === baseRect16.top && endRect16.right === baseRect16.right
        && endRect16.bottom === baseRect16.bottom;
      const flapCyc16 = flapCount16(sinceCyc16);
      if (takeEv16 && setEv16 && fg16 >= 0 && rectStable16 && autoSteady16 && stripOk16 && flap16 === 0
        && retractEv16 && liftEv16 && cycStable16 && flapCyc16 === 0) {
        rep.pass(`P16 覆盖式主诉：后台最大化窗（底边基线 ${baseRect16 ? baseRect16.bottom : '?'}）+ 普通窗 ${fg16}ms 夺前台`
          + `→ 3s 观察窗逐拍采样：最大化窗矩形逐点不变（底边序列 ${samples16.join('/')}）、读回恒含 AUTOHIDE、条带覆盖常驻屏底（底 ${stripRect16 ? stripRect16.bottom : '?'}/${phys16.height}）、`
          + `状态族存证零条（takeover userState=${takeEv16.userState} + set 之外零拍动）；`
          + `档位循环（收栏 → 回常驻）后矩形仍与基线逐字一致、循环期零拍动（${flapCyc16} 条）——运行期任何档位迁移不改窗尺寸（M1 主诉修复面）`);
      } else {
        rep.fail(`P16 takeover=${JSON.stringify(takeEv16)} set=${!!setEv16} 夺前台=${fg16}ms 矩形稳定=${rectStable16}（基线=${JSON.stringify(baseRect16)} 序列=${samples16.join('/')}） `
          + `读回恒置位=${autoSteady16}（现值 0x${appbarState()}） 条带贴底=${stripOk16}（${JSON.stringify(stripRect16)}） 夺前台拍动=${flap16} `
          + `收栏存证=${!!retractEv16} 回常驻存证=${!!liftEv16} 循环后矩形一致=${cycStable16}（${JSON.stringify(endRect16)}） 循环拍动=${flapCyc16}`);
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
