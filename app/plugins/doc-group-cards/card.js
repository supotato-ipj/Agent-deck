// 组卡（工单179 = spec166 之②，tracer bullet；工单181 = spec166 之④，交互语义与生命周期）：投放型插件包 doc-group-cards 的入口。
//
// 交付形态（ADR-0014）：投放型插件包，不是内置卡片包。源码在仓库内（app/plugins/doc-group-cards/），
// 另有一道安装步骤把它拷进用户插件根；运行态仍投放型——删掉那个目录即完全撤回，内核文档区自己回来。
// 本文件是浏览器可跑的 ES 模块（面板经 deck-plugin:// 原样 import，无编译步骤），故：
//   - 分组规则在同目录 grouping.js（纯逻辑、零 DOM 零 Electron，vitest 直测）；
//   - 交互裁决在同目录 interaction.js（同一条缝，工单181）；
//   - 本文件只管「画卡」与「接线」：几何、图标、启动、点击监听、热区。
//
// 词：GLOSSARY 的**扩展组**（按单个扩展名聚合）是**组卡**（渲染它的那张卡）的分组单位；
// 内核按类别聚合的**文档组**（六类列）与此并存、互不干涉（内核那条规则本插件一行不改）。
//
// 装载即接管桌面文档的呈现：mount 藏掉内核文档区，unmount 原样还回去。呈现层的调用纪律：
// 插件每一次改变卡片几何之后都必须主动 host.onDomChanged()——热区没有周期性重算，
// 不申报新覆盖的区域就既点不到也滚不动（spec166「热区纪律」）。折叠切换会改形状，故申报；
// 高亮只改类名不改布局盒，矩形不动，故不申报。

import { extOf, groupByExtension } from './grouping.js'
import {
  CARD_CLASS,
  CELL_CLASS,
  EXPANDED_CLASS,
  HIGHLIGHT_CLASS,
  MORE_CLASS,
  clickOnCardBlank,
  clickOnIcon,
  expandedClassOf,
  highlightClassOf,
  initialCardState,
  isCardToggle,
} from './interaction.js'

// ---- 折叠态几何（工单179：宽 320、内容区 280、单格 88、3 列 × 2 行）----
const CARD_W = 320
const CARD_H = 244
const COLS = 3
const ROWS = 2
const CELL = 88
const CELL_GAP = 8
/** 卡间横向留白，与内核文档区的 column-gap（index.html #doc-groups）同值 */
const CARD_GAP = 18
/** 卡头行高 + 下边距（`.card h2` 家族：11px 字 + 10px 下边距，此处定死保证热区矩形稳定） */
const HEAD_H = 24

const PLUGIN_ID = 'doc-group-cards'

/** 本插件插进文档头的样式元素的 id（换代前一代没清干净时按它扫；热区日志也认这个名字） */
export const STYLE_ID = 'dgc-style'

/**
 * 插件自带样式（第三方插件不依赖面板样式表的面板内规则——只继承 .card 底盘）。
 *
 * 作用域根是**卡片根类名** `.dgc-card`，不是样式元素自己的 id：`#dgc-style .dgc-cell` 这种写法
 * 选的是「#dgc-style 的元素后代里的 .dgc-cell」，而 <style> 元素在 DOM 树里没有任何后代，
 * 于是整表规则一条都不会命中（工单179 原样如此，本票顺带修正——不改这条，本票新加的高亮与
 * 指针样式同样是哑的）。
 *
 * 折叠几何一行不写：那张表留给工单180，挂在 `.card.dgc-expanded` 上即可（见 EXPANDED_CLASS）。
 */
