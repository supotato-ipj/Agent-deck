'use strict';
// 工单48 托盘 spike 验收（路线 C 闸门）：控制器以 --accept-tray 身份运行，
// 拉起 --tray-spike 面板子进程（托盘宿主在其数据面里），逐项验收：
//   P1 竞争窗口赢下投递（探针 NIM_ADD 到达我方而非系统托盘）
//   P2 泵延迟无感知（Shell_NotifyIconW 同步调用快速返回 true）
//   P3 真实托盘图标在验收页像素正确渲染（面板自绘琥珀图标为基准真值）
//   P4 投递改道证据（spike 期间真托盘条带无琥珀像素）
//   P5 真实字节语料固化（corpus JSONL 可解析、含 NIM_ADD）
//   P6 交还：面板退出后广播 TaskbarCreated，真托盘回归 explorer
// 运行：npm run accept:tray（= electron . --accept-tray）。
const { app, BrowserWindow, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const win32 = require('./lib/win32');
const { Report } = require('./lib/report');

const APP_ROOT = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(APP_ROOT, 'config.json');
const EVENTS_FILE = path.join(__dirname, 'evidence', '48-runtime-events.jsonl');
const CORPUS_FILE = path.join(__dirname, 'evidence', '48-tray-corpus.jsonl');
const AMBER = [245, 166, 35]; // 面板托盘图标识别色（tray.ts #f5a623）
const SPIKE_TITLE = 'TRAY-SPIKE-ACCEPT';
const PROBE_UID = 0xd3c44801;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 原生任务栏兜底还原（工单50：spike 面板若建条带会隐藏原生任务栏；本电池以
// taskbar.enabled=false 运行，清场仍做视图事实核验，不给用户留隐藏态；
// 判据共用 accept/lib/win32.js 导出，四电池单点维护）
const { ensureNativeTaskbarVisible } = win32;

function capture(rect, name) {
  const out = path.join(__dirname, 'evidence', name + '.png');
  const r = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(__dirname, 'lib', 'capture.ps1'),
    '-Out', out, '-X', String(rect.left), '-Y', String(rect.top),
    '-W', String(rect.right - rect.left), '-H', String(rect.bottom - rect.top),
  ], { encoding: 'utf8', timeout: 20000 });
  if (r.status !== 0 || !fs.existsSync(out)) throw new Error(`capture 失败: ${r.stderr || r.stdout}`);
  return out;
}

