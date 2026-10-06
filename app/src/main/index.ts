import { app, BrowserWindow, screen } from 'electron'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { defaultAppearance, defaultAutostart, defaultDesktopLayout, defaultPanelGeometry, defaultPlugins, defaultSearchConfig, defaultTaskbar, defaultTools, defaultWeather, loadConfig } from './config'
import { createPanelKernel } from './panel-kernel'
import { applyAutostart, desiredShortcut } from './autostart'
import { legacyUsageDir, migrateUsageLog } from './usage/migrate'
import { HotzoneTracker } from './hotzone'
import { createPanelWindow } from './panel-window'
import { startTaskbarController } from './taskbar/window'
import { createTray } from './tray'
import { DesktopCoverWatcher } from './desktop-cover'
import { WinDRestorer } from './wind-restore'
import { fileEventLog, wireBridgeIpc, wireHostIpc } from './panel-ipc'
import { pinToBottom } from './win32'
import { forceShowIcons, IconCarry } from './icon-carry'
import { forceShowNativeTaskbar, restoreNativeTaskbarIfHidden } from './taskbar/native'
import { defaultDesktopRoots } from './desktop/adapter'
import { installPluginProtocol, panelUrl, registerPluginScheme } from './plugins/protocol'
import { userDataPath } from './paths'
import type { TrayWireEvent } from './trayhost/protocol'

const CONFIG_FILE = path.join(app.getAppPath(), 'config.json')
/** 渲染层资产根（dist/renderer）：经 deck-plugin:// 协议交付，工单10 起与插件资产同源 */
const RENDERER_ROOT = path.join(__dirname, '../renderer')
/**
 * 内置桌面组件根（工单10）：五个内置信息卡即第一批桌面组件，与用户插件同一套契约。
 * 排在前 = 同 id 先到先得（用户插件顶不掉内置组件；想改内置就另起 id 或改本仓库）。
 */
const BUILTIN_CARDS_ROOT = path.join(RENDERER_ROOT, 'cards')
const ACCEPT_MODE = process.argv.includes('--accept')
const ACCEPT_TRAY_MODE = process.argv.includes('--accept-tray')
const ACCEPT_TASKBAR_MODE = process.argv.includes('--accept-taskbar')
/** 任务栏显隐验收（工单50）：控制器身份跑 accept/taskbar-carry.js */
const ACCEPT_TASKBAR_CARRY_MODE = process.argv.includes('--accept-taskbar-carry')
/** 任务栏右组验收（工单55）：控制器身份跑 accept/taskbar-right-group.js */
const ACCEPT_TASKBAR_RIGHT_GROUP_MODE = process.argv.includes('--accept-taskbar-right-group')
const PANEL_MODE = process.argv.includes('--panel')
/** 验收专用面板子进程（工单49）：完整面板但绕开单实例锁，与常驻面板共存 */
const PANEL_ACCEPT_MODE = process.argv.includes('--panel-accept')
const TRAY_SPIKE_MODE = process.argv.includes('--tray-spike')
const RESTORE_MODE = process.argv.includes('--icon-restore')

// 特权协议必须在 app ready 之前注册（Electron 硬要求）：面板页面与插件资产都走它。
registerPluginScheme()

/** 托盘 spike（工单48）：最小验收页标题（控制器按标题寻窗截图） */
export const TRAY_SPIKE_TITLE = 'TRAY-SPIKE-ACCEPT'

