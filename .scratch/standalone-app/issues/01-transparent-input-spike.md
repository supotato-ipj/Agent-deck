# 01: 透明与输入机制 spike（探针）

**What to build:** 一次性探针（非生产代码），在真机上验证新底座的四个风险机制并给出 go/no-go：① WebView2/Chromium 透明合成——透明 Electron 窗口悬浮于壁纸之上、壁纸可见；② 鼠标穿透 + 事件转发——默认点击直达桌面，代码可控地局部恢复接收；③ 底部钉扎——经 FFI/SetWindowPos 把普通窗口压在所有普通应用之下、盖过壁纸；④ 低 z 序窗口的键盘聚焦——强制前台后输入框可输入、中文输入法可用。透明合成失败时，实测 ADR-0004 已记的窗口级整体 alpha 降级路径并记录观感结论。

**Blocked by:** None (can start immediately)

**Status:** ready-for-human

- [x] 四项机制各有真机探针证据（脚本输出/截图）存证于本工单评论
- [x] 透明合成给出 go/no-go；no-go 时降级路径（窗口级 alpha）已实测并记录观感结论
- [x] 底部钉扎在普通应用窗口、置顶窗口场景下验证 z 序表现
- [x] 键盘聚焦探针验证中文输入法输入可达
- [x] 结论与实施建议回写本工单评论，02 的实现要点据此定案

## Comments

**2026-09-26 探针跑绿（四机制全过，透明合成 GO）**

探针工程：`.scratch/standalone-app/probe01/`（Electron 44.4.3 + koffi 2.9，koffi 为 NAPI 模块、无需 rebuild 直接在 Electron 主进程加载）。四探针各自独立进程可复跑：`cd .scratch/standalone-app/probe01 && node_modules/electron/dist/electron.exe . a|b|c|d`。探针开局逐窗最小化用户窗口（COM MinimizeAll 对 Edge 全屏窗不可靠，改为 ShowWindow 逐窗 + 点位校验重试），结束逐窗还原。

**① 透明合成：GO**（`a_transparency.log.txt`）

- 透明窗口（transparent+frameless）叠在不透明棋盘参照窗之上，透明区棋盘双色命中率 **100%**（70864 样本）；卡片区实色绘制、白色文字像素 1121/54000 实色清晰。证据：`a-transparent-on-checker.png`。
- 关参照窗实拍面板叠真壁纸：桌面图标透过透明区清晰可见，文字实色。证据：`a-on-wallpaper.png`、`a-wallpaper-baseline.png`。
- 降级路径（ADR-0004 备胎）实测——**重要更正（评审发现）**：最初一轮的「白字 2.1%→0.4%」结论作废，那轮截图经 MD5 比对与裸壁纸基线逐字节相同（GDI CopyFromScreen 未把半透明窗截进去）。重做的严格版本：同背景（棋盘参照）下先后测 `setOpacity(0.45)` 与直调 `SetLayeredWindowAttributes(LWA_ALPHA, 115)`，两者 EXSTYLE 均已置上 WS_EX_LAYERED（0x280000），但截屏差分均为 **零**（`a-alpha-setopacity-045.png`、`a-alpha-lwa-alpha-115.png`）。两种解释无法用本探针区分：窗口级 alpha 在透明合成路径上无视觉效果，或 GDI 抓屏对部分 alpha 分层窗存在盲区。**结论：GO 成立不依赖降级；若未来真需降级，勿依赖窗口级 alpha，改用「非透明窗口 + 渲染层 CSS 半透明」并另行实测。**

**② 鼠标穿透 + 事件转发：12/12 PASS**（`b_clickthrough.log.txt`）

- 穿透态 EXSTYLE 实测含 WS_EX_TRANSPARENT|WS_EX_LAYERED；真实 SendInput 点击穿过面板落到下层窗口（哨兵收 click 并获前台）、落到系统桌面（前台翻转为 Progman）、右键同样穿透。
- **事件转发（forward:true）单列断言**：穿透态下光标扫过面板，渲染层持续收到 mousemove——热区悬停检测的两条通路（主进程 GetCursorPos 轮询、渲染层转发事件）都实证可用。
- 热区机制按 spec 设计验证：渲染层声明热区矩形、主进程 GetCursorPos 25ms 轮询命中切换 `setIgnoreMouseEvents(true,{forward:true})/false`——进入热区 WS_EX_TRANSPARENT 移除、点击由面板接收（client 坐标精确）、面板可获前台；离开热区穿透恢复、后续点击不再被拦。
- 证据：`b-pass-through.png`、`b-hotzone-click.png`。

