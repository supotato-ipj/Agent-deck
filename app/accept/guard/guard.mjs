#!/usr/bin/env node
// accept-guard —— 主机真机验收槽调度 CLI（工单 #63；工单 #495 起仓内化）
// 零 npm 依赖，Node >= 18。协议全文与词汇表见同目录 README.md。
//
// 工单 #495 仓内化：源码住在本仓库 app/accept/guard/，与电池同仓演进、同 PR 评审；
// 家目录（租约/相位/配置落点）与源码位置分离——固定在本机 D:\test-folder\.accept-guard
// （既有租约状态与生产 config 的 --panel-quit 优雅径零迁移连续，运行态绝不写进 git 检出）。
// 环境变量 ACCEPT_GUARD_HOME 仍可重定向（selftest 沙箱/搬迁用）。
//
// 工单 #495 任务栏还原兜底：电池收尾对面板是拔电式强杀，面板来不及还原原生任务栏
// （可见性账 SW_HIDE），placement/conversation/tiling 族电池收尾又无自救兜底——每轮
// 验收可能给用户留「任务栏压死、鼠标触底无响应」的桌面。guard 在拿槽与释放槽两侧各跑
// 一次 restoreTaskbarCmd（默认 = 主检出的 electron --icon-restore 自救通道：桌面图标
// 还原 → appbar 落盘账复原 → 原生任务栏 SW_SHOW，幂等、不抢单实例锁），交还机器前
// 兜住残局。置空字符串即禁用。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec } from 'node:child_process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 源码脚本自身的绝对路径（selftest 拉起子进程用——家目录与源码位置分离后，二者不再同址）
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_HOME = 'D:\\test-folder\\.accept-guard';
const HOME = path.resolve(process.env.ACCEPT_GUARD_HOME || DEFAULT_HOME);
const GUARD_JSON = path.join(HOME, 'guard.json');
const STATUS_JSON = path.join(HOME, 'status.json');
const CONFIG_JSON = path.join(HOME, 'config.json');
const MUTEX = path.join(HOME, 'guard.lock');
const MUTEX_STALE_MS = 10_000;

const PURPOSES = ['selftest', 'accept-sprint'];
const PHASES = ['dev', 'selftest', 'accept-sprint', 'human', 'idle'];
const MECHANICAL_PHASES = ['waiting', 'accepting'];
const EXIT_USAGE = 2;
const EXIT_WAIT_TIMEOUT = 3;

const DEFAULT_CONFIG = {
  heartbeatMs: 30_000,
  ttlMs: 180_000,
  maxWaitMs: 1_800_000,
  pollMs: 3_000,
  // 队列死条目收割的陈旧度阈值（工单 #488）：holder 进程已不存在且入队陈旧超过此值的
  // 队列条目视为死头收走，不再永久占据 sorted-head 堵死候补轮。阈值须远大于活轮次
  // 短暂未接手的自愈形态（#482 反向误诊教训）。
  queueStaleMs: 60_000,
  // 验收命令看护告警间隔（工单 #488）：hold 托管的命令运行超过此值仍未退出则告警提示
  // 人工裁决（不自动杀——正常验收可能长跑）；置 0 禁用。
  cmdWatchMs: 600_000,
  panelPathPattern: 'D:\\test-folder\\wallpaperengine-research*',
  gracefulPanelsCmd:
    "powershell -NoProfile -Command \"Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'electron.exe' -and $_.ExecutablePath -like '{pattern}' } | ForEach-Object { Write-Output ('graceful ' + $_.ProcessId + ' ' + $_.ExecutablePath); taskkill /PID $_.ProcessId }\"",
  // 优雅径等待硬预算（毫秒）：枚举 PID 全消失即提前出；轮询步长固定 500ms（工单 #429）。
  gracefulWaitMs: 5_000,
  clearPanelsCmd:
    "powershell -NoProfile -Command \"Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'electron.exe' -and $_.ExecutablePath -like '{pattern}' } | ForEach-Object { Write-Output ('kill ' + $_.ProcessId + ' ' + $_.ExecutablePath); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }\"",
  notifyCmd:
    "powershell -NoProfile -Command \"$ErrorActionPreference='SilentlyContinue'; [Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime] > $null; $x=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); $x.GetElementsByTagName('text').Item(0).AppendChild($x.CreateTextNode('真机验收占用中')) > $null; $x.GetElementsByTagName('text').Item(1).AppendChild($x.CreateTextNode('{holder} 正在真机验收（{purpose}），各检出面板已清理，请暂勿拉起面板')) > $null; [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('accept-guard').Show([Windows.UI.Notifications.ToastNotification]::new($x))\"",
  // 任务栏还原兜底（工单 #495）：主检出既有 --icon-restore 自救通道，拿槽/释放槽双侧
  // 各跑一次（效果幂等）；置空字符串即禁用。
  restoreTaskbarCmd:
    'D:\\test-folder\\wallpaperengine-research\\app\\node_modules\\electron\\dist\\electron.exe D:\\test-folder\\wallpaperengine-research\\app --icon-restore',
};

// ---------- 通用小工具 ----------

const pad2 = (n) => String(n).padStart(2, '0');

function localIso(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}` +
    `${sign}${pad2(Math.floor(Math.abs(off) / 60))}:${pad2(Math.abs(off) % 60)}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`[accept-guard] ${msg}`);
