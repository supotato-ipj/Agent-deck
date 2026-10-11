'use strict';
// 工单163 托盘回放取证 harness（spec #154 ⑧）：一轮真机轮判别三假设——
//   ①回调投递被系统拒收（PostMessage 返回值/GetLastError）
//   ②回调负载语义错（版本协商、消息序列——wParam/lParam 排布、鼠标消息常量）
//   ③条目登记缺失（回调消息未协商登记——entries 无该 key 或 callbackMessage=0）
// 用法（纯 node；须先 npm run build）：node accept/experiments/tray-replay-forensics.js [--out=<dir>]
//
// 五相（固定此序，判读依赖）：
//   P0 拉起     --panel-accept + DECK_EVENT_LOG/CDP，taskbar.enabled 覆写 true（结束还原）
//   P1 链路与登记全量 dump  CDP 逐 key invoke taskbar/tray-click（右键）——事件流里的
//               tray-replay/tray-replay-miss/tray-replay-result 给出登记内容（hwnd/uid/
//               version/callbackMessage）与投递返回值（posted）＝①③证据+版本分布；
//               同时按 #32768 菜单窗/前台切换观测真实行为
//   P2 真实点击复现  SendInput 左键+右键点击条带内样本图标（CSS→物理换算）——用户
//               「点了没反应」的端到端复现；DOM handler→桥→数据面全链存证
//   P3 负载 A/B/C 对照  同一样本图标、同一目标 hwnd，harness 侧 koffi 直投三种负载：
//               A=产品现行 packTrayClick 形态；B=MSDN NOTIFYICONDATAW 口径（v0:
//               wParam=uID、lParam=鼠标消息；v4: wParam=锚点坐标、lParam=事件|uID<<16，
//               右键 WM_CONTEXTMENU）；C=v4 布局对但右键仍用 WM_RBUTTONUP（修复范围输入）。
//               行为.oracle = #32768 菜单窗（按目标 pid）/ 新可见顶层窗 / 前台切到目标 pid
//   P4 判读     汇总三假设证据与第三方样本行为对照，落 verdict.json
// 纪律：产品代码零改动；本 harness 是取证工具不进 manifest 不产 verdict 电池；退出码
// 0=完成 3=机器脏。碰真桌面（真面板+CDP+键鼠注入），一律经 accept-guard 托管。
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const win32 = require('../lib/win32');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_OUT = 'D:\\test-folder\\.agent-notes\\t163-tray-replay-forensics';
const PANEL_TITLE = 'AGENT DECK';
const STRIP_TITLE = 'DECK-TASKBAR';
const CDP_PORT = 9227;
const VK_ESCAPE = 0x1b;

// —— Win32 消息常量（WinUser.h；取证对照的权威口径）——
// 真 WM_LBUTTONUP=0x0202；0x0203 是 WM_LBUTTONDBLCLK（产品 protocol.ts 的
// WM_LBUTTONUP 常量即 0x0203——P3 的 A 臂如实复现产品形态，判读时对照）。
const MSG = {
  WM_CONTEXTMENU: 0x007b,
  WM_LBUTTONUP: 0x0202,
  WM_LBUTTONDBLCLK: 0x0203, // 产品口径的「WM_LBUTTONUP」
  WM_RBUTTONUP: 0x0205,
};

const user32Local = win32.koffi.load('user32.dll');
const kernel32Local = win32.koffi.load('kernel32.dll');
const AllowSetForegroundWindow = user32Local.func('bool __stdcall AllowSetForegroundWindow(uintptr_t dwProcId)');
const GetLastError = kernel32Local.func('uint32 __stdcall GetLastError()');
const GetWindowTextW = user32Local.func('int __stdcall GetWindowTextW(uintptr_t hWnd, uint16 *buf, int nMax)');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const exeBase = (p) => path.basename(p || '').toLowerCase().replace(/\.exe$/, '');

function windowTitle(hwnd) {
  const buf = Buffer.alloc(1024);
  const n = GetWindowTextW(hwnd, buf, 512);
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(buf.readUInt16LE(i * 2));
  return s;
}

// —— 事件文件增量读取（只看新增行）——
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

