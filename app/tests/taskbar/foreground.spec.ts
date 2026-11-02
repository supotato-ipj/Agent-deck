// 托盘回调的前台放行（工单363）：应用收到托盘回调后要弹**自己的**菜单 ⇒ 它必须能取前台。
// 真机取证（工单363 基线轮）：回调投递与负载语义全通（posted=true、v0 负载
// wp=uid/lp=WM_RBUTTONUP、PowerToys 的 #32768 标准菜单确实弹出），断点落在**前台段**——
// 数据面子进程发起的 AllowSetForegroundWindow 恒失败（该调用已删、asfw 存证字段随之退役），应用的菜单
// 不持前台 ⇒ Esc（走前台窗）与点外都收不掉，部分应用（OneDrive、Electron 托盘）
// 直接不弹菜单。放行因此改由面板主进程发起（条带窗属主、真实右键的末次输入接收者）。
//
// 本单测钉放行裁决的外部行为：属主缺位不放行、放行落到该属主 pid、放行失败如实
// 回报不抛穿。真实前台转移由真机轮覆盖（放行是否成功取决于系统前台锁，真机存证
// 为准——见 app/accept/experiments/tray-menu-forensics.js）。
import { describe, expect, it } from 'vitest'
import { grantTrayForeground } from '../../src/main/taskbar/foreground'

describe('托盘回调的前台放行（工单363）', () => {
  it('属主 hwnd 缺位：不放行（不猜、不代持第三方进程）', () => {
    const calls: number[] = []
    const out = grantTrayForeground({ hwnd: 0, pid: 0 }, { allow: (p) => { calls.push(p); return true } })
    expect(out).toEqual({ pid: 0, granted: false, reason: 'no-hwnd' })
    expect(calls).toEqual([]) // 缺位即零调用——不放行给任何人
  })

  it('属主窗口在场但 pid 解析缺位（窗口已销）：不放行', () => {
    const calls: number[] = []
    const out = grantTrayForeground({ hwnd: 4242, pid: 0 }, { allow: (p) => { calls.push(p); return true } })
    expect(out).toEqual({ pid: 0, granted: false, reason: 'no-pid' })
    expect(calls).toEqual([])
  })

  it('属主在场：放行落到该属主 pid，回执如实反映 API 结果', () => {
    const calls: number[] = []
    const out = grantTrayForeground({ hwnd: 4242, pid: 200 }, { allow: (p) => { calls.push(p); return true } })
    expect(out).toEqual({ pid: 200, granted: true, reason: 'ok' })
    expect(calls).toEqual([200])
  })

  it('放行 API 拒收（返回 false）：如实回报未放行，不当成功', () => {
    const out = grantTrayForeground({ hwnd: 4242, pid: 200 }, { allow: () => false })
    expect(out).toEqual({ pid: 200, granted: false, reason: 'ok' })
  })

  it('放行 API 抛错：收口为失败回报，不抛穿到回放链', () => {
    const out = grantTrayForeground({ hwnd: 4242, pid: 200 }, {
      allow: () => { throw new Error('api down') },
    })
    expect(out).toEqual({ pid: 200, granted: false, reason: 'allow-failed' })
  })

  it('放行只给这一个属主进程（不放行全局、不顺带放行旁证进程）', () => {
    const calls: number[] = []
    grantTrayForeground({ hwnd: 4242, pid: 200 }, { allow: (p) => { calls.push(p); return true } })
    grantTrayForeground({ hwnd: 4343, pid: 300 }, { allow: (p) => { calls.push(p); return true } })
    expect(calls).toEqual([200, 300])
  })
})