// 区域内接近识别色的像素计数（spike 页/真托盘条带的琥珀存在性断言）
function colorHits(pngPath, rgb, tol = 20) {
  const img = nativeImage.createFromPath(pngPath);
  const s = img.getSize();
  const buf = img.toBitmap();
  let hit = 0;
  for (let i = 0; i + 3 < buf.length; i += 4) {
    if (Math.abs(buf[i + 2] - rgb[0]) <= tol && Math.abs(buf[i + 1] - rgb[1]) <= tol && Math.abs(buf[i] - rgb[2]) <= tol) hit++;
  }
  return hit;
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

// 窗口标题（battery.js 同款 koffi 缓冲形态）
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
const shell32 = koffi.load('shell32.dll');
const gdi32 = koffi.load('gdi32.dll');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(uintptr_t hWnd, uint16 *buf, int nMax)');
const LoadIconW = user32.func('uintptr_t __stdcall LoadIconW(uintptr_t hInst, uintptr_t name)');
const RegisterWindowMessageW = user32.func('uint32 __stdcall RegisterWindowMessageW(const char16_t *name)');
const ShellNotifyIconW = shell32.func('bool __stdcall Shell_NotifyIconW(uint32 dwMessage, void *nid)');
const GetDC = user32.func('uintptr_t __stdcall GetDC(uintptr_t hWnd)');
const ReleaseDC = user32.func('int __stdcall ReleaseDC(uintptr_t hWnd, uintptr_t hdc)');
const GetClientRect = user32.func('bool __stdcall GetClientRect(uintptr_t hWnd, void *rect)');
const PrintWindow = user32.func('bool __stdcall PrintWindow(uintptr_t hWnd, uintptr_t hdc, uint32 flags)');
const CreateCompatibleDC = gdi32.func('uintptr_t __stdcall CreateCompatibleDC(uintptr_t hdc)');
const CreateDIBSection = gdi32.func('uintptr_t __stdcall CreateDIBSection(uintptr_t hdc, void *bmi, uint32 usage, void *bits, uintptr_t sec, uint32 off)');
const SelectObject = gdi32.func('uintptr_t __stdcall SelectObject(uintptr_t hdc, uintptr_t h)');
const DeleteDC = gdi32.func('bool __stdcall DeleteDC(uintptr_t hdc)');
const DeleteObjectG = gdi32.func('bool __stdcall DeleteObject(uintptr_t h)');
const GetDIBits = gdi32.func('int __stdcall GetDIBits(uintptr_t hdc, uintptr_t hbm, uint32 start, uint32 lines, void *bits, void *bi, uint32 usage)');

// PrintWindow 直拍窗口客户区：被遮挡/非前台也能拿到真实内容（截屏按屏幕区域抓会拍到遮挡窗）。
// PW_RENDERFULLCONTENT(2) 让 Chromium 离屏内容也落进 DC。
function captureWindow(hwnd, name) {
  const rect = Buffer.alloc(16);
  if (!GetClientRect(hwnd, rect)) throw new Error('GetClientRect 失败');
  const w = rect.readInt32LE(8); const h = rect.readInt32LE(12);
  if (w <= 0 || h <= 0) throw new Error(`客户区尺寸异常 ${w}x${h}`);
  const bmi = Buffer.alloc(40);
  bmi.writeUInt32LE(40, 0); bmi.writeInt32LE(w, 4); bmi.writeInt32LE(-h, 8); // 负 = 顶向下
  bmi.writeUInt16LE(1, 12); bmi.writeUInt16LE(32, 14);
  const screen = GetDC(0);
  const mem = CreateCompatibleDC(screen);
  const dib = CreateDIBSection(mem, bmi, 0, null, 0, 0);
  if (!dib) throw new Error('CreateDIBSection 失败');
  const old = SelectObject(mem, dib);
  try {
    if (!PrintWindow(hwnd, mem, 2)) throw new Error('PrintWindow 失败');
    SelectObject(mem, old); // GetDIBits 要求位图不在 DC 中
    const pixels = Buffer.alloc(w * h * 4);
    if (GetDIBits(mem, dib, 0, h, pixels, bmi, 0) !== h) throw new Error('GetDIBits 失败');
    for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255; // BI_RGB 不带 alpha，强制不透明避免预乘除零
    const out = path.join(__dirname, 'evidence', name + '.png');
    fs.writeFileSync(out, nativeImage.createFromBitmap(pixels, { width: w, height: h }).toPNG());
    return out;
  } finally {
    DeleteObjectG(dib);
    DeleteDC(mem);
    ReleaseDC(0, screen);
  }
}

function windowTitle(hwnd) {
  const buf = Buffer.alloc(1024);
  const n = GetWindowTextW(hwnd, buf, 512);
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(buf.readUInt16LE(i * 2));
  return s;
}

function hwndOf(bw) {
  const v = koffi.decode(bw.getNativeWindowHandle(), 'uintptr_t');
  return typeof v === 'bigint' ? Number(v) : v;
}

// explorer 的真托盘（竞争窗口在场时 FindWindow 命中我方，按属主进程 pid 找真身）
function explorerPid() {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', '(Get-Process explorer -ErrorAction Stop).Id'], { encoding: 'utf8', timeout: 10000 });
  const pid = parseInt((r.stdout || '').trim(), 10);
  return Number.isFinite(pid) ? pid : null;
}

function realTrayHwnd() {
  const pid = explorerPid();
  if (pid === null) return null;
  return win32.topLevelWindows().find((h) =>
    win32.className(h) === 'Shell_TrayWnd' && win32.threadIdOf(h).pid === pid) || null;
}

function broadcastTaskbarCreated() {
  const msg = RegisterWindowMessageW('TaskbarCreated');
  win32.PostMessageW(0xffff, msg, 0, 0);
}

async function main() {
  const rep = new Report('48-tray-spike');
  try { fs.unlinkSync(EVENTS_FILE); } catch { /* 首次不存在 */ }
  try { fs.unlinkSync(CORPUS_FILE); } catch { /* 首次不存在 */ }

  // 工单50：任务栏插件默认开启会建条带并隐藏原生任务栏——本电池的 P1 投递竞争 /
  // P4 改道证据都要对着「可见的现役真托盘」取证，全程以 taskbar.enabled=false 运行
  // （显隐链路归 49/50 专电池），清场还原原文。
  const configBackup = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, 'utf8') : null;
  {
    const cfg = configBackup ? JSON.parse(configBackup) : {};
    cfg.taskbar = { ...(cfg.taskbar ?? {}), enabled: false };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    rep.note('已临时置 taskbar.enabled=false（托盘 spike 需现役真托盘在场，清场还原）');
  }

  // 互斥侦察基线：真托盘属主应为 explorer（RetroBar/Seelen/Zebar 在场则本验收不可判）
  const trayBase = realTrayHwnd();
  if (trayBase) {
    rep.pass(`互斥侦察：现役 Shell_TrayWnd 属主是 explorer（0x${trayBase.toString(16)}）——无第三方托盘托管冲突`);
  } else {
    rep.fail('互斥侦察失败：未找到 explorer 的 Shell_TrayWnd（存在 RetroBar/Seelen 类竞争者时本验收不可判）');
  }

  let child = null;
  let probeWin = null;
  const cleanup = async () => {
    try { probeWin && probeWin.destroy(); } catch { /* 尽力 */ }
    if (child) {
      try { child.kill(); } catch { /* 尽力 */ }
      await sleep(600);
      try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 尽力 */ }
      child = null;
    }
    // 交还真托盘：我方窗口随进程死亡消失，广播 TaskbarCreated 让响应的应用重新注册回 explorer
    broadcastTaskbarCreated();
    await sleep(2500);
  };

  try {
    // —— P0 拉起 spike 面板 ——
    child = spawn(process.execPath, ['.', '--tray-spike'], {
      cwd: APP_ROOT,
      env: { ...process.env, DECK_EVENT_LOG: EVENTS_FILE, DECK_TRAY_CORPUS: CORPUS_FILE },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderrTail = '';
    child.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-4000); });

    const ready = await waitEvent('tray-host-ready', null, 25000);
    if (!ready) throw new Error(`25s 内未见 tray-host-ready\nstderr:\n${stderrTail}`);
    rep.pass(`托盘宿主上线：竞争窗口 hwnd=0x${Number(ready.hwnd).toString(16)}，接管前真托盘=0x${Number(ready.realTrayHwnd).toString(16)}`);

    // —— P1 投递竞争：置顶重申持续赢下 FindWindow ——
    const win1 = await waitEvent('tray-competition', (e) => e.win === true, 8000);
    win1
      ? rep.pass('投递竞争：FindWindow(Shell_TrayWnd) 命中我方竞争窗口（置顶重申生效）')
      : rep.fail('投递竞争：未见 tray-competition win=true 存证');

    // —— P2 泵延迟无感知：控制器直调 Shell_NotifyIconW，计时 + 返回值 ——
    probeWin = new BrowserWindow({ show: false, skipTaskbar: true });
    const probeHwnd = hwndOf(probeWin);
    const { encodeNotifyIconData, NIM_ADD, NIM_DELETE, NIF_MESSAGE, NIF_ICON, NIF_TIP } =
      require(path.join(APP_ROOT, 'dist', 'main', 'trayhost', 'protocol.js'));
    const hicon = Number(LoadIconW(0, 32512)); // IDI_APPLICATION
    const nid = encodeNotifyIconData({
      arch: 'x64', version: 3, hwnd: probeHwnd, uid: PROBE_UID,
      flags: NIF_MESSAGE | NIF_ICON | NIF_TIP, callbackMessage: 0x8000 + 77,
      hicon, tooltip: 'DECK-SPIKE-PROBE',
    });
    const t0 = Date.now();
    const okAdd = ShellNotifyIconW(NIM_ADD, nid);
    const addMs = Date.now() - t0;
    okAdd && addMs < 500
      ? rep.pass(`泵延迟无感知：探针 NIM_ADD 返回 true，同步耗时 ${addMs}ms（<500ms，调用方无挂起）`)
      : rep.fail(`泵延迟异常：NIM_ADD ok=${okAdd} 耗时 ${addMs}ms`);
    const delivered = await waitEvent('tray-event', (e) => e.kind === 'add' && Number(e.hwnd) === probeHwnd, 6000);
    delivered
      ? rep.pass(`投递改道实证：探针 NIM_ADD 到达我方宿主（key=${delivered.key} tooltip=${JSON.stringify(delivered.tooltip)}）而非系统托盘`)
      : rep.fail('探针 NIM_ADD 未到达我方宿主（投递未赢下）');
    const t1 = Date.now();
    const okDel = ShellNotifyIconW(NIM_DELETE, nid);
    const delMs = Date.now() - t1;
    const deleted = await waitEvent('tray-event', (e) => e.kind === 'delete' && Number(e.hwnd) === probeHwnd, 6000);
    okDel && delMs < 500 && deleted
      ? rep.pass(`探针 NIM_DELETE 同样快速送达（${delMs}ms）`)
      : rep.fail(`NIM_DELETE 异常：ok=${okDel} 耗时=${delMs}ms 事件=${JSON.stringify(deleted)}`);

    // —— P3 真实托盘图标渲染：面板自身琥珀托盘图标（Electron 真 Shell_NotifyIcon 调用方）为基准真值 ——
    // Electron 的注册是 add(空) → modify(icon) → modify(tip) 三条独立调用，按 key 聚合断言。
    const ownTip = await waitEvent('tray-event', (e) => e.tooltip === 'AGENT DECK 独立面板', 20000);
    const ownKey = ownTip && ownTip.key;
    const ownIconEvt = ownKey && readEvents().find((e) => e.type === 'tray-event' && e.key === ownKey && e.hasIcon);
    ownKey && ownIconEvt
      ? rep.pass(`真实图标流量：面板自身托盘图标（key=${ownKey}）带像素到达（${ownIconEvt.w}x${ownIconEvt.h}），tooltip 同键更新`)
      : rep.fail(`未收齐面板自身托盘图标事件（tip=${JSON.stringify(ownTip)} icon=${JSON.stringify(ownIconEvt)}）`);
    const others = readEvents().filter((e) => e.type === 'tray-event' && e.kind === 'add' && e.tooltip !== 'AGENT DECK 独立面板');
    const otherKeys = [...new Set(others.map((e) => e.key))];
    rep.note(`TaskbarCreated 收编存量：其余 add 事件 ${others.length} 条 / 图标 ${otherKeys.length} 个：${otherKeys.slice(0, 8).map((k) => {
      const ev = others.find((e) => e.key === k);
      return `${JSON.stringify(ev && ev.tooltip) || k}`;
    }).join('、') || '（无——存量应用未响应广播）'}`);

    // —— P3b 验收页像素正确：spike 窗截图应有琥珀簇（非占位图）——
    const boot = readEvents().filter((e) => e.type === 'boot').pop();
    const panelPid = boot && boot.pid;
    let spikeHwnd = null;
    const winDeadline = Date.now() + 8000;
    while (Date.now() < winDeadline && !spikeHwnd) {
      spikeHwnd = win32.topLevelWindows().find((h) =>
        win32.threadIdOf(h).pid === panelPid && win32.className(h) === 'Chrome_WidgetWin_1' && windowTitle(h) === SPIKE_TITLE) || null;
      if (!spikeHwnd) await sleep(200);
    }
    if (!spikeHwnd) {
      rep.fail('未找到 spike 验收页窗口');
    } else {
      // 页面经 IPC 收事件有延迟（did-finish-load 前入暂存队列补发），等首波事件落页再拍
      await sleep(1500);
      const shot = captureWindow(spikeHwnd, '48-spike-page');
      const hits = colorHits(shot, AMBER);
      hits >= 40
        ? rep.pass(`验收页像素正确：spike 页内琥珀像素 ${hits} 个（真图标渲染，非占位图；实拍 48-spike-page.png）`)
        : rep.fail(`验收页未见琥珀像素（命中 ${hits}）——图标未渲染或像素错误`);

      // —— P3c 第三方像素正确：取一条第三方带像素事件的主色真值（宿主提取图标本体的量化众数），
      // 页面应渲染出同色簇——渲染像素与提取像素互为印证。只取饱和色（避开页面底色/灰图标的假命中）——
      const tp = readEvents().find((e) =>
        e.type === 'tray-event' && e.hasIcon && Array.isArray(e.dom) && e.key !== ownKey &&
        Math.max(...e.dom) - Math.min(...e.dom) > 40);
      if (!tp) {
        rep.fail('无带饱和主色真值的第三方图标事件可断言');
      } else {
        const tpHits = colorHits(shot, tp.dom, 24);
        tpHits >= 40
          ? rep.pass(`第三方图标像素正确：${JSON.stringify(tp.tooltip || tp.key)} 主色 rgb(${tp.dom}) 页面命中 ${tpHits} 像素（真值来自宿主提取的图标本体）`)
          : rep.fail(`第三方图标 ${JSON.stringify(tp.tooltip || tp.key)} 主色 rgb(${tp.dom}) 页面仅命中 ${tpHits} 像素——渲染与提取不符`);
      }
    }

    // —— P4 投递改道旁证：真托盘条带此刻无琥珀（图标被我方吞下）——
    const realTray = realTrayHwnd();
    if (!realTray) {
      rep.note('真托盘窗口未找到（P4 跳过）');
    } else {
      const stripShot = capture(win32.rectOf(realTray), '48-real-tray-strip');
      const stray = colorHits(stripShot, AMBER);
      // 少量命中是截图抗锯齿/系统图标底色噪声（电池验收先例以 <40 为噪声下限），阈值内视为无琥珀
      stray < 40
        ? rep.pass(`投递改道旁证：真托盘条带琥珀像素 ${stray} 个（<40 噪声阈值，面板图标未落入系统托盘）`)
        : rep.fail(`真托盘条带仍有琥珀像素 ${stray} 个（投递未完全改道）`);
    }

    // —— P5 字节语料：JSONL 可解析、含 NIM_ADD 负载（dwMessage 用 dist 的协议解码，不手写偏移）——
    let corpus = [];
    try {
      corpus = fs.readFileSync(CORPUS_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch { /* 下面统一断言 */ }
    const { decodeTrayPayload } = require(path.join(APP_ROOT, 'dist', 'main', 'trayhost', 'protocol.js'));
    const adds = corpus.filter((c) => {
      if (!c.hex) return false;
      const d = decodeTrayPayload(Buffer.from(c.hex, 'hex'));
      return d && d.dwMessage === 0;
    });
    corpus.length >= 3 && adds.length >= 1 && corpus.every((c) => typeof c.hex === 'string' && c.cbData * 2 === c.hex.length)
      ? rep.pass(`字节语料固化：${corpus.length} 条负载落盘（NIM_ADD ${adds.length} 条，hex 长度与 cbData 钩稽一致）`)
      : rep.fail(`字节语料异常：${corpus.length} 条（NIM_ADD ${adds.length}）`);

    // —— P6 交还：杀面板 → 广播 → 真托盘回归 explorer ——
    await cleanup();
    const trayAfter = realTrayHwnd();
    trayAfter
      ? rep.pass(`交还真托盘：面板退出后 explorer 托盘在场（0x${trayAfter.toString(16)}），TaskbarCreated 已广播`)
      : rep.fail('交还失败：面板退出后找不到 explorer 的 Shell_TrayWnd');
  } catch (err) {
    rep.fail(`验收异常中断：${err && err.message}`);
    await cleanup();
  }

  // 工单50 清场：还原 config + 原生任务栏视图事实核验（电池不得留隐藏态）
  try {
    if (configBackup === null) { try { fs.unlinkSync(CONFIG_FILE); } catch { /* 尽力 */ } }
    else { fs.writeFileSync(CONFIG_FILE, configBackup); }
  } catch { /* 尽力 */ }
  ensureNativeTaskbarVisible();

  const v = rep.verdict(rep.fails === 0 ? 'PASS' : 'FAIL');
  app.exit(v.fails === 0 ? 0 : 1);
}

module.exports = main;