// —— 行为观测面 ——
/** 全部 #32768 菜单窗（按属主 pid/exe 标注；Win32 右键菜单的标准形态） */
function menuWindows() {
  const out = [];
  let after = 0;
  for (;;) {
    const h = Number(win32.FindWindowExW(0, after, '#32768', null));
    if (!h) break;
    const pid = win32.threadIdOf(h).pid;
    out.push({ hwnd: h, pid, exe: exeBase(win32.exeOfPid(pid)) });
    after = h;
  }
  return out;
}
function foregroundInfo() {
  const h = Number(win32.GetForegroundWindow());
  if (!h) return { hwnd: 0, pid: 0, exe: '' };
  const pid = win32.threadIdOf(h).pid;
  return { hwnd: h, pid, exe: exeBase(win32.exeOfPid(pid)) };
}
function visibleWindowSet() {
  return win32.topLevelWindows().map((h) => {
    const pid = win32.threadIdOf(h).pid;
    return { hwnd: h, pid, exe: exeBase(win32.exeOfPid(pid)), title: windowTitle(h).slice(0, 60), cls: win32.className(h) };
  });
}

/**
 * 一次投递的行为快照：投递前基线 → 执行动作 → 稳定窗口 → 三路 oracle 采样。
 * menuFor(pid)：目标 pid 的 #32768 菜单窗；newVisible：新出现的可见顶层窗（含 pid/exe/标题）；
 * foregroundBecame：前台是否切到目标 pid。
 */
async function behaviorProbe(tag, targetPid, act) {
  const menuBefore = menuWindows().map((m) => m.hwnd);
  const visBefore = visibleWindowSet();
  const fgBefore = foregroundInfo();
  await act();
  await sleep(1400);
  const menus = menuWindows();
  const visAfter = visibleWindowSet();
  const fgAfter = foregroundInfo();
  const beforeSet = new Set(visBefore.map((w) => w.hwnd));
  const menuSet = new Set(menuBefore);
  const newVisible = visAfter.filter((w) => !beforeSet.has(w.hwnd));
  const row = {
    tag,
    menus: menus.filter((m) => !menuSet.has(m.hwnd)),
    menuForTarget: menus.filter((m) => m.pid === targetPid).length,
    anyMenuCount: menus.length,
    newVisible,
    fgBefore, fgAfter,
    foregroundBecameTarget: fgAfter.pid === targetPid && fgBefore.pid !== targetPid,
  };
  row.responsive = row.menuForTarget > 0 || row.foregroundBecameTarget
    || newVisible.some((w) => w.pid === targetPid);
  // P1 用（targetPid 未知时的泛化口径）：任一菜单/新窗/前台变化
  row.responsiveAny = row.menus.length > 0 || row.newVisible.length > 0
    || row.foregroundBecameTarget || (fgAfter.pid !== fgBefore.pid && fgAfter.pid !== 0);
  return row;
}

async function dismissMenus() {
  win32.tapKeys([VK_ESCAPE]);
  await sleep(350);
  win32.tapKeys([VK_ESCAPE]);
  await sleep(350);
}

// —— 面板拉起 / CDP ——
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
    if (boot && ready) {
      const hwnd = win32.topLevelWindows().find((w) =>
        win32.threadIdOf(w).pid === boot.pid && win32.className(w) === 'Chrome_WidgetWin_1' && windowTitle(w) === PANEL_TITLE);
      if (hwnd) return { panelPid: boot.pid, panelHwnd: hwnd, ready };
    }
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

/** CDP 驱动指定标题的页面（t142 同款：原生 WebSocket + Runtime.evaluate） */
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

// —— 负载形态（与产品 protocol.ts packTrayClick 逐字段对照；A 臂=产品现行形态）——
// JS << 是 32 位有符号——一律 >>>0 归一成无符号 32 位再入 koffi uintptr_t 通道
// （同坑：host.ts 对 GDI 句柄的符号扩展备注）。
/** 产品 packTrayClick 的忠实复刻（右键 button 预展开；左键见 packProductLeft） */
function packProduct(entry, button, x, y) {
  if (entry.version >= 4) {
    const xx = x & 0xffff, yy = y & 0xffff;
    return { wp: (((yy << 16) | xx) >>> 0), lp: (((xx << 16) | (entry.uid & 0xffff)) >>> 0) };
  }
  return { wp: (button === 'left' ? MSG.WM_LBUTTONDBLCLK /*产品常量 0x0203*/ : MSG.WM_RBUTTONUP) >>> 0, lp: (entry.uid & 0xffff) >>> 0 };
}
/** MSDN NOTIFYICONDATAW uCallbackMessage 备注（learn.microsoft.com，2026-10 拉取原文）：
 *  v0：wParam=图标 uID、lParam=鼠标/键盘消息；v4：LOWORD(lParam)=事件（NIN 系列、
 *  WM_CONTEXTMENU、鼠标消息）、HIWORD(lParam)=uID、wParam=锚点坐标（GET_X/Y_LPARAM）。
 *  右键 v4 事件=WM_CONTEXTMENU。 */
