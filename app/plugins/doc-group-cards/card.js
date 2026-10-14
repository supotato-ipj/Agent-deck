// 组卡（工单179 = spec166 之②，tracer bullet）：投放型插件包 doc-group-cards 的入口。
//
// 交付形态（ADR-0014）：投放型插件包，不是内置卡片包。源码在仓库内（app/plugins/doc-group-cards/），
// 另有一道安装步骤把它拷进用户插件根；运行态仍投放型——删掉那个目录即完全撤回，内核文档区自己回来。
// 本文件是浏览器可跑的 ES 模块（面板经 deck-plugin:// 原样 import，无编译步骤），故：
//   - 分组规则在同目录 grouping.js（纯逻辑、零 DOM 零 Electron，vitest 直测）；
//   - 本文件只管「画卡」：几何、图标、启动、热区。
//
// 词：GLOSSARY 的**扩展组**（按单个扩展名聚合）是**组卡**（渲染它的那张卡）的分组单位；
// 内核按类别聚合的**文档组**（六类列）与此并存、互不干涉（内核那条规则本插件一行不改）。
//
// 装载即接管桌面文档的呈现：mount 藏掉内核文档区，unmount 原样还回去。呈现层的调用纪律：
// 插件每一次改变卡片几何之后都必须主动 host.onDomChanged()——热区没有周期性重算，
// 不申报新覆盖的区域就既点不到也滚不动（spec166「热区纪律」）。

import { extOf, groupByExtension } from './grouping.js'

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

/** 插件自带样式（第三方插件不依赖面板样式表的面板内规则——只继承 .card 底盘） */
const STYLE_ID = 'dgc-style'
const CARD_CSS = `
#${STYLE_ID} .dgc-head {
  height: ${HEAD_H}px;
  margin: 0;
  line-height: 14px;
  overflow: hidden;
  white-space: nowrap;
}
#${STYLE_ID} .dgc-grid {
  display: grid;
  grid-template-columns: repeat(${COLS}, ${CELL}px);
  grid-auto-rows: ${CELL}px;
  gap: ${CELL_GAP}px;
  width: ${COLS * CELL + (COLS - 1) * CELL_GAP}px;
  height: ${ROWS * CELL + (ROWS - 1) * CELL_GAP}px;
  overflow: hidden;
}
#${STYLE_ID} .dgc-cell {
  width: ${CELL}px;
  height: ${CELL}px;
  padding-top: 4px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  overflow: hidden;
}
#${STYLE_ID} .dgc-icon {
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
}
#${STYLE_ID} .dgc-icon img { width: 48px; height: 48px; object-fit: contain; }
#${STYLE_ID} .dgc-glyph {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.10);
  color: #d6d6d6;
  font-size: 12px;
  line-height: 44px;
  text-align: center;
}
#${STYLE_ID} .dgc-name {
  max-width: ${CELL}px;
  font-size: 11px;
  line-height: 13px;
  color: #d6d6d6;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#${STYLE_ID} .dgc-cell:hover .dgc-name { color: #fff; }
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

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CARD_CSS
  document.head.appendChild(style)
}

function dropStyle() {
  const style = document.getElementById(STYLE_ID)
  if (style) style.remove()
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

function buildCell(host, item) {
  const cell = document.createElement('div')
  cell.className = 'dgc-cell'
  cell.dataset.path = item.path
  const box = document.createElement('div')
  box.className = 'dgc-icon'
  paintIcon(host, box, item)
  const name = document.createElement('div')
  name.className = 'dgc-name'
  name.textContent = item.name
  cell.append(box, name)
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
  for (const group of groups) {
    // .card 是渲染层扫热区的唯一通用入口，不挂则永不收输入；id 必须唯一（扫掠不去重），
    // 唯一性由 grouping.js 保证。不用 .ditem：那是内核条目类，挂上会让内核的框选/选区/摆位
    // 半途接管插件画的节点，那几套状态机本插件接不上（ADR-0014 已登记失去）。
    const card = document.createElement('div')
    card.className = 'card'
    card.id = group.id
    card.style.width = `${CARD_W}px`
    card.style.height = `${CARD_H}px`
    const head = document.createElement('h2')
    head.className = 'dgc-head'
    head.textContent = `${group.label} · ${group.items.length}`
    const grid = document.createElement('div')
    grid.className = 'dgc-grid'
    for (const item of group.items) grid.appendChild(buildCell(host, item))
    card.append(head, grid)
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
      drawnKey = ''
      hostRef = null
      restoreDocZone()
      dropStyle()
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
    dropStyle()
    iconCache.clear()
    drawnKey = ''
    restoreDocZone()
    // 文档区回来后热区要跟着回声明（含内核那条 24px 文档区环带），否则新露出的区域点不动
    hostRef?.onDomChanged()
    hostRef = null
  },
}
