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
 * @property {string} name 卡面名（粘贴时刻 + 序号：`临时 10-15 21:04 01`）
 * @property {number} seq 序号（与自定义卡共用一个计数器）
 * @property {number} createdAtMs 粘贴时刻（工单186 按批次排序用；缺失落 0，不编一个当前时间）
 * @property {readonly string[]} names 这一批粘贴真正落地的**桌面文件名**（内核 desktop/paste 的
 *   `pasted` 响应：落盘最终名，含「x - 副本」后缀）。
 *
 *   **为什么临时卡非得存一份名单，而自定义卡不用**：自定义卡的成员是**定义**的函数（它接受哪些
 *   扩展名，桌面上就有哪些文件属于它），所以工单185 那句「归属不存盘、只由定义现推」成立；
 *   临时卡恰恰相反——它接受**任意**类型，「哪些文件属于它」这件事**无法**从扩展名推出来，它就是
 *   「一次粘贴」这个事实本身。故名单是这张卡**唯一**的成员表示，别的路一条也没有（不另设同步表、
 *   不靠到达次序、磁盘上更不需要任何记号）。文件本身**一个字节都不动**：名单记的是「归它」，
 *   不是「搬到哪儿去」。
 */
/**
 * @typedef {object} GroupStore
 * @property {number} version
 * @property {number} nextSeq 下一个序号（单调；读回时按盘上已用的序号抬齐）
 * @property {readonly CustomGroupDef[]} groups 自定义组卡（按 (seq, id) 有序 = 创建顺序）
 * @property {readonly TempGroupDef[]} temps 临时组卡（工单186：每次粘贴各一张，按创建序）
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

/** 文件名清单归一：逐条 trim、去重（留第一次出现的次序）。次序即批内次序，落盘形状稳定 */
function normNames(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const out = []
  for (const v of raw) {
    if (typeof v !== 'string') continue
    const n = v.trim()
    if (!n || seen.has(n)) continue
    seen.add(n)
    out.push(n)
  }
  return out
}

/**
 * 临时卡定义自愈（工单186 起带 names）：**成员名单是这张卡唯一的成员表示**，丢一个名字就等于
 * 那个文件回落固有组，故名单逐条清洗而不是整条丢弃（与自定义卡 exts 同一处置）。
 */
