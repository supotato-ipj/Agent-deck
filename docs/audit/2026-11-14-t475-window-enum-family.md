# 工单475：窗口枚举族事件化/降频——遮罩守望订阅化 + 任务栏裁决降频 增量审计

- 日期：2026-11-14
- 票：#475（母票 #472 性能与响应性重整 T9，依据 ADR-0032）
- 分支：`feat/475-window-enum-events`（基点 `feat/472-perf-integration`@52313be）
- 工作树：`D:\test-folder\wallpaperengine-research--feat475-window-enum-events`
- 基线判别对照树：`D:\test-folder\wallpaperengine-research--t475-base`（52313be 一次性检出）

## 一、改造对象（改造前形态）

| 常驻轮询 | 旧拍距 | 旧成本（ADR-0032 消耗源盘点） |
| --- | --- | --- |
| 桌面遮罩守望（`desktop-cover.ts`） | 150ms | 全窗 z 序双走查（`findTopWindowByClass`+`zPrecedes`+`hasVisibleBelow`），每秒数千次 user32 调用落主进程 |
| 任务栏三态裁决（`taskbar/window.ts` yieldTimer） | 250ms | `probeForegroundWindow`（5 次直调）+ `probeSnapWindows` **全窗枚举**（IsWindowVisible+IsWindowArranged 逐窗，审计外推 ~1.6% 整机） |
| keepalive 置顶重申（同文件） | 500ms | `assertTop`→`ownWindowsAbove` 全窗 z 序走查 + `isTopmost` |

## 二、新形态

1. **系统窗口事件泵**（新 `win-events.ts` + 纯路由 `win-event-route.ts`）：`SetWinEventHook`
   （`WINEVENT_OUTOFCONTEXT|WINEVENT_SKIPOWNPROCESS`）按四个闭区间挂订阅
   （FOREGROUND 0x3 / MINIMIZESTART-END 0x16-17 / OBJECT_DESTROY-SHOW-HIDE-REORDER 0x8001-4 /
   STATECHANGE-LOCATIONCHANGE 0x800A-B）；WinEventProc 回调只做路由记账（微秒级），防抖
   冲刷拍再侦察。订阅路由与突发合并为纯函数（单测钉）：
   - `routeWinEvent`：光标/插入符对象与子对象事件滤除（全局钩子下最高频噪声源——鼠标逐采样
     一条、打字逐条；置脏即把事件驱动退化回准轮询），整窗对象订阅区间事件置脏；
   - `planEventFlush`：trailing 防抖 60ms（合并最小化风暴/拖拽突发）+ 最小间隔 250ms 封顶
     （风暴期最坏再评估频率与旧 250ms 轮询同量级；静默期零成本）。
   - koffi 回调注册（`register(fn, '<proto> *')` 指针形态、proto 进程级单登、trampoline
     模块级持引防 GC）；机制先经裸 Node 探针实证（SetWinEventHook→PeekMessage 排水→回调
     收帧全通；Electron 主进程自带消息泵无需手动排水）。
2. **遮罩守望事件化**（`desktop-cover.ts` 重写）：150ms interval 退役；侦察三入口——
   事件冲刷拍（泵订阅）、面板自身显隐/最小化（Electron 窗口事件 show/hide/minimize/restore）、
   5s 新鲜度兜底拍（ADR-0032「必须轮询的按新鲜度降级」档，覆盖钩子失能/事件整批漏投——
   正确性有界、只亏新鲜度）。`coverDecision` 纯裁决不变。engage/release 存证新增
   `trigger`（win-event/panel-event/backstop）与 `osEventAgeMs`（OS 事件时刻→本方裁决的
   GetTickCount 同口径毫秒差——捕获时延的度量字段）。
