---
Status: accepted
---

# 插件包的写入契约与宿主面：投放窄面、内核受信内部桥、待装载区事务

`doc-group-cards` 是第一方维护的插件包，却按扫描根落在**投放档**：它声明 `capabilities: ["desktop"]`，并调用 `desktop/launch|reveal|rename|trash|paste|copy-path|clipboard-copy|clipboard-cut|clipboard-state|icon` 与 `plugin-config/get|set`——其中 9 个是 ADR-0010 排除的「面板外的世界」，`desktop` 段也不在投放档的 4 段上限内。按 ADR-0010 的矩阵裁 `view`/`invoke`，这个已交付的包会整体失效；可它又不能按不可信投放代码来裁——它按设计就是桌面文件管理器。同一份代码里，内置 `search` / `sessions` 卡也在调被控制面排除的 `search/*`、`session/focus`。于是三件事同时成立：**控制面（agent 面向）与插件宿主面（插件包拿到什么）不是同一条面**；**内核档插件包拿受信内部桥，投放型插件包拿投放窄面**；**第一方包应随面板发布在内核档，而不是靠用户根获得投放档**。

本 ADR 拍板：`doc-group-cards` 迁到随面板发布的**第一方包根**（内核档），用户可停用、不能运行期卸载；安装契约只写**用户插件根**（投放档），agent 永远不能经控制面产出内核档包；控制面安装走**待装载区事务**（`sourceDir` → 内部控制面暂存 → 严格校验 → 闸门 → 提交 → 有界激活），失败回滚；投放型插件包的宿主面固定为 `host.view` 4 段 + `taskbar/get-state` + 自身 `host.config`，invoke 不再由 manifest 声明；`plugin-config` 不是第五类控制面客体，而是插件私有状态，经主进程绑定的 `host.config` 访问；旧包在 update 成功后送回收站，不建用户可点还原的「回滚点」。agent 创建的包只能是投放档，因此**能力授予的上限由包根决定，agent 不能给自己提权**。

## 前提校正

- **方法表以 `origin/master` 为准：48 法**（`app/src/shared/contract.ts:404-685`）。ADR-0010 记的 27 法、地图 #66 记的 25/27 法都是历史口径；本 ADR 的契约形状不依赖具体计数。
- **`doc-group-cards` 的档位是投放，实际能力却远超投放上限**：manifest 声明 `capabilities: ["desktop"]`（`app/plugins/doc-group-cards/plugin.json`）；安装脚本的缺省根是用户插件根 `userData/plugins`（`app/scripts/install-plugin.mjs:47`）；`card.js` 调用 9 个「面板外」方法与 `desktop/icon`、`plugin-config/get|set`（`app/plugins/doc-group-cards/card.js:784,885,1017,1077,1108,1377,1383,1386,1389,1392,1527,1598`）。`desktop/icon` 与 `desktop` 段绑定同口径（ADR-0010）。
- **内置卡也在用控制面排除的方法**：`search` 卡调 `search/action|activate|deactivate|query`（`app/src/renderer/cards/search/card.ts:129,150,169,221`），`sessions` 卡调 `session/focus`（`app/src/renderer/cards/sessions/card.ts:16`）。它们都是内核档插件包，今天拿的是未裁剪的 `deps.invoke`（`app/src/renderer/plugins.ts:147`）。这说明「插件包拿到的 invoke」与「控制面投影」是两条面，而不是同一条。
- **`plugin-config` 的命名空间隔离今天只是约定式**：`id` 由调用方自证，主进程只校验 id 形状与体积（`app/src/main/services/plugin-config.ts:88-93`、`app/src/main/plugins/config-store.ts:117-130`），ADR-0014 已自陈。ADR-0017 的每包执行上下文是把它收成强制式的前提。
- **`ready()` 今天不向主进程回报完成**：`void instance.ready(this.ctx)` 在 try/catch 里（`app/src/main/plugins/service.ts:267-276`），异步 rejection 无人接管。本 ADR 的「有界激活」要求补上这条完成信号。
- **包根现状是位置约定**：`roots: [BUILTIN_CARDS_ROOT, config.plugins.dir || userData/plugins]`（`app/src/main/index.ts:222-223`），第一项被当作内置根，没有显式的根→档绑定。本 ADR 把它改成显式登记。

