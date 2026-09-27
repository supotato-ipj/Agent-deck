'use strict';
// 工单02 验收电池雏形：透明合成 / 默认穿透 / 热区接收与重钉 / 底部钉扎。
// 运行：npm run accept（= electron . --accept，控制器与面板同仓库，面板为子进程）。
// 复用工单01 探针的调用形态（探针A/B/C 全绿）：SendInput 虚拟屏归一化坐标、
// WindowFromPoint 经 GetAncestor(GA_ROOT)、GDI 抓屏走 DPI 感知 PowerShell。
const { app, BrowserWindow, screen, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const win32 = require('./lib/win32');
const { Report } = require('./lib/report');

const APP_ROOT = path.resolve(__dirname, '..');
const EVENTS_FILE = path.join(__dirname, 'evidence', '02-runtime-events.jsonl');
const WM_CLOSE = 0x0010;
// 卡片几何须与 src/renderer/index.html 的 #clock-card 保持一致（DIP）
const CARD_DIP = { x: 48, y: 48, w: 320, h: 176 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function screenInfo() {
  const d = screen.getPrimaryDisplay();
  return {
    factor: d.scaleFactor,
    dipBounds: d.bounds,
    workArea: d.workArea,
    phys: { w: Math.round(d.bounds.width * d.scaleFactor), h: Math.round(d.bounds.height * d.scaleFactor) },
  };
}

// 物理像素区域截图（DPI 感知 PowerShell）
function capture(rect, name) {
  const out = path.join(__dirname, 'evidence', name + '.png');
  const { spawnSync } = require('child_process');
  const r = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(__dirname, 'lib', 'capture.ps1'),
    '-Out', out, '-X', String(rect.left), '-Y', String(rect.top),
    '-W', String(rect.right - rect.left), '-H', String(rect.bottom - rect.top),
  ], { encoding: 'utf8', timeout: 20000 });
  if (r.status !== 0 || !fs.existsSync(out)) throw new Error(`capture 失败: ${r.stdout} ${r.stderr}`);
  return out;
}

// 棋盘两色 #2040c0/#c04020 命中率（工单01 探针A 同法）
function checkerHitRate(pngPath, zone) {
  const img = nativeImage.createFromPath(pngPath);
  const s = img.getSize();
  const buf = img.toBitmap();
  const W = s.width;
  let hit = 0, n = 0;
  const tol = 30;
  const colors = [[192, 64, 32], [32, 64, 192]];
  for (let y = Math.max(0, zone.top); y < Math.min(s.height, zone.bottom); y += 2) {
    for (let x = Math.max(0, zone.left); x < Math.min(W, zone.right); x += 2) {
      const i = (y * W + x) * 4;
      const r = buf[i + 2], g = buf[i + 1], b = buf[i];
      n++;
      for (const [cr, cg, cb] of colors) {
        if (Math.abs(r - cr) <= tol && Math.abs(g - cg) <= tol && Math.abs(b - cb) <= tol) { hit++; break; }
      }
    }
  }
  return { rate: hit / Math.max(1, n), n };
}

// 区域内接近纯白的像素占比（文字实色证据；工单01 探针A 同法）
function whitePixels(pngPath, zone, threshold = 200) {
  const img = nativeImage.createFromPath(pngPath);
  const s = img.getSize();
  const buf = img.toBitmap();
  const W = s.width;
  let hit = 0, n = 0;
  for (let y = Math.max(0, zone.top); y < Math.min(s.height, zone.bottom); y += 2) {
    for (let x = Math.max(0, zone.left); x < Math.min(W, zone.right); x += 2) {
      const i = (y * W + x) * 4;
      n++;
      if (buf[i] > threshold && buf[i + 1] > threshold && buf[i + 2] > threshold) hit++;
    }
  }
  return { hit, n, pct: 100 * hit / Math.max(1, n) };
}

// —— 桌面清场：逐窗最小化，退出时精确还原（工单01 探针同法）——
const CLEAR_DESKTOP_SKIP = new Set([
  'Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd',
  'Windows.UI.Core.CoreWindow', 'Windows.Internal.Shell.TabProxyWindow',
]);
const SW_MINIMIZE = 6, SW_RESTORE = 9;
let minimizedForRestore = [];

