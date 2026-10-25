'use strict';
/**
 * 工单249 真机取证探针：最大化收栏循环 × 唤出态 DOM 归零（F1）+ 唤出条几何存证帧再发（F2）。
 *
 * 定位：**取证探针**（app/accept/experiments/ 同款），**不是验收电池段**——49 电池的
 * 「唤出条新段」归工单243。本探针只为本票的真机验收出证据：跑一遍
 * 「最大化 → 悬停唤出某组 → 取消最大化 → 再最大化」，然后读两样东西：
 *   ① 条带页 DOM 上各组元素的 .summon-popped 残态（F1：收栏态栏面上不得有未唤出的组残留）；
 *   ② 事件档里 taskbar-summon-strips 帧数（F2：第二次进收栏态要**再发一帧**）。
 *
 * 用法（**必须经 accept-guard 托管**，禁裸跑——本机多检出共享同一验收槽）：
 *   node D:\test-folder\.accept-guard\guard.mjs hold --as mcode --purpose accept-sprint -- \
 *     node app\accept\experiments\t249-retract-cycle-probe.js
 *
 * 退出码：0 = 两条断言全过；1 = 有断言不成立（打印取证）；2 = 环境/时序问题（本轮未取到证据）。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const win32 = require('../lib/win32');
const { createEventTape } = require('../lib/event-tape');

/** CDP 端口（不与 manifest 登记的电池端口相撞：9223–9228 / 9333 已占） */
const CDP_PORT = 9229;
/** 事件档（面板经 DECK_EVENT_LOG 落）——落在临时目录，不进仓库证据面 */
const EVENTS_FILE = path.join(os.tmpdir(), 't249-retract-cycle-events.jsonl');
const TASKBAR_TITLE = 'DECK-TASKBAR';
/** 唤出组：取「右组」——它恒在场（应用组可能为空、无条）；组 → 条带页元素 id */
const GROUP = 'right';
const GROUP_ELEMENT_ID = { start: 'pill-start', recs: 'pill-recs', apps: 'pill-apps', right: 'right-pill', showdesk: 'show-desktop' };
/** Win32 ShowWindow 常量 */
const SW_MAXIMIZE = 3;
const SW_RESTORE = 9;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 结论账目（探针自己的报告面） */
const findings = [];
function say(s) { console.log(s); findings.push(s); }

/** 报告落盘（证据面：app/accept/evidence/ 下按证据档名分文件——与电池同款纪律） */
const REPORT_FILE = path.join(__dirname, '..', 'evidence', '249-t249-retract-cycle.txt');
function flushReport() {
  try {
    fs.writeFileSync(REPORT_FILE, [
      '工单249 真机取证探针（t249-retract-cycle-probe.js）——最大化收栏循环 × 唤出态归零',
      `运行时刻：${new Date().toISOString()}`,
      `事件档：${EVENTS_FILE}`,
      '',
      ...findings,
      '',
    ].join('\n'), 'utf8');
  } catch (e) {
    console.log(`（报告落盘失败：${e && e.message}）`);
  }
}

/* ---------------------------------------------------------------- 窗标题读数 */
const { koffi } = win32;
const user32 = koffi.load('user32.dll');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(uintptr_t hWnd, uint16 *buf, int nMax)');
function titleOf(hwnd) {
  const buf = Buffer.alloc(1024);
  const n = GetWindowTextW(hwnd, buf, 512);
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(buf.readUInt16LE(i * 2));
  return s;
}

/** 条带窗（按 pid + 标题 + 可见性甄别——拿错窗＝读到别的东西） */
function findTaskbarWindow(pid) {
  for (const h of win32.topLevelWindows()) {
    if (win32.threadIdOf(h).pid !== pid) continue;
    if (titleOf(h) !== TASKBAR_TITLE) continue;
    if (!win32.IsWindowVisible(h)) continue;
    return h;
  }
  return null;
}

