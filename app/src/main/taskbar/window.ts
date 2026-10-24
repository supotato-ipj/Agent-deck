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
import { hideNativeTaskbar, menuWindowCountByPids, nativeTaskbarView, nativeTaskbarVisible, pidOfWindow, showNativeTaskbar } from './native'
import { ABN_POSCHANGED, appBarCallbackMessage, getAppBarState, negotiateAppBarPos, registerAppBar, removeAppBar } from './appbar'
import type { AppBarRect } from './appbar'
import { engageRetractAutoHide, reassertRetractAutoHide, restoreRetractAutoHide } from './appbar-autohide'
import { probeForegroundWindow } from './yield'
import { ABS_AUTOHIDE, planBarTransition, resolveBarMode } from './retract'
import type { BarMode } from './retract'
import { NATIVE_WATCH_POLL_MS, NativeReassertMachine } from './native-watch'
import type { NativeWatchProbe } from './native-watch'
import { TrayYieldMachine, TRAY_YIELD_POLL_MS } from './tray-yield'
import type { TrayYieldDecision, TrayYieldRestoreReason } from './tray-yield'
import { startTrayOverflowHost } from './overflow'
import { startAppMenuHost } from './app-menu'
import { startRecMenuHost } from './rec-menu'
import { startBlankMenuHost } from './blank-menu'
import { startTierMenuHost } from './tier-menu'
import { startWinsMenuHost } from './wins-menu'
import type { MenuHost } from './menu-host'
import type { ForegroundProbe, PhysRect } from './yield'

