# 工单163 取证报告：托盘点击回放断链——packTrayClick 回调负载语义错（②坐实）

- 日期：2026-10-11
- 工单：[#163](https://github.com/supotato-ipj/Agent-deck/issues/163)（spec #154 ⑧，结论供 ⑨=#164 修复票直接消费）
- 取证代码：`app/accept/experiments/tray-replay-forensics.js`（df80b6c 起，fce5055/d1b5445 修正；**产品代码零改动**，`git diff 851d8d5 -- app/src` 为空）
- 判读素材：`D:\test-folder\.agent-notes\t163-tray-replay-forensics\`（panel-events.jsonl / harness-log.json / registry.json，不进仓库）
- 真机轮：两轮全经 accept-guard 托管（`hold --as zcode --purpose accept-sprint`，均退出码 0、无残留条带；第一轮暴露 harness 读窗缺陷，第二轮为判读轮）
- 对照文档：[NOTIFYICONDATAW (shellapi.h)](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/ns-shellapi-notifyicondataw) uCallbackMessage 备注（2026-10-11 拉取原文）

## 1. TL;DR：断点在哪一层

**断点 = 假设②（回调负载语义错），且只断在这一处**：数据面托盘宿主的点击负载合成纯函数
`packTrayClick`（`app/src/main/trayhost/protocol.ts:289-320`）把 **v0（未协商版本）回调的 wParam/lParam 整体互换**：

| | wParam | lParam |
|---|---|---|
| MSDN 口径（v0） | **图标 uID** | **鼠标消息**（WM_LBUTTONUP / WM_RBUTTONUP…） |
| 产品现行（protocol.ts:314-319） | 鼠标消息（WM_RBUTTONUP=0x0205） | uID |

应用读 lParam 取事件 → 读到的是一个小整数 uID → switch 无命中 → 静默忽略。这就是「左键右键都完全没反应」的全量主因。真机 A/B 对照（§4 P3）：同一图标同一目标窗，产品形态负载全哑，MSDN 形态负载**当场响应**（联想电脑管家弹窗 ×2、PowerToys 弹出标准 #32768 菜单）。

三假设判别结论：

| 假设 | 判别 | 关键证据 |
|---|---|---|
| ①回调投递被系统拒收 | **不成立** | P1 全量 23 次真实回放 `posted=true`（3 次另有 miss，见③）；P3 harness 侧 9 臂全部 `posted=true`，无一 `GetLastError` 拒绝记录 |
| ②回调负载语义错 | **坐实（主因）** | P3 三真实第三方样本 A/B：lenovotray、PowerToys 产品形态 0 响应、MSDN 形态即响应；代码直读与 MSDN 原文逐字段对不上（§5 四处偏差） |
| ③条目登记缺失 | **非主因（少数派在案）** | 25 条栏内条目 23 条登记齐备（hwnd/uid/version/callbackMessage 全字段留档）；2 枚 miss（Windows 安全中心、耳机，均 explorer 系统图标）＝登记在场但 callbackMessage=0——tooltip 更新类流量、本无回调可回放，属 spec user story 33 既定的「如实不可交互」少数派 |

**链路其余各层全通**（P2 端到端存证，§4）：真实鼠标点击条带图标 → 渲染层 DOM handler（`taskbar-tray-click`）→ 桥 invoke 回执 ok → 服务护栏通过 → 数据面宿主 `tray-replay` posted=true → `tray-replay-result` ok=true——事件链完整在场，唯一缺的是目标应用的行为。用户的投诉被精确复现。

**版本分布**：两轮登记全量 `version=0`（判读轮 23/23；首轮抽样 10/10）。收编（TaskbarCreated 广播）触发的重注册潮里，本机图标群无一向宿主重协商 NIM_SETVERSION——**v4 分支在今天的主机上等于死代码**，但其负载布局同样错（§5-2），修 #164 时必须一并修对（版本协商是动态的，别的机器/未来的应用会走到）。

## 2. 回放链路全貌（读码结论，取证对象定位）

```
渲染层 taskbar.ts makeTrayEl 点击/右键 handler
  → window.deck.bridge.invoke('taskbar/tray-click')          [P2 事件存证 ✓]
  → services/bridge.ts → services/taskbar.ts trayClick（栏内名单护栏 ✓）
  → panel-kernel replayTrayClick → services/dataplane.ts postMessage
  → 数据面子进程 dataplane.ts 'tray-replay' → TrayHost.replay（host.ts:320-338）
      ├ 条目登记 entries 查表（缺失/无回调 → 'tray-replay-miss'）      [③证据面]
      ├ GetCursorPos → packTrayClick 合成负载（protocol.ts:301-320）   ★断点在这
      ├ AllowSetForegroundWindow(entry.hwnd)                           ★传参错位（§5-4）
      └ PostMessageW(entry.hwnd, message, wparam, lparam) → posted     [①证据面]
```

断链不涉及渲染层、桥、服务编排与进程间协议——它们在本轮全部被真机事件流证明工作正常。

## 3. 实验设计（harness 五相，可复跑）

`node accept/experiments/tray-replay-forensics.js`（app/ 下，先 `npm run build`；真机轮经 guard）：

| 相 | 手段 | 回答 |
|---|---|---|
| P0 拉起 | `--panel-accept` + DECK_EVENT_LOG/CDP（t142 同款），taskbar.enabled 覆写 true，稳 6s 收编 | 现场就位 |
| P1 链路+登记全量 dump | CDP 于条带页逐 key invoke `taskbar/tray-click`（右键，≤25 条）；读事件流 `tray-replay`（含 hwnd/uid/version/message/wparam/lparam/posted 全字段）与 `tray-replay-miss`（known 计数）；每拍后探 #32768 菜单/新窗/前台 | ①投递返回值、③登记内容、版本分布 |
| P2 真实点击复现 | CDP 取样本图标 CSS 矩形 → GetWindowRect 换算屏坐标（scale=物理宽/innerWidth，实测=1）→ SetCursorPos 稳 350ms（条带默认鼠标穿透，热区 25ms 轮询开门）→ SendInput 左/右单键单击 | 用户端到端复现 + 全链存证 |
| P3 负载 A/B(/C/D) 对照 | 同一样本同 hwnd，harness 侧 koffi 直投：A=产品 packTrayClick 忠实复刻；B=MSDN 口径（v0: wp=uid/lp=msg；v4: wp=MAKELONG(x,y)/lp=(事件<<16)\|uid，右键 WM_CONTEXTMENU）；C=v4 布局对但右键仍 WM_RBUTTONUP；D=左键只修排布不修常量（0x0203 归因）。每臂前 SetCursorPos 到条带图标位取锚点、投前 AllowSetForegroundWindow 留档 | ②判别主证 + #164 修复范围 |
| P4 判读 | 汇总 verdict.json | 数据驱动，最终归因本报告 |

行为 oracle 三路：目标 pid 的 #32768 菜单窗 / 新可见顶层窗 / 前台切换；每臂后 ESC 清菜单。

## 4. 证据（判读轮 = run 第二轮）

### P1 登记与投递全量（25 条栏内条目逐条右键回放）

- **23/25 `tray-replay` posted=true、version=0**，负载形态逐字段符合产品 v0 分支（wparam=517=0x0205、lparam=uid，留档见 harness-log `P1-row`）。**全部 0 响应**（无菜单/无新窗/无前台切换）。
- 2/25 `tray-replay-miss known=26`：Windows 安全中心（guid:ba82e2dc）、耳机（guid:7820ae73）——均 explorer 系统图标；栏内名单与登记同源同流（host.ts remember 与服务 applyTrayEvent 消费同一事件流），栏里在而登记缺的唯一自洽解释是**登记在场但 callbackMessage=0**（这些图标只发 tooltip 更新类 NIM_MODIFY，不带 NIF_MESSAGE）。首轮的 Weixin miss 在第二轮变为登记齐备——miss 集合随收编时序漂移，但始终 ≤2 且都是系统图标。
- 第三方样本在装且登记齐备（本轮实测）：联想电脑管家(lenovotray)、PowerToys、Shadowsocks、滴答清单(ticktick)、OneDrive、Snipaste、微信(weixin)、火绒(hipstray)、Steam、1Password、飞书(feishu)、Kimi、迅雷(thunder)、百度网盘、Legion Zone、CCEED。

### P2 真实点击复现（样本=联想电脑管家 262492:9967）

真实鼠标点击条带内图标（左+右各一次，屏坐标 (1808,1416)，scale=1）：

```
chainLeft/Right（panel-events.jsonl 实测序列）：
taskbar-tray-click → taskbar-tray-click-result{ok:true}
→ tray-replay{posted:true, wparam:517, lparam:9967, version:0, cb:1125}
→ tray-replay-result{ok:true}
```

链路四层全通、投递成功、**应用零行为**（leftResponsive=false / rightResponsive=false）——用户投诉的完整复现，且把断点压缩到「负载合成之后、应用解释之前」。

### P3 三真实第三方样本负载对照（右键主 oracle；version 全 0）

| 样本（exe / cb / uid） | 臂（wparam→lparam） | posted | 行为 |
|---|---|---|---|
| 联想电脑管家 lenovotray / cb=1125 / uid=9967 | **A 产品**：517→9967 | true | **无响应** |
| | **B MSDN**：9967→517 | true | **响应：新窗 ×2**（自绘托盘面板，非 #32768） |
| | A-left 产品：515→9967 | true | 无响应 |
| | B-left MSDN：9967→514(真 WM_LBUTTONUP) | true | 无响应（该图标左键本无默认动作） |
| | D-left 只修排布：9967→515 | true | 无响应（左键归因不可判，同上） |
| CCEED wocalcscec / cb=2002 / uid=1 | A：517→1 | true | 无响应 |
| | B：1→517 | true | 无响应（个别应用对合成回调不响应，如实记录） |
| PowerToys powertoys / cb=32768 / uid=1 | **A 产品**：517→1 | true | **无响应** |
| | **B MSDN**：1→517 | true | **响应：#32768 标准菜单在场** |

- 2/3 样本给出同轮同目标的「产品形态哑 / MSDN 形态活」判别对；同一 lenovotray key 在 P1（产品链路）与 P3-A（harness 直投）双口径一致哑、P3-B 一致活——交叉验证成立。
- 全部 9 臂 posted=true，asfw（AllowSetForegroundWindow）恒 false（见 §5-4——传参错位自证）；asfw=false 下 PowerToys 菜单仍能弹出：菜单显示不硬依赖前台权，但正确放行仍应修（防「菜单秒关/后台失活」类症状）。
- C 臂（v4 专属）与 v4 版本分布：**本机两轮登记 version 全 0，无 v4 样本，C 臂与 v4 分支真机缺证**——判罪依据为 MSDN 原文 + 代码直读（§5-2），修复建议见 §6。

### 版本分布

判读轮 `P1-summary versionHisto={0:23, miss:2}`；首轮 {0:8, miss:2}（10 条抽样）。本机主机上收编后的重注册潮无人重协商 NIM_SETVERSION（事件流中亦无 version 类事件可回放对照——tray-event 明细只在 spike 模式落盘，本结论以登记表 version 字段为准）。

## 5. 代码级偏差清单（vs MSDN NOTIFYICONDATAW uCallbackMessage 备注）

MSDN 原文（节译）：
> When uVersion is 0 or NOTIFYICON_VERSION: **wParam contains the identifier of the taskbar icon** … **lParam holds the mouse or keyboard message**.
> When uVersion is NOTIFYICON_VERSION_4: **LOWORD(lParam) contains notification events** (NIN_BALLOONSHOW, NIN_POPUPOPEN, WM_CONTEXTMENU…); **HIWORD(lParam) contains the icon ID**; **GET_X_LPARAM(wParam)/GET_Y_LPARAM(wParam)** return the X/Y anchor coordinates.

| # | 位置 | 现行 | 应然 | 真机判罪级 |
|---|---|---|---|---|
| 1 | protocol.ts:314-319 v0 分支 | wparam=鼠标消息、lparam=uid | **wparam=uid、lParam=鼠标消息** | ★★★ 主因（A/B 坐实） |
| 2 | protocol.ts:306-313 v4 分支 | lparam=(x<<16)\|uid | **lparam=(事件消息<<16)\|uid**（事件消息缺席、uid/x 错位双错） | ★★ 文档+直读（本机无 v4 样本） |
| 3 | protocol.ts:289 `WM_LBUTTONUP=0x0203` | 0x0203=WM_LBUTTONDBLCLK | **0x0202**（真 WM_LBUTTONUP） | ★★ 直读（左键修复必须连带；真机左臂因样本左键无动作未获行为级分离） |
| 4 | protocol.ts:313(v4 右键)/host.ts:334 | v4 右键发 WM_RBUTTONUP | **WM_CONTEXTMENU(0x007B)**（v4 语义下外壳右键即此消息） | ★ 直读（随 #2 一并修，C 臂缺真机对照） |
| 5 | host.ts:336-337 AllowSetForegroundWindow(entry.hwnd) | 传 HWND | API 形参是 **DWORD dwProcessId**（或 ASFW_ANY=-1）——传 `GetWindowThreadProcessId` 的 pid | ★ 直读+asfw=false 实测（放行恒失败；非无响应主因） |

**测试反向锁定**：`app/tests/trayhost-protocol.spec.ts:178-209` 把互换语义写成断言（「旧版：wParam = WM_LBUTTONUP/WM_RBUTTONUP，lParam = uid」「v4 lParam = uid | (x << 16)」）——#164 改产品必须连这些断言一起改写，否则修正会被旧测试打回。

## 6. ⑨票（#164）修复范围结论

**修哪层**：只动数据面托盘宿主两处——`protocol.ts` 的 `packTrayClick`（负载字段三处 + WM_LBUTTONUP 常量 + v4 右键事件）与 `host.ts` 的 `AllowSetForegroundWindow` 传参（hwnd→属主 pid 或 -1），加对应单测改写。渲染层分发、桥契约、服务护栏、进程间协议消息**零改动**——P2 已证它们全通。

**动多大**：小票。1 个纯函数 + 1 行传参 + 单测；无新增状态、无新链路、无配置面，符合 spec「修复保持在既有链路内，不另起机制」的决策。

**验证建议**：
- 单测：按 §5 表逐字段改写 packTrayClick 断言（v0 互换复原、0x0202、v4 lParam 布局、右键 WM_CONTEXTMENU）。
- 真机：可复用本 harness 的 P3 臂法做修复对照（A 臂=修复后产品链路，应出现 P3-B 的行为签名）；若进验收电池，建议形态为「右键第三方样本 → #32768 菜单在场 → ESC 收起」，段登记按电池章法另走。
- v4 分支缺真机样本：#164 可用 tray-spike 页自注册一枚 v4 探针图标（encodeNotifyIconData 已支持 uVersion）补合成对照，或在票面声明 v4 仅文档级验证。

## 7. 工具坑位与遗留

- **harness 读窗教训**（已在 fce5055 修正）：首轮事件读窗游标不前进，miss 行吃到上一 key 的 stale `tray-replay` 事件（假 registered）；修正后按事件内 key 字段匹配+游标前进。两轮交叉验证（lenovotray/PowerToys 双口径一致）确认判读轮数据未受污染。
- CCEED（wocalcscec）两臂皆哑：个别应用对合成回调无响应（可能要求 v4 语义/前台态校验），如实记录，2/3 样本判别不受影响。
- 联想管家左键三臂皆哑（含 MSDN 形态）：该图标左键本无默认动作（其交互=右键面板），非矛盾证据。
- P1 中 NVIDIA 与系统 GUID 图标 exe 解析为空（pid→exe 查询失败），不影响判读。
- P2 换算前提=条带窗 frameless（内容区原点=窗口原点），scale=物理宽/innerWidth 实测 1；换 DPI 机器复跑时该换算仍自洽（比例制）。
- 本轮右键回放的菜单均 ESC 收净，桌面无残留；面板停止后交还广播已发（图标回注册 explorer）。
