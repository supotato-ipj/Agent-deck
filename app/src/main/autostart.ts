// 开机自启（工单11）：面板自启项挂在当前用户的 Startup 文件夹，随面板进程代换。
//
// 为什么是 Startup 快捷方式而不是注册表 Run 键：这是旧栈沿用至今的做法
// （scripts/create_startup_shortcut.ps1 的 qoder-deck-server-watchdog.lnk），
// 用户在「任务管理器 → 启动」与「启动文件夹」两处都认得；平移只换指向，不换机制。
//
// 三条语义钉死在这里，改动前先读：
//   ① **只有声明过的生产安装位置才有权新建/接管自启项**（config.autostart.appDir）。
//      规则①（不追改活链）只保护「已存在且存活」的链接——若生产链接尚未建立，
//      一个从开发 worktree 拉起的面板会把机器的开机自启指向 worktree，而 worktree
//      收尾即删，自启项随之指向空气。故「新建」与「死链自愈」都额外要求本次运行
//      就是声明的生产位置；未声明（appDir 空）则一律 skip，只清旧链。
//   ② 自启项是机器级部署记录，不是每次运行的安装记录：因此没有「随运行位置漂移」。
//   ③ 旧链自启项（Python 看门狗）在每次应用时无条件清除——工单11 的退役不靠用户记得手删。
//
// 助手脚本 autostart.ps1 与本文件同目录（copy-assets.mjs 复制到 dist/main）。
// 该脚本必须保持纯 ASCII：Windows PowerShell 5.1 以系统 ANSI 码页读取无 BOM 脚本，
// UTF-8 注释会变成乱码并直接让解析失败（capture.ps1 / uia-focus.ps1 同此约定）。
// 决策理由留在本文件，不写进 ps1。
//
// 工单481 去同步化（#478 诊断实锤④）：helper 调用从 spawnSync 改异步 spawn——
// 每次启动同步跑 PowerShell 的形态（热态 1.19s、上界 20s、开机窗口冷态放大数秒）
// 退役；启动链经 boot-sequence 计划把本模块的调用整体后补（发起不等待），helper
// 自带显式上界（AUTOSTART_HELPER_BOUND_MS，与旧 spawnSync timeout 同值），超时
// 终止进程降级放行。滞后哨兵 span 只包 spawn 发起段（同步段近零——冷态 sidecar
// 的 'autostart' span 读数即去同步化的 W2 正面证据）。
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { AUTOSTART_HELPER_BOUND_MS, boundWait } from './boot-sequence'
import { panelLabels } from './lag-sentinel'

/** 本应用自启项文件名（Startup 文件夹内） */
export const AUTOSTART_LINK_NAME = 'AGENT DECK.lnk'

/** 旧栈遗留的自启项：Python 看门狗链。工单11 退役即删——认名字，不认目标路径。 */
export const LEGACY_STARTUP_LINK_NAMES: readonly string[] = ['qoder-deck-server-watchdog.lnk']

export interface ShortcutSpec {
  target: string
  args: string
  workDir?: string
}

/** 参数去首尾引号后比对：Windows 快捷方式里引号可有可无，不该因此判定为「不是同一个」 */
function normalizeArgs(args: string): string {
  const trimmed = args.trim()
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed
}

