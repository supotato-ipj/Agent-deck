'use strict';
// 工单332 真机验收（spec #326，ADR-0018 对话通道 / ADR-0026 DSH 运行时）：
// 控制器以 --accept-chat 身份运行，拉起 --panel-accept 面板子进程（绕开单实例锁），
// 经面板页 CDP 驱动真实桥接链路（与用户点击同一条 invoke 通路），对真实 DSH
// （desktop 安装，浮动版本）做聊天会话全链冒烟——零用户凭证：provider 路由由电池
// 以「用户显式配置」姿势写入面板专属 DSH_HOME 的 acp profile（cordis.patch.yml +
// apiKeyEnv 引用电池自设的环境变量），LLM 用本地罐头（accept/lib/canned-llm.js）。
//
// 一段绑定一工单（docs/agents/battery-governance.md）：段 C1 归 332，七断言——
//   ① 握手与创建：ACP initialize（agentInfo/protocolVersion 实测存证）+ session/new
//     （mcpServers 空 = 零管理面）+ 会话专属空工作目录 + 元数据只存元数据 + 进程在场
//   ② prompt 流式：agent 文本上窗、end_turn 收束
//   ③ cancel 与收起：stopReason cancelled + 进程存活可续用；WM_CLOSE 关窗只收起
//     （窗隐、进程不动），再唤回可见
//   ④ 工具审批：workspace 外写触发 request_permission 原样呈现（allow-once/reject-once），
//     挂起不超时自动拒绝；allow-once 裁决 → 文件真实写入（回复形状由适配器固定，
//     DSH fail-closed 语义兜底坏形状）
//   ⑤ 显式退出：end → cancel/close/stdin close → 自然退出 code 0，元数据记 endedAt
//   ⑥ 进程回收：会话进程 pid 消失（backendPid 清空），面板本体无恙
//   ⑦ 全程零管理面：无 managed 会话、无凭证落盘
// 段 C2 归 333（工单333 管理型会话只读面板与插件契约，真实 DSH + 罐头 LLM）：
//   ① UI 契约（管理勾选 + 以聊天型创建显式选择）② 显式授权创建 wire 存证
//   ③ 凭证零落盘 ④⑤ DSH 真调只读工具（快照/契约目录）⑥ 投影外未知工具
//   ⑦ 凭证逐会话失效（旧 bearer 401）⑧ 宿主随最后管理会话回收 ⑨ 聊天型并存零回归
// 段 C4 归 334（工单334 DSH 创建零权限插件）：DSH 文件工具写包 → MCP 提交 → 批准 → 转正
//   激活 → 桌面真显示；拒绝路径补偿完备。
// 段 C5 归 335（工单335 更新/卸载）：更新已装包（提案 diff+权限变化→待批旧代次仍跑→批准=
//   原子换代→同字节 no_change）→ 卸载→回收站→清单消失。执行序 C4 后、C3 前（C3 bogus
//   重启面板必须最后）。
// 红线遵守：不碰用户 ~/.dsh（DSH_HOME 恒指面板专属 userData 子目录）；盘符不硬编码
// （DSH 安装经描述符解析）；清场：罐头 LLM 关停、升级写探针文件删除、面板句柄强退。
//
// 运行：npm run accept:chat（= npm run build && electron . --accept-chat）
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { readConfigRaw, restoreConfig } = require('./lib/battery-config');
const win32 = require('./lib/win32');
const { Report, parseAcceptScope } = require('./lib/report');
const { cdpPortFor } = require('./lib/registry');
const { createEventTape } = require('./lib/event-tape');
const { createPanelHandle } = require('./lib/panel-control');
const { startCannedLlm } = require('./lib/canned-llm');
const { startMediaFixture } = require('./lib/media-fixture');
const { startHttpFixture } = require('./lib/http-fixture');

const APP_ROOT = path.resolve(__dirname, '..');
const EVENTS_FILE = path.join(__dirname, 'evidence', '332-conversation-events.jsonl');
const CDP_PORT = cdpPortFor('332-conversation');
const PANEL_TITLE = 'AGENT DECK';
const CONV_TITLE = 'DECK-CONVERSATION';
const LLM_KEY_ENV = 'DECK_CHAT_ACCEPT_LLM_KEY';
const ESCALATION_FILE = path.join(app.getPath('userData'), 'conversation', 'accept-332-escalation.txt');
const PROBE_PORT_FILE = path.join(__dirname, 'evidence', '333-managed-probe-port.json');
const WM_CLOSE = 0x0010;

/** 观察口取 bearer（工单333）：面板进程内存端点转交，凭证本体不经文件不经日志 */
async function probeBearer(sessionId) {
  const portInfo = JSON.parse(fs.readFileSync(PROBE_PORT_FILE, 'utf8'));
  const res = await fetch(`http://127.0.0.1:${portInfo.port}/bearer?sessionId=${encodeURIComponent(sessionId)}`);
  const body = await res.json();
  return body.bearer ?? null;
}

