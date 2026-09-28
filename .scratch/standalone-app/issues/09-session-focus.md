# 09: 会话块直达

**What to build:** 点击会话列表卡中的会话块，把对应工具的窗口聚焦到前台；对应工具未运行时启动它。进程发现与启动为内核能力，经桥接契约暴露；未知或失效目标静默降级，不影响面板。

**Blocked by:** 04 数据卡片

**Status:** ready-for-human

- [x] 工具运行中：点击会话块其窗口被带到前台
- [x] 工具未运行：点击后启动对应工具
- [x] 未知/失效目标静默降级，面板不崩
- [x] 电池探针以探针进程验证聚焦与启动路径
- [x] 真机截图存证于工单评论

## Comments

**2026-09-28 开工前设计决策点：工具→exe 映射**

09 要求"进程发现与启动"，而当前全仓不存在工具→exe 映射（扫描器只持有数据根，`app/src/main/scanners/index.ts:31`；`TOOL_TAGS` 只是渲染层显示标签，`app/src/renderer/main.ts:6`）。需新增一份映射。

- **主路径（推荐）**：config.json 新增 `tools` 段，字段设计成可改（先以当前生产值为默认），换机或改安装位置只调 json 键，不是返工。
- **可选兜底（不作为方案）**：若五工具在桌面有 lnk，理论上可零新增映射走 `desktop/launch` 池内条目——但工具通常装在 Program Files 或用户目录、无桌面快捷方式，指向版本也可能与实际运行实例不一致，不可靠。

池校验代码本身是 **05 的交付物**（`app/src/main/services/desktop.ts` 的 `launch` 方法，`this.items.some((i) => i.path === filePath)`），09 引用它但不在本票重写；`spec.md:99` 是 spec 全局约束（只禁 Steam/WE 绝对路径），在 09 票面引用即可，不需要改动 spec。

结论：决策点归 **09**，不单独立票，实施时随 09 落地（config 优先）。

---

**2026-09-28 实现落地：config.tools 映射 + 内核 focus 服务 + 电池 P9 三探针全绿**

**架构：决策收口内核，渲染层只发工具名**

- **config 新 `tools` 段**（`config.ts`）：`tools.<tool> = { launch, processes }`——`launch` 是启动目标 exe（支持 `%VAR%` 展开，本机强相关段用 `LOCALAPPDATA`/`ProgramFiles` 占位），`processes` 是窗口发现用的进程镜像名（小写 basename 去 .exe，**可多值**：Electron 应用常有「启动器 + 主进程 + 若干渲染/GPU 子进程」并存，只认主 exe 名会漏——Qoder 故收 `qoder cn launcher` + `qoder cn`）。缺段的老 config.json 静默合并五工具默认；字段级校验，非法回退默认并告警（同 appearance/search 段惯例）。换机或改安装位置只改 json 键。
- **`focus/plan.ts`（新，纯逻辑）**：`planFocus(查表结果, 窗口快照)` 三态穷尽——命中可见窗口 → `focus`（择优：可见未最小化 > 可见已最小化 > 不可见跳过），无窗口但有 launch → `launch`（常驻托盘无可见窗口也走这里：ShellExecute 对单实例应用是唤起而非新开），否则 `degrade`。辅缝离线可测，不碰 FFI/Electron。
- **`focus/adapter.ts`（新，真源）**：koffi **延迟绑定**（desktop/adapter、usage/native 先例），顶层窗口链式枚举（`GetTopWindow`/`GetWindow` 链，与 `accept/lib/win32.js` 实证形态同形，不用 EnumWindows 回调）；置前 = `IsIconic` 则 `SW_RESTORE` + `BringWindowToTop` + `SetForegroundWindow`，失败（前台锁）返回 false 由服务降级。**隐私：只取窗口所属进程的可执行路径，不读任何窗口标题**（ADR-0002 边界同 usage/native；新增源码级守卫测试）。
- **`services/focus.ts`（新 cordis 插件）**：deps 束（listWindows / focusWindow / launch / env）+ 状态机，与 05/06/07/08 服务同构。窗口枚举抛错时仍尝试启动（工具未运行照样能拉起）。
- **契约只扩不增通道**：`BridgeMethods` 加 `session/focus { tool } → { ok, action, error?, hwnd? }`；preload 与 panel-ipc 转发表**零改动**（无事件推送，故无需转发表）。`FocusAction` 类型单一来源在 `shared/contract.ts`。
- **渲染层**：`.srow` 加 click → `session/focus`，存证 `session-focus-clicked` / `session-focus-result`（含 action + 降级原因）/ `session-focus-failed`；行加 `data-tool` + hover 底色 + `cursor:pointer`。`sessions-rendered` 存证补 `rows[{tool, project, rect}]`（电池按 project 精确定位落点，同 desktop-rendered rects 惯例）。

**边界：渲染层永不发路径**

启动目标只从 `config.tools` 取，映射缺失即降级——与 05 的 `desktop/launch` 池校验同款的任意路径执行防线（09 无「池」可校验，配置本身就是白名单）。服务侧用 `hasOwnProperty` 判定 + plan 侧形状守卫（见踩坑 1）。

**逐条验收证据（电池 P9，输出原文 `app/accept/evidence/03-battery.log.txt`）**

