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
