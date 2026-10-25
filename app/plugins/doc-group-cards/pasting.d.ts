// pasting.js 的类型声明（工单186）。与 grouping.d.ts / ownership.d.ts / menu.d.ts / writeops.d.ts
// 同一个理由：投放型插件包的源码就是投放单元，入口只收 .js/.mjs，没有编译步骤；而本仓库 tsconfig
// 没开 allowJs——TS 测试 import 这个 .js 时若没有同名 .d.ts，tsc 报 TS2307，`npm run typecheck` 即红。

import type { GroupStore, OwnerVerdict, TempGroupDef } from './ownership'

/** 粘贴路由依次征询的层序（temp 必须排在 builtin 之前——票面点名要验的那条推导） */
export declare const PASTE_TIER_PRIORITY: readonly string[]

/** 粘贴落地的存证族 */
export declare const PASTE_ROUTED_NOTIFY: string
export declare const PASTE_FAILED_NOTIFY: string

/** 路由结果：none 没落地 / into 显式粘进那张卡 / merge 并入自定义卡 / temp 新建临时卡 /
 *  builtin 只在层序被改成 builtin 先于 temp 时才可能出现（反面证据） */
export type PasteRouteKind = 'none' | 'into' | 'merge' | 'temp' | 'builtin'

export type PasteRoute = {
  kind: PasteRouteKind
  /** 并入的自定义组卡 id（merge 态非空；temp 态可有可无） */
  mergeCardIds: string[]
  /** 本次落进临时层的那几个文件名 */
  tempFiles: string[]
  /** 本次新建的临时卡（只有 temp 态非空） */
  tempCard: TempGroupDef | null
  /** 归属卡 id：into/temp 是那张卡，merge 是第一个命中的自定义卡 */
  targetCardId: string
  store: GroupStore
  /** 组定义有没有变（false ⇒ 调用方不需要落盘） */
  changed: boolean
}

/** 内核 desktop/paste 的响应 → 这一批真正落地的桌面文件名（只取 pasted，failed 不是桌面上的东西） */
export declare function pastedNamesOf(response: unknown): string[]

/** 三态路由（纯函数；priority 可注入以便单测跑反面层序） */
export declare function routePaste(
  store: unknown,
  names: readonly string[],
  options?: { nowMs?: number; intoCardId?: string; priority?: readonly string[] },
): PasteRoute

export { TIER_BUILTIN, TIER_CUSTOM, TIER_TEMP }
export type { GroupStore, OwnerVerdict, TempGroupDef }
