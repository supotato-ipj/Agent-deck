# 04: 历史曲线、自启收尾与切换说明

**What to build:** 底栏三条 canvas 曲线（CPU/DL/UP，近 5 分钟）；完成看门狗自启注册（启动文件夹快捷方式 → pythonw 看门狗）；写清 TERMINAL 02 ↔ QODER DECK 切换命令供用户试跑对比。

**Blocked by:** 03 多会话列表与聚焦交互

**Status:** ready-for-agent

- [x] canvas 曲线随 history 缓冲滚动更新，遮挡恢复后继续生长
- [x] 启动文件夹存在看门狗快捷方式；杀掉服务后看门狗在 15s 内拉起（WE 运行前提下）
- [x] 双实例防护：手动再启 server.py 静默退出不报错
- [x] README 或注释含两张壁纸的切换命令
- [x] 用户实机试跑对比验收

## Comments

- 2026-09-23: 用户定稿并切为主力壁纸（WE config Monitor0 已持久化为 qoder-deck）；TERMINAL 02 留作备份（README 有切回命令）。
- 定稿前迭代记录：砍曲线→硬件右下角小块；会话状态右上、窄栏、分隔线贴栏左缘；只留四态状态机（RUN/CONFIRM/DONE/IDLE）无对话内容；硬件数值全定长（整数补零+固定两位小数）防换行抖动。

## Comments

- 2026-09-21: 曲线实机截图确认（CPU/DL/UP 三条 canvas 折线）。看门狗复活测试通过（杀服务后 ~15s 内 pythonw detached 拉起）；注意 TaskStop 会连坐杀 detached 子进程，测试后需重启服务。
- 2026-09-21: 双实例守卫改用 connect 探测——Windows SO_REUSEADDR 允许双进程同绑端口，原 bind 守卫无效（实测 exit 124 不退出）；改后 guard-exit=0。
- 2026-09-21: 启动快捷方式 `qoder-deck-server-watchdog.lnk` 已落盘（scripts/create_startup_shortcut.ps1 可重建）。切换命令见根目录 README.md。
- 2026-09-21: 意外收获——服务被连坐杀期间桌面截图验证了 OFFLINE 角标真实路径（OFFLINE + 仪表 --- + standby）。
