// 用户摆位存储（工单06，纯逻辑；工单310 升版 v2）：文档区显式摆位有序名单 +
// 桌面组件手定位格点表。
// 自绘世界没有坐标可存——「拖到哪」记成「排在谁前面」（成员名单的相对顺序）；
// 名单里的陈旧名字（文件已删）原样保留、编排时被池过滤，文件回来了摆位还在。
// v2 新增 cards（工单310，ADR-0024）：**只有手定位写入**，未手定位走渲染层默认位表；
// 条目按 id 长期保留（插件停用/卸载不删，回来仍回到原格点）。位置以格点（col/row）
// 存储而非像素——分辨率变化不改变格点关系，夹取与冲突消解在渲染层落地。
// 旧版 v1 文件按空卡片表读入，文档项顺序原样保留（自愈，不丢用户已有摆位）。
import type { CardSlot, DesktopZone } from '../../shared/contract'

export interface LayoutStore {
  version: 2
  /** 文档区显式摆位有序名单（zone 隐含 doc） */
  docs: string[]
  /** 桌面组件手定位格点表：卡 id → 格点（只有用户拖过的卡在此） */
  cards: Record<string, CardSlot>
}

export const FACTORY_STORE: LayoutStore = { version: 2, docs: [], cards: {} }

/** 解析落盘 JSON；缺失/损坏/结构不符 → 出厂态（损坏自愈：下次保存覆写）。
 * 旧版（v1 / 无 version）读入时卡片表为空、文档项顺序原样保留（工单310 升版纪律）。 */
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
  const cards: Record<string, CardSlot> = {}
  if (typeof r.cards === 'object' && r.cards !== null && !Array.isArray(r.cards)) {
    for (const [id, slot] of Object.entries(r.cards as Record<string, unknown>)) {
      if (!id) continue
      if (typeof slot !== 'object' || slot === null || Array.isArray(slot)) continue
      const s = slot as Record<string, unknown>
      const col = Number(s.col)
      const row = Number(s.row)
      if (!Number.isInteger(col) || !Number.isInteger(row) || col < 0 || row < 0) continue
      cards[id] = { col, row }
    }
  }
  return { version: 2, docs: strList(r.docs), cards }
}

export function serializeStore(store: LayoutStore): string {
  return JSON.stringify(store, null, 1) + '\n'
}

function factoryCopy(): LayoutStore {
  return { version: 2, docs: [], cards: {} }
}

/** 摆位动作（拖拽摆位）：name 插入文档区名单 beforeName 之前；beforeName 为 null
 * 追加到末尾。名单允许含不在池中的名字（过滤发生在编排），这里不做池校验。
 * 卡片格点表原样保留。 */
export function moveItem(
  store: LayoutStore,
  name: string,
  zone: DesktopZone,
  beforeName: string | null,
): LayoutStore {
  const docs = store.docs.filter((n) => n !== name)
  if (zone !== 'doc') return { version: 2, docs, cards: { ...store.cards } } // 应用区不再由桌面承载：拖出即离文档区，不另找落点
  const at = beforeName === null ? -1 : docs.indexOf(beforeName)
  if (at < 0) docs.push(name)
  else docs.splice(at, 0, name)
  return { version: 2, docs, cards: { ...store.cards } }
}

/** 恢复出厂布局：清掉全部显式摆位（文档区名单）与全部卡片手定位（工单310：
 * 一键回到干净版面——两者同进同退），回到归类分组的出厂编排。 */
export function resetFactory(_store: LayoutStore): LayoutStore {
  return { version: 2, docs: [], cards: {} }
}

/**
 * 重命名同拍的摆位迁移（工单28）：from 在摆位名单里的身影原位换成 to——按名字键控的
 * 存储，文件改名不改名单就等于丢摆位。序与其余名字不动；名单里没有的名字原样返回。
 * 卡片格点表与文件无关，原样保留。
 */
export function renameItemInStore(store: LayoutStore, from: string, to: string): LayoutStore {
  if (!store.docs.includes(from)) return store
  return { version: 2, docs: store.docs.map((n) => (n === from ? to : n)), cards: { ...store.cards } }
}

/**
 * 删除同拍的摆位清除（工单27）：名字从摆位名单移除——文件已进回收站，名单留着会让
 * 日后的同名文件莫名归位。其余名字与序保持；名单里没有的名字原样跳过（幂等空转）。
 */
export function forgetItems(store: LayoutStore, names: readonly string[]): LayoutStore {
  const gone = new Set(names)
  const docs = store.docs.filter((n) => !gone.has(n))
  if (docs.length === store.docs.length) return store
  return { version: 2, docs, cards: { ...store.cards } }
}

/** 写入一张卡的手定位（工单310）：只增改该卡条目，其余卡片与文档名单原样。
 * 调用方保证 col/row 为已夹取的非负整数；这里只做存储层下限（负数归零）。 */
export function setCardSlot(store: LayoutStore, id: string, col: number, row: number): LayoutStore {
  const slot = { col: Math.max(0, Math.trunc(col)), row: Math.max(0, Math.trunc(row)) }
  return { version: 2, docs: [...store.docs], cards: { ...store.cards, [id]: slot } }
}
