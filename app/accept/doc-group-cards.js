'use strict';
// 工单187 桌面文档组卡（spec166 收官）真机验收池。控制器以 --accept-doc-group-cards 身份运行，
// 拉起 --panel-accept 面板子进程（绕开单实例锁，与常驻面板共存）。
//
// 一段绑定一工单（docs/agents/battery-governance.md 增段三条件之三）：九张票各一段；工单179 的
// 失败面有「装载接管」与「卸载交还」两头，按主电池 P9/P9B 的同款拆段记法落成 P179 与 P179B
// 两段（段号电池内唯一），两段同归工单179。
// 增段条件对照：① 真机行为存证——卡面几何、菜单开层、输入注入、剪贴板落盘、系统热区矩形均为
// 单测够不到的面（纯模块那侧已由 tests/plugins/doc-group-cards-*.spec.ts 穷举）；② 单测能覆盖
// 的不进——分组/几何/交互/归属/菜单态/路由/写操作裁决都在纯模块里，本池只钉「真机接上了没有」；
// ③ 一段绑定一工单——见上。
//
// 两处裁决在本池里落定：
//   问A 24×24 残留文档区热区 —— 定「文档并接受」：成因是 ZONE_HOTZONE_PAD_PX 外扩把一个
//     零尺寸矩形撑成 24×24 的带（main.ts:1564 走 zoneHotzoneRectOf，hasItems 判据看 .ditem 子
//     节点不看可见性），不是 spec 与 ADR-0014 原记的「零尺寸矩形仍出带」（零尺寸矩形在
//     main.ts:1575 被 filter 掉了）。消除它要改内核共享几何（zone-hotzone.ts 同时供 declareHotZones
//     与 zoneAtPoint 两处用，改判据会波及框选起笔带与穿透让渡带宽），不在 ADR-0014 决策 (c)
//     「内核只增一对 plugin-config 方法」的边界内，故记录并接受；本段把这条带的**确切成因与确切
//     尺寸**钉死（常量从源码按行读，尺寸随常量走），它一变即红。
//   问B 首拍滚轮 —— 真机实测：见 P180 段账目与本文件末「问B 结论」。
//
// 运行：npm run accept:doc-group-cards（= electron . --accept-doc-group-cards）
// 装机纪律：插件只装进 os.tmpdir() 下的私有根（--root），本机共享根
// %APPDATA%\agent-deck-panel\plugins 全程不落东西——常驻自启面板（主检出 app/）会热加载
// 半成品插件到真桌面上。插件私有状态走内核 plugin-config（userData/plugin-config/<id>.json），
// 那是内核的既定落点（index.ts 不开放目录覆写），故电池备份原文件、轮末原样还原。
const { app, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const win32 = require('./lib/win32');
const { Report, parseAcceptScope } = require('./lib/report');
const { readConfigRaw, restoreConfig } = require('./lib/battery-config');
const { cdpPortFor } = require('./lib/registry');
// 工单212：事件磁带（app/accept/lib/event-tape）——等待/读事件收口到一份正典实现；
// 超时档 8000（本电池档：母票 #201 决策 8 的枚举漏列本电池，编排台账 §8 裁决 1
// 「保真优先于枚举」——传 6000 即 8000→6000 的行为变更）
const { createEventTape } = require('./lib/event-tape');
// 工单212：面板句柄（app/accept/lib/panel-control 的 createPanelHandle）——发射/就绪/
// 重启/清场四段样板归句柄；清场走**验证强退**（优雅终止 → 整树强杀 → 有界等待并验证消失）
const { createPanelHandle } = require('./lib/panel-control');

const BATTERY_ID = '166-doc-group-cards';
const APP_ROOT = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(APP_ROOT, 'config.json');
// 工单212：事件文件常量名归一——原名 EVIDENCE_FILE，其余七块电池一律叫 EVENTS_FILE；
// **路径字面不变**（仍是 166-doc-group-cards-events.jsonl），本刀只统一变量名
const EVENTS_FILE = path.join(__dirname, 'evidence', '166-doc-group-cards-events.jsonl');
const tape = createEventTape(EVENTS_FILE, { defaultTimeoutMs: 8000 });
// 工单212：证据档 fd 账（裁决 10 第②条：句柄的 archive 形态**不 close** fd，长跑会漏 fd——
// 由电池侧在清场时关闭）。本电池是**唯一**用 archive 形态的电池（落档变体）。
const archiveFds = [];
// 工单212：句柄装配——发射形态 accept（['.','--panel-accept'] ＋ CDP 端口）；事件档 EVENTS_FILE
// （boot 自报 pid 的来源）；证据档**按电池注入专属档名**（裁决 10 第①条：缺省是八块电池共用的
// 同一文件，混批会让红轮归因变难）——本电池的档名与路径字面保持 166-panel-child.log 不变
const handle = createPanelHandle({
  execPath: process.execPath,
  appRoot: APP_ROOT,
  eventLogPath: EVENTS_FILE,
  archivePath: path.join(__dirname, 'evidence', '166-panel-child.log'),
  openArchive: (file) => { const fd = fs.openSync(file, 'a'); archiveFds.push(fd); return fd; },
});
const PLUGIN_ROOT = path.join(os.tmpdir(), 'deck187-plugins');
const STAGING = path.join(os.tmpdir(), 'deck187-staging');
// 工单214：CDP 端口自电池接入表取（manifest 的 cdpPort 字段）——端口分配不再靠注释接力。
const CDP_PORT = cdpPortFor('166-doc-group-cards');
const PANEL_TITLE = 'AGENT DECK';
const DESKTOP_PREFIX = 'DGC187-';
const PAD_SOURCE = path.join(APP_ROOT, 'src', 'renderer', 'zone-hotzone.ts');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const koffi = win32.koffi;
const MOUSEWHEEL = 0x0800;
const SW_MINIMIZE = 6;

/** 轮询等条件成立（真机面上一切都得等：快照 1Hz、热区 25ms 轮询、watch 300ms 去抖） */
async function until(pred, timeoutMs, stepMs = 150) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() >= deadline) return null;
    await sleep(stepMs);
  }
}

function psRun(script) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', timeout: 25000 });
  if (r.status !== 0) throw new Error(`ps 失败 status=${r.status} stderr=${String(r.stderr || '').slice(0, 400)}`);
  return String(r.stdout || '').trim();
}

/** 用户桌面路径（与内核扫描同源：Environment.SpecialFolder.Desktop） */
function userDesktop() {
  return psRun('[Environment]::GetFolderPath("Desktop")');
}

// ---------------------------------------------------------------------------
// 事件流 / CDP
// ---------------------------------------------------------------------------
// 工单212：正典 readEvents / waitEvent 整体退役——事件观测归事件磁带（app/accept/lib/event-tape）。
// 磁带 wait 取「首个」匹配拍（正典 .find() 口径，编排台账 §8 裁决 2）；latest 取「最新一拍」
// （正典 .filter().pop() 口径）。时间门由 since 参数统一承担（e.t >= since）。

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

// ---------------------------------------------------------------------------
// 页内取样（CDP 表达式：DOM 几何/类名/热区相关的一切都在页里问，物理坐标在电池侧换算）
// ---------------------------------------------------------------------------
const EXPR = {
  cards: `(() => Array.from(document.querySelectorAll('.card.dgc-card')).map(c => {
    const r = c.getBoundingClientRect();
    return { id: c.id, x: r.left, y: r.top, w: r.width, h: r.height,
      expanded: c.classList.contains('dgc-expanded'), faded: c.classList.contains('dgc-faded'),
      cells: c.querySelectorAll('.dgc-cell').length,
      more: (c.querySelector('.dgc-more') || {}).textContent || null,
      title: (c.querySelector('.dgc-title') || {}).textContent || null };
  }))()`,
  viewport: `({ w: window.innerWidth, h: window.innerHeight })`,
  docZone: `(() => { const z = document.getElementById('doc-zone'); if (!z) return null;
    const r = z.getBoundingClientRect();
    return { display: z.style.display, w: r.width, h: r.height, ditem: z.querySelectorAll('.ditem').length,
      visible: getComputedStyle(z).display !== 'none' }; })()`,
  pluginMounted: `(() => {
    const c = document.querySelector('.deck-plugin[data-plugin-id="doc-group-cards"]');
    return { container: !!c, style: !!document.getElementById('dgc-style'),
      pluginConfig: !!(window.deck && window.deck.bridge) }; })()`,
  hotzoneCard: (id) => `(() => { const r = document.getElementById(${JSON.stringify(id)});
    if (!r) return null; const b = r.getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height }; })()`,
  menu: `(() => { const p = document.getElementById('dgc-menu'); if (!p) return null;
    const rows = Array.from(p.querySelectorAll('.dgc-menu-row')).map(r => ({
      id: r.dataset.row, label: (r.textContent || '').trim(),
      disabled: r.classList.contains('dgc-menu-disabled') }));
    const b = p.getBoundingClientRect();
    const ov = document.getElementById('dgc-overlay');
    const ob = ov ? ov.getBoundingClientRect() : null;
    return { open: true, rows, rect: { x: b.left, y: b.top, w: b.width, h: b.height },
      overlay: ob ? { x: ob.left, y: ob.top, w: ob.width, h: ob.height } : null,
      overlayIsCard: !!(ov && ov.classList.contains('card')) }; })()`,
  types: `(() => { const b = document.getElementById('dgc-types'); if (!b) return null;
    const list = document.getElementById('dgc-types-list');
    const name = document.getElementById('dgc-types-name');
    const bb = b.getBoundingClientRect();
    const rows = list ? Array.from(list.querySelectorAll('.dgc-types-row')).map(r => {
      const rb = r.getBoundingClientRect();
      return { ext: r.dataset.ext, checked: (r.textContent || '').indexOf('☑') >= 0,
        x: rb.left, y: rb.top, w: rb.width, h: rb.height }; }) : [];
    const allEl = document.getElementById('dgc-types-all');
    const ab = allEl ? allEl.getBoundingClientRect() : null;
    const okEl = document.getElementById('dgc-types-ok');
    const ob = okEl ? okEl.getBoundingClientRect() : null;
    const nb = name ? name.getBoundingClientRect() : null;
    return { open: true, name: name ? name.value : null,
      rect: { x: bb.left, y: bb.top, w: bb.width, h: bb.height }, rows,
      all: ab ? { x: ab.left, y: ab.top, w: ab.width, h: ab.height } : null,
      ok: ob ? { x: ob.left, y: ob.top, w: ob.width, h: ob.height } : null,
      nameRect: nb ? { x: nb.left, y: nb.top, w: nb.width, h: nb.height } : null }; })()`,
  confirm: `(() => { const b = document.getElementById('dgc-confirm'); if (!b) return null;
    const text = document.getElementById('dgc-confirm-text');
    const ok = document.getElementById('dgc-confirm-ok');
    const cancel = document.getElementById('dgc-confirm-cancel');
    const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
    return { open: true, text: text ? (text.textContent || '').trim() : null,
      ok: rect(ok), cancel: rect(cancel) }; })()`,
  rename: `(() => { const i = document.querySelector('.dgc-rename-input'); if (!i) return null;
    const r = i.getBoundingClientRect();
    return { open: true, value: i.value, rect: { x: r.left, y: r.top, w: r.width, h: r.height } }; })()`,
};

function cardExpr(id) {
  return `(() => { const c = document.getElementById(${JSON.stringify(id)}); if (!c) return null;
    const r = c.getBoundingClientRect();
    const g = c.querySelector('.dgc-grid'); const gr = g.getBoundingClientRect();
    const cs = getComputedStyle(g);
    const head = c.querySelector('.dgc-head'); const hr = head.getBoundingClientRect();
    const more = c.querySelector('.dgc-more'); const mr = more ? more.getBoundingClientRect() : null;
    const multi = c.querySelector('.dgc-multi'); const ur = multi ? multi.getBoundingClientRect() : null;
    const cells = Array.from(c.querySelectorAll('.dgc-cell')).map(el => { const b = el.getBoundingClientRect();
      return { path: el.dataset.path, x: b.left, y: b.top, w: b.width, h: b.height,
        sel: el.classList.contains('dgc-selected') }; });
    return { id: c.id, x: r.left, y: r.top, w: r.width, h: r.height,
      expanded: c.classList.contains('dgc-expanded'), faded: c.classList.contains('dgc-faded'),
      cellCount: cells.length,
      opacity: getComputedStyle(c).opacity, pointerEvents: getComputedStyle(c).pointerEvents,
      scrollTop: g.scrollTop, scrollHeight: g.scrollHeight, clientHeight: g.clientHeight,
      overflowY: cs.overflowY, grid: { x: gr.left, y: gr.top, w: gr.width, h: gr.height },
      head: { x: hr.left, y: hr.top, w: hr.width, h: hr.height },
      more: mr ? { x: mr.left, y: mr.top, w: mr.width, h: mr.height } : null,
      multi: ur ? { x: ur.left, y: ur.top, w: ur.width, h: ur.height } : null,
      multiOn: !!c.querySelector('.dgc-multi-on'),
      moreText: more ? (more.textContent || '').trim() : null,
      marquee: !!c.querySelector('.dgc-marquee'),
      cells }; })()`;
}

const cardProbe = (id) => cdpEval(cardExpr(id));

/** 卡片里与格序对应的可见性：格子中心是否落在内容区裁剪盒内（折叠态溢出即「藏而不丢」） */
const VISIBLE_CELLS_EXPR = (id) => `(() => { const c = document.getElementById(${JSON.stringify(id)});
  if (!c) return null; const g = c.querySelector('.dgc-grid'); const gr = g.getBoundingClientRect();
  return Array.from(c.querySelectorAll('.dgc-cell')).filter(el => { const b = el.getBoundingClientRect();
    const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
    return cx >= gr.left && cx < gr.right && cy >= gr.top && cy < gr.bottom; }).length; })()`;