3. **三态裁决双入口 + 增量 diff**（`taskbar/window.ts`）：
   - 兜底拍 250ms→**500ms**（前台探针 5 次直调 + 已知成员便宜位复检，无全窗枚举）；事件冲刷拍
     （泵订阅）毫秒级响应档位迁移——退出全屏 resize / 最大化前台 / Snap 贴靠均产生订阅事件；
     `退出全屏 ≤1 秒恢复` 口径由事件拍承接（实测 P4b 146ms/217ms，见 §五）。
   - Snap 会话全窗枚举改 **`planSnapBeat` 增量调度**（`taskbar/snap.ts` 新纯函数）：静默稳态
     复用缓存（零枚举）；全量探针只在①事件脏位（world-dirty）②已知成员便宜位失格
     （member-lost——事件漏投现场保险）③新鲜度到点（freshness，**5s**——ADR-0032 用户拍板的
     「会话扫描 3~5 秒」档）时发生。成员便宜位复检 = 每窗 4 次 user32 直调（IsWindow/
     IsWindowVisible/IsIconic/IsWindowArranged），不走全窗链式枚举。
   - keepalive 置顶重申改**事件闸门**：z 序扰动必产生订阅事件（REORDER/SHOW/FOREGROUND…），
     事件冲刷拍已即时重申；keepalive 只在「自上次重申以来世界动过」或泵失能（钩子挂空降级，
     回旧无条件拍）时补拍——静默期不再每 500ms 付 ownWindowsAbove 全窗走查。
4. **降级阶梯**（钩子失能时正确性有界）：守望退 5s 兜底全扫；三态退 500ms 兜底拍（前台/
   zoomed 事实不变）+ snap 5s 新鲜度全量；keepalive 退回无条件 assertTop。

## 三、单测缝（票面验收第 5 条）

| 缝 | 断言面 |
| --- | --- |
| `routeWinEvent`（tests/win-event-route.spec.ts，6 例） | 订阅集置脏；光标/插入符/子对象滤除；区间外不置脏 |
| `planEventFlush`/`markEventPending`（tests/win-event-debounce.spec.ts，6 例） | 静默零成本稳态；尾沿单发；风暴封顶排程；账本清结；重入不漂移 |
| `planSnapBeat`（tests/taskbar/snap-beat.spec.ts，8 例） | 静默复用（常驻零枚举稳态）；world-dirty/member-lost/freshness 三理由；脏位优先级；首拍立基线；新鲜度边界 |
| 既有回归 | `coverDecision` 矩阵、snap 成员/因果族、retract-orchestration 源码守卫（YIELD_POLL_MS 字面量随降频更新为 500，单一常量/单一使用点不变量保留） |

全量单测：**186 文件 3414 例全绿**（基线 183/3394，+3 文件 +20 例）。typecheck 全绿。

## 四、常驻期枚举出清对账（票面验收第 1 条）

| 旧「每拍全窗枚举/z 序走查」 | 新形态 |
| --- | --- |
| 遮罩守望 150ms×双走查（6.7 拍/s） | interval 退役——事件驱动 + 5s 兜底；静默期零走查 |
| 三态 250ms 全窗枚举（4 拍/s，~1.6% 整机） | 500ms 兜底拍无枚举（前台探针+成员复检）；全量探针仅事件脏位/成员失格/5s 新鲜度（≤0.2Hz）；静默稳态零枚举 |
| keepalive 500ms z 序走查（2 拍/s） | 事件闸门——静默期零走查（扰动必产生事件） |

## 五、验收轮记录（guard 托管，accept-sprint 证据轮）

