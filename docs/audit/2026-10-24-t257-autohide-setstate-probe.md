# 工单259 spike 取证：`ABM_SETSTATE(ABS_AUTOHIDE)` 能否释放原生任务栏 48px 保留带（#257 裁决闸门）

> 2026-10-24，本机真机实测（Win11，主屏 2560×1440 物理像素，DIP 缩放 1.0，**单屏**）。
> 探针（仓外一次性取证件，不入库）：`D:\test-folder\t257-probes\probe-autohide-setstate.js`（迭代 1，原版一字未动）
> 与 `D:\test-folder\t257-probes\probe-autohide-setstate-out.js`（迭代 2，仪表修复版，见「探针迭代留痕」）。
> 一律经 `accept-guard` 托管执行（`guard.mjs hold --as zcode --purpose accept-sprint -- node <probe>`），
> 槽位排队 0；guard 清各检出面板进程后探针 preflight 自检「原生栏可见（面板不在场）」通过。

## TL;DR

- **阳性**。四项通过判据全 PASS：`SW_HIDE(Shell_TrayWnd)` + `ABM_SETSTATE(ABS_ALWAYSONTOP|ABS_AUTOHIDE)`
  组合让 shell **释放了原生任务栏的 48px 保留带**——工作区底边 **1392 → 1440（屏底）**，
  最大化参照窗贴屏底，`StuckRects3\Settings` 字节三点全等（置位不回写注册表），复原完全可逆。
- ⇒ #257 裁决「第三条路」的核心命题在本机成立，#258（原生栏托管）按 spike 闸门放行实施。
- 观察项 6（Win 键闪现）：保持期内合成 Ctrl+Esc（Win 键等效）打开开始菜单，探针 200ms 可见性轮询
  **0 帧** + 两张截屏（菜单开/收）屏底均无原生栏——**SW_HIDE 的原生栏在 autohide 置位态下按 Win 不闪现**。
- 观察项 5（副屏）：本机单屏，无 `Shell_SecondaryTrayWnd` 可观察（环境背景 PowerShell `AllScreens` 实测）。
- **探针迭代留痕**：迭代 1（原版）全部 RECT 出参读数 `undefined`——koffi 2.16.3 对无 `_Out_`
  注解的结构体指针出参不做原生→JS 回写（探针伪因，非系统行为）；迭代 2 仅给两处签名加 `_Out_`
  （t250 探针同技术，见 `t250-probes/probe-native-appbar.js:35,38`），测量逻辑零改动，读数恢复完整。

## 环境与前提

| 项 | 值 |
|---|---|
| 屏幕拓扑 | 单屏 DISPLAY1（主屏 2560×1440，物理像素，PER_MONITOR_AWARE_V2） |
| 面板在场 | 否（guard 清场 + 探针 preflight 自检 `Shell_TrayWnd` 可见通过；两轮同） |
| 基线 appbarState | 0（无 autohide / always-on-top 位；两轮同） |
| 基线工作区 | `{0,0,2560,1392}`（原生栏单独占底边 48px，与 t250 基线一致） |
| 基线 `Shell_TrayWnd` | 可见，矩形 `[0,1392] → [2560,1440]`（与保留带同矩形） |
| 置位序列 | `SW_HIDE` → `ABM_SETSTATE((0 & ABS_ALWAYSONTOP) | ABS_AUTOHIDE)`，保持 30 秒，`ABM_SETSTATE(0)` + `SW_SHOW` 复原 |

## 探针迭代留痕（仪表修复，t250「探针迭代留痕」先例）

**迭代 1（原版 `probe-autohide-setstate.js`，只读未动）**：
- 现象：`GetWindowRect` / `SPI_GETWORKAREA` 全部读数 `undefined`（`矩形=undefined,undefined → undefined,undefined`、
  `工作区底边=undefined`）；判据 1/2/4 因读数缺失无法判读（比较式退化为 `undefined >= 1438` → FAIL，是仪表失效不是测量结论）；
  判据 3 的 reg 字符串比对不受影响，PASS。
