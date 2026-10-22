---
Status: accepted
---

# 最大化收栏的过渡语义：注销 AppBar 释放工作区占位、恢复时重注册重协商（48px 回缩取舍、降级档禁用、与全屏让位的优先级）

背景：spec #236 的四项改版里，第三项是**最大化收栏**——前台窗口真最大化时任务栏自动隐藏并释放工作区占位，最大化窗铺满整屏；屏幕底部各组原位出现**唤出条**，悬停或点击唤出条把该组 pill 以叠加方式弹出在最大化窗之上，窗口不改变尺寸；前台不再最大化时栏回归、工作区占位恢复。

该决策与仓库既有决策的关系须先厘清——全仓有四套方向与机制各异的「让位」语汇，行文勿混：

| 词 | 方向 | 机制 | 出处 |
| --- | --- | --- | --- |
| 全屏让位 | 栏给全屏应用让位 | 条带整窗隐藏（显隐） | ADR-0007 / 工单51 |
| 托盘右键让位 | 条带给应用自带菜单让出 z 序 | 条带临时降非置顶（栏不隐藏、占位不动） | ADR-0013 / 工单194 |
| 最大化让位 | **窗给栏让位** | 工作区占位生效，最大化窗底边停在栏上沿 | ADR-0007 / 51 电池 P2 段标题语境 |
| **最大化收栏**（本 ADR） | **栏给窗让位** | 注销 AppBar 释放工作区占位；栏面退场、唤出条出场 | spec #236 / 本 ADR |

「最大化让位」是 51 电池 P2 段的既有段标题语境，方向与「最大化收栏」**相反**（前者是窗给栏让位，后者是栏给窗让位），不可互代。GLOSSARY 已由工单246 入册「最大化收栏」「唤出条」「最大化让位」「托盘右键让位」四词条。

ADR-0007 立的决策是「注册 AppBar 占住工作区底边，最大化窗口停在栏上方；检测到前台全屏应用时栏自动让位」。**收栏是这条决策在最大化场景下的反面**：它要解除那条占位。占位本身仍是常态语义（visible 态不变），本 ADR 不推翻 ADR-0007，只立「收栏态下释放占位、恢复时重注册重协商」这一例外。它难逆转（AppBar 注册/注销与系统工作区重排是系统级副作用，一旦落地就成为所有最大化场景的既成行为）且有真实取舍（最大化窗此刻回缩 48px 的平台惯常过渡、唤出条的承载窗口形态、真最大化判据的选型），符合入册条件。

## 决策（2026-10-23，用户确认）

1. **收栏与恢复的过渡语义：占位释放 ↔ 重注册重协商。** 三态为 `visible` / `maximize-retract` / `fullscreen-yield`（`BarMode`，`app/src/shared/retract.ts:75`），收栏态的语义是「**工作区占位已释放**」。
   - **收栏**（visible → maximize-retract）：注销 AppBar（`SHAppBarMessage(ABM_REMOVE)`，`app/src/main/taskbar/appbar.ts:69`）→ 工作区占位释放 → 最大化窗铺满整屏 → 栏面退场 → 唤出条出场。
   - **恢复**（maximize-retract → visible）：**重注册 AppBar（ABM_NEW）→ 重协商（`ABM_QUERYPOS` / `ABM_SETPOS`）→ 工作区占位恢复 → 最大化窗回缩 48px**。
   - **次序不可颠倒：先注册再协商。** 释放态下的协商矩形不是条带矩形——未注册时发起协商，系统按当前工作区把提议矩形裁成整屏，条带窗的提议矩形会被整屏矩形写回窗口。实现次序即此约束（`app/src/main/taskbar/window.ts:387-391`）。
   - 判定与动作分居两处、互不越界：`resolveBarMode` 判档（纯函数，`app/src/shared/retract.ts:103`），`planBarTransition` 判动作（纯函数，`:423`），`applyBarMode` 只做效果层动作（`app/src/main/taskbar/window.ts:365`）。
   - 三条不变量（`planBarTransition` 的裁决）：① **占位只在收栏态释放**，其余两态占位必须生效；② **整窗只在让位态退场**，收栏态条带窗在场承载唤出条；③ **同态迁移零动作**（250ms 轮询每拍都过，重复落账会刷爆存证流）。

