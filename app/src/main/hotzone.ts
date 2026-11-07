import { BrowserWindow, screen } from 'electron'
import type { HotzoneRect } from '../shared/contract'
import { panelLabels } from './lag-sentinel'

const POLL_MS = 25
/** 离开判定确认拍数：连续两拍不命中才恢复穿透——边界光标抖动不翻转窗口样式 */
const LEAVE_CONFIRM_POLLS = 2

export interface HotzoneHooks {
  /** 离开热区：恢复穿透后触发（生产语义 = 重新钉扎，探针01-C：热区点击会顶起 z 序） */
  onLeave?: () => void
  /** 穿透状态切换（供存证日志） */
  onTransition?: (hot: boolean) => void
  /**
   * 工单242 唤出条指针对账：光标落在哪个热区（id = 矩形声明时的 id；null = 不在任何热区）。
   *
   * 这是**按光标坐标 hit-test 的结论**——与穿透判定同一次轮询、同一份光标坐标，
   * 故悬停态与穿透态永不各判一次。只在命中区**变化**时触发（不等距拍发）。
   * 拖拽会话持门期（holdCount > 0）轮询提前返回 → 不触发（拖拽期不做唤出交互）。
   */
  onZone?: (id: string | null) => void
}

/**
 * 交互热区跟踪：主进程持有渲染层声明的热区矩形，GetCursorPos 轮询（25ms 量级）命中切换
 * setIgnoreMouseEvents——机制经工单01 探针B 12/12 实证。
 * 恢复穿透一律不带 forward：低级鼠标钩子会让主线程阻塞波及全系统鼠标输入。
 */
export class HotzoneTracker {
  private rects: HotzoneRect[] = []
  /**
   * 投放包视图矩形表（工单343）：包宿主 live bounds 表的投影（index.ts 接线推送），
   * 与渲染层申报的热区**同一 hit-test**并入命中集——包视图区域从「穿透死区」变为可交互，
   * 不建 sendInputEvent 注入桥，穿透解除后 OS 按视图层叠自然递点击。
   */
  private packageRects: HotzoneRect[] = []
  private hot = false
  private missCount = 0
  /** 拖拽会话持门计数（工单195）：OLE 拖拽活动期抑制关门——渲染层 dragstart/dragend
   * 成对上行（嵌套安全用计数），持门期 poll 跳过离场判定、穿透恒开。跨组/缝隙松手
   * 不丢（断点③：~60% 跨 pill 场景 drop 随 25ms 轮询关门丢失，2026-10-14 取证在案）。 */
  private holdCount = 0
  /** 当前命中的热区 id（工单242：按光标坐标 hit-test 的结论，供唤出条指针对账） */
  private zoneId: string | null = null
  private readonly timer: NodeJS.Timeout
  private disposed = false

  constructor(private readonly win: BrowserWindow, private readonly hooks: HotzoneHooks = {}) {
    this.timer = setInterval(() => this.poll(), POLL_MS)
  }

  setRects(rects: HotzoneRect[]): void {
    this.rects = rects
  }

  /** 包宿主 bounds 表并入命中集（工单343；index.ts 接线随宿主 live 表变化推送） */
  setPackageRects(rects: HotzoneRect[]): void {
    this.packageRects = Array.isArray(rects) ? rects : []
  }

  /** 命中区变化时上报（工单242 对账通路）：只在真变了才发——等距拍发会把渲染层淹掉 */
  private setZone(id: string | null): void {
    if (this.zoneId === id) return
    this.zoneId = id
    this.hooks.onZone?.(id)
  }

  /** 拖拽会话持门（工单195）：on=true 计数 +1 并立即开门（拖拽起手时窗必在穿透态——
   * 不开门则首个 dragover 就收不到）；on=false 计数 -1，归零后下一拍恢复常态判定。 */
  setHold(on: boolean): void {
    if (this.disposed) return
    this.holdCount = Math.max(0, this.holdCount + (on ? 1 : -1))
    if (this.holdCount > 0) {
      this.missCount = 0
      if (!this.hot) {
        this.hot = true
        panelLabels.run('hotzone-toggle', () => this.win.setIgnoreMouseEvents(false))
        this.hooks.onTransition?.(true)
      }
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    clearInterval(this.timer)
  }

  private poll(): void {
    if (this.disposed) return
    if (this.win.isDestroyed()) {
      this.dispose()
      return
    }
    // 拖拽会话持门（工单195）：跳过命中/离场判定——门保持开（setHold 已即时开门），
    // missCount 清零使释门后从干净拍恢复常态判定，不会因陈旧计数秒关。
    if (this.holdCount > 0) {
      this.missCount = 0
      return
    }
    // 滞后哨兵（工单117）：穿透翻转是触碰窗口全局态的动作（H2；final4 轮事件尾终点）。
    // 25ms 的常态读（光标/几何）不挂标签——span 落盘量与主线程开销都按「动作」而非「节拍」计。
    const cursor = screen.getCursorScreenPoint()
    const bounds = this.win.getBounds()
    const px = cursor.x - bounds.x
    const py = cursor.y - bounds.y
    // 包矩形优先命中（工单343 spec 决策4：包宿主 bounds 表并入命中集）：WebContentsView
    // 层叠在渲染层之上，点击先落包视图——zoneId 同拍上报包热区 id（setPackageRects 传入的
    // 包 id），不误报被盖住的渲染层热区。包矩形与渲染层热区本就互斥（摆位账本同一份占用），
    // 优先序只是对声明缺口的兜底取序。
    const contains = (r: HotzoneRect) =>
      px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h
    const hit = this.packageRects.find(contains) ?? this.rects.find(contains)
    if (hit) {
      this.missCount = 0
      // 工单242：命中区 id 与穿透判定同拍同源（同一份光标坐标、同一遍 hit-test）——
      // 唤出条的悬停态据此对账，不另开坐标源
      this.setZone(hit.id)
      if (!this.hot) {
        this.hot = true
        panelLabels.run('hotzone-toggle', () => this.win.setIgnoreMouseEvents(false))
        this.hooks.onTransition?.(true)
      }
      return
    }
    this.missCount += 1
    if (this.hot && this.missCount >= LEAVE_CONFIRM_POLLS) {
      this.hot = false
      this.setZone(null)
      panelLabels.run('hotzone-toggle', () => this.win.setIgnoreMouseEvents(true))
      this.hooks.onLeave?.()
      this.hooks.onTransition?.(false)
    }
  }
}
