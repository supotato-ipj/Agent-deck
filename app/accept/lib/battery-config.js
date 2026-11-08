'use strict';
// 电池 config 读写共通 helper（工单124，spec #125 Phase 0）——各电池的
// config.json 读写/还原单点维护（win32.js「四电池单点维护」同款先例）。
// 三态契约：
//   readConfigRaw()          → 原文 string；缺位 null（不抛 ENOENT——修 49/50 fresh worktree 秒败）
//   patchTaskbar(patch)      → 覆写 taskbar 段字段（保留其余字段原文档位），返回原文供还原；
//                              缺位落最小桩 {}（面板 loadConfig 按默认值补齐其余段）——
//                              语义与 right-group writeTaskbarFields 等价（真机背书的参照实现）
//   restoreConfig(raw|null)  → 三态还原：null → unlink 桩（缺位来、缺位去）；有原文 → 写回
//
// 落点（工单402）：生产落点是 app/config.json；DECK_CONFIG_FILE 覆盖优先——验收控制器把本轮
// 配置迁到一次性隔离文件，面板子进程继承同一变量。生效落点**按调用时环境解析**：模块加载
// 早于覆盖注入（如隔离模块的依赖链先加载本模块）时也不会绑错路径。
const fs = require('fs');
const path = require('path');

// 生产落点（用户真实配置）：恒指 app/config.json——config 漂移检查以它为准，不受隔离覆盖影响
const USER_CONFIG_FILE = path.resolve(__dirname, '..', '..', 'config.json');

/** 本进程生效落点（工单402）：DECK_CONFIG_FILE 覆盖优先，未设即生产落点 */
function effectiveConfigFile() {
  return process.env.DECK_CONFIG_FILE
    ? path.resolve(process.env.DECK_CONFIG_FILE)
    : USER_CONFIG_FILE;
}

function readConfigRawAt(configFile) {
  return fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : null;
}

function patchTaskbarAt(configFile, patch) {
  const raw = readConfigRawAt(configFile);
  const json = raw ? JSON.parse(raw) : {};
  json.taskbar = { ...(json.taskbar ?? {}), ...patch };
  fs.writeFileSync(configFile, JSON.stringify(json, null, 2) + '\n', 'utf8');
  return raw;
}

function restoreConfigAt(configFile, raw) {
  if (raw !== null) fs.writeFileSync(configFile, raw, 'utf8');
  else fs.rmSync(configFile, { force: true });
}

/** 建绑定指定 config 路径的 helper（真机电池用缺省实例；单测经此注入临时目录） */
function createBatteryConfig(configFile) {
  return {
    configFile,
    readConfigRaw: () => readConfigRawAt(configFile),
    patchTaskbar: (patch) => patchTaskbarAt(configFile, patch),
    restoreConfig: (raw) => restoreConfigAt(configFile, raw),
  };
}

module.exports = {
  // 每次访问按当前环境解析（模块导出 getter：电池在加载后解构也能拿到注入后的落点）
  get CONFIG_FILE() { return effectiveConfigFile(); },
  USER_CONFIG_FILE,
  createBatteryConfig,
  readConfigRaw: () => readConfigRawAt(effectiveConfigFile()),
  patchTaskbar: (patch) => patchTaskbarAt(effectiveConfigFile(), patch),
  restoreConfig: (raw) => restoreConfigAt(effectiveConfigFile(), raw),
};
