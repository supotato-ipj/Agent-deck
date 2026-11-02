'use strict';
// 工单363 取证 harness：通知区域（托盘）原生菜单的「回调／前台／z 序」三段断点定位。
//
// 目的（工单363 AC 第一条 / 父 spec #361 决策 7「先取证再定改点」）：一次最小真机
// 复现，采集并记录——回调版本、回调投递结果、目标属主、前台窗、菜单窗（#32768 标准
// 菜单 vs 自绘菜单）、条带置顶与「托盘右键让位」时序，并能指出实际断点落在哪一段。
//
// 相位：
//   P0 拉起      --panel-accept + DECK_EVENT_LOG/CDP；taskbar.enabled 覆写 true（结束还原）
//   P1 基线      条带窗 hwnd + WS_EX_TOPMOST 位；栏内名单逐条解析属主 pid/exe/tooltip；
//                候选样本清单（自家图标 + 第三方优先名单）；ASFW 放行权对照探针
//                （harness 进程既非前台也非末次输入接收者 ⇒ 放行应当失败）
//   P2 产品链轮  对每个候选做**真实鼠标右键**（用户链路：DOM → 桥 → 服务 → 数据面托盘
//                宿主 → 回调投递）。采样：前台窗身份 / 目标 pid 的 #32768 菜单窗 /
//                目标 pid 的可见顶层窗（自绘菜单）/ 条带 TOPMOST 位；菜单在场则测
//                「Esc 收起」与「点外收起」
//   P3 溢出轮    托盘溢出浮层在场性核对（两条入口同链）
//   P4 汇总      findings.json / timeline.json 落盘
//
// 纪律：产品代码零改动；取证工具不进 manifest、不产 verdict 电池；碰真桌面（真面板 +
// CDP + 键鼠注入），一律经 accept-guard 托管。退出码 0=完成，3=机器脏（残留菜单/条带）。
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const win32 = require('../lib/win32');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_OUT = 'D:\\test-folder\\.agent-notes\\t363-tray-menu';
const STRIP_TITLE = 'DECK-TASKBAR';
const OVERFLOW_TITLE = 'DECK-TRAY-OVERFLOW';
const CDP_PORT = 9229;
const VK_ESCAPE = 0x1b;
const WS_EX_TOPMOST = 0x8;
const GWL_EXSTYLE = -20;
const WM_CANCELMODE = 0x001f;
const WM_KEYDOWN = 0x0100;
const WM_KEYUP = 0x0101;

const user32Local = win32.koffi.load('user32.dll');
const GetWindowLongW = user32Local.func('long __stdcall GetWindowLongW(uintptr_t hWnd, int nIndex)');
const GetWindowTextW = user32Local.func('int __stdcall GetWindowTextW(uintptr_t hWnd, uint16 *buf, int nMax)');
const AllowSetForegroundWindow = user32Local.func('bool __stdcall AllowSetForegroundWindow(uintptr_t dwProcId)');
const WindowFromPoint = user32Local.func('uintptr_t __stdcall WindowFromPoint(POINT pt)');
// —— 菜单项读取（P7 自家图标菜单链）：MN_GETHMENU 取 HMENU，逐项取文本与矩形 ——
const MN_GETHMENU = 0x01e1;
const SendMessageW = user32Local.func('intptr_t __stdcall SendMessageW(uintptr_t hWnd, uint32 msg, uintptr_t wp, intptr_t lp)');
const GetMenuItemCount = user32Local.func('int __stdcall GetMenuItemCount(uintptr_t hMenu)');
const GetMenuStringW = user32Local.func('int __stdcall GetMenuStringW(uintptr_t hMenu, uint32 uIDItem, uint16 *lpString, int cchMax, uint32 flags)');
const GetMenuItemRect = user32Local.func('bool __stdcall GetMenuItemRect(uintptr_t hMenu, uint32 uItem, _Out_ RECT *lpRect)');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 条带窗矩形（点外落点判定用；主流程建场后填） */
let stripRectBox = null;
/** 面板主进程 pid（自家窗口：点外落点与收净都要避开——点到自家卡会误触发面板动作） */
let ownPid = 0;
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const exeBase = (p) => path.basename(p || '').toLowerCase().replace(/\.exe$/, '');
const topmostBit = (hwnd) => (Number(GetWindowLongW(hwnd, GWL_EXSTYLE)) & WS_EX_TOPMOST) !== 0;
const titleOf = (hwnd) => {
  const buf = Buffer.alloc(1024);
  const n = GetWindowTextW(hwnd, buf, 512);
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(buf.readUInt16LE(i * 2));
  return s;
};

