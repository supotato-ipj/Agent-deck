// 插件目录看门狗（工单10）：放入/移除/改资产 → 重扫。
// 与桌面看门狗同形：事件先 settle 合并风暴，监听出错静默退场（显式 rescan 兜底）。
// 与桌面看门狗的一处不同：监听前先把根目录建出来——插件目录就是安装位，
// 「首次运行还没有这个目录」是常态，不建就永远等不到首次放入的那个事件。
import fs from 'node:fs'
import path from 'node:path'

export interface PluginWatchOptions {
  /** 事件风暴合并窗口（ms）：最后一个事件后安静多久才算稳定 */
  settleMs?: number
}

/**
 * 监听各插件根目录（含其下的插件资产递归变更），变化稳定后回调一次；返回停听函数。
 * 根目录会被建出来；建不出的（权限等）静默跳过，等下一轮显式 rescan。
 */
export function watchPluginRoots(roots: string[], onChange: () => void, options: PluginWatchOptions = {}): () => void {
  const settleMs = options.settleMs ?? 300
  let timer: NodeJS.Timeout | null = null
  let stopped = false
  const closers: Array<() => void> = []

  const arm = () => {
    if (stopped) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (!stopped) onChange()
    }, settleMs)
  }

  for (const dir of roots) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      // recursive：改插件自己的 card.js 也要能触发重载（工单10 AC 的运行时热重载）
      const watcher = fs.watch(dir, { persistent: false, recursive: true }, () => arm())
      watcher.on('error', () => { /* 静默退场 */ })
      closers.push(() => watcher.close())
    } catch {
      /* 目录建不出/不可监听：跳过，等显式 rescan 兜底 */
    }
  }

  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    for (const close of closers) close()
  }
}

/** 插件根目录下的候选子目录（按名排序，保证扫描序稳定；非目录/不可读跳过） */
export function listPluginDirs(root: string): string[] {
  let names: string[]
  try {
    names = fs.readdirSync(root)
  } catch {
    return []
  }
  const dirs: string[] = []
  for (const name of names.sort()) {
    const dir = path.join(root, name)
    try {
      if (fs.statSync(dir).isDirectory()) dirs.push(dir)
    } catch {
      /* 扫描瞬间消失的目录：跳过，下轮再说 */
    }
  }
  return dirs
}