function normalizeTarget(target: string): string {
  return target.trim().replace(/\//g, '\\').toLowerCase()
}

/** 路径口径的归一：补尾分隔符差异，故声明值与运行值只差一个 `\` 也算同一处 */
function normalizePath(p: string): string {
  const n = normalizeTarget(p)
  return n.length > 3 && n.endsWith('\\') ? n.slice(0, -1) : n
}

/** 两个快捷方式是否指同一处（existing 为 null 即「不存在」，永不相同） */
export function sameShortcut(existing: ShortcutSpec | null, desired: ShortcutSpec): boolean {
  if (!existing) return false
  return (
    normalizeTarget(existing.target) === normalizeTarget(desired.target) &&
    normalizeArgs(existing.args) === normalizeArgs(desired.args)
  )
}

export function startupDirFrom(appData: string): string {
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
}

/** 当前用户的 Startup 文件夹。APPDATA 缺失即配置异常，显式报错而非猜路径 */
export function startupDir(env: NodeJS.ProcessEnv = process.env): string {
  const appData = env.APPDATA
  if (!appData) throw new Error('APPDATA 未设置，无法定位 Startup 文件夹')
  return startupDirFrom(appData)
}

export function autostartLinkPath(startup: string, name: string = AUTOSTART_LINK_NAME): string {
  return path.join(startup, name)
}

export function legacyLinkPaths(startup: string): string[] {
  return LEGACY_STARTUP_LINK_NAMES.map((name) => path.join(startup, name))
}

/**
 * 自启项指向当前这次运行：Electron 可执行 + 应用目录（带引号——路径含空格是常态）。
 * 由运行位置派生而非写死路径，换机只改启动方式不改代码。
 */
export function desiredShortcut(execPath: string, appPath: string): ShortcutSpec {
  return { target: execPath, args: `"${appPath}"`, workDir: appPath }
}

export type AutostartAction = 'create' | 'keep' | 'remove' | 'disabled' | 'skip'

export interface AutostartPlan {
  action: AutostartAction
  reason: string
}

/** 本次运行是否就是声明过的生产安装位置——只有它才有权新建/接管自启项（规则①） */
export function isProductionRun(input: { appDir: string; runningAppDir: string }): boolean {
  const declared = input.appDir.trim()
  if (!declared) return false
  return normalizePath(declared) === normalizePath(input.runningAppDir)
}

export function decideAutostart(input: {
  enabled: boolean
  /** 本次运行是否即声明的生产安装位置 */
  mayClaim: boolean
  existing: ShortcutSpec | null
  desired: ShortcutSpec
  /** 目标是否可达（死链判定）。注入以便离线测试不碰磁盘 */
  targetAlive: (target: string) => boolean
}): AutostartPlan {
  if (!input.enabled) {
    return input.existing ? { action: 'remove', reason: 'disabled' } : { action: 'disabled', reason: 'disabled' }
  }
  if (input.existing) {
    if (sameShortcut(input.existing, input.desired)) return { action: 'keep', reason: 'existing-matches' }
    // 活链不追改；死链只有生产位置才有资格接管——否则等于把机器指向开发路径
    if (input.targetAlive(input.existing.target)) return { action: 'keep', reason: 'live-other-location' }
    return input.mayClaim ? { action: 'create', reason: 'dead-target' } : { action: 'skip', reason: 'not-production-run' }
  }
  return input.mayClaim ? { action: 'create', reason: 'missing' } : { action: 'skip', reason: 'not-production-run' }
}

const HELPER = path.join(__dirname, 'autostart.ps1')

interface HelperResult {
  ok: boolean
  json: Record<string, unknown> | null
  error: string
}

interface HelperClose {
  code: number | null
  stdout: string
  stderr: string
  spawnError: string
}

/**
 * 异步跑一次 helper（工单481）：spawn 发起段挂滞后哨兵 `autostart` 标签（同步段），
 * 全程以 boundWait 竞速显式上界——超时终止进程、按超时错误降级返回，不悬挂调用方。
 */
async function runHelper(mode: 'read' | 'write', link: string, spec?: ShortcutSpec, boundMs: number = AUTOSTART_HELPER_BOUND_MS): Promise<HelperResult> {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER, '-Mode', mode, '-Link', link]
  if (spec) {
    args.push('-Target', spec.target, '-LinkArgs', spec.args)
    if (spec.workDir) args.push('-WorkDir', spec.workDir)
  }
  const child = panelLabels.run('autostart', () =>
    spawn('powershell.exe', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }),
  )
  const closed = new Promise<HelperClose>((resolve) => {
    let stdout = ''
    let stderr = ''
    let spawnError = ''
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
    child.on('error', (err) => { spawnError = err.message })
    child.on('close', (code) => resolve({ code, stdout, stderr, spawnError }))
  })
  const outcome = await boundWait(closed, boundMs)
  if (outcome.kind === 'timeout') {
    child.kill()
    return { ok: false, json: null, error: `helper 超时（${boundMs}ms 上界，已终止进程）` }
  }
  const r = outcome.value
  if (r.spawnError) return { ok: false, json: null, error: r.spawnError }
  if (r.code !== 0) return { ok: false, json: null, error: `status=${r.code} stderr=${r.stderr.trim()}` }
  try {
    const line = r.stdout.trim().split('\n').filter(Boolean).pop() ?? ''
    return { ok: true, json: line ? (JSON.parse(line) as Record<string, unknown>) : null, error: '' }
  } catch (err) {
    return { ok: false, json: null, error: `helper 输出非 JSON：${(err as Error).message} stdout=${r.stdout}` }
  }
}

