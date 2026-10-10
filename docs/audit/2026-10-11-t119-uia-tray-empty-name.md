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

## 6. 结果（跑后补记）

（待跑：`run-<时间戳>/summary.json` 的 statsByArm 与 verdict 行落此处。）

## 7. 结论与衍生票

（待判读归行后补记。）
