# 05: kimi work 扫描器（降级展示）

**What to build:** 壁纸会话列表开始出现 kimi work 会话：因标题锁在上游私有存储中，行内降级为"工具标签 + 状态"展示（`KW` 标签，无标题无项目名）；状态取其显式状态映射（当前上游只观察到 completed→DONE，未知值容错为 IDLE）；活跃时间借同目录的上下文用量记录换算，10 分钟窗外不入列。

**Blocked by:** 01 接缝抽取

**Status:** done

- [x] 经 `collect_sessions` 产出 `tool:"kimiwork"` 会话：状态映射 completed→DONE、未知值→IDLE、映射文件更新时间≤90s→RUN
- [x] age 来自上下文用量文件的每会话 updatedAt；无 updatedAt 的会话不入列
- [x] project/title 为空值语义，前端降级渲染为工具名 + 状态
- [x] 任一文件缺失/损坏静默跳过，仅服务端日志
- [x] 前端标签映射加入 KW；降级行渲染不破坏列表布局
- [x] fixture 单测（临时目录）：状态映射、未知值容错、缺 updatedAt 排除、坏 JSON 跳过

## Comments

- 2026-09-25 实施完成。8 条接缝单测全绿；真实数据平移冒烟：9 月近期会话映射 DONE、project 空串、前端以 KW 标签 + 状态降级显示。
- RUN 判定用每会话 updatedAt≤90s（比票面"映射文件 mtime"更精确，避免一条新会话把全部旧会话顶成 RUN）。
- WE 内实机目测留待票 07。
