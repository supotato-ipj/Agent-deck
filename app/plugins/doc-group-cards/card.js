// 组卡（工单179 = spec166 之②，tracer bullet；工单181 = spec166 之④，交互语义与生命周期；
// 工单182 = spec166 之⑤，自绘菜单外壳与只读五项；工单183 = spec166 之⑥，写操作两项
// RENAME/DELETE + 组卡菜单骨架；工单185 = spec166 之⑧，自定义组卡的建立与编辑——组定义持久化
// 与三层归属；工单186 = spec166 之⑨，粘贴路由三态 + 临时组卡 + 解散归档）：投放型插件包
// doc-group-cards 的入口。
//
// 交付形态（ADR-0014）：投放型插件包，不是内置卡片包。源码在仓库内（app/plugins/doc-group-cards/），
// 另有一道安装步骤把它拷进用户插件根；运行态仍投放型——删掉那个目录即完全撤回，内核文档区自己回来。
// 本文件是浏览器可跑的 ES 模块（面板经 deck-plugin:// 原样 import，无编译步骤），故：
//   - 分组规则在同目录 grouping.js（纯逻辑、零 DOM 零 Electron，vitest 直测）；
//   - 交互裁决在同目录 interaction.js（同一条缝，工单181）；
//   - 折叠/展开几何在同目录 geometry.js（同一条缝，工单180）；
//   - 菜单开合/置灰/落位在同目录 menu.js（同一条缝，工单182）；
//   - 删除确认层与内联重命名编辑器的状态迁移在同目录 writeops.js（同一条缝，工单183）；
//   - **组定义形状、三层归属、临时卡成员与序号**在同目录 ownership.js（同一条缝，工单185/186）；
//   - **「接受的类型」勾选浮层**的状态迁移在同目录 typepicker.js（同一条缝，工单185）；
//   - **粘贴三态路由与临时卡生成**在同目录 pasting.js（同一条缝，工单186）；
//   - 本文件只管「画卡」「接线」「画浮层」与「存取组定义」：几何、图标、启动、点击监听、热区、
//     菜单与浮层接线。
//
// 词：GLOSSARY 的**扩展组**（按单个扩展名聚合）是**组卡**（渲染它的那张卡）的分组单位；
// 内核按类别聚合的**文档组**（六类列）与此并存、互不干涉（内核那条规则本插件一行不改）。
//
// 装载即接管桌面文档的呈现：mount 藏掉内核文档区，unmount 原样还回去。呈现层的调用纪律：
// 插件每一次改变卡片几何之后都必须主动 host.onDomChanged()——热区没有周期性重算，
// 不申报新覆盖的区域就既点不到也滚不动（spec166「热区纪律」）。折叠切换会改形状，故申报；
// 高亮只改类名不改布局盒，矩形不动，故不申报；菜单遮罩、删除确认层遮罩与勾选浮层遮罩一铺一撤
// 都改几何，故三个方向都申报；内联重命名编辑器在**卡框内部**顶替一个标签、卡框那两行内联几何
// 一字未动，故不申报（详见 writeops.js 的归约器注释）。

import { extOf } from './grouping.js'
import {
  CARD_PAD_X,
  CARD_PAD_Y,
  CARD_GAP,
  CELL,
  CELL_GAP,
  COLLAPSED_COLS,
  COLLAPSED_ROWS,
  EXPANDED_COLS,
  EXPANDED_H,
  EXPANDED_W,
  HEAD_H,
  moreLabelOf,
  rowLayoutOf,
} from './geometry.js'
import {
  CARD_CLASS,
  CELL_CLASS,
  EXPANDED_CLASS,
  FADED_CLASS,
  HIGHLIGHT_CLASS,
  MORE_CLASS,
  clickOnIcon,
  clickToggleExclusive,
  expandedCardIdOf,
  expandedClassOf,
  fadedClassOf,
  highlightClassOf,
  initialCardState,
  isCardToggle,
  isGroupMenuHit,
} from './interaction.js'
import {
  CLOSED_MENU,
  DISABLED_CLASS,
  FILE_MENU_ROWS,
  GROUP_CARD_MENU_ROWS,
  KEYBOARD_TIER,
  MENU_ACTION_NOTIFY,
  MENU_CLOSED_NOTIFY,
  MENU_CSS,
  MENU_STYLE_ID,
  OVERLAY_CLASS,
  OVERLAY_ID,
  PANEL_CLASS,
  PANEL_ID,
  ROW_CLASS,
  nextMenuShell,
} from './menu.js'
import {
  CLOSED_CONFIRM,
  CLOSED_RENAME,
  CONFIRM_BOX_CLASS,
  CONFIRM_BOX_ID,
  CONFIRM_BTN_H,
  CONFIRM_CANCEL_CLASS,
  CONFIRM_CANCEL_ID,
  CONFIRM_KEYBOARD_TIER,
  CONFIRM_MODE_DISSOLVE,
  CONFIRM_MODE_TRASH,
  CONFIRM_OK_CLASS,
  CONFIRM_OK_ID,
  CONFIRM_OPENED_NOTIFY,
  CONFIRM_OVERLAY_CLASS,
  CONFIRM_OVERLAY_ID,
  CONFIRM_PAD_Y,
  CONFIRM_STYLE_ID,
  CONFIRM_TEXT_CLASS,
  CONFIRM_TEXT_ID,
  CONFIRM_CSS,
  RENAME_INPUT_CLASS,
  RENAME_KEYBOARD_TIER,
  confirmTitleOf,
  confirmOkLabelOf,
  nextConfirmLayer,
  nextRenameEditor,
  renameCssOf,
} from './writeops.js'
import {
  STORE_KEY,
  TIER_CUSTOM,
  TIER_TEMP,
  addCustomGroup,
  buildCards,
  dissolveGroup,
  editCustomGroupTypes,
  emptyStore,
  presentExtensionsOf,
  storeOf,
} from './ownership.js'
import {
  PASTE_FAILED_NOTIFY,
  PASTE_ROUTED_NOTIFY,
  pastedNamesOf,
  routePaste,
} from './pasting.js'
import {
  CLOSED_TYPES,
  TYPE_ALL_CLASS,
  TYPE_ALL_ID,
  TYPE_BOX_MARK_CLASS,
  TYPE_BOX_CLASS,
  TYPE_BOX_ID,
  TYPE_CANCEL_CLASS,
  TYPE_CANCEL_ID,
  TYPE_KEYBOARD_TIER,
  TYPE_LIST_CLASS,
  TYPE_LIST_ID,
  TYPE_NAME_CLASS,
  TYPE_NAME_ID,
  TYPE_OK_CLASS,
  TYPE_OK_ID,
  TYPE_OPENED_NOTIFY,
  TYPE_OVERLAY_CLASS,
  TYPE_OVERLAY_ID,
  TYPE_PICKER_CSS,
  TYPE_ROW_CLASS,
  TYPE_STYLE_ID,
  checkedOf,
  nextTypePicker,
  typePickerBoxOf,
} from './typepicker.js'

const PLUGIN_ID = 'doc-group-cards'
/** 组卡样式与组定义存证族 */
const GROUPS_LOADED_NOTIFY = 'doc-group-cards-groups-loaded'
const GROUPS_SAVED_NOTIFY = 'doc-group-cards-groups-saved'

/** 本插件插进文档头的样式元素的 id（换代前一代没清干净时按它扫；热区日志也认这个名字） */
export const STYLE_ID = 'dgc-style'

/**
 * 插件自带样式（第三方插件不依赖面板样式表的面板内规则——只继承 .card 底盘）。
 *
 * 作用域根是**卡片根类名** `.dgc-card`，不是样式元素自己的 id：`#dgc-style .dgc-cell` 这种写法
 * 选的是「#dgc-style 的元素后代里的 .dgc-cell」，而 <style> 元素在 DOM 树里没有任何后代，
 * 于是整表规则一条都不会命中（工单179 原样如此，工单181 修正——不改这条，新增规则同样是哑的）。
 *
 * 几何只有一个出处：`geometry.js`。本表里的格子尺寸与列数都从那里插值进来，卡框那两行
 * （width/height）则由 JS 按 geometry.js 的同一张表写进行内样式——CSS 与 JS 各写一份宽度，
 * 迟早会有一份过期，而热区矩形取的是 getBoundingClientRect()，两份数字打架时用户看到的是错的。
 *
 * 展开态的**卡框**在 JS（内联），**内容区重排与滚动**在这里（`.dgc-expanded .dgc-grid`）：
 * 内容区没有任何内联对手，交给 CSS 才是它该待的地方；卡框必须跟着 `.dgc-expanded` 这个类名走，
 * 否则工单181 留在 interaction.js 里的那道接缝（只切类名、不写几何）就白留了。
 */
