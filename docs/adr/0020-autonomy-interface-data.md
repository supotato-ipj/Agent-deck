---
Status: accepted
---

# 自主管理的接口预留与数据口径：独立只读主体、提案队列、活动日志与目标键

自主管理在 ADR-0010 的矩阵里只剩一个「提案」列：不能直接写，批准只能由用户发起。但控制面、提案队列与审计都还没有落进代码，而自主管理最需要的「用户怎么用面板」今天完全不存在——使用日志只记 `{ts, exe}` 的外部进程启动/聚焦，面板内交互一条不记。本 ADR 把第三支柱的接口与数据口径钉死：一个独立的**自主管理主体**持专用凭证，默认只读三段快照加一套最小化活动数据，只能提交**提案**；面板在用户手势批准后以自主管理档落地、引用提案 id，永不代发。运行时、模型、调度与学习策略不在本 ADR 内。

## 前提与边界

- **一条控制面**（ADR-0009）：自主管理不是第二条通路，也不是新的监听面；它只是控制面上的一个受控调用方。
- **凭证与护栏**（ADR-0017）：身份只能由主进程从通道绑定推导；提案持久化、批准至多一次、审计写前记意图/写后记结局、结果未知不重放。
- **宽严矩阵**（ADR-0010）：自主管理不入宽严顺序，永不宽于后端档，不能直接发起写，只能产出提案；`proposals/approve` 只能存在于内核档且必须是用户交互。
- **插件包与对话通道**（ADR-0019、ADR-0018）：agent 创建的包永远落投放档；写插件包必须经待装载区、批准与哈希绑定；对话窗只做呈现与输入。
- 本 ADR **只定接口与数据口径**，不选运行时/模型/调度，不设计学习策略，不产实施。控制面、提案队列、审计在 ADR 落盘时仍不存在于代码；本 ADR 是后续实施与另一张 map 的输入。
- 现状事实：`PanelSnapshot` 固定八段（clock / sessions / hardware / weather / desktop / layout / settings / plugins），没有 usage/activity 段；`userData/usage` 只记 `{ts, exe}`，仅 start 事件参与 `fuseScores`；面板内交互无记录；`taskbar/get-state` 的响应含窗口标题、exe 绝对路径、path 型 `iconKey` 与托盘 tooltip。这些事实是下面默认读面与脱敏视图的理由，不是本 ADR 要重新争论的选择。

## 自主管理主体与凭证

**自主管理主体**是持**自主管理凭证**的调用方。它不是第五个信任档，不进宽严顺序；它没有任何对象写权限，只能读最小化数据与提交提案。它可以在面板内被拉起，也可以是用户自己的外部 agent——本 ADR 不选运行时，接口对两者相同。

- **一份长期凭证**：同一安装同一时刻只有一份有效长期凭证；用户在内核 UI 显式启用自主管理时签发。凭证只在签发时一次性展示/复制，落盘只存哈希；关闭自主管理即吊销，再次启用轮换新凭证（旧凭证永久失效）。
- **面板自拉起的运行**可另签同主体的短时凭证，不新增长期凭证；短时凭证随运行结束失效。
- **存储**：凭证元数据、启用开关与自主管理数据放在 ADR-0017 的专用控制面存储，不进 `app/config.json`；agent 不能经控制面改开关或凭证。
- **不可组合**：每次调用只按该次凭证绑定到一个主体。一个进程同时持有后端/外部凭证与自主管理凭证时，用哪份凭证调用就记哪一档；自主管理的「只能提案」只约束自主管理凭证发起的调用。
- **来源**：`proposals/submit` 由自主管理主体发起，`origin` 由主进程置为 `autonomy`；确认闸门超时转来的提案由系统置为 `gate-timeout`。自主管理只能读到 `origin=autonomy` 的提案；`gate-timeout` 提案属于发起的档位与内核 UI。

**自主管理投影**（其余方法对该档不存在，而不是「存在但被拒」）：

| 能力 | 自主管理 |
| --- | --- |
| `panel/snapshot` | R；按用户生效段集裁剪。默认 `plugins` / `layout` / `settings`，上限为 ADR-0010 的八段 |
| `activity/query` | R |
| `usage/summary` | R |
| `layout/agent-state` | R |
| `taskbar/autonomy-state` | R |
| `proposals/submit` | W（只写提案队列，不写任何受管对象） |
| `proposals/list` | R（仅 `origin=autonomy`） |
| `audit/read` | R（仅自主管理档） |
| `proposals/approve`、`rollback/*`、全部对象写、`plugins/list`、`plugins/read`、`plugins/rescan`、`taskbar/get-state`、`plugin-config/*`、`app/quit` | — |

