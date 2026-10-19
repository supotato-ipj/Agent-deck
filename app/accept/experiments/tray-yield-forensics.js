'use strict';
// 工单194 托盘右键让位人工验收取证 harness（ADR-0013「托盘自带菜单让位」）：
// native 菜单 z 序难以稳定自动断言（票面口径）——本工具按**事件时序 + 视图事实**留证：
//   P0 拉起     --panel-accept + DECK_EVENT_LOG/CDP，taskbar.enabled 覆写 true（结束还原）
//   P1 基线     条带窗在场且 WS_EX_TOPMOST=1；选已登记第三方托盘样本
//   P2 让位轮   产品链路右键回放（CDP invoke taskbar/tray-click）：
//               · 条带 TOPMOST 位翻转（让位期 0 → 恢复后 1，视图事实）
//               · 目标 pid 的 #32768 菜单窗在场 + 菜单矩形实拍（PNG 留证）+ 菜单内
//                 点命中测试（z 序在条带之上的视图佐证）
//               · 让位期间 keepalive 重申点被压制（taskbar-topmost-suppressed 事件在场）
//               · 2.5s 趁菜单在场实拍后敲 ESC → restored reason=menu-closed（侦测①路）
//   P3 超时轮   无菜单目标（自种探针图标，属主=条带窗自身——回放投递必达但不弹菜单）
//               右键回放 → 三路侦测全盲 → restored reason=timeout elapsed≈10s
//               （盲区兜底不死锁让位）
//   P3b 重申点  让位窗口中段：全屏探针顶前台→条带让位→探针退场→恢复拍被闸门压制
//               （fullscreen-yield-lifted 存证 + 可见但 topmost=0 视图事实）；光标划入
//               条带热区再离开→热区离开重申拍被压制（hotzone-leave 存证）
//   P4 左键回归 左键回放不触发让位（taskbar-tray-yield 缺席）
//   P5 时间线   事件日志按类型抽取落盘（让位/恢复时序存证样本，报告引用）
// 纪律：产品代码零改动；取证工具不进 manifest 不产 verdict 电池；退出码 0=完成 3=机器脏。
// 碰真桌面（真面板+CDP+键鼠注入），一律经 accept-guard 托管。
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const win32 = require('../lib/win32');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_OUT = 'D:\\test-folder\\.agent-notes\\t194-tray-yield';
const STRIP_TITLE = 'DECK-TASKBAR';
const CDP_PORT = 9229;
const VK_ESCAPE = 0x1b;
const WS_EX_TOPMOST = 0x8;
const GWL_EXSTYLE = -20;
const WM_CANCELMODE = 0x001f; // 直投菜单窗收菜单（无前台菜单收不到键盘 ESC，r4 实证）
const WM_KEYDOWN = 0x0100;
const WM_KEYUP = 0x0101;

const user32Local = win32.koffi.load('user32.dll');
const shell32Local = win32.koffi.load('shell32.dll');
const GetWindowLongW = user32Local.func('long __stdcall GetWindowLongW(uintptr_t hWnd, int nIndex)');
const GetWindowTextW = user32Local.func('int __stdcall GetWindowTextW(uintptr_t hWnd, uint16 *buf, int nMax)');
const ShellNotifyIconW = shell32Local.func('bool __stdcall Shell_NotifyIconW(uint32 dwMessage, void *nid)');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

