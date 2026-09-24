# 06: 品牌改名 AGENT DECK

**What to build:** 用户在 Wallpaper Engine 里和壁纸画面上看到的品牌从 QODER DECK 变为 AGENT DECK：WE 项目元数据 title、页面标题、画面内可见品牌文案、数据服务端代码内文案全部更新。GitHub 库名与 Steam 项目文件夹名本期不动（Q8A 决策），改名不得破坏 WE 项目关联与开机自启。

**Blocked by:** 01 接缝抽取（避开前端同文件冲突，非逻辑依赖）

**Status:** done

- [x] WE 项目元数据 title 与前端页面标题、画面可见文案均为 AGENT DECK
- [x] 数据服务端代码/注释内品牌文案更新；`/deck` 契约字段名不变（tool 取值、sessions 键等零变化）
- [x] Steam 项目文件夹路径不变，WE 重载壁纸正常、开机自启不受影响
- [x] TERMINAL 02 相关文案零波及（其 Qoder 状态块语义保留）
- [x] 壁纸重载后目测：WE 编辑器与画面标题均显示 AGENT DECK

## Comments

- 2026-09-25 备注：CONTEXT.md 的改名部分（标题/首段改 AGENT DECK、新增"会话列表""工具标签"词条）已在 spec 发布提交 a0dc278 完成，本票只需核对不重复做；剩余范围是前端文案、WE project.json title 与服务端代码内文案。
- 2026-09-25 实施完成：index.html 的 title 与 brand、project.json 的 title/description、zones_geometry.py 注释四处改毕；project.json JSON 校验通过、文件夹路径未动；浏览器加载实测画面品牌为 AGENT DECK，会话列表与仪表零回归。README 更新按分工留票 07。