// ---------------------------------------------------------------------------
// 输入注入（win32 层；物理坐标 = 页内 CSS 坐标经面板窗矩形换算，自校准 DPI）
// ---------------------------------------------------------------------------
let panelMap = null;
/** 报告句柄（供 refreshPanelMap 就绪自证记账用；未就位时静默） */
let repRef = null;
async function refreshPanelMap(hwnd) {
  const r = win32.rectOf(hwnd);
  // 窗已出现不等于页已就绪：视口读不到就重试，取不到有限值即如实抛（不拿 NaN 去注入坐标）
  const inner = await until(async () => {
    try {
      const v = await cdpEval(EXPR.viewport);
      return v && Number.isFinite(v.w) && Number.isFinite(v.h) && v.w > 0 ? v : null;
    } catch { return null; }
  }, 10000, 250);
  if (!r || !inner) throw new Error(`面板窗矩形/视口取不到：rect=${JSON.stringify(r)} inner=${JSON.stringify(inner)}`);
  const scale = (r.right - r.left) / inner.w;
  if (!Number.isFinite(scale) || scale <= 0) throw new Error(`面板坐标映射不成立：rect=${JSON.stringify(r)} inner=${JSON.stringify(inner)} scale=${scale}`);
  panelMap = { left: r.left, top: r.top, scale, inner };
  if (repRef) repRef.note(`面板坐标映射：窗矩形=${JSON.stringify(r)} 视口=${JSON.stringify(inner)} scale=${scale.toFixed(4)}`);
  return panelMap;
}
const toPhys = (css) => ({
  x: Math.round(panelMap.left + css.x * panelMap.scale),
  y: Math.round(panelMap.top + css.y * panelMap.scale),
});
const centerOf = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

const minimizedForRestore = [];
/** 落点必须真被本面板接收：被无关顶层窗盖住就最小化它（还原清单轮末消费，battery.js 同款纪律） */
async function ensureHit(p) {
  for (let i = 0; i < 24; i++) {
    const h = win32.windowFromPointRoot(p);
    const owned = h && win32.threadIdOf(h).pid === panelPid;
    if (owned) return true;
    const cls = h ? win32.className(h) : '(none)';
    if (h && !/Progman|WorkerW|Shell_TrayWnd/.test(cls)) {
      try { win32.ShowWindow(h, SW_MINIMIZE); minimizedForRestore.push(h); } catch { /* 尽力 */ }
    }
    await sleep(250);
  }
  return false;
}

/** 落点等热区：面板默认鼠标穿透，靠主进程 25ms 轮询 + setIgnoreMouseEvents 生效才收得到输入。
 *  刚落点就点击会整片打空（落在下面的窗上）——真机首轮实证：这一处等待是 P181/框选/PASTE
 *  三处假红的共同成因。故：移动 → 等两拍轮询 → 微抖一下再等 → 才按下。 */
async function settleAt(p) {
  win32.moveMousePhys(p.x, p.y);
  await sleep(140);
  win32.moveMousePhys(p.x + 2, p.y + 2);
  await sleep(140);
  win32.moveMousePhys(p.x, p.y);
  await sleep(80);
}

async function clickAt(css, button = 'left') {
  const p = toPhys(css);
  const ok = await ensureHit(p);
  await settleAt(p);
  win32.clickPhys(p.x, p.y, button);
  return ok ? p : null;
}
async function doubleClickAt(css) {
  const p = toPhys(css);
  await ensureHit(p);
  await settleAt(p);
  win32.clickPhys(p.x, p.y, 'left');
  await sleep(60);
  win32.clickPhys(p.x, p.y, 'left');
  return p;
}
/** 滚轮一「拍」= 一个 WHEEL_DELTA（120）。负值向下滚。win32.mouseInput 的 mouseData 恒 0，
 *  故这里自建 INPUT（MOUSEWHEEL 位），与 clickPhys 同一 send 通道。 */
function wheelTick(delta) {
  const input = { type: 0, u: { mi: { dx: 0, dy: 0, mouseData: delta >>> 0, dwFlags: MOUSEWHEEL, time: 0, dwExtraInfo: 0 } } };
  win32.send([input]);
}

/** 页内滚动探针：记录每个 scroll 事件的墙钟时刻与 scrollTop（问B 的毫秒级取证靠它） */
async function installScrollProbe(cardId) {
  await cdpEval(`(() => { const c = document.getElementById(${JSON.stringify(cardId)});
    if (!c) return false; const g = c.querySelector('.dgc-grid');
    window.__t187 = { ticks: [] };
    g.addEventListener('scroll', () => {
      window.__t187.ticks.push({ t: performance.timeOrigin + performance.now(), st: g.scrollTop });
    }, true);
    return true; })()`);
}
const readTicks = () => cdpEval('(window.__t187 && window.__t187.ticks) || []');

async function captureRect(cssRect, name) {
  const x = cssRect.x, y = cssRect.y, w = cssRect.w, h = cssRect.h;
  if (!panelMap || ![x, y, w, h].every((v) => Number.isFinite(v))) {
    if (repRef) repRef.note(`截图跳过（几何非有限值）：${name} rect=${JSON.stringify(cssRect)}`);
    return null;
  }
  try {
    const { desktopCapturer } = require('electron');
    const d = screen.getPrimaryDisplay();
    const phys = { w: Math.round(d.bounds.width * d.scaleFactor), h: Math.round(d.bounds.height * d.scaleFactor) };
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: phys.w, height: phys.h } });
    const full = sources[0] && sources[0].thumbnail;
    if (!full || full.isEmpty()) return null;
    const p = toPhys({ x, y });
    const cw = Math.round(w * panelMap.scale);
    const ch = Math.round(h * panelMap.scale);
    if (![p.x, p.y, cw, ch].every((v) => Number.isFinite(v))) return null;
    const crop = full.crop({
      x: Math.max(0, p.x), y: Math.max(0, p.y),
      w: Math.max(1, Math.min(cw, phys.w - Math.max(0, p.x))),
      h: Math.max(1, Math.min(ch, phys.h - Math.max(0, p.y))),
    });
    const out = path.join(__dirname, 'evidence', `${name}.png`);
    fs.writeFileSync(out, crop.toPNG());
    return out;
  } catch (err) {
    // 像素存证是加分项，不得反过来带走整轮断言：截屏通道异常如实记账后继续
    if (repRef) repRef.note(`截图通道异常（跳过 ${name}，不影响断言）：${err && err.message}｜display=${JSON.stringify(screen.getPrimaryDisplay())}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 面板子进程（工单212：发射/就绪/清场归面板句柄）
// ---------------------------------------------------------------------------
let panelPid = 0;

async function startPanel(reason) {
  fs.writeFileSync(EVENTS_FILE, '', 'utf8');
  // 工单212：发射归面板句柄——mode='accept'（['.','--panel-accept'] 绕单实例锁，与常驻面板共存）
  // ＋ CDP 端口；stdio='archive'（落档变体）：子进程 stdout/stderr 落证据档，面板早亡时
  // （如 bootPanel 抛错）本控制器拿不到任何栈，那正是首轮定位不到原因的原因——stderr 必须留证
  // （工单49 同款纪律）。archivePath 注入**本电池专属**档名，路径字面不变（仍是
  // evidence/166-panel-child.log，裁决 10 第①条）。
  handle.launch({ mode: 'accept', cdpPort: CDP_PORT, stdio: 'archive' });
  const boot = await tape.wait('boot', null, { timeoutMs: 20000 });
  if (!boot) throw new Error(`面板子进程未上报 boot 事件（${reason}）`);
  panelPid = boot.pid;
  // 工单212：就绪寻窗归面板句柄（pid＋标题＋可见性；cls 缺省不做类名过滤——与正典同形）
  const hwnd = await handle.waitWindow({ title: PANEL_TITLE, timeoutMs: 15000 });
  if (!hwnd) {
    const seen = win32.topLevelWindows().filter((x) => win32.threadIdOf(x).pid === panelPid)
      .map((x) => `hwnd=${x} title=${JSON.stringify(titleOf(x))} cls=${win32.className(x)} vis=${win32.IsWindowVisible(x)}`);
    throw new Error(`面板窗口未出现（${reason}）；该进程顶层窗诊断=${JSON.stringify(seen)}`);
  }
  await refreshPanelMap(hwnd);
  await installPageErrorProbe();
  // 插件装载是热加载链（fs.watch 300ms 去抖 → rescan → import），等挂载事件而不是死等
  await until(() => cdpEval(EXPR.pluginMounted).then((v) => v && v.container), 15000, 250);
  return hwnd;
}

/**
 * 验证强退（工单212，#202 决策 8 授权的唯一有意行为变更）：句柄 stop() 沿用工单112 的强退序列
 * （优雅终止 → 整树强杀 → 有界等待并**验证消失**）。**gone=false ＝「需重启清障」中止信号**：
 * 入环境降责账并中止后续段（throw 借电池的 try/catch 汇流，不吞）。
 * 原实现是无验证 killPanel（taskkill /T /F 后不验消失就放行重启）——停摆面板残留会撞
 * 单实例守卫，本刀起补上「验证消失」这一环。
 */
async function stopPanelOrAbort(rep) {
  const stopped = await handle.stop();
  panelPid = 0; panelMap = null; // 面板身份与几何缓存随面板一起作废（原 killPanel 的同一处置）
  if (!stopped.gone) {
    rep.exclude(`面板强退失败：强杀后有界等待内仍存活（pid=${stopped.pidsLeft.join(', ')}）——需重启清障`,
      '面板强退序列未能终结面板进程', 'panel-forcekill');
    throw new Error('面板强退失败：需重启清障——后续段中止');
  }
  return stopped;
}

// ---------------------------------------------------------------------------
// 装机 / 夹具
// ---------------------------------------------------------------------------
function installPlugin() {
  fs.mkdirSync(PLUGIN_ROOT, { recursive: true });
  // ELECTRON_RUN_AS_NODE：控制器身份是 electron.exe，直接拿 process.execPath 跑 .mjs 会被当成
  // 拉起一个应用实例（首轮实证：spawnSync 30s 超时、status=null，还顺带开了一扇窗）。
  const r = spawnSync(process.execPath, ['scripts/install-plugin.mjs', 'doc-group-cards', '--root', PLUGIN_ROOT],
    { cwd: APP_ROOT, encoding: 'utf8', timeout: 30000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  if (r.status !== 0) throw new Error(`install-plugin 失败 status=${r.status} ${String(r.stderr || '').slice(0, 300)}`);
  return path.join(PLUGIN_ROOT, 'doc-group-cards', 'plugin.json');
}

function patchConfigPlugins(dir) {
  const raw = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, 'utf8') : null;
  const json = raw ? JSON.parse(raw) : {};
  json.plugins = { ...(json.plugins || {}), dir, disabled: (json.plugins && json.plugins.disabled) || [] };
  // 投放档必须不在停用名单里（config.json 是 gitignored 的本地文件，不污染 diff）
  json.plugins.disabled = json.plugins.disabled.filter((id) => id !== 'doc-group-cards');
  json.taskbar = { ...(json.taskbar || {}), enabled: false };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(json, null, 2) + '\n', 'utf8');
  return raw;
}

function makeFixtures(desktop, count, ext, tag) {
  const names = [];
  for (let i = 1; i <= count; i++) {
    const n = `${DESKTOP_PREFIX}${tag}${i}.${ext}`;
    fs.writeFileSync(path.join(desktop, n), `deck187 fixture ${tag}${i}\n`, 'utf8');
    names.push(n);
  }
  return names;
}
/** 撤夹具；给了 tag 就只撤该批（rtf 批量撤时不能连带撤掉后续段还要用的 txt/pdf/zip 夹具） */
function removeFixtures(desktop, tag) {
  const head = tag ? DESKTOP_PREFIX + tag : DESKTOP_PREFIX;
  let n = 0;
  try {
    for (const f of fs.readdirSync(desktop)) {
      // 粘贴用例的落物不带前缀（内核贴到桌面根时用原名，同名冲突再加「 - 副本」），
      // 一并按前缀撤——否则它们会留到下一轮，把「粘贴路由」的判据越搅越脏。
      const isPasteDrop = /^(s1|q1)( - 副本)*\.txt$/.test(f);
      if (f.startsWith(head) || isPasteDrop) {
        try { fs.unlinkSync(path.join(desktop, f)); n++; } catch { /* 尽力 */ }
      }
    }
  } catch { /* 尽力 */ }
  return n;
}
const desktopHas = (desktop, name) => fs.existsSync(path.join(desktop, name));
const desktopList = (desktop) => { try { return fs.readdirSync(desktop).filter((f) => f.startsWith(DESKTOP_PREFIX)); } catch { return []; } };

/** 剪贴板播种（PS 通道，battery.js P5.16 同法）：Set-Clipboard -Path + FileDropList 回读核验。
 *  只播种**一个**文件——本机 PowerShell 的 `Set-Clipboard -Path 'a','b'` 实测只落进第一个
 *  （FileDropList 回读恒为 1），多文件播种必须换通道，故本池一律单文件，逐次换夹具。 */
async function seedClipboard(paths) {
  let lastErr = '';
  for (let i = 0; i < 3; i++) {
    try {
      const list = paths.map((p) => `'${String(p).replace(/'/g, "''")}'`).join(',');
      psRun(`Set-Clipboard -Path ${list} -ErrorAction Stop`);
      await sleep(400);
      const check = psRun(`if (@(Get-Clipboard -Format FileDropList -ErrorAction SilentlyContinue).Count -ge ${paths.length}) { 'ok' } else { 'no' }`);
      if (check === 'ok') return true;
      lastErr = `回读核验未过（期望 ≥${paths.length}）`;
    } catch (e) { lastErr = (e && e.message) || String(e); }
    await sleep(700);
  }
  if (repRef) repRef.note(`剪贴板播种三次未成：${lastErr}`);
  return false;
}
function clearClipboard() {
  try { psRun("Set-Clipboard -Value 'deck187-cleared' -ErrorAction Stop"); return true; } catch { return false; }
}

