'use strict';
// Agent 会话预览验收（工单381，spec #369 决策 20-24；ADR-0028）：控制器以
// --accept-session-preview 身份运行，拉起 --panel-accept 面板子进程（数据根全部换成本轮
// 合成夹具——DECK_SESSION_PREVIEW_ROOTS，不读也不写用户真实会话存储）。
//   P1 悬停展开与卡片流：悬停 Agent 入口真实注入 → ≥300ms 才展开、气泡在图标上方；
//      四工具固定相对序、组内最近活跃、空工具不占位；真实标题/项目名/短 ID 分列、
//      无标题显示未命名；Qoder CONFIRM=疑似等待、mtime=最近活跃（不冒充执行）；
//      活动卡片单行横向排列；卡片只读（无按钮/无光标）。
//   P2 离场宽限与收起：指针移入气泡不收起；离开后 250ms 仍展开、≥400ms 宽限后收起；
//      Esc 收起。
//   P3 打开期间 1Hz 刷新：generatedAt 与 session-preview-refresh 存证按 ~1000ms 步进。
//   P4 单行横向滚动：卡片数超出窗宽 → scrollWidth > clientWidth、可横向滚动、单行。
//   P5 两桌面可用与只读无直达：普通桌面（未配对高亮）可悬停；配对切到 Agent 桌面后
//      同一入口仍可悬停；点击卡片不产生会话直达/模式动作/其他窗口激活。
//   P6 源存储只读与零残留：夹具全树 sha256+mtime 前后逐字节一致；config 三态还原；
//      切回普通并删除本轮创建的 Agent 桌面（注册表集合与基线相等）；面板退出、不残留窗。
//   P7 五工具同场（工单382）：MiniMax Code 作为第五工具进入同一流——在场工具序是
//      qodercn→zcode→kimicode→minimaxcode→dsh 固定序的子序列（DSH 在验收面板无真实 ACP
//      会话，如实缺席）；MiniMax 真实标题/项目/短 ID、空标题降级未命名、状态只落
//      「最近活跃」（DB status=started 也不冒充执行）；过期会话被过滤；多组仍单行可横向
//      滚动、1Hz 刷新后 MiniMax 卡片不丢。源存储只读由 P6 全树快照覆盖（含 minimax 夹具）。
//
// 运行：npm run accept:session-preview（= electron . --accept-session-preview）。
// **必须经 accept-guard 托管**（AGENTS.md 真机验收调度协议）。
const { app, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const win32 = require('./lib/win32');
const { Report } = require('./lib/report');
const { readConfigRaw, restoreConfig, CONFIG_FILE } = require('./lib/battery-config');
const { cdpPortFor } = require('./lib/registry');
const { createEventTape } = require('./lib/event-tape');
const { createPanelHandle } = require('./lib/panel-control');

const APP_ROOT = path.resolve(__dirname, '..');
const EVENTS_FILE = path.join(__dirname, 'evidence', '381-session-preview-events.jsonl');
const tape = createEventTape(EVENTS_FILE, { defaultTimeoutMs: 8000 });
const handle = createPanelHandle({
  execPath: process.execPath, appRoot: APP_ROOT, eventLogPath: EVENTS_FILE,
  archivePath: path.join(__dirname, 'evidence', '381-session-preview-panel-handle-child.log'),
});
const CDP_PORT = cdpPortFor('381-session-preview');
const TASKBAR_TITLE = 'DECK-TASKBAR';
const BUBBLE_TITLE = 'DECK-SESSION-PREVIEW';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const koffi = win32.koffi;
koffi.load('user32.dll');

// ————————————————————————————————————————————————————————————
// 系统事实源（375/379 同款：注册表单查询原子读 + COM 双源；桌面身份一律系统 ID）
// ————————————————————————————————————————————————————————————
const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VirtualDesktops';
function regBytesToGuid(hex) {
  const b = [];
  for (let i = 0; i + 2 <= hex.length; i += 2) b.push(parseInt(hex.slice(i, i + 2), 16));
  const p = (n) => n.toString(16).padStart(2, '0');
  const swap = (arr) => arr.slice().reverse().map((x) => p(x)).join('');
  if (b.length < 16) return '';
  return `${swap(b.slice(0, 4))}-${swap(b.slice(4, 6))}-${swap(b.slice(6, 8))}-${b.slice(8, 10).map((x) => p(x)).join('')}-${b.slice(10, 16).map((x) => p(x)).join('')}`;
}
function regDesktopFacts() {
  try {
    const out = execFileSync('reg', ['query', REG_KEY], { encoding: 'utf8' });
    const idsM = out.match(/VirtualDesktopIDs\s+REG_BINARY\s+([0-9A-Fa-f]+)/);
    const curM = out.match(/CurrentVirtualDesktop\s+REG_BINARY\s+([0-9A-Fa-f]+)/);
    const hexIds = idsM ? idsM[1].toUpperCase() : '';
    const ids = [];
    for (let off = 0; off + 32 <= hexIds.length; off += 32) ids.push(regBytesToGuid(hexIds.slice(off, off + 32)));
    const cur = curM ? regBytesToGuid(curM[1].toUpperCase()) : '';
    return { count: ids.length, ids: ids.filter(Boolean), current: cur || null };
  } catch { return { count: 0, ids: [], current: null }; }
}

const ole32 = koffi.load('ole32.dll');
koffi.struct('T381_GUID', { d1: 'uint32', d2: 'uint16', d3: 'uint16', d4: 'uint8[8]' });
const CoInitializeEx381 = ole32.func('int32 __stdcall CoInitializeEx(void *reserved, uint32 dwCoInit)');
const CLSIDFromString381 = ole32.func('int32 __stdcall CLSIDFromString(const char16_t *lpsz, _Out_ T381_GUID *clsid)');
const CoCreateInstance381 = ole32.func('int32 __stdcall CoCreateInstance(const T381_GUID *clsid, void *outer, uint32 clsCtx, const T381_GUID *iid, _Out_ void **outObj)');
const PTRSZ381 = koffi.sizeof(koffi.pointer('void'));
const protoRelease381 = koffi.proto('__stdcall', 'T381_Release', 'uint32', ['void *']);
const protoQueryService381 = koffi.proto('__stdcall', 'T381_QueryService', 'int32', ['void *', 'const T381_GUID *', 'const T381_GUID *', koffi.out('void **')]);
const protoGetDesktops381 = koffi.proto('__stdcall', 'T381_VdmiGetDesktops', 'int32', ['void *', koffi.out('void **')]);
const protoGetCurrent381 = koffi.proto('__stdcall', 'T381_VdmiGetCurrent', 'int32', ['void *', koffi.out('void **')]);
const protoSwitch381 = koffi.proto('__stdcall', 'T381_VdmiSwitch', 'int32', ['void *', 'void *']);
const protoCreate381 = koffi.proto('__stdcall', 'T381_VdmiCreate', 'int32', ['void *', koffi.out('void **')]);
const protoRemove381 = koffi.proto('__stdcall', 'T381_Remove', 'int32', ['void *', 'void *', 'void *']);
const protoVdGetId381 = koffi.proto('__stdcall', 'T381_VdGetId', 'int32', ['void *', koffi.out('T381_GUID *')]);
const protoObjArrCount381 = koffi.proto('__stdcall', 'T381_ObjArrCount', 'int32', ['void *', koffi.out('int32 *')]);
const protoObjArrGetAt381 = koffi.proto('__stdcall', 'T381_ObjArrGetAt', 'int32', ['void *', 'int32', 'const T381_GUID *', koffi.out('void **')]);

const CLSID381 = { immersiveShell: 'C2F03A33-21F5-47FA-B4BB-156362A2F239', vdmi: 'C5E0CDCA-7B6E-41B2-9FC4-D93975CC467B', vdm: 'AA509086-5CA9-4C25-8F95-589D3C07B48A' };
const IID381 = { vdmi_24H2: '53F5CA0B-158F-4124-900C-057158060B27', vdm: 'A5CD92FF-29BE-454C-8D04-D82879FB3F1B', virtualDesktop: '3F07F4BE-B107-441A-AF0F-39D82529072C', serviceProvider: '6D5140C1-7436-11CE-8034-00AA006009FA' };

function guidFromStr381(s) {
  const g = [null];
  const hr = CLSIDFromString381('{' + s + '}', g);
  if (hr !== 0) throw new Error(`CLSIDFromString(${s}) 失败 hr=${hr}`);
  return g[0];
}
function comGuidToStr381(q) {
  if (!q || !q.d4) return '';
  const p = (n, w) => n.toString(16).padStart(w, '0');
  const d4 = Array.from({ length: 8 }, (_, i) => q.d4[i]);
  return `${p(q.d1 >>> 0, 8)}-${p(q.d2, 4)}-${p(q.d3, 4)}-${d4.slice(0, 2).map((b) => p(b, 2)).join('')}-${d4.slice(2).map((b) => p(b, 2)).join('')}`;
}
const slot381 = (obj, i) => koffi.decode(koffi.decode(obj, 'void *'), i * PTRSZ381, 'void *');
const release381 = (obj) => { try { if (obj) koffi.call(slot381(obj, 2), protoRelease381, obj); } catch { /* 尽力 */ } };

function bindVdCom381() {
  const hrInit = CoInitializeEx381(null, 0);
  if (hrInit !== 0 && hrInit !== 1 && hrInit !== -2147417850) throw new Error(`CoInitializeEx 失败 hr=${hrInit}`);
  const shell = [null];
  const hrShell = CoCreateInstance381(guidFromStr381(CLSID381.immersiveShell), null, 1 | 4, guidFromStr381(IID381.serviceProvider), shell);
  if (hrShell !== 0 || !shell[0]) throw new Error(`ImmersiveShell 创建失败 hr=${hrShell}`);
  const svc = [null];
  const hrQs = koffi.call(slot381(shell[0], 3), protoQueryService381, shell[0], guidFromStr381(CLSID381.vdmi), guidFromStr381(IID381.vdmi_24H2), svc);
  const pub = [null];
  const hrPub = CoCreateInstance381(guidFromStr381(CLSID381.vdm), null, 1, guidFromStr381(IID381.vdm), pub);
  release381(shell[0]);
  if (hrQs !== 0 || !svc[0]) throw new Error(`IVirtualDesktopManagerInternal 取不到 hr=${hrQs}`);
  if (hrPub !== 0 || !pub[0]) throw new Error(`IVirtualDesktopManager 取不到 hr=${hrPub}`);
  const readDesktopId = (desktop) => {
    const g = [null];
    // IVirtualDesktop.GetId 在 COM vtable 第 5 槽（= slot 4）；376/379 探针同源口径
    const hr = koffi.call(slot381(desktop, 4), protoVdGetId381, desktop, g);
    return hr === 0 ? comGuidToStr381(g[0]) : null;
  };
  return {
    vdmi: svc[0],
    vdm: pub[0],
    listIds() {
      const arr = [null];
      if (koffi.call(slot381(svc[0], 7), protoGetDesktops381, svc[0], arr) !== 0 || !arr[0]) return [];
      const n = [0];
      koffi.call(slot381(arr[0], 3), protoObjArrCount381, arr[0], n);
      const out = [];
      for (let i = 0; i < n[0]; i++) {
        const d = [null];
        if (koffi.call(slot381(arr[0], 4), protoObjArrGetAt381, arr[0], i, guidFromStr381(IID381.virtualDesktop), d) === 0 && d[0]) {
          const id = readDesktopId(d[0]);
          if (id) out.push(id);
          release381(d[0]);
        }
      }
      release381(arr[0]);
      return out;
    },
    currentId() {
      const d = [null];
      if (koffi.call(slot381(svc[0], 6), protoGetCurrent381, svc[0], d) !== 0 || !d[0]) return null;
      const id = readDesktopId(d[0]);
      release381(d[0]);
      return id;
    },
    switchDesktop(id) {
      const arr = [null];
      if (koffi.call(slot381(svc[0], 7), protoGetDesktops381, svc[0], arr) !== 0 || !arr[0]) return false;
      const n = [0];
      koffi.call(slot381(arr[0], 3), protoObjArrCount381, arr[0], n);
      let done = false;
      for (let i = 0; i < n[0]; i++) {
        const d = [null];
        if (koffi.call(slot381(arr[0], 4), protoObjArrGetAt381, arr[0], i, guidFromStr381(IID381.virtualDesktop), d) !== 0 || !d[0]) continue;
        if (readDesktopId(d[0]) === id) {
          koffi.call(slot381(svc[0], 9), protoSwitch381, svc[0], d[0]);
          done = true;
        }
        release381(d[0]);
        if (done) break;
      }
      release381(arr[0]);
      return done;
    },
    removeDesktop(id, fallbackId) {
      const arr = [null];
      if (koffi.call(slot381(svc[0], 7), protoGetDesktops381, svc[0], arr) !== 0 || !arr[0]) return false;
      const n = [0];
      koffi.call(slot381(arr[0], 3), protoObjArrCount381, arr[0], n);
      let desktop = null; let fallback = null;
      for (let i = 0; i < n[0]; i++) {
        const d = [null];
        if (koffi.call(slot381(arr[0], 4), protoObjArrGetAt381, arr[0], i, guidFromStr381(IID381.virtualDesktop), d) !== 0 || !d[0]) continue;
        const did = readDesktopId(d[0]);
        if (did === id) desktop = d[0];
        else if (did === fallbackId) fallback = d[0];
        else release381(d[0]);
      }
      release381(arr[0]);
      if (!desktop) return false;
      const hr = koffi.call(slot381(svc[0], 13), protoRemove381, svc[0], desktop, fallback);
      release381(desktop);
      if (fallback) release381(fallback);
      return hr === 0;
    },
    release() { release381(svc[0]); release381(pub[0]); },
  };
}

async function waitDesktopCurrent381(com, targetId, timeoutMs = 4000) {
  const t0 = Date.now();
  for (;;) {
    const f = regDesktopFacts();
    const internal = com.currentId();
    if (f.current === targetId && (internal === null || internal === targetId)) return { ok: true, ms: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) return { ok: false, ms: Date.now() - t0, detail: `注册表=${f.current} 内部=${internal}` };
    await sleep(60);
  }
}

// ————————————————————————————————————————————————————————————
// CDP 与真实输入（375/378/379 同款）
// ————————————————————————————————————————————————————————————
async function cdpEval(pageTitle, expression) {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
  const target = targets.find((t) => t.title === pageTitle);
  if (!target) throw new Error(`CDP 找不到页面目标: ${pageTitle}（可见目标: ${targets.map((t) => t.title).join('|')}）`);
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
  } finally {
    ws.close();
  }
}

