// 面板渲染层（原生 ESM 模块，工单10 起：插件资产同源经 deck-plugin:// 协议动态 import）。
// 数据一律经桥接契约自内核而来（初始 snapshot + panel/changed 订阅）；
// 天气卡是唯一例外：纯前端直连 Open-Meteo（沿用 patched 壁纸先例），坐标经快照下发。
// 渲染层向宿主声明交互热区（各卡片矩形）；字体就绪后再声明一次，免字体换挡挪动矩形。
import { syncPlugins } from './plugins.js'
import type { PluginRuntimeDeps } from './plugins.js'
import { pad3 } from './format.js'
import { EMPTY_SELECTION, itemMenuPlan, keyboardOpenTargets, launchListOf, nextSelection } from './selection.js'
import type { SelectionEvent, SelectionModel } from './selection.js'
import { GATE_INITIAL, escapePlan, keyRoutingContextOf, nextKeyboardGate, pasteFailureNotice, routeSelectionKey } from './keyboard-gate.js'
import type { KeyboardActionType, KeyboardGateEvent, KeyboardGateState } from './keyboard-gate.js'
import { pasteableWithinTimeout } from './pasteable-query.js'
import { zoneHotzoneContains, zoneHotzoneRect } from './zone-hotzone.js'
import type { ZoneBox } from './zone-hotzone.js'

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T
}

// ---- 存证上报（前 3 次渲染；验收电池断言数据到达与刷新） ----

function notify(type: string, payload?: Record<string, unknown>): void {
  window.deck.host.notify(type, payload)
}

// ---- 桌面承载（工单05 扫描/图标/启动 + 工单06 编排/摆位 + 工单20 选区）：文档区分组列 ----
// 工单59：dock 应用区退役——应用入口并入任务栏（左组手钉/运行中 + 中组推荐位），
// 桌面只承载文档区。应用条目仍在条目池里（zone=app），供任务栏取元数据，不再上屏。
// 条目池随 1Hz 快照下发，按指纹 diff——集合未变不重建 DOM；图标经 desktop/icon
// 懒取（dataURL 本地缓存，键含 mtime，lnk 指向变更自然换图标）。
// 工单06 起文档区按 plan.docs 的
// 组序/组内序铺分组列；拖拽摆位经 desktop/move 落内核并持久化。
// 工单20 起选区是名字集合（跨分区、瞬态、按名存续）：迁移全部走 selection.ts
// 纯状态机，本文件只消费其输出——快照重建后按名恢复，消失条目自动剔除。
// 工单21 起分区空白可框选（band=替换 / ctrl+band=并集，起笔阈值与拖拽共用）。
// 工单22 起批量拖拽：起笔于选中集内且集合多条 = 整组按选区插入序迁移，ghost 带
// 「N 项」徽标（N = 实际拖动条数，不含内核跳过的组员——内核回报的 skipped 是权威口径，
// 经 desktop-moved-batch 存证如实上报）。
// 工单23 起分区空白右键弹上下文菜单：shell 是 cordis 插件（cards/context-menu，
// 随清单热插拔），触发与收起裁决在面板——右键分区空白（热区内、非条目上）把内置
// 两项交给 shell；开层期间热区换全窗，任何菜单外按下即收起并吞掉那一击。
// 工单24 起条目右键弹单项菜单（打开/打开所在位置/复制路径）：弹/切裁决经
// selection.itemMenuPlan，动作走 desktop/launch（via=ctx-menu）/desktop/reveal/
// desktop/copy-path 三个契约，收起与吞没共用 23 的面板裁决。
// 工单26 起右键命中选中集内条目（选区多于一条）弹多选菜单：条目集收敛为
// 【打开全部 / 复制路径（多行 \n）/ 删除全部】（工单27 补入删除全部、工单29 补入
// 复制/剪切文件级写向），动作作用于整个选区且选区不动；右键非选中条目仍走单项菜单（先切单选）。
// 工单27 起条目删除进回收站（desktop/trash）：单项【删除】直接执行，多选【删除全部】
// 先弹自绘轻量确认（列出条数、确认/取消，点外部/Esc=取消）；删除成功条目由内核同拍
// 清除摆位（防同名复活莫名归位）；权限/占用失败 ok=false 存证 + 瞬态提示条（#trash-notice）。
// 工单28 起单项菜单加【重命名】：标签原地变输入框（Enter/失焦确认、Esc 取消），
// desktop/rename 契约在内核做校验与摆位同拍迁移；失败 ok=false 存证 + 提示条 + 原名还原。

const docZone = el('doc-zone')
const docGroups = el('doc-groups')
const GROUP_ORDER = ['folders', 'office', 'pdf', 'image', 'archive', 'other'] as const
const GROUP_LABELS: Record<string, string> = {
  folders: 'FOLDERS', office: 'OFFICE', pdf: 'PDF', image: 'IMAGE', archive: 'ARCHIVE', other: 'OTHER',
}
const localIcons = new Map<string, string>()
let desktopFingerprintSeen = ''
let desktopRenderCount = 0
let selection: SelectionModel = EMPTY_SELECTION
/** 最近一拍条目名 → 条目（双击全开按名取 path；快照未变时同样有效） */
let itemByName = new Map<string, DesktopItem>()
let layoutApplied = ''

function itemGlyph(item: DesktopItem): string {
  return item.kind === 'folder' ? 'DIR' : item.kind === 'url' ? 'URL' : 'DOC'
}

function markSelection(): void {
  const sel = new Set(selection.names)
  for (const d of document.querySelectorAll<HTMLElement>('.ditem')) {
    d.classList.toggle('sel', sel.has(d.dataset.name ?? ''))
  }
}

// ---- 键盘模式归一仲裁（工单31，ADR-0006 收官）：键盘模式是多方共用的单通道（工单02
// 起搜索/设置浮层、删除确认层、重命名编辑 9 处调用点；工单31 增选区生灭；工单100 增
// 插件键盘档）。归一仲裁把开态合成一处——键盘模式 = 选区非空 OR 任一浮层开 OR 任一
// 插件档在持（keyboard-gate.ts 纯逻辑）。全部开关意图都进同一归约器，变化沿才出通道：
// 浮层关而选区仍非空 → 保持 on 不互相踩；选区清空而浮层/插件档仍开 → 键盘归浮层/键盘档。
// panel-ipc 侧 keyboard-mode-on/off 存证与选区生灭严格同相（电池 P5.17 硬断言）。

let keyboardGate: KeyboardGateState = GATE_INITIAL

/** 门控单点：事件进归约器，沿出通道。选区生灭以 applySelection 为唯一出口（band 框选
 * 不发选区存证也过这里），浮层开合九处调用点全部改走此封装。 */
function dispatchKeyboardGate(event: KeyboardGateEvent): void {
  const { state, edge } = nextKeyboardGate(keyboardGate, event)
  keyboardGate = state
  if (edge !== null) window.deck.host.setKeyboardMode(edge === 'on')
}

/** 选区事件入口：状态机迁移 → DOM 标记 → 生灭存证（desktop-* 族；#19 存证约定）。
 * band/ctrl-band 不在此发事件——框选的生灭与结果存证归框选生命周期事件
 * （desktop-marquee-started/updated/finished/cancelled，含矩形与最终名单）。 */
function applySelection(event: SelectionEvent): void {
  const prev = selection.names
  selection = nextSelection(selection, event)
  markSelection()
  if (event.type === 'click') {
    notify('desktop-selected', { name: event.name, names: [...selection.names] })
  } else if (event.type === 'ctrl-click') {
    notify('desktop-selection-toggled', {
      name: event.name,
      names: [...selection.names],
      selected: selection.names.includes(event.name),
    })
  } else if (event.type === 'blank-click') {
    if (prev.length) notify('desktop-selection-cleared', { had: [...prev] })
  } else if (event.type === 'reconcile') {
    const removed = prev.filter((n) => !selection.names.includes(n))
    if (removed.length) notify('desktop-selection-pruned', { removed, names: [...selection.names] })
  } else if (event.type === 'select-all') {
    notify('desktop-selection-all', { names: [...selection.names] })
  }
  // 生灭出口唯一：选区空否（含 band 框选、dblclick 吞集消费——不发选区存证但同样过
  // 此口）喂入仲裁，keyboard-mode-on/off 与生灭同相由构造保证（本函数是全部选区迁移
  // 的必经之路）
  dispatchKeyboardGate({ type: 'selection', nonEmpty: selection.names.length > 0 })
}

/** 双击启动名单逐项经 desktop/launch（走既有启动校验），结果逐项存证；via 记来源
 * （双击 / 工单24 单项菜单「打开」——同一启动链路，存证可分；工单31 增 keyboard=Enter） */
function launchNames(names: readonly string[], via: 'dblclick' | 'ctx-menu' | 'keyboard' = 'dblclick'): void {
  for (const name of names) {
    const target = itemByName.get(name)
    if (!target) {
      // 渲染层快照落后于内核池：按同名拒绝存证（与内核「不在当前扫描池内」同语义）
      notify('desktop-launch-rejected', { name, ok: false, error: '桌面项不在当前扫描池内' })
      continue
    }
    notify('desktop-launch-clicked', { name: target.name, path: target.path, via })
    void window.deck.bridge.invoke('desktop/launch', { path: target.path }).then(
      (r) => notify(r.ok ? 'desktop-launched' : 'desktop-launch-rejected', {
        name: target.name, ok: r.ok, error: r.error ?? null,
      }),
      (err: unknown) => notify('desktop-launch-failed', { name: target.name, message: String(err) }),
    )
  }
}

function fetchItemIcon(img: HTMLImageElement, item: DesktopItem): void {
  void window.deck.bridge.invoke('desktop/icon', { key: item.iconKey }).then((r) => {
    const dataUrl = r && r.dataUrl
    if (!dataUrl) {
      // 提取失败/未就绪：落位字形占位（不重试——内核侧已有按尝试上限的退避）
      const glyph = document.createElement('div')
      glyph.className = 'glyph'
      glyph.textContent = itemGlyph(item)
      img.replaceWith(glyph)
      return
    }
    localIcons.set(item.iconKey, dataUrl)
    img.src = dataUrl
  }, () => { /* 图标是观感项，失败不阻塞承载 */ })
}