const CARD_CSS_BASE = `
.${CARD_CLASS} {
  cursor: pointer;
}
.${CARD_CLASS} .dgc-head {
  height: ${HEAD_H}px;
  margin: 0;
  line-height: 14px;
  overflow: hidden;
  white-space: nowrap;
  /* 徽标挂在标题行右侧：卡片本身是 .card（position:fixed），内部要自己开定位上下文 */
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.${CARD_CLASS} .dgc-title { overflow: hidden; text-overflow: ellipsis; }
/* 「+N」徽标：折叠态藏起来的个数。仅在确有溢出时渲染（见 geometry.js moreLabelOf）。 */
.${CARD_CLASS} .${MORE_CLASS} {
  flex: none;
  padding: 1px 8px;
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.12);
  color: #cfd3d6;
  font-size: 10px;
  line-height: 14px;
  letter-spacing: 0.06em;
}
.${CARD_CLASS} .${MORE_CLASS}:hover { background: rgba(255, 255, 255, 0.22); color: #fff; }
.${CARD_CLASS} .dgc-grid {
  display: grid;
  grid-template-columns: repeat(${COLLAPSED_COLS}, ${CELL}px);
  grid-auto-rows: ${CELL}px;
  gap: ${CELL_GAP}px;
  width: ${COLLAPSED_COLS * CELL + (COLLAPSED_COLS - 1) * CELL_GAP}px;
  height: ${COLLAPSED_ROWS * CELL + (COLLAPSED_ROWS - 1) * CELL_GAP}px;
  /* 折叠态内容区与卡框的内边距盒严丝合缝（280 + 20×2 = 320），margin:0 auto 在这一态是空操作；
     展开态内容区 568 比内边距盒 600 窄，居中才不像漏排了一列。 */
  margin: 0 auto;
  /* 折叠态：固定两行，超出部分隐藏——文件仍在 DOM 里（geometry.js 的 visibleCount/remainingCount
     说的就是这件事），只是这一屏露不出来。想看就点 +N。 */
  overflow: hidden;
}
/* 展开态（工单180）：卡框尺寸由 JS 按 geometry.js 写内联样式，这里负责内容区的重排与滚动。
   6 列重排；内容区高度取卡框扣掉内边距与卡头的全部（976 − 36 − 24 = 916），卡内不留死带；
   overflow-y:auto 即那道纵向滚动条——卡内滚轮滚的是它自己，不是整窗。 */
.${CARD_CLASS}.${EXPANDED_CLASS} .dgc-grid {
  grid-template-columns: repeat(${EXPANDED_COLS}, ${CELL}px);
  width: ${EXPANDED_COLS * CELL + (EXPANDED_COLS - 1) * CELL_GAP}px;
  height: ${EXPANDED_H - 2 * CARD_PAD_Y - HEAD_H}px;
  overflow-y: auto;
  overflow-x: hidden;
}
/* 展开卡压在淡出的卡之上：淡出只改 opacity 与 pointer-events（都不参与布局，卡片矩形不动），
   但叠放次序仍要定下来，否则淡出的卡可能糊在展开卡上面。 */
.${CARD_CLASS}.${EXPANDED_CLASS} { z-index: 2; }
.${CARD_CLASS}.${FADED_CLASS} {
  opacity: 0.06;
  /* 淡出的卡不该再吃点击：指针事件走穿到下面的展开卡/桌面。热区矩形照旧（主进程那侧
     按 getBoundingClientRect 算，opacity 与 pointer-events 都不影响它），但那片区域里
     仍看得见一个极淡的卡，不是「看不见却点得到」的死区。 */
  pointer-events: none;
}
.${CARD_CLASS} .${CELL_CLASS} {
  width: ${CELL}px;
  height: ${CELL}px;
  padding-top: 4px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  overflow: hidden;
  cursor: default;
}
.${CARD_CLASS} .dgc-icon {
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.${CARD_CLASS} .dgc-icon img { width: 48px; height: 48px; object-fit: contain; }
.${CARD_CLASS} .dgc-glyph {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.10);
  color: #d6d6d6;
  font-size: 12px;
  line-height: 44px;
  text-align: center;
}
.${CARD_CLASS} .dgc-name {
  max-width: ${CELL}px;
  font-size: 11px;
  line-height: 13px;
  color: #d6d6d6;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.${CARD_CLASS} .${CELL_CLASS}:hover .dgc-name { color: #fff; }
/* 高亮：outline + 背景色，两者都不参与布局，故高亮不改变卡片的 getBoundingClientRect()——
   「选文件绝不改卡片形状」在样式层也成立，不只是状态层。类名是插件私有的 dgc-selected，
   与内核 .ditem 的选中类名 sel 无关（那条线本插件一根线头都碰不到）。 */
.${CARD_CLASS} .${CELL_CLASS}.${HIGHLIGHT_CLASS} {
  outline: 2px solid rgba(120, 180, 255, 0.9);
  outline-offset: -2px;
  border-radius: 10px;
  background: rgba(120, 180, 255, 0.16);
}
.${CARD_CLASS} .${CELL_CLASS}.${HIGHLIGHT_CLASS} .dgc-name { color: #fff; }
`

/**
 * 组卡的完整样式表 = 底盘 + 工单183 的内联重命名编辑器一段。
 *
 * 单独拆出来是因为编辑器那一段的**作用域根要由本文件给**（CARD_CLASS 出自 interaction.js），
 * 而规则文本住在 writeops.js 的 renameCssOf 里——样式表是一份，作用域根只有一处，两边都不
 * 另写。合起来仍只插**一个** <style>（#181 的「装载后 head 恰有一个子节点」不受影响）。
 */
const CARD_CSS = `${CARD_CSS_BASE}${renameCssOf(CARD_CLASS)}`

/** 本次装载的宿主（unmount 不带参，故在此留一份；装完即用） */
let hostRef = null
/** 文档区装载前的行内 display 原样留档，卸载时原样还回（不假定它本来是空） */
let docZone = null
let docZoneDisplay = ''
/** 图标缓存：iconKey → dataURL；取不到落 null（负缓存，不重试，与内核同纪律） */
const iconCache = new Map()
/** 上一次画出的结构指纹：结构没变就不动 DOM（1Hz 快照别把用户的卡刷没了） */
let drawnKey = ''
/** 本插件画出的卡（卸载时整批摘除） */
const cardNodes = new Map()
/**
 * 卡片级交互态（工单181）：**插件自建**，以卡片 id 为键。
 * 内核选区是渲染层的模块私有变量（main.ts `let selection`）——不导出、不挂 window、
 * 桥接契约表里没有对应方法，且插件是 deck-plugin:// 下的另一套模块图、够不着渲染层源码，
 * 插件没有任何接口可接。故「选中」就是这里的一套自建高亮，不读内核选区、不写内核选区、
 * 也不伪造内核那套 desktop-selected 存证。内核选中态是 `.ditem.sel`，本插件的格子一律不是
 * `.ditem`，两条线互不相干（ADR-0014 已登记「失去内核选区」）。
 *
 * 工单180 起它多担一件事：**全表里谁展开着**由这张表推导（`expandedCardIdOf`），不另设单值——
 * 两个真相来源迟早各记各的。
 */
let cardState = new Map()
/**
 * 本插件插到宿主管之外的节点（样式元素；将来的遮罩同样登记在此）。
 * **按引用登记、按引用摘除**——不靠 id 反查：卸载时手里拿着的正是自己插进去的那个节点，
 * 换代交错也不会摘错。
 */
const injected = []

/**
 * 按引用摘一个自建节点，并把它从登记表里划掉（关菜单只摘菜单那两枚，不动样式表）。
 * @param {Element | null} node
 */
function dropInjected(node) {
  if (!node) return
  const i = injected.indexOf(node)
  if (i >= 0) injected.splice(i, 1)
  node.remove()
}

/**
 * 菜单壳状态（工单182）。归约器（menu.js）拥有它，本文件只负责把效果数组落到 DOM 与宿主上。
 * 世代交换后重新装载一律回到闭态：菜单不该跨代续着开（上一代已经没人负责它的收尾了）。
 */
let menuState = CLOSED_MENU
/** 开层期间挂在 document.body 上的全屏遮罩（按引用持有，关层即摘） */
let overlayNode = null
/** 开层期间挂在文档头的菜单样式元素（与菜单同寿：开层才插，关层即摘） */
let menuStyleNode = null

/**
 * 删除确认层状态（工单183）。归约器（writeops.js）拥有它，本文件只负责把效果数组落到 DOM 与宿主上。
 * 世代交换后重新装载一律回到闭态：确认层不该跨代续着开（上一代已经没人负责它的收尾了）。
 */
let confirmState = CLOSED_CONFIRM
/** 确认层开层期间的全屏遮罩与样式元素（各自按引用持有，关层即摘） */
let confirmOverlayNode = null
let confirmStyleNode = null

/**
 * 内联重命名编辑器状态（工单183）。与确认层一样由归约器拥有；本文件持有的是它落到 DOM 上的
 * 那三枚节点——输入框、给它顶替掉的标签（收场时原样放回），以及输入框所在的格子。
 */
let renameState = CLOSED_RENAME
let renameInputNode = null
let renameLabelNode = null
let renameCellNode = null

// ---------------------------------------------------------------------------
// 组定义（工单185）：本插件自己那份「有哪些自定义卡、临时卡序号到几了」
//
// 存取只走**内核的插件私有状态通道**（工单178 的 plugin-config/get|set，一对桥接方法），
// 落盘由主进程做（合并校验、坏值逐键回退、原子写、体积上限）。插件自己一个文件都不写——
// 那是内核那份实现的职责，两边各写一份迟早在合并策略上分叉。
//
// **命名空间隔离是约定式、不是强制式**：`invoke` 是全表透传的单一 handler，主进程无从分辨
// 调用方，插件 id 由本插件自证。这与面板现有的零护栏状态一致（ADR-0014 Consequences）。
//
// 世代守卫：读定义是异步的，而换代（热重载）可能在读回来之前就把上一代拆了。故每次
// mount/unmount 都换一个世代号，读回来的结果世代对不上就丢弃——否则上一代的组定义会
// 画进新代的卡里。
// ---------------------------------------------------------------------------

/** 当前生效的组定义（内存态；与盘上那一份同步） */
let groupStore = emptyStore()
/** 世代号：换代即 +1，异步读回时用它判断自己是不是上一代 */
let generation = 0

/**
 * 本次装载画出的**卡片归属层**（卡 id → custom / temp / builtin）。
 *
 * 组卡菜单的可见性要判「这张卡手改得动吗」，判据就是它；故这一张表随整排重画重建，
 * 不另设一份真相（菜单那边只读 ctx，不回头来问）。
 */
let cardTierById = new Map()

/**
 * 「接受的类型」勾选浮层状态（工单185）。与另两层一样由归约器（typepicker.js）拥有；
 * 本文件持有的是它落到 DOM 上的那几枚节点。
 */
let typeState = CLOSED_TYPES
let typesOverlayNode = null
let typesStyleNode = null
let typesNameNode = null

/**
 * 本轮快照的桌面项索引（绝对路径 → 项）与格子索引（绝对路径 → 格子节点）。
 *
 * **为什么需要它**：`desktop/rename` 的载荷是 `{ name, to }`——**按名**改，护栏也是 name-keyed；
 * 而菜单冻结的选区只有绝对路径（menu.js 的 MenuCtx.paths）。从路径反推文件名等于在插件侧
 * 重写一遍「桌面项的 name 就是文件名」这条约定，护卫栏一旦有例外就静默改错文件。故从快照里
 * 直接取：条目自己带着 name，一个字都不推。
 * 两张表都随整排重画清空（格节点换了，旧格没有可以依附的实体）。
 */
let itemByPath = new Map()
let cellByPath = new Map()

function injectStyle() {
  // 换代时先按 id 扫掉上一代可能没清干净的那一枚：留着它，装载期就会**静默沿用上一代的旧
  // 样式**，改了 CSS 也不生效（这正是「热重载后不留旧状态」要堵的口子）。扫的是本插件命名
  // 空间下的唯一 id，且装载期不存在并存的另一代（syncPlugins 是先 unmount 后 mount），故安全。
  const stale = document.getElementById(STYLE_ID)
  if (stale) stale.remove()
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CARD_CSS
  document.head.appendChild(style)
  injected.push(style)
}

