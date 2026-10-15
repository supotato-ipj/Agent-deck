// 自绘菜单外壳的纯逻辑（工单182 = spec166 之⑤：全屏热区接管与只读五项）。
//
// 与同目录 grouping.js / interaction.js / geometry.js 同一条缝：**纯模块、零 DOM、零 Electron**，
// vitest 直测。投放型插件包的源码就是投放单元（面板经 deck-plugin:// 原样 import，无编译步骤），
// 而「菜单开合怎么迁移」「哪一行在当前选区下可不可用」「菜单摆在哪不出屏」这三类裁决必须离开
// DOM 才能被测——它们也是最容易在演进中各自漂移的三类数字。故各自只有这一处出处，card.js 一个数
// 都不许另写。
//
// **本模块不依赖任何其他插件。** 内置的上下文菜单插件（cards/context-menu，本机停用、用户可随时
// 关掉）另有一份自己的外壳实现，但它不在本插件目录内、也不在任何声明契约里（PluginHost /
// global.d.ts / BridgeMethods 都没有 `window.deck.ctxMenu`），依赖它等于交付一个开箱即坏的功能。
// 故这里是本插件自绘的外壳：形状与之相近是同一条纪律的必然结果（都是纯归约器 + 效果数组），
// 但实现、状态与生命周期各归各的。
//
// 行清单是**数据驱动**的（行描述符 + 逐行可用性裁决），不是一段写死的 DOM 顺序：
//   - 工单183 已往里加 RENAME / DELETE（写动作，各配一块自绘 UX：删除确认层 / 内联重命名编辑器，
//     见 writeops.js）；
//   - 工单184 上多选后，needs:'single' 的行（打开所在位置、以及届时新增的重命名）自然被置灰；
//   - 工单185 加组卡菜单的 NEW GROUP / EDIT TYPES（各配 visibleWhen：固有扩展组卡不出这两行）；
//   - 工单186 再加 PASTE（needs:'pasteable'，恒可见——任何一张卡都能接粘贴）与 DISSOLVE
//     （visibleWhen 同款：固有扩展组卡没有定义可删，故不出这一行）。
// 四张票都只往这张表里加行或改裁决函数，本文件与 card.js 的接缝不用动。

/** 菜单宽度（像素）。定死它，钳制的算式才与画出来的盒子同源 */
export const MENU_W = 176
/** 单行高（像素） */
export const MENU_ROW_H = 26
/** 菜单上下内边距（像素）：面板高度 = 行数 × 行高 + 2 × 本值 */
export const MENU_PAD_Y = 6
/** 出屏钳制的边距（像素）：菜单离视口边缘至少留这么多 */
export const MENU_EDGE = 8

/** 全屏遮罩的 id：它同时是 class='card'，故热区扫掠认得（热区身份靠 id，不去重，取唯一） */
export const OVERLAY_ID = 'dgc-overlay'
/** 遮罩根类名：菜单样式表的作用域根（与 #181 的教训同源——不能挂在样式元素自己的 id 上） */
export const OVERLAY_CLASS = 'dgc-overlay'
/** 菜单面板的 id */
export const PANEL_ID = 'dgc-menu'
/** 菜单面板根类名 */
export const PANEL_CLASS = 'dgc-menu'
/** 菜单行类名 */
export const ROW_CLASS = 'dgc-menu-row'
/** 置灰行类名（真菜单同款：点了没反应，菜单也不收） */
export const DISABLED_CLASS = 'dgc-menu-disabled'
/** 菜单样式元素的 id（与菜单同寿：开层才插，关层即摘） */
export const MENU_STYLE_ID = 'dgc-menu-style'
/**
 * 键盘档名（宿主按插件 id 加命名空间后进键盘模式单通道归一仲裁）。
 * 持拿它即让窗口可聚焦——Esc 才送得到本插件的 keydown 监听（宿主/契约里没有任何「聚焦某个元素」的 API）。
 */
