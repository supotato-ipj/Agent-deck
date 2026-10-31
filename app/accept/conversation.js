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
const WM_CLOSE = 0x0010;

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

/** 桥接 invoke（经面板页真实通路；与用户点击渲染层同一入口） */
async function bridge(method, payload) {
  const expr = `window.deck.bridge.invoke(${JSON.stringify(method)}, ${JSON.stringify(payload ?? null)})`;
  return cdpEvalOn(PANEL_TITLE, expr);
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

    // —— 拉面板（--panel-accept 绕单实例锁；事件档 + CDP + 罐头 LLM key 注入）——
    handle.launch({
      mode: 'accept',
      cdpPort: CDP_PORT,
      stdio: 'archive',
      extraEnv: { [LLM_KEY_ENV]: 'accept-round-not-a-real-key' },
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

    // 断言② prompt 流式（验收标准 1：看到 DSH 回复）
    await bridge('conversation/prompt', { sessionId, text: 'Say PROBE OK. Do not use any tools. (PROBE OK marker)' });
    const endTurn = await tape.wait('conversation-prompt-result', (e) => e.sessionId === sessionId && e.stopReason === 'end_turn', { timeoutMs: 45000 });
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

    await bridge('conversation/prompt', { sessionId, text: 'Count slowly from 1 to 20, one number per line, no tools. (Count slowly marker)' });
    await sleep(2500); // 让慢流真的跑起来
    await bridge('conversation/cancel', { sessionId });
    const cancelled = await tape.wait('conversation-prompt-result', (e) => e.sessionId === sessionId && e.stopReason === 'cancelled', { timeoutMs: 30000 });
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
    await bridge('conversation/prompt', { sessionId, text: 'Write a file to the absolute path required by your task. (outside marker)' });
    const permReq = await tape.wait('conversation-permission-request', (e) => e.sessionId === sessionId, { timeoutMs: 60000 });
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
    await bridge('conversation/permission', { sessionId, optionId: 'allow-once' });
    const permTurn = await tape.wait('conversation-prompt-result', (e) => e.sessionId === sessionId && e.stopReason === 'end_turn', { timeoutMs: 60000 });
    const allowWorked = fs.existsSync(ESCALATION_FILE);
    const permResolved = await tape.wait('conversation-permission-resolved', (e) => e.sessionId === sessionId && e.optionId === 'allow-once', { timeoutMs: 10000 });
    if (permTurn && allowWorked && permResolved) rep.pass('allow-once 裁决生效：升级写真实落盘 + end_turn + 裁决存证');
    else rep.fail(`审批流不符：turn=${JSON.stringify(permTurn)} fileWritten=${allowWorked} resolved=${JSON.stringify(permResolved)}`);

    // 断言⑤ 显式退出（验收标准 1 结束语义 + 标准 5 元数据）
    const pidBeforeEnd = (await sessionById(sessionId)).backendPid;
    await bridge('conversation/end', { sessionId });
    const closeLog = await tape.wait('conversation-session-close', (e) => e.sessionId === sessionId, { timeoutMs: 20000 });
    const exitLog = await tape.wait('conversation-process-exit', (e) => e.sessionId === sessionId, { timeoutMs: 30000 });
    const endedLog = await tape.wait('conversation-ended', (e) => e.sessionId === sessionId, { timeoutMs: 10000 });
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

    // 断言⑦ 全程零管理面（验收标准 4）
    if ((await sessionsView()).every((s) => s.managed === false)) rep.pass('全程零管理面：无任何会话持有管理标记');
    else rep.fail('出现 managed 会话（聊天型票面不允许）');
  } catch (err) {
    rep.fail(`电池异常中止：${err instanceof Error ? err.stack || err.message : String(err)}`);
  } finally {
    // 清场：config 原样还原、罐头关停、探针文件删除、面板强退（验证消失）
    try { restoreConfig(configRaw); } catch { /* 尽力 */ }
    try { if (llm) await llm.close(); } catch { /* 尽力 */ }
    try { fs.rmSync(ESCALATION_FILE, { force: true }); } catch { /* 尽力 */ }
    try { await handle.stop(); } catch { /* 尽力 */ }
    finish();
  }
}

module.exports = main;
