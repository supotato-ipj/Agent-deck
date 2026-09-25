# 02: 接入 Listary 7 引擎——打字实时出结果，离线显 ENGINE OFFLINE

**What to build:** 活动态下键入查询词，经约 200ms 防抖后调用本机 Listary 本地 HTTP API（仅 127.0.0.1、只读、无 CORS、无 keep-alive——由数据服务调用，每请求新建连接），结果自绘为约 8 行列表（文件名 + 合理截断的路径 + 总数规模），空结果显示明确的无结果提示。API 连接失败或返回 SEARCH_UNAVAILABLE 时进入引擎离线态（ENGINE OFFLINE，呼应壁纸的 OFFLINE 徽章语言），引擎恢复后自动可用；TOO_MANY_REQUESTS 时静默退避重试。「查询 → 防抖 → 请求 → 结果模型 → 错误映射」抽成不依赖 GUI 的可导入纯逻辑，用假 API 响应离线测试全部真机上不可安全复现的分支（引擎离线、限流退避、空结果、offset 翻页、防抖窗口）。查询词不写入自建使用日志（对齐 ADR-0002）。

**Blocked by:** 01（搜索面板待机窗——需要活动态面板承载渲染）

**Status:** ready-for-agent

- [ ] 键入探针词后约一个防抖周期内出现真实结果（真机 Listary API）
- [ ] 结果行含文件名与路径截断，总数可见，默认不超过约 8 行、不超出右窄栏宽
- [ ] 空结果显示无结果提示而非空白
- [ ] API 不可达时显示 ENGINE OFFLINE，引擎恢复后自动回到可用（SEARCH_UNAVAILABLE 分支由离线测试覆盖）
- [ ] TOO_MANY_REQUESTS 分支静默退避重试（离线测试覆盖）
- [ ] 每次请求新建连接，不依赖 keep-alive
- [ ] 纯逻辑离线测试全绿（离线、限流、空结果、offset、防抖窗口五类分支）
- [ ] 查询词不出现在自建使用日志中
