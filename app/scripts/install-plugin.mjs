// 插件包装载步骤（工单179 = spec166 之②）：把仓库内的投放型插件包拷进用户插件根。
//
// 为什么要这道步骤（ADR-0014）：投放型 = 「目录在不在」决定有没有这张卡。源码因此留在仓库里
// （有版本控制、纯逻辑可单测、可回滚），运行态却是一个可以整个删掉的目录——本脚本就是那道
// 「仓库 → 用户插件根」的搬运，搬完即投放；`--uninstall` 或手删目录都是完全撤回。
//
// 目标根的三级优先（并行开发必须能指向私有根，见下）：
//   1. `--root <dir>` 命令行参数
//   2. `DECK_PLUGIN_ROOT` 环境变量
//   3. 用户插件根默认值 = Electron 的 userData/plugins（config.plugins.dir 为空时内核走的那条，
//      见 src/main/index.ts 与 src/main/paths.ts）
//
// ⚠ 并行开发须知：本机各检出共享同一份 userData（userData 按 app 名派生，与检出无关），
// 开机自启面板会把共享根里的插件热插拔到真实桌面。开发中的半成品请装到私有根：
//   node scripts/install-plugin.mjs doc-group-cards --root D:\tmp\deck-plugins-t179
// 再在 app/config.json 里写 "plugins": { "dir": "D:\\tmp\\deck-plugins-t179" }（该文件已 gitignore，
// 改了不进 diff）。真要上真实桌面时，才用默认根。
//
// 用法：
//   node scripts/install-plugin.mjs [id...] [--root <dir>] [--uninstall]

import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const packagesRoot = path.join(appRoot, 'plugins')

/** 用户插件根默认值：Electron 的 userData/plugins（无 Electron 运行时时按平台惯例推） */
function defaultPluginRoot() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(process.env.HOME ?? '', 'AppData', 'Roaming'), 'agent-deck-panel', 'plugins')
  }
  if (process.platform === 'darwin') {
    return path.join(process.env.HOME ?? '', 'Library', 'Application Support', 'agent-deck-panel', 'plugins')
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME ?? '', '.config'), 'agent-deck-panel', 'plugins')
}

const argv = process.argv.slice(2)
const rootFlag = argv.indexOf('--root')
const uninstall = argv.includes('--uninstall')
if (rootFlag >= 0 && !argv[rootFlag + 1]) {
  console.error('[install-plugin] --root 后面要跟目录')
  process.exit(1)
}
const root = rootFlag >= 0 ? argv[rootFlag + 1] : (process.env.DECK_PLUGIN_ROOT || defaultPluginRoot())
const ids = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--root')

if (ids.length === 0) {
  console.error('[install-plugin] 用法：node scripts/install-plugin.mjs [id...] [--root <dir>] [--uninstall]')
  console.error(`[install-plugin] 可用包：${existsSync(packagesRoot) ? readdirSync(packagesRoot).join(' ') : '(app/plugins 不存在)'}`)
  process.exit(1)
}

for (const id of ids) {
  const src = path.join(packagesRoot, id)
  const dest = path.join(root, id)
  if (!existsSync(src)) {
    console.error(`[install-plugin] 仓库内没有这个包：${src}`)
    process.exit(1)
  }
  if (uninstall) {
    rmSync(dest, { recursive: true, force: true })
    console.log(`[install-plugin] 已撤回 ${dest}（目录不存在即完全撤回）`)
    continue
  }
  cpSync(src, dest, { recursive: true })
  console.log(`[install-plugin] ${src}\n              → ${dest}`)
}

if (!uninstall) {
  console.log(`[install-plugin] 面板在跑：插件根被 fs.watch 递归盯着，装完约 300ms 内热插拔生效，无需重启。`)
  console.log(`[install-plugin] 目标根不是默认用户根时，记得在 app/config.json 里对齐 plugins.dir：`)
  console.log(`[install-plugin]   "plugins": { "dir": ${JSON.stringify(root)} }`)
}
