// 上下文菜单插件（工单23，GLOSSARY.md「上下文菜单」）：自绘菜单 shell，随插件清单
// 热插拔（卸载即摘 window.deck.ctxMenu，面板侧触发与收起裁决全部空转）。分区归 panel，
// 菜单归插件：右键触发、菜单外按下收起的政策在面板（main.ts），本插件只做呈现——
// 行清单渲染、光标定位（视口钳制）、开合与动作存证、开层期间经宿主 onDomChanged
// 重声明热区（面板据 isOpen() 换全窗热区）。
//
// contributor 形状（动作注册位留缝，本票不实现注册机制）：open(x, y, items) 的 items
// 即注册位——面板本票传两个内置动作（全选/恢复出厂布局），后续工单在此接入 contributor
// 注册机制（收集各方动作合并进同一份 items），形状不变。
//
// 开合/激活转移矩阵是纯函数（nextMenuShell，离线测试穷举）；本文件默认导出 PluginApi，
// 只是归约输出的呈现端：一个事件一次 apply——run（动作转交面板）→ 存证 → DOM → 热区。
import type { PluginApi, PluginHost } from '../../plugins.js'

// ---- 纯逻辑段（无 DOM，离线测试直接 import）----

/** 菜单行（状态只存数据；动作回调由插件旁路持有，不进状态） */
export interface MenuRow {
  id: string
  label: string
}

/** 面板注入的菜单条目：run 即动作本体（面板侧闭包，读当拍实况） */
export interface MenuItem extends MenuRow {
  run(): void
}

export interface MenuShellState {
  open: boolean
  x: number
  y: number
  rows: readonly MenuRow[]
}

export const CLOSED_MENU: MenuShellState = { open: false, x: 0, y: 0, rows: [] }

export type MenuShellEvent =
  /** 面板右键触发打开 */
  | { type: 'open'; x: number; y: number; rows: readonly MenuRow[] }
  /** 行点击：id 必须在当前打开的行集内 */
  | { type: 'activate'; id: string }
  /** 菜单外按下（面板裁决后转发） */
  | { type: 'dismiss' }
  /** 插件卸载：静默收场，不走存证（通道随插件消亡） */
  | { type: 'unmount' }

/** 归约输出：一个事件的全部副作用，按数组序执行 */
export interface MenuShellEffect {
  /** 行激活要执行的动作 id（插件从最近一次 open 的回调表解析） */
  run?: string
  /** 存证（desktop-menu-opened / desktop-menu-closed） */
  notify?: { type: string; payload?: Record<string, unknown> }
  /** DOM 呈现：show = 重建行集并定位显示；hide = 隐藏；none = 不动 */
  dom: 'show' | 'hide' | 'none'
  /** DOM 变了：宿主重声明热区（开=全窗承接、收=恢复原状） */
  hotzones: boolean
}

export interface MenuShellResult {
  state: MenuShellState
  effects: MenuShellEffect[]
}

/** 光标原点钳制：右/下越界按 8px 边距收回；视口过小钳到 8px 下限（不留负坐标） */
export function clampMenuOrigin(
  x: number, y: number, w: number, h: number, vw: number, vh: number,
): { x: number; y: number } {
  const edge = 8
  const clamp = (v: number, max: number) => Math.min(Math.max(v, edge), Math.max(edge, max))
  return { x: clamp(x, vw - w - edge), y: clamp(y, vh - h - edge) }
}

/**
 * shell 转移矩阵（穷举见 tests/renderer/menu-shell.spec.ts）：
 * 开合存证严格成对（闭态的 dismiss/activate 是迟到噪声，不发存证）；卸载静默。
 */
export function nextMenuShell(state: MenuShellState, event: MenuShellEvent): MenuShellResult {
  switch (event.type) {
    case 'open': {
      if (!event.rows.length) return { state, effects: [] } // 空条目不弹空壳
      return {
        state: { open: true, x: event.x, y: event.y, rows: [...event.rows] },
        effects: [{
          notify: { type: 'desktop-menu-opened', payload: { x: event.x, y: event.y, items: event.rows.map((r) => r.id) } },
          dom: 'show',
          hotzones: true,
        }],
      }
    }
    case 'activate': {
      if (!state.open || !state.rows.some((r) => r.id === event.id)) return { state, effects: [] }
      return {
        state: CLOSED_MENU,
        effects: [
          { run: event.id, dom: 'none', hotzones: false },
          { notify: { type: 'desktop-menu-closed', payload: { reason: 'action' } }, dom: 'hide', hotzones: true },
        ],
      }
    }
    case 'dismiss': {
      if (!state.open) return { state, effects: [] }
      return {
        state: CLOSED_MENU,
        effects: [{ notify: { type: 'desktop-menu-closed', payload: { reason: 'outside' } }, dom: 'hide', hotzones: true }],
      }
    }
    case 'unmount': {
      if (!state.open) return { state, effects: [] }
      return { state: CLOSED_MENU, effects: [{ dom: 'hide', hotzones: true }] }
    }
  }
}

