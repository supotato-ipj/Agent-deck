# 工单371 探针结论文档：真实 Win11 虚拟桌面配对、切换与面板跟随（spec #369 原生门槛）

- **探针**：`app/accept/experiments/t371-virtual-desktop-probe.js`（可丢弃取证探针，非电池段）
- **正式证据**：`app/accept/evidence/371-virtual-desktop-probe.log.txt`（guard accept-sprint 轮，exit 0，断言全过；此前两轮 selftest 同样全绿——172/191ms 与 180/190ms，可复现）
- **机器**：Windows 11 Pro build 26300（25H2），单屏 2560×1440 物理像素，基线 2 个虚拟桌面
- **技术承载**：仓库既有 Electron + koffi（2.16.3）栈，未新增任何依赖

## 一、裁决：go（附边界）

spec #369 决策 3 要求「创建、切换和跟随路径必须先经探针证明」。三件事全部实测成立，**允许进入生产实现**（按决策 30，生产实现仍以失败关闭为纪律，本探针不记作生产完成）：

1. **创建/切换/删除**：ImmersiveShell `QueryService(IVirtualDesktopManagerInternal)` 走 24H2/25H2 IID `53F5CA0B-158F-4124-900C-057158060B27`，在本机 26300 全部可用（CreateDesktop / SwitchDesktop / RemoveDesktop / GetCount / GetCurrentDesktop / GetDesktops）。热键回退路径（Win+Ctrl+D / ←→ / F4，SendInput 和弦）亦实测可用（S10 回读确认 357ms）。
2. **系统桌面 ID 事实源**（多源互证，判定不依赖乐观假设）：
   - 公开 `IVirtualDesktopManager`（CLSID `AA509086-…`，IID `A5CD92FF-…`）：`GetWindowDesktopId` / `IsWindowOnCurrentVirtualDesktop` 对本进程与他进程窗口全部读回成功（S3 观察：4/4 他进程窗口成功）；
   - 注册表 `HKCU\...\Explorer\VirtualDesktops` 的 `VirtualDesktopIDs`（桌面全集合）+ `CurrentVirtualDesktop`（当前桌面），**单次 `reg query` 原子读**（分两次读会撞 explorer 中途更新产生错配快照，调试轮实证）；
   - DWM cloak 分位 `DWMWA_CLOAKED == 2`（DWM_CLOAKED_SHELL）标识「在其他虚拟桌面」——对普通可激活窗口可靠；
   - 内部 COM `GetCurrentDesktop()` 直读当前桌面 ID。
   - 注意 GUID 端序：注册表存的是原始 16 字节（Data1/2/3 小端），COM 结构体字段经 koffi 解码后已是主机序数值——两处换算若做错会把同一桌面变成两套永不匹配的字符串（调试轮实证踩坑）。
3. **桌面切换性能**：点击→系统事实确认 161/176ms（spec 决策 17 预算 ≤1000ms），热键切换确认 ~360ms。

## 二、面板/任务栏/胶囊跟随：机制实测（重要发现）

以生产同形态窗口实测（`panel-window.ts:29` 实测注释：生产 `skipTaskbar` 走 `ITaskbarList::DeleteTab`，**不设 `WS_EX_TOOLWINDOW` 位**；应用集合排除走自家进程规则）：

| 窗口形态 | 跨桌面行为（实测） |
| --- | --- |
| `WS_POPUP` + `WS_EX_TOPMOST\|WS_EX_NOACTIVATE`（任务栏/胶囊/面板开 alwaysOnTop 形态） | **自动跟随**：切走后静置 800ms 仍 `IsOnCurrent=true` + 未 cloak——原生跨桌面在场，无需任何动作 |
| `WS_POPUP` + 仅 `WS_EX_NOACTIVATE`（非置顶面板形态） | **同样自动跟随** |
| `WS_OVERLAPPEDWINDOW`（普通可激活窗，如应用窗口） | **桌面绑定**：切走即 shell cloak（cloak=2）、`IsOnCurrent=false` |

即：**跟随机制对 NOACTIVATE 弹窗是免费的**——面板/任务栏/胶囊无需逐桌面重显。失败边界两条如实记录：

- **`SW_SHOWNA` 重显不迁移** desktop-bound 窗（调试轮与正式轮一致：migrator 重显后 `on=false,cloak=2` 不变）。跟随兜底不能走重显。
- **公开 `IVirtualDesktopManager::MoveWindowToDesktop` 可用**（hr=S_OK，窗口真实迁移，正式轮两方向各验一次）——desktop-bound 窗的跨桌面移动兜底路径成立，顺带回答了 spec 决策 3 的「窗口跨桌面移动观察」。

**生产待验证项（不阻塞 go，但进入实现票须复验）**：