async function clearDesktop(points, f) {
  const isDesktopAt = (pt) => {
    if (!pt) return true;
    const cls = win32.className(win32.windowFromPointRoot(pt));
    return ['WorkerW', 'Progman', 'SHELLDLL_DefView', 'SysListView32'].includes(cls);
  };
  minimizedForRestore = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const h of win32.topLevelWindows()) {
      if (CLEAR_DESKTOP_SKIP.has(win32.className(h))) continue;
      const ex = win32.GetWindowLongW(h, win32.GWL_EXSTYLE);
      if (ex & win32.WS_EX_TOPMOST) continue;
      win32.ShowWindow(h, SW_MINIMIZE);
      minimizedForRestore.push(h);
    }
    await sleep(700);
    if (points.every(isDesktopAt)) break;
  }
}

function restoreDesktop() {
  for (const h of minimizedForRestore.reverse()) {
    try { if (win32.IsWindow(h)) win32.ShowWindow(h, SW_RESTORE); } catch { /* 尽力还原 */ }
  }
  minimizedForRestore = [];
}

// 启动真实普通应用窗（Win11 打包版记事本的窗口不属于启动进程，按新出现窗口匹配）
async function launchNotepad(rep, rect) {
  const before = new Set(win32.topLevelWindows().filter((h) => win32.className(h) === 'Notepad'));
  const np = spawn('notepad.exe', [], { stdio: 'ignore' });
  let hwnd = null;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !hwnd) {
    await sleep(250);
    hwnd = win32.topLevelWindows().find((h) => win32.className(h) === 'Notepad' && !before.has(h)) || null;
  }
  let kind = 'notepad';
  if (!hwnd) throw new Error('8s 内未出现记事本窗口（电池需要真实普通应用窗）');
  win32.SetWindowPos(hwnd, 0, rect.x, rect.y, rect.w, rect.h, win32.SWP_NOZORDER | win32.SWP_NOACTIVATE);
  await sleep(300);
  return { hwnd, kind, child: np };
}

