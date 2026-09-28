/**
 * 桥接契约：内核对渲染层的唯一 API 形态（spec「内核契约」缝）。
 * 后续工单只扩展这里的 methods / events 映射，不另开通道。
 *
 * 窗口宿主机制（热区声明、点击存证）不属于内核契约，走 host 面，
 * 但与 bridge 共用同一对 IPC 通道与同一个 window.deck 命名空间。
 */

/** 时钟状态：ISO 字符串 + 纪元毫秒（渲染层以 epochMs 走时） */
export interface ClockState {
  iso: string
  epochMs: number
}

/** 会话四态（RUN/CONFIRM/DONE/IDLE）；string 交集保留字面量提示同时不锁死未知态 */
export type SessionState = 'RUN' | 'CONFIRM' | 'DONE' | 'IDLE' | (string & {})

/** 统一会话模型（ADR-0003-multi-tool）：五工具扫描器的输出行 */
export interface SessionInfo {
  tool: string
  id: string
  project: string
  running: boolean
  /** 距最近活跃的秒数（取整） */
  age: number
  tasks_done: number | null
  tasks_total: number | null
  state: SessionState
}

/** Qoder 状态卡：最近活跃会话的进度快照（Python server.qoder_state 的字段集） */
export interface QoderSessionState {
  project: string
  running: boolean
  tasks_done: number
  tasks_total: number
  current_task: string | null
}

export interface QoderStatus {
  active_sessions: number
  session: QoderSessionState | null
}

/** 硬件仪表（旧 /deck gauges 字段集）：GPU/网络字段在源不可用时缺位 */
export interface HardwareGauges {
  cpu: number
  memory: number
  memory_gb: string
  gpu_usage?: number
  gpu_temp?: number
  vram_usage?: number | null
  download_speed?: number
  upload_speed?: number
}

/** 300 点滚动历史（Python server._history 的 cpu/dl/up/gpu 四键）；不可用点为 null */
export interface HardwareHistory {
  cpu: number[]
  dl: (number | null)[]
  up: (number | null)[]
  gpu: (number | null)[]
}

export interface HardwareState {
  gauges: HardwareGauges
  history: HardwareHistory
}

/** 天气卡取数坐标（config.json 下发；渲染层纯前端直连 Open-Meteo，沿用先例） */
export interface WeatherLocation {
  latitude: number
  longitude: number
}

/** 桌面项种类（工单05）：快捷方式/网址文件归应用区，文件与文件夹归文档区 */
export type DesktopItemKind = 'shortcut' | 'url' | 'file' | 'folder'

/** 桌面项分区：应用区（底部 dock）/ 文档区 */
export type DesktopZone = 'app' | 'doc'

/** 桌面项（CONTEXT.md 词汇：被面板承载并渲染的桌面文件或快捷方式） */
export interface DesktopItem {
  /** 文件名（含扩展名，合并去重键） */
  name: string
  /** 显示名：.lnk/.url 剥扩展（explorer 对这两类永远隐藏扩展），其余保留原名 */
  display: string
  kind: DesktopItemKind
  /** 承载分区：归类（应用入口入应用区）经用户拖拽可覆盖（跨区拖拽即换区） */
  zone: DesktopZone
  /** 绝对路径；双击启动与图标提取都以它为准 */
  path: string
  /** 图标缓存键：path|mtimeMs——lnk 指向变更（mtime 变）即换图标 */
  iconKey: string
  /** 修改时间（ms；文档区「组内新在上」的排序依据） */
  mtimeMs: number
}

/** 应用区栏位来源（工单06 编排）：手钉 / 用户拖拽摆位 / 使用频次推荐 */
export type DesktopDockSource = 'pinned' | 'placed' | 'recommended'

/** dock 有序条目（手钉在前、显式摆位其后、推荐按频次填补） */
export interface DesktopDockEntry {
  name: string
  source: DesktopDockSource
}

/** 文档组（按扩展名聚合；组序固定） */
export type DesktopDocGroup = 'folders' | 'office' | 'pdf' | 'image' | 'archive' | 'other'

/** 文档条目落位：组名 + 组内序 + 文档区全局列号（满行折列、组间空列由列号表达） */
export interface DesktopDocEntry {
  name: string
  group: DesktopDocGroup
  rank: number
  col: number
  row: number
}

/** 编排计划（工单06）：渲染层按 dock 序铺条、按 docs 的组序/组内序铺列 */
export interface DesktopPlan {
  dock: DesktopDockEntry[]
  docs: DesktopDocEntry[]
}

/** 桌面承载状态：条目池 + 编排计划 + 指纹（渲染层按指纹 diff，1Hz 快照不重建 DOM） */
export interface DesktopState {
  fingerprint: string
  items: DesktopItem[]
  plan: DesktopPlan
}

