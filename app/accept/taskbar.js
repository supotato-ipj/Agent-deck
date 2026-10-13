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
//      空带内居中（随两侧内容浮动）、右组与细条位置不变、不与邻组重叠——几何存证帧
//      与 CDP computed style 互证；居中回正驱动 = set-button-hidden 藏/显 TaskView 钮
//   P16 推荐组交互主体（工单160）：五条 usage 种子探针确定性占满推荐位（先于面板种入
//      ——usage 打分只在服务构造时读盘），真机六臂——图标化上限5（.tb-rec 44 格/32 图标
//      img/首字母占位，无显示名文本残留）、左键启动（真点击→rec-click 存证→notepad 副本
//      真窗口出场）、右键两行菜单（手钉到任务栏/打开文件位置）+手钉即时迁移（推荐组消失
//      +应用组手钉段前位出现）、真 OLE 拖拽组内换位（显式序压过分数序）、跨组升手钉
//      （recs→apps 落点条目前插入）、解除手钉随下拍回池；痕迹三处在 finally 摘除
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

async function main() {
  const rep = new Report('49-taskbar');
  let child = null;
  let panelPid = 0;
  let probe164 = null; // P14 探针（#164）：finally 兜底拆除（段内异常也不漏窗漏类）
  let p16 = null; // P16 推荐组探针（#160）：面板启动前种入（usage 只在服务构造时读盘），finally 兜底清理
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
    // 缝隙探针（工单159 布局重排适配）：应用组空带居中后，pill 间缝隙取「应用组右缘与
    // 右组左缘的中点」（带宽恒宽敞）；应用组空（pill-apps 不渲染）退「开始组右缘与右组
    // 左缘的中点」；开始组也整组不渲染时 startPill 矩形归零、退化为条带左半任意点
    // （固定 x=40 会落进钉左的开始组热区——工单159 起开始组钉条带左缘）
    const gapCssX = geom.apps && geom.apps.length > 0
      ? (geom.appsPill.x + geom.appsPill.w + geom.rightPill.x) / 2
      : (geom.startPill.x + geom.startPill.w + geom.rightPill.x) / 2;
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
      // 工单158 挤撞回正的密度紧凑档，托盘格 padding 7→5 延缓右组左侵中组）
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

    // P15 栏分组布局重排（工单159）：三组新布局落位与居中回正。证据两路互证：
    //   (1) taskbar-geometry 存证帧（渲染层量出的 pill 矩形，与电池点击坐标同源）；
    //   (2) 任务栏页 CDP computed style（开始组钉左 CSS 落位 + 应用组 JS 落位在场）。
    //   居中回正驱动 = CDP taskbar/set-button-hidden 藏/显 TaskView 钮（左界内容变化 →
    //   taskbar/changed 结构性重渲 → 应用组按新空带回正）；hiddenButtons 是 config 落盘项，
    //   段内显式复原（finally 的三态还原兜底）。应用格空时 notepad 探针（同 P13）。
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
      const bandOf = (g) => ({
        lo: g.startPill.x + g.startPill.w + GAP15,
        hi: g.rightPill.x - GAP15,
        mid: (g.startPill.x + g.startPill.w + GAP15 + g.rightPill.x - GAP15) / 2,
      });
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
      const appsMid0 = g0.appsPill.x + g0.appsPill.w / 2;
      const centerOk14 = Math.abs(appsMid0 - b0.mid) <= 2.5;
      const noOverlap14 = g0.appsPill.x >= b0.lo - 0.5 && g0.appsPill.x + g0.appsPill.w <= b0.hi + 0.5;
      const dip14 = screen.getPrimaryDisplay().bounds;
      const rightOk14 = Math.abs(g0.rightPill.x + g0.rightPill.w - (dip14.width - 14)) <= 2
        && Math.abs(g0.sliver.x + g0.sliver.w - dip14.width) <= 2;
      const recs14 = g0.recommendations || [];
      const recsOk14 = recs14.length === 0
        || recs14.every((r) => r.x >= g0.startPill.x - 0.5 && r.x + r.w <= g0.startPill.x + g0.startPill.w + 0.5);
      if (startOk14 && cssOk14 && centerOk14 && noOverlap14 && rightOk14 && recsOk14) {
        rep.pass(`P15 三组新布局落位：开始组钉左（x=${g0.startPill.x.toFixed(1)}，CSS=${css14.startLeft}）、`
          + `应用组空带居中（组心 ${appsMid0.toFixed(1)} ≈ 带中点 ${b0.mid.toFixed(1)}，带 [${b0.lo.toFixed(0)}, ${b0.hi.toFixed(0)}]）、`
          + `不与邻组重叠、右组+细条钉右不变${recs14.length ? `、推荐位 ${recs14.length} 枚占位其后` : ''}`);
      } else {
        rep.fail(`P15 钉左=${startOk14}(x=${g0.startPill.x}) css互证=${cssOk14}(${JSON.stringify(css14)})`
          + ` 居中=${centerOk14}(组心${appsMid0.toFixed(1)} vs 带中点${b0.mid.toFixed(1)}) 不重叠=${noOverlap14}`
          + ` 右组细条=${rightOk14} 推荐位界内=${recsOk14}(${recs14.length} 枚)`
          + ` 帧=${JSON.stringify({ startPill: g0.startPill, appsPill: g0.appsPill, rightPill: g0.rightPill, sliver: g0.sliver })}`);
      }
      // —— 居中回正（随两侧内容浮动）：藏 TaskView 钮 → 左界收窄 → 应用组左移带中点回正 ——
      const w0 = g0.startPill.w;
      const sinceHide = Date.now();
      await cdpEval(`window.deck.bridge.invoke('taskbar/set-button-hidden', { id: 'tasks', hidden: true })`);
      let g1 = null;
      for (let i = 0; i < 30 && !g1; i++) {
        await sleep(200);
        const cand = latestGeometry(null);
        if (cand && cand.t >= sinceHide && cand.startPill && cand.startPill.w < w0 - 4) g1 = cand;
      }
      await sleep(1300); // settle 窗（推荐位后到位会推位移帧，取跨拍稳定帧）
      if (g1) g1 = latestGeometry(null);
      const b1 = g1 ? bandOf(g1) : null;
      const recenterHideOk = !!(g1 && b1
        && Math.abs(g1.appsPill.x + g1.appsPill.w / 2 - b1.mid) <= 2.5
        && g1.appsPill.x < g0.appsPill.x - 4);
      // 复原 TaskView 钮 → 左界回宽 → 应用组右移回正（显式复原；config 三态还原兜底）
      const sinceRestore = Date.now();
      await cdpEval(`window.deck.bridge.invoke('taskbar/set-button-hidden', { id: 'tasks', hidden: false })`);
      let g2 = null;
      for (let i = 0; i < 30 && !g2; i++) {
        await sleep(200);
        const cand = latestGeometry(null);
        if (cand && cand.t >= sinceRestore && cand.startPill && g1 && cand.startPill.w > g1.startPill.w + 4) g2 = cand;
      }
      await sleep(1300);
      if (g2) g2 = latestGeometry(null);
      const b2 = g2 ? bandOf(g2) : null;
      const recenterRestoreOk = !!(g2 && b2 && Math.abs(g2.appsPill.x + g2.appsPill.w / 2 - b2.mid) <= 2.5);
      if (recenterHideOk && recenterRestoreOk) {
        rep.pass(`P15 居中随两侧内容浮动：藏 TaskView 钮（开始组 ${w0.toFixed(0)}→${g1.startPill.w.toFixed(0)}px）`
          + `应用组左移回正（组心 ${(g1.appsPill.x + g1.appsPill.w / 2).toFixed(1)} ≈ 带中点 ${b1.mid.toFixed(1)}），`
          + `复原回中（组心 ${(g2.appsPill.x + g2.appsPill.w / 2).toFixed(1)} ≈ ${b2.mid.toFixed(1)}）`);
      } else {
        rep.fail(`P15 居中回正: 藏钮后=${recenterHideOk}(帧=${g1 ? JSON.stringify({ startPill: g1.startPill, appsPill: g1.appsPill }) : 'null'})`
          + ` 复原后=${recenterRestoreOk}(帧=${g2 ? JSON.stringify({ startPill: g2.startPill, appsPill: g2.appsPill }) : 'null'})`);
      }
    } finally {
      if (notepad14) spawnSync('taskkill', ['/PID', String(notepad14.pid), '/T', '/F'], { stdio: 'ignore' });
    }

    // P16 推荐组交互主体（工单160）：探针五条确定性占满推荐位（usage 种子压分），真机
    // 断言六臂——①图标化+上限5（.tb-rec 定宽图标格 img/首字母占位，无显示名文本残留，
    // 探针恰满 5 枚=第 6/7 名 F/G 不出现）②左键启动（真点击 → rec-click 存证 → cmd
    // 副本真出场，端到端 shell 打开通道）③右键三行菜单+手钉（真右键 → 三行在列 →
    // 点「手钉到任务栏」→ B 即时消失、第 6 名 F 递补（工单161 滤除后截断），不双占位）
    // ④拖拽组内换位（真 OLE 拖拽 recs→recs，显式序压过分数序）⑤拖去应用组升手钉
    // （recs→apps 跨组，落点条目前插入、G 随 D 升钉递补）⑥解除手钉随下拍回池 +
    // 打开文件位置（explorer 定位真出场）。可见数断言按工单161 递补语义校准（升手钉
    // 不再留空位，候选池后续名次即时补齐）。痕迹三处在 finally 摘除（桌面夹具/usage
    // 行/栏布局存储身份含 excluded 段）。
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
      const domRecs16 = async () => cdpEval(`(() => {
        const cells = [...document.querySelectorAll('#pill-start .tb-rec')];
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
      const menuRows16 = (name) => {
        const n = JSON.stringify(name);
        return cdpEval(`(() => {
          return [...document.querySelectorAll('#pill-start .tb-menu-item')]
            .filter((r) => !${n} || r.dataset.name === ${n})
            .map((r) => ({ action: r.dataset.action, label: r.textContent || '', rect: r.getBoundingClientRect().toJSON() }));
        })()`, TASKBAR_TITLE);
      };
      // 菜单诊断（右键开合抖动的取证面：menuOpen 标记 + 在册菜单行）
      const menuDiag16 = () => cdpEval(`(() => {
        return {
          menuOpen: document.getElementById('pill-start')?.dataset.menuOpen || '',
          rows: [...document.querySelectorAll('#pill-start .tb-menu-item')].map((r) => r.dataset.action || r.dataset.id || ''),
        };
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

        // —— ③ 右键三行菜单 + 手钉（B 消失、F 递补，不双占位；工单161 扩移除行）——
        let gB = await waitGeometrySettled(g16);
        const ptB = recPt16(gB, pB16.name);
        if (!ptB) {
          rep.fail(`P16 右键臂前置缺失：探针 B 不在推荐位（${JSON.stringify(recNames16(gB))}）`);
        } else {
          win32.clickPhys(ptB.x, ptB.y, 'right');
          let rowsB = null;
          for (let i = 0; i < 20 && !rowsB; i++) {
            await sleep(200);
            const rows = await menuRows16(pB16.name);
            if (rows.length === 3) rowsB = rows;
          }
          const rowsOk16 = !!rowsB && rowsB.map((r) => r.action).join(',') === 'pin,remove,reveal'
            && rowsB.map((r) => r.label).join(',') === '手钉到任务栏,从推荐栏移除,打开文件位置';
          let pinned16 = null;
          if (rowsOk16) {
            const pr = rowsB.find((r) => r.action === 'pin').rect;
            const pp = toPhys(pr.x + pr.width / 2, pr.y + pr.height / 2);
            win32.clickPhys(pp.x, pp.y, 'left');
            await waitEvent('taskbar-rec-menu-action', (e) => e.name === pB16.name && e.action === 'pin', 5000);
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

          // —— ⑥ 解除手钉随下拍回池 + 打开文件位置 ——
          // 右键两试（第 5 轮实证 pill-apps 右键偶发不开菜单）：未开则光标离位刷新热区、
          // 重取 settle 几何再试一次。
          let gU = await waitGeometrySettled(cross16 || gD);
          let ptU = appPt16(gU, pD16.exe); // 解除对象 = 探针 D（拖拽升手钉；按 exe 定位）
          let repool16 = null;
          let unpinRow = null;
          for (let attempt16 = 0; attempt16 < 2 && ptU && !unpinRow; attempt16++) {
            win32.clickPhys(ptU.x, ptU.y, 'right');
            for (let i = 0; i < 10 && !unpinRow; i++) {
              await sleep(200);
              const rows = await cdpEval(`(() => {
                const r = document.querySelector('#pill-start .tb-menu-item[data-action="unpin"]');
                return r ? { label: r.textContent || '', rect: r.getBoundingClientRect().toJSON() } : null;
              })()`, TASKBAR_TITLE);
              if (rows) unpinRow = rows;
            }
            if (!unpinRow && attempt16 === 0) {
              win32.moveMousePhys(ptU.x, ptU.y - 60); // 离位刷新热区
              await sleep(300);
              gU = await waitGeometrySettled(latestGeometry(null));
              ptU = appPt16(gU, pD16.exe);
            }
          }
          if (ptU && unpinRow) {
              const up = toPhys(unpinRow.rect.x + unpinRow.rect.width / 2, unpinRow.rect.y + unpinRow.rect.height / 2);
              win32.clickPhys(up.x, up.y, 'left');
              await waitEvent('taskbar-app-menu-action', (e) => e.action === 'unpin', 5000);
              for (let i = 0; i < 30 && !repool16; i++) {
                await sleep(200);
                const cand = latestGeometry(null);
                if (cand && recNames16(cand).includes(pD16.name) && recNames16(cand).length === 5
                  && !(cand.apps || []).some((a) => norm16(a.id) === norm16(pD16.exe))) repool16 = cand;
              }
          }
          // 打开文件位置（推荐位 C）：右键 → 点 reveal 行 → explorer 定位窗口真出场（软核验收尾关闭）。
          // 右键两试（⑥解除臂同款：右键偶发不开菜单——离位刷新热区+重取 settle 几何再试）。
          let reveal16 = null;
          let expHwnd16 = null;
          const gR0 = await waitGeometrySettled(repool16 || gU);
          let rowsR = null;
          let ptR = recPt16(gR0, pC16.name);
          for (let attempt16 = 0; attempt16 < 2 && ptR && !rowsR; attempt16++) {
            win32.clickPhys(ptR.x, ptR.y, 'right');
            for (let i = 0; i < 20 && !rowsR; i++) {
              await sleep(200);
              const rows = await menuRows16(pC16.name);
              if (rows.length === 3) rowsR = rows;
            }
            if (!rowsR && attempt16 === 0) {
              win32.moveMousePhys(ptR.x, ptR.y - 60); // 离位刷新热区
              await sleep(300);
              const gR = await waitGeometrySettled(latestGeometry(null));
              ptR = recPt16(gR, pC16.name);
            }
          }
            if (rowsR) {
              const rr = rowsR.find((r) => r.action === 'reveal').rect;
              const rp = toPhys(rr.x + rr.width / 2, rr.y + rr.height / 2);
              win32.clickPhys(rp.x, rp.y, 'left');
              reveal16 = await waitEvent('taskbar-rec-menu-action', (e) => e.name === pC16.name && e.action === 'reveal', 5000);
              await waitEvent('taskbar-rec-menu-result', (e) => e.name === pC16.name && e.action === 'reveal', 5000);
              const dirName = path.basename(p16.tmpDir);
              for (let i = 0; i < 24 && !expHwnd16; i++) {
                await sleep(250);
                expHwnd16 = win32.topLevelWindows().find((h) => win32.className(h) === 'CabinetWClass' && titleOf(h).includes(dirName)) || null;
              }
              if (expHwnd16) PostMessageW16(expHwnd16, WM_CLOSE_16, 0, 0); // 只关窗不碰 shell
            }
          if (repool16 && reveal16) {
            rep.pass(`P16 解除手钉回池+打开文件位置：D 解除手钉随下拍回池（推荐组恒 5、第 7 名 G 让位、应用组摘除）；`
              + `reveal 行点击存证在案${expHwnd16 ? '，explorer 定位窗口真出场（已收窗）' : '（explorer 窗未及出场，软核验）'}`);
          } else {
            const diagU = await menuDiag16();
            rep.fail(`P16 解除回池/reveal：回池=${!!repool16}(recs=${JSON.stringify(recNames16(latestGeometry(null)))})`
              + ` reveal存证=${!!reveal16} explorer窗=${expHwnd16 ? '在场' : '未出场'} 菜单诊断=${JSON.stringify(diagU)}`);
          }
        }
      }
    }

    // P17 推荐组移除名单（工单161）：持久排除 + 名次递补 + 空白右键恢复。三臂——
    // ①右键探针 F（第 6 名，经⑤递补在栏）→ 菜单恰三行 → 点「从推荐栏移除」→ F 即时消失、
    //   第 7 名 G 递补（可见恒 5），移除落盘（get-state excluded 含 F，exe=富化目标身份）；
    // ②推荐组空白右键 → 54 菜单恢复段在列（「恢复 <显示名>」行）→ 点选 → F 回池（G 让位），
    //   excluded 清空；
    // ③重启保持：CDP 桥直发 rec-remove（输入注入路径①已证）→ killTree+重启面板 →
    //   get-state 排除名单与可见名单都保持（F 不复活、G 占位）→ 空白右键恢复行仍在 →
    //   点选恢复 → F 回池。恢复入口用 pill 内横排形态（#162 浮层菜单面板为托盘域专用：
    //   挂点在「⋯」钮且行交互接托盘像素管线，推荐组恢复行是纯文本标签——票内裁定走横排）。
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
      const restoreRow17 = () => cdpEval(`(() => {
        const r = document.querySelector('#pill-start .tb-menu-item[data-action="restore"]');
        return r ? { label: r.textContent || '', exe: r.dataset.exe || '', rect: r.getBoundingClientRect().toJSON() } : null;
      })()`, TASKBAR_TITLE);
      const state17 = () => cdpEval(`window.deck.bridge.invoke('taskbar/get-state', null)`, TASKBAR_TITLE);
      const menuDiag17 = () => cdpEval(`(() => {
        return {
          menuOpen: document.getElementById('pill-start')?.dataset.menuOpen || '',
          rows: [...document.querySelectorAll('#pill-start .tb-menu-item')].map((r) => r.dataset.action || r.dataset.id || ''),
        };
      })()`, TASKBAR_TITLE);
      // 空白右键（恢复菜单挂点 = pillStart 空白，54 菜单同一点）：三点轮试——左缘内衬 3px
      // 在热区/DPI 取整松弛下余量太窄（红轮两轮 4 试全败的系统性签名；图标点击 44px 格
      // 中心从无此问题），换顶部内衬横中点（水平余量大）与开始钮面（contextmenu 冒泡到
      // pill，同挂点语义）兜底。每次尝试后轮询 menuOpen 标记 + 恢复行。
      const blankRightClick17 = async (gBlank) => {
        const pill = gBlank.startPill;
        const cands = [
          { x: pill.x + pill.w / 2, y: pill.y + 3, tag: 'top-pad-center' },
          { x: pill.x + 3, y: pill.y + pill.h / 2, tag: 'left-pad-mid' },
        ];
        for (const c of cands) {
          const pt = toPhys(c.x, c.y);
          win32.clickPhys(pt.x, pt.y, 'right');
          for (let i = 0; i < 10; i++) {
            await sleep(200);
            const row = await restoreRow17();
            if (row) return { row, tag: c.tag };
          }
          const diag = await menuDiag17();
          rep.note(`P17 空白右键试点 ${c.tag} 未出恢复行：menuOpen=${diag.menuOpen} rows=${JSON.stringify(diag.rows)}`);
          // 收层再试下一点（菜单可能开了但无恢复行——excluded 空态，或压根没开）
          win32.moveMousePhys(pt.x, pt.y - 60);
          await sleep(300);
          const g2 = await waitGeometrySettled(latestGeometry(null));
          if (g2) gBlank.startPill = g2.startPill;
        }
        return { row: null, tag: 'none' };
      };
      // ① 右键 F → 三行 → 点「从推荐栏移除」→ F 消失 G 递补 + 移除落盘（右键两试：
      // 右键偶发不开菜单——⑥解除臂同款抖动，离位刷新热区+重取 settle 几何再试）
      let g17 = await waitGeometrySettled(latestGeometry(null));
      const ptF0 = recPt17(g17, pF17.name);
      let removed17 = null;
      let rows17 = null;
      if (!ptF0) {
        rep.fail(`P17 前置缺失：探针 F 不在推荐位（${JSON.stringify(recNames17(g17))}）`);
      } else {
        let ptF = ptF0;
        for (let attempt17 = 0; attempt17 < 2 && !rows17; attempt17++) {
          win32.clickPhys(ptF.x, ptF.y, 'right');
          for (let i = 0; i < 20 && !rows17; i++) {
            await sleep(200);
            const rows = await cdpEval(`(() => {
              return [...document.querySelectorAll('#pill-start .tb-menu-item')].map((r) => ({ action: r.dataset.action, label: r.textContent || '', rect: r.getBoundingClientRect().toJSON() }));
            })()`, TASKBAR_TITLE);
            if (rows.length === 3) rows17 = rows;
          }
          if (!rows17 && attempt17 === 0) {
            const diag = await menuDiag17();
            rep.note(`P17 移除臂右键首试未开菜单：menuOpen=${diag.menuOpen} rows=${JSON.stringify(diag.rows)}——离位刷新热区重试`);
            win32.moveMousePhys(ptF.x, ptF.y - 60);
            await sleep(300);
            const gR = await waitGeometrySettled(latestGeometry(null));
            ptF = recPt17(gR, pF17.name) || ptF;
          }
        }
        if (rows17 && rows17.map((r) => r.action).join(',') === 'pin,remove,reveal') {
          const rr = rows17.find((r) => r.action === 'remove').rect;
          const rp = toPhys(rr.x + rr.width / 2, rr.y + rr.height / 2);
          win32.clickPhys(rp.x, rp.y, 'left');
          await waitEvent('taskbar-rec-menu-action', (e) => e.name === pF17.name && e.action === 'remove', 5000);
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

        // ② 推荐组空白右键 → 恢复段点选 → F 回池（G 让位）
        let restored17 = null;
        let row17 = null;
        {
          const gBlank = await waitGeometrySettled(latestGeometry(null));
          const hit = await blankRightClick17(gBlank);
          row17 = hit.row;
          if (row17) rep.note(`P17 恢复段经试点 ${hit.tag} 开出`);
        }
        if (row17) {
          const labelOk17 = row17.label === `恢复 ${pF17.name.replace(/\.lnk$/i, '')}`;
          const rp = toPhys(row17.rect.x + row17.rect.width / 2, row17.rect.y + row17.rect.height / 2);
          win32.clickPhys(rp.x, rp.y, 'left');
          await waitEvent('taskbar-rec-restore', (e) => norm17(e.exe) === norm17(pF17.exe), 5000);
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
          if (rowAfter17) rep.note(`P17 重启后恢复段经试点 ${hit.tag} 开出`);
          if (rowAfter17) {
            const rp = toPhys(rowAfter17.rect.x + rowAfter17.rect.width / 2, rowAfter17.rect.y + rowAfter17.rect.height / 2);
            win32.clickPhys(rp.x, rp.y, 'left');
            await waitEvent('taskbar-rec-restore', (e) => norm17(e.exe) === norm17(pF17.exe), 5000);
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
  } catch (err) {
    rep.fail(`电池异常: ${err && err.stack || err}`);
  } finally {
    if (probe164) { try { probe164.destroy(); } catch { /* 尽力 */ } }
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