function buildItem(item: DesktopItem): HTMLElement {
  const d = document.createElement('div')
  d.className = 'ditem'
  d.dataset.name = item.name
  const img = document.createElement('img')
  img.className = 'icon'
  img.alt = ''
  img.draggable = false
  const cached = localIcons.get(item.iconKey)
  if (cached) img.src = cached
  else fetchItemIcon(img, item)
  const label = document.createElement('div')
  label.className = 'label'
  label.textContent = item.display
  d.append(img, label)
  // 单击选中（启动前确认目标；Ctrl+单击切换）；双击全开（集内任一条=整集，肌肉记忆
  // 原样保留）；拖拽摆位（工单06）。双击序列的第二击（e.detail≥2）不做选区迁移——
  // 整集语义由 dblclick 分支经状态机裁决（selection.ts 注记的时间无关实现）。
  d.addEventListener('click', (e) => {
    if (dragState.suppressed || marqueeState.suppressed) return // 拖拽/框选结束的那一下点击不算选中
    if (e.detail > 1) return
    applySelection(e.ctrlKey
      ? { type: 'ctrl-click', name: item.name }
      : { type: 'click', name: item.name })
  })
  d.addEventListener('dblclick', () => {
    if (dragState.suppressed) return
    const launch = launchListOf(selection, item.name) // 整集名单先取：dblclick 事件会消费吞集
    applySelection({ type: 'dblclick', name: item.name }) // 名单不变、吞集一次性消费；生灭喂入走 applySelection 单出口（评审结构项收敛第二喂点）
    notify('desktop-launch-set-clicked', { names: [...launch] })
    launchNames(launch)
  })
  // 条目上下文菜单（工单24 单项 / 工单26 多选）：弹/切裁决在状态机（selection.itemMenuPlan）
  // ——选中集内条目（选区多于一条）弹多选菜单，动作作用于整集、选区不动；非选中条目
  // 先发 click 把选区切为该条（desktop-selected 存证随之自然产生）再弹单项菜单。
  // 手势进行中不弹（native 惯例，分区空白菜单同法）。
  d.addEventListener('contextmenu', (e) => {
    if (dragState.active || marqueeState.active) return
    e.preventDefault() // 自绘世界观没有原生菜单，右键只属于上下文菜单
    const plan = itemMenuPlan(selection, item.name)
    if (plan.kind === 'multi') {
      window.deckCtxMenu?.open(e.clientX, e.clientY, multiItemMenuItems(selection.names))
      return
    }
    if (plan.switchTo) applySelection({ type: 'click', name: plan.switchTo })
    window.deckCtxMenu?.open(e.clientX, e.clientY, itemMenuItems(item))
  })
  wireDrag(d, item)
  return d
}

// ---- 拖拽摆位（工单06；工单22 批量）：指针事件自实现（非 HTML5 DnD——合成输入驱不动
// OLE 拖拽，且自绘世界要的是「排在谁前面」语义）。拖拽期间声明全窗热区：跨分区拖动会
// 路过非热区空档，若不临时全窗接收，中途面板转穿透、pointer 流即断（拖拽死在中途）。
// 批量（工单22）：起笔于选中集内且集合多条 = 整组按选区插入序迁移（desktop/move-batch，
// 手钉组员由内核跳过并回报 skipped）；起笔于集合外 = 单选拖拽（desktop/move，现状不变）。

interface DragState {
  name: string | null
  fromZone: string | null
  /** 批量拖拽组（选区插入序）；单选拖拽为 null。含手钉组员——可动性由内核裁决 */
  group: string[] | null
  startX: number
  startY: number
  active: boolean
  suppressed: boolean
  ghost: HTMLElement | null
  target: { zone: 'app' | 'doc'; beforeName: string | null } | null
}

const dragState: DragState = {
  name: null, fromZone: null, group: null, startX: 0, startY: 0, active: false, suppressed: false, ghost: null, target: null,
}

const DRAG_THRESHOLD_PX = 6

function zoneOfContainer(node: Node | null): 'app' | 'doc' | null {
  for (let n = node; n; n = (n as HTMLElement).parentElement) {
    if ((n as HTMLElement).id === 'doc-groups' || (n as HTMLElement).id === 'doc-zone') return 'doc'
  }
  return null
}

function itemUnder(exclude: readonly string[]): string | null {
  const ex = new Set(exclude)
  const hit = document.elementFromPoint(lastPointer.x, lastPointer.y)
  const item = hit && (hit as HTMLElement).closest ? (hit as HTMLElement).closest<HTMLElement>('.ditem') : null
  if (!item || !item.dataset.name) return null
  if (ex.has(item.dataset.name)) return null
  return item.dataset.name
}

const lastPointer = { x: 0, y: 0 }

function markDropTarget(): void {
  for (const d of document.querySelectorAll<HTMLElement>('.ditem.drop-before')) d.classList.remove('drop-before')
  if (!dragState.target || dragState.target.beforeName === null) return
  const node = document.querySelector<HTMLElement>(`.ditem[data-name="${CSS.escape(dragState.target.beforeName)}"]`)
  if (node) node.classList.add('drop-before')
}

function wireDrag(d: HTMLElement, item: DesktopItem): void {
  d.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    dragState.name = item.name
    dragState.fromZone = item.zone
    // 批量拖拽判定（工单22）：起笔于选中集内且集合多条 = 整组拖。起笔于集合外仍是
    // 单选拖拽——此刻的旧选区原样保留（收束语义归尾随 click），不在此抢先改选区。
    dragState.group = selection.names.length >= 2 && selection.names.includes(item.name)
      ? [...selection.names]
      : null
    dragState.startX = e.clientX
    dragState.startY = e.clientY
    dragState.active = false
    dragState.suppressed = false
    try { d.setPointerCapture(e.pointerId) } catch { /* 旧环境退化：窗口内拖拽仍可用 */ }
  })
  d.addEventListener('pointermove', (e) => {
    if (dragState.name !== item.name) return
    lastPointer.x = e.clientX
    lastPointer.y = e.clientY
    if (!dragState.active) {
      if (Math.hypot(e.clientX - dragState.startX, e.clientY - dragState.startY) < DRAG_THRESHOLD_PX) return
      dragState.active = true
      dragState.suppressed = true
      beginGhost(item)
      // 全窗热区：拖拽途中经过非热区空档也不转穿透
      window.deck.host.setHotZones([{ id: 'drag', x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }])
    }
    if (dragState.ghost) {
      dragState.ghost.style.left = `${e.clientX - 24}px`
      dragState.ghost.style.top = `${e.clientY - 24}px`
    }
    const zone = zoneOfContainer(document.elementFromPoint(e.clientX, e.clientY))
    if (zone === null) {
      dragState.target = null
    } else {
      // 落点参照不取被拖组员（批量整组都走，以组外条目为锚；单选即自身）
      dragState.target = { zone, beforeName: itemUnder(dragState.group ?? [item.name]) }
    }
    markDropTarget()
  })
  const finish = () => {
    if (dragState.name !== item.name) return
    const { active, target, fromZone, group } = dragState
    const name = dragState.name
    endDrag()
    if (!active || !target) return
    if (group) {
      if (batchDropUnchanged(group, target.zone, target.beforeName)) return // 整组原地：不落盘
      notify('desktop-move-batch-clicked', { names: [...group], zone: target.zone, beforeName: target.beforeName })
      void window.deck.bridge.invoke('desktop/move-batch', { names: [...group], zone: target.zone, beforeName: target.beforeName }).then(
        (r) => notify(r.ok ? 'desktop-moved-batch' : 'desktop-move-batch-rejected', {
          names: [...group], zone: target.zone, beforeName: target.beforeName,
          moved: r.moved, skipped: r.skipped, ok: r.ok, error: r.error ?? null,
        }),
        (err: unknown) => notify('desktop-move-batch-failed', { names: [...group], message: String(err) }),
      )
      return
    }
    if (target.zone === fromZone && target.beforeName === nextSiblingName(name)) return // 位置未变，不落盘
    notify('desktop-move-clicked', { name, zone: target.zone, beforeName: target.beforeName })
    void window.deck.bridge.invoke('desktop/move', { name, zone: target.zone, beforeName: target.beforeName }).then(
      (r) => notify(r.ok ? 'desktop-moved' : 'desktop-move-rejected', {
        name, zone: target.zone, beforeName: target.beforeName, ok: r.ok, error: r.error ?? null,
      }),
      (err: unknown) => notify('desktop-move-failed', { name, message: String(err) }),
    )
  }
  d.addEventListener('pointerup', finish)
  d.addEventListener('pointercancel', () => {
    if (dragState.name === item.name) endDrag()
  })
}

/** 批量同位守卫（单选「位置未变，不落盘」的整组版）：组员已全部在目标分区、且按
 * 选区插入序紧贴参照之前（参照 null = 紧贴末尾）——整组原地，不落盘不发存证。 */
function batchDropUnchanged(group: readonly string[], zone: 'app' | 'doc', beforeName: string | null): boolean {
  if (zone !== 'doc') return false // 应用区不再由桌面承载：无处可摆，一律判为有变化
  const container = docGroups
  const order = [...container.querySelectorAll<HTMLElement>('.ditem')].map((d) => d.dataset.name ?? '')
  if (!group.every((n) => order.includes(n))) return false // 有组员在另一分区：跨区必变
  const at = beforeName === null ? order.length : order.indexOf(beforeName)
  if (at < group.length) return false // 参照之前装不下整组
  return order.slice(at - group.length, at).join('\u0000') === group.join('\u0000')
}

function nextSiblingName(name: string): string | null {
  const node = document.querySelector<HTMLElement>(`.ditem[data-name="${CSS.escape(name)}"]`)
  let n = node ? node.nextElementSibling : null
  while (n && !(n as HTMLElement).classList.contains('ditem')) n = n.nextElementSibling
  return n ? (n as HTMLElement).dataset.name ?? null : null
}

function beginGhost(item: DesktopItem): void {
  const group = dragState.group ?? [item.name]
  // 只把「实际会动的」条目变半透明：不参与拖拽观感的组员（不在文档区）不参与变暗。
  // N 项徽标 = 实际拖动条数（不含 skipped）——权威 skipped 口径由内核回报，
  // desktop-moved-batch 存证上报。
  const movers = group.filter((n) => itemByName.get(n)?.zone === 'doc')
  for (const n of movers) {
    document.querySelector<HTMLElement>(`.ditem[data-name="${CSS.escape(n)}"]`)?.classList.add('dragging')
  }
  const source = document.querySelector<HTMLElement>(`.ditem[data-name="${CSS.escape(item.name)}"]`)
  const ghost = document.createElement('div')
  ghost.id = 'drag-ghost'
  const img = source ? source.querySelector('img') : null
  if (img) {
    const g = document.createElement('img')
    g.draggable = false // 幽灵随光标走：可拖 img 会在指针下把拖拽劫持成浏览器原生拖拽
    g.src = img.src
    g.style.width = '40px'
    g.style.height = '40px'
    ghost.appendChild(g)
  }
  const label = document.createElement('div')
  label.className = 'label'
  label.textContent = item.display
  ghost.appendChild(label)
  if (dragState.group) {
    const badge = document.createElement('div')
    badge.className = 'badge'
    badge.textContent = `${movers.length} 项`
    ghost.appendChild(badge)
    notify('desktop-batch-drag-started', { names: [...dragState.group], count: movers.length })
  }
  document.body.appendChild(ghost)
  dragState.ghost = ghost
}

