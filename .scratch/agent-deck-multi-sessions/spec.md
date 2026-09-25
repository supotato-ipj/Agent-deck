# Spec: AGENT DECK — 多工具会话展示

Status: ready-for-agent

## Problem Statement

用户日常同时驱动多个 AI 编码工具（Qoder、kimi work、kimi code、zcode、hermes），但壁纸右栏的会话列表只展示 Qoder 会话。其他工具的任务在跑时，桌面上看不到任何迹象，用户需要逐个切窗口才能掌握全局，违背了"作战面板"一屏总览的初衷。

## Solution

把 QODER DECK 升级为 AGENT DECK：数据服务在既有 `/deck` 契约上为会话对象新增工具来源字段，并以五个并列的只读扫描器（每工具一个）把各家本地存储归一化为统一会话记录；壁纸前端把会话列表变为五工具混排（按最近活跃排序），每行以两字母工具标签区分来源。品牌文案同步改为 AGENT DECK。TERMINAL 02 及其 Qoder 状态块完全不动。

## User Stories

1. 作为桌面用户，我想在壁纸会话列表里看到所有五个工具的活跃会话混排在一起，以便一屏掌握全部 AI 工作进展。
2. 作为桌面用户，我想每行会话带两字母工具标签（QD/KC/KW/ZC/HM），以便一眼区分会话来自哪个工具。
3. 作为桌面用户，我想列表按最近活跃排序，以便最新动静永远在最上面。
4. 作为桌面用户，我想非 Qoder 工具沿用同一套四态（RUN/CONFIRM/DONE/IDLE）视觉语言，以便不用为每个工具学一套新状态词汇。
5. 作为桌面用户，我想 hermes 会话的 RUN 判定用其活跃租约文件交叉验证，以便长任务不因写入间隙被误判为停转。
6. 作为桌面用户，我想 zcode 会话像 Qoder 一样显示任务进度（done/total），以便看到其 todo 清单推进。
7. 作为桌面用户，我想 kimi work 会话即使拿不到标题也以"工具名 + 状态"降级显示，以便它的活动不被完全隐藏。
8. 作为桌面用户，我想所有工具统一沿用 10 分钟活跃池（超时出列、archived 排除），以便列表始终反映"现在"。
9. 作为桌面用户，我想某工具数据源缺失、被锁或损坏时列表静默跳过它，以便壁纸永远不因单工具故障花屏或报错。
10. 作为桌面用户，我想壁纸标题与画面文案显示 AGENT DECK，以便品牌与实际能力一致。
11. 作为桌面用户，我想顶栏 SESSIONS 计数统计所有工具的活跃会话总数，以便感知整体并行度。
12. 作为桌面用户，我想在全部工具都无活跃会话时仍看到既有待机态（NO ACTIVE SESSIONS），以便区分"没会话"与"服务挂了"。
13. 作为桌面用户，我想 TERMINAL 02 壁纸与 /performance 契约保持原样，以便既有展示零回归。
14. 作为壁纸维护者，我想五工具采集逻辑收在一个模块的单一公开函数后面（数据根可注入），以便用 fixture 做密封单测、不碰真实用户目录。
15. 作为壁纸维护者，我想每个扫描器对源存储严格只读（SQLite 用只读 URI 打开），以便绝不干扰各工具自身运行。
16. 作为壁纸维护者，我想会话唯一键为"工具 + 会话 id"，以便不同工具的 id 撞车时互不覆盖。
17. 作为壁纸维护者，我想 GitHub 库名与 Steam 项目文件夹名本期不动，以便避开 WE 项目关联断裂风险，改名收尾下期单独做。

## Implementation Decisions

