// 逃生口触发判据（工单480，ADR-0032 韧性基线三件套）：面板瘫痪期把原生任务栏还原给
// 系统的退路——冻结失能档与崩溃两入口触发自动还原，面板恢复后重新接管；另有手动热键
// 随时强制还原作保险丝。与任务栏设置浮层的「逃生开关」（用户偏好切回，GLOSSARY 词汇
// 分立）不是一回事：开关改用户偏好落 config，逃生口不碰偏好、只在瘫痪期暂敛接管。
//
// 分层（与仓库纯函数域先例同构：render-sentinel.ts 的 silenceVerdict / native-restore.ts
// 的 planRestore）：本模块零 Electron 零 IO——只吃调用方喂入的相位与事实，裁决「开不开
// 逃生口、还不还接管」；还原与重接管的效果面（setTray/destroy/create——复用既有还原账
// appbar-ledger 与还原守护通道）由任务栏控制器（window.ts）执行，离线不可测的面由
// 50-taskbar-carry 电池覆盖。不新造还原机制：逃生口的还原动作就是既有交还三件套的
// destroy 路径（reason=escape-hatch），重接管就是既有 create 路径。
//
// 状态机两相：standby = 接管在effect（原生栏由我托管）；escaped = 原生栏已按逃生口还原
// （接管暂敛，欠一笔「恢复后重新接管」的债）。入口四事件：失能档（哨兵 renderer-frozen
// 发射）、崩溃（面板渲染进程 render-process-gone 非正常退出）、恢复（renderer-unfrozen
// 闭合）、手动（全局热键）。失能档发射一轮一条（#91），崩溃后不会再有心跳——两入口都
// 只欠同一笔债，逃逸后其余入口幂等不重复。

/** 一次逃生口裁决的入口事件 */
export type EscapeHatchEntry =
  | { kind: 'frozen' }
  /** 崩溃入口：宿主侧补两桩事实——cleanExit = 渲染进程正常退出（clean-exit，退出序列
   *  的伴生事件，非崩溃）；windowDestroyed = 面板窗已销毁（退出序列，既有路径已还） */
  | { kind: 'crash'; cleanExit: boolean; windowDestroyed: boolean }
  | { kind: 'recovered' }
  | { kind: 'manual' }

/** 相位：standby = 接管在场；escaped = 原生栏已按逃生口还原（欠一次重新接管） */
export type EscapeHatchPhase = 'standby' | 'escaped'

/**
 * 手动热键（保险丝，工单480）：全局热键随时强制还原原生任务栏——防自动检测本身失灵。
 * 键位取舍：Ctrl+Alt+Shift+T（T=taskbar）——四修饰组合与常见应用冲突概率最低；
 * 注册失败（被占用）落存证不破启动。电池经本常量注入同款键序（SendInput）。
 */
export const ESCAPE_HATCH_HOTKEY = 'Control+Alt+Shift+T'

/** 宿主喂入的接管事实（控制器闭包账面与用户偏好，本模块不持账） */
export interface EscapeHatchFacts {
  /** 接管在场（条带窗活着 = 原生栏确由我托管；不在场 = 无债可还） */
  readonly takeoverEngaged: boolean
  /** 用户偏好仍要接管（config.taskbar.enabled——偏好优先于逃生口的一切动作） */
  readonly takeoverWanted: boolean
}

/** 裁决动作：none = 不动作；restore-native = 开逃生口（原生栏还原给系统）；
 *  retake = 还债（面板恢复，重新接管） */
export type EscapeHatchAction = 'none' | 'restore-native' | 'retake'

export interface EscapeHatchDecision {
  readonly next: EscapeHatchPhase
  readonly action: EscapeHatchAction
}

const NONE_STANDBY: EscapeHatchDecision = Object.freeze({ next: 'standby', action: 'none' })
const NONE_ESCAPED: EscapeHatchDecision = Object.freeze({ next: 'escaped', action: 'none' })

/**
 * 裁决（离线矩阵穷举见 tests/taskbar/escape-hatch.spec.ts）：
 * - 失能档：接管在场且未逃逸 → 开逃生口；接管不在场（原生栏本就归用户）或已在
 *   逃生口（一轮冻结一条发射，重复还原只会把交还三件套空转一遍）→ 不动作。
 */
export function escapeHatchDecide(
  phase: EscapeHatchPhase,
  entry: EscapeHatchEntry,
  facts: EscapeHatchFacts,
): EscapeHatchDecision {
  if (entry.kind === 'frozen') {
    if (!facts.takeoverEngaged || phase === 'escaped') return phase === 'escaped' ? NONE_ESCAPED : NONE_STANDBY
    return { next: 'escaped', action: 'restore-native' }
  }
  if (entry.kind === 'crash') {
    // 退出序列的伴生形态（clean-exit / 窗已销）不是崩溃：正常退出走既有还原三路径
    //（面板退避 → 守卫 → 还原守护），逃生口不再插一脚。
    if (entry.cleanExit || entry.windowDestroyed) return NONE_STANDBY
    if (!facts.takeoverEngaged || phase === 'escaped') return phase === 'escaped' ? NONE_ESCAPED : NONE_STANDBY
    return { next: 'escaped', action: 'restore-native' }
  }
  if (entry.kind === 'recovered') {
    // 心跳回归只还「逃逸时立下的债」：manual 逃逸前的健康心跳、standby 期的闭合记录
    // 都没有欠债——重接管的唯一凭据是逃逸账本身。
    return phase === 'escaped' && facts.takeoverWanted
      ? { next: 'standby', action: 'retake' }
      : NONE_STANDBY
  }
  if (entry.kind === 'manual') {
    // 热键 toggle：standby 健康时按下 = 强制还原（保险丝）；escaped 再按 = 恢复接管。
    // 偏好已禁用接管时原生栏本就归用户：不动作（开不出也还不着）。
    if (!facts.takeoverWanted) return NONE_STANDBY
    return phase === 'escaped' ? { next: 'standby', action: 'retake' } : { next: 'escaped', action: 'restore-native' }
  }
  return NONE_STANDBY
}
