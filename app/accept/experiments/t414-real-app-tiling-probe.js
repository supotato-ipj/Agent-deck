'use strict';
/**
 * 工单414 真机探针：真实 Electron 应用窗口在 Agent 平铺写窗链上的最小尺寸夹取观察
 * （spec #413「先用低敏诊断和真实 Electron 应用回归取得故障证据，再实施修复」）。
 *
 * 定位：**取证探针**（app/accept/experiments/ 先例，同 t249/t371/t372），**不是验收电池
 * 段**——增段三条件未满足前，真实应用探索性取证走实验入口（spec 413 Testing Decisions）。
 *
 * 与 t372 的关键差异：本探针直接驱动**生产平铺服务**（dist/main 编译产物——
 * AgentTilingService + tile-scan 采集链 + geom-write 写窗/回读 FFI，与面板同一代码路径，
 * 仅 currentMode 注入 'agent'、事实集过滤到探针自拉起的窗口），观察对象是**真实 Electron
 * 应用的最小尺寸约束**（BrowserWindow minWidth/minHeight → Chromium WM_GETMINMAXINFO
 * 夹取——ZCode/Kimi Code 等真实 Electron 应用的常见形态），而非理想 WPF 夹具。
 *
 *   ① 拉起仓库 electron.exe 伴生进程创建 5 扇真实 Electron 窗（T414-W1..W5；W4/W5 带
 *      minWidth 1100 / minHeight 900 的真实最小尺寸约束）；
 *   ② 生产服务按成员序平铺 5 扇（真实 SetWindowPos 写入 + GetWindowRect 回读核验）；
 *   ③ 低敏诊断面（工单414 tiling-write / tiling-verify / tiling-anomaly 事件）逐行落
 *      jsonl 证据——目标矩形、实际矩形、写窗结果、异常类别、恢复状态；零标题字段；
 *   ④ 结论如实二值：夹取复现（写受理但回读不达标）或未复现（真实应用接受了全部目标）
 *      ——两者都是有效取证结论，不伪造根因；
 *   ⑤ 零残留：伴生进程全退、临时目录删除、探针只管理自拉起窗（事实集过滤，绝不触碰
 *      用户既有窗口）。
 *
 * 用法（**必须经 accept-guard 托管**，禁裸跑——本机多检出共享同一验收槽）：
 *   先 npm run build（探针 require dist 产物），再：
 *   node D:\test-folder\.accept-guard\guard.mjs hold --as zcode --purpose accept-sprint -- \
 *     node app\accept\experiments\t414-real-app-tiling-probe.js
 *
 * 退出码：0 = 观察能力成立（状态+几何+诊断事件三面取证完成；夹取复现与否见报告）；
 *         1 = 观察能力断言不成立；2 = 环境/时序问题（本轮未取到证据）。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execSync } = require('child_process');

const win32 = require('../lib/win32');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const APP_ROOT = path.resolve(__dirname, '..', '..');
const DIST_SERVICE = path.join(APP_ROOT, 'dist', 'main', 'services', 'agent-tiling.js');
const DIST_TILE_SCAN = path.join(APP_ROOT, 'dist', 'main', 'desktop', 'tile-scan.js');
const REPORT_FILE = path.join(__dirname, '..', 'evidence', '414-real-app-tiling-probe.log.txt');
const EVENTS_FILE = path.join(__dirname, '..', 'evidence', '414-real-app-tiling-probe-events.jsonl');

/** 结论账目（探针自己的报告面） */
const findings = [];
function say(s) { console.log(s); findings.push(s); }
/** 断言账目：观察能力断言（夹取复现与否不是断言——是取证结论） */
const failures = [];
function check(desc, ok, detail = '') {
  const line = `${ok ? 'PASS' : 'FAIL'} ${desc}${detail ? ' —— ' + detail : ''}`;
  say(line);
  if (!ok) failures.push(desc);
  return ok;
}
/** 诊断事件流（低敏 jsonl——与生产 DECK_EVENT_LOG 同口径） */
const eventLines = [];
function appendEventFile(e) {
  eventLines.push(JSON.stringify(e));
}
function flushEvents() {
  try { fs.writeFileSync(EVENTS_FILE, eventLines.join('\n') + '\n', 'utf8'); } catch (e) { say(`（事件 jsonl 落盘失败：${e && e.message}）`); }
}
function flushReport(exitCode) {
  try {
    fs.writeFileSync(REPORT_FILE, [
      '工单414 真机探针（t414-real-app-tiling-probe.js）——真实 Electron 应用最小尺寸夹取观察',
      `运行时刻：${new Date().toISOString()}`,
      `退出码：${exitCode}（${failures.length === 0 ? '观察能力断言全过' : failures.length + ' 条断言不成立'}）`,
      '',
      ...findings,
      '',
    ].join('\n'), 'utf8');
  } catch (e) { console.log(`（报告落盘失败：${e && e.message}）`); }
}