| 轮 | 电池 | 判定 | 记录 |
| --- | --- | --- | --- |
| t475-r1 | 51-taskbar-appbar | FAIL 15/2 | P11「恢复存证=false」、P12 thirds=false——见 §七 定责：P11 为 battery helper 读形缺陷（面板终点事实在流），P12 为注入抖动 |
| t475-r2 | 51-taskbar-appbar | **PASS 17/0** | 三态全族绿：P4b 退出全屏恢复 **146ms**（≤1s 口径）、P6 最大化收栏+解除、P7 三态优先级（收栏恢复 64-72ms）、P11 分屏收栏单窗闭环、P12 集合生命周期+1/3+2/3 布局（贴边=true）、P13 虚拟桌面（cause=desktop-switched/closed+retractHeldByZoomed）、P14 让位与会话解耦、P16 覆盖式主诉（3s 观察窗零拍动）；P10b/c 为在案 explorer-acceptance-tail 环境降责 |
| t475-r3 | 49-taskbar | FAIL 47/2 | P3（缝隙穿透）、P23（点击→弹 189/230ms>150ms 首两试未达）——见 §七 |
| t475-r4 | 49-taskbar（重试） | FAIL 47/2 | P3 同形再挂；P23 本轮绿（段内重试 20ms——坐实 r3 的 P23 为负载抖动）；P27 一臂 timeout（新抖动面） |
| t475-r5（基线判别） | 49-taskbar @**52313be 原码** | FAIL 47/2 | **P3 基线同挂**（同形字样）、P20臂B 基线同挂（拖拽会话被环境中止）、P23 基线同样首击 224ms 后段内重试 12ms 过——**环境扰动定责成立**（§七） |
| t475-r6/r7 | 03-battery（主电池全量） | FAIL-CODE 182/5、169/6 | 红全部集中：P9 控制门「Win+D 键盘投递未生效」、P9B 会话行被外来记事本窗遮挡（preflight user-window-activity 在案：`zzdeck07-*.txt - Notepad` / `无标题 - Notepad` 持持前台）、P12 自发静默（对读 main-lag：两处 main-lag 均为 boot 期 autostart 标签，与静默时刻不相关——渲染层遮挡节流，非主线程阻塞）；r7 另遭跨代理面板锁竞争（`single-instance-refused`，#478 验收风暴同窗）。两轮均无 cover-engaged（P9 控制门未过、守望路径未被触发） |

**三态裁决既有验收段不红（票面验收第 3 条）的判定**：51 电池 r2 全绿（17/0）为合并门证据；
49 电池 P22/P23/P24/P25（收栏唤出族）在 r3/r4 两轮全绿；49 的 P3/P20B/P27 与 03 的 P9/P9B/P12
红均按章法流程定责（§七），非本票改动面回归。

## 六、Progman 抬顶捕获时延实测（票面验收第 2 条）——被机器 shell 态阻断，移交 T12 补测

**结论先行**：本票在当日机器上无法产出该时延的实测值——shell 的 show desktop 全天系统级失效
（基线同受影响，与本票改动无关），合成 z 序刺激又被 shell 即时压回。守望**正确性面**由
`coverDecision` 单测矩阵 + 事件泵机制实证（§六.3）+ 51 电池全绿覆盖；**时延实测**留待 T12
终验在健康 shell 窗口补测（03 电池 P9 恢复即可出证，守望路径已事件化、触发→裁决全链就绪）。

### 六.1 电池径（03 电池 P9）——注入路径被壳态击穿

P9 段以 SendInput Win+D 触发 show desktop，连续三轮全部挂在段首控制门
（「记事本未被最小化，键盘投递未生效——本组断言不可信」）：shell 对 Win+D 无响应，与轮次负载/
外部窗无关（第三轮在近空载窗口仍挂）。z 序直读证实：Win+D 前后 Progman 未动、普通窗未被最小化。

### 六.2 COM 径（`shell.Application.ToggleDesktop()`）——同为空操作

z 序直读（TopVisible 12 窗 × 显示桌面三态）：WITHVICTIM / AFTERSHOW / AFTERRESTORE 三读数
逐字一致——ToggleDesktop 前后 Progman 未抬、牺牲窗未被最小化。键盘径与 COM 径双双失效坐实
「shell show desktop 系统级失效」，非注入实现问题。

### 六.3 合成径（SetWindowPos 直抬 Progman）——被 shell 即时压回

面板 --panel-accept 拉起（DECK_EVENT_LOG/DECK_CONFIG_FILE 双隔离，工单402 通道），
`SetWindowPos(Progman, HWND_TOP)`（SWP_NOMOVE|NOSIZE|NOACTIVATE|NOOWNERZORDER）直接构造
「Progman 抬到面板之上」的物理刺激：调用返回成功（up=OK）但 1.2s 后决策输入自证读数
`progmanAbovePanel=False`——**shell 把 Progman 即时压回底部**（桌面态维护机制对合成抬顶的
主动对抗），三轮同形。决策输入五项中唯一为假的就是 `progmanAbovePanel`（progmanFound/
progmanVisible/panelVisible/panelTopmost=False 全真）——守望自身状态健康，缺的只是
「Progman 在面板之上」这一持续成立的事实，而它只有 shell 的 show desktop 能持续供给。