async function bootPanel(options: { traySpike?: boolean } = {}): Promise<void> {
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
    taskbar: defaultTaskbar(),
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

  // 托盘 spike（工单48）：最小验收页 + 托盘宿主开关（竞争窗口跑在数据面子进程）。
  // 页面未就绪前事件先入暂存，did-finish-load 后补发，不丢首波 NIM_ADD。
  let spikeWin: BrowserWindow | null = null
  let spikeReady = false
  const spikePending: TrayWireEvent[] = []
  // 图标主色真值（量化众数桶）：验收控制器拿它到页面截图里找同色像素簇，
  // 构成「第三方图标像素正确」的自动断言——页面渲染色必须与宿主提取色一致。
  const dominantColor = (icon: { bgraBase64: string }): [number, number, number] | null => {
    const bgra = Buffer.from(icon.bgraBase64, 'base64')
    const buckets = new Map<number, { r: number; g: number; b: number; n: number }>()
    for (let i = 0; i + 3 < bgra.length; i += 4) {
      if (bgra[i + 3] < 128) continue
      const key = ((bgra[i + 2] >> 5) << 6) | ((bgra[i + 1] >> 5) << 3) | (bgra[i] >> 5)
      const e = buckets.get(key) ?? { r: 0, g: 0, b: 0, n: 0 }
      e.r += bgra[i + 2]; e.g += bgra[i + 1]; e.b += bgra[i]; e.n++
      buckets.set(key, e)
    }
    let best: { r: number; g: number; b: number; n: number } | null = null
    for (const e of buckets.values()) if (!best || e.n > best.n) best = e
    if (!best || best.n < 24) return null
    return [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)]
  }
  const onTrayEvent = (event: TrayWireEvent) => {
    const dom = event.icon ? dominantColor(event.icon) : null
    log?.append({ type: 'tray-event', kind: event.kind, key: event.key, hwnd: event.hwnd, tooltip: event.tooltip, hasIcon: !!event.icon, w: event.icon?.width ?? 0, h: event.icon?.height ?? 0, ...(dom ? { dom } : {}) })
    if (spikeWin && !spikeWin.isDestroyed() && spikeReady) spikeWin.webContents.send('tray:event', event)
    else spikePending.push(event)
  }
  if (options.traySpike) {
    spikeWin = new BrowserWindow({
      width: 560, height: 920, title: TRAY_SPIKE_TITLE, autoHideMenuBar: true,
      webPreferences: { preload: path.join(app.getAppPath(), 'accept', 'lib', 'tray-spike-preload.js') },
    })
    spikeWin.webContents.on('did-finish-load', () => {
      spikeReady = true
      for (const e of spikePending) spikeWin?.webContents.send('tray:event', e)
      spikePending.length = 0
    })
    void spikeWin.loadFile(path.join(app.getAppPath(), 'accept', 'lib', 'tray-spike.html'))
  }

  const kernel = createPanelKernel({
    weather: config.weather,
    layout: config.desktop,
    search: { port: config.search.port, engine: config.search.engine, everythingPort: config.search.everythingPort },
    settings: { file: CONFIG_FILE, config },
    focus: { tools: config.tools },
    // 任务栏（工单49/54/55）：开关、按钮显隐与硬件摘要勾选随 config 下发，
    // set-enabled/set-button-hidden/set-metrics 经此整份回写
    taskbar: {
      enabled: config.taskbar.enabled,
      hiddenButtons: config.taskbar.hiddenButtons,
      metrics: config.taskbar.metrics,
      file: CONFIG_FILE,
      config,
    },
    // 桌面组件（工单10）：内置五卡 + 用户插件目录（缺省 userData/plugins；config.plugins.dir 可改）
    plugins: { roots: [BUILTIN_CARDS_ROOT, config.plugins.dir || userDataPath('plugins')] },
    // 数据面（鼠标卡顿修复）：四个采集服务在 utilityProcess 子进程跑，主进程不装定时器。
    // Electron API 不可用于子进程——桌面根/摆位存储/日志目录等路径全部在此解析后下发。
    dataplane: {
      workerModule: path.join(__dirname, 'dataplane.js'),
      init: {
        roots: defaultDesktopRoots(),
        storeFile: path.join(app.getPath('userData'), 'layout.json'),
        docMaxRows: config.desktop.docMaxRows,
        usageDir,
        ...(options.traySpike
          ? { traySpike: { corpusFile: process.env.DECK_TRAY_CORPUS ?? path.join(app.getAppPath(), 'accept', 'evidence', '48-tray-corpus.jsonl') } }
          : {}),
      },
      log: (event) => log?.append(event),
      onTrayEvent: options.traySpike ? onTrayEvent : undefined,
    },
  })
  await kernel.start()
  // 首拍就位（工单05 教训）：等数据面第一份快照再开窗，dock 随首绘就位；
  // 子进程异常时 whenReady 超时放行，面板以空数据面先起、子进程就绪后自然补拍。
  await kernel.panelData.whenReady

  installPluginProtocol({ appRoot: RENDERER_ROOT, host: kernel.plugins })

  const win = createPanelWindow({ geometry: config.panel })
  wireBridgeIpc(win, kernel.bridge)

  // 任务栏插件窗口（工单49）：跟随内核 taskbar 状态建/销；禁用即窗口消失，面板本体不受影响
  const taskbarCtl = startTaskbarController({ ctx: kernel, log })
  app.on('before-quit', () => taskbarCtl.dispose())

  // 唤回面板的唯一实现点：还原（若收起）→ 显示（不夺焦）→ 重钉。
  // 托盘点击、second-instance、Win+D 防抖恢复共用；恢复后的重钉是票01 实施要点。
  const showPanel = (reason: string) => {
    if (win.isMinimized() || !win.isVisible()) win.showInactive()
    if (pinToBottom(win)) log?.append({ type: 'pin', reason: `show-${reason}` })
    log?.append({ type: 'panel-shown', reason })
  }

  // 热区离开的重钉节流：光标在热区边界抖动时，离开确认（hotzone 去抖）+ 500ms 节流
  // 双保险，不把边界抖动放大成 z 序重排风暴（SetWindowPos(HWND_BOTTOM) 触发全系统重排）。
  let lastLeavePinMs = 0
  const tracker = new HotzoneTracker(win, {
    onLeave: () => {
      // 探针01-C：热区交互（点击）会顶起 z 序，离开即重钉回底部
      const now = Date.now()
      if (now - lastLeavePinMs < 500) return
      lastLeavePinMs = now
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
    // Win+D 防抖恢复：首显后开始盯收起态。 ToggleDesktop 不把面板最小化（skipTaskbar 下
    // shell 不视其为任务栏窗；注意 Electron 44 的 skipTaskbar 并不设置 WS_EX_TOOLWINDOW
    // 位——「工具窗豁免」的旧说法不成立，见工单07），防抖机制兜底任意最小化来源，
    // 电池以 SW_MINIMIZE 演练；不盯 !isVisible：隐藏是启动前的正常态，且未来「隐藏面板」
    // 功能不应被恢复器顶回（评审收编）。show desktop 态的「壁纸盖住面板」由桌面遮罩
    // 守望（下方）处置，电池以像素级断言与 cover 事件把关。
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
    // 桌面遮罩守望（工单07）：show desktop 态 shell 把 Progman 抬到面板之上，壁纸连带
    // 盖住面板（窗口态全程正常，肉眼即「deck 被显示桌面清空」）。守望器在 Progman 压顶
    // 时把面板临时提入 TOPMOST 带、Progman 回底即撤回重钉；TOPMOST 期间底部钉扎一律
    // 闸断（win32.setPinGate），防止热区离开/focus 兜底把面板亲手塞回壁纸之下。
    const cover = new DesktopCoverWatcher(win, log ?? undefined)
    win.on('closed', () => cover.dispose())
  })
  win.on('closed', () => tracker.dispose())
  // 兜底重钉（工单02）：面板永不激活，但键盘模式/系统交互理论上仍可能送来 focus 事件——
  // 探针实证前台/激活态下 HWND_BOTTOM 重钉依然生效，focus 即钉回，z 序永不破例。
  win.on('focus', () => {
    if (pinToBottom(win)) log?.append({ type: 'pin', reason: 'focus-fallback' })
  })
  // 面板页面经 deck-plugin:// 加载（工单10）：与插件资产同源，ESM 与动态 import 才成立
  void win.loadURL(panelUrl())
  // 主窗关闭即退出（工单49：任务栏条带是同进程第二个常驻窗，window-all-closed 要等
  // 它先关才成立——WM_CLOSE 只落主窗时条件永不达成、进程残留（主电池 P10 实证）。
  // 条带窗的拆卸走上方 before-quit 的 taskbarCtl.dispose()。
  win.on('closed', () => app.quit())
  app.on('second-instance', () => showPanel('second-instance'))
}

