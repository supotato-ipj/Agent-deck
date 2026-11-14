// launch 通道裁决纯函数（工单482，#478 诊断定谳照单施工）：Electron shell.openPath
// （ShellExecute 'open' verb）对 shell 本体 explorer.exe 恒失败——真机实测恒返回
// "Failed to open path"（86ms、零窗口），而同语义 CreateProcess（spawn explorer）
// 开窗成功（见 docs/audit/2026-11-14-t478-diagnostic-round.md §二三对照）。回归点 =
// 2026-10-14 explorer 被手钉进任务栏（此前无点击入口），通道实现与 Electron 版本
// 此后均未变——「通道对 explorer 的失败是恒久语义」。
// 纯函数、零 IO 零 Win32：通道效果由服务依赖缝注入（desktop/adapter 真源 + 离线测试假源）。

import { normalizeExe } from './apps-plan'

/** launch 通道两态：shell-open=Electron shell.openPath（既有默认通道）；
 * explorer-spawn=spawn explorer 专用通道（无窗新开「此电脑」，工单482 目标语义） */
export type TaskbarLaunchRoute = 'shell-open' | 'explorer-spawn'

/** shell 本体 exe 身份判定（归一后按 basename 比较）：任意路径下的 explorer.exe
 * 同属 shell 本体，ShellExecute 对其的失败语义相同（诊断对照只测了 SystemRoot
 * 正本，副本按同一身份路由——basename 相同即同一 shell 语义）。 */
export function isShellBodyExe(exe: string): boolean {
  const norm = normalizeExe(exe)
  const base = norm.split('\\').pop() ?? ''
  return base === 'explorer.exe'
}

/** launch 通道裁决：explorer.exe → explorer-spawn；其余应用 → shell-open 不变 */
export function decideLaunchRoute(exe: string): TaskbarLaunchRoute {
  return isShellBodyExe(exe) ? 'explorer-spawn' : 'shell-open'
}
