/**
 * 插件契约目录（工单331，ADR-0025 拍板）：机器可读的**单一正典**。
 *
 * 目录描述投放型插件包的开发契约：manifest 形状、`hostApiVersion` 版本策略、基线宿主
 * API（分领域 DTO/动作/事件/错误）、首版权限目录、结构化错误与资源上限。它是只读发现
 * 面，不授予权限——批准 UI 与 agent/MCP 从同一来源投影（`projectCatalog`）。
 *
 * 单一正典的机械保证：投放包解析器（dropped-manifest.ts）与包宿主运行时（package-host.ts）
 * 的常量（当前主版本、已知权限、基线域清单）一律 `import` 自本模块，不许另立字面量——
 * 目录改了，解析与运行时同步改，不存在第二处正典。
 *
 * 纯数据 + 纯函数：无 fs、无 Electron，Vitest 全覆盖。
 */

/** 宿主 API 主版本：首版 1。同主版本只做向后兼容新增；删除权限或改变语义须升主版本 */
export const HOST_API_VERSION = { current: 1, policy: 'same-major-backward-compatible' } as const

/** 当前主版本（运行时与解析器共用出口） */
export function currentHostApiVersion(): number {
  return HOST_API_VERSION.current
}

/** 权限的授予形态 */
export type PermissionGrant = 'exact-origin' | 'gsmtc-sessions' | 'media-commands'

/** 权限生命周期：declared = 目录已登记、消费路径未实现（后续票）；enforced = 运行时已消费 */
export type CatalogEntryStatus = 'declared' | 'enforced'

/** 权限目录条目：敏感数据与动作的封闭声明（插件不能靠新字符串创造权限） */
export interface PermissionDescriptor {
  /** 权限 id（manifest.permissions 的合法成员） */
  id: string
  /** 首版全部为敏感权限（基线宿主 API 不占权限位） */
  kind: 'sensitive'
  /** 所属领域（媒体 / 受控网络） */
  domain: 'media' | 'network'
  /** 用户可读一句话（批准 UI 直接投影） */
  summary: string
  /** 授权形态 */
  grant: PermissionGrant
  /** 授予后插件可读的脱敏 DTO（字段级描述） */
  data: string[]
  /** 授予后插件可执行的动作 */
  actions: string[]
  /** 授予后插件可订阅的事件 */
  events: string[]
  /** 本权限可能产生的结构化错误码（必须已在 errors 登记） */
  errors: string[]
  /** 是否需要一次性用户手势（高影响/不可逆动作） */
  userGestureRequired: boolean
  /** 资源上限声明（平台上限；用户可收紧不可放宽；数值型） */
  limits: Record<string, number>
  /** 消费状态：首版三项全部 declared（本票只实现零权限消费路径） */
  status: CatalogEntryStatus
}

/** 基线宿主 API 域：分领域、带类型，投放包**不带通用 invoke** */
export interface BaselineApiDomain {
  /** 域 id（`host.view` / `host.config`） */
  id: string
  summary: string
  /** DTO 描述（键 = DTO 名，值 = 字段级说明） */
  dto: Record<string, string>
  /** 域内动作（不含 invoke） */
  actions: string[]
  /** 域内事件 */
  events: string[]
  /** 域内可能产生的结构化错误码（必须已在 errors 登记） */
  errors: string[]
  /** 基线域本票即落地 */
  status: 'enforced'
}

/** manifest 字段形状（投放包契约） */
export interface ManifestSchemaField {
  name: string
  type: string
  required: boolean
  description: string
}

/** 结构化错误目录条目 */
export interface ContractErrorEntry {
  code: string
  kind: 'migration' | 'runtime' | 'gate'
  /** 用户/agent 可读一句话 */
  message: string
}

/** 投放包文件形状上限（ADR-0019 包格式上限的正典登记） */
export const PACKAGE_RESOURCE_LIMITS = {
  totalBytes: 8 * 1024 * 1024,
  maxFiles: 256,
  maxFileBytes: 2 * 1024 * 1024,
  maxPathDepth: 8,
  manifestBytes: 64 * 1024,
  /** 插件私有状态单命名空间上限（与 config-store PLUGIN_CONFIG_MAX_BYTES 同源口径） */
  privateConfigBytes: 64 * 1024,
} as const

