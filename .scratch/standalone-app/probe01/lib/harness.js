'use strict';
const path = require('path');
const fs = require('fs');
const { spawnSync, spawn } = require('child_process');
const { screen, BrowserWindow, ipcMain, nativeImage } = require('electron');
const win32 = require('./win32');

const ROOT = path.join(__dirname, '..');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function screenInfo() {
  const d = screen.getPrimaryDisplay();
  return {
    factor: d.scaleFactor,
    dipBounds: d.bounds,
    phys: { w: Math.round(d.bounds.width * d.scaleFactor), h: Math.round(d.bounds.height * d.scaleFactor) },
  };
}

// 窗口注册表：ipc 事件按窗口分桶，退出时统一清理
const windows = new Set();
const cleanups = [];
function onCleanup(fn) { cleanups.push(fn); }

function createWindow(opts) {
  const { file, domChannel, events, ...bw } = opts;
  const win = new BrowserWindow({
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    focusable: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
    ...bw,
  });
  windows.add(win);
  win.on('closed', () => windows.delete(win));
  if (domChannel) {
    ipcMain.on(domChannel, (_e, payload) => { events.push({ t: Date.now(), ...payload }); });
  }
  return win.loadFile(path.join(ROOT, 'renderers', file)).then(() => win);
}

function hwndOf(win) {
  const buf = win.getNativeWindowHandle();
  const v = win32.koffi.decode(buf, 'uintptr_t');
  return typeof v === 'bigint' ? Number(v) : v;
}

// 物理像素区域截图（走 DPI 感知的 PowerShell）
function capture(rect, name) {
  const out = path.join(ROOT, 'evidence', name + '.png');
  const r = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(__dirname, 'capture.ps1'),
    '-Out', out, '-X', String(rect.left), '-Y', String(rect.top),
    '-W', String(rect.right - rect.left), '-H', String(rect.bottom - rect.top),
  ], { encoding: 'utf8', timeout: 20000 });
  if (r.status !== 0 || !require('fs').existsSync(out)) {
    throw new Error(`capture 失败: ${r.stdout} ${r.stderr}`);
  }
  return out;
}

// BGRA 位图区域比对：mean/max 绝对差（0..255）
function zoneDiff(imgPathA, imgPathB, zone) {
  const a = nativeImage.createFromPath(imgPathA);
  const b = nativeImage.createFromPath(imgPathB);
  const sa = a.getSize(), sb = b.getSize();
  if (sa.width !== sb.width || sa.height !== sb.height) throw new Error('截图尺寸不一致');
  const ba = a.toBitmap(), bb = b.toBitmap();
  const W = sa.width;
  let sum = 0, n = 0, max = 0, over40 = 0;
  const x0 = Math.max(0, zone.left), y0 = Math.max(0, zone.top);
  const x1 = Math.min(W, zone.right), y1 = Math.min(sa.height, zone.bottom);
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = (y * W + x) * 4;
      const d = (Math.abs(ba[i] - bb[i]) + Math.abs(ba[i + 1] - bb[i + 1]) + Math.abs(ba[i + 2] - bb[i + 2])) / 3;
      sum += d; n++;
      if (d > max) max = d;
      if (d > 40) over40++;
    }
  }
  return { mean: sum / Math.max(1, n), max, over40Pct: 100 * over40 / Math.max(1, n), n };
}

// 区域内接近纯白的像素占比（文字实色证据）
function whitePixels(imgPath, zone, threshold = 200) {
  const img = nativeImage.createFromPath(imgPath);
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

async function cleanupAll() {
  for (const fn of cleanups.reverse()) {
    try { await fn(); } catch { /* 清理尽力而为 */ }
  }
  cleanups.length = 0;
  for (const w of [...windows]) {
    try { if (!w.isDestroyed()) w.destroy(); } catch { /* 同上 */ }
  }
}

// 等待某窗口的 dom 事件数组中出现满足条件的条目
async function waitForEvent(events, pred, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = events.find(pred);
    if (hit) return hit;
    await sleep(40);
  }
  return null;
}

