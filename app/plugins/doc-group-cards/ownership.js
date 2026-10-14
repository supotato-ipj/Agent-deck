// 组定义与三层归属（工单185 = spec166 之⑧：自定义组卡的建立与编辑）。
//
// 与同目录 grouping.js / interaction.js / geometry.js / menu.js / writeops.js 同一条缝：
// **纯模块、零 DOM、零 Electron**，vitest 直测。这一票的三个核心裁决全在这一处，且只在这一处：
//   1. **组定义的形状**（落在插件私有状态通道里的那一份，经 JSON 往返后仍自愈）；
//   2. **三层归属判定**（自定义卡命中 → 冲突先建先得 → 被领走的不再出固有卡 → 其余走固有卡）；
//   3. **临时卡序号分配**（序号必须在盘上，否则之⑨ 开工时序号随重启重排、`临时 01` 撞名）。
// 它们都是纯数据决策，混进 DOM 就会既测不动又各自漂移；card.js 在缝的另一侧画卡。
//
// **归属不存盘、只由定义现推**：组卡是归属概念，不是目录（ADR-0014）。任何一个文件归哪张卡，
// 永远是「桌面项 + 组定义」的一次纯函数求值——用户在 EDIT TYPES 里改了勾选，既有文件的归属
// 随之迁移是这条设计的**结构后果**，而不是需要单独同步的副作用（没有任何一份「文件 → 卡」的表）。
//
// 三层优先级（spec166「分组与归属」，自高而低）：
//   1. 自定义组卡 —— 命中**创建顺序最早**的那张（先建先得，与内核「同 id 跨扫描根先到先得」同一惯例）；
//   2. 临时组卡 —— **不参与**自动路由（只承接粘贴，生成规则归工单186）；本票只占位并落盘序号；
//   3. 固有扩展组 —— 兜底，只收没被任何自定义卡领走的扩展名。

import { EXT_GROUP_ORDER, groupByExtension, groupKeyOf, groupLabelOf, sortGroupKeys } from './grouping.js'

/**
 * 组定义在**插件私有状态通道**里的键名（工单178 的 plugin-config 本就按插件 id 命名空间，
 * 故这一个键即可；id 由调用方自证，命名空间隔离是约定式而非强制式）。
 * 整份定义放**一个**键里而不是拆成「组表」「计数器」两个键：一次写 = 一次原子写，
 * 拆开则「卡表写成功、计数器写失败」会留下一个把序号退回去的状态——而序号退回去就是撞名。
 */
export const STORE_KEY = 'groups'
/** 定义格式版本（自愈：版本不认识也照样按形状读，不抛） */
export const STORE_VERSION = 1

/** 三层的层名（判定结果与卡面标注共用这三个字面量，别处不另写） */
export const TIER_CUSTOM = 'custom'
export const TIER_TEMP = 'temp'
export const TIER_BUILTIN = 'builtin'

/**
 * @typedef {object} CustomGroupDef
 * @property {string} id 组卡 DOM id（`dgc-c<seq>`）；热区扫掠不去重，故必须全表唯一
 * @property {string} name 用户起的名（卡面标签就是它，不是扩展名大写）
 * @property {string[]} exts 接受的扩展名（小写含点；空串 = 无扩展名那一组）
 * @property {boolean} acceptAll 「接受全部类型」开关：为真时 exts 不作准，命中一切扩展名
 * @property {number} seq 创建序号（**先建先得的唯一依据**；与数组下标无关）
 */
/**
 * @typedef {object} TempGroupDef
 * @property {string} id `dgc-t<seq>`
 * @property {string} name 卡面名（只带序号：`临时 01`）
 * @property {number} seq 序号（与自定义卡共用一个计数器）
 * @property {number} createdAtMs 粘贴时刻（工单186 按批次排序用；缺失落 0，不编一个当前时间）
 */
/**
 * @typedef {object} GroupStore
 * @property {number} version
 * @property {number} nextSeq 下一个序号（单调；读回时按盘上已用的序号抬齐）
 * @property {readonly CustomGroupDef[]} groups 自定义组卡（按 (seq, id) 有序 = 创建顺序）
 * @property {readonly TempGroupDef[]} temps 临时组卡（本票只占位，生成规则归工单186）
 */

/** 空状态：计数器从 1 起，第一张卡拿到 seq 1 */
export function emptyStore() {
  return { version: STORE_VERSION, nextSeq: 1, groups: [], temps: [] }
}

