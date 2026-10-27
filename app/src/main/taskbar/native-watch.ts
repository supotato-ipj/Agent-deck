// 原生栏重申轮询（工单262，spec #258 原生栏托管；工单293 ADR-0016 双缺陷复审 Q1/Q2
// 扩为**全接管期**；工单308 M1 覆盖式普通档收紧目标态）：接管存续期间低频轮询，检测
// Shell_TrayWnd 窗口重建（explorer 重启/崩溃、显示器热插拔）或可见性翻转 / 置位丢失，
// 命中即重挂——压回 SW_HIDE 并重申**置位目标**（原生栏不复活、闪现即压回）。起表随接管
// 建立（条带窗 create）、停表随拆场（destroy/closed）——不随档位迁移起停（M1 下托管期
// 目标态唯一：auto-hide 恒置位，无「清位目标」这一拍，旧 NativeWatchWant 随接口退役）。
// 与「发现可见即再压」是同一只轮询：重建、翻开、置位丢失三因都归它，不做键盘
// 拦截（Win 键唤出路径不拦——spike 观察项 6：SW_HIDE + 置位态按 Win 0 帧不闪现，
// docs/audit/2026-10-24-t257-autohide-setstate-probe.md）。
//
// 命名纪律：票面/spec 措辞「看门狗」，但 GLOSSARY 里「看门狗」是工单11 退役词条
// （_Avoid_）、「守卫」「守护」各被既有机制占用——本机制按渲染层哨兵同款命名法
// 取「重申」（与既有「置顶重申」族同源：按拍子观察、偏离即重申），领域语言收口
// 归 T5（工单263）。
//
// 本模块只做裁决（纯逻辑零 Win32，同 tray-yield 状态机与 yield 谓词的分工）：
// 每拍喂进观察快照，出「重挂与否、归因、该做哪两样动作」的决策。FFI 观察与
// 重挂动作是效果层（window.ts 接线 + native.ts / appbar-autohide.ts 动作面），
// 离线不可测——接线以源码级守卫钉住，真机行为走 51 电池 P10 段。
//
// 判据口径（spike 附记的坑）：置位态下 explorer 可能翻开 Shell_TrayWnd 的
// WS_VISIBLE 位（autohide「滑出屏」态的窗口位标记，窗口本体不在视觉场——
// 迭代 1 实测 0.8s 内恢复该位，迭代 2 恒 false，非确定）。「发现可见即再压」
// 照样把该位当翻转压回：压回是安全方向（位在场恰是 hover 唤出原生栏的通路，
// 托管期要的正是这条通路被摁住），且 SW_HIDE 幂等无害；位语义的「窗口显示位
// ≠视觉在场」只影响电池断言的读法（P10 以工作区底边=屏底为主判据）。

/** 轮询间隔（票面 1–2s 低频档）：1000ms——检测时延 ≤1 拍 + 动作耗时 */
export const NATIVE_WATCH_POLL_MS = 1000

/** 一拍观察快照（FFI 采集，喂给纯裁决） */
export interface NativeWatchProbe {
  /** 原生主任务栏句柄（explorer 不在场 = 0） */
  hwnd: number
  /** 视图事实：IsWindowVisible（「窗口显示位」口径，见模块头注） */
  visible: boolean
  /** appbar 状态读回含 ABS_AUTOHIDE（置位在场的系统侧事实）。**窗口缺位拍可不采**
   *  （缺省 = 未采）——机器在 hwnd=0 的间隙拍不读此字段，效果层借此跳过对死亡/重启中
   *  shell 的状态读（实测：对新起 explorer 的 SHAppBarMessage 会阻塞秒级，间隙拍白等）。 */
  autoHideOn?: boolean
}

/** 重挂归因（优先级 rebuild > visible > autohide-mismatch——报最重的因） */
export type NativeWatchReason = 'rebuild' | 'visible' | 'autohide-mismatch'

/** 一拍决策：none = 清净不动作；reattach = 重挂（hide / autoHide 由观察事实派生，
 *  效果层照单执行——已隐不重复压、置位已在位不重复写） */
export type NativeWatchDecision =
  | { action: 'none' }
  | { action: 'reattach'; reason: NativeWatchReason; hide: boolean; autoHide: 'engage' | null }

/**
 * 原生栏重申状态机：持有「上拍见过的原生栏句柄」这一份账。
 *
 * - begin：起拍以当拍观察立基线（起拍不动作——置位/隐藏刚由接管建立做过，
 *   首拍不误报重建）；
 * - poll：每拍裁决。窗口缺位（explorer 死亡间隙）不动作——无从压也无从置，
 *   基线清零等窗口归位；归位窗口（任意句柄，含复用旧值）即重建。
 */
export class NativeReassertMachine {
  private lastHwnd = 0
  private armed = false

  /** 起拍：立基线（不动作） */
  begin(probe: NativeWatchProbe): void {
    this.lastHwnd = probe.hwnd
    this.armed = true
  }

  /**
   * 一拍裁决。重挂两样动作由事实派生：
   * - hide ⟸ 可见（含重建后的新窗——explorer 重建的新窗必可见；已隐则不重复压）；
   * - autoHide ⟸ 置位读回丢失（M1 目标态恒置位：explorer 重启按注册表原态复活、
   *   置位被冲掉，读回缺 AUTOHIDE 即 engage——托管期没有「清位目标」这一态）。
   */
  poll(probe: NativeWatchProbe): NativeWatchDecision {
    if (!this.armed) {
      this.begin(probe) // 防御路径（正常流程 begin 先行）：重立基线不动作
      return { action: 'none' }
    }
    if (probe.hwnd === 0) {
      this.lastHwnd = 0 // 间隙：基线清零，归位窗口（任意句柄）即重建
      return { action: 'none' }
    }
    const rebuild = probe.hwnd !== this.lastHwnd
    const hide = probe.visible
    const on = probe.autoHideOn === true
    const autoHide = on ? null : 'engage' as const
    this.lastHwnd = probe.hwnd
    if (!rebuild && !hide && autoHide === null) return { action: 'none' }
    return {
      action: 'reattach',
      reason: rebuild ? 'rebuild' : hide ? 'visible' : 'autohide-mismatch',
      hide,
      autoHide,
    }
  }

  /** 拆场（destroy/closed 两径）：回未武装态（停表只随拆场——效果层停表
   *  后残留一拍也不再动作；档位迁移不停表，工单294 注记同步建成事实） */
  reset(): void {
    this.armed = false
    this.lastHwnd = 0
  }
}
