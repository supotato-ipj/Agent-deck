/**
 * 左组编排纯函数测试（工单52）：手钉与运行中应用合并——以 exe 路径为身份去重、
 * 手钉在前、已手钉应用运行时不新增图标只叠加运行态；窗口标题只随运行态即时呈现。
 * 工单58 溢出裁决：容量超限尾部收进溢出浮层（为 ⋯ 钮预留一格），数量回落自动回栏。
 * 先例：tests/desktop/plan.spec.ts（直接喂构造输入断言输出清单）。
 */
import { describe, expect, it } from 'vitest'
import { planLeftGroup, planLeftOverflow } from '../../src/main/taskbar/left-plan'
import type { TaskbarPinnedEntry, TaskbarWindowInput } from '../../src/main/taskbar/left-plan'

const pinned = (exe: string, over: Partial<TaskbarPinnedEntry> = {}): TaskbarPinnedEntry => ({
  exe,
  label: over.label ?? exe.replace(/^.*[\\/]/, '').replace(/\.exe$/i, ''),
  iconKey: over.iconKey ?? null,
})

describe('左组编排（手钉 ∪ 运行中，工单52）', () => {
  it('手钉在前、按手钉清单序；仅运行的应用按窗口首见序随后', () => {
    const out = planLeftGroup(
      [pinned('C:\\apps\\B.exe'), pinned('C:\\apps\\A.exe')],
      [{ exe: 'C:\\apps\\C.exe', title: 'C 窗口' }],
    )
    expect(out.map((e) => [e.exe, e.pinned, e.running])).toEqual([
      ['C:\\apps\\B.exe', true, false],
      ['C:\\apps\\A.exe', true, false],
      ['C:\\apps\\C.exe', false, true],
    ])
  })

  it('已手钉的应用运行时不新增图标：同一图标叠加运行态与窗口标题', () => {
    const out = planLeftGroup(
      [pinned('C:\\apps\\A.exe', { label: '甲应用', iconKey: 'C:\\apps\\A.exe|1' })],
      [{ exe: 'C:\\apps\\A.exe', title: '甲应用 - 编辑中' }],
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({
      exe: 'C:\\apps\\A.exe',
      label: '甲应用',
      pinned: true,
      running: true,
      title: '甲应用 - 编辑中',
      iconKey: 'C:\\apps\\A.exe|1',
    })
  })

  it('exe 身份判定大小写与斜杠向不敏感（NTFS 语义）', () => {
    const out = planLeftGroup(
      [pinned('C:\\Apps\\WeChat.exe')],
      [{ exe: 'c:/apps/wechat.exe', title: '微信' }],
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ pinned: true, running: true, title: '微信' })
  })

  it('同一应用多个窗口只出一个图标；标题取首个非空窗口标题', () => {
    const out = planLeftGroup(
      [],
      [
        { exe: 'C:\\apps\\A.exe', title: '' },
        { exe: 'C:\\apps\\A.exe', title: '文档 2' },
        { exe: 'C:\\apps\\A.exe', title: '文档 1' },
      ],
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ running: true, title: '文档 2' })
  })

  it('全部窗口无标题时 title 为 null（渲染层回退 label 作 tooltip）', () => {
    const out = planLeftGroup([], [{ exe: 'C:\\apps\\A.exe', title: '' }])
    expect(out[0].title).toBeNull()
  })

  it('仅运行应用的 label = exe 基名去扩展；图标键经注入查表（无表即 null）', () => {
    const icons = new Map([['c:\\apps\\a.exe', 'C:\\apps\\A.exe|9']])
    const out = planLeftGroup([], [{ exe: 'C:\\apps\\A.exe', title: null }], (exe) => icons.get(exe) ?? null)
    expect(out[0]).toMatchObject({ label: 'A', pinned: false, iconKey: 'C:\\apps\\A.exe|9' })
    const bare = planLeftGroup([], [{ exe: 'C:\\apps\\A.exe', title: null }])
    expect(bare[0].iconKey).toBeNull()
  })

  it('手钉清单内重复身份去重（首个胜）；空 exe 窗口跳过', () => {
    const out = planLeftGroup(
      [pinned('C:\\apps\\A.exe', { label: '一号' }), pinned('c:\\apps\\a.exe', { label: '二号' })],
      [{ exe: '', title: '无名' }, { exe: 'C:\\apps\\B.exe', title: '乙' }],
    )
    expect(out.map((e) => [e.label, e.iconKey])).toEqual([['一号', null], ['B', null]])
  })

  it('手钉未运行：running=false 且不带标题（标题只随运行态即时呈现）', () => {
    const out = planLeftGroup([pinned('C:\\apps\\A.exe')], [])
    expect(out).toEqual([
      { exe: 'C:\\apps\\A.exe', label: 'A', pinned: true, running: false, title: null, iconKey: null },
    ])
  })

  it('全空输入 → 空左组', () => {
    expect(planLeftGroup([], [])).toEqual([])
  })
})

