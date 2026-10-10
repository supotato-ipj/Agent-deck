'use strict';
// 工单119 取证 harness：托盘 UIA 键盘导航空名四臂取证（设计、臂序与预登记判读标准：
// docs/audit/2026-10-11-t119-uia-tray-empty-name.md）。
// 用法（纯 node；须先 npm run build——面板以 --panel-accept 子进程拉起需要 dist 在场）：
//   node accept/experiments/uia-tray-forensics.js --arm=all|baseline|idle|broadcast|relaunch [--smoke] [--out=<dir>]
// 臂（--arm=all 固定此序，判读表依赖）：
//   baseline  无面板裸托盘基线：Win+B 导航 N 轮（前置互斥侦察：Shell_TrayWnd 唯一且属 explorer）
//   idle      静置面板：拉真面板（taskbar.enabled=false，对齐主电池跑法）就绪稳 5s 后导航 N 轮
//   broadcast 迁移窗口定向：同面板每轮广播 TaskbarCreated 后 150ms 即导航 ×20
//   relaunch  电池路径复核：每轮重启面板，就绪即导航 ×10（P8 重启→P10 导航的真实路径）
// 每轮走满 20 步全量采集（uia-probe2.ps1：步级焦点字段 + 前台窗 + 双 Shell_TrayWnd 树
// 前后 dump），永不早退——首中步后算。面板事件（boot/tray-host-*/tray-event，带 t 时戳）
// 落 DECK_EVENT_LOG 与轮窗对齐。
// 纪律：面板 stdout 必须排空（工单132 根因）；本 harness 是取证工具不是验收段——不进
// manifest、不产 verdict、退出码 0=完成 3=机器脏（遗留进程/互斥侦察失败/面板中途死冻）。
// 碰真桌面（键鼠注入+真面板），一律经 accept-guard 托管。
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const win32 = require('../lib/win32');
const { parseProbeOutput, classifyRound, aggregateRounds, verdictRows } = require('./uia-tray-analyze');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_OUT = 'D:\\test-folder\\.agent-notes\\t119-uia-tray-forensics';
const PROBE_PATH = path.join(__dirname, '..', 'lib', 'uia-probe2.ps1');
const NEEDLE = 'AGENT DECK';
const PROBE_TIMEOUT_MS = 120000;   // 树 dump 是跨进程 UIA 调用，比现役探针宽得多
const WINB_SETTLE_MS = 1200;       // battery P10 同款
const INTER_ROUND_MS = 2000;
const IDLE_SETTLE_MS = 5000;       // idle 臂求稳态：launch 广播的迁移窗口散去后再开测
const POST_BROADCAST_MS = 150;     // broadcast 臂打迁移窗口：广播后立即导航
const PANEL_READY_MS = 25000;
const PROBE_WINDOW_MS = 2000;      // WM_NULL 探针超时（battery.panelLiveness 同款）

const ARM_ROUNDS = { baseline: 30, idle: 30, broadcast: 20, relaunch: 10 };
const VK_LWIN = 0x5b, VK_B = 0x42, VK_ESCAPE = 0x1b;

const user32Local = win32.koffi.load('user32.dll');
const RegisterWindowMessageW = user32Local.func('uint32 __stdcall RegisterWindowMessageW(const char16_t* lpString)');
const GetWindowTextW = user32Local.func('int __stdcall GetWindowTextW(uintptr_t hWnd, uint16 *buf, int nMax)');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function parseArgs(argv) {
  const out = { arm: 'all', out: DEFAULT_OUT, smoke: false };
  for (const a of argv.slice(2)) {
    const m = /^--(arm|out)=(.+)$/.exec(a);
    if (m) out[m[1]] = m[2];
    else if (a === '--smoke') out.smoke = true;
  }
  if (!['all', 'baseline', 'idle', 'broadcast', 'relaunch'].includes(out.arm)) {
    throw new Error('--arm=all|baseline|idle|broadcast|relaunch');
  }
  return out;
}

function windowTitle(hwnd) {
  const buf = Buffer.alloc(1024);
  const n = GetWindowTextW(hwnd, buf, 512);
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(buf.readUInt16LE(i * 2));
  return s;
}

/** 指定类名的全部顶层窗（z 序）。宿主枚举必须在 harness 侧做：PS 探针的
 *  FindWindowExW 枚举看不见隐藏的竞争窗（A/B 实证 2026-10-11，koffi 通道可见）。 */
function topLevelWindowsOfClass(cls) {
  const out = [];
  let after = 0;
  for (;;) {
    const h = Number(win32.FindWindowExW(0, after, cls, null));
    if (!h) break;
    out.push(h);
    after = h;
  }
  return out;
}

