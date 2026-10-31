import { app, BrowserWindow, screen } from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { defaultAppearance, defaultAutostart, defaultConversation, defaultDesktopLayout, defaultPanelGeometry, defaultPlugins, defaultSearchConfig, defaultTaskbar, defaultTools, defaultWeather, loadConfig } from './config'
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
import { attachLagSentinel, panelLabels } from './lag-sentinel'
import { pinToBottom } from './win32'
import { forceShowIcons, IconCarry } from './icon-carry'
import { forceShowNativeTaskbar, restoreNativeTaskbarIfHidden } from './taskbar/native'
import { restoreAppBarStateFromLedger } from './taskbar/appbar-ledger'
import { defaultDesktopRoots } from './desktop/adapter'
import { installPluginProtocol, panelUrl, registerPluginScheme } from './plugins/protocol'
import { startConversationWindow, wireConversationQuitGuard } from './conversation/window'
import { createNodeProjectionSource, type ManagedProjectionSource } from './conversation/managed-projection'
import { SessionCredentialRegistry } from './conversation/managed-credentials'
import { productionPluginRoots } from './plugins/roots'
import { DroppedPackageHost } from './plugins/package-host'
import { ExecutionContextRegistry } from './plugins/identity'
import { userDataPath } from './paths'
import type { TrayWireEvent } from './trayhost/protocol'

const CONFIG_FILE = path.join(app.getAppPath(), 'config.json')
/** 渲染层资产根（dist/renderer）：经 deck-plugin:// 协议交付，工单10 起与插件资产同源 */
const RENDERER_ROOT = path.join(__dirname, '../renderer')
const ACCEPT_DIR = path.join(app.getAppPath(), 'accept')

/**
 * 电池接入表（工单214，spec #203 决策 1/2/5/6）——段级清单的**电池级条目**是电池接线的
 * 唯一登记处：flag（控制器身份旗标）/ entry（电池模块路径）/ hintBar（验收提示条挂条条件）/
 * cdpPort（CDP 端口）/ kind（'experiment' = 取证工具，段级治理豁免）。
 *
 * 运行端读表统一分发：表内 flag 匹配 argv → require(entry)()；单实例豁免（任意控制器模式即豁免）
 * 与挂条条件一并由表派生——手维护布尔式（九连 if 与挂条超长条件行）随之退役。
 * 面板侧被测物模式（--panel/--panel-accept/--tray-spike）不表化，保留既在判别。
 *
 * 行为变更申报（工单214，非纯机械替换）：master 的面板模式单实例守卫布尔式**漏列
 * ACCEPT_DOC_GROUP_CARDS_MODE**——dgc 控制器会落到 requestSingleInstanceLock() 那一支并
 * **真的持有单实例锁**（其余八块控制器都被该布尔式豁免）。本刀起九个控制器**一律不持锁**：
 * 与母票 #203 决策 6「单实例豁免由表派生（任意控制器模式即豁免）」、AGENTS.md「控制器进程
 * 绕开单实例锁」以及 dgc 电池自身设计（其面板以 --panel-accept 绕锁子进程拉起、与常驻面板共存）
 * 三处口径一致。代价：轮中面板互斥不再由控制器持锁提供，改由 accept-guard 轮前清场
 * ＋ 主电池 preflight 的 double-panel 类承担（dgc 无双面板检测，取窗走 pid＋可见＋标题三重甄别）。
 */
interface BatteryRegistryEntry {
  id: string
  flag: string
  entry: string
  hintBar: boolean
  cdpPort: number | null
  kind: string | null
}

/**
 * 接入表读取器（app/accept/lib/registry.js）。此处是**模块顶层** require——普通启动路径
 * （不开验收）也会读一次表（读不到即空表，控制器不识别、走面板路径）。
 * 仓内无 asar 打包配置（accept/ 与 dist/ 平级在应用目录下），现状无实际风险；仅作稳健性备注。
 */
