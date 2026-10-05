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

/** 桌面项（GLOSSARY.md 词汇：被面板承载并渲染的桌面文件或快捷方式） */
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

/** 任务栏系统动作（工单49，GLOSSARY.md「任务栏」）：按键合成触发原生系统 UI，不自绘系统浮层 */
export type TaskbarSystemAction = 'start-menu' | 'task-view'

/** 任务栏状态（工单49 tracer bullet）：enabled=false 时主进程销毁任务栏窗口 */
export interface TaskbarState {
  enabled: boolean
}

/**
 * 桌面组件能力（工单10 插件体系）：manifest 声明插件可读的快照段。
 * 取值与 PanelSnapshot 的段名一一对应——「少给而非不给」（同桌面项池校验思路）：
 * 渲染层按声明裁剪快照后交给插件，未声明的段根本不出内核。
 * 工单03 起 qoder 段随状态块退役移除（能力表收窄，旧声明按未知能力串静默丢弃）。
 */
export type PluginCapability = 'clock' | 'sessions' | 'hardware' | 'weather' | 'desktop' | 'layout' | 'settings'

/** 全部能力（渲染层裁剪口径的唯一实现处；新增快照段时同步登记） */
export const PLUGIN_CAPABILITIES: readonly PluginCapability[] = [
  'clock', 'sessions', 'hardware', 'weather', 'desktop', 'layout', 'settings',
] as const

/** 插件 manifest（插件目录下 plugin.json）：声明式契约，spec 用户故事 37 */
export interface PluginManifest {
  /**
   * 插件标识：协议主机名（`deck-plugin://<id>/…`），故限小写字母数字与 `-`/`.`/`_`。
   * 同 id 跨扫描根先到先得（内置根在前 = 内置组件不被同名用户插件顶替）。
   */
  id: string
  /** 面板可读名（设置/调试用，不参与寻址） */
  name: string
  /** 版本串（manifest 必填；不参与寻址，变更即触发重载） */
  version: string
  /** 渲染层入口：相对插件目录的 .js 路径（如 `./card.js`）；拒绝绝对路径与 `..` */
  entry: string
  /** 可读快照段；未知能力串静默丢弃（少给而非不给），不使 manifest 失效 */
  capabilities: PluginCapability[]
  /** 挂载锚点：渲染层按 id 找容器元素；缺省 = 追加到 body 末尾 */
  mount?: string
  /** 挂载顺序（小者在前；缺省 = 扫描序 + id 序稳定化） */
  order?: number
}

/** 插件装载态：ok = 已识别、资产已校验并投递给渲染层；error = 坏 manifest/资产缺失，带原因 */
export type PluginStatus = 'ok' | 'error'

/** 快照可见的插件条目（entry 已解析为可直接 import 的协议 URL） */
export interface PluginInfo {
  id: string
  name: string
  version: string
  /** `deck-plugin://<id>/<entry>?v=<revision>`——revision 变化即绕开 ESM 模块缓存做真重载 */
  entry: string
  capabilities: PluginCapability[]
  mount?: string
  order: number
  status: PluginStatus
  /** 失败原因（status=error 时给出，面板只做静默降级不弹窗） */
  error: string | null
  /** 资产代号：manifest 或入口文件变更即递增 */
  revision: number
}

