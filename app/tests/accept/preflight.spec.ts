// preflight 环境体检分类（工单113，spec #109 seam② 同模块扩展）：注入假探测结果断言
// 五类污染源各产出正确警示条目、无污染账目干净。分类是纯函数——真机探测的合理性归电池。
import { describe, expect, it } from 'vitest'
import { classifyPreflight, classifyUserWindowActivity, PREFLIGHT_OWN_TITLES } from '../../accept/lib/panel-control'

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

describe('preflight 第五类：用户窗口活跃度（工单34 方向3，输入=窗口枚举快照）', () => {
  const row = (over: object = {}) => ({
    cls: 'Notepad', title: '无标题 - 记事本', pid: 5000, selfPid: 1000,
    visible: true, cloaked: false, foreground: false, ...over,
  })

  it('检出：前台是可见的普通用户应用窗 → user-window-activity，detail 指认 cls/pid', () => {
    const entries = classifyUserWindowActivity([row({ foreground: true }), row({ cls: 'Chrome_WidgetWin_1', title: 'AGENT DECK', pid: 1000 })])
    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe('user-window-activity')
    expect(entries[0].detail).toContain('cls=Notepad')
    expect(entries[0].detail).toContain('pid=5000')
  })

  it('未检出：前台是壳层桌面宿主/任务栏（用户停在桌面，无应用活动）', () => {
    for (const cls of ['Progman', 'WorkerW', 'Shell_TrayWnd', 'SHELLDLL_DefView', 'SysListView32']) {
      expect(classifyUserWindowActivity([row({ cls, title: '', foreground: true })])).toEqual([])
    }
  })

  it('未检出：前台是电池自家窗（selfPid 命中或 OWN_TITLES 命中）——自家现场不算用户活动', () => {
    expect(PREFLIGHT_OWN_TITLES).toContain('AGENT DECK')
    expect(classifyUserWindowActivity([row({ cls: 'Chrome_WidgetWin_1', title: 'AGENT DECK', pid: 1000, foreground: true })])).toEqual([])
    expect(classifyUserWindowActivity([row({ cls: 'Chrome_WidgetWin_1', title: 'AGENT DECK ACCEPT HINT', pid: 1000, foreground: true })])).toEqual([])
    expect(classifyUserWindowActivity([row({ pid: 1000, foreground: true })])).toEqual([])
  })

  it('未检出：前台 cloaked（不可见合成）或不可见', () => {
    expect(classifyUserWindowActivity([row({ foreground: true, cloaked: true })])).toEqual([])
    expect(classifyUserWindowActivity([row({ foreground: true, visible: false })])).toEqual([])
  })

  it('未检出：快照无前台行 / 空快照 / 缺省不抛', () => {
    expect(classifyUserWindowActivity([row()])).toEqual([])
    expect(classifyUserWindowActivity([])).toEqual([])
    expect(classifyUserWindowActivity()).toEqual([])
  })

  it('未检出：Ghost 前台（OLE 幽灵归既有 dwm-ghost 类，不重复入账）', () => {
    expect(classifyUserWindowActivity([row({ cls: 'Ghost', title: '', pid: 940, foreground: true })])).toEqual([])
  })
})
