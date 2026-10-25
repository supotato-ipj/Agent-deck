/**
 * 桥接契约：内核对渲染层的唯一 API 形态（spec「内核契约」缝）。
 * 后续工单只扩展这里的 methods / events 映射，不另开通道。
 *
 * 窗口宿主机制（热区声明、点击存证）不属于内核契约，走 host 面，
 * 但与 bridge 共用同一对 IPC 通道与同一个 window.deck 命名空间。
 */

import type { BarMode } from './retract'

/** 时钟状态：ISO 字符串 + 纪元毫秒（渲染层以 epochMs 走时） */
export interface ClockState {
  iso: string
  epochMs: number
}

/**
 * 任务栏三态下发（工单241 最大化收栏编排）：主进程裁决后把「当前档位」推给条带渲染层。
 *
 * 档位语义（spec #236 状态机）：
 * - visible：栏面常驻可见，工作区占位生效（现状）；
 * - maximize-retract：**最大化收栏**——**注销我方 AppBar 占位登记**（系统工作区数值**不变**——原生任务栏
 *   那 48px 保留带由 shell 自算、不在 AppBar 登记表内，Win32 侧无法释放；工单250 取证），栏面退场、唤出条在场；
 * - fullscreen-yield：**全屏让位**——整窗退场，唤出条也不出现。
 *
 * 几何不在本载荷里——唤出条几何由渲染层自算（工单241 裁决 (b)：pill 矩形只有渲染层量得到，
 * 主进程不回读 taskbar-geometry 帧）。
 */
