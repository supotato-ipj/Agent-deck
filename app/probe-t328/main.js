// probe-t328 main — 抛弃式探针（工单 #328）。
// 模式：
//   PROBE_MODE=functional  默认。跑四条验收标准中的 1/2/3 全套断言，结果 JSON 写 PROBE_RESULT，exit 0/1。
//   PROBE_MODE=measure     资源基线。PROBE_N=0|1|5|10，起 N 个执行上下文，测时延/内存/进程数，写 PROBE_RESULT 后退出。
//   PROBE_EXP=late|double|unregistered|nonstandard  Electron 44 registerSchemesAsPrivileged 行为微实验。
'use strict';

const { app, BrowserWindow, WebContentsView, session, ipcMain, protocol, net } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const T0 = Date.now();
const MODE = process.env.PROBE_MODE || (process.env.PROBE_EXP ? 'exp' : 'functional');
const PROBE_N = parseInt(process.env.PROBE_N || '0', 10);
const RESULT_FILE = process.env.PROBE_RESULT || '';
const EXP = process.env.PROBE_EXP || '';

// userData 指到独立临时目录：不碰真实面板 userData（单实例锁/托盘等一概无关）。
app.setPath('userData', path.join(app.getPath('temp'), `probe-t328-${process.pid}`));

// ---- scheme 池：ready 前“一次调用列全所有 scheme”（Electron 硬约束，行为见微实验）----
const SCHEME_POOL = ['pkg-a', 'pkg-b', 'pkg-ns', ...Array.from({ length: 10 }, (_, i) => `pkg-m${i}`)];
const PRIV_FULL = { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true };

function registerAllSchemes() {
  const privs = SCHEME_POOL.map((s) => ({ scheme: s, privileges: { ...PRIV_FULL } }));
  // 'pkg-ns' 在 nonstandard 实验里降权：不带 standard，看 origin/localStorage/fetch 实际形态
  if (EXP === 'nonstandard') privs.find((p) => p.scheme === 'pkg-ns').privileges = {};
  protocol.registerSchemesAsPrivileged(privs);
}

if (EXP === 'double') {
  registerAllSchemes();
  try {
    registerAllSchemes(); // 第二次调用：预期报错或静默，记录实际行为
  } catch (e) {
    process.__expDoubleError = String(e && e.stack ? e.stack.split('\n')[0] : e);
  }
} else {
  registerAllSchemes();
}

// ---- 执行上下文登记表：webContents.id -> 身份。renderer 自报身份一律不采信。----
const registry = new Map(); // wcId -> { packageId, generation, scheme, root, whitelist(origin keys) }
const mountEffects = Object.create(null); // packageId -> mount 副作用计数
const netBlockedLog = []; // webRequest 层拒绝留痕

// ---- 小工具 ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const once = (emitter, ev) => new Promise((res) => emitter.once(ev, (...a) => res(a)));
let LAST_STEP = 'init';
// Electron 44 实测坑：对已崩溃的 webContents，executeJavaScript 的 promise 可能悬挂不落定
// （内部只打 "Render frame was disposed" 日志）。所有调用一律套超时。
async function safeExec(wc, code, timeoutMs = 5000) {
  try {
    const value = await Promise.race([
      wc.executeJavaScript(code, false),
      sleep(timeoutMs).then(() => { throw new Error(`safeExec timeout ${timeoutMs}ms`); })
    ]);
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}
async function onceTimeout(emitter, ev, timeoutMs = 8000) {
  return Promise.race([once(emitter, ev), sleep(timeoutMs).then(() => null)]);
}
function writeResult(obj) {
  const out = JSON.stringify(obj, null, 2);
  if (RESULT_FILE) {
    fs.mkdirSync(path.dirname(RESULT_FILE), { recursive: true });
    fs.writeFileSync(RESULT_FILE, out);
  }
  console.log(out);
}

// ---- 本地 fixture 服务：两个端口 = 两个授权 origin ----
function startFixture() {
  return new Promise((resolve) => {
    const handler = (req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, path: req.url, ts: Date.now() }));
    };
    const a = http.createServer(handler);
    const b = http.createServer(handler);
    a.listen(0, '127.0.0.1', () => {
      b.listen(0, '127.0.0.1', () => resolve({ originA: `http://127.0.0.1:${a.address().port}`, originB: `http://127.0.0.1:${b.address().port}` }));
    });
  });
}

