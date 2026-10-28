---
Status: accepted
---

# 原生栏托管：收栏态临时置位 ABS_AUTOHIDE 释放 shell 保留带（出路 A / B / 第三条路的取舍、C1 纪律口径修正）

背景：ADR-0015 的补记（工单252 事实更正，2026-10-23）落定——**最大化收栏**注销的只是我方那一份 AppBar 登记，原生任务栏那 48px 保留带由 shell 自算、不在 AppBar 登记表内，收栏态最大化窗底边停在栏上沿、**不铺满整屏**（spec #236 用户故事 10 半兑现、11 未兑现，判为产品级缺口），承诺口径**列为待用户裁决**，出路两条：A 收窄 spec 承诺 / B 放开 C1 纪律（允许面板把原生任务栏切自动隐藏）。

**关键事实更正（#257 explore 复核）**：工单250 取证从未测过 `ABM_SETSTATE(ABS_AUTOHIDE)`——该路径当时以「正撞 C1 红线」未实验即挡下，保留带在 auto-hide 态下是否释放**从未被本机证伪**。外部研究（`research/win11-hide-taskbar.md`）：Win11 24H2/25H2 上 `Shell_TrayWnd` 外层容器类名仍有效，thide 蓝本即 SW_HIDE + ABS_AUTOHIDE 组合。

**用户裁决（#257，2026-10-24，grilling 两轮问答定案）**：A / B 均不取，走**第三条路**——收栏态下临时置位 `ABS_AUTOHIDE`（原生栏维持 SW_HIDE），收栏退出 / 面板退出即复原；裁决附带闸门 **spike 先行**，证伪则回票重裁 A/B。spike（工单259）四判据全 PASS 阳性：置位后工作区底边 **1392 → 1440（屏底）**、最大化参照窗客户区贴屏底、`StuckRects3\Settings` 字节基线/置位期/复原后**三点全等**（置位**不回写注册表**）、复原完全可逆；观察项 Win 键不闪现（0 帧 + 双截屏）、副屏本机单屏无观察对象。取证归档 **`docs/audit/2026-10-24-t257-autohide-setstate-probe.md`**。

## 决策（2026-10-24，#257 用户裁决；工单260 落地最小闭环）

1. **第三条路：收栏态临时置位，与收栏同生命周期。** 进入收栏时 `ABM_GETSTATE` 记录原生栏原 appbar 状态 → `ABM_SETSTATE` 置 `ABS_AUTOHIDE`（保留 `ABS_ALWAYSONTOP` 位，目标值出自纯函数 `retractAutoHideState`，`app/src/shared/retract.ts:419`）→ shell 释放保留带；退出收栏复原原状态。置位/复原挂进三态机的 `planBarTransition`（`engageAutoHide` / `restoreAutoHide` 旗帜，`app/src/shared/retract.ts:494-495`），与占位注销/重注册**严格同拍**（效果层 `app/src/main/taskbar/window.ts:425-426`）——非收栏时段（窗口未最大化）系统行为与现状完全一致，auto-hide 不被置位；这正是它对出路 B 的本质区别（B 是常驻置位）。
   - **RAII 记账（thide 蓝本）**：模块级单账 `engaged`（`app/src/main/taskbar/appbar-autohide.ts:30`——appbar 状态是会话级事实，与哪扇条带窗现任无关）；置位成败以**读回事实**裁决，未生效则不记账（无复原义务，账不许凭空欠出）；待决复原重试被新一次置位作废（分叉账纪律，快速退收栏/再收栏不串账）。
   - **koffi 绑定**：`ABM_GETSTATE(4)` / `ABM_SETSTATE(10)` 官方值与最薄封装（`app/src/main/taskbar/appbar.ts:28-29,127-134`，探针同款形态）；`APPBARDATA.lParam` 携带状态位，结构不变。#251（SETPOS/QUERYPOS 常量写反）保持独立缺陷票不并入。
   - **用户本已开启系统自动隐藏**：置位为无操作（`retractAutoHideState` 结果不变）、记账照走、复原照走，逻辑不特判。