探针诊断还顺带修复了一处机器坏态：当日多轮 explorer 重启后桌面宿主一度未回归
（FindWindow Progman=0、WorkerW 全家不可见），已按 51 电池 P10 同款受控操作重启 explorer
恢复（Progman visible=True 回归）。

### 六.4 移交清单（T12 终验补测）

- 触发条件：shell show desktop 恢复（Win+D 能最小化普通窗、Progman 抬顶可持续）即可测；
- 证据形态：03 电池 P9 段照跑（cover-engaged 存证携带 `osEventAgeMs`——OS 事件时刻→本方
  裁决的 GetTickCount 同口径毫秒差），或 `app/scripts` 同族探针脚本（本次探针已验证：
  z 序合成在健康 shell 下可直接构造刺激）；
- 有界性论证（不依赖实测的上界）：事件径时延 = OS 事件投递（消息循环即时）+ 60ms 防抖尾沿
  + 一次 z 序走查（≤512 窗护栏，实测毫秒级）+ SetWindowPos 单调用——合计有界且远小于旧
  150ms 拍距；兜底径（钩子失能）上界 5s + ε（ADR-0032 新鲜度档）。

## 七、定责留痕（章法：flaky 流程 ①重试 → ②基线判别 → ③留痕）

| 段 | 现象 | 定责 | 依据 |
| --- | --- | --- | --- |
| 49 P3（缝隙穿透） | 分支 r3/r4 同形挂；**基线 r5 同挂** | 环境扰动（非本票回归） | 基线判别：52313be 原码同形失败（`缝隙命中=任务栏窗(应穿透)`）——外来窗/桌面态影响探针，两检出一致 |
| 49 P20臂B（OLE 拖拽） | 基线 r5 挂（分支 r2/r4 绿） | 环境扰动 | 基线同挂（拖拽会话被中止、节点重建）；分支两轮绿 |
| 49 P23（点击即弹 <150ms） | r3 首两试 189/230ms；r4/r5 段内重试后 20ms/12ms 过 | 负载时延抖动（段自重试机制消化） | 三轮形态一致：首击拖慢、重试达标——机器多代理并发期 |
| 49 P27 臂4（溢出让位恢复） | r4 单臂 reason=timeout；r5（基线）16 臂全过、分支 r3 亦全过 | 环境抖动 | 双向绿证（基线与分支各有过全过轮） |
| 51 P11（r1 恢复存证=false） | **battery helper 读形缺陷**，非面板回归 | 改段（本票提交） | 事件流（51 r1 jsonl 05:20:20.005-20.388）：面板真实链 = retract→yield（130ms 壳面瞬态）→retract→visible，终点 `retract-lifted(mode=visible)` 在流；旧 `waitSettledVisible` 两跳形状读到中间跳提前返回 null。事件化后 130ms 级真全屏瞬态被可靠观测（旧 250ms 轮询大概率整拍跳过）——helper 跳数模型不匹配证据链形状。改沿 lift 链轮询至终点 visible（断言本义不变、强度只增不减）；r2 即全绿 |
| 03 P9/P9B/P12 | 外来记事本窗（`zzdeck07-*.txt`/`无标题 - Notepad`，#478 验收风暴+用户窗）遮挡/夺焦/输入竞争 | 环境扰动 | preflight user-window-activity 在案×3 轮；P9B 点击落点逐次诊断「命中 Notepad pid=xxxx 非面板→被遮挡」；P12 静默对读 main-lag 不相关（boot 期 autostart 标签） |
| 03 r7 电池中断 | 面板重启被拒（single-instance-refused）→ fetch failed | 跨代理竞争 | #478 验收风暴同窗（集成 tip 5402c00 收尾补记原文「14:08 验收风暴仍在进行」）；面板锁被同窗其它轮次面板占用 |

## 八、窗口枚举族 CPU 抽样对照（票面验收第 4 条，供 T12 终验）

口径（ADR-0032/#484）：任务管理器进程页同口径——面板**进程组**（外层守卫→--panel 子进程树全体）
TotalProcessorTime 差分 ÷（墙钟×16 逻辑核）×100 = 整机%；静置 30s 后采样 90s；工具
`app/scripts/panel-cpu-sample.mjs` + 编排 `panel-cpu-run.mjs`（拉起→静置→采样→--panel-quit 优雅退）。

