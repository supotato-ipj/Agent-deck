# 工单363 取证报告：通知区域原生菜单断链——断点在前台段（放行权发起方错位）与回调段（鼠标消息只发抬起一条）

- 日期：2026-11-02
- 工单：[#363](https://github.com/supotato-ipj/Agent-deck/issues/363)（父 spec #361 决策 7「先取证再定改点」/ 决策 8「通用修复边界」）
- 取证工具：`app/accept/experiments/tray-menu-forensics.js`（新增；基线轮 r2 与修复轮 r5/r7/r8/r9 共用同一工具）
- 判读素材：`D:\test-folder\.agent-notes\t363-tray-menu\`（findings.json / timeline.json / panel-events.jsonl，不进仓库）
- 真机轮：一律经 accept-guard 托管（`hold --as mcode --purpose accept-sprint`）；基线轮 r2、修复轮 r5/r7/r8/r11

## 1. TL;DR：两个断点，都不是「菜单实现」问题

| 断点 | 段 | 机制 | 真机证据 |
|---|---|---|---|
| ① | **前台段** | 放行（`AllowSetForegroundWindow`）由**数据面子进程**发起——那儿既非前台也非末次输入接收者，放行恒失败（存证 `asfw=false`）⇒ 应用弹不出菜单，或弹出的菜单不持前台（点外/Esc 收不掉） | 基线轮 r2：PowerToys 的 `#32768` 菜单在场但前台仍是上一个应用；Esc 后 `menusAfter=1`、`gone=false` |
| ② | **回调段（消息条数）** | 外壳把图标上的**原始鼠标消息逐条转发**（按下与抬起各一条）；我们只发**抬起**一条 ⇒ 只认按下态的应用永远收不到动作 | Electron 托盘源码（`shell/browser/ui/win/notify_icon_host.cc`）只认 `WM_LBUTTONDOWN/WM_RBUTTONDOWN/WM_CONTEXTMENU` 一族、**不认 UP 族** ⇒ 自家图标右键菜单永不弹；外壳发消息对（ReactOS `base/shell/explorer/syspager.cpp` 逐条转发原始鼠标消息） |

**z 序段不是断点**：回放期间条带确实退出置顶带（`topmostSeen=[true,false]`），菜单在普通带诞生即压在条带之上；
让位恢复也把条带放回置顶带（`topmostAfter=true`）。

## 2. 基线证据（轮 r2，未改产品代码）

| 样本 | 类型 | 回调投递 | 放行 | 菜单 | 前台 | Esc 收起 |
|---|---|---|---|---|---|---|
| PowerToys v0.96.1 | 标准 `#32768` | posted=true、v0、wp=uid、lp=0x0205 | **asfw=false** | **在场** | **未转移**（仍是上一个应用） | ❌ `gone=false` |
| 联想电脑管家 | 自绘面板 | posted=true | **asfw=false** | 无 | — | — |
| OneDrive / Steam | 私有实现 | posted=true | **asfw=false** | 无 | — | — |
| Agent Deck 自身 | 自家托盘 | posted=true | **asfw=false** | 无 | — | — |

## 3. 修复（两处，均为通用修复，无应用特判）

### 3.1 放行权改由面板主进程发起（断点①）

- `app/src/main/taskbar/foreground.ts`（新增）：纯裁决 + `AllowSetForegroundWindow` 真源（形参是属主进程 id）。
- `app/src/main/taskbar/window.ts`：`taskbar/tray-replay-begin` 处理器里放行——该事件由服务在**转发回放之前**
  同步发出，放行时序与外壳一致（放行先于回调投递）。
- 理由：外壳投递托盘回调前先替应用放行；放行只能由**持前台权或末次输入**的过程发起。条带窗属主
  进程（面板主进程）才是真实右键的末次输入接收者。

### 3.2 回调负载按外壳口径补齐「鼠标消息对」（断点②）

- `app/src/main/trayhost/protocol.ts`：`packTrayClick` 返回**投递序列**——pre-v4 图标收按下 + 抬起两条，
  v4 图标仍收一条通知码（右键 `WM_CONTEXTMENU`）。
- `app/src/main/trayhost/host.ts`：按序逐条 `PostMessage`（同一目标线程保序），存证 `packs` 记全序列。
- 口径来源：外壳把图标上的原始鼠标消息逐条转发（ReactOS `syspager.cpp` 的 `SendMouseEvent` →
  `SendNotifyCallback` 逐条转发；`OnCtxMenu` 只在**键盘**场景模拟这对消息，鼠标场景是「已经一起发出去了」）；
  应用按哪一条动作由它自己决定（Electron 只认按下族，联想电脑管家只认抬起族）。
- #163 取证的 A/B 臂只试了 UP 一条，样本恰好都认 UP，掩盖了消息条数缺口——本轮由自家图标（Electron）
  这类「只认按下族」的应用暴露。

## 4. 修复后真机证据（轮 r5/r7/r8/r9）

| 样本 | 类型 | 回调投递 | 放行 | 菜单 | 前台 | Esc 收起 | 点外收起 |
|---|---|---|---|---|---|---|---|
| PowerToys v0.96.1 | 标准 `#32768` | posted=true、packs=[0x0204, 0x0205] | granted=true | 在场 | **取到前台**（`PToyTrayIconWindow`） | ✅ `menusAfter=0` | ✅ `menusAfter=0` |
| 联想电脑管家 | **自绘**面板 | posted=true、packs=[0x0204, 0x0205] | granted=true | 在场 | **取到前台**（`LenovoTrayMenuV2`） | ❌ 菜单窗仍在 | ✅ `customLeft=0` |
| **Agent Deck 自身** | 自家托盘（Chromium 自绘菜单） | posted=true、packs=[0x0204, 0x0205] | granted=true | **在场** | **取到前台**（自家 `Chrome_WidgetWin_1`） | ✅ `gone=true`、前台交还原应用 | ✅ `gone=true` |

- 让位账：菜单在场 → 点外 → Esc → 换图标 → 条带销毁各路径，恢复后 `topmostAfter=true`（条带不永久停留
  非置顶态）；标准 `#32768` 走 `reason=menu-closed` 快速恢复，自绘面板走超时上限（10s）盲区兜底恢复
  （工单194 既定口径）。

### 4.1 自家图标菜单链（工单363 必测项，独立证据链——轮 r11）

```
P7-menu       栏内真实右键自家图标（产品链）：
             tray-replay{packs:[{lparam:516(WM_RBUTTONDOWN),posted:true},
                               {lparam:517(WM_RBUTTONUP),posted:true}],posted:true}
             taskbar-tray-foreground-grant{granted:true, reason:'ok'}
             前台窗 = 自家 Chrome_WidgetWin_1（pid 面板主进程）← 菜单持前台
P7-conversation  菜单内触发「对话窗」项（键盘 Down+Enter，菜单已持前台）：
             convOpened = {title:'DECK-CONVERSATION'} ← 对话窗真实打开
P7-close     Esc 后菜单消失（menusAfter=0）；条带恢复置顶（topmostAfter=true）
```

- 菜单由**既有** `tray.setContextMenu(Menu.buildFromTemplate([对话窗, 退出面板]))` 呈现——模板/文案/项集
  未改，未重做成自绘菜单（spec 决策 6）；项触发走菜单自身的路径（菜单已持前台 ⇒ 键盘落在菜单上）。
- 面板的非激活纪律未动：面板窗始终 `focusable:false`/WS_EX_NOACTIVATE，面板本体不抢前台；菜单的激活由
  菜单自身的窗口承担，菜单关闭后前台交还原应用（存证：Esc 后前台回到原应用，点外后回到桌面）。
- 「退出面板」项未单独点验（点它即退面板，验完面板就没了）：项集与模板未改 + 菜单项行为由 Electron 既有
  菜单路径承担，「对话窗」项已真机点验通过，同一菜单的「退出面板」项走同一 `Menu` 点击路径。

## 5. 遗留与边界（按 spec #361 决策 8 / Out of Scope 记录，不加特判）

- **已闭合**：Agent Deck 自身图标 —— 栏内真实右键 → 既有菜单弹出（持前台）→ Esc / 点外收起 → 条带恢复置顶；
  面板的非激活纪律未改（面板窗始终 `focusable:false`，面板本身不抢前台；菜单的激活由菜单自身的窗口承担，
  关闭后前台交还原应用）。
- **Esc 收起对自绘菜单不生效**（联想电脑管家）：菜单是应用自绘窗，其 Esc 行为属应用私有生命周期；
  点外收起照常生效。标准 `#32768` 菜单的 Esc 收起已验证通过。
- **OneDrive / Steam 不响应合成回调**：回放投递成功、放行成功，仍不弹菜单——按 spec 决策 8 记为
  「不响应合成回调的第三方」，未加特判。