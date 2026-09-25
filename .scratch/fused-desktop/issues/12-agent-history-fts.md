# 12: agent 会话内容检索——FTS tab

**What to build:** 搜索面板加"会话"检索源：hermes messages_fts 直接查询；zcode db 的 message/part 表建轻量查询（只读、限流）；qoder/codex jsonl 内存 LRU 尾索引（不落盘）。结果行显示工具标签 + 会话标题/时间 + 命中摘录（脱敏截断），点击打开对应工具或会话文件。入口与票 11 的 tab 骨架合并（文件/会话/对话三源）。

**Blocked by:** 05（tab 骨架成型）、10（如需作为 MCP 工具暴露则依赖其 ADR 框架）

**Status:** ready-for-agent

- [ ] hermes FTS 查询：fixture db 断言命中与摘录截断；只读 URI
- [ ] zcode message 查询：限流（单次查询上限 + 超时）
- [ ] qoder/codex LRU 尾索引：fixture 断言命中率与内存上限
- [ ] 结果行点击行为三态（可打开/仅查看/无动作）明确并存证