/** 按键态 INPUT（LEFTDOWN/LEFTUP 走与 clickPhys 同一 send 通道，拖拽用） */
const mouseBtn = (flag) => ({ type: 0, u: { mi: { dx: 0, dy: 0, mouseData: 0, dwFlags: flag, time: 0, dwExtraInfo: 0 } } });

/** 菜单里某一行的中心点（行等高，按序从菜单顶边量——菜单外壳的行高是自绘的固定值） */
function rowPoint(menu, rowId) {
  if (!menu || !menu.rows.length) return null;
  const i = menu.rows.findIndex((r) => r.id === rowId);
  if (i < 0) return null;
  const h = menu.rect.h / menu.rows.length;
  return { x: menu.rect.x + menu.rect.w / 2, y: menu.rect.y + (i + 0.5) * h, w: 2, h: 2 };
}

// 记事本窗标题（关窗按标题认领本轮夹具，不误伤用户自己的记事本）
const _user32 = koffi.load('user32.dll');
const GetWindowTextW = _user32.func('int __stdcall GetWindowTextW(uintptr_t hWnd, uint16 *buf, int nMax)');
function titleOf(hwnd) {
  const buf = Buffer.alloc(1024);
  const n = GetWindowTextW(hwnd, buf, 512);
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(buf.readUInt16LE(i * 2));
  return s;
}

/** 关掉被本轮启动、且标题带夹具前缀的窗（认不出归属的一律不动） */
function closeFixtureWindows() {
  let n = 0;
  for (const h of win32.topLevelWindows()) {
    try {
      if (!win32.IsWindowVisible(h)) continue;
      const title = titleOf(h);
      if (title && title.includes(DESKTOP_PREFIX)) { win32.ShowWindow(h, SW_MINIMIZE); n++; }
    } catch { /* 尽力 */ }
  }
  return n;
}

/** 收掉自绘菜单并等它真的退场（菜单开着时全屏遮罩会吃掉后续所有卡片点击——
 *  上一段留下的菜单会让下一段整段假红，故每处开完层必须显式收场）。 */
async function closeMenu() {
  const open = await cdpEval(EXPR.menu);
  if (!open) return true;
  win32.tapKeys([0x1B]);
  const gone = await until(() => cdpEval(EXPR.menu).then((m) => (m ? null : true)), 4000, 120);
  if (!gone) {
    const vp = await cdpEval(EXPR.viewport);
    await clickAt({ x: vp.w - 12, y: vp.h - 12 });
    return !!(await until(() => cdpEval(EXPR.menu).then((m) => (m ? null : true)), 4000, 120));
  }
  return true;
}

/** 段首把某张卡收回折叠态（折叠切换会清高亮，顺带把上一段的选中态归零） */
async function ensureCollapsed(cardId) {
  const c = await cardProbe(cardId);
  if (!c || !c.expanded) return c;
  await clickAt({ x: c.x + 8, y: c.y + c.h / 2 });
  return until(async () => {
    const x = await cardProbe(cardId);
    return x && !x.expanded ? x : null;
  }, 5000, 120);
}

/**
 * 等整排**稳下来**：相邻两次快照（间隔一个快照周期）里，整排的张数与逐卡矩形完全一致才算稳。
 *
 * 为什么不能只看某一张卡的位置：卡片的增删（撤夹具、删除最后一份文件）触发整排重新居中，而那一拍
 * 可能还没落进快照——此时两次量到的某张卡相同、判据就提前放行，随后它才消失、别的卡才位移，
 * 于是「量到的卡框」与「点击那一刻的真位置」错开一整排。实测那一击会落到隔壁的 calendar-card 上：
 * 点不中图标、不高亮、卡框前后两份也对不上（工单167 修复轮复现，见 §证据）。
 * 判据按整排即是对题面那句「等排稳住」的本意，不是把判据放松——一致性要求比原来**更严**。
 */
async function rowStable() {
  return until(async () => {
    const shot = async () => (await cdpEval(EXPR.cards))
      .map((k) => `${k.id}@${Math.round(k.x)},${Math.round(k.y)},${Math.round(k.w)},${Math.round(k.h)}`).join('|');
    const a1 = await shot();
    await sleep(700);
    const a2 = await shot();
    return a1.length > 0 && a1 === a2;
  }, 8000, 300)
}

/** 段首把整排收回折叠态：淡出卡 pointer-events:none，谁没收起谁就吃掉后续段的卡片点击 */
async function collapseAll() {  const cards = await cdpEval(EXPR.cards);
  for (const c of cards.filter((k) => k.expanded)) {
    await clickAt({ x: c.x + 8, y: c.y + c.h / 2 });
    await until(async () => {
      const now = await cdpEval(EXPR.cards);
      return !now.some((k) => k.id === c.id && k.expanded);
    }, 5000, 120);
  }
}

/** 落点上真正压着的元素（注入打空时的取证，页内 elementFromPoint） */
const hitProbe = (x, y) => cdpEval(`(() => { const el = document.elementFromPoint(${x}, ${y});
  if (!el) return null; const r = el.getBoundingClientRect();
  return { tag: el.tagName, cls: el.className, id: el.id,
    parent: el.parentElement ? (el.parentElement.className || el.parentElement.id) : null,
    x: r.left, y: r.top, w: r.width, h: r.height }; })()`);

/** 页内错误收集器：注入打空/裁决抛错时，页内栈是唯一线索（控制器拿不到） */
async function installPageErrorProbe() {
  await cdpEval(`(() => { if (window.__t187err) return true;
    window.__t187err = [];
    window.addEventListener('error', (e) => window.__t187err.push(String(e.message) + ' @' + (e.filename || '') + ':' + (e.lineno || '')));
    window.addEventListener('unhandledrejection', (e) => window.__t187err.push('rejection: ' + String(e.reason)));
    return true; })()`);
}
const pageErrors = () => cdpEval('(window.__t187err || []).slice(-5)');

/** 开组卡菜单（卡片空白处右键）：先确保没有残留菜单遮罩，再右击；注入失手有界重试一次并记账。
 *  返回 { menu, ev, retries }——ev 取插件自己的 menu-opened 存证（带 cardId 与行号）。 */
async function openGroupMenuAt(cardId) {
  await closeMenu();
  for (let attempt = 1; attempt <= 2; attempt++) {
    const c = await cardProbe(cardId);
    if (!c) return { menu: null, ev: null, retries: attempt };
    await clickAt({ x: c.x + 8, y: c.y + c.h / 2 }, 'right');
    const menu = await until(() => cdpEval(EXPR.menu), 4000, 150);
    if (menu) {
      const ev = await tape.wait('doc-group-cards-menu-opened', (e) => e.cardId === cardId, { timeoutMs: 3000 });
      if (attempt > 1 && repRef) repRef.note(`组卡菜单开层第 2 次才成（${cardId}）：注入失手一次，如实记账`);
      return { menu, ev, retries: attempt };
    }
  }
  return { menu: null, ev: null, retries: 2 };
}

// 工单212：末拍口径（正典 readEvents().filter(...).pop()）→ 磁带 latest
const lastHotzones = () => tape.latest('hotzones');
const rectEq = (a, b, tol = 1) => !!a && !!b && Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol
  && Math.abs(a.w - b.w) <= tol && Math.abs(a.h - b.h) <= tol;

