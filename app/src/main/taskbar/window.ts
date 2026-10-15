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
import { hideNativeTaskbar, menuWindowCountByPids, nativeTaskbarVisible, pidOfWindow, showNativeTaskbar } from './native'
import { ABN_POSCHANGED, appBarCallbackMessage, negotiateAppBarPos, registerAppBar, removeAppBar } from './appbar'
import type { AppBarRect } from './appbar'
import { probeForegroundWindow, shouldYieldToFullscreen } from './yield'
import { TrayYieldMachine, TRAY_YIELD_POLL_MS } from './tray-yield'
import type { TrayYieldDecision, TrayYieldRestoreReason } from './tray-yield'
import { startTrayOverflowHost } from './overflow'
import { startAppMenuHost } from './app-menu'
import type { PhysRect } from './yield'

/** 任务栏窗口标题：验收控制器按 pid + 标题寻窗（TRAY_SPIKE_TITLE 先例） */
export const TASKBAR_TITLE = 'DECK-TASKBAR'
/** 条带高度（DIP，工单158 起 64：栏高与图标尺寸升档——48px 条带配 22px 应用图标
 * 的观感小于原生任务栏，升档后应用图标 32px/托盘 24px；几何手改口属后续票） */
export const TASKBAR_HEIGHT = 64
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
function createTaskbarWindow(log: EventLog | null): BrowserWindow {
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
  // 渲染层自诊断（真机实证的教训：条带渲染层静默不执行时，电池只会报「存证缺失」，
  // 主进程侧一切正常，无从分辨是没跑还是跑崩了——把渲染层错误与加载失败落进事件流）
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) log?.append({ type: 'taskbar-renderer-console', level, message, line, sourceId })
  })
  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    log?.append({ type: 'taskbar-load-failed', code, description, url })
  })
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    log?.append({ type: 'taskbar-preload-error', preloadPath, message: error.message })
  })
  return win
}

export interface TaskbarController {
  dispose(): void
}

/**
 * 一扇条带窗的全部账（#103 缺陷①按窗记账）：keepalive/让位轮询/AppBar 句柄/热区
 * 跟踪器都随窗生灭。控制器的正确性不再依赖「closed 恰好在下一窗建立前落地」的
 * 时序巧合——迟到旧窗的 closed 只清自家定时器，共享账只在仍是现任时清。
 */
interface TaskbarSession {
  win: BrowserWindow
  tracker: HotzoneTracker | null
  appBarHwnd: number | null
  yieldTimer: NodeJS.Timeout | null
  yielded: boolean
  keepalive: NodeJS.Timeout
  /** 最近一次协商落定的 DIP 目标几何（工单158 回正守卫用；未协商过 = null） */
  negotiated: { x: number; y: number; width: number; height: number } | null
}

/**
 * 任务栏窗口控制器：跟随 TaskbarService 状态建/销窗口（启用即建、禁用即销）。
 * 与面板的 z 序纪律相反：面板钉底，本窗置顶——热区离开即重申置顶（ADR-0007 残余
 * 风险：z 序竞争需定时/事件驱动维持置顶）。
 */
