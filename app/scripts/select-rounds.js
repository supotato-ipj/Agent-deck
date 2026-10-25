#!/usr/bin/env node
'use strict';
/**
 * 定向验收轮 CLI（工单207，spec #201 A 分支决策4）——只打印计划与拼好的 accept-guard hold 命令行。
 *
 * 纪律：本命令**只打印**，不拉起任何 electron 模式、不抢验收槽——多检出并行安全。
 * 真正的执行仍走 accept-guard 调度协议（`guard.mjs hold --as <身份> --purpose <用途> -- npm run …`）。
 *
 * 用法（在 app/ 目录下）：
 *   node scripts/select-rounds.js                        # 默认基线 origin/master，取 origin/master...HEAD 的改动
 *   node scripts/select-rounds.js --base HEAD~1          # 指定基线 ref
 *   node scripts/select-rounds.js --worktree             # 追加未提交改动（含未跟踪文件）
 *   node scripts/select-rounds.js --files a.ts,b.ts      # 直接给文件集（逗号分隔）
 *   node scripts/select-rounds.js --as mcode --purpose accept-sprint
 *   node scripts/select-rounds.js --json                 # 机读输出
 *
 * 选项：
 *   --files <逗号分隔>   变更文件集（给了就不问 git）
 *   --base <ref>         diff 基线（默认 origin/master）
 *   --worktree           把未提交改动并进文件集
 *   --as <身份>          guard 持锁身份（默认取环境变量 ACCEPT_HOLDER，否则 agent）
 *   --purpose <用途>     guard 用途：selftest | accept-sprint（默认 selftest）
 *   --guard <路径>       guard.mjs 路径（默认取环境变量 ACCEPT_GUARD_HOME，其次 D:\test-folder\.accept-guard\guard.mjs）
 *   --json               机读输出（计划 JSON + 命令行数组）
 */

const path = require('path');
const { execFileSync } = require('child_process');
const { selectPlan, buildGuardCommands } = require('../accept/lib/area-selector');
const { loadManifest } = require('../accept/lib/report');

const APP_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_DIR, '..');
const DEFAULT_GUARD = 'D:\\test-folder\\.accept-guard\\guard.mjs';

/** 参数解析：--key value 与 --key=value 都收 */
function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (!a.startsWith('--')) { rest.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (key === 'worktree' || key === 'json' || key === 'help') { flags[key] = true; continue; }
    if (typeof next === 'string' && !next.startsWith('--')) { flags[key] = next; i++; continue; }
    flags[key] = true;
  }
  return { flags, rest };
}

/** git 取变更文件集（失败即抛出，由上层报错退出，不猜） */
function gitFiles(ref, includeWorktree) {
  const git = (args) => execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8' });
  const out = [];
  const push = (text) => {
    for (const line of String(text || '').split(/\r?\n/)) {
      const p = line.trim();
      if (p && !out.includes(p)) out.push(p);
    }
  };
  push(git(['diff', '--name-only', `${ref}...HEAD`]));
  if (includeWorktree) {
    push(git(['diff', '--name-only', 'HEAD']));
    push(git(['ls-files', '--others', '--exclude-standard']));
  }
  return out;
}

/** guard 路径：显式参数 > 环境变量 ACCEPT_GUARD_HOME > 本机默认；返回值是可执行命令行前缀 */
function resolveGuard(flag) {
  let p = null;
  if (flag && typeof flag === 'string') p = flag.trim();
  else if (process.env.ACCEPT_GUARD_HOME) p = path.join(process.env.ACCEPT_GUARD_HOME, 'guard.mjs');
  else p = DEFAULT_GUARD;
  if (!p) return 'node guard.mjs';
  // 路径形态的 guard.mjs 前面补 node（Windows 下 .mjs 不可直接执行）
  if (!/^(node|npm|cmd|pwsh|powershell)\b/i.test(p) && /\.(mjs|cjs|js)$/i.test(p)) return `node ${p}`;
  return p;
}