## 两条面与包根

**控制面**是 agent 面向的投影；**插件宿主面**是插件包从面板拿到的 API（`view` 快照段、`config` 私有状态、可用 invoke 方法集）。两者同出一张 `BridgeMethods`，但不是同一条投影；信任档由**包根**决定，不由 manifest 或调用参数自报。

- **包根**：插件包扫描根，根→信任档显式登记。内置卡根与**第一方包根** = 内核档；用户插件根（`config.plugins.dir || userData/plugins`）= 投放档。第一方包根随面板发布，用户可停用、不能经控制面卸载；用户根随目录热插拔，投放即生效。
- **内核档插件包**（内置卡、`doc-group-cards` 迁移后）：宿主面 = **受信内部桥**，即 `BridgeMethods` 母集减去 `app/quit`。它们随面板发布，信任来源与内核 UI 相同；`app/quit` 不给任何插件包，避免一个包的 bug 直接退出面板。
- **投放型插件包**（用户根，含 agent 安装的一切包）：宿主面 = **投放窄面**——`host.view` 4 段（clock / hardware / layout / settings）、`taskbar/get-state`（R）、自身 `host.config`；其余方法对该档**不存在**。读侧由 `host.view` 推送，不需要 `panel/snapshot` invoke。
- **投放包的 `capabilities`** 只能在 4 段上限内声明；控制面安装越档/未知即报错，手动投放沿用「少给而非不给」的静默裁剪。`invoke` 不由 manifest 声明——它是档的宿主面，不是包的能力。

## 写入契约

**安装只写用户根。** `plugins/install` 没有 `root` 参数；内核/第一方包随 app 发布，不经控制面安装。agent 创建的包因此只能是投放档，**不能借安装动作给自己或自己的包提权**。

- `plugins/install { sourceDir }`：主进程把源目录拷进内部控制面的待装载区（不被 `fs.watch` 看见），严格校验、算哈希、过闸门、提交、有界激活。agent 不拿到面板存储的可写句柄。
- `sourceDir` 守卫：绝对路径、存在、是目录、不在任何插件根/待装载区/备份内、不是目标本身；只收常规文件；拒绝符号链接/junction/重解析点；拒绝 `node_modules`/`.git`。
- **包格式**：目录根上有 `plugin.json`，`entry` 为相对 `.js`/`.mjs`，资产用相对路径引用；只支持包内相对 import，无 build、无 bare specifier。manifest 字段 `id/name/version/entry/capabilities/mount?/order?`；控制面安装**未知字段即错**，capabilities 只允许投放 4 段、未知/越档即错、重复去重并给 warning；`entry` 沿用既有 `parseManifest` 的路径规则（`app/src/main/plugins/manifest.ts:26-32`）；`mount`/`order` 类型校验；`version`/`name` 非空。
- **id**：沿用 `^[a-z0-9][a-z0-9._-]*$`（`manifest.ts:11`）；**保留 `app`**——`deck-plugin://app` 是面板自己的 host，插件同名会解析到 app 根；跨所有根查冲突（含被遮蔽的用户根副本）。
- **文件上限**：8 MiB 总量 / 256 文件 / 2 MiB 单文件 / 路径深度 8 / `plugin.json` 64 KiB；扩展名限协议白名单 `.js .mjs .css .json .html .svg .png .woff2`。上限是契约的一部分，错误里如实回报。
- `plugins/update { id, sourceDir }`：目标必须是用户根包；源 manifest id 必须等于目标 id；**不允许改名**（改名 = uninstall + install，两次闸门）；内核/第一方包不可 update。`version` 是字符串，不做 semver 排序、不禁止降级；待装载区树与已装树逐字节相同 → `no_change` 成功（`changed:false`，不重载）。
- `plugins/uninstall { id }`：只对用户根包；目录送**回收站**（`shell.trashItem`），回收站失败即整个 uninstall 失败，**不降级成永久删除**；内核/第一方包只能停用。
- `settings/set-card-enabled { id, enabled }`：插件包的持久停用/启用，沿用既有方法名（`app/src/shared/contract.ts:526`）；归插件包客体，不归 config。停用保留目录与 `plugin-config`。
- `plugins/rescan`：刷新扫描，返回最新清单；无参数、无闸门。它不改变包，只让手动投放/watcher 失效后的目录重新入列；触发的重载与 watcher 同源。
- **不再有 `unload`**：`PluginHostService.unload(id)` 是运行期摘除，下一次 rescan/重启就会回来，没有持久管理价值；持久停用走 `set-card-enabled`。
- `plugins/list` 与 `plugins/read` 是管理视图，不是快照 `plugins` 段。`list` 返回 `PluginPackageInfo[]`：`id / name / version / root(builtin|firstParty|user) / tier(kernel|投放) / status(ok|error|shadowed) / enabled / active / capabilities / effectiveCapabilities / error / revision / manageable / shadowedBy?`；含停用包与被遮蔽的用户根副本。`read {id}` 返回 manifest + 文件清单（`path/size/sha256`）；`read {id,file}` 返回内容（文本 utf8 / 二进制 base64，单文件上限）。用户根源码：内核/后端可读；第一方/内置源码：仅内核；外部只能 `list`。**`read` 不返回 `plugin-config`**。

