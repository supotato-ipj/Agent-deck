// 数据面子进程入口（utilityProcess）：会话/硬件/使用日志/桌面承载四个采集服务
// 连同采样定时器整体跑在本进程，快照经 parentPort 推回面板主进程——主进程只留
// 窗口/热区/桥接/插件宿主（鼠标卡顿修复：采集阻塞不再波及输入管线）。
// 本进程无 Electron API：lnk 目标解析与图标提取留主进程，经协议消息供给。
import type { Context } from 'cordis'
import { appendFileSync } from 'node:fs'
import type { DesktopZone } from '../shared/contract'
import { createDataplaneKernel } from './kernel'
import { TrayHost } from './trayhost/host'
import {
  ProxyShortcutResolver,
  type DataplaneMessage,
  type DataplaneSnapshot,
  type ParentPort,
} from './dataplane-protocol'

const parentPort: ParentPort | undefined = (process as unknown as { parentPort?: ParentPort }).parentPort

let ctx: Context | null = null
let trayHost: TrayHost | null = null

function snapshotOf(c: Context): DataplaneSnapshot {
  const d = new Date()
  return {
    clock: { iso: d.toISOString(), epochMs: d.getTime() },
    sessions: c.sessions.current(),
    hardware: c.hardware.state(),
    desktop: c.desktop.state(),
  }
}

if (parentPort) {
  const resolver = new ProxyShortcutResolver((paths) => {
    parentPort.postMessage({ type: 'resolve-shortcuts', paths })
  })

  parentPort.on('message', (e) => {
    const msg: DataplaneMessage = e.data
    if (msg.type === 'init') {
      if (ctx) return // 只初始化一次（主进程重启兜底重发 init 也不重复装配）
      ctx = createDataplaneKernel({
        usage: { dir: msg.init.usageDir },
        desktop: {
          roots: msg.init.roots,
          storeFile: msg.init.storeFile,
          docMaxRows: msg.init.docMaxRows,
          deps: {
            // 图标提取与启动是 Electron 主进程 API（app.getFileIcon / shell.openPath）：
            // 数据面不装这两面，主进程按快照条目预热图标、校验条目池后自行启动。
            extractIcon: null,
            open: async () => {
              throw new Error('desktop/launch 由面板主进程执行')
            },
            readShortcutTarget: (lnk) => resolver.resolve(lnk),
          },
        },
        onSnapshot: (snapshot) => parentPort.postMessage({ type: 'snapshot', data: snapshot }),
      })
      void ctx.start().then(() => {
        parentPort.postMessage({ type: 'ready', snapshot: snapshotOf(ctx!) })
      })
      // 托盘宿主（工单48 spike）：init.traySpike 在场才起。竞争窗口/泵/TaskbarCreated
      // 全在子进程；事件经 parentPort 回主进程，原始字节语料落 JSONL（测试夹具来源）。
      if (msg.init.traySpike && !trayHost) {
        try {
          const corpusFile = msg.init.traySpike.corpusFile
          trayHost = new TrayHost({
            onEvent: (event) => parentPort.postMessage({ type: 'tray-event', event }),
            corpus: (entry) => {
              try { appendFileSync(corpusFile, JSON.stringify(entry) + '\n') } catch { /* 语料尽力而为 */ }
            },
            log: (event) => parentPort.postMessage({ type: 'tray-host', event }),
          })
          trayHost.start()
        } catch (err) {
          parentPort.postMessage({ type: 'tray-host', event: { type: 'tray-host-failed', message: (err as Error).message } })
        }
      }
      return
    }
    if (msg.type === 'shortcuts') {
      resolver.deliver(msg.targets)
      return
    }
    if (msg.type === 'req') {
      void (async () => {
        try {
          if (ctx === null) throw new Error('数据面尚未初始化')
          let result: unknown
          if (msg.method === 'desktop/move') {
            const { name, zone, beforeName } = msg.payload as { name: string; zone: DesktopZone; beforeName: string | null }
            result = ctx.desktop.move(name, zone, beforeName)
          } else if (msg.method === 'desktop/move-batch') {
            const { names, zone, beforeName } = msg.payload as { names: string[]; zone: DesktopZone; beforeName: string | null }
            result = ctx.desktop.moveBatch(names, zone, beforeName)
          } else if (msg.method === 'desktop/pin') {
            const { name } = msg.payload as { name: string }
            result = ctx.desktop.pin(name)
          } else if (msg.method === 'desktop/unpin') {
            const { name } = msg.payload as { name: string }
            result = ctx.desktop.unpin(name)
          } else if (msg.method === 'desktop/reset-layout') {
            result = ctx.desktop.resetLayout()
          } else {
            throw new Error(`未知数据面方法: ${String(msg.method)}`)
          }
          parentPort.postMessage({ type: 'res', id: msg.id, ok: true, result })
        } catch (err) {
          parentPort.postMessage({
            type: 'res',
            id: msg.id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      })()
    }
  })
}