if (RESTORE_MODE) {
  // 一次性恢复入口（--icon-restore）：确保原生图标与原生任务栏可见。电池清场兜底
  // 与用户自救通道（工单50 起任务栏同通道）；不抢单实例锁（面板可能在跑，恢复与其互不影响）。
  const log = fileEventLog(process.env.DECK_EVENT_LOG)
  log?.append({ type: 'carry-boot', pid: process.pid, mode: 'restore' })
  forceShowIcons(log)
  forceShowNativeTaskbar(log)
  app.exit(0)
} else if (!ACCEPT_MODE && !PANEL_MODE && !TRAY_SPIKE_MODE && !ACCEPT_TRAY_MODE && !ACCEPT_TASKBAR_MODE && !ACCEPT_TASKBAR_CARRY_MODE && !ACCEPT_TASKBAR_RIGHT_GROUP_MODE && !PANEL_ACCEPT_MODE) {
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
    // 还原双兜底（工单50）：图标走 IconCarry（「本次由我隐藏」标记 + 视图事实），
    // 原生任务栏走视图事实兜底（隐藏动作在面板侧任务栏窗控制器，守卫查不到它的
    // 内存标记——隐藏态才翻回，可见绝不动）。两路幂等，多出口共用。
    const restoreCarry = (reason: string) => {
      carry.restore(reason)
      restoreNativeTaskbarIfHidden(log, reason)
    }
    app.on('before-quit', () => restoreCarry('outer-quit'))
    // 控制台信号缝隙（2026-09-28，09 票人工核验时踩到）：Ctrl+C / Ctrl+Break / 关终端窗由
    // conhost 同发守卫与面板，Electron 主进程在 Windows 下 process.on('SIGINT'|'SIGBREAK')
    // 不触发（真机实证：CTRL_BREAK 经 GenerateConsoleCtrlEvent 送达后整树死亡、Node 信号
    // 处理器未运行、图标留隐藏态）——守卫进程内的任何还原钩子都会被同杀。
    // 解法：还原守护（icon-restore-watch.cjs）以 detached + stdio:ignore 出生——无控制台
    // 可收信号，且逃出 Chromium job kill-on-close（05 踩坑 2 的反向利用）；守护钉守卫
    // 进程对象等死亡，死后把仍隐藏的桌面图标/原生任务栏（视图事实）翻回。
    // 工单50 起守护常驻拉起（不再以 carry.didHide() 为条件）：原生任务栏的隐藏发生在
    // 面板侧、且可由设置开关在运行期随时打开——守卫在拉起时点无法预知还原义务；
    // 守护零义务时（守卫正常退出、一切可见）见到可见即静默自退，零感知。
    const watcher = spawn(process.execPath, [path.join(__dirname, 'icon-restore-watch.cjs'), String(process.pid)], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    watcher.on('error', (err) => log?.append({ type: 'restore-watch-spawn-failed', message: err.message }))
    watcher.unref()
    log?.append({ type: 'restore-watch-spawned', pid: watcher.pid })
    const child = spawn(process.execPath, [app.getAppPath(), '--panel'], {
      cwd: app.getAppPath(),
      env: process.env,
      stdio: 'inherit',
    })
    child.on('error', (err) => {
      console.error('[deck] 面板拉起失败:', err)
      restoreCarry('panel-spawn-failed')
      app.exit(1)
    })
    child.on('exit', (code) => {
      restoreCarry('panel-exit')
      log?.append({ type: 'carry-exit', code: code ?? 0 })
      app.exit(code ?? 0)
    })
  }
} else if (!ACCEPT_MODE && !TRAY_SPIKE_MODE && !ACCEPT_TRAY_MODE && !ACCEPT_TASKBAR_MODE && !ACCEPT_TASKBAR_CARRY_MODE && !ACCEPT_TASKBAR_RIGHT_GROUP_MODE && !PANEL_ACCEPT_MODE && !app.requestSingleInstanceLock()) {
  // 面板模式的单实例守卫（工单03）：锁由本进程持有直至退出，second-instance 唤回面板。
  fileEventLog(process.env.DECK_EVENT_LOG)?.append({ type: 'single-instance-refused', pid: process.pid })
  app.quit()
} else {
  // 验收子进程（--panel-accept）：电池要求时开 CDP 端口——运行时的桥动作（如任务栏
  // 开关 taskbar/set-enabled）由电池经 CDP 在真实渲染层驱动，覆盖「插件热切换」真机链路。
  if (PANEL_ACCEPT_MODE && process.env.DECK_CDP_PORT) {
    app.commandLine.appendSwitch('remote-debugging-port', process.env.DECK_CDP_PORT)
  }
  void app.whenReady().then(() => {
    if (ACCEPT_MODE) {
      // 验收电池：同一 Electron 应用上下文内以控制器身份运行（复用 nativeImage 截屏比对）。
      // 空处理器压掉「窗口全关默认退出」——电池自己管理生命周期（参照窗关掉后还要继续跑）。
      app.on('window-all-closed', () => {})
      require(path.join(app.getAppPath(), 'accept', 'battery.js'))()
      return
    }
    if (ACCEPT_TRAY_MODE) {
      // 托盘 spike 验收（工单48）：控制器身份跑 accept/tray-spike.js，面板以 --tray-spike 子进程拉起。
      app.on('window-all-closed', () => {})
      require(path.join(app.getAppPath(), 'accept', 'tray-spike.js'))()
      return
    }
    if (ACCEPT_TASKBAR_MODE) {
      // 任务栏验收（工单49）：控制器身份跑 accept/taskbar.js，面板以 --panel-accept 子进程拉起。
      app.on('window-all-closed', () => {})
      require(path.join(app.getAppPath(), 'accept', 'taskbar.js'))()
      return
    }
    if (ACCEPT_TASKBAR_CARRY_MODE) {
      // 任务栏显隐验收（工单50）：控制器身份跑 accept/taskbar-carry.js，全程真机链路
      // （守卫链默认入口 + --panel-accept 混合，见电池文件头）。
      app.on('window-all-closed', () => {})
      require(path.join(app.getAppPath(), 'accept', 'taskbar-carry.js'))()
      return
    }
    if (ACCEPT_TASKBAR_RIGHT_GROUP_MODE) {
      // 任务栏右组验收（工单55）：控制器身份跑 accept/taskbar-right-group.js，面板以
      // --panel-accept 子进程拉起。
      app.on('window-all-closed', () => {})
      require(path.join(app.getAppPath(), 'accept', 'taskbar-right-group.js'))()
      return
    }
    bootPanel({ traySpike: TRAY_SPIKE_MODE }).catch((err) => {
      console.error('[deck] 面板启动失败:', err)
      app.quit()
    })
  })
}