function endDrag(): void {
  if (dragState.ghost) {
    dragState.ghost.remove()
    dragState.ghost = null
  }
  for (const d of document.querySelectorAll<HTMLElement>('.ditem.dragging')) d.classList.remove('dragging')
  for (const d of document.querySelectorAll<HTMLElement>('.ditem.drop-before')) d.classList.remove('drop-before')
  dragState.name = null
  dragState.fromZone = null
  dragState.group = null
  dragState.active = false
  dragState.target = null
  declareHotZones()
  // suppressed 在下一拍放开：pointerup 后浏览器还会补发一次 click（拖拽尾-click 不算选中）
  setTimeout(() => { dragState.suppressed = false }, 0)
}

// ---- 框选（工单21，GLOSSARY.md「框选」）：从分区热区内的空白起笔拖出半透明矩形，
// 凡与矩形相交的桌面项即时高亮；松手普通=替换选区、Ctrl=并集（迁移入 selection.ts
// 状态机，本文件只消费输出）。与拖拽摆位共用起笔阈值：阈值内松手就是普通空白单击
// （清空语义走既有 click 冒泡，suppressed 不置位）；越过阈值后声明全窗热区续接指针流
// （拖拽同法）——指针流出分区热区框选不中断。热区外空白桌面不经过面板（穿透照旧）。
// 工单89 起热区=分区容器矩形外扩一圈（zone-hotzone.ts），起笔面从「条目缝隙+10px
// 边带」扩成整个条带+环带（分区语义路由见下方 body 级监听注记）。

interface MarqueeState {
  pointerId: number | null
  startX: number
  startY: number
  /** 起笔瞬间的 Ctrl 态：「按住 Ctrl 框选」——预演与提交同源，不随途中/松手修饰键漂移 */
  ctrl: boolean
  active: boolean
  suppressed: boolean
  rect: HTMLElement | null
  hits: readonly string[]
  rectNow: { x: number; y: number; w: number; h: number } | null
}

const marqueeState: MarqueeState = {
  pointerId: null, startX: 0, startY: 0, ctrl: false, active: false, suppressed: false,
  rect: null, hits: [], rectNow: null,
}

/** 框选命中：与「起笔 → 现位」矩形相交的桌面项名（DOM 序 = 并集插入序） */
function marqueeHits(x: number, y: number): string[] {
  const left = Math.min(marqueeState.startX, x)
  const top = Math.min(marqueeState.startY, y)
  const right = Math.max(marqueeState.startX, x)
  const bottom = Math.max(marqueeState.startY, y)
  const names: string[] = []
  for (const d of document.querySelectorAll<HTMLElement>('.ditem')) {
    const r = d.getBoundingClientRect()
    if (r.left < right && r.right > left && r.top < bottom && r.bottom > top) {
      const name = d.dataset.name ?? ''
      if (name) names.push(name)
    }
  }
  return names
}

/** 框选高亮预演：普通=命中集（替换预览）、Ctrl=现选区∪命中（并集预览，与状态机
 * ctrl-band 同式——语义唯一出处仍是状态机，这里只是提交前的显示层同构覆写），
 * 松手后 markSelection 按状态机输出重刷。 */
function markMarqueePreview(hits: readonly string[], ctrl: boolean): void {
  const set = new Set(ctrl ? [...selection.names, ...hits] : hits)
  for (const d of document.querySelectorAll<HTMLElement>('.ditem')) {
    d.classList.toggle('sel', set.has(d.dataset.name ?? ''))
  }
}

function updateMarquee(x: number, y: number, ctrl: boolean): void {
  const box = {
    x: Math.min(marqueeState.startX, x),
    y: Math.min(marqueeState.startY, y),
    w: Math.abs(x - marqueeState.startX),
    h: Math.abs(y - marqueeState.startY),
  }
  marqueeState.rectNow = box
  if (marqueeState.rect) {
    marqueeState.rect.style.left = `${box.x}px`
    marqueeState.rect.style.top = `${box.y}px`
    marqueeState.rect.style.width = `${box.w}px`
    marqueeState.rect.style.height = `${box.h}px`
  }
  const hits = marqueeHits(x, y)
  const changed = hits.join('\u0000') !== marqueeState.hits.join('\u0000')
  marqueeState.hits = hits
  markMarqueePreview(hits, ctrl)
  // 存证只随命中集变化发（矩形本身每拍都重绘；命中不变时事件无信息量）
  if (changed) notify('desktop-marquee-updated', { rect: box, hits: [...hits] })
}

function resetMarquee(): void {
  if (marqueeState.rect) {
    marqueeState.rect.remove()
    marqueeState.rect = null
  }
  marqueeState.pointerId = null
  marqueeState.active = false
  marqueeState.hits = []
  marqueeState.rectNow = null
  markSelection()
  declareHotZones()
  // suppressed 在下一拍放开：pointerup 后浏览器还会补发一次 click（框选尾-click 不算空白清空）
  setTimeout(() => { marqueeState.suppressed = false }, 0)
}

// ---- 分区空白清空选区（工单20）+ 框选起笔（工单21）+ 分区语义路由（工单89）：
// 条目之外的分区面单击即清空（GLOSSARY.md「选区」）；同一起笔面按住拖动即框选。
// 监听统一挂 body：分区热区是「容器可见矩形外扩一圈」（工单89，zone-hotzone.ts），
// 环带内的落点 target 在 body 本体上（无分区 DOM 可挂），分区 DOM 面（容器、标签带）
// 的落点 target 在分区内——两处共用同一几何门控（zoneAtPoint + onZoneSurface）路由进
// 同一条语义；只扩热区不接语义，环带就成了「接住点击却无事发生」的黑洞。条目自身的
// 点击同样冒泡到 body，closest 滤掉（点选/拖拽摆位各走各的语义）；卡片、浮层、插件面
// 即使压着环带也不归分区（onZoneSurface 的 target 门控）。环带之外的空白桌面不经过
// 面板（穿透照旧）。

/** 分区命中：几何上落在某分区热区（容器外扩带）内 */
function zoneAtPoint(x: number, y: number): boolean {
  for (const zone of [docZone]) {
    if (zoneHotzoneContains(zoneHotzoneRectOf(zone), x, y)) return true
  }
  return false
}

/** 起笔/点击目标是否为分区语义面：分区 DOM 内（容器面、标签带），或环带上的 body
 * 本体。卡片/浮层/插件面不归分区——它们即使几何上压着环带，target 门控也先挡下。 */
function onZoneSurface(t: EventTarget | null): boolean {
  if (t === document.body || t === document.documentElement) return true
  return t instanceof Element && t.closest('.zone') !== null
}

/** 分区空白事件判定：条目上不归分区（点选/拖拽摆位各走各的语义）；卡片、浮层、
 * 插件面即使几何上压着环带也不归（target 门控）；热区外不归（穿透照旧）。三关全过
 * 才算分区空白语义面——框选起笔、空白清空、分区菜单共用这一道门。 */
function zoneBlankEvent(e: PointerEvent | MouseEvent): boolean {
  const t = e.target as HTMLElement
  if (t.closest('.ditem')) return false
  return onZoneSurface(t) && zoneAtPoint(e.clientX, e.clientY)
}

document.body.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  if (!zoneBlankEvent(e)) return
  // 上一笔框选若因指针流中断而残留（up/cancel 未达，矩形/吞点击态悬空），起笔时静默收尸
  if (marqueeState.active || marqueeState.rect) resetMarquee()
  marqueeState.pointerId = e.pointerId
  marqueeState.startX = e.clientX
  marqueeState.startY = e.clientY
  marqueeState.ctrl = e.ctrlKey
  marqueeState.active = false
  try { document.body.setPointerCapture(e.pointerId) } catch { /* 旧环境退化：窗口内框选仍可用 */ }
})
document.body.addEventListener('pointermove', (e) => {
  if (marqueeState.pointerId !== e.pointerId) return
  if (!marqueeState.active) {
    if (Math.hypot(e.clientX - marqueeState.startX, e.clientY - marqueeState.startY) < DRAG_THRESHOLD_PX) return
    marqueeState.active = true
    marqueeState.suppressed = true
    const rect = document.createElement('div')
    rect.id = 'marquee-rect'
    document.body.appendChild(rect)
    marqueeState.rect = rect
    // 全窗热区：框选途中流出分区热区也不转穿透（拖拽同法）
    window.deck.host.setHotZones([{ id: 'marquee', x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }])
    notify('desktop-marquee-started', { from: { x: marqueeState.startX, y: marqueeState.startY } })
  }
  updateMarquee(e.clientX, e.clientY, marqueeState.ctrl)
})
document.body.addEventListener('pointerup', (e) => {
  if (marqueeState.pointerId !== e.pointerId) return
  if (!marqueeState.active) {
    resetMarquee() // 阈值内松手：尾随 click 走空白清空语义（普通点击）
    return
  }
  const ctrl = marqueeState.ctrl
  const hits = [...marqueeState.hits]
  const rectNow = marqueeState.rectNow
  applySelection(ctrl ? { type: 'ctrl-band', names: hits } : { type: 'band', names: hits })
  notify('desktop-marquee-finished', { rect: rectNow, ctrl, hits, names: [...selection.names] })
  resetMarquee()
})
document.body.addEventListener('pointercancel', (e) => {
  if (marqueeState.pointerId !== e.pointerId) return
  if (marqueeState.active) notify('desktop-marquee-cancelled', {}) // 生灭存证的 abort 半边
  resetMarquee() // 取消即作废：不提交命中，选区保持框选前原样
})
document.body.addEventListener('click', (e) => {
  if (dragState.suppressed || marqueeState.suppressed) return
  if (!zoneBlankEvent(e)) return
  applySelection({ type: 'blank-click' })
})
// 右键分区空白（工单23）：分区 DOM 面与外扩环带都可达（环带是工单89 新接的面），
// 到达即「热区内」。条目右键归条目自己的 contextmenu 监听（工单24 单项菜单），此处
// closest 滤掉不重复弹；手势进行中不弹（native 惯例）。开层走 openZoneMenu（工单30
// 起异步：先查可贴态再弹）。
document.body.addEventListener('contextmenu', (e) => {
  if (dragState.active || marqueeState.active) return
  if (!zoneBlankEvent(e)) return
  e.preventDefault() // 自绘世界观没有原生菜单，右键只属于上下文菜单
  void openZoneMenu(e.clientX, e.clientY)
})

