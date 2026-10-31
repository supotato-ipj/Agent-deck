#!/usr/bin/env node
'use strict';
/**
 * 本地检出清理（工单349）——盘点并清理只存在于本机的未跟踪遗留。
 *
 * 边界：只删未跟踪文件；tracked 文件与 git 历史零改动——分支、stash、gc 三类只报告不执行
 * （它们不可逆，必须人工确认）。默认 dry-run，--apply 才落盘。
 *
 * 类别：
 *   scratch-oversize   .scratch 下未跟踪、超阈值、非 .md/.txt/.patch 的文件
 *   evidence-images    app/accept/evidence 下超过保留窗的图片（像素证据只留本机，spec #281）
 *   userdata-caches    %APPDATA%/agent-deck-panel 下的 Chromium 缓存目录
 *   orphan-checkouts   父目录下 <repo>--* 且未被 git worktree 登记的目录（只报告）
 *   git-refs           未合并本地分支与 stash 条数（只报告）
 *
 * 用法（在 app/ 下）：
 *   node scripts/cleanup-local.js
 *   node scripts/cleanup-local.js --apply
 *   node scripts/cleanup-local.js --json --keep-days 7 --min-mb 1
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const APP_DIR = path.resolve(__dirname, '..');
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const KEEP_EXTS = new Set(['.md', '.txt', '.patch']);
const USERDATA_CACHES = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'GrShaderCache',
  'ShaderCache',
  'DawnWebGPUCache',
  'DawnGraphiteCache',
];

/** 参数解析：--key value 与 --key=value 都收（对齐 evidence-ledger.js） */
function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (key === 'apply' || key === 'json' || key === 'help') { flags[key] = true; continue; }
    if (typeof next === 'string' && !next.startsWith('--')) { flags[key] = next; i++; continue; }
    flags[key] = true;
  }
  return flags;
}

function usage() {
  console.log([
    '本地检出清理（工单349）——只碰未跟踪文件，不碰 tracked 与 git 历史。',
    '',
    '  --apply          执行删除（缺省 dry-run，只打印清单）',
    '  --json           机读输出',
    '  --keep-days <n>  evidence 图片保留天数（默认 7，与 master 历史窗同口径）',
    '  --min-mb <n>     .scratch 大文件阈值（默认 1）',
    '  --help           本用法',
  ].join('\n'));
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function repoRoot() {
  return git(APP_DIR, ['rev-parse', '--show-toplevel']).trim();
}

function relPosix(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/');
}

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 递归列文件；不进符号链接/联接（避免把目标目录当成本地遗留删掉） */
function walkFiles(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walkFiles(abs, out);
    else if (entry.isFile()) {
      try {
        out.push({ abs, size: fs.statSync(abs).size });
      } catch {
        /* 读不到就跳过 */
      }
    }
  }
  return out;
}

function trackedSet(root) {
  const raw = git(root, ['ls-files', '-z']);
  return new Set(raw.split('\0').filter(Boolean));
}

function collectScratch(root, tracked, minBytes) {
  const dir = path.join(root, '.scratch');
  if (!fs.existsSync(dir)) return [];
  return walkFiles(dir, [])
    .filter(({ abs, size }) => {
      if (size <= minBytes) return false;
      if (KEEP_EXTS.has(path.extname(abs).toLowerCase())) return false;
      return !tracked.has(relPosix(root, abs));
    })
    .map(({ abs, size }) => ({ category: 'scratch-oversize', path: abs, size }));
}

function collectEvidence(appDir, keepDays, now) {
  const dir = path.join(appDir, 'accept', 'evidence');
  if (!fs.existsSync(dir)) return [];
  const cutoff = now - keepDays * 24 * 60 * 60 * 1000;
  return walkFiles(dir, [])
    .filter(({ abs }) => IMAGE_EXTS.has(path.extname(abs).toLowerCase()))
    .filter(({ abs }) => fs.statSync(abs).mtimeMs < cutoff)
    .map(({ abs, size }) => ({ category: 'evidence-images', path: abs, size }));
}

function collectUserDataCaches() {
  const base = process.env.APPDATA
    ? path.join(process.env.APPDATA, 'agent-deck-panel')
    : null;
  if (!base || !fs.existsSync(base)) return [];
  const items = [];
  for (const name of USERDATA_CACHES) {
    const abs = path.join(base, name);
    if (!fs.existsSync(abs)) continue;
    const files = walkFiles(abs, []);
    items.push({
      category: 'userdata-caches',
      path: abs,
      size: files.reduce((sum, f) => sum + f.size, 0),
    });
  }
  return items;
}

function registeredWorktrees(root) {
  const raw = git(root, ['worktree', 'list', '--porcelain']);
  return new Set(
    raw
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => path.resolve(line.slice('worktree '.length).trim())),
  );
}

