# 07: 滴答清单 Open API——TODAY 块 + 写回 + 顶栏徽标

**What to build:** 滴答清单官方 Open API 接入（OAuth2，用户一次性注册开发者应用并授权）：token 存 `%LOCALAPPDATA%\qoder-deck\ticktick.json`；右栏新增 TODAY 块（今日待办可勾选完成写回 + 未来 24h 日程），顶栏未完成数徽标；轮询 5 分钟、写回即时刷新；失败/未授权静默隐藏块（顶栏徽标同步消失）。服务端 ticktick.py 客户端 + /today 端点（或并入 /usage 相邻新端点）。

**Blocked by:** 人工步骤——用户在滴答开放平台注册开发者应用并完成一次授权（拿 client_id/secret 或授权码）

**Status:** needs-info

- [ ] 用户完成开发者应用注册，redirect/callback 方案与仓主确认后落票面 Comments
- [ ] OAuth 流程：本地回调拿 token、刷新、失效重登，token 文件不进 git
- [ ] TODAY 块渲染：今日待办（勾选→API 写回→UI 即时反馈）+ 24h 日程
- [ ] 顶栏未完成数徽标
- [ ] 失败矩阵：未授权/超时/限流均静默隐藏；5 分钟轮询对 API 配额友好
