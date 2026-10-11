// 数据面子进程入口（utilityProcess）：会话/硬件/使用日志/桌面承载四个采集服务
// 连同采样定时器整体跑在本进程，快照经 parentPort 推回面板主进程——主进程只留
// 窗口/热区/桥接/插件宿主（鼠标卡顿修复：采集阻塞不再波及输入管线）。
// 本进程无 Electron API：lnk 目标解析与图标提取留主进程，经协议消息供给。
import type { Context } from 'cordis'
import { appendFileSync } from 'node:fs'
import type { DesktopZone } from '../shared/contract'
import { createDataplaneKernel } from './kernel'
import { planTaskbarRecommendations } from './taskbar/plan'
import { TrayHost } from './trayhost/host'
import {
  ProxyClipboardRead,
  ProxyShortcutResolver,
  ProxyTrash,
  type DataplaneMessage,
  type DataplaneSnapshot,
  type ParentPort,
} from './dataplane-protocol'

const parentPort: ParentPort | undefined = (process as unknown as { parentPort?: ParentPort }).parentPort

let ctx: Context | null = null
let trayHost: TrayHost | null = null
// 托盘宿主装配参数（#153）：init 与 tray-control 起共用一条装配路径（语料文件在 init 定档）
let trayCorpusFile: string | undefined

/** 托盘宿主起（#153 幂等）：在场即不动——不重播收编广播（每播一次图标往返一次，ADR-0012）。
 * 起成功才登记 trayHost：半途抛错（类型表/类注册等）不滞留半死实例——后续 stop 不产
 * 幻影 tray-host-stopped 存证、重试起也不被旧实例挡道（绿轮实证教训）。 */
function startTrayHost(): void {
  if (trayHost) return
  const corpusFile = trayCorpusFile // 闭包内 let 收窄失效，先落 const
  const host = new TrayHost({
    onEvent: (event) => parentPort!.postMessage({ type: 'tray-event', event }),
    corpus: corpusFile
      ? (entry) => {
        try { appendFileSync(corpusFile, JSON.stringify(entry) + '\n') } catch { /* 语料尽力而为 */ }
      }
      : undefined,
    log: (event) => parentPort!.postMessage({ type: 'tray-host', event }),
  })
  try {
    host.start()
    trayHost = host
  } catch (err) {
    parentPort!.postMessage({ type: 'tray-host', event: { type: 'tray-host-failed', message: (err as Error).message } })
  }
}

function snapshotOf(c: Context): DataplaneSnapshot {
  const d = new Date()
  const desktop = c.desktop.state()
  return {
    clock: { iso: d.toISOString(), epochMs: d.getTime() },
    sessions: c.sessions.current(),
    hardware: c.hardware.state(),
    desktop,
    // 推荐位（工单54）：fuseScores 链路产物随每拍携带，主进程 TaskbarService 据此回推
    recommendations: planTaskbarRecommendations(desktop.items, c.desktop.usageScores()),
  }
}

if (parentPort) {
  const resolver = new ProxyShortcutResolver((paths) => {
    parentPort.postMessage({ type: 'resolve-shortcuts', paths })
  })
  const trashProxy = new ProxyTrash((id, paths) => {
    parentPort.postMessage({ type: 'trash-req', id, paths })
  })
  const clipboardProxy = new ProxyClipboardRead((id) => {
    parentPort.postMessage({ type: 'clipboard-read-req', id })
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
            // 回收站删除同理（工单27）：shell.trashItem 是主进程 API——删除裁决与摆位
            // 清除都在本进程（存储归属地），那一只手经代理伸回主进程。
            trash: (filePath) => trashProxy.trash(filePath),
            // 剪贴板读同理（工单30）：粘贴落盘与可贴态查询的裁决都在本进程（落点/扫描
            // 归属地），读的那只手经代理伸回主进程。读真源为 koffi 纯 native（真机修复版，
            // 本进程亦可直跑）；沿用真机实证的 clipboard-read 代理回环（trash 同形），
            // 不为换真源扩动装配。
            readClipboardFiles: () => clipboardProxy.read(),
          },
        },
        onSnapshot: (snapshot) => parentPort.postMessage({ type: 'snapshot', data: snapshot }),
      })
      void ctx.start().then(() => {
        parentPort.postMessage({ type: 'ready', snapshot: snapshotOf(ctx!) })
      })
      // 托盘宿主（工单48 起、工单56 入栏、#153 随任务栏开关）：竞争窗口/泵/
      // TaskbarCreated 全在子进程，事件经 parentPort 回主进程；验收模式下额外落原始
      // 字节语料（测试夹具来源）。init.tray 缺席（任务栏启态禁用）不建——主进程
      // 重启用经 tray-control 起。
      if (msg.init.tray) {
        trayCorpusFile = msg.init.tray.corpusFile
        startTrayHost()
      }
      return
    }
    if (msg.type === 'tray-control') {
      // 托盘宿主启停（#153 交还链路）：停 = 拆竞争窗 + 广播 TaskbarCreated 交还真托盘；
      // 起 = 新实例收编。两侧幂等（同态重复消息不动宿主、不重播广播）。
      if (msg.on) startTrayHost()
      else {
        trayHost?.stop()
        trayHost = null
      }
      return
    }
    if (msg.type === 'tray-replay') {
      // 托盘点击回放（工单56）：宿主不在场（未起或已停）如实回执，渲染层按失败呈现
      const r = trayHost?.replay(msg.key, msg.button) ?? { ok: false, error: '托盘宿主不在场' }
      parentPort.postMessage({ type: 'tray-host', event: { type: 'tray-replay-result', key: msg.key, ...r } })
      return
    }
    if (msg.type === 'shortcuts') {
      resolver.deliver(msg.targets)
      return
    }
    if (msg.type === 'trash-res') {
      trashProxy.deliver(msg.id, msg.errors)
      return
    }
    if (msg.type === 'clipboard-read-res') {
      clipboardProxy.deliver(msg.id, msg.files)
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
          } else if (msg.method === 'desktop/reset-layout') {
            result = ctx.desktop.resetLayout()
          } else if (msg.method === 'desktop/trash') {
            const { paths } = msg.payload as { paths: string[] }
            result = await ctx.desktop.trash(paths)
          } else if (msg.method === 'desktop/rename') {
            const { name, to } = msg.payload as { name: string; to: string }
            result = await ctx.desktop.rename(name, to)
          } else if (msg.method === 'desktop/clipboard-copy') {
            const { paths } = msg.payload as { paths: string[] }
            result = await ctx.desktop.clipboardCopy(paths)
          } else if (msg.method === 'desktop/clipboard-cut') {
            const { paths } = msg.payload as { paths: string[] }
            result = await ctx.desktop.clipboardCut(paths)
          } else if (msg.method === 'desktop/paste') {
            result = await ctx.desktop.paste()
          } else if (msg.method === 'desktop/clipboard-state') {
            result = await ctx.desktop.clipboardState()
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
