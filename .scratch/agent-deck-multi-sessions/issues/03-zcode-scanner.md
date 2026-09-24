# 03: zcode 扫描器

**What to build:** 壁纸会话列表开始出现 zcode 会话：带 `ZC` 标签，且像 Qoder 一样显示任务进度（done/total，来自其 todo 数据按会话聚合）；归档会话不出现；zcode 正在写入导致库被锁时壁纸无感（该轮静默跳过，下一轮恢复）。

**Blocked by:** 01 接缝抽取

**Status:** ready-for-agent

- [ ] 经 `collect_sessions` 产出 `tool:"zcode"` 会话：title/directory→project、毫秒时间戳换算 age、四态启发式（≤90s→RUN）
- [ ] tasks_done = completed 数、tasks_total = 全部数；无 todo 的会话两值为 0
- [ ] 归档（time_archived 非空）排除；SQLite 以只读 URI 打开容忍 WAL
- [ ] 锁库/坏库/缺库静默跳过，仅服务端日志
- [ ] 前端标签映射加入 ZC
- [ ] fixture 单测（临时 SQLite）：基本映射、todo 计数、archived 排除、锁库跳过
- [ ] 真实 zcode 会话目测入列且进度正确
