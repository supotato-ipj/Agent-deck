# 研究文档：融合桌面与本机 Copilot（下一代方向）

Status: research / 供决策
Date: 2026-09-25
Branch: feat/fullscreen-hud

## 0. 一句话愿景

把 desktop-deck 从「AI 会话状态屏」升级为**本机 Copilot 的桌面入口**：图标、待办日程、文件检索、agent 状态、用量额度在一个桌面上各归其位，且这套数据与能力最终成为 DSH agent 可直接调用的本机工具面。

## 1. 现有资产盘点（2026-09-25 实机确认）

| 能力 | 现状 | 所在 |
|---|---|---|
| 五工具会话状态 | qoder / hermes / zcode / kimi code / kimi work 混排，四态判定 | agent_sessions.py |
| 硬件性能 | CPU/MEM/GPU/VRAM/网速 + 1Hz×300 点历史曲线 | server.py |
| 文件检索 | Listary 面板（待机伪装右栏、点击激活、ESC 退回、引擎离线降级） | search_panel.py |
| 桌面图标编排 | 应用区 6×2（手钉+频次推荐）、文档区分列、增量漂移纠正、快照还原 | zones_*.py |
| 使用日志 | ts+exe，90 天滚动（隐私原则：不含窗口标题） | usage_log.py |
| 两版壁纸 | 经典版 deck/（右栏式，图标区完整）+ 全屏 HUD wallpaper/（信息密度） | 并存对比中 |
| 多实例 | QD_PORT 环境变量可并行第二服务 | server.py |

## 2. Agent 矩阵扩展（5 → 7）

### 2.1 数据源可行性（2026-09-25 逐个实机探明）

| Agent | 状态采集 | Token/用量数据（本地实测） | 接入成本 |
|---|---|---|---|
| zcode | ✅ 已接 | **金矿**：`~/.zcode/cli/db/db.sqlite` 的 `model_usage` 表含每次调用的 input/output/reasoning/cache token、provider_id、model_id、duration；`turn_usage` 按轮聚合；`session_target` 有 token_budget/tokens_used | 低（纯 SQL 聚合） |
| codex | 未接 | `~/.codex/sessions/2026/…/*.jsonl` 每会话含 `total_token_usage`（input/cached_input/output/reasoning/total）+ 分轮记录 | 中（新 scanner，jsonl 尾扫模式与 qoder 同构） |
| kimi code | ✅ 已接 | wire.jsonl 有 `token_counting.turn_recorded` 事件（tokens 字段） | 低（扩展现有 scanner） |
| hermes | ✅ 已接 | `messages.token_count` 每条消息都有 | 低（SQL SUM） |
| DSH | 未接 | `~/.dsh/sessions/` 本地会话存储（结构待详查）；**订阅额度（5 小时窗/周）按 deepseek-harness 研究结论可读取** | 中（状态 scanner + 额度参数） |
| qoder | ✅ 已接 | jsonl 未见用量字段（本轮 grep 为空，待深挖） | 状态已有；用量存疑 |
| kimi work | 降级 | 上游私有存储（既有结论） | 维持状态行 |

### 2.2 用量的三个口径（必须分清，展示才不混乱）

1. **本地 token 统计**：精确、免费、可到模型/天/会话粒度（zcode 最强，codex 次之）
2. **订阅窗口额度**：5 小时窗/周额度——影响"还能不能继续用"的决策，来自应用内参数/API（用户已在 deepseek-harness 研究中确认 DSH 可读；codex 订阅额度是否本地可读待验证）
3. **账单**：订阅制多半无逐 token 账单；API key 制才有

### 2.3 展示设计（可配置是硬需求）

- **每行徽标**：会话行尾可开关显示"今日 token"或"5h 窗剩余"（每 agent 独立配置）
- **用量汇总块**：今日/本周柱状（按 agent 分色）+ 各模型分布（zcode 数据可到 model 级）
- **额度告警**：订阅窗剩余 <20% 时徽标变琥珀色（复用 CONFIRM 色语言）
- 配置载体：WE 壁纸属性（简单开关）+ 服务端配置文件（细粒度），默认全部关闭——经典版的克制美学是底线

## 3. 融合桌面版式（建议路线）

**以经典版骨架为底**（右栏式、保住图标区——"桌面"的本分），吸收 HUD 版的按需展开：