function describeWindows(cls) {
  return topLevelWindowsOfClass(cls).map((h) => {
    const pid = win32.threadIdOf(h).pid;
    return { hwnd: h, class: cls, pid, exe: win32.exeOfPid(pid), visible: !!win32.IsWindowVisible(h) };
  });
}

/** 取证 dump 靶标：explorer 真托盘 + TrayHost 竞争窗（同类名）+ 溢出浮层（独立顶层窗，
 *  Win11 把未提升的第三方托盘图标收在这里——键盘导航走不到，树 dump 是唯一观测面。
 *  溢出窗类名随构建漂移：旧名 NotifyIconOverflowWindow，Win11 22H2+ 改 TopLevelWindowForOverflowXamlExplorer）。 */
function trayDumpTargets() {
  return [
    ...describeWindows('Shell_TrayWnd'),
    ...describeWindows('NotifyIconOverflowWindow'),
    ...describeWindows('TopLevelWindowForOverflowXamlExplorer'),
  ];
}

/** 仅 Shell_TrayWnd 宿主（互斥侦察用：竞争窗在场时 >1） */
function shellTrayHosts() {
  return describeWindows('Shell_TrayWnd');
}

function broadcastTaskbarCreated() {
  const msg = RegisterWindowMessageW('TaskbarCreated');
  win32.PostMessageW(0xffff, msg, 0, 0); // HWND_BROADCAST
}

function readEvents(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function panelAliveByHwnd(hwnd) {
  try {
    const out = Buffer.alloc(16);
    return !!win32.SendMessageTimeoutW(Number(hwnd), 0, 0, 0, 0x0002 /*SMTO_ABORTIFHUNG*/, PROBE_WINDOW_MS, out);
  } catch { return false; }
}

/** 拉真面板：stdout 排空（工单132 根因纪律）、stderr 留尾账、事件落轮目录 */
function launchPanel(eventsFile) {
  const electronExe = require('electron'); // 纯 node 下返回 exe 路径字符串
  const c = spawn(electronExe, ['.', '--panel-accept'], {
    cwd: APP_ROOT,
    env: { ...process.env, DECK_EVENT_LOG: eventsFile, DECK_LAG_SENTINEL: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  c.stdout.on('data', () => {}); // 排空即全部：管道永不满，面板永不因 stdout 阻塞
  let stderrTail = '';
  c.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-4000); });
  c.stderrTail = () => stderrTail;
  return c;
}

/** 面板就绪握手：boot 事件 pid → 面板窗口（Chrome_WidgetWin_1/AGENT DECK）→ tray-host-ready。
 *  tray-host-ready 是 TrayHost 竞争窗与收编广播已发的证据（迁移窗口在场的必要条件）。 */
async function waitPanelReady(eventsFile, child, h) {
  const deadline = Date.now() + PANEL_READY_MS;
  let lastEvents = 0;
  while (Date.now() < deadline) {
    const evs = readEvents(eventsFile);
    lastEvents = evs.length;
    const boot = evs.filter((e) => e.type === 'boot').pop();
    const ready = evs.filter((e) => e.type === 'tray-host-ready').pop();
    if (boot && ready) {
      const hwnd = win32.topLevelWindows().find((w) =>
        win32.threadIdOf(w).pid === boot.pid && win32.className(w) === 'Chrome_WidgetWin_1' && windowTitle(w) === 'AGENT DECK');
      if (hwnd) {
        h({ type: 'panel-ready', childPid: child.pid, panelPid: boot.pid, hwnd, trayHostReady: ready });
        return { panelPid: boot.pid, hwnd, ready };
      }
    }
    if (child.exitCode !== null) throw new Error(`面板提前退出（code=${child.exitCode}）stderr尾：${child.stderrTail()}`);
    await sleep(200);
  }
  throw new Error(`面板 ${PANEL_READY_MS}ms 未就绪（boot/tray-host-ready/窗口 三缺一，事件数=${lastEvents}）stderr尾：${child.stderrTail()}`);
}

/** 面板清场：树杀 + 交还广播（竞争窗随进程消失，广播让图标回注册 explorer） */
async function stopPanel(child, h) {
  if (!child) return;
  if (isAlive(child.pid)) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  }
  await sleep(600);
  broadcastTaskbarCreated();
  await sleep(2500); // 图标重注册回 explorer 的迁移窗口，等它散去
  h({ type: 'panel-stopped', childPid: child.pid, gone: !isAlive(child.pid) });
}

