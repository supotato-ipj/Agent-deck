# 工单431 真机取证记录——`--panel-quit` 退出径首验（kill-mode 首次转 graceful）

- **日期**：2026-11-10 凌晨（guard hold 取证轮 01:33，烟雾轮 01:29）
- **被测构建**：master `d547fb9`（PR #453，工单431 代码 + ADR-0030），主检出 `npm run build` 后部署、面板重启
- **guard 侧变更**：`D:\test-folder\.accept-guard\config.json`（备份 `config.json.bak-t431`）——`gracefulPanelsCmd` 载荷从 taskkill(WM_CLOSE) 换为「枚举 + `graceful <pid>` 标记行 + 每个唯一检出根拉一次 `--panel-quit` 实例」（guard.mjs 零改动，等待契约不变）；`gracefulWaitMs` 5000→8000。**双 agent 共享活文件，此为工单431 共识第 2 条的既定披露项**。
- **次序纪律**：先部署（build+重启验证新构建在跑）→ 后翻 config（ADR-0030 纪律）。

## 四断言

### ① hold 输出 kill-mode=graceful ✅

`guard.mjs hold --as zcode --purpose accept-sprint` 取证轮（`t431-r1.log`）：

```
优雅径触达：graceful <15 个 PID …（载荷枚举并输出标记行）
优雅等待：触达 15 个面板 PID，等 1044ms，残留 无
清场落点 kill-mode=graceful（面板已自发退出或本就无残留，强杀空枚举）
```

对照 #429 同协议三轮 **forced/forced/forced**（WM_CLOSE 径全灭）：本径 15 PID（守卫+面板+渲染/GPU 全树）**1044ms 内全数自发消失**，强杀空枚举。级联链实测远低于 8000ms 新预算（quit 实例启动+退出链+守卫还原账合计 ≈1s 量级）。

### ② 清场后托盘零僵尸 ✅（判据修正：amber 计数→三层证据）

**amber 像素计数判据在本机失效，且 #429 自身数据即已带此病**：对 #429 当轮证据截图重跑 `amber-count.ps1`，基线与三轮清场后同为 **30→30→30→30**——该计数测的是浮层内第三方图标的琥珀色噪底，对本面板图标在否无感。失效机理（本轮查明）：

1. 本面板托盘图标实为**深底（#1a1f2e）+ 四个 8px 琥珀方点**（`tray.ts` 程序化绘制），非纯琥珀块——琥珀像素占比小且缩放后混入噪底（本轮实测噪底 22-24px，图标在否不改变计数）；
2. 图标活态宿主在**面板自托管栏**（任务栏接管态，原生 TrayNotifyWnd 不可寻址），本就不在溢出浮层。

替代三层证据：

| 层 | 手段 | 结果 |
|---|---|---|
| 主托盘 | UIA 按钮枚举（`t431-tray-dump.ps1`，tooltip 级）×2 轮 | 无 `AGENT DECK` 按钮（清场后扫场） |
| 溢出浮层 | 活/死两帧截图对比（`t431-tray-alive-1` vs `t431-tray-dead-1`，视觉模型判读 + 逐像素 bbox 分析） | **完全同图**：22 枚第三方图标同排布无增减（橙色火焰盾为第三方 Norton 系图标，两帧均在） |
| 产品事件流 | before-quit 链落账 | `quit` 与 `trayHolder.current?.destroy()` 同一处理器顺序执行（`index.ts` before-quit 段），退出链日志在场（见③） |

结论：shell 侧无任何 AGENT DECK 呈现、无死主图标残留——零僵尸成立。

### ③ 面板事件流完整退出链 ✅

`t431-panel-events.jsonl`（取证面板以 `DECK_EVENT_LOG` 拉起，guard 轮第 412-420 行，全程 **461ms**）：

```
quit-request (source=panel-quit)        ← second-instance 认旗标（新事件词汇）
taskbar-autohide-restored (dispose)     ← 任务栏控制器 dispose
taskbar-window-destroyed (dispose)
session-preview-window-closed (dispose)
quit                                    ← before-quit 存证
dataplane-exit
icons-restored (panel-exit)             ← 外层守卫还原账走完
carry-exit                              ← 守卫自杀（级联终点）
```

手动烟雾轮（第 740-749 行）同链复现。

### ④ 外层守卫随级联消失 ✅

清场后 pattern `D:\test-folder\wallpaperengine-research*` 下 electron 进程 **residue=0**（守卫级联自杀、quit 实例自退、渲染/GPU 随 job 收走）；事件流 `icons-restored`+`carry-exit` 落账（还原账 <3s 走完才退场）。

## 附加验证

- **手动烟雾**（config 翻转前）：直接拉 `<exe> <app> --panel-quit` → 10s 内全树消失（tree-gone）——机制先于 guard 接线独立坐实。
- **退出实例两径**：拿锁失败径（面板在跑）由烟雾轮+guard 轮覆盖；拿锁成功径（无面板→还锁即退、不拉任何东西）在烟雾轮中隐式覆盖（quit 实例自身即刻消失、未反拉面板）。
- **`quit-busy-bypassed` 事件未覆盖**：取证轮无在途 turn 夹具（需真实会话流式中），该旁路覆盖面=代码审查（Spec 轴确认闩唯一置位点在 quitRequest 动作内、托盘径不受影响）+单测闩语义。如实记账，不冒充已验。

## 工具沉淀（`D:\test-folder\.accept-guard\`）

- `t431-tray-shot.cjs`（t429 同款截图工具改前缀）＋ `t431-flyout-compare.png`（活/死浮层并排对比图）
- `t431-flyout-open-hold.cjs` / `t431-flyout-enum.ps1`：浮层 UIA 枚举试验件——**结论：浮层轻关闭特性使任何「开层后拉子进程枚举」路数不可靠**（子进程控制台即抢焦点关层），记录备查勿再踩
- 证据文件：`t431-r1.log`（hold 全输出）、`t431-panel-events.jsonl`（749 行）、`t431-tray-*` 系列截图、`config.json.bak-t431`
