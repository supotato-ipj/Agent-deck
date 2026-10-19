# 六电池「注入/采样断言 × 遮挡前置」盘点清单（工单34 方向2）

> 留痕产物：PR 内评审用，不做静态校验（spec #125 Testing Decisions 明文）。
> 逐电池盘点「注入/采样断言」对「用户窗抬起」这一根因的前置防护状态：**已接**（断言前有落点清场/有界重试/事件门前置）/ **已补**（本票给未接点补上前置）/ **无暴露**（机制不敏感或夹具故意，附裁定依据）。

## 口径与事实边界

- **根因统一**：电池一跑数分钟，用户在机器上正常工作会抬起窗口，SendInput 整段被覆盖窗偷走、像素采样被遮（工单34 票面根因；#17 的 `ensurePanelHit` 是第一个接缝）。
- **事实边界（票面评论决议口径）**：SendInput 仅存在于全量电池（五块副电池为零）；`ensurePanelHit` 已覆盖全量电池主要交互段；48-tray-spike 的像素采样纳入本审计。
- **分类依据**：以代码现状为准（分支 `fix/battery-occlusion-robust` @ 本票 diff 后）。「机制不敏感」的常见形态：条带/托盘是 TOPMOST（普通用户窗盖不住）、PrintWindow 直拍窗口内容（遮挡免疫）、键盘经前台门+事件门判定、断言纯事件/配置级（无落点无像素）。
- **改段纪律**：只给未接点补前置，不动已接点（不全量重包，spec #125 Out of Scope）；本票所有补前置改动统一理由即上述根因，阈值/取样区/等待零变化。

## 03-battery（全量电池，30 段）—— 唯一有 SendInput 的电池

| 段 | 注入/采样点 | 遮挡前置 | 状态 |
|---|---|---|---|
| P1 | （面板拉起，无注入） | — | 无暴露 |
| P2 | `checkerHitRateAtPoints` 棋盘采样带（500 点阈值 + WindowFromPoint 过滤） | 开局清场后仅过滤不计被遮点，点不足即 FAIL 且不可定责 | **已补**（方向1：ensurePanelHit 式清场重试 4 轮；清不掉如实 FAIL 附遮挡源指认） |
| P2 | `whitePixels` 时钟卡文字像素（同 shot 取景卡区） | 无 | **已补**（卡心落点并入 P2 同一重试循环；未清掉时 fail 文本附遮挡证据） |
| P3 | `clickPhys` 空区左/右键（穿透探针，断言前台翻转为桌面层） | 无（开局 clearDesktop 之后约 1 分钟，暴露窗期内抬起即假失败） | **已补**（落点 3 轮有界清场：覆盖窗最小化、TOPMOST/Ghost 走 ESC；清不掉交前台断言如实判） |
| P4 | `clickPhys(overlap)` 激活记事本 + `wfp(overlap)` 断言 | 记事本**就是**本段夹具（故意盖在面板上测钉扎/顶起语义） | 无暴露（夹具故意遮挡，加清场反而破坏测试意图；用户窗恰好落在 overlap 点属低概率噪声，其失败方向仍可由同段多点断言交叉定责） |
| P4 | `ensurePanelHit` + `clickPhys(cardCenter)`（clock-card-clicked 存证门） | 无 | **已补**（点击前 `ensurePanelHit(cardCenter)`；未清掉不停轮、带证继续事件门判定） |
| P5→P5.17 | 全部交互点：单击/双击/右键/拖拽/框选/键盘模式（约 40 处落点） | `ensurePanelHit`（#17 先例：落点命中 + 最小化重试 + 假死自愈 + 排除窗联动）或 `occludedClickAt`（落点取证 + 事件门判定） | 已接 |
| P5-ICON / P5-ICON2 | 无注入无采样（desktop-rendered 事件夹具断言） | — | 无暴露 |
| P7S | 搜索卡激活 `clickPhys`（search-activated 事件门 + 前台门 ×3 重试）；键盘注入（前台=面板进程门） | 激活点击无落点清场 | **已补**（激活前 `ensurePanelHit` 落点清场；键盘注入走前台门判定，遮挡非直接暴露） |
| P8S | 设置浮层入口 `occludedClickAt` + 浮层内拖拽/点击 | 入口经 `occludedClickAt`；浮层开后为 TOPMOST | 已接 |
| P9 | Win+D 键盘注入 + `captureFast` 像素对照（immune vs minimized） | Win+D 自身即全量清场（发送后全部普通窗最小化，immune 拍在清场后）；两拍间隔秒级 | 无暴露（机制自带清场）；段末另发还原 toggle 防 show desktop 残留遮挡后续段 |
| P9 段末重钉 | `wfp(overlap) === notepad.hwnd` | 记事本由电池自恢复自摆位（夹具） | 无暴露（同 P4 裁定） |
| P10/P10E | 托盘识别色 `scanAmberInTray`（截 Shell_TrayWnd 条带）+ `occludedClickAt` 设置入口/退出按钮 | 条带 TOPMOST 普通窗盖不住；交互点经 `occludedClickAt` | 已接 / 无暴露 |
| P9B | 会话行/时钟卡 `occludedClickAt` | 同上 | 已接 |
| P11 | 插件契约事件/配置断言 | — | 无暴露 |
| 全局 | 托盘琥珀基线/增量（`scanAmberInTray`，735/5136/5304） | 条带 TOPMOST | 无暴露 |