/** 首版权限目录（封闭集合：media.read / media.control / network.request） */
const PERMISSIONS: readonly PermissionDescriptor[] = [
  {
    id: 'media.read',
    kind: 'sensitive',
    domain: 'media',
    summary: '读取系统媒体会话的脱敏快照（曲名/艺术家/播放态/受控缩略图），覆盖全部 GSMTC 会话',
    grant: 'gsmtc-sessions',
    data: ['MediaSessionSnapshot（脱敏：标题/艺术家/播放态/会话键；不含 WinRT 对象与原生流）'],
    actions: [],
    events: ['media/sessions-changed'],
    errors: ['media_unavailable'],
    userGestureRequired: false,
    limits: { snapshotRatePerSecond: 1, snapshotBytes: 64 * 1024, thumbnailMaxBytes: 2 * 1024 * 1024 },
    status: 'enforced',
  },
  {
    id: 'media.control',
    kind: 'sensitive',
    domain: 'media',
    summary: '对媒体会话执行播放/暂停/上一曲/下一曲控制（按带代次的不透明会话键寻址）',
    grant: 'media-commands',
    data: [],
    actions: ['media/play', 'media/pause', 'media/previous', 'media/next'],
    events: [],
    errors: ['media_unavailable', 'media_session_gone', 'media_command_failed', 'media_rate_limited'],
    userGestureRequired: false,
    limits: { commandsPerSecond: 5 },
    // 工单337：可选权限逐项批准落地（控制面/授权账/降级渲染全链）
    status: 'enforced',
  },
  {
    id: 'network.request',
    kind: 'sensitive',
    domain: 'network',
    summary: '向精确授权的 origin 发起 HTTP(S) 请求-响应（无凭证；重定向不自动跟随）',
    grant: 'exact-origin',
    data: ['HttpResponse（有界响应体：文本/JSON/二进制字节副本；不含中间流）'],
    actions: ['network/request'],
    events: [],
    // 工单338：限额与权限拒绝分域——限流/超时/重定向/失败各不同码
    errors: ['network_permission_denied', 'network_rate_limited', 'network_timeout', 'network_redirect_blocked', 'network_failed', 'credential_unavailable', 'unknown_context'],
    userGestureRequired: false,
    limits: { requestsPerSecond: 5, maxResponseBytes: 2 * 1024 * 1024, timeoutMs: 10_000, maxConcurrent: 2 },
    // 工单338：origin 授权/宿主代理面/限额/脱敏审计全链落地
    status: 'enforced',
  },
]

