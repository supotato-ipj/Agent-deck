import { app, screen } from 'electron'
import path from 'node:path'
import { defaultPanelGeometry, defaultWeather, loadConfig } from './config'
import { createKernel } from './kernel'
import { HotzoneTracker } from './hotzone'
import { createPanelWindow } from './panel-window'
import { createTray } from './tray'
import { WinDRestorer } from './wind-restore'
import { fileEventLog, wireBridgeIpc, wireHostIpc } from './panel-ipc'
import { pinToBottom } from './win32'

const CONFIG_FILE = path.join(app.getAppPath(), 'config.json')
const RENDERER_HTML = path.join(__dirname, '../renderer/index.html')
const ACCEPT_MODE = process.argv.includes('--accept')

async function bootPanel(): Promise<void> {
  const log = fileEventLog(process.env.DECK_EVENT_LOG)
  const fallback = { panel: defaultPanelGeometry(screen.getPrimaryDisplay().bounds), weather: defaultWeather() }
  const { config, warnings, created } = loadConfig(CONFIG_FILE, fallback)
  for (const w of warnings) console.warn('[deck]', w)
  if (created) console.log('[deck] config.json 不存在，已按当前屏幕几何写出默认值')
  log?.append({ type: 'boot', pid: process.pid })

  const kernel = createKernel({ weather: config.weather })
  await kernel.start()

  const win = createPanelWindow({ geometry: config.panel })
  wireBridgeIpc(win, kernel.bridge)

  // 唤回面板的唯一实现点：还原（若收起）→ 显示（不夺焦）→ 重钉。
  // 托盘点击、second-instance、Win+D 防抖恢复共用；恢复后的重钉是票01 实施要点。
  const showPanel = (reason: string) => {
    if (win.isMinimized() || !win.isVisible()) win.showInactive()
    if (pinToBottom(win)) log?.append({ type: 'pin', reason: `show-${reason}` })
    log?.append({ type: 'panel-shown', reason })
  }

  const tracker = new HotzoneTracker(win, {
    onLeave: () => {
      // 探针01-C：热区交互（点击）会顶起 z 序，离开即重钉回底部
      if (pinToBottom(win)) log?.append({ type: 'pin', reason: 'hotzone-leave' })
    },
    onTransition: (hot) => log?.append({ type: hot ? 'hotzone-enter' : 'hotzone-leave' }),
  })
  wireHostIpc(win, tracker, log)

  const tray = createTray({ onShowPanel: () => showPanel('tray-click') })
  app.on('before-quit', () => {
    log?.append({ type: 'quit' })
    tray.destroy()
  })

  win.once('ready-to-show', () => {
    win.showInactive()
    if (pinToBottom(win)) log?.append({ type: 'pin', reason: 'startup' })
    // Win+D 防抖恢复：首显后开始盯收起态。spec 只要求最小化恢复（Win11 实测 ToggleDesktop
    // 对 skipTaskbar 工具窗豁免，面板根本不会因 Win+D 最小化——防抖机制兜底任意最小化来源，
    // 电池以 SW_MINIMIZE 演练）；不盯 !isVisible：隐藏是启动前的正常态，且未来「隐藏面板」
    // 功能不应被恢复器顶回（评审收编）。
    const restorer = new WinDRestorer(
      () => (win.isMinimized() ? 'minimized' : null),
      {
        onMinimized: (why) => log?.append({ type: 'wind-minimized', why }),
        onRestore: (why, afterMs) => {
          log?.append({ type: 'wind-restored', why, afterMs })
          showPanel('wind-restore')
        },
      },
    )
    win.on('closed', () => restorer.dispose())
  })
  win.on('closed', () => tracker.dispose())
  void win.loadFile(RENDERER_HTML)
  app.on('window-all-closed', () => app.quit())
  app.on('second-instance', () => showPanel('second-instance'))
}

if (!ACCEPT_MODE && !app.requestSingleInstanceLock()) {
  // 单实例守卫（工单03）：二次拉起立即自行退出，不出现双面板。
  // 验收电池模式不参与锁竞争（控制器与面板同仓库，面板是 spawn 出的第二个实例）。
  fileEventLog(process.env.DECK_EVENT_LOG)?.append({ type: 'single-instance-refused', pid: process.pid })
  app.quit()
} else {
  void app.whenReady().then(() => {
    if (ACCEPT_MODE) {
      // 验收电池：同一 Electron 应用上下文内以控制器身份运行（复用 nativeImage 截屏比对）。
      // 空处理器压掉「窗口全关默认退出」——电池自己管理生命周期（参照窗关掉后还要继续跑）。
      app.on('window-all-closed', () => {})
      require(path.join(app.getAppPath(), 'accept', 'battery.js'))()
      return
    }
    bootPanel().catch((err) => {
      console.error('[deck] 面板启动失败:', err)
      app.quit()
    })
  })
}
