# 07: 搜索并入

**What to build:** 搜索浮层内嵌独立面板：待机态融入右窄栏静态视觉、热区点击激活、中文输入法可输入、实时结果、↑/↓ 选择、Enter 打开、Ctrl+Enter 资源管理器定位、ESC/失焦退回待机态、引擎不可达显示 ENGINE OFFLINE。Listary 7 本地 HTTP API 由内核直连（无 CORS、无 keep-alive 约束保持，防抖约 200ms、限流静默退避）；查询词不写入使用日志；Tk 搜索窗退役。01 spike 的键盘聚焦结论在此落地。

**Blocked by:** 02 底座尖兵

**Status:** ready-for-human

- [x] 三态（待机/活动/引擎离线）迁移完整，键盘、输入法、快捷键行为与旧验收对齐（accept_search 电池适配后跑绿）
- [x] 低 z 序下键盘聚焦与中文输入法输入可用
- [x] 查询词只发往本机 Listary API、不入使用日志（测试断言）
- [x] Listary 客户端 vitest（假 API）全绿：引擎离线/限流退避/空结果/offset 翻页/防抖
- [x] Tk 窗口代码退役，搜索框与右窄栏的垫高对齐耦合移除
- [x] 真机截图存证于工单评论

## Comments

**2026-09-27 实现落地 + 验收电池 56/56 全绿（P7S 搜索段 10 探针）+ vitest 266/266**

**架构：引擎链路全收口内核，渲染层只喂词与画三态**

- `search/engine.ts`（纯，listary_engine.py 平移）：Debouncer（时间可注入、同词去重、feedDue 绕窗重试）、buildRequest（offset 翻页透传）、parseResponse（snake_case→驼峰，异常结构退化空结果）、classifyFailure（网络失败/SEARCH_UNAVAILABLE→offline，TOO_MANY_REQUESTS→rate_limited，非法载荷→error 不冒充离线）、退避曲线 0.5s 倍增封顶 5s。
- `search/client.ts`（唯一 I/O）：node:http 直连 `127.0.0.1:<port>/api/v1/search`（host 常量收口 engine.ts，端口 config.search.port 下发）；agent:false + Connection:close 保无 keep-alive；超时 3s；网络失败抛 ListaryNetworkError，非法 JSON 抛普通异常。
- `services/search.ts`（SearchService，cordis 插件）：待机/活动机器态 + 引擎链路策略（50ms 泵统一判定防抖到期/限流退避/离线 3s 重试）；单飞行代际作废旧响应（含退待机作废）；Enter/Ctrl+Enter 动作内核执行，**path 护栏 = 最近一次结果集成员**（desktop/launch 池内校验同款）；事件 `search/state`（idle/active/offline，只在变化时推）与 `search/results`。
- 桥接扩展 4 方法：`search/activate|query|deactivate|action`（只扩表不开新通道）；panel-ipc 转发表加 search 两事件；config 新 `search.port` 段（1..65535 校验，缺省 38431）。
- **隐私边界（ADR-0002 精神）**：查询词只进内存防抖器与本机回环 HTTP，全链路无落盘；行为级测试（collect 前后使用目录无查询词）+ 源码级守卫（搜索链路禁引用 usage/log、禁 writeFileSync/appendFileSync、禁硬编码 http(s) URL）双断言；渲染层存证 notify 只带 qlen 不带内容（旧 QD_PANEL_TRACE 惯例）。
- 渲染层：SEARCH 卡占右窄栏待机位（会话/Qoder/硬件下移至 152/516/690）；待机态 SEARCH 头 + CLICK TO SEARCH_ 融卡片视觉；活动态原生输入框（IME composition 照常喂词 = 拼音实时检索）、结果行（名称保留头部 + 父路径保留尾部）、选中反白 clamp 不环绕、TOTAL 页脚、NO RESULTS、ENGINE OFFLINE 反白徽标；活动态卡片向下展开盖住会话卡（旧 Tk 面板惯例），热区随卡片矩形自动扩展。01-D 结论落地：点击激活（前台随点击）+ 渲染层 JS focus 输入框，低 z 序键盘聚焦可达；行 mousedown preventDefault 保焦点（失焦即收层、行点击不落空）。

**逐条验收证据（电池 P7S，输出原文 `app/accept/evidence/03-battery.log.txt`，56/56）**