/** 基线宿主 API（投放窄面：本票落地 host.view / host.config 两域） */
const BASELINE_HOST_API: readonly BaselineApiDomain[] = [
  {
    id: 'host.view',
    summary: '按 manifest capabilities 声明裁剪的只读快照视图（投放档四段上限：clock/hardware/layout/settings）',
    dto: {
      'view.clock': '时钟段（PanelSnapshot.clock 同形状）',
      'view.hardware': '硬件仪表段',
      'view.layout': '桌面布局段',
      'view.settings': '设置状态段（卡片显隐等）',
    },
    actions: ['view/get', 'view/subscribe'],
    events: ['view/changed'],
    errors: ['view_unavailable'],
    status: 'enforced',
  },
  {
    id: 'host.config',
    summary: '插件私有状态（按包命名空间；身份由主进程执行上下文登记表推导，不采信自报）',
    dto: { 'PluginConfigState': 'config 键值 + 自愈 warnings' },
    actions: ['config/get', 'config/set'],
    events: [],
    errors: ['config_invalid', 'config_io_failed', 'config_too_large', 'unknown_context'],
    status: 'enforced',
  },
  {
    id: 'host.media',
    // 工单336：媒体域落地（首个敏感权限闭环）。数据面 = media.read 授权后的脱敏快照
    // （MediaSnapshotDTO，白名单字段）；缩略图按需单取（类型/大小校验后交字节副本）。
    // 授权面 = 持久化授权账（id+权限集合+代码哈希；撤销即断供）。
    // 工单337：media.control 可选权限逐项批准——控制命令经 deckHost.media.control →
    // Broker.controlForPackage（授权门+限流+结构化错误+逐次审计）；未授权=卡片只读降级。
    summary: '媒体会话脱敏快照与受控缩略图（media.read）+ 播放/暂停/上一曲/下一曲控制（media.control 可选，逐项批准）；事件 media/sessions-changed 驱动宿主重推',
    dto: {
      'MediaSnapshotDTO': '脱敏快照（generation/available/selectedKey/sessions[]；session = key/aumid/status/caps/timeline/media 八字段白名单）',
      'MediaThumbnail': '受控缩略图（dataUrl 字节副本；png/jpeg/webp ≤2MB，校验拒付一个字节不出）',
    },
    actions: [],
    events: ['media/sessions-changed'],
    errors: ['media_unavailable', 'media_session_gone', 'media_thumbnail_rejected', 'media_permission_denied', 'unknown_context'],
    status: 'enforced',
  },
  {
    id: 'host.network',
    // 工单338：网络域落地。放行只经宿主代理面——包页自己的 fetch/XHR 仍被 session 级
    // webRequest + CSP 全拒；NetworkBroker 做逐 origin 授权、限额与脱敏审计。
    summary: '向 manifest 声明且获批的精确 origin 发起有界 HTTP(S) 请求-响应（network.request；重定向不自动跟随、无凭证）',
    dto: {
      'NetworkResponse': '有界响应（status/origin/method/contentType/bytes/truncated + text 或 base64 字节副本；无中间流）',
    },
    actions: ['network/request'],
    events: [],
    errors: ['network_permission_denied', 'network_rate_limited', 'network_timeout', 'network_redirect_blocked', 'network_failed', 'credential_unavailable', 'unknown_context'],
    status: 'enforced',
  },
]