`proposals/submit` 是一次控制面写：它进审计、带 `opId`，但不建对象回滚点——提案队列本身不是受管客体。它也不是矩阵意义上的「直接写」：真正的对象写只在用户批准后由面板以自主管理档执行。

### 自主管理凭证的启用/失效

- 启用：内核 UI 的用户手势签发凭证；同时开始写**活动日志**（见下）。
- 关闭：立即吊销凭证、停止写活动日志、拒绝新提案；已存在的待批提案保留到过期或用户处理，不自动删除。
- 面板重启：凭证、活动日志、提案都持久化；代理重连后继续使用同一份长期凭证（若未关闭）。
- 凭证丢失：用户轮换即可；旧凭证永久失效。轮换不会复活任何已消费的提案或旧授权（ADR-0017）。

## 活动日志

自主管理启用期间，面板把**用户在本面板内发起的动作**追加写入：

```
userData/autonomy/activity-YYYYMMDD.jsonl
```

每条记录：

```jsonc
{ "v": 1, "id": "20261025-000123", "ts": "2026-10-25T08:31:07Z", "kind": "card.click", "pluginId": "clock" }
```

- `v`：模式版本；未知字段忽略、未知 `kind` 跳过。
- `id`：`YYYYMMDD-<当日序号>`；同一日内单调递增，跨日由日期前缀排序。它是证据引用的稳定 id，保留期内不变。
- `ts`：UTC、秒精度；经 `activity/query` 暴露时粗化到分钟。
- 保留 90 天，按日文件滚动清理；与 ADR-0017 的审计/提案保留期对齐。

**事件集**（只记用户发起；经控制面的写由审计覆盖，不重复记；确定性推荐位的自动重排不记）：

| kind | 载荷 | 说明 |
| --- | --- | --- |
| `card.click` | `{ pluginId }` | 用户点击桌面卡片 |
| `session.action` | `{ tool, action: "focus" \| "launch" }` | 会话行点击；不记项目名、会话 id、标题 |
| `plugin.toggle` | `{ pluginId, enabled }` | 用户在设置里启停卡片 |
| `plugin.lifecycle` | `{ pluginId, action: "install" \| "remove" \| "update", source: "manual" }` | 用户手动投放/删除/改包；`source=manual` 表示**未观察到控制面写**，可能含外部进程旁路 |
| `layout.action` | `{ object: "desktop" \| "taskbar", action: "move" \| "pin" \| "unpin" \| "remove" \| "restore" \| "reset", target?: { kind: "doc" \| "app", key }, toZone?, beforeKey? }` | 拖拽、手钉、移除、恢复、恢复出厂；`reset` 无 target |
| `taskbar.action` | `{ action: "app-click" \| "rec-click", target: { kind: "doc" \| "app", key } }` | 应用组/推荐组点击；结果（launch/focus 等）不进日志 |
| `context.action` | `{ actionId, targetKind }` | 右键菜单项；`targetKind` 为 `desktop` / `taskbar-app` / `taskbar-recommendation` / `card` / `search-result` / `session-row` |
| `search.action` | `{ action: "activate" \| "open" \| "reveal", resultRank?, resultKind? }` | 搜索使用；`resultKind` 为 `file` / `folder` / `app` / `url` / `other`，**不记查询词与路径** |

**不采集**：文件名、绝对路径、窗口标题、项目名、查询词、会话正文、剪贴板、键盘、屏幕内容、托盘 tooltip。活动日志从设计上就不含这些字段，因此即使被本机其他进程读取，泄露面也小于桌面/会话快照。

**用户发起**的判据是内核 UI 的命令层；经控制面的写（包括用户批准提案后的落地写）记审计与提案结局，不写活动日志。用户手动改插件目录由插件宿主观察到目录变化后写 `source=manual`；若该变化实际来自旁路的外部进程，日志无法区分——这与 ADR-0010 的协作性边界一致。

### 目标键