function normTempDef(raw) {
  if (!isPlainObject(raw)) return null
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  const seq = Number.isInteger(raw.seq) && raw.seq > 0 ? raw.seq : 0
  if (!id || !seq) return null
  const createdAtMs = Number.isFinite(raw.createdAtMs) ? Math.round(raw.createdAtMs) : 0
  const name = typeof raw.name === 'string' && raw.name.trim()
    ? raw.name.trim()
    : tempLabelOf(seq, pasteStampOf(createdAtMs) || null)
  return { id, name, seq, createdAtMs, names: normNames(raw.names) }
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

/** 两位补零（卡面宽度有限，序号一律两位；过 99 也不截断——那才是撞名） */
function pad2(n) {
  return String(n).padStart(2, '0')
}

/**
 * 粘贴时刻 → 卡面用的时间戳（`10-15 21:04`，**本地时刻**）。
 *
 * 卡面是人看的，粘在 21:04 的那一批就该写 21:04，故按本地时区折算（跨时区看自己的桌面，
 * UTC 读数是错的）。时刻缺失（0 / 非有限）返回空串——**不编一个当前时间**：编出来的时刻
 * 让「哪一批」从此没法复现。
 *
 * 唯一性由序号保证，不靠这段文本（时间戳里没有秒，两次粘贴完全可能落在同一分钟）。
 * @param {number} nowMs
 * @returns {string}
 */
export function pasteStampOf(nowMs) {
  const ms = Number(nowMs)
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const d = new Date(ms)
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/**
 * 临时卡面名：**粘贴时刻 + 序号**（工单186 AC「命名含粘贴时间与序号」）。
 *
 * 时刻丢失时退化成只带序号（`临时 03`）——工单185 交付时是这个名字，兜底路径保持原样，
 * 不因为本票改了命名就让它连兜底都换一副面孔。
 *
 * 工单185 交付时这里刻意只写序号（「序号即唯一性」）；本票按 AC 把时刻加进来，**序号仍在末尾**，
 * 那条「唯一性靠序号、不靠名字」的不变量一个字没动。
 * @param {number} seq
 * @param {string | null} [stamp] `MM-DD HH:mm`（由 pasteStampOf 出）；空/缺省则不写
 */
export function tempLabelOf(seq, stamp) {
  const s = typeof stamp === 'string' ? stamp.trim() : ''
  return s ? `临时 ${s} ${pad2(seq)}` : `临时 ${pad2(seq)}`
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
 * 建一张临时组卡。**纯函数**：返回新状态 + 新卡，不改入参。
 *
 * 工单185 只占位（取号 + 推进计数器），工单186 补上成员与命名：
 *   - `names` = 这一批粘贴真正落地的桌面文件名（内核 desktop/paste 的 `pasted` 响应）。文件
 *     **不移动**：内核的粘贴契约无参、落点固定用户桌面根，插件控制不了物理去向，故「存放」只能是
 *     分组归属，而归属对临时卡来说就是这份名单。
 *   - 卡面名 = 粘贴时刻 + 序号（序号取自**落盘的单调计数器**，跨重启不撞名见上）。
 * @param {unknown} store
 * @param {number} [nowMs] 粘贴时刻（写进 createdAtMs，并进卡面名）
 * @param {readonly string[]} [names] 这一批落地的文件名（缺省 = 空批次）
 * @returns {{ store: GroupStore, card: TempGroupDef }}
 */
export function allocateTempCard(store, nowMs, names) {
  const base = normalizeStore(store)
  const seq = base.nextSeq
  const at = Number.isFinite(nowMs) ? Math.round(Number(nowMs)) : 0
  const card = {
    id: tempCardIdOf(seq),
    name: tempLabelOf(seq, pasteStampOf(at) || null),
    seq,
    createdAtMs: at,
    names: normNames(names),
  }
  return { store: { ...base, nextSeq: seq + 1, temps: [...base.temps, card] }, card }
}

/**
 * 往一张已有的临时卡里再粘一批（用户对临时卡显式粘贴；它接受任意类型，故总是可粘）。
 *
 * 只加不重（同一批文件再点一次 PASTE 不产生第二份名单），返回新状态 + 本次真正新加进去的那几个。
 * @param {unknown} store
 * @param {string} cardId
 * @param {readonly string[]} names
 * @returns {{ store: GroupStore, card: TempGroupDef | null, added: readonly string[] }}
 */
export function appendToTempCard(store, cardId, names) {
  const base = normalizeStore(store)
  const card = base.temps.find((t) => t.id === cardId)
  if (!card) return { store: base, card: null, added: [] }
  const added = normNames(names).filter((n) => card.names.indexOf(n) < 0)
  if (!added.length) return { store: base, card, added: [] }
  const next = { ...card, names: [...card.names, ...added] }
  return {
    store: { ...base, temps: base.temps.map((t) => (t.id === cardId ? next : t)) },
    card: next,
    added,
  }
}

/**
 * 解散一张组卡（工单186）：**只删掉这张卡的定义**，卡内文件按扩展名回落固有分组。
 *
 * **磁盘文件零移动**——这不是一句承诺，是这份返回值的形状事实：它只带 `store`（插件私有状态里
 * 的定义）与被删掉的那条定义本身，**不带任何路径、不带任何文件操作**。组卡是归属概念不是目录
 * （ADR-0014），删掉归属即可，文件仍在用户桌面根原地不动。
 *
 * **nextSeq 一个字都不动**：序号只增不减是「跨重启不撞名」那条不变量的全部依托——解散一张卡
 * 若把号退回去，重启后新粘贴的那张就会与盘上某张重名。退号省下的那个号换不来任何东西。
 *
 * 固有扩展组卡**没有定义可删**（它是规则算出来的），故传它的 id 原样返回，dissolved 为 null——
 * 菜单那一侧用 visibleWhen 挡掉，这一层只是把「拦不住也不会出错」钉住。
 * @param {unknown} store
 * @param {string} cardId
 * @returns {{ store: GroupStore, dissolved: CustomGroupDef | TempGroupDef | null, kind: string }}
 */
export function dissolveGroup(store, cardId) {
  const base = normalizeStore(store)
  const temp = base.temps.find((t) => t.id === cardId) ?? null
  const group = base.groups.find((g) => g.id === cardId) ?? null
  if (!temp && !group) return { store: base, dissolved: null, kind: '' }
  return {
    store: {
      ...base,
      groups: base.groups.filter((g) => g.id !== cardId),
      temps: base.temps.filter((t) => t.id !== cardId),
    },
    dissolved: temp ?? group,
    kind: temp ? TIER_TEMP : TIER_CUSTOM,
  }
}

/**
 * 这张卡**接受任意类型**吗（显式对卡粘贴能不能把它粘进去）。
 *
 * 归宿两类：临时组卡（按定义接受一切）与「接受全部类型」开关打开的自定义卡。
 * 有限扩展名清单的自定义卡**不在其中**——它的成员是定义的函数，粘一个它不接受的类型进去，
 * 除非另设一份成员表（那是与「归属不存盘」打架的第二套真相），否则它在下一帧根本不会显示。
 * 故那一路退回自动路由：新卡或并入，绝不假装粘进了那张卡。
 * @param {unknown} store
 * @param {string} cardId
 * @returns {boolean}
 */
export function acceptsAnyTypeOf(store, cardId) {
  const base = normalizeStore(store)
  if (base.temps.some((t) => t.id === cardId)) return true
  const group = base.groups.find((g) => g.id === cardId)
  return Boolean(group && group.acceptAll)
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
 * 卡序：自定义卡（创建序）→ 临时卡（创建序）→ 固有组（固定组序表、表外字母序）。三段各自有序，
 * 故加一张卡不会让既有卡乱跳。
 *
 * **「空组不占卡」只对固有扩展组卡成立（工单187 裁决①）**：一条被全部文件领走而空掉的固有组
 * 不出卡，那条纪律是为「规则生成、桌面上此刻没文件的类型不糊屏」而设的（spec166 用户故事 #7）。
 * 自定义卡是用户建的持久对象，空卡**照样出卡（0 格）**，理由见下面 push 自定义卡那一段的注释。
 *
 * **三层优先级在这里是结构，不是注释**（工单186 票面点名要验的那条推导）：
 * 临时卡的成员（`names` 里那批粘贴落地的文件名）在**分桶之前**就被摘走，故
 *   - 它们**不进**固有扩展组卡 —— 这就是「临时层高于固有层」；
 *   - 它们也**不进**任何自定义组卡 —— 已进临时卡的那一批是一个可独立处理的整体，不该被后来
 *     的一次 EDIT TYPES 拆散（否则同一文件出现在两张卡里，违反「同一批文件只在一张卡里」）。
 *     已登记的代价：要改这批文件的归属，先解散临时卡。
 * 若把这一句摘掉（即让临时层排在固有层之下），上两件事同时不成立——而那正是票面要求验的
 * 反面：那样「没有卡接受」这个状态永远不会出现，临时卡也就永远生成不出来。
 *
 * @param {readonly GroupableItem[]} items 桌面条目池（内核 state.items 形状）
 * @param {unknown} store 组定义
 * @param {readonly string[]} [order] 固有组序表
 * @returns {OwnedCard[]}
 */
export function buildCards(items, store, order = EXT_GROUP_ORDER) {
  const base = normalizeStore(store)
  /** 临时层的硬认领：文件名 → 归属那张临时卡（这张表是三层优先级在代码里的唯一体现） */
  const tempOfName = new Map()
  for (const card of base.temps) for (const name of card.names) if (!tempOfName.has(name)) tempOfName.set(name, card.id)

  /** @type {Map<string, GroupableItem[]>} 扩展名 → 条目（**临时层摘走的不进来**） */
  const byExt = new Map()
  /** @type {Map<string, GroupableItem[]>} 临时卡 id → 条目（按快照序，成员取的是同一个条目对象） */
  const tempBuckets = new Map()
  for (const card of base.temps) tempBuckets.set(card.id, [])
  for (const item of items) {
    const tempId = tempOfName.get(item.name)
    if (tempId !== undefined) {
      tempBuckets.get(tempId).push(item)
      continue
    }
    const key = groupKeyOf(item)
    if (key === null) continue // 快捷方式 / 网址 / 文件夹：进不了卡
    const bucket = byExt.get(key)
    if (bucket) bucket.push(item)
    else byExt.set(key, [item])
  }

  // 自定义卡的桶按创建序预置（工单187 裁决①起，**空桶也出卡**，故这里预置会直接变成一张 0 格卡）
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
    // 工单187 裁决①：空的自定义卡**照样出卡（0 格）**，只把自定义层这一行去掉「必须非空」的条件。
    // 它是用户亲手建的持久对象：定义还在插件私有状态里存着，面板重启后还会回来——可它一空就退场，
    // 屏上就再没有 EDIT TYPES（勾回类型）与 DISSOLVE（解散）这两条出路，用户界面上**不可恢复**
    // （造一张什么类型都没勾的卡、或在 EDIT TYPES 里把勾全取消，皆可走到这一步）。
    // 固有组那一条「空组不占卡」一个字没动：它是规则生成的卡，出不出卡由桌面上的文件决定。
    if (bucket) cards.push({ id: group.id, label: group.name, tier: TIER_CUSTOM, items: bucket })
  }
  for (const card of base.temps) {
    const bucket = tempBuckets.get(card.id)
    if (bucket && bucket.length) cards.push({ id: card.id, label: card.name, tier: TIER_TEMP, items: bucket })
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