// ---- 上下文菜单（工单23，GLOSSARY.md 词条）：shell 是 cordis 插件（cards/context-menu，
// 卸载即摘 window.deckCtxMenu，这里的触发与收起全部 ?. 空转 = 热插拔自动生效）。
// 触发在上面的分区监听里；收起裁决在面板：开层期间的任何菜单外按下（含热区外全窗
// 范围——全窗热区承接）在捕获段拦下，尾随 click/contextmenu 由 suppressed 捕获段
// 恰吞一笔——菜单外一击只收菜单：不产生选区副作用，右键也不立刻复弹。
// suppressed 是消费制而非定时制（工单23 复审修正）：置位于 pointerdown，复位只发生在
// 「吞掉首笔尾随事件」或「下一笔按下」——尾随事件是 down/up 之后的独立输入任务，
// setTimeout(0) 会抢在它前面复位（拖拽/框选的 suppressed 置位于 pointerup，无此问题）。
// 条目集是 contributor 注册位（open(x,y,items)）：本票三项内置，注册机制后续工单接入。

const menuState = { suppressed: false }

function menuOpen(): boolean {
  return window.deckCtxMenu?.isOpen() === true
}

/** 分区空白菜单开层（工单30 起异步）：【粘贴】行按剪贴板实况置灰——先查
 * desktop/clipboard-state 再 open。开层本来就是 effect 调用，异步可接受；查询走有界
 * 等待（pasteableWithinTimeout，工单30 真机 (c) 挂起形态）——超时/拒绝都按查败置灰，
 * 菜单永远开得出来，绝无界 await 挡开层。右键到弹出之间的极小窗口内若另有右键，
 * 后发者照常重弹（open 幂等换位，既有语义）。 */
async function openZoneMenu(x: number, y: number): Promise<void> {
  let pasteable = false
  try {
    pasteable = await pasteableWithinTimeout(window.deck.bridge.invoke('desktop/clipboard-state', null))
  } catch { /* invoke 同步缺席等形态：置灰 */ }
  window.deckCtxMenu?.open(x, y, ctxMenuItems(pasteable))
}

/** 内置三项（工单30 起）：【粘贴】读剪贴板落用户桌面（desktop/paste，置灰态由归约器
 * 挡）；全选走选区状态机（select-all）；恢复出厂布局复用 06 契约（与设置浮层入口同链路） */
function ctxMenuItems(pasteable: boolean): DeckCtxMenuItem[] {
  return [
    { id: 'paste', label: 'PASTE', disabled: !pasteable, run: () => pasteFromClipboard() },
    {
      id: 'select-all',
      label: 'SELECT ALL',
      run: () => applySelection({ type: 'select-all', names: [...itemByName.keys()] }),
    },
    { id: 'reset-layout', label: 'RESET LAYOUT', run: () => resetLayout('ctx-menu') },
  ]
}

window.addEventListener('pointerdown', (e) => {
  if (!menuOpen()) {
    menuState.suppressed = false // 新一笔按下先清上一笔的吞没态（其尾随事件可能没来）
    return
  }
  if ((e.target as HTMLElement).closest('#ctx-menu')) return // 菜单内按下：行自己处理
  e.stopPropagation() // 分区框选/条目拖拽的起笔监听不再看到这次按下
  e.preventDefault()
  window.deckCtxMenu?.close()
  menuState.suppressed = true
}, { capture: true })

for (const type of ['click', 'contextmenu'] as const) {
  window.addEventListener(type, (e) => {
    if (!menuState.suppressed) return
    e.stopPropagation()
    e.preventDefault()
    menuState.suppressed = false // 恰吞一笔：收起那一击的尾随事件到此为止
  }, { capture: true })
}

// ---- 单项菜单（工单24，GLOSSARY.md「上下文菜单」）：右键单个桌面项的动作条目集，
// 触发在 buildItem 的条目 contextmenu 监听里（弹/切裁决 = selection.itemMenuPlan）；
// 收起与吞没共用工单23 的面板裁决（开层全窗热区、菜单外一击即收）。动作都走
// 内核契约：打开=双击同款 desktop/launch（via 标 ctx-menu）；打开所在位置=desktop/reveal
// （explorer /select, 内核执行，搜索 reveal 同机制）；复制路径=desktop/copy-path——
// 主进程剪贴板写，面板永不激活（focusable:false），渲染层 navigator.clipboard 因文档
// 无焦点不可用。路径校验（扫描池护栏）在内核，与 launch 同款。

/** 单项动作条目集（contributor 注册位形状，同工单23 分区空白内置两项）：三动作之外，
 * 第 4/5 行【复制】【剪切】（工单29，文件级剪贴板写向，COPY PATH 之后）、
 * 第 6 行【重命名】（工单28）：原地编辑（beginRename，标签变输入框）、
 * 第 7 行【删除】（工单27）：单删直接执行不弹确认（送回收站，误删可找回）。
 * 工单59：钉到应用区/取消手钉两行随 dock 一并退役——手钉改由任务栏左组承担。 */
function itemMenuItems(item: DesktopItem): DeckCtxMenuItem[] {
  return [
    { id: 'open', label: 'OPEN', run: () => launchNames([item.name], 'ctx-menu') },
    { id: 'reveal', label: 'OPEN LOCATION', run: () => revealItem(item) },
    { id: 'copy-path', label: 'COPY PATH', run: () => copyItemPath(item) },
    { id: 'copy', label: 'COPY', run: () => clipboardFilesAction([item.name], 'copy') },
    { id: 'cut', label: 'CUT', run: () => clipboardFilesAction([item.name], 'cut') },
    { id: 'rename', label: 'RENAME', run: () => beginRename(item) },
    { id: 'delete', label: 'DELETE', run: () => trashItems([item.name]) },
  ]
}

/** 打开所在位置：desktop/reveal 结果存证（rejected/failed 分名，电池按名断言） */
function revealItem(item: DesktopItem): void {
  notify('desktop-reveal-clicked', { name: item.name, path: item.path, via: 'ctx-menu' })
  void window.deck.bridge.invoke('desktop/reveal', { path: item.path }).then(
    (r) => notify(r.ok ? 'desktop-revealed' : 'desktop-reveal-rejected', {
      name: item.name, ok: r.ok, error: r.error ?? null,
    }),
    (err: unknown) => notify('desktop-reveal-failed', { name: item.name, message: String(err) }),
  )
}

/** 复制路径：desktop/copy-path 结果存证（同上分名） */
function copyItemPath(item: DesktopItem): void {
  notify('desktop-path-copy-clicked', { name: item.name, via: 'ctx-menu' })
  void window.deck.bridge.invoke('desktop/copy-path', { path: item.path }).then(
    (r) => notify(r.ok ? 'desktop-path-copied' : 'desktop-path-copy-rejected', {
      name: item.name, ok: r.ok, error: r.error ?? null,
    }),
    (err: unknown) => notify('desktop-path-copy-failed', { name: item.name, message: String(err) }),
  )
}

// ---- 多选菜单（工单26）：右键命中选中集内条目（选区多于一条）时弹，动作作用于
// 整个选区（选区不动、无 desktop-selected 副作用）；工单27 起条目集收敛为三动作
// （打开全部 / 复制路径 / 删除全部）。名单以开层当拍选区为准（插入序 = 逐项启动顺序）；
// 收起与吞没共用工单23 的面板裁决。

/** 多选动作条目集（contributor 注册位形状，同工单23/24）：打开全部 = 双击全开同款
 * 整集逐项经 desktop/launch（launchNames，via 标 ctx-menu，逐项存证）；复制路径 =
 * desktop/copy-paths 整集多行；复制/剪切 = desktop/clipboard-copy/cut 整集进系统文件
 * 剪贴板（工单29）；删除全部 = 先弹自绘确认再整集 desktop/trash（工单27）。 */
function multiItemMenuItems(names: readonly string[]): DeckCtxMenuItem[] {
  return [
    { id: 'open-all', label: 'OPEN ALL', run: () => launchNames(names, 'ctx-menu') },
    { id: 'copy-path', label: 'COPY PATH', run: () => copyItemPaths(names) },
    { id: 'copy', label: 'COPY', run: () => clipboardFilesAction(names, 'copy') },
    { id: 'cut', label: 'CUT', run: () => clipboardFilesAction(names, 'cut') },
    { id: 'delete-all', label: 'DELETE ALL', run: () => openTrashConfirm(names) },
  ]
}

/** 复制路径（多行，工单26）：desktop/copy-paths 结果存证（desktop-paths-* 族，分名同
 * 单项 desktop-path-* 惯例）。名单路径经 itemByName 解析（launchNames 同款）——渲染层
 * 快照落后于内核池时整份拒绝（与内核「不在当前扫描池内」同语义，剪贴板不写半份名单）；
 * 多行拼接与逐条池内校验在内核（copyPaths）。 */
function copyItemPaths(names: readonly string[]): void {
  const resolved = names.map((name) => itemByName.get(name)?.path)
  if (resolved.some((p) => !p)) {
    notify('desktop-paths-copy-rejected', { names: [...names], ok: false, error: '桌面项不在当前扫描池内' })
    return
  }
  const paths = resolved as string[]
  notify('desktop-paths-copy-clicked', { names: [...names], via: 'ctx-menu' })
  void window.deck.bridge.invoke('desktop/copy-paths', { paths }).then(
    (r) => notify(r.ok ? 'desktop-paths-copied' : 'desktop-paths-copy-rejected', {
      names: [...names], ok: r.ok, error: r.error ?? null,
    }),
    (err: unknown) => notify('desktop-paths-copy-failed', { names: [...names], message: String(err) }),
  )
}

// ---- 复制与剪切（工单29，GLOSSARY.md「上下文菜单」二期条目）：单项【复制】【剪切】与
// 多选菜单共用一道执行（评审结构项收敛——两闭包除存证族名与契约方法外逐行同形，合一为
// clipboardFilesAction，effect 定族），desktop/clipboard-copy / desktop/clipboard-cut
// 一道契约两处入口。内核侧：整份池护栏、CF_HDROP + Preferred DropEffect 单事务写入
// （copy=1 / move=2）；写剪贴板不动摆位不删文件（剪切后条目仍在原地，真桌面同款）。
// 存证族 desktop-copy-* / desktop-cut-*（clicked/copied|cut/rejected/failed 三分名，
// trash/pin 惯例），电池按名断言。trashItems 是第三处同构，但存证载荷多 trashed/failed
// 两字段且确认层路径共用，强行参合得不偿失——留守（评审结构项记因）。

/** 复制/剪切的族表（effect → 契约方法 + 存证三分名 + 失败提示词）：单一出处防两族漂移 */
const CLIPBOARD_FILE_FAMILIES = {
  copy: {
    method: 'desktop/clipboard-copy',
    clicked: 'desktop-copy-clicked', ok: 'desktop-copied',
    rejected: 'desktop-copy-rejected', failed: 'desktop-copy-failed',
    failNotice: '复制失败',
  },
  cut: {
    method: 'desktop/clipboard-cut',
    clicked: 'desktop-cut-clicked', ok: 'desktop-cut',
    rejected: 'desktop-cut-rejected', failed: 'desktop-cut-failed',
    failNotice: '剪切失败',
  },
} as const

