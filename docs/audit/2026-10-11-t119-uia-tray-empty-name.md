# 工单119 取证报告：托盘 UIA 键盘导航空名——独立复现性与归因

- 日期：2026-10-11（预登记）/ 结果补记见 §6
- 工单：[#119](https://github.com/supotato-ipj/Agent-deck/issues/119)（#107 方向④，工单111 静态审计分离立项）
- 代码：`app/accept/lib/uia-probe2.ps1`（增强探针）、`app/accept/experiments/uia-tray-forensics.js`（harness）、`app/accept/experiments/uia-tray-analyze.js`（分析器，判读规则单测 `app/tests/accept/uia-tray-analyze.spec.ts`）
- 产物：`D:\test-folder\.agent-notes\t119-uia-tray-forensics\run-<时间戳>\`（不进仓库）

## 1. 背景与票面勘误

主电池托盘段（**P10**，非票面所称 P10E——P10E 是设置浮层退出按钮段，无 UIA）的 Win+B 键盘导航探针（`uia-focus.ps1`）在现场日志呈现**三种失败签名**，票面只描述了其一：

| 签名 | 形态 | 出处 |
|---|---|---|
| **A 全空串** | STEP 0–19 焦点名全空 → NOT-FOUND | battery-final/final2/final5 |
| **B 焦点冻住** | 20 步同一非空名（"Search box"），LEFT 未生效 | battery-baseline/run2 |
| **C 真托盘可导航、无我方图标、夹空步** | 正常走过 Show Hidden Icons→Clock→Power→Volume→Network→输入法，唯独无 AGENT DECK；STEP 8/17 为空、恰在绕回前末位 | battery-final3 |

三份日志同场均伴随后续「P10E 重启后未见面板窗口」电池中断——即全部现场都在 #107 停摆（根因已定案：stdout 管道写阻塞，PR #137 修复）的级联里。

**提问背景已变**：#107 根因修复后的健康面板上，空名是否仍可复现、与什么相关——这是本票要回答的问题。

## 2. 机理假说（候选解释）

- **H-迁移窗口**：TrayHost 竞争窗以同名 `Shell_TrayWnd` 收编托盘图标（start/stop 广播 TaskbarCreated，`host.ts:157/173`）；广播后图标在两宿主间重注册的瞬态期里，UIA 树登记滞后 → 按钮 Name 瞬态为空。注：交还广播（stop）在全仓无调用方；电池每次 `launchPanel()` 都触发一轮收编广播，P10 导航跑在其前 P8 段重启的面板上。
- **H-Windows 本底**：Win11 26200 XAML 任务栏的 UIA 图标名缓存/延迟本身就有空名瞬态，与面板无关。
- **H-我方图标**：AGENT DECK 图标（Electron 托盘，tooltip「AGENT DECK 独立面板」）在 explorer 真托盘的 UIA 树里 Name 恒空或不登记——签名 C 的末位空步疑似就是它。
- **H-停摆级联**：空名只是 #107 停摆的下游产物，健康面板不复现。

## 3. 实验设计（四臂，预登记）

harness：`uia-tray-forensics.js --arm=all`，臂序固定 baseline → idle → broadcast → relaunch；每轮 Win+B → 稳 1.2s → probe2 全量走满 20 步（步级采 Name/AutomationId/ClassName/hwnd/PID/进程名/ControlType + 前台顶层窗）→ ESC；每轮导航前后对**每一个**在场的 Shell_TrayWnd（explorer 真托盘 + 竞争窗）做按钮级子树 dump。面板以 `--panel-accept` 子进程拉起（stdout 排空，工单132 纪律）、`taskbar.enabled=false`（对齐主电池跑法）、事件 JSONL（boot/tray-host-*/tray-event，带 t）与轮窗对齐。全程经 accept-guard `selftest` 托管。

| 臂 | 轮次 | 构成 | 回答 |
|---|---|---|---|
| baseline | 30 | 无面板裸托盘（前置互斥侦察：Shell_TrayWnd 唯一且属 explorer） | Windows/UIA 本底 |
| idle | 30 | 静置面板，就绪稳 5s 后导航 | 空名是否独立于停摆 |
| broadcast | 20 | 同面板每轮广播 TaskbarCreated 后 150ms 即导航 | 迁移窗口因果（同面板自对照） |
| relaunch | 10 | 每轮重启面板，就绪即导航 | 电池路径（P8 重启→P10）同征 |

统计口径（分析器 `uia-tray-analyze.js`，步级+轮级+树级）：签名分型计数（A/B/C）、步级空名率、轮级空名步出现率、空名观测轮率（步级空名 **或** 树内空名项/末位空名项）、首中率、我方图标在走查/树中的在场率。签名 B 非空名现象（键盘注入面），只计数不归因。

## 4. 预登记判读表（跑前登记，单测锁定）

| 观测组合 | 结论行 |
|---|---|
| baseline 出现空名观测 | **R1-windows-floor**：Windows/UIA 本底存在，空名不（全）是我方产物 |
| baseline 净、idle 出现空名观测 | **R2-independent-of-stall**：空名独立于停摆成立 |
| baseline/idle 净、broadcast 复现 | **R3-migration-window-linked**：收编迁移窗口强相关 |
| 仅 relaunch 复现 | **R4-relaunch-only**：重启专属混杂，需复核 |
| 四臂全零 | **R5-no-repro-fallback**：不直接关票，回 #119 议系统变量轮（explorer 重启/多显/DPI） |

- 优先级自上而下互斥归行；**batteryPathConfirmed** = broadcast 与 relaunch 双复现（P8 重启→P10 导航解释链闭合的标志位，附属于 R3/R4 行）。
- 口径注记：空名观测 = 步级空名 ∨ 树内空名项；签名 B 单独登记不计入。

## 5. 时长与预算

每轮 ≈15s（PS 冷启 2s + Win+B 稳 1.2s + 20 步×0.55s + dump ~2s + 间隔 2s）；净跑 ≈35–40 分钟，guard 槽位预算 45–60 分钟。

## 6. 结果

全量轮：`run-2026-10-10T16-49-39`（guard selftest 托管，四臂连跑 ~40 分钟，退出码 0、终局侦察干净）。

### 6.1 四臂主账（90 轮）

| 臂 | 轮 | 签名分布 | 步级空名率 | 空名观测轮率 | MATCH 率 | 树中我方图标率 |
|---|---|---|---|---|---|---|
| baseline（裸托盘） | 30 | C×30 | 0 | 0 | 0 | — |
| idle（静置面板） | 30 | C×30 | 0 | 0 | 0 | 0 |
| broadcast（广播后即导航） | 20 | C×20 | 0 | 0 | 0 | 0 |
| relaunch（每轮重启面板） | 10 | C×10 | 0 | 0 | 0 | 0 |

- Win+B 前台窗 100% 落 **explorer 真托盘**（90/90，从不落竞争窗）；导航全部正常循环（签名 C 形态＝真托盘序列可导航）。
- **签名 A（全空串）与签名 B（焦点冻住）零复现**；步级、树按钮级空名双口径均为 0。
- 面板在场的全部 60 轮 firstMatch=-1：**AGENT DECK 图标键盘导航不可达、树 dump 不可见**——与 master 2026-10-09 全量电池 P8「已注册但可见区无识别色」+P10 键盘导航 NOT-FOUND 的现行失败同征（`app/accept/evidence/03-battery.log.txt`）。
- 判读归行：**R5-no-repro-fallback**（四臂零空名复现）。

### 6.2 追加诊断（R5 触发 fallback 后的系统级定位）

**① 图标下落——溢出层开箱**（Win+B → ENTER 拨开「显示隐藏的图标」→ dump 浮层）：

- 本机（Win11 26200）溢出浮层顶层窗类名实测为 **`TopLevelWindowForOverflowXamlIsland`**（旧名 `NotifyIconOverflowWindow` 与常见资料名 `...XamlExplorer` 均枚举不到——网上流传类名不可尽信，harness 已带三类名探扫）。
- 浮层 85 个 UIA 条目里：NVIDIA/联想管家/Shadowsocks/PowerToys/Steam/OneDrive 等按名可见；**多枚 `SystemTray.NormalButton` 条目 Name 为空**（空名托盘按钮是本机 Windows 层现实，在场于溢出层而非可见托盘）；**Wallpaper Engine 重复条目 ×18**。
- 全部 dump（可见托盘/溢出层/竞争窗）中**没有任何按名可识别的 AGENT DECK 条目**；UIA 里托盘按钮的进程字段一律报 explorer 宿主，按 exe 归属找图标的方法对托盘按钮失效——空名按钮之一是否为我方图标，UIA 层不可判定。

**② 注册表提升位**（`HKCU\Control Panel\NotifyIconSettings`，纯读）：按**可执行文件全路径**分键——主检出 electron 条目无 `IsPromoted` 值（未提升），`--battery-baseline` 检出条目 `IsPromoted=0`，t119 worktree 的 electron 路径**无条目**。即：**每个检出/worktree 的面板 exe 是独立的提升记忆，且当前均未提升**——图标注册后默认进溢出层。

**③ 竞争窗与事件流**：竞争窗在场全程（keepalive 全 `win:true`，始终是 FindWindow 首个命中），但其 **UIA 树恒为 0 条目**（纯消息接收窗——收编进它的图标在 UIA 世界不存在）；面板侧 tray-event 三轮全零——本取证中从未观测到任何图标进竞争窗。

**④ 工具层**：PS 5.1 的 `FindWindowExW` 枚举**看不见隐藏的竞争窗**，同机同时刻 koffi 通道可见（A/B 对质实证）——托盘窗枚举必须走 koffi 通道；PS 树 dump 的空名口径必须收紧到按钮级条目（结构性容器 Pane/Image 天然无名，粗口径会把 Windows 本底虚构成 100%）。

## 7. 结论与衍生票

**C1（票题主答）空名独立复现性＝否。** 四臂 90 轮零复现（步级/树按钮级双口径）。签名 A（全空串）与签名 B（焦点冻住）是 #107 停摆场的时代产物——停摆根因修复（#132/#137 stdout 排空）后停摆绝迹，空名随之消失；票面「与停摆同场、因果未证」的悬念以「绑定停摆场」收口。溢出层空名按钮虽是 Windows 层现实，但键盘导航永远走不到溢出层，不构成 P10 步级空名来源。

**C2（现行 P10 失败定案）签名 C＝图标不在可见托盘，探针报告的是真实。** 图标按系统提升位管理默认进溢出层（per-exe-path 记忆，当前各检出均未提升）→ 键盘导航对溢出层图标结构性不可达 → NOT-FOUND。P10 断言的前提「图标可见于系统托盘」在 Windows 提升位层面失效——不是面板缺陷、不是探针缺陷、也不是 TrayHost 收编窗口（本轮零收编观测）。历史 P10 绿 ⇔ 当年该 exe 路径提升位为 1；提升记忆丢失/新检出路径无记忆即红。此结论同时解释 master 2026-10-09 电池 P8「已注册但可见区无增量」+P10 NOT-FOUND 同场失败。

**C3（系统级副作用实证）收编广播→响应应用重注册→溢出堆积。** 每次面板启动广播 TaskbarCreated，响应的应用重注册图标；未提升者溢出层堆积（Wallpaper Engine ×18，数量级与面板累计启动次数吻合）。对本票是环境证据，对 TrayHost 是值得评估的降噪项。

**C4（工具层沉淀）** 托盘窗枚举走 koffi（PS 有盲区）；溢出窗类名以实测为准；空名口径按按钮级。harness/探针/分析器已按此固化，判读规则由单测锁定。

**判读表归行：R5-no-repro-fallback**——fallback 条款（回票议系统变量轮）由追加诊断 §6.2 履行完毕（系统变量＝提升位/溢出层，已钉死），无需再加轮。

**衍生票建议**（不在本票实施）：
- **D1**：P10/P8 断言前提加固——导航/识别色断言前先读 `NotifyIconSettings` 提升位并在未提升时给出定向失败语（「图标在溢出层：提升位未置」而非笼统 NOT-FOUND）；或电池环境前置里包含提升位检查。机器态归 #138 域。
- **D2**：TrayHost 收编广播降噪评估（C3 的 WE×18 堆积副作用）。
- **D3**（可选）：若修 `uia-focus.ps1`，采集字段照抄 `uia-probe2.ps1`（hwnd/类名/aid/树 dump）。