- `doc:<hex>` 与 `app:<hex>` 是高敏对象在自主管理数据面里的不透明稳定标识。由**每安装随机盐**加对象规范身份（桌面项绝对路径 / exe 绝对路径）导出，取摘要截断；不落反向映射，面板按当前状态重算解析。
- 同一对象在活动日志、使用聚合、布局/任务栏脱敏态、提案里用同一个键；提案的参数用键，批准 UI 再解析成用户可读的真实对象。
- 改名/移动/换目标可能产生新键；v1 不追跨改名的身份连续性。
- 盐随控制面存储持久化：关闭再启用、清空活动数据都不轮换。v1 不提供盐轮换；要彻底断开历史关联需另开票，且必须接受待批提案与历史证据引用一并作废。
- 目标键不是安全边界：同一用户的本地进程（包括带文件工具的 agent）仍可直接读控制面存储与 `userData`。它只保证**按接口正常读取时**不把高敏内容送进模型上下文。

## 读取接口

### 快照段

自主管理读 `panel/snapshot` 时按用户生效段集裁剪。默认只开三段：

- `plugins`：已装载插件包的 id/name/version/status 等管理信息；不含源码。
- `layout`：桌面区几何（`docZone`、`docMaxRows`）。
- `settings`：卡片透明度与停用卡片 id。

默认关闭 `clock` / `hardware` / `sessions` / `desktop` / `weather`。用户可在内核 UI 的段级开关里逐段放开，上限仍是 ADR-0010 的八段；放开 `desktop`（绝对路径）、`sessions`（项目 basename）或 `weather`（经纬度）会削弱默认的最小化承诺，开关必须展示敏感度提示。

`config·观感与检索` 的其余值（如搜索引擎、天气坐标）在 v1 不另设专用读方法；自主管理可以对其提案，但批准 UI 必须显示当前值与新值。

### `activity/query`

```jsonc
// request
{ "v": 1, "since"?: "2026-10-01T00:00:00Z", "until"?: "...", "kinds"?: ["card.click"], "after"?: "20261025-000123", "limit"?: 200 }
// response
{ "v": 1, "events": [ /* 活动事件，ts 粗化到分钟 */ ], "next"?: "20261025-000124" }
```

默认 200 条、上限 1000；`after` 是上一页最后一条事件的 `id`。只对自主管理主体与内核 UI 开放；后端/外部/投放档不可读。读取按 ADR-0017 记入审计（档 × 方法 × 段集/时间窗聚合）。

### `usage/summary`

```jsonc
{
  "v": 1,
  "windows": {
    "7d": { "startCount": 0, "focusCount": 0 },
    "30d": { ... },
    "90d": { ... }
  },
  "apps": [
    { "targetKey": "doc:...", "startCount": 12, "focusCount": 8, "score": 3.42, "lastUsedDay": "2026-10-24" }
  ],
  "totals": { "startCount": 0, "focusCount": 0 }
}
```

- `score` 是现有 `fuseScores` 产出的当前分数（与推荐位同源），不另造窗口分；`windows` 只给窗口内计数。
- `apps` 只映射**当前可解析的桌面条目**（doc 键）；不出路径、exe、显示名、精确时间戳；`lastUsedDay` 为日粒度。
- 只对自主管理主体与内核 UI 开放；读取记审计。

### `layout/agent-state`

```jsonc
{
  "docZone": { "left": 0, "top": 0, "maxWidth": 0 },
  "docMaxRows": 8,
  "items": [
    { "targetKey": "doc:...", "zone": "doc", "group": "pdf", "rank": 2 },
    { "targetKey": "doc:...", "zone": "app" }
  ]
}
```

- 覆盖 doc/app 两个 zone（`desktop/move` 的 app 侧也需要可见），只给目标键与语义位置；不出文件名、路径、图标键。
- `group`/`rank` 只对 doc 项有意义；app 项只有 `zone`。

### `taskbar/autonomy-state`

```jsonc
{
  "enabled": true,
  "hiddenButtons": ["start"],
  "metrics": ["cpu", "ram"],
  "trayOverflowLimit": 5,
  "maximizeRetract": true,
  "apps": [ { "targetKey": "app:...", "pinned": true, "running": true } ],
  "recommendations": [ { "targetKey": "doc:...", "rank": 0 } ],
  "excluded": [ { "targetKey": "app:..." } ]
}
```

