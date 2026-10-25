// 桌面目录看门狗（工单06，zones_watcher.py 的 fs.watch 化）：新增/删除触发即编排刷新。
// 事件先 settle（等目录安静 settleMs）合并拷入风暴；监听错误静默退场——1Hz 重扫描
// 是兜底网（工单05 已交付），看门狗只是把「新建自动入池、删除同步消失」提到亚秒级。
// 触发只看事件发生，不区分增删改：条目池集合运算（fingerprint diff）自会分辨。
import fs from 'node:fs'
import type { DesktopRoots } from './scan'

export interface WatchOptions {
  /** 事件风暴合并窗口（ms）：最后一个事件后安静多久才算稳定 */
  settleMs?: number
}

/**
 * 监听两个桌面根目录，变化稳定后回调一次；返回停听函数。
 * 目录不存在（桌面被重定向到未挂载盘等）不抛错——直接不监听，等 tick 兜底。
 */
export function watchDesktopRoots(roots: DesktopRoots, onChange: () => void, options: WatchOptions = {}): () => void {
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

  for (const dir of [roots.user, roots.common]) {
    try {
      const watcher = fs.watch(dir, { persistent: false }, () => arm())
      watcher.on('error', () => {
        /* 静默退场：1Hz 重扫描兜底 */
      })
      closers.push(() => watcher.close())
    } catch {
      /* 目录不可监听：跳过，另一根或 tick 兜底 */
    }
  }

  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    for (const close of closers) close()
  }
}
