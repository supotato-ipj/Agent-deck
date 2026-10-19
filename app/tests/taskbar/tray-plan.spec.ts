// 托盘名单编排纯函数（工单56）：Windows 托盘事件流 → 栏内图标名单。
// 重点覆盖三件：NIM_MODIFY 的部分更新语义（无图不带图、无 tip 不清 tip）、
// 删除摘除、其余事件（setversion/setfocus/unknown）空转。
import { describe, expect, it } from 'vitest'
import { applyTrayEvent, planTrayOverflow, sameTrayIcons, trayIconKeyOf } from '../../src/main/taskbar/tray-plan'
import type { TaskbarTrayEntry } from '../../src/shared/contract'
import type { TrayIconPixels, TrayWireEvent } from '../../src/main/trayhost/protocol'

const PIX: TrayIconPixels = { width: 16, height: 16, bgraBase64: 'AAAA' }

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