/** 目标 pid 在场的可见 #32768 菜单窗（win32.menuWindowsOfPid 同口径，t163 取证工具先例） */
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
/** 全桌面在场的可见 #32768 菜单窗（清场核验用） */
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
/** 直投菜单窗收菜（WM_CANCELMODE+ESC）：无前台菜单收不到全局键盘，tapKeys 收不掉 */
function cancelMenusOf(pid) {
  for (const h of menuWindowsOfPid(pid)) {
    win32.PostMessageW(h, WM_CANCELMODE, 0, 0);
    win32.PostMessageW(h, WM_KEYDOWN, VK_ESCAPE, 0);
    win32.PostMessageW(h, WM_KEYUP, VK_ESCAPE, 0);
  }
}
function foregroundPid() {
  const h = Number(win32.GetForegroundWindow());
  return h ? win32.threadIdOf(h).pid : 0;
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

// —— P3b 全屏探针（taskbar-appbar 电池 P4 同款形态，本 harness 是裸 node 故走子进程）：
//    独立 Electron 全屏无边框窗，让位轮中段顶前台 → 条带全屏让位（hide），探针一死
//    → 恢复拍 showInactive+重申置顶——让位闸门在场时该拍必须被压制（票面第三处
//    重申点的在场证据）。 ——
const FS_PROBE_TITLE = 'DECK-T194-FULLSCREEN';
function writeFullscreenProbe(outDir) {
  const file = path.join(outDir, 'fs-probe.js');
  fs.writeFileSync(file, [
    "const { app, BrowserWindow } = require('electron');",
    'app.whenReady().then(() => {',
    "  const win = new BrowserWindow({ fullscreen: true, frame: false, title: " + JSON.stringify(FS_PROBE_TITLE) + ", backgroundColor: '#101820' });",
    "  win.loadURL('about:blank');",
    '  win.show();',
    '});',
  ].join('\n'));
  return file;
}
function spawnFullscreenProbe(outDir) {
  const child = spawn(require('electron'), [writeFullscreenProbe(outDir)], {
    cwd: APP_ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let err = '';
  child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
  child.stderrTail = () => err;
  return child;
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
/** 强制前台（前台锁下普通手段静默失败，taskbar-appbar 同款：AttachThreadInput 链入再置前） */
function forceForegroundH(hwnd) {
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
    if (child.exitCode !== null) throw new Error(`面板提前退出（code=${child.exitCode}）stderr尾：${child.stderrTail()}`);
    await sleep(200);
  }
  throw new Error(`面板 25s 未就绪 stderr尾：${child.stderrTail()}`);
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

/** CDP 驱动指定标题的页面（t142/t163 同款：原生 WebSocket + Runtime.evaluate） */
async function cdpEval(title, expression) {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
  const target = targets.find((t) => t.title === title && t.webSocketDebuggerUrl);
  if (!target) throw new Error(`CDP 找不到页面目标: ${title}`);
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
      throw new Error(`CDP evaluate 失败: ${JSON.stringify(reply.error || reply.result.exceptionDetails)}`);
    }
    return reply.result.result.value;
  } finally { ws.close(); }
}

async function dismissMenus() {
  // 双管齐下：全局键盘 ESC（前台菜单常规路）+ 直投 WM_CANCELMODE（无前台菜单兜底，
  // r4 实证 tapKeys 收不掉 → 残留菜单 dirty 退场）；最多三轮，逐轮复查
  for (let i = 0; i < 3; i++) {
    win32.tapKeys([VK_ESCAPE]);
    for (const h of visibleMenuWindows()) win32.PostMessageW(h, WM_CANCELMODE, 0, 0);
    await sleep(350);
    if (visibleMenuWindows().length === 0) return;
  }
}

// —— 让位轮观测：右键回放 → 每 100ms 采样视图事实（TOPMOST 位/可见/菜单窗/前台），
//    直到恢复事件落地后再续 500ms 收尾拍。返回逐拍样本 + 结构化事件（时序存证样本）。
//    窗口内事件全程累积（yield/suppressed/replay 都要在轮内记账，只捞尾拍会漏光）；
//    opts.plan：让位窗口内的定时动作表（{ atMs, fn }，按到点序各执行一次）——P2 趁菜单
//    在场实拍后敲 ESC（三路侦测第①路 menu-closed）；P3b 中段起全屏探针/热区划过
//    （重申点在场驱证）；不配则放任到超时上限（P3 盲区口径）。 ——
async function yieldRound(tag, key, stripHwnd, tail, opts = {}) {
  const since = Date.now();
  tail.next(); // 排空既有
  const samples = [];
  const seen = [];
  const plan = (opts.plan || []).slice().sort((a, b) => a.atMs - b.atMs);
  const planDone = [];
  let restored = null;
  let restoredAt = 0;
  // 光标先落到托盘区（真实右键的常态：光标就在图标上）——应用菜单按光标点锚定，
  // 不钉就弹到物理鼠标残留位置（r2/r3 实证弹到屏左上，与条带零重叠，覆盖不到缺陷面）
  if (opts.cursorAt) win32.SetCursorPos(opts.cursorAt.x, opts.cursorAt.y);
  void cdpEval(STRIP_TITLE,
    `window.deck.bridge.invoke('taskbar/tray-click', { key: ${JSON.stringify(key)}, button: 'right' })`).catch(() => null);
  const deadline = Date.now() + 12000; // 超时上限 10s + 余量
  while (Date.now() < deadline) {
    if (stripHwnd && !win32.IsWindow(stripHwnd)) break;
    const t = Date.now() - since;
    samples.push({
      t,
      topmost: stripHwnd ? topmostBit(stripHwnd) : null,
      visible: win32.IsWindow(stripHwnd) ? win32.IsWindowVisible(stripHwnd) : null,
      menus: opts.watchPid ? menuWindowsOfPid(opts.watchPid).length : null,
      fgPid: foregroundPid(),
    });
    while (plan.length && t >= plan[0].atMs) {
      const step = plan.shift();
      try {
        await step.fn();
        planDone.push({ atMs: step.atMs, ok: true });
      } catch (e) {
        planDone.push({ atMs: step.atMs, ok: false, error: e && e.message });
      }
    }
    for (const e of tail.next()) {
      seen.push(e);
      if (e.type === 'taskbar-tray-yield-restored') { restored = e; restoredAt = restoredAt || e.t; }
    }
    if (restoredAt && Date.now() - restoredAt > 500) break; // 恢复后续 500ms 收尾拍
    await sleep(100);
  }
  seen.push(...tail.next());
  const fresh = seen.filter((e) => e.t >= since - 1000);
  const events = {
    yield: fresh.find((e) => e.type === 'taskbar-tray-yield') || null,
    suppressed: fresh.filter((e) => e.type === 'taskbar-topmost-suppressed').map((e) => ({ t: e.t - since, reason: e.reason })),
    replay: fresh.find((e) => e.type === 'tray-replay' && e.key === key) || null,
    restored: restored ? { t: restored.t - since, reason: restored.reason, pid: restored.pid, menuSeen: restored.menuSeen, elapsedMs: restored.elapsedMs } : null,
  };
  return { tag, key, since, samples, events, planDone };
}

// —— 主流程 ——
(async () => {
  const outDir = process.argv.find((a) => a.startsWith('--out='))?.slice(6) || DEFAULT_OUT;
  fs.mkdirSync(outDir, { recursive: true });
  const hlog = [];
  const h = (ev) => { hlog.push({ t: Date.now(), ...ev }); console.log(`[t194-forensics] ${JSON.stringify(ev)}`); };
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
  let probeNid = null;
  const findings = { p1: null, p2: null, p3: null, p3b: null, p4: null, finalStripTopmost: null, leftoverMenus: null };
  try {
    // —— P0 拉起 ——
    child = launchPanel(eventsFile);
    const st = await waitPanelReady(eventsFile, child);
    h({ type: 'P0-ready', panelPid: st.panelPid });
    await sleep(6000); // TaskbarCreated 收编波次 + 条带建窗稳定拍

    const tail = new EventTail(eventsFile);
    tail.next();
    const strip = win32.topLevelWindows().find((w) =>
      win32.threadIdOf(w).pid === st.panelPid && titleOf(w) === STRIP_TITLE) || null;
    if (!strip || !topmostBit(strip)) throw new Error(`条带基线不可判：hwnd=${strip} topmost=${strip ? topmostBit(strip) : 'n/a'}`);
    h({ type: 'P1-strip-baseline', hwnd: strip, topmost: topmostBit(strip) });
    findings.p1 = { stripHwnd: strip, topmostBaseline: topmostBit(strip) };

    // 样本选择：栏内名单第三方（优先已知 #32768 菜单友好的 exe）
    const state = await cdpEval(STRIP_TITLE, `window.deck.bridge.invoke('taskbar/get-state', {})`);
    const P2_PREF = ['snipaste', 'powertoys', 'onedrive', 'steam', 'weixin', 'ticktick', 'shadowsocks', 'lenovotray'];
    const candidates = [];
    for (const entry of state.tray || []) {
      const hwndNum = Number((entry.key.match(/^(\d+):/) || [])[1] || 0);
      const pid = hwndNum ? win32.threadIdOf(hwndNum).pid : 0;
      const exe = pid ? exeBase(win32.exeOfPid(pid)) : '';
      if (exe && !['electron', 'explorer'].includes(exe)) candidates.push({ key: entry.key, pid, exe, tooltip: entry.tooltip });
    }
    candidates.sort((a, b) => {
      const ra = P2_PREF.indexOf(a.exe), rb = P2_PREF.indexOf(b.exe);
      return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb);
    });
    h({ type: 'P1-candidates', candidates: candidates.slice(0, 8).map((c) => ({ exe: c.exe, pid: c.pid, tooltip: c.tooltip })) });
    if (!candidates.length) throw new Error('无第三方托盘样本可验（机器态域）');

    // —— P2 让位轮：逐候选试到第一个「右键后目标 pid 出 #32768 菜单」的样本。
    //    cursorAt：光标钉到条带托盘区（菜单按光标锚定，与条带重叠才是缺陷场景位形，
    //    r2/r3 实证不钉则弹到物理鼠标残留位）。plan：菜单在场读 2.5s 后先命中测试
    //    （快、权威的 z 序事实）再实拍留证（条带尚在普通带——菜单压得过的直接视图
    //    佐证），然后直投收菜 → 三路侦测第①路 menu-closed 恢复。 ——
    let p2 = null;
    const stripRect = win32.rectOf(strip);
    const trayPoint = { x: stripRect.right - 200, y: Math.round((stripRect.top + stripRect.bottom) / 2) };
    for (const cand of candidates.slice(0, 4)) {
      let menuShot = null, hitTest = null;
      const snapMenu = () => {
        const menus = menuWindowsOfPid(cand.pid);
        if (!menus.length) return;
        const mr = win32.rectOf(menus[0]);
        const hit = win32.windowFromPointRoot({ x: Math.round((mr.left + mr.right) / 2), y: Math.round((mr.top + mr.bottom) / 2) });
        hitTest = { hwnd: hit, isMenu: menus.includes(hit) };
        const sr = win32.rectOf(strip);
        menuShot = capture({
          left: Math.min(mr.left, sr.left) - 24, top: Math.min(mr.top, sr.top) - 24,
          right: Math.max(mr.right, sr.right) + 24, bottom: Math.max(mr.bottom, sr.bottom) + 24,
        }, `t194-menu-over-strip-${cand.exe}`, outDir);
      };
      const round = await yieldRound(`P2:${cand.exe}`, cand.key, strip, tail, {
        watchPid: cand.pid,
        cursorAt: trayPoint,
        plan: [{ atMs: 2500, fn: async () => {
          snapMenu();
          // 直投收菜（WM_CANCELMODE）：无前台菜单收不到全局键盘 ESC——确定性触发
          // 三路侦测第①路 menu-closed（r4 实证 tapKeys 路不可靠）
          cancelMenusOf(cand.pid);
        } }],
      });
      const menuBorn = round.samples.some((s) => (s.menus ?? 0) > 0);
      const topmostDropped = round.samples.some((s) => s.topmost === false);
      h({ type: 'P2-round', exe: cand.exe, key: cand.key, menuBorn, topmostDropped, events: round.events });
      if (topmostDropped && menuBorn) {
        p2 = { ...round, exe: cand.exe, pid: cand.pid, menuBorn, topmostDropped, menuShot, hitTest };
        break;
      }
      await dismissMenus();
    }
    findings.p2 = p2;
    await dismissMenus();

    // —— P3 超时轮：自种探针图标（属主=条带窗自身：回放必达、必无菜单、不夺前台）
    //      → 三路侦测全盲 → 只有超时路径恢复（盲区兜底不死锁让位）。 ——
    const { encodeNotifyIconData, NIM_ADD, NIM_DELETE, NIF_MESSAGE, NIF_TIP } =
      require(path.join(APP_ROOT, 'dist', 'main', 'trayhost', 'protocol.js'));
    const PROBE_UID = 0x19400191;
    const CB = 0x8000 + 194;
    // 不带 NIF_ICON（hicon 0 会走 extractIcon 失败路径刷存证噪声；本探针只要名单在册）
    probeNid = encodeNotifyIconData({ arch: 'x64', version: 3, hwnd: strip, uid: PROBE_UID,
      flags: NIF_MESSAGE | NIF_TIP, callbackMessage: CB, hicon: 0,
      tooltip: 'DECK194-YIELD-PROBE', uVersion: 0 });
    const okAdd = ShellNotifyIconW(NIM_ADD, probeNid);
    const probeKey = `${strip}:${PROBE_UID}`;
    let inRoster = false;
    for (let i = 0; i < 12 && !inRoster; i++) {
      await sleep(700);
      const st2 = await cdpEval(STRIP_TITLE, `window.deck.bridge.invoke('taskbar/get-state', {})`);
      inRoster = (st2.tray || []).some((t) => t.key === probeKey);
    }
    h({ type: 'P3-probe-seeded', okAdd, inRoster, key: probeKey });
    if (okAdd && inRoster) {
      const round = await yieldRound('P3:timeout-probe', probeKey, strip, tail, { watchPid: st.panelPid });
      findings.p3 = { ...round, lastTopmost: round.samples[round.samples.length - 1]?.topmost };
      h({ type: 'P3-round', events: round.events, lastTopmost: findings.p3.lastTopmost });
      // 探针删除挪到 P4 之后（前任轮实证：先删再左键=点空名单，replayed 恒 false 失证）
    } else {
      h({ type: 'P3-skipped', reason: 'probe-not-rostered' });
    }

    // —— P3b 重申点在场驱证（票面 AC「让位期间条带不被三处重申点抢回置顶」的其余两处，
    //    keepalive 已由 P2/P3 每 500ms 压制存证在场）。监视 pid 走未知口径（死 hwnd 探针
    //    →pidOfWindow=0）让位窗口内**只有超时一条恢复路**——全屏探针顶前台/退场引起的
    //    前台变化不触发三路侦测第②路，恢复拍（5.5s）必然落在让位窗口内，不与前台变化
    //    恢复赛跑（前任轮口径：pid 未知两路停用只超时兜底）：
    //    ① 2s 起全屏探针顶前台 → 条带全屏让位（taskbar-yield，条带 hide）
    //    ② 5.5s 探针退场 → 恢复拍 showInactive+assertTop——闸门必须压制（存证
    //       fullscreen-yield-lifted；视图事实：条带可见但 topmost 位仍 0）
    //    ③ 7s 光标划入条带热区再离开 → 热区离开重申拍被压制（存证 hotzone-leave） ——
    let probe2Nid = null;
    if (okAdd && inRoster) {
      const FAKE_HWND = 0x1940194; // 非真实窗口句柄：pidOfWindow→0，监视 pid 未知口径
      const PROBE2_UID = 0x19400192;
      probe2Nid = encodeNotifyIconData({ arch: 'x64', version: 3, hwnd: FAKE_HWND, uid: PROBE2_UID,
        flags: NIF_MESSAGE | NIF_TIP, callbackMessage: CB, hicon: 0,
        tooltip: 'DECK194-YIELD-PROBE2', uVersion: 0 });
      const okAdd2 = ShellNotifyIconW(NIM_ADD, probe2Nid);
      const probe2Key = `${FAKE_HWND}:${PROBE2_UID}`;
      let inRoster2 = false;
      for (let i = 0; i < 12 && !inRoster2; i++) {
        await sleep(700);
        const st3 = await cdpEval(STRIP_TITLE, `window.deck.bridge.invoke('taskbar/get-state', {})`);
        inRoster2 = (st3.tray || []).some((t) => t.key === probe2Key);
      }
      h({ type: 'P3b-probe-seeded', okAdd: okAdd2, inRoster: inRoster2, key: probe2Key });
      if (okAdd2 && inRoster2) {
        const origCursor = win32.cursor();
        const probeChild = spawnFullscreenProbe(outDir);
        const round = await yieldRound('P3b:reassert-points', probe2Key, strip, tail, {
          watchPid: 0, // 死 hwnd → pid 未知口径（与产品链路 begin(pid=0) 同形）
          plan: [
            { atMs: 2000, fn: async () => {
                const fsHwnd = await waitFor(() => win32.topLevelWindows().find((w) => titleOf(w) === FS_PROBE_TITLE) || null, 6000);
                if (!fsHwnd) throw new Error(`全屏探针窗未现身（stderr尾：${probeChild.stderrTail()}`);
                forceForegroundH(fsHwnd);
            } },
            { atMs: 5500, fn: async () => { if (probeChild.exitCode === null) probeChild.kill(); } },
            { atMs: 7000, fn: async () => {
                const sr = win32.rectOf(strip);
                win32.SetCursorPos(Math.round((sr.left + sr.right) / 2), Math.round((sr.top + sr.bottom) / 2));
                await sleep(350); // 热区命中拍（25ms 轮询）
                win32.SetCursorPos(origCursor.x, origCursor.y);
                await sleep(450); // 离开确认拍（LEAVE_CONFIRM_POLLS=2）
            } },
          ],
        });
        // 恢复拍压制视图事实：全屏退场后（>6s）、超时恢复前（<9.3s）条带可见但 topmost 位恒 0
        const visibleAfterLift = round.samples
          .filter((s) => s.t > 6000 && s.t < 9300)
          .every((s) => s.visible === true && s.topmost === false);
        findings.p3b = { ...round, visibleAfterLift };
        h({ type: 'P3b-round', events: round.events, visibleAfterLift, planDone: round.planDone });
        try { if (probeChild.exitCode === null) probeChild.kill(); } catch { /* 尽力 */ }
        ShellNotifyIconW(NIM_DELETE, probe2Nid);
        probe2Nid = null;
      }
    }

    // —— P4 左键回归：左键回放不触发让位（探针须仍在册） ——
    if (okAdd && inRoster) {
      const since = Date.now();
      tail.next();
      void cdpEval(STRIP_TITLE,
        `window.deck.bridge.invoke('taskbar/tray-click', { key: ${JSON.stringify(probeKey)}, button: 'left' })`).catch(() => null);
      await sleep(1200);
      const fresh = tail.next().filter((e) => e.t >= since);
      findings.p4 = { replayed: fresh.some((e) => e.type === 'tray-replay' && e.key === probeKey), yielded: fresh.some((e) => e.type === 'taskbar-tray-yield') };
      h({ type: 'P4-left-round', ...findings.p4 });
      ShellNotifyIconW(NIM_DELETE, probeNid);
    }

    // 收尾核验：条带回置顶带、无遗留菜单窗
    const samplePids = [...new Set(candidates.slice(0, 4).map((c) => c.pid))];
    findings.finalStripTopmost = strip && win32.IsWindow(strip) ? topmostBit(strip) : null;
    findings.leftoverMenus = samplePids.reduce((n, pid) => n + menuWindowsOfPid(pid).length, 0);
    h({ type: 'final', stripTopmost: findings.finalStripTopmost, leftoverMenus: findings.leftoverMenus });
    if (!findings.finalStripTopmost || findings.leftoverMenus > 0) dirty = true;
  } catch (e) {
    dirty = true;
    h({ type: 'fatal', message: e && e.message, stack: (e && e.stack || '').split('\n').slice(0, 4).join(' | ') });
  } finally {
    try { if (probeNid) ShellNotifyIconW(NIM_DELETE, probeNid); } catch { /* 尽力 */ }
    try { if (probe2Nid) ShellNotifyIconW(NIM_DELETE, probe2Nid); } catch { /* 尽力 */ }
    await stopPanel(child);
    restoreConfig();
    // P5 时间线：让位/恢复相关事件全量抽取（报告引用的时序存证样本）
    const timeline = readEvents(eventsFile).filter((e) =>
      ['taskbar-tray-yield', 'taskbar-tray-yield-restored', 'taskbar-topmost-suppressed',
        'taskbar-topmost', 'tray-replay', 'tray-replay-miss', 'taskbar-tray-click'].includes(e.type));
    fs.writeFileSync(path.join(outDir, 'timeline.json'), JSON.stringify(timeline, null, 2));
    fs.writeFileSync(path.join(outDir, 'findings.json'), JSON.stringify({ findings, hlog }, null, 2));
    const leftovers = win32.topLevelWindows().filter((w) => titleOf(w) === STRIP_TITLE);
    if (leftovers.length) { dirty = true; h({ type: 'leftover-strips', count: leftovers.length }); }
    h({ type: 'run-end', dirty });
    process.exit(dirty ? 3 : 0);
  }
})();
