// launch 通道裁决纯函数测试（工单482，interactions.spec 同形态）：输入 = 应用的 exe 身份，
// 输出 = shell 打开通道 / explorer spawn 专用通道两态路由。零 IO 零 Win32——通道效果层
// 由服务依赖缝注入，真源薄壳（adapter spawn）由真机验收覆盖。
// 依据 #478 诊断定谳：Electron shell.openPath（ShellExecute 'open'）对 shell 本体
// explorer.exe 恒失败（"Failed to open path"、零窗口），同语义 CreateProcess
// （spawn explorer）开窗成功——explorer.exe 特判走 spawn 通道，其余不变。
import { describe, expect, it } from 'vitest'
import { decideLaunchRoute, isShellBodyExe } from '../../src/main/taskbar/launch-route'

describe('launch 通道裁决（工单482：explorer.exe → spawn 专用通道，其余 → shell 打开）', () => {
  it('explorer.exe 常规绝对路径 → explorer-spawn', () => {
    expect(decideLaunchRoute('C:\\Windows\\explorer.exe')).toBe('explorer-spawn')
  })

  it('explorer.exe 身份判定归一比较（大小写/正斜杠/裸名）', () => {
    expect(isShellBodyExe('c:\\WINDOWS\\EXPLORER.EXE')).toBe(true)
    expect(isShellBodyExe('C:/Windows/explorer.exe')).toBe(true)
    expect(isShellBodyExe('explorer.exe')).toBe(true)
  })

  it('同盘其它位置的 explorer.exe 副本同属 shell 本体（ShellExecute 失败语义相同）→ explorer-spawn', () => {
    expect(decideLaunchRoute('D:\\tools\\explorer.exe')).toBe('explorer-spawn')
  })

  it('普通应用走既有 shell 打开通道不变', () => {
    expect(decideLaunchRoute('C:\\Windows\\notepad.exe')).toBe('shell-open')
    expect(decideLaunchRoute('C:\\Program Files\\ZCode\\ZCode.exe')).toBe('shell-open')
  })

  it('名字含 explorer 但非 shell 本体的 exe 不误路由', () => {
    expect(decideLaunchRoute('C:\\apps\\explorer-plus.exe')).toBe('shell-open')
  })
})
