'use strict';
// 工单03 验收电池：02 全部行为（透明合成 / 默认穿透 / 热区接收与重钉 / 底部钉扎 / config 几何）
// + 工单03 宿主常驻三件套：单实例守卫（P7）、托盘图标与菜单退出（P8/P10）、Win+D 防抖自动恢复（P9）。
// + 工单04 数据卡片（P2.5）：四类卡片经桥接契约实时刷新 + 历史曲线滚动 + 截图存证。
// + 工单06 编排与推荐（P5.5）：手钉前段 / 新建自动归类 / 拖拽摆位持久化 / 恢复出厂布局。
// 运行：npm run accept（= electron . --accept，控制器与面板同仓库，面板为子进程）。
// 复用工单01 探针的调用形态（探针A/B/C 全绿）：SendInput 虚拟屏归一化坐标、
// WindowFromPoint 经 GetAncestor(GA_ROOT)、GDI 抓屏走 DPI 感知 PowerShell。
const { app, BrowserWindow, screen, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const win32 = require('./lib/win32');
const { Report } = require('./lib/report');

const APP_ROOT = path.resolve(__dirname, '..');
const EVENTS_FILE = path.join(__dirname, 'evidence', '03-runtime-events.jsonl');
const WM_CLOSE = 0x0010;
const VK_LWIN = 0x5b, VK_B = 0x42, VK_D = 0x44, VK_DOWN = 0x28, VK_UP = 0x26, VK_RETURN = 0x0d, VK_ESCAPE = 0x1b;
const VK_CONTROL = 0x11, VK_V = 0x56;
const NOTIFY_ICON_SETTINGS = 'HKCU:\\Control Panel\\NotifyIconSettings';
// 托盘图标的程序化识别色（tray.ts 琥珀 #f5a623 → RGB）
const AMBER = [245, 166, 35];
// 卡片几何须与 src/renderer/index.html 的 .card 布局保持一致（DIP）
const CARD_DIP = { x: 48, y: 48, w: 320, h: 176 }
const LEFT_CARDS_DIP = { x: 48, y: 48, w: 320, h: 686 }   // 时钟+天气+日历（至 734）
// 右列自 07 起顶部是搜索面板（SEARCH 卡 ~89 高 + 会话（工单03 起加高吞掉 Qoder 状态块槽）+ 硬件，底缘至 942）
const RIGHT_CARDS_DIP = { right: 48, y: 48, w: 420, h: 894 }
// 搜索卡几何（与 src/renderer/index.html #search-card 一致；results 展开随事件重取）
const SEARCH_CARD_DIP = { right: 48, y: 48, w: 420, h: 89 }
// 工单05 桌面承载分区几何（与 renderer/index.html #doc-zone / #dock-zone 一致）：
// 文档区 x408 起、max-width 640（满 8 行折右列的列流布局，透明带取样按最宽取 1056）；
// dock 条锚面板底部（bottom:16 + 条高约 94），其上缘随面板高度计算，不设常量。
const DOC_ZONE_RIGHT_DIP = 1056
const DOCK_STRIP_DIP = 110 // 底距 16 + 条高约 94，取样避让余量

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
  if (r.status !== 0 || !fs.existsSync(out)) throw new Error(`capture 失败: status=${r.status} signal=${r.signal} err=${r.error ? r.error.message : '无'} stdout=${r.stdout} stderr=${r.stderr}`);
  return out;
}

// 两张同尺寸实拍的逐像素均值差（0-255；-1 = 尺寸不一致/读取失败）。步进采样全通道，
// 供「面板内容在场 vs 仅壁纸」的粗粒度判定（工单07）。
function meanAbsDiff(pngA, pngB) {
  try {
    const a = nativeImage.createFromPath(pngA);
    const b = nativeImage.createFromPath(pngB);
    const sa = a.getSize(), sb = b.getSize();
    if (sa.width !== sb.width || sa.height !== sb.height || sa.width === 0) return -1;
    const ba = a.toBitmap(), bb = b.toBitmap();
    let sum = 0, n = 0;
    const step = 8 * 4; // 每 8 像素采样一次（BGRA）
    for (let i = 0; i + 3 < ba.length && i + 3 < bb.length; i += step) {
      sum += Math.abs(ba[i] - bb[i]) + Math.abs(ba[i + 1] - bb[i + 1]) + Math.abs(ba[i + 2] - bb[i + 2]);
      n += 3;
    }
    return n ? sum / n : -1;
  } catch {
    return -1;
  }
}

// 遮挡感知命中率（工单04）：只统计 WindowFromPoint 命中参照窗的采样点——
// 电池运行中被用户恢复的普通窗只遮屏不遮断言（面板透明机制与遮挡正交）。
function checkerHitRateAtPoints(pngPath, points) {
  const img = nativeImage.createFromPath(pngPath);
  const s = img.getSize();
  const buf = img.toBitmap();
  const W = s.width;
  let hit = 0, n = 0;
  const tol = 30;
  const colors = [[192, 64, 32], [32, 64, 192]];
  for (const { x, y } of points) {
    if (x < 0 || y < 0 || x >= s.width || y >= s.height) continue;
    const i = (Math.round(y) * W + Math.round(x)) * 4;
    const r = buf[i + 2], g = buf[i + 1], b = buf[i];
    n++;
    for (const [cr, cg, cb] of colors) {
      if (Math.abs(r - cr) <= tol && Math.abs(g - cg) <= tol && Math.abs(b - cb) <= tol) { hit++; break; }
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

// 识别色图标定位（连通簇分析）：琥珀图标由 4 个 8px 方点组成（点间有缝隙，呈 4 个连通簇），
// 且任务栏上可能存在他图标的零星同色像素——全局均值会被拉到簇间空档。取最大簇为种子，
// 合并 48px 内的邻簇再取质心，即图标中心。
function colorIconTarget(pngPath, rgb, tol = 20) {
  const img = nativeImage.createFromPath(pngPath);
  const s = img.getSize();
  const buf = img.toBitmap();
  const W = s.width, H = s.height;
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (Math.abs(buf[i + 2] - rgb[0]) <= tol && Math.abs(buf[i + 1] - rgb[1]) <= tol && Math.abs(buf[i] - rgb[2]) <= tol) mask[y * W + x] = 1;
    }
  }
  const seen = new Uint8Array(W * H);
  const clusters = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      if (!mask[idx] || seen[idx]) continue;
      let n = 0, sx = 0, sy = 0, minx = x, maxx = x, miny = y, maxy = y;
      const q = [idx];
      seen[idx] = 1;
      while (q.length) {
        const c = q.pop();
        const cy = (c / W) | 0, cx = c % W;
        n++; sx += cx; sy += cy;
        minx = Math.min(minx, cx); maxx = Math.max(maxx, cx);
        miny = Math.min(miny, cy); maxy = Math.max(maxy, cy);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const ni = ny * W + nx;
          if (mask[ni] && !seen[ni]) { seen[ni] = 1; q.push(ni); }
        }
      }
      clusters.push({ n, sx, sy, minx, maxx, miny, maxy });
    }
  }
  if (!clusters.length) return null;
  clusters.sort((a, b) => b.n - a.n);
  const seed = clusters[0];
  const scx = (seed.minx + seed.maxx) / 2, scy = (seed.miny + seed.maxy) / 2;
  let hits = 0, sx = 0, sy = 0, nClusters = 0;
  for (const c of clusters) {
    const ccx = (c.minx + c.maxx) / 2, ccy = (c.miny + c.maxy) / 2;
    if (Math.abs(ccx - scx) <= 48 && Math.abs(ccy - scy) <= 48) {
      hits += c.n; sx += c.sx; sy += c.sy; nClusters++;
    }
  }
  if (hits < 40) return null; // 四点合计在 1.0 缩放约 64 像素（1.25 缩放 256）；40 为噪声下限，增量断言另有基线把门
  return { x: Math.round(sx / hits), y: Math.round(sy / hits), hits, nClusters };
}

// —— 托盘常驻件（Win11 纯 XAML 任务栏，无 legacy ToolbarWindow32 可数）——
// 存在性与退出以两层证据断言：注册表 NotifyIconSettings 条目（Shell_NotifyIcon 注册事实源）
// + 识别色像素（程序化琥珀图标 #f5a623，IsPromoted 提升到可见区后可截屏定位）。
const w32FindWindowEx = (parent, after, cls) => win32.FindWindowExW(parent, after, cls, null);

// —— 通知区域注册表（Win11 22H2+）：IsPromoted=1 把溢出区图标提升到任务栏可见区 ——
function psRun(script) {
  return psSpawn(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]);
}

function psRunFile(args) {
  return psSpawn(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ...args]);
}

function psSpawn(args) {
  const r = spawnSync('powershell.exe', args, { encoding: 'utf8', timeout: 15000 });
  if (r.status !== 0) throw new Error(`powershell 失败: ${r.stderr || r.stdout}`);
  return (r.stdout || '').trim();
}

function psJson(script) {
  const s = psRun(script);
  return s ? JSON.parse(s) : null;
}

