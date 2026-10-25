// 收栏决策纯函数域模块的主进程侧转发导出（工单237，spec #236）。
//
// 实现本体住在 shared/retract.ts：收栏态横跨主进程与渲染层两端——三态裁决与前台探针在
// 主进程，唤出条几何（pill 矩形只有渲染层量得到）与唤出交互在渲染层。渲染层引用主进程
// 模块会让浏览器 ESM 解析失败（shared/overflow 头注释的同款理由），故单一实现住在 shared/，
// 主进程侧只做转发导出、**不另写一份实现**（工单237 修正 A2）。
// 先例：apps-plan.ts / tray-plan.ts 转出 shared/overflow 的同款做法。
export {
  ABS_ALWAYSONTOP,
  ABS_AUTOHIDE,
  COVER_TOLERANCE,
  DESKTOP_HOST_CLASSES,
  SUMMON_GRACE_MS,
  SUMMON_HOVER_DELAY_MS,
  SUMMON_STRIP_HIT_HEIGHT,
  SUMMON_STRIP_MIN_WIDTH,
  SUMMON_STRIP_VISUAL_HEIGHT,
  coversScreenRect,
  initialSummonState,
  normalBarAutoHideState,
  planBarTransition,
  planSummonStrips,
  reduceSummon,
  reduceSummonSequence,
  resolveBarMode,
  retractAutoHideState,
  retractGateDisqualified,
  retractHeldByZoomed,
  retractReasonHeld,
  summonedGroups,
} from '../../shared/retract'
export type {
  BarEvidenceEvent,
  BarMode,
  BarModeInput,
  BarTransitionContext,
  BarTransitionPlan,
  ForegroundProbe,
  PhysRect,
  SummonEvent,
  SummonEventType,
  SummonGroupState,
  SummonPillRect,
  SummonState,
  SummonStrip,
  SummonStripPlanInput,
} from '../../shared/retract'
