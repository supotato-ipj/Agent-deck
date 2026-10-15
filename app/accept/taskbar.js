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
//   P15 栏分组布局重排（工单159）：开始组钉条带左缘、应用组在 [开始组右缘, 右组左缘]
//      带内落位（不与邻组重叠）、右组与细条位置不变——几何存证帧与 CDP computed style
//      互证；居中语义随工单190 移交 P15B（原「空带居中+随带回正」断言退役）
//   P15B 屏幕中心线锚定（工单190，ADR-0013 决策2）：应用组 pill 中心对齐屏幕水平中心线
//      （容差 ±2.5px 段内注明），藏/显 TaskView、推荐位移除/恢复、托盘溢出档位切换三路
//      邻居宽度驱动中心不变；图标增多向两侧对称扩张；全程带内不越界（夹取围栏）
//   P21 多窗选窗浮层（工单196）：cmd 副本 start 双开（/K 驻留+title 定名）——左键图标
//   出选窗浮层 DECK-TASKBAR-WINS-MENU（行集=2/行身份=hwnd/标题断言）→ 点行选窗存证+
//   前台对账+行点即收 → 点外即收（时钟格转达 strip-click）
//   P16 推荐组交互主体（工单160）：五条 usage 种子探针确定性占满推荐位（先于面板种入
//      ——usage 打分只在服务构造时读盘），真机六臂——图标化上限5（.tb-rec 44 格/32 图标
//      img/首字母占位，无显示名文本残留）、左键启动（真点击→rec-click 存证→notepad 副本
//      真窗口出场）、右键三行菜单（手钉到任务栏/从推荐栏移除/打开文件位置，工单161）+手钉
//      即时迁移（推荐组消失
//      +应用组手钉段前位出现）、真 OLE 拖拽组内换位（显式序压过分数序）、跨组升手钉
//      （recs→apps 落点条目前插入）、解除手钉随下拍回池；痕迹三处在 finally 摘除
//   P17 推荐组移除名单（工单161）：持久排除 + 名次递补 + 空白右键恢复 + 重启保持
//   P18 应用组统一序列默认落位（工单189，ADR-0013）：排序键与 z 序快照脱钩——
//      反复切换前台应用组位次纹丝不动；新面孔追加最右/全关消失/复启回最右；
//      钉入原地转正（手钉段末位=落最后一个手钉之后，安静栏面即位次不动）、
//      已钉应用开新窗并入钉图标呈运行态、关闭后不消失、解除未运行消失、
//      解除在运行原地转运行。探针 = csc 现编译 WinForms 最小窗副本×3（自有探针：
//      窗直属探针进程、镜像名唯一、真多开；选型取证见 seedP18Probes 注），位次读数
//      = get-state 的 apps 数组（编排序权威真源），taskbar-geometry 几何帧互证。
//   P19 推荐组独立漂浮 pill（工单192）：#pill-recs 独立容器界内落位与组间隙、开始组零残留、
//      两组显隐解耦（藏两钮推荐组独立在场并退条带左缘内衬 / 推荐位清空推荐组不渲染、回池复原）
//   P20 全量拖拽三断点（工单195，ADR-0013 全量自由拖拽落地）：真 OLE 拖拽臂 apps→apps
//      （现行电池无此臂，三断点曾因此漏掉）——A 全条目接线（手钉拖到仅运行图标上，
//      before 语义不被容器守卫静默吞掉）、B 运行段会话拖位+渲染冻结（中程 CDP 强推
//      changed，被拖节点 expando 同一性保持=无闪烁无回弹；drag-start/drag-drop/
//      drag-result 三存证组合为分诊判据）、C 跨组拖拽+组间缝隙松手（缝隙中停拍 drop
//      不丢；拖拽窗口 hotzone-leave=0 = 热区持门存证）、E 拖拽失败可见反馈（未钉运行
//      拖到推荐组=服务层确定性拒返，toast 在场+文案断言）、D1/D2 拖位持久化两半
//      （D1 臂A 钉入前重启=运行拖位回默认序；D2 末尾重启=手钉拖位落盘记住、存储无
//      运行序段=会话态不落盘；q3 钉入后只在手钉段，两半各配一次重启）。
//      探针复用 P18 的 csc WinForms 副本×3。
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

/** 最新一帧几何存证（渲染层在 pill/按钮/推荐位/应用组矩形变化时补发 taskbar-geometry） */
function latestGeometry(fallback) {
  const evs = readEvents().filter((e) => e.type === 'taskbar-geometry');
  return evs.length ? evs[evs.length - 1] : fallback;
}

/** 等几何安静窗口再取点击坐标：推荐位随 1Hz 数据面快照后到位会推开始组 pill 移位，
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

// —— 弹窗菜单浮层锚点（工单196 五面迁浮层窗）——
// 行矩形取 opened/resized（窗 bounds，屏幕 DIP）与 ready（rows 带 id/label/y/h 相对客户
// 区）两路配对——勿用 settle 静态几何（6fab89d 教训：托盘 churn 会重居中）。family =
// 存证事件家族前缀（taskbar-rec-menu / taskbar-blank-menu / taskbar-tier-menu /
// taskbar-wins-menu / taskbar-app-menu）。窗常驻（hide 不销）事件流跨段累积——所有取数
// 必须以开层拍 since 为下界，防上一段同族浮层的旧帧串门。
const popupAnchored = (family) => (since) => {
  const os = readEvents().filter((e) => e.t >= since
    && (e.type === `${family}-opened` || e.type === `${family}-resized`));
  const rd = readEvents().filter((e) => e.type === `${family}-ready` && e.t >= since && Array.isArray(e.rows));
  return os.length && rd.length
    ? { since, bounds: os[os.length - 1].bounds, rows: rd[rd.length - 1].rows, w: Number(rd[rd.length - 1].w) || 0 }
    : null;
};

/** 右键开浮层核验重试（右键偶发不开菜单——离位刷新热区+重取 settle 几何再试，≤3 试；
 * 到靶停拍 250ms 同 P16⑤ 热区开门先例）。命中即返回浮层锚（含 since 供行点击续用）。 */
const rightClickPopupVerify = async (ptOf, family, minRows) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const pt = ptOf();
    if (!pt) return null;
    win32.moveMousePhys(pt.x, pt.y);
    await sleep(250);
    const since = Date.now();
    win32.clickPhys(pt.x, pt.y, 'right');
    for (let i = 0; i < 12; i++) {
      await sleep(200);
      const pop = popupAnchored(family)(since);
      if (pop && pop.rows.length >= minRows) return pop;
    }
    win32.moveMousePhys(pt.x, pt.y - 60);
    await sleep(300);
  }
  return null;
};

/** 浮层行点击核验重试（点行也可能撞热区轮询窗/新窗输入路由——证据 3s 不来就重查行矩形
 * 再点，≤3 试；行物理坐标 = 窗 bounds + ready 行偏移，直乘 scale 不叠条带 rect，P16⑥
 * 先例同式）。返回动作存证事件（供调用方对账身份）。 */
const clickPopupRowVerify = async (family, since, rowId, evidenceType, evidencePred, scale) => {
  for (let i = 0; i < 3; i++) {
    const pop = popupAnchored(family)(since);
    const row = pop ? pop.rows.find((r) => r.id === rowId) : null;
    if (!row) return null;
    // 行物理坐标 = 窗 bounds（DIP）+ ready 行偏移直乘 scale（面板子进程主屏原点 (0,0)）
    const pt = {
      x: Math.round((pop.bounds.x + pop.w / 2) * scale),
      y: Math.round((pop.bounds.y + row.y + row.h / 2) * scale),
    };
    win32.moveMousePhys(pt.x, pt.y);
    await sleep(250);
    win32.clickPhys(pt.x, pt.y, 'left');
    const ev = await waitEvent(evidenceType, evidencePred, 3000);
    if (ev) return ev;
  }
  return null;
};

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

// —— P14 托盘回放探针（工单164）：控制器进程自建消息窗 + 自注册 v0/v4 两枚托盘图标，
// 把「宿主按协商版本合成的回调负载真实到达目标应用窗口」收进电池断言。口径 = MSDN
// NOTIFYICONDATAW uCallbackMessage 备注（#163 取证坐实产品 v0 wParam/lParam 互换为
// 全哑主因）：v0 wparam=uID/lparam=鼠标消息（左 0x0202/右 0x0205）；v4 wparam=
// MAKELPARAM(x,y) 锚点/lparam=(uID<<16)|事件（右键 WM_CONTEXTMENU=0x007B）。
// 探针窗的 wndProc 记录收到的帧（msg/wp/lp），回放臂断言存证事件与收帧逐字段一致。
const shell32 = koffi.load('shell32.dll');
const ShellNotifyIconW = shell32.func('bool __stdcall Shell_NotifyIconW(uint32 dwMessage, void *nid)');
const kernel32Tb = koffi.load('kernel32.dll');
const GetModuleHandleW164 = kernel32Tb.func('uintptr_t __stdcall GetModuleHandleW(uintptr_t name)');
const LoadIconW164 = user32.func('uintptr_t __stdcall LoadIconW(uintptr_t hInst, uintptr_t name)');
koffi.proto('__stdcall', 'Deck164WndProc', 'intptr_t', ['uintptr_t', 'uint32', 'uintptr_t', 'intptr_t']);
const DECK164_WNDCLASS = koffi.struct('Deck164WndClassW', {
  cbSize: 'uint32', style: 'uint32', lpfnWndProc: 'Deck164WndProc *',
  cbClsExtra: 'int32', cbWndExtra: 'int32', hInstance: 'uintptr_t',
  hIcon: 'uintptr_t', hCursor: 'uintptr_t', hbrBackground: 'uintptr_t',
  lpszMenuName: 'uintptr_t', lpszClassName: 'char16_t *', hIconSm: 'uintptr_t',
});
const RegisterClassExW164 = user32.func('uint16 __stdcall RegisterClassExW(Deck164WndClassW *wc)');
const CreateWindowExW164 = user32.func('uintptr_t __stdcall CreateWindowExW(uint32 ex, const char16_t *cls, const char16_t *name, uint32 style, int x, int y, int w, int h, uintptr_t parent, uintptr_t menu, uintptr_t hinst, uintptr_t param)');
const DestroyWindow164 = user32.func('bool __stdcall DestroyWindow(uintptr_t hWnd)');
const UnregisterClassW164 = user32.func('bool __stdcall UnregisterClassW(const char16_t *cls, uintptr_t hinst)');
const DefWindowProcW164 = user32.func('intptr_t __stdcall DefWindowProcW(uintptr_t hWnd, uint32 msg, uintptr_t wp, intptr_t lp)');
const PeekMessageW164 = user32.func('bool __stdcall PeekMessageW(void *msg, uintptr_t hWnd, uint32 min, uint32 max, uint32 remove)');
const TranslateMessage164 = user32.func('bool __stdcall TranslateMessage(const void *msg)');
const DispatchMessageW164 = user32.func('intptr_t __stdcall DispatchMessageW(const void *msg)');

function makeReplayProbe() {
  const frames = [];
  const proc = koffi.register((h, msg, wp, lp) => {
    // intptr_t lParam 按有符号回来（≥0x80000000 为负）——归一成无符号 32 位再断言
    const lpn = typeof lp === 'bigint' ? Number(BigInt.asUintN(32, lp)) : Number(lp) >>> 0;
    frames.push({ h: Number(h), msg, wp: Number(wp), lp: lpn });
    return Number(DefWindowProcW164(h, msg, wp, lp));
  }, 'Deck164WndProc *');
  const hinst = Number(GetModuleHandleW164(0));
  const atom = RegisterClassExW164({
    cbSize: koffi.sizeof(DECK164_WNDCLASS), style: 0, lpfnWndProc: proc,
    cbClsExtra: 0, cbWndExtra: 0, hInstance: hinst,
    hIcon: 0, hCursor: 0, hbrBackground: 0,
    lpszMenuName: 0, lpszClassName: 'DECK164PROBE', hIconSm: 0,
  });
  // 隐藏 0 尺寸工具窗（TOOLWINDOW|NOACTIVATE，同宿主竞争窗形态）：只收回调不露脸
  const hwnd = Number(CreateWindowExW164(0x80 | 0x08000000, 'DECK164PROBE', 'DECK164PROBE',
    0x80000000, 0, 0, 0, 0, 0, 0, hinst, 0));
  const msgBuf = Buffer.alloc(48); // MSG x64
  const pump = () => {
    while (PeekMessageW164(msgBuf, hwnd, 0, 0, 1 /* PM_REMOVE */)) {
      TranslateMessage164(msgBuf);
      DispatchMessageW164(msgBuf);
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
    try { if (hwnd) DestroyWindow164(hwnd); } catch { /* 尽力 */ }
    try { if (atom) UnregisterClassW164('DECK164PROBE', hinst); } catch { /* 尽力 */ }
    try { koffi.unregister(proc); } catch { /* 尽力 */ }
  };
  return { frames, hwnd, pump, waitFrame, destroy };
}

// —— P16 推荐组探针（工单160）：五条推荐位夹具 + usage 打分种子 ——
// 推荐位只在条目有正分时占位（候选池=桌面项池 ∩ 正分条目），而 usage 事件只在
// UsageService 构造时读盘一次（services/usage.ts）——探针种入必须先于面板拉起。
// 五条 lnk 夹具落真实桌面扫描根（P5-ICON 夹具法先例：不依赖用户桌面内容），目标指向
// 临时目录里的唯一路径：首条 = notepad 副本（真 exe，左键启动臂的端到端依据），余四条
// = 占位文件（不可执行，只做图标/菜单/拖拽/手钉的寻址体）。打分 = 每探针 2000 条新鲜
// start 事件（decay(0)≈1 → 融合分 ~2000，确定性压过真实条目占满 top-5；同分按名稳定序）。
// 工单161 增两条递补候选（extras F=1000/G=500，夹具法与种子通道同款）：不进 P16 的
// 「必在推荐位」断言集，只作第 6/7 名——手钉/移除腾位的递补断言（滤除后截断）与
// 「第 6 名及以后不出现」的强断言都吃它。cleanupRecsProbes 摘除全部痕迹：桌面夹具 /
// usage 按行摘除（探针 exe 是临时唯一路径，无合法流量撞行）/ 栏布局存储按探针身份
// 过滤（手钉/拖拽/移除臂的落盘残留，工单161 起含 excluded 段）。
const shell32P16 = koffi.load('shell32.dll');
const PostMessageW16 = user32.func('int __stdcall PostMessageW(uintptr_t hWnd, uint32 msg, uintptr_t wp, intptr_t lp)');
const WM_CLOSE_16 = 0x0010;

function psRunP16(args, timeoutMs = 15000) {
  const r = spawnSync('powershell.exe', args, { encoding: 'utf8', timeout: timeoutMs });
  if (r.status !== 0) throw new Error(`powershell 失败: ${r.stderr || r.stdout}`);
  return (r.stdout || '').trim();
}

function createShortcutLnkP16(lnkPath, targetPath) {
  const script = [
    '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($args[0])',
    '$s.TargetPath = $args[1]',
    '$s.Save()',
    "Write-Output ('exists=' + (Test-Path -LiteralPath $args[0]))",
  ].join('\n');
  const scriptFile = path.join(__dirname, 'evidence', '49-create-shortcut-lnk.ps1');
  fs.writeFileSync(scriptFile, script, 'utf8');
  try {
    return psRunP16(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptFile, lnkPath, targetPath]);
  } finally {
    try { fs.unlinkSync(scriptFile); } catch { /* 尽力清理 */ }
  }
}