function readEvents() {
  try {
    return fs.readFileSync(EVENTS_FILE, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

async function waitEvent(type, pred, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = readEvents().find((e) => e.type === type && (!pred || pred(e)));
    if (hit) return hit;
    await sleep(60);
  }
  return null;
}

async function waitPanelWindow(timeoutMs) {
  // 面板自报 pid（boot 事件）：spawn 的 child.pid 在 Electron 父进程下不等于
  // 面板真实主进程 pid（实测），以面板自报为准。
  const boot = await waitEvent('boot', null, timeoutMs);
  if (!boot) { console.log('[battery] 未收到 boot 存证'); return null; }
  const pid = boot.pid;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hwnd = win32.topLevelWindows().find(
      (h) => win32.threadIdOf(h).pid === pid && win32.className(h) === 'Chrome_WidgetWin_1');
    if (hwnd) return hwnd;
    await sleep(200);
  }
  const dump = win32.topLevelWindows()
    .filter((h) => win32.className(h).startsWith('Chrome'))
    .slice(0, 12)
    .map((h) => `0x${h.toString(16)} pid=${win32.threadIdOf(h).pid} cls=${win32.className(h)}`);
  console.log(`[battery] boot.pid=${pid} 的窗口未找到。controller.pid=${process.pid} 可见 Chrome 窗:`, dump.join(' | '));
  return null;
}

async function main() {
  const rep = new Report('02-battery');
  const w32 = win32;
  const si = screenInfo();
  const f = si.factor;
  rep.note(`screen: phys ${si.phys.w}x${si.phys.h} @ factor ${f}`);
  try { fs.unlinkSync(EVENTS_FILE); } catch { /* 首次不存在 */ }

  const savedCursor = w32.cursor();
  const safePt = { x: 40 * f, y: si.phys.h - 40 };
  await clearDesktop([safePt], f);
  w32.moveMousePhys(safePt.x, safePt.y);

  let child = null;
  let panelPid = null;
  let notepad = null;
  let stderrTail = '';

  const launchPanel = () => spawn(process.execPath, ['.'], {
    cwd: APP_ROOT,
    env: { ...process.env, DECK_EVENT_LOG: EVENTS_FILE },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stopPanel = async () => {
    if (!child && !panelPid) return;
    try { child && child.kill(); } catch { /* 尽力 */ }
    await sleep(800);
    let alive = false;
    for (const pid of [child && child.pid, panelPid].filter(Boolean)) {
      try { process.kill(pid, 0); alive = true; } catch { /* 已退出 */ }
    }
    if (alive) {
      // Electron 有 GPU/工具子进程，兜底整树强杀
      const { spawnSync } = require('child_process');
      for (const pid of [child && child.pid, panelPid].filter(Boolean)) {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      }
    }
    child = null;
    panelPid = null;
  };
  try {
    // —— P1 启动面板（子进程，存证事件落盘）——
    child = launchPanel();
    child.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-4000); });
    const hwnd = await waitPanelWindow(20000);
    if (!hwnd) throw new Error(`20s 内未见面板窗口\nstderr:\n${stderrTail}`);
    panelPid = win32.threadIdOf(hwnd).pid;
    const rect = w32.rectOf(hwnd);
    rep.note(`panel hwnd=0x${hwnd.toString(16)} rect(phys)=${rect.left},${rect.top} ${rect.right - rect.left}x${rect.bottom - rect.top}`);
    await sleep(1200);

    // —— P2 透明合成：棋盘参照窗压到面板之下（免受动态壁纸干扰）——
    const checker = new BrowserWindow({
      x: Math.round(rect.left / f) - 8, y: Math.round(rect.top / f) - 8,
      width: Math.round((rect.right - rect.left) / f) + 16,
      height: Math.round((rect.bottom - rect.top) / f) + 16,
      show: false, frame: false, transparent: false, skipTaskbar: true,
    });
    checker.loadFile(path.join(__dirname, 'lib', 'checker.html'));
    checker.once('ready-to-show', () => checker.showInactive());
    const checkerHwnd = await (async () => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        await sleep(200);
        const h = w32.topLevelWindows().find(
          (hh) => w32.threadIdOf(hh).pid === process.pid && w32.className(hh) === 'Chrome_WidgetWin_1');
        if (h) return h;
      }
      throw new Error('参照窗未创建');
    })();
    w32.SetWindowPos(checkerHwnd, w32.HWND_BOTTOM, 0, 0, 0, 0,
      w32.SWP_NOMOVE | w32.SWP_NOSIZE | w32.SWP_NOACTIVATE | w32.SWP_NOOWNERZORDER);
    await sleep(1000);

    const localCard = {
      left: CARD_DIP.x * f, top: CARD_DIP.y * f,
      right: (CARD_DIP.x + CARD_DIP.w) * f, bottom: (CARD_DIP.y + CARD_DIP.h) * f,
    };
    const workBottom = Math.round((si.workArea.y + si.workArea.height) * f) - 8 - rect.top;
    const transparentZone = {
      left: Math.min(localCard.right + 8, (rect.right - rect.left) - 8),
      top: 8, right: (rect.right - rect.left) - 8, bottom: workBottom,
    };
    const shot = capture(rect, '02-transparent-on-checker');
    const chk = checkerHitRate(shot, transparentZone);
    rep.log(`透明区棋盘色命中率: ${(chk.rate * 100).toFixed(1)}% (样本 ${chk.n})`);
    chk.rate > 0.9
      ? rep.pass('透明合成：面板透明区透出其下参照窗（壁纸可见性的机制保证）')
      : rep.fail(`透明区未透出参照窗（命中率 ${(chk.rate * 100).toFixed(1)}%）`);
    const wp = whitePixels(shot, localCard);
    wp.hit > 30
      ? rep.pass(`时钟卡白色文字像素 ${wp.hit}/${wp.n}（文字实色清晰）`)
      : rep.fail(`时钟卡白色文字像素不足 ${wp.hit}/${wp.n}`);
    checker.destroy();
    await sleep(600);
    capture(rect, '02-on-wallpaper');
    rep.note('实拍面板叠真壁纸（观感存证；动态壁纸逐帧不同，不做像素断言）');

    // —— P3 默认穿透：左键/右键直达桌面 ——
    const ex = w32.GetWindowLongW(hwnd, w32.GWL_EXSTYLE);
    rep.log(`穿透态 EXSTYLE=0x${(ex >>> 0).toString(16)}`);
    (ex & w32.WS_EX_TRANSPARENT) && (ex & w32.WS_EX_LAYERED)
      ? rep.pass('默认穿透：窗口样式含 WS_EX_TRANSPARENT|WS_EX_LAYERED')
      : rep.fail('默认穿透：窗口样式缺少预期位');
    const emptyPt = { x: 560 * f, y: 300 * f }; // 面板内、卡片与记事本之外（探针01 实证桌面落点）
    w32.clickPhys(emptyPt.x, emptyPt.y, 'left');
    await sleep(500);
    const fg = w32.GetForegroundWindow();
    const fgCls = w32.className(fg);
    ['Progman', 'WorkerW', 'SHELLDLL_DefView', 'SysListView32'].includes(fgCls)
      ? rep.pass(`默认穿透：面板空区点击直达桌面（前台翻转为 ${fgCls}）`)
      : rep.fail(`面板空区点击未直达桌面：前台=0x${fg.toString(16)}(${fgCls})`);
    w32.clickPhys(emptyPt.x, emptyPt.y, 'right');
    await sleep(500);
    const fgR = w32.GetForegroundWindow();
    const fgRCls = w32.className(fgR);
    // Win11 桌面右键菜单宿主为 XamlExplorerHostIslandWindow（WASDK）——菜单弹出即右键直达桌面
    fgRCls === 'Progman' || fgRCls === 'WorkerW' || fgRCls.startsWith('XamlExplorerHost')
      ? rep.pass(`默认穿透：右键同样直达桌面（桌面右键菜单弹出，前台 ${fgRCls}）`)
      : rep.fail(`右键未直达桌面：前台=0x${fgR.toString(16)}(${fgRCls})`);
    w32.tapKeys([0x1b]); // ESC 收起桌面右键菜单（若有）
    await sleep(300);

    // —— P4 热区接收 + 交互后重钉 ——
    const zones = await waitEvent('hotzones');
    const cardZone = zones && (zones.rects || []).find((r) => r.id === 'clock-card');
    cardZone
      ? rep.pass(`热区声明：渲染层上报 clock-card rel(${cardZone.x},${cardZone.y}) ${cardZone.w}x${cardZone.h}`)
      : rep.fail('渲染层未上报 clock-card 热区');

    notepad = await launchNotepad(rep, { x: 1000, y: 200, w: 1400, h: 900 });
    rep.note(`普通应用窗: ${notepad.kind} hwnd=0x${notepad.hwnd.toString(16)} @phys(1000,200) 1400x900`);
    const overlap = { x: 1800, y: 600 }; // 记事本∩面板、卡片之外
    w32.clickPhys(overlap.x, overlap.y, 'left'); // 激活记事本
    await sleep(400);
    const wfp = (pt) => w32.windowFromPointRoot(pt);
    wfp(overlap) === notepad.hwnd
      ? rep.pass('记事本盖住面板（普通窗在钉扎面板之上的自然 z 序）')
      : rep.fail(`重叠点命中 0x${wfp(overlap).toString(16)}(${w32.className(wfp(overlap))})，非记事本`);

    const cardCenter = { x: Math.round((CARD_DIP.x + CARD_DIP.w / 2) * f), y: Math.round((CARD_DIP.y + CARD_DIP.h / 2) * f) };
    w32.moveMousePhys(cardCenter.x, cardCenter.y);
    const exAfterEnter = await (async () => {
      const deadline = Date.now() + 1500;
      while (Date.now() < deadline) {
        const e = w32.GetWindowLongW(hwnd, w32.GWL_EXSTYLE);
        if (!(e & w32.WS_EX_TRANSPARENT)) return e;
        await sleep(50);
      }
      return w32.GetWindowLongW(hwnd, w32.GWL_EXSTYLE);
    })();
    !(exAfterEnter & w32.WS_EX_TRANSPARENT)
      ? rep.pass('光标进入时钟卡热区：面板临时解除穿透（WS_EX_TRANSPARENT 移除）')
      : rep.fail('进入热区后面板仍处于穿透样式');

    w32.clickPhys(cardCenter.x, cardCenter.y, 'left');
    const clickEvt = await waitEvent('clock-card-clicked', (e) => e.count >= 1);
    clickEvt
      ? rep.pass(`热区点击由时钟卡接收（count=${clickEvt.count}）`)
      : rep.fail('热区点击未被时钟卡接收（无 clock-card-clicked 存证）');
    const renders = readEvents().filter((e) => e.type === 'clock-rendered');
    renders.length >= 2 && renders[1].epochMs > renders[0].epochMs
      ? rep.pass(`时钟卡数据经桥接契约自内核而来并持续走时（${renders.length} 次渲染，epoch 递增）`)
      : rep.fail(`时钟卡未证实内核推送（clock-rendered 存证 ${renders.length} 条）`);

    w32.moveMousePhys(safePt.x, safePt.y);
    const exAfterLeave = await (async () => {
      const deadline = Date.now() + 1500;
      while (Date.now() < deadline) {
        const e = w32.GetWindowLongW(hwnd, w32.GWL_EXSTYLE);
        if (e & w32.WS_EX_TRANSPARENT) return e;
        await sleep(50);
      }
      return w32.GetWindowLongW(hwnd, w32.GWL_EXSTYLE);
    })();
    exAfterLeave & w32.WS_EX_TRANSPARENT
      ? rep.pass('离开热区：面板恢复穿透')
      : rep.fail('离开热区后面板未恢复穿透样式');
    await sleep(600);
    wfp(overlap) === notepad.hwnd
      ? rep.pass('热区交互后重钉生效：面板回到普通窗之下（记事本仍盖住面板）')
      : rep.fail(`热区交互后重叠点命中 0x${wfp(overlap).toString(16)}(${w32.className(wfp(overlap))})，面板未回底`);
    const z = w32.topLevelWindows();
    const zPanel = z.indexOf(hwnd), zNp = z.indexOf(notepad.hwnd);
    zPanel > zNp
      ? rep.pass(`底部钉扎 z 序：面板(${zPanel}) 在记事本(${zNp}) 之下（自顶向下枚举序）`)
      : rep.fail(`z 序异常：面板=${zPanel} 记事本=${zNp}`);
    capture({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }, '02-pinned-bottom');

    // —— P6 config 几何生效：改 config 重启面板 ——
    const configPath = path.join(APP_ROOT, 'config.json');
    const configBackup = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null;
    try {
      await stopPanel();
      fs.writeFileSync(configPath, JSON.stringify({ panel: { x: 60, y: 60, width: 1100, height: 800 } }, null, 2) + '\n');
      try { fs.unlinkSync(EVENTS_FILE); } catch { /* 重置存证，waitEvent 才能等到新 boot */ }
      child = launchPanel();
      const hwnd2 = await waitPanelWindow(20000);
      if (!hwnd2) throw new Error(`重启后未见面板窗口\nstderr:\n${stderrTail}`);
      const r2 = w32.rectOf(hwnd2);
      panelPid = w32.threadIdOf(hwnd2).pid;
      const expect = { x: 60 * f, y: 60 * f, w: 1100 * f, h: 800 * f };
      const tol = 24; // frameless 窗 GetWindowRect 含约 12 物理像素隐形边框（探针01-E）
      const ok = Math.abs(r2.left - expect.x) <= tol && Math.abs(r2.top - expect.y) <= tol
        && Math.abs((r2.right - r2.left) - expect.w) <= tol
        && Math.abs((r2.bottom - r2.top) - expect.h) <= tol;
      rep.log(`改几何重启后 rect(phys)=${r2.left},${r2.top} ${r2.right - r2.left}x${r2.bottom - r2.top}（期望 ${expect.x},${expect.y} ${expect.w}x${expect.h}）`);
      ok
        ? rep.pass('config.json 改动几何后重启面板即反映')
        : rep.fail('config 几何未生效（窗口矩形偏离期望超出容差）');
    } finally {
      if (configBackup === null) { try { fs.unlinkSync(configPath); } catch { /* 尽力 */ } }
      else fs.writeFileSync(configPath, configBackup);
    }
  } catch (e) {
    rep.fail(`电池中断: ${e && e.stack || e}`);
  } finally {
    // —— 清场 ——
    if (notepad) {
      try { w32.PostMessageW(notepad.hwnd, WM_CLOSE, 0, 0); } catch { /* 尽力 */ }
      try { notepad.child.kill(); } catch { /* 尽力 */ }
      await sleep(400);
    }
    await stopPanel();
    restoreDesktop();
    try { w32.SetCursorPos(savedCursor.x, savedCursor.y); } catch { /* 尽力 */ }
  }
  return rep.verdict(rep.fails === 0 ? 'PASS' : 'FAIL');
}

module.exports = function battery() {
  app.whenReady().then(() => main().then((v) => {
    process.exitCode = v.fails > 0 ? 1 : 0;
    setTimeout(() => app.exit(v.fails > 0 ? 1 : 0), 300);
  })).catch((e) => {
    console.error('BATTERY CRASH:', e && e.stack || e);
    app.exit(2);
  });
};
