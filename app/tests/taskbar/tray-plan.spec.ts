// 托盘名单编排纯函数（工单56）：Windows 托盘事件流 → 栏内图标名单。
// 重点覆盖三件：NIM_MODIFY 的部分更新语义（无图不带图、无 tip 不清 tip）、
// 删除摘除、其余事件（setversion/setfocus/unknown）空转。
import { describe, expect, it } from 'vitest'
import { applyTrayEvent, planTrayOverflow, sameTrayIcons, trayIconKeyOf } from '../../src/main/taskbar/tray-plan'
import { trayPinnedMatch, trayPinnedMatcher } from '../../src/shared/overflow'
import type { TaskbarTrayEntry } from '../../src/shared/contract'
import { reapedTrayEvent } from '../../src/main/trayhost/protocol'
import type { TrayIconPixels, TrayWireEvent } from '../../src/main/trayhost/protocol'

const PIX: TrayIconPixels = { width: 16, height: 16, bgraBase64: 'AAAA' }

/** 回收事件（工单423）：面板侧广播，载荷 key/ownerPid/时刻 */
const reaped = (key: string): TrayWireEvent => reapedTrayEvent(key, 1234, 1762400000000)

function ev(over: Partial<TrayWireEvent> = {}): TrayWireEvent {
  return {
    kind: 'add',
    key: '100:1',
    hwnd: '100',
    uid: 1,
    guid: null,
    tooltip: '',
    callbackMessage: 0x0400,
    version: 0,
    flags: 0,
    hicon: null,
    ownerPid: null,
    reapedAt: null,
    ...over,
  }
}

