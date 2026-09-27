import { app, screen } from 'electron'
import path from 'node:path'
import { defaultPanelGeometry, loadConfig } from './config'
import { createKernel } from './kernel'
import { HotzoneTracker } from './hotzone'
import { createPanelWindow } from './panel-window'
import { fileEventLog, wireBridgeIpc, wireHostIpc } from './panel-ipc'
import { pinToBottom } from './win32'

const CONFIG_FILE = path.join(app.getAppPath(), 'config.json')
const RENDERER_HTML = path.join(__dirname, '../renderer/index.html')

async function bootPanel(): Promise<void> {
  const log = fileEventLog(process.env.DECK_EVENT_LOG)
  const fallback = { panel: defaultPanelGeometry(screen.getPrimaryDisplay().bounds) }
  const { config, warnings, created } = loadConfig(CONFIG_FILE, fallback)
  for (const w of warnings) console.warn('[deck]', w)
  if (created) console.log('[deck] config.json 不存在，已按当前屏幕几何写出默认值')
  log?.append({ type: 'boot', pid: process.pid })

  const kernel = createKernel()
  await kernel.start()

  const win = createPanelWindow({ geometry: config.panel })
  wireBridgeIpc(win, kernel.bridge)
  const tracker = new HotzoneTracker(win, {
    onLeave: () => {
      // 探针01-C：热区交互（点击）会顶起 z 序，离开即重钉回底部
      if (pinToBottom(win)) log?.append({ type: 'pin', reason: 'hotzone-leave' })
    },
    onTransition: (hot) => log?.append({ type: hot ? 'hotzone-enter' : 'hotzone-leave' }),
  })
  wireHostIpc(win, tracker, log)

  win.once('ready-to-show', () => {
    win.showInactive()
    if (pinToBottom(win)) log?.append({ type: 'pin', reason: 'startup' })
  })
  win.on('closed', () => tracker.dispose())
  void win.loadFile(RENDERER_HTML)
  app.on('window-all-closed', () => {
    // 面板常驻；02 尚无托盘，窗口全关即退出（托盘与单实例守卫见工单03）。
    // 仅面板模式注册——验收电池模式有自己的窗口生命周期。
    app.quit()
  })
}

void app.whenReady().then(() => {
  if (process.argv.includes('--accept')) {
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