/** taskbar.enabled=false 覆写（对齐主电池跑法：P10 断言依赖原生任务栏在场） */
function configTaskbarOff(h) {
  const configFile = path.join(APP_ROOT, 'config.json');
  const backup = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : null;
  const cfg = backup ? JSON.parse(backup) : {};
  fs.writeFileSync(configFile, JSON.stringify({ ...cfg, taskbar: { ...(cfg.taskbar ?? {}), enabled: false } }, null, 2) + '\n');
  h({ type: 'config-taskbar-off', hadFile: backup !== null });
  return () => {
    try {
      if (backup === null) { try { fs.unlinkSync(configFile); } catch { /* 本就无 */ } }
      else fs.writeFileSync(configFile, backup);
      h({ type: 'config-restored' });
    } catch (e) { h({ type: 'config-restore-failed', message: e.message }); }
  };
}

/** 一轮导航：Win+B → 稳 → probe2 全量走满 → ESC。dump 靶标由 harness 侧枚举显式下发
 *  （harness 前后各拍一次宿主快照，与探针 dump 对照）。原始输出落盘，返回分型轮记录。 */
async function runNavRound(roundsDir, tag, h, eventsFile) {
  const t0 = Date.now();
  const targetsPre = trayDumpTargets();
  win32.send([
    win32.keyInput(VK_LWIN, win32.KEYDOWN), win32.keyInput(VK_B, win32.KEYDOWN),
    win32.keyInput(VK_B, win32.KEYUP), win32.keyInput(VK_LWIN, win32.KEYUP),
  ]);
  await sleep(WINB_SETTLE_MS);
  const dumpHwnds = targetsPre.map((t) => t.hwnd).join(',');
  const probe = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', PROBE_PATH, '-Needle', NEEDLE, '-MaxSteps', '20', '-DumpHwnds', dumpHwnds],
  { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, windowsHide: true });
  const targetsPost = trayDumpTargets();
  const raw = `${probe.stdout || ''}\n# stderr\n${probe.stderr || ''}\n# status=${probe.status} error=${probe.error ? probe.error.message : 'none'}\n# targets-pre ${JSON.stringify(targetsPre)}\n# targets-post ${JSON.stringify(targetsPost)}\n`;
  fs.writeFileSync(path.join(roundsDir, `${tag}.jsonl`), raw);
  win32.tapKeys([VK_ESCAPE]);
  const parsed = parseProbeOutput(probe.stdout);
  const round = classifyRound(parsed, NEEDLE);
  round.tag = tag;
  round.t0 = t0;
  round.t1 = Date.now();
  round.probeStatus = probe.status;
  round.probeTimedOut = !!(probe.error && probe.error.killed);
  round.targetsPre = targetsPre;
  round.targetsPost = targetsPost;
  if (eventsFile) {
    // 轮窗内面板侧托盘事件（收编 add/delete、competition 等，带 t 对齐）
    round.panelEvents = readEvents(eventsFile)
      .filter((e) => String(e.type || '').startsWith('tray') && e.t >= t0 && e.t <= round.t1);
  }
  h({ type: 'round', tag, signature: round.signature, firstMatch: round.firstMatch, emptySteps: round.emptySteps, probeStatus: probe.status });
  await sleep(INTER_ROUND_MS);
  return round;
}

/** 面板存活复核（每轮前）：死/冻都判脏——取证前提是被测面板健康在场 */
function assertPanelHealthy(state, h) {
  if (!isAlive(state.panelPid) || !win32.IsWindow(state.hwnd)) throw new Error(`面板中途消失（pid=${state.panelPid}）`);
  if (!panelAliveByHwnd(state.hwnd)) throw new Error(`面板 WM_NULL 探针超时（假死形态，pid=${state.panelPid}）——取证前提被破坏`);
}

async function armBaseline(h, armDir, rounds) {
  const hosts = shellTrayHosts();
  h({ type: 'recon', hosts });
  const ok = hosts.length === 1 && path.basename(hosts[0].exe || '').toLowerCase().replace(/\.exe$/, '') === 'explorer';
  if (!ok) throw new Error(`互斥侦察失败：Shell_TrayWnd ×${hosts.length}（${hosts.map((x) => `${x.exe}:${x.pid}`).join(', ')}）——期望唯一 explorer 宿主，机器脏`);
  const roundsDir = path.join(armDir, 'rounds');
  fs.mkdirSync(roundsDir, { recursive: true });
  const out = [];
  for (let i = 1; i <= rounds; i++) out.push(await runNavRound(roundsDir, `baseline-r${String(i).padStart(2, '0')}`, h, null));
  return out;
}