function readEvents(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

class EventTail {
  constructor(file) { this.file = file; this.seen = 0; }
  next() {
    const all = readEvents(this.file);
    const fresh = all.slice(this.seen);
    this.seen = all.length;
    return fresh;
  }
}

/** 目标 pid 在场的可见 #32768 菜单窗（标准 Win32 菜单窗） */
function menuWindowsOfPid(pid) {
  const out = [];
  let after = 0;
  for (;;) {
    const h = Number(win32.FindWindowExW(0, after, '#32768', null));
    if (!h) break;
    after = h;
    if (!win32.IsWindowVisible(h)) continue;
    if (win32.threadIdOf(h).pid === pid) out.push(h);
  }
  return out;
}

/** 全桌面在场的可见 #32768 菜单窗（清场核验） */
function visibleMenuWindows() {
  const out = [];
  let after = 0;
  for (;;) {
    const h = Number(win32.FindWindowExW(0, after, '#32768', null));
    if (!h) break;
    after = h;
    if (win32.IsWindowVisible(h)) out.push(h);
  }
  return out;
}

/** 目标 pid 的可见顶层窗（自绘菜单窗的发现面） */
function visibleWindowsOfPid(pid) {
  return win32.topLevelWindows().filter((h) => win32.threadIdOf(h).pid === pid);
}

/** 直投收菜（WM_CANCELMODE + ESC）：无前台菜单收不到键盘 ESC——确定性收场用 */
function cancelMenusOf(pid) {
  for (const h of menuWindowsOfPid(pid)) {
    win32.PostMessageW(h, WM_CANCELMODE, 0, 0);
    win32.PostMessageW(h, WM_KEYDOWN, VK_ESCAPE, 0);
    win32.PostMessageW(h, WM_KEYUP, VK_ESCAPE, 0);
  }
}

/** 菜单项集（#32768 标准菜单窗）：项文本 + 项屏幕矩形（P7 点项用） */
function menuItemsOf(menuHwnd) {
  const hmenu = Number(SendMessageW(menuHwnd, MN_GETHMENU, 0, 0));
  if (!hmenu) return [];
  const count = Number(GetMenuItemCount(hmenu));
  const items = [];
  for (let i = 0; i < count; i++) {
    const buf = Buffer.alloc(1024);
    const n = Number(GetMenuStringW(hmenu, i, buf, 256, 0x0400 /* MF_BYPOSITION */));
    const text = buf.toString('utf16le', 0, Math.max(0, n * 2));
    const rect = { left: 0, top: 0, right: 0, bottom: 0 };
    const ok = Boolean(GetMenuItemRect(hmenu, i, rect));
    items.push({ index: i, text, rect: ok ? rect : null });
  }
  return items;
}

/** 当拍前台窗身份（hwnd/pid/class/exe） */
function foregroundInfo() {
  const h = Number(win32.GetForegroundWindow());
  if (!h) return { hwnd: 0, pid: 0, class: '', exe: '' };
  const pid = win32.threadIdOf(h).pid;
  return { hwnd: h, pid, class: win32.className(h), exe: pid ? exeBase(win32.exeOfPid(pid)) : '' };
}

/** 菜单中心的命中测试（z 序事实）：命中菜单本身 = 菜单压在条带之上 */
function menuHitTest(presence) {
  const hwnd = (presence.menus[0] || presence.custom[0] || 0);
  if (!hwnd) return null;
  const r = win32.rectOf(hwnd);
  if (!r) return null;
  const cx = Math.round((r.left + r.right) / 2);
  const cy = Math.round((r.top + r.bottom) / 2);
  const hit = win32.windowFromPointRoot({ x: cx, y: cy });
  return { menuHwnd: hwnd, rect: r, hit, isMenu: hit === hwnd, cls: win32.className(hit) };
}

/** 菜单在场事实：#32768 标准菜单 + 目标 pid 新增可见顶层窗（自绘面板） */
function menuPresence(pid, baseWindows) {
  const menus = pid ? menuWindowsOfPid(pid) : [];
  const wins = pid ? visibleWindowsOfPid(pid) : [];
  const custom = wins.filter((w) => !(baseWindows || []).includes(w));
  return { menus, custom, customInfo: custom.map((w) => ({ hwnd: w, cls: win32.className(w) })), seen: menus.length > 0 || custom.length > 0 };
}

function capture(rect, name, outDir) {
  const out = path.join(outDir, name + '.png');
  const r = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(__dirname, '..', 'lib', 'capture.ps1'),
    '-Out', out, '-X', String(Math.max(0, rect.left)), '-Y', String(Math.max(0, rect.top)),
    '-W', String(rect.right - rect.left), '-H', String(rect.bottom - rect.top),
  ], { encoding: 'utf8', timeout: 20000 });
  return r.status === 0 && fs.existsSync(out) ? out : null;
}

async function waitFor(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(120);
  }
}

function launchPanel(eventsFile) {
  const electronExe = require('electron');
  const c = spawn(electronExe, ['.', '--panel-accept'], {
    cwd: APP_ROOT,
    env: { ...process.env, DECK_EVENT_LOG: eventsFile, DECK_LAG_SENTINEL: '1', DECK_CDP_PORT: String(CDP_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  c.stdout.on('data', () => {});
  let stderrTail = '';
  c.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-4000); });
  c.stderrTail = () => stderrTail;
  return c;
}

async function waitPanelReady(eventsFile, child) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const evs = readEvents(eventsFile);
    const boot = evs.filter((e) => e.type === 'boot').pop();
    const ready = evs.filter((e) => e.type === 'tray-host-ready').pop();
    if (boot && ready) return { panelPid: boot.pid };
    if (child.exitCode !== null) throw new Error('面板提前退出（code=' + child.exitCode + '）stderr尾：' + child.stderrTail());
    await sleep(200);
  }
  throw new Error('面板 25s 未就绪 stderr尾：' + child.stderrTail());
}

