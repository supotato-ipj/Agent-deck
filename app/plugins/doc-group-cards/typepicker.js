// 「接受的类型」勾选浮层的**纯逻辑**（工单185 = spec166 之⑧）。
//
// 与同目录 writeops.js 同一条缝、同款纪律：**纯模块、零 DOM、零 Electron**，状态归归约器、
// 效果数组按序执行、本文件是那几个数字的唯一出处（card.js 一个数都不许另写）。
//
// 为什么自绘（票面原文的同一理由，内核那份取不到）：面板的键盘档是唯一「让窗口可聚焦」的入口
// （宿主与桥接契约里没有任何「聚焦某个元素」的 API），故焦点两步走——效果数组里**档先持**、
// show 里才 focus，顺序反了焦点就落空。
//
// **列表只来自桌面上此刻真实存在的扩展名**（present 由 card.js 用 ownership.presentExtensionsOf
// 从快照现算，本模块不碰 DOM 故自己不去数）。不存在的类型不列：列了也没文件可放，用户不必为
// 不存在的类型操心。但**不清声明**：一张卡曾经接受、而桌面上暂时没有文件的类型，用户这一轮没碰
// 过它，保存就不该顺手抹掉——否则删几个文件再存一次，分类悄悄丢了。

/** 浮层遮罩 id（同时是 class='card'，故进热区扫掠；热区身份靠 id 且不去重，取唯一） */
export const TYPE_OVERLAY_ID = 'dgc-types-overlay'
/** 遮罩根类名（勾选浮层样式表的作用域根；不能挂在样式元素自己的 id 上——工单181 的教训） */
export const TYPE_OVERLAY_CLASS = 'dgc-types-overlay'
/** 对话框 id */
export const TYPE_BOX_ID = 'dgc-types'
export const TYPE_BOX_CLASS = 'dgc-types-box'
/** 名字输入（仅 NEW GROUP 有；EDIT TYPES 不改卡名） */
export const TYPE_NAME_ID = 'dgc-types-name'
export const TYPE_NAME_CLASS = 'dgc-types-name'
/** 「接受全部类型」开关 */
export const TYPE_ALL_ID = 'dgc-types-all'
export const TYPE_ALL_CLASS = 'dgc-types-all'
/** 类型清单容器（超出可见行数即纵向滚动） */
export const TYPE_LIST_ID = 'dgc-types-list'
export const TYPE_LIST_CLASS = 'dgc-types-list'
/** 清单里的一行（一个扩展名一个勾选） */
export const TYPE_ROW_CLASS = 'dgc-types-row'
/** 勾选框 */
export const TYPE_BOX_MARK_CLASS = 'dgc-types-mark'
/** 建卡 / 保存两钮 */
export const TYPE_OK_ID = 'dgc-types-ok'
export const TYPE_OK_CLASS = 'dgc-types-ok'
export const TYPE_CANCEL_ID = 'dgc-types-cancel'
export const TYPE_CANCEL_CLASS = 'dgc-types-cancel'
/** 样式元素 id（与浮层同寿：开层才插，关层即摘——保住「装载后 head 恰有一个子节点」） */
export const TYPE_STYLE_ID = 'dgc-types-style'

/** 浮层的键盘档名（档名自由，宿主按插件 id 加命名空间成 plugin:doc-group-cards:<tier>） */
export const TYPE_KEYBOARD_TIER = 'types'
/** 存证族（本插件一律 doc-group-cards-* 前缀，绝不冒充内核的存证族） */
export const TYPE_OPENED_NOTIFY = 'doc-group-cards-types-opened'
export const TYPE_CLOSED_NOTIFY = 'doc-group-cards-types-closed'

// ---------------------------------------------------------------------------
// 几何：尺寸与居中（唯一出处；CSS 里插的是同一批常量）
//
// 几何为什么也走纯模块：盒子是**居中**的，落位算式与画出来的盒子必须是同一个算式的产物——
// 热区与存证矩形取的是 getBoundingClientRect()，两边各写一份尺寸时，用户点到的按钮与存证里报的
// 按钮矩形会分家。
// ---------------------------------------------------------------------------