export const KEYBOARD_TIER = 'menu'

/** 开层/收层存证族。刻意**不叫** `desktop-menu-*`：那是内核上下文菜单插件的存证族，
 *  冒充它会让验收电池把两处菜单的证据混为一谈。本插件一律 `doc-group-cards-menu-*`。 */
export const MENU_OPENED_NOTIFY = 'doc-group-cards-menu-opened'
export const MENU_CLOSED_NOTIFY = 'doc-group-cards-menu-closed'
export const MENU_ACTION_NOTIFY = 'doc-group-cards-menu-action'

/**
 * 菜单自带样式（几何数值全部从上面的常量插值进来，与 menuSizeOf/clampMenuBox 同源；
 * 面板的 width/height 由 JS 按 menuSizeOf 写内联样式——热区取的是 getBoundingClientRect()，
 * CSS 与 JS 各写一份尺寸，两份打架时用户看到的是错的）。
 */
export const MENU_CSS = `
.${OVERLAY_CLASS} { cursor: default; }
.${PANEL_CLASS} {
  position: absolute;
  box-sizing: border-box;
  padding: ${MENU_PAD_Y}px 0;
  background: rgba(20, 20, 22, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 10px;
  font-family: Consolas, "Courier New", monospace;
  overflow: hidden;
}
.${ROW_CLASS} {
  height: ${MENU_ROW_H}px;
  line-height: ${MENU_ROW_H}px;
  padding: 0 14px;
  font-size: 11px;
  letter-spacing: 0.08em;
  color: #e6e6e6;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  user-select: none;
}
.${ROW_CLASS}:hover { background: rgba(120, 180, 255, 0.22); color: #fff; }
.${ROW_CLASS}.${DISABLED_CLASS} { color: #6b7075; cursor: default; }
.${ROW_CLASS}.${DISABLED_CLASS}:hover { background: transparent; color: #6b7075; }
`

// ---------------------------------------------------------------------------
// 行清单：数据驱动（工单183/184/185 的接缝都在这张表上）
// ---------------------------------------------------------------------------

/**
 * 一行需要什么才可用（**选区口径**的三个档）。
 * - `any`：有无选中都可用（打开 / 复制路径 / 复制 / 剪切 / 删除）。工单184 上多选后仍是 any——
 *   内核的 desktop/copy-paths、clipboard-copy、clipboard-cut、trash 都是整批语义，多选天然支持。
 * - `single`：**恰一个**选中才可用（打开所在位置；重命名）。工单184 落地前这里是
 *   `n === 0 || n === 1`（工单原文口径「无选中时全部可用」——那时只有单选，菜单是从一个文件上
 *   右键弹出来的，无选中态根本到不了这里）；**工单184 已收紧成 `n === 1`**：多选下这两行必须
 *   置灰，因为 desktop/reveal 是按 path 单个定位、desktop/rename 是按名一对一改，多选天然无解。
 * - `pasteable`：剪贴板里真有可贴内容才可用（PASTE 行接这一档；读的是
 *   desktop/clipboard-state 的实况，查不到即置灰，不误使能）。
 */
export const NEED_ANY = 'any'
export const NEED_SINGLE = 'single'
export const NEED_PASTEABLE = 'pasteable'

/**
 * 文件菜单（单选）——工单182 的只读五项 + 工单183 的两个写动作。顺序即显示顺序，
 * 追加在末尾（spec166「菜单（自绘外壳）」：OPEN / OPEN LOCATION / COPY PATH / COPY / CUT /
 * RENAME / DELETE；破坏性的 DELETE 收尾，与真菜单同款）。
 *
 * 两个写动作的 needs 口径**故意不同**，理由是内核两个契约的批量语义不同：
 *   - RENAME 走 `single`：`desktop/rename` 是**按名**一对一改的（护栏也是 name-keyed），
 *     多选下天然无解，故工单184 上多选时它自然被置灰（#182 留在本文件里的接缝说明即指这一行）。
 *   - DELETE 走 `any`：`desktop/trash {paths}` 是整批语义且**全有全无**（扫描池护栏先于任何
 *     一件生效），内核自己的 Del 在多选时也是弹确认层整批送回收站。故工单184 上多选时它
 *     仍然可用——现在只有单选，needs 的差别只在多选那一张票上显形。
 *
 * 动作回调**不进状态**（状态只存数据），由 card.js 旁路持有：`run` 一律经内核既有桥接契约调用。
 * @type {{ id: string, label: string, needs?: string, visibleWhen?: (ctx: object) => boolean }[]}
 */
