# 11: 搜索面板对话 tab——桌面的 DSH 入口

**What to build:** search_panel 状态机加 CHAT 态：待机态点击后可选"文件/对话"两个 tab（同一窗口骨架，视觉语言不变）；对话 tab 输入经 ACP（或 harness API，实现时按 dsh 文档定）提交任务到 DSH，流式回显最近回复（克制：单行摘要 + 最近一条，完整过程去 dsh web）；提交的 DSH 会话自动进入壁纸会话列表（经票 02 的 dsh scanner 自然可见）。ESC/失焦回待机态语义不变；引擎/DSH 不可达时对话 tab 显示降级提示（对齐 ENGINE OFFLINE 语言）。

**Blocked by:** 10（MCP/ACP 通道与边界 ADR 先行）

**Status:** ready-for-agent

- [ ] 状态机：IDLE→ACTIVE(文件)→CHAT 切换与回退，纯逻辑测试先行（对齐 PanelStateMachine 风格）
- [ ] DSH 提交链路：本地 mock 先行（提交/回显/取消）；真机冒烟存证
- [ ] 提交的会话在壁纸列表可见（DH 行）
- [ ] 降级：DSH 不可达显示 OFFLINE 类提示；隐私：查询内容不落日志（对齐 ADR-0002 精神）