- 根因（最小复现坐实）：koffi 2.16.3（`app/node_modules/koffi`）只对带 `_Out_` 注解的指针参数做调用后回写——
  `RECT *` 无注解 → 传参后对象保持 `{}`；`_Out_ RECT *` → 回写 `{0,0,2560,1392}`。
  t250 探针正是用 `_Out_` 注解（`probe-native-appbar.js:35,38`）取到全部实测值的。
- 该轮另录得可见帧数 146/150（**未按任何键**）——见观察项 6 附记。

**迭代 2（`probe-autohide-setstate-out.js`）**：原版逐字副本，仅
`GetWindowRect(void *hwnd, _Out_ RECT *rc)` 与 `SystemParametersInfoW(..., _Out_ RECT *pvParam, ...)`
两处签名加 `_Out_`；置位/保持/复原/判据计算全部零改动。判读以迭代 2 为准。

## 实测数据（迭代 2，全部本机实测值，非推断）

| 观测 | 值 | 说明 |
|---|---|---|
| 基线工作区底边 | **1392** | 原生栏单独占 48px（t250 同款基线） |
| 基线 appbarState | 0 | 无 autohide |
| `SW_HIDE` + 置位后 appbarState | 1 | `ABS_AUTOHIDE` 生效（读回） |
| **置位后工作区** | **`{0,0,2560,1440}`（底边 1440=屏底）** | **保留带释放** |
| 保持期末工作区底边（30 秒后复查） | 1440 | 置位态稳定，非瞬时 |
| 参照窗 `t257-probe-ref` 最大化矩形 | `[-8,-8] → [2568,1448]`（底边 1448） | 2560×1440 屏的标准最大化几何（8px 装饰边）；客户区底 = 1448−8 = **1440 = 屏底** |
| `StuckRects3\Settings` 字节（基线/置位期/复原后） | **三点全等**（reg query 输出字符串级比对） | `ABM_SETSTATE` 置位/复原**不回写**注册表 |
| 复原（`ABM_SETSTATE(0)` + `SW_SHOW`）后 | 工作区底边 **1392**、appbarState **0**、原生栏**可见** | 完全回基线 |
| 探针退出后独立复查（另行 koffi 直读，非探针自证） | 工作区 `{0,0,2560,1392}`、栏可见=true、state 0；`StuckRects3\Settings` 现值在案 | 系统态干净，无残留 |
| 副屏 `Shell_SecondaryTrayWnd` | 基线=[] 置位=[] | 单屏环境，无观察对象 |

## 判据汇总（探针输出原文，迭代 2）

```
[1] 核心命题（置位后工作区底边 1392→1440）: PASS（基线 1392 → 置位 1440）
[2] 参照窗最大化底边≈工作区底边(±8): PASS（窗底 1448 / 工作区底 1440）
[3] StuckRects3 字节基线/置位期/复原后三点全等: PASS
[4] 可逆性（复原后工作区回基线±2、状态复原、栏可见）: PASS（1392 vs 1392, state 0 vs 0）
[5] 副屏观察: 基线=[] 置位=[]
[6] Win 键闪现观察: 可见帧数=0（0=未闪现或未按 Win；>0 且有按=闪现坐实）
```

判据 [2] 附注：窗底 1448 与工作区底 1440 差 8px，恰为最大化窗口的 8px 装饰边
（矩形 `-8,-8 → 2568,1448` 是 2560×1440 屏的标准最大化几何）；客户区底边=屏底=1440，±8 容差内 PASS。

## 观察项（只记录不裁决）

**[5] 副屏**：本机单屏（`[System.Windows.Forms.Screen]::AllScreens` 仅 `\\.\DISPLAY1`，主屏 2560×1440），
无 `Shell_SecondaryTrayWnd` 枚举项，探针基线/置位两读均为空。多屏副作用（#258 Further Notes 未证实点③）
本机无可观察对象，留待实施期多屏环境。