function collectOrphanCheckouts(root) {
  const parent = path.dirname(root);
  const prefix = `${path.basename(root)}--`;
  const registered = registeredWorktrees(root);
  const items = [];
  let entries;
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return items;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (!entry.name.startsWith(prefix)) continue;
    const abs = path.join(parent, entry.name);
    if (registered.has(path.resolve(abs))) continue;
    const files = walkFiles(abs, []);
    items.push({
      category: 'orphan-checkouts',
      path: abs,
      size: files.reduce((sum, f) => sum + f.size, 0),
      reportOnly: true,
    });
  }
  return items;
}

function collectGitRefs(root) {
  const items = [];
  let branches = [];
  try {
    branches = git(root, ['branch', '--no-merged', 'master', '--format=%(refname:short)'])
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    /* 没有 master 或非 git 仓库：跳过 */
  }
  for (const name of branches) {
    items.push({ category: 'git-refs', path: `branch ${name}`, size: 0, reportOnly: true });
  }
  const stashes = git(root, ['stash', 'list'])
    .split('\n')
    .filter(Boolean);
  if (stashes.length > 0) {
    items.push({
      category: 'git-refs',
      path: `${stashes.length} 条 stash（先导出 patch 再 drop）`,
      size: 0,
      reportOnly: true,
    });
  }
  return items;
}

/** 白名单根校验：只允许删这三类根下的路径 */
function isDeletable(item, roots) {
  const abs = path.resolve(item.path);
  return roots.some((root) => abs === root || abs.startsWith(root + path.sep));
}

function applyDeletes(items, roots) {
  const failures = [];
  const deleted = [];
  for (const item of items) {
    if (!isDeletable(item, roots)) {
      failures.push({ path: item.path, error: '拒绝：不在白名单根内' });
      continue;
    }
    try {
      fs.rmSync(item.path, { recursive: true, force: true });
      deleted.push(item.path);
    } catch (error) {
      failures.push({ path: item.path, error: error.code || String(error) });
    }
  }
  return { deleted, failures };
}

function render(items, options) {
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.category)) groups.set(item.category, []);
    groups.get(item.category).push(item);
  }
  for (const [category, rows] of groups) {
    rows.sort((a, b) => b.size - a.size);
    console.log(`\n[${category}]${rows[0].reportOnly ? '（只报告，不自动删）' : ''}`);
    for (const row of rows) {
      console.log(`  ${human(row.size).padStart(10)}  ${row.path}`);
    }
  }
  const deletable = items.filter((item) => !item.reportOnly);
  const total = deletable.reduce((sum, item) => sum + item.size, 0);
  console.log(
    `\n共 ${items.length} 项；可删 ${deletable.length} 项，预计回收 ${human(total)}。` +
      (options.apply ? '' : '（dry-run：加 --apply 才执行）'),
  );
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    usage();
    return;
  }
  const root = repoRoot();
  const keepDays = Number.parseInt(flags['keep-days'], 10);
  const minMb = Number.parseFloat(flags['min-mb']);
  const options = {
    apply: Boolean(flags.apply),
    keepDays: Number.isFinite(keepDays) && keepDays >= 0 ? keepDays : 7,
    minBytes: Math.max(0, (Number.isFinite(minMb) ? minMb : 1) * 1024 * 1024),
  };

  const tracked = trackedSet(root);
  const items = [
    ...collectScratch(root, tracked, options.minBytes),
    ...collectEvidence(APP_DIR, options.keepDays, Date.now()),
    ...collectUserDataCaches(),
    ...collectOrphanCheckouts(root),
    ...collectGitRefs(root),
  ];

  const roots = [path.join(root, '.scratch'), path.join(APP_DIR, 'accept', 'evidence')];
  if (process.env.APPDATA) {
    roots.push(path.join(process.env.APPDATA, 'agent-deck-panel'));
  }

  let result = { deleted: [], failures: [] };
  if (options.apply) {
    const deletable = items.filter((item) => !item.reportOnly);
    result = applyDeletes(deletable, roots);
  }

  if (flags.json) {
    console.log(
      JSON.stringify(
        { repoRoot: root, keepDays: options.keepDays, items, ...result },
        null,
        2,
      ),
    );
  } else {
    render(items, options);
    if (options.apply) {
      console.log(`已删除 ${result.deleted.length} 项。`);
      if (result.failures.length > 0) {
        console.log(`失败 ${result.failures.length} 项：`);
        for (const failure of result.failures) {
          console.log(`  ${failure.path}  ${failure.error}`);
        }
      }
    }
  }

  if (result.failures.length > 0) process.exitCode = 1;
}

main();