/** 结构化错误目录（迁移错误 + 基线域运行时错误 + 权限运行时错误 + 闸门错误） */
const ERRORS: readonly ContractErrorEntry[] = [
  // —— 迁移错误（AC5：旧包可读迁移错误 → 待迁移态）——
  { code: 'host_api_version_missing', kind: 'migration', message: 'manifest 缺 hostApiVersion：这是旧模型插件包，须升级到当前主版本后重新投放' },
  { code: 'host_api_version_unsupported', kind: 'migration', message: 'hostApiVersion 主版本与宿主当前主版本不兼容，须迁移后重新投放' },
  { code: 'permission_unknown', kind: 'migration', message: 'manifest 声明了权限目录外的未知权限，须改用目录内权限或升主版本' },
  // —— 工单338 网络 origin 声明迁移错误 ——
  { code: 'network_origin_invalid', kind: 'migration', message: 'networkOrigins 含非法条目：必须是纯 origin（scheme://host[:port]，无路径/查询/片段）' },
  { code: 'network_origin_required', kind: 'migration', message: '声明了 network.request 但 networkOrigins 为空：精确 origin 是授权的参数面' },
  { code: 'network_origin_without_permission', kind: 'migration', message: '给了 networkOrigins 却没声明 network.request：origin 清单离开权限没有意义' },
  // —— 闸门错误（敏感包批准面，本票只登记形状）——
  { code: 'gate_denied', kind: 'gate', message: '用户拒绝批准，包不执行' },
  { code: 'gate_pending', kind: 'gate', message: '含敏感权限的包等待用户批准，批准前不执行' },
  // —— 基线域运行时错误 ——
  { code: 'view_unavailable', kind: 'runtime', message: '请求的快照段未在 capabilities 声明或当前不可用' },
  { code: 'config_invalid', kind: 'runtime', message: '私有状态载荷不在 JSON 数据模型内' },
  { code: 'config_too_large', kind: 'runtime', message: '私有状态超过单命名空间体积上限' },
  { code: 'config_io_failed', kind: 'runtime', message: '私有状态读写盘失败（原样回报，不静默）' },
  { code: 'unknown_context', kind: 'runtime', message: '调用方 webContents 不在执行上下文登记表中（崩溃/未登记）' },
  // —— 权限运行时错误（本票登记形状，消费路径归后续票）——
  { code: 'media_unavailable', kind: 'runtime', message: '系统媒体会话不可用' },
  { code: 'media_session_gone', kind: 'runtime', message: '目标媒体会话已消失（带代次会话键失效）' },
  { code: 'media_command_failed', kind: 'runtime', message: '媒体控制命令执行失败（目标当下能力不足或系统拒绝）' },
  { code: 'media_rate_limited', kind: 'runtime', message: '媒体控制超过每包速率上限（commandsPerSecond=5）——稍后重试' },
  // —— 工单336 媒体域运行时错误（media.read 闭环）——
  { code: 'media_thumbnail_rejected', kind: 'runtime', message: '缩略图校验未通过（类型/大小越界）——拒付，一个字节不出' },
  { code: 'media_permission_denied', kind: 'gate', message: 'media.read 未授权（授权账无在册绑定或已撤销）——媒体数据不付' },
  { code: 'network_permission_denied', kind: 'gate', message: '目标 origin 未获授权（network.request 缺失/已撤销/origin 不在授予集）——请求不付' },
  { code: 'network_rate_limited', kind: 'runtime', message: '网络请求超过每包速率或并发上限（requestsPerSecond=5、maxConcurrent=2）——稍后重试' },
  { code: 'network_timeout', kind: 'runtime', message: '网络请求超时（timeoutMs=10s）——与权限拒绝分域' },
  { code: 'network_redirect_blocked', kind: 'runtime', message: '重定向不自动跟随：返回目标 origin，如需访问须单独请求并先取得授权' },
  { code: 'network_failed', kind: 'runtime', message: '授权请求执行失败（DNS/连接/方法不支持/非法 URL）' },
  // —— 工单339 命名凭证错误（凭证面与网络权限相互独立）——
  { code: 'credential_unavailable', kind: 'gate', message: '命名凭证不可用（不存在/未绑定本包本 origin/密文不可解/加密能力不可用）——不静默改用其他凭证，也不撤销网络权限' },
  { code: 'credential_invalid', kind: 'gate', message: '凭证名/secret/headerName/origin 形状非法——拒绝写入' },
  { code: 'credential_store_unavailable', kind: 'runtime', message: '系统加密能力不可用（safeStorage/DPAPI 未就绪）——拒绝保存凭证，绝不落明文兜底' },
]

/** 投放包 manifest 契约字段（与 dropped-manifest.ts 解析行为一一对应） */
const MANIFEST_SCHEMA: readonly ManifestSchemaField[] = [
  { name: 'id', type: 'string', required: true, description: '插件标识（小写主机名字符集；同协议 origin 主机名）' },
  { name: 'name', type: 'string', required: true, description: '面板可读名' },
  { name: 'version', type: 'string', required: true, description: '版本串（展示用；代码代次由内容哈希推导）' },
  { name: 'entry', type: 'string', required: true, description: '相对包根的 .js/.mjs 入口' },
  { name: 'hostApiVersion', type: 'number', required: true, description: '目标宿主 API 主版本（首版只接受当前主版本）' },
  { name: 'permissions', type: 'string[]', required: false, description: '声明的敏感权限（权限目录封闭集合；缺省 = 零权限包，投放即生效）' },
  { name: 'optionalPermissions', type: 'string[]', required: false, description: '可选敏感权限（封闭目录同严；批准面逐项授予，未授 = 降级运行）' },
  { name: 'networkOrigins', type: 'string[]', required: false, description: 'network.request 的精确 origin 白名单（纯 origin：scheme://host[:port]，无路径/查询/片段；声明该权限时必须非空）' },
  { name: 'capabilities', type: 'string[]', required: false, description: '只读快照段声明（投放档四段上限，未知串静默裁剪）' },
  { name: 'mount', type: 'string', required: false, description: '挂载锚点（保留字段）' },
  { name: 'order', type: 'number', required: false, description: '挂载顺序（保留字段）' },
]