**[6] Win 键闪现**：保持期 11:32:21–11:32:51（探针日志「>>> 保持 30 秒」行锚定）内合成按键，看门日志时间戳为证：
- 11:32:36.117 `SendKeys('^{ESC}')`（Win 键等效）发送成功；11:32:39.441 `SendKeys('{ESC}')` 收菜单（按键后 3 秒，对齐工单口径）。
- 探针 200ms 可见性轮询：**整个保持期 0 帧**（`IsWindowVisible(Shell_TrayWnd)` 恒 false，含开始菜单打开期间）。
- 截屏甲（11:32:37.9，菜单开）：开始菜单在场（搜索框/Pinned/All 列表/用户角），**屏底无任何原生任务栏**。
- 截屏乙（11:32:41.1，Esc 后）：开始菜单已收，最大化参照窗 `t257-probe-ref` **完整铺满到屏底**（无栏、无 48px 空隙）。
- ⇒ **按 Win（Ctrl+Esc 等效）不使 SW_HIDE 的原生栏闪现**：轮询计数与截屏互证。
- 附记（跨轮差异，如实记录）：迭代 1 **未按任何键**时可见帧数 146/150——同置位序列下 explorer 曾在约 0.8 秒内
  恢复窗口 `WS_VISIBLE` 位（autohide「滑出屏」态的窗口位标记，窗口本体不在视觉场）；迭代 2 同序列为 0 帧。
  `WS_VISIBLE` 位在置位时序下**非确定**，但两轮均无任何「视觉在栏」证据（迭代 2 截屏铁证）。
  面板实施期注意：看门狗哨兵若以 `IsWindowVisible` 为准，该位语义是「窗口显示位」≠「视觉在场」
  （与本仓既有「发现可见即再压」哨兵的判据选择相关，供 #258 实施参考）。

## 裁决链

- **#250**（2026-10-23 取证，`docs/audit/2026-10-23-t250-native-taskbar-reserved-band.md`）：原生 48px 保留带
  由 shell 自算、不在 AppBar 登记表内；`ABM_REMOVE` / 空矩形 `ABM_SETPOS` / `SW_HIDE` 均不释放；
  `ABM_SETSTATE(ABS_AUTOHIDE)` 当时**未测**（以正撞 C1 纪律未实验即挡下）。
- **#257**（2026-10-24 用户裁决，grilling 两轮定案）：走**第三条路**——收栏态临时置位 `ABS_AUTOHIDE`，
  原生栏维持 SW_HIDE；spike 先行闸门，阳性关票、证伪回票重裁 A/B。
- **#258**（spec，承接实施）：原生栏托管。spike 四判据 + 两观察即本票所出；阳性 ⇒ 按 #258 放行。
- **#259（本票）**：四判据全 PASS ⇒ **阳性**。#257 关票与 #258 并流由编排执行（本票不开 PR 不关票）。

## 结论

**阳性**：`SW_HIDE` + `ABM_SETSTATE(ABS_AUTOHIDE)` 组合在本机让 shell 释放原生任务栏 48px 保留带
（工作区底边 1392→1440=屏底，保持 30 秒稳定），最大化窗贴屏底（客户区底=屏底）；
`StuckRects3\Settings` 置位期与复原后字节全等（不回写注册表，C1「生命周期结束后字节复原」口径天然满足）；
退出置位即完全复原（工作区/状态/可见性三复原，探针退出后独立复查无残留）。

#258 Further Notes 三大未证实点收口：① `ABM_SETSTATE` 是否回写注册表——**不回写**（判据 3 实测三点全等）✓；
② Win 键闪现——**不闪现**（观察 6：0 帧 + 截屏无栏）✓；③ 副屏副作用——本机单屏**无观察对象**，
如实留白，多屏验证属实施期验收面（#258 用户故事 14 本期只承诺主屏）。
