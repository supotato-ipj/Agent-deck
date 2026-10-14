// card.js 的类型声明（工单181）。与 grouping.d.ts / interaction.d.ts 同一个理由：
// 投放型插件包的源码就是投放单元，入口只收 .js/.mjs，没有编译步骤；而本仓库 tsconfig 没开
// allowJs——TS 测试 import 这个 .js 时若没有同名 .d.ts，tsc 报 TS2307，`npm run typecheck` 即红。
//
// 这份声明顺带**自述了宿主面**：投放型插件跑在 deck-plugin:// 之下，够不着内核渲染层源码，
// 所以宿主形状按结构写在这里，而不是 import 内核的 PluginHost 类型——插件对宿主的依赖，
// 一眼就是这几个成员，没有别的。

/** 本插件插进文档头的样式元素的 id（换代前一代没清干净时按它扫） */
export declare const STYLE_ID: string

/** 组卡认识的桌面项：只要分组与画卡用得到的字段（内核 DesktopItem 结构上即可满足） */
export type HostDesktopItem = {
  name: string
  kind: string
  path: string
  iconKey: string
}

/** 按 manifest.capabilities 裁剪过的快照视图；本插件只声明 desktop，故只有这一段 */
export type HostView = {
  desktop?: { items: readonly HostDesktopItem[] }
}

/** 组卡用到的宿主面 */
export type Host = {
  /** 自己的容器（卡片挂在里面；卡片本身是 .card，故自动进热区扫掠） */
  el: HTMLElement
  view: HostView
  notify(type: string, payload?: Record<string, unknown>): void
  invoke(method: string, payload: Record<string, unknown>): Promise<unknown>
  /** 「我动了 DOM，请重扫热区」——插件侧唯一的热区重申报入口 */
  onDomChanged(): void
}

declare const plugin: {
  mount(host: Host): void
  update?(host: Host): void
  unmount?(): void
}

export default plugin