/** CDP 求值（条带页 DECK-TASKBAR；与 49 电池的 cdpEval 同形） */
async function cdpEval(expression, pageTitle) {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
  const target = targets.find((t) => t.title === pageTitle);
  if (!target) throw new Error(`CDP 找不到页面目标 ${pageTitle}（现有：${targets.map((t) => t.title).join('|')}）`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  try {
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP WebSocket 连接失败')); });
    const reply = await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('CDP evaluate 超时')), 8000);
      ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id === 1) { clearTimeout(timer); res(m); } };
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
    if (reply.error || (reply.result && reply.result.exceptionDetails)) {
      throw new Error(`CDP evaluate 失败: ${JSON.stringify(reply.error || reply.result.exceptionDetails)}`);
    }
    return reply.result.result.value;
  } finally { ws.close(); }
}

/** 条带页上某组的唤出条矩形（客户区坐标） */
async function stripRect(group) {
  return cdpEval(`(() => {
    const el = document.querySelector('.tb-summon-strip[data-group="${group}"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()`, TASKBAR_TITLE);
}

/** 条带页上各组元素的 class 名 */
async function groupClasses() {
  const ids = Object.values(GROUP_ELEMENT_ID);
  const raw = await cdpEval(`JSON.stringify(${JSON.stringify(ids)}.map((id) => {
    const el = document.getElementById(id);
    return { id, cls: el ? el.className : null };
  }))`, TASKBAR_TITLE);
  return JSON.parse(raw);
}

/** 拉起探针窗（notepad）：新开一扇独立进程的窗——自家进程的窗会被 pid 排除挡掉 */
async function launchNotepad() {
  const before = new Set(win32.topLevelWindows().filter((h) => win32.className(h) === 'Notepad'));
  const child = spawn('notepad.exe', [], { stdio: 'ignore' });
  let hwnd = null;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && !hwnd) {
    await sleep(250);
    hwnd = win32.topLevelWindows().find((h) => win32.className(h) === 'Notepad' && !before.has(h)) || null;
  }
  return { child, hwnd };
}

