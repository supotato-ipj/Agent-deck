# 02: DSH scanner——第八工具状态接入

**What to build:** agent_sessions 新增 dsh 扫描器：先写一个只读探针脚本摸清 `~/.dsh/sessions/` 的会话存储结构（目录布局、状态文件、mtime 语义、是否有 title/project 可取、subagent 会话特征），再按探针结论实现扫描器：会话行进混排（标签 DH、四态判定、project/title 尽最大可得），subagent/内部会话若噪音过大则按 ZCODE_SUBAGENT_PREFIX 先例排除并在票面记录规则。注意区分开源 harness（dsh CLI）与桌面端（@deepseek-ai/dsh-desktop）的会话归属，避免同会话双计。

**Blocked by:** None（可立即开工；探针先行）

**Status:** ready-for-agent

- [ ] 探针结论记录在本票 Comments（目录结构、关键字段、样例脱敏摘录）
- [ ] 扫描器实现：fixture 临时目录断言 DH 标签、四态、title/project 可得性
- [ ] 双源去重或归属规则明确（harness vs desktop 不双计）
- [ ] 坏源静默跳过；SESSION_ROOTS 增加 dsh 根
- [ ] 全部测试通过；README 表格更新（八工具）