async function stopPanel(child) {
  if (child && isAlive(child.pid)) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  }
  await sleep(600);
  const RWM = user32Local.func('uint32 __stdcall RegisterWindowMessageW(const char16_t *lpString)');
  win32.PostMessageW(0xffff, RWM('TaskbarCreated'), 0, 0); // 交还广播：图标回注册 explorer
  await sleep(2000);
}

/** CDP 驱动指定标题的页面 */
async function cdpEval(title, expression) {
  const targets = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json')).json();
  const target = targets.find((t) => t.title === title && t.webSocketDebuggerUrl);
  if (!target) throw new Error('CDP 找不到页面目标: ' + title);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  try {
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP WebSocket 连接失败')); });
    const reply = await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('CDP evaluate 超时')), 10000);
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id === 1) { clearTimeout(timer); res(m); }
      };
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
    if (reply.error || (reply.result && reply.result.exceptionDetails)) {
      throw new Error('CDP evaluate 失败: ' + JSON.stringify(reply.error || reply.result.exceptionDetails));
    }
    return reply.result.result.value;
  } finally { ws.close(); }
}

/** 收净残留：Esc + 桌面点外 + 目标 pid 的残留菜单窗（#32768 与自绘面板都收） */
async function dismissAll(pids = []) {
  await dismissMenus();
  const pt = findOutsidePoint(stripRectBox);
  if (pt) { win32.clickPhys(pt.x, pt.y, 'left'); await sleep(600); }
  for (const pid of pids) {
    // 只发 WM_CANCELMODE：绝不发 WM_CLOSE——自家面板的窗口被关掉会连带退面板
    for (const h of menuWindowsOfPid(pid)) { win32.PostMessageW(h, WM_CANCELMODE, 0, 0); }
    if (pid && pid !== ownPid) {
      // 第三方应用的自绘菜单窗：WM_CANCELMODE 不一定收得掉（联想管家那类不认 Esc），
      // 再补一条 WM_CLOSE —— 只对第三方 pid 发（自家面板被关会连带退面板）
      for (const h of visibleWindowsOfPid(pid)) {
        win32.PostMessageW(h, WM_CANCELMODE, 0, 0);
        win32.PostMessageW(h, 0x0010 /* WM_CLOSE */, 0, 0);
      }
    }
  }
  await sleep(500);
}

async function dismissMenus() {
  for (let i = 0; i < 3; i++) {
    win32.tapKeys([VK_ESCAPE]);
    for (const h of visibleMenuWindows()) win32.PostMessageW(h, WM_CANCELMODE, 0, 0);
    await sleep(350);
    if (visibleMenuWindows().length === 0) return;
  }
}

/** 条带内某托盘图标的屏幕坐标（DOM rect → 物理坐标；scale = 物理宽/客户宽） */
async function iconScreenPoint(key, stripRect) {
  const expr = '(() => { const el = document.querySelector(\'.tb-tray-icon[data-key=' + JSON.stringify(key) + ']\');'
    + ' if (!el) return null; const r = el.getBoundingClientRect();'
    + ' return { x: r.x + r.width / 2, y: r.y + r.height / 2, iw: window.innerWidth }; })()';
  const geo = await cdpEval(STRIP_TITLE, expr);
  if (!geo) return null;
  const scale = (stripRect.right - stripRect.left) / geo.iw;
  return { x: Math.round(stripRect.left + geo.x * scale), y: Math.round(stripRect.top + geo.y * scale), scale };
}

/**, * 点外收起的落点：① 桌面（Progman/WorkerW）优先；② 退到真实任务栏的**空白处**——, * 取最深子窗判定（最深子窗 == 任务栏窗本身 ⇒ 空白背景，不是按钮），避开启动应用。
 */