/** 复制/剪切执行（文件级，工单29）：名单路径经 itemByName 解析（copyItemPaths 同款）——
 * 渲染层快照落后于内核池时整份拒绝。结果分名存证，失败上浮提示条。via 记来源
 * （工单31 增 keyboard=Ctrl+C/X，存证族名不另立）。 */
function clipboardFilesAction(names: readonly string[], effect: 'copy' | 'cut', via: 'ctx-menu' | 'keyboard' = 'ctx-menu'): void {
  const fam = CLIPBOARD_FILE_FAMILIES[effect]
  const resolved = names.map((name) => itemByName.get(name)?.path)
  if (resolved.some((p) => !p)) {
    notify(fam.rejected, { names: [...names], ok: false, error: '桌面项不在当前扫描池内' })
    showNotice('桌面项不在当前扫描池内')
    return
  }
  const paths = resolved as string[]
  notify(fam.clicked, { names: [...names], count: names.length, via })
  void window.deck.bridge.invoke(fam.method, { paths }).then(
    (r) => {
      notify(r.ok ? fam.ok : fam.rejected, {
        names: [...names], ok: r.ok, error: r.error ?? null,
      })
      if (!r.ok) showNotice(r.error ?? fam.failNotice)
    },
    (err: unknown) => notify(fam.failed, { names: [...names], message: String(err) }),
  )
}

// ---- 粘贴（工单30，GLOSSARY.md「上下文菜单」二期条目）：分区空白菜单【粘贴】把系统
// 剪贴板文件落进用户桌面根（desktop/paste 契约：剪切语义移动、否则复制，同名「 - 副本」
// 递增不弹框，剪贴板读与落盘裁决都在内核）。置灰态在开层前经 desktop/clipboard-state
// 查询（openZoneMenu），点置灰行由 shell 归约器挡下。存证族 desktop-paste-*：
// clicked/pasted/rejected/failed（trash 三分名惯例），失败上浮提示条。无池护栏——
// 剪贴板来源是桌面之外的任意位置，菜单层不做名单解析（paste 契约无参）。

/** 粘贴执行：结果分名存证（pin/trash 同款），失败上浮提示条。via 记来源（工单31 增
 * keyboard=Ctrl+V）；剪贴板无文件时 desktop/paste ok=false 存证 rejected——与菜单置灰
 * 同语义。失败观感按 via 分流（评审 c2，pasteFailureNotice 纯函数）：菜单路保持提示条，
 * 键路静默只存证（注释与票面「键触发静默不弹层」自此名实相符）。 */
function pasteFromClipboard(via: 'ctx-menu' | 'keyboard' = 'ctx-menu'): void {
  notify('desktop-paste-clicked', { via })
  void window.deck.bridge.invoke('desktop/paste', null).then(
    (r) => {
      notify(r.ok ? 'desktop-pasted' : 'desktop-paste-rejected', {
        ok: r.ok, pasted: r.pasted, failed: r.failed, error: r.error ?? null,
      })
      const notice = r.ok ? null : pasteFailureNotice(via, r.error ?? '粘贴失败')
      if (notice) showNotice(notice)
    },
    (err: unknown) => {
      notify('desktop-paste-failed', { message: String(err) })
      const notice = pasteFailureNotice(via, String(err))
      if (notice) showNotice(notice)
    },
  )
}

// ---- 删除与删除全部（工单27，GLOSSARY.md「上下文菜单」二期条目）：desktop/trash 一道
// 契约两处入口——单项【删除】直接执行（真桌面单删同语义，回收站兜底误删），多选
// 【删除全部】先弹自绘轻量确认（列出条数，确认/取消）。内核侧：整份池护栏、逐项送
// 回收站、成功条目同拍清除摆位；权限/占用失败 ok=false 存证（desktop-trash-rejected）
// 并在菜单层上浮瞬态提示条。存证族 desktop-trash-*：confirm-opened/closed（确认层
// 开合，按钮矩形随开层存证——电池按它定位点击）、clicked/trashed/rejected/failed。

/** 删除执行（单项/确认后共用）：名单路径经 itemByName 解析（copyItemPaths 同款）——
 * 渲染层快照落后于内核池时整份拒绝。结果分名存证（同 pin 惯例），失败上浮提示条。
 * via 记来源（工单31 增 keyboard=Del；确认层的确认点击仍记 ctx-menu——点击确属菜单层）。 */
function trashItems(names: readonly string[], via: 'ctx-menu' | 'keyboard' = 'ctx-menu'): void {
  const resolved = names.map((name) => itemByName.get(name)?.path)
  if (resolved.some((p) => !p)) {
    notify('desktop-trash-rejected', { names: [...names], ok: false, error: '桌面项不在当前扫描池内' })
    showNotice('桌面项不在当前扫描池内')
    return
  }
  const paths = resolved as string[]
  notify('desktop-trash-clicked', { names: [...names], count: names.length, via })
  void window.deck.bridge.invoke('desktop/trash', { paths }).then(
    (r) => {
      notify(r.ok ? 'desktop-trashed' : 'desktop-trash-rejected', {
        names: [...names], ok: r.ok, trashed: r.trashed, failed: r.failed, error: r.error ?? null,
      })
      if (!r.ok) showNotice(r.error ?? '删除失败')
    },
    (err: unknown) => {
      notify('desktop-trash-failed', { names: [...names], message: String(err) })
      showNotice(String(err))
    },
  )
}

// ---- 删除确认层（工单27）：自绘轻量确认（settings-card 浮层先例）——开层临时取得
// 键盘焦点（Esc=取消），确认/取消两钮，点外部=取消（捕获段拦下并恰吞一笔，菜单外
// 一击即收的同款语义）。开层期间热区换全窗（declareHotZones 读 trashConfirmOpen），
// 1Hz 快照重声明不会中途覆写。按钮矩形随开层存证（电池定位点击，settings-opened
// 的滑杆矩形同法）。

const trashConfirmCard = el('trash-confirm')
const trashConfirmText = el('trash-confirm-text')
const trashConfirmOk = el('trash-confirm-ok')
const trashConfirmCancel = el('trash-confirm-cancel')
/** 开层名单（null = 关闭态）；名单以菜单开层当拍选区为准，确认即对该名单整份 trash */
let trashConfirmNames: readonly string[] | null = null

function trashConfirmOpen(): boolean {
  return trashConfirmNames !== null
}

function rectOfBox(r: DOMRect): { x: number; y: number; w: number; h: number } {
  return { x: r.left, y: r.top, w: r.width, h: r.height }
}

type TrashConfirmCloseReason = 'confirm' | 'cancel' | 'outside' | 'esc' | 'blur'

function openTrashConfirm(names: readonly string[]): void {
  if (trashConfirmOpen()) return
  trashConfirmNames = [...names]
  trashConfirmText.textContent = names.length === 1
    ? `DELETE 1 ITEM?\n${names[0]}`
    : `DELETE ${names.length} ITEMS?\n${names.join('\n')}`
  trashConfirmCard.style.display = 'block'
  dispatchKeyboardGate({ type: 'overlay-opened', name: 'trash-confirm' }) // 浮层接管键盘（仲裁单点，工单31）
  trashConfirmCard.focus()
  notify('desktop-trash-confirm-opened', {
    names: [...names], count: names.length,
    confirm: rectOfBox(trashConfirmOk.getBoundingClientRect()),
    cancel: rectOfBox(trashConfirmCancel.getBoundingClientRect()),
  })
  declareHotZones()
}

function closeTrashConfirm(reason: TrashConfirmCloseReason): void {
  const names = trashConfirmNames
  if (!names) return
  trashConfirmNames = null
  trashConfirmCard.style.display = 'none'
  dispatchKeyboardGate({ type: 'overlay-closed', name: 'trash-confirm' }) // 选区仍非空则仲裁保持 on（工单31）
  notify('desktop-trash-confirm-closed', { reason, count: names.length })
  declareHotZones()
  if (reason === 'confirm') trashItems(names)
}

trashConfirmOk.addEventListener('click', () => closeTrashConfirm('confirm'))
trashConfirmCancel.addEventListener('click', () => closeTrashConfirm('cancel'))
trashConfirmCard.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault()
    closeTrashConfirm('esc')
  }
})
trashConfirmCard.addEventListener('focusout', (e) => {
  const to = e.relatedTarget as Node | null
  if (to && trashConfirmCard.contains(to)) return // 焦点仍在确认层内（两钮之间转移）
  closeTrashConfirm('blur')
})
window.addEventListener('pointerdown', (e) => {
  if (!trashConfirmOpen()) return
  if ((e.target as HTMLElement).closest('#trash-confirm')) return // 层内按下：钮自己处理
  e.stopPropagation() // 点外部 = 取消，那一击不落任何面板语义（框选/条目起笔不再看到）
  e.preventDefault()
  closeTrashConfirm('outside')
}, { capture: true })

// 面板的拖拽语义全是自绘手势（摆位、框选各自监听 pointer 流）。浏览器原生 HTML5
// 拖拽在本面板没有合法用途，且代价是整个面板停摆：一旦 DoDragDrop 会话起不来收不掉，
// 满屏 Ghost 幽灵窗跟着光标走、渲染主线程进模态循环，此后点击进得去但事件不发、
// 快照不上屏（真机实证：工单59 验收首跑 30 余段连锁判死）。面板常驻不重启，冻住就是
// 永久失去交互——故在源头掐掉。任务栏是另一扇窗、另一份文档，其换位拖拽不受影响。
document.addEventListener('dragstart', (e) => e.preventDefault())

// ---- 动作失败提示（工单27 AC「菜单层有可见提示」；工单28 重命名失败复用同一条）：
// 权限/占用/重名等失败如实上浮的瞬态条，数秒自隐；纯展示不接交互（无热区，指针穿透到下层）。

const trashNotice = el('trash-notice')
let trashNoticeTimer: ReturnType<typeof setTimeout> | null = null

function showNotice(message: string): void {
  trashNotice.textContent = message
  trashNotice.style.display = 'block'
  if (trashNoticeTimer !== null) clearTimeout(trashNoticeTimer)
  trashNoticeTimer = setTimeout(() => {
    trashNotice.style.display = 'none'
    trashNoticeTimer = null
  }, 6000)
}

