# 01: 系统级鼠标卡顿根因修复（fix 步）

**What to build:** 定位并消除面板运行期的全系统鼠标卡顿（用户实测：间歇阵发、退出面板即恢复、143Hz 屏感知明显）。要求实证根因而非猜测，修复后以可复现指标证明消除（事件循环探针 + CPU 采样 + 全量电池），并立结构性决策防止复发。

**Blocked by:** （无——独立工单，grill-with-docs 流程两轮访谈定方案）

**Status:** done（2026-09-30 用户手感验收通过，随本工单合入 master）

- [x] 根因实证：静态审计 + 基线测量双重定位（主进程每秒被阻塞 ~300ms，与 1Hz tick 同相）
- [x] 去 forward 低级鼠标钩子（全系统输入管线的阻塞通道）
- [x] 四个采集服务整体移入 utilityProcess 数据面子进程
- [x] 附带：热区离开去抖、重钉节流、nvidia-smi TTL 3s→5s
- [x] 离线测试 451/451 全绿（含 2 个新测试文件）
- [x] 验收电池 71 PASS / 1 FAIL（唯一失败为环境项，见下）
- [x] ADR-0005 立案 + README 更新 + 测量证据归档（`.scratch/mouse-lag/`）
- [x] 用户 10 分钟主观手感验收通过（2026-09-30）

## Comments

**2026-09-29 根因（静态审计 × 基线实测互证）**

三件事叠在同一条主进程线程上：

1. `setIgnoreMouseEvents(true, { forward: true })`（窗口创建 + 每次离开热区恢复）令 Electron
   44.4.3 在主进程装全局 `WH_MOUSE_LL` 低级钩子——系统每个鼠标事件串行等它返回；
2. 同线程周期采集：每 1s 会话扫描（两个 SQLite `DatabaseSync`，锁库 `busy_timeout=500` 最坏
   堵 500ms）+ 桌面重扫（`fuseScores` 里未缓存的同步 `readShortcutLink`×3N/秒）+ 每 2s 全系统
   进程枚举（EnumProcesses + 逐 pid 3 次 FFI ≈ 900+ 次/轮）；
3. 整屏窗口放大：钩子把全屏每次鼠标移动复制进 Chromium 做 `:hover` 重算，而渲染层无任何
   mousemove 消费者。

基线探针（`--inspect` 注入 50ms 心跳，140s）：≥150ms 停顿 **139 次**、p99=367ms、max=2302ms，
时间戳与 1Hz bridge tick 精确同相；主进程 CPU 均值 **35.29% 单核**（p95=68.8%）。WE 经用户
隔离实验排除（退出面板即恢复）。

**2026-09-29 修复（用户批准：1a 去 forward / 2b utilityProcess / 3b TTL 拉长 / 立 ADR / 分工确认）**

- 去 forward：穿透一律不带转发（panel-window.ts / hotzone.ts）；悬停由热区解除穿透后的真实
  事件驱动（≤25ms 点亮）；热区离开两拍去抖 + 离开重钉 500ms 节流（index.ts）。
- 数据面搬家：`dataplane-protocol.ts`（消息形态 + 凑批/在途去重的 lnk 解析代理）、
  `services/panel-data.ts`（`PanelDataPort` 接缝 + 进程内装配 LocalPanelDataService）、
  `services/dataplane.ts`（utilityProcess 宿主：快照转发/图标预热/lnk 代理解析/写路径 RPC/
  崩溃退避重启）、`dataplane.ts`（子进程入口）、`kernel.ts` 新增 `createDataplaneKernel`、
  `panel-kernel.ts`（Electron 专用主进程装配）。`createKernel` 原样保留（测试与契约缝不动），
  渲染层与桥接契约零改动。DesktopService 图标面可选化（`extractIcon: null`）。
- 顺带消灭每秒 3N 次未缓存 `readShortcutLink`：经代理缓存后 `fuseScores` 的 resolve 变查表。

**修复后同法复测（140s）**：≥150ms 停顿 **0 次**（max=68ms）；主进程 CPU 均值 **1.82% 单核**
（16 核整机 0.11%），≥10% 尖峰 205→8；采集负载整体落入 utility 子进程（0.07%→3.78%）；
GPU 进程 max 46.9%→9.4%。数据存 `.scratch/mouse-lag/`（README 含复测方法）。

**实施插曲两则**：

1. 首版 `DataplaneService` 直取 `ctx.bridge?.push()` 每拍触发 cordis「未注册访问」警告
   （145 次/140s，实测确认仍返回实例、推送未断）；改为 `dataplane/snapshot` 事件解耦后归零。
2. 电池两个偶发失败均查实为环境：本机负载下 powershell.exe 启动实测 6.4s（探针 lnk 的
   10s 断言窗与 GDI 截图的 20s 超时先后触发；标记文件最终都写了，重跑即过）；
   `工具映射启动目标缺失：kimicode` 为 config 默认值指向 `D:\programs\Kimi Code`（本机无此路径）。
   另修真 COM 集成测试在并行负载下的 5s 临界超时（autostart.spec 显式 15s 限时）。

**遗留**：kimicode 路径若本机确装有此工具，改 `config.json` 的 `tools.kimicode.launch` 即可
消掉该环境项失败；生产机器（工单11 装自启的那台）需 `git pull && npm run build` 后重启面板
才带上本修复——本机无生产检出（`D:\local_works` 不存在），当前运行的面板即 worktree 修复版。
