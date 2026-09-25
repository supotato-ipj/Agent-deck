# 04: /usage 聚合端点——本地 token 日聚合 + 额度出口

**What to build:** server.py 新增 `GET /usage`：聚合各工具本地 token 数据（zcode model_usage / turn_usage、codex total_token_usage、kimi code token_counting 事件、hermes messages.token_count；qoder/kimi work 无数据返 null）为 `{per_agent: {today_tokens, week_tokens?, models: {model_id: tokens}}, quota: {agent: {window, remaining_pct, resets_at} | null}}`；聚合结果进程内缓存 60s；zcode SQL 聚合注意只读 URI 与时间戳单位（ms）。DSH 额度经票 03 客户端并入口径主位。CORS/no-store 与既有端点一致。

**Blocked by:** 01（codex token 并入；zcode/kimi/hermes 已就绪可先行开发，codex 到货即并入）

**Status:** done

- [x] 契约：fixture 数据根断言 per_agent 今日聚合正确、models 分布正确（zcode 到 model 级）
- [x] 无数据工具返回 null 而非缺席键；总额恒等于各源之和
- [x] quota 字段接票 03 客户端（未就绪时为 null）；60s 缓存生效
- [x] 性能：zcode model_usage 大表聚合 < 200ms（限定时间窗 SQL）
- [x] 全部测试通过；README 端点清单更新

## Comments

**2026-09-25 实现完成（done，usage.py + server.py /usage 路由 + 16 项测试）**

- 四源聚合：zcode（model_usage 按日窗 SQL + model 分桶）、codex（今日活动文件累计）、
  kimicode（wire turn_recorded tokens 求和）、hermes（messages.token_count 日窗求和）。
- 实机输出：zcode 今日 1.04 亿 token（GLM-5.3/Flash/deepseek-flash/kimi-k3 四模型分桶）、
  codex 3275 万；qoder/kimiwork/dsh 无数据为 null。
- /usage 挂 server.py，60s 缓存（USAGE_CACHE_TTL），CORS/no-store 与既有端点一致。
- 口径注记：codex 为"今日文件会话累计"近似（新会话文件即今日消耗）；zcode/hermes
  为精确日窗聚合。dsh 并入待票 02 探明会话存储后补。
