// 左组点击裁决纯函数测试（工单53，plan.spec 同形态）：输入 = 该应用的窗口快照 + 前台 hwnd，
// 输出 = 启动/置前/最小化/多窗口列表四态裁决。零 Win32——效果层薄壳由真机验收覆盖。
import { describe, expect, it } from 'vitest'
import { decideAppClick } from '../../src/main/taskbar/interactions'

describe('左键裁决（工单53：未运行→启动、运行中→置前、已前台→最小化、多窗口→列表）', () => {
  it('无窗口（未运行）→ 启动', () => {
    expect(decideAppClick([], 0)).toEqual({ kind: 'launch' })
  })

  it('单窗口且不在前台 → 置前该窗口', () => {
    expect(decideAppClick([{ hwnd: 101, title: '甲' }], 999)).toEqual({ kind: 'activate', hwnd: 101 })
  })

  it('单窗口且已在前台 → 最小化该窗口', () => {
    expect(decideAppClick([{ hwnd: 101, title: '甲' }], 101)).toEqual({ kind: 'minimize', hwnd: 101 })
  })

  it('前台 hwnd 未知（0）时单窗口按置前处理', () => {
    expect(decideAppClick([{ hwnd: 101, title: null }], 0)).toEqual({ kind: 'activate', hwnd: 101 })
  })

  it('多窗口 → 弹出选窗列表（含 hwnd 与窗口标题，即使其一已在前台）', () => {
    const windows = [
      { hwnd: 101, title: '甲 - 文档1' },
      { hwnd: 102, title: '甲 - 文档2' },
    ]
    expect(decideAppClick(windows, 101)).toEqual({ kind: 'pick', windows })
  })
})
