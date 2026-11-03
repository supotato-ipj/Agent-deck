// 标题栏拖入纯裁决（工单407，spec #403 决策「新增一个内部工作区拖入命令」+「拖入是
// 一次事务」）：命令门禁、迁移确认判据、回滚确认判据与有界预算常量。零 IO、零 FFI、
// 零 Electron——系统桌面 ID 事实由调用方喂入（workspace-plan 同款分层）；窗口资格裁决
// 复用 tile-scope.classifyTileWindow（单一口径，不在此重复）；FFI 采集在
// desktop/title-drag.ts（MOVESIZE 起止观察），编排在其上的 services/agent-drag-in.ts。
//
// 判定口径（t371/t407 探针在案）：桌面身份一律系统桌面 ID（GUID 标准形）比对按原文
// 等值；「移动受理就当成功」的乐观状态在本层无法表达——确认只认桌面 ID 回读
// （公开 IVirtualDesktopManager::GetWindowDesktopId，story 46）。

/** 拖入拒绝理由（对外可见原因——story 45「简短原因」的枚举面；不含窗口标题） */
export type DragInRejectReason =
  | 'unavailable' // 工作区不可用（开关关/平台能力缺席——失败关闭）
  | 'unpaired' // 未配对
  | 'not-normal-desktop' // 当前不在配对普通桌面（Agent/非托管桌面零拖入）
  | 'missing-pairing-id' // 配对缺侧（不拿半份配对猜迁移目标）
  | 'window-unknown' // 请求句柄不在窗口事实里
  | 'ineligible-window' // 窗口资格不合格（主屏/自家/工具窗/副屏……tile-scope 口径）
  | 'source-desktop-mismatch' // 源窗口不在配对普通桌面
  | 'move-failed' // 移动有界重试后仍不受理
  | 'move-unconfirmed' // 移动受理但桌面 ID 回读未确认（已回滚）
  | 'rollback-failed' // 回滚移动也不受理（如实上报，不伪造回滚成功）

/** 命令门禁输入（主进程自有事实，调用方不得自报） */
export interface DragInGateInput {
  workspaceAvailable: boolean
  paired: boolean
  currentMode: 'normal' | 'agent' | 'unmanaged'
  agentId: string | null
  normalId: string | null
}

export type DragInGate = { action: 'proceed' } | { action: 'reject'; reason: DragInRejectReason }

/**
 * 命令门禁（主进程重核第一道）：可用 → 配对 → 配对 ID 双侧在册 → 当前普通桌面。
 * 落放不切桌面是结构事实（本裁决层与编排层都没有切换桌面的通道）。
 */
export function decideDragInGate(input: DragInGateInput): DragInGate {
  if (!input.workspaceAvailable) return { action: 'reject', reason: 'unavailable' }
  if (!input.paired) return { action: 'reject', reason: 'unpaired' }
  if (!input.agentId || !input.normalId) return { action: 'reject', reason: 'missing-pairing-id' }
  if (input.currentMode !== 'normal') return { action: 'reject', reason: 'not-normal-desktop' }
  return { action: 'proceed' }
}

/** 零 GUID（P7 实证：新建/迁移中的窗首读全零——不等于归属，不参与确认比对） */
export function isZeroGuid(id: string | null | undefined): boolean {
  if (!id) return false
  return /^0{8}-/.test(id)
}

/**
 * 迁移确认判据（story 46「以桌面 ID 回读确认成功」）：公开 VDM 回读 = 配对 Agent 桌面
 * ID 且非零 GUID 才算确认；null/仍原桌面/其他桌面一律未确认（调用方有界轮询后回滚）。
 */
export function migrationConfirmed(readbackId: string | null, agentId: string): boolean {
  if (!readbackId || isZeroGuid(readbackId)) return false
  return readbackId === agentId
}

/** 回滚确认判据（story 47）：回读回到原普通桌面 ID 才算回滚成功；失败如实上报。 */
export function rollbackConfirmed(readbackId: string | null, normalId: string): boolean {
  if (!readbackId || isZeroGuid(readbackId)) return false
  return readbackId === normalId
}

// —— 有界预算（ADR-0028：桌面切换确认 ≤1s；重试有界不无限） ——
/** 迁移移动尝试上限（每次一个 MoveWindowToDesktop 调用） */
export const DRAG_IN_MOVE_ATTEMPTS = 3
/** 移动重试间隔（ms） */
export const DRAG_IN_MOVE_RETRY_DELAY_MS = 120
/** 迁移确认预算（ms；与 workspace 切换确认同口径 ≤1000） */
export const DRAG_IN_CONFIRM_TIMEOUT_MS = 1000
/** 确认轮询步进（ms；desktop-workspace 同款 60） */
export const DRAG_IN_CONFIRM_POLL_MS = 60