- **不含** `title`、`exe`、`path`、`label`、`iconKey`、`tray`、`tooltip`。这些字段属于内核 UI 的完整 `taskbar/get-state`；它们若进自主管理的数据面，本 ADR 的最小化承诺（不出现窗口标题/绝对路径）当场失效。
- `apps` 用 app 键；`recommendations` 用 doc 键；`excluded` 用 app 键。提案需要真实 exe/名称时由面板在批准时解析；解析不到即 `stale`。

### 为什么是方法而不是快照段

活动是事件流，不是 1 Hz 状态：塞进快照会放大每拍载荷、拿不到回放序，也让裁剪只能按段而不能按事件类型/时间窗。四个读取方法把脱敏、分页、档位可见性集中在一处；`PanelSnapshot` 的八段语义保持不变。

## 提案接口

### 提交

```jsonc
// proposals/submit request（自主管理凭证）
{
  "v": 1,
  "target": { "object": "plugin-package" | "layout" | "config-appearance-search" | "kernel-plugin", "key": "..." },
  "action": { "method": "plugins/install", "params": { "stagedPackageId": "..." } },
  "rationale": "给用户看的一句话",
  "evidence": [ { "kind": "activity" | "usage" | "proposal", "ref": "..." } ],
  "expiresAt"?: "2026-11-01T00:00:00Z"
}
```

- `origin` 不由调用方给：自主管理提交记为 `autonomy`，确认闸门超时由系统记为 `gate-timeout`。
- `evidence` 只放引用（活动事件 id、`targetKey` + 窗口、历史提案 id），不放原始内容。
- 插件 `install` / `update` 的 `params` 引 `stagedPackageId`；见下。
- `rationale` 是用户可见文本；因为代理看不到高敏名称，它可能只能写通用理由，真实对象由批准 UI 解析后展示。

### 提案记录

```jsonc
{
  "v": 1,
  "id": "proposal-...",
  "origin": "autonomy",
  "createdAt": "...",
  "expiresAt": "...",
  "target": { "object": "...", "key": "..." },
  "action": { "method": "...", "params": { ... } },
  "rationale": "...",
  "evidence": [ ... ],
  "status": "pending",
  "consumedAt"?: "...",
  "result"?: "success" | "failed" | "result_unknown",
  "stagedPackageId"?: "...",
  "decisionNote"?: "用户可选备注"
}
```

记录里的顶层 `stagedPackageId` 是派生字段，供待装载区清理与审计；方法调用以 `action.params` 里的引用为准。

状态语义：

- `pending`：待用户处理；可批准、拒绝或过期。
- `stale`：一次批准尝试的校验失败（目标不在、引用键缺失、包哈希不匹配等）；**不消费一次性授权、不写**，可稍后重试或拒绝；仍未过期。
- `rejected`：用户拒绝；终态。
- `expired`：过期未处理；终态。
- `approved`：校验通过、一次性授权已消费且落地写已尝试；`result` 给出 `success` / `failed` / `result_unknown`。失败/未知都不自动重放。

### 配额、去重与过期

- 同一 `target + action + params` 在 `pending`/`stale` 期间重复提交，返回既有提案，不新增记录。
- 待批（`pending` + `stale`）上限 **5** 条；默认过期 **7 天**；代理可请求更短的 `expiresAt`，不能超过 7 天。
- 同一 `dedupeKey` 被用户拒绝后 **24 小时**内不得再提交；不设日限额。被拒绝后换目标/换理由的新提案不受此限。
- 配额/冷却错误走传输无关信封；`cooldown` 带 `retryAfterMs`，`quota_exceeded` 要等过期/拒绝释放槽位。`busy` 仍是唯一可立即重试的 code（ADR-0019）。
- 自主管理可读自己的提案及 `decisionNote`，包括 `rejected` / `expired` / `stale` ——拒绝与过期是最直接的负反馈。

### 插件包提案的物料化

`plugins/install` / `plugins/update` 的提案在**提交时**把 `sourceDir` 拷进控制面待装载区、冻结字节并算 sha256，返回 `stagedPackageId` 记入提案；批准时安装这份冻结字节，**不再读 `sourceDir`**。源目录之后被改动/删除不会改变已提交提案。卸载不需要物料。

这沿用 ADR-0019 的「批准与哈希绑定」语义，只是把冻结时点从 install 调用前移到提案提交时；待装载区副本保留到提案过期，过期即清理。提案提交时的包校验失败即拒收，不产生提案记录。

