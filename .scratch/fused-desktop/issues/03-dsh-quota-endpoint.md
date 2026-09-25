# 03: DSH 订阅额度端点——5 小时窗/周额度只读拉取

**What to build:** 新增额度客户端（建议 quota.py）：用 DSH 本机配置中的 API key 认证调用官方额度端点，拉取 5 小时窗与周额度的 remaining/reset 信息。用户已确认"添加订阅和 key 后额度可读"（deepseek-harness 研究），具体端点路径/参数实现时以探针确认（抓 DSH 应用配置 `~/.dsh/settings.yaml` / auth 相关文件中的 base_url 与 key 字段，必要时对照 harness 源码里的 client 实现）。行为：GET 只读、进程内缓存 60s、超时/坏 payload/无 key 一律静默降级为 None（前端显示"额度未知"，绝不显示 0 或报错）；key 不落日志。

**Blocked by:** None（可立即开工；端点路径探针是本票第一验收项）

**Status:** ready-for-agent

- [ ] 探针：确认端点 URL、认证头形式、响应字段（5h 窗剩余/重置时间、周额度）记录在本票 Comments（脱敏）
- [ ] quota 客户端：`get_quota(agent) -> {window, remaining_pct, resets_at} | None`，本地 HTTP mock 断言解析
- [ ] 60s 缓存 + 并发去重（同窗只打一次端点）
- [ ] 失败矩阵：无 key / 超时 / 401 / 坏 JSON 全部静默 None，服务日志一行
- [ ] key 生命周期：从 DSH 配置读取引用，不复制不落盘到本仓库运行时目录