## 待装载区与事务

- **校验不执行包代码**。它只证明 manifest/文件结构合法，不证明 JS 能跑；语法错误、`mount` 抛错、`ready()` rejection 都在激活阶段暴露。安装成功 = 文件提交 + 有界激活；不是「结构合法」。
- **提交**：待装载区里的副本通过闸门后移入用户根；提交前把这份副本的哈希与批准绑定，提交的是同一份字节，不回读 `sourceDir`。用户手动投放不经过待装载区，语义不变（投放即热插拔）。
- **有界激活**：提交后等待插件宿主回报 mount/ready 完成；`ready()` 必须在有限时间内回报成功/失败（当前 fire-and-forget 的缺陷在本 ADR 生效时修正）。失败则回滚：新装移除、更新恢复旧版、待装载区副本丢弃；返回 `activation_failed`，带 phase、mount 错误与 rollback 结果。
- **update 换入**：暂停宿主/watcher 对该 id 的观察 → 旧包移到内部控制面备份 → 新包移入 → 激活 → 成功后旧包送回收站；失败则新包退出、旧包还原、待装载区副本丢弃；还原也失败 → `result_unknown`，保留备份与审计意图，不猜补偿。宿主对这次换入只应观察到一次变化，不得看到半份包。
- **串行化**：所有插件包写全局串行（用户根只有一个），并发写回 `busy`；读不阻塞。
- **停用的 id**：install/update 成功但 `active:false`；不擅自清掉用户的停用记录。
- **旧版去向**：成功 update 后旧版送回收站。**不建用户可点还原的回滚点**——ADR-0010 已说回滚点对插件包单独失效：它能撤掉包，撤不掉包已经干过的事。回收站是文件级恢复，不是对执行的撤销。
- **审计**：每次写尝试带 `opId`；意图/结局/补偿结果按 ADR-0017 落审计；agent 只能读自己那一档。

## 错误形状

传输无关的信封：`{ ok:false, code, message, opId, retryable, warnings?, issues?, hint?, proposalId?, activation? }`。