function modeButtonPoint381(geo, tbRect, scale, id) {
  const btn = (geo.modeButtons || []).find((b) => b.id === id);
  if (!btn) return null;
  return {
    x: Math.round(tbRect.left + (btn.x + btn.w / 2) * scale),
    y: Math.round(tbRect.top + (btn.y + btn.h / 2) * scale),
  };
}

// ————————————————————————————————————————————————————————————
// 合成夹具（确定性、零真实会话内容；只存于临时目录）
// ————————————————————————————————————————————————————————————
function snapshotTree(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      const st = fs.statSync(p);
      const h = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
      out.push(`${path.relative(root, p)}|${st.size}|${h}|${st.mtimeMs}`);
    }
  };
  walk(root);
  return out.sort();
}

function makeFixtures() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deck381-fixtures-'));
  const now = Date.now();

  // —— Qoder CN：疑似等待（末条 assistant tool_use）+ 已完成（assistant 文本，应被过滤） ——
  const qdir = path.join(root, 'qoder', 'projects', 'DECK381-alpha');
  fs.mkdirSync(qdir, { recursive: true });
  const writeLines = (file, recs, mtimeMs) => {
    fs.writeFileSync(file, recs.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    const t = new Date(mtimeMs);
    fs.utimesSync(file, t, t);
  };
  writeLines(path.join(qdir, 'sess-q-suspect.jsonl'), [
    { type: 'user', message: { content: [{ type: 'text', text: '跑一下测试' }] }, cwd: 'D:/work/alpha' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] }, cwd: 'D:/work/alpha' },
  ], now - 20_000);
  writeLines(path.join(qdir, 'sess-q-done.jsonl'), [
    { type: 'assistant', message: { content: [{ type: 'text', text: '完成' }] }, cwd: 'D:/work/alpha' },
  ], now - 10_000);

  // —— ZCode：真实标题 / 空标题 / 多条用于横向滚动 ——
  const { DatabaseSync } = require('node:sqlite');
  const zdir = path.join(root, 'zcode', 'cli', 'db');
  fs.mkdirSync(zdir, { recursive: true });
  const db = new DatabaseSync(path.join(zdir, 'db.sqlite'));
  db.exec(`CREATE TABLE session (
    id TEXT PRIMARY KEY, directory TEXT, title TEXT,
    time_created INTEGER, time_updated INTEGER, time_archived INTEGER
  );`);
  const ins = db.prepare('INSERT INTO session (id, directory, title, time_created, time_updated, time_archived) VALUES (?,?,?,?,?,?)');
  const zrows = [
    ['sess-z-fix-001', 'D:/work/zeta', '修复构建脚本', 15_000],
    ['sess-z-blank-002', 'D:/work/eta', '', 40_000],
  ];
  for (let i = 3; i <= 8; i += 1) zrows.push([`sess-z-scroll-00${i}`, 'D:/work/theta', `滚动会话 ${i}`, 40_000 + i * 5_000]);
  for (const [id, directory, title, age] of zrows) {
    const upd = now - age;
    ins.run(id, directory, title, upd - 60_000, upd, null);
  }
  db.close();

  // —— Kimi Code：state.json 真实标题 ——
  const kdir = path.join(root, 'kimicode', 'sessions', 'wd_x', 'kimi-0001');
  fs.mkdirSync(path.join(kdir, 'agents', 'main'), { recursive: true });
  const kstate = path.join(kdir, 'state.json');
  fs.writeFileSync(kstate, JSON.stringify({ createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', title: 'Kimi 计划梳理', workDir: 'D:/work/kappa' }), 'utf8');
  const kt = new Date(now - 25_000);
  fs.utimesSync(kstate, kt, kt);
  const kwire = path.join(kdir, 'agents', 'main', 'wire.jsonl');
  fs.writeFileSync(kwire, '{"type":"config.update"}\n', 'utf8');
  fs.utimesSync(kwire, kt, kt);

  // —— MiniMax Code（工单382 第五工具）：主账本 runtime-state.sqlite ——
  // 真实标题 + 空标题（降级未命名）+ 超出活跃池的过期会话（应被过滤）；
  // titled 行 DB status=started（工单374 证实 status 非执行信号——卡片仍只许「最近活跃」）。
  const mxdir = path.join(root, 'minimax', 'v2', 'sqlite');
  fs.mkdirSync(mxdir, { recursive: true });
  const mxdb = new DatabaseSync(path.join(mxdir, 'runtime-state.sqlite'));
  mxdb.exec(`CREATE TABLE local_runtime_sessions (
    session_id TEXT PRIMARY KEY, updated_at_ms INTEGER, status TEXT, archived INTEGER,
    workspace_dir TEXT, title TEXT
  );`);
  const mxins = mxdb.prepare('INSERT INTO local_runtime_sessions (session_id, updated_at_ms, status, archived, workspace_dir, title) VALUES (?,?,?,?,?,?)');
  const minimaxTitle = 'mvs_aaaaaaaa4f2c4a67b2d9a6c1e8f0d123';
  const minimaxBlank = 'mvs_bbbbbbbb4f2c4a67b2d9a6c1e8f0d456';
  const minimaxStale = 'mvs_cccccccc4f2c4a67b2d9a6c1e8f0d789';
  mxins.run(minimaxTitle, now - 20_000, 'started', 0, 'D:/work/mu', 'MiniMax 真标题');
  mxins.run(minimaxBlank, now - 30_000, 'idle', 0, 'D:/work/nu', '');
  mxins.run(minimaxStale, now - 11 * 60_000, 'idle', 0, 'D:/work/old', '过期会话');
  mxdb.close();

  return {
    root,
    now,
    rootsEnv: {
      qoder: path.join(root, 'qoder'),
      zcode: path.join(root, 'zcode'),
      kimicode: path.join(root, 'kimicode'),
      minimaxcode: path.join(root, 'minimax'),
    },
    expected: {
      qoderId: 'sess-q-suspect',
      zcodeFix: 'sess-z-fix-001',
      zcodeBlank: 'sess-z-blank-002',
      kimiId: 'kimi-0001',
      minimaxTitleId: minimaxTitle,
      minimaxBlankId: minimaxBlank,
      minimaxStaleId: minimaxStale,
    },
  };
}

/** 气泡页用户可见卡片（DOM 事实；只取结构字段，不取用户数据以外内容） */
const CARD_DOM_EXPR = `(() => {
  const cards = [...document.querySelectorAll('.sp-card')].map((el) => {
    const t = el.querySelector('.sp-title');
    const p = el.querySelector('.sp-project');
    return {
      tool: el.dataset.tool || '',
      id: el.dataset.id || '',
      status: el.dataset.status || '',
      readonly: el.dataset.readonly === 'true',
      title: t ? t.textContent : '',
      unnamed: !!(t && t.dataset.titleMissing === 'true'),
      project: p ? p.textContent : '',
      projectMissing: !!(p && p.dataset.projectMissing === 'true'),
      shortId: el.querySelector('.sp-id') ? el.querySelector('.sp-id').textContent : '',
    };
  });
  const stream = document.querySelector('#sp-stream');
  const bubble = document.querySelector('#sp-bubble');
  const rects = cards.map((_, i) => document.querySelectorAll('.sp-card')[i].getBoundingClientRect());
  return {
    hidden: !!bubble.hidden,
    cards,
    flexWrap: stream ? getComputedStyle(stream).flexWrap : '',
    dataReadonly: stream ? stream.dataset.readonly : '',
    scrollWidth: stream ? stream.scrollWidth : 0,
    clientWidth: stream ? stream.clientWidth : 0,
    scrollLeft: stream ? stream.scrollLeft : 0,
    tops: [...new Set(rects.map((r) => Math.round(r.top)))],
    bubbleRect: bubble ? (() => { const r = bubble.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })() : null,
    buttons: document.querySelectorAll('.sp-card button, .sp-card [role="button"], .sp-card a').length,
  };
})()`;

const SCROLL_EXPR = `(() => {
  const s = document.querySelector('#sp-stream');
  if (!s) return null;
  const before = s.scrollLeft;
  s.scrollLeft = 260;
  return { before, after: s.scrollLeft, scrollWidth: s.scrollWidth, clientWidth: s.clientWidth };
})()`;

// ————————————————————————————————————————————————————————————
// 主流程
// ————————————————————————————————————————————————————————————
async function main() {
  const rep = new Report('381-session-preview');
  const originalConfig = readConfigRaw();
  let fixtures = null;
  let beforeTree = null;
  let base = null;
  let normalId = null;
  let agentId = null;
  let com = null;

  const finish = () => {
    const v = rep.verdict(rep.fails === 0 ? 'PASS' : 'FAIL');
    rep.writeLedger();
    app.exit(v.fails === 0 ? 0 : 1);
  };

  try {
    fs.writeFileSync(EVENTS_FILE, '', 'utf8');
    fixtures = makeFixtures();
    beforeTree = snapshotTree(fixtures.root);
    rep.note(`夹具根=${fixtures.root}（qodercn 2 会话 / zcode 8 会话 / kimicode 1 会话 / minimaxcode 3 会话；全部合成）`);

    {
      const json = originalConfig !== null ? JSON.parse(originalConfig) : {};
      json.agentDesktop = { ...(json.agentDesktop ?? {}), enabled: true, normalDesktopId: '', agentDesktopId: '' };
      json.taskbar = { ...(json.taskbar ?? {}), enabled: true };
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(json, null, 2) + '\n', 'utf8');
    }
    com = bindVdCom381();
    base = regDesktopFacts();
    normalId = base.current;
    rep.note(`基线桌面：${base.count} 个，当前=${normalId ? normalId.slice(0, 8) : 'null'}`);
    if (!base.count || !normalId) throw new Error('注册表桌面事实不可读——环境问题，本轮未取证');

    handle.launch({
      mode: 'accept', cdpPort: CDP_PORT, stdio: 'ignore',
      extraEnv: { DECK_SESSION_PREVIEW_ROOTS: JSON.stringify(fixtures.rootsEnv) },
    });
    const boot = await tape.wait('boot', null, { timeoutMs: 15000 });
    if (!boot) throw new Error('面板子进程未上报 boot 事件');
    rep.note(`面板 pid=${boot.pid}`);
    const tbHwnd = await handle.waitWindow({ title: TASKBAR_TITLE, timeoutMs: 12000 });
    if (!tbHwnd) throw new Error('任务栏窗口未出现');
    const tbRect = win32.rectOf(tbHwnd);
    const dip = screen.getPrimaryDisplay().bounds;
    const scale = (tbRect.right - tbRect.left) / dip.width;
    const hasModeButtons = (e) => e.modePill && Array.isArray(e.modeButtons) && e.modeButtons.length >= 2;
    const ready = await tape.wait('taskbar-geometry', hasModeButtons, { timeoutMs: 12000 });
    if (!ready) throw new Error('taskbar-geometry 存证缺失模式组矩形');
    const latestGeo = () => tape.latest('taskbar-geometry', hasModeButtons) || ready;
    const agentPt = () => modeButtonPoint381(latestGeo(), tbRect, scale, 'agent');
    // 中性点：主屏中上部（不在条带窗/气泡的任何区域）
    const neutral = { x: Math.round((dip.width / 2) * scale), y: Math.round((dip.height / 4) * scale) };
    const park = async (ms = 500) => { win32.moveMousePhys(neutral.x, neutral.y); await sleep(ms); };
    const bubbleState = () => cdpEval(BUBBLE_TITLE, `window.deck.bridge.invoke('session-preview/get-state', null)`);
    const bubbleDom = () => cdpEval(BUBBLE_TITLE, CARD_DOM_EXPR);
    const hoverAgent = async () => {
      const pt = agentPt();
      if (!pt) throw new Error('Agent 模式按钮几何缺位');
      win32.moveMousePhys(pt.x, pt.y);
      return pt;
    };
    const pressEsc = () => win32.send([win32.keyInput(0x1b, win32.KEYDOWN), win32.keyInput(0x1b, win32.KEYUP)]);
    /** 真实点击 Agent 入口：先等热区跟踪器把穿透翻过来（windowFromPoint 命中条带窗）再落点击，
     *  否则点击会穿透到条带下方的窗口（375/379 电池同款收敛纪律）。 */
    const clickAgent = async () => {
      const pt = agentPt();
      if (!pt) throw new Error('Agent 模式按钮几何缺位');
      win32.moveMousePhys(pt.x, pt.y);
      for (let i = 0; i < 40; i++) {
        await sleep(100);
        if (win32.windowFromPointRoot(pt) === tbHwnd) break;
      }
      await sleep(150);
      win32.clickPhys(pt.x, pt.y, 'left');
      return pt;
    };
    /** 每段测量前把气泡清回关闭态：面板启动时若光标恰在 Agent 入口上会先展开一次，
     *  不先收掉会让「本次悬停 → 新 shown 存证」的判据拿到陈旧现场。 */
    const ensureClosed = async (label) => {
      let st = null;
      try { st = await bubbleState(); } catch { /* 页面未就绪：按关闭处置 */ }
      if (st && st.open) {
        pressEsc();
        await tape.wait('session-preview-window-hidden', null, { timeoutMs: 3000 });
        rep.note(`${label} 前置：气泡已展开（面板启动时的存量悬停），按 Esc 收掉`);
      }
      await park(600);
    };

    // —— P1 悬停展开与卡片流（决策 22/23/24）——
    rep.beginSegment('P1');
    let p1Open = false;
    try {
      const agentWindow = await tape.wait('session-preview-window-created', null, { timeoutMs: 12000 });
      rep.note(`气泡承载窗创建=${agentWindow ? '是' : '否（探测 pending）'}`);
      await ensureClosed('P1');
      const t0 = Date.now();
      const pt = await hoverAgent();
      const shown = await tape.wait('session-preview-window-shown', null, { timeoutMs: 5000, since: t0 });
      const latency = shown ? shown.t - t0 : null;
      const hiddenBefore = (await tape.latest('session-preview-window-hidden', null, { since: t0 })) === null;
      rep.note(`P1 悬停点=${JSON.stringify(pt)} 展开时延=${latency}ms（未先收起=${hiddenBefore}）`);
      if (!shown) throw new Error('悬停 5s 内未见 session-preview-window-shown 存证');
      const bubbleHwnd = await handle.waitWindow({ title: BUBBLE_TITLE, timeoutMs: 5000 });
      const bubbleRect = bubbleHwnd ? win32.rectOf(bubbleHwnd) : null;
      const dom = await bubbleDom();
      const state = await bubbleState();
      const cards = dom.cards;
      const byId = new Map(cards.map((c) => [c.id, c]));
      const toolOrder = state.groups.map((g) => g.tool);
      const expectedPrefix = ['qodercn', 'zcode', 'kimicode'];
      const orderOk = expectedPrefix.every((t, i) => toolOrder[i] === t);
      const noEmptyGroup = state.groups.every((g) => g.cards.length > 0);
      const qoderCard = byId.get(fixtures.expected.qoderId);
      const fixCard = byId.get(fixtures.expected.zcodeFix);
      const blankCard = byId.get(fixtures.expected.zcodeBlank);
      const kimiCard = byId.get(fixtures.expected.kimiId);
      const qoderDoneFiltered = !cards.some((c) => c.id === 'sess-q-done');
      const statusOk = qoderCard && qoderCard.status === 'suspected-waiting'
        && fixCard && fixCard.status === 'active'
        && kimiCard && kimiCard.status === 'active';
      const titlesOk = fixCard && fixCard.title === '修复构建脚本'
        && kimiCard && kimiCard.title === 'Kimi 计划梳理'
        && qoderCard && qoderCard.unnamed && qoderCard.title === '未命名会话'
        && blankCard && blankCard.unnamed;
      const columnsOk = fixCard && fixCard.project === 'zeta' && fixCard.shortId === 'sess-z-f'
        && kimiCard && kimiCard.project === 'kappa' && kimiCard.shortId === 'kimi-000'
        && qoderCard && qoderCard.project === 'alpha' && qoderCard.shortId === 'sess-q-s';
      const readOnly = dom.hidden === false && dom.dataReadonly === 'true'
        && cards.every((c) => c.readonly) && dom.buttons === 0;
      const singleRow = dom.flexWrap === 'nowrap' && dom.tops.length === 1;
      const aboveBar = bubbleRect
        ? bubbleRect.bottom <= tbRect.top + Math.round(4 * scale) && bubbleRect.top < tbRect.top
        : false;
      const overIcon = bubbleRect ? pt.x >= bubbleRect.left && pt.x <= bubbleRect.right : false;
      const latencyOk = typeof latency === 'number' && latency >= 290 && latency <= 4000;
      rep.note(`P1 卡片=${JSON.stringify(cards.map((c) => ({ t: c.tool, id: c.id, s: c.status, n: c.unnamed })))} 窗口=${JSON.stringify(bubbleRect)} 条带=${JSON.stringify(tbRect)}`);

      if (latencyOk && hiddenBefore && orderOk && noEmptyGroup && qoderDoneFiltered && statusOk && titlesOk && columnsOk && readOnly && singleRow && aboveBar && overIcon) {
        rep.pass(`P1 悬停展开与卡片流：真实注入悬停 Agent 入口后 ${latency}ms 展开（≥300ms 阈值，未提前触发）；气泡位于条带上沿之上且覆盖悬停点（${JSON.stringify(bubbleRect)}）；工具相对序 ${toolOrder.join('→')}、组内按最近活跃、空工具不占位；Qoder 疑似等待 / mtime 最近活跃（不冒充执行）、完成会话被过滤；标题分列（${fixCard.title} / ${kimiCard.title}）、无标题显示未命名；项目与短 ID 分列（zeta/sess-z-f、kappa/kimi-000）；卡片单行 nowrap、只读无按钮`);
        p1Open = true;
      } else {
        rep.fail(`P1 时延=${latency}(${latencyOk}) 先收起=${hiddenBefore} 序=${toolOrder.join(',')}(${orderOk}) 空组=${noEmptyGroup} 完成过滤=${qoderDoneFiltered} 状态=${statusOk} 标题=${titlesOk} 分列=${columnsOk} 只读=${readOnly} 单行=${singleRow}/${JSON.stringify(dom.tops)} 条带上方=${aboveBar} 覆盖悬停点=${overIcon} 气泡=${JSON.stringify(bubbleRect)} 条带=${JSON.stringify(tbRect)}`);
      }
    } catch (err) { rep.fail(`P1 异常: ${err && err.stack || err}`); }

    // —— P2 离场宽限与收起（决策 24）——
    rep.beginSegment('P2');
    try {
      if (!p1Open) {
        // P1 未成展开态：本段仍按独立事实取一次展开（失败连带给判定）
        await ensureClosed('P2');
        await hoverAgent();
        await tape.wait('session-preview-window-shown', null, { timeoutMs: 5000 });
      }
      const domOpen = await bubbleDom();
      const bubbleHwnd = await handle.waitWindow({ title: BUBBLE_TITLE, timeoutMs: 5000 });
      const brect = bubbleHwnd ? win32.rectOf(bubbleHwnd) : null;
      // ① 指针移入气泡：不收起（400ms 宽限的实际目的）
      if (brect) win32.moveMousePhys(Math.round((brect.left + brect.right) / 2), Math.round((brect.top + brect.bottom) / 2));
      await sleep(900);
      const stay = await bubbleDom();
      const closedWhileInside = (await tape.latest('session-preview-window-hidden', null, { since: Date.now() - 900 })) !== null;

      // ② 离开到中性点：250ms 仍展开；400ms 宽限后收起
      const tLeave = Date.now();
      win32.moveMousePhys(neutral.x, neutral.y);
      await sleep(250);
      const stillOpen250 = !(await bubbleDom()).hidden;
      const hideEv = await tape.wait('session-preview-window-hidden', (e) => e.reason === 'grace', { timeoutMs: 3000, since: tLeave });
      const graceMs = hideEv ? hideEv.t - tLeave : null;
      const graceOk = typeof graceMs === 'number' && graceMs >= 380 && graceMs <= 2000;

      // ③ Esc 收起（重新展开后真实按键；主进程 before-input-event 兜底）
      await ensureClosed('P2-esc');
      const tEsc0 = Date.now();
      await hoverAgent();
      await tape.wait('session-preview-window-shown', null, { timeoutMs: 5000, since: tEsc0 });
      await sleep(150);
      win32.send([win32.keyInput(0x1b, win32.KEYDOWN), win32.keyInput(0x1b, win32.KEYUP)]);
      const escEv = await tape.wait('session-preview-window-hidden', (e) => e.reason === 'esc' || e.reason === 'esc-key' || e.reason === 'esc-global', { timeoutMs: 3000, since: tEsc0 });

      if (!domOpen.hidden && !closedWhileInside && stillOpen250 && graceOk && escEv) {
        rep.pass(`P2 离场宽限与收起：指针移入气泡 900ms 不收起（无 hidden 存证）；离开后 250ms 仍展开、${graceMs}ms 后按 400ms 宽限收起（≥380ms）；Esc 真实按键收起（reason=${escEv.reason}）`);
      } else {
        rep.fail(`P2 展开=${!domOpen.hidden} 移入不收起=${!closedWhileInside} 250ms仍开=${stillOpen250} 宽限=${graceMs}(${graceOk}) Esc=${escEv ? escEv.reason : 'null'}`);
      }
    } catch (err) { rep.fail(`P2 异常: ${err.message}`); }

    // —— P3 打开期间 1Hz 刷新（决策 24/27）——
    rep.beginSegment('P3');
    try {
      await ensureClosed('P3');
      const tP3 = Date.now();
      await hoverAgent();
      await tape.wait('session-preview-window-shown', null, { timeoutMs: 5000, since: tP3 });
      const a = await bubbleState();
      await sleep(1150);
      const b = await bubbleState();
      await sleep(1150);
      const c = await bubbleState();
      const d1 = b.generatedAt - a.generatedAt;
      const d2 = c.generatedAt - b.generatedAt;
      const refreshes = tape.all('session-preview-refresh', null, { since: tP3 }).map((e) => e.t);
      const gaps = refreshes.slice(1).map((t, i) => t - refreshes[i]);
      const cadenceOk = d1 >= 900 && d1 <= 1400 && d2 >= 900 && d2 <= 1400;
      const eventCadenceOk = gaps.length >= 1 && gaps.every((g) => g >= 900 && g <= 1400);
      if (cadenceOk && eventCadenceOk) {
        rep.pass(`P3 打开期间 1Hz 刷新：generatedAt 步进 ${d1}ms / ${d2}ms；存证 session-preview-refresh 间隔 ${gaps.map((g) => `${g}ms`).join(' / ')}（均在 900–1400ms 带内）——静止画面不高于 1Hz`);
      } else {
        rep.fail(`P3 generatedAt 步进=${d1}/${d2} 刷新存证间隔=${JSON.stringify(gaps)}（cadenceOk=${cadenceOk} eventCadenceOk=${eventCadenceOk}）`);
      }
    } catch (err) { rep.fail(`P3 异常: ${err.message}`); }

    // —— P4 单行横向滚动（决策 24）——
    rep.beginSegment('P4');
    try {
      const dom = await bubbleDom();
      const scroll = await cdpEval(BUBBLE_TITLE, SCROLL_EXPR);
      const overflows = scroll && scroll.scrollWidth > scroll.clientWidth;
      const scrolled = scroll && scroll.after > 0 && scroll.after <= 260;
      const singleRow = dom.flexWrap === 'nowrap' && dom.tops.length === 1;
      const capped = dom.bubbleRect && dom.bubbleRect.w <= 1000;
      if (!dom.hidden && overflows && scrolled && singleRow && capped) {
        rep.pass(`P4 活动卡片单行横向滚动：${dom.cards.length} 张卡片宽 ${scroll.scrollWidth} > 可视 ${scroll.clientWidth}；scrollLeft 0→${scroll.after}；flex-wrap=${dom.flexWrap}、全部卡片同一行（top 集合 ${JSON.stringify(dom.tops)}）；气泡宽 ${dom.bubbleRect.w} ≤ 1000`);
      } else {
        rep.fail(`P4 展开=${!dom.hidden} 溢出=${overflows} 滚动=${JSON.stringify(scroll)} 单行=${singleRow}/${JSON.stringify(dom.tops)} 宽=${dom.bubbleRect && dom.bubbleRect.w}`);
      }
      // 滚动复位（P5 要点可见卡片）；随后收起气泡进入桌面臂
      await cdpEval(BUBBLE_TITLE, `(() => { const s = document.querySelector('#sp-stream'); if (s) s.scrollLeft = 0; return s ? s.scrollLeft : null; })()`);
      win32.send([win32.keyInput(0x1b, win32.KEYDOWN), win32.keyInput(0x1b, win32.KEYUP)]);
      await sleep(400);
    } catch (err) { rep.fail(`P4 异常: ${err.message}`); }

    // —— P5 普通/Agent 两桌面可用与只读无直达（决策 24 + 用户故事 57/69）——
    rep.beginSegment('P5');
    try {
      await ensureClosed('P5-normal');
      const wsNormal = await cdpEval(BUBBLE_TITLE, `window.deck.bridge.invoke('workspace/get-state', null)`);
      // 普通桌面（未配对/当前非 agent 高亮）悬停仍可展开
      const tNormal = Date.now();
      await hoverAgent();
      const shownNormal = await tape.wait('session-preview-window-shown', null, { timeoutMs: 5000, since: tNormal });
      const stateNormal = await bubbleState();
      const normalOk = normalId !== null && wsNormal.current !== 'agent' && shownNormal && stateNormal.open;

      // 只读无直达：点击卡片中心 → 不产生会话直达、不触发模式动作、不激活其他窗口
      const domBefore = await bubbleDom();
      const bubbleHwnd = await handle.waitWindow({ title: BUBBLE_TITLE, timeoutMs: 5000 });
      const brect = bubbleHwnd ? win32.rectOf(bubbleHwnd) : null;
      const fgBefore = win32.GetForegroundWindow();
      const clickEvtSince = Date.now();
      let clickPoint = null;
      if (brect) {
        // CDP 矩形是 CSS/DIP；窗口矩形是物理 px —— 必须按缩放换算后再注入
        // 取第一张**完整可见**的卡片（横向滚动后首张可能已移出视口——点它会落在窗外）
        const cardEl = await cdpEval(BUBBLE_TITLE, `(() => { const b = document.querySelector('#sp-bubble').getBoundingClientRect(); const cards = [...document.querySelectorAll('.sp-card')]; const el = cards.find((c) => { const r = c.getBoundingClientRect(); return r.x >= b.x && r.right <= b.x + b.width && r.width > 0; }); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + b.x, y: r.y + b.y, w: r.width, h: r.height, bx: b.x, by: b.y, bw: b.width, bh: b.height, vw: window.innerWidth, vh: window.innerHeight, id: el.dataset.id }; })()`);
        if (cardEl) {
          clickPoint = { x: Math.round(brect.left + (cardEl.x + cardEl.w / 2) * scale), y: Math.round(brect.top + (cardEl.y + cardEl.h / 2) * scale) };
          win32.clickPhys(clickPoint.x, clickPoint.y, 'left');
        }
        rep.note(`P5 只读点：气泡=${JSON.stringify(brect)} 缩放=${scale} 卡片=${JSON.stringify(cardEl)} 落点=${JSON.stringify(clickPoint)}`);
      }
      await sleep(500);
      const fgAfter = win32.GetForegroundWindow();
      const afterDom = await bubbleDom();
      const directEvents = tape.all('session-focus-action', null, { since: clickEvtSince })
        .concat(tape.all('session-focus-result', null, { since: clickEvtSince }))
        .concat(tape.all('taskbar-mode-action', null, { since: clickEvtSince }))
        .concat(tape.all('conversation-create', null, { since: clickEvtSince }));
      // 点击卡片后前台只允许保持原样或落到气泡自身（取焦），绝不激活别的窗口/工具
      const fgOk = fgAfter === fgBefore || fgAfter === bubbleHwnd;
      const readOnlyOk = !domBefore.hidden && afterDom.hidden === false && directEvents.length === 0 && fgOk;

      // Agent 桌面臂：点 Agent 入口配对并切换 → 同一入口仍可悬停
      win32.send([win32.keyInput(0x1b, win32.KEYDOWN), win32.keyInput(0x1b, win32.KEYUP)]);
      await sleep(300);
      const readAgentId = () => {
        try {
          return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))?.agentDesktop?.agentDesktopId || null;
        } catch { return null; }
      };
      await clickAgent();
      for (let i = 0; i < 20 && !agentId; i++) {
        await sleep(250);
        agentId = readAgentId();
      }
      if (!agentId) {
        // 首次点击可能被前一段的悬停/收起时序吞掉——重试一次真实点击
        await clickAgent();
        for (let i = 0; i < 20 && !agentId; i++) {
          await sleep(250);
          agentId = readAgentId();
        }
      }
      const switched = agentId ? await waitDesktopCurrent381(com, agentId, 6000) : { ok: false, detail: 'config 无 agentDesktopId' };
      await ensureClosed('P5-agent');
      const tAgent = Date.now();
      await hoverAgent();
      const shownAgent = await tape.wait('session-preview-window-shown', null, { timeoutMs: 5000, since: tAgent });
      const stateAgent = await bubbleState();
      const agentOk = switched.ok && shownAgent && stateAgent.open && stateAgent.groups.length > 0;
      // 收起气泡，避免残留态干扰收尾
      win32.send([win32.keyInput(0x1b, win32.KEYDOWN), win32.keyInput(0x1b, win32.KEYUP)]);
      await sleep(300);

      if (normalOk && readOnlyOk && agentOk) {
        rep.pass(`P5 两桌面可用与只读无直达：普通桌面（current=${wsNormal.current}）悬停展开；点击卡片无会话直达/模式动作/会话创建存证、前台保持原样或气泡自取焦（0x${Number(fgBefore).toString(16)}→0x${Number(fgAfter).toString(16)}，气泡=0x${Number(bubbleHwnd).toString(16)}）、气泡保持展开；切到 Agent 桌面（${agentId ? agentId.slice(0, 8) : 'null'}…，确认 ${switched.ms}ms）后同一入口悬停仍展开`);
      } else {
        rep.fail(`P5 普通臂=${normalOk}（current=${wsNormal.current} 展开=${!!shownNormal}） 只读=${readOnlyOk}（hidden=${domBefore.hidden}/${afterDom.hidden} 直达事件=${directEvents.length} 前台 0x${Number(fgBefore).toString(16)}→0x${Number(fgAfter).toString(16)} 气泡=0x${Number(bubbleHwnd).toString(16)}） Agent 臂=${agentOk}（切换=${JSON.stringify(switched)} 展开=${!!shownAgent} 组=${stateAgent && stateAgent.groups.length}）`);
      }
    } catch (err) { rep.fail(`P5 异常: ${err.message}`); }

    // —— P7 五工具同场：MiniMax Code 第五工具（工单382，spec 决策 21/22/23）——
    rep.beginSegment('P7');
    try {
      await ensureClosed('P7');
      const t7 = Date.now();
      await hoverAgent();
      const shown7 = await tape.wait('session-preview-window-shown', null, { timeoutMs: 5000, since: t7 });
      if (!shown7) throw new Error('悬停 5s 内未见 session-preview-window-shown 存证');
      const state7 = await bubbleState();
      const dom7 = await bubbleDom();
      const cards7 = dom7.cards;
      const byId7 = new Map(cards7.map((c) => [c.id, c]));
      const order = state7.groups.map((g) => g.tool);
      const fixed = ['qodercn', 'zcode', 'kimicode', 'minimaxcode', 'dsh'];
      // 在场工具必须是固定序的**子序列**：只有真实有会话的工具占位（dsh 在验收面板无真实
      // ACP 会话，如实缺席；它若在场，顺序仍须落在固定序上）
      const idx = order.map((t) => fixed.indexOf(t));
      const orderOk = idx.length > 0 && idx.every((v, i) => v >= 0 && (i === 0 || v > idx[i - 1]));
      const minimaxIn = order.includes('minimaxcode');
      const noEmptyGroup = state7.groups.every((g) => g.cards.length > 0);
      const titled = byId7.get(fixtures.expected.minimaxTitleId);
      const blank = byId7.get(fixtures.expected.minimaxBlankId);
      const staleFiltered = !cards7.some((c) => c.id === fixtures.expected.minimaxStaleId);
      const titleOk = titled && titled.tool === 'minimaxcode' && titled.title === 'MiniMax 真标题'
        && titled.project === 'mu' && titled.shortId === 'mvs_aaaa';
      const blankOk = blank && blank.unnamed && blank.title === '未命名会话';
      // 诚实：MiniMax 卡片只许「最近活跃」——DB status=started 也不得冒充执行/等待
      const honest = !!titled && !!blank
        && titled.status === 'active' && blank.status === 'active'
        && ![titled, blank].some((c) => c.status === 'running' || c.status === 'waiting' || c.status === 'suspected-waiting');
      const minimaxCards = cards7.filter((c) => c.tool === 'minimaxcode');
      const minimaxCount = minimaxCards.length === 2;
      const singleRow = dom7.flexWrap === 'nowrap' && dom7.tops.length === 1;
      const scroll = await cdpEval(BUBBLE_TITLE, SCROLL_EXPR);
      const scrollOk = !!(scroll && scroll.scrollWidth > scroll.clientWidth && scroll.after > 0);
      // 五工具同场下 1Hz 刷新仍成立，且刷新后 MiniMax 卡片未丢失（第五工具不打断既有刷新）
      const g0 = (await bubbleState()).generatedAt;
      await sleep(1150);
      const stateAfter = await bubbleState();
      const domAfter = await bubbleDom();
      const dRefresh = stateAfter.generatedAt - g0;
      const refreshOk = dRefresh >= 900 && dRefresh <= 1400;
      const minimaxAfter = domAfter.cards.some((c) => c.id === fixtures.expected.minimaxTitleId)
        && stateAfter.groups.some((g) => g.tool === 'minimaxcode');
      rep.note(`P7 工具序=${order.join('→')}（固定序子序列=${orderOk}，dsh 在场=${order.includes('dsh')}） MiniMax 卡片=${JSON.stringify([titled, blank].map((c) => c && ({ id: c.id, s: c.status, u: c.unnamed, t: c.title })))} 刷新步进=${dRefresh}ms`);

      if (shown7 && minimaxIn && orderOk && noEmptyGroup && titleOk && blankOk && honest && minimaxCount && staleFiltered && singleRow && scrollOk && refreshOk && minimaxAfter) {
        rep.pass(`P7 五工具同场：MiniMax Code 真实进入悬浮卡片流——在场工具序 ${order.join('→')} 落在固定序子序列上（dsh 无真实 ACP 会话如实缺席）、空工具不占位；真实标题/项目/短 ID 分列（MiniMax 真标题 / mu / mvs_aaaa）、空标题显示未命名、过期（11 分钟）会话被过滤；DB status=started 的会话仍只显示「最近活跃」，不伪造执行/等待；${cards7.length} 张卡片单行、可横向滚动、1Hz 刷新 ${dRefresh}ms 后 MiniMax 卡片在位`);
      } else {
        rep.fail(`P7 展开=${!!shown7} MiniMax在场=${minimaxIn} 序=${order.join(',')}(${orderOk}) 空组=${noEmptyGroup} 标题=${titleOk} 未命名=${blankOk} 诚实=${honest} 卡片数=${minimaxCards.length}(${minimaxCount}) 过期过滤=${staleFiltered} 单行=${singleRow} 滚动=${JSON.stringify(scroll)}(${scrollOk}) 刷新=${dRefresh}(${refreshOk}) 刷新后在场=${minimaxAfter}`);
      }
      win32.send([win32.keyInput(0x1b, win32.KEYDOWN), win32.keyInput(0x1b, win32.KEYUP)]);
      await sleep(300);
    } catch (err) { rep.fail(`P7 异常: ${err && err.stack || err}`); }
  } catch (err) {
    rep.fail(`电池异常: ${err && err.stack || err}`);
  } finally {
    // —— P6 源存储只读与零残留 ——
    rep.beginSegment('P6');
    try {
      // ① 源存储只读：夹具全树 sha256+mtime 前后逐字节一致
      const afterTree = fixtures ? snapshotTree(fixtures.root) : [];
      const treeOk = beforeTree !== null && afterTree.length === beforeTree.length && afterTree.every((x, i) => x === beforeTree[i]);

      // ② 收尾：切回普通 → 删除本轮创建的 Agent 桌面 → 注册表集合与基线相等
      const cfgNow = (() => { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return null; } })();
      const agentIdNow = cfgNow?.agentDesktop?.agentDesktopId || agentId || null;
      const normalIdNow = cfgNow?.agentDesktop?.normalDesktopId || normalId || null;
      if (agentIdNow && com) {
        const f0 = regDesktopFacts();
        if (f0.current === agentIdNow && normalIdNow) {
          com.switchDesktop(normalIdNow);
          await waitDesktopCurrent381(com, normalIdNow, 3000);
        }
        try { com.removeDesktop(agentIdNow, normalIdNow ?? undefined); } catch (e) { rep.note(`P6 RemoveDesktop 异常（热键兜底前记录）：${e.message}`); }
      }
      for (let guard = 0; guard < 6; guard++) {
        const f = regDesktopFacts();
        if (f.count <= (base ? base.count : f.count)) break;
        const extra = f.ids.filter((x) => !base.ids.includes(x));
        if (!extra.length) break;
        if (extra.includes(f.current)) {
          win32.send([
            win32.keyInput(0x5b, win32.KEYDOWN), win32.keyInput(0xa2, win32.KEYDOWN),
            win32.keyInput(0x73, win32.KEYDOWN), win32.keyInput(0x73, win32.KEYUP),
            win32.keyInput(0xa2, win32.KEYUP), win32.keyInput(0x5b, win32.KEYUP),
          ]);
          await sleep(700);
        } else {
          win32.send([
            win32.keyInput(0x5b, win32.KEYDOWN), win32.keyInput(0xa2, win32.KEYDOWN),
            win32.keyInput(0x25, win32.KEYDOWN), win32.keyInput(0x25, win32.KEYUP),
            win32.keyInput(0xa2, win32.KEYUP), win32.keyInput(0x5b, win32.KEYUP),
          ]);
          await sleep(500);
        }
      }
      const f2 = regDesktopFacts();
      const setEq = base !== null && f2.count === base.count && base.ids.every((x) => f2.ids.includes(x)) && f2.ids.every((x) => base.ids.includes(x));
      const backNormal = !normalId || f2.current === normalId;

      // ③ 面板退出与配置三态还原
      const cleared = await handle.stop();
      restoreConfig(originalConfig);
      const cfgRestored = (() => {
        const raw = readConfigRaw();
        return originalConfig === null ? raw === null : raw === originalConfig;
      })();
      com?.release();
      if (fixtures) fs.rmSync(fixtures.root, { recursive: true, force: true });
      win32.ensureNativeTaskbarVisible();

      if (treeOk && setEq && backNormal && cfgRestored && cleared && cleared.gone !== false) {
        rep.pass(`P6 源存储只读与零残留：夹具全树 ${afterTree.length} 文件 sha256+mtime 前后逐字节一致（只读适配器零写入）；config 三态还原；桌面集合与基线逐项相等（${f2.count} 个，当前回到普通）；面板退出（${cleared.outcome}）`);
      } else {
        rep.fail(`P6 只读=${treeOk} 桌面集合=${setEq}（${f2.count} vs ${base ? base.count : 'null'}） 回普通=${backNormal} config还原=${cfgRestored} 面板退出=${JSON.stringify(cleared)}`);
      }
    } catch (err) { rep.fail(`P6 异常: ${err.message}`); }
    finish();
  }
}

module.exports = main;
