// 窗口预览条目投影（工单379，spec #369 决策 15 + GLOSSARY「窗口预览」）：纯裁决——
// 成员事实（与胶囊计数同口径的主屏合格窗口）× 缓存在场 → 逐条呈现模式。
//
// 口径：
// - 可见窗（非最小化）优先实时缩略图（DWM 承载；注册失败的运行期回退由服务侧改判）；
// - 最小化窗用最近缓存（预览打开期间抓取的内存帧）；无缓存回退应用图标与标题；
// - 条目序 = 成员序（win-facts z 序，稳定可预期）；标题只作上屏载荷（绝不入日志）。
import type { TileWindowFacts } from './tile-scope'

/** 条目呈现模式（契约 WindowPreviewItem.mode 同形） */
export type PreviewMode = 'live' | 'cached' | 'icon'

/** 单窗模式裁决 */
export function decidePreviewMode(input: { iconic: boolean; hasCache: boolean }): PreviewMode {
  if (!input.iconic) return 'live'
  return input.hasCache ? 'cached' : 'icon'
}

/** 投影条目（服务层在条目上补 icon/image 载荷；本层只裁决模式与身份） */
export interface PreviewSeed {
  hwnd: number
  title: string
  /** 应用可执行文件绝对路径（图标提取的键；空串 = 取不到） */
  exe: string
  mode: PreviewMode
}

export function projectPreviewItems(
  members: readonly TileWindowFacts[],
  hasCache: (hwnd: number) => boolean,
): PreviewSeed[] {
  return members.map((m) => ({
    hwnd: m.hwnd,
    title: m.title,
    exe: m.exe,
    mode: decidePreviewMode({ iconic: m.iconic, hasCache: hasCache(m.hwnd) }),
  }))
}
