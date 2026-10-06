// 任务栏窗口（工单49/50/51，ADR-0007）：体系内第一个置顶窗口——独立、无边框、透明、
// 主屏底部通栏条带（落屏底；隐藏原生任务栏失败的降级档才让出净空，见
// TASKBAR_BOTTOM_CLEARANCE），渲染层在其中央画 pill。本文件是 Electron 效果层
// （离线测试不加载）：窗口建/销由 TaskbarService 的状态与 taskbar/changed 事件
// 驱动（禁用即窗口消失）。工单50 起控制器同时持有原生任务栏显隐：建窗先隐藏
// 原生任务栏、销窗还原（只还原自己藏的那次）；死路径兜底在守卫与还原守护。
// 工单51 起注册 AppBar 占住主屏底边工作区（最大化窗底边停在栏上方，销窗归还），
// 并轮询前台全屏让位（AppBar 生效才让位——降级档最大化窗覆盖全屏会误判）。
import { BrowserWindow, screen } from 'electron'
import path from 'node:path'
import type { Context } from 'cordis'
import type { TaskbarState } from '../../shared/contract'
import { HotzoneTracker } from '../hotzone'
import type { EventLog } from '../panel-ipc'
import { wireBridgeIpc, wireHostIpc } from '../panel-ipc'
import { taskbarUrl } from '../plugins/protocol'
import { setTopmost, hwndOf } from '../win32'
import { hideNativeTaskbar, nativeTaskbarVisible, showNativeTaskbar } from './native'
import { ABN_POSCHANGED, appBarCallbackMessage, negotiateAppBarPos, registerAppBar, removeAppBar } from './appbar'
import type { AppBarRect } from './appbar'
import { probeForegroundWindow, shouldYieldToFullscreen } from './yield'
import type { PhysRect } from './yield'

/** 任务栏窗口标题：验收控制器按 pid + 标题寻窗（TRAY_SPIKE_TITLE 先例） */
export const TASKBAR_TITLE = 'DECK-TASKBAR'
/** 条带高度（DIP，工单37 默认档位；几何手改口属后续票） */
export const TASKBAR_HEIGHT = 48
/**
 * 条带底边距屏底的降级净空（DIP，工单50 起仅降级档）：原生任务栏仍可见时让出它的
 * 高度、坐到上沿。49 真机实证（zprobe 阶梯）：Shell_TrayWnd 位于普通 TOPMOST 之上的
 * 窗口层级，且 explorer 主动重申防守——同矩形重叠全阶梯无解，不重叠则竞争从根上消失。
 * 常态路径下工单50 已先隐藏原生任务栏（下方 clearance 按视图事实取 0），条带落回屏底；
 * 本净空只在隐藏失败（句柄缺位等）降级时生效。
 */
export const TASKBAR_BOTTOM_CLEARANCE = 48

/** 全屏让位轮询间隔（工单51）：退出全屏 ≤1 秒恢复的验收口径，250ms 四拍内必达 */
const YIELD_POLL_MS = 250

/** 主屏物理矩形（AppBar/让位判定同为 GetWindowRect 物理口径，非 DIP） */
function primaryPhysRect(): PhysRect {
  const d = screen.getPrimaryDisplay()
  return {
    left: Math.round(d.bounds.x * d.scaleFactor),
    top: Math.round(d.bounds.y * d.scaleFactor),
    right: Math.round((d.bounds.x + d.bounds.width) * d.scaleFactor),
    bottom: Math.round((d.bounds.y + d.bounds.height) * d.scaleFactor),
  }
}

/** 主屏底部通栏几何（v1 仅主屏，ADR-0007 Out of Scope）。净空按视图事实：
 * 原生任务栏已隐藏（常态）落屏底，仍可见（隐藏失败降级）让出其上沿。 */
function stripBounds(): { x: number; y: number; width: number; height: number } {
  const d = screen.getPrimaryDisplay().bounds
  const clearance = nativeTaskbarVisible() ? TASKBAR_BOTTOM_CLEARANCE : 0
  return {
    x: d.x,
    y: d.y + d.height - TASKBAR_HEIGHT - clearance,
    width: d.width,
    height: TASKBAR_HEIGHT,
  }
}

/** 条带 DIP 几何 → AppBar 提议矩形（物理像素；AppBar 生效档净空必为 0，底边贴屏底） */
function stripPhysRect(): AppBarRect {
  const d = screen.getPrimaryDisplay()
  const full = primaryPhysRect()
  return {
    left: full.left,
    top: full.bottom - Math.round(TASKBAR_HEIGHT * d.scaleFactor),
    right: full.right,
    bottom: full.bottom,
  }
}

