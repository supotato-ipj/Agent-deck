# 11: 退役与收尾（contract 步）

**What to build:** 新应用全面接管：Startup 自启快捷方式切换到新应用并真重启复验；退役 Python 数据服务及其自启链、看门狗、Tk 搜索窗、zones Win32 挪真图标链路、三个 WE 部署脚本；deck/patched/backup 壁纸资产冻结归档（只读封存不再维护）；README 与 docs 更新到新架构语境（与 ADR-0004、CONTEXT.md 终稿一致）；旧使用日志历史数据的去向有明确交代（随迁移保留或声明重新积累）。

**Blocked by:** 03 宿主常驻件、04 数据卡片、05 桌面承载尖兵、06 编排与推荐、07 搜索并入、08 设置浮层与透明度、09 会话块直达、10 插件体系自举

**Status:** ready-for-agent

- [ ] 真重启后仅新面板自启就位；旧数据服务/看门狗/Tk 搜索窗进程不存在
- [ ] 旧自启项移除，新自启项经真重启验证
- [ ] 退役代码与脚本移除或归档，壁纸资产只读封存
- [ ] README/docs 与词汇表、ADR 一致
- [ ] 使用日志历史去向明确（迁移保留或声明重新积累）
- [ ] 全量验收电池最终轮全绿并截图存证于工单评论

## Comments

**2026-09-27 旧栈运行态提前清理（bug 修复，非本工单验收）**

用户报告桌面偶现 WE 版残留 Listary 搜索框组件，定位为旧检出 `D:\test-folder\wallpaperengine-research` 的自启链：Startup 快捷方式 `qoder-deck-server-watchdog.lnk` → `server_watchdog.pyw`（PID 18604）→ `server.py`（PID 30612，内嵌 Tk 搜索面板窗）。已删 Startup 快捷方式并结束两进程（hermes 工具进程无关未动）；核查无计划任务/HKLM/看门狗自重建等其他复活途径。**本工单的「旧自启项移除」在运行态层面已提前完成**，代码退役（删脚本、冻结壁纸资产、Startup 改指新应用、真重启复验）仍按本工单计划执行。
