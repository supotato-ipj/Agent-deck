// 文件名语义（工单28 重命名，纯逻辑）：输入框原文 → 盘面目标文件名的推导，与
// Win32 文件名合法性校验。不碰文件系统——冲突校验（目标是否已存在）在服务层走依赖束。
// 工单30 起兼营粘贴重名冲突的副本名递增（同为纯逻辑，盘面实况由调用方注入）。
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

/** 副本名后缀（工单30，explorer 同款不弹框）：「 - 副本」起步、「 - 副本 N」递增 */
const DUPLICATE_SUFFIX = ' - 副本'
/** 基名已带的副本后缀（剥掉续号用）：「xxx - 副本」或「xxx - 副本 N」收尾形态 */
const DUPLICATE_TAIL = /^(.*) - 副本(?: (\d+))?$/

/**
 * 粘贴重名冲突的副本名（工单30，真桌面同款不弹框）：原名未被占用原样返回；被占用则
 * 「基名 - 副本<ext>」起步、「基名 - 副本 N<ext>」递增取第一个空位。基名自带
 * 「 - 副本」/「 - 副本 N」后缀时剥掉续号（再贴一份 ≠ 叠罗汉，多份粘贴不互相覆盖）。
 * 扩展名主意只对文件打（目录名带点不拆——explorer 对文件夹只在名尾加后缀；点开头的
 * 名字 .gitignore 不算扩展）。taken 是盘面实况谓词（服务层注入 entryExists）——先贴出
 * 的名字立即可见，同拍多份递增不撞名；本函数不碰文件系统。
 */
export function duplicateName(
  entry: { name: string; isDirectory: boolean },
  taken: (candidate: string) => boolean,
): string {
  if (!taken(entry.name)) return entry.name
  let stem = entry.name
  let ext = ''
  if (!entry.isDirectory) {
    const dot = entry.name.lastIndexOf('.')
    if (dot > 0) {
      stem = entry.name.slice(0, dot)
      ext = entry.name.slice(dot)
    }
  }
  let n = 1
  const carried = DUPLICATE_TAIL.exec(stem)
  if (carried) {
    stem = carried[1]
    n = carried[2] ? Number(carried[2]) + 1 : 2
  }
  for (;; n += 1) {
    const candidate = `${stem}${DUPLICATE_SUFFIX}${n > 1 ? ` ${n}` : ''}${ext}`
    if (!taken(candidate)) return candidate
  }
}
