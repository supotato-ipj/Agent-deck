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

- 实现落点（工单260，最小闭环）：FFI 面 `getAppBarState` / `setAppBarState`（`app/src/main/taskbar/appbar.ts`）；纯函数域 `ABS_AUTOHIDE` / `ABS_ALWAYSONTOP` / `retractAutoHideState` 与 `planBarTransition` 两旗帜（`app/src/shared/retract.ts`，单测覆盖 `app/tests/taskbar/retract-orchestration.spec.ts`）；效果层 RAII 账本 `engageRetractAutoHide` / `restoreRetractAutoHide`（`app/src/main/taskbar/appbar-autohide.ts`）；挂点 `applyBarMode` / `destroy`（`app/src/main/taskbar/window.ts`）；退避裁决 `planAppBarStateRestore`（`app/src/main/taskbar/native-restore.ts`）。
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
