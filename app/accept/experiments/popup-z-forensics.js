'use strict';
// 自家浮层/原生 tooltip 被条带反压 z 序取证 harness（用户报障 2026-11-09：
// 「taskbar 在显示弹出菜单或浮动说明时仍压在菜单/说明上面——先弹出压在 taskbar 上，
// 不到 1 秒被 taskbar 压回去」）。
// 观测面两条（症状的两个形态，同一怀疑机制：条带 500ms keepalive/热区离开两处置顶
// 重申把条带抢回置顶带顶，闸门只护第三方托盘回放 trayYield，自家浮层与原生 tooltip
// 不在防护面）：
//   P0 拉起     --panel-accept + DECK_EVENT_LOG/CDP（tray-yield-forensics 同款）
//   P1 基线     条带窗在场且 WS_EX_TOPMOST=1；「⋯」钮在 DOM（缺则临时档位 3、finally 还原）
//   P2 菜单轮   clickPhys 点「⋯」→ taskbar-tray-overflow-opened → 逐 100ms 采样
//               z 序（top-down 枚举里条带与浮层窗的相对位）×2.5s；分两相：A 相光标
//               停在条带（只可能 keepalive 翻转），B 相光标上移进浮层（+热区离开拍）。
//               浮层可见且条带在其上 = 反压（红）。末拍实拍 PNG。
//   P3 tooltip 轮 moveMousePhys 悬停首枚托盘图标（原生 title tooltip）→ 等
//               tooltips_class32 可见窗 → 逐 100ms 采样 z 序 ×2.5s + PNG。
//   P4 复原     浮层收层、光标挪走、面板 taskkill、交还广播、用户常驻面板重拉。
// 纪律：产品代码零改动；取证工具不进 manifest 不产 verdict 电池；退出码
//   0=反压复现（红） 2=未复现（绿） 1=harness 错 3=机器脏。
// 碰真桌面（真面板+CDP+键鼠注入），一律经 accept-guard 托管（README 协议）。
// 配置走 env（guard hold 多词命令坑，见 t442 记忆）：POPUPZ_OUT / POPUPZ_REPEAT /
// POPUPZ_MODE(menu|tooltip|both，默认 both)。
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const win32 = require('../lib/win32');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const OUT = process.env.POPUPZ_OUT || `D:\\test-folder\\.agent-notes\\popup-z-forensics-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
const REPEAT = Number(process.env.POPUPZ_REPEAT || 2);
const MODE = process.env.POPUPZ_MODE || 'both';
const STRIP_TITLE = 'DECK-TASKBAR';
const OVERFLOW_TITLE = 'DECK-TRAY-OVERFLOW';
const CDP_PORT = Number(process.env.POPUPZ_CDP_PORT || 9229);
const WS_EX_TOPMOST = 0x8;
const GWL_EXSTYLE = -20;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const topmostBit = (hwnd) => (Number(win32.GetWindowLongW(hwnd, GWL_EXSTYLE)) & WS_EX_TOPMOST) !== 0;
const exStyle = (hwnd) => Number(win32.GetWindowLongW(hwnd, GWL_EXSTYLE));

const user32Local = win32.koffi.load('user32.dll');
const GetWindowTextW = user32Local.func('int __stdcall GetWindowTextW(uintptr_t hWnd, uint16 *buf, int nMax)');
function titleOf(hwnd) {
  const buf = Buffer.alloc(1024);
  const n = GetWindowTextW(hwnd, buf, 512);
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(buf.readUInt16LE(i * 2));
  return s;
}

// —— 事件尾读（tray-yield-forensics EventTail 同款）——
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

// —— 窗口定位 ——
/** 同题名且属本面板 pid 的可见顶层窗 */
function ownWindowByTitle(title, pid) {
  let after = 0;
  for (;;) {
    const h = Number(win32.FindWindowExW(0, after, null, title));
    if (!h) break;
    after = h;
    if (win32.IsWindowVisible(h) && win32.threadIdOf(h).pid === pid) return h;
  }
  return 0;
}
/** 本面板 pid 的可见 tooltips_class32 窗（原生 title tooltip 旧径） */
function ownTooltipWindows(pid) {
  const out = [];
  let after = 0;
  for (;;) {
    const h = Number(win32.FindWindowExW(0, after, 'tooltips_class32', null));
    if (!h) break;
    after = h;
    if (win32.IsWindowVisible(h) && win32.threadIdOf(h).pid === pid) out.push(h);
  }
  return out;
}
/** 本面板 pid 的全部可见顶层窗（tooltip 探测主径：Chromium 自绘 tooltip 类名不定，
 *  悬停前后差集抓「悬停新生窗」——r1 实证 tooltips_class32 枚举为空，探针改差集） */
function ownVisibleWindows(pid) {
  return win32.topLevelWindows().filter((h) => win32.threadIdOf(h).pid === pid);
}

// —— z 序采样：top-down 枚举（越前越高）；条带先于目标 = 条带压在目标上（红）——
function zSample(stripHwnd, targetHwnd) {
  const list = win32.topLevelWindows();
  const si = list.indexOf(stripHwnd);
  const oi = targetHwnd ? list.indexOf(targetHwnd) : -1;
  return {
    t: Date.now(),
    stripIdx: si, targetIdx: oi,
    targetVisible: oi >= 0,
    covered: si >= 0 && oi >= 0 && si < oi,
  };
}
async function sampleFor(stripHwnd, findTarget, ms, tail, tag) {
  const samples = [];
  const deadline = Date.now() + ms;
  let target = 0;
  while (Date.now() < deadline) {
    if (!target) target = findTarget();
    const s = zSample(stripHwnd, target);
    s.tag = tag; s.stripTopmost = topmostBit(stripHwnd);
    s.targetTopmost = target ? topmostBit(target) : null; s.exStyle = target ? exStyle(target) : null;
    samples.push(s);
    const evs = tail.next().filter((e) => /topmost|hotzone|overflow|tray-yield/.test(e.type));
    if (evs.length) s.events = evs.map((e) => e.type + (e.reason ? `:${e.reason}` : ''));
    await sleep(100);
  }
  return { samples, target };
}

// —— CDP 驱动（t194 同款：原生 WebSocket + Runtime.evaluate）——
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

// —— 条带页 DOM → 物理坐标（strip 窗矩形 + CSS/inner 比例，无 Electron screen API 依赖）——
async function stripGeo(stripHwnd) {
  const g = await cdpEval(STRIP_TITLE, `(() => {
    const r = (sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
    return { more: r('#right-pill .tb-tray-overflow'), icon: r('#right-pill .tb-tray-icon'), innerW: window.innerWidth, innerH: window.innerHeight };
  })()`);
  const sr = win32.rectOf(stripHwnd);
  const sx = (sr.right - sr.left) / (g.innerW || 1), sy = (sr.bottom - sr.top) / (g.innerH || 1);
  const toPhys = (r) => r ? {
    x: Math.round(sr.left + r.x * sx), y: Math.round(sr.top + r.y * sy),
    w: Math.round(r.w * sx), h: Math.round(r.h * sy),
  } : null;
  return { stripRect: sr, morePhys: toPhys(g.more), iconPhys: toPhys(g.icon), dom: g };
}

function capture(rect, name) {
  fs.mkdirSync(OUT, { recursive: true });
  const out = path.join(OUT, name + '.png');
  const r = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(__dirname, '..', 'lib', 'capture.ps1'),
    '-Out', out, '-X', String(Math.max(0, rect.left ?? rect.x)), '-Y', String(Math.max(0, rect.top ?? rect.y)),
    '-W', String(rect.right ? rect.right - rect.left : rect.w), '-H', String(rect.bottom ? rect.bottom - rect.top : rect.h),
  ], { encoding: 'utf8', timeout: 20000 });
  return r.status === 0 && fs.existsSync(out) ? out : null;
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
  await sleep(1500);
}
/** 用户常驻面板重拉（autostart 同径：恒指主检出 app/——在 worktree 里跑本工具也不把
 * 用户面板拉成 worktree 构建（worktree 会被清理，自启不指向它，AGENTS.md 纪律）） */
const MAIN_APP_ROOT = 'D:\\test-folder\\wallpaperengine-research\\app';
function relaunchUserPanel() {
  const electronExe = require('electron');
  const env = { ...process.env };
  delete env.DECK_EVENT_LOG; delete env.DECK_CDP_PORT; delete env.DECK_LAG_SENTINEL;
  const c = spawn(electronExe, ['.'], { cwd: MAIN_APP_ROOT, env, detached: true, stdio: 'ignore' });
  c.unref();
}

/** 机器脏判：本仓非 accept 的 electron 在场（guard 应已清；防御性口令） */
function machineDirty() {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.CommandLine -like '*wallpaperengine-research*' -and $_.CommandLine -notlike '*--accept*' -and $_.CommandLine -notlike '*--type=' } | Select-Object -ExpandProperty ProcessId",
  ], { encoding: 'utf8', timeout: 15000 });
  return (r.stdout || '').trim().split('\n').filter(Boolean);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const eventsFile = path.join(OUT, 'events.jsonl');
  const report = { out: OUT, mode: MODE, repeat: REPEAT, rounds: [], verdict: null, startedAt: new Date().toISOString() };
  const dirty = machineDirty();
  if (dirty.length) {
    console.log(`DIRTY: 非本 harness 的面板进程在场 pid=${dirty.join(',')}（guard 应已清场）`);
    process.exit(3);
  }
  let child = null;
  let limitTouched = null; // 原档位（动过才还原）
  try {
    // P0
    child = launchPanel(eventsFile);
    const { panelPid } = await waitPanelReady(eventsFile, child);
    report.panelPid = panelPid;
    const tail = new EventTail(eventsFile);
    // P1 基线
    let strip = 0;
    for (let i = 0; i < 50 && !strip; i++) { strip = ownWindowByTitle(STRIP_TITLE, panelPid); if (!strip) await sleep(200); }
    if (!strip) throw new Error('条带窗 25s 未在场（taskbar.enabled？）');
    report.strip = { hwnd: strip, topmost: topmostBit(strip), title: titleOf(strip) };
    console.log(`P1 条带 hwnd=0x${strip.toString(16)} topmost=${report.strip.topmost}`);
    let geo = await stripGeo(strip);
    if (!geo.morePhys) {
      // 档位全开时无「⋯」：临时档位 3、finally 还原（P27 先例）
      const st = await cdpEval(STRIP_TITLE, `window.deck.bridge.invoke('taskbar/get-state', {})`);
      limitTouched = st && st.trayOverflowLimit !== undefined ? st.trayOverflowLimit : 3;
      await cdpEval(STRIP_TITLE, `window.deck.bridge.invoke('taskbar/set-tray-overflow-limit', { limit: 3 })`);
      await sleep(1200);
      geo = await stripGeo(strip);
      if (!geo.morePhys) throw new Error('档位 3 后仍无「⋯」钮');
    }
    report.morePhys = geo.morePhys; report.iconPhys = geo.iconPhys;
    const morePt = { x: geo.morePhys.x + Math.round(geo.morePhys.w / 2), y: geo.morePhys.y + Math.round(geo.morePhys.h / 2) };
    await sleep(1500); // boot 后沉降拍（r1 实证首轮 opened 存证未落地——渲染层未就绪即点击）

    // P2 菜单轮
    if (MODE === 'both' || MODE === 'menu') {
      for (let round = 0; round < REPEAT; round++) {
        tail.next(); // 清积压
        const tOpen = Date.now();
        win32.clickPhys(morePt.x, morePt.y, 'left');
        let openedEv = null;
        {
          const deadline = Date.now() + 4000;
          let retried = false;
          while (Date.now() < deadline && !openedEv) {
            openedEv = tail.next().find((e) => e.type === 'taskbar-tray-overflow-opened') || null;
            if (!openedEv && !retried && Date.now() - tOpen > 1500) {
              retried = true;
              win32.clickPhys(morePt.x, morePt.y, 'left'); // 首击被吞兜底（r1/r2 实证：首次开层点击约 p=1 被吞，二次必达）
            }
            if (!openedEv) await sleep(100);
          }
        }
        if (!openedEv) { report.rounds.push({ kind: 'menu', round, error: 'opened 存证未落地' }); continue; }
        // A 相：光标停在条带「⋯」上（热区在场）——只可能 keepalive 翻转
        const a = await sampleFor(strip, () => ownWindowByTitle(OVERFLOW_TITLE, panelPid), 1500, tail, 'A-parked');
        // B 相：光标上移 120px（离开条带热区；通常仍落浮层内）——引入热区离开拍
        win32.moveMousePhys(morePt.x, Math.max(10, morePt.y - 120));
        const b = await sampleFor(strip, () => ownWindowByTitle(OVERFLOW_TITLE, panelPid), 1500, tail, 'B-moved');
        const popup = b.target || a.target;
        const png = popup ? capture(win32.rectOf(popup), `menu-r${round}-popup`) : null;
        const samples = [...a.samples, ...b.samples];
        const firstCovered = samples.find((s) => s.covered);
        const visibleSamples = samples.filter((s) => s.targetVisible);
        report.rounds.push({
          kind: 'menu', round, popupHwnd: popup || 0, popupTopmost: popup ? topmostBit(popup) : null,
          popupRect: popup ? win32.rectOf(popup) : null, png,
          openedAt: openedEv.t ?? tOpen, firstCoveredAt: firstCovered ? firstCovered.t : null,
          coveredSamples: samples.filter((s) => s.covered).length,
          visibleSamples: visibleSamples.length,
          timeline: samples.map((s) => `${s.tag}+${s.t - tOpen}ms idx=${s.stripIdx}/${s.targetIdx}${s.covered ? ' COVERED' : ''}${s.events ? ' ev=' + s.events.join('|') : ''}`),
        });
        console.log(`P2 菜单轮${round}: popup=0x${(popup || 0).toString(16)} topmost=${popup ? topmostBit(popup) : '?'} covered=${report.rounds[report.rounds.length - 1].coveredSamples}/${samples.length} png=${png}`);
        // 收层：再点「⋯」（拨动 toggle）
        win32.clickPhys(morePt.x, morePt.y, 'left');
        await sleep(600);
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline && ownWindowByTitle(OVERFLOW_TITLE, panelPid)) await sleep(150);
        await sleep(400);
      }
    }

    // P3 tooltip 轮
    if (MODE === 'both' || MODE === 'tooltip') {
      const iconPtOf = () => { const g = geo.iconPhys; return g ? { x: g.x + Math.round(g.w / 2), y: g.y + Math.round(g.h / 2) } : null; };
      let iconPt = iconPtOf();
      if (!iconPt) report.rounds.push({ kind: 'tooltip', error: '无在栏托盘图标' });
      for (let round = 0; iconPt && round < REPEAT; round++) {
        tail.next();
        const g2 = await stripGeo(strip).catch(() => null); // 每轮重取：托盘名单 churn 会挪图标位（P27 教训）
        if (g2 && g2.iconPhys) { geo.iconPhys = g2.iconPhys; iconPt = iconPtOf(); }
        const before = new Set(ownVisibleWindows(panelPid));
        win32.moveMousePhys(iconPt.x, iconPt.y); // 悬停并保持不动（title tooltip 需静置）
        let tip = [];
        const dwellDeadline = Date.now() + 7000;
        let jiggled = false;
        while (Date.now() < dwellDeadline) {
          tip = ownVisibleWindows(panelPid).filter((h) => !before.has(h));
          if (!tip.length) tip = ownTooltipWindows(panelPid); // 类名探针兜底（旧径）
          if (tip.length) break;
          if (!jiggled && Date.now() > dwellDeadline - 4000) { // 3s 无 tooltip：微挪 1px 重触发 hover 计时器
            jiggled = true;
            win32.moveMousePhys(iconPt.x + 1, iconPt.y + 1);
          }
          await sleep(120);
        }
        if (!tip.length) { report.rounds.push({ kind: 'tooltip', round, error: '悬停 7s 无 tooltip 窗（含 1px 微挪重触发）' }); continue; }
        const hwnd = tip[0];
        report.rounds.push({ kind: 'tooltip-meta', round, cls: win32.className(hwnd), tipTitle: titleOf(hwnd) });
        const s = await sampleFor(strip, () => (win32.IsWindowVisible(hwnd) ? hwnd : 0), 2500, tail, 'hover');
        const tr = win32.rectOf(hwnd);
        const png = capture({ left: tr.left - 16, top: tr.top - 8, right: tr.right + 16, bottom: tr.bottom + 40 }, `tooltip-r${round}`);
        const firstCovered = s.samples.find((x) => x.covered);
        report.rounds.push({
          kind: 'tooltip', round, tooltipHwnd: hwnd, tooltipTopmost: topmostBit(hwnd), tooltipRect: tr, png,
          tooltipTitle: titleOf(hwnd), firstCoveredAt: firstCovered ? firstCovered.t : null,
          coveredSamples: s.samples.filter((x) => x.covered).length,
          visibleSamples: s.samples.filter((x) => x.targetVisible).length,
          timeline: s.samples.map((x) => `hover+${x.t - (firstCovered ? firstCovered.t : Date.now())}ms idx=${x.stripIdx}/${x.targetIdx}${x.covered ? ' COVERED' : ''}${x.events ? ' ev=' + x.events.join('|') : ''}`),
        });
        console.log(`P3 tooltip轮${round}: hwnd=0x${hwnd.toString(16)} topmost=${topmostBit(hwnd)} covered=${report.rounds[report.rounds.length - 1].coveredSamples}/${s.samples.length} png=${png}`);
        win32.moveMousePhys(Math.round(iconPt.x - 200), Math.max(10, iconPt.y - 300)); // 挪走收 tooltip
        await sleep(800);
      }
    }

    // 判红：任一轮任一拍「目标可见且条带在其上」= 反压复现
    const menuCovered = report.rounds.some((r) => r.kind === 'menu' && r.coveredSamples > 0);
    const tipCovered = report.rounds.some((r) => r.kind === 'tooltip' && r.coveredSamples > 0);
    report.verdict = { menuCovered, tipCovered, red: menuCovered || tipCovered };
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`VERDICT: menu=${menuCovered ? 'RED(被反压)' : 'green'} tooltip=${tipCovered ? 'RED(被反压)' : 'green'} → ${report.verdict.red ? 'RED 反压复现' : 'GREEN 未复现'}`);
    process.exitCode = report.verdict.red ? 0 : 2;
  } catch (err) {
    report.error = String(err && err.stack || err);
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`ERROR: ${report.error}`);
    process.exitCode = 1;
  } finally {
    try { if (limitTouched !== null && child && isAlive(child.pid)) await cdpEval(STRIP_TITLE, `window.deck.bridge.invoke('taskbar/set-tray-overflow-limit', { limit: ${JSON.stringify(limitTouched)} })`); } catch { /* 面板已死即算 */ }
    await stopPanel(child);
    relaunchUserPanel(); // 用户常驻面板回场（guard 清的是它，还原现场）
    await sleep(1000);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