## 48-tray-spike（10 段，零 SendInput）

| 段 | 注入/采样点 | 遮挡前置 | 状态 |
|---|---|---|---|
| P0-P2 | Shell_NotifyIconW 直调（控制器进程内 API 调用，非屏幕注入）+ 事件门 | — | 无暴露 |
| P3/P3b/P3c | `captureWindow`（**PrintWindow 直拍窗口客户区**——被遮挡/非前台也能拿到真实内容，代码注释明示） | PrintWindow 遮挡免疫 | **已核无暴露** |
| P4 | `capture(rectOf(realTray))` 截真托盘条带（屏幕区域抓拍，负向断言：琥珀 <40） | 条带 TOPMOST，普通用户窗盖不住 | **已核无暴露**（残余风险注记：全屏 TOPMOST 覆盖层理论可遮条带，归 preflight ① 全屏覆盖层警示管辖；且本断言是负向式，遮挡的失效方向是「假通过」而非不可定责的「假失败」，不在本票问题域） |
| P5/P6 | 字节语料解析 + 交还后 explorer 托盘在场（FindWindow 级） | — | 无暴露 |

## 49-taskbar（9 段，SendInput 在场）

| 段 | 注入/采样点 | 遮挡前置 | 状态 |
|---|---|---|---|
| 开局 | `ensureTaskViewClosed`（Win+Tab 反 toggle 循环清任务视图岛——岛窗盖条带会毒死 P3/P4 命中判定） | 有界 8 拍清场 | 已接 |
| P1/P2 | 窗口在场/置顶/几何（rectOf/EXSTYLE，无落点） | — | 无暴露 |
| P3 | 缝隙/pill `moveMousePhys` + WindowFromPoint 双向往返 | 点击前 z 序收敛等待（32×250ms 轮询落点命中条带；未收敛附「上方窗口」取证） | 已接（条带 TOPMOST，普通用户窗盖不住；收敛等的是 shell 重申时序） |
| P4/P5 | `clickPhys` 开始/任务视图按钮（事件门 taskbar-action + 合成回执 + 前台门三重判定） | P5 点击前再收敛；P4/P5 间开始菜单消散静置 | 已接 |
| P6-P9 | CDP 驱动 + 窗口存在性/registry（无落点） | — | 无暴露 |

## 50-taskbar-carry（7 段）

- **零 SendInput、零屏幕采样**（grep 全文无 clickPhys/tapKeys/send/capture/nativeImage）。
- 全部断言为窗口存在性/可见性（Shell_TrayWnd 视图事实）、事件存证、config 落盘、StuckRects3 字节比对——系统状态/事件面，无落点敏感性。**无暴露点**。

## 51-taskbar-appbar（5 段）

- **零 SendInput、零屏幕采样**。
- 断言面：SPI_GETWORKAREA 工作区、条带几何、分辨率切换（ChangeDisplaySettings）、全屏让位事件（taskbar-yield）+ 视图事实。P2/P4 的参照窗是电池**自开自管**的 BrowserWindow（AttachThreadInput + SetForegroundWindow 是夹具控制，非断言注入）。**无暴露点**。

## 55-taskbar-right-group（6 段，SendInput 在场）

| 段 | 注入/采样点 | 遮挡前置 | 状态 |
|---|---|---|---|
| P1 | 右组格清单 + 细条几何（rectOf，无落点） | — | 无暴露 |
| P2 | CDP 双读 DOM 比对（无落点无像素） | — | 无暴露 |
| P3/P4/P5 | `clickPhys` 时钟格/音量格/显示桌面细条 ×2（事件门 taskbar-action-result + 前台门判定） | 每次点击前 `convergeAt`（移入刷新热区 + WindowFromPoint 轮询收敛，taskbar.js 同款纪律）；P5 notepad 探针 SetForegroundWindow 属夹具控制 | 已接 |
| P6 | CDP set-metrics + config 落盘 + 面板重拉（无落点） | — | 无暴露 |

## 本票补前置改动汇总（统一理由：用户窗抬起同一根因）

| # | 位置 | 改动 | 改段性质 |
|---|---|---|---|
| 1 | 03 P2 采样带 | ensurePanelHit 式清场重试 4 轮（方向1 主改动）；清不掉如实 FAIL 附遮挡源指认（移除「不可判」措辞——verdict 三态外无不可判状态） | 采样前置（阈值 500/0.9、取样区几何、等待均零变化） |
| 2 | 03 P2 时钟卡 | 卡心落点并入 #1 同一重试循环；whitePixels 失败文本附遮挡证据 | 采样前置 |
| 3 | 03 P3 空区探针 | 落点 3 轮有界清场（桌面层在位即放行） | 注入前置 |
| 4 | 03 P4 时钟卡点击 | 点击前 `ensurePanelHit(cardCenter)`，未清掉不停轮带证继续 | 注入前置 |
| 5 | 03 P7S 激活点击 | 激活前 `ensurePanelHit(搜索卡中心)`，未清掉不停轮带证继续 | 注入前置 |

已接点一概未动（不全量重包）；五块副电池无一处需要补前置（48 已核无暴露、50/51 无注入无采样、49/55 机制级已接：TOPMOST 条带 + 收敛等待 + 事件/前台门）。