/** 卸载：把登记过的每一个自建节点摘掉，一个不留 */
function releaseInjected() {
  for (const node of injected.splice(0)) node.remove()
}

/** 藏内核文档区：本插件接管它的活，卸载时原样还回去（内核自身不碰 display，故不会被抢回来） */
function hideDocZone() {
  docZone = document.getElementById('doc-zone')
  if (!docZone) return
  docZoneDisplay = docZone.style.display
  docZone.style.display = 'none'
}

function restoreDocZone() {
  if (!docZone) return
  docZone.style.display = docZoneDisplay
  docZone = null
}

// ---------------------------------------------------------------------------
// 自绘菜单外壳（工单182 = spec166 之⑤）
//
// **不依赖任何其他插件。** 内置上下文菜单插件本机停用（config.json 的 plugins.disabled）、
// 用户可随时关掉，且它挂在 window.deck.ctxMenu 上——那不是任何声明契约的一部分
// （PluginHost / global.d.ts / BridgeMethods 都没有），依赖它等于交付一个开箱即坏的功能。
// 故这里自己画、自己收、自己申报热区。
//
// **全屏热区接管的做法**：开层期间往 document.body 铺一张 `class="card"` 的全屏元素。
// 渲染层的常规热区扫掠就是 `document.querySelectorAll('.card')` 取每个的 getBoundingClientRect，
// 零尺寸矩形被滤掉——故一张铺满视口的 .card 即被声明成全屏热区，主进程那侧 25ms 轮询
// 解掉鼠标穿透，面板在整屏范围内不再穿透（内核自己有同款特例：menuOpen()/trashConfirmOpen()
// 直发全窗矩形；那是内核私有状态，插件够不着，铺一张遮罩就是插件侧的等价物）。
// 撤遮罩后必须**再申报一次**，否则全屏热区会残留到菜单关闭之后。
//
// 关层要一样不漏地收回：遮罩节点、菜单样式元素、窗口 keydown 监听、键盘档。
// ---------------------------------------------------------------------------

/** 行点击：置灰行与未知 id 由归约器挡下（无效果、菜单不收）；此处只保证点击不上浮到遮罩 */
function buildRow(host, row) {
  const el = document.createElement('div')
  el.className = row.enabled ? ROW_CLASS : `${ROW_CLASS} ${DISABLED_CLASS}`
  el.dataset.row = row.id
  el.textContent = row.label
  el.addEventListener('click', (ev) => {
    ev.stopPropagation() // 行点击到此为止：绝不外溢到遮罩的「菜单外点击」
    dispatchMenu(host, { type: 'activate', id: row.id })
  })
  return el
}

/**
 * 铺一张全屏热区接管面（工单182 起，菜单与删除确认层共用同一份做法）。
 *
 * 插件侧要「菜单开着时整屏不穿透」，唯一的通用入口就是往 document.body 铺一张 `class="card"`
 * 的全屏元素：渲染层的常规热区扫掠是 `document.querySelectorAll('.card')` 取每个的
 * getBoundingClientRect()，铺满视口的一张即被声明成全屏热区，主进程那侧 25ms 轮询解掉鼠标穿透。
 * （内核自己有同款特例：`menuOpen()/trashConfirmOpen()` 直发全窗矩形；那是内核私有状态，
 * 插件够不着，铺一张遮罩就是插件侧的等价物。）
 *
 * 几何全部写成**内联样式**：热区取的是 getBoundingClientRect()，内联数字与算式同源才不会出现
 * 「按 A 算、按 B 画」。`.card` 底盘带来的圆角/边框/内边距/底色对一张遮罩全是多余的，用内联
 * 样式逐条中和（内联压得过面板样式表的 `.card`）。
 *
 * @param {string} id 热区身份（扫掠对重复 id **不去重**，故每张遮罩各取唯一）
 * @param {string} cssClass 遮罩根类名（确认层/菜单各自的作用域根，不共用）
 * @param {number} zIndex 叠放次序：必须高于展开卡自带的 z-index:2（工单180）
 * @returns {HTMLElement}
 */
function newOverlay(id, cssClass, zIndex) {
  const overlay = document.createElement('div')
  overlay.id = id
  // class='card' 是热区扫掠唯一的通用入口，不挂则整屏仍穿透
  overlay.className = `card ${cssClass}`
  overlay.style.left = '0px'
  overlay.style.top = '0px'
  overlay.style.width = `${window.innerWidth}px`
  overlay.style.height = `${window.innerHeight}px`
  overlay.style.padding = '0'
  overlay.style.border = 'none'
  overlay.style.borderRadius = '0'
  overlay.style.background = 'transparent'
  overlay.style.zIndex = String(zIndex)
  return overlay
}

/** 铺菜单：全屏遮罩 + 菜单面板 + 行表 + 两个接管面（遮罩上的菜单外点击、窗口上的 Esc）。
 *
 * 遮罩与面板的几何都按 menu.js 算出的数写**内联样式**：热区取的是 getBoundingClientRect()，
 * 内联数字与纯模块的算式同源才不会出现「钳制按 A、画出来是 B」。
 */
function showMenu(host, rows, box) {
  hideMenu() // 重开不留两层：上一轮若有残留，先原样收干净

  const style = document.createElement('style')
  style.id = MENU_STYLE_ID
  style.textContent = MENU_CSS
  document.head.appendChild(style)
  injected.push(style)
  menuStyleNode = style

  const overlay = newOverlay(OVERLAY_ID, OVERLAY_CLASS, 1000)

  const panel = document.createElement('div')
  panel.id = PANEL_ID
  panel.className = PANEL_CLASS
  panel.style.left = `${box.left}px`
  panel.style.top = `${box.top}px`
  panel.style.width = `${box.width}px`
  panel.style.height = `${box.height}px`
  for (const row of rows) panel.appendChild(buildRow(host, row))
  overlay.appendChild(panel)

  // 菜单外点击由遮罩接管（真菜单同款）。面板自身的留白**不**收起：那一击不是「菜单外」，
  // 收起它只会让用户想瞄准某一行时手一抖就丢了菜单。
  overlay.addEventListener('click', (ev) => {
    if (panel.contains(ev.target)) return
    ev.stopPropagation()
    dispatchMenu(host, { type: 'dismiss', reason: 'outside' })
  })

  document.body.appendChild(overlay)
  injected.push(overlay)
  overlayNode = overlay
  window.addEventListener('keydown', onMenuKeydown)
}

/** 关层：遮罩、菜单样式、窗口监听一起收，登记项也从表里划掉（关层后屏幕上一点不留） */
function hideMenu() {
  window.removeEventListener('keydown', onMenuKeydown)
  dropInjected(overlayNode)
  dropInjected(menuStyleNode)
  overlayNode = null
  menuStyleNode = null
}

/**
 * Esc 收起。键盘档已由开层时的 `holdKeyboardTier` 持拿——窗口因此可聚焦，Esc 才送得到这里
 * （内核的 Esc 定序把「插件档在持」等同浮层开，故键盘那段捕获监听会放行不拦，本监听是唯一处置处）。
 */
function onMenuKeydown(ev) {
  if (!hostRef || ev.key !== 'Escape') return
  ev.preventDefault()
  ev.stopPropagation()
  dispatchMenu(hostRef, { type: 'esc' })
}

// ---------------------------------------------------------------------------
// 删除确认层（工单183 = spec166 之⑥）
//
// 内核那份确认层的**显示逻辑**是渲染层的模块私有闭包（main.ts 的 openTrashConfirm/
// closeTrashConfirm），取不到，故自建一层。**删除动作本身不是自建**：确认之后一律走内核既有
// 契约 desktop/trash —— 回收站语义、扫描池全有全无护栏、清理摆位存证、失败明细，全部保留。
// 本层只回答「用户确认了吗」，不碰任何落盘的事。
//
// 遮罩与菜单遮罩同一套热区接管做法（newOverlay），但**各取唯一 id**：热区扫掠对重复 id 不去重。
// ---------------------------------------------------------------------------

/**
 * 铺确认层：全屏遮罩 + 居中对话框 + 文案 + 确认/取消两钮 + 两个接管面（层外点击取消、Esc 取消）。
 * 对话框的落位与尺寸按 writeops.js 算出的数写内联样式（存证里报的按钮矩形与用户真点到的那一枚
 * 必须是同一个盒子，故落位与画法同源）。
 */
function showConfirm(host, mode, names, box) {
  hideConfirm() // 重开不留两层

  const style = document.createElement('style')
  style.id = CONFIRM_STYLE_ID
  style.textContent = CONFIRM_CSS
  document.head.appendChild(style)
  injected.push(style)
  confirmStyleNode = style

  const overlay = newOverlay(CONFIRM_OVERLAY_ID, CONFIRM_OVERLAY_CLASS, 1001)

  const dialog = document.createElement('div')
  dialog.id = CONFIRM_BOX_ID
  dialog.className = CONFIRM_BOX_CLASS
  dialog.style.left = `${box.left}px`
  dialog.style.top = `${box.top}px`
  dialog.style.width = `${box.width}px`
  dialog.style.height = `${box.height}px`

  const text = document.createElement('div')
  text.id = CONFIRM_TEXT_ID
  text.className = CONFIRM_TEXT_CLASS
  // white-space: pre-wrap，故标题与文件名清单用换行拼在一处（与内核确认层同款排版）
  text.textContent = `${confirmTitleOf(names, mode)}\n${names.join('\n')}`
  dialog.appendChild(text)

  const ok = document.createElement('div')
  ok.id = CONFIRM_OK_ID
  ok.className = CONFIRM_OK_CLASS
  // 钮上的字与标题同源：解散时写 DISSOLVE，不写 DELETE（那会骗用户以为要删文件）
  ok.textContent = confirmOkLabelOf(mode)
  ok.addEventListener('click', (ev) => {
    ev.stopPropagation() // 钮自己处置，不外溢到遮罩的「层外点击」（否则确认一次变取消一次）
    dispatchConfirm(host, { type: 'confirm' })
  })

  const cancel = document.createElement('div')
  cancel.id = CONFIRM_CANCEL_ID
  cancel.className = CONFIRM_CANCEL_CLASS
  cancel.textContent = 'CANCEL'
  cancel.addEventListener('click', (ev) => {
    ev.stopPropagation()
    dispatchConfirm(host, { type: 'cancel', reason: 'button' })
  })

  dialog.append(ok, cancel)
  overlay.appendChild(dialog)

  // 层外点击 = 取消（内核删除确认层同款：捕获段恰吞一笔，那一击不落任何面板语义）
  overlay.addEventListener('click', (ev) => {
    if (dialog.contains(ev.target)) return
    ev.stopPropagation()
    dispatchConfirm(host, { type: 'outside' })
  })

  document.body.appendChild(overlay)
  injected.push(overlay)
  confirmOverlayNode = overlay
  window.addEventListener('keydown', onConfirmKeydown)
}