- 启动路径：探针无窗口 → 点会话块拉起其 exe（`action=launched`，notepad 探针窗口出现）。截图 `09-session-focus-launched.png`。
- 聚焦路径：探针窗口 `SW_MINIMIZE` 收起（前台离开探针）→ 点会话块被**还原并带到前台**（`action=focused`，`hwnd` 与探针窗一致，前台 pid 翻转到探针 pid，`IsIconic=false`）。截图 `09-session-focus-focused.png`（画面可见 SESSIONS 卡 `QD RUN DECK-PROBE-09` 行 + 探针窗已还原置前）。
- 静默降级：清空该工具映射 → 断言 `action=degraded` + **面板未崩**（降级后再点时钟卡仍收到 click 存证 = 仍可交互）。
- 附带：config 显式 tools 段的启动目标在本机存在性只读核对（映射写错会退化为「每次重跑启动器」，是本票唯一探针覆盖不到的风险）。
- 离线：vitest **318/318**（新增 focus/plan 13 例、focus/service 10 例、config 6 例、contract 3 例）、typecheck 干净、`node --check battery.js` 通过。

**真机踩坑记录（后续工单注意）**

1. **查表命中原型链 = 抛异常而非降级**（评审抓出，最有价值的一条）：`this.tools[tool]` 在 `tool` 恰为 `toString`/`constructor`/`hasOwnProperty` 时会取到 `Object.prototype` 的成员（函数，truthy），`planFocus` 未做形状校验即 `.processes.map` → `TypeError`，`focusTool` 以 rejected promise 收场，**违反「未知/失效目标静默降级」**（面板靠渲染层 `.then(_,_)` 兜住不崩，但契约层是洞）。修法两层：服务侧 `Object.prototype.hasOwnProperty.call` 只认自有条目，plan 侧 `asToolTarget` 补形状守卫（launch 须 string、processes 须 string[]）。已补 4 条原型键 + 4 条形状非法 + 路径型工具名的单测。**教训：任何「外部字符串查配置表」的入口都要防原型链**，`config.tools` 是 Record 字面量，正好中招。
2. **Win11 记事本是单实例进程**：「另开一个盖窗证明前台翻转」的判据作废——盖窗与探针窗同 pid，翻转无从证明。改用「`SW_MINIMIZE` 收起探针窗 → 点击 → 断言被还原且置前」，顺带覆盖内核 `SW_RESTORE` 分支。
3. **探针窗会挡住会话块落点**：会话卡在**右上**信息列，探针窗若落在屏中央/右侧，`WindowFromPoint` 命中探针而非面板，点击被探针吃掉（表现为 `result=null` 而内核其实是对的）。探针/盖窗一律放屏幕左侧。
4. **本机可能一个活跃会话都没有**（五工具都没在 10 分钟活跃池内）→ 会话卡空 → 无行可点，探针无从下手。解法：在 `.qoder-cn` 数据根种一条**专属探针会话**（唯一标记 `DECK-PROBE-09`），按 `project` 精确定位那一行，绝不点到用户自己的行；清场时整目录删。
5. **`panel/changed` 不落存证日志**：`panel-ipc` 只把事件转发给渲染层、不写 event log，所以拿它当「面板存活」判据恒为 false。改用「降级后再点时钟卡仍收到 `clock-card-clicked`」——顺带证明了面板**仍可交互**，比只证明还在推送更强。
6. **电池会被用户自己的窗口污染**：跑电池期间用户桌面若有 Electron 应用（Chrome_WidgetWin_1）盖住面板，多个探针会连环误判（本轮实测 pass=34/fail=21）。跑电池前请先最小化自己的窗口。

**残留检查**：config.json 已整段还原（无 tools 段残留）、探针会话目录 `~/.qoder-cn/projects/DECK-PROBE-09` 已删、探针 notepad 已关、无残留 electron 进程、光标归位、基线 worktree 已移除。

**未验事项（如实记录）**：五条**真实**工具映射的「点击真的能拉起对应工具」未做真机点击（探针用的是 notepad 替身，避免扰动用户应用）。已只读核对五个 `launch` 路径在本机均存在、`Qoder CN.exe` 实际装在 `D:\programs\Qoder CN\`。**残留风险**：Qoder 的 `launch` 指向 `%LOCALAPPDATA%\...\Qoder CN Launcher.exe`（启动器），而实际进程在 D 盘安装目录——点它能否把 D 盘那份拉起，只能人工点一次确认；若某工具镜像名写错，表现是「聚焦静默退化成每次重跑启动器」。电池新增的启动目标存在性核对能在合并前挑出「路径不存在」这一类，其余需人工各点一次。

**评审收编**（双轴并行评审，verifier 独立复核）：必修复 3 项已全部处理——原型链抛异常（见踩坑 1）、`contract.ts` 误改缩进、工单收尾（本段）。另采纳：`FocusAction` 类型去重（改从 `shared/contract` 取）、补真实工具映射的只读核对、一条名不副实的测试（原本没传任何含路径入参、零证明力）改为真的用路径型工具名走一遍并断言「不执行」。**有意不做**：① `adapter` 未滤 DWM cloaked 窗（挂起态 UWP 窗 `IsWindowVisible` 仍为真，可能赢得择优后置前失败）——五工具均为桌面/Electron 应用，命中概率低，且真发生也只是优雅降级不崩；加 dwmapi 绑定会扩大 FFI 面，收益不抵风险，留作后续。② 每次点击在主进程同步全量枚举窗口无缓存——点击热路径、窗口数量级下开销可忽略。③ 电池新增段未加分号（与 battery.js 既有风格不一致）——纯风格，且重排有引入手误风险。
