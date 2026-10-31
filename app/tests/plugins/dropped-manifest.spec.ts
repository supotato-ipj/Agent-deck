import { describe, expect, it } from 'vitest'
import {
  DROPPED_VIEW_SEGMENTS,
  classifyDroppedManifest,
  type DroppedManifest,
} from '../../src/main/plugins/dropped-manifest'
import { currentHostApiVersion } from '../../src/main/plugins/catalog'

/**
 * 投放包 manifest 迁移分类（工单331，ADR-0025）：旧包（缺主版本）、未知权限、
 * 宿主 API 不兼容 → 结构化迁移错误（进待迁移态，可读原因）；
 * 当前主版本零权限包 → 通过。结构错（缺 id/name/entry）沿用旧 error 语义。
 */

function base(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'widget-a', name: '组件A', version: '1.0.0', entry: './card.js',
    hostApiVersion: currentHostApiVersion(),
    ...over,
  }
}

const OK: DroppedManifest = {
  id: 'widget-a', name: '组件A', version: '1.0.0', entry: './card.js',
  hostApiVersion: currentHostApiVersion(),
  permissions: [], optionalPermissions: [], networkOrigins: [],
  capabilities: [],
}

describe('当前主版本包（AC1 零权限投放即生效的入口）', () => {
  it('零权限包通过：permissions 缺省 = 空清单', () => {
    const r = classifyDroppedManifest(base())
    expect(r).toEqual({ ok: true, manifest: OK })
  })

  it('显式空权限数组等价缺省；capabilities 声明在投放四段内照收', () => {
    const r = classifyDroppedManifest(base({ permissions: [], optionalPermissions: [], capabilities: ['clock', 'settings'] }))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.manifest.permissions).toEqual([])
      expect(r.manifest.capabilities).toEqual(['clock', 'settings'])
    }
  })

  it('capabilities 越档/未知串静默裁剪（投放宽松：少给而非不给），不使 manifest 失效', () => {
    const r = classifyDroppedManifest(base({ capabilities: ['clock', 'sessions', 'desktop', 'bogus'] }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.manifest.capabilities).toEqual(['clock'])
  })

  it('重复 capabilities 去重', () => {
    const r = classifyDroppedManifest(base({ capabilities: ['clock', 'clock'] }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.manifest.capabilities).toEqual(['clock'])
  })
})

describe('旧包迁移错误（AC5：缺失主版本 / 未知权限 / API 不兼容 → 待迁移态）', () => {
  it('缺 hostApiVersion = 旧模型包 → host_api_version_missing，可读中文原因', () => {
    const raw = base()
    delete raw.hostApiVersion
    const r = classifyDroppedManifest(raw)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.issues.map((i) => i.code)).toEqual(['host_api_version_missing'])
      expect(r.issues[0].message).toContain('hostApiVersion')
      expect(r.issues[0].message.length).toBeGreaterThan(10)
    }
  })

  it('hostApiVersion 非当前主版本（更高/更低）→ host_api_version_unsupported，带 expected/actual', () => {
    for (const v of [currentHostApiVersion() + 1, currentHostApiVersion() - 1, 99]) {
      const r = classifyDroppedManifest(base({ hostApiVersion: v }))
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.issues[0].code).toBe('host_api_version_unsupported')
        expect(r.issues[0].expected).toBe(currentHostApiVersion())
        expect(r.issues[0].actual).toBe(v)
      }
    }
  })

  it('hostApiVersion 非整数（字符串/小数）→ 同样归迁移错（不是崩溃）', () => {
    for (const v of ['1', 1.5, null, true]) {
      const r = classifyDroppedManifest(base({ hostApiVersion: v }))
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.issues[0].code).toBe('host_api_version_unsupported')
    }
  })

  it('未知权限 → permission_unknown，报告未知串清单；已知权限不误报', () => {
    const r = classifyDroppedManifest(base({ permissions: ['media.read', 'fs.raw', 'network.root'] }))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.issues.map((i) => i.code)).toEqual(['permission_unknown'])
      expect(r.issues[0].unknown).toEqual(['fs.raw', 'network.root'])
    }
  })

  it('permissions 非字符串数组（对象/数字）→ permission_unknown 迁移错', () => {
    for (const p of [{ steal: true }, 42, 'media.read']) {
      const r = classifyDroppedManifest(base({ permissions: p }))
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.issues[0].code).toBe('permission_unknown')
    }
  })

  it('多个迁移问题一次报全（缺主版本 + 未知权限同现，顺序确定）', () => {
    const raw = base({ permissions: ['media.read', 'shell.exec'] })
    delete raw.hostApiVersion
    const r = classifyDroppedManifest(raw)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.issues.map((i) => i.code)).toEqual(['host_api_version_missing', 'permission_unknown'])
    }
  })

  it('迁移错误不落执行：分类结果不含可激活的 manifest', () => {
    const r = classifyDroppedManifest(base({ hostApiVersion: 99 }))
    expect((r as { manifest?: DroppedManifest }).manifest).toBeUndefined()
  })
})