export const FILE_MENU_ROWS = [
  { id: 'open', label: 'OPEN', needs: NEED_ANY },
  { id: 'open-location', label: 'OPEN LOCATION', needs: NEED_SINGLE },
  { id: 'copy-path', label: 'COPY PATH', needs: NEED_ANY },
  { id: 'copy', label: 'COPY', needs: NEED_ANY },
  { id: 'cut', label: 'CUT', needs: NEED_ANY },
  { id: 'rename', label: 'RENAME', needs: NEED_SINGLE },
  { id: 'delete', label: 'DELETE', needs: NEED_ANY },
]

/**
 * 卡片身份（组卡菜单的上下文里带着它；工单185 起）。
 * 与 ownership.js 的三层同名同字面量——「这是不是自定义卡」是三层归属的一部分，
 * 不该在菜单这边另写一份判定。
 * @typedef {'custom' | 'temp' | 'builtin' | ''} CardKind
 */
export const KIND_CUSTOM = 'custom'
export const KIND_TEMP = 'temp'
export const KIND_BUILTIN = 'builtin'

/**
 * 这张卡**手改得动**吗（固有扩展组卡是规则生成的，不该被手改）。
 *
 * 归宿两层：自定义组卡与临时组卡。内置的 builtin 卡不在其中——它的内容由扩展名规则算出来，
 * 勾选/改名对它没有意义，出了那两行只会是一个点了没用的入口。
 * @param {CardKind | undefined} kind
 * @returns {boolean}
 */
export function isHandEditableKind(kind) {
  return kind === KIND_CUSTOM || kind === KIND_TEMP
}

/**
 * 组卡菜单（卡片**空白处**右键；与文件菜单同一副壳、同一套裁决）——PASTE / NEW GROUP / EDIT TYPES / DISSOLVE。
 *
 * 行序即 spec166「菜单（自绘外壳）」写的次序：PASTE / NEW GROUP / EDIT TYPES / DISSOLVE
 * （破坏性的 DISSOLVE 收尾，与文件菜单里 DELETE 收尾同款）。
 *
 * **PASTE 恒可见**（任何一张卡都能接粘贴），可用性走 `needs:'pasteable'`——读的是
 * `desktop/clipboard-state` 的实况，查不到即置灰，绝不误使能。它是本票（#186）加进来的第一行。
 *
 * 另外三行都带 `visibleWhen: 归宿自定义卡或临时卡`：**固有扩展组卡不出这三行**（规则生成的卡
 * 不该被手改，DISSOLVE 更是无从谈起——它压根没有定义可删）。行可见性只有 rowVisibleOf 这一个
 * 出口，渲染端不判。
 *
 * **工单185 登记过的那个后果，本票改变了一半，如实更新**：#185 交付时这张表对固有扩展组卡
 * 零可见行，于是右键卡片空白**不出菜单**、用户**建不出第一张自定义卡**（#185 按票面实现，并把
 * 修法留成「删掉 NEW GROUP 那一行的 visibleWhen」一行）。本票加的 PASTE 行**恒可见**，于是
 * 固有卡上右键**会出菜单了，只是菜单里只有 PASTE 一行**——NEW GROUP 仍在（票面 AC 与 spec166
 * 那一节对不上，本票不改 #185 的裁决）。副作用是那条路反而通了：第一次粘贴生成的临时卡是
 * 手改得动的卡，用户从它上面就能 NEW GROUP / EDIT TYPES 了。
 *
 * 可见性挂在卡片身份上而不挂在选区上：组卡菜单的选区恒为空（菜单是从卡片空白处开出来的，
 * 不是一个文件），故判据只能是 ctx.cardKind。
 *
 * @type {{ id: string, label: string, needs?: string, visibleWhen?: (ctx: object) => boolean }[]}
 */
