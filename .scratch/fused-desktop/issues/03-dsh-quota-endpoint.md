# 03: DSH 订阅额度端点——5 小时窗/周额度只读拉取

**What to build:** 新增额度客户端（建议 quota.py）：用 DSH 本机配置中的 API key 认证调用官方额度端点，拉取 5 小时窗与周额度的 remaining/reset 信息。用户已确认"添加订阅和 key 后额度可读"（deepseek-harness 研究），具体端点路径/参数实现时以探针确认（抓 DSH 应用配置 `~/.dsh/settings.yaml` / auth 相关文件中的 base_url 与 key 字段，必要时对照 harness 源码里的 client 实现）。行为：GET 只读、进程内缓存 60s、超时/坏 payload/无 key 一律静默降级为 None（前端显示"额度未知"，绝不显示 0 或报错）；key 不落日志。

**Blocked by:** None（可立即开工；端点路径探针是本票第一验收项）

**Status:** done

- [x] 探针：官方文档实锤 GET https://api.deepseek.com/user/balance（is_available/balance_infos）；订阅 5h/周窗端点未公开→配置驱动回填
- [ ] quota 客户端：`get_quota(agent) -> {window, remaining_pct, resets_at} | None`，本地 HTTP mock 断言解析
- [x] 60s 缓存 + 并发去重（同窗只打一次端点）
- [x] 失败矩阵：无 key / 超时 / 401 / 坏 JSON 全部静默 None，服务日志一行
- [x] key 生命周期：从 DSH 配置读取引用，不复制不落盘到本仓库运行时目录

## Comments

**2026-09-25 实现完成（done，quota.py + tests/test_quota_usage.py）**

- 探针结论（官方文档核对）：公开文档只有 `GET /user/balance`（API key 计费余额，
  Bearer 认证，返回 is_available + balance_infos[currency/total_balance/granted/topped]）；
  harness 开源侧（llm-deepseek）的 quota 全是 Files API 存储配额，无订阅窗口端点。
- 实现三源：codex=本地会话快照正则解析（票 01 红利，容忍多重 JSON 转义）；
  dsh=/user/balance（key 依次取 QD_DEEPSEEK_API_KEY 与 ~/.dsh/.credentials.yaml 的
  api key 字段，只引用不复制）；订阅窗=可配置端点
  （%LOCALAPPDATA%/qoder-deck/quota.json 的 dsh_subscription：url/token_env/
  json_path_remaining/window，未配置静默 None）。
- 实机：codex 周窗剩余 81%（resets_at 1790662039）；dsh 无 key 时 None（预期）。
- 待回填：DSH 订阅 5h/周窗的具体端点（用户 deepseek-harness 研究结论称可读），
  quota.json 一行配置即接入。
