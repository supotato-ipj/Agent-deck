// DSH 后端启动描述符（工单332，ADR-0018「适配面 = 每后端一份启动描述符」）：
// 可执行文件与参数来自描述符解析，不经 shell、不经 .cmd（探针 #330 实录配方）。
// 解析顺序：用户显式配置（后端档）→ 环境变量 DSH_EXE → 标准安装位探测（C..Z 逐盘，
// 不硬编码盘符）。布局校验要求桌面宿主形态（exe + 内置 cli.js 资源齐备），
// 缺一即解析失败——「不把失败伪装成可用」（ADR-0018 可用性口径）。
//
// cli.js 资源相对布局（探针实录）：
//   <installDir>\DeepSeek Harness.exe
//   <installDir>\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js
// spawn 形态：exe 直拉 + ['--expose-internals', cliJs, '--profile', 'acp']，
// env 需 ELECTRON_RUN_AS_NODE=1 + DSH_HOME（面板专属稳定目录，ADR-0026）。

import fs from 'node:fs'
import path from 'node:path'

export interface DshInstall {
  exe: string
  cliJs: string
  /** 解析来源（存证用）：config / env / probe:<root> */
  source: string
}

/** 探测依赖缝（离线测试注入假 fs/环境；缺省真源） */
export interface DshProbeDeps {
  exists(p: string): boolean
  env: Record<string, string | undefined>
}

export const DSH_EXE_NAME = 'DeepSeek Harness.exe'

/** 桌面宿主内置 CLI 的相对布局（探针 #330 实录） */
export function dshCliJsFor(installDir: string): string {
  return path.join(installDir, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
}

/** 候选安装根（有序）：用户级安装位优先，其后 C..Z 逐盘的 Program 两式（跳过软盘 A/B） */
export function candidateInstallRoots(deps: DshProbeDeps): string[] {
  const roots: string[] = []
  const localAppData = deps.env.LOCALAPPDATA
  if (localAppData) roots.push(path.join(localAppData, 'Programs', 'Dsh'))
  for (let i = 67; i <= 90; i++) {
    const drive = `${String.fromCharCode(i)}:\\`
    if (!deps.exists(drive)) continue
    roots.push(path.join(drive, 'Program', 'Dsh'))
    roots.push(path.join(drive, 'Program Files', 'Dsh'))
  }
  return roots
}

function installAt(root: string, source: string, deps: DshProbeDeps): DshInstall | null {
  const exe = path.join(root, DSH_EXE_NAME)
  const cliJs = dshCliJsFor(root)
  if (deps.exists(exe) && deps.exists(cliJs)) return { exe, cliJs, source }
  return null
}

/** 解析 DSH 安装：config 显式 → env DSH_EXE → 探测；全落空 = null（未安装） */
export function resolveDshInstall(config: { exe?: string } | undefined, deps: DshProbeDeps = defaultProbeDeps()): DshInstall | null {
  const explicit = config?.exe?.trim() || deps.env.DSH_EXE?.trim()
  if (explicit) {
    const root = path.dirname(explicit)
    const via = config?.exe?.trim() ? 'config' : 'env'
    return installAt(root, via, deps)
  }
  for (const root of candidateInstallRoots(deps)) {
    const hit = installAt(root, `probe:${root}`, deps)
    if (hit) return hit
  }
  return null
}

export interface DshLaunchPlan {
  file: string
  args: string[]
  env: Record<string, string>
}

/** 启动计划（探针配方）：exe 直 spawn、ELECTRON_RUN_AS_NODE + DSH_HOME、acp profile */
export function buildLaunchPlan(install: DshInstall, dshHome: string): DshLaunchPlan {
  return {
    file: install.exe,
    args: ['--expose-internals', install.cliJs, '--profile', 'acp'],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      DSH_HOME: dshHome,
    },
  }
}

/** 缺省探测真源：真实 fs + 进程环境（惰性，不拉 Electron） */
export function defaultProbeDeps(): DshProbeDeps {
  return {
    exists: (p) => {
      try {
        return fs.existsSync(p)
      } catch {
        return false
      }
    },
    env: process.env,
  }
}