2. **48px 回缩的取舍：接受恢复瞬间最大化窗回缩 48px。** 工作区重新收缩，最大化窗底边回到栏上沿——平台惯常过渡，spec 用户故事 25 明示接受（「接受最大化窗此刻回缩 48px 的平台惯常过渡」）；栏高 48 DIP 随 DPI 缩放（工单238 回归 Win11 原生 48）。
   - 取舍本质：收栏拿「窗的收益」（铺满整屏）换「栏的一次瞬时形变」。栏面在收栏态不可见，这 48px 回缩发生在用户看不见栏面的时刻——视觉代价低，而收益是 ADR-0007 的「占位与栏严格同矩形」不被破坏（恢复后栏与占位重新同矩形）。

3. **降级档禁用：AppBar 注册失败 ⇒ 收栏整体禁用。** `registerAppBar` 返回 false（`app/src/main/taskbar/appbar.ts:62`）即置 `appBarDegraded` 标记，此后**不重试注册**、**不收栏**，与全屏让位同待遇。理由两条：① 没有占位就没有「释放占位」这回事——收栏动作集的第一步就是注销占位，无占位时整条迁移无从谈起；② 降级档下最大化窗本就覆盖全屏，矩形覆盖判据会把它误判成全屏而触发让位（51 电池既有降级档同款处理）。落点是 `resolveBarMode` 的两道闸门之一（`retractEnabled` 与 `appBarDegraded`，`app/src/shared/retract.ts:110`）；降级档下三态轮询根本不起（轮询只在 AppBar 注册成功档内建立，`app/src/main/taskbar/window.ts:504`）——「无轮询 ⇒ 无收栏」与「有轮询但闸门不过 ⇒ 落 visible」是同一结论的两种实现。

4. **与全屏让位的优先级：全屏让位压过收栏（但不让收栏自造的覆盖翻掉自己）。** 全屏应用在场时条带整窗退场，**唤出条也不出现**；退出全屏回到最大化窗时收栏态自动回来（唤出条随之复现）。
   - **压过收栏**：覆盖主屏但**不上真最大化态**的窗（游戏 / 视频这类真全屏应用）→ 让位档，与收栏开关、降级档无关，收栏不得翻它（穷举矩阵见 `app/tests/taskbar/retract.spec.ts:66-77`）。
   - **唯一例外是收栏自己制造的覆盖**：收栏释放占位后，真最大化窗的底边落到屏底、矩形**正好覆盖整屏**——这条覆盖是收栏的副作用，不是「有全屏应用在场」。故判档次序是「先看**真最大化位**（→ 收栏档），再看**矩形覆盖**（→ 让位档）」，把真最大化窗从「像全屏」里摘出去，免得收栏刚生效就被翻掉（栏隐藏且无唤出条 ⇒ 收栏功能等于没做）。
   - 一句话口径：**「全屏」指有全屏应用在场，不指有窗覆盖整屏**。真最大化窗因此**永不**落让位档；闸门没过时落 visible，不落让位。

5. **真最大化判据选型：`IsZoomed`。** 选 Win32 user32 的 **`IsZoomed(hwnd)`**——单次调用、语义精确、命中即真最大化。
   - 三个候选的裁决：① `IsZoomed`——**选它**；② `GetWindowPlacement`——更重（要 struct、要多次调用、状态位要自己解读），比 ① 多不出精度；③ `WS_MAXIMIZE` 样式位——对 Win11 贴靠（snap）窗与真最大化的语义不一致。
   - **仓库现状**（记此以免后人重复考证；下列基线是**改判据前**的形态）：改判据前全仓搜 `IsZoomed|MAXIMIZE|GetWindowPlacement|WS_MAXIMIZE` 只有一处命中，在**验收侧** `app/accept/battery.js:690-692`（`GetWindowLongW(h, -16) & 0x10000000`）——它读的是样式位、只供全屏判据排除用，**不是**产品判据的先例；产品侧 `app/src/main/win32.ts:13` 已绑 `GetWindowLongW`，但只定义了 `GWL_EXSTYLE = -20`（`:22`），**没有 `GWL_STYLE = -16`**——即产品侧此前根本没有样式位通路，选 `WS_MAXIMIZE` 样式位得先补一条 FFI 通路。（改判据后，产品侧的真最大化判据只有 `IsZoomed` 一处，其余命中皆为注释与测试。）
   - 接线：探针在 `app/src/main/taskbar/yield.ts` 的 `Bound` 增 `isZoomed`（`:58`），`probeForegroundWindow()` 填 `zoomed: Boolean(b.isZoomed(hwnd))`（`:85`）；探针形状 `ForegroundProbe.zoomed` 是**单一来源**（`app/src/shared/retract.ts:44`），主进程侧经 `app/src/main/taskbar/retract.ts` 转发导出，不另写一份实现。
   - 排除族与全屏让位同一套：自家面板进程（`ownPid`）+ 桌面宿主类（`DESKTOP_HOST_CLASSES`：Progman / WorkerW / Shell_TrayWnd / Shell_SecondaryTrayWnd，`app/src/shared/retract.ts:51`）。
   - **已知边界（spec 明确接受）**：少数自绘边框应用最大化不上 IsZoomed 样式 ⇒ 这类窗**不触发**收栏。宁可遗漏，不用矩形法误触发手拉铺满的窗。

