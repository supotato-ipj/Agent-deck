'use strict';
// 工单132 第一阶段：H1 vs H7 对照实验 harness（stall-duel，单轮一进程）。
// 设计与预登记判读标准：docs/audit/2026-10-09-t132-stall-duel-experiment.md。
// 用法（一律经 accept-guard 托管）：
//   electron . --accept-stall-duel --arm=kb|sys|raw|still|bare [--round=1] [--seconds=240]
//     [--wind（phase-1b Win+D）] [--tag=1a] [--taskbar=on|off（默认 off，对齐主电池跑法）]
// 消元阶梯（r1 后追加的臂，spec §0.x 入账）：raw=去CDP裸负载，still=纯探针，bare=零接触终局对照
// 轮产物：accept/evidence/stall-duel/<tag>/r<round>-<arm>/{panel-events.jsonl(+.spans.jsonl),
//   harness-log.jsonl, summary.json}；summary 由 stall-duel-analyze 纯函数算出。
// 本 harness 是取证工具不是验收段：不进 manifest、不产 verdict、退出码 0=轮完成 3=机器脏。
const { app, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const win32 = require('../lib/win32');
const { createPanelControl } = require('../lib/panel-control');
const {
  dedupeProbeStalls, couplingStats, classifyOrder, labelDistribution,
} = require('./stall-duel-analyze');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const CDP_PORT = 9333;
const VK_LWIN = 0x5b, VK_D = 0x44;
const SW_RESTORE = 9;
const SWP_NOZORDER = 0x0004; // lib/win32.js 未导出此常量（battery.js 同名引用实为 undefined 的既有潜伏坑，本地常量避开）
const KB_CYCLE_MS = 600;      // 键盘模式 on/off 交替拍（A 臂真 eval / B 臂空 eval 同拍）
const MOUSE_STEP_MS = 200;    // 鼠标移动流拍（5Hz，共主输入合成负载）
const CAPTURE_MS = 3000;      // 像素捕获拍（GDI，GPU/DWM 负载）
const WIND_MS = 10000;        // phase-1b Win+D toggle 拍
const PROBE_MS = 500;         // WM_NULL 探针拍
const PROBE_TIMEOUT_MS = 2000;
const FROZEN_PROBES = 6;      // 连续超时拍数 → 判终末冻结，提前收场
const WAKE_WINDOW_MS = 10000; // 冻结后有界等待：让迟到的 main-lag 拍落盘再清障

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const out = { arm: null, round: 1, seconds: 240, wind: false, tag: '1a', taskbar: 'off' };
  for (const a of argv.slice(argv.indexOf('--accept-stall-duel') + 1)) {
    const m = /^--(arm|round|seconds|tag|taskbar)=(.+)$/.exec(a);
    if (m) out[m[1]] = m[2];
    if (a === '--wind') out.wind = true;
  }
  out.round = Number(out.round) || 1;
  out.seconds = Number(out.seconds) || 240;
  if (out.arm !== 'kb' && out.arm !== 'sys' && out.arm !== 'raw' && out.arm !== 'still' && out.arm !== 'bare') {
    throw new Error('--arm=kb|sys|raw|still|bare 必填（raw=去CDP裸负载，still=纯探针，bare=零接触终局对照）');
  }
  return out;
}