/** 读一个 .lnk 的目标与参数；不存在读作 null（COM 不可用等真故障则抛，不静默当作不存在） */
export async function readShortcut(link: string, boundMs?: number): Promise<ShortcutSpec | null> {
  const r = await runHelper('read', link, undefined, boundMs)
  if (!r.ok) throw new Error(`读快捷方式失败 ${link}: ${r.error}`)
  if (!r.json || r.json.exists !== true) return null
  return {
    target: String(r.json.target ?? ''),
    args: String(r.json.args ?? ''),
    workDir: r.json.workDir ? String(r.json.workDir) : undefined,
  }
}

export async function writeShortcut(link: string, spec: ShortcutSpec, boundMs?: number): Promise<void> {
  fs.mkdirSync(path.dirname(link), { recursive: true })
  const r = await runHelper('write', link, spec, boundMs)
  if (!r.ok) throw new Error(`写快捷方式失败 ${link}: ${r.error}`)
}

export function removeShortcut(link: string): void {
  try {
    fs.rmSync(link, { force: true })
  } catch {
    /* 尽力而为 */
  }
}

export interface AutostartOutcome {
  link: string
  action: AutostartAction
  reason: string
  /** 决策是否真的落到磁盘上（写失败/跳过时为 false）——别拿 action 当既成事实 */
  applied: boolean
  legacyRemoved: string[]
}

/**
 * 应用自启策略并顺手退役旧链（工单481 起为异步：启动链「发起不等待」，本函数
 * 全程不阻塞主线程——helper 上界内超时终止进程降级放行）。幂等：每次启动都跑，
 * 只在需要时动文件。失败一律降级为「照常开面板」——自启项写不进去不该挡住桌面。
 */
export async function applyAutostart(options: {
  enabled: boolean
  /** config.autostart.appDir：声明过的生产安装位置；空串 = 本次运行无权新建/接管 */
  appDir: string
  /** 本次运行的应用目录 */
  runningAppDir: string
  startup?: string
  linkPath?: string
  desired: ShortcutSpec
  /** helper 单次调用上界（缺省 AUTOSTART_HELPER_BOUND_MS；测试注入小上界验降级） */
  helperBoundMs?: number
  log?: (event: Record<string, unknown>) => void
}): Promise<AutostartOutcome> {
  const startup = options.startup ?? startupDir()
  const link = options.linkPath ?? autostartLinkPath(startup)
  const log = options.log ?? (() => {})

  // 旧链先清：与新自启项决策无关，纯退役动作，且必须无条件执行（开发运行也清）
  const legacyRemoved: string[] = []
  for (const legacy of legacyLinkPaths(startup)) {
    if (!fs.existsSync(legacy)) continue
    removeShortcut(legacy)
    legacyRemoved.push(path.basename(legacy))
  }
  if (legacyRemoved.length > 0) log({ type: 'autostart-legacy-removed', names: legacyRemoved })

  let existing: ShortcutSpec | null = null
  try {
    existing = await readShortcut(link, options.helperBoundMs)
  } catch (err) {
    log({ type: 'autostart-read-failed', link, message: (err as Error).message })
  }

  const plan = decideAutostart({
    enabled: options.enabled,
    mayClaim: isProductionRun({ appDir: options.appDir, runningAppDir: options.runningAppDir }),
    existing,
    desired: options.desired,
    targetAlive: (target) => fs.existsSync(target),
  })

  let applied = plan.action === 'keep' || plan.action === 'disabled' || plan.action === 'skip'
  try {
    if (plan.action === 'create') {
      await writeShortcut(link, options.desired, options.helperBoundMs)
      applied = true
    } else if (plan.action === 'remove') {
      removeShortcut(link)
      applied = true
    }
  } catch (err) {
    applied = false
    log({ type: 'autostart-write-failed', link, action: plan.action, message: (err as Error).message })
  }

  log({ type: 'autostart-applied', link, action: plan.action, reason: plan.reason, applied })
  return { link, action: plan.action, reason: plan.reason, applied, legacyRemoved }
}
