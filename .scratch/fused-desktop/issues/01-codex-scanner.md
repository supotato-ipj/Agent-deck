# 01: codex scanner——状态 + token 一次接齐（第七工具）

**What to build:** agent_sessions 新增 codex 扫描器：扫 `~/.codex/sessions/2026/**/rollout-*.jsonl`（日期目录层级），会话行进 collect_sessions 混排（标签 CX、四态判定沿用 _session_state：mtime 在 RUNNING_WINDOW 内为 RUN、尾部 assistant/user 记录定 CONFIRM/DONE/IDLE）；同一扫描器产出该会话的 token 数据（文件尾部 `total_token_usage`：input/cached_input/output/reasoning/total），供票 04 的 /usage 聚合。会话 id 取 rollout 文件名中的 uuid 段，project 取 jsonl 内 cwd 尾段（与 qoder 同构）。文件缺失/损坏/超 ACTIVE_WINDOW 静默跳过。

**Blocked by:** None（可立即开工）

**Status:** ready-for-agent

- [ ] 会话行进混排：fixture jsonl 断言 CX 标签、四态边界（90s/600s）、uuid 会话 id、project 尾段
- [ ] token 提取：fixture 断言 total_token_usage 五字段读出；无该块的旧会话返回 None 不报错
- [ ] 坏文件（截断行/非 json/空文件）跳过，其余会话照常
- [ ] 日期目录层级（2026/09/25）正确遍历，性能可接受（尾扫 ≤128KB/文件）
- [ ] SESSION_ROOTS 增加 codex 根；SESSIONS 计数含 codex
- [ ] 全部测试通过；README 五工具表格更新为七工具
