#!/usr/bin/env node
'use strict';
/**
 * 证据分类账 CLI（spec #281）——测出 git 历史里 blob 的构成与指定基线以来的增量，供任意时点复测。
 *
 * 分层：聚合逻辑全在纯核 `scripts/lib/ledger-core.js`（零依赖纯函数，有单测）；
 * 本壳只做 git 交互（rev-list --objects ＋ cat-file --batch-check）与人读表渲染。
 *
 * 口径：同一 path 的多版本 blob 是多行（历代重拍累积正是要量化的东西，不按 path 去重）；
 * 只取 blob（tree/commit 行剔除）；无扩展名 blob 归 `(无扩展名)` 桶；二级目录＝路径前两级。
 *
 * 用法（任意目录皆可，git 调用自动 -C 仓库根；在 app/ 下则 `node scripts/evidence-ledger.js`）：
 *   node scripts/evidence-ledger.js                          # 全史（git rev-list --objects --all）
 *   node scripts/evidence-ledger.js --since origin/master    # 基线以来新引入 blob（<ref>..HEAD）
 *   node scripts/evidence-ledger.js --since <ref> --json     # 机读输出
 *
 * 本票验收复测口径：分级入库合并后跑 `--since <合并点>`，断言 PNG blob 增量=0（文本 blob 照常）。
 */

const { execFileSync } = require('child_process');
const path = require('path');
const { aggregate } = require('./lib/ledger-core.js');

const APP_DIR = path.resolve(__dirname, '..');

/** 参数解析：--key value 与 --key=value 都收（对齐 select-rounds.js） */
function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (key === 'json' || key === 'help') { flags[key] = true; continue; }
    if (typeof next === 'string' && !next.startsWith('--')) { flags[key] = next; i++; continue; }
    flags[key] = true;
  }
  return flags;
}

function usage() {
  console.log([
    '证据分类账（spec #281）——git 历史 blob 构成与基线增量复测。',
    '',
    '  --since <ref>   只测 <ref>..HEAD 新引入的 blob（PNG 增量=0 的复测口径）',
    '  --json          机读输出',
    '  --help          本用法',
  ].join('\n'));
}

/** 仓库根定位（cwd 无关，CI/任意检出都稳） */
function repoRoot() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
}

/** rev-list --objects 行集 → [{path, size}]（只留 blob；多版本同 path 多行是特性） */
function collectBlobRows(root, revArgs) {
  const git = (args, opts) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });

  const objectsOut = git(['rev-list', '--objects', ...revArgs]);
  const pathsBySha = new Map();
  const shas = [];
  for (const line of String(objectsOut).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sp = trimmed.indexOf(' ');
    const sha = sp < 0 ? trimmed : trimmed.slice(0, sp);
    const p = sp < 0 ? '' : trimmed.slice(sp + 1).trim();
    if (!pathsBySha.has(sha)) shas.push(sha);
    pathsBySha.set(sha, p);
  }
  if (!shas.length) return [];

  // cat-file --batch-check：<sha> <type> <size>（missing 行剔除）
  const checkOut = git(['cat-file', '--batch-check'], { input: shas.join('\n') + '\n' });
  const rows = [];
  for (const line of String(checkOut).split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [sha, type, size] = parts;
    if (type !== 'blob') continue;
    const sizeNum = Number(size);
    if (!Number.isFinite(sizeNum) || sizeNum < 0) continue;
    rows.push({ path: pathsBySha.get(sha) || '', size: sizeNum });
  }
  return rows;
}

/** 人读字节量：B/KB/MB/GB（2 位小数） */
function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = -1;
  do { v /= 1024; u++; } while (v >= 1024 && u < units.length - 1);
  return `${v.toFixed(2)} ${units[u]}`;
}

function renderTable(title, buckets, totalBytes) {
  console.log(`${title}（字节降序）：`);
  for (const b of buckets) {
    const pct = totalBytes > 0 ? ` ${(100 * b.bytes / totalBytes).toFixed(1)}%` : '';
    console.log(`  ${b.key.padEnd(24)} ${String(b.count).padStart(6)} 个  ${humanBytes(b.bytes).padStart(12)}${pct}`);
  }
  if (!buckets.length) console.log('  （空——该范围内没有 blob）');
}

function main(argv) {
  const flags = parseArgs(argv);
  if (flags.help) { usage(); return 0; }

  const since = typeof flags.since === 'string' && flags.since.trim() ? flags.since.trim() : null;
  let root;
  try {
    root = repoRoot();
  } catch (err) {
    console.error('evidence-ledger：定位仓库根失败（git rev-parse --show-toplevel）——不在 git 仓库内？');
    return 1;
  }

  const revArgs = since ? [`${since}..HEAD`] : ['--all'];
  let rows;
  try {
    rows = collectBlobRows(root, revArgs);
  } catch (err) {
    console.error(`evidence-ledger：git 取 blob 行集失败（rev-list/cat-file，范围 ${since ? `${since}..HEAD` : '--all'}）：${err.message}`);
    return 1;
  }

  const ledger = aggregate(rows);
  const scopeLabel = since ? `基线以来（${since}..HEAD）` : '全史（--all）';

  if (flags.json) {
    console.log(JSON.stringify({ scope: since ? `since:${since}` : 'all', range: since ? `${since}..HEAD` : '--all', ...ledger }, null, 2));
    return 0;
  }

  console.log('=== 证据分类账（spec #281）===');
  console.log(`范围：${scopeLabel}｜blob 总量：${ledger.total.count} 个 / ${humanBytes(ledger.total.bytes)}`);
  console.log('');
  renderTable('按扩展名', ledger.byExtension, ledger.total.bytes);
  console.log('');
  renderTable('按二级目录', ledger.byDirectory, ledger.total.bytes);
  console.log('');
  console.log('口径：多版本同名 blob 各计各行（重拍累积如实入账）；tree/commit 已剔除；无扩展名归 (无扩展名) 桶。');
  console.log('复测口径（spec #281）：分级入库合并后 `--since <合并点>` 断言 PNG blob 增量=0。');
  return 0;
}

process.exitCode = main(process.argv.slice(2));
