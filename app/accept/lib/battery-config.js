'use strict';
// 电池 config 读写共通 helper（工单124，spec #125 Phase 0）——四块任务栏副电池的
// config.json 读写/还原单点维护（win32.js「四电池单点维护」同款先例）。
// 三态契约：
//   readConfigRaw()          → 原文 string；缺位 null（不抛 ENOENT——修 49/50 fresh worktree 秒败）
//   patchTaskbar(patch)      → 覆写 taskbar 段字段（保留其余字段原文档位），返回原文供还原；
//                              缺位落最小桩 {}（面板 loadConfig 按默认值补齐其余段）——
//                              语义与 right-group writeTaskbarFields 等价（真机背书的参照实现）
//   restoreConfig(raw|null)  → 三态还原：null → unlink 桩（缺位来、缺位去）；有原文 → 写回
const fs = require('fs');
const path = require('path');

// 面板 config.json 落点：app/config.json（各电池原 CONFIG_FILE 同值，单点收编于此）
const CONFIG_FILE = path.resolve(__dirname, '..', '..', 'config.json');

/** 建绑定指定 config 路径的 helper（真机电池用缺省实例；单测经此注入临时目录） */
function createBatteryConfig(configFile) {
  return {
    configFile,
    readConfigRaw() {
      return fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : null;
    },
    patchTaskbar(patch) {
      const raw = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : null;
      const json = raw ? JSON.parse(raw) : {};
      json.taskbar = { ...(json.taskbar ?? {}), ...patch };
      fs.writeFileSync(configFile, JSON.stringify(json, null, 2) + '\n', 'utf8');
      return raw;
    },
    restoreConfig(raw) {
      if (raw !== null) fs.writeFileSync(configFile, raw, 'utf8');
      else fs.rmSync(configFile, { force: true });
    },
  };
}

const defaultConfig = createBatteryConfig(CONFIG_FILE);

module.exports = {
  CONFIG_FILE,
  createBatteryConfig,
  readConfigRaw: defaultConfig.readConfigRaw,
  patchTaskbar: defaultConfig.patchTaskbar,
  restoreConfig: defaultConfig.restoreConfig,
};