**③ 底部钉扎：6/6 PASS**（`c_bottom_pinning.log.txt`）

- koffi 直调 `SetWindowPos(HWND_BOTTOM, SWP_NOMOVE|NOSIZE|NOACTIVATE|NOOWNERZORDER)` 生效：记事本（Win11 打包版）盖住钉扎后的面板，面板仍在壁纸/桌面层之上（WindowFromPoint 三点探针：重叠点=记事本、仅面板点=面板）。置顶（TOPMOST）记事本同样盖住面板——z 序分带符合预期。证据：`c-pinned-bottom.png`、`c-topmost-over-panel.png`。
- **关键行为差异（02 设计输入）**：鼠标点击钉扎面板会把它顶起到普通窗之上；纯 `SetForegroundWindow` 前台化**不**顶起 z 序。→ 生产须「每次热区交互结束后重钉」，或优先用程序化前台避免顶起。

**④ 低 z 序键盘聚焦 + 中文输入法：6/6 PASS**（`d_focus_ime.log.txt`）

- 底部钉扎 + 记事本在其上时，`win.focus()` 可强制前台；focus 会顺带顶起 z 序，**focus 后立即重钉**（SWP_NOACTIVATE）即达「前台=面板、z 序=底部」共存——前台与 z 序独立实证。
- 输入框经渲染层 JS 聚焦，ASCII 键入 "deck01" 直达（注意：先经 ImmSetOpenStatus 关 IME，否则数字被候选选词吃掉——探针首轮 "DECK01"→"deck0" 的根因）。
- 中文输入法（langid 0x804 微软拼音）：键入 nihao 触发 composition 事件、IME 候选窗悬于面板输入框上方、空格上屏汉字「你…」。盲发拼音的候选次序因输入法个性化而异（本次上屏「你哈尔」），机制（composition→候选→上屏）实证无损。证据：`d-ime-composition.png`（候选窗+合成串内联下划线现场）、`d-ime-committed.png`、`d-typed-ascii.png`。
- 附测 WS_EX_NOACTIVATE（点击热区不夺前台不顶起）在 Electron 上未稳定生效，02 按「交互后重钉」设计，NOACTIVATE 不采用。

**02 实施要点（据此定案）**

1. 透明路径定案：`transparent:true + frame:false`，不走 alpha 降级（降级路径本身已证不可靠，见①更正块；真需降级时用非透明窗+CSS 半透明另测）。
2. 穿透：默认 `setIgnoreMouseEvents(true,{forward:true})`；主进程持有渲染层声明的热区矩形，GetCursorPos 轮询（25ms 量级）命中切换；切换即改 EXSTYLE，事件通路已验证。
3. 钉扎：koffi FFI 直调 SetWindowPos(HWND_BOTTOM)，flag 用 `SWP_NOMOVE|NOSIZE|NOACTIVATE|NOOWNERZORDER`；触发时机=启动后+每次热区交互结束+Win+D 恢复后。
4. 聚焦：`win.focus()`（或纯 SetForegroundWindow，它不顶起 z 序可省一次重钉）+ 渲染层 JS focus 输入框；两者都已在底部 z 验证。
5. 验收电池可直接复用本探针库：koffi 绑定（`lib/win32.js`）、WindowFromPoint 必须经 `GetAncestor(GA_ROOT)` 映射到顶层根窗口再断言（Chromium/记事本都有子窗，直比必假阴）、SendInput 用虚拟屏归一化坐标免 DPI 换算、Win11 记事本的窗口不属于启动进程（按「新出现的 Notepad 类窗口」匹配）、Electron frameless 窗 GetWindowRect 含约 12 物理像素隐形边框。

**残留物**：无（探针自清理；清场的用户窗口已逐窗还原）。display 环境备注：3120×2080 @200%，所有探针坐标已按 scaleFactor 换算。