const warn = (msg) => console.error(`[accept-guard] ${msg}`);
function die(code, msg) {
  warn(msg);
  process.exit(code);
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function humanDur(ms) {
  if (ms < 0) ms = 0;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3_600_000)}h${Math.round((ms % 3_600_000) / 60_000)}m`;
}

// ---------- 配置与状态文件 ----------

function ensureHome() {
  fs.mkdirSync(HOME, { recursive: true });
  if (!fs.existsSync(CONFIG_JSON)) {
    writeJsonAtomic(CONFIG_JSON, DEFAULT_CONFIG);
    log(`已生成默认配置 ${CONFIG_JSON}（含清面板/通知/任务栏还原命令，请按需调整 panelPathPattern）`);
  }
}

function loadConfig() {
  const file = readJson(CONFIG_JSON, {});
  const cfg = { ...DEFAULT_CONFIG, ...file };
  for (const k of ['heartbeatMs', 'ttlMs', 'maxWaitMs', 'pollMs']) {
    if (!(cfg[k] > 0)) die(EXIT_USAGE, `config.json 的 ${k} 必须为正数`);
  }
  if (typeof cfg.gracefulWaitMs !== 'number' || !(cfg.gracefulWaitMs >= 0)) {
    die(EXIT_USAGE, 'config.json 的 gracefulWaitMs 必须为非负数（毫秒）');
  }
  if (!(cfg.queueStaleMs > 0)) {
    die(EXIT_USAGE, 'config.json 的 queueStaleMs 必须为正数（毫秒；死头收割的保守性靠它兜底，不做 0）');
  }
  if (typeof cfg.cmdWatchMs !== 'number' || !(cfg.cmdWatchMs >= 0)) {
    die(EXIT_USAGE, 'config.json 的 cmdWatchMs 必须为非负数（毫秒，0=禁用看护告警）');
  }
  return cfg;
}

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

// 同步短眠（writeJsonAtomic 的 EPERM 重试用）：guard 是 CLI，进程内阻塞百毫秒级可接受。
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// 原子写（工单 #488 加固）：Windows 上 renameSync 撞上并发读句柄（无锁 readState /
// 杀软与索引服务的扫描）会偶发 EPERM。窄窗竞争用短重试吃掉（3 次共 100ms）；重试耗尽
// 仍失败则如实抛出（真长锁形态本就该报错），finally 清掉 tmp 残留——此前的失败路径
// 会把 guard.json.<pid>.tmp 留在家目录（当日家目录 4 个 .tmp 残留的同源物证）。
function writeJsonAtomic(p, obj) {
  const tmp = `${p}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, p);
        return;
      } catch (e) {
        if (e.code === 'EPERM' && attempt < 2) {
          sleepSync(50);
          continue;
        }
        throw e;
      }
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* rename 成功后 tmp 已不在 */ }
  }
}

function readState() {
  return readJson(GUARD_JSON, { slot: null, queue: [], lastReleaseAt: null, lastReleaseMs: null });
}

// ---------- 变更互斥（串行化租约读改写） ----------

async function withMutex(fn) {
  for (;;) {
    let fd;
    try {
      fd = fs.openSync(MUTEX, 'wx');
    } catch (e) {
      if (e.code === 'EEXIST') {
        try {
          const age = Date.now() - fs.statSync(MUTEX).mtimeMs;
          if (age > MUTEX_STALE_MS) {
            warn(`互斥哨兵已残留 ${Math.round(age / 1000)}s，视为崩溃残留并清除`);
            fs.unlinkSync(MUTEX);
          }
        } catch { /* stat 竞争，下一轮重试 */ }
        await sleep(25);
        continue;
      }
      throw e;
    }
    try {
      return await fn();
    } finally {
      fs.closeSync(fd);
      try { fs.unlinkSync(MUTEX); } catch { /* 已被下一轮清走 */ }
    }
  }
}

// ---------- 相位状态（status.json） ----------

function setStatus(name, phase, note, { declared = false } = {}) {
  const st = readJson(STATUS_JSON, { agents: {} });
  const entry = st.agents[name] || { declaredPhase: 'idle', note: '' };
  entry.phase = phase;
  if (declared) entry.declaredPhase = phase;
  if (note !== undefined) entry.note = note;
  entry.updatedAt = localIso();
  entry.updatedMs = Date.now();
  st.agents[name] = entry;
  writeJsonAtomic(STATUS_JSON, st);
}

function restoreDeclaredPhase(name) {
  const st = readJson(STATUS_JSON, { agents: {} });
  const entry = st.agents[name];
  if (!entry) return;
  entry.phase = entry.declaredPhase || 'idle';
  entry.updatedAt = localIso();
  entry.updatedMs = Date.now();
  writeJsonAtomic(STATUS_JSON, st);
}

// ---------- 验收槽核心 ----------

function purposeRank(p) {
  return p === 'accept-sprint' ? 0 : 1;
}

function sortedQueue(queue) {
  return [...queue].sort((a, b) => purposeRank(a.purpose) - purposeRank(b.purpose) || a.enqueuedMs - b.enqueuedMs);
}

// 队列死条目收割（工单 #488）：holder 进程已不存在且入队陈旧度超 queueStaleMs 的条目
// 视为死头收走——此前死条目永居队头，sorted-head 规则堵死全部候补轮（当日 7 实锤）。
// 保守性：双判据「pid 存活 + 陈旧度」，只看进程生死、不看轮次接手状态，活轮次短暂
// 未接手的自愈形态不会被误收（#482 反向误诊教训）；pid 复用只会把死条目错判成活条目
// =漏收，也在保守方向。无 pid 字段的旧版条目按陈旧度单判据收割。须在持互斥的前提下调用。
function pruneQueue(st, cfg) {
  if (!st.queue.length) return;
  const now = Date.now();
  const survivors = [];
  for (const e of st.queue) {
    const stale = now - (e.enqueuedMs || 0) > cfg.queueStaleMs;
    if (stale && !pidAlive(e.pid)) {
      warn(`收割队列死条目：${e.name}｜用途 ${e.purpose}｜holder PID ${e.pid ?? '未记录'}｜入队于 ${e.enqueuedAt}（陈旧 ${humanDur(now - (e.enqueuedMs || 0))}，超阈 ${humanDur(cfg.queueStaleMs)}）`);
      continue;
    }
    survivors.push(e);
  }
  st.queue = survivors;
}

