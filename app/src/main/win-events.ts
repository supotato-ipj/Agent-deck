// 系统窗口事件泵（工单475，spec #472 用户故事 19「窗口增删等事件由系统通知驱动」）：
// SetWinEventHook（WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS）按订阅区间挂钩，
// WinEventProc 回调经 win-event-route 纯路由置脏，驱动循环按防抖计划冲刷消费者。
// 消费者（桌面遮罩守望 / 任务栏三态裁决）各持订阅，引用计数归零即摘钩。
// 旧世界对照：遮罩守望每 150ms 全窗 z 序双走查、三态裁决每 250ms 全窗枚举——
// 事件化后常驻静默期零走查，事件到达即按需再评估（ADR-0032 事件驱动优先于轮询）。
//
// 效果层边界（lazy-bind 纪律，yield.ts / win-facts.ts 先例）：模块加载不触 FFI；
// 钩子安装/摘除在首/末订阅时发生。回调与 trampoline 进程级持引（koffi 回调生命周期
// ——EnumWindows 短命回调的翻车面这里不适用：本回调随钩子常驻、模块级单登不释放，
// #153 撞名教训：proto 名带票号防撞）。回调体内只做路由与账本记账（微秒级），全部
// 侦察与动作推迟到防抖冲刷拍——事件风暴（拖拽期 LOCATIONCHANGE 逐帧）不放大 FFI。
//
// 钩子失能降级（bind 抛错 / SetWinEventHook 落空）：泵保持无钩空转、消费者照常注册，
// 侦察退回各自的常驻兜底拍（守望 5s 新鲜度全扫、三态 500ms 兜底拍）——正确性有界、
// 只亏新鲜度，不崩不静默。
import koffi from 'koffi'
import {
  EMPTY_PUMP_STATE,
  SUBSCRIBED_EVENT_RANGES,
  markEventPending,
  planEventFlush,
  routeWinEvent,
} from './win-event-route'
import type { EventPumpState, WinEventObservation } from './win-event-route'

const WINEVENT_OUTOFCONTEXT = 0x0000
const WINEVENT_SKIPOWNPROCESS = 0x0002

/** 冲刷配置：60ms 尾沿防抖（合并最小化风暴/拖拽突发），250ms 最小间隔封顶
 * （风暴期最坏再评估频率=旧 250ms 轮询同量级，静默期零成本） */
const FLUSH_CFG = { quietMs: 60, minIntervalMs: 250 }

/** 防抖冲刷供给消费者的信息：osEventAtMs = 本批最早事件的 OS 侧时刻（GetTickCount 口径，
 * 捕获时延「OS 事件→本方裁决」的度量基点） */
export interface WindowEventFlush {
  osEventAtMs: number | null
}
export type WindowEventConsumer = (flush: WindowEventFlush) => void

interface Bound {
  setWinEventHook: (...args: unknown[]) => unknown
  unhookWinEvent: (...args: unknown[]) => unknown
}

let bound: Bound | null = null
/** proto 单登名（#153 教训：进程级撞名即崩——名字钉票号） */
const WIN_EVENT_PROC_PROTO = 'deck475_win_event_proc'
/** trampoline 进程级持引：钩子存活期内回调指针必须有效（GC 掉=野指针回调，进程崩溃面） */
let trampoline: unknown = null

function bind(): Bound {
  if (bound) return bound
  const user32 = koffi.load('user32.dll')
  try {
    // C 签名字符串形声明（koffi.register 的 type spec 用「名 *」指针形态引用它）；
    // 重入（teardown 后再订阅）同名单登会抛 Duplicate——已声明即放行
    koffi.proto(`void __stdcall ${WIN_EVENT_PROC_PROTO}(void *hook, uint32 event, uintptr_t hwnd, int32 idObject, int32 idChild, uint32 thread, uint32 ms)`)
  } catch { /* 已注册：幂等放行 */ }
  bound = {
    setWinEventHook: user32.func('void * __stdcall SetWinEventHook(uint32 eventMin, uint32 eventMax, void *hmodWinEventProc, void *pfnWinEventProc, uint32 idProcess, uint32 idThread, uint32 dwFlags)'),
    unhookWinEvent: user32.func('bool __stdcall UnhookWinEvent(void *hWinEventHook)'),
  }
  return bound
}

/** 防抖冲刷的驱动节拍下限（ms）：排程时刻已过时兜一拍，避免 0ms 忙转 */
const MIN_RECHECK_MS = 5

/**
 * 窗口事件泵单例：订阅计数 + 钩子生命周期 + 防抖驱动。install() 失败（koffi 缺符号/
 * 挂钩落空）不抛——泵以「无钩空转」形态降级，消费者的常驻兜底拍接管侦察（正确性
 * 有界、新鲜度退档，见模块头注）。
 */