function userDesktopRootP16() {
  const out = psRunP16(['-NoProfile', '-Command',
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; [Environment]::GetFolderPath("Desktop")']);
  if (!out) throw new Error('桌面根定位失败');
  return out;
}

function seedRecsProbes(rep) {
  try {
    const t = Date.now();
    const sysRoot = process.env.SystemRoot || 'C:\\Windows';
    const cmdSrc = path.join(sysRoot, 'System32', 'cmd.exe');
    if (!fs.existsSync(cmdSrc)) {
      rep.note('P16 探针前置失败：cmd.exe 缺失');
      return null;
    }
    const desktopRoot = userDesktopRootP16();
    // 临时目录取长路径形：os.tmpdir() 给 8.3 短名（C:\Users\ANW~1\...），lnk 经
    // readShortcutLink 解析回长名（C:\Users\An W\...）——种子事件 exe 与 byTarget 键
    // 形差不归一，mapScoresToItems 整段映射不上（2026-10-13 红轮取证实验坐实）。
    const tmpDir = fs.mkdtempSync(path.join(fs.realpathSync.native(require('os').tmpdir()), 'deck-p16-'));
    // 启动臂探针 = cmd 副本（真控制台窗、进程常驻、镜像名唯一可轮询）——notepad 副本
    // 弃用：Win11 System32 notepad.exe 是存根，副本启动被重定向 Store 记事本且并入既有
    // 实例标签页，进程与窗口两级判据都抓不到出场（第 3/4 轮红轮实证）。
    const launchTarget = path.join(tmpDir, 'deck-p16-cmd.exe');
    fs.copyFileSync(path.join(sysRoot, 'System32', 'cmd.exe'), launchTarget);
    const tags = ['A', 'B', 'C', 'D', 'E'];
    const probes = tags.map((tag, i) => {
      const target = i === 0 ? launchTarget : path.join(tmpDir, `deck-p16-probe-${tag}.exe`);
      if (i > 0) fs.writeFileSync(target, 'deck-p16 placeholder (not an executable)', 'utf8');
      const name = `DECK-P16-${t}-${tag}.lnk`;
      return { name, display: `DeckP16${tag}`, exe: target };
    });
    // 递补候选（工单161）：F/G 是第 6/7 名——不进可见集，只在手钉/移除腾位时递补
    const EXTRA_SCORES_16 = { F: 1000, G: 500 };
    const extras = Object.keys(EXTRA_SCORES_16).map((tag) => {
      const target = path.join(tmpDir, `deck-p16-probe-${tag}.exe`);
      fs.writeFileSync(target, 'deck-p16 placeholder (not an executable)', 'utf8');
      const name = `DECK-P16-${t}-${tag}.lnk`;
      return { name, display: `DeckP16${tag}`, exe: target };
    });
    for (const p of [...probes, ...extras]) createShortcutLnkP16(path.join(desktopRoot, p.name), p.exe);
    // 种子事件的 exe 身份走 byStem 通道（第二轮红轮取证）：面板子进程的 lnk 目标解析是
    // 异步代理（ProxyShortcutResolver 首轮 null 即被 targets 缓存），.exe 分数键经
    // byTarget 永远映射不上；真实条目的分全靠 UserAssist 先验里「盘上不存在的 .lnk
    // 路径」走 mapScoresToItems 的 stem 兜底。种子对齐同一条通道：exe = 合成的不存在
    // .lnk 路径，文件名 stem = 夹具显示名（byStem 键 = display 小写）——与解析缓存、
    // 目标形态、盘上存在性全部解耦。（本地装配的直连解析器不经此路，取证实验
    // recs-seed-forensics.js 已实证打分链路本体无误。）
    for (const p of [...probes, ...extras]) p.seedExe = path.join('C:\\deck-p16-usage-seed', String(t), p.name);
    // usage 打分种子：按天 JSONL 追加（appendEvent 同款记录形态 {ts, exe}，UTC 日）。
    // 打分键 = seedExe（byStem 通道，见上）；p.exe（解析目标）留给 evidence 归一与
    // 栏布局存储清理（手钉/拖拽/移除臂落盘的是富化后的目标路径）。
    const usageDir = path.join(app.getPath('userData'), 'usage');
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const usageFile = path.join(usageDir, `start-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}.jsonl`);
    const ts = new Date(Math.floor(t / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    let blob = '';
    for (const p of probes) for (let i = 0; i < 2000; i++) blob += JSON.stringify({ ts, exe: p.seedExe }) + '\n';
    for (const p of extras) for (let i = 0; i < EXTRA_SCORES_16[p.display.slice(-1)]; i++) blob += JSON.stringify({ ts, exe: p.seedExe }) + '\n';
    fs.mkdirSync(usageDir, { recursive: true });
    fs.appendFileSync(usageFile, blob, 'utf8');
    return { t, desktopRoot, tmpDir, usageFile, probes, extras, done: false };
  } catch (err) {
    rep.note(`P16 探针种入失败（段内将以缺前置判红）: ${err && err.message}`);
    return null;
  }
}

function cleanupRecsProbes(p16) {
  if (!p16 || p16.done) return;
  p16.done = true;
  const all16 = [...p16.probes, ...(p16.extras || [])]; // 工单161 起含递补候选 F/G
  for (const p of all16) {
    try { fs.unlinkSync(path.join(p16.desktopRoot, p.name)); } catch { /* 尽力 */ }
  }
  try {
    // 摘除集合 = 种子键（seedExe，byStem 合成路径）+ 解析目标（p.exe——面板在启动臂
    // 检测到的副本真启动事件同键）
    const probeExes = new Set(all16.flatMap((p) => [p.seedExe, p.exe].map((x) => String(x).toLowerCase())));
    const text = fs.readFileSync(p16.usageFile, 'utf8');
    const kept = text.split('\n').filter((l) => {
      if (!l.trim()) return false;
      try { return !probeExes.has(String(JSON.parse(l).exe || '').toLowerCase()); } catch { return true; }
    });
    fs.writeFileSync(p16.usageFile, kept.length ? kept.join('\n') + '\n' : '', 'utf8');
  } catch { /* 尽力 */ }
  try {
    const storeFile = path.join(app.getPath('userData'), 'taskbar-layout.json');
    const store = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    const probeExes = new Set(all16.map((p) => p.exe.toLowerCase()));
    const probeNames = new Set(all16.map((p) => p.name));
    const before = JSON.stringify(store);
    if (Array.isArray(store.pinned)) store.pinned = store.pinned.filter((e) => !probeExes.has(String(e.exe || '').toLowerCase()));
    if (Array.isArray(store.recommended)) store.recommended = store.recommended.filter((n) => !probeNames.has(n));
    if (Array.isArray(store.excluded)) store.excluded = store.excluded.filter((e) => !probeExes.has(String(e.exe || '').toLowerCase())); // 工单161 移除名单段
    if (JSON.stringify(store) !== before) fs.writeFileSync(storeFile, JSON.stringify(store, null, 1) + '\n', 'utf8');
  } catch { /* 尽力 */ }
  try { fs.rmSync(p16.tmpDir, { recursive: true, force: true }); } catch { /* 尽力 */ }
}

// —— P18 统一序列探针（工单189）：csc 现编译 WinForms 最小窗，副本×3 ——
// 探针选型四轮真机取证留痕（禁静默换径）：
//   R2 cmd 副本直接 spawn 无窗——默认终端宿主（Windows Terminal）接管控制台窗；
//   R3 openPath 后窗出场但栏面身份=windowsterminal.exe 全并一格——控制台窗宿主
//      代持，探针 exe 身份永不进栏，cmd 族在默认终端形态下整族不可用；
//   R4 charmap 副本 openPath 无错而进程=0——Win11 System32 charmap.exe 副本本机
//      不启动（秒退）；notepad 副本同症（秒退 code=0，P16 种入注同证：存根重定向
//      Store 版，进程/窗两级判据都抓不到）——「拷贝系统 GUI exe」路线在本机否决；
//   R5 自有探针：csc（.NET Framework 自带，无新依赖）现编译 WinForms 最小窗，
//      副本×3 各自镜像名唯一。一次性取证实证：编译 446ms、三副本进程=1 且窗直属
//      探针 exe（标题含镜像名）、ShellExecute 通路 OK、二实例不并、taskkill 收杀
//      干净。窗按 tag 横向错位摆开（focus18 点中兜底不误点邻探针）。
const P18_PROBE_CS = `
using System;
using System.Drawing;
using System.Windows.Forms;
static class Probe {
  [STAThread]
  static void Main() {
    string img = AppDomain.CurrentDomain.FriendlyName; // deck-p18-N.exe
    int tag = 1;
    int p = img.LastIndexOf('-');
    if (p >= 0) int.TryParse(img.Substring(p + 1), out tag);
    Form f = new Form();
    f.Text = img + " deck-p18 probe";
    f.StartPosition = FormStartPosition.Manual;
    f.Bounds = new Rectangle(40 + (tag - 1) * 360, 60, 300, 160);
    Application.Run(f);
  }
}
`;
function seedP18Probes(rep) {
  try {
    const sysRoot = process.env.SystemRoot || 'C:\\Windows';
    const csc = path.join(sysRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    if (!fs.existsSync(csc)) {
      rep.note('P18 探针前置失败：csc.exe 缺失（.NET Framework4.x）');
      return null;
    }
    const tmpDir = fs.mkdtempSync(path.join(fs.realpathSync.native(require('os').tmpdir()), 'deck-p18-'));
    const csFile = path.join(tmpDir, 'probe.cs');
    fs.writeFileSync(csFile, P18_PROBE_CS, 'utf8');
    const built = spawnSync(csc, ['/nologo', '/target:winexe', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
      `/out:${path.join(tmpDir, 'deck-p18-probe.exe')}`, csFile], { encoding: 'utf8' });
    if (built.status !== 0 || !fs.existsSync(path.join(tmpDir, 'deck-p18-probe.exe'))) {
      rep.note(`P18 探针编译失败：status=${built.status} ${(built.stderr || '').trim().slice(0, 200)}`);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 尽力 */ }
      return null;
    }
    const tags = ['1', '2', '3'];
    const probes = tags.map((tag) => {
      const exe = path.join(tmpDir, `deck-p18-${tag}.exe`);
      fs.copyFileSync(path.join(tmpDir, 'deck-p18-probe.exe'), exe);
      return { tag, exe, img: path.basename(exe), hwnd: 0, child: null };
    });
    return { tmpDir, probes, done: false };
  } catch (err) {
    rep.note(`P18 探针种入失败（段内将以缺前置判红）: ${err && err.message}`);
    return null;
  }
}

function cleanupP18Probes(p18) {
  if (!p18 || p18.done) return;
  p18.done = true;
  for (const p of p18.probes) {
    spawnSync('taskkill', ['/IM', p.img, '/T', '/F'], { stdio: 'ignore' });
    try { if (p.child) p.child.kill(); } catch { /* 已退出 */ }
  }
  try {
    // 栏布局存储按探针身份过滤（钉入/解除臂失败路径的手钉残留，工单161 三处摘除同款）
    const storeFile = path.join(app.getPath('userData'), 'taskbar-layout.json');
    const store = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    const probeExes = new Set(p18.probes.map((p) => p.exe.toLowerCase()));
    const before = JSON.stringify(store);
    if (Array.isArray(store.pinned)) store.pinned = store.pinned.filter((e) => !probeExes.has(String(e.exe || '').toLowerCase()));
    if (JSON.stringify(store) !== before) fs.writeFileSync(storeFile, JSON.stringify(store, null, 1) + '\n', 'utf8');
  } catch { /* 尽力 */ }
  try { fs.rmSync(p18.tmpDir, { recursive: true, force: true }); } catch { /* 尽力 */ }
}

async function main() {
  const rep = new Report('49-taskbar');
  let child = null;
  let panelPid = 0;
  let probe164 = null; // P14 探针（#164）：finally 兜底拆除（段内异常也不漏窗漏类）
  let p16 = null; // P16 推荐组探针（#160）：面板启动前种入（usage 只在服务构造时读盘），finally 兜底清理
  let p18 = null; // P18 统一序列探针（#189）：finally 兜底清理
  const originalConfig = readConfigRaw();
  const finish = () => {
    const v = rep.verdict(rep.fails === 0 ? 'PASS' : 'FAIL');
    app.exit(v.fails === 0 ? 0 : 1);
  };

  try {
    fs.writeFileSync(EVENTS_FILE, '', 'utf8');
    patchTaskbar({ enabled: true });
    await ensureTaskViewClosed(rep); // 上一轮 P5 的任务视图残留会盖住条带，先清场

    // —— P16 推荐组探针（工单160）：先于面板种入（usage 打分只在服务构造时读盘）——
    p16 = seedRecsProbes(rep);
    if (p16) rep.note(`P16 探针已种入：${p16.probes.map((p) => p.name).join(' / ')}`);

    // —— P18 统一序列探针（工单189）：面板拉起后段内种入（无 usage 前置）——
    p18 = seedP18Probes(rep);
    if (p18) rep.note(`P18 探针已备：${p18.probes.map((p) => p.img).join(' / ')}`);

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
    const ready = await waitEvent('taskbar-ready', (e) => e.startPill && e.buttons, 10000);
    if (!ready) throw new Error('taskbar-ready 存证缺失（无法取 pill 点击坐标）');
    // 几何稳定帧：推荐位后到位会推 pill 移位，点击坐标一律取 settle 后的最新几何
    const geom = await waitGeometrySettled(ready);
    rep.note(`几何帧: boot startPill.w=${Math.round(ready.startPill.w)} → settled startPill.w=${Math.round(geom.startPill.w)}`);
    const toPhys = (cssX, cssY) => ({
      x: Math.round(rect.left + cssX * scale),
      y: Math.round(rect.top + cssY * scale),
    });
    const btnOf = (id) => {
      const b = geom.buttons.find((x) => x.id === id);
      return toPhys(b.x + b.w / 2, b.y + b.h / 2);
    };
    // 缝隙探针（工单159 布局重排适配；工单190 起居中锚定不改变本探针——缝隙点从实测
    // 几何取；工单192 推荐组拆出随迁）：pill 间缝隙取「应用组右缘与右组左缘的中点」
    // （带宽恒宽敞）；应用组空（pill-apps 不渲染）退「左邻组右缘与右组左缘的中点」——
    // 左邻按推荐组优先（工单192 独立 pill 在场取其右缘，缺席回退开始组）；左邻也整组
    // 不渲染时矩形归零、退化为条带左半任意点
    // （固定 x=40 会落进钉左的开始组热区——工单159 起开始组钉条带左缘）
    const leftEdgeCss192 = geom.recPill && geom.recPill.w > 0
      ? geom.recPill.x + geom.recPill.w
      : geom.startPill.x + geom.startPill.w;
    const gapCssX = geom.apps && geom.apps.length > 0
      ? (geom.appsPill.x + geom.appsPill.w + geom.rightPill.x) / 2
      : (leftEdgeCss192 + geom.rightPill.x) / 2;
    const gapPt = toPhys(gapCssX, TASKBAR_HEIGHT_DIP / 2); // 条带缝隙（两组 pill 之间/左端）
    const pillCenter = toPhys(geom.startPill.x + geom.startPill.w / 2, geom.startPill.y + geom.startPill.h / 2);

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
      // 几何存证互证：应用格位 h≈44（cell）；托盘格 h≈34（24 图标 + 5+5 padding——
      // 工单158 挤撞回正的密度紧凑档，托盘格 padding 7→5 延缓右组左侵开始组）
      const geo13 = latestGeometry(null);
      const geoAppsOk13 = !!(geo13 && geo13.apps && geo13.apps.length > 0 && Math.abs(geo13.apps[0].h - 44) <= 2);
      const geoTrayOk13 = !!(geo13 && geo13.trayIcons && geo13.trayIcons.length > 0 && Math.abs(geo13.trayIcons[0].h - 34) <= 2);
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

    // P15 栏分组布局重排（工单159；工单192 推荐组独立 pill 随迁重定界）：三组新布局落位。
    // 证据两路互证：
    //   (1) taskbar-geometry 存证帧（渲染层量出的 pill 矩形，与电池点击坐标同源）；
    //   (2) 任务栏页 CDP computed style（开始组钉左 CSS 落位 + 应用组 JS 落位在场）。
    //   工单190 起居中语义移交 P15B（屏幕中心线锚定）：本段只钉钉左/两侧界（不与邻组
    //   重叠，界 = 推荐组右缘优先回退开始组右缘——工单192 左邻随迁）、右组细条钉右、
    //   推荐位界内——原「空带中点居中 + 随带回正」断言随功能变更退役（P15B 接班）。
    //   推荐位界内断言重定界到 #pill-recs（量测出处随迁、字段语义不变）。应用格空时
    //   notepad 探针（同 P13）。
    rep.beginSegment('P15');
    let notepad14 = null;
    try {
      let geom14 = latestGeometry(null);
      if (!geom14 || !geom14.apps || geom14.apps.length === 0) {
        notepad14 = spawn('notepad.exe', [], { stdio: 'ignore' });
        const deadline14 = Date.now() + 12000;
        while (Date.now() < deadline14) {
          geom14 = latestGeometry(null);
          if (geom14 && geom14.apps && geom14.apps.length > 0) break;
          await sleep(300);
        }
      }
      const g0 = await waitGeometrySettled(geom14);
      const GAP15 = 8; // 渲染层 GROUP_GAP（taskbar-view appsBand 纯函数常量，CSS px）
      const bandOf = (g) => {
        // 左邻组右缘：推荐组独立 pill 在场取其右缘（工单192），缺席回退开始组；
        // 工单190 起空带只作容量/夹取围栏（居中语义在 P15B），不带中点
        const leftEdge = g.recPill && g.recPill.w > 0 ? g.recPill.x + g.recPill.w : g.startPill.x + g.startPill.w;
        return {
          lo: leftEdge + GAP15,
          hi: g.rightPill.x - GAP15,
        };
      };
      // CDP 互证：#pill-start 钉左（computed left=8px）、#pill-apps 由 JS 落位（inline left 在场）
      const css14 = await cdpEval(`(() => {
        const st = document.getElementById('pill-start');
        const ap = document.getElementById('pill-apps');
        return {
          startLeft: getComputedStyle(st).left,
          startTransform: getComputedStyle(st).transform,
          appsInlineLeft: ap.style.left,
          appsDisplay: getComputedStyle(ap).display,
        };
      })()`, TASKBAR_TITLE);
      const b0 = bandOf(g0);
      const startOk14 = Math.abs(g0.startPill.x - 8) <= 2
        && Math.abs(g0.startPill.y + g0.startPill.h / 2 - TASKBAR_HEIGHT_DIP / 2) <= 2;
      const cssOk14 = css14.startLeft === '8px' && css14.appsInlineLeft !== '' && css14.appsDisplay !== 'none';
      const noOverlap14 = g0.appsPill.x >= b0.lo - 0.5 && g0.appsPill.x + g0.appsPill.w <= b0.hi + 0.5;
      const dip14 = screen.getPrimaryDisplay().bounds;
      const rightOk14 = Math.abs(g0.rightPill.x + g0.rightPill.w - (dip14.width - 14)) <= 2
        && Math.abs(g0.sliver.x + g0.sliver.w - dip14.width) <= 2;
      const recs14 = g0.recommendations || [];
      // 推荐位界内断言重定界（工单192）：有推荐位 → 独立 pill 在场、与开始组有明确间隙、
      // 枚枚界内 #pill-recs；无推荐位 → 独立 pill 不渲染（矩形归零）。量测出处随迁、
      // recommendations 字段名与语义不变（taskbar-geometry 断言存活前提）
      const recPill14 = g0.recPill && g0.recPill.w > 0 ? g0.recPill : null;
      const recsOk14 = recs14.length === 0
        ? !recPill14
        : !!recPill14
          && recPill14.x >= g0.startPill.x + g0.startPill.w + GAP15 - 0.5
          && recs14.every((r) => r.x >= recPill14.x - 0.5 && r.x + r.w <= recPill14.x + recPill14.w + 0.5);
      if (startOk14 && cssOk14 && noOverlap14 && rightOk14 && recsOk14) {
        rep.pass(`P15 三组新布局落位：开始组钉左（x=${g0.startPill.x.toFixed(1)}，CSS=${css14.startLeft}）、`
          + `应用组带内落位（带 [${b0.lo.toFixed(0)}, ${b0.hi.toFixed(0)}]，居中语义见 P15B）、`
          + `不与邻组重叠、右组+细条钉右不变${recs14.length
            ? `、推荐位 ${recs14.length} 枚独立 pill 界内（pill @${recPill14.x.toFixed(0)}，与开始组间隙 ${(recPill14.x - g0.startPill.x - g0.startPill.w).toFixed(0)}px）`
            : '、推荐位空缺独立 pill 不渲染'}`);
      } else {
        rep.fail(`P15 钉左=${startOk14}(x=${g0.startPill.x}) css互证=${cssOk14}(${JSON.stringify(css14)})`
          + ` 不重叠=${noOverlap14} 右组细条=${rightOk14} 推荐位界内=${recsOk14}(${recs14.length} 枚 recPill=${JSON.stringify(g0.recPill || null)})`
          + ` 帧=${JSON.stringify({ startPill: g0.startPill, appsPill: g0.appsPill, rightPill: g0.rightPill, sliver: g0.sliver })}`);
      }
    } finally {
      if (notepad14) spawnSync('taskkill', ['/PID', String(notepad14.pid), '/T', '/F'], { stdio: 'ignore' });
    }

    // P15B 屏幕中心线锚定（工单190，ADR-0013 决策2）：应用组 pill 中心对齐屏幕水平
    // 中心线，不随开始组/推荐组/右组宽度漂移。容差 ±2.5px CSS px（段内注明口径：落位
    // 取整 ±1px + 1Hz 快照抖动余量，与旧空带居中容差同源）。三路邻居宽度驱动各带复原：
    // 藏/显 TaskView（左邻）、推荐位移除/恢复（开始组内容增删，工单161 rec-remove/
    // rec-restore 通道，P16 种子探针保证在场）、托盘溢出档位切换（右邻，工单162 档位
    // 通道，原档位读 config 还原）；对称扩张臂用第二应用探针（图标增多向两侧对称扩张，
    // mspaint 独立 exe 不与 notepad 合一）。夹取/不越界 = 逐帧「pill 恒在带内」断言
    // （超宽病态档夹取数学由单测钉——章法：单测能覆盖的不进电池）；居中锚 = 屏幕中心线
    // （条带窗通栏横跨主屏、窗 x = 屏 x，存证帧视口中线 = 屏宽/2 − 窗 DIP 原点）。
    rep.beginSegment('P15B');
    let notepad15b = null;
    let mspaint15b = null;
    let recExe15b = null;
    let tier15b = null;
    let tierTarget15b = null;
    try {
      const dip15b = screen.getPrimaryDisplay().bounds;
      const appsMid = (g) => g.appsPill.x + g.appsPill.w / 2;
      const tbHwnd15b = findWindow(panelPid, TASKBAR_TITLE);
      const rect15b = tbHwnd15b ? win32.rectOf(tbHwnd15b) : null;
      // 窗 DIP 原点（P1 同款换算：窗物理宽 / 屏 DIP 宽 = 缩放），存证帧视口原点 = 窗原点
      const winXDip15b = rect15b ? rect15b.left / ((rect15b.right - rect15b.left) / dip15b.width) : 0;
      const centerLine15b = dip15b.x + dip15b.width / 2 - winXDip15b;
      const inBand15b = (g) => {
        const lo = g.startPill.x + g.startPill.w + 8;
        const hi = g.rightPill.x - 8;
        return g.appsPill.x >= lo - 0.5 && g.appsPill.x + g.appsPill.w <= hi + 0.5;
      };
      // 应用格保底探针（同 P15：栏上无应用时 notepad 1–2s 上栏）
      let geom15b = latestGeometry(null);
      if (!geom15b || !geom15b.apps || geom15b.apps.length === 0) {
        notepad15b = spawn('notepad.exe', [], { stdio: 'ignore' });
        const deadline15b = Date.now() + 12000;
        while (Date.now() < deadline15b) {
          geom15b = latestGeometry(null);
          if (geom15b && geom15b.apps && geom15b.apps.length > 0) break;
          await sleep(300);
        }
      }
      const gA = await waitGeometrySettled(geom15b);
      const midA = appsMid(gA);
      const anchorOk = Math.abs(midA - centerLine15b) <= 2.5;
      // 臂1 藏 TaskView（左邻收窄）→ 中心不变；显回 → 中心不变
      const wA = gA.startPill.w;
      let gHide = null;
      const sinceHide15b = Date.now();
      await cdpEval(`window.deck.bridge.invoke('taskbar/set-button-hidden', { id: 'tasks', hidden: true })`);
      for (let i = 0; i < 30 && !gHide; i++) {
        await sleep(200);
        const cand = latestGeometry(null);
        if (cand && cand.t >= sinceHide15b && cand.startPill && cand.startPill.w < wA - 4) gHide = cand;
      }
      await sleep(1300);
      if (gHide) gHide = latestGeometry(null);
      const hideOk = !!(gHide && Math.abs(appsMid(gHide) - centerLine15b) <= 2.5);
      let gShow = null;
      const sinceShow15b = Date.now();
      await cdpEval(`window.deck.bridge.invoke('taskbar/set-button-hidden', { id: 'tasks', hidden: false })`);
      for (let i = 0; i < 30 && !gShow; i++) {
        await sleep(200);
        const cand = latestGeometry(null);
        if (cand && cand.t >= sinceShow15b && cand.startPill && cand.startPill.w > wA - 4) gShow = cand;
      }
      await sleep(1300);
      if (gShow) gShow = latestGeometry(null);
      const showOk = !!(gShow && Math.abs(appsMid(gShow) - centerLine15b) <= 2.5);
      // 臂2 推荐位移除/恢复（开始组内容增删）→ 中心不变（P16 种子保证推荐位在场）。
      // 递补语义（工单161）：候选池有后继时移除后第 6 名即时递补、可见恒 5——开始组
      // 宽度不变，宽度类邻居驱动由臂1（TaskView）/臂3（托盘档位）承载；本臂口径 =
      // 驱动真行使（excluded 落账/回池）+ 推荐管线重渲后中心不漂移
      const st15b = await cdpEval(`window.deck.bridge.invoke('taskbar/get-state', {})`, TASKBAR_TITLE);
      const recs15b = (st15b && st15b.recommendations) || [];
      let recOk = null;
      if (recs15b.length > 0) {
        recExe15b = recs15b[0].exe;
        const eqExe = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
        const sinceRec15b = Date.now();
        await cdpEval(`window.deck.bridge.invoke('taskbar/rec-remove', { exe: ${JSON.stringify(recExe15b)} })`, TASKBAR_TITLE);
        await sleep(1600); // 1Hz 快照拍 + 重渲 settle（递补后几何不变则无新帧，取最新帧比对）
        const gRec = latestGeometry(null);
        const stRec = await cdpEval(`window.deck.bridge.invoke('taskbar/get-state', {})`, TASKBAR_TITLE);
        const removed = !!(stRec && stRec.excluded && stRec.excluded.some((e) => eqExe(e.exe, recExe15b)));
        const recGoneOk = !!(removed && gRec && Math.abs(appsMid(gRec) - centerLine15b) <= 2.5);
        const sinceRecBack = Date.now();
        await cdpEval(`window.deck.bridge.invoke('taskbar/rec-restore', { exe: ${JSON.stringify(recExe15b)} })`, TASKBAR_TITLE);
        await sleep(1600);
        const gRecBack = latestGeometry(null);
        const stBack = await cdpEval(`window.deck.bridge.invoke('taskbar/get-state', {})`, TASKBAR_TITLE);
        const restored = !!(stBack && stBack.excluded && !stBack.excluded.some((e) => eqExe(e.exe, recExe15b)));
        const recBackOk = !!(restored && gRecBack && Math.abs(appsMid(gRecBack) - centerLine15b) <= 2.5);
        // recExe15b 不清空：finally 幂等重发恢复（rec-restore 对名单外身份空转）
        recOk = !!(recGoneOk && recBackOk);
      } else {
        recOk = null; // 空池（种子未上场）——留证不静默：报表注明「驱动未行使」
      }
      // 臂3 托盘溢出档位切换（右邻宽度变化）→ 中心不变；还原原档位
      const cfgRaw15b = readConfigRaw();
      let cfg15b = null;
      try { cfg15b = cfgRaw15b ? JSON.parse(cfgRaw15b) : null; } catch { cfg15b = null; }
      tier15b = (cfg15b && cfg15b.taskbar && cfg15b.taskbar.trayOverflowLimit) ?? 5;
      tierTarget15b = tier15b === 3 ? 8 : 3;
      const gTier0 = latestGeometry(null) || gA;
      const rp0 = gTier0.rightPill.x;
      const sinceTier15b = Date.now();
      await cdpEval(`window.deck.bridge.invoke('taskbar/set-tray-overflow-limit', { limit: ${JSON.stringify(tierTarget15b)} })`, TASKBAR_TITLE);
      let gTier = null;
      for (let i = 0; i < 30 && !gTier; i++) {
        await sleep(200);
        const cand = latestGeometry(null);
        if (cand && cand.t >= sinceTier15b && cand.rightPill && Math.abs(cand.rightPill.x - rp0) > 8) gTier = cand;
      }
      await sleep(1300);
      if (gTier) gTier = latestGeometry(null);
      const tierMoved = !!(gTier && Math.abs(appsMid(gTier) - centerLine15b) <= 2.5);
      const sinceTierBack = Date.now();
      await cdpEval(`window.deck.bridge.invoke('taskbar/set-tray-overflow-limit', { limit: ${JSON.stringify(tier15b)} })`, TASKBAR_TITLE);
      let gTierBack = null;
      for (let i = 0; i < 30 && !gTierBack; i++) {
        await sleep(200);
        const cand = latestGeometry(null);
        if (cand && cand.t >= sinceTierBack && cand.rightPill && Math.abs(cand.rightPill.x - rp0) <= 8) gTierBack = cand;
      }
      await sleep(1300);
      if (gTierBack) gTierBack = latestGeometry(null);
      const tierRestored = !!(gTierBack && Math.abs(appsMid(gTierBack) - centerLine15b) <= 2.5);
      // tier15b 不清空：finally 幂等重发原档位（set-tray-overflow-limit 同值幂等）
      // 臂4 图标增多向两侧对称扩张：第二应用探针（mspaint 独立 exe 不与 notepad 合一）
      const wBefore = (latestGeometry(null) || gA).appsPill.w;
      const xBefore = (latestGeometry(null) || gA).appsPill.x;
      mspaint15b = spawn('mspaint.exe', [], { stdio: 'ignore' });
      let gGrow = null;
      const sinceGrow15b = Date.now();
      for (let i = 0; i < 40 && !gGrow; i++) {
        await sleep(250);
        const cand = latestGeometry(null);
        if (cand && cand.t >= sinceGrow15b && cand.apps && cand.apps.length > (gA.apps || []).length
          && cand.appsPill.w > wBefore + 20) gGrow = cand;
      }
      await sleep(1300);
      if (gGrow) gGrow = latestGeometry(null);
      const growOk = !!(gGrow && Math.abs(appsMid(gGrow) - centerLine15b) <= 2.5);
      // 对称性：左缘左移量 ≈ 右缘右移量（落位取整 ±1px → 合计不对称 ≤3px）
      const symOk = !!(gGrow
        && Math.abs((xBefore - gGrow.appsPill.x) - ((gGrow.appsPill.x + gGrow.appsPill.w) - (xBefore + wBefore))) <= 3);
      // 全程不越界：采样帧 pill 恒在带内（夹取围栏）
      const frames15b = [gA, gHide, gShow, gGrow].filter(Boolean);
      const allInBand = frames15b.every(inBand15b);
      if (anchorOk && hideOk && showOk && (recOk !== false) && tierMoved && tierRestored && growOk && symOk && allInBand) {
        const recNote = recOk === true ? '推荐位移除/恢复中心不变' : '推荐位空池（种子未上场），增删驱动未行使';
        rep.pass(`P15B 屏幕中心线锚定：应用组中心 ${midA.toFixed(1)} ≈ 屏幕中心线 ${centerLine15b.toFixed(1)}（容差 ±2.5px）、`
          + `藏/显 TaskView 中心不变、${recNote}、托盘档位 ${JSON.stringify(tierTarget15b)} 切换中心不变、`
          + `图标增多对称扩张（宽 ${wBefore.toFixed(0)}→${gGrow ? gGrow.appsPill.w.toFixed(0) : '?'}px，不对称 ≤3px）、全程带内不越界`);
      } else {
        rep.fail(`P15B 锚定=${anchorOk}(组心${midA.toFixed(1)} vs 中心线${centerLine15b.toFixed(1)})`
          + ` 藏钮=${hideOk} 显回=${showOk} 推荐位=${JSON.stringify(recOk)} 档位切换=${tierMoved} 档位还原=${tierRestored}`
          + ` 对称扩张=${growOk}/${symOk}(帧=${gGrow ? JSON.stringify(gGrow.appsPill) : 'null'})`
          + ` 带内=${allInBand} 帧=${JSON.stringify({ gA: gA && gA.appsPill, gHide: gHide && gHide.appsPill, gShow: gShow && gShow.appsPill })}`);
      }
    } finally {
      // 痕迹四处复原（各臂已就地还原，此处兜底幂等）：探针进程、推荐位、托盘档位
      if (mspaint15b) spawnSync('taskkill', ['/PID', String(mspaint15b.pid), '/T', '/F'], { stdio: 'ignore' });
      if (notepad15b) spawnSync('taskkill', ['/PID', String(notepad15b.pid), '/T', '/F'], { stdio: 'ignore' });
      if (recExe15b) {
        try { await cdpEval(`window.deck.bridge.invoke('taskbar/rec-restore', { exe: ${JSON.stringify(recExe15b)} })`, TASKBAR_TITLE); } catch { /* 条带已不在场 */ }
      }
      if (tier15b !== null) {
        try { await cdpEval(`window.deck.bridge.invoke('taskbar/set-tray-overflow-limit', { limit: ${JSON.stringify(tier15b)} })`, TASKBAR_TITLE); } catch { /* 条带已不在场 */ }
      }
    }

    // P16 推荐组交互主体（工单160）：探针五条确定性占满推荐位（usage 种子压分），真机
    // 断言六臂——①图标化+上限5（.tb-rec 定宽图标格 img/首字母占位，无显示名文本残留，
    // 探针恰满 5 枚=第 6/7 名 F/G 不出现）②左键启动（真点击 → rec-click 存证 → cmd
    // 副本真出场，端到端 shell 打开通道）③右键三行菜单+手钉（真右键 → 三行在列 →
    // 点「手钉到任务栏」→ B 即时消失、第 6 名 F 递补（工单161 滤除后截断），不双占位）
    // ④拖拽组内换位（真 OLE 拖拽 recs→recs，显式序压过分数序）⑤拖去应用组升手钉
    // （recs→apps 跨组，落点条目前插入、G 随 D 升钉递补）⑥解除手钉随下拍回池 +
    // 打开文件位置（explorer 定位真出场）——⑥解除臂的应用组菜单随工单193 迁竖排浮层窗
    // DECK-TASKBAR-MENU：行集/横排退役/行点即收/点外即收四面断言随迁（动作存证名不变）。
    // 可见数断言按工单161 递补语义校准（升手钉不再留空位，候选池后续名次即时补齐）。
    // 痕迹三处在 finally 摘除（桌面夹具/usage 行/栏布局存储身份含 excluded 段）。
    rep.beginSegment('P16');
    if (!p16) {
      rep.fail('P16 前置缺失：探针种入失败（见种入 note）');
    } else {
      const probes16 = p16.probes;
      const [pA16, pB16, pC16, pD16, pE16] = probes16;
      const steps16 = 12; // OLE 拖拽步进（渲染层拖拽阈值 6px，步进远超阈值；每步 24ms 保持事件流）
      const norm16 = (s) => String(s || '').toLowerCase();
      const recNames16 = (g) => (g && g.recommendations ? g.recommendations.map((r) => r.name) : []);
      const scanDisplay16 = (name) => name.replace(/\.lnk$/i, ''); // 扫描显示名 = 文件名去扩展（.lnk 恒剥）
      const recPt16 = (g, name) => {
        const r = (g.recommendations || []).find((x) => x.name === name);
        return r ? toPhys(r.x + r.w / 2, r.y + r.h / 2) : null;
      };
      const appPt16 = (g, exe) => {
        // 按 exe 身份定位应用组条目矩形（下标不可用——机器有用户自钉条目占前段）
        const r = (g.apps || []).find((a) => norm16(a.id) === norm16(exe));
        return r ? toPhys(r.x + r.w / 2, r.y + r.h / 2) : null;
      };
      // 图标化查询锚点随迁（工单192）：推荐位图标格已拆出 #pill-recs 独立容器
      const domRecs16 = async () => cdpEval(`(() => {
        const cells = [...document.querySelectorAll('#pill-recs .tb-rec')];
        return cells.map((c) => ({
          name: c.dataset.name || '',
          img: !!c.querySelector('img'),
          letter: !!c.querySelector('.tb-rec-letter'),
          ownText: [...c.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(''),
          title: c.title || '',
          w: c.getBoundingClientRect().width,
          h: c.getBoundingClientRect().height,
        }));
      })()`, TASKBAR_TITLE);
      // 推荐条目右键三行菜单已迁浮层窗 DECK-TASKBAR-REC-MENU（工单196，ADR-0013）：
      // 行集/label/顺序断言走 taskbar-rec-menu-opened/-ready 两路配对（模块级
      // popupAnchored/rightClickPopupVerify/clickPopupRowVerify），动作存证名不变。
      const REC_MENU_FAMILY16 = 'taskbar-rec-menu';
      // 横排退役诊断（取证面）：条带 DOM 不应再有任何菜单行/窗口列表行（工单196 AC——
      // 全任务栏任何右键入口不再出现横排形态）
      const stripMenuRows16 = () => cdpEval(`(() => {
        return [...document.querySelectorAll('.tb-menu-item, .tb-win-item')].map((r) => r.dataset.action || r.dataset.id || '');
      })()`, TASKBAR_TITLE);
      // —— ① 图标化 + 上限 5 ——
      let g16 = null;
      for (let i = 0; i < 40 && !g16; i++) {
        await sleep(300);
        const cand = latestGeometry(null);
        const names = recNames16(cand);
        if (probes16.every((p) => names.includes(p.name))) g16 = cand;
      }
      if (!g16) {
        rep.fail(`P16 探针未占满推荐位（12s 内五条夹具未同帧在场——usage 种子/桌面扫描链路断，`
          + `或机器真实条目分压过种子）：几何=${JSON.stringify(latestGeometry(null) && recNames16(latestGeometry(null)))}`);
      } else {
        const dom16 = await domRecs16();
        const countOk16 = recNames16(g16).length === 5;
        // 第 6/7 名不出现（工单161 强断言：F/G 在候选池里，滤除后截断才不可见）
        const fillersHidden16 = (p16.extras || []).every((f) => !recNames16(g16).includes(f.name));
        const iconizedOk16 = dom16.length === 5 && dom16.every((c) => (c.img || c.letter) && !c.ownText
          && Math.abs(c.w - 44) <= 2 && Math.abs(c.h - 44) <= 2);
        // tooltip = 扫描显示名（文件名去扩展——图标化后名称的唯一即时呈现位；种子侧的
        // display 字段是打分键不进条目，条目 display 由桌面扫描派生）
        const tooltipOk16 = dom16.every((c) => {
          const hit = probes16.find((p) => p.name === c.name);
          return hit && c.title === scanDisplay16(hit.name);
        });
        if (countOk16 && fillersHidden16 && iconizedOk16 && tooltipOk16) {
          rep.pass(`P16 推荐组图标化+上限5：探针恰满 5 枚（第 6/7 名 F/G 在池不可见）；每格 44×44 图标格`
            + `（img ${dom16.filter((c) => c.img).length}/占位 ${dom16.filter((c) => c.letter).length}），无显示名文本残留，扫描显示名即时进 tooltip`);
        } else {
          rep.fail(`P16 图标化断言：count=${countOk16}(${recNames16(g16).length}) fillersHidden=${fillersHidden16} iconized=${iconizedOk16}`
            + `(${JSON.stringify(dom16)}) tooltip=${tooltipOk16}`);
        }

        // —— ② 左键启动（端到端：真点击 → rec-click 存证 → 探针进程真出场）——
        // 出场判据 = 进程级（镜像名 tasklist 轮询）：notepad 副本两轮红轮实证抓不到
        // （System32 存根重定向 Store 记事本并并入既有实例标签页——窗口类与镜像名两级
        // 都失）；cmd 副本进程常驻镜像名唯一，进程在场即 shell 打开通道端到端实锤，
        // 控制台窗（ConsoleWindowClass 新窗）作旁证。
        const ptA = recPt16(await waitGeometrySettled(g16), pA16.name);
        const clickPt16 = ptA || toPhys(g16.recommendations[0].x + g16.recommendations[0].w / 2, g16.recommendations[0].y + g16.recommendations[0].h / 2);
        const notepadHwndsBefore16 = new Set(win32.topLevelWindows()
          .filter((h) => win32.className(h) === 'ConsoleWindowClass'));
        win32.clickPhys(clickPt16.x, clickPt16.y, 'left');
        const clickEv16 = await waitEvent('taskbar-rec-click', (e) => e.name === pA16.name, 5000);
        const clickOk16 = await waitEvent('taskbar-rec-click-result', (e) => e.name === pA16.name && e.ok, 5000);
        const imgName16 = 'deck-p16-cmd.exe';
        let procUp16 = false;
        let copyHwnd16 = null;
        const isConsole16 = (h) => ['ConsoleWindowClass', 'CASCADIA_HOSTING_WINDOW_CLASS'].includes(win32.className(h));
        for (let i = 0; i < 16 && !procUp16; i++) {
          await sleep(400);
          const r16 = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${imgName16}`, '/NH'], { encoding: 'utf8' });
          procUp16 = (r16.stdout || '').toLowerCase().includes(imgName16);
          if (!copyHwnd16) {
            copyHwnd16 = win32.topLevelWindows().find((h) => isConsole16(h) && !notepadHwndsBefore16.has(h)) || null;
          }
        }
        if (procUp16) spawnSync('taskkill', ['/IM', imgName16, '/F'], { stdio: 'ignore' });
        if (copyHwnd16) spawnSync('taskkill', ['/PID', String(win32.threadIdOf(copyHwnd16).pid), '/T', '/F'], { stdio: 'ignore' });
        if (clickEv16 && clickOk16 && procUp16) {
          rep.pass(`P16 左键启动经 shell 打开通道：真点击存证（rec-click+ok）→ 探针目标（cmd 副本）进程真出场${copyHwnd16 ? '（控制台窗在场）' : ''}并收杀`);
        } else {
          rep.fail(`P16 左键启动：点击存证=${!!clickEv16} 回执ok=${!!clickOk16} 目标进程=${procUp16 ? '在场' : '未出场'}`
            + ` 控制台窗=${copyHwnd16 ? '在场' : '未出场'}（exe 归一寻址=${clickEv16 ? norm16(clickEv16.exe) === norm16(pA16.exe) : 'n/a'}）`);
        }

        // —— ③ 右键三行菜单 + 手钉（B 消失、F 递补，不双占位；工单161 扩移除行；
        //     工单196 菜单迁浮层窗 DECK-TASKBAR-REC-MENU——行集/label/顺序随迁浮层锚点）——
        let gB = await waitGeometrySettled(g16);
        const ptB = recPt16(gB, pB16.name);
        if (!ptB) {
          rep.fail(`P16 右键臂前置缺失：探针 B 不在推荐位（${JSON.stringify(recNames16(gB))}）`);
        } else {
          const popB = await rightClickPopupVerify(() => recPt16(latestGeometry(null), pB16.name), REC_MENU_FAMILY16, 3);
          const rowsB = popB ? popB.rows : null;
          const rowsOk16 = !!rowsB && rowsB.length === 3 && rowsB.map((r) => r.id).join(',') === 'pin,remove,reveal'
            && rowsB.map((r) => r.label).join(',') === '手钉到任务栏,从推荐栏移除,打开文件位置';
          let pinned16 = null;
          if (rowsOk16) {
            const pinEv16 = await clickPopupRowVerify(REC_MENU_FAMILY16, popB.since, 'pin', 'taskbar-rec-menu-action', (e) => e.name === pB16.name && e.action === 'pin', scale);
            rep.note(`P16③ 手钉行点击存证=${!!pinEv16}（浮层窗 DECK-TASKBAR-REC-MENU 行点）`);
            for (let i = 0; i < 30 && !pinned16; i++) {
              await sleep(200);
              const cand = latestGeometry(null);
              // 手钉落位判据：B 即时消失 + 第 6 名 F 递补（工单161 滤除后截断，可见恒 5）
              // + 应用组按 exe 身份在册（几何矩形不带 pinned 位——手钉段语义由离线契约测试
              // 与⑤的落点前插邻接断言收口）
              if (cand && recNames16(cand).length === 5 && !recNames16(cand).includes(pB16.name)
                && recNames16(cand).includes(p16.extras[0].name)
                && (cand.apps || []).some((a) => norm16(a.id) === norm16(pB16.exe))) pinned16 = cand;
            }
          }
          if (rowsOk16 && pinned16) {
            const apps16 = pinned16.apps || [];
            rep.pass(`P16 右键三行+手钉：菜单恰三行（手钉到任务栏/从推荐栏移除/打开文件位置）；点手钉后 B 即时消失`
              + `、第 6 名 F 递补（可见恒 5，工单161 递补语义）、应用组在册（位次 ${apps16.findIndex((a) => norm16(a.id) === norm16(pB16.exe)) + 1}/${apps16.length}，手钉段）`);
          } else {
            rep.fail(`P16 右键/手钉：三行=${JSON.stringify(rowsB)} 手钉落位=${!!pinned16}`
              + `(recs=${pinned16 ? JSON.stringify(recNames16(pinned16)) : 'n/a'} apps0=${pinned16 && pinned16.apps[0] ? pinned16.apps[0].id : 'n/a'})`);
          }

          // —— ④ 拖拽组内换位（recs→recs：显式序压过分数序）——
          let gE = await waitGeometrySettled(pinned16 || gB);
          const ptE = recPt16(gE, pE16.name);
          const ptC = recPt16(gE, pC16.name);
          let dragOrder16 = null;
          if (ptE && ptC) {
            win32.moveMousePhys(ptE.x, ptE.y);
            await sleep(250);
            win32.send([win32.mouseInput(0, 0, win32.LEFTDOWN)]);
            for (let s = 1; s <= steps16; s++) {
              await sleep(24);
              win32.moveMousePhys(ptE.x + Math.round(((ptC.x - ptE.x) * s) / steps16), ptE.y + Math.round(((ptC.y - ptE.y) * s) / steps16));
            }
            await sleep(140);
            win32.send([win32.mouseInput(0, 0, win32.LEFTUP)]);
            await waitEvent('taskbar-drag-drop', (e) => e.from === 'recs' && e.to === 'recs' && e.id === pE16.name && e.before === pC16.name, 6000);
            for (let i = 0; i < 30 && !dragOrder16; i++) {
              await sleep(200);
              const cand = latestGeometry(null);
              const names = recNames16(cand);
              if (names.length === 5 && names.indexOf(pE16.name) >= 0 && names.indexOf(pE16.name) < names.indexOf(pC16.name)) dragOrder16 = cand;
            }
          }
          if (dragOrder16) {
            rep.pass(`P16 推荐组内拖拽换位：E 拖至 C 之前（真 OLE 拖拽，显式序压过分数序，落位存证 recs→recs）`);
          } else {
            rep.fail(`P16 组内换位未达成：源/落点矩形=${!!ptE}/${!!ptC} 落位后序=${JSON.stringify(recNames16(latestGeometry(null)))}`);
          }

          // —— ⑤ 拖去应用组升手钉（recs→apps 跨组，落点条目前插入）——
          // 落点收尾三拍（红轮实证：跨 pill 拖拽 drop 会随热区开门时序抖动——第 3 轮同
          // 路径成、第 4 轮败，drag-start 在而 drag-drop 无）：到靶后停一拍（热区 25ms
          // 轮询开门）→ 小步 jitter 两下（dragover 重注册）→ 再抬键。
          let gD = await waitGeometrySettled(dragOrder16 || gE);
          const ptD = recPt16(gD, pD16.name);
          const ptApps = appPt16(gD, pB16.exe); // 落点 = 探针 B 的应用组矩形（按 exe 定位——机器可能有用户自钉条目占前段，下标不可用）
          let cross16 = null;
          if (ptD && ptApps) {
            win32.moveMousePhys(ptD.x, ptD.y);
            await sleep(250);
            win32.send([win32.mouseInput(0, 0, win32.LEFTDOWN)]);
            for (let s = 1; s <= steps16; s++) {
              await sleep(24);
              win32.moveMousePhys(ptD.x + Math.round(((ptApps.x - ptD.x) * s) / steps16), ptD.y + Math.round(((ptApps.y - ptD.y) * s) / steps16));
            }
            await sleep(300); // 到靶停拍：热区开门 + dragover 落 B
            win32.moveMousePhys(ptApps.x - 3, ptApps.y);
            await sleep(120);
            win32.moveMousePhys(ptApps.x, ptApps.y);
            await sleep(200);
            win32.send([win32.mouseInput(0, 0, win32.LEFTUP)]);
            await waitEvent('taskbar-drag-drop', (e) => e.from === 'recs' && e.to === 'apps' && e.id === pD16.name, 6000);
            for (let i = 0; i < 30 && !cross16; i++) {
              await sleep(200);
              const cand = latestGeometry(null);
              // 落点前插判据：D 紧邻 B 之前（pinEntry before 语义；G 随 D 升钉递补——可见恒 5；
              // 用户自钉条目可在段首）
              if (cand && recNames16(cand).length === 5 && recNames16(cand).includes(p16.extras[1].name)) {
                const apps16 = cand.apps || [];
                const di16 = apps16.findIndex((a) => norm16(a.id) === norm16(pD16.exe));
                const bi16 = apps16.findIndex((a) => norm16(a.id) === norm16(pB16.exe));
                if (di16 >= 0 && bi16 === di16 + 1) cross16 = cand;
              }
            }
          }
          if (cross16) {
            const apps16 = cross16.apps || [];
            rep.pass(`P16 拖去应用组升手钉：D 拖至 B 之前（跨组 recs→apps 落点前插——应用组 [${apps16.map((a) => path.basename(String(a.id))).join(', ')}]，推荐组恒 5 枚、第 7 名 G 递补不双占位）`);
          } else {
            rep.fail(`P16 跨组升手钉未达成：源/落点矩形=${!!ptD}/${!!ptApps}`
              + ` 应用组=${JSON.stringify((latestGeometry(null).apps || []).map((a) => a.id))} 推荐组=${JSON.stringify(recNames16(latestGeometry(null)))}`);
          }

          // —— ⑥ 解除手钉随下拍回池 + 打开文件位置（工单193：菜单锚点随迁浮层窗）——
          // 应用组右键菜单已迁竖排浮层窗 DECK-TASKBAR-MENU（横排进 pill 退役）：行几何
          // 取 taskbar-app-menu-ready（rows 带 y/h）与 opened/resized（窗 bounds）两路
          // 配对（55 族 overflow 浮层先例同款验收缝），动作存证名不变。右键两试（第 5 轮
          // 实证 pill-apps 右键偶发不开菜单）：未开则光标离位刷新热区、重取 settle 几何再试。
          const APP_MENU_TITLE = 'DECK-TASKBAR-MENU';
          const APP_MENU_LABELS = { pin: '手钉到任务栏', unpin: '解除手钉', close: '关闭窗口', reveal: '打开文件位置' };
          const popupSince16 = (since) => {
            const os = readEvents().filter((e) => e.t >= since
              && (e.type === 'taskbar-app-menu-opened' || e.type === 'taskbar-app-menu-resized'));
            const rd = readEvents().filter((e) => e.type === 'taskbar-app-menu-ready' && e.t >= since && Array.isArray(e.rows));
            return os.length && rd.length ? { bounds: os[os.length - 1].bounds, rows: rd[rd.length - 1].rows, w: Number(rd[rd.length - 1].w) || 0 } : null;
          };
          let gU = await waitGeometrySettled(cross16 || gD);
          let ptU = appPt16(gU, pD16.exe); // 解除对象 = 探针 D（拖拽升手钉；按 exe 定位）
          let repool16 = null;
          let unpinPop = null; // { bounds, rows, w }：浮层在场证据（含行矩形）
          let menuRowsOk16 = false; // 条目集现状断言（工单193：行集随迁不变）
          let horizGone16 = false; // 横排入口退役断言：pill 区域不再出应用菜单行
          let rowClose16 = null; // 行点即收存证（reason=row）
          for (let attempt16 = 0; attempt16 < 2 && ptU && !unpinPop; attempt16++) {
            const since16 = Date.now();
            win32.clickPhys(ptU.x, ptU.y, 'right');
            for (let i = 0; i < 12 && !unpinPop; i++) {
              await sleep(200);
              unpinPop = popupSince16(since16);
            }
            if (unpinPop && !menuRowsOk16) {
              // 行集断言（条目集现状）：首行按 pinned 取 手钉/解除手钉、运行中在列关闭窗口、
              // 打开文件位置恒在——期望行集从内核态的 pinned/running 独立推导（规格编码）
              const stD = await cdpEval(`window.deck.bridge.invoke('taskbar/get-state', {})`, TASKBAR_TITLE);
              const dE = (stD && stD.apps ? stD.apps : []).find((a) => norm16(a.exe) === norm16(pD16.exe)) || {};
              const expect = [dE.pinned ? 'unpin' : 'pin', ...(dE.running ? ['close'] : []), 'reveal'];
              menuRowsOk16 = unpinPop.rows.map((r) => r.id).join(',') === expect.join(',')
                && unpinPop.rows.map((r) => r.label).join(',') === expect.map((x) => APP_MENU_LABELS[x]).join(',');
              // 横排入口退役（工单196 AC 全条带口径）：浮层在场拍，条带 DOM 不再有
              // 任何菜单行/窗口列表行（五面全迁浮层，pill 内横排形态整体退役）
              horizGone16 = await stripMenuRows16().then((rows) => Array.isArray(rows) && rows.length === 0);
            }
            if (!unpinPop && attempt16 === 0) {
              win32.moveMousePhys(ptU.x, ptU.y - 60); // 离位刷新热区
              await sleep(300);
              gU = await waitGeometrySettled(latestGeometry(null));
              ptU = appPt16(gU, pD16.exe);
            }
          }
          if (ptU && unpinPop) {
              // 点行核验重试（红轮实证：菜单开、行在，点行那一下仍可能撞热区轮询窗落空——
              // 事件 3s 不来就重查行矩形再点，≤3 试；到靶停拍同 P16⑤ 先例）。行矩形 = 浮层
              // 窗 bounds + ready 行偏移（55 族 rowPt 同式；面板子进程主屏原点 (0,0)，DIP×缩放即物理）
              for (let click16 = 0; click16 < 3 && !repool16; click16++) {
                const popNow = popupSince16(Date.now() - 12000);
                const rowNow = popNow && popNow.rows.find((r) => r.id === 'unpin');
                if (!rowNow) break;
                const up = {
                  x: Math.round((popNow.bounds.x + popNow.w / 2) * scale),
                  y: Math.round((popNow.bounds.y + rowNow.y + rowNow.h / 2) * scale),
                };
                win32.moveMousePhys(up.x, up.y);
                await sleep(250);
                win32.clickPhys(up.x, up.y, 'left');
                const ev16 = await waitEvent('taskbar-app-menu-action', (e) => e.action === 'unpin' && norm16(e.exe || '') === norm16(pD16.exe), 3000);
                if (!ev16) continue;
                rowClose16 = await waitEvent('taskbar-app-menu-closed', (e) => e.reason === 'row' && e.t >= Date.now() - 6000, 5000); // 行点即收（随 pass 行一并呈报）
                for (let i = 0; i < 30 && !repool16; i++) {
                  await sleep(200);
                  const cand = latestGeometry(null);
                  if (cand && recNames16(cand).includes(pD16.name) && recNames16(cand).length === 5
                    && !(cand.apps || []).some((a) => norm16(a.id) === norm16(pD16.exe))) repool16 = cand;
                }
              }
          }
          // 点外即收（工单193 AC）：再开一扇（右键探针 B——③手钉的在册条目），条带内点击
          // （时钟格——非内核动作键，dispatch 噪声免费）转达收层（strip-click）。blur 路径
          // 已由 55 族臂5 在同一载体实证（浮层窗 blur 收「栏外」点击，桌面/应用窗夺焦；
          // 面板钉底永不激活点不出 blur——缝隙点击落在面板上无效），此处不再拉探针重复拉证。
          // B 定位走条带页 CDP 现取 DOM 矩形（P13/P15 同款观察缝）——应用组 pill 随托盘
          // churn 每拍重居中，settle 几何快照到点击之间必有一拍 churn 概率（两轮红轮实证
          // 右键落 pill 空白），现取矩形消掉这一整类失配。到靶停拍 300ms（热区 25ms 轮询
          // 翻转接收——行点后光标离条带，先挪上靶标再点击）。右键三试。
          const liveAppPt16 = async (exe) => {
            const r = await cdpEval(`(() => {
              const want = ${JSON.stringify(exe)}.toLowerCase();
              const el = [...document.querySelectorAll('#pill-apps .tb-app')].find((n) => (n.dataset.exe || '').toLowerCase() === want);
              return el ? el.getBoundingClientRect().toJSON() : null;
            })()`, TASKBAR_TITLE);
            return r ? toPhys(r.x + r.width / 2, r.y + r.height / 2) : null;
          };
          let outsideClose16 = null;
          for (let attemptB2 = 0; attemptB2 < 3 && !outsideClose16; attemptB2++) {
            const ptB2 = await liveAppPt16(pB16.exe);
            if (!ptB2) break; // B 不在栏（转 ⋯ 溢出）：子臂无从谈起
            const sinceB2 = Date.now();
            win32.moveMousePhys(ptB2.x, ptB2.y); // 到靶停拍：热区翻转接收后再点击
            await sleep(300);
            win32.clickPhys(ptB2.x, ptB2.y, 'right');
            for (let i = 0; i < 12 && !popupSince16(sinceB2); i++) await sleep(200);
            if (!popupSince16(sinceB2)) continue;
            const gClock = latestGeometry(null);
            const clockCell = (gClock.rightCells || []).find((c) => c.id === 'clock');
            if (clockCell) {
              const cp = toPhys(clockCell.x + clockCell.w / 2, clockCell.y + clockCell.h / 2);
              win32.moveMousePhys(cp.x, cp.y);
              await sleep(250);
              win32.clickPhys(cp.x, cp.y, 'left');
              outsideClose16 = await waitEvent('taskbar-app-menu-closed', (e) => (e.reason === 'strip-click' || e.reason === 'blur') && e.t >= Date.now() - 6000, 5000);
            }
          }
          // 打开文件位置（推荐位 C）：右键 → 点 reveal 行（工单196 迁浮层窗锚点）→
          // explorer 定位窗口真出场（软核验收尾关闭）。右键三试（模块级助手内置：
          // 右键偶发不开菜单——离位刷新热区+重取几何再试）。
          let reveal16 = null;
          let expHwnd16 = null;
          const gR0 = await waitGeometrySettled(repool16 || gU);
          const ptR = recPt16(gR0, pC16.name);
          const popR = ptR ? await rightClickPopupVerify(() => recPt16(latestGeometry(null), pC16.name), REC_MENU_FAMILY16, 3) : null;
            if (popR) {
              reveal16 = await clickPopupRowVerify(REC_MENU_FAMILY16, popR.since, 'reveal', 'taskbar-rec-menu-action', (e) => e.name === pC16.name && e.action === 'reveal', scale);
              await waitEvent('taskbar-rec-menu-result', (e) => e.name === pC16.name && e.action === 'reveal', 5000);
              const dirName = path.basename(p16.tmpDir);
              for (let i = 0; i < 24 && !expHwnd16; i++) {
                await sleep(250);
                expHwnd16 = win32.topLevelWindows().find((h) => win32.className(h) === 'CabinetWClass' && titleOf(h).includes(dirName)) || null;
              }
              if (expHwnd16) PostMessageW16(expHwnd16, WM_CLOSE_16, 0, 0); // 只关窗不碰 shell
            }
          if (repool16 && reveal16 && menuRowsOk16 && horizGone16 && outsideClose16) {
            rep.pass(`P16 解除手钉回池+打开文件位置（工单193 菜单随迁浮层窗）：右键浮层 DECK-TASKBAR-MENU 在场`
              + `（条目集现状行集=${unpinPop.rows.map((r) => r.label).join('/')}）、pill 内横排行已退役；`
              + `解除手钉行点存证（exe 身份核对）+行点即收${rowClose16 ? '在案' : '（收层存证缺席）'}、D 随下拍回池（推荐组恒 5、第 7 名 G 让位、应用组摘除）；`
              + `点外即收（reason=${outsideClose16.reason}）；reveal 行点击存证在案${expHwnd16 ? '，explorer 定位窗口真出场（已收窗）' : '（explorer 窗未及出场，软核验）'}`);
          } else {
            const diagU = await stripMenuRows16(); // 横排退役诊断（条带菜单行应恒空）
            rep.fail(`P16 解除回池/reveal：回池=${!!repool16}(recs=${JSON.stringify(recNames16(latestGeometry(null)))})`
              + ` 浮层行集=${unpinPop ? JSON.stringify(unpinPop.rows.map((r) => r.id)) : '未开'} rowsOk=${menuRowsOk16} 横排退役=${horizGone16}`
              + ` 行点即收=${rowClose16 ? JSON.stringify(rowClose16.reason) : '缺'} 点外即收=${outsideClose16 ? outsideClose16.reason : '缺'}`
              + ` reveal存证=${!!reveal16} explorer窗=${expHwnd16 ? '在场' : '未出场'} 条带菜单诊断=${JSON.stringify(diagU)}`);
          }
        }
      }
    }

    // P17 推荐组移除名单（工单161）：持久排除 + 名次递补 + 空白右键恢复。三臂——
    // ①右键探针 F（第 6 名，经⑤递补在栏）→ 菜单恰三行 → 点「从推荐栏移除」→ F 即时消失、
    //   第 7 名 G 递补（可见恒 5），移除落盘（get-state excluded 含 F，exe=富化目标身份）；
    // ②推荐组空白右键 → 恢复段在列（「恢复 <显示名>」行）→ 点选 → F 回池（G 让位），
    //   excluded 清空；
    // ③重启保持：CDP 桥直发 rec-remove（输入注入路径①已证）→ killTree+重启面板 →
    //   get-state 排除名单与可见名单都保持（F 不复活、G 占位）→ 空白右键恢复行仍在 →
    //   点选恢复 → F 回池。工单196（ADR-0013）：移除臂菜单迁浮层窗 DECK-TASKBAR-REC-MENU、
    //   恢复入口迁浮层窗 DECK-TASKBAR-BLANK-MENU（通用弹窗通路域适配器——t193 票内
    //   「横排保留」裁定随本票通路迁移退役），断言锚点随迁浮层窗（章法改段）。
    rep.beginSegment('P17');
    if (!p16 || !(p16.extras && p16.extras.length === 2)) {
      rep.fail('P17 前置缺失：探针/递补候选种入失败（见种入 note）');
    } else {
      const pF17 = p16.extras[0]; // F：递补源（本段移除→恢复的主角）
      const pG17 = p16.extras[1]; // G：递补实证的补位者
      const norm17 = (s) => String(s || '').toLowerCase();
      const recNames17 = (g) => (g && g.recommendations ? g.recommendations.map((r) => r.name) : []);
      const recPt17 = (g, name) => {
        const r = (g.recommendations || []).find((x) => x.name === name);
        return r ? toPhys(r.x + r.w / 2, r.y + r.h / 2) : null;
      };
      const state17 = () => cdpEval(`window.deck.bridge.invoke('taskbar/get-state', null)`, TASKBAR_TITLE);
      const REC_MENU_FAMILY17 = 'taskbar-rec-menu';       // 移除臂浮层（DECK-TASKBAR-REC-MENU）
      const BLANK_MENU_FAMILY17 = 'taskbar-blank-menu';   // 恢复臂浮层（DECK-TASKBAR-BLANK-MENU）
      // 空白右键（恢复菜单挂点 = 推荐组空白，工单192 起推荐组独立 pill 承接；工单196 迁
      // 浮层窗 DECK-TASKBAR-BLANK-MENU——系统显隐+恢复段同一面）：两点轮试——顶部内衬横
      // 中点（水平余量大）、左缘内衬中点兜底。推荐组 pill 不在场时回退开始组空白。每次
      // 尝试后轮询浮层 ready 行集。到靶停拍 250ms（热区开门先例）。
      const blankRightClick17 = async (gBlank) => {
        const pillOf = (g) => (g.recPill && g.recPill.w > 0 ? g.recPill : (g.startPill.w > 0 ? g.startPill : null));
        const pill = pillOf(gBlank);
        if (!pill) return { row: null, tag: 'no-pill', since: 0 };
        const cands = [
          { x: pill.x + pill.w / 2, y: pill.y + 3, tag: 'top-pad-center' },
          { x: pill.x + 3, y: pill.y + pill.h / 2, tag: 'left-pad-mid' },
        ];
        for (const c of cands) {
          const pt = toPhys(c.x, c.y);
          win32.moveMousePhys(pt.x, pt.y);
          await sleep(250); // 到靶停拍
          const since = Date.now();
          win32.clickPhys(pt.x, pt.y, 'right');
          for (let i = 0; i < 10; i++) {
            await sleep(200);
            const pop = popupAnchored(BLANK_MENU_FAMILY17)(since);
            // 行身份 restore:<exe> 归一前缀匹配（excluded.exe 与探针 exe 的字节差不破匹配）
            const row = pop ? pop.rows.find((r) => r.id.startsWith('restore:')
              && norm17(r.id.slice('restore:'.length)) === norm17(pF17.exe)) : null;
            if (row) return { row, tag: c.tag, since };
          }
          rep.note(`P17 空白右键试点 ${c.tag} 未出恢复行（浮层未开或恢复行缺席——excluded 空态或开层失手）`);
          // 收层再试下一点（右键恒重开语义，重开即重锚定）
          win32.moveMousePhys(pt.x, pt.y - 60);
          await sleep(300);
          const g2 = await waitGeometrySettled(latestGeometry(null));
          if (g2) {
            const p2 = pillOf(g2);
            if (p2) {
              pill.x = p2.x; pill.y = p2.y; pill.w = p2.w; pill.h = p2.h;
            }
          }
        }
        return { row: null, tag: 'none', since: 0 };
      };
      // ① 右键 F → 三行（工单196 迁浮层窗 DECK-TASKBAR-REC-MENU）→ 点「从推荐栏移除」
      // → F 消失 G 递补 + 移除落盘（右键三试核验内置——右键偶发不开菜单＝⑥解除臂同款抖动）
      let g17 = await waitGeometrySettled(latestGeometry(null));
      const ptF0 = recPt17(g17, pF17.name);
      let removed17 = null;
      let rows17 = null;
      if (!ptF0) {
        rep.fail(`P17 前置缺失：探针 F 不在推荐位（${JSON.stringify(recNames17(g17))}）`);
      } else {
        const popF17 = await rightClickPopupVerify(() => recPt17(latestGeometry(null), pF17.name), REC_MENU_FAMILY17, 3);
        rows17 = popF17 ? popF17.rows : null;
        if (!rows17) rep.note('P17 移除臂右键三试未开浮层');
        if (rows17 && rows17.map((r) => r.id).join(',') === 'pin,remove,reveal'
          && rows17.map((r) => r.label).join(',') === '手钉到任务栏,从推荐栏移除,打开文件位置') {
          const clicked17 = await clickPopupRowVerify(REC_MENU_FAMILY17, popF17.since, 'remove', 'taskbar-rec-menu-action', (e) => e.name === pF17.name && e.action === 'remove', scale);
          rep.note(`P17① 移除行点击存证=${!!clicked17}（浮层窗行点，name/exe 身份随事件核对）`);
          for (let i = 0; i < 30 && !removed17; i++) {
            await sleep(200);
            const cand = latestGeometry(null);
            if (cand && recNames17(cand).length === 5 && !recNames17(cand).includes(pF17.name)
              && recNames17(cand).includes(pG17.name)) removed17 = cand;
          }
        }
        const st17 = await state17();
        const excludedOk17 = !!(st17 && Array.isArray(st17.excluded) && st17.excluded.some((e) => norm17(e.exe) === norm17(pF17.exe)));
        if (removed17 && excludedOk17) {
          rep.pass(`P17 从推荐栏移除：三行菜单点「从推荐栏移除」→ F 即时消失、第 7 名 G 递补（可见恒 5），`
            + `持久排除落盘（excluded 含富化身份 ${path.basename(pF17.exe)}）`);
        } else {
          rep.fail(`P17 移除臂：菜单=${JSON.stringify(rows17)} 递补=${!!removed17}(recs=${JSON.stringify(recNames17(latestGeometry(null)))}) 落盘=${excludedOk17}`);
        }

        // ② 推荐组空白右键 → 恢复段（工单196 迁浮层窗 DECK-TASKBAR-BLANK-MENU）点选 → F 回池（G 让位）
        let restored17 = null;
        let row17 = null;
        let hit17 = null;
        {
          const gBlank = await waitGeometrySettled(latestGeometry(null));
          hit17 = await blankRightClick17(gBlank);
          row17 = hit17.row;
          if (row17) rep.note(`P17 恢复段经试点 ${hit17.tag} 开出（浮层窗 DECK-TASKBAR-BLANK-MENU）`);
        }
        if (row17) {
          const labelOk17 = row17.label === `恢复 ${pF17.name.replace(/\.lnk$/i, '')}`;
          const clicked17 = await clickPopupRowVerify(BLANK_MENU_FAMILY17, hit17.since, row17.id, 'taskbar-rec-restore', (e) => norm17(e.exe) === norm17(pF17.exe), scale);
          rep.note(`P17② 恢复行点击存证=${!!clicked17}（restore:<exe> 行身份，事件 exe 对账）`);
          for (let i = 0; i < 30 && !restored17; i++) {
            await sleep(200);
            const cand = latestGeometry(null);
            if (cand && recNames17(cand).length === 5 && recNames17(cand).includes(pF17.name)
              && !recNames17(cand).includes(pG17.name)) restored17 = cand;
          }
          const stClean17 = await state17();
          const cleanOk17 = !!(stClean17 && Array.isArray(stClean17.excluded) && stClean17.excluded.length === 0);
          if (restored17 && cleanOk17) {
            rep.pass(`P17 空白右键恢复：恢复段「${row17.label}」行在列（label 对扫描显示名=${labelOk17}），点选即回池`
              + `（F 复见、G 让位）、excluded 清空`);
          } else {
            rep.fail(`P17 恢复臂：行=${JSON.stringify(row17)} 回池=${!!restored17}(recs=${JSON.stringify(recNames17(latestGeometry(null)))}) excluded清空=${cleanOk17}`);
          }
        } else {
          rep.fail(`P17 恢复臂前置缺失：空白右键恢复段未开出（excluded 应含 F）`);
        }

        // ③ 重启保持：再移除 → 重启面板 → 名单与排除都保持 → 恢复入口仍可达
        await cdpEval(`window.deck.bridge.invoke('taskbar/rec-remove', { exe: ${JSON.stringify(pF17.exe)} })`, TASKBAR_TITLE);
        await sleep(600); // 落盘+重排一帧
        const stBefore17 = await state17();
        const diskOk17 = !!(stBefore17 && Array.isArray(stBefore17.excluded) && stBefore17.excluded.some((e) => norm17(e.exe) === norm17(pF17.exe)));
        killTree(child, panelPid);
        child = null;
        await sleep(1200);
        const since17 = Date.now();
        child = launchPanel();
        const boot17 = await waitEvent('boot', (e) => e.t >= since17, 15000);
        if (boot17) {
          panelPid = boot17.pid;
          await waitWindow(panelPid, TASKBAR_TITLE, 12000);
        }
        let reboot17 = null;
        for (let i = 0; i < 40 && !reboot17; i++) {
          await sleep(300); // 推荐位随数据面快照后到位（P16 同款等待）
          const g2 = latestGeometry(null);
          if (g2 && recNames17(g2).length === 5 && !recNames17(g2).includes(pF17.name) && recNames17(g2).includes(pG17.name)) reboot17 = g2;
        }
        const stAfter17 = await state17();
        const persistOk17 = !!(stAfter17 && Array.isArray(stAfter17.excluded) && stAfter17.excluded.some((e) => norm17(e.exe) === norm17(pF17.exe)));
        // 重启后恢复入口仍可达：空白右键 → 恢复行在 → 点选 → F 回池
        let rowAfter17 = null;
        let restoredAfter17 = null;
        if (boot17 && reboot17 && persistOk17) {
          const gBlank = await waitGeometrySettled(latestGeometry(null));
          const hit = await blankRightClick17(gBlank);
          rowAfter17 = hit.row;
          if (rowAfter17) rep.note(`P17 重启后恢复段经试点 ${hit.tag} 开出（浮层窗行集）`);
          if (rowAfter17) {
            const clickedAfter17 = await clickPopupRowVerify(BLANK_MENU_FAMILY17, hit.since, rowAfter17.id, 'taskbar-rec-restore', (e) => norm17(e.exe) === norm17(pF17.exe), scale);
            rep.note(`P17③ 重启后恢复行点击存证=${!!clickedAfter17}`);
            for (let i = 0; i < 30 && !restoredAfter17; i++) {
              await sleep(200);
              const cand = latestGeometry(null);
              if (cand && recNames17(cand).includes(pF17.name) && !recNames17(cand).includes(pG17.name)) restoredAfter17 = cand;
            }
          }
        }
        if (diskOk17 && boot17 && reboot17 && persistOk17 && restoredAfter17) {
          rep.pass(`P17 重启保持：移除落盘（重启前 excluded 在）→ 面板重启后排除名单保持（F 不复活、G 占位）、`
            + `空白右键恢复行仍在 → 点选即回池（重启记住 + 恢复入口跨重启可达）`);
        } else {
          rep.fail(`P17 重启臂：重启前落盘=${diskOk17} boot=${!!boot17} 可见名单=${!!reboot17}(recs=${JSON.stringify(recNames17(latestGeometry(null)))}) `
            + `重启后排除保持=${persistOk17} 恢复行=${!!rowAfter17} 回池=${!!restoredAfter17}`);
        }
      }
    }

    // P19 推荐组独立漂浮 pill（工单192）：拆出开始组的独立容器（开始组右侧、应用组左侧，
    // 间隙与样式同族）与两组显隐解耦。三臂——
    // ①独立容器在场：P16/P17 存活的五探针推荐位全部落 #pill-recs 界内、开始组 pill 内
    //   零残留（.tb-rec 不再出现在 #pill-start）、与开始组有明确间隙（GROUP_GAP 8px）、
    //   应用组不越推荐组右缘（应用组空带左邻=推荐组右缘）；
    // ②显隐解耦正向：CDP 藏两系统按钮 → 开始组 display:none、推荐组独立在场（recPill
    //   在场、recommendations 名单不变、退条带左缘内衬 x≈8），复原后开始组回归；
    // ③解耦反向：迭代 rec-remove 当前可见名单直至候选池竭（滤除后截断语义——移除腾位
    //   即时递补，清空=池竭）→ 推荐组 display:none、recPill 矩形归零、recommendations []、
    //   开始组不受牵连；移除账全数 rec-restore 回池（excluded 清空复原）。
    // 全臂 CDP 桥直发 + 几何存证帧 + DOM 读取（显隐裁决面，无输入注入——驱动式同 P15）。
    rep.beginSegment('P19');
    if (!p16) {
      rep.fail('P19 前置缺失：P16 探针种入失败（见种入 note）');
    } else {
      const probes19 = p16.probes;
      const recNames19 = (g) => (g && g.recommendations ? g.recommendations.map((r) => r.name) : []);
      const state19 = () => cdpEval(`window.deck.bridge.invoke('taskbar/get-state', null)`, TASKBAR_TITLE);
      const GAP19 = 8; // 渲染层 GROUP_GAP（taskbar-view appsBand 纯函数常量，CSS px，与 P15 同源）
      // —— ① 独立容器在场与组间隙 ——
      const g19 = await waitGeometrySettled(latestGeometry(null));
      const dom19 = await cdpEval(`(() => {
        const rs = document.getElementById('pill-recs');
        const st = document.getElementById('pill-start');
        return {
          recsDisplay: rs ? getComputedStyle(rs).display : 'missing',
          recsInlineLeft: rs ? rs.style.left : '',
          recCells: rs ? rs.querySelectorAll('.tb-rec').length : -1,
          startCells: st ? st.querySelectorAll('.tb-rec').length : -1,
        };
      })()`, TASKBAR_TITLE);
      const names19 = recNames19(g19);
      const pill19 = g19.recPill && g19.recPill.w > 0 ? g19.recPill : null;
      // 前置口径：可见推荐位全部是本电池夹具身份（DECK-P16-*）且非空——探针 B 在 P16③
      // 已合法手钉迁出推荐组（第 6 名 F 递补），可见集 = 探针减手钉加递补，不要求全五探针
      const fixture19 = names19.length > 0 && names19.every((n) => String(n).startsWith('DECK-P16-'));
      const inside19 = !!pill19 && names19.every((n) => {
        const r = (g19.recommendations || []).find((x) => x.name === n);
        return r && r.x >= pill19.x - 0.5 && r.x + r.w <= pill19.x + pill19.w + 0.5;
      });
      const gapOk19 = !!pill19 && g19.startPill.w > 0
        && pill19.x >= g19.startPill.x + g19.startPill.w + GAP19 - 0.5;
      const appsAfter19 = !pill19 || g19.appsPill.w === 0
        || g19.appsPill.x >= pill19.x + pill19.w + GAP19 - 0.5;
      const zeroResidue19 = dom19.startCells === 0;
      const domOk19 = dom19.recsDisplay !== 'none' && dom19.recsInlineLeft !== ''
        && dom19.recCells === names19.length;
      if (fixture19 && inside19 && gapOk19 && appsAfter19 && zeroResidue19 && domOk19) {
        rep.pass(`P19 推荐组独立漂浮 pill：${names19.length} 枚推荐位全部界内 #pill-recs`
          + `（pill @${pill19.x.toFixed(0)}，开始组零残留），与开始组间隙达标（≥8px）`
          + `、应用组居其右侧空带，独立容器 DOM 在场`);
      } else {
        rep.fail(`P19 独立容器：夹具集=${fixture19}(${JSON.stringify(names19)}) 界内=${inside19} 间隙=${gapOk19}`
          + ` 应用组右置=${appsAfter19} 开始组零残留=${zeroResidue19}(startCells=${dom19.startCells})`
          + ` DOM=${domOk19}(${JSON.stringify(dom19)}) recPill=${JSON.stringify(g19.recPill || null)}`);
      }

      // —— ② 显隐解耦正向：藏两系统按钮 → 开始组不渲染、推荐组独立在场 ——
      const sinceHide19 = Date.now();
      await cdpEval(`(async () => {
        await window.deck.bridge.invoke('taskbar/set-button-hidden', { id: 'start', hidden: true });
        await window.deck.bridge.invoke('taskbar/set-button-hidden', { id: 'tasks', hidden: true });
      })()`);
      let decoupled19 = null;
      for (let i = 0; i < 30 && !decoupled19; i++) {
        await sleep(200);
        const cand = latestGeometry(null);
        if (cand && cand.t >= sinceHide19 && cand.startPill && cand.startPill.w === 0
          && cand.recPill && cand.recPill.w > 0 && recNames19(cand).length === names19.length) decoupled19 = cand;
      }
      const domHide19 = decoupled19 ? await cdpEval(`(() => {
        const rs = document.getElementById('pill-recs');
        const st = document.getElementById('pill-start');
        return {
          recsDisplay: rs ? getComputedStyle(rs).display : 'missing',
          startDisplay: st ? getComputedStyle(st).display : 'missing',
          recsLeft: rs ? rs.style.left : '',
        };
      })()`, TASKBAR_TITLE) : null;
      const hideOk19 = !!(decoupled19 && domHide19
        && domHide19.startDisplay === 'none'
        && domHide19.recsDisplay !== 'none'
        && Math.abs(parseFloat(domHide19.recsLeft || 'NaN') - 8) <= 2); // 退条带左缘内衬（APPS_INSET=8）
      // 复原两钮（显式复原；config 三态还原兜底）
      const sinceShow19 = Date.now();
      await cdpEval(`(async () => {
        await window.deck.bridge.invoke('taskbar/set-button-hidden', { id: 'start', hidden: false });
        await window.deck.bridge.invoke('taskbar/set-button-hidden', { id: 'tasks', hidden: false });
      })()`);
      let reshown19 = null;
      for (let i = 0; i < 30 && !reshown19; i++) {
        await sleep(200);
        const cand = latestGeometry(null);
        if (cand && cand.t >= sinceShow19 && cand.startPill && cand.startPill.w > 0
          && cand.recPill && cand.recPill.w > 0) reshown19 = cand;
      }
      if (hideOk19 && reshown19) {
        rep.pass(`P19 显隐解耦正向：两系统按钮全藏 → 开始组不渲染（display:none）、推荐组独立在场`
          + `（recPill 退条带左缘 left=${domHide19.recsLeft}，${recNames19(decoupled19).length} 枚推荐位无牵连），复原后开始组回归`);
      } else {
        rep.fail(`P19 解耦正向：藏钮后=${hideOk19}(帧=${decoupled19 ? JSON.stringify({ startPill: decoupled19.startPill, recPill: decoupled19.recPill }) : 'null'}`
          + ` dom=${JSON.stringify(domHide19 || {})}) 复原=${!!reshown19}`);
      }

      // —— ③ 解耦反向：推荐位清空 → 推荐组不渲染、开始组不受牵连；回池复原 ——
      // 迭代 rec-remove 当前可见名单直至候选池竭（滤除后截断语义——移除腾位即时递补，
      // 清空=池竭），移除账全数记录、段末 rec-restore 原路回池（excluded 清空复原）。
      // 池竭前置可能被机器态封死：桌面滞留项 exe 富化空串（resolveShortcutTarget 空串
      // 兜底链死角）= 契约惰性身份——rec-remove/rec-pin 六 exe 口 requireNonEmptyId 拒收、
      // 存储装载器丢空 exe 条目，用户无任何路径可排除之；此时断言本体保留（不降阈值），
      // 本臂记环境降责排除（机器态）留证，真失败（可移除身份滞留=移除未生效）照判红。
      const seenRemove19 = [];
      let emptied19 = null;
      let stuck19 = null; // 池里滞留的条目（含完整形态诊断——exe 富化身份是裁决依据）
      const sinceRemove19 = Date.now();
      // 滞留宽限：账已覆盖当前池 / exe 暂空时，数据面下一拍可能重算富化身份或清池——
      // 重轮 get-state（≤5×400ms）再判滞留，不立断（同拍竞态的陈旧读不作数）
      const regauge19 = async (recs) => {
        for (let i = 0; i < 5; i++) {
          await sleep(400);
          const st = await state19();
          const list = st && Array.isArray(st.recommendations) ? st.recommendations : [];
          if (!list.length) return { recs: [] };
          const exes = [...new Set(list.map((r) => String(r.exe || '')).filter(Boolean))];
          if (exes.some((exe) => !seenRemove19.includes(exe))) return { recs: list };
          if (exes.length) continue; // 还是已见身份，继续宽限
        }
        return { recs };
      };
      for (let round19 = 0; round19 < 24 && !emptied19; round19++) {
        const st19 = await state19();
        const recs19 = st19 && Array.isArray(st19.recommendations) ? st19.recommendations : [];
        const exes19 = [...new Set(recs19.map((r) => String(r.exe || '')).filter(Boolean))];
        if (!recs19.length) {
          for (let i = 0; i < 30 && !emptied19; i++) {
            await sleep(200);
            const cand = latestGeometry(null);
            if (cand && cand.t >= sinceRemove19 && recNames19(cand).length === 0
              && cand.recPill && cand.recPill.w === 0 && cand.startPill && cand.startPill.w > 0) emptied19 = cand;
          }
          break;
        }
        if (!exes19.length || exes19.every((exe) => seenRemove19.includes(exe))) {
          const re = await regauge19(recs19);
          if (!re.recs.length) continue; // 池清了，外层走空分支
          if (re.recs !== recs19) continue; // 新身份进池，外层继续移除
          stuck19 = re.recs;
          break;
        }
        for (const exe of exes19) if (!seenRemove19.includes(exe)) seenRemove19.push(exe);
        await cdpEval(`(async () => {
          for (const exe of ${JSON.stringify(exes19)}) {
            await window.deck.bridge.invoke('taskbar/rec-remove', { exe });
          }
        })()`, TASKBAR_TITLE);
        await sleep(400); // 一移除一拍：changed 回推/几何帧到位再取下一轮名单
      }
      // 回池复原（rec-restore 全数移除账；excluded 清空 = 复原干净，不给后续段留账）
      await cdpEval(`(async () => {
        for (const exe of ${JSON.stringify(seenRemove19)}) {
          await window.deck.bridge.invoke('taskbar/rec-restore', { exe });
        }
      })()`, TASKBAR_TITLE);
      let repool19 = null;
      for (let i = 0; i < 30 && !repool19; i++) {
        await sleep(200);
        const cand = latestGeometry(null);
        if (cand && recNames19(cand).length === names19.length
          && names19.every((n) => recNames19(cand).includes(n))) repool19 = cand;
      }
      const stClean19 = await state19();
      const clean19 = !!(stClean19 && Array.isArray(stClean19.excluded) && stClean19.excluded.length === 0);
      if (emptied19) {
        const domEmpty19 = await cdpEval(`getComputedStyle(document.getElementById('pill-recs')).display`, TASKBAR_TITLE);
        if (domEmpty19 === 'none' && repool19 && clean19) {
          rep.pass(`P19 显隐解耦反向：候选池竭（移除 ${seenRemove19.length} 枚）→ 推荐组不渲染（display:none、`
            + `recPill 矩形归零、recommendations []），开始组在场不受牵连；rec-restore 回池复原`
            + `（可见集复原、excluded 清空）`);
        } else {
          rep.fail(`P19 解耦反向：清空=${!!emptied19} dom=${JSON.stringify(domEmpty19)} 回池=${!!repool19}`
            + `(recs=${JSON.stringify(recNames19(latestGeometry(null)))}) excluded清空=${clean19}`);
        }
      } else if (stuck19 && stuck19.length && stuck19.every((r) => !String(r.exe || ''))) {
        // 机器态封死（滞留体全部契约惰性身份）：空池前置本机不可达——断言保留、本臂记
        // 环境降责排除；可移除账已全数移除+回池、推荐组仍按非空在场（与①一致）作旁证
        const keptRender19 = await cdpEval(`(() => {
          const rs = document.getElementById('pill-recs');
          return { display: rs ? getComputedStyle(rs).display : 'missing', cells: rs ? rs.querySelectorAll('.tb-rec').length : -1 };
        })()`, TASKBAR_TITLE);
        rep.note(`P19 反向臂机器态滞留：可移除账 ${seenRemove19.length} 枚全移除+回池=${!!repool19}、`
          + `滞留体 ${JSON.stringify(stuck19.map((r) => ({ name: r.name, exe: r.exe })))} 契约惰性（渲染 ${keptRender19.cells} 格保持在场=非空不渲染界线一致）`);
        rep.exclude(`P19 显隐解耦反向（池竭清空）本机前置不可达：滞留体 exe 富化空串、契约性不可排除`
          + `（rec-remove requireNonEmptyId 拒收 + 存储装载滤空 exe 条目）——空渲染断言保留未降阈值`,
        '机器态：桌面滞留项（ZCode.lnk 同类）空 exe 身份进池且用户无排除路径', 'machine-state');
      } else {
        rep.fail(`P19 解耦反向：清空=${!!emptied19}(移除账=${seenRemove19.length}`
          + ` 池内滞留=${stuck19 ? JSON.stringify(stuck19.map((r) => ({ name: r.name, exe: r.exe, path: r.path }))) : 'null'}`
          + ` 帧=${emptied19 ? JSON.stringify({ recPill: emptied19.recPill, startPill: emptied19.startPill }) : 'null'})`
          + ` 回池=${!!repool19}(recs=${JSON.stringify(recNames19(latestGeometry(null)))}) excluded清空=${clean19}`);
      }
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
    // P14 托盘点击回放负载语义（#164，回归面 = #163 取证坐实的回放全哑主因）：
    //   (前置) 重启用（P12 收在禁用态）→ 条带 + 宿主 + 名单回填
    //   (v0-右) CDP invoke 右键 → tray-replay 存证 wparam=uID/lparam=WM_RBUTTONUP +
    //           探针窗收帧逐字段一致 + pid=属主进程（抓 ASFW 传 hwnd 当 pid 回归）
    //   (v0-左) 真实 SendInput 点击条带探针图标（用户链路端到端：DOM handler → 桥 →
    //           宿主 → 回调到达）→ 收帧 lp=WM_LBUTTONUP(0x0202，旧实现误为 0x0203)
    //   (v4-右/v4-左) NIM_SETVERSION 协商 4 → SetCursorPos 定锚 → invoke →
    //           wparam=MAKELPARAM(x,y)/lparam=(uID<<16)|事件（右 WM_CONTEXTMENU/左
    //           WM_LBUTTONUP）——本机无真实 v4 样本，自注册探针补合成对照
    rep.beginSegment('P14');
    const t13on = Date.now();
    // P12(b) 重拉的面板渲染页可能尚未就位 CDP（boot 存证早于渲染页加载，红轮实证
    // /json 列表还无 AGENT DECK 目标）——先等面板窗在场，再重试取页（各 500ms 一拍）
    await waitWindow(panelPid, PANEL_TITLE, 10000);
    let r13on = null;
    for (let i = 0; i < 20 && !(r13on && r13on.enabled === true); i++) {
      try { r13on = await cdpEval(`window.deck.bridge.invoke('taskbar/set-enabled', { enabled: true })`); }
      catch { /* 渲染页未就位——下一拍重试 */ }
      if (!(r13on && r13on.enabled === true)) await sleep(500);
    }
    const strip13 = await waitWindow(panelPid, TASKBAR_TITLE, 10000);
    const hostReady13 = await waitEvent('tray-host-ready', (e) => e.t >= t13on, 10000);
    let roster13 = 0;
    for (let i = 0; i < 12 && roster13 === 0; i++) {
      await sleep(700);
      const st = await cdpEval(`window.deck.bridge.invoke('taskbar/get-state', {})`);
      roster13 = st && st.tray ? st.tray.length : 0;
    }
    if (!(r13on && r13on.enabled === true && strip13 && hostReady13 && roster13 >= 1)) {
      rep.fail(`P14 前置失败：启用=${r13on && r13on.enabled} 条带=${!!strip13} 宿主=${!!hostReady13} 名单=${roster13}`);
    } else {
      const {
        encodeNotifyIconData, NIM_ADD, NIM_DELETE, NIM_SETVERSION,
        NIF_MESSAGE, NIF_ICON, NIF_TIP,
      } = require(path.join(APP_ROOT, 'dist', 'main', 'trayhost', 'protocol.js'));
      const WM_LBUTTONUP_T = 0x0202, WM_RBUTTONUP_T = 0x0205, WM_CONTEXTMENU_T = 0x007b;
      // v0 uid 用满 32 位（断言 wParam 不截位）；v4 uid 高 16 位故意放垃圾（0x1234 应被丢弃）
      const PROBE_UID_V0 = 0x1640001;
      const PROBE_UID_V4 = 0x12341802;
      const CB_V0 = 0x8000 + 164, CB_V4 = 0x8000 + 165;
      probe164 = makeReplayProbe();
      if (!probe164.hwnd) throw new Error('P14 探针窗创建失败');
      const hicon164 = Number(LoadIconW164(0, 32512)); // IDI_APPLICATION
      const nidV0 = encodeNotifyIconData({ arch: 'x64', version: 3, hwnd: probe164.hwnd, uid: PROBE_UID_V0,
        flags: NIF_MESSAGE | NIF_ICON | NIF_TIP, callbackMessage: CB_V0, hicon: hicon164,
        tooltip: 'DECK164-PROBE-V0', uVersion: 0 });
      const nidV4 = encodeNotifyIconData({ arch: 'x64', version: 3, hwnd: probe164.hwnd, uid: PROBE_UID_V4,
        flags: NIF_MESSAGE | NIF_ICON | NIF_TIP, callbackMessage: CB_V4, hicon: hicon164,
        tooltip: 'DECK164-PROBE-V4', uVersion: 0 });
      const okAdd0 = ShellNotifyIconW(NIM_ADD, nidV0);
      const okAdd4 = ShellNotifyIconW(NIM_ADD, nidV4);
      // 探针收编确认：tray-event 明细只在 spike 模式落盘（#163 留档口径，红轮实证
      // 非轮 0 行）——改走栏内名单（get-state 的 key 集合，服务层消费同一事件流，
      // P11 收编断言同源）轮询等待探针在册；key = <hwnd十进制>:<uid十进制>
      const waitRosterKey = async (key, timeoutMs = 9000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const st = await cdpEval(`window.deck.bridge.invoke('taskbar/get-state', {})`);
          if (st && st.tray && st.tray.some((t) => t.key === key)) return true;
          await sleep(400);
        }
        return false;
      };
      const expKey0 = `${probe164.hwnd}:${PROBE_UID_V0}`;
      const expKey4 = `${probe164.hwnd}:${PROBE_UID_V4}`;
      const inRoster0 = okAdd0 ? await waitRosterKey(expKey0) : false;
      const inRoster4 = okAdd4 ? await waitRosterKey(expKey4) : false;
      // v4 协商：NIM_SETVERSION 负载只带 hwnd/uid/uVersion=4（uVersion 字段即协商值）。
      // 协商真值断言落在 v4 臂的 tray-replay 存证 version 字段（宿主登记表回读——
      // version 类事件明细同样只在 spike 模式落盘）
      const nidV4set = encodeNotifyIconData({ arch: 'x64', version: 3, hwnd: probe164.hwnd, uid: PROBE_UID_V4,
        flags: 0, callbackMessage: 0, hicon: 0, uVersion: 4 });
      const okSet4 = okAdd4 && inRoster4 ? ShellNotifyIconW(NIM_SETVERSION, nidV4set) : false;
      const arms = [];
      const armFail = (name, detail) => arms.push(`${name}: ${detail}`);
      if (!(okAdd0 && inRoster0)) armFail('probe-add-v0', `ok=${okAdd0} 名单在册=${inRoster0} key=${expKey0}`);
      if (!(okAdd4 && inRoster4)) armFail('probe-add-v4', `ok=${okAdd4} 名单在册=${inRoster4} key=${expKey4}`);
      if (!okSet4) armFail('probe-setversion', `ok=${okSet4}（version 真值由 v4 臂存证断言）`);
      const key0 = okAdd0 && inRoster0 ? expKey0 : null;
      const key4 = okAdd4 && inRoster4 ? expKey4 : null;
      if (key0 || key4) await sleep(800); // 条带渲染稳定拍（真实点击臂取几何前）

      // —— v0 右键（invoke 臂）：存证 + 收帧逐字段 ——
      if (key0) {
        const t = Date.now();
        probe164.frames.length = 0;
        await cdpEval(`window.deck.bridge.invoke('taskbar/tray-click', { key: ${JSON.stringify(key0)}, button: 'right' })`);
        const ev = await waitEvent('tray-replay', (e) => e.key === key0 && e.t >= t, 6000);
        const frame = await probe164.waitFrame((f) => f.msg === CB_V0);
        const ok = ev && ev.posted === true && ev.version === 0
          && ev.wparam === PROBE_UID_V0 && ev.lparam === WM_RBUTTONUP_T
          && ev.pid === process.pid // ASFW 属主 pid（旧实现传 hwnd——必不等）
          && frame && frame.wp === PROBE_UID_V0 && frame.lp === WM_RBUTTONUP_T;
        ok ? arms.push('v0-右键:存证+收帧一致(wparam=uID/lparam=0x0205/pid=属主)')
          : armFail('v0-右键', `存证=${JSON.stringify(ev && { posted: ev.posted, wparam: ev.wparam, lparam: ev.lparam, version: ev.version, pid: ev.pid })} 收帧=${JSON.stringify(frame)}`);
        rep.note(`v0 右键 asfw=${ev && ev.asfw}（前台态依赖，尽力放行不作硬断言）`);
      }

      // —— v0 左键（真实点击臂）：SendInput 点条带探针图标 → DOM handler → 桥 → 宿主 → 收帧 ——
      // #158 并流后红轮实证：放大档托盘图标像素装载会重排条带（taskbar-geometry 在
      // 取几何与点击之间推进），点击落到邻位探针——先等几何安静，再取位点击；点击
      // 存证未命中 key0（名单漂移）则重取几何重试一次（探针排布期间唯一的不稳源）。
      // 机器托盘膨胀守卫（2026-10-13 红轮定责）：机器在册托盘（本轮 22 枚）多于档位 5，
      // 尾部注册的探针进溢出浮层、条带页 DOM 无其图标（同轮 v0-右键 invoke 臂全绿＝
      // 回放链路无恙）——非回放回归。工单162 契约杠杆：档位临时全开让全部图标上条带，
      // 点击臂结束即复原档位（config 落盘面另有 finally restoreConfig 兜底）。
      if (key0) {
        const stBefore14 = await cdpEval(`window.deck.bridge.invoke('taskbar/get-state', {})`);
        await cdpEval(`window.deck.bridge.invoke('taskbar/set-tray-overflow-limit', { limit: 'all' })`);
        await sleep(400); // 档位重拆名单一帧
        const rect13 = win32.rectOf(strip13);
        const dip13 = screen.getPrimaryDisplay().bounds;
        const scale13 = (rect13.right - rect13.left) / dip13.width;
        await waitGeometrySettled(latestGeometry(null), 9000);
        let clickEv = null, ev = null, frame = null, geoMissing = false;
        for (let attempt = 0; attempt < 2 && !clickEv; attempt++) {
          const geo = await cdpEval(`(() => {
            const el = document.querySelector('.tb-tray-icon[data-key=${JSON.stringify(key0)}]');
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2, iw: window.innerWidth };
          })()`, TASKBAR_TITLE);
          if (!geo) { geoMissing = true; break; }
          const sx = Math.round(rect13.left + geo.x * scale13), sy = Math.round(rect13.top + geo.y * scale13);
          const t = Date.now();
          probe164.frames.length = 0;
          win32.SetCursorPos(sx, sy); // 条带默认鼠标穿透：热区 25ms 轮询命中才开门
          await sleep(400);
          win32.clickPhys(sx, sy, 'left');
          clickEv = await waitEvent('taskbar-tray-click', (e) => e.key === key0 && e.t >= t, 6000);
          if (clickEv) {
            ev = await waitEvent('tray-replay', (e) => e.key === key0 && e.t >= t, 6000);
            frame = await probe164.waitFrame((f) => f.msg === CB_V0);
          } else {
            await waitGeometrySettled(latestGeometry(null), 9000); // 漂移重试前再等安静
          }
        }
        const prevLimit14 = stBefore14 && stBefore14.trayOverflowLimit ? stBefore14.trayOverflowLimit : 5;
        await cdpEval(`window.deck.bridge.invoke('taskbar/set-tray-overflow-limit', { limit: ${JSON.stringify(prevLimit14)} })`); // 复原档位
        if (geoMissing) {
          armFail('v0-左键', '条带页找不到探针图标 .tb-tray-icon');
        } else {
          const ok = clickEv && ev && ev.posted === true
            && ev.wparam === PROBE_UID_V0 && ev.lparam === WM_LBUTTONUP_T
            && frame && frame.wp === PROBE_UID_V0 && frame.lp === WM_LBUTTONUP_T;
          ok ? arms.push('v0-左键:真实点击端到端(存证+收帧 lp=0x0202)')
            : armFail('v0-左键', `点击存证=${!!clickEv} 回放存证=${JSON.stringify(ev && { wparam: ev.wparam, lparam: ev.lparam, posted: ev.posted })} 收帧=${JSON.stringify(frame)}`);
        }
        win32.tapKeys([VK_ESC]); // 万一名单漂移点到邻位第三方图标开了菜单——尽力收净不留桌面残留
      }

      // —— v4 两键（invoke 臂 + 定锚）：wparam=MAKELPARAM(x,y)、lparam=(uID<<16)|事件 ——
      // （门槛不再看 version 事件字段——事件流不落 version；协商真值 = 臂内存证 ev.version===4）
      if (okSet4 && key4) {
        const mkLparam = (x, y) => ((y & 0xffff) << 16) | (x & 0xffff);
        const mkLpV4 = (event) => ((PROBE_UID_V4 & 0xffff) << 16) | event;
        for (const [button, anchor, event, eventName] of [
          ['right', { x: 101, y: 202 }, WM_CONTEXTMENU_T, 'WM_CONTEXTMENU'],
          ['left', { x: 103, y: 201 }, WM_LBUTTONUP_T, 'WM_LBUTTONUP'],
        ]) {
          const t = Date.now();
          probe164.frames.length = 0;
          win32.SetCursorPos(anchor.x, anchor.y); // v4 锚点 = 宿主回放瞬间的 GetCursorPos
          await sleep(150);
          await cdpEval(`window.deck.bridge.invoke('taskbar/tray-click', { key: ${JSON.stringify(key4)}, button: ${JSON.stringify(button)} })`);
          const ev = await waitEvent('tray-replay', (e) => e.key === key4 && e.t >= t, 6000);
          const frame = await probe164.waitFrame((f) => f.msg === CB_V4);
          const ok = ev && ev.posted === true && ev.version === 4
            && ev.wparam === mkLparam(anchor.x, anchor.y) && ev.lparam === mkLpV4(event)
            && frame && frame.wp === mkLparam(anchor.x, anchor.y) && frame.lp === mkLpV4(event);
          ok ? arms.push(`v4-${button === 'right' ? '右' : '左'}键:存证+收帧一致(wparam=MAKELPARAM(${anchor.x},${anchor.y})/lparam=(uID<<16)|${eventName})`)
            : armFail(`v4-${button}`, `存证=${JSON.stringify(ev && { posted: ev.posted, version: ev.version, wparam: ev.wparam, lparam: ev.lparam })} 期望=${JSON.stringify({ wparam: mkLparam(anchor.x, anchor.y), lparam: mkLpV4(event) })} 收帧=${JSON.stringify(frame)}`);
        }
      }

      // 臂判读：通过臂含「一致/端到端」标记，失败臂为「名: 明细」
      const passCount = arms.filter((a) => a.includes('一致') || a.includes('端到端')).length;
      const failArms = arms.filter((a) => !(a.includes('一致') || a.includes('端到端')));
      if (failArms.length === 0 && passCount >= 4) {
        rep.pass(`P14 托盘回放负载语义：${passCount} 臂全过（${arms.join('；')}）`);
      } else {
        rep.fail(`P14 ${failArms.length}/${arms.length} 臂失败：${failArms.join(' | ')}`);
      }

      // 清理探针（正常路径；异常路径 finally 兜底）
      try { ShellNotifyIconW(NIM_DELETE, nidV0); } catch { /* 尽力 */ }
      try { ShellNotifyIconW(NIM_DELETE, nidV4); } catch { /* 尽力 */ }
      probe164.destroy();
      probe164 = null;
      await sleep(300);
    }

    // P18 应用组统一序列默认落位（工单189，ADR-0013）：应用组排序键与 z 序快照脱钩。
    // 位次读数 = get-state 的 apps 数组（编排纯函数产序的权威真源），taskbar-geometry
    // 几何帧互证。四臂——
    //   A z 序脱钩：SetForegroundWindow 反复切换前台（每步前台归属核验），应用组序列
    //     纹丝不动（跨 1Hz 编排拍，几何帧同序互证）；
    //   B 新面孔追加最右：后启动探针恒在序列末位；全部窗口关闭即消失；再启动回末位；
    //   C 钉入原地转正：运行图标钉入落手钉段末位（=落最后一个手钉之后；安静栏面即
    //     原位次不动），手钉段/运行段两账各自保序；已钉应用开新窗不新增条目、钉图标
    //     呈运行态；全部窗口关闭后条目不消失（pinned 在、running 落、标题清空）；
    //     未运行解除手钉即消失；
    //   D 解除原地转运行：在运行的已钉图标解除手钉，条目停原位次（紧随手钉段=运行段
    //     首位），不按新面孔跳最右；随后关闭仍消失。
    rep.beginSegment('P18');
    if (!p18) {
      rep.fail('P18 前置缺失：探针种入失败（见种入 note）');
    } else {
      const [q1, q2, q3] = p18.probes;
      const norm18 = (s) => String(s || '').toLowerCase();
      const stem18 = (img) => img.replace(/\.exe$/i, '');
      const arms18 = [];
      const armOk18 = (name, detail) => arms18.push(`${name}:一致(${detail})`);
      const armFail18 = (name, detail) => arms18.push(`${name}: ${detail}`);
      const state18 = async () => {
        for (let i = 0; i < 10; i++) {
          try { return await cdpEval(`window.deck.bridge.invoke('taskbar/get-state', null)`, TASKBAR_TITLE); }
          catch { await sleep(400); } // 渲染页未就位重试
        }
        return null;
      };
      const seq18 = (st) => ((st && st.apps) || []).map((a) => norm18(a.exe));
      const entry18 = (st, p) => ((st && st.apps) || []).find((a) => norm18(a.exe) === norm18(p.exe)) || null;
      const waitSeq18 = async (pred, timeoutMs = 12000) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const st = await state18();
          if (st && pred(st)) return st;
          if (Date.now() >= deadline) return null;
          await sleep(300);
        }
      };
      const procCount18 = (img) => {
        const r = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${img}`, '/NH'], { encoding: 'utf8' });
        return ((r.stdout || '').toLowerCase().match(new RegExp(img.toLowerCase().replace(/\./g, '\\.'), 'g')) || []).length;
      };
      // 探针窗定位：自有 GUI 探针窗直属探针进程（R5 取证：标题含镜像名，按 exe
      // 归属识别，不猜类名）。R2/R3 的终端宿主代持匹配已随控制台探针废弃。
      const probeWin18 = (p) => {
        const stem = stem18(p.img);
        for (const h of win32.topLevelWindows()) {
          if (win32.exeNameOfWindow(h) === stem && win32.IsWindowVisible(h)) return h;
        }
        return null;
      };
      // 启动经 shell 通道（ShellExecute，贴近用户路径；P16② 同通道已证端到端）。
      // 失败诊断：进程数 + 探针镜像名相关窗清单（GUI 探针窗直属自身进程，无宿主代持形态）。
      const launch18 = async (p) => {
        const err18 = await require('electron').shell.openPath(p.exe);
        if (err18) { p.diag = `openPath=${err18}`; return false; }
        let hwnd = null;
        for (let i = 0; i < 30 && !hwnd; i++) { await sleep(200); hwnd = probeWin18(p); }
        p.hwnd = hwnd || 0;
        if (!hwnd) {
          const stem = stem18(p.img);
          const wins18 = win32.topLevelWindows()
            .filter((h) => win32.exeNameOfWindow(h) === stem || titleOf(h).includes(p.img))
            .slice(0, 8)
            .map((h) => `${win32.exeNameOfWindow(h)}:${titleOf(h).slice(0, 48)}`);
          p.diag = `进程=${procCount18(p.img)} 同名窗=[${wins18.join(' | ') || '无'}]`;
          return false;
        }
        return true;
      };
      const kill18 = async (p) => {
        spawnSync('taskkill', ['/IM', p.img, '/T', '/F'], { stdio: 'ignore' });
        for (let i = 0; i < 20 && procCount18(p.img) > 0; i++) await sleep(200);
        return procCount18(p.img) === 0;
      };
      // 前台切换（z 序驱动）：SetForegroundWindow → AttachThreadInput 附着 assist →
      // 真实点击兜底，每步以 GetForegroundWindow 归属核验（切不动则该步不计——
      // z 序根本没变，脱钩断言必须建立在真实切换之上）
      const focus18 = async (p) => {
        const hwnd = p.hwnd;
        if (!hwnd) return false;
        for (let attempt = 0; attempt < 3; attempt++) {
          win32.SetForegroundWindow(hwnd);
          await sleep(300);
          if (Number(win32.GetForegroundWindow()) === hwnd) return true;
          const fg = Number(win32.GetForegroundWindow());
          if (fg) {
            const myTid = win32.GetCurrentThreadId();
            const fgTid = win32.threadIdOf(fg).tid;
            const tTid = win32.threadIdOf(hwnd).tid;
            win32.AttachThreadInput(myTid, fgTid, true);
            win32.AttachThreadInput(myTid, tTid, true);
            win32.SetForegroundWindow(hwnd);
            win32.BringWindowToTop(hwnd);
            win32.AttachThreadInput(myTid, fgTid, false);
            win32.AttachThreadInput(myTid, tTid, false);
          }
          await sleep(300);
          if (Number(win32.GetForegroundWindow()) === hwnd) return true;
          const r = win32.rectOf(hwnd);
          if (r) {
            const cx = Math.round((r.left + r.right) / 2), cy = Math.round((r.top + r.bottom) / 2);
            win32.SetCursorPos(cx, cy);
            await sleep(250);
            if (Number(win32.windowFromPointRoot({ x: cx, y: cy })) === hwnd) win32.clickPhys(cx, cy, 'left');
            await sleep(400);
            if (Number(win32.GetForegroundWindow()) === hwnd) return true;
          }
        }
        return false;
      };
      // 段化对账（默认规则的结构不变式）：手钉段 = 前态手钉段（+新增钉），运行段保序
      const segSplit18 = (st) => {
        const apps = (st && st.apps) || [];
        return {
          pinned: apps.filter((a) => a.pinned).map((a) => norm18(a.exe)),
          running: apps.filter((a) => !a.pinned).map((a) => norm18(a.exe)),
        };
      };
      const same18 = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      // 搅动容忍的保序断言：before 的每一项都在 after 中、且相对次序不颠倒（after 可有
      // before 之外的机器侧新增项——并行会话共享桌面，段间生灭不算失据）
      const subseq18 = (after, before) => {
        let j = 0;
        for (const k of after) { if (j < before.length && k === before[j]) j++; }
        return j === before.length;
      };

      // —— 前置：q1/q2 按序上栏（1Hz 编排轮 1–2s）——
      if (!(await launch18(q1)) || !(await launch18(q2))) {
        rep.fail(`P18 前置失败：探针窗未出场（q1=${!!q1.hwnd}${q1.diag ? ' ' + q1.diag : ''} q2=${!!q2.hwnd}${q2.diag ? ' ' + q2.diag : ''}）`);
      } else {
        const pre18 = await waitSeq18((st) => {
          const s = seq18(st);
          return s.includes(norm18(q1.exe)) && s.includes(norm18(q2.exe));
        });
        if (!pre18) {
          rep.fail(`P18 前置失败：q1/q2 未上栏（编排链断）get-state=${JSON.stringify(seq18(await state18()))}`);
        } else {
          rep.note(`P18 栏面基线：${seq18(pre18).map((id) => path.basename(id)).join(' | ')}`);

          // —— 臂A z 序脱钩：反复切换前台，序列纹丝不动 ——
          // 断言走搅动容忍口径（验收机多应用并存、并行会话抢前台）：q1/q2 相对序不变
          // （z 序若参与排序必翻这俩）、前态手钉条目全体保序在场、几何帧与 get-state
          // 对两探针同序互证。机器侧新增/退出条目不算失据。
          {
            const beforeA = await state18();
            const seqA0 = seq18(beforeA);
            const key1 = norm18(q1.exe), key2 = norm18(q2.exe);
            const f0 = seqA0.filter((k) => k === key1 || k === key2);
            const pinnedA0 = segSplit18(beforeA).pinned;
            let q1Fg = 0, q2Fg = 0;
            for (const target of [q2, q1, q2, q1]) {
              if (await focus18(target)) { if (target === q1) q1Fg++; else q2Fg++; }
              await sleep(1300); // ≥1 个编排拍：z 序若再参与排序，重排就落在这一拍内
            }
            const stA = await state18();
            const seqA1 = seq18(stA);
            const f1 = seqA1.filter((k) => k === key1 || k === key2);
            const pinnedA1 = segSplit18(stA).pinned;
            const pinnedOkA = pinnedA0.every((k) => pinnedA1.includes(k))
              && pinnedA1.filter((k) => pinnedA0.includes(k)).every((k, i) => k === pinnedA0[i]);
            const geoA = latestGeometry(null);
            const geoIdsA = geoA && geoA.apps ? geoA.apps.map((a) => norm18(a.id)) : [];
            const geoF = geoIdsA.filter((k) => k === key1 || k === key2);
            const geoOkA = f1.length === 2 && same18(f1, geoF);
            if (q1Fg >= 1 && q2Fg >= 1 && (q1Fg + q2Fg) >= 3 && f0.length === 2 && same18(f0, f1) && pinnedOkA && geoOkA) {
              armOk18('A-z序脱钩', `前后台切换达成 q1=${q1Fg}/q2=${q2Fg}，探针相对序与手钉段纹丝不动（get-state 与几何帧同序）`);
            } else {
              armFail18('A-z序脱钩', `切前台 q1=${q1Fg}/q2=${q2Fg} 探针序 前=${JSON.stringify(f0)} 后=${JSON.stringify(f1)}`
                + ` 手钉段保序=${pinnedOkA} 几何互证=${geoOkA}(geo=${JSON.stringify(geoF)})`);
            }
          }

          // —— 臂B 新面孔追加最右 / 全关消失 / 复启回最右 ——
          // 「追加最右」断言走搅动容忍口径：启动前在场的条目，凡此刻仍在场者必在 q3
          // 之左（q3 追加全序最右）；机器侧启动晚于 q3 的新面孔可在其右，不算失据。
          {
            const killedB = (await kill18(q1)) && (await kill18(q2));
            const goneB = await waitSeq18((st) => !seq18(st).includes(norm18(q1.exe)) && !seq18(st).includes(norm18(q2.exe)));
            let armB = !!killedB && !!goneB;
            let lastB1 = false;
            if (armB) {
              const l0B = seq18(await state18());
              await launch18(q3);
              const stB = await waitSeq18((st) => !!entry18(st, q3));
              const l1B = seq18(stB);
              const key3 = norm18(q3.exe);
              lastB1 = !!stB && l0B.every((k) => { const i = l1B.indexOf(k); return i < 0 || i < l1B.indexOf(key3); });
              armB = lastB1;
            }
            let goneB2 = false;
            if (armB) {
              armB = await kill18(q3);
              goneB2 = !!(armB && await waitSeq18((st) => !seq18(st).includes(norm18(q3.exe))));
              armB = goneB2;
            }
            let lastB2 = false;
            if (armB) {
              const l0B2 = seq18(await state18());
              await launch18(q3);
              const stB2 = await waitSeq18((st) => !!entry18(st, q3));
              const l1B2 = seq18(stB2);
              const key3 = norm18(q3.exe);
              lastB2 = !!stB2 && l0B2.every((k) => { const i = l1B2.indexOf(k); return i < 0 || i < l1B2.indexOf(key3); });
              armB = lastB2;
            }
            if (armB) {
              armOk18('B-追加最右/全关消失/复启回最右', `q1/q2 摘除、q3 两度落全体在场条目之右（末位）`);
            } else {
              armFail18('B-追加最右/全关消失/复启回最右', `进程摘除=${!!killedB} 栏面摘除=${!!goneB} 首启最右=${lastB1} 关闭消失=${goneB2} 复启最右=${lastB2}`
                + ` 现序=${JSON.stringify(seq18(await state18()))}`);
            }
          }

          // —— 臂C 钉入原地转正 / 已钉开新窗并入 / 关闭不消失 / 未运行解除消失 ——
          // 钉入段化不变式（搅动容忍公共子序列）：前态手钉条目全体在场保序、q3 成为
          // 手钉段最后一位（老左新右=落最后一个手钉之后）、运行段 = 前态 − q3 保序。
          {
            const preC = await state18();
            const keyC = norm18(q3.exe);
            const beforeC = segSplit18(preC);
            await cdpEval(`window.deck.bridge.invoke('taskbar/set-app-pinned', { exe: ${JSON.stringify(q3.exe)}, pinned: true })`, TASKBAR_TITLE);
            const postC = await waitSeq18((st) => { const e = entry18(st, q3); return e && e.pinned; });
            const afterC = segSplit18(postC);
            const pinOkC = !!postC && subseq18(afterC.pinned, beforeC.pinned)
              && afterC.pinned.includes(keyC) && afterC.pinned.indexOf(keyC) === afterC.pinned.length - 1
              && !afterC.running.includes(keyC)
              && subseq18(afterC.running, beforeC.running.filter((k) => k !== keyC));
            let armC = !!pinOkC;

            // 已钉应用开新窗：不新增条目、钉图标呈运行态（第二实例若被应用并回单实例，
            // 栏面同样恰一条目运行态——「不新增图标」在两种形态下都成立）
            let mergeC = false;
            if (armC) {
              await launch18(q3);
              const stM = await waitSeq18((st) => {
                const hits = (st.apps || []).filter((a) => norm18(a.exe) === keyC);
                return hits.length === 1 && hits[0].pinned && hits[0].running;
                }, 8000);
              mergeC = !!stM;
              armC = mergeC;
            }
            // 全部窗口关闭：条目不消失（pinned 在、running 落、标题清空）
            let keepC = false;
            if (armC) {
              armC = await kill18(q3);
              const stK = armC ? await waitSeq18((st) => { const e = entry18(st, q3); return e && e.pinned && !e.running; }) : null;
              keepC = !!stK && entry18(stK, q3).title === null;
              armC = keepC;
            }
            // 未运行解除手钉：消失（按推荐管线回池；探针非桌面项，回池即不可见）
            let unpinGoneC = false;
            if (armC) {
              await cdpEval(`window.deck.bridge.invoke('taskbar/set-app-pinned', { exe: ${JSON.stringify(q3.exe)}, pinned: false })`, TASKBAR_TITLE);
              unpinGoneC = !!(await waitSeq18((st) => !seq18(st).includes(keyC)));
              armC = unpinGoneC;
            }
            if (armC) {
              armOk18('C-钉入转正/开新窗并入/关闭不消失/未运行解除消失',
                `钉入落手钉段末位（前态手钉 ${beforeC.pinned.length} 项保序在后）、运行段摘键保序，新窗并入单条目=${mergeC}，关闭后钉态驻留=${keepC}，未运行解除即消失=${unpinGoneC}`);
            } else {
              armFail18('C-钉入转正/开新窗并入/关闭不消失/未运行解除消失',
                `钉后帧=${!!postC} 段化=${!!pinOkC} 并入=${mergeC} 驻留=${keepC} 消失=${unpinGoneC}`
                + ` 前态=${JSON.stringify(beforeC)} 后态=${JSON.stringify(afterC)}`);
            }
          }

          // —— 臂D 解除原地转运行 ——
          {
            let armD = await launch18(q3);
            const stD0 = armD ? await waitSeq18((st) => !!entry18(st, q3)) : null;
            armD = !!stD0;
            const beforeD0 = segSplit18(stD0);
            // 钉入（运行中）→ 解除（仍在运行）：原地转运行
            if (armD) {
              await cdpEval(`window.deck.bridge.invoke('taskbar/set-app-pinned', { exe: ${JSON.stringify(q3.exe)}, pinned: true })`, TASKBAR_TITLE);
              const pinnedD = await waitSeq18((st) => { const e = entry18(st, q3); return e && e.pinned; });
              armD = !!pinnedD;
            }
            let demoteD = null;
            if (armD) {
              await cdpEval(`window.deck.bridge.invoke('taskbar/set-app-pinned', { exe: ${JSON.stringify(q3.exe)}, pinned: false })`, TASKBAR_TITLE);
              demoteD = await waitSeq18((st) => { const e = entry18(st, q3); return e && !e.pinned && e.running; });
            }
            const keyD = norm18(q3.exe);
            const afterD = segSplit18(demoteD);
            // 解除臂结构不变式：手钉段回到钉入前态（保序），q3 落运行段**首位**（紧随
            // 手钉段=原地转运行；新面孔只会追加最右、无人能插到它前面），先序运行条目保序殿后
            const segOkD = !!demoteD && afterD.running.indexOf(keyD) === 0
              && subseq18(afterD.running, beforeD0.running.filter((k) => k !== keyD))
              && subseq18(afterD.pinned, beforeD0.pinned) && beforeD0.pinned.every((k) => afterD.pinned.includes(k));
            let goneD = false;
            if (armD && demoteD) {
              armD = await kill18(q3);
              goneD = !!(armD && await waitSeq18((st) => !seq18(st).includes(keyD)));
              armD = goneD;
            }
            if (armD && segOkD) {
              armOk18('D-解除原地转运行', `解除后停运行段首位（原位次、两段保序），随后全关消失=${goneD}`);
            } else {
              armFail18('D-解除原地转运行', `钉入=${armD} 解除帧=${!!demoteD} 段化=${!!segOkD} 全关消失=${goneD}`
                + ` 钉前=${JSON.stringify(beforeD0)} 解后=${JSON.stringify(afterD)}`);
            }
          }

          const pass18 = arms18.filter((a) => a.includes(':一致(')).length;
          const fail18 = arms18.filter((a) => !a.includes(':一致('));
          if (fail18.length === 0 && pass18 === 4) {
            rep.pass(`P18 统一序列默认落位：4 臂全过（${arms18.join('；')}）`);
          } else {
            rep.fail(`P18 ${fail18.length}/4 臂失败：${arms18.join(' | ')}`);
          }
        }
      }
    }
    // P21 多窗选窗浮层（工单196，ADR-0013 五面迁移收官）：应用组多窗应用左键点出的
    // 选窗列表迁浮层窗 DECK-TASKBAR-WINS-MENU（横排进开始组 pill 退役；行源 = 工单196
    // 新只读契约 taskbar/app-windows 即席拉取——app-click window-list 的 windowsOf 同一
    // 当拍枚举）。探针 = cmd 副本 start 双开（/K 驻留 + title 定名——真多开两控制台窗、
    // 标题可断言；cmd 副本规避 System32 notepad 存根重定向，P16② 同款选型）。臂——
    // ①左键图标 → 浮层在场（pid+标题寻窗）+ ready 行集恰 2 行（行身份=hwnd 互异、
    //   标题=探针定名）；②点行选窗 → taskbar-window-pick 存证（exe/hwnd 身份核对）+
    //   目标窗真前台（GetForegroundWindow 对账）+ 行点即收（reason=row）；③点外即收
    //   （再开一层=重锚定 → 点时钟格 → reason=strip-click）。
    rep.beginSegment('P21');
    {
      // 探针 = csc 编译最小 WinForms 窗（P18 同款制备法）：同 exe 双实例、argv 定标题
      //（断言锚点）。cmd 副本双开弃用：Win11 默认终端下控制台窗属主是 WindowsTerminal.exe
      //（CASCADIA 宿主）——栏面 exe 枚举归到终端宿主，cmd 副本身份永远不上栏（三轮红轮
      // 实证：窗就位=true 进程=2 而栏面无条目）。
      const P21_PROBE_CS = `
using System;
using System.Drawing;
using System.Windows.Forms;
static class Probe {
  [STAThread]
  static void Main(string[] args) {
    string title = (args != null && args.Length > 0 && args[0].Length > 0) ? args[0] : "deck-p21 probe";
    Form f = new Form();
    f.Text = title;
    f.StartPosition = FormStartPosition.Manual;
    f.Bounds = new Rectangle(40, 60, 300, 160);
    Application.Run(f);
  }
}
`;
      const img21 = 'deck-p21-app.exe';
      const sysRoot21 = process.env.SystemRoot || 'C:\\Windows';
      const tmp21 = fs.mkdtempSync(path.join(fs.realpathSync.native(require('os').tmpdir()), 'deck-p21-'));
      const copy21 = path.join(tmp21, img21);
      const csc21 = path.join(sysRoot21, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
      const cs21 = path.join(tmp21, 'probe.cs');
      fs.writeFileSync(cs21, P21_PROBE_CS, 'utf8');
      const built21 = spawnSync(csc21, ['/nologo', '/target:winexe', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', `/out:${copy21}`, cs21], { encoding: 'utf8' });
      const titles21 = ['DECK-P21-WIN-1', 'DECK-P21-WIN-2'];
      if (built21.status !== 0 || !fs.existsSync(copy21)) {
        rep.fail(`P21 前置缺失：探针编译失败 status=${built21.status} ${(built21.stderr || '').trim().slice(0, 160)}`);
        try { fs.rmSync(tmp21, { recursive: true, force: true }); } catch { /* 尽力 */ }
        spawnSync('taskkill', ['/IM', img21, '/T', '/F'], { stdio: 'ignore' });
      } else {
      for (const t of titles21) {
        spawn(copy21, [t], { stdio: 'ignore' });
      }
      // 双窗就绪等待（WinForms 窗出生即带 argv 标题；trim 对账沿既往口径）
      let winsUp21 = false;
      for (let i = 0; i < 30 && !winsUp21; i++) {
        await sleep(400);
        winsUp21 = titles21.every((t) => win32.topLevelWindows().some((h) => titleOf(h).trim() === t));
      }
      const norm21 = (s21) => String(s21 || '').toLowerCase();
      const liveAppPt21 = async () => cdpEval(`(() => {
        const want = ${JSON.stringify(img21)}.toLowerCase();
        const el = [...document.querySelectorAll('#pill-apps .tb-app')].find((n) => (n.dataset.exe || '').toLowerCase().endsWith(want));
        return el ? el.getBoundingClientRect().toJSON() : null;
      })()`, TASKBAR_TITLE);
      const WINS_MENU_FAMILY21 = 'taskbar-wins-menu';
      // 开层证据 = opened/resized（show 重开不触发页重回报 ready——页只在 boot 与
      // changed 回报，行内容由载页常活自养；行几何另由 ready 锚点配对，见①）
      const popOpen21 = (since) => readEvents().some((e) => e.t >= since
        && (e.type === 'taskbar-wins-menu-opened' || e.type === 'taskbar-wins-menu-resized'));
      const clickIconOpen21 = async () => {
        // 左键图标 → 浮层开层（三试：到靶停拍后点击，等开层存证）
        for (let attempt21 = 0; attempt21 < 3; attempt21++) {
          const r21 = await liveAppPt21();
          if (!r21) return null;
          const pt21 = toPhys(r21.x + r21.width / 2, r21.y + r21.height / 2);
          win32.moveMousePhys(pt21.x, pt21.y);
          await sleep(300); // 到靶停拍（热区开门 + 托盘 churn 重居中后现取矩形）
          const since21 = Date.now();
          win32.clickPhys(pt21.x, pt21.y, 'left');
          for (let i = 0; i < 15; i++) {
            await sleep(200);
            if (popOpen21(since21)) return { since: since21 };
          }
        }
        return null;
      };
      try {
        let appSeen21 = null;
        for (let i = 0; i < 40 && !appSeen21; i++) {
          await sleep(400);
          appSeen21 = await liveAppPt21();
        }
        if (!appSeen21) {
          const diagProc21 = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${img21}`, '/NH'], { encoding: 'utf8' });
          const procCount21 = ((diagProc21.stdout || '').match(/deck-p21-app/g) || []).length;
          rep.fail(`P21 前置缺失：双实例探针未上栏（应用组合一条目未出现——探针窗被栏面枚举过滤或双开失败）`
            + ` 窗就位=${winsUp21} 进程=${procCount21}`);
        } else {
          const pop21 = await clickIconOpen21();
          const popWin21 = pop21 ? await waitWindow(panelPid, 'DECK-TASKBAR-WINS-MENU', 3000) : null;
          // 行几何锚点（create 路径页 boot 即报 ready；行集/行坐标据此断言与取点击点）
          let popReady21 = null;
          if (pop21) {
            for (let i = 0; i < 15 && !popReady21; i++) {
              await sleep(200);
              popReady21 = popupAnchored(WINS_MENU_FAMILY21)(pop21.since);
            }
          }
          const rowsOk21 = !!popReady21 && popReady21.rows.length === 2
            && new Set(popReady21.rows.map((r) => r.id)).size === 2
            && popReady21.rows.every((r) => titles21.includes(r.label.trim()));
          if (pop21 && popWin21 && rowsOk21) {
            rep.pass(`P21① 选窗浮层随左键弹出：DECK-TASKBAR-WINS-MENU 在场（pid+标题寻窗实锤）、行集恰 2（行身份=hwnd 互异，`
              + `标题=[${popReady21.rows.map((r) => r.label).join(', ')}]）——横排进 pill 退役（taskbar/app-windows 行源）`);
          } else {
            rep.fail(`P21① 浮层弹出：开层=${!!pop21} 窗=${!!popWin21} ready=${!!popReady21}`
              + ` rows=${popReady21 ? JSON.stringify(popReady21.rows.map((r) => [r.id, r.label])) : 'n/a'}`);
          }
          // ② 点行选窗 → 存证 + 前台对账 + 行点即收
          let pick21 = null;
          let fgOk21 = false;
          let closedRow21 = null;
          if (popReady21 && rowsOk21) {
            const row21 = popReady21.rows[0];
            pick21 = await clickPopupRowVerify(WINS_MENU_FAMILY21, popReady21.since, row21.id, 'taskbar-window-pick', (e) => norm21(e.exe).endsWith(img21) && String(e.hwnd) === row21.id, scale);
            for (let i = 0; i < 12 && !fgOk21; i++) {
              await sleep(250);
              fgOk21 = Number(win32.GetForegroundWindow()) === Number(row21.id);
            }
            closedRow21 = await waitEvent('taskbar-wins-menu-closed', (e) => e.reason === 'row' && e.t >= popReady21.since, 5000);
          }
          if (pick21 && fgOk21 && closedRow21) {
            rep.pass(`P21② 选窗聚焦端到端：行点存证（exe/hwnd 身份核对）→ 目标探针窗真前台（hwnd=${pick21.hwnd}）、行点即收（reason=row）`);
          } else {
            rep.fail(`P21② 选窗：存证=${!!pick21}${pick21 ? `(hwnd=${pick21.hwnd})` : ''} 前台对账=${fgOk21} 行点即收=${closedRow21 ? closedRow21.reason : '缺'}`);
          }
          // ③ 点外即收：再开一层（左键重开=重锚定），条带内点击（时钟格——非内核动作键）
          // 转达收层（strip-click）
          let outside21 = null;
          const pop21b = await clickIconOpen21();
          if (pop21b) {
            const g21 = latestGeometry(null);
            const clock21 = (g21.rightCells || []).find((c) => c.id === 'clock');
            if (clock21) {
              const cp21 = toPhys(clock21.x + clock21.w / 2, clock21.y + clock21.h / 2);
              win32.moveMousePhys(cp21.x, cp21.y);
              await sleep(250);
              win32.clickPhys(cp21.x, cp21.y, 'left');
              outside21 = await waitEvent('taskbar-wins-menu-closed', (e) => (e.reason === 'strip-click' || e.reason === 'blur') && e.t >= pop21b.since, 5000);
            }
          }
          if (outside21) {
            rep.pass(`P21③ 点外即收：条带内点击转达收层（reason=${outside21.reason}）`);
          } else {
            rep.fail(`P21③ 点外即收：再开=${!!pop21b} 收层存证=缺`);
          }
        }
      } finally {
        spawnSync('taskkill', ['/IM', img21, '/T', '/F'], { stdio: 'ignore' });
        try { fs.rmSync(tmp21, { recursive: true, force: true }); } catch { /* 尽力 */ }
      }
      } // 编译成功分支（探针缺编只判前置红，不再走注入臂）
    }


    // P20 全量拖拽三断点（工单195，ADR-0013 全量自由拖拽落地）：真 OLE 拖拽臂 apps→apps
    // （现行电池无此臂，三断点曾因此漏掉，2026-10-14 取证在案）。复用 P18 探针
    // （deck-p18-1/2/3.exe——P18 段尾已收杀，exe 文件仍在，P18 finally 兜底清理不提前），
    // drag-start/drag-drop/drag-result 三存证组合为分诊判据。六臂执行序 B→D1→A→C→E→D2
    // （运行臂先于手钉臂；持久化两半各配一次重启——D1 在臂A 钉入前重启验运行拖位回默认序
    //  （q1/q3 同在运行段才可断相对序，q3 钉入后恒不可满足，第1-5轮臂D 全红的真根因），
    //  D2 在末尾重启验手钉拖位落盘记住）——
    //   B 运行段会话拖位 + 渲染冻结（断点①② ~75% 弹回）：运行条目互拖两连，第一拖
    //     中程经 CDP 强推 taskbar/changed（set-metrics 往返两帧）——被拖节点同一性凭
    //     expando token 断言（节点重建即丢 token），冻结生效则拖拽全程节点不重建、
    //     1–2 秒真机节奏无弹回，落点即所得；
    //   D1 运行拖位重启回默认序（持久化口径前半）：三探针全未钉时重启——臂B 摆下的
    //     会话序（q3<q1）随会话归零，重启后按首见序回默认序（q1 前台=z 序最先→q1<q3）；
    //   A 全条目接线（断点① ~80% 必现）：手钉条目真拖到仅运行图标上松手——before=运行
    //     身份被内核接受（钳取手钉段末尾），不再被容器守卫静默吞掉（落点条目化）；
    //   C 跨组拖拽 + 组间缝隙松手（断点③ ~60% 跨 pill）：推荐条目拖经组间缝隙（缝隙
    //     中停拍 400ms——持门期 25ms 穿透轮询不关门）落应用组运行图标上升手钉；拖拽
    //     窗口（drag-start→drag-drop 存证 t 区间）无 taskbar-hotzone-leave；
    //   E 拖拽失败可见反馈（票面 AC）：未钉运行条目拖到推荐组——服务层确定性拒返
    //     ok:false（仅手钉可解除），toast 在场+文案断言，拒返不静默；
    //   D2 手钉拖位落盘记住（持久化口径后半）：重启面板——臂A 摆下的手钉拖位
    //     （q2<q3）落盘记住；存储文件无运行序段（会话态不落盘）。
    rep.beginSegment('P20');
    if (!p18) {
      rep.fail('P20 前置缺失：P18 探针种入失败（见种入 note）');
    } else {
      const [q1, q2, q3] = p18.probes;
      const norm20 = (s) => String(s || '').toLowerCase();
      const stem20 = (img) => img.replace(/\.exe$/i, '');
      const steps20 = 12; // OLE 拖拽步进（渲染层拖拽阈值 6px，步进远超阈值；每步 24ms 保持事件流）
      const state20 = async () => {
        for (let i = 0; i < 10; i++) {
          try { return await cdpEval(`window.deck.bridge.invoke('taskbar/get-state', null)`, TASKBAR_TITLE); }
          catch { await sleep(400); } // 渲染页未就位重试
        }
        return null;
      };
      const seq20 = (st) => ((st && st.apps) || []).map((a) => norm20(a.exe));
      const segSplit20 = (st) => {
        const apps = (st && st.apps) || [];
        return {
          pinned: apps.filter((a) => a.pinned).map((a) => norm20(a.exe)),
          running: apps.filter((a) => !a.pinned).map((a) => norm20(a.exe)),
        };
      };
      const waitSeq20 = async (pred, timeoutMs = 12000) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const st = await state20();
          if (st && pred(st)) return st;
          if (Date.now() >= deadline) return null;
          await sleep(300);
        }
      };
      const probeWin20 = (p) => {
        const stem = stem20(p.img);
        for (const h of win32.topLevelWindows()) {
          if (win32.exeNameOfWindow(h) === stem && win32.IsWindowVisible(h)) return h;
        }
        return null;
      };
      const launch20 = async (p) => {
        const err20 = await require('electron').shell.openPath(p.exe);
        if (err20) { p.diag = `openPath=${err20}`; return false; }
        let hwnd = null;
        for (let i = 0; i < 30 && !hwnd; i++) { await sleep(200); hwnd = probeWin20(p); }
        p.hwnd = hwnd || 0;
        return !!hwnd;
      };
      // 前台切换（P18 focus18 同款三段：直调 → AttachThreadInput 附着 assist → 真实点击兜底），
      // 每步 GetForegroundWindow 归属核验
      const focus20 = async (p) => {
        const hwnd = p.hwnd;
        if (!hwnd) return false;
        for (let attempt = 0; attempt < 3; attempt++) {
          win32.SetForegroundWindow(hwnd);
          await sleep(300);
          if (Number(win32.GetForegroundWindow()) === hwnd) return true;
          const fg = Number(win32.GetForegroundWindow());
          if (fg) {
            const myTid = win32.GetCurrentThreadId();
            const fgTid = win32.threadIdOf(fg).tid;
            const tTid = win32.threadIdOf(hwnd).tid;
            win32.AttachThreadInput(myTid, fgTid, true);
            win32.AttachThreadInput(myTid, tTid, true);
            win32.SetForegroundWindow(hwnd);
            win32.BringWindowToTop(hwnd);
            win32.AttachThreadInput(myTid, fgTid, false);
            win32.AttachThreadInput(myTid, tTid, false);
          }
          await sleep(300);
          if (Number(win32.GetForegroundWindow()) === hwnd) return true;
          const r = win32.rectOf(hwnd);
          if (r) {
            const cx = Math.round((r.left + r.right) / 2), cy = Math.round((r.top + r.bottom) / 2);
            win32.SetCursorPos(cx, cy);
            await sleep(250);
            if (Number(win32.windowFromPointRoot({ x: cx, y: cy })) === hwnd) win32.clickPhys(cx, cy, 'left');
            await sleep(400);
            if (Number(win32.GetForegroundWindow()) === hwnd) return true;
          }
        }
        return false;
      };
      const appPt20 = (g, exe) => {
        const r = (g.apps || []).find((a) => norm20(a.id) === norm20(exe));
        return r ? toPhys(r.x + r.w / 2, r.y + r.h / 2) : null;
      };
      const recPt20 = (g, name) => {
        const r = (g.recommendations || []).find((x) => x.name === name);
        return r ? toPhys(r.x + r.w / 2, r.y + r.h / 2) : null;
      };
      // 真 OLE 拖拽一步到底：down → 前半程步进 → 中程钩子（拖拽会话活动期）→ 后半程 →
      // 到靶停拍 + jitter 两下（dragover 重注册）→ 抬键（P16④⑤ 同款收尾三拍）
      const oleDrag20 = async (srcPt, dstPt, midDrag) => {
        win32.moveMousePhys(srcPt.x, srcPt.y);
        await sleep(250);
        win32.send([win32.mouseInput(0, 0, win32.LEFTDOWN)]);
        const half = Math.ceil(steps20 / 2);
        for (let s = 1; s <= half; s++) {
          await sleep(24);
          win32.moveMousePhys(srcPt.x + Math.round(((dstPt.x - srcPt.x) * s) / steps20), srcPt.y + Math.round(((dstPt.y - srcPt.y) * s) / steps20));
        }
        if (midDrag) await midDrag();
        for (let s = half + 1; s <= steps20; s++) {
          await sleep(24);
          win32.moveMousePhys(srcPt.x + Math.round(((dstPt.x - srcPt.x) * s) / steps20), srcPt.y + Math.round(((dstPt.y - srcPt.y) * s) / steps20));
        }
        await sleep(300); // 到靶停拍：dragover 落靶（热区持门期恒开，无需等轮询开门拍）
        win32.moveMousePhys(dstPt.x - 3, dstPt.y);
        await sleep(120);
        win32.moveMousePhys(dstPt.x, dstPt.y);
        await sleep(200);
        win32.send([win32.mouseInput(0, 0, win32.LEFTUP)]);
      };
      // 面板重启（臂D1/D2 共用，14b4c16 就绪守卫+二次重启兜底两处同款）：旧 pid 真死再
      // spawn（cb174c8：taskkill /F 后旧 remote-debugging-port 短暂未释放，新面板 Chromium
      // 静默跳过 CDP 绑定）；boot 后等 taskbar-ready，未就绪即杀掉重拉一次（14b4c16：
      // 偶发新实例 boot 后主进程/渲染层停滞，不烧 20s 等死实例）。
      const restartPanel20 = async (tag) => {
        const oldPid = panelPid;
        killTree(child, panelPid);
        child = null;
        for (let i = 0; i < 50 && oldPid; i++) {
          const r = spawnSync('tasklist', ['/FI', `PID eq ${oldPid}`, '/NH'], { encoding: 'utf8' });
          if (!(r.stdout || '').includes(String(oldPid))) break;
          await sleep(200);
        }
        await sleep(1200);
        const since = Date.now();
        child = launchPanel();
        const boot = await waitEvent('boot', (e) => e.t >= since, 15000);
        if (boot) {
          panelPid = boot.pid;
          await waitWindow(panelPid, TASKBAR_TITLE, 12000);
        }
        let ready = boot ? await waitEvent('taskbar-ready', (e) => e.t >= since, 15000) : null;
        if (boot && !ready) {
          rep.note(`P20 ${tag} 首拉实例未就绪（taskbar-ready 15s 未出场）——二次重启兜底`);
          const pid2 = panelPid;
          killTree(child, panelPid);
          child = null;
          for (let i = 0; i < 50 && pid2; i++) {
            const r = spawnSync('tasklist', ['/FI', `PID eq ${pid2}`, '/NH'], { encoding: 'utf8' });
            if (!(r.stdout || '').includes(String(pid2))) break;
            await sleep(200);
          }
          await sleep(1200);
          const since2 = Date.now();
          child = launchPanel();
          const boot2 = await waitEvent('boot', (e) => e.t >= since2, 15000);
          if (boot2) {
            panelPid = boot2.pid;
            await waitWindow(panelPid, TASKBAR_TITLE, 12000);
          }
          ready = boot2 ? await waitEvent('taskbar-ready', (e) => e.t >= since2, 15000) : null;
        }
        return { boot, ready };
      };

      // —— 前置：q1/q2/q3 按序上栏（首见序引导会话运行序 [q1, q2, q3]）——
      if (!(await launch20(q1)) || !(await launch20(q2)) || !(await launch20(q3))) {
        rep.fail(`P20 前置失败：探针窗未出场（q1=${!!q1.hwnd} q2=${!!q2.hwnd} q3=${!!q3.hwnd}${q1.diag ? ' ' + q1.diag : ''}）`);
      } else {
        const pre20 = await waitSeq20((st) => {
          const s = seq20(st);
          return s.includes(norm20(q1.exe)) && s.includes(norm20(q2.exe)) && s.includes(norm20(q3.exe));
        });
        if (!pre20) {
          rep.fail(`P20 前置失败：q1/q2/q3 未上栏（编排链断）get-state=${JSON.stringify(seq20(await state20()))}`);
        } else {
          rep.note(`P20 栏面基线：${seq20(pre20).map((id) => path.basename(id)).join(' | ')}`);

          // —— 臂B 运行段会话拖位 + 渲染冻结（断点①②）：中程强推 changed，节点不重建 ——
          // （先于臂A 执行：q1/q2/q3 此时全为未钉运行——臂D 重启判据两对同时可满足：
          //   pinned 对 = 臂A 摆下的 q2<q3，running 对 = 本臂摆下的 q3<q1）
          {
            // 前置等待：两探针都在运行段（首见序随编排拍与 z 序快照走——机器侧未钉运行
            // 条目可夹中间，断言只认两探针相对序）
            const runPre20 = await waitSeq20((st) => {
              const seg = segSplit20(st);
              return seg.running.indexOf(norm20(q3.exe)) >= 0 && seg.running.indexOf(norm20(q1.exe)) >= 0;
            });
            let dragB = null;
            let startB20 = false;
            let token20 = 'skip';
            let orderB = null;
            const gB = await waitGeometrySettled(runPre20);
            const srcB = appPt20(gB, q1.exe);
            const dstB = appPt20(gB, q3.exe);
            if (runPre20 && srcB && dstB) {
              oleDrag20(srcB, dstB, async () => {
                // 拖拽会话活动期（真机节奏 1–2s 的中程）：等 drag-start 存证（三存证组合第一证）
                // → 给被拖节点打 expando token → CDP 强推 taskbar/changed 两帧（set-metrics
                // 往返，目标集保证与现值不同=真推帧）→ 复核 token。
                // 冻结生效：帧被合挂、节点不重建 → token 犹在；冻结缺失：整树重建 →
                // .dragging 换人/消失 → OLE 会话中止（drag-drop 存证缺失）。
                const startB = await waitEvent('taskbar-drag-start', (e) => e.group === 'apps' && norm20(e.id) === norm20(q1.exe), 3000);
                startB20 = !!startB;
                if (!startB) { token20 = 'no-drag-start'; return; }
                token20 = await cdpEval(`(() => {
                  const el = document.querySelector('.tb-app.dragging');
                  if (!el) return 'no-dragging';
                  el.__deckP20 = 42;
                  return 'stamped';
                })()`, TASKBAR_TITLE);
                const stM = await state20();
                const metrics0 = (stM && stM.metrics) || [];
                const altM = (metrics0.length === 1 && metrics0[0] === 'cpu') ? ['cpu', 'memory'] : ['cpu'];
                await cdpEval(`window.deck.bridge.invoke('taskbar/set-metrics', { metrics: ${JSON.stringify(altM)} })`, TASKBAR_TITLE);
                await cdpEval(`window.deck.bridge.invoke('taskbar/set-metrics', { metrics: ${JSON.stringify(metrics0)} })`, TASKBAR_TITLE);
                await sleep(300); // 两帧回推落地窗
                token20 = await cdpEval(`(() => {
                  const el = document.querySelector('.tb-app.dragging');
                  if (!el) return 'no-dragging';
                  return el.__deckP20 === 42 ? 'same-node' : 'rebuilt';
                })()`, TASKBAR_TITLE);
              }).catch(() => {});
              dragB = await waitEvent('taskbar-drag-drop', (e) => e.from === 'apps' && e.to === 'apps' && norm20(e.id) === norm20(q1.exe) && norm20(e.before) === norm20(q3.exe), 6000);
              if (dragB) {
                const okB = await waitEvent('taskbar-drag-result', (e) => e.ok === true && e.t >= dragB.t, 6000);
                if (okB) dragB.ok20 = true;
                orderB = await waitSeq20((st) => {
                  const seg = segSplit20(st);
                  return seg.running.indexOf(norm20(q1.exe)) >= 0 && seg.running.indexOf(norm20(q3.exe)) >= 0
                    && seg.running.indexOf(norm20(q1.exe)) < seg.running.indexOf(norm20(q3.exe));
                });
              }
              // 第二拖（无中程推帧）：q3 拖回 q1 之前 → 会话序 q3<q1（臂D 重启对照态）
              const gB2 = await waitGeometrySettled(orderB || gB);
              const srcB2 = appPt20(gB2, q3.exe);
              const dstB2 = appPt20(gB2, q1.exe);
              if (srcB2 && dstB2) {
                const t0B2 = Date.now();
                oleDrag20(srcB2, dstB2, null).catch(() => {});
                await waitEvent('taskbar-drag-drop', (e) => e.t >= t0B2 && e.from === 'apps' && e.to === 'apps' && norm20(e.id) === norm20(q3.exe) && norm20(e.before) === norm20(q1.exe), 6000);
                orderB = await waitSeq20((st) => {
                  const seg = segSplit20(st);
                  return seg.running.indexOf(norm20(q3.exe)) >= 0 && seg.running.indexOf(norm20(q1.exe)) >= 0
                    && seg.running.indexOf(norm20(q3.exe)) < seg.running.indexOf(norm20(q1.exe));
                });
              }
            }
            if (dragB && dragB.ok20 && startB20 && token20 === 'same-node' && orderB) {
              rep.pass(`P20 臂B 运行段会话拖位+渲染冻结：运行条目真拖两连落位（会话序 q3<q1），中程强推 changed 两帧被拖节点同一性保持`
                + `（token=${token20}）——冻结生效无闪烁无回弹，drag-start/drag-drop/drag-result 三存证齐`);
            } else {
              rep.fail(`P20 臂B 未达成：drag-start存证=${startB20} drag-drop存证=${!!dragB} ok=${!!(dragB && dragB.ok20)} 冻结token=${token20} 落位后运行段=${JSON.stringify(segSplit20(await state20()).running)}`
                + ` 源/落点矩形=${!!srcB}/${!!dstB} 前置帧=${!!runPre20}（token=rebuilt/no-dragging 即节点被重建=冻结缺失；drag-start 在而 drag-drop 无即会话被中止）`);
            }
          }

          // —— 臂D1 运行拖位重启回默认序（持久化口径前半，第5轮取证重构）：此刻
          // q1/q2/q3 全为未钉运行（臂A 尚未钉入——q3 一经钉入便只出现在手钉段，两段模型
          // 下「重启后运行段含 q3」恒不可满足，第1-5轮臂D 读态半边全红的真根因；
          // 2dd29a0 只改了臂序与判据对，判据门/判据仍要求 q3 在 running，本臂拆出修复）。
          // 重启面板——臂B 摆下的会话序（q3<q1）不落盘：重启前置 q1 前台=首见序 q1<q3 ——
          {
            const stD1 = await state20();
            const beforeD1 = JSON.stringify(segSplit20(stD1));
            const focusOkD1 = await focus20(q1); // q1 前台=重启后 z 序首见第一（默认序判据的确定性底座）
            const { boot: bootD1, ready: readyD1 } = await restartPanel20('臂D1');
            const rebootD1 = await waitSeq20((st) => {
              const seg = segSplit20(st);
              return seg.running.indexOf(norm20(q1.exe)) >= 0 && seg.running.indexOf(norm20(q3.exe)) >= 0
                && seg.running.indexOf(norm20(q1.exe)) < seg.running.indexOf(norm20(q3.exe));
            }, 20000);
            if (bootD1 && readyD1 && rebootD1) {
              rep.pass(`P20 臂D1 运行拖位重启回默认序：重启面板——臂B 会话拖位（q3<q1）随会话归零，`
                + `重启后 q1 前台=首见序（q1<q3，运行段=${JSON.stringify(segSplit20(rebootD1).running.map((k) => path.basename(k)))}）`);
            } else {
              rep.fail(`P20 臂D1 运行拖位复位未达成：boot=${!!bootD1} 就绪=${!!readyD1} 重启帧=${!!rebootD1}(前台=${focusOkD1})`
                + ` 重启前=${beforeD1} 重启后=${JSON.stringify(segSplit20(await state20()))}`);
            }
          }

          // —— 臂A 全条目接线（断点①）：手钉条目拖到仅运行图标上，before=运行身份不被吞 ——
          {
            await cdpEval(`window.deck.bridge.invoke('taskbar/set-app-pinned', { exe: ${JSON.stringify(q3.exe)}, pinned: true })`, TASKBAR_TITLE);
            await cdpEval(`window.deck.bridge.invoke('taskbar/set-app-pinned', { exe: ${JSON.stringify(q2.exe)}, pinned: true })`, TASKBAR_TITLE);
            // 钉入序 = 清单序 [q3, q2]（老左新右）；手钉拖位将把 q3 拖过 q2
            const pinned20 = await waitSeq20((st) => {
              const seg = segSplit20(st);
              return seg.pinned.includes(norm20(q3.exe)) && seg.pinned.includes(norm20(q2.exe));
            });
            const gA = await waitGeometrySettled(pinned20);
            const srcA = appPt20(gA, q3.exe);
            const dstA = appPt20(gA, q1.exe); // 落点 = 仅运行图标（未钉运行条目——老代码在此静默吞掉）
            let dragA = null;
            let orderA = null;
            if (srcA && dstA) {
              oleDrag20(srcA, dstA, null).catch(() => {});
              dragA = await waitEvent('taskbar-drag-drop', (e) => e.from === 'apps' && e.to === 'apps' && norm20(e.id) === norm20(q3.exe) && norm20(e.before) === norm20(q1.exe), 6000);
              if (dragA) {
                const okA = await waitEvent('taskbar-drag-result', (e) => e.ok === true && e.t >= dragA.t, 6000);
                orderA = await waitSeq20((st) => {
                  const seg = segSplit20(st);
                  return seg.pinned.indexOf(norm20(q2.exe)) >= 0 && seg.pinned.indexOf(norm20(q2.exe)) < seg.pinned.indexOf(norm20(q3.exe));
                });
                if (okA) dragA.ok20 = true;
              }
            }
            if (dragA && dragA.ok20 && orderA) {
              rep.pass(`P20 臂A 全条目接线：手钉条目拖到仅运行图标上松手——drag-drop 存证 before=运行身份、ok 回执、`
                + `手钉段 ${segSplit20(orderA).pinned.map((k) => path.basename(k)).join('|')}（q3 跨 q2 落手钉段末尾=运行段邻接钳取，不再被容器守卫静默吞掉）`);
            } else {
              rep.fail(`P20 臂A 全条目接线未达成：drag-drop存证=${!!dragA} ok=${!!(dragA && dragA.ok20)} 落位后序=${JSON.stringify(seq20(await state20()))}`
                + ` 源/落点矩形=${!!srcA}/${!!dstA}`);
            }
          }

          // —— 臂C 跨组拖拽 + 组间缝隙松手（断点③）：推荐条目经缝隙落运行图标升手钉 ——
          {
            const recNameC = p16 ? p16.probes[0].name : null;
            const gC = await waitGeometrySettled(null);
            const srcC = recNameC ? recPt20(gC, recNameC) : null;
            const dstC = appPt20(gC, q1.exe);
            // 组间缝隙中点（推荐组右缘 ~ 应用组左缘，CSS 口径进 toPhys；y 取应用组格带中线）：
            // 持门期门恒开，缝隙停拍不再丢拖拽
            const gapC = (gC && gC.recPill && gC.appsPill && srcC && dstC)
              ? toPhys((gC.recPill.x + gC.recPill.w + gC.appsPill.x) / 2, gC.appsPill.y + gC.appsPill.h / 2)
              : null;
            let dragC = null;
            if (srcC && dstC && gapC) {
              // 手工三段路径：recs → 缝隙（停拍 400ms，断点③的丢失点）→ 运行图标
              win32.moveMousePhys(srcC.x, srcC.y);
              await sleep(250);
              win32.send([win32.mouseInput(0, 0, win32.LEFTDOWN)]);
              for (let s = 1; s <= 6; s++) {
                await sleep(24);
                win32.moveMousePhys(srcC.x + Math.round(((gapC.x - srcC.x) * s) / 6), srcC.y + Math.round(((gapC.y - srcC.y) * s) / 6));
              }
              await sleep(400); // 缝隙中停拍：老代码此处 25ms 轮询两拍关门 → ~60% 跨 pill 丢 drop
              for (let s = 1; s <= 6; s++) {
                await sleep(24);
                win32.moveMousePhys(gapC.x + Math.round(((dstC.x - gapC.x) * s) / 6), gapC.y + Math.round(((dstC.y - gapC.y) * s) / 6));
              }
              await sleep(300);
              win32.moveMousePhys(dstC.x - 3, dstC.y);
              await sleep(120);
              win32.moveMousePhys(dstC.x, dstC.y);
              await sleep(200);
              win32.send([win32.mouseInput(0, 0, win32.LEFTUP)]);
              const startC = await waitEvent('taskbar-drag-start', (e) => e.group === 'recs' && e.id === recNameC, 6000);
              dragC = await waitEvent('taskbar-drag-drop', (e) => e.from === 'recs' && e.to === 'apps' && e.id === recNameC && norm20(e.before) === norm20(q1.exe), 6000);
              if (dragC) {
                const okC = await waitEvent('taskbar-drag-result', (e) => e.ok === true && e.t >= dragC.t, 6000);
                if (okC) dragC.ok20 = true;
                // 拖拽窗口（drag-start→drag-drop 存证 t 区间）无 hotzone-leave：持门生效的直接存证
                if (startC) {
                  const leavesC = readEvents().filter((e) => e.type === 'taskbar-hotzone-leave' && e.t >= startC.t && e.t <= dragC.t);
                  if (leavesC.length > 0) dragC.leaves20 = leavesC.length;
                }
              }
            }
            if (dragC && dragC.ok20) {
              rep.pass(`P20 臂C 跨组拖拽+组间缝隙松手：推荐条目拖经缝隙（中停 400ms）落运行图标升手钉——drag-drop 存证 before=运行身份、ok 回执`
                + `，拖拽窗口 hotzone-leave=${dragC.leaves20 || 0} 次（持门生效${dragC.leaves20 ? '' : '，门全程未关'}）`);
            } else {
              rep.fail(`P20 臂C 跨组/缝隙未达成：drag-drop存证=${!!dragC} ok=${!!(dragC && dragC.ok20)} 拖拽窗口hotzone-leave=${dragC ? (dragC.leaves20 || 0) : 'n/a'}`
                + ` 源/落点/缝隙矩形=${!!srcC}/${!!dstC}/${!!gapC}（drag-start 在而 drag-drop 无 = 缝隙处门关丢了会话）`);
            }
          }

          // —— 臂E 拖拽失败可见反馈（票面 AC：服务层拒返渲染层不静默）：未钉运行条目
          // 拖到推荐组（apps→recs 解除臂）——服务层确定性拒返 ok:false（仅手钉可解除，
          // 运行态不可摆位），零竞态路径；断言 drag-result ok:false 存证 + #drag-toast
          // DOM 在场与文案（5s 兜底自收窗内即时取），栏面状态不变 ——
          {
            const gE = await waitGeometrySettled(null);
            const srcE = appPt20(gE, q1.exe); // q1 此刻仍为未钉运行（臂B 会话序、臂C 未触钉态）
            const dstE = (gE && gE.recPill && gE.recPill.w > 0)
              ? toPhys(gE.recPill.x + gE.recPill.w / 2, gE.recPill.y + gE.recPill.h / 2)
              : null; // 推荐组 pill 中心：落推荐位条目或组空白同达 apps→recs 分发
            let dragE = null;
            let resultE = null;
            let toastE = null;
            if (srcE && dstE) {
              const t0E = Date.now();
              oleDrag20(srcE, dstE, null).catch(() => {});
              dragE = await waitEvent('taskbar-drag-drop', (e) => e.t >= t0E && e.from === 'apps' && e.to === 'recs' && norm20(e.id) === norm20(q1.exe), 6000);
              if (dragE) {
                resultE = await waitEvent('taskbar-drag-result', (e) => e.ok === false && e.t >= dragE.t, 6000);
                // toast 5s 自收：drag-result 后即时取 DOM（dataset.on=1 且文案前缀）
                try {
                  toastE = await cdpEval(`(() => {
                    const t = document.getElementById('drag-toast');
                    return t && t.dataset.on === '1' ? (t.textContent || '') : null;
                  })()`, TASKBAR_TITLE);
                } catch { toastE = null; }
              }
            }
            const stE = await state20();
            const stillE = !!stE && seq20(stE).includes(norm20(q1.exe));
            if (dragE && resultE && toastE && toastE.includes('拖拽落位失败') && stillE) {
              rep.pass(`P20 臂E 拖拽失败可见反馈：未钉运行条目拖到推荐组——服务层拒返（仅手钉可解除）、`
                + `drag-result ok:false 存证（error=${resultE.error || 'n/a'}）、条带内 toast 在场文案「${toastE.slice(0, 40)}」、栏面状态不变（拒返不摆位）`);
            } else {
              rep.fail(`P20 臂E 失败反馈未达成：drag-drop存证=${!!dragE} ok:false回执=${!!resultE} toast=${JSON.stringify(toastE)}`
                + ` 源/落点矩形=${!!srcE}/${!!dstE}（toast=null = 拒返无可见反馈或 5s 窗外取拍）`);
            }
          }

          // —— 臂D2 手钉拖位落盘记住（持久化口径后半）：重启面板——臂A 摆下的手钉拖位
          // （钉入落盘序 [.., q3, q2]，拖位后 [.., q2, q3]）落盘记住；存储文件无运行序段
          // （会话态不落盘；运行半边见臂D1）——
          {
            const stD0 = await state20();
            const beforeD = JSON.stringify(segSplit20(stD0));
            const { boot: bootD, ready: readyD } = await restartPanel20('臂D2');
            const rebootD = await waitSeq20((st) => {
              const seg = segSplit20(st);
              return seg.pinned.includes(norm20(q2.exe)) && seg.pinned.includes(norm20(q3.exe));
            }, 20000);
            const segD1 = segSplit20(rebootD);
            // 手钉拖位记住：钉入落盘序是 [.., q3, q2]，臂A 拖位后 [.., q2, q3]——重启后仍 q2 在 q3 前
            const pinPersistD = !!rebootD && segD1.pinned.indexOf(norm20(q2.exe)) >= 0
              && segD1.pinned.indexOf(norm20(q2.exe)) < segD1.pinned.indexOf(norm20(q3.exe));
            // 存储文件无运行序段（会话态不落盘）+ 手钉拖位确在盘面
            let diskD = null;
            try {
              diskD = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'taskbar-layout.json'), 'utf8'));
            } catch { /* 读不到按失败判 */ }
            const diskOkD = !!diskD && !('runOrder' in diskD)
              && (diskD.pinned || []).some((e) => norm20(e.exe) === norm20(q2.exe))
              && (diskD.pinned || []).map((e) => norm20(e.exe)).indexOf(norm20(q2.exe))
                < (diskD.pinned || []).map((e) => norm20(e.exe)).indexOf(norm20(q3.exe));
            if (bootD && readyD && rebootD && pinPersistD && diskOkD) {
              rep.pass(`P20 臂D2 手钉拖位落盘记住：重启面板——手钉拖位 q2<q3 落盘记住（get-state 与盘面一致），`
                + `存储无运行序段（会话态不落盘）`);
            } else {
              let cdpDiagD = 'fetch-fail';
              try {
                const tg = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
                cdpDiagD = 'targets=[' + tg.map((x) => x.title).join('|') + ']';
              } catch (e) { cdpDiagD = 'fetch-fail:' + (e && e.message); }
              rep.fail(`P20 臂D2 手钉拖位保持未达成：boot=${!!bootD} 就绪=${!!readyD} 重启帧=${!!rebootD} 手钉拖位保持=${pinPersistD} 盘面=${diskOkD}`
                + ` 重启前=${beforeD} 重启后=${JSON.stringify(segD1)} 盘面pinned=${diskD ? JSON.stringify((diskD.pinned || []).map((e) => e.exe)) : 'n/a'} CDP=${cdpDiagD}`);
            }
          }
        }
      }
    }
  } catch (err) {
    rep.fail(`电池异常: ${err && err.stack || err}`);
  } finally {
    if (probe164) { try { probe164.destroy(); } catch { /* 尽力 */ } }
    cleanupP18Probes(p18); // P18 痕迹摘除（进程/目录/栏布局存储手钉残留）
    killTree(child, panelPid);
    cleanupRecsProbes(p16); // P16 痕迹三处摘除（面板已杀，落盘清理不再被回写）
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