- 面板「键盘模式」会临时 `setFocusable(true)`（panel-window.ts:12）——focusable 翻转后窗口是否从「跨桌面在场」退化为「桌面绑定」，探针未覆盖（探针窗没有 focusable 翻转语义）；若退化，需在键盘模式期间用 `MoveWindowToDesktop` 或保持某个 NOACTIVATE 锚定。
- 探针窗均为本进程简单窗；真实 Electron BrowserWindow（透明、DeleteTab）在 26300 的同款行为应在实现票用真面板复验一轮。
- 自动跟随意味着面板会出现在**所有**虚拟桌面（含 unmanaged 第三桌面）——是否符合产品语义（spec 用户故事 7：其他桌面不受托管）属设计裁决，需在实现票明确（若要限制，可评估 `IVirtualDesktopPinnedApps` 反向能力或接受全桌面在场）。

## 三、第三桌面与零残留

- **第三桌面安全**：新建一个替身桌面（当作用户既有桌面），配对切换 4 轮中逐轮断言：当前桌面从不落在它、其系统 ID 始终在册、哨兵窗归属不变、桌面集合数不变——不被吞并、不被删除、不被自动切回（正式轮 S8 全绿）。
- **零残留**（S11）：`RemoveDesktop` 后注册表桌面集合与基线**逐项相等**（含 GUID 集合）、当前=普通桌面；探针窗口全部销毁（本 pid 顶层可见窗=0）；原生任务栏 `ABM_GETSTATE` 与可见性不变（矩形在 autohide 下随 peek 漂移，只记录不断言）；探针不 spawn 子进程，进程退出即无驻留。
- **残差纪律（调试轮教训）**：调试轮一次 JS 崩溃（TDZ）曾把两个孤儿桌面留在机器上（后用一次性脚本清掉复原）。探针因此内置 `recoverCleanup()`：任何中途异常都尽力删除本探针新建的桌面（COM 删除 + 热键兜底）。生产实现必须把「创建后任何失败路径都要回收桌面」作为硬纪律。

## 四、工程事实（实现票直接可用的坑位清单）

1. **COM 调用形态**：koffi vtable 直调（`koffi.call(ptr, proto, ...)` + `koffi.proto('__stdcall', ...)`）；out 参数必须 `koffi.out(...)` 否则解码不回写；`koffi.register` 的回调类型必须传 `'ProtoName *'`；GUID 用 `CLSIDFromString` 构造（手拼 struct 不可靠）；ImmersiveShell 必须**直接以 `IID_IServiceProvider`（`6D5140C1-7436-11CE-8034-00AA006009FA`）CoCreateInstance** 再 QueryService——对裸 IUnknown 直接调槽 3 会段错误（调试轮实证）。
2. **IID 漂移防护**：适配器绑定失败（`QueryService` E_NOINTERFACE 等）必须显式失败关闭（spec 决策 30），不得静默改热键凑合——热键路径只作为显式声明的回退，且判定一律走系统事实回读。
3. **消息泵**：SendInput 点击 → `WM_COMMAND` → handler → `SwitchDesktop` 链路要求本线程派发消息；轮询等待循环里必须显式泵消息（PeekMessage/Translate/Dispatch），否则消息派发只能靠谓词里 spawn 子进程的副作用，时序时好时坏（调试轮实证：S7 确认曾靠 `execSync` 间接泵消息，1603ms 才到；改为确定性泵后 176ms）。
4. **判定口径**：切换成功 = 公开 `IsOnCurrent`（哨兵离场/回场）+ 注册表当前 ID + 内部 `GetCurrentDesktop` + DWM cloak 四源一致；「点了/调了就当成功」的乐观假设为零。

## 五、与票面验收标准的对应

| 验收标准 | 证据行 |
| --- | --- |
| 探针能创建或识别一对真实虚拟桌面，并以系统桌面 ID 区分目标和第三桌面 | S3/S4/S6/S8 PASS 行（多源 ID 互证） |
| 点击探针入口后实际桌面发生切换，成功判定不依赖发送快捷键后的乐观假设 | S5/S7 PASS 行（真 SendInput 点击按钮 → WM_COMMAND handler → SwitchDesktop → 四源回读确认，161/176ms） |
| 独立面板、自绘任务栏和胶囊探针能在两个桌面使用且自身不进入应用窗口集合 | S6/S7 跟随 PASS 行（自动跟随机制判定）+ S3 排除 PASS 行（自家进程排除规则，生产同款；合格集正对照非空） |
| 第三桌面不被吞并、删除或自动切回 | S8 两行 PASS（替身桌面四轮全程原样） |
| 探针结束不留下多余桌面、窗口、原生任务栏状态或常驻进程 | S11 四行 PASS + 常驻进程结构性说明 |
| 结果记录可行路径、失败边界和是否允许进入生产 | 本文档 + 探针头注（探针能力不记作生产完成） |
