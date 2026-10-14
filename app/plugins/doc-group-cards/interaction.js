// 组卡交互语义的纯逻辑（工单181 = spec166 之④：点击展开、高亮、热区重声明）。
//
// 与同目录 grouping.js 同一条缝：插件源码即投放单元（面板经 deck-plugin:// 原样 import，
// 不能有编译步骤），入口必须是浏览器可跑的 ES 模块；而「点击落到哪儿、要不要截断冒泡、
// 状态怎么迁移」这些裁决要能被 vitest 直测，就必须不碰 DOM、不碰 Electron。
// 这个文件是那条缝的另一半，card.js 在缝的另一侧接线与画卡。
//
// **高亮是插件自建的一套，不是内核选区。** 内核选区状态是渲染层的模块私有变量
// （main.ts `let selection`）——既不导出也不挂 window，桥接契约表里没有对应方法，
// 且插件是 deck-plugin:// 下的另一套模块图、够不着渲染层源码，插件没有任何接口可接。
// 故这里的「选中」就是插件自己的一枚类名 + 一个以绝对路径为键的集合：
// 不读内核选区、不写内核选区、不伪造内核那套 desktop-selected 存证。
// 内核选中态是 `.ditem.sel`（applySelection），本插件的格子一律不是 `.ditem`，两条线互不相干。

/** 卡片根类名：同时是本插件样式表的作用域根（`.dgc-card .dgc-cell {...}` 挂它身上） */
export const CARD_CLASS = 'dgc-card'
/** 组内单格（一个文件图标） */
export const CELL_CLASS = 'dgc-cell'
/** 「更多」徽标：工单180 落 +N 徽标时用它；本票只认它、不造它 */
export const MORE_CLASS = 'dgc-more'
/**
 * 展开态类名 —— **工单180 的接缝**。
 * 本票只负责「点空白处把折叠/展开切换掉」这一层语义，几何一行不写；
 * 工单180 只要给 `.card.dgc-expanded {...}` 写几何规则，切换即自动带上。
 * 故此处类名是常量而非字面量：#180 接的是同一个常量，两边不会各写各的。
 */
export const EXPANDED_CLASS = 'dgc-expanded'
/** 高亮类名：插件私有，绝不叫 `sel`（那是内核 `.ditem` 的选中类名） */
export const HIGHLIGHT_CLASS = 'dgc-selected'
/**
 * 淡出类名（工单180）：**别的卡被展开了，你才淡出**。
 * 与展开类名一样是插件私有的，不与内核选区类名 `sel`、也不与本插件自己的其他类名相撞。
 */
export const FADED_CLASS = 'dgc-faded'

/**
 * 点击落点。本票的三个有效落点 + 一个「哪都不是」：
 * @typedef {'icon' | 'card-blank' | 'more' | 'outside'} ClickHit
 */

/**
 * 卡片级交互态：**插件自建**（内核够不着，本插件也不去够）。
 * @typedef {object} CardUiState
 * @property {boolean} expanded 折叠/展开（本票只切这个布尔量，不碰几何）
 * @property {ReadonlySet<string>} highlight 高亮的绝对路径集合（单选：后点的顶掉先点的）
 */

/**
 * 点击之后卡片级监听器该不该切换折叠。
 *
 * **这就是「点图标不改变卡片形状」的那道闸。** 图标是 `.card` 的后代，事件本会冒泡上来；
 * 即便图标那侧漏了 `stopPropagation()`，这里也返回 false —— 卡片级监听器对图标命中无动作可做。
 * 「更多」徽标与空白处等价（验收标准：点空白与点徽标同样展开/收起），故同列 true。
 * @param {ClickHit} hit
 * @returns {boolean}
 */
export function isCardToggle(hit) {
  return hit === 'card-blank' || hit === 'more'
}

/**
 * 这次右键该不该开**组卡菜单**（工单183）。
 *
 * 与 {@link isCardToggle} 同一道闸、同一个 spirit：**图标格上右键是文件菜单**，格那侧已经
 * 截断冒泡自己开去了；即便漏了，这里也返回 false，卡片级监听器对图标命中无动作可做。
 * 徽标与空白处等价（卡片自己的空白面，spec166：组卡菜单是卡片空白右键）。
 *
 * 组卡菜单的行表当前是空的（spec166 的 PASTE / NEW GROUP / EDIT TYPES / DISSOLVE 分属
 * 工单185/186），故本题只钉住**裁决**这一半：命中判对了，行到即自动出菜单。
 * @param {ClickHit} hit
 * @returns {boolean}
 */
export function isGroupMenuHit(hit) {
  return hit === 'card-blank' || hit === 'more'
}

/** 初始态：收起、无高亮。热重载重挂（换代即新模块实例）回到的就是这个态 */
export function initialCardState() {
  return { expanded: false, highlight: new Set() }
}

/** 该路径是否处于高亮态 */
export function isHighlighted(state, path) {
  return state.highlight.has(path)
}

/**
 * 点图标 → 高亮它，**且必须截断冒泡**。
 * 高亮只改类名、不改布局盒（outline + 背景色，见 card.js 样式），故卡片的
 * `getBoundingClientRect()` 纹丝不动：选文件绝不改卡片形状。
 * @param {CardUiState} state
 * @param {string} path 绝对路径（高亮以路径为键，与内核按 `data-name` 存的选区互不相干）
 * @returns {{ state: CardUiState, stopPropagation: true, action: 'highlight' }}
 */
