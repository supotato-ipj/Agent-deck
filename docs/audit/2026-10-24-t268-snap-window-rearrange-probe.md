# 工单268 取证：双 Snap 窗在工作区释放后是否被 Windows 自动重排（#269「补齐高度」路径的裁决闸门）

> 2026-10-24，本机真机实测（Win11，主屏 2560×1440 物理像素，DIP 缩放 1.0，**单屏**）。
> 探针（仓外一次性取证件，不入库——t250/t257 先例）：`D:\test-folder\spec267-notes\t268-probe\probe-t268-snap-rearrange.js`
> 与看门狗启动器 `probe-t268-launch.js`（完整运行日志 `run-final.log`，逐拍数据 `..\t268-probe-results.json`）。
> 一律经 `accept-guard` 托管执行（`guard.mjs hold --as zcode --purpose accept-sprint -- node <启动器>`），
> 全程不裸跑、不拉真面板；preflight 自检「面板不在场」（DECK-TASKBAR 窗缺位 + 原生栏可见）通过。

## TL;DR

- **阴性（无需主动补齐高度）**。三轮释放/恢复全一致：释放我方 AppBar 占位并进入原生栏托管后，
  **Windows 自动把左右双 Snap 窗重排到新的工作区底边**——窗底 1399 → **1447**（= 屏底 1440 + 7px DWM
  不可见边，与最大化窗的标准几何同构），水平几何分毫不动（纯高度延展），**真 Snap 状态
  （IsWindowArranged）三轮六次迁移零丢失**；恢复占位后系统又自动反向收缩回 1399，Snap 依旧保持。
- ⇒ **#269 不需要「受约束补齐高度」路径**：Snap 窗与最大化窗一样跟随工作区变化自动重排，
  生产可继续信赖平台自带的 reflow（ADR-0015 已明示接受「平台惯常过渡」的同一机制）。
  实现票的落点回到会话裁决本身（IsWindowArranged 探针 + resolveBarMode/planBarTransition），
  不新增任何改窗逻辑（也再次确认 spec 用户故事 32「禁几何兜底」的可行性）。
- 无空白（底边空白 = −7px，即窗边越屏底 7px 恰为 DWM 不可见边）、无重叠（水平接缝 14px =
  两侧各 7px 不可见边，客户区严丝合缝）、无退出 Snap。

## 环境与前提

| 项 | 值 | 说明 |
|---|---|---|
| 屏幕拓扑 | 单屏 DISPLAY1（2560×1440，PER_MONITOR_AWARE_V2） | 与 t250/t257 同机同屏 |
| 面板在场 | 否（guard 清场 + preflight DECK-TASKBAR 缺位 + 原生栏可见） | 两轮核对 |
| 基线 appbarState | **1（已含 ABS_AUTOHIDE）** | ⚠️ 与 t250/t257 基线 0 不同，见「环境异常记录」 |
| 基线工作区 | `{0,0,2560,1440}`（屏底） | autohide 已释放原生保留带 |
| 基线 Shell_TrayWnd | 可见，矩形 `[0,1438] → [2560,1486]` | 停放在屏外（autohide 泊位，仅 2px 悬边） |
| 参照窗 | 自建两扇 WS_OVERLAPPEDWINDOW 顶层窗（STATIC 类，无属主） | 标准普通顶层窗；Snap 由系统执行 |
| Snap 建立方式 | 合成 Win+Left / Win+Right 键（系统通道，非窗口移动接口） | 键盘和弦一次成功（via=keyboard-1） |
| 真假 Snap 判据 | `IsWindowArranged(hwnd)` | 域笔记 §5 本机实证该 API 可绑定可用 |

**与生产一致的释放/恢复序列**（逐调用形态复刻，非重写）：

