#!/usr/bin/env node
'use strict';
/**
 * 证据 PNG 哨兵（spec #281，CI 硬闸）——断言 git 跟踪集中证据 PNG 计数=0，非零判红。
 *
 * 分级口径（spec #281）：文本审计链（verdict/段账/jsonl/文本 log）随轮进版本历史；
 * 截图 PNG 只留存运行机器本地作审计件，不进版本历史。本哨兵防的是 `git add -f`
 * 式破防或未来脚本化提交——忽略规则（.gitignore）挡不住它们。
 *
 * 口径：`git ls-files` 全量枚举（**禁止 pathspec 通配**，防 #199 两次踩的漏报坑），
 * 按路径前缀计数：前缀 `app/accept/` 或 `.scratch/` 且后缀 `.png` 的跟踪文件必须为 0。
 * `archive/wallpaper-assets` 下 2 张上游壁纸像素资产非证据，不在证据口径内。
 *
 * 前缀口径**故意宽于** `.gitignore` 的忽略根（`app/accept/evidence/**`）：哨兵罩住 `app/accept/`
 * 整树，防未来证据截图落到 evidence/ 之外逃过门禁。合法非证据 PNG 若确需落 `app/accept/` 树，
 * 先过分类账盘点（章法守则）再调整哨兵口径。
 *
 * 用法（任意目录，仓库根直跑或 app/ 下皆可——脚本用 `git rev-parse --show-toplevel` 自定根，
 * 不依赖 cwd；CI 里 checkout 之后、Install dependencies 之前挂载，零依赖快失败）：
 *   node app/scripts/evidence-png-sentinel.js
 *
 * 退出码：0 = 绿（跟踪证据 PNG 计数 0）；1 = 红（逐行列出违规文件＋处置指引）。
 */

const { execFileSync } = require('child_process');

/** 证据目录前缀与证据后缀（spec #281 png-only 界线） */
const EVIDENCE_PREFIXES = ['app/accept/', '.scratch/'];
const EVIDENCE_SUFFIX = '.png';

/** 在仓库根跑 git（cwd 无关，POSIX 风格路径输出稳定） */
function git(args, repoRoot) {
  return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
}

/** 全量枚举跟踪文件并按口径筛出证据 PNG（不走 pathspec 通配） */
function collectEvidencePngs(repoRoot) {
  const out = git(['ls-files'], repoRoot);
  return String(out || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((p) => p.toLowerCase().endsWith(EVIDENCE_SUFFIX))
    .filter((p) => EVIDENCE_PREFIXES.some((prefix) => p.startsWith(prefix)));
}

function main() {
  let repoRoot;
  try {
    repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch (err) {
    console.error('evidence-png-sentinel：定位仓库根失败（git rev-parse --show-toplevel）——不在 git 仓库内？');
    console.error(String(err.message || err));
    return 1;
  }

  let violations;
  try {
    violations = collectEvidencePngs(repoRoot);
  } catch (err) {
    console.error('evidence-png-sentinel：git ls-files 枚举失败——退出。');
    console.error(String(err.message || err));
    return 1;
  }

  if (violations.length === 0) {
    console.log(
      `evidence-png-sentinel：绿——跟踪集中证据 PNG 计数=0（口径：前缀 ${EVIDENCE_PREFIXES.join(' / ')} 且后缀 ${EVIDENCE_SUFFIX}；spec #281 分级入库）`
    );
    return 0;
  }

  console.error(`evidence-png-sentinel：红——跟踪集中证据 PNG 计数=${violations.length}（应为 0，spec #281 分级入库）。违规文件：`);
  for (const p of violations) console.error(`  ${p}`);
  console.error('处置指引（分级界线无豁免）：');
  console.error('  1. git rm --cached <file>   # 索引出库，本地文件原地保留');
  console.error('  2. 若系历史遗留批量的，逐张出库后复跑本哨兵至绿；存量历史剥除另案（spec #281 Out of Scope），禁止自行 filter-repo/强推。');
  return 1;
}

process.exitCode = main();