const CARD_CSS = `
.${CARD_CLASS} {
  cursor: pointer;
}
.${CARD_CLASS} .dgc-head {
  height: ${HEAD_H}px;
  margin: 0;
  line-height: 14px;
  overflow: hidden;
  white-space: nowrap;
}
.${CARD_CLASS} .dgc-grid {
  display: grid;
  grid-template-columns: repeat(${COLS}, ${CELL}px);
  grid-auto-rows: ${CELL}px;
  gap: ${CELL_GAP}px;
  width: ${COLS * CELL + (COLS - 1) * CELL_GAP}px;
  height: ${ROWS * CELL + (ROWS - 1) * CELL_GAP}px;
  overflow: hidden;
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
 */
const cardState = new Map()
/**
 * 本插件插到宿主管之外的节点（样式元素；将来的遮罩同样登记在此）。
 * **按引用登记、按引用摘除**——不靠 id 反查：卸载时手里拿着的正是自己插进去的那个节点，
 * 换代交错也不会摘错。
 */
const injected = []

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

/** 该卡当前的交互态（没有记录过就是初始态：收起、无高亮） */
function stateOf(card) {
  return cardState.get(card.id) ?? initialCardState()
}

/**
 * 把交互态整个刷到卡上（状态 → 类名的唯一出口，映射在 interaction.js 里）。
 * 整卡刷而不是增量改：高亮是单选，清掉旧的那一枚与点亮新的是同一次动作。
 */
function paintCardState(card, state) {
  const expanded = expandedClassOf(state)
  if (expanded) card.classList.add(expanded)
  else card.classList.remove(EXPANDED_CLASS)
  for (const cell of card.querySelectorAll(`.${CELL_CLASS}`)) {
    const highlight = highlightClassOf(state, cell.dataset.path)
    if (highlight) cell.classList.add(highlight)
    else cell.classList.remove(HIGHLIGHT_CLASS)
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
  cell.addEventListener('click', (ev) => {
    const next = clickOnIcon(stateOf(card), item.path)
    if (next.stopPropagation) ev.stopPropagation() // 这次点击到此为止，不上浮到卡片
    cardState.set(card.id, next.state)
    paintCardState(card, next.state)
  })
  // 双击启动：走内核既有启动契约（desktop/launch），主进程侧的扫描池护栏原样生效——
  // 插件不自己 shell.openPath，那会绕开「桌面项不在当前扫描池内」的拒绝。
  cell.addEventListener('dblclick', () => {
    host.notify('doc-group-cards-launch', { path: item.path, name: item.name })
    void host.invoke('desktop/launch', { path: item.path })
  })
  return cell
}

/**
 * 整行布局：水平居中 + 按视口垂直居中。
 * 面板窗几何是主显示器**全屏 bounds（含任务栏占位）**，故视口中心本就比工作区中心低一个
 * 任务栏高度——这里按视口居中即 spec166 的要求，不要再减任务栏。
 */
function layoutRow() {
  const rowWidth = cardNodes.size * CARD_W + Math.max(0, cardNodes.size - 1) * CARD_GAP
  const left = Math.round((window.innerWidth - rowWidth) / 2)
  const top = Math.round((window.innerHeight - CARD_H) / 2)
  let i = 0
  for (const card of cardNodes.values()) {
    card.style.left = `${left + i * (CARD_W + CARD_GAP)}px`
    card.style.top = `${top}px`
    i += 1
  }
}

/** 结构指纹：组 id + 组内路径。刻意不含 mtime/iconKey——文件被碰一下不该重画整排卡 */
function fingerprintOf(groups) {
  return JSON.stringify(groups.map((g) => [g.id, g.items.map((i) => i.path)]))
}

function draw(host, groups) {
  const key = fingerprintOf(groups)
  if (key === drawnKey) {
    layoutRow()
    return
  }
  drawnKey = key
  for (const card of cardNodes.values()) card.remove()
  cardNodes.clear()
  // 整排重画即从头来过：交互态按卡片 id 存着，卡片节点都换了，旧态没有可以依附的实体。
  // （工单180 起若要跨重画保持折叠，那是那张表自己的事，本票只保证不留旧状态。）
  cardState.clear()
  for (const group of groups) {
    // .card 是渲染层扫热区的唯一通用入口，不挂则永不收输入；id 必须唯一（扫掠不去重），
    // 唯一性由 grouping.js 保证。不用 .ditem：那是内核条目类，挂上会让内核的框选/选区/摆位
    // 半途接管插件画的节点，那几套状态机本插件接不上（ADR-0014 已登记失去）。
    const card = document.createElement('div')
    card.className = `card ${CARD_CLASS}`
    card.id = group.id
    card.style.width = `${CARD_W}px`
    card.style.height = `${CARD_H}px`
    const head = document.createElement('h2')
    head.className = 'dgc-head'
    head.textContent = `${group.label} · ${group.items.length}`
    const grid = document.createElement('div')
    grid.className = 'dgc-grid'
    for (const item of group.items) grid.appendChild(buildCell(host, item, card))
    card.append(head, grid)
    // 点空白（或将来的「更多」徽标）→ 折叠/展开往复切换 + 清高亮。
    // 图标命中即便因为漏截断而冒泡上来，这道闸也不让它改卡片形状。
    card.addEventListener('click', (ev) => {
      if (!isCardToggle(hitOf(card, ev.target))) return
      const next = clickOnCardBlank(stateOf(card))
      cardState.set(card.id, next.state)
      paintCardState(card, next.state)
      host.onDomChanged() // 折叠切换改了卡片形状 → 热区跟着重申报
    })
    host.el.appendChild(card)
    cardNodes.set(group.id, card)
  }
  layoutRow()
  host.onDomChanged()
}

function render(host) {
  const desktop = host.view.desktop
  draw(host, groupByExtension(desktop ? desktop.items : []))
}

function onResize() {
  if (!hostRef) return
  layoutRow()
  hostRef.onDomChanged()
}

export default {
  mount(host) {
    hostRef = host
    injectStyle()
    try {
      hideDocZone()
      render(host)
      window.addEventListener('resize', onResize)
      host.notify('doc-group-cards-mounted', { id: PLUGIN_ID })
    } catch (err) {
      // 装载失败不把桌面留成空白：先还原内核文档区，再交回宿主走静默降级
      // （宿主记 plugin-mount-failed、摘掉容器、面板照常工作）。宿主不会调 unmount，
      // 故半途画出来的卡与留下的宿主引用都在这里自己收干净。
      for (const card of cardNodes.values()) card.remove()
      cardNodes.clear()
      cardState.clear()
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
    for (const card of cardNodes.values()) card.remove()
    cardNodes.clear()
    cardState.clear()
    releaseInjected()
    iconCache.clear()
    drawnKey = ''
    restoreDocZone()
    // 文档区回来后热区要跟着回声明（含内核那条 24px 文档区环带），否则新露出的区域点不动
    hostRef?.onDomChanged()
    hostRef = null
  },
}
