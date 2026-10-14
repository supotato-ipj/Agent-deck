// 两块自绘写操作层的**纯逻辑**（工单183 = spec166 之⑥：删除确认层 + 内联重命名编辑器）。
//
// 与同目录 grouping.js / interaction.js / geometry.js / menu.js 同一条缝：**纯模块、零 DOM、零
// Electron**，vitest 直测。「什么时候弹、弹出来长什么样、按哪个键干什么、键盘档什么时候持
// 什么时候放」这四类裁决必须能离开 DOM 被测——它们也是最容易在演进中各自漂移的几类数字。
// 本文件是那四类裁决的唯一出处，card.js 一个数都不许另写。
//
// **为什么要自建（票面原文：内核那份取不到）**：
//   - 删除确认层：内核那份（main.ts 的 openTrashConfirm/closeTrashConfirm）是渲染层的模块私有
//     闭包，既不导出也不挂 window，桥接契约表里没有对应方法；插件跑在 deck-plugin:// 下的
//     另一套模块图里，够不着那段源码。故自建一层**显示逻辑**——真正的删除动作仍走内核既有
//     契约 desktop/trash（送回收站、扫描池全有全无护栏、清理摆位存证全部保留）。
//   - 内联重命名编辑器：同理（内核的 beginRename/createRenameInput 同样取不到）。提交仍走
//     desktop/rename，**命名校验规则一个字都不在本插件重写**：Win32 合法名、同名幂等、大小写
//     改名豁免、冲突拒绝——这些是内核的职责，本插件只负责把用户敲的字符串原样递过去，并把
//     失败原因如实上报。递空串也一样：内核会拒，本插件不替它猜。
//
// **键盘档是「让位」不是「抢占」**（工单100 通用能力，档名自由、宿主按插件 id 加命名空间成
// `plugin:doc-group-cards:<tier>`）：档在持期间内核的键盘归一仲裁把「插件档在持」等同浮层在即，
// 于是六键路由（Del/Enter/Ctrl+A/C/X/V）与 Esc 拦截双双让开（keyboard-gate.keyRoutingContextOf
// → overlayOpen → routeSelectionKey 返 null、escapePlan 双否），按键落到本插件自己的监听上。
// 反过来说，档不放，窗口就一直可聚焦——故每一路收起都必须放，卸载亦然；万一插件连卸载钩子都
// 没跑到（进程被杀），宿主在 reclaimPlugin 里按插件 id 强制回收（plugins.ts + plugin-tiers.ts），
// 那是**兜底**，不是可以依赖的常规路径。

/** 删除确认层的全屏遮罩 id（同时是 class='card'，故进热区扫掠；热区身份靠 id 且不去重，取唯一） */
export const CONFIRM_OVERLAY_ID = 'dgc-confirm-overlay'
/** 确认层遮罩根类名（确认层样式表的作用域根；不能挂在样式元素自己的 id 上——见工单181 的教训） */
export const CONFIRM_OVERLAY_CLASS = 'dgc-confirm-overlay'
/** 确认层对话框 id */
export const CONFIRM_BOX_ID = 'dgc-confirm'
export const CONFIRM_BOX_CLASS = 'dgc-confirm-box'
/** 确认层文案（标题 + 文件名清单）的 id 与类名 */
export const CONFIRM_TEXT_ID = 'dgc-confirm-text'
export const CONFIRM_TEXT_CLASS = 'dgc-confirm-text'
/** 确认 / 取消两钮：id 与类名各一对（存证与电池按 id 定位，样式按类名走） */
export const CONFIRM_OK_ID = 'dgc-confirm-ok'
export const CONFIRM_OK_CLASS = 'dgc-confirm-ok'
export const CONFIRM_CANCEL_ID = 'dgc-confirm-cancel'
export const CONFIRM_CANCEL_CLASS = 'dgc-confirm-cancel'
/** 确认层样式元素 id（与确认层同寿：开层才插，关层即摘——保住 #181「装载后 head 恰有一个子节点」） */
export const CONFIRM_STYLE_ID = 'dgc-confirm-style'
/** 内联重命名编辑器的输入框类名（挂在格子里，原地顶替文件名标签） */
export const RENAME_INPUT_CLASS = 'dgc-rename-input'

