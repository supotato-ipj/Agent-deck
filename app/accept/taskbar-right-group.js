'use strict';
// 工单55 任务栏右组验收：控制器以 --accept-taskbar-right-group 身份运行，
// 拉起 --panel-accept 面板子进程（绕开单实例锁，与常驻面板共存），逐项验收：
//   P1 右组 pill 在场（摘要+音量+时钟三格）、显示桌面细条钉屏幕最右端（撑满条带高）
//   （无 P2：原「硬件摘要与硬件卡口径一致」段随硬件卡在工单59 退役、参照面 hw-line1/2
//    已无渲染源，工单134 按特征退役整段删除；P3-P6 段号不重排，防历史证据错位）
//   P3 时钟格点击 → 原生通知中心前台（Win+N）
//   P4 音量格点击 → 原生快速设置前台（Win+A）
//   P5 显示桌面细条点击 → ToggleDesktop（notepad 探针：一点全最小化、再点还原）
//   P6 勾选子集持久化：set-metrics 落盘 config.json、任务栏页即时收敛、
//      面板重拉（重启保持）后摘要仍只有勾选子集
//   P7 托盘溢出菜单（工单162）：自注册 7 枚探针钉名单量——默认档 5 可见+超量入「⋯」/
//     （工单196：档位两挂点臂6/7 断言锚点迁浮层窗 DECK-TASKBAR-TIER-MENU，落盘/收敛口径不变）/
//      点「⋯」浮层随鼠标弹出（独立浮层窗）/格左键右键同回放分发（探针窗收帧）/点面板
//      外即收（blur）/档位两挂点（「⋯」右键+右组空白右键）选档落盘/数量回落自动回栏
//   P8 图标档位（工单244；工单458 随动改写：溢出行→网格）：托盘图标 16px（1:1 直渲）
//      + 托盘格盒 28×28 + 溢出网格 5 列 36×36 格、16px 图标居中 + 浮层恒宽 200
//      （CDP computed style 与几何存证帧两路互证；条目数变化两拍宽度不变）
//   P9 托盘常驻（工单462）：档位菜单「常驻管理」节勾选即写名单即生效/豁免溢出裁剪/
//      到达序原位/解除回账/跨面板重启保持
//   P10 硬件摘要定宽槽位（工单459）：硬件仪表 stub 喂窄/宽两拍读数（1 位↔3 位百分位、
//      短 KB↔满 5 位 KB 与 MB 进位），taskbar-geometry 右组矩形与摘要/音量/时钟格宽
//      两拍不变 + tb-seg tabular-nums/右对齐/定宽 computed 三证
// 运行：npm run accept:taskbar-right-group（= electron . --accept-taskbar-right-group）。
const { app, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const win32 = require('./lib/win32');
const { Report } = require('./lib/report');
// config 读写/还原共通 helper（工单124）：本电池的 writeTaskbarFields 是有兜底参照实现，
// 抽为单点维护后四电池同一契约（缺位读不抛、缺位落桩、三态还原）
const { readConfigRaw, patchTaskbar, restoreConfig, CONFIG_FILE } = require('./lib/battery-config');
const { cdpPortFor } = require('./lib/registry');
// 工单210：事件磁带（app/accept/lib/event-tape）——等待/读事件收口到一份正典实现；
// 超时档 8000（taskbar 族五块档，母票 #201 决策 8）
const { createEventTape } = require('./lib/event-tape');
// 工单211：面板句柄（app/accept/lib/panel-control 的 createPanelHandle）——发射/就绪/
// 重启/清场四段样板归句柄；清场走**验证强退**（优雅终止 → 整树强杀 → 有界等待并验证消失）
const { createPanelHandle } = require('./lib/panel-control');

const APP_ROOT = path.resolve(__dirname, '..');
const EVENTS_FILE = path.join(__dirname, 'evidence', '55-taskbar-right-group-events.jsonl');
const tape = createEventTape(EVENTS_FILE, { defaultTimeoutMs: 8000 });
// 工单211：句柄装配——发射形态 accept（['.','--panel-accept'] ＋ CDP 端口）；证据档按电池
// 注入专属档名（裁决 10：缺省是八块电池共用的同一文件，混批会让红轮归因变难）
const handle = createPanelHandle({
  execPath: process.execPath, appRoot: APP_ROOT, eventLogPath: EVENTS_FILE,
  archivePath: path.join(__dirname, 'evidence', '55-taskbar-right-group-panel-handle-child.log'),
});
// 工单214：CDP 端口自电池接入表取（manifest 的 cdpPort 字段）——端口分配不再靠注释接力。
const CDP_PORT = cdpPortFor('55-taskbar-right-group');
// 工单459 硬件仪表脚本喂入（P10 定宽槽位段）：控制器写脚本读数、面板进程内 stub
// （accept/lib/hardware-gauge-stub.js，DECK_HW_GAUGE_STUB=1 双门禁）在 hardware() 现读。
// 三处拉面板（起跑 + P6/P9 重拉）都带同一 extraEnv；轮末 P10 段自删脚本文件。
const HW_GAUGE_FILE = path.join(APP_ROOT, 'accept', 'evidence', '459-hw-gauge-script.json');
const PANEL_ENV_459 = { DECK_HW_GAUGE_STUB: '1', DECK_HW_GAUGE_FILE: HW_GAUGE_FILE };
const TASKBAR_TITLE = 'DECK-TASKBAR';
const PANEL_TITLE = 'AGENT DECK';
const VK_ESC = 0x1b;

const { nativeTaskbarVisible, ensureNativeTaskbarVisible } = win32;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const koffi = win32.koffi;
const user32 = koffi.load('user32.dll');

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

/**
 * 验证强退（工单211，#202 决策 8）：句柄 stop() 沿用工单112 的强退序列
 * （优雅终止 → 整树强杀 → 有界等待并验证消失）。**gone=false ＝「需重启清障」中止信号**：
 * 入环境降责账并中止后续段（throw 借电池的 try/catch 汇流，不吞）。
 * 原实现是无验证 killTree（taskkill /T /F 后不验消失就放行重启）——停摆面板残留会撞
 * 单实例守卫，本刀起补上「验证消失」这一环。
 */
async function stopPanelOrAbort(rep) {
  const stopped = await handle.stop();
  if (!stopped.gone) {
    rep.exclude(`面板强退失败：强杀后有界等待内仍存活（pid=${stopped.pidsLeft.join(', ')}）——需重启清障`,
      '面板强退序列未能终结面板进程', 'panel-forcekill');
    throw new Error('面板强退失败：需重启清障——后续段中止');
  }
  return stopped;
}

// 任务栏页摘要格读式（工单123 引入）：仅 P6 消费（即时收敛 + 重拉两读）——hw-summary
// 缺位返回 null 而非抛 TypeError 的空安全读，防格缺位窗口期中止电池。
const READ_SUMMARY_EXPR = `(() => { const el = document.getElementById('hw-summary'); return el ? el.innerText : null; })()`;

// —— P7 托盘溢出探针（工单162）：控制器进程自建消息窗 + 自注册 7 枚托盘图标，把溢出
// 拆分的名单量钉到确定性（默认档 5 → 恒 ≥2 枚进「⋯」，机器图标数量不影响断言）。
// 49 电池 P14 探针同款机制（收编确认走栏内名单轮询——tray-event 明细只在 spike 模式落盘）。
const shell32r = koffi.load('shell32.dll');
const ShellNotifyIconW7 = shell32r.func('bool __stdcall Shell_NotifyIconW(uint32 dwMessage, void *nid)');
const kernel32r = koffi.load('kernel32.dll');
const GetModuleHandleW7 = kernel32r.func('uintptr_t __stdcall GetModuleHandleW(uintptr_t name)');
const LoadIconW7 = user32.func('uintptr_t __stdcall LoadIconW(uintptr_t hInst, uintptr_t name)');
koffi.proto('__stdcall', 'Deck162WndProc', 'intptr_t', ['uintptr_t', 'uint32', 'uintptr_t', 'intptr_t']);
const DECK162_WNDCLASS = koffi.struct('Deck162WndClassW', {
  cbSize: 'uint32', style: 'uint32', lpfnWndProc: 'Deck162WndProc *',
  cbClsExtra: 'int32', cbWndExtra: 'int32', hInstance: 'uintptr_t',
  hIcon: 'uintptr_t', hCursor: 'uintptr_t', hbrBackground: 'uintptr_t',
  lpszMenuName: 'uintptr_t', lpszClassName: 'char16_t *', hIconSm: 'uintptr_t',
});
const RegisterClassExW7 = user32.func('uint16 __stdcall RegisterClassExW(Deck162WndClassW *wc)');
const CreateWindowExW7 = user32.func('uintptr_t __stdcall CreateWindowExW(uint32 ex, const char16_t *cls, const char16_t *name, uint32 style, int x, int y, int w, int h, uintptr_t parent, uintptr_t menu, uintptr_t hinst, uintptr_t param)');
const DestroyWindow7 = user32.func('bool __stdcall DestroyWindow(uintptr_t hWnd)');
const UnregisterClassW7 = user32.func('bool __stdcall UnregisterClassW(const char16_t *cls, uintptr_t hinst)');
const DefWindowProcW7 = user32.func('intptr_t __stdcall DefWindowProcW(uintptr_t hWnd, uint32 msg, uintptr_t wp, intptr_t lp)');
const PeekMessageW7 = user32.func('bool __stdcall PeekMessageW(void *msg, uintptr_t hWnd, uint32 min, uint32 max, uint32 remove)');
const TranslateMessage7 = user32.func('bool __stdcall TranslateMessage(const void *msg)');
const DispatchMessageW7 = user32.func('intptr_t __stdcall DispatchMessageW(const void *msg)');

function makeOverflowProbe() {
  const frames = [];
  const proc = koffi.register((h, msg, wp, lp) => {
    const lpn = typeof lp === 'bigint' ? Number(BigInt.asUintN(32, lp)) : Number(lp) >>> 0;
    frames.push({ h: Number(h), msg, wp: Number(wp), lp: lpn });
    return Number(DefWindowProcW7(h, msg, wp, lp));
  }, 'Deck162WndProc *');
  const hinst = Number(GetModuleHandleW7(0));
  const atom = RegisterClassExW7({
    cbSize: koffi.sizeof(DECK162_WNDCLASS), style: 0, lpfnWndProc: proc,
    cbClsExtra: 0, cbWndExtra: 0, hInstance: hinst,
    hIcon: 0, hCursor: 0, hbrBackground: 0,
    lpszMenuName: 0, lpszClassName: 'DECK162PROBE', hIconSm: 0,
  });
  const hwnd = Number(CreateWindowExW7(0x80 | 0x08000000, 'DECK162PROBE', 'DECK162PROBE',
    0x80000000, 0, 0, 0, 0, 0, 0, hinst, 0));
  const msgBuf = Buffer.alloc(48);
  const pump = () => {
    while (PeekMessageW7(msgBuf, hwnd, 0, 0, 1)) {
      TranslateMessage7(msgBuf);
      DispatchMessageW7(msgBuf);
    }
  };
  const waitFrame = async (pred, timeoutMs = 4000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      pump();
      const hit = frames.filter(pred).pop();
      if (hit) return hit;
      await sleep(60);
    }
    return null;
  };
  const destroy = () => {
    try { if (hwnd) DestroyWindow7(hwnd); } catch { /* 尽力 */ }
    try { if (atom) UnregisterClassW7('DECK162PROBE', hinst); } catch { /* 尽力 */ }
    try { koffi.unregister(proc); } catch { /* 尽力 */ }
  };
  return { frames, hwnd, pump, waitFrame, destroy };
}