2. **C1 纪律口径修正：「全程字节不变」→「面板生命周期结束后字节复原」。** 50-taskbar-carry 的 C1 段实现本就是 `StuckRects3\Settings` 的**首末两点比对**，旧措辞「全程字节不变」与实现对不齐；收口为「面板生命周期结束后字节复原」（措辞落点 `app/accept/taskbar-carry.js:340-345`）。spike 判据 3 实测 `ABM_SETSTATE` 置位/复原**不回写注册表**（三点全等），该口径在原生栏托管下天然满足——用户任务栏偏好不被永久改写（spec #258 用户故事 8）。
3. **不新增还原路径：复原走既有还原账。** 已落地的是**还原路径①**（面板侧退避重试）：读回不一致按 native-restore 的同一张退避表重试（有限次、终局有界，timer unref 不吊住进程退出；裁决函数 `planAppBarStateRestore`，`app/src/main/taskbar/native-restore.ts:89`，与可见性复原同表同形决策面）；收栏态下面板退出/禁用/退役经 `destroy` 同路复原（`app/src/main/taskbar/window.ts:458`，51 电池 P9 断言）。死路径兜底与重建对抗**已随本分支落地**（2026-10-24 按本 ADR 文末自立规矩原地回改本节，按建成事实记）：死路径②③（外层守卫 before-quit/panel-exit、guard-dead 还原守护）所需的原状态**落盘记账**（`app/src/main/taskbar/appbar-ledger.ts`——置位生效即 fsync 落盘，复原到位/终局失败即清账，守卫/守护经 `restoreAppBarStateFromLedger` 消费）归 #261（727b429）；explorer 重启/显示器热插拔的重挂（压回 SW_HIDE + 重申收栏态置位）由**原生栏重申轮询**承担（`app/src/main/taskbar/native-watch.ts`，收栏态 1s 低频拍；票面措辞「看门狗」按 GLOSSARY 退役词条规避改称）归 #262（ec8f4b0）。
4. **开关与降级：托管与收栏整体同开关。** 降级档（AppBar 注册失败）与 `taskbar.maximizeRetract=off` 下 `resolveBarMode` 两道闸门永不进收栏档 ⇒ 不置位（ADR-0015 决策 3 同款待遇）；全屏让位期间不收栏故不置位（全屏态优先级最高）——**例外（工单271）**：分屏会话存续的全屏让位期间**托管不中断**（占位保持释放、置位不复原、重申轮询值守随工作区收栏账持续重挂），退出覆盖后分屏收栏直接恢复；无分屏会话时本句逐字不变。50 电池 C2 段断言 off 不置位（`app/accept/taskbar-carry.js:349-353`，config 全程钉 `maximizeRetract=false`）。
5. **两笔账各自独立：可见性账（SW_HIDE）与 appbar 状态账（SETSTATE）。** `ShowWindow` 与 appbar 状态是两个系统事实，模块各自记账、各自复原、互不代偿（`appbar-autohide.ts` 模块头注纪律）；原生栏在托管期间维持既有 SW_HIDE 不可见，spike 观察项 6 证 Win 键不闪现。
6. **多屏边界：系统级状态、只承诺主屏。** `ABM_SETSTATE` 是系统级状态、主副屏同生效；本期只承诺主屏工作区释放，副屏 `Shell_SecondaryTrayWnd` 不 SW_HIDE、维持现状（spike 单屏无观察对象，副屏副作用留实施期多屏验收面，spec #258 用户故事 14）。

**备选否决**：

