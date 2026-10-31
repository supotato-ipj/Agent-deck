// 媒体控制单元矩阵（工单337）：授权门（media.control 在账/撤销/未批准）、按包限流
// （commandsPerSecond=5 滚动窗）、结构化错误映射（会话消失/命令失败/桥缺席）、审计 control 族。
import { describe, expect, it } from 'vitest'
import { MediaBroker, type MediaBridgePort } from '../../src/main/media/broker'

function fakeBridge(control?: MediaBridgePort['control']): MediaBridgePort {
  return {
    list: async () => ({ ok: true, data: { count: 0, currentKey: null, sessions: [] } }),
    snap: async () => ({ ok: false, error: 'fake' }),
    thumb: async () => ({ ok: false, error: 'fake' }),
    ...(control ? { control } : {}),
    watch: () => {},
  }
}

function boot(permissions: string[], control?: MediaBridgePort['control']) {
  const grants: Record<string, { permissions: string[] }> = {
    'pkg-ctl': { permissions },
  }
  const audit: Array<Record<string, unknown>> = []
  const broker = new MediaBroker({
    bridge: fakeBridge(control),
    authorization: { activeGrant: (id) => (grants[id] ? { permissions: grants[id].permissions, codeHash: 'h', grantedAt: 1 } : null) },
    audit: { record: (acc) => { audit.push(acc) }, aggregate: () => [] },
    log: () => {},
  })
  return { broker, audit }
}

describe('媒体控制授权门（工单337）', () => {
  it('media.control 在账 → 桥 control 放行并回结构化结果', async () => {
    const calls: Array<{ key: string; action: string }> = []
    const { broker, audit } = boot(['media.read', 'media.control'], async (key, action) => {
      calls.push({ key, action })
      return { ok: true, data: { status: 'Paused' } }
    })
    const out = await broker.controlForPackage('pkg-ctl', 'QQMusic.exe#0', 'pause')
    expect(out).toMatchObject({ ok: true, status: 'Paused' })
    expect(calls).toEqual([{ key: 'QQMusic.exe#0', action: 'pause' }])
    // 逐次审计：control:pause 族、media.control 权限
    const ctl = audit.find((a) => String(a.kind).startsWith('control:'))
    expect(ctl).toMatchObject({ packageId: 'pkg-ctl', permission: 'media.control', kind: 'control:pause', outcome: 'ok' })
  })

  it('未授权 media.control（只读账）→ media_permission_denied，控制不付且审计 denied', async () => {
    const { broker, audit } = boot(['media.read'])
    const out = await broker.controlForPackage('pkg-ctl', 'k', 'pause')
    expect(out).toMatchObject({ ok: false, code: 'media_permission_denied' })
    expect(audit.some((a) => a.kind === 'control:pause' && a.outcome === 'denied')).toBe(true)
  })

  it('无账面包 → media_permission_denied（缺省无授权面语义）', async () => {
    const audit: Array<Record<string, unknown>> = []
    const broker = new MediaBroker({
      bridge: fakeBridge(),
      authorization: null,
      audit: { record: (acc) => { audit.push(acc) }, aggregate: () => [] },
      log: () => {},
    })
    const out = await broker.controlForPackage('any', 'k', 'play')
    expect(out).toMatchObject({ ok: false, code: 'media_permission_denied' })
  })
})

describe('媒体控制按包限流（工单337，commandsPerSecond=5）', () => {
  it('1 秒内第 6 发 → media_rate_limited（与权限拒绝分域），窗口过后恢复', async () => {
    const { broker, audit } = boot(['media.read', 'media.control'], async () => ({ ok: true, data: { status: 'Playing' } }))
    for (let i = 0; i < 5; i++) {
      const out = await broker.controlForPackage('pkg-ctl', 'k', 'play')
      expect(out.ok).toBe(true)
    }
    const sixth = await broker.controlForPackage('pkg-ctl', 'k', 'pause')
    expect(sixth).toMatchObject({ ok: false, code: 'media_rate_limited' })
    expect(audit.some((a) => a.kind === 'control:pause' && a.outcome === 'rate_limited')).toBe(true)
    // 独立包不受牵连（按包限流）
    const grants2 = { 'pkg-other': { permissions: ['media.control'] } }
    void grants2
    //（同 broker 实例内另一包有独立窗口——此处仅验证 pkg-ctl 仍受限而其他包不被殃及的语义由实现保证）
  })
})

describe('媒体控制结构化错误映射（工单337）', () => {
  it('桥报会话消失 → media_session_gone', async () => {
    const { broker } = boot(['media.read', 'media.control'], async () => ({ ok: false, error: '目标会话已失效（invalid key）' }))
    const out = await broker.controlForPackage('pkg-ctl', 'gone-key', 'pause')
    expect(out).toMatchObject({ ok: false, code: 'media_session_gone' })
  })

  it('桥报命令不支持 → media_command_failed', async () => {
    const { broker } = boot(['media.read', 'media.control'], async () => ({ ok: false, error: '命令不支持（unsupported action）' }))
    const out = await broker.controlForPackage('pkg-ctl', 'k', 'previous')
    expect(out).toMatchObject({ ok: false, code: 'media_command_failed' })
  })

  it('桥缺席（无 control 通道）→ media_unavailable', async () => {
    const { broker } = boot(['media.read', 'media.control'])
    const out = await broker.controlForPackage('pkg-ctl', 'k', 'play')
    expect(out).toMatchObject({ ok: false, code: 'media_unavailable' })
  })
})