/** 纯对象判定（数组不是——持久化里 groups 写成了数组要当坏值处理，不是坏顶层） */
function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * 扩展名归一：' .PDF ' → '.pdf'、'.tar.gz' → '.gz'（路由侧 extOf 只取末段，同口径）、
 * '' → ''（无扩展名那一组）、'pdf'/非字符串 → null（丢弃）。
 *
 * 隐藏文件名（'.gitignore'）与扩展名（'.docx'）语法上不可分辨，故按扩展名收下；这类认领是
 * **哑的**——路由把隐藏文件分到无扩展名组，它永远匹配不上，而不是错领别人的文件。
 * @param {unknown} v
 * @returns {string | null}
 */
function normExt(v) {
  if (typeof v !== 'string') return null
  const s = v.trim().toLowerCase()
  if (!s) return ''
  if (s[0] !== '.' || s.length < 2) return null
  const tail = s.slice(1)
  if (/[\\/]/.test(tail)) return null
  const dot = tail.lastIndexOf('.')
  const last = dot >= 0 ? tail.slice(dot) : tail
  return `.${last.replace(/^\.+/, '')}`
}

/** 扩展名清单归一：逐条筛、去重、排序（排序让落盘的形状稳定，读回 diff 无噪声） */
function normExts(raw) {
  if (!Array.isArray(raw)) return []
  const set = new Set()
  for (const v of raw) {
    const e = normExt(v)
    if (e !== null) set.add(e)
  }
  return [...set].sort()
}

/** 组定义自愈：坏形状逐项回退，实在不可寻址（无 id / 非正整数序号）的那条整条丢弃 */
function normGroupDef(raw) {
  if (!isPlainObject(raw)) return null
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  const seq = Number.isInteger(raw.seq) && raw.seq > 0 ? raw.seq : 0
  if (!id || !seq) return null
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : fallbackName(raw.seq)
  return { id, name, exts: normExts(raw.exts), acceptAll: raw.acceptAll === true, seq }
}

/** 临时卡定义自愈（本票它没有 exts/acceptAll：临时卡接受任意类型，规则归工单186） */
function normTempDef(raw) {
  if (!isPlainObject(raw)) return null
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  const seq = Number.isInteger(raw.seq) && raw.seq > 0 ? raw.seq : 0
  if (!id || !seq) return null
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : tempLabelOf(seq)
  const createdAtMs = Number.isFinite(raw.createdAtMs) ? Math.round(raw.createdAtMs) : 0
  return { id, name, seq, createdAtMs }
}

/**
 * 归一 + 按 (seq, id) 排序 + 按 id 去重（留序号最小的那条）。
 * 排序是**先建先得的依据**：裁决读的是这个次序，不是数组下标，故把数组顺序打乱也不会改判。
 */
