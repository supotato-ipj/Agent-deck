# 10: MCP server L1——desktop-deck 作为 DSH 的桌面工具面

**What to build:** 数据服务旁挂 MCP 端点（stdio 起步，传输层实现时比对 harness mcp-client 的连接习惯），把现有能力注册为只读工具：`get_agent_status`（collect_sessions 输出）、`get_token_usage` / `get_quota`（/usage 输出）、`search_files`（Listary 引擎代理）、`get_hw_stats`（性能快照）、`get_desktop_zones`（分区/编排状态，只读）、`get_today`（滴答，票 07 到货后并入）。工具暴露面走 config 白名单，默认最小集（状态+硬件）；每个工具带一句话 description 供模型理解。先补 ADR（docs/adr/）记录边界与安全考量（只读、无 shell、白名单）。

**Blocked by:** 04（用量端点就绪）

**Status:** ready-for-agent

- [ ] ADR 落 docs/adr/（边界：只读、无写操作、白名单、降级原则）
- [ ] MCP 端点：dsh mcp-client 实连冒烟（工具列表可见、get_agent_status 一次真实调用返回）
- [ ] 白名单配置生效（默认最小集）；未暴露工具不可见
- [ ] 崩溃隔离：MCP 线程异常不影响 /deck /performance（对齐 search_panel 先例）