// ---- 每包 session：自定义协议服务包根 + webRequest 默认拒绝 ----
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json', '.css': 'text/css' };

function serveFromRoot(req, root, scheme) {
  let u;
  try { u = new URL(req.url); } catch { return new Response('bad url', { status: 400 }); }
  const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
  const p = path.resolve(root, rel);
  if (!p.toLowerCase().startsWith(String(root).toLowerCase() + path.sep) && p.toLowerCase() !== String(root).toLowerCase()) {
    return new Response('forbidden', { status: 403 });
  }
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return new Response('not found', { status: 404 });
  const type = MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
  return new Response(fs.readFileSync(p), { headers: { 'content-type': type } });
}

function mountPackage({ packageId, scheme, root, whitelist }) {
  const ses = session.fromPartition(`probe-${packageId}`); // 内存态 partition，天然每包隔离
  ses.protocol.handle(scheme, (req) => serveFromRoot(req, root, scheme));
  ses.webRequest.onBeforeRequest((details, callback) => {
    const allow = details.url.startsWith(`${scheme}://`);
    if (!allow) netBlockedLog.push({ packageId, url: details.url.slice(0, 120), resourceType: details.resourceType });
    callback({ cancel: !allow });
  });
  const view = new WebContentsView({
    webPreferences: {
      session: ses,
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false,
      nodeIntegration: false
    }
  });
  registry.set(view.webContents.id, { packageId, generation: 1, scheme, root, whitelist });
  return view;
}

// ---- 宿主壳（“面板”）：一个隐藏 BrowserWindow，包视图挂它上面 ----
let hostWin = null;
function createHostWindow() {
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 700,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false }
  });
  win.loadFile(path.join(__dirname, 'host-shell.html'));
  return win;
}

// ---- broker IPC：身份从 event.sender.id 查登记表；payload.pluginId 只留证不采信 ----
ipcMain.handle('probe:network', async (event, payload) => {
  const reg = registry.get(event.sender.id);
  const claimed = payload && payload.pluginId != null ? String(payload.pluginId) : null;
  if (!reg) return { denied: true, code: 'unknown_context', claimed };
  let u;
  try { u = new URL(String(payload.url)); } catch (e) {
    return { denied: true, code: 'bad_url', identity: reg.packageId, claimed };
  }
  const originKey = `${u.protocol}//${u.host}`;
  if (!reg.whitelist.includes(originKey)) {
    return { denied: true, code: 'network_denied', identity: reg.packageId, claimed, origin: originKey };
  }
  try {
    const resp = await net.fetch(payload.url); // 主进程代发：无凭证、无 renderer 网络栈参与
    const body = await resp.text();
    return { denied: false, identity: reg.packageId, claimed, status: resp.status, body: body.slice(0, 4096) };
  } catch (e) {
    return { denied: true, code: 'fetch_error', identity: reg.packageId, claimed, message: String(e && e.message ? e.message : e) };
  }
});
ipcMain.on('probe:mount-effect', (event) => {
  const reg = registry.get(event.sender.id);
  if (reg) mountEffects[reg.packageId] = (mountEffects[reg.packageId] || 0) + 1;
});
ipcMain.handle('probe:ping', (event) => {
  const reg = registry.get(event.sender.id);
  return reg ? { identity: reg.packageId, generation: reg.generation } : { identity: null };
});

