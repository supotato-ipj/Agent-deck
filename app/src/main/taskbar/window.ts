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
import { clearRetractAutoHide, engageTakeoverAutoHide, enterRetractAutoHide, reassertTakeoverAutoHide, restoreTakeoverAutoHide } from './appbar-autohide'
import { probeForegroundWindow } from './yield'
import { classifySnapSessionEnd, probeSnapWindows, snapSessionMembers } from './snap'
import type { SnapSessionEndCause, SnapWindowFact } from './snap'
import { ABS_AUTOHIDE, planBarTransition, resolveBarMode, retractGateDisqualified, retractHeldByZoomed, retractReasonHeld } from './retract'
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

/** 主屏底部通栏几何（v1 仅主屏，ADR-0007 Out of Scope）。净空**只在降级档**给：
 * 原生任务栏隐藏失败（句柄缺位等）让出其上沿；健康档恒贴屏底。
 * ⚠️ 工单293 改段：净空判据从「视图事实 nativeTaskbarVisible()」改为**调用方给的
 * 降级档标记**——视图位是瞬态（收栏置位会翻开 explorer 的 WS_VISIBLE 位，「显示位」
 * ≠视觉在场，spike 附记），把几何锚在它上面会让 display-metrics/ABN 协商在收栏过渡
 * 窗口期写出「带 48 净空」的矩形并粘在协商账里（真机 R7-R9 实证：条带停在
 * [屏底−96, 屏底−48] 一整段、keepalive 反而按住不放，51 电池 P2 同签名红）。
 * 健康档下原生栏的可见位翻不翻都不动条带——可见性账（ShowWindow）与几何账本就互不代偿。 */