/** 关层：遮罩、样式、窗口监听一起收，登记项也从表里划掉 */
function hideConfirm() {
  window.removeEventListener('keydown', onConfirmKeydown)
  dropInjected(confirmOverlayNode)
  dropInjected(confirmStyleNode)
  confirmOverlayNode = null
  confirmStyleNode = null
}

function onConfirmKeydown(ev) {
  if (!hostRef || ev.key !== 'Escape') return
  ev.preventDefault()
  ev.stopPropagation()
  dispatchConfirm(hostRef, { type: 'esc' })
}

/** 一个事件一次合成：状态交给 writeops.js 的归约器，效果数组按序落到宿主与 DOM 上 */
function dispatchConfirm(host, event) {
  if (!host) return
  const next = nextConfirmLayer(confirmState, event, { width: window.innerWidth, height: window.innerHeight })
  confirmState = next.state
  for (const fx of next.effects) {
    if (fx.kind === 'tier') {
      // 键盘档是「让位」不是「抢占」：持档期间内核六键路由与 Esc 拦截双双让开（keyboard-gate 的
      // keyRoutingContextOf 把插件档在持等同浮层在即）。档不放窗口就一直可聚焦，故每路收起都放。
      if (fx.held) host.holdKeyboardTier(CONFIRM_KEYBOARD_TIER)
      else host.releaseKeyboardTier(CONFIRM_KEYBOARD_TIER)
    } else if (fx.kind === 'show') {
      showConfirm(host, fx.mode, fx.names, fx.box)
    } else if (fx.kind === 'hide') {
      hideConfirm()
    } else if (fx.kind === 'run') {
      if (fx.op === 'dissolve') {
        // 解散：**只删组定义，一个 desktop/* 契约都不发**（磁盘零移动是这条分支的形状事实）
        doDissolve(host, fx.cardId)
      } else {
        // 唯一的落盘动作出口：送回收站，内核既有契约，插件不自己 shell.trashItem
        void host.invoke('desktop/trash', { paths: [...fx.paths] })
      }
    } else if (fx.kind === 'hotzones') {
      // 热区纪律：遮罩一铺一撤都改了矩形，两个方向都要让渲染层重扫
      host.onDomChanged()
    } else if (fx.kind === 'notify') {
      host.notify(fx.type, fx.payload)
    }
  }
}

/** 从菜单的 DELETE 行进来：把绝对路径换成本轮快照里的显示名（开层时冻结的清单） */
function openConfirm(host, paths) {
  if (!paths.length) return
  dispatchConfirm(host, { type: 'open', mode: CONFIRM_MODE_TRASH, names: namesOf(paths), paths })
}

// ---------------------------------------------------------------------------
// 解散（工单186）与粘贴（工单186）
//
// 两者是同一件事的两面：**都只改归属、都不动磁盘上的文件**（ADR-0014：组卡是归属概念，不是
// 目录）。区别只在改哪一份归属：
//   - 解散：从组定义里**删掉**一张卡。落盘动作只有一次 plugin-config/set（写的是插件自己的
//     私有状态），**零个 desktop/* 契约调用**——没有一个内核契约能搬文件，也一个都没发。
//   - 粘贴：先由内核既有契约 desktop/paste 落文件（落点固定用户桌面根、无参，插件控制不了
//     物理去向），再把落地的那些文件名**记进**组定义。文件是内核放的，插件只是给它一个归属。
// ---------------------------------------------------------------------------

/** 组定义里那张卡的定义与归属层（自定义卡 / 临时卡 / 不在组定义里——后者是固有扩展组卡） */
function cardDefOf(cardId) {
  const temp = groupStore.temps.find((t) => t.id === cardId)
  if (temp) return { def: temp, kind: TIER_TEMP }
  const group = groupStore.groups.find((g) => g.id === cardId)
  return group ? { def: group, kind: TIER_CUSTOM } : { def: null, kind: '' }
}

/**
 * 从菜单的 DISSOLVE 行进来：过确认层（**先问过用户**，与 DELETE 同一副壳）。
 *
 * 清单是「卡名 + 卡内此刻的文件名」，开层时冻结。卡内文件取自本轮渲染结果（归属的求值结果），
 * 而不是从卡面标签反推——一个字节都不猜。
 *
 * **固有扩展组卡到不了这里**：菜单那一行的 visibleWhen 挡掉了（它没有定义可删，是规则算出来的）。
 * 这一层仍兜一道：拿不到定义就如实上报，绝不开一只没有目标的确认层。
 * @param {Host} host
 * @param {string} cardId
 */
function openDissolveConfirm(host, cardId) {
  const { def } = cardDefOf(cardId)
  if (!def) {
    host.notify(CONFIRM_OPENED_NOTIFY, { ok: false, mode: CONFIRM_MODE_DISSOLVE, error: '这张卡不在当前组定义里', cardId })
    return
  }
  const members = membersOfCard(cardId)
  dispatchConfirm(host, {
    type: 'open',
    mode: CONFIRM_MODE_DISSOLVE,
    cardId,
    names: [def.name, ...members.map((item) => item.name)],
    paths: members.map((item) => item.path),
  })
}

/** 那张卡此刻装着的条目（归属的求值结果，不是任何一份记着的表——那张表不存在） */
function membersOfCard(cardId) {
  const desktop = hostRef && hostRef.view.desktop
  const cards = buildCards(desktop ? desktop.items : [], groupStore)
  const card = cards.find((c) => c.id === cardId)
  return card ? card.items : []
}

/**
 * 确认之后的那一步：删掉这张卡的定义，然后**什么都不做**。
 *
 * 卡内文件按扩展名回落固有分组是 `buildCards` 的**结构后果**（归属是定义的函数），不是一段
 * 要单独同步的逻辑；磁盘上的文件一个字节都没动，故这里没有任何 desktop/* 调用。
 * @param {Host} host
 * @param {string} cardId
 */
function doDissolve(host, cardId) {
  const next = dissolveGroup(groupStore, cardId)
  if (!next.dissolved) {
    host.notify(GROUPS_SAVED_NOTIFY, { ok: false, error: '这张卡不在当前组定义里', cardId })
    return
  }
  saveGroups(host, next.store)
}

/**
 * 粘贴：先问内核要剪贴板里的文件落在哪儿（desktop/paste，**无参**，落点固定用户桌面根），
 * 再把落地的那些文件名按三态路由记进组定义（pasting.js 的纯裁决）。
 *
 * **插件控制不了物理去向**，所以「存放」只是归属：文件在桌面根原地不动，插件只决定它归哪张卡。
 * @param {Host} host
 * @param {string} cardId 用户点的那张卡（空串 = 不针对任何卡，走自动路由）
 */
async function doPaste(host, cardId) {
  const mine = generation
  /** @type {{ ok?: boolean, pasted?: unknown, failed?: unknown, error?: unknown } | null} */
  let response = null
  try {
    response = await Promise.resolve(host.invoke('desktop/paste', null))
  } catch (err) {
    if (generation === mine) {
      host.notify(PASTE_FAILED_NOTIFY, { ok: false, error: err instanceof Error ? err.message : String(err) })
    }
    return
  }
  if (generation !== mine || hostRef !== host) return // 换代途中回来的是上一代的请求，丢弃
  const names = pastedNamesOf(response)
  const failed = response && Array.isArray(response.failed) ? response.failed.map(String) : []
  if (!names.length) {
    // 一个文件都没落地：不为一个空的批次建卡（否则凭空多一张永远空的临时卡）
    host.notify(PASTE_FAILED_NOTIFY, {
      ok: false,
      error: response && typeof response.error === 'string' ? response.error : '剪贴板里没有可粘贴的文件',
      failed,
    })
    return
  }
  const route = routePaste(groupStore, names, { nowMs: Date.now(), intoCardId: cardId })
  host.notify(PASTE_ROUTED_NOTIFY, {
    ok: true,
    kind: route.kind,
    cardId: route.targetCardId,
    pasted: names,
    merged: route.mergeCardIds,
    tempCard: route.tempCard ? { id: route.tempCard.id, name: route.tempCard.name, seq: route.tempCard.seq } : null,
    failed,
  })
  // 组定义没变就不落盘（并入自定义卡那一态：成员是定义的函数，一个字节都不必写）
  if (route.changed) saveGroups(host, route.store)
  else render(host)
}

/** 绝对路径 → 快照里的显示名。快照里查不到（菜单开着的那一拍文件刚好没了）时退回路径末段，
 *  那只影响**文案**；真正决定送不送回收站的是内核的扫描池护栏，不是这段文本。 */
function namesOf(paths) {
  return paths.map((p) => {
    const item = itemByPath.get(p)
    if (item) return item.display || item.name
    const cut = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
    return cut >= 0 ? p.slice(cut + 1) : p
  })
}

// ---------------------------------------------------------------------------
// 内联重命名编辑器（工单183）
//
// 内核那份编辑器（main.ts 的 beginRename/createRenameInput）同样取不到，故自建。提交走内核
// 既有契约 desktop/rename，**命名校验不在本插件重写**：Win32 合法名、同名幂等、大小写改名
// 豁免、冲突拒绝，都是内核那条 switch 的事。
//
// **焦点怎么接住**：宿主与桥接契约里**没有任何「聚焦某个元素」的 API**。面板自己的做法是
// 「先让窗口可聚焦，再 input.focus()」——第一步就是键盘档（工单100：档在持 → 键盘模式开 →
// 主进程 setFocusable(true)+focus()）。故本层的效果数组把「档先持」排在「建 DOM」之前，
// showRename 里再 focus()，顺序反了焦点就落空。档名自由，宿主按插件 id 加命名空间。
// ---------------------------------------------------------------------------