function packMsdn(entry, button, x, y) {
  if (entry.version >= 4) {
    const xx = x & 0xffff, yy = y & 0xffff;
    const ev = button === 'right' ? MSG.WM_CONTEXTMENU : MSG.WM_LBUTTONUP;
    return { wp: (((yy << 16) | xx) >>> 0), lp: (((ev << 16) | (entry.uid & 0xffff)) >>> 0) };
  }
  return { wp: (entry.uid & 0xffffffff) >>> 0, lp: (button === 'right' ? MSG.WM_RBUTTONUP : MSG.WM_LBUTTONUP) >>> 0 };
}
/** v4 布局按 MSDN、右键事件仍用 WM_RBUTTONUP（判「必须换 WM_CONTEXTMENU 吗」） */
function packMsdnLegacyRight(entry, x, y) {
  const xx = x & 0xffff, yy = y & 0xffff;
  return { wp: (((yy << 16) | xx) >>> 0), lp: (((MSG.WM_RBUTTONUP << 16) | (entry.uid & 0xffff)) >>> 0) };
}

/** harness 侧直投（P3）：AllowSetForegroundWindow 尽力 + PostMessageW，返回投递结果 */
function postPayload(hwnd, callbackMessage, pack) {
  const asfw = Boolean(AllowSetForegroundWindow(hwnd));
  const posted = Boolean(win32.PostMessageW(hwnd, callbackMessage, pack.wp, pack.lp));
  const lastError = posted ? null : GetLastError();
  return { asfw, posted, lastError };
}