6. **「最大化窗不算全屏」这条边界的性质：保住既有语义，不是改方向。**
   - 现行实现下**最大化窗从不触发全屏让位**——`app/src/main/taskbar/yield.ts:16-21` 的既有注释就是这么记的（「最大化窗在 AppBar 占位生效后底边停在栏上方，天然不满足覆盖」）。
   - 收栏**释放**占位后，最大化窗才「看起来」覆盖整屏（底边落到屏底）。加「真最大化窗不算全屏」这条排除，是**把全屏让位的既有语义保住**，**不是**改它的行为方向：判定依据仍是矩形覆盖（`coversScreenRect`，`app/src/shared/retract.ts:63`，容差 `COVER_TOLERANCE = 2`），变的只是**哪些窗进入判据**——真最大化窗被摘出来，免得收栏自己制造出来的「看起来像全屏」把收栏自己翻掉。
   - spec 的 Out of Scope 禁的是「全屏让位**本身的行为变更**」（维持现状：隐藏、无唤出条、250ms 轮询、1 秒内恢复）——本 ADR 那四条一条不动；这条排除只是**收栏释放占位后的副作用防护**。两者不是一回事，不得被读成「改了全屏让位」。
   - 对外措辞口径：**判据没变，变的只是「哪些窗进入判据」**。

7. **唤出条的承载窗口形态：栏窗复用。** 收栏态**条带窗不隐藏**（`planBarTransition` 的 `hideWindow` 只在全屏让位态为真，`app/src/shared/retract.ts:437`）。唤出条在同一条 48px 带内贴屏底绘制、在最大化窗之上、命中区可点；弹出的组落在同一条带内 ⇒ **不改变最大化窗的尺寸**（占位已随收栏释放，弹组不重注册占位）。
   - 几何来源：**渲染层自算**（(b) 方案）——pill 矩形只有渲染层量得到（`measure()`，`app/src/renderer/taskbar.ts:133`），主进程**不回读** `taskbar-geometry` 帧；主进程只下发档位（`taskbar/bar-mode` 事件，载荷 `TaskbarBarModeState { mode, reason }`，`app/src/shared/contract.ts:29`）。渲染层在收栏前缓存最后一帧 pill 矩形（`cacheSummonPills` 在收栏态直接 return、不覆写，`app/src/renderer/taskbar.ts:109-121`）。
   - 置顶纪律：收栏态不改置顶纪律——条带窗仍须压在最大化窗之上（唤出条贴屏底、可见、可点），置顶重申与收栏共存，收栏不另起第二套置顶抑制机制（`app/src/main/taskbar/window.ts:336-340`）。

8. **收栏触发瞬间关闭全部自绘浮层。** 复用 `popupHosts` 单一清单（`app/src/main/taskbar/window.ts:273`，六面自绘浮层的唯一登记处），`close('yield')` 与全屏让位**同口径**。理由：栏面退场后浮层无锚——留孤儿浮层压在最大化窗之上，既无交互入口又挡内容（spec 用户故事 29）。新增菜单面只在清单追加一行，不再两处平行展开防漏。

**备选否决**：