/**
 * 铺编辑器：在格子里**原地**顶替文件名标签。
 *
 * 输入框宽度写死成 CELL——与 `.dgc-name` 的 max-width 同一个来源，于是编辑器开关前后卡框的
 * 内联几何一个字没变，热区扫掠读到的 getBoundingClientRect() 也就没变，故**不申报热区**
 * （工单181 的纪律：申报当且仅当矩形变了）。
 */
function showRename(host, fx) {
  const cell = cellByPath.get(fx.path)
  const label = cell ? findLabelIn(cell) : null
  if (!cell || !label) return // 格已被整排重画摘掉：无从原地编辑（归约器状态随后被 cancel 清掉）
  const input = document.createElement('input')
  input.type = 'text'
  input.maxLength = 255
  input.className = RENAME_INPUT_CLASS
  input.spellcheck = false
  input.setAttribute('autocomplete', 'off')
  input.style.width = `${CELL}px`
  input.value = fx.value
  label.replaceWith(input)

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault()
      ev.stopPropagation()
      // 草稿以输入框为真相：状态里那份 draft 只是开层时的初稿，用户敲的每一个字都在这里
      renameState = renameState.open ? { ...renameState, draft: input.value } : renameState
      dispatchRename(host, { type: 'submit' })
    } else if (ev.key === 'Escape') {
      ev.preventDefault()
      ev.stopPropagation()
      dispatchRename(host, { type: 'esc' })
    }
  })

  // 焦点两步走：键盘档已在效果数组的前一步持拿（窗口此刻可聚焦），这里才落得到输入框上
  input.focus()
  // 预选扩展名之前的部分（与内核 rename 编辑器同款：改名时最该被选中的是「名字」不是「后缀」）
  if (typeof input.setSelectionRange === 'function') input.setSelectionRange(0, fx.stem)
  else input.select()

  renameInputNode = input
  renameLabelNode = label
  renameCellNode = cell
}

/** 收场：把标签原样放回格子（文案不动——快照是权威，重命名成功后下一拍自然会换新名） */
function hideRename() {
  if (renameInputNode && renameLabelNode) {
    renameInputNode.replaceWith(renameLabelNode)
  } else if (renameInputNode) {
    renameInputNode.remove()
  }
  renameInputNode = null
  renameLabelNode = null
  renameCellNode = null
}

function dispatchRename(host, event) {
  if (!host) return
  const next = nextRenameEditor(renameState, event)
  renameState = next.state
  for (const fx of next.effects) {
    if (fx.kind === 'tier') {
      if (fx.held) host.holdKeyboardTier(RENAME_KEYBOARD_TIER)
      else host.releaseKeyboardTier(RENAME_KEYBOARD_TIER)
    } else if (fx.kind === 'show') {
      showRename(host, fx)
    } else if (fx.kind === 'hide') {
      hideRename()
    } else if (fx.kind === 'run') {
      void host.invoke('desktop/rename', { name: fx.name, to: fx.to })
    } else if (fx.kind === 'notify') {
      host.notify(fx.type, fx.payload)
    }
  }
}

/** 从菜单的 RENAME 行进来：条目身份取自本轮快照（desktop/rename 是按名改的，名字不能反推） */
function openRename(host, paths) {
  const item = itemByPath.get(paths[0])
  if (!item) {
    // 快照里没有这一件（菜单开着的那一拍它没了）：无从编辑，如实上报而不是猜一个名字去改盘
    host.notify(RENAME_OPENED_NOTIFY, { error: '条目已不在当前快照中', path: paths[0] })
    return
  }
  // 已在编辑别的一件时先收场再开新的（菜单层可能罩在上面），否则新 open 会被归约器的「不重入」挡下，
  // 用户点了 RENAME 却毫无反应。
  if (renameState.open) dispatchRename(host, { type: 'cancel', reason: 'reopen' })
  dispatchRename(host, { type: 'open', name: item.name, path: item.path, display: item.display || item.name })
}

/** 格子里的文件名标签（`.dgc-name`）：编辑器顶替的就是它 */
function findLabelIn(cell) {
  for (const node of walkIn(cell)) if (node.classList.contains('dgc-name')) return node
  return null
}

/** 深度优先列出子元素（含自身）——只在画卡时用一次找标签，故自己带一份而不必引第三方 */
function walkIn(root, out = []) {
  out.push(root)
  for (const c of root.children) walkIn(c, out)
  return out
}

// ---------------------------------------------------------------------------
// 组定义的存取（工单185）
//
// **只经内核的插件私有状态通道**（工单178：`plugin-config/get` {id} → {config, warnings}、
// `plugin-config/set` {id, patch} → {config, warnings}）。落盘位置、合并校验、坏值逐键回退、
// 原子写、体积上限全是主进程那份实现的职责——插件一个文件都不自己写，也不在渲染层碰盘。
//
// 整份定义放**一个**键（STORE_KEY）里：一次写 = 一次原子写。拆成「组表」「计数器」两个键，
// 就会出现「组表写成功、计数器写失败」的半份状态，而计数器退回去就是 `临时 01` 撞名。
//
// 读不到定义不是致命的：给空状态照常画固有卡（用户一张自定义卡还没建过时本就是空状态），
// 但要把失败如实上报，而不是静默当空——否则用户建过卡、读失败、卡全散了他还不知道原因。
// ---------------------------------------------------------------------------

/**
 * 读回本插件的组定义（异步）。世代对不上就放弃——上一代的读回不该画进新代的卡里。
 * @param {Host} host
 */
async function loadGroups(host) {
  const mine = generation
  let response = null
  try {
    response = await host.invoke('plugin-config/get', { id: PLUGIN_ID })
  } catch (err) {
    if (generation !== mine) return
    host.notify(GROUPS_LOADED_NOTIFY, { ok: false, error: err instanceof Error ? err.message : String(err) })
    return
  }
  if (generation !== mine) return
  groupStore = storeOf(response)
  const warnings = response && typeof response === 'object' ? /** @type {{ warnings?: string[] }} */ (response).warnings : null
  host.notify(GROUPS_LOADED_NOTIFY, {
    ok: true,
    groups: groupStore.groups.length,
    temps: groupStore.temps.length,
    nextSeq: groupStore.nextSeq,
    warnings: warnings && warnings.length ? warnings : undefined,
  })
  // 定义变了就重画整排：归属是定义的函数（组卡是归属概念，不是目录——磁盘上的文件一个都不动）
  if (hostRef) render(hostRef)
}

/**
 * 落盘一次组定义。内核归一之后的那一份才是权威，故以它为准接回内存。
 *
 * 调用方已经先把新定义落到内存并重画过（界面不等磁盘）；这里落完盘再接回来，通常结构指纹
 * 没变故整排原样不动（1Hz 快照不会因此把用户的卡刷没了）。
 * @param {Host} host
 * @param {GroupStore} next
 */
function saveGroups(host, next) {
  groupStore = next
  render(host)
  void Promise.resolve(host.invoke('plugin-config/set', { id: PLUGIN_ID, patch: { [STORE_KEY]: next } })).then(
    (response) => {
      if (!hostRef) return
      groupStore = storeOf(response ?? next)
      host.notify(GROUPS_SAVED_NOTIFY, { groups: groupStore.groups.length, nextSeq: groupStore.nextSeq })
      render(hostRef)
    },
    (err) => {
      // 落盘失败就如实上报：内存里已经是新定义（界面照新定义画），但盘上还是旧的
      host.notify(GROUPS_SAVED_NOTIFY, { ok: false, error: err instanceof Error ? err.message : String(err) })
    },
  )
}

// ---------------------------------------------------------------------------
// 「接受的类型」勾选浮层（工单185）
//
// 第三块自绘浮层（菜单、删除确认层之后）。**遮罩与那两块同一套热区接管做法**（newOverlay），
// 但**各取唯一 id**——热区扫掠对重复 id 不去重。铺一张铺满视口的 .card 即全屏热区，
// 撤掉必须**再申报一次**（两个方向都改矩形，故 open/hide 各发一次 hotzones 效果）。
//
// 焦点两步走：效果数组里**档先持**（窗口因此可聚焦），show 里才 focus，顺序反了焦点落空。
// 宿主与桥接契约里没有任何「聚焦某个元素」的 API，故这两步缺一不可。
// ---------------------------------------------------------------------------

/**
 * 铺浮层：全屏遮罩 + 居中盒子 + 名字输入（仅 NEW GROUP）+「接受全部类型」开关 + 类型清单 + 两钮。
 *
 * 盒子的落位与尺寸按 typepicker.js 算出的数写内联样式（热区与存证矩形取 getBoundingClientRect()，
 * 落位算式与画法必须同源）。
 */
