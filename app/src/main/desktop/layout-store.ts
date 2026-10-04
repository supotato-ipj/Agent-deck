// 用户摆位存储（工单06，纯逻辑）：手钉清单 + 两个分区的显式摆位有序名单。
// 自绘世界没有坐标可存——「拖到哪」记成「排在谁前面」（成员名单的相对顺序）；
// 名单里的陈旧名字（文件已删）原样保留、编排时被池过滤，文件回来了摆位还在。
// Python 世界的漂移纠正与布局快照不迁移（自绘布局不受系统打扰），出厂态 = 无显式摆位。
import type { DesktopZone } from '../../shared/contract'

export interface LayoutStore {
  version: 1
  /** 手钉显示名有序清单（pinned.json 语义平移；占据 dock 前段） */
  pinned: string[]
  /** dock 显式摆位有序名单（zone 隐含 app） */
  dock: string[]
  /** 文档区显式摆位有序名单（zone 隐含 doc） */
  docs: string[]
}

export const FACTORY_STORE: LayoutStore = { version: 1, pinned: [], dock: [], docs: [] }

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
  return {
    version: 1,
    pinned: strList(r.pinned),
    dock: strList(r.dock),
    docs: strList(r.docs),
  }
}

export function serializeStore(store: LayoutStore): string {
  return JSON.stringify(store, null, 1) + '\n'
}

function factoryCopy(): LayoutStore {
  return { version: 1, pinned: [], dock: [], docs: [] }
}

/**
 * 摆位动作（拖拽落点）：name 从两个名单中移除后，插入目标名单 beforeName 之前；
 * beforeName 为 null 追加到末尾。同一名字至多在一个名单里（跨区拖拽即换区）。
 * 名单允许含不在池中的名字（过滤发生在编排），这里不做池校验（服务层先校验）。
 */
export function moveItem(
  store: LayoutStore,
  name: string,
  zone: DesktopZone,
  beforeName: string | null,
): LayoutStore {
  // 手钉身份不受拖拽影响：钉住的条目挪动只改 dock 名单，pinned 清单原样保留
  const next: LayoutStore = {
    version: 1,
    pinned: [...store.pinned],
    dock: store.dock.filter((n) => n !== name),
    docs: store.docs.filter((n) => n !== name),
  }
  const target = zone === 'app' ? next.dock : next.docs
  const at = beforeName === null ? -1 : target.indexOf(beforeName)
  if (at < 0) target.push(name)
  else target.splice(at, 0, name)
  return next
}

/** 恢复出厂布局：清掉全部显式摆位（dock/docs 名单），手钉清单保留（用户意图非布局） */
export function resetFactory(store: LayoutStore): LayoutStore {
  return { version: 1, pinned: [...store.pinned], dock: [], docs: [] }
}

/**
 * 钉到应用区（工单25）：name 进手钉清单前段——已在清单则移到最前（不重复）。
 * 显式摆位名单不动：手钉期间其条目被 dock 前段身份遮蔽（planDock 手钉段优先），
 * 取消手钉时按原名单裁决归位——「钉」不销毁「摆」，两份用户意图各自存续。
 */
export function pinItem(store: LayoutStore, name: string): LayoutStore {
  return { version: 1, pinned: [name, ...store.pinned.filter((n) => n !== name)], dock: [...store.dock], docs: [...store.docs] }
}

/** 取消手钉（工单25）：name 从手钉清单移除，条目回归归类与显式摆位裁决；
 * 不在清单即原样返回（幂等空转，菜单条件显隐下不可达的防御性下限）。 */
export function unpinItem(store: LayoutStore, name: string): LayoutStore {
  return { version: 1, pinned: store.pinned.filter((n) => n !== name), dock: [...store.dock], docs: [...store.docs] }
}
