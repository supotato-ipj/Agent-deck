// 条带置顶重申让位裁决（工单450）：三处置顶重申点（keepalive 500ms、热区离开、
// 键盘 pin；另加 shown/让位恢复拍）经 assertTop 单漏斗后的**动作裁决**抽纯函数钉单测
// （tray-yield 先例同纪律）。FFI 效果层（win32.ts setTopmost/moveBelow/ownWindowsAbove）
// 由真机验收覆盖（popup-z-forensics 取证工具双形态判据）。
//
// 语义 =「对世界照抢、对自家让位」（#450 用户拍板候选 C）：
// - 条带上方**无**本进程可见窗：行为与旧版逐字一致——全量 HWND_TOPMOST 抢回置顶带顶
//   （对 explorer/第三方置顶窗的竞争面一寸不让，ADR-0007 守望职责不减）；
// - 条带上方**有**本进程可见窗（六菜单面浮层窗、hover 原生 tooltip——均诞生在置顶带内、
//   只是被旧版每拍 HWND_TOPMOST 插队反压，#450 取证 3 轮红）：改插到最低一枚自家窗正下方
//   ——重申仍在（置顶位丢失先回带），只是不再越过自家弹出物；
// - 走查不可判（ownAbove=null，极深链/条带销毁）：按「无自家窗」处理。误判方向安全：
//   把「有」当「无」= 退回旧版行为（让位白做，可观测不隐蔽）；把「无」当「有」才会漏让位。
export interface TopmostReassertPlan {
  /** 先全量抢回（HWND_TOPMOST）。置顶位丢失时必须先回带，插队才落在带内；无自家窗时这是唯一动作。 */
  jump: boolean
  /** 插到该窗正下方（自家让位目标 = 条带上方最低一枚本进程可见窗）；null = 无插队。 */
  below: number | null
}

/**
 * 裁决重申动作。输入：条带置顶位事实 + 条带上方自家窗走查结果（高→低序，null=不可判）。
 * 输出效果层两原语的执行计划（jump → setTopmost(true)；below → moveBelow）。
 */
export function planTopmostReassert(input: { topmost: boolean; ownAbove: readonly number[] | null }): TopmostReassertPlan {
  const above = input.ownAbove ?? []
  if (above.length === 0) return { jump: true, below: null }
  const lowest = above[above.length - 1] // 走查序高→低，末位即最低：插其下=在全部自家窗之下
  return input.topmost ? { jump: false, below: lowest } : { jump: true, below: lowest }
}