/** 删除确认层的键盘档名 */
export const CONFIRM_KEYBOARD_TIER = 'delete-confirm'
/** 内联重命名编辑器的键盘档名 */
export const RENAME_KEYBOARD_TIER = 'rename'

/** 存证族。本插件一律 doc-group-cards-* 前缀，绝不冒充内核的 desktop-trash-* / desktop-rename-*：
 *  冒充会让验收电池把两处的证据混为一谈。 */
export const CONFIRM_OPENED_NOTIFY = 'doc-group-cards-confirm-opened'
export const CONFIRM_CLOSED_NOTIFY = 'doc-group-cards-confirm-closed'
export const RENAME_OPENED_NOTIFY = 'doc-group-cards-rename-opened'
export const RENAME_CLOSED_NOTIFY = 'doc-group-cards-rename-closed'

// ---------------------------------------------------------------------------
// 删除确认层几何：尺寸与居中（唯一出处；card.js 只把算出的数写进 DOM）
//
// 几何为什么也走纯模块：确认层的盒子是**居中**的，居中算式与画出来的盒子必须是同一个算式的
// 产物——热区取的是 getBoundingClientRect()，JS 算的落位与 CSS 画的盒子对不上时，用户点到的
// 按钮与存证里报的按钮矩形会分家（电池按存证矩形注入点击，点空了却以为点中了）。
// ---------------------------------------------------------------------------

/** 对话框宽度（像素） */
export const CONFIRM_W = 268
/** 文案单行高（像素） */
export const CONFIRM_LINE_H = 14
/** 对话框上下内边距（像素） */
export const CONFIRM_PAD_Y = 12
/** 文案块与按钮行之间的间距（像素） */
export const CONFIRM_GAP_Y = 10
/** 按钮行高（像素） */
export const CONFIRM_BTN_H = 26

/** 确认层标题：与内核同款措辞（单数/复数），一字不差地照抄不是巧合——同一个心智模型 */
export function confirmTitleOf(names) {
  return names.length === 1 ? 'DELETE 1 ITEM?' : `DELETE ${names.length} ITEMS?`
}

/**
 * 文案行数：标题一行 + 文件名每件一行。空清单（不该发生，见下方归约器的空清单拒绝）也按一行算，
 * 免得盒子塌成一个 0 高的框。
 */
export function confirmLinesOf(names) {
  return 1 + Math.max(1, names.length)
}

/**
 * 确认层盒子尺寸：高 = 上内边距 + 文案行数 × 行高 + 间距 + 按钮行高 + 下内边距。
 * CSS 里插的是同一批常量，JS 里算的也是同一批常量。
 * @param {readonly string[]} names 开层时冻结的文件名清单（仅用于排版与显示）
 */
export function confirmSizeOf(names) {
  return { width: CONFIRM_W, height: 2 * CONFIRM_PAD_Y + confirmLinesOf(names) * CONFIRM_LINE_H + CONFIRM_GAP_Y + CONFIRM_BTN_H }
}

/**
 * 确认层落位：视口正中（**不**按任务栏让位——面板窗本就是主显示器全屏 bounds，
 * 内核的删除确认层同样是直接居中，用户已经习惯了它落在这个位置）。
 * @param {{ width: number, height: number }} viewport
 * @param {readonly string[]} names
 */
export function confirmBoxOf(viewport, names) {
  const size = confirmSizeOf(names)
  return {
    left: Math.max(0, Math.round((viewport.width - size.width) / 2)),
    top: Math.max(0, Math.round((viewport.height - size.height) / 2)),
    width: size.width,
    height: size.height,
  }
}

// ---------------------------------------------------------------------------
// 删除确认层：转移矩阵（状态 + 一个事件一次合成，效果数组按序执行）
// ---------------------------------------------------------------------------

/** 闭态：清单空着——闭态不残留上一次的行，免得「确认层没开却还认得某个文件」的错觉 */
export const CLOSED_CONFIRM = { open: false, names: [], paths: [] }