function listNotifyIcons() {
  const raw = psJson(`$o = @(Get-ChildItem '${NOTIFY_ICON_SETTINGS}' -ErrorAction Stop | ForEach-Object { $p = Get-ItemProperty $_.PSPath; [pscustomobject]@{ key = $_.PSChildName; exe = [string]$p.ExecutablePath; promoted = $p.IsPromoted } }); $o | ConvertTo-Json -Compress`);
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

function setPromoted(key, value) {
  psRun(`Set-ItemProperty -Path '${NOTIFY_ICON_SETTINGS}\\${key}' -Name IsPromoted -Value ${value} -Type DWord -ErrorAction Stop`);
}

function removePromoted(key) {
  psRun(`Remove-ItemProperty -Path '${NOTIFY_ICON_SETTINGS}\\${key}' -Name IsPromoted -ErrorAction Stop`);
}

// IsPromoted 改动登记（P8 提升时记录原值）：restorePromoted 按原值回写/移除，用后清登记
let promotedKey = null;
let promotedOld;

// IsPromoted 还原（P10 finally 与电池清场共用）
function restorePromoted(log = console.error) {
  if (!promotedKey) return;
  try {
    if (promotedOld == null) removePromoted(promotedKey);
    else setPromoted(promotedKey, promotedOld);
    promotedKey = null;
  } catch (e) { log(`IsPromoted 还原失败: ${e && e.message || e}`); }
}

// —— 工单05 桌面承载：电池侧磁盘扫描（与面板扫描对照；用户桌面优先遮蔽同名公共项）——
// 输出编码锁 UTF-8（中文文件名经 PS 默认控制台码页会变 GBK 乱码，首轮电池实测）。
function psDesktopScan() {
  return psJson([
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
    '$u=[Environment]::GetFolderPath("Desktop")',
    '$c=[Environment]::GetFolderPath("CommonDesktopDirectory")',
    '$items=@()',
    'foreach($d in @($u,$c)){',
    '  Get-ChildItem -LiteralPath $d -Force -ErrorAction SilentlyContinue | Where-Object {',
    '    -not ($_.Attributes -band [IO.FileAttributes]::Hidden) -and -not ($_.Attributes -band [IO.FileAttributes]::System)',
    '  } | ForEach-Object { $items += [pscustomobject]@{ dir=$d; name=$_.Name } }',
    '}',
    '[pscustomobject]@{ user=$u; common=$c; items=$items } | ConvertTo-Json -Compress',
  ].join('\n'));
}

// 造验收探针 lnk（ASCII-only 临时 ps1 走 -File：内联 -Command 传 COM 调用在本机
// 实测挂起/静默失败——03 踩坑 1「ps1 一律 ASCII」同源，引号路径不再过 shell 转义层）。
function createProbeLnk(lnkPath, markerPath) {
  const script = [
    '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($args[0])',
    "$s.TargetPath = 'powershell.exe'",
    "$s.Arguments = '-NoProfile -WindowStyle Hidden -Command Set-Content -LiteralPath ' + $args[1] + ' -Value ok'",
    '$s.Save()',
    "Write-Output ('exists=' + (Test-Path -LiteralPath $args[0]))",
  ].join('\n');
  const scriptFile = path.join(__dirname, 'evidence', '05-create-probe-lnk.ps1');
  fs.writeFileSync(scriptFile, script, 'utf8');
  try {
    // -File 模式下未声明 param() 的脚本一切参数按位置进 $args
    return psRunFile([scriptFile, lnkPath, markerPath]);
  } finally {
    try { fs.unlinkSync(scriptFile); } catch { /* 尽力清理 */ }
  }
}

// 造指向指定 exe 的验收 lnk（工单01 图标区分度探针夹具）。与 createProbeLnk 同法：
// ASCII-only 临时 ps1 走 -File（内联 -Command 传 COM 调用在本机实测挂起/静默失败）。
// 不声明图标定位——默认图标留空，决策链走「未声明回落目标可执行文件」分支。
function createShortcutLnk(lnkPath, targetPath) {
  const script = [
    '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($args[0])',
    '$s.TargetPath = $args[1]',
    '$s.Save()',
    "Write-Output ('exists=' + (Test-Path -LiteralPath $args[0]))",
  ].join('\n');
  const scriptFile = path.join(__dirname, 'evidence', '01-create-shortcut-lnk.ps1');
  fs.writeFileSync(scriptFile, script, 'utf8');
  try {
    return psRunFile([scriptFile, lnkPath, targetPath]);
  } finally {
    try { fs.unlinkSync(scriptFile); } catch { /* 尽力清理 */ }
  }
}

// 进程存活探测（pid 退出轮询用）
function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// 在任务栏条带截图中定位本面板托盘图标（识别色图标中心 → 物理屏幕坐标），截图按名存证
function scanAmberInTray(tag) {
  const tb = w32FindWindowEx(0, 0, 'Shell_TrayWnd');
  if (!tb) return null;
  const r = win32.rectOf(tb);
  if (!r) return null;
  const shot = capture(r, `03-tray-${tag}`);
  const c = colorIconTarget(shot, AMBER, 20);
  if (!c) return null;
  return { x: r.left + c.x, y: r.top + c.y, hits: c.hits, nClusters: c.nClusters };
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

// —— 遮挡感知交互前置（工单11）：交互落点必须真被本面板接收——电池一跑数分钟，
// 用户窗口随时抬回 dock 区上空，SendInput 整段被覆盖窗偷走，探针以「无存证」假死
// （真机实证：单击过、9 秒后双击挂；像素级取证落点命中的是覆盖窗而非面板，几何
// 与时序无罪）。命中桌面层（Progman/WorkerW 等）= show desktop 态残留或面板不在
// 屏，最小化覆盖窗无意义，直接带诊断失败；普通覆盖窗按 clearDesktop 同法最小化
// 并记入还原清单，重试至命中。
async function ensurePanelHit(pt, hwnd) {
  for (let i = 0; i < 4; i++) {
    win32.moveMousePhys(pt.x, pt.y);
    await sleep(400); // 热区轮询 25ms，留足解除穿透
    const root = Number(win32.windowFromPointRoot(pt));
    if (root === Number(hwnd)) return { ok: true };
    const cls = win32.className(root);
    if (CLEAR_DESKTOP_SKIP.has(cls)) {
      return { ok: false, why: `落点命中桌面层 ${cls}（show desktop 态残留或面板未在屏）` };
    }
    if (!minimizedForRestore.includes(root)) minimizedForRestore.push(root);
    win32.ShowWindow(root, SW_MINIMIZE);
    await sleep(700);
  }
  const cls = win32.className(Number(win32.windowFromPointRoot(pt)));
  return { ok: false, why: `清场重试后仍被 ${cls} 遮挡` };
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

async function waitPanelWindow(timeoutMs, sinceMs = 0) {
  // 面板自报 pid（boot 事件）：spawn 的 child.pid 在 Electron 父进程下不等于
  // 面板真实主进程 pid（实测），以面板自报为准。sinceMs 之后的 boot 才算数——
  // 电池中途重启面板时事件文件里已有旧 boot（P6 重置过、P10 未重置）。
  const deadline = Date.now() + timeoutMs;
  let boot = null;
  while (Date.now() < deadline) {
    boot = readEvents().filter((e) => e.type === 'boot' && e.t >= sinceMs).pop() || null;
    if (boot) break;
    await sleep(60);
  }
  if (!boot) { console.log('[battery] 未收到 boot 存证'); return null; }
  const pid = boot.pid;
  const winDeadline = Date.now() + timeoutMs;
  while (Date.now() < winDeadline) {
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

// 等某类事件安静 quietMs（工单06）：渲染层按指纹 diff，事件只在变化时发——
// 安静即稳定。06 起使用分数异步就位会让 dock 首拍（名序）在 ~1s 后重排为频次序，
// 拿首拍矩形去点击会点在换位后的别的条目上（首轮电池实证）。
async function waitStable(type, quietMs = 2000, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const evts = readEvents().filter((e) => e.type === type);
    const last = evts.length ? evts[evts.length - 1] : null;
    if (last && Date.now() - last.t >= quietMs) return last;
    await sleep(250);
  }
  return null;
}

// —— 工单07 搜索并入：accept_search 电池（scripts/ 版已随 Tk 窗退役）的探针件 ——

// 窗口标题（win32.js 未导出；与 className 同款 koffi 缓冲形态）
const user32Title = win32.koffi.load('user32.dll');
const GetWindowTextW = user32Title.func('int __stdcall GetWindowTextW(uintptr_t hWnd, uint16 *buf, int nMax)');
function windowTitle(hwnd) {
  const buf = Buffer.alloc(1024);
  const n = GetWindowTextW(hwnd, buf, 512);
  if (n <= 0) return '';
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(buf.readUInt16LE(i * 2));
  return s;
}

// 直连真实 Listary 引擎（旧电池 engine_has_probe_first 平移）：探针文件入索引且排首位。
// 路径比对用 realpath + basename：os.tmpdir() 可能返回 8.3 短名（ANW~1），Listary 报长名。
function engineProbeFirst(word, probePath, token) {
  let realPath = probePath;
  try { realPath = fs.realpathSync(probePath); } catch { /* 文件在，短名比对兜底 */ }
  return new Promise((resolve) => {
    const body = JSON.stringify({ query: word, limit: 8, offset: 0 });
    const req = http.request({
      host: '127.0.0.1', port: 38431, path: '/api/v1/search', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 3000, agent: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const rows = payload && payload.data && payload.data.results;
          resolve(Array.isArray(rows) && rows.length > 0
            && path.basename(String(rows[0].path || '')).toLowerCase() === word.toLowerCase()
            && String(rows[0].path || '').toLowerCase().includes(String(token).toLowerCase()));
        } catch { resolve(false); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end(body);
  });
}

// 找一个必死的本机端口（ENGINE OFFLINE 注入用）：listen(0) 占位后立即释放
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function clipboardGet() {
  try { return psRun('Get-Clipboard -Raw -ErrorAction SilentlyContinue'); } catch { return ''; }
}

function clipboardSet(text) {
  try { psRun(`Set-Clipboard -Value '${String(text).replace(/'/g, "''")}'`); } catch { /* 尽力 */ }
}

async function main() {
  const rep = new Report('03-battery');
  const w32 = win32;
  const si = screenInfo();
  const f = si.factor;
  rep.note(`screen: phys ${si.phys.w}x${si.phys.h} @ factor ${f}`);
  try { fs.unlinkSync(EVENTS_FILE); } catch { /* 首次不存在 */ }

  // 托盘基线：面板启动前扫一次任务栏识别色（P8 以后续增量断言图标可见，P10 以退出后回落断言消失）
  const amberBase = scanAmberInTray('baseline');
  rep.note(`托盘识别色基线：${amberBase ? `命中 ${amberBase.hits} 像素 @(${amberBase.x},${amberBase.y})` : '无琥珀像素'}`);
  // 原生图标显隐基线（工单05）：电池不得改变用户电池前的偏好状态
  const iconsVisibleBase = w32.desktopIconsVisible();
  rep.note(`原生桌面图标基线：visible=${iconsVisibleBase}`);

  const savedCursor = w32.cursor();
  const safePt = { x: 40 * f, y: si.phys.h - 40 };
  await clearDesktop([safePt], f);
  w32.moveMousePhys(safePt.x, safePt.y);

  let child = null;
  let panelPid = null;
  let notepad = null;
  let stderrTail = '';
  let searchProbeDir = null; // P7S 探针目录（记事本标签占着句柄，末尾关窗后再删）

  // —— 工单06 编排验收预置：备份并种子摆位存储（手钉一个真实桌面 lnk，占 dock 前段可断言）。
  // 电池不得改变用户真实摆位：清场时还原/删除。userData 与面板同 app 名（同仓库 electron .）。
  const userDataDir = app.getPath('userData');
  const layoutFile = path.join(userDataDir, 'layout.json');
  const layoutBackup = fs.existsSync(layoutFile) ? fs.readFileSync(layoutFile, 'utf8') : null;
  const seedScan = psDesktopScan();
  const pinnedSeed = (seedScan.items.find((i) => i.dir === seedScan.user && /\.lnk$/i.test(i.name)) || {}).name || null;
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(layoutFile, JSON.stringify({ version: 1, pinned: pinnedSeed ? [pinnedSeed] : [], dock: [], docs: [] }, null, 1) + '\n');
  rep.note(`摆位存储已种子：pinned=[${pinnedSeed ?? '用户桌面无 lnk（手钉断言将降级失败）'}]`);

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
    let hwnd = await waitPanelWindow(20000);
    if (!hwnd) throw new Error(`20s 内未见面板窗口\nstderr:\n${stderrTail}`);
    panelPid = win32.threadIdOf(hwnd).pid;
    const rect = w32.rectOf(hwnd);
    rep.note(`panel hwnd=0x${hwnd.toString(16)} rect(phys)=${rect.left},${rect.top} ${rect.right - rect.left}x${rect.bottom - rect.top}`);
    await sleep(1200);

    // —— 电池共用探针件（06 复位 / 08 设置浮层共用；hwnd 随重启段更新，闭包取现值）——
    const CONFIG_FILE_B = path.join(APP_ROOT, 'config.json');
    const pctOf = (v) => Math.round(v * 100);
    // 热区矩形按**面板代次**取：面板重启后旧矩形不再作数（几何虽同，上一任面板的热区
    // 属于上一任现场）。sinceMs 缺省 0 = 全部历史，与旧行为同。
    const latestZoneOf = (id, sinceMs = 0) => {
      const evts = readEvents().filter((e) => e.type === 'hotzones' && e.t >= sinceMs && (e.rects || []).some((r) => r.id === id));
      const last = evts[evts.length - 1];
      return last ? (last.rects || []).find((r) => r.id === id) || null : null;
    };
    /** 最近一次面板启动时刻（boot 存证自报 pid 的那次）——重启后面板代次的下界 */
    const lastBootMs = () => {
      const hits = readEvents().filter((e) => e.type === 'boot');
      return hits.length ? hits[hits.length - 1].t : 0;
    };
    const lastEvent = (type, pred, sinceMs = 0) => {
      const hits = readEvents().filter((e) => e.type === type && e.t >= sinceMs && (!pred || pred(e)));
      return hits.length ? hits[hits.length - 1] : null;
    };
    const ptOfZoneAt = (winRect, z) => ({ x: winRect.left + Math.round((z.x + z.w / 2) * f), y: winRect.top + Math.round((z.y + z.h / 2) * f) });
    const occludedClickAt = async (pt, label) => {
      w32.moveMousePhys(pt.x, pt.y);
      await sleep(350);
      // 命中取证：面板应为 WindowFromPoint 结果（热区已解除穿透）；非面板=通知横幅/用户窗遮挡
      const hit = w32.windowFromPointRoot(pt);
      if (hit !== hwnd) rep.note(`${label} 点击前遮挡探测：命中 ${w32.className(hit)} pid=${w32.threadIdOf(hit).pid}（继续点击，事件门判定）`);
      w32.clickPhys(pt.x, pt.y, 'left');
    };
    const backupConfigB = () => (fs.existsSync(CONFIG_FILE_B) ? fs.readFileSync(CONFIG_FILE_B, 'utf8') : null);
    const restoreConfigB = (backup) => {
      if (backup === null) { try { fs.unlinkSync(CONFIG_FILE_B); } catch { /* 尽力 */ } }
      else { try { fs.writeFileSync(CONFIG_FILE_B, backup); } catch { /* 尽力 */ } }
    };
    const fullShot = (name) => capture({ left: 0, top: 0, right: si.phys.w, bottom: si.phys.h }, name);

    // 电池自己的对照记事本铺在 phys(1000,200) 1400x900，而设置入口（settings-btn
    // DIP 944..1052、面板右下）折算后正落在同一片区域 → 落点被记事本吃掉、点击根本
    // 到不了面板，设置浮层永远开不起来（工单11 真机实证：P6 复位与 P8 开层两组断言
    // 连报未开层，遮挡探测命中 Notepad）。P9 会话行段已有同款处置，但那里是把记事本
    // 直接关掉——本段之后 P9 的 Win+D 演练还要靠它活着，故改为「收起→探针→还原」，
    // 与 P7S 搜索段的挪位还原同一取向。只动 notepad 变量记录的这一扇，不按类名遍历全机。
    //
    // 与模块级 clearDesktop/restoreDesktop 形状相似但**故意不合并**：后者是开局那次
    // 全桌面扫描（带「直到采样点命中桌面」的重试语义），且其还原清单由电池末尾的
    // finally 一次性消费；这里要的是可反复调用的、只针对电池自己那一扇窗的收放。
    const withControlWindowClear = async (fn) => {
      if (!notepad) return fn();
      w32.ShowWindow(notepad.hwnd, SW_MINIMIZE);
      await sleep(500);
      try {
        return await fn();
      } finally {
        try { w32.ShowWindow(notepad.hwnd, SW_RESTORE); } catch { /* 尽力 */ }
        await sleep(500);
      }
    };

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
    // 清场后又被用户恢复的普通窗会盖住取样带（工单04 实拍：运行中被恢复的视频窗）
    // ——截图前对非本电池/非面板的普通窗再做一轮最小化，不碰参照窗与桌面层
    for (const h of w32.topLevelWindows()) {
      if (CLEAR_DESKTOP_SKIP.has(w32.className(h))) continue;
      const pid = w32.threadIdOf(h).pid;
      if (pid === process.pid || pid === panelPid) continue;
      const ex = w32.GetWindowLongW(h, w32.GWL_EXSTYLE);
      if (ex & w32.WS_EX_TOPMOST || w32.IsIconic(h)) continue;
      w32.ShowWindow(h, SW_MINIMIZE);
      minimizedForRestore.push(h);
    }
    await sleep(1000);

    const localCard = {
      left: CARD_DIP.x * f, top: CARD_DIP.y * f,
      right: (CARD_DIP.x + CARD_DIP.w) * f, bottom: (CARD_DIP.y + CARD_DIP.h) * f,
    };
    const panelW = rect.right - rect.left;
    const workBottom = Math.round((si.workArea.y + si.workArea.height) * f) - 8 - rect.top;
    // 透明区取样带须避开两侧卡片列（04 起左列至 x368、右列自 w-468 起）与桌面承载分区
    // （05 起文档区至 x616、dock 条自 y≈882——否则卡片/条目底色拉低命中率）
    const leftColRight = Math.round((LEFT_CARDS_DIP.x + LEFT_CARDS_DIP.w) * f) + Math.round(8 * f)
    const rightColLeft = panelW - Math.round((RIGHT_CARDS_DIP.right + RIGHT_CARDS_DIP.w) * f) - Math.round(8 * f)
    const transparentZone = {
      left: Math.max(Math.round(DOC_ZONE_RIGHT_DIP * f) + Math.round(8 * f), leftColRight),
      top: 8, right: Math.max(rightColLeft, leftColRight + Math.round(200 * f)),
      bottom: Math.min(workBottom, Math.round(((rect.bottom - rect.top) / f - DOCK_STRIP_DIP) * f)),
    };
    // shell 浮层（快捷设置等）是 TOPMOST，会挡住面板透明区（03 迭代 8 实拍 87.1% 即此因）：
    // 截图前 ESC 收层，命中率不足再重拍一次取后值
    w32.tapKeys([0x1b]);
    await sleep(400);
    // 采样点先经 WindowFromPoint 过滤：只取面板之下确为参照窗的点（遮挡感知，工单04）
    const probePoints = [];
    for (let y = transparentZone.top + 8; y < transparentZone.bottom - 8; y += 16) {
      for (let x = transparentZone.left + 8; x < transparentZone.right - 8; x += 16) {
        if (w32.windowFromPointRoot({ x: rect.left + x, y: rect.top + y }) === checkerHwnd) probePoints.push({ x, y });
      }
    }
    rep.note(`透明区采样点 ${probePoints.length} 个命中参照窗（其余被用户窗遮挡的点不计）`);
    const shot = capture(rect, '02-transparent-on-checker');
    let chk = checkerHitRateAtPoints(shot, probePoints);
    if (chk.rate <= 0.9 && probePoints.length >= 500) {
      w32.tapKeys([0x1b]);
      await sleep(800);
      const shot2 = capture(rect, '02-transparent-on-checker');
      const chk2 = checkerHitRateAtPoints(shot2, probePoints);
      rep.note(`首拍命中率 ${(chk.rate * 100).toFixed(1)}% 疑浮层遮挡，ESC 后重拍 ${(chk2.rate * 100).toFixed(1)}%`);
      chk = chk2;
    }
    rep.log(`透明区棋盘色命中率: ${(chk.rate * 100).toFixed(1)}% (样本 ${chk.n})`);
    probePoints.length >= 500 && chk.rate > 0.9
      ? rep.pass('透明合成：面板透明区透出其下参照窗（壁纸可见性的机制保证）')
      : rep.fail(probePoints.length < 500
        ? `参照窗几乎被用户窗全遮（有效采样点仅 ${probePoints.length}），透明断言不可判`
        : `透明区未透出参照窗（命中率 ${(chk.rate * 100).toFixed(1)}%）`);
    const wp = whitePixels(shot, localCard);
    wp.hit > 30
      ? rep.pass(`时钟卡白色文字像素 ${wp.hit}/${wp.n}（文字实色清晰）`)
      : rep.fail(`时钟卡白色文字像素不足 ${wp.hit}/${wp.n}`);
    checker.destroy();
    await sleep(600);
    capture(rect, '02-on-wallpaper');
    rep.note('实拍面板叠真壁纸（观感存证；动态壁纸逐帧不同，不做像素断言）');

    // —— P2.5 工单04 数据卡片：四类卡片经桥接契约上线并实时刷新 ——
    {
      const sessionsEvt = await waitEvent('sessions-rendered', null, 8000);
      sessionsEvt
        ? rep.pass(`会话列表卡：渲染层收到内核会话数据（count=${sessionsEvt.count}，真机活跃池）`)
        : rep.fail('会话列表卡：未收到 sessions-rendered 存证');
      const hw2 = await waitEvent('hardware-rendered', (e) => e.n >= 2, 8000);
      hw2
        ? rep.pass(`硬件指标卡：面板 1Hz 刷新持续走数（第 ${hw2.n} 次渲染）`)
        : rep.fail('硬件指标卡：未见第二次渲染（实时刷新未证实）');
      const historyLive = await waitEvent('history-live', null, 10000);
      historyLive
        ? rep.pass(`历史曲线滚动窗口上线（cpu 历史已积累 ${historyLive.len} 点，300 点上限契约）`)
        : rep.fail('历史曲线未见积累（无 history-live 存证）');
      const weatherOk = await waitEvent('weather-rendered', null, 15000);
      if (weatherOk) {
        rep.pass(`天气卡：Open-Meteo 取数成功（weather_code=${weatherOk.code} temp=${weatherOk.temp}）`);
      } else {
        const weatherErr = readEvents().find((e) => e.type === 'weather-error');
        weatherErr
          ? rep.note(`天气卡取数失败（网络相关，不作硬断言）：${weatherErr.message}`)
          : rep.fail('天气卡：既无 weather-rendered 也无 weather-error（卡片逻辑未运行）');
      }
      const leftZone = {
        left: rect.left + Math.round((LEFT_CARDS_DIP.x - 8) * f),
        top: rect.top + Math.round((LEFT_CARDS_DIP.y - 8) * f),
        right: rect.left + Math.round((LEFT_CARDS_DIP.x + LEFT_CARDS_DIP.w + 8) * f),
        bottom: rect.top + Math.round((LEFT_CARDS_DIP.y + LEFT_CARDS_DIP.h + 8) * f),
      };
      const rightZone = {
        left: rect.right - Math.round((RIGHT_CARDS_DIP.right + RIGHT_CARDS_DIP.w + 8) * f),
        top: rect.top + Math.round((RIGHT_CARDS_DIP.y - 8) * f),
        right: rect.right - Math.round((RIGHT_CARDS_DIP.right - 8) * f),
        bottom: rect.top + Math.round((RIGHT_CARDS_DIP.y + RIGHT_CARDS_DIP.h + 8) * f),
      };
      capture(leftZone, '04-cards-left');
      capture(rightZone, '04-cards-right');
      rep.note('卡片实拍存证：04-cards-left.png（时钟/天气/日历）、04-cards-right.png（会话/硬件曲线）');
    }


    // —— P3 默认穿透：左键/右键直达桌面 ——
    const ex = w32.GetWindowLongW(hwnd, w32.GWL_EXSTYLE);
    rep.log(`穿透态 EXSTYLE=0x${(ex >>> 0).toString(16)}`);
    (ex & w32.WS_EX_TRANSPARENT) && (ex & w32.WS_EX_LAYERED)
      ? rep.pass('默认穿透：窗口样式含 WS_EX_TRANSPARENT|WS_EX_LAYERED')
      : rep.fail('默认穿透：窗口样式缺少预期位');
    // 空落点选文档区右侧、右列卡片左侧的空带（05 起文档区占 x408..616，原 560 落其内）
    const emptyPt = { x: 700 * f, y: 300 * f };
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
    // 工单10 起卡片由插件异步挂载：首拍热区快照里还没有它们，必须等**声明了 clock-card 的那一拍**，
    // 否则会把「插件尚未挂上」误判成「渲染层没声明热区」（真机踩过，10b 回归）。
    const zones = await waitEvent('hotzones', (e) => (e.rects || []).some((r) => r.id === 'clock-card'));
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
    // 工单02 永不顶起：回归线前移到点击瞬间——点击后面板必须仍在记事本之下、前台未变、
    // 窗口带不可激活扩展样式（现状是「点击即顶起、离开热区才重钉」，改后点击瞬间就不顶起）。
    const exAfterClick = w32.GetWindowLongW(hwnd, w32.GWL_EXSTYLE);
    const fgAfterClick = w32.GetForegroundWindow();
    wfp(overlap) === notepad.hwnd
      ? rep.pass('永不顶起：热区点击瞬间面板仍在记事本之下（回归线自「离开重钉后」前移到点击瞬间）')
      : rep.fail(`点击瞬间重叠点命中 0x${wfp(overlap).toString(16)}(${w32.className(wfp(overlap))})，面板被点击顶起`);
    fgAfterClick === notepad.hwnd
      ? rep.pass('永不顶起：点击未抢走工作窗口前台（键盘焦点留在记事本，可继续盲打）')
      : rep.fail(`点击后前台变为 0x${fgAfterClick.toString(16)}(${w32.className(fgAfterClick)})，点击抢了前台`);
    exAfterClick & w32.WS_EX_NOACTIVATE
      ? rep.pass(`永不激活：面板窗口样式含 WS_EX_NOACTIVATE（EXSTYLE=0x${(exAfterClick >>> 0).toString(16)}，点击不激活的机制保证）`)
      : rep.fail(`面板无 WS_EX_NOACTIVATE 样式（EXSTYLE=0x${(exAfterClick >>> 0).toString(16)}）`);
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
      ? rep.pass('热区交互全程面板未顶起：记事本始终盖住面板（离开重钉路径保留，在永不顶起语义下是冗余保险）')
      : rep.fail(`热区交互后重叠点命中 0x${wfp(overlap).toString(16)}(${w32.className(wfp(overlap))})，面板不在记事本之下`);
    const z = w32.topLevelWindows();
    const zPanel = z.indexOf(hwnd), zNp = z.indexOf(notepad.hwnd);
    zPanel > zNp
      ? rep.pass(`底部钉扎 z 序：面板(${zPanel}) 在记事本(${zNp}) 之下（自顶向下枚举序）`)
      : rep.fail(`z 序异常：面板=${zPanel} 记事本=${zNp}`);
    capture({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }, '02-pinned-bottom');

    // —— P5 工单05 桌面承载：条目一致性 / 图标隐藏 / 单击选中 / lnk 双击启动 / 杀进程还原 ——
    {
      const rendered = await waitEvent('desktop-rendered', null, 8000);
      const scan = psDesktopScan();
      const userNames = scan.items.filter((i) => i.dir === scan.user).map((i) => i.name);
      const commonNames = scan.items.filter((i) => i.dir === scan.common).map((i) => i.name);
      const userSet = new Set(userNames);
      const expected = [...userSet, ...commonNames.filter((n) => !userSet.has(n))];
      if (!rendered) {
        rep.fail('桌面承载：未收到 desktop-rendered 存证');
      } else {
        const panelSet = new Set(rendered.names || []);
        const missing = expected.filter((n) => !panelSet.has(n));
        const extra = (rendered.names || []).filter((n) => !userSet.has(n) && !commonNames.includes(n));
        missing.length === 0 && extra.length === 0
          ? rep.pass(`条目集合与磁盘扫描一致：${expected.length} 项（用户桌面 ${userNames.length} + 公共桌面独有 ${expected.length - userNames.length}，电池对照）`)
          : rep.fail(`条目集合不一致：缺 ${JSON.stringify(missing)} 多 ${JSON.stringify(extra)}`);
        rep.note(`公共桌面 ${commonNames.length} 项（同名被用户桌面遮蔽 ${commonNames.length - (expected.length - userNames.length)} 项）`);
      }

      const hiddenNow = !w32.desktopIconsVisible();
      hiddenNow
        ? rep.pass('原生桌面图标已隐藏（SysListView32 不可见）——桌面无「两套图标」')
        : rep.fail('原生桌面图标未隐藏（SysListView32 仍可见）');
      capture({ left: 0, top: 0, right: si.phys.w, bottom: si.phys.h }, '05-icons-hidden');
      rep.note('面板承载实拍：05-icons-hidden.png（原生图标隐藏 + dock 应用区/文档区自绘）');

      // 单击选中态（dock 首个条目）。矩形必须取安静后的最新一拍：06 起分数异步
      // 就位会让 dock 在 boot 后 ~1s 重排，首拍矩形会指向换位后的别的条目。
      const stableSel = await waitStable('desktop-rendered', 1500, 8000);
      const appRect = stableSel && (stableSel.rects || []).find((r) => r.zone === 'app' && r.rect);
      if (!appRect) {
        rep.fail('desktop-rendered 未带 app 条目矩形（选中态不可测）');
      } else {
        const cx = rect.left + Math.round((appRect.rect.x + appRect.rect.w / 2) * f);
        const cy = rect.top + Math.round((appRect.rect.y + appRect.rect.h / 2) * f);
        const hitSel = await ensurePanelHit({ x: cx, y: cy }, hwnd);
        if (!hitSel.ok) {
          rep.fail(`单击选中前置失败：${hitSel.why}`);
        } else {
          w32.clickPhys(cx, cy, 'left');
          const sel = await waitEvent('desktop-selected', (e) => e.name === appRect.name, 4000);
          sel
            ? rep.pass(`单击选中态：dock 条目「${appRect.name}」选中并上报存证`)
            : rep.fail('单击未见 desktop-selected 存证');
        }
        capture({
          left: rect.left + Math.round((appRect.rect.x - 70) * f), top: rect.top + Math.round((appRect.rect.y - 40) * f),
          right: rect.left + Math.round((appRect.rect.x + appRect.rect.w + 70) * f), bottom: rect.top + Math.round((appRect.rect.y + appRect.rect.h + 50) * f),
        }, '05-dock-selected');
        w32.moveMousePhys(safePt.x, safePt.y);
        await sleep(300);
      }

      // 双击验收探针 lnk：造唯一名 → 入池 → 静置矩形 → 遮挡校验 → 双击启动 → 标记实证 → 清理。
      // 工单11 两处修：矩形改取 waitStable 静置拍（首拍后 dock 分数异步重排会换位，
      // 首拍矩形点在换位后的空档上）；交互前 ensurePanelHit（真机实证：用户窗口抬起
      // 盖住 dock 区时 SendInput 整段被偷走，探针以「无存证」假死）。
      const probeName = `DECK-PROBE-${Date.now()}.lnk`;
      const lnkPath = path.join(scan.user, probeName);
      const markerPath = path.join(__dirname, 'evidence', `05-marker-${Date.now()}.txt`);
      try {
        createProbeLnk(lnkPath, markerPath);
        const shown = await waitEvent('desktop-rendered', (e) => (e.names || []).includes(probeName), 8000);
        shown
          ? rep.pass(`新建探针 lnk 入池：${probeName}（1Hz 重扫描自动出现）`)
          : rep.fail('新建探针 lnk 未入池（desktop-rendered 未见）');
        const settledProbe = await waitStable('desktop-rendered', 1500, 8000);
        const probeRect = settledProbe && (settledProbe.rects || []).find((r) => r.name === probeName && r.rect);
        if (probeRect) {
          const cx = rect.left + Math.round((probeRect.rect.x + probeRect.rect.w / 2) * f);
          const cy = rect.top + Math.round((probeRect.rect.y + probeRect.rect.h / 2) * f);
          const hitDbl = await ensurePanelHit({ x: cx, y: cy }, hwnd);
          if (!hitDbl.ok) {
            rep.fail(`双击启动前置失败：${hitDbl.why}`);
          } else {
            w32.clickPhys(cx, cy, 'left');
            await sleep(90); // 第二击须落在 GetDoubleClickTime（默认 500ms）内
            w32.clickPhys(cx, cy, 'left');
            w32.moveMousePhys(safePt.x, safePt.y);
            const launched = await waitEvent('desktop-launched', (e) => e.name === probeName, 6000);
            launched && launched.ok
              ? rep.pass('双击启动：探针 lnk 经桥接 desktop/launch 启动（ok=true）')
              : rep.fail(`双击启动存证异常：${JSON.stringify(launched)}`);
            let markerOk = false;
            const markerDeadline = Date.now() + 10000;
            while (Date.now() < markerDeadline && !markerOk) {
              try { markerOk = fs.readFileSync(markerPath, 'utf8').trim() === 'ok'; } catch { markerOk = false; }
              if (!markerOk) await sleep(250);
            }
            markerOk
              ? rep.pass('双击验收探针 lnk 启动成功（目标进程写标记文件实证）')
              : rep.fail('探针 lnk 目标 10s 内未写标记文件（启动未实证）');
          }
        } else {
          rep.fail('探针 lnk 条目无矩形（无法双击）');
        }
      } finally {
        try { fs.unlinkSync(lnkPath); } catch { /* 尽力清理 */ }
      }
      const gone = await waitEvent('desktop-rendered', (e) => !(e.names || []).includes(probeName), 6000);
      gone
        ? rep.pass('清理探针 lnk 后条目同步消失（面板与磁盘一致）')
        : rep.fail('清理探针 lnk 后条目未消失');
      try { fs.unlinkSync(markerPath); } catch { /* 尽力清理 */ }

      // —— P5-ICON 工单01 快捷方式真实图标：不同快捷方式的图标 dataUrl 互不相等（spec 防回归线）——
      // 根因（.scratch/icon-probe 实证）：本机 Electron getFileIcon 对一切 .lnk 返回字节级相同的
      // 通用图标，对目标本体直取正常。修法在适配层提取链：lnk 先解析图标源再对本体提取。
      // 夹具法不依赖用户桌面内容：现场造两条指向不同真 exe（notepad/charmap）的 lnk，
      // 等面板扫描指纹翻转（desktop-rendered 只在变化时发，带入夹具名即翻转）后，
      // 经控制器内桥接取 desktop/icon 断言互不相等；结束删夹具，等条目同步消失。
      {
        const tIcon = Date.now();
        const sysRoot = process.env.SystemRoot || 'C:\\Windows';
        const fixtureDefs = [
          { name: `DECK-ICON-${tIcon}-NOTEPAD.lnk`, target: path.join(sysRoot, 'notepad.exe') },
          { name: `DECK-ICON-${tIcon}-CHARMAP.lnk`, target: path.join(sysRoot, 'System32', 'charmap.exe') },
        ].filter((fx) => fs.existsSync(fx.target));
        const fixturePaths = fixtureDefs.map((fx) => path.join(scan.user, fx.name));
        try {
          if (fixtureDefs.length < 2) {
            rep.fail(`图标区分度探针前置失败：目标 exe 缺失（${fixtureDefs.map((fx) => fx.target).join(', ')}）`);
          } else {
            for (const fx of fixtureDefs) createShortcutLnk(path.join(scan.user, fx.name), fx.target);
            const joined = await waitEvent('desktop-rendered',
              (e) => e.t >= tIcon && fixtureDefs.every((fx) => (e.names || []).includes(fx.name)), 10000);
            joined
              ? rep.note(`图标夹具入池，面板扫描指纹已翻转：${fixtureDefs.map((fx) => fx.name).join(' / ')}`)
              : rep.fail('图标夹具未入池（desktop-rendered 10s 未见夹具名，图标断言不可信）');
            if (joined) {
              // 控制器内桥接：进程内内核（kernel.ts 契约缝先例）+ 真源桌面装配——
              // 提取链与面板同一份代码（dist 构建产物，npm run accept 先 build）。
              // 定时器全关；usage/store 假源隔离，不触真实 usage 目录与摆位存储。
              const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-icon-probe-'));
              const { createKernel } = require(path.join(APP_ROOT, 'dist', 'main', 'kernel.js'));
              const ctx = createKernel({
                tickIntervalMs: 0, hardwareIntervalMs: 0, usageIntervalMs: 0, searchIntervalMs: 0,
                desktop: { storeFile: path.join(probeDir, 'layout.json') },
                usage: {
                  dir: path.join(probeDir, 'usage'),
                  deps: { runningPidExes: () => new Map(), foregroundExe: () => null, readPrior: async () => new Map() },
                },
              });
              await ctx.start();
              try {
                const snap = await ctx.bridge.invoke('panel/snapshot', null);
                const byName = new Map((snap.desktop.items || []).map((i) => [i.name, i]));
                const urls = [];
                for (const fx of fixtureDefs) {
                  const item = byName.get(fx.name);
                  if (!item) { rep.fail(`控制器内核扫描未见夹具 ${fx.name}（桌面根与面板不一致）`); urls.push(null); continue; }
                  const res = await ctx.bridge.invoke('desktop/icon', { key: item.iconKey });
                  urls.push(res && res.dataUrl);
                }
                const okPair = urls.every((u) => typeof u === 'string' && u.startsWith('data:image/') && u.length > 0);
                okPair && urls[0] !== urls[1]
                  ? rep.pass(`快捷方式真实图标：两条夹具经桥接 desktop/icon 取得的 dataUrl 互不相等`
                    + `（notepad ${urls[0].length}B / charmap ${urls[1].length}B——lnk 绕行提取链生效，通用图标回归即二者同串）`)
                  : rep.fail(`图标区分度未过：dataUrl=${JSON.stringify(urls.map((u) => (u ? `${u.slice(0, 24)}…(${u.length}B)` : null)))}`);
              } finally {
                await ctx.stop();
                try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
              }
            }
          }
        } finally {
          for (const p of fixturePaths) { try { fs.unlinkSync(p); } catch { /* 尽力清理 */ } }
          // 清场存证按时间下限取：历史 desktop-rendered 天然不含夹具名，须只认夹具创建之后的拍
          const tClean = Date.now();
          const goneFixtures = await waitEvent('desktop-rendered',
            (e) => e.t >= tClean && fixtureDefs.every((fx) => !(e.names || []).includes(fx.name)), 6000);
          goneFixtures
            ? rep.pass('图标夹具清理后条目同步消失（面板与磁盘一致）')
            : rep.note('图标夹具清理存证未到（不阻塞；夹具已尽力删除）');
        }
      }

      // —— P5-ICON2 工单06 巨型 exe 图标兜底 + 文件夹目标：提取链不得退化为通用图标 ——
      // 根因（探针实证）：getFileIcon（SHGetFileInfo 路径）对 ~235MB 级 exe 确定性返回通用
      // 应用图标（三只 exe 字节级同串、新路径副本仍复现）；.lnk 目标为文件夹时 isFile 判定
      // 误杀。修法：文件本体先走 SHDefExtractIconW 直取（icon-ffi.ts），目录回落 getFileIcon。
      // 断言法（沿工单01 区分度思路）：巨型 exe 夹具图标互不相等且 ≠ 文档基线（退化为通用
      // 即同串）；目录夹具图标 ≠ 文档基线（误杀回归即同串）。巨型 exe 不在本机时如实降级。
      {
        const t2 = Date.now();
        const dirFx = path.join(scan.user, `DECK-ICON2-${t2}-DIR.dirfx`);
        const txtFx = path.join(scan.user, `DECK-ICON2-${t2}-TXT.txt`);
        const giantDefs = [
          ['KIMI', 'C:\\Users\\HUAWEI\\AppData\\Local\\Programs\\kimi-desktop\\Kimi.exe'],
          ['DSH', 'D:\\programs\\dsh\\DeepSeek Harness.exe'],
          ['MMX', 'D:\\programs\\MMXcode\\MiniMax Code\\MiniMax Code.exe'],
        ].map(([tag, p]) => ({ name: `DECK-ICON2-${t2}-${tag}.lnk`, target: p })).filter((fx) => fs.existsSync(fx.target));
        const dirLnkName = `DECK-ICON2-${t2}-DIRLNK.lnk`;
        const allNames = [dirLnkName, path.basename(txtFx), ...giantDefs.map((fx) => fx.name)];
        try {
          fs.mkdirSync(dirFx, { recursive: true });
          fs.writeFileSync(txtFx, 'deck icon probe');
          createShortcutLnk(path.join(scan.user, dirLnkName), dirFx);
          for (const fx of giantDefs) createShortcutLnk(path.join(scan.user, fx.name), fx.target);
          const joined = await waitEvent('desktop-rendered',
            (e) => e.t >= t2 && allNames.every((n) => (e.names || []).includes(n)), 10000);
          joined
            ? rep.note(`工单06 夹具入池：目录 lnk / txt 基线 / 巨型 exe×${giantDefs.length}`)
            : rep.fail('工单06 夹具未入池（desktop-rendered 10s 未见夹具名，图标断言不可信）');
          if (joined) {
            const probeDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-icon6-probe-'));
            const { createKernel } = require(path.join(APP_ROOT, 'dist', 'main', 'kernel.js'));
            const ctx2 = createKernel({
              tickIntervalMs: 0, hardwareIntervalMs: 0, usageIntervalMs: 0, searchIntervalMs: 0,
              desktop: { storeFile: path.join(probeDir2, 'layout.json') },
              usage: {
                dir: path.join(probeDir2, 'usage'),
                deps: { runningPidExes: () => new Map(), foregroundExe: () => null, readPrior: async () => new Map() },
              },
            });
            await ctx2.start();
            try {
              const snap2 = await ctx2.bridge.invoke('panel/snapshot', null);
              const byName2 = new Map((snap2.desktop.items || []).map((i) => [i.name, i]));
              const grab = async (name) => {
                const item = byName2.get(name);
                if (!item) return null;
                const res = await ctx2.bridge.invoke('desktop/icon', { key: item.iconKey });
                return res && res.dataUrl;
              };
              const txtUrl = await grab(path.basename(txtFx));
              const dirUrl = await grab(dirLnkName);
              const giantUrls = [];
              for (const fx of giantDefs) giantUrls.push({ tag: fx.name, url: await grab(fx.name) });
              // 文档基线必须先到手（它是一切「≠ 通用」断言的锚）
              txtUrl
                ? rep.pass(`文档基线夹具取得图标（${txtUrl.length}B）`)
                : rep.fail('txt 基线夹具未取得图标（扫描或提取链异常）');
              // 目录目标：真目录图标 ≠ 文档基线（isFile 误杀回归 = 二者同串）
              dirUrl && txtUrl && dirUrl !== txtUrl
                ? rep.pass(`目录目标 lnk 显示目录图标（${dirUrl.length}B ≠ 文档基线——文件夹目标不再被 isFile 误杀）`)
                : rep.fail(`目录目标退化为文档基线或未取得：dir=${dirUrl ? dirUrl.length + 'B' : 'null'} txt=${txtUrl ? txtUrl.length + 'B' : 'null'}`);
              // 巨型 exe：互不相等且 ≠ 文档基线（SHGetFileInfo 退化回归 = 同串）
              if (giantDefs.length >= 2) {
                const urls = giantUrls.map((g) => g.url);
                const allGot = urls.every((u) => typeof u === 'string' && u.startsWith('data:image/'));
                const distinct = allGot && txtUrl && new Set([...urls, txtUrl]).size === urls.length + 1;
                distinct
                  ? rep.pass(`巨型 exe 图标兜底：${giantUrls.map((g) => `${g.tag} ${g.url.length}B`).join(' / ')}——互不相等且 ≠ 文档基线（getFileIcon 通用图标回归即同串）`)
                  : rep.fail(`巨型 exe 图标退化：${JSON.stringify(giantUrls.map((g) => ({ tag: g.tag, len: g.url ? g.url.length : null })))}`);
              } else {
                rep.note(`巨型 exe 不在本机（${giantDefs.length}/3 在场），兜底断言按缺席降级`);
              }
            } finally {
              await ctx2.stop();
              try { fs.rmSync(probeDir2, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
            }
          }
        } finally {
          const tClean2 = Date.now();
          for (const p of [dirLnkName, path.basename(txtFx), ...giantDefs.map((fx) => fx.name)]) {
            try { fs.unlinkSync(path.join(scan.user, p)); } catch { /* 尽力清理 */ }
          }
          try { fs.rmSync(dirFx, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
          const gone2 = await waitEvent('desktop-rendered',
            (e) => e.t >= tClean2 && allNames.every((n) => !(e.names || []).includes(n)), 6000);
          gone2
            ? rep.pass('工单06 夹具清理后条目同步消失')
            : rep.note('工单06 夹具清理存证未到（不阻塞；夹具已尽力删除）');
        }
      }

      // 杀面板进程（taskkill /F）：外层守卫自动还原原生图标
      spawnSync('taskkill', ['/PID', String(panelPid), '/F'], { stdio: 'ignore' });
      let restoredVis = false;
      const restoreDeadline = Date.now() + 6000;
      while (Date.now() < restoreDeadline && !restoredVis) {
        restoredVis = w32.desktopIconsVisible();
        if (!restoredVis) await sleep(200);
      }
      const carryRestored = await waitEvent('icons-restored', null, 2000);
      let supervisorDead = false;
      const superDeadline = Date.now() + 4000;
      while (Date.now() < superDeadline && !supervisorDead) {
        supervisorDead = !isAlive(child.pid);
        if (!supervisorDead) await sleep(200);
      }
      restoredVis && carryRestored
        ? rep.pass(`杀进程自动还原：面板被 taskkill /F 后原生图标恢复（reason=${carryRestored.reason}，守卫还原后退出=${supervisorDead}）`)
        : rep.fail(`杀进程还原未达成（iconsVisible=${restoredVis}，存证=${JSON.stringify(carryRestored)}）`);
      capture({ left: 0, top: 0, right: si.phys.w, bottom: si.phys.h }, '05-icons-restored');
      rep.note('杀面板后实拍：05-icons-restored.png（原生图标回归、面板已死）');

      // 后续探针继续：重新拉起面板（完整守卫链——此刻图标可见，守卫将再次隐藏）。
      // sinceMs 必传：事件文件里留着 P1 的旧 boot，不带时间下限会去盯死 pid 的窗口（本轮实测踩中）
      const relaunchT0 = Date.now();
      child = launchPanel();
      const hwnd3 = await waitPanelWindow(20000, relaunchT0);
      if (!hwnd3) throw new Error(`P5 重启后未见面板窗口\nstderr:\n${stderrTail}`);
      hwnd = hwnd3;
      panelPid = w32.threadIdOf(hwnd3).pid;
      await sleep(1200);
    }

    // —— P5.5 工单06 编排与推荐：手钉前段 / 新建自动归类入区 / 拖拽摆位持久化 / 恢复出厂 ——
    {
      const rendered0 = await waitEvent('desktop-rendered', null, 8000);

      // a. 手钉条目稳定占据 dock 前段，其余为推荐位（推荐序本身的数学在离线测试盯）
      if (rendered0 && Array.isArray(rendered0.dock) && rendered0.dock.length > 1) {
        const first = rendered0.dock[0];
        const restSources = [...new Set(rendered0.dock.slice(1).map((d) => d.source))];
        first.name === pinnedSeed && first.source === 'pinned' && !restSources.includes('pinned')
          ? rep.pass(`手钉条目稳定占据 dock 前段：${first.name}（source=pinned，其余 ${rendered0.dock.length - 1} 项为 ${restSources.join('/')}，不被推荐顶替）`)
          : rep.fail(`dock 前段非手钉：${JSON.stringify(first)}（种子 pinned=${pinnedSeed}，其余来源 ${restSources.join('/')}）`);
        capture({ left: rect.left, top: rect.bottom - Math.round(DOCK_STRIP_DIP * f), right: rect.right, bottom: rect.bottom }, '06-dock-pinned');
      } else {
        rep.fail(`desktop-rendered 未带 dock 编排序（工单06 编排未上线）：${JSON.stringify(rendered0 && rendered0.dock)}`);
      }

      // b. 新建桌面文件自动归类入区（文档组聚合），删除后同步消失
      const probeDocx = `DECK06-PROBE-${Date.now()}.docx`;
      const probePdf = `DECK06-PROBE-${Date.now() + 1}.pdf`;
      const docPaths = [path.join(seedScan.user, probeDocx), path.join(seedScan.user, probePdf)];
      try {
        fs.writeFileSync(docPaths[0], 'probe');
        fs.writeFileSync(docPaths[1], 'probe');
        const grouped = await waitEvent('desktop-rendered', (e) => (e.names || []).includes(probeDocx) && (e.names || []).includes(probePdf), 8000);
        if (grouped) {
          const g1 = (grouped.docEntries || []).find((d) => d.name === probeDocx);
          const g2 = (grouped.docEntries || []).find((d) => d.name === probePdf);
          g1 && g1.group === 'office' && g2 && g2.group === 'pdf'
            ? rep.pass(`新建桌面文件自动归类入区：${probeDocx}→office 组、${probePdf}→pdf 组（文档区按扩展名聚合）`)
            : rep.fail(`文档组归类不符：docx=${JSON.stringify(g1)} pdf=${JSON.stringify(g2)}`);
          capture({ left: rect.left + Math.round(400 * f), top: rect.top, right: rect.left + Math.round(1060 * f), bottom: rect.top + Math.round(780 * f) }, '06-doc-groups');
        } else {
          rep.fail('新建探针文档未入池（desktop-rendered 未见）');
        }
      } finally {
        for (const p of docPaths) { try { fs.unlinkSync(p); } catch { /* 尽力清理 */ } }
      }
      const goneDocs = await waitEvent('desktop-rendered', (e) => !(e.names || []).includes(probeDocx) && !(e.names || []).includes(probePdf), 6000);
      goneDocs
        ? rep.pass('删除探针文档后条目同步消失（面板与磁盘一致）')
        : rep.fail('删除探针文档后条目未消失');

      // c. 拖拽摆位：真鼠标（SendInput 按下-移动-抬起）驱动渲染层指针拖拽 → desktop/move 落盘。
      // 源/参照矩形取安静后的最新一拍（拖拽中途编排序再变会错位）。
      const dockEvt = await waitStable('desktop-rendered', 1500, 8000);
      const dockOrder = ((dockEvt && dockEvt.dock) || []).map((d) => d.name);
      const rectByName = (name) => {
        const r = (dockEvt.rects || []).find((x) => x.name === name);
        return r && r.rect;
      };
      if (dockOrder.length < 3) {
        rep.fail(`dock 条目不足 3，拖拽探针不可排（现有 ${dockOrder.length}）`);
      } else {
        const dragged = dockOrder[dockOrder.length - 1]; // 拖末位条目
        const anchor = dockOrder[1];                     // 落到第 2 位条目之前（第 1 位是手钉）
        const rd = rectByName(dragged);
        const ra = rectByName(anchor);
        if (!rd || !ra) {
          rep.fail('拖拽源/参照条目无矩形（渲染层 rects 缺失）');
        } else {
          const from = { x: rect.left + Math.round((rd.x + rd.w / 2) * f), y: rect.top + Math.round((rd.y + rd.h / 2) * f) };
          const to = { x: rect.left + Math.round((ra.x + ra.w / 2) * f), y: rect.top + Math.round((ra.y + ra.h / 2) * f) };
          const hitDrag = await ensurePanelHit(from, hwnd);
          hitDrag.ok
            ? rep.note('拖拽源落点校验通过（面板在收输入）')
            : rep.fail(`拖拽摆位前置失败：${hitDrag.why}（排序/持久化连锁断言跳过）`);
          if (hitDrag.ok) {
            w32.send([w32.mouseInput(0, 0, w32.LEFTDOWN)]);
            const steps = 12; // 渲染层拖拽阈值 6px，步进远超阈值；每步 24ms 保持事件流
            for (let s = 1; s <= steps; s++) {
              await sleep(24);
              w32.moveMousePhys(from.x + Math.round(((to.x - from.x) * s) / steps), from.y + Math.round(((to.y - from.y) * s) / steps));
            }
            await sleep(140); // 落点稳定后再抬键（elementFromPoint 取参照条目）
            const hitDrop = await ensurePanelHit(to, hwnd);
            hitDrop.ok
              ? rep.note('拖拽落点校验通过（输入流全程在面板）')
              : rep.fail(`拖拽落点中途被遮：${hitDrop.why}`);
            w32.send([w32.mouseInput(0, 0, w32.LEFTUP)]);
          }
          w32.moveMousePhys(safePt.x, safePt.y);
          const moved = hitDrag.ok && await waitEvent('desktop-moved', (e) => e.name === dragged && e.ok, 6000);
          if (hitDrag.ok) {
            moved
              ? rep.pass(`拖拽摆位：${dragged} 拖至 ${anchor} 之前（desktop/move ok=true，摆位落盘）`)
              : rep.fail(`拖拽摆位未达成（desktop-moved=${JSON.stringify(moved)}）`);
          }
          const tReordered = Date.now();
          const reordered = hitDrag.ok && await waitEvent('desktop-rendered', (e) => {
            const ord = ((e.dock) || []).map((d) => d.name);
            return e.t >= tReordered - 2500 && ord.includes(dragged) && ord.includes(anchor) && ord.indexOf(dragged) < ord.indexOf(anchor);
          }, 6000);
          if (!hitDrag.ok) {
            rep.note('拖拽未执行（前置遮挡失败），排序/持久化连锁断言跳过');
          } else {
            reordered
              ? rep.pass('摆位即时重编排：拖拽条目越过参照（渲染序更新）')
              : rep.fail('拖拽后编排序未更新');
          }
          capture({ left: rect.left, top: rect.bottom - Math.round(DOCK_STRIP_DIP * f), right: rect.right, bottom: rect.bottom }, '06-drag-moved');

          // 重启面板：摆位持久化（layout.json）。拖拽未执行时跳过（重启只为验证持久化）。
          let rectN = w32.rectOf(hwnd); // 前置失败时即当前面板矩形（复位段仍可跑）
          if (hitDrag.ok) {
          await stopPanel();
          const rt0 = Date.now();
          child = launchPanel();
          const hwnd4 = await waitPanelWindow(20000, rt0);
          if (!hwnd4) throw new Error(`P5.5 重启后未见面板窗口\nstderr:\n${stderrTail}`);
          hwnd = hwnd4;
          panelPid = w32.threadIdOf(hwnd4).pid;
          rectN = w32.rectOf(hwnd4);
          const persisted = await waitEvent('desktop-rendered', (e) => {
            const ord = ((e.dock) || []).map((d) => d.name);
            return e.t >= rt0 && ord.includes(dragged) && ord.includes(anchor) && ord.indexOf(dragged) < ord.indexOf(anchor);
          }, 8000);
          persisted
            ? rep.pass(`重启面板后位置保持：${dragged} 仍在 ${anchor} 之前（layout.json 持久化）`)
            : rep.fail('重启后摆位未保持（layout.json 未生效）');
          capture({ left: rectN.left, top: rectN.bottom - Math.round(DOCK_STRIP_DIP * f), right: rectN.right, bottom: rectN.bottom }, '06-drag-persisted');
          } else {
            rep.note('重启面板持久化断言随拖拽前置失败一并跳过');
          }

          // d. 恢复出厂布局：设置浮层（工单08 迁入）内的 RESET LAYOUT 一键回出厂编排（清摆位、留手钉）。
          // 每轮从干净态起：先 ESC（浮层开着则收层；被系统浮层遮挡也顺带清场），再点入口开层、点复位。
          const ptOfZone = (z) => ptOfZoneAt(rectN, z);
          const resetViaOverlay = async () => {
            const tRound = Date.now();
            w32.tapKeys([VK_ESCAPE]);
            await sleep(500);
            const bz = latestZoneOf('settings-btn');
            if (!bz) return { reset: null, why: 'settings-btn 未进热区' };
            await occludedClickAt(ptOfZone(bz), '设置入口');
            const opened = await waitEvent('settings-opened', (e) => e.t >= tRound, 3000);
            if (!opened) return { reset: null, why: 'settings-opened 未到（浮层未开）' };
            await sleep(350); // 浮层热区声明落地
            const rz2 = latestZoneOf('settings-reset');
            if (!rz2) return { reset: null, why: 'settings-reset 未进热区' };
            await occludedClickAt(ptOfZone(rz2), '浮层复位');
            const reset = await waitEvent('desktop-layout-reset', (e) => e.ok, 3000);
            return { reset, why: reset ? '' : 'desktop-layout-reset 未到' };
          };
          let reset = await withControlWindowClear(resetViaOverlay);
          if (!reset.reset) {
            rep.note(`首次复位未达成（${reset.why}），重试一轮`);
            reset = await withControlWindowClear(resetViaOverlay);
          }
          w32.moveMousePhys(safePt.x, safePt.y);
          if (!reset.reset) {
            rep.fail(`恢复出厂未达成（${reset.why}）`);
          } else {
            const tReset = Date.now() - 15000; // 覆盖重试轮的窗口
            const factoryEvt = await waitEvent('desktop-rendered', (e) => {
              const dock = e.dock || [];
              return e.t >= tReset && dock.length > 1 && dock.every((d) => d.source !== 'placed');
            }, 6000);
            const pinnedKept = factoryEvt && factoryEvt.dock[0] && factoryEvt.dock[0].source === 'pinned';
            factoryEvt
              ? rep.pass(`设置浮层恢复出厂一键生效：清除 ${reset.reset.cleared} 处摆位，非手钉全部回推荐位${pinnedKept ? '（手钉保留在前段）' : '（注意：手钉未保留）'}`)
              : rep.fail(`恢复出厂未达成（reset=${JSON.stringify(reset.reset)}，factoryEvt=${JSON.stringify(factoryEvt && factoryEvt.dock)}）`);
            capture({ left: rectN.left, top: rectN.bottom - Math.round(DOCK_STRIP_DIP * f), right: rectN.right, bottom: rectN.bottom }, '06-factory-reset');
            // 收层退场：ESC 关浮层（08 段对 esc/blur 有专门断言，这里只求干净退场）
            const tClose = Date.now();
            w32.tapKeys([VK_ESCAPE]);
            const closed = await waitEvent('settings-closed', (e) => e.t >= tClose && e.reason === 'esc', 2500);
            closed || rep.note('复位后 ESC 收层存证未到（不阻塞；08 段有专门断言）');
          }
        }
      }
    }

    // —— P7S 工单07 搜索并入：accept_search 电池适配（scripts/accept_search.py 随 Tk 窗退役）——
    // 链路：探针文件直连引擎取证 → 热区点击激活（前台门校验）→ 剪贴板粘贴探针词
    // （绕开输入法合成，旧电池同法；IME 机制本体由探针01-D 在同窗体实证）→ 实时结果 →
    // ↑/↓ 选择 → Enter 打开 → Ctrl+Enter 定位 → ESC/失焦退待机 → 假端口复现 ENGINE OFFLINE。
    await (async () => {
      // 记事本（P4 起 1000,200 1400x900）盖住搜索卡左半——挪开，段末挪回（P9 重钉断言仍按原位）
      const npRect0 = w32.rectOf(notepad.hwnd);
      w32.SetWindowPos(notepad.hwnd, 0, 60, 200, 0, 0,
        w32.SWP_NOSIZE | w32.SWP_NOZORDER | w32.SWP_NOACTIVATE);
      const restoreNotepadPos = () => {
        if (!npRect0) return;
        try {
          w32.SetWindowPos(notepad.hwnd, 0, npRect0.left, npRect0.top, 0, 0,
            w32.SWP_NOSIZE | w32.SWP_NOZORDER | w32.SWP_NOACTIVATE);
        } catch { /* 尽力 */ }
      };

      const token = `zzdeck07-${Date.now()}`;
      const probeDir = path.join(os.tmpdir(), token);
      const probeFile = path.join(probeDir, `${token}.txt`);
      const word = `${token}.txt`; // 搜完整文件名：唯一且必排首位（目录不匹配 .txt，旧电池同法）
      const savedClip = clipboardGet();
      const configPathS = path.join(APP_ROOT, 'config.json');
      const configBackupS = fs.existsSync(configPathS) ? fs.readFileSync(configPathS, 'utf8') : null;
      let currentRect = w32.rectOf(hwnd);
      let searchZone = null;

      const latestSearchZone = () => {
        const evts = readEvents().filter((e) => e.type === 'hotzones' && (e.rects || []).some((r) => r.id === 'search-card'));
        const last = evts[evts.length - 1];
        return last ? (last.rects || []).find((r) => r.id === 'search-card') || null : null;
      };
      const zoneShot = (z, base, name, extraBottom = 40) => {
        capture({
          left: base.left + Math.round((z.x - 24) * f),
          top: base.top + Math.round((z.y - 24) * f),
          right: base.left + Math.round((z.x + z.w + 24) * f),
          bottom: base.top + Math.round((z.y + z.h + extraBottom) * f),
        }, name);
      };
      const foregroundIsPanel = () => {
        const fg = w32.GetForegroundWindow();
        return !!fg && w32.threadIdOf(fg).pid === panelPid;
      };
      // 工单02：面板 z 序取证——面板必须压在全部普通窗之下（键盘模式也钉底）。
      // 判据方向：自顶向下枚举里面板**之下**不得再出现普通窗（其下只允许桌面层/任务栏，
      // 见 CLEAR_DESKTOP_SKIP；置顶层带另论——普通窗顶不起钉底面板，普通窗在其上属自然 z 序）。
      const panelBelowAllNormal = () => {
        const wins = win32.topLevelWindows();
        const zi = wins.indexOf(hwnd);
        if (zi < 0) return { ok: false, detail: '面板窗不在可见 z 序里' };
        const below = [];
        for (let i = zi + 1; i < wins.length; i++) {
          const h = wins[i];
          if (w32.GetWindowLongW(h, w32.GWL_EXSTYLE) & w32.WS_EX_TOPMOST) continue;
          if (CLEAR_DESKTOP_SKIP.has(w32.className(h))) continue;
          below.push(`${w32.className(h)}@pid${w32.threadIdOf(h).pid}`);
        }
        return { ok: below.length === 0, detail: below.length ? `其下有普通窗 ${below.join(', ')}` : '其下仅桌面层' };
      };
      // 激活 = 点击热区（search-activated 存证）+ 前台门校验（键只发进面板进程，旧电池 panel_sendkeys 同款）。
      // 工单02 起「激活」的实现在面板侧 = 键盘模式临时聚焦：点击本身不再激活窗口（永不激活），
      // 前台=面板改由 keyboard-mode-on 的 setFocusable(true)+focus() 达成——断言意图不变（键盘落在面板进程）。
      const activate = async () => {
        const z = latestSearchZone();
        if (!z) return false;
        const cx = currentRect.left + Math.round((z.x + z.w / 2) * f);
        const cy = currentRect.top + Math.round((z.y + z.h / 2) * f);
        for (let i = 0; i < 3; i++) {
          w32.moveMousePhys(cx, cy);
          await sleep(350);
          const t0 = Date.now();
          w32.clickPhys(cx, cy, 'left');
          const act = await waitEvent('search-activated', (e) => e.t >= t0, 2500);
          if (act && foregroundIsPanel()) return true;
        }
        return false;
      };
      // 粘贴任意词进输入框（探针词/常用词共用；绕开输入法合成，旧电池同法）
      const paste = async (text) => {
        clipboardSet(text);
        await sleep(250);
        w32.send([
          w32.keyInput(VK_CONTROL, w32.KEYDOWN), w32.keyInput(VK_V, w32.KEYDOWN),
          w32.keyInput(VK_V, w32.KEYUP), w32.keyInput(VK_CONTROL, w32.KEYUP),
        ]);
      };
      const pasteAwaitResults = async () => {
        const t0 = Date.now();
        await paste(word);
        return await waitEvent('search-results-rendered', (e) => e.t >= t0 && (e.count ?? 0) >= 1, 20000);
      };
      const waitWindow = async (pred, timeoutMs = 15000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const hit = win32.topLevelWindows().find(pred);
          if (hit) return hit;
          await sleep(300);
        }
        return null;
      };

      try {
        // —— 探针文件 + 引擎索引等待（直连真实引擎，90s 上限）——
        fs.mkdirSync(probeDir, { recursive: true });
        fs.writeFileSync(probeFile, 'agent-deck search acceptance probe\n', 'utf8');
        let indexed = false;
        const idxDeadline = Date.now() + 90000;
        while (Date.now() < idxDeadline && !indexed) {
          indexed = await engineProbeFirst(word, probeFile, token);
          if (!indexed) await sleep(1500);
        }
        indexed
          ? rep.pass('真实 Listary 引擎在线且探针文件入索引排首位（直连取证——与内核同款回环链路）')
          : rep.fail('Listary 引擎离线或索引 90s 未就绪（搜索链路探针不可信，确认 Listary 在运行后重跑）');
        if (!indexed) return;

        await waitStable('desktop-rendered', 1200, 8000);
        currentRect = w32.rectOf(hwnd);
        searchZone = latestSearchZone();
        if (!searchZone) {
          rep.fail('搜索卡热区未声明（渲染层 search-card 缺席）');
          return;
        }
        zoneShot(searchZone, currentRect, '07-search-idle', 24);
        rep.note('待机态实拍：07-search-idle.png（SEARCH 头 + CLICK TO SEARCH_ 融入右窄栏卡片视觉）');

        // —— 点击激活 → 键盘模式取证 → 粘贴 → 实时结果 ——
        const tAct0 = Date.now();
        const okAct = await activate();
        okAct
          ? rep.pass('热区点击激活搜索面板（search-activated 存证；前台=面板进程——01-D 低 z 序键盘聚焦结论在永不激活语义下经键盘模式落地）')
          : rep.fail('搜索面板未激活或键盘焦点未落入面板进程（前台门校验 3 次失败）');
        if (!okAct) return;
        // 工单02 键盘模式：mode-on 存证 + 前台=面板 + 键盘模式期间面板仍在全部普通窗之下
        const kbOn = await waitEvent('keyboard-mode-on', (e) => e.t >= tAct0, 3000);
        const belowOn = panelBelowAllNormal();
        kbOn && belowOn.ok
          ? rep.pass(`键盘模式开启：keyboard-mode-on 存证；键盘焦点在手（前台=面板）且面板仍在全部普通窗之下（${belowOn.detail}）——键盘模式也钉底`)
          : rep.fail(`键盘模式断言未过（kbOn=${JSON.stringify(kbOn)}，z 序=${belowOn.detail}）`);
        const resEvt = await pasteAwaitResults();
        resEvt
          ? rep.pass(`键入探针词后防抖-引擎-渲染管线打通（结果 ${resEvt.count} 行 TOTAL ${resEvt.total}，qlen=${resEvt.qlen}——存证只带长度不带查询词；Ctrl+V 键程直达输入框 = 键盘模式焦点到手）`)
          : rep.fail('探针词粘贴后 20s 未出结果（search-results-rendered 未见）');
        if (!resEvt) return;
        searchZone = latestSearchZone() || searchZone; // 活动态卡片随结果展开
        zoneShot(searchZone, currentRect, '07-search-results');

        // —— Enter 打开探针文件（探针词仍在输入框、选中在首行）——
        let tSel = Date.now();
        w32.tapKeys([VK_RETURN]);
        const opened = await waitWindow((h) => windowTitle(h).includes(token));
        opened
          ? rep.pass('Enter 打开验收探针文件（首行确为探针——渲染正确性行为级实证）')
          : rep.fail('Enter 未打开探针文件窗口');
        // 不关这个窗口：Win11 记事本有标签页——探针文件是作为 P4 记事本窗口的新标签
        // 打开的，关掉它 = 杀掉 P4 的对照窗（P9 Win+D 断言依赖它活着，首轮实测踩中）。
        // 探针标签随电池末尾 P4 窗口的 WM_CLOSE 一并消亡。

        // —— Ctrl+Enter 资源管理器定位 ——
        const okAct2 = await activate();
        if (!okAct2) {
          rep.fail('重新激活失败（reveal 链不可测）');
          return;
        }
        const resEvt2 = await pasteAwaitResults();
        if (!resEvt2) {
          rep.fail('reveal 链粘贴后未出结果');
          return;
        }
        searchZone = latestSearchZone() || searchZone;
        zoneShot(searchZone, currentRect, '07-search-reveal'); // 动作前的活动态存证（动作完成即收层）
        tSel = Date.now();
        w32.send([
          w32.keyInput(VK_CONTROL, w32.KEYDOWN), w32.keyInput(VK_RETURN, w32.KEYDOWN),
          w32.keyInput(VK_RETURN, w32.KEYUP), w32.keyInput(VK_CONTROL, w32.KEYUP),
        ]);
        const revealed = await waitWindow((h) => win32.className(h) === 'CabinetWClass' && windowTitle(h).includes(token));
        revealed
          ? rep.pass('Ctrl+Enter 资源管理器定位（CabinetWClass 窗口弹出且标题含探针目录）')
          : rep.fail('Ctrl+Enter 未弹出资源管理器定位窗口');
        if (revealed) {
          w32.PostMessageW(revealed, WM_CLOSE, 0, 0);
          await sleep(800);
        }

        // —— ↑/↓ 选择 + ESC 退回待机态 ——
        // 探针词唯一 → 只 1 行，选择移动需多行：换常用词（readme，索引内海量）出满 8 行。
        // 选择后原地 ESC 收层（选择链留下的活动态正好作 ESC 探针——面板退待机，
        // 供后续失焦链从待机态重新激活；活动态下点击卡片中心会落到结果行上误开文件）。
        const okActSel = await activate();
        if (!okActSel) {
          rep.fail('选择链重新激活失败');
          return;
        }
        await paste('readme');
        const multiRow = await waitEvent('search-results-rendered', (e) => (e.count ?? 0) >= 3, 20000);
        if (!multiRow) {
          rep.fail('常用词未出多行结果（↑/↓ 选择不可测）');
          return;
        }
        tSel = Date.now();
        w32.tapKeys([VK_DOWN]);
        await sleep(180);
        w32.tapKeys([VK_DOWN]);
        const selEvt = await waitEvent('search-selection-moved', (e) => e.t >= tSel && e.index === 2, 4000);
        selEvt
          ? rep.pass('↑/↓ 选择：两击 DOWN 选中第 3 行（index=2 存证）')
          : rep.fail('↓ 选择未生效（search-selection-moved index=2 未见）');
        tSel = Date.now();
        w32.tapKeys([VK_ESCAPE]);
        const escEvt = await waitEvent('search-deactivated', (e) => e.t >= tSel && e.reason === 'esc', 5000);
        escEvt
          ? rep.pass('ESC 退回待机态（search-deactivated reason=esc：输入清空、结果收起）')
          : rep.fail('ESC 未退回待机态');
        // 工单02 键盘模式退出：mode-off 存证 + 恢复不可聚焦样式 + 面板仍钉底
        const kbOff = await waitEvent('keyboard-mode-off', (e) => e.t >= tSel, 3000);
        const belowOff = panelBelowAllNormal();
        const exOff = w32.GetWindowLongW(hwnd, w32.GWL_EXSTYLE);
        kbOff && belowOff.ok && (exOff & w32.WS_EX_NOACTIVATE)
          ? rep.pass(`键盘模式退出：keyboard-mode-off 存证，面板恢复不可聚焦（WS_EX_NOACTIVATE 回归）且仍钉底（${belowOff.detail}）`)
          : rep.fail(`键盘模式退出断言未过（kbOff=${JSON.stringify(kbOff)}，z 序=${belowOff.detail}，EXSTYLE=0x${(exOff >>> 0).toString(16)}）`);

        // —— 失焦退回待机态（点击桌面空档：穿透处点击 → 前台翻转 → 输入框 blur）——
        const okAct4 = await activate();
        if (!okAct4) {
          rep.fail('失焦链重新激活失败');
          return;
        }
        await pasteAwaitResults();
        tSel = Date.now();
        w32.moveMousePhys(safePt.x, safePt.y);
        await sleep(400); // 热区轮询 25ms，留足恢复穿透
        w32.clickPhys(safePt.x, safePt.y, 'left');
        const blurEvt = await waitEvent('search-deactivated', (e) => e.t >= tSel && e.reason === 'blur', 6000);
        blurEvt
          ? rep.pass('失焦退回待机态（点击桌面后前台翻转，输入框 blur → 收层）')
          : rep.fail('失焦未退回待机态');

        // —— ENGINE OFFLINE（假端口注入：config.search.port 指必死端口 → 重启面板）——
        await stopPanel();
        fs.writeFileSync(configPathS, JSON.stringify({ search: { port: await freePort() } }, null, 2) + '\n');
        const tOff = Date.now();
        child = launchPanel();
        const hwndOff = await waitPanelWindow(20000, tOff);
        if (!hwndOff) throw new Error('离线探针重启后面板窗口未出现');
        hwnd = hwndOff;
        panelPid = win32.threadIdOf(hwndOff).pid;
        currentRect = w32.rectOf(hwndOff);
        await sleep(1500);
        const okAct5 = await activate();
        if (!okAct5) {
          rep.fail('离线探针激活失败');
        } else {
          tSel = Date.now();
          await paste(word);
          const offEvt = await waitEvent('search-offline-shown', (e) => e.t >= tSel, 20000);
          offEvt
            ? rep.pass('引擎不可达显示 ENGINE OFFLINE（假端口连接失败 → offline 态 → 徽标；内核 3s 静默重试在场）')
            : rep.fail('假端口注入后未出现 ENGINE OFFLINE（search-offline-shown 未见）');
          zoneShot(latestSearchZone() || searchZone, currentRect, '07-search-offline');
        }
      } finally {
        restoreNotepadPos();
        clipboardSet(savedClip);
        // 不按 token 关窗：Enter 打开的探针文件是 P4 记事本窗口的新标签（Win11 标签页
        // 复用），按标题关窗会连 P4 对照窗一起杀（P9 依赖它存活）。目录删除挪到电池
        // 末尾（主 finally）——关掉记事本释放句柄后再删。
        searchProbeDir = probeDir;
        await sleep(600);
        // 面板拉回正常态（离线探针停在假端口配置）：还原 config + 重启
        if (configBackupS === null) { try { fs.unlinkSync(configPathS); } catch { /* 尽力 */ } }
        else { try { fs.writeFileSync(configPathS, configBackupS); } catch { /* 尽力 */ } }
        await stopPanel();
        const tRelaunch = Date.now();
        child = launchPanel();
        const hwndR = await waitPanelWindow(20000, tRelaunch);
        if (hwndR) {
          hwnd = hwndR;
          panelPid = win32.threadIdOf(hwndR).pid;
        } else {
          rep.fail('搜索段收尾重启后面板窗口未出现');
        }
      }
    })();

    // —— P8S 工单08 设置浮层与透明度：入口开层（浮层=热区）→ 滑杆拖拽即时反映 +
    // config 持久化 → ESC / 失焦关闭 → 重启保持。全程事件门判定 + 截图存证；
    // config 整段备份还原，不给 P6 及用户留残留。——
    // 整段裹一层 withControlWindowClear：本段落点（设置入口、浮层滑杆、时钟卡）全在面板
    // 右下，电池自己的对照记事本正压在那里——不挪开则开层与拖拽两头都到不了面板。
    await withControlWindowClear(async () => {
      const configBackup08 = backupConfigB();
      // 缺 appearance 段 = loadConfig 合并默认（与内核同语义），读盘断言按 0.55 兜底
      const defaultAppearanceB = 0.55;
      const readCardOpacity = () => {
        try { return JSON.parse(fs.readFileSync(CONFIG_FILE_B, 'utf8')).appearance?.cardOpacity ?? defaultAppearanceB; } catch { return null; }
      };
      let rect08 = w32.rectOf(hwnd);
      const openOverlay = async () => {
        const t0 = Date.now();
        const bz = latestZoneOf('settings-btn');
        if (!bz) return null;
        await occludedClickAt(ptOfZoneAt(rect08, bz), '设置入口');
        const opened = await waitEvent('settings-opened', (e) => e.t >= t0, 3000);
        if (opened) await sleep(350); // 浮层热区声明落地
        return opened;
      };
      const closeOverlayEsc = async () => {
        const t0 = Date.now();
        w32.tapKeys([VK_ESCAPE]);
        return await waitEvent('settings-closed', (e) => e.t >= t0 && e.reason === 'esc', 3000);
      };
      const dragSliderTo = async (slider, frac) => {
        // 从滑杆中心按到目标分位（thumb 几何忽略——断言走事件终值，不猜落点）
        const y = rect08.top + Math.round((slider.y + slider.h / 2) * f);
        const x0 = rect08.left + Math.round((slider.x + slider.w / 2) * f);
        const fracX = slider.x + Math.max(2, Math.min(slider.w - 2, slider.w * frac));
        const x1 = rect08.left + Math.round(fracX * f);
        w32.moveMousePhys(x0, y);
        await sleep(300);
        w32.send([w32.mouseInput(0, 0, w32.LEFTDOWN)]);
        const steps = 12;
        for (let s = 1; s <= steps; s++) {
          await sleep(24);
          w32.moveMousePhys(Math.round(x0 + ((x1 - x0) * s) / steps), y);
        }
        await sleep(160);
        w32.send([w32.mouseInput(0, 0, w32.LEFTUP)]);
        await sleep(500); // 尾随 input 事件与内核回程落地，断言取「终值一致」而非中途值
      };
      /** 拖拽终值三链一致：滑杆终值 = 内核响应 = applied 存证，且 config 落盘同值 */
      const dragConsistent = (tDrag, gate) => {
        const input = lastEvent('settings-opacity-input', null, tDrag);
        const set = lastEvent('settings-opacity-set', null, tDrag);
        const applied = lastEvent('settings-opacity-applied', null, tDrag);
        const cfg = readCardOpacity();
        const ok = input && set && applied && cfg != null
          && input.value === set.value && applied.value === input.value
          && Math.abs(set.value - pctOf(cfg)) <= 1
          && (!gate || gate(input.value));
        return { ok, input, set, applied, cfg };
      };

      try {
        // a. 入口开层 + 浮层自身是热区；开层存证带滑杆矩形与当前值。
        //    工单02：开层同时走键盘模式（ESC 关层、滑杆键盘路径都要键盘焦点在手）。
        //    过滤起点取墙钟（P7S 同法）：渲染层先发 keyboard-mode-on 再报 settings-opened，
        //    以 opened0.t 为起点会把 on 事件筛在门外（首轮实测踩中）。
        const tOpen0 = Date.now();
        const opened0 = await openOverlay();
        const overlayZone = latestZoneOf('settings-card');
        opened0 && overlayZone
          ? rep.pass(`设置浮层：入口点击开启（settings-opened 存证），浮层矩形进热区 ${Math.round(overlayZone.w)}x${Math.round(overlayZone.h)}（可交互）`)
          : rep.fail(`设置浮层开启失败（opened=${JSON.stringify(opened0)}，热区=${JSON.stringify(overlayZone)}）`);
        if (opened0) {
          const kbOn08 = await waitEvent('keyboard-mode-on', (e) => e.t >= tOpen0, 3000);
          const fg08 = w32.GetForegroundWindow();
          const fgIsPanel08 = !!fg08 && w32.threadIdOf(fg08).pid === panelPid;
          kbOn08 && fgIsPanel08
            ? rep.pass('设置浮层键盘模式：开层即 keyboard-mode-on 存证，键盘焦点到手（前台=面板）——ESC 可关层')
            : rep.fail(`设置浮层键盘模式未到手（kbOn=${JSON.stringify(kbOn08)}，前台 pid=${fg08 ? w32.threadIdOf(fg08).pid : 'null'}）`);
        }
        fullShot('08-settings-open');

        // b. 初值同源：开层上报的滑杆值 = config 当前值（快照 settings 下发）
        const cfg0 = readCardOpacity();
        const val0 = opened0 && opened0.value;
        val0 != null && cfg0 != null && Math.abs(val0 - pctOf(cfg0)) <= 1
          ? rep.pass(`初值同源：开层滑杆值 ${val0}% = config.appearance.cardOpacity ${cfg0}`)
          : rep.fail(`开层初值与 config 不一致（slider=${val0}，config=${cfg0}）`);

        // c. 拖到低位：input 即时反映（applied 存证）+ set-card-opacity 落盘
        const slider0 = opened0 && opened0.slider;
        if (!slider0) {
          rep.fail('开层存证未带滑杆矩形（拖拽探针无法定位）');
        } else {
          const tDrag = Date.now();
          await dragSliderTo(slider0, 0.08);
          const low = dragConsistent(tDrag, (v) => v <= 30);
          low.ok
            ? rep.pass(`滑杆拖至低位 ${low.input.value}%：底色即时反映（applied 同值）且 config 同步落盘 ${low.cfg}`)
            : rep.fail(`低位拖拽断言未过（input=${JSON.stringify(low.input)}，set=${JSON.stringify(low.set)}，applied=${JSON.stringify(low.applied)}，config=${low.cfg}）`);
          fullShot('08-opacity-low');

          // d. 拖回高位 + ESC 收层
          const tDrag2 = Date.now();
          await dragSliderTo(slider0, 0.92);
          const high = dragConsistent(tDrag2, (v) => v >= 70);
          high.ok
            ? rep.pass(`滑杆拖回高位 ${high.input.value}%：config 同步落盘 ${high.cfg}（滑杆调节即时反映于各信息卡底色）`)
            : rep.fail(`高位拖拽断言未过（input=${JSON.stringify(high.input)}，set=${JSON.stringify(high.set)}，applied=${JSON.stringify(high.applied)}，config=${high.cfg}）`);
          fullShot('08-opacity-high');

          const tEsc0 = Date.now();
          const escEvt = await closeOverlayEsc();
          escEvt
            ? rep.pass('ESC 关闭设置浮层（settings-closed reason=esc 存证）')
            : rep.fail('ESC 未关闭设置浮层（settings-closed reason=esc 未到）');
          // 工单02 关层恢复：keyboard-mode-off 存证 + 面板恢复不可聚焦样式
          // （off 事件先于 settings-closed 落盘，过滤起点取按 ESC 前的墙钟）
          if (escEvt) {
            const kbOff08 = await waitEvent('keyboard-mode-off', (e) => e.t >= tEsc0, 3000);
            const ex08 = w32.GetWindowLongW(hwnd, w32.GWL_EXSTYLE);
            kbOff08 && (ex08 & w32.WS_EX_NOACTIVATE)
              ? rep.pass(`关层恢复不可聚焦：keyboard-mode-off 存证，WS_EX_NOACTIVATE 回归（EXSTYLE=0x${(ex08 >>> 0).toString(16)}）`)
              : rep.fail(`关层后未恢复不可聚焦（kbOff=${JSON.stringify(kbOff08)}，EXSTYLE=0x${(ex08 >>> 0).toString(16)}）`);
          }
          w32.moveMousePhys(safePt.x, safePt.y);

          // e. 失焦关闭：重开浮层后点时钟卡（焦点离开浮层 → blur 收层）
          const opened1 = await openOverlay();
          const clockZone = latestZoneOf('clock-card');
          if (opened1 && clockZone) {
            const tBlur = Date.now();
            await occludedClickAt(ptOfZoneAt(rect08, clockZone), '时钟卡');
            const blurEvt = await waitEvent('settings-closed', (e) => e.t >= tBlur && e.reason === 'blur', 3000);
            blurEvt
              ? rep.pass('失焦关闭：焦点移出浮层（点时钟卡）即收层（reason=blur 存证）')
              : rep.fail('失焦未关闭设置浮层（settings-closed reason=blur 未到）');
          } else {
            rep.fail(`失焦探针前置失败（opened=${JSON.stringify(opened1)}，clockZone=${JSON.stringify(clockZone)}）`);
          }

          // f. 重启保持：拖到已知高位 → ESC 收层 → 重启面板 → config 值回灌渲染层
          const opened2 = await openOverlay();
          if (opened2 && opened2.slider) {
            const tDrag3 = Date.now();
            await dragSliderTo(opened2.slider, 0.85);
            const persist = dragConsistent(tDrag3, (v) => v >= 70);
            await closeOverlayEsc();
            if (persist.ok) {
              await stopPanel();
              const tRelaunch = Date.now();
              child = launchPanel();
              const hwnd8 = await waitPanelWindow(20000, tRelaunch);
              if (!hwnd8) {
                rep.fail('重启保持探针：面板重启后窗口未出现');
              } else {
                hwnd = hwnd8;
                panelPid = win32.threadIdOf(hwnd8).pid;
                rect08 = w32.rectOf(hwnd8);
                const appliedPersist = await waitEvent('settings-opacity-applied', (e) => e.t >= tRelaunch && Math.abs(e.value - pctOf(persist.cfg)) <= 1, 8000);
                appliedPersist
                  ? rep.pass(`重启保持：config ${persist.cfg} 回灌渲染层（boot applied ${appliedPersist.value}%，滑杆与底色同值）`)
                  : rep.fail(`重启后渲染层未回灌 config 值（期望 ~${pctOf(persist.cfg)}%，applied 未到）`);
                fullShot('08-opacity-persisted');
              }
            } else {
              rep.fail(`重启保持前置失败（input=${JSON.stringify(persist.input)}，set=${JSON.stringify(persist.set)}，config=${persist.cfg}）`);
            }
          } else {
            rep.fail('重启保持前置失败：浮层未重开或无滑杆矩形');
          }
        }
      } finally {
        w32.moveMousePhys(safePt.x, safePt.y);
        restoreConfigB(configBackup08);
      }
    });


    // —— P6 config 几何生效：改 config 重启面板 ——
    const configBackup = backupConfigB();
    try {
      await stopPanel();
      fs.writeFileSync(CONFIG_FILE_B, JSON.stringify({ panel: { x: 60, y: 60, width: 1100, height: 800 } }, null, 2) + '\n');
      // P1-P5.5 的存证先留档再重置（waitEvent 要等新 boot）；此前直接 unlink 把
      // P5.5 期事件抹掉，复位探针排障无据可查（三轮实测痛点）
      try { fs.copyFileSync(EVENTS_FILE, path.join(__dirname, 'evidence', '03-runtime-events-preP6.jsonl')); } catch { /* 尽力留档 */ }
      try { fs.unlinkSync(EVENTS_FILE); } catch { /* 重置存证，waitEvent 才能等到新 boot */ }
      child = launchPanel();
      const hwnd2 = await waitPanelWindow(20000);
      if (!hwnd2) throw new Error(`重启后未见面板窗口\nstderr:\n${stderrTail}`);
      const r2 = w32.rectOf(hwnd2);
      panelPid = w32.threadIdOf(hwnd2).pid;
      hwnd = hwnd2; // 后续探针（P7-P10）继续盯当前面板窗
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
      restoreConfigB(configBackup);
    }

    // —— P7 单实例守卫：二次拉起立即自行退出，屏幕上始终只有一个面板 ——
    {
      const chromeBefore = w32.topLevelWindows().filter((h) => w32.className(h) === 'Chrome_WidgetWin_1').length;
      const t0 = Date.now();
      const child2 = spawn(process.execPath, ['.'], {
        cwd: APP_ROOT,
        env: { ...process.env, DECK_EVENT_LOG: EVENTS_FILE },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let exited = null;
      child2.once('exit', (code) => { exited = { code, at: Date.now() }; });
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && !exited) await sleep(100);
      const elapsed = exited ? exited.at - t0 : null;
      if (!exited) {
        rep.fail('单实例守卫：二次拉起 15s 内未退出');
        try { child2.kill(); } catch { /* 尽力 */ }
      } else if (elapsed < 3000 && exited.code === 0) {
        rep.pass(`单实例守卫：二次拉起 ${elapsed}ms 自行退出（code=${exited.code}）`);
      } else {
        rep.fail(`单实例守卫：二次拉起退出异常（elapsed=${elapsed}ms code=${exited.code}，工单要求「立即」）`);
      }
      readEvents().some((e) => e.type === 'single-instance-refused')
        ? rep.pass('单实例守卫：被拒实例自报 single-instance-refused 存证')
        : rep.fail('单实例守卫：无 single-instance-refused 存证');
      const chromeAfter = w32.topLevelWindows().filter((h) => w32.className(h) === 'Chrome_WidgetWin_1').length;
      w32.IsWindow(hwnd) && chromeAfter === chromeBefore
        ? rep.pass(`单实例守卫：原面板窗完好（Chrome 窗计数 ${chromeBefore} → ${chromeAfter}），屏上仍只有一个面板`)
        : rep.fail(`单实例守卫后面板状态异常（原窗在=${w32.IsWindow(hwnd)}，Chrome 窗计数 ${chromeBefore} → ${chromeAfter}）`);
    }

    // —— P8 托盘图标已注册且可上屏 ——
    // Win11 新图标默认收进溢出区：经 NotifyIconSettings 的 IsPromoted 提升到可见区，
    // 以识别色（琥珀）像素 + 截图断言「图标在系统托盘里」。
    {
      const entries = listNotifyIcons();
      const exeLower = process.execPath.toLowerCase();
      const mine = entries.find((e) => (e.exe || '').toLowerCase() === exeLower);
      mine
        ? rep.pass(`托盘图标已注册：NotifyIconSettings 条目 ${mine.key}（exe 匹配）`)
        : rep.fail(`托盘图标未注册：NotifyIconSettings 无本面板条目（exe=${process.execPath}）`);
      if (mine) {
        promotedKey = mine.key;
        promotedOld = mine.promoted;
        if (promotedOld !== 1) {
          setPromoted(mine.key, 1);
          rep.note(`已设 IsPromoted=1（原值 ${promotedOld ?? '未设'}），等待 explorer 应用`);
          await sleep(1800);
        } else {
          rep.note('IsPromoted 已是 1，直接扫可见区');
        }
        let amber = scanAmberInTray('area');
        if (!amber) {
          rep.note('提升后可见区未发现识别色，重启面板让 explorer 按注册表重挂图标');
          await stopPanel();
          const t0 = Date.now();
          child = launchPanel();
          hwnd = await waitPanelWindow(20000, t0);
          if (!hwnd) throw new Error('P8 重启后未见面板窗口');
          panelPid = w32.threadIdOf(hwnd).pid;
          // 显示模式切换后 explorer 重挂托盘图标可能迟滞（工单04 实测）：8s 内轮询重扫
          const scanDeadline = Date.now() + 8000;
          while (!amber && Date.now() < scanDeadline) {
            await sleep(1000);
            amber = scanAmberInTray('area');
          }
        }
        amber && (!amberBase || amber.hits > amberBase.hits)
          ? rep.pass(`托盘图标可见：识别色命中 ${amber.hits} 像素 @(${amber.x},${amber.y})（基线 ${amberBase ? amberBase.hits : 0}），截图 03-tray-area.png`)
          : rep.fail('托盘图标未在可见区检出（识别色无增量）');
      }
    }

    // —— P9 Win+D 收起桌面：遮罩守望实证（事件+像素）+ 任意最小化来源的防抖自动恢复 ——
    // show desktop（ToggleDesktop/Win+D/任务栏右下角按钮）不最小化面板窗口（skipTaskbar
    // 下 shell 不视其为任务栏窗；注意 Electron 44 的 skipTaskbar 并不设置 WS_EX_TOOLWINDOW
    // 位——「工具窗豁免」旧说法不成立，见工单07）。
    // 工单07 根因与修法：show desktop 态 shell 把桌面宿主 Progman 抬到面板之上，壁纸连带
    // 盖住面板（窗口态全程正常——既有断言只查窗口状态因此漏检，真机 SendInput 复现 +
    // 逐帧截屏 + z 序枚举实证）。桌面遮罩守望（desktop-cover.ts）在 Progman 压顶时把面板
    // 临时提入 TOPMOST 带、Progman 回底即撤回重钉。本组断言三线并查：
    // ① cover-engaged 事件（守望器在 Win+D 后 1s 内进场）；
    // ② 像素级：Win+D 实拍 vs 最小化实拍在面板内容上显著不同（退化即二者同为壁纸、趋零）；
    // ③ 防抖恢复演练（SW_MINIMIZE）不受守望干扰。
    {
      const rect1 = w32.rectOf(hwnd);
      await sleep(400);
      const tWind = Date.now();
      w32.send([
        w32.keyInput(VK_LWIN, w32.KEYDOWN), w32.keyInput(VK_D, w32.KEYDOWN),
        w32.keyInput(VK_D, w32.KEYUP), w32.keyInput(VK_LWIN, w32.KEYUP),
      ]);
      rep.note('已发送 Win+D');
      await sleep(2000); // shell 收起动画与窗口落位
      const npIconic = w32.IsIconic(notepad.hwnd);
      const panelIconic = w32.IsIconic(hwnd);
      if (!npIconic) {
        rep.fail('Win+D 对照失败：记事本未被最小化，键盘投递未生效（本组断言不可信）');
      } else if (!panelIconic) {
        rep.pass('Win+D 收起桌面：普通窗（记事本）最小化，面板窗口未被收起（窗口态级豁免）');
        capture(rect1, '03-wind-immune');
        rep.note('Win+D 后实拍：面板仍在原位（对照窗已收起）；内容级断言见最小化实拍之后的比对');
        // ① 守望器进场存证（工单07）：遮罩守望在 Progman 压顶后 1s 内 engage
        const coverEngaged = await waitEvent('cover-engaged', (e) => e.t >= tWind, 4000);
        coverEngaged
          ? rep.pass('桌面遮罩守望进场：cover-engaged 已存证（Progman 压顶 → 面板临时 TOPMOST）')
          : rep.fail('桌面遮罩守望未进场（4s 内无 cover-engaged，Progman 压顶期面板处于壁纸之下）');
      } else {
        // 若未来 Windows 行为变化或面板失去工具窗豁免：防抖恢复机制接管
        const windMin = await waitEvent('wind-minimized', null, 6000);
        rep.note(`面板亦被 Win+D 最小化（存证 ${JSON.stringify(windMin)}），等待防抖自动恢复`);
      }
      // —— 防抖自动恢复真机演练：SW_MINIMIZE 收起面板 → 1.5s 防抖 → 自动恢复原位并重钉 ——
      const windMinPromise = waitEvent('wind-minimized', null, 6000);
      w32.ShowWindow(hwnd, SW_MINIMIZE);
      const windMin = await windMinPromise;
      await sleep(400);
      const minIconic = w32.IsIconic(hwnd);
      windMin && minIconic
        ? rep.pass(`面板被最小化（来源=SW_MINIMIZE，存证 why=${windMin.why}，IsIconic=true）`)
        : rep.fail(`面板最小化未检出（存证=${JSON.stringify(windMin)}，IsIconic=${minIconic}）`);
      if (minIconic) {
        const immunePng = path.join(__dirname, 'evidence', '03-wind-immune.png');
        const minimizedPng = capture(rect1, '03-wind-minimized');
        rep.note('最小化期实拍：面板收起（时钟卡区无实色内容）');
        // 工单07 像素级断言：Win+D 实拍 vs 最小化实拍——面板内容在场则显著不同，
        // 内容被合成层清空（真机复现的退化形态）则二者同为壁纸、均值差趋零。
        if (!fs.existsSync(immunePng)) {
          rep.note('immune 实拍缺席（面板同被 Win+D 收起的分支），像素断言本轮不适用');
        } else {
          const meanDiff = meanAbsDiff(immunePng, minimizedPng);
          meanDiff >= 8
            ? rep.pass(`Win+D 后面板内容像素级在场：与最小化（仅壁纸）实拍均值差 ${meanDiff.toFixed(1)}/255（≥8；合成层停帧退化即趋零）`)
            : rep.fail(`Win+D 后面板内容不可见（像素级）：与最小化实拍均值差仅 ${meanDiff.toFixed(1)}/255（<8，屏幕只剩壁纸——工单07 退化形态）`);
        }
      }
      const windRestored = await waitEvent('wind-restored', null, 10000);
      await sleep(600);
      const rect2 = w32.rectOf(hwnd);
      const tol = 24; // frameless 隐形边框（探针01-E 同 P6 容差）
      const okRect = rect2 && rect1 && Math.abs(rect2.left - rect1.left) <= tol
        && Math.abs(rect2.top - rect1.top) <= tol
        && Math.abs((rect2.right - rect2.left) - (rect1.right - rect1.left)) <= tol
        && Math.abs((rect2.bottom - rect2.top) - (rect1.bottom - rect1.top)) <= tol;
      windRestored && !w32.IsIconic(hwnd) && okRect
        ? rep.pass(`防抖自动恢复：${(windRestored.afterMs / 1000).toFixed(2)}s 后回到原位（存证 afterMs=${windRestored.afterMs}，矩形偏差在容差内）`)
        : rep.fail(`防抖自动恢复未达成（存证=${JSON.stringify(windRestored)}，IsIconic=${w32.IsIconic(hwnd)}，okRect=${okRect}）`);
      // 恢复后的重钉（票01 实施要点）：还原记事本，普通窗应重新盖住面板
      w32.ShowWindow(notepad.hwnd, SW_RESTORE);
      await sleep(600);
      const overlap = { x: 1800, y: 600 };
      w32.windowFromPointRoot(overlap) === notepad.hwnd
        ? rep.pass('最小化恢复后重钉生效：记事本重新盖住面板')
        : rep.fail(`恢复后重叠点命中 0x${w32.windowFromPointRoot(overlap).toString(16)}(${w32.className(w32.windowFromPointRoot(overlap))})，面板未回底`);
      capture(rect1, '03-wind-restored');
      // 工单11：show desktop 态残留会把桌面宿主 Progman 抬在面板之上，盖住后续段的
      // 交互探针（真机实证：会话行直达落点命中 Progman 被迫重试）——段末发送还原
      // toggle，把桌面态拨回常态再交棒。
      w32.send([
        w32.keyInput(VK_LWIN, w32.KEYDOWN), w32.keyInput(VK_D, w32.KEYDOWN),
        w32.keyInput(VK_D, w32.KEYUP), w32.keyInput(VK_LWIN, w32.KEYUP),
      ]);
      await sleep(1500);
      rep.note('已发送 Win+D 还原桌面态（清 show desktop 残留，防遮挡后续段探针）');
    }

    // —— P10 托盘退出闭环：UIA 系统级可见 + 退出后托盘随之消失 ——
    // 探针结论（工单03 迭代，7 轮真机实证）：Win11 26200 的 XAML 任务栏不把注入的右键
    // （SendInput 即时/保持/悬停）与键盘上下文菜单（聚焦后 Shift+F10）投递给 Electron 托盘
    // 图标——邻位 Win32 应用图标可达、本图标左键可达，唯右键不通，属 shell 行为而非应用缺陷；
    // 真人鼠标右键菜单（含「退出面板」项）留人工验收。电池自动化两条硬证据：
    // ① Win+B 键盘导航经 UIA 焦点链命中本图标（系统托盘里可见、名字正确、可聚焦）；
    // ② WM_CLOSE 走 window-all-closed → app.quit() → before-quit 拆托盘——与托盘菜单
    //   「退出面板」（click=app.quit()）共用同一退出管道，断言进程退出且托盘图标消失。
    {
      try {
        w32.send([
          w32.keyInput(VK_LWIN, w32.KEYDOWN), w32.keyInput(VK_B, w32.KEYDOWN), // Win+B
          w32.keyInput(VK_B, w32.KEYUP), w32.keyInput(VK_LWIN, w32.KEYUP),
        ]);
        await sleep(1200);
        const nav = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
          '-File', path.join(__dirname, 'lib', 'uia-focus.ps1'), '-Needle', 'AGENT DECK', '-MaxSteps', '20'],
        { encoding: 'utf8', timeout: 45000 });
        const navOut = (nav.stdout || '').trim();
        const focusLine = (navOut.split('\n').filter((l) => l.startsWith('STEP')).pop() || '').replace(/^STEP \d+: /, '');
        navOut.includes('MATCH')
          ? rep.pass(`托盘图标系统级可见：Win+B 键盘导航命中托盘焦点元素「${focusLine}」（tooltip 名匹配）`)
          : rep.fail(`托盘图标未被系统键盘导航命中（nav.status=${nav.status} 末步焦点「${focusLine}」全部输出：${JSON.stringify(navOut)} stderr: ${nav.stderr || '无'}）`);
        w32.tapKeys([VK_ESCAPE]); // 收起可能弹出的托盘气泡/焦点残留

        const t0 = Date.now();
        w32.PostMessageW(hwnd, WM_CLOSE, 0, 0);
        // 进程退出以面板真实主进程 pid（boot 自报）的存活轮询为准——spawn 的 child.pid 是
        // launcher 壳（票02 坑 2），其 exit 事件不可靠（实测 8s 内不触发）。
        const dead = await (async () => {
          const deadline = Date.now() + 10000;
          while (Date.now() < deadline) {
            await sleep(200);
            if (!isAlive(panelPid) && !w32.IsWindow(hwnd)) return true;
          }
          return false;
        })();
        dead
          ? rep.pass(`退出闭环：窗口销毁、主进程（pid=${panelPid}）退出（耗时 ${Date.now() - t0}ms）`)
          : rep.fail(`退出闭环未达成（窗口销毁=${!w32.IsWindow(hwnd)}，pid=${panelPid} 存活=${isAlive(panelPid)}）`);
        readEvents().some((e) => e.type === 'quit')
          ? rep.pass('退出管道经 before-quit 存证（quit，托盘随之 destroy）')
          : rep.fail('无 quit 存证');
        await sleep(1500);
        const afterExit = scanAmberInTray('after-exit');
        (!afterExit || afterExit.hits <= (amberBase ? amberBase.hits : 0))
          ? rep.pass('退出后托盘图标随之消失（识别色回落至基线水平，截图 03-tray-after-exit.png）')
          : rep.fail(`退出后识别色仍在托盘区（命中 ${afterExit.hits} 像素 @(${afterExit.x},${afterExit.y})）`);
      } finally {
        restorePromoted();
      }
    }

    // —— P9 工单09 会话行直达：点击会话行 → 工具窗口置前；工具未运行则启动。
    // 三条约束决定探针设计：
    // ① 真实五工具的启动/聚焦会扰动用户自己的应用 → 以 charmap（字符映射表）作受控探针进程，
    //    把 config.tools.qoder 指向它（进程名 charmap），内核只会对它动作；
    // ② 探针必须是「无用户数据、几乎不会自己开着」的经典 Win32 程序——上一版用 notepad
    //    犯了两个错：Win11 记事本是单实例（拿不到「新窗口」差集判据），且为拿干净起点
    //    关闭了全机 Notepad 窗口，动了用户自己的应用（含未保存标签页），违反 spec 主缝
    //    「造唯一名、验证启动、清理」的既有纪律（05/06 探针 lnk/文件均唯一命名）。
    //    charmap 窗口归属即其进程、不持有任何文档，关闭零损失；
    // ③ 本机可能一个活跃会话都没有（会话卡空 → 无行可点）→ 在 .qoder-cn 数据根种一条
    //    专属探针会话（唯一标记 DECK-PROBE-09），按 project 精确定位那一行，绝不点到用户自己的行。
    // 探针会话与 config 整段备份还原，不给用户留残留（08 同法）。
    // 探针窗口按「归属 exe 名 = charmap」识别，只关本段自己观测到的那一个 hwnd，
    // 不做「按类名遍历全机关闭」——
    // ④ 位置约束：本段是电池**最后一段**（排在 P10 之后、清场之前）。它要为改 config
    //    而重启面板；排在中间会连带搅乱 P5「杀进程还原」的图标状态机（两轮实证确定性失败）。
    //    排最后则谁也不扰动，清场仍照常收尾。代价是此时对照记事本还开着——只关电池自己
    //    记录的那一扇（下面 try 开头处），P7S 搜索段的记事本它自己段尾已关。——
    await (async () => {
      const configBackup09 = backupConfigB();
      const PROBE_EXE = 'charmap.exe';
      const PROBE_NAME = 'charmap';
      const probeExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', PROBE_EXE);
      const PROBE_TAG = 'DECK-PROBE-09';
      const qoderRoot = path.join(os.homedir(), '.qoder-cn');
      const probeProjDir = path.join(qoderRoot, 'projects', PROBE_TAG);
      const probeJsonl = path.join(probeProjDir, 'probe-session.jsonl');
      /** 探针窗口：按归属 exe 名识别（本段自己启动的那一个） */
      const probeWins = () => w32.topLevelWindows().filter((h) => w32.exeNameOfWindow(h) === PROBE_NAME);
      /** 只关我们自己观测到的探针 hwnd，绝不按类名遍历关闭其他应用 */
      const closeProbe = async () => {
        for (const h of probeWins()) { try { w32.PostMessageW(h, WM_CLOSE, 0, 0); } catch { /* 尽力 */ } }
        await sleep(600);
      };
      /** 种一条活跃探针会话（mtime = now，落 10 分钟活跃池；最后一条 tool_use → CONFIRM 态醒目） */
      const seedProbeSession = () => {
        fs.mkdirSync(probeProjDir, { recursive: true });
        const rec = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } };
        fs.writeFileSync(probeJsonl, JSON.stringify(rec) + '\n', 'utf8');
        const t = new Date();
        fs.utimesSync(probeJsonl, t, t);
      };
      /** 点探针那一行并等结果。失败须能自证原因（裸 null 无法区分「没找到行」与「点了没反应」） */
      const clickProbeRow = async (t0, why) => {
        const sess = lastEvent('sessions-rendered', (e) => e.rows && e.rows.length, 0);
        const row = ((sess && sess.rows) || []).find((r) => r.project === PROBE_TAG && r.rect);
        if (!row) {
          rep.note(`${why} 诊断：未找到探针行（sessions-rendered 最新 count=${sess ? sess.count : 'null'}，rows=${sess ? (sess.rows || []).length : 0}）`);
          return null;
        }
        const pr = w32.rectOf(hwnd);
        if (!pr) {
          rep.note(`${why} 诊断：面板窗 0x${hwnd.toString(16)} rect 取不到`);
          return null;
        }
        const pt = ptOfZoneAt(pr, row.rect);
        // 落点取证：面板矩形 / 行矩形 / 物理落点 / 落点处 WindowFromPoint 命中。
        // 注意「命中面板 hwnd」并不等于「点击被面板接收」——面板在非热区是穿透的，
        // 真正判据是渲染层有没有回 session-focus-clicked。
        const hit = w32.windowFromPointRoot(pt);
        rep.note(`${why} 诊断：panel 0x${hwnd.toString(16)} rect(${pr.left},${pr.top} ${pr.right - pr.left}x${pr.bottom - pr.top})`
          + ` rowRect(${Math.round(row.rect.x)},${Math.round(row.rect.y)} ${Math.round(row.rect.w)}x${Math.round(row.rect.h)})`
          + ` pt(${pt.x},${pt.y}) 落点命中 ${hit ? '0x' + hit.toString(16) : 'null'}`
          + `${hit && hit !== hwnd ? `(${w32.className(hit)} pid=${w32.threadIdOf(hit).pid}，非面板→被遮挡)` : ''}`);
        await occludedClickAt(pt, `会话行(${PROBE_TAG})`);
        return await waitEvent('session-focus-result', (e) => e.t >= t0, 6000);
      };
      /**
       * 以指定 tools 映射重启面板，等首拍含探针行的会话列表就绪。
       * 常规 launchPanel()（外层守卫形态）：P9 排在电池最后一段，
       * 重启面板不会再扰动前面任何探针的窗口/图标状态机。
       * 位置约束（两轮实证）：P9 必须排在最后——它要为改 config 而重启面板，
       * 放在中间会连带搅乱 P5「杀进程还原」的图标状态机（确定性失败）。
       */
      const relaunchWith = async (toolsPatch) => {
        let cfg = {};
        try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE_B, 'utf8')); } catch { cfg = {}; }
        cfg.tools = { ...(cfg.tools || {}), ...toolsPatch };
        await stopPanel();
        fs.writeFileSync(CONFIG_FILE_B, JSON.stringify(cfg, null, 2) + '\n');
        const t = Date.now();
        child = launchPanel();
        const h = await waitPanelWindow(20000, t);
        if (h) { hwnd = h; panelPid = win32.threadIdOf(h).pid; }
        const ready = await waitEvent('sessions-rendered',
          (e) => e.t >= t && e.rows && e.rows.some((r) => r.project === PROBE_TAG), 15000);
        return { hwnd: h, ready };
      };
      try {
        if (!fs.existsSync(probeExe)) {
          rep.fail(`会话行直达探针前置失败：未找到探针进程 ${probeExe}`);
          return;
        }
        // 前置：探针程序此刻不该在跑。若在跑（用户自己开的），本段宁可如实降级也不去动它——
        // 「拿不到干净起点就跳过」远好过「关掉用户的窗口」。
        if (probeWins().length) {
          rep.note(`会话行直达探针跳过：探针程序 ${PROBE_EXE} 已在运行（${probeWins().length} 个窗口），不干预用户进程`);
          return;
        }
        // 清场：关掉**电池自己**开的那扇对照记事本窗（notepad 变量记录的那一个，
        // 本来就在最外层 finally 里要关）。它按 launchNotepad 的 rect 铺在 phys(1000,200)
        // 1400x900，正好压住右上角会话行 → 落点被遮挡、点击根本到不了面板。
        // 只关这一个已记录句柄，绝不按类名遍历全机（用户自己的记事本一律不碰）。
        if (notepad) {
          try { w32.PostMessageW(notepad.hwnd, WM_CLOSE, 0, 0); } catch { /* 尽力 */ }
          try { notepad.child.kill(); } catch { /* 尽力 */ }
          await sleep(700);
        }
        // b0. 工具→exe 映射的启动目标存在性（只读核对，不启动任何真实工具）：
        //     映射写错时点会话行会「每次重跑启动器」，属本票唯一无法用探针覆盖的风险。
        //     只核 config.json 里显式存在的条目（默认值在代码里，电池不 import 生产代码，
        //     缺 tools 段时如实说明而不假装核过）。
        const expand09 = (s) => String(s).replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g,
          (w, n) => process.env[n] ?? w);
        let cfgReal = {};
        try { cfgReal = JSON.parse(fs.readFileSync(CONFIG_FILE_B, 'utf8')); } catch { cfgReal = {}; }
        const toolsReal = (cfgReal.tools && typeof cfgReal.tools === 'object') ? cfgReal.tools : {};
        const toolNames = Object.keys(toolsReal);
        if (!toolNames.length) {
          rep.note('工具映射核对：config.json 无显式 tools 段（面板走代码内五工具默认值，电池不 import 生产代码故不核）');
        } else {
          const missingTools = toolNames
            .filter((k) => !toolsReal[k] || typeof toolsReal[k].launch !== 'string'
              || !expand09(toolsReal[k].launch).trim() || !fs.existsSync(expand09(toolsReal[k].launch)));
          missingTools.length === 0
            ? rep.pass(`工具→exe 映射核对：config 显式的 ${toolNames.length} 个工具启动目标在本机均存在（只读核对，未启动真实工具）`)
            : rep.fail(`工具映射启动目标缺失：${missingTools.join(', ')}（点击会话行会退化为「每次重跑启动器」）`);
        }
        seedProbeSession();
        rep.note(`会话行直达探针：受控探针进程 ${path.basename(probeExe)} + 探针会话 ${PROBE_TAG}（工具槽位 qoder 指向探针）`);

        // b. 启动路径：探针未运行 → 点探针行应拉起 charmap
        const r1 = await relaunchWith({ qoder: { launch: probeExe, processes: [PROBE_NAME] } });
        if (!r1.hwnd) { rep.fail('会话行直达探针：面板重启后窗口未出现'); return; }
        if (!r1.ready) { rep.fail('会话行直达探针：探针会话行未出现在会话卡（种会话未被扫描）'); return; }
        const beforeLaunch = new Set(w32.topLevelWindows());
        const tLaunch = Date.now();
        const resLaunch = await clickProbeRow(tLaunch, '启动路径');
        let probeWin = null;
        const deadlineLaunch = Date.now() + 8000;
        while (Date.now() < deadlineLaunch && !probeWin) {
          await sleep(250);
          // 只认「新出现且归属探针 exe」的窗口：既不误认别的应用，也不用关任何既有窗口
          probeWin = w32.topLevelWindows()
            .find((hw) => !beforeLaunch.has(hw) && w32.exeNameOfWindow(hw) === PROBE_NAME) || null;
        }
        resLaunch && resLaunch.action === 'launched' && probeWin
          ? rep.pass(`会话行直达·启动路径：工具未运行 → 点击会话行拉起其 exe（action=launched，探针 ${PROBE_EXE} 窗口 0x${probeWin.toString(16)} 出现）`)
          : rep.fail(`启动路径未过（result=${JSON.stringify(resLaunch)}，探针窗口=${probeWin ? '0x' + probeWin.toString(16) : '未出现'}）`);
        fullShot('09-session-focus-launched');

        // c. 聚焦路径：探针窗口已在 → 挪到屏幕左侧（会话卡在右上信息列，挪开才点得到落点），
        //    SW_MINIMIZE 收起它（前台随之离开探针），点探针行应把它还原并带到前台。
        //    判据用「最小化 → 前台」而非「另开盖窗」：charmap 窗口归属其自身进程，
        //    盖窗法会引入第三个进程变量，而最小化→还原同时覆盖内核的 SW_RESTORE 分支。
        if (probeWin) {
          const leftRect = { x: Math.round(si.phys.w * 0.06), y: Math.round(si.phys.h * 0.30), w: 620, h: 420 };
          w32.SetWindowPos(probeWin, w32.HWND_TOP, leftRect.x, leftRect.y, leftRect.w, leftRect.h,
            w32.SWP_NOACTIVATE);
          await sleep(300);
          w32.ShowWindow(probeWin, SW_MINIMIZE);
          await sleep(600);
          const probePid = w32.threadIdOf(probeWin).pid;
          const fgBefore = w32.GetForegroundWindow();
          const beforePid = fgBefore ? w32.threadIdOf(fgBefore).pid : 0;
          const tFocus = Date.now();
          const resFocus = await clickProbeRow(tFocus, '聚焦路径');
          await sleep(700);
          const fgAfter = w32.GetForegroundWindow();
          const afterPid = fgAfter ? w32.threadIdOf(fgAfter).pid : 0;
          const stillIconic = w32.IsIconic(probeWin);
          resFocus && resFocus.action === 'focused' && resFocus.hwnd === probeWin
            && afterPid === probePid && !stillIconic
            ? rep.pass(`会话行直达·聚焦路径：工具在跑 → 点击会话行把其窗口还原并带到前台（探针 pid ${probePid}，点击前前台 pid=${beforePid}，点击后=${afterPid}，IsIconic=${stillIconic}）`)
            : rep.fail(`聚焦路径未过（result=${JSON.stringify(resFocus)}，hwnd 期望=${probeWin}，点击前前台 pid=${beforePid}，点击后=${afterPid}，探针 pid=${probePid}，仍最小化=${stillIconic}）`);
          fullShot('09-session-focus-focused');
        } else {
          rep.fail('聚焦路径前置失败：启动路径未拉起探针窗口');
        }

        // d. 静默降级：清空 qoder 映射 → 点击既不能聚焦也不能启动，
        //    断言返回 degraded，且面板仍可交互（点时钟卡仍能收到 click 存证 = 没崩）。
        await closeProbe();
        const r2 = await relaunchWith({ qoder: { launch: '', processes: [] } });
        if (!r2.hwnd) { rep.fail('降级探针：面板重启后窗口未出现'); return; }
        if (!r2.ready) { rep.fail('降级探针：探针会话行未出现'); return; }
        const tDeg = Date.now();
        const resDeg = await clickProbeRow(tDeg, '降级');
        // 面板存活探针：降级点击后再点时钟卡，仍能收到 click 存证即面板未崩。
        // 热区矩形只认**本次重启**的现场：卡片由插件异步挂载，重启后还没挂上时宁可等，
        // 也不能拿上一任面板的旧矩形去点（那会点在没有热区的空处 → 落到桌面 → 误判面板已死）。
        let clockZone = null;
        for (let i = 0; i < 20 && !clockZone; i++) {
          await sleep(300);
          clockZone = latestZoneOf('clock-card', lastBootMs());
        }
        let alive = null;
        if (clockZone) {
          const tAlive = Date.now();
          await occludedClickAt(ptOfZoneAt(w32.rectOf(hwnd), clockZone), '时钟卡');
          alive = await waitEvent('clock-card-clicked', (e) => e.t >= tAlive, 4000);
        }
        resDeg && resDeg.action === 'degraded' && !resDeg.ok && alive
          ? rep.pass(`会话行直达·静默降级：失效目标返回 degraded（reason=${resDeg.error}）且面板未崩（降级后仍可交互：时钟卡点击存证到达）`)
          : rep.fail(`降级探针未过（result=${JSON.stringify(resDeg)}，面板存活=${Boolean(alive)}）`);
      } finally {
        w32.moveMousePhys(safePt.x, safePt.y);
        await closeProbe();
        try { fs.rmSync(probeProjDir, { recursive: true, force: true }); } catch { /* 尽力清探针会话 */ }
        restoreConfigB(configBackup09);
      }
    })();
    // —— P11 工单10 桌面组件（插件体系自举）：外部样例插件「放入即被识别」——
    // 位置纪律（沿用 09 踩坑 8）：本段是电池的**最后一段**（P9 之后、清场之前）。本段要在
    // 电池运行中改 userData 下的插件目录，排在中间会扰动前面探针的时序。
    // 唯一判据的形状：**全程不重启面板**——只往插件目录里放一个目录，面板自己认出来。
    // 「没重启」由 boot 存证条数不变来证，不靠自述。
    await (async () => {
      const pluginsDir = path.join(userDataDir, 'plugins');
      const sampleSrc = path.join(APP_ROOT, 'samples', 'hello-plugin');
      const dest = path.join(pluginsDir, 'hello');
      const bootCount = () => readEvents().filter((e) => e.type === 'boot').length;
      try {
        // 0. 内置四卡自举：四个桌面组件必须**经插件契约**装载（不是面板自己画的）。
        //    事件按面板代次取（lastBootMs 之后）：事件文件跨重启不清，上一任面板的
        //    plugin-mounted 留着会让本段假通过。
        const since = lastBootMs();
        const builtinIds = ['clock', 'weather', 'sessions', 'hardware'];
        const builtinMounted = builtinIds.filter((id) => lastEvent('plugin-mounted', (e) => e.id === id, since));
        // 观感一致性的机器可查部分：四张卡都进了热区声明（都在场、都在点击穿透模型里），
        // 且时钟卡矩形与 renderer/index.html 的 CARD_DIP 逐项相等。像素级观感仍按既有
        // 惯例人工核验截图（spec：界面视觉对齐不设自动化缝）。
        const cardZones = new Map(((readEvents().filter((e) => e.type === 'hotzones' && e.t >= since).pop() || {}).rects || [])
          .filter((r) => builtinIds.includes(`${r.id}`.replace('-card', '')))
          .map((r) => [r.id, r]));
        const zonesOk = builtinIds.every((id) => cardZones.has(`${id}-card`));
        const geomOk = cardZones.get('clock-card')
          && cardZones.get('clock-card').x === CARD_DIP.x && cardZones.get('clock-card').y === CARD_DIP.y
          && cardZones.get('clock-card').w === CARD_DIP.w && cardZones.get('clock-card').h === CARD_DIP.h;
        builtinMounted.length === builtinIds.length && zonesOk && geomOk
          ? rep.pass(`桌面组件·内置四卡自举：${builtinIds.join('/')} 四张信息卡均经插件契约装载渲染，`
            + `且四张都进了热区声明（时钟卡矩形 ${CARD_DIP.x},${CARD_DIP.y} ${CARD_DIP.w}x${CARD_DIP.h} 与 index.html 一致；`
            + `像素级观感按惯例人工核验 04-cards-*.png）`)
          : rep.fail(`桌面组件·内置四卡自举未过：经插件契约装载 ${builtinMounted.join('/') || '无'}`
            + `（缺 ${builtinIds.filter((i) => !builtinMounted.includes(i)).join('/') || '无'}）；`
            + `热区声明 ${zonesOk ? '齐' : `缺 ${builtinIds.filter((i) => !cardZones.has(`${i}-card`)).join('/') || '无'}`}；`
            + `时钟卡矩形 ${geomOk ? '一致' : `不符（实得 ${JSON.stringify(cardZones.get('clock-card') || null)}）`}`);

        // 0.5 Qoder 状态块退役（工单03）：热区声明按 id 找 qoder-card 应缺席，
        //     会话卡加高补位——top 152 不动、高 348→522（吞 16px 间隙 + 158px 状态块槽，
        //     底缘 674 与硬件卡 top 690 之间仍隔 16px），硬件卡位置零改动。
        const zoneRects = (readEvents().filter((e) => e.type === 'hotzones' && e.t >= since).pop() || {}).rects || [];
        const qoderGone = !zoneRects.some((r) => r.id === 'qoder-card');
        const sz = zoneRects.find((r) => r.id === 'sessions-card');
        const fillOk = Boolean(sz) && sz.y === 152 && sz.h === 522;
        qoderGone && fillOk
          ? rep.pass(`Qoder 状态块退役：qoder-card 不在任何热区声明里，会话卡加高补位到位`
            + `（top ${sz.y}、高 ${sz.h}，覆盖原状态块槽位 152..674）`)
          : rep.fail(`Qoder 状态块退役探针未过：qoder-card ${qoderGone ? '已缺席' : '仍在热区声明'}，`
            + `sessions-card 矩形 ${JSON.stringify(sz || null)}（期望 top 152 / 高 522）`);

        if (!fs.existsSync(sampleSrc)) { rep.fail('桌面组件探针前置失败：样例插件源缺失'); return; }
        if (lastEvent('plugin-mounted', (e) => e.id === 'hello', since)) {
          rep.fail('桌面组件探针前置失败：样例插件在电池启动前已在装（干净起点不成立）');
          return;
        }
        const boots0 = bootCount();
        const t0 = Date.now();
        fs.mkdirSync(dest, { recursive: true });
        for (const name of ['plugin.json', 'card.js']) {
          fs.copyFileSync(path.join(sampleSrc, name), path.join(dest, name));
        }
        rep.note(`桌面组件探针：样例插件已放入 ${dest}（本段不重启面板，boot 存证基线 ${boots0} 条）`);

        // ① 主进程认到插件并把前端入口投递给渲染层（plugins/changed → plugin-mounted）
        const mounted = await waitEvent('plugin-mounted', (e) => e.id === 'hello' && e.t >= t0, 15000);
        // ② 插件模块自身跑起来（deck-plugin:// 动态 import 成功 → mount 被调）
        const ran = await waitEvent('hello-mounted', (e) => e.t >= t0, 8000);
        // ③ 卡片进入热区：插件组件与面板卡片同一套点击穿透模型，不是画上去的死图
        let zone = null;
        for (let i = 0; i < 20 && !zone; i++) { await sleep(300); zone = latestZoneOf('hello-card'); }
        const boots1 = bootCount();
        if (!mounted) {
          rep.fail('桌面组件探针未过：插件放入后 15s 内未收到 plugin-mounted（主进程未认到或未投递）');
          return;
        }
        if (!ran) {
          rep.fail(`桌面组件探针未过：主进程已投递入口，但插件模块未跑起来（无 hello-mounted；`
            + `看面板 stderr 的 CSP/协议错误；capabilities=${JSON.stringify(mounted.capabilities)}）`);
          return;
        }
        if (!zone) {
          rep.fail('桌面组件探针未过：插件卡片未进入热区（点了没反应 = 面板在非热区是穿透的）');
          return;
        }
        boots1 === boots0
          ? rep.pass(`桌面组件·放入即识别：外部样例插件放入插件目录后**无需重启面板**即被装载并渲染`
            + `（capabilities=${JSON.stringify(mounted.capabilities)}，卡片热区 ${Math.round(zone.w)}x${Math.round(zone.h)}，boot 存证 ${boots0}→${boots1} 未增）`)
          : rep.fail(`桌面组件探针无效：插件装载期间面板重启过（boot 存证 ${boots0}→${boots1}），本段断言不成立`);
        fullShot('10-plugin-hello');

        // ② 运行时重载：改插件自己的 card.js → 代号递增 → 渲染层重挂（不重启面板）
        const tReload = Date.now();
        const cardFile = path.join(dest, 'card.js');
        fs.writeFileSync(cardFile,
          fs.readFileSync(cardFile, 'utf8').replace('EXTERNAL PLUGIN OK', 'EXTERNAL PLUGIN RELOADED'), 'utf8');
        const reloaded = await waitEvent('plugin-mounted', (e) => e.id === 'hello' && e.t >= tReload, 15000);
        reloaded
          ? rep.pass('桌面组件·运行时重载：改插件自身资产后即时重载生效（未重启面板，入口代号变化即换 URL 绕开 ESM 模块缓存）')
          : rep.fail('桌面组件·重载未过：改 card.js 后 15s 内未再次收到 plugin-mounted');

        // ③ 卸载：移除插件目录 → 卡片从热区消失（点击不再有反应，场面上真的走了）
        const tUnload = Date.now();
        fs.rmSync(dest, { recursive: true, force: true });
        let gone = false;
        for (let i = 0; i < 25 && !gone; i++) {
          await sleep(300);
          const last = readEvents().filter((e) => e.type === 'hotzones' && e.t >= tUnload).pop();
          gone = Boolean(last && !(last.rects || []).some((r) => r.id === 'hello-card'));
        }
        gone
          ? rep.pass('桌面组件·卸载：移除插件目录后其卡片从面板消失（热区不再声明，无残留死区）')
          : rep.fail('桌面组件·卸载未过：移除插件目录后 8s 内卡片仍在热区里');

        // ④ 重装恢复：放回同一个目录 → 卡片回来（安装位语义：放入即被识别）
        const tReinstall = Date.now();
        fs.mkdirSync(dest, { recursive: true });
        for (const name of ['plugin.json', 'card.js']) {
          fs.copyFileSync(path.join(sampleSrc, name), path.join(dest, name));
        }
        const back = await waitEvent('plugin-mounted', (e) => e.id === 'hello' && e.t >= tReinstall, 15000);
        let backZone = null;
        for (let i = 0; i < 20 && !backZone; i++) { await sleep(300); backZone = latestZoneOf('hello-card'); }
        const boots2 = bootCount();
        back && backZone && boots2 === boots0
          ? rep.pass('桌面组件·重装恢复：把插件目录放回即恢复装载与渲染（boot 存证全程未增 = 四步都没重启面板）')
          : rep.fail(`桌面组件·重装未过（plugin-mounted=${Boolean(back)}，卡片热区=${Boolean(backZone)}，boot ${boots0}→${boots2}）`);
        fullShot('10-plugin-reinstalled');
      } finally {
        // 不给用户留残留：插件目录里的东西电池放进去的，电池自己收走
        try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* 尽力 */ }
        rep.note(`桌面组件探针清场：已移除 ${dest}`);
      }
    })();
  } catch (e) {
    rep.fail(`电池中断: ${e && e.stack || e}`);
  } finally {
    // —— 清场 ——
    restorePromoted();
    try { w32.tapKeys([VK_ESCAPE]); } catch { /* 尽力收起残留菜单 */ }
    await sleep(300);
    if (notepad) {
      try { w32.PostMessageW(notepad.hwnd, WM_CLOSE, 0, 0); } catch { /* 尽力 */ }
      try { notepad.child.kill(); } catch { /* 尽力 */ }
      await sleep(400);
    }
    // P7S 探针目录：记事本（探针标签所在窗）已关、句柄释放，现在删得掉
    if (searchProbeDir) {
      for (let i = 0; i < 3; i++) {
        try { fs.rmSync(searchProbeDir, { recursive: true, force: true }); } catch { /* 尽力 */ }
        if (!fs.existsSync(searchProbeDir)) break;
        await sleep(1000);
      }
      fs.existsSync(searchProbeDir)
        ? rep.note(`探针目录未能删除（句柄仍被占用）: ${searchProbeDir}`)
        : rep.note('搜索探针目录已清理');
    }
    await stopPanel();
    // 工单05 清场核验：面板被 /F 清杀时守卫无还原路径（还原依赖存活），图标若仍隐藏则走
    // --icon-restore 自救通道回到电池前状态（电池不得改变用户原生偏好）
    try {
      const hiddenNow = !w32.desktopIconsVisible();
      if (iconsVisibleBase && hiddenNow) {
        const r = spawnSync(process.execPath, ['.', '--icon-restore'], { cwd: APP_ROOT, encoding: 'utf8', timeout: 20000 });
        await sleep(1500);
        w32.desktopIconsVisible()
          ? rep.note('清场兜底：--icon-restore 已还原图标（守卫被 /F 清杀时的自救通道）')
          : rep.note(`清场兜底未生效（status=${r.status} ${r.stderr || ''}），图标可能仍隐藏`);
      } else {
        rep.note(`图标状态清场核验：visible=${w32.desktopIconsVisible()}（电池前=${iconsVisibleBase}）`);
      }
    } catch (e) { rep.note(`图标清场核验异常: ${e && e.message || e}`); }
    // 工单06 清场：还原摆位存储到电池前状态（种子只服务断言，不得改变用户真实摆位）
    try {
      if (layoutBackup === null) fs.unlinkSync(layoutFile);
      else fs.writeFileSync(layoutFile, layoutBackup);
      rep.note(`摆位存储清场：${layoutBackup === null ? '已删除（电池前不存在）' : '已还原备份'}`);
    } catch (e) { rep.note(`摆位存储清场异常: ${e && e.message || e}`); }
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