- 右栏结构自上而下：搜索面板槽位（已有）→ 会话列表（已有）→ **用量汇总块**（新增，可关）→ 硬件行（已有）
- 会话行点击 → 展开聚焦详情（HUD 版已实现的任务清单/预览流，移植进右栏宽度）
- 模块显隐全部走配置；未开启的模块不留白
- 等比字号体系统一（两版已各自实现 100vw/160 与 100vw×scale 两套，收敛为一套）

**待办日程的落位**：右栏新增「TODAY」块（今日待办 + 未来 24h 日程），未完成数在顶栏 SESSIONS 旁加徽标。克制原则：只显示今天需要的，完整管理去滴答清单本体。

## 4. 图标编排优化

### 4.1 固定快捷入口（两案可并行）

- **A｜快捷入口带**：桌面顶部固定一行，位置锁死、不参与推荐竞争、编排绝不触碰；手钉（pinned.json）语义升级为两级：「入口带钉」与「应用区钉」
- **B｜壁纸 dock**：壁纸底部/右栏常驻高频应用图标（数据来自使用日志 top-N），点击经 explorer 启动；纯视觉层，零编排改动

### 4.2 零散文档归宿（三档，需拍板授权级别）

| 档 | 机制 | 破坏性 |
|---|---|---|
| 轻 | 老化折叠：N 天未动文档沉入归档列，近期文档恒在前 | 零（只动图标坐标） |
| 中 | 收件箱：指定 Inbox 目录，散文档先进；服务按类型**建议**归位（壁纸显示建议清单，人确认） | 零 |
| 重 | 自动归类落盘：服务移动文件到分类目录 | **打破"从不移动文件"铁律**，需白名单+快照可回滚 |

建议路线：轻 → 中（一期），重（观察后再说）。

## 5. 检索增强

- 现状：Listary 搜文件（外部引擎）
- **富矿**：hermes 库自带 `messages_fts` 全文索引；zcode db 结构化程度高——**搜历史 agent 会话内容**是独有价值（"上次让 zcode 改的那个正则是啥"）
- 形态：搜索面板加一个 tab（文件 / 会话），会话结果行点击 → 打开对应工具或回放
- 顺带：qoder jsonl 与 codex jsonl 可建轻量索引（内存 LRU，不落盘）

## 6. 滴答清单（TickTick/滴答清单）接入

### 6.1 本机形态（实测）