function showTypes(host, fx) {
  hideTypes() // 重开不留两层

  const style = document.createElement('style')
  style.id = TYPE_STYLE_ID
  style.textContent = TYPE_PICKER_CSS
  document.head.appendChild(style)
  injected.push(style)
  typesStyleNode = style

  const overlay = newOverlay(TYPE_OVERLAY_ID, TYPE_OVERLAY_CLASS, 1002)
  const box = document.createElement('div')
  box.id = TYPE_BOX_ID
  box.className = TYPE_BOX_CLASS
  box.style.left = `${fx.box.left}px`
  box.style.top = `${fx.box.top}px`
  box.style.width = `${fx.box.width}px`
  box.style.height = `${fx.box.height}px`

  if (fx.mode === 'create') {
    const name = document.createElement('input')
    name.type = 'text'
    name.id = TYPE_NAME_ID
    name.className = TYPE_NAME_CLASS
    name.maxLength = 40
    name.spellcheck = false
    name.setAttribute('autocomplete', 'off')
    name.setAttribute('placeholder', 'CARD NAME')
    name.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault()
        ev.stopPropagation()
        dispatchTypes(host, { type: 'submit' }) // 草稿由 dispatchTypes 统一从输入框读回
      }
    })
    box.appendChild(name)
    typesNameNode = name
  }

  // 「接受全部类型」开关在顶部：宽卡不必逐个勾
  const all = document.createElement('div')
  all.id = TYPE_ALL_ID
  all.className = TYPE_ALL_CLASS
  const allMark = document.createElement('span')
  allMark.className = TYPE_BOX_MARK_CLASS
  allMark.textContent = typeState.acceptAll ? '☑' : '☐'
  const allLabel = document.createElement('span')
  allLabel.textContent = 'ACCEPT ALL TYPES'
  all.append(allMark, allLabel)
  all.addEventListener('click', (ev) => {
    ev.stopPropagation()
    dispatchTypes(host, { type: 'toggle-all' })
  })
  box.appendChild(all)

  // 类型清单：桌面上此刻真实存在的扩展名逐个勾（不存在的类型不列——列了也没文件可放）
  const list = document.createElement('div')
  list.id = TYPE_LIST_ID
  list.className = TYPE_LIST_CLASS
  for (const row of fx.present) {
    const line = document.createElement('div')
    line.className = TYPE_ROW_CLASS
    line.dataset.ext = row.ext
    const mark = document.createElement('span')
    mark.className = TYPE_BOX_MARK_CLASS
    mark.textContent = checkedOf(typeState, row.ext) ? '☑' : '☐'
    const text = document.createElement('span')
    text.textContent = row.label
    line.append(mark, text)
    line.addEventListener('click', (ev) => {
      ev.stopPropagation()
      dispatchTypes(host, { type: 'toggle', ext: row.ext })
    })
    list.appendChild(line)
  }
  box.appendChild(list)

  const ok = document.createElement('div')
  ok.id = TYPE_OK_ID
  ok.className = TYPE_OK_CLASS
  ok.textContent = fx.mode === 'create' ? 'CREATE' : 'SAVE'
  ok.addEventListener('click', (ev) => {
    ev.stopPropagation()
    dispatchTypes(host, { type: 'submit' })
  })

  const cancel = document.createElement('div')
  cancel.id = TYPE_CANCEL_ID
  cancel.className = TYPE_CANCEL_CLASS
  cancel.textContent = 'CANCEL'
  cancel.addEventListener('click', (ev) => {
    ev.stopPropagation()
    dispatchTypes(host, { type: 'cancel', reason: 'button' })
  })
  box.append(ok, cancel)
  overlay.appendChild(box)

  // 层外点击 = 取消（与删除确认层同款：那一击不落任何面板语义）。盒子自身的留白**不**取消。
  overlay.addEventListener('click', (ev) => {
    if (box.contains(ev.target)) return
    ev.stopPropagation()
    dispatchTypes(host, { type: 'outside' })
  })

  document.body.appendChild(overlay)
  injected.push(overlay)
  typesOverlayNode = overlay
  window.addEventListener('keydown', onTypesKeydown)

  // 焦点两步走：键盘档已在效果数组的前一步持拿（窗口此刻可聚焦），这里才落得到输入框上
  if (typesNameNode) {
    typesNameNode.value = fx.name
    typesNameNode.focus()
  }
}

/** 关层：遮罩、样式、窗口监听一起收，登记项也从表里划掉（关层后屏幕上一点不留） */
function hideTypes() {
  window.removeEventListener('keydown', onTypesKeydown)
  dropInjected(typesOverlayNode)
  dropInjected(typesStyleNode)
  typesOverlayNode = null
  typesStyleNode = null
  typesNameNode = null
}

/** 名字输入框开着时，把框里的文本读回状态（草稿以 DOM 为真相；关着则无事可做） */
function syncTypesDraft() {
  if (typesNameNode && typeState.open && typeState.name !== typesNameNode.value) {
    typeState = { ...typeState, name: typesNameNode.value }
  }
}

/** 只改状态的那几类事件（勾一项、切开关、改名）没有 show 效果，但勾号与草稿得跟上——
 * 故自己重画浮层本体。落位尺寸在重画时按当前状态重算（清单没变则尺寸不变）。
 */
function repaintTypes(host) {
  if (!typesOverlayNode || !typeState.open) return
  showTypes(host, {
    mode: typeState.mode,
    cardId: typeState.cardId,
    label: typeState.label,
    name: typeState.name,
    acceptAll: typeState.acceptAll,
    present: typeState.present,
    checked: typeState.picked,
    box: typePickerBoxFor(typeState),
  })
}

function onTypesKeydown(ev) {
  if (!hostRef || ev.key !== 'Escape') return
  ev.preventDefault()
  ev.stopPropagation()
  dispatchTypes(hostRef, { type: 'esc' })
}

/**
 * 一个事件一次合成：状态交给 typepicker.js 的归约器，效果数组按序落到宿主与 DOM 上。
 *
 * **草稿以输入框为真相**（与工单183 的内联重命名编辑器同纪律）：状态里那份 name 只是开层时的
 * 初稿，用户敲的每一个字都在 DOM 的输入框上。故每个事件进来先把它读回来——不然点 CREATE 会
 * 拿空名去建卡，勾一项触发重画还会把已敲的名字抹掉。
 */
function dispatchTypes(host, event) {
  if (!host) return
  syncTypesDraft()
  const next = nextTypePicker(typeState, event, { width: window.innerWidth, height: window.innerHeight })
  typeState = next.state
  const painted = next.effects.some((fx) => fx.kind === 'show' || fx.kind === 'hide')
  for (const fx of next.effects) {
    if (fx.kind === 'tier') {
      // 键盘档是「让位」不是「抢占」：持档期间内核六键路由与 Esc 拦截双双让开。档不放窗口就一直
      // 可聚焦，故每一路收起都必须放，卸载亦然。
      if (fx.held) host.holdKeyboardTier(TYPE_KEYBOARD_TIER)
      else host.releaseKeyboardTier(TYPE_KEYBOARD_TIER)
    } else if (fx.kind === 'show') {
      showTypes(host, fx)
    } else if (fx.kind === 'hide') {
      hideTypes()
    } else if (fx.kind === 'run') {
      // 唯一的落库出口：两条动作都只改**定义**，归属随后由定义重算（磁盘上的文件一个都不动）
      if (fx.op === 'create-group') {
        saveGroups(host, addCustomGroup(groupStore, { name: fx.name, exts: fx.exts, acceptAll: fx.acceptAll }).store)
      } else {
        saveGroups(host, editCustomGroupTypes(groupStore, fx.cardId, { exts: fx.exts, acceptAll: fx.acceptAll }))
      }
    } else if (fx.kind === 'hotzones') {
      // 热区纪律：遮罩一铺一撤都改了矩形，两个方向都要让渲染层重扫
      host.onDomChanged()
    } else if (fx.kind === 'notify') {
      host.notify(fx.type, fx.payload)
    }
  }
  if (!painted && typeState.open) repaintTypes(host)
}

/** 桌面上此刻真实存在的扩展名清单（勾选浮层逐个勾的就是它；空快照也给空清单，不抛） */
function presentTypes() {
  const desktop = hostRef ? hostRef.view.desktop : null
  return presentExtensionsOf(desktop ? desktop.items : [])
}

/** 浮层盒子按当前状态重算落位（重画浮层本体时用；算式与 typepicker.js 同一处） */
function typePickerBoxFor(state) {
  return typePickerBoxOf(
    { width: window.innerWidth, height: window.innerHeight },
    { present: state.present, mode: state.mode },
  )
}

/**
 * 行动作：一律经内核既有桥接契约调用，插件自己不碰 shell、不碰剪贴板。
 * 与内核单项菜单（工单24）走同一批契约：
 *   OPEN → desktop/launch（带扫描池护栏：不在扫描池内即 {ok:false}，不抛）
 *   OPEN LOCATION → desktop/reveal（explorer /select, 内核执行，面板不写磁盘）
 *   COPY PATH → desktop/copy-path（主进程写文本剪贴板；面板 focusable:false，
 *              渲染层 navigator.clipboard 用不上，故只能走这条）
 *   COPY → desktop/clipboard-copy（CF_HDROP + Preferred DropEffect=copy）
 *   CUT  → desktop/clipboard-cut （同格式，拖放效果 = move，即搬移语义）
 *
 * 两个写动作（工单183）**不在这里落盘**，只开层：RENAME 开内联编辑器、DELETE 开删除确认层，
 * 真正调用发生在各自的归约器 emit `run` 效果之后。故此处 runMenuRow 对它们**一行契约调用都
 * 不发**——「先问过用户」是这两行的全部语义。
 * @param {Host} host
 * @param {string} id 行 id
 * @param {readonly string[]} paths 开层时冻结的选区
 * @param {string} cardId 开层时冻结的来源卡片 id（组卡菜单用；工单185 的行按它判卡片身份）
 */
function runMenuRow(host, id, paths, cardId = '') {
  const one = paths[0]
  host.notify(MENU_ACTION_NOTIFY, { row: id, paths: [...paths], cardId })
  switch (id) {
    case 'open':
      void host.invoke('desktop/launch', { path: one })
      return
    case 'open-location':
      void host.invoke('desktop/reveal', { path: one })
      return
    case 'copy-path':
      void host.invoke('desktop/copy-path', { path: one })
      return
    case 'copy':
      void host.invoke('desktop/clipboard-copy', { paths })
      return
    case 'cut':
      void host.invoke('desktop/clipboard-cut', { paths })
      return
    case 'rename':
      openRename(host, paths)
      return
    case 'delete':
      openConfirm(host, paths)
      return
    case 'new-group':
      // NEW GROUP：开勾选浮层（建卡模式要起名 + 勾类型）。此处一个字节都不落库——
      // 「先问过用户」是这一行的全部语义，落库发生在浮层 submit 之后。
      if (typeState.open) dispatchTypes(host, { type: 'cancel', reason: 'reopen' })
      dispatchTypes(host, { type: 'create', present: presentTypes() })
      return
    case 'edit-types':
      openEditTypes(host, cardId)
      return
    case 'paste':
      // PASTE：一个字节都不在这里落。落文件走内核 desktop/paste（唯一动磁盘的一步，且落点固定
      // 用户桌面根、插件无从选择）；归属由 pasting.js 的三态路由裁决，之后才谈得上存组定义。
      void doPaste(host, cardId)
      return
    case 'dissolve':
      // DISSOLVE：开确认层（**先问过用户**是这一行的全部语义），真正删定义发生在确认之后
      openDissolveConfirm(host, cardId)
      return
    default:
      // 未知行不猜动作
  }
}

/**
 * 从菜单的 EDIT TYPES 行进来：开勾选浮层（编辑模式只改接受的类型，不改卡名）。
 *
 * 卡的身份取自本轮组定义（不按 id 反查、不从卡面标签猜）；快照里已经没有这张卡（解散过、或
 * 读定义失败）就如实上报，不开一只没有归属的浮层。
 */
function openEditTypes(host, cardId) {
  const group = groupStore.groups.find((g) => g.id === cardId)
  if (!group) {
    host.notify(TYPE_OPENED_NOTIFY, { ok: false, error: '这张卡不在当前组定义里', cardId })
    return
  }
  if (typeState.open) dispatchTypes(host, { type: 'cancel', reason: 'reopen' })
  dispatchTypes(host, {
    type: 'edit',
    cardId: group.id,
    label: group.name,
    exts: group.exts,
    acceptAll: group.acceptAll,
    present: presentTypes(),
  })
}