| 步骤 | 生产对应 | 复刻要点 |
|---|---|---|
| 前态：SW_HIDE(Shell_TrayWnd) | 工单50 `hideNativeTaskbar`（window.ts create 序 `:553`） | t250 取证：不改工作区，仅复刻前置可见性账 |
| 前态：注册 AppBar | `registerAppBar`（appbar.ts:77）+ `stripPhysRect`（window.ts:81，TASKBAR_HEIGHT=48） | ABM_NEW，宿主窗为**真实尺寸**的底边 48px 通栏窗（t250 阳性对照：0×0 窗不落保留带是伪因） |
| 前态：协商 | `negotiateAppBarPos`（appbar.ts:96） | ABM_QUERYPOS→ABM_SETPOS，**照生产常量值 3→2**（#251 在案缺陷，勿顺手修） |
| 释放① | `applyBarMode` ② `removeAppBar`（window.ts:461-464 → appbar.ts:87） | ABM_REMOVE + 零矩形 |
| 释放② | `applyBarMode` ②′ `engageRetractAutoHide`（window.ts:482 → appbar-autohide.ts:59-83） | 记 previous → `SETSTATE((prev & ABS_ALWAYSONTOP) \| ABS_AUTOHIDE)` → 读回裁决（retractAutoHideState，shared/retract.ts:419） |
| 恢复① | `applyBarMode` ② claimAppBar（window.ts:465-473） | ABM_NEW + 重协商 |
| 恢复② | `applyBarMode` ②′ `restoreRetractAutoHide`（window.ts:483 → appbar-autohide.ts:116-153） | `SETSTATE(previous)` + 生产退避表（native-restore.ts，40ms…1.28s）重试至读回一致 |
| 收尾 | `destroy` 序（window.ts:511-544） | 托管复原 → 可见性复原 → ABM_REMOVE |

**与生产的两处已声明偏差**（均非系统状态输入）：① 不写 appbar-ledger 落盘账（工单261 的面板内部
持久化记账，探针进程不得触碰面板 userData）；② 不起原生栏重申轮询（工单262 的韧性机制——观察期
稳定性由探针逐拍记录覆盖，三轮 2.5s+ 稳定窗均无回翻）。

**探针不调用任何窗口移动接口**（无 SetWindowPos/MoveWindow/SetWindowPlacement）；两参照窗的几何变化
全部由系统执行（Snap 和弦与工作区 reflow）。`SetForegroundWindow`/按键合成只涉焦点与输入。

## 实测数据（三轮全一致，全部本机实测值）

占位在场态（释放前，三轮同）：

| 观测 | 值 |
|---|---|
| 工作区 | `{0,0,2560,1392}`（我方 48px 带在场；原生带已由基线 autohide 释放） |
| 左窗矩形 | `[-7,0] → [1287,1399]`，客户区即 `[0,0]→[1280,1392]`（恰为半工作区） |
| 右窗矩形 | `[1273,0] → [2567,1399]`，客户区即 `[1280,0]→[2560,1392]` |
| 真 Snap | L=true R=true（IsWindowArranged） |

释放后（ABM_REMOVE + SETSTATE，每轮稳定值）：

| 观测 | 值 | 说明 |
|---|---|---|
| 工作区 | `{0,0,2560,1440}` | 释放后首拍（≤127ms）即到位 |
| 左窗底边 | 1399 → **1447** | = 屏底 1440 + 7px DWM 不可见边；释放后 ~170-310ms 内直接跳变，无中间态 |
| 右窗底边 | 1399 → **1447** | 同上；**水平几何不动**（left/top/right 分毫不变，纯高度延展） |
| 真 Snap | **true / true（保持）** | 含迁移瞬间在内的每一拍都为 true |
| 底边空白 | **−7px**（窗边恰越屏底 7px = 不可见边） | 无空白 |
| 水平接缝 | L.right − R.left = **14px**（两侧各 7px 不可见边，客户区贴合） | 无重叠、无缝隙 |
| 重排触发时序 | 工作区先动（首拍 ≤127ms），窗随动（次拍，≤310ms） | 系统主导的 reflow，非动画残留（2.5s+ 稳定窗 + 三轮复现） |

恢复后（ABM_NEW+协商 + SETSTATE(previous)，每轮稳定值）：

| 观测 | 值 |
|---|---|
| 工作区底边 | → **1392** |
| 双窗底边 | → **1399**（~170ms 内反向收缩，水平几何依旧不动） |
| 真 Snap | **true / true（保持）** |

跨轮与收尾：

| 观测 | 值 |
|---|---|
| 三轮间补 Snap 次数 | **0**（六次释放/恢复迁移 Snap 状态零丢失，resnap 全为 already） |
| SETSTATE 复原 | restored=true tries=1（读回即一致，每轮） |
| C1 纪律 | **StuckRects3\Settings 全程字节不变**（基线/终检比对） |
| 终检（探针外独立直读） | 工作区 `{0,0,2560,1440}`、state=1、原生栏可见=true，与基线逐项相等；无遗留窗口/AppBar 登记 |

## 环境异常记录（如实）