describe('托盘名单编排', () => {
  it('空名单收 add 即追加（到达序）', () => {
    const out = applyTrayEvent([], ev({ tooltip: '滴答清单', icon: PIX }))
    expect(out).toHaveLength(1)
    expect(out[0].key).toBe('100:1')
    expect(out[0].tooltip).toBe('滴答清单')
    expect(out[0].iconKey).toBe(trayIconKeyOf(ev({ tooltip: '滴答清单', icon: PIX })))
  })

  it('像素键随像素变化（换图标即换键）', () => {
    const one = applyTrayEvent([], ev({ icon: PIX }))
    const two = applyTrayEvent(one, ev({ icon: { ...PIX, bgraBase64: 'BBBB' } }))
    expect(two[0].iconKey).not.toBe(one[0].iconKey)
  })

  it('delete 摘除对应条目，其余不动', () => {
    const list = applyTrayEvent(applyTrayEvent([], ev({ key: 'a:1' })), ev({ key: 'b:2' }))
    const out = applyTrayEvent(list, ev({ kind: 'delete', key: 'a:1' }))
    expect(out.map((i) => i.key)).toEqual(['b:2'])
  })

  it('delete 名单外身份：不抛、名单原样', () => {
    const list = applyTrayEvent([], ev({ key: 'a:1' }))
    expect(applyTrayEvent(list, ev({ kind: 'delete', key: 'zzz' }))).toEqual(list)
  })

  it('update 部分更新：只带 tip 不丢图', () => {
    const list = applyTrayEvent([], ev({ tooltip: 'OneDrive', icon: PIX }))
    const out = applyTrayEvent(list, ev({ kind: 'update', tooltip: 'OneDrive - 已同步' }))
    expect(out[0].tooltip).toBe('OneDrive - 已同步')
    expect(out[0].iconKey).toBe(list[0].iconKey)
  })

  it('update 部分更新：只带图不清 tip', () => {
    const list = applyTrayEvent([], ev({ tooltip: '联想电脑管家', icon: PIX }))
    const out = applyTrayEvent(list, ev({ kind: 'update', icon: PIX }))
    expect(out[0].tooltip).toBe('联想电脑管家')
  })

  it('update 空 tip 且无图：原引用返回（渲染层据此零重渲）', () => {
    const list = applyTrayEvent([], ev({ tooltip: 'Listary', icon: PIX }))
    expect(applyTrayEvent(list, ev({ kind: 'update' }))).toBe(list)
  })

  it('add 同 key 二次到达：就地覆盖不重复追加', () => {
    const list = applyTrayEvent([], ev({ tooltip: 'Steam', icon: PIX }))
    const out = applyTrayEvent(list, ev({ tooltip: 'Steam 正在运行' }))
    expect(out).toHaveLength(1)
    expect(out[0].tooltip).toBe('Steam 正在运行')
  })

  it('setversion / setfocus / unknown 空转（名单原引用）', () => {
    const list = applyTrayEvent([], ev({ tooltip: 'Steam', icon: PIX }))
    for (const kind of ['version', 'focus', 'unknown'] as const) {
      expect(applyTrayEvent(list, ev({ kind }))).toBe(list)
    }
  })

  // —— 回收（工单423）：宿主进程死亡 → 面板广播 reaped → 计划层剔除条目并重排，
  // 与 delete 同构（渲染侧无新增状态）。词汇对齐 GLOSSARY「回收」。 ——
  describe('reaped 剔除与重排收敛（工单423）', () => {
    it('reaped 摘除对应条目（与 delete 同构），其余条目次序不动', () => {
      const list = applyTrayEvent(applyTrayEvent(applyTrayEvent([], ev({ key: 'a:1' })), ev({ key: 'b:2' })), ev({ key: 'c:3' }))
      const out = applyTrayEvent(list, reaped('a:1'))
      expect(out.map((i) => i.key)).toEqual(['b:2', 'c:3'])
    })

    it('reaped 名单外身份（重复回收/竞态）：不抛，二次回收幂等（同单次回收结果）', () => {
      const list = applyTrayEvent([], ev({ key: 'a:1' }))
      const once = applyTrayEvent(list, reaped('a:1'))
      expect(applyTrayEvent(once, reaped('a:1'))).toEqual(once)
    })

    it('溢出条目自动回栏：栏内图标回收后重拆溢出，名单序尾的溢出条目补入', () => {
      let list: readonly TaskbarTrayEntry[] = []
      for (const k of ['a:1', 'b:2', 'c:3', 'd:4', 'e:5', 'f:6', 'g:7']) {
        list = applyTrayEvent(list, ev({ key: k }))
      }
      // 档位 5：名单序前 5 可见，第 6/7 枚入溢出（工单162 溢出语义）
      const over = planTrayOverflow(list, 5)
      expect(over.overflow.map((i) => i.key)).toEqual(['f:6', 'g:7'])
      // 栏内图标 a:1 被回收 → 名单剔除 → 重拆溢出：f:6 自动回栏，只剩 g:7
      const reapedList = applyTrayEvent(list, reaped('a:1'))
      const overAfter = planTrayOverflow(reapedList, 5)
      expect(overAfter.bar.map((i) => i.key)).toEqual(['b:2', 'c:3', 'd:4', 'e:5', 'f:6'])
      expect(overAfter.overflow.map((i) => i.key)).toEqual(['g:7'])
    })

    it('与 add/update/delete 混序账面一致：回收后同 key 重新 add 即重新入栏', () => {
      let list: readonly TaskbarTrayEntry[] = []
      list = applyTrayEvent(list, ev({ key: 'a:1', tooltip: '旧实例', icon: PIX }))
      list = applyTrayEvent(list, ev({ key: 'b:2', tooltip: '存活', icon: PIX }))
      list = applyTrayEvent(list, reaped('a:1'))
      expect(list.map((i) => i.key)).toEqual(['b:2'])
      list = applyTrayEvent(list, ev({ key: 'a:1', tooltip: '新实例', icon: PIX }))
      expect(list.map((i) => i.key)).toEqual(['b:2', 'a:1'])
      list = applyTrayEvent(list, ev({ kind: 'delete', key: 'b:2' }))
      expect(list.map((i) => i.key)).toEqual(['a:1'])
    })

    it('回收与 delete 互为冗余：先回收再 delete 不双重摘除、不抛', () => {
      let list: readonly TaskbarTrayEntry[] = applyTrayEvent([], ev({ key: 'a:1' }))
      list = applyTrayEvent(list, reaped('a:1'))
      list = applyTrayEvent(list, ev({ kind: 'delete', key: 'a:1' }))
      expect(list).toEqual([])
    })
  })

  it('sameTrayIcons 逐条比对（tooltip 与像素键都变才算变）', () => {
    const a: TaskbarTrayEntry[] = [{ key: 'a', tooltip: 'x', iconKey: 'i1' }]
    expect(sameTrayIcons(a, [{ key: 'a', tooltip: 'x', iconKey: 'i1' }])).toBe(true)
    expect(sameTrayIcons(a, [{ key: 'a', tooltip: 'y', iconKey: 'i1' }])).toBe(false)
    expect(sameTrayIcons(a, [{ key: 'a', tooltip: 'x', iconKey: 'i2' }])).toBe(false)
    expect(sameTrayIcons(a, [...a, { key: 'b', tooltip: '', iconKey: null }])).toBe(false)
  })
})

