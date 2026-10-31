// DSH 浮动运行时接入状态机（工单340，ADR-0026「浮动最新、专属数据目录、失败不重置」）：
//
// - 版本号只记录不比对：任何 agentVersion 字符串（未知/怪形/未来版本）都不构成拒绝理由——
//   本模块没有版本白名单，也不存在按版本号拒绝的分支（票面验收标准 1 的实现级保证）。
// - 「未验收版本」标记恒在：accepted 是字面量 false 类型。面板侧没有「验收登记」写入路径
//   （ADR-0026：真实验收只记录当时版本，不把一次绿色结果写成永久兼容承诺），因此不存在
//   翻 true 的代码路径——类型系统即保证。
// - 冒烟门（管理型适用）：接入流程 = 解析描述符 → ACP initialize → 最小只读 MCP 冒烟
//   （复用工单333 独立宿主的只读投影：等 DSH 对注入宿主的 initialize/tools/list 探活）
//   → 通过才可创建会话。聊天型无 MCP 面，smoke = 'skipped'，握手通过即可用。
// - 冒烟失败按真实故障处理：不可用 + 补救指引；绝不自动降级、不把协议失败伪装成可用
//   （ADR-0026/0018）。

/** ACP initialize 握手实测的运行时身份（原样记录，不做语义解释） */
export interface DshRuntimeIdentity {
  agentName: string
  agentVersion: string
  protocolVersion: number
  agentCapabilities: Record<string, unknown>
}

/** 接入冒烟结果：passed/failed = 管理型宿主探活两态；skipped = 聊天型（无 MCP 面）；pending = 已握手未收口 */
export type SmokeStatus = 'pending' | 'passed' | 'failed' | 'skipped'

/** 运行时接入记录（诊断面板呈现源）。accepted 恒为 false——类型级保证无验收白名单路径 */
export interface DshRuntimeAccessRecord extends DshRuntimeIdentity {
  smoke: SmokeStatus
  accepted: false
  /** 记录时点（epoch ms） */
  at: number
}

export interface RuntimeAccessVerdict {
  /** 该次接入是否可用（冒烟通过/聊天跳过 = true；冒烟失败 = false）。版本号永不影响本值 */
  usable: boolean
  record: DshRuntimeAccessRecord
}

/** 接入裁定：identity + 冒烟结果 → 可用性 + 完整记录。版本字符串只进记录、永不参与判定 */
export function evaluateRuntimeAccess(
  identity: DshRuntimeIdentity,
  smoke: SmokeStatus,
  opts: { now?: () => number } = {},
): RuntimeAccessVerdict {
  const usable = smoke === 'passed' || smoke === 'skipped'
  return {
    usable,
    record: {
      agentName: identity.agentName,
      agentVersion: identity.agentVersion,
      protocolVersion: identity.protocolVersion,
      agentCapabilities: identity.agentCapabilities,
      smoke,
      accepted: false,
      at: (opts.now ?? (() => Date.now()))(),
    },
  }
}

/** 冒烟失败的补救指引（创建失败 error 面原文——票面标准 5：明确错误与补救指引） */
export function smokeFailureMessage(agentVersion: string): string {
  return (
    `后端未在时限内完成管理通道只读冒烟（版本 ${agentVersion}，MCP initialize/tools/list 探活未到达）——` +
    `按全有或全无不创建会话。可重试；或显式选择「以聊天型创建」（聊天接入无管理面，不依赖冒烟）。` +
    `若反复失败，请确认 DSH 可完整启动后再试。`
  )
}