// ---- 插件呈现段（默认导出；DOM 只在这里触碰）----

let shell: MenuShellState = CLOSED_MENU
let hostRef: PluginHost | null = null
let menuEl: HTMLElement | null = null
let rowsEl: HTMLElement | null = null
/** 最近一次 open 注入的动作回调表（activate 效果按 id 解析执行） */
let actions = new Map<string, () => void>()

function apply(result: MenuShellResult): void {
  shell = result.state
  const host = hostRef
  if (!host || !menuEl || !rowsEl) return
  for (const fx of result.effects) {
    if (fx.run) actions.get(fx.run)?.()
    if (fx.dom === 'show') {
      rowsEl.textContent = ''
      for (const row of shell.rows) {
        const item = document.createElement('div')
        item.className = 'ctx-item'
        item.dataset.id = row.id
        item.textContent = row.label
        item.addEventListener('click', () => dispatch({ type: 'activate', id: row.id }))
        rowsEl.appendChild(item)
      }
      menuEl.style.display = 'block'
      const origin = clampMenuOrigin(shell.x, shell.y, menuEl.offsetWidth, menuEl.offsetHeight, window.innerWidth, window.innerHeight)
      menuEl.style.left = `${origin.x}px`
      menuEl.style.top = `${origin.y}px`
      // 行矩形随开层存证（电池按它定位行点击，settings-opened 的滑杆矩形同法）；
      // 归约器保持纯数据，几何是呈现层自己补齐的存证字段。先 DOM 后 notify——
      // rows 要量到已定位的行才有意义（首轮电池实测：notify 在前则存证缺 rows）。
      const fxNotify = fx.notify
      if (fxNotify && fxNotify.type === 'desktop-menu-opened' && fxNotify.payload) {
        fxNotify.payload.rows = Array.from(rowsEl.children).map((el) => {
          const r = (el as HTMLElement).getBoundingClientRect()
          return { id: (el as HTMLElement).dataset.id ?? '', x: r.left, y: r.top, w: r.width, h: r.height }
        })
      }
    } else if (fx.dom === 'hide') {
      menuEl.style.display = 'none'
    }
    if (fx.notify) host.notify(fx.notify.type, fx.notify.payload)
    if (fx.hotzones) host.onDomChanged()
  }
}

function dispatch(event: MenuShellEvent): void {
  apply(nextMenuShell(shell, event))
}

export default {
  mount(host: PluginHost): void {
    hostRef = host
    shell = CLOSED_MENU
    actions = new Map()
    menuEl = document.createElement('div')
    menuEl.id = 'ctx-menu'
    menuEl.style.display = 'none'
    rowsEl = document.createElement('div')
    rowsEl.className = 'ctx-rows'
    menuEl.appendChild(rowsEl)
    host.el.appendChild(menuEl)
    // 面板可达的唯一缝：触发（右键）、外按收起、全窗热区判定都读这里。
    // 挂在 window.deckCtxMenu 而非 window.deck 上——后者经 contextBridge 暴露，
    // 渲染层侧不可扩展（首轮电池实测 plugin-mount-failed）。卸载即摘除——插件清单
    // 热插拔对面板自动生效（触发处 ?. 空转）。
    window.deckCtxMenu = {
      open(x: number, y: number, items: readonly MenuItem[]): void {
        actions = new Map(items.map((i) => [i.id, i.run]))
        dispatch({ type: 'open', x, y, rows: items.map(({ id, label }) => ({ id, label })) })
      },
      close(): void {
        dispatch({ type: 'dismiss' })
      },
      isOpen(): boolean {
        return shell.open
      },
    }
  },

  unmount(): void {
    dispatch({ type: 'unmount' })
    delete window.deckCtxMenu
    hostRef = null
    menuEl = null
    rowsEl = null
    actions = new Map()
  },
} satisfies PluginApi