- **出路 A（收窄 spec 承诺）**——零技术成本，但用户要的「最大化窗铺满整屏」落空，spec #236 用户故事 10/11 被收回；产品价值放弃。
- **出路 B（常驻放开 C1，常驻切自动隐藏）**——shell 确实会放掉保留带，但**常驻**置位意味着非收栏时段系统行为也变（与本决策「非收栏时段与现状一致」的诉求正面对撞）；且永久改写用户任务栏偏好 ⇒ 50 电池 C1 断言必红、须全量重写，原生栏滑入时还与面板条带抢同一块地需另做让位/叠放。
- **对原生栏句柄发 `ABM_REMOVE` / 空矩形 `ABM_SETPOS`**——工单250 已实测不释放（保留带不在 AppBar 登记表内），此路在取证阶段即被否决。
- **面板改前台窗几何（收栏时把最大化窗拉到屏底）**——越过 Win32 最大化语义、与应用窗口管理互搏（#257 已排除）。
- **注入类方案（Windhawk / ExplorerPatcher）**——攻击面与维护负担过大，仅作边界条件参考（spec #258 Out of Scope 明列）。

## Consequences

- 实现落点（工单260，最小闭环）：FFI 面 `getAppBarState` / `setAppBarState`（`app/src/main/taskbar/appbar.ts`）；纯函数域 `ABS_AUTOHIDE` / `ABS_ALWAYSONTOP` / `retractAutoHideState` 与 `planBarTransition` 两旗帜（`app/src/shared/retract.ts`，单测覆盖 `app/tests/taskbar/retract-orchestration.spec.ts`）；效果层 RAII 账本 `engageRetractAutoHide` / `restoreRetractAutoHide`（`app/src/main/taskbar/appbar-autohide.ts`；函数名后随全接管期改组——`*Retract*` → `*Takeover*` 并新增 enter/clear 两动作，现名见文末修订记落地状态）；挂点 `applyBarMode` / `destroy`（`app/src/main/taskbar/window.ts`）；退避裁决 `planAppBarStateRestore`（`app/src/main/taskbar/native-restore.ts`）。
- 存证族新增 `taskbar-autohide-set` / `taskbar-autohide-set-failed` / `taskbar-autohide-restored` / `taskbar-autohide-restore-failed`（`app/src/main/taskbar/appbar-autohide.ts`）——与既有 `taskbar-yield` 族同款纪律：notify 名保持则事件断言可存活，不得静默改名。
- 验收电池按章法（ADR-0011、`docs/agents/battery-governance.md`）动断言：**51 电池 P6/P7 改段**（收栏态不变式改写「工作区底边 = 屏底 ±2」+ 参照窗铺满整屏 ±8——旧「底边 ≥ 屏底−48」是保留带被认定不可释放时代的口径，spike 取证背书改段）＋ **新增 P9**（收栏态面板正常退出 → 可见性与 appbar 状态双复原，路径①）；**50 电池 C1 措辞收口**「面板生命周期结束后字节复原」＋ **新增 C2**（maximizeRetract=off 不置位）。
- 领域语言：GLOSSARY 入册「原生栏托管」（_Avoid_: 自动隐藏、任务栏隐藏），「最大化收栏」「工作区占位」词条的交叉引用同步收口；ADR-0015 文末补记的「待用户裁决」标记按本裁决摘除（本 ADR 即其裁决记录）。
- spec #236 正文不改——承诺口径维持原文，本决策是兑现手段而非改写承诺（工单252 补记既定边界维持）。
- 与 ADR-0015 的关系：不推翻其收栏过渡语义（占位登记释放 ↔ 重注册重协商）；本 ADR 只补上其补记留下的「保留带谁来放」这一环。其决策 2/4/6 与备选否决中以「释放占位 ⇒ 最大化窗铺满整屏」为前提的表述，随本决策落地恢复为本机现状（收栏态）。
- 死路径兜底（#261，727b429）与重申轮询（#262，ec8f4b0——票面措辞「看门狗」按 GLOSSARY 退役词条规避改称「原生栏重申轮询」）已随本分支落地；本 ADR 决策 3 的「未落地」注记已按本节自立规矩于 2026-10-24 **原地回改**（未另开口径）。

## 修订记（工单271，2026-10-24：分屏会话存续的全屏让位期间托管不中断）