async function armWithPanel(h, armDir, rounds, mode) {
  const eventsFile = path.join(armDir, 'panel-events.jsonl');
  const roundsDir = path.join(armDir, 'rounds');
  fs.mkdirSync(roundsDir, { recursive: true });
  const restore = configTaskbarOff(h);
  const child = launchPanel(eventsFile);
  const spawned = [child];
  try {
    const state = await waitPanelReady(eventsFile, child, h);
    if (mode === 'idle') await sleep(IDLE_SETTLE_MS);
    const out = [];
    for (let i = 1; i <= rounds; i++) {
      assertPanelHealthy(state, h);
      const tag = `${mode}-r${String(i).padStart(2, '0')}`;
      if (mode === 'broadcast') {
        h({ type: 'broadcast', round: i });
        broadcastTaskbarCreated();
        await sleep(POST_BROADCAST_MS);
      }
      out.push(await runNavRound(roundsDir, tag, h, eventsFile));
    }
    return out;
  } finally {
    await stopPanel(child, h);
    restore();
    const leftovers = spawned.filter((c) => isAlive(c.pid)).map((c) => c.pid);
    if (leftovers.length) h({ type: 'arm-leftovers', pids: leftovers });
  }
}

async function armRelaunch(h, armDir, rounds) {
  const roundsDir = path.join(armDir, 'rounds');
  fs.mkdirSync(roundsDir, { recursive: true });
  const restore = configTaskbarOff(h);
  const out = [];
  let child = null;
  try {
    for (let i = 1; i <= rounds; i++) {
      const eventsFile = path.join(armDir, `panel-events-r${String(i).padStart(2, '0')}.jsonl`);
      child = launchPanel(eventsFile);
      const state = await waitPanelReady(eventsFile, child, h); // 就绪即导航：电池 P8 重启→P10 的真实间隔远长，这里打最密窗口
      const tag = `relaunch-r${String(i).padStart(2, '0')}`;
      h({ type: 'relaunch-round', round: i, panelPid: state.panelPid });
      out.push(await runNavRound(roundsDir, tag, h, eventsFile));
      await stopPanel(child, h);
      child = null;
      await sleep(500);
    }
    return out;
  } finally {
    if (child) await stopPanel(child, h);
    restore();
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const roundsOf = (arm) => args.smoke ? 1 : ARM_ROUNDS[arm];
  const runDir = path.join(args.out, `run-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`);
  fs.mkdirSync(runDir, { recursive: true });
  const hlog = [];
  const h = (ev) => { hlog.push({ t: Date.now(), ...ev }); console.log(`[uia-tray-forensics] ${JSON.stringify(ev)}`); };
  h({ type: 'run-start', ...args, rounds: Object.fromEntries(Object.entries(ARM_ROUNDS).map(([k, v]) => [k, roundsOf(k)])) });

  const order = args.arm === 'all' ? ['baseline', 'idle', 'broadcast', 'relaunch'] : [args.arm];
  const statsByArm = {};
  let dirty = false;
  for (const arm of order) {
    const armDir = path.join(runDir, arm);
    fs.mkdirSync(armDir, { recursive: true });
    h({ type: 'arm-start', arm, rounds: roundsOf(arm) });
    let rounds = [];
    try {
      if (arm === 'baseline') rounds = await armBaseline(h, armDir, roundsOf(arm));
      else if (arm === 'relaunch') rounds = await armRelaunch(h, armDir, roundsOf(arm));
      else rounds = await armWithPanel(h, armDir, roundsOf(arm), arm);
    } catch (e) {
      h({ type: 'arm-failed', arm, message: e.message, stack: (e.stack || '').split('\n').slice(0, 4).join(' | ') });
      dirty = true;
    }
    const stats = aggregateRounds(rounds);
    statsByArm[arm] = stats;
    fs.writeFileSync(path.join(armDir, 'rounds.jsonl'), rounds.map((r) => JSON.stringify(r)).join('\n') + '\n');
    fs.writeFileSync(path.join(armDir, 'aggregate.json'), JSON.stringify(stats, null, 2));
    h({ type: 'arm-done', arm, rounds: rounds.length, signatureCounts: stats.signatureCounts });
  }

  const verdict = verdictRows(statsByArm);
  const finalHosts = shellTrayHosts();
  const finalDirty = finalHosts.length !== 1;
  if (finalDirty) { h({ type: 'final-recon-dirty', hosts: finalHosts }); dirty = true; }
  const summary = { ...args, runDir, arms: order, statsByArm, verdict, finalHosts, dirty, exitCode: dirty ? 3 : 0 };
  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(runDir, 'harness-log.jsonl'), hlog.map((e) => JSON.stringify(e)).join('\n') + '\n');
  console.log(`[uia-tray-forensics] 轮账：arms=${order.join('+')} 判读=${verdict.row} 电池路径同征=${verdict.batteryPathConfirmed} dirty=${dirty} → ${runDir}`);
  process.exit(summary.exitCode); // 硬退出：不依赖事件循环排空
}

if (require.main === module) {
  main().catch((err) => { console.error('[uia-tray-forensics] 轮失败：', err); process.exit(3); });
}

module.exports = { shellTrayHosts, broadcastTaskbarCreated, parseArgs }; // 供外部复核/复用