export const GROUP_CARD_MENU_ROWS = [
  { id: 'paste', label: 'PASTE', needs: NEED_PASTEABLE },
  { id: 'new-group', label: 'NEW GROUP', visibleWhen: (ctx) => isHandEditableKind(ctx.cardKind) },
  { id: 'edit-types', label: 'EDIT TYPES', visibleWhen: (ctx) => isHandEditableKind(ctx.cardKind) },
  { id: 'dissolve', label: 'DISSOLVE', visibleWhen: (ctx) => isHandEditableKind(ctx.cardKind) },
]

/**
 * 当前上下文：菜单作用于哪个选区（绝对路径数组）+ 剪贴板实况 + 菜单是**从哪儿**开出来的。
 * @typedef {object} MenuCtx
 * @property {readonly string[]} paths 当前选区（工单182 只有单选：一个路径）
 * @property {boolean} [pasteable] 剪贴板可贴实况（needs:'pasteable' 的行读它）
 * @property {string} [cardId] 触发本次开层的卡片 id（组卡菜单用；文件菜单为空串）。
 *   工单185 起两行的可见性按它判「这是不是手改得动的卡」（落在 ctx 里而不是藏在 card.js 的
 *   闭包里，是为了让 visibleWhen 成为唯一的可见性裁决出口——渲染端不判）。
 * @property {CardKind} [cardKind] 那张卡的归属层（custom / temp / builtin；文件菜单为空串）。
 */

/**
 * 一行在当前上下文下可不可用（**唯一的置灰裁决出口**）。
 * @param {{ id?: string, needs?: string }} spec
 * @param {MenuCtx} ctx
 * @returns {boolean}
 */
export function rowEnabledOf(spec, ctx) {
  const n = ctx.paths.length
  switch (spec.needs) {
    // **恰一个**选中才可用（工单184 收紧）：多选下 OPEN LOCATION 与 RENAME 置灰。
    // 无选中时同样置灰——这两行到那时本就无事可做，置灰比误使能诚实。
    case NEED_SINGLE:
      return n === 1
    // 查不到实况即置灰，绝不误使能（与内核「粘贴按剪贴板实况置灰」同纪律）
    case NEED_PASTEABLE:
      return ctx.pasteable === true
    default:
      return true
  }
}

/**
 * 一行在当前上下文下该不该出现（**唯一的可见性裁决出口**）。
 * 本票五项恒可见；工单185 的组卡菜单里某些行按上下文隐藏时，只在此处加条件，渲染端不判。
 * @param {{ visibleWhen?: (ctx: MenuCtx) => boolean }} spec
 * @param {MenuCtx} ctx
 * @returns {boolean}
 */
export function rowVisibleOf(spec, ctx) {
  return typeof spec.visibleWhen === 'function' ? spec.visibleWhen(ctx) !== false : true
}

/**
 * 行描述符 + 上下文 → 渲染端要画的那张表（可见 ∧ 带可用性）。
 * @param {readonly { id: string, label: string, needs?: string, visibleWhen?: (ctx: MenuCtx) => boolean }[]} specs
 * @param {MenuCtx} ctx
 * @returns {{ id: string, label: string, enabled: boolean }[]}
 */
export function resolveMenuRows(specs, ctx) {
  const out = []
  for (const spec of specs) {
    if (!rowVisibleOf(spec, ctx)) continue
    out.push({ id: spec.id, label: spec.label, enabled: rowEnabledOf(spec, ctx) })
  }
  return out
}

