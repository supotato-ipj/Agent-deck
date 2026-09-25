# 02: 接入 Listary 7 引擎——打字实时出结果，离线显 ENGINE OFFLINE

**What to build:** 活动态下键入查询词，经约 200ms 防抖后调用本机 Listary 本地 HTTP API（仅 127.0.0.1、只读、无 CORS、无 keep-alive——由数据服务调用，每请求新建连接），结果自绘为约 8 行列表（文件名 + 合理截断的路径 + 总数规模），空结果显示明确的无结果提示。API 连接失败或返回 SEARCH_UNAVAILABLE 时进入引擎离线态（ENGINE OFFLINE，呼应壁纸的 OFFLINE 徽章语言），引擎恢复后自动可用；TOO_MANY_REQUESTS 时静默退避重试。「查询 → 防抖 → 请求 → 结果模型 → 错误映射」抽成不依赖 GUI 的可导入纯逻辑，用假 API 响应离线测试全部真机上不可安全复现的分支（引擎离线、限流退避、空结果、offset 翻页、防抖窗口）。查询词不写入自建使用日志（对齐 ADR-0002）。

**Blocked by:** 01（搜索面板待机窗——需要活动态面板承载渲染）

**Status:** ready-for-human

- [x] 键入探针词后约一个防抖周期内出现真实结果（真机 Listary API）
- [x] 结果行含文件名与路径截断，总数可见，默认不超过约 8 行、不超出右窄栏宽
- [x] 空结果显示无结果提示而非空白
- [x] API 不可达时显示 ENGINE OFFLINE，引擎恢复后自动回到可用（SEARCH_UNAVAILABLE 分支由离线测试覆盖）
- [x] TOO_MANY_REQUESTS 分支静默退避重试（离线测试覆盖）
- [x] 每次请求新建连接，不依赖 keep-alive
- [x] 纯逻辑离线测试全绿（离线、限流、空结果、offset、防抖五类分支）
- [x] 查询词不出现在自建使用日志中

## Comments

**2026-09-25 ticket 02 实现完成（ready-for-human）**

实现：`listary_engine.py`（纯逻辑：Debouncer 防抖/feed_due 重发、build_request、
parse_response、classify_failure、backoff_delay、display_parts、elide_left/right；
I/O：http_search 每请求新建 HTTPConnection、finally 关闭、3s 超时，QD_LISTARY_PORT
可换假端口复现离线）+ `search_panel.py` 集成（StringVar 追踪喂防抖——中文输入法合成
提交对 var 生效；50ms tick 检查到期；工作线程查询、代际号作废过期响应、queue 回传
Tk 线程渲染；结果区窗口向下展开，ESC 收起复位；离线徽标反白样式同壁纸 OFFLINE）。

错误语义（评审后修正）：offline 仅指「引擎不可达/SEARCH_UNAVAILABLE」；引擎在线但
响应异常（非 JSON、未知错误码）归 error——不冒充离线、不自动重试、等下次输入；
仅 TOO_MANY_REQUESTS 走静默退避（0.5→5s 倍增封顶）。offset 覆盖为契约级
（build_request 直通测试）：面板按设计不分页（8 行 + TOTAL 总量）。

验收证据（`evidence/` + trace）：
- 真机快乐路径（11/12-results-readme）：粘贴→防抖 0.35s→API 往返 61ms→8 行渲染
  （视觉复核：名称+省略号路径+TOTAL 9747），ESC 收起后结果区 0 亮px。
- 真机离线（11-results-zzoffline + zzretry2 trace）：假端口→ENGINE OFFLINE 徽标
  （反白 16k 亮px）→+3s 自动 retry→再查；SEARCH_UNAVAILABLE/限流分支由离线测试覆盖。
- 隐私：使用日志与 QD_PANEL_TRACE 文件 grep 查询词均为零命中（trace 只记 qlen）。
- 测试：listary_engine 25 例 + 面板渲染 8 例，全套 182 绿。

ready-for-human 项：中文输入法合成实际打字仍待人工目验（自动化走剪贴板粘贴，
真人合成输入是 ticket 01 遗留的同一项，两项一并验）。
