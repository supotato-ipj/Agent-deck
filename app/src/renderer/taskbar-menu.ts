// 任务栏弹窗菜单通用载页（工单193）：自绘竖排菜单面板（纯文本行）的渲染端。从托盘
// 溢出浮层页（taskbar-overflow.ts）泛化而来——开合与回报纪律逐字同源：
// - 行集自足于内核契约：页自取 taskbar/get-state，行推导走域适配器（与条带视图同一
//   份纯函数）——开层请求不携带行集，浮层行与条带视图永不各判一次；
// - 内容实测回报（ready）：宿主据此定窗并锚光标弹出；rows 携带行矩形（相对客户区，
//   电池据此取行点击坐标）与 id/label（电池据此对账动作身份）；
// - 收层路径：点行（动作存证先行、收层殿后——红轮实证：先收层后回执时窗已销、
//   pending .then 随渲染进程一起死）、名单拆空（宿主 changed 推进重渲后为空）、
//   点面板空白、点面板外（宿主 blur 收）。
// 通路复用面（#196）：新菜单面 = 一枚域适配器（行集推导 + 行动作分发 + 域 notify 名）
// 注册进 adapters，本页零改动。readyEvent/closeEvent 与主进程宿主包装层（app-menu.ts
// 等）成对声明，改名两处同步。
import type { TaskbarState } from '../shared/contract'
import { appMenuAdapter } from './taskbar-menu-app.js'
import { blankMenuAdapter } from './taskbar-menu-blank.js'
import { recMenuAdapter } from './taskbar-menu-rec.js'
import { tierMenuAdapter } from './taskbar-menu-tier.js'
import { winsMenuAdapter } from './taskbar-menu-wins.js'

/** 域适配器：菜单面的全部域语义收口在这两个挂点 + 两个 notify 名（通路不写死任何域） */
interface MenuPageRow { id: string; label: string }
interface MenuPageAdapter {
  /** 内容实测回报的 notify 名（主进程宿主包装层消费：定窗锚光标弹出） */
  readyEvent: string
  /** 收层请求的 notify 名（payload.reason 落存证） */
  closeEvent: string
  /** 行集推导：条目不在场/名单空 = null（页自收，reason=empty） */
  rows(state: TaskbarState): MenuPageRow[] | null
  /** 行集异步推导（工单196 选窗面：窗口清单不在 state 快照内，需即席经桥拉取——
   * 在场时优先于同步 rows，页 await 后同一渲染管线） */
  rowsAsync?(state: TaskbarState): Promise<MenuPageRow[] | null>
  /** 行动作分发（存证在此先行；调用方随后收层） */
  onRow(row: MenuPageRow): void
}

/** 菜单面注册表（工单196 五面迁毕）：系统按钮显隐+恢复段（开始/推荐组空白右键）、
 * 推荐条目三行、托盘档位、多窗选窗 */
const adapters: Record<string, MenuPageAdapter> = {
  app: appMenuAdapter,
  rec: recMenuAdapter,
  blank: blankMenuAdapter,
  tier: tierMenuAdapter,
  wins: winsMenuAdapter,
}

const list = document.getElementById('menu-panel') as HTMLElement

// 视口帽随宿主 query 下发（工作区高留边距）：名单超帽才滚动，帽内行全部可点（先例同款）
const maxH = Number(new URLSearchParams(location.search).get('maxH')) || 560
if (Number.isFinite(maxH) && maxH > 100) list.style.maxHeight = `${maxH}px`

const adapter = adapters[new URLSearchParams(location.search).get('menu') ?? '']

// 浮层窗标题随宿主 query 下发（工单196：文档 <title> 会覆盖 BrowserWindow 的 title
// 选项——五面共用本页时窗口标题全部塌成页默认值，验收按 pid+标题寻窗歧义）。缺省
// 保持页默认（app 面宿主不传参，行为与工单193 一致）。
const titleParam = new URLSearchParams(location.search).get('title')
if (titleParam) document.title = titleParam

function requestClose(reason: string): void {
  if (!adapter) return
  window.deck.host.notify(adapter.closeEvent, { reason })
}

/** 菜单行：点击 = 域动作分发（存证先行）→ 收层殿后（回放已发出，浮层稍收不遮动作响应）。 */
function makeRow(row: MenuPageRow): HTMLElement {
  const el = document.createElement('div')
  el.className = 'm-row'
  el.dataset.id = row.id
  el.textContent = row.label
  el.addEventListener('click', (ev) => {
    ev.stopPropagation()
    adapter.onRow(row)
    requestClose('row')
  })
  return el
}

/** 状态 → 行集（同步/异步适配器同一道；异步行源即席拉取后再进渲染） */
async function deriveRows(state: TaskbarState): Promise<MenuPageRow[] | null> {
  if (!adapter) return null
  return adapter.rowsAsync ? adapter.rowsAsync(state) : adapter.rows(state)
}

/** 状态 → 行渲染；返回当拍行集（空 = 收层判据）。 */
function render(rows: MenuPageRow[] | null): MenuPageRow[] | null {
  list.textContent = ''
  if (rows) for (const row of rows) list.appendChild(makeRow(row))
  return rows
}

/** 内容实测回报：宿主据此定窗并锚光标弹出。 */
function reportReady(rows: MenuPageRow[]): void {
  const rect = list.getBoundingClientRect()
  const geo = rows.map((row, i) => {
    const el = list.children[i] as HTMLElement | undefined
    const r = el?.getBoundingClientRect()
    return { id: row.id, label: row.label, y: r ? r.y : 0, h: r ? r.height : 0 }
  })
  window.deck.host.notify(adapter.readyEvent, { w: rect.width, h: rect.height, rows: geo, ids: rows.map((row) => row.id) })
}

void (async () => {
  if (!adapter) {
    // 错误寻址（query 无适配器键）：载页无域语义可演——静默自杀不留悬窗
    window.deck.host.notify('taskbar-boot-error', { stage: 'taskbar-menu-adapter', message: `未知菜单面: ${new URLSearchParams(location.search).get('menu') ?? ''}` })
    window.close()
    return
  }
  let state: TaskbarState
  try {
    state = await window.deck.bridge.invoke('taskbar/get-state', null)
  } catch (err) {
    window.deck.host.notify('taskbar-boot-error', { stage: 'taskbar-menu-get-state', message: String(err) })
    requestClose('boot-failed')
    return
  }
  const rows = render(await deriveRows(state))
  if (!rows || !rows.length) {
    requestClose('empty')
    return
  }
  reportReady(rows)
  // 名单/条目变化：重推导重渲（行数变化重回报，宿主重定窗——浮层已在场不再 show）
  window.deck.bridge.on('taskbar/changed', (next: TaskbarState) => {
    void deriveRows(next).then((nextRows) => {
      if (!nextRows || !nextRows.length) {
        requestClose('empty')
        return
      }
      render(nextRows)
      reportReady(nextRows)
    })
  })
})()

// 点面板空白（非行）即收：原生菜单同语义（面板内非可点区不算「面板外」，但仍收——
// 菜单不留空点悬置态；先例同款）
document.addEventListener('click', (ev) => {
  if (ev.target instanceof HTMLElement && ev.target.closest('.m-row')) return
  requestClose('outside')
})
