# 03: 宿主常驻件

**What to build:** 面板成为可日常共处的常驻件：托盘图标（含退出面板入口）、单实例守卫（重复拉起自动退出、不出现双面板）、Win+D 收起桌面后面板防抖自动恢复。用户视角：面板像壁纸一样常在，可从托盘管理，误触显示桌面不用找回。

**Blocked by:** 02 底座尖兵

**Status:** ready-for-human

- [x] 托盘图标常驻，菜单可退出面板；退出后托盘随之消失
- [x] 二次拉起应用立即自行退出，屏幕上始终只有一个面板
- [x] Win+D 后面板最小化，防抖窗口后自动恢复原位（实测见评论：Win11 对工具窗豁免，防抖机制兜底任意最小化来源）
- [x] 三项行为纳入验收电池并截图存证于工单评论

## Comments

**2026-09-27 实现落地 + 验收电池 27/27 跑绿（含 7 轮真机探针迭代与一轮 code-review 收编）**

`app/src/main/index.ts` 接线三项常驻行为；新增 `tray.ts`（托盘）、`wind-restore.ts`（防抖状态机，纯逻辑零 Electron 依赖，vitest 假计时器 5/5）；验收电池扩至 P7-P10（单实例/托盘/Win+D/退出闭环），`npm run accept` 一键 27/27 PASS，连跑三轮全绿。`npm test` 14/14、typecheck 绿。

**逐条验收证据（电池输出原文 `app/accept/evidence/03-battery.log.txt`，存证截图同目录）**

- **单实例守卫**：二次拉起 386ms 自行退出（code=0），被拒实例自报 `single-instance-refused` 存证；原面板窗完好、可见 Chrome 窗计数 4→4——屏上始终只有一个面板。锁只在面板模式申请（accept 电池模式不参与，面板本身是电池 spawn 的第二实例）；首次实例收到 `second-instance` 事件时唤回面板（showPanel）。
- **托盘常驻 + 退出闭环**：Shell_NotifyIcon 注册事实源=注册表 `NotifyIconSettings` 条目（exe 精确匹配）；图标程序化绘制（深底 #1a1f2e + 琥珀 #f5a623 四点 deck 母题，琥珀兼作电池识别色），经 `IsPromoted=1` 提升到可见区后识别色 256px 精确命中 @(2476,2032)（截图 `03-tray-area.png`，基线 0）；Win+B 键盘导航经 UIA 焦点链 10 步命中焦点元素「AGENT DECK 独立面板」（tooltip 名匹配）——系统级可见三重证据。退出管道：`before-quit` → `tray.destroy()` → 进程退出（真实主进程 pid 2260ms 内退出）→ 识别色回落基线（截图 `03-tray-after-exit.png`）。**菜单「退出面板」的真人右键点击留人工验收**（原因见踩坑 2）；左键点击已实证到达图标 Electron handler（`panel-shown:tray-click` 存证）。
- **Win+D 防抖恢复**：**真机实测推翻工单预设**——Win11 ToggleDesktop 不最小化 skipTaskbar（WS_EX_TOOLWINDOW）窗口：对照记事本被 Win+D 收起的同时面板 IsIconic=false 纹丝不动（截图 `03-wind-immune.png`）。**面板常在即用户故事 6 的本意（误触显示桌面不用找回）**；防抖恢复机制保留兜底任意最小化来源，以 SW_MINIMIZE 真机演练：最小化（存证 why=minimized）→ 1.50s 防抖 → 自动恢复原位（矩形偏差 ≤24 物理像素，截图 `03-wind-minimized.png`/`03-wind-restored.png`）→ 恢复后重钉生效（记事本重新盖住面板）。

**两个真机发现（后续工单与电池维护注意）**

1. **Win+D 工具窗豁免**：票 01 实施要点预留的「Win+D 恢复后重钉」在豁免场景下由防抖恢复路径的 showPanel 统一承担（托盘点击/second-instance/防抖恢复共用同一 showPanel：还原→不夺焦显示→重钉）。
2. **Win11 26200 shell 不向 Electron 托盘图标投递注入右键**：7 轮探针实证——SendInput 右键（即时/保持 120/300ms/悬停后）与聚焦后 Shift+F10 均无 `right-click` 事件、无菜单窗（#32768 从未出现）；邻位 Win32 应用图标（华为电脑管家）的注入右键可达、本图标左键可达——唯右键不通，属 shell 行为而非应用缺陷。电池相应改走 UIA 键盘导航 + WM_CLOSE 退出闭环（与菜单项 click=app.quit() 共用同一退出管道）。

**实现要点**

- 防抖状态机（`wind-restore.ts`）：轮询 250ms、防抖 1500ms；收起态首次命中开启防抖期，期满仍收起才恢复；**轮询重复命中不重置计时**（iconic 期间每轮命中，重置将永不恢复）；窗口期内 shell 还原/托盘唤回自动取消。IsDownFn 为 `'minimized'|'hidden'|null` 字面量联合，只盯最小化（评审收编：不盯 !isVisible——启动前是正常态，未来「隐藏面板」功能不应被顶回）。
- 托盘退出唯一入口=菜单「退出面板」（app.quit）；before-quit 显式 tray.destroy + `quit` 存证。
- 托盘可见性证据链（Win11 无 legacy ToolbarWindow32 可数）：注册表条目 → IsPromoted 提升（电池登记原值、finally 还原，主 finally 兜底）→ 识别色像素（连通簇定位：图标 4 个 8px 方点呈 4 簇，全局均值会被拉到簇间空档，取最大簇种子合并 48px 邻簇）→ UIA 焦点导航。
- 电池基建：`lib/win32.js` 增 FindWindowExW（koffi 需 `const char16_t *` 才收 JS 字符串）/IsIconic；`lib/uia-focus.ps1`（ASCII-only，Win+B 后托盘键盘导航）。

**踩坑记录**

1. **PowerShell 5.1 把 BOM-less UTF-8 的 .ps1 中文注释按 ANSI 误解析**，直接破坏 Add-Type（`-File` 方式炸、`-Command` 同代码不炸）——电池侧 ps1 一律 ASCII。
2. **spawn 的 child.pid 是 launcher 壳**（票02 坑 2 强化）：托盘退出后其 `exit` 事件 8s 内不触发，进程退出判定一律轮询 boot 自报 pid 的存活（`process.kill(pid,0)`）。
3. Win11 26200 任务栏纯 XAML：`Shell_TrayWnd` 下无 ToolbarWindow32、`NotifyIconOverflowWindow` 不存在——托盘计数路线整条废弃。
4. 全局均值质心在多簇同色像素下会点到簇间空档（实拍 87.1% 透明率 FAIL 同源于 shell 浮层遮挡）——图标定位用连通簇，P2 截图前 ESC 收浮层 + 命中率不足自动重拍一次。

**残留物**：无（IsPromoted 还原为原值 0、无残留 electron/notepad 进程、光标归位、config 还原）。

**Code-review 收编**（两轴并行评审，全部采纳）：IsPromoted 还原块提取 `restorePromoted()`（双 finally 去重）；`psRun` 去局部 require；`isAlive(pid)` 提取；魔法数换 VK 常量；`WinDRestorer.cancel()` 无外部调用者转私有；`IsDownFn` 字面量联合；测试改用导出常量；P7「立即退出」阈值 10s→3s（实测 0.2~1.9s）；恢复器去掉未测的 hidden 分支。保留项：tray.ts 与 battery.js 的琥珀色几何重复（电池不得 import 生产代码，以注释互链）；second-instance 唤回面板（story 46 的自然延伸，已存证）。
