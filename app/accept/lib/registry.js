'use strict';
/**
 * 电池接入表运行端读取器（工单214，spec #203 决策 1/2/5/6）——
 * 段级清单（app/accept/manifest.json）的**电池级条目**是电池接线的唯一登记处：
 * flag（控制器身份旗标）/ entry（电池模块路径）/ hintBar（验收提示条挂条条件）/
 * cdpPort（CDP 端口）/ kind（'experiment' = 取证工具，段级治理豁免）。
 *
 * 运行端（src/main/index.ts 的通用分发）与电池文件（自取 CDP 端口）共用本读取器——
 * 同一把尺，同一份表。表本身由 CI 校验器（accept/lib/manifest-check.js 的 validateRegistry）
 * 守住六项接线校验；本读取器只管读，不判红。
 */
const fs = require('fs');
const path = require('path');

/** 段级清单：电池接入表住在它的电池级条目里 */
const MANIFEST_FILE = path.join(__dirname, '..', 'manifest.json');
/** 仓库根（本文件住在 <仓库根>/app/accept/lib/）——表内 entry 是仓库根相对路径 */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

let cache;

/**
 * 读表（进程内一次）→ 接线条目数组。
 * 清单缺位/坏 JSON → 空数组（不炸：真问题由 CI 校验器判红，不在真机轮里炸）
 * @returns {Array<{id: string, flag: string, entry: string, hintBar: boolean, cdpPort: number|null, kind: string|null}>}
 */
function loadRegistry() {
  if (cache !== undefined) return cache;
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8')); } catch { manifest = null; }
  const batteries = (manifest && Array.isArray(manifest.batteries)) ? manifest.batteries : [];
  cache = batteries
    .filter((b) => b && typeof b.flag === 'string' && b.flag)
    .map((b) => ({
      id: String(b.id || ''),
      flag: b.flag,
      entry: String(b.entry || ''),
      hintBar: b.hintBar === true,
      cdpPort: Number.isInteger(b.cdpPort) ? b.cdpPort : null,
      kind: b.kind || null,
    }));
  return cache;
}

/**
 * 控制器身份匹配（表派生，工单214）：表内 flag 命中 argv → 该条目；未命中即非控制器。
 * @param {string[]} argv
 * @returns {object|null}
 */
function matchByFlag(argv) {
  const args = Array.isArray(argv) ? argv : [];
  for (const e of loadRegistry()) {
    if (args.includes(e.flag)) return e;
  }
  return null;
}

/**
 * 挂条条件（表派生，工单214）：命中条目的 hintBar 为真即挂条。
 * 形态与三条硬约束不动（ADR-0008 域）——这里只回答「挂不挂」。
 * @param {object|null} entry 命中的表条目
 * @returns {boolean}
 */
function hintBarRequired(entry) {
  return !!(entry && entry.hintBar);
}

/**
 * 电池的 CDP 端口（表派生，工单214）：无端口的电池留空（返回 null）。
 * @param {string} id 电池 id
 * @returns {number|null}
 */
function cdpPortFor(id) {
  const e = loadRegistry().find((x) => x.id === id);
  return e ? e.cdpPort : null;
}

/**
 * 电池模块的绝对路径（表派生，工单214）：表内 entry 是仓库根相对路径。
 * @param {string} entry 如 app/accept/battery.js
 * @returns {string}
 */
function modulePathFor(entry) {
  return path.join(REPO_ROOT, String(entry || ''));
}

module.exports = {
  MANIFEST_FILE,
  REPO_ROOT,
  loadRegistry,
  matchByFlag,
  hintBarRequired,
  cdpPortFor,
  modulePathFor,
};