async function main() {
  const rep = new Report('166-doc-group-cards', { scope: parseAcceptScope(process.argv) });
  repRef = rep;
  const configBackup = readConfigRaw();
  const desktop = userDesktop();
  const userDataDir = app.getPath('userData');
  const cfgFile = path.join(userDataDir, 'plugin-config', 'doc-group-cards.json');
  const probeCfgFile = path.join(userDataDir, 'plugin-config', 'deck187-probe.json');
  const cfgBackup = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, 'utf8') : null;
  let stageFiles = [];
  const sameRect = (a, b) => rectEq(a, b, 0.5);

  const finish = () => {
    const v = rep.verdict();
    app.exit(v.exitCode);
  };

  try {
    rep.note(`插件私有根（私有，绝不落共享根）：${PLUGIN_ROOT}`);
    const manifestPath = installPlugin();
    rep.note(`install-plugin --root 就位：${manifestPath}`);
    patchConfigPlugins(PLUGIN_ROOT);

    fs.mkdirSync(STAGING, { recursive: true });
    makeFixtures(desktop, 8, 'txt', 't');       // TXT 卡：8 格（折叠一屏 6 格 → 溢出 +2）
    makeFixtures(desktop, 3, 'pdf', 'p');       // PDF 卡：3 格，无溢出
    makeFixtures(desktop, 2, 'zip', 'z');       // ZIP 卡：粘贴落点（固有卡）
    makeFixtures(desktop, 1, 'txt', 'del');     // DELETE 用例（单张，删得干净）
    makeFixtures(desktop, 1, 'txt', 'ren');     // RENAME 用例
    for (const n of ['s1.txt', 'q1.txt']) {
      const f = path.join(STAGING, n); fs.writeFileSync(f, `deck187 staged ${n}\n`, 'utf8'); stageFiles.push(f);
    }
    rep.note(`夹具就位：桌面 ${desktopList(desktop).length} 份，暂存 ${stageFiles.length} 份`);

    let hwnd = await startPanel('首启');

    // ===== P178 · 工单178 内核 plugin-config 契约（真机跨进程面）====================
    rep.beginSegment('P178');
    {
      // (a) 跨进程读回本身即契约面：面板页 invoke 经 preload→主进程→service 回到 JS 值。
      //     注意不依赖「插件恰好写过 groups」——插件只在定义变化时才落库，契约与插件的偶然状态无关。
      const got = await cdpEval(`window.deck.bridge.invoke('plugin-config/get', { id: 'doc-group-cards' })`);
      got && typeof got.config === 'object' && got.config !== null && Array.isArray(got.warnings)
        ? rep.pass(`跨进程读回成立：面板页 invoke('plugin-config/get') 返回 {config, warnings} 形状（warnings=${JSON.stringify(got.warnings)}）`)
        : rep.fail(`跨进程读回异常：${JSON.stringify(got)}`);

      // (b) 落盘面（system-state）：经同一契约写一次，userData/plugin-config/<id>.json 即刻落盘并可读回
      const wrote = await cdpEval(`window.deck.bridge.invoke('plugin-config/set', { id: 'doc-group-cards', patch: { probe: 't187' } })`);
      const onDisk = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : null;
      const reread = await cdpEval(`window.deck.bridge.invoke('plugin-config/get', { id: 'doc-group-cards' })`);
      wrote && onDisk && onDisk.probe === 't187' && reread && reread.config.probe === 't187'
        ? rep.pass(`落盘面成立：set 之后 ${cfgFile} 即为 ${Buffer.byteLength(fs.readFileSync(cfgFile, 'utf8'), 'utf8')} 字节且含新键，get 读回同值`)
        : rep.fail(`落盘面异常：wrote=${!!wrote} onDisk=${JSON.stringify(onDisk)} reread=${JSON.stringify(reread && reread.config)}`);

      // 命名空间隔离：另一个 id 读写各落各的文件，doc-group-cards 的文件一个字节都不动
      const before = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, 'utf8') : null;
      const other = await cdpEval(`window.deck.bridge.invoke('plugin-config/set', { id: 'deck187-probe', patch: { k: 'v' } })`);
      const otherGet = await cdpEval(`window.deck.bridge.invoke('plugin-config/get', { id: 'deck187-probe' })`);
      const after = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, 'utf8') : null;
      const isolated = otherGet && otherGet.config && otherGet.config.k === 'v'
        && fs.existsSync(probeCfgFile) && before === after;
      isolated
        ? rep.pass(`命名空间隔离成立：deck187-probe 落 ${path.basename(probeCfgFile)}，doc-group-cards 文件逐字节未变（${before === after ? '同' : '异'}）`)
        : rep.fail(`命名空间隔离异常：probe=${JSON.stringify(otherGet)} probeFile=${fs.existsSync(probeCfgFile)} docGroupFileChanged=${before !== after}`);
      try { fs.rmSync(probeCfgFile, { force: true }); } catch { /* 尽力 */ }

      // 自愈面：坏 JSON 视同空对象 + warning 如实回报，且插件仍装载（面板不崩、桌面不空白）
      fs.writeFileSync(cfgFile, '{ this is not json', 'utf8');
      rep.note('已把 doc-group-cards.json 写成坏 JSON，重启面板验自愈面');
      // 工单212：定点杀归句柄验证强退（gone=false 即中止信号）；不走向柄 relaunch——
      // 本电池的重拉点是「定点杀 → 沉降 → 发射」形态，且**旧 boot 清除靠事件档截断**而非
      // since 门，relaunch 的 sinceMs（只能在停止前取值）会把门提前到旧实例 boot 之前
      await stopPanelOrAbort(rep);
      hwnd = await startPanel('坏 JSON 重启');
      const healed = await cdpEval(`window.deck.bridge.invoke('plugin-config/get', { id: 'doc-group-cards' })`);
      const mountedAgain = await cdpEval(EXPR.pluginMounted);
      const warnOk = healed && Array.isArray(healed.warnings) && healed.warnings.length > 0
        && healed.config && Object.keys(healed.config).length === 0;
      warnOk && mountedAgain && mountedAgain.container
        ? rep.pass(`坏值自愈成立：坏 JSON 视同空对象并记 warning（${(healed.warnings || []).join(' | ').slice(0, 120)}），插件照常装载`)
        : rep.fail(`坏值自愈异常：config=${JSON.stringify(healed && healed.config)} warnings=${JSON.stringify(healed && healed.warnings)} mounted=${!!(mountedAgain && mountedAgain.container)}`);
      // 契约面验完即收干净：把 (b) 写的探针键与坏 JSON 都抹掉，后续段从零状态起
      try {
        if (cfgBackup !== null) fs.writeFileSync(cfgFile, cfgBackup, 'utf8');
        else fs.rmSync(cfgFile, { force: true });
      } catch { /* 尽力 */ }
      rep.note('P178 契约面收尾：插件私有状态已复位，后续段从零定义起');
    }

    // ===== P179 · 工单179 装载接管文档区 / 整排几何 / 24×24 残留（问A 定案）========
    rep.beginSegment('P179');
    {
      const mounted = await tape.wait('doc-group-cards-mounted', null, { timeoutMs: 6000 });
      const mount = await cdpEval(EXPR.pluginMounted);
      const zone = await cdpEval(EXPR.docZone);
      mount && mount.container && mount.style && mounted
        ? rep.pass(`装载接管成立：doc-group-cards-mounted 存证在档，插件容器与自带样式表均在场`)
        : rep.fail(`装载接管异常：container=${!!(mount && mount.container)} style=${!!(mount && mount.style)} event=${!!mounted}`);

      // 问A 成因链三要素：文档区矩形零尺寸（display:none）+ 「分区非空」判据仍见 .ditem 子节点
      //                 + 外扩常量 P（从内核源码按行读，带宽即 P）
      const padSrc = fs.readFileSync(PAD_SOURCE, 'utf8');
      const pad = Number((padSrc.match(/ZONE_HOTZONE_PAD_PX\s*=\s*(\d+)/) || [])[1] || NaN);
      const hz = lastHotzones();
      const band = hz && (hz.rects || []).find((r) => r.id === 'doc-zone');
      zone && zone.display === 'none' && zone.w === 0 && zone.h === 0 && zone.ditem > 0
        ? rep.pass(`成因链在场：文档区 display:none 且矩形 ${zone.w}×${zone.h}（零尺寸），而「分区非空」判据仍数到 ${zone.ditem} 个 .ditem 子节点`)
        : rep.fail(`成因链缺环：${JSON.stringify(zone)}`);
      band && band.x === 0 && band.y === 0 && band.w === pad && band.h === pad
        ? rep.pass(`24×24 残留带定案（文档并接受）：最新热区申报里 doc-zone 恰为 (${band.x},${band.y},${band.w},${band.h})，与 ZONE_HOTZONE_PAD_PX=${pad} 同值——它不是零尺寸矩形漏网（零尺寸矩形在 main.ts:1575 被 filter 掉），而是零尺寸矩形被外扩撑成的带`)
        : rep.fail(`残留带尺寸与成因不符：band=${JSON.stringify(band)} ZONE_HOTZONE_PAD_PX=${pad}`);

      // 整排几何：左到右、整行水平居中、按视口垂直居中、组序稳定、id 唯一
      const cards = await cdpEval(EXPR.cards);
      const vp = await cdpEval(EXPR.viewport);
      const rowLeft = Math.min(...cards.map((c) => c.x));
      const rowRight = Math.max(...cards.map((c) => c.x + c.w));
      const rowCenter = (rowLeft + rowRight) / 2;
      const centerOff = Math.abs(rowCenter - vp.w / 2);
      const ids = cards.map((c) => c.id);
      const uniq = new Set(ids).size === ids.length;
      const yOk = cards.every((c) => Math.abs((c.y + c.h / 2) - vp.h / 2) <= 1);
      const orderOk = ids.every((id, i) => i === 0 || cards[i - 1].x <= cards[i].x);
      const txtCard = cards.find((c) => c.id === 'dgc-txt');
      const pdfCard = cards.find((c) => c.id === 'dgc-pdf');
      const zipCard = cards.find((c) => c.id === 'dgc-zip');
      cards.length >= 3 && txtCard && pdfCard && zipCard
        ? rep.pass(`整排在场：${cards.length} 张卡（${ids.join(', ')}），卡 id 全表唯一=${uniq}`)
        : rep.fail(`整排异常：ids=${JSON.stringify(ids)} txt=${!!txtCard} pdf=${!!pdfCard} zip=${!!zipCard}`);
      centerOff <= 1 && yOk && orderOk && uniq
        ? rep.pass(`整排几何：水平居中偏差 ${centerOff.toFixed(2)}px（≤1），逐卡垂直居中偏差 ≤1，左到右序递增，id 唯一`)
        : rep.fail(`整排几何：居中偏差=${centerOff.toFixed(2)} 垂直居中=${yOk} 序递增=${orderOk} id唯一=${uniq}`);
      // 组序稳定：表内扩展名按 EXT_GROUP_ORDER、表外统一按字母序兜底（grouping.js sortGroupKeys 同款排法）
      const order = fs.readFileSync(path.join(APP_ROOT, 'plugins', 'doc-group-cards', 'grouping.js'), 'utf8');
      const table = (order.match(/EXT_GROUP_ORDER\s*=\s*\[([\s\S]*?)\]/) || [])[1] || '';
      // 表里带 `// 办公系` 这类行内注释，必须先剥掉再切分（否则 `.pdf` 会与注释粘成一个条目）
      const rank = new Map();
      table.replace(/\/\/[^\n]*/g, '').split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter((s) => s.startsWith('.')).forEach((ext, i) => rank.set(ext, i));
      const cardExts = ids.filter((id) => id.startsWith('dgc-') && !/^dgc-[ct]\d+$/.test(id))
        .map((id) => '.' + id.slice(4));
      // 排序口径与 grouping.js sortGroupKeys 同款：order.indexOf（表外 = -1，即排在表内之前），
      // 同为表外时按字母序。表内序非降即错。
      const exts = cardExts.map((e) => (rank.has(e) ? rank.get(e) : -1));
      const stable = exts.every((v, i) => i === 0 || exts[i - 1] <= v);
      stable
        ? rep.pass(`组序稳定：卡序与 EXT_GROUP_ORDER 一致（表内按表序、表外 indexOf=-1 排在表前且按字母序），无到达序依赖——ranks=${JSON.stringify(exts)}`)
        : rep.fail(`组序不稳定：ranks=${JSON.stringify(exts)} cards=${JSON.stringify(cardExts)} 表内条目=${rank.size}`);
      if (txtCard && pdfCard && zipCard) {
        await captureRect({ x: rowLeft, y: cards[0].y - 10, w: rowRight - rowLeft, h: (cards[0].h + 20) }, '187-p179-cards');
      }
    }

    // ===== P180 · 工单180 折叠/展开/滚动/热区重申报 + 问B 首拍滚轮 ===============
    rep.beginSegment('P180');
    {
      const c0 = await cardProbe('dgc-txt');
      const vis0 = await cdpEval(VISIBLE_CELLS_EXPR('dgc-txt'));
      const hidden = c0 && c0.cellCount - vis0;
      c0 && c0.overflowY === 'hidden' && vis0 === 6 && hidden > 0
        ? rep.pass(`折叠态溢出隐藏：内容区 overflow-y=${c0.overflowY}，一屏露 ${vis0} 格、藏 ${hidden} 格（藏而不丢：DOM 里 ${c0.cells} 格全在）`)
        : rep.fail(`折叠态异常：overflowY=${c0 && c0.overflowY} 可见=${vis0} 总数=${c0 && c0.cells}`);
      const expectBadge = c0 && hidden > 0 ? `+${hidden}` : null;
      expectBadge && c0.moreText === expectBadge
        ? rep.pass(`+N 徽标正确：卡片实况 ${c0.cells} 格 − 一屏 6 格 = 藏 ${hidden}，徽标文本「${c0.moreText}」`)
        : rep.fail(`+N 徽标异常：徽标=${JSON.stringify(c0 && c0.moreText)} 期望=${JSON.stringify(expectBadge)}`);
      await captureRect(c0, '187-p180-collapsed');

      // 展开：2 倍宽 4 倍高 + 其余卡淡出 + 按自身高度重新垂直居中 + 热区立刻重申报
      const txtCardBlank = c0 ? { x: c0.x + 8, y: c0.y + c0.h / 2 } : null; // 卡内 20px 内边距条 = 空白处
      await clickAt(txtCardBlank);
      const c1 = await until(async () => { const c = await cardProbe('dgc-txt'); return c && c.expanded ? c : null; }, 5000, 120);
      const vp = await cdpEval(EXPR.viewport);
      const others = (await cdpEval(EXPR.cards)).filter((c) => c.id !== 'dgc-txt');
      const geoOk = c1 && Math.abs(c1.w - c0.w * 2) <= 1 && Math.abs(c1.h - c0.h * 4) <= 1;
      const recenter = c1 && Math.abs((c1.y + c1.h / 2) - vp.h / 2) <= 1;
      const fadedOk = others.length > 0 && others.every((c) => c.faded);
      geoOk && recenter && fadedOk
        ? rep.pass(`展开态 2×/4×：${Math.round(c0.w)}×${Math.round(c0.h)} → ${Math.round(c1.w)}×${Math.round(c1.h)}，垂直重新居中偏差 ${Math.abs((c1.y + c1.h / 2) - vp.h / 2).toFixed(2)}px，其余 ${others.length} 张卡淡出`)
        : rep.fail(`展开态异常：几何2x4x=${geoOk} 重新居中=${recenter}（偏差 ${c1 ? Math.abs((c1.y + c1.h / 2) - vp.h / 2).toFixed(2) : 'n/a'}）其余淡出=${fadedOk}`);
      const otherId = others.length ? others[0].id : '';
      const pdfProbe = otherId ? await cdpEval(cardExpr(otherId)) : null;
      pdfProbe && pdfProbe.faded && Number(pdfProbe.opacity) <= 0.1 && pdfProbe.pointerEvents === 'none'
        ? rep.pass(`淡出卡形态：${otherId} opacity=${pdfProbe.opacity}、pointer-events=${pdfProbe.pointerEvents}（工单167：淡出卡卡框塌成 0×0 → 主进程那侧扫 .card 取零尺寸矩形、按 main.ts:1575 滤掉 → 不再声明热区，那一带真正穿透回桌面，不再是「看得见的死区」）`)
        : rep.fail(`淡出卡形态异常：${JSON.stringify(pdfProbe && { id: pdfProbe.id, faded: pdfProbe.faded, opacity: pdfProbe.opacity, pe: pdfProbe.pointerEvents })}`);
      const hzNow = lastHotzones();
      const hzCard = hzNow && (hzNow.rects || []).find((r) => r.id === 'dgc-txt');
      rectEq(hzCard, c1, 1.5)
        ? rep.pass(`热区重申报：展开后最新热区矩形与 DOM 矩形互证一致（${JSON.stringify(hzCard)}）——新露出的那圈立即可点`)
        : rep.fail(`热区未跟上：热区=${JSON.stringify(hzCard)} DOM=${JSON.stringify(c1 && { x: c1.x, y: c1.y, w: c1.w, h: c1.h })}`);
      await captureRect({ x: c1.x, y: Math.max(0, c1.y), w: c1.w, h: Math.min(c1.h, vp.h - c1.y) }, '187-p180-expanded');

      // 新露出的第 7 格（折叠态被裁掉、展开态可见）立刻可点 → 高亮出现
      const seventh = c1 && c1.cells[6];
      let clicked = false;
      if (seventh) { await clickAt(centerOf(seventh)); clicked = true; }
      const sel = await until(async () => {
        const c = await cardProbe('dgc-txt');
        return c && c.cells[6] && c.cells[6].sel ? c.cells[6] : null;
      }, 4000, 120);
      clicked && sel
        ? rep.pass(`新露区域立即可点：折叠态看不见的第 7 格（${seventh.path && path.basename(seventh.path)}）点中即高亮，无需等下一拍`)
        : rep.fail(`新露区域点不动：点击=${clicked} 第7格高亮=${!!sel}`);

      // 滚动条：单扩展名堆够格数才有溢出（展开内容区 916px 高 ≈ 9 行 54 格）
      const many = makeFixtures(desktop, 66, 'rtf', 'w');
      const big = await until(async () => {
        const c = await cardProbe('dgc-rtf');
        return c && c.cellCount >= 55 ? c : null;
      }, 25000, 500);
      if (big) {
        const b1 = await cardProbe('dgc-rtf');
        await clickAt({ x: b1.x + 8, y: b1.y + b1.h / 2 }); // 空白处展开
        const b2 = await until(async () => { const c = await cardProbe('dgc-rtf'); return c && c.expanded ? c : null; }, 5000, 120);
        const range = b2 ? b2.scrollHeight - b2.clientHeight : 0;
        b2 && b2.overflowY === 'auto' && range >= 100
          ? rep.pass(`纵向滚动条：展开内容区 overflow-y=auto，可滚余量 ${range}px（scrollHeight=${b2.scrollHeight} / clientHeight=${b2.clientHeight}，${many.length} 份夹具）`)
          : rep.fail(`滚动条异常：overflowY=${b2 && b2.overflowY} 余量=${range}`);

        // —— 问B 首拍滚轮（真机；判据与离线模型 tests/plugins/doc-group-cards-wheel.spec.ts 同族）——
        await installScrollProbe('dgc-rtf');
        const midOfGrid = (c) => ({ x: c.grid.x + c.grid.w / 2, y: c.grid.y + c.grid.h / 2 });
        const away = toPhys({ x: 40, y: 40 }); // 卡外：面板转鼠标穿透
        // (1) 入场首拍：光标在卡外（穿透态）→ 移进卡内并立刻打一拍
        const before0 = (await cardProbe('dgc-rtf')).scrollTop;
        win32.moveMousePhys(away.x, away.y);
        await sleep(400);
        const enterPt = toPhys(midOfGrid(await cardProbe('dgc-rtf')));
        win32.moveMousePhys(enterPt.x, enterPt.y);
        const tEntry = Date.now();
        wheelTick(-120);
        const afterEntry = await until(async () => {
          const c = await cardProbe('dgc-rtf'); return c && c.scrollTop > before0 ? c.scrollTop : null;
        }, 1200, 30);
        const ticks1 = await readTicks();
        // (2) 已在卡内驻留后的一拍：对照（应当零丢失）
        await sleep(500);
        const before1 = (await cardProbe('dgc-rtf')).scrollTop;
        const tInside = Date.now();
        wheelTick(-120);
        const afterInside = await until(async () => {
          const c = await cardProbe('dgc-rtf'); return c && c.scrollTop > before1 ? c.scrollTop : null;
        }, 1200, 30);
        // (3) 连续三拍（问B：入场丢的那一拍之后，后续各拍是否都送达）
        const before3 = (await cardProbe('dgc-rtf')).scrollTop;
        for (let i = 0; i < 3; i++) { wheelTick(-120); await sleep(120); }
        await sleep(600);
        const after3 = (await cardProbe('dgc-rtf')).scrollTop;
        const entryLatency = ticks1.length ? Math.round(ticks1[0].t - tEntry) : null;
        rep.note(`问B 实测：入场首拍 scrollTop ${before0}→${afterEntry}（${afterEntry != null ? '送达' : '丢失'}，首个 scroll 事件滞后 ${entryLatency != null ? entryLatency + 'ms' : 'n/a'}）；驻留后一拍 ${before1}→${afterInside}；连打三拍 ${before3}→${after3}`);
        const lostOnEntry = afterEntry == null;
        const residentOk = afterInside != null;
        const laterAllDelivered = after3 > afterInside;
        // 判据按离线模型（tests/plugins/doc-group-cards-wheel.spec.ts）的口径写：入场首拍**至多丢 1 拍**
        // （成因即 SendInput 队列 + setIgnoreMouseEvents→合成器延迟这两项残差），其后各拍全部送达；
        // 已在卡内驻留后再打则必达。实测若首拍也送达，同样判绿（那是更好的结果）。
        residentOk && laterAllDelivered
          ? rep.pass(`问B 结论（真机）：入场首拍${lostOnEntry ? '**丢失**（丢 1 拍）' : '送达'}，驻留后一拍必达（${before1}→${afterInside}），连打三拍 ${before3}→${after3} 全部生效——SendInput 队列与 setIgnoreMouseEvents→合成器延迟两项残差的净效应 = 入场丢至多 1 拍、其后无丢，与离线模型同口径`)
          : rep.fail(`问B 与离线模型不一致：入场首拍${lostOnEntry ? '丢失' : '送达'}，驻留后${residentOk ? '送达' : '丢失'}，三拍后=${after3}（明细见 NOTE）`);
        await clickAt({ x: (await cardProbe('dgc-rtf')).x + 8, y: (await cardProbe('dgc-rtf')).y + 40 }); // 收起
        await until(async () => { const c = await cardProbe('dgc-rtf'); return c && !c.expanded; }, 5000, 120);
      } else {
        rep.fail(`滚动/滚轮用例前置缺失：rtf 卡未在 25s 内堆到 55 格（夹具 ${many.length} 份已落盘）`);
      }
      removeFixtures(desktop, 'w');
      rep.note(`滚轮用例夹具已撤（rtf 批量 ${many.length} 份），其余夹具留着给后续段`);
      // 撤夹具会触发下一拍重排（整行重新居中 → 卡片位移）。等排稳住再进下一段，
      // 否则下一段开头量到的卡框会与点击那一刻的真位置对不上（首轮假红成因之二；判据见 rowStable）。
      await rowStable();
    }

    // ===== P181 · 工单181 卡级交互（高亮不改形状 / 空白切折叠 / 徽标同裁决 / 双击启动）=
    rep.beginSegment('P181');
    {
      await ensureCollapsed('dgc-txt'); // 折叠切换顺带清高亮，段首拿回干净起点
      const before = await cardProbe('dgc-txt');
      const cell0 = before && before.cells[0];
      await clickAt(centerOf(cell0));
      const after = await cardProbe('dgc-txt');
      const hl = after && after.cells[0] && after.cells[0].sel;
      const shapeSame = sameRect({ x: before.x, y: before.y, w: before.w, h: before.h },
        { x: after.x, y: after.y, w: after.w, h: after.h });
      hl && shapeSame && !after.expanded
        ? rep.pass(`点图标只高亮不改形状：该格亮起（.dgc-selected），卡框逐像素未变（${Math.round(before.w)}×${Math.round(before.h)}），卡片未展开`)
        : rep.fail(`点图标异常：highlight=${!!hl} 卡框不变=${shapeSame} expanded=${after && after.expanded}`);
      // 高亮不参与布局（outline+背景色），再点一次图标格形状也不该变
      await clickAt(centerOf(after.cells[1]));
      const after2 = await cardProbe('dgc-txt');
      const two = after2.cells.filter((c) => c.sel).length;
      sameRect({ x: before.x, y: before.y, w: before.w, h: before.h }, { x: after2.x, y: after2.y, w: after2.w, h: after2.h }) && two >= 1
        ? rep.pass(`高亮是插件自建的一套：再点一格后高亮 ${two} 格，卡框仍逐像素不变，也不伪造内核 desktop-selected 存证族`)
        : rep.fail(`高亮布局异常：两格高亮=${two} 卡框不变=${sameRect({ x: before.x, y: before.y, w: before.w, h: before.h }, { x: after2.x, y: after2.y, w: after2.w, h: after2.h })}`);

      // 空白处折叠/展开往复；徽标命中走同一裁决
      const b1 = await cardProbe('dgc-txt');
      await clickAt({ x: b1.x + 8, y: b1.y + b1.h / 2 });
      const up = await until(async () => { const c = await cardProbe('dgc-txt'); return c && c.expanded ? c : null; }, 5000, 120);
      await clickAt({ x: up.x + 8, y: up.y + up.h / 2 });
      const down = await until(async () => { const c = await cardProbe('dgc-txt'); return c && !c.expanded ? c : null; }, 5000, 120);
      down && sameRect({ x: b1.x, y: b1.y, w: b1.w, h: b1.h }, { x: down.x, y: down.y, w: down.w, h: down.h })
        ? rep.pass(`空白处往复切换：折叠→展开（${Math.round(up.w)}×${Math.round(up.h)}）→折叠回原矩形，往复幂等`)
        : rep.fail(`空白处往复异常：expanded=${!!up} 回位=${!!down}`);
      const bm = await cardProbe('dgc-txt');
      if (bm && bm.more) {
        await clickAt(centerOf(bm.more));
        const viaBadge = await until(async () => { const c = await cardProbe('dgc-txt'); return c && c.expanded; }, 4000, 120);
        viaBadge
          ? rep.pass(`徽标与空白同一裁决：点「${bm.moreText}」徽标同样切到展开态（isCardToggle 单一出口）`)
          : rep.fail(`徽标命中未切形状：expanded=${!!viaBadge}`);
        const bb = await cardProbe('dgc-txt');
        await clickAt({ x: bb.x + 8, y: bb.y + bb.h / 2 });
        await until(async () => { const c = await cardProbe('dgc-txt'); return c && !c.expanded; }, 4000, 120);
      } else {
        rep.note('本卡无 +N 徽标（无溢出），徽标同裁决一例由溢出用例覆盖');
      }

      // 双击启动：走既有 desktop/launch 契约与扫描池护栏
      const cur = await cardProbe('dgc-txt');
      const tLaunch = Date.now();
      await doubleClickAt(centerOf(cur.cells[0]));
      const evLaunch = await tape.wait('doc-group-cards-launch', undefined, { since: tLaunch - 500, timeoutMs: 8000 });
      evLaunch && evLaunch.path && desktopHas(desktop, path.basename(evLaunch.path))
        ? rep.pass(`双击启动成立：存证 ${path.basename(evLaunch.path)}（${evLaunch.name}），文件确在桌面扫描池内`)
        : rep.fail(`双击启动异常：event=${JSON.stringify(evLaunch)}`);
      await closeFixtureWindows();
    }

    // ===== P182 · 工单182 自绘菜单外壳 + 只读五项 ==============================
    rep.beginSegment('P182');
    {
      const c = await cardProbe('dgc-pdf');
      const t0 = Date.now();
      await clickAt(centerOf(c.cells[0]), 'right');
      const menu = await until(() => cdpEval(EXPR.menu), 6000, 150);
      const evOpen = await tape.wait('doc-group-cards-menu-opened', undefined, { since: t0, timeoutMs: 4000 });
      const readonlyFive = ['open', 'open-location', 'copy-path', 'copy', 'cut'];
      const ids = menu ? menu.rows.map((r) => r.id) : [];
      menu && readonlyFive.every((r) => ids.includes(r))
        ? rep.pass(`文件菜单只读五项在列：${menu.rows.map((r) => r.label).join(' / ')}（外加工单183 的 RENAME / DELETE 共 ${menu.rows.length} 行）`)
        : rep.fail(`文件菜单行异常：${JSON.stringify(ids)}`);
      menu && menu.overlayIsCard && menu.overlay && Math.round(menu.overlay.w) === menu.rect.w + 1000
        ? rep.pass(`自绘外壳在场：#dgc-overlay 是一张铺开的 .card，遮罩矩形 ${Math.round(menu.overlay.w)}×${Math.round(menu.overlay.h)}`)
        : rep.note(`遮罩形态：overlay=${JSON.stringify(menu && menu.overlay)} isCard=${menu && menu.overlayIsCard}`);
      const hzOpen = lastHotzones();
      const fullWin = hzOpen && (hzOpen.rects || []).find((r) => r.w >= panelMap.inner.w - 1 && r.h >= panelMap.inner.h - 1);
      fullWin && evOpen
        ? rep.pass(`开层期间面板不让穿透：热区申报里出现全窗矩形 ${JSON.stringify(fullWin)}，菜单外的一击收得到`)
        : rep.fail(`开层未让出全窗热区：rects=${JSON.stringify((hzOpen && hzOpen.rects || []).map((r) => r.id))}`);
      const vp = await cdpEval(EXPR.viewport);
      await clickAt({ x: vp.w - 12, y: vp.h - 12 });
      const closedOutside = await tape.wait('doc-group-cards-menu-closed', undefined, { since: t0, timeoutMs: 4000 });
      rep.note(`菜单外点击收场：closed=${!!closedOutside}`);
      // Esc 收场（工单182 的一半）
      const c2 = await cardProbe('dgc-pdf');
      const t1 = Date.now();
      await clickAt(centerOf(c2.cells[1]), 'right');
      await until(() => cdpEval(EXPR.menu), 5000, 150);
      win32.tapKeys([0x1B]);
      const closedEsc = await tape.wait('doc-group-cards-menu-closed', undefined, { since: t1, timeoutMs: 4000 });
      closedEsc
        ? rep.pass(`菜单外点击与 Esc 都收场：两次开层分别由屏外一击与 Esc 收掉（存证族在档）`)
        : rep.fail(`收场异常：外击=${!!closedOutside} Esc=${!!closedEsc}`);
      const hzAfter = lastHotzones();
      const bandAfter = hzAfter && (hzAfter.rects || []).find((r) => r.id === 'doc-zone');
      bandAfter && bandAfter.w === 24
        ? rep.pass(`关层即撤全窗热区：doc-zone 残留带回到 (${bandAfter.x},${bandAfter.y},${bandAfter.w},${bandAfter.h})，没留死区`)
        : rep.fail(`关层后热区异常：${JSON.stringify(bandAfter)}`);
    }

    // ===== P183 · 工单183 写操作 DELETE/RENAME + 组卡菜单骨架 ====================
    rep.beginSegment('P183');
    {
      await ensureCollapsed('dgc-txt');
      const c = await cardProbe('dgc-txt');
      const t0 = Date.now();
      await clickAt(centerOf(c.cells[0]), 'right');
      const menu = await until(() => cdpEval(EXPR.menu), 6000, 150);
      const ids = menu ? menu.rows.map((r) => r.id) : [];
      ids.length === 7 && ids.includes('rename') && ids.includes('delete')
        ? rep.pass(`文件菜单七行齐：${menu.rows.map((r) => r.label).join(' / ')}（破坏性的 DELETE 收尾）`)
        : rep.fail(`文件菜单行数/构成异常：${JSON.stringify(ids)}`);
      await closeMenu(); // 七行验完即收场：菜单的全屏遮罩会把后续卡片点击整片吃掉

      // RENAME：内联编辑器 → 输入框已被聚焦且预选 stem → 敲新名 → Enter 提交（内核按名一对一契约）
      const curCells = (await cardProbe('dgc-txt')).cells;
      const renameCell = curCells.find((x) => path.basename(x.path).includes('ren'));
      const newName = 'ren2';
      if (renameCell) {
        const tRen = Date.now();
        await clickAt(centerOf(renameCell), 'right');
        const mr = await until(() => cdpEval(EXPR.menu), 6000, 150);
        await clickAt(rowPoint(mr, 'rename'));
        const ed = await until(() => cdpEval(EXPR.rename), 6000, 150);
        const evRen = await tape.wait('doc-group-cards-rename-opened', undefined, { since: tRen, timeoutMs: 4000 });
        ed && evRen
          ? rep.pass(`RENAME 带内联编辑器：输入框在场（草稿「${ed.value}」，扩展名之前的部分已预选），改名走内核 desktop/rename 一对一契约`)
          : rep.fail(`RENAME 编辑器异常：editor=${!!ed} event=${!!evRen}`);
        if (ed) {
          // 输入框里预选的是 stem（全选态），故直接敲完整新 stem 即可，不必做局部替换
          const newStem = `${DESKTOP_PREFIX}ren2`;
          win32.sendUnicode(newStem);
          await sleep(350);
          win32.tapKeys([0x0D]);
          const wantName = `${newStem}.txt`;
          const renamed = await until(() => desktopHas(desktop, wantName), 10000, 300);
          const closed = await tape.wait('doc-group-cards-rename-closed', undefined, { since: tRen, timeoutMs: 4000 });
          renamed && closed
            ? rep.pass(`RENAME 提交成立：${path.basename(renameCell.path)} → ${wantName}（真实改名，扫描池随 watch 更新）`)
            : rep.fail(`RENAME 提交异常：期望 ${wantName} 存在=${!!renamed} 关闭存证=${!!closed}（实况 ${JSON.stringify(desktopList(desktop).filter((n) => n.includes('ren'))) }）`);
        }
      } else {
        rep.fail('RENAME 用例夹具缺失：TXT 卡里找不到 *ren*.txt');
      }

      // DELETE：确认层 → 取消不动 → 再开 → 确认真删
      const delName = `${DESKTOP_PREFIX}del1.txt`;
      if (desktopHas(desktop, delName)) {
        const cc = await cardProbe('dgc-txt');
        const target = cc.cells.find((x) => path.basename(x.path) === delName);
        const tDel = Date.now();
        await clickAt(centerOf(target), 'right');
        const m2 = await until(() => cdpEval(EXPR.menu), 6000, 150);
        await clickAt(rowPoint(m2, 'delete'));
        const cf = await until(() => cdpEval(EXPR.confirm), 6000, 150);
        const evConfirm = await tape.wait('doc-group-cards-confirm-opened', undefined, { since: tDel, timeoutMs: 4000 });
        cf && evConfirm
          ? rep.pass(`DELETE 带确认层：确认框在场（文案「${String(cf.text).slice(0, 40)}」），不确认不动磁盘`)
          : rep.fail(`DELETE 确认层异常：confirm=${!!cf} event=${!!evConfirm}`);
        if (cf && cf.cancel) {
          await clickAt(centerOf(cf.cancel));
          await sleep(600);
          rep.note(`取消分支：文件仍在原处=${desktopHas(desktop, delName)}`);
        }
        // 再来一次，这次确认
        const cc2 = await cardProbe('dgc-txt');
        const target2 = cc2.cells.find((x) => path.basename(x.path) === delName);
        if (target2) {
          await clickAt(centerOf(target2), 'right');
          const m3 = await until(() => cdpEval(EXPR.menu), 6000, 150);
          await clickAt(rowPoint(m3, 'delete'));
          const cf2 = await until(() => cdpEval(EXPR.confirm), 6000, 150);
          if (cf2 && cf2.ok) await clickAt(centerOf(cf2.ok));
          const gone = await until(() => !desktopHas(desktop, delName), 8000, 200);
          gone
            ? rep.pass(`DELETE 确认后真删：${delName} 已不在桌面（desktop/trash 既有契约，回收站直进）`)
            : rep.fail(`DELETE 确认后未删：${delName} 仍在桌面`);
        }
      } else {
        rep.fail('DELETE 用例夹具缺失：找不到 ' + delName);
      }

      // 组卡菜单骨架：固有卡出 PASTE / NEW GROUP 两行（EDIT TYPES / DISSOLVE 挂在手改得动的卡上）
      // 工单187 裁决②：NEW GROUP 建的是**新**卡、不改脚下那张，故在固有卡上恒可见；
      // 「全新安装时全是固有卡、建不出第一张自定义卡」那条路由此通了。另两行仍不出现。
      // 同款：DELETE 刚删掉一份文件，整排要重排（最后一份被删时那张卡整个消失）。
      // 不等稳就量 dgc-zip 的矩形，这一记右键会落在陈旧坐标上、菜单压根不开（实测复现过两次）。
      await rowStable()
      const zip = await cardProbe('dgc-zip');
      await clickAt({ x: zip.x + 8, y: zip.y + zip.h / 2 }, 'right');
      const gmenu = await until(() => cdpEval(EXPR.menu), 6000, 150);
      const gids = gmenu ? gmenu.rows.map((r) => r.id) : [];
      JSON.stringify(gids) === JSON.stringify(['paste', 'new-group'])
        ? rep.pass(`组卡菜单骨架（固有卡）：右键卡片空白出菜单，行集=PASTE + NEW GROUP——${gids.join(',')}；NEW GROUP 建的是新卡、不改这张规则生成的卡，而 EDIT TYPES·DISSOLVE 仍不出`)
        : rep.fail(`固有卡组卡菜单异常：${JSON.stringify(gids)}（期望恰为 paste,new-group）`);
      if (gmenu) { await clickAt({ x: (await cdpEval(EXPR.viewport)).w - 12, y: (await cdpEval(EXPR.viewport)).h - 12 }); await sleep(400); }
    }

    // ===== P184 · 工单184 卡内多选 ============================================
    rep.beginSegment('P184');
    {
      await collapseAll(); // 段首收排：淡出卡 pointer-events:none，不收就会吃掉本段后续点击
      const c = await cardProbe('dgc-pdf');
      await clickAt(centerOf(c.multi));
      const on = await until(async () => { const x = await cardProbe('dgc-pdf'); return x && x.multiOn ? x : null; }, 4000, 120);
      const evMulti = await tape.wait('doc-group-cards-multi-toggled', null, { timeoutMs: 3000 });
      const other = await cardProbe('dgc-zip');
      on && evMulti && !other.multiOn
        ? rep.pass(`逐卡多选开关：dgc-multi 点亮（.dgc-multi-on）+ 存证在档，另一张卡的开关不受影响（逐卡独立）`)
        : rep.fail(`多选开关异常：on=${!!on} event=${!!evMulti} 邻卡=${!!(other && other.multiOn)}`);

      const c2 = await cardProbe('dgc-pdf');
      await clickAt(centerOf(c2.cells[0]));
      await clickAt(centerOf(c2.cells[1]));
      const sel2 = await until(async () => {
        const x = await cardProbe('dgc-pdf'); const n = x.cells.filter((k) => k.sel).length; return n >= 2 ? n : null;
      }, 4000, 120);
      sel2
        ? rep.pass(`点选切换：两格各自点一下即两格在选（${sel2} 格），再点一格即摘（单选集合，非累加）`)
        : rep.fail('点选切换异常：两格未同时在选');

      // 框选：展开态内容区底部空白起笔，向上拖过若干格。
      // 多选开关紧挨着拖拽临点现开：中间任何一次整排重画都会把交互态清零，开关与拖拽之间
      // 隔一拍就可能白开——这是首轮「拖拽带不出现」的候选成因，故按临点现开写死。
      const c3 = await cardProbe('dgc-pdf');
      await clickAt({ x: c3.x + 8, y: c3.y + c3.h / 2 });
      const up = await until(async () => { const x = await cardProbe('dgc-pdf'); return x && x.expanded ? x : null; }, 5000, 120);
      if (up && !up.multiOn) {
        await clickAt(centerOf(up.multi));
        await until(async () => { const x = await cardProbe('dgc-pdf'); return x && x.multiOn; }, 4000, 120);
      }
      const up2 = await cardProbe('dgc-pdf');
      // 全表落证（工单187 第二轮）：起笔点能不能落在卡内，全看这张「展开卡」此刻**真的**按展开几何
      // 摆在那儿。类名 dgc-expanded 与内联几何是两回事——首轮红臂实测到二者脱节（类名在、卡框仍是
      // 折叠尺寸且停在折叠槽位），于是内容区下半截掉出视口、起笔点落空，框选恒空。
      const rowNow = (await cdpEval(EXPR.cards)).map((c) => ({
        id: c.id, expanded: c.expanded, faded: c.faded,
        x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.w), h: Math.round(c.h),
      }));
      rep.note(`框选段落首全表落证：${JSON.stringify(rowNow)}｜视口=${JSON.stringify(await cdpEval(EXPR.viewport))}`);
      // 起笔点/收笔点按**实测格子**取，不按网格外沿的固定比例。
      // 【工单187 第二轮修正】原先取 `grid.x + grid.w/2` 与 `grid.w * 0.62`：展开态是 6 列，
      // 而这张卡只有 3 格，格子只占前 3 列（实测 x 996..1276），网格外沿 60% 处（x≈1280 起）
      // 整条带子都在**格子右侧的空白列**里——那一框从头到尾没压到任何一格，命中恒为 0。
      // 与其对列数与件数做假设，不如直接量那几格的真矩形，从它们正下方的内容区空白起笔、
      // 收到最后一格中心：这条带子必然横穿每一格。
      const cellRects = up2.cells;
      if (cellRects.length < 2) {
        rep.fail(`框选取证前置失败：dgc-pdf 只有 ${cellRects.length} 格，构不成「拖过若干格」的框`);
      }
      const firstCell = cellRects[0];
      const lastCell = cellRects[cellRects.length - 1];
      const startCss = { x: firstCell.x + firstCell.w / 2, y: up2.grid.y + up2.grid.h - 20 };
      const endCss = { x: lastCell.x + lastCell.w / 2, y: lastCell.y + lastCell.h / 2 };
      const a = toPhys(startCss); const b = toPhys(endCss);
      await ensureHit(a);
      await settleAt(a); // 同 clickAt：拖拽起笔同样要等热区轮询把这一片接管
      win32.send([mouseBtn(win32.LEFTDOWN)]);
      const steps = 8;
      for (let i = 1; i <= steps; i++) {
        win32.moveMousePhys(Math.round(a.x + (b.x - a.x) * i / steps), Math.round(a.y + (b.y - a.y) * i / steps));
        await sleep(60);
      }
      const duringMarquee = await cardProbe('dgc-pdf');
      win32.send([mouseBtn(win32.LEFTUP)]);
      rep.note(`框选取证：起笔点压着 ${JSON.stringify(await hitProbe(startCss.x, startCss.y))}｜按下瞬间 multiOn=${up2.multiOn} expanded=${up2.expanded}｜拖拽中 multiOn=${duringMarquee && duringMarquee.multiOn} 拖拽带=${duringMarquee && duringMarquee.marquee} 页内错误=${JSON.stringify(await pageErrors())}`);
      const marqueeSeen = duringMarquee && duringMarquee.marquee;
      const selAfter = await cardProbe('dgc-pdf');
      const hitCount = selAfter.cells.filter((k) => k.sel).length;
      // 坐标系自证（工单187 真机轮）：实测网格外沿 vs「卡框内联 left/top + 内边距 20/18 + 卡头 24」
      // 那套换算。差值非零即两份「网格局部」不是同一个系——真格子的实测矩形是唯一的裁判。
      const drift = { dx: Math.round(selAfter.grid.x - (selAfter.x + 20)), dy: Math.round(selAfter.grid.y - (selAfter.y + 42)) };
      rep.note(`框选坐标系自证：实测网格外沿 ${Math.round(selAfter.grid.x)},${Math.round(selAfter.grid.y)}｜算式外沿 ${Math.round(selAfter.x + 20)},${Math.round(selAfter.y + 42)}｜偏移 ${JSON.stringify(drift)}｜松手后带子残留=${!!selAfter.marquee} multiOn=${!!selAfter.multiOn}`);
      marqueeSeen && hitCount >= 2
        ? rep.pass(`框选成立：拖拽期间卡上有 .dgc-marquee 带，松手后 ${hitCount} 格入选（内容区空白起笔，不改写已有格序；网格外沿与算式外沿偏移 ${JSON.stringify(drift)}）`)
        : rep.fail(`框选异常：拖拽带=${!!marqueeSeen} 入选=${hitCount} 松手后带子残留=${!!selAfter.marquee} multiOn=${!!selAfter.multiOn} 坐标系偏移=${JSON.stringify(drift)} 格子数=${selAfter.cells.length}`);

      // ENTER 整批启动
      const tEnt = Date.now();
      win32.tapKeys([0x0D]);
      const evSel = await tape.wait('doc-group-cards-launch-selection', undefined, { since: tEnt - 300, timeoutMs: 8000 });
      evSel && Array.isArray(evSel.paths) && evSel.paths.length === hitCount
        ? rep.pass(`ENTER 整批启动：一次回车发出 ${evSel.paths.length} 条（${evSel.paths.map((p) => path.basename(p)).join(', ')}），与选区同数`)
        : rep.fail(`ENTER 批量启动异常：event=${JSON.stringify(evSel && { n: evSel.paths && evSel.paths.length })} 选区=${hitCount}`);
      await closeFixtureWindows();

      // 多选菜单：两格在选时 OPEN LOCATION / RENAME 置灰
      // 【工单187 第三轮修正】原先无脑点前两格：那是「从 0 选起切到 2 选」的写法，可本用例接在
      // 框选之后——框选已经把 3 格选上了，再点两格是**摘**（3→2→1），落到「恰一选中」那一档，
      // 判据自然不成立。故改成收敛到恰好两格：多退少补，点到 selected===2 为止。
      const fixSel = await until(async () => {
        const cur = await cardProbe('dgc-pdf');
        if (!cur) return null;
        const n = cur.cells.filter((k) => k.sel).length;
        if (n === 2) return n;
        // 多于两格就摘掉最后一格，少于两格就补上第一格未选中的
        const target = n > 2 ? cur.cells.filter((k) => k.sel).slice(-1)[0] : cur.cells.find((k) => !k.sel);
        if (!target) return null;
        await clickAt(centerOf(target));
        return null;
      }, 8000, 200);
      const tM = Date.now();
      const selNow = await cardProbe('dgc-pdf');
      await clickAt(centerOf(selNow.cells[0]), 'right');
      const mm = await until(() => cdpEval(EXPR.menu), 6000, 150);
      const g = (id) => mm && mm.rows.find((r) => r.id === id);
      const greyed = g('open-location') && g('open-location').disabled && g('rename') && g('rename').disabled;
      greyed && g('open') && !g('open').disabled
        ? rep.pass(`多选菜单置灰：恰一选中才可用的 OPEN LOCATION 与 RENAME 两行置灰，OPEN 仍可用（needs 单一裁决出口）；本条先把框选选中的 ${hitCount} 格收敛到 2 格再验`)
        : rep.fail(`多选菜单异常：选区=${selNow.cells.filter((k) => k.sel).length} 格（收敛=${!!fixSel}）rows=${JSON.stringify(mm && mm.rows)}`);
      void tM;
      await clickAt({ x: (await cdpEval(EXPR.viewport)).w - 12, y: (await cdpEval(EXPR.viewport)).h - 12 });
      await sleep(400);
      await clickAt({ x: (await cardProbe('dgc-pdf')).x + 8, y: (await cardProbe('dgc-pdf')).y + 40 });
      await until(async () => { const x = await cardProbe('dgc-pdf'); return x && !x.expanded; }, 4000, 120);
    }

    // ===== P186 · 工单186 粘贴路由三态 + 临时组卡 + 解散回落 ====================
    rep.beginSegment('P186');
    {
      await collapseAll(); // 段首收排：淡出卡 pointer-events:none，不收就会吃掉本段后续点击
      const seeded1 = await seedClipboard([stageFiles[0]]);
      if (!seeded1) { rep.fail('剪贴板播种失败（Set-Clipboard -Path 两次回读核验均未通过——PS 通道环境因素）'); }
      else {
        const zip = await cardProbe('dgc-zip');
        const tP = Date.now();
        await clickAt({ x: zip.x + 8, y: zip.y + zip.h / 2 }, 'right');
        const menu = await until(() => cdpEval(EXPR.menu), 6000, 150);
        const pasteRow = menu && menu.rows.find((r) => r.id === 'paste');
        pasteRow && !pasteRow.disabled
          ? rep.pass(`PASTE 行可用（needs:'pasteable' 读剪贴板实况）：剪贴板里有真文件时使能`)
          : rep.fail(`PASTE 行可用性异常：${JSON.stringify(pasteRow)}`);
        if (menu && menu.rows.length === 1) {
          await clickAt({ x: menu.rect.x + menu.rect.w / 2, y: menu.rect.y + menu.rect.h / 2, w: 2, h: 2 });
          const routed = await tape.wait('doc-group-cards-paste-routed', undefined, { since: tP, timeoutMs: 10000 });
          const landed = await until(() => desktopHas(desktop, 's1.txt'), 10000, 250);
          const tempCard = await until(async () => {
            const cards = await cdpEval(EXPR.cards);
            const t = cards.find((c) => /^dgc-t\d+$/.test(c.id));
            return t || null;
          }, 8000, 250);
          routed && landed && tempCard
            ? rep.pass(`路由态一（固有卡 → 新临时卡）：PASTE 落出临时卡 ${tempCard.id}（${tempCard.cells} 格），文件落桌面根而磁盘未搬动（暂存原样 ${stageFiles[0] ? fs.existsSync(stageFiles[0]) : false}）`)
            : rep.fail(`路由态一异常：routed=${!!routed} 落盘=${!!landed} 临时卡=${JSON.stringify(tempCard)}`);
          const payload = routed && { cardId: routed.cardId, names: routed.names, kind: routed.kind };
          rep.note(`paste-routed 存证：${JSON.stringify(payload)}`);

          // 置灰态：剪贴板清成文本 → PASTE 行仍在但不可用
          clearClipboard();
          await sleep(600);
          const z2 = await cardProbe('dgc-zip');
          await clickAt({ x: z2.x + 8, y: z2.y + z2.h / 2 }, 'right');
          const m2 = await until(() => cdpEval(EXPR.menu), 6000, 150);
          const pr2 = m2 && m2.rows.find((r) => r.id === 'paste');
          pr2 && pr2.disabled
            ? rep.pass(`PASTE 置灰态：剪贴板无文件时该行仍在列但置灰（点了没反应，菜单也不收）`)
            : rep.fail(`PASTE 置灰态异常：${JSON.stringify(pr2)}`);
          // 置灰行点了不收菜单（正是设计如此）→ 必须显式收场，否则下一用例的全屏遮罩会吃掉全部点击
          if (m2) { await clickAt(rowPoint(m2, 'paste')); await sleep(300); }
          await closeMenu();

          // 解散：临时卡消失，文件回落到固有 TXT 卡，磁盘一个字节没动
          const beforeList = desktopList(desktop).slice().sort();
          const temp = await until(async () => {
            const cards = await cdpEval(EXPR.cards);
            const t = cards.find((c) => /^dgc-t\d+$/.test(c.id));
            return t || null;
          }, 4000, 250);
          let dissolved = false;
          /** 临时卡那张菜单实见到的行（拿到块外，红臂信息里要印它） */
          let tempRows = [];
          if (temp) {
            await clickAt({ x: temp.x + 8, y: temp.y + temp.h / 2 }, 'right');
            const tGm = Date.now();
            const gm = await until(() => cdpEval(EXPR.menu), 6000, 150);
            const evGm = await tape.wait('doc-group-cards-menu-opened', undefined, { since: tGm, timeoutMs: 4000 });
            const storeNow = (() => { try { return JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch { return null; } })();
            rep.note(`临时卡开层存证：cardId=${JSON.stringify(evGm && evGm.cardId)} rows=${JSON.stringify(evGm && evGm.rows)}｜磁盘组定义 temps=${JSON.stringify(storeNow && storeNow.groups ? storeNow.groups.temps : null)}`);
            const dis = gm && gm.rows.find((r) => r.id === 'dissolve');
            const rows = gm ? gm.rows : [];
            tempRows = rows;
            if (dis) {
              // DISSOLVE 是「先问过用户」的那一行（工单186：删定义发生在确认**之后**，且磁盘零移动）。
              // 不点掉确认层上的确定，组定义根本没被删——上一轮红臂「dissolved=false / temps 还在」
              // 正是漏了这一步，不是产品没落库。这里按 DELETE 段同款走：开层 → 等确定 → 点确定。
              await clickAt(rowPoint(gm, 'dissolve'));
              const cf = await until(() => cdpEval(EXPR.confirm), 6000, 150);
              rep.note(`DISSOLVE 确认层：${cf ? `在场（文案「${String(cf.text).slice(0, 40)}」）` : '未开'}`);
              if (cf && cf.ok) await clickAt(centerOf(cf.ok));
              dissolved = await until(async () => {
                const cards = await cdpEval(EXPR.cards);
                return !cards.some((c) => c.id === temp.id);
              }, 8000, 200);
            }
            rep.note(`临时卡组卡菜单行：${rows.map((r) => r.id + (r.disabled ? '(灰)' : '')).join(', ')}`);
          }
          const afterList = desktopList(desktop).slice().sort();
          const backInTxt = await until(async () => {
            const c = await cardProbe('dgc-txt');
            return c && c.cells.some((k) => path.basename(k.path) === 's1.txt');
          }, 8000, 300);
          const diskSame = JSON.stringify(beforeList) === JSON.stringify(afterList);
          dissolved && backInTxt && diskSame
            ? rep.pass(`解散回落：临时卡退场，其名下文件回到固有 TXT 卡，磁盘清单前后一致（${afterList.length} 份，${diskSame ? '未动' : '变了'}）——组卡是归属概念不是目录`)
            : rep.fail(`解散回落异常：dissolved=${!!dissolved} 回TXT卡=${!!backInTxt} 磁盘一致=${diskSame} 前=${JSON.stringify(beforeList)} 后=${JSON.stringify(afterList)}｜临时卡菜单行=${JSON.stringify(tempRows.map((r) => r.id + (r.disabled ? '(灰)' : '')))}`);
        }
      }
    }

    // ===== P185 · 工单185 组定义持久化 + 三层归属 ==============================
    rep.beginSegment('P185');
    {
      await collapseAll(); // 段首收排：淡出卡 pointer-events:none，不收就会吃掉本段后续点击
      // 本段仍借一次粘贴落一张临时卡当 NEW GROUP 的入口卡（临时卡是手改得动的卡）——工单187
      // 裁决②之后，固有卡上其实也出 NEW GROUP 了（那一面由 P183 段钉），此处入口卡换个来路
      // 不影响本段要验的东西：组定义落库、归属迁移、取消勾选回落、重启后原样回来。
      const seeded = await seedClipboard([stageFiles[1]]);
      if (!seeded) rep.fail('P185 前置：剪贴板播种失败');
      let gate = await until(async () => {
        const cards = await cdpEval(EXPR.cards);
        return cards.find((c) => /^dgc-t\d+$/.test(c.id) && c.cells >= 1) || null;
      }, 2000, 250);
      if (!gate) {
        const z = await cardProbe('dgc-zip');
        await clickAt({ x: z.x + 8, y: z.y + z.h / 2 }, 'right');
        const m = await until(() => cdpEval(EXPR.menu), 6000, 150);
        // 按行 id 落点，不取菜单正中：裁决②给这张固有卡加了一行 NEW GROUP，两行菜单的正中
        // 恰好落在两行之间，点正中等于掷硬币（上一轮单行时无此问题）
        if (m) { const rp = rowPoint(m, 'paste'); if (rp) await clickAt(rp); }
        await until(() => desktopHas(desktop, 'q1.txt'), 8000, 250);
        gate = await until(async () => {
          const cards = await cdpEval(EXPR.cards);
          return cards.find((c) => /^dgc-t\d+$/.test(c.id) && c.cells >= 1) || null;
        }, 8000, 250);
      }
      rep.note(`NEW GROUP 的入口卡（临时卡，手改得动）：${gate ? gate.id : '(缺)'}`);
      await closeMenu();

      const diskBefore = desktopList(desktop).slice().sort();
      const tNg = Date.now();
      if (gate) {
        // 入口卡必须**临点现取**：粘贴落一张临时卡会让整排重排重居中，gate 是重排前量下的矩形，
        // 拿旧坐标右键会整笔落空——上一轮红臂「组卡菜单行异常：」后面空无一物正是这么来的
        // （空串即 rows=[]，即菜单压根没开），而不是产品少给了行。
        const gLive = await cardProbe(gate.id);
        await clickAt({ x: gLive.x + 8, y: gLive.y + gLive.h / 2 }, 'right');
        const gm = await until(() => cdpEval(EXPR.menu), 6000, 150);
        const rows = gm ? gm.rows : [];
        const ngIdx = rows.findIndex((r) => r.id === 'new-group');
        ngIdx >= 0
          ? rep.pass(`组卡菜单四行齐（手改得动的卡）：${rows.map((r) => r.label).join(' / ')}`)
          : rep.fail(`组卡菜单行异常：右键落在 ${gLive.id} 卡片空白（${Math.round(gLive.x)},${Math.round(gLive.y)} ${Math.round(gLive.w)}×${Math.round(gLive.h)}），菜单${gm ? '开了' : '没开'}，实见行=${JSON.stringify(rows.map((r) => ({ id: r.id, label: r.label, disabled: !!r.disabled })))}，全表卡序=${JSON.stringify((await cdpEval(EXPR.cards)).map((c) => c.id))}，页内错误=${JSON.stringify(await pageErrors())}`);
        if (ngIdx >= 0) {
          await clickAt({ x: gm.rect.x + gm.rect.w / 2, y: gm.rect.y + (ngIdx + 0.5) * (gm.rect.h / rows.length), w: 2, h: 2 });
          const box = await until(() => cdpEval(EXPR.types), 6000, 150);
          const evTypes = await tape.wait('doc-group-cards-types-opened', undefined, { since: tNg, timeoutMs: 4000 });
          box && evTypes
            ? rep.pass(`NEW GROUP 开勾选浮层：#dgc-types 在场（起名框默认值「${box.name}」，类型清单 ${box.rows.length} 行按桌面上真实存在的扩展名逐个列），一个字节都还没落库`)
            : rep.fail(`勾选浮层异常：box=${!!box} event=${!!evTypes}`);
          if (box) {
            // 起名是**必填**：typepicker.js 的 submit 判空后原地报「给这张卡起个名」且不落任何库
            // （产品行为是对的：空名卡建出来无从辨认）。上一轮红臂「建卡异常 custom=null」正是
            // 本段漏敲名字——浮层开了、CREATE 也点了，提交被那条空名校验当场挡下。故先敲名。
            const cardName = `${DESKTOP_PREFIX}grp`;
            if (box.nameRect) await clickAt(centerOf(box.nameRect));
            win32.sendUnicode(cardName);
            await sleep(400);
            const named = await cdpEval(EXPR.types);
            // 勾一个类型（.pdf）后提交：只勾 pdf 这张自定义卡
            const row = named && named.rows.find((r) => r.ext === '.pdf');
            if (row) await clickAt(centerOf(row));
            const box2 = await cdpEval(EXPR.types);
            const okRect = box2 && box2.ok;
            if (okRect) await clickAt(centerOf(okRect));
            await sleep(400);
            // 点完 CREATE 立刻问一句「层还在不在」：提交成功时层当场收起（typepicker 的 submit
            // 走 CLOSED_TYPES），还在就说明这一击没进 reducer——空名校验、或这一击压根没落在钮上。
            // 两条路都是真机轮实测过的岔口（首轮漏敲名字、第二轮名字在框里却仍无落库），故留证。
            const afterCreate = await cdpEval(EXPR.types);
            let viaEnter = false;
            if (afterCreate) {
              rep.note(`CREATE 一击后浮层仍开着：name=${JSON.stringify(afterCreate.name)} 勾选=${JSON.stringify(afterCreate.rows.filter((r) => r.checked).map((r) => r.ext))} 改走起名框回车提交（产品同一条 reducer 路径）`);
              if (afterCreate.nameRect) await clickAt(centerOf(afterCreate.nameRect));
              win32.tapKeys([0x0D]);
              viaEnter = true;
            }
            const saved = await tape.wait('doc-group-cards-groups-saved', undefined, { since: tNg, timeoutMs: 6000 });            const custom = await until(async () => {
              const cards = await cdpEval(EXPR.cards);
              return cards.find((c) => /^dgc-c\d+$/.test(c.id)) || null;
            }, 6000, 250);
            const pdfCard = await cardProbe('dgc-pdf');
            // 工单187 裁决①后的新前提：「空组不占卡」只对固有扩展组成立，故被领空的**固有** PDF 组
            // 应当**退场**（而不是留一张 0 格的卡）。这一条不是把断言放松：它要求自定义卡里的格数
            // **恰好等于桌面上 .pdf 的全量**——「全数迁走」由此被逐份数出来，而旧写法只说剩 0 格。
            const pdfOnDesk = diskBefore.filter((n) => /\.pdf$/i.test(n)).length;
            const migratedAll = !!custom && pdfOnDesk > 0 && custom.cells === pdfOnDesk;
            migratedAll && pdfCard === null && saved
              ? rep.pass(`建卡落库：自定义卡 ${custom.id} 出现（「${custom.title}」），它认领的 .pdf 全数从固有 PDF 卡迁走（卡内 ${custom.cells} 格 = 桌面 .pdf 全量 ${pdfOnDesk} 份；固有 PDF 组此刻一份不剩，按工单187 裁决①「空组不占卡」退场，不再是 0 格留屏），groups-saved 存证在档${viaEnter ? '（CREATE 一击未进 reducer，改走起名框回车提交——两条路是同一条 reducer，见上条留证）' : ''}`)
              : rep.fail(`建卡异常：custom=${JSON.stringify(custom)} 桌面.pdf 全量=${pdfOnDesk} 逐份数齐=${migratedAll} 固有PDF卡=${pdfCard ? `在场（${pdfCard.cellCount} 格）` : '已退场'} saved=${!!saved} 浮层起名框实况=${JSON.stringify(named && named.name)} CREATE钮在场=${!!okRect} 走回车=${viaEnter}｜磁盘组定义=${JSON.stringify((() => { try { const s = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); const g = s.groups || {}; return { custom: g.custom, nextSeq: g.nextSeq }; } catch (e) { return '读不到'; } })())} 页内错误=${JSON.stringify(await pageErrors())}`);
            const diskSame = JSON.stringify(diskBefore) === JSON.stringify(desktopList(desktop).slice().sort());
            diskSame
              ? rep.pass(`全程只改归属不动磁盘：建卡前后桌面清单一致（${diskBefore.length} 份，${diskSame ? '未动' : '变了'}）`)
              : rep.fail(`磁盘被动过：前=${JSON.stringify(diskBefore)} 后=${JSON.stringify(desktopList(desktop).slice().sort())}`);

            // EDIT TYPES：把 .pdf 取消勾 → 归属回落固有卡，磁盘仍不动
            // 自定义卡不存在时**记一条红并跳过**，而不是让 `cst.x` 抛出去把整段后面的用例全带崩
            // （上一轮红臂里电池就是这么在 16:14:59 中止的，后面几条根本没跑到）。
            const cst = (await cdpEval(EXPR.cards)).find((c) => /^dgc-c\d+$/.test(c.id));
            if (!cst) {
              rep.fail('EDIT TYPES 异常：建卡未落库，全表没有 dgc-c* 自定义卡，本用例无从进入');
              await closeMenu();
            } else {
              await clickAt({ x: cst.x + 8, y: cst.y + cst.h / 2 }, 'right');
              const gm2 = await until(() => cdpEval(EXPR.menu), 6000, 150);
              const rows2 = gm2 ? gm2.rows : [];
              const etIdx = rows2.findIndex((r) => r.id === 'edit-types');
              if (etIdx < 0) rep.fail(`EDIT TYPES 异常：菜单未开或缺该行，menu=${!!gm2} rows=${JSON.stringify(rows2.map((r) => r.id))}`);
              if (etIdx >= 0) {
                await clickAt({ x: gm2.rect.x + gm2.rect.w / 2, y: gm2.rect.y + (etIdx + 0.5) * (gm2.rect.h / rows2.length), w: 2, h: 2 });
                const box3 = await until(() => cdpEval(EXPR.types), 6000, 150);
                const prow = box3 && box3.rows.find((r) => r.ext === '.pdf');
                if (prow) await clickAt(centerOf(prow));
                const box4 = box3 && (await cdpEval(EXPR.types));
                if (box4 && box4.ok) await clickAt(centerOf(box4.ok));
                // 存证取 SAVE **之后**那一发 groups-saved（带 t 门槛，否则会捡到粘贴那次更早的）
                const tSave = Date.now();
                const savedEdit = await tape.wait('doc-group-cards-groups-saved', undefined, { since: tSave, timeoutMs: 4000 });
                // 事件行把载荷平铺在顶层（没有 payload 子对象），故去掉 t/type 只留判读字段
                const savedEditView = savedEdit ? JSON.stringify({ ...savedEdit, t: undefined, type: undefined }) : '(无)';
                const pdfBack = await until(async () => { const c = await cardProbe('dgc-pdf'); return c && c.cellCount >= 3; }, 6000, 250);
                // 卡清单里的格数字段叫 **cells**（只有 cardProbe 那份探针才叫 cellCount）。工单187
                // 前两轮这条读的是 cellCount，恒为 undefined —— 于是「自定义卡清空但留屏」这条判据
                // **永远不成立**：红臂红的是电池自己的一处字段名笔误，不是产品（实测落定耗时 3ms，
                // 空卡当下就在屏上）。断言的意图一个字没改，仍是「卡在屏上且恰好 0 格」。
                const cstAfter = (await cdpEval(EXPR.cards)).find((c) => /^dgc-c\d+$/.test(c.id));
                rep.note(`EDIT TYPES 落库存证：${savedEditView}；全表=${JSON.stringify((await cdpEval(EXPR.cards)).map((c) => `${c.id}:${c.cells}`))}`);
                pdfBack && cstAfter && cstAfter.cells === 0
                  ? rep.pass(`EDIT TYPES 迁移归属：取消勾选 .pdf 后文件回落固有 PDF 卡（${pdfBack} 格），自定义卡清空**但留屏**（${cstAfter.cells} 格，工单187 裁决①：0 格卡仍在屏上，EDIT TYPES / DISSOLVE 两条出路回得去）；勾选即归属，磁盘始终不动`)
                  : rep.fail(`EDIT TYPES 异常：固有PDF卡=${pdfBack} 自定义卡余=${cstAfter && cstAfter.cells} 落库存证=${savedEditView} 全表=${JSON.stringify((await cdpEval(EXPR.cards)).map((c) => `${c.id}:${c.cells}`))} 页内错误=${JSON.stringify(await pageErrors())}`);
              }
            const diskSame2 = JSON.stringify(diskBefore) === JSON.stringify(desktopList(desktop).slice().sort());
            rep.note(`EDIT TYPES 后磁盘一致性：${diskSame2}`);

            // 持久化：重启面板后自定义卡连同勾选原样回来（definition 存内核 plugin-config）
            const defsBefore = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, 'utf8') : null;
            // 工单212：定点杀归句柄验证强退（gone=false 即中止信号）；不走 relaunch（同上）
            await stopPanelOrAbort(rep);
            hwnd = await startPanel('组定义重启');
            const restored = await until(async () => {
              const cards = await cdpEval(EXPR.cards);
              return cards.find((c) => /^dgc-c\d+$/.test(c.id)) || null;
            }, 12000, 400);
            const loaded = await tape.wait('doc-group-cards-groups-loaded', null, { timeoutMs: 6000 });
            const pdfAfter = await cardProbe('dgc-pdf');
            restored && loaded && defsBefore
              ? rep.pass(`组定义持久化：面板重启后自定义卡 ${restored.id} 原样回来（groups-loaded 存证在档），归属仍按定义算（固有 PDF 卡 ${pdfAfter ? pdfAfter.cells : '?'} 格）`)
              : rep.fail(`持久化异常：restored=${JSON.stringify(restored)} loaded=${!!loaded} 定义文件=${!!defsBefore}`);
            if (restored) await captureRect(restored, '187-p185-custom');
            } // 自定义卡在场的正常路径到此为止
          }
        }
      }
    }

    // ===== P179B · 工单179 卸载交还（接管与交还是一族失败面，拆段记法同主电池 P9/P9B）===
    rep.beginSegment('P179B');
    {
      const cfgRaw = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, 'utf8') : null;
      rep.note(`轮末自定义卡定义文件字节数=${cfgRaw ? Buffer.byteLength(cfgRaw, 'utf8') : 0}（持久化面见 P185 段）`);
      fs.rmSync(path.join(PLUGIN_ROOT, 'doc-group-cards'), { recursive: true, force: true });
      rep.note('已删私有根里的插件目录（= 投放型的撤回方式：删目录即完全撤回）');
      const unmounted = await until(async () => {
        const m = await cdpEval(EXPR.pluginMounted);
        return m && !m.container;
      }, 15000, 400);
      const zone = await until(async () => {
        const z = await cdpEval(EXPR.docZone);
        return z && z.display !== 'none' && z.ditem > 0 ? z : null;
      }, 12000, 400);
      const cards = await cdpEval(EXPR.cards);
      const hz = lastHotzones();
      const band = hz && (hz.rects || []).find((r) => r.id === 'doc-zone');
      unmounted && zone && cards.length === 0
        ? rep.pass(`卸载交还：插件容器退场，内核文档区原样还原（display=${JSON.stringify(zone.display)}，${zone.ditem} 个 .ditem 回到可见面），组卡一张不剩`)
        : rep.fail(`卸载交还异常：unmounted=${!!unmounted} zone=${JSON.stringify(zone)} 残留组卡=${cards.length}`);
      zone && zone.w > 0 && band && band.w > 24
        ? rep.pass(`残留热区随之退场：文档区恢复可见后 doc-zone 热区回到真实分区矩形（${band.x},${band.y},${band.w},${band.h}），24×24 那圈只剩插件装载期间存在——这正是本条选择「记录并接受」而非「改内核」的实际代价（代价窗口 = 插件在装期间）`)
        : rep.fail(`卸载后热区异常：zone=${JSON.stringify(zone)} band=${JSON.stringify(band)}`);
      // 还原插件私有状态原文件（内核落点是共享 userData，电池不留痕）
      rep.note(`插件私有状态：轮末还原为${cfgBackup ? '备份原文' : '缺位删除'}（${cfgFile}）`);
    }
  } catch (err) {
    rep.fail(`电池异常: ${(err && err.stack) || err}`);
  } finally {
    // 清场纪律（同 49/156）：不留无系统入口的桌面、不留落物、不动共享插件根
    // 工单212：收尾清场归句柄**验证强退**——gone=false 只入环境降责账、**不中止**
    // （清场不掩盖真结局；中止会拦住 finish() → 控制器不退 → 验收槽租约挂死）
    try {
      const cleared = await handle.stop();
      panelPid = 0; panelMap = null;
      if (cleared && cleared.gone === false) {
        rep.exclude(`清场核验：面板强退失败：强杀后有界等待内仍存活（pid=${cleared.pidsLeft.join(', ')}）——需重启清障`,
          '清场后仍有面板进程存活', 'panel-forcekill');
      }
    } catch { /* 尽力 */ }
    // 工单212：证据档 fd 由电池侧关闭（裁决 10 第②条：句柄的 archive 形态不 close fd，
    // 本电池每轮起面板开一次档、三轮共三只 fd，不关则长跑会漏 fd）
    for (const fd of archiveFds.splice(0)) { try { fs.closeSync(fd); } catch { /* 尽力 */ } }
    for (const h of minimizedForRestore.reverse()) {
      try { if (win32.IsWindow(h)) win32.ShowWindow(h, 9); } catch { /* 尽力还原 */ }
    }
    try { win32.moveMousePhys(40, 40); } catch { /* 尽力 */ }
    const desktop = (() => { try { return userDesktop(); } catch { return null; } })();
    if (desktop) { const n = removeFixtures(desktop); rep.note(`桌面落物清理：撤 ${n} 份 ${DESKTOP_PREFIX}* 夹具`); }
    try { fs.rmSync(STAGING, { recursive: true, force: true }); } catch { /* 尽力 */ }
    try { fs.rmSync(PLUGIN_ROOT, { recursive: true, force: true }); } catch { /* 尽力 */ }
    // 插件私有状态：备份原文写回 / 缺位则删（内核 plugin-config 落点是共享 userData，电池不留痕）
    try {
      if (cfgBackup !== null) fs.writeFileSync(cfgFile, cfgBackup, 'utf8');
      else fs.rmSync(cfgFile, { force: true });
    } catch { /* 尽力 */ }
    clearClipboard();
    restoreConfig(configBackup);
    // 共享插件根核验：全程必须一个子目录都没有（常驻自启面板会热加载半成品到真桌面）
    const shared = path.join(process.env.APPDATA || '', 'agent-deck-panel', 'plugins');
    const sharedEntries = fs.existsSync(shared) ? fs.readdirSync(shared) : [];
    sharedEntries.length === 0
      ? rep.note(`共享插件根核验：${shared} 仍为空（${sharedEntries.length} 项）`)
      : rep.fail(`共享插件根被污染：${shared} 下有 ${sharedEntries.join(', ')}——常驻面板会热加载它`);
    const cfgFinal = path.join(app.getPath('userData'), 'plugin-config', 'deck187-probe.json');
    try { fs.rmSync(cfgFinal, { force: true }); } catch { /* 尽力 */ }
    win32.nativeTaskbarVisible()
      ? rep.note('清场核验：原生任务栏可见')
      : rep.note('清场核验：原生任务栏仍隐藏（本电池 taskbar.enabled=false，理应未隐藏）');
  }

  finish();
}

module.exports = main;