// ==================== functional 模式：标准 1/2/3 ====================
async function runFunctional() {
  const R = { mode: 'functional', electron: process.versions.electron, startedAt: new Date().toISOString(), checks: [], notes: {} };
  RUNR = R;
  const check = (name, pass, detail) => { R.checks.push({ name, pass: !!pass, detail }); };

  const { originA, originB } = await startFixture();
  R.notes.fixture = { originA, originB };

  hostWin = createHostWindow();

  const viewA = mountPackage({
    packageId: 'pkg-a', scheme: 'pkg-a', root: path.join(__dirname, 'pkg-a'),
    whitelist: [originA] // A 只授权 originA
  });
  const viewB = mountPackage({
    packageId: 'pkg-b', scheme: 'pkg-b', root: path.join(__dirname, 'pkg-b'),
    whitelist: [originB] // B 只授权 originB
  });
  hostWin.contentView.addChildView(viewA);
  hostWin.contentView.addChildView(viewB);
  viewA.setBounds({ x: 0, y: 0, width: 400, height: 300 });
  viewB.setBounds({ x: 400, y: 0, width: 400, height: 300 });

  const wcA = viewA.webContents;
  const wcB = viewB.webContents;
  await Promise.all([
    wcA.loadURL('pkg-a://bundle/index.html'),
    wcB.loadURL('pkg-b://bundle/index.html')
  ]);
  await sleep(200); // 让页面脚本跑完

  // ---------- 标准 1：独立 webContents + 独立 origin，跨包 DOM/资产/运行状态读取失败 ----------
  LAST_STEP = 't1-origin';
  const oA = await safeExec(wcA, 'location.origin');
  const oB = await safeExec(wcB, 'location.origin');
  check('1.1 A origin 独立解析为 pkg-a://bundle', oA.ok && oA.value === 'pkg-a://bundle', JSON.stringify(oA.value || oA.error));
  check('1.2 B origin 独立解析为 pkg-b://bundle', oB.ok && oB.value === 'pkg-b://bundle', JSON.stringify(oB.value || oB.error));
  check('1.3 两包是不同 webContents', wcA.id !== wcB.id, `wcA.id=${wcA.id} wcB.id=${wcB.id}`);

  const lsA = await safeExec(wcA, "localStorage.getItem('who')");
  const lsB = await safeExec(wcB, "localStorage.getItem('who')");
  check('1.4 localStorage 各自独立（A=A, B=B，互不可见）', lsA.ok && lsA.value === 'A' && lsB.ok && lsB.value === 'B', `A=${JSON.stringify(lsA.value)} B=${JSON.stringify(lsB.value)}`);
  const secA = await safeExec(wcA, 'window.__secret');
  const secB = await safeExec(wcB, 'window.__secret');
  check('1.5 JS 变量各在独立堆（A 只见 A-secret，B 只见 B-secret）', secA.ok && secA.value === 'A-secret' && secB.ok && secB.value === 'B-secret', `A=${JSON.stringify(secA.value)} B=${JSON.stringify(secB.value)}`);

  // 跨包资产：B 读 A 的资产 / A 读 B 的资产（webRequest 层 + origin/CORS 层双保险）
  LAST_STEP = 't1-cross-asset';
  const xfB = await safeExec(wcB, "fetch('pkg-a://bundle/index.html').then(r => 'HTTP ' + r.status).catch(e => 'ERR ' + e.message)");
  const xfA = await safeExec(wcA, "fetch('pkg-b://bundle/index.html').then(r => 'HTTP ' + r.status).catch(e => 'ERR ' + e.message)");
  check('1.6 B fetch A 文档失败', xfB.ok && /^ERR/.test(String(xfB.value)), JSON.stringify(xfB.value));
  check('1.7 A fetch B 文档失败', xfA.ok && /^ERR/.test(String(xfA.value)), JSON.stringify(xfA.value));
  const asB = await safeExec(wcB, "fetch('pkg-a://bundle/asset.svg').then(r => 'HTTP ' + r.status).catch(e => 'ERR ' + e.message)");
  check('1.8 B 读 A 资产失败', asB.ok && /^ERR/.test(String(asB.value)), JSON.stringify(asB.value));
  // 同包控制组：协议本身好使
  const selfA = await safeExec(wcA, "fetch('pkg-a://bundle/index.html').then(r => 'HTTP ' + r.status).catch(e => 'ERR ' + e.message)");
  const selfAssetA = await safeExec(wcA, "fetch('pkg-a://bundle/asset.svg').then(r => 'HTTP ' + r.status).catch(e => 'ERR ' + e.message)");
  check('1.9 控制组：A 取本包文档/资产成功', selfA.ok && selfA.value === 'HTTP 200' && selfAssetA.ok && selfAssetA.value === 'HTTP 200', `doc=${JSON.stringify(selfA.value)} asset=${JSON.stringify(selfAssetA.value)}`);

  // 跨包 DOM 尝试：B 用 iframe 装 A 的页面（scheme 未在 B 的 session 注册 → 预期解析失败）
  LAST_STEP = 't1-iframe';
  const iframeB = await safeExec(wcB, `(async () => {
    const f = document.createElement('iframe');
    f.src = 'pkg-a://bundle/index.html';
    document.body.appendChild(f);
    return await new Promise((res) => {
      let settled = false;
      f.onload = () => { if (!settled) { settled = true; try { const d = f.contentDocument; res(d === null ? 'contentDocument=null (跨域拒绝访问)' : 'DOM泄漏:' + d.title); } catch (e) { res('SecurityError: ' + e.message); } } };
      f.onerror = () => { if (!settled) { settled = true; res('iframe error (加载被拒)'); } };
      setTimeout(() => { if (!settled) { settled = true; try { const d = f.contentDocument; res(d === null ? 'timeout:contentDocument=null' : (d.location ? 'doc accessible, href=' + d.location.href : 'doc=' + String(d))); } catch (e) { res('timeout+SecurityError: ' + e.message); } } }, 1500);
    });
  })()`);
  check('1.10 B iframe 装 A 页面拿不到 A 的 DOM', iframeB.ok && !/DOM泄漏/.test(String(iframeB.value)), JSON.stringify(iframeB.value));

  // ---------- 标准 2：逐包网络拦截 + 自报 pluginId 不改身份 ----------
  LAST_STEP = 't2-direct-deny';
  const dA = await safeExec(wcA, `fetch('${originA}/a-only').then(r => 'HTTP ' + r.status).catch(e => 'ERR ' + e.message)`);
  const dB = await safeExec(wcB, `fetch('${originB}/b-only').then(r => 'HTTP ' + r.status).catch(e => 'ERR ' + e.message)`);
  check('2.1 renderer 直连网络被 webRequest 默认拒绝（A）', dA.ok && /^ERR/.test(String(dA.value)), JSON.stringify(dA.value));
  check('2.2 renderer 直连网络被 webRequest 默认拒绝（B）', dB.ok && /^ERR/.test(String(dB.value)), JSON.stringify(dB.value));

  LAST_STEP = 't2-broker';
  const n1 = (await safeExec(wcA, `host.networkRequest({ pluginId: 'pkg-b', url: '${originA}/a-only' })`)).value;
  check('2.3 A 冒称 pkg-b 访问自己的授权 origin → 放行，身份按登记表=pkg-a', n1 && n1.denied === false && n1.identity === 'pkg-a' && n1.claimed === 'pkg-b', JSON.stringify(n1));
  const n2 = (await safeExec(wcA, `host.networkRequest({ pluginId: 'pkg-b', url: '${originB}/b-only' })`)).value;
  check('2.4 A 冒称 pkg-b 访问 B 的 origin → 拒（按真实身份 A 的白名单）', n2 && n2.denied === true && n2.code === 'network_denied' && n2.identity === 'pkg-a', JSON.stringify(n2));
  const n3 = (await safeExec(wcB, `host.networkRequest({ pluginId: 'pkg-a', url: '${originA}/a-only' })`)).value;
  check('2.5 B 冒称 pkg-a 访问 A 的 origin → 拒（不因冒称而放行）', n3 && n3.denied === true && n3.code === 'network_denied' && n3.identity === 'pkg-b', JSON.stringify(n3));
  const n4 = (await safeExec(wcB, `host.networkRequest({ pluginId: 'pkg-b', url: '${originB}/b-only' })`)).value;
  check('2.6 B 走自己的授权 origin → 放行', n4 && n4.denied === false && n4.identity === 'pkg-b', JSON.stringify(n4));

  // ---------- 标准 3：崩溃隔离，不自动重挂，副作用不重放 ----------
  LAST_STEP = 't3-pre';
  check('3.0 前置：A mount 副作用计数=1', mountEffects['pkg-a'] === 1, `count=${mountEffects['pkg-a']}`);
  const beats1 = (await safeExec(wcB, 'window.__beats')).value;
  wcA.forcefullyCrashRenderer();
  LAST_STEP = 't3-crashed-wait-event';
  const gone = await onceTimeout(wcA, 'render-process-gone');
  const reason = gone && gone[1] && gone[1].reason;
  check('3.1 render-process-gone 触发', !!gone, `reason=${reason}`);

  LAST_STEP = 't3-host-alive';
  check('3.2 宿主壳窗体存活', !hostWin.isDestroyed(), `isDestroyed=${hostWin.isDestroyed()}`);
  await sleep(300);
  const pingB = await safeExec(wcB, '1+1');
  check('3.3 另一包 renderer 仍可执行 JS', pingB.ok && String(pingB.value) === '2', JSON.stringify(pingB.ok ? pingB.value : pingB.error));
  const beats2 = (await safeExec(wcB, 'window.__beats')).value;
  await sleep(600);
  const beats3 = (await safeExec(wcB, 'window.__beats')).value;
  check('3.4 另一包事件循环仍在走（心跳递增）', beats3 > beats2, `${beats2} -> ${beats3}`);

  LAST_STEP = 't3-crash-state';
  check('3.5 A 进入崩溃态 isCrashed()=true', wcA.isCrashed() === true, `isCrashed=${wcA.isCrashed()}`);
  const deadA = await safeExec(wcA, '1+1', 3000);
  check('3.6 崩溃包 executeJavaScript 拒绝（错误态可探测）', !deadA.ok, JSON.stringify(deadA.error));

  // 关键纪律：主进程【不调用 reload()】，观察窗内验证无重挂、无副作用重放
  LAST_STEP = 't3-no-remount-observe';
  await sleep(2000);
  check('3.7 无自动重挂（mount 副作用计数仍=1，未重放）', mountEffects['pkg-a'] === 1, `count=${mountEffects['pkg-a']}`);
  R.notes.reloadNeverCalled = true; // 本探针主进程全文无 reload()，静态可查
  R.notes.netBlockedLog = netBlockedLog.slice(0, 20);

  R.passed = R.checks.filter((c) => c.pass).length;
  R.failed = R.checks.filter((c) => !c.pass).length;
  writeResult(R);
  app.exit(R.failed === 0 ? 0 : 1);
}

