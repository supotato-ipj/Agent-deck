# 05: 融合版式——经典右栏骨架 + 会话行按需展开聚焦详情

**What to build:** 以 deck/index.html 为底改造右栏：会话行点击后在右栏内就地展开聚焦详情（状态灯、任务清单、NOW 行、消息预览流——渲染逻辑从 wallpaper/deck.js 移植并适配 36rem 栏宽，预览流客户端累积上限 8 沿用）；再点收起；同一时刻至多一行展开。右栏结构调整为 SEARCH 槽位 → SESSIONS →（预留 USAGE/TODAY 均可让位）→ 硬件行钉底。字号沿用 100vw/160 等比；行高显式声明避免大字形裁切（wallpaper 的教训）。HUD 版 wallpaper/ 保持冻结不动。

**Blocked by:** None（可立即开工；票 06 的用量块在本票让出的槽位落位）

**Status:** ready-for-agent

- [ ] 点击展开/收起：浏览器目测（直开 index.html + /deck 数据）+ 截图存证
- [ ] 展开内容与 /deck 的 tasks/current_task/preview 契约对齐；无数据字段优雅留白
- [ ] 硬件行钉底不被展开内容挤走；SEARCH 槽位与搜索面板窗口几何不冲突
- [ ] 大字形无裁切（1080p 与 2880x1800@200% 两档目测）
- [ ] WE 实机验收截图存本票评论；deploy_deck.py 下发后即时生效
