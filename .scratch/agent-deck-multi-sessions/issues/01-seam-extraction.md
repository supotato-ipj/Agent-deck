# 01: 接缝抽取：agent_sessions 模块 + tool 字段贯穿

**What to build:** 壁纸用户看到的会话列表与现在完全一致（仅每行多了 `QD` 工具标签前缀），但底层完成 prefactor：五工具会话采集收进一个新模块，公开唯一接缝 `collect_sessions(roots, now)`（roots 为各工具数据根路径字典，可注入；来自已确认的接缝设计），数据服务的 `/deck` 端点改为调用它。会话对象新增 `tool` 字段（本票只有 `"qoder"`），前端 DOM diff key 改为 tool+id。Qoder 行为零变化：四态判定、90 秒 RUNNING 窗、10 分钟活跃池、任务进度全部原样。

**Blocked by:** None (can start immediately)

**Status:** done

- [x] 新模块存在且公开 `collect_sessions(roots, now)`，数据服务经由它组装 `/deck` 的 sessions
- [x] `/deck` 每条会话对象含 `tool:"qoder"`，其余字段与改造前一致
- [x] `/performance` 契约与 TERMINAL 02 行为零变化（回归验证）
- [x] 前端 DOM diff key 使用 tool+id；会话行渲染两字母裸标签（本期仅 QD）
- [x] fixture 单测经接缝覆盖 Qoder 行为：四态判定、90s/600s 窗口边界、tasks_done/tasks_total、坏源静默跳过（沿用 unittest + 临时目录惯例，不碰真实用户目录）
- [x] 壁纸重载后目测：与改造前一致 + QD 标签

## Comments

- 2026-09-25 实施完成。验证证据：16 条接缝单测全绿（全套 157 通过）；worktree 服务端临时跑 5001 端口与线上 5000 对比，`/deck` 唯一差异为新增 tool 字段、`/performance` 键集与 qoder 块形状完全一致；浏览器加载真实 index.html 目测，QD 标签/四态色/进度/计数正确，旧契约（无 tool 字段）行优雅降级为空标签不崩。
- 部署期偏斜防护：前端标签取值 `TOOL_TAG[s.tool] || s.tool || ""`，老服务端在跑时标签留空而非显示 undefined。
- WE 内实机重载目测留待合入 master 后（看门狗从主仓库拉起服务端）随票 07 一并确认。