/** 对话框宽度（像素） */
export const PICKER_W = 288
/** 名字输入行高（像素） */
export const PICKER_FIELD_H = 24
/** 开关行高（像素） */
export const PICKER_SWITCH_H = 20
/** 类型清单单行高（像素） */
export const PICKER_ROW_H = 20
/** 清单可见行数上限：再多即纵向滚动（类型多的桌面也不把盒子撑出视口） */
export const PICKER_MAX_ROWS = 8
/** 上下内边距（像素） */
export const PICKER_PAD_Y = 12
/** 块间距（像素）：名字 / 开关 / 清单 / 按钮行之间 */
export const PICKER_GAP_Y = 8
/** 按钮行高（像素） */
export const PICKER_BTN_H = 26


/**
 * 盒子尺寸：**照 TYPE_PICKER_CSS 的内容堆叠**自上而下加总（工单187 真机轮修）。
 *
 * 这一段与 CSS 的对应是**硬约束**，不是两处各写一份的巧合——此前正是这里与 CSS 分家：CSS 里类型
 * 清单是**定高可滚动视口**（`height: PICKER_MAX_ROWS × PICKER_ROW_H`，溢出在清单内部滚），这里却
 * 按**行数**算清单高、且只给**一个**钮留位。真机轮实测：桌面上只有五个扩展名时盒子比内容短 86px，
 * CREATE 与 CANCEL 被排到盒子外沿之下、被 `overflow:hidden` 裁掉——那一击穿过盒子落在遮罩上，被判成
 * outside：层当场收起、落库一个字节没发生，用户看着像「点了 CREATE 没反应」，而页内一个错误都没有。
 * 存证佐证（app/accept/evidence/166-doc-group-cards-events.jsonl）：那次提交记的是
 * `types-closed reason=outside`，从头到尾没有 `groups-saved`。
 *
 * 逐项对照（改任何一项都必须连 CSS 一起改）：
 *   - 上下内边距      PICKER_PAD_Y × 2（`.dgc-types-box` 的 padding）
 *   - 名字输入        PICKER_FIELD_H（仅 NEW GROUP）+ 其后一个间距
 *   - 「接受全部类型」PICKER_SWITCH_H + 其后一个间距
 *   - 类型清单        PICKER_MAX_ROWS × PICKER_ROW_H（**定高视口**，行数不参与）
 *   - 两钮            2 × PICKER_BTN_H + 一个间距（CANCEL 的 margin-top）
 *   - 间距合计        4 × PICKER_GAP_Y
 * 盒子高度因此与类型数无关：类型多时清单内部滚动，而不是把盒子撑大。
 * @param {{ present: readonly { ext: string }[], mode?: string }} view
 */
export function typePickerSizeOf(view) {
  const nameH = view.mode === 'create' ? PICKER_FIELD_H : 0
  const listH = PICKER_MAX_ROWS * PICKER_ROW_H
  return {
    width: PICKER_W,
    height: 2 * PICKER_PAD_Y + nameH + PICKER_SWITCH_H + listH + 2 * PICKER_BTN_H + 4 * PICKER_GAP_Y,
  }
}

/**
 * 落位：视口正中（**不**按任务栏让位——面板窗本就是主显示器全屏 bounds，内核的删除确认层同样
 * 直接居中，用户已经习惯了它落在这个位置）。
 * @param {{ width: number, height: number }} viewport
 * @param {{ present: readonly { ext: string }[], mode?: string }} view
 */
export function typePickerBoxOf(viewport, view) {
  const size = typePickerSizeOf(view)
  return {
    left: Math.max(0, Math.round((viewport.width - size.width) / 2)),
    top: Math.max(0, Math.round((viewport.height - size.height) / 2)),
    width: size.width,
    height: size.height,
  }
}

// ---------------------------------------------------------------------------
// 转移矩阵（与 writeops.js 同款形状）
// ---------------------------------------------------------------------------

/** 闭态：清单与草稿都空着——闭态不残留上一次的内容，免得「浮层没开却还认得某个类型」的错觉 */
export const CLOSED_TYPES = {
  open: false,
  mode: 'edit',
  cardId: '',
  label: '',
  name: '',
  nameError: '',
  acceptAll: false,
  present: [],
  picked: [],
}

