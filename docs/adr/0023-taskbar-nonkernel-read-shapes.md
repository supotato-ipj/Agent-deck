---
Status: accepted
---

# 非内核档任务栏读面：三份命名形状、保留寻址键、剥窗口标题与托盘

ADR-0010 把 `taskbar/get-state` 列入「只读 3」，但没有定非内核档能看见哪些字段；ADR-0019 把同一方法放进投放窄面，也没有定响应形状；ADR-0020 为自主管理另开了 `taskbar/autonomy-state`，并把完整 `taskbar/get-state` 留成内核面专属；ADR-0021 只动策略写侧；ADR-0022 给 #282 留了一条硬约束——非内核档必须保留可寻址身份，否则 5 个栏布局写失效。本 ADR 收口 #282：拍板三份**命名形状**，非内核档一律剥窗口标题与整个托盘，后端/外部保留 `exe` / `name` 寻址键、投放只拿展示态；同一档凡返回 `TaskbarState` 的请求响应、写方法响应与事件同形。

## 前提校正

- **`TaskbarState` 不止 `taskbar/get-state` 一个出口。** 4 个栏布局写（`set-app-pinned` / `rec-pin` / `rec-remove` / `rec-restore`）与 4 个策略写（`set-button-hidden` / `set-metrics` / `set-tray-overflow-limit` / `set-maximize-retract`）的响应是 `TaskbarState`；`drag-drop` 的普通响应只有 `{ ok, error? }`，但它的控制面 dry-run 预览按 ADR-0022 返回 `TaskbarState`，同样要按档裁剪；`set-enabled` 是内核专属，不在非内核面。只在 `get-state` 上脱敏，agent 调一次 `set-metrics` 就能从响应里拿到完整状态。
- **`taskbar/get-state` 是内核 UI 的读法。** 任务栏条带、弹窗菜单、托盘溢出与面板页四处直调；脱敏只能发生在控制面投影与投放窄面，不能改方法本体。这与 ADR-0022 的三面边界一致：控制面是 agent 面向的投影，受信内部桥与内核 UI 直调不受影响。
- **ADR-0022 已写死寻址键。** 5 个栏布局写以 `exe` / `name` 寻址；非内核 `taskbar/get-state` 必须保留可寻址身份，否则 5 法只能退回内核档，等于重开 #277 的寻址面。因此本 ADR 不引入 `targetKey`。
- **托盘在非内核档没有消费者。** `tray-click` 已由 ADR-0022 判为全档不投影；`tray-icon` 是内核 UI 的读侧方法，尚未进控制面（ADR-0022 明确把未来的托盘图标读留给另票）。`tray[].key` 是 `<hwnd>:<uid>` / `guid:<guid>`，`iconKey` 是 `path|mtimeMs`。剥掉 `tooltip` 后，剩余字段没有任何非内核方法能消费。
- **投放今天拿的是完整响应。** ADR-0019 的投放窄面与 ADR-0017 的每包身份绑定尚未落代码，今天是零身份状态；本 ADR 定的是目标态，不承诺兼容 shim。

## 决策

### 1. 三份命名形状

| 面 / 档 | 形状 | 字段 |
| --- | --- | --- |
| 内核 UI / 内核档插件包受信内部桥 | `TaskbarState`（不变） | 完整 `TaskbarState` |
| 控制面 · 后端 / 外部 | `TaskbarStateManaged` | 见下 |
| 投放窄面 | `TaskbarStateDisplay` | 见下 |

`TaskbarStateManaged`：

```ts
{
  enabled: boolean
  hiddenButtons: TaskbarButtonId[]
  recommendations: Array<{ name: string; display: string; exe: string }>
  excluded: Array<{ exe: string; label: string }>
  metrics: TaskbarMetric[]
  apps: Array<{ exe: string; label: string; pinned: boolean; running: boolean }>
  trayOverflowLimit: TaskbarTrayOverflowLimit
  maximizeRetract: boolean
}
```

`TaskbarStateDisplay`：