export function clickOnIcon(state, path) {
  // 单选语义：后点的高亮顶掉先点的（点空白即全清，故不存在多选残留）。
  // 后续工单要 Ctrl 多选，改的就是这一行（并集）。
  return {
    state: { expanded: state.expanded, highlight: new Set([path]) },
    stopPropagation: true,
    action: 'highlight',
  }
}

/**
 * 状态 → 某格的高亮类名（未高亮返回空串）。
 * @param {CardUiState} state
 * @param {string} path
 * @returns {string}
 */
export function highlightClassOf(state, path) {
  return isHighlighted(state, path) ? HIGHLIGHT_CLASS : ''
}

// ---------------------------------------------------------------------------
// 工单180（spec166 之③）：同一时刻只允许一张卡展开，其余卡淡出
//
// 「至多一张展开」是**全表**性质，而工单181 的 CardUiState 是**每卡**的。故状态仍按卡存
// （重画时能整表清、换代时能整表丢），而「哪张展开着」由全表推导——不另设一个模块级单值，
// 否则它就会变成第二个真相来源，和 cardState 里的 expanded 各记各的。
// ---------------------------------------------------------------------------

/**
 * 全表里当前展开的卡 id（空串 = 都没展开）。
 *
 * 若因任何原因出现多张同时展开（不该发生：本模块是唯一写 `expanded` 的地方），取卡序最前
 * 的一张为准——唯一读处立刻收敛回「一张」，不会带着矛盾继续往下算。
 * @param {ReadonlyMap<string, CardUiState>} states
 * @returns {string}
 */
export function expandedCardIdOf(states) {
  for (const [id, state] of states) if (state.expanded) return id
  return ''
}

/**
 * 状态 → 展开类名（收起态返回空串，即「不带这个类」）。
 * 状态到类名的映射只有这一处：工单180 的几何挂在类名上，而不是散在 card.js 的判断里。
 * @param {CardUiState} state
 * @returns {string}
 */
export function expandedClassOf(state) {
  return state.expanded ? EXPANDED_CLASS : ''
}

/**
 * 点空白处（或「更多」徽标）→ 折叠/展开往复切换，**并清掉高亮**（工单181 的单卡语义）。
 *
 * 它只看得见自己那一张卡，故**不知道**全表还有谁展开着——真要「点另一张自动收起前一张」，
 * 用下面的 {@link clickToggleExclusive}。这个函数保留在接口里：它仍是单卡语义的基准，
 * 也被工单181 的测试钉着。
 * @param {CardUiState} state
 * @returns {{ state: CardUiState, stopPropagation: false, action: 'toggle-expand' }}
 */
export function clickOnCardBlank(state) {
  return {
    state: { expanded: !state.expanded, highlight: new Set() },
    stopPropagation: false,
    action: 'toggle-expand',
  }
}

/**
 * 点空白处（或「更多」徽标）→ 在**全表**上往复切换，且**同一时刻至多一张展开**：
 * 点的是已展开的那张就收起它；点的是别的就展开它、其余全部收起。
 *
 * 纯函数：入表原样不改，返回新表（重画整排时连同返回的表一起换掉即可）。
 * 其余卡只是**被顺带收起**，它们的高亮原样保留——折叠别人的卡不该顺手取消用户的选中。
 *
 * 这是 `clickOnCardBlank` 的全表版本，语义上多了「排他」一条；徽标命中与空白命中走的是同一个
 * 裁决入口（工单181 已定），故点徽标展开、点别张卡自动收起前一张，两句话是同一行代码。
 *
 * @param {ReadonlyMap<string, CardUiState>} states 全表交互态（键为卡片 id，插入序即卡序）
 * @param {string} cardId 被点的那张
 * @returns {{ states: Map<string, CardUiState>, state: CardUiState, stopPropagation: false, action: 'toggle-expand' }}
 */
export function clickToggleExclusive(states, cardId) {
  const target = states.get(cardId)
  const collapsing = Boolean(target && target.expanded)
  /** @type {Map<string, CardUiState>} */
  const next = new Map()
  for (const [id, state] of states) {
    if (id === cardId) next.set(id, { expanded: !collapsing, highlight: new Set() })
    else next.set(id, { expanded: false, highlight: state.highlight })
  }
  // 表里还没有这张卡（刚被重画出来，态表还没记它）：照样能展开
  if (!next.has(cardId)) next.set(cardId, { expanded: !collapsing, highlight: new Set() })
  return { states: next, state: next.get(cardId), stopPropagation: false, action: 'toggle-expand' }
}

/**
 * 全表状态 → 某张卡的淡出类名（没人展开返回空串，即「不带这个类」）。
 * 与 {@link expandedClassOf} 同一层映射：状态 → 类名只有这一处出口，card.js 不自己判断。
 * @param {string} expandedId 当前展开的卡 id（空串 = 都没展开）
 * @param {string} cardId 要判的那张卡
 * @returns {string}
 */
export function fadedClassOf(expandedId, cardId) {
  return expandedId && expandedId !== cardId ? FADED_CLASS : ''
}