**修订对象**：本 ADR 决策 4 的旧绝对表述「全屏让位期间不收栏故不置位（全屏态优先级最高）」——它隐含「让位 ⇒ 置位复原」，对分屏收栏不成立。spec #267 裁决：分屏会话拥有**工作区收栏理由**、全屏让位只拥有**栏面呈现**；分屏会话存续的全屏让位期间，托管随工作区收栏账**延续**（置位不复原、重申轮询继续值守——覆盖期间 explorer 重启/置位丢失也须重挂，否则原生保留带复活、后台 Snap 窗被顶起变尺寸，违反工单271 验收判据）。条件边界：仅「分屏会话存续且过共用开关/降级两道闸门」时适用；无分屏会话时旧句逐字不变（50 电池 C1/C2、51 电池 P6/P7/P9/P10 不回归）。

**机制落点**：值守判据从「档位 = maximize-retract」改为「工作区收栏账 `workspaceRetracted` 在账」（效果层 `app/src/main/taskbar/window.ts` 逐笔维护；裁决上下文与理由持有归 `app/src/shared/retract.ts` 的 `BarTransitionContext` / `retractReasonHeld`）。置位/复原的交割时机不变——仍与占位注销/重注册严格同拍（工单260 语义未动），只是「占位注销状态」不再等价于「档位在收栏」。

**取舍记录**：覆盖期间值守多跑 1s 低频观察拍（覆盖下可见性/置位读数正常即零动作），成本可忽略；账面跨覆盖延续使 RAII 账（engaged.previous）生命周期覆盖全屏让位期——复原目标仍是用户的原 appbar 状态，不受覆盖进出影响。

## 修订记（工单293，2026-10-26：托管扩为全接管期——双缺陷复审 Q1/Q2 落地，按建成事实记）

**裁决与修订对象**（spec #292，ADR-0016 修订记 2026-10-25 双缺陷复审 Q1=A / Q2=A）：托管从「收栏态临时置位、与收栏同生命周期」扩为**全接管期**——条带窗创建即建立接管（记用户原状态一次 → 落盘记账 → 压当前档位目标态），条带窗销毁才退场写回原值。修订决策 1 的「与收栏同生命周期」、决策 3 的「置位生效才记账」（改为**接管建立即记账**——清位已动系统状态，复原义务自接管开始成立）、决策 4 的「off/降级档下不置位」（收窄为**只关收栏档**：普通档的清位与值守照走，50 电池 C2 口径同步收窄——收栏置位零条 + restored 仅退场复原两径）。旗标改名：`restoreAutoHide` → `clearAutoHide`（旧「复原用户原值」语义作废，新语义「退回清位目标」；用户原值只在退场复原）；新增纯函数 `normalBarAutoHideState`（清位目标：清 AUTOHIDE、留 ALWAYSONTOP），与 `retractAutoHideState` 同源派生（GLOSSARY 新增**清位**词条）。重申轮询扩为全接管期（起表随接管建立、停表随拆场；目标档位由工作区收栏账派生 `autohide-on|off`；归因 `autohide-lost` → `autohide-mismatch`）；新增存证 `taskbar-autohide-takeover` / `-cleared` / `-clear-failed`（既有族保留原义）。

