// 顶部窗口胶囊（工单376，spec #369 决策 14 + GLOSSARY「顶部窗口胶囊」）：Agent 桌面
// 正上方始终置顶的主屏合格窗口计数入口。复用任务栏条带窗的既有承载形态（决策 25：
// Electron 置顶窗 + NOACTIVATE + 默认鼠标穿透——不引入第二套 UI 框架/常驻面板实例），
// 计数数据源 = AgentTilingService 的 tiling/changed 回推（含平铺、最小化与各类未平铺，
// 排除面在 tile-scope 裁决）。
//
// 显隐随 workspace/changed：current==='agent' 且 available 才建窗；普通/非托管桌面
// 零胶囊（用户故事 77：普通档除任务栏新秩序外无胶囊）。预览展开/恢复按钮/聚焦退出
// 归工单378+——本票胶囊只有计数主体。
import { BrowserWindow, screen } from 'electron'
import path from 'node:path'
import type { Context } from 'cordis'
import type { DesktopWorkspaceState } from '../../shared/contract'
import { wireBridgeIpc } from '../panel-ipc'
import type { EventLog } from '../panel-ipc'
import { capsuleUrl } from '../plugins/protocol'
import { hwndOf } from '../win32'

/** 胶囊窗标题：验收控制器按 pid + 标题寻窗（TASKBAR_TITLE 先例） */
export const CAPSULE_TITLE = 'DECK-CAPSULE'

/** 胶囊几何（DIP）：主屏顶部居中小条（计数胶囊不占平铺区——平铺顶部不留白，覆盖其上） */
const CAPSULE_W = 96
const CAPSULE_H = 30

function capsuleBounds(): { x: number; y: number; width: number; height: number } {
  const d = screen.getPrimaryDisplay().bounds
  return { x: d.x + Math.round((d.width - CAPSULE_W) / 2), y: d.y + 6, width: CAPSULE_W, height: CAPSULE_H }
}

function createCapsuleWindow(log: EventLog | null): BrowserWindow {
  const win = new BrowserWindow({
    ...capsuleBounds(),
    title: CAPSULE_TITLE,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    hasShadow: false,
    skipTaskbar: true,
    // 始终置顶（spec 决策 16「胶囊始终置顶」）：screen-saver 级——压过平铺窗口与
    // 前台应用（任务栏条带同带之上再一层，胶囊必须永远可见）
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '../../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  // 默认穿透（条带窗同款纪律）：本票胶囊只读计数，无交互面——整窗穿透，预览交互
  // 票再按命中区翻开。forward 不装（全局低级鼠标钩子成本，条带窗已实证的取舍）。
  win.setIgnoreMouseEvents(true)
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) log?.append({ type: 'capsule-renderer-console', level, message, line, sourceId })
  })
  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    log?.append({ type: 'capsule-load-failed', code, description, url })
  })
  return win
}

export interface CapsuleController {
  dispose(): void
  /** 当前胶囊窗原生句柄（桌面跟随兜底的跟随目标；不在场/销毁 = null） */
  hwnd(): number | null
}

/**
 * 胶囊控制器：订阅 workspace/changed 与 tiling/changed，随桌面模式建/销窗。
 * 窗内渲染层经同一桥订阅 tiling/changed 自渲染计数（主进程只管显隐与承载）。
 */
export function startCapsuleController(options: { ctx: Context; log: EventLog | null }): CapsuleController {
  const { ctx, log } = options
  let win: BrowserWindow | null = null
  let disposed = false

  // 显隐判据：桌面工作区投影 available && current==='agent'（工作区服务是桌面模式的
  // 事实源；实验开关关/未配对/非托管桌面都不出胶囊）。平铺服务的计数经桥事件直达
  // 渲染层，不参与显隐判据。
  const wantVisible = (): boolean => {
    if (disposed) return false
    const ws: DesktopWorkspaceState | null = ctx.desktopWorkspace?.state() ?? null
    return Boolean(ws && ws.available && ws.current === 'agent')
  }

  const sync = () => {
    if (disposed) return
    const want = wantVisible()
    if (want && (!win || win.isDestroyed())) {
      win = createCapsuleWindow(log)
      wireBridgeIpc(win, ctx.bridge, ['tiling/changed', 'workspace/changed'])
      void win.loadURL(capsuleUrl())
      win.showInactive()
      log?.append({ type: 'capsule-window-created' })
    } else if (!want && win && !win.isDestroyed()) {
      win.destroy()
      win = null
      log?.append({ type: 'capsule-window-closed' })
    }
  }

  ctx.on('workspace/changed', sync)
  ctx.on('tiling/changed', sync)
  // 装配期延迟一拍起跑：内核插件装配顺序下 desktopWorkspace/agentTiling 可能晚于本控制器
  setImmediate(sync)

  return {
    dispose(): void {
      disposed = true
      if (win && !win.isDestroyed()) win.destroy()
      win = null
    },
    hwnd(): number | null {
      return win && !win.isDestroyed() ? hwndOf(win) : null
    },
  }
}
