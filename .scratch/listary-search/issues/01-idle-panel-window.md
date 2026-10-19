# 01: 搜索面板待机窗——落位 DECK 右窄栏顶部，点击可打字

**What to build:** 数据服务启动时，一个待机态搜索面板出现并钉在 DECK 右窄栏顶部新 SEARCH 面板头的位置，视觉与壁纸融为一体（同款等宽字体、前景色与分隔线，看起来就是壁纸画出来的）；DECK 侧新增 SEARCH 面板头，SESSIONS 让位下移，硬件块布局不变。点击待机面板转为活动态：原生输入框获得焦点、可直接打字，中文输入法原生可用；ESC 或点击桌面别处（失焦）退回待机态。本票不接引擎——活动态暂显示「引擎未接」类占位即可。搜索面板的窗口线程寄生于数据服务（ADR-0003）：窗口异常不得拖垮数据服务本体，壁纸侧的既有轮询不受影响。

**Blocked by:** None（可立即开工）

**Status:** ready-for-human

- [x] 服务启动后，待机窗出现在右窄栏顶部并与 DECK 视觉对齐（100% 缩放）
- [x] DECK 显示 SEARCH 面板头，SESSIONS 下移、硬件块不动，整体布局不破
- [ ] 点击待机窗转活动态，输入框获焦，中文输入法可用（点击/获焦/英文输入已验；**中文输入法合成待人工确认**）
- [x] ESC 与失焦均退回待机态
- [x] 人为制造窗口线程异常时，数据服务本体不受影响（/deck 轮询仍正常响应）
- [x] 待机态与活动态截图存证于本票评论

## Comments

**2026-09-25 ticket 01 实现完成（ready-for-human）**

实现：`search_panel.py`（状态机纯逻辑 + Tk 窗口层，私有加载壁纸同款字体 Decima Mono
Cyr，窗口绘制 SEARCH 面板头与输入行，壁纸侧只留固定高度槽位）；`server.py` 增面板
线程（daemon + 双层异常兜底）与 `/deck` 的 `panel` 几何字段；DECK 壁纸（AGENT DECK，
注意其已由 QODER DECK 更名而 CONTEXT.md 词条尚未跟）加 `#searchspacer` 让位、硬件块
`margin-top:auto` 钉底、槽位高度随 `/deck` 的 `panel.h` 自适应（实测 73px，离线兜底
64px）。壁纸已用 WE 控制命令重载生效。

验收方式与证据（`evidence/`）：
- 待机态 `07`（提示行 756 亮px）/ 活动态占位 `08`（AWAITING ENGINE (02)_，1069 亮px）/
  点击打字 `05`（视觉复核见 deck+光标）/ ESC 复位 `04==06` 逐像素相等。
- 事件级证据（QD_PANEL_TRACE）：click IDLE→ACTIVE、粘贴 query='ok'、esc→IDLE 且清空。
- 崩溃隔离（QD_PANEL_CRASH=2 + QD_PORT=5050）：窗口线程真实终结（destroy 后线程体内
  抛出，绕开 Tk 吞回调异常），/deck 持续 200。
- 单测：状态机 8 例 + 渲染逻辑 4 例（winfo_manager 断言，withdrawn 可测），全套 153 绿。

留给人工：中文输入法合成输入的目验（自动化取证用剪贴板粘贴绕开 IME——SendKeys 裸键
会被合成框吞掉 KeyPress；真人打中文本来就走合成，这正是待人工点）。

验收钩子（环境变量，非生产路径）：`QD_PORT`（并行测试实例）、`QD_PANEL_CRASH`（注入
线程终结）、`QD_PANEL_TRACE`（事件流水）、`QD_PANEL_AUTOACTIVATE`（程序化激活）。
ticket 05 验收电池直接复用。

排障教训（写进电池注意事项）：截图取证必须先 MinimizeAll（仓库 capture 先例）；
PS1 行内注释必须 ASCII（无 BOM 文件被 PowerShell 5.1 按 GBK 读，中文行内注释乱码可
吞行）；杀 Windows 原生进程用 taskkill（bash kill 常无效，会留僵尸面板窗口叠在同一
坐标偷走点击）。曾由此叠加出「渲染卡栈」假象并暴露一个真 bug：渲染切换已从
winfo_ismapped 改为 winfo_manager 判断（pack 与映射之间的时间窗会让组件卡在堆叠）。
