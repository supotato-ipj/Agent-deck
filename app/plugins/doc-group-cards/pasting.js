// 粘贴路由与临时组卡的生成（工单186 = spec166 之⑨：三态路由 / 临时组卡 / 解散归档）。
//
// 与同目录 grouping.js / ownership.js / interaction.js / menu.js / writeops.js 同一条缝：
// **纯模块、零 DOM、零 Electron**，vitest 直测。card.js 在缝的另一侧发契约调用、画卡。
//
// **前提（票面原文）**：内核的粘贴契约 **无参**——`desktop/paste` 的 request 是 `null`，落点固定
// 用户桌面根（roots.user），插件**控制不了物理去向**。故「把文件放进组卡」只能是**分组归属**，
// 文件全程原地不动（ADR-0014：组卡是归属概念，不是目录）。
//
// **三态路由**（spec166「临时组卡的生成」）：
//   1. 粘进来的文件若有**自定义组卡**接受该扩展名 → 并入那张卡（先建先得，与自动路由同一裁决）；
//   2. 否则 → **新建一张临时组卡**，按粘贴时刻 + 序号命名，接受任意类型；
//   3. 用户**显式对某张卡**粘贴 → 粘进那张卡（该卡接受任意类型时；临时卡恒是）。
//
// **每次粘贴各生成一张**：临时卡一旦生成，名字就在组定义里占住，而自动路由**不再选中它**
// （ownership.buildCards 里临时层高于固有层，路由时压根不看 temps）——故第二张粘贴拿不到第一张，
// 一次粘贴 = 一张卡 = 一个可独立处理的批次。用户仍可对已有的临时卡显式再粘（第三态）。
//
// ### ⚠️ 本票点名要验的那条推导（本文件就是它的实现，不是它的注释）
// 固有扩展组是**兜底**：它接受一切扩展名，因此**永远存在**。于是——若临时卡的优先级**不高于**
// 固有分组，「没有任何卡接受这个类型」这个状态就永远不会发生，第二态也就永远不会触发，
// 临时卡**永远生成不出来**。所以三层优先级必须让临时卡排在固有组**之前**。
//
// 这条推导在这里是**可执行的**，不是一句话：`PASTE_TIER_PRIORITY` 是路由**依次征询的层序**，
// `routePaste` 沿它走、遇到第一层能收口就收口。把 builtin 排到 temp 之前，同一批输入就会在
// builtin 处收口、`kind` 变成 `'builtin'`、一张临时卡都不生成——单测里两条顺序各跑一遍即可看见。
//
// 另一侧（归属侧）的同一条推导在 `ownership.buildCards`：临时卡的成员在分桶前就被摘走，故
// 它们不进固有扩展组卡。本文件只管「贴到哪儿去」，那边只管「卡里装谁」，两处合起来才是一句话。

import { extOf } from './grouping.js'
import {
  TIER_BUILTIN,
  TIER_CUSTOM,
  TIER_TEMP,
  acceptsAnyTypeOf,
  acceptingCustomOf,
  allocateTempCard,
  appendToTempCard,
  normalizeStore,
} from './ownership.js'

/**
 * 粘贴路由的**层序**（自高而低）。这张表就是上面那条推导的实现：temp 排在 builtin 之前，
 * 临时卡才有机会在兜底层之前收口。改动这张表 = 改这条推导，故它是导出的常量而不是内联的数组。
 * @type {readonly string[]}
 */
export const PASTE_TIER_PRIORITY = Object.freeze([TIER_CUSTOM, TIER_TEMP, TIER_BUILTIN])

/** 粘贴落地的存证族（与内核的 desktop-* 族、另两层的 doc-group-cards-* 族都不混） */
export const PASTE_ROUTED_NOTIFY = 'doc-group-cards-paste-routed'
export const PASTE_FAILED_NOTIFY = 'doc-group-cards-paste-failed'