/** 完整契约目录（单一正典本体） */
export interface PluginContractCatalog {
  schemaVersion: 1
  hostApiVersion: typeof HOST_API_VERSION
  manifest: readonly ManifestSchemaField[]
  baselineHostApi: readonly BaselineApiDomain[]
  permissions: readonly PermissionDescriptor[]
  errors: readonly ContractErrorEntry[]
  resourceLimits: typeof PACKAGE_RESOURCE_LIMITS
}

export const PLUGIN_CONTRACT_CATALOG: PluginContractCatalog = {
  schemaVersion: 1,
  hostApiVersion: HOST_API_VERSION,
  manifest: MANIFEST_SCHEMA,
  baselineHostApi: BASELINE_HOST_API,
  permissions: PERMISSIONS,
  errors: ERRORS,
  resourceLimits: PACKAGE_RESOURCE_LIMITS,
}

/** 已知权限 id（封闭只读清单；解析器与运行时共用） */
export function knownPermissionIds(): readonly string[] {
  return Object.freeze(PERMISSIONS.map((p) => p.id))
}

/** 基线域 id 清单（封闭只读） */
export function baselineApiDomainIds(): readonly string[] {
  return Object.freeze(BASELINE_HOST_API.map((d) => d.id))
}

/** 已登记错误码清单（封闭只读） */
export function contractErrorCodes(): readonly string[] {
  return Object.freeze(ERRORS.map((e) => e.code))
}

/** 投影受众：agent/MCP 全量；批准 UI 最小面 */
export type CatalogAudience = 'agent' | 'approval-ui'

/** 可投影段封闭词表（投影接口的段集合；后续票的 MCP/批准 UI 按段拉取） */
export const PROJECTABLE_CATALOG_SECTIONS = Object.freeze([
  'identity', // hostApiVersion + schemaVersion（批准对象是「这套契约下的包」）
  'manifest',
  'baselineHostApi',
  'permissions',
  'errors',
  'resourceLimits',
] as const)

export type ProjectableSection = (typeof PROJECTABLE_CATALOG_SECTIONS)[number]

/** 投影接口形状：同源投影的稳定出口（本票只落形状，不实现批准 UI / MCP） */
export interface CatalogProjection {
  audience: CatalogAudience
  /** 本受众可见的段清单（取自 PROJECTABLE_CATALOG_SECTIONS 封闭词表） */
  sections: readonly ProjectableSection[]
  /** 段 → 数据（JSON 可序列化；按段独立取用） */
  data: Record<string, unknown>
}

/** 批准 UI 可见段：权限（批准对象）、身份、基线域（告知包能拿什么）、资源上限 */
const APPROVAL_UI_SECTIONS: readonly ProjectableSection[] = ['identity', 'baselineHostApi', 'permissions', 'resourceLimits']

/**
 * 同源投影：批准 UI 与 agent/MCP 从同一目录投影，不同受众裁剪不同段。
 * 纯函数、JSON 可序列化——投影结果可直出 IPC/工具描述，不含运行时对象。
 */
export function projectCatalog(catalog: PluginContractCatalog, audience: CatalogAudience): CatalogProjection {
  const sections: readonly ProjectableSection[] = audience === 'agent'
    ? PROJECTABLE_CATALOG_SECTIONS
    : APPROVAL_UI_SECTIONS
  const data: Record<string, unknown> = {}
  for (const section of sections) {
    switch (section) {
      case 'identity':
        data.identity = { schemaVersion: catalog.schemaVersion, hostApiVersion: catalog.hostApiVersion }
        break
      case 'manifest':
        data.manifest = catalog.manifest
        break
      case 'baselineHostApi':
        data.baselineHostApi = catalog.baselineHostApi
        break
      case 'permissions':
        data.permissions = catalog.permissions
        break
      case 'errors':
        data.errors = catalog.errors
        break
      case 'resourceLimits':
        data.resourceLimits = catalog.resourceLimits
        break
    }
  }
  return { audience, sections, data }
}
