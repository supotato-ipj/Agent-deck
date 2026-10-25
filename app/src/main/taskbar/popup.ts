// 任务栏弹窗菜单浮层窗载体（工单193）：自绘竖排菜单面板的通用承载，从托盘溢出菜单
// 浮层窗（工单162 overflow.ts）泛化而来——托盘溢出与应用组右键菜单（#196 起含其余
// 菜单面）共用同一载体，窗参数与开合语义逐字对齐先例：
// - 裁定不变（overflow.ts 模块头三候选论证）：独立浮层窗 focusable:true + show 取焦，
//   blur 即「点面板外」的全局信号；生命周期独立，不碰条带几何；主面板钉底会被普通
//   窗盖住、条带窗扩展与回正守卫互斥且 focusable:false 收不到 blur——都不成立。
// - 窗常驻（红轮实证：每次开层新起渲染进程有秒级 spin-up jank——首点偶发吞点击）：
//   首开惰性建一扇，收层即 hide、再开即重定位 show；行内容由载页自养（bridge 广播
//   常活重渲），宿主只持最新内容尺寸做开层定位。
// - 落位与开层裁决是纯函数（popup-plan.ts，离线单测钉住）：锚点上方 8px 出层、水平
//   居中、工作区四缘内衬夹取；create/reload/show 三态。
// 通路 API（#196 复用面）：startPopupMenuCarrier(options) → { open, close, dispose }。
// 锚点（open 参数）/条目集（载页 URL query 寻址域适配器）/动作（载页行点击域适配器
// 自行分发+存证）三参均可复用，应用组菜单语义不写死在本模块。
import { BrowserWindow, screen } from 'electron'
import path from 'node:path'
import type { Context } from 'cordis'
import type { BridgeEventName } from '../../shared/contract'
import type { EventLog } from '../panel-ipc'
import { wireBridgeIpc, wireHostIpc } from '../panel-ipc'
import { clampPopupBounds, planPopupOpen } from './popup-plan'
import type { PopupAnchor } from './popup-plan'

/** 页面内容实测回报载荷（w/h 必带，rows 携行矩形与行身份供验收取点击坐标） */
interface PopupReadyPayload {
  w?: unknown
  h?: unknown
  rows?: unknown
}

export interface PopupMenuCarrierOptions {
  ctx: Context
  log: EventLog | null
  /** 浮层窗标题：验收控制器按 pid + 标题寻窗（TASKBAR_TITLE 先例） */
  title: string
  /**
   * 浮层家族前缀（工单242 钉组用）：条带渲染层据此把「浮层在场」映射到**所属组**
   * （如托盘溢出菜单钉右组）——家族名与存证事件族同源（events.opened = `${family}-opened`）。
   */
  family: string
  /** 存证事件名（域前缀各自持有，不混用）：开层/在场重定窗/收层 */
  events: { opened: string; resized: string; closed: string }
  /** 载页内容实测回报的 notify 名（载体消费：定窗锚光标弹出） */
  readyEvent: string
  /** 载页收层请求的 notify 名（payload.reason 落存证） */
  closeEvent: string
  /** 渲染层自诊断存证前缀：-renderer-console / -load-failed / -preload-error */
  diagPrefix: string
  /** 转发给载页的 bridge 广播通道（行集常活自养的数据源，如 taskbar/changed） */
  bridgeChannels: BridgeEventName[]
  /** ready/close 之外的载页通知路由（行点击等域事件——wireHostIpc 已自动落存证，
   * 需要行为的宿主包装层在此接线；缺省即只存证） */
  onPageNotify?(type: string, payload: Record<string, unknown> | undefined): void
}

export interface PopupMenuCarrier {
  /**
   * 开层请求（恒重锚定）：按 planPopupOpen 三态——首开建窗载页待 ready 弹出；URL
   * 变化重载行集再弹出；URL 未变按现存内容即刻定位弹出（载页随 changed 常活自养）。
   * anchor 缺省 = 定位拍光标位（右键手势即图标位，先例「锚光标」同款）。
   */
  open(options?: { url: string; anchor?: PopupAnchor }): void
  /** 显式收层（全屏让位/条带点击转达/条带销毁等场景；reason 落存证） */
  close(reason: string): void
  /** 浮层窗在场可见与否（拨动语义的宿主判据：在场遇开层请求即收） */
  isVisible(): boolean
  /** 条带销毁/控制器退役随行（禁用即销窗） */
  dispose(): void
}

