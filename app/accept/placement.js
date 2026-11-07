'use strict';
// 工单310 桌面组件摆位真机验收（spec #310，ADR-0024）：控制器以 --accept-placement 身份运行，
// 拉起 --panel-accept 面板子进程（绕开单实例锁，与常驻面板共存）。
//
// 一段绑定一工单（docs/agents/battery-governance.md）：P1–P6 归 310，P7 归 343。
//   ① 长按进入与取消（400ms / 6px / Esc / 失焦 / 点击抑制 / 点阵只铺可用区）
//   ② 20px 吸附、绿/红落点、冲突回弹、拖拽期全窗热区
//   ③ 手定位持久化（layout v2：docs 保留 + cards 格点）、重启回原位、恢复出厂双清
//   ④ 组卡默认位冻结、新建/解散不挪旧卡、展开保中心+夹取、邻卡淡出、展开卡仍可拖、热区重申报
//   ⑤ 搜索面板待机 420×100 占位、活动态优先向下/不足向上且留在可用区
//   ⑥ 小面板无空位拒绝并提示、手定位越界夹取进可用区
//   ⑦ 投放包真实摆位与热区集成（工单343）：两包激活互不重叠、对齐 20px 格线、落可用区
//      且不压卡片、点击经包宿主通道回执、激活事件带 bounds、禁用即出账本与视图移除
// 只断言真人可见/可查的外部事实（屏幕矩形、热区申报、磁盘落盘、重启后行为、提示文案），
// 不断言实现内部；P1–P6 摆位纯函数的数学正确性由本电池的几何断言兜底（工单310 用户裁决
// 例外，battery-governance.md 在案且仅限该票）；P7 落位逻辑按工单343 spec Testing
// Decisions 不另设单测——纯函数既有覆盖 + 真机 P7 端到端兜底。
//
// 运行：npm run accept:placement（= electron . --accept-placement）
// 装机纪律：只在临时 config/layout 备份上动手，轮末原样还原；桌面夹具一律 PLACE310- 前缀并清场。
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const win32 = require('./lib/win32');
const { Report } = require('./lib/report');
const { readConfigRaw, restoreConfig } = require('./lib/battery-config');
const { cdpPortFor } = require('./lib/registry');
const { createEventTape } = require('./lib/event-tape');
const { createPanelHandle } = require('./lib/panel-control');

const APP_ROOT = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(APP_ROOT, 'config.json');
const EVENTS_FILE = path.join(__dirname, 'evidence', '310-placement-events.jsonl');
const tape = createEventTape(EVENTS_FILE, { defaultTimeoutMs: 8000 });
const handle = createPanelHandle({
  execPath: process.execPath,
  appRoot: APP_ROOT,
  eventLogPath: EVENTS_FILE,
  archivePath: path.join(__dirname, 'evidence', '310-placement-panel-child.log'),
});
const CDP_PORT = cdpPortFor('310-placement');
const PANEL_TITLE = 'AGENT DECK';
const GRID = 20;
const MARGIN = 40;
const BAND = 64;
const SW_MINIMIZE = 6;
const VK_ESCAPE = 0x1b;
const FIXTURE_PREFIX = 'PLACE310-';

const koffi = win32.koffi;
const user32 = koffi.load('user32.dll');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(uintptr_t hWnd, uint16 *buf, int nMax)');

function titleOf(hwnd) {
  const buf = Buffer.alloc(512);
  const n = GetWindowTextW(hwnd, buf, 256);
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(buf.readUInt16LE(i * 2));
  return s;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(pred, timeoutMs, stepMs = 150) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() >= deadline) return null;
    await sleep(stepMs);
  }
}

// ---------------------------------------------------------------------------
// CDP（页内几何/状态就地取；物理坐标在电池侧换算）
// ---------------------------------------------------------------------------

async function cdpEval(expression, timeoutMs = 8000) {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
  const target = targets.find((t) => t.title === PANEL_TITLE);
  if (!target) throw new Error('CDP 找不到面板页目标');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  try {
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP WebSocket 连接失败')); });
    const reply = await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('CDP evaluate 超时')), timeoutMs);
      ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id === 1) { clearTimeout(timer); res(m); } };
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true } }));
    });
    if (reply.error || (reply.result && reply.result.exceptionDetails)) {
      throw new Error(`CDP evaluate 失败: ${JSON.stringify(reply.error || reply.result.exceptionDetails)}`);
    }
    return reply.result.result.value;
  } finally { ws.close(); }
}

const EXPR = {
  viewport: `({ w: window.innerWidth, h: window.innerHeight })`,
  cards: `(() => {
    const out = [];
    for (const el of document.querySelectorAll('.card')) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const faded = el.classList.contains('dgc-faded');
      if ((cs.display === 'none' || r.width < 1 || r.height < 1) && !faded) continue;
      out.push({ id: el.id || null, cardId: el.dataset.cardId || null,
        x: r.left, y: r.top, w: r.width, h: r.height,
        group: el.classList.contains('dgc-card'),
        expanded: el.classList.contains('dgc-expanded'),
        faded,
        search: el.dataset.placementSearch || null,
        rejected: el.classList.contains('placement-rejected') });
    }
    const dz = document.getElementById('doc-zone');
    if (dz) {
      const r = dz.getBoundingClientRect();
      const cs = getComputedStyle(dz);
      if (cs.display !== 'none' && r.width >= 1 && r.height >= 1) {
        out.push({ id: 'doc-zone', cardId: null, x: r.left, y: r.top, w: r.width, h: r.height,
          group: false, expanded: false, faded: false, search: null, rejected: false });
      }
    }
    return out;
  })()`,
  grid: `(() => { const g = document.getElementById('placement-grid'); const p = document.getElementById('placement-preview');
    const gr = g ? g.getBoundingClientRect() : null; const pr = p ? p.getBoundingClientRect() : null;
    return { gridOn: !!g && g.classList.contains('on'),
      grid: gr ? { x: gr.left, y: gr.top, w: gr.width, h: gr.height } : null,
      preview: p && getComputedStyle(p).display !== 'none' && pr ? { x: pr.left, y: pr.top, w: pr.width, h: pr.height,
        ok: p.classList.contains('ok'), bad: p.classList.contains('bad') } : null }; })()`,
  notice: `(() => { const n = document.getElementById('trash-notice');
    return n && getComputedStyle(n).display !== 'none' ? n.textContent : ''; })()`,
};

// ---------------------------------------------------------------------------
// 面板窗口与输入
// ---------------------------------------------------------------------------

function panelHwnd() {
  for (const h of win32.topLevelWindows()) {
    if (!win32.IsWindowVisible(h)) continue;
    const pid = win32.threadIdOf(h).pid;
    if (!pid || pid === process.pid) continue;
    if (titleOf(h) === PANEL_TITLE) return h;
  }
  return null;
}

let geo = { left: 0, top: 0, scale: 1, inner: { w: 2560, h: 1440 } };
let panelPid = 0;

async function refreshGeo() {
  const h = panelHwnd();
  if (!h) throw new Error('找不到面板窗口');
  panelPid = win32.threadIdOf(h).pid;
  const r = win32.rectOf(h);
  const vp = await cdpEval(EXPR.viewport);
  geo = { left: r.left, top: r.top, scale: (r.right - r.left) / vp.w, inner: vp };
  return h;
}

function toPhys(pt) {
  return { x: geo.left + Math.round(pt.x * geo.scale), y: geo.top + Math.round(pt.y * geo.scale) };
}

const SKIP_MINIMIZE = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'DV2ControlHost']);

/** 面板之上除桌面层外的覆盖窗逐个最小化（真机轮里用户窗随时可抬起，输入落点会被偷走） */
async function clearCovering() {
  const owner = panelPid;
  for (const h of win32.topLevelWindows()) {
    try {
      if (!win32.IsWindowVisible(h)) continue;
      const pid = win32.threadIdOf(h).pid;
      if (!pid || pid === process.pid || pid === owner) continue;
      const cls = win32.className(h);
      if (SKIP_MINIMIZE.has(cls)) continue;
      win32.ShowWindow(h, SW_MINIMIZE);
    } catch { /* 窗已销毁：尽力 */ }
  }
  await sleep(500);
}