**落地状态：已实施、真机出证**（2026-10-26，本节按建成事实原地回改；工单294/296/295 并流后终态）：
- 单账/清位/收栏置位/重申机器/接线：`app/src/main/taskbar/appbar-autohide.ts`（engage/enter/clear/reassert/restore 五动作 + 单账——收栏置位 `enterRetractAutoHide`、退收栏回落 `clearRetractAutoHide` 与清位同走一份账，普通↔收栏只换目标、不重记原值（工单294）+ 退避窗防投毒）、`app/src/shared/retract.ts`（三目标态纯函数 `normalBarAutoHideState` / `retractAutoHideState`）、`app/src/main/taskbar/native-watch.ts`（两档目标）、`app/src/main/taskbar/window.ts`（create 接管即起表、destroy 先状态后可见性）。离线 2302/2302 绿（四票终态）。
- 真机：51 电池 accept-sprint 出证轮 **PASS 17/0**（P6/P7 清位口径改段读回无 AUTOHIDE 位 + P6 进收栏读回含 AUTOHIDE 位、退收栏清位落定后 2s×150ms 采样窗零可见拍（工单294 读回双面）、P9 扩臂 B 普通态退出双复原、P10 判据改全接管期值守 + 拍 B 义务面/接受面拆分（shell ABM 接受窗尾部 52–66s 观测入环境账 explorer-acceptance-tail，面板义务面逐拍重试不断流）、**新增 P15 普通态清位与三路径禁现**——底边悬停 3.5s/Win 键零可见帧、通知路径如实记未观察、禁用后读回复原）；50 电池 **PASS 11/0**（A2/A3/A4 收栏态退场复原不回归 + A5/A6/A7 普通态出发三径——复原义务覆盖全接管期（工单296）、C1 字节复原、C2 收窄口径绿）。
- 几何（决策 4 域）：进出收栏双复核（`retract-enter` / `retract-exit` 宿主矩形复核）；条带净空改锚**降级账面**（`applyDegradedClearance`，视图位瞬态不再写几何账）——真机实证收栏置位翻开的 WS_VISIBLE 位会经 display-metrics/ABN 通路把协商账带偏一身高（R7-R10 磁带），健康档条带恒贴屏底；复核判据后抽纯函数 `recheckStripHostRect`（底边 vs 物理屏底 ±1 DIP、DIP 域语义，离线 9 例）、applyBarMode 接线顺序钉「预隐藏 → 置位 → 复核」、51 电池 P6/P11 挂 enter/exit 双相位复核断言（出证轮四相位全 verified、宿主底边偏 0px、五组唤出条存证落点贴屏底）（工单295）。

**取舍记录**：全接管期使清位/值守在普通档常开（每秒一拍观察 + 收栏进出各一次 SETSTATE，常态零动作成本可忽略）；清位本身是对用户自动隐藏偏好的**运行期**改写（退场按账复原，C1 字节口径不受影响——SETSTATE 不回写注册表，spike 既证）。

## 修订记（2026-10-25，当前转向 ManagedShell 侧车预研）

用户在后续 Q1–Q26 路线复审中确认：当前暂停自研注入器实施，改以 **ManagedShell C# 侧车 + 现有 Electron UI** 做逐能力、可丢弃原型；保留 Explorer，不同时运行第二套 Cairo 任务栏。这是对当前实施顺序的调整，不是对注入技术的永久否决，也不是正式生产架构裁决。

原生栏全路径禁现、全接管期状态托管与稳态/启动期零帧目标均未降低。侧车只推进 ShellFolders、图标、原生 Shell 菜单、变更通知与故障恢复验证，**不得记作原生栏双缺陷或零帧目标的完成证据**。原型晋级后才另行形成正式 ADR、产品接缝与验收决策；本注记不表示产品代码已改变。

## 修订记（工单308，2026-10-28：M1 覆盖式普通档——托管改恒置位单账、AppBar 占位链退役，spec #306）

