---
Status: accepted
---

# 面板 second-instance 退出语义（--panel-quit）

工单431（#429 回退线票）：guard 真机验收清场走两级阶梯（优雅径 → 有界等待 → 强杀兜底），#429 取证 3 轮优雅径**全灭**（kill-mode=forced/forced/forced，`t429-r1/r2/r3.log`）——每轮面板树都被强杀收场，dispose 链与托盘图标注销全不走。本 ADR 记录替代径的设计裁决：面板新增 `--panel-quit` 退出旗标，经**单实例锁的 argv 转发**叫持锁面板走完整退出链，替代「优雅径恒不通 → 每轮强杀」。

## 决策

- **为什么不是修 WM_CLOSE 径**：两层理由，任何一层都足以否决。
  1. **真机证死**：guard 优雅径发的是 `taskkill`（不带 /F，向顶层窗发 WM_CLOSE），面板收到后 3 轮全不退（#429 取证）。票面原表述「面板主窗有 close 拦截」经摸底**勘误**：主窗（panel-window.ts）没有 close 拦截，全主进程唯一拦截在对话窗（conversation/window.ts，ADR-0018「关窗只收起」）。WM_CLOSE 为何没让主窗走完 close → closed → app.quit 机理未定谳——但本方向不依赖谜底。
  2. **结构性无前途**：外层守卫（disableHardwareAcceleration、零窗口）、渲染/GPU 子进程都没有顶层窗——#429 取证 15 PID 中 9 个**永远收不到窗口消息**。即使主窗修好，守卫恒残留 → 恒 forced。
- **--panel-quit 退出实例**：新旗标与 `--panel`/`--panel-accept` 同族。新进程分支置于外层守卫默认分支**之前**（掉进守卫分支的旧构建会在无面板持锁时反拉新面板）；`requestSingleInstanceLock()` 拿到锁（无面板在跑，含守卫 spawn 面板前的显式让位空窗期）→ 还锁即退、不拉任何东西；拿锁失败 → argv 已被 Electron 转发给持锁面板，本实例即刻退。两种结局都是「一次性退出信使」，**绝不拉 UI**（`planQuitInstance` 单测钉死）。
- **持锁面板侧**：second-instance 统一分发（`dispatchSecondInstance`）——带旗标 → 记 `{type:'quit-request', source:'panel-quit'}`（把「谁叫退的」变一等可取证事实；既有 before-quit 的 `{type:'quit'}` 无差别）+ `app.quit()` 完整退出链；无旗标 → showPanel 唤回（既有二次拉起口径不变）。**认旗标段提前到拿锁时刻注册**——覆盖半开机态被清场（bootPanel 装配未完也认得退出请求）；mid-boot 退出的部分 dispose 风险由取证轮覆盖，失败兜底仍是 guard 强杀。
- **级联退场是价值核心**：面板主动退 → 外层守卫 child-exit 跑还原账（<3s）后自杀 → 渲染/GPU 子进程随 Chromium job 收走——**全树优雅退场，无窗进程也覆盖**，这是 WM_CLOSE 径原理上做不到的。
- **确认框语义分岔（无人径/有人径）**：`--panel-quit` 径**旁路**在途 turn 确认框（等价自动选「终止会话并退出」，正文由后端保存可续接）；托盘「退出面板」与设置浮层按钮**保留**确认框——guard 清场等不了人，用户退出该被问。
- **guard 侧零代码改动，只换 config 载荷**：`D:\test-folder\.accept-guard\config.json` 的 `gracefulPanelsCmd` 从 taskkill(WM_CLOSE) 换成「枚举 + `graceful <pid> <path>` 标记行输出（guard 等待契约不变）+ 每个枚举到的检出拉一次 `--panel-quit` 实例」；`gracefulWaitMs` 5000→8000（级联链 = quit 实例启动 ~1s + 退出链 + 守卫还原账 <3s，贴 5s 预算跑）。阶梯结构/等待逻辑/强杀兜底全不动（#429 User Story 10）——强杀兜底兼兜「旧构建面板不认旗标」的退化。
- **部署次序纪律：主检出 dist 先部署、再翻 guard config**。反着来会出现窗口期：旧构建的 quit 实例在无面板持锁时掉进守卫分支反拉新面板（新构建此径已由分支前置堵死；config 的枚举门控只是缓解——枚举到的可能全是不持锁的 --panel-accept 子进程）。config 是双 agent 共享活文件，改动须在票面披露。

## Considered Options

- **修主窗 WM_CLOSE 关闭链**——机理未定谳先不谈；守卫/渲染/GPU 无顶层窗收不到信号，修好主窗也恒 forced，否决。
- **guard 直接强杀 + 依赖显示侧回收（#423）兜僵尸**——#429 已按此收口为现状，但 dispose 链（干净退出标记、托盘注销、在途会话终止）全不走，强杀每轮都在产源上残留，只被显示侧兜住。本 ADR 把产源收掉。
- **给面板加退出 IPC 端口/命名管道**——新通道新生命周期要维护，而单实例锁的 argv 转发是 Electron 原生自带、全部检出共用 userData → 共用一把锁，second-instance 天然只达常驻面板（`--panel-accept`/控制器/tray-spike 不抢锁），恰好就是 guard 清场对象。零新增通道。
- **`--panel-quit` 顺带产品化为用户命令行退出**——只当实现细节，不写用户文档（用户退出正径仍是托盘菜单）。

## Consequences

- 验收口径（与 #429 同款「单测+真机取证轮」章法，不加电池段）：① 单测（argv 分辨/分支计划/分发/闩，`tests/panel-quit.spec.ts`）；② 真机取证一轮走 guard hold 协议，断言四件——hold 输出 `kill-mode=graceful`、清场后托盘琥珀像素=0、面板事件流有 quit-request 起头的完整退出链、外层守卫进程随级联消失；③ 取证记录入 `docs/audit/`，config 改动在票面披露。
- 新事件词汇：`{type:'quit-request', source:'panel-quit'}`（收到退出请求）、`{type:'quit-busy-bypassed', source:'panel-quit'}`（在途 turn 确认被旁路）。GLOSSARY 暂不加词条（浓度未到；将来真出现第二个退出入口再立）。
- 纯逻辑收在 `src/main/panel-quit.ts`（无 electron 依赖）；接线面（分支前置、拿锁时刻注册、确认框旁路）在 `index.ts` 与 `conversation/window.ts`。
- Out of Scope 不回挖：guard.mjs 代码与阶梯结构、显示侧回收机制（#423）、`--panel-accept`/控制器/tray-spike 的生命周期管理（各自控制器自管）。