### 批准

批准只能发生在内核 UI，由真实用户手势触发；`proposals/approve` 不在自主管理投影内。顺序固定：

1. **解析并展示**：把 `targetKey` 解析成真实目标，展示给用户；同时展示 `rationale`、证据摘要、当前值/新值或布局预览；插件提案展示包 id/name/version、文件清单、哈希与 manifest，不执行包代码。
2. **校验**：目标仍存在且身份未变；布局引用键（如 `beforeKey`）仍存在；插件 `stagedPackageId` 的字节哈希匹配；动方法与参数对自主管理投影合法。失败 → 提案保持/转 `stale`，不消费授权、不写。
3. **消费**：校验通过后原子标记一次性授权已消费（ADR-0017 的至多一次语义）。
4. **执行**：以 `tier=autonomy`、`proposalId` 为落地上下文执行那次写；写前记意图、写后记结局；成功记 `result=success`，确认失败记 `failed`，无法确认记 `result_unknown`。
5. **不重放**：任何失败/未知都不自动重试；代理可提交一条新的提案（新意图、新批准），但同一 `dedupeKey` 的拒绝冷却不约束失败重提。

批准 UI 永远显示真实目标与当前/新值；代理看不到的高敏字段（如 config 的天气坐标）也必须让用户看到。校验失败不允许静默重定向到「同名目标」——那等于把授权挪到用户没批准的对象上。

## 范围与确定性机制

自主管理的提案范围沿用 ADR-0010 的自主管理列，不新增客体：

| 客体 | 自主管理提案 |
| --- | --- |
| 插件包 | `plugins/install` / `plugins/update` / `plugins/uninstall` / `settings/set-card-enabled` |
| 布局 | 当前布局写方法（`desktop/move` / `desktop/move-batch` / `desktop/reset-layout` 等；以 `BridgeMethods` 当前符号为准） |
| config·观感与检索 | 当前及后续受控新增的观感/检索写方法（如 `settings/set-card-opacity`） |
| 内核插件层 | taskbar 的 `set-*` 方法；具体方法开放级仍归 #276 / #277 |
| 信任根与持久化 / `plugins.dir` / 凭据 / 审计 / 回滚 / 批准 | — |

- 自主管理**永不直接写**；上表每一格都是「提案」，不是「调用」。
- **推荐位归确定性**：`fuseScores` 负责打分、排序与自动重排；自主管理不提交「替换推荐排序/重排推荐位」的提案。它可以对单个应用提案 pin/remove/restore 这类显式覆盖（属内核插件层），批准后确定性机制继续对剩余候选排名——显式覆盖不是新排序。
- #276 / #277 尚未决定具体 taskbar 方法的开放级；本 ADR 只预留提案接口，不预判它们。如果某方法不在自主管理投影内，`proposals/submit` 返回 `not_manageable`，不是静默失败。
- **不盲写**：批准 UI 始终显示当前值与拟写值；代理的读集可以小于提案面，但用户必须在真实目标上点头，且不允许静默重定向。

## 启用、保留与删除

- **默认关**。单一开关在内核 UI；启用是用户手势，开关与凭证元数据落在 ADR-0017 的控制面存储，`app/config.json` 的回滚/整份回写不会碰到它。
- **启用后**开始写活动日志、允许提交提案；**关闭**立即吊销凭证、停止写活动日志、拒绝新提案；待批提案保留到过期或用户处理；不自动删除活动数据。
- **保留**：活动日志 90 天；提案与审计按 ADR-0017 保留 90 天；现有 `userData/usage` 使用日志保持原样、不合并、不影响推荐位。五工具扫描器仍走快照 `sessions` 段，不并入活动日志。
- **清空活动数据**（内核 UI 的用户手势）：删活动日志与其派生缓存；**不动**使用日志、提案、审计；盐不轮换。清空后旧提案的 `evidence` 引用可能解析不到，批准 UI 显示「证据不可用」，但目标/动作本身自足，仍可批准或拒绝。
- **彻底删除**（含提案/审计）不提供一键 UI；用户作为本机所有者可自行处理控制面存储。v1 不把「删除审计」包装成自主管理的安全动作。
- **出机边界**：面板无法约束模型收到数据之后的行为，因此**数据面本身就是合同**：默认三段 + 活动/聚合/脱敏态；不出现绝对路径、文件名、窗口标题、项目名、查询词、会话正文；高敏目标用不透明键。用户主动放开 `desktop`/`sessions`/`weather` 是明确的、有敏感度提示的放宽。目标键/护栏是协作性的：带文件工具的本地 agent 仍可直接读 `userData`，这与 ADR-0010 的效力边界一致。

