// 扩展组分组（工单179 = spec166 之②）：投放型插件包 doc-group-cards 的**纯逻辑**部分。
//
// 纯模块是硬约束，不是洁癖：插件源码即投放单元，由面板经 deck-plugin:// 原样 import，
// 不能有编译步骤，所以入口必须是浏览器可跑的 ES 模块；而分组规则要能被 vitest 直测，
// 就必须不碰 DOM、不碰 Electron。这个文件是那条缝，card.js 在缝的另一侧画卡。
//
// 领域词汇见 GLOSSARY.md：**扩展组**（按单个扩展名聚合的一组桌面文件，是组卡的分组单位）
// 与内核按类别聚合的**文档组**（folders/office/pdf/image/archive/other 六类）不是一回事，
// 本插件不去动内核那条规则（ADR-0014）。桌面项自身不带扩展名字段（DesktopItem 无此字段），
// 分组键一律由文件名现推。

/**
 * 纯逻辑认的桌面项形状：只读 name 与 kind。
 * 内核的 DesktopItem 结构上即可满足（kind 是 string 的子集），故内核零改动。
 * @typedef {{ name: string, kind: string }} GroupableItem
 */

/**
 * @typedef {object} ExtensionGroup
 * @property {string} key 分组键：单个文件扩展名（小写、含点，如 '.docx'）；无扩展名为空串
 * @property {string} label 卡面标签（面板既有组标签一律全大写）
 * @property {string} id 组卡的 DOM id（热区扫掠取 card.id，故必须唯一）
 * @property {GroupableItem[]} items 组内条目（保持入参序）
 */

/**
 * 固有组序表（工单179 **硬编码在插件里**）：办公系 → pdf → image 系 → 压缩系。
 * 组序固定 ⇒ 卡序固定 ⇒ 卡的位置可预期（spec166「卡片几何与布局」）。
 *
 * 后续工单（spec166 之⑧）把组定义换成 plugin-config 驱动、并叠加自定义组卡与临时组卡；
 * 换法就是把这个表从「入参默认值」换成「配置算出来的表」——`groupByExtension(items, order)`
 * 的第二参就是那道缝，现在只留形状，不建配置读取与持久化。
 *
 * 表外扩展名按字母序兜底（用户在桌面引入新类型时也有卡，不会凭空消失）。
 * @type {readonly string[]}
 */
export const EXT_GROUP_ORDER = [
  // 办公系
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp', '.rtf', '.csv',
  // pdf
  '.pdf',
  // image 系
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg', '.ico', '.tif', '.tiff',
  // 压缩系
  '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz',
]

/** 文件名 → 扩展名（小写、含点）；无扩展名（`README`、`.gitignore` 隐藏文件）返回空串 */
export function extOf(name) {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return ''
  return name.slice(dot).toLowerCase()
}

/**
 * 条目 → 分组键；非文件条目（快捷方式/网址文件/文件夹）返回 null，即「不进卡」。
 * 注意：plan.docs 已按 zone 滤掉 shortcut/url，但 state.items 里它们还在，故此处必须自己滤。
 */
export function groupKeyOf(item) {
  return item.kind === 'file' ? extOf(item.name) : null
}

/** 分组键 → 卡面标签：扩展名去点全大写（`.docx` → `DOCX`）；无扩展名组落字面标签 */
export function groupLabelOf(key) {
  return key ? key.slice(1).toUpperCase() : 'NO EXTENSION'
}

/**
 * 分组键 → 组卡 DOM id 的基名（`dgc-` 前缀便于热区日志认人）。
 * 渲染层扫热区时 `id` 直接取自 `card.id` 且**不去重**（main.ts declareHotZones），
 * 故唯一性由 groupByExtension 保证：撞车则加序号后缀（见下）。
 */
export function cardIdOf(key) {
  if (!key) return 'dgc-noext'
  const slug = key.slice(1).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug ? `dgc-${slug}` : 'dgc-x'
}

/** 组序：表内按表序，表外（表外扩展名与无扩展名组）统一按字母序兜底 */
function sortGroupKeys(keys, order) {
  return [...keys].sort((a, b) => {
    const rank = order.indexOf(a) - order.indexOf(b)
    return rank !== 0 ? rank : (a < b ? -1 : a > b ? 1 : 0)
  })
}

/**
 * 桌面项 → 扩展组列表（组序即卡序）。空组不产出：只有真有文件的扩展名才成组。
 * @param {readonly GroupableItem[]} items 桌面条目池（内核 state.items 形状）
 * @param {readonly string[]} [order] 固有组序表（默认硬编码表；后续工单换成配置驱动）
 * @returns {ExtensionGroup[]}
 */
export function groupByExtension(items, order = EXT_GROUP_ORDER) {
  /** @type {Map<string, GroupableItem[]>} */
  const buckets = new Map()
  for (const item of items) {
    const key = groupKeyOf(item)
    if (key === null) continue
    const bucket = buckets.get(key)
    if (bucket) bucket.push(item)
    else buckets.set(key, [item])
  }
  /** @type {ExtensionGroup[]} */
  const groups = sortGroupKeys(buckets.keys(), order).map((key) => ({
    key, label: groupLabelOf(key), id: '', items: buckets.get(key),
  }))
  // 唯一 id：净化后的扩展名可能撞车（`.do cx` 与 `.do-cx` 同归 `dgc-do-cx`），
  // 而热区扫掠不去重——撞车即让后者带序号，一卡一 id 是硬约束不是讲究。
  const used = new Set()
  for (const group of groups) {
    const base = cardIdOf(group.key)
    let id = base
    for (let n = 2; used.has(id); n += 1) id = `${base}-${n}`
    used.add(id)
    group.id = id
  }
  return groups
}