// —— 主流程 ——
(async () => {
  const outDir = process.argv.find((a) => a.startsWith('--out='))?.slice(6) || DEFAULT_OUT;
  fs.mkdirSync(outDir, { recursive: true });
  const hlog = [];
  const h = (ev) => { hlog.push({ t: Date.now(), ...ev }); console.log(`[t163-forensics] ${JSON.stringify(ev)}`); };
  h({ type: 'run-start', out: outDir, msg: JSON.stringify(MSG) });
  const eventsFile = path.join(outDir, 'panel-events.jsonl');

  // config 覆写（t142 同款）：任务栏启用——条带在场才有栏内托盘可点
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
  const registry = []; // P1 全量登记 dump
  const samples = []; // P3 选中的第三方样本
  try {
    // —— P0 拉起 ——
    child = launchPanel(eventsFile);
    const st = await waitPanelReady(eventsFile, child);
    h({ type: 'P0-ready', panelPid: st.panelPid, trayHostReady: st.ready });
    await sleep(6000); // TaskbarCreated 广播后的 NIM_ADD/NIM_SETVERSION 波次收编 + 条带建窗

    const tail = new EventTail(eventsFile);
    tail.next(); // 排空既有
    // P1/P2 共用的读窗游标：每次取「上次读到现在的增量」，避免跨 key 陈旧归因
    // （首轮教训：窗口不前进时 miss 行会捡到上一 key 的 tray-replay 事件）
    const evIdx = { n: 0 };
    const freshEvents = () => {
      const all = readEvents(eventsFile);
      const fresh = all.slice(evIdx.n);
      evIdx.n = all.length;
      return fresh;
    };

    // —— P1 链路与登记全量 dump（右键逐 key；③①证据+版本分布）——
    const state = await cdpEval(STRIP_TITLE, `window.deck.bridge.invoke('taskbar/get-state', {})`);
    const domKeys = await cdpEval(STRIP_TITLE,
      `Array.from(document.querySelectorAll('.tb-tray-icon')).map((el) => el.dataset.key)`);
    h({ type: 'P1-bar-state', tray: state.tray, domKeys });
    const stripHwnd = win32.topLevelWindows().find((w) =>
      win32.threadIdOf(w).pid === st.panelPid && windowTitle(w) === STRIP_TITLE);
    h({ type: 'P1-strip', stripHwnd: stripHwnd ?? 0 });

    for (const entry of state.tray.slice(0, 25)) {
      try {
        const probe = await behaviorProbe(`P1:${entry.key}`, 0, async () => {
          await cdpEval(STRIP_TITLE, `window.deck.bridge.invoke('taskbar/tray-click', { key: ${JSON.stringify(entry.key)}, button: 'right' })`);
        });
        const fresh = freshEvents();
        // 本 key 的 replay/miss 按事件内 key 字段匹配（防串行残留）
        const replay = fresh.filter((e) => e.type === 'tray-replay' && e.key === entry.key).pop() || null;
        const miss = fresh.filter((e) => e.type === 'tray-replay-miss' && e.key === entry.key).pop() || null;
        const result = fresh.filter((e) => e.type === 'tray-replay-result' && e.key === entry.key).pop() || null;
        const clickRes = fresh.filter((e) => e.type === 'taskbar-tray-click-result' && e.key === entry.key).pop() || null;
        let pid = 0, exe = '';
        if (replay?.hwnd) { pid = win32.threadIdOf(Number(replay.hwnd)).pid; exe = exeBase(win32.exeOfPid(pid)); }
        const row = {
          key: entry.key, tooltip: entry.tooltip, inDom: domKeys.includes(entry.key),
          registered: !!replay, replay, miss, bridgeResult: result ?? clickRes ?? null, behavior: probe,
          pid, exe,
        };
        registry.push(row);
        h({ type: 'P1-row', key: entry.key, tooltip: entry.tooltip, exe,
          registered: !!replay, posted: replay?.posted ?? null, version: replay?.version ?? null,
          cb: replay?.message ?? null, wparam: replay?.wparam ?? null, lparam: replay?.lparam ?? null,
          missKnown: miss?.known ?? null, responsiveAny: probe.responsiveAny,
          menuAny: probe.menus.length > 0, newVisibleAny: probe.newVisible.length > 0 });
        await dismissMenus();
      } catch (e) {
        registry.push({ key: entry.key, tooltip: entry.tooltip, registered: false, error: e && e.message });
        h({ type: 'P1-row-error', key: entry.key, message: e && e.message });
      }
    }
    const versionHisto = {};
    for (const r of registry) {
      const v = r.replay ? String(r.replay.version ?? 0) : (r.miss ? 'miss' : 'no-event');
      versionHisto[v] = (versionHisto[v] ?? 0) + 1;
    }
    h({ type: 'P1-summary', total: registry.length, versionHisto });

    // —— P2 真实点击复现（用户「点了没反应」端到端；选一个有登记的第三方样本）——
    let sample2 = registry.find((r) => r.registered && r.exe && !['electron', 'explorer', ''].includes(r.exe))
      || registry.find((r) => r.registered);
    let p2 = { skipped: 'no-registered-entry' };
    if (sample2 && stripHwnd) {
      const rect = win32.rectOf(stripHwnd);
      const geo = await cdpEval(STRIP_TITLE, `(() => {
        const el = document.querySelector('.tb-tray-icon[data-key=${JSON.stringify(sample2.key)}]');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, iw: window.innerWidth };
      })()`);
      if (geo && rect) {
        const scale = (rect.right - rect.left) / geo.iw;
        const sx = Math.round(rect.left + geo.x * scale), sy = Math.round(rect.top + geo.y * scale);
        // 条带默认鼠标穿透（热区跟踪器 25ms 轮询命中才开门）：先移过去稳一拍再点，
        // 否则点击会穿到壁纸——单次点击（双击会给应用送 WM_LBUTTONDBLCLK，污染判读）
        const realClick = async (button) => {
          win32.SetCursorPos(sx, sy);
          await sleep(350);
          win32.clickPhys(sx, sy, button);
        };
        const left = await behaviorProbe('P2-left-real-click', sample2.pid, async () => { await realClick('left'); });
        await dismissMenus();
        const freshL = freshEvents();
        const right = await behaviorProbe('P2-right-real-click', sample2.pid, async () => { await realClick('right'); });
        await dismissMenus();
        const freshR = freshEvents();
        p2 = {
          sample: { key: sample2.key, tooltip: sample2.tooltip, exe: sample2.exe },
          screen: { sx, sy, scale }, left, right,
          chainEventsLeft: freshL.filter((e) => /tray/.test(String(e.type))).map((e) => ({ type: e.type, posted: e.posted ?? null, ok: e.ok ?? null, error: e.error ?? null })),
          chainEventsRight: freshR.filter((e) => /tray/.test(String(e.type))).map((e) => ({ type: e.type, posted: e.posted ?? null, ok: e.ok ?? null, error: e.error ?? null })),
        };
        h({ type: 'P2-real-click', sample: p2.sample, screen: p2.screen,
          leftResponsive: left.responsive, rightResponsive: right.responsive,
          chainLeft: p2.chainEventsLeft, chainRight: p2.chainEventsRight });
      } else {
        p2 = { skipped: 'cdp-geo-or-rect-missing', geo: !!geo, rect: !!rect };
        h({ type: 'P2-skipped', ...p2 });
      }
    } else {
      h({ type: 'P2-skipped', ...p2 });
    }

    // —— P3 负载 A/B/C 对照（②判别主证；样本=已登记第三方，至多 3 个，右键为主 oracle）——
    const thirdParty = registry.filter((r) => r.registered && r.replay?.hwnd && r.exe
      && !['electron', 'explorer', ''].includes(r.exe));
    // 版本多样性优先：一个 version>=4、一个 version==0，再补一个任意
    const picked = [];
    const v4 = thirdParty.find((r) => Number(r.replay.version) >= 4); if (v4) picked.push(v4);
    const v0 = thirdParty.find((r) => Number(r.replay.version) === 0 && r !== v4); if (v0) picked.push(v0);
    for (const r of thirdParty) { if (picked.length >= 3) break; if (!picked.includes(r)) picked.push(r); }
    h({ type: 'P3-samples', picked: picked.map((r) => ({ key: r.key, tooltip: r.tooltip, exe: r.exe, version: r.replay.version, uid: r.replay.uid, hwnd: r.replay.hwnd, cb: r.replay.message })) });

    // 锚点=样本图标在条带内的屏坐标（产品回放取 GetCursorPos，先移过去对齐该形态）
    const anchorFor = async (key) => {
      if (!stripHwnd) { const c = win32.cursor(); return { x: c.x, y: c.y, moved: false }; }
      const rect = win32.rectOf(stripHwnd);
      const geo = await cdpEval(STRIP_TITLE, `(() => {
        const el = document.querySelector('.tb-tray-icon[data-key=${JSON.stringify(key)}]');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, iw: window.innerWidth };
      })()`).catch(() => null);
      if (!geo || !rect) { const c = win32.cursor(); return { x: c.x, y: c.y, moved: false }; }
      const scale = (rect.right - rect.left) / geo.iw;
      const sx = Math.round(rect.left + geo.x * scale), sy = Math.round(rect.top + geo.y * scale);
      win32.SetCursorPos(sx, sy);
      await sleep(200);
      const c = win32.cursor();
      return { x: c.x, y: c.y, moved: true };
    };

    // 左键三臂白名单（左键=应用默认动作，会真开窗——只对行为可预期的常见应用做）
    const LEFT_WHITELIST = ['steam', 'onedrive', 'lenovotray', 'powertoys', 'shadowsocks', 'ticktick', 'snipaste', 'weixin'];
    let leftArmsDone = false;

    for (const s of picked) {
      const entry = { uid: Number(s.replay.uid), version: Number(s.replay.version), callbackMessage: Number(s.replay.message) };
      const hwnd = Number(s.replay.hwnd);
      const anchor = await anchorFor(s.key);
      const arms = [
        { name: 'A-product', pack: packProduct(entry, 'right', anchor.x, anchor.y) },
        { name: 'B-msdn', pack: packMsdn(entry, 'right', anchor.x, anchor.y) },
      ];
      if (entry.version >= 4) arms.push({ name: 'C-msdn-rbuttonup', pack: packMsdnLegacyRight(entry, anchor.x, anchor.y) });
      // 左键三臂（首个白名单样本）：产品形态（wp=0x0203,lp=uid）/ MSDN 形态（wp=uid,lp=0x0202）/
      // 只修排布（wp=uid,lp=0x0203）——第三臂隔离「常量 0x0203 是否也要修」的归因
      if (!leftArmsDone && LEFT_WHITELIST.includes(s.exe)) {
        leftArmsDone = true;
        arms.push({ name: 'A-product-left', pack: packProduct(entry, 'left', anchor.x, anchor.y) });
        arms.push({ name: 'B-msdn-left', pack: packMsdn(entry, 'left', anchor.x, anchor.y) });
        if (entry.version < 4) {
          arms.push({ name: 'D-swaponly-left', pack: { wp: (entry.uid & 0xffffffff) >>> 0, lp: MSG.WM_LBUTTONDBLCLK >>> 0 } });
        }
      }
      const armRows = [];
      for (const arm of arms) {
        const probe = await behaviorProbe(`P3:${arm.name}:${s.exe}`, s.pid, async () => {
          const res = postPayload(hwnd, entry.callbackMessage, arm.pack);
          armRows.push({ arm: arm.name, ...res, wp: arm.pack.wp, lp: arm.pack.lp, cb: entry.callbackMessage, version: entry.version });
          if (!res.posted) h({ type: 'P3-post-rejected', sample: s.exe, arm: arm.name, lastError: res.lastError, asfw: res.asfw });
        });
        h({ type: 'P3-arm', sample: s.exe, tooltip: s.tooltip, version: entry.version,
          arm: arm.name, wp: arm.pack.wp, lp: arm.pack.lp, responsive: probe.responsive,
          menus: probe.menus.length, fgBecame: probe.foregroundBecameTarget, newVisible: probe.newVisible.length });
        await dismissMenus();
      }
      samples.push({ key: s.key, tooltip: s.tooltip, exe: s.exe, pid: s.pid, version: entry.version, arms: armRows });
    }

    // —— P4 判读（数据驱动；最终归因在 audit 报告）——
    const p1Rows = registry.filter((r) => r.inDom !== false);
    const postedRows = p1Rows.filter((r) => r.replay);
    const missRows = p1Rows.filter((r) => r.miss);
    const noEventRows = p1Rows.filter((r) => !r.replay && !r.miss);
    const postRejected = [...postedRows.filter((r) => r.replay.posted === false)].map((r) => r.key);
    const p3Arms = hlog.filter((e) => e.type === 'P3-arm');
    const groupArms = (pred) => {
      const by = new Map();
      for (const r of p3Arms) { if (!by.has(r.sample)) by.set(r.sample, {}); by.get(r.sample)[r.arm] = r; }
      return [...by.entries()].filter(([, v]) => pred(v)).map(([k]) => k);
    };
    const verdict = {
      H1_postRejected: {
        anyRejected: postRejected.length > 0 || samples.some((s) => s.arms.some((a) => a.posted === false)),
        rejectedKeys: postRejected,
        note: 'posted=false 或 P3 lastError 即投递被拒证据；全 true=①不成立',
      },
      H3_registration: {
        registered: postedRows.length, missed: missRows.length, noEvent: noEventRows.length, total: p1Rows.length,
        note: 'miss=tray-replay-miss（未登记/未协商回调）；noEvent=链路断在到达宿主前',
      },
      H2_payload: {
        productInert_msdnResponsive: groupArms((rows) => rows.A?.responsive === false && rows.B?.responsive === true),
        bothResponsive: groupArms((rows) => rows.A?.responsive === true),
        bothInert: groupArms((rows) => rows.A?.responsive !== true && rows.B?.responsive !== true),
        note: 'productInert+msdnResponsive=②坐实（同一目标同轮对照）；arm 键=A-product/B-msdn',
      },
      versionHisto,
      samples: samples.map((s) => ({ exe: s.exe, tooltip: s.tooltip, version: s.version, arms: s.arms })),
    };
    h({ type: 'P4-verdict', verdict });
    fs.writeFileSync(path.join(outDir, 'registry.json'), JSON.stringify({ registry, samples, p2, verdict, msg: MSG }, null, 2));
  } catch (e) {
    dirty = true;
    h({ type: 'fatal', message: e && e.message, stack: (e && e.stack || '').split('\n').slice(0, 4).join(' | ') });
  } finally {
    await stopPanel(child);
    restoreConfig();
    fs.writeFileSync(path.join(outDir, 'harness-log.json'), JSON.stringify(hlog, null, 2));
    const leftovers = win32.topLevelWindows().filter((w) => windowTitle(w) === STRIP_TITLE);
    if (leftovers.length) { dirty = true; h({ type: 'leftover-strips', count: leftovers.length }); }
    h({ type: 'run-end', dirty });
    process.exit(dirty ? 3 : 0);
  }
})();
