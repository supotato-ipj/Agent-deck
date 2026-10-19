# 02: 壁纸骨架与硬件底栏

**What to build:** 在 WE 自有项目目录新建 qoder-deck web 壁纸：project.json + index.html + 终端风字体资源；全屏网格布局（顶栏标题/时钟/活跃计数、左栏占位、主区占位、底栏硬件仪表）；openWallpaper 可加载，桌面截图可见骨架与实时硬件数据。

**Blocked by:** 01 服务端 /deck 契约

**Status:** ready-for-agent

- [x] myprojects/qoder-deck 目录含 project.json（web 类型）与 index.html，WE 可加载
- [x] 顶栏渲染标题、实时时钟、活跃会话计数
- [x] 底栏渲染 CPU/GPU/VRAM/RAM 仪表，数据来自 /deck
- [x] fetch 失败时显示离线角标，其余部分正常渲染
- [x] 静态 HUD 透视属性开关生效（默认开）
- [x] 桌面截图验证骨架观感

## Comments

- 2026-09-21: /deck 增补 gauges 快照字段（底栏仪表数据源）。桌面截图确认骨架：顶栏 VT323 时钟 + SESSIONS 001、底栏六仪表实时、静态透视可见。浏览器接缝断言全过：离线角标 隐藏→fetch 失败显示→恢复隐藏；perspective 属性 none↔rotateY(1.2deg)。验证后已切回 TERMINAL 02（并存试跑约定）。