// ---------------------------------------------------------------------------
// 几何：尺寸与出屏钳制（唯一出处；card.js 只把算出的数写进 DOM）
// ---------------------------------------------------------------------------

/**
 * 菜单盒尺寸。高度 = 行数 × 行高 + 上下内边距——与 MENU_CSS 里插值进去的同两个常量同源。
 * @param {readonly unknown[]} rows
 * @param {number} [count] 不给行数组时直接给行数
 * @returns {{ width: number, height: number }}
 */
export function menuSizeOf(rows, count) {
  const n = count === undefined ? (rows ? rows.length : 0) : count
  return { width: MENU_W, height: Math.max(0, n) * MENU_ROW_H + 2 * MENU_PAD_Y }
}

/**
 * 光标原点钳制：右/下越界按 MENU_EDGE 收回；视口装不下菜单时钳到边距下限（绝不给负坐标）。
 *
 * 规则：**菜单的左上角必须落在视口内，且尽可能贴近光标**。菜单比视口还大的极端情形下
 * 右边/下边仍会超出——这是唯一无法两全的情形，取「贴边且不出负坐标」而不是把菜单缩变形。
 * @param {{ x: number, y: number }} anchor 光标（视口坐标）
 * @param {{ width: number, height: number }} size
 * @param {{ width: number, height: number }} viewport
 * @param {number} [edge]
 * @returns {{ left: number, top: number, width: number, height: number }}
 */
export function clampMenuBox(anchor, size, viewport, edge = MENU_EDGE) {
  const clamp = (v, max) => {
    const lo = edge
    const hi = Number.isFinite(max) ? Math.max(lo, max) : lo
    return Math.min(Math.max(Number.isFinite(v) ? v : lo, lo), hi)
  }
  return {
    left: clamp(anchor.x, viewport.width - size.width - edge),
    top: clamp(anchor.y, viewport.height - size.height - edge),
    width: size.width,
    height: size.height,
  }
}

// ---------------------------------------------------------------------------
// 壳的转移矩阵：状态 + 一个事件一次合成，效果数组按序执行
//
// 形状与内核那份外壳相近（同一条纪律的必然结果），但**不共享任何一行代码**：本文件不 import
// 任何别的插件/内核模块，故内核上下文菜单插件被停用、被卸载、被用户关掉都不影响本菜单。
// ---------------------------------------------------------------------------

/** 闭态：rows 与 box 都空着——闭态不残留上一次的行清单，免得「菜单没开却还有行」的错觉 */
export const CLOSED_MENU = {
  open: false,
  x: 0,
  y: 0,
  rows: [],
  paths: [],
  cardId: '',
  box: { left: 0, top: 0, width: 0, height: 0 },
}

/**
 * @typedef {{ id: string, label: string, enabled: boolean }} MenuRowState
 * @typedef {{ left: number, top: number, width: number, height: number }} MenuBox
 * @typedef {object} MenuShellState
 * @property {boolean} open
 * @property {number} x 光标横坐标（存证用；真正落位的是钳制后的 box）
 * @property {number} y
 * @property {readonly MenuRowState[]} rows 本次打开解析出来的行表
 * @property {readonly string[]} paths 本次打开冻结的选区（动作作用于它，菜单开着期间选区变了也不改）
 * @property {string} cardId 本次打开冻结的来源卡片 id（组卡菜单用；文件菜单为空串。工单185 的行按它判卡片身份）
 * @property {MenuBox} box 钳制后的落位
 */

/**
 * 一个事件的全部副作用（**按数组序执行**，即依赖顺序的纪律显式化）。
 * @typedef {{ kind: 'keyboard-tier', held: boolean }
 *   | { kind: 'show', rows: readonly MenuRowState[], box: MenuBox }
 *   | { kind: 'hide' }
 *   | { kind: 'run', id: string, paths: readonly string[], cardId: string }
 *   | { kind: 'hotzones' }
 *   | { kind: 'notify', type: string, payload?: object }} MenuEffect
 */

