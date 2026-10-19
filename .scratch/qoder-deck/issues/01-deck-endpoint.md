# 01: 服务端 /deck 契约

**What to build:** 数据服务新增 `GET /deck` 端点：返回活跃会话数组（含任务进度与最近消息预览）、CPU/网速/GPU 的 1Hz 环形历史缓冲（约 300 点）、时间戳。原 /performance 不受影响。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [x] /deck 返回 sessions 数组：按最近活跃排序，字段 id/project/running/tasks_done/tasks_total/current_task/preview/preview_role/age
- [x] preview 取最近 assistant/user 记录的最后一个非空 text 块（截断 100 字符）；无 text 块时 `tool:<name>`
- [x] history 四个数组随采样增长，上限 300 点
- [x] 损坏会话文件被跳过；无活跃会话时 sessions 为空数组而非报错
- [x] /performance 契约不变（TERMINAL 02 回归正常）

## Comments

- 2026-09-21: 实机验证 sessions=1（当前会话，preview=tool:Bash）、history 1Hz 增长、/performance 200；monkey 测试 4 场景全过（空目录、text 块优先于 tool_use、user 字符串内容、过期排除）。
