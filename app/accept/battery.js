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
const { Report, parseAcceptScope } = require('./lib/report');
const { createPanelControl, findPanelWindows, classifyPreflight } = require('./lib/panel-control');

const APP_ROOT = path.resolve(__dirname, '..');
const EVENTS_FILE = path.join(__dirname, 'evidence', '03-runtime-events.jsonl');
const WM_CLOSE = 0x0010;
const VK_LWIN = 0x5b, VK_B = 0x42, VK_D = 0x44, VK_DOWN = 0x28, VK_UP = 0x26, VK_RETURN = 0x0d, VK_ESCAPE = 0x1b;
const VK_CONTROL = 0x11, VK_V = 0x56, VK_A = 0x41, VK_C = 0x43, VK_X = 0x58, VK_DELETE = 0x2e;
const NOTIFY_ICON_SETTINGS = 'HKCU:\\Control Panel\\NotifyIconSettings';
// 托盘图标的程序化识别色（tray.ts 琥珀 #f5a623 → RGB）
const AMBER = [245, 166, 35];
// 卡片几何须与 src/renderer/index.html 的 .card 布局保持一致（DIP）
const CARD_DIP = { x: 48, y: 48, w: 320, h: 176 }
const LEFT_CARDS_DIP = { x: 48, y: 48, w: 320, h: 686 }   // 时钟+天气+日历（至 734）
// 右列自 07 起顶部是搜索面板（SEARCH 卡 ~89 高 + 会话（工单03 起加高吞掉 Qoder 状态块槽），
// 底缘至 674——工单59 硬件卡退役，其显示职责由任务栏硬件摘要承接）
const RIGHT_CARDS_DIP = { right: 48, y: 48, w: 420, h: 626 }
// 搜索卡几何（与 src/renderer/index.html #search-card 一致；results 展开随事件重取）
const SEARCH_CARD_DIP = { right: 48, y: 48, w: 420, h: 89 }
// 工单05 桌面承载分区几何（与 renderer/index.html #doc-zone 一致）：
// 文档区 x408 起、max-width 640（满 8 行折右列的列流布局，透明带取样按最宽取 1056）。
// 工单59：dock 条随应用区一并退役，面板只剩文档区一处承载，底部不再有要避让的常驻条。
const DOC_ZONE_RIGHT_DIP = 1056

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

// 物理像素区域截图（DPI 感知 PowerShell）。20s 超时偶尔会咬一口（PS 冷启动 + 屏
// 捕获被系统占住），重试一次再判死——单次抖动不该把整轮电池带走。
function capture(rect, name) {
  const out = path.join(__dirname, 'evidence', name + '.png');
  const { spawnSync } = require('child_process');
  let r = null;
  for (let i = 0; i < 2; i++) {
    r = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(__dirname, 'lib', 'capture.ps1'),
      '-Out', out, '-X', String(rect.left), '-Y', String(rect.top),
      '-W', String(rect.right - rect.left), '-H', String(rect.bottom - rect.top),
    ], { encoding: 'utf8', timeout: 20000 });
    if (r.status === 0 && fs.existsSync(out)) return out;
  }
  throw new Error(`capture 失败: status=${r.status} signal=${r.signal} err=${r.error ? r.error.message : '无'} stdout=${r.stdout} stderr=${r.stderr}`);
}

// 进程内快速截屏（desktopCapturer，~200ms）：与时序敏感的断言配对使用。
// 工单16 验证轮实证：Win+D 像素断言的「最小化实拍」走 PowerShell 子进程（~1s），
// 与 1500ms 防抖自动恢复赛跑——PS 慢一拍就把还原后的 deck 拍进去，两图同为
// 「deck 在场」→ 均值差趋零 → 假失败。此 helper 无子进程延迟，只供该对实拍。
async function captureFast(rect, name) {
  const { desktopCapturer } = require('electron');
  const phys = screenInfo().phys;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: phys.w, height: phys.h },
  });
  const full = sources[0] && sources[0].thumbnail;
  if (!full || full.isEmpty()) throw new Error('captureFast 失败：desktopCapturer 无可用屏源');
  const crop = full.crop({
    x: Math.max(0, rect.left), y: Math.max(0, rect.top),
    width: Math.min(rect.right - rect.left, phys.w - rect.left),
    height: Math.min(rect.bottom - rect.top, phys.h - rect.top),
  });
  const out = path.join(__dirname, 'evidence', name + '.png');
  fs.writeFileSync(out, crop.toPNG());
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
function psRun(script, timeoutMs) {
  return psSpawn(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], timeoutMs);
}

function psRunFile(args, timeoutMs) {
  return psSpawn(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ...args], timeoutMs);
}

function psSpawn(args, timeoutMs = 15000) {
  const r = spawnSync('powershell.exe', args, { encoding: 'utf8', timeout: timeoutMs });
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

// 造验收 bat 探针（工单59 起替代 lnk 探针：lnk 归应用区随 dock 退役不再有可视矩形，
// bat 归 other 组落在文档区，双击/【打开】走同一条 desktop/launch 链路，目标进程写标记文件）。
function createProbeBat(batPath, markerPath) {
  fs.writeFileSync(batPath, `@echo off\r\necho ok>"${markerPath}"\r\n`, 'ascii');
}

// 造指向指定 exe 的验收 lnk（工单01 图标区分度探针夹具）。ASCII-only 临时 ps1 走
// -File（内联 -Command 传 COM 调用在本机实测挂起/静默失败）。不声明图标定位——默认图标
// 留空，决策链走「未声明回落目标可执行文件」分支。
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
// 用户窗口随时抬回面板上空，SendInput 整段被覆盖窗偷走，探针以「无存证」假死
// （真机实证：单击过、9 秒后双击挂；像素级取证落点命中的是覆盖窗而非面板，几何
// 与时序无罪）。命中桌面层（Progman/WorkerW 等）= show desktop 态残留或面板不在
// 屏，最小化覆盖窗无意义，直接带诊断失败；普通覆盖窗按 clearDesktop 同法最小化
// 并记入还原清单，重试至命中。
// —— OLE 拖拽幽灵拆解（工单59 验收首跑真机事故）：——
// 光标底下被 OLE 的 Ghost 幽灵窗盖住时，落点校验永远不成立：那是拖拽会话自己画在
// 光标上的顶层窗，ShowWindow 最小化对它无效，ensurePanelHit 四轮全空 → 后面几十段
// 连锁判死（首跑 52 fail 的形态）。ESC 撤会话、未抬起的键鼠补一次抬起，是 OLE 拖拽
// 唯一通用退场法；退不掉就把主人（pid/进程名）与全场窗景报出来，别只留一个类名。
let ghostDumped = false;
// 幽灵主人身份只查一次（PowerShell 查进程链要半秒，几十段连锁失败不能每段都查）：
// pid → 「exe 名 ← 父 exe(pid)｜命令行」一行摘要，取不到就存 '?'，不抛。
const ghostIdentities = new Map();

function ghostIdentity(pid) {
  if (ghostIdentities.has(pid)) return ghostIdentities.get(pid);
  let out = '?';
  try {
    const raw = spawnSync('powershell', [
      '-NoProfile', '-Command',
      `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"` +
      `;if($p){$pp=Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)"` +
      `;"$($p.Name)|$($p.ParentProcessId)|$($pp.Name)|$($p.CommandLine)"}`,
    ], { encoding: 'utf8', timeout: 8000, windowsHide: true }).stdout || '';
    const [name, ppid, pname, cmd] = raw.trim().split('|');
    if (name) out = `${name} 父=${ppid}(${pname || '?'})${cmd ? ` cmd=${cmd.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`;
  } catch { /* 取不到就存 '?'，取证不该带崩电池 */ }
  ghostIdentities.set(pid, out);
  return out;
}

/** 面板活体探针：窗还在 ≠ 面板还能干活。窗口过程跑在浏览器进程主线程，
 * SendMessageTimeout 超时即主线程不泵消息（与「面板已退出」严格分开报——两种形态
 * 的修法完全不同）。结果指针必须给真缓冲：传 null 时 user32 可能不解引用而直接判
 * 失败，一台活着的面板会被误报成假死（首跑据此误判过一次「面板卡死」）。 */
function panelLiveness(hwnd) {
  const h = Number(hwnd);
  if (!win32.IsWindow(h)) return '已退出';
  try {
    const out = Buffer.alloc(16);
    return win32.SendMessageTimeoutW(h, 0, 0, 0, 0x0002, 2000, out) ? '主线程在' : '主线程假死(WM_NULL 超时)';
  } catch { return '活体探针异常'; }
}

let hungDumped = false;
// 面板假死自愈钩子（主流程装配成闭包：取证 → 重启面板 → 交还新 hwnd）。假死态下任何
// 落点断言都不可能成立，留在原地只会让后续几十段连锁判死（首跑 52 fail 的形态）；
// 工单110 起它记环境降责排除而非失败：停摆是环境事件，检出即开排除窗，窗内失败断言
// 改记排除——环境噪声不再污染 verdict。
let healHungPanel = null;
// 重启健康验证钩子（工单110）：排除窗自停摆检出开启，至「面板重启验证健康」闭合。
// 验证判据取 ensurePanelHit 的落点命中（点击真能落到面板上=新面板可服务），故由
// 主流程装配成闭包，ensurePanelHit 命中时回调闭合排除窗；其后失败断言恢复记失败。
let onPanelHealthy = null;
/** 面板假死取证（只取第一次）：冻住前最后在做什么（事件尾）+ 谁在跑（进程树、
 * 主线程态/等待原因、CPU）。判「卡在谁身上」只有这三样，别的都是猜。 */
function hungForensics(hwnd) {
  if (hungDumped) return '';
  hungDumped = true;
  const lines = [];
  try {
    const evs = readEvents().slice(-14);
    lines.push(`事件尾：${evs.map((e) => `${new Date(e.t).toISOString().slice(11, 23)} ${e.type}`).join(' ; ')}`);
  } catch (e) { lines.push(`事件尾取不到：${e.message}`); }
  let pid = 0;
  try { pid = win32.threadIdOf(Number(hwnd)).pid; } catch { /* 窗已销毁 */ }
  if (pid) {
    const ps = spawnSync('powershell', ['-NoProfile', '-Command', [
      `$ids=@(${pid}) + @((Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${pid} }).ProcessId)`,
      `$rows=@(); foreach($id in $ids){ $p=Get-Process -Id $id -ErrorAction SilentlyContinue; $n=(Get-CimInstance Win32_Process -Filter "ProcessId=$id").Name; $t=if($p){($p.Threads | ForEach-Object { "$($_.ThreadState)/$($_.WaitReason)" } | Group-Object | Sort-Object Count -Descending | Select-Object -First 3 | ForEach-Object { "$($_.Name)x$($_.Count)" }) -join ' '}else{'<已退出>'}; $rows += "$id $n cpu=$($p.CPU)s 线程=$t" }`,
      `$rows -join [Environment]::NewLine`,
    ].join(';')], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    lines.push((ps.stdout || ps.stderr || '').trim());
  }
  return lines.join('\n');
}


function cancelDragGhost() {
  try {
    win32.send([win32.keyInput(VK_ESCAPE, win32.KEYDOWN), win32.keyInput(VK_ESCAPE, win32.KEYUP)]);
    win32.send([win32.mouseInput(0, 0, win32.LEFTUP), win32.mouseInput(0, 0, win32.RIGHTUP)]);
  } catch { /* 尽力：拆不掉就走下面的判死 */ }
}

async function ensurePanelHit(pt, hwnd) {
  for (let i = 0; i < 4; i++) {
    win32.moveMousePhys(pt.x, pt.y);
    await sleep(400); // 热区轮询 25ms，留足解除穿透
    // 面板窗没了（进程退出）时落点校验没有意义：立刻带着取证中止，别把「面板没了」
    // 说成遮挡、也别让后面几十段连锁判死（首跑 52 fail 的形态就是这么来的）
    if (!win32.IsWindow(Number(hwnd))) {
      const err = new Error(`面板中途退出：hwnd=0x${Number(hwnd).toString(16)} 已不是窗口（面板进程没了）`);
      err.panelDead = true;
      throw err;
    }
    const root = Number(win32.windowFromPointRoot(pt));
    if (root === Number(hwnd)) {
      // 工单112：命中面板 ≠ 面板健康——停摆的窗不收窗消息但仍中落点。命中即探活，
      // 假死走自愈（首跑二次停摆被「命中即健康」短路放过的形态，见工单110 现场记录）。
      const live = panelLiveness(hwnd);
      if (live.startsWith('主线程假死')) {
        const healed = healHungPanel ? await healHungPanel() : false;
        if (healed) return { ok: false, why: '落点命中面板但主线程假死→已重启面板，本段跳过' };
      }
      if (onPanelHealthy) onPanelHealthy(); // 落点命中面板=重启健康验证（工单110：闭合排除窗）
      return { ok: true };
    }
    const cls = win32.className(root);
    if (CLEAR_DESKTOP_SKIP.has(cls)) {
      // 工单112：命中桌面层也可能是面板停摆退到了桌面层之下——先探活再下「残留」结论，
      // 别把二次停摆说成 show desktop 残留（工单110 现场发现的漏检点）。
      const live = panelLiveness(hwnd);
      if (live.startsWith('主线程假死')) {
        const healed = healHungPanel ? await healHungPanel() : false;
        if (healed) return { ok: false, why: '面板主线程假死→已重启面板，本段跳过' };
      }
      return { ok: false, why: `落点命中桌面层 ${cls}（show desktop 态残留或面板未在屏）` };
    }
    if (cls === 'Ghost') {
      cancelDragGhost(); // 拖拽幽灵：最小化无效，撤会话再来一轮
      const gpid = win32.threadIdOf(root).pid;
      console.log(`[battery] Ghost 幽灵 pid=${gpid} rect=${JSON.stringify(win32.rectOf(root))} 面板=${panelLiveness(hwnd)}｜主人：${ghostIdentity(gpid)}`);
      if (!ghostDumped) {
        // 第一次见幽灵就把全场窗景拍下来（下一轮即可定位是谁开起的拖拽会话）
        ghostDumped = true;
        try {
          const dump = win32.topLevelWindows().map((h) => {
            let c = '?', p = 0, r = null;
            try { c = win32.className(h); p = win32.threadIdOf(h).pid; r = win32.rectOf(h); } catch { /* 已销毁 */ }
            return `${c}#${p}@${r ? `${r.left},${r.top} ${r.right - r.left}x${r.bottom - r.top}` : '?'}`;
          });
          console.log(`[battery] 首个 OLE 幽灵：pid=${win32.threadIdOf(root).pid}；顶层窗景（${dump.length}）：${dump.join(' | ')}`);
        } catch { /* 尽力 */ }
      }
    }
    if (!minimizedForRestore.includes(root)) minimizedForRestore.push(root);
    win32.ShowWindow(root, SW_MINIMIZE);
    await sleep(700);
  }
  const cls = win32.className(Number(win32.windowFromPointRoot(pt)));
  const stuck = Number(win32.windowFromPointRoot(pt));
  // 报清楚是谁家的窗挡着：Ghost 是 OLE 拖拽幽灵（谁开起来的拖拽会话），
  // 最小化对它无效，只有 ESC/抬键能撤——不指认主人就永远说不清谁在拖。
  let who = `${cls}`;
  try {
    const pid = win32.threadIdOf(stuck).pid;
    who = `${cls}（pid=${pid} ${win32.exeNameOfWindow(stuck) || win32.exeOfPid(pid) || '?'}｜${ghostIdentity(pid)}）`;
  } catch { /* 窗已销毁：类名够用 */ }
  const live = panelLiveness(hwnd);
  if (live.startsWith('主线程假死')) {
    const healed = healHungPanel ? await healHungPanel() : false;
    if (healed) return { ok: false, why: '面板主线程假死→已重启面板，本段跳过' };
  }
  return { ok: false, why: `清场重试后仍被 ${who} 遮挡；面板${live}` };
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

/** 临点现取矩形（工单59 真机首跑教训）：文档区名序随后台使用频次落定会重排
 * （工单05，~1s 内动），一次 settle 抓的快照隔几秒再点就点空。落点一律现取。 */
function liveItemRect(name) {
  const last = readEvents().filter((e) => e.type === 'desktop-rendered').pop();
  return ((last && last.rects) || []).find((r) => r.name === name && r.rect) || null;
}
/** 文档区顶排条目矩形（分区空白落点要用它上面的容器空白）：同上，临点现取 */
function liveTopDocRect() {
  const last = readEvents().filter((e) => e.type === 'desktop-rendered').pop();
  return ((last && last.rects) || []).filter((r) => r.zone === 'doc' && r.rect)
    .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)[0] || null;
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
      // 工单49 起面板进程有了第二个 Chrome 窗（DECK-TASKBAR 条带）：按标题甄别面板本体
      (h) => win32.threadIdOf(h).pid === pid && win32.className(h) === 'Chrome_WidgetWin_1'
        && windowTitle(h) === 'AGENT DECK');
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
// 安静即稳定。06 起使用分数异步就位会让首拍名序在 ~1s 后重排为频次序，
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