```ts
{
  enabled: boolean
  hiddenButtons: TaskbarButtonId[]
  recommendations: Array<{ display: string }>
  metrics: TaskbarMetric[]
  apps: Array<{ label: string; pinned: boolean; running: boolean }>
  trayOverflowLimit: TaskbarTrayOverflowLimit
  maximizeRetract: boolean
}
```

三份形状的字段取舍：

- **一律剥** `apps[].title` 与整个 `tray[]`：前者是窗口标题，后者含 `tooltip`；ADR-0007 只允许它们用于内核面的即时显示，且非内核档没有任何托盘方法。
- **managed 另剥** `recommendations[].path` 与全部 `iconKey`：没有已投影方法按 `path` 寻址，`name` + `exe` 已够；`iconKey` 是路径型缓存键，管理侧不需要图标渲染。策略字段与 `label` / `display` 保留——agent 的确认请求与用户可读输出要有名字可用（闸门 UI 本身读内核完整态）。
- **display 另剥** `excluded`、`name`、`exe`、`path`、`iconKey`：投放没有 `desktop` 段、没有图标取用通路、也没有 5 个栏布局写，这些字段对它没有可执行用途，反而带出它在别处看不见的绝对路径。`display` 与 `label` 保留用于渲染。
- **`running` 保留**：它是栏面状态的一部分（区分已钉/运行、判断哪些条目可拖）；它不是标题或路径。若将来要收，另开票。
- **被剥字段用缺失表达**：三份形状各自命名，脱敏形状根本没有这些属性；不用 `null` / 空数组，因为 `title: null` 在完整形状里已经表示「未运行/无标题」，`tray: []` 会误读成「当前没有托盘图标」。

### 2. 覆盖所有 `TaskbarState` 出口

控制面所有返回 `TaskbarState` 的方法按调用方档位返回对应形状：`taskbar/get-state`、4 个栏布局写、4 个策略写，以及 `drag-drop` 的 dry-run 预览（其普通响应仍是 `{ ok, error? }`）；未来 `taskbar/changed` 若进控制面事件，也按同档同形投递。内核 UI 与受信内部桥的完整 `TaskbarState` 不变。这是 ADR-0010「事件与快照同口径」在任务栏读面上的落点。

### 3. `desktop` 段开关不联动

后端/外部的 `desktop` 快照段可以由用户单独关掉；这**不**改变 `taskbar/get-state` 里的 `exe` / `name`。任务栏身份属于任务栏客体，不属于 `desktop` 段；用户要隐藏应用身份，按 ADR-0010 的「档 × 客体」格把任务栏行收紧（只读或不在投影内）。不选联动，是因为联动会让「读段开关」顺带改变 5 个栏布局写的可用性；也不选不透明键，因为那会重开 #277 的寻址面。

### 4. 内核面与自主管理不变

- 内核 UI、内核档插件包的受信内部桥继续拿完整 `TaskbarState`；任务栏 tooltip、多窗列表、托盘 tooltip 的行为不变。
- 自主管理继续用 `taskbar/autonomy-state`，看不到 `taskbar/get-state`；目标键、活动日志、提案口径均不变（ADR-0020）。
- `taskbar/tray-icon` 是读方法、`taskbar/status` 是事件，二者都不在控制面投影内，不受本决策影响。

## 票面四问的答案

1. **是否至少剥 `title` 与 `tray.tooltip`？`exe` / `path` / `iconKey` 是否保留？** 剥 `title` 与整个 `tray`。managed 保留 `exe` / `name`（寻址必需），剥 `path` / `iconKey`；display 连 `exe` / `name` 一起剥。
2. **三档共用一份脱敏响应，还是各一份字段集？** 三份命名形状：内核完整、后端/外部共用 managed、投放 display。后端与外部没有可区分理由；投放的需求面更小。
3. **若剥 `exe` / `path`，pin/remove 如何接受 `targetKey`？** 不剥 `exe` / `name`，不引入 `targetKey`；5 法签名不变。若未来要剥，必须同时给等价不透明键并重开 ADR-0022 的寻址面，不能静默发生。
4. **与 #276 / #277 的 taskbar 方法开放级如何对齐？** 读写分开：策略字段与 5 个栏布局写的寻址键都在 managed 里保留；写侧格位、闸门、dry-run、回滚点、审计不变；投放的 display 不含写侧需要的键，因为投放本来就没有这些写。