function normDefs(raw, norm) {
  if (!Array.isArray(raw)) return []
  const list = raw.map(norm).filter(Boolean)
  list.sort((a, b) => (a.seq - b.seq) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  /** @type {Map<string, typeof list[number]>} */
  const byId = new Map()
  for (const def of list) if (!byId.has(def.id)) byId.set(def.id, def)
  return [...byId.values()]
}

/**
 * 把任意来路的东西（plugin-config 响应、内存态、上一次读回的）归一成可用的状态。
 *
 * **计数器的兜底**：`nextSeq` 一律被抬到「盘上已用序号 + 1」。于是**唯一性不依赖计数器被老实
 * 存着**——计数器丢了、被改回 1、被手工编辑过，只要那张卡还在盘上，它的序号就永远发不出去，
 * `临时 01` 不可能撞名。这是「序号纳入持久化设计」真正兜住的那一层。
 * @param {unknown} raw
 * @returns {GroupStore}
 */
export function normalizeStore(raw) {
  if (!isPlainObject(raw)) return emptyStore()
  const groups = /** @type {CustomGroupDef[]} */ (normDefs(raw.groups, normGroupDef))
  const temps = /** @type {TempGroupDef[]} */ (normDefs(raw.temps, normTempDef))
  let maxSeq = 0
  for (const g of groups) if (g.seq > maxSeq) maxSeq = g.seq
  for (const t of temps) if (t.seq > maxSeq) maxSeq = t.seq
  const declared = Number.isInteger(raw.nextSeq) && raw.nextSeq > 0 ? raw.nextSeq : 1
  return { version: STORE_VERSION, nextSeq: Math.max(declared, maxSeq + 1), groups, temps }
}

/**
 * 从 plugin-config 的响应里取出组定义。
 *
 * 响应形状是 `{ config, warnings }`（工单178），`config` 是该插件 id 名下整份键值；坏 JSON 视同
 * 空对象并由内核记 warning，故这里取不到值就给空状态——**不抛**，因为读不到定义不该让卡出不来。
 * @param {unknown} response
 * @returns {GroupStore}
 */
export function storeOf(response) {
  const config = isPlainObject(response) && isPlainObject(response.config) ? response.config : null
  return normalizeStore(config ? config[STORE_KEY] : undefined)
}

/** 名字丢了时的兜底（可读即可；不是编一个用户没起过的名字） */
function fallbackName(seq) {
  return `组 ${seq}`
}

/** 自定义组卡的 DOM id（`dgc-c` 前缀与固有组的扩展名净化名不共前缀，但仍走全表唯一化兜底） */
export function customCardIdOf(seq) {
  return `dgc-c${seq}`
}

/** 临时组卡的 DOM id */
export function tempCardIdOf(seq) {
  return `dgc-t${seq}`
}

/** 临时卡面名：只带序号（`临时 01`）。序号即唯一性，名字里再加时间戳也不能替代它 */
export function tempLabelOf(seq) {
  return `临时 ${String(seq).padStart(2, '0')}`
}

/** 卡名的兜底裁剪（卡面宽度有限；空名也不该画成一张没标题的卡） */
function cardNameOf(raw, seq) {
  const s = typeof raw === 'string' ? raw.trim() : ''
  return s ? s.slice(0, 40) : fallbackName(seq)
}

/**
 * 建一张自定义组卡。**纯函数**：返回新状态 + 新卡，不改入参。
 * 序号取自状态里的单调计数器，故「先建先得」在落盘之后依然成立。
 * @param {unknown} store
 * @param {{ name?: unknown, exts?: unknown, acceptAll?: unknown }} draft
 * @returns {{ store: GroupStore, group: CustomGroupDef }}
 */
export function addCustomGroup(store, draft) {
  const base = normalizeStore(store)
  const seq = base.nextSeq
  const group = {
    id: customCardIdOf(seq),
    name: cardNameOf(draft && draft.name, seq),
    exts: normExts(draft && draft.exts),
    acceptAll: Boolean(draft && draft.acceptAll),
    seq,
  }
  return { store: { ...base, nextSeq: seq + 1, groups: [...base.groups, group] }, group }
}

/**
 * 改一张自定义卡接受的类型（EDIT TYPES 的落库动作）。
 *
 * **只改定义、不动任何文件，也不记任何「文件 → 卡」的表**：归属由定义现推，故改完下一帧
 * 既有文件的归属自动迁移，无需手动干预（这是结构事实，不是同步动作）。
 * @param {unknown} store
 * @param {string} id
 * @param {{ exts?: unknown, acceptAll?: unknown }} types
 * @returns {GroupStore}
 */
export function editCustomGroupTypes(store, id, types) {
  const base = normalizeStore(store)
  if (!base.groups.some((g) => g.id === id)) return base // 不静默新建一张同名卡
  return {
    ...base,
    groups: base.groups.map((g) =>
      g.id === id ? { ...g, exts: normExts(types && types.exts), acceptAll: Boolean(types && types.acceptAll) } : g,
    ),
  }
}

/**
 * 占一张临时组卡的序号（**只占位不实现**：生成规则、接收哪些文件归工单186）。
 *
 * 本票要它，是因为序号**必须**在盘上：若序号只在内存里递增，重启后从头数，第二批粘贴又会拿到
 * `临时 01`，与盘上那张重名。故这里只做一件事——从**落盘的单调计数器**取号并把计数器一起推进。
 * @param {unknown} store
 * @param {number} [nowMs] 粘贴时刻（仅记录，不参与取号）
 * @returns {{ store: GroupStore, card: TempGroupDef }}
 */
export function allocateTempCard(store, nowMs) {
  const base = normalizeStore(store)
  const seq = base.nextSeq
  const card = {
    id: tempCardIdOf(seq),
    name: tempLabelOf(seq),
    seq,
    createdAtMs: Number.isFinite(nowMs) ? Math.round(Number(nowMs)) : 0,
  }
  return { store: { ...base, nextSeq: seq + 1, temps: [...base.temps, card] }, card }
}

/**
 * 第一层裁决：创建顺序最早、且接受该扩展名的那张自定义组卡（**先建先得**）。
 *
 * 判据是 `store.groups` 的次序，而那个次序由 normalizeStore 按 (seq, id) 排定——所以
 * 「先建先得」是**创建序号**的函数，不是数组下标的函数（把数组顺序打乱，改判不会发生）。
 * @param {unknown} store
 * @param {string} ext 分组键（小写含点；无扩展名为空串）
 * @returns {CustomGroupDef | null}
 */
export function acceptingCustomOf(store, ext) {
  for (const group of normalizeStore(store).groups) {
    if (group.acceptAll) return group
    if (group.exts.indexOf(ext) >= 0) return group
  }
  return null
}

/**
 * @typedef {{ tier: string, id: string, label: string, key?: string }} OwnerVerdict
 */

/**
 * 三层归属判定：给一个扩展名，问它归哪张卡。
 *
 * 第二层（临时组卡）在这里**显式缺席**——它不参与自动路由，这是它的定义，不是本票没查。
 * 于是「被自定义卡领走的扩展名不再生成固有卡」不是一条额外的过滤，而是同一个 switch 的两个
 * 互斥分支：走了 custom 就走不到 builtin。
 * @param {string} ext
 * @param {unknown} store
 * @returns {OwnerVerdict}
 */
export function resolveOwner(ext, store) {
  const custom = acceptingCustomOf(store, ext)
  if (custom) return { tier: TIER_CUSTOM, id: custom.id, label: custom.name }
  return { tier: TIER_BUILTIN, id: '', label: groupLabelOf(ext), key: ext }
}

/**
 * @typedef {object} OwnedCard
 * @property {string} id 组卡 DOM id（**全表唯一**——渲染层扫热区对重复 id 不去重）
 * @property {string} label 卡面标签（自定义卡 = 用户起的名；固有卡 = 扩展名大写）
 * @property {string} tier 归属层（custom / temp / builtin）
 * @property {GroupableItem[]} items 卡内条目（保持入参序）
 */

/**
 * 桌面项 + 组定义 → 一整排卡（**归属的全部来源**）。
 *
 * 卡序：自定义卡按创建序在前，其后固有组按固定组序表、表外按字母序。两段各自有序，故加一张
 * 卡不会让既有卡乱跳。空组不占卡（自定义卡声明了类型但桌面上没有对应文件时不出卡）。
 * 临时卡本票不产卡：它还没有成员模型（成员来自粘贴，归工单186）。
 *
 * @param {readonly GroupableItem[]} items 桌面条目池（内核 state.items 形状）
 * @param {unknown} store 组定义
 * @param {readonly string[]} [order] 固有组序表
 * @returns {OwnedCard[]}
 */
export function buildCards(items, store, order = EXT_GROUP_ORDER) {
  const base = normalizeStore(store)
  /** @type {Map<string, GroupableItem[]>} 扩展名 → 条目 */
  const byExt = new Map()
  for (const item of items) {
    const key = groupKeyOf(item)
    if (key === null) continue // 快捷方式 / 网址 / 文件夹：进不了卡
    const bucket = byExt.get(key)
    if (bucket) bucket.push(item)
    else byExt.set(key, [item])
  }

  // 自定义卡的桶按创建序预置（空桶后面会被滤掉，故这里预置不影响「空组不占卡」）
  /** @type {Map<string, GroupableItem[]>} */
  const customBuckets = new Map()
  for (const group of base.groups) customBuckets.set(group.id, [])
  /** @type {GroupableItem[]} */
  const rest = []

  for (const ext of sortGroupKeys(byExt.keys(), order)) {
    const bucket = byExt.get(ext)
    const custom = acceptingCustomOf(base, ext)
    if (custom) {
      const target = customBuckets.get(custom.id)
      target.push(...bucket)
    } else {
      rest.push(...bucket)
    }
  }

  /** @type {OwnedCard[]} */
  const cards = []
  for (const group of base.groups) {
    const bucket = customBuckets.get(group.id)
    if (bucket && bucket.length) cards.push({ id: group.id, label: group.name, tier: TIER_CUSTOM, items: bucket })
  }
  for (const group of groupByExtension(rest, order)) {
    cards.push({ id: group.id, label: group.label, tier: TIER_BUILTIN, items: group.items })
  }

  // 全表唯一化：固有组的 id 由扩展名净化而来，理论上能撞上自定义卡的 dgc-c1（扩展名 '.c1'），
  // 而扫热区不去重 —— 故这里按最终次序统一兜一遍，与 grouping.js 内部那道闸同款。
  const used = new Set()
  for (const card of cards) {
    const baseId = card.id
    let id = baseId
    for (let n = 2; used.has(id); n += 1) id = `${baseId}-${n}`
    used.add(id)
    card.id = id
  }
  return cards
}

/**
 * @typedef {{ ext: string, label: string }} PresentExtension
 */

/**
 * 桌面上**此刻真实存在**的扩展名清单（勾选浮层逐个勾的就是它）。
 *
 * 不存在的类型不列——列了也没文件可放，用户不必为不存在的类型操心（spec166 用户故事 46）。
 * 排序与卡序同一份算式（sortGroupKeys），用户看到的次序与勾完之后卡片的排列对得上。
 * @param {readonly GroupableItem[]} items
 * @param {readonly string[]} [order]
 * @returns {PresentExtension[]}
 */
export function presentExtensionsOf(items, order = EXT_GROUP_ORDER) {
  const seen = new Set()
  for (const item of items) {
    const key = groupKeyOf(item)
    if (key !== null) seen.add(key)
  }
  return sortGroupKeys(seen, order).map((ext) => ({ ext, label: groupLabelOf(ext) }))
}
