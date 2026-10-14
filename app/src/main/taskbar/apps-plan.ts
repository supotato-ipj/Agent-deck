// 应用组编排核心（工单52，纯逻辑）：手钉名单 ∪ 运行中窗口 → 应用组有序条目。
// 形态平移 desktop/plan.ts 的 planDock（状态 → 语义位置的有序清单，纯函数、零 IO、
// 零 electron；条目形态类型 TaskbarAppEntry 与契约面共用一份，不在此重复声明）。
// 身份 = exe 路径（NTFS 语义归一：大小写与斜杠向不敏感）：已手钉的应用运行时不新增
// 图标，只在原图标上叠加运行态；手钉在前。窗口标题只随运行态即时进出（ADR-0007
// 书面口子：仅内存即时显示，永不持久化——本模块不碰任何持久化）。
import type { TaskbarAppEntry } from '../../shared/contract'

// 溢出裁决本体已移至 shared/overflow（渲染层同用一份，见该文件头的边界说明）；此处转出
// 保持主进程侧 import 路径不变。
export { planAppsOverflow } from '../../shared/overflow'
export type { TaskbarAppsOverflow } from '../../shared/overflow'

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

/**
 * 窗口特征位（工单156，枚举壳采集）：可见样式位 / DWM cloaked / 工具窗样式 / 属主 /
 * APPWINDOW——全部由 FFI 枚举薄壳逐窗采集，判据不落在采集层。特征位缺省 =
 * 未采集到该拒绝位，按通过处理（生产枚举壳恒给全量特征；离线旧 fake 源不带位
 * 即「正常可见带标题主窗」口径，契约面零破坏）。
 */
export interface TaskbarWindowTraits {
  /** 可见样式位（IsWindowVisible；最小化窗仍带该位——运行态含最小化的既有语义） */
  visible?: boolean
  /** DWM cloaked（UWP 挂起 / 其他虚拟桌面）；拒 */
  cloaked?: boolean
  /** WS_EX_TOOLWINDOW 工具窗样式；拒 */
  toolWindow?: boolean
  /** 有属主窗（GW_OWNER 非空）；配合 appWindow 判 */
  owned?: boolean
  /** WS_EX_APPWINDOW（应用自证该窗是任务栏形态）；有属主时唯一的赦免位 */
  appWindow?: boolean
}

/**
 * 应用组窗口过滤判据（工单156，纯函数）：真任务栏同款口径——后台进程、cloaked 挂起窗、
 * 工具窗、有属主弹窗（无 APPWINDOW）、无标题窗、自家进程的窗口一律拒；正常可见带
 * 标题主窗收（最小化窗特征与正常主窗一致，同收）。自家判据按 exe 归一身份（NTFS
 * 大小写斜杠不敏感）。FFI 枚举薄壳只采集特征不载裁决（本函数是唯一裁决点）。
 */
export function shouldShowOnTaskbar(w: TaskbarWindowInput & TaskbarWindowTraits, ownExe: string): boolean {
  if (w.visible === false) return false // 不可见样式位
  if (w.cloaked) return false // 挂起/其他桌面
  if (w.toolWindow) return false // 工具窗
  if (w.owned && !w.appWindow) return false // 有属主且无 APPWINDOW
  if (!w.title) return false // 空标题（后台无窗口面进程的常态）
  if (!w.exe) return false // 取不到身份的窗口无从寻址
  if (normalizeExe(w.exe) === normalizeExe(ownExe)) return false // 自家进程
  return true
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
 * 应用组合并编排（工单189 起为「统一图标序列」的落位本体）：手钉按清单序占最前
 * （运行中则叠加运行态与窗口标题），仅运行的应用按会话运行序随后——runOrder 在场
 * 时位次与当拍窗口枚举序（z 序快照）彻底脱钩（ADR-0013：切窗口焦点不改位次）；
 * runOrder 缺席/陈旧键按窗口首见序殿后（首拍引导与兜底口径）。同一 exe 多窗口只出
 * 一个条目，标题取首个非空窗口标题。iconKeyForExe 是仅运行条目的图标键查表缝
 * （注入即纯；缺省/查不到为 null）。
 */
export function planAppsGroup(
  pinned: readonly TaskbarPinnedEntry[],
  windows: readonly TaskbarWindowInput[],
  iconKeyForExe?: (exe: string) => string | null,
  runOrder?: readonly string[],
): TaskbarAppEntry[] {
  // 运行中应用按身份归并：首个窗口定身份原文，标题取首个非空
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
  const out: TaskbarAppEntry[] = []
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
  // 运行段落位序：会话序在前（陈旧键跳过），序外键按首见序殿后
  const orderedKeys = runOrder
    ? [...runOrder.filter((k) => running.has(k)), ...[...running.keys()].filter((k) => !runOrder.includes(k))]
    : [...running.keys()]
  for (const key of orderedKeys) {
    if (seen.has(key)) continue
    seen.add(key)
    const app = running.get(key)
    if (!app) continue
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

/** 编排一拍的产出：统一图标序列＋推进后的会话运行序（调用方回存，仅内存不落盘） */
export interface TaskbarAppsPlan {
  apps: TaskbarAppEntry[]
  /** 会话运行序（归一 exe 键）：仅未钉运行应用在册——新面孔追加最右、消失即摘除（工单189） */
  runOrder: string[]
}

/**
 * 应用组编排一拍（工单189，ADR-0013 默认规则落位＋手工序合并的本体）：上一拍会话
 * 运行序 ∪ 当拍运行集 → 新会话运行序——老面孔位次原样保留（任一窗口存续期间不动，
 * 与 z 序快照彻底脱钩）、新面孔追加最右、全部窗口关闭的键摘除（再次启动=新面孔回
 * 最右）；已手钉的运行应用不入会话序（并入钉图标）。随后按序合并出统一图标序列。
 * 会话序只活在本进程内存（调用方回存），面板重启即归零重引导——不落盘、无时间戳。
 */
export function planAppsSequence(
  pinned: readonly TaskbarPinnedEntry[],
  windows: readonly TaskbarWindowInput[],
  prevRunOrder: readonly string[],
  iconKeyForExe?: (exe: string) => string | null,
): TaskbarAppsPlan {
  const pinnedKeys = new Set(pinned.map((p) => normalizeExe(p.exe)))
  const runningKeys = new Set<string>()
  for (const w of windows) {
    if (!w.exe) continue
    const key = normalizeExe(w.exe)
    if (!pinnedKeys.has(key)) runningKeys.add(key)
  }
  const kept = prevRunOrder.filter((k) => runningKeys.has(k))
  const runOrder = [...kept, ...[...runningKeys].filter((k) => !prevRunOrder.includes(k))]
  return { apps: planAppsGroup(pinned, windows, iconKeyForExe, runOrder), runOrder }
}

/**
 * 解除手钉的原地转运行过渡（工单189）：在运行的已钉应用解除手钉时，其键插回会话
 * 运行序**首位**——运行段紧随手钉段，键落首位即该应用停在原位次（原地转为运行图标，
 * 不按新面孔跳最右）；键已在序中（帧间陈旧账）先去重再插，恒无重复。
 */
export function promoteRunToFront(runOrder: readonly string[], key: string): string[] {
  return [key, ...runOrder.filter((k) => k !== key)]
}