// ---- 原地重命名（工单28，GLOSSARY.md「上下文菜单」二期条目）：单项菜单【重命名】→
// 条目标签原地变输入框（预填显示名、预选主名段——真桌面肌肉记忆），Enter/失焦确认、
// Esc 取消。编辑期间临时取得键盘焦点（trash 确认层同款 keyboard-mode 通道，面板永不
// 激活的前提下输入框才收得到键）；确认走 desktop/rename 契约（池护栏、文件名合法性、
// 重名冲突校验与摆位同拍迁移全在内核），结果分名存证（started/renamed/rejected/failed/
// cancelled，电池按名断言）；失败上浮瞬态提示条（工单27 同款）并还原原名——盘面没改
// 成功，摆位与文件名都还是旧的。与现名全同的提交 = 幂等空转（内核同语义），不发契约。
// 1Hz 快照重建（后台使用分数重排等指纹噪声，与编辑无关）会整块摘掉输入框：编辑器
// **原地重锚**而非取消——旧输入框的原文带走，条目还在池里就在新 DOM 上重开（打字
// 进行中则光标接在已输入尾巴上续传）；条目真没了（外部删除竞态）才按取消收场。
// 首轮真机电池实证：取消式守卫让后台重排杀掉编辑（started 后 229ms 被 rebuild 收场），
// 真桌面语义是编辑存活于后台刷新，重锚是正解。

interface RenameEditorState {
  active: boolean
  /** 收场护栏：endRenameEditor 的 DOM 摘除会触发 focusout，防再入误判为失焦确认 */
  closing: boolean
  item: DesktopItem | null
  input: HTMLInputElement | null
  label: HTMLElement | null
}

const renameEditor: RenameEditorState = {
  active: false, closing: false, item: null, input: null, label: null,
}

/** 预选主名段（真桌面同款）：file/folder 的显示名有扩展时选最后一个点之前，
 * .lnk/.url 的显示名本就无扩展、无点选全部。 */
function selectRenameStem(item: DesktopItem, input: HTMLInputElement): void {
  const dot = item.display.lastIndexOf('.')
  const end = (item.kind === 'file' || item.kind === 'folder') && dot > 0 ? dot : item.display.length
  input.setSelectionRange(0, end)
}

/** 输入框工厂（开编辑与重锚共用）：预填、键盘路径、失焦确认都在这里接线 */
function createRenameInput(): HTMLInputElement {
  const input = document.createElement('input')
  input.className = 'rename-input'
  input.type = 'text'
  input.maxLength = 255
  input.spellcheck = false
  input.setAttribute('autocomplete', 'off')
  input.addEventListener('keydown', (e) => {
    if (!renameEditor.active) return
    if (e.key === 'Enter') {
      e.preventDefault()
      commitRename()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation() // Esc 只归编辑器：取消编辑，不再外溢成别的收层语义
      cancelRename('esc')
    }
  })
  input.addEventListener('focusout', () => {
    if (!renameEditor.active || renameEditor.closing) return
    commitRename()
  })
  return input
}

function beginRename(item: DesktopItem): void {
  if (renameEditor.active) return // 已在编辑：忽略再次触发（菜单开层期间不可达，防御性空转）
  const node = document.querySelector<HTMLElement>(`.ditem[data-name="${CSS.escape(item.name)}"]`)
  const label = node?.querySelector<HTMLElement>('.label')
  if (!node || !label) return // 条目刚被快照重建摘掉：无从原地编辑（防御性空转）
  const input = createRenameInput()
  input.value = item.display
  label.replaceWith(input)
  renameEditor.active = true
  renameEditor.closing = false
  renameEditor.item = item
  renameEditor.input = input
  renameEditor.label = label
  dispatchKeyboardGate({ type: 'overlay-opened', name: 'rename' }) // 键盘模式开（仲裁单点，工单31）：输入框要接键盘
  input.focus()
  selectRenameStem(item, input)
  const r = input.getBoundingClientRect()
  notify('desktop-rename-started', {
    name: item.name, display: item.display,
    input: { x: r.left, y: r.top, w: r.width, h: r.height },
  })
}

/** 快照重建前的静默摘除：状态清零（输入框随重建销毁，无 focusout 可言），键盘模式
 * 保持开、不发存证——条目还在池里就由 renderDesktop 在新 DOM 上重锚（reanchorRename）。 */
function detachRenameEditor(): { item: DesktopItem; value: string } | null {
  if (!renameEditor.active || !renameEditor.item) return null
  const carry = { item: renameEditor.item, value: renameEditor.input?.value ?? '' }
  renameEditor.active = false
  renameEditor.closing = false
  renameEditor.input = null
  renameEditor.label = null
  renameEditor.item = null
  return carry
}

/** 重锚（快照重建后）：同一编辑会话在新 DOM 上续开——原文带走；原文还是显示名则
 * 重选主名段（打字未开始），已改动则光标接尾（打字进行中的续传语义）。不发存证：
 * started 属于会话首开，重锚只是同一会话换了张皮。 */
function reanchorRename(item: DesktopItem, value: string): boolean {
  const node = document.querySelector<HTMLElement>(`.ditem[data-name="${CSS.escape(item.name)}"]`)
  const label = node?.querySelector<HTMLElement>('.label')
  if (!node || !label) return false
  const input = createRenameInput()
  input.value = value
  label.replaceWith(input)
  renameEditor.active = true
  renameEditor.closing = false
  renameEditor.item = item
  renameEditor.input = input
  renameEditor.label = label
  input.focus()
  if (value === item.display) selectRenameStem(item, input)
  else input.setSelectionRange(value.length, value.length)
  return true
}

/** 收场：摘输入框、原位放回标签（textContent 由调用方定夺——成功可乐观上新名）、
 * 键盘模式关。返回输入原文与标签节点（成功后的乐观上名要认节点，快照重建会换血）。 */
function endRenameEditor(nextLabelText: string): { typed: string; label: HTMLElement | null } {
  const { input, label } = renameEditor
  renameEditor.closing = true
  const typed = input ? input.value : ''
  if (label) label.textContent = nextLabelText
  input?.replaceWith(label!)
  dispatchKeyboardGate({ type: 'overlay-closed', name: 'rename' }) // 键盘模式关（仲裁单点，工单31）：选区仍非空则保持 on
  renameEditor.active = false
  renameEditor.closing = false
  renameEditor.input = null
  renameEditor.label = null
  renameEditor.item = null
  return { typed, label }
}

/** 显示名口径的乐观上名：快捷方式/网址剥掉原扩展（与内核 display 推导同规），
 * 其余即文件名。只补「提交成功 → 下一拍快照重建」之间的观感间隙，权威口径仍是快照。 */
function optimisticDisplay(item: DesktopItem, fileName: string): string {
  if (item.kind === 'shortcut' || item.kind === 'url') {
    const dot = item.name.lastIndexOf('.')
    const ext = dot >= 0 ? item.name.slice(dot).toLowerCase() : ''
    if (ext && fileName.toLowerCase().endsWith(ext)) return fileName.slice(0, -ext.length)
  }
  return fileName
}

function commitRename(): void {
  const item = renameEditor.item
  if (!item) return
  const { typed, label } = endRenameEditor(item.display)
  const to = typed.trim()
  if (to === item.display || to === item.name) return // 与现名全同：幂等空转（内核同语义）
  void window.deck.bridge.invoke('desktop/rename', { name: item.name, to }).then(
    (r) => {
      if (r.ok) {
        notify('desktop-renamed', { name: item.name, to: r.to ?? to, ok: true })
        if (label?.isConnected) label.textContent = optimisticDisplay(item, r.to ?? to)
      } else {
        notify('desktop-rename-rejected', { name: item.name, to, ok: false, error: r.error ?? null })
        showNotice(r.error ?? '重命名失败')
      }
    },
    (err: unknown) => {
      notify('desktop-rename-failed', { name: item.name, to, message: String(err) })
      showNotice(String(err))
    },
  )
}

function cancelRename(reason: 'esc' | 'rebuild'): void {
  const item = renameEditor.item
  if (!item) return
  endRenameEditor(item.display)
  notify('desktop-rename-cancelled', { name: item.name, reason })
}


// ---- 编排应用：文档分组列 / 几何（config 下发） ----

function applyLayout(layout: PanelSnapshot['layout']): void {
  const key = JSON.stringify(layout)
  if (key === layoutApplied) return
  layoutApplied = key
  docZone.style.left = `${layout.docZone.left}px`
  docZone.style.top = `${layout.docZone.top}px`
  docZone.style.maxWidth = `${layout.docZone.maxWidth}px`
  for (const grid of document.querySelectorAll<HTMLElement>('.doc-group .ggrid')) {
    grid.style.gridTemplateRows = `repeat(${layout.docMaxRows}, auto)`
  }
}

function renderDesktop(state: DesktopState, layout: PanelSnapshot['layout']): void {
  applyLayout(layout)
  itemByName = new Map(state.items.map((i) => [i.name, i]))
  if (state.fingerprint === desktopFingerprintSeen) return
  desktopFingerprintSeen = state.fingerprint
  // 编辑中的重命名输入框会被这次重建整块摘掉（输入框在条目 DOM 里）：静默 detach、
  // 重建后在同名词目的新节点上重锚（编辑存活于后台刷新——后台使用分数重排等指纹
  // 噪声与编辑无关）；条目不在新池（外部删除竞态）才按取消收场。fingerprint 未变的
  // 快照在上方早退，不经过这里（工单28；首轮真机电池实证取消式守卫会杀掉编辑）。
  const carried = detachRenameEditor()
  let renameCarry: { item: DesktopItem; value: string } | null = carried
  if (carried && !state.items.some((i) => i.name === carried.item.name)) {
    notify('desktop-rename-cancelled', { name: carried.item.name, reason: 'rebuild' })
    dispatchKeyboardGate({ type: 'overlay-closed', name: 'rename' }) // 编辑会话随条目消失收场（仲裁单点，工单31）
    renameCarry = null
  }
  const byName = itemByName
  // 文档区：按组序铺分组列（组内序即 plan.docs 的 rank 序）
  docGroups.textContent = ''
  for (const group of GROUP_ORDER) {
    const entries = state.plan.docs.filter((d) => d.group === group)
    if (!entries.length) continue
    const block = document.createElement('div')
    block.className = 'doc-group'
    const glabel = document.createElement('div')
    glabel.className = 'glabel'
    glabel.textContent = GROUP_LABELS[group]
    const grid = document.createElement('div')
    grid.className = 'ggrid'
    grid.style.gridTemplateRows = `repeat(${layout.docMaxRows}, auto)`
    for (const entry of entries) {
      const item = byName.get(entry.name)
      if (item) grid.appendChild(buildItem(item))
    }
    block.append(glabel, grid)
    docGroups.appendChild(block)
  }
  // 重锚：新 DOM 就位后把编辑会话接回同名词目（原文续传，见工单28 注记）
  if (renameCarry) reanchorRename(renameCarry.item, renameCarry.value)
  // 快照重建后按名恢复选区、消失条目剔除（工单20：选区是渲染层瞬态，1Hz 重建不丢）
  applySelection({ type: 'reconcile', liveNames: state.items.map((i) => i.name) })
  declareHotZones()
  desktopRenderCount += 1
  // 存证：条目集合 + 编排序 + 各条目矩形（电池按名定位探针落点/拖放源坐标）+ 当前选区
  notify('desktop-rendered', {
    n: desktopRenderCount,
    fingerprint: state.fingerprint,
    apps: state.items.filter((i) => i.zone === 'app').length,
    docs: state.plan.docs.length,
    names: state.items.map((i) => i.name),
    sel: [...selection.names],
    docEntries: state.plan.docs,
    rects: state.items.map((item) => {
      const node = document.querySelector<HTMLElement>(`.ditem[data-name="${CSS.escape(item.name)}"]`)
      if (!node) return { name: item.name, zone: item.zone, rect: null }
      const r = node.getBoundingClientRect()
      return { name: item.name, zone: item.zone, rect: { x: r.left, y: r.top, w: r.width, h: r.height } }
    }),
  })
}

