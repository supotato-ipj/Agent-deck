# 06: 品牌改名 AGENT DECK

**What to build:** 用户在 Wallpaper Engine 里和壁纸画面上看到的品牌从 QODER DECK 变为 AGENT DECK：WE 项目元数据 title、页面标题、画面内可见品牌文案、数据服务端代码内文案全部更新。GitHub 库名与 Steam 项目文件夹名本期不动（Q8A 决策），改名不得破坏 WE 项目关联与开机自启。

**Blocked by:** 01 接缝抽取（避开前端同文件冲突，非逻辑依赖）

**Status:** ready-for-agent

- [ ] WE 项目元数据 title 与前端页面标题、画面可见文案均为 AGENT DECK
- [ ] 数据服务端代码/注释内品牌文案更新；`/deck` 契约字段名不变（tool 取值、sessions 键等零变化）
- [ ] Steam 项目文件夹路径不变，WE 重载壁纸正常、开机自启不受影响
- [ ] TERMINAL 02 相关文案零波及（其 Qoder 状态块语义保留）
- [ ] 壁纸重载后目测：WE 编辑器与画面标题均显示 AGENT DECK