async function main() {
  fs.writeFileSync(EVENTS_FILE, '');
  const tape = createEventTape(EVENTS_FILE, { defaultTimeoutMs: 8000 });

  // —— ① 拉起面板子进程（--panel-accept 绕单实例锁；CDP 端口与事件档经环境变量接线）——
  const electronPath = require('electron');
  const panel = spawn(electronPath, ['.', '--panel-accept'], {
    cwd: APP_ROOT,
    env: { ...process.env, DECK_EVENT_LOG: EVENTS_FILE, DECK_CDP_PORT: String(CDP_PORT) },
    stdio: 'ignore',
  });
  let notepad = null;
  const verdicts = [];

  try {
    const boot = await tape.wait('boot', null, { timeoutMs: 25000 });
    if (!boot) throw new Error('面板子进程未上报 boot');
    const ready = await tape.wait('taskbar-ready', null, { timeoutMs: 25000 });
    if (!ready) throw new Error('面板子进程未上报 taskbar-ready');
    const tbHwnd = findTaskbarWindow(boot.pid);
    if (!tbHwnd) throw new Error('未找到条带窗 DECK-TASKBAR');
    say(`面板 pid=${boot.pid} 条带窗 hwnd=${tbHwnd}`);

    // —— ② 拉起独立进程的真最大化窗（前台 + IsZoomed ⇒ 档位落 maximize-retract）——
    notepad = await launchNotepad();
    if (!notepad.hwnd) throw new Error('探针窗（notepad）未起来');
    win32.ShowWindow(notepad.hwnd, SW_MAXIMIZE);
    try { win32.SetForegroundWindow(notepad.hwnd); } catch { /* 前台由启动天然取得 */ }
    say(`探针窗 hwnd=${notepad.hwnd} 已最大化`);

    const t0 = Date.now();
    const retract1 = await tape.wait('taskbar-retract', null, { since: t0, timeoutMs: 15000 });
    if (!retract1) throw new Error('未观测到 taskbar-retract（前台真最大化窗未触发收栏——环境问题）');
    say(`① 进收栏态：taskbar-retract @${retract1.t}`);

    // —— ③ 悬停唤出某组（悬停 150ms 弹出）——
    const rect = await stripRect(GROUP);
    if (!rect) throw new Error(`条带页上找不到 ${GROUP} 组的唤出条`);
    const winRect = win32.rectOf(tbHwnd);
    const px = Math.round(winRect.left + rect.x + rect.w / 2);
    const py = Math.round(winRect.top + rect.y + rect.h / 2);
    win32.moveMousePhys(px, py);
    await sleep(700);
    const poppedCls = (await groupClasses()).find((g) => g.id === GROUP_ELEMENT_ID[GROUP]);
    say(`② 悬停 ${GROUP} 组唤出条 @(${px},${py})：${GROUP_ELEMENT_ID[GROUP]}.className="${poppedCls.cls}"`);
    if (!String(poppedCls.cls).includes('summon-popped')) {
      throw new Error(`悬停后 ${GROUP} 组未弹出（className="${poppedCls.cls}"）——本轮未取到唤出态证据`);
    }

    // 指针挪开（离开条带）：避免第二次进收栏态时该组被合法地重新唤出、把残态盖掉
    win32.moveMousePhys(20, 20);
    await sleep(600);

    // —— ④ 取消最大化（档位回 visible）——
    win32.ShowWindow(notepad.hwnd, SW_RESTORE);
    await sleep(1200);
    const lifted = await tape.wait('taskbar-retract-lifted', null, { since: t0, timeoutMs: 15000 });
    say(`③ 取消最大化：${lifted ? `taskbar-retract-lifted @${lifted.t}` : '（未见 retract-lifted 存证）'}`);

    // —— ⑤ 再最大化（档位回 maximize-retract）——
    const t1 = Date.now();
    win32.ShowWindow(notepad.hwnd, SW_MAXIMIZE);
    try { win32.SetForegroundWindow(notepad.hwnd); } catch { /* 同上 */ }
    const retract2 = await tape.wait('taskbar-retract', null, { since: t1, timeoutMs: 15000 });
    if (!retract2) throw new Error('未观测到第二次 taskbar-retract（再最大化未触发收栏）');
    await sleep(1200);
    say(`④ 再进收栏态：taskbar-retract @${retract2.t}`);

    // —— ⑥ 断言面 ——
    const classes = await groupClasses();
    const framesAll = tape.all('taskbar-summon-strips', null, { since: t0 });
    const framesSecond = tape.all('taskbar-summon-strips', null, { since: t1 });
    say(`⑤ 收栏态各组 class：${JSON.stringify(classes)}`);
    say(`⑥ taskbar-summon-strips 帧：全程 ${framesAll.length} 帧 / 第二轮 ${framesSecond.length} 帧`);

    // F1：收栏态栏面上不得有未唤出的组残留（可见但不在热区集内 = 看得见点不着）
    const residual = classes.filter((g) => String(g.cls).includes('summon-popped'));
    if (residual.length === 0) {
      verdicts.push('F1 ✅ 收栏态栏面无未唤出的组残留（.summon-popped 已归零）');
    } else {
      verdicts.push(`F1 ❌ 收栏态栏面有组残留：${JSON.stringify(residual)}（看得见、点不着）`);
    }

    // F2：第二次进收栏态要再发一帧（几何未变也照样发——档位切换不该被去重吞掉）
    if (framesSecond.length >= 1) {
      verdicts.push(`F2 ✅ 第二次进收栏态再发了 ${framesSecond.length} 帧 taskbar-summon-strips（等帧不得超时）`);
    } else {
      verdicts.push('F2 ❌ 第二次进收栏态未再发 taskbar-summon-strips 帧（被去重吞掉——验收等帧会超时）');
    }
  } catch (err) {
    say(`✗ 本轮未取到完整证据：${err && err.message ? err.message : String(err)}`);
    for (const v of verdicts) say(v);
    say('退出码 2（环境/时序问题——非产品判定）');
    flushReport();
    return 2;
  } finally {
    // 清场：探针窗 + 面板子进程 + 原生任务栏可见性（本仓电池同款纪律：不留断头的桌面）
    if (notepad && notepad.child) { try { notepad.child.kill(); } catch { /* 尽力 */ } }
    try { spawnSync('taskkill', ['/PID', String(panel.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 尽力 */ }
    try { win32.ensureNativeTaskbarVisible(); } catch { /* 尽力 */ }
  }

  for (const v of verdicts) say(v);
  const ok = verdicts.every((v) => v.includes('✅'));
  say(ok ? '退出码 0（F1/F2 全过）' : '退出码 1（有断言不成立）');
  flushReport();
  return ok ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }).catch((err) => {
  console.error('探针异常：', err);
  process.exitCode = 2;
});