/**
 * 任务栏窗口：置顶 + 透明无边框 + 默认鼠标穿透（热区跟踪器接管——pill 缝隙点击
 * 穿透到下方窗口/壁纸，pill 内热区正常接收）。focusable:false 与面板同款：
 * 点击 pill 按钮不夺焦，按键合成送达系统时前台语义不被自家窗口搅乱。
 */
function createTaskbarWindow(): BrowserWindow {
  const win = new BrowserWindow({
    ...stripBounds(),
    title: TASKBAR_TITLE,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '../../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  // 默认穿透（面板同款纪律）：不带 forward——Electron 的 forward 实现要装全局低级
  // 鼠标钩子，主线程任一阻塞拖慢全系统光标（.scratch/mouse-lag/ 基线存证）。
  win.setIgnoreMouseEvents(true)
  return win
}

export interface TaskbarController {
  dispose(): void
}

/**
 * 任务栏窗口控制器：跟随 TaskbarService 状态建/销窗口（启用即建、禁用即销）。
 * 与面板的 z 序纪律相反：面板钉底，本窗置顶——热区离开即重申置顶（ADR-0007 残余
 * 风险：z 序竞争需定时/事件驱动维持置顶）。
 */
export function startTaskbarController(options: { ctx: Context; log: EventLog | null }): TaskbarController {
  const { ctx, log } = options
  let win: BrowserWindow | null = null
  let tracker: HotzoneTracker | null = null
  // 原生任务栏显隐账（工单50）：只还原「本次由我隐藏」的那次；隐藏失败/本已隐藏
  // 则无还原义务（死路径兜底由守卫与还原守护以视图事实补足）。
  let hidNative = false
  // AppBar 占位账（工单51）：注册成功的条带窗句柄；销窗先注销归还工作区。
  // null = 注册失败降级档（不占工作区，也不做全屏让位——降级档最大化窗覆盖
  // 全屏会造成误判，宁可不让位也不闪）。
  let appBarHwnd: number | null = null
  // 全屏让位态与轮询（工单51）：仅 AppBar 生效档轮询。
  let yielded = false
  let yieldTimer: NodeJS.Timeout | null = null

  const stopYieldPoll = () => {
    if (yieldTimer) clearInterval(yieldTimer)
    yieldTimer = null
    yielded = false
  }

  /** 协商矩形（物理）→ 条带窗 DIP 几何（差异 >1 DIP 才动，避免与系统微调来回震荡） */
  const applyNegotiated = (rc: AppBarRect) => {
    if (!win || win.isDestroyed()) return
    const dip = screen.screenToDipRect(win, { x: rc.left, y: rc.top, width: rc.right - rc.left, height: rc.bottom - rc.top })
    const cur = win.getBounds()
    if (Math.abs(dip.x - cur.x) > 1 || Math.abs(dip.y - cur.y) > 1
      || Math.abs(dip.width - cur.width) > 1 || Math.abs(dip.height - cur.height) > 1) {
      win.setBounds(dip)
    }
  }

  /** 占位重协商（建窗后初次、ABN_POSCHANGED、display-metrics-changed 三入口同路） */
  const renegotiate = (reason: string) => {
    if (appBarHwnd === null || !win || win.isDestroyed()) return
    applyNegotiated(negotiateAppBarPos(appBarHwnd, stripPhysRect(), log, reason))
  }

  const destroy = (reason: string) => {
    // 还原先于窗口判空：hidNative 账独立于 win 存续（窗被外部先销/建窗半途抛错
    // 都不能把「我藏的原生任务栏」赖成孤儿账——code-review 工单50 收口）
    if (hidNative) {
      hidNative = false
      showNativeTaskbar(log, reason)
    }
    // AppBar 注销同理独立于 win 存续（closed 先行时句柄账仍在，归还工作区不赖账）
    stopYieldPoll()
    if (appBarHwnd !== null) {
      removeAppBar(appBarHwnd, log)
      appBarHwnd = null
    }
    if (!win) return
    tracker?.dispose()
    tracker = null
    const w = win
    win = null
    w.destroy()
    log?.append({ type: 'taskbar-window-destroyed', reason })
  }

  const create = () => {
    if (win) return
    // 先隐原生再建窗（工单50）：stripBounds 按视图事实取净空——隐藏成功落屏底，
    // 失败（句柄缺位等）降级让出原生任务栏上沿，49 实证的同矩形 z 序竞争不进场。
    hidNative = hideNativeTaskbar(log)
    try {
      win = createTaskbarWindow()
    } catch (err) {
      // 建窗失败即还账：hidNative 不带出 create（destroy 的还原前提不变式：hidNative ⇒ win 在场）
      if (hidNative) {
        hidNative = false
        showNativeTaskbar(log, 'create-failed')
      }
      throw err
    }
    const w = win
    // 置顶维持（ADR-0007 已知风险）：49 起条带不再与可见的 Shell_TrayWnd 同矩形竞争
    // （那条赛道无解——其层级高于普通 TOPMOST 且 explorer 主动防守）；工单50 隐藏原生
    // 任务栏后竞争面进一步收窄。keepalive 500ms + 热区离开重申只守一般性置顶争夺
    // （其他 always-on-top 窗口、shell 事件扰动）。
    const assertTop = () => {
      if (!w.isDestroyed()) setTopmost(hwndOf(w), true)
    }
    const keepalive = setInterval(assertTop, 500)
    // 工单51 AppBar 工作区占位：注册 → 协商 → 按协商矩形重排窗口（renegotiate 在
    // 控制器作用域，display-metrics 事件同路）。注册失败走 49/50 的净空降级档
    // （不占工作区、不让位）。
    if (registerAppBar(hwndOf(w), stripPhysRect(), log)) {
      appBarHwnd = hwndOf(w)
      renegotiate('create')
      // 系统侧工作区变动（其他 AppBar 增删等）→ 重协商（ABN_POSCHANGED 经回调消息送达）
      w.hookWindowMessage(appBarCallbackMessage(), (wParam) => {
        if (Number(wParam.readUInt32LE(0)) === ABN_POSCHANGED) renegotiate('abn-poschanged')
      })
      // 全屏让位轮询（仅 AppBar 生效档）：前台全屏即 hide，退出即 showInactive 复位顶
      yieldTimer = setInterval(() => {
        if (w.isDestroyed()) return
        const hit = shouldYieldToFullscreen(probeForegroundWindow(), primaryPhysRect(), process.pid)
        if (hit && !yielded) {
          yielded = true
          w.hide()
          log?.append({ type: 'taskbar-yield' })
        } else if (!hit && yielded) {
          yielded = false
          w.showInactive()
          assertTop()
          log?.append({ type: 'taskbar-yield-lifted' })
        }
      }, YIELD_POLL_MS)
    }
    // 热区离开重申置顶：热区交互（点击）会顶起 z 序归属变化（探针01-C 同机制），
    // 面板离开重钉底，任务栏离开重置顶——两窗语义相反。
    tracker = new HotzoneTracker(w, {
      onLeave: () => {
        if (!w.isDestroyed() && setTopmost(hwndOf(w), true)) {
          log?.append({ type: 'taskbar-topmost', reason: 'hotzone-leave' })
        }
      },
      onTransition: (hot) => log?.append({ type: hot ? 'taskbar-hotzone-enter' : 'taskbar-hotzone-leave' }),
    })
    // 任务栏窗只收自己关心的事件（面板事件不进条带渲染层）：
    // changed = 启停/勾选状态；status = 右组 1Hz 时钟 + 硬件仪表帧（工单55）
    wireBridgeIpc(w, ctx.bridge, ['taskbar/changed', 'taskbar/status'])
    wireHostIpc(w, tracker, log, { pin: (v) => { setTopmost(hwndOf(v), true) } })
    w.once('ready-to-show', () => {
      w.showInactive()
      assertTop()
    })
    w.once('closed', () => {
      clearInterval(keepalive)
      // 外部先销窗（非 destroy 路径）：AppBar/让位账在此归还，不留孤儿占位
      stopYieldPoll()
      if (appBarHwnd !== null) {
        removeAppBar(appBarHwnd, log)
        appBarHwnd = null
      }
      tracker?.dispose()
      tracker = null
      win = null
    })
    void w.loadURL(taskbarUrl())
    log?.append({ type: 'taskbar-window-created' })
  }

  // 主屏几何变化（换分辨率/DPI/换主屏）即重排条带；窗口不在场（禁用态）无事可做。
  // AppBar 生效档走重协商（占位与栏同矩形重算），降级档维持净空几何重排。
  const onDisplayMetrics = () => {
    if (!win || win.isDestroyed()) return
    if (appBarHwnd !== null) renegotiate('display-metrics-changed')
    else win.setBounds(stripBounds())
  }

  if (ctx.taskbar.state().enabled) create()
  const offChanged = ctx.on('taskbar/changed', (state: TaskbarState) => {
    if (state.enabled) create()
    else destroy('disabled')
  })
  screen.on('display-metrics-changed', onDisplayMetrics)

  return {
    dispose() {
      screen.removeListener('display-metrics-changed', onDisplayMetrics)
      offChanged()
      destroy('dispose')
    },
  }
}
