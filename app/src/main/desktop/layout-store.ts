// 用户摆位存储（工单06，纯逻辑）：文档区的显式摆位有序名单。
// 自绘世界没有坐标可存——「拖到哪」记成「排在谁前面」（成员名单的相对顺序）；
// 名单里的陈旧名字（文件已删）原样保留、编排时被池过滤，文件回来了摆位还在。
// Python 世界的漂移纠正与布局快照不迁移（自绘布局不受系统打扰），出厂态 = 无显式摆位。
import type { DesktopZone } from '../../shared/contract'

export interface LayoutStore {
  version: 1
  /** 文档区显式摆位有序名单（zone 隐含 doc） */
  docs: string[]
}

export const FACTORY_STORE: LayoutStore = { version: 1, docs: [] }

/** 解析落盘 JSON；缺失/损坏/结构不符 → 出厂态（损坏自愈：下次保存覆写） */
export function loadStore(text: string | null): LayoutStore {
  if (text === null) return factoryCopy()
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return factoryCopy()
  }
  if (typeof raw !== 'object' || raw === null) return factoryCopy()
  const r = raw as Record<string, unknown>
  const strList = (v: unknown): string[] =>
    Array.isArray(v) && v.every((x) => typeof x === 'string') ? [...v] : []
  return { version: 1, docs: strList(r.docs) }
}

export function serializeStore(store: LayoutStore): string {
  return JSON.stringify(store, null, 1) + '\n'
}

function factoryCopy(): LayoutStore {
  return { version: 1, docs: [] }
}

/** 摆位动作（拖拽摆位）：name 插入文档区名单 beforeName 之前；beforeName 为 null
 * 追加到末尾。名单允许含不在池中的名字（过滤发生在编排），这里不做池校验。 */
export function moveItem(
  store: LayoutStore,
  name: string,
  zone: DesktopZone,
  beforeName: string | null,
): LayoutStore {
  const next: LayoutStore = { version: 1, docs: store.docs.filter((n) => n !== name) }
  if (zone !== 'doc') return next // 应用区不再由桌面承载：拖出即离文档区，不另找落点
  const at = beforeName === null ? -1 : next.docs.indexOf(beforeName)
  if (at < 0) next.docs.push(name)
  else next.docs.splice(at, 0, name)
  return next
}

/** 恢复出厂布局：清掉全部显式摆位（文档区名单），回到归类分组的出厂编排 */
export function resetFactory(store: LayoutStore): LayoutStore {
  return { version: 1, docs: [] }
}

/**
 * 重命名同拍的摆位迁移（工单28）：from 在摆位名单里的身影原位换成 to——按名字键控的
 * 存储，文件改名不改名单就等于丢摆位。序与其余名字不动；名单里没有的名字原样返回。
 */
export function renameItemInStore(store: LayoutStore, from: string, to: string): LayoutStore {
  if (!store.docs.includes(from)) return store
  return { version: 1, docs: store.docs.map((n) => (n === from ? to : n)) }
}

/**
 * 删除同拍的摆位清除（工单27）：名字从摆位名单移除——文件已进回收站，名单留着会让
 * 日后的同名文件莫名归位。其余名字与序保持；名单里没有的名字原样跳过（幂等空转）。
 */
export function forgetItems(store: LayoutStore, names: readonly string[]): LayoutStore {
  const gone = new Set(names)
  return { version: 1, docs: store.docs.filter((n) => !gone.has(n)) }
}