// ---- 设置浮层（工单08）：卡片底色透明度全局滑杆 + 恢复出厂布局入口 ----
// 滑杆 input 即时改 CSS 变量 --card-alpha（.card 的底色，文字全部
// 实色不动）；持久化经内核契约 settings/set-card-opacity（内核整份回写 config.json），
// 回推经 settings/changed 与快照 reconcile（applyCardAlpha 幂等）。
// 浮层开关：点击 settings-btn 切换；ESC 关闭；失焦关闭 = focusout 且焦点未落回浮层
// 内（面板穿透之下「点外部」根本到不了渲染层，与 07 失焦退待机同一语义边界）。
// 恢复出厂布局动作本体属 06，这里接入口（存证 notify 名沿用 06 电池契约）。

const settingsBtn = el('settings-btn')
const settingsCard = el('settings-card')
const opacitySlider = el('opacity-slider') as HTMLInputElement
const opacityValue = el('opacity-value')
const settingsReset = el('settings-reset')
const settingsExit = el('settings-exit')
const taskbarToggle = el('taskbar-toggle') as HTMLInputElement
const taskbarToggleState = el('taskbar-toggle-state')
const settingsCardsList = el('settings-cards-list')
let settingsOpen = false
let appliedOpacity: number | null = null

/** 应用透明度：CSS 变量 + 滑杆/数值 reconcile + 变化存证（boot/滑杆/回推三路共用，幂等） */
function applyCardAlpha(alpha: number): void {
  const clamped = Math.min(1, Math.max(0, alpha))
  document.documentElement.style.setProperty('--card-alpha', clamped.toFixed(3))
  const value = Math.round(clamped * 100)
  opacityValue.textContent = `${pad3(value)}%`
  // 滑杆正被拖拽（持焦点）时不回写位置——用户是唯一来源；其余路径照常 reconcile
  if (document.activeElement !== opacitySlider) opacitySlider.value = String(value)
  if (appliedOpacity !== clamped) {
    appliedOpacity = clamped
    notify('settings-opacity-applied', { value })
  }
}

function renderSettings(s: SettingsState): void {
  lastSettings = s // 最近一次内核态：开关 invoke 失败时的回滚真相
  applyCardAlpha(s.cardOpacity)
  renderCardToggles(s)
}

// ---- 卡片显隐开关列表（工单101）----
// 行 = 全部已发现插件包（快照 plugins 段 + 停用集并集），每行名称 + 开关。停用经
// settings/set-card-enabled 落内核（整份回写 config.plugins.disabled），插件宿主重扫清单
// 剔除该包 → syncPlugins 卸载 → 热区随 DOM 变更自动重声明；包文件一律不动。快照 plugins
// 段天然不含停用包，其行以最近见过的名称（本会话内记得）或 id 兜底显示；开关回弹即恢复。

/** 插件包 id → 最近见过的可读名（快照在场即记；停用后行仍显示人话，重启后 id 兜底） */
const cardNames = new Map<string, string>()
let lastSettings: SettingsState | null = null
/** 行签名：名单/名称/开关态任一变了才重建 DOM（1Hz 快照 reconcile 不抖动交互中的行） */
let cardRowsKey: string | null = null

function renderCardToggles(s: SettingsState): void {
  const rows: Array<{ id: string; name: string; enabled: boolean }> = []
  const disabled = new Set(s.disabledCards)
  for (const p of lastSnapshot?.plugins ?? []) {
    cardNames.set(p.id, p.name)
    rows.push({ id: p.id, name: p.name, enabled: !disabled.has(p.id) })
  }
  for (const id of [...disabled].sort()) {
    if (!rows.some((r) => r.id === id)) rows.push({ id, name: cardNames.get(id) ?? id, enabled: false })
  }
  const key = JSON.stringify(rows)
  if (key === cardRowsKey) return
  cardRowsKey = key
  settingsCardsList.replaceChildren(...rows.map((row) => {
    const line = document.createElement('div')
    line.className = 'set-row'
    const label = document.createElement('span')
    label.className = 'set-label'
    label.textContent = row.name
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.className = 'card-toggle'
    input.dataset['cardId'] = row.id
    input.checked = row.enabled
    input.setAttribute('aria-label', `显示或隐藏插件包 ${row.name}`)
    const state = document.createElement('span')
    state.className = 'card-toggle-state'
    state.textContent = row.enabled ? 'ON' : 'OFF'
    line.append(label, input, state)
    return line
  }))
}

// 开关切换（事件托付：行随 reconcile 重建也不换监听）：先存证意图，再经内核落盘生效；
// 失败以最近一次内核态回滚勾选（内核未变）。生效回执里同时带回新停用集（reconcile 用）。
settingsCardsList.addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement
  const id = input.dataset['cardId']
  if (!id) return
  const enabled = input.checked
  notify('settings-card-toggle', { id, enabled })
  void window.deck.bridge.invoke('settings/set-card-enabled', { id, enabled }).then(
    (s) => {
      notify('settings-card-set', { id, enabled: !s.disabledCards.includes(id) })
      renderSettings(s)
    },
    (err: unknown) => {
      notify('settings-card-failed', { id, message: String(err) })
      cardRowsKey = null // 强制重建，勾选态回滚到内核真相
      if (lastSettings) renderSettings(lastSettings)
    },
  )
})

/** 任务栏逃生开关（工单50）：勾选态 reconcile——开层拉取、切换回执、taskbar/changed
 * 回推三路共用，幂等。开关关 = 还原原生任务栏的自救通道（内核落盘 config 并销条带窗）。 */
function applyTaskbarEnabled(enabled: boolean): void {
  taskbarToggle.checked = enabled
  taskbarToggleState.textContent = enabled ? 'ON' : 'OFF'
}

type SettingsCloseReason = 'esc' | 'blur' | 'toggle'

function openSettings(): void {
  if (settingsOpen) return
  settingsOpen = true
  // 键盘模式开（仲裁单点，工单31）：浮层要接 ESC/滑杆拖拽后的键盘路径，临时取得键盘焦点
  dispatchKeyboardGate({ type: 'overlay-opened', name: 'settings' })
  settingsCard.style.display = 'block'
  settingsCard.focus()
  // 逃生开关与内核态对齐（工单50）：每次开层拉一手真值，不等回推
  void window.deck.bridge.invoke('taskbar/get-state', null).then(
    (s) => applyTaskbarEnabled(s.enabled),
    () => { /* 拉取失败保持现状，回推会补齐 */ },
  )
  // 滑杆/开关矩形随开层存证（电池按它们定位拖拽/点击落点，desktop-rendered rects 同法）。
  // 卡片开关行矩形（工单101）：id + 当拍勾选态 + 勾选框矩形（电池按 id 定位点击开关行）；
  // 列表在浮层隐藏期间也持续 reconcile，此处矩形按已显示布局取（display 先行恢复）。
  const sr = opacitySlider.getBoundingClientRect()
  const tr = taskbarToggle.getBoundingClientRect()
  const cards = Array.from(settingsCardsList.querySelectorAll<HTMLInputElement>('input.card-toggle')).map((input) => {
    const r = input.getBoundingClientRect()
    return { id: input.dataset['cardId'] ?? '', enabled: input.checked, rect: { x: r.left, y: r.top, w: r.width, h: r.height } }
  })
  notify('settings-opened', {
    slider: { x: sr.left, y: sr.top, w: sr.width, h: sr.height },
    taskbarToggle: { x: tr.left, y: tr.top, w: tr.width, h: tr.height },
    cards,
    value: appliedOpacity == null ? null : Math.round(appliedOpacity * 100),
  })
  declareHotZones()
}

function closeSettings(reason: SettingsCloseReason): void {
  if (!settingsOpen) return
  settingsOpen = false
  // 键盘模式关（仲裁单点，工单31）：恢复不可聚焦+钉底；焦点悬空不还原（spec 拍板）。
  // 失焦引发的 focusout 再入被 settingsOpen 早退拦住。选区仍非空则仲裁保持 on。
  dispatchKeyboardGate({ type: 'overlay-closed', name: 'settings' })
  settingsCard.style.display = 'none'
  notify('settings-closed', { reason })
  declareHotZones()
}

settingsBtn.addEventListener('mousedown', (e) => {
  // 点击按钮不转移焦点：浮层开着时点按钮只走 click 开关，不触发 focusout 误关
  e.preventDefault()
})
settingsBtn.addEventListener('click', () => {
  if (settingsOpen) closeSettings('toggle')
  else openSettings()
})

settingsCard.addEventListener('mousedown', (e) => {
  // 滑杆/逃生开关/卡片开关（工单101）要收焦点（拖拽/键盘切换中渲染层不抢位）；
  // 其余区域保焦点，点击不触发失焦关层
  if (e.target !== opacitySlider && e.target !== taskbarToggle
    && !(e.target instanceof HTMLInputElement && e.target.classList.contains('card-toggle'))) {
    e.preventDefault()
  }
})

settingsCard.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault()
    closeSettings('esc')
  }
})

settingsCard.addEventListener('focusout', (e) => {
  const to = e.relatedTarget as Node | null
  if (to && settingsCard.contains(to)) return // 焦点仍在浮层内（如滑杆）
  closeSettings('blur')
})

opacitySlider.addEventListener('input', () => {
  const value = Math.round(Number(opacitySlider.value))
  applyCardAlpha(value / 100) // 滑杆持焦点，applyCardAlpha 不会回写滑杆位
  notify('settings-opacity-input', { value })
  void window.deck.bridge.invoke('settings/set-card-opacity', { opacity: value / 100 }).then(
    (s) => notify('settings-opacity-set', { value: Math.round(s.cardOpacity * 100) }),
    (err: unknown) => notify('settings-opacity-failed', { message: String(err) }),
  )
})

// 逃生开关切换（工单50）：先存证意图，再经内核落盘生效；失败回滚勾选态（内核未变）。
taskbarToggle.addEventListener('change', () => {
  const enabled = taskbarToggle.checked
  notify('settings-taskbar-toggle', { enabled })
  void window.deck.bridge.invoke('taskbar/set-enabled', { enabled }).then(
    (s) => {
      applyTaskbarEnabled(s.enabled)
      notify('settings-taskbar-set', { enabled: s.enabled })
    },
    (err: unknown) => {
      applyTaskbarEnabled(!enabled)
      notify('settings-taskbar-failed', { message: String(err) })
    },
  )
})

