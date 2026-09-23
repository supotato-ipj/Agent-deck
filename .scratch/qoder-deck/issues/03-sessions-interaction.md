# 03: 多会话列表与聚焦交互

**What to build:** 左栏渲染活跃会话列表（项目名+状态灯+任务进度），点击切换聚焦会话，hover 展开消息预览；主区渲染聚焦会话详情：状态、任务进度条、当前任务、消息预览流。

**Blocked by:** 02 壁纸骨架与硬件底栏

**Status:** ready-for-agent

- [x] 会话行数量与 /deck sessions 一致，按最近活跃排序
- [x] 点击会话行切换主区聚焦详情（含 current_task 与 preview）
- [x] hover 会话行展开其 preview，移开收起
- [x] 无活跃会话时左栏与主区显示待机态文案
- [x] 浏览器 evaluate 断言点击/hover 的 DOM 状态变化

## Comments

- 2026-09-21: 浏览器合成双会话数据断言全过：rows=2、默认聚焦首行、点击切聚焦（focus 显示 IDLE+其预览）、mouseenter 加 .hover 且 prev 展开 70.56px、空态 NO ACTIVE SESSIONS+standby、恢复真实 fetch 回单行。桌面截图确认会话行与聚焦面板观感（RUN/项目名/008/008/预览流时间戳）。验证后切回 TERMINAL 02。
- 实现注：hover 用 JS mouseenter/leave 加 .hover 类（而非纯 :hover），以便自动化断言；预览流为客户端累积（preview 变化时 unshift，上限 8 条）。