// —— Win32 绑定（探针进程；T414_ 前缀防撞名，#153 教训） ——
const koffi = win32.koffi;
const user32 = koffi.load('user32.dll');
const FindWindowW = user32.func('uintptr_t __stdcall FindWindowW(const char16_t *, const char16_t *)');
const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(uintptr_t, _Out_ uint32 *)');
const WM_CLOSE = 0x0010;

function primaryRectOf() {
  // 主屏物理矩形（物理原点恒 (0,0)；多屏下副屏在虚拟屏坐标——本探针只在主屏拉窗）
  return { left: 0, top: 0, right: win32.GetSystemMetrics(0), bottom: win32.GetSystemMetrics(1) };
}
function taskbarTopOf() {
  const hwnd = FindWindowW('Shell_TrayWnd', null);
  if (!hwnd || !win32.IsWindowVisible(hwnd)) return null;
  const r = win32.rectOf(hwnd);
  return r ? r.top : null;
}
function tasklistCount(image) {
  try {
    const out = execSync(`tasklist /FI "IMAGENAME eq ${image}" /FO CSV /NH`, { encoding: 'utf8' });
    return out.split('\n').filter((l) => l.toLowerCase().includes(image.toLowerCase())).length;
  } catch { return -1; }
}
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function taskkillTree(pid) {
  try { execSync(`taskkill /PID ${pid} /T /F /W`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { /* 已退出 */ }
}
function rectEq(a, b, tol = 1) {
  if (!a || !b) return false;
  return ['left', 'top', 'right', 'bottom'].every((k) => Math.abs(a[k] - b[k]) <= tol);
}
function rectStr(r) { return r ? `[${r.left},${r.top},${r.right},${r.bottom}]` : 'null'; }

// —— 伴生进程源码（真实 Electron 应用代表窗；写临时目录，退出前删除） ——
const HELPER_ELECTRON_SRC = `'use strict';
// 工单414 探针伴生进程：仓库 electron.exe 创建 5 扇真实 Electron 窗（W4/W5 带
// minWidth/minHeight——真实 Electron 应用最小尺寸约束的常见形态，Chromium 在
// WM_GETMINMAXINFO 里夹取）。**不得 attach stdin**（t372 实证：Electron 主进程挂
// stdin 监听会让 BrowserWindow 原生句柄 ~1s 内被销毁）。退出由控制器 WM_CLOSE +
// taskkill 兜底（window-all-closed 默认退 app）。
const { app, BrowserWindow } = require('electron');
const SPECS = [
  { title: 'T414-W1', x: 60,  y: 80,  w: 800, h: 600, min: null },
  { title: 'T414-W2', x: 920, y: 120, w: 760, h: 560, min: null },
  { title: 'T414-W3', x: 200, y: 700, w: 720, h: 520, min: null },
  { title: 'T414-W4', x: 1000, y: 640, w: 900, h: 700, min: { w: 1100, h: 900 } },
  { title: 'T414-W5', x: 400, y: 300, w: 860, h: 640, min: { w: 1100, h: 900 } },
];
function reply(obj) { try { process.stdout.write(JSON.stringify(obj) + '\\n'); } catch { /* 收尾 */ } }
app.whenReady().then(async () => {
  const wins = [];
  for (const s of SPECS) {
    const opts = { x: s.x, y: s.y, width: s.w, height: s.h, show: true, title: s.title,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } };
    if (s.min) { opts.minWidth = s.min.w; opts.minHeight = s.min.h; }
    const win = new BrowserWindow(opts);
    win.loadURL('about:blank');
    let hwnd = null;
    try {
      const b = win.getNativeWindowHandle();
      hwnd = (b.readBigUInt64LE ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0)).toString(16);
    } catch { hwnd = null; }
    wins.push({ title: s.title, hwnd, min: s.min });
  }
  reply({ type: 'ready', pid: process.pid, windows: wins });
}).catch((e) => { reply({ type: 'fatal', error: String(e && e.message) }); process.exit(2); });
`;

async function main() {
  process.exitCode = 2;
  // —— 前置：生产 dist 编译产物（探针 require 生产代码，不用测试假源） ——
  for (const f of [DIST_SERVICE, DIST_TILE_SCAN]) {
    if (!fs.existsSync(f)) { say(`前置不成立：生产编译产物缺失 ${f}——先 npm run build，exit 2`); flushReport(2); return; }
  }

  // —— S1 基线 ——
  const electronCountBefore = tasklistCount('electron.exe');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 't414-probe-'));
  const helperSrc = path.join(tempDir, 'helper-electron.js');
  fs.writeFileSync(helperSrc, HELPER_ELECTRON_SRC, 'utf8');
  say(`S1 基线：electron.exe 进程计数=${electronCountBefore}；主屏=${JSON.stringify(primaryRectOf())} taskbarTop=${taskbarTopOf()}`);
  say('S1 事实集过滤：探针服务只管理自拉起的 T414 窗（collectFacts 过滤），绝不触碰用户既有窗口');

  // —— S2 伴生 Electron 拉起 ——
  const electronExe = path.join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!fs.existsSync(electronExe)) { say(`electron.exe 不存在：${electronExe}——exit 2`); flushReport(2); return; }
  const helper = spawn(electronExe, [helperSrc], { stdio: ['pipe', 'pipe', 'pipe'], cwd: tempDir });
  let helperReady = null;
  let buf = '';
  helper.stdout.setEncoding('utf8');
  helper.stdout.on('data', (d) => {
    buf += d;
    for (;;) {
      const i = buf.indexOf('\n');
      if (i < 0) break;
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.type === 'ready') helperReady = m;
      if (m.type === 'fatal') say(`（helper fatal: ${String(m.error || '').slice(0, 300)}）`);
    }
  });
  helper.stderr.setEncoding('utf8');
  helper.stderr.on('data', (d) => {
    for (const l of String(d).split('\n')) if (l.trim()) say(`（helper stderr: ${l.trim().slice(0, 200)}）`);
  });
  const t0 = Date.now();
  while (!helperReady && Date.now() - t0 < 20000) await sleep(120);
  if (!helperReady || !Array.isArray(helperReady.windows) || helperReady.windows.length !== 5) {
    say('S2 helper 未就绪或窗数不足 5——核心基础设施不成立，exit 2');
    try { helper.kill(); } catch { /* 尽力 */ }
    taskkillTree(helper.pid);
    try { fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 尽力 */ }
    flushReport(2);
    return;
  }
  const hwnds = helperReady.windows.map((w) => Number.parseInt(w.hwnd, 16));
  const minSpecs = helperReady.windows.map((w) => w.min);
  say(`S2 helper 就绪：pid=${helper.pid} windows=${helperReady.windows.map((w) => `${w.title}(hwnd=${w.hwnd},min=${w.min ? `${w.min.w}x${w.min.h}` : 'none'})`).join(' ')}`);

  // —— S3 生产平铺服务（真实采集链 + 真实写窗/回读 FFI；事实集过滤到探针窗） ——
  const { AgentTilingService } = require(DIST_SERVICE);
  const { Context } = require('cordis');
  const { collectTileFacts } = require(DIST_TILE_SCAN);
  const probeHwnds = new Set(hwnds);
  const ctx = new Context();
  const svc = new AgentTilingService(ctx, {
    enabled: true,
    batchMs: 40,
    settleMs: 200,
    // 低敏诊断事件（工单414）逐行落 jsonl——与生产 DECK_EVENT_LOG 同一口径
    log: (e) => { appendEventFile(e); },
    deps: {
      currentMode: () => 'agent', // 探针注入：无需面板壳与桌面配对（这是与生产装配的唯一语义差异）
      ownExes: () => [], // 探针进程无窗口；成员面由 collectFacts 过滤兜底
      primaryRect: () => primaryRectOf(),
      taskbarTop: () => taskbarTopOf(),
      // 生产采集链（win-facts + VDM + 窗框特征）照跑，仅过滤成员集到探针自拉起窗——
      // 用户既有窗口不在事实集内，绝不被动改窗
      collectFacts: () => collectTileFacts().filter((f) => probeHwnds.has(f.hwnd)),
      // readRect / startWatch / isForeground / restoreRect / minPane 全部缺省 = 生产 geom-write 真源
      agentDesktopId: () => null, // 无配对 → 恢复面按无持久文档走（layoutFile null）
    },
  });
  ctx.on('tiling/changed', (payload) => appendEventFile({ type: 'tiling-state', ...payload }));
  svc.start();
  say('S3 生产 AgentTilingService 已启动（dist 真源；currentMode=agent 注入，其余缺省绑定生产 FFI）');

  // —— S4 观察窗：等服务收敛（状态投影连续 3 拍不变），上限 25s ——
  let last = null;
  let stable = 0;
  const t1 = Date.now();
  while (Date.now() - t1 < 25000) {
    await sleep(600);
    const s = svc.state();
    const sig = JSON.stringify(s);
    if (sig === last) stable++; else stable = 0;
    last = sig;
    if (stable >= 2) break;
  }
  const state = svc.state();
  say(`S4 服务收敛：count=${state.count} placed=${state.placed} overflow=${state.overflow} anomalies=${state.anomalies} anomalyDetail=${JSON.stringify(state.anomalyDetail)} recovery=${state.recovery}/${state.recoveryReason ?? '-'}`);
  check('S4 平铺服务激活并管理 5 扇真实 Electron 窗（count=5）', state.count === 5, `count=${state.count}`);

  // —— S5 低敏平铺状态与实际几何对拍（AC 4 观察入口面） ——
  const rows = helperReady.windows.map((w, i) => {
    const hwnd = hwnds[i];
    return { title: w.title, hwnd, min: w.min, actual: win32.rectOf(hwnd) };
  });
  // 目标矩形从诊断事件流取（tiling-write = 生产写窗当拍证据）
  const lastWrite = new Map();
  for (const l of eventLines) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.type === 'tiling-write' && e.target) lastWrite.set(e.hwnd, e);
  }
  say('—— S5 实际几何 vs 最后写窗目标（真实 Electron 应用） ——');
  for (const r of rows) {
    const wr = lastWrite.get(r.hwnd);
    say(`  ${r.title} hwnd=${r.hwnd.toString(16)} min=${r.min ? `${r.min.w}x${r.min.h}` : 'none'} 写目标=${wr ? rectStr(wr.target) : '无'} 实际=${rectStr(r.actual)}`);
  }
  const stateOk = state && typeof state.count === 'number' && typeof state.placed === 'number'
    && typeof state.overflow === 'number' && typeof state.anomalies === 'number'
    && state.anomalyDetail && state.recovery !== undefined;
  check('S5 低敏平铺状态可读（count/placed/overflow/anomalies/anomalyDetail/recovery 全字段）',
    Boolean(stateOk), `available=${state && state.available}`);
  check('S5 实际几何可读（5 扇 GetWindowRect 全部非空）', rows.every((r) => r.actual), rows.map((r) => `${r.title}:${rectStr(r.actual)}`).join(' '));
  const diagOk = [...lastWrite.keys()].some((h) => probeHwnds.has(h));
  check('S5 写窗诊断事件在真机事件流（tiling-write 含目标矩形与写窗结果）', diagOk, `tiling-write 覆盖 ${[...lastWrite.keys()].length} 扇`);
  const privacyOk = eventLines.length > 0 && eventLines.every((l) => !/"title"\s*:/.test(l));
  check('S5 隐私边界：诊断事件流零标题字段（jsonl 全行无 title 键）', privacyOk, `${eventLines.length} 行`);

  // —— S6 夹取取证结论（复现/未复现都如实记录——不伪造根因） ——
  const clamped = rows.filter((r) => {
    const wr = lastWrite.get(r.hwnd);
    return wr && wr.ok === true && !rectEq(r.actual, wr.target, 1);
  });
  const anomalyRows = [];
  for (const l of eventLines) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.type === 'tiling-anomaly') anomalyRows.push(e);
  }
  say('—— S6 夹取取证结论 ——');
  if (clamped.length > 0) {
    say(`夹取复现：${clamped.length} 扇真实 Electron 窗写受理但回读不达标（minSize 夹取）——`);
    for (const r of clamped) {
      const wr = lastWrite.get(r.hwnd);
      say(`  ${r.title} min=${r.min ? `${r.min.w}x${r.min.h}` : '?'} 写目标 ${rectStr(wr.target)} → 实际 ${rectStr(r.actual)}（尺寸差 ${wr.target.right - wr.target.left - (r.actual.right - r.actual.left)}x${wr.target.bottom - wr.target.top - (r.actual.bottom - r.actual.top)}）`);
    }
  } else {
    say('未复现：本轮真实 Electron 窗全部接受了平铺目标（写受理且回读达标）——如实记录，不伪造根因');
  }
  say(`异常化结论：anomalies=${state.anomalies} detail=${JSON.stringify(state.anomalyDetail)}；tiling-anomaly 事件 ${anomalyRows.length} 条（${anomalyRows.map((e) => `hwnd=${e.hwnd}/${e.kind}/recovery=${e.recovery}`).join('；') || '无'}）`);
  say(`S6 事件流全量证据：${EVENTS_FILE}（${eventLines.length} 行）`);

  // —— S7 零残留 ——
  say('—— S7 清理与零残留 ——');
  for (const h of hwnds) { try { if (win32.IsWindow(h)) win32.PostMessageW(h, WM_CLOSE, 0, 0); } catch { /* 尽力 */ } }
  await sleep(1500);
  if (pidAlive(helper.pid)) taskkillTree(helper.pid);
  await sleep(600);
  const electronAfter = tasklistCount('electron.exe');
  check('S7 伴生 Electron 进程计数不高于基线（无残留）', electronAfter <= electronCountBefore, `${electronCountBefore} → ${electronAfter}`);
  try { fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 尽力 */ }
  check('S7 探针临时目录已删除', !fs.existsSync(tempDir), tempDir);
  say('S7 WinEvent hook：生产服务绑定的观察 hook 随探针进程退出由系统释放（进程级生命周期）');

  say('');
  say('=== 工单414 观察能力要点 ===');
  say('① 低敏平铺状态：生产服务 state() 投影（计数/落格/溢出/异常分类/恢复态）直接可读——见 S4/S5');
  say('② 实际几何：GetWindowRect 对拍写窗目标——夹取/达标逐扇可见——见 S5 表');
  say('③ 诊断事件：tiling-write/tiling-verify/tiling-anomaly 在真实应用写窗链上当拍落 jsonl——见 S6 与事件文件');
  say('④ 结论二值如实：夹取复现或未复现均记录在案，不伪造根因（spec 413 Further Notes）');
  say(`断言账目：${failures.length === 0 ? '全部通过' : failures.length + ' 条不成立：' + failures.join('；')}`);

  process.exitCode = failures.length === 0 ? 0 : 1;
  flushEvents();
  flushReport(process.exitCode);
}

main().catch(async (e) => {
  say(`探针异常退出：${e && e.stack ? e.stack : e && e.message}`);
  try { flushEvents(); } catch { /* 尽力 */ }
  process.exitCode = 2;
  flushReport(2);
});
