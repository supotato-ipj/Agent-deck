// 左组编排核心（工单52，纯逻辑）：手钉名单 ∪ 运行中窗口 → 左组有序条目。
// 形态平移 desktop/plan.ts 的 planDock（状态 → 语义位置的有序清单，纯函数、零 IO、
// 零 electron；条目形态类型 TaskbarLeftEntry 与契约面共用一份，不在此重复声明）。
// 身份 = exe 路径（NTFS 语义归一：大小写与斜杠向不敏感）：已手钉的应用运行时不新增
// 图标，只在原图标上叠加运行态；手钉在前。窗口标题只随运行态即时进出（ADR-0007
// 书面口子：仅内存即时显示，永不持久化——本模块不碰任何持久化）。
import type { TaskbarLeftEntry } from '../../shared/contract'

/** 手钉条目（栏布局存储的记录形态；label/iconKey 是迁移时从桌面项捕获的展示元数据） */
export interface TaskbarPinnedEntry {
  exe: string
  label: string
  iconKey: string | null
}

/** 运行中窗口输入（适配层产出；exe = 绝对路径，title 空串按无标题处理） */
export interface TaskbarWindowInput {
  exe: string
  title: string | null
}

/** exe 身份归一：小写 + 斜杠归一到反斜杠（NTFS 大小写不敏感） */
export function normalizeExe(exe: string): string {
  return exe.replace(/\//g, '\\').toLowerCase()
}

/** 仅运行应用的显示名：exe 基名去扩展 */
function labelOfExe(exe: string): string {
  return exe.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '')
}

/**
 * 左组合并编排：手钉按清单序占最前（运行中则叠加运行态与窗口标题），仅运行的
 * 应用按窗口首见序随后；同一 exe 多窗口只出一个条目，标题取首个非空窗口标题。
 * iconKeyForExe 是仅运行条目的图标键查表缝（注入即纯；缺省/查不到为 null）。
 */
export function planLeftGroup(
  pinned: readonly TaskbarPinnedEntry[],
  windows: readonly TaskbarWindowInput[],
  iconKeyForExe?: (exe: string) => string | null,
): TaskbarLeftEntry[] {
  // 运行中应用按身份归并：首个窗口定身份原文与排序位，标题取首个非空
  const running = new Map<string, { exe: string; title: string | null }>()
  for (const w of windows) {
    if (!w.exe) continue
    const key = normalizeExe(w.exe)
    const title = w.title ? w.title : null
    const hit = running.get(key)
    if (!hit) running.set(key, { exe: w.exe, title })
    else if (hit.title === null && title !== null) hit.title = title
  }

  const seen = new Set<string>()
  const out: TaskbarLeftEntry[] = []
  for (const p of pinned) {
    const key = normalizeExe(p.exe)
    if (!p.exe || seen.has(key)) continue
    seen.add(key)
    const hit = running.get(key)
    out.push({
      exe: p.exe,
      label: p.label,
      pinned: true,
      running: hit !== undefined,
      title: hit?.title ?? null,
      iconKey: p.iconKey,
    })
  }
  for (const [key, app] of running) {
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      exe: app.exe,
      label: labelOfExe(app.exe),
      pinned: false,
      running: true,
      title: app.title,
      iconKey: iconKeyForExe?.(key) ?? null,
    })
  }
  return out
}
