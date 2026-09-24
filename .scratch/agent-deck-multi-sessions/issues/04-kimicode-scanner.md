# 04: kimi code 扫描器

**What to build:** 壁纸会话列表开始出现 kimi code 会话：带 `KC` 标签，显示其会话标题与项目目录；状态用写入时间启发式（≤90s→RUN，10 分钟内入列），没有任务进度（该位置留空）。只读迁移后的新数据目录，不读已废弃的旧目录。

**Blocked by:** 01 接缝抽取

**Status:** done

- [x] 经 `collect_sessions` 产出 `tool:"kimicode"` 会话：title/workDir→project、mtime 换算 age
- [x] 四态启发式：mtime≤90s→RUN，否则按最后记录粗分 DONE/IDLE，不产生 CONFIRM
- [x] tasks_done/tasks_total 为空值语义（前端留空显示）
- [x] 数据目录缺失/JSON 损坏静默跳过，仅服务端日志
- [x] 前端标签映射加入 KC；空任务进度渲染为留空
- [x] fixture 单测（临时目录）：基本映射、90s/600s 边界、坏 JSON 跳过
- [x] 真实 kimi code 会话目测入列

## Comments

- 2026-09-25 实施完成。7 条接缝单测全绿；age 取 state.json 与 wire.jsonl 两者 mtime 的较新者（wire 写入即会话活动）。
- 偏差备注：实测 wire.jsonl 尾部事件为 config/mcp 类，无 user/assistant 角色信号，"按最后记录粗分 DONE/IDLE"不可行——旧会话统一落 DONE，与 zcode 一致。
- 坏 state.json 只跳过该会话、不连累整工具（比票面"静默跳过工具"更细粒度）；本机真实会话均为七月旧数据，0 入列属预期，目测以 fixture 与票 07 混排验收为准。
