// 卡内多选的裁决（工单184 = spec166 之⑦：开关、框选、ENTER 批量启动）。
//
// 与同目录 grouping.js / interaction.js / geometry.js / menu.js 同一条缝：**纯模块、零 DOM、
// 零 Electron**，vitest 直测。投放型插件包的源码就是投放单元（面板经 deck-plugin:// 原样 import，
// 无编译步骤），而「多选开关怎么切」「框选命中哪些」「ENTER 该启动谁」「右键该作用于谁」这四类
// 裁决必须离开 DOM 才能被测——它们也是最容易在演进中各自漂移的四类。故各自只有这一处出处，
// card.js 一个判定都不许另写。
//
// **多选与 #181 的单选共用同一枚状态，不另设第二个真相。** interaction.js 的 CardUiState 里
// 那个 `highlight` 集合本来就已经是「以绝对路径为键的选中集」，工单181 把它用成单选语义
// （后点的顶掉先点的）；本票只在 `multi` 为真时把它用成多选语义（并集 / 切换 / 框选整批替换）。
// 故 `clickOnIcon` 一行未改，非多选态走的仍是它——肌肉记忆与既有验收标准都不被本票动到。
//
// **卡内独立是结构性的，不是约定。** 本模块的所有裁决都只看得见**一张卡**的 CardUiState：
// 没有「选区分布在哪几张卡」这种全表概念，也没有跨卡合并的入口。框选命中集合同理由调用方
// 决定——card.js 传进来的就是**那张卡自己**的格子表，别的卡压根不在表里。
// spec166「已知代价」一节把跨卡选区明确列为不做，本文件即为那句话的代码形态。
//
// **启动一律走内核既有契约**：launchTargetsOf 只回答「该启动谁」，逐项 desktop/launch 由
// card.js 发出（主进程侧的扫描池护栏原样生效）。本模块不碰文件、不写盘。

/** 多选开关的类名（挂在卡头上，每张卡一枚） */
export const MULTI_CLASS = 'dgc-multi'
/** 开关打开时的附加类名（点亮态；与内核 `.ditem.sel` 无任何关系） */
export const MULTI_ON_CLASS = 'dgc-multi-on'
/** 框选拖拽带的类名（只在拖拽期间在场，松手即摘） */
export const MARQUEE_CLASS = 'dgc-marquee'
/**
 * ENTER 批量启动的键盘档名（自由档名，宿主按插件 id 加命名空间后并进键盘模式单通道归一仲裁）。
 *
 * **持拿它即让窗口可聚焦**——面板默认 focusable:false，ENTER 送不到本插件的 keydown 监听，
 * 而宿主/契约里没有任何「聚焦某个元素」的 API（键盘档是让位而非抢占：持档期间内核六键与 Esc
 * 捕获双双让开）。故档必须在**选区活跃期间**持、选区一空即放、卸载必放。
 *
 * 与 #182 的菜单档（`'menu'`）、#183 的确认层/重命名档各持各的，互不相干：档名不共用，
 * 一层开着不会把另一层的放行误领走。
 */
export const SELECT_KEYBOARD_TIER = 'multi-select'

/** 多选态存证族（与 #182 的 `doc-group-cards-menu-*` 各归各的，验收电池不会把两处证据混为一谈） */
export const MULTI_TOGGLED_NOTIFY = 'doc-group-cards-multi-toggled'
export const SELECTION_LAUNCHED_NOTIFY = 'doc-group-cards-launch-selection'

/**
 * 开关与框选只看得见**一张卡**的交互态（结构上够不着别的卡——多选不跨卡是 spec166 明令不做的）。
 * @typedef {import('./interaction.js').CardUiState} CardUiState
 */

/** 该卡是否开着多选 */
export function isMultiOn(state) {
  return state.multi === true
}

/**
 * 多选开关：往复切换。**关掉即清空选区**——留着高亮会让用户以为还选着，而下一次框选又要从
 * 一个看不见的旧选区起算。
 *
 * 展开态一个字节都不碰：多选与折叠是两件事，一件事不该顺手代劳另一件。
 * @param {CardUiState} state
 * @returns {{ state: CardUiState, stopPropagation: true, action: 'toggle-multi' }}
 */
export function toggleMulti(state) {
  const on = !isMultiOn(state)
  return {
    state: { expanded: state.expanded, multi: on, highlight: on ? state.highlight : new Set() },
    stopPropagation: true,
    action: 'toggle-multi',
  }
}

/**
 * 多选态下单击图标：**切换**选中（选中则取消，取消则选中），**并集**而非后点顶掉先点。
 *
 * 与 interaction.js 的 `clickOnIcon` 是同一个动作的两种语义：那个是单选（替换），
 * 这个是多选（并集）。裁决各归一处，卡片级监听器只需问 `isMultiOn(state)` 走哪条。
 * 截断冒泡照旧——否则同一次点击会顺带把整卡折叠（#181 钉死的那道闸，多选态下同样成立）。
 * @param {CardUiState} state
 * @param {string} path 绝对路径（选中集以路径为键，与内核选区互不相干）
 * @returns {{ state: CardUiState, stopPropagation: true, action: 'toggle-select' }}
 */