function readEvents(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

// 窗口标题（battery.js 同款 koffi 缓冲形态；win32.js 未导出）
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

/** 冻结主进程 minidump：线程栈 + 上下文入盘（MiniDumpNormal）。零外部依赖（koffi 直调
 * dbghelp），事后用 python minidump 库做模块归属——冻结点在哪个模块（win32u64/combase/
 * electron/node）一翻便知，黑盒推不动时的最后实证手段。尽力而为，失败不碍轮账。 */
const kernel32duel = win32.koffi.load('kernel32.dll');
const dbghelp = win32.koffi.load('dbghelp.dll');
const OpenProcess = kernel32duel.func('uintptr_t __stdcall OpenProcess(uint32 dwDesiredAccess, bool bInheritHandle, uint32 dwProcessId)');
const CreateFileW = kernel32duel.func('uintptr_t __stdcall CreateFileW(const char16_t* lpFileName, uint32 dwDesiredAccess, uint32 dwShareMode, void* lpSecurityAttributes, uint32 dwCreationDisposition, uint32 dwFlagsAndAttributes, uintptr_t hTemplateFile)');
const CloseHandle = kernel32duel.func('bool __stdcall CloseHandle(uintptr_t hObject)');
const MiniDumpWriteDump = dbghelp.func('bool __stdcall MiniDumpWriteDump(uintptr_t hProcess, uint32 ProcessId, uintptr_t hFile, uint32 DumpType, void* ExceptionParam, void* UserStreamParam, void* CallbackParam)');
function dumpFrozenMain(pid, outFile) {
  const hProc = Number(OpenProcess(0x0410, false, pid)); // QUERY_INFORMATION | VM_READ
  if (!hProc) throw new Error(`OpenProcess(${pid}) 失败`);
  const hFile = Number(CreateFileW(outFile, 0x40000000, 0, null, 2, 0x80, 0)); // GENERIC_WRITE, CREATE_ALWAYS, NORMAL
  try {
    if (!hFile || hFile === -1) throw new Error('CreateFileW 失败');
    const ok = MiniDumpWriteDump(hProc, pid, hFile, 0, null, null, null); // MiniDumpNormal：含线程栈与上下文
    if (!ok) throw new Error(`MiniDumpWriteDump 失败 gle=${kernel32duel.GetLastError?.() ?? '?'}`);
    return outFile;
  } finally {
    if (hFile && hFile !== -1) CloseHandle(hFile);
    CloseHandle(hProc);
  }
}

/** 面板活体探针（battery.panelLiveness 同款）：true=在泵消息 */
function panelAlive(hwnd) {
  try {
    const out = Buffer.alloc(16);
    return !!win32.SendMessageTimeoutW(Number(hwnd), 0, 0, 0, 0x0002, PROBE_TIMEOUT_MS, out);
  } catch { return false; }
}

/** CDP evaluate（taskbar.js cdpEval 同款：每次新连接，8s 超时） */
async function cdpEval(expression) {
  // fetch 必须有界：面板主进程冻结时 CDP HTTP 端点不再应答，无界 fetch 会把驱动循环
  // 挂死到轮末（r1-kb 实证）——观测者不能比被测物先死。
  const ac = new AbortController();
  const fetchTimer = setTimeout(() => ac.abort(), 3000);
  let targets;
  try {
    targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`, { signal: ac.signal })).json();
  } finally { clearTimeout(fetchTimer); }
  const target = targets.find((t) => t.title === 'AGENT DECK');
  if (!target) throw new Error('CDP 找不到面板页目标');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  try {
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP WebSocket 连接失败')); });
    const reply = await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('CDP evaluate 超时')), 8000);
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

async function main() {
  const args = parseArgs(process.argv);
  const startedAt = Date.now();
  const roundDir = path.join(__dirname, '..', 'evidence', 'stall-duel', args.tag, `r${args.round}-${args.arm}`);
  fs.mkdirSync(roundDir, { recursive: true });
  const eventsFile = path.join(roundDir, 'panel-events.jsonl');
  const spansFile = `${eventsFile}.spans.jsonl`;
  const harnessLog = path.join(roundDir, 'harness-log.jsonl');
  const hlog = [];
  const h = (ev) => { hlog.push({ t: Date.now(), ...ev }); };

  // —— taskbar 配置覆写（主电池 battery.js:775 同款纪律）：默认 off 对齐主电池跑法。
  // r1 轮实证：默认配置 taskbar.enabled=true（config.ts defaultTaskbar），任务栏链
  // （AppBar 注册/500ms 置顶 keepalive/1Hz 枚举/条带渲染层）在场与否是停摆实验的
  // 生死级变量——不控制它，任何臂间对照都被它污染。
  const configFile = path.join(APP_ROOT, 'config.json');
  let configBackup = null;
  if (fs.existsSync(configFile)) configBackup = fs.readFileSync(configFile, 'utf8');
  const cfgNow = (() => { try { return JSON.parse(configBackup ?? '{}'); } catch { return {}; } })();
  const cfgNext = { ...cfgNow, taskbar: { ...(cfgNow.taskbar ?? {}), enabled: args.taskbar === 'on' } };
  fs.writeFileSync(configFile, JSON.stringify(cfgNext, null, 2) + '\n');
  h({ type: 'config-override', taskbar: args.taskbar === 'on' });

  const si = (function screenInfo() {
    const d = screen.getPrimaryDisplay();
    return { factor: d.scaleFactor, phys: { w: Math.round(d.bounds.width * d.scaleFactor), h: Math.round(d.bounds.height * d.scaleFactor) } };
  })();
  h({ type: 'round-start', arm: args.arm, round: args.round, seconds: args.seconds, wind: args.wind, screen: si, bootUptimeS: Math.round(process.uptime()) });
  console.log(`[stall-duel] arm=${args.arm} round=${args.round} tag=${args.tag} seconds=${args.seconds} wind=${args.wind}`);

  // —— 参照记事本（真实普通窗；Win+D 期的对照与恢复对象）。bare 臂零接触：不拉。 ——
  let notepadHwnd = null, np = null;
  if (args.arm !== 'bare') {
    const before = new Set(win32.topLevelWindows().filter((wnd) => win32.className(wnd) === 'Notepad'));
    np = spawn('notepad.exe', [], { stdio: 'ignore' });
    for (let i = 0; i < 32 && !notepadHwnd; i++) {
      await sleep(250);
      notepadHwnd = win32.topLevelWindows().find((wnd) => win32.className(wnd) === 'Notepad' && !before.has(wnd)) || null;
    }
    if (!notepadHwnd) throw new Error('8s 内未出现记事本窗口');
    win32.SetWindowPos(notepadHwnd, 0, 1000, 200, 1400, 900, SWP_NOZORDER | win32.SWP_NOACTIVATE);
    h({ type: 'notepad-ready', hwnd: notepadHwnd });
  }

  // —— 面板（--panel-accept：CDP 通道必需，spec 入账的形态差异）——
  const child = spawn(process.execPath, ['.', '--panel-accept'], {
    cwd: APP_ROOT,
    // raw 臂不带 DECK_CDP_PORT：面板无 DevTools 端口，CDP 负载彻底归零
    env: { ...process.env, DECK_EVENT_LOG: eventsFile, DECK_LAG_SENTINEL: '1', ...(args.arm === 'raw' ? {} : { DECK_CDP_PORT: String(CDP_PORT) }) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderrTail = '';
  child.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-2000); });
  // stdout 必须排空（r3-bare minidump 实证：主线程终末冻结在 KERNELBASE 写路径的系统调用
  // 上——子进程 stdout 管道无人读、64KB 写满后同步 WriteFile 永久阻塞。电池 battery.js:812
  // 同款形态只读 stderr）。这里计数不落盘，只留量级入 harness 账。
  let stdoutBytes = 0;
  const stdoutSample = []; // 首个 64KB 采样：指认写入者（面板日志远达不到 6KB/s，IME/注入 DLL 嫌疑）
  child.stdout.on('data', (d) => {
    stdoutBytes += d.length;
    if (stdoutSample.length < 65536) stdoutSample.push(d);
  });
  let panelPid = null, panelHwnd = null;
  const launchDeadline = Date.now() + 25000;
  while (Date.now() < launchDeadline && !panelHwnd) {
    const boot = readEvents(eventsFile).filter((e) => e.type === 'boot').pop();
    if (boot) {
      panelPid = boot.pid;
      panelHwnd = win32.topLevelWindows().find((wnd) =>
        win32.threadIdOf(wnd).pid === panelPid && win32.className(wnd) === 'Chrome_WidgetWin_1'
        && windowTitle(wnd) === 'AGENT DECK') || null;
    }
    await sleep(200);
  }
  if (!panelHwnd) {
    h({ type: 'panel-launch-failed', stderrTail });
    console.error(`[stall-duel] 面板未就位\nstderr:\n${stderrTail}`);
    app.exit(3);
    return;
  }
  h({ type: 'panel-ready', pid: panelPid, hwnd: panelHwnd });
  // 渲染层就位门：热区已声明（第一份 hotzones 事件）再开跑
  const hotzoneDeadline = Date.now() + 20000;
  while (Date.now() < hotzoneDeadline && !readEvents(eventsFile).some((e) => e.type === 'hotzones')) await sleep(300);
  const panelRect = win32.rectOf(panelHwnd);
  h({ type: 'hotzones-seen', rect: panelRect });
  console.log(`[stall-duel] panel pid=${panelPid} hwnd=0x${panelHwnd.toString(16)} rect=${panelRect.left},${panelRect.top} ${panelRect.right - panelRect.left}x${panelRect.bottom - panelRect.top}`);

  // —— 观测与驱动的共享态 ——
  const probeSamples = [];
  const cdpEvalTimes = [];   // 全部 eval 发起时刻（B 臂的「有节奏活动」零假设触发点）
  const cdpErrors = [];
  let frozen = false;
  let driveOn = true;
  const deadline = Date.now() + args.seconds * 1000;

  // 探针：500ms 一拍（停摆拍自身阻塞 ≤2s，阻塞期间其他拍顺延——账目按发起时刻记，不虚增密度）
  // bare 臂零接触：不起探针循环（终局单次探活）
  const probeTimer = args.arm === 'bare' ? null : setInterval(() => {
    if (frozen && probeSamples.length && !probeSamples[probeSamples.length - 1].ok) {
      // 冻结后的探针只记有界几拍（wake window 内），不刷屏
      if (probeSamples.filter((s) => !s.ok).length > 400) return;
    }
    const t = Date.now();
    const ok = panelAlive(panelHwnd);
    probeSamples.push({ t, ok });
    if (!ok) h({ type: 'probe-timeout', t });
    const lastN = probeSamples.slice(-FROZEN_PROBES);
    if (!frozen && lastN.length === FROZEN_PROBES && lastN.every((s) => !s.ok)) {
      frozen = true;
      driveOn = false;
      h({ type: 'terminal-freeze-detected', t });
      console.log('[stall-duel] 终末冻结检出：停驱动，进入有界唤醒窗');
      try {
        dumpFrozenMain(panelPid, path.join(roundDir, 'freeze-main.dmp'));
        h({ type: 'freeze-dump-ok' });
      } catch (e) { h({ type: 'freeze-dump-failed', message: e.message }); }
      try {
        const ps = spawnSync('powershell', ['-NoProfile', '-Command', [
          `$ids=@(${panelPid}) + @((Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${panelPid} }).ProcessId)`,
          `$rows=@(); foreach($id in $ids){ $p=Get-Process -Id $id -ErrorAction SilentlyContinue; $n=(Get-CimInstance Win32_Process -Filter "ProcessId=$id").Name; $t=if($p){($p.Threads | ForEach-Object { "$($_.ThreadState)/$($_.WaitReason)" } | Group-Object | Sort-Object Count -Descending | Select-Object -First 3 | ForEach-Object { "$($_.Name)x$($_.Count)" }) -join ' '}else{'<已退出>'}; $rows += "$id $n cpu=$($p.CPU)s 线程=$t" }`,
          `$rows -join [Environment]::NewLine`,
        ].join(';')], { encoding: 'utf8', timeout: 20000, windowsHide: true });
        fs.writeFileSync(path.join(roundDir, 'freeze-forensics.txt'),
          `# 终末冻结线程态取证（t=${new Date(t).toISOString()} pid=${panelPid}）
` + (ps.stdout || ps.stderr || '').trim());
      } catch (e) { h({ type: 'freeze-forensics-failed', message: e.message }); }
    }
  }, PROBE_MS);

  // 鼠标路径：记事本中心 ⇄ 面板上缘内侧 40px，每拍 80px 步进往返（跨热区边界）
  const pathA = { x: 1200, y: 600 };
  const pathB = { x: panelRect.left + Math.round(240 * si.factor), y: panelRect.top + Math.round(40 * si.factor) };
  const mouseState = { x: pathA.x, y: pathA.y, dir: 1 };
  function mouseStep() {
    const target = mouseState.dir > 0 ? pathB : pathA;
    const dist = Math.hypot(target.x - mouseState.x, target.y - mouseState.y);
    if (dist < 90) mouseState.dir *= -1; // 距当前目标端近即翻转（两端都翻，单端翻转会钉死在另一端）
    const tdx = target.x - mouseState.x, tdy = target.y - mouseState.y;
    const td = Math.hypot(tdx, tdy) || 1;
    const step = Math.min(80, td);
    mouseState.x += Math.round((tdx / td) * step);
    mouseState.y += Math.round((tdy / td) * step);
    win32.moveMousePhys(mouseState.x, mouseState.y);
  }

  // 像素捕获（异步 spawn，不堵驱动拍；超时杀掉记 cdpErrors 同款错误账）
  let captureBusy = false;
  function captureTick() {
    if (captureBusy || !driveOn) return;
    captureBusy = true;
    const out = path.join(roundDir, 'capture-latest.png');
    const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(__dirname, '..', 'lib', 'capture.ps1'),
      '-Out', out, '-X', String(panelRect.left), '-Y', String(panelRect.top),
      '-W', String(panelRect.right - panelRect.left), '-H', String(panelRect.bottom - panelRect.top)]);
    const kill = setTimeout(() => { try { ps.kill(); } catch { /* 已退 */ } }, 15000);
    ps.on('exit', (code) => { clearTimeout(kill); captureBusy = false; h({ type: 'capture-exit', code }); });
    ps.on('error', (err) => { clearTimeout(kill); captureBusy = false; h({ type: 'capture-error', message: err.message }); });
  }

  // Win+D（phase-1b）：toggle 后恢复记事本（对照窗不被压死；面板由遮罩守望自理）
  async function windTick() {
    win32.send([
      win32.keyInput(VK_LWIN, win32.KEYDOWN), win32.keyInput(VK_D, win32.KEYDOWN),
      win32.keyInput(VK_D, win32.KEYUP), win32.keyInput(VK_LWIN, win32.KEYUP),
    ]);
    h({ type: 'wind-sent' });
    await sleep(2000);
    if (win32.IsIconic(notepadHwnd)) {
      win32.ShowWindow(notepadHwnd, SW_RESTORE);
      win32.SetWindowPos(notepadHwnd, 0, 1000, 200, 1400, 900, SWP_NOZORDER | win32.SWP_NOACTIVATE);
      h({ type: 'notepad-restored' });
    }
  }

  // —— 驱动主循环：各活动按各自到期时刻跑，错过即跳（不补拍不并行堆积）——
  const next = { mouse: Date.now(), kb: Date.now(), capture: Date.now(), wind: args.wind ? Date.now() + 5000 : Infinity };
  let kbOn = false;
  if (args.arm === 'bare') {
    await sleep(Math.max(1000, args.seconds * 1000));
    driveOn = false;
  }
  while (driveOn && Date.now() < deadline) {
    const now = Date.now();
    if (args.arm !== 'still' && now >= next.mouse) { next.mouse = now + MOUSE_STEP_MS; try { mouseStep(); } catch (e) { h({ type: 'mouse-error', message: e.message }); } }
    if (args.arm !== 'still' && now >= next.capture) { next.capture = now + CAPTURE_MS; captureTick(); }
    if (now >= next.wind) { next.wind = now + WIND_MS; await windTick(); }
    if (args.arm !== 'raw' && now >= next.kb) {
      next.kb = now + KB_CYCLE_MS;
      const t = Date.now();
      cdpEvalTimes.push(t);
      const expr = args.arm === 'kb'
        ? (kbOn
          ? `(() => { const i = document.getElementById('search-input'); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 'esc'; })()`
          : `(() => { document.getElementById('search-card').click(); return 'click'; })()`)
        : '1+1';
      if (args.arm === 'kb') kbOn = !kbOn;
      try {
        await cdpEval(expr);
        h({ type: 'cdp-eval-ok', t, exprKind: args.arm === 'kb' ? (kbOn ? 'off' : 'on') : 'noop' });
      } catch (e) {
        cdpErrors.push({ t, message: e.message });
        h({ type: 'cdp-eval-error', t, message: e.message });
      }
    }
    await sleep(50);
  }
  const activeMs = Math.min(Date.now(), deadline) - (deadline - args.seconds * 1000);
  h({ type: 'drive-end', activeMs, frozen, reason: frozen ? 'terminal-freeze' : 'deadline' });
  console.log(`[stall-duel] 驱动结束：${frozen ? '终末冻结' : '到时'}（active ${(activeMs / 1000).toFixed(1)}s）`);

  // 有界唤醒窗（冻结形态）：哨兵迟到的察觉拍只有冻结结束后才可能落盘——等它一手再清障
  if (frozen) await sleep(WAKE_WINDOW_MS);

  // —— 收尾：有界强退（restart-clear-required 时以退出码 3 报脏机器）——
  if (probeTimer) clearInterval(probeTimer);
  if (args.arm === 'bare') {
    // 终局单次探活：探针本身是否为诱因已由 still/raw 臂交叉覆盖，这里只定生死与冻结时刻
    const t = Date.now();
    const ok = panelAlive(panelHwnd);
    probeSamples.push({ t, ok });
    if (!ok) {
      frozen = true;
      h({ type: 'terminal-freeze-detected', t });
      try {
        dumpFrozenMain(panelPid, path.join(roundDir, 'freeze-main.dmp'));
        h({ type: 'freeze-dump-ok' });
      } catch (e) { h({ type: 'freeze-dump-failed', message: e.message }); }
    }
  }
  const panelControl = createPanelControl();
  const stopRes = await panelControl.stop({ pids: [child.pid, panelPid].filter(Boolean), child });
  h({ type: 'panel-stop', outcome: stopRes.outcome, pidsLeft: stopRes.pidsLeft, stdoutBytes });
  if (notepadHwnd) { try { win32.PostMessageW(notepadHwnd, 0x0010, 0, 0); } catch { /* 尽力 */ } }
  await sleep(800);
  if (np) { try { np.kill(); } catch { /* 已退 */ } }

  // 配置还原（尽力而为；失败入 harness 账不吞退出码）
  try {
    if (configBackup === null) { try { fs.unlinkSync(configFile); } catch { /* 本就无 */ } }
    else fs.writeFileSync(configFile, configBackup);
  } catch (e) { h({ type: 'config-restore-failed', message: e.message }); }

  // —— 轮账：事件侧 + harness 侧 → 分析器出 summary ——
  await sleep(600); // 事件文件尾拍落盘
  const events = readEvents(eventsFile);
  const mainLag = events.filter((e) => e.type === 'main-lag');
  const rendererStalls = events.filter((e) => e.type === 'renderer-stall');
  const kbTransitions = events.filter((e) => e.type === 'keyboard-mode-on' || e.type === 'keyboard-mode-off').map((e) => ({ t: e.t, kind: e.type }));
  const windSents = hlog.filter((e) => e.type === 'wind-sent').map((e) => e.t);
  const stalls = dedupeProbeStalls(probeSamples, { timeoutMs: PROBE_TIMEOUT_MS, mergeGapMs: 6000 });
  const stallOnsets = stalls.map((s) => s.onsetMs);
  const coupling = couplingStats(stallOnsets, args.arm === 'kb' ? kbTransitions.map((k) => k.t) : cdpEvalTimes);
  const windCoupling = couplingStats(stallOnsets, windSents, { windowMs: 2500 });
  const order = classifyOrder(stallOnsets, rendererStalls.map((r) => r.t - (r.quietMs || 0)));
  const labels = labelDistribution(mainLag);
  const terminalSpan = (function readTerminalSpans() {
    try {
      const lines = fs.readFileSync(spansFile, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const lastByPid = new Map();
      for (const l of lines) if (l.type === 'span-open') lastByPid.set(`${l.pid}:${l.label}`, l);
      const closedPids = new Set(lines.filter((l) => l.type === 'span-close').map((l) => `${l.pid}:${l.label}`));
      // 粗口径：文件里最后一个 span-open 若无同 pid+label 的后续 close 即终末在录签名
      const last = lines[lines.length - 1];
      if (last && last.type === 'span-open' && !lines.slice(lines.indexOf(last) + 1).some((l) => l.type === 'span-close' && l.pid === last.pid && l.label === last.label)) return last.label;
      return null;
    } catch { return null; }
  })();

  const summary = {
    arm: args.arm, round: args.round, tag: args.tag, wind: args.wind, taskbar: args.taskbar,
    startedAt, activeSeconds: Math.round(activeMs / 1000),
    panel: { pid: panelPid, stopOutcome: stopRes.outcome },
    probeCount: probeSamples.length,
    stalls: stalls.map((s) => ({ ...s, onsetIso: new Date(s.onsetMs).toISOString() })),
    mainLag: mainLag.map((e) => ({ t: e.t, lagMs: e.lagMs, liveLabels: e.liveLabels })),
    rendererStalls: rendererStalls.map((e) => ({ t: e.t, quietMs: e.quietMs, recovered: e.recovered })),
    kbTransitions, cdpEvalCount: cdpEvalTimes.length, cdpErrors,
    coupling, windCoupling, order, labels, terminalSpan,
    files: { eventsFile, spansFile, harnessLog, probesFile: path.join(roundDir, 'probes.jsonl') },
  };
  fs.writeFileSync(path.join(roundDir, 'probes.jsonl'), probeSamples.map((s2) => JSON.stringify(s2)).join('\n') + '\n');
  if (stdoutSample.length) fs.writeFileSync(path.join(roundDir, 'stdout-sample.txt'), Buffer.concat(stdoutSample));
  fs.writeFileSync(path.join(roundDir, 'summary.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(harnessLog, hlog.map((e) => JSON.stringify(e)).join('\n') + '\n');
  console.log(`[stall-duel] 轮账：停摆事件 ${stalls.length}（终末 ${stalls.filter((s) => s.terminal).length}）、main-lag ${mainLag.length}、renderer-stall ${rendererStalls.length}、kb 迁移沿 ${kbTransitions.length}、cdpErr ${cdpErrors.length}`);
  console.log(`[stall-duel] 耦合：${summary.coupling.withinWindow}/${summary.coupling.total} 在窗；labels=${JSON.stringify(labels.slice(0, 4))}；终末 span=${terminalSpan ?? '无'}`);
  app.exit(stopRes.gone ? 0 : 3);
}

process.on('unhandledRejection', (err) => {
  console.error('[stall-duel] 未处理拒绝：', err);
  app.exit(3);
});

// 控制器路由约定（battery.js 同款）：require(...)() 直接调起，返回启动 promise
module.exports = () => app.whenReady().then(main);
if (require.main === module) {
  module.exports().catch((err) => {
    console.error('[stall-duel] 轮失败：', err);
    app.exit(3);
  });
}
