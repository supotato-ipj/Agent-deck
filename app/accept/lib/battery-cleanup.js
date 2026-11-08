'use strict';
/**
 * 验收电池自清场（2026-11-01 补，事故：C10 装的认证联网卡在面板重启后上了用户桌面）。
 *
 * 验收面板与用户常驻面板**共用同一 userData**（单实例锁/共用配置是既有事实），所以电池装的
 * 投放包、写的授权账行、建的会话/工作目录如果不清，就会以「残留插件卡」「满屏 accept-* 会话」
 * 的形式出现在用户的真实桌面与对话窗里。本模块把「电池产出的东西」按可枚举的所有权清干净：
 *
 * - 投放包目录（电池自有 id 表 + `bulk-<n>` 批量测量包）；
 * - 授权账里这些包的账行（文件其余内容原样保留）；
 * - 私有配置 `<id>.json` / `<id>.json.detached`；
 * - 换代备份 `plugins-backup/old-<id>-*`；
 * - 待装载区（整目录，重新按需创建）；
 * - 对话窗元数据里 label 以 `accept-` 开头的会话行及其 cwd 工作目录；
 * - 审计档：**仅当全文所有记录都属于电池包时**整份删除（有真实用户记录就保留——审计不能因测试被删）；
 * - DSH provider 路由补丁（`dsh-home/profiles/acp/cordis.patch.yml`）：电池会把 provider 指到
 *   一次性罐头 LLM（端口随进程消失），补丁留着会让用户真实对话全连不上——标记命中即还原为空补丁。
 *
 * 调用点：电池启动时一次（清上一轮崩溃残留）+ finally 里一次（面板停掉之后）。
 * 纯 node:fs，无 Electron 依赖。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { USER_CONFIG_FILE } = require('./battery-config');

/** 电池自有的投放包 id（各段用过的一次性包；新增段请登记到这里） */
const BATTERY_PACKAGE_IDS = [
  'dsh-hello',
  'dsh-media',
  'dsh-media-ctl',
  'dsh-net',
  'dsh-net-auth',
  'dsh-reject',
  'dsh-mix',
];

function isBatteryPackageId(id) {
  return BATTERY_PACKAGE_IDS.includes(id) || /^bulk-\d+$/.test(id);
}

function readdirSafe(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function removeSafe(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** 授权账：只删电池包的账行，其余（用户包/撤销行）原样保留 */
function cleanLedger(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return 0;
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return 0;
  }
  const grants = Array.isArray(body && body.grants) ? body.grants : [];
  const kept = grants.filter((g) => !(g && isBatteryPackageId(String(g.packageId || ''))));
  const removed = grants.length - kept.length;
  if (removed > 0) {
    body.grants = kept;
    try {
      fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n', 'utf8');
    } catch {
      return 0;
    }
  }
  return removed;
}

/** 审计档：全部记录都属于电池包才整份删（有真实记录就保留——测试不得删用户审计） */
function cleanAuditIfBatteryOnly(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  for (const line of lines) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      return false; // 不可解析的档不碰
    }
    const pkg = rec && rec.packageId;
    if (typeof pkg !== 'string' || !isBatteryPackageId(pkg)) return false;
  }
  return removeSafe(file);
}

/** 对话窗元数据：删掉 label 以 accept- 开头的会话行、它们的 cwd 目录与 DSH 侧会话缓存 */
function cleanSessions(userData) {
  const metaFile = path.join(userData, 'conversation', 'metadata.json');
  let raw;
  try {
    raw = fs.readFileSync(metaFile, 'utf8');
  } catch {
    return 0;
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return 0;
  }
  const sessions = Array.isArray(body && body.sessions) ? body.sessions : [];
  const dropped = sessions.filter((s) => s && typeof s.label === 'string' && s.label.startsWith('accept-'));
  if (dropped.length === 0) return 0;
  const keep = sessions.filter((s) => !(s && typeof s.label === 'string' && s.label.startsWith('accept-')));
  body.sessions = keep;
  try {
    fs.writeFileSync(metaFile, JSON.stringify(body, null, 2) + '\n', 'utf8');
  } catch {
    return 0;
  }
  for (const s of dropped) {
    const id = typeof s.id === 'string' ? s.id : null;
    if (id) removeSafe(path.join(userData, 'conversation', 'cwd', id));
    // DSH 自己的 session 投影缓存（backendSessionId 命名；孤儿缓存不清会一直堆）
    const backendId = typeof s.backendSessionId === 'string' ? s.backendSessionId : null;
    if (backendId && /^[a-zA-Z0-9-]+$/.test(backendId)) {
      removeSafe(path.join(userData, 'dsh-home', 'storages', 'session_projcache', 'sessions', `${backendId}.json`));
    }
  }
  return dropped.length;
}