/** 桌面承载几何（工单06，config.json 下发；渲染层应用到分区容器） */
export interface DesktopLayout {
  /** 文档区原点与最大宽度（DIP；DOCS 标签随原点放置） */
  docZone: { left: number; top: number; maxWidth: number }
  /** 文档组满几行折右列 */
  docMaxRows: number
  /** dock 条最大宽度（DIP；超出折行） */
  dockMaxWidth: number
}

/** 设置状态（工单08）：卡片底色透明度全局滑杆值（0..1，rgba alpha 语义；config.appearance.cardOpacity 平移） */
export interface SettingsState {
  cardOpacity: number
}

/** 会话行直达的结果动作（工单09）：聚焦既有窗口 / 启动工具 / 静默降级 */
export type FocusAction = 'focused' | 'launched' | 'degraded'

/** 面板快照：02 时钟；04 扩展会话/Qoder 状态/硬件与历史曲线/天气坐标；05 桌面项池；06 编排与几何；08 设置 */
export interface PanelSnapshot {
  clock: ClockState
  sessions: SessionInfo[]
  qoder: QoderStatus
  hardware: HardwareState
  weather: WeatherLocation
  desktop: DesktopState
  layout: DesktopLayout
  settings: SettingsState
}

/** 搜索结果行（工单07，Listary 本地 API data.results 行的字段集，snake_case 平移为驼峰） */
export interface SearchResultItem {
  path: string
  name: string
  type: string
  sizeBytes: number
  modifiedAt: string
  score: number
}

/** 搜索面板派生态（CONTEXT.md 三态词汇）：待机 / 活动 / 引擎离线（活动态的降级显示） */
export type SearchUiState = 'idle' | 'active' | 'offline'

/** 内核桥接方法表：method → [请求体, 响应体] */
export interface BridgeMethods {
  'panel/snapshot': { request: null; response: PanelSnapshot }
  /** 桌面项图标提取（dataURL 渲染层本地缓存；null = 提取失败/未知键） */
  'desktop/icon': { request: { key: string }; response: { dataUrl: string | null } }
  /** 双击启动桌面项；path 必须在当前扫描池内（拒绝任意路径执行） */
  'desktop/launch': { request: { path: string }; response: { ok: boolean; error?: string } }
  /** 拖拽摆位：name 入目标分区、排在 beforeName 之前（null = 末尾）；落盘并即时重编排 */
  'desktop/move': {
    request: { name: string; zone: DesktopZone; beforeName: string | null }
    response: { ok: boolean; error?: string }
  }
  /** 恢复出厂布局：清除全部显式摆位（手钉保留），回到归类 + 频次推荐的出厂编排 */
  'desktop/reset-layout': { request: null; response: { ok: boolean; cleared: number } }
  /** 搜索激活（点击热区）：待机 → 活动；活动态重复激活幂等（返回当前派生态） */
  'search/activate': { request: null; response: { state: SearchUiState } }
  /** 输入喂给引擎链路（内核防抖 ~200ms 后直连 Listary；结果/离线经事件回推） */
  'search/query': { request: { query: string }; response: { accepted: boolean } }
  /** ESC/失焦退回待机：清查询词、作废在途响应、清退避计时 */
  'search/deactivate': { request: null; response: { state: SearchUiState } }
  /** Enter 打开 / Ctrl+Enter 资源管理器定位；path 必须在最近一次结果集内 */
  'search/action': {
    request: { path: string; reveal: boolean }
    response: { ok: boolean; error?: string }
  }
  /** 设置滑杆（工单08）：写卡片底色透明度（clamp 0..1）、整份回写 config.json；回推 settings/changed */
  'settings/set-card-opacity': { request: { opacity: number }; response: SettingsState }
  /**
   * 会话行直达（工单09）：点击会话行 → 对应工具窗口置前，工具未运行则启动。
   * 渲染层只发工具名（启动目标只从 config.tools 取，映射缺失即静默降级）。
   */
  'session/focus': {
    request: { tool: string }
    response: { ok: boolean; action: FocusAction; error?: string; hwnd?: number }
  }
}

/** 内核桥接事件表：event → 推送载荷 */
export interface BridgeEvents {
  'panel/changed': PanelSnapshot
  /** 派生态变化（待机/活动/引擎离线）；限流退避静默不推 */
  'search/state': { state: SearchUiState }
  /** 引擎成功响应（空结果 items=[]）；选中语义与展示归渲染层 */
  'search/results': { total: number; items: SearchResultItem[] }
  /** 设置变化（工单08 滑杆即时回推；快照每秒也携带同一状态） */
  'settings/changed': SettingsState
}

export type BridgeMethod = keyof BridgeMethods & string
export type BridgeEventName = keyof BridgeEvents & string

/** 交互热区矩形：相对窗口客户区左上角，CSS px（= DIP） */
export interface HotzoneRect {
  id: string
  x: number
  y: number
  w: number
  h: number
}