/**
 * @typedef {{ open: boolean, names: readonly string[], paths: readonly string[] }} ConfirmState
 *   names 仅供显示（标题与清单文案）；paths 才是送给 desktop/trash 的载荷，且**开层时冻结**——
 *   确认层开着期间桌面变了也按冻结那份走，绝不把中途新增的件搭车送进回收站。
 * @typedef {{ kind: 'tier', held: boolean }
 *   | { kind: 'show', names: readonly string[], box: { left: number, top: number, width: number, height: number } }
 *   | { kind: 'hide' }
 *   | { kind: 'run', op: 'trash', paths: readonly string[] }
 *   | { kind: 'hotzones' }
 *   | { kind: 'notify', type: string, payload?: object }} ConfirmEffect
 * @typedef {{ type: 'open', names: readonly string[], paths: readonly string[] }
 *   | { type: 'confirm' }
 *   | { type: 'cancel', reason: string }
 *   | { type: 'esc' }
 *   | { type: 'outside' }
 *   | { type: 'unmount' }} ConfirmEvent
 */

/**
 * 删除确认层的归约：一个事件一次合成。
 *
 * 副作用顺序即纪律，与 menu.js 同款：
 *   1. **键盘档先持**——窗口先可聚焦，Esc 才送得到本插件自己的 keydown 监听；
 *   2. 再建 DOM；3. 后申报热区（遮罩是 class='card'，撤掉它必须重申报，否则全屏热区残留）；
 *   4. 再执行动作；5. 最后存证。
 *
 * **取消四路（confirm 之外的一切）一律不产生 run 效果**——即「取消则无副作用」不是一句承诺，
 * 而是这张效果表的结构事实：没有 run，就没有 desktop/trash，也就没有任何落盘动作。
 *
 * 闭态下的 confirm/cancel/esc/outside 是迟到噪声（无转移、无效果）；已在层里时再 open 不重入
 * （与内核 openTrashConfirm 的 `if (trashConfirmOpen()) return` 同款）。空清单一律不开层：
 * 没有可确认的东西时弹一个空框毫无意义。
 *
 * @param {ConfirmState} state
 * @param {ConfirmEvent} event
 * @param {{ width: number, height: number }} viewport 落位要按视口算（面板窗尺寸）
 * @returns {{ state: ConfirmState, effects: ConfirmEffect[] }}
 */
export function nextConfirmLayer(state, event, viewport) {
  switch (event.type) {
    case 'open': {
      if (state.open) return { state, effects: [] }
      if (!event.paths.length) return { state, effects: [] }
      const names = [...event.names]
      const paths = [...event.paths]
      const box = confirmBoxOf(viewport, names)
      return {
        state: { open: true, names, paths },
        effects: [
          { kind: 'tier', held: true },
          { kind: 'show', names, box },
          { kind: 'hotzones' },
          { kind: 'notify', type: CONFIRM_OPENED_NOTIFY, payload: { names, count: paths.length, box } },
        ],
      }
    }
    case 'confirm': {
      if (!state.open) return { state, effects: [] }
      return {
        state: CLOSED_CONFIRM,
        effects: [
          { kind: 'hide' },
          { kind: 'hotzones' },
          { kind: 'tier', held: false },
          { kind: 'run', op: 'trash', paths: state.paths },
          { kind: 'notify', type: CONFIRM_CLOSED_NOTIFY, payload: { reason: 'confirm', count: state.paths.length } },
        ],
      }
    }
    case 'cancel':
    case 'esc':
    case 'outside': {
      if (!state.open) return { state, effects: [] }
      return {
        state: CLOSED_CONFIRM,
        effects: [
          { kind: 'hide' },
          { kind: 'hotzones' },
          { kind: 'tier', held: false },
          {
            kind: 'notify',
            type: CONFIRM_CLOSED_NOTIFY,
            payload: { reason: event.type === 'esc' ? 'esc' : event.type === 'outside' ? 'outside' : event.reason, count: state.paths.length },
          },
        ],
      }
    }
    case 'unmount': {
      // 静默收场：通道随插件消亡，存证没有意义，但 DOM/热区/键盘档一样不漏地收回
      if (!state.open) return { state, effects: [] }
      return { state: CLOSED_CONFIRM, effects: [{ kind: 'hide' }, { kind: 'hotzones' }, { kind: 'tier', held: false }] }
    }
    default:
      return { state, effects: [] }
  }
}

// ---------------------------------------------------------------------------
// 内联重命名编辑器：转移矩阵
// ---------------------------------------------------------------------------