/** 一个事件一次合成：状态交给归约器，效果数组按序落到宿主与 DOM 上 */
function dispatchMenu(host, event) {
  if (!host) return
  const next = nextMenuShell(menuState, event)
  menuState = next.state
  for (const fx of next.effects) {
    if (fx.kind === 'keyboard-tier') {
      if (fx.held) host.holdKeyboardTier(KEYBOARD_TIER)
      else host.releaseKeyboardTier(KEYBOARD_TIER)
    } else if (fx.kind === 'show') {
      showMenu(host, fx.rows, fx.box)
    } else if (fx.kind === 'hide') {
      hideMenu()
    } else if (fx.kind === 'run') {
      runMenuRow(host, fx.id, fx.paths, fx.cardId)
    } else if (fx.kind === 'hotzones') {
      // 热区纪律：遮罩一铺一撤都改了矩形，两个方向都要让渲染层重扫
      host.onDomChanged()
    } else if (fx.kind === 'notify') {
      host.notify(fx.type, fx.payload)
    }
  }
}

/** 在一个文件上打开文件菜单（右键落点即菜单原点，越界由 menu.js 钳制） */
function openFileMenu(host, x, y, paths) {
  dispatchMenu(host, {
    type: 'open',
    x,
    y,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    specs: FILE_MENU_ROWS,
    ctx: { paths },
  })
}

/**
 * 在卡片**空白处**打开组卡菜单。
 *
 * 与文件菜单**同一副壳、同一套裁决**，换的只有两样：行表（GROUP_CARD_MENU_ROWS）与上下文
 * （无选区 + 触发它的卡片 id + 那张卡的归属层 + **剪贴板实况**）。渲染端一行都不用改——card.js
 * 画的是 resolveMenuRows() 的输出。
 *
 * **PASTE 的置灰必须按剪贴板实况**（needs:'pasteable'），而那份实况要问内核
 * desktop/clipboard-state，故开层前先发一次查询。**查不到即视为不可贴**（宁可置灰，绝不误使能——
 * 与内核「粘贴按剪贴板实况置灰」同纪律）。查询回来之前菜单不弹：带着未知实况弹一只菜单再改行
 * 会让用户看见一次会变的置灰态。
 *
 * **归属层是可见性的唯一判据**：NEW GROUP / EDIT TYPES / DISSOLVE 三行都配了
 * `visibleWhen: 自定义卡或临时卡`，故固有扩展组卡上只有 PASTE 一行可见（工单185 登记过的那个
 * 「零可见行 → 不出菜单」的后果，本票的 PASTE 行把它化解了一半，详见 menu.js 的注释）。
 * @param {Host} host
 * @param {number} x
 * @param {number} y
 * @param {string} cardId
 */
async function openGroupMenu(host, x, y, cardId) {
  const mine = generation
  const pasteable = await pasteableNow(host, mine)
  if (generation !== mine || hostRef !== host) return // 换代途中：不把上一代的菜单画进这一代
  dispatchMenu(host, {
    type: 'open',
    x,
    y,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    specs: GROUP_CARD_MENU_ROWS,
    ctx: { paths: [], cardId, cardKind: cardTierById.get(cardId) || '', pasteable },
  })
}

/** 剪贴板实况（只读契约 desktop/clipboard-state）。查不到 / 查询失败一律读作**不可贴** */
async function pasteableNow(host, mine) {
  try {
    const state = await Promise.resolve(host.invoke('desktop/clipboard-state', null))
    if (generation !== mine) return false
    return Boolean(state && typeof state === 'object' && (/** @type {{ pasteable?: unknown }} */ (state).pasteable) === true)
  } catch (err) {
    // 查询失败按不可贴（契约原文：「查询失败按不可贴，宁可置灰不误可用」），不外溢也不打断开层
    return false
  }
}

/** 该卡当前的交互态（没有记录过就是初始态：收起、无高亮） */
function stateOf(card) {
  return cardState.get(card.id) ?? initialCardState()
}

/** 加/去一个类名（`classList.toggle` 在旧桩上未必有，这里显式写两步） */
function setClass(node, name, on) {
  if (on) node.classList.add(name)
  else node.classList.remove(name)
}

/**
 * 把整排的交互态刷到 DOM 上（状态 → 类名与几何的唯一出口，映射全在 interaction.js / geometry.js）。
 * 整排刷而不是增量改：高亮是单选、排他展开是全表性质，清掉旧的那一枚与点亮新的是同一次动作。
 *
 * @param {ReadonlyMap<string, { expanded: boolean, highlight: ReadonlySet<string> }>} states 全表交互态
 */
function paintStates(states) {
  const expandedId = expandedCardIdOf(states)
  layoutRow(expandedId)
  for (const [id, card] of cardNodes) {
    const state = states.get(id) ?? initialCardState()
    setClass(card, EXPANDED_CLASS, Boolean(expandedClassOf(state)))
    setClass(card, FADED_CLASS, Boolean(fadedClassOf(expandedId, id)))
    for (const cell of card.querySelectorAll(`.${CELL_CLASS}`)) {
      setClass(cell, HIGHLIGHT_CLASS, Boolean(highlightClassOf(state, cell.dataset.path)))
    }
  }
}

/**
 * 点击落点取样（DOM 侧；裁决在 interaction.js）。
 * 判定用 `closest` 自命中目标上溯，故点在图标盒、点字形占位、点文件名都算同一个图标格。
 */
function hitOf(card, target) {
  const from = target && typeof target.closest === 'function' ? target : null
  if (from) {
    const cell = from.closest(`.${CELL_CLASS}`)
    if (cell && card.contains(cell)) return 'icon'
    const more = from.closest(`.${MORE_CLASS}`)
    if (more && card.contains(more)) return 'more'
    if (card.contains(from)) return 'card-blank'
  }
  return 'outside'
}

/** 图标：缓存优先；取不到就落字形占位（不重试、不阻塞其余图标） */
function paintIcon(host, box, item) {
  if (iconCache.has(item.iconKey)) {
    const cached = iconCache.get(item.iconKey)
    box.appendChild(cached ? imageOf(cached) : glyphOf(item))
    return
  }
  // 先落占位：图标是观感项，取回前卡也该是完整的
  box.appendChild(glyphOf(item))
  void Promise.resolve(host.invoke('desktop/icon', { key: item.iconKey })).then(
    (r) => {
      const dataUrl = r && r.dataUrl
      iconCache.set(item.iconKey, dataUrl || null) // 负缓存：占位已是终态，不重试
      // 取回就地换真图标（节点还在场才换；卡已重建的走下一轮从缓存取）
      if (dataUrl && box.isConnected && box.firstChild) box.replaceChild(imageOf(dataUrl), box.firstChild)
    },
    () => { iconCache.set(item.iconKey, null) }, // 提取失败不外溢：占位留着，负缓存后不再重试
  )
}

function imageOf(src) {
  const img = document.createElement('img')
  img.alt = ''
  img.draggable = false
  img.src = src
  return img
}

/** 字形占位：扩展名首字母，无扩展名落 '·'（与内核 DOC/DIR/URL 字形同一观感层级） */
function glyphOf(item) {
  const glyph = document.createElement('div')
  glyph.className = 'dgc-glyph'
  const ext = extOf(item.name)
  glyph.textContent = ext ? ext.slice(1, 2).toUpperCase() : '·'
  return glyph
}

/**
 * 一格（一个文件）。
 *
 * 点击语义（工单181）：单击高亮这一格，**并在图标这一侧截断冒泡**——同一次点击不得顺带
 * 把整卡折叠/展开（选文件改卡片形状是最刺眼的误触）。截断与否由 interaction.js 裁决，
 * 这里只照办。
 */
function buildCell(host, item, card) {
  const cell = document.createElement('div')
  cell.className = CELL_CLASS
  cell.dataset.path = item.path
  const box = document.createElement('div')
  box.className = 'dgc-icon'
  paintIcon(host, box, item)
  const name = document.createElement('div')
  name.className = 'dgc-name'
  name.textContent = item.name
  cell.append(box, name)
  // 两张索引表（工单183）：desktop/rename 是按名改的，菜单手里只有绝对路径；条目自带 name，
  // 从本轮快照直接取，一个字都不反推。整排重画时一并清空（格节点换了，旧格没有可依附的实体）。
  cellByPath.set(item.path, cell)
  itemByPath.set(item.path, item)
  cell.addEventListener('click', (ev) => {
    const next = clickOnIcon(stateOf(card), item.path)
    if (next.stopPropagation) ev.stopPropagation() // 这次点击到此为止，不上浮到卡片
    cardState.set(card.id, next.state)
    paintStates(cardState) // 只改类名不改布局盒 → 不申报热区（#181 的纪律）
  })
  // 双击启动：走内核既有启动契约（desktop/launch），主进程侧的扫描池护栏原样生效——
  // 插件不自己 shell.openPath，那会绕开「桌面项不在当前扫描池内」的拒绝。
  cell.addEventListener('dblclick', () => {
    host.notify('doc-group-cards-launch', { path: item.path, name: item.name })
    void host.invoke('desktop/launch', { path: item.path })
  })
  // 右键：本插件自绘的只读菜单（工单182）。不派发给内核那份——它挂在 window.deckCtxMenu 上
  // 且本机停用；停用时内核那段只会空转，依赖它等于交付开箱即坏的功能。
  cell.addEventListener('contextmenu', (ev) => {
    ev.preventDefault() // 自绘世界观没有原生右键菜单
    ev.stopPropagation() // 不让文档区的右键分发看见这次右键（它只会去调停用的内核菜单）
    // 右键即选中该文件（与内核单项菜单同语义：先切选区再弹菜单）：复用 #181 的单选裁决，
    // 高亮与选区口径同源，不另设一份「菜单开着时选中谁」的真相。
    const next = clickOnIcon(stateOf(card), item.path)
    cardState.set(card.id, next.state)
    paintStates(cardState) // 只改类名不改布局盒 → 不申报热区（#181 的纪律）
    openFileMenu(host, ev.clientX, ev.clientY, [item.path])
  })
  return cell
}

