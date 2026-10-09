'use strict';
// 工单118 取证 harness：停摆/卡死进程的「可杀性」杀灭阶梯实验（单轮一进程一臂）。
// 设计与预登记判读标准：docs/audit/2026-10-09-t118-kill-forensics.md。
// 用法（纯 node，无需 electron 上下文；产物落 --out 指定目录，不进仓库）：
//   node accept/experiments/kill-forensics.js --arm=s1|s2|s3|panel [--seconds=360] [--profile=normal|elevated] [--out=<dir>]
// 臂：
//   s1    满管道写卡死：node 子进程 fs.writeSync 循环写 stdout（读端在场不读）→ 主线程冻于内核写
//   s2    读端死亡解锁：s1 形态 + 中继 proxy 持读端；杀 proxy 后观察写者是否自行解除/退出
//   s3    挂死窗同步发送卡死：接收端子进程建 message-only 静态窗（HWND_MESSAGE，零桌面足迹）后
//         Atomics.wait 永不泵消息；发送者 SendMessageW 同步发送冻于内核（审计嫌疑① trayhost 同款形态）
//   panel 真面板停摆复现：proxy 不排空 stdout 拉真面板（复现 #132 前条件）→ WM_NULL 判冻 → 杀 proxy
//         （读端死亡）观察面板 → 阶梯收尾。碰真桌面，一律经 accept-guard 托管。
// 阶梯（--profile）：normal=R1 taskkill /F /T → R2 koffi 直调 TerminateProcess；
//   elevated=R3 提权 taskkill /F → R4 提权 Stop-Process -Force（须自提权 shell 跑）。
//   每档前 OpenProcess(PROCESS_TERMINATE) 探针（终止态进程拒开是假说b指纹）；每档 60s 观察窗；
//   档间卡死者补 dump；终局复核。panel 臂碰真桌面，一律经 accept-guard 托管。
// 本 harness 是取证工具不是验收段：不进 manifest、不产 verdict、退出码 0=轮完成 3=机器脏（有存活者）。
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const win32 = require('../lib/win32');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_OUT = 'D:\\test-folder\\.agent-notes\\t118-kill-forensics';
const PROBE_TIMEOUT_MS = 2000;   // WM_NULL 探针超时（battery.panelLiveness 同款）
const FROZEN_PROBES = 6;          // 连续超时拍数 → 判冻结
const RUNG_WINDOW_MS = 60000;     // 每档杀灭后的观察窗（12min 先例说明卡死可久，60s 是取证预算折中）
const READER_DEATH_WATCH_MS = 120000; // s2/panel 读端死亡后的观察窗
const POLL_MS = 200;
const PROCESS_TERMINATE = 0x0001;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// —— koffi 本地绑定（win32.js 未导出的部分；stall-duel.js 同款手法）——
const kernel32 = win32.koffi.load('kernel32.dll');
const dbghelp = win32.koffi.load('dbghelp.dll');
const OpenProcess = kernel32.func('uintptr_t __stdcall OpenProcess(uint32 dwDesiredAccess, bool bInheritHandle, uint32 dwProcessId)');
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(uintptr_t hObject)');
const TerminateProcess = kernel32.func('bool __stdcall TerminateProcess(uintptr_t hProcess, uint32 uExitCode)');
const GetLastError = kernel32.func('uint32 __stdcall GetLastError()');
const CreateFileW = kernel32.func('uintptr_t __stdcall CreateFileW(const char16_t* lpFileName, uint32 dwDesiredAccess, uint32 dwShareMode, void* lpSecurityAttributes, uint32 dwCreationDisposition, uint32 dwFlagsAndAttributes, uintptr_t hTemplateFile)');
const MiniDumpWriteDump = dbghelp.func('bool __stdcall MiniDumpWriteDump(uintptr_t hProcess, uint32 ProcessId, uintptr_t hFile, uint32 DumpType, void* ExceptionParam, void* UserStreamParam, void* CallbackParam)');

