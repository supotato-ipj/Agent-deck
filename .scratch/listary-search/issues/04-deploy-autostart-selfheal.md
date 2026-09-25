# 04: 部署与自愈——主检出、自启链路、壁纸重载

**What to build:** 功能完整后落到实际运行环境：改动到达自启链路所指向的主检出（而非仅开发 worktree）；重启电脑后，搜索面板待机窗随既有自启链路（watchdog → 数据服务）自动出现在原位；数据服务单独重启后，待机窗自愈回原位原态；DECK 壁纸的视觉改动经 Wallpaper Engine 的控制命令重载生效（WE 无热重载），所用命令记录于本票评论供复用。

**Blocked by:** 03（结果操作集——部署的是完整功能）

**Status:** ready-for-human

- [x] 自启链路实际运行的主检出包含搜索面板功能，运行态与开发 worktree 隔离不互相干扰
- [ ] 重启电脑后，待机窗随自启链路自动出现在右窄栏顶部原位（冷链路模拟已验，真重启待人工复验）
- [x] 手动重启数据服务后，待机窗回到待机态原位（自愈）
- [x] DECK 视觉改动经 WE 控制命令重载后生效，命令与步骤记录于本票评论

## Comments

**2026-09-25 ticket 04 部署完成（ready-for-human）**

部署方式：`feat/listary-search` 合并进主检出 `master`（合并提交 f5c42af）。分支在
zones 系列后分叉：master 多一个 ticket-07 回头修复（引入 `agent_sessions` 多工具
会话——即壁纸更名 AGENT DECK 的配套），feat 多 4 个 listary 提交。唯一冲突在
server.py 导入区，两者并留；合并后**主检出 244 测全绿**。生产自此运行含搜索面板
的代码（`/deck` 返回 panel 键即证）。运行态与开发 worktree 隔离：watchdog 只拉起
主检出的 server.py；worktree 测试不占 5000 端口。

自愈验收：`taskkill` 生产服务 → 15s 内 watchdog 拉起新进程 → `/deck` 200 带
panel 键 → 面板窗待机态原位（最小化截图 1167 亮px，与 ticket 01 基准一致；
`evidence/20-deploy-desktop.png`）。

冷链路模拟（等效重启，`evidence/21-coldchain-desktop.png`）：watchdog + 服务全杀
→ 按启动快捷方式原命令（`pythonw.exe scripts\server_watchdog.pyw`）拉起 →
22s 内 watchdog+服务+面板全部自动就位，面板待机态原位。开机真实链路与本模拟执行
的是同一条命令（Startup 快捷方式 → watchdog → server），留一次真重启人工复验即可
（与 IME 目验一并做）。

壁纸重载命令（WE 无热重载，DECK 改动后需执行；README「壁纸切换命令」同款）：

```
"D:\Steam\steamapps\common\wallpaper_engine\wallpaper64.exe" -control openWallpaper -file "D:\Steam\steamapps\common\wallpaper_engine\projects\myprojects\qoder-deck\project.json"
```

ticket 01 期间已执行过一次（spacer 让位生效的当天）。

备注：本票无新代码，全部为已过两轴评审的既有提交的部署与链路验收。