// 在持有互斥的前提下尝试拿槽；成功则改写 st 并返回 true。
// 规则：槽空闲（或租约心跳过期判挂死可接管），且我是排序队列的队头（队列为空时自然满足）。
function tryTakeSlot(st, me, cfg) {
  let takeover = false;
  if (st.slot) {
    const hbAge = Date.now() - (st.slot.heartbeatMs || 0);
    if (hbAge <= cfg.ttlMs) return false;
    warn(`检测到挂死租约：持锁方 ${st.slot.owner}（用途 ${st.slot.purpose}）心跳已停 ${humanDur(hbAge)} > TTL ${humanDur(cfg.ttlMs)}，执行挂死接管`);
    takeover = true;
    st.slot = null;
  }
  if (st.queue.length) {
    const head = sortedQueue(st.queue)[0];
    if (head.id !== me.id) return false;
    st.queue = st.queue.filter((e) => e.id !== me.id);
  }
  const nowMs = Date.now();
  st.slot = {
    owner: me.name,
    purpose: me.purpose,
    note: me.note || '',
    checkout: me.checkout || '',
    pid: process.pid,
    acquiredAt: localIso(),
    acquiredMs: nowMs,
    heartbeatAt: localIso(),
    heartbeatMs: nowMs,
    takeover,
  };
  return true;
}

// ---------- 主机效果（清面板/通知/任务栏还原） ----------

// shell:true 拼接不转义（Node DEP0190 同款语义）：含空格的 token 会被 cmd.exe 从空格处
// 拆断（工单 #488：C:\Program Files\... → 'C:\Program' is not recognized，#475/#481/#482
// 各中招过）。对含空白且未自带引号包裹的 token 补双引号；已引号包裹的元素（调用方自带）
// 原样保留，避免双重引号。只处理空白——cmd 元字符（&|^><%）的超面转义不在此刀范围。
function quoteForCmd(token) {
  if (typeof token !== 'string') return token;
  if (/\s/.test(token) && !(token.startsWith('"') && token.endsWith('"'))) {
    return `"${token}"`;
  }
  return token;
}