export class WindowEventPump {
  private consumers = new Set<WindowEventConsumer>()
  private hookHandles: unknown[] = []
  private state: EventPumpState = EMPTY_PUMP_STATE
  /** 最近一条脏事件的本方到达时刻（hasEventsSince 的单一事实——「自 t 以来世界动过没」） */
  private lastEventArrivalMs = 0
  /** 本批最早的 OS 事件时刻（捕获时延度量基点；冲刷后清账） */
  private oldestOsEventAtMs: number | null = null
  private timer: NodeJS.Timeout | null = null
  private installed = false

  /** 最近脏事件到达时刻（任务栏 keepalive 的置顶重申闸门用） */
  lastDirtyEventMs(): number {
    return this.lastEventArrivalMs
  }

  /** 钩子是否在场（install 落空=降级态——调用方据此退回各自的无条件兜底拍） */
  hasHooks(): boolean {
    return this.hookHandles.length > 0
  }

  /** 自 t 以来窗口世界是否出现过订阅事件（snap 增量 diff 的脏位查询） */
  hasEventsSince(tMs: number): boolean {
    return this.lastEventArrivalMs > tMs
  }

  subscribe(consumer: WindowEventConsumer): () => void {
    this.consumers.add(consumer)
    this.install()
    return () => {
      this.consumers.delete(consumer)
      if (this.consumers.size === 0) this.teardown()
    }
  }

  /** WinEventProc 回调体（主线程消息循环内执行）：只做路由与记账，微秒级返回 */
  private onRawEvent = (eventId: number, hwnd: number, idObject: number, idChild: number, atMs: number): void => {
    try {
      const obs: WinEventObservation = { eventId, hwnd, idObject, idChild, atMs }
      const route = routeWinEvent(obs)
      if (!route.dirty) return
      const now = Date.now()
      if (this.state.pendingSinceMs === null) this.oldestOsEventAtMs = atMs
      this.lastEventArrivalMs = now
      this.state = markEventPending(this.state, now)
      this.schedule(planEventFlush(this.state, now, FLUSH_CFG).recheckInMs ?? FLUSH_CFG.quietMs)
    } catch {
      // 回调内异常不得逸出 FFI 边界（进程崩溃面）：本拍放弃，下一事件重来
    }
  }

  private schedule(inMs: number): void {
    if (this.timer) return
    this.timer = setTimeout(() => this.tick(), Math.max(MIN_RECHECK_MS, inMs))
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  private tick(): void {
    this.timer = null
    const now = Date.now()
    const plan = planEventFlush(this.state, now, FLUSH_CFG)
    this.state = plan.state
    if (plan.fire) {
      const osAt = this.oldestOsEventAtMs
      this.oldestOsEventAtMs = null
      for (const consumer of this.consumers) {
        try {
          consumer({ osEventAtMs: osAt })
        } catch {
          // 消费者异常不拖垮泵与其他消费者（守望/三态互不连坐）
        }
      }
    }
    if (this.state.pendingSinceMs !== null) {
      this.schedule(plan.recheckInMs ?? FLUSH_CFG.quietMs)
    }
  }

  private install(): void {
    if (this.installed) return
    this.installed = true
    try {
      const b = bind()
      if (!trampoline) {
        // register(func, type) 参数序（koffi 2.x 契约）；type 用「proto 名 *」指针形态；
        // trampoline 进程级单登、随单例常驻（模块级持引防 GC——回调指针必须活过钩子）
        trampoline = koffi.register((_hook: unknown, eventId: number, hwnd: number, idObject: number, idChild: number, _thread: number, atMs: number) => {
          this.onRawEvent(eventId, Number(hwnd), Number(idObject), Number(idChild), Number(atMs))
        }, `${WIN_EVENT_PROC_PROTO} *`)
      }
      for (const range of SUBSCRIBED_EVENT_RANGES) {
        const handle = b.setWinEventHook(range.min, range.max, null, trampoline, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS)
        if (handle) this.hookHandles.push(handle)
      }
      // 全部区间挂钩落空 = 钩子失能：摘掉 trampoline 引用不现实（保持单登无害），
      // 降级面由消费者的常驻兜底拍接管——这里只留空转泵。
    } catch {
      // bind 失败（koffi/符号缺位）：同上，无钩空转
    }
  }

  private teardown(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    try {
      const b = bound
      if (b) for (const h of this.hookHandles) b.unhookWinEvent(h)
    } catch { /* 摘钩失败不阻断拆场（进程生命周期内单例，泄漏面有限） */ }
    this.hookHandles = []
    this.state = EMPTY_PUMP_STATE
    this.oldestOsEventAtMs = null
    this.installed = false
  }
}

const pump = new WindowEventPump()

/** 取进程级窗口事件泵单例（订阅返回退订闭包；末订阅者退订即摘钩） */
export function acquireWindowEventPump(): WindowEventPump {
  return pump
}