/** 冻结进程 minidump（stall-duel.dumpFrozenMain 同款：MiniDumpNormal，事后 python minidump 模块归属） */
function dumpProcess(pid, outFile) {
  const hProc = Number(OpenProcess(0x0410, false, pid)); // QUERY_INFORMATION | VM_READ
  if (!hProc) throw new Error(`OpenProcess(${pid}) 失败 gle=${GetLastError()}`);
  const hFile = Number(CreateFileW(outFile, 0x40000000, 0, null, 2, 0x80, 0)); // GENERIC_WRITE, CREATE_ALWAYS
  try {
    if (!hFile || hFile === -1) throw new Error('CreateFileW 失败');
    if (!MiniDumpWriteDump(hProc, pid, hFile, 0, null, null, null)) throw new Error(`MiniDumpWriteDump 失败 gle=${GetLastError()}`);
    return outFile;
  } finally {
    if (hFile && hFile !== -1) CloseHandle(hFile);
    CloseHandle(hProc);
  }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** OpenProcess(PROCESS_TERMINATE) 探针：终止态/ACL 拒开的指纹采集 */
function openProbe(pid) {
  const h = Number(OpenProcess(PROCESS_TERMINATE, false, pid));
  if (h) { CloseHandle(h); return { pid, opened: true }; }
  return { pid, opened: false, gle: GetLastError() };
}

/** 线程态取证（stall-duel freeze-forensics 同款）：ThreadState/WaitReason 直方图 + cpu */
function psForensics(pids) {
  const ids = pids.filter((p) => p).join(',');
  const ps = spawnSync('powershell', ['-NoProfile', '-Command', [
    `$ids=@(${ids})`,
    `$rows=@(); foreach($id in $ids){ $p=Get-Process -Id $id -ErrorAction SilentlyContinue; $n=(Get-CimInstance Win32_Process -Filter "ProcessId=$id").Name; $t=if($p){($p.Threads | ForEach-Object { "$($_.ThreadState)/$($_.WaitReason)" } | Group-Object | Sort-Object Count -Descending | Select-Object -First 4 | ForEach-Object { "$($_.Name)x$($_.Count)" }) -join ' '}else{'<已退出>'}; $rows += "$id $n cpu=$($p.CPU)s ws=$([math]::Round($p.WorkingSet64/1KB))K 线程=$t" }`,
    `$rows -join [Environment]::NewLine`,
  ].join(';')], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  return (ps.stdout || ps.stderr || '').trim();
}

/** 主线程是否处于 Wait 态（写者/发送者卡死验证：不烧 CPU、主线程内核等待）。
 * PS 输出经 bash 管道有 GBK/UTF8 乱码风险，判据只用 ASCII 的 State/Reason 直方图项。 */
function mainThreadWaiting(pid) {
  const txt = psForensics([pid]);
  return { txt, waiting: /Wait\//.test(txt) && !/Running\//.test(txt) };
}

function taskkillTree(pid) {
  const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  return { code: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim().split('\n').pop() };
}

function terminateDirect(pid) {
  const h = Number(OpenProcess(PROCESS_TERMINATE, false, pid));
  if (!h) return { issued: false, gle: GetLastError() };
  const ok = TerminateProcess(h, 1);
  const gle = ok ? null : GetLastError();
  CloseHandle(h);
  return { issued: ok, gle };
}

function stopProcessForce(pid) {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force -ErrorAction Continue; exit 0`], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  return { code: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim().split('\n').pop() };
}

const RUNGS = {
  normal: [
    { id: 'R1-taskkill', run: (pid) => taskkillTree(pid) },
    { id: 'R2-terminate-direct', run: (pid) => terminateDirect(pid) },
  ],
  elevated: [
    { id: 'R3-taskkill-elevated', run: (pid) => taskkillTree(pid) },
    { id: 'R4-stop-process-elevated', run: (pid) => stopProcessForce(pid) },
  ],
};

/** 杀灭阶梯：每档前探针，档后 60s 观察窗，卡死者档间补 dump；返回逐档账目 */
async function runLadder(pid, profile, roundDir, h) {
  const results = [];
  for (const rung of RUNGS[profile]) {
    if (!isAlive(pid)) { results.push({ rung: rung.id, skipped: 'already-gone' }); break; }
    const pre = openProbe(pid);
    const issued = rung.run(pid);
    const t0 = Date.now();
    let deathMs = null;
    while (Date.now() - t0 < RUNG_WINDOW_MS) {
      await sleep(POLL_MS);
      if (!isAlive(pid)) { deathMs = Date.now() - t0; break; }
    }
    const entry = { rung: rung.id, preOpen: pre, issued, deathMs, survived: deathMs === null };
    if (entry.survived) {
      const tag = `post-${rung.id}`;
      try { entry.dump = dumpProcess(pid, path.join(roundDir, `${tag}.dmp`)); } catch (e) { entry.dumpError = e.message; }
      entry.forensics = psForensics([pid]);
    }
    h({ type: 'ladder-rung', ...entry });
    results.push(entry);
    if (deathMs !== null) break;
  }
  return results;
}

function parseArgs(argv) {
  const out = { arm: null, seconds: 360, profile: 'normal', out: DEFAULT_OUT };
  for (const a of argv.slice(2)) {
    const m = /^--(arm|seconds|profile|out)=(.+)$/.exec(a);
    if (m) out[m[1]] = m[2];
  }
  out.seconds = Number(out.seconds) || 360;
  if (!['s1', 's2', 's3', 'panel'].includes(out.arm)) throw new Error('--arm=s1|s2|s3|panel 必填');
  if (!['normal', 'elevated'].includes(out.profile)) throw new Error('--profile=normal|elevated');
  return out;
}

// —— 生成的被试脚本（落轮目录，自证形态）——
const WRITER_JS = `// s1/s2 写者：同步写满 stdout 管道（读端不读 → 64KB 后冻于内核写，#132 根因同款路径）
const fs = require('fs');
const b = Buffer.alloc(65536, 0x61);
fs.writeSync(2, 'writer-ready\\n');
for (;;) fs.writeSync(1, b);
`;

const PROXY_JS = `// s2 读端中继：spawn 写者并持其 stdout 读端，永不读取；自身只排空 stderr。被杀即读端关闭。
const { spawn } = require('child_process');
const w = spawn(process.execPath, [process.argv[2]], { stdio: ['ignore', 'pipe', 'pipe'] });
w.stderr.on('data', () => {});
console.log('proxy-ready pid=' + w.pid);
setInterval(() => {}, 1 << 30);
`;

const PANEL_PROXY_JS = `// panel 读端中继：拉真面板且【故意不排空 stdout】——复现 #132 修复前的停摆触发条件（battery.js:810 注释）。
// 注意：不给 stdout 挂 data 监听 = 不排空；挂了监听哪怕空回调也是排空（即 #137 修复形态）。
// stderr 落盘轮目录：面板启动失败时留诊断（不排空只限 stdout）。
const { spawn } = require('child_process');
const fs = require('fs');
const [exe, appRoot, eventsFile, errFile] = process.argv.slice(2);
const c = spawn(exe, ['.', '--panel-accept'], {
  cwd: appRoot,
  env: { ...process.env, DECK_EVENT_LOG: eventsFile, DECK_LAG_SENTINEL: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
c.stdout.on('close', () => console.log('panel-stdout-closed'));
c.stderr.on('data', (d) => { try { fs.appendFileSync(errFile, d); } catch { /* 尽力 */ } });
console.log('proxy-ready pid=' + c.pid);
setInterval(() => {}, 1 << 30);
`;

const SENDER_TEMPLATE = `// s3 发送者：SendMessageW 同步发送到挂死窗（接收端永不泵消息）→ 冻于 user32/win32k 内核等待
const koffi = require(__KOFFI__);
const u = koffi.load('user32.dll');
const SendMessageW = u.func('intptr_t __stdcall SendMessageW(uintptr_t, uint32, uintptr_t, intptr_t)');
const fs = require('fs');
fs.writeSync(2, 'sender-ready\\n');
const r = SendMessageW(Number(process.argv[2]), 0x0400, 0, 0); // WM_USER，同步
fs.writeSync(2, 'send-returned ' + r + '\\n');
`;

const RECEIVER_TEMPLATE = `// s3 接收者：message-only 静态窗（HWND_MESSAGE——不可见、不入桌面 z 序、EnumWindows 不可见），
// 建窗后 Atomics.wait 永不泵消息 = 挂死窗（审计嫌疑①：trayhost 泵卡死时对端窗无人应答的同款形态）。
const koffi = require(__KOFFI__);
const u = koffi.load('user32.dll');
const k = koffi.load('kernel32.dll');
const CreateWindowExW = u.func('uintptr_t __stdcall CreateWindowExW(uint32, const char16_t*, const char16_t*, uint32, int32, int32, int32, int32, uintptr_t, uintptr_t, uintptr_t, void*)');
const GetModuleHandleW = k.func('uintptr_t __stdcall GetModuleHandleW(const char16_t*)');
const hInst = Number(GetModuleHandleW(null));
const HWND_MESSAGE = 0xfffffffffffffffdn; // (uintptr_t)-3
const hwnd = Number(CreateWindowExW(0, 'STATIC', 't118recv', 0, 0, 0, 100, 50, HWND_MESSAGE, 0, hInst, null));
require('fs').writeSync(2, 'recv-ready hwnd=' + hwnd + '\\n');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
`;

async function armS1(args, roundDir, h) {
  const writerPath = path.join(roundDir, 'writer.js');
  fs.writeFileSync(writerPath, WRITER_JS);
  const subject = spawn(process.execPath, [writerPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  subject.stderr.on('data', () => {}); // 只排空 stderr（写者就绪标记走这）；stdout 不挂监听=读端在场不读
  await sleep(1500);
  const st = mainThreadWaiting(subject.pid);
  h({ type: 'subject-stuck-check', pid: subject.pid, waiting: st.waiting, forensics: st.txt });
  try { h({ type: 'pre-dump', file: dumpProcess(subject.pid, path.join(roundDir, 'stuck-main.dmp')) }); } catch (e) { h({ type: 'pre-dump-failed', message: e.message }); }
  const ladder = await runLadder(subject.pid, args.profile, roundDir, h);
  return { subjectPid: subject.pid, stuckVerified: st.waiting, ladder };
}

async function armS2(args, roundDir, h) {
  const writerPath = path.join(roundDir, 'writer.js');
  const proxyPath = path.join(roundDir, 'proxy.js');
  fs.writeFileSync(writerPath, WRITER_JS);
  fs.writeFileSync(proxyPath, PROXY_JS);
  const proxy = spawn(process.execPath, [proxyPath, writerPath], { stdio: ['ignore', 'pipe', 'ignore'] });
  let writerPid = null;
  let buf = '';
  const ready = new Promise((res) => { proxy.stdout.on('data', (d) => { buf += d; const m = /proxy-ready pid=(\d+)/.exec(buf); if (m) { writerPid = Number(m[1]); res(writerPid); } }); });
  await Promise.race([ready, sleep(5000)]);
  if (!writerPid) throw new Error('proxy 5s 未就绪');
  await sleep(1500);
  const st = mainThreadWaiting(writerPid);
  h({ type: 'subject-stuck-check', pid: writerPid, waiting: st.waiting, forensics: st.txt });
  try { h({ type: 'pre-dump', file: dumpProcess(writerPid, path.join(roundDir, 'stuck-main.dmp')) }); } catch (e) { h({ type: 'pre-dump-failed', message: e.message }); }
  // —— 读端死亡：杀 proxy（其持写者 stdout 读端；写者成孤儿）——
  const killRes = taskkillTree(proxy.pid);
  let proxyGoneMs = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 10000) { await sleep(POLL_MS); if (!isAlive(proxy.pid)) { proxyGoneMs = Date.now() - t0; break; } }
  h({ type: 'reader-killed', proxyPid: proxy.pid, killRes, proxyGoneMs });
  // —— 观察写者：解除阻塞应自行退出（fs.writeSync 抛错→未捕获→退出）——
  const t1 = Date.now();
  let writerDeathMs = null;
  while (Date.now() - t1 < READER_DEATH_WATCH_MS) { await sleep(POLL_MS); if (!isAlive(writerPid)) { writerDeathMs = Date.now() - t1; break; } }
  h({ type: 'reader-death-watch', writerPid, writerDeathMs, unblocked: writerDeathMs !== null });
  const readerDeath = { proxyGoneMs, writerDeathMs, unblocked: writerDeathMs !== null };
  if (writerDeathMs !== null) return { subjectPid: writerPid, stuckVerified: st.waiting, readerDeath, ladder: [] };
  // 读端死了仍卡 → 补 dump 再上阶梯（这正是 10-08 僵尸的形态问题）
  try { h({ type: 'post-reader-death-dump', file: dumpProcess(writerPid, path.join(roundDir, 'post-reader-death.dmp')) }); } catch (e) { h({ type: 'dump-failed', message: e.message }); }
  const ladder = await runLadder(writerPid, args.profile, roundDir, h);
  return { subjectPid: writerPid, stuckVerified: st.waiting, readerDeath, ladder };
}

async function armS3(args, roundDir, h) {
  const koffiPath = require.resolve('koffi', { paths: [path.join(APP_ROOT, 'node_modules')] });
  // 接收端：message-only 静态窗 + 永不泵消息（原 notepad 挂起方案作废：Win11 记事本单实例复用，
  // 新进程无窗、窗属既有实例，挂错对象且误伤用户窗口的风险不可接受）
  const recvPath = path.join(roundDir, 'recv.js');
  const senderPath = path.join(roundDir, 'sender.js');
  fs.writeFileSync(recvPath, RECEIVER_TEMPLATE.replace('__KOFFI__', JSON.stringify(koffiPath)));
  fs.writeFileSync(senderPath, SENDER_TEMPLATE.replace('__KOFFI__', JSON.stringify(koffiPath)));
  const recv = spawn(process.execPath, [recvPath], { stdio: ['ignore', 'ignore', 'pipe'] });
  let recvSays = '';
  let hwnd = null;
  const ready = new Promise((res) => { recv.stderr.on('data', (d) => { recvSays += d; const m = /recv-ready hwnd=(\d+)/.exec(recvSays); if (m) { hwnd = Number(m[1]); res(hwnd); } }); });
  await Promise.race([ready, sleep(5000)]);
  if (!hwnd) throw new Error(`接收端 5s 未就绪：${recvSays.trim()}`);
  h({ type: 'receiver-ready', pid: recv.pid, hwnd });
  // 发送者：同步 SendMessage 冻结
  const sender = spawn(process.execPath, [senderPath, String(hwnd)], { stdio: ['ignore', 'ignore', 'pipe'] });
  let senderSays = '';
  sender.stderr.on('data', (d) => { senderSays += d; });
  await sleep(1500);
  const st = mainThreadWaiting(sender.pid);
  const senderStuck = st.waiting && !senderSays.includes('send-returned');
  h({ type: 'subject-stuck-check', pid: sender.pid, waiting: st.waiting, senderSays: senderSays.trim(), forensics: st.txt });
  let ladder = [];
  const stuckVerified = senderStuck;
  if (senderStuck) {
    try { h({ type: 'pre-dump', file: dumpProcess(sender.pid, path.join(roundDir, 'stuck-main.dmp')) }); } catch (e) { h({ type: 'pre-dump-failed', message: e.message }); }
    ladder = await runLadder(sender.pid, args.profile, roundDir, h);
  } else {
    h({ type: 'sender-not-stuck', note: '发送者未冻结，跳过阶梯（接收端建窗失败或消息已回）' });
  }
  // 清场：接收端与发送者一并强杀（发送者若已死则 taskkill 空报）
  taskkillTree(recv.pid);
  if (isAlive(sender.pid)) taskkillTree(sender.pid);
  await sleep(800);
  h({ type: 'cleanup', recvGone: !isAlive(recv.pid), senderGone: !isAlive(sender.pid) });
  return { subjectPid: sender.pid, receiverPid: recv.pid, stuckVerified, ladder };
}

function readEvents(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function windowTitle(hwnd) {
  const user32Title = win32.koffi.load('user32.dll');
  const GetWindowTextW = user32Title.func('int __stdcall GetWindowTextW(uintptr_t hWnd, uint16 *buf, int nMax)');
  const buf = Buffer.alloc(1024);
  const n = GetWindowTextW(hwnd, buf, 512);
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(buf.readUInt16LE(i * 2));
  return s;
}

function panelAliveByHwnd(hwnd) {
  try {
    const out = Buffer.alloc(16);
    return !!win32.SendMessageTimeoutW(Number(hwnd), 0, 0, 0, 0x0002, PROBE_TIMEOUT_MS, out);
  } catch { return false; }
}

function childrenOf(pid) {
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | ForEach-Object { "$($_.ProcessId):$($_.Name)" }) -join ','`],
    { encoding: 'utf8', timeout: 15000, windowsHide: true });
  return (r.stdout || '').trim();
}

async function armPanel(args, roundDir, h) {
  const eventsFile = path.join(roundDir, 'panel-events.jsonl');
  const proxyPath = path.join(roundDir, 'panel-proxy.js');
  fs.writeFileSync(proxyPath, PANEL_PROXY_JS);
  // taskbar 覆写（stall-duel 同款纪律：对齐主电池跑法，清场还原）
  const configFile = path.join(APP_ROOT, 'config.json');
  let configBackup = null;
  if (fs.existsSync(configFile)) configBackup = fs.readFileSync(configFile, 'utf8');
  const cfgNow = (() => { try { return JSON.parse(configBackup ?? '{}'); } catch { return {}; } })();
  fs.writeFileSync(configFile, JSON.stringify({ ...cfgNow, taskbar: { ...(cfgNow.taskbar ?? {}), enabled: false } }, null, 2) + '\n');
  const electronExe = require('electron'); // 纯 node 下 require('electron') 返回 exe 路径字符串
  const proxy = spawn(process.execPath, [proxyPath, electronExe, APP_ROOT, eventsFile, path.join(roundDir, 'panel-stderr.log')], { stdio: ['ignore', 'pipe', 'ignore'] });
  h({ type: 'proxy-spawned', pid: proxy.pid });
  let panelPid = null;
  let buf = '';
  const ready = new Promise((res) => { proxy.stdout.on('data', (d) => { buf += d; const m = /proxy-ready pid=(\d+)/.exec(buf); if (m) { panelPid = Number(m[1]); res(panelPid); } }); });
  await Promise.race([ready, sleep(15000)]);
  if (!panelPid) throw new Error('panel proxy 15s 未就绪');
  // 面板窗口就位（stall-duel 同款：boot 事件 pid + Chrome_WidgetWin_1/AGENT DECK）
  let panelHwnd = null;
  const launchDeadline = Date.now() + 25000;
  while (Date.now() < launchDeadline && !panelHwnd) {
    const boot = readEvents(eventsFile).filter((e) => e.type === 'boot').pop();
    if (boot) {
      panelHwnd = win32.topLevelWindows().find((w) =>
        win32.threadIdOf(w).pid === panelPid && win32.className(w) === 'Chrome_WidgetWin_1' && windowTitle(w) === 'AGENT DECK') || null;
    }
    await sleep(200);
  }
  if (!panelHwnd) {
    h({ type: 'panel-window-miss', panelPid });
    taskkillTree(proxy.pid);            // 失败路径也清场：proxy/面板树不泄漏（否则 harness 事件循环被
    if (panelPid) taskkillTree(panelPid); // 存活子进程钉住，guard 槽永不释放——首跑实证）
    if (fs.existsSync(path.join(roundDir, 'panel-stderr.log'))) {
      h({ type: 'panel-stderr-tail', tail: fs.readFileSync(path.join(roundDir, 'panel-stderr.log'), 'utf8').slice(-1500) });
    }
    throw new Error('25s 内未找到面板窗口');
  }
  h({ type: 'panel-ready', pid: panelPid, hwnd: panelHwnd });
  // —— 停摆侦测：500ms 一拍 WM_NULL，连续 6 次超时 = 冻结（不排空 stdout 的自然后果）——
  const deadline = Date.now() + args.seconds * 1000;
  let timeouts = 0, frozen = false, freezeAt = null;
  while (Date.now() < deadline) {
    const ok = panelAliveByHwnd(panelHwnd);
    timeouts = ok ? 0 : timeouts + 1;
    if (timeouts >= FROZEN_PROBES) { frozen = true; freezeAt = Date.now(); break; }
    await sleep(500);
  }
  h({ type: frozen ? 'panel-frozen' : 'panel-no-freeze', pid: panelPid, freezeAt, waitedMs: Date.now() - (deadline - args.seconds * 1000) });
  const childListBefore = childrenOf(panelPid);
  h({ type: 'panel-children-before', children: childListBefore });
  const result = { panelPid, frozen, childListBefore, ladder: [] };
  if (frozen) {
    try { h({ type: 'freeze-dump', file: dumpProcess(panelPid, path.join(roundDir, 'freeze-main.dmp')) }); } catch (e) { h({ type: 'freeze-dump-failed', message: e.message }); }
    fs.writeFileSync(path.join(roundDir, 'freeze-forensics.txt'),
      `# 冻结线程态取证（t=${new Date(freezeAt).toISOString()} pid=${panelPid}）\n${psForensics([panelPid])}\n# 子进程\n${childListBefore}\n`);
    // —— 读端死亡：杀 proxy（其持面板 stdout 读端）——观察面板是否自行解除/退出 ——
    const killRes = taskkillTree(proxy.pid);
    const t0 = Date.now();
    while (Date.now() - t0 < 10000 && isAlive(proxy.pid)) await sleep(POLL_MS);
    h({ type: 'reader-killed', proxyPid: proxy.pid, killRes });
    const t1 = Date.now();
    let panelDeathMs = null, panelUnfrozeMs = null;
    while (Date.now() - t1 < READER_DEATH_WATCH_MS) {
      await sleep(1000);
      if (!isAlive(panelPid)) { panelDeathMs = Date.now() - t1; break; }
      if (panelUnfrozeMs === null && panelAliveByHwnd(panelHwnd)) panelUnfrozeMs = Date.now() - t1;
    }
    result.readerDeath = { killRes, panelDeathMs, panelUnfrozeMs };
    h({ type: 'reader-death-watch', ...result.readerDeath });
    if (panelDeathMs === null) {
      // 仍活：补 dump 再上阶梯（含子进程树账目）
      try { h({ type: 'post-reader-death-dump', file: dumpProcess(panelPid, path.join(roundDir, 'post-reader-death.dmp')) }); } catch (e) { h({ type: 'dump-failed', message: e.message }); }
      result.ladder = await runLadder(panelPid, args.profile, roundDir, h);
    }
  } else {
    // 未冻结：健康面板的阶梯基线（应 R1 即死——对照账）
    result.ladder = await runLadder(panelPid, args.profile, roundDir, h);
  }
  // 清场：终局复核 + 子进程遗留账
  await sleep(1000);
  const leftovers = [];
  for (const pid of [panelPid, ...childListBefore.split(',').filter(Boolean).map((s) => Number(s.split(':')[0]))]) {
    if (pid && isAlive(pid)) leftovers.push(pid);
  }
  result.leftovers = leftovers;
  h({ type: 'final-check', leftovers });
  // 配置还原
  try {
    if (configBackup === null) { try { fs.unlinkSync(configFile); } catch { /* 本就无 */ } }
    else fs.writeFileSync(configFile, configBackup);
  } catch (e) { h({ type: 'config-restore-failed', message: e.message }); }
  return result;
}

async function main() {
  const args = parseArgs(process.argv);
  const roundDir = path.join(args.out, `${args.arm}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`);
  fs.mkdirSync(roundDir, { recursive: true });
  const hlog = [];
  const h = (ev) => { hlog.push({ t: Date.now(), ...ev }); console.log(`[kill-forensics] ${JSON.stringify(ev)}`); };
  h({ type: 'round-start', ...args, elevatedShell: (() => {
    const r = spawnSync('powershell', ['-NoProfile', '-Command', '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    return (r.stdout || '').trim() === 'True';
  })() });
  let result;
  try {
    if (args.arm === 's1') result = await armS1(args, roundDir, h);
    else if (args.arm === 's2') result = await armS2(args, roundDir, h);
    else if (args.arm === 's3') result = await armS3(args, roundDir, h);
    else result = await armPanel(args, roundDir, h);
  } catch (e) {
    h({ type: 'arm-failed', message: e.message, stack: (e.stack || '').split('\n').slice(0, 4).join(' | ') });
    result = { failed: e.message };
  }
  const survivor = Array.isArray(result.ladder) && result.ladder.length > 0
    ? result.ladder[result.ladder.length - 1].survived
    : false;
  const summary = { ...args, roundDir, result, survivor, exitCode: survivor || result.failed ? 3 : 0 };
  fs.writeFileSync(path.join(roundDir, 'harness-log.jsonl'), hlog.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(roundDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`[kill-forensics] 轮账：arm=${args.arm} survivor=${survivor} → ${roundDir}`);
  process.exit(summary.exitCode); // 硬退出：不依赖事件循环排空（存活子进程会钉住它）
}

if (require.main === module) {
  main().catch((err) => { console.error('[kill-forensics] 轮失败：', err); process.exitCode = 3; });
}
module.exports = { parseArgs, runLadder, isAlive, openProbe };