1. **基线 appbarState=1（ABS_AUTOHIDE 已在位）**，与 t250/t257（10-23/10-24 上午）的基线 0 不同。
   定谳尝试：面板落盘账（userData/appbar-ledger.json）**缺位**；StuckRects3\Settings 的 flags
   DWORD（offset 8）= 0x02，与社区文档的 03/07 解码不吻合（Win11 布局存疑——同 blob 的 0x14-0x24
   处 48/1392/2560/1440 恰为任务栏高度与停靠矩形，佐证偏移布局但无法反解 autohide 位）；时间线：
   面板 17:32 被 guard 清场击杀、~17:39 有部署员重部署相位注记、userData 内面板文件 18:47 仍有写入、
   19:08 起无面板进程。**来源无法定谳（用户偏好 vs 击杀遗留），探针不擅动该位**。
2. **处置**：按生产一等情形继续——`engageRetractAutoHide` 对「用户本已开启自动隐藏」明文不特判
   （appbar-autohide.ts:9-11：置位为无操作、记账照走、复原照走）。本形态下 SETSTATE 为无操作
   （target=1，读回=1），**工作区触发量由我方 AppBar 占位注销独立供给**：基线 1440（原生带已
   autohide 释放）→ 注册我方 48px 带 → 1392 → 注销 → 1440。与基线-0 生产形态的 delta **同量（48px）
   同沿（底边）同时序**（基线-0 时该 delta 全由 SETSTATE 贡献——t257 取证；我方带的注销在基线-0
   下不产生工作区变化——t250 取证）。Snap 窗 reflow 是窗口管理器对工作区变化的响应，与本测得结论
   的传导一致；**基线-0 形态的复测留待该位回到 0 后可顺手补做**（不阻塞本票定谳）。
3. **首跑卡死与看门狗**（探针迭代留痕，t250/t257 先例）：迭代 1-3 为仪表修复（koffi 函数签名须用
   注册类型名；TranslateMessage 无 W 变体）。迭代 4 裸跑（无看门狗）在**活跃用户桌面**上焦点竞逐
   致同步 FFI 分钟级阻塞（Snap L 耗 202s 成功、Snap R 停滞 >10min，进程 CPU 0.42s/14min=原生阻塞
   而非循环），TaskStop 击杀后环境逐项核对回基线（无遗留窗/登记，state=1 未动）；同会话
   keybd_event 独立诊断 3ms 健康（阻塞为情境性）。迭代 5 加**建窗即焦点**（避开 SetForegroundWindow
   竞逐）、键盘和弦主/拖拽手势兜底、外部看门狗（心跳停搏 150s 击杀+最小复原），26s 全绿跑完。
   附：TaskStop 连 guard.mjs 一并击杀会跳过租约释放，guard 的挂死接管（心跳 TTL 3min）在下一轮
   hold 自动接管，无需人工 force-release。

## 判据汇总（探针输出原文）

```
[1] 释放触发量: 工作区底边 1392 → 1440（屏底=1440）
[2] 双窗底边: L 1399 → 1447；R 1399 → 1447
[3] 真 Snap 保持: L arranged true → true；R true → true
[4] 底边空白（屏底−双窗底边最小值，含 7px DWM 不可见边几何）: -7px
[5] 双窗水平接缝（L.right−R.left，≈14=贴合（两侧 7px 边）>14=重叠 <14=空隙）: 14px
[6] 反向（恢复后）: 工作区底边 → 1392；L.bottom → 1399；R.bottom → 1399；arranged L=true R=true
[7] 全轮一致性: 真 Snap 保持=true 双窗贴屏底(含边±9)=true
```

## 结论与裁决链

- **#269 裁决输入**：**无需主动补齐 Snap 窗高度**。释放（注销+托管）后 Windows 自动把双 Snap 窗
  延展到新工作区底边（纯高度、无水平扰动、真 Snap 保持），恢复后自动反向收缩。不存在空白/重叠/
  退出 Snap 三种失败形态中的任何一种。#269 及后续实现票**不得**新增改窗逻辑（spec 用户故事 32
  「禁几何兜底」）；「最大化窗铺满整屏」的平台 reflow 语义可安全外推给 Snap 窗——这正是本票票面
  「不把最大化窗的既有行为外推给 Snap 窗」要求实证的命题，今以双 Snap 窗真机三轮实证。
- 边界（如实）：单屏、缩放 1.0、STATIC 类标准顶层参照窗（无自绘边框类应用的边界形位未测）、
  基线 autohide 在位形态（触发量由我方占位注销供给，见环境异常记录 2）；多副屏与每显示器会话
  隔离属 #270/#271 实现面。
- 裁决链：t250（原生保留带 shell 自算）→ t257（SW_HIDE+SETSTATE 释放保留带）→ **t268（本票：
  保留带释放后 Snap 窗自动 reflow 且状态保持——「收栏对 Snap 窗也兑现」的最后一环实证）** →
  #269 按此结论走「无补齐」路径实施。
