// preflight 环境体检分类（工单113，spec #109 seam② 同模块扩展）：注入假探测结果断言
// 四类污染源各产出正确警示条目、无污染账目干净。分类是纯函数——真机探测的合理性归电池。
import { describe, expect, it } from 'vitest'
import { classifyPreflight } from '../../accept/lib/panel-control'

describe('preflight 四类污染源分类（注入假探测结果）', () => {
  it('③ 遗留面板进程：恰一扇面板本体窗 → leftover-panel；镜像不可查询附提权嫌疑', () => {
    const entries = classifyPreflight({ panelWindows: [{ cls: 'Chrome_WidgetWin_1', title: 'AGENT DECK', pid: 3900, exeQueryable: false }] })
    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe('leftover-panel')
    expect(entries[0].detail).toContain('pid=3900')
    expect(entries[0].detail).toContain('提权')
  })

  it('④ 双面板并存：≥2 扇面板本体窗 → double-panel（不并报 leftover）', () => {
    const entries = classifyPreflight({
      panelWindows: [
        { cls: 'Chrome_WidgetWin_1', title: 'AGENT DECK', pid: 3900 },
        { cls: 'Chrome_WidgetWin_1', title: 'AGENT DECK', pid: 4101 },
      ],
    })
    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe('double-panel')
    expect(entries[0].detail).toContain('pid=3900, 4101')
  })

  it('② dwm 幽灵窗：Ghost 类在场 → dwm-ghost（每扇一条）', () => {
    const entries = classifyPreflight({ ghostWindows: [{ cls: 'Ghost', pid: 940 }, { cls: 'Ghost', pid: 77 }] })
    expect(entries.map((e) => e.kind)).toEqual(['dwm-ghost', 'dwm-ghost'])
    expect(entries[0].detail).toContain('pid=940')
  })

  it('① 全屏覆盖层候选：壳层外全屏可见窗 → fullscreen-overlay', () => {
    const entries = classifyPreflight({ fullscreenForeign: [{ cls: 'Windows.UI.Core.CoreWindow', pid: 20592, title: '' }] })
    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe('fullscreen-overlay')
    expect(entries[0].detail).toContain('cls=Windows.UI.Core.CoreWindow')
  })

  it('无污染：三路探针全空 → 空数组（账目干净）', () => {
    expect(classifyPreflight({ panelWindows: [], ghostWindows: [], fullscreenForeign: [] })).toEqual([])
  })

  it('混合在场：四类齐发各产条目；空 probes 缺省不抛', () => {
    const mixed = classifyPreflight({
      panelWindows: [{ cls: 'Chrome_WidgetWin_1', title: 'AGENT DECK', pid: 1 }, { cls: 'Chrome_WidgetWin_1', title: 'AGENT DECK', pid: 2 }],
      ghostWindows: [{ cls: 'Ghost', pid: 940 }],
      fullscreenForeign: [{ cls: 'X', pid: 3 }],
    })
    expect(mixed.map((e) => e.kind)).toEqual(['double-panel', 'dwm-ghost', 'fullscreen-overlay'])
    expect(classifyPreflight()).toEqual([])
  })
})