/** 光标落点须由面板接住；被覆盖则先清场（有界 4 轮），仍不行返回 false 由段内如实判 */
async function ensureHit(cssPt) {
  const p = toPhys(cssPt);
  for (let i = 0; i < 4; i++) {
    win32.moveMousePhys(p.x, p.y);
    await sleep(220);
    const root = Number(win32.windowFromPointRoot(p));
    if (!root) return false;
    const pid = win32.threadIdOf(root).pid;
    if (pid === panelPid) return true;
    const cls = win32.className(root);
    if (SKIP_MINIMIZE.has(cls)) return false;
    try { win32.ShowWindow(root, SW_MINIMIZE); } catch { return false; }
    await sleep(450);
  }
  return false;
}

async function moveMouse(cssPt) {
  const p = toPhys(cssPt);
  win32.moveMousePhys(p.x, p.y);
  await sleep(60);
}

function centerOf(rect) {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

async function pointerDown(cssPt) {
  await ensureHit(cssPt);
  await moveMouse(cssPt);
  win32.send([win32.mouseInput(0, 0, win32.LEFTDOWN)]);
}

function pointerUp() {
  win32.send([win32.mouseInput(0, 0, win32.LEFTUP)]);
}

async function dragBy(cssPt, dx, dy, opts = {}) {
  const holdMs = opts.holdMs ?? 560;
  const steps = opts.steps ?? 10;
  const stepMs = opts.stepMs ?? 30;
  await pointerDown(cssPt);
  await sleep(holdMs);
  for (let i = 1; i <= steps; i++) {
    await moveMouse({ x: cssPt.x + (dx * i) / steps, y: cssPt.y + (dy * i) / steps });
    await sleep(stepMs);
  }
  await sleep(120);
  pointerUp();
}

async function clickCard(cssPt) {
  await ensureHit(cssPt);
  win32.clickPhys(toPhys(cssPt).x, toPhys(cssPt).y, 'left');
  await sleep(160);
}

/** 搜索活动态造内容：真输入链（input 事件）让结果/离线区出现，活动态高度才离开待机值 */
async function typeSearchProbe() {
  await cdpEval(`(() => { const i = document.getElementById('search-input');
    if (!i) return false; i.value = 'placement-probe'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
}

// ---------------------------------------------------------------------------
// 落盘与配置
// ---------------------------------------------------------------------------

const layoutFile = path.join(app.getPath('userData'), 'layout.json');

function readLayout() {
  try { return JSON.parse(fs.readFileSync(layoutFile, 'utf8')); } catch { return null; }
}

function writeLayout(store) {
  fs.mkdirSync(path.dirname(layoutFile), { recursive: true });
  fs.writeFileSync(layoutFile, JSON.stringify(store, null, 1) + '\n', 'utf8');
}

function patchConfig(mutator) {
  const raw = readConfigRaw();
  const cfg = raw ? JSON.parse(raw) : {};
  mutator(cfg);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

function userDesktop() {
  return app.getPath('desktop');
}

/** 投放包根解析（index.ts 同款口径，本文件夹具落盘与清场共用一处）：config.plugins.dir
 * 在册则其优先，userData/plugins 恒兜底；去重有序，首位 = 首选根。 */
function packageRoots() {
  const roots = [];
  try {
    const cfg = JSON.parse(readConfigRaw() || '{}');
    if (cfg.plugins && cfg.plugins.dir) roots.push(String(cfg.plugins.dir));
  } catch { /* 缺配置走默认根 */ }
  const fallback = path.join(app.getPath('userData'), 'plugins');
  if (!roots.includes(fallback)) roots.push(fallback);
  return roots;
}

/** P7 投放包清场（工单343）：包目录（配置根 + userData 根双查）与包私有配置一并移除，
 * 防崩溃轮残留的电池包在下一次面板启动时被激活上用户桌面。id 均为已登记 dsh-* 族。 */
function removeBatteryPackages(ids) {
  for (const id of ids) {
    for (const root of packageRoots()) {
      try { fs.rmSync(path.join(root, id), { recursive: true, force: true }); } catch { /* 尽力 */ }
    }
    try { fs.rmSync(path.join(app.getPath('userData'), 'plugin-config', `${id}.json`), { force: true }); } catch { /* 尽力 */ }
  }
}

const P7_PACKAGE_IDS = ['dsh-hello', 'dsh-net'];

function makeFixtures(names) {
  for (const name of names) fs.writeFileSync(path.join(userDesktop(), `${FIXTURE_PREFIX}${name}`), 'placement fixture\n', 'utf8');
}

function removeFixtures() {
  const dir = userDesktop();
  for (const f of fs.readdirSync(dir)) {
    if (!f.startsWith(FIXTURE_PREFIX)) continue;
    try { fs.unlinkSync(path.join(dir, f)); } catch { /* 尽力 */ }
  }
}

// ---------------------------------------------------------------------------
// 面板生命周期
// ---------------------------------------------------------------------------

async function launchPanel() {
  handle.launch({ mode: 'accept', cdpPort: CDP_PORT, stdio: 'ignore' });
  await waitReady(0);
}

async function waitReady(since, requireSessions = true) {
  const boot = await tape.wait('boot', null, { since, timeoutMs: 15000 });
  if (!boot) throw new Error('面板子进程未上报 boot 事件');
  panelPid = boot.pid;
  const rendered = await tape.wait('placement-rendered',
    (e) => (e.cards || []).some((c) => c.id === 'clock-card')
      && (!requireSessions || (e.cards || []).some((c) => c.id === 'sessions-card')),
    { since, timeoutMs: 15000 });
  if (!rendered) throw new Error('placement-rendered 未报出时钟/会话卡（摆位宿主未就位）');
  await refreshGeo();
  return rendered;
}

async function relaunchPanel(requireSessions = true) {
  await clearCovering();
  const t = Date.now();
  const r = await handle.relaunch({ sinceMs: t });
  if (!r.launched) throw new Error('面板重启失败');
  await waitReady(t, requireSessions);
  await sleep(800);
}

async function resetLayoutViaBridge() {
  const r = await cdpEval(`window.deck.bridge.invoke('desktop/reset-layout', null)`);
  await sleep(600);
  return r;
}

function segmentNote(rep, note) {
  if (note) rep.note(note);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const rep = new Report('310-placement');
  const configRaw = readConfigRaw();
  const layoutRaw = fs.existsSync(layoutFile) ? fs.readFileSync(layoutFile, 'utf8') : null;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    // 三态判决（不传 explicit）：段账目/排除账随证据文件落盘，estSeconds 才有 took= 佐证
    const v = rep.verdict();
    app.exit(v.exitCode);
  };

  try {
    fs.writeFileSync(EVENTS_FILE, '', 'utf8');
    removeFixtures();
    // 组卡插件须在装（P4/P5 的对照面）；其余插件维持本机现状
    patchConfig((cfg) => {
      cfg.plugins = cfg.plugins || {};
      cfg.plugins.disabled = (cfg.plugins.disabled || []).filter((id) => id !== 'doc-group-cards');
    });
    await launchPanel();
    await clearCovering();

    // ------------------ P1 长按进入与取消 ------------------
    rep.beginSegment('P1');
    segmentNote(rep, '长按宿主在时钟卡上落点；计时/阈值/取消/点击抑制均为真机输入注入');
    {
      await resetLayoutViaBridge();
      let clock = (await cdpEval(EXPR.cards)).find((c) => c.id === 'clock-card');
      if (!clock) throw new Error('P1 前置缺失：时钟卡不在场');
      const clockCenter = centerOf(clock);
      const clicksBefore = (tape.latest('clock-card-clicked') || {}).count || 0;

      // a. 短按（<400ms）不进入摆位，普通点击照常
      await pointerDown(clockCenter);
      await sleep(150);
      pointerUp();
      const clickAfter = await tape.wait('clock-card-clicked', (e) => e.count > clicksBefore, { since: Date.now() - 3000, timeoutMs: 2500 });
      const noMode = !tape.latest('placement-mode-entered', null, { since: Date.now() - 4000 });
      clickAfter && noMode
        ? rep.pass(`短按 <400ms 不进入摆位：clock-card-clicked count=${clickAfter.count}，无 placement-mode-entered`)
        : rep.fail(`短按语义不符：点击=${JSON.stringify(clickAfter && clickAfter.count)} 无模式事件=${noMode}`);
      await sleep(300);

      // b. 长按前位移 >6px：取消按压，不进入摆位
      const tMove = Date.now();
      await pointerDown(clockCenter);
      await sleep(120);
      await moveMouse({ x: clockCenter.x + 30, y: clockCenter.y });
      await sleep(200);
      pointerUp();
      await sleep(350);
      const movedMode = tape.latest('placement-mode-entered', null, { since: tMove });
      !movedMode
        ? rep.pass('长按前位移 >6px 取消按压：未进入摆位模式（普通手势不被误判）')
        : rep.fail('长按前位移未取消按压（误进入摆位模式）');
      await sleep(300);

      // c. 长按 400ms 成立：点阵网格只铺可用区；松手抑制点击
      const tLong = Date.now();
      await pointerDown(clockCenter);
      const entered = await tape.wait('placement-mode-entered', (e) => e.id === 'clock-card', { since: tLong, timeoutMs: 2500 });
      const grid = await cdpEval(EXPR.grid);
      const area = { x: MARGIN, y: MARGIN, w: geo.inner.w - 2 * MARGIN, h: geo.inner.h - 2 * MARGIN - BAND };
      const gridOk = grid.gridOn && grid.grid
        && Math.abs(grid.grid.x - area.x) <= 1 && Math.abs(grid.grid.y - area.y) <= 1
        && Math.abs(grid.grid.w - area.w) <= 1 && Math.abs(grid.grid.h - area.h) <= 1;
      entered && gridOk
        ? rep.pass(`长按成立即进入摆位：placement-mode-entered(${entered.id})，点阵网格 ${JSON.stringify(grid.grid)} = 可用区（四周 ${MARGIN}px、底边任务栏带 ${BAND}px 之外无点）`)
        : rep.fail(`长按进入异常：entered=${!!entered} grid=${JSON.stringify(grid)} 期望可用区=${JSON.stringify(area)}`);
      const clicksBeforeRelease = (tape.latest('clock-card-clicked') || {}).count || 0;
      pointerUp();
      const suppressed = await tape.wait('placement-click-suppressed', (e) => e.id === 'clock-card', { since: tLong, timeoutMs: 2500 });
      await sleep(500);
      const clicksAfterRelease = (tape.latest('clock-card-clicked') || {}).count || 0;
      suppressed && clicksAfterRelease === clicksBeforeRelease
        ? rep.pass(`长按成立后松手不触发卡片点击：placement-click-suppressed 在档、时钟点击计数停在 ${clicksAfterRelease}`)
        : rep.fail(`点击抑制异常：suppressed=${!!suppressed} 前=${clicksBeforeRelease} 后=${clicksAfterRelease}`);
      const gridClosed = (await cdpEval(EXPR.grid)).gridOn === false;
      gridClosed ? rep.pass('松手后点阵网格退场（平时不打扰壁纸）') : rep.fail('松手后网格仍在场');

      // d. Esc 取消：直接派发 DOM 键事件（面板不可聚焦，Esc 不会从系统键盘到达 window）
      const tEsc = Date.now();
      await pointerDown(clockCenter);
      await tape.wait('placement-mode-entered', (e) => e.id === 'clock-card', { since: tEsc, timeoutMs: 2500 });
      await cdpEval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
      const escCancel = await tape.wait('placement-cancelled', (e) => e.id === 'clock-card' && e.reason === 'esc', { since: tEsc, timeoutMs: 2500 });
      pointerUp();
      escCancel ? rep.pass('Esc 取消本次摆位（placement-cancelled reason=esc）') : rep.fail('Esc 未取消摆位');
      await sleep(400);

      // e. 失焦取消
      const tBlur = Date.now();
      await pointerDown(clockCenter);
      await tape.wait('placement-mode-entered', (e) => e.id === 'clock-card', { since: tBlur, timeoutMs: 2500 });
      await cdpEval(`window.dispatchEvent(new Event('blur')); true`);
      const blurCancel = await tape.wait('placement-cancelled', (e) => e.id === 'clock-card' && e.reason === 'blur', { since: tBlur, timeoutMs: 2500 });
      pointerUp();
      blurCancel ? rep.pass('窗口失焦取消本次摆位（placement-cancelled reason=blur）') : rep.fail('失焦未取消摆位');
      await sleep(300);
      const clockNow = (await cdpEval(EXPR.cards)).find((c) => c.id === 'clock-card');
      clockNow && clockNow.x === clock.x && clockNow.y === clock.y
        ? rep.pass(`取消后卡片回原位（${clockNow.x},${clockNow.y}）`)
        : rep.fail(`取消后位置未复原：${JSON.stringify(clockNow)}`);
    }

    // ------------------ P2 吸附与冲突 ------------------
    rep.beginSegment('P2');
    segmentNote(rep, '真鼠标长按拖拽：跟手 / 格点预览 / 冲突回弹 / 拖拽期全窗热区');
    {
      await resetLayoutViaBridge();
      let clock = (await cdpEval(EXPR.cards)).find((c) => c.id === 'clock-card');
      const sessions = (await cdpEval(EXPR.cards)).find((c) => c.id === 'sessions-card');
      if (!clock || !sessions) throw new Error('P2 前置缺失：时钟/会话卡不在场');
      const from = centerOf(clock);
      const tDrag = Date.now();
      await dragBy(from, 400, 0, { steps: 10 });
      const placed = await tape.wait('placement-placed', (e) => e.id === 'clock-card', { since: tDrag, timeoutMs: 4000 });
      await sleep(400); // 吸附动画 180ms + 落位重排
      const moved = (await cdpEval(EXPR.cards)).find((c) => c.id === 'clock-card');
      const aligned = moved && moved.x % GRID === 0 && moved.y % GRID === 0;
      placed && aligned && placed.rect && placed.rect.x % GRID === 0 && placed.rect.y % GRID === 0
        ? rep.pass(`松手吸附 20px 格点：placement-placed col=${placed.col} row=${placed.row} rect=(${placed.rect.x},${placed.rect.y})，DOM 同步对齐`)
        : rep.fail(`吸附异常：placed=${JSON.stringify(placed)} dom=${JSON.stringify(moved && { x: moved.x, y: moved.y })}`);

      // 拖拽期全窗热区
      const hz = tape.all('hotzones', (e) => (e.rects || []).some((r) => r.id === 'placement'), { since: tDrag })[0];
      const full = hz && (hz.rects || []).find((r) => r.id === 'placement');
      full && full.x === 0 && full.y === 0 && full.w === geo.inner.w && full.h === geo.inner.h
        ? rep.pass(`拖拽期热区保持全窗（placement ${full.w}×${full.h} @0,0）——指针流出卡片不转穿透`)
        : rep.fail(`拖拽全窗热区缺失：${JSON.stringify(full)}`);

      if (!placed || !placed.rect || !moved) {
        rep.note('吸附失败：冲突回弹与红色落点断言随同一前置一并跳过');
      } else {
      // 冲突：把时钟拖到会话卡上，预览变红、松手回弹、不落盘
      const layoutBefore = readLayout();
      const tConflict = Date.now();
      await dragBy(centerOf(moved), sessions.x + sessions.w / 2 - centerOf(moved).x, sessions.y + sessions.h / 2 - centerOf(moved).y, { steps: 10 });
      const rebound = await tape.wait('placement-rebound', (e) => e.id === 'clock-card', { since: tConflict, timeoutMs: 4000 });
      await sleep(450); // 回弹动画 180ms + 重排落定
      const after = (await cdpEval(EXPR.cards)).find((c) => c.id === 'clock-card');
      const layoutAfter = readLayout();
      const back = after && Math.abs(after.x - placed.rect.x) <= 1 && Math.abs(after.y - placed.rect.y) <= 1;
      const sameStore = JSON.stringify(layoutBefore) === JSON.stringify(layoutAfter);
      rebound && back && sameStore
        ? rep.pass(`冲突落点红框回弹：placement-rebound，卡片回 (${after.x},${after.y})，layout.json 未写`)
        : rep.fail(`冲突回弹异常：rebound=${!!rebound} back=${back} storeSame=${sameStore}`);

      // 负向：冲突期间预览为红（在拖拽途中取）
      const tPreview = Date.now();
      const target = centerOf(sessions);
      const start = centerOf(after);
      await pointerDown(start);
      await sleep(560);
      await moveMouse({ x: target.x, y: target.y - sessions.h / 2 + 40 });
      await sleep(250);
      const preview = (await cdpEval(EXPR.grid)).preview;
      const hzWaiting = await tape.wait('hotzones', (e) => (e.rects || []).some((r) => r.id === 'placement'), { since: tPreview, timeoutMs: 1500 });
      pointerUp();
      await sleep(500);
      preview && preview.bad && hzWaiting
        ? rep.pass('拖到已占位置：落点预览红色（.bad）且热区保持全窗')
        : rep.fail(`冲突预览异常：preview=${JSON.stringify(preview)}`);
      await sleep(300);
      }
    }

    // ------------------ P3 持久化与恢复出厂 ------------------
    rep.beginSegment('P3');
    segmentNote(rep, 'layout.json v2 形状 / 两张手定位重启回原位 / 恢复出厂双清');
    {
      // #314：至少两张卡的手定位都要跨重启——时钟已在 P2 落位，这里再拖天气到右移 400。
      const weather0 = (await cdpEval(EXPR.cards)).find((c) => c.id === 'weather-card');
      if (!weather0) throw new Error('P3 前置缺失：天气卡不在场');
      const tWeather = Date.now();
      await dragBy(centerOf(weather0), 400, 0, { steps: 8 });
      const placedWeather = await tape.wait('placement-placed', (e) => e.id === 'weather-card', { since: tWeather, timeoutMs: 4000 });
      await sleep(400);
      const store = readLayout();
      const placement = tape.latest('placement-rendered');
      const clockCard = placement && (placement.cards || []).find((c) => c.id === 'clock-card');
      const weatherCard = placement && (placement.cards || []).find((c) => c.id === 'weather-card');
      const v2 = store && store.version === 2 && Array.isArray(store.docs) && store.cards && typeof store.cards === 'object';
      const slotOk = v2 && clockCard && weatherCard && placedWeather
        && store.cards['clock-card'] && store.cards['weather-card']
        && store.cards['clock-card'].col === clockCard.base.col && store.cards['clock-card'].row === clockCard.base.row
        && store.cards['weather-card'].col === weatherCard.base.col && store.cards['weather-card'].row === weatherCard.base.row;
      v2 && slotOk
        ? rep.pass(`layout.json 升版 v2：docs 保留（${store.docs.length} 项）+ 两张手定位 cards.clock-card=${JSON.stringify(store.cards['clock-card'])}、cards.weather-card=${JSON.stringify(store.cards['weather-card'])}（与渲染格点互证）`)
        : rep.fail(`layout v2 形状不符：${JSON.stringify(store && { version: store.version, docs: store.docs, cards: store.cards })}`);

      const beforeCards = await (async () => { await sleep(500); return cdpEval(EXPR.cards); })();
      const beforeClock = beforeCards.find((c) => c.id === 'clock-card');
      const beforeWeather = beforeCards.find((c) => c.id === 'weather-card');
      const sinceRestart = Date.now();
      await relaunchPanel();
      const afterCards = await cdpEval(EXPR.cards);
      const afterClock = afterCards.find((c) => c.id === 'clock-card');
      const afterWeather = afterCards.find((c) => c.id === 'weather-card');
      const persisted = afterClock && beforeClock && afterWeather && beforeWeather
        && Math.abs(afterClock.x - beforeClock.x) <= 1 && Math.abs(afterClock.y - beforeClock.y) <= 1
        && Math.abs(afterWeather.x - beforeWeather.x) <= 1 && Math.abs(afterWeather.y - beforeWeather.y) <= 1;
      persisted
        ? rep.pass(`重启面板后两张手定位都保持：时钟 ${beforeClock.x},${beforeClock.y} → ${afterClock.x},${afterClock.y}；天气 ${beforeWeather.x},${beforeWeather.y} → ${afterWeather.x},${afterWeather.y}`)
        : rep.fail(`重启后手定位丢失：${JSON.stringify({ clock: afterClock && [afterClock.x, afterClock.y], weather: afterWeather && [afterWeather.x, afterWeather.y] })}`);
      const restartEvt = tape.latest('placement-rendered', null, { since: sinceRestart });
      restartEvt && rep.note(`重启后 placement-rendered 已复发（${restartEvt.cards.length} 张卡）`);

      const reset = await resetLayoutViaBridge();
      await sleep(700); // 恢复出厂回执后等一拍快照重排（清手定位 → 默认位）
      const storeAfter = readLayout();
      const afterReset = await cdpEval(EXPR.cards);
      const clockAfter = afterReset.find((c) => c.id === 'clock-card');
      const weatherAfter = afterReset.find((c) => c.id === 'weather-card');
      const clearedBoth = reset && reset.ok && storeAfter && storeAfter.version === 2
        && Object.keys(storeAfter.cards || {}).length === 0 && (storeAfter.docs || []).length === 0;
      const defaultBack = clockAfter && clockAfter.x === MARGIN && clockAfter.y === MARGIN
        && weatherAfter && weatherAfter.x === MARGIN && weatherAfter.y === 240;
      clearedBoth && defaultBack
        ? rep.pass(`恢复出厂同时清空手定位与文档名单（cleared=${reset.cleared}），时钟回 (${clockAfter.x},${clockAfter.y})、天气回 (${weatherAfter.x},${weatherAfter.y})`)
        : rep.fail(`恢复出厂异常：reset=${JSON.stringify(reset)} store=${JSON.stringify(storeAfter && { docs: storeAfter.docs, cards: storeAfter.cards })} clock=${JSON.stringify(clockAfter && { x: clockAfter.x, y: clockAfter.y })} weather=${JSON.stringify(weatherAfter && { x: weatherAfter.x, y: weatherAfter.y })}`);
    }

    // ------------------ P4 组卡冻结 / 原位展开 / 默认登记 ------------------
    rep.beginSegment('P4');
    segmentNote(rep, '桌面夹具造组卡；首次摆位冻结默认位；新建/解散不挪旧卡；展开保中心+夹取；展开卡仍可拖');
    {
      makeFixtures(['a.txt', 'b.txt', 'c.txt', 'd.pdf', 'e.pdf']);
      await sleep(1200);
      const groups = await until(async () => {
        const cards = (await cdpEval(EXPR.cards)).filter((c) => c.group && !c.expanded);
        return cards.length >= 2 ? cards : null;
      }, 15000, 300);
      if (!groups) throw new Error('P4 前置缺失：组卡未成排（桌面夹具已落盘）');
      const aligned = groups.every((c) => c.x % GRID === 0 && c.y % GRID === 0);
      aligned ? rep.pass(`组卡默认位按格点量化：${groups.length} 张卡四边对齐 20px 格线（${groups.map((c) => `${c.id}@${c.x},${c.y}`).join('；')}）`)
        : rep.fail(`组卡默认位未量化：${JSON.stringify(groups.map((c) => ({ id: c.id, x: c.x, y: c.y })))}`);

      // 首次成功摆位 → 冻结组卡默认位
      const clock = (await cdpEval(EXPR.cards)).find((c) => c.id === 'clock-card');
      const tFreeze = Date.now();
      await dragBy(centerOf(clock), 40, 20, { steps: 6 });
      const frozen = await tape.wait('placement-frozen', null, { since: tFreeze, timeoutMs: 4000 });
      await sleep(500); // 冻结事件与落位动画/重排落定后再取基准
      frozen && Array.isArray(frozen.ids) && frozen.ids.length >= groups.length
        ? rep.pass(`首次成功摆位即冻结组卡默认位（placement-frozen ids=${frozen.ids.join(', ')}）`)
        : rep.fail(`组卡冻结未发生：${JSON.stringify(frozen)}`);

      const slotsBefore = new Map();
      for (const c of await cdpEval(EXPR.cards)) if (c.group) slotsBefore.set(c.cardId || c.id, { x: c.x, y: c.y });
      makeFixtures(['new.zip']);
      await sleep(1200);
      const zip = await until(async () => (await cdpEval(EXPR.cards)).find((c) => c.group && c.id === 'dgc-zip'), 12000, 300);
      const afterAdd = (await cdpEval(EXPR.cards)).filter((c) => c.group && c.id !== 'dgc-zip');
      const unmoved = afterAdd.every((c) => {
        const s = slotsBefore.get(c.cardId || c.id);
        return s && Math.abs(c.x - s.x) <= 1 && Math.abs(c.y - s.y) <= 1;
      });
      const zipAligned = zip && zip.x % GRID === 0 && zip.y % GRID === 0;
      const overlaps = zip && afterAdd.some((c) => zip.x < c.x + c.w && c.x < zip.x + zip.w && zip.y < c.y + c.h && c.y < zip.y + zip.h);
      zip && unmoved && zipAligned && !overlaps
        ? rep.pass(`冻结后新增组卡落最近空位（${zip.id}@${zip.x},${zip.y}，格点对齐且不压旧卡），旧卡一张未挪`)
        : rep.fail(`新增组卡异常：zip=${JSON.stringify(zip && { id: zip.id, x: zip.x, y: zip.y })} 旧卡不动=${unmoved} 对齐=${zipAligned} 重叠=${overlaps}`);

      try { fs.unlinkSync(path.join(userDesktop(), `${FIXTURE_PREFIX}new.zip`)); } catch { /* 尽力 */ }
      await sleep(1200);
      const goneZip = await until(async () => !(await cdpEval(EXPR.cards)).some((c) => c.id === 'dgc-zip'), 8000, 300);
      const afterRemove = (await cdpEval(EXPR.cards)).filter((c) => c.group);
      const stillUnmoved = afterRemove.every((c) => {
        const s = slotsBefore.get(c.cardId || c.id);
        return s && Math.abs(c.x - s.x) <= 1 && Math.abs(c.y - s.y) <= 1;
      });
      goneZip && stillUnmoved
        ? rep.pass('解散一张组卡后其余卡原地不动（冻结语义）')
        : rep.fail(`解散后旧卡挪位：gone=${!!goneZip} unmoved=${stillUnmoved}`);

      // 展开：保中心放大 + 越界夹取 + 邻卡淡出 + 热区重申报
      const target = (await cdpEval(EXPR.cards)).find((c) => c.group && c.id === 'dgc-txt');
      if (!target) throw new Error('P4 展开前置缺失：dgc-txt 不在场');
      const base = { x: target.x + target.w / 2, y: target.y + target.h / 2 };
      const tExpand = Date.now();
      await clickCard({ x: target.x + 8, y: target.y + target.h / 2 });
      const expanded = await until(async () => (await cdpEval(EXPR.cards)).find((c) => c.id === 'dgc-txt' && c.expanded), 5000, 120);
      const others = (await cdpEval(EXPR.cards)).filter((c) => c.group && c.id !== 'dgc-txt');
      const centerKeep = expanded && Math.abs((expanded.x + expanded.w / 2) - base.x) <= 1 && Math.abs((expanded.y + expanded.h / 2) - base.y) <= 1;
      const clampOk = expanded && expanded.x >= MARGIN && expanded.y >= MARGIN
        && expanded.x + expanded.w <= geo.inner.w - MARGIN && expanded.y + expanded.h <= geo.inner.h - MARGIN - BAND;
      const faded = others.length > 0 && others.every((c) => c.faded);
      const hzExp = tape.latest('hotzones', null, { since: tExpand });
      const hzRect = hzExp && (hzExp.rects || []).find((r) => r.id === 'dgc-txt');
      const hzOk = hzRect && expanded && Math.abs(hzRect.x - expanded.x) <= 1.5 && Math.abs(hzRect.y - expanded.y) <= 1.5
        && Math.abs(hzRect.w - expanded.w) <= 1.5 && Math.abs(hzRect.h - expanded.h) <= 1.5;
      expanded && centerKeep && clampOk && faded
        ? rep.pass(`展开为临时模态：640×980 保中心（偏差 ${Math.abs((expanded.x + expanded.w / 2) - base.x).toFixed(1)}px）且夹取进可用区，${others.length} 张邻卡淡出`)
        : rep.fail(`展开异常：expanded=${JSON.stringify(expanded && { x: expanded.x, y: expanded.y, w: expanded.w, h: expanded.h })} center=${centerKeep} clamp=${clampOk} faded=${faded}`);
      hzOk
        ? rep.pass(`展开后热区即时重申报：dgc-txt 热区 = DOM 矩形（${JSON.stringify(hzRect)}）`)
        : rep.fail(`展开后热区未跟上：hz=${JSON.stringify(hzRect)} dom=${JSON.stringify(expanded && { x: expanded.x, y: expanded.y, w: expanded.w, h: expanded.h })}`);

      // 展开卡仍可长按拖动（基准格点位移；展开态不写存储位置，写的是折叠基准位）
      const tDragExpanded = Date.now();
      await dragBy({ x: expanded.x + 12, y: expanded.y + expanded.h / 2 }, 40, 40, { steps: 8 });
      const placedExpanded = await tape.wait('placement-placed', (e) => e.id === 'doc-group-cards:dgc-txt', { since: tDragExpanded, timeoutMs: 4000 });
      await sleep(400); // 落位重排后再量展开卡的新位置
      const stillExpanded = (await cdpEval(EXPR.cards)).find((c) => c.id === 'dgc-txt');
      placedExpanded && stillExpanded && stillExpanded.expanded
        ? rep.pass(`展开卡仍可长按拖动：placement-placed 基准格点 col=${placedExpanded.col} row=${placedExpanded.row}，拖后仍在展开态`)
        : rep.fail(`展开卡拖动失败：placed=${JSON.stringify(placedExpanded)} expanded=${!!(stillExpanded && stillExpanded.expanded)}`);

      // 收起：回折叠尺寸与原（新）基准格点
      await clickCard({ x: stillExpanded.x + 8, y: stillExpanded.y + stillExpanded.h / 2 });
      const collapsed = await until(async () => (await cdpEval(EXPR.cards)).find((c) => c.id === 'dgc-txt' && !c.expanded), 5000, 120);
      collapsed && collapsed.w === 320 && collapsed.h === 240
        ? rep.pass(`收起回折叠尺寸 320×240（落在拖动后的基准格点 ${collapsed.x},${collapsed.y}）`)
        : rep.fail(`收起异常：${JSON.stringify(collapsed && { x: collapsed.x, y: collapsed.y, w: collapsed.w, h: collapsed.h })}`);
      removeFixtures();
      await sleep(900);
    }

    // ------------------ P5 搜索活动态方向 ------------------
    rep.beginSegment('P5');
    segmentNote(rep, '搜索待机 420×100；活动态优先向下、下方不足向上；退待机收高');
    {
      await resetLayoutViaBridge();
      let search = (await cdpEval(EXPR.cards)).find((c) => c.id === 'search-card');
      if (!search) throw new Error('P5 前置缺失：搜索卡不在场');
      const idleOk = search.w === 420 && search.h === 100 && search.y % GRID === 0;
      idleOk ? rep.pass(`搜索待机按 420×100 占位（实得 ${search.w}×${search.h} @${search.x},${search.y}）`)
        : rep.fail(`搜索待机尺寸异常：${JSON.stringify(search)}`);

      const tDown = Date.now();
      await clickCard(centerOf(search));
      const activatedDown = await tape.wait('search-activated', null, { since: tDown, timeoutMs: 3000 });
      await typeSearchProbe();
      const down = await tape.wait('placement-search-expanded', (e) => e.id === 'search-card' && e.direction === 'down' && e.rect && e.rect.h > 100, { since: tDown, timeoutMs: 6000 });
      const activeDown = (await cdpEval(EXPR.cards)).find((c) => c.id === 'search-card');
      const inside = activeDown && activeDown.y >= MARGIN && activeDown.y + activeDown.h <= geo.inner.h - MARGIN - BAND;
      activatedDown && down && inside
        ? rep.pass(`活动态优先向下展开：direction=down，内容高 ${activeDown.h}，卡底 ${Math.round(activeDown.y + activeDown.h)} 留在可用区内`)
        : rep.fail(`向下展开异常：activated=${!!activatedDown} down=${JSON.stringify(down)} rect=${JSON.stringify(activeDown && { y: activeDown.y, h: activeDown.h })}`);
      // #317：活动态不启动长按摆位（输入时误触不拖卡）
      const tBlock = Date.now();
      await pointerDown(centerOf(activeDown));
      await sleep(560);
      pointerUp();
      await sleep(300);
      const activeBlocked = !tape.latest('placement-mode-entered', null, { since: tBlock });
      const stillActive = (await cdpEval(EXPR.cards)).find((c) => c.id === 'search-card');
      activeBlocked && stillActive && stillActive.search === 'active'
        ? rep.pass('搜索活动态长按不触发摆位：560ms 按压后无 placement-mode-entered，面板仍在活动态')
        : rep.fail(`活动态长按未拦住：blocked=${activeBlocked} state=${JSON.stringify(stillActive && stillActive.search)}`);
      // 退待机（DOM 键事件走输入框自己的 keydown）
      await cdpEval(`document.getElementById('search-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
      const deactivated = await tape.wait('search-deactivated', null, { since: tDown, timeoutMs: 3000 });
      await sleep(700);
      const idleAgain = (await cdpEval(EXPR.cards)).find((c) => c.id === 'search-card');
      deactivated && idleAgain && idleAgain.h === 100
        ? rep.pass(`ESC 退待机后高度收回 100（热区同步重申报）`)
        : rep.fail(`退待机未收高：deactivated=${!!deactivated} rect=${JSON.stringify(idleAgain && { y: idleAgain.y, h: idleAgain.h })}`);

      // 拖到下半屏：活动态下方空间不足 → 向上展开
      const tLow = Date.now();
      search = (await cdpEval(EXPR.cards)).find((c) => c.id === 'search-card');
      await dragBy(centerOf(search), 0, 1270 - centerOf(search).y, { steps: 12 });
      const placedLow = await tape.wait('placement-placed', (e) => e.id === 'search-card', { since: tLow, timeoutMs: 4000 });
      await sleep(400);
      search = (await cdpEval(EXPR.cards)).find((c) => c.id === 'search-card');
      const tUp = Date.now();
      await clickCard(centerOf(search));
      const activatedUp = await tape.wait('search-activated', null, { since: tUp, timeoutMs: 3000 });
      await typeSearchProbe();
      const up = await tape.wait('placement-search-expanded', (e) => e.id === 'search-card' && e.direction === 'up', { since: tUp, timeoutMs: 6000 });
      const activeUp = (await cdpEval(EXPR.cards)).find((c) => c.id === 'search-card');
      const staysInside = activeUp && activeUp.y >= MARGIN && activeUp.y + activeUp.h <= geo.inner.h - MARGIN - BAND;
      placedLow && activatedUp && up && staysInside
        ? rep.pass(`拖到下半屏后活动态向上展开：direction=up，rect=(${Math.round(activeUp.x)},${Math.round(activeUp.y)},${Math.round(activeUp.w)},${Math.round(activeUp.h)}) 始终留在屏内`)
        : rep.fail(`向上展开异常：placed=${JSON.stringify(placedLow)} activated=${!!activatedUp} up=${JSON.stringify(up)} rect=${JSON.stringify(activeUp && { y: activeUp.y, h: activeUp.h })}`);
      await cdpEval(`document.getElementById('search-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
      await sleep(700);
    }

    // ------------------ P6 无空位拒绝与尺寸夹取 ------------------
    rep.beginSegment('P6');
    segmentNote(rep, '小面板 700×520：容不下的卡被拒并提示（#trash-notice 文案）；手定位越界夹取');
    {
      // 手定位写一个越界格点，小面板重启后应夹取到右上角
      writeLayout({ version: 2, docs: [], cards: { 'clock-card': { col: 100, row: 60 } } });
      patchConfig((cfg) => { cfg.panel = { x: 0, y: 0, width: 700, height: 520 }; });
      await relaunchPanel(false);
      const vp = await cdpEval(EXPR.viewport);
      const area = { x: MARGIN, y: MARGIN, w: vp.w - 2 * MARGIN, h: vp.h - 2 * MARGIN - BAND };
      const clock = (await cdpEval(EXPR.cards)).find((c) => c.id === 'clock-card');
      const maxCol = Math.floor((area.w - 320) / GRID);
      const maxRow = Math.floor((area.h - 180) / GRID);
      const clampedOk = clock && clock.x === area.x + maxCol * GRID && clock.y === area.y + maxRow * GRID;
      clampedOk
        ? rep.pass(`面板缩到 ${vp.w}×${vp.h} 后手定位夹取进可用区：时钟卡落在 max 格点 col=${maxCol} row=${maxRow}（${clock.x},${clock.y}）`)
        : rep.fail(`手定位夹取异常：clock=${JSON.stringify(clock && { x: clock.x, y: clock.y })} 期望=${area.x + maxCol * GRID},${area.y + maxRow * GRID}`);

      const rejected = await until(() => tape.latest('placement-rejected', (e) => e.id === 'sessions-card' && e.reason === 'no-space'), 6000, 200);
      const notice = await cdpEval(EXPR.notice);
      rejected && notice.includes('放不下')
        ? rep.pass(`无空位拒绝并提示：placement-rejected(sessions-card, no-space) 在档，可见提示「${notice.slice(0, 40)}」`)
        : rep.fail(`无空位拒绝异常：rejected=${JSON.stringify(rejected)} notice=${JSON.stringify(notice)}`);
      const sessionCard = (await cdpEval(EXPR.cards)).find((c) => c.id === 'sessions-card');
      !sessionCard
        ? rep.pass('被拒的会话卡不占屏不占地（不是静默叠卡，也不会把已摆好的卡自动搬走）')
        : rep.fail(`被拒卡仍在屏上占位：${JSON.stringify(sessionCard)}`);

      // 极端小面板（300×300，可用区 220×156）：两张手定位都大于可用区、夹取后同点相撞，
      // 无任何空位 → 停靠首个可用位 (0,0) 并落 placement-overlap-accepted 诊断（#318：
      // 不静默重叠；已有卡不被自动搬走，只有被夹到同一处的这一对如实告警）。
      writeLayout({ version: 2, docs: [], cards: {
        'clock-card': { col: 100, row: 60 },
        'weather-card': { col: 101, row: 61 },
      } });
      patchConfig((cfg) => { cfg.panel = { x: 0, y: 0, width: 300, height: 300 }; });
      const tTiny = Date.now();
      await relaunchPanel(false);
      const dockedEvt = await tape.wait('placement-overlap-accepted',
        (e) => e.id === 'weather-card' && e.reason === 'no-space', { since: tTiny, timeoutMs: 8000 });
      const tinyCards = await cdpEval(EXPR.cards);
      const tinyClock = tinyCards.find((c) => c.id === 'clock-card');
      const tinyWeather = tinyCards.find((c) => c.id === 'weather-card');
      const docked = tinyClock && tinyWeather
        && tinyClock.x === MARGIN && tinyClock.y === MARGIN
        && tinyWeather.x === MARGIN && tinyWeather.y === MARGIN;
      dockedEvt && docked
        ? rep.pass(`面板缩到 300×300 且两张手定位都大于可用区：夹取后相撞、无空位 → 停靠首个可用位 (${MARGIN},${MARGIN}) 并落 placement-overlap-accepted 诊断（不静默重叠）`)
        : rep.fail(`无空位停靠异常：event=${JSON.stringify(dockedEvt)} clock=${JSON.stringify(tinyClock && { x: tinyClock.x, y: tinyClock.y })} weather=${JSON.stringify(tinyWeather && { x: tinyWeather.x, y: tinyWeather.y })}`);

      // #317 文档区：停用组卡后文档区可见、可拖；手定位在组卡启停间保留。
      // 再灌入一批 docx 让文档区内容变高，验证内容增长只接受相交、不把文档区/别卡自动推开。
      writeLayout({ version: 2, docs: [], cards: {} });
      patchConfig((cfg) => {
        cfg.panel = { x: 0, y: 0, width: 2560, height: 1440 };
        cfg.plugins.disabled = [...new Set([...(cfg.plugins.disabled || []), 'doc-group-cards'])];
      });
      await relaunchPanel(false);
      const doc0 = await until(async () => (await cdpEval(EXPR.cards)).find((c) => c.id === 'doc-zone'), 8000, 200);
      if (!doc0) throw new Error('P6 文档区前置缺失：停用组卡后 doc-zone 不在场');
      // 起笔压在 DOCS 标签带（分区 DOM 面，非条目）：长按归属文档区，不落进条目点击
      const docGrab = { x: doc0.x + 8, y: doc0.y + 4 };
      const tDoc = Date.now();
      await dragBy(docGrab, 300, 200, { steps: 10 });
      const docPlaced = await tape.wait('placement-placed', (e) => e.id === 'doc-zone', { since: tDoc, timeoutMs: 4000 });
      await sleep(400);
      const docMoved = (await cdpEval(EXPR.cards)).find((c) => c.id === 'doc-zone');
      const docSlot = readLayout() && readLayout().cards && readLayout().cards['doc-zone'];
      docPlaced && docMoved && docSlot
        ? rep.pass(`文档区可拖并落盘：doc-zone 拖到 (${docMoved.x},${docMoved.y})，layout cards.doc-zone=${JSON.stringify(docSlot)}`)
        : rep.fail(`文档区拖动异常：placed=${JSON.stringify(docPlaced)} rect=${JSON.stringify(docMoved && { x: docMoved.x, y: docMoved.y })} slot=${JSON.stringify(docSlot)}`);
      const heightBefore = docMoved ? docMoved.h : 0;
      makeFixtures(Array.from({ length: 40 }, (_, i) => `grow-${String(i).padStart(2, '0')}.docx`));
      const grown = await until(async () => {
        const d = (await cdpEval(EXPR.cards)).find((c) => c.id === 'doc-zone');
        return d && d.h > heightBefore + 20 ? d : null;
      }, 10000, 300);
      const growthKept = grown && docMoved && grown.x === docMoved.x && grown.y === docMoved.y;
      growthKept
        ? rep.pass(`文档区内容增长（高 ${Math.round(heightBefore)}→${Math.round(grown.h)}）不自动位移：仍在 (${grown.x},${grown.y})，相交只接受`)
        : rep.fail(`文档区内容增长被自动推开：before=${JSON.stringify(docMoved && { x: docMoved.x, y: docMoved.y, h: heightBefore })} after=${JSON.stringify(grown && { x: grown.x, y: grown.y, h: grown.h })}`);
      removeFixtures();
      await sleep(800);
      // 组卡在装时文档区隐藏且不占位；再停用后回到手定位（条目保留语义）
      patchConfig((cfg) => {
        cfg.plugins.disabled = (cfg.plugins.disabled || []).filter((id) => id !== 'doc-group-cards');
      });
      await relaunchPanel(false);
      const hiddenWhileGroup = await until(async () => !(await cdpEval(EXPR.cards)).some((c) => c.id === 'doc-zone'), 10000, 250);
      patchConfig((cfg) => {
        cfg.plugins.disabled = [...new Set([...(cfg.plugins.disabled || []), 'doc-group-cards'])];
      });
      await relaunchPanel(false);
      const docBack = await until(async () => (await cdpEval(EXPR.cards)).find((c) => c.id === 'doc-zone'), 8000, 200);
      const backOk = hiddenWhileGroup && docBack && docMoved && docBack.x === docMoved.x && docBack.y === docMoved.y;
      backOk
        ? rep.pass(`组卡在装时文档区隐藏且不占位；再停用后回到停用前手定位 (${docBack.x},${docBack.y})`)
        : rep.fail(`文档区启停保留异常：hidden=${hiddenWhileGroup} back=${JSON.stringify(docBack && { x: docBack.x, y: docBack.y })} expect=${JSON.stringify(docMoved && { x: docMoved.x, y: docMoved.y })}`);

      // 还原：配置与版面回原样，面板重启一次收干净
      writeLayout(layoutRaw ? JSON.parse(layoutRaw) : { version: 2, docs: [], cards: {} });
      restoreConfig(configRaw);
      await relaunchPanel(false);
      const restored = (await cdpEval(EXPR.cards)).find((c) => c.id === 'clock-card');
      restored && restored.x % GRID === 0 && restored.y % GRID === 0
        ? rep.pass(`还原本机配置与版面后面板正常起落（时钟卡 ${restored.x},${restored.y}）`)
        : rep.fail(`还原后状态异常：${JSON.stringify(restored)}`);
    }

    // ------------------ P7 投放包真实摆位与热区集成（工单343） ------------------
    rep.beginSegment('P7');
    segmentNote(rep, '两包零权限投放进格点账本：激活事件带 bounds、矩形互不重叠/对齐 20px 格线/'
      + '落可用区/不压卡片、点击经包宿主通道回执（热区命中集并入的端到端证明）、禁用即出账本与视图移除、重启用回账本重落位');
    {
      const [PKG_A, PKG_B] = P7_PACKAGE_IDS;
      const bridgeInvoke = (method, payload) => cdpEval(
        `window.deck.bridge.invoke(${JSON.stringify(method)}, ${JSON.stringify(payload ?? {})})`);
      const pkgTargets = async () => (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json())
        .filter((x) => typeof x.url === 'string' && x.url.startsWith('deck-pkg://'));
      // 包根与面板同源（index.ts 解析口径：config.plugins.dir || userData/plugins）
      const [pkgRoot] = packageRoots();
      const writeDropped = (id) => {
        fs.mkdirSync(path.join(pkgRoot, id), { recursive: true });
        fs.writeFileSync(path.join(pkgRoot, id, 'plugin.json'), JSON.stringify({
          id, name: `摆位样例 ${id}`, version: '1.0.0', entry: './card.js', hostApiVersion: 1,
        }), 'utf8');
        // 点击回执 fixture：整面按钮（position:fixed 铺满包视图视口——root 是 auto 高容器，
        // 百分比高会塌成内容高，视图中心的点击会落在按钮外），点击计数经 host.config 上行
        //（包→宿主回执走 pkg:config-set）
        fs.writeFileSync(path.join(pkgRoot, id, 'card.js'), [
          'export default {',
          '  async mount(host) {',
          '    const env = await host.config.get();',
          '    let clicks = ((env && env.config && env.config.clicks) || 0) + 1;',
          '    await host.config.set({ clicks });',
          '    host.el.innerHTML = \'<button id="pkg-click-btn" style="position:fixed;inset:0;width:100%;height:100%;font-size:28px">CLICK</button>\';',
          '    host.el.querySelector(\'#pkg-click-btn\').addEventListener(\'click\', async () => {',
          '      clicks += 1;',
          '      const btn = document.getElementById(\'pkg-click-btn\');',
          '      if (btn) btn.textContent = \'CLICKED \' + clicks;',
          '      try { await host.config.set({ clicks }); } catch { /* 回执尽力 */ }',
          '    });',
          '  },',
          '};',
        ].join('\n'), 'utf8');
      };
      const rectOf = (evt, id) => ((evt && evt.bounds) || []).find((b) => b.id === id) || null;
      const shapeOk = (b) => !!b && [b.x, b.y, b.width, b.height].every((v) => Number.isFinite(v));
      const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
      const area = { x: MARGIN, y: MARGIN, w: geo.inner.w - 2 * MARGIN, h: geo.inner.h - 2 * MARGIN - BAND };
      const inArea = (b) => b.x >= area.x - 0.5 && b.y >= area.y - 0.5
        && b.x + b.width <= area.x + area.w + 0.5 && b.y + b.height <= area.y + area.h + 0.5;
      const gridOk = (b) => b.x % GRID === 0 && b.y % GRID === 0 && b.width % GRID === 0 && b.height % GRID === 0;

      try {
        // 前置：两包登记停用（未知 id 静默待命）+ 清上一轮残留，再投放夹具
        await bridgeInvoke('settings/set-card-enabled', { id: PKG_A, enabled: false });
        await bridgeInvoke('settings/set-card-enabled', { id: PKG_B, enabled: false });
        await sleep(900); // 停用 rescan 落定再投放，防看门狗先激活
        removeBatteryPackages([PKG_A, PKG_B]);
        writeDropped(PKG_A);
        writeDropped(PKG_B);

        // ①② 逐包启用：零权限投放即激活（无批准闸门）；激活事件带 bounds（DIP）
        const tA = Date.now();
        await bridgeInvoke('settings/set-card-enabled', { id: PKG_A, enabled: true });
        const actA = await tape.wait('dropped-package-activated', (e) => e.id === PKG_A, { since: tA, timeoutMs: 15000 });
        const tB = Date.now();
        await bridgeInvoke('settings/set-card-enabled', { id: PKG_B, enabled: true });
        const actB = await tape.wait('dropped-package-activated', (e) => e.id === PKG_B, { since: tB, timeoutMs: 15000 });
        // 摆位下行回执：渲染层账本算好矩形 → set-package-bounds → 宿主落 dropped-package-bounds 存证
        const boundsAB = await tape.wait('dropped-package-bounds',
          (e) => rectOf(e, PKG_A) && rectOf(e, PKG_B), { since: tA, timeoutMs: 20000 });
        const rectA = rectOf(boundsAB, PKG_A);
        const rectB = rectOf(boundsAB, PKG_B);

        actA && actB && shapeOk(actA.bounds) && shapeOk(actB.bounds)
          ? rep.pass(`激活事件带 bounds（DIP）：${PKG_A} ${JSON.stringify(actA.bounds)}；${PKG_B} ${JSON.stringify(actB.bounds)}（激活时刻宿主矩形；最终矩形以下行存证为准）`)
          : rep.fail(`激活事件缺 bounds：A=${JSON.stringify(actA && actA.bounds)} B=${JSON.stringify(actB && actB.bounds)}`);

        rectA && rectB && gridOk(rectA) && gridOk(rectB) && inArea(rectA) && inArea(rectB) && !overlaps(rectA, rectB)
          ? rep.pass(`两包真实摆位：${PKG_A} (${rectA.x},${rectA.y}) ${rectA.width}×${rectA.height}、${PKG_B} (${rectB.x},${rectB.y}) ${rectB.width}×${rectB.height}——对齐 20px 格线、落可用区、互不重叠`)
          : rep.fail(`两包摆位几何不符：A=${JSON.stringify(rectA)} B=${JSON.stringify(rectB)} 格线=${!!(rectA && gridOk(rectA))}/${!!(rectB && gridOk(rectB))} 可用区=${!!(rectA && inArea(rectA))}/${!!(rectB && inArea(rectB))} 重叠=${!!(rectA && rectB && overlaps(rectA, rectB))}`);

        // 不压卡片：placement-rendered 的卡矩形（展开/活动态是临时模态不算占位，跳过）
        const rendered = tape.latest('placement-rendered');
        const solidCards = ((rendered && rendered.cards) || []).filter((c) => !c.expanded && !c.search && !c.rejected);
        const cardHit = rectA && rectB && solidCards.find((c) =>
          overlaps(rectA, { x: c.rect.x, y: c.rect.y, width: c.rect.w, height: c.rect.h })
          || overlaps(rectB, { x: c.rect.x, y: c.rect.y, width: c.rect.w, height: c.rect.h }));
        rectA && rectB && !cardHit
          ? rep.pass(`包与卡片同一账本互斥：${solidCards.length} 张在场卡无一被压（占用互斥同源 20px 格点）`)
          : rep.fail(`包压卡片：hit=${JSON.stringify(cardHit && cardHit.id)} cards=${JSON.stringify(solidCards.map((c) => `${c.id}@${c.rect.x},${c.rect.y},${c.rect.w}x${c.rect.h}`).slice(0, 8))}`);

        // ③ 点击回执：注入点击 B 中心——热区命中集并入包矩形（穿透解除）→ OS 递点击 → 包页
        // handler → host.config 上行（pkg:config-set）；plugin-config/get 读回即端到端回执。
        if (rectB) {
          const clicksBefore = await bridgeInvoke('plugin-config/get', { id: PKG_B })
            .then((r) => (r && r.config && r.config.clicks) || 0).catch(() => 0);
          await clickCard({ x: rectB.x + rectB.width / 2, y: rectB.y + rectB.height / 2 });
          const clicksAfter = await until(async () => {
            const r = await bridgeInvoke('plugin-config/get', { id: PKG_B }).catch(() => null);
            return r && r.config && Number(r.config.clicks) > clicksBefore ? Number(r.config.clicks) : null;
          }, 6000, 300);
          clicksAfter !== null
            ? rep.pass(`点击直达包内容：注入点击 (${Math.round(rectB.x + rectB.width / 2)},${Math.round(rectB.y + rectB.height / 2)}) 后经包宿主 config 通道回执 clicks ${clicksBefore}→${clicksAfter}（热区并入包矩形解除穿透，无输入注入桥）`)
            : rep.fail(`点击未达包内容：clicks 停在 ${clicksBefore}（查 hotzone 命中集与包视图矩形）`);
        }

        // ④ 禁用 A：视图移除 + 出账本（下行存证清单缩到只剩 B）
        const tDis = Date.now();
        await bridgeInvoke('settings/set-card-enabled', { id: PKG_A, enabled: false });
        const deactivated = await tape.wait('dropped-package-deactivated', (e) => e.id === PKG_A && e.reason === 'disabled', { since: tDis, timeoutMs: 15000 });
        const viewGone = await until(async () => !(await pkgTargets()).some((t) => t.url.startsWith(`deck-pkg://${PKG_A}/`)), 10000, 300);
        const ledgerOut = await until(async () => {
          const evt = tape.latest('dropped-package-bounds', null, { since: tDis });
          return evt && rectOf(evt, PKG_B) && !rectOf(evt, PKG_A) ? evt : null;
        }, 10000, 300);
        deactivated && viewGone && ledgerOut
          ? rep.pass(`禁用即显隐一致：deactivated(reason=disabled) 在档、deck-pkg://${PKG_A} 视图已移除、摆位账本同步出格（下行清单只剩 ${PKG_B}）`)
          : rep.fail(`禁用链路不符：deactivated=${!!deactivated} viewGone=${viewGone} ledgerOut=${JSON.stringify(ledgerOut && ledgerOut.bounds)}`);

        // ⑤ 重启用 A：回格点账本重新落位（禁用不留幽灵格点）
        const tRe = Date.now();
        await bridgeInvoke('settings/set-card-enabled', { id: PKG_A, enabled: true });
        const actA2 = await tape.wait('dropped-package-activated', (e) => e.id === PKG_A, { since: tRe, timeoutMs: 15000 });
        const reBounds = await tape.wait('dropped-package-bounds',
          (e) => rectOf(e, PKG_A) && rectOf(e, PKG_B), { since: tRe, timeoutMs: 20000 });
        const rectA2 = rectOf(reBounds, PKG_A);
        actA2 && rectA2 && gridOk(rectA2) && inArea(rectA2) && !overlaps(rectA2, rectB)
          ? rep.pass(`重启用回账本重落位：${PKG_A} 再激活（generation=${actA2.generation}）落 (${rectA2.x},${rectA2.y})，格线/可用区/与 ${PKG_B} 互斥全部保持`)
          : rep.fail(`重启用落位异常：act=${!!actA2} rect=${JSON.stringify(rectA2)} 格线=${!!(rectA2 && gridOk(rectA2))} 重叠=${!!(rectA2 && overlaps(rectA2, rectB))}`);
      } finally {
        // 清场：两包退停用集 + 目录与私有配置移除（崩溃轮由 finally 兜底同款清场）
        try { await bridgeInvoke('settings/set-card-enabled', { id: PKG_A, enabled: false }); } catch { /* 尽力 */ }
        try { await bridgeInvoke('settings/set-card-enabled', { id: PKG_B, enabled: false }); } catch { /* 尽力 */ }
        await sleep(500);
        removeBatteryPackages([PKG_A, PKG_B]);
      }
    }
  } catch (err) {
    rep.fail(`电池异常中止：${err instanceof Error ? err.stack || err.message : String(err)}`);
  } finally {
    // 清场：面板强退（验证消失）→ 配置/版面原样还原 → 桌面夹具与 P7 投放包清光
    try { await handle.stop(); } catch { /* 尽力 */ }
    try { restoreConfig(configRaw); } catch { /* 尽力 */ }
    try { removeBatteryPackages(P7_PACKAGE_IDS); } catch { /* 尽力 */ }
    try {
      if (layoutRaw !== null) fs.writeFileSync(layoutFile, layoutRaw, 'utf8');
      else fs.rmSync(layoutFile, { force: true });
    } catch { /* 尽力 */ }
    try { removeFixtures(); } catch { /* 尽力 */ }
    try { win32.moveMousePhys(40, 40); } catch { /* 尽力 */ }
    finish();
  }
}

module.exports = main;
