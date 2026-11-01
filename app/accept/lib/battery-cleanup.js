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
 * - 审计档：**仅当全文所有记录都属于电池包时**整份删除（有真实用户记录就保留——审计不能因测试被删）。
 *
 * 调用点：电池启动时一次（清上一轮崩溃残留）+ finally 里一次（面板停掉之后）。
 * 纯 node:fs，无 Electron 依赖。
 */

const fs = require('node:fs');
const path = require('node:path');

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

/** 对话窗元数据：删掉 label 以 accept- 开头的会话行与它们的 cwd 目录 */
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
    if (!id) continue;
    removeSafe(path.join(userData, 'conversation', 'cwd', id));
  }
  return dropped.length;
}

/**
 * 清场主入口：返回做了什么（供电池日志留痕）。
 * @param {string} userData 面板 userData 根
 * @returns {{ packages: string[], grants: number, configs: string[], backups: string[], sessions: number, audits: string[] }}
 */
function cleanupBatteryArtifacts(userData) {
  const report = { packages: [], grants: 0, configs: [], backups: [], sessions: 0, audits: [] };

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

  // 7) 审计档（只在全属电池包时删）
  for (const name of ['media-audit.jsonl', 'network-audit.jsonl']) {
    if (cleanAuditIfBatteryOnly(path.join(userData, name))) report.audits.push(name);
  }

  return report;
}

module.exports = { cleanupBatteryArtifacts, isBatteryPackageId, BATTERY_PACKAGE_IDS };