export interface TaskbarBarModeState {
  /** 当前档位 */
  mode: BarMode
  /** 迁移原因（存证用：retract / retract-lifted / fullscreen-yield / fullscreen-yield-lifted / ready） */
  reason: string
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

/** 桌面项分区：应用区（工单59 起由任务栏承载，桌面不摆位）/ 文档区（桌面唯一承载面） */
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

/** 编排计划（工单06）：渲染层按 docs 的组序/组内序铺列。
 * dock 段随工单59 退役——应用区已并入任务栏，桌面只承载文档区；应用条目仍在条目
 * 池内（zone=app），作为任务栏应用组手钉与推荐组推荐位的元数据来源，不再由桌面渲染。 */
export interface DesktopPlan {
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
}

/**
 * 设置状态（工单08）：卡片底色透明度全局滑杆值（0..1，rgba alpha 语义；config.appearance.cardOpacity 平移）。
 * 工单101 扩 disabledCards：卡片显隐停用集（插件包 id 列表；config.plugins.disabled 平移，
 * 空集 = 全启用）。渲染层据此装配设置浮层的开关列表（快照 plugins 段已不含停用包，
 * 停用包的行以 id 兜底显示），开关经 settings/set-card-enabled 回写。
 */
export interface SettingsState {
  cardOpacity: number
  disabledCards: string[]
}

/** 会话行直达的结果动作（工单09）：聚焦既有窗口 / 启动工具 / 静默降级 */
export type FocusAction = 'focused' | 'launched' | 'degraded'

/** 任务栏系统动作（工单49，GLOSSARY.md「任务栏」）：按键合成触发原生系统 UI，不自绘系统浮层。
 * 工单55 扩右组：通知中心 = Win+N（时钟格）、快速设置 = Win+A（音量格，ADR-0007）、
 * 显示桌面 = Win+D（屏幕最右端细条，对齐 Win11 右下角肌肉记忆）。 */
export type TaskbarSystemAction = 'start-menu' | 'task-view' | 'notification-center' | 'quick-settings' | 'toggle-desktop'

/** 硬件摘要指标键（工单55，GLOSSARY.md「硬件摘要」五项）：与硬件卡同一份 HardwareGauges 口径 */
export type TaskbarMetric = 'cpu' | 'gpu' | 'ram' | 'net-down' | 'net-up'

/** 五项指标的规范顺序（显示序与 set-metrics 归一序的唯一出处；勾选持久化存的是子集） */
export const TASKBAR_METRIC_KEYS: readonly TaskbarMetric[] = ['cpu', 'gpu', 'ram', 'net-down', 'net-up'] as const

/** 开始组系统按钮 id（工单49/54）：开始按钮 + TaskView 按钮——显隐持久化与右键菜单按它寻址 */
export type TaskbarButtonId = 'start' | 'tasks'

/**
 * 推荐组推荐位条目（工单54/160）：使用频次推荐的桌面条目；name 是合并去重键。
 * 工单160 起携带图标键与 exe 身份——图标渲染、手钉、启动、定位的统一寻址。
 * exe 的快捷方式目标解析（Electron 真源）在主进程服务层富化：纯函数层与数据面
 * 子进程（无 Electron API）以条目路径为暂定身份，服务层经同款解析升级为目标 exe。
 */
export interface TaskbarRecommendation {
  name: string
  display: string
  path: string
  /** 图标缓存键（desktop 契约同款 path|mtimeMs，随条目池扫描产出） */
  iconKey: string
  /** exe 身份：快捷方式经解析取目标（解析不出/池外 = 条目路径兜底） */
  exe: string
}

/**
 * 任务栏应用组条目（工单52，GLOSSARY.md「栏分组」应用组）：手钉与运行中应用的合并视图。
 * 身份 = exe 路径（原始大小写；比较时归一）。title 是窗口标题——仅内存即时读取的
 * 即时呈现（tooltip），永不持久化（ADR-0007 对 ADR-0002 的书面口子；图标键、手钉
 * 名单等落盘面绝不含它）。
 */
export interface TaskbarAppEntry {
  /** 身份：exe 绝对路径（手钉 = 手钉登记的 exe；仅运行 = 首见窗口的 exe） */
  exe: string
  /** 显示名（手钉 = 迁移时桌面项显示名；仅运行 = exe 基名去扩展） */
  label: string
  pinned: boolean
  running: boolean
  /** 窗口标题（tooltip 用；仅运行中在场，仅内存，永不落盘） */
  title: string | null
  /** 图标缓存键（desktop/icon 契约同款 path|mtimeMs；null = 无图标源） */
  iconKey: string | null
}

/** 应用组应用窗口引用（工单53 多窗口列表选窗）：hwnd 即时有效（仅当拍，不持久化）；
 * title 仅内存即时显示（ADR-0007 书面口子：tooltip 与多窗口列表可用，永不落盘） */
export interface TaskbarWindowRef {
  hwnd: number
  title: string | null
}

/** 左键点击结果动作（工单53 三态 + 多窗口列表）：launched=启动；activated=置前；
 * minimized=最小化；window-list=弹出带窗口标题的选窗列表（windows 随响应携带） */
export type TaskbarAppClickAction = 'launched' | 'activated' | 'minimized' | 'window-list'

/**
 * 推荐栏移除名单条目（工单161）：用户「从推荐栏移除」的应用（exe 身份 + 移除时点展示
 * 元数据），落栏布局存储持久化（重启记住）。渲染层据它渲染推荐组空白右键菜单的恢复段；
 * iconKey = 移除时点图标键（null = 无图标源）。
 */
export interface TaskbarExcludedEntry {
  exe: string
  label: string
  iconKey: string | null
}

/** 任务栏状态（工单49 起）：enabled=false 时主进程销毁任务栏窗口；
 * hiddenButtons（工单54）= 右键菜单藏起的系统按钮（config.json 持久化）；
 * recommendations（工单54）= 使用频次推荐位（上限 5，工单160 收窄；随数据面快照即时刷新；
 * 工单161 起移除名单与手钉条目不占位、滤除后由候选池后续名次递补）；
 * excluded（工单161）= 推荐栏移除名单（栏布局存储持久化，重启记住；推荐组空白右键恢复段的来源）；
 * metrics（工单55）= 右组硬件摘要勾选子集（config.json taskbar 段持久化，重启保持）；
 * apps（工单52）= 应用组合并视图（手钉在前、运行态叠加；禁用态由渲染层视图模型收敛为空）；
 * tray（工单56）= 系统托盘入栏名单（瞬态，不落盘——托盘状态由数据面宿主现收现给）；
 * trayOverflowLimit（工单162）= 托盘溢出档位（config 任务栏段持久化，重启保持）。
 * maximizeRetract（工单239）= 最大化收栏开关（前台窗口真最大化时任务栏自动收栏；默认开，
 * 关掉即回到「最大化窗不收栏、栏常驻」的旧行为；config 任务栏段持久化，重启保持）。 */
export interface TaskbarState {
  enabled: boolean
  hiddenButtons: TaskbarButtonId[]
  recommendations: TaskbarRecommendation[]
  excluded: TaskbarExcludedEntry[]
  metrics: TaskbarMetric[]
  apps: TaskbarAppEntry[]
  tray: TaskbarTrayEntry[]
  trayOverflowLimit: TaskbarTrayOverflowLimit
  maximizeRetract: boolean
}

/** 托盘按钮（工单56）：左键 = 应用默认动作（启动/置前由图标所属应用自决），右键 = 上下文菜单 */
export type TaskbarTrayButton = 'left' | 'right'

/** 栏内托盘条目（工单56）：身份键 = 协议层身份（NIF_GUID 在则 guid:<guid>，否则 <hwnd>:<uid>），
 * tooltip 即时显示不落盘；iconKey = 图标像素缓存键（null = 该条目尚无像素，渲染层按空格呈现） */
export interface TaskbarTrayEntry {
  key: string
  tooltip: string
  iconKey: string | null
}

/**
 * 托盘溢出档位（工单162）：通知区域默认最多可见的托盘图标数，超量收进「⋯」钮。
 * 3/5/8 为固定档，'all' = 全部可见（「⋯」不出场）；config.json taskbar.trayOverflowLimit
 * 持久化。档位是用户声明的可见数，「⋯」钮不吃名额——语义与容量实测的 planAppsOverflow 分界。
 */
export type TaskbarTrayOverflowLimit = 3 | 5 | 8 | 'all'

/** 托盘图标像素（工单56）：32bpp 顶向下 BGRA，base64——渲染层本地 canvas 转 dataURL
 * （与 desktop/icon 的 dataURL 面同款职责分工：编码在渲染层，主进程只搬运字节） */
export interface TaskbarTrayPixels {
  width: number
  height: number
  bgraBase64: string
}

/** 任务栏拖拽组（工单57；工单157 起 apps/recs 语义新名，GLOSSARY.md「栏分组」）：
 * apps = 应用组（手钉+运行中合并）；recs = 推荐位（推荐组条目）；开始组不参与拖拽。 */
export type TaskbarDragGroup = 'apps' | 'recs'

/**
 * 任务栏拖拽落位描述子（工单57；工单195 起全量拖拽语义）：条目身份按组取值——应用组 =
 * exe 原文（TaskbarAppEntry.exe，手钉与未钉运行条目均可起拖），推荐组 = 桌面项 name
 * （TaskbarRecommendation.name）。before = 落点（排在该身份之前）；null = 组空白（落段
 * 末尾）。落点段位按源条目归属收敛：手钉源只在手钉段内换位（拖位落盘持久），未钉运行
 * 源在运行段内换位（拖位会话态）——落点指向另一段身份时向本段邻接边界钳取（手钉段末尾
 * /运行段首位），不作废整次拖拽、不静默吞掉。落点身份不在场（渲染与落位之间的状态竞态）
 * 同款边界收敛。
 */
export interface TaskbarDragDrop {
  from: TaskbarDragGroup
  to: TaskbarDragGroup
  id: string
  before: string | null
}

/**
 * 应用组应用激活动作（工单58 启动/置前基本分发通路）：launched = 未运行启动；
 * focused = 运行中置前。action 是内核裁决（执行失败时仍回报裁决，ok 标记成败）；
 * null = 未执行（栏外身份护栏）。中键新实例、最小化切换、多窗口列表与右键菜单
 * 是工单53 的全交互面，在同一 exe 身份挂点上扩展。
 */
export type TaskbarActivateAction = 'launched' | 'focused'

/** 任务栏右组 1Hz 数据帧（工单55）：时钟 + 硬件仪表，随数据面每拍快照回推
 * （与 panel/changed 同源同拍——数值口径与硬件卡一致的依据；只裁右组要的两段，
 * 整份 PanelSnapshot 不进条带渲染层） */
export interface TaskbarStatus {
  clock: ClockState
  hardware: HardwareGauges
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

/**
 * 插件私有状态的一份快照（工单178 plugin-config）：config 是该插件 id 名下整份键值状态，
 * warnings 是本次读/写的自愈记录（坏值逐键回退、坏 JSON 视同空对象……）。
 *
 * 载荷限定为 JSON 数据模型内的值（纯对象/数组/字符串/有限数/布尔/null）；键值语义由插件
 * 自定，内核不解释内容只管持久化强度——这是「组卡存组定义与临时卡序号」一类运行态数据的
 * 通道（工单166 之⑧），不是通用配置面。
 */
export interface PluginConfigState {
  config: Record<string, unknown>
  warnings: string[]
}

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
   * 选中桌面项写入系统文件剪贴板（工单29 单项菜单【复制】与多选菜单共用一道契约，
   * 多选整集进剪贴板）：整份绝对路径有序列表（序 = 名单序 = 选区插入序）+ copy 语义
   * （Preferred DropEffect = DROPEFFECT_COPY，粘贴为副本）。paths 全部在当前扫描池内
   * 才执行（copy-paths 同款整份护栏——剪贴板不写半份名单），空名单拒绝。写入格式
   * CF_HDROP + Preferred DropEffect（资源管理器及任意应用可直接粘贴），执行在
   * DesktopService 宿主进程（koffi 直调 user32 纯 native，数据面子进程可用，
   * 无 trash 那样的主进程代理）。
   */
  'desktop/clipboard-copy': { request: { paths: string[] }; response: { ok: boolean; error?: string } }
  /**
   * 选中桌面项以剪切语义写入系统文件剪贴板（工单29 单项菜单【剪切】与多选菜单共用）：
   * 与 clipboard-copy 同一道护栏与写入格式，effect = move（Preferred DropEffect =
   * DROPEFFECT_MOVE，粘贴为搬移）。写剪贴板不动摆位不删文件——剪切后条目仍在原地
   * （真桌面同款），摆位清除发生在粘贴移走或 trash 时。
   */
  'desktop/clipboard-cut': { request: { paths: string[] }; response: { ok: boolean; error?: string } }
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
  /** 恢复出厂布局：清除全部显式摆位，回到归类分组的出厂编排 */
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
   * 卡片显隐开关（工单101）：把插件包 id 加进/移出停用集（config.plugins.disabled），
   * 整份回写 config.json；回推 settings/changed（渲染层对齐开关列表）+
   * settings/cards-changed（插件宿主重扫清单，快照 plugins 段剔除/恢复，下一拍生效）。
   * 同态幂等空转；空 id 与非布尔开关值抛 BridgeError（契约违规）。
   * 未知 id 不拒：停用集只按 id 过滤，包未在场时条目静默待命（目录回来仍保持停用）。
   */
  'settings/set-card-enabled': { request: { id: string; enabled: boolean }; response: SettingsState }
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
  /** 任务栏系统动作（开始菜单/任务视图/通知中心/快速设置/显示桌面）：主进程按键合成触发原生系统 UI */
  'taskbar/system-action': { request: { action: TaskbarSystemAction }; response: { ok: boolean; error?: string } }
  /**
   * 开始组系统按钮显隐（工单54）：右键菜单触发，整份回写 config.json taskbar.hiddenButtons，
   * 回推 taskbar/changed。同态幂等空转；未知按钮 id 抛 BridgeError（契约违规）。
   */
  'taskbar/set-button-hidden': { request: { id: TaskbarButtonId; hidden: boolean }; response: TaskbarState }
  /**
   * 栏上拖拽落位（工单57）：组内换位（应用组手钉段内 / 推荐组推荐位内）与跨组拖拽
   * （中→左 = 升为手钉，左→中 = 解除手钉回推荐池）。裁决进 taskbar/layout-store 纯函数，
   * 先落盘 taskbar-layout.json（有序名单）再提交内存态并回推 taskbar/changed（一帧）。
   * ok:false = 源条目不可拖（应用组仅运行条目 / 推荐组推荐位名单外名字），状态与落盘不变；
   * 同态幂等空转不重写不重推；描述子畸形（组别/身份非法）抛 BridgeError（契约违规）。
   */
  'taskbar/drag-drop': { request: TaskbarDragDrop; response: { ok: boolean; error?: string } }
  /**
   * 应用组图标左键（工单53）：三态裁决内核落地——未运行（无窗口）→ 启动 exe；单窗口
   * 未前台 → 置前；单窗口已前台 → 最小化；多窗口 → 不执行窗口效果，响应 action=
   * 'window-list' 并携带带标题的窗口清单（渲染层弹出 pill 内列表，再经
   * taskbar/activate-window 精确选窗）。exe 护栏 = 必须在当前应用组条目内（归一匹配），
   * 否则 ok:false（应用进出栏的帧间竞态按普通失败回报，不抛）。
   */
  'taskbar/app-click': {
    request: { exe: string }
    response: { ok: boolean; action: TaskbarAppClickAction | null; windows?: TaskbarWindowRef[]; error?: string }
  }
  /** 多窗口列表选窗（工单53）：hwnd 必须在最近一次窗口枚举快照内且归属应用组某 exe
   * （不置前任意义外的窗口）；已销毁/名单外 hwnd 回报 ok:false 不抛。 */
  'taskbar/activate-window': { request: { hwnd: number }; response: { ok: boolean; error?: string } }
  /**
   * 应用组窗口清单查询（工单196 选窗浮层行源）：只读——按 exe 归一匹配回当拍带标题
   * 窗口清单（与 app-click window-list 同一 windowsOf 枚举，选窗浮层页自足取行用，
   * 行集永不与条带视图各判一次）。exe 护栏 = 必须在当前应用组条目内（归一匹配），
   * 否则 ok:false 空清单（应用进出栏的帧间竞态按普通失败回报，不抛）。
   */
  'taskbar/app-windows': { request: { exe: string }; response: { ok: boolean; windows: TaskbarWindowRef[] } }
  /** 中键开新实例（工单53）：恒启动 exe（app-click 同款应用组护栏） */
  'taskbar/app-new-instance': { request: { exe: string }; response: { ok: boolean; error?: string } }
  /**
   * 右键菜单「手钉/解除手钉」（工单53）：手钉 = exe 身份连同展示元数据（label/iconKey
   * 取自当前应用组条目）追加进栏布局存储手钉清单并落盘；解除 = 从清单移除。同态幂等
   * 空转；落盘后即时重编排（手钉段迁移）并回推 taskbar/changed。手钉目标必须在
   * 当前应用组条目内（需要展示元数据来源），未知 exe 抛 BridgeError（契约违规）。
   */
  'taskbar/set-app-pinned': { request: { exe: string; pinned: boolean }; response: TaskbarState }
  /** 右键菜单「关闭窗口」（工单53）：向该 exe 的全部应用组窗口投递 WM_CLOSE（多窗口
   * 一并关，Win11「关闭所有窗口」语义）；closed = 成功投递数。应用组护栏同 app-click。 */
  'taskbar/close-window': { request: { exe: string }; response: { ok: boolean; closed: number; error?: string } }
  /** 右键菜单「打开文件位置」（工单53）：explorer /select,<exe> 定位（desktop/reveal
   * 同款 fire-and-forget 机制）；应用组护栏同 app-click。 */
  'taskbar/reveal-app': { request: { exe: string }; response: { ok: boolean; error?: string } }
  /**
   * 推荐组条目左键启动（工单160）：以富化后的 exe 身份寻址（快捷方式经服务层解析为
   * 目标），经既有 shell 打开通道启动（desktop/adapter shellOpen——应用组启动同款）。
   * exe 护栏 = 必须在当前推荐组条目内（归一匹配），栏外身份 ok:false 不启动不抛
   * （推荐位随快照刷新进出栏的帧间竞态按普通失败回报）；空/非字符串 exe 抛
   * BridgeError（契约违规）。
   */
  'taskbar/rec-click': { request: { exe: string }; response: { ok: boolean; error?: string } }
  /**
   * 推荐组条目「手钉到任务栏」（工单160）：exe 身份连同推荐条目展示元数据（label=
   * 显示名、iconKey=条目图标键）追加进栏布局存储手钉清单并落盘，重编排即时生效——
   * 该应用从推荐组消失（既有可见性管线：手钉条目不占推荐位）、出现在应用组手钉段
   * （不双占位），回推一帧 taskbar/changed。同态幂等空转；推荐位名单外身份抛
   * BridgeError（契约违规——展示元数据来源必须在当前推荐位，set-app-pinned 同款口径）。
   */
  'taskbar/rec-pin': { request: { exe: string }; response: TaskbarState }
  /**
   * 推荐组条目「从推荐栏移除」（工单161）：exe 身份连同推荐条目展示元数据（label=显示名、
   * iconKey=条目图标键）进栏布局存储持久排除名单并落盘，重编排即时生效——该应用从推荐组
   * 消失（可见性管线第三条滤除线，与手钉滤除、显式序正交），空位由候选池后续名次递补
   * （上限仍 5），回推一帧 taskbar/changed。持久排除重启记住；恢复入口 = 推荐组空白处
   * 右键的恢复菜单（taskbar/rec-restore）。同态幂等空转；推荐位名单外身份抛 BridgeError
   * （契约违规——展示元数据来源必须在当前推荐位，rec-pin 同款口径）。
   */
  'taskbar/rec-remove': { request: { exe: string }; response: TaskbarState }
  /**
   * 从推荐栏移除名单恢复（工单161）：推荐组空白处右键弹出的「已移除应用」恢复菜单点选
   * 落点——exe 身份（归一匹配）移出持久排除名单并落盘，条目随同帧推荐位管线回池（按既有
   * 显式序/分数序）。不在名单 → 幂等空转原样返回（菜单行与状态之间的帧间竞态按空转呈现，
   * 不抛）。
   */
  'taskbar/rec-restore': { request: { exe: string }; response: TaskbarState }
  /**
   * 推荐组条目「打开文件位置」（工单160）：explorer /select,<exe> 定位（reveal-app
   * 同款 fire-and-forget 机制）；exe 护栏同 rec-click（栏外身份 ok:false 不抛）。
   */
  'taskbar/rec-reveal': { request: { exe: string }; response: { ok: boolean; error?: string } }
  /**
   * 应用组应用图标点击（工单58，栏内与溢出浮层共用同一道契约）：exe 身份必须在当前应用组
   * 栏面上（desktop/launch 池护栏同款——栏外身份不启动，ok:false 回报）；运行中置前、
   * 未运行启动，裁决在内核。执行失败（前台锁拒收/启动报错）ok:false + error 不抛——
   * 点击语义不需 try/catch。工单53 的全交互（右键菜单/中键/最小化切换）在同一身份挂点扩展。
   */
  'taskbar/activate-app': { request: { exe: string }; response: { ok: boolean; action: TaskbarActivateAction | null; error?: string } }
  /** 任务栏右组硬件摘要勾选（工单55）：metrics 为勾选子集（按规范序归一），整份回写 config.json；回推 taskbar/changed */
  'taskbar/set-metrics': { request: { metrics: TaskbarMetric[] }; response: TaskbarState }
  /**
   * 托盘图标点击回放（工单56）：把点击按图标所属应用协商的负载语义回投到它的窗口
   * （v0：wParam=uID/lParam=鼠标消息；v4：wParam=锚点坐标/lParam=事件|(uID<<16)，右键
   * WM_CONTEXTMENU——工单164 修正，口径=MSDN uCallbackMessage 备注），菜单由应用
   * 自己渲染。key 护栏 = 必须在当前栏内托盘名单（名单外/已删图标 ok:false 不抛）；
   * 执行失败（宿主不在场/投递被系统拒收）ok:false + error。
   */
  'taskbar/tray-click': { request: { key: string; button: TaskbarTrayButton }; response: { ok: boolean; error?: string } }
  /**
   * 托盘溢出档位（工单162）：档位菜单（「⋯」右键/右组空白处右键挂点）选择即生效，
   * 整份回写 config.json taskbar.trayOverflowLimit，回推 taskbar/changed（渲染层重拆
   * 名单：上调即图标回栏、「⋯」消失）。同态幂等空转；档位外取值抛 BridgeError（契约违规）。
   */
  'taskbar/set-tray-overflow-limit': { request: { limit: TaskbarTrayOverflowLimit }; response: TaskbarState }
  /**
   * 最大化收栏开关（工单239）：设置浮层切换即生效（不必重启面板），整份回写
   * config.json taskbar.maximizeRetract，回推 taskbar/changed（渲染层对齐勾选态）。
   * 同态幂等空转；非布尔值抛 BridgeError（契约违规）。
   */
  'taskbar/set-maximize-retract': { request: { enabled: boolean }; response: TaskbarState }
  /** 托盘图标像素（工单56）：按条目身份取像素字节（渲染层本地转 dataURL 并缓存）；null = 未知键或无像素 */
  'taskbar/tray-icon': { request: { key: string }; response: { icon: TaskbarTrayPixels | null } }
  /**
   * 插件私有状态读取（工单178，ADR-0014 决策 (c)）：按插件 id 取回整份键值状态，落盘在
   * userData 下每个 id 一个文件；从未写过 = 空对象，坏 JSON 视同空对象并记 warning。
   *
   * **命名空间隔离是约定式、不是强制式**（ADR-0014 Consequences 原文）：invoke 是全表
   * 透传的单一 handler，主进程无从分辨调用方，`id` 由调用方自证。读别人那一份没有任何
   * 机制拦得住——这与面板现有的零护栏状态一致（同 ADR-0010 所述，控制面在代码里尚不存在）。
   * 本契约不引入信任档/开放级/护栏（那套覆盖四类客体与两维矩阵，为一个 KV 搭半套只会留下
   * 残缺结构）；「只能写自己命名空间」写成该契约的固有约束，落地靠自律。
   */
  'plugin-config/get': { request: { id: string }; response: PluginConfigState }
  /**
   * 插件私有状态写入（工单178）：patch 按键合并到该 id 的既有状态后整份落盘（tmp+rename
   * 原子写，坏写不碰原文件、不留半份）。
   *
   * 沿用项目既有的持久化强度：逐键校验——坏值**逐键**回退（保留既有值）并记 warning，
   * 不整体失败；体积超限则拒收并抛 BridgeError，如实回报，绝不静默截断。
   * 同上，命名空间隔离仅为约定式。
   */
  'plugin-config/set': { request: { id: string; patch: Record<string, unknown> }; response: PluginConfigState }
  /**
   * 退出面板（工单83）：设置浮层「退出面板」按钮 → 主进程 app.quit()，与托盘菜单
   * 「退出面板」（tray.ts click=app.quit()）、WM_CLOSE 走同一条 before-quit 优雅退出
   * 收敛（窗口销毁、托盘 destroy、桌面图标/原生任务栏还原）。主进程本地动作，无数据面
   * 参与；quit 依赖由生产装配（index.ts）注入，未装配如实拒绝（不静默吞）。
   */
  'app/quit': { request: null; response: { ok: boolean } }
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
  /** 工单55 任务栏右组：每拍快照回推时钟 + 硬件仪表（与 panel/changed 同源同拍） */
  'taskbar/status': TaskbarStatus
  /**
   * 工单241 任务栏三态：主进程收栏编排裁决后下发（条带渲染层据此让栏面退场/复现）。
   * 只下发档位事实，不下发矩形——唤出条几何由渲染层自算（pill 矩形只有渲染层量得到）。
   */
  'taskbar/bar-mode': TaskbarBarModeState
  /**
   * 工单242 唤出条指针对账：主进程 HotzoneTracker 25ms 光标轮询按光标坐标 hit-test 后
   * 报出「光标此刻落在哪个热区」（id = 热区矩形声明时的 id；null = 不在任何热区）。
   * 唤出交互的悬停态**只认这条事实**——不得以浏览器 enter/leave 事件序列为准（原型振荡教训）。
   * 只在命中区变化时下发（不等距拍发）。
   */
  'taskbar/cursor-zone': { id: string | null }
  /**
   * 工单242 浮层钉组：自绘浮层开合事实（family = 存证事件家族前缀，如 taskbar-tray-overflow）。
   * 条带渲染层据此钉住所属组（浮层在场只钉所属组，其余组照常收）。
   */
  'taskbar/popup-state': { family: string; open: boolean }
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