/** 任务栏窗口标题：验收控制器按 pid + 标题寻窗（TRAY_SPIKE_TITLE 先例） */
export const TASKBAR_TITLE = 'DECK-TASKBAR'
/** 条带高度（DIP，工单238 回归 48：栏高 64 是工单158 从 48 升上来的——配 32px 应用图标
 * 升档，本票随新排版回归 Win11 原生 48（spec #236 用户故事 1/2）。该常量是条带窗几何
 * （stripBounds）、AppBar 提议矩形（stripPhysRect）的单点来源——改这一处两者同落 48 */
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
  /**
   * 当前三态档位（工单241）：visible = 栏面常驻；maximize-retract = 最大化收栏
   * （占位已释放、栏面退场、唤出条在场）；fullscreen-yield = 全屏让位（整窗退场）。
   * 裁决归纯函数 resolveBarMode（shared/retract），本层只执行动作。
   */
  mode: BarMode
  /**
   * 原生栏重申轮询账（工单262，spec #258）：收栏态期间低频轮询（1s 拍）检测
   * Shell_TrayWnd 重建（explorer 重启/热插拔）或可见性翻转/置位丢失，命中即重挂
   * SW_HIDE 与 ABS_AUTOHIDE 置位（与「发现可见即再压」同一只轮询，不做键盘拦截）。
   * 非收栏态停表休止——起/停随三态迁移（applyBarMode），裁决归纯机器
   * native-watch.ts 的 NativeReassertMachine。
   */
  nativeWatch: { machine: NativeReassertMachine; timer: NodeJS.Timeout } | null
  /**
   * 降级档标记（AppBar 注册失败）——降级档下收栏整体禁用（与全屏让位同待遇）：
   * 没有占位就没有「释放占位」这回事，且降级档下最大化窗本就覆盖全屏。
   */
  appBarDegraded: boolean
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
  // 其余四菜单面浮层（工单196，ADR-0013 全家迁通路）：推荐条目三行（rec）、空白右键
  // （blank：系统按钮显隐+恢复段）、托盘档位（tier）、多窗选窗列表（wins）——生灭与
  // 让位纪律同上（每面一枚宿主各持一扇常驻浮层窗，惰性建）。
  const recMenuPopup = startRecMenuHost({ ctx, log })
  const blankMenuPopup = startBlankMenuHost({ ctx, log })
  const tierMenuPopup = startTierMenuHost({ ctx, log })
  const winsMenuPopup = startWinsMenuHost({ ctx, log })
  // 六浮层宿主清单（spec188 评审收口）：dispose 清算与全屏让位收层两处收成单遍历——
  // 新增菜单面只在清单追加一行，不再两处平行展开防漏。onNotify 转发扇形不在此列
  // （0301676 接缝教训定的 canonical 形态：各宿主在箭头体内并列追加自家 onStripNotify）。
  const popupHosts: ReadonlyArray<MenuHost> = [
    trayOverflow, appMenuPopup, recMenuPopup, blankMenuPopup, tierMenuPopup, winsMenuPopup,
  ]

  /**
   * 自家自绘浮层在场的家族集合（工单253）。
   *
   * 六面浮层开层即取前台（focusable: true + show 取焦——blur 收「点面板外」的前提）⇒
   * 主进程的前景探针看到的是**自家进程** ⇒ 档位裁决按「自家进程」这一族处理。若一律
   * 判 visible，收栏档会被浮层开层当场翻掉：栏面复现、唤出态被工单249 的 F1 同拍清空
   * ⇒「浮层在场只钉住所属组、离场不塌」（spec #236 用户故事 21）在真机上不可观测
   * （存证实测：taskbar-tier-menu-opened → taskbar-retract-lifted 仅隔 99ms）。
   *
   * 在场事实取载体的开合事件（taskbar/popup-state——六面同一通道、载体是唯一收口）：
   * 裁决据此把「自家浮层夺前台」（档位保持）与「面板本体被点成前台」（仍判 visible，
   * 既有语义不变）分清。
   */
  const openOverlayFamilies = new Set<string>()
  const offPopupState = ctx.on('taskbar/popup-state', (p) => {
    if (p.open) openOverlayFamilies.add(p.family)
    else openOverlayFamilies.delete(p.family)
  })

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
    s.mode = 'visible' // 档位归零（窗在场期间的状态切换——会话账随窗生灭，不另立一套）
  }

  /** 原生栏一拍观察采齐（工单262）：句柄/可见性走 native.ts 单一来源，置位走读回事实。
   *  窗口缺位拍跳过状态读——机器不读该字段，也不对死亡/重启中的 shell 发状态查询
   *  （51 电池 P10 实测：对新起 explorer 的 SHAppBarMessage 阻塞秒级，间隙拍白等）。 */
  const nativeWatchProbe = (): NativeWatchProbe => {
    const view = nativeTaskbarView()
    if (view.hwnd === 0) return { ...view, autoHideOn: undefined }
    return { ...view, autoHideOn: (getAppBarState() & ABS_AUTOHIDE) !== 0 }
  }

  /**
   * 原生栏重申轮询一拍（工单262）：观察喂机器、照单执行重挂、归因落存证。
   * 休止后残留拍不动作（档位守门——stopNativeWatch 已清 interval，此处兜底竞态）。
   */
  const pollNativeWatch = (): void => {
    const s = session
    if (!s || s.win.isDestroyed() || s.mode !== 'maximize-retract') return
    const probe = nativeWatchProbe()
    const decision = s.nativeWatch?.machine.poll(probe)
    if (!decision || decision.action === 'none') return
    if (decision.hide) hideNativeTaskbar(log)
    if (decision.engage) reassertRetractAutoHide(log)
    log?.append({
      type: 'taskbar-native-reassert',
      reason: decision.reason,
      hwnd: probe.hwnd,
      visible: probe.visible,
      autoHideOn: probe.autoHideOn,
    })
  }

  /** 起表（进收栏）：以「刚置位过的当拍事实」立基线——首拍不误报重建/翻转 */
  const startNativeWatch = (s: TaskbarSession): void => {
    if (s.nativeWatch) return // 已在场（幂等——迁移执行器只在档位变更时调）
    const machine = new NativeReassertMachine()
    machine.begin(nativeWatchProbe())
    const timer = setInterval(pollNativeWatch, NATIVE_WATCH_POLL_MS)
    s.nativeWatch = { machine, timer }
  }

  /** 停表（离收栏/拆场）：清 interval + 机器回未武装态（非收栏态轮询休止） */
  const stopNativeWatch = (s: TaskbarSession): void => {
    if (!s.nativeWatch) return
    clearInterval(s.nativeWatch.timer)
    s.nativeWatch.machine.reset()
    s.nativeWatch = null
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

  /**
   * 置顶重申（ADR-0007 已知风险 + 工单194 托盘让位闸门）：条带是 WS_EX_TOPMOST 带，
   * 置顶重申有三处（500ms keepalive、热区离开、全屏让位恢复拍）——重申点把条带抢回
   * 置顶带，应用右键菜单就又被压回条带之下，修复等于白做（工单194 票面验收第二条款）。
   * → 闸门置位期间一律跳过并落存证。
   *
   * **收栏态不改这条**（工单241）：收栏态条带窗仍须压在最大化窗之上（唤出条贴屏底、
   * 可见、可点），置顶重申与收栏共存。收栏**不另起第二套置顶抑制机制**——两套抑制
   * 互踩会让 z 序断言 flaky（票面取证第 2 条）。
   */
  const assertTop = (s: TaskbarSession, reason: string): void => {
    if (trayYield) {
      log?.append({ type: 'taskbar-topmost-suppressed', reason })
      return
    }
    if (!s.win.isDestroyed()) setTopmost(hwndOf(s.win), true)
  }

  /**
   * 三态迁移的执行器（工单241）：**档位裁决归纯函数**（resolveBarMode 判档、
   * planBarTransition 判动作），本函数只做效果层动作——浮层收拢 / 工作区占位注销与
   * 重注册 / 整窗显隐 / 档位下发 / 存证。
   *
   * 收栏（maximize-retract，栏给窗让位）：
   * - 注销 AppBar → **我方那份**占位登记释放；
   *   ⚠️ 工单250 实测更正：系统工作区**不随之变化**——原生任务栏那 48px 保留带由 shell
   *   自算、不在 AppBar 登记表里（对原生 Shell_TrayWnd 发 ABM_REMOVE/空矩形 ABM_SETPOS
   *   均无效）⇒ 最大化窗底边仍停在 1392，「铺满整屏」在本机不发生（产品级缺口，见
   *   docs/audit/2026-10-23-t250-native-taskbar-reserved-band.md）。
   * - 自绘浮层一律关闭（不留无锚孤儿浮层，用户故事 29）；
   * - 条带窗**不隐藏**（承载形态 = 栏窗复用，工单241 修正 E3 裁决）：唤出条贴屏底、
   *   在最大化窗之上、命中区可点；弹出的组就落在同一条 48px 带内 → **不改变最大化窗尺寸**
   *   （占位已随收栏释放，弹组不重注册占位）；
   * - 档位下发给渲染层：栏面（各组 pill）退场，唤出条由工单242 在同一条带内画。
   *
   * 恢复（回 visible）：重注册 AppBar → 重协商 → 占位恢复（最大化窗回缩 48px——
   * 平台惯常过渡，spec 用户故事 25 明示接受）。
   */
  const applyBarMode = (s: TaskbarSession, next: BarMode, probe: ForegroundProbe | null): void => {
    const prev = s.mode
    if (prev === next) return
    const plan = planBarTransition(prev, next)
    s.mode = next
    const w = s.win
    const reason = prev === 'maximize-retract' ? 'retract-lifted'
      : prev === 'fullscreen-yield' ? 'fullscreen-yield-lifted'
        : next === 'maximize-retract' ? 'retract'
          : next === 'fullscreen-yield' ? 'fullscreen-yield'
            : 'bar-mode'
    // ① 浮层收拢：单遍历清单（popupHosts 六面自绘浮层的唯一登记处）——与全屏让位同口径
    if (plan.closePopups) for (const h of popupHosts) h.close('yield')
    // ② 工作区占位：收栏释放（注销 AppBar）；其余态占位必须生效（已占位空转，未占位则重注册 + 重协商）
    let appBar: 'removed' | 'registered' | 'register-failed' | 'kept' = 'kept'
    if (plan.releaseAppBar && s.appBarHwnd !== null) {
      removeAppBar(s.appBarHwnd, log)
      s.appBarHwnd = null
      appBar = 'removed'
    } else if (plan.claimAppBar && s.appBarHwnd === null) {
      if (s.appBarDegraded) {
        appBar = 'kept' // 降级档：注册失败过一次不再重试（收栏整体禁用，与让位同待遇）
      } else if (registerAppBar(hwndOf(w), stripPhysRect(), log)) {
        s.appBarHwnd = hwndOf(w)
        // 重协商：占位矩形重算（释放态下的协商矩形不是条带矩形——先注册再协商，
        // 不在「未注册」态协商，避免把整屏当条带矩形写回窗口）
        renegotiate(reason)
        appBar = 'registered'
      } else {
        s.appBarDegraded = true
        appBar = 'register-failed'
      }
    }
    // ②′ 原生栏托管（工单260）：与占位段同拍——进入收栏置位 ABS_AUTOHIDE（shell 由此
    // 释放原生保留带，最大化窗铺满整屏）、退出收栏复原原状态（thide RAII 账在
    // appbar-autohide 模块，与哪扇条带窗现任无关；退避复原不拖住迁移）。
    if (plan.engageAutoHide) engageRetractAutoHide(log)
    if (plan.restoreAutoHide) restoreRetractAutoHide(log, reason)
    // ②′′ 原生栏重申轮询（工单262）：与置位同生命周期——进收栏起表（1s 低频拍，检测
    // Shell_TrayWnd 重建/可见性翻转/置位丢失，命中即重挂 SW_HIDE 与置位；与「发现可见
    // 即再压」同一只轮询，不做键盘拦截），离收栏休止（非收栏态系统行为与现状一致）。
    if (next === 'maximize-retract') startNativeWatch(s)
    else stopNativeWatch(s)
    // ③ 整窗显隐：让位态整窗退场（唤出条也不出现）；收栏态条带窗在场（承载唤出条）
    if (plan.hideWindow) {
      w.hide()
    } else if (plan.showWindow) {
      w.showInactive()
      assertTop(s, reason)
    }
    // ④ 档位下发渲染层（栏面退场/复现）
    ctx.emit('taskbar/bar-mode', { mode: next, reason })
    // ⑤ 存证：模式、旧→新、前台窗身份、AppBar 注销/重注册结果
    const foreground = probe
      ? { hwnd: probe.hwnd, pid: probe.pid, className: probe.className, zoomed: probe.zoomed }
      : null
    for (const type of plan.evidence) log?.append({ type, mode: next, from: prev, foreground, appBar })
  }

  /** 档位下发渲染层（条带渲染层据此让栏面退场/复现；唤出条几何由渲染层自算） */
  const pushBarMode = (s: TaskbarSession, reason: string): void => {
    if (s.win.isDestroyed()) return
    ctx.emit('taskbar/bar-mode', { mode: s.mode, reason })
  }

  const destroy = (reason: string) => {
    // 原生栏重申轮询停表（工单262）：拆场先停观察再动复原账——重申不得在拆场中途再压一笔
    if (session) stopNativeWatch(session)
    // 还原先于会话判空：hidNative 账独立于窗存续（窗被外部先销/建窗半途抛错
    // 都不能把「我藏的原生任务栏」赖成孤儿账——code-review 工单50 收口）
    if (hidNative) {
      hidNative = false
      showNativeTaskbar(log, reason)
    }
    // 原生栏托管复原（工单260，还原路径①）：收栏态下退出（禁用/退役/dispose）也要还
    // appbar 状态账——RAII 账与窗现任无关，退避重试异步推进不拖住销窗；未置位则静默。
    restoreRetractAutoHide(log, reason)
    // 托盘让位闸门随控制器收摊（工单194）：侦测定时器随窗灭，不让位账悬空
    endTrayYield('session-gone', null)
    const s = session
    session = null
    if (!s) return
    // 会话全账就地清（keepalive 不再依赖 closed 收尾）：先摘控制器引用再动手，
    // closed 无论同步落地还是迟到，撞见的都是「已退位的会话」。
    stopYieldPoll(s)
    if (s.appBarHwnd !== null) {
      removeAppBar(s.appBarHwnd, log)
      s.appBarHwnd = null // 账目归零（工单241 顺手理直：注销即清字段，不留陈旧句柄）
    }
    clearInterval(s.keepalive)
    s.tracker?.dispose()
    for (const h of popupHosts) h.dispose() // 条带销毁即收浮层（禁用/退役路径都在此收敛，工单162/193/196）
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
    // 托盘让位闸门（工单194）与三态机（工单241）共用 assertTop 一处闸门。
    const s: TaskbarSession = {
      win: w,
      tracker: null,
      appBarHwnd: null,
      yieldTimer: null,
      mode: 'visible',
      nativeWatch: null,
      appBarDegraded: false,
      negotiated: null,
      keepalive: null as unknown as NodeJS.Timeout,
    }
    session = s
    // 置顶维持 + 几何回正（工单158 起同一拍：置顶重申与协商带回正都是壳侧扰动兜底）
    // 收栏态下这两个动作都不与收栏打架：条带窗几何不变（唤出条贴屏底要靠它），
    // 置顶重申正是唤出条压在最大化窗之上所需（托盘让位闸门仍照旧抑制）。
    s.keepalive = setInterval(() => {
      if (w.isDestroyed()) return
      assertTop(s, 'keepalive')
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
      // 三态轮询（工单241）：与全屏让位共用 250ms 节奏（YIELD_POLL_MS）。档位裁决归
      // 纯函数 resolveBarMode——真最大化优先（→ 收栏档，再受「开关关断」与「降级档禁用」
      // 两道闸门约束），否则矩形覆盖全屏 → 让位档，其余常驻；本层**不自己判两态关系**
      // （工单237 修正 A1/E2：真最大化窗永不落让位档，否则收栏刚生效就被翻掉、唤出条回不来）。
      // 轮询只在 AppBar 注册成功档内：降级档自然「无轮询 ⇒ 无收栏」（与让位同构）。
      s.yieldTimer = setInterval(() => {
        if (w.isDestroyed()) return
        const probe = probeForegroundWindow()
        const mode = resolveBarMode({
          probe,
          screen: primaryPhysRect(),
          ownPid: process.pid,
          retractEnabled: ctx.taskbar.state().maximizeRetract, // 工单239 开关（默认开，关则永不为收栏档）
          appBarDegraded: s.appBarDegraded,
          prevMode: s.mode, // 工单253：自家浮层夺前台时沿用当前档位（不翻收栏档）
          ownOverlayPresent: openOverlayFamilies.size > 0, // 工单253：自家浮层在场（与「面板本体被点」分清）
        })
        applyBarMode(s, mode, probe)
      }, YIELD_POLL_MS)
    } else {
      // 降级档（工单50/51）：注册被拒 → 不占工作区、也让位。收栏整体禁用（同待遇——
      // 没有占位就没有「释放占位」这回事，且降级档下最大化窗本就覆盖全屏）。
      s.appBarDegraded = true
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
      // 工单242 指针对账：热区跟踪器按光标坐标 hit-test 的结论下发条带渲染层——
      // 唤出条的悬停态只认这条事实（不采信浏览器 enter/leave 事件序列，原型振荡教训）
      onZone: (id) => ctx.emit('taskbar/cursor-zone', { id }),
    })
    // 任务栏窗只收自己关心的事件（面板事件不进条带渲染层）：
    // changed = 启停/勾选状态；status = 右组 1Hz 时钟 + 硬件仪表帧（工单55）；
    // bar-mode = 三态下发（工单241：栏面退场/复现——唤出条几何由渲染层自算）；
    // cursor-zone = 光标落在哪个热区（工单242：唤出条指针对账的唯一事实来源）；
    // popup-state = 自绘浮层开合（工单242：浮层在场钉住所属组）
    wireBridgeIpc(w, ctx.bridge, ['taskbar/changed', 'taskbar/status', 'taskbar/bar-mode', 'taskbar/cursor-zone', 'taskbar/popup-state'])
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
        // 渲染层就绪握手（工单241）：条带页加载期可能错过早先的档位下发（订阅晚于首推）
        // ——收到 taskbar-ready 即补发当前档位，渲染层据此对齐栏面显隐。
        if (type === 'taskbar-ready') pushBarMode(s, 'ready')
        // 「⋯」开层/条带点击收层请求（工单162）+ 应用组菜单开层/收层请求（工单193）+
        // 其余四菜单面开层/收层请求（工单196）——各宿主包装层只认自家 notify 名，
        // 域外类型静默跳过（双宿主转发箭头形态：新宿主在箭头体内并列追加一行自家
        // onStripNotify，勿写回单转发赋值形态——0301676 接缝教训）
        trayOverflow.onStripNotify(type, payload)
        appMenuPopup.onStripNotify(type, payload)
        recMenuPopup.onStripNotify(type, payload)
        blankMenuPopup.onStripNotify(type, payload)
        tierMenuPopup.onStripNotify(type, payload)
        winsMenuPopup.onStripNotify(type, payload)
      },
    })
    w.once('ready-to-show', () => {
      w.showInactive()
      assertTop(s, 'shown')
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
      // 原生栏重申轮询同停（工单262）：外部先销窗路径不留悬空 interval
      stopNativeWatch(s)
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
  // AppBar 生效档走重协商（占位与栏同矩形重算）；降级档/收栏态无占位可协商——按视图事实
  // 重排并同步回正目标（否则 500ms 回正守卫会拿旧矩形把窗口拽回去，来回拉扯）。
  const onDisplayMetrics = () => {
    const s = session
    if (!s || s.win.isDestroyed()) return
    if (s.appBarHwnd !== null) renegotiate('display-metrics-changed')
    else {
      const bounds = stripBounds()
      s.win.setBounds(bounds)
      s.negotiated = bounds
    }
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
      offPopupState() // 工单253：退订浮层在场订阅（不留悬挂监听）
      destroy('dispose')
    },
  }
}