describe('托盘溢出拆分（工单162）：名单序前 N 可见、超量入溢出，数量回落自动回栏', () => {
  // 与应用组 planAppsOverflow 同形态，但语义不同源：档位是用户声明的可见数
  // （config 持久化），不是几何实测容量——「⋯」钮是额外铬件，**不吃档位名额**。
  const icons = (n: number): TaskbarTrayEntry[] =>
    Array.from({ length: n }, (_, i) => ({ key: `${100 + i}:1`, tooltip: `图标${i}`, iconKey: `k${i}` }))

  it('档位内全可见（含恰好齐档的边界）：无溢出、「⋯」不出场', () => {
    expect(planTrayOverflow(icons(3), 5)).toEqual({ bar: icons(3), overflow: [] })
    expect(planTrayOverflow(icons(5), 5)).toEqual({ bar: icons(5), overflow: [] })
  })

  it('超量取尾部：名单序前 5 可见，第 6 枚起进溢出（到达序即优先级）', () => {
    const { bar, overflow } = planTrayOverflow(icons(7), 5)
    expect(bar.map((i) => i.key)).toEqual(['100:1', '101:1', '102:1', '103:1', '104:1'])
    expect(overflow.map((i) => i.key)).toEqual(['105:1', '106:1'])
  })

  it('「⋯」不吃名额：档位 3 就是真的 3 枚可见（与容量语义的分界）', () => {
    const { bar } = planTrayOverflow(icons(8), 3)
    expect(bar).toHaveLength(3)
  })

  it('档位「全部」：永不溢出，「⋯」不出场', () => {
    expect(planTrayOverflow(icons(26), 'all')).toEqual({ bar: icons(26), overflow: [] })
    expect(planTrayOverflow([], 'all')).toEqual({ bar: [], overflow: [] })
  })

  it('数量回落自动回栏：图标退出使名单低于档位，重拆即溢出清空', () => {
    expect(planTrayOverflow(icons(7), 5).overflow).toHaveLength(2)
    const again = planTrayOverflow(icons(5), 5)
    expect(again.bar).toHaveLength(5)
    expect(again.overflow).toEqual([])
  })

  it('空名单恒双空；档位为 0 的退化输入全部入溢出（契约边界校验兜底，不炸）', () => {
    expect(planTrayOverflow([], 5)).toEqual({ bar: [], overflow: [] })
    expect(planTrayOverflow(icons(2), 0).overflow).toHaveLength(2)
  })

  it('输入不被改动，条目原样引用（不复制不重组字段）', () => {
    const entries = icons(4)
    const snapshot = entries.map((e) => ({ ...e }))
    const { bar, overflow } = planTrayOverflow(entries, 3)
    expect(bar[0]).toBe(entries[0])
    expect(overflow[0]).toBe(entries[3])
    expect(entries).toEqual(snapshot)
  })
})

