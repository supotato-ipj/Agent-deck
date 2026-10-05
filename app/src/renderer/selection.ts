// 选区状态机（工单20，纯逻辑）：名字集合 + 事件迁移，不含 DOM——渲染层只消费其输出，
// 是后续框选（#21）、菜单、键盘工单的公共地基。选区按 GLOSSARY.md 词条「选区」：
// 跨分区（只存名字，分区无关）、按名存续、随交互清空、瞬态不落盘。
//
// 语义矩阵（#19 spec 定稿）：click=单选重置、ctrl+click=切换、blank-click=清空、
// reconcile=按名恢复/消失剔除；band=替换、ctrl+band=并集（#21 框选接线）；
// select-all=全选（#23 上下文菜单，名单整体替换）。
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
  /** 框选松手：命中名单替换现选区（工单21；names 为矩形相交条目，DOM 序） */
  | { type: 'band'; names: readonly string[] }
  /** Ctrl+框选松手：命中名单与现选区求并集（旧选区保序在前，新命中依序追加去重） */
  | { type: 'ctrl-band'; names: readonly string[] }
  /** 全选（工单23 上下文菜单）：名单整体替换现选区（names = 当前池内全部条目） */
  | { type: 'select-all'; names: readonly string[] }
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
    case 'band':
      // 命中即选区：框到纯空白 = 清空（真桌面同款）
      return { names: [...event.names], swallowed: null }
    case 'ctrl-band': {
      // 并集只追加新命中：已选条目按名去重，插入序（= 逐项启动顺序）不打乱
      const fresh = event.names.filter((n) => !model.names.includes(n))
      return { names: [...model.names, ...fresh], swallowed: null }
    }
    case 'select-all':
      // 全选即整体替换：显式增删，吞集随旧选区一并作废
      return { names: [...event.names], swallowed: null }
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

/** 键盘 Enter（工单31 六键）的启动名单：当前选区整份（多选整集、单选单条），不复活吞集
 * （评审 c1：story「Enter 打开选中」= 当前选区——吞集是双击路径专属判据，单击收束后
 * Enter 只开手里这一条；与 launchListOf 的整集语义故意分叉，对照用例锁定在 selection.spec）。 */
export function keyboardOpenTargets(model: SelectionModel): readonly string[] {
  return [...model.names]
}

/** 条目上下文菜单裁决（工单24 单项 / 工单26 多选，GLOSSARY.md「上下文菜单」）：右键命中
 * 非选中条目先切单选（switchTo = 该条）再弹单项菜单；该条即全部选区直接弹单项菜单；
 * 选中集内条目（选区多于一条）弹多选菜单，动作作用于整个选区（无选区副作用）。 */
export type ItemMenuPlan =
  | { kind: 'single'; switchTo: string | null }
  | { kind: 'multi' }

export function itemMenuPlan(model: SelectionModel, name: string): ItemMenuPlan {
  if (!model.names.includes(name)) return { kind: 'single', switchTo: name }
  return model.names.length > 1 ? { kind: 'multi' } : { kind: 'single', switchTo: null }
}