**裁决与修订对象**（spec #306，用户经 grill 流程逐项定案 M1 方案）：spec292 部署后出现主诉体验缺陷——任意应用的后台最大化窗口在前台被普通窗口夺走时，自绘栏弹出常驻 + 该最大化窗被压矮 48px（档位裁决落普通档 → 清位收回保留带的工作区签名）。经两轮代码取证定性为**按设计行为**（非实现走样），修复属设计修订：**普通档自绘栏改覆盖式常驻**——托管期任务栏 auto-hide **恒置位**、48px 保留带**恒释放**，自绘栏覆盖在窗口之上，托管期间任何窗口尺寸永不被改变（已知代价：普通档常驻时后台最大化窗底边约 48px 被栏遮挡，尺寸不变、仅遮挡——用户拍板接受；ADR-0015 决策 2 口径同步收窄为仅退场瞬间）。修订决策 1/4 的「接管即清位 / 普通档清位目标」（`normalBarAutoHideState` 与 `taskbar-autohide-cleared` 存证族退役）与本 ADR 既有修订记的「占位注销 ↔ 托管置位严格同拍」「收栏置位/退收栏清位」叙事——**运行期 appbar 状态写入归零**：进出收栏/让位零置位/注销/协商（`planBarTransition` 收敛为栏面计划，`BarTransitionContext`/`retractReasonHeld`/`retractGateDisqualified` 退役），AppBar 注册/注销/位置协商/ABN 重协商调用点与降级档机制整体退役（占位与覆盖物理互斥：占位必收回保留带、必挤压最大化窗）。重申轮询目标态简化为恒 `autohide-on`（`NativeWatchWant` 退役）；1s 值守与 SW_HIDE 压回义务照旧；退场三层复原用户原值照旧（48px 回缩只剩退场瞬间）。接管建立=置位一次（`engageTakeoverAutoHide` SET `retractAutoHideState`）、退场写回一次，auto-hide 单账保持最简形态；`taskbar-autohide-set`/`-set-failed` 事件族由 engage 复用。本修订同时取代 ADR-0007 的 AppBar 工作区占位机制（ADR-0007 正文不改，以本修订记为准）。

**落地状态：已实施、真机出证**（2026-10-28，工单308 单 PR 分层落地）：
- 源码：`app/src/shared/retract.ts`（BarModeInput 去 appBarDegraded、闸门只剩共用开关；迁移计划收敛为栏面四字段 hideWindow/showWindow/closePopups/evidence）、`app/src/main/taskbar/appbar-autohide.ts`（恒置位单账：engage 置位 / restore 写回 / reassert 恒置位，enter/clear 与档位账退役）、`app/src/main/taskbar/native-watch.ts`（poll 单参恒置位）、`app/src/main/taskbar/window.ts`（无注册无协商无降级档、三态轮询无条件起、托管建立置位一次）、`app/src/main/taskbar/appbar.ts`（收口为 GETSTATE/SETSTATE 单职责，注册/协商/回调面整体删除）。
- 单测 2274 断言全绿（retract / retract-orchestration / appbar-autohide-ledger / native-watch 随动改写锁 M1 语义）。
- 真机：51 电池 **PASS 17/0**（P8 降级档禁用段特征退役；P16 新增覆盖式主诉专项段——后台最大化窗+普通窗夺前台 3s 逐拍采样矩形逐点不变+零拍动；P10b/P10c explorer-acceptance-tail 环境降责 EXENV 在案；P13 一轮红二轮绿按 flaky 流程定谳抖动）、50 电池 **PASS 11/0**（C2 改「每次接管生命周期恰两次状态写入」计数式——off 只关收栏档、托管恒置位）。
- 几何（决策 4 域）：进出收栏双复核（retract-enter/exit）与 `recheckStripHostRect`/`stepHostRectSettle` 随触发前提消失整体特征退役——壳侧挪移的两大来源（AppBar 重协商、SETSTATE 收栏过渡）在 M1 不复存在，几何漂移兜底归 keepalive `reassertGeometry`；条带恒贴屏底（净空/降级几何随降级档退役）。

**取舍记录**：① 恒置位把自动隐藏协议的唤出通路重新武装（旧清位把它关掉）——禁现面由 SW_HIDE + 1s 值守承担（t257 spike：SW_HIDE+置位态按 Win 0 帧不闪现；51 电池 P15 悬停 3.5s/Win 键零可见帧实证）；② 保留带恒释放 = 普通档常驻时后台最大化窗底边 48px 被栏**遮挡**（尺寸不变、仅遮挡）——换「任何窗口尺寸永不被托管改变」的在案代价；③ 存证族随栏面收敛（retract 族不再随工作区面——覆盖进出 retract↔yield 各落一条）——51 电池 P14 改段锁新语义；④ 主诉行为 b（切回最大化窗偶发不收）另开观察票 #307，M1 已消灭其 FFI 阻塞根源候选，部署后实测定谳。
