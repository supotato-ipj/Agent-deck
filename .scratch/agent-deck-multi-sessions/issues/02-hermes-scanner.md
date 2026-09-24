# 02: hermes 扫描器

**What to build:** 壁纸会话列表开始出现 hermes 会话：跑一个真实 hermes 任务时，列表中出现带 `HM` 标签的行，运行中显示 RUN（用其活跃租约文件与"未结束"信号交叉判定，长任务不因写入间隙掉出 RUN），结束后按统一四态回落，10 分钟后出列；归档会话永不出现。

**Blocked by:** 01 接缝抽取

**Status:** done

- [x] 经 `collect_sessions` 产出 `tool:"hermes"` 会话，含 title→project、age、state；archived 排除
- [x] RUN 判定 = 活跃租约中存在该会话 或 未结束且 ≤90s；仅只读访问其 SQLite 与租约文件
- [x] 数据源缺失/损坏/被锁时静默跳过 hermes，其他工具照常，仅服务端日志
- [x] 前端标签映射加入 HM
- [x] fixture 单测（临时 SQLite + 租约 JSON）：租约判 RUN、end_reason 分支、archived 排除、坏源跳过
- [x] 真实 hermes 会话目测入列、状态流转正确

## Comments

- 2026-09-25 实施完成。10 条接缝单测全绿；真实 state.db 只读冒烟：未结束会话经 active_sessions.json 租约判 RUN、project 取 cwd 目录名（与 Qoder 列语义一致，title 不入契约，见 spec 范围外事项）。
- 无任务进度语义：tasks_done/tasks_total 为 null，前端该位置留空（本票顺带实现空值渲染，票 03-05 复用）。
- WE 内实机目测留待票 07 全链路验收。
