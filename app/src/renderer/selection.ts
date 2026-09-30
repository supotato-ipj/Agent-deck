// 选区状态机（工单20，纯逻辑）：名字集合 + 事件迁移，不含 DOM——渲染层只消费其输出，
// 是后续框选（#21）、菜单、键盘工单的公共地基。选区按 CONTEXT.md 词条「选区」：
// 跨分区（只存名字，分区无关）、按名存续、随交互清空、瞬态不落盘。
//
// 语义矩阵（#19 spec 定稿子集）：click=单选重置、ctrl+click=切换、blank-click=清空、
// reconcile=按名恢复/消失剔除；band=替换、ctrl+band=并集随 #21 接线时入矩阵，不预留。
//
// 双击全开（真桌面语义）：双击选中集内任一条 = 整集启动。浏览器先于 dblclick 补发两次
// click，第一次就会把选区收束为单条——故收束时把被吞的旧选区记进 swallowed 作判据；
// 双击序列的第二击由渲染层按 e.detail≥2 拦下不入迁移，dblclick 事件一次性消费 swallowed
// （连点不重复整集启动）。随后的再次单击因集合已是单条，swallowed 置空，旧集不再复活。

/** 选区态：names 为当前集合（插入序 = 逐项启动顺序）；swallowed 为被单击收束吞下的旧选区 */
export interface SelectionModel {
  readonly names: readonly string[]
  readonly swallowed: readonly string[] | null
}

export const EMPTY_SELECTION: SelectionModel = { names: [], swallowed: null }

export type SelectionEvent =
  /** 单击条目：选区重置为该条（收束多条选区时记 swallowed） */
  | { type: 'click'; name: string }
  /** Ctrl+单击条目：切换该条选中态（任何显式增删都作废 swallowed） */
  | { type: 'ctrl-click'; name: string }
  /** 单击分区空白：清空选区 */
  | { type: 'blank-click' }
  /** 双击条目：消费 swallowed（启动名单经 launchListOf 先行查询） */
  | { type: 'dblclick'; name: string }
  /** 快照重建：按名恢复、消失条目剔除（选区按名存续的落点） */
  | { type: 'reconcile'; liveNames: readonly string[] }

export function nextSelection(model: SelectionModel, event: SelectionEvent): SelectionModel {
  switch (event.type) {
    case 'click': {
      const inSet = model.names.includes(event.name)
      return {
        names: [event.name],
        swallowed: inSet && model.names.length > 1 ? model.names : null,
      }
    }
    case 'ctrl-click': {
      const has = model.names.includes(event.name)
      return {
        names: has ? model.names.filter((n) => n !== event.name) : [...model.names, event.name],
        swallowed: null,
      }
    }
    case 'blank-click':
      return { names: [], swallowed: null }
    case 'dblclick':
      return { names: model.names, swallowed: null }
    case 'reconcile': {
      const live = new Set(event.liveNames)
      const names = model.names.filter((n) => live.has(n))
      const kept = model.swallowed ? model.swallowed.filter((n) => live.has(n)) : null
      return { names, swallowed: kept && kept.length ? kept : null }
    }
  }
}

/** 双击启动名单：swallowed 含该条 = 整集（插入序逐项），否则仅该条 */
export function launchListOf(model: SelectionModel, name: string): readonly string[] {
  return model.swallowed && model.swallowed.includes(name) ? model.swallowed : [name]
}
