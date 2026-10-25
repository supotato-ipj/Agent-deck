'use strict';
/**
 * 证据分类账聚合纯核（spec #281）——CommonJS、零依赖、纯函数。
 *
 * 输入 blob 行集 `[{path, size}]`（path 为仓库根相对 POSIX 路径，size 为字节数）；
 * 输出按扩展名与按二级目录的「字节＋计数」聚合（均按字节降序）。
 *
 * 纪律：本核**绝不 import git/child_process/fs**——git 交互（rev-list --objects /
 * cat-file --batch-check）全部在 CLI 壳 `scripts/evidence-ledger.js` 里。
 * 同一 path 的多版本 blob 就是多行、各计各的——这是特性不是 bug：历代重拍的
 * 累积体积正是分类账要量化的东西（spec #281 Problem Statement），不按 path 去重。
 *
 * 口径：
 * - 扩展名取路径末段最后一个点之后（小写归一）；无扩展名（含点开头裸名如 `.gitignore`）
 *   归入 `(无扩展名)` 桶；
 * - 二级目录＝路径前两级（`app/accept/evidence/x.png` → `app/accept`）；根级文件归 `(根目录)`；
 * - 排序：字节降序 → 计数降序 → key 码点升序（全确定性，同输入必同输出）。
 */

/** 无扩展名桶（任务书 D3 定名） */
const NO_EXTENSION = '(无扩展名)';
/** 根级文件在二级目录聚合里的桶 */
const ROOT_DIR = '(根目录)';

/** 扩展名判定：末段最后一个点之后小写归一；无点/点在首位 → (无扩展名) */
function extensionOf(filePath) {
  const base = String(filePath || '').split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return NO_EXTENSION;
  return base.slice(dot + 1).toLowerCase();
}

/** 二级目录判定：前两级路径；根级文件 → (根目录) */
function directoryOf(filePath) {
  const segments = String(filePath || '').split('/').filter(Boolean);
  if (segments.length >= 2) return `${segments[0]}/${segments[1]}`;
  return ROOT_DIR;
}

/** 单桶累加器：key → {bytes, count} */
function tallyInto(map, key, size) {
  const bucket = map.get(key);
  if (bucket) { bucket.bytes += size; bucket.count += 1; }
  else map.set(key, { bytes: size, count: 1 });
}

/** 桶 map → 降序数组（字节降序 → 计数降序 → key 码点升序） */
function bucketsSorted(map) {
  return Array.from(map.entries())
    .map(([key, v]) => ({ key, bytes: v.bytes, count: v.count }))
    .sort((a, b) => (b.bytes - a.bytes) || (b.count - a.count) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * 聚合入口：blob 行集 → { total, byExtension, byDirectory }。
 * 非法行（path 非字符串或 size 非有限数）防御性跳过，不抛——测量工具不吃脏行。
 *
 * @param {Array<{path: string, size: number}>} rows
 * @returns {{total: {bytes: number, count: number}, byExtension: Array<{key: string, bytes: number, count: number}>, byDirectory: Array<{key: string, bytes: number, count: number}>}}
 */
function aggregate(rows) {
  const byExt = new Map();
  const byDir = new Map();
  let totalBytes = 0;
  let totalCount = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row.path !== 'string' || !Number.isFinite(row.size) || row.size < 0) continue;
    tallyInto(byExt, extensionOf(row.path), row.size);
    tallyInto(byDir, directoryOf(row.path), row.size);
    totalBytes += row.size;
    totalCount += 1;
  }
  return {
    total: { bytes: totalBytes, count: totalCount },
    byExtension: bucketsSorted(byExt),
    byDirectory: bucketsSorted(byDir),
  };
}

module.exports = { aggregate, extensionOf, directoryOf, NO_EXTENSION, ROOT_DIR };
