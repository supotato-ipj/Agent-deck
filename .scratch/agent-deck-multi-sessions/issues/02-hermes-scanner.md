# 02: hermes 扫描器

**What to build:** 壁纸会话列表开始出现 hermes 会话：跑一个真实 hermes 任务时，列表中出现带 `HM` 标签的行，运行中显示 RUN（用其活跃租约文件与"未结束"信号交叉判定，长任务不因写入间隙掉出 RUN），结束后按统一四态回落，10 分钟后出列；归档会话永不出现。

**Blocked by:** 01 接缝抽取

**Status:** ready-for-agent

- [ ] 经 `collect_sessions` 产出 `tool:"hermes"` 会话，含 title→project、age、state；archived 排除
- [ ] RUN 判定 = 活跃租约中存在该会话 或 未结束且 ≤90s；仅只读访问其 SQLite 与租约文件
- [ ] 数据源缺失/损坏/被锁时静默跳过 hermes，其他工具照常，仅服务端日志
- [ ] 前端标签映射加入 HM
- [ ] fixture 单测（临时 SQLite + 租约 JSON）：租约判 RUN、end_reason 分支、archived 排除、坏源跳过
- [ ] 真实 hermes 会话目测入列、状态流转正确