function stripBounds(clearanceDip = 0): { x: number; y: number; width: number; height: number } {
  const d = screen.getPrimaryDisplay().bounds
  const clearance = clearanceDip
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
   * 工作区收栏账面（工单271，spec #267）：true = 我方 AppBar 占位已注销、原生栏托管
   * 已置位（收栏效果**在账**）——效果层逐笔维护的事实账，不从档位反推。工单271 起
   * 工作区收栏理由（zoomed ∨ 分屏会话）与栏面呈现解耦：分屏会话存续的全屏让位期间
   * 档位是 fullscreen-yield（栏面整窗退场、无唤出条）而账面仍在收（占位保持释放、
   * 托管不中断、不复原工作区）——重申轮询的值守与原生栏账本都以此账为准，档位不再
   * 是托管在场与否的判据。
   */
  workspaceRetracted: boolean
  /**
   * 原生栏重申轮询账（工单262，spec #258；工单293 扩为全接管期）：接管存续期间低频
   * 轮询（1s 拍）检测 Shell_TrayWnd 重建（explorer 重启/热插拔）或可见性翻转/置位丢失，
   * 命中即重挂 SW_HIDE 与目标档位（与「发现可见即再压」同一只轮询，不做键盘拦截）。
   * 起表随接管建立（create）、停表随拆场（destroy/closed），**不随三态迁移起停**；
   * 每拍目标由工作区收栏账（本账 workspaceRetracted）派生。裁决归纯机器
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

  // —— 分屏会话探针账（工单269，spec #267；工单270 扩集合生命周期与结束因果）——
  // 会话是后台事实（真 Snap 窗存续即活跃，与前台是谁无关）；采集与成员裁决在
  // main/taskbar/snap.ts（IsWindowArranged 公共 API，矩形永不提升身份）。首版实际接管
  // 范围 = 主屏（primaryPhysRect），会话按显示器参数隔离裁决、不引入全局判定。
  // 工单270：账面从「一次布尔判定」扩为**成员集合**——上一拍合格成员句柄喂回探针
  // （最小化/解除/换桌面的前成员照采事实），会话结束时按前成员去向分类因果
  // （最小化/关闭/解除/虚拟桌面切换，classifySnapSessionEnd）落进翻转存证；
  // 翻转存证在档位裁决**之后**落盘（调用方），收栏理由接续（会话结束但 zoomed
  // 仍持有收栏档）一并落进同一条——真机可判「会话因何结束、栏为何仍收」（spec 决策 14）。
  let snapSessionLedger: { active: boolean; available: boolean } | null = null
  /** 上一拍合格成员句柄（探针追踪集——结束因果分类的事实源；失败拍清空） */
  let snapMemberHwnds: number[] = []
  const pollSnapSession = (): {
    active: boolean
    available: boolean
    flip: null | { cause?: SnapSessionEndCause; members: number }
  } => {
    let windows: readonly SnapWindowFact[] = []
    let available = true
    let probeFailed = false
    try {
      const probed = probeSnapWindows(snapMemberHwnds)
      available = probed.available
      windows = probed.windows
    } catch {
      // 探针一拍失败按「无会话」处理（还原是安全方向，与前台探针缺位同纪律）；
      // 失败拍无从分类去向（不误报「关闭」）——cause=unknown。
      // 两层失败语义（工单271 评审收口，取舍在案 ADR-0015 修订记取舍记录④）：
      // - bind 层失败（koffi/dll 加载抛错）同样落「识别不可用」（available=false，
      //   spec 决策 11 诊断口径）——不得把 bind 级失败记成 available:true 存证；
      // - 采集层单拍抖动（逐窗 FFI 竞态 / 虚拟桌面 cloak 动画同拍命中）⇒ 本拍按
      //   「无会话」全交割（拆会话 + claim/restore 复原，下一拍按当拍事实重建收栏）——
      //   这是「还原是安全方向 + 用户故事 37 即时性」压过抖动成本的在案取舍，收敛
      //   手段（一拍确认驻留 / 逐窗单点 try/catch）本票未取（前者改恢复时延口径，
      //   后者把「缺席=关闭」的结束因果归真性降级为误报源），出现实测抖动损害再议。
      probeFailed = true
      available = false
    }
    const display = primaryPhysRect()
    const members = available ? snapSessionMembers(windows, display, process.execPath) : []
    const result = { active: members.length > 0, available }
    let flip: { cause?: SnapSessionEndCause; members: number } | null = null
    if (!snapSessionLedger
      || snapSessionLedger.active !== result.active
      || snapSessionLedger.available !== result.available) {
      flip = { members: members.length }
      if (snapSessionLedger?.active && !result.active) {
        // 会话结束：按前成员当拍去向分类（探针失败拍/识别不可用拍无从分类 → unknown，
        // 不误报「关闭」）；建立/可用性翻转不带 cause
        flip.cause = probeFailed || !result.available
          ? 'unknown'
          : classifySnapSessionEnd(snapMemberHwnds, windows, display)
      }
      snapSessionLedger = { ...result }
    }
    snapMemberHwnds = probeFailed ? [] : members.map((m) => m.hwnd)
    return { ...result, flip }
  }

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
    s.workspaceRetracted = false // 工作区收栏账同清（工单271：账随轮询生灭，不悬空）
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
    if (!s || s.win.isDestroyed()) return
    const probe = nativeWatchProbe()
    // 目标档位随工作区收栏账（工单271）：账面在 = 收栏态目标（置位），账清 = 普通栏态
    // 目标（清位）——值守覆盖全接管期（ADR-0016 双缺陷复审 Q1/Q2）：普通态的清位同样
    // 会被 explorer 重启按注册表原值冲掉，所以不只是收栏期才值守。
    const decision = s.nativeWatch?.machine.poll(probe, s.workspaceRetracted ? 'autohide-on' : 'autohide-off')
    if (!decision || decision.action === 'none') return
    if (decision.hide) hideNativeTaskbar(log)
    if (decision.autoHide !== null) reassertTakeoverAutoHide(log)
    log?.append({
      type: 'taskbar-native-reassert',
      reason: decision.reason,
      hwnd: probe.hwnd,
      visible: probe.visible,
      autoHideOn: probe.autoHideOn,
      autoHide: decision.autoHide,
    })
  }

  /** 起表（接管建立，create 一处）：以「当拍事实」立基线——首拍不误报重建/翻转。
   *  全接管期值守（工单293 扩）：不随普通↔收栏迁移起停（工单294 注记同步建成事实）。 */
  const startNativeWatch = (s: TaskbarSession): void => {
    if (s.nativeWatch) return // 已在场（幂等——迁移执行器只在档位变更时调）
    const machine = new NativeReassertMachine()
    machine.begin(nativeWatchProbe())
    const timer = setInterval(pollNativeWatch, NATIVE_WATCH_POLL_MS)
    s.nativeWatch = { machine, timer }
  }

  /** 停表（拆场：destroy / 外部先销窗 closed 两径）：清 interval + 机器回未武装态
   *  （全接管期口径下唯一停表点是拆场——普通↔收栏迁移不停表，工单294 注记同步） */
  const stopNativeWatch = (s: TaskbarSession): void => {
    if (!s.nativeWatch) return
    clearInterval(s.nativeWatch.timer)
    s.nativeWatch.machine.reset()
    s.nativeWatch = null
  }

  /** 净空降级（工单293 改段）：注册失败即把条带上移一身高、协商账同步落降级矩形——
   *  净空不再锚视图位（transient，见 stripBounds 注），锚降级账面；keepalive 从此按
   *  降级矩形回正。create 侧降级档与 applyBarMode 的 claim 失格两路共用。 */
  const applyDegradedClearance = (s: TaskbarSession): void => {
    if (s.win.isDestroyed()) return
    const bounds = stripBounds(TASKBAR_BOTTOM_CLEARANCE)
    s.win.setBounds(bounds)
    s.negotiated = bounds
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

  /**
   * 收栏过渡后的宿主矩形复核（ADR-0016 双缺陷复审决策 4）：收栏过渡会让壳侧把条带宿主
   * 抬高一个原生栏身高（48px），渲染层的唤出条按宿主矩形自算定位 ⇒ 五组唤出条整体偏离
   * 屏底。判据取**宿主矩形底边 vs 屏底**（stripPhysRect 是单点来源，不读渲染层的
   * window.innerHeight 相对值），偏离 >1 DIP 即回正并留证。
   */
  const verifyStripBottom = (s: TaskbarSession, reason: string): void => {
    if (s.win.isDestroyed()) return
    const phys = stripPhysRect()
    const dip = screen.screenToDipRect(s.win, {
      x: phys.left,
      y: phys.top,
      width: phys.right - phys.left,
      height: phys.bottom - phys.top,
    })
    const cur = s.win.getBounds()
    const offBottom = Math.abs((cur.y + cur.height) - (dip.y + dip.height))
    if (offBottom > 1 || Math.abs(cur.y - dip.y) > 1) {
      s.negotiated = dip
      s.win.setBounds(dip)
      log?.append({ type: 'taskbar-host-rect-corrected', reason, from: cur, to: dip })
      return
    }
    log?.append({ type: 'taskbar-host-rect-verified', reason, rect: cur })
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
  const applyBarMode = (s: TaskbarSession, next: BarMode, probe: ForegroundProbe | null, retractHeld: boolean, gateDisqualified: boolean): void => {
    const prev = s.mode
    // 迁移计划带解耦上下文（工单271）：工作区账面 + 理由持有 + 闸门失格——全屏让位
    // 只拥有栏面呈现，占位/托管是否交割由工作区面裁决（分屏会话存续的覆盖期间保持
    // 释放与置位；覆盖期间闸门失格则工作区面当场交割，见同态零动作的唯一例外）。
    const plan = planBarTransition(prev, next, {
      workspaceRetracted: s.workspaceRetracted,
      retractHeld,
      gateDisqualified,
    })
    // 同态零动作（不变量③）：计划零存证零交割才早退——真实 3×3 迁移恒带存证（纯函数
    // 侧矩阵钉死），闸门失格的同态交割拍携带 retract-lifted，不得早退（用户故事 27）。
    if (prev === next && plan.evidence.length === 0) return
    s.mode = next
    // 工作区收栏账面以计划产出**原样落账**（工单271 评审收口①单一所有权）：账面推进
    // 的唯一公式住在 planBarTransition（wantRetracted → plan.targetWorkspaceRetracted），
    // 效果层不再有第二份写法——分屏会话持有的全屏让位期间账保持（理由仍持有）、覆盖
    // 期间闸门失格的同态拍账清（闸门交割）。账面是效果层逐笔维护的事实账，后续值守/
    // 证据都以它为准。
    s.workspaceRetracted = plan.targetWorkspaceRetracted
    const w = s.win
    const reason = prev === next ? 'retract-gate-disqualified'
      : prev === 'maximize-retract' ? 'retract-lifted'
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
        applyDegradedClearance(s) // 净空降级（工单293 改段）：几何动作收口在控制器 helper——档位迁移器不自写窗口几何（既有守卫同款纪律）
      }
    }
    // ②′ 原生栏托管（工单260；ADR-0016 双缺陷复审 2026-10-25 扩为全接管期，Q1/Q2）：
    // 与占位段同拍——进入收栏时**先预隐藏**原生栏再置位 ABS_AUTOHIDE（shell 由此释放
    // 原生保留带，最大化窗铺满整屏）；退出收栏回**普通栏态的清位目标**（不是用户原值，
    // 原值只在退场复原）。raii 账在 appbar-autohide 模块，与哪扇条带窗现任无关。
    if (plan.engageAutoHide) {
      // 收栏过渡前预隐藏（复审对照：普通态弹出后进入收栏，条带宿主可被抬高 48px、五组
      // 唤出条随之偏离屏底；唯一新增「最大化前 SW_HIDE」的对照里唤出条全部贴回 1440）
      hidNative = hideNativeTaskbar(log) || hidNative
      enterRetractAutoHide(log)
    }
    if (plan.clearAutoHide) clearRetractAutoHide(log, reason)
    // ②′′ 收栏过渡后的宿主矩形复核（复审决策 4：几何不变量另行守住——不得把
    // window.innerHeight 的相对正确当成宿主矩形正确）
    if (plan.engageAutoHide) verifyStripBottom(s, 'retract-enter')
    // ②′′′ 退出收栏同样复核（spec #292 用户故事 9「恢复后自绘栏干净回到屏底，不发生位置
    // 漂移」；真机 R7/R8 实证的漂移形态）：置位/清位会把 explorer 的 Shell_TrayWnd
    // WS_VISIBLE 位翻开（「显示位」翻转是既证行为），若 ABN 协商落在该窗口期，QUERYPOS
    // 会被原生保留带剪掉一身高（协商矩形 [屏底−96, 屏底−48]）⇒ 协商账带着错矩形、keepalive
    // 回正守卫反而把窗按住——进收栏有复核（上 行），退收栏同判据补一发，偏离即当场回正留证。
    if (plan.clearAutoHide) verifyStripBottom(s, 'retract-exit')
    // ③ 整窗显隐：让位态整窗退场（唤出条也不出现）；收栏态条带窗在场（承载唤出条）
    if (plan.hideWindow) {
      w.hide()
    } else if (plan.showWindow) {
      w.showInactive()
      assertTop(s, reason)
    }
    // ④ 档位下发渲染层（栏面退场/复现）——只在真实档位迁移拍下发；同态闸门交割拍
    // 栏面不动（渲染层已持有该档位），重复下发只刷事件（渲染层只消费 mode 值）
    if (prev !== next) ctx.emit('taskbar/bar-mode', { mode: next, reason })
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
    // 原生栏托管复原（工单260；ADR-0016 双缺陷复审扩为全接管期）：禁用/退役/dispose 与
    // 正常退出都要把**用户接管前原值**还回去——RAII 账与窗现任无关，退避重试异步推进不拖住
    // 销窗；未接管则静默。**先于可见性复原**（顺序即行为，与守卫/守护径同源——restore-ledger-wiring
    // 的钉序理由）：置位态下 explorer 可翻开 Shell_TrayWnd 的 WS_VISIBLE 位（「窗口显示位」
    // ≠「视觉在场」），可见性判据会被「已可见」骗成静默；先卸置位，可见性复原才做真工作
    // （51 电池 P9 的面板侧径）。
    restoreTakeoverAutoHide(log, reason)
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
    // 先隐原生再建窗（工单50）：条带**恒 born 贴屏底**（工单293 改段——净空不再锚
    // 视图位，见 stripBounds 注）；注册失败才由降级档分支把条带上移一身高。
    // 49 实证的同矩形 z 序竞争（原生栏在场时）由「先隐原生 + 健康档贴屏底」规避，
    // 隐藏失败（句柄缺位等）走降级档净空，竞争面同样不进场。
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
      workspaceRetracted: false, // 工作区收栏账（工单271）：效果层逐笔维护，不从档位反推
      nativeWatch: null,
      appBarDegraded: false,
      negotiated: null,
      keepalive: null as unknown as NodeJS.Timeout,
    }
    session = s
    // 全接管期原生栏托管（ADR-0016 双缺陷复审 Q1/Q2）：接管建立即记用户原状态、落盘记账、
    // 压到普通栏态的清位目标；重申轮询同时起表——普通态的清位同样会被 explorer 重启按
    // 注册表原值冲掉，值守不再只在收栏期（工作区收栏账只决定重申的**目标档位**）。
    engageTakeoverAutoHide(log)
    startNativeWatch(s)
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
        // 分屏会话探针（工单269/270）：与三态裁决同一接缝（spec 决策 3——持续重查，
        // 不缓存一次判定）；识别不可用 ⇒ 恒无会话（分屏收栏关闭，最大化/全屏不受影响）
        const snap = pollSnapSession()
        // 裁决输入装配一次（工单271）：resolveBarMode（档位=栏面呈现）与 retractReasonHeld
        // （工作区收栏理由持有）同源消费同一份事实——全屏覆盖 + 会话存续时档位落让位
        // （②支掩蔽）而 held 独立为真，正是「栏面让位、工作区不让」的裁决缝。
        const barInput = {
          probe,
          screen: primaryPhysRect(),
          ownPid: process.pid,
          retractEnabled: ctx.taskbar.state().maximizeRetract, // 工单239 开关（默认开，关则永不为收栏档；工单269 起分屏收栏共用）
          appBarDegraded: s.appBarDegraded,
          prevMode: s.mode, // 工单253：自家浮层夺前台时沿用当前档位（不翻收栏档）
          ownOverlayPresent: openOverlayFamilies.size > 0, // 工单253：自家浮层在场（与「面板本体被点」分清）
          snapSessionActive: snap.active, // 工单269：主屏分屏会话事实（后台理由，与 zoomed 同档同闸门）
        }
        const mode = resolveBarMode(barInput)
        const retractHeld = retractReasonHeld(barInput)
        // 会话事实翻转存证（工单269/270）：落点在档位裁决之后——会话结束但档位仍收栏
        // （zoomed 理由接续）在同一条存证里可判；只在事实变化时落（同拍幂等，不刷屏）。
        // members = 当拍合格成员数（多窗集合的规模可观测——建立/结束存证可判会话由几窗维持）
        // retractHeldByZoomed = retractReasonHeld 的 zoomed 分量（工单271 评审收口⑤）：
        // 浮层夺前台的 prevMode 保持拍（probe 是自家进程）与会话理由接续拍不再误记为 zoomed。
        if (snap.flip) {
          log?.append({
            type: 'taskbar-snap-session',
            active: snap.active,
            available: snap.available,
            members: snap.flip.members,
            ...(snap.flip.cause !== undefined ? {
              cause: snap.flip.cause,
              retractHeldByZoomed: retractHeldByZoomed(barInput),
            } : {}),
          })
        }
        applyBarMode(s, mode, probe, retractHeld, retractGateDisqualified(barInput))
      }, YIELD_POLL_MS)
    } else {
      // 降级档（工单50/51）：注册被拒 → 不占工作区、也让位。收栏整体禁用（同待遇——
      // 没有占位就没有「释放占位」这回事，且降级档下最大化窗本就覆盖全屏）。
      s.appBarDegraded = true
      applyDegradedClearance(s) // 净空降级（工单293 改段）：净空锚降级账面，不锚视图位
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
  // AppBar 生效档走重协商（占位与栏同矩形重算）；降级档按**账面净空**重排（工单293 改段：
  // 不再锚视图位——收栏置位翻开的 WS_VISIBLE 位是瞬态，健康档恒贴屏底），并同步回正目标
  // （否则 500ms 回正守卫会拿旧矩形把窗口拽回去，来回拉扯）。
  const onDisplayMetrics = () => {
    const s = session
    if (!s || s.win.isDestroyed()) return
    if (s.appBarHwnd !== null) renegotiate('display-metrics-changed')
    else {
      const bounds = stripBounds(s.appBarDegraded ? TASKBAR_BOTTOM_CLEARANCE : 0)
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