export function toggleSelection(state, path) {
  const highlight = new Set(state.highlight)
  if (highlight.has(path)) highlight.delete(path)
  else highlight.add(path)
  return {
    state: { expanded: state.expanded, multi: state.multi === true, highlight },
    stopPropagation: true,
    action: 'toggle-select',
  }
}

/** 该卡当前选中了哪些路径（顺序 = 加入顺序；空集即没选） */
export function selectionPathsOf(state) {
  return [...state.highlight]
}

/**
 * 右键该把菜单作用于谁（工单184：多选态下对**整个选中集**生效）。
 *
 * 落在**已选中**的格子上 → 选区原样保留，菜单作用于整个选中集（「我选了这三个，右键当然
 * 是对这三个」）。落在**未选中**的格子上 → 单独选中它：否则菜单会作用在一个用户并没有选、
 * 又混着一堆别的的集合上，「对选中集生效」这句话就落空了。
 * @param {CardUiState} state
 * @param {string} path 被右键的那一格
 * @returns {string[]}
 */
export function menuSelectionFor(state, path) {
  if (!isMultiOn(state)) return [path]
  if (state.highlight.has(path)) return [...state.highlight]
  return [path]
}

/**
 * 拖拽两端点 → 归一化矩形（左上/右下与右下/左上两种拖法等效）。
 * @param {{ x: number, y: number }} from
 * @param {{ x: number, y: number }} to
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
export function marqueeRectOf(from, to) {
  const x = Math.min(from.x, to.x)
  const y = Math.min(from.y, to.y)
  return { x, y, width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y) }
}

/**
 * 两个矩形是否相交（**半开区间**：紧贴边不算——相邻格子的公共边界不互相吃掉，
 * 否则框选会多吃一列/多一行）。
 * @param {{ x: number, y: number, width: number, height: number }} a
 * @param {{ x: number, y: number, width: number, height: number }} b
 * @returns {boolean}
 */
export function rectsOverlap(a, b) {
  if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) return false
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/**
 * 框选命中集合：**只从传进来的那张表的格子**里取（故命中集天然卡内——别的卡不在表里）。
 *
 * 判据是**矩形相交**而非中心点落在框内：部分压到的格子也算选中，这是框选的通行口径。
 * 零尺寸的框（点一下没拖）不命中任何格子——否则「在空白处点一下」会变成一次误清。
 * @param {{ x: number, y: number, width: number, height: number }} rect
 * @param {readonly { path: string, x: number, y: number, width: number, height: number }[]} cells 本卡的格子表
 * @returns {string[]}
 */
export function marqueeHits(rect, cells) {
  if (rect.width <= 0 || rect.height <= 0) return []
  const out = []
  for (const cell of cells || []) if (rectsOverlap(rect, cell)) out.push(cell.path)
  return out
}

/**
 * 框选落定：选区**整批替换**成命中集合（不是并上去——框的口径是「这一框选中的就是全部」，
 * 与逐个单击的「往集里加」相反；框空即清空，与点空白清高亮同款）。
 *
 * 只在多选态下成立：关着的卡上框一下不产生任何选区。
 * @param {CardUiState} state
 * @param {{ x: number, y: number, width: number, height: number }} rect
 * @param {readonly { path: string, x: number, y: number, width: number, height: number }[]} [cells] 本卡的格子表
 * @returns {{ state: CardUiState, stopPropagation: false, action: 'marquee-select' }}
 */
export function marqueeSelect(state, rect, cells) {
  const hits = isMultiOn(state) ? marqueeHits(rect, cells || []) : []
  return {
    state: { expanded: state.expanded, multi: state.multi === true, highlight: new Set(hits) },
    stopPropagation: false,
    action: 'marquee-select',
  }
}

/**
 * ENTER 该启动谁：**仅多选态**下的整个选中集（单选态不批量启动——双击启动是肌肉记忆，
 * ENTER 不去抢它的活）；空选区不启动。
 * @param {CardUiState} state
 * @returns {string[]}
 */
export function launchTargetsOf(state) {
  if (!isMultiOn(state)) return []
  return [...state.highlight]
}

/**
 * 全表里有**哪张卡**在多选且选区非空（= 键盘档该不该持、ENTER 该不该有东西可启动）。
 *
 * 档随选区起落而不是随模式起落：多选开着但一个都没选时，没有可启动的东西，档不必持
 * （持着会让面板一直可聚焦，那是白占键盘通道）。
 * @param {ReadonlyMap<string, CardUiState>} states
 * @returns {boolean}
 */
export function hasSelection(states) {
  for (const state of states.values()) if (isMultiOn(state) && state.highlight.size > 0) return true
  return false
}
