# 01: codex scanner——状态 + token 一次接齐（第七工具）

**What to build:** agent_sessions 新增 codex 扫描器：扫 `~/.codex/sessions/2026/**/rollout-*.jsonl`（日期目录层级），会话行进 collect_sessions 混排（标签 CX，前端映射；四态判定沿用 _session_state：mtime 在 RUNNING_WINDOW 内为 RUN、尾部 assistant/user 记录定 CONFIRM/DONE/IDLE）；同一扫描器产出该会话的 token 数据（尾部 `token_count.info.total_token_usage`：input/cached_input/output/reasoning/total 会话累计），供票 04 的 /usage 聚合。会话 id 取 session_meta 的 session_id（回退文件名 uuid 段），project 取 session_meta 的 cwd 尾段。文件缺失/损坏/超 ACTIVE_WINDOW 静默跳过。

**Blocked by:** None（可立即开工）

**Status:** done

- [x] 会话行进混排：fixture jsonl 断言 tool=codex、四态边界（90s/600s）、uuid 会话 id、project 尾段
- [x] token 提取：fixture 断言 total_token_usage 五字段读出；无该块的旧会话返回 None 不报错
- [x] 坏文件（截断行/非 json/空文件）跳过，其余会话照常（产生回退 id 行，与 qoder 垃圾文件行为一致）
- [x] 日期目录层级（2026/09/25）正确遍历，性能可接受（头读 8KB + 尾扫 128KB/文件）
- [x] SESSION_ROOTS 增加 codex 根；SESSIONS 计数含 codex
- [x] 全部测试通过（11 新增 + 全套 274 绿）；README 表格已加 codex 行（六工具；dsh 到货后更七）

## Comments

**2026-09-25 实现完成（done）**

- 结构探明：首行 session_meta（session_id/cwd/thread_source，但整行可能被 base_instructions
  撑到远超读取窗口→正则提取三字段而非整行 JSON 解析）；尾部 response_item（message
  role=assistant/user 定 DONE/IDLE、custom_tool_call 定 CONFIRM；developer 角色跳过）；
  event_msg token_count 的 info.total_token_usage 为会话累计。
- thread_source 只放行 None/user；guardian_review 等内部会话排除（实测近 30 文件中
  12 个为 guardian_review）。
- 真机冒烟：宽时间窗下 1 会话，project=设备运维（中文 cwd 解码正确）、
  tokens.total=5,022,644 与文件内累计一致。活跃窗内无 codex 会话时空列表为预期行为。
- 红利发现（转票 03）：token_count 事件与 custom_tool_call_output 里携带
  rateLimits 快照（usedPercent/windowDurationMins/resetsAt），codex 额度可从会话
  文件本地解析，无需调 API。