- 引擎在线预检：探针文件直连 Listary 入索引排首位（~3s，USN 索引）；截图 `07-search-idle.png`（待机态）。
- 点击激活：search-activated 存证 + 前台门校验（pid=面板进程，低 z 序聚焦结论落地）；粘贴探针词后防抖-引擎-渲染管线打通（结果 1 行 TOTAL 1，qlen=26 只带长度）。
- Enter 打开探针文件（首行确为探针）；Ctrl+Enter 资源管理器定位（CabinetWClass 弹出，截图 `07-search-reveal.png` 活动态存证）。
- ↑/↓ 选择：常用词出满 8 行后两击 DOWN 选中第 3 行（selection-moved index=2）。
- ESC 退待机（reason=esc）、失焦退待机（点桌面 → 前台翻转 → blur）。
- ENGINE OFFLINE：config.search.port 指必死端口重启面板 → 离线徽标（截图 `07-search-offline.png`；内核 3s 静默重试在场）。

**真机踩坑记录（后续工单注意）**

1. **os.tmpdir() 给 8.3 短名**（`C:\Users\ANW~1\...`），Listary 索引报长名——引擎预检的路径断言须 realpath + basename 比对，纯字符串比对恒假阴（首轮电池实证）。
2. **活动态下点击卡片中心会落在结果行上**：结果区向下展开后卡片几何中心在列表中部——电池的「激活」探针若在活动态复用会误开结果文件（second 轮实测：误开了别的 readme 并连锁打歪后续断言）。激活探针必须从待机态起。
3. **Win11 记事本有标签页**：Enter 打开探针文件是作为既有记事本窗口的新标签打开的——按标题关窗会连 P4 对照窗一起杀（P9 Win+D 断言依赖它存活）。探针窗口不关，目录删除挪到电池末尾（关窗释放句柄后）。
4. **spawn explorer 带 windowsHide 会把文件夹窗口一起藏掉**（STARTUPINFO SW_HIDE 对 GUI 窗同样生效）：reveal ok=true 但 CabinetWClass 永不出现（third 轮实证）。GUI 应用无控制台可闪，去掉 windowsHide。
5. **环境遮挡**：真机冒烟时搜索卡被 Edge 窗盖住（用户正在用桌面）——热区进入≠点击可达，电池靠 clearDesktop 清场兜底（与既往票据同款教训）。

**Tk 窗退役边界**：`search_panel.py`、`tests/test_search_panel.py`、`scripts/accept_search.py`、`scripts/accept_search_ui.ps1` 删除（本票）；`server.py` 去 import/start_thread/panel 契约字段、`deck/index.html` 去 searchspacer 与 panel.h 高度同步（垫高对齐耦合移除）；`listary_engine.py` 及其测试保留（语义已 TS 平移并加了假 API 测试，Python 侧整体退役归 11）。

**离线测试**：engine 23 例 + client（真传输层 × node:http 假 API，离线/限流/空结果/offset/超时/no-keep-alive）9 例 + service（三态迁移/防抖/退避/离线重试/单飞行/动作护栏/离线残留）15 例 + 契约 3 例 + 隐私守卫 2 例 + config search 段 5 例；全套 267/267，typecheck 干净。

**Code-review 收编（双轴并行评审）**：① spec 轴抓出真回归——deactivate 未清 offlineShown，离线后退待机再激活会凭空显示 ENGINE OFFLINE（旧面板语义是只在真实查询失败后出现）——已修并加回归测试；② 搜索假源束在 service.spec/contract.spec 各一份 ~40 行——收敛到 `tests/search/harness.ts` 共享（跨 spec 导入会重跑 describe，故放非 spec 文件）；③ 命名归族——searchPumpMs → searchIntervalMs（同 tickIntervalMs/hardwareIntervalMs 族）、searchTearing → searchDeactivating、失焦 reason 收成字面量联合类型（存证契约显性化）；④ 电池粘贴助手段化（探针词/常用词共用）；⑤ 死代码——离线契约测试里一行被覆盖的 respondWith 桩删除；⑥ 词汇对齐——注释「搜索浮层」归一到 CONTEXT.md 规范词「搜索面板」。**有意保留**：offset 翻页与结果行 sizeBytes/modifiedAt/score 字段（工单验收点「offset 翻页」与 Listary 载荷模型平移，测试断言在盯）；config→engine 的 BASE_PORT 单一来源（注释已声明）；subscribe 双转型（cordis 逐事件签名限制，注释在案）；电池粘贴绕开 IME 合成——与旧 accept_search 同法，IME 机制本体由探针 01-D 在同窗体实证（工单验收语义「与旧验收对齐」即此）。收编后电池复跑一轮 56/0 全绿。

**残留物**：无（电池清场：探针目录已删、托盘 IsPromoted 还原、图标状态还原、config 还原、layout.json 清场、无残留 electron、光标归位）。