- `invalid_package`：`issues[]` 为 `{ path, code, message, expected?, actual?, allowed? }`，`path` 是 `manifest.<字段>` 或包内相对路径；顺序确定；任何 issue 都不落盘、不部分提交。
- `id_conflict`（带 existing root+tier）、`id_mismatch`、`not_found`、`not_manageable`（内置/第一方目标或内核源码）、`io_failed`。
- `gate_denied`：用户拒绝，待装载区副本丢弃；`gate_timeout`：带 `proposalId`，待装载区副本保留到提案过期，批准时按哈希提交同一份字节。
- `activation_failed`：`{ phase, message, rollback: 'removed' | 'restored' | 'failed' }`；rollback 失败时同时标 `stateUnknown`。
- `busy`：唯一可重试的 code，带 `retryAfterMs`；写尚未开始，安全。其余一律不自动重试；`result_unknown` 尤其禁止——agent 先读 `plugins/list` 对账。
- 方法不在本档宿主面/控制面投影内 = **不存在**：传输层回 unknown tool，不走这套 code；不要与 `not_manageable`（方法存在、目标不可管理）混淆。
- 成功可带 `warnings[]`（如 capabilities 去重、版本未变但内容变）。

## plugin-config

`plugin-config` 是**插件私有状态**，不是第五类控制面客体，也不是布局列的新载体：

- 插件包（内核与投放）经 `host.config` 读写自己的命名空间；主进程从执行上下文绑定插件 id，**不接受调用方自报 id**（ADR-0017）。跨插件访问不存在。
- agent 侧不投影 `plugin-config/*`；内核 UI/验收电池保留 `plugin-config/get|set` 为**内核档**管理路径。
- 卸载保留 `<id>.json`：它是用户可见状态（如组卡定义），不是包的附属垃圾；清理由内核 UI 的独立「重置」动作承担。
- 不新增 `plugin-config` 的宽严矩阵行；ADR-0010 的「四类客体」不变。

## 闸门与会话级授权

- 后端档的 `install` / `update`：**每次全新确认，不允许会话级授权豁免**。每个包都是任意代码；一次批准若变成整场会话的免确认，等于把「批准这个包」偷换成「批准无限个包」。
- `uninstall`：可请求会话级授权（回收站可逆、批量清理常见）；否则逐次确认。这是往严的方向的方法级例外，ADR-0010 允许。
- `set-enabled`：W，免闸门（可逆、不引入代码）；外部档不投影。
- 内核档：无闸门（第一方包随 app 发布，安装动作本身是用户/发布动作；用户根的管理动作也是用户手势）。
- 闸门呈现归 UI 实施，不在本 ADR 范围；契约只要求闸门能看到包 id/name/version、来源根、声明 capabilities、文件清单，以及 update 的旧/新版本与文件变化。
- 闸门超时 → 提案；提案批准是一次性用户手势，落地那次写记自主管理档并引用提案 id（ADR-0010/0017）。

## 删除与旧版

- 控制面 `uninstall` 送回收站；失败即失败，不降级永久删除。
- 内核/第一方包不可卸载，只能停用；`doc-group-cards` 迁到第一方包根后同样如此。
- 用户手动删除目录的路径不变；`app/scripts/install-plugin.mjs --uninstall` 是开发者工具（Node 环境无 Electron `shell`），不承诺控制面的回收站语义，文档中明确标为开发者专用硬删。
- 旧版 update 成功后送回收站（见上）；`plugin-config` 保留。

## 代码来源

v1 **只接受 agent 现写的包**：安装契约对代码来源不可知，只要目录符合包格式。**不做模板库、不做分发源/registry**；格式写在 `plugins/install` 的工具描述与 `app/samples/hello-plugin` 样例里。模板/分发源若要，另开票，不在本 map 的决策面。

## 宽严矩阵的修订

ADR-0010 的「插件包 后端 W✓ 确 + 待装载、外部 R、投放 —」按方法细化如下（不新增客体；`plugin-config` 不在表内）：

