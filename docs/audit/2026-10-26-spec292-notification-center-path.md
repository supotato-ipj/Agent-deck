# 工单292 F3 取证：面板接管+清位在场下 通知中心（Win+N）通路——原生栏零可见帧（spec #292 验收判据⑤）

> 2026-10-26，本机真机实测（Win11，主屏 2560×1440 物理像素，DIP 缩放 1.0，**单屏**）。
> 探针（仓外一次性取证件，不入库，t257 先例）：`D:\test-folder\spec292-probes\probe-notification-center.js`
> （复用仓内 `app/accept/lib/` 的 win32/panel-control/event-tape/battery-config，观测逻辑自含）。
> 一律经 `accept-guard` 托管执行（`guard.mjs hold --as zcode --purpose accept-sprint -- node <probe>`），
> 全部四轮排队 0；guard 清各检出面板进程后探针 preflight 自检「原生栏可见（面板不在场）」通过。
> 证据（节拍 JSONL/事件档/面板子进程归档/摘要 JSON/文本 log）落仓外
> `D:\test-folder\spec292-probes\evidence\`；本文只引关键读数（文本审计链口径，截图 PNG 不入库）。

## TL;DR

- **阳性**。四项预告判据全立：受控原值（自动隐藏 ON）下面板接管+清位在场
  （takeover userState=0x1 + cleared 存证 + 落盘账在 + 读回无 AUTOHIDE 10ms）时，
  合成 Win+N 打开通知中心——NC CoreWindow（`ShellExperienceHost` 承载
  `Windows.UI.Core.CoreWindow`）**200ms 出现、376ms 前台命中**（cloaked=true，
  非激活开出形态），**150ms 采样窗 37 拍 + 在场保持段 19 拍全部零可见帧**
  （`Shell_TrayWnd`（explorer 属主）`IsWindowVisible` 口径，同 51 电池 P15）；
  Esc 收起后 1.5s 采样仍零帧；通路全程接管+清位保持（appbar 0x0 无 AUTOHIDE、账在盘）；
  复原四件全净（restored reason=disabled、读回 0x1、账清、config 三态还原、原生栏回场、工作区回基线）。
- ⇒ spec #292 验收判据⑤「时钟格→通知中心」系统 UI 通路的**原生栏抑制面**坐实：
  通知中心开出期间原生栏无一帧回场。时钟格→动作的**产品回执面**由 55 电池 P3 覆盖
  （时钟格点击 → `taskbar-action-result action=notification-center ok`），动作→表层的
  按键真源同一（见「通路拆解」）——两段证据合起来即完整通路。
- **环境前提（重要）**：NC 表面在本轮之前处于卡死态（面板 chord 与探针 chord 均无任何
  表面产生，见「探针迭代留痕」）——**壳表一刷新**（P10 同款 Stop-Process + AutoRestartShell，
  面板不在场时做）后 NC 表面恢复健康，首轮尝试即坐实。在此类陈旧 shell 机器上该通路
  会呈现「回执 ok 而无表面」的环境形态（55 电池 P3 最近一轮 FAIL 同签名），取证前刷新
  shell 是可重复触发的前提步骤。

## 环境与前提

| 项 | 值 |
|---|---|
| 屏幕拓扑 | 单屏 DISPLAY1（主屏 2560×1440，物理像素，PER 盘 DPI 感知由探针 `SetProcessDPIAware` 保证） |
| 面板发射形态 | `--panel-accept`（绕单实例锁）+ `DECK_CDP_PORT`（51 电池登记端口，仅备禁用复原径） |
| config 前置 | `patchTaskbar({enabled:true})`（工单124 三态契约；发射前打补丁、收尾按原文还原） |
| 受控原值 | `appbarState = 0x1`（保留 ALWAYSONTOP、置 AUTOHIDE——清位对它是有动作的，同 P15） |
| 接管+清位坐实 | takeover 存证（userState=0x1）+ cleared 存证（reason=takeover）+ 读回无 AUTOHIDE **10ms** + 落盘账在盘 |
| 接管态视图事实 | `Shell_TrayWnd` hwnd 0x301a6（explorer 属主）显示位**不在场**（SW_HIDE 托管）；工作区底边 1392（面板 appbar 占位带在场） |
| 观测判据 | `nativeTaskbarVisible()` = explorer 属主 `Shell_TrayWnd` 的 `IsWindowVisible` 显示位；150ms 拍距逐拍采样，任何一拍可见=可见帧（口径同 P15 底边悬停/Win 键两路径；「显示位 ≠ 视觉在场」既有口径） |
| 触发 | Win+N 和弦**一次 SendInput 提交**（产品同款：`src/main/taskbar/syskeys.ts sendSystemAction` 的 chord 形态——分拍多次提交系统不认，49 首跑同坑） |

## 探针迭代留痕（四轮，全部 guard 托管 accept-sprint；环境稳定性风险的实证链）

1. **R1（14:09，失败——config 缺补）**：条带窗 12s 缺席，探针中止。根因：运行时
   `app/config.json`（gitignore）`taskbar.enabled=false`（前任轮次留下的状态；51 电池开跑
   会 `patchTaskbar({enabled:true})` 自补，仓外探针此前漏了这步）——面板桌面窗正常
   （desktop-rendered 在流）而条带窗随 config 建缺。修复：探针补 battery-config 三态
   （快照→patch→收尾还原），同电池契约。
2. **R2（14:14，失败——NC 表面无响应）**：状态构造全真（接管+清位 6ms），但 Win+N
   四次分拍 SendInput 无任何表面。判读：分拍提交是**仪表缺陷**（系统不认），非系统结论。
3. **R3（14:17，失败——NC 表面卡死坐实）**：R2 修复后（和弦一次提交，产品同款）仍零
   新窗（`freshWindows=[]` 任何类名）——`ShellExperienceHost` 进程在场（14:04 explorer
   重启时重生）但表面僵死：和弦被接受、表面不出。**55 电池 P3 最近一轮 FAIL 同签名**
   （合成回执 ok=true 而前台/表面全无）——本机 shell 表面的环境形态，非面板回归。
4. **R4（14:22，成功——本案）**：探针加「⓪ 壳表一刷新」（P10 同款：Stop-Process explorer
   → AutoRestartShell 归位 → 新 `Shell_TrayWnd` 显示位回场，面板不在场时做，无 rebuild
   复杂度；appbar 原值在刷新后读，复原目标随之修正）——刷新后首轮 Win+N 即坐实（本局
   全部实测数据）。appbar 原值刷新前后一致（0x0），复原不受影响。

## 实测数据（R4，全部本机实测值，非推断）

| 观测 | 值 | 说明 |
|---|---|---|
| ⓪ 壳表一刷新 | 旧窗退场=是、新窗归位=是（AutoRestartShell，无自起兜底）、显示位回场=是 | P10 同款程序；刷新后 appbar 读回 0x0（注册表原态复活） |
| 受控原值置位 | 0x1，23ms 读回 | 清位的有动作前提（同 P15） |
| 面板 boot | pid=39464，条带窗在场 | `--panel-accept` + config patch enabled |
| 接管+清位 | takeover userState=0x1 + cleared（reason=takeover）+ 读回无 AUTOHIDE **10ms** + 账在盘 | 状态构造坐实 |
| 接管态视图 | `Shell_TrayWnd` hwnd 0x301a6 显示位不在场；工作区底边 1392（appbar 带） | SW_HIDE 托管在场 |
| **NC 出现** | **200ms**（`CoreWindow`/`shellexperiencehost`，cloaked=**true**） | 非激活开出形态（55 P3 代码注记同形态）；`GetForegroundWindow` **376ms** 命中同一 hwnd |
| **NC 在场采样** | **37 拍 × 150ms 零可见帧** | 采样窗自和弦发出起算（含开出动画期）；双坐实+≥6s 提前收窗 |
| **在场保持段** | **19 拍 × 150ms 零可见帧** | 命中后追加 3s——「开着」期间零帧稳定，非一闪而过 |
| NC 之外新窗（诊断面） | textinputhost CoreWindow ×3、explorer `ApplicationFrameWindow` ×1，**全部 cloaked** | NC 开出期壳侧浮层均为遮挡态，无一携 `Shell_TrayWnd` 回场 |
| Esc 收起 | 前台让出（收后前台=Progman 桌面），关闭后 1.5s 采样零帧 | 无残留浮层 |
| 通路后接管保持 | appbar 0x0（AUTOHIDE 位不在场）+ 账在盘 | 通知中心开出/收起全程接管+清位不被扰动 |
| 复原径 | `taskbar/set-enabled false`（CDP）→ restored reason=disabled（attempts=2）+ 读回 0x1（40ms）+ 账清 + 面板 graceful-gone | 同 P15 禁用复原路径① |
| 复原收尾 | config 三态还原（1506B 原文写回）+ appbar 0x0（24ms）+ 原生栏显示位回场 + 工作区回基线（1392） | 实验扰动零残留 |

## 判据汇总（探针输出原文）

```
[1] 通知中心在场坐实: PASS（CoreWindow shellexperiencehost @200ms + 前台命中 @376ms，cloaked=true）
[2] 在场采样窗原生栏零可见帧: PASS（37 拍 + 保持段 19 拍全零——150ms 口径同 P15）
[3] 通路前后接管+清位在场保持: PASS（appbar 无 AUTOHIDE + 账在盘 + 条带窗在场）
[4] 复原干净: PASS（restored reason=disabled + 读回 0x1 + 账清 + config 还原 + 原生栏回场 + 工作区回基线）
核心成立=[1]且[2]（探针退出码 0）
```

## 通路拆解（证据分工）

spec 验收判据⑤的「时钟格→通知中心」通路由两跳构成，证据分列：

1. **时钟格→动作**（产品面）：面板渲染层时钟格点击 → `taskbar-action-result
   action=notification-center ok` 回执——55 电池 P3 在证（历史轮 PASS 出证：前台
   ShellExperienceHost CoreWindow 命中）。
2. **动作→表层→原生栏抑制**（系统面，本文）：动作的按键真源是 `syskeys.ts
   sendSystemAction('notification-center')` 的 Win+N 一次 SendInput 和弦——探针用**同一
   和弦**从控制器侧直发，在「面板接管+清位在场」状态下观测表层开出（200ms）与原生栏
   抑制（零帧）。两段证据合起来即完整通路；本文补的正是此前「未观察」的那半边。

## 观察项（只记录不裁决）

- **非激活开出（cloaked=true）**：NC CoreWindow 以 DWM cloak 态开出且 `GetForegroundWindow`
  命中——「回执 ok 而前台断言不收敛」的 55 P3 已知形态在本文口径下的补全：表面**确实
  在场**（IsWindowVisible 位在场、前台归属命中），只是以遮挡态呈现。对「原生栏抑制」
  判据无影响（判据只看 `Shell_TrayWnd`）。
- **NC 表面卡死的环境形态**：陈旧 shell 下和弦被接受而表面不出（R3，`freshWindows=[]`
  铁证）；壳表一刷新即愈。电池侧若未来要给该路径加自动化断言，须以此为前提设计
  （刷新步骤的代价与 P10 同档）——本票不加段（任务书明裁：环境稳定性风险 vs 证据单列）。
- **单屏**：本机单屏，多屏形态无观察对象（同 t257 口径，如实留白）。

## 结论

**阳性**：面板接管+清位在场时，通知中心经 Win+N 开出（200ms 表面、376ms 前台，
非激活 cloak 形态），全程原生栏零可见帧（150ms 口径 56 拍含保持段），接管+清位不被
扰动，复原四件全净——spec #292 验收判据⑤「时钟格→通知中心」系统 UI 通路的三路径
禁现面（底边悬停/Win 键在 51 电池 P15 在证，通知路径由本文单列补齐）**全部有证**。

spec Further Notes 的验收判据⑤自此从「未观察」收口为「有证单列」：51 电池 P15 的
`rep.note` 改为引用本文（不加断言段、est 不动——清单标题与段内断言面不变，通知中心
UI 自动化的环境稳定性风险由探针迭代留痕一节实证）。
