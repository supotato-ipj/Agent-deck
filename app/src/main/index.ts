import { app, screen } from 'electron'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { defaultAppearance, defaultAutostart, defaultDesktopLayout, defaultPanelGeometry, defaultPlugins, defaultSearchConfig, defaultTools, defaultWeather, loadConfig } from './config'
import { createKernel } from './kernel'
import { applyAutostart, desiredShortcut } from './autostart'
import { legacyUsageDir, migrateUsageLog } from './usage/migrate'
import { HotzoneTracker } from './hotzone'
import { createPanelWindow } from './panel-window'
import { createTray } from './tray'
import { WinDRestorer } from './wind-restore'
import { fileEventLog, wireBridgeIpc, wireHostIpc } from './panel-ipc'
import { pinToBottom } from './win32'
import { forceShowIcons, IconCarry } from './icon-carry'
import { installPluginProtocol, panelUrl, registerPluginScheme } from './plugins/protocol'
import { userDataPath } from './paths'

const CONFIG_FILE = path.join(app.getAppPath(), 'config.json')
/** 渲染层资产根（dist/renderer）：经 deck-plugin:// 协议交付，工单10 起与插件资产同源 */
const RENDERER_ROOT = path.join(__dirname, '../renderer')
/**
 * 内置桌面组件根（工单10）：五个内置信息卡即第一批桌面组件，与用户插件同一套契约。
 * 排在前 = 同 id 先到先得（用户插件顶不掉内置组件；想改内置就另起 id 或改本仓库）。
 */
const BUILTIN_CARDS_ROOT = path.join(RENDERER_ROOT, 'cards')
const ACCEPT_MODE = process.argv.includes('--accept')
const PANEL_MODE = process.argv.includes('--panel')
const RESTORE_MODE = process.argv.includes('--icon-restore')

// 特权协议必须在 app ready 之前注册（Electron 硬要求）：面板页面与插件资产都走它。
registerPluginScheme()

async function bootPanel(): Promise<void> {
  const log = fileEventLog(process.env.DECK_EVENT_LOG)
  const fallback = {
    panel: defaultPanelGeometry(screen.getPrimaryDisplay().bounds),
    weather: defaultWeather(),
    desktop: defaultDesktopLayout(),
    search: defaultSearchConfig(),
    appearance: defaultAppearance(),
    tools: defaultTools(),
    plugins: defaultPlugins(),
    autostart: defaultAutostart(),
  }
  const { config, warnings, created } = loadConfig(CONFIG_FILE, fallback)
  for (const w of warnings) console.warn('[deck]', w)
  if (created) console.log('[deck] config.json 不存在，已按当前屏幕几何写出默认值')
  log?.append({ type: 'boot', pid: process.pid })

  // 自启项（工单11）：Startup 快捷方式由面板自举，且每次启动顺手清掉旧看门狗链的自启项。
  // 只有 config.autostart.appDir 声明的生产安装位置才有权新建/接管（开发 worktree 不劫持）。
  // 失败不拦启动——自启项写不进去不该挡住桌面。
  try {
    applyAutostart({
      enabled: config.autostart.enabled,
      appDir: config.autostart.appDir,
      runningAppDir: app.getAppPath(),
      desired: desiredShortcut(process.execPath, app.getAppPath()),
      log: (event) => log?.append(event),
    })
  } catch (err) {
    console.warn('[deck] 自启项处理失败:', err)
    log?.append({ type: 'autostart-failed', message: (err as Error).message })
  }

  const usageDir = path.join(app.getPath('userData'), 'usage')

  // 历史使用日志迁移（工单11）：Python 数据服务时代的使用日志先搬进 userData，
  // 搬完再启动采集，否则当天两份记录会被合并到同一个按天文件里、顺序错乱。
  // 幂等，重启安全；失败只降级为「从零开始积累」，不拦启动。
  try {
    migrateUsageLog({
      legacyDir: legacyUsageDir(),
      targetDir: usageDir,
      markerFile: path.join(usageDir, '.legacy-migrated.json'),
      nowMs: Date.now(),
      log: (event) => log?.append(event),
    })
  } catch (err) {
    console.warn('[deck] 使用日志迁移失败:', err)
    log?.append({ type: 'usage-migrate-failed', message: (err as Error).message })
  }

  const kernel = createKernel({
    weather: config.weather,
    layout: config.desktop,
    desktop: {
      storeFile: path.join(app.getPath('userData'), 'layout.json'),
      docMaxRows: config.desktop.docMaxRows,
    },
    usage: { dir: usageDir },
    search: { port: config.search.port },
    settings: { file: CONFIG_FILE, config },
    focus: { tools: config.tools },
    // 桌面组件（工单10）：内置五卡 + 用户插件目录（缺省 userData/plugins；config.plugins.dir 可改）
    plugins: { roots: [BUILTIN_CARDS_ROOT, config.plugins.dir || userDataPath('plugins')] },
  })
  await kernel.start()

  installPluginProtocol({ appRoot: RENDERER_ROOT, host: kernel.plugins })

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
  // 面板页面经 deck-plugin:// 加载（工单10）：与插件资产同源，ESM 与动态 import 才成立
  void win.loadURL(panelUrl())
  app.on('window-all-closed', () => app.quit())
  app.on('second-instance', () => showPanel('second-instance'))
}

