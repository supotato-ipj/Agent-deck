// 浮动运行时接入状态机测试（工单340，ADR-0026）：
// - 版本号只记录不比对：任何版本字符串（含未知/怪形/未来版本）都不构成拒绝理由，
//   无白名单、无版本号拒绝路径（票面验收标准 1）
// - 「未验收版本」标记恒在：验收只记录不白名单，accepted 是字面量 false（票面标准 2）
// - 冒烟门：管理型 requires 冒烟通过；聊天型 skipped 即可用；冒烟失败=真实故障
//   （可用=false + 补救指引，票面标准 5）
import { describe, expect, it } from 'vitest'
import {
  evaluateRuntimeAccess,
  smokeFailureMessage,
  type DshRuntimeIdentity,
} from '../../src/main/conversation/runtime'

function identity(version: string, capabilities: Record<string, unknown> = { mcpCapabilities: { http: true } }): DshRuntimeIdentity {
  return {
    agentName: 'deepseek-harness-acp',
    agentVersion: version,
    protocolVersion: 1,
    agentCapabilities: capabilities,
  }
}

describe('浮动运行时接入状态机（工单340，ADR-0026）', () => {
  it('未知/怪形/未来版本一律乐观可用——版本号不是拒绝理由（无白名单）', () => {
    const versions = [
      '0.0.1',
      '0.2.1-rc.2',
      '0.2.1-rc.5',
      '99.99.99-future-unreleased',
      'not-a-semver',
      '',
      '0.2.1-rc.999-local-build-dirty',
    ]
    for (const v of versions) {
      const chat = evaluateRuntimeAccess(identity(v), 'skipped')
      expect(chat.usable, `版本 ${JSON.stringify(v)} 聊天接入必须乐观可用`).toBe(true)
      expect(chat.record.accepted, `版本 ${JSON.stringify(v)} 不得被标记为已验收`).toBe(false)
      const managed = evaluateRuntimeAccess(identity(v), 'passed')
      expect(managed.usable, `版本 ${JSON.stringify(v)} 冒烟通过后管理接入必须可用`).toBe(true)
    }
  })

  it('未验收标记恒在且记录实际身份：agent 名/版本/协议版本/协商能力/时点全量在案', () => {
    const caps = { mcpCapabilities: { http: true }, promptCapabilities: { image: false }, sessionCapabilities: { resume: {} } }
    const at = 1730000000000
    const r = evaluateRuntimeAccess(identity('0.2.1-rc.2', caps), 'passed', { now: () => at })
    expect(r.record).toEqual({
      agentName: 'deepseek-harness-acp',
      agentVersion: '0.2.1-rc.2',
      protocolVersion: 1,
      agentCapabilities: caps,
      smoke: 'passed',
      accepted: false,
      at,
    })
  })

  it('冒烟失败=真实故障：不可用 + 补救指引（不把协议失败伪装成可用）', () => {
    const r = evaluateRuntimeAccess(identity('0.2.1-rc.2'), 'failed')
    expect(r.usable).toBe(false)
    expect(r.record.accepted).toBe(false)
    expect(r.record.smoke).toBe('failed')
    expect(smokeFailureMessage('0.2.1-rc.2')).toContain('0.2.1-rc.2')
    expect(smokeFailureMessage('0.2.1-rc.2')).toContain('聊天型')
  })

  it('聊天型 skipped 冒烟不阻断：握手通过即可用（冒烟只适用管理型）', () => {
    const r = evaluateRuntimeAccess(identity('0.2.1-rc.2'), 'skipped')
    expect(r.usable).toBe(true)
    expect(r.record.smoke).toBe('skipped')
  })
})
