import { describe, expect, it } from 'vitest'
import { parseManifest } from '../../src/main/plugins/manifest'

/** 插件 manifest 契约（工单10 辅缝）：声明式契约的校验纯逻辑 */

const valid = {
  id: 'clock',
  name: '时钟',
  version: '1.0.0',
  entry: './card.js',
  capabilities: ['clock'],
}

describe('manifest 解析（工单10 桌面组件契约）', () => {
  it('合法 manifest 原样通过，mount/order 缺省时留空', () => {
    const r = parseManifest(valid)
    expect(r.error).toBeUndefined()
    expect(r.manifest).toMatchObject({ id: 'clock', name: '时钟', version: '1.0.0', entry: './card.js', capabilities: ['clock'] })
    expect(r.manifest?.mount).toBeUndefined()
    expect(r.manifest?.order).toBeUndefined()
  })

  it('mount 与 order 显式声明时保留', () => {
    const r = parseManifest({ ...valid, mount: 'clock-card', order: 30 })
    expect(r.manifest?.mount).toBe('clock-card')
    expect(r.manifest?.order).toBe(30)
  })

  it.each([
    ['顶层不是对象', 'x'],
    ['顶层是数组', [valid]],
    ['顶层是 null', null],
  ])('%s → 报错', (_label, raw) => {
    expect(parseManifest(raw).error).toMatch(/plugin\.json|manifest/)
  })

  it.each([
    ['缺 id', { ...valid, id: undefined }],
    ['id 非字符串', { ...valid, id: 42 }],
    ['id 为空', { ...valid, id: '' }],
    ['id 含大写（协议主机名不容许）', { ...valid, id: 'Clock' }],
    ['id 以点开头', { ...valid, id: '.clock' }],
    ['id 含斜杠', { ...valid, id: 'a/b' }],
  ])('%s → 报错', (_label, raw) => {
    expect(parseManifest(raw).error).toMatch(/id/)
  })

  it('id 命中原型键不靠字符集挡——查表一律走 Map（09 踩坑 1 的纪律，此处只验放行）', () => {
    // 禁掉 constructor/toString 这类 id 是自造规则；真正的防线是宿主/协议解析全程 Map 查表，
    // 结构性安全由 service/protocol 的用例证明（见 service.spec.ts「原型键 id 可寻址」）。
    expect(parseManifest({ ...valid, id: 'constructor' }).error).toBeUndefined()
    expect(parseManifest({ ...valid, id: 'tostring' }).error).toBeUndefined()
    // 大写混写的原型键名被字符集直接挡掉（主机名限小写）
    expect(parseManifest({ ...valid, id: 'toString' }).error).toMatch(/id/)
  })

  it.each([
    ['name 缺省', { ...valid, name: undefined }],
    ['name 空串', { ...valid, name: '   ' }],
    ['version 缺省', { ...valid, version: undefined }],
    ['entry 缺省', { ...valid, entry: undefined }],
    ['entry 非字符串', { ...valid, entry: 7 }],
    ['entry 非 .js/.mjs', { ...valid, entry: './card.txt' }],
    ['entry 绝对路径', { ...valid, entry: '/etc/passwd.js' }],
    ['entry 带盘符', { ...valid, entry: 'C:/x/card.js' }],
    ['entry 目录穿越', { ...valid, entry: '../outside/card.js' }],
    ['entry 内嵌穿越', { ...valid, entry: './sub/../../card.js' }],
    ['entry 反斜杠', { ...valid, entry: '.\\card.js' }],
  ])('%s → 报错', (_label, raw) => {
    expect(parseManifest(raw).error).toMatch(/name|version|entry/)
  })

  it('未知能力串静默丢弃，不使 manifest 失效（少给而非不给）', () => {
    const r = parseManifest({ ...valid, capabilities: ['clock', 'not-a-capability', 'kernel', 7] })
    expect(r.error).toBeUndefined()
    expect(r.manifest?.capabilities).toEqual(['clock'])
  })

  it('capabilities 非数组时按空能力处理（插件拿不到任何快照段，仍可渲染静态 UI）', () => {
    const r = parseManifest({ ...valid, capabilities: 'clock' })
    expect(r.error).toBeUndefined()
    expect(r.manifest?.capabilities).toEqual([])
  })

  it('order 非有限数时丢弃（不影响装载）', () => {
    const r = parseManifest({ ...valid, order: 'first' })
    expect(r.error).toBeUndefined()
    expect(r.manifest?.order).toBeUndefined()
  })

  it('mount 类型非法时丢弃', () => {
    const r = parseManifest({ ...valid, mount: 42 })
    expect(r.manifest?.mount).toBeUndefined()
  })

  it('id 允许数字、下划线、连字符（协议主机名的合法字符集）', () => {
    for (const id of ['a1', 'my-plugin', 'my_plugin', 'my.plugin', '0clock']) {
      expect(parseManifest({ ...valid, id }).error, id).toBeUndefined()
    }
  })
})