const registryLib = require(path.join(ACCEPT_DIR, 'lib', 'registry.js'))
const BATTERY_REGISTRY: BatteryRegistryEntry[] = registryLib.loadRegistry()

/** 控制器身份匹配（表派生）：表内 flag 命中 argv → 该条目；未命中即非控制器身份 */
function matchControllerEntry(argv: string[]): BatteryRegistryEntry | null {
  for (const e of BATTERY_REGISTRY) {
    if (argv.includes(e.flag)) return e
  }
  return null
}

/** 本进程的控制器条目（表派生；表空或旗标未命中即 null → 走面板路径） */
const CONTROLLER_ENTRY = matchControllerEntry(process.argv)
/**
 * 任意控制器模式即豁免单实例守卫（表派生）。
 * 口径变更见上注：master 上 dgc 控制器因守卫布尔式漏列而**仍会持锁**，本刀起与其余八块一致。
 */
const IS_CONTROLLER_MODE = CONTROLLER_ENTRY !== null
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
  // 滞后哨兵（工单117）：DECK_LAG_SENTINEL 未设时 attachLagSentinel 原样退回同一引用
  // （常规模式零改动）；诊断模式起采样并把 lag 事件（type='main-lag'）落同一事件文件，
  // 标签置/清另落 sidecar（事件文件 + '.spans.jsonl'）——终末冻结时它以无 close 的
  // span-open 收尾，即卡死调用点的签名。
  const eventFile = process.env.DECK_EVENT_LOG
  const log = attachLagSentinel(
    fileEventLog(eventFile),
    process.env.DECK_LAG_SENTINEL,
    eventFile ? `${eventFile}.spans.jsonl` : undefined,
  )
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
    conversation: defaultConversation(),
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

  // 托盘 spike（工单48）：最小验收页（托盘宿主本身工单56 起常驻，不再由本开关起停）。
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

  // 投放包宿主（工单331）：dropped 档独立执行上下文的 Electron 接线。登记表与宿主先于
  // 内核装配创建（激活发生在 PluginHostService 构造期首扫），config 存储与崩溃记账经
  // 懒闭包在内核就绪后解析。仅用户根是投放档（roots.ts 档位标记）。
  const packageRegistry = new ExecutionContextRegistry()
  let kernelRef: ReturnType<typeof createPanelKernel> | null = null
  const droppedPackageHost = new DroppedPackageHost({
    registry: packageRegistry,
    configPort: () => kernelRef?.pluginConfig ?? null,
    onCrashed: (id, reason) => kernelRef?.plugins.markDroppedCrashed(id, reason),
    log: (event) => log?.append(event),
  })
  // 对话窗唤起钩子（工单332）：装配期先占位，控制器就位后重绑
  const conversationShowHook: { fn: (sessionId: string | null) => void } = { fn: () => {} }
  // 管理面凭证登记处（工单333）：显式建在装配层（服务自建则观察口拿不到同一实例）——
  // 仅内存；accept 观察口经它向电池转交 bearer（绝不落盘）
  const managedRegistry = new SessionCredentialRegistry()

  const kernel = createPanelKernel({
    weather: config.weather,
    layout: config.desktop,
    // 退出面板（工单83）：设置浮层按钮经 app/quit 到这里——与托盘菜单同一 app.quit 收敛
    quit: () => app.quit(),
    search: { port: config.search.port, engine: config.search.engine, everythingPort: config.search.everythingPort },
    settings: { file: CONFIG_FILE, config },
    focus: { tools: config.tools },
    // 任务栏（工单49/54/55）：开关、按钮显隐与硬件摘要勾选随 config 下发，
    // set-enabled/set-button-hidden/set-metrics 经此整份回写
    taskbar: {
      enabled: config.taskbar.enabled,
      hiddenButtons: config.taskbar.hiddenButtons,
      metrics: config.taskbar.metrics,
      trayOverflowLimit: config.taskbar.trayOverflowLimit,
      // 最大化收栏开关（工单239）：随 config 下发，默认开；设置浮层切换经
      // taskbar/set-maximize-retract 即时生效
      maximizeRetract: config.taskbar.maximizeRetract,
      file: CONFIG_FILE,
      config,
    },
    // 桌面组件：内置卡 + 第一方包根 + 用户插件目录（缺省 userData/plugins；config.plugins.dir 可改）。
    // 停用集（工单101）：读 config.plugins.disabled 的活引用——settings/set-card-enabled
    // 改写 config 后经 settings/cards-changed 触发重扫，清单随即剔除/恢复，无需重建宿主。
    plugins: {
      roots: productionPluginRoots({
        appRoot: app.getAppPath(),
        rendererRoot: RENDERER_ROOT,
        userRoot: config.plugins.dir || userDataPath('plugins'),
      }),
      disabledIds: () => config.plugins.disabled,
      // 投放档（工单331）：独立上下文宿主端口 + 生命周期事件出口（dropped-package-*）
      droppedHost: droppedPackageHost,
      // DSH 安装管线（工单334）：待装载区面板私域（userData/plugins-staging）；会话工作区
      // 事实源 = 对话域会话 cwd（kernelRef 惰性取）；有界激活 12s（t331 坑位：crash 悬挂竞速）
      install: {
        stagingRoot: userDataPath('plugins-staging'),
        userRoot: config.plugins.dir || userDataPath('plugins'),
        sessionInfo: (sessionId) => {
          const v = kernelRef?.conversation?.sessions().find((s) => s.id === sessionId)
          return v ? { cwd: v.cwd, label: v.label } : null
        },
        mountBoundMs: 12_000,
      },
      log: (event) => log?.append(event),
    },
    // 对话窗（工单332）：面板专属 DSH_HOME 与元数据落 userData（跟面板走），后端档
    // config.conversation 下发；会话事件走 DECK_EVENT_LOG 存证。窗口唤起经控制器（下）。
    conversation: {
      config: { exe: config.conversation.dshExe, model: config.conversation.model },
      // 工单340（ADR-0026）：数据目录指向跟 config 走（缺省 userData/dsh-home，手势切换后
      // 下次启动落到新目录）；persistDshHome = 全新目录手势的持久化缝（旧目录零触碰）。
      dshHome: config.conversation.dshHome || undefined,
      notifyShow: (sessionId) => conversationShowHook.fn(sessionId),
      deps: {
        log: (event) => log?.append(event),
        persistDshHome: (home) => {
          const raw = fs.readFileSync(CONFIG_FILE, 'utf8')
          const json = raw.trim() ? JSON.parse(raw) : {}
          json.conversation = { ...(json.conversation ?? {}), dshHome: home }
          fs.writeFileSync(CONFIG_FILE, JSON.stringify(json, null, 2) + '\n', 'utf8')
        },
      },
      // 管理面（工单333，ADR-0018/0009/0025）：独立专用 MCP 宿主 + 只读投影源。
      // 投影源惰性求值（内核启动后才有单点引用）；快照走 bridge 单点（不私开第二执行路径），
      // 插件清单走 plugins 服务（内核 + 投放两路），源码读仅限用户插件根（投影模块内做
      // 包含校验与体积上限），契约目录取 catalog.ts 单一正典的 agent 投影。
      managed: {
        registry: managedRegistry,
        source: (() => {
          let cached: ManagedProjectionSource | null = null
          return () => {
            if (!cached) {
              cached = createNodeProjectionSource({
                userRoot: config.plugins.dir || userDataPath('plugins'),
                panelSnapshot: () => {
                  if (!kernelRef) throw new Error('内核未就绪（面板启动中）')
                  return kernelRef.bridge.snapshot()
                },
                pluginsList: () => ({
                  kernel: kernelRef?.plugins.info() ?? [],
                  dropped: kernelRef?.plugins.droppedInfo() ?? [],
                }),
                // 工单334：安装提交缝（MCP 只收路径；会话工作区包含校验在 install.ts，
                // sessionId 从 bearer 通道绑定来）
                installSubmit: (args, mctx) => {
                  const mgr = kernelRef?.plugins.installs
                  if (!mgr) throw new Error('本面板未装配安装面（install 未接线）——安装工具不可用')
                  // backend='dsh'：管理面 v1 后端唯一 = DSH（ADR-0026）
                  return mgr.submit(args, { sessionId: mctx.sessionId, backend: 'dsh' })
                },
              })
            }
            return cached
          }
        })(),
      },
    },
    // 数据面（鼠标卡顿修复）：四个采集服务在 utilityProcess 子进程跑，主进程不装定时器。
    // Electron API 不可用于子进程——桌面根/摆位存储/日志目录等路径全部在此解析后下发。
    dataplane: {
      workerModule: path.join(__dirname, 'dataplane.js'),
      init: {
        roots: defaultDesktopRoots(),
        storeFile: path.join(app.getPath('userData'), 'layout.json'),
        docMaxRows: config.desktop.docMaxRows,
        usageDir,
        // 托盘宿主（工单56 入栏、#153 随任务栏开关）：子进程竞争同名窗口收编系统托盘；
        // 启态禁用不建（不偷图标——图标只该随条带收编），运行期启停经 tray-control；
        // 验收 spike 模式恒建并额外收语料（测试夹具来源）
        tray: (options.traySpike || config.taskbar.enabled)
          ? (options.traySpike
            ? { corpusFile: process.env.DECK_TRAY_CORPUS ?? path.join(app.getAppPath(), 'accept', 'evidence', '48-tray-corpus.jsonl') }
            : {})
          : undefined,
      },
      log: (event) => log?.append(event),
      onTrayEvent: options.traySpike ? onTrayEvent : undefined,
    },
  })
  await kernel.start()
  kernelRef = kernel
  // 投放包视图数据（工单331）：快照随拍按 capabilities 裁剪后推给各包独立上下文
  kernel.on('panel/changed', (snap) => droppedPackageHost.pushSnapshot(snap))
  // 首拍就位（工单05 教训）：等数据面第一份快照再开窗，dock 随首绘就位；
  // 子进程异常时 whenReady 超时放行，面板以空数据面先起、子进程就绪后自然补拍。
  await kernel.panelData.whenReady

  installPluginProtocol({ appRoot: RENDERER_ROOT, sharedRoot: path.join(__dirname, '../shared'), host: kernel.plugins, log: (e) => log?.append(e) })

  const win = createPanelWindow({ geometry: config.panel })
  // 投放包视图挂载（工单331）：开窗前已激活的包在此补挂 contentView
  droppedPackageHost.attach(win)
  wireBridgeIpc(win, kernel.bridge)

  // 任务栏插件窗口（工单49）：跟随内核 taskbar 状态建/销；禁用即窗口消失，面板本体不受影响
  const taskbarCtl = startTaskbarController({ ctx: kernel, log })
  app.on('before-quit', () => taskbarCtl.dispose())

  // #103 缺陷① 验收触发器（accept 双门禁）：P10 需要同一 JS 任务内连发两次 setEnabled——
  // renderer 侧双桥写无论多快都跨 IPC 任务，旧窗 closed 总能先落地（2026-10-11 红轮实证）。
  // hint-bar 同款 accept 树 require 先例，仅 DECK_TASKBAR_BURST=1 的 --panel-accept 拉起。
  if (PANEL_ACCEPT_MODE && process.env.DECK_TASKBAR_BURST === '1') {
    require(path.join(app.getAppPath(), 'accept', 'lib', 'taskbar-burst.js')).run(kernel, log)
  }

  // 管理型会话验收观察口（工单333，accept 双门禁）：凭证绝不落盘——bearer 只在本进程
  // 内存应答给电池控制器（驱动 401/未知工具/宿主回收三条真机断言）；端口（非凭证）写
  // evidence/333-managed-probe-port.json 供寻址，电池轮末自删。生产零启用。
  if (PANEL_ACCEPT_MODE && process.env.DECK_MANAGED_PROBE === '1') {
    require(path.join(app.getAppPath(), 'accept', 'lib', 'managed-probe.js'))
      .startManagedProbe(managedRegistry, log)
      .then((probe: { close: () => Promise<void> }) => { app.on('before-quit', () => { void probe.close() }) })
  }

  // 唤回面板的唯一实现点：还原（若收起）→ 显示（不夺焦）→ 重钉。
  // 托盘点击、second-instance、Win+D 防抖恢复共用；恢复后的重钉是票01 实施要点。
  const showPanel = (reason: string) => {
    // 滞后哨兵（工单117）：show 是原生窗口显示路径（审计 B5），与重钉分开标注
    if (win.isMinimized() || !win.isVisible()) panelLabels.run('panel-show', () => win.showInactive())
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
  // 渲染层活性心跳武装（#91）：面板窗接 2s 心跳（deck:host-beat，渲染层 main.ts 起拍），
  // 哨兵失能档只在武装态发射。任务栏条带不接（观测口径不变，epic 暂停期不碰）。
  wireHostIpc(win, tracker, log, { sentinelHeartbeat: true })

  // 对话窗（工单332）：窗口控制器（关窗只收起、退出确认）+ 托盘入口。
  // 服务唤起钩子在装配期指向惰性转发（控制器在内核启动后才存在）。
  const conversationCtl = startConversationWindow({ ctx: kernel, log })
  conversationShowHook.fn = (sessionId) => conversationCtl.show(sessionId ?? undefined)
  wireConversationQuitGuard(conversationCtl)
  app.on('before-quit', () => conversationCtl.dispose())

  const tray = createTray({ onShowPanel: () => showPanel('tray-click'), onShowConversation: () => conversationCtl.show() })
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
  // 工单261（还原账全路径扩展）：appbar 落盘账同通道消费——置位态滞留（守护双兜底均
  // 失败的 freak 现场）时用户有自救出口。appbar 复原先于 forceShowNativeTaskbar：
  // 置位态翻开 Shell_TrayWnd 的 WS_VISIBLE 位（spike 附记「窗口显示位」≠「视觉在场」），
  // 后行会被「已可见」骗过；先卸置位，可见性兜底才做真工作。异步退避有界（<3s），走完再退场。
  const log = fileEventLog(process.env.DECK_EVENT_LOG)
  log?.append({ type: 'carry-boot', pid: process.pid, mode: 'restore' })
  forceShowIcons(log)
  void restoreAppBarStateFromLedger(log, 'force').finally(() => {
    forceShowNativeTaskbar(log)
    app.exit(0)
  })
} else if (!IS_CONTROLLER_MODE && !PANEL_MODE && !TRAY_SPIKE_MODE && !PANEL_ACCEPT_MODE) {
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
    // 还原三兜底（工单50 图标/可见性；工单261 appbar 落盘账）：
    // - appbar 账复原**先行**（顺序即行为）：收栏置位态 explorer 翻开 Shell_TrayWnd 的
    //   WS_VISIBLE 位（spike 附记「窗口显示位」≠「视觉在场」），后行会被「已可见」骗过
    //   可见性判据；先卸置位，可见性兜底才做真工作并落 taskbar-restored 存证。
    // - 账复原是异步退避（有限次、终局有界 <3s）——调用方等它走完再 app.exit
    //   （否则退避定时器随进程蒸发，账白记）。
    const restoreCarry = async (reason: string) => {
      await restoreAppBarStateFromLedger(log, reason)
      carry.restore(reason)
      restoreNativeTaskbarIfHidden(log, reason)
    }
    app.on('before-quit', (e) => {
      // outer-quit 径等账走完再退场：preventDefault 挡默认退出序列，退避终局后显式 exit
      e.preventDefault()
      void restoreCarry('outer-quit').finally(() => app.exit(0))
    })
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
      void restoreCarry('panel-spawn-failed').finally(() => app.exit(1))
    })
    child.on('exit', (code) => {
      // 面板退出（含崩溃/强杀——taskkill /T 杀不到父级守卫）：等 appbar 账退避走完
      // 再随面板退出码退场（工单261；50 电池 A3 的 panel-exit 径）。finally 兜底与其余
      // 两径对齐：restoreCarry 一旦 reject（清账 rmSync 遇 Windows 文件锁、FFI 抛错），
      // app.exit 也必须执行——否则守卫变僵尸进程吊住不放、还原守护（盯守卫 pid）永不
      // 触发；拒绝落存证，不无声。
      void restoreCarry('panel-exit').then(
        undefined,
        (err) => { log?.append({ type: 'carry-restore-failed', reason: 'panel-exit', message: String(err) }) },
      ).finally(() => {
        log?.append({ type: 'carry-exit', code: code ?? 0 })
        app.exit(code ?? 0)
      })
    })
  }
} else if (!IS_CONTROLLER_MODE && !TRAY_SPIKE_MODE && !PANEL_ACCEPT_MODE && !app.requestSingleInstanceLock()) {
  // 面板模式的单实例守卫（工单03）：锁由本进程持有直至退出，second-instance 唤回面板。
  fileEventLog(process.env.DECK_EVENT_LOG)?.append({ type: 'single-instance-refused', pid: process.pid })
  app.quit()
} else {
  // 面板进程（--panel / --panel-accept）：电池要求时开 CDP 端口——运行时的桥动作（如任务栏
  // 开关 taskbar/set-enabled）与渲染层活性取证（#91 P12 忙环注入）由电池经 CDP 在真实
  // 渲染层驱动。守卫拉起的 --panel 子进程继承环境变量，故门控不分公司/验收两种面板态。
  if ((PANEL_ACCEPT_MODE || PANEL_MODE) && process.env.DECK_CDP_PORT) {
    app.commandLine.appendSwitch('remote-debugging-port', process.env.DECK_CDP_PORT)
  }
  // 遮挡不得降频（工单59 真机首跑实证，见 panel-window.ts 的 backgroundThrottling）：
  // 面板与条带是常驻桌面件，被普通窗盖住是常态而非「看不见」——Chromium 默认把被遮挡
  // 的渲染层后台化（停帧、掐表），面板当场失能：热区不解穿透（点击漏到桌面）、新快照
  // 不上屏（新建文件不出现）。这两项在 ready 之前必须挂上。
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  void app.whenReady().then(() => {
    // 工单86 验收提示条：控制器身份挂条——琥珀药丸驻留屏幕上中部安全带，提示用户暂勿键鼠操作；
    // 随控制器进程生灭自清（约束与依据见 accept/lib/hint-bar.js 头注、docs/adr/0008-accept-hint-bar.md）。
    // 工单214（spec #203 决策 4/6）：挂条条件改由电池接入表派生——命中条目的 hintBar 为真即挂条；
    // 八块电池 + stall-duel 对照实验共九项在表内逐条登记（--panel-accept/--tray-spike 是被测物
    // 子进程，不表化、不挂条）。形态与三条硬约束不动（ADR-0008 域）。
    if (registryLib.hintBarRequired(CONTROLLER_ENTRY)) {
      require(path.join(ACCEPT_DIR, 'lib', 'hint-bar.js')).showAcceptHintBar()
    }
    if (CONTROLLER_ENTRY) {
      // 通用分发（工单214）：表内 flag 匹配 argv → require(entry)()。
      // 空处理器压掉「窗口全关默认退出」——电池自己管理生命周期（参照窗关掉后还要继续跑）；
      // 处理器由本分发统一注册一次（原先每块电池各注册一遍）。
      app.on('window-all-closed', () => {})
      require(registryLib.modulePathFor(CONTROLLER_ENTRY.entry))()
      return
    }
    bootPanel({ traySpike: TRAY_SPIKE_MODE }).catch((err) => {
      console.error('[deck] 面板启动失败:', err)
      app.quit()
    })
  })
}