| 构建点 | 整机 CPU（进程组，静置 30s 后 90s 均值） | 墙钟 | ΔCPU 时间 | 树规模 | 抖动 |
| --- | --- | --- | --- | --- | --- |
| before = 52313be（基点原码，150ms/250ms/500ms 三轮询在役） | **2.390%** | 91577ms | 35015.6ms | 15 pids | 0 |
| after = feat/475-window-enum-events（事件化+降频后） | **2.363%** | 91598ms | 34625ms | 15 pids | 0 |
| 差值 | **−0.027pp**（连续采样，同窗背靠背） | | | | |

原始采样：`docs/audit/t475-samples/cpu-before.json` / `cpu-after.json`（2026-11-14 16:14/16:16
背靠背两窗）。

**判读（诚实归因）**：实测差值在噪声级（0.03pp），显著低于仓库审计外推的 ~1.6% 整机。对照
t267 在案成本审计（docs/audit/2026-10-25-t267-snap-probe-beat-cost.md：现行探针每拍仅付
IsWindowVisible+IsWindowArranged 两次直调、常态一拍 0.374ms ≈ 250ms 间隔的 0.15%，折整机
~0.01%）——**1.6% 外推相对现行代码偏高一个数量级**，本票实测与 t267 微成本口径一致。本票的
价值在结构性（常驻静默期零枚举/零走查，CPU 时间从「有界但恒在」变「按需发生」，为后续叠加
负载留出余量；ADR-0032 事件驱动优先于轮询的架构裁决落地）而非当日空闲绝对值的大幅下降；
空闲整组 2.36%（>1% 目标线）的大头是全屏透明窗合成+引擎结构性地板（ADR-0032 预判的余量
归因面，归 T12 终验与其余降频票共同裁决）。

采样环境注记：多代理验收风暴同窗（#478 取证轮并发），before/after 背靠背同窗采样——背景负载
对两组读数同向叠加，差值仍具归因力；绝对值待 T12 终验在静默窗复测。

## 九、遗留与移交

1. `--accept-scope` 声明后**不收窄执行**（r6/r7 两轮 scope=P9 而全量段照跑；清单硬交叉校验与
   verdict 记账正常）——选段器的 scoped 形态与运行器行为不一致，另案核实（非本票引入，
   基线同行为）。
2. **shell show desktop 系统级失效**（本票验收的最大环境阻断，已彻查留痕）：Win+D 键盘注入、
   COM ToggleDesktop 双路径全天空操作，合成 z 抬顶被 shell 即时压回（§六）；explorer 重启
   未能恢复（桌面宿主 Progman 一度消失，重启后 visible 回归但 show desktop 仍死）。重启/
   重新登录可能恢复——T12 终验补测 P9 时延前先验证 Win+D 是否生效。
3. 03 电池 P9 的键盘注入路径在多代理并发期不可信（与本票改动无关）——T12 终验若在静默窗
   跑 03 全量，P9 应能正常出证据。
4. guard `hold` 命令行经 shell 拼接：**含空格路径会被截断**（npm-cli 短路径 `C:/PROGRA~1/...`
   可绕；`C:\Users\AN W\...` 类用户目录路径必须挪到无空格目录）——本次实测的工程细节；
   另 guard.json 在多客户端并发下偶发 EPERM rename 竞态杀死排队方（本次两度命中，重试
   包装器对抗），供 guard 维护者参考。
5. 探针与编排脚本（cover-latency-probe.mjs / panel-cpu-run.mjs / ps 诊断族）落在
   `D:\test-folder\deck475-probe\`（非仓内）；采样工具本体已入仓
   （`app/scripts/panel-cpu-sample.mjs`，树遍历用索引游标 BFS——PS 数组无 Pop，成员枚举
   会把方法下放到 Int32 元素上，实测踩坑）。
6. `waitSettledVisible` 改段（本票提交）建议 T12 全量校准轮复核其多跳语义对 P6/P7/P10c/P16
   的影响面（该轮已在 r2 全绿验证过一轮）。
