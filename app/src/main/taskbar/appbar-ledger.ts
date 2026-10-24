// appbar 状态还原账落盘（工单261，spec #258「还原账全路径扩展」）：原生栏托管的
// 原 appbar 状态（收栏置位 ABS_AUTOHIDE 之前的用户原状态）持久账本，供三条既有
// 还原路径共享——尤其 guard-dead 还原守护进程（icon-restore-watch）不持面板内存账，
// 复原目标只能从本账读。
//
// 生命周期纪律（票面：「随还原守护管理，面板清场清除，不留陈旧账误导守护」）：
// - **记账**：面板置位生效（读回确认）即写（appbar-autohide 的 engage）——置位未
//   生效不记账（账不许凭空欠出，同 RAII 内存账纪律）。
// - **清账**：任一还原路径履行完复原义务即清——路径①（面板退避复原，成功或终局
//   失败）与路径②③（本模块 restoreAppBarStateFromLedger，成功或终局失败）。
//   账清了，后续会话的守卫/守护就不会拿陈旧账把用户此后手动改的任务栏偏好翻回去。
// - **中途死**：面板/守卫在退避重试中途死亡 → 账仍在盘上 → 下一层（守卫 → 守护）
//   接力复原——三层各有限次、终局有界，同 native-restore 的一张退避表。
//
// 落点：userData/appbar-ledger.json。面板与守卫（Electron）经 app.getPath('userData')；
// 还原守护（ELECTRON_RUN_AS_NODE）经本模块的专用推导（%APPDATA%\agent-deck-panel，
// 与 Electron 默认 userData 同址）——两侧同址是守护能读到账的前提（写入带 fsync：
// 账的生死线是进程强杀，不能赌 OS 缓冲）。
//
// 效果层（真 FFI 置位/读回、进程接线）离线不可测，由真机验收 50-taskbar-carry
// A2/A3/A4 覆盖（同 tray-yield/native 口径：纯逻辑进单测，效果层进验收）。
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs'
import path from 'node:path'
import type { EventLog } from '../panel-ipc'
import { getAppBarState, setAppBarState } from './appbar'
import { planAppBarStateRestore } from './native-restore'

/** 账本文件名（userData 下；面板/守卫/守护三侧共用） */
export const APPBAR_LEDGER_FILE = 'appbar-ledger.json'

/**
 * 账本目录的**专用**解析（不走 paths.userDataPath 的 LOCALAPPDATA 离线兜底）：
 * - Electron 运行时（面板/守卫）= app.getPath('userData')；
 * - 纯 Node（还原守护 ELECTRON_RUN_AS_NODE，无 process.type）= %APPDATA%\agent-deck-panel
 *   推导——Electron 默认 userData 与之同址（应用名 agent-deck-panel，本机实测在场），
 *   两侧同址是守护能读到账的前提；
 * - 离线单测注入 process.env.APPDATA 临时目录（无 Electron 时只有推导路径可走）。
 * 工单261 实证：若把 userDataPath 的离线兜底改成 APPDATA 优先，内核级单测的默认存储
 * 会读写真机面板的 userData（contract.spec 读到真 taskbar-layout.json 的电池残留）——
 * 离线隔离红线（工单06）因此由本处专用解析承担，不动全局兜底。
 */
function ledgerDir(): string {
  if ((process as { type?: string }).type !== undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires -- 同 paths.ts 的守卫式 require（纯 Node 下 require('electron') 会触发同步下载，绝不许试）
      const { app } = require('electron') as { app: { getPath(name: 'userData'): string } }
      return app.getPath('userData')
    } catch {
      /* 掉到推导路径 */
    }
  }
  return path.join(process.env.APPDATA ?? process.env.LOCALAPPDATA ?? process.cwd(), 'agent-deck-panel')
}

/** 一笔账：previous = 置位前原状态（ABS 位掩码 0..3）；pid/t 为取证面（谁的哪次置位） */
export interface AppBarLedgerEntry {
  previous: number
  pid: number
  t: number
}

/** 账本字节格式（JSON 单行）；编解码纪律见 parse */
export function encodeAppBarLedger(entry: AppBarLedgerEntry): string {
  return JSON.stringify(entry)
}

/** 认账判据：合法 JSON 对象、previous 为 0..3 整数（GETSTATE 读回域）、pid/t 数值。
 *  任何不认（腐账/缺字段/越界）返回 null——**账不许凭空欠出**：解析不出的账不能
 *  拿去 SETSTATE（腐值可能把用户任务栏翻到非法态），按缺账处理。 */