describe('左组溢出裁决（工单58）：容量超限尾部收进浮层，回落自动回栏', () => {
  const exes = (n: number) => Array.from({ length: n }, (_, i) => pinned(`C:\\apps\\App${i}.exe`))

  it('容量内全留栏（含恰好放满的边界）：无浮层、不预留 ⋯ 格', () => {
    expect(planLeftOverflow(exes(3), 5)).toEqual({ bar: exes(3), overflow: [] })
    expect(planLeftOverflow(exes(4), 4)).toEqual({ bar: exes(4), overflow: [] })
  })

  it('超出一个：尾部一个收进浮层，栏内为 ⋯ 钮预留一格', () => {
    const { bar, overflow } = planLeftOverflow(exes(5), 4)
    expect(bar.map((e) => e.exe)).toEqual(['C:\\apps\\App0.exe', 'C:\\apps\\App1.exe', 'C:\\apps\\App2.exe'])
    expect(overflow.map((e) => e.exe)).toEqual(['C:\\apps\\App3.exe', 'C:\\apps\\App4.exe'])
  })

  it('溢出取尾部：手钉在前的编排序即优先级，仅运行的后排应用先进浮层', () => {
    const entries = planLeftGroup(
      [pinned('C:\\apps\\P0.exe'), pinned('C:\\apps\\P1.exe')],
      [{ exe: 'C:\\apps\\R0.exe', title: '运行甲' }, { exe: 'C:\\apps\\R1.exe', title: '运行乙' }],
    )
    const { bar, overflow } = planLeftOverflow(entries, 3)
    expect(bar.map((e) => e.exe)).toEqual(['C:\\apps\\P0.exe', 'C:\\apps\\P1.exe'])
    expect(overflow.map((e) => e.exe)).toEqual(['C:\\apps\\R0.exe', 'C:\\apps\\R1.exe'])
  })

  it('数量回落自动回栏：同一容量重新编排，浮层清空', () => {
    expect(planLeftOverflow(exes(5), 3).overflow).toHaveLength(3)
    const again = planLeftOverflow(exes(2), 3)
    expect(again.bar).toHaveLength(2)
    expect(again.overflow).toEqual([])
  })

  it('容量只剩一格：栏内不留图标，全部经 ⋯ 进浮层', () => {
    const { bar, overflow } = planLeftOverflow(exes(3), 1)
    expect(bar).toEqual([])
    expect(overflow).toHaveLength(3)
  })

  it('容量为零或负：全部进浮层；空清单恒双空', () => {
    expect(planLeftOverflow(exes(2), 0).overflow).toHaveLength(2)
    expect(planLeftOverflow(exes(2), -1).overflow).toHaveLength(2)
    expect(planLeftOverflow([], 0)).toEqual({ bar: [], overflow: [] })
  })

  it('输入不被改动，条目原样引用（不复制不重组字段）', () => {
    const entries = exes(4)
    const snapshot = entries.map((e) => ({ ...e }))
    const { bar, overflow } = planLeftOverflow(entries, 3)
    expect(entries).toEqual(snapshot)
    expect(bar[0]).toBe(entries[0])
    expect(overflow[0]).toBe(entries[2])
  })
})