| 方法 | 内核 | 后端 | 外部 | 投放 | 自主管理 |
| --- | --- | --- | --- | --- | --- |
| `plugins/list` | R | R | R | — | —（#75 定） |
| `plugins/read` | R（含内置/第一方源码） | R（仅用户根源码） | — | — | —（#75 定） |
| `plugins/install` | W（用户根；待装载区；闸门免） | W✓（待装载区；每次确认；无会话级） | — | — | 提案 |
| `plugins/update` | W（同上） | W✓（同上） | — | — | 提案 |
| `plugins/uninstall` | W（回收站） | W✓（回收站；可会话级） | — | — | 提案 |
| `settings/set-card-enabled` | W | W（免闸门） | — | — | 提案 |
| `plugins/rescan` | R | R | — | — | —（#75 定） |

- 外部档从 `R` 收窄为**只给 `list`**：源码读取按 #72 的方法级例外只开内核/后端；`rescan` 会触发重载，不给外部。
- `set-enabled` 是 W 而非 W✓：可逆、不引入代码，确认闸门「只给不可逆与大影响面」的判据不适用；这是本 ADR 对 ADR-0010 插件包格的**方法级细化**，用户仍可把整格再关小。
- 投放档的 `host.view` 4 段与 `taskbar/get-state` 属「只读快照与事件」与「内核插件层」两行；`host.config` 是插件私有状态，不占控制面列。插件包永远不能管理插件包（投放档在 `plugins/*` 列全 `—`）。

## Considered Options

- **把 `doc-group-cards` 留在投放档 + 逐包用户授权 `desktop` 段与 10 个方法**——改写 ADR-0010 的「架构定上限、用户只能收紧」；一次授权会被后续 update 的任意代码继承，除非每次 update 重新审代码，而用户读不了 JS。否决。
- **放宽投放档上限，把 `desktop` 段与这些方法纳入投放**——投放档不再是最窄，ADR-0009 拆出投放档的理由（投放即 RCE、无发布把关）被推翻。否决。
- **保留投放档 + 内核桌面动作代理，破坏性动作逐次确认**——插件 UI 不可信，确认只能由可信 UI 呈现；文件管理器每步确认不可用，且等于把「面板外」重新开一条给投放的通道。否决。
- **把内核档插件包的宿主面也当作控制面投影（排除 12 个面板外方法）**——内置 `search`/`sessions` 卡与 `doc-group-cards` 都会失效；内核档插件包是第一方代码，信任来源与内核 UI 相同，不应被 agent 面的排除名单约束。否决。
- **invoke 由 manifest 的 `permissions` 声明（包级最小权限）**——投放窄面已经很小；再加一条轴会带来遗留默认值与迁移成本，而档位绑定才是主进程能强制的身份。否决（若将来要包级最小权限，另开票）。
- **把 invoke 并进 `capabilities`**——改变现有 manifest 语义与内置卡的含义。否决。
- **`plugin-config` 作为第五类独立客体**——会给投放档造出 `W(自身命名空间)`，在矩阵列上比外部档还宽，破坏单调性；而且它是插件状态，不是 agent 管理的独立客体。否决。
- **让 agent 直接把包写进待装载区（`install/begin` 返回路径）**——暴露面板存储、多一次往返、不增加安全性（agent 本来就有文件工具）。否决。
- **inline files / zip**——协议膨胀、zip-slip、仓库无解压依赖。否决。
- **install 成功只认文件落地，激活异步轮询**——假成功；agent 要在 `mount` 抛错后靠轮询才发现，自我修正回路断一半。否决。
- **install/update 也允许会话级授权**——一次批准变成无限包，正是投放档要防的提权。否决。
- **`set-card-enabled` 归 config·观感与检索**——外部档会拿到 `W✓`，与「外部只读插件包」的方法级例外冲突；它效果上就是插件包启停。否决（除非用户明确要外部能关包）。
- **控制面安装沿用 `parseManifest` 的宽松语义**——agent 的 typo 会被静默吞掉，拿不到可修正的错误。否决；手动投放仍宽松。
- **旧版永久删除 / 保留 N 代备份 + 用户可点还原**——前者违背本机删除走回收站的口径；后者把 ADR-0010 已判无效的「回滚点」换个名字复活。否决。
- **`plugins/schema` 方法**——包格式写在 install 工具描述与样例里足够；真要机器可读 schema 另开。否决。
- **模板库 / 分发源**——是后续便利性/交付物，不是本决策的门。否决入本票。