export function parseAppBarLedger(text: string): AppBarLedgerEntry | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const e = raw as Record<string, unknown>
  const { previous, pid, t } = e
  if (typeof previous !== 'number' || !Number.isInteger(previous) || previous < 0 || previous > 3) return null
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 0) return null
  if (typeof t !== 'number' || !Number.isFinite(t)) return null
  return { previous, pid, t }
}

/** 账本路径（userData/appbar-ledger.json；三侧同址，解析见 ledgerDir） */
export function appbarLedgerPath(): string {
  return path.join(ledgerDir(), APPBAR_LEDGER_FILE)
}

/** 记账（置位生效后）：fsync 写——账的生死线是进程强杀，不赌 OS 缓冲 */
export function writeAppBarLedger(previous: number, log: EventLog | null): void {
  const file = appbarLedgerPath()
  const entry: AppBarLedgerEntry = { previous, pid: process.pid, t: Date.now() }
  mkdirSync(path.dirname(file), { recursive: true })
  const fd = openSync(file, 'w')
  try {
    writeSync(fd, encodeAppBarLedger(entry), 0, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  log?.append({ type: 'taskbar-autohide-ledger-written', previous, file })
}

/** 清账（复原义务履行完毕）：文件消失；缺账不抛（幂等，多路径共用） */
export function clearAppBarLedger(): void {
  rmSync(appbarLedgerPath(), { force: true })
}

/** 读账：缺账/腐账都算无账（null）；腐账顺手清掉（认不了的账不留在盘上误导后续会话） */
export function readAppBarLedger(log: EventLog | null): AppBarLedgerEntry | null {
  const file = appbarLedgerPath()
  if (!existsSync(file)) return null
  let entry: AppBarLedgerEntry | null
  try {
    entry = parseAppBarLedger(readFileSync(file, 'utf8'))
  } catch {
    entry = null
  }
  if (entry === null) {
    rmSync(file, { force: true })
    log?.append({ type: 'taskbar-autohide-ledger-corrupt', file })
  }
  return entry
}

/* ================================================================
 * 复原编排（工单261，还原路径②③共用：外层守卫 before-quit/panel-exit、
 * guard-dead 还原守护）：从落盘账读复原目标 → SETSTATE → 读回事实裁决。
 * ================================================================ */

/** 编排依赖（离线单测注入；缺省走真 FFI 与真账本） */
export interface AppBarLedgerRestoreDeps {
  read: () => AppBarLedgerEntry | null
  clear: () => void
  setState: (state: number) => void
  getState: () => number
  sleep: (ms: number) => Promise<void>
}

const defaultDeps: AppBarLedgerRestoreDeps = {
  read: () => readAppBarLedger(null),
  clear: () => clearAppBarLedger(),
  setState: (state) => setAppBarState(state),
  getState: () => getAppBarState(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

/**
 * 从落盘账复原 appbar 状态（守卫/守护进程专用——它们不持面板内存账，落盘账是唯一
 * 复原目标来源）。裁决纪律与路径①（appbar-autohide 的退避复原）同源：
 * - 缺账 → absent，静默（守卫每次退出一调，不为常态路径造噪声——同
 *   restoreNativeTaskbarIfHidden 的空转纪律）；
 * - 读回一致 → restored：**清账**（义务履行完毕）+ taskbar-autohide-restored 存证；
 * - 读回不一致 → 按 native-restore 同一张退避表重试（每拍重新 SETSTATE；有限次、
 *   终局有界）；
 * - 终局仍不一致 → failed：**清账**（尽力语义与图标/可见性兜底一致——账不许留在盘上
 *   误导后续会话的守护去翻用户此后手动改的偏好）+ taskbar-autohide-restore-failed。
 * 存证事件类型与路径①同族（taskbar-autohide-restored / -restore-failed），reason
 * 透传调用方（panel-exit / outer-quit / guard-dead / force）——验收电池按 reason 分径。
 */
export async function restoreAppBarStateFromLedger(
  log: EventLog | null,
  reason: string,
  deps: AppBarLedgerRestoreDeps = defaultDeps,
): Promise<'absent' | 'restored' | 'failed'> {
  const entry = deps.read()
  if (entry === null) return 'absent'
  const previous = entry.previous
  let attempt = 1
  for (;;) {
    deps.setState(previous)
    const state = deps.getState()
    if (state === previous) {
      deps.clear()
      log?.append({ type: 'taskbar-autohide-restored', reason, state, attempts: attempt })
      return 'restored'
    }
    const d = planAppBarStateRestore(attempt, 'mismatch')
    if (d.action === 'done') {
      deps.clear()
      log?.append({ type: 'taskbar-autohide-restore-failed', reason, state, attempts: d.attempt })
      return 'failed'
    }
    await deps.sleep(d.delayMs)
    attempt = d.attempt
  }
}
