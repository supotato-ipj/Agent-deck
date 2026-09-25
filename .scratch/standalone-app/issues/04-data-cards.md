# 04: 数据卡片

**What to build:** 会话与硬件的活数据上卡。五工具（Qoder、kimi work、kimi code、zcode、hermes）会话扫描器移植为 cordis 服务，判定语义逐字段保持：90 秒时间窗判 RUNNING、10 分钟活跃池、SQLite 一律只读 URI、单扫描器失败静默跳过、zcode subagent 会话排除、kimi work 降级无标题；Python 侧对应单元测试整体移植为 vitest 回归网。会话列表卡（最近活跃混排 + 两字母工具标签）、Qoder 状态卡、硬件指标卡（CPU/内存/GPU/网络 + 300 点历史曲线）经桥接契约上线；天气/日历卡（纯前端取数，沿用 Open-Meteo 先例）顺带上车。

**Blocked by:** 02 底座尖兵

**Status:** ready-for-agent

- [ ] 扫描器 vitest 全绿，分支覆盖与 Python 版等价（异常跳过、mtime 判定、任务进度、活跃池）
- [ ] 真机会话数据与旧数据服务输出逐字段对照一致
- [ ] 四类卡片在面板上实时刷新，真机截图存证于工单评论
- [ ] 历史曲线滚动窗口与旧契约一致
- [ ] 任一工具数据源异常不影响其余扫描与硬件采样
