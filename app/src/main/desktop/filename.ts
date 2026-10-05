// 文件名语义（工单28 重命名，纯逻辑）：输入框原文 → 盘面目标文件名的推导，与
// Win32 文件名合法性校验。不碰文件系统——冲突校验（目标是否已存在）在服务层走依赖束。
import type { DesktopItemKind } from '../../shared/contract'
import { isAppEntry } from './scan'

/**
 * 标签原文 → 目标文件名：两端去空白后，快捷方式/网址文件未带原扩展时自动补回
 * （explorer 对这两类永远隐藏扩展，用户输入的是显示名；显式带了原扩展则尊重原文，
 * 不做双扩展）。file/folder 的标签即完整文件名，逐字采纳。
 */
export function renameTarget(
  item: { name: string; kind: DesktopItemKind },
  input: string,
): string {
  const typed = input.trim()
  if (!isAppEntry(item.kind)) return typed
  const dot = item.name.lastIndexOf('.')
  if (dot < 0) return typed // 无扩展可保（kindOf 不会产生，防御性下限）
  const ext = item.name.slice(dot).toLowerCase() // .lnk / .url
  return typed.toLowerCase().endsWith(ext) ? typed : typed + ext
}

/** Win32 保留设备名（不分大小写；带任意扩展同样保留——CON.txt 亦非法） */
const RESERVED_STEMS = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
])

/** Win32 禁字符（fs.rename 静默失败/产物未定的同类）+ 控制字符 */
const INVALID_CHARS = /[<>:"/\\|?*\u0000-\u001f]/

/**
 * Win32 文件名合法性：空串、禁字符/控制字符、保留设备名、收尾点或空格（Win32 路径
 * 归一化会静默剥掉，产物与用户意图不符——显式拒绝而非盘面自作主张）。
 * 返回错误语（拒绝原因），合法返回 null。大小写不敏感（NTFS 同规）。
 */
export function fileNameError(name: string): string | null {
  if (!name) return '文件名不能为空'
  if (INVALID_CHARS.test(name)) return '文件名含非法字符'
  if (name.endsWith('.') || name.endsWith(' ')) return '文件名不能以点或空格收尾'
  const stem = name.includes('.') ? name.slice(0, name.indexOf('.')) : name
  if (RESERVED_STEMS.has(stem.toUpperCase())) return '文件名是系统保留名'
  return null
}
