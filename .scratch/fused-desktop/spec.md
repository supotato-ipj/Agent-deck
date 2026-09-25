# Spec: fused-desktop — 融合桌面（agent 矩阵 / 用量额度 / 版式融合 / 图标优化 / 本机 Copilot）

Status: ready-for-agent（P1 票据 01–04 可开工；票 07 另需人工注册滴答开发者应用）

研究依据：同目录 `research.md`（2026-09-25 实机探明）。用户已拍板的决议见 Implementation Decisions 首节。

## Problem Statement

桌面上并存多个 agent（codex、zcode、Kimi、DSH、qoder、hermes、kimi work），但壁纸只显示其中五个、看不到任何用量与订阅额度；两版壁纸各有取舍（经典版留图标区但信息少、HUD 版信息密但没给图标留位置）；桌面图标编排有应用区/文档区但缺固定快捷入口与散文档归宿；文件检索之外，滴答清单里的待办日程、以及历次 agent 会话内容都无法在桌面触达。用户要的是一个融合桌面：常用图标、性能、检索、agent 状态、可配置的订阅额度与 token 消耗在一个桌面各归其位，并最终成为 DSH 可调用的本机 Copilot 工具面。

## Decisions（用户 2026-09-25 拍板）

1. DSH 额度来源：**API key 认证的官方端点**（只读拉取 5 小时窗/周额度）
2. 用量主口径：**额度优先**（5h 窗剩余 > 今日 token；token 作次级信息）
3. 版式：**经典版骨架 + 按需展开**（右栏式，图标区完整；HUD 能力收进右栏交互）
4. 散文档：**轻档——老化折叠**（不移动文件，不破只读铁律）
5. codex：**P1 全量接入**（状态 + token 一次接齐）
6. 滴答清单：**官方 Open API**（用户注册开发者应用并授权；B 本地缓存路线仅作备选研究）
7. Copilot 对话入口：**搜索面板加对话 tab**（壁纸不嵌输入框，守住克制美学）

## Solution

数据层把 agent 矩阵从五工具扩到七工具（+codex、+DSH）并新增 `/usage` 聚合端点（本地 token 日聚合 + 各 agent 额度窗）；展示层以经典版右栏为底，会话行点击展开聚焦详情（移植 HUD 版任务清单/预览流），新增可配置的额度徽标与用量汇总块；图标层加快捷入口带与文档老化折叠；滴答清单经官方 API 供 TODAY 块；远期把上述能力包装成 MCP server 供 DSH 调用、搜索面板加对话 tab 成为桌面的 agent 入口。

## User Stories

1. 作为桌面用户，我想在会话列表看到 codex 与 DSH 的会话行（标签 CX/DH，四态判定与其他工具一致），以便七工具一屏尽览。
2. 作为订阅用户，我想在每个 agent 的会话行或徽标位看到 5 小时窗剩余额度（主口径），以便决定"现在还能不能派活"。
3. 作为订阅用户，我想看到周额度的单独展示，以便规划本周的重活安排。
4. 作为重度用户，我想看今日/本周 token 消耗的汇总块（按 agent 分色、zcode 可到模型粒度），以便了解各 agent 的用量结构。
5. 作为桌面用户，我想让用量模块默认隐藏、经配置按 agent 逐个开启，以便界面保持克制。
6. 作为桌面用户，我想点击会话行在右栏内展开聚焦详情（状态灯、任务清单、消息预览流），以便不换壁纸就看到 agent 在干什么。
7. 作为桌面用户，我想桌面顶部有一条位置锁死的快捷入口带，常用应用恒在、不被推荐位挤走。
8. 作为桌面用户，我想让 N 天未动的文档图标自动沉入归档列、近期文档恒在前，以便散文档不再无限堆积。
9. 作为滴答清单用户，我想在右栏看到 TODAY 块（今日待办可勾选完成 + 未来 24h 日程），以便不打开滴答就掌握今天。
10. 作为滴答清单用户，我想顶栏有未完成数徽标，以便一眼看到剩余负担。
11. 作为 DSH 用户，我想在搜索面板切到对话 tab 直接对 DSH 下任务，以便在任何场合调用本机 Copilot。
12. 作为 DSH 用户，我想让 desktop-deck 的状态/用量/检索/分区能力成为 DSH 可调用的 MCP 工具，以便 agent 能"看见"我的桌面。
13. 作为桌面用户，我想检索历史 agent 会话内容（如"上次让 zcode 改的正则"），以便找回散落在会话里的知识。

## Implementation Decisions