function runEffect(cmdTemplate, placeholders) {
  let cmd = cmdTemplate || '';
  for (const [k, v] of Object.entries(placeholders)) {
    cmd = cmd.split(`{${k}}`).join(v);
  }
  if (!cmd.trim()) return Promise.resolve('');
  return new Promise((resolve) => {
    exec(cmd, { windowsHide: true, timeout: 30_000 }, (err, stdout, stderr) => {
      resolve({ err, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
    });
  });
}

// 任务栏还原兜底（工单 #495）：调 restoreTaskbarCmd（默认 = electron --icon-restore），
// 把上一轮验收（或 guard-dead 接管残局）可能留下的 SW_HIDE 原生任务栏与 appbar 落盘账
// 还原给系统。幂等（可见则静默/缺账静默）；失败不阻塞调度（尽力语义，warn 留痕）。
async function restoreTaskbarEffect(cfg) {
  const r = await runEffect(cfg.restoreTaskbarCmd, {});
  if (r && r.err) warn(`任务栏还原兜底命令异常（忽略，继续调度）：${r.err.message}`);
  return r;
}

// 从效果命令 stdout 提取 PID 清单（行格式 `<tag> <pid> <path>`）。
function parseEffectPids(stdout, tag) {
  if (!stdout) return [];
  const pids = [];
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(new RegExp(`^${tag} (\\d+) `));
    if (m) pids.push(Number(m[1]));
  }
  return pids;
}

// 有界等待：枚举 PID 全消失即提前出，否则等满硬预算（挂死面板不阻塞清场）。
async function waitPidsGone(pids, budgetMs) {
  const start = Date.now();
  const deadline = start + budgetMs;
  for (;;) {
    const survivors = pids.filter(pidAlive);
    if (!survivors.length) return { waitedMs: Date.now() - start, survivors };
    if (Date.now() >= deadline) return { waitedMs: Date.now() - start, survivors };
    await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
  }
}

async function acquireEffects(cfg, slot) {
  const placeholders = { pattern: cfg.panelPathPattern, holder: slot.owner, purpose: slot.purpose };
  // 第一步：优雅径——对全部枚举 PID 发 taskkill（不带 /F，向顶层窗发 WM_CLOSE），
  // 面板走既有退出链（dispose + 托盘图标注销）后自行退出；无顶层窗的子进程天然 no-op。
  const graceful = await runEffect(cfg.gracefulPanelsCmd, placeholders);
  if (graceful && graceful.stdout) log(`优雅径触达：${graceful.stdout.split('\n').join('；')}`);
  if (graceful && graceful.err) warn(`优雅径命令异常（忽略，继续清场）：${graceful.err.message}`);
  const touched = parseEffectPids(graceful && graceful.stdout, 'graceful');
  if (touched.length) {
    const { waitedMs, survivors } = await waitPidsGone(touched, cfg.gracefulWaitMs);
    log(`优雅等待：触达 ${touched.length} 个面板 PID，等 ${waitedMs}ms，残留 ${survivors.length ? survivors.join(',') : '无'}`);
  }
  // 第二步：强杀清场兜底——最后一级、不可拆除（挂死面板不得阻塞验收槽获取）。
  const killed = await runEffect(cfg.clearPanelsCmd, placeholders);
  const residue = parseEffectPids(killed && killed.stdout, 'kill');
  if (residue.length) {
    log(`清场落点 kill-mode=forced（优雅径后有残留，强杀兜底）：${killed.stdout.split('\n').join('；')}`);
  } else {
    log('清场落点 kill-mode=graceful（面板已自发退出或本就无残留，强杀空枚举）');
  }
  if (killed && killed.err) warn(`面板清理命令异常（忽略，继续验收）：${killed.err.message}`);
  // 第三步（工单 #495）：任务栏还原兜底——上一位持有者（含 guard-dead 接管的残局）可能
  // 把原生任务栏留在隐藏态；先还成干净桌面，再交出验收槽。
  await restoreTaskbarEffect(cfg);
  // 第四步：既有系统通知。
  const notified = await runEffect(cfg.notifyCmd, { holder: slot.owner, purpose: slot.purpose });
  if (notified && notified.err) warn(`系统通知失败（忽略，继续验收）：${notified.err.message}`);
}

// ---------- 子命令 ----------

function parseGlobal(argv) {
  const i = argv.indexOf('--');
  const flagPart = i === -1 ? argv : argv.slice(0, i);
  const cmdPart = i === -1 ? [] : argv.slice(i + 1);
  const flags = { positional: [] };
  for (let j = 0; j < flagPart.length; j++) {
    const a = flagPart[j];
    const val = () => flagPart[++j];
    switch (a) {
      case '--as': flags.as = val(); break;
      case '--purpose': flags.purpose = val(); break;
      case '--note': flags.note = val(); break;
      case '--json': flags.json = true; break;
      case '--force': flags.force = true; break;
      default:
        if (a.startsWith('--')) die(EXIT_USAGE, `未知参数：${a}`);
        flags.positional.push(a);
    }
  }
  return { flags, cmdPart };
}

function defaultAgentName() {
  return process.env.ACCEPT_GUARD_AGENT || path.basename(process.cwd());
}

function parseHoldArgs(flags, cmdPart) {
  const name = flags.as || defaultAgentName();
  const purpose = flags.purpose || 'selftest';
  if (!PURPOSES.includes(purpose)) {
    die(EXIT_USAGE, `--purpose 只接受 ${PURPOSES.join(' | ')}，收到：${purpose}`);
  }
  if (!cmdPart.length) {
    die(EXIT_USAGE, 'hold 需要 -- 之后的验收命令，例如：guard.mjs hold --as zcode --purpose accept-sprint -- npm run accept');
  }
  return { name, purpose, note: flags.note || '', cmd: cmdPart };
}

async function cmdHold(flags, cmdPart) {
  const { name, purpose, note, cmd } = parseHoldArgs(flags, cmdPart);
  ensureHome();
  const cfg = loadConfig();
  const me = {
    id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    purpose,
    note,
    checkout: path.basename(process.cwd()),
    pid: process.pid, // 死头收割判据（工单 #488）：条目必须能对账到 holder 进程
    enqueuedMs: Date.now(),
    enqueuedAt: localIso(),
  };

  // 统一走队列：先入队，再按队头规则拿槽（槽空闲即队头即时放行）。
  let acquired = false;
  let position = 0;
  await withMutex(() => {
    const st = readState();
    st.queue.push(me);
    pruneQueue(st, cfg);
    acquired = tryTakeSlot(st, me, cfg);
    writeJsonAtomic(GUARD_JSON, st);
  });
  if (!acquired) {
    const st = readState();
    const ahead = sortedQueue(st.queue).find((e) => e.id !== me.id);
    // 如实区分两种被堵形态（工单 #488）：槽被真持锁方占着 vs 槽空闲但队列有人排在前面
    const reason = st.slot
      ? `验收槽被占：${describeSlot(st.slot)}`
      : `槽空闲但队列非空（队头 ${ahead ? `${ahead.name}｜PID ${ahead.pid ?? '未记录'}${pidAlive(ahead.pid) ? '' : '（进程已不存在）'}` : '?'}）`;
    log(`${reason}。已入队（${purpose}），最长等待 ${humanDur(cfg.maxWaitMs)}…`);
  }

  const deadline = Date.now() + cfg.maxWaitMs;
  while (!acquired) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(cfg.pollMs, remaining));
    await withMutex(() => {
      const st = readState();
      pruneQueue(st, cfg);
      acquired = tryTakeSlot(st, me, cfg);
      position = acquired ? 0 : Math.max(1, sortedQueue(st.queue).findIndex((e) => e.id === me.id) + 1);
      writeJsonAtomic(GUARD_JSON, st);
    });
    if (!acquired && position > 0 && Math.random() < 0.05) {
      log(`仍在排队：第 ${position} 位…`);
    }
  }

  if (!acquired) {
    await withMutex(() => {
      const st = readState();
      st.queue = st.queue.filter((e) => e.id !== me.id);
      writeJsonAtomic(GUARD_JSON, st);
    });
    restoreDeclaredPhase(name);
    const st = readState();
    die(EXIT_WAIT_TIMEOUT,
      `等待验收槽超限（> ${humanDur(cfg.maxWaitMs)}）。当前持锁方：${describeSlot(st.slot)}。` +
      `裁决指引：与持锁方协调、稍后重试，或经用户同意后执行 release --force。`);
  }

  const st0 = readState();
  const slot = st0.slot;
  log(`已拿到验收槽${slot.takeover ? '（接管自挂死租约）' : ''}：${describeSlot(slot)}`);
  setStatus(name, 'accepting', note);
  await acquireEffects(cfg, slot);

  const cmdForShell = [quoteForCmd(cmd[0]), ...cmd.slice(1).map(quoteForCmd)];
  const cmdStartMs = Date.now();
  log(`开始执行验收命令：${cmdForShell.join(' ')}`);
  const child = spawn(cmdForShell[0], cmdForShell.slice(1), { shell: true, stdio: 'inherit', windowsHide: false });
  const childExit = new Promise((res) => {
    child.on('error', () => res(1));
    child.on('exit', (c, sig) => res(sig ? 1 : (c ?? 1)));
  });
  // 验收命令看护（工单 #488）：命令运行超 cmdWatchMs 仍未退出则周期性告警提示人工裁决，
  // 不自动杀——正常验收可能长跑。背景：验收命令 stdio inherit，外层若接了停摆的管道
  // 消费方，命令会卡死在写满的管道上且 guard 心跳仍在跳（活心跳假活），TTL 挂死接管
  // 判据失效、租约无人能自动接走——此时唯一出路就是这里的告警指向的人工裁决。
  const cmdWatch = cfg.cmdWatchMs > 0 ? setInterval(() => {
    warn(`看护提示：验收命令已运行 ${humanDur(Date.now() - cmdStartMs)} 仍未退出（PID ${child.pid}）。` +
      '若属输出管道无消费者等挂死形态（心跳仍在跳、他人接管不会触发），请人工裁决：结束本 hold 进程或 release --force。');
  }, cfg.cmdWatchMs) : null;
  const heartbeat = setInterval(() => {
    withMutex(() => {
      const st = readState();
      if (st.slot && st.slot.acquiredMs === slot.acquiredMs && st.slot.owner === name) {
        st.slot.heartbeatMs = Date.now();
        st.slot.heartbeatAt = localIso();
        writeJsonAtomic(GUARD_JSON, st);
      }
    }).catch(() => {});
  }, cfg.heartbeatMs);

  const release = async () => {
    clearInterval(heartbeat);
    if (cmdWatch) clearInterval(cmdWatch);
    // 工单 #495：交还机器前的任务栏还原兜底（先于清租约——验收命令对电池面板是拔电式
    // 强杀，placement/tiling 族电池收尾无自救兜底，残局只能在这里兜住）。
    await restoreTaskbarEffect(cfg);
    await withMutex(() => {
      const st = readState();
      if (st.slot && st.slot.acquiredMs === slot.acquiredMs) {
        st.slot = null;
        st.lastReleaseAt = localIso();
        st.lastReleaseMs = Date.now();
        writeJsonAtomic(GUARD_JSON, st);
      }
    });
    restoreDeclaredPhase(name);
  };
  const onSignal = () => { try { child.kill(); } catch { /* 已退出 */ } };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  let code;
  try {
    code = await childExit;
    code = typeof code === 'number' ? code : 1;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await release();
  }
  log(`验收命令退出（code=${code}），验收槽已释放。`);
  process.exit(code);
}