## Considered Options

- **不脱敏，三档继续拿完整 `TaskbarState`**：窗口标题、托盘提示、绝对路径全部进 agent 数据面；ADR-0020 已为自主管理否掉同款，否决。
- **只剥 `tray.tooltip`，保留 `tray[].key` / `iconKey`**：非内核档没有托盘方法可消费，剩余字段只是句柄与路径型缓存键；否决。
- **所有非内核档共用一份脱敏形**：投放会拿到它在 `host.view` 4 段里看不到的 `exe` 绝对路径；投放档是最窄档，否决。
- **每档一份字段集（后端 / 外部 / 投放各不同）**：后端与外部没有可区分理由，形状爆炸；否决。
- **剥 `exe` / `name` + 引入 `targetKey`**：重开 ADR-0022 的寻址面并要改 5 法与内核 UI；本票不预支，否决。
- **`desktop` 段开关联动任务栏路径**：读段开关顺带改变写能力；要么破坏 5 法寻址，要么需要动态方法可用性；否决。
- **被剥字段置 `null` / 空数组**：与「没有标题」「没有托盘图标」的既有语义冲突；否决。
- **只脱敏 `taskbar/get-state`**：写方法响应成为侧门；否决。
- **managed 保留 `recommendations[].path` / `iconKey`**：没有已投影方法需要它们，路径型字段只会扩大泄露面；否决。
- **display 保留 `excluded` / `name`**：没有恢复方法、没有栏面呈现需求；`name` 是文件级身份；否决。
- **剥掉 `running`**：栏面状态不完整，agent 无法判断已钉/运行，渲染也画不出运行中的未钉应用；否决（保留）。
- **把 `taskbar/get-state` 的读形状做成用户可逐字段开关**：过度精细、无法审计，且与「档 × 客体」的收紧单位冲突；否决。

## Consequences

- **ADR-0007**：补记——`title` / `tooltip` 口子收紧到内核面；非内核脱敏态不含。
- **ADR-0010**：补记——任务栏读面用三份命名形状落定「段内字段级裁剪」的后续票；不是任意按档减字段，段级投影名单不变。
- **ADR-0019**：补记——投放窄面的 `taskbar/get-state` 返回 `TaskbarStateDisplay`；方法集不变，响应变窄是有意破坏性变更，不做 shim。
- **ADR-0020**：补记——自主管理读面不变，继续用 `taskbar/autonomy-state`。
- **ADR-0021**：补记——策略字段在两个非内核形状里全保留；策略写响应也按档形状返回。
- **ADR-0022**：补记——`exe` / `name` 寻址键保留，不引入 `targetKey`；5 法签名不变；`desktop` 段开关不联动。
- **GLOSSARY**：新增**脱敏态**词条（按档固定的只读视图；与段级裁剪、任意字段级裁剪区分）。
- **实施输入**（控制面与投放身份绑定尚未落代码）：控制面适配器按档返回 managed/display；投放窄面的 invoke 返回 display；所有 `TaskbarState` 出口（含写响应与未来事件）统一裁剪；读审计按「档 × 方法 × 形状名」聚合，不逐次记；错误信封与 unknown tool 语义不变。本 ADR 不产代码。
- **破坏性**：投放包今天能读完整 `TaskbarState`，目标态只给 display；这是 ADR-0019 既定的档位收窄，不做兼容 shim。后端/外部尚无实现，无运行时影响。
- **验证**：纯决策与词汇变更，无运行时代码；`git diff --check` 与 PR CI 通过即可，不跑真机验收电池（没有运行时行为可验）。
- **地图 #66**：#282 关闭后，本 map 的三件目的地（控制面形态 / 传输与宿主 / 可管理对象边界与护栏）与自主管理接口均已收口，无剩余前沿；实施与细化另开 map。
