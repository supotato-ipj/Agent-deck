// Agent 平铺窗口事实采集（工单376）：win-facts 统一接缝（工单370，顶层枚举 + 特征位 +
// 几何 + 身份的单一采集真源）上的平铺投影采集面——不复制枚举实现，只做事实合成：
// win-facts 甄别通过的顶层窗 → 特征位/身份/矩形/最小化 → VDM 公开桥 IsWindowOnCurrent
// → TileWindowFacts（tile-scope 纯裁决的输入）。
//
// 成本纪律（win-facts 成本面同款）：甄别判先行（IsWindowVisible 一判），通过者才付
// 特征/身份/几何采集；标题只内存即时使用（ADR-0007 口子，永不出进程、永不落盘）。
// 采集失败口径：单点取失败按「未采集到该拒绝位」/零矩形/空身份回报（tile-scope 判据
// 缺省/拒绝的两向口径），不抛不重试；本模块自身不抛（collectTileFacts 顶层 catch 归空集）。
import { scanTopWindows, isWindowVisible, isIconic, windowTraits, nativeWindowTitle, exeOfPid, pidOf, windowRect } from '../taskbar/win-facts'
import { isWindowOnCurrentDesktop } from './virtual-desktop'
import { hasResizableFrame } from './window-frame'
import type { TileWindowFacts } from './tile-scope'

function factsOf(hwnd: number): TileWindowFacts | null {
  if (!isWindowVisible(hwnd)) return null // 甄别判先行（无窗口面进程的常态，零后续成本）
  const traits = windowTraits(hwnd)
  const pid = pidOf(hwnd)
  const exe = pid ? exeOfPid(pid) : ''
  const title = nativeWindowTitle(hwnd) ?? ''
  return {
    hwnd,
    pid,
    exe,
    title,
    visible: true,
    cloaked: traits.cloaked,
    cloakedShell: traits.cloakedShell,
    toolWindow: traits.toolWindow,
    owned: traits.owned,
    appWindow: traits.appWindow,
    iconic: isIconic(hwnd),
    resizable: hasResizableFrame(hwnd),
    rect: windowRect(hwnd),
    onCurrentDesktop: isWindowOnCurrentDesktop(hwnd),
  }
}

/**
 * 一拍平铺事实采集（z 序 = win-facts scanTopWindows 输出序——平铺成员入列序的确定性
 * 依据）：可见顶层窗全量合成事实（范围裁决交 tile-scope 纯函数）。任何一步异常归空集
 * （本拍不可用——编排层沿用上一拍，不猜）。
 */
export function collectTileFacts(): TileWindowFacts[] {
  try {
    const out: TileWindowFacts[] = []
    for (const hwnd of scanTopWindows((h) => isWindowVisible(h))) {
      const f = factsOf(hwnd)
      if (f) out.push(f)
    }
    return out
  } catch {
    return []
  }
}
