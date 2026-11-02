// 桌面工作区纯逻辑（工单375，spec #369 决策 2/4/13）：配对解析、当前模式映射、切换
// 决策与确认判据。零 IO、零 FFI、零 electron——系统桌面 ID 事实由调用方喂入
// （DesktopSetFacts），离线 vitest 矩阵直驱；FFI 采集在 virtual-desktop.ts，编排在其上
// 的 services/desktop-workspace.ts（三段分工同 taskbar 的 apps-plan/services 分层）。
//
// 判定口径（t371 探针在案）：桌面身份一律是**系统桌面 ID**（GUID 标准形字符串）——
// 注册表集合（VirtualDesktopIDs）与内部 COM GetCurrentDesktop 经同一换算产出，比对按
// 原文等值；「点了/调了就当成功」的乐观状态在本层无法表达（确认函数只认 ID 回读）。

/** 一次桌面集合事实快照（注册表单查询原子读 + 内部 COM 双源，调用方合成） */
export interface DesktopSetFacts {
  /** 系统桌面全集合（GUID 原文；空 = 事实不可读——调用方按失败关闭处理） */
  ids: readonly string[]
  /** 当前桌面 ID（null = 本拍不可读，不参与判定） */
  current: string | null
  /** 内部 COM 直读的当前桌面 ID（第二事实源；null = 本拍不可读） */
  internalCurrent?: string | null
}

/** 已配对桌面身份（config agentDesktop 持久化的最小形态；空串 = 该侧未配对） */
export interface StoredPairing {
  normalId: string
  agentId: string
}

/** 配对解析结论（工单375）：ok = 双侧在册；partial = 单侧失效（失效侧清空，保留在册侧，
 *  下次配对动作以此为原料补齐）；unpaired = 无存储或双侧失效——进入未配对安全态。 */
export type PairingResolution =
  | { kind: 'ok'; pairing: StoredPairing }
  | { kind: 'partial'; pairing: StoredPairing }
  | { kind: 'unpaired' }

/**
 * 配对解析（工单375）：以系统桌面集合核对存储的配对身份。身份失效（用户在 TaskView
 * 删了桌面）不清算另一侧——普通桌面被删但 Agent 还在时，Agent 桌面与其中窗口的既有
 * 事实不该被吞并（ADR-0028「其他桌面不受托管」的对称纪律）；补齐配对由下一次显式
 * 配对动作完成（本层不产生创建桌面的决定）。
 */
export function resolvePairing(stored: StoredPairing | null, facts: DesktopSetFacts): PairingResolution {
  const normalOk = Boolean(stored?.normalId) && facts.ids.includes(stored!.normalId)
  const agentOk = Boolean(stored?.agentId) && facts.ids.includes(stored!.agentId)
  if (normalOk && agentOk) return { kind: 'ok', pairing: { normalId: stored!.normalId, agentId: stored!.agentId } }
  if (!normalOk && !agentOk) return { kind: 'unpaired' }
  return {
    kind: 'partial',
    pairing: { normalId: normalOk ? stored!.normalId : '', agentId: agentOk ? stored!.agentId : '' },
  }
}

/**
 * 当前模式映射（工单375，spec #369 决策 2 三值口径）：配对在册且当前 ID 命中 → 对应
 * 模式；未配对/当前不在配对内（含第三桌面）→ unmanaged。多源互证口径：注册表当前与
 * 内部 COM 直读**都在场且不一致**时按「本拍事实打架」处理——返回 unmanaged 不提交任何
 * 一侧（下一拍重对账），不拿单源冒充事实（t371 判定纪律）。
 */
export function modeOfCurrent(facts: DesktopSetFacts, pairing: StoredPairing | null): 'normal' | 'agent' | 'unmanaged' {
  if (!facts.current) return 'unmanaged'
  if (facts.internalCurrent != null && facts.internalCurrent !== facts.current) return 'unmanaged'
  if (pairing && facts.current === pairing.normalId) return 'normal'
  if (pairing && facts.current === pairing.agentId) return 'agent'
  return 'unmanaged'
}

/** 切换决策（工单375，spec #369 决策 4 单飞串行）：在途忽略、同态空转、其余执行。 */
export type SwitchDecision =
  | { action: 'in-flight' }
  | { action: 'no-op' }
  | { action: 'switch'; targetId: string }

export function decideSwitch(
  input: { switching: boolean; pairing: StoredPairing | null; current: 'normal' | 'agent' | 'unmanaged' },
  target: 'normal' | 'agent',
): SwitchDecision {
  if (input.switching) return { action: 'in-flight' }
  if (input.pairing && input.current === target) return { action: 'no-op' }
  const targetId = target === 'agent' ? input.pairing?.agentId ?? '' : input.pairing?.normalId ?? ''
  if (!targetId) return { action: 'switch', targetId: '' } // 未配对：编排层先配对再切
  return { action: 'switch', targetId }
}

/**
 * 切换确认判据（工单375，spec #369 决策 4「只有系统桌面 ID 与目标一致才提交 UI」）：
 * 注册表当前 + 内部 COM 直读双源都命中目标才算确认——单源在场按未确认继续等（预算内），
 * 预算耗尽即失败（失败关闭，不乐观提交）。
 */
export function switchConfirmed(facts: DesktopSetFacts, targetId: string): boolean {
  if (!targetId) return false
  if (facts.current !== targetId) return false
  if (facts.internalCurrent != null && facts.internalCurrent !== targetId) return false
  return true
}

/** 配对动作的原料核验（编排层配对前调）：系统当前 ID 必须可读，否则不得启动配对。 */
export function canPairNow(facts: DesktopSetFacts): boolean {
  return Boolean(facts.current) && facts.ids.length > 0
}

/** 首次配对（工单375 验收①）：普通 = 当下所在桌面（既有窗口不迁移），Agent = 新建
 *  （首次为空）。输入新建成功后的 Agent ID；本函数只组装配对身份，不落盘。 */
export function firstPairing(normalId: string, agentId: string): StoredPairing {
  return { normalId, agentId }
}