function describeSlot(slot) {
  if (!slot) return '（空闲）';
  const hbAge = Date.now() - (slot.heartbeatMs || 0);
  return `${slot.owner}｜用途 ${slot.purpose}｜已持 ${humanDur(Date.now() - slot.acquiredMs)}｜心跳 ${humanDur(hbAge)} 前｜PID ${slot.pid}${pidAlive(slot.pid) ? '' : '（进程已不存在）'}`;
}

function cmdStatus(flags) {
  ensureHome();
  const st = readState();
  const agents = readJson(STATUS_JSON, { agents: {} }).agents || {};
  if (flags.json) {
    console.log(JSON.stringify({ guardHome: HOME, slot: st.slot, queue: sortedQueue(st.queue), agents }, null, 2));
    return;
  }
  console.log(`守卫目录：${HOME}`);
  console.log(`验收槽：${describeSlot(st.slot)}`);
  const q = sortedQueue(st.queue);
  if (q.length) {
    console.log('等待队列：');
    q.forEach((e, i) => console.log(`  ${i + 1}. ${e.name}｜${e.purpose}｜入队于 ${e.enqueuedAt}（${humanDur(Date.now() - e.enqueuedMs)} 前）｜PID ${e.pid ?? '未记录'}${pidAlive(e.pid) ? '' : '（进程已不存在，陈旧超阈将在下次拿槽时被收割）'}`));
  } else {
    console.log('等待队列：（空）');
  }
  console.log('双方相位：');
  for (const [name, e] of Object.entries(agents)) {
    console.log(`  ${name}｜${e.phase}${e.phase !== e.declaredPhase ? `（声明相位 ${e.declaredPhase}，验收中机械覆盖）` : ''}${e.note ? `｜${e.note}` : ''}｜更新于 ${e.updatedAt}`);
  }
  if (st.lastReleaseAt) console.log(`上次释放：${st.lastReleaseAt}`);
}

function cmdPhase(flags, args) {
  ensureHome();
  const phase = flags.positional[0];
  if (!PHASES.includes(phase)) {
    die(EXIT_USAGE, `phase 只接受 ${PHASES.join(' | ')}，收到：${phase}`);
  }
  const name = flags.as || defaultAgentName();
  setStatus(name, phase, flags.note, { declared: true });
  log(`相位已声明：${name} → ${phase}${flags.note ? `｜${flags.note}` : ''}`);
}