/** 恢复出厂布局（06 契约复用）：设置浮层入口与上下文菜单（工单23）共用同一链路与存证名 */
function resetLayout(from: 'settings' | 'ctx-menu'): void {
  notify('desktop-reset-clicked', { from })
  void window.deck.bridge.invoke('desktop/reset-layout', null).then(
    (r) => notify('desktop-layout-reset', { ok: r.ok, cleared: r.cleared }),
    (err: unknown) => notify('desktop-reset-failed', { message: String(err) }),
  )
}

settingsReset.addEventListener('click', () => resetLayout('settings'))

// 退出面板（工单83）：设置浮层底部按钮——托盘被系统折叠/任务栏特性未完成时的本体退出
// 入口。经 app/quit 走主进程 app.quit()，与托盘菜单「退出面板」同一 before-quit 优雅
// 退出收敛（窗口销毁、托盘 destroy、桌面图标/原生任务栏还原）。先存证后 invoke（退出
// 竞态下 clicked 必已在档）；invoke 失败（quit 未装配等异常态）面板还活着，提示条如实上报。
function exitPanel(): void {
  notify('settings-exit-clicked', {})
  // ok 即退出中，进程随后消亡、无回执处理；catch 只接异常态（quit 未装配等）——面板
  // 还活着，提示条如实上报
  window.deck.bridge.invoke('app/quit', null).catch(
    (err: unknown) => showNotice(`退出失败：${String(err)}`),
  )
}

settingsExit.addEventListener('click', () => exitPanel())

window.deck.bridge.on('settings/changed', (s) => renderSettings(s))
// 逃生开关状态回推（工单50）：他端切换（如条带侧动作、插件卸载终态帧）即时对齐勾选态
window.deck.bridge.on('taskbar/changed', (s) => applyTaskbarEnabled(s.enabled))

// ---- 键盘全局编排（工单31，ADR-0006 收官）：window keydown 捕获段优先级编排——
// 浮层（既有自处理保持不动：浮层开着时本段对一切按键不拦不抢先，事件落到浮层聚焦
// 元素自己的 keydown 监听）> 菜单（esc 收起：菜单开着 Esc 只关菜单不清选区）>
// 选区清空。六键路由（Del/Enter/Ctrl+A/Ctrl+C/X/V）只在选区非空且无浮层、无菜单
// 开层期间接管（条件裁决在 keyboard-gate.ts 纯逻辑），动作复用既有动作闭包——存证
// 族名不另立，via 标 keyboard 供电池分源。捕获段接管时 preventDefault +
// stopPropagation 恰吃一笔不双吃；放行（返回 null / 双否）时本段零动作。

/** 六键动作执行（选区非空期间）：Del=既有删除语义（单项直删、多选弹确认层——工单27）、
 * Enter=打开选中（当前选区整份：多选按插入序逐项、单选单条；不复活吞集——评审 c1，
 * 整集启动语义是双击路径专属，dblclick 仍走 launchListOf）、Ctrl+A=select-all 事件进
 * 选区状态机、Ctrl+C/X=文件级复制/剪切（工单29）、Ctrl+V=粘贴（工单30：剪贴板无文件时
 * desktop/paste ok=false 存证 rejected，与菜单置灰同语义；键路静默不弹提示条——评审 c2）。 */
function runKeyboardAction(action: KeyboardActionType): void {
  const names = [...selection.names]
  if (!names.length) return
  if (action === 'delete') {
    if (names.length === 1) trashItems(names, 'keyboard')
    else openTrashConfirm(names)
  } else if (action === 'open') {
    launchNames(keyboardOpenTargets(selection), 'keyboard')
  } else if (action === 'select-all') {
    applySelection({ type: 'select-all', names: [...itemByName.keys()] })
  } else if (action === 'copy') {
    clipboardFilesAction(names, 'copy', 'keyboard')
  } else if (action === 'cut') {
    clipboardFilesAction(names, 'cut', 'keyboard')
  } else if (action === 'paste') {
    pasteFromClipboard('keyboard')
  }
}

window.addEventListener('keydown', (e) => {
  // 装配口径唯一出处 keyboard-gate.keyRoutingContextOf（工单100 起：插件档在持等同浮层开）
  const ctx = keyRoutingContextOf(keyboardGate, menuOpen())
  if (e.key === 'Escape') {
    const plan = escapePlan(ctx)
    if (!plan.closeMenu && !plan.clearSelection) return // 浮层自处理/无事可做：不拦，既有监听接手
    e.preventDefault()
    e.stopPropagation() // Esc 定序恰吃一笔：菜单开着只关菜单（选区不动），清空选区也不外溢
    if (plan.closeMenu) window.deckCtxMenu?.escDismiss()
    else applySelection({ type: 'blank-click' }) // 清空语义唯一出处仍是选区状态机（连带仲裁还原键盘模式）
    return
  }
  const action = routeSelectionKey(e.key, e.ctrlKey, ctx)
  if (!action) return
  e.preventDefault()
  e.stopPropagation()
  runKeyboardAction(action)
}, { capture: true })

// ---- 总渲染（快照到达即刷新全部卡片 + 桌面组件） ----

/** 插件运行时的宿主依赖：存证与桥接沿用面板同一条通道，DOM 变了重声明热区 */
const pluginDeps: PluginRuntimeDeps = {
  notify,
  invoke: (method, payload) => window.deck.bridge.invoke(method, payload),
  on: (event, listener) => window.deck.bridge.on(event, listener),
  // 插件键盘档进宿主单点仲裁（工单100）：键盘档声明 = 归一仲裁的一种具名事件（与选区/
  // 浮层同一把合成开关，单通道不另立——keyboard-mode-on/off 同相是电池硬断言口径）。
  // 名字带插件 id 命名空间，键盘档记账/去重/卸载回收在插件运行时（plugins.ts）。
  onKeyboardTier: (id, tier, held) => dispatchKeyboardGate(
    held
      ? { type: 'tier-acquired', name: `plugin:${id}:${tier}` }
      : { type: 'tier-released', name: `plugin:${id}:${tier}` },
  ),
  onDomChanged: declareHotZones,
}

/** 最近一拍快照：插件清单变化时复用（渲染层只保留这一份，不另建缓存） */
let lastSnapshot: PanelSnapshot | null = null

function render(snap: PanelSnapshot): void {
  lastSnapshot = snap
  renderDesktop(snap.desktop, snap.layout)
  renderSettings(snap.settings)
  // 桌面组件（工单10 起）：全由插件自己渲染（时钟/天气/会话列表 + 日历随工单99 成包），
  // 宿主只负责把清单与裁剪后的视图喂过去。
  syncPlugins(snap.plugins, snap, pluginDeps)
}

// ---- 热区声明（全部卡片 + 桌面承载区） ----
// 桌面分区按「容器可见矩形外扩 ZONE_HOTZONE_PAD_PX、裁到窗内」声明（工单89，几何
// 唯一出处 zone-hotzone.ts）：空分区不占热区（不产生点击死区，穿透照旧）；容器带进
// 内边距（光标在容器边停留仍可交互）。同一几何也门控 body 级分区语义路由
// （zoneAtPoint）——声明与路由必须同源，环带点击才有语义。

function zoneHotzoneRectOf(zone: HTMLElement): ZoneBox | null {
  const r = zone.getBoundingClientRect()
  return zoneHotzoneRect(
    { x: r.left, y: r.top, w: r.width, h: r.height },
    { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight },
    zone.querySelector('.ditem') !== null,
  )
}

function declareHotZones(): void {
  // 手势进行中（拖拽摆位/框选）、菜单开层（工单23）或删除确认开层（工单27）保持全窗
  // 热区：1Hz 快照重建会走到这里重声明常规热区，若中途覆写回小矩形，指针恰在分区包围
  // 盒外时面板转穿透、指针流即断（矩形残留屏上/菜单外一击收不到）。菜单开层由 shell 的
  // isOpen 判定（热插拔：插件卸载即 undefined，自动恢复常规热区）。
  if (dragState.active || marqueeState.active || menuOpen() || trashConfirmOpen()) {
    const id = trashConfirmOpen() ? 'trash-confirm'
      : menuOpen() ? 'menu' : dragState.active ? 'drag' : 'marquee'
    window.deck.host.setHotZones([{
      id, x: 0, y: 0, w: window.innerWidth, h: window.innerHeight,
    }])
    return
  }
  const rects: HotzoneRect[] = Array.from(document.querySelectorAll<HTMLElement>('.card')).map((card) => {
    const r = card.getBoundingClientRect()
    return { id: card.id, x: r.left, y: r.top, w: r.width, h: r.height }
  })
const doc = zoneHotzoneRectOf(docZone)
  if (doc) rects.push({ id: 'doc-zone', ...doc })
  const sb = settingsBtn.getBoundingClientRect()
  if (sb.width > 0) rects.push({ id: 'settings-btn', x: sb.left, y: sb.top, w: sb.width, h: sb.height })
  // 浮层内的复位按钮自带矩形热区（电池按 id 定位点击，旧独立按钮同法）；随浮层显隐
  const sr = settingsReset.getBoundingClientRect()
  if (sr.width > 0) rects.push({ id: 'settings-reset', x: sr.left, y: sr.top, w: sr.width, h: sr.height })
  // 退出面板按钮（工单83）同法：矩形随浮层显隐进热区（电池按 id 定位点击）
  const se = settingsExit.getBoundingClientRect()
  if (se.width > 0) rects.push({ id: 'settings-exit', x: se.left, y: se.top, w: se.width, h: se.height })
  // 关闭中的设置浮层矩形为 0（display:none），与一切零尺寸矩形一起不进热区（不留死区）
  window.deck.host.setHotZones(rects.filter((r) => r.w > 0 && r.h > 0))
}

// 插件清单变化即时对齐（放入/移除/改资产即生效，不等 1Hz 快照）：
// 复用最近一拍快照——插件只关心自己能力内的段，无需为此多问内核一次。
window.deck.bridge.on('plugins/changed', (list) => {
  notify('plugins-changed', { ids: list.map((p) => p.id), status: list.map((p) => `${p.id}:${p.status}`) })
  if (!lastSnapshot) return // 快照还没到（启动瞬间）：下一拍 render 自会带上 plugins 段
  syncPlugins(list, { ...lastSnapshot, plugins: list }, pluginDeps)
  declareHotZones()
})

void window.deck.bridge.invoke('panel/snapshot', null).then(render, (err: unknown) => {
  notify('snapshot-error', { message: String(err) })
})
window.deck.bridge.on('panel/changed', render)

declareHotZones()
if (document.fonts) document.fonts.ready.then(declareHotZones)
