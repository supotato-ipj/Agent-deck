# 03: QODER 状态区块垂直切片

**What to build:** 壁纸右栏硬件区块下方出现 QODER 状态区块，实时显示最近活跃 Qoder 会话：RUNNING/IDLE 状态、项目名、任务进度（已完成/总数 + 文本进度条）、当前 in_progress 任务标题（中文原样显示、约 16 全角字符截断）；无活跃会话时显示 OFFLINE 待机态。实施本票的会话自身即可作为数据源完成自指验证。

**Blocked by:** 02 硬件指标垂直切片

**Status:** ready-for-agent

- [x] `GET /performance` 响应新增 qoder 对象：active_sessions（整数）与 session（project、running、tasks_done、tasks_total、current_task）
- [x] 活跃判定：会话记录文件 90 秒内有写入 = 活跃；多会话时 session 取最近写入者
- [x] 任务数据取自会话对应任务目录下每任务 JSON 的 subject/status 字段
- [x] 壁纸轮询函数把 qoder 字段透传给布局构建函数
- [x] 布局覆盖文件渲染 QODER 区块约 5 行，风格与右栏其他区块一致
- [x] 浏览器截图可见本会话实时状态（项目名、进度、当前任务中文正常渲染）
- [x] 定制文件同步进补丁目录

## Comments

- 2026-09-20: 桌面截图自指验证成功：RUNNING 高亮、SESSIONS 001、PROJ=wallpaperengine-research、TASKS 004/007 进度条、NOW=「票02: 硬件指标垂直切片」，中文经 CEF 字体回退正常渲染。
- 2026-09-20: 活跃窗口细化为两级：10 分钟内写入计入 active_sessions 池，90 秒内写入才置 running（使 IDLE 态可达）；与 spec 文字略有出入，语义保持一致。