- **决议表**：见上文 Decisions 节，票据实现与此冲突时以本节为准。
- **agent 矩阵**：新增 `codex`（`~/.codex/sessions/2026/**` jsonl 尾扫，`total_token_usage` 在文件尾部累计）与 `dsh`（`~/.dsh/sessions/`，结构实现时先探针）；标签 CX/DH；沿用 collect_sessions 接缝与四态判定；任一源缺失静默跳过（ADR-0003 原则）。
- **额度接入**：DSH 走 API key 认证端点（key 从 DSH 本机配置读取，端点路径实现时以抓包/配置探针确认）；只读 GET、本地缓存 60s、失败静默降级为"额度未知"（不显示 0）；codex/qoder 订阅额度若本地不可读则该行不显示额度，不阻塞其他行。
- **用量口径**：徽标主显额度（`5h 窗 剩余%`，<20% 转 CONFIRM 琥珀色）；token 为次级（今日值）；`/usage` 返回 `{per_agent: {today_tokens, models: {model: tokens}}, quota: {agent: {window: "5h", remaining_pct, resets_at} | null}}`，全部只读聚合，不落盘不外传。
- **版式**：以 `deck/` 经典版 index.html 为底改造；右栏结构＝SEARCH 槽位 → SESSIONS →（可关）USAGE 汇总块 →（可关）TODAY 块 → 硬件行钉底；会话行点击展开聚焦详情（复用 wallpaper/ 的渲染逻辑，宽度适配 36rem 栏）；字号沿用 100vw/160 等比；HUD 版 wallpaper/ 保留不删，作为对照与能力试验田。
- **配置载体**：壁纸属性放粗粒度开关（用量块显隐、TODAY 块显隐、透视、字号）；`config.json`（服务端，新）放细粒度（每 agent 徽标开关、额度阈值、老化天数、入口带清单）；默认全部最小化显示。
- **图标**：快捷入口带＝桌面顶部固定一行（不参与应用区推荐、编排绝不触碰，pinned.json 升级两级语义「入口带钉/应用区钉」）；老化折叠＝文档区按 mtime 分「近期/归档」两段，阈值默认 14 天、可配，只动图标坐标。
- **滴答清单**：官方 Open API OAuth2（用户一次性注册授权），token 存本机 `%LOCALAPPDATA%\qoder-deck\ticktick.json`（0600 权限语义）；TODAY 块只读轮询 5 分钟、勾选完成走 POST 写回；失败静默降级隐藏块。
- **MCP server**（P5）：server.py 旁挂 stdio/SSE MCP 端点，工具面＝`get_agent_status` / `get_token_usage` / `get_quota` / `search_files` / `search_agent_history` / `get_hw_stats` / `get_desktop_zones`（首版全部只读）；暴露面经 config 白名单。
- **对话 tab**（P6）：search_panel 状态机加 CHAT 态（复用待机/激活骨架），后端经 ACP/harness API 提交 DSH；DSH 会话自动进入第七工具会话列表。
- **隐私**：额度 key 与 OAuth token 仅本机；token 统计不含会话内容；MCP 工具白名单默认最小。

## Testing Decisions

- scanner 测试沿用现有 fixture 风格（tests/test_scanner_*.py 同构）：构造 codex jsonl / dsh sessions 临时目录，断言状态四态、token 聚合、坏文件跳过、超窗排除。
- `/usage` 用 curl/urllib 断言契约字段与日聚合正确性；额度客户端用本地 HTTP mock 断言 60s 缓存、超时降级、坏 payload 静默。
- 布局与徽标走浏览器目测（deck/index.html 直开 + /deck 注入）+ WE 实机截图（DPI 感知脚本）存证票据评论。
- 老化折叠：fixture 桌面 + 固定 now，断言近期/归档分段与编排坐标；入口带断言手钉顺序与"编排不触碰"。
- MCP 工具面：stdio 冒烟（工具列表与一次只读调用）；TODAY 块：mock OAuth + mock tasks 端点。
- 好的测试只断言外部行为（JSON 字段、DOM 状态、截图观感），不断言内部实现。

## Out of Scope

- 散文档"中/重"档（收件箱、自动落盘）——本期只做老化折叠。
- qoder / kimi work 的用量采集（前者本地无用量字段，后者上游私有）。
- 语音入口、多显示器差异化、移动端。
- 账单展示（订阅制无逐 token 账单）。
- HUD 版 wallpaper/ 的新功能平移（保持冻结作对照）。

## Further Notes

- 分期与票据对应：P1=票 01–04，P2=票 05–06，P3=票 07，P4=票 08–09，P5=票 10，P6=票 11，P7=票 12。
- 实施涉及新领域词汇（额度窗/用量徽标/快捷入口带/老化折叠/TODAY 块）已入 CONTEXT.md。
- MCP 方向若实施，建议先补一篇 ADR（docs/adr/）记录"desktop-deck 作为 DSH 工具面"的边界与安全考量。
- DSH 额度端点无官方稳定性承诺：取不到就隐藏，永不报错（既有降级原则）。
