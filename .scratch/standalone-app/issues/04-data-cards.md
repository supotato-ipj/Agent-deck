# 04: 数据卡片

**What to build:** 会话与硬件的活数据上卡。五工具（Qoder、kimi work、kimi code、zcode、hermes）会话扫描器移植为 cordis 服务，判定语义逐字段保持：90 秒时间窗判 RUNNING、10 分钟活跃池、SQLite 一律只读 URI、单扫描器失败静默跳过、zcode subagent 会话排除、kimi work 降级无标题；Python 侧对应单元测试整体移植为 vitest 回归网。会话列表卡（最近活跃混排 + 两字母工具标签）、Qoder 状态卡、硬件指标卡（CPU/内存/GPU/网络 + 300 点历史曲线）经桥接契约上线；天气/日历卡（纯前端取数，沿用 Open-Meteo 先例）顺带上车。

**Blocked by:** 02 底座尖兵

**Status:** ready-for-human

- [x] 扫描器 vitest 全绿，分支覆盖与 Python 版等价（异常跳过、mtime 判定、任务进度、活跃池）
- [x] 真机会话数据与旧数据服务输出逐字段对照一致
- [x] 四类卡片在面板上实时刷新，真机截图存证于工单评论
- [x] 历史曲线滚动窗口与旧契约一致
- [x] 任一工具数据源异常不影响其余扫描与硬件采样

## Comments

**2026-09-27 实现落地 + 验收电池 32/32 跑绿（含一轮 code-review 收编）**

**实现要点**

- **扫描器**（`app/src/main/scanners/`）：`collectSessions(roots, now)` 唯一接缝，Python `agent_sessions.py` 逐字段平移（90s/600s 窗、四态判定、hermes 租约/归档、zcode subagent 排除、kimi work 降级无标题、age 升序）。SQLite 经 `node:sqlite` 只读打开（`readOnly` 选项 = `file:...?mode=ro` URI 的等价物）+ `busy_timeout=500`——库被写方独占时快速失败走静默跳过。默认数据根与 Python `server.SESSION_ROOTS` 同源。
- **Qoder 状态卡数据**：`qoderStatus()` 平移 Python `server._scan_qoder`/`qoder_state`（最近活跃会话的 project/running/tasks/current_task，意外失败回零态）。
- **硬件服务**（`app/src/main/services/hardware.ts`）：1Hz 采样状态机、源可注入（离线测试假源 / 主进程真源）。CPU=`os.cpus()` 差值（psutil 同式、首拍 0）；内存 `os.freemem`；GPU=nvidia-smi 异步 + 3s 缓存（Python 同 TTL，异步不阻塞采样循环）；网络=koffi 直调 `iphlpapi!GetIfTable`（MIB_IFROW 平铺布局，本机与 `Get-NetAdapterStatistics` 交叉实证；32 位计数按接口做回绕差值——较 Python 的 `max(0, cur-prev)` 为有意改进，回绕瞬间不再丢一段真实流量）。300 点历史环（cpu/dl/up/gpu）与 Python `_history` 同构，不可用点 null。逐源 try/catch：任一源异常只缺位对应字段。
- **桥接契约**：`PanelSnapshot` 扩展 `sessions / qoder / hardware{gauges,history} / weather`；tick 1Hz 先刷会话再推送；仪表字段集与旧 `/deck` gauges 一致（含 `memory_gb` 定长格式）。
- **渲染层**：左列时钟/天气/日历，右列会话列表（QD/KC/KW/ZC/HM 工具标签 + 四态 + 任务进度）、Qoder 状态（项目/进度条/当前任务）、硬件（两行定长仪表 + 四条 sparkline 曲线，canvas 按窗内最大值归一）。天气纯前端直连 Open-Meteo（先例平移：当前温/风/湿/降水 + 天气码文案表，10 分钟刷新、10s abort 兜底），坐标 config.json → 快照下发（默认北京）。热区声明覆盖全部六卡。
- **验收电池 P2.5**：四类卡片渲染存证事件（sessions/qoder/hardware-rendered、history-live ≥5 点、weather-rendered/weather-error）+ 左右列截图。