function findOutsidePoint(stripRect) {
  const vs = win32.virtualScreen();
  const seen = new Set();
  for (let fy = 0.05; fy < 0.95; fy += 0.05) {
    for (let fx = 0.05; fx < 0.95; fx += 0.05) {
      const x = Math.round(vs.x + vs.w * fx);
      const y = Math.round(vs.y + vs.h * fy);
      const key = x + ':' + y;
      if (seen.has(key)) continue;
      seen.add(key);
      const root = win32.windowFromPointRoot({ x, y });
      if (!root) continue;
      if (ownPid && win32.threadIdOf(root).pid === ownPid) continue; // 自家窗（面板/条带/浮层）不算落点
      const cls = win32.className(root);
      if (cls === 'Progman' || cls === 'WorkerW') return { x, y, cls, kind: 'desktop' };
    }
  }
  // 任务栏空白：最深子窗 == 任务栏窗本身即空白背景
  for (const h of win32.topLevelWindows()) {
    if (win32.className(h) !== 'Shell_TrayWnd') continue;
    const r = win32.rectOf(h);
    if (!r) continue;
    for (const fx of [0.02, 0.06, 0.1, 0.4, 0.5, 0.6, 0.9]) {
      const x = Math.round(r.left + (r.right - r.left) * fx);
      const y = Math.round((r.top + r.bottom) / 2);
      if (stripRect && x >= stripRect.left && x <= stripRect.right && y >= stripRect.top && y <= stripRect.bottom) continue;
      const deep = Number(WindowFromPoint({ x, y }));
      if (!deep || deep !== h) continue; // 非空白（按钮/子窗）→ 跳过
      return { x, y, cls: 'Shell_TrayWnd', kind: 'taskbar-blank' };
    }
  }
  return null;
}
// —— 主流程 ——
(async () => {
  const outDir = process.argv.find((a) => a.startsWith('--out='))?.slice(6) || DEFAULT_OUT;
  fs.mkdirSync(outDir, { recursive: true });
  const hlog = [];
  const h = (ev) => { hlog.push({ t: Date.now(), ...ev }); console.log('[t363-forensics] ' + JSON.stringify(ev)); };
  h({ type: 'run-start', out: outDir });
  const eventsFile = path.join(outDir, 'panel-events.jsonl');
  try { fs.unlinkSync(eventsFile); } catch { /* 首轮不存在 */ }

  const configFile = path.join(APP_ROOT, 'config.json');
  const backup = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : null;
  const cfg = backup ? JSON.parse(backup) : {};
  fs.writeFileSync(configFile, JSON.stringify({ ...cfg, taskbar: { ...(cfg.taskbar ?? {}), enabled: true } }, null, 2) + '\n');
  const restoreConfig = () => {
    try {
      if (backup === null) { try { fs.unlinkSync(configFile); } catch { /* 本就无 */ } }
      else fs.writeFileSync(configFile, backup);
    } catch { /* 尽力 */ }
  };

  let child = null;
  let dirty = false;
  const findings = { p1: null, rounds: [], overflow: null, final: null };

  /**
   * 一轮产品链右键取证：真实鼠标右键 → 采样至「菜单出现」或 3.5s 超时。
   * 采样字段：前台窗身份 / 目标 pid 菜单在场 / 条带 TOPMOST 位。
   */
  async function fireAndObserve(tag, key, opts) {
    const stripHwnd = opts.stripHwnd;
    const watchPid = opts.watchPid;
    const tail = opts.tail;
    const since = Date.now();
    tail.next();
    const base = {
      fg: foregroundInfo(),
      topmost: stripHwnd ? topmostBit(stripHwnd) : null,
      windows: watchPid ? visibleWindowsOfPid(watchPid) : [],
    };
    // 光标先钉到落点（应用菜单按光标锚定；不钉则弹到物理鼠标残留位——t194 实证）
    win32.SetCursorPos(opts.clickAt.x, opts.clickAt.y);
    await sleep(400); // 条带热区 25ms 轮询开门
    win32.clickPhys(opts.clickAt.x, opts.clickAt.y, 'right');
    const samples = [];
    let menu = { menus: [], custom: [], seen: false };
    let fgAtMenu = null;
    let hitTest = null;
    const deadline = Date.now() + 3500;
    while (Date.now() < deadline) {
      const fg = foregroundInfo();
      const presence = menuPresence(watchPid, base.windows);
      samples.push({
        t: Date.now() - since,
        fgHwnd: fg.hwnd, fgPid: fg.pid, fgClass: fg.class, fgExe: fg.exe,
        menus: presence.menus.length, custom: presence.custom.length,
        topmost: stripHwnd ? topmostBit(stripHwnd) : null,
      });
      if (presence.seen && !menu.seen) {
        menu = presence;
        fgAtMenu = fg;
        hitTest = menuHitTest(presence);
        break; // 菜单已现——立即进入收起两测（Esc / 点外）
      }
      await sleep(60);
    }
    if (!menu.seen) menu = menuPresence(watchPid, base.windows);
    const events = tail.next().filter((e) => e.t >= since - 500);
    return {
      tag, key, since, base, samples, menu, fgAtMenu, hitTest,
      replay: events.find((e) => e.type === 'tray-replay' && e.key === key) || null,
      clickEv: events.find((e) => e.type === 'taskbar-tray-click' && e.key === key) || null,
      yieldEv: events.find((e) => e.type === 'taskbar-tray-yield') || null,
      restoredEv: events.find((e) => e.type === 'taskbar-tray-yield-restored') || null,
      suppressed: events.filter((e) => e.type === 'taskbar-topmost-suppressed').length,
      grantEv: events.find((e) => e.type === 'taskbar-tray-foreground-grant' && e.key === key) || null,
    };
  }

  /**
   * 合成回放臂（诊断）：harness 侧直投到图标属主窗（与产品链同一投递形态：PostMessage
   * + 同款负载布局），观察应用是否弹菜单 / 是否取前台。臂间先收净残留菜单。
   * 用它判别两件事：① 右键事件口径（WM_RBUTTONUP vs WM_CONTEXTMENU）；
   * ② 版本口径（v0 负载 vs v4 负载——本机有应用发过 NIM_SETVERSION，见语料取证）。
   */
  async function armRound(tag, key, replayEv, version, event, cursor) {
    const ownerPid = replayEv.pid;
    const hwnd = Number(replayEv.hwnd);
    const uid = Number(replayEv.uid);
    const message = Number(replayEv.message);
    const pack = version >= 4
      ? { wparam: ((cursor.y & 0xffff) << 16) | (cursor.x & 0xffff), lparam: ((uid & 0xffff) << 16) | event }
      : { wparam: uid >>> 0, lparam: event };
    await dismissMenus();
    await sleep(400);
    const base = ownerPid ? visibleWindowsOfPid(ownerPid) : [];
    const posted = Boolean(win32.PostMessageW(hwnd, message, pack.wparam, pack.lparam));
    const deadline = Date.now() + 2500;
    let pres = menuPresence(ownerPid, base);
    while (Date.now() < deadline && !pres.seen) {
      await sleep(60);
      pres = menuPresence(ownerPid, base);
    }
    const fg = foregroundInfo();
    const res = { tag, key, version, event, posted, ...pack, menuSeen: pres.seen, menus: pres.menus, custom: pres.custom, fgPid: fg.pid, fgClass: fg.class, fgExe: fg.exe };
    cancelMenusOf(ownerPid);
    return res;
  }

  /**
   * 让位恢复等拍：等 taskbar-tray-yield-restored 事件落地（上限 13s，超时上限 10s + 余量），
   * 记录恢复原因与恢复后条带 TOPMOST 位（AC：任何路径都不许条带永久停在非置顶态）。
   */
  async function waitRestore(stripHwnd, since, timeoutMs = 13000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ev = readEvents(eventsFile).filter((e) => e.type === 'taskbar-tray-yield-restored' && e.t >= since).pop();
      if (ev) {
        await sleep(400);
        return { restored: { reason: ev.reason, pid: ev.pid, menuSeen: ev.menuSeen, elapsedMs: ev.elapsedMs, t: ev.t }, topmostAfter: stripHwnd ? topmostBit(stripHwnd) : null };
      }
      await sleep(150);
    }
    return { restored: null, topmostAfter: stripHwnd ? topmostBit(stripHwnd) : null, timedOut: true };
  }

  /** Esc 收起测：全局 ESC 键（正常系统行为走前台窗；菜单非前台则收不掉） */
  async function testEscDismiss(watchPid, baseWindows) {
    const before = { menus: menuWindowsOfPid(watchPid), fg: foregroundInfo() };
    win32.tapKeys([VK_ESCAPE]);
    await sleep(1000);
    const after = { menus: menuWindowsOfPid(watchPid), fg: foregroundInfo() };
    const customLeft = visibleWindowsOfPid(watchPid).filter((w) => !baseWindows.includes(w));
    return {
      before, after,
      menusBefore: before.menus.length, menusAfter: after.menus.length,
      customLeft: customLeft.length,
      gone: after.menus.length === 0 && customLeft.length === 0,
      fgWasMenu: before.menus.includes(before.fg.hwnd),
    };
  }

  /** 点外收起测：点桌面空白（正常系统行为：菜单应自收） */
  async function testOutsideDismiss(watchPid, baseWindows) {
    const before = { menus: menuWindowsOfPid(watchPid), fg: foregroundInfo() };
    const pt = findOutsidePoint(stripRectBox);
    if (!pt) return { skipped: 'no-desktop-point', menusBefore: before.menus.length };
    win32.clickPhys(pt.x, pt.y, 'left');
    await sleep(1000);
    const after = { menus: menuWindowsOfPid(watchPid), fg: foregroundInfo() };
    const customLeft = visibleWindowsOfPid(watchPid).filter((w) => !baseWindows.includes(w));
    return {
      point: pt, before, after,
      menusBefore: before.menus.length, menusAfter: after.menus.length,
      customLeft: customLeft.length,
      gone: after.menus.length === 0 && customLeft.length === 0,
      fgWasMenu: before.menus.includes(before.fg.hwnd),
    };
  }

  try {
    // —— P0 拉起 ——
    child = launchPanel(eventsFile);
    const st = await waitPanelReady(eventsFile, child);
    ownPid = st.panelPid;
    h({ type: 'P0-ready', panelPid: st.panelPid });
    await sleep(6000); // TaskbarCreated 收编波次 + 条带建窗稳定拍

    const tail = new EventTail(eventsFile);
    tail.next();
    const strip = win32.topLevelWindows().find((w) =>
      win32.threadIdOf(w).pid === st.panelPid && titleOf(w) === STRIP_TITLE) || null;
    if (!strip) throw new Error('条带窗不在场');
    h({ type: 'P1-strip', hwnd: strip, topmost: topmostBit(strip) });

    // —— P1 名单解析 ——
    const state = await cdpEval(STRIP_TITLE, "window.deck.bridge.invoke('taskbar/get-state', {})");
    const roster = [];
    for (const entry of (state && state.tray) || []) {
      const hwndNum = Number((entry.key.match(/^(\d+):/) || [])[1] || 0);
      const pid = hwndNum ? win32.threadIdOf(hwndNum).pid : 0;
      const exe = pid ? exeBase(win32.exeOfPid(pid)) : '';
      roster.push({ key: entry.key, hwnd: hwndNum, pid, exe, tooltip: entry.tooltip, own: pid === st.panelPid });
    }
    h({ type: 'P1-roster', count: roster.length, own: roster.filter((r) => r.own).map((r) => r.key), exes: [...new Set(roster.map((r) => r.exe))] });

    // ASFW 放行权对照探针：harness 进程既非前台也非末次输入接收者 ⇒ 放行应失败
    const probeTarget = roster.find((r) => r.pid && !r.own);
    const asfwFromHarness = probeTarget ? Boolean(AllowSetForegroundWindow(probeTarget.pid)) : null;
    h({ type: 'P1-asfw-probe', targetPid: probeTarget ? probeTarget.pid : null, asfwFromHarness });
    findings.p1 = { stripHwnd: strip, stripTopmost: topmostBit(strip), roster, asfwFromHarness };

    // 候选：自家图标（必测样本）+ 第三方（优先已知菜单友好名单）
    // 优先名单：powertoys = 标准 #32768 菜单样本；lenovotray = 自绘托盘面板样本（#163 取证坐实）；
    // onedrive/steam = 另两类（自绘面板 / 私有实现）；其余按需
    const PREF = ['powertoys', 'lenovotray', 'onedrive', 'steam', 'snipaste', 'weixin', 'ticktick', 'shadowsocks', 'feishu', 'hipstray'];
    const third = roster.filter((r) => r.pid && !r.own && r.exe && r.exe !== 'explorer' && r.exe !== 'electron');
    third.sort((a, b) => {
      const ra = PREF.indexOf(a.exe), rb = PREF.indexOf(b.exe);
      return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb);
    });
    const own = roster.filter((r) => r.own);
    const candidates = [...own, ...third].slice(0, 5);
    h({ type: 'P1-candidates', candidates: candidates.map((c) => ({ exe: c.exe, pid: c.pid, own: c.own, tooltip: c.tooltip, key: c.key })) });
    if (!candidates.length) throw new Error('无托盘样本可验（机器态域）');

    // —— P2 产品链真实右键轮 ——
    // 档位临时开到 all：机器在册托盘多于条带档位，尾部图标不在条带 DOM 内（红轮先例：
    // 尾部注册的图标进溢出浮层）。本轮要逐条真实右键，取证面必须覆盖到它们。
    const state0 = await cdpEval(STRIP_TITLE, "window.deck.bridge.invoke('taskbar/get-state', {})");
    const prevLimit = (state0 && state0.trayOverflowLimit) || 5;
    await cdpEval(STRIP_TITLE, "window.deck.bridge.invoke('taskbar/set-tray-overflow-limit', { limit: 'all' })");
    await sleep(1500);
    const stripRect = win32.rectOf(strip);
    stripRectBox = stripRect;
    // —— P7 自家图标菜单链（工单363 必测项）——
    // 真实右击**栏内**自家图标（产品链）→ 既有「对话窗／退出面板」菜单弹出 → 项集与
    // 项行为（点「对话窗」照常开对话窗）→ 收起 → 条带恢复置顶、面板不抢前台
    //（非激活纪律复原）。档位此时是 all：自家图标在条带 DOM 内。
    const ownCand = candidates.find((c) => c.own);
    if (ownCand) {
      await dismissAll(candidates.map((c) => c.pid));
      const pt7 = await iconScreenPoint(ownCand.key, stripRect);
      if (!pt7) {
        h({ type: 'P7-skip', reason: '条带页无自家图标 DOM' });
      } else {
        // 条带几何在档位重拆后仍在安定：最多三轮重取位置重试（以回放事件到位为准）
        let obs7 = { replay: null, grantEv: null, since: Date.now() };
        for (let attempt = 0; attempt < 3; attempt++) {
          await dismissAll(candidates.map((c) => c.pid));
          await sleep(1200);
          const ptTry = await iconScreenPoint(ownCand.key, stripRect);
          if (!ptTry) break;
          obs7 = await fireAndObserve('P7:own', ownCand.key, {
            stripHwnd: strip, watchPid: ownPid, clickAt: ptTry, tail,
          });
          if (obs7.replay) break;
        }
        if (!obs7) { h({ type: 'P7-skip', reason: 'no-observation' }); }
        const menus7 = menuWindowsOfPid(ownPid);
        const items7 = menus7.length ? menuItemsOf(menus7[0]) : [];
        h({ type: 'P7-menu', replay: obs7.replay, grantEv: obs7.grantEv, menus: menus7, items: items7, fg: foregroundInfo() });
        const convItem = items7.find((i) => i.text.includes('对话窗'));
        const quitItem = items7.find((i) => i.text.includes('退出面板'));
        let convOpened = null;
        let actBy = null;
        if (convItem && convItem.rect) {
          // 原生菜单（#32768）：点项矩形
          const cx = Math.round((convItem.rect.left + convItem.rect.right) / 2);
          const cy = Math.round((convItem.rect.top + convItem.rect.bottom) / 2);
          win32.clickPhys(cx, cy, 'left');
          actBy = 'click-item';
        } else {
          // Chromium 自绘菜单（无 #32768 菜单窗）：键盘路径——Down 选中首项（对话窗）、
          // Enter 触发。菜单既已持前台（见 fgAtMenu），键盘落在菜单上。
          win32.tapKeys([0x28 /* VK_DOWN */]);
          await sleep(300);
          win32.tapKeys([0x0d /* VK_RETURN */]);
          actBy = 'keyboard-down-enter';
        }
        await sleep(1800);
        const wins = visibleWindowsOfPid(ownPid).map((hw) => ({ hwnd: hw, cls: win32.className(hw), title: titleOf(hw) }));
        convOpened = wins.find((w) => w.title === 'DECK-CONVERSATION') || null;
        h({ type: 'P7-conversation', actBy, clicked: convItem && convItem.text, convOpened, wins });
        const fgBeforeEsc = foregroundInfo();
        win32.tapKeys([VK_ESCAPE]);
        await sleep(900);
        const menusAfter = menuWindowsOfPid(ownPid);
        const fgAfter = foregroundInfo();
        const restore7 = await waitRestore(strip, obs7.since);
        h({ type: 'P7-close', menusAfter: menusAfter.length, fgBeforeEsc, fgAfter, restore: restore7, stripTopmost: strip ? topmostBit(strip) : null });
        findings.own = {
          replay: obs7.replay, grantEv: obs7.grantEv, menus: menus7, items: items7,
          convItem: convItem && convItem.text, quitItem: quitItem && quitItem.text,
          convOpened, menusAfterEsc: menusAfter.length, fgBeforeEsc, fgAfter, restore: restore7,
        };
      }
    }
    for (const cand of candidates) {
      await dismissAll(candidates.map((c) => c.pid)); // 前一轮残留菜单会挡住条带点击
      const pt = await iconScreenPoint(cand.key, stripRect);
      if (!pt) { h({ type: 'P2-skip', key: cand.key, reason: '条带页无该图标 DOM' }); continue; }
      const obs = await fireAndObserve('P2:' + cand.exe, cand.key, {
        stripHwnd: strip, watchPid: cand.pid, clickAt: pt, tail,
      });
      const entry = { exe: cand.exe, pid: cand.pid, own: cand.own, key: cand.key, tooltip: cand.tooltip };
      h({
        type: 'P2-round', ...entry,
        replay: obs.replay, clickEv: obs.clickEv, grantEv: obs.grantEv,
        yieldEv: obs.yieldEv, restoredEv: obs.restoredEv,
        fgBefore: obs.base.fg, fgAtMenu: obs.fgAtMenu,
        menuSeen: obs.menu.seen, menus: obs.menu.menus, custom: obs.menu.custom,
        topmostSeen: [...new Set(obs.samples.map((s) => s.topmost))],
        fgPids: [...new Set(obs.samples.map((s) => s.fgPid))],
      });
      const rec = { entry, obs };
      if (obs.menu.seen) {
        // —— Esc 收起 ——
        const esc = await testEscDismiss(cand.pid, obs.base.windows);
        rec.esc = esc;
        h({ type: 'P2-esc', exe: cand.exe, ...esc });
        cancelMenusOf(cand.pid);
        await sleep(500);
        // —— 点外收起（复现一轮） ——
        const obs2 = await fireAndObserve('P2b:' + cand.exe, cand.key, {
          stripHwnd: strip, watchPid: cand.pid, clickAt: pt, tail,
        });
        rec.obs2 = obs2;
        const outside = await testOutsideDismiss(cand.pid, obs2.base.windows);
        rec.outside = outside;
        h({ type: 'P2-outside', exe: cand.exe, ...outside });
        cancelMenusOf(cand.pid);
      }
      // 让位恢复等拍（AC：条带不得永久停在非置顶态）
      rec.restore = await waitRestore(strip, rec.obs2 ? rec.obs2.since : rec.obs.since);
      h({ type: 'P2-restore', exe: cand.exe, ...rec.restore });
      findings.rounds.push(rec);
      await dismissAll([cand.pid]);
      await sleep(400);
    }
    // —— P5 负载臂对照（诊断）：右键事件口径 + 版本口径 ——
    // 真实右键走产品链（已含主进程放行）→ 随后 harness 侧直投其余臂，同一属主窗、
    // 同款投递形态；每臂观察「菜单是否出现 / 前台是否转移」。
    const ARM_EXES = ['electron', 'onedrive', 'powertoys', 'lenovotray'];
    for (const cand of candidates.filter((c) => ARM_EXES.includes(c.exe))) {
      const pt = await iconScreenPoint(cand.key, stripRect);
      if (!pt) { h({ type: 'P5-skip', exe: cand.exe, reason: 'no-icon-dom' }); continue; }
      await dismissAll(candidates.map((c) => c.pid));
      const pt2 = await iconScreenPoint(cand.key, stripRect);
      const obs = await fireAndObserve('P5:' + cand.exe, cand.key, {
        stripHwnd: strip, watchPid: cand.pid, clickAt: pt2 || pt, tail,
      });
      const ev = obs.replay;
      if (!ev) { h({ type: 'P5-skip', exe: cand.exe, reason: 'no-replay-event' }); continue; }
      const arms = [];
      for (const arm of [
        { name: 'v0-rbutton', version: 0, event: 0x0205 },
        { name: 'v0-ctxmenu', version: 0, event: 0x007b },
        { name: 'v4-ctxmenu', version: 4, event: 0x007b },
        { name: 'v4-rbutton', version: 4, event: 0x0205 },
      ]) {
        const r = await armRound('P5:' + cand.exe, cand.key, ev, arm.version, arm.event, pt);
        arms.push({ arm: arm.name, ...r });
        h({ type: 'P5-arm', exe: cand.exe, ...r });
        await sleep(400);
      }
      findings.arms = findings.arms || [];
      findings.arms.push({ exe: cand.exe, key: cand.key, replay: ev, arms });
    }


    await cdpEval(STRIP_TITLE, "window.deck.bridge.invoke('taskbar/set-tray-overflow-limit', { limit: " + JSON.stringify(prevLimit) + " })");
    await sleep(800);

    // —— P3 溢出入口轮（两条入口同链对照）：浮层内真实右键同一图标 ——
    const overflowTarget = findings.rounds.find((r) => r.obs && r.obs.menu.seen) || findings.rounds[0];
    if (overflowTarget) {
      const key = overflowTarget.entry.key;
      const state2 = await cdpEval(STRIP_TITLE, "window.deck.bridge.invoke('taskbar/get-state', {})");
      const limit2 = (state2 && state2.trayOverflowLimit) || 5;
      const trayList = (state2 && state2.tray) || [];
      const candPids = new Map(findings.rounds.map((r) => [r.entry.key, r.entry.pid]));
      const ovEntry = trayList.slice(typeof limit2 === 'number' ? limit2 : 0).find((t) => candPids.has(t.key)) || null;
      const key2 = ovEntry ? ovEntry.key : key;
      const pid2 = ovEntry ? candPids.get(key2) : overflowTarget.entry.pid;
      const ov = win32.topLevelWindows().find((w) => titleOf(w) === OVERFLOW_TITLE) || null;
      h({ type: 'P3-overflow', key: key2, window: ov, limit: limit2, trayCount: trayList.length });
      findings.overflow = { key: key2, pid: pid2, window: ov, limit: limit2 };
      // 开层：条带页「⋯」真实左键（宿主按光标位置弹浮层并取焦）
      const moreExpr = '(() => { const el = document.querySelector(\'[data-id=\\"tray-overflow\\"]\');'
        + ' if (!el) return null; const r = el.getBoundingClientRect();'
        + ' return { x: r.x + r.width / 2, y: r.y + r.height / 2, iw: window.innerWidth }; })()';
      const more = await cdpEval(STRIP_TITLE, moreExpr);
      if (more) {
        const mscale = (stripRect.right - stripRect.left) / more.iw;
        win32.SetCursorPos(Math.round(stripRect.left + more.x * mscale), Math.round(stripRect.top + more.y * mscale));
        await sleep(300);
        win32.clickPhys(Math.round(stripRect.left + more.x * mscale), Math.round(stripRect.top + more.y * mscale), 'left');
      }
      const ovWin = await waitFor(() => win32.topLevelWindows().find((w) => titleOf(w) === OVERFLOW_TITLE) || null, 8000);
      h({ type: 'P3-opened', window: ovWin });
      if (ovWin) {
        const rowExpr = '(() => { const el = document.querySelector(\'.ov-row[data-key=' + JSON.stringify(key2) + ']\');'
          + ' if (!el) return null; const r = el.getBoundingClientRect();'
          + ' return { x: r.x + r.width / 2, y: r.y + r.height / 2, iw: window.innerWidth }; })()';
        let row = null;
        for (let i = 0; i < 10 && !row; i++) {
          try { row = await cdpEval(OVERFLOW_TITLE, rowExpr); } catch { /* 浮层页未就位 */ }
          if (!row) await sleep(400);
        }
        if (row) {
          const ovRect = win32.rectOf(ovWin);
          const osc = (ovRect.right - ovRect.left) / row.iw;
          const clickAt = { x: Math.round(ovRect.left + row.x * osc), y: Math.round(ovRect.top + row.y * osc) };
          const obs = await fireAndObserve('P3:overflow', key2, {
            stripHwnd: strip, watchPid: pid2, clickAt, tail,
          });
          h({ type: 'P3-round', key: key2, replay: obs.replay, clickEv: obs.clickEv, grantEv: obs.grantEv, menuSeen: obs.menu.seen, menus: obs.menu.menus, custom: obs.menu.custom, fgAtMenu: obs.fgAtMenu, fgBefore: obs.base.fg, hitTest: obs.hitTest });
          findings.overflow = { ...findings.overflow, round: obs };
          cancelMenusOf(pid2);
        } else {
          h({ type: 'P3-no-row', key: key2 });
        }
      }
    }

    // —— P4 收尾核验（先等最后一条让位恢复落地，再核条带置顶态） ——
    const lastRestore = await waitRestore(strip, Date.now() - 15000);
    h({ type: 'P4-last-restore', ...lastRestore });
    const samplePids = [...new Set(findings.rounds.map((r) => r.entry.pid).filter(Boolean))];
    findings.final = {
      stripTopmost: strip && win32.IsWindow(strip) ? topmostBit(strip) : null,
      leftoverMenus: samplePids.reduce((n, pid) => n + menuWindowsOfPid(pid).length, 0),
    };
    h({ type: 'final', ...findings.final });
    if (!findings.final.stripTopmost || findings.final.leftoverMenus > 0) dirty = true;
  } catch (e) {
    dirty = true;
    h({ type: 'fatal', message: e && e.message, stack: (e && e.stack || '').split('\n').slice(0, 4).join(' | ') });
  } finally {
    await dismissMenus();
    await stopPanel(child);
    restoreConfig();
    const timeline = readEvents(eventsFile).filter((e) =>
      ['taskbar-tray-yield', 'taskbar-tray-yield-restored', 'taskbar-topmost-suppressed',
        'taskbar-topmost', 'tray-replay', 'tray-replay-miss', 'taskbar-tray-click',
        'taskbar-tray-click-result', 'taskbar-tray-foreground-grant'].includes(e.type));
    fs.writeFileSync(path.join(outDir, 'timeline.json'), JSON.stringify(timeline, null, 2));
    fs.writeFileSync(path.join(outDir, 'findings.json'), JSON.stringify({ findings, hlog }, null, 2));
    const leftovers = win32.topLevelWindows().filter((w) => titleOf(w) === STRIP_TITLE);
    if (leftovers.length) { dirty = true; h({ type: 'leftover-strips', count: leftovers.length }); }
    h({ type: 'run-end', dirty });
    process.exit(dirty ? 3 : 0);
  }
})();