if (RESTORE_MODE) {
  // 一次性恢复入口（--icon-restore）：确保原生图标可见。电池清场兜底与用户自救通道；
  // 不抢单实例锁（面板可能在跑，恢复与其互不影响）。
  const log = fileEventLog(process.env.DECK_EVENT_LOG)
  log?.append({ type: 'carry-boot', pid: process.pid, mode: 'restore' })
  forceShowIcons(log)
  app.exit(0)
} else if (!ACCEPT_MODE && !PANEL_MODE) {
  // 外层守卫（工单05，默认入口）：抢单实例锁——二次拉起在此快速拒绝（毫秒级）。
  // 首次拉起：隐藏原生图标 → 拉起面板（--panel 子进程）→ 常驻等待。守卫是面板的父进程，
  // taskkill /T 只清向下子树——杀面板进程（含崩溃/强杀）杀不到守卫，图标还原链路始终
  // 在场（工单验收项）。锁在 spawn 前显式让位：app 拆卸不瞬时，残留锁会把刚拉起的面板
  // 当成二次实例拒掉（真机烟雾实测）；空窗期内双拉起仍至多一个面板（锁二选一）。
  if (!app.requestSingleInstanceLock()) {
    fileEventLog(process.env.DECK_EVENT_LOG)?.append({ type: 'single-instance-refused', pid: process.pid })
    app.quit()
  } else {
    app.disableHardwareAcceleration() // 守卫不开窗口，压掉 GPU 进程
    app.releaseSingleInstanceLock()
    const log = fileEventLog(process.env.DECK_EVENT_LOG)
    const carry = new IconCarry(log)
    log?.append({ type: 'carry-boot', pid: process.pid, mode: 'carry' })
    carry.begin()
    app.on('before-quit', () => carry.restore('outer-quit'))
    // 控制台信号缝隙（2026-09-28，09 票人工核验时踩到）：Ctrl+C / Ctrl+Break / 关终端窗由
    // conhost 同发守卫与面板，Electron 主进程在 Windows 下 process.on('SIGINT'|'SIGBREAK')
    // 不触发（真机实证：CTRL_BREAK 经 GenerateConsoleCtrlEvent 送达后整树死亡、Node 信号
    // 处理器未运行、图标留隐藏态）——守卫进程内的任何还原钩子都会被同杀。
    // 解法：还原守护（icon-restore-watch.cjs）以 detached + stdio:ignore 出生——无控制台
    // 可收信号，且逃出 Chromium job kill-on-close（05 踩坑 2 的反向利用）；守护钉守卫
    // 进程对象等死亡，死后若原生图标仍隐藏则翻回。仅在「本次确实由我隐藏」后拉起：
    // 用户偏好隐藏/隐藏失败时无还原义务，也就无守护。正常退出路径守卫先还原、守护
    // 见到图标可见即静默自退，零感知。
    if (carry.didHide()) {
      const watcher = spawn(process.execPath, [path.join(__dirname, 'icon-restore-watch.cjs'), String(process.pid)], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      })
      watcher.on('error', (err) => log?.append({ type: 'restore-watch-spawn-failed', message: err.message }))
      watcher.unref()
      log?.append({ type: 'restore-watch-spawned', pid: watcher.pid })
    }
    const child = spawn(process.execPath, [app.getAppPath(), '--panel'], {
      cwd: app.getAppPath(),
      env: process.env,
      stdio: 'inherit',
    })
    child.on('error', (err) => {
      console.error('[deck] 面板拉起失败:', err)
      carry.restore('panel-spawn-failed')
      app.exit(1)
    })
    child.on('exit', (code) => {
      carry.restore('panel-exit')
      log?.append({ type: 'carry-exit', code: code ?? 0 })
      app.exit(code ?? 0)
    })
  }
} else if (!ACCEPT_MODE && !app.requestSingleInstanceLock()) {
  // 面板模式的单实例守卫（工单03）：锁由本进程持有直至退出，second-instance 唤回面板。
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
