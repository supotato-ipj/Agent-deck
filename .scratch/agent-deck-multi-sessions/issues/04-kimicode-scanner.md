# 04: kimi code 扫描器

**What to build:** 壁纸会话列表开始出现 kimi code 会话：带 `KC` 标签，显示其会话标题与项目目录；状态用写入时间启发式（≤90s→RUN，10 分钟内入列），没有任务进度（该位置留空）。只读迁移后的新数据目录，不读已废弃的旧目录。

**Blocked by:** 01 接缝抽取

**Status:** ready-for-agent

- [ ] 经 `collect_sessions` 产出 `tool:"kimicode"` 会话：title/workDir→project、mtime 换算 age
- [ ] 四态启发式：mtime≤90s→RUN，否则按最后记录粗分 DONE/IDLE，不产生 CONFIRM
- [ ] tasks_done/tasks_total 为空值语义（前端留空显示）
- [ ] 数据目录缺失/JSON 损坏静默跳过，仅服务端日志
- [ ] 前端标签映射加入 KC；空任务进度渲染为留空
- [ ] fixture 单测（临时目录）：基本映射、90s/600s 边界、坏 JSON 跳过
- [ ] 真实 kimi code 会话目测入列