## Consequences

- **`doc-group-cards` 迁到第一方包根，成为内核档插件包**。它的 `desktop` 段与 10 个方法在受信内部桥内；用户可停用、不能运行期卸载。ADR-0014 决策 (a)「交付为投放型插件包」不再适用于本包，由本 ADR 取代（决策 (b)「不动磁盘」与 (c) 的持久化强度仍成立，后者归 `host.config`）。
- **用户根里已有的 `doc-group-cards` 副本会变成被遮蔽的包**：内核/第一方根在前，扫描时该 id 先到先得；`plugins/list` 必须把这份副本以 `shadowed` 列出，供用户卸载。它的 `<id>.json` 与迁移后的第一方包共享同一 id，组卡定义随迁不丢。
- **现有用户根的投放包会失去投放窄面之外的方法**：这是有意的破坏性变更，不做兼容 shim。插件宿主面在方法不存在时应抛出可读错误（含档位名），而不是 `undefined`；坏包进 error 态、面板静默降级，与既有语义一致。
- **ADR-0017 的每包执行上下文是本契约的强制前提**：同文档的 facade/nonce 不构成隔离；主进程必须从通道绑定推导 `tier` 与 `pluginId`，`host.view`/`host.config`/invoke 窄面都在这个绑定上裁剪。只扩 manifest、保留自报 id 不能兑现投放档。
- **插件宿主必须回报 mount/ready 完成**。`ready()` 的 fire-and-forget（`service.ts:267-276`）在本 ADR 生效时修正；否则「有界激活」无法兑现。
- **`plugin-config/get|set` 保留为内核档**；`doc-group-cards` 的代码迁到 `host.config`，验收电池的直接 CDP `plugin-config/get|set` 仍是内核上下文、不受影响。
- **`deck-plugin://` 仍是单一 origin**：`protocol.ts:55-81` 的 host 表把 `app` 与全部插件目录放在同一 scheme 下，`access-control-allow-origin: *`，一个投放包可以 fetch 另一个包的源码/资产。本 ADR 只把 `app` 列为保留 id 并限制 `plugins/read`，**没有关闭这条跨包读**；按包隔离 origin 是 ADR-0017 执行上下文的实施细节或后续票。这个缺口要在实施时显式记账，不能假装 `plugins/read` 的档位裁剪已经覆盖它。
- **`app` 成为保留 id**；控制面安装拒绝，手动投放的同名包会在协议 host 表里与 app 碰撞——这是既有实现的潜在缺陷，本 ADR 只把新写入路径堵住，手动路径的碰撞留给实施/后续票。
- **验收电池与安装脚本要跟着迁移**：`doc-group-cards` 不再用 `install-plugin.mjs` 拷进用户根；电池改为指向第一方包根（或临时根），`install-plugin.mjs --uninstall` 标注为开发者专用硬删。控制面的 `uninstall` 用 `shell.trashItem`。
- **审计与提案**：每次写带 `opId`；gate 超时转提案时保留待装载区副本到提案过期；批准按哈希提交同一份字节，记自主管理档并引用提案 id。回滚/结果未知沿用 ADR-0017，不重放。
- **地图 #66**：本票清掉「插件代码从哪来」的雾；`14 个 taskbar/*` 那条雾在 #73 这一侧已清（它们不在投放窄面），剩下的「收栏档位/闸门」与「14 个方法是否属面板外」另开两张票承接。ADR-0010 的插件包格补记、ADR-0014 与 ADR-0017 的补记随本 PR 落盘。