// ==================== measure 模式：标准 4 ====================
async function runMeasure() {
  const tReady = Date.now();
  hostWin = createHostWindow();
  const loads = [];
  for (let i = 0; i < PROBE_N; i++) {
    const scheme = `pkg-m${i}`;
    const view = mountPackage({
      packageId: `m${i}`,
      scheme,
      root: path.join(__dirname, 'pkg-m'),
      whitelist: []
    });
    hostWin.contentView.addChildView(view);
    view.setBounds({ x: (i % 5) * 180, y: Math.floor(i / 5) * 160, width: 170, height: 150 });
    loads.push(view.webContents.loadURL(`${scheme}://bundle/index.html`));
  }
  await Promise.all(loads);
  const tLoaded = Date.now();
  await sleep(400); // 稳定窗

  const metrics = app.getAppMetrics();
  const byType = {};
  let wsTotalKb = 0;
  let pkTotalKb = 0;
  for (const m of metrics) {
    byType[m.type] = (byType[m.type] || 0) + 1;
    wsTotalKb += (m.memory && m.memory.workingSetSize) || 0;
    pkTotalKb += (m.memory && m.memory.privateBytes) || 0;
  }
  writeResult({
    mode: 'measure',
    electron: process.versions.electron,
    n: PROBE_N,
    t0_to_ready_ms: tReady - T0,
    ready_to_loaded_ms: tLoaded - tReady,
    rss_main_bytes: process.memoryUsage().rss,
    process_count: metrics.length,
    processes_by_type: byType,
    workingSet_total_kb: wsTotalKb,
    private_total_kb: pkTotalKb
  });
  app.exit(0);
}