function usage() {
  console.log([
    '定向验收轮选择器（工单207 / spec #201 A2）——只打印计划与 guard hold 命令行，不占验收槽。',
    '',
    '  --files <逗号分隔>   变更文件集（给了就不问 git）',
    '  --base <ref>         diff 基线（默认 origin/master）',
    '  --worktree           把未提交改动并进文件集',
    '  --as <身份>          guard 持锁身份（默认 ACCEPT_HOLDER 或 agent）',
    '  --purpose <用途>     selftest | accept-sprint（默认 selftest）',
    '  --guard <路径>       guard.mjs 路径',
    '  --json               机读输出',
  ].join('\n'));
}

function main(argv) {
  const { flags } = parseArgs(argv);
  if (flags.help) { usage(); return 0; }

  const manifest = loadManifest();
  if (!manifest) {
    console.error('段级清单读不到（app/accept/manifest.json）——选段无据，退出。');
    return 1;
  }

  let files = [];
  if (Object.prototype.hasOwnProperty.call(flags, 'files')) {
    // 显式给了文件集（哪怕是空集）就不再问 git
    files = String(flags.files || '').split(',').map((s) => s.trim()).filter(Boolean);
  } else {
    const ref = typeof flags.base === 'string' && flags.base.trim() ? flags.base.trim() : 'origin/master';
    try {
      files = gitFiles(ref, Boolean(flags.worktree));
    } catch (err) {
      console.error(`取变更文件集失败（git diff ${ref}...HEAD）：${err.message}`);
      return 1;
    }
  }

  const plan = selectPlan({ changedFiles: files, manifest });
  const guard = resolveGuard(flags.guard);
  const holder = typeof flags.as === 'string' && flags.as.trim() ? flags.as.trim() : (process.env.ACCEPT_HOLDER || 'agent');
  const purpose = typeof flags.purpose === 'string' && flags.purpose.trim() ? flags.purpose.trim() : 'selftest';
  const commands = buildGuardCommands(plan, { guard, holder, purpose });

  if (flags.json) {
    console.log(JSON.stringify({ ...plan, commands }, null, 2));
    return 0;
  }

  console.log('=== 定向验收轮计划（工单207 / spec #201 A2）===');
  console.log(`改动文件：${plan.changedFiles.length} 个`);
  for (const f of plan.changedFiles) console.log(`  ${f}`);
  console.log(`命中域：${plan.areas.length ? plan.areas.join(', ') : '（无）'}`);
  console.log(`计划形态：${plan.conservative ? '保守（未收窄，多跑不少跑）' : '定向'}`);
  for (const r of plan.reasons) console.log(`  · ${r}`);
  if (plan.unmapped.length) {
    console.log(`未被映射表覆盖的源码文件（${plan.unmapped.length}）：`);
    for (const f of plan.unmapped) console.log(`  ! ${f}`);
  }
  if (plan.ignored.length) {
    console.log(`非面板域改动（${plan.ignored.length}，不进验收计划）：`);
    for (const f of plan.ignored) console.log(`  - ${f}`);
  }

  const full = plan.batteries.filter((b) => b.mode === 'full');
  const scoped = plan.batteries.filter((b) => b.mode === 'scoped');
  console.log('');
  console.log(`整块跑的电池（${full.length}）：`);
  for (const b of full) console.log(`  - ${b.id}  ${b.title}  ← ${b.reason}`);
  console.log(`按 --accept-scope 跑的段（${scoped.length}）：`);
  for (const b of scoped) console.log(`  - ${b.id}  ${b.segments.join(',')}  ← ${b.reason}`);

  console.log('');
  console.log('拼好的 guard hold 命令行（只打印，不执行；多检出并行安全）：');
  if (!commands.length) console.log('  （本次改动不命中任何验收段——没有要跑的轮）');
  for (const c of commands) console.log(`  ${c}`);
  console.log('');
  console.log(`下一步：在 ${APP_DIR} 目录下逐条执行（每条单独抢槽，排队最长 30 分钟，超时退出码 3）。`);
  console.log('轮次纪律见 docs/agents/battery-governance.md「定向验收轮与轮次纪律」。');
  return 0;
}

process.exitCode = main(process.argv.slice(2));
