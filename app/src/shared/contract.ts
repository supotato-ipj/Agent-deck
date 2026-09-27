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
  zone: DesktopZone
  /** 绝对路径；双击启动与图标提取都以它为准 */
  path: string
  /** 图标缓存键：path|mtimeMs——lnk 指向变更（mtime 变）即换图标 */
  iconKey: string
}

/** 桌面承载状态：条目池 + 指纹（渲染层按指纹 diff，1Hz 快照不重建 DOM） */
export interface DesktopState {
  fingerprint: string
  items: DesktopItem[]
}

/** 面板快照：02 时钟；04 扩展会话/Qoder 状态/硬件与历史曲线/天气坐标；05 桌面项池 */
export interface PanelSnapshot {
  clock: ClockState
  sessions: SessionInfo[]
  qoder: QoderStatus
  hardware: HardwareState
  weather: WeatherLocation
  desktop: DesktopState
}

/** 内核桥接方法表：method → [请求体, 响应体] */
export interface BridgeMethods {
  'panel/snapshot': { request: null; response: PanelSnapshot }
  /** 桌面项图标提取（dataURL 渲染层本地缓存；null = 提取失败/未知键） */
  'desktop/icon': { request: { key: string }; response: { dataUrl: string | null } }
  /** 双击启动桌面项；path 必须在当前扫描池内（拒绝任意路径执行） */
  'desktop/launch': { request: { path: string }; response: { ok: boolean; error?: string } }
}

/** 内核桥接事件表：event → 推送载荷 */
export interface BridgeEvents {
  'panel/changed': PanelSnapshot
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
