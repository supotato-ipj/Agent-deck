/**
 * 左组编排纯函数测试（工单52）：手钉与运行中应用合并——以 exe 路径为身份去重、
 * 手钉在前、已手钉应用运行时不新增图标只叠加运行态；窗口标题只随运行态即时呈现。
 * 先例：tests/desktop/plan.spec.ts（直接喂构造输入断言输出清单）。
 */
import { describe, expect, it } from 'vitest'
import { planLeftGroup } from '../../src/main/taskbar/left-plan'
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