async function cmdRelease(flags) {
  ensureHome();
  if (!flags.force) {
    die(EXIT_USAGE, '释放只提供应急语义：guard.mjs release --force（正常路径由 hold 自动释放）');
  }
  await withMutex(() => {
    const st = readState();
    if (!st.slot) {
      log('验收槽本就空闲，无需释放。');
      return;
    }
    log(`应急释放验收槽（原持锁方 ${st.slot.owner}，用途 ${st.slot.purpose}）。`);
    st.slot = null;
    st.lastReleaseAt = localIso();
    st.lastReleaseMs = Date.now();
    writeJsonAtomic(GUARD_JSON, st);
  });
}

// ---------- selftest：沙箱行为电池（工单 #63 测试决策） ----------

function sandboxConfig(sandbox) {
  const markerCmd = (tag) => `node -e "require('fs').appendFileSync(process.env.SELFTEST_MARKER,'${tag}\\n')"`;
  return {
    heartbeatMs: 200,
    ttlMs: 900,
    maxWaitMs: 5_000,
    pollMs: 120,
    queueStaleMs: 1_000, // 沙箱短阈值：T11 死头收割段用（工单 #488）
    cmdWatchMs: 400, // 沙箱短间隔：T12 看护告警段用（工单 #488）
    panelPathPattern: 'Z:\\nonexistent*',
    gracefulPanelsCmd: markerCmd('graceful'), // 优雅径沙箱 no-op：写标记、不触真机进程
    gracefulWaitMs: 100, // 短预算防真等（no-op 不产 PID，等待本就即刻出）
    clearPanelsCmd: markerCmd('clear'),
    restoreTaskbarCmd: markerCmd('restore'), // 任务栏还原兜底沙箱 no-op（工单 #495）
    notifyCmd: markerCmd('notify'),
  };
}

