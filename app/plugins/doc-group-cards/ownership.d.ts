// ownership.js 的类型声明（工单185）。与 grouping.d.ts / menu.d.ts / writeops.d.ts 同一个理由：
// 投放型插件包的源码就是投放单元，入口只收 .js/.mjs，没有编译步骤；而本仓库 tsconfig 没开
// allowJs——TS 测试 import 这个 .js 时若没有同名 .d.ts，tsc 报 TS2307，`npm run typecheck` 即红。
//
// 声明与实现一一对应；改 ownership.js 的签名时同步改这里（typecheck 与 vitest 各自拦一道）。
// 本文件顺带就是**组定义那份持久化数据的形状说明书**：GLOSSARY 与 ADR-0014 引的就是它。

import type { GroupableItem } from './grouping'

/** 自定义组卡的定义（工单185：用户自建、可起名、声明接受哪些类型） */
export type CustomGroupDef = {
  /** 组卡 DOM id（`dgc-c<seq>`）；渲染层扫热区对重复 id 不去重，故必须全表唯一 */
  id: string
  /** 用户起的名（卡面标签就是它，不是扩展名大写） */
  name: string
  /** 接受的扩展名（小写含点；空串 = 无扩展名那一组） */
  exts: string[]
  /** 「接受全部类型」开关：为真时 exts 不作准，命中一切扩展名 */
  acceptAll: boolean
  /** 创建序号：先建先得的唯一依据（与数组下标无关） */
  seq: number
}

/** 临时组卡的定义（本票只占位并落盘序号；生成规则与成员模型归工单186） */
export type TempGroupDef = {
  id: string
  /** 卡面名（只带序号，如 `临时 01`） */
  name: string
  seq: number
  /** 粘贴时刻（工单186 按批次排序用；缺失落 0） */
  createdAtMs: number
}

/** 组定义整份状态（落在 plugin-config 的 STORE_KEY 一个键里，一次写 = 一次原子写） */
export type GroupStore = {
  version: number
  /** 下一个序号（单调；读回时按盘上已用的序号抬齐，故计数器丢失也不撞名） */
  nextSeq: number
  /** 自定义组卡，按 (seq, id) 有序 = 创建顺序 */
  groups: CustomGroupDef[]
  temps: TempGroupDef[]
}

/** 三层归属的层名 */
export declare const TIER_CUSTOM: string
export declare const TIER_TEMP: string
export declare const TIER_BUILTIN: string

/** 组定义在 plugin-config 里的键名 */
export declare const STORE_KEY: string
export declare const STORE_VERSION: number

/** 三层归属的判定结果 */
export type OwnerVerdict = {
  /** custom / temp / builtin */
  tier: string
  /** 命中自定义卡时是它的 id；固有组留空串（id 由 buildCards 统一分配） */
  id: string
  label: string
  /** 仅固有组带：分组键本身 */
  key?: string
}

/** 一张成型的卡（归属渲染层的唯一输入） */
export type OwnedCard = {
  id: string
  label: string
  tier: string
  items: GroupableItem[]
}

/** 勾选浮层里的一行（桌面上此刻真实存在的扩展名） */
export type PresentExtension = { ext: string; label: string }

export declare function emptyStore(): GroupStore

/** 任意来路 → 可用状态（归一 + 排序 + 去重 + 计数器按盘上已用序号抬齐） */
export declare function normalizeStore(raw: unknown): GroupStore

/** 从 plugin-config 响应 `{ config, warnings }` 里取出组定义（取不到给空状态，不抛） */
export declare function storeOf(response: unknown): GroupStore

export declare function customCardIdOf(seq: number): string
export declare function tempCardIdOf(seq: number): string
export declare function tempLabelOf(seq: number): string

/** 建一张自定义组卡（纯函数；序号取自落盘的单调计数器） */
export declare function addCustomGroup(
  store: unknown,
  draft: { name?: unknown; exts?: unknown; acceptAll?: unknown },
): { store: GroupStore; group: CustomGroupDef }

/** EDIT TYPES 的落库动作：只改定义，不动文件也不记「文件 → 卡」的表 */
export declare function editCustomGroupTypes(
  store: unknown,
  id: string,
  types: { exts?: unknown; acceptAll?: unknown },
): GroupStore

/** 占一张临时组卡的序号（纯占位；生成规则归工单186） */
export declare function allocateTempCard(
  store: unknown,
  nowMs?: number,
): { store: GroupStore; card: TempGroupDef }

/** 第一层裁决：创建顺序最早、且接受该扩展名的那张自定义卡（先建先得） */
export declare function acceptingCustomOf(store: unknown, ext: string): CustomGroupDef | null

/** 三层归属判定（临时层显式不参与自动路由） */
export declare function resolveOwner(ext: string, store: unknown): OwnerVerdict

/** 桌面项 + 组定义 → 一整排卡（归属的全部来源；空组不占卡、id 全表唯一） */
export declare function buildCards(
  items: readonly GroupableItem[],
  store: unknown,
  order?: readonly string[],
): OwnedCard[]

/** 桌面上此刻真实存在的扩展名清单（勾选浮层逐个勾的就是它；不存在的类型不列） */
export declare function presentExtensionsOf(
  items: readonly GroupableItem[],
  order?: readonly string[],
): PresentExtension[]