/**
 * 清场主入口：返回做了什么（供电池日志留痕）。
 * @param {string} userData 面板 userData 根
 * @returns {{ packages: string[], grants: number, configs: string[], backups: string[], sessions: number, audits: string[], dshPatchReset?: boolean }}
 */
function cleanupBatteryArtifacts(userData) {
  const report = { packages: [], grants: 0, configs: [], backups: [], sessions: 0, audits: [], dshPatchReset: false };

  // 1) 投放包目录
  const pluginsRoot = path.join(userData, 'plugins');
  for (const name of readdirSafe(pluginsRoot)) {
    if (!isBatteryPackageId(name)) continue;
    if (removeSafe(path.join(pluginsRoot, name))) report.packages.push(name);
  }

  // 2) 授权账行
  report.grants = cleanLedger(path.join(userData, 'plugin-authorizations.json'));

  // 3) 私有配置（含 rejected-inheritance 的 .detached）
  const configRoot = path.join(userData, 'plugin-config');
  for (const name of readdirSafe(configRoot)) {
    const id = name.replace(/\.json(\.detached)?$/, '');
    if (!isBatteryPackageId(id)) continue;
    if (removeSafe(path.join(configRoot, name))) report.configs.push(name);
  }

  // 4) 换代备份（old-<id>-<opId>）
  const backupRoot = path.join(userData, 'plugins-backup');
  for (const name of readdirSafe(backupRoot)) {
    const hit = BATTERY_PACKAGE_IDS.some((id) => name.startsWith(`old-${id}-`));
    if (!hit) continue;
    if (removeSafe(path.join(backupRoot, name))) report.backups.push(name);
  }

  // 5) 待装载区（电池每轮都会清扫；这里兜底）
  removeSafe(path.join(userData, 'plugins-staging'));

  // 6) 会话行 + cwd
  report.sessions = cleanSessions(userData);

  // 7) DSH provider 路由补丁：电池把 provider 指到一次性罐头 LLM（端口会失效），
  //    补丁留着会让用户真实对话全连不上——标记命中就还原为空补丁（其余补丁内容不碰）
  const patchFile = path.join(userData, 'dsh-home', 'profiles', 'acp', 'cordis.patch.yml');
  try {
    const patch = fs.readFileSync(patchFile, 'utf8');
    if (patch.includes('DECK_CHAT_ACCEPT_LLM_KEY')) {
      fs.writeFileSync(patchFile, '[]\n', 'utf8');
      report.dshPatchReset = true;
    }
  } catch { /* 无补丁文件 = 无需处理 */ }

  // 8) 审计档（只在全属电池包时删）
  for (const name of ['media-audit.jsonl', 'network-audit.jsonl']) {
    if (cleanAuditIfBatteryOnly(path.join(userData, name))) report.audits.push(name);
  }

  return report;
}

/** sha256 原文摘要（工单402 漂移比对口径） */
function sha256Of(raw) {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * config 漂移检查·轮前快照（工单402）：目标缺省为生产落点（USER_CONFIG_FILE），
 * 不受 DECK_CONFIG_FILE 隔离覆盖影响——隔离失效时本检查是用户配置的最后一道兜底。
 * @param {string} [configFile] 目标配置文件（单测注入临时文件）
 * @returns {{file: string, sha256: string|null, raw: string|null}} 缺位来（raw=null）、在位带原文
 */
function snapshotConfig(configFile = USER_CONFIG_FILE) {
  const raw = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : null;
  return { file: configFile, sha256: raw === null ? null : sha256Of(raw), raw };
}

/**
 * config 漂移检查·轮后比对（工单402）：sha256 不等即判红并还原（缺位来、缺位去）。
 * 调用方据 drifted 记降责账（rep.exclude）——本函数只判、只还原，不记账。
 * @param {{file: string, sha256: string|null, raw: string|null}} snapshot 轮前快照
 * @returns {{drifted: boolean, restored: boolean, beforeSha: string|null, afterSha: string|null}}
 */
function checkConfigDrift(snapshot) {
  const currentRaw = fs.existsSync(snapshot.file) ? fs.readFileSync(snapshot.file, 'utf8') : null;
  const currentSha = currentRaw === null ? null : sha256Of(currentRaw);
  if (currentSha === snapshot.sha256) {
    return { drifted: false, restored: false, beforeSha: snapshot.sha256, afterSha: currentSha };
  }
  if (snapshot.raw === null) fs.rmSync(snapshot.file, { force: true });
  else fs.writeFileSync(snapshot.file, snapshot.raw, 'utf8');
  return { drifted: true, restored: true, beforeSha: snapshot.sha256, afterSha: currentSha };
}

module.exports = { cleanupBatteryArtifacts, isBatteryPackageId, BATTERY_PACKAGE_IDS, snapshotConfig, checkConfigDrift };