/**
 * 整行布局：水平居中 + 按视口垂直居中；展开的那张独占屏幕正中并**按自己的高度重新垂直居中**。
 *
 * 位置与卡框尺寸全由 `rowLayoutOf` 算（geometry.js，纯模块、可直测），这里只把数写进 DOM——
 * 卡框那两行是**内联样式**而非 CSS 规则：热区矩形取的就是 getBoundingClientRect()，卡框必须
 * 与它同源；内容区的重排与滚动归 CSS（`.dgc-expanded .dgc-grid`），那里没有内联对手。
 *
 * 面板窗几何是主显示器**全屏 bounds（含任务栏占位）**，故视口中心本就比工作区中心低一个
 * 任务栏高度——按视口居中即 spec166 的要求，不要再减任务栏。展开卡若不重新居中，976 的高度
 * 会沿用折叠态的 top，底边直接越过视口插进任务栏（1440 屏上 598+976 = 1574）。
 */
function layoutRow(expandedId = expandedCardIdOf(cardState)) {
  const boxes = rowLayoutOf([...cardNodes.keys()], {
    width: window.innerWidth,
    height: window.innerHeight,
  }, expandedId)
  for (const box of boxes) {
    const card = cardNodes.get(box.id)
    if (!card) continue
    card.style.width = `${box.width}px`
    card.style.height = `${box.height}px`
    card.style.left = `${box.left}px`
    card.style.top = `${box.top}px`
  }
}

/** 卡头：标题 + 「+N」徽标（徽标仅在确有溢出时渲染；点击它与点空白是同一个裁决） */
function buildHead(group) {
  const head = document.createElement('h2')
  head.className = 'dgc-head'
  const title = document.createElement('span')
  title.className = 'dgc-title'
  title.textContent = `${group.label} · ${group.items.length}`
  head.appendChild(title)
  // 徽标数的是「折叠起来看不到几个」——文件还在，只是这一屏露不出来（工单180：隐藏而不丢弃）
  const more = moreLabelOf(group.items.length)
  if (more) {
    const badge = document.createElement('span')
    badge.className = MORE_CLASS
    badge.textContent = more
    head.appendChild(badge)
  }
  return head
}

/**
 * 结构指纹：卡 id + 归属层 + 卡面名 + 组内路径。
 *
 * 工单185 起**卡面名与归属层也进了指纹**：自定义卡的标题是用户起的名，改名 / 改归属层若不计入，
 * 指纹不变则整排不重画，标题就停在旧值上。刻意仍不含 mtime/iconKey——文件被碰一下不该重画整排卡。
 */
function fingerprintOf(groups) {
  return JSON.stringify(groups.map((g) => [g.id, g.tier, g.label, g.items.map((i) => i.path)]))
}

function draw(host, groups) {
  const key = fingerprintOf(groups)
  if (key === drawnKey) {
    layoutRow()
    return
  }
  drawnKey = key
  // 编辑会话随整排重画收场（工单183）：格节点马上要换，输入框连同它的宿主格一起没了，
  // 留着就是个悬空的输入框。与内核删除确认层/重命名编辑器的 `reason:'rebuild'` 同款口径。
  // 注意 1Hz 快照**不会**走到这里——结构指纹不含 mtime/iconKey，文件没增删时整排原样不动。
  if (renameState.open) dispatchRename(host, { type: 'cancel', reason: 'rebuild' })
  for (const card of cardNodes.values()) card.remove()
  cardNodes.clear()
  // 整排重画即从头来过：交互态按卡片 id 存着，卡片节点都换了，旧态没有可以依附的实体。
  cardState = new Map()
  cellByPath = new Map()
  itemByPath = new Map()
  // 归属层表随之重建：组卡菜单的可见性要判「这张卡手改得动吗」，判据就是它，不另设一份真相
  cardTierById = new Map()
  for (const group of groups) {
    // .card 是渲染层扫热区的唯一通用入口，不挂则永不收输入；id 必须唯一（扫掠不去重），
    // 唯一性由 grouping.js 保证。不用 .ditem：那是内核条目类，挂上会让内核的框选/选区/摆位
    // 半途接管插件画的节点，那几套状态机本插件接不上（ADR-0014 已登记失去）。
    const card = document.createElement('div')
    card.className = `card ${CARD_CLASS}`
    card.id = group.id
    const grid = document.createElement('div')
    grid.className = 'dgc-grid'
    for (const item of group.items) grid.appendChild(buildCell(host, item, card))
    card.append(buildHead(group), grid)
    // 点空白或点「更多」徽标 → 折叠/展开往复切换 + 清高亮 + 排他（同一时刻至多一张展开）。
    // 图标命中即便因为漏截断而冒泡上来，这道闸也不让它改卡片形状。
    card.addEventListener('click', (ev) => {
      // 编辑器开着时这一击归编辑器处置：点在编辑器里不吞（还要让人继续打字），点在外面则
      // 收场——那一击不该顺手把整卡折起来，也不该落到别的格子上改高亮。
      if (renameState.open) {
        if (isInsideRename(ev.target)) return
        ev.stopPropagation()
        dispatchRename(host, { type: 'outside' })
        return
      }
      if (!isCardToggle(hitOf(card, ev.target))) return
      const next = clickToggleExclusive(cardState, card.id)
      cardState = next.states
      paintStates(cardState)
      host.onDomChanged()
      // 热区纪律：折叠切换改了卡框（640×976）与位置，热区矩形随之变——不申报，新露出的
      // 那块区域既收不到点击也收不到滚轮（面板默认鼠标穿透，靠主进程 25ms 轮询解除）。
    })
    // 卡片**空白处**右键 → 组卡菜单（工单183 立骨架；图标格上右键是文件菜单，格那侧自己截断）。
    card.addEventListener('contextmenu', (ev) => {
      // 图标命中已经由格那侧截断冒泡走自己的路；即便漏了，这里也有同一道纯函数闸兜底。
      if (!isGroupMenuHit(hitOf(card, ev.target))) return
      ev.preventDefault()
      ev.stopPropagation()
      // 开层前要问一次剪贴板实况（PASTE 行的置灰），故这一击是异步的；世代/宿主对不上就放弃
      void openGroupMenu(host, ev.clientX, ev.clientY, card.id)
    })
    host.el.appendChild(card)
    cardNodes.set(group.id, card)
    cardTierById.set(group.id, group.tier)
  }
  paintStates(cardState)
  host.onDomChanged()
}

/** 这次点击是不是落在重命名编辑器的输入框里（编辑器开着时才有意义） */
function isInsideRename(target) {
  if (!renameInputNode) return false
  return typeof target?.closest === 'function' ? Boolean(target.closest(`.${RENAME_INPUT_CLASS}`)) : false
}

/**
 * 画一整排卡。
 *
 * 归属是**定义的函数**（工单185）：buildCards(桌面项, 组定义) 一次算出每张卡装什么。磁盘上的
 * 文件一个都不动、不移动、不改名——组卡是归属概念，不是目录。故用户在 EDIT TYPES 里改了勾选，
 * 下一帧的归属就随之迁移，无需任何手动步骤，也不需要「文件 → 卡」那张同步表。
 */
function render(host) {
  const desktop = host.view.desktop
  draw(host, buildCards(desktop ? desktop.items : [], groupStore))
}

function onResize() {
  if (!hostRef) return
  layoutRow()
  hostRef.onDomChanged()
}

export default {
  mount(host) {
    hostRef = host
    generation += 1 // 换代即换世代：上一代那次异步读回不该画进这一代的卡里
    groupStore = emptyStore()
    cardTierById = new Map()
    menuState = CLOSED_MENU // 换代后从头来过：菜单不跨代续着开
    confirmState = CLOSED_CONFIRM // 同上：确认层不跨代续着开
    renameState = CLOSED_RENAME // 同上：编辑器不跨代续着开
    typeState = CLOSED_TYPES // 同上：勾选浮层不跨代续着开
    injectStyle()
    try {
      hideDocZone()
      // 先用空定义画一排固有卡（用户一张自定义卡还没建过时本就是这个结果，故不是错画），
      // 组定义读回来后由 loadGroups 自己重画——mount 是同步的，不能等一个异步 IO。
      render(host)
      void loadGroups(host)
      window.addEventListener('resize', onResize)
      host.notify('doc-group-cards-mounted', { id: PLUGIN_ID })
    } catch (err) {
      // 装载失败不把桌面留成空白：先还原内核文档区，再交回宿主走静默降级
      // （宿主记 plugin-mount-failed、摘掉容器、面板照常工作）。宿主不会调 unmount，
      // 故半途画出来的卡与留下的宿主引用都在这里自己收干净。
      for (const card of cardNodes.values()) card.remove()
      cardNodes.clear()
      cardState = new Map()
      cellByPath = new Map()
      itemByPath = new Map()
      cardTierById = new Map()
      drawnKey = ''
      hostRef = null
      restoreDocZone()
      releaseInjected()
      throw err
    }
  },

  update(host) {
    if (!hostRef) return
    hostRef = host
    render(host)
  },

  unmount() {
    window.removeEventListener('resize', onResize)
    generation += 1 // 异步读回若在路上，回来时世代已变，自会被丢弃
    // 四层浮层开着就各自静默收场：遮罩/样式/热区/键盘档一样不漏地收回（归约器的 unmount
    // 事件不带存证——通道随插件消亡，但热区必须重申报，否则全屏热区会残留到卸载之后）。
    // **键盘档必须在每一条路径上都被放掉**：不放窗口就一直可聚焦，面板再也点不动。
    // 万一连这个钩子都没跑到（进程被杀），宿主在 reclaimPlugin 里按插件 id 强制回收
    // （plugins.ts + plugin-tiers.ts）——那是兜底，不是可以依赖的常规路径。
    dispatchMenu(hostRef, { type: 'unmount' })
    dispatchConfirm(hostRef, { type: 'unmount' })
    dispatchRename(hostRef, { type: 'unmount' })
    dispatchTypes(hostRef, { type: 'unmount' })
    menuState = CLOSED_MENU
    confirmState = CLOSED_CONFIRM
    renameState = CLOSED_RENAME
    typeState = CLOSED_TYPES
    for (const card of cardNodes.values()) card.remove()
    cardNodes.clear()
    cardState = new Map()
    cellByPath = new Map()
    itemByPath = new Map()
    cardTierById = new Map()
    releaseInjected()
    iconCache.clear()
    drawnKey = ''
    groupStore = emptyStore()
    restoreDocZone()
    // 文档区回来后热区要跟着回声明（含内核那条 24px 文档区环带），否则新露出的区域点不动
    hostRef?.onDomChanged()
    hostRef = null
  },
}