function guardProc(sandbox, args, env = {}) {
  return spawn(process.execPath, [SCRIPT_PATH, ...args], {
    env: { ...process.env, ACCEPT_GUARD_HOME: sandbox, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function capture(child) {
  let out = '';
  let errout = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { errout += d; });
  return {
    text: Promise.all([
      new Promise((res) => child.stdout.on('end', () => res(out))),
      new Promise((res) => child.stderr.on('end', () => res(errout))),
    ]).then(([o, e]) => o + e),
    code: new Promise((res) => child.on('exit', (c) => res(c ?? 1))),
  };
}

function writeSandboxSlot(sandbox, slot) {
  writeJsonAtomic(path.join(sandbox, 'guard.json'), { slot, queue: [] });
}

async function waitForSlot(sandbox, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const slot = readJson(path.join(sandbox, 'guard.json'), {}).slot;
    if (slot) return slot;
    await sleep(50);
  }
  throw new Error('等待沙箱租约出现超时');
}

async function cmdSelftest() {
  const { test } = await import('node:test');
  const assert = (await import('node:assert/strict')).default;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-guard-selftest-'));
  const marker = path.join(sandbox, 'effects.log');
  const cfgPath = path.join(sandbox, 'config.json');
  writeJsonAtomic(cfgPath, sandboxConfig(sandbox));
  const guardScript = SCRIPT_PATH; // 家目录与源码分离（工单 #495）：沙箱子进程拉本文件
  const baseEnv = { SELFTEST_MARKER: marker };
  const run = async (args, env = {}) => {
    const child = spawn(process.execPath, [guardScript, ...args], {
      env: { ...process.env, ACCEPT_GUARD_HOME: sandbox, ...baseEnv, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const cap = capture(child);
    const code = await cap.code;
    const text = await cap.text;
    fs.appendFileSync(path.join(sandbox, 'selftest-run.log'), `$ guard ${args.join(' ')}\nexit=${code}\n${text}\n----\n`);
    return { code, text };
  };
  const readSandboxState = () => readJson(path.join(sandbox, 'guard.json'), {});
  const markerLines = () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n') : []);
  const freshSlot = (over = {}) => ({
    owner: 'ghost', purpose: 'selftest', note: '', checkout: 'ghost-checkout', pid: 999_999,
    acquiredAt: localIso(), acquiredMs: Date.now(), heartbeatAt: localIso(), heartbeatMs: Date.now(), takeover: false, ...over,
  });

  console.log(`selftest 沙箱：${sandbox}`);

  await test('T1 hold 正常执行并释放，主机效果 no-op 触达', { timeout: 20_000 }, async () => {
    const r = await run(['hold', '--as', 't1', '--purpose', 'selftest', '--', 'cmd', '/c', 'exit', '0']);
    assert.equal(r.code, 0, `exit=${r.code}\n${r.text}`);
    assert.equal(readSandboxState().slot, null, '租约应已释放');
    const lines = markerLines();
    // 清场触达序：拿槽侧 优雅径 → 强杀清场兜底 → 任务栏还原兜底（工单 #495）→ 通知；
    // 释放侧再兜一次任务栏还原——交还机器前必须兜住电池强杀面板留下的 SW_HIDE 残局。
    assert.deepEqual(lines, ['graceful', 'clear', 'restore', 'notify', 'restore'],
      `触达序（拿槽三步+还原兜底、释放还原兜底），实际：${JSON.stringify(lines)}`);
    assert.ok(r.text.includes('kill-mode=graceful'), `输出应标明本轮清场落点：${r.text}`);
  });

  await test('T2 互斥：第二 hold 阻塞至首者释放后才执行', { timeout: 20_000 }, async () => {
    fs.rmSync(marker, { force: true });
    const holder = guardProc(sandbox, ['hold', '--as', 'h2', '--', 'node', '-e', '"setTimeout(()=>process.exit(0),2000)"'], baseEnv);
    const holderCap = capture(holder);
    const holderSlot = await waitForSlot(sandbox);
    // w-start 行自带结尾换行：释放侧 restore 标记（工单 #495）会在其后追加，无换行会并成一行
    const w = await run(['hold', '--as', 'w2', '--', 'node', '-e', `"require('fs').appendFileSync(process.env.SELFTEST_MARKER,'w-start '+Date.now()+'\\n')"`]);
    assert.equal(w.code, 0);
    assert.equal((await holderCap.code), 0);
    const wLine = markerLines().find((l) => l.startsWith('w-start '));
    assert.ok(wLine, `等待方应已执行：${w.text}`);
    // 持锁方命令固定睡 2000ms：等待方起点 ≥ 持锁方拿槽时刻 + 2000ms - 容差 ⇒ 未并发执行
    assert.ok(Number(wLine.split(' ')[1]) >= holderSlot.acquiredMs + 2000 - 300,
      `等待方应在持锁方释放后才开始（w-start=${wLine}，holder 拿槽=${holderSlot.acquiredMs}）`);
    assert.equal(readSandboxState().slot, null);
  });

  await test('T3 异常退出透传退出码且释放', { timeout: 20_000 }, async () => {
    const r = await run(['hold', '--as', 't3', '--', 'cmd', '/c', 'exit', '7']);
    assert.equal(r.code, 7);
    assert.equal(readSandboxState().slot, null);
  });

  await test('T4 伪造过期心跳 → 挂死接管', { timeout: 20_000 }, async () => {
    writeSandboxSlot(sandbox, freshSlot({ heartbeatMs: Date.now() - 2_000, heartbeatAt: localIso() }));
    const r = await run(['hold', '--as', 't4', '--', 'cmd', '/c', 'exit', '0']);
    assert.equal(r.code, 0, `exit=${r.code}\n${r.text}`);
    assert.ok(r.text.includes('接管'), `应输出接管信息：${r.text}`);
    assert.equal(readSandboxState().slot, null);
  });

  await test('T5 持有者被强杀 → TTL 后接管', { timeout: 25_000 }, async () => {
    const holder = guardProc(sandbox, ['hold', '--as', 'h5', '--', 'node', '-e', '"setTimeout(()=>process.exit(0),30000)"'], baseEnv);
    await waitForSlot(sandbox);
    holder.kill('SIGKILL');
    await sleep(1_200); // > ttlMs(900)：心跳必然过期
    const r = await run(['hold', '--as', 't5', '--', 'cmd', '/c', 'exit', '0']);
    assert.equal(r.code, 0, `exit=${r.code}\n${r.text}`);
    assert.ok(r.text.includes('接管'));
  });

  await test('T6 队列相位优先：sprint 越过先入队的 selftest', { timeout: 25_000 }, async () => {
    fs.rmSync(marker, { force: true });
    const holder = guardProc(sandbox, ['hold', '--as', 'h6', '--', 'node', '-e', '"setTimeout(()=>process.exit(0),1500)"'], baseEnv);
    await waitForSlot(sandbox);
    const a = guardProc(sandbox, ['hold', '--as', 'qSelf', '--purpose', 'selftest', '--',
      'node', '-e', `"require('fs').appendFileSync(process.env.SELFTEST_MARKER,'qSelf\\n')"`], baseEnv);
    await sleep(300);
    const b = guardProc(sandbox, ['hold', '--as', 'qSprint', '--purpose', 'accept-sprint', '--',
      'node', '-e', `"require('fs').appendFileSync(process.env.SELFTEST_MARKER,'qSprint\\n')"`], baseEnv);
    await Promise.all([a, b, holder].map((p) => new Promise((res) => p.on('exit', res))));
    const lines = markerLines().filter((l) => l === 'qSelf' || l === 'qSprint');
    assert.deepEqual(lines, ['qSprint', 'qSelf'], `sprint 应先于先入队的 selftest 执行，实际：${JSON.stringify(lines)}`);
  });

  await test('T7 等待超限：退出码 3 + 裁决指引 + 出队', { timeout: 20_000 }, async () => {
    writeJsonAtomic(cfgPath, { ...sandboxConfig(sandbox), ttlMs: 3_600_000, maxWaitMs: 800, pollMs: 100 });
    writeSandboxSlot(sandbox, freshSlot()); // 心跳新鲜且 TTL 巨大 → 永不可接管
    const r = await run(['hold', '--as', 't7', '--', 'cmd', '/c', 'exit', '0']);
    assert.equal(r.code, EXIT_WAIT_TIMEOUT, `exit=${r.code}\n${r.text}`);
    assert.ok(r.text.includes('裁决指引'), `应输出裁决指引：${r.text}`);
    assert.deepEqual(readSandboxState().queue, [], '超时后应出队');
    writeJsonAtomic(cfgPath, sandboxConfig(sandbox));
  });

  await test('T8 phase/status 可观察性', { timeout: 20_000 }, async () => {
    const bad = await run(['phase', 'nonsense', '--as', 't8']);
    assert.equal(bad.code, EXIT_USAGE);
    const ok = await run(['phase', 'accept-sprint', '--as', 't8', '--note', '出工单63证据']);
    assert.equal(ok.code, 0);
    const s = await run(['status', '--json']);
    const parsed = JSON.parse(s.text);
    assert.equal(parsed.agents.t8.declaredPhase, 'accept-sprint');
    assert.equal(parsed.agents.t8.note, '出工单63证据');
  });

  await test('T9 release --force 后立即可拿槽', { timeout: 20_000 }, async () => {
    writeJsonAtomic(cfgPath, { ...sandboxConfig(sandbox), ttlMs: 3_600_000 });
    writeSandboxSlot(sandbox, freshSlot()); // 新鲜租约 + 巨大 TTL：只能 force
    const rel = await run(['release', '--force']);
    assert.equal(rel.code, 0, `exit=${rel.code}\n${rel.text}`);
    assert.equal(readSandboxState().slot, null);
    const r = await run(['hold', '--as', 't9', '--', 'cmd', '/c', 'exit', '0']);
    assert.equal(r.code, 0);
    writeJsonAtomic(cfgPath, sandboxConfig(sandbox));
  });

  await test('T10 status 人类可读输出包含持锁方与队列', { timeout: 20_000 }, async () => {
    writeSandboxSlot(sandbox, freshSlot({ owner: '展示者' }));
    const s = await run(['status']);
    assert.ok(s.text.includes('展示者'), s.text);
    assert.ok(s.text.includes('验收槽'), s.text);
  });

  // 工单 #488：队列死条目收割——死头（pid 不存在且陈旧超阈）不堵候补轮；活 pid 条目
  // 即使陈旧也不误收（保守性双判据）。候补用 accept-sprint 越过活条目以拿到槽。
  await test('T11 队列死条目收割：死头不堵候补、活 pid 不误收', { timeout: 20_000 }, async () => {
    writeJsonAtomic(cfgPath, { ...sandboxConfig(sandbox), ttlMs: 3_600_000 });
    const deadE = {
      id: 'q-dead', name: 'dead-ghost', purpose: 'selftest', note: '', checkout: 'ghost',
      pid: 999_999, enqueuedMs: Date.now() - 60_000, enqueuedAt: localIso(),
    };
    const liveE = {
      id: 'q-live', name: 'live-but-stale', purpose: 'selftest', note: '', checkout: 'live',
      pid: process.pid, enqueuedMs: Date.now() - 60_000, enqueuedAt: localIso(),
    };
    writeJsonAtomic(path.join(sandbox, 'guard.json'), { slot: null, queue: [deadE, liveE], lastReleaseAt: null, lastReleaseMs: null });
    const r = await run(['hold', '--as', 't11', '--purpose', 'accept-sprint', '--', 'cmd', '/c', 'exit', '0']);
    assert.equal(r.code, 0, `死头收割后候补应立即拿槽：exit=${r.code}\n${r.text}`);
    assert.ok(r.text.includes('收割队列死条目'), `应留收割留痕：${r.text}`);
    const q = readSandboxState().queue;
    assert.deepEqual(q.map((e) => e.name), ['live-but-stale'],
      `活 pid 条目不得被误收、死条目应被收走，实际队列：${JSON.stringify(q.map((e) => e.name))}`);
    assert.ok(r.text.includes('已拿到验收槽：t11'), `候补应越过收割后的队列直接拿槽：${r.text}`);
    // 清尾：liveE 是活 pid（永不自动收割）——留给下段会把它段堵死，验完即清。
    writeJsonAtomic(path.join(sandbox, 'guard.json'), { slot: null, queue: [], lastReleaseAt: null, lastReleaseMs: null });
    writeJsonAtomic(cfgPath, sandboxConfig(sandbox));
  });

  // 工单 #488：验收命令看护——长跑命令超 cmdWatchMs 触发告警提示（不自动杀，命令照常跑完）。
  await test('T12 验收命令看护：超时告警出现且不杀', { timeout: 20_000 }, async () => {
    const r = await run(['hold', '--as', 't12', '--', 'node', '-e', '"setTimeout(()=>process.exit(0),1200)"']);
    assert.equal(r.code, 0, `看护不杀——命令应照常跑完：exit=${r.code}\n${r.text}`);
    assert.ok(r.text.includes('看护提示'), `1.2s 命令在 cmdWatchMs=400 下应至少告警一次：${r.text}`);
    assert.equal(readSandboxState().slot, null, '告警后照常释放');
  });

  await new Promise((res) => setTimeout(res, 100));
  fs.appendFileSync(path.join(sandbox, 'selftest-run.log'), `selftest 完成于 ${localIso()}\n`);
  console.log(`selftest 报告目录：${sandbox}（selftest-run.log）`);
}

// ---------- 入口 ----------

async function main() {
  const [, , sub, ...rest] = process.argv;
  const { flags, cmdPart } = parseGlobal(rest);
  switch (sub) {
    case 'hold': return cmdHold(flags, cmdPart);
    case 'status': return cmdStatus(flags);
    case 'phase': return cmdPhase(flags, cmdPart);
    case 'release': return cmdRelease(flags);
    case 'selftest': return cmdSelftest();
    default:
      die(EXIT_USAGE,
        'accept-guard —— 主机真机验收槽调度（协议见 README.md）\n' +
        '  hold [--as <名>] [--purpose selftest|accept-sprint] [--note <备>] -- <验收命令>\n' +
        '  status [--json]\n' +
        '  phase <dev|selftest|accept-sprint|human|idle> [--as <名>] [--note <备>]\n' +
        '  release --force\n' +
        '  selftest');
  }
}

main().catch((e) => {
  warn(`未预期的错误：${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
