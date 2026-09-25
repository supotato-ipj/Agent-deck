# 04: /usage 聚合端点——本地 token 日聚合 + 额度出口

**What to build:** server.py 新增 `GET /usage`：聚合各工具本地 token 数据（zcode model_usage / turn_usage、codex total_token_usage、kimi code token_counting 事件、hermes messages.token_count；qoder/kimi work 无数据返 null）为 `{per_agent: {today_tokens, week_tokens?, models: {model_id: tokens}}, quota: {agent: {window, remaining_pct, resets_at} | null}}`；聚合结果进程内缓存 60s；zcode SQL 聚合注意只读 URI 与时间戳单位（ms）。DSH 额度经票 03 客户端并入口径主位。CORS/no-store 与既有端点一致。

**Blocked by:** 01（codex token 并入；zcode/kimi/hermes 已就绪可先行开发，codex 到货即并入）

**Status:** ready-for-agent

- [ ] 契约：fixture 数据根断言 per_agent 今日聚合正确、models 分布正确（zcode 到 model 级）
- [ ] 无数据工具返回 null 而非缺席键；总额恒等于各源之和
- [ ] quota 字段接票 03 客户端（未就绪时为 null）；60s 缓存生效
- [ ] 性能：zcode model_usage 大表聚合 < 200ms（限定时间窗 SQL）
- [ ] 全部测试通过；README 端点清单更新