/**
 * 最新一条命中事件（waitEvent 取首条；溢出几何/浮层开合要看「当前态」——从尾部扫）。
 * 工单210：事件源归磁带——tape.latest 是正典 readEvents().filter().pop() 的「末拍」口径，
 * 与 tape.wait 的「首个」口径**刻意并存**（裁决 2：不许一律用 latest / 不许一律用 wait）。
 */
async function waitLastEvent(type, pred, timeoutMs = 8000, queryOptions) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = tape.latest(type, pred, queryOptions);
    if (hit) return hit;
    await sleep(60);
  }
  return null;
}

async function main() {
  const rep = new Report('55-taskbar-right-group');
  let panelPid = 0;
  let notepad = null;
  let probe162 = null; // P7 探针（工单162）：finally 兜底拆除（段内异常也不漏窗漏类漏图标）
  let spawnedP7 = null;
  const originalConfig = readConfigRaw();
  const finish = () => {
    const v = rep.verdict(rep.fails === 0 ? 'PASS' : 'FAIL');
    app.exit(v.fails === 0 ? 0 : 1);
  };

  try {
    fs.writeFileSync(EVENTS_FILE, '', 'utf8');
    patchTaskbar({ enabled: true, metrics: ['cpu', 'gpu', 'ram', 'net-down', 'net-up'] });

    // —— 拉起面板子进程（任务栏启用态）——
    // 工单211：发射归面板句柄（mode='accept' ＝ ['.','--panel-accept'] ＋ CDP 端口）
    handle.launch({ mode: 'accept', cdpPort: CDP_PORT, stdio: 'ignore', extraEnv: PANEL_ENV_459 });
    const boot = await tape.wait('boot', null, { timeoutMs: 15000 });
    if (!boot) throw new Error('面板子进程未上报 boot 事件');
    panelPid = boot.pid;
    rep.note(`面板 pid=${panelPid}`);

    const tbHwnd = await handle.waitWindow({ title: TASKBAR_TITLE, timeoutMs: 12000 });
    if (!tbHwnd) throw new Error('任务栏窗口未出现');
    const tbRect = win32.rectOf(tbHwnd);
    const dip = screen.getPrimaryDisplay().bounds;
    const scale = (tbRect.right - tbRect.left) / dip.width;
    const toPhys = (cssX, cssY) => ({
      x: Math.round(tbRect.left + cssX * scale),
      y: Math.round(tbRect.top + cssY * scale),
    });

    // 等右组渲染就绪 + 首个 1Hz 数据帧（摘要数值就位）
    const ready = await tape.wait('taskbar-ready', (e) => e.rightPill && e.sliver, { timeoutMs: 10000 });
    if (!ready) throw new Error('taskbar-ready 存证缺失右组矩形（无法取点击坐标）');
    const statusEv = await tape.wait('taskbar-right-status', (e) => e.values && e.values.cpu, { timeoutMs: 10000 });
    if (!statusEv) throw new Error('taskbar-right-status 存证缺失（右组 1Hz 数据帧未到达）');
    const cellOf = (id) => {
      const c = ready.rightCells.find((x) => x.id === id);
      if (!c) throw new Error(`rightCells 缺 ${id} 格`);
      return toPhys(c.x + c.w / 2, c.y + c.h / 2);
    };

    // P1 右组 pill 在场 + 细条钉屏幕最右端（右缘贴屏右、撑满条带高）
    rep.beginSegment('P1');
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

    // —— 系统动作三格（P3/P4/P5）：点击前统一收敛 z 序/热区 ——
    // P3 时钟格 → 原生通知中心（Win+N）
    // 终检 R2 复盘：合成回执 ok 而 6s 无前台——通知中心以非激活态开出（前台锁：用户
    // 会话活跃输入下 shell 浮层可不夺前台；Esc 能收起=true 佐证浮层在场，产品已履约）。
    // 有界重试：dismiss 后重点一次，前台判据原样不放宽；两径其一成立即过。
    rep.beginSegment('P3');
    const beforeP3 = foregroundInfo();
    const clockPt = cellOf('clock');
    let convP3 = false;
    let evP3 = null;
    let fgP3 = null;
    for (let attempt = 0; attempt < 2 && !fgP3; attempt++) {
      convP3 = await convergeAt(clockPt, tbHwnd);
      if (!convP3) break;
      if (attempt > 0) rep.note(`P3 第 ${attempt + 1} 次尝试（上次回执 ok 而前台未收敛——前台锁/非激活开出，dismiss 后重试）`);
      win32.clickPhys(clockPt.x, clockPt.y, 'left');
      const ev = await tape.wait('taskbar-action-result', (e) => e.action === 'notification-center' && e.t >= Date.now() - 6000, { timeoutMs: 5000 });
      if (ev) evP3 = ev;
      fgP3 = await waitForeground((i) => isNotificationCenter(i) && (!beforeP3 || i.hwnd !== beforeP3.hwnd), 6000);
      if (!fgP3) { await dismissFlyout(); await sleep(600); }
    }
    rep.note(`P3 点击前收敛=${convP3}`);
    if (convP3 && evP3 && evP3.ok && fgP3) {
      rep.pass(`P3 时钟格弹出原生通知中心（前台 ${fgP3.exe} / ${fgP3.cls}）`);
    } else {
      rep.fail(`P3 收敛=${convP3} 合成回执=${JSON.stringify(evP3)} 前台=${JSON.stringify(fgP3)}`);
    }
    const closedP3 = await dismissFlyout();
    rep.note(`通知中心收起=${closedP3}`);
    await sleep(600);

    // P4 音量格 → 原生快速设置（Win+A）
    rep.beginSegment('P4');
    const beforeP4 = foregroundInfo();
    const volPt = cellOf('volume');
    const convP4 = await convergeAt(volPt, tbHwnd);
    rep.note(`P4 点击前收敛=${convP4}`);
    win32.clickPhys(volPt.x, volPt.y, 'left');
    const evP4 = await tape.wait('taskbar-action-result', (e) => e.action === 'quick-settings' && e.t >= Date.now() - 6000, { timeoutMs: 5000 });
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
    rep.beginSegment('P5');
    notepad = spawn('notepad.exe', [], { stdio: 'ignore' });
    // 新窗口能不能自抢前台取决于启动方此刻是否持前台：本控制器刚做完 P4 的浮层收势，
    // 前台在原生任务栏（explorer）手里，spawn 出来的 notepad 会被 Win 前台锁挡在台外
    // （实测冷启 371ms 就有窗口，却始终等不到前台）。显式提前台，探针起点才干净。
    const noteHwnd = await waitWindowByExe('notepad', 8000);
    if (noteHwnd) {
      win32.SetForegroundWindow(noteHwnd);
      await sleep(300);
    }
    // 终检 R2 复盘：SetForegroundWindow 受前台锁阻（用户会话活跃输入时后台进程不可夺
    // 前台——实测 8s 等不到，探针前台=false 即段红）。兜底走探针窗自身的最小化→还原：
    // 还原是窗口操作级激活（不经前台锁），且只动自家探针窗、不向用户会话注入键鼠。
    if (noteHwnd && !(await waitForeground((i) => i.exe === 'notepad', 1200))) {
      win32.ShowWindow(noteHwnd, 6 /* SW_MINIMIZE */);
      await sleep(250);
      win32.ShowWindow(noteHwnd, 9 /* SW_RESTORE */);
      await sleep(400);
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
      evP5a = await tape.wait('taskbar-action-result', (e) => e.action === 'toggle-desktop' && e.t >= Date.now() - 6000, { timeoutMs: 5000 });
      p5min = await waitForeground(isDesktop, 6000);
      await sleep(400);
      // 再点一次：Win+D 反 toggle 还原 notepad 前台（对齐 Win11 右下角肌肉记忆）
      await convergeAt(sliverPt, tbHwnd);
      win32.clickPhys(sliverPt.x, sliverPt.y, 'left');
      evP5b = await tape.wait('taskbar-action-result', (e) => e.action === 'toggle-desktop' && e.t >= Date.now() - 4000, { timeoutMs: 5000 });
      p5restore = await waitForeground((i) => i.exe === 'notepad', 6000);
    }
    if (fgNote && p5min && p5restore && evP5a && evP5a.ok && evP5b && evP5b.ok) {
      rep.pass('P5 显示桌面细条 ToggleDesktop：一点全最小化落桌面、再点 notepad 还原前台');
    } else {
      rep.fail(`P5 探针前台=${!!fgNote} 最小化=${JSON.stringify(p5min)} 还原=${JSON.stringify(p5restore)} 回执=${JSON.stringify([evP5a, evP5b])}`);
    }

    // P6 勾选子集持久化：CDP 面板页 set-metrics → 落盘 + 任务栏页即时收敛 + 重拉重启保持
    rep.beginSegment('P6');
    const r6 = await cdpEval(PANEL_TITLE, `window.deck.bridge.invoke('taskbar/set-metrics', { metrics: ['ram', 'cpu'] })`);
    await sleep(800); // 等 taskbar/changed 抵达任务栏页重渲染
    const disk6 = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    // 工单123：读侧时序——set-metrics 触发重渲染，空安全读缺位返回 null
    // （live6 判 false 走段失败留证据），不再 TypeError 中止整块电池
    const sumText6 = await cdpEval(TASKBAR_TITLE, READ_SUMMARY_EXPR);
    const live6 = /CPU/.test(String(sumText6)) && /RAM/.test(String(sumText6))
      && !/GPU/.test(String(sumText6)) && !/DL/.test(String(sumText6)) && !/UP/.test(String(sumText6));
    // 重拉面板（重启保持判据）
    await stopPanelOrAbort(rep); // 工单211：验证强退（gone=false 即中止信号）
    panelPid = 0;
    await sleep(1200);
    const since6 = Date.now();
    handle.launch({ mode: 'accept', cdpPort: CDP_PORT, stdio: 'ignore', extraEnv: PANEL_ENV_459 });
    const boot6 = await tape.wait('boot', undefined, { since: since6, timeoutMs: 15000 });
    if (!boot6) throw new Error('P6 重拉面板子进程未上报 boot');
    panelPid = boot6.pid;
    await handle.waitWindow({ title: TASKBAR_TITLE, timeoutMs: 12000 });
    const ready6 = await tape.wait('taskbar-ready', (e) => e.rightCells, { since: since6, timeoutMs: 10000 });
    const ids6 = ready6 ? ready6.rightCells.map((c) => c.id) : [];
    const sumText6b = ready6 ? await cdpEval(TASKBAR_TITLE, READ_SUMMARY_EXPR) : '';
    const persist6 = /CPU/.test(String(sumText6b)) && /RAM/.test(String(sumText6b)) && !/GPU/.test(String(sumText6b));
    if (r6 && JSON.stringify(r6.metrics) === JSON.stringify(['cpu', 'ram'])
      && JSON.stringify(disk6.taskbar?.metrics) === JSON.stringify(['cpu', 'ram'])
      && live6 && persist6) {
      rep.pass('P6 勾选子集持久化：落盘 config.json、任务栏即时收敛为 CPU/RAM、重拉后保持（重启保持）');
    } else {
      rep.fail(`P6 响应=${JSON.stringify(r6)} 落盘=${JSON.stringify(disk6.taskbar)} 即时=${live6}(${sumText6}) 重拉=${persist6}(${sumText6b}) 格=${JSON.stringify(ids6)}`);
    }

    // P7 托盘溢出菜单（工单162）：探针 7 枚钉名单量 → 默认档 5 恒溢出，机器图标数不影响断言。
    rep.beginSegment('P7');
    const t7 = Date.now();
    // P6 重拉了面板：旧条带窗句柄已死（convergeAt 对死 hwnd 轮询必超时），重取现任窗
    const tbHwnd7 = await handle.waitWindow({ title: TASKBAR_TITLE, timeoutMs: 12000 });
    if (!tbHwnd7) throw new Error('P7 条带窗未出现');
    const conv = (pt) => convergeAt(pt, tbHwnd7);
    const {
      encodeNotifyIconData, NIM_ADD, NIM_DELETE,
      NIF_MESSAGE, NIF_ICON, NIF_TIP,
    } = require(path.join(APP_ROOT, 'dist', 'main', 'trayhost', 'protocol.js'));
    const PROBE_CB = 0x8000 + 162;
    const PROBE_UIDS = Array.from({ length: 7 }, (_, i) => 0x1620001 + i);
    probe162 = makeOverflowProbe();
    if (!probe162.hwnd) throw new Error('P7 探针窗创建失败');
    const hicon7 = Number(LoadIconW7(0, 32512)); // IDI_APPLICATION
    const probeKeys = PROBE_UIDS.map((uid) => `${probe162.hwnd}:${uid}`);
    const probeAlive = [];
    for (let i = 0; i < PROBE_UIDS.length; i++) {
      const nid = encodeNotifyIconData({ arch: 'x64', version: 3, hwnd: probe162.hwnd, uid: PROBE_UIDS[i],
        flags: NIF_MESSAGE | NIF_ICON | NIF_TIP, callbackMessage: PROBE_CB, hicon: hicon7,
        tooltip: `DECK162-P${i}`, uVersion: 0 });
      if (ShellNotifyIconW7(NIM_ADD, nid)) probeAlive.push(i);
    }
    // 收编确认走栏内名单轮询（49 P14 同款——tray-event 明细只在 spike 模式落盘）
    const rosterKeys = async () => {
      const st = await cdpEval(TASKBAR_TITLE, `window.deck.bridge.invoke('taskbar/get-state', {})`);
      return (st && Array.isArray(st.tray)) ? st.tray.map((x) => x.key) : [];
    };
    let roster7 = [];
    for (let i = 0; i < 20; i++) {
      roster7 = await rosterKeys();
      if (probeAlive.length > 0 && probeKeys.every((k) => roster7.includes(k))) break;
      await sleep(400);
    }
    const probesIn = probeKeys.filter((k) => roster7.includes(k));
    rep.note(`P7 探针在册 ${probesIn.length}/${PROBE_UIDS.length} 名单=${roster7.length}`);
    const armFail7 = (name, detail) => rep.fail(`P7[${name}] ${detail}`);

    // 前置数据：最新几何（⋯ 矩形在此）
    const geo7 = await waitLastEvent('taskbar-geometry', (e) => e.trayOverflow, 8000, { since: t7 });
    if (!geo7) {
      armFail7('几何', 'taskbar-geometry 无 trayOverflow 矩形（⋯ 未渲染或存证缺字段）');
    } else {
      const barCount = geo7.trayIcons.length;
      // 臂1：默认档 5 可见、超量尾部入 ⋯（名单 > 5 恒真——探针已钉 7+）
      if (barCount === 5 && roster7.length > 5 && !!geo7.trayOverflow) {
        rep.pass(`臂1 默认档 5 可见（栏内 ${barCount}/名单 ${roster7.length}）、超量 ${roster7.length - 5} 枚入「⋯」`);
      } else {
        armFail7('默认5', `栏内=${barCount} 名单=${roster7.length} ⋯=${JSON.stringify(geo7.trayOverflow)}`);
      }

      const more = geo7.trayOverflow;
      const morePt = toPhys(more.x + more.w / 2, more.y + more.h / 2);
      // 格矩形在页面 ready 事件（工单458：rows 数组带 x/y/w/h，坐标语义 = 格），窗
      // bounds 在宿主 opened/resized 事件（常驻窗重开从 cache 弹出，名单churn重定窗落
      // resized）——两路配对。开层后 700ms 沉降：红轮两轮实证「show 后 ~100ms 内落点的
      // 点击整帧丢失」（新窗输入路由未就绪），沉降拍后 bounds/rows 都取最新帧（churn
      // 重定窗后的现行布局）。只点视口内格（y+h ≤ ready.h）：帽外格点击会落到浮层外
      //（红轮实证：触发条带 strip-click 收层 + 杂散点击，连锁红）。
      const openPopup = async (note) => {
        const since = Date.now();
        const convOk = await conv(morePt);
        if (note) rep.note(`${note} 收敛=${convOk}`);
        win32.clickPhys(morePt.x, morePt.y, 'left');
        await sleep(700);
        const boundsOf = () => {
          const os = tape.all(undefined,
            (e) => e.type === 'taskbar-tray-overflow-opened' || e.type === 'taskbar-tray-overflow-resized',
            { since });
          return os.length ? os[os.length - 1] : null;
        };
        let opened = null;
        const dl = Date.now() + 8000;
        while (Date.now() < dl) {
          opened = boundsOf();
          if (opened) break;
          await sleep(80);
        }
        const ready = await waitLastEvent('taskbar-tray-overflow-ready', (e) => Array.isArray(e.rows) && e.rows.length > 0, 4000, { since });
        let rows = ready ? ready.rows : null;
        let viewH = ready ? Number(ready.h) || 0 : 0;
        if (!rows) {
          // 兜底：页面 ready 随名单 churn 才重报，无 churn 窗口内可能缺席——直接从内核
          // 现取名单按格几何推（同一态：浮层格 = 名单去前 limit 的尾段；工单458：5 列
          // 行优先、格 36×36、列/行步进 38、首格偏移 6（边 1 + 内衬 5）——与浮层页 CSS
          // 同源），key 实时、坐标算术稳定
          const st = await cdpEval(TASKBAR_TITLE, `window.deck.bridge.invoke('taskbar/get-state', {})`);
          const limit = st && st.trayOverflowLimit === 'all' ? st.tray.length : (st?.trayOverflowLimit ?? 5);
          const tail = (st?.tray || []).slice(limit);
          rows = tail.map((e, i) => ({
            key: e.key, label: e.tooltip || e.key,
            x: 6 + 38 * (i % 5), y: 6 + 38 * Math.floor(i / 5), w: 36, h: 36,
          }));
          viewH = Math.ceil(rows.length / 5) * 38 + 10;
        }
        if (note) rep.note(`${note}: ${opened ? `rows=${rows ? rows.length : 'n/a'} bounds=${JSON.stringify(opened.bounds)}` : '未开'}`);
        return { opened, rows, viewH };
      };
      const cellPt = (pop, idx) => ({
        x: Math.round((pop.opened.bounds.x + pop.rows[idx].x + pop.rows[idx].w / 2) * scale),
        y: Math.round((pop.opened.bounds.y + pop.rows[idx].y + pop.rows[idx].h / 2) * scale),
      });
      const probeRowIdx = (pop) => pop.rows.findIndex((r) => probesIn.includes(r.key) && r.y + r.h <= pop.viewH + 4);

      // 臂2：点「⋯」浮层随鼠标弹出（独立浮层窗 DECK-TRAY-OVERFLOW 在场、行数 = 名单-5）
      const pop2 = await openPopup('臂2开层');
      const popWin2 = pop2.opened ? await handle.waitWindow({ title: 'DECK-TRAY-OVERFLOW', timeoutMs: 3000 }) : null;
      // 机器图标有进出（churn 是常态）：开层后重读名单对账，行数 = 现任名单 - 5
      let roster2 = roster7;
      for (let i = 0; i < 5 && pop2.rows && pop2.rows.length !== roster2.length - 5; i++) {
        await sleep(300);
        roster2 = await rosterKeys();
      }
      if (pop2.opened && popWin2 && pop2.rows && pop2.rows.length === roster2.length - 5
        && probeRowIdx(pop2) >= 0) {
        rep.pass(`臂2 浮层随鼠标弹出（格 ${pop2.rows.length} = 名单 ${roster2.length} - 5，浮层窗在场）`);
      } else {
        armFail7('浮层弹出', `opened=${!!pop2.opened} 窗=${!!popWin2} rows=${pop2.rows ? pop2.rows.length : 'n/a'} 名单=${roster2.length} 探针行=${pop2.rows ? probeRowIdx(pop2) : 'n/a'}`);
      }

      // 臂3：格左键 = 默认动作（同一回放分发）：溢出格点击 → taskbar/tray-click 存证
      //（surface=overflow）+ 探针窗收帧（v0 口径 wp=uid/lp=WM_LBUTTONUP）+ 格点即收
      if (pop2.opened && pop2.rows && probeRowIdx(pop2) >= 0) {
        const idx3 = probeRowIdx(pop2);
        const key3 = pop2.rows[idx3].key;
        const uid3 = PROBE_UIDS[probeKeys.indexOf(key3)];
        probe162.frames.length = 0;
        const pt3 = cellPt(pop2, idx3);
        win32.clickPhys(pt3.x, pt3.y, 'left');
        const click3 = await tape.wait('taskbar-tray-click', (e) => e.surface === 'overflow' && e.key === key3 && e.button === 'left' && e.t >= Date.now() - 6000, { timeoutMs: 5000 });
        const result3 = await tape.wait('taskbar-tray-click-result', (e) => e.surface === 'overflow' && e.key === key3 && e.ok && e.t >= Date.now() - 6000, { timeoutMs: 5000 });
        const frame3 = await probe162.waitFrame((f) => f.msg === PROBE_CB && f.wp === uid3 && f.lp === 0x0202);
        const closed3 = await tape.wait('taskbar-tray-overflow-closed', (e) => e.reason === 'cell' && e.t >= Date.now() - 6000, { timeoutMs: 5000 });
        if (click3 && result3 && frame3 && closed3) {
          rep.pass(`臂3 格左键默认动作（key=${key3}）：同回放分发收帧 wp=${frame3.wp}/lp=0x${frame3.lp.toString(16)}、格点即收`);
        } else {
          armFail7('格左键', `存证=${!!click3} 回执=${!!result3} 收帧=${JSON.stringify(frame3)} 收层=${JSON.stringify(closed3)}`);
        }
      } else {
        armFail7('格左键', '浮层未开或溢出无探针格（臂2 失败连带）');
      }

      // 臂4：格右键 = 应用自带菜单（同回放分发右键链；v0 lp=WM_RBUTTONUP）
      const pop4 = await openPopup('臂4开层');
      if (pop4.opened && pop4.rows && probeRowIdx(pop4) >= 0) {
        const idx4 = probeRowIdx(pop4);
        const key4 = pop4.rows[idx4].key;
        const uid4 = PROBE_UIDS[probeKeys.indexOf(key4)];
        probe162.frames.length = 0;
        const pt4 = cellPt(pop4, idx4);
        win32.clickPhys(pt4.x, pt4.y, 'right');
        const click4 = await tape.wait('taskbar-tray-click', (e) => e.surface === 'overflow' && e.key === key4 && e.button === 'right' && e.t >= Date.now() - 6000, { timeoutMs: 5000 });
        const frame4 = await probe162.waitFrame((f) => f.msg === PROBE_CB && f.wp === uid4 && f.lp === 0x0205);
        if (click4 && frame4) {
          rep.pass(`臂4 格右键自带菜单（key=${key4}）：同回放分发右键收帧 lp=0x${frame4.lp.toString(16)}`);
        } else {
          armFail7('格右键', `存证=${JSON.stringify(click4)} 收帧=${JSON.stringify(frame4)}`);
        }
        // 臂5：点面板外即收起——notepad 探针前台点击夺焦（面板永不激活点不出 blur，
        // 桌面/应用窗才夺焦点；浮层 blur 即「点面板外」的全局信号）。臂4 行点已收层
        //（回执殿后修复生效），先重开浮层
        const pop5 = await openPopup('臂5开层');
        let note7 = pop5.opened ? await waitWindowByExe('notepad', 1500) : null;
        if (!note7 && pop5.opened) {
          const spawned = spawn('notepad.exe', [], { stdio: 'ignore' });
          note7 = await waitWindowByExe('notepad', 8000);
          if (note7) spawnedP7 = spawned;
        }
        if (note7 && pop5.opened) {
          win32.SetForegroundWindow(note7);
          await sleep(300);
          const r7n = win32.rectOf(note7);
          const center7 = { x: Math.round((r7n.left + r7n.right) / 2), y: Math.round((r7n.top + r7n.bottom) / 2) };
          // notepad 中心若被浮层盖住（低分屏），改点浮层窗外一定距离的屏中
          const b7 = pop5.opened.bounds;
          const covered = center7.x > b7.x - 8 && center7.x < b7.x + b7.width + 8
            && center7.y > b7.y - 8 && center7.y < b7.y + b7.height + 8;
          const pt5 = covered
            ? { x: Math.round((dip.x + dip.width / 2) * scale), y: Math.round((dip.y + dip.height / 2) * scale) }
            : center7;
          win32.clickPhys(pt5.x, pt5.y, 'left');
          const closed5 = await tape.wait('taskbar-tray-overflow-closed', (e) => e.reason === 'blur' && e.t >= Date.now() - 6000, { timeoutMs: 5000 });
          if (closed5) {
            rep.pass('臂5 点面板外即收起（浮层 blur 收层）');
          } else {
            armFail7('点外收起', '无 reason=blur 收层存证');
          }
        } else {
          armFail7('点外收起', 'notepad 探针不可用（夺焦点臂无法执行）');
        }
      } else {
        armFail7('格右键', '浮层未开或溢出无探针格（臂2 失败连带）');
      }

      // 档位菜单浮层锚点（工单196：档位菜单迁浮层窗 DECK-TASKBAR-TIER-MENU，横排进右组
      // pill 退役）：opened/resized（窗 bounds）与 ready（rows 带 id/label/y/h 相对客户区）
      // 两路配对取行点击坐标——勿用 settle 静态几何（49 族 6fab89d 教训同源）。窗常驻事件
      // 跨臂累积，以开层拍 since 为下界。落盘与栏面收敛断言口径不变（system-state 面）。
      const tierPopup7 = (since) => {
        const os = tape.all(undefined,
          (e) => e.type === 'taskbar-tier-menu-opened' || e.type === 'taskbar-tier-menu-resized', { since });
        // ready 行几何：本开层拍有新回报用新拍；缺席（show 重开不触发页重回报——页只在
        // boot/changed 回报）回退最近一拍——行集 = 四档行恒列 + 常驻管理节（工单462：行数
        // 随托盘名单量增长，开层判据从「恰 4 行」改「四档行齐列」；行高同族一致，行几何按
        // 行 id 定位，跨开拍坐标算术稳定）
        let rd = tape.all('taskbar-tier-menu-ready', (e) => Array.isArray(e.rows), { since });
        if (!rd.length) rd = tape.all('taskbar-tier-menu-ready', (e) => Array.isArray(e.rows));
        return os.length && rd.length
          ? { since, bounds: os[os.length - 1].bounds, rows: rd[rd.length - 1].rows, w: Number(rd[rd.length - 1].w) || 0 }
          : null;
      };
      // 右键开浮层（三试：右键偶发不开——49 族 P16⑥/⑰ 同款抖动，到靶收敛后重试）；
      // 开层判据 = 四档行齐列（tier 行恰 4 条——常驻管理节行随名单量增列，工单462）
      const openTierPopup7 = async (ptOf) => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const pt = ptOf();
          if (!pt) return null;
          await conv(pt); // 到靶停拍（convergeAt 内含热区翻转窗口）
          const since = Date.now();
          win32.clickPhys(pt.x, pt.y, 'right');
          for (let i = 0; i < 12; i++) {
            await sleep(200);
            const pop = tierPopup7(since);
            if (pop && pop.rows.filter((r) => String(r.id || '').startsWith('tier-')).length === 4) return pop;
          }
        }
        return null;
      };
      // 浮层行点击核验重试（点行撞热区轮询窗同款——回执 3s 不来就重查行矩形再点，≤3 试；
      // 行物理坐标 = 窗 bounds + ready 行偏移直乘 scale，49 族 P16⑥ 先例同式）
      const clickTierRowVerify7 = async (since, rowId, limitVal) => {
        for (let i = 0; i < 3; i++) {
          const pop = tierPopup7(since);
          const row = pop ? pop.rows.find((r) => r.id === rowId) : null;
          if (!row) return null;
          const pt = {
            x: Math.round((pop.bounds.x + pop.w / 2) * scale),
            y: Math.round((pop.bounds.y + row.y + row.h / 2) * scale),
          };
          win32.moveMousePhys(pt.x, pt.y);
          await sleep(250);
          win32.clickPhys(pt.x, pt.y, 'left');
          const ev = await tape.wait('taskbar-tray-overflow-limit-result', (e) => e.limit === limitVal && e.ok && e.t >= Date.now() - 5000, { timeoutMs: 5000 });
          if (ev) return ev;
        }
        return null;
      };

      // 臂6：档位菜单挂点一（「⋯」右键）→ 选 3 枚：落盘 + 即时收敛 + ⋯ 保持（名单 ≥4 恒真）
      const conv6 = await conv(morePt);
      rep.note(`臂6 收敛=${conv6}`);
      const pop6 = await openTierPopup7(() => morePt);
      let arm6 = false;
      let detail6 = `档位浮层=${pop6 ? '在场' : '缺'}`;
      if (pop6) {
        const limitEv = await clickTierRowVerify7(pop6.since, 'tier-3', 3);
        await sleep(800); // 重拆 + 几何重报一拍
        const disk6b = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        const geo6b = tape.latest('taskbar-geometry', (e) => e.trayIcons, { since: pop6.since });
        arm6 = !!limitEv && disk6b.taskbar?.trayOverflowLimit === 3
          && geo6b && geo6b.trayIcons.length === 3 && !!geo6b.trayOverflow;
        detail6 += ` 回执=${JSON.stringify(limitEv)} 落盘=${disk6b.taskbar?.trayOverflowLimit} 栏内=${geo6b ? geo6b.trayIcons.length : 'n/a'} ⋯=${geo6b ? !!geo6b.trayOverflow : 'n/a'}`;
      }
      if (arm6) {
        rep.pass('臂6 「⋯」右键档位浮层（DECK-TASKBAR-TIER-MENU）选 3 枚：落盘 config（trayOverflowLimit=3）、即时收敛 3 枚、「⋯」保持');
      } else {
        armFail7('档位挂点一', detail6);
      }

      // 臂7：档位菜单挂点二（右组空白处右键）→ 选全部：⋯ 消失、栏内 = 名单（工单196
      // 迁浮层窗锚点，行点击 = DECK-TASKBAR-TIER-MENU ready 行集）
      const blankPtOf7 = () => {
        const rp7 = tape.latest('taskbar-geometry', (e) => e.rightPill);
        return toPhys(rp7.rightPill.x + 4, rp7.rightPill.y + rp7.rightPill.h / 2);
      };
      const blankPt = blankPtOf7();
      const conv7 = await conv(blankPt);
      rep.note(`臂7 收敛=${conv7}`);
      const pop7 = await openTierPopup7(blankPtOf7);
      let arm7 = false;
      let detail7 = `档位浮层=${pop7 ? '在场' : '缺'}`;
      if (pop7) {
        const limitEv = await clickTierRowVerify7(pop7.since, 'tier-all', 'all');
        await sleep(800);
        const disk7b = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        const geo7b = tape.latest('taskbar-geometry', (e) => e.trayIcons, { since: pop7.since });
        roster7 = await rosterKeys();
        arm7 = !!limitEv && disk7b.taskbar?.trayOverflowLimit === 'all'
          && geo7b && geo7b.trayIcons.length === roster7.length && geo7b.trayOverflow === null;
        detail7 += ` 回执=${JSON.stringify(limitEv)} 落盘=${disk7b.taskbar?.trayOverflowLimit} 栏内=${geo7b ? geo7b.trayIcons.length : 'n/a'}/${roster7.length} ⋯=${geo7b ? JSON.stringify(geo7b.trayOverflow) : 'n/a'}`;
      }
      if (arm7) {
        rep.pass('臂7 右组空白处右键档位浮层选全部：「⋯」消失、全部图标回栏（栏内=名单）');
      } else {
        armFail7('档位挂点二', detail7);
      }

      // 臂8：数量回落自动回栏——探针逐枚退出，档位 5 下栏内跟随名单回落、「⋯」在名单
      // 落到 ≤5 时消失（机器图标数 M≥5 时名单到不了 5，退化为不变式断言并记 note）
      await cdpEval(TASKBAR_TITLE, `window.deck.bridge.invoke('taskbar/set-tray-overflow-limit', { limit: 5 })`);
      await sleep(600);
      let fell = false;
      let sawFallback = false;
      for (let round = 0; round < 14; round++) {
        roster7 = await rosterKeys();
        // 名单churn（机器图标进出）与渲染推帧之间有时序差：不一致时沉降 600ms 重读两拍再判
        let g = tape.latest('taskbar-geometry', (e) => e.trayIcons, { since: Date.now() - 6000 });
        let wantBar = Math.min(roster7.length, 5);
        let wantMore = roster7.length > 5;
        for (let settle = 0; settle < 2 && g
          && (g.trayIcons.length !== wantBar || !!g.trayOverflow !== wantMore); settle++) {
          await sleep(600);
          roster7 = await rosterKeys();
          g = tape.latest('taskbar-geometry', (e) => e.trayIcons, { since: Date.now() - 6000 });
          wantBar = Math.min(roster7.length, 5);
          wantMore = roster7.length > 5;
        }
        if (!g) break;
        if (g.trayIcons.length !== wantBar || !!g.trayOverflow !== wantMore) { fell = false; break; }
        fell = true;
        if (roster7.length <= 5) { sawFallback = true; break; }
        // 删一枚探针（在册的最末一枚）
        const live = probeKeys.filter((k) => roster7.includes(k));
        if (!live.length) break;
        const uid = PROBE_UIDS[probeKeys.indexOf(live[live.length - 1])];
        const nidDel = encodeNotifyIconData({ arch: 'x64', version: 3, hwnd: probe162.hwnd, uid,
          flags: 0, callbackMessage: 0, hicon: 0, uVersion: 0 });
        ShellNotifyIconW7(NIM_DELETE, nidDel);
        await sleep(900);
      }
      roster7 = await rosterKeys();
      const g8 = tape.latest('taskbar-geometry', (e) => e.trayIcons, { since: Date.now() - 6000 });
      if (fell) {
        rep.pass(`臂8 数量回落自动回栏（栏内=min(名单,5) 逐拍成立）${sawFallback && g8 ? `、「⋯」在名单回落到 5 时消失（终态栏内 ${g8.trayIcons.length} ⋯=${!!g8.trayOverflow}）` : `；机器图标 ${roster7.length} 枚 ≥ 档位 5，⋯ 消失正例已由臂7 全部档实证`}`);
      } else {
        armFail7('数量回落', `名单=${roster7.length} 栏内=${g8 ? g8.trayIcons.length : 'n/a'} ⋯=${g8 ? !!g8.trayOverflow : 'n/a'}`);
      }

      // 收尾：剩余探针拆除（异常路径 finally 兜底）
      for (const k of probeKeys) {
        const uid = PROBE_UIDS[probeKeys.indexOf(k)];
        const nidDel = encodeNotifyIconData({ arch: 'x64', version: 3, hwnd: probe162.hwnd, uid,
          flags: 0, callbackMessage: 0, hicon: 0, uVersion: 0 });
        ShellNotifyIconW7(NIM_DELETE, nidDel);
      }
    }

    // —— P8：托盘与溢出网格档位（工单244 新增；工单458 随动改写：溢出行→网格）：
    //        托盘图标 16px（1:1 直渲）+ 托盘格盒 28×28 + 溢出网格 5 列 36×36 格、
    //        16px 图标居中、悬停 title 在场 + 浮层恒宽 200（条目数变化两拍宽度不变）——
    // 断言形态照 49 电池 P13 的两路互证：CDP computed style（渲染层真实尺寸，单测断不到）
    // ＋ ready 存证帧（格矩形，坐标语义 = 格）。溢出网格在浮层页（DECK-TRAY-OVERFLOW）
    // 里读，格几何取 ready 存证的格矩形。
    // 探针：溢出格需要「名单 > 5」，且 5 列断言需溢出段 ≥5 格跨满列位——机器自身图标数
    // 不定，自注册 10 枚探针把名单量钉到确定性（P7 同款机制，探针窗复用 P7 的实例；
    // 原 6 枚在机器图标极少时溢出段 <5 格，5 列断言不成立——工单458 随动加量）。
    rep.beginSegment('P8');
    const since8 = Date.now();
    // 档位锚定 5（scope 定向轮单跑本段时不受 P7 档位臂残留影响，独立可跑）；跑前读基线
    // 供段尾复原（恒宽两拍会把档位切 3）
    const prevLimit8 = (() => {
      try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).taskbar?.trayOverflowLimit ?? 5; } catch { return 5; }
    })();
    await cdpEval(TASKBAR_TITLE, `window.deck.bridge.invoke('taskbar/set-tray-overflow-limit', { limit: 5 })`);
    await sleep(600); // 重拆 + 几何重报一拍
    const uids8 = Array.from({ length: 10 }, (_, i) => 0x2440001 + i);
    const hicon8 = Number(LoadIconW7(0, 32512));
    const probe8Keys = [];
    for (const uid of uids8) {
      const nid8 = encodeNotifyIconData({ arch: 'x64', version: 3, hwnd: probe162.hwnd, uid,
        flags: NIF_MESSAGE | NIF_ICON | NIF_TIP, callbackMessage: PROBE_CB, hicon: hicon8,
        tooltip: `DECK244-P${uid}`, uVersion: 0 });
      if (ShellNotifyIconW7(NIM_ADD, nid8)) probe8Keys.push(`${probe162.hwnd}:${uid}`);
    }
    rep.note(`P8 探针在册 ${probe8Keys.length}/${uids8.length}`);
    // 名单收编（面板把系统托盘图标收进栏内）→ 几何帧到位（栏内托盘格 + ⋯ 钮）
    const roster8 = async () => {
      const st = await cdpEval(TASKBAR_TITLE, `window.deck.bridge.invoke('taskbar/get-state', {})`);
      return (st && Array.isArray(st.tray)) ? st.tray.map((x) => x.key) : [];
    };
    let r8 = [];
    for (let i = 0; i < 20; i++) {
      r8 = await roster8();
      if (probe8Keys.length && probe8Keys.every((k) => r8.includes(k))) break;
      await sleep(400);
    }
    // 几何帧（格盒矩形）：渲染层只在**栏面几何变化**时重发（payload 未变即不发）——
    // 探针枚数增加不改变栏面（默认档 5 可见），故取「最新一帧」而不设时间门。
    const geo8 = await waitLastEvent('taskbar-geometry',
      (e) => e.trayIcons && e.trayIcons.length > 0 && e.trayOverflow, 8000, {});
    // 托盘图标显示档（CDP computed style）+ 1:1 直渲判据（源 < 16px 才挂 pixelated）
    let sizes8 = null;
    for (let i = 0; i < 10; i++) {
      sizes8 = await cdpEval(TASKBAR_TITLE, `(() => {
        const tray = [...document.querySelectorAll('.tb-tray-icon img')];
        const cs = (el, p) => (el ? getComputedStyle(el)[p] : null);
        return tray.map((t) => ({ w: cs(t,'width'), h: cs(t,'height'), nat: t.naturalWidth,
          px: t.classList.contains('tb-tray-px'), rendering: cs(t,'imageRendering') }));
      })()`);
      if (sizes8 && sizes8.length && sizes8.some((t) => t.nat > 0)) break;
      await sleep(400);
    }
    const traySizeOk8 = !!sizes8 && sizes8.length > 0 && sizes8.every((t) => t.w === '16px' && t.h === '16px');
    const loaded8 = (sizes8 || []).filter((t) => t.nat > 0);
    const pxOk8 = loaded8.every((t) => t.px === (t.nat < 16) && (t.px ? t.rendering === 'pixelated' : t.rendering !== 'pixelated'));
    const geoTrayOk8 = !!(geo8 && geo8.trayIcons && geo8.trayIcons.length > 0
      && Math.abs(geo8.trayIcons[0].w - 28) <= 2 && Math.abs(geo8.trayIcons[0].h - 28) <= 2);
    // 溢出网格（工单458 格断言）：开层后从浮层页读格 computed style（格 36×36、图标
    // 16px 居中、title 在场），格几何取 ready 存证的格矩形
    let cellInfo8 = null; // .ov-cell computed：{ w, h, img: { w, h }, title }
    let cells8 = null;    // ready8.rows 格矩形（x/y/w/h）
    let popW8 = 0;        // 档位 5 拍浮层实测宽（恒定 200 断言）
    let popupOk8 = false;
    let conv8 = null;
    const more8 = geo8 && geo8.trayOverflow;
    if (more8) {
      const pt8 = toPhys(more8.x + more8.w / 2, more8.y + more8.h / 2);
      conv8 = await convergeAt(pt8, tbHwnd7);
      win32.clickPhys(pt8.x, pt8.y, 'left');
      await sleep(700); // 沉降拍（红轮实证：show 后 ~100ms 内落点的点击整帧丢失）
      const ready8 = await waitLastEvent('taskbar-tray-overflow-ready',
        (e) => Array.isArray(e.rows) && e.rows.length > 0, 5000, { since: since8 });
      if (ready8) {
        cells8 = ready8.rows;
        popW8 = Number(ready8.w) || 0;
        cellInfo8 = await cdpEval('DECK-TRAY-OVERFLOW', `(() => {
          const cs = (el, p) => (el ? getComputedStyle(el)[p] : null);
          return [...document.querySelectorAll('.ov-cell')].map((c) => {
            const img = c.querySelector('img');
            return { w: cs(c,'width'), h: cs(c,'height'),
              img: img ? { w: cs(img,'width'), h: cs(img,'height'), nat: img.naturalWidth } : null,
              title: c.title || null };
          });
        })()`);
        popupOk8 = true;
      }
      rep.note(`P8 浮层开层 收敛=${conv8} 宽=${popW8} 格数=${cells8 ? cells8.length : 'n/a'}`);
    }
    // 恒宽两拍（工单458 验收标准：条目数变化宽度不变）——档位 5→3 溢出段变长，浮层在场
    // 拍 changed 重渲重报 ready（行优先格数 = 名单-3 > 名单-5 严格递增）；宽度应纹丝不动
    //（CSS 定值 200，与条目数无关）
    let popW8b = 0;
    if (popupOk8) {
      const since8b = Date.now();
      await cdpEval(TASKBAR_TITLE, `window.deck.bridge.invoke('taskbar/set-tray-overflow-limit', { limit: 3 })`);
      const ready8b = await waitLastEvent('taskbar-tray-overflow-ready',
        (e) => Array.isArray(e.rows) && e.rows.length > (cells8 ? cells8.length : 0), 6000, { since: since8b });
      if (ready8b) popW8b = Number(ready8b.w) || 0;
      rep.note(`P8 恒宽两拍 档5 宽=${popW8} 格=${cells8 ? cells8.length : 'n/a'}；档3 宽=${popW8b} 格=${ready8b ? ready8b.rows.length : 'n/a'}`);
    }
    const cellOk8 = !!cellInfo8 && cellInfo8.length > 0
      && cellInfo8.every((c) => c.w === '36px' && c.h === '36px'
        && c.img && c.img.w === '16px' && c.img.h === '16px' && !!c.title);
    const cellRectOk8 = !!cells8 && cells8.length > 0
      && cells8.every((r) => Math.abs(r.w - 36) <= 2 && Math.abs(r.h - 36) <= 2);
    // 5 列判据：列位（x）去重恰 5 个（≥5 格跨满 5 列；行数增加不增列位）
    const colsOk8 = !!cells8 && cells8.length >= 5
      && new Set(cells8.map((r) => Math.round(r.x))).size === 5;
    const widthOk8 = Math.abs(popW8 - 200) <= 2 && popW8b > 0 && Math.abs(popW8b - popW8) <= 2;
    if (traySizeOk8 && pxOk8 && geoTrayOk8 && popupOk8 && cellOk8 && cellRectOk8 && colsOk8 && widthOk8) {
      rep.pass(`P8 图标档位：托盘图标 ${sizes8.length} 枚均 16px（1:1 直渲判据：${loaded8.length ? (pxOk8 ? '通过' : '不符') : '未及（像素未到齐，软核验跳过）'}）、`
        + `托盘格盒 ${geo8.trayIcons[0].w}×${geo8.trayIcons[0].h}（期望 28×28）、`
        + `溢出网格 ${cellInfo8.length} 格 computed 均 36×36、图标 16px 居中、title 在场、`
        + `ready 格矩形均 36×36（±2）、列位恰 5 列、浮层宽档5=${popW8}/档3=${popW8b} 恒定（期望 200±2）`);
    } else {
      rep.fail(`P8 托盘尺寸=${JSON.stringify(sizes8)} 直渲判据=${pxOk8} 格盒=${JSON.stringify(geo8 && geo8.trayIcons && geo8.trayIcons[0])} `
        + `溢出格=${JSON.stringify(cellInfo8)} 格矩形=${JSON.stringify(cells8)} `
        + `列位=${cells8 ? new Set(cells8.map((r) => Math.round(r.x))).size : 'n/a'} `
        + `宽=${popW8}/${popW8b} 开层=${popupOk8}`);
    }
    // 收层：点浮层外（blur 收层）——不给用户留残留浮层
    if (popupOk8) {
      const center8 = { x: Math.round((dip.x + dip.width / 2) * scale), y: Math.round((dip.y + dip.height / 2) * scale) };
      win32.clickPhys(center8.x, center8.y, 'left');
      await waitLastEvent('taskbar-tray-overflow-closed', undefined, 3000, { since: since8 });
    }
    // 档位复原（恒宽两拍把档位切了 3；基线缺位时回默认 5——与内核缺省一致）
    try { await cdpEval(TASKBAR_TITLE, `window.deck.bridge.invoke('taskbar/set-tray-overflow-limit', { limit: ${JSON.stringify(prevLimit8)} })`); } catch { /* 条带已不在场 */ }
    // 探针拆除（异常路径 finally 兜底）
    for (const uid of uids8) {
      const nidDel8 = encodeNotifyIconData({ arch: 'x64', version: 3, hwnd: probe162.hwnd, uid,
        flags: 0, callbackMessage: 0, hicon: 0, uVersion: 0 });
      ShellNotifyIconW7(NIM_DELETE, nidDel8);
    }

    // —— P9 托盘常驻（工单462）：档位菜单「常驻管理」节勾选即写名单即生效/豁免溢出裁剪
    //        （档位只数非常驻、保持到达序原位）/解除即回档位账/跨面板重启保持——
    // 断言形态：真实右键挂点开档位菜单点常驻行（input-injection）+ config 落盘与
    // taskbar-geometry 栏面键序互证（system-state 面）+ taskbar-tray-pinned(-result)
    // 存证（event-evidence 面）。探针：常驻行需「名单 > 档位」才有裁剪面——自注册 7 枚
    // 探针钉名单量（P7/P8 同款机制，探针窗复用 P7 实例；tooltip DECK462-P<i> 特异命名，
    // 与机器真实图标零名字碰撞——名字兜底匹配不误挂真图标）。真机勾选蓝牙/耳机/电源的
    // 人眼验收不进电池（机器图标不定），由工单 462 真机轮 CDP 名单取证佐证。
    rep.beginSegment('P9');
    const since9 = Date.now();
    // 档位与常驻名单基线（段尾复原——本段切档 3、勾 3 枚探针）
    const prevLimit9 = (() => {
      try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).taskbar?.trayOverflowLimit ?? 5; } catch { return 5; }
    })();
    const prevPinned9 = (() => {
      try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).taskbar?.trayPinned ?? []; } catch { return []; }
    })();
    await cdpEval(TASKBAR_TITLE, `window.deck.bridge.invoke('taskbar/set-tray-overflow-limit', { limit: 5 })`);
    await sleep(600); // 重拆 + 几何重报一拍
    const uids9 = Array.from({ length: 7 }, (_, i) => 0x4620001 + i);
    const probe9Keys = [];
    for (const uid of uids9) {
      const nid9 = encodeNotifyIconData({ arch: 'x64', version: 3, hwnd: probe162.hwnd, uid,
        flags: NIF_MESSAGE | NIF_ICON | NIF_TIP, callbackMessage: PROBE_CB, hicon: Number(LoadIconW7(0, 32512)),
        tooltip: `DECK462-P${uid - 0x4620001}`, uVersion: 0 });
      if (ShellNotifyIconW7(NIM_ADD, nid9)) probe9Keys.push(`${probe162.hwnd}:${uid}`);
    }
    const probe9Names = probe9Keys.map((k, i) => `DECK462-P${i}`);
    // 名单收编确认（探针全在册才继续——P7 rosterKeys 同款）
    let roster9 = [];
    for (let i = 0; i < 20; i++) {
      roster9 = await rosterKeys();
      if (probe9Keys.length && probe9Keys.every((k) => roster9.includes(k))) break;
      await sleep(400);
    }
    rep.note(`P9 探针在册 ${probe9Keys.filter((k) => roster9.includes(k)).length}/${uids9.length} 名单=${roster9.length}`);
    // 档位菜单浮层锚点（P7 tierPopup7 同式——P7 的闭包锚在其 else 块内，本段自持一份；
    // opened/resized 窗 bounds 与 ready 行矩形两路配对，行几何按行 id 定位）
    const tierPopup9 = (since) => {
      const os = tape.all(undefined,
        (e) => e.type === 'taskbar-tier-menu-opened' || e.type === 'taskbar-tier-menu-resized', { since });
      let rd = tape.all('taskbar-tier-menu-ready', (e) => Array.isArray(e.rows), { since });
      if (!rd.length) rd = tape.all('taskbar-tier-menu-ready', (e) => Array.isArray(e.rows));
      return os.length && rd.length
        ? { since, bounds: os[os.length - 1].bounds, rows: rd[rd.length - 1].rows, w: Number(rd[rd.length - 1].w) || 0 }
        : null;
    };
    // 右键开浮层（三试，P7 openTierPopup7 同款抖动收敛；开层判据 = 四档行齐列）
    const openTierPopup9 = async (ptOf) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const pt = ptOf();
        if (!pt) return null;
        await conv(pt); // 到靶停拍（convergeAt 内含热区翻转窗口）
        const since = Date.now();
        win32.clickPhys(pt.x, pt.y, 'right');
        for (let i = 0; i < 12; i++) {
          await sleep(200);
          const pop = tierPopup9(since);
          if (pop && pop.rows.filter((r) => String(r.id || '').startsWith('tier-')).length === 4) return pop;
        }
      }
      return null;
    };
    const geo9a = await waitLastEvent('taskbar-geometry', (e) => e.trayOverflow, 8000, {});
    let arm1 = false, detail9a = '';
    let pinRow0 = null, pinRow1 = null;
    let pinRowCount9 = 0;
    if (!geo9a) {
      detail9a = '无 trayOverflow 几何（⋯ 未渲染）';
    } else {
      const morePt9 = toPhys(geo9a.trayOverflow.x + geo9a.trayOverflow.w / 2, geo9a.trayOverflow.y + geo9a.trayOverflow.h / 2);
      const pop9 = await openTierPopup9(() => morePt9);
      detail9a = `档位浮层=${pop9 ? '在场' : '缺'}`;
      if (pop9) {
        pinRow0 = pop9.rows.find((r) => r.id === `pin:${probe9Keys[0]}`);
        pinRow1 = pop9.rows.find((r) => r.id === `pin:${probe9Keys[1]}`);
        const pinRows9 = pop9.rows.filter((r) => String(r.id || '').startsWith('pin:'));
        // 行集对账名单取「开层后现读」——探针注册后名单仍在收编窗口，前读会与菜单渲染
        // 时的行集错一拍（首跑实证 roster 前读 29、开层时 30，行数对账误红）
        const rosterNow9 = await rosterKeys();
        detail9a += ` 常驻行=${pinRows9.length}/${rosterNow9.length} tier 行=${pop9.rows.filter((r) => String(r.id || '').startsWith('tier-')).length}`;
        // 臂1a：常驻管理节列出全部名单（pin 行数 = 名单数，含栏内+溢出内——工单462 验收标准①）
        const sectionOk = pinRows9.length === rosterNow9.length;
        // 臂1b：点行勾选即写名单即生效（存证回执 + config 落盘；两行连击不关层——keepOpen）
        let result1 = null;
        const clickPinRow9 = async (row) => {
          const pt = {
            x: Math.round((pop9.bounds.x + pop9.w / 2) * scale),
            y: Math.round((pop9.bounds.y + row.y + row.h / 2) * scale),
          };
          win32.moveMousePhys(pt.x, pt.y);
          await sleep(250);
          win32.clickPhys(pt.x, pt.y, 'left');
          await sleep(300); // changed 回推重渲一拍（keepOpen 面行集刷新）
          const pop9b = tierPopup9(pop9.since);
          return pop9b && pop9b.rows.find((r) => r.id === row.id);
        };
        if (pinRow0) {
          const still = await clickPinRow9(pinRow0);
          result1 = await tape.wait('taskbar-tray-pinned-result', (e) => e.key === probe9Keys[0] && e.pinned === true && e.ok && e.t >= Date.now() - 6000, { timeoutMs: 5000 });
          detail9a += ` 行点击后浮层=${still ? '在场(keepOpen)' : '关'}`;
        }
        let result1b = null;
        if (pinRow1 && result1) {
          await clickPinRow9(pinRow1);
          result1b = await tape.wait('taskbar-tray-pinned-result', (e) => e.key === probe9Keys[1] && e.pinned === true && e.ok && e.t >= Date.now() - 6000, { timeoutMs: 5000 });
        }
        const disk9 = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        const disk9pinned = disk9.taskbar?.trayPinned ?? [];
        arm1 = sectionOk && !!result1 && !!result1b
          && disk9pinned.some((r) => r.id === probe9Keys[0] && r.name === probe9Names[0])
          && disk9pinned.some((r) => r.id === probe9Keys[1] && r.name === probe9Names[1]);
        detail9a += ` 回执=${!!result1}/${!!result1b} 落盘=${JSON.stringify(disk9pinned)}`;
        pinRowCount9 = pinRows9.length;
        // 收层：点浮层外（不给后续臂留残留浮层）
        const center9 = { x: Math.round((dip.x + dip.width / 2) * scale), y: Math.round((dip.y + dip.height / 2) * scale) };
        win32.clickPhys(center9.x, center9.y, 'left');
        await sleep(400);
      }
    }
    if (arm1) {
      rep.pass(`臂1 常驻管理节列出全部名单（栏内+溢出内 ${pinRowCount9} 行）、点行勾选即写名单即生效（config 落盘 {id,name} 双保险）、勾选连击不关层`);
    } else {
      rep.fail(`P9[臂1 勾选即生效] ${detail9a}`);
    }

    // 臂2：豁免溢出裁剪 + 档位只数非常驻 + 保持到达序原位——钉 2 枚探针、档位切 3
    //（合法档最小 3），栏面键序逐枚对账（期望序 = 名单序中「常驻豁免 + 前 3 枚非常驻」
    // 的插序序列，栏内 5 枚 > 档位 3 即「只数非常驻」的直接证据）
    let arm2 = false;
    let detail9b = `探针=${probe9Keys.filter((k) => roster9.includes(k)).length}`;
    try {
      const sinceInvoke9b = Date.now();
      await cdpEval(TASKBAR_TITLE, `window.deck.bridge.invoke('taskbar/set-tray-overflow-limit', { limit: 3 })`);
      await sleep(800);
      const roster9b = await rosterKeys();
      const pinnedSet = new Set([probe9Keys[0], probe9Keys[1]].filter((k) => roster9b.includes(k)));
      let kept = 0;
      const expected9 = roster9b.filter((k) => pinnedSet.has(k) || kept++ < 3);
      const geo9b = await waitLastEvent('taskbar-geometry', (e) => e.trayIcons && e.trayIcons.length >= 2, 8000, { since: sinceInvoke9b });
      const barKeys9 = geo9b ? geo9b.trayIcons.map((t) => t.key) : [];
      arm2 = geo9b && !!geo9b.trayOverflow
        && JSON.stringify(barKeys9) === JSON.stringify(expected9)
        && barKeys9.length === expected9.length;
      detail9b += ` 期望序=${JSON.stringify(expected9)} 栏内序=${JSON.stringify(barKeys9)} ⋯=${!!(geo9b && geo9b.trayOverflow)}`;
      const disk9b = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      arm2 = arm2 && (disk9b.taskbar?.trayPinned ?? []).length === 2;
    } catch (e9) {
      detail9b += ` 异常=${e9.message}`;
    }
    if (arm2) {
      rep.pass('臂2 常驻豁免溢出裁剪：档位 3 只数非常驻（栏内 = 2 常驻 + 3 非常驻，5 > 档位 3）、到达序原位不重排（栏面键序逐枚对账）、「⋯」收余量');
    } else {
      rep.fail(`P9[臂2 豁免/计数/原位] ${detail9b}`);
    }

    // 臂3：解除常驻即回档位账——摘 1 枚，栏面跟随回 4 枚（3 非常驻 + 1 常驻）
    let arm3 = false;
    let detail9c = '';
    try {
      const sinceInvoke9c = Date.now();
      await cdpEval(TASKBAR_TITLE, `window.deck.bridge.invoke('taskbar/set-tray-pinned', { id: ${JSON.stringify(probe9Keys[1])}, name: ${JSON.stringify(probe9Names[1])}, pinned: false })`);
      await sleep(800);
      const roster9c = await rosterKeys();
      const pinned3 = new Set([probe9Keys[0]].filter((k) => roster9c.includes(k)));
      let kept3 = 0;
      const expected9c = roster9c.filter((k) => pinned3.has(k) || kept3++ < 3);
      const geo9c = await waitLastEvent('taskbar-geometry', (e) => e.trayIcons && e.trayIcons.length >= 2, 8000, { since: sinceInvoke9c });
      const barKeys9c = geo9c ? geo9c.trayIcons.map((t) => t.key) : [];
      const disk9c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      arm3 = JSON.stringify(barKeys9c) === JSON.stringify(expected9c)
        && (disk9c.taskbar?.trayPinned ?? []).length === 1
        && disk9c.taskbar.trayPinned[0].id === probe9Keys[0];
      detail9c += ` 期望=${JSON.stringify(expected9c)} 栏内=${JSON.stringify(barKeys9c)} 落盘=${JSON.stringify(disk9c.taskbar?.trayPinned ?? [])}`;
    } catch (e9c) {
      detail9c += ` 异常=${e9c.message}`;
    }
    if (arm3) {
      rep.pass('臂3 解除常驻即回档位账：名单摘条、栏面回「3 非常驻 + 1 常驻」、落盘同步');
    } else {
      rep.fail(`P9[臂3 解除回账] ${detail9c}`);
    }

    // 臂4：跨面板重启保持——再钉 1 枚（账 2 条）、P6 同款强退重拉，重启后账原样、
    // 豁免语义照走（重拉后切档 5 真变档取帧：栏内 = 2 常驻 + 5 非常驻，7 > 档位 5）
    let arm4 = false;
    let detail9d = '';
    try {
      await cdpEval(TASKBAR_TITLE, `window.deck.bridge.invoke('taskbar/set-tray-pinned', { id: ${JSON.stringify(probe9Keys[2])}, name: ${JSON.stringify(probe9Names[2])}, pinned: true })`);
      await sleep(400);
      await stopPanelOrAbort(rep); // 工单211：验证强退（gone=false 即中止信号）
      panelPid = 0;
      await sleep(1200);
      const since9d = Date.now();
      handle.launch({ mode: 'accept', cdpPort: CDP_PORT, stdio: 'ignore', extraEnv: PANEL_ENV_459 });
      const boot9 = await tape.wait('boot', undefined, { since: since9d, timeoutMs: 15000 });
      if (!boot9) throw new Error('P9 重拉面板子进程未上报 boot');
      panelPid = boot9.pid;
      await handle.waitWindow({ title: TASKBAR_TITLE, timeoutMs: 12000 });
      // 名单重建确认：控制器探针窗仍在场，面板重启后收编广播回填（P7 收编轮询同款）
      for (let i = 0; i < 20; i++) {
        roster9 = await rosterKeys();
        if (probe9Keys.length && probe9Keys.every((k) => roster9.includes(k))) break;
        await sleep(400);
      }
      const st9 = await cdpEval(TASKBAR_TITLE, `window.deck.bridge.invoke('taskbar/get-state', {})`);
      const pinned9 = (st9 && Array.isArray(st9.trayPinned)) ? st9.trayPinned : [];
      const disk9d = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      const expectLedger = [probe9Keys[0], probe9Keys[2]].map((k) => ({ id: k, name: probe9Names[probe9Keys.indexOf(k)] }));
      const ledgerOk = JSON.stringify(pinned9.map((r) => ({ id: r.id, name: r.name }))) === JSON.stringify(expectLedger)
        && JSON.stringify((disk9d.taskbar?.trayPinned ?? []).map((r) => ({ id: r.id, name: r.name }))) === JSON.stringify(expectLedger);
      // 切档 5 真变档必发帧（重拉时盘上已是 3——再发 3 是幂等空转无几何帧，首跑二轮实证）；
      // 豁免照走 = 栏内 7 枚（2 常驻 + 5 非常驻）> 档位 5，「⋯」收余量
      const sinceInvoke9d = Date.now();
      await cdpEval(TASKBAR_TITLE, `window.deck.bridge.invoke('taskbar/set-tray-overflow-limit', { limit: 5 })`);
      await sleep(800);
      const roster9d = await rosterKeys();
      const pinned4 = new Set([probe9Keys[0], probe9Keys[2]].filter((k) => roster9d.includes(k)));
      let kept4 = 0;
      const expected9d = roster9d.filter((k) => pinned4.has(k) || kept4++ < 5);
      const geo9d = await waitLastEvent('taskbar-geometry', (e) => e.trayIcons && e.trayIcons.length >= 2, 8000, { since: sinceInvoke9d });
      const barKeys9d = geo9d ? geo9d.trayIcons.map((t) => t.key) : [];
      arm4 = ledgerOk && !!geo9d && !!geo9d.trayOverflow
        && JSON.stringify(barKeys9d) === JSON.stringify(expected9d);
      detail9d += ` 重启账=${JSON.stringify(pinned9)} 落盘=${JSON.stringify(disk9d.taskbar?.trayPinned ?? [])} 期望序=${JSON.stringify(expected9d)} 栏内=${JSON.stringify(barKeys9d)} ⋯=${!!(geo9d && geo9d.trayOverflow)}`;
    } catch (e9d) {
      detail9d += ` 异常=${e9d.message}`;
    }
    if (arm4) {
      rep.pass('臂4 跨面板重启保持：常驻账原样恢复（state+config 双证）、重拉后切档 5 豁免照走（栏内 = 2 常驻 + 5 非常驻，7 > 档位 5）');
    } else {
      rep.fail(`P9[臂4 重启保持] ${detail9d}`);
    }

    // 段尾复原：档位回基线、常驻名单清空（本段 3 枚探针钉账逐一解除——探针拆除后账内
    // 记录会成幽灵，恢复「名单不产生幽灵图标」的无残留口径）、探针拆除
    try { await cdpEval(TASKBAR_TITLE, `window.deck.bridge.invoke('taskbar/set-tray-overflow-limit', { limit: ${JSON.stringify(prevLimit9)} })`); } catch { /* 条带已不在场 */ }
    for (let i = 0; i < probe9Keys.length; i++) {
      try { await cdpEval(TASKBAR_TITLE, `window.deck.bridge.invoke('taskbar/set-tray-pinned', { id: ${JSON.stringify(probe9Keys[i])}, name: ${JSON.stringify(probe9Names[i])}, pinned: false })`); } catch { /* 面板已退场 */ }
    }
    for (const uid of uids9) {
      const nidDel9 = encodeNotifyIconData({ arch: 'x64', version: 3, hwnd: probe162.hwnd, uid,
        flags: 0, callbackMessage: 0, hicon: 0, uVersion: 0 });
      ShellNotifyIconW7(NIM_DELETE, nidDel9);
    }
    // 基线名单非空的兜底（上轮异常残留）：基线恢复逐条回写（正常轮 prevPinned9 为空，零写）
    try {
      if (prevPinned9.length) {
        for (const r of prevPinned9) {
          await cdpEval(TASKBAR_TITLE, `window.deck.bridge.invoke('taskbar/set-tray-pinned', { id: ${JSON.stringify(r.id)}, name: ${JSON.stringify(r.name ?? '')}, pinned: true })`);
        }
      }
    } catch { /* 面板已退场 */ }

    // —— P10 硬件摘要定宽槽位（工单459）：喂不同位数读数，taskbar-geometry 右组矩形宽度不变 ——
    // 断言形态（spec #457 测试裁决：总宽恒定经 taskbar-geometry 帧在电池断言）：硬件仪表 stub
    // （DECK_HW_GAUGE_STUB=1，main/index.ts accept 双门禁）把 gauges 换成控制器脚本文件现读——
    // 真 1Hz 管线（bridge.push → taskbar/status → applyStatus → formatMetric → 定宽槽位 DOM）
    // 原样走通只换数据源。窄/宽两拍读数位数差拉满（1 位百分位 + 短 KB ↔ 3 位百分位 + 满 5 位
    // KB / MB 进位），taskbar-right-status 数值口径实机取证（含 MB 进位）；几何帧由左侧系统钮
    // set-button-hidden 无害翻转触发（载荷变化在左组，右组右锚定不受牵连；窄拍翻 tasks、宽拍翻
    // start——两拍翻不同的钮，同值幂等不重发几何帧，P9 实证）。右侧噪声隔离：托盘名单/像素键
    // 两拍同名单时右组 pill 宽必须不变；名单变动的轮次以摘要/音量/时钟三格宽对账为准并留痕。
    rep.beginSegment('P10');
    let p10ok = false;
    let detail10 = '';
    const gaugeFile10 = HW_GAUGE_FILE;
    let metricsBase10 = null; // 段尾复原（P6 把勾选子集持久化成 ['cpu','ram']——本段要五项全勾）
    try {
      if (!gaugeFile10) throw new Error('HW_GAUGE_FILE 缺位');
      // 基线自愈：两系统钮须在场（几何帧触发器翻左组；电池自持隔离 config 常态全在场）
      const baseState10 = await cdpEval(TASKBAR_TITLE, `window.deck.bridge.invoke('taskbar/get-state', {})`);
      const hiddenBase10 = Array.isArray(baseState10 && baseState10.hiddenButtons) ? baseState10.hiddenButtons : [];
      for (const id of hiddenBase10) {
        await cdpEval(TASKBAR_TITLE, `window.deck.bridge.invoke('taskbar/set-button-hidden', { id: ${JSON.stringify(id)}, hidden: false })`);
      }
      if (hiddenBase10.length) await sleep(600);
      // 五项全勾（首跑红轮实证：P6 把子集持久化成 ['cpu','ram']，摘要格只剩两段，
      // net-down/net-up 槽位缺席——喂速率读数无处可落）。段尾复原基线子集。
      metricsBase10 = (baseState10 && Array.isArray(baseState10.metrics)) ? baseState10.metrics : ['cpu', 'gpu', 'ram', 'net-down', 'net-up'];
      await cdpEval(TASKBAR_TITLE, `window.deck.bridge.invoke('taskbar/set-metrics', { metrics: ['cpu', 'gpu', 'ram', 'net-down', 'net-up'] })`);
      let segs10 = 0;
      for (let i = 0; i < 10; i++) {
        segs10 = await cdpEval(TASKBAR_TITLE, `document.querySelectorAll('#hw-summary .tb-seg').length`);
        if (segs10 === 5) break;
        await sleep(400);
      }
      if (segs10 !== 5) throw new Error(`五项段未齐（在场 ${segs10}/5）`);
      const expect10 = (g) => ({
        cpu: `CPU ${Math.round(g.cpu)}%`,
        gpu: `GPU ${Math.round(g.gpu_usage)}%`,
        ram: `RAM ${Math.round(g.memory)}%`,
        'net-down': g.download_speed >= 1000 ? `DL ${(g.download_speed / 1000).toFixed(2)}MB/s` : `DL ${g.download_speed.toFixed(2)}KB/s`,
        'net-up': g.upload_speed >= 1000 ? `UP ${(g.upload_speed / 1000).toFixed(2)}MB/s` : `UP ${g.upload_speed.toFixed(2)}KB/s`,
      });
      const feed10 = async (g) => {
        fs.writeFileSync(gaugeFile10, JSON.stringify(g), 'utf8');
        const want = expect10(g);
        const since = Date.now();
        return { want, ev: await waitLastEvent('taskbar-right-status',
          (e) => e.values && Object.entries(want).every(([k, v]) => e.values[k] === v), 8000, { since }) };
      };
      const geoViaToggle10 = async (buttonId) => {
        const t = Date.now();
        await cdpEval(TASKBAR_TITLE, `window.deck.bridge.invoke('taskbar/set-button-hidden', { id: ${JSON.stringify(buttonId)}, hidden: true })`);
        const frame = await waitLastEvent('taskbar-geometry',
          (e) => e.rightPill && Array.isArray(e.rightCells) && Array.isArray(e.buttons), 8000, { since: t });
        await cdpEval(TASKBAR_TITLE, `window.deck.bridge.invoke('taskbar/set-button-hidden', { id: ${JSON.stringify(buttonId)}, hidden: false })`);
        await sleep(400); // 复原拍（载荷回基线，下一拍翻另一钮必发帧）
        return frame;
      };
      const cellOf10 = (frame, id) => (frame.rightCells || []).find((c) => c.id === id) || null;

      // 窄拍：1 位百分位 + 短速率（既有 'DL 1.23KB/s' 口径实机取证）
      const narrow10 = { cpu: 9, gpu_usage: 8, memory: 46, download_speed: 1.23, upload_speed: 0.5 };
      const a10 = await feed10(narrow10);
      const frameA = a10.ev ? await geoViaToggle10('tasks') : null;
      // 宽拍：3 位百分位 + 满 5 位 KB / MB 进位（速率槽位最宽形态）
      const wide10 = { cpu: 100, gpu_usage: 87, memory: 99, download_speed: 999.99, upload_speed: 125500 };
      const b10 = await feed10(wide10);
      const frameB = b10.ev ? await geoViaToggle10('start') : null;
      detail10 += `窄拍值=${a10.ev ? JSON.stringify(a10.ev.values) : '未达'} 宽拍值=${b10.ev ? JSON.stringify(b10.ev.values) : '未达'}`;

      // 槽位与等宽数字真机证（CDP computed style，P8 同款）：tabular-nums / 右对齐 / 定宽三件
      const slotStyle10 = await cdpEval(TASKBAR_TITLE, `(() => {
        const cs = (el, p) => (el ? getComputedStyle(el)[p] : null);
        return ['cpu', 'net-down'].map((m) => {
          const el = document.querySelector('#hw-summary .tb-seg[data-metric="' + m + '"]');
          return el ? { m, tabular: cs(el, 'fontVariantNumeric'), align: cs(el, 'textAlign'), minWidth: cs(el, 'minWidth') } : null;
        });
      })()`);
      const styleOk10 = Array.isArray(slotStyle10) && slotStyle10.length === 2 && slotStyle10.every((s) => s
        && String(s.tabular).includes('tabular-nums') && s.align === 'right' && parseFloat(s.minWidth) > 0);

      // 两拍矩形对账：摘要/音量/时钟格宽逐项恒等（定宽槽位的直接证据）；右组 pill 宽在托盘
      // 名单两拍同名单时也须恒等（真机噪声隔离：名单变动轮以格宽对账为准并留痕）
      const rects10 = (() => {
        if (!frameA || !frameB) return { ok: false, why: '几何帧缺' };
        const rows = [];
        for (const id of ['hw-summary', 'volume', 'clock']) {
          const ca = cellOf10(frameA, id);
          const cb = cellOf10(frameB, id);
          if (!ca || !cb) return { ok: false, why: `rightCells 缺 ${id}` };
          rows.push(`${id} ${ca.w.toFixed(2)}→${cb.w.toFixed(2)}`);
          if (Math.abs(ca.w - cb.w) > 0.01) return { ok: false, why: `${id} 格宽变 ${ca.w}→${cb.w}` };
        }
        const trayA = (frameA.trayIcons || []).map((t) => t.key);
        const trayB = (frameB.trayIcons || []).map((t) => t.key);
        const traySame = JSON.stringify(trayA) === JSON.stringify(trayB);
        const pillSame = Math.abs(frameA.rightPill.w - frameB.rightPill.w) <= 0.01;
        if (!traySame && !pillSame) return { ok: false, why: `托盘名单变动(${trayA.length}→${trayB.length})且右组宽变 ${frameA.rightPill.w}→${frameB.rightPill.w}` };
        return { ok: true, why: `${rows.join(' ; ')}；右组 pill ${frameA.rightPill.w.toFixed(2)}→${frameB.rightPill.w.toFixed(2)}（托盘两拍同名单=${traySame}）` };
      })();
      p10ok = !!a10.ev && !!b10.ev && !!frameA && !!frameB && styleOk10 && rects10.ok;
      detail10 += ` 槽位=${JSON.stringify(slotStyle10)} 矩形对账=${rects10.why}`;
    } catch (e10) {
      detail10 += ` 异常=${e10.message}`;
    } finally {
      try { fs.unlinkSync(gaugeFile10); } catch { /* 本就缺位 */ }
      // 勾选子集复原（本段五项全勾过——回基线，不给 P6 之后的重跑轮留漂移）
      try {
        if (metricsBase10) await cdpEval(TASKBAR_TITLE, `window.deck.bridge.invoke('taskbar/set-metrics', { metrics: ${JSON.stringify(metricsBase10)} })`);
      } catch { /* 面板已退场 */ }
    }
    if (p10ok) {
      rep.pass(`P10 硬件摘要定宽槽位：窄/宽两拍读数（CPU 9%↔100%、DL 1.23KB/s↔999.99KB/s、UP 0.50KB/s↔125.50MB/s 含 MB 进位）taskbar-right-status 口径实机取证、tb-seg tabular-nums+右对齐+定宽槽位 computed 三证、taskbar-geometry 右组矩形与摘要/音量/时钟格宽两拍不变`);
    } else {
      rep.fail(`P10[定宽槽位] ${detail10}`);
    }
  } catch (err) {
    rep.fail(`电池异常: ${err && err.stack || err}`);
  } finally {
    if (probe162) probe162.destroy();
    if (spawnedP7) spawnSync('taskkill', ['/PID', String(spawnedP7.pid), '/T', '/F'], { stdio: 'ignore' });
    if (notepad) spawnSync('taskkill', ['/PID', String(notepad.pid), '/T', '/F'], { stdio: 'ignore' });
    // 工单211：收尾清场归句柄验证强退——gone=false 只入环境降责账、**不中止**
    // （清场不掩盖真结局；中止会拦住 finish() → 控制器不退 → 验收槽租约挂死）
    const cleared = await handle.stop();
    if (cleared && cleared.gone === false) {
      rep.exclude(`清场核验：面板强退失败：强杀后有界等待内仍存活（pid=${cleared.pidsLeft.join(', ')}）——需重启清障`,
        '清场后仍有面板进程存活', 'panel-forcekill');
    }
    // config 三态还原（工单124）：原本无文件则删掉电池落的最小桩（worktree 首跑场景）
    restoreConfig(originalConfig);
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
