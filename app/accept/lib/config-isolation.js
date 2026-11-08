'use strict';
/**
 * 验收电池 config 隔离落点（工单402，事故：探针档位写进用户生产 config.json）。
 *
 * 面板配置落点原本写死 app/config.json，电池在哪个检出跑就改哪个检出的真配置；控制器
 * 中途死（崩溃/租约超时/强杀）时探针档位留在盘上，用户桌面静默失去自绘任务栏。本模块
 * 把「电池轮」的配置读写迁到一次性隔离文件：
 *
 *   1. 控制器分发时 prepareIsolation() —— 读用户配置（只读：播种隔离文件的初值）、把本轮
 *      快照（sha256 + 原文）落盘到 guard 目录、返回隔离文件路径；调用方写
 *      DECK_CONFIG_FILE=isolatedFile 并让面板子进程继承（battery-config 与面板侧
 *      resolveConfigFile 同口径读该变量）。
 *   2. 轮末 dispose() 删隔离文件与快照——用户配置全程零写入。
 *   3. 崩溃兜底：SIGKILL 不可捕获，快照留在盘上；下一轮 prepareIsolation() 先比对上一轮
 *      快照与当前用户配置，漂移即还原（battery-cleanup.checkConfigDrift，缺位来缺位去）。
 *   4. 可捕获的异常路径（SIGINT/SIGTERM/uncaughtException）由 installCrashGuard() 兜底：
 *      先判漂移还原、再清隔离落点、最后退出。
 *
 * 纯 node:fs（无 Electron 依赖）；测试经注入 tmpRoot/userConfigFile 与假 process 离线验证。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { snapshotConfig, checkConfigDrift } = require('./battery-cleanup');

const DEFAULT_USER_CONFIG_FILE = path.resolve(__dirname, '..', '..', 'config.json');

/** 每检出独立 guard 目录：按用户配置绝对路径取短哈希（大小写不敏感盘符口径） */
function guardDirFor(userConfigFile, tmpRoot) {
  const tag = crypto.createHash('sha256')
    .update(path.resolve(userConfigFile).toLowerCase())
    .digest('hex')
    .slice(0, 12);
  return path.join(tmpRoot, `deck-accept-config-guard-${tag}`);
}

let roundSeq = 0;

/**
 * 准备本轮隔离落点（控制器分发时调用一次）。
 * @param {{userConfigFile?: string, tmpRoot?: string, tag?: string, guardDir?: string}} [deps]
 *   userConfigFile 缺省 app/config.json；tmpRoot 缺省 os.tmpdir()；单测注入沙箱路径
 * @returns {{isolatedFile: string, guardDir: string, snapshot: object, residueRestored: boolean,
 *   residueBeforeSha: string|null, checkDrift: () => object, dispose: () => void}}
 */
function prepareIsolation(deps = {}) {
  const userConfigFile = path.resolve(deps.userConfigFile || DEFAULT_USER_CONFIG_FILE);
  const tmpRoot = deps.tmpRoot || os.tmpdir();
  const guardDir = deps.guardDir || guardDirFor(userConfigFile, tmpRoot);
  const tag = deps.tag || `${process.pid}-${Date.now()}-${roundSeq++}`;
  const isolatedFile = path.join(guardDir, `config-${tag}.json`);
  const snapshotFile = path.join(guardDir, 'snapshot.json');

  fs.mkdirSync(guardDir, { recursive: true });

  // 上一轮崩溃残留（快照还在 = 没走到 dispose）：先比对并还原，再为新轮取快照
  let residueRestored = false;
  let residueBeforeSha = null;
  try {
    const previous = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
    const judged = checkConfigDrift(previous);
    residueRestored = judged.drifted;
    residueBeforeSha = judged.afterSha;
  } catch { /* 无残留快照（首轮或上轮正常收尾） */ }

  const snapshot = snapshotConfig(userConfigFile);
  fs.writeFileSync(snapshotFile, JSON.stringify(snapshot), 'utf8');
  // 缺位态不落桩：battery-config.patchTaskbar 会按三态契约自建最小桩（与生产同口径）
  if (snapshot.raw !== null) fs.writeFileSync(isolatedFile, snapshot.raw, 'utf8');

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    // 整目录删除：连带清理面板 saveConfig 的 tmp 残片与散落文件（目录按检出独立且轮内独占）
    fs.rmSync(guardDir, { recursive: true, force: true });
  };
  const checkDrift = () => checkConfigDrift(snapshot);

  return { isolatedFile, guardDir, snapshot, residueRestored, residueBeforeSha, checkDrift, dispose };
}

/**
 * 挂可捕获的异常路径守卫（控制器分发时调用一次）。
 * 信号/未捕获异常到达时：先判用户配置漂移（命中即还原），再清隔离落点，最后退出。
 * 监听器随控制器进程生灭——正常收尾后进程随即退出，无需卸载。
 * @param {object} handle prepareIsolation 的返回值
 * @param {object} [proc] process 形接口（单测注入假 EventEmitter + exit）
 * @param {object} [log] 错误出口（缺省 console）
 */
function installCrashGuard(handle, proc = process, log = console) {
  const onFatal = (code, reason) => {
    try {
      const judged = handle.checkDrift();
      if (judged.drifted) {
        log.error(`[accept] ${reason}：用户 config 发现漂移，已还原（${judged.beforeSha} → ${judged.afterSha}）`);
      }
    } finally {
      try { handle.dispose(); } catch { /* 尽力 */ }
      proc.exit(code);
    }
  };
  proc.once('SIGINT', () => onFatal(130, 'SIGINT'));
  proc.once('SIGTERM', () => onFatal(143, 'SIGTERM'));
  proc.once('uncaughtException', (err) => {
    log.error('[accept] uncaughtException:', err);
    onFatal(1, 'uncaughtException');
  });
}

module.exports = { prepareIsolation, installCrashGuard };