/**
 * @typedef {{ type: 'open', x: number, y: number, viewport: { width: number, height: number }, specs: readonly object[], ctx: MenuCtx }
 *   | { type: 'activate', id: string }
 *   | { type: 'dismiss', reason: string }
 *   | { type: 'esc' }
 *   | { type: 'unmount' }} MenuShellEvent
 */

/**
 * 归约：一个事件一次合成。
 *
 * 副作用顺序即纪律：
 * 1. **键盘档先持**——窗口先可聚焦，Esc 才送得到插件自己的 keydown 监听；
 * 2. **再建 DOM**（show/hide）；
 * 3. **后申报热区**（hotzones）——遮罩是 class='card'，撤掉它必须重申报，否则全屏热区残留、
 *    菜单关了面板还整屏不穿透；
 * 4. **再执行动作**（run）——菜单此刻已收，动作期间屏幕上不再压着一层壳；
 * 5. 最后存证。
 *
 * 闭态下的 dismiss/activate/esc 是迟到噪声（无转移、无效果）；置灰行与未知 id 同为无效激活
 * （真菜单同款：点了没反应，菜单保持开着，用户可以改点别的行）。
 *
 * @param {MenuShellState} state
 * @param {MenuShellEvent} event
 * @returns {{ state: MenuShellState, effects: MenuEffect[] }}
 */
export function nextMenuShell(state, event) {
  switch (event.type) {
    case 'open': {
      const ctx = event.ctx || { paths: [] }
      const rows = resolveMenuRows(event.specs || [], ctx)
      if (!rows.length) return { state, effects: [] } // 空壳不弹（点开一个没有可用行的菜单一无意义）
      const size = menuSizeOf(rows)
      const box = clampMenuBox({ x: event.x, y: event.y }, size, event.viewport)
      return {
        state: { open: true, x: event.x, y: event.y, rows, paths: ctx.paths, cardId: ctx.cardId || '', box },
        effects: [
          { kind: 'keyboard-tier', held: true },
          { kind: 'show', rows, box },
          { kind: 'hotzones' },
          {
            kind: 'notify',
            type: MENU_OPENED_NOTIFY,
            payload: { x: event.x, y: event.y, box, rows: rows.map((r) => r.id), cardId: ctx.cardId || '' },
          },
        ],
      }
    }
    case 'activate': {
      const row = state.rows.find((r) => r.id === event.id)
      if (!state.open || !row || !row.enabled) return { state, effects: [] }
      return {
        state: CLOSED_MENU,
        effects: [
          { kind: 'hide' },
          { kind: 'hotzones' },
          { kind: 'keyboard-tier', held: false },
          { kind: 'run', id: row.id, paths: state.paths, cardId: state.cardId },
          { kind: 'notify', type: MENU_CLOSED_NOTIFY, payload: { reason: 'action', row: row.id } },
        ],
      }
    }
    case 'dismiss':
    case 'esc': {
      if (!state.open) return { state, effects: [] }
      return {
        state: CLOSED_MENU,
        effects: [
          { kind: 'hide' },
          { kind: 'hotzones' },
          { kind: 'keyboard-tier', held: false },
          {
            kind: 'notify',
            type: MENU_CLOSED_NOTIFY,
            payload: { reason: event.type === 'esc' ? 'esc' : 'outside' },
          },
        ],
      }
    }
    case 'unmount': {
      // 静默收场：通道随插件消亡，存证没有意义，但 DOM/热区/键盘档必须一样不漏地收回
      if (!state.open) return { state, effects: [] }
      return {
        state: CLOSED_MENU,
        effects: [
          { kind: 'hide' },
          { kind: 'hotzones' },
          { kind: 'keyboard-tier', held: false },
        ],
      }
    }
    default:
      return { state, effects: [] }
  }
}