// —— 工单113 preflight 探测：四类污染源的原始行产出（分类在 panel-control.classifyPreflight，
// 注入式纯函数可单测）。全屏判定 = 矩形覆盖虚拟屏 ≥95% 且可见、未 cloaked、非壳层白名单；
// cloaked 滤除壳宿主常驻「全屏」窗（Start/搜索宿主等）的常态误报源。
const PREFLIGHT_SHELL_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'SHELLDLL_DefView', 'SysListView32']);
const PREFLIGHT_OWN_TITLES = new Set(['AGENT DECK', 'AGENT DECK ACCEPT HINT', 'DECK-TASKBAR']);
function preflightProbes() {
  const vs = win32.virtualScreen();
  const screenArea = Math.max(1, vs.w * vs.h);
  const rows = [];
  for (const h of win32.topLevelWindows()) {
    try {
      const pid = win32.threadIdOf(h).pid;
      rows.push({
        cls: win32.className(h), title: windowTitle(h), pid, selfPid: process.pid,
        rect: win32.rectOf(h), visible: !!win32.IsWindowVisible(h), cloaked: win32.isCloaked(h),
        exeQueryable: win32.exeOfPid(pid) !== '',
      });
    } catch { /* 已销毁：跳过 */ }
  }
  const vis = rows.filter((r) => r.visible);
  const fullscreenForeign = vis.filter((r) => !PREFLIGHT_SHELL_CLASSES.has(r.cls)
    && r.cls !== 'Ghost' && !PREFLIGHT_OWN_TITLES.has(r.title)
    && r.rect && (r.rect.right - r.rect.left) * (r.rect.bottom - r.rect.top) >= screenArea * 0.95
    && !r.cloaked);
  return {
    panelWindows: findPanelWindows(vis).map((p) => ({ ...p, exeQueryable: (rows.find((r) => r.pid === p.pid) || {}).exeQueryable })),
    ghostWindows: vis.filter((r) => r.cls === 'Ghost'),
    fullscreenForeign,
  };
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
  // 工单110：--accept-scope 显式声明本次验收的 spec 范围段（如 npm run accept -- --accept-scope P6,P8）。
  // 段号进 verdict 行与报告账目；段级清单（注册表）落地前，未知段号告警不阻断（硬交叉校验归 #115）。
  const acceptScope = parseAcceptScope(process.argv);
  const rep = new Report('03-battery', { scope: acceptScope });
  if (acceptScope.length) rep.note(`spec 范围段声明：${acceptScope.join(', ')}（段注册表未填充前，未注册段号告警不阻断）`);
  const w32 = win32;
  // —— 工单113 preflight 环境体检：四类已知污染源探测，警示入账不拒跑——本机覆盖层
  // 是常态在场，拒跑会把验收永久卡死。FAIL-ENV 的环境定责从报告第一行起就有证据链。
  // 体检自身异常也只入账不中断（探测是增益，不是电池的前置条件）。
  try {
    const entries = classifyPreflight(preflightProbes());
    if (entries.length === 0) rep.note('preflight 环境体检：四类污染源均不在场');
    else for (const e of entries) rep.note(`preflight 环境体检［${e.kind}］${e.detail}`);
  } catch (e) { rep.note(`preflight 环境体检异常（不拒跑）: ${e && e.message}`); }
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
  // 原生任务栏显隐基线（工单50）：清场核验用——电池不得改变用户电池前状态
  // （判据共用 accept/lib/win32.js 导出，四电池单点维护）
  const nativeTaskbarBase = w32.nativeTaskbarVisible();
  rep.note(`原生任务栏基线：visible=${nativeTaskbarBase}`);

  // 工单50：本电池多段断言依赖原生任务栏在场（P8/P10 托盘识别色扫描 Shell_TrayWnd
  // 矩形；clearDesktop 同区点击），而任务栏插件默认开启会隐藏原生任务栏——主电池
  // 全程以 taskbar.enabled=false 运行（任务栏显隐有 49/50 专电池），清场还原原文。
  const CONFIG_FILE_MAIN = path.join(APP_ROOT, 'config.json');
  const configBackupMain = fs.existsSync(CONFIG_FILE_MAIN) ? fs.readFileSync(CONFIG_FILE_MAIN, 'utf8') : null;
  {
    const cfg = configBackupMain ? JSON.parse(configBackupMain) : {};
    cfg.taskbar = { ...(cfg.taskbar ?? {}), enabled: false };
    fs.writeFileSync(CONFIG_FILE_MAIN, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    rep.note('已临时置 taskbar.enabled=false（主电池依赖原生任务栏在场，清场还原）');
  }

  const savedCursor = w32.cursor();
  const safePt = { x: 40 * f, y: si.phys.h - 40 };
  await clearDesktop([safePt], f);
  w32.moveMousePhys(safePt.x, safePt.y);

  let child = null;
  let panelPid = null;
  let notepad = null;
  let stderrTail = '';
  let searchProbeDir = null; // P7S 探针目录（记事本标签占着句柄，末尾关窗后再删）
  let deckProbeFiles = []; // 桌面探针兜底清场名单（各段自清，这里兜异常提前收场）

  // —— 摆位存储：备份即可，不预置。工单59 手钉与 dock 随面板退役，桌面只编排文档区；
  // 电池拖拽会改写 layout.json，清场时把用户现场原样还原（不预置＝不种用户看不到的手钉）。
  const userDataDir = app.getPath('userData');
  const layoutFile = path.join(userDataDir, 'layout.json');
  const layoutBackup = fs.existsSync(layoutFile) ? fs.readFileSync(layoutFile, 'utf8') : null;
  const seedScan = psDesktopScan();
  fs.mkdirSync(userDataDir, { recursive: true });

  const launchPanel = () => spawn(process.execPath, ['.'], {
    cwd: APP_ROOT,
    env: { ...process.env, DECK_EVENT_LOG: EVENTS_FILE },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // 工单112：强退序列换面板控制模块（seam②）——优雅终止 → 整树强杀 → 有界等待并
  // **验证进程确实消失**。现状缺的正是验证这一环：taskkill /F 后不确认消失就放行重启，
  // 停摆面板存活 → 新面板被单实例守卫拒收 → 缓存互锁/托盘竞争成片失真。验证消失后
  // 放行重启，验证失败就不让污染继续（决策→后果的接线在调用方：heal 中止后续段，清场入账）。
  const panelControl = createPanelControl();
  const stopPanel = async () => {
    if (!child && !panelPid) return { gone: true, graceful: true, forced: false, pidsLeft: [], outcome: 'idle' };
    const res = await panelControl.stop({ pids: [child && child.pid, panelPid].filter(Boolean), child });
    child = null;
    panelPid = null;
    return res;
  };
  try {
    // —— P1 启动面板（子进程，存证事件落盘）——
    rep.beginSegment('P1');
    child = launchPanel();
    child.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-4000); });
    let hwnd = await waitPanelWindow(20000);
    if (!hwnd) throw new Error(`20s 内未见面板窗口\nstderr:\n${stderrTail}`);
    panelPid = win32.threadIdOf(hwnd).pid;
    // 假死自愈接线（钩子在 ensurePanelHit 里按需回调）：先取证再重启，交还新 hwnd。
    // hwnd/child/panelPid 都是本函数词法变量，闭包内赋值对后续段可见。
    healHungPanel = async () => {
      const dump = hungForensics(hwnd);
      if (dump) console.log(`[battery] 面板假死取证：\n${dump}`);
      // 工单110 三态记账：停摆是环境事件——检出即开排除窗，停摆事件记环境降责排除而非
      // 失败。窗自此刻开至面板重启验证健康（onPanelHealthy 在 ensurePanelHit 落点命中时
      // 闭合），其间失败断言自动入排除账；重启失败（下方 !nh）也落在窗内，随窗不闭合
      // 连带其后「无面板可用」的失败全数环境降责——环境噪声不再污染 verdict。
      rep.beginEnvWindow('面板主线程假死（WM_NULL 超时）——重启验证健康前断言不可信', 'panel-stall');
      rep.exclude('面板主线程假死（WM_NULL 超时）：已重启面板继续跑，停摆检出至重启健康验证之间的失败断言记环境降责', '面板主线程假死（WM_NULL 超时）', 'panel-stall');
      const stopped = await stopPanel();
      if (!stopped.gone) {
        // 工单112：强退后仍存活 = 需重启清障——入环境降责账并**中止后续段**（借主
        // try/catch 汇流：异常落在停摆排除窗内自动环境降责，轮末 verdict=FAIL-ENV）。
        // 被污染的轮次（双面板并存）不再产出误导性 verdict。
        rep.exclude(`面板强退失败：强杀后有界等待内仍存活（pid=${stopped.pidsLeft.join(', ')}）——需重启清障，后续段中止`, '面板强退序列未能终结面板进程（#107 遗留进程形态）', 'panel-forcekill');
        const err = new Error('面板强退失败：需重启清障——后续段中止');
        err.clearanceRequired = true;
        throw err;
      }
      child = launchPanel();
      child.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-4000); });
      const nh = await waitPanelWindow(20000, Date.now() - 1500); // sinceMs 必给：事件文件里还留着上一实例的 boot
      if (!nh) { rep.fail('假死自愈：重启后面板窗口未现，后续段无面板可用'); return false; }
      hwnd = nh;
      panelPid = win32.threadIdOf(nh).pid;
      return true;
    };
    // 工单110：重启健康验证闭合钩子——heal 后首次「落点命中面板」即证明新面板可服务，
    // 闭合排除窗；其后的失败断言恢复照常记失败。
    onPanelHealthy = () => rep.endEnvWindow('面板重启后首次落点命中（健康验证通过）');
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
    // 实拍尽力而为（capture 是同步实拍，PS 停摆等环境抖动会 ETIMEDOUT）：降级为 NOTE，
    // 不让观感存证失败拖垮语义断言（工单23 起 21/22/23 段实拍统一走这里）。
    const safeShot = (name, rect) => {
      try { (rect ? capture(rect, name) : fullShot(name)); } catch (err) {
        rep.note(`${name} 实拍失败（不阻塞语义断言）：${err && err.message}`);
      }
    };

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
    rep.beginSegment('P2');
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
        // 工单86：控制器进程自验收提示条起常驻一个 Chrome 窗（同 pid 同类名且 alwaysOnTop
        // 恒居枚举首位）——按 pid+类名找本参照窗会误中提示条（HWND_BOTTOM 落空、真参照窗
        // 盖满面板、透明断言全灭），必须加标题甄别（checker.html 立标题 CHECKER-BACKDROP）。
        const h = w32.topLevelWindows().find(
          (hh) => w32.threadIdOf(hh).pid === process.pid && w32.className(hh) === 'Chrome_WidgetWin_1'
            && windowTitle(hh) === 'CHECKER-BACKDROP');
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
    // （05 起文档区至 x616——否则卡片/条目底色拉低命中率）
    const leftColRight = Math.round((LEFT_CARDS_DIP.x + LEFT_CARDS_DIP.w) * f) + Math.round(8 * f)
    const rightColLeft = panelW - Math.round((RIGHT_CARDS_DIP.right + RIGHT_CARDS_DIP.w) * f) - Math.round(8 * f)
    const transparentZone = {
      left: Math.max(Math.round(DOC_ZONE_RIGHT_DIP * f) + Math.round(8 * f), leftColRight),
      top: 8, right: Math.max(rightColLeft, leftColRight + Math.round(200 * f)),
      bottom: workBottom,
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

    // —— P2.5 工单04 数据卡片：四类卡片经桥接契约上线并实时刷新（工单59 后剩三类：
    //     时钟/天气/会话——硬件卡退役，硬件读数改由任务栏右组摘要承载，另有 accept:taskbar 电池盯）——
    rep.beginSegment('P2.5');
    {
      const sess2 = await waitEvent('sessions-rendered', (e) => e.n >= 2, 8000);
      const sessionsEvt = sess2 || (await waitEvent('sessions-rendered', null, 2000));
      sessionsEvt
        ? rep.pass(`会话列表卡：渲染层收到内核会话数据并持续走数（第 ${sessionsEvt.n} 次渲染，count=${sessionsEvt.count}，真机活跃池）`)
        : rep.fail('会话列表卡：未收到 sessions-rendered 存证');
      // 工单59 退役回归：硬件卡已删，面板不再发 hardware-rendered / history-live
      const hwGone = !readEvents().some((e) => e.type === 'hardware-rendered' || e.type === 'history-live');
      hwGone
        ? rep.pass('硬件卡已退役：面板全程未发 hardware-rendered/history-live（读数改由任务栏摘要承载）')
        : rep.fail('硬件卡退役不彻底：面板仍在发 hardware-rendered/history-live 存证');
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
      rep.note('卡片实拍存证：04-cards-left.png（时钟/天气/日历）、04-cards-right.png（搜索/会话）');
    }


    // —— P3 默认穿透：左键/右键直达桌面 ——
    rep.beginSegment('P3');
    const ex = w32.GetWindowLongW(hwnd, w32.GWL_EXSTYLE);
    rep.log(`穿透态 EXSTYLE=0x${(ex >>> 0).toString(16)}`);
    (ex & w32.WS_EX_TRANSPARENT) && (ex & w32.WS_EX_LAYERED)
      ? rep.pass('默认穿透：窗口样式含 WS_EX_TRANSPARENT|WS_EX_LAYERED')
      : rep.fail('默认穿透：窗口样式缺少预期位');
    // 空落点运行时安全取点（工单89）：分区热区改为「容器矩形外扩 24px」后随桌面内容
    // 长宽，硬编码空点会被热区吞进去（原 (700,300) 在文档区条目变宽后落进外扩带，断言
    // 翻转）。改为读最近一拍常规态 hotzones 矩形（已含外扩），在面板窗内部扫一个与全部
    // 热区沿保持净距的探针点：网格步进 16px、取距「文档区右侧历史空带」锚点最近者（确定序）。
    const hzRects = (lastEvent('hotzones') || { rects: [] }).rects || [];
    const emptyDip = (() => {
      if (!hzRects.length) return null;
      const winDip = { w: (rect.right - rect.left) / f, h: (rect.bottom - rect.top) / f };
      const CLEAR = 12; // 探针与任一热区沿的最小净距（DIP）
      const anchor = { x: winDip.w * 0.72, y: 300 };
      const clearOf = (x, y) => hzRects.every((r) =>
        x < r.x - CLEAR || x >= r.x + r.w + CLEAR || y < r.y - CLEAR || y >= r.y + r.h + CLEAR);
      let best = null;
      for (let y = 120; y <= winDip.h - 160; y += 16) {
        for (let x = 16; x <= winDip.w - 16; x += 16) {
          if (!clearOf(x, y)) continue;
          const d = Math.hypot(x - anchor.x, y - anchor.y);
          if (!best || d < best.d) best = { x, y, d };
        }
      }
      return best;
    })();
    if (!hzRects.length) {
      rep.fail('P3 前置缺失：hotzones 存证未见（穿透探针无据可取）');
    } else if (!emptyDip) {
      rep.fail('P3 前置缺失：面板窗内扫不到全部热区外的空点（hotzones 覆盖异常）');
    } else {
      rep.note(`P3 穿透探针点 DIP(${emptyDip.x},${emptyDip.y})——与全部热区沿净距 ≥12px`);
      const emptyPhys = { x: rect.left + Math.round(emptyDip.x * f), y: rect.top + Math.round(emptyDip.y * f) };
      w32.clickPhys(emptyPhys.x, emptyPhys.y, 'left');
      await sleep(500);
      const fg = w32.GetForegroundWindow();
      const fgCls = w32.className(fg);
      ['Progman', 'WorkerW', 'SHELLDLL_DefView', 'SysListView32'].includes(fgCls)
        ? rep.pass(`默认穿透：面板空区点击直达桌面（前台翻转为 ${fgCls}）`)
        : rep.fail(`面板空区点击未直达桌面：前台=0x${fg.toString(16)}(${fgCls})`);
      w32.clickPhys(emptyPhys.x, emptyPhys.y, 'right');
      await sleep(500);
      const fgR = w32.GetForegroundWindow();
      const fgRCls = w32.className(fgR);
      // Win11 桌面右键菜单宿主为 XamlExplorerHostIslandWindow（WASDK）——菜单弹出即右键直达桌面
      fgRCls === 'Progman' || fgRCls === 'WorkerW' || fgRCls.startsWith('XamlExplorerHost')
        ? rep.pass(`默认穿透：右键同样直达桌面（桌面右键菜单弹出，前台 ${fgRCls}）`)
        : rep.fail(`右键未直达桌面：前台=0x${fgR.toString(16)}(${fgRCls})`);
    }
    w32.tapKeys([0x1b]); // ESC 收起桌面右键菜单（若有）
    await sleep(300);

    // —— P4 热区接收 + 交互后重钉 ——
    rep.beginSegment('P4');
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
    rep.beginSegment('P5');
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
      rep.note('面板承载实拍：05-icons-hidden.png（原生图标隐藏 + 文档区自绘）');

      // 单击选中态（文档区首个可视条目）。矩形取静置后的最新一拍：使用频次异步就位
      // 会在 boot 后 ~1s 内重排文档区，首拍矩形会指向换位后的别的条目。
      const stableSel = await waitStable('desktop-rendered', 1500, 8000);
      const docRect = stableSel && (stableSel.rects || []).filter((r) => r.zone === 'doc' && r.rect)[0];
      if (!docRect) {
        rep.fail('desktop-rendered 未带文档区条目矩形（选中态不可测）');
      } else {
        const cx = rect.left + Math.round((docRect.rect.x + docRect.rect.w / 2) * f);
        const cy = rect.top + Math.round((docRect.rect.y + docRect.rect.h / 2) * f);
        const hitSel = await ensurePanelHit({ x: cx, y: cy }, hwnd);
        if (!hitSel.ok) {
          rep.fail(`单击选中前置失败：${hitSel.why}`);
        } else {
          w32.clickPhys(cx, cy, 'left');
          const sel = await waitEvent('desktop-selected', (e) => e.name === docRect.name, 4000);
          sel
            ? rep.pass(`单击选中态：文档区条目「${docRect.name}」选中并上报存证`)
            : rep.fail('单击未见 desktop-selected 存证');
        }
        capture({
          left: rect.left + Math.round((docRect.rect.x - 70) * f), top: rect.top + Math.round((docRect.rect.y - 40) * f),
          right: rect.left + Math.round((docRect.rect.x + docRect.rect.w + 70) * f), bottom: rect.top + Math.round((docRect.rect.y + docRect.rect.h + 50) * f),
        }, '05-doc-selected');
        w32.moveMousePhys(safePt.x, safePt.y);
        await sleep(300);
      }

      // 双击验收探针 bat：造唯一名 → 入池 → 静置矩形 → 遮挡校验 → 双击启动 → 标记实证 → 清理。
      // 工单59 起探针从 lnk 换 bat：lnk 归应用区、随 dock 退役不再有可视矩形，bat 落文档区。
      // 工单11 两处修：矩形改取 waitStable 静置拍（首拍后频次分数异步重排会换位，
      // 首拍矩形点在换位后的空档上）；交互前 ensurePanelHit（真机实证：用户窗口抬起
      // 盖住文档区时 SendInput 整段被偷走，探针以「无存证」假死）。
      const probeName = `DECK-PROBE-${Date.now()}.bat`;
      const lnkPath = path.join(scan.user, probeName);
      const markerPath = path.join(__dirname, 'evidence', `05-marker-${Date.now()}.txt`);
      try {
        createProbeBat(lnkPath, markerPath);
        const shown = await waitEvent('desktop-rendered', (e) => (e.names || []).includes(probeName), 8000);
        shown
          ? rep.pass(`新建探针 bat 入池：${probeName}（1Hz 重扫描自动出现，other 组落文档区）`)
          : rep.fail('新建探针 bat 未入池（desktop-rendered 未见）');
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
              ? rep.pass('双击启动：探针 bat 经桥接 desktop/launch 启动（ok=true）')
              : rep.fail(`双击启动存证异常：${JSON.stringify(launched)}`);
            let markerOk = false;
            const markerDeadline = Date.now() + 20000;
            while (Date.now() < markerDeadline && !markerOk) {
              try { markerOk = fs.readFileSync(markerPath, 'utf8').trim() === 'ok'; } catch { markerOk = false; }
              if (!markerOk) await sleep(250);
            }
            markerOk
              ? rep.pass('双击验收探针 bat 启动成功（目标进程写标记文件实证）')
              : rep.fail('探针 bat 目标 10s 内未写标记文件（启动未实证）');
          }
        } else {
          rep.fail('探针 bat 条目无矩形（无法双击）');
        }
      } finally {
        try { fs.unlinkSync(lnkPath); } catch { /* 尽力清理 */ }
      }
      const gone = await waitEvent('desktop-rendered', (e) => !(e.names || []).includes(probeName), 6000);
      gone
        ? rep.pass('清理探针 bat 后条目同步消失（面板与磁盘一致）')
        : rep.fail('清理探针 bat 后条目未消失');
      try { fs.unlinkSync(markerPath); } catch { /* 尽力清理 */ }

      // —— P5-ICON 工单01 快捷方式真实图标：不同快捷方式的图标 dataUrl 互不相等（spec 防回归线）——
      // 根因（.scratch/icon-probe 实证）：本机 Electron getFileIcon 对一切 .lnk 返回字节级相同的
      // 通用图标，对目标本体直取正常。修法在适配层提取链：lnk 先解析图标源再对本体提取。
      // 夹具法不依赖用户桌面内容：现场造两条指向不同真 exe（notepad/charmap）的 lnk，
      // 等面板扫描指纹翻转（desktop-rendered 只在变化时发，带入夹具名即翻转）后，
      // 经控制器内桥接取 desktop/icon 断言互不相等；结束删夹具，等条目同步消失。
      rep.beginSegment('P5-ICON');
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
      rep.beginSegment('P5-ICON2');
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
      // 基线感知：用户自身偏好隐藏（基线 visible=false 且 HideIcons=1）时，守卫按设计
      // 全程不动（icon-carry 评审收编：绝不顶掉用户偏好）——此时断言不动作语义：
      // icons-restored 存证在场 + prefHiddenAfter 未被顶掉（视图保持隐藏 = 正确行为）。
      // 基线可见时才断言实际恢复（图标翻回）。
      const userPrefHidden = !iconsVisibleBase && carryRestored && carryRestored.prefHiddenAfter === true;
      restoredVis && carryRestored
        ? rep.pass(`杀进程自动还原：面板被 taskkill /F 后原生图标恢复（reason=${carryRestored.reason}，守卫还原后退出=${supervisorDead}）`)
        : userPrefHidden && carryRestored
          ? rep.pass(`杀进程还原（用户偏好隐藏基线）：守卫按设计不动用户偏好——icons-restored 存证在（reason=${carryRestored.reason}），HideIcons 偏好未被顶掉，视图保持隐藏`)
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

    // —— P5.5 工单06 编排与摆位：按组归类 / 拖拽摆位即时重编排 + 落盘持久化 / 恢复出厂 ——
    // 工单59：应用区（dock）随任务栏接管退役，桌面只剩文档区一处承载。手钉/推荐位断言
    // 整段删除（手钉改由任务栏左组承担），改为文档区内的显式摆位序断言。
    rep.beginSegment('P5.5');
    {
      const rendered0 = await waitEvent('desktop-rendered', null, 8000);
      // office 组内序：编排的身份就是这条序（拖拽/持久化/出厂三段都按它复算）
      const officeOrder = (e) => ((e && e.docEntries) || []).filter((d) => d.group === 'office').map((d) => d.name);
      const docShot = (name, r) => capture({
        left: r.left + Math.round(400 * f), top: r.top,
        right: r.left + Math.round((DOC_ZONE_RIGHT_DIP + 4) * f), bottom: r.top + Math.round(780 * f),
      }, name);

      // a. 编排只承载文档区：存证带 docEntries、dock 段随退役消失（回归线）
      if (rendered0 && Array.isArray(rendered0.docEntries) && rendered0.dock === undefined) {
        rep.pass(`面板只编排文档区：desktop-rendered 带 docEntries（${rendered0.docEntries.length} 项）、无 dock 段（工单59 退役）`);
      } else {
        rep.fail(`desktop-rendered 编排段结构不符：${JSON.stringify({ doc: rendered0 && rendered0.docEntries && rendered0.docEntries.length, dock: rendered0 && rendered0.dock })}`);
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
      // 清场存证按时间下限取：历史 desktop-rendered 天然不含探针名，不设下界会立刻
      // 命中创建前的旧拍——电池以为删除已同步、实则下一拍重建仍在路上（本轮实证：
      // 在飞拖拽被这次迟到重建掐断）。P5-ICON 清场同法。
      const tDocGone = Date.now();
      const goneDocs = await waitEvent('desktop-rendered', (e) => e.t >= tDocGone && !(e.names || []).includes(probeDocx) && !(e.names || []).includes(probePdf), 6000);
      goneDocs
        ? rep.pass('删除探针文档后条目同步消失（面板与磁盘一致）')
        : rep.fail('删除探针文档后条目未消失');

      // c. 拖拽摆位：真鼠标（SendInput 按下-移动-抬起）驱动渲染层指针拖拽 → desktop/move 落盘。
      // 夹具是两条同组（office）docx 探针：编排按组分列，跨组的「谁在谁之前」没有确定含义，
      // 同组探针是唯一能让相对序断言成立的组合。mtime 显式拉开，出厂序即 [A, B, ...]。
      const tDrag = Date.now();
      const dragA = `DECK06-DRAG-${tDrag}-A.docx`;
      const dragB = `DECK06-DRAG-${tDrag}-B.docx`;
      const dragPaths = [path.join(seedScan.user, dragA), path.join(seedScan.user, dragB)];
      deckProbeFiles.push(...dragPaths);
      let orderBefore = null;   // 出厂序（d 段恢复出厂的期望值）
      let rectN = w32.rectOf(hwnd); // 复位段要用；拖拽前置失败时即当前面板矩形
      const dragged = dragB;    // 拖末位
      {
        const mA = new Date(Date.now() - 1000), mB = new Date(Date.now() - 2000);
        fs.writeFileSync(dragPaths[0], 'probe');
        fs.writeFileSync(dragPaths[1], 'probe');
        fs.utimesSync(dragPaths[0], mA, mA); // A 新于 B → 出厂序 [A, B, ...]
        fs.utimesSync(dragPaths[1], mB, mB);
        const joinedDrag = await waitEvent('desktop-rendered',
          (e) => officeOrder(e).includes(dragA) && officeOrder(e).includes(dragB), 8000);
        // 源/参照矩形取安静后的最新一拍（拖拽中途编排序再变会错位）
        const dragEvt = await waitStable('desktop-rendered', 1500, 8000);
        orderBefore = officeOrder(dragEvt);
        const rectByName = (name) => {
          const r = ((dragEvt && dragEvt.rects) || []).find((x) => x.name === name && x.rect);
          return r && r.rect;
        };
        const anchor = orderBefore[0];         // 落到首位条目之前
        const rd = rectByName(dragged);
        const ra = rectByName(anchor);
        if (!joinedDrag || orderBefore.length < 2 || !rd || !ra) {
          rep.fail(`拖拽摆位前置缺失：入池=${!!joinedDrag} office=${orderBefore.length} 源矩形=${!!rd} 参照矩形=${!!ra}`);
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
            const ord = officeOrder(e);
            return e.t >= tReordered - 2500 && ord.includes(dragged) && ord.includes(anchor) && ord.indexOf(dragged) < ord.indexOf(anchor);
          }, 6000);
          if (!hitDrag.ok) {
            rep.note('拖拽未执行（前置遮挡失败），排序/持久化连锁断言跳过');
          } else {
            reordered
              ? rep.pass('摆位即时重编排：拖拽条目越过参照（渲染序更新）')
              : rep.fail('拖拽后编排序未更新');
          }
          docShot('06-drag-moved', rect);

          // 重启面板：摆位持久化（layout.json）。拖拽未执行时跳过（重启只为验证持久化）。
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
            const ord = officeOrder(e);
            return e.t >= rt0 && ord.includes(dragged) && ord.includes(anchor) && ord.indexOf(dragged) < ord.indexOf(anchor);
          }, 8000);
          persisted
            ? rep.pass(`重启面板后位置保持：${dragged} 仍在 ${anchor} 之前（layout.json 持久化）`)
            : rep.fail('重启后摆位未保持（layout.json 未生效）');
          docShot('06-drag-persisted', rectN);
          } else {
            rep.note('重启面板持久化断言随拖拽前置失败一并跳过');
          }

          // d. 恢复出厂布局：设置浮层（工单08 迁入）内的 RESET LAYOUT 一键回出厂编排（清文档区显式摆位）。
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
            const factoryEvt = orderBefore && await waitEvent('desktop-rendered', (e) => {
              const ord = officeOrder(e);
              return e.t >= tReset && orderBefore.every((n) => ord.includes(n))
                && ord.indexOf(dragged) > ord.indexOf(anchor);
            }, 6000);
            factoryEvt
              ? rep.pass(`设置浮层恢复出厂一键生效：清除 ${reset.reset.cleared} 处显式摆位，文档区回到出厂归类序（${orderBefore.slice(0, 2).join(', ')} 归位）`)
              : rep.fail(`恢复出厂未达成（reset=${JSON.stringify(reset.reset)}，出厂序=${JSON.stringify(orderBefore && orderBefore.slice(0, 2))}）`);
            docShot('06-factory-reset', rectN);
            // 收层退场：ESC 关浮层（08 段对 esc/blur 有专门断言，这里只求干净退场）
            const tClose = Date.now();
            w32.tapKeys([VK_ESCAPE]);
            const closed = await waitEvent('settings-closed', (e) => e.t >= tClose && e.reason === 'esc', 2500);
            closed || rep.note('复位后 ESC 收层存证未到（不阻塞；08 段有专门断言）');
          }
        }
      }
      for (const p of dragPaths) { try { fs.unlinkSync(p); } catch { /* 尽力清理 */ } }
      const tDragGone = Date.now();
      const dragGone = await waitEvent('desktop-rendered',
        (e) => e.t >= tDragGone && !(e.names || []).includes(dragA) && !(e.names || []).includes(dragB), 6000);
      dragGone
        ? rep.pass('清理拖拽探针后条目同步消失（面板与磁盘一致）')
        : rep.note('拖拽探针清理存证未到（不阻塞；探针已尽力删除）');
    }

    // —— P5.6 工单20 选区：单击重置 / Ctrl 点选并集与切换（工单59 后只有文档区一处承载，
    //     原「跨区并集」改为区内两条并集）/ 空白清空 / 快照重建不丢 /
    // 外删自动剔除 / 双击全开。语义矩阵穷举在离线测试（tests/renderer/selection.spec.ts），
    // 这里每类语义只留一条真机端到端代表用例（#19 spec 三缝约定）。
    rep.beginSegment('P5.6');
    await (async () => {
      const rectS = w32.rectOf(hwnd); // P5.5 可能重启过面板，取现役矩形
      const ptOf = (r) => ({ x: rectS.left + Math.round((r.x + r.w / 2) * f), y: rectS.top + Math.round((r.y + r.h / 2) * f) });
      // 有序名单比较（names 断言统一走这里；join 比较即序敏感）
      const sameNames = (a, b) => (a || []).join() === b.join();
      const hitAndClick = async (pt, label) => {
        const hit = await ensurePanelHit(pt, hwnd);
        if (!hit.ok) { rep.fail(`${label}前置失败：${hit.why}`); return false; }
        w32.clickPhys(pt.x, pt.y, 'left');
        return true;
      };
      const ctrlClick = async (pt, label) => {
        const hit = await ensurePanelHit(pt, hwnd);
        if (!hit.ok) { rep.fail(`${label}前置失败：${hit.why}`); return false; }
        w32.send([w32.keyInput(VK_CONTROL, w32.KEYDOWN)]);
        await sleep(60);
        w32.clickPhys(pt.x, pt.y, 'left');
        await sleep(60);
        w32.send([w32.keyInput(VK_CONTROL, w32.KEYUP)]);
        return true;
      };

      // a. 夹具：两条文档区探针（docx）保证并集用例不依赖用户桌面的既有文档项
      const t20 = Date.now();
      const selDoc = `DECK20-A-${t20}.docx`;
      const selDoc2 = `DECK20-B-${t20}.docx`;
      const selDocPath = path.join(seedScan.user, selDoc);
      const selDoc2Path = path.join(seedScan.user, selDoc2);
      deckProbeFiles.push(selDocPath, selDoc2Path);
      fs.writeFileSync(selDocPath, 'probe');
      fs.writeFileSync(selDoc2Path, 'probe');
      const joined = await waitEvent('desktop-rendered',
        (e) => (e.names || []).includes(selDoc) && (e.names || []).includes(selDoc2), 8000);
      joined || rep.fail(`选区文档探针未入池（${selDoc} / ${selDoc2}）`);

      // b. 单击重置 + Ctrl 点选并集 + 再点切换出选
      const settled20 = await waitStable('desktop-rendered', 1500, 8000);
      const docR = settled20 && (settled20.rects || []).find((r) => r.name === selDoc && r.rect);
      const docR2 = settled20 && (settled20.rects || []).find((r) => r.name === selDoc2 && r.rect);
      // 文档区顶排条目：分区空白清空的落点原语（20c 同法）
      const topDoc = settled20 && (settled20.rects || []).filter((r) => r.zone === 'doc' && r.rect)
        .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)[0];
      if (!docR || !docR2 || !topDoc) {
        rep.fail(`选区用例矩形缺失：A=${JSON.stringify(docR && docR.rect)} B=${JSON.stringify(docR2 && docR2.rect)} 顶排=${!!topDoc}`);
      } else {
        // 逐击取最新矩形：文档区名序随后台使用频次落定会重排（工单05，~1s 内动），
        // 一次 settle 抓的矩形隔几秒再点就点空——「Ctrl 切换出选存证异常」的根因。
        const liveRect20 = (name) => {
          const last = readEvents().filter((e) => e.type === 'desktop-rendered' && e.t >= t20).pop();
          return ((last && last.rects) || []).find((r) => r.name === name && r.rect) || null;
        };
        const ctrlClickItem20 = async (name, label) => {
          const r = liveRect20(name);
          if (!r) { rep.fail(`${label}取矩形失败（${name} 不在最新渲染里）`); return false; }
          return ctrlClick(ptOf(r.rect), label);
        };
        const tSel = Date.now();
        const rSel = liveItemRect(selDoc); // 落点现取：同 liveRect20，名序随后台频次重排
        if (!rSel) rep.fail(`选区-单击取矩形失败（${selDoc} 不在最新渲染里）`);
        const okA = rSel && await hitAndClick(ptOf(rSel.rect), '选区-单击');
        const selected = okA && await waitEvent('desktop-selected', (e) => e.t >= tSel && e.name === selDoc && sameNames(e.names, [selDoc]), 4000);
        selected
          ? rep.pass(`单击重置选区：文档区条目「${selDoc}」单选存证`)
          : rep.fail('单击重置未见 desktop-selected（单条 names）');

        const tX = Date.now();
        const okX = await ctrlClickItem20(selDoc2, '选区-Ctrl 补选');
        const union = okX && await waitEvent('desktop-selection-toggled', (e) => e.t >= tX && e.selected === true && sameNames(e.names, [selDoc, selDoc2]), 4000);
        union
          ? rep.pass(`Ctrl 点选并集：文档区「${selDoc}」+「${selDoc2}」同选`)
          : rep.fail(`Ctrl 并集存证异常：${JSON.stringify(union)}`);
        capture({ left: rectS.left, top: rectS.top + Math.round((docR.rect.y - 60) * f), right: rectS.left + Math.round(1100 * f), bottom: rectS.bottom }, '20-selection-union');

        await sleep(600); // 隔开同位置双击窗口，确保下一击 detail 重新计 1（切换出选要真到达渲染层）
        const tOff = Date.now();
        const okOff = await ctrlClickItem20(selDoc2, '选区-Ctrl 再点');
        const off = okOff && await waitEvent('desktop-selection-toggled', (e) => e.t >= tOff && e.selected === false && sameNames(e.names, [selDoc]), 4000);
        off
          ? rep.pass('Ctrl 再点同条切换出选：names 只剩先选那条')
          : rep.fail(`Ctrl 切换出选存证异常：${JSON.stringify(off)}`);

        // c. 空白清空：先补回两条选中，再点文档区顶排上方的容器空白（分区热区内的非条目面）
        await sleep(600); // 同上：隔开同位置（docR2 第三击）的双击窗口
        const tBack = Date.now();
        const okBack = await ctrlClickItem20(selDoc2, '选区-Ctrl 补选');
        const back = okBack && await waitEvent('desktop-selection-toggled', (e) => e.t >= tBack && (e.names || []).length === 2, 4000);
        if (!back) rep.fail('空白清空前置补选失败');
        // 文档区容器内边距空白：顶排条目上沿之上 6px——在条目包围盒+10px 热区内、又不落任何条目。
        // 顶排条目也随后台频次换位，这落点离补选/断言隔了几秒，临点现取
        const topBlank = liveTopDocRect();
        if (!topBlank) rep.fail('选区-空白清空取矩形失败（文档区无可视条目）');
        const blankPt = topBlank && { x: rectS.left + Math.round((topBlank.rect.x + topBlank.rect.w / 2) * f), y: rectS.top + Math.round((topBlank.rect.y - 6) * f) };
        const tBlank = Date.now();
        const okBlank = blankPt && await hitAndClick(blankPt, '选区-空白');
        const cleared = okBlank && await waitEvent('desktop-selection-cleared', (e) => e.t >= tBlank && (e.had || []).length === 2, 4000);
        cleared
          ? rep.pass('单击分区空白清空选区：desktop-selection-cleared 存证（had=2）')
          : rep.fail(`分区空白清空存证异常：${JSON.stringify(cleared)}`);
      }
      w32.moveMousePhys(safePt.x, safePt.y);

      // d. 快照重建选中不丢（条目集合不变）：重选两条 → touch 探针 mtime（指纹翻转、名字集不变
      //    → DOM 重建）→ desktop-rendered.sel 仍含两条
      if (docR && docR2) {
        const tRe = Date.now();
        const rRe1 = liveItemRect(selDoc);
        if (!rRe1) rep.fail(`重建-重选取矩形失败（${selDoc} 不在最新渲染里）`);
        const okRe1 = rRe1 && await hitAndClick(ptOf(rRe1.rect), '重建-重选');
        const reSel = okRe1 && await waitEvent('desktop-selected', (e) => e.t >= tRe && e.name === selDoc, 4000);
        const rRe2 = liveItemRect(selDoc2);
        if (!rRe2) rep.fail(`重建-Ctrl 补选取矩形失败（${selDoc2} 不在最新渲染里）`);
        const okRe2 = reSel && rRe2 && await ctrlClick(ptOf(rRe2.rect), '重建-Ctrl 补选');
        const reTwo = okRe2 && await waitEvent('desktop-selection-toggled', (e) => e.t >= tRe && (e.names || []).length === 2, 4000);
        if (!reTwo) {
          rep.fail('快照重建用例前置补选失败');
        } else {
          const fut = new Date(Date.now() + 5000);
          fs.utimesSync(selDocPath, fut, fut); // mtime 变 → iconKey/指纹翻转，条目集合不变
          const rebuilt = await waitEvent('desktop-rendered', (e) => e.t >= tRe && sameNames(e.sel, [selDoc, selDoc2]), 8000);
          rebuilt
            ? rep.pass(`快照重建（条目集合不变）后选中态不丢：desktop-rendered.sel=[${(rebuilt.sel || []).join(', ')}]`)
            : rep.fail('指纹翻转重建后选中态丢失（desktop-rendered.sel 未见两条）');

          // e. 选中条目被外部删除 → 自动出选区
          fs.unlinkSync(selDoc2Path);
          const tPrune = Date.now();
          const pruned = await waitEvent('desktop-selection-pruned', (e) => e.t >= tPrune && (e.removed || []).join() === selDoc2, 8000);
          pruned && sameNames(pruned.names, [selDoc])
            ? rep.pass(`选中条目外部删除自动剔除：removed=[${selDoc2}]，余 [${(pruned.names || []).join(', ')}]`)
            : rep.fail(`外删剔除存证异常：${JSON.stringify(pruned)}`);
          const goneSel = await waitEvent('desktop-rendered', (e) => e.t >= tPrune && sameNames(e.sel, [selDoc]), 8000);
          goneSel || rep.fail('外删后 desktop-rendered.sel 仍含被删条目（悬空选中）');
        }
      }
      w32.moveMousePhys(safePt.x, safePt.y);

      // f. 双击全开：两条探针 bat（写标记实证）→ 点选 + Ctrl 补选 → 双击其一 → 整集逐项启动
      {
        const batA = `DECK20-BAT-${t20}-A.bat`;
        const batB = `DECK20-BAT-${t20}-B.bat`;
        const pathA = path.join(seedScan.user, batA);
        const pathB = path.join(seedScan.user, batB);
        const markerA = path.join(__dirname, 'evidence', `20-marker-${t20}-A.txt`);
        const markerB = path.join(__dirname, 'evidence', `20-marker-${t20}-B.txt`);
        try {
          createProbeBat(pathA, markerA);
          createProbeBat(pathB, markerB);
          const both = await waitEvent('desktop-rendered', (e) => (e.names || []).includes(batA) && (e.names || []).includes(batB), 8000);
          if (!both) {
            rep.fail('双击全开探针 bat 未入池');
          } else {
            await waitStable('desktop-rendered', 1500, 8000);
            // 落点现取（工单59 真机首跑教训）：两条 bat 入池后频次分数落定会重排名序，
            // 一次 settle 抓的矩形隔几秒再点就点空
            const rA = liveItemRect(batA);
            const rB = liveItemRect(batB);
            if (!rA || !rB) {
              rep.fail(`双击全开探针无矩形（不可点击）：${!rA ? batA : batB} 不在最新渲染里`);
            } else {
              const tSet = Date.now();
              const rAl1 = liveItemRect(batA);
              if (!rAl1) rep.fail(`双击全开-点选 A 取矩形失败（${batA} 不在最新渲染里）`);
              const ok1 = rAl1 && await hitAndClick(ptOf(rAl1.rect), '双击全开-点选 A');
              const selA = ok1 && await waitEvent('desktop-selected', (e) => e.t >= tSet && e.name === batA, 4000);
              const rBl = liveItemRect(batB);
              if (!rBl) rep.fail(`双击全开-Ctrl 补选 B 取矩形失败（${batB} 不在最新渲染里）`);
              const ok2 = selA && rBl && await ctrlClick(ptOf(rBl.rect), '双击全开-Ctrl 补选 B');
              const two = ok2 && await waitEvent('desktop-selection-toggled', (e) => e.t >= tSet && sameNames(e.names, [batA, batB]), 4000);
              if (!two) {
                rep.fail('双击全开前置（选中集两条）未达成');
              } else {
                await sleep(600); // 隔开此前点击的双击窗口，确保接下来的两击自成一组
                const rAl2 = liveItemRect(batA); // 现取：前面的点选已把频次分数推上去，名序可能重排
                if (!rAl2) {
                  rep.fail(`双击全开双击取矩形失败（${batA} 不在最新渲染里）`);
                } else {
                  const tDbl = Date.now();
                  const pt = ptOf(rAl2.rect);
                  const hitDbl = await ensurePanelHit(pt, hwnd);
                if (!hitDbl.ok) {
                    rep.fail(`双击全开前置失败：${hitDbl.why}`);
                  } else {
                    w32.clickPhys(pt.x, pt.y, 'left');
                    await sleep(90); // 第二击落在 GetDoubleClickTime（默认 500ms）内
                    w32.clickPhys(pt.x, pt.y, 'left');
                    w32.moveMousePhys(safePt.x, safePt.y);
                    const setClicked = await waitEvent('desktop-launch-set-clicked', (e) => e.t >= tDbl && (e.names || []).length === 2, 6000);
                    const setOk = setClicked && (setClicked.names || []).join() === [batA, batB].join();
                    setOk
                      ? rep.pass('双击选中集内任一条 = 整集启动名单（desktop-launch-set-clicked 两条）')
                      : rep.fail(`双击全开名单存证异常：${JSON.stringify(setClicked)}`);
                    const tLa = Date.now();
                    const launchA = await waitEvent('desktop-launched', (e) => e.t >= tLa && e.name === batA && e.ok, 6000);
                    const launchB = await waitEvent('desktop-launched', (e) => e.t >= tLa && e.name === batB && e.ok, 6000);
                    launchA && launchB
                      ? rep.pass('整集逐项启动：两条 desktop-launched ok=true（desktop/launch 逐项存证）')
                      : rep.fail(`整集启动存证异常：A=${JSON.stringify(launchA)} B=${JSON.stringify(launchB)}`);
                    let markerOk = { A: false, B: false };
                    const markerDeadline = Date.now() + 20000;
                    while (Date.now() < markerDeadline && !(markerOk.A && markerOk.B)) {
                      for (const [k, mp] of [['A', markerA], ['B', markerB]]) {
                        if (markerOk[k]) continue;
                        try { markerOk[k] = fs.readFileSync(mp, 'utf8').trim() === 'ok'; } catch { markerOk[k] = false; }
                      }
                      if (!(markerOk.A && markerOk.B)) await sleep(250);
                    }
                    markerOk.A && markerOk.B
                      ? rep.pass('双击全开目标实证：两条探针 bat 均启动（标记文件双落盘）')
                      : rep.fail(`双击全开标记缺失：A=${markerOk.A} B=${markerOk.B}`);
                  }
                }
              }
            }
          }
        } finally {
          for (const p of [pathA, pathB]) { try { fs.unlinkSync(p); } catch { /* 尽力清理 */ } }
        }
        try { fs.unlinkSync(markerA); } catch { /* 尽力清理 */ }
        try { fs.unlinkSync(markerB); } catch { /* 尽力清理 */ }
        try { fs.unlinkSync(selDocPath); } catch { /* 已删则跳过 */ }
        try { fs.unlinkSync(selDoc2Path); } catch { /* e 段已删则跳过 */ }
      }
    })();

    // —— P5.7 工单21 框选：分区空白起笔、实时矩形与即时高亮、松手替换 / Ctrl 并集、
    // 条目起笔不误触（阈值内=普通点击语义）、指针流出分区包围盒不中断；工单89 补
    // 外扩带起笔 ×2（doc 标签带 / dock body 环带——旧热区边带外的原穿透区）。
    // band/ctrl-band 语义矩阵穷举在离线测试（tests/renderer/selection.spec.ts），
    // 这里每类语义只留真机端到端代表用例（#19 spec 三缝约定）。命中期望值由电池按
    // desktop-rendered 的 rects + DOM 序（工单59 后只剩 doc 分组序，应用区不再渲染）
    // 复算——与渲染层 querySelectorAll 的遍历序一致，不依赖具体桌面内容。
    rep.beginSegment('P5.7');
    await (async () => {
      const rectS = w32.rectOf(hwnd);
      const ptOfDip = (x, y) => ({ x: rectS.left + Math.round(x * f), y: rectS.top + Math.round(y * f) });
      const sameNames = (a, b) => (a || []).join() === b.join();

      // a. 夹具：三条 docx 探针保证文档区 ≥3 条（列几何随桌面而变，命中集运行时复算）
      const t21 = Date.now();
      const probes = [0, 1, 2].map((i) => `DECK21-DOC-${t21}-${i}.docx`);
      const probePaths = probes.map((n) => path.join(seedScan.user, n));
      try {
        for (const p of probePaths) fs.writeFileSync(p, 'probe');
        const joined21 = await waitEvent('desktop-rendered', (e) => probes.every((n) => (e.names || []).includes(n)), 8000);
        joined21 || rep.fail(`框选文档探针未入池（${probes.join(', ')}）`);

        const settled21 = await waitStable('desktop-rendered', 1500, 8000);
        // 几何现取（工单59 真机首跑教训）：文档区名序随后台使用频次落定会重排（工单05，~1s 内动），
        // settled21 抓的那份几何隔几秒再点就点空。各段按「要点的这一刻」重读最新一拍；落点与期望
        // 命中集同源同拍复算——框变了而期望没变，一样是假败。
        const GROUPS21 = ['folders', 'office', 'pdf', 'image', 'archive', 'other'];
        const boxOf = (p1, p2) => ({ l: Math.min(p1.x, p2.x), t: Math.min(p1.y, p2.y), r: Math.max(p1.x, p2.x), b: Math.max(p1.y, p2.y) });
        const geo21 = () => {
          const last = readEvents().filter((e) => e.type === 'desktop-rendered').pop();
          const rects = ((last && last.rects) || []).filter((r) => r.zone === 'doc' && r.rect).map((r) => ({ name: r.name, ...r.rect }));
          const byName = new Map(rects.map((r) => [r.name, r]));
          // DOM 序复算（渲染层 marqueeHits 的 querySelectorAll 序）：doc 分组序（工单59 后无 dock 段）
          const order = GROUPS21
            .flatMap((g) => ((last && last.docEntries) || []).filter((e) => e.group === g).map((e) => e.name))
            .filter((n) => byName.has(n));
          return {
            rects, order,
            rectOf: (n) => byName.get(n) || null,
            // 顶排条目：起笔空白点取它上沿之上 6px（分区热区边距内、不落任何条目）
            top: rects.slice().sort((a, b) => a.y - b.y || a.x - b.x)[0] || null,
            hitsOf: (box) => order.filter((n) => {
              const r = byName.get(n);
              return r.x < box.r && r.x + r.w > box.l && r.y < box.b && r.y + r.h > box.t;
            }),
            zoneBox: rects.length ? {
              l: Math.min(...rects.map((r) => r.x)), t: Math.min(...rects.map((r) => r.y)),
              r: Math.max(...rects.map((r) => r.x + r.w)), b: Math.max(...rects.map((r) => r.y + r.h)),
            } : null,
          };
        };
        const g0 = geo21();
        // 预置单选哨兵（替换 / Ctrl 并集用例的「旧选区」）：DOM 序末条文档区条目——框选
        // 矩形止于同列第 2 行，末条必在其外。工单59 后面板没有应用区，哨兵改由文档区承担。
        // 只有名字在门禁处定死（b/c/d/e 段语义须指向同一条），矩形随后各段现取。
        const sentinel21 = g0.order.length ? g0.order[g0.order.length - 1] : null;
        if (!settled21 || !g0.top || !sentinel21 || g0.rects.length < 3) {
          rep.fail(`框选几何前置缺失：doc=${g0.rects.length} T=${!!g0.top} 哨兵=${!!sentinel21}`);
        } else {
          let expected1 = null; // b 段现取；c 段要拿它复算 expected2，故跨块持有
          let M = null;         // 框外条目（c 段定，d 段当开关用）
          // 步进拖拽（与 06 拖拽摆位同法）：按住起笔 → 步进到落点 →（可选驻留回调）→ 抬键
          const dragMarquee = async (from, to, opts = {}) => {
            const hit = await ensurePanelHit(from, hwnd);
            if (!hit.ok) { rep.fail(`框选前置失败：${hit.why}`); return false; }
            if (opts.ctrl) { w32.send([w32.keyInput(VK_CONTROL, w32.KEYDOWN)]); await sleep(80); }
            w32.send([w32.mouseInput(0, 0, w32.LEFTDOWN)]);
            const steps = 16;
            for (let s = 1; s <= steps; s++) {
              await sleep(22);
              w32.moveMousePhys(from.x + Math.round(((to.x - from.x) * s) / steps), from.y + Math.round(((to.y - from.y) * s) / steps));
            }
            await sleep(120);
            if (opts.onHold) await opts.onHold();
            w32.send([w32.mouseInput(0, 0, w32.LEFTUP)]);
            if (opts.ctrl) { await sleep(80); w32.send([w32.keyInput(VK_CONTROL, w32.KEYUP)]); }
            w32.moveMousePhys(safePt.x, safePt.y);
            return true;
          };

          // b. 替换语义 + 实时绘制/即时高亮：先单选文档区哨兵 A，再普通框选 T..N，
          //    松手选区应只剩框选命中（A 被替换掉）
          {
            const G = geo21(); // 本段落点与期望同源同拍
            const T = G.top;
            const stDip = T ? { x: T.x + T.w / 2, y: T.y - 6 } : null;
            const preItem = G.rectOf(sentinel21);
            if (!T || !stDip || !preItem) {
              rep.fail('框选几何前置缺失（最新渲染里取不到顶排条目/哨兵矩形）');
            } else {
              const stBlank = !G.rects.some((r) => stDip.x > r.x && stDip.x < r.x + r.w && stDip.y > r.y && stDip.y < r.y + r.h);
              stBlank || rep.note('起笔点校验：顶行上方 6px 落在条目内（几何异常，以下断言可能失真）');
              // 同列下邻 N（无则只框 T）；expected1 = 框选矩形（起笔→N 中心）的相交集
              const Tcx = T.x + T.w / 2;
              const N = G.rects.filter((r) => r.name !== T.name && Math.abs(r.x + r.w / 2 - Tcx) <= 30 && r.y > T.y).sort((a, b) => a.y - b.y)[0] || null;
              const end1Dip = N ? { x: N.x + N.w / 2, y: N.y + N.h / 2 } : { x: T.x + T.w / 2, y: T.y + T.h / 2 };
              expected1 = G.hitsOf(boxOf(stDip, end1Dip));

              const tPre = Date.now();
              const ptA = ptOfDip(preItem.x + preItem.w / 2, preItem.y + preItem.h / 2);
              const hitPre = await ensurePanelHit(ptA, hwnd);
              if (!hitPre.ok) rep.fail(`框选-预置选区前置失败：${hitPre.why}`);
              else w32.clickPhys(ptA.x, ptA.y, 'left');
              const pre = hitPre.ok && await waitEvent('desktop-selected', (e) => e.t >= tPre && e.name === preItem.name, 4000);
              pre || rep.fail('框选-预置单选未见 desktop-selected（替换语义不可分辨）');

              const zoneBox = G.zoneBox;
              const tMq1 = Date.now();
              const ok1 = await dragMarquee(ptOfDip(stDip.x, stDip.y), ptOfDip(end1Dip.x, end1Dip.y), {
                // 按住期间实拍：矩形与即时高亮的视觉证据（captureFast ~200ms，指针驻留不动）
                onHold: () => captureFast({
                  left: Math.max(0, rectS.left + Math.round((zoneBox.l - 24) * f)),
                  top: Math.max(0, rectS.top + Math.round((zoneBox.t - 24) * f)),
                  right: rectS.left + Math.round((zoneBox.r + 24) * f),
                  bottom: rectS.top + Math.round((zoneBox.b + 24) * f),
                }, '21-marquee-live').catch((err) => {
                  rep.note(`框选实拍失败（不阻塞语义断言）：${err && err.message}`);
                }),
              });
              if (!ok1) {
                rep.fail('普通框选用例未执行（前置失败）');
              } else {
                const started = await waitEvent('desktop-marquee-started', (e) => e.t >= tMq1, 4000);
                started
                  ? rep.pass(`框选越过阈值即启动：desktop-marquee-started（起笔于分区空白 (${Math.round(started.from.x)}, ${Math.round(started.from.y)})）`)
                  : rep.fail('desktop-marquee-started 未见（阈值/起笔接线异常）');
                const live = await waitEvent('desktop-marquee-updated', (e) => e.t >= tMq1 && sameNames(e.hits, expected1), 4000);
                live
                  ? rep.pass(`拖动途中即时高亮：desktop-marquee-updated 途中携带命中 [${expected1.join(', ')}]（矩形实拍见 21-marquee-live.png）`)
                  : rep.fail(`途中命中存证异常：期望 [${expected1.join(', ')}]，未见对应 desktop-marquee-updated`);
                const fin1 = await waitEvent('desktop-marquee-finished', (e) => e.t >= tMq1 && e.ctrl === false && sameNames(e.hits, expected1) && sameNames(e.names, expected1), 4000);
                fin1
                  ? rep.pass(`松手普通框选=替换：选区由 [${preItem.name}] → [${expected1.join(', ')}]（desktop-marquee-finished ctrl=false）`)
                  : rep.fail(`替换语义存证异常：${JSON.stringify(fin1)}`);
              }
            }
          }

          // c. Ctrl 并集：Ctrl 点选补回 A（跨区混选）→ Ctrl 框选圈入 expected1 之外的条目 M，
          //    松手 = 旧选区保序 + 新命中追加（按名去重）
          let unionNames = null; // 供 d 段清空断言核对 had
          {
            const G = geo21();
            const stDip = G.top ? { x: G.top.x + G.top.w / 2, y: G.top.y - 6 } : null;
            const preItem = G.rectOf(sentinel21);
            M = expected1 ? G.order.find((n) => !expected1.includes(n)) : null;
            if (!stDip || !preItem) {
              rep.fail('Ctrl 并集几何前置缺失（最新渲染里取不到顶排条目/哨兵矩形）');
            } else if (!M) {
              rep.note('无框外条目可圈（文档区条目不足），Ctrl 并集用例跳过');
            } else {
              const ptAc = ptOfDip(preItem.x + preItem.w / 2, preItem.y + preItem.h / 2);
              const tCc = Date.now();
              const okCc0 = await ensurePanelHit(ptAc, hwnd);
              if (!okCc0.ok) rep.fail(`Ctrl 并集-预置前置失败：${okCc0.why}`);
              else {
                w32.send([w32.keyInput(VK_CONTROL, w32.KEYDOWN)]);
                await sleep(60);
                w32.clickPhys(ptAc.x, ptAc.y, 'left');
                await sleep(60);
                w32.send([w32.keyInput(VK_CONTROL, w32.KEYUP)]);
              }
              const cc = okCc0.ok && await waitEvent('desktop-selection-toggled', (e) => e.t >= tCc && e.selected === true && sameNames(e.names, [...expected1, preItem.name]), 4000);
              if (!cc) {
                rep.fail('Ctrl 并集前置（Ctrl 点选补回 A）未达成');
              } else {
                const mR = G.rectOf(M);
                const end2Dip = { x: mR.x + mR.w / 2, y: mR.y + mR.h / 2 };
                const expected2 = G.hitsOf(boxOf(stDip, end2Dip));
                const selBefore = [...expected1, preItem.name];
                const expectedUnion = selBefore.concat(expected2.filter((n) => !selBefore.includes(n)));
                unionNames = expectedUnion;
                const tMq2 = Date.now();
                const ok2 = await dragMarquee(ptOfDip(stDip.x, stDip.y), ptOfDip(end2Dip.x, end2Dip.y), { ctrl: true });
                if (!ok2) {
                  rep.fail('Ctrl 框选用例未执行（前置失败）');
                } else {
                  const fin2 = await waitEvent('desktop-marquee-finished', (e) => e.t >= tMq2 && e.ctrl === true && sameNames(e.hits, expected2) && sameNames(e.names, expectedUnion), 4000);
                  fin2
                    ? rep.pass(`松手 Ctrl 框选=并集：[${selBefore.join(', ')}] ∪ 命中 [${expected2.join(', ')}] → [${expectedUnion.join(', ')}]（按名去重）`)
                    : rep.fail(`并集语义存证异常：${JSON.stringify(fin2)}`);
                  safeShot('21-marquee-ctrl-union', {
                    left: Math.max(0, rectS.left + Math.round((G.zoneBox.l - 24) * f)),
                    top: Math.max(0, rectS.top + Math.round((G.zoneBox.t - 24) * f)),
                    right: rectS.left + Math.round((Math.min(G.zoneBox.r, (mR.x + mR.w) + 24)) * f),
                    bottom: rectS.top + Math.round((G.zoneBox.b + 24) * f),
                  });
                  // 渲染态交叉校验：touch 探针 mtime 翻指纹 → desktop-rendered.sel 应携带并集
                  const fut21 = new Date(Date.now() + 5000);
                  fs.utimesSync(probePaths[2], fut21, fut21);
                  const selEvt = await waitEvent('desktop-rendered', (e) => e.t >= tMq2 && sameNames(e.sel, expectedUnion), 8000);
                  selEvt
                    ? rep.pass('并集结果入渲染态：指纹翻转重建后 desktop-rendered.sel=并集（选中不闪没）')
                    : rep.fail('重建后 desktop-rendered.sel 与并集不符');
                }
              }
            }
          }

          // d. 阈值内松手=普通点击语义：空白起笔 + 3px 抖动 + 抬键 → 不进框选、
          //    尾随 click 清空选区（had=并集名单）
          if (M) {
            const G = geo21();
            const stDip = G.top ? { x: G.top.x + G.top.w / 2, y: G.top.y - 6 } : null;
            if (!stDip) {
              rep.fail('阈值用例几何前置缺失（最新渲染里取不到顶排条目）');
            } else {
              const tSub = Date.now();
              const okSub = await ensurePanelHit(ptOfDip(stDip.x, stDip.y), hwnd);
              if (!okSub.ok) {
                rep.fail(`阈值用例前置失败：${okSub.why}`);
              } else {
                const stPx = ptOfDip(stDip.x, stDip.y);
                w32.send([w32.mouseInput(0, 0, w32.LEFTDOWN)]);
                await sleep(30);
                w32.moveMousePhys(stPx.x + 3, stPx.y + 2); // 3 物理px（任何 DPI 缩放下都 < 6 DIP 阈值）
                await sleep(30);
                w32.send([w32.mouseInput(0, 0, w32.LEFTUP)]);
                w32.moveMousePhys(safePt.x, safePt.y);
                const noStart = await waitEvent('desktop-marquee-started', (e) => e.t >= tSub, 1200);
                const clearedSub = await waitEvent('desktop-selection-cleared', (e) => e.t >= tSub && (!unionNames || sameNames(e.had, unionNames)), 4000);
                !noStart && clearedSub
                  ? rep.pass(`阈值内松手=普通点击：无框选事件，尾随 click 清空选区（desktop-selection-cleared had=${clearedSub.had ? clearedSub.had.length : '?'} 条）`)
                  : rep.fail(`阈值语义异常：marquee-started=${JSON.stringify(!!noStart)} cleared=${JSON.stringify(!!clearedSub)}`);
              }
            }
          }

          // e. 起笔于条目不误触：按住文档区条目拖出阈值、落到另一条上 → 走拖拽摆位
          //    路径（desktop-moved ok 为正证据），全程无框选事件。（原位抬键会被
          //    itemUnder 判成 beforeName=null 的「挪到末位」，故落点选另一条真实条目。）
          {
            const G = geo21();
            const preItem = G.rectOf(sentinel21);
            const otherDoc = G.rects.slice().sort((a, b) => b.y - a.y || b.x - a.x).find((r) => r.name !== sentinel21);
            if (!preItem) {
              rep.fail('条目起笔用例几何前置缺失（哨兵不在最新渲染里）');
            } else if (!otherDoc) {
              rep.note('文档区无第二条可视条目，条目起笔用例跳过');
            } else {
              const tItem = Date.now();
              const ptL = ptOfDip(otherDoc.x + otherDoc.w / 2, otherDoc.y + otherDoc.h / 2);
              const ptAe = ptOfDip(preItem.x + preItem.w / 2, preItem.y + preItem.h / 2);
              const okItem = await dragMarquee(ptAe, ptL);
              if (!okItem) {
                rep.fail('条目起笔用例未执行（前置失败）');
              } else {
                const noMq = await waitEvent('desktop-marquee-started', (e) => e.t >= tItem, 1200);
                const moved = await waitEvent('desktop-moved', (e) => e.t >= tItem && e.name === preItem.name && e.ok, 5000);
                !noMq
                  ? rep.pass(`起笔于条目不误触框选（仍走拖拽摆位路径：desktop-moved ok=${moved ? 'true' : '未落盘（同位守卫）'}）`)
                  : rep.fail('条目起笔误入框选（desktop-marquee-started 不应出现）');
              }
            }
          }

          // f. 越过阈值后指针流出分区包围盒不中断：向左拖出文档区包围盒 130px 到真桌面
          //    空白（热区外），松手框选仍提交、命中按整条矩形（含区外段）计算。
          //    末点 y 避开条目边界 ≥3px：中点恰好落在行边界时，物理→DIP 的亚像素
          //    舍入会让电池复算与渲染层实时判定分裂（首轮实测踩中：8 行均分时中点
          //    正好压在第 5 行上沿）。
          {
            const G = geo21();
            const zoneBox = G.zoneBox;
            const stDip = G.top ? { x: G.top.x + G.top.w / 2, y: G.top.y - 6 } : null;
            if (!zoneBox || !stDip) {
              rep.fail('越界框选用例几何前置缺失（最新渲染里取不到文档区矩形）');
            } else {
              const tOut = Date.now();
              let end5y = zoneBox.t + (zoneBox.b - zoneBox.t) / 2;
              for (const r of G.rects) {
                if (Math.abs(end5y - r.y) < 3 || Math.abs(end5y - (r.y + r.h)) < 3) { end5y += 6; break; }
              }
              const end5Dip = { x: Math.max(zoneBox.l - 130, 30), y: end5y };
              const expected5 = G.hitsOf(boxOf(stDip, end5Dip));
              const ok5 = await dragMarquee(ptOfDip(stDip.x, stDip.y), ptOfDip(end5Dip.x, end5Dip.y));
              if (!ok5) {
                rep.fail('越界框选用例未执行（前置失败）');
              } else {
                const fin5 = await waitEvent('desktop-marquee-finished', (e) => e.t >= tOut && sameNames(e.hits, expected5), 4000);
                const reached = fin5 && fin5.rect && fin5.rect.x <= zoneBox.l - 60;
                fin5 && reached
                  ? rep.pass(`指针流出分区包围盒框选不中断：矩形左沿 ${Math.round(fin5.rect.x)} < 包围盒左沿 ${Math.round(zoneBox.l)}，松手仍提交命中 [${expected5.join(', ')}]`)
                  : rep.fail(`越界续接异常：fin=${JSON.stringify(fin5 && { rect: fin5.rect, hits: fin5.hits })} reached=${JSON.stringify(!!reached)}`);
              }
            }
          }

          // g. doc 外扩带起笔（工单89）：文档区顶条上沿外 20px——旧几何（条目包围盒
          //    +10px 边带）下是穿透真桌面、起不了笔的空白；新几何（容器外扩 24px）下
          //    面板接住、直接起笔框选。起笔点落分区 DOM 内（组标签带），前置断言其在
          //    现役 doc-zone 热区矩形内且不落任何条目。工单59 后面板无应用区，master
          //    上那条 dock 环带用例随分区退役一并删去，doc 环带保留并改挂 geo21 实时几何。
          {
            const G = geo21();
            const docZoneRect = latestZoneOf('doc-zone', t21);
            const T = G.top;
            if (!T) {
              rep.fail('doc 外扩带前置异常：最新渲染里取不到文档区顶排条目');
            } else {
              const docRingStart = { x: T.x + T.w / 2, y: T.y - 20 };
              const docRingEnd = { x: T.x + T.w / 2, y: T.y + T.h / 2 };
              const docRingBlank = !G.rects.some((r) => docRingStart.x > r.x && docRingStart.x < r.x + r.w && docRingStart.y > r.y && docRingStart.y < r.y + r.h);
              const inDocZone = !!docZoneRect
                && docRingStart.x >= docZoneRect.x && docRingStart.x < docZoneRect.x + docZoneRect.w
                && docRingStart.y >= docZoneRect.y && docRingStart.y < docZoneRect.y + docZoneRect.h;
              if (!docZoneRect || !inDocZone || !docRingBlank) {
                rep.fail(`doc 外扩带前置异常：dz=${JSON.stringify(docZoneRect)} start=(${Math.round(docRingStart.x)},${Math.round(docRingStart.y)}) in=${inDocZone} blank=${docRingBlank}`);
              } else {
                const tDocRing = Date.now();
                const okDocRing = await dragMarquee(ptOfDip(docRingStart.x, docRingStart.y), ptOfDip(docRingEnd.x, docRingEnd.y));
                if (!okDocRing) {
                  rep.fail('doc 外扩带框选用例未执行（前置失败）');
                } else {
                  const docRingExpected = G.hitsOf(boxOf(docRingStart, docRingEnd));
                  const startedDocRing = await waitEvent('desktop-marquee-started', (e) => e.t >= tDocRing, 4000);
                  const finDocRing = await waitEvent('desktop-marquee-finished', (e) => e.t >= tDocRing && e.ctrl === false && sameNames(e.hits, docRingExpected) && sameNames(e.names, docRingExpected), 4000);
                  startedDocRing && finDocRing
                    ? rep.pass(`doc 外扩带起笔框选：顶条上沿外 20px（旧 10px 边带外的穿透区）直接起笔，命中 [${docRingExpected.join(', ')}]`)
                    : rep.fail(`doc 外扩带框选存证异常：started=${JSON.stringify(!!startedDocRing)} fin=${JSON.stringify(finDocRing && { hits: finDocRing.hits })}`);
                  safeShot('89-marquee-doc-ring', {
                    left: Math.max(0, rectS.left + Math.round((T.x - 24) * f)),
                    top: Math.max(0, rectS.top + Math.round((docRingStart.y - 12) * f)),
                    right: rectS.left + Math.round((T.x + T.w + 24) * f),
                    bottom: rectS.top + Math.round((docRingEnd.y + 24) * f),
                  });
                }
              }
            }
          }

        }
      } finally {
        for (const p of probePaths) { try { fs.unlinkSync(p); } catch { /* 尽力清理 */ } }
      }
    })();

    // —— P5.8 工单22 批量拖拽摆位：整组按选区插入序落进文档区显式段、ghost「N 项」
    // 徽标（N=实际拖动条数）。工单59 后面板只有文档区一处承载，也没有手钉组员可跳
    // 过——skipped 只在池外名字（外部删除竞态）时出现，故此处恒为空名单；跨区「落点
    // 分区为准」退化为同区内按插入序插到参照之前。内核参照校验/落盘语义在离线测试
    // （tests/desktop/service.spec.ts + tests/contract.spec.ts），这里留真机端到端
    // 代表用例（#19 三缝约定）。
    rep.beginSegment('P5.8');
    await (async () => {
      const rectB = w32.rectOf(hwnd);
      const ptOfB = (r) => ({ x: rectB.left + Math.round((r.x + r.w / 2) * f), y: rectB.top + Math.round((r.y + r.h / 2) * f) });
      const sameNames22 = (a, b) => (a || []).join() === b.join();
      const officeOrder22 = (e) => ((e && e.docEntries) || []).filter((d) => d.group === 'office').map((d) => d.name);
      const ctrlClick22 = async (pt, label) => {
        const hit = await ensurePanelHit(pt, hwnd);
        if (!hit.ok) { rep.fail(`${label}前置失败：${hit.why}`); return false; }
        w32.send([w32.keyInput(VK_CONTROL, w32.KEYDOWN)]);
        await sleep(60);
        w32.clickPhys(pt.x, pt.y, 'left');
        await sleep(60);
        w32.send([w32.keyInput(VK_CONTROL, w32.KEYUP)]);
        return true;
      };
      // 步进拖拽（06/21 同法）：按住起笔条目 → 步进到落点 →（可选驻留回调：ghost 实拍）→ 抬键
      const dragBatch = async (from, to, onHold) => {
        const hit = await ensurePanelHit(from, hwnd);
        if (!hit.ok) { rep.fail(`批量拖拽前置失败：${hit.why}`); return false; }
        w32.send([w32.mouseInput(0, 0, w32.LEFTDOWN)]);
        const steps = 16;
        for (let s = 1; s <= steps; s++) {
          await sleep(22);
          w32.moveMousePhys(from.x + Math.round(((to.x - from.x) * s) / steps), from.y + Math.round(((to.y - from.y) * s) / steps));
        }
        await sleep(140); // 落点稳定后再驻留/抬键（elementFromPoint 取参照条目）
        if (onHold) await onHold();
        w32.send([w32.mouseInput(0, 0, w32.LEFTUP)]);
        w32.moveMousePhys(safePt.x, safePt.y);
        return true;
      };

      // a. 夹具：三条同组（office）docx 探针，mtime 拉开使出厂序稳定为 [1, 2, 3]
      const t22 = Date.now();
      const probes22 = [1, 2, 3].map((i) => `DECK22-DOC-${t22}-${i}.docx`);
      const paths22 = probes22.map((n) => path.join(seedScan.user, n));
      deckProbeFiles.push(...paths22);
      try {
        for (const p of paths22) fs.writeFileSync(p, 'probe');
        const now22 = Date.now();
        paths22.forEach((p, i) => { const t = new Date(now22 - (2 - i) * 60000); fs.utimesSync(p, t, t); });
        const joined22 = await waitEvent('desktop-rendered', (e) => probes22.every((n) => (e.names || []).includes(n)), 8000);
        joined22 || rep.fail(`批量拖拽探针未入池（${probes22.join(', ')}）`);

        const settled22 = await waitStable('desktop-rendered', 1500, 8000);
        const orderBefore22 = officeOrder22(settled22).filter((n) => probes22.includes(n));
        rep.note(`批量拖拽夹具出厂序：[${orderBefore22.join(', ')}]（mtime 1 最新 → 组内降序在前）`);
        const rect22 = (name) => {
          // 落点现取（工单59 真机首跑教训）：settled22 抓的矩形隔几秒再点就点空——工单05 名序
          // 在入池后 ~1s 内重排，点选 2 / 补选 3 / 抓起 2 拖到 1 之前三处各现取一次
          const r = liveItemRect(name);
          return r ? r.rect : null;
        };
        const rOne = rect22(probes22[0]);
        const rTwo = rect22(probes22[1]);
        const rThree = rect22(probes22[2]);
        if (!rOne || !rTwo || !rThree) {
          rep.fail(`批量拖拽用例矩形缺失：1=${!!rOne} 2=${!!rTwo} 3=${!!rThree}`);
          return;
        }

        // b. 组选区：单击 2 → Ctrl 补选 3（插入序 [2, 3]）
        const tSet22 = Date.now();
        const lTwo = rect22(probes22[1]);
        if (!lTwo) { rep.fail(`批量拖拽点选取矩形失败（${probes22[1]} 不在最新渲染里）`); return; }
        const ptTwo = ptOfB(lTwo);
        const hitTwo = await ensurePanelHit(ptTwo, hwnd);
        if (!hitTwo.ok) { rep.fail(`批量拖拽点选前置失败：${hitTwo.why}`); return; }
        w32.clickPhys(ptTwo.x, ptTwo.y, 'left');
        const selTwo = await waitEvent('desktop-selected', (e) => e.t >= tSet22 && e.name === probes22[1], 4000);
        selTwo || rep.fail('批量拖拽前置：单击选中 2 未见 desktop-selected');
        const lThree = rect22(probes22[2]);
        if (!lThree) rep.fail(`批量-Ctrl 补选 3 取矩形失败（${probes22[2]} 不在最新渲染里）`);
        const okThree = selTwo && lThree && await ctrlClick22(ptOfB(lThree), '批量-Ctrl 补选 3');
        const twoOk = okThree && await waitEvent('desktop-selection-toggled', (e) => e.t >= tSet22 && sameNames22(e.names, [probes22[1], probes22[2]]), 4000);
        twoOk || rep.fail('批量拖拽前置：Ctrl 补选 3 未达成（选区非 [2, 3]）');

        // c. 抓起 2 拖到 1 之前 → 显式段 [2, 3]，office 组内序翻转为 [2, 3, 1]
        if (!twoOk) return;
        const lTwoDrag = rect22(probes22[1]);
        const lOne = rect22(probes22[0]);
        if (!lTwoDrag || !lOne) {
          rep.fail(`批量拖拽落点取矩形失败：源 2=${!!lTwoDrag} 参照 1=${!!lOne}`);
          return;
        }
        const tDrag22 = Date.now();
        const dragOk = await dragBatch(ptOfB(lTwoDrag), ptOfB(lOne), async () => {
          try { // capture 是 spawnSync 同步实拍：失败仅丢一张截图，不拖累语义断言
            capture({ left: rectB.left, top: rectB.top, right: rectB.right, bottom: rectB.bottom }, '22-batch-ghost');
          } catch (err) {
            rep.note(`批量 ghost 实拍失败（不阻塞语义断言）：${err && err.message}`);
          }
        });
        if (!dragOk) return;
        const started22 = await waitEvent('desktop-batch-drag-started', (e) => e.t >= tDrag22 && sameNames22(e.names, [probes22[1], probes22[2]]) && e.count === 2, 4000);
        started22
          ? rep.pass(`ghost「N 项」徽标：desktop-batch-drag-started count=${started22.count}（整组 2 条都实际拖动）`)
          : rep.fail('ghost 徽标存证异常：desktop-batch-drag-started 未见或 count≠2');
        const clicked22 = await waitEvent('desktop-move-batch-clicked', (e) => e.t >= tDrag22 && e.zone === 'doc' && sameNames22(e.names, [probes22[1], probes22[2]]) && e.beforeName === probes22[0], 4000);
        clicked22
          ? rep.pass(`批量落位意图存证：desktop-move-batch-clicked zone=doc，参照 beforeName 落在 1 上`)
          : rep.fail('批量落位意图存证异常：desktop-move-batch-clicked 未见（zone=doc + 参照=1）');
        const done22 = await waitEvent('desktop-moved-batch', (e) => e.t >= tDrag22 && e.ok === true && sameNames22(e.moved, [probes22[1], probes22[2]]) && sameNames22(e.skipped, []), 6000);
        done22
          ? rep.pass(`整组落位 + skipped 如实上报：moved=[${done22.moved.join(', ')}]，skipped=[]（面板无手钉组员可跳过，desktop-moved-batch ok=true）`)
          : rep.fail(`批量落位/skipped 存证异常：${JSON.stringify(done22)}`);
        const relaid = await waitEvent('desktop-rendered', (e) => e.t >= tDrag22 && sameNames22(officeOrder22(e).filter((n) => probes22.includes(n)), [probes22[1], probes22[2], probes22[0]]), 6000);
        relaid
          ? rep.pass(`组内相对序 = 选区插入序：显式段 [2, 3] 插到 1 之前，office 序由 [${orderBefore22.map((n) => n.slice(-6)).join(', ')}] 翻转为 [2, 3, 1]`)
          : rep.fail('批量落位后编排未达预期（显式段序 ≠ 选区插入序）');
        safeShot('22-batch-moved', { left: rectB.left, top: rectB.top, right: rectB.right, bottom: rectB.bottom });
      } finally {
        for (const p of paths22) { try { fs.unlinkSync(p); } catch { /* 尽力清理 */ } }
      }
    })();

    // —— P5.9 工单23 上下文菜单：分区空白右键弹自绘菜单（shell 为 cordis 插件随清单
    // 热插拔）、开层全窗热区承接与菜单外一击收起（含热区外、无选区副作用）、工单30 起
    // 【粘贴】行在列（置灰语义归 P5.16）、全选（选区状态机 select-all）/恢复出厂布局
    // （06 契约）两动作。条目右键的单项菜单归 P5.10（工单24）——原「条目右键不弹」
    // 断言随单项菜单落地退役。
    // 开合/激活转移矩阵在离线测试（tests/renderer/menu-shell.spec.ts），
    // 这里留真机端到端代表用例（#19 三缝约定）。
    rep.beginSegment('P5.9');
    await (async () => {
      const rectM = w32.rectOf(hwnd); // P5.8 未重启面板，取现役矩形
      const ptOfM = (r) => ({ x: rectM.left + Math.round((r.x + r.w / 2) * f), y: rectM.top + Math.round((r.y + r.h / 2) * f) });
      const sameNamesM = (a, b) => (a || []).join() === b.join();
      // 右键空白点（20c 同法）：文档区顶排条目上沿之上 6px——分区热区边距内的非条目面
      // （工单59 后面板只有文档区一处承载，空白点由文档区顶排条目让出）
      // 顶排条目随后台使用频次落定会换位（工单05，~1s 内动），空白落点跟着换：本段的
      // 开层/收场跨几十秒（热插拔那几轮尤其长），一律临点现取，别拿早先快照的坐标
      let blankDip = null;
      let ptBlank = null;
      const refreshBlank = () => {
        const top = liveTopDocRect();
        if (!top) { blankDip = null; ptBlank = null; return false; }
        blankDip = { x: top.rect.x + top.rect.w / 2, y: top.rect.y - 6 };
        ptBlank = { x: rectM.left + Math.round(blankDip.x * f), y: rectM.top + Math.round(blankDip.y * f) };
        return true;
      };
      // 右键菜单打开原语：返回 { t0, opened }（opened 含 x/y 与行矩形），未弹返回 null
      const openMenuAt = async (label) => {
        if (!refreshBlank()) { rep.fail(`${label}前置失败：分区空白落点取矩形失败（文档区无可视条目）`); return null; }
        const hit = await ensurePanelHit(ptBlank, hwnd);
        if (!hit.ok) { rep.fail(`${label}前置失败：${hit.why}`); return null; }
        const t0 = Date.now();
        w32.clickPhys(ptBlank.x, ptBlank.y, 'right');
        const opened = await waitEvent('desktop-menu-opened', (e) => e.t >= t0, 4000);
        return opened ? { t0, opened } : null;
      };
      // 收起原语：点 pt（物理坐标）。两处用法：
      // - 面板内、分区热区之外的空档（文档区与右列卡片之间）：常规态这一击根本进不了
      //   面板（穿透传真桌面），开层后能进渲染层本身就证明全窗热区承接；
      // - 分区空白（传 refreshBlank() && ptBlank）：尾随 click 会撞上分区的空白清空监听
      //   ——吞没机制的正宗考题；分区空白同样现取。
      // 注意不能用 safePt——它在任务栏上（面板只盖工作区），点击永远到不了渲染层
      // （首轮实测：收场断言恒败，菜单悬到下一段才被下一击顺手收掉）。
      const dismissAt = async (pt, button) => {
        if (!pt) { rep.fail('菜单收场前置失败：分区空白落点取矩形失败（文档区无可视条目）'); return null; }
        const hit = await ensurePanelHit(pt, hwnd);
        if (!hit.ok) return null;
        const t0 = Date.now();
        w32.clickPhys(pt.x, pt.y, button || 'left');
        return waitEvent('desktop-menu-closed', (e) => e.t >= t0 && e.reason === 'outside', 4000);
      };
      const outPtM = { x: rectM.left + Math.round((DOC_ZONE_RIGHT_DIP + 100) * f), y: rectM.top + Math.round(600 * f) };

      // a. 夹具：文档区探针 docx 保证「全选=池内全部」的名单断言不依赖用户桌面内容
      const t23 = Date.now();
      const probe23 = `DECK23-DOC-${t23}.docx`;
      const probe23Path = path.join(seedScan.user, probe23);
      try {
        fs.writeFileSync(probe23Path, 'probe');
        const joined23 = await waitEvent('desktop-rendered', (e) => (e.names || []).includes(probe23), 8000);
        joined23 || rep.fail(`菜单文档探针未入池（${probe23}）`);
        const settledM = await waitStable('desktop-rendered', 1500, 8000);
        const docRectsM = ((settledM && settledM.rects) || []).filter((r) => r.zone === 'doc' && r.rect).map((r) => ({ name: r.name, ...r.rect }));
        const topDocM = docRectsM.slice().sort((a, b) => a.y - b.y || a.x - b.x)[0] || null;
        const poolNames = (settledM && settledM.names) || [];
        if (!topDocM || !poolNames.length) {
          rep.fail(`菜单用例几何前置缺失：doc=${docRectsM.length} 顶条=${JSON.stringify(topDocM && { name: topDocM.name, rect: { x: topDocM.x, y: topDocM.y, w: topDocM.w, h: topDocM.h } })} pool=${poolNames.length}`);
          return;
        }
        refreshBlank(); // 门禁后的首次落点；此后各处开层/收场前由 openMenuAt/refreshBlank 现取
        // shell 以 cordis 插件装载的前置证据：随快照插件清单装载（plugin-mounted 在档）
        lastEvent('plugin-mounted', (e) => e.id === 'context-menu')
          ? rep.pass('菜单以 cordis 插件装载：plugin-mounted（id=context-menu，随插件清单）在档')
          : rep.fail('菜单插件未装载：plugin-mounted（id=context-menu）自启动起未见');

        // b. 条目右键不弹（后续工单接管）：随工单24 单项菜单落地退役——条目右键
        //    现弹三动作单项菜单，用例移步 P5.10（右键条目原语与断言在那里）。

        // c. 右键分区空白弹菜单：开层存证（x/y=右键落点 + 两内置项 + 行矩形）+ 热区换全窗
        const sess = await openMenuAt('菜单打开');
        if (!sess) {
          rep.fail('分区空白右键未弹菜单（desktop-menu-opened 未见）');
        } else {
          const { t0, opened } = sess;
          sameNamesM(opened.items, ['paste', 'select-all', 'reset-layout']) && (opened.rows || []).length === 3
            ? rep.pass(`空白右键弹菜单：条目集=[${(opened.items || []).join(', ')}]，行矩形随开层存证`)
            : rep.fail(`开层存证条目集异常：${JSON.stringify({ items: opened.items, rows: opened.rows })}`);
          typeof opened.x === 'number' && Math.abs(opened.x - blankDip.x) < 2 && Math.abs(opened.y - blankDip.y) < 2
            ? rep.pass(`菜单在光标处弹出：开层原点 (${Math.round(opened.x)}, ${Math.round(opened.y)}) = 右键落点`)
            : rep.fail(`开层原点异常：(${opened.x}, ${opened.y}) ≠ 落点 (${blankDip.x}, ${blankDip.y})`);
          const lastZones = readEvents().filter((e) => e.type === 'hotzones' && e.t >= t0).pop();
          const menuRects = (lastZones && lastZones.rects) || [];
          const menuZone = menuRects.find((r) => r.id === 'menu');
          const panelW = (rectM.right - rectM.left) / f;
          const panelH = (rectM.bottom - rectM.top) / f;
          menuRects.length === 1 && menuZone && menuZone.w >= panelW * 0.95 && menuZone.h >= panelH * 0.95
            ? rep.pass(`开层期间热区换全窗：hotzones=[menu ${Math.round(menuZone.w)}x${Math.round(menuZone.h)}]（面板 ${Math.round(panelW)}x${Math.round(panelH)}）`)
            : rep.fail(`开层热区异常：${JSON.stringify(menuRects)}`);
          safeShot('23-menu-open');
          // 收场再进下一段：菜单开着时全窗热区承接任何一击（外按收起+吞没），d 的
          // 预置单击必须落在菜单已收的正常现场（首轮实测：忘收场则预置单击被吞）。
          const closedC = await dismissAt(outPtM);
          closedC || rep.fail('菜单打开用例收场失败（outside 一击未收起）');
        }

        // d. 菜单外一击即收且无副作用，三式各证一题（预置单选全程挂着当哨兵）：
        //   ① 空档收起（分区热区外的面板内空档）——收得到这一击 = 全窗热区承接「含热区外」，
        //      随后热区恢复原状；
        //   ② 分区空白左键收起——尾随 click 撞分区空白清空监听，吞没机制的正宗考题：
        //      收起但无 desktop-selection-cleared（复审修正后的消费制吞没）；
        //   ③ 分区空白右键收起——尾随 contextmenu 不复弹菜单（无第二个 desktop-menu-opened）。
        {
          const tSelM = Date.now();
          const topLive = liveTopDocRect(); // 预置单选的哨兵现取（顶排会随后台频次换位）
          const ptItem = topLive && ptOfM(topLive.rect);
          const hitPre = ptItem && await ensurePanelHit(ptItem, hwnd);
          if (!ptItem) {
            rep.fail('菜单外一击用例前置失败：预置单选取矩形失败（文档区无可视条目）');
          } else if (!hitPre.ok) {
            rep.fail(`菜单外一击用例前置失败：${hitPre.why}`);
          } else {
            w32.clickPhys(ptItem.x, ptItem.y, 'left');
            const selPre = await waitEvent('desktop-selected', (e) => e.t >= tSelM && e.name === topLive.name, 4000);
            selPre || rep.fail('菜单外一击用例前置（预置单选）未达成');

            // ① 空档收起 + 热区恢复
            const sessD1 = selPre && await openMenuAt('菜单-空档收起');
            if (!sessD1) {
              rep.fail('菜单外一击用例开层失败（desktop-menu-opened 未见）');
            } else {
              const tD1 = Date.now();
              const closedD1 = await dismissAt(outPtM);
              closedD1
                ? rep.pass('菜单外一击即收（reason=outside；点位在分区热区外的面板空档，收得到即全窗承接）')
                : rep.fail('菜单外一击未收起（desktop-menu-closed outside 未见）');
              const after = readEvents().filter((e) => e.type === 'hotzones' && e.t >= tD1).pop();
              const rectsAfter = (after && after.rects) || [];
              !rectsAfter.some((r) => r.id === 'menu') && rectsAfter.some((r) => r.id === 'doc-zone')
                ? rep.pass(`收起后热区恢复原状：[${rectsAfter.map((r) => r.id).join(', ')}]，menu 全窗矩形退场`)
                : rep.fail(`收起后热区异常：${JSON.stringify(rectsAfter.map((r) => r.id))}`);

              // ② 分区空白左键收起：尾随 click 不许泄漏成空白清空
              const sessD2 = await openMenuAt('菜单-空白左键收起');
              if (!sessD2) {
                rep.fail('分区左键收起用例开层失败（desktop-menu-opened 未见）');
              } else {
                const tD2 = Date.now();
                const closedD2 = await dismissAt(refreshBlank() && ptBlank);
                closedD2 || rep.fail('分区空白左键未收起（desktop-menu-closed outside 未见）');
                const leaked = await waitEvent('desktop-selection-cleared', (e) => e.t >= tD2, 1500);
                !leaked
                  ? rep.pass('分区空白左键收起：尾随 click 被吞没，预置单选原样（无 desktop-selection-cleared）')
                  : rep.fail(`外击泄漏成空白清空：${JSON.stringify(leaked)}`);

                // ③ 分区空白右键收起：尾随 contextmenu 不复弹
                const sessD3 = await openMenuAt('菜单-空白右键收起');
                if (!sessD3) {
                  rep.fail('分区右键收起用例开层失败（desktop-menu-opened 未见）');
                } else {
                  const tD3 = Date.now();
                  const closedD3 = await dismissAt(refreshBlank() && ptBlank, 'right');
                  closedD3 || rep.fail('分区空白右键未收起（desktop-menu-closed outside 未见）');
                  const reopened = await waitEvent('desktop-menu-opened', (e) => e.t >= tD3, 1500);
                  !reopened
                    ? rep.pass('分区空白右键收起：尾随 contextmenu 被吞没，菜单不立刻复弹')
                    : rep.fail('右键收起复弹菜单（contextmenu 未被吞没）');
                }
              }
            }
          }
        }

        // e. 全选动作：空白单击清掉 d 的预置单选 → 开菜单点 SELECT ALL 行 →
        //    desktop-selection-all 名单 = 池内全部；指纹翻转重建后 sel 仍为全选名单
        {
          await dismissAt(outPtM); // 上一段若有残留开层先收掉（此击才不会真落进分区）
          const hitClear = refreshBlank() && await ensurePanelHit(ptBlank, hwnd);
          if (hitClear && hitClear.ok) w32.clickPhys(ptBlank.x, ptBlank.y, 'left');
          await sleep(400); // 空白清空（既有语义），不强制断言——d 段已证吞没
          const sessE = await openMenuAt('菜单-全选');
          if (!sessE) {
            rep.fail('全选用例开层失败（desktop-menu-opened 未见）');
          } else {
            const rowE = (sessE.opened.rows || []).find((r) => r.id === 'select-all');
            if (!rowE) {
              rep.fail(`全选用例开层存证缺行矩形：${JSON.stringify(sessE.opened.rows || null)}`);
            } else {
              const rowPt = { x: rectM.left + Math.round((rowE.x + rowE.w / 2) * f), y: rectM.top + Math.round((rowE.y + rowE.h / 2) * f) };
              const hitRow = await ensurePanelHit(rowPt, hwnd);
              if (!hitRow.ok) {
                rep.fail(`全选行点击前置失败：${hitRow.why}`);
              } else {
                const tE = Date.now();
                w32.clickPhys(rowPt.x, rowPt.y, 'left');
                const all = await waitEvent('desktop-selection-all', (e) => e.t >= tE, 4000);
                all && sameNamesM(all.names, poolNames)
                  ? rep.pass(`全选动作（选区状态机 select-all）：desktop-selection-all ${poolNames.length} 条 = 池内全部条目`)
                  : rep.fail(`全选存证异常：${JSON.stringify(all && all.names)}（期望池内全部 ${poolNames.length} 条）`);
                const closedE = await waitEvent('desktop-menu-closed', (e) => e.t >= tE && e.reason === 'action', 4000);
                closedE
                  ? rep.pass('菜单动作执行后即收（reason=action）')
                  : rep.fail('全选动作后菜单未收起');
                const fut23 = new Date(Date.now() + 5000);
                fs.utimesSync(probe23Path, fut23, fut23);
                const rebuilt = await waitEvent('desktop-rendered', (e) => e.t >= tE && sameNamesM(e.sel, poolNames), 8000);
                rebuilt
                  ? rep.pass('全选入渲染态：指纹翻转重建后 desktop-rendered.sel=全选名单（快照重建不丢）')
                  : rep.fail('重建后 desktop-rendered.sel 与全选名单不符');
                safeShot('23-menu-select-all');
              }
            }
          }
        }

        // f. 恢复出厂布局动作：清掉全选 → 开菜单点 RESET LAYOUT 行 → 06 契约同链路存证
        {
          await dismissAt(outPtM); // e 若中途失败有残留开层，先收掉
          const hitClear2 = refreshBlank() && await ensurePanelHit(ptBlank, hwnd);
          if (hitClear2 && hitClear2.ok) w32.clickPhys(ptBlank.x, ptBlank.y, 'left');
          await sleep(400);
          const sessF = await openMenuAt('菜单-恢复出厂');
          if (!sessF) {
            rep.fail('恢复出厂用例开层失败（desktop-menu-opened 未见）');
          } else {
            const rowF = (sessF.opened.rows || []).find((r) => r.id === 'reset-layout');
            if (!rowF) {
              rep.fail(`恢复出厂用例开层存证缺行矩形：${JSON.stringify(sessF.opened.rows || null)}`);
            } else {
              const rowPt = { x: rectM.left + Math.round((rowF.x + rowF.w / 2) * f), y: rectM.top + Math.round((rowF.y + rowF.h / 2) * f) };
              const hitRow = await ensurePanelHit(rowPt, hwnd);
              if (!hitRow.ok) {
                rep.fail(`恢复出厂行点击前置失败：${hitRow.why}`);
              } else {
                const tF = Date.now();
                w32.clickPhys(rowPt.x, rowPt.y, 'left');
                const clickedF = await waitEvent('desktop-reset-clicked', (e) => e.t >= tF && e.from === 'ctx-menu', 4000);
                const resetF = await waitEvent('desktop-layout-reset', (e) => e.t >= tF && e.ok === true, 6000);
                const closedF = await waitEvent('desktop-menu-closed', (e) => e.t >= tF && e.reason === 'action', 4000);
                clickedF && resetF && closedF
                  ? rep.pass(`恢复出厂布局动作（06 契约复用）：desktop-reset-clicked(from=ctx-menu) → desktop-layout-reset ok=true cleared=${resetF.cleared}，菜单随动作收起`)
                  : rep.fail(`恢复出厂存证异常：clicked=${JSON.stringify(clickedF)} reset=${JSON.stringify(resetF)} closed=${JSON.stringify(closedF)}`);
                safeShot('23-menu-reset-layout');
              }
            }
          }
        }

        // g. 随插件清单热插拔：移除插件目录即卸载（右键空转、无存证），放回即恢复。
        //    与工单10 样例插件同法，但对象是内置根里的菜单本体——「cordis 插件形态」的实证。
        {
          const MENU_DIR = path.join(APP_ROOT, 'dist', 'renderer', 'cards', 'context-menu');
          const MENU_BAK = path.join(APP_ROOT, 'dist', 'renderer', `context-menu-deck23-bak-${t23}`);
          try {
            if (!fs.existsSync(MENU_DIR)) {
              rep.fail('热插拔用例前置失败：内置菜单插件目录缺失');
              return;
            }
            fs.renameSync(MENU_DIR, MENU_BAK);
            const goneList = await waitEvent('plugins-changed', (e) => !(e.ids || []).includes('context-menu'), 15000);
            goneList || rep.fail('热插拔卸载未生效：plugins-changed 未摘除 context-menu');
            const openedGone = await openMenuAt('热插拔-卸载后右键');
            !openedGone
              ? rep.pass('插件卸载即失效：移除插件目录后右键分区空白不再弹菜单（面板触发 ?. 空转）')
              : rep.fail('热插拔卸载未生效：目录已移除仍弹出菜单');
            fs.renameSync(MENU_BAK, MENU_DIR);
            const backList = await waitEvent('plugins-changed', (e) => (e.ids || []).includes('context-menu'), 15000);
            const backMounted = await waitEvent('plugin-mounted', (e) => e.id === 'context-menu' && e.t >= (goneList ? goneList.t : t23), 15000);
            if (!backList || !backMounted) {
              rep.fail(`热插拔重装未生效：plugins-changed=${Boolean(backList)} plugin-mounted=${Boolean(backMounted)}`);
              return;
            }
            const backOpen = await openMenuAt('热插拔-重装后右键');
            backOpen
              ? rep.pass('插件重装即恢复：目录放回后右键再弹菜单（随清单热插拔全链路，未重启面板）')
              : rep.fail('热插拔重装未生效：菜单未恢复');
            const closedG = backOpen && await dismissAt(outPtM);
            (backOpen && closedG) || rep.note('热插拔收场：菜单未关干净（后续段不受影响——下一击自会收起）');
          } finally {
            if (!fs.existsSync(MENU_DIR) && fs.existsSync(MENU_BAK)) {
              try {
                fs.renameSync(MENU_BAK, MENU_DIR);
                rep.note('热插拔清场：菜单插件目录已还原');
              } catch (e) {
                rep.note(`热插拔清场失败: ${e && e.message}`);
              }
            } else if (fs.existsSync(MENU_BAK)) {
              try { fs.rmSync(MENU_BAK, { recursive: true, force: true }); } catch { /* 尽力 */ }
            }
          }
        }
      } finally {
        try { fs.unlinkSync(probe23Path); } catch { /* 尽力清理 */ }
      }
      w32.moveMousePhys(safePt.x, safePt.y);
    })();

    // —— P5.10 工单24 单项菜单：右键单个桌面项弹动作菜单（打开/打开所在位置/复制路径，
    // 工单29 起附【复制】【剪切】文件级写向第 4/5 行、工单28 重命名、工单27 删除。
    // 工单59：手钉管理两行随 dock 退役，条目集定格为七行。
    // 弹/切裁决（非选中条目先切单选、选中集内条目走多选菜单）在离线测试（tests/renderer/
    // selection.spec.ts itemMenuPlan）；reveal/copy-path 的扫描池护栏在离线内核测试
    // （desktop service spec + 契约 spec）。这里留真机端到端代表用例（#19 三缝约定）：
    // 右键切换选区后开层、打开=双击同款启动（探针标记文件实证）、定位弹资源管理器窗、
    // 复制路径剪贴板实读、单选态右键不重复发选区存证。（原「选中集内条目右键不弹」
    // 随工单26 多选菜单落地退役——现弹两行动作菜单，端到端用例移步 P5.12。）
    rep.beginSegment('P5.10');
    await (async () => {
      const rect24 = w32.rectOf(hwnd);
      const savedClip24 = clipboardGet();
      const sameNames24 = (a, b) => (a || []).join() === b.join();
      let probe24Name = null;
      let probe24Path = null;
      let doc24Path = null;
      let marker24Path = null;
      try {
        // 夹具：应用类探针 bat（「打开」有行为级实证——目标进程写标记文件，双击启动用例同法；
        // 工单59 后面板只渲染文档区，.bat 归 other 组落文档区，故右键原语取它）
        // + 文档区探针 docx（保「池内不止一条」，用例不依赖用户桌面内容）
        const t24 = Date.now();
        probe24Name = `DECK24-BAT-${t24}.bat`;
        probe24Path = path.join(seedScan.user, probe24Name);
        doc24Path = path.join(seedScan.user, `DECK24-DOC-${t24}.docx`);
        marker24Path = path.join(os.tmpdir(), `deck24-marker-${t24}.txt`);
        createProbeBat(probe24Path, marker24Path);
        fs.writeFileSync(doc24Path, 'probe');
        deckProbeFiles.push(probe24Path, doc24Path);
        const joined24 = await waitEvent('desktop-rendered', (e) => (e.names || []).includes(probe24Name), 8000);
        joined24 || rep.fail(`单项菜单探针未入池（${probe24Name}）`);
        const settled24 = await waitStable('desktop-rendered', 1500, 8000);
        const probeRect = settled24 && (settled24.rects || []).find((r) => r.name === probe24Name && r.rect);
        if (!probeRect) {
          rep.fail(`单项菜单用例几何前置缺失：探针 ${probe24Name} 无矩形`);
          return;
        }
        // 右键落点现取（工单59 真机首跑教训）：打开动作入使用频次后编排重排，旧矩形隔几秒
        // 再右键就点错条目 = 假败；本段三次右键（a/c/d）跨越数十秒，逐次现取
        const ptProbeNow = () => {
          const r = liveItemRect(probe24Name);
          return r ? {
            x: rect24.left + Math.round((r.rect.x + r.rect.w / 2) * f),
            y: rect24.top + Math.round((r.rect.y + r.rect.h / 2) * f),
          } : null;
        };
        // 右键条目原语：返回 { t0, opened }（opened 含 x/y 与行矩形），未弹返回 null
        const openItemMenuAt = async (label) => {
          const pt = ptProbeNow();
          if (!pt) { rep.fail(`${label}前置失败：探针 ${probe24Name} 取矩形失败（不在最新渲染里）`); return null; }
          const hit = await ensurePanelHit(pt, hwnd);
          if (!hit.ok) { rep.fail(`${label}前置失败：${hit.why}`); return null; }
          const t0 = Date.now();
          w32.clickPhys(pt.x, pt.y, 'right');
          const opened = await waitEvent('desktop-menu-opened', (e) => e.t >= t0, 4000);
          return opened ? { t0, opened } : null;
        };
        // 菜单行点击原语（按 id 定位行矩形；返回点击时刻，行缺失返回 null）
        const clickRow24 = (rows, id) => {
          const row = (rows || []).find((r) => r.id === id);
          if (!row) return null;
          const pt = {
            x: rect24.left + Math.round((row.x + row.w / 2) * f),
            y: rect24.top + Math.round((row.y + row.h / 2) * f),
          };
          w32.clickPhys(pt.x, pt.y, 'left');
          return Date.now();
        };
        const outPt24 = {
          x: rect24.left + Math.round((DOC_ZONE_RIGHT_DIP + 100) * f),
          y: rect24.top + Math.round(600 * f),
        };

        // a. 右键非选中条目：desktop-selected（选区先切为该条）→ 三动作菜单开层
        const sessA = await openItemMenuAt('单项菜单-右键条目');
        if (!sessA) {
          rep.fail('条目右键未弹单项菜单（desktop-menu-opened 未见）');
          return;
        }
        const selA = await waitEvent('desktop-selected', (e) => e.t >= sessA.t0 && e.name === probe24Name, 4000);
        selA && sameNames24(selA.names, [probe24Name]) && selA.t <= sessA.opened.t
          ? rep.pass('右键非选中条目：选区先切为该条（desktop-selected names=[探针]，先于开层存证）再弹菜单')
          : rep.fail(`右键切换选区存证异常：${JSON.stringify(selA)}`);
        sameNames24(sessA.opened.items, ['open', 'reveal', 'copy-path', 'copy', 'cut', 'rename', 'delete']) && (sessA.opened.rows || []).length === 7
          ? rep.pass(`单项菜单条目集=[${(sessA.opened.items || []).join(', ')}]，七行矩形随开层存证（第 4/5 行=复制/剪切文件级写向，工单29；第 6 行=重命名，工单28；第 7 行=删除，工单27；工单59 起无手钉管理行）`)
          : rep.fail(`单项菜单开层条目集异常：${JSON.stringify({ items: sessA.opened.items, rows: sessA.opened.rows })}`);
        safeShot('24-item-menu-open', { left: rect24.left, top: rect24.top, right: rect24.right, bottom: rect24.bottom });

        // b. 打开动作 = 双击同款启动：desktop/launch 同链路存证 + 探针标记文件行为级实证
        {
          const tB = clickRow24(sessA.opened.rows, 'open');
          if (!tB) {
            rep.fail('打开用例开层存证缺 open 行矩形');
          } else {
            const closedB = await waitEvent('desktop-menu-closed', (e) => e.t >= tB && e.reason === 'action', 4000);
            const clickedB = await waitEvent('desktop-launch-clicked', (e) => e.t >= tB && e.name === probe24Name && e.via === 'ctx-menu', 4000);
            const launchedB = await waitEvent('desktop-launched', (e) => e.t >= tB && e.name === probe24Name && e.ok, 6000);
            let markerOk = false;
            const markerDeadline = Date.now() + 20000;
            while (Date.now() < markerDeadline && !markerOk) {
              try { markerOk = fs.readFileSync(marker24Path, 'utf8').trim() === 'ok'; } catch { markerOk = false; }
              if (!markerOk) await sleep(250);
            }
            closedB && clickedB && launchedB && markerOk
              ? rep.pass('打开动作（菜单行 → desktop/launch）：via=ctx-menu 存证 + 菜单随动作收起 + 探针目标进程写标记文件（双击同款启动）')
              : rep.fail(`打开动作存证异常：closed=${JSON.stringify(closedB)} clicked=${JSON.stringify(clickedB)} launched=${JSON.stringify(launchedB)} marker=${markerOk}`);
            safeShot('24-item-open-launched');
            // 打开动作入使用频次后编排可能重排：c/d/e 的右键落点改由 ptProbeNow() 现取
            // （原本此处只重取一次，c/d 两段仍可能落在重排前的坐标上）
          }
        }

        // c. 打开所在位置（此刻探针已是单选态——顺带证单选右键）：desktop/reveal 存证 +
        //    资源管理器窗弹出（新 CabinetWClass）；单选态右键不重复发 desktop-selected
        {
          const sessC = await openItemMenuAt('单项菜单-打开所在位置');
          if (!sessC) {
            rep.fail('打开所在位置用例开层失败（desktop-menu-opened 未见）');
          } else {
            const dupSel = readEvents().some((e) => e.type === 'desktop-selected' && e.t >= sessC.t0 && e.t <= sessC.opened.t);
            !dupSel
              ? rep.pass('单选态右键：选区已是该条，不重复发 desktop-selected（直接弹菜单）')
              : rep.fail('单选态右键重复发 desktop-selected（选区被无谓重置）');
            const explorerBefore = new Set(win32.topLevelWindows().filter((h) => win32.className(h) === 'CabinetWClass'));
            const tC = clickRow24(sessC.opened.rows, 'reveal');
            if (!tC) {
              rep.fail('打开所在位置用例开层存证缺 reveal 行矩形');
            } else {
              const clickedC = await waitEvent('desktop-reveal-clicked', (e) => e.t >= tC && e.name === probe24Name, 4000);
              const revealedC = await waitEvent('desktop-revealed', (e) => e.t >= tC && e.ok === true, 6000);
              let revealWin = null;
              const revealDeadline = Date.now() + 10000;
              while (Date.now() < revealDeadline && !revealWin) {
                await sleep(250);
                revealWin = win32.topLevelWindows().find((h) => win32.className(h) === 'CabinetWClass' && !explorerBefore.has(h)) || null;
              }
              clickedC && revealedC && revealWin
                ? rep.pass('打开所在位置动作（desktop/reveal）：ok=true 存证 + 资源管理器窗弹出（新 CabinetWClass）')
                : rep.fail(`打开所在位置存证异常：clicked=${JSON.stringify(clickedC)} revealed=${JSON.stringify(revealedC)} explorer=${revealWin ? '新窗' : '未弹出'}`);
              safeShot('24-item-reveal-explorer');
              if (revealWin) {
                w32.PostMessageW(revealWin, WM_CLOSE, 0, 0);
                await sleep(800);
              }
            }
          }
        }

        // d. 复制路径：desktop/copy-path 存证 + 剪贴板实读 = 完整路径（粘贴可用）
        {
          const sessD = await openItemMenuAt('单项菜单-复制路径');
          if (!sessD) {
            rep.fail('复制路径用例开层失败（desktop-menu-opened 未见）');
          } else {
            const tD = clickRow24(sessD.opened.rows, 'copy-path');
            if (!tD) {
              rep.fail('复制路径用例开层存证缺 copy-path 行矩形');
            } else {
              const clickedD = await waitEvent('desktop-path-copy-clicked', (e) => e.t >= tD && e.name === probe24Name, 4000);
              const copiedD = await waitEvent('desktop-path-copied', (e) => e.t >= tD && e.ok === true, 4000);
              let clip = '';
              const clipDeadline = Date.now() + 8000;
              while (Date.now() < clipDeadline) {
                clip = clipboardGet() || '';
                if (clip.trim() === probe24Path) break;
                await sleep(300);
              }
              clickedD && copiedD && clip.trim() === probe24Path
                ? rep.pass('复制路径动作（desktop/copy-path）：ok=true 存证 + 剪贴板实读 = 完整路径（粘贴可用）')
                : rep.fail(`复制路径存证异常：clicked=${JSON.stringify(clickedD)} copied=${JSON.stringify(copiedD)} 剪贴板=${JSON.stringify(clip.trim())}`);
              safeShot('24-item-copy-path');
            }
          }
        }

        // e.（原「选中集内条目右键不弹」占位用例随工单26 退役：现弹多选菜单，
        //    端到端断言移步 P5.12——条目集收敛、选区不动、打开全部与多行复制路径）
      } finally {
        for (const p of [probe24Path, doc24Path, marker24Path]) {
          try { if (p) fs.unlinkSync(p); } catch { /* 尽力清理 */ }
        }
        clipboardSet(savedClip24); // 电池不得改变用户剪贴板内容（07 搜索段同法）
      }
      if (probe24Name) {
        const gone24 = await waitEvent('desktop-rendered', (e) => !(e.names || []).includes(probe24Name), 6000);
        gone24
          ? rep.pass('清理单项菜单探针后条目同步消失（面板与磁盘一致）')
          : rep.fail('单项菜单探针清理后未消失');
      }
      w32.moveMousePhys(safePt.x, safePt.y);
    })();

    // —— P5.11 工单25 手钉管理菜单随工单59 整段退役：桌面侧 desktop/pin、
    //    desktop/unpin 与 layout.json 的 pinned 名单一并移除，手钉改由任务栏左组
    //    承担。契约与栏位语义在离线内核测试（desktop service spec + 契约 spec）
    //    另有覆盖；这里不再留真机端到端用例（原证手钉往返 + dock 前段承载）。


    // —— P5.12 工单26 多选菜单与右键选区语义：选区多于一条且右键命中选中集内条目时，
    // 菜单作用于整个选区、条目集收敛为【打开全部 / 复制路径（多行）/ 复制 / 剪切（工单29）/
    // 删除全部（工单27）】；右键非选中条目仍走单项菜单（先切单选）。弹/切裁决矩阵在离线测试
    // （selection.spec.ts itemMenuPlan），多行拼接与整份拒绝护栏在离线内核测试（desktop
    // service spec + 契约 spec）。这里留真机端到端代表用例（#19 三缝约定）：Ctrl 点选两条 →
    // 右键集内条目弹动作菜单（无选区副作用）→ 打开全部逐项启动（存证按选区插入序 + 探针
    // 标记双落盘）→ 多选复制路径剪贴板实读两行（\n 分隔、行序同选区）→ 右键集外条目仍
    // 单项菜单（#24 回归）。
    rep.beginSegment('P5.12');
    await (async () => {
      const rect26 = w32.rectOf(hwnd);
      const savedClip26 = clipboardGet();
      const sameNames26 = (a, b) => (a || []).join() === b.join();
      let probeA26Path = null;
      let probeB26Path = null;
      let doc26Path = null;
      let markerA26Path = null;
      let markerB26Path = null;
      try {
        // 夹具：两条应用类探针 bat（打开全部的行为级实证——目标进程各写标记文件，P5.6 双击全开
        // 同法；工单59 后面板只渲染文档区，.bat 归 other 组落文档区）
        // + 文档区探针 docx（选区外第三条，集外右键回归用例）
        const t26 = Date.now();
        const probeA26 = `DECK26-BAT-${t26}-A.bat`;
        const probeB26 = `DECK26-BAT-${t26}-B.bat`;
        const doc26Name = `DECK26-DOC-${t26}.docx`;
        probeA26Path = path.join(seedScan.user, probeA26);
        probeB26Path = path.join(seedScan.user, probeB26);
        doc26Path = path.join(seedScan.user, doc26Name);
        markerA26Path = path.join(os.tmpdir(), `deck26-marker-${t26}-A.txt`);
        markerB26Path = path.join(os.tmpdir(), `deck26-marker-${t26}-B.txt`);
        createProbeBat(probeA26Path, markerA26Path);
        createProbeBat(probeB26Path, markerB26Path);
        fs.writeFileSync(doc26Path, 'probe');
        deckProbeFiles.push(probeA26Path, probeB26Path, doc26Path);
        const joined26 = await waitEvent('desktop-rendered', (e) => (e.names || []).includes(probeA26)
          && (e.names || []).includes(probeB26) && (e.names || []).includes(doc26Name), 8000);
        joined26 || rep.fail(`多选菜单探针未入池（${probeA26}/${probeB26}/${doc26Name}）`);
        const settled26 = await waitStable('desktop-rendered', 1500, 8000);
        const rA26 = settled26 && (settled26.rects || []).find((r) => r.name === probeA26 && r.rect);
        const rB26 = settled26 && (settled26.rects || []).find((r) => r.name === probeB26 && r.rect);
        const rDoc26 = settled26 && (settled26.rects || []).find((r) => r.name === doc26Name && r.rect);
        if (!rA26 || !rB26 || !rDoc26) {
          rep.fail(`多选菜单用例几何前置缺失：A=${JSON.stringify(rA26 && rA26.rect)} B=${JSON.stringify(rB26 && rB26.rect)} doc=${JSON.stringify(rDoc26 && rDoc26.rect)}`);
          return;
        }
        const ptOf26 = (r) => ({ x: rect26.left + Math.round((r.rect.x + r.rect.w / 2) * f), y: rect26.top + Math.round((r.rect.y + r.rect.h / 2) * f) });
        // 落点现取（工单59 真机首跑教训）：打开全部入使用频次后编排重排，早先快照的矩形隔几秒
        // 再点就点空（右键点错条目 = 假败）。点选 A / Ctrl 补选 B / 两次集内右键 / 集外右键 /
        // 清场 Ctrl，各处现取
        const ptItem26 = (name) => {
          const r = liveItemRect(name);
          return r ? ptOf26(r) : null;
        };
        const ctrlClick26 = async (pt, label) => {
          if (!pt) { rep.fail(`${label}前置失败：落点取矩形失败（条目不在最新渲染里）`); return false; }
          const hit = await ensurePanelHit(pt, hwnd);
          if (!hit.ok) { rep.fail(`${label}前置失败：${hit.why}`); return false; }
          w32.send([w32.keyInput(VK_CONTROL, w32.KEYDOWN)]);
          await sleep(60);
          w32.clickPhys(pt.x, pt.y, 'left');
          await sleep(60);
          w32.send([w32.keyInput(VK_CONTROL, w32.KEYUP)]);
          return true;
        };
        // 右键/行点击原语（P5.10/11 同款）
        const rightClick26 = async (pt, label) => {
          if (!pt) { rep.fail(`${label}前置失败：落点取矩形失败（条目不在最新渲染里）`); return null; }
          const hit = await ensurePanelHit(pt, hwnd);
          if (!hit.ok) { rep.fail(`${label}前置失败：${hit.why}`); return null; }
          const t0 = Date.now();
          w32.clickPhys(pt.x, pt.y, 'right');
          const opened = await waitEvent('desktop-menu-opened', (e) => e.t >= t0, 4000);
          return opened ? { t0, opened } : null;
        };
        const clickRow26 = (rows, id) => {
          const row = (rows || []).find((r) => r.id === id);
          if (!row) return null;
          const pt = { x: rect26.left + Math.round((row.x + row.w / 2) * f), y: rect26.top + Math.round((row.y + row.h / 2) * f) };
          w32.clickPhys(pt.x, pt.y, 'left');
          return Date.now();
        };

        // 前置：点选 A + Ctrl 补选 B → 选中集 [A, B]（插入序 = 逐项启动顺序）
        const ptA26 = ptItem26(probeA26);
        if (!ptA26) { rep.fail(`多选菜单选区前置失败：探针 ${probeA26} 取矩形失败（不在最新渲染里）`); return; }
        const hitA26 = await ensurePanelHit(ptA26, hwnd);
        if (!hitA26.ok) { rep.fail(`多选菜单选区前置失败：${hitA26.why}`); return; }
        const tSel26 = Date.now();
        w32.clickPhys(ptA26.x, ptA26.y, 'left');
        const selA26 = await waitEvent('desktop-selected', (e) => e.t >= tSel26 && e.name === probeA26 && sameNames26(e.names, [probeA26]), 4000);
        const okCtrl26 = selA26 && await ctrlClick26(ptItem26(probeB26), '多选菜单-Ctrl 补选');
        const two26 = okCtrl26 && await waitEvent('desktop-selection-toggled', (e) => e.t >= tSel26 && e.selected === true && sameNames26(e.names, [probeA26, probeB26]), 4000);
        if (!two26) {
          rep.fail('多选菜单用例前置（选中集两条）未达成');
          return;
        }

        // a. 右键选中集内条目：弹多选菜单（条目集收敛为 open-all/copy-path 两行），
        //    选区不动（desktop-selected/toggled/cleared 无一副作用）
        const sessA26 = await rightClick26(ptItem26(probeA26), '多选菜单-集内右键');
        if (!sessA26) {
          rep.fail('选中集内条目右键未弹多选菜单（desktop-menu-opened 未见）');
          return;
        }
        sameNames26(sessA26.opened.items, ['open-all', 'copy-path', 'copy', 'cut', 'delete-all']) && (sessA26.opened.rows || []).length === 5
          ? rep.pass(`右键选中集内条目弹多选菜单：条目集=[${(sessA26.opened.items || []).join(', ')}] 五行矩形随开层存证（菜单作用于整集；复制/剪切=工单29，删除全部=工单27）`)
          : rep.fail(`多选菜单条目集异常：${JSON.stringify({ items: sessA26.opened.items, rows: sessA26.opened.rows })}`);
        const sideEffect26 = readEvents().find((e) => e.t >= sessA26.t0 && e.t <= sessA26.opened.t
          && (e.type === 'desktop-selected' || e.type === 'desktop-selection-toggled' || e.type === 'desktop-selection-cleared'));
        !sideEffect26
          ? rep.pass('多选菜单开层无选区副作用：desktop-selected/toggled/cleared 均未见（选区保持两条）')
          : rep.fail(`多选菜单开层选区被改动：${JSON.stringify(sideEffect26)}`);
        safeShot('26-multi-menu-open', { left: rect26.left, top: rect26.top, right: rect26.right, bottom: rect26.bottom });

        // b. 打开全部 = 整集逐项启动：desktop-launch-clicked 按选区插入序 [A, B]（via=ctx-menu）
        //    + desktop-launched 双 ok + 探针标记双落盘（行为级）
        {
          const tB26 = clickRow26(sessA26.opened.rows, 'open-all');
          if (!tB26) {
            rep.fail('打开全部用例开层存证缺 open-all 行矩形');
          } else {
            const closedB26 = await waitEvent('desktop-menu-closed', (e) => e.t >= tB26 && e.reason === 'action', 4000);
            const clickedB26 = await waitEvent('desktop-launch-clicked', (e) => e.t >= tB26 && e.name === probeB26 && e.via === 'ctx-menu', 6000);
            const clickedOrder26 = readEvents().filter((e) => e.type === 'desktop-launch-clicked' && e.t >= tB26 && e.via === 'ctx-menu').map((e) => e.name);
            const launchedA26 = await waitEvent('desktop-launched', (e) => e.t >= tB26 && e.name === probeA26 && e.ok, 6000);
            const launchedB26 = await waitEvent('desktop-launched', (e) => e.t >= tB26 && e.name === probeB26 && e.ok, 6000);
            let markerOk26 = { A: false, B: false };
            const markerDeadline26 = Date.now() + 20000;
            while (Date.now() < markerDeadline26 && !(markerOk26.A && markerOk26.B)) {
              for (const [k, mp] of [['A', markerA26Path], ['B', markerB26Path]]) {
                if (markerOk26[k]) continue;
                try { markerOk26[k] = fs.readFileSync(mp, 'utf8').trim() === 'ok'; } catch { markerOk26[k] = false; }
              }
              if (!(markerOk26.A && markerOk26.B)) await sleep(250);
            }
            closedB26 && clickedB26 && sameNames26(clickedOrder26, [probeA26, probeB26]) && launchedA26 && launchedB26 && markerOk26.A && markerOk26.B
              ? rep.pass(`打开全部动作（菜单行 → desktop/launch 逐项）：clicked 按选区插入序 [${clickedOrder26.join(', ')}]（via=ctx-menu）+ launched 双 ok + 探针标记双落盘`)
              : rep.fail(`打开全部存证异常：closed=${JSON.stringify(closedB26)} clicked=${JSON.stringify(clickedOrder26)} launchedA=${JSON.stringify(launchedA26)} launchedB=${JSON.stringify(launchedB26)} markers=${JSON.stringify(markerOk26)}`);
            safeShot('26-open-all-launched');
            // 编排可能因频次变化重排：c 段的右键落点改由 ptItem26() 现取（原本此处只重取一次）
          }
        }

        // c. 多选复制路径：再右键集内条目（选区仍 [A, B]——b 段菜单动作不动选区）→
        //    copy-path 行 → desktop-paths-copy-clicked/copied 存证 + 剪贴板实读两行
        {
          const sessC26 = await rightClick26(ptItem26(probeA26), '多选菜单-复制路径');
          if (!sessC26) {
            rep.fail('多选复制路径用例开层失败（desktop-menu-opened 未见）');
          } else {
            sameNames26(sessC26.opened.items, ['open-all', 'copy-path', 'copy', 'cut', 'delete-all']) || rep.fail(`复制路径用例开层条目集异常（选区应仍两条）：${JSON.stringify(sessC26.opened.items)}`);
            const tC26 = clickRow26(sessC26.opened.rows, 'copy-path');
            if (!tC26) {
              rep.fail('多选复制路径用例开层存证缺 copy-path 行矩形');
            } else {
              const clickedC26 = await waitEvent('desktop-paths-copy-clicked', (e) => e.t >= tC26 && sameNames26(e.names, [probeA26, probeB26]) && e.via === 'ctx-menu', 4000);
              const copiedC26 = await waitEvent('desktop-paths-copied', (e) => e.t >= tC26 && e.ok === true && sameNames26(e.names, [probeA26, probeB26]), 6000);
              const expectClip26 = `${probeA26Path}\n${probeB26Path}`;
              // 剪贴板实读：单进程内轮询（电池负载下每轮重开 powershell 冷启 1.5-3s，
              // 8s 窗口实际只能读到 ~3 次，工单27 轮次实测三连败；27 回收站实查同法）
              const clipScript26 = path.join(__dirname, 'evidence', '26-clipboard-wait.ps1');
              fs.writeFileSync(clipScript26, [
                '$deadline = (Get-Date).AddSeconds(20)',
                "$text = ''",
                'while ((Get-Date) -lt $deadline) {',
                '  $text = [string](Get-Clipboard -Raw)',
                '  $norm = $text.Replace("`r`n", "`n").Trim()',
                '  if ($norm -eq ($args[0] + "`n" + $args[1])) { break }',
                '  Start-Sleep -Milliseconds 400',
                '}',
                'Write-Output $text',
              ].join('\n'), 'utf8');
              let clip26 = '';
              try {
                clip26 = psRunFile([clipScript26, probeA26Path, probeB26Path], 30000);
              } catch { /* 尽力：空串走下方比对判败，不阻断 */ }
              try { fs.unlinkSync(clipScript26); } catch { /* 尽力清理 */ }
              clickedC26 && copiedC26 && clip26.replace(/\r\n/g, '\n').trim() === expectClip26
                ? rep.pass('多选复制路径动作（desktop/copy-paths）：ok=true 存证 + 剪贴板实读两行 = [A 路径, B 路径]（\\n 分隔，行序同选区插入序）')
                : rep.fail(`多选复制路径存证异常：clicked=${JSON.stringify(clickedC26)} copied=${JSON.stringify(copiedC26)} 剪贴板=${JSON.stringify(clip26)}`);
              safeShot('26-multi-copy-paths');
            }
          }
        }

        // d. 右键集外条目仍走单项菜单（#24 回归）：右键 docx（非选中）→ 先切单选
        //    （desktop-selected 先于开层）→ 条目集 = 单项四动作；随后收菜单、Ctrl 点回
        //    清掉选区（电池余段回到无选区现场）
        {
          const sessD26 = await rightClick26(ptItem26(doc26Name), '多选菜单-集外右键');
          if (!sessD26) {
            rep.fail('右键集外条目未弹单项菜单（desktop-menu-opened 未见）');
          } else {
            const selD26 = await waitEvent('desktop-selected', (e) => e.t >= sessD26.t0 && e.name === doc26Name && sameNames26(e.names, [doc26Name]), 4000);
            selD26 && selD26.t <= sessD26.opened.t
              ? rep.pass('右键非选中条目仍走单项菜单：先切单选（desktop-selected names=[docx]）再弹（#24 语义回归）')
              : rep.fail(`集外右键切单选存证异常：${JSON.stringify(selD26)}`);
            sameNames26(sessD26.opened.items, ['open', 'reveal', 'copy-path', 'copy', 'cut', 'rename', 'delete'])
              ? rep.pass(`集外右键单项菜单条目集=[${(sessD26.opened.items || []).join(', ')}]（未收敛为多选动作；第 4/5 行=复制/剪切，工单29；第 6 行=重命名，工单28；第 7 行=删除，工单27）`)
              : rep.fail(`集外右键条目集异常：${JSON.stringify(sessD26.opened.items)}`);
            const outPt26 = { x: rect26.left + Math.round((DOC_ZONE_RIGHT_DIP + 100) * f), y: rect26.top + Math.round(600 * f) };
            w32.clickPhys(outPt26.x, outPt26.y, 'left'); // 开层全窗热区承接：收菜单且吞没（无选区副作用）
            await sleep(400);
            await ctrlClick26(ptItem26(doc26Name), '多选菜单-清场'); // 切换出选：选区归空
          }
        }
      } finally {
        for (const p of [probeA26Path, probeB26Path, doc26Path, markerA26Path, markerB26Path]) {
          try { if (p) fs.unlinkSync(p); } catch { /* 尽力清理 */ }
        }
        clipboardSet(savedClip26); // 电池不得改变用户剪贴板内容（07 搜索段同法）
      }
      if (probeA26Path && probeB26Path && doc26Path) {
        const gone26 = await waitEvent('desktop-rendered', (e) => !(e.names || []).includes(path.basename(probeA26Path))
          && !(e.names || []).includes(path.basename(probeB26Path)) && !(e.names || []).includes(path.basename(doc26Path)), 6000);
        gone26
          ? rep.pass('清理多选菜单探针后条目同步消失（面板与磁盘一致）')
          : rep.fail('多选菜单探针清理后未消失');
      }
      w32.moveMousePhys(safePt.x, safePt.y);
    })();

    // —— P5.13 工单27 删除与删除全部：删除=送回收站（desktop/trash 契约，回收站源经
    // 主进程代理）。单项菜单【删除】直接执行（真桌面同语义，回收站兜底误删），多选菜单
    // 【删除全部】先弹自绘轻量确认（列出条数，确认/取消）。内核侧整份池护栏、部分失败
    // 如实回报、摆位同拍清除在离线测试（layout-store / desktop service / contract spec）
    // 穷举；这里留真机端到端代表用例（#19 三缝约定）：
    // a. 单删：探针先真拖拽造显式摆位（摆位对账靶子）→ 右键 DELETE → 无确认层直进
    //    回收站（回收站实查可找回）+ layout.json docs 同拍清除（防同名复活）
    // b. 多删取消：选中两条 → DELETE ALL → 确认层开（desktop-trash-confirm-opened，
    //    按钮矩形随层存证）→ CANCEL → 条目原样、无 desktop-trash-clicked
    // c. 多删确认：再弹 → DELETE → desktop-trashed ok=true 整批名单 + 文件离盘 +
    //    条目消失 + layout.json 对账
    rep.beginSegment('P5.13');
    await (async () => {
      const rect27 = w32.rectOf(hwnd);
      const sameNames27 = (a, b) => (a || []).join() === b.join();
      let single27Path = null;
      let probeB27Path = null;
      let probeC27Path = null;
      try {
        // 夹具：单删探针 txt（真拖拽造摆位 + 删除 + 回收站实查）+ 多删探针 docx 两条
        const t27 = Date.now();
        const single27Name = `DECK27-SINGLE-${t27}.txt`;
        const docB27 = `DECK27-MULTI-${t27}-B.docx`;
        const docC27 = `DECK27-MULTI-${t27}-C.docx`;
        single27Path = path.join(seedScan.user, single27Name);
        probeB27Path = path.join(seedScan.user, docB27);
        probeC27Path = path.join(seedScan.user, docC27);
        fs.writeFileSync(single27Path, 'probe');
        fs.writeFileSync(probeB27Path, 'probe');
        fs.writeFileSync(probeC27Path, 'probe');
        deckProbeFiles.push(single27Path, probeB27Path, probeC27Path);
        const joined27 = await waitEvent('desktop-rendered', (e) => (e.names || []).includes(single27Name)
          && (e.names || []).includes(docB27) && (e.names || []).includes(docC27), 8000);
        joined27 || rep.fail(`删除用例探针未入池（${single27Name}/${docB27}/${docC27}）`);
        const settled27 = await waitStable('desktop-rendered', 1500, 8000);
        const rects27 = settled27 && (settled27.rects || []);
        const rA27 = rects27.find((r) => r.name === single27Name && r.rect);
        const rB27 = rects27.find((r) => r.name === docB27 && r.rect);
        const rC27 = rects27.find((r) => r.name === docC27 && r.rect);
        if (!rA27 || !rB27 || !rC27) {
          rep.fail(`删除用例几何前置缺失：A=${JSON.stringify(rA27 && rA27.rect)} B=${JSON.stringify(rB27 && rB27.rect)} C=${JSON.stringify(rC27 && rC27.rect)}`);
          return;
        }
        const ptOf27 = (r) => ({ x: rect27.left + Math.round((r.rect.x + r.rect.w / 2) * f), y: rect27.top + Math.round((r.rect.y + r.rect.h / 2) * f) });
        // 落点现取（工单59 真机首跑教训）：摆位/选中/右键都会改使用频次，名序随之后台落定重排，
        // 早先快照的矩形隔几秒再点就点空（点错条目 = 假败）。三条探针各处现取
        const ptItem27 = (name) => {
          const r = liveItemRect(name);
          return r ? ptOf27(r) : null;
        };
        // 真拖拽摆位原语（06/21/22 同法）：按住条目 → 步进到参照条目 → 抬键
        const dragPlace27 = async (from, to, name) => {
          if (!from || !to) { rep.fail(`摆位拖拽取矩形失败（${name} 不在最新渲染里）`); return false; }
          const hit = await ensurePanelHit(from, hwnd);
          if (!hit.ok) { rep.fail(`摆位拖拽前置失败：${hit.why}`); return false; }
          const t0 = Date.now();
          w32.send([w32.mouseInput(0, 0, w32.LEFTDOWN)]);
          const steps = 16;
          for (let s = 1; s <= steps; s++) {
            await sleep(22);
            w32.moveMousePhys(from.x + Math.round(((to.x - from.x) * s) / steps), from.y + Math.round(((to.y - from.y) * s) / steps));
          }
          await sleep(140);
          w32.send([w32.mouseInput(0, 0, w32.LEFTUP)]);
          w32.moveMousePhys(safePt.x, safePt.y);
          const moved = await waitEvent('desktop-moved', (e) => e.t >= t0 && e.name === name && e.ok === true, 6000);
          return !!moved;
        };
        // 右键/行点击/确认层钮点击原语（P5.10/12 同款；钮矩形来自开层存证）
        const rightClick27 = async (pt, label) => {
          if (!pt) { rep.fail(`${label}前置失败：落点取矩形失败（条目不在最新渲染里）`); return null; }
          const hit = await ensurePanelHit(pt, hwnd);
          if (!hit.ok) { rep.fail(`${label}前置失败：${hit.why}`); return null; }
          const t0 = Date.now();
          w32.clickPhys(pt.x, pt.y, 'right');
          const opened = await waitEvent('desktop-menu-opened', (e) => e.t >= t0, 4000);
          return opened ? { t0, opened } : null;
        };
        const clickRow27 = (rows, id) => {
          const row = (rows || []).find((r) => r.id === id);
          if (!row) return null;
          const pt = { x: rect27.left + Math.round((row.x + row.w / 2) * f), y: rect27.top + Math.round((row.y + row.h / 2) * f) };
          w32.clickPhys(pt.x, pt.y, 'left');
          return Date.now();
        };
        const clickBtn27 = (box) => {
          const pt = { x: rect27.left + Math.round((box.x + box.w / 2) * f), y: rect27.top + Math.round((box.y + box.h / 2) * f) };
          w32.clickPhys(pt.x, pt.y, 'left');
          return Date.now();
        };
        const ctrlClick27 = async (pt, label) => {
          if (!pt) { rep.fail(`${label}前置失败：落点取矩形失败（条目不在最新渲染里）`); return false; }
          const hit = await ensurePanelHit(pt, hwnd);
          if (!hit.ok) { rep.fail(`${label}前置失败：${hit.why}`); return false; }
          w32.send([w32.keyInput(VK_CONTROL, w32.KEYDOWN)]);
          await sleep(60);
          w32.clickPhys(pt.x, pt.y, 'left');
          await sleep(60);
          w32.send([w32.keyInput(VK_CONTROL, w32.KEYUP)]);
          return true;
        };
        // layout.json 对账（带重试：落盘在内核 persist，与快照同拍到达；P5.11 同法）
        const layoutOnDisk27 = async (retryMs = 4000) => {
          const deadline = Date.now() + retryMs;
          let store = null;
          while (Date.now() < deadline) {
            try { store = JSON.parse(fs.readFileSync(layoutFile, 'utf8')); } catch { /* 重试 */ }
            if (store) return store;
            await sleep(200);
          }
          return store;
        };
        const goneFromDisk27 = async (p, timeoutMs = 8000) => {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            if (!fs.existsSync(p)) return true;
            await sleep(250);
          }
          return false;
        };
        // 回收站实查（AC「真机可在回收站找回」）：Shell.Application Namespace(0xA) 逐项
        // 原名（ASCII-only 临时 ps1 走 -File，createShortcutLnk 同法）。重试在 PS 进程**内部**
        // 轮询（电池负载下每轮重开 powershell + COM 初始化 + 全量枚举可到 10s+，第三轮
        // 实测进程外 15s 预算也会假败）；枚举彻底不可用降级为 note，查到缺席才判败。
        const recycleHas27 = async (likePattern) => {
          const scriptFile = path.join(__dirname, 'evidence', '27-recycle-scan.ps1');
          fs.writeFileSync(scriptFile, [
            '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
            '$deadline = (Get-Date).AddSeconds(25)',
            '$found = $false',
            'while ((Get-Date) -lt $deadline -and -not $found) {',
            '  $bin = (New-Object -ComObject Shell.Application).Namespace(0xA)',
            '  foreach ($it in $bin.Items()) {',
            '    if ($bin.GetDetailsOf($it, 0) -like $args[0]) { $found = $true; break }',
            '  }',
            '  if (-not $found) { Start-Sleep -Milliseconds 800 }',
            '}',
            '[pscustomobject]@{ found = $found } | ConvertTo-Json -Compress',
          ].join('\n'), 'utf8');
          try {
            const res = JSON.parse(psRunFile([scriptFile, likePattern], 35000));
            return res && res.found === true;
          } catch {
            return null; // 枚举不可用（超时/COM 抖动）：降级为 note，不判败
          } finally {
            try { fs.unlinkSync(scriptFile); } catch { /* 尽力清理 */ }
          }
        };

        // a. 单删：先真拖拽造显式摆位（给「摆位同拍清除」造靶子）→ DELETE 直进回收站
        {
          const placedA = await dragPlace27(ptItem27(single27Name), ptItem27(docC27), single27Name);
          const placeDisk = placedA ? await layoutOnDisk27() : null;
          placedA && placeDisk && Array.isArray(placeDisk.docs) && placeDisk.docs.includes(single27Name)
            ? rep.pass(`单删前置：${single27Name} 真拖拽造显式摆位（layout.json docs 对账在列）`)
            : rep.fail(`单删前置摆位异常：placed=${placedA} disk=${JSON.stringify(placeDisk && placeDisk.docs)}`);
          // 摆位后编排重排，探针矩形现取（原本靠 refreshRects27 重取一次，之后几处仍会过期）
          const ptDel27 = ptItem27(single27Name);
          if (!ptDel27) {
            rep.fail('单删用例摆位后探针矩形缺失（探针不在最新渲染里）');
            return;
          }
          const sessDel = await rightClick27(ptDel27, '单删-右键');
          if (!sessDel) {
            rep.fail('单删右键未弹单项菜单（desktop-menu-opened 未见）');
            return;
          }
          (sessDel.opened.items || []).includes('delete')
            ? rep.pass(`单项菜单含【删除】行（条目集=[${(sessDel.opened.items || []).join(', ')}]）`)
            : rep.fail(`单项菜单缺 delete 行：${JSON.stringify(sessDel.opened.items)}`);
          const tDel = clickRow27(sessDel.opened.rows, 'delete');
          if (!tDel) {
            rep.fail('单删用例开层存证缺 delete 行矩形');
            return;
          }
          const clickedA = await waitEvent('desktop-trash-clicked', (e) => e.t >= tDel && sameNames27(e.names, [single27Name]) && e.via === 'ctx-menu', 4000);
          const trashedA = await waitEvent('desktop-trashed', (e) => e.t >= tDel && e.ok === true && sameNames27(e.trashed, [single27Name]), 8000);
          // 单删直进：确认层不开（desktop-trash-confirm-opened 在动作后 1.2s 内不得出现）
          await sleep(1200);
          const confirmA = readEvents().some((e) => e.type === 'desktop-trash-confirm-opened' && e.t >= tDel);
          const goneDiskA = trashedA ? await goneFromDisk27(single27Path) : false;
          const prunedA = trashedA && await waitEvent('desktop-rendered', (e) => e.t >= tDel && !(e.names || []).includes(single27Name), 8000);
          const diskA = trashedA ? await layoutOnDisk27() : null;
          const placedGone = diskA && Array.isArray(diskA.docs) ? !diskA.docs.includes(single27Name) : false;
          const inBin = trashedA ? await recycleHas27(`DECK27-SINGLE-${t27}*`) : null;
          clickedA && trashedA && !confirmA && goneDiskA && prunedA && placedGone
            ? rep.pass(`单删直进回收站：无确认层、desktop-trashed ok=true、文件离盘、条目消失、layout.json docs 摆位同拍清除${inBin === true ? ' + 回收站实查可找回' : inBin === false ? '（注意：回收站实查未命中）' : '（回收站枚举不可用，降级跳过）'}`)
            : rep.fail(`单删存证异常：clicked=${JSON.stringify(clickedA)} trashed=${JSON.stringify(trashedA)} confirm=${confirmA} goneDisk=${goneDiskA} pruned=${!!prunedA} placedGone=${placedGone}`);
          if (trashedA && inBin === false) {
            rep.fail(`回收站实查未命中 ${single27Name}（送回收站语义存疑，人工核验 shell:RecycleBin）`);
          }
          safeShot('27-single-deleted');
        }

        // b. 多删取消：点选 B + Ctrl 补选 C → 右键 B（集内）→ delete-all → 确认层 → CANCEL
        const ptSelB = ptItem27(docB27);
        const ptSelC = ptItem27(docC27);
        if (!ptSelB || !ptSelC) {
          rep.fail(`多删选区前置取矩形失败：B=${!!ptSelB} C=${!!ptSelC}`);
          return;
        }
        const okSelB = await ensurePanelHit(ptSelB, hwnd);
        if (!okSelB.ok) { rep.fail(`多删选区前置失败：${okSelB.why}`); return; }
        const tSel27 = Date.now();
        w32.clickPhys(ptSelB.x, ptSelB.y, 'left');
        const selB27 = await waitEvent('desktop-selected', (e) => e.t >= tSel27 && e.name === docB27, 4000);
        const okCtrl27 = selB27 && await ctrlClick27(ptItem27(docC27), '多删-Ctrl 补选');
        const two27 = okCtrl27 && await waitEvent('desktop-selection-toggled', (e) => e.t >= tSel27 && e.selected === true && sameNames27(e.names, [docB27, docC27]), 4000);
        if (!two27) {
          rep.fail('多删用例前置（选中集两条）未达成');
          return;
        }
        {
          const sessC = await rightClick27(ptItem27(docB27), '多删-集内右键');
          if (!sessC) {
            rep.fail('多删集内右键未弹多选菜单（desktop-menu-opened 未见）');
            return;
          }
          const tAll = clickRow27(sessC.opened.rows, 'delete-all');
          if (!tAll) {
            rep.fail('多删用例开层存证缺 delete-all 行矩形');
            return;
          }
          const confirmOpen = await waitEvent('desktop-trash-confirm-opened', (e) => e.t >= tAll && e.count === 2 && sameNames27(e.names, [docB27, docC27]) && e.confirm && e.cancel, 4000);
          if (!confirmOpen) {
            rep.fail('多删确认层未开（desktop-trash-confirm-opened 未见或载荷缺按钮矩形）');
            return;
          }
          rep.pass(`多选【删除全部】先弹自绘确认：desktop-trash-confirm-opened count=2，确认/取消钮矩形随层存证（确认 ${confirmOpen.confirm.w}x${confirmOpen.confirm.h} / 取消 ${confirmOpen.cancel.w}x${confirmOpen.cancel.h}）`);
          safeShot('27-multi-confirm-open');
          const tCancel = clickBtn27(confirmOpen.cancel);
          const closedCancel = await waitEvent('desktop-trash-confirm-closed', (e) => e.t >= tCancel && e.reason === 'cancel', 4000);
          await sleep(1200);
          const noTrashClicked = !readEvents().some((e) => e.type === 'desktop-trash-clicked' && e.t >= tAll);
          const stillOnDisk = fs.existsSync(probeB27Path) && fs.existsSync(probeC27Path);
          // 池内原样：desktop-rendered 只在指纹变化时发——取消后无变化即无新事件，
          // 故断言「最近一条 rendered 仍含两条目」（若真被删，删除后的池会翻转最后的 rendered）
          const lastRendered27 = readEvents().filter((e) => e.type === 'desktop-rendered').pop();
          const stillInPool = !!lastRendered27 && (lastRendered27.names || []).includes(docB27) && (lastRendered27.names || []).includes(docC27);
          closedCancel && noTrashClicked && stillOnDisk && stillInPool
            ? rep.pass('确认层取消不动：confirm-closed reason=cancel、无 desktop-trash-clicked、两条探针在盘且池内原样（最后一条 rendered 仍含两者）')
            : rep.fail(`确认层取消异常：closed=${JSON.stringify(closedCancel)} clicked=${noTrashClicked} disk=${stillOnDisk} pool=${stillInPool}`);
          safeShot('27-multi-confirm-cancelled');
        }

        // c. 多删确认：选区不动，再右键 B → delete-all → 确认层 → DELETE → 整批进回收站
        {
          const sessD = await rightClick27(ptItem27(docB27), '多删-确认右键');
          if (!sessD) {
            rep.fail('多删确认段右键未弹多选菜单（desktop-menu-opened 未见）');
            return;
          }
          const tAll2 = clickRow27(sessD.opened.rows, 'delete-all');
          const confirmOpen2 = tAll2 && await waitEvent('desktop-trash-confirm-opened', (e) => e.t >= tAll2 && e.count === 2, 4000);
          if (!confirmOpen2) {
            rep.fail('多删确认段确认层未开');
            return;
          }
          const tOk = clickBtn27(confirmOpen2.confirm);
          const closedOk = await waitEvent('desktop-trash-confirm-closed', (e) => e.t >= tOk && e.reason === 'confirm', 4000);
          const clickedAll = await waitEvent('desktop-trash-clicked', (e) => e.t >= tOk && sameNames27(e.names, [docB27, docC27]) && e.count === 2 && e.via === 'ctx-menu', 4000);
          const trashedAll = await waitEvent('desktop-trashed', (e) => e.t >= tOk && e.ok === true && sameNames27(e.trashed, [docB27, docC27]) && sameNames27(e.failed, []), 8000);
          const goneB = trashedAll ? await goneFromDisk27(probeB27Path) : false;
          const goneC = trashedAll ? await goneFromDisk27(probeC27Path) : false;
          const prunedAll = trashedAll && await waitEvent('desktop-rendered', (e) => e.t >= tOk && !(e.names || []).includes(docB27) && !(e.names || []).includes(docC27), 8000);
          const diskAll = trashedAll ? await layoutOnDisk27() : null;
          const cleanLists = diskAll
            ? Array.isArray(diskAll.docs) && !diskAll.docs.includes(docB27) && !diskAll.docs.includes(docC27)
            : false;
          const inBinAll = trashedAll ? await recycleHas27(`DECK27-MULTI-${t27}*`) : null;
          closedOk && clickedAll && trashedAll && goneB && goneC && prunedAll && cleanLists
            ? rep.pass(`确认整批进回收站：desktop-trashed ok=true trashed=[B, C]、文件离盘、条目消失、layout.json docs 名单对账干净${inBinAll === true ? ' + 回收站实查可找回' : inBinAll === false ? '（注意：回收站实查未命中）' : '（回收站枚举不可用，降级跳过）'}`)
            : rep.fail(`多删确认存证异常：closed=${JSON.stringify(closedOk)} clicked=${JSON.stringify(clickedAll)} trashed=${JSON.stringify(trashedAll)} goneB=${goneB} goneC=${goneC} pruned=${!!prunedAll} lists=${cleanLists}`);
          safeShot('27-multi-deleted');
        }
      } finally {
        for (const p of [single27Path, probeB27Path, probeC27Path]) {
          try { if (p) fs.unlinkSync(p); } catch { /* 尽力清理（已删条目本就不在盘上） */ }
        }
      }
      rep.note('删除用例残留：已删探针在回收站可找回（AC 语义本体），如需清净请手动清空回收站');
      w32.moveMousePhys(safePt.x, safePt.y);
    })();

    // —— P5.14 工单28 原地重命名：单项菜单【重命名】→ 标签原地变输入框（预填显示名、
    // 预选主名段）→ 真键盘确认（SendInput UNICODE 直注替换选区 + Enter）。内核侧池护栏、
    // 文件名合法性、重名冲突校验与摆位同拍迁移在离线测试（filename / layout-store /
    // desktop service fakeWorld / contract / dataplane spec）穷举；这里留真机端到端
    // 代表用例（#19 三缝约定）：
    // a. 改名 + 摆位迁移：探针先真拖拽造显式摆位（迁移靶子）→ RENAME →
    //    desktop-rename-started（输入框矩形随开编辑存证）→ 直注新主名 + Enter →
    //    desktop-renamed ok=true、文件真离盘改名、条目按新名回显式段、
    //    layout.json docs 同拍原位迁移（面板发起的重命名不丢摆位——AC 本体）
    // b. Esc 取消：再进 RENAME → 直接 Esc → desktop-rename-cancelled reason=esc、
    //    keyboard-mode-off 成对、盘面与池内原样
    // c. 重名冲突：RENAME 输既有名字 + Enter → desktop-rename-rejected ok=false、
    //    两个盘面文件都原样（原名还原的盘面事实）
    rep.beginSegment('P5.14');
    await (async () => {
      const rect28 = w32.rectOf(hwnd);
      let probeA28 = null;
      let probeB28 = null;
      let probeC28 = null;
      try {
        const t28 = Date.now();
        const nameA28 = `DECK28A-${t28}.txt`; // 改名靶子（先真拖拽造显式摆位）
        const nameB28 = `DECK28B-${t28}.txt`; // 改名后的新名
        const nameC28 = `DECK28C-${t28}.txt`; // 预置冲突占位（重名拒绝靶子）
        probeA28 = path.join(seedScan.user, nameA28);
        probeB28 = path.join(seedScan.user, nameB28);
        probeC28 = path.join(seedScan.user, nameC28);
        fs.writeFileSync(probeA28, 'probe');
        fs.writeFileSync(probeC28, 'probe');
        deckProbeFiles.push(probeA28, probeC28);
        const joined28 = await waitEvent('desktop-rendered', (e) => (e.names || []).includes(nameA28)
          && (e.names || []).includes(nameC28), 8000);
        joined28 || rep.fail(`重命名用例探针未入池（${nameA28}/${nameC28}）`);
        const settled28 = await waitStable('desktop-rendered', 1500, 8000);
        const rects28 = settled28 && (settled28.rects || []);
        if (!rects28.find((r) => r.name === nameA28 && r.rect)) {
          rep.fail(`重命名用例几何前置缺失：A=${JSON.stringify(rects28.find((r) => r.name === nameA28))}`);
          return;
        }
        const ptOf28 = (r) => ({ x: rect28.left + Math.round((r.rect.x + r.rect.w / 2) * f), y: rect28.top + Math.round((r.rect.y + r.rect.h / 2) * f) });
        // 落点现取（工单59 真机首跑教训）：摆位/选中/改名都改使用频次，名序随后台落定重排
        // （工单05，~1s 内动），一次 settle 抓的矩形隔几秒再点就点空（右键点错条目 = 假败）。
        // 三条探针各处现取；settledXX 仍作 settle 屏障 + 几何齐全门禁
        const ptItem28 = (name) => {
          const r = liveItemRect(name);
          return r ? ptOf28(r) : null;
        };
        // 清空选区的分区空白落点（文档区顶排条目上沿之上 6px）：同上，临点现取
        let blankDip28 = null;
        let ptBlank28 = null;
        const refreshBlank28 = () => {
          const top = liveTopDocRect();
          if (!top) { blankDip28 = null; ptBlank28 = null; return false; }
          blankDip28 = { x: top.rect.x + top.rect.w / 2, y: top.rect.y - 6 };
          ptBlank28 = { x: rect28.left + Math.round(blankDip28.x * f), y: rect28.top + Math.round(blankDip28.y * f) };
          return true;
        };
        const rightClick28 = async (pt, label) => {
          if (!pt) { rep.fail(`${label}前置失败：落点取矩形失败（条目不在最新渲染里）`); return null; }
          const hit = await ensurePanelHit(pt, hwnd);
          if (!hit.ok) { rep.fail(`${label}前置失败：${hit.why}`); return null; }
          const t0 = Date.now();
          w32.clickPhys(pt.x, pt.y, 'right');
          const opened = await waitEvent('desktop-menu-opened', (e) => e.t >= t0, 4000);
          return opened ? { t0, opened } : null;
        };
        const clickRow28 = (rows, id) => {
          const row = (rows || []).find((r) => r.id === id);
          if (!row) return null;
          const pt = { x: rect28.left + Math.round((row.x + row.w / 2) * f), y: rect28.top + Math.round((row.y + row.h / 2) * f) };
          w32.clickPhys(pt.x, pt.y, 'left');
          return Date.now();
        };
        // 重命名输入框走真键盘：直注字符前等键盘焦点真的到手（keyboard-mode-on 的
        // setFocusable+focus 落定；前台不是面板时键会漏进别的窗——P7S 前台门同款语义）
        const waitForeground28 = async (timeoutMs = 5000) => {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            const fg = w32.GetForegroundWindow();
            if (fg && w32.threadIdOf(fg).pid === w32.threadIdOf(hwnd).pid) return true;
            await sleep(150);
          }
          return false;
        };
        // layout.json docs 对账（带重试：落盘在内核 persist，与快照同拍到达；P5.13 同法）
        const placedSwapped28 = async (oldName, newName, timeoutMs = 5000) => {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            try {
              const store = JSON.parse(fs.readFileSync(layoutFile, 'utf8'));
              if (Array.isArray(store.docs) && store.docs.includes(newName)) {
                return { swapped: !store.docs.includes(oldName), docs: store.docs };
              }
            } catch { /* 重试 */ }
            await sleep(200);
          }
          return { swapped: false, docs: null };
        };
        // 真拖拽摆位原语（06/21/22/27 同款）
        const dragPlace28 = async (from, to, name) => {
          if (!from || !to) { rep.fail(`摆位拖拽取矩形失败（${name} 不在最新渲染里）`); return false; }
          const hit = await ensurePanelHit(from, hwnd);
          if (!hit.ok) { rep.fail(`摆位拖拽前置失败：${hit.why}`); return false; }
          const t0 = Date.now();
          w32.send([w32.mouseInput(0, 0, w32.LEFTDOWN)]);
          const steps = 16;
          for (let s = 1; s <= steps; s++) {
            await sleep(22);
            w32.moveMousePhys(from.x + Math.round(((to.x - from.x) * s) / steps), from.y + Math.round(((to.y - from.y) * s) / steps));
          }
          await sleep(140);
          w32.send([w32.mouseInput(0, 0, w32.LEFTUP)]);
          w32.moveMousePhys(safePt.x, safePt.y);
          const moved = await waitEvent('desktop-moved', (e) => e.t >= t0 && e.name === name && e.ok === true, 6000);
          return !!moved;
        };

        // a. 前置真拖拽造显式摆位（给「摆位同拍迁移」造靶子）→ RENAME → 直注新主名 + Enter
        {
          const ptA0 = ptItem28(nameA28);
          const ptC0 = ptItem28(nameC28);
          if (!ptC0) {
            rep.fail('重命名用例前置摆位参照缺失（冲突占位无矩形）');
            return;
          }
          const placedA = await dragPlace28(ptA0, ptC0, nameA28);
          const placeDisk = placedA ? await (async () => {
            const deadline = Date.now() + 5000;
            while (Date.now() < deadline) {
              try {
                const store = JSON.parse(fs.readFileSync(layoutFile, 'utf8'));
                if (Array.isArray(store.docs) && store.docs.includes(nameA28)) return { docs: store.docs };
              } catch { /* 重试 */ }
              await sleep(200);
            }
            return { docs: null };
          })() : { docs: null };
          placedA && placeDisk.docs
            ? rep.pass('改名前置：靶子真拖拽造显式摆位（layout.json docs 对账在列）')
            : rep.fail(`改名前置摆位异常：placed=${placedA} docs=${JSON.stringify(placeDisk.docs)}`);
          // 摆位后编排会重排：重取探针矩形再右键（点错条目 = 假败），落点改为临点现取
          const settledA = await waitStable('desktop-rendered', 1500, 8000);
          if (!settledA || !((settledA.rects || []).find((r) => r.name === nameA28 && r.rect))) {
            rep.fail('重命名用例摆位后探针矩形缺失');
            return;
          }
          const sessRen = await rightClick28(ptItem28(nameA28), '改名-右键');
          if (!sessRen) {
            rep.fail('改名右键未弹单项菜单（desktop-menu-opened 未见）');
            return;
          }
          (sessRen.opened.items || []).includes('rename')
            ? rep.pass(`单项菜单含【重命名】行（条目集=[${(sessRen.opened.items || []).join(', ')}]，工单28 第六行）`)
            : rep.fail(`单项菜单缺 rename 行：${JSON.stringify(sessRen.opened.items)}`);
          const tRen = clickRow28(sessRen.opened.rows, 'rename');
          const started = tRen && await waitEvent('desktop-rename-started', (e) => e.t >= tRen && e.name === nameA28 && e.input && e.input.w > 0, 4000);
          // 工单31 起键盘模式归一仲裁：on 沿属选区生（右键切换单选那拍已取得，P5.17 硬断言①），
          // 编辑器开层共用同态不重发——这里断言 started 时刻键盘模式在 on 态 + 键盘焦点到手
          const lastKb28 = (readEvents().filter((e) => e.type === 'keyboard-mode-on' || e.type === 'keyboard-mode-off').pop() || {}).type || null;
          const kbOn = started && lastKb28 === 'keyboard-mode-on';
          const fgOk = started && await waitForeground28();
          started && kbOn && fgOk
            ? rep.pass(`标签原地变输入框：desktop-rename-started（输入框 ${started.input.w}x${started.input.h} 随开编辑存证）、keyboard-mode on 在手（选区生沿取得，编辑器共用单通道同态）、键盘焦点到手`)
            : rep.fail(`重命名编辑器开层异常：started=${JSON.stringify(started)} kbOn=${!!kbOn}(last=${lastKb28}) fg=${fgOk}`);
          safeShot('28-rename-editor');
          // 预选主名段：直注即整段替换（扩展名 .txt 留在输入框里），Enter 确认
          if (!started || !fgOk) return;
          await sleep(300); // 焦点落定缓冲
          w32.sendUnicode(`DECK28B-${t28}`);
          await sleep(150);
          w32.tapKeys([VK_RETURN]);
          const renamed = await waitEvent('desktop-renamed', (e) => e.t >= tRen && e.ok === true && e.to === nameB28, 8000);
          const renamedOld = await waitEvent('desktop-rendered', (e) => e.t >= tRen && (e.names || []).includes(nameB28) && !(e.names || []).includes(nameA28), 8000);
          const goneA = renamed ? await (async () => {
            const deadline = Date.now() + 8000;
            while (Date.now() < deadline) {
              if (!fs.existsSync(probeA28) && fs.existsSync(probeB28)) return true;
              await sleep(250);
            }
            return false;
          })() : false;
          const diskDocs = renamed ? await placedSwapped28(nameA28, nameB28) : { swapped: false, docs: null };
          renamed && renamedOld && goneA && diskDocs.swapped
            ? rep.pass(`Enter 确认改名落盘：desktop-renamed ok=true to=${nameB28}、文件真改名、条目按新名入池、layout.json docs 同拍原位迁移${diskDocs.docs ? `（docs=[${diskDocs.docs.join(', ')}]）` : ''}`)
            : rep.fail(`改名存证异常：renamed=${JSON.stringify(renamed)} rendered=${!!renamedOld} goneDisk=${goneA} docsSwap=${JSON.stringify(diskDocs)}`);
          safeShot('28-rename-migrated');
        }

        // b. Esc 取消：再进 RENAME 直接 Esc——原名原样、keyboard-mode-off 成对
        {
          const settledB = await waitStable('desktop-rendered', 1500, 8000);
          if (!settledB || !((settledB.rects || []).find((r) => r.name === nameB28 && r.rect))) {
            rep.fail('取消用例探针矩形缺失（改名后新名未承载？）');
            return;
          }
          const sessEsc = await rightClick28(ptItem28(nameB28), '取消-右键');
          if (!sessEsc) {
            rep.fail('取消右键未弹单项菜单（desktop-menu-opened 未见）');
            return;
          }
          const tEscRow = clickRow28(sessEsc.opened.rows, 'rename');
          const started2 = tEscRow && await waitEvent('desktop-rename-started', (e) => e.t >= tEscRow && e.name === nameB28, 4000);
          if (!started2 || !(await waitForeground28())) {
            rep.fail(`取消用例编辑器未就绪：started=${JSON.stringify(started2)}`);
            return;
          }
          await sleep(300); // 焦点落定缓冲
          const tEsc = Date.now();
          w32.tapKeys([VK_ESCAPE]);
          const cancelled = await waitEvent('desktop-rename-cancelled', (e) => e.t >= tEsc && e.reason === 'esc' && e.name === nameB28, 4000);
          // 工单31 起键盘模式归一仲裁：Esc 只取消编辑会话，选区（右键切换那拍所生）仍非空
          // → keyboard-mode 保持 on 不还原（浮层关而选区非空不互相踩，P5.17 硬断言⑨同款）；
          // 不可聚焦还原的出口 = 选区清空（段末空白点击补断言）。
          await sleep(400);
          const leakOffB = readEvents().some((e) => e.type === 'keyboard-mode-off' && e.t >= tEsc);
          const stillB = fs.existsSync(probeB28) && !fs.existsSync(probeA28);
          cancelled && leakOffB === false && stillB
            ? rep.pass(`Esc 取消编辑：desktop-rename-cancelled reason=esc、keyboard-mode 保持 on（选区仍非空，仲裁不互相踩）、盘面原名原样`)
            : rep.fail(`取消存证异常：cancelled=${JSON.stringify(cancelled)} offLeak=${leakOffB} stillB=${stillB}`);
          safeShot('28-rename-cancelled');
          // 选区清空 → keyboard-mode-off 同相还原（门控出口：面板恢复不可聚焦）
          const tClr28 = Date.now();
          const settledClr = await waitStable('desktop-rendered', 1500, 8000);
          if (settledClr && refreshBlank28()) {
            const hitClr = await ensurePanelHit(ptBlank28, hwnd);
            if (hitClr.ok) {
              w32.clickPhys(ptBlank28.x, ptBlank28.y, 'left');
              const cleared28 = await waitEvent('desktop-selection-cleared', (e) => e.t >= tClr28, 4000);
              const kbOff28 = cleared28 && await waitEvent('keyboard-mode-off', (e) => e.t >= tClr28, 3000);
              cleared28 && kbOff28
                ? rep.pass('取消编辑后清空选区：desktop-selection-cleared → keyboard-mode-off 同相还原（ADR-0006 出口：选区灭即还原不可聚焦）')
                : rep.fail(`取消后清场断言未过：cleared=${JSON.stringify(cleared28)} kbOff=${!!kbOff28}`);
            } else {
              rep.note('取消后清场点击被遮挡（环境因素），off 同相断言由 P5.17 承接');
            }
          } else {
            rep.note('取消后清场落点取矩形失败（文档区无可视条目），off 同相断言由 P5.17 承接');
          }
        }

        // c. 重名冲突：输既有名字 + Enter——ok=false 存证，两个盘面文件都原样
        {
          const settledC = await waitStable('desktop-rendered', 1500, 8000);
          if (!settledC || !((settledC.rects || []).find((r) => r.name === nameB28 && r.rect))) {
            rep.fail('冲突用例探针矩形缺失');
            return;
          }
          const sessC = await rightClick28(ptItem28(nameB28), '冲突-右键');
          if (!sessC) {
            rep.fail('冲突右键未弹单项菜单（desktop-menu-opened 未见）');
            return;
          }
          const tConf = clickRow28(sessC.opened.rows, 'rename');
          const started3 = tConf && await waitEvent('desktop-rename-started', (e) => e.t >= tConf && e.name === nameB28, 4000);
          if (!started3 || !(await waitForeground28())) {
            rep.fail(`冲突用例编辑器未就绪：started=${JSON.stringify(started3)}`);
            return;
          }
          await sleep(300); // 焦点落定缓冲
          w32.sendUnicode(`DECK28C-${t28}`);
          await sleep(150);
          const tEnter = Date.now();
          w32.tapKeys([VK_RETURN]);
          const rejected = await waitEvent('desktop-rename-rejected', (e) => e.t >= tEnter && e.ok === false && e.to === nameC28, 8000);
          await sleep(1500); // 留足「若误放行则池内换名」的时间窗，再核对盘面与池
          const intact = fs.existsSync(probeB28) && fs.existsSync(probeC28);
          // 拒绝路径不动指纹（无重建无新 rendered）：最新一拍 rendered 仍载原名即池内未动
          const lastRendered = readEvents().filter((e) => e.type === 'desktop-rendered').pop();
          const stillInPool = !!lastRendered && (lastRendered.names || []).includes(nameB28);
          rejected && intact && stillInPool
            ? rep.pass(`重名冲突如实拒绝：desktop-rename-rejected ok=false（原名还原），盘面两文件原样、池内条目未动`)
            : rep.fail(`冲突存证异常：rejected=${JSON.stringify(rejected)} intact=${intact} stillInPool=${stillInPool}`);
          safeShot('28-rename-conflict');
        }
      } finally {
        for (const p of [probeA28, probeB28, probeC28]) {
          try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch { /* 尽力清理 */ }
        }
        w32.moveMousePhys(safePt.x, safePt.y);
      }
    })();

    // —— P5.15 工单29 复制与剪切（系统文件剪贴板写向）：单项菜单【复制】【剪切】与多选
    // 菜单整集写向（desktop/clipboard-copy / desktop/clipboard-cut 一道契约两处入口）。
    // 写入格式 CF_HDROP + Preferred DropEffect（copy=1 / move=2）的单事务字节布局在离线
    // 测试直测（clipboard-files spec；真机探针差分实证 DragQueryFile 与 Get-Clipboard
    // -Format FileDropList 双读通过）；池护栏 / 空名单 / 失败信封在契约与 fakeWorld spec
    // 穷举。这里留真机端到端代表用例（#19 三缝约定）：
    // a. 单项复制：右键 → COPY → desktop-copy-clicked/-copied 存证 + 剪贴板实读
    //    FileDropList 含该文件 + Preferred DropEffect=1（资源管理器粘贴得副本）
    // b. 单项剪切：CUT → desktop-cut-clicked/-cut 存证 + FileDropList 含该文件 +
    //    DropEffect=2（粘贴为搬移）；写剪贴板不动盘面（文件仍在原地，真桌面同款）
    // c. 多选复制：Ctrl 补选两条 → COPY → clicked 名单序整集 + FileDropList 两条按序俱全
    // （PS 通道当日可能不稳——文件表读空重试一轮，仍空则如实标注环境因素，不静默放行）
    rep.beginSegment('P5.15');
    await (async () => {
      const rect29 = w32.rectOf(hwnd);
      const savedClip29 = clipboardGet();
      const sameNames29 = (a, b) => (a || []).join() === b.join();
      let probeS29Path = null;
      let multiA29Path = null;
      let multiB29Path = null;
      try {
        // 夹具：三条真桌面探针文件（复制/剪切只读盘面，探针全程留在盘上，finally 清理）
        const t29 = Date.now();
        const single29Name = `DECK29-SINGLE-${t29}.txt`;
        const multiA29 = `DECK29-MULTI-${t29}-A.txt`;
        const multiB29 = `DECK29-MULTI-${t29}-B.txt`;
        probeS29Path = path.join(seedScan.user, single29Name);
        multiA29Path = path.join(seedScan.user, multiA29);
        multiB29Path = path.join(seedScan.user, multiB29);
        fs.writeFileSync(probeS29Path, 'probe');
        fs.writeFileSync(multiA29Path, 'probe');
        fs.writeFileSync(multiB29Path, 'probe');
        const joined29 = await waitEvent('desktop-rendered', (e) => (e.names || []).includes(single29Name)
          && (e.names || []).includes(multiA29) && (e.names || []).includes(multiB29), 8000);
        joined29 || rep.fail(`复制剪切用例探针未入池（${single29Name}/${multiA29}/${multiB29}）`);
        const settled29 = await waitStable('desktop-rendered', 1500, 8000);
        const rects29 = settled29 && (settled29.rects || []);
        const rS29 = rects29.find((r) => r.name === single29Name && r.rect);
        const rA29 = rects29.find((r) => r.name === multiA29 && r.rect);
        const rB29 = rects29.find((r) => r.name === multiB29 && r.rect);
        if (!rS29 || !rA29 || !rB29) {
          rep.fail(`复制剪切用例几何前置缺失：S=${JSON.stringify(rS29 && rS29.rect)} A=${JSON.stringify(rA29 && rA29.rect)} B=${JSON.stringify(rB29 && rB29.rect)}`);
          return;
        }
        const ptOf29 = (r) => ({ x: rect29.left + Math.round((r.rect.x + r.rect.w / 2) * f), y: rect29.top + Math.round((r.rect.y + r.rect.h / 2) * f) });
        // 落点现取（工单59 真机首跑教训）：选中/复制/剪切都改使用频次，名序随后台落定重排
        // （工单05，~1s 内动），一次 settle 抓的三条矩形隔几秒再点就点空（点错条目 = 假败）。
        // 三条探针各处现取；settled29 仍作 settle 屏障 + 几何齐全门禁
        const ptItem29 = (name) => {
          const r = liveItemRect(name);
          return r ? ptOf29(r) : null;
        };
        // 右键/行点击/Ctrl 补选原语（P5.13 同款；钮矩形来自开层存证）
        const rightClick29 = async (pt, label) => {
          if (!pt) { rep.fail(`${label}前置失败：落点取矩形失败（条目不在最新渲染里）`); return null; }
          const hit = await ensurePanelHit(pt, hwnd);
          if (!hit.ok) { rep.fail(`${label}前置失败：${hit.why}`); return null; }
          const t0 = Date.now();
          w32.clickPhys(pt.x, pt.y, 'right');
          const opened = await waitEvent('desktop-menu-opened', (e) => e.t >= t0, 4000);
          return opened ? { t0, opened } : null;
        };
        const clickRow29 = (rows, id) => {
          const row = (rows || []).find((r) => r.id === id);
          if (!row) return null;
          const pt = { x: rect29.left + Math.round((row.x + row.w / 2) * f), y: rect29.top + Math.round((row.y + row.h / 2) * f) };
          w32.clickPhys(pt.x, pt.y, 'left');
          return Date.now();
        };
        const ctrlClick29 = async (pt, label) => {
          if (!pt) { rep.fail(`${label}前置失败：落点取矩形失败（条目不在最新渲染里）`); return false; }
          const hit = await ensurePanelHit(pt, hwnd);
          if (!hit.ok) { rep.fail(`${label}前置失败：${hit.why}`); return false; }
          w32.send([w32.keyInput(VK_CONTROL, w32.KEYDOWN)]);
          await sleep(60);
          w32.clickPhys(pt.x, pt.y, 'left');
          await sleep(60);
          w32.send([w32.keyInput(VK_CONTROL, w32.KEYUP)]);
          return true;
        };
        // 文件剪贴板实读（PS 通道，P5.12 单进程内轮询同法）：FileDropList 全路径名单 +
        // Preferred DropEffect 4 字节 DWORD。读空重试一轮（历史「剪贴板空读」环境败同法），
        // 仍空如实返回 null，由调用方在失败信息里标注环境因素。
        const fileDropList29 = async (minCount, timeoutMs = 12000) => {
          const scriptFile = path.join(__dirname, 'evidence', '29-filedroplist-wait.ps1');
          fs.writeFileSync(scriptFile, [
            '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
            'Add-Type -AssemblyName System.Windows.Forms',
            '$deadline = (Get-Date).AddSeconds(11)',
            '$names = @()',
            '$eff = -1',
            'while ((Get-Date) -lt $deadline) {',
            '  $fl = Get-Clipboard -Format FileDropList -ErrorAction SilentlyContinue',
            '  if ($fl -and $fl.Count -ge $args[0]) {',
            '    $names = @($fl | ForEach-Object { $_.FullName })',
            '    $d = [System.Windows.Forms.Clipboard]::GetDataObject()',
            '    if ($d -and $d.GetDataPresent(\'Preferred DropEffect\')) {',
            '      $ms = $d.GetData(\'Preferred DropEffect\')',
            '      $b = New-Object byte[] 4',
            '      [void]$ms.Read($b, 0, 4)',
            '      $eff = [BitConverter]::ToUInt32($b, 0)',
            '    }',
            '    break',
            '  }',
            '  Start-Sleep -Milliseconds 400',
            '}',
            '[pscustomobject]@{ names = $names; effect = $eff } | ConvertTo-Json -Compress',
          ].join('\n'), 'utf8');
          const attempt = () => {
            try {
              const res = JSON.parse(psRunFile([scriptFile, String(minCount)], 35000));
              return res && Array.isArray(res.names) && res.names.length >= minCount
                ? { names: res.names, effect: res.effect }
                : null;
            } catch { return null; } // PS 冷启/超时：按空读处理
          };
          try {
            const first = await attempt();
            if (first) return first;
            await sleep(600);
            return await attempt(); // 重试一轮
          } finally {
            try { fs.unlinkSync(scriptFile); } catch { /* 尽力清理 */ }
          }
        };

        // a. 单项复制：desktop-copy-clicked/-copied 存证 + FileDropList 实读 + effect=1
        {
          const sessA29 = await rightClick29(ptItem29(single29Name), '单项复制-右键');
          if (!sessA29) {
            rep.fail('单项复制右键未弹单项菜单（desktop-menu-opened 未见）');
            return;
          }
          (sessA29.opened.items || []).includes('copy') || rep.fail(`单项菜单缺 copy 行：${JSON.stringify(sessA29.opened.items)}`);
          const tCopy = clickRow29(sessA29.opened.rows, 'copy');
          if (!tCopy) {
            rep.fail('单项复制用例开层存证缺 copy 行矩形');
            return;
          }
          const clickedA = await waitEvent('desktop-copy-clicked', (e) => e.t >= tCopy && sameNames29(e.names, [single29Name]) && e.via === 'ctx-menu', 4000);
          const copiedA = await waitEvent('desktop-copied', (e) => e.t >= tCopy && e.ok === true && sameNames29(e.names, [single29Name]), 8000);
          const clipA = (clickedA && copiedA) ? await fileDropList29(1) : null;
          const effOkA = !!clipA && clipA.effect === 1;
          const diskOkA = fs.existsSync(probeS29Path); // 复制不动盘面
          clickedA && copiedA && clipA && sameNames29(clipA.names, [probeS29Path]) && effOkA && diskOkA
            ? rep.pass('单项复制动作（desktop/clipboard-copy）：ok=true 存证 + 剪贴板实读 FileDropList=[探针全路径] + Preferred DropEffect=1（资源管理器粘贴得副本）')
            : rep.fail(`单项复制存证异常：clicked=${JSON.stringify(clickedA)} copied=${JSON.stringify(copiedA)} 剪贴板=${JSON.stringify(clipA)} effect=${clipA ? clipA.effect : '-'}（names 空 = PS 通道空读环境败，重试后仍未命中）disk=${diskOkA}`);
          safeShot('29-single-copied');
        }

        // b. 单项剪切：desktop-cut-clicked/-cut 存证 + FileDropList + effect=2；文件仍在盘上
        {
          const sessB29 = await rightClick29(ptItem29(single29Name), '单项剪切-右键');
          if (!sessB29) {
            rep.fail('单项剪切右键未弹单项菜单（desktop-menu-opened 未见）');
            return;
          }
          (sessB29.opened.items || []).includes('cut') || rep.fail(`单项菜单缺 cut 行：${JSON.stringify(sessB29.opened.items)}`);
          const tCut = clickRow29(sessB29.opened.rows, 'cut');
          if (!tCut) {
            rep.fail('单项剪切用例开层存证缺 cut 行矩形');
            return;
          }
          const clickedB = await waitEvent('desktop-cut-clicked', (e) => e.t >= tCut && sameNames29(e.names, [single29Name]) && e.via === 'ctx-menu', 4000);
          const cutB = await waitEvent('desktop-cut', (e) => e.t >= tCut && e.ok === true && sameNames29(e.names, [single29Name]), 8000);
          const clipB = (clickedB && cutB) ? await fileDropList29(1) : null;
          const effOkB = !!clipB && clipB.effect === 2;
          const diskOkB = fs.existsSync(probeS29Path); // 剪切语义：写剪贴板不动盘面
          clickedB && cutB && clipB && sameNames29(clipB.names, [probeS29Path]) && effOkB && diskOkB
            ? rep.pass('单项剪切动作（desktop/clipboard-cut）：ok=true 存证 + 剪贴板实读 FileDropList=[探针全路径] + Preferred DropEffect=2（粘贴为搬移）+ 文件仍在盘上')
            : rep.fail(`单项剪切存证异常：clicked=${JSON.stringify(clickedB)} cut=${JSON.stringify(cutB)} 剪贴板=${JSON.stringify(clipB)} effect=${clipB ? clipB.effect : '-'}（effect≠2 = 搬移语义存疑）disk=${diskOkB}`);
          safeShot('29-single-cut');
        }

        // c. 多选复制：Ctrl 补选两条 → 右键集内 → COPY → 整集进剪贴板（名单序）
        {
          const ptSelA29 = ptItem29(multiA29);
          if (!ptSelA29) { rep.fail(`多选复制选区前置取矩形失败：${multiA29} 不在最新渲染里`); return; }
          const okSelA29 = await ensurePanelHit(ptSelA29, hwnd);
          if (!okSelA29.ok) { rep.fail(`多选复制选区前置失败：${okSelA29.why}`); return; }
          const tSel29 = Date.now();
          w32.clickPhys(ptSelA29.x, ptSelA29.y, 'left');
          const selA29 = await waitEvent('desktop-selected', (e) => e.t >= tSel29 && e.name === multiA29, 4000);
          const okCtrl29 = selA29 && await ctrlClick29(ptItem29(multiB29), '多选复制-Ctrl 补选');
          const two29 = okCtrl29 && await waitEvent('desktop-selection-toggled', (e) => e.t >= tSel29 && e.selected === true && sameNames29(e.names, [multiA29, multiB29]), 4000);
          if (!two29) {
            rep.fail('多选复制用例前置（选中集两条）未达成');
            return;
          }
          const sessC29 = await rightClick29(ptItem29(multiA29), '多选复制-集内右键');
          if (!sessC29) {
            rep.fail('多选复制集内右键未弹多选菜单（desktop-menu-opened 未见）');
            return;
          }
          (sessC29.opened.items || []).includes('copy') || rep.fail(`多选菜单缺 copy 行：${JSON.stringify(sessC29.opened.items)}`);
          const tCopyAll = clickRow29(sessC29.opened.rows, 'copy');
          if (!tCopyAll) {
            rep.fail('多选复制用例开层存证缺 copy 行矩形');
            return;
          }
          const clickedC = await waitEvent('desktop-copy-clicked', (e) => e.t >= tCopyAll && sameNames29(e.names, [multiA29, multiB29]) && e.count === 2 && e.via === 'ctx-menu', 4000);
          const copiedC = await waitEvent('desktop-copied', (e) => e.t >= tCopyAll && e.ok === true && sameNames29(e.names, [multiA29, multiB29]), 8000);
          const clipC = (clickedC && copiedC) ? await fileDropList29(2) : null;
          const diskOkC = fs.existsSync(multiA29Path) && fs.existsSync(multiB29Path);
          clickedC && copiedC && clipC && sameNames29(clipC.names, [multiA29Path, multiB29Path]) && diskOkC
            ? rep.pass('多选复制整集动作：clicked/copied 按选区插入序 [A, B] + 剪贴板实读 FileDropList 两条按序俱全（AC「多选整集进剪贴板」）')
            : rep.fail(`多选复制存证异常：clicked=${JSON.stringify(clickedC)} copied=${JSON.stringify(copiedC)} 剪贴板=${JSON.stringify(clipC)}（两条不齐 = 整集写向或 PS 空读，见 effect 字段佐证）disk=${diskOkC}`);
          safeShot('29-multi-copied');
          // 清场：Ctrl 点回 A 切换出选（电池余段回到无选区现场）
          await ctrlClick29(ptItem29(multiA29), '多选复制-清场');
        }
      } finally {
        for (const p of [probeS29Path, multiA29Path, multiB29Path]) {
          try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch { /* 尽力清理 */ }
        }
        clipboardSet(savedClip29); // 电池不得改变用户剪贴板内容（07 搜索段同法）
      }
      w32.moveMousePhys(safePt.x, safePt.y);
    })();

    // —— P5.16 工单30 粘贴：分区空白菜单【粘贴】把剪贴板文件落进用户桌面根（desktop/paste
    // 契约：剪贴板读经主进程 clipboard-read 代理，落盘裁决在数据面子进程；同名「 - 副本」
    // 递增不弹框）。离线侧（contract / desktop service fakeWorld / filename / menu-shell）
    // 穷举；这里留真机端到端代表用例（#19 三缝约定）：
    // a. 置灰态：剪贴板清成文本 → 右键空白 → PASTE 行在列（行矩形随开层存证）→ 点行无
    //    反应（归约器挡下：无 desktop-paste-clicked、菜单不收）→ 外击收场
    // b. 可用态：Set-Clipboard -Path 播种真文件 → 点 PASTE → desktop-pasted ok=true →
    //    文件落桌面根 → watch 后条目入池
    // c. 同名「 - 副本」：剪贴板原样再贴一份 → pasted 名带「 - 副本」、桌面两份共存不覆盖
    // 夹具与落物段内 finally 兜底；PS 通道（Set-Clipboard）不稳当日可能假败——播种失败
    // 重试一次，仍败在断言信息如实标注环境因素（历史上有一例「剪贴板空读」环境败）。
    rep.beginSegment('P5.16');
    await (async () => {
      const rect30 = w32.rectOf(hwnd);
      const sameNames30 = (a, b) => (a || []).join() === b.join();
      const t30 = Date.now();
      const baseA = `DECK30-PASTE-${t30}.txt`;
      const copyA = `DECK30-PASTE-${t30} - 副本.txt`;
      const userDesktop = seedScan.user;
      let staging30 = null;
      try {
        // 几何前置：文档区顶排条目上沿之上 6px 的分区空白点（P5.9 同法）。顶排条目随后台使用
        // 频次落定会换位（工单05，~1s 内动），本段三处开层跨几十秒，空白落点一律临点现取
        let blankDip30 = null;
        let ptBlank30 = null;
        const refreshBlank30 = () => {
          const top = liveTopDocRect();
          if (!top) { blankDip30 = null; ptBlank30 = null; return false; }
          blankDip30 = { x: top.rect.x + top.rect.w / 2, y: top.rect.y - 6 };
          ptBlank30 = { x: rect30.left + Math.round(blankDip30.x * f), y: rect30.top + Math.round(blankDip30.y * f) };
          return true;
        };
        const settled30 = await waitStable('desktop-rendered', 1500, 8000);
        if (!settled30 || !refreshBlank30()) {
          rep.fail('粘贴用例几何前置缺失：文档区顶排矩形未取到');
          return;
        }
        const openMenu30 = async (label) => {
          if (!refreshBlank30()) { rep.fail(`${label}前置失败：分区空白落点取矩形失败（文档区无可视条目）`); return null; }
          const hit = await ensurePanelHit(ptBlank30, hwnd);
          if (!hit.ok) { rep.fail(`${label}前置失败：${hit.why}`); return null; }
          const t0 = Date.now();
          w32.clickPhys(ptBlank30.x, ptBlank30.y, 'right');
          const opened = await waitEvent('desktop-menu-opened', (e) => e.t >= t0, 4000);
          return opened ? { t0, opened } : null;
        };
        const clickRow30 = (rows, id) => {
          const row = (rows || []).find((r) => r.id === id);
          if (!row) return null;
          w32.clickPhys(rect30.left + Math.round((row.x + row.w / 2) * f), rect30.top + Math.round((row.y + row.h / 2) * f), 'left');
          return Date.now();
        };
        // 收起原语：面板内分区热区之外的空档一击（P5.9 空档收起同法——开层菜单盖着
        // ptBlank30 本身，点那里会落回菜单行；空档在热区外，常规态这一击进不了面板，
        // 开层后收得到 = 全窗热区承接；尾随 click 由吞没机制恰吞）
        const outPt30 = { x: rect30.left + Math.round((DOC_ZONE_RIGHT_DIP + 100) * f), y: rect30.top + Math.round(600 * f) };
        const dismissBlank30 = async (since) => {
          const hit = await ensurePanelHit(outPt30, hwnd);
          if (!hit.ok) return false;
          w32.clickPhys(outPt30.x, outPt30.y, 'left');
          return !!(await waitEvent('desktop-menu-closed', (e) => e.t >= since && e.reason === 'outside', 4000));
        };
        // 剪贴板播种（PS 通道）：Set-Clipboard -Path → FileDropList 回读核验；不稳重试一次
        const seedClipboardFiles = async (paths) => {
          for (let i = 0; i < 2; i++) {
            try {
              const list = paths.map((p) => `'${String(p).replace(/'/g, "''")}'`).join(',');
              psRun(`Set-Clipboard -Path ${list} -ErrorAction Stop`);
              await sleep(400);
              const check = psRun("if (@(Get-Clipboard -Format FileDropList -ErrorAction SilentlyContinue).Count -ge " + paths.length + ") { 'ok' } else { 'no' }");
              if (check === 'ok') return true;
            } catch { /* PS 抖动：重试一次 */ }
            await sleep(600);
          }
          return false;
        };
        const clearClipboardText = () => {
          try { psRun("Set-Clipboard -Value 'deck30-cleared' -ErrorAction Stop"); return true; } catch { return false; }
        };

        // a. 置灰态：剪贴板清成文本 → PASTE 行在列但点了没反应
        if (!clearClipboardText()) rep.note('置灰用例清剪贴板未走通（PS 通道异常）——若环境剪贴板残留文件态，置灰断言将如实失败');
        const sessA = await openMenu30('粘贴-置灰开层');
        if (!sessA) {
          rep.fail('置灰用例开层失败（desktop-menu-opened 未见）');
          return;
        }
        const rowA = (sessA.opened.rows || []).find((r) => r.id === 'paste');
        (sessA.opened.items || []).includes('paste') && rowA
          ? rep.pass(`空白菜单含【粘贴】行（条目集=[${(sessA.opened.items || []).join(', ')}]，行矩形 ${Math.round(rowA.w)}x${Math.round(rowA.h)} 随开层存证）`)
          : rep.fail(`空白菜单缺 paste 行：${JSON.stringify(sessA.opened.items)}`);
        const tGray = rowA ? clickRow30(sessA.opened.rows, 'paste') : null;
        await sleep(1200);
        const grayLeaked = tGray && readEvents().some((e) => e.type === 'desktop-paste-clicked' && e.t >= tGray);
        const grayStill = tGray ? await dismissBlank30(tGray) : false;
        tGray && !grayLeaked && grayStill
          ? rep.pass('置灰态：【粘贴】行点击无反应（无 desktop-paste-clicked）、菜单保持开着由外击收起——剪贴板无文件时置灰（shell 归约器挡下）')
          : rep.fail(`置灰态断言未过：行矩形=${!!rowA} 点击泄漏=${!!grayLeaked} 收起=${grayStill}`);

        // b. 可用态：播种真文件 → 点 PASTE → 落桌面根 → 入池
        const staging = path.join(os.tmpdir(), `deck30-clip-${t30}`);
        fs.mkdirSync(staging, { recursive: true });
        staging30 = staging;
        const srcA = path.join(staging, baseA);
        fs.writeFileSync(srcA, 'paste-v1');
        const seeded = await seedClipboardFiles([srcA]);
        if (!seeded) {
          rep.fail('粘贴用例剪贴板播种失败（Set-Clipboard -Path 两次尝试均未通过 FileDropList 回读核验——PS 通道环境因素，非面板行为断言失败）');
          return;
        }
        const sessB = await openMenu30('粘贴-可用开层');
        if (!sessB) {
          rep.fail('可用用例开层失败（desktop-menu-opened 未见）');
          return;
        }
        const tPaste = clickRow30(sessB.opened.rows, 'paste');
        if (!tPaste) {
          rep.fail('可用用例开层存证缺 paste 行矩形');
          return;
        }
        const clickedB = await waitEvent('desktop-paste-clicked', (e) => e.t >= tPaste && e.via === 'ctx-menu', 4000);
        const pastedB = await waitEvent('desktop-pasted', (e) => e.t >= tPaste && e.ok === true && sameNames30(e.pasted, [baseA]), 8000);
        const landedDiskB = pastedB ? fs.existsSync(path.join(userDesktop, baseA)) : false;
        const landedPoolB = pastedB && await waitEvent('desktop-rendered', (e) => e.t >= tPaste && (e.names || []).includes(baseA), 8000);
        clickedB && pastedB && landedDiskB && landedPoolB
          ? rep.pass(`可用态：desktop-pasted ok=true pasted=[${baseA}]，文件落桌面根且 watch 后条目入池（desktop-rendered 在档）`)
          : rep.fail(`可用态存证异常：clicked=${JSON.stringify(clickedB)} pasted=${JSON.stringify(pastedB)} disk=${landedDiskB} pool=${!!landedPoolB}`);
        safeShot('30-paste-landed');

        // c. 同名「 - 副本」：剪贴板原样（copy 语义不清剪贴板）再贴一份 → 递增名落盘
        const sessC = await openMenu30('粘贴-副本开层');
        if (!sessC) {
          rep.fail('副本用例开层失败（desktop-menu-opened 未见）');
          return;
        }
        const tPaste2 = clickRow30(sessC.opened.rows, 'paste');
        const pastedC = tPaste2 && await waitEvent('desktop-pasted', (e) => e.t >= tPaste2 && e.ok === true && sameNames30(e.pasted, [copyA]), 8000);
        const bothOnDisk = pastedC && fs.existsSync(path.join(userDesktop, baseA)) && fs.existsSync(path.join(userDesktop, copyA));
        pastedC && bothOnDisk
          ? rep.pass(`同名冲突自动「 - 副本」递增：再贴落为 [${copyA}]，桌面两份共存不覆盖（真桌面同款不弹框）`)
          : rep.fail(`副本用例存证异常：pasted=${JSON.stringify(pastedC)} both=${bothOnDisk}`);
        safeShot('30-paste-copy-suffix');
      } finally {
        // 落物清理兜底：桌面落物按前缀清 + 暂存目录整删 + 剪贴板还原为文本（不给后续段留文件态剪贴板）
        try {
          for (const n of fs.readdirSync(userDesktop)) {
            if (n.startsWith(`DECK30-PASTE-${t30}`)) {
              try { fs.unlinkSync(path.join(userDesktop, n)); } catch { /* 尽力清理 */ }
            }
          }
        } catch { /* 尽力清理 */ }
        if (staging30) { try { fs.rmSync(staging30, { recursive: true, force: true }); } catch { /* 尽力 */ } }
        try { psRun("Set-Clipboard -Value 'deck30-cleared' -ErrorAction Stop"); } catch { /* 尽力 */ }
        w32.moveMousePhys(safePt.x, safePt.y);
      }
    })();

    // —— P5.17 工单31 键盘门控全套（ADR-0006 收官）：选区生灭与 keyboard-mode-on/off
    // 严格同相（硬断言组，nextKeyboardMode31 按「since 起首个 keyboard-mode 事件即指望
    // 方向」判相邻性）+ 六键各一条（Del 单删/多选确认层、Enter、Ctrl+A、Ctrl+C、Ctrl+X、
    // Ctrl+V）+ Esc 两层定序（菜单 > 选区：菜单开着 Esc 只关菜单不清选区）+ 浮层优先
    // （搜索激活期间选区快捷键不接管、搜索输入不受影响、Esc 归浮层且关层不踩选区）。
    // 仲裁/路由/Esc 定序纯逻辑在离线测试（keyboard-gate.spec、menu-shell.spec）穷举；
    // 选区构造用 P5.6 点选 / P5.7 框选同款探针手法。夹具与落物段内 finally 兜底。
    rep.beginSegment('P5.17');
    await (async () => {
      const rect31 = w32.rectOf(hwnd);
      const sameNames31 = (a, b) => (a || []).join() === b.join();
      const t31 = Date.now();
      const nameCopy31 = `DECK31-COPY-${t31}.txt`;
      const nameDel31 = `DECK31-DEL-${t31}.txt`;
      const nameDelB31 = `DECK31-DEL-${t31}-B.txt`;
      const nameDelC31 = `DECK31-DEL-${t31}-C.txt`;
      const nameBat31 = `DECK31-BAT-${t31}.bat`;
      const namePaste31 = `DECK31-PASTE-${t31}.txt`;
      const probeCopy31 = path.join(seedScan.user, nameCopy31);
      const probeDel31 = path.join(seedScan.user, nameDel31);
      const probeDelB31 = path.join(seedScan.user, nameDelB31);
      const probeDelC31 = path.join(seedScan.user, nameDelC31);
      const probeBat31 = path.join(seedScan.user, nameBat31);
      const marker31 = path.join(__dirname, 'evidence', `31-marker-${t31}.txt`);
      const staging31 = path.join(os.tmpdir(), `deck31-clip-${t31}`);
      const userDesktop31 = seedScan.user;
      const savedClip31 = clipboardGet();
      // 同相硬断言原语：since 起首个 keyboard-mode 事件必须是指望方向（相邻性——
      // 其间夹进另一方向即失败）；超时未见任何 keyboard-mode 事件也算失败。
      const nextKeyboardMode31 = async (since, want, timeoutMs = 4000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const hits = readEvents().filter((e) => (e.type === 'keyboard-mode-on' || e.type === 'keyboard-mode-off') && e.t >= since);
          if (hits.length) {
            const first = hits[0];
            return { ok: first.type === want, first, between: hits.slice(1, 3).map((h) => h.type) };
          }
          await sleep(60);
        }
        return { ok: false, first: null, between: [] };
      };
      // 反向硬断言：since 起不得出现某类事件（快捷键泄漏 / 通道重发检测）
      const leaked31 = (type, since) => readEvents().some((e) => e.type === type && e.t >= since);
      const latestRect31 = (name) => {
        const last = readEvents().filter((e) => e.type === 'desktop-rendered').pop();
        return last ? (((last.rects || []).find((r) => r.name === name && r.rect) || {}).rect || null) : null;
      };
      // 矩形读取统一先等渲染安静（P5.6 纪律：用法分重排在首拍 ~1s 后，读早了会点错条目）
      const settledRect31 = async (name) => {
        await waitStable('desktop-rendered', 1200, 8000);
        return latestRect31(name);
      };
      const latestSearchZone31 = () => {
        const evts = readEvents().filter((e) => e.type === 'hotzones' && (e.rects || []).some((r) => r.id === 'search-card'));
        const last = evts[evts.length - 1];
        return last ? (last.rects || []).find((r) => r.id === 'search-card') || null : null;
      };
      const ptOf31 = (r) => ({ x: rect31.left + Math.round((r.x + r.w / 2) * f), y: rect31.top + Math.round((r.y + r.h / 2) * f) });
      const clickItem31 = async (rect, label) => {
        const hit = await ensurePanelHit(ptOf31(rect), hwnd);
        if (!hit.ok) { rep.fail(`${label}前置失败：${hit.why}`); return false; }
        w32.clickPhys(ptOf31(rect).x, ptOf31(rect).y, 'left');
        return true;
      };
      // 选区清场：文档区顶排上沿之上 6px 分区空白（P5.6 同法，热区内非条目面）
      const blankClear31 = async (label) => {
        const settled = await waitStable('desktop-rendered', 1200, 8000);
        const docRects = ((settled && settled.rects) || []).filter((r) => r.zone === 'doc' && r.rect).map((r) => ({ name: r.name, ...r.rect }));
        const topDoc = docRects.slice().sort((a, b) => a.y - b.y || a.x - b.x)[0];
        if (!topDoc) { rep.fail(`${label}清场取矩形失败`); return false; }
        const pt = { x: rect31.left + Math.round((topDoc.x + topDoc.w / 2) * f), y: rect31.top + Math.round((topDoc.y - 6) * f) };
        const hit = await ensurePanelHit(pt, hwnd);
        if (!hit.ok) { rep.fail(`${label}清场前置失败：${hit.why}`); return false; }
        w32.clickPhys(pt.x, pt.y, 'left');
        return true;
      };
      // 键盘路径：发键前等键盘焦点真的到手（keyboard-mode-on 的 setFocusable+focus 落定，
      // P5.14 前台门同款语义——前台不是面板时键会漏进别的窗）
      const waitFg31 = async (timeoutMs = 6000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const fg = w32.GetForegroundWindow();
          if (fg && w32.threadIdOf(fg).pid === w32.threadIdOf(hwnd).pid) return true;
          await sleep(150);
        }
        return false;
      };
      const tapKey31 = (vk) => {
        w32.send([w32.keyInput(vk, w32.KEYDOWN)]);
        w32.send([w32.keyInput(vk, w32.KEYUP)]);
      };
      const ctrlKey31 = async (vk) => {
        w32.send([w32.keyInput(VK_CONTROL, w32.KEYDOWN)]);
        await sleep(80);
        w32.send([w32.keyInput(vk, w32.KEYDOWN)]);
        w32.send([w32.keyInput(vk, w32.KEYUP)]);
        await sleep(80);
        w32.send([w32.keyInput(VK_CONTROL, w32.KEYUP)]);
      };
      // 剪贴板播种（PS 通道，P5.16 同法：不稳重试一次）与文件实读（P5.15 同法收窄）
      const seedClipboard31 = async (paths) => {
        for (let i = 0; i < 2; i++) {
          try {
            const list = paths.map((p) => `'${String(p).replace(/'/g, "''")}'`).join(',');
            psRun(`Set-Clipboard -Path ${list} -ErrorAction Stop`);
            await sleep(400);
            const check = psRun("if (@(Get-Clipboard -Format FileDropList -ErrorAction SilentlyContinue).Count -ge " + paths.length + ") { 'ok' } else { 'no' }");
            if (check === 'ok') return true;
          } catch { /* PS 抖动：重试一次 */ }
          await sleep(600);
        }
        return false;
      };
      const fileDropList31 = async (minCount, timeoutMs = 12000) => {
        const scriptFile = path.join(__dirname, 'evidence', '31-filedroplist-wait.ps1');
        fs.writeFileSync(scriptFile, [
          '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
          'Add-Type -AssemblyName System.Windows.Forms',
          '$deadline = (Get-Date).AddSeconds(11)',
          '$names = @()',
          '$eff = -1',
          'while ((Get-Date) -lt $deadline) {',
          '  $fl = Get-Clipboard -Format FileDropList -ErrorAction SilentlyContinue',
          '  if ($fl -and $fl.Count -ge $args[0]) {',
          '    $names = @($fl | ForEach-Object { $_.FullName })',
          '    $d = [System.Windows.Forms.Clipboard]::GetDataObject()',
          '    if ($d -and $d.GetDataPresent(\'Preferred DropEffect\')) {',
          '      $ms = $d.GetData(\'Preferred DropEffect\')',
          '      $b = New-Object byte[] 4',
          '      [void]$ms.Read($b, 0, 4)',
          '      $eff = [BitConverter]::ToUInt32($b, 0)',
          '    }',
          '    break',
          '  }',
          '  Start-Sleep -Milliseconds 400',
          '}',
          '[pscustomobject]@{ names = $names; effect = $eff } | ConvertTo-Json -Compress',
        ].join('\n'), 'utf8');
        const attempt = () => {
          try {
            const res = JSON.parse(psRunFile([scriptFile, String(minCount)], 35000));
            return res && Array.isArray(res.names) && res.names.length >= minCount
              ? { names: res.names, effect: res.effect }
              : null;
          } catch { return null; }
        };
        try {
          const first = await attempt();
          if (first) return first;
          await sleep(600);
          return await attempt();
        } finally {
          try { fs.unlinkSync(scriptFile); } catch { /* 尽力清理 */ }
        }
      };

      try {
        // 夹具：四条真桌面探针文件 + 一条探针 lnk（Enter 用，标记实证）+ 粘贴暂存目录
        fs.writeFileSync(probeCopy31, 'probe');
        fs.writeFileSync(probeDel31, 'probe');
        fs.writeFileSync(probeDelB31, 'probe');
        fs.writeFileSync(probeDelC31, 'probe');
        createProbeBat(probeBat31, marker31);
        fs.mkdirSync(staging31, { recursive: true });
        const staged31 = path.join(staging31, namePaste31);
        fs.writeFileSync(staged31, 'paste-v1');
        const joined31 = await waitEvent('desktop-rendered', (e) => e.t >= t31
          && [nameCopy31, nameDel31, nameDelB31, nameDelC31, nameBat31].every((n) => (e.names || []).includes(n)), 12000);
        joined31 || rep.fail(`键盘门控用例探针未入池（bat=${nameBat31}）`);
        // 段前清场：上游段若遗留选区（异常路径）先归零（空选区上是无操作）
        await blankClear31('P5.17 段前');
        await sleep(400);

        // a. 生灭同相（硬断言①②）：点选生 → 首个 keyboard-mode 事件即 on；
        //    Esc 清空灭 → 首个即 off
        {
          const rA = await settledRect31(nameCopy31);
          const tA = Date.now();
          const okA = rA && await clickItem31(rA, '同相-点选');
          const selA = okA && await waitEvent('desktop-selected', (e) => e.t >= tA && e.name === nameCopy31, 4000);
          const onA = selA && await nextKeyboardMode31(tA, 'keyboard-mode-on');
          selA && onA && onA.ok
            ? rep.pass(`选区生与 keyboard-mode-on 同相（硬断言①）：desktop-selected 后首个键盘模式事件即 on（+${onA.first.t - tA}ms）`)
            : rep.fail(`生相同相断言未过：sel=${JSON.stringify(selA)} next=${JSON.stringify(onA)}`);
          // nextKeyboardMode31 等不到会回 null——onA 可能为 null，判活一律走 onA && onA.ok
          const onAOk = !!(onA && onA.ok);
          const fgA = onAOk && await waitFg31();
          if (onAOk && !fgA) rep.fail('生相同相用例键盘焦点未到手（Esc 清空断言跳过）');
          if (onAOk && fgA) {
            const tEsc = Date.now();
            tapKey31(VK_ESCAPE);
            const clrA = await waitEvent('desktop-selection-cleared', (e) => e.t >= tEsc && (e.had || []).length === 1, 4000);
            const offA = clrA && await nextKeyboardMode31(tEsc, 'keyboard-mode-off');
            clrA && offA && offA.ok
              ? rep.pass('选区灭与 keyboard-mode-off 同相（硬断言②）：Esc 清空后首个键盘模式事件即 off')
              : rep.fail(`灭相同相断言未过：cleared=${JSON.stringify(clrA)} next=${JSON.stringify(offA)}`);
            safeShot('31-gate-phase');
          }
        }

        // b. Ctrl+A 全选：select-all 事件进状态机，名单=池内全部
        {
          const rB = await settledRect31(nameCopy31);
          const tB = Date.now();
          const okB = rB && await clickItem31(rB, '全选-点选');
          const selB = okB && await waitEvent('desktop-selected', (e) => e.t >= tB && e.name === nameCopy31, 4000);
          const fgB = selB && await waitFg31();
          if (!fgB) {
            rep.fail('Ctrl+A 用例键盘焦点未到手');
          } else {
            await ctrlKey31(VK_A);
            const pool = (readEvents().filter((e) => e.type === 'desktop-rendered').pop() || {}).names || [];
            const allB = await waitEvent('desktop-selection-all', (e) => e.t >= tB && sameNames31(e.names, pool), 4000);
            allB
              ? rep.pass(`Ctrl+A 全选（select-all 进状态机）：desktop-selection-all 名单=池内全部 ${pool.length} 条`)
              : rep.fail(`Ctrl+A 全选存证异常：${JSON.stringify(allB)}（池 ${pool.length} 条）`);
            await blankClear31('全选清场');
          }
        }

        // c. Enter 打开选中：探针 bat 标记实证（desktop-launch-clicked via=keyboard）
        {
          const rC = await settledRect31(nameBat31);
          const tC = Date.now();
          const okC = rC && await clickItem31(rC, 'Enter-点选');
          const selC = okC && await waitEvent('desktop-selected', (e) => e.t >= tC && e.name === nameBat31, 4000);
          const fgC = selC && await waitFg31();
          if (!fgC) {
            rep.fail('Enter 用例键盘焦点未到手');
          } else {
            tapKey31(VK_RETURN);
            const clickedC = await waitEvent('desktop-launch-clicked', (e) => e.t >= tC && e.name === nameBat31 && e.via === 'keyboard', 4000);
            const launchedC = clickedC && await waitEvent('desktop-launched', (e) => e.t >= tC && e.name === nameBat31 && e.ok === true, 6000);
            let markerOk31 = false;
            const mDeadline = Date.now() + 20000;
            while (Date.now() < mDeadline && !markerOk31) {
              try { markerOk31 = fs.readFileSync(marker31, 'utf8').trim() === 'ok'; } catch { markerOk31 = false; }
              if (!markerOk31) await sleep(250);
            }
            clickedC && launchedC && markerOk31
              ? rep.pass('Enter 打开选中（desktop/launch）：desktop-launch-clicked via=keyboard + desktop-launched ok=true + 探针标记落盘')
              : rep.fail(`Enter 存证异常：clicked=${JSON.stringify(clickedC)} launched=${JSON.stringify(launchedC)} marker=${markerOk31}`);
            await blankClear31('Enter 清场');
          }
        }

        // d. Del 单项直删（多选才弹确认层，真桌面同语义）+ 删尽灭相同相（硬断言③）
        {
          const rD = await settledRect31(nameDel31);
          const tD = Date.now();
          const okD = rD && await clickItem31(rD, 'Del-点选');
          const selD = okD && await waitEvent('desktop-selected', (e) => e.t >= tD && e.name === nameDel31, 4000);
          const fgD = selD && await waitFg31();
          if (!fgD) {
            rep.fail('Del 单删用例键盘焦点未到手');
          } else {
            tapKey31(VK_DELETE);
            const clickedD = await waitEvent('desktop-trash-clicked', (e) => e.t >= tD && sameNames31(e.names, [nameDel31]) && e.via === 'keyboard', 4000);
            const trashedD = clickedD && await waitEvent('desktop-trashed', (e) => e.t >= tD && e.ok === true && sameNames31(e.names, [nameDel31]), 8000);
            const goneD = trashedD ? await (async () => {
              const dl = Date.now() + 8000;
              while (Date.now() < dl) { if (!fs.existsSync(probeDel31)) return true; await sleep(250); }
              return false;
            })() : false;
            clickedD && trashedD && goneD
              ? rep.pass('Del 删除选中（单项直删不弹确认）：desktop-trash-clicked via=keyboard + desktop-trashed ok=true + 文件离盘')
              : rep.fail(`Del 存证异常：clicked=${JSON.stringify(clickedD)} trashed=${JSON.stringify(trashedD)} gone=${goneD}`);
            const prunedD = trashedD && await waitEvent('desktop-selection-pruned', (e) => e.t >= tD && (e.removed || []).join() === nameDel31, 8000);
            const offD = prunedD && await nextKeyboardMode31(prunedD.t, 'keyboard-mode-off');
            prunedD && offD && offD.ok
              ? rep.pass('删尽灭相同相（硬断言③）：desktop-selection-pruned 后紧跟 keyboard-mode-off（面板还原不可聚焦）')
              : rep.fail(`删尽灭相同相未过：pruned=${JSON.stringify(prunedD)} next=${JSON.stringify(offD)}`);
          }
        }

        // d2. Del 多选弹确认层（desktop-trash-confirm-opened → 点确认 → 整份删除）+
        //     同向抑制（硬断言④）：选区生只发一次 on、确认层开不重发
        {
          const rB = await settledRect31(nameDelB31);
          const rC2 = await settledRect31(nameDelC31);
          const tM = Date.now();
          const okM1 = rB && await clickItem31(rB, 'Del 多选-点选');
          const selM = okM1 && await waitEvent('desktop-selected', (e) => e.t >= tM && e.name === nameDelB31, 4000);
          const okM2 = selM && rC2 && await (async () => {
            const hit = await ensurePanelHit(ptOf31(rC2), hwnd);
            if (!hit.ok) return false;
            w32.send([w32.keyInput(VK_CONTROL, w32.KEYDOWN)]);
            await sleep(60);
            w32.clickPhys(ptOf31(rC2).x, ptOf31(rC2).y, 'left');
            await sleep(60);
            w32.send([w32.keyInput(VK_CONTROL, w32.KEYUP)]);
            return true;
          })();
          const twoM = okM2 && await waitEvent('desktop-selection-toggled', (e) => e.t >= tM && e.selected === true && sameNames31(e.names, [nameDelB31, nameDelC31]), 4000);
          const fgM = twoM && await waitFg31();
          if (!fgM) {
            rep.fail('Del 多选用例前置（选中集两条+焦点）未达成');
          } else {
            tapKey31(VK_DELETE);
            const confirmM = await waitEvent('desktop-trash-confirm-opened', (e) => e.t >= tM && e.count === 2, 4000);
            if (!confirmM) {
              rep.fail('Del 多选未弹删除确认层（desktop-trash-confirm-opened 未见）');
            } else {
              const onCountM = readEvents().filter((e) => e.type === 'keyboard-mode-on' && e.t >= tM && e.t <= confirmM.t).length;
              onCountM === 1
                ? rep.pass('同向抑制（硬断言④）：[点选, confirm-opened] 内 keyboard-mode-on 计数=1——选区生只发一次，确认层开（浮层接管）不重发')
                : rep.fail(`同向抑制断言未过：[tM, confirm-opened] 内 keyboard-mode-on 计数=${onCountM}（期望 1）`);
              const ptOk = { x: rect31.left + Math.round((confirmM.confirm.x + confirmM.confirm.w / 2) * f), y: rect31.top + Math.round((confirmM.confirm.y + confirmM.confirm.h / 2) * f) };
              w32.clickPhys(ptOk.x, ptOk.y, 'left');
              const trashedM = await waitEvent('desktop-trashed', (e) => e.t >= confirmM.t && e.ok === true && sameNames31(e.names, [nameDelB31, nameDelC31]), 8000);
              const goneM = trashedM ? await (async () => {
                const dl = Date.now() + 8000;
                while (Date.now() < dl) { if (!fs.existsSync(probeDelB31) && !fs.existsSync(probeDelC31)) return true; await sleep(250); }
                return false;
              })() : false;
              const offM = trashedM && await nextKeyboardMode31(confirmM.t, 'keyboard-mode-off', 15000);
              trashedM && goneM && offM && offM.ok
                ? rep.pass('Del 多选弹确认层→确认整份删除：desktop-trashed ok=true 两条、文件离盘、keyboard-mode-off 同相还原')
                : rep.fail(`Del 多选存证异常：trashed=${JSON.stringify(trashedM)} gone=${goneM} next=${JSON.stringify(offM)}`);
            }
          }
        }

        // e. Ctrl+C / Ctrl+X：文件级复制/剪切（desktop/clipboard-copy/cut，via=keyboard）
        {
          const rE = await settledRect31(nameCopy31);
          const tE = Date.now();
          const okE = rE && await clickItem31(rE, 'Ctrl+C-点选');
          const selE = okE && await waitEvent('desktop-selected', (e) => e.t >= tE && e.name === nameCopy31, 4000);
          const fgE = selE && await waitFg31();
          if (!fgE) {
            rep.fail('复制/剪切用例键盘焦点未到手');
          } else {
            await ctrlKey31(VK_C);
            const clickedE = await waitEvent('desktop-copy-clicked', (e) => e.t >= tE && sameNames31(e.names, [nameCopy31]) && e.via === 'keyboard', 4000);
            const copiedE = clickedE && await waitEvent('desktop-copied', (e) => e.t >= tE && e.ok === true && sameNames31(e.names, [nameCopy31]), 8000);
            const clipE = (clickedE && copiedE) ? await fileDropList31(1) : null;
            const effOkE = !!clipE && clipE.effect === 1;
            clickedE && copiedE && clipE && sameNames31(clipE.names, [probeCopy31]) && effOkE
              ? rep.pass('Ctrl+C 复制选中（desktop/clipboard-copy）：via=keyboard + ok=true + FileDropList 实读 effect=1（资源管理器粘贴得副本）')
              : rep.fail(`Ctrl+C 存证异常：clicked=${JSON.stringify(clickedE)} copied=${JSON.stringify(copiedE)} 剪贴板=${JSON.stringify(clipE)}（names 空 = PS 通道空读环境败）`);
            const tX = Date.now();
            await ctrlKey31(VK_X);
            const clickedX = await waitEvent('desktop-cut-clicked', (e) => e.t >= tX && sameNames31(e.names, [nameCopy31]) && e.via === 'keyboard', 4000);
            const cutX = clickedX && await waitEvent('desktop-cut', (e) => e.t >= tX && e.ok === true && sameNames31(e.names, [nameCopy31]), 8000);
            const clipX = (clickedX && cutX) ? await fileDropList31(1) : null;
            const effOkX = !!clipX && clipX.effect === 2;
            const diskX = fs.existsSync(probeCopy31); // 剪切语义：写剪贴板不动盘面
            clickedX && cutX && clipX && sameNames31(clipX.names, [probeCopy31]) && effOkX && diskX
              ? rep.pass('Ctrl+X 剪切选中（desktop/clipboard-cut）：via=keyboard + ok=true + effect=2（粘贴为搬移）+ 文件仍在盘上')
              : rep.fail(`Ctrl+X 存证异常：clicked=${JSON.stringify(clickedX)} cut=${JSON.stringify(cutX)} 剪贴板=${JSON.stringify(clipX)} disk=${diskX}`);
            await blankClear31('复制剪切清场');
          }
        }

        // f. Ctrl+V 粘贴：剪贴板文件落桌面根（desktop/paste；剪贴板无文件时与菜单置灰
        //    同语义——desktop/paste ok=false 存证 rejected，键触发静默不弹层）
        {
          const seededF = await seedClipboard31([staged31]);
          if (!seededF) {
            rep.fail('Ctrl+V 用例剪贴板播种失败（Set-Clipboard -Path 两次尝试均未通过 FileDropList 回读核验——PS 通道环境因素，非面板行为断言失败）');
          } else {
            const rF = await settledRect31(nameCopy31);
            const tF = Date.now();
            const okF = rF && await clickItem31(rF, 'Ctrl+V-点选');
            const selF = okF && await waitEvent('desktop-selected', (e) => e.t >= tF && e.name === nameCopy31, 4000);
            const fgF = selF && await waitFg31();
            if (!fgF) {
              rep.fail('Ctrl+V 用例键盘焦点未到手');
            } else {
              await ctrlKey31(VK_V);
              const clickedF = await waitEvent('desktop-paste-clicked', (e) => e.t >= tF && e.via === 'keyboard', 4000);
              const pastedF = clickedF && await waitEvent('desktop-pasted', (e) => e.t >= tF && e.ok === true && sameNames31(e.pasted, [namePaste31]), 8000);
              const landedF = pastedF ? fs.existsSync(path.join(userDesktop31, namePaste31)) : false;
              const inPoolF = pastedF && await waitEvent('desktop-rendered', (e) => e.t >= tF && (e.names || []).includes(namePaste31), 8000);
              clickedF && pastedF && landedF && inPoolF
                ? rep.pass(`Ctrl+V 粘贴（desktop/paste）：via=keyboard + desktop-pasted ok=true pasted=[${namePaste31}]，文件落桌面根且入池`)
                : rep.fail(`Ctrl+V 存证异常：clicked=${JSON.stringify(clickedF)} pasted=${JSON.stringify(pastedF)} disk=${landedF} pool=${!!inPoolF}`);
              await blankClear31('粘贴清场');
            }
          }
        }

        // g. Esc 两层定序（硬断言⑤⑥）：菜单开着 Esc 只关菜单（reason=esc，选区不清、
        //    键盘模式不还原）；菜单已关再 Esc → 清空选区并同相还原 off
        {
          const rG = await settledRect31(nameCopy31);
          const tG = Date.now();
          const okG = rG && await clickItem31(rG, 'Esc 定序-点选');
          const selG = okG && await waitEvent('desktop-selected', (e) => e.t >= tG && e.name === nameCopy31, 4000);
          if (!selG) {
            rep.fail('Esc 定序用例点选失败');
          } else {
            const hitG = await ensurePanelHit(ptOf31(rG), hwnd);
            if (!hitG.ok) {
              rep.fail(`Esc 定序右键前置失败：${hitG.why}`);
            } else {
              w32.clickPhys(ptOf31(rG).x, ptOf31(rG).y, 'right');
              const menuG = await waitEvent('desktop-menu-opened', (e) => e.t >= tG, 4000);
              if (!menuG) {
                rep.fail('Esc 定序用例右键未弹单项菜单（desktop-menu-opened 未见）');
              } else {
                const tEsc1 = Date.now();
                tapKey31(VK_ESCAPE);
                const closed1 = await waitEvent('desktop-menu-closed', (e) => e.t >= tEsc1 && e.reason === 'esc', 4000);
                const leakClr1 = closed1 ? leaked31('desktop-selection-cleared', tEsc1) : null;
                const leakOff1 = closed1 ? readEvents().some((e) => e.type === 'keyboard-mode-off' && e.t >= tEsc1) : null;
                closed1 && leakClr1 === false && leakOff1 === false
                  ? rep.pass('Esc 第一层（硬断言⑤）：菜单开着只关菜单（desktop-menu-closed reason=esc），选区不清、keyboard-mode 不还原（无 cleared / 无 off 泄漏）')
                  : rep.fail(`Esc 第一层断言未过：closed=${JSON.stringify(closed1)} clearedLeak=${leakClr1} offLeak=${leakOff1}`);
                const tEsc2 = Date.now();
                tapKey31(VK_ESCAPE);
                const clr2 = await waitEvent('desktop-selection-cleared', (e) => e.t >= tEsc2, 4000);
                const off2 = clr2 && await nextKeyboardMode31(tEsc2, 'keyboard-mode-off');
                clr2 && off2 && off2.ok
                  ? rep.pass('Esc 第二层（硬断言⑥）：菜单已关 Esc 清空选区（desktop-selection-cleared）并同相还原 keyboard-mode-off')
                  : rep.fail(`Esc 第二层断言未过：cleared=${JSON.stringify(clr2)} next=${JSON.stringify(off2)}`);
                safeShot('31-esc-ordering');
              }
            }
          }
        }

        // h. 浮层优先（硬断言⑦⑧⑨）：选区在手激活搜索——浮层开不重发 on；Ctrl+A /
        //    Ctrl+V 不泄漏到桌面路由、搜索输入不受影响；Esc 归浮层（关层不清选区、
        //    键盘模式保持 on——浮层关而选区非空不互相踩）；最后空白清场灭相同相
        {
          const rH = await settledRect31(nameCopy31);
          const tH = Date.now();
          const okH = rH && await clickItem31(rH, '浮层优先-点选');
          const selH = okH && await waitEvent('desktop-selected', (e) => e.t >= tH && e.name === nameCopy31, 4000);
          const zoneH = selH ? latestSearchZone31() : null;
          if (!selH || !zoneH) {
            rep.fail(`浮层优先用例前置失败：sel=${!!selH} searchZone=${!!zoneH}`);
          } else {
            const ptH = { x: rect31.left + Math.round((zoneH.x + zoneH.w / 2) * f), y: rect31.top + Math.round((zoneH.y + zoneH.h / 2) * f) };
            const hitH = await ensurePanelHit(ptH, hwnd);
            if (!hitH.ok) {
              rep.fail(`浮层优先搜索激活前置失败：${hitH.why}`);
            } else {
              w32.clickPhys(ptH.x, ptH.y, 'left');
              const actH = await waitEvent('search-activated', (e) => e.t >= tH, 4000);
              const onCountH = actH ? readEvents().filter((e) => e.type === 'keyboard-mode-on' && e.t >= selH.t && e.t <= actH.t).length : -1;
              actH && onCountH === 1
                ? rep.pass('浮层开不重发 keyboard-mode-on（硬断言⑦）：search-activated 且 [selected, activated] 内 on 计数=1（选区生唯一一次）')
                : rep.fail(`浮层重发断言未过：act=${JSON.stringify(actH)} onCount=${onCountH}（期望 1）`);
              if (actH && onCountH === 1) {
                await ctrlKey31(VK_A);
                await ctrlKey31(VK_V);
                await sleep(600);
                const leakA = leaked31('desktop-selection-all', tH) || leaked31('desktop-selection-cleared', tH);
                const leakV = leaked31('desktop-paste-clicked', tH) || leaked31('desktop-pasted', tH);
                const searchAlive = !leaked31('search-deactivated', tH);
                !leakA && !leakV && searchAlive
                  ? rep.pass('浮层优先（硬断言⑧）：搜索激活期间 Ctrl+A / Ctrl+V 不接管（无 selection-all / paste-* 泄漏），搜索输入不受影响、层未收')
                  : rep.fail(`浮层优先断言未过：leakA=${leakA} leakV=${leakV} searchAlive=${searchAlive}`);
                const tEscH = Date.now();
                tapKey31(VK_ESCAPE);
                const deactH = await waitEvent('search-deactivated', (e) => e.t >= tEscH && e.reason === 'esc', 4000);
                const leakClrH = deactH ? leaked31('desktop-selection-cleared', tEscH) : null;
                const leakOffH = deactH ? readEvents().some((e) => e.type === 'keyboard-mode-off' && e.t >= tEscH) : null;
                deactH && leakClrH === false && leakOffH === false
                  ? rep.pass('Esc 归浮层（硬断言⑨）：search-deactivated reason=esc，选区保持、keyboard-mode 保持 on（浮层关而选区非空不互相踩）')
                  : rep.fail(`Esc 浮层定序断言未过：deact=${JSON.stringify(deactH)} clearedLeak=${leakClrH} offLeak=${leakOffH}`);
                const tEndH = Date.now();
                const blanked = await blankClear31('浮层优先清场');
                const clrH = blanked && await waitEvent('desktop-selection-cleared', (e) => e.t >= tEndH, 4000);
                const offH = clrH && await nextKeyboardMode31(tEndH, 'keyboard-mode-off');
                clrH && offH && offH.ok
                  ? rep.pass('浮层关后清选区：灭相同相（硬断言）keyboard-mode-off——门控收官归零')
                  : rep.fail(`收官灭相未过：cleared=${JSON.stringify(clrH)} next=${JSON.stringify(offH)}`);
                safeShot('31-overlay-priority');
              }
            }
          }
        }
      } finally {
        for (const p of [probeCopy31, probeDel31, probeDelB31, probeDelC31, probeBat31]) {
          try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* 尽力清理 */ }
        }
        try { fs.unlinkSync(marker31); } catch { /* 尽力清理 */ }
        try {
          for (const n of fs.readdirSync(userDesktop31)) {
            if (n.startsWith(`DECK31-PASTE-${t31}`)) {
              try { fs.unlinkSync(path.join(userDesktop31, n)); } catch { /* 尽力清理 */ }
            }
          }
        } catch { /* 尽力清理 */ }
        if (staging31) { try { fs.rmSync(staging31, { recursive: true, force: true }); } catch { /* 尽力 */ } }
        clipboardSet(savedClip31); // 电池不得改变用户剪贴板内容（P5.15 同法）
        w32.moveMousePhys(safePt.x, safePt.y);
      }
    })();

    // —— P7S 工单07 搜索并入：accept_search 电池适配（scripts/accept_search.py 随 Tk 窗退役）——
    // 链路：探针文件直连引擎取证 → 热区点击激活（前台门校验）→ 剪贴板粘贴探针词
    // （绕开输入法合成，旧电池同法；IME 机制本体由探针01-D 在同窗体实证）→ 实时结果 →
    // ↑/↓ 选择 → Enter 打开 → Ctrl+Enter 定位 → ESC/失焦退待机 → 假端口复现 ENGINE OFFLINE。
    rep.beginSegment('P7S');
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
        // 工单50：最小覆写同样带 taskbar.enabled=false——缺段回落默认开启会藏掉原生
        // 任务栏，而探针面板随后被 /F 清杀（无还原路径），P8 托盘扫描将对着隐藏态空扫
        fs.writeFileSync(configPathS, JSON.stringify({ search: { port: await freePort() }, taskbar: { enabled: false } }, null, 2) + '\n');
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
    rep.beginSegment('P8S');
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
    rep.beginSegment('P6');
    const configBackup = backupConfigB();
    try {
      await stopPanel();
      // 工单50：几何探针也要带上 taskbar.enabled=false——最小覆写会丢 taskbar 段回落
      // 默认开启，条带隐藏原生任务栏后 P8 托盘识别色扫描（Shell_TrayWnd 矩形）全灭
      fs.writeFileSync(CONFIG_FILE_B, JSON.stringify({ panel: { x: 60, y: 60, width: 1100, height: 800 }, taskbar: { enabled: false } }, null, 2) + '\n');
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
    rep.beginSegment('P7');
    {
      // 计数只数面板 pid 的 Chrome 窗（工单49 起同进程还有 DECK-TASKBAR 条带窗；
      // 系统级计数会被无关 Electron/Chrome 窗与条带建窗时序扰动——49 实测 3→4 假阳性）
      const chromeOfPanel = () => w32.topLevelWindows().filter(
        (h) => w32.className(h) === 'Chrome_WidgetWin_1' && w32.threadIdOf(h).pid === panelPid).length;
      const chromeBefore = chromeOfPanel();
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
      const chromeAfter = chromeOfPanel();
      w32.IsWindow(hwnd) && chromeAfter === chromeBefore
        ? rep.pass(`单实例守卫：原面板窗完好（Chrome 窗计数 ${chromeBefore} → ${chromeAfter}），屏上仍只有一个面板`)
        : rep.fail(`单实例守卫后面板状态异常（原窗在=${w32.IsWindow(hwnd)}，Chrome 窗计数 ${chromeBefore} → ${chromeAfter}）`);
    }

    // —— P8 托盘图标已注册且可上屏 ——
    // Win11 新图标默认收进溢出区：经 NotifyIconSettings 的 IsPromoted 提升到可见区，
    // 以识别色（琥珀）像素 + 截图断言「图标在系统托盘里」。
    rep.beginSegment('P8');
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
    rep.beginSegment('P9');
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
        await captureFast(rect1, '03-wind-immune');
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
        const minimizedPng = await captureFast(rect1, '03-wind-minimized');
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
      // 恢复后的重钉（票01 实施要点）：还原记事本，普通窗应重新盖住面板。
      // SW_RESTORE 后记事本按自己记住的几何回位（Win11 记事本实测会漂出 P4 摆位，
      // 重叠点落空命中 Progman——工单27 轮次起慢性失败），先强制复位到 P4 摆位再断言。
      w32.ShowWindow(notepad.hwnd, SW_RESTORE);
      await sleep(600);
      if (win32.IsWindow(notepad.hwnd)) {
        w32.SetWindowPos(notepad.hwnd, 0, 1000, 200, 1400, 900,
          w32.SWP_NOZORDER | w32.SWP_NOACTIVATE);
        await sleep(400);
      }
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
    rep.beginSegment('P10');
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

    // —— P10E 工单83 设置浮层「退出面板」按钮：托盘不可达时的本体退出路径 ——
    // 托盘退出对真人也不总可达（Win11 默认把新托盘图标折叠进溢出区，且右键菜单不可
    // 自动化——P10 探针结论；任务栏特性未完成），面板本体必须有退出入口。点击 →
    // settings-exit-clicked → app/quit → 与托盘菜单/WM_CLOSE 同一 before-quit 收敛。
    // 断言：clicked 在档、quit 在档、窗口销毁、主进程退出。P9 随后自会重启面板（其
    // 段首重启不受此处面板死亡影响）。点击走热区（settings-exit 随浮层显隐进声明）。
    rep.beginSegment('P10E');
    {
      const t0e = Date.now();
      child = launchPanel();
      hwnd = await waitPanelWindow(20000, t0e);
      if (!hwnd) throw new Error('P10E 重启后未见面板窗口');
      panelPid = w32.threadIdOf(hwnd).pid;
      await sleep(2500); // boot + 热区声明落地（settings-btn 进声明，06/08 同等待口径）
      const bzE = latestZoneOf('settings-btn');
      if (!bzE) {
        rep.fail('P10E：settings-btn 未进热区（无法开浮层点退出，工单83 用例未跑）');
      } else {
        await occludedClickAt(ptOfZoneAt(w32.rectOf(hwnd), bzE), '设置入口');
        const openedE = await waitEvent('settings-opened', (e) => e.t >= t0e, 3000);
        await sleep(350); // 浮层热区声明落地（settings-exit 随开层进声明）
        const ezE = latestZoneOf('settings-exit');
        if (!openedE || !ezE) {
          rep.fail(`P10E：设置浮层未开或退出按钮未进热区（opened=${JSON.stringify(openedE)}，exit=${JSON.stringify(ezE)}）`);
        } else {
          await occludedClickAt(ptOfZoneAt(w32.rectOf(hwnd), ezE), '退出面板按钮');
          const clickedE = await waitEvent('settings-exit-clicked', (e) => e.t >= t0e, 3000);
          const tExitE = Date.now();
          const deadE = await (async () => {
            const deadline = Date.now() + 10000;
            while (Date.now() < deadline) {
              await sleep(200);
              if (!isAlive(panelPid) && !w32.IsWindow(hwnd)) return true;
            }
            return false;
          })();
          deadE
            ? rep.pass(`退出面板按钮闭环：settings-exit-clicked → app/quit → 窗口销毁、主进程（pid=${panelPid}）退出（耗时 ${Date.now() - tExitE}ms）`)
            : rep.fail(`退出面板按钮未达成完整退出（clicked=${JSON.stringify(clickedE)}，窗口销毁=${!w32.IsWindow(hwnd)}，pid=${panelPid} 存活=${isAlive(panelPid)}）`);
          readEvents().some((e) => e.type === 'quit' && e.t >= t0e)
            ? rep.pass('退出按钮走 before-quit 同一收敛（quit 存证在档，桌面图标/原生任务栏/托盘随之还原）')
            : rep.fail('退出按钮无 quit 存证（未走 before-quit 收敛）');
        }
      }
    }

    // —— P9B 工单09 会话行直达：点击会话行 → 工具窗口置前；工具未运行则启动。
    // （段号 P9B：与工单03 的 P9（Win+D 收起桌面）撞号，工单114 归账时辨析——
    //   段号在电池内须唯一，清单 app/accept/manifest.json 为准。）
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
    //    探针窗口按「归属 exe 名 = charmap」识别，只关本段自己观测到的那一个 hwnd，
    // 不做「按类名遍历全机关闭」——
    // ④ 位置约束：本段是电池**最后一段**（排在 P10 之后、清场之前）。它要为改 config
    //    而重启面板；排在中间会连带搅乱 P5「杀进程还原」的图标状态机（两轮实证确定性失败）。
    //    排最后则谁也不扰动，清场仍照常收尾。代价是此时对照记事本还开着——只关电池自己
    //    记录的那一扇（下面 try 开头处），P7S 搜索段的记事本它自己段尾已关。——
    rep.beginSegment('P9B');
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
      /** 点探针那一行并等结果。失败须能自证原因（裸 null 无法区分「没找到行」与「点了没反应」）。
       * 工单16：行矩形自「最新事件」到点击落地之间，会话列表会按活跃度重排——操作者自己的
       * 会话就活在被扫描的项目里（电池本身即跑在其中一场会话中），矩形抓完即过期，点中的
       * 是别人的行（真机实证：session-focus-result tool=zcode，聚焦了操作者的 ZCode 主窗
       * 而非探针 charmap，探针行选行匹配本身无罪）。故以结果自证：探针行挂在 qoder 工具
       * 槽位，session-focus-result.tool === 'qoder' 才是探针行的回音；其余（点中他人行的
       * 异槽回音）视为重排竞态，取新矩形重试。 */
      const clickProbeRow = async (t0, why) => {
        for (let attempt = 1; attempt <= 3; attempt++) {
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
          const tAttempt = Date.now();
          await occludedClickAt(pt, `会话行(${PROBE_TAG})`);
          const res = await waitEvent('session-focus-result',
            (e) => e.t >= Math.max(t0, tAttempt) && e.tool === 'qoder', 6000);
          if (res) return res;
          // 没等到探针行回音：大概率点中了重排后的他人行（异槽回音）——如实记录并重试
          const foreign = lastEvent('session-focus-result', (e) => e.t >= tAttempt, 0);
          rep.note(`${why} 第 ${attempt}/3 次点击未收到探针行回音`
            + `（${foreign ? `点中异槽行 tool=${foreign.tool}${foreign.id ? ' id=' + foreign.id : ''}` : '无任何回音'}）`
            + `——会话列表活跃重排竞态，取新矩形重试`);
        }
        return null;
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
    rep.beginSegment('P11');
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
        const builtinIds = ['clock', 'weather', 'sessions'];
        const builtinMounted = builtinIds.filter((id) => lastEvent('plugin-mounted', (e) => e.id === id, since));
        // 观感一致性的机器可查部分：三张卡都进了热区声明（都在场、都在点击穿透模型里），
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
          ? rep.pass(`桌面组件·内置三卡自举：${builtinIds.join('/')} 三张信息卡均经插件契约装载渲染，`
            + `且三张都进了热区声明（时钟卡矩形 ${CARD_DIP.x},${CARD_DIP.y} ${CARD_DIP.w}x${CARD_DIP.h} 与 index.html 一致；`
            + `像素级观感按惯例人工核验 04-cards-*.png）`)
          : rep.fail(`桌面组件·内置三卡自举未过：经插件契约装载 ${builtinMounted.join('/') || '无'}`
            + `（缺 ${builtinIds.filter((i) => !builtinMounted.includes(i)).join('/') || '无'}）；`
            + `热区声明 ${zonesOk ? '齐' : `缺 ${builtinIds.filter((i) => !cardZones.has(`${i}-card`)).join('/') || '无'}`}；`
            + `时钟卡矩形 ${geomOk ? '一致' : `不符（实得 ${JSON.stringify(cardZones.get('clock-card') || null)}）`}`);

        // 0.5 Qoder 状态块退役（工单03）：热区声明按 id 找 qoder-card 应缺席，
        //     会话卡加高补位——top 152 不动、高 348→522（吞 16px 间隙 + 158px 状态块槽）。
        //     硬件卡随工单59 一并退役，其 top 690 原槽位不再有卡片。
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
    // 面板真死过的话，这里是唯一能说清「为什么死」的地方（首跑 52 fail 排查卡在这）：
    // 子进程 stderr 尾 + 进程存活 + 当时顶层窗全景 + 最后一条存证事件。
    try {
      let alive = 'n/a';
      if (panelPid) { try { process.kill(panelPid, 0); alive = 'true'; } catch { alive = 'false'; } }
      const wins = w32.topLevelWindows().map((h) => {
        let cls = '?', pid = 0, r = null;
        try { cls = w32.className(h); pid = w32.threadIdOf(h).pid; r = w32.rectOf(h); } catch { /* 窗已销毁 */ }
        return `${cls}#${pid}@${r ? `${r.left},${r.top} ${r.right - r.left}x${r.bottom - r.top}` : '?'}`;
      });
      rep.note(`死因取证：panelPid=${panelPid} 存活=${alive}；stderr 尾=${(stderrTail || '(空)').slice(-1500).replace(/\s+/g, ' ')}`);
      rep.note(`死因取证·顶层窗全景（${wins.length}）：${wins.join(' | ')}`);
      const lastEvt = readEvents().slice(-1)[0];
      rep.note(`死因取证·最后一条存证：${lastEvt ? `${lastEvt.type} @${lastEvt.t}` : '(无)'}`);
    } catch (diagErr) {
      rep.note(`死因取证自身失败：${diagErr && diagErr.message}`);
    }
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
    for (const p of deckProbeFiles) { try { fs.unlinkSync(p); } catch { /* 已不在盘上 */ } }
    deckProbeFiles = [];
    // 工单112：收尾清场换面板控制模块——强退后验证消失；「需重启清障」只入账不中止
    // （清场不掩盖真结局），随后窗枚举核验无任何遗留面板本体窗（双面板级联的末道闸）。
    const cleared = await stopPanel();
    if (cleared && cleared.gone === false) {
      rep.exclude(`清场核验：面板强退失败：强杀后有界等待内仍存活（pid=${cleared.pidsLeft.join(', ')}）`, '清场后仍有面板进程存活', 'panel-forcekill');
    }
    try {
      const leftover = findPanelWindows(w32.topLevelWindows().map((h) => {
        let cls = '?', title = '', pid = 0;
        try { cls = w32.className(h); title = windowTitle(h); pid = w32.threadIdOf(h).pid; } catch { /* 已销毁 */ }
        return { cls, title, pid, selfPid: process.pid };
      }));
      leftover.length === 0
        ? rep.note('清场核验：无遗留面板本体窗')
        : rep.exclude(`清场核验：仍有 ${leftover.length} 扇面板本体窗在场（pid=${leftover.map((c) => c.pid).join(', ')}）——需重启清障`, '收尾清场后面板窗仍存在', 'panel-leftover');
    } catch (e) { rep.note(`清场核验·窗枚举异常: ${e && e.message}`); }
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
    // 工单50 清场核验：原生任务栏若留隐藏态（异常中断等），走 --icon-restore 自救通道
    // （工单50 起该通道同还原原生任务栏）——电池不得给用户留无系统入口的桌面
    try {
      if (!w32.nativeTaskbarVisible()) {
        spawnSync(process.execPath, ['.', '--icon-restore'], { cwd: APP_ROOT, encoding: 'utf8', timeout: 20000 });
        await sleep(1200);
        w32.ensureNativeTaskbarVisible(); // 自救通道异常的最后一道兜底
      }
      rep.note(`原生任务栏清场核验：visible=${w32.nativeTaskbarVisible()}（电池前=${nativeTaskbarBase}）`);
    } catch (e) { rep.note(`原生任务栏清场核验异常: ${e && e.message || e}`); }
    // 工单50 清场：还原 config.json（含开电池时临时置入的 taskbar.enabled=false）
    try {
      if (configBackupMain === null) { try { fs.unlinkSync(CONFIG_FILE_MAIN); } catch { /* 尽力 */ } }
      else { fs.writeFileSync(CONFIG_FILE_MAIN, configBackupMain); }
      rep.note('config.json 已还原电池前原文');
    } catch (e) { rep.note(`config 清场异常: ${e && e.message || e}`); }
    // 工单06 清场：还原摆位存储到电池前状态（种子只服务断言，不得改变用户真实摆位）
    try {
      if (layoutBackup === null) fs.unlinkSync(layoutFile);
      else fs.writeFileSync(layoutFile, layoutBackup);
      rep.note(`摆位存储清场：${layoutBackup === null ? '已删除（电池前不存在）' : '已还原备份'}`);
    } catch (e) { rep.note(`摆位存储清场异常: ${e && e.message || e}`); }
    restoreDesktop();
    try { w32.SetCursorPos(savedCursor.x, savedCursor.y); } catch { /* 尽力 */ }
  }
  return rep.verdict();
}

module.exports = function battery() {
  app.whenReady().then(() => main().then((v) => {
    // 工单110 三态退出码：PASS=0 / FAIL-CODE=1 / FAIL-ENV=2（guard 与自动化按此分辨结局）
    process.exitCode = v.exitCode;
    setTimeout(() => app.exit(v.exitCode), 300);
  })).catch((e) => {
    console.error('BATTERY CRASH:', e && e.stack || e);
    app.exit(2);
  });
};