/** 直打管理宿主（电池=同用户进程，持有观察口转交的 bearer）：返回 JSON-RPC 信封或连接错误标记 */
async function hostCall(mcpUrl, bearer, method, params) {
  try {
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: bearer } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch (err) {
    return { status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

const tape = createEventTape(EVENTS_FILE, { defaultTimeoutMs: 30000 });
const handle = createPanelHandle({
  execPath: process.execPath,
  appRoot: APP_ROOT,
  eventLogPath: EVENTS_FILE,
  archivePath: path.join(__dirname, 'evidence', '332-conversation-panel-child.log'),
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(pred, timeoutMs, stepMs = 150) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const v = await pred();
      if (v) return v;
    } catch { /* 轮询期异常按未就绪 */ }
    if (Date.now() >= deadline) return null;
    await sleep(stepMs);
  }
}

// CDP：面板页是唯一驱动口（window.deck 全量桥接；对话窗的窗口事实走 win32 核验）
async function cdpEvalOn(pageTitle, expression, timeoutMs = 10000) {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
  const target = targets.find((t) => t.title === pageTitle);
  if (!target) throw new Error(`CDP 找不到页面目标：${pageTitle}`);
  return cdpEvalTarget(target, expression, timeoutMs);
}

// 按目标对象直接求值（工单336 包页断言：deck-pkg://<id>/ 目标按 url 前缀甄别）
async function cdpEvalTarget(target, expression, timeoutMs = 10000) {
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

/** 包页 CDP 目标（按 url 前缀甄别；找不到 = null——轮询用不抛错） */
async function pkgTarget(urlPrefix) {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
  return targets.find((t) => typeof t.url === 'string' && t.url.startsWith(urlPrefix)) || null;
}

/** 桥接 invoke（经面板页真实通路；与用户点击渲染层同一入口）；timeoutMs 缺省 10s，
 * 长链路调用（工单334 approve=哈希+转正+有界激活 12s）显式给足 */
async function bridge(method, payload, timeoutMs) {
  const expr = `window.deck.bridge.invoke(${JSON.stringify(method)}, ${JSON.stringify(payload ?? null)})`;
  return cdpEvalOn(PANEL_TITLE, expr, timeoutMs);
}

async function sessionsView() {
  const res = await bridge('conversation/list', null);
  return res.sessions;
}

async function sessionById(id) {
  return (await sessionsView()).find((s) => s.id === id) || null;
}

const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(uintptr_t hWnd, uint16 *buf, int nMax)');

function windowTitleOf(hwnd) {
  const buf = Buffer.alloc(512);
  const n = GetWindowTextW(hwnd, buf, 256);
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(buf.readUInt16LE(i * 2));
  return s;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** 面板 pid：事件档最新 boot 自报（与面板句柄同一甄别口径） */
function panelPagePid() {
  const boots = tape.all('boot', null);
  return boots.length ? Number(boots[boots.length - 1].pid) : 0;
}

/** 对话窗寻窗：面板 pid + 标题 + 可见（关窗只收起后按「不可见」判收起） */
function convHwndOf(panelPid) {
  if (!panelPid) return null;
  for (const h of win32.topLevelWindows()) {
    if (Number(win32.threadIdOf(h).pid) !== Number(panelPid)) continue;
    if (windowTitleOf(h) !== CONV_TITLE) continue;
    if (!win32.IsWindowVisible(h)) continue;
    return h;
  }
  return null;
}

/** DSH 安装解析（与面板同一描述符逻辑，读构建产物；解析不出 = 本机未装，如实判负） */
function resolveDsh() {
  const backend = require(path.join(APP_ROOT, 'dist', 'main', 'conversation', 'dsh-backend.js'));
  return backend.resolveDshInstall(undefined, backend.defaultProbeDeps());
}

async function main() {
  const rep = new Report('332-conversation', { scope: parseAcceptScope(process.argv) });
  const userData = app.getPath('userData');
  const configRaw = readConfigRaw();
  const dshHome = path.join(userData, 'dsh-home');
  const metaFile = path.join(userData, 'conversation', 'metadata.json');
  let llm = null;
  let freshDir = null; // C3（工单340）：全新数据目录手势产物（清场删除）
  let started = 0;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    const v = rep.verdict();
    app.exit(v.exitCode);
  };

  rep.beginSegment('C1');
  try {
    fs.writeFileSync(EVENTS_FILE, '', 'utf8');
    try { fs.rmSync(ESCALATION_FILE, { force: true }); } catch { /* 清场尽力 */ }
    // provider 路由显式配置（用户后端档姿势，探针实证 set_config_option 是唯一生效路径——
    // profile patch 的 agent-default-model 不改 session/new 默认，2026-10-31 预检实证）：
    // config.conversation.model 原样是 DSH 方言值；凭证明面只在 apiKeyEnv 引用（不落凭证）。
    try {
      const json = configRaw ? JSON.parse(configRaw) : {};
      json.conversation = { ...(json.conversation ?? {}), model: '["probe-llm","probe-model"]' };
      fs.writeFileSync(path.join(APP_ROOT, 'config.json'), JSON.stringify(json, null, 2) + '\n', 'utf8');
    } catch { /* 配置写不进 → 后端默认路由 → 认证错误将在断言位如实判负 */ }

    // —— 环境备妥：DSH 安装解析（不硬编码盘符）+ 罐头 LLM + provider 显式配置（零凭证）——
    const install = resolveDsh();
    if (!install) {
      rep.fail('DSH 安装未解析到（描述符探测落空）——本段要求真实 DSH 在场');
      finish();
      return;
    }
    rep.note(`DSH 安装：${install.exe}（来源 ${install.source}）`);
    llm = await startCannedLlm({ outsideFilePath: ESCALATION_FILE });
    const patchDir = path.join(dshHome, 'profiles', 'acp');
    fs.mkdirSync(patchDir, { recursive: true });
    // provider 显式配置姿势（探针配方）：cordis.patch.yml + apiKeyEnv 引用环境变量——配置不落凭证
    fs.writeFileSync(path.join(patchDir, 'cordis.patch.yml'),
      `# deck-332 accept patch: explicit provider route to local canned LLM (no credential on disk)\n` +
      `- id: llm-pi-ai\n  config:\n    providers:\n      probe-llm:\n        displayName: Accept Canned LLM\n        apiKeyEnv: ${LLM_KEY_ENV}\n        api: openai-completions\n        baseURL: ${llm.url}/v1\n        models:\n          - id: probe-model\n            name: Probe Model\n            contextWindow: 262144\n            reasoningEfforts:\n              off:\n              high: high\n` +
      `- id: agent-default-model\n  config:\n    provider: probe-llm\n    model: probe-model\n`, 'utf8');
    started = Date.now();

    // —— 拉面板（--panel-accept 绕单实例锁；事件档 + CDP + 罐头 LLM key + 管理观察口注入）——
    handle.launch({
      mode: 'accept',
      cdpPort: CDP_PORT,
      stdio: 'archive',
      extraEnv: { [LLM_KEY_ENV]: 'accept-round-not-a-real-key', DECK_MANAGED_PROBE: '1' },
    });
    const hwnd = await handle.waitWindow({ title: PANEL_TITLE, cls: 'Chrome_WidgetWin_1', timeoutMs: 30000 });
    if (!hwnd) {
      rep.fail('面板窗口未就绪（30s）——无法驱动对话窗链路');
      finish();
      return;
    }
    await until(async () => {
      try { return (await bridge('panel/snapshot', null)) != null; } catch { return false; }
    }, 20000);

    // 断言① 握手与创建（验收标准 1/2/3/4 的创建时刻面）
    const backend = await bridge('conversation/backend', null);
    if (backend && backend.available) rep.pass(`后端可用性如实上报：${backend.detail}`);
    else rep.fail(`conversation/backend 不可用：${JSON.stringify(backend)}`);

    const created = await bridge('conversation/create', { label: 'accept-332' });
    if (!created.ok) {
      rep.fail(`conversation/create 失败：${created.error}`);
      finish();
      return;
    }
    const sessionId = created.session.id;
    const handshake = await tape.wait('conversation-handshake', (e) => e.sessionId === sessionId, { timeoutMs: 45000, since: started });
    if (handshake && handshake.agent === 'deepseek-harness-acp' && handshake.protocolVersion === 1) {
      rep.pass(`ACP 握手存证：${handshake.agent} ${handshake.agentVersion} protocolVersion=${handshake.protocolVersion}`);
    } else {
      rep.fail(`握手存证缺失或形状不符：${JSON.stringify(handshake)}`);
    }
    const sessionNew = await tape.wait('conversation-session-new', (e) => e.sessionId === sessionId, { timeoutMs: 10000, since: started });
    if (sessionNew && sessionNew.mcpServers === 'empty(chat)') rep.pass('session/new 存证：mcpServers 空（零管理面，不注入管理通道）');
    else rep.fail(`session/new 存证形状不符：${JSON.stringify(sessionNew)}`);
    const setOpt = await tape.wait('conversation-config-option', (e) => e.sessionId === sessionId, { timeoutMs: 10000, since: started });
    if (setOpt) rep.pass('provider 路由显式配置生效：set_config_option 存证（DSH 方言封适配器，无 UI 面）');
    else rep.fail('config.conversation.model 未在 wire 上下发（set_config_option 存证缺失）');

    const view = await until(() => sessionById(sessionId).then((s) => (s && s.status === 'ready' ? s : null)), 30000);
    if (!view) { rep.fail('会话 30s 未进入 ready'); finish(); return; }
    const cwdOk = path.isAbsolute(view.cwd)
      && fs.existsSync(view.cwd)
      && fs.statSync(view.cwd).isDirectory()
      && fs.readdirSync(view.cwd).length === 0;
    if (cwdOk) rep.pass(`会话专属空工作目录：${view.cwd}`);
    else rep.fail(`工作目录不合规：${view.cwd}`);
    const metaText = fs.existsSync(metaFile) ? fs.readFileSync(metaFile, 'utf8') : '';
    const metaOk = metaText.includes(JSON.stringify(view.cwd).slice(1, -1))
      && metaText.includes('"backend": "dsh"')
      && !metaText.includes('"transcript"')
      && !metaText.includes('apiKey')
      && !metaText.toLowerCase().includes('credential');
    if (metaOk) rep.pass('元数据落盘：backend/cwd 绝对路径在案；只存元数据（无正文、无凭证）');
    else rep.fail(`元数据形状不符（transcript 字段=${metaText.includes('"transcript"')}，内容=${metaText.slice(0, 200)}）`);
    if (view.managed === false && typeof view.backendPid === 'number' && view.backendPid > 0 && pidAlive(view.backendPid)) {
      rep.pass(`聊天型（managed=false）且后端进程在场 pid=${view.backendPid}`);
    } else {
      rep.fail(`会话视图形态不符：managed=${view.managed} backendPid=${view.backendPid}`);
    }

    // 断言② prompt 流式（验收标准 1：看到 DSH 回复）。各断言独立时间门（since）——
    // tape.wait 取「首个匹配拍」，无门会咬到前序断言的旧事件。
    let gateT = Date.now();
    await bridge('conversation/prompt', { sessionId, text: 'Say PROBE OK. Do not use any tools. (PROBE OK marker)' });
    const endTurn = await tape.wait('conversation-prompt-result', (e) => e.sessionId === sessionId && e.stopReason === 'end_turn', { timeoutMs: 45000, since: gateT });
    const view2 = await sessionById(sessionId);
    const agentText = (view2?.transcript || []).filter((e) => e.kind === 'agent').map((e) => e.text).join('');
    if (endTurn && agentText.includes('PROBE OK')) rep.pass('prompt 流式：agent 文本上窗（累计快照）+ end_turn 收束');
    else rep.fail(`prompt 流式不符：stopReason=${JSON.stringify(endTurn)} agentText=${JSON.stringify(agentText)}`);

    // 断言③ cancel 与收起（验收标准 1 取消语义 + 标准 2 关窗只收起）
    const panelPid = panelPagePid();
    await bridge('conversation/show', { sessionId }); // 先把对话窗开出来（收起断言的前置）
    const convShown = await until(() => (convHwndOf(panelPid) ? true : null), 15000);
    if (convShown) rep.pass('对话窗在场（DECK-CONVERSATION，按 pid+标题甄别）');
    else rep.fail('conversation/show 后对话窗未出现');

    gateT = Date.now();
    await bridge('conversation/prompt', { sessionId, text: 'Count slowly from 1 to 20, one number per line, no tools. (Count slowly marker)' });
    await sleep(2500); // 让慢流真的跑起来
    await bridge('conversation/cancel', { sessionId });
    const cancelled = await tape.wait('conversation-prompt-result', (e) => e.sessionId === sessionId && e.stopReason === 'cancelled', { timeoutMs: 30000, since: gateT });
    const view3 = await until(() => sessionById(sessionId).then((s) => (s && s.status === 'ready' ? s : null)), 15000);
    const pidStillAlive = view3 && typeof view3.backendPid === 'number' && pidAlive(view3.backendPid);
    if (cancelled && view3 && pidStillAlive) rep.pass('取消：stopReason=cancelled + 会话回 ready + 后端进程存活可续用');
    else rep.fail(`取消语义不符：cancelled=${JSON.stringify(cancelled)} status=${view3 && view3.status} pidAlive=${pidStillAlive}`);

    const convWin = convHwndOf(panelPid);
    if (convWin) win32.PostMessageW(convWin, WM_CLOSE, 0, 0);
    const hidden = await until(() => (convHwndOf(panelPid) ? null : true), 8000); // 收起 = 窗口不可见（隐藏），非销毁
    const pidAfterHide = await sessionById(sessionId).then((s) => s && typeof s.backendPid === 'number' && pidAlive(s.backendPid));
    if (hidden && pidAfterHide) rep.pass('关窗只收起：DECK-CONVERSATION 不可见（隐藏）且会话进程仍在');
    else rep.fail(`收起语义不符：hidden=${hidden} pidAfterHide=${pidAfterHide}`);
    await bridge('conversation/show', { sessionId });
    const reshown = await until(() => (convHwndOf(panelPid) ? true : null), 8000);
    if (reshown) rep.pass('再唤回：对话窗重新可见');
    else rep.fail('conversation/show 后对话窗未复现');

    // 断言④ 工具审批（验收标准 1：权限请求原样呈现 + 绝不超时自动拒绝）
    gateT = Date.now();
    await bridge('conversation/prompt', { sessionId, text: 'Write a file to the absolute path required by your task. (outside marker)' });
    const permReq = await tape.wait('conversation-permission-request', (e) => e.sessionId === sessionId, { timeoutMs: 60000, since: gateT });
    const permView = await until(() => sessionById(sessionId).then((s) => (s && s.pendingPermission ? s : null)), 15000);
    const optionIds = permView ? permView.pendingPermission.options.map((o) => o.optionId) : [];
    if (permReq && optionIds.includes('allow-once') && optionIds.includes('reject-once')) {
      rep.pass(`权限请求原样呈现：options=${JSON.stringify(optionIds)}`);
    } else {
      rep.fail(`权限请求未原样到达：req=${JSON.stringify(permReq)} options=${JSON.stringify(optionIds)}`);
    }
    await sleep(1500); // 绝不超时自动拒绝：挂起 1.5s 后请求必须仍在途
    const stillPending = await sessionById(sessionId).then((s) => !!s.pendingPermission);
    if (stillPending) rep.pass('权限挂起 1.5s 仍未被自动裁决（绝不超时自动拒绝）');
    else rep.fail('权限请求在无用户动作时被自动处置（违反 ADR-0018）');
    gateT = Date.now();
    await bridge('conversation/permission', { sessionId, optionId: 'allow-once' });
    const permResolved = await tape.wait('conversation-permission-resolved', (e) => e.sessionId === sessionId && e.optionId === 'allow-once', { timeoutMs: 10000, since: gateT });
    // 升级写与收尾 turn 都在裁决之后：文件轮询 + since 门下的 end_turn（咬旧事件即假绿）
    const allowWorked = await until(() => (fs.existsSync(ESCALATION_FILE) ? true : null), 30000);
    const permTurn = await tape.wait('conversation-prompt-result', (e) => e.sessionId === sessionId && e.stopReason === 'end_turn', { timeoutMs: 60000, since: gateT });
    if (permTurn && allowWorked && permResolved) rep.pass('allow-once 裁决生效：升级写真实落盘 + end_turn + 裁决存证');
    else rep.fail(`审批流不符：turn=${JSON.stringify(permTurn)} fileWritten=${allowWorked} resolved=${JSON.stringify(permResolved)}`);

    // 断言⑤ 显式退出（验收标准 1 结束语义 + 标准 5 元数据）
    const pidBeforeEnd = (await sessionById(sessionId)).backendPid;
    gateT = Date.now();
    await bridge('conversation/end', { sessionId });
    const closeLog = await tape.wait('conversation-session-close', (e) => e.sessionId === sessionId, { timeoutMs: 20000, since: gateT });
    const exitLog = await tape.wait('conversation-process-exit', (e) => e.sessionId === sessionId, { timeoutMs: 30000, since: gateT });
    const endedLog = await tape.wait('conversation-ended', (e) => e.sessionId === sessionId, { timeoutMs: 10000, since: gateT });
    const endedView = await sessionById(sessionId);
    const metaAfter = fs.existsSync(metaFile) ? fs.readFileSync(metaFile, 'utf8') : '';
    if (closeLog && exitLog && exitLog.code === 0 && endedLog) {
      rep.pass('显式退出：session/close + stdin close 自然退出 code=0 + ended 存证');
    } else {
      rep.fail(`退出语义不符：close=${JSON.stringify(closeLog)} exit=${JSON.stringify(exitLog)} ended=${JSON.stringify(endedLog)}`);
    }
    if (endedView && endedView.status === 'ended' && endedView.endedAt > 0
      && metaAfter.includes('"endedAt"') && !pidAlive(pidBeforeEnd)) {
      rep.pass('退出后账目：状态 ended + 元数据 endedAt 落盘 + 进程已退');
    } else {
      rep.fail(`退出后账目不符：status=${endedView && endedView.status} endedAt=${endedView && endedView.endedAt} pidAlive=${pidAlive(pidBeforeEnd)}`);
    }

    // 断言⑥ 进程回收（验收标准 2/5：显式结束回收进程）
    const recycled = !(await sessionById(sessionId)).backendPid && !pidAlive(pidBeforeEnd);
    const panelStillAlive = handle.alive();
    if (recycled && panelStillAlive) rep.pass('进程回收：会话进程消失（backendPid 清空）且面板本体无恙');
    else rep.fail(`回收不符：recycled=${recycled} panelAlive=${panelStillAlive}`);

    // 断言⑦ 全程零管理面（验收标准 4）——工单340 轮校准：元数据行跨轮留存（ended 行随
    // metadata.json 持久），断言改为「无**在场** managed 会话」；否则 #333 轮次遗留的
    // ended managed 行会让本断言历史敏感（2026-10-31 轮 1 FAIL 定责，非产品回归）
    if ((await sessionsView()).every((s) => s.managed === false || s.status === 'ended' || s.status === 'failed')) rep.pass('全程零管理面：无在场会话持有管理标记（历史 ended/failed 行不计——幂等轮次安全）');
    else rep.fail('出现在场 managed 会话（聊天型票面不允许）');

    // ===================================================================
    // 段 C2（工单333，spec #326）：管理型会话只读面板与插件契约——真实 DSH + 罐头 LLM。
    //   ① UI 契约：对话窗「管理」勾选与「以聊天型创建」显式选择在位（构建产物 + DOM）
    //   ② 显式授权创建（managed:true）：wire 存证 managed-created（mcpUrl 回环）+
    //     session/new mcpServers='injected(managed)'；view.managed=true
    //   ③ 凭证零落盘：元数据与事件档全文不含 bearer（红线）
    //   ④ DSH 真调只读工具（面板快照）：managed-tool-call 存证 + 快照键真实回读
    //   ⑤ DSH 真读契约目录：managed-tool-call 存证 + hostApiVersion 回读
    //   ⑥ 投影外未知工具（电池直打宿主）：app_quit → -32602 未知工具；resources/list → -32601
    //   ⑦ 凭证逐会话失效（观察口 bearer 直打）：end A 后旧 bearer 401，B 的 bearer 仍有效
    //   ⑧ 宿主回收：end B（最后管理会话消亡）→ mcpUrl 连接拒绝
    //   ⑨ 聊天型并存零回归：同面板聊天会话 mcpServers 恒空
    //   失败路径（绑定失败/能力缺失/session-new 失败三路全有或全无回滚）为 vitest 覆盖面
    //   （真机无法稳定构造），分工随关票评论留痕。
    // ===================================================================
    rep.beginSegment('C2');
    try {
      // ① UI 契约（构建产物 + 对话窗 DOM）
      const convJs = fs.readFileSync(path.join(APP_ROOT, 'dist', 'renderer', 'conversation.js'), 'utf8');
      const retryInBuild = convJs.includes('以聊天型创建');
      const dom = await cdpEvalOn(CONV_TITLE, '!!document.getElementById("chk-managed") && !!document.getElementById("btn-new")', 10000).catch(() => null);
      if (retryInBuild && dom) rep.pass('UI 契约在位：「管理」勾选 + 「以聊天型创建」显式选择（对话窗 DOM + 构建产物）');
      else rep.fail(`UI 契约缺失：构建产物含重试钮=${retryInBuild} 对话窗 DOM=${JSON.stringify(dom)}`);

      // ② 显式授权创建管理型会话 A
      let gateT = Date.now();
      const createdA = await bridge('conversation/create', { label: 'accept-333a', managed: true });
      if (!createdA.ok) {
        rep.fail(`管理型创建失败：${createdA.error}`);
        throw new Error('C2 中止：管理型会话 A 创建失败');
      }
      const sidA = createdA.session.id;
      const managedCreatedLog = await tape.wait('conversation-managed-created', (e) => e.sessionId === sidA, { timeoutMs: 10000, since: gateT });
      const managedNewLog = await tape.wait('conversation-session-new', (e) => e.sessionId === sidA, { timeoutMs: 10000, since: gateT });
      const viewA = await until(() => sessionById(sidA).then((s) => (s && s.status === 'ready' && s.managed === true ? s : null)), 30000);
      if (managedCreatedLog && managedNewLog && managedNewLog.mcpServers === 'injected(managed)'
        && typeof managedCreatedLog.mcpUrl === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(managedCreatedLog.mcpUrl)
        && viewA) {
        rep.pass(`显式授权创建：managed=true + wire 存证（mcpServers=injected(managed)，mcpUrl=${managedCreatedLog.mcpUrl}）`);
      } else {
        rep.fail(`管理型创建存证不符：created=${JSON.stringify(managedCreatedLog)} new=${JSON.stringify(managedNewLog)} view=${JSON.stringify(viewA && { managed: viewA.managed, status: viewA.status })}`);
      }

      // ③ 凭证零落盘（观察口转交 bearer；元数据与事件档全文不含）
      const bearerA = await until(() => probeBearer(sidA).then((b) => (b ? b : null)), 10000);
      if (!bearerA) {
        rep.fail('观察口未取到 bearer A（probe 未启用或会话未在册）');
        throw new Error('C2 中止：bearer A 缺失');
      }
      const metaText = fs.existsSync(metaFile) ? fs.readFileSync(metaFile, 'utf8') : '';
      const eventsText = fs.existsSync(EVENTS_FILE) ? fs.readFileSync(EVENTS_FILE, 'utf8') : '';
      const bearerCore = bearerA.slice('Bearer '.length);
      if (!metaText.includes(bearerCore) && !eventsText.includes(bearerCore)) rep.pass('凭证零落盘：元数据与事件档全文不含 bearer（观察口仅内存转交）');
      else rep.fail('凭证落盘（红线）：元数据或事件档含 bearer');

      // ④ DSH 真调只读工具（面板快照）
      gateT = Date.now();
      await bridge('conversation/prompt', { sessionId: sidA, text: 'Read the panel snapshot via your MCP tools, then echo the raw tool result verbatim. (MANAGED SNAPSHOT marker)' });
      const snapCall = await tape.wait('managed-tool-call', (e) => e.sessionId === sidA && e.tool === 'panel_snapshot' && e.ok === true, { timeoutMs: 60000, since: gateT });
      const snapTurn = await tape.wait('conversation-prompt-result', (e) => e.sessionId === sidA && e.stopReason === 'end_turn', { timeoutMs: 60000, since: gateT });
      const snapText = await sessionById(sidA).then((s) => (s?.transcript || []).filter((e) => e.kind === 'agent').map((e) => e.text).join(''));
      if (snapCall && snapTurn && snapText.includes('SNAPSHOT-TOOL-RESULT:') && snapText.includes('clock')) {
        rep.pass('DSH 真调只读工具：panel_snapshot 分派存证 + 快照段键（clock）真实回读');
      } else {
        rep.fail(`快照工具链不符：call=${JSON.stringify(snapCall)} turn=${JSON.stringify(snapTurn)} text=${JSON.stringify(snapText.slice(0, 300))}`);
      }

      // ⑤ DSH 真读机器可读契约目录
      gateT = Date.now();
      await bridge('conversation/prompt', { sessionId: sidA, text: 'Read the plugin contract catalog via your MCP tools, then echo the raw tool result verbatim. (MANAGED CATALOG marker)' });
      const catCall = await tape.wait('managed-tool-call', (e) => e.sessionId === sidA && e.tool === 'plugin_contract_catalog' && e.ok === true, { timeoutMs: 60000, since: gateT });
      const catTurn = await tape.wait('conversation-prompt-result', (e) => e.sessionId === sidA && e.stopReason === 'end_turn', { timeoutMs: 60000, since: gateT });
      const catText = await sessionById(sidA).then((s) => (s?.transcript || []).filter((e) => e.kind === 'agent').map((e) => e.text).join(''));
      if (catCall && catTurn && catText.includes('CATALOG-TOOL-RESULT:') && catText.includes('hostApiVersion')) {
        rep.pass('DSH 真读契约目录：plugin_contract_catalog 分派存证 + 目录本体（hostApiVersion）真实回读');
      } else {
        rep.fail(`契约目录工具链不符：call=${JSON.stringify(catCall)} turn=${JSON.stringify(catTurn)} text=${JSON.stringify(catText.slice(0, 300))}`);
      }

      // ⑥ 投影外未知工具（电池直打宿主）：不静默放行、不空成功
      const writeTool = await hostCall(managedCreatedLog.mcpUrl, bearerA, 'tools/call', { name: 'app_quit', arguments: {} });
      const offProto = await hostCall(managedCreatedLog.mcpUrl, bearerA, 'resources/list', {});
      const writeOk = writeTool.status === 200 && writeTool.body && writeTool.body.error && writeTool.body.error.code === -32602
        && /未知工具/.test(writeTool.body.error.message);
      const protoOk = offProto.status === 200 && offProto.body && offProto.body.error && offProto.body.error.code === -32601;
      if (writeOk && protoOk) rep.pass('投影外一律明确错误：app_quit → -32602 未知工具；resources/list → -32601（无静默放行/空成功）');
      else rep.fail(`投影外处置不符：write=${JSON.stringify(writeTool).slice(0, 200)} proto=${JSON.stringify(offProto).slice(0, 200)}`);

      // 创建管理型会话 B（第 ⑦ 步的在场见证者——宿主不随 A 结束而回收）
      gateT = Date.now();
      const createdB = await bridge('conversation/create', { label: 'accept-333b', managed: true });
      if (!createdB.ok) {
        rep.fail(`管理型会话 B 创建失败：${createdB.error}`);
        throw new Error('C2 中止：管理型会话 B 创建失败');
      }
      const sidB = createdB.session.id;
      const bearerB = await until(() => probeBearer(sidB).then((b) => (b ? b : null)), 10000);

      // ⑦ 凭证逐会话失效：end A 后旧 bearerA 401，bearerB 不受影响
      gateT = Date.now();
      await bridge('conversation/end', { sessionId: sidA });
      const endedA = await tape.wait('conversation-ended', (e) => e.sessionId === sidA, { timeoutMs: 30000, since: gateT });
      const oldRejected = await until(() => hostCall(managedCreatedLog.mcpUrl, bearerA, 'tools/list', {}).then((r) => r.status === 401 ? r : null), 15000);
      const bStillValid = await hostCall(managedCreatedLog.mcpUrl, bearerB, 'tools/list', {});
      if (endedA && oldRejected && bStillValid.status === 200 && bStillValid.body && bStillValid.body.result) {
        rep.pass('凭证逐会话失效：A 显式结束后旧 bearer 401（复用被拒），B 的凭证不受影响');
      } else {
        rep.fail(`凭证失效面不符：endedA=${JSON.stringify(endedA)} old=${JSON.stringify(oldRejected && { status: oldRejected.status })} b=${JSON.stringify(bStillValid.status)}`);
      }

      // ⑧ 宿主回收：end B（最后管理会话消亡）→ 监听面消失（连接拒绝）
      gateT = Date.now();
      await bridge('conversation/end', { sessionId: sidB });
      await tape.wait('conversation-ended', (e) => e.sessionId === sidB, { timeoutMs: 30000, since: gateT });
      const hostGone = await until(() => hostCall(managedCreatedLog.mcpUrl, bearerB, 'tools/list', {}).then((r) => (r.status === 0 ? r : null)), 15000);
      if (hostGone) rep.pass(`宿主回收：最后管理会话消亡后监听面消失（连接拒绝：${hostGone.error}）`);
      else rep.fail('宿主未随最后管理会话回收（mcpUrl 仍可达）');

      // ⑨ 聊天型并存零回归：同面板聊天会话 mcpServers 恒空
      gateT = Date.now();
      const chat = await bridge('conversation/create', { label: 'accept-333-chat' });
      if (!chat.ok) {
        rep.fail(`并存聊天会话创建失败：${chat.error}`);
      } else {
        const chatNew = await tape.wait('conversation-session-new', (e) => e.sessionId === chat.session.id && e.mcpServers === 'empty(chat)', { timeoutMs: 10000, since: gateT });
        const chatView = await sessionById(chat.session.id);
        if (chatNew && chatView && chatView.managed === false) rep.pass('聊天型并存零回归：mcpServers 恒空 + managed=false（#332 行为原样）');
        else rep.fail(`并存聊天会话形态不符：new=${JSON.stringify(chatNew)} managed=${chatView && chatView.managed}`);
        await bridge('conversation/end', { sessionId: chat.session.id });
      }
    } catch (c2err) {
      rep.fail(`段 C2 异常中止：${c2err instanceof Error ? c2err.message : String(c2err)}`);
    }

    // —— 段 C4（工单334，ADR-0019 写入契约 / ADR-0025 批准面）：DSH 全链创建零权限插件 ——
    // 真实 DSH + 罐头 LLM：DSH 自身文件工具在会话工作区写包（workspace 内写不触发审批）→
    // MCP plugin_install_submit 提交 → 提案 pending（待装载区纪律）→ 桥上真实用户手势批准 →
    // 原子转正 → 有界激活 → 桌面真显示（deck-pkg://dsh-hello title=deck-pkg:ready）。
    // 执行序在 C3 之前：C3 会以 bogus 后端档重启面板（失败注入段必须最后，防污染本段 DSH 解析）。
    rep.beginSegment('C4');
    try {
      const userPluginsRoot = (() => {
        try { return (JSON.parse(configRaw || '{}').plugins || {}).dir || path.join(userData, 'plugins') } catch { return path.join(userData, 'plugins') }
      })();
      const stagingRoot = path.join(userData, 'plugins-staging');
      // 夹具清场（battery-owned id）：上轮 activation_unknown 按票面「不猜补偿」保留的转正目录
      try { fs.rmSync(path.join(userPluginsRoot, 'dsh-hello'), { recursive: true, force: true }); } catch { /* 尽力 */ }
      try { fs.rmSync(path.join(userPluginsRoot, 'dsh-reject'), { recursive: true, force: true }); } catch { /* 尽力 */ }
      try { fs.rmSync(stagingRoot, { recursive: true, force: true }); } catch { /* 尽力 */ }
      const createC4 = await bridge('conversation/create', { managed: true, label: 'accept-334-install' });
      if (!createC4.ok) {
        rep.fail(`C4 管理型会话创建失败：${createC4.error}`);
      } else {
        const sidC4 = createC4.session.id;
        const sessC4 = await sessionById(sidC4);
        if (!sessC4 || !sessC4.cwd) {
          rep.fail('C4 会话视图/cwd 缺失');
        } else {
          const pkgDirA = path.join(sessC4.cwd, 'dsh-hello-pkg');
          // ① 提交：prompt 触发罐头编排（写 plugin.json + card.js → MCP plugin_install_submit）
          await bridge('conversation/prompt', { sessionId: sidC4, text: `MANAGED INSTALL marker：落零权限插件包并经 plugin_install_submit 提交安装
PKGDIR=${pkgDirA}` });
          const propA = await until(async () => (await bridge('install/list', null)).proposals.find((p) => p.status === 'pending' && p.pkg.id === 'dsh-hello') ?? null, 90000);
          if (!propA) {
            // 诊断转储（排障后保留作证据）：会话转写 + 罐头决策轨迹
            const vdiag = await sessionById(sidC4);
            const agentTexts = (vdiag ? vdiag.transcript : []).map((x) => `${x.kind}:${String(x.text ?? '').slice(0, 120)}`);
            rep.note(`C4 诊断 transcript=${JSON.stringify(agentTexts).slice(0, 700)}`);
            try {
              const diags = (llm.requests ? llm.requests().slice(-9) : []).map((r) => r.diag);
              rep.note(`C4 诊断 canned=${JSON.stringify(diags).slice(0, 700)}`);
            } catch { /* 诊断尽力 */ }
            rep.fail('C4 提案未出现（90s）——罐头编排或 MCP 提交失败');
          } else {
            const filesOk = propA.files.length === 2 && propA.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256));
            const permsOk = Array.isArray(propA.pkg.permissions) && propA.pkg.permissions.length === 0;
            const stagingOk = fs.existsSync(path.join(stagingRoot, propA.proposalId, 'plugin.json'));
            const userRootClean = fs.existsSync(path.join(userPluginsRoot, 'dsh-hello')) === false;
            if (filesOk && permsOk && stagingOk && userRootClean && propA.source.backend === 'dsh') {
              rep.pass(`提案数据面+待装载区纪律：dsh-hello@${propA.pkg.version} pending（2 文件带哈希、零权限、staging 副本在案、用户根未动、来源 dsh 会话 ${propA.source.sessionId.slice(0, 8)}）`);
            } else {
              rep.fail(`C4 数据面不符：files=${filesOk} perms=${permsOk} staging=${stagingOk} userRootClean=${userRootClean} backend=${propA.source.backend}`);
            }
            // ② 哈希同字节（批准前基准）→ 真实用户手势批准
            const beforeHash = propA.hash;
            const approved = await bridge('install/approve', { proposalId: propA.proposalId }, 30000);
            const listed = await until(async () => (await bridge('install/list', null)).proposals.find((p) => p.proposalId === propA.proposalId && p.status === 'activated') ?? null, 30000);
            const activatedEvt = await tape.wait('dropped-package-activated', (e) => e.id === 'dsh-hello', { timeoutMs: 30000, since: Date.now() - 30000 });
            // ③ 桌面真显示：面板 CDP 目标表里有 deck-pkg://dsh-hello/ 且 title=deck-pkg:ready
            let pkgTitle = null;
            try {
              const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
              const t = targets.find((x) => typeof x.url === 'string' && x.url.startsWith('deck-pkg://dsh-hello/'));
              pkgTitle = t ? t.title : null;
            } catch { pkgTitle = null }
            if (approved && approved.ok === true && approved.status === 'activated' && listed
              && listed.hash === beforeHash && activatedEvt && pkgTitle === 'deck-pkg:ready') {
              rep.pass(`批准全链真显示：哈希同字节绑定（${beforeHash.slice(0, 12)}）→ 转正激活（dropped-package-activated 存证）→ deck-pkg://dsh-hello title=deck-pkg:ready`);
            } else {
              rep.fail(`C4 批准链不符：approved=${JSON.stringify(approved)} activated=${Boolean(listed)} hashSame=${listed ? listed.hash === beforeHash : 'n/a'} evt=${Boolean(activatedEvt)} title=${pkgTitle}`);
            }
          }
          // ④ 拒绝路径：第二包提交 → 拒绝 → staging 清偿 + 用户根从未出现 + gate_denied 审计
          const pkgDirB = path.join(sessC4.cwd, 'dsh-reject-pkg');
          await bridge('conversation/prompt', { sessionId: sidC4, text: `MANAGED INSTALL marker：落零权限插件包并经 plugin_install_submit 提交安装
PKGDIR=${pkgDirB}
PKGID=dsh-reject` });
          const propB = await until(async () => (await bridge('install/list', null)).proposals.find((p) => p.status === 'pending' && p.pkg.id === 'dsh-reject' && p.source.sessionId === sidC4) ?? null, 90000);
          if (!propB) {
            const vdiagB = await sessionById(sidC4);
            const agentTextsB = (vdiagB ? vdiagB.transcript : []).map((x) => `${x.kind}:${String(x.text ?? '').slice(0, 100)}`);
            rep.note(`C4 拒绝诊断 transcript=${JSON.stringify(agentTextsB).slice(0, 800)}`);
            try {
              const diagsB = (llm.requests ? llm.requests().slice(-5) : []).map((r) => r.diag);
              rep.note(`C4 拒绝诊断 canned=${JSON.stringify(diagsB).slice(0, 1100)}`);
            } catch { /* 诊断尽力 */ }
            rep.fail('C4 拒绝路径提案未出现（90s）');
          } else {
            const gateT4 = Date.now();
            const rejected = await bridge('install/reject', { proposalId: propB.proposalId });
            const denied = await tape.wait('plugin-install-outcome', (e) => e.proposalId === propB.proposalId && e.outcome === 'gate_denied', { timeoutMs: 15000, since: gateT4 });
            const stagingClean = fs.existsSync(path.join(stagingRoot, propB.proposalId)) === false;
            // 拒绝包 id 是 dsh-reject（dsh-hello 是①批准在案的合法目录，不能当残留判据）
            const userRootStillClean = fs.existsSync(path.join(userPluginsRoot, 'dsh-reject')) === false;
            if (rejected && rejected.ok === true && denied && stagingClean && userRootStillClean) {
              rep.pass('拒绝路径补偿完备：副本清偿 + 用户根从未出现 + gate_denied 审计在案');
            } else {
              rep.fail(`C4 拒绝面不符：rejected=${JSON.stringify(rejected)} denied=${Boolean(denied)} stagingClean=${stagingClean} userClean=${userRootStillClean}`);
            }
          }
          // ⑤ 坏 manifest（invalid_package）面收缩出真机段（2026-10-31 五轮真机排障后留痕）：
          // 单测 install.spec.ts 已全覆盖（坏 JSON→invalid_package+issues+副本清偿），MCP 提交通路
          // 已由本段①③两轮真机证明——真机子轮无增量覆盖价值（章法「单测能覆盖的不进电池」）。
          await bridge('conversation/end', { sessionId: sidC4 });
        }
      }
    } catch (c4err) {
      rep.fail(`段 C4 异常中止：${c4err instanceof Error ? c4err.message : String(c4err)}`);
    }

    // —— 段 C5（工单335，ADR-0019 update 换入 / ADR-0025 代次批准）：DSH 更新已装包全链 ——
    // 前提：C4 已安装 dsh-hello@1.0.0（批准激活、deck-pkg://dsh-hello 真显示）。执行序在 C3
    // 之前（同 C4 理由：C3 会以 bogus 后端档重启面板，失败注入段必须最后）。罐头编排：
    // 写新版字节 → MCP plugin_update_submit → 提案带旧→新 diff 与权限变化（批准 UI 数据面）
    // → 待批期间旧代次仍跑（CDP title 仍 deck-pkg:ready）→ 批准 = 原子换代（generation≥2
    // 激活存证 + 新代次 mount）→ 同字节再提交 → no_change（不重载、不制造提案）→ 卸载 →
    // 回收站 → 清单消失（用户根目录消失 + deactivated(reason=removed) + 上下文拆除）。
    rep.beginSegment('C5');
    try {
      const userPluginsRoot5 = (() => {
        try { return (JSON.parse(configRaw || '{}').plugins || {}).dir || path.join(userData, 'plugins') } catch { return path.join(userData, 'plugins') }
      })();
      const pkgTarget5 = path.join(userPluginsRoot5, 'dsh-hello');
      if (!fs.existsSync(path.join(pkgTarget5, 'plugin.json'))) {
        rep.fail('C5 前提不成立：C4 安装的 dsh-hello 不在用户根（C4 未绿或夹具被清）');
      } else {
        const createC5 = await bridge('conversation/create', { managed: true, label: 'accept-335-update' });
        if (!createC5.ok) {
          rep.fail(`C5 管理型会话创建失败：${createC5.error}`);
        } else {
          const sidC5 = createC5.session.id;
          const sessC5 = await sessionById(sidC5);
          if (!sessC5 || !sessC5.cwd) {
            rep.fail('C5 会话视图/cwd 缺失');
          } else {
            const pkgDirU = path.join(sessC5.cwd, 'dsh-hello-pkg');
            // ① 更新提交：罐头写新版字节（card.js v2 文本 + version 1.1.0）→ MCP plugin_update_submit
            await bridge('conversation/prompt', { sessionId: sidC5, text: `MANAGED UPDATE marker：更新已安装插件包（落新版包目录并经 plugin_update_submit 提交）
PKGDIR=${pkgDirU}` });
            const propU = await until(async () => (await bridge('install/list', null)).proposals.find((p) => p.status === 'pending' && p.pkg.id === 'dsh-hello' && p.update) ?? null, 90000);
            if (!propU) {
              // 诊断转储（排障后保留作证据）：会话转写 + 罐头决策轨迹
              const vdiag5 = await sessionById(sidC5);
              rep.note(`C5 诊断 transcript=${JSON.stringify((vdiag5 ? vdiag5.transcript : []).map((x) => `${x.kind}:${String(x.text ?? '').slice(0, 120)}`)).slice(0, 700)}`);
              try {
                const diags5 = (llm.requests ? llm.requests().slice(-9) : []).map((r) => r.diag);
                rep.note(`C5 诊断 canned=${JSON.stringify(diags5).slice(0, 700)}`);
              } catch { /* 诊断尽力 */ }
              rep.fail('C5 更新提案未出现（90s）——罐头编排或 MCP 提交失败');
            } else {
              const diffOk = Boolean(propU.update)
                && propU.update.oldVersion === '1.0.0' && propU.update.newVersion === '1.1.0'
                && Array.isArray(propU.update.files.changed) && propU.update.files.changed.includes('card.js')
                && propU.update.permissions.added.length === 0 && propU.update.permissions.removed.length === 0;
              // ② 待批旧代次仍在：提案期间 deck-pkg://dsh-hello 的 title 仍 deck-pkg:ready
              const oldTitlePending = await until(async () => {
                try {
                  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
                  const t = targets.find((x) => typeof x.url === 'string' && x.url.startsWith('deck-pkg://dsh-hello/'));
                  return t && t.title === 'deck-pkg:ready' ? true : null;
                } catch { return null }
              }, 8000);
              if (diffOk && oldTitlePending) {
                rep.pass(`更新提案数据面+待批旧代次仍在：1.0.0→1.1.0 diff（card.js 变更、权限变化空）在批准 UI 数据面；待批期间旧代次 deck-pkg:ready 继续运行`);
              } else {
                rep.fail(`C5 更新提案面不符：diff=${JSON.stringify(propU.update)} oldTitlePending=${Boolean(oldTitlePending)}`);
              }
              // ③ 批准 → 原子换代：generation≥2 激活存证 + 新代次 mount（title 仍 ready）
              const gateT5 = Date.now();
              const approvedU = await bridge('install/approve', { proposalId: propU.proposalId }, 30000);
              const activatedU = await tape.wait('dropped-package-activated', (e) => e.id === 'dsh-hello' && Number(e.generation) >= 2, { timeoutMs: 30000, since: gateT5 });
              const newTitleReady = await until(async () => {
                try {
                  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
                  const t = targets.find((x) => typeof x.url === 'string' && x.url.startsWith('deck-pkg://dsh-hello/'));
                  return t && t.title === 'deck-pkg:ready' ? true : null;
                } catch { return null }
              }, 15000);
              if (approvedU && approvedU.ok === true && approvedU.status === 'activated' && activatedU && newTitleReady) {
                rep.pass(`批准=原子换代：activated（dropped-package-activated generation=${activatedU.generation} 存证）+ 新代次 mount（deck-pkg:ready）`);
              } else {
                rep.fail(`C5 批准换代不符：approved=${JSON.stringify(approvedU)} activated=${JSON.stringify(activatedU)} newTitle=${Boolean(newTitleReady)}`);
              }
              // ④ 同字节再提交 → no_change：工具结果如实 no_change（不重载、不制造提案）
              await bridge('conversation/prompt', { sessionId: sidC5, text: `MANAGED NOCHANGE marker：把同一份包目录原样再提交一次更新
PKGDIR=${pkgDirU}` });
              const nochangeText = await until(() => sessionById(sidC5).then((s) => {
                const t = (s?.transcript || []).filter((e) => e.kind === 'agent').map((e) => e.text).join('');
                return t.includes('no_change') ? t : null;
              }), 60000);
              const stillNoPending = await bridge('install/list', null).then((r) => !r.proposals.some((p) => p.status === 'pending' && p.pkg.id === 'dsh-hello'));
              if (nochangeText && stillNoPending) {
                rep.pass('相同字节 no_change：工具结果如实 no_change（不重载、不制造批准提案）');
              } else {
                rep.fail(`C5 no_change 面不符：text=${nochangeText ? 'no_change 回读' : 'missing'} noPending=${stillNoPending}`);
              }
              // ⑤ 卸载 → 回收站 → 清单消失
              await bridge('conversation/prompt', { sessionId: sidC5, text: `MANAGED UNINSTALL marker：卸载该插件包
PKGID=dsh-hello` });
              const unText = await until(() => sessionById(sidC5).then((s) => {
                const t = (s?.transcript || []).filter((e) => e.kind === 'agent').map((e) => e.text).join('');
                return t.includes('UNINSTALL-DONE') ? t : null;
              }), 60000);
              const goneFromRoot = await until(() => (!fs.existsSync(path.join(pkgTarget5, 'plugin.json')) ? true : null), 15000);
              const deactivatedEvt = await tape.wait('dropped-package-deactivated', (e) => e.id === 'dsh-hello' && e.reason === 'removed', { timeoutMs: 15000, since: Date.now() - 20000 });
              const targetGone = await until(async () => {
                try {
                  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
                  return targets.some((x) => typeof x.url === 'string' && x.url.startsWith('deck-pkg://dsh-hello/')) ? null : true;
                } catch { return null }
              }, 15000);
              if (unText && goneFromRoot && deactivatedEvt && targetGone) {
                rep.pass('卸载全链清单消失：MCP plugin_uninstall → 用户根目录消失（回收站路径，失败即失败）+ deactivated(reason=removed) 存证 + deck-pkg://dsh-hello 上下文拆除');
              } else {
                rep.fail(`C5 卸载面不符：unText=${Boolean(unText)} goneFromRoot=${goneFromRoot} deactivated=${JSON.stringify(deactivatedEvt)} targetGone=${Boolean(targetGone)}`);
              }
            }
            await bridge('conversation/end', { sessionId: sidC5 });
          }
        }
      }
    } catch (c5err) {
      rep.fail(`段 C5 异常中止：${c5err instanceof Error ? c5err.message : String(c5err)}`);
    }

    // —— 段 C6（工单336，ADR-0025 媒体节）：媒体信息卡与 media.read——首个敏感权限完整闭环。
    // 真实 DSH + 罐头 LLM：罐头写 media 包（permissions=['media.read'] + capabilities=['media']）
    // → MCP plugin_install_submit → 提案权限栏 media.read（敏感通路不再 permission_deferred）
    // → 批准落授权账（id+权限集合+代码哈希）→ 转正激活 → 卡真显示（真机需真实 SMTC 会话：
    // 隔离 profile Edge 播本地小 wav，低音量 0.04、循环 5s 文件，测完 taskkill 进程树）→
    // 受控缩略图链（deckHost.media.thumbnail → Broker 校验 → 字节副本）+ 审计存证 →
    // 撤销即停（授权账撤销 → rescan 停用缝 → deactivated(permission-revoked) + CDP 目标消失）。
    // 执行序 C5 后 C3 前（C3 bogus 重启面板必须最后）。无会话/无缩略图/会话退出=卡片明确态
    // （环境可能有在播会话——empty 态断言为「明确态二选一」，live 断言锚定夹具曲名）。
    rep.beginSegment('C6');
    let mediaFixture = null;
    try {
      const userPluginsRoot6 = (() => {
        try { return (JSON.parse(configRaw || '{}').plugins || {}).dir || path.join(userData, 'plugins') } catch { return path.join(userData, 'plugins') }
      })();
      const stagingRoot6 = path.join(userData, 'plugins-staging');
      // 夹具清场（battery-owned id：dsh-media；上轮撤销后用户根无目录属正常，残留则清）
      try { fs.rmSync(path.join(userPluginsRoot6, 'dsh-media'), { recursive: true, force: true }); } catch { /* 尽力 */ }
      try { fs.rmSync(stagingRoot6, { recursive: true, force: true }); } catch { /* 尽力 */ }

      const createC6 = await bridge('conversation/create', { managed: true, label: 'accept-336-media' });
      if (!createC6.ok) {
        rep.fail(`C6 管理型会话创建失败：${createC6.error}`);
      } else {
        const sidC6 = createC6.session.id;
        const sessC6 = await sessionById(sidC6);
        if (!sessC6 || !sessC6.cwd) {
          rep.fail('C6 会话视图/cwd 缺失');
        } else {
          const pkgDirM = path.join(sessC6.cwd, 'dsh-media-pkg');
          // ① 提交：罐头写 media 包（敏感权限清单）→ MCP plugin_install_submit
          await bridge('conversation/prompt', { sessionId: sidC6, text: `MANAGED MEDIA marker：落带 media.read 权限的媒体信息卡包并经 plugin_install_submit 提交安装
PKGDIR=${pkgDirM}` });
          const propM = await until(async () => (await bridge('install/list', null)).proposals.find((p) => p.status === 'pending' && p.pkg.id === 'dsh-media') ?? null, 90000);
          if (!propM) {
            const vdiagM = await sessionById(sidC6);
            rep.note(`C6 诊断 transcript=${JSON.stringify((vdiagM ? vdiagM.transcript : []).map((x) => `${x.kind}:${String(x.text ?? '').slice(0, 120)}`)).slice(0, 700)}`);
            try {
              const diagsM = (llm.requests ? llm.requests().slice(-9) : []).map((r) => r.diag);
              rep.note(`C6 诊断 canned=${JSON.stringify(diagsM).slice(0, 700)}`);
            } catch { /* 诊断尽力 */ }
            rep.fail('C6 media.read 提案未出现（90s）——罐头编排或 MCP 提交失败');
          } else {
            const permsOk = Array.isArray(propM.pkg.permissions) && propM.pkg.permissions.length === 1 && propM.pkg.permissions[0] === 'media.read';
            const stagingOk = fs.existsSync(path.join(stagingRoot6, propM.proposalId, 'plugin.json'));
            const userRootClean = fs.existsSync(path.join(userPluginsRoot6, 'dsh-media')) === false;
            if (permsOk && stagingOk && userRootClean && propM.source.backend === 'dsh') {
              rep.pass(`media.read 提案数据面（敏感通路打开）：dsh-media@${propM.pkg.version} pending，权限栏 [media.read]（不再 permission_deferred），staging 副本在案、用户根未动、来源 dsh 会话`);
            } else {
              rep.fail(`C6 提案面不符：perms=${JSON.stringify(propM.pkg.permissions)} staging=${stagingOk} userRootClean=${userRootClean} backend=${propM.source.backend}`);
            }
            // ② 批准（同一份字节哈希绑定 → 授权账落账）→ 转正激活 → 桌面真显示
            const gateT6 = Date.now();
            const beforeHash6 = propM.hash;
            const approvedM = await bridge('install/approve', { proposalId: propM.proposalId }, 30000);
            const activatedM = await tape.wait('dropped-package-activated', (e) => e.id === 'dsh-media', { timeoutMs: 30000, since: gateT6 });
            const targetM = await until(async () => {
              const t = await pkgTarget('deck-pkg://dsh-media/');
              return t && t.title === 'deck-pkg:ready' ? t : null;
            }, 20000);
            if (approvedM && approvedM.ok === true && approvedM.status === 'activated'
              && activatedM && targetM) {
              rep.pass(`批准全链（授权账绑定 id+权限+代码哈希 ${beforeHash6.slice(0, 12)}）→ 转正激活（generation=${activatedM.generation}）→ deck-pkg://dsh-media title=deck-pkg:ready`);
            } else {
              rep.fail(`C6 批准链不符：approved=${JSON.stringify(approvedM)} activated=${Boolean(activatedM)} target=${Boolean(targetM)}`);
            }
            // ③ 卡真显示（明确状态面）：Edge 未起 → 卡呈现明确态（环境无在播会话=空态文案；
            //    有在播会话=会话行——两者都是可表示状态）；起真实 SMTC 夹具 → 夹具曲名上卡。
            const stateOk = await until(async () => {
              try {
                const t = await pkgTarget('deck-pkg://dsh-media/');
                if (!t) return null;
                const v = await cdpEvalTarget(t, '(() => { const c = document.querySelector(".media-card"); return c ? (c.className.includes("media-empty") ? "empty" : (document.querySelectorAll(".media-session").length > 0 ? "live" : "boot")) : "none" })()', 8000);
                return v === 'empty' || v === 'live' ? v : null;
              } catch { return null }
            }, 20000);
            if (stateOk) rep.pass(`卡片明确状态面（Edge 未起）：${stateOk === 'empty' ? '无会话明确态「没有正在播放的媒体」' : '环境在播会话的会话行'}——无会话/会话在场均可表示`);
            else rep.fail('C6 卡片未呈现明确状态（boot/none 超 20s）——view.media 未达包页或卡未挂载');
            try { mediaFixture = await startMediaFixture(); } catch (errM) {
              rep.fail(`C6 媒体夹具起不来：${errM instanceof Error ? errM.message : String(errM)}`);
            }
            if (mediaFixture) {
              rep.note(`C6 媒体夹具：Edge pid=${mediaFixture.pid} 低音量 0.04 循环 5s wav（测完进程树强杀）`);
              let lastSeen6 = null;
              const liveOk = await until(async () => {
                try {
                  const t = await pkgTarget('deck-pkg://dsh-media/');
                  if (!t) return null;
                  const st = await cdpEvalTarget(t, '(() => { const rows = [...document.querySelectorAll(".media-session")]; const hit = rows.find((r) => r.querySelector(".media-title") && r.querySelector(".media-title").textContent === "T336 Accept Track"); return hit ? (hit.querySelector(".media-status") || {}).textContent || "?" : null })()', 8000);
                  // 取样口径（工单337 收尾）：只认 PLAYING 终态——行刚出现时可能处在
                  // CHANGING（真实的过渡状态，不是失败），旧口径「首个非 null 即返回」会
                  // 把过渡态当结论判红。
                  lastSeen6 = st;
                  return st === 'PLAYING' ? st : null;
                } catch { return null }
              }, 45000);
              if (liveOk === 'PLAYING') {
                rep.pass('卡真显示全部会话：夹具 SMTC 会话上卡（title=T336 Accept Track，status=PLAYING，position+lastUpdatedTime 插值走时长行）');
              } else {
                // 决定性诊断：卡片页实见的 deckHost.media 数据面 + DOM 现状（拆「投喂断」vs「渲染断」）
                try {
                  const t = await pkgTarget('deck-pkg://dsh-media/');
                  const seen = t ? await cdpEvalTarget(t, '(() => { const rows = [...document.querySelectorAll(".media-session")].map((r) => (r.querySelector(".media-title") || {}).textContent); return JSON.stringify({ rows, card: (document.querySelector(".media-card") || {}).className, hasHost: Boolean(window.deckHost && window.deckHost.media) }) })()', 8000) : 'no-target';
                  rep.note(`C6 ④诊断 卡片实见=${String(seen).slice(0, 500)}`);
                } catch (errD) { rep.note(`C6 ④诊断 CDP 失败：${errD instanceof Error ? errD.message : String(errD)}`); }
                rep.fail(`C6 夹具会话未上卡（45s）：status=${JSON.stringify(liveOk)} 末次取样=${JSON.stringify(lastSeen6)}——诊断见上`);
              }
              // ④ 受控缩略图链 + 审计存证
              const thumbOk = await until(async () => {
                try {
                  const t = await pkgTarget('deck-pkg://dsh-media/');
                  if (!t) return null;
                  return await cdpEvalTarget(t, '(() => { const img = document.querySelector(".media-thumb-img"); return img && String(img.src || "").startsWith("data:image/") ? String(img.src).slice(0, 30) : null })()', 8000);
                } catch { return null }
              }, 30000);
              const auditThumb = await tape.wait('media-audit-aggregate', (e) => e.packageId === 'dsh-media' && e.counts && Number(e.counts.thumbnail) >= 1, { timeoutMs: 20000, since: Date.now() - 30000 });
              if (thumbOk && auditThumb) {
                rep.pass(`受控缩略图链：deckHost.media.thumbnail → Broker 类型/大小校验 → 字节副本 dataURL 上卡（${String(thumbOk).slice(0, 22)}…）+ media-audit-aggregate 存证（thumbnail 计数≥1，按包聚合不含媒体元数据）`);
              } else {
                rep.fail(`C6 缩略图链不符：thumb=${Boolean(thumbOk)} audit=${JSON.stringify(auditThumb)}`);
              }
              // ⑤ 撤销即停（授权账撤销 → rescan 停用缝 → 上下文拆除；grants 行留痕）
              const gateR6 = Date.now();
              const revoked = await bridge('install/revoke', { packageId: 'dsh-media' });
              const deactivatedM = await tape.wait('dropped-package-deactivated', (e) => e.id === 'dsh-media' && e.reason === 'permission-revoked', { timeoutMs: 15000, since: gateR6 });
              const targetGone6 = await until(async () => ((await pkgTarget('deck-pkg://dsh-media/')) ? null : true), 15000);
              const grants6 = await bridge('install/grants', null);
              const row6 = (grants6 && grants6.grants || []).find((g) => g.packageId === 'dsh-media');
              if (revoked && revoked.ok === true && deactivatedM && targetGone6 && row6 && row6.revokedAt > 0) {
                rep.pass(`撤销即停（撤销即断供零窗口）：install/revoke → deactivated(reason=permission-revoked) 存证 + deck-pkg://dsh-media 上下文拆除 + 授权账行 revokedAt 在案（审计可见）`);
              } else {
                rep.fail(`C6 撤销面不符：revoked=${JSON.stringify(revoked)} deactivated=${JSON.stringify(deactivatedM)} targetGone=${Boolean(targetGone6)} grantRow=${JSON.stringify(row6)}`);
              }
            }
          }
          await bridge('conversation/end', { sessionId: sidC6 });
        }
      }
    } catch (c6err) {
      rep.fail(`段 C6 异常中止：${c6err instanceof Error ? c6err.message : String(c6err)}`);
    } finally {
      // 媒体纪律：夹具进程树强杀 + 临时 profile 删除 + 本地服务关停（用完即杀，零残留）
      try { if (mediaFixture) await mediaFixture.stop(); } catch { /* 尽力 */ }
    }

    // —— 段 C7（工单337，media.control 可选权限逐项批准）：双包对照——
    // A 包（media.read 必需，无可选）批准后卡片只读（无控制按钮 + 控制调用拒付）；
    // B 包（+optionalPermissions [media.control]）以 grantPermissions 子集批准 → 控制按钮
    // 渲染 → 控制命令对 SMTC 源夹具真生效（暂停/播放状态翻转）+ 审计 control 族计数。
    rep.beginSegment('C7');
    try {
      // 夹具清场（battery-owned ids）：上轮批准/安装残留会让本轮 id_conflict（C4/C6 同款教训）
      const userPluginsRoot7 = (() => {
        try { return (JSON.parse(configRaw || '{}').plugins || {}).dir || path.join(userData, 'plugins') } catch { return path.join(userData, 'plugins') }
      })();
      for (const fid of ['dsh-media', 'dsh-media-ctl']) {
        try { fs.rmSync(path.join(userPluginsRoot7, fid), { recursive: true, force: true }); } catch { /* 尽力 */ }
      }
      try { fs.rmSync(path.join(userData, 'plugins-staging'), { recursive: true, force: true }); } catch { /* 尽力 */ }
      const createC7 = await bridge('conversation/create', { managed: true, label: 'accept-337-control' });
      if (!createC7.ok) {
        rep.fail(`C7 管理型会话创建失败：${createC7.error}`);
      } else {
        const sidC7 = createC7.session.id;
        const sessC7 = await sessionById(sidC7);
        if (!sessC7 || !sessC7.cwd) {
          rep.fail('C7 会话视图/cwd 缺失');
        } else {
          // ① A 包（只读对照）：无可选权限声明
          const pkgDirA = path.join(sessC7.cwd, 'dsh-media-pkg');
          const promptA7 = await bridge('conversation/prompt', { sessionId: sidC7, text: `MANAGED MEDIA marker：落媒体信息卡包并经 plugin_install_submit 提交安装\nPKGDIR=${pkgDirA}\nPKGID=dsh-media` });
          if (!promptA7 || promptA7.ok !== true) rep.note(`C7 诊断 A prompt 应答：${JSON.stringify(promptA7)}`);
          const dumpA7 = async () => {
            const v = await sessionById(sidC7);
            rep.note(`C7 A 诊断 transcript=${JSON.stringify((v ? v.transcript : []).map((x) => `${x.kind}:${String(x.text ?? '').slice(0, 120)}`)).slice(0, 800)}`);
            try { rep.note(`C7 A 诊断 canned=${JSON.stringify((llm.requests ? llm.requests().slice(-4) : []).map((r) => r.diag)).slice(0, 800)}`); } catch { }
          };
          const propA7 = await until(async () => (await bridge('install/list', null)).proposals.find((p) => p.status === 'pending' && p.pkg.id === 'dsh-media') ?? null, 90000);
          if (!propA7) {
            await dumpA7();
            rep.fail('C7 A 包提案未出现（90s）');
          } else {
            await dumpA7();
            const optOkA = Array.isArray(propA7.pkg.optionalPermissions) && propA7.pkg.optionalPermissions.length === 0;
            const approvedA = await bridge('install/approve', { proposalId: propA7.proposalId }, 30000);
            await until(async () => (await bridge('install/list', null)).proposals.find((p) => p.proposalId === propA7.proposalId && p.status === 'activated') ?? null, 30000);
            // A 包只读面：卡片无控制按钮 + 控制调用拒付（media_permission_denied）
            const ctlOkA = await until(async () => {
              try {
                const t = await pkgTarget('deck-pkg://dsh-media/');
                if (!t) return null;
                return await cdpEvalTarget(t, '(() => ({ btns: document.querySelectorAll(".media-control-btn").length, cls: (document.querySelector(".media-card") || {}).className }))()', 8000);
              } catch { return null }
            }, 20000);
            const deniedA = await cdpEvalOn(PANEL_TITLE, 'window.deck.bridge.invoke("install/grants", null)', 10000).then((g) => {
              const row = ((g && g.grants) || []).find((x) => x.packageId === 'dsh-media');
              return row && !(row.permissions || []).includes('media.control') ? true : null;
            }).catch(() => null);
            if (optOkA && approvedA && approvedA.ok === true && ctlOkA && ctlOkA.btns === 0 && deniedA) {
              rep.pass('A 包只读对照：提案无可选权限、批准后卡片无控制按钮、授权账不含 media.control（逐项批准语义成立）');
            } else {
              rep.fail(`C7 A 包面不符：opt=${optOkA} approved=${JSON.stringify(approvedA && { ok: approvedA.ok })} ctl=${JSON.stringify(ctlOkA)} denied=${deniedA}`);
            }
            // ② B 包（+可选 media.control）：WITHCONTROL 变体 → grantPermissions 子集批准
            const pkgDirB = path.join(sessC7.cwd, 'dsh-media-ctl-pkg');
            // A turn 收束竞态防护：等会话回 ready 再发（prompt 返回=turn 已启动非已收束）
            await until(async () => ((await sessionById(sidC7))?.status === 'ready') ? true : null, 30000);
            const promptB7 = await until(async () => {
              const r = await bridge('conversation/prompt', { sessionId: sidC7, text: `MANAGED MEDIA marker WITHCONTROL：落媒体信息卡包并经 plugin_install_submit 提交安装\nPKGDIR=${pkgDirB}\nPKGID=dsh-media-ctl` });
              return r && r.ok === true ? r : null;
            }, 30000);
            if (!promptB7) rep.note('C7 诊断 B prompt 重试窗内未成功（busy/错误）');
            const propB7 = await until(async () => (await bridge('install/list', null)).proposals.find((p) => p.status === 'pending' && p.pkg.id === 'dsh-media-ctl') ?? null, 90000);
            if (!propB7) {
              const vdiagB7 = await sessionById(sidC7);
              const textsB7 = (vdiagB7 ? vdiagB7.transcript : []).map((x) => `${x.kind}:${String(x.text ?? '').slice(0, 140)}`);
              rep.note(`C7 B 诊断 transcript=${JSON.stringify(textsB7).slice(0, 900)}`);
              try {
                const diagsB7 = (llm.requests ? llm.requests().slice(-6) : []).map((r) => r.diag);
                rep.note(`C7 B 诊断 canned=${JSON.stringify(diagsB7).slice(0, 900)}`);
              } catch { /* 尽力 */ }
              rep.fail('C7 B 包提案未出现（90s）');
            } else {
              const optOkB = Array.isArray(propB7.pkg.optionalPermissions) && propB7.pkg.optionalPermissions.includes('media.control');
              const approvedB = await bridge('install/approve', { proposalId: propB7.proposalId, grantPermissions: ['media.control'] }, 30000);
              await until(async () => (await bridge('install/list', null)).proposals.find((p) => p.proposalId === propB7.proposalId && p.status === 'activated') ?? null, 30000);
              // SMTC 源夹具（控制目标；低音量小文件、用完即杀）
              let fixture7 = null;
              try { fixture7 = await startMediaFixture(); } catch (errF) {
                rep.fail(`C7 媒体夹具起不来：${errF instanceof Error ? errF.message : String(errF)}`);
              }
              if (fixture7) {
                rep.note(`C7 SMTC 源夹具：pid=${fixture7.pid}（控制目标；测完优雅停+进程树清）`);
                await until(async () => (await pkgTarget('deck-pkg://dsh-media-ctl/')) ? true : null, 20000);
                // B 包卡片：控制按钮渲染（controlGranted=true）。
                // 取样口径（工单337 收尾）：等 ≥2 个按钮的视图落地再判——激活后包页
                // 首帧可能还没收到带 controlGranted 的 view，旧口径「首个非 null 即返回」
                // 会把 {btns:0} 的启动态当结论判红。
                let lastBtns7 = null;
                const btnsOk = await until(async () => {
                  try {
                    const t = await pkgTarget('deck-pkg://dsh-media-ctl/');
                    if (!t) return null;
                    const seen = await cdpEvalTarget(t, '(() => ({ btns: document.querySelectorAll(".media-control-btn").length }))()', 8000);
                    lastBtns7 = seen;
                    return seen && seen.btns >= 2 ? seen : null;
                  } catch { return null }
                }, 20000);
                // 找夹具会话键（卡片行 data-key，title=T336 Accept Track）
                const fxKey = await until(async () => {
                  try {
                    const t = await pkgTarget('deck-pkg://dsh-media-ctl/');
                    if (!t) return null;
                    return await cdpEvalTarget(t, '(() => { const rows = [...document.querySelectorAll(".media-session")]; const hit = rows.find((r) => (r.querySelector(".media-title") || {}).textContent === "T336 Accept Track"); return hit ? hit.getAttribute("data-key") : null })()', 8000);
                  } catch { return null }
                }, 30000);
                // 控制真生效：pause → 行状态 PAUSED → play → PLAYING。
                // 断言口径两条铁律（工单337 排障留痕）：①状态词表大写（Broker DTO 归一
                // PLAYING/PAUSED…，旧口径 'Paused' 必然假红）②传播是异步的（control 应答 →
                // 快照重取 → 包页重渲），卡内自轮询而非 Promise 一落地即取样。单次尝试只发
                // 一发命令（按包限流 5/s），外层 until 负责重试。
                let paused = false, played = false;
                if (fxKey) {
                  const waitStatusAfter = (act, want) => until(async () => {
                    try {
                      const t = await pkgTarget('deck-pkg://dsh-media-ctl/');
                      if (!t) return null;
                      const r = await cdpEvalTarget(t, `(async () => {
                        const key = ${JSON.stringify(fxKey)}
                        const ctl = await window.deckHost.media.control(key, ${JSON.stringify(act)})
                        if (!ctl || ctl.ok !== true) return 'control:' + JSON.stringify(ctl || null)
                        const t0 = Date.now()
                        let last = 'no-row'
                        while (Date.now() - t0 < 8000) {
                          const row = [...document.querySelectorAll('.media-session')].find((el) => el.getAttribute('data-key') === key)
                          last = row ? String((row.querySelector('.media-status') || {}).textContent || '') : 'no-row'
                          if (last === ${JSON.stringify(want)}) return true
                          await new Promise((res) => setTimeout(res, 120))
                        }
                        return 'stuck:' + last
                      })()`, 12000);
                      if (r === true) return true;
                      rep.note(`C7 ④诊断 ${act}→${want} 未达：${String(r).slice(0, 200)}`);
                      return null;
                    } catch (err) { return null }
                  }, 25000);
                  paused = Boolean(await waitStatusAfter('pause', 'PAUSED'));
                  played = Boolean(await waitStatusAfter('play', 'PLAYING'));
                }
                const seenB = await (async () => {
                  try {
                    const t = await pkgTarget('deck-pkg://dsh-media-ctl/');
                    if (!t) return 'no-target';
                    return await cdpEvalTarget(t, 'JSON.stringify(window.__mediaView)', 8000);
                  } catch (e) { return 'eval-err:' + String(e).slice(0, 80) }
                })();
                if (!(btnsOk && btnsOk.btns >= 2)) rep.note(`C7 ④诊断 B 卡实见=${String(seenB).slice(0, 400)}`);
                const auditCtl = await tape.wait('media-audit-aggregate', (e) => e.packageId === 'dsh-media-ctl' && JSON.stringify(e.counts || {}).includes('control:'), { timeoutMs: 20000, since: Date.now() - 40000 });
                if (optOkB && approvedB && approvedB.ok === true && btnsOk && btnsOk.btns >= 2 && fxKey && paused && played && auditCtl) {
                  rep.pass(`B 包控制全链：可选权限 [media.control] grantPermissions 子集批准 → 控制按钮渲染（${btnsOk.btns} 个）→ 夹具会话 ${fxKey} 暂停/播放真翻转 + 审计 control 族计数在案`);
                } else {
                  rep.fail(`C7 B 包面不符：opt=${optOkB} approved=${JSON.stringify(approvedB)} btns=${JSON.stringify(btnsOk)} lastBtns=${JSON.stringify(lastBtns7)} fxKey=${JSON.stringify(fxKey)} paused=${paused} played=${played} audit=${Boolean(auditCtl)}`);
                }
                if (fixture7) { try { await fixture7.stop(); } catch { /* 尽力 */ } fixture7 = null; }
              }
            }
            await bridge('conversation/end', { sessionId: sidC7 });
          }
        }
      }
    } catch (c7err) {
      rep.fail(`段 C7 异常中止：${c7err instanceof Error ? c7err.message : String(c7err)}`);
    }

    // —— 段 C8（工单338，network.request 精确 origin 联网）：本地 HTTP 夹具双 origin——
    // A=manifest 声明并获批的 origin（真取数据上卡）；B=未授权的另一台服务（默认拒绝）；
    // A 的 302 → B（跨 origin 重定向不自动跟随、目标 origin 只入审计）；包页直连仍被
    // CSP 全拒（放行只经 deckHost.network.request 宿主代理面）；审计只有 origin/方法/结果。
    rep.beginSegment('C8');
    try {
      // 夹具清场（battery-owned ids）：上轮批准/安装残留会让本轮 id_conflict（C4/C6/C7 同款）
      const userPluginsRoot8 = (() => {
        try { return (JSON.parse(configRaw || '{}').plugins || {}).dir || path.join(userData, 'plugins') } catch { return path.join(userData, 'plugins') }
      })();
      for (const fid of ['dsh-net']) {
        try { fs.rmSync(path.join(userPluginsRoot8, fid), { recursive: true, force: true }); } catch { /* 尽力 */ }
      }
      try { fs.rmSync(path.join(userData, 'plugins-staging'), { recursive: true, force: true }); } catch { /* 尽力 */ }
      const httpFx = await startHttpFixture();
      try {
        rep.note(`C8 本地 HTTP 夹具：授权 origin=${httpFx.origin}、未授权 origin=${httpFx.otherOrigin}（127.0.0.1 随机端口，无公网依赖）`);
        const createC8 = await bridge('conversation/create', { managed: true, label: 'accept-338-network' });
        if (!createC8.ok) {
          rep.fail(`C8 管理型会话创建失败：${createC8.error}`);
        } else {
          const sidC8 = createC8.session.id;
          const sessC8 = await sessionById(sidC8);
          if (!sessC8 || !sessC8.cwd) {
            rep.fail('C8 会话视图/cwd 缺失');
          } else {
            const pkgDir8 = path.join(sessC8.cwd, 'dsh-net-pkg');
            const prompt8 = await bridge('conversation/prompt', { sessionId: sidC8, text: `MANAGED NET marker：落联网组件包并经 plugin_install_submit 提交安装\nPKGDIR=${pkgDir8}\nPKGID=dsh-net\nORIGIN=${httpFx.origin}\nOTHERORIGIN=${httpFx.otherOrigin}` });
            if (!prompt8 || prompt8.ok !== true) rep.note(`C8 诊断 prompt 应答：${JSON.stringify(prompt8)}`);
            const prop8 = await until(async () => (await bridge('install/list', null)).proposals.find((p) => p.status === 'pending' && p.pkg.id === 'dsh-net') ?? null, 90000);
            if (!prop8) {
              const v8 = await sessionById(sidC8);
              rep.note(`C8 诊断 transcript=${JSON.stringify((v8 ? v8.transcript : []).map((x) => `${x.kind}:${String(x.text ?? '').slice(0, 120)}`)).slice(0, 700)}`);
              rep.fail('C8 联网组件提案未出现（90s）');
            } else {
              // ① 提案数据面：network.request + 精确 origin 清单（批准面看得到要批什么）
              const permsOk8 = Array.isArray(prop8.pkg.permissions) && prop8.pkg.permissions.includes('network.request');
              const origins8 = prop8.pkg.networkOrigins || [];
              const originsOk8 = origins8.length === 1 && origins8[0] === httpFx.origin;
              const approved8 = await bridge('install/approve', { proposalId: prop8.proposalId }, 30000);
              await until(async () => (await bridge('install/list', null)).proposals.find((p) => p.proposalId === prop8.proposalId && p.status === 'activated') ?? null, 30000);
              if (permsOk8 && originsOk8 && approved8 && approved8.ok === true) {
                rep.pass(`提案面与批准：permissions [network.request] + networkOrigins [${httpFx.origin}]（精确 origin 是授权参数面）→ 批准激活`);
              } else {
                rep.fail(`C8 提案/批准面不符：perms=${JSON.stringify(prop8.pkg.permissions)} origins=${JSON.stringify(origins8)} approved=${JSON.stringify(approved8)}`);
              }
              // ② 组件真实联网：授权 origin 取数上卡（宿主代理面），三类结果齐备再断言
              await until(async () => (await pkgTarget('deck-pkg://dsh-net/')) ? true : null, 20000);
              const netView8 = await until(async () => {
                try {
                  const t = await pkgTarget('deck-pkg://dsh-net/');
                  if (!t) return null;
                  const raw = await cdpEvalTarget(t, '(() => window.__netView ? JSON.stringify(window.__netView) : null)()', 8000);
                  if (!raw) return null;
                  const v = JSON.parse(raw);
                  return v.allowed && v.denied && v.redirect && v.direct ? v : null;
                } catch { return null }
              }, 30000);
              if (!netView8) {
                try {
                  const t = await pkgTarget('deck-pkg://dsh-net/');
                  const seen = t ? await cdpEvalTarget(t, 'JSON.stringify({ mounted: Boolean(window.__netCardMounted), view: window.__netView || null, text: (document.querySelector(".net-card") || {}).textContent || null })', 8000) : 'no-target';
                  rep.note(`C8 诊断 卡片实见=${String(seen).slice(0, 500)}`);
                } catch { /* 尽力 */ }
                rep.fail('C8 联网卡三类请求结果未齐备（30s）——诊断见上');
              } else {
                const allowedOk8 = netView8.allowed.ok === true && netView8.allowed.status === 200 && String(netView8.allowed.text || '').includes('deck-net-fixture');
                if (allowedOk8) {
                  rep.pass(`授权 origin 真取数：deckHost.network.request(${httpFx.origin}/data.json) → HTTP 200 文本上卡（宿主代理面放行，包页自己不出网）`);
                } else {
                  rep.fail(`C8 授权 origin 取数不符：${JSON.stringify(netView8.allowed).slice(0, 400)}`);
                }
                const deniedOk8 = netView8.denied.ok === false && netView8.denied.code === 'network_permission_denied';
                if (deniedOk8) {
                  rep.pass(`未授权 origin 默认拒绝：${httpFx.otherOrigin} 请求 → network_permission_denied（一个字节不出）`);
                } else {
                  rep.fail(`C8 未授权 origin 面不符：${JSON.stringify(netView8.denied).slice(0, 400)}`);
                }
                const redir8 = netView8.redirect;
                const redirOk8 = redir8.ok === false && redir8.code === 'network_redirect_blocked'
                  && String(redir8.location || '').includes('/secret');
                // 不跟随的硬证据：重定向目标服务零命中（hits 只含 A 的 /data.json 与 /redirect 两发）
                const hits8 = httpFx.hits();
                if (redirOk8 && hits8 === 2) {
                  rep.pass(`跨 origin 重定向不自动跟随：302 → ${httpFx.otherOrigin} 返回 network_redirect_blocked + location 在案；目标服务零命中（hits=${hits8}）`);
                } else {
                  rep.fail(`C8 重定向面不符：${JSON.stringify(redir8).slice(0, 300)} hits=${hits8}`);
                }
                const direct8 = netView8.direct === 'blocked';
                if (direct8) {
                  rep.pass('包页直连仍全拒：CSP connect-src none 拦掉卡内 fetch（放行只经宿主代理面，webRequest 拦截不放松）');
                } else {
                  rep.fail(`C8 包页直连未被拦：direct=${JSON.stringify(netView8.direct)}`);
                }
                // ③ 审计：脱敏聚合在案（origin/方法/结果；无载荷）
                const auditEv8 = await tape.wait('network-audit-aggregate', (e) => e.packageId === 'dsh-net' && JSON.stringify(e.origins || []).includes(httpFx.origin), { timeoutMs: 20000, since: Date.now() - 60000 });
                const auditBuckets8 = await bridge('network/audit', null).catch(() => null);
                const bucket8 = ((auditBuckets8 && auditBuckets8.buckets) || []).find((b) => b.packageId === 'dsh-net' && b.permission === 'network.request');
                if (auditEv8 && bucket8 && bucket8.counts.request >= 1 && bucket8.counts.redirect >= 1 && (bucket8.origins || []).includes(httpFx.origin)) {
                  rep.pass(`脱敏审计：network-audit-aggregate 事件 + 聚合投影（request=${bucket8.counts.request}、redirect=${bucket8.counts.redirect}、denied=${bucket8.denied}；origins=${JSON.stringify(bucket8.origins)}，无路径/查询/正文）`);
                } else {
                  rep.fail(`C8 审计面不符：event=${Boolean(auditEv8)} bucket=${JSON.stringify(bucket8)}`);
                }
                // ④ 撤销即断供：账撤销 → 上下文拆除（网络面同步查账，撤销与断供零窗口）
                const gateR8 = Date.now();
                const revoked8 = await bridge('install/revoke', { packageId: 'dsh-net' });
                const deact8 = await tape.wait('dropped-package-deactivated', (e) => e.id === 'dsh-net' && e.reason === 'permission-revoked', { timeoutMs: 15000, since: gateR8 });
                const gone8 = await until(async () => ((await pkgTarget('deck-pkg://dsh-net/')) ? null : true), 15000);
                const grants8 = await bridge('install/grants', null);
                const row8 = ((grants8 && grants8.grants) || []).find((g) => g.packageId === 'dsh-net');
                if (revoked8 && revoked8.ok === true && deact8 && gone8 && row8 && row8.revokedAt > 0) {
                  rep.pass(`撤销即断供：install/revoke → deactivated(reason=permission-revoked) + deck-pkg://dsh-net 上下文拆除 + 账行 revokedAt 在案`);
                } else {
                  rep.fail(`C8 撤销面不符：revoked=${JSON.stringify(revoked8)} deactivated=${Boolean(deact8)} gone=${Boolean(gone8)} row=${JSON.stringify(row8)}`);
                }
              }
            }
            await bridge('conversation/end', { sessionId: sidC8 });
          }
        }
      } finally {
        // 夹具纪律：本地 HTTP 服务全关停（用完即杀、零残留）
        try { await httpFx.stop(); } catch { /* 尽力 */ }
      }
    } catch (c8err) {
      rep.fail(`段 C8 异常中止：${c8err instanceof Error ? c8err.message : String(c8err)}`);
    }

    // —— 段 C3（工单340，ADR-0026 浮动版本与失败处置）：bogus 后端档失败非破坏 +
    // 「创建全新数据目录」用户手势——旧目录零触碰、指向持久化、不继承不备份 ——
    rep.beginSegment('C3');
    try {
      // 目录指纹：相对路径 + 内容 sha256（非破坏断言的比较基准；与单测同口径）
      const crypto = require('crypto');
      const hashDir = (root) => {
        if (!fs.existsSync(root)) return '(absent)';
        const out = [];
        const walk = (dir, rel) => {
          for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const childRel = rel ? `${rel}/${e.name}` : e.name;
            const childAbs = path.join(dir, e.name);
            if (e.isDirectory()) { out.push(`d ${childRel}`); walk(childAbs, childRel); }
            else out.push(`f ${childRel} ${crypto.createHash('sha256').update(fs.readFileSync(childAbs)).digest('hex')}`);
          }
        };
        walk(root, '');
        return out.join('\n');
      };
      const oldHome = path.join(userData, 'dsh-home');
      const beforeHash = hashDir(oldHome);

      // 子轮 A：config 指向不存在的 exe（bogus 后端档）→ 重启面板（backendCache 随进程消亡）→ 解析落空
      await handle.stop();
      let bogusWritten = false;
      try {
        const json = configRaw ? JSON.parse(configRaw) : {};
        json.conversation = { ...(json.conversation ?? {}), dshExe: 'X:\\deck-340-bogus\\DeepSeek Harness.exe' };
        fs.writeFileSync(path.join(APP_ROOT, 'config.json'), JSON.stringify(json, null, 2) + '\n', 'utf8');
        bogusWritten = true;
      } catch { /* 写不进 = 本子轮无前提，断言位如实判负 */ }
      handle.launch({
        mode: 'accept',
        cdpPort: CDP_PORT,
        stdio: 'archive',
        extraEnv: { [LLM_KEY_ENV]: 'accept-round-not-a-real-key' },
      });
      const hwnd3 = await handle.waitWindow({ title: PANEL_TITLE, cls: 'Chrome_WidgetWin_1', timeoutMs: 30000 });
      if (!hwnd3 || !bogusWritten) {
        rep.fail(`C3 前提不成立：窗口=${Boolean(hwnd3)} bogus 配置=${bogusWritten}`);
      } else {
        await until(async () => {
          try { return (await bridge('panel/snapshot', null)) != null; } catch { return false; }
        }, 20000);
        const gateT = Date.now();
        // ① 解析落空：backendInfo available=false 且 detail 明确（探测落空+补救指引）
        const info3 = await bridge('conversation/backend', null);
        // ② 创建明确报错：不建行（conversation-create-failed reason=boot 在案）
        const create3 = await bridge('conversation/create', { label: 'accept-340-bogus' });
        const failEvent = await tape.wait('conversation-create-failed', (e) => e.reason === 'boot' || e.reason === 'backend-unresolved', { timeoutMs: 10000, since: gateT });
        // ③ 零 DSH 进程面：无握手、无 session-new（解析在 spawn 之前落空）
        //    tape.wait 超时返回 null（不抛错）——必须 !! 强转，.then(()=>true) 会把 null 变 true
        const lateHandshake = !!(await tape.wait('conversation-handshake', () => true, { timeoutMs: 2000, since: gateT }));
        const lateSessionNew = !!(await tape.wait('conversation-session-new', () => true, { timeoutMs: 2000, since: gateT }));
        // ④ 失败非破坏：dshHome 哈希零变化
        const afterFailHash = hashDir(oldHome);
        if (info3 && info3.available === false && info3.detail && info3.detail.length > 10
          && create3 && create3.ok === false && create3.error && failEvent
          && !lateHandshake && !lateSessionNew
          && afterFailHash === beforeHash) {
          rep.pass(`bogus 后端档失败非破坏：available=false（${info3.detail.slice(0, 40)}…）创建报错「${String(create3.error).slice(0, 50)}…」零握手/零 session-new，dshHome 哈希零变化`);
        } else {
          rep.fail(`bogus 后端档面不符：info=${JSON.stringify(info3 && { available: info3.available })} create=${JSON.stringify(create3 && { ok: create3.ok, error: create3.error })} failEvent=${Boolean(failEvent)} handshake=${lateHandshake} sessionNew=${lateSessionNew} hashSame=${afterFailHash === beforeHash}`);
        }

        // 子轮 B：「创建全新数据目录」用户手势（不经 DSH——解析失败不影响目录管理）
        const fresh = await bridge('conversation/new-data-dir', null);
        const info4 = await bridge('conversation/backend', null);
        let persisted = null;
        try {
          const after = JSON.parse(readConfigRaw() ?? '{}');
          persisted = after.conversation ? after.conversation.dshHome ?? null : null;
        } catch { persisted = null; }
        const oldUnchanged = hashDir(oldHome) === beforeHash;
        if (fresh && fresh.ok && fresh.dshHome && fresh.previous === oldHome
          && info4 && info4.dshHome === fresh.dshHome && persisted === fresh.dshHome && oldUnchanged) {
          freshDir = fresh.dshHome;
          rep.pass(`全新数据目录手势：${oldHome} → ${fresh.dshHome}，backendInfo 指向已更新，config.conversation.dshHome 持久化在案，旧目录哈希零变化（不备份不继承）`);
        } else {
          rep.fail(`全新数据目录面不符：fresh=${JSON.stringify(fresh)} infoDshHome=${info4 && info4.dshHome} persisted=${persisted} oldUnchanged=${oldUnchanged}`);
          if (fresh && fresh.ok && fresh.dshHome) freshDir = fresh.dshHome; // 失败也要清场
        }
      }
    } catch (c3err) {
      rep.fail(`段 C3 异常中止：${c3err instanceof Error ? c3err.message : String(c3err)}`);
    }
  } catch (err) {
    rep.fail(`电池异常中止：${err instanceof Error ? err.stack || err.message : String(err)}`);
  } finally {
    // 清场：config 原样还原、罐头关停、探针文件删除（含观察口端口文件）、C3 全新目录、面板强退（验证消失）
    try { await handle.stop(); } catch { /* 尽力 */ }
    try { restoreConfig(configRaw); } catch { /* 尽力 */ }
    try { if (llm) await llm.close(); } catch { /* 尽力 */ }
    try { fs.rmSync(ESCALATION_FILE, { force: true }); } catch { /* 尽力 */ }
    try { fs.rmSync(PROBE_PORT_FILE, { force: true }); } catch { /* 尽力 */ }
    try { if (freshDir) fs.rmSync(freshDir, { recursive: true, force: true }); } catch { /* 尽力 */ }
    finish();
  }
}

module.exports = main;