// —— 托盘常驻豁免（工单462，GLOSSARY「托盘常驻」）：常驻集合作为 planTrayOverflow 的
// 谓词入参——名单内条目豁免切尾、永远平铺栏内；保持到达序原位不重排不跳位；档位只数
// 非常驻条目（「⋯」不吃名额语义不变）。数量回落（图标退出/解除常驻）重拆即自动回栏。 ——
describe('托盘常驻豁免溢出拆分（工单462）：档位只数非常驻、豁免条目保持到达序原位', () => {
  /** icons(n) 的第 i 枚（0 起）的 key */
  const keyOf = (i: number): string => `${100 + i}:1`
  const icons = (n: number): TaskbarTrayEntry[] =>
    Array.from({ length: n }, (_, i) => ({ key: `${100 + i}:1`, tooltip: `图标${i}`, iconKey: `k${i}` }))
  /** 常驻谓词：入参为 icons(n) 的下标集 */
  const pinnedAt = (...idx: number[]) => (e: TaskbarTrayEntry) => {
    const i = Number(e.key.split(':')[0]) - 100
    return idx.includes(i)
  }

  it('常驻豁免切尾：7 枚钉住第 2/6 枚（0 起）、档位 5 → 非常驻恰 5 枚全在栏、无溢出', () => {
    const { bar, overflow } = planTrayOverflow(icons(7), 5, pinnedAt(1, 5))
    expect(bar.map((i) => i.key)).toEqual([0, 1, 2, 3, 4, 5, 6].map(keyOf))
    expect(overflow).toEqual([])
  })

  it('非常驻超量仍切尾：8 枚钉住末枚、档位 5 → 栏内 = 前 5 非常驻 + 常驻（原位殿后）、溢出 = 余下非常驻', () => {
    const { bar, overflow } = planTrayOverflow(icons(8), 5, pinnedAt(7))
    expect(bar.map((i) => i.key)).toEqual([0, 1, 2, 3, 4, 7].map(keyOf))
    expect(overflow.map((i) => i.key)).toEqual([5, 6].map(keyOf))
  })

  it('保持到达序原位不重排：中段常驻条目钉在原位，两侧非常驻按序排布、不跳位不聚块', () => {
    const { bar } = planTrayOverflow(icons(8), 3, pinnedAt(2, 5))
    expect(bar.map((i) => i.key)).toEqual([0, 1, 2, 3, 5].map(keyOf))
    expect(planTrayOverflow(icons(8), 3, pinnedAt(2, 5)).overflow.map((i) => i.key)).toEqual([4, 6, 7].map(keyOf))
  })

  it('全部常驻：档位再小也全在栏、溢出恒空（豁免不吃档位名额）', () => {
    const { bar, overflow } = planTrayOverflow(icons(5), 3, pinnedAt(0, 1, 2, 3, 4))
    expect(bar).toHaveLength(5)
    expect(overflow).toEqual([])
  })

  it('档位「全部」：常驻与否全在栏（豁免语义在无溢出档下无感）', () => {
    const { bar, overflow } = planTrayOverflow(icons(6), 'all', pinnedAt(0, 3))
    expect(bar).toHaveLength(6)
    expect(overflow).toEqual([])
  })

  it('解除常驻即回旧账：同名单重拆，被解条目按非常驻参与切尾（勾选可逆）', () => {
    const { bar, overflow } = planTrayOverflow(icons(8), 5, pinnedAt(7))
    expect(overflow.map((i) => i.key)).toEqual([5, 6].map(keyOf))
    const off = planTrayOverflow(icons(8), 5, pinnedAt())
    expect(off.bar.map((i) => i.key)).toEqual([0, 1, 2, 3, 4].map(keyOf))
    expect(off.overflow.map((i) => i.key)).toEqual([5, 6, 7].map(keyOf))
  })

  it('谓词缺省 = 旧语义逐字不变（不传常驻集合的调用方零行为漂移）', () => {
    expect(planTrayOverflow(icons(7), 5)).toEqual({ bar: icons(5), overflow: icons(7).slice(5) })
    expect(planTrayOverflow(icons(2), 0, () => false).overflow).toHaveLength(2)
  })

  it('输入不被改动、条目原样引用（与无常驻版同一纪律）', () => {
    const entries = icons(6)
    const snapshot = entries.map((e) => ({ ...e }))
    const { bar, overflow } = planTrayOverflow(entries, 3, pinnedAt(4))
    expect(bar.map((i) => i.key)).toEqual([0, 1, 2, 4].map(keyOf))
    expect(overflow.map((i) => i.key)).toEqual([3, 5].map(keyOf))
    expect(bar[3]).toBe(entries[4])
    expect(entries).toEqual(snapshot)
  })
})