/**
 * 预选区的右端：文件名里**扩展名之前**的位置（`预算.pdf` → 2，即选中「预算」）。
 * 无扩展名时选中全文。没有点或点在第 0 位（`.gitignore` 这类隐藏文件）都算无扩展名——
 * 与 grouping.extOf 同一口径，不另立一份「什么算扩展名」。
 * @param {string} display 开层时的显示名（内核 DesktopItem.display：快捷方式/网址文件去了扩展名）
 */
export function stemEndOf(display) {
  const dot = display.lastIndexOf('.')
  return dot > 0 ? dot : display.length
}

/** 闭态 */
export const CLOSED_RENAME = { open: false, name: '', path: '', draft: '', stem: 0 }

/**
 * @typedef {{ open: boolean, name: string, path: string, draft: string, stem: number }} RenameState
 *   name/path 是**开层时冻结**的条目身份：草稿敲到一半桌面又变了，提交也只作用于当初那一件。
 *   draft 是输入框当前文本（仅 DOM 与本状态共用；提交载荷是它的 trim）。
 *   stem 是预选右端（开层时算一次，之后不动——用户自己挪了光标，输入框才是真相）。
 * @typedef {{ kind: 'tier', held: boolean }
 *   | { kind: 'show', path: string, value: string, stem: number }
 *   | { kind: 'hide' }
 *   | { kind: 'run', op: 'rename', name: string, to: string }
 *   | { kind: 'notify', type: string, payload?: object }} RenameEffect
 * @typedef {{ type: 'open', name: string, path: string, display: string }
 *   | { type: 'submit' }
 *   | { type: 'cancel', reason: string }
 *   | { type: 'esc' }
 *   | { type: 'outside' }
 *   | { type: 'unmount' }} RenameEvent
 */

/**
 * 内联重命名编辑器的归约：一个事件一次合成。
 *
 * 顺序与另两层同款：**档先持**（窗口先可聚焦），**再建 DOM**（show 里才 focus——顺序反了，
 * focus 落在还不可聚焦的窗口上就没有焦点），最后存证。**刻意不申报热区**：编辑器顶替的是格子
 * 里的文件名标签，卡框那两行内联几何一个字没动，热区扫掠读的是卡片的 getBoundingClientRect()，
 * 矩形纹丝不动 → 不申报就是对的（工单181 的纪律：申报当且仅当矩形变了）。
 *
 * 提交一律把 trim 后的草稿递给内核，**不在本层判合法名**：空串、非法字符、同名冲突都是内核
 * desktop/rename 的裁决（它有 Win32 校验 + 大小写豁免 + 幂等空转），插件替它判就是两份规则
 * 各自漂移的第一现场。失败原因原样上报存证，由 card.js 呈现。
 *
 * 取消三路（submit 之外的一切）一律不产生 run 效果——即「取消不落盘」是这张效果表的结构事实。
 * 已在编辑时再 open 不重入（与内核 beginRename 同款）。
 *
 * @param {RenameState} state
 * @param {RenameEvent} event
 * @returns {{ state: RenameState, effects: RenameEffect[] }}
 */
export function nextRenameEditor(state, event) {
  switch (event.type) {
    case 'open': {
      if (state.open) return { state, effects: [] }
      const stem = stemEndOf(event.display)
      return {
        state: { open: true, name: event.name, path: event.path, draft: event.display, stem },
        effects: [
          { kind: 'tier', held: true },
          { kind: 'show', path: event.path, value: event.display, stem },
          { kind: 'notify', type: RENAME_OPENED_NOTIFY, payload: { name: event.name, path: event.path } },
        ],
      }
    }
    case 'submit': {
      if (!state.open) return { state, effects: [] }
      const to = state.draft.trim()
      return {
        state: CLOSED_RENAME,
        effects: [
          { kind: 'hide' },
          { kind: 'tier', held: false },
          { kind: 'run', op: 'rename', name: state.name, to },
          { kind: 'notify', type: RENAME_CLOSED_NOTIFY, payload: { reason: 'submit', name: state.name, to } },
        ],
      }
    }
    case 'cancel':
    case 'esc':
    case 'outside': {
      if (!state.open) return { state, effects: [] }
      return {
        state: CLOSED_RENAME,
        effects: [
          { kind: 'hide' },
          { kind: 'tier', held: false },
          {
            kind: 'notify',
            type: RENAME_CLOSED_NOTIFY,
            payload: {
              reason: event.type === 'esc' ? 'esc' : event.type === 'outside' ? 'outside' : event.reason,
              name: state.name,
            },
          },
        ],
      }
    }
    case 'unmount': {
      if (!state.open) return { state, effects: [] }
      return { state: CLOSED_RENAME, effects: [{ kind: 'hide' }, { kind: 'tier', held: false }] }
    }
    default:
      return { state, effects: [] }
  }
}

