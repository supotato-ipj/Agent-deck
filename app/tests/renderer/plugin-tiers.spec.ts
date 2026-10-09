/**
 * 插件键盘档记账测试（工单100）：createPluginTierRegistry 直测——请求/释放去重、
 * 多插件分账、卸载强制回收（crash 安全；#101 停用持有键盘档的卡走同一条回收链）。
 * 记账只决定「要不要向归一仲裁发键盘档事件」，沿的产生与同相性归 keyboard-gate
 * 归约器（见 keyboard-gate.spec.ts 插件键盘档段），这里不发断言沿。
 * 在持与否一律用 hold/release 返回值探测（重复持拿 false = 已在账），不设观测口。
 */
import { describe, expect, it } from 'vitest'
import { createPluginTierRegistry } from '../../src/renderer/plugin-tiers'

describe('createPluginTierRegistry 请求/释放（工单100）', () => {
  it('新持拿返回 true（应发 tier-acquired），重复持拿返回 false（幂等噪声不发）', () => {
    const reg = createPluginTierRegistry()
    expect(reg.hold('search', 'search')).toBe(true)
    expect(reg.hold('search', 'search')).toBe(false) // 去重生效 = 档确已在账
  })
  it('在持释放返回 true（应发 tier-released），未持拿释放返回 false（噪声不发）', () => {
    const reg = createPluginTierRegistry()
    expect(reg.release('search', 'search')).toBe(false)
    reg.hold('search', 'search')
    expect(reg.release('search', 'search')).toBe(true)
    expect(reg.release('search', 'search')).toBe(false) // 二次释放落空 = 账面已清
  })
  it('多插件分账：同档名互不串账（名字宿主侧已带插件 id 命名空间）', () => {
    const reg = createPluginTierRegistry()
    expect(reg.hold('search', 'search')).toBe(true)
    expect(reg.hold('note', 'search')).toBe(true)
    expect(reg.hold('search', 'search')).toBe(false) // search 账上在持
    expect(reg.hold('note', 'search')).toBe(false) // note 账上也在持
    expect(reg.release('search', 'search')).toBe(true)
    expect(reg.hold('note', 'search')).toBe(false) // search 的释放不波及 note 在持
  })
})

describe('createPluginTierRegistry 强制回收（crash 安全；#101 停用回收衔接点）', () => {
  it('unmount 未释放：reclaim 收走全部在持档并返回名单（宿主逐一发 tier-released）', () => {
    const reg = createPluginTierRegistry()
    reg.hold('search', 'search')
    reg.hold('search', 'overlay-x')
    expect(reg.reclaim('search')).toEqual(['search', 'overlay-x'])
    expect(reg.hold('search', 'search')).toBe(true) // 回收后账面已空：可重新持拿
  })
  it('插件已自行释放干净：reclaim 返回空（宿主零补偿动作）', () => {
    const reg = createPluginTierRegistry()
    reg.hold('search', 'search')
    reg.release('search', 'search')
    expect(reg.reclaim('search')).toEqual([])
  })
  it('回收后重装是干净起点：可重新持拿，且不影响其他插件在持档', () => {
    const reg = createPluginTierRegistry()
    reg.hold('search', 'search')
    reg.hold('note', 'input')
    reg.reclaim('search')
    expect(reg.hold('search', 'search')).toBe(true)
    expect(reg.hold('note', 'input')).toBe(false) // note 在持档不受他人回收影响
  })
  it('从未持拿的插件 reclaim 是空操作', () => {
    const reg = createPluginTierRegistry()
    expect(reg.reclaim('ghost')).toEqual([])
  })
})