// ==================== exp 模式：Electron 44 微实验 ====================
async function runExp() {
  const out = { exp: EXP, electron: process.versions.electron, notes: {} };
  if (EXP === 'double') {
    out.secondCallError = process.__expDoubleError || null;
    out.conclusion = out.secondCallError ? '第二次 registerSchemesAsPrivileged 抛错' : '第二次调用静默（未抛错）——仍应只调一次';
  } else if (EXP === 'late') {
    try {
      protocol.registerSchemesAsPrivileged([{ scheme: 'pkg-late', privileges: PRIV_FULL }]);
      out.lateCallError = null;
    } catch (e) {
      out.lateCallError = String(e && e.message ? e.message : e);
    }
    // 试导航一个未注册 scheme
    const w = new BrowserWindow({ show: false });
    try {
      await w.loadURL('pkg-late://bundle/index.html');
      out.lateNav = 'loaded?! ' + (await w.webContents.executeJavaScript('location.origin'));
    } catch (e) {
      out.lateNavError = String(e && e.message ? e.message : e);
    }
    try { w.destroy(); } catch {}
  } else if (EXP === 'unregistered') {
    const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    try {
      await w.loadURL('pkg-z://bundle/index.html');
      out.nav = 'loaded?!';
    } catch (e) {
      out.navError = String(e && e.message ? e.message : e);
    }
    try { w.destroy(); } catch {}
  } else if (EXP === 'nonstandard') {
    const ses = session.fromPartition('probe-ns');
    ses.protocol.handle('pkg-ns', (req) => serveFromRoot(req, path.join(__dirname, 'pkg-a'), 'pkg-ns'));
    const w = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, contextIsolation: true } });
    try {
      await w.loadURL('pkg-ns://bundle/index.html');
      out.origin = await w.webContents.executeJavaScript('location.origin');
      out.ls = await w.webContents.executeJavaScript("try { localStorage.setItem('k','v'); 'ok:'+localStorage.getItem('k') } catch (e) { 'ERR ' + e.message }");
      out.fetchSelf = await w.webContents.executeJavaScript("fetch('pkg-ns://bundle/index.html').then(r=>'HTTP '+r.status).catch(e=>'ERR '+e.message)");
    } catch (e) {
      out.navError = String(e && e.message ? e.message : e);
    }
    try { w.destroy(); } catch {}
  }
  writeResult(out);
  app.exit(0);
}

// ---- 入口 ----
let RUNR = null; // 诊断用：functional 的结果对象引用，watchdog 崩溃时导出部分断言
const WATCHDOG = setTimeout(() => {
  writeResult({ mode: MODE, exp: EXP, fatal: 'watchdog timeout', lastStep: LAST_STEP, partial: RUNR });
  app.exit(2);
}, 90000);

app.whenReady().then(() => {
  if (MODE === 'measure') return runMeasure();
  if (MODE === 'exp') return runExp();
  return runFunctional();
}).catch((e) => {
  writeResult({ mode: MODE, exp: EXP, fatal: String(e && e.stack ? e.stack : e) });
  app.exit(2);
}).finally(() => clearTimeout(WATCHDOG));