export function startTaskbarController(options: { ctx: Context; log: EventLog | null }): TaskbarController {
  const { ctx, log } = options
  let session: TaskbarSession | null = null
  // 原生任务栏显隐账（工单50）：只还原「本次由我隐藏」的那次；隐藏失败/本已隐藏
  // 则无还原义务（死路径兜底由守卫与还原守护以视图事实补足）。控制器级——原生栏
  // 显隐与哪扇条带窗现任无关。
  let hidNative = false

  // —— 托盘右键让位闸门（工单194，ADR-0013「托盘自带菜单让位」）——
  // 条带是 WS_EX_TOPMOST 带且有 500ms keepalive、热区离开重申、全屏让位恢复拍三处
  // 置顶重申点，应用右键弹的菜单（#32768 或自绘面板）诞生在普通带、重叠区压不过。
  // 回放右键期间条带临时降非置顶；「菜单已关闭」三路侦测（目标 pid 菜单窗消失 /
  // 前台窗变化 / 超时上限）任一命中即恢复。闸门形态仿桌面遮罩的钉扎闸门先例
  // （win32.setPinGate）：置位期间全部置顶重申点跳过重申并落存证——被自家重申点
  // 抢回置顶等于修复白做。裁决在 tray-yield 纯状态机（单测钉），本层只做 FFI 采集
  // 与置顶动作；native 菜单 z 序真机人工验收留证（事件时序存证为主，票面口径）。
  let trayYield: { machine: TrayYieldMachine; timer: NodeJS.Timeout } | null = null

  /** 让位中再次右键（换图标）：换监视 pid 续时限（machine 语义），条带已在普通带不动 */
  const beginTrayYield = (payload: { key: string; hwnd: string | null }): void => {
    const s = session
    if (!s || s.win.isDestroyed()) return // 条带不在场（禁用态）：无可让位，回放照常
    const hwnd = payload.hwnd ? Number(payload.hwnd) : 0
    const pid = hwnd ? pidOfWindow(hwnd) : 0
    let fgPid = 0
    try {
      fgPid = probeForegroundWindow()?.pid ?? 0
    } catch { /* 前台不可判按无前台处理（恢复是安全方向，与 yield.ts 同纪律） */ }
    const machine = trayYield?.machine ?? new TrayYieldMachine()
    const mode = machine.begin(pid, fgPid, process.pid, Date.now())
    if (mode === 'yield') {
      // 降非置顶走 Electron 自家 API：内部 alwaysOnTop 账同步翻转，hide/show 等
      // 内部路径不会把 TOPMOST 位写回（FFI 直翻样式位会留下「Electron 以为还置顶」
      // 的分叉账）。NOTOPMOST 把条带放到普通带顶，菜单此后才诞生、必在其上。
      s.win.setAlwaysOnTop(false)
    }
    if (!trayYield) trayYield = { machine, timer: setInterval(() => pollTrayYield(), TRAY_YIELD_POLL_MS) }
    log?.append({ type: 'taskbar-tray-yield', key: payload.key, pid, fgPid, mode })
  }

  /** 一拍侦测：FFI 采集（目标 pid 菜单窗数 + 前台属主）喂状态机，restore 即收闸回顶 */
  const pollTrayYield = (): void => {
    const ty = trayYield
    if (!ty) return
    const s = session
    if (!s || s.win.isDestroyed()) {
      endTrayYield('session-gone', null)
      return
    }
    const pid = ty.machine.pid
    let menuCount = 0
    if (pid) {
      try {
        menuCount = menuWindowCountByPids([pid]).get(pid) ?? 0
      } catch { /* 枚举失败按「菜单不在场」继续——三路侦测不因单拍 FFI 抖动翻脸 */ }
    }
    let fgPid = 0
    try {
      fgPid = probeForegroundWindow()?.pid ?? 0
    } catch { /* 同上：本拍放弃前台证据 */ }
    let decision: TrayYieldDecision
    try {
      decision = ty.machine.poll({ menuCount, fgPid, now: Date.now() })
    } catch {
      return // 状态机不抛；防御性收口不把侦测拍变崩点
    }
    if (decision.action === 'restore') endTrayYield(decision.reason, decision)
  }

  /** 收闸回顶（三路命中 / teardown）：回置顶带 + 存证（时序可审计的落点） */
  const endTrayYield = (reason: TrayYieldRestoreReason | 'session-gone', decision: TrayYieldDecision | null): void => {
    const ty = trayYield
    if (!ty) return
    trayYield = null
    clearInterval(ty.timer)
    const s = session
    if (s && !s.win.isDestroyed()) {
      try {
        s.win.setAlwaysOnTop(true)
      } catch { /* 尽力回顶：窗销毁竞态下一条 destroy 路径收尾 */ }
    }
    log?.append({
      type: 'taskbar-tray-yield-restored',
      reason,
      pid: ty.machine.pid,
      menuSeen: ty.machine.menuSeen,
      elapsedMs: decision && decision.action === 'restore' ? decision.elapsedMs : null,
    })
  }

  // 托盘溢出菜单浮层（工单162）：载体裁定 = 独立浮层窗（见模块头注释）。随本控制器
  // 生灭——条带销毁（禁用/退役）即收层；全屏让位即收层。
  const trayOverflow = startTrayOverflowHost({ ctx, log })
  // 应用组图标右键菜单浮层（工单193）：同一通用载体（popup.ts）的首个新菜单面，生灭
  // 与让位纪律同托盘溢出浮层。
  const appMenuPopup = startAppMenuHost({ ctx, log })

  // 托盘宿主启停（#153 交还链路）：随条带生灭——启用即起（收编）、禁用即停（拆竞争窗
  // + 广播 TaskbarCreated 交还真托盘）。panel-kernel replayTrayClick 同款鸭子类型直调
  // （不上 PanelDataPort：本地装配无宿主概念，缺席即静默跳过）。
  const setTray = (on: boolean) => {
    try {
      (ctx.panelData as { setTrayActive?: (on: boolean) => boolean } | undefined)?.setTrayActive?.(on)
    } catch { /* 数据面不在场（离线装配）：链路无从谈起 */ }
  }

  const stopYieldPoll = (s: TaskbarSession) => {
    if (s.yieldTimer) clearInterval(s.yieldTimer)
    s.yieldTimer = null
    s.yielded = false
  }

  /** 协商矩形（物理）→ 条带窗 DIP 几何（差异 >1 DIP 才动，避免与系统微调来回震荡） */
  const applyNegotiated = (s: TaskbarSession, rc: AppBarRect) => {
    if (s.win.isDestroyed()) return
    const dip = screen.screenToDipRect(s.win, { x: rc.left, y: rc.top, width: rc.right - rc.left, height: rc.bottom - rc.top })
    s.negotiated = dip
    const cur = s.win.getBounds()
    if (Math.abs(dip.x - cur.x) > 1 || Math.abs(dip.y - cur.y) > 1
      || Math.abs(dip.width - cur.width) > 1 || Math.abs(dip.height - cur.height) > 1) {
      s.win.setBounds(dip)
    }
  }

  /** 几何回正守卫（工单158 真机取证修）：壳侧 AppBar 通路会在 ABM_SETPOS 与
   * showInactive 之后异步把条带窗挪到「协商带上移一身高」的位置（64 高真机取证：
   * 目标 [1376,1440] 反复被挪 [1312,1376]，协商 rc 始终正确、挪的是窗口本体）。
   * 48 时代带位 [1392,1440] 与原生任务栏旧带重合、净零工作区变更，壳侧不扰动，
   * 缺陷潜伏未暴露——升档 64 后带位错开才显形。三个协商入口（create/ABN_POSCHANGED/
   * display-metrics-changed）都赶在挪移拍之前，最后一拍纠正追不上 show 拍的挪移；
   * keepalive 500ms 与 ready-to-show 即拍各补一记回正（取证：挪移一触发一拍、纠正
   * 后不复发，回正恒获最后一语）。回正事件落 taskbar-geometry-reasserted 存证。 */
  const reassertGeometry = (s: TaskbarSession, reason: string) => {
    if (!s.negotiated || s.win.isDestroyed()) return
    const cur = s.win.getBounds()
    const t = s.negotiated
    if (Math.abs(cur.x - t.x) > 1 || Math.abs(cur.y - t.y) > 1
      || Math.abs(cur.width - t.width) > 1 || Math.abs(cur.height - t.height) > 1) {
      s.win.setBounds(t)
      log?.append({ type: 'taskbar-geometry-reasserted', reason, from: cur, to: t })
    }
  }

  /** 占位重协商（建窗后初次、ABN_POSCHANGED、display-metrics-changed 三入口同路）；
   * 只作用于现任 session 的占位账。 */
  const renegotiate = (reason: string) => {
    const s = session
    if (!s || s.appBarHwnd === null || s.win.isDestroyed()) return
    applyNegotiated(s, negotiateAppBarPos(s.appBarHwnd, stripPhysRect(), log, reason))
  }

  const destroy = (reason: string) => {
    // 还原先于会话判空：hidNative 账独立于窗存续（窗被外部先销/建窗半途抛错
    // 都不能把「我藏的原生任务栏」赖成孤儿账——code-review 工单50 收口）
    if (hidNative) {
      hidNative = false
      showNativeTaskbar(log, reason)
    }
    // 托盘让位闸门随控制器收摊（工单194）：侦测定时器随窗灭，不让位账悬空
    endTrayYield('session-gone', null)
    const s = session
    session = null
    if (!s) return
    // 会话全账就地清（keepalive 不再依赖 closed 收尾）：先摘控制器引用再动手，
    // closed 无论同步落地还是迟到，撞见的都是「已退位的会话」。
    stopYieldPoll(s)
    if (s.appBarHwnd !== null) removeAppBar(s.appBarHwnd, log)
    clearInterval(s.keepalive)
    s.tracker?.dispose()
    trayOverflow.dispose() // 条带销毁即收浮层（禁用/退役路径都在此收敛，工单162）
    appMenuPopup.dispose() // 应用组菜单浮层同行（工单193）
    s.win.destroy()
    log?.append({ type: 'taskbar-window-destroyed', reason })
  }

  const create = () => {
    if (session) return
    // 宿主先起（#153）：收编广播尽早落地，图标随条带就位（boot 启用态由 init 先建，
    // 此处幂等 no-op）
    setTray(true)
    // 先隐原生再建窗（工单50）：stripBounds 按视图事实取净空——隐藏成功落屏底，
    // 失败（句柄缺位等）降级让出原生任务栏上沿，49 实证的同矩形 z 序竞争不进场。
    hidNative = hideNativeTaskbar(log)
    let w: BrowserWindow
    try {
      w = createTaskbarWindow(log)
    } catch (err) {
      // 建窗失败即还账：hidNative 不带出 create（destroy 的还原前提不变式：hidNative ⇒ 有会话）
      if (hidNative) {
        hidNative = false
        showNativeTaskbar(log, 'create-failed')
      }
      throw err
    }
    // 置顶维持（ADR-0007 已知风险）：49 起条带不再与可见的 Shell_TrayWnd 同矩形竞争
    // （那条赛道无解——其层级高于普通 TOPMOST 且 explorer 主动防守）；工单50 隐藏原生
    // 任务栏后竞争面进一步收窄。keepalive 500ms + 热区离开重申只守一般性置顶争夺
    // （其他 always-on-top 窗口、shell 事件扰动）。
    // 托盘让位闸门（工单194）：置位期间重申一律跳过并落存证——重申点把条带抢回
    // 置顶带，应用菜单就又被压回条带之下，修复等于白做（票面验收第二条款）。
    const assertTop = (reason: string) => {
      if (trayYield) {
        log?.append({ type: 'taskbar-topmost-suppressed', reason })
        return
      }
      if (!w.isDestroyed()) setTopmost(hwndOf(w), true)
    }
    const s: TaskbarSession = {
      win: w,
      tracker: null,
      appBarHwnd: null,
      yieldTimer: null,
      yielded: false,
      negotiated: null,
      keepalive: null as unknown as NodeJS.Timeout,
    }
    session = s
    // 置顶维持 + 几何回正（工单158 起同一拍：置顶重申与协商带回正都是壳侧扰动兜底）
    s.keepalive = setInterval(() => {
      if (w.isDestroyed()) return
      assertTop('keepalive')
      reassertGeometry(s, 'keepalive')
    }, 500)
    // 工单51 AppBar 工作区占位：注册 → 协商 → 按协商矩形重排窗口（renegotiate 在
    // 控制器作用域，display-metrics 事件同路）。注册失败走 49/50 的净空降级档
    // （不占工作区、不让位）。
    if (registerAppBar(hwndOf(w), stripPhysRect(), log)) {
      s.appBarHwnd = hwndOf(w)
      renegotiate('create')
      // 系统侧工作区变动（其他 AppBar 增删等）→ 重协商（ABN_POSCHANGED 经回调消息送达）
      w.hookWindowMessage(appBarCallbackMessage(), (wParam) => {
        if (Number(wParam.readUInt32LE(0)) === ABN_POSCHANGED) renegotiate('abn-poschanged')
      })
      // 全屏让位轮询（仅 AppBar 生效档）：前台全屏即 hide，退出即 showInactive 复位顶
      // （复位顶同样吃让位闸门——全屏恢复拍是票面点名的第三处重申点）
      s.yieldTimer = setInterval(() => {
        if (w.isDestroyed()) return
        const hit = shouldYieldToFullscreen(probeForegroundWindow(), primaryPhysRect(), process.pid)
        if (hit && !s.yielded) {
          s.yielded = true
          trayOverflow.close('yield') // 全屏让位：浮层不悬置在已隐藏的条带之上（工单162）
          appMenuPopup.close('yield') // 应用组菜单浮层同让位（工单193）
          w.hide()
          log?.append({ type: 'taskbar-yield' })
        } else if (!hit && s.yielded) {
          s.yielded = false
          w.showInactive()
          assertTop('fullscreen-yield-lifted')
          log?.append({ type: 'taskbar-yield-lifted' })
        }
      }, YIELD_POLL_MS)
    }
    // 热区离开重申置顶：热区交互（点击）会顶起 z 序归属变化（探针01-C 同机制），
    // 面板离开重钉底，任务栏离开重置顶——两窗语义相反。让位闸门置位期间跳过
    // （工单194：菜单就铺在条带热区上，鼠标划过菜单/热区边缘的离开拍不许抢回置顶）。
    s.tracker = new HotzoneTracker(w, {
      onLeave: () => {
        if (trayYield) {
          log?.append({ type: 'taskbar-topmost-suppressed', reason: 'hotzone-leave' })
          return
        }
        if (!w.isDestroyed() && setTopmost(hwndOf(w), true)) {
          log?.append({ type: 'taskbar-topmost', reason: 'hotzone-leave' })
        }
      },
      onTransition: (hot) => log?.append({ type: hot ? 'taskbar-hotzone-enter' : 'taskbar-hotzone-leave' }),
    })
    // 任务栏窗只收自己关心的事件（面板事件不进条带渲染层）：
    // changed = 启停/勾选状态；status = 右组 1Hz 时钟 + 硬件仪表帧（工单55）
    wireBridgeIpc(w, ctx.bridge, ['taskbar/changed', 'taskbar/status'])
    wireHostIpc(w, s.tracker, log, {
      // 键盘模式 pin（条带渲染层常态不发，防御性同闸）：让位期间不重申置顶
      pin: (v) => {
        if (trayYield) {
          log?.append({ type: 'taskbar-topmost-suppressed', reason: 'keyboard-pin' })
          return
        }
        setTopmost(hwndOf(v), true)
      },
      onNotify: (type, payload) => {
        // 「⋯」开层/条带点击收层请求（工单162）+ 应用组菜单开层/收层请求（工单193）——
        // 各宿主包装层只认自家 notify 名，域外类型静默跳过
        trayOverflow.onStripNotify(type, payload)
        appMenuPopup.onStripNotify(type, payload)
      },
    })
    w.once('ready-to-show', () => {
      w.showInactive()
      assertTop('shown')
      // show 拍挪移的即拍回正（工单158）：取证显示 showInactive 会触发壳侧把窗挪到
      // 协商带上方，等 keepalive 首拍最多闪 500ms——此处同步补一记
      reassertGeometry(s, 'shown')
    })
    w.once('closed', () => {
      // 自家定时器无条件清（destroy 路径已清过也无害）：keepalive 属本闭包，
      // 即便本会话已退位也不能让 interval 悬空漏掉。
      clearInterval(s.keepalive)
      // 身份校验（#103 缺陷①）：destroy() 路径摘除 session 在先、closed 落地在后
      // （或同步），此处 session 已不指向本会话；外部先销窗（close 管线）时本会话
      // 仍是现任——AppBar/让位账在此归还，不留孤儿占位。迟到的旧窗 closed 永远
      // 撞不上现任共享账，新窗的占位/热区/让位轮询不被动。
      if (session !== s) return
      stopYieldPoll(s)
      // 外部先销窗路径（close 管线）：让位侦测一并收摊（destroy 路径已在先清过也无害）
      endTrayYield('session-gone', null)
      if (s.appBarHwnd !== null) {
        removeAppBar(s.appBarHwnd, log)
        s.appBarHwnd = null
      }
      s.tracker?.dispose()
      s.tracker = null
      session = null
    })
    void w.loadURL(taskbarUrl())
    log?.append({ type: 'taskbar-window-created' })
  }

  // 主屏几何变化（换分辨率/DPI/换主屏）即重排条带；窗口不在场（禁用态）无事可做。
  // AppBar 生效档走重协商（占位与栏同矩形重算），降级档维持净空几何重排。
  const onDisplayMetrics = () => {
    const s = session
    if (!s || s.win.isDestroyed()) return
    if (s.appBarHwnd !== null) renegotiate('display-metrics-changed')
    else s.win.setBounds(stripBounds())
  }

  if (ctx.taskbar.state().enabled) create()
  const offChanged = ctx.on('taskbar/changed', (state: TaskbarState) => {
    if (state.enabled) create()
    else {
      // 禁用三件套的交还环（#153）：先发宿主停（广播落地时条带可能仍在场，图标无缝
      // 回注册 explorer），随即销条带、还原原生栏。dispose（应用退出）不走这里——
      // 退出侧交还广播已被 ADR-0012 否决，强杀路径本就走不到钩子。
      setTray(false)
      destroy('disabled')
    }
  })
  // 托盘右键让位起拍（工单194）：TaskbarService.trayClick 在转发回放前同步发出，
  // 本控制器同轮内先降置顶、后见菜单诞生（z 序正确性赖此顺序，见 trayClick 注）
  const offTrayBegin = ctx.on('taskbar/tray-replay-begin', beginTrayYield)
  screen.on('display-metrics-changed', onDisplayMetrics)

  return {
    dispose() {
      screen.removeListener('display-metrics-changed', onDisplayMetrics)
      offChanged()
      offTrayBegin()
      destroy('dispose')
    },
  }
}
