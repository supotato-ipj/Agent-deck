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
 * 点卡片空白处（或「更多」徽标）→ 折叠/展开往复切换，**并清掉高亮**。
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
 * 状态 → 展开类名（收起态返回空串，即「不带这个类」）。
 * 状态到类名的映射只有这一处：工单180 的几何挂在类名上，而不是散在 card.js 的判断里。
 * @param {CardUiState} state
 * @returns {string}
 */
export function expandedClassOf(state) {
  return state.expanded ? EXPANDED_CLASS : ''
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
