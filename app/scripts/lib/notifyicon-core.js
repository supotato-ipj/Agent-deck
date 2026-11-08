'use strict';
/**
 * NotifyIconSettings 僵尸清理纯核（工单433）——CommonJS、零依赖、纯函数。
 *
 * 事实源：HKCU\Control Panel\NotifyIconSettings（Win11 22H2+ 的 Shell_NotifyIcon
 * 注册账本）。读法沿用 userassist 先例：reg.exe export 导出 .reg 文本（UTF-16LE，
 * 由壳解码）再纯解析——reg query 的 ANSI 控制台输出会把中文路径 mojibake 成
 * 「不存在的路径」，误判活条目为死路径（2026-11-08 现机实测）。
 *
 * 删除口径（2026-11-08 用户拍板，票面窄口径＋探针白名单）：
 * - dead-path：ExecutablePath 解析后指向不存在的文件；
 * - probe-zombie：InitialTooltip 精确等于 DECK164-PROBE-V0/V4（#325 取证红轮
 *   探针被 OS 路由进 explorer 真托盘的残留，exe 路径可能仍在，白名单兜底）；
 * - 其余一律 keep：活路径、无路径、GUID 不可解析——不可判死的一律不动。
 *
 * 纪律：本核绝不 import fs/child_process——reg 导出/删除与文件存在性探测都在
 * CLI 壳 scripts/cleanup-notifyicons.js，壳把事实喂给本核判定。
 */

const REG_KEY_PREFIX = '[HKEY_CURRENT_USER\\Control Panel\\NotifyIconSettings\\';

/** KnownFolder GUID 前缀 → 环境变量目录（小写键；只登记现机实测出现过的四种） */
const KNOWN_FOLDER_DIRS = new Map([
  ['{1ac14e77-02e7-4e5d-b744-2eb1ae5198b7}', (env) => (env.SystemRoot ? env.SystemRoot + '\\System32' : null)],
  ['{6d809377-6af0-444b-8957-a3773f02200e}', (env) => env.ProgramFiles || null],
  ['{7c5a40ef-a0fb-4bfc-874a-c0f2e0b9fa8e}', (env) => env['ProgramFiles(x86)'] || null],
  ['{f38bf404-1d43-42f2-9305-67de0b28fc23}', (env) => env.SystemRoot || null],
]);

/**
 * ExecutablePath 解析：KnownFolder GUID 前缀展开为真实目录；绝对路径原样；
 * 未知 GUID / 相对路径 → null（不可判定，调用方必须保留条目）。
 * @param {string|null} raw
 * @param {Record<string, string|undefined>} env
 * @returns {string|null}
 */
function resolveExecutablePath(raw, env) {
  if (!raw) return null;
  const gm = /^\{[0-9a-fA-F-]+\}/.exec(raw);
  if (gm) {
    const dirOf = KNOWN_FOLDER_DIRS.get(gm[0].toLowerCase());
    if (!dirOf) return null;
    const dir = dirOf(env);
    if (!dir) return null;
    return dir.replace(/[\\/]+$/, '') + raw.slice(gm[0].length);
  }
  if (/^[A-Za-z]:[\\/]/.test(raw) || /^\\\\/.test(raw)) return raw;
  return null;
}

/** .reg 字符串值去转义（"a\\"b" → a"b，"a\\\\b" → a\\b）；与 userassist.ts 的
 * unescapeRegName 同构——两处分属 CJS 脚本核与 TS 主进程，暂不拉共享模块 */
function unescapeRegString(quoted) {
  let out = '';
  for (let i = 0; i < quoted.length; i++) {
    const c = quoted[i];
    if (c !== '\\' || i + 1 >= quoted.length) { out += c; continue; }
    const next = quoted[i + 1];
    if (next === '\\' || next === '"') { out += next; i++; } else { out += c; }
  }
  return out;
}

/**
 * 纯解析 .reg 导出文本：只收 NotifyIconSettings 数字子键下的
 * ExecutablePath / InitialTooltip 两个 REG_SZ 值；根键值与非目标分支不收。
 * 文本为 UTF-16LE（reg export v5 格式）时由调用方先解码，这里收 string。
 * @param {string} text
 * @returns {Array<{key: string, executablePath: string|null, initialTooltip: string|null}>}
 */
function parseNotifyIconRegExport(text) {
  const entries = [];
  let cur = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (line.startsWith(REG_KEY_PREFIX) && line.endsWith(']')) {
      const key = line.slice(REG_KEY_PREFIX.length, -1);
      cur = /^\d+$/.test(key) ? { key, executablePath: null, initialTooltip: null } : null;
      if (cur) entries.push(cur);
      continue;
    }
    if (line.startsWith('[')) { cur = null; continue; }
    if (!cur || !line.startsWith('"')) continue;
    // 长 hex 值被 reg 导出折行（行尾反斜杠续行），先并回一行
    while (line.endsWith('\\') && i + 1 < lines.length) {
      line = line.slice(0, -1) + lines[++i].trim();
    }
    const pm = /^"ExecutablePath"="(.*)"$/.exec(line);
    if (pm) { cur.executablePath = unescapeRegString(pm[1]); continue; }
    const tm = /^"InitialTooltip"="(.*)"$/.exec(line);
    if (tm) cur.initialTooltip = unescapeRegString(tm[1]);
  }
  return entries;
}

/** #325 取证红轮留下的我方探针僵尸（InitialTooltip 精确匹配；每红轮净增 2 条） */
const PROBE_ZOMBIE_TOOLTIPS = new Set(['DECK164-PROBE-V0', 'DECK164-PROBE-V4']);

const VERDICT = Object.freeze({
  PROBE_ZOMBIE: 'probe-zombie',
  DEAD_PATH: 'dead-path',
  KEEP: 'keep',
});

/**
 * 判定单条目：probe-zombie（白名单，即使 exe 路径仍在）> dead-path（路径可解析且
 * 文件不存在）> keep（活路径、不可解析、无路径一律不动）。
 * @param {{executablePath: string|null, initialTooltip: string|null}} entry
 * @param {string|null} resolvedPath
 * @param {boolean} fileExists
 * @returns {'probe-zombie'|'dead-path'|'keep'}
 */
function judgeNotifyIconEntry(entry, resolvedPath, fileExists) {
  if (PROBE_ZOMBIE_TOOLTIPS.has(entry.initialTooltip)) return VERDICT.PROBE_ZOMBIE;
  if (resolvedPath && !fileExists) return VERDICT.DEAD_PATH;
  return VERDICT.KEEP;
}

module.exports = {
  parseNotifyIconRegExport,
  resolveExecutablePath,
  judgeNotifyIconEntry,
  VERDICT,
};
