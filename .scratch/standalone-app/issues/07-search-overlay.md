# 07: 搜索并入

**What to build:** 搜索浮层内嵌独立面板：待机态融入右窄栏静态视觉、热区点击激活、中文输入法可输入、实时结果、↑/↓ 选择、Enter 打开、Ctrl+Enter 资源管理器定位、ESC/失焦退回待机态、引擎不可达显示 ENGINE OFFLINE。Listary 7 本地 HTTP API 由内核直连（无 CORS、无 keep-alive 约束保持，防抖约 200ms、限流静默退避）；查询词不写入使用日志；Tk 搜索窗退役。01 spike 的键盘聚焦结论在此落地。

**Blocked by:** 02 底座尖兵

**Status:** ready-for-agent

- [ ] 三态（待机/活动/引擎离线）迁移完整，键盘、输入法、快捷键行为与旧验收对齐（accept_search 电池适配后跑绿）
- [ ] 低 z 序下键盘聚焦与中文输入法输入可用
- [ ] 查询词只发往本机 Listary API、不入使用日志（测试断言）
- [ ] Listary 客户端 vitest（假 API）全绿：引擎离线/限流退避/空结果/offset 翻页/防抖
- [ ] Tk 窗口代码退役，搜索框与右窄栏的垫高对齐耦合移除
- [ ] 真机截图存证于工单评论