// —— 常驻匹配纯函数（工单462）：{标识, 名字} 二元记录对条目的匹配——先标识后名字
// （GLOSSARY「托盘常驻」双保险记账：标识 = 图标身份键 guid:<guid> / <hwnd>:<uid>，
// 重启后 hwnd 类标识可能漂移；名字 = 勾选时刻 tooltip 兜底）。 ——
describe('托盘常驻匹配：先标识后名字（工单462 双保险记账）', () => {
  const rec = (id: string, name: string) => ({ id, name })
  const ent = (key: string, tooltip: string) => ({ key, tooltip })

  it('标识相等即命中（先标识——tooltip 已改名的更新场景不脱钉）', () => {
    expect(trayPinnedMatch(rec('guid:abc', '旧名'), ent('guid:abc', '新名'))).toBe(true)
    expect(trayPinnedMatch(rec('100:1', 'x'), ent('100:1', 'y'))).toBe(true)
  })

  it('标识对不上、名字相同 → 名字兜底命中（跨重启 hwnd 类标识漂移的恢复场景）', () => {
    expect(trayPinnedMatch(rec('999:1', '蓝牙'), ent('777:2', '蓝牙'))).toBe(true)
  })

  it('标识与名字都不中 → 不命中（名单不产生幽灵钉挂）', () => {
    expect(trayPinnedMatch(rec('100:1', '蓝牙'), ent('100:2', '耳机'))).toBe(false)
    expect(trayPinnedMatch(rec('guid:a', 'X'), ent('guid:b', 'Y'))).toBe(false)
  })

  it('名字空串不参与兜底（空 tooltip 的条目只按标识比，防全栏误挂）', () => {
    expect(trayPinnedMatch(rec('100:1', ''), ent('100:2', ''))).toBe(false)
    expect(trayPinnedMatch(rec('100:1', ''), ent('100:1', ''))).toBe(true)
    expect(trayPinnedMatch(rec('100:1', '蓝牙'), ent('100:2', ''))).toBe(false)
    expect(trayPinnedMatch(rec('100:1', ''), ent('100:2', '蓝牙'))).toBe(false)
  })

  it('谓词形态：任一记录命中即常驻；全不中不常驻；空名单恒不常驻', () => {
    const isPinned = trayPinnedMatcher([rec('a:1', 'X'), rec('b:2', '蓝牙')])
    expect(isPinned(ent('a:1', '别的名'))).toBe(true) // 标识优先
    expect(isPinned(ent('b:9', '蓝牙'))).toBe(true) // 名字兜底
    expect(isPinned(ent('c:9', 'X'))).toBe(true) // 另一条记录的名字兜底
    expect(isPinned(ent('c:9', 'Z'))).toBe(false) // 全不中
    expect(trayPinnedMatcher([])(ent('a:1', 'X'))).toBe(false)
  })

  it('跨重启恢复链路（名字兜底端到端）：旧面板记 {hwndA, 蓝牙/hwndB, 电源}，重启后名单全换新键 → 两常驻豁免入栏；解名单则按非常驻切尾', () => {
    const records = [rec('1000:5', '蓝牙'), rec('2000:6', '电源')]
    const rebooted: TaskbarTrayEntry[] = [
      { key: '3000:7', tooltip: '音量', iconKey: 'k0' },
      { key: '4000:8', tooltip: '蓝牙', iconKey: 'k1' },
      { key: '5000:9', tooltip: '电源', iconKey: 'k2' },
    ]
    // 档位 1：两常驻豁免 → 全在栏（音量占唯一的非常驻名额），溢出空
    const { bar, overflow } = planTrayOverflow(rebooted, 1, trayPinnedMatcher(records))
    expect(bar.map((i) => i.tooltip)).toEqual(['音量', '蓝牙', '电源'])
    expect(overflow).toEqual([])
    // 对照：名单不在场（重启丢了账）则按非常驻切尾——豁免语义的差别就在这份账
    const off = planTrayOverflow(rebooted, 1)
    expect(off.bar.map((i) => i.tooltip)).toEqual(['音量'])
    expect(off.overflow.map((i) => i.tooltip)).toEqual(['蓝牙', '电源'])
  })
})