/** 面板快照：02 时钟；04 扩展会话/硬件与历史曲线/天气坐标；05 桌面项池；06 编排与几何；08 设置；10 桌面组件。qoder 段随工单03 状态块退役移除 */
export interface PanelSnapshot {
  clock: ClockState
  sessions: SessionInfo[]
  hardware: HardwareState
  weather: WeatherLocation
  desktop: DesktopState
  layout: DesktopLayout
  settings: SettingsState
  /** 工单10 桌面组件：按挂载顺序排列；坏插件以 status=error 在列（面板据此静默降级） */
  plugins: PluginInfo[]
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

/** 搜索面板派生态（GLOSSARY.md 三态词汇）：待机 / 活动 / 引擎离线（活动态的降级显示） */
export type SearchUiState = 'idle' | 'active' | 'offline'

/** 内核桥接方法表：method → [请求体, 响应体] */
export interface BridgeMethods {
  'panel/snapshot': { request: null; response: PanelSnapshot }
  /** 桌面项图标提取（dataURL 渲染层本地缓存；null = 提取失败/未知键） */
  'desktop/icon': { request: { key: string }; response: { dataUrl: string | null } }
  /** 双击启动桌面项；path 必须在当前扫描池内（拒绝任意路径执行） */
  'desktop/launch': { request: { path: string }; response: { ok: boolean; error?: string } }
  /**
   * 资源管理器定位并选中桌面项（工单24 单项菜单「打开所在位置」）：机制沿用搜索 reveal
   * 同款（explorer /select,，fire-and-forget）；path 必须在当前扫描池内（launch 同款护栏）。
   */
  'desktop/reveal': { request: { path: string }; response: { ok: boolean; error?: string } }
  /**
   * 复制桌面项完整路径进文本剪贴板（工单24 单项菜单「复制路径」）。path 必须在当前
   * 扫描池内——剪贴板内容也只出自桌面项池（与 launch/reveal 同护栏）。主进程执行：
   * 面板永不激活（focusable:false），渲染层 navigator.clipboard 因文档无焦点不可用。
   */
  'desktop/copy-path': { request: { path: string }; response: { ok: boolean; error?: string } }
  /**
   * 复制多条桌面项完整路径进文本剪贴板（工单26 多选菜单「复制路径」）：每行一个完整
   * 路径、以 \n 分隔（贴给终端/对话逐行可用），行序 = 名单序（选区插入序）。paths 全部
   * 在当前扫描池内才执行（copy-path 同护栏——剪贴板内容只出自桌面项池），任一池外即
   * 整份拒绝（剪贴板不写半份名单）。主进程执行：同 copy-path（面板永不激活）。
   */
  'desktop/copy-paths': { request: { paths: string[] }; response: { ok: boolean; error?: string } }
  /**
   * 删除进回收站（工单27，单项菜单【删除】与多选菜单【删除全部】共用一道契约）：
   * paths 全部在当前扫描池内才执行（launch/copy-paths 同款护栏，不删半份名单）；逐项
   * 送回收站（shell.trashItem，误删可找回），失败条目如实回报不做提权——任一失败
   * ok=false 且 error 带明细（菜单层据此提示）。成功条目同拍清除摆位存储三名单（防
   * 同名复活莫名归位）并即时重编排。执行在数据面子进程（摆位存储归属地），回收站源
   * 经主进程代理（shell.trashItem 是主进程 API，lnk 目标解析同法）。
   */
  'desktop/trash': {
    request: { paths: string[] }
    response: { ok: boolean; trashed: string[]; failed: string[]; error?: string }
  }
  /**
   * 原地重命名（工单28 单项菜单【重命名】）：name 必须在当前扫描池内（pin 同款按名
   * 护栏），to 为标签输入框里的原文——目标文件名由内核从条目推导（快捷方式/网址文件
   * explorer 永远藏扩展，未带原扩展时自动补回；其余逐字）。校验在内核：非法文件名
   * （Win32 禁字符/保留设备名/收尾点空格/空串）与重名冲突（同名同目录已存在，含
   * fs.rename 静默覆写防线的显式拒绝）都 ok=false（菜单层提示、原名还原）；与现名
   * 仅大小写有别的改名放行（NTFS 大小写不敏感，冲突校验对自身豁免）；与现名全同 =
   * 幂等空转（不落盘不发依赖）。成功同拍迁移摆位存储三名单（按名键控，位置不丢）
   * 并落盘 + 即时重编排；响应 to = 盘面最终文件名。外部（资源管理器发起）的重命名
   * 丢摆位——既有名字键控行为，本契约不覆盖。执行在数据面子进程（fs 是纯 Node API，
   * 摆位存储归属地；trash 的主进程代理在此不需要）。
   */
  'desktop/rename': { request: { name: string; to: string }; response: { ok: boolean; to?: string; error?: string } }
  /**
   * 粘贴（工单30 分区空白菜单【粘贴】）：读系统剪贴板文件清单（CF_HDROP + Preferred
   * DropEffect 语义）逐项落用户桌面根——剪切语义逐项移动（rename 落败回退复制+删源，
   * 跨卷）、否则递归复制（文件夹同款）；目标名冲突自动「x - 副本」「x - 副本 2」递增取
   * 空位（真桌面同款不弹框）。无池护栏——源路径不在扫描池是常态（剪贴板来自桌面之外
   * 的任意位置）。部分失败语义照 trash：失败条目如实回报、成功条目保留。响应 pasted =
   * 落盘最终名（含副本后缀）、failed = 源基名。执行在数据面子进程（落点落盘裁决地），
   * 剪贴板读经主进程代理（clipboard 是主进程 API，trash 同法）。
   */
  'desktop/paste': {
    request: null
    response: { ok: boolean; pasted: string[]; failed: string[]; error?: string }
  }
  /**
   * 可粘贴态查询（工单30，只读）：剪贴板含文件即可贴（CF_HDROP 在场即真）。分区空白
   * 右键开层前查询，【粘贴】行按结果置灰；查询失败按不可贴（宁可置灰不误可用）。
   * 与 desktop/paste 同一道剪贴板读依赖束（主进程代理）。
   */
  'desktop/clipboard-state': { request: null; response: { pasteable: boolean } }
  /** 拖拽摆位：name 入目标分区、排在 beforeName 之前（null = 末尾）；落盘并即时重编排 */
  'desktop/move': {
    request: { name: string; zone: DesktopZone; beforeName: string | null }
    response: { ok: boolean; error?: string }
  }
  /**
   * 批量拖拽摆位（工单22）：names 按选区插入序整组迁移到落点（排在 beforeName 之前，
   * null = 末尾），落点分区即整组目标分区（跨区整组换区）。手钉条目不可动（批量语境
   * 永不变更手钉栏位）与池外名字（选择与落点之间的外部删除竞态）跳过并如实回报
   * skipped；参照校验整批一道，无效即整批拒绝。逐项落摆位存储后落盘并即时重编排。
   */
  'desktop/move-batch': {
    request: { names: string[]; zone: DesktopZone; beforeName: string | null }
    response: { ok: boolean; moved: string[]; skipped: string[]; error?: string }
  }
  /**
   * 钉到应用区（工单25 手钉管理）：name 进手钉清单前段（已在清单则移到最前），占据
   * dock 前段栏位、不被推荐顶替；显式摆位名单不动（取消手钉时按其裁决归位）。
   * name 必须在当前扫描池内（move 同款护栏）；落盘并即时重编排。
   */
  'desktop/pin': { request: { name: string }; response: { ok: boolean; error?: string } }
  /**
   * 取消手钉（工单25）：name 从手钉清单移除，条目回归归类与显式摆位裁决（文档类条目
   * 回文档区）；清单本就不含时幂等空转。name 必须在当前扫描池内；落盘并即时重编排。
   */
  'desktop/unpin': { request: { name: string }; response: { ok: boolean; error?: string } }
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
  /** 任务栏（工单49）：窗口启停状态读取（config.json taskbar 段为持久化口径） */
  'taskbar/get-state': { request: null; response: TaskbarState }
  /** 任务栏开关：禁用即销毁任务栏窗口、启用即恢复；整份回写 config.json；回推 taskbar/changed */
  'taskbar/set-enabled': { request: { enabled: boolean }; response: TaskbarState }
  /** 任务栏系统动作（开始菜单/任务视图）：主进程按键合成触发原生系统 UI */
  'taskbar/system-action': { request: { action: TaskbarSystemAction }; response: { ok: boolean; error?: string } }
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
  /**
   * 工单10 桌面组件清单变化（放入/移除/资产变更触发重载）。
   * 独立于 1Hz 的 panel/changed：热插拔要即时可见，不必等下一拍快照。
   */
  'plugins/changed': PluginInfo[]
  /** 工单49 任务栏：开关变化即时回推（任务栏窗口据此渲染/渲染层不等重启） */
  'taskbar/changed': TaskbarState
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