## Considered Options

- **把自主管理做成第五个信任档**：会引入一个比后端更窄但不入序的列，和 ADR-0010 已定的「形状不同」冲突；否决，保留独立主体 + 专用凭证。
- **复用后端会话凭证或外部客户端凭证**：前者要求面板托管运行时、并把逐会话授权改造成预授权；后者把只读+提案能力和长期外部写凭证混在一起，吊销与审计粒度变粗。否决。
- **默认读八段快照**：把桌面绝对路径、项目 basename、天气经纬度常态送进模型上下文；否决，改为默认三段 + 用户逐段放开。
- **把活动日志做成快照片段**：1 Hz 事件流放大载荷、失去回放序、裁剪粒度不对。否决。
- **把完整 `taskbar/get-state` 给自主管理**：窗口标题、exe 路径、path 型 iconKey、托盘 tooltip 全部泄露；否决，改为 `taskbar/autonomy-state`。
- **在批准时才拷插件包**：源目录可变，批准与哈希不绑定；否决，改为提交时冻结。
- **先消费授权再校验**：一次无效点击烧掉一次批准；否决，改为先校验后消费。
- **无待批上限/无拒绝冷却**：提案队列会被刷屏；否决，改为 5 条 + 7 天 + 24 小时冷却。
- **合并使用日志与活动日志**：破坏「使用日志只含进程路径与时间戳」的既有承诺，且和扫描器重复采集；否决。
- **把高敏目标以明文交给代理**：模型能读出文件名/路径/标题，出机后不可控；否决，改为目标键 + 批准 UI 解析。
- **让自主管理替换/重排推荐位**：跨档冲突，且确定性推荐位的用户可预期性被破坏；否决，推荐位排序归 `fuseScores`。
- **活动只出聚合、不出事件**：隐私更强，但失去先后顺序与具体交互信号；否决，事件级保留在本地，读取时只做字段最小化与时间粗化。

## Consequences

- 控制面实施需要新增：自主管理凭证与投影、活动日志、目标键盐、`activity/query`、`usage/summary`、`layout/agent-state`、`taskbar/autonomy-state`、提案队列的提交/列表/批准与冻结包物料。当前控制面/提案/审计尚未在代码中实现，这些是实施输入。
- ADR-0019 表中留给 #75 的格子落定：自主管理不投影 `plugins/list` / `plugins/read` / `plugins/rescan`；它用 `plugins` 段与 `settings.disabledCards` 识别可提案的包，源码读取不开放。
- ADR-0010 的自主管理列不变；默认三段读是**在八段上限内的用户级收紧**，不是改矩阵。`taskbar/get-state` 的完整响应仍只给内核 UI；后端/外部/投放的脱敏边界由后续票 #282 承接。
- #276 / #277 仍决定具体 taskbar 方法的内核/后端/外部开放级与闸门形态；本 ADR 只保证「若在自主管理投影内，就走提案」。
- 运行时、模型、调度与学习算法另开 map；本 ADR 不承诺自主管理何时运行、用什么模型、如何学习。
- 风险与缓解：目标键在改名/移动后换键（v1 接受，提案会 stale）；本地文件工具可绕过目标键（协作性边界，已写明）；活动日志体积（90 天 + 日文件滚动）；提案刷屏（5 条待批 + 7 天过期 + 24 小时拒绝冷却）；用户对不透明目标困惑（批准 UI 必须解析真实名称）；插件待装载区占用（提案过期清理）。
- 验证：纯决策文档与词汇变更，无运行时代码；`git diff --check` 通过、PR CI 通过；不跑真机验收电池（没有运行时行为可验）。
- **后续票**：[非内核档 taskbar/get-state 的脱敏边界（窗口标题与托盘提示）](https://github.com/supotato-ipj/Agent-deck/issues/282) 承接 backend/external/投放档的 title/tooltip/exe/path 字段集，不在本 ADR 内顺手改。