**逐条验收证据（电池 `app/accept/evidence/03-battery.log.txt` 32/32 PASS，截图同目录）**

- vitest **88/88**：扫描器回归网 51（collect 16 / hermes 10 / zcode 10 / kimicode 7 / kimiwork 8）+ 硬件纯逻辑 19 + 服务与契约 8 + config 8 + 存量 wind-restore 5——Python 侧五工具用例整体移植（含活跃窗边界、mtime 判定、任务进度、异常跳过分支）。
- **逐字段对照**：`node scripts/compare-sessions.mjs` 真机实跑——python 1 条 / ts 1 条（zcode），project/state/running/tasks/排序全等、age ±2s 内。注：采样时刻真机活跃池仅此一条（即本工单会话），四态中仅 RUN 得到真机实证，其余三态由 fixture 回归网覆盖。
- **四类卡片实时刷新**：sessions-rendered（count 随真机活跃池变化 0→1）、qoder-rendered、hardware-rendered 第 2 次渲染（1Hz 推送）、history-live cpu 历史累计 5 点滚动；截图 `04-cards-left.png`（时钟/天气 24°C Cloudy/日历今日高亮）、`04-cards-right.png`（会话行 ZC RUN wallpaperengine-research--standalone-app 005/008、Qoder 状态、硬件四曲线）。
- **历史曲线滚动窗口**：HistoryRing 300 点上限单测锁定（推 350 只留最后 300）；`dl/up/gpu` 不可用点 null 与 Python `_history` null 语义一致。
- **数据源隔离**：单测「任一数据源异常不影响其余采样」断言 cpu/mem 存活、gpu/net 缺位不崩；扫描器侧单工具失败静默跳过有专测。

**电池健壮化（真机干扰实测后，属 02/03 探针的适应性维护）**

1. 透明探针改**遮挡感知**：只统计 WindowFromPoint 命中参照窗的采样点（本轮实测电池运行中被用户恢复的视频窗盖住取样带导致 71.8% 假 FAIL；遮挡与面板透明机制正交）。
2. 托盘识别色噪声下限 100→40：显示缩放 1.25→1.0 切换后四点图标实际 64 像素（1.25 时 256），旧下限全部漏检；增量断言仍有基线把门。
3. 截图前对被用户恢复的普通窗再清一轮场（豁免电池控制器与面板自身窗口）。
4. 旧证据位（02/03 截图与日志）随本轮 32/32 全绿电池一并刷新——同一轮电池的连贯存证。

**Code-review 收编（两轴并行评审）**：工单段落并入 `## Comments`、Status 用五标签词汇（done 越界）；bridge 与 config 的北京坐标默认值合一（`defaultWeather()` 单源）；`WeatherConfig` 收敛为契约面 `WeatherLocation` 别名；`SessionState` 字面量联合不再被 `| string` 塌缩；`dirName` 上移 types（不再栖身 hermes）；zcode todo `SUM` 全 NULL 组落 null（Python None 语义）；GPU 读源 try/catch 抽 `readGpu()`；rates 复用 `round1`；`memory_gb` 补齐旧格式 `X GB/Y GB`；历史 dl/up 缺位推 null（与 gpu 对称，不再伪装成 0 流量）；battery 死代码 `checkerHitRate` 删除、同循环 `w32./win32.` 混用与缺分号清理；kimicode 补移植 Python 最后一例（超活跃窗排除）。

**保留项（有意为之，非遗漏）**：网络 32 位回绕差值为 Python 之改进（见上）；JS `Math.round` 与 Python 银行家舍入在 .5 边界可差 0.1（真机浮点 mtimes 落界概率可忽略）；GpuQuery 异步首读导致开机前一两拍 GPU 仪表缺位（换来采样循环不被 nvidia-smi 子进程阻塞）；天气默认坐标北京为可改默认（config.json `weather` 节，先例为壁纸内固定坐标无配置面）。

**残留物**：无（电池清场还原 config/托盘 IsPromoted/桌面窗口/光标；无残留 electron/notepad 进程）。