- **「栏不隐藏、只让占位」**——窗铺不满整屏，用户诉求（最大化窗铺到屏幕底边）落空；且栏面与占位脱钩，栏在屏底、窗也铺到底，两者在同一块屏幕上重叠打架。
- **「栏半透明淡出」**——与系统窗口重排打架：淡出是动画，用户的窗口重排是瞬时，两条时间线对不齐；且违反 spec 用户故事 23「收栏、恢复、组收起全部瞬时完成」。
- **「工作区永久让出、栏常驻悬浮」**——占位与栏脱钩，与 ADR-0007 的「占位与栏严格同矩形」相悖；且「最大化窗铺满整屏」与「栏悬在窗上」并存，等于把「窗少 48px 可用区」这个问题换个形态长期留着。
- **`GetWindowPlacement` 真最大化判据**——更重（要 struct、要多次调用、状态位要自己解读），比 `IsZoomed` 多不出任何精度。
- **`WS_MAXIMIZE` 样式位真最大化判据**——对 Win11 贴靠（snap）窗与真最大化的语义不一致；且产品侧当时根本没有样式位通路（`app/src/main/win32.ts:22` 只定义了 `GWL_EXSTYLE = -20`），选它要先补一条 FFI 通路。
- **矩形覆盖法真最大化判定**——手拉四角铺满的窗会误触发（spec 用户故事 26 明令「宁可遗漏，不用矩形法误触发」）；且收栏恰恰要释放占位让窗覆盖整屏，用覆盖法判收栏等于自证循环。
- **唤出条用独立窄窗承载**——① 要多一扇窗、多一套置顶/穿透/热区基建，且与既有浮层宿主的「失焦即自关」纪律（`app/src/main/taskbar/popup.ts:191`）冲突：承载窗一旦失焦就自关，直接摧毁「离开后 400ms 宽限才收起」的语义；② 独立窄窗与条带窗不同坐标系，唤出条与 pill 的 1:1 镜像要跨窗对账；③ 弹出的组要落在窄窗内就得改窄窗高度，改的又正是「不改变最大化窗尺寸」这条稳定诉求。

## Consequences

- 状态面：新增三态 `BarMode`（`visible` / `maximize-retract` / `fullscreen-yield`）与档位下发事件 `taskbar/bar-mode`（载荷 `TaskbarBarModeState { mode, reason }`，`app/src/shared/contract.ts:29`）；决策逻辑集中在单一纯函数域模块 `app/src/shared/retract.ts`（`resolveBarMode` / `planBarTransition` / `planSummonStrips` / `reduceSummon`），主进程侧只转发导出（`app/src/main/taskbar/retract.ts`），渲染层与主进程共用同一份实现、不许各判一次。
- 存证族：新增 `taskbar-retract` / `taskbar-retract-lifted`（与既有 `taskbar-yield` / `taskbar-yield-lifted` 同族，`BarEvidenceEvent` 四元组，`app/src/shared/retract.ts:384`）；AppBar 侧沿用既有 `taskbar-appbar-registered` / `taskbar-appbar-removed` / `taskbar-appbar-register-failed`。**事件面 notify 名与 `taskbar-geometry` 字段保持则事件断言可存活**（ADR-0013 的经验）——新增存证名 `taskbar-retract` / `taskbar-retract-lifted` 要与既有 49/51 电池的段级断言一并点名，不得静默改名。
- 验收电池按章法（ADR-0011、`docs/agents/battery-governance.md`）动断言：
  - **49-taskbar**：P13（栏高与图标尺寸段）随 48 DIP / 图标 24 / 格 36 / 托盘 16 的新口径重写；P15（栏分组布局重排）与 P15B（屏幕中心线锚定）随栏高口径动；唤出条交互新段（悬停 150ms 弹出、点击立即、400ms 宽限收起、按组独立、浮层钉组）。
  - **50-taskbar-carry**：栏高段随动（A1 接管开启等段落的条带落位口径）。
  - **51-taskbar-appbar**：新增收栏段——注销 → `SPI_GETWORKAREA` 还回整屏 / 恢复 → 回缩 48 / 三态优先级（全屏压收栏）/ 降级档禁用。
  - **55-taskbar-right-group**：新增托盘 16px 与溢出菜单行 16px 断言。
- 与 ADR-0007 的关系：不推翻其「注册 AppBar 占住工作区底边」——那是常态（visible 态）语义；本 ADR 只立收栏态下释放占位这一例外及其恢复路径（重注册 + 重协商）。
- 多显示器仍出界（ADR-0007 既定，仅主屏）；真最大化判据的已知遗漏（自绘边框应用最大化不上 IsZoomed 样式）按 spec 接受，不在本 ADR 追补。