- 商店版安装：`%LOCALAPPDATA%\Packages\Tick_Tick\`，进程 TickTick.exe 在跑
- 云优先架构：本地是缓存，**任务真值在云端**

### 6.2 接入路线对比

| 路线 | 说明 | 评估 |
|---|---|---|
| **A｜官方 Open API**（滴答清单 open API，OAuth2） | projects/tasks 端点，读今日任务/日程；成熟、稳定、可写 | **推荐**：需要用户创建开发者应用并授权一次 |
| B｜本地缓存抓取 | 商店包 LocalCache 内（格式待详查，可能 LevelDB/SQLite） | 脆弱、随版本变、可能加密；仅当 API 不可用时备选 |

### 6.3 桌面呈现（克制原则）

- 「TODAY」块：今日待办（可勾选完成 → API 写回）+ 未来 24h 日程
- 顶栏徽标：未完成数
- **与 agent 联动（Copilot 预演）**：agent 会话结束后可经 API 往滴答清单写"待确认事项"——人的一天规划与 agent 的工作输出在同一个清单里汇合

## 7. 本机 Copilot 远景（与 DSH 融合）

### 7.1 DSH 是什么（实测确认）

DeepSeek 开源 agent harness（`dsh` CLI / `npx @deepseek-ai/dsh web` 起 3080 端口 Web UI），**一切皆插件**（Cordis 架构），官方扩展面齐备：`mcp-client`（外部 MCP server 的工具注册为 `mcp__server__tool`）、`mcp-resources`、`skill` 体系、`acp`（Agent Client Protocol）。桌面端与开源 harness 同源（`~/.dsh` 目录共享）。

### 7.2 融合架构（两层，可分期）

**第一层｜desktop-deck 作为 MCP server（供 dsh 调用）**：
把桌面数据与能力注册成 MCP 工具，DSH 里的任何 agent 就能"看见并操作"这台桌面：
- `get_agent_status` / `get_token_usage`（会话+用量）
- `search_desktop` / `search_agent_history`（文件+会话 FTS）
- `get_desktop_zones` / `arrange_icons`（分区状态，只读先行）
- `get_hw_stats`、`get_today_schedule`（滴答清单接入后）
实现成本低：server.py 加一个 MCP stdio/SSE 端点包装现有函数。

**第二层｜dsh 作为桌面的大脑（桌面调用 agent）**：
- 壁纸/搜索面板的输入框升级为对话入口（经 ACP 或 harness API 提交任务给 DSH）
- 任务进度天然回流到会话列表（DSH 会话成为第七个被监控的工具）
- 终极形态：桌面成为 DSH 的「皮肤」——每个信息块背后都可以有一个 agent 在工作，人只看桌面

### 7.3 调用场合（"各个场合都能方便调用"）

1. 壁纸常驻入口（右栏输入框，全局可见）
2. 搜索面板（已有点击激活机制，同一入口加对话 tab）
3. 全局快捷键唤起 Tk 面板（复用 search_panel 的窗口层）
4. 语音（远期；dsh 侧能力）

## 8. 风险与原则

- **只读铁律**：额度/token/清单全部只读；唯一例外（散文档"重"档移动文件）需显式授权+白名单+快照回滚
- 上游无承诺：DSH 额度参数、TickTick Open API（beta）、qoder jsonl 格式都可能变——取不到就隐藏，永不报错（既有降级原则）
- 隐私：token 消耗与任务内容仅本地展示；不写日志不外传；MCP 工具暴露面做成可配置白名单
- 克制美学：每个新模块默认关闭，开了也要做减法（一行起，点击展开）

## 9. 分期路线图（建议）

| 期 | 内容 | 依赖 |
|---|---|---|
| P1 数据层 | codex + DSH scanner；`/usage` 聚合端点（zcode/kimi/hermes/codex 日聚合，含模型分布） | 无 |
| P2 展示层 | 可配置用量徽标 + 汇总块；右栏聚焦详情移植 | P1 |
| P3 滴答清单 | Open API OAuth + TODAY 块 + 写回 | 用户建开发者应用 |
| P4 图标期 | 快捷入口带 + 文档老化折叠 | 无 |
| P5 Copilot L1 | desktop-deck MCP server（状态/用量/检索/分区） | 无（纯增量） |
| P6 Copilot L2 | 桌面对话入口（ACP/harness 接 DSH） | P5 + DSH 端配合 |
| P7 检索期 | agent 会话 FTS 搜索 tab | P5（工具暴露才需要） |

## 10. 开放问题（待用户拍板）

1. DSH 订阅额度的"相关参数"具体指什么（端点/本地文件/头部字段）？给出方向即可评估接入成本
2. 用量主口径：常显额度（5h 窗）还是今日 token？（建议额度优先）
3. 融合版式确认：经典骨架 + 按需展开？
4. 散文档三档选哪档？（是否授权移动文件）
5. codex 是否进 P1？（状态+token 可行性都高，前提是你日常在用）
6. 滴答清单用官方 Open API 需要你注册开发者应用并授权一次——接受吗？
7. Copilot 的对话入口放哪：壁纸内嵌 vs 独立 Tk 面板 vs 两处都要？

## 11. 本文档的证据清单

- zcode db schema：实机 `PRAGMA table_info`（model_usage/turn_usage/session_target 全列）
- codex jsonl：`~/.codex/sessions/2026/09/06/rollout-*.jsonl` 实样含 `total_token_usage`
- kimi-code wire.jsonl：实样含 `token_counting.turn_recorded`/`tokens`
- hermes db：messages 表 token_count 列
- DSH：`~/.dsh/sessions|profiles|settings.yaml`；`@deepseek-ai/dsh-mcp-client` README（MCP 工具命名规则）
- harness 仓库：`D:\GIThub\deepseek-harness`（README.zh「一切皆插件」、packages/acp|mcp|skill）
- TickTick：`%LOCALAPPDATA%\Packages\Tick_Tick` + TickTick.exe 进程在跑
- 上轮研究：/deck 契约扩展、HUD 字号等比、DPI 捕获（见 .scratch/ 各 feature spec 与 git log）