describe('结构错沿用旧语义（不属迁移，进 error 态）', () => {
  it('缺 id / name / version / entry → structural 错误', () => {
    for (const key of ['id', 'name', 'version', 'entry']) {
      const raw = base()
      delete raw[key]
      const r = classifyDroppedManifest(raw)
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.issues[0].code).toBe('manifest_invalid')
        expect(r.issues[0].message).toContain(String(key))
      }
    }
  })

  it('id 字符集非法 / entry 越界（绝对路径、.. 穿越反斜杠）→ structural 错误', () => {
    for (const raw of [
      base({ id: 'Bad-ID' }),
      base({ entry: '/etc/passwd.js' }),
      base({ entry: '../outside.js' }),
      base({ entry: 'a\\b.js' }),
    ]) {
      const r = classifyDroppedManifest(raw)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.issues[0].code).toBe('manifest_invalid')
    }
  })

  it('非对象输入 → structural 错误', () => {
    for (const raw of [null, 'x', 42, []]) {
      const r = classifyDroppedManifest(raw)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.issues[0].code).toBe('manifest_invalid')
    }
  })
})

describe('networkOrigins 声明（工单338）：纯 origin、与权限成对', () => {
  it('声明 network.request + 纯 origin 清单 → 正典化并去重（大小写/默认端口归一）', () => {
    const r = classifyDroppedManifest(base({ permissions: ['network.request'], networkOrigins: ['HTTP://127.0.0.1:47823', 'http://127.0.0.1:47823/'] }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.manifest.networkOrigins).toEqual(['http://127.0.0.1:47823'])
  })

  it('{ origin } 对象写法同样接受（DSH 生成面的结构化形状）', () => {
    const r = classifyDroppedManifest(base({ optionalPermissions: ['network.request'], networkOrigins: [{ origin: 'http://127.0.0.1:47824' }] }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.manifest.networkOrigins).toEqual(['http://127.0.0.1:47824'])
  })

  it('带路径/查询/片段或非 http(s) → network_origin_invalid（不猜前缀授权）', () => {
    for (const bad of ['http://127.0.0.1:47823/api', 'http://127.0.0.1:47823/?q=1', 'ws://127.0.0.1:47823', 'not-a-url']) {
      const r = classifyDroppedManifest(base({ permissions: ['network.request'], networkOrigins: [bad] }))
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.issues.some((i) => i.code === 'network_origin_invalid')).toBe(true)
    }
  })

  it('声明 network.request 但清单为空 → network_origin_required', () => {
    const r = classifyDroppedManifest(base({ permissions: ['network.request'] }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues.map((i) => i.code)).toContain('network_origin_required')
  })

  it('给了 origin 清单但没声明 network.request → network_origin_without_permission', () => {
    const r = classifyDroppedManifest(base({ networkOrigins: ['http://127.0.0.1:47823'] }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues.map((i) => i.code)).toContain('network_origin_without_permission')
  })
})

describe('投放档 view 段上限（正典登记，与解析器同源）', () => {
  it('DROPPED_VIEW_SEGMENTS = clock/hardware/layout/settings/media（四段 + 工单336 媒体段）', () => {
    expect([...DROPPED_VIEW_SEGMENTS]).toEqual(['clock', 'hardware', 'layout', 'settings', 'media'])
    expect(Object.isFrozen(DROPPED_VIEW_SEGMENTS)).toBe(true)
  })
})