/**
 * @typedef {object} TypePickerState
 * @property {boolean} open
 * @property {'create' | 'edit'} mode create = NEW GROUP（要起名）；edit = EDIT TYPES（只改类型）
 * @property {string} cardId 被改的那张自定义卡的 id（建卡模式为空串；改类型时**开层时冻结**）
 * @property {string} label 那张卡的卡面名（仅供显示）
 * @property {string} name 名字草稿（仅 create）
 * @property {string} nameError 「没名」的自陈（仅 create；不替用户编一个名）
 * @property {boolean} acceptAll 「接受全部类型」开关
 * @property {readonly { ext: string, label: string }[]} present 开层时冻结的清单
 * @property {string[]} picked 声明里真正勾着的扩展名（含桌面上暂时没有文件的那些，见文件头）
 *
 * @typedef {{ kind: 'tier', held: boolean }
 *   | { kind: 'show', mode: string, cardId: string, label: string, name: string, acceptAll: boolean,
 *       present: readonly { ext: string, label: string }[], checked: readonly string[],
 *       box: { left: number, top: number, width: number, height: number } }
 *   | { kind: 'hide' }
 *   | { kind: 'run', op: 'create-group', name: string, exts: readonly string[], acceptAll: boolean }
 *   | { kind: 'run', op: 'edit-types', cardId: string, exts: readonly string[], acceptAll: boolean }
 *   | { kind: 'hotzones' }
 *   | { kind: 'notify', type: string, payload?: object }} TypePickerEffect
 *
 * @typedef {{ type: 'create', present: readonly { ext: string, label: string }[] }
 *   | { type: 'edit', cardId: string, label: string, exts: readonly string[], acceptAll: boolean,
 *       present: readonly { ext: string, label: string }[] }
 *   | { type: 'toggle', ext: string }
 *   | { type: 'toggle-all' }
 *   | { type: 'set-name', name: string }
 *   | { type: 'submit' }
 *   | { type: 'cancel', reason: string }
 *   | { type: 'esc' }
 *   | { type: 'outside' }
 *   | { type: 'unmount' }} TypePickerEvent
 */

/** 某一行在当前状态下显示为勾住吗（「接受全部类型」打开时一律显示为勾住——宽卡不必逐个勾） */
export function checkedOf(state, ext) {
  return state.acceptAll === true || state.picked.indexOf(ext) >= 0
}

/** 声明里真的勾着它吗（与显示分家：开关开着时显示为勾住，声明里并没有） */
export function isPicked(state, ext) {
  return state.picked.indexOf(ext) >= 0
}

/** 勾选清单里有的那一行才排得上；不在清单里就原样退回（用户勾不了不存在的东西） */
function togglePick(picked, ext) {
  return picked.indexOf(ext) >= 0 ? picked.filter((e) => e !== ext) : [...picked, ext]
}

/**
 * 归约：一个事件一次合成。
 *
 * 副作用顺序即纪律，与 menu.js / writeops.js 同款：
 *   1. **键盘档先持**（窗口先可聚焦，Esc 与输入焦点才送得到本插件自己的监听）；
 *   2. 再建 DOM（show 里才 focus——顺序反了焦点落空）；3. 后申报热区（遮罩铺满视口，撤掉必须
 *      重申报，否则全屏热区残留、浮层关了面板还整屏不穿透）；4. 再执行动作；5. 最后存证。
 *
 * **取消四路（submit 之外的一切）一律不产生 run 效果**——即「取消不落盘」是这张效果表的结构事实，
 * 不是一句承诺。**空名提交同样不产生 run**（没名就没有卡可建；不替用户编一个名）。
 *
 * 闭态下的噪声事件既无转移也无效果；已在层里时再 open 不重入。
 *
 * @param {TypePickerState} state
 * @param {TypePickerEvent} event
 * @param {{ width: number, height: number }} viewport
 * @returns {{ state: TypePickerState, effects: TypePickerEffect[] }}
 */
