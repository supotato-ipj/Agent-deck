#!/usr/bin/env node
'use strict';
/**
 * NotifyIconSettings 僵尸条目清理（工单433）——清 explorer 侧托盘注册账本的存量。
 *
 * 事实源：HKCU\Control Panel\NotifyIconSettings。只删两类（判定在 scripts/lib/notifyicon-core.js）：
 *   dead-path     ExecutablePath 解析后指向不存在的文件（已删 worktree 的面板图标、卸载残留）
 *   probe-zombie  InitialTooltip 精确等于 DECK164-PROBE-V0/V4（#325 红轮探针被 OS 路由进
 *                 explorer 真托盘的残留；exe 路径可能仍在，白名单兜底）
 * 活路径条目、不可解析路径、无路径条目一律不动。默认 dry-run，--apply 才落盘。
 * 不代杀 explorer：删完提示重启 explorer（或注销重登），托盘溢出层随之收敛。
 *
 * 用法（在 app/ 下）：
 *   npm run cleanup:notifyicons
 *   npm run cleanup:notifyicons -- --apply
 *   npm run cleanup:notifyicons -- --json
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseNotifyIconRegExport, resolveExecutablePath, judgeNotifyIconEntry, VERDICT } =
  require('./lib/notifyicon-core.js');

const REG_KEY = 'HKCU\\Control Panel\\NotifyIconSettings';

/** 参数解析：只收 --apply / --json / --help 三个布尔旗标（操作习惯对齐 cleanup-local.js） */
function parseArgs(argv) {
  const flags = {};
  for (const a of argv) {
    const s = String(a);
    if (!s.startsWith('--')) continue;
    const key = s.slice(2);
    if (key === 'apply' || key === 'json' || key === 'help') flags[key] = true;
  }
  return flags;
}

function usage() {
  console.log([
    'NotifyIconSettings 僵尸条目清理（工单433）——只删死路径与探针白名单，活进程条目不动。',
    '',
    '  --apply  执行删除（缺省 dry-run，只打印清单）',
    '  --json   机读输出',
    '  --help   本用法',
  ].join('\n'));
}

/** reg export 到临时文件再读回（UTF-16LE）——reg query 的 ANSI 输出会 mojibake 中文路径 */
function exportRegistry() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-nis-'));
  const file = path.join(dir, 'notifyicons.reg');
  try {
    execFileSync('reg.exe', ['export', REG_KEY, file, '/y'], { stdio: 'pipe' });
    return fs.readFileSync(file, 'utf16le');
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 尽力清理 */
    }
  }
}

/** 存在性事实：盘符/网络共享不可达（外接盘离线、NAS 断网）时「不存在」不可判死，返回 null */
function probeExistence(resolvedPath) {
  if (!resolvedPath) return null;
  const root = path.parse(resolvedPath).root;
  if (root && !fs.existsSync(root)) return null;
  return fs.existsSync(resolvedPath);
}

/** 同一判据复用于扫描与落盘前重探：壳只提供存在性事实，判定归纯核 */
function verdictOf(entry, resolvedPath) {
  const exists = probeExistence(resolvedPath);
  return judgeNotifyIconEntry(entry, exists === null ? null : resolvedPath, exists === true);
}

function collectFacts(entries, env) {
  return entries.map((entry) => {
    const resolvedPath = resolveExecutablePath(entry.executablePath, env);
    return { ...entry, resolvedPath, verdict: verdictOf(entry, resolvedPath) };
  });
}

function applyDeletes(facts) {
  const deleted = [];
  const skipped = [];
  const failures = [];
  for (const fact of facts) {
    // 扫描与落盘之间活路径可能恢复（或盘刚挂回），恢复即放行，不算失败
    if (verdictOf(fact, fact.resolvedPath) === VERDICT.KEEP) {
      skipped.push(fact.key);
      continue;
    }
    try {
      execFileSync('reg.exe', ['delete', `${REG_KEY}\\${fact.key}`, '/f'], { stdio: 'pipe' });
      deleted.push(fact.key);
    } catch (error) {
      failures.push({ key: fact.key, error: String(error.stderr || error.code || error) });
    }
  }
  return { deleted, skipped, failures };
}

function render(facts, options) {
  for (const fact of facts) {
    const detail = fact.resolvedPath || fact.executablePath || '（无 ExecutablePath）';
    const tip = fact.initialTooltip ? `  tooltip="${fact.initialTooltip}"` : '';
    console.log(`  [${fact.verdict}]  ${fact.key}  ${detail}${tip}`);
  }
  const pending = facts.filter((fact) => fact.verdict !== VERDICT.KEEP);
  const dead = pending.filter((fact) => fact.verdict === VERDICT.DEAD_PATH).length;
  const probe = pending.filter((fact) => fact.verdict === VERDICT.PROBE_ZOMBIE).length;
  console.log(
    `\n共 ${facts.length} 条；待删 ${pending.length} 条（dead-path ${dead}，probe-zombie ${probe}）；` +
      `其余 ${facts.length - pending.length} 条保留。` +
      (options.apply ? '' : '（dry-run：加 --apply 才执行）'),
  );
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    usage();
    return;
  }
  const options = { apply: Boolean(flags.apply) };

  let entries;
  try {
    entries = parseNotifyIconRegExport(exportRegistry());
  } catch (error) {
    console.error(`读 ${REG_KEY} 失败：${String(error.message || error)}`);
    process.exitCode = 1;
    return;
  }

  const facts = collectFacts(entries, process.env);
  const pending = facts.filter((fact) => fact.verdict !== VERDICT.KEEP);
  const restartHint = '重启 explorer（或注销重登）后托盘溢出层才会同步收敛——本脚本不代杀 explorer。';

  if (flags.json) {
    const result = options.apply ? applyDeletes(pending) : { deleted: [], skipped: [], failures: [] };
    console.log(
      JSON.stringify(
        {
          total: facts.length,
          entries: facts,
          ...result,
          explorerRestartHint: result.deleted.length > 0 ? restartHint : null,
        },
        null,
        2,
      ),
    );
    if (result.failures.length > 0) process.exitCode = 1;
    return;
  }

  render(facts, options);
  if (!options.apply) return;

  const result = applyDeletes(pending);
  console.log(`已删除 ${result.deleted.length} 条。`);
  if (result.skipped.length > 0) {
    console.log(`扫描后已恢复存在、放行 ${result.skipped.length} 条：${result.skipped.join(', ')}`);
  }
  if (result.failures.length > 0) {
    console.log(`删除失败 ${result.failures.length} 条：`);
    for (const failure of result.failures) console.log(`  ${failure.key}  ${failure.error}`);
  }
  if (result.deleted.length > 0) console.log(`提示：${restartHint}`);
  if (result.failures.length > 0) process.exitCode = 1;
}


main();