/**
 * 内核 `desktop/paste` 的响应 → 这一批**真正落地**的桌面文件名。
 *
 * 契约：`{ ok, pasted: 落盘最终名（含「x - 副本」后缀）, failed: 源基名, error? }`。只有
 * `pasted` 里的才算落地——`failed` 是源基名，不是桌面上的东西，把它记进归属等于凭空造一批
 * 不存在的成员（那一批文件压根没到桌面，自然不归任何卡）。
 * @param {unknown} response
 * @returns {string[]}
 */
export function pastedNamesOf(response) {
  const pasted = response && typeof response === 'object' ? /** @type {{ pasted?: unknown }} */ (response).pasted : null
  if (!Array.isArray(pasted)) return []
  const seen = new Set()
  /** @type {string[]} */
  const out = []
  for (const v of pasted) {
    if (typeof v !== 'string') continue
    const name = v.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

/**
 * 批内文件名归一：逐条 trim、去重（留第一次出现的次序）。空批次原样返回空数组。
 * @param {readonly unknown[]} names
 * @returns {string[]}
 */
function normBatch(names) {
  if (!Array.isArray(names)) return []
  return pastedNamesOf({ pasted: names })
}

/**
 * @typedef {object} PasteRoute
 * @property {'none' | 'into' | 'merge' | 'temp' | 'builtin'} kind 四种结果里的一个：
 *   - `into` 第三态：显式对某张接受任意类型的卡粘贴，全部粘进那张卡；
 *   - `merge` 第一态：全部并入自定义组卡（`mergeCardIds` 是命中的那些卡，先建先得）；
 *   - `temp` 第二态：至少有一个文件没有任何卡领走 → 本次**新建一张临时卡**承接那部分；
 *   - `builtin` **只在层序被改成 builtin 先于 temp 时才可能出现**（反面证据，见文件头）；
 *   - `none` 这一批一个文件都没落地（粘贴失败 / 全被内核拒了）。
 * @property {readonly string[]} mergeCardIds 并入的自定义组卡 id（`merge` 态非空；`temp` 态可有可无）
 * @property {readonly string[]} tempFiles 本次落进临时层的那几个文件名（新卡的那一批 / 追加的那几个）
 * @property {import('./ownership.js').TempGroupDef | null} tempCard 本次新建的临时卡（只有 `temp` 态非空）
 * @property {string} targetCardId 归属卡 id：`into`/`temp` 是那张卡，`merge` 是第一个命中的自定义卡
 * @property {import('./ownership.js').GroupStore} store 路由之后的状态（不变时是同一个引用）
 * @property {boolean} changed 组定义有没有变（false ⇒ 调用方**不需要**落盘）
 */

/**
 * 三态路由：给一次粘贴落地的文件名清单，问它们归谁。
 *
 * 纯函数，不改入参；`changed` 告诉调用方要不要落盘——第一态（全部并入自定义卡）**不落任何盘**，
 * 因为自定义卡的成员是定义的函数，粘进去的文件下一帧自然就在那张卡上。
 *
 * @param {unknown} store 组定义
 * @param {readonly string[]} names 这一批落地的文件名（内核 pasted 响应）
 * @param {{ nowMs?: number, intoCardId?: string, priority?: readonly string[] }} [options]
 *   `intoCardId` = 用户显式点的那张卡（组卡菜单带下来的 cardId；文件菜单与未点卡时为空串）；
 *   `priority` = 层序（缺省即 PASTE_TIER_PRIORITY；单测用它跑反面顺序）。
 * @returns {PasteRoute}
 */
export function routePaste(store, names, options = {}) {
  const base = normalizeStore(store)
  const batch = normBatch(names)
  const intoCardId = typeof options.intoCardId === 'string' ? options.intoCardId : ''
  const priority = Array.isArray(options.priority) && options.priority.length
    ? options.priority
    : PASTE_TIER_PRIORITY

  if (!batch.length) return idle(base)

  // 第三态先判：显式对卡粘贴是用户直接说了「粘这张」，它盖过自动路由的两态。
  // 只在目标卡**接受任意类型**时成立——临时卡恒是，「接受全部类型」的自定义卡按定义也是。
  // 有限清单的自定义卡不在其中：它的成员是定义的函数，粘一个它不接受的类型进去，那一帧根本
  // 不会显示（除非另设一份成员表 —— 那是与「归属不存盘」打架的第二套真相）。那一路退回自动路由。
  if (intoCardId && acceptsAnyTypeOf(base, intoCardId)) {
    const wide = base.groups.find((g) => g.id === intoCardId)
    if (wide) {
      // 接受全部类型的自定义卡：归属已是定义的函数，这批文件**已经在**那张卡上，不落任何盘
      return { ...idle(base), kind: 'into', targetCardId: wide.id, mergeCardIds: [wide.id] }
    }
    const appended = appendToTempCard(base, intoCardId, batch)
    return {
      kind: 'into',
      mergeCardIds: [],
      tempFiles: appended.added,
      tempCard: null,
      targetCardId: intoCardId,
      store: appended.store,
      // 按「真的加进去了几个」判，不按引用（base 与 appended.store 都是归一过的新对象，比引用必假）
      changed: appended.added.length > 0,
    }
  }

  // 一、二态：沿层序依次征询，第一个能收口的层收口。
  for (const tier of priority) {
    if (tier === TIER_CUSTOM) {
      const hits = batch.map((name) => acceptingCustomOf(base, extOf(name)))
      if (hits.every(Boolean)) return mergeRoute(base, batch, hits.map((h) => /** @type {string} */ (h.id)))
      continue // 有文件没被任何自定义卡领走 → 交给下一层
    }
    if (tier === TIER_TEMP) return tempRoute(base, batch, options.nowMs)
    if (tier === TIER_BUILTIN) {
      // 兜底收口：这一层接受一切，于是「没有卡接受」永不发生，临时卡永不生成。
      // 出厂层序走不到这里（temp 在它前面）；单测刻意把顺序倒过来即命中这一支。
      return { ...idle(base), kind: 'builtin', targetCardId: '' }
    }
  }
  return idle(base)
}

/** 什么都没变的一趟（`none` 态的四个字段全是空） */
function idle(store) {
  return { kind: /** @type {const} */ ('none'), mergeCardIds: [], tempFiles: [], tempCard: null, targetCardId: '', store, changed: false }
}

/** 第一态：整批并入自定义组卡。成员是定义的函数，故一个字节都不落盘 */
function mergeRoute(store, batch, ids) {
  const mergeCardIds = [...new Set(ids)]
  return {
    kind: /** @type {const} */ ('merge'),
    mergeCardIds,
    tempFiles: [],
    tempCard: null,
    targetCardId: mergeCardIds[0] ?? '',
    store,
    changed: false,
  }
}

/** 第二态：没被领走的那几个新建一张临时卡；被领走的那几个照旧并入（同一批里两种去向） */
function tempRoute(store, batch, nowMs) {
  const unaccepted = []
  /** @type {string[]} */
  const merged = []
  /** @type {string[]} */
  const mergeCardIds = []
  for (const name of batch) {
    const owner = acceptingCustomOf(store, extOf(name))
    if (owner) {
      merged.push(name)
      if (!mergeCardIds.includes(owner.id)) mergeCardIds.push(owner.id)
    } else {
      unaccepted.push(name)
    }
  }
  // 全批都被领走的情形在路由层序里走不到这里（custom 层会先收口），但守住不变量成本为零
  if (!unaccepted.length) return mergeRoute(store, batch, mergeCardIds)
  const alloc = allocateTempCard(store, nowMs, unaccepted)
  return {
    kind: /** @type {const} */ ('temp'),
    mergeCardIds,
    tempFiles: unaccepted,
    tempCard: alloc.card,
    targetCardId: alloc.card.id,
    store: alloc.store,
    changed: true,
  }
}

/**
 * 本票新增/复用的三层字面量在此转出，card.js 与单测都从这一个入口拿 */
export { TIER_BUILTIN, TIER_CUSTOM, TIER_TEMP }