/**
 * 确认层样式（几何数值全部从上面的常量插值进来，与 confirmSizeOf/confirmBoxOf 同源；
 * 对话框的 left/top/width/height 由 JS 按算式写内联样式——热区与存证矩形取的是
 * getBoundingClientRect()，CSS 与 JS 各写一份尺寸时用户点到的是错的）。
 *
 * 确认层的遮罩与菜单遮罩不是同一个节点：菜单先收干净才轮到确认层开，两者不会同时在场，
 * 但 id 仍各取唯一——热区扫掠对重复 id 不去重。
 */
export const CONFIRM_CSS = `
.${CONFIRM_OVERLAY_CLASS} { cursor: default; }
.${CONFIRM_BOX_CLASS} {
  position: absolute;
  box-sizing: border-box;
  padding: ${CONFIRM_PAD_Y}px 14px;
  background: rgba(20, 20, 22, 0.94);
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 12px;
  font-family: Consolas, "Courier New", monospace;
  overflow: hidden;
}
.${CONFIRM_TEXT_CLASS} {
  font-size: 11px;
  line-height: ${CONFIRM_LINE_H}px;
  letter-spacing: 0.06em;
  color: #e6e6e6;
  white-space: pre-wrap;
  overflow: hidden;
  user-select: none;
}
.${CONFIRM_OK_CLASS}, .${CONFIRM_CANCEL_CLASS} {
  display: block;
  width: 100%;
  height: ${CONFIRM_BTN_H}px;
  margin-top: ${CONFIRM_GAP_Y}px;
  border-radius: 8px;
  font-family: inherit;
  font-size: 11px;
  letter-spacing: 0.12em;
  text-align: center;
  line-height: ${CONFIRM_BTN_H}px;
  cursor: pointer;
  user-select: none;
}
.${CONFIRM_OK_CLASS} { background: rgba(190, 70, 70, 0.35); border: 1px solid rgba(255, 120, 120, 0.5); color: #ffe2e2; }
.${CONFIRM_OK_CLASS}:hover { background: rgba(210, 80, 80, 0.55); color: #fff; }
.${CONFIRM_CANCEL_CLASS} { background: rgba(255, 255, 255, 0.10); border: 1px solid rgba(255, 255, 255, 0.22); color: #e6e6e6; }
.${CONFIRM_CANCEL_CLASS}:hover { background: rgba(255, 255, 255, 0.2); color: #fff; }
`

/**
 * 内联重命名编辑器的样式（并入 card.js 的 CARD_CSS 一起插，故不另起样式元素——
 * 编辑器样式极小且不含任何几何：唯一要定死的是输入框宽度，而宽度由 card.js 按 CELL 写内联）。
 *
 * **作用域根由调用方给**（interaction.js 的 CARD_CLASS），不在这儿写死：作用域根只有一个出处，
 * 两边各写一份迟早会分叉，而写成样式元素自己的 id（`#dgc-style .dgc-cell`）那种写法更是哑的
 * ——<style> 在 DOM 树里没有任何后代，整表规则一条都不命中（工单181 的教训）。
 * @param {string} scope 作用域根（卡片根类名）
 */
export function renameCssOf(scope) {
  return `
.${scope} .${RENAME_INPUT_CLASS} {
  box-sizing: border-box;
  padding: 0 2px;
  border: 1px solid rgba(120, 180, 255, 0.9);
  border-radius: 4px;
  background: rgba(10, 14, 20, 0.95);
  color: #fff;
  font-family: inherit;
  font-size: 11px;
  line-height: 13px;
  text-align: center;
  outline: none;
}
`
}