export function nextTypePicker(state, event, viewport) {
  switch (event.type) {
    case 'create': {
      if (state.open) return { state, effects: [] }
      const present = [...event.present]
      const box = typePickerBoxOf(viewport, { present, mode: 'create' })
      return {
        state: { open: true, mode: 'create', cardId: '', label: '', name: '', nameError: '', acceptAll: false, present, picked: [] },
        effects: [
          { kind: 'tier', held: true },
          {
            kind: 'show',
            mode: 'create',
            cardId: '',
            label: '',
            name: '',
            acceptAll: false,
            present,
            checked: [],
            box,
          },
          { kind: 'hotzones' },
          { kind: 'notify', type: TYPE_OPENED_NOTIFY, payload: { mode: 'create', cardId: '', label: '', present, checked: [], box } },
        ],
      }
    }
    case 'edit': {
      if (state.open) return { state, effects: [] }
      const present = [...event.present]
      const box = typePickerBoxOf(viewport, { present, mode: 'edit' })
      // 声明原样带走（含桌面上暂时没有文件的那些，见文件头：保存不该顺手抹掉没碰过的声明）
      const picked = [...new Set(event.exts)].sort()
      const acceptAll = event.acceptAll === true
      return {
        state: {
          open: true, mode: 'edit', cardId: event.cardId, label: event.label,
          name: '', nameError: '', acceptAll, present, picked,
        },
        effects: [
          { kind: 'tier', held: true },
          {
            kind: 'show',
            mode: 'edit',
            cardId: event.cardId,
            label: event.label,
            name: '',
            acceptAll,
            present,
            checked: acceptAll ? present.map((p) => p.ext) : picked,
            box,
          },
          { kind: 'hotzones' },
          {
            kind: 'notify',
            type: TYPE_OPENED_NOTIFY,
            payload: { mode: 'edit', cardId: event.cardId, label: event.label, present, checked: acceptAll ? present.map((p) => p.ext) : picked, box },
          },
        ],
      }
    }
    case 'toggle': {
      if (!state.open) return { state, effects: [] }
      // 开关开着时逐项一律无效果（宽卡与逐项互斥，不留半开半关的第三态）
      if (state.acceptAll) return { state, effects: [] }
      // 清单里没有的类型勾不动（不存在的类型不给勾）
      if (!state.present.some((p) => p.ext === event.ext)) return { state, effects: [] }
      return { state: { ...state, picked: togglePick(state.picked, event.ext).sort() }, effects: [] }
    }
    case 'toggle-all': {
      if (!state.open) return { state, effects: [] }
      // 只翻开关，**不清勾选**：关回来时用户逐项勾过的东西还在
      return { state: { ...state, acceptAll: !state.acceptAll }, effects: [] }
    }
    case 'set-name': {
      if (!state.open) return { state, effects: [] }
      return { state: { ...state, name: String(event.name ?? ''), nameError: '' }, effects: [] }
    }
    case 'submit': {
      if (!state.open) return { state, effects: [] }
      if (state.mode === 'create') {
        const name = state.name.trim()
        if (!name) {
          // 空名：层还开着，把「没名」摆出来，等用户补（不产生任何落库动作）
          return { state: { ...state, nameError: '给这张卡起个名' }, effects: [] }
        }
        return {
          state: CLOSED_TYPES,
          effects: [
            { kind: 'hide' },
            { kind: 'hotzones' },
            { kind: 'tier', held: false },
            { kind: 'run', op: 'create-group', name, exts: [...state.picked], acceptAll: state.acceptAll },
            { kind: 'notify', type: TYPE_CLOSED_NOTIFY, payload: { reason: 'submit', mode: 'create', name } },
          ],
        }
      }
      return {
        state: CLOSED_TYPES,
        effects: [
          { kind: 'hide' },
          { kind: 'hotzones' },
          { kind: 'tier', held: false },
          { kind: 'run', op: 'edit-types', cardId: state.cardId, exts: [...state.picked], acceptAll: state.acceptAll },
          { kind: 'notify', type: TYPE_CLOSED_NOTIFY, payload: { reason: 'submit', mode: 'edit', cardId: state.cardId } },
        ],
      }
    }
    case 'cancel':
    case 'esc':
    case 'outside': {
      if (!state.open) return { state, effects: [] }
      return {
        state: CLOSED_TYPES,
        effects: [
          { kind: 'hide' },
          { kind: 'hotzones' },
          { kind: 'tier', held: false },
          {
            kind: 'notify',
            type: TYPE_CLOSED_NOTIFY,
            payload: { reason: event.type === 'esc' ? 'esc' : event.type === 'outside' ? 'outside' : event.reason, mode: state.mode },
          },
        ],
      }
    }
    case 'unmount': {
      if (!state.open) return { state, effects: [] }
      return { state: CLOSED_TYPES, effects: [{ kind: 'hide' }, { kind: 'hotzones' }, { kind: 'tier', held: false }] }
    }
    default:
      return { state, effects: [] }
  }
}

