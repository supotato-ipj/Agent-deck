'use strict';
/**
 * 证据分类账纯核（spec #281）——CommonJS、零依赖、纯函数。
 *
 * 输入两档：
 * - 原始 git 行流——`git rev-list --objects` 行（`<sha> <path>`；commit 行无 path）与
 *   `git cat-file --batch-check` 行（`<sha> <type> <size>`；对象取不到应答 `<sha> missing`），
 *   经 `parseRevListObjects` / `parseBatchCheck` 解析，或 `ledgerFromRawLines` 一步到账；
 * - 已解析 blob 行集 `[{path, size}]`（path 为仓库根相对 POSIX 路径，size 为字节数），
 *   经 `aggregate` 聚合。
 * 输出按扩展名与按二级目录的「字节＋计数」聚合（均按字节降序）。
 *
 * 纪律：本核**绝不 import git/child_process/fs**——spawn git 全部在 CLI 壳
 * `scripts/evidence-ledger.js`，壳把 stdout 原始行原样喂给本核。
 * tree/commit 行剔除、missing 行防御、同 path 多版本多行如实累积都在核里：同一 path 的
 * 多版本 blob 就是多行、各计各的——这是特性不是 bug：历代重拍的累积体积正是分类账要
 * 量化的东西（spec #281 Problem Statement），不按 path 去重。
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

/**
 * 解析 `git rev-list --objects` 原始行（`<sha> <path>`；commit 行无 path）。
 *
 * @param {string} stdout 命令 stdout 原文，按行拆（容忍 \r\n）。
 * @returns {{shas: string[], pathsBySha: Map<string, string>}}
 *   shas＝首次出现序的去重 sha 列表（作 cat-file --batch-check 的 stdin）；
 *   pathsBySha＝sha → path（首个空格分隔，path 内空格原样保留；同 sha 多行时取末次，
 *   防御性口径——git 正常输出每 sha 一行）。
 */
function parseRevListObjects(stdout) {
  const pathsBySha = new Map();
  const shas = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sp = trimmed.indexOf(' ');
    const sha = sp < 0 ? trimmed : trimmed.slice(0, sp);
    const p = sp < 0 ? '' : trimmed.slice(sp + 1).trim();
    if (!pathsBySha.has(sha)) shas.push(sha);
    pathsBySha.set(sha, p);
  }
  return { shas, pathsBySha };
}

/**
 * 解析 `git cat-file --batch-check` 原始行 × rev-list 的 pathsBySha → blob 行集。
 *
 * 只留 `<sha> blob <size>`；tree/commit 行剔除，`<sha> missing` 与其他短行/脏行
 * 防御性跳过（不抛），size 非有限数或负数跳过；pathsBySha 里没有的 sha 一律空 path。
 *
 * @param {string} stdout 命令 stdout 原文，按行拆（容忍 \r\n）。
 * @param {Map<string, string>} pathsBySha `parseRevListObjects` 给出的 sha → path 表。
 * @returns {Array<{path: string, size: number}>}
 */
function parseBatchCheck(stdout, pathsBySha) {
  const rows = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [sha, type, size] = parts;
    if (type !== 'blob') continue;
    const sizeNum = Number(size);
    if (!Number.isFinite(sizeNum) || sizeNum < 0) continue;
    rows.push({ path: (pathsBySha && pathsBySha.get(sha)) || '', size: sizeNum });
  }
  return rows;
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

/**
 * 顶层入口：两段原始行流 → 聚合账本。
 * 适合两段输出都已在手的调用方；CLI 壳走两段式（先 parseRevListObjects 拿 shas 喂
 * cat-file，再 parseBatchCheck ＋ aggregate），与本入口必得同结果。
 *
 * @param {string} revListOut `git rev-list --objects` stdout 原文
 * @param {string} batchCheckOut `git cat-file --batch-check` stdout 原文
 * @returns {{total: {bytes: number, count: number}, byExtension: Array<{key: string, bytes: number, count: number}>, byDirectory: Array<{key: string, bytes: number, count: number}>}}
 */
function ledgerFromRawLines(revListOut, batchCheckOut) {
  const { pathsBySha } = parseRevListObjects(revListOut);
  return aggregate(parseBatchCheck(batchCheckOut, pathsBySha));
}

module.exports = { aggregate, parseRevListObjects, parseBatchCheck, ledgerFromRawLines, extensionOf, directoryOf, NO_EXTENSION, ROOT_DIR };