// —— 桌面清场：逐窗 ShowWindow(SW_MINIMIZE)（COM MinimizeAll 对部分应用不可靠）——
// 记录被最小化的窗口，cleanup 时逐窗 SW_RESTORE 精确还原。
const DESKTOP_CLASSES = ['WorkerW', 'Progman', 'SHELLDLL_DefView', 'SysListView32'];
const CLEAR_DESKTOP_SKIP = new Set([
  'Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd',
  'Windows.UI.Core.CoreWindow', 'Windows.Internal.Shell.TabProxyWindow',
]);
const SW_MINIMIZE = 6, SW_RESTORE = 9;
let minimizedForRestore = [];

async function clearDesktop(points = []) {
  const w32 = win32;
  const isDesktopAt = pt => {
    if (!pt) return true;
    const cls = w32.className(w32.windowFromPointRoot(pt));
    return DESKTOP_CLASSES.includes(cls);
  };
  minimizedForRestore = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const h of w32.topLevelWindows()) {
      if (CLEAR_DESKTOP_SKIP.has(w32.className(h))) continue;
      const ex = w32.GetWindowLongW(h, w32.GWL_EXSTYLE);
      if (ex & w32.WS_EX_TOPMOST) continue; // 置顶壳层浮窗不动
      w32.ShowWindow(h, SW_MINIMIZE);
      minimizedForRestore.push(h);
    }
    await sleep(700);
    if (points.every(isDesktopAt)) break;
  }
  onCleanup(restoreDesktop);
}

function restoreDesktop() {
  for (const h of minimizedForRestore.reverse()) {
    try { if (win32.IsWindow(h)) win32.ShowWindow(h, SW_RESTORE); } catch { /* 尽力还原 */ }
  }
  minimizedForRestore = [];
}

// 启动一个真实普通应用窗（优先记事本）：Win11 打包版记事本的窗口不属于启动进程，
// 按「新出现的 Notepad 类窗口」匹配；找不到则用 Electron 普通窗顶替（同为原生顶层窗）。
// 坐标为物理像素。
async function launchOrdinaryApp(report, { x, y, w, h }) {
  const w32 = win32;
  const before = new Set(w32.topLevelWindows().filter(hh => w32.className(hh) === 'Notepad'));
  const np = spawn('notepad.exe', [], { stdio: 'ignore' });
  let hwnd = null;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !hwnd) {
    await sleep(250);
    hwnd = w32.topLevelWindows().find(hh => w32.className(hh) === 'Notepad' && !before.has(hh)) || null;
  }
  let kind = 'notepad';
  if (!hwnd) {
    kind = 'electron-fallback';
    const appWin = await createWindow({
      file: 'sentinel.html', domChannel: 'oa:dom', events: [],
      x: Math.round(x / 2), y: Math.round(y / 2),
      width: Math.round(w / 2), height: Math.round(h / 2),
      transparent: false, frame: true, title: 'PROBE-ORDINARY-APP',
    });
    appWin.showInactive();
    hwnd = hwndOf(appWin);
  }
  w32.SetWindowPos(hwnd, 0, x, y, w, h, w32.SWP_NOZORDER | w32.SWP_NOACTIVATE);
  await sleep(300);
  onCleanup(() => {
    try { w32.PostMessageW(hwnd, 0x0010, 0, 0); } catch { /* 尽力 */ }
    try { np.kill(); } catch { /* 尽力 */ }
  });
  report.note(`普通应用窗: ${kind} hwnd=0x${hwnd.toString(16)} @(${x},${y}) ${w}x${h}`);
  return { hwnd, kind, child: np };
}

module.exports = {
  sleep, screenInfo, createWindow, hwndOf, capture, zoneDiff, whitePixels,
  onCleanup, cleanupAll, waitForEvent, clearDesktop, launchOrdinaryApp,
  ROOT, win32,
};