/**
 * 浮层样式（几何数值从上面的常量插值进来，与 typePickerSizeOf/BoxOf 同源；对话框的
 * left/top/width/height 由 JS 按算式写内联样式——热区取 getBoundingClientRect()，CSS 与 JS
 * 各写一份尺寸时用户点到的是错的）。
 *
 * 作用域根是**遮罩根类名**而非样式元素自己的 id（工单181 的教训：<style> 在 DOM 树里没有任何
 * 后代，写成 `#dgc-types-style .dgc-types-row` 那种整表规则一条都不命中）。
 */
export const TYPE_PICKER_CSS = `
.${TYPE_OVERLAY_CLASS} { cursor: default; }
.${TYPE_BOX_CLASS} {
  position: absolute;
  box-sizing: border-box;
  padding: ${PICKER_PAD_Y}px 14px;
  background: rgba(20, 20, 22, 0.94);
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 12px;
  font-family: Consolas, "Courier New", monospace;
  overflow: hidden;
}
.${TYPE_NAME_CLASS} {
  display: block;
  box-sizing: border-box;
  width: 100%;
  height: ${PICKER_FIELD_H}px;
  margin-bottom: ${PICKER_GAP_Y}px;
  padding: 0 6px;
  border: 1px solid rgba(120, 180, 255, 0.55);
  border-radius: 6px;
  background: rgba(10, 14, 20, 0.95);
  color: #fff;
  font-family: inherit;
  font-size: 11px;
  letter-spacing: 0.04em;
  outline: none;
}
.${TYPE_ALL_CLASS} {
  height: ${PICKER_SWITCH_H}px;
  margin-bottom: ${PICKER_GAP_Y}px;
  font-size: 11px;
  line-height: ${PICKER_SWITCH_H}px;
  letter-spacing: 0.06em;
  color: #e6e6e6;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  user-select: none;
}
.${TYPE_ALL_CLASS}:hover { color: #fff; }
.${TYPE_LIST_CLASS} {
  height: ${PICKER_MAX_ROWS * PICKER_ROW_H}px;
  overflow-y: auto;
  overflow-x: hidden;
  margin-bottom: ${PICKER_GAP_Y}px;
}
.${TYPE_ROW_CLASS} {
  height: ${PICKER_ROW_H}px;
  line-height: ${PICKER_ROW_H}px;
  font-size: 11px;
  letter-spacing: 0.06em;
  color: #d6d6d6;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
}
.${TYPE_ROW_CLASS}:hover { color: #fff; }
.${TYPE_BOX_MARK_CLASS} {
  display: inline-block;
  width: 11px;
  margin-right: 8px;
  text-align: center;
  color: #78b4ff;
}
.${TYPE_OK_CLASS}, .${TYPE_CANCEL_CLASS} {
  display: block;
  width: 100%;
  height: ${PICKER_BTN_H}px;
  border-radius: 8px;
  font-family: inherit;
  font-size: 11px;
  letter-spacing: 0.12em;
  text-align: center;
  line-height: ${PICKER_BTN_H}px;
  cursor: pointer;
  user-select: none;
}
.${TYPE_OK_CLASS} { background: rgba(70, 130, 190, 0.35); border: 1px solid rgba(120, 180, 255, 0.5); color: #e6f0ff; }
.${TYPE_OK_CLASS}:hover { background: rgba(90, 160, 230, 0.55); color: #fff; }
.${TYPE_CANCEL_CLASS} { margin-top: ${PICKER_GAP_Y}px; background: rgba(255, 255, 255, 0.10); border: 1px solid rgba(255, 255, 255, 0.22); color: #e6e6e6; }
.${TYPE_CANCEL_CLASS}:hover { background: rgba(255, 255, 255, 0.2); color: #fff; }
`