/**
 * 弹窗菜单浮层窗载体：宿主 open 请求 →（首开）建窗载页 /（URL 变）重载页 /
 * （同页）即刻定位 → 载页自渲行集 → 实测回报（readyEvent）→ 按内容定窗、锚点上方
 * 弹出（工作区夹取）并取焦。收层 = hide（窗常驻）：blur（点面板外）/ 载页请求 /
 * 宿主显式 close / dispose（destroy）。
 */
export function startPopupMenuCarrier(options: PopupMenuCarrierOptions): PopupMenuCarrier {
  const { ctx, log } = options
  let win: BrowserWindow | null = null
  /** 页面最新内容实测（w/h/行数）：隐藏拍持续更新，开层定位据此 */
  let cache: { w: number; h: number; rows: number } | null = null
  /** 首开/重载页未回报前的 show 挂起标记：ready 回报即定位弹出 */
  let pendingShow = false
  /** 现行载页 URL：开层裁决（planPopupOpen）的比对基线 */
  let pageUrl: string | null = null
  /** 弹出锚点：在场拍名单 churn 重定窗只变尺寸不挪位（红轮实证：以实时光标重锚会把
   * 开着的浮层拽到光标处——行点击中途浮层跳走，下一击落空）；开层请求恒重锚 */
  let anchor: PopupAnchor | null = null

  const hide = (reason: string): void => {
    const w = win
    if (!w || w.isDestroyed() || !w.isVisible()) return
    w.hide()
    log?.append({ type: options.events.closed, reason })
    // 工单242 钉组：浮层离场事实下发条带渲染层——所属组解除钉住（否则该组永不收起）
    ctx.emit('taskbar/popup-state', { family: options.family, open: false })
  }

  /** 锚点 + 内容尺寸 → 工作区夹取定窗（popup-plan clampPopupBounds）；隐藏态即弹出
   * 取焦，在场态只重定窗不挪锚。 */
  const placeAndShow = (): void => {
    const w = win
    if (!w || w.isDestroyed() || !cache) return
    if (!anchor) {
      const cursor = screen.getCursorScreenPoint()
      anchor = { x: cursor.x, y: cursor.y }
    }
    const wa = screen.getPrimaryDisplay().workArea
    const pos = clampPopupBounds(anchor, cache, wa)
    const cur = w.getBounds()
    if (Math.abs(cur.x - pos.x) > 1 || Math.abs(cur.y - pos.y) > 1 || Math.abs(cur.width - cache.w) > 1 || Math.abs(cur.height - cache.h) > 1) {
      w.setBounds({ x: pos.x, y: pos.y, width: cache.w, height: cache.h })
    }
    if (!w.isVisible()) {
      w.show() // 取焦：blur 收「点面板外」的前提（原生菜单在场持前台同语义）
      log?.append({ type: options.events.opened, bounds: w.getBounds(), rows: cache.rows })
      // 工单242 钉组：浮层在场事实下发条带渲染层——所属组被钉住（其余组照常收）
      ctx.emit('taskbar/popup-state', { family: options.family, open: true })
    } else {
      log?.append({ type: options.events.resized, bounds: w.getBounds(), rows: cache.rows })
    }
  }

  const onReady = (payload: PopupReadyPayload): void => {
    cache = {
      w: Math.max(80, Math.round(Number(payload.w) || 320)),
      h: Math.max(40, Math.round(Number(payload.h) || 80)),
      rows: Array.isArray(payload.rows) ? payload.rows.length : 0,
    }
    const w = win
    if (!w || w.isDestroyed()) return
    if (pendingShow) {
      pendingShow = false
      placeAndShow()
    } else if (w.isVisible()) {
      placeAndShow() // 在场拍名单变化重定窗（尺寸随行数，锚点冻结不挪位）
    }
    // 隐藏拍：只更新 cache（开层时 placeAndShow 消费）
  }

  return {
    open(req) {
      const url = req?.url ?? ''
      if (!url) return
      const plan = planPopupOpen({ exists: !!win && !win.isDestroyed(), url: pageUrl }, { url })
      if (plan === 'create') {
        const cursor = screen.getCursorScreenPoint()
        const w = new BrowserWindow({
          width: 320,
          height: 80, // 临时尺寸：页面渲染完按内容实测重定（placeAndShow）
          x: cursor.x,
          y: cursor.y,
          title: options.title,
          show: false,
          frame: false,
          transparent: true,
          resizable: false,
          movable: false,
          focusable: true,
          hasShadow: false,
          skipTaskbar: true,
          alwaysOnTop: true,
          backgroundColor: '#00000000',
          webPreferences: {
            // 本模块编译产物在 dist/main/taskbar/ → 向上两级到 dist/ 再进 preload/
            //（红轮实证：三级向上出了 dist 落 appRoot/preload，ENOENT → window.deck 未定义，
            // 浮层页静默死——opened 存证永不落，电池臂2/4 连锁红）
            preload: path.join(__dirname, '../../preload/index.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        })
        win = w
        pageUrl = url
        pendingShow = true
        anchor = req?.anchor ?? null
        // 渲染层自诊断（条带页同款纪律：静默不执行时电池只见「存证缺失」——把渲染层错误
        // 与加载失败落进事件流）
        w.webContents.on('console-message', (_event, level, message, line, sourceId) => {
          if (level >= 2) log?.append({ type: `${options.diagPrefix}-renderer-console`, level, message, line, sourceId })
        })
        w.webContents.on('did-fail-load', (_event, code, description, url2) => {
          log?.append({ type: `${options.diagPrefix}-load-failed`, code, description, url: url2 })
        })
        w.webContents.on('preload-error', (_event, _preloadPath, error) => {
          log?.append({ type: `${options.diagPrefix}-preload-error`, message: error.message })
        })
        // 行集/名单变化推进载页重渲（页自决：拆空即请求收层）
        wireBridgeIpc(w, ctx.bridge, options.bridgeChannels)
        // 浮层无热区（小窗整体受点，不走条带的穿透机制）；host 通道只为 notify 存证与收层请求
        wireHostIpc(w, null, log, {
          onNotify: (type, payload) => {
            if (type === options.readyEvent) onReady((payload ?? {}) as PopupReadyPayload)
            else if (type === options.closeEvent) hide(String((payload as { reason?: unknown } | undefined)?.reason ?? 'request'))
            else options.onPageNotify?.(type, payload)
          },
        })
        // 点面板外 = blur（全局信号：桌面/其他应用任意点击都先夺走浮层焦点）
        w.on('blur', () => hide('blur'))
        w.once('closed', () => {
          if (win === w) win = null
        })
        void w.loadURL(url)
        return
      }
      const w = win as BrowserWindow
      anchor = req?.anchor ?? null // 重开 = 重新锚定当前光标/指定点（上次弹出位不残留）
      if (plan === 'reload') {
        pageUrl = url
        if (!w.isVisible()) pendingShow = true
        void w.loadURL(url) // 载页重渲后 ready 定位弹出（在场拍 ready 重定窗）
        return
      }
      placeAndShow()
    },
    close(reason) {
      hide(reason)
    },
    isVisible() {
      const w = win
      return !!w && !w.isDestroyed() && w.isVisible()
    },
    dispose() {
      const w = win
      win = null
      // 工单253：销窗即「浮层不在场」——所属组解除钉住、档位裁决的「自家浮层在场」位归零
      // （浮层在场时前台探针看到自家进程 ⇒ 收栏档保持；浮层没了就不该再钉着档位）
      ctx.emit('taskbar/popup-state', { family: options.family, open: false })
      if (!w || w.isDestroyed()) return
      w.destroy()
      log?.append({ type: options.events.closed, reason: 'dispose' })
    },
  }
}