- **契约**：`/deck` 响应的 sessions 数组元素在既有字段（id、project、running、age、tasks_done、tasks_total、state）上新增 `tool` 字段（取值 qoder/kimicode/kimiwork/zcode/hermes）；前端 DOM diff key 改为 tool+id。`/performance` 契约不变。
- **新模块**：五工具会话采集抽为独立模块，公开单一函数 `collect_sessions(roots, now)`；数据服务以真实路径调用并保留既有 1 秒缓存节奏。
- **各工具数据源与判定**（全部只读）：
  - qoder：现有扫描逻辑原样迁入，行为不变（mtime 四态判定、tasks 目录进度）。
  - kimi code：会话目录树下的 state.json 提供 title/workDir，wire.jsonl 的 mtime 判活跃度；四态用启发式（≤90s→RUN，否则按最后记录粗分 DONE/IDLE，无 CONFIRM 信号）。仅读迁移后的新目录，不读旧 .kimi。
  - kimi work：状态 map 文件给出每会话显式状态（现只观察到 completed→DONE，未知值容错为 IDLE）；age 借同目录上下文用量文件的 updatedAt；无标题，行内降级显示工具名。
  - zcode：SQLite 只读 URI 打开（容 WAL），session 表提供 title/directory/time_updated，time_archived 非空排除；todo 表按 session_id join 出 tasks_done（completed 数）/tasks_total。
  - hermes：SQLite 只读打开，sessions 表提供 title/cwd/last_activity_at/ended_at，archived=1 排除；RUN 判定 = 活跃租约文件（active_sessions.json）中存在该会话 或 end_reason 为 NULL 且 ≤90s。
- **统一规则**：活跃池 = 最后更新 ≤600s；RUNNING 窗 = ≤90s；archived 一律排除；任一工具扫描抛错 → 记服务端日志并跳过该工具，其余照常。
- **前端**：会话行渲染加两字母裸标签前缀（无方括号）；任务进度仅 QD/ZC 有值，其余留空；品牌文案（页面标题、panel 头等可见处）改为 AGENT DECK；WE 项目元数据 title 改为 AGENT DECK；列表无容量上限（维持 overflow 裁剪现状）。
- **词汇表与 ADR**：CONTEXT.md 标题/首段改 AGENT DECK，"数据服务""会话活跃"定义泛化，新增"会话列表""工具标签"词条，"Qoder 状态块"保留原义；ADR 0003 记录统一四态模型与 kimi work 降级取舍。

## Testing Decisions

- **接缝**：唯一自动化接缝是 `collect_sessions(roots, now)`。好测试只断言外部行为——给定 fixture 数据根与固定 now，断言返回的会话列表内容（tool、state、age、任务进度、排序、排除与降级行为），不断言内部扫描实现。
- **fixture 风格**：沿用现有 unittest + tests/records.py 惯例；文件系统类工具（qoder/kimi code/kimi work）用临时目录造假数据根，SQLite 类工具（zcode/hermes）用内存或临时库建最小表结构。
- **必测行为**：五工具各自的基本映射；90s/600s 窗口边界；archived 排除；坏源（缺文件、锁库、坏 JSON）静默跳过且不影响其他工具；tool+id 撞车不互覆；zcode todo 计数；hermes 租约判 RUN。
- **前端**：不做自动化测试；改完重载壁纸目测验收（混排、标签、状态色、计数、待机态），与仓库既有前端验证做法一致。

## Out of Scope

- TERMINAL 02 壁纸与 /performance 端点的任何改动。
- GitHub 库名、Steam 项目文件夹名的改名（下期收尾）。
- kimi work 标题解析（LevelDB/IndexedDB 破解）。
- 会话列表容量上限、分页、按工具过滤/分组。
- 各工具 token 用量、消息预览等新字段展示。
- 桌面分区、使用频次推荐等既有 feature。

## Further Notes

- 2026-09-25 验收时补充决策（票 07）：zcode 的子代理会话（id 前缀 `sess_subagent_`）不入列——真实数据中 subagent 行占比过高构成列表噪音；实现为扫描器内前缀过滤（常量 ZCODE_SUBAGENT_PREFIX）。

- 事实依据（2026-09-24/25 实测）：kimi work 状态 map 现存 7 条全为 completed；hermes end_reason 观察值 {NULL, cli_close, startup_orphan_reap, ws_orphan_reap}；zcode todo status ∈ {pending, in_progress, completed}；四工具数据源均在本机验证存在且可读。
- 决策过程见本次 grilling 共识（Q1-Q12 全锁定）：1A 只改 DECK、2A kimi work 降级、3A 统一四态、4A 混排+标签、5A 任务进度 QD+ZC、6B/7A 改名 AGENT DECK、8A 仅文案层改名、9A 统一 10 分钟窗、10B 裸两字母标签、11A 静默跳过、12A 无上限。
- 若实际使用中某工具因写入节奏稀疏频繁"闪现即消失"，再单独放宽其窗口（Q9 预留的演进路径）。
