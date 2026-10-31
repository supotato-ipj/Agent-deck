// 管理型会话凭证登记处（工单333，ADR-0017「后端会话凭证」/ ADR-0018 管理授权）：
//
// - 每个管理型会话独立签发高熵随机 bearer（32 字节 CSPRNG → base64url），**只存内存**
//   （Map 键值），随会话存亡——显式结束、后端进程退出、面板重启、MCP 宿主重拉均失效；
//   对话窗收起不失效（沿用 ADR-0017，无空闲超时）。会话内不轮换；新会话一律新凭证。
// - 身份只由主进程从通道绑定推导：authenticate 只认自己签发过的 token，绝不采信参数
//   自报的 sessionId/trust（ADR-0017「身份只能来自通道绑定」）。
// - 无任何序列化/落盘出口：凭证绝不落盘（含日志与存证）——红线。
//
// 本模块零依赖（node:crypto），离线 Vitest 全覆盖。

import { randomBytes } from 'node:crypto'

export class SessionCredentialRegistry {
  /** token 主体（不含 Bearer 前缀）→ 会话 id */
  private readonly byToken = new Map<string, string>()
  /** 会话 id → 当前 token（重签时换键） */
  private readonly bySession = new Map<string, string>()

  /** 为会话签发 bearer（返回完整 Authorization 头值）。重签 = 旧 token 即刻作废 */
  issue(sessionId: string): string {
    const prev = this.bySession.get(sessionId)
    if (prev) this.byToken.delete(prev)
    const token = randomBytes(32).toString('base64url')
    this.byToken.set(token, sessionId)
    this.bySession.set(sessionId, token)
    return `Bearer ${token}`
  }

  /** 通道绑定认证：Authorization 头值 → 会话 id；一切形状不符/未知 → null（不抛） */
  authenticate(headerValue: string | undefined | null): string | null {
    if (typeof headerValue !== 'string') return null
    if (!headerValue.startsWith('Bearer ')) return null
    const token = headerValue.slice('Bearer '.length)
    return this.byToken.get(token) ?? null
  }

  /** 会话结束/进程退出：该会话凭证即时失效（幂等） */
  revoke(sessionId: string): void {
    const token = this.bySession.get(sessionId)
    if (token) {
      this.byToken.delete(token)
      this.bySession.delete(sessionId)
    }
  }

  /** MCP 宿主重拉：全部凭证即时失效（ADR-0017——宿主重拉后原会话只能聊天） */
  revokeAll(): void {
    this.byToken.clear()
    this.bySession.clear()
  }

  /** 在册凭证数（观测缝，不含 token 本体） */
  size(): number {
    return this.byToken.size
  }
}
