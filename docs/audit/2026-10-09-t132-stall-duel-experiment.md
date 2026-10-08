# H1 vs H7 对照实验设计（stall-duel）——工单132 第一阶段

- 工单：#132（第一阶段）；上游：#107（根因票）、#111（假设审计）、#117（哨兵）、#127 转正轮修正输入。
- 日期：2026-10-09。性质：**预登记的对照实验设计**——轮数、判读标准、early-stop 在跑之前定死，防事后挑数据。
- harness：`app/accept/experiments/stall-duel.js`（控制器模式 `electron . --accept-stall-duel`，guard 托管跑）；离线分析 `stall-duel-analyze.js`（纯函数，vitest 直测）。

## 0.x 实验结论（2026-10-09 跑后补记——预登记设计与实际走的路都留档）

**预登记的两臂对照没有走完：r1 一轮就把两臂同时证伪，实验转入消元阶梯，最终由 minidump 栈取证 + 排空干预一锤定音。** 全部 9 轮产物在 `app/accept/evidence/stall-duel/1a/`（r1-kb / r1-sys / r1-raw / r1-still / r1-bare / r2-bare / r3-bare / r4-bare / r5-bare / r6-bare——r2 起 taskbar 配置受控，r4 起排空 stdout，r6 附 stdout 采样）。

| 轮 | 臂 | 消元对象 | 结果 |
|---|---|---|---|
| r1-kb | A 臂（kb 循环+全负载） | — | boot 后 ~13s 终末冻结（第 10 次 keyboard-mode off 后 <1s） |
| r1-sys | B 臂（同负载去 kb） | H1 | ~27s 终末冻结 → **H1 出局**（键盘模式链非必要） |
| r1-raw | 去 CDP 裸负载 | CDP churn | ~27s 终末冻结 → CDP 非必要 |
| r1-still | 纯探针（无鼠标无捕获） | 鼠标流/捕获 | ~29s 终末冻结 → 输入合成/捕获/H7 **出局**（零输入也冻结） |
| r1/r2/r3-bare | 零接触（240s 后单次探活） | 探针/记事本/taskbar 配置 | boot 后 **+15.8s 定时刻冻结**（taskbar on/off 同拍）→ 面板自冻结实锤 |
| r3-bare | — | — | 冻结瞬间 minidump：主线程阻塞在 KERNELBASE 写路径系统调用，栈含 windows.storage/oleaut32/CallWindowProcW/KiUserCallbackDispatcher；全 64 线程 Wait；spans 全闭合（卡点在未标注区，与 #127「不在 11 个子系统内」一致） |
| r4/r5/r6-bare | 零接触 + **排空 stdout** | 写入目标 | **0 停摆、面板全 240s 存活 ×3**；r4/r5 stdout 字节数逐字节相同 = 确定性写入者；r6 采样指认 |

**根因（两层）**：

1. **喂料端**：生产装配（panel-kernel + DataplaneService）不在主进程注册 desktop 服务，TaskbarService 推荐位每拍解析 lnk 的默认兜底读 `ctx.desktop`——cordis 对未声明属性的访问**每次落一条带全栈的 [W] 告警**（~1.2KB × ~5/s ≈ 6KB/s 刷 stdout；工单59 时代的 try/catch 只挡了异常没挡告警）。单测内核注册了 desktop 所以从未复现。
2. **阻塞端**：验收控制器把面板子进程 stdout 接成管道而不排空（battery.js `stdio:['ignore','pipe','pipe']` 只读 stderr，自工单起即如此）——64KB 匿名管道 ~11s 写满，主线程下一次同步写（WriteFile）**永久阻塞**：boot 后 +15.8s 定时冻结，与全部 9 轮观测严丝合缝。

**对历史证据的回读**：#97/#108/#127 全系「主进程假死」即此机制——电池每 (re)拉起一个面板，~15s 后冻死；电池懒探活（只在落点时探）让轮次带伤爬行，heal 重启 → 新面板 15s 后再冻 → 「重启恶性循环/双面板/12 波排除窗」；P9 的「cover-engaged 后卡死」= 电池 ShowWindow 撞上已冻面板（无界阻塞，本票已改 PostMessage 有界化）。#127 的「H4 修正」（守望状态迁移路径）与「真重启仍卡死」全部吻合：面板代际无关、机器态无关，只与「stdout 接管道不排空」有关。用户常驻面板不挂：Explorer 启动的 GUI 进程无 stdout 管道（写无效句柄即失败，不阻塞）。

**假设账**：H1 证伪（B 臂同冻）、H7 证伪（零输入同冻）、H2 证伪（still 臂无热区活动）、H3 托盘链未单独消元但被 bare 臂覆盖（零接触无托盘操作仍冻）、H4 修正版证伪（无 Win+D 仍冻；P9 表象为次生）、H5 既有存档、「stdout 管道写阻塞」为新立主嫌并实锤。

**修复面（第二阶段，同 PR）**：① taskbar.ts 可选 inject 抑制告警（喂料端，单测锁定）；② 电池/控制器 stdout 排空（阻塞端结构防御：battery.js 两处 + taskbar-carry.js + tray-spike.js）；③ P9 恢复等待有界化（PostMessage SC_MINIMIZE）；④ heal 有界唤醒窗（ADR-0011 约束①）。

## 0. 被分辨的假设（引用 #111 审计原文）

- **H1**：键盘模式三连（setFocusable+focus+pinToBottom，`panel-ipc.ts` onKeyboardMode）× 输入合成竞争。预期信号：lag 时 `liveLabels` 含 keyboard-mode-*/pin/hotzone-* 且滞后时刻与 `keyboard-mode-on` 存证时差 <2s（审计 H1-①）。
- **H7**：系统级输入/合成管线竞争。预期信号：注入但禁用 keyboard-mode 通道后停摆仍在（审计 H7-②）；次序跨轮漂移（renderer 先静默 vs main 先停，审计 H7-③）。
- **H4（修正版，#127 输入）**：遮罩守望**状态迁移/通知路径**（cover-engage/release 的 SetWindowPos），非枚举本身。本实验 phase-1a 不含 Win+D，H4 只在 phase-1b（升档）出场。

## 1. 实验臂与共同负载

**对照轴只有一条**：键盘模式链（B1/B2）是否被密集驱动。其余负载两臂严格同款同拍。

| 成分 | A 臂（kb，H1 定向暴露） | B 臂（sys，H7 定向暴露） |
|---|---|---|
| 键盘模式循环 | 每 600ms 交替 on/off（CDP 真实 UI 链路：`search-card` DOM click 开、`search-input` 元素直派 Escape 关） | **无**（压制 B1/B2 活动） |
| CDP 通道 | 同款节奏真 eval | 同款节奏空 eval（`1+1`，控制 CDP 开销面） |
| 鼠标合成 | movePhys 沿固定路径 200ms 一拍（跨面板上缘热区边界与记事本区往返） | 同款同拍 |
| 像素捕获 | capture.ps1（GDI）每 ~3s 捕面板矩形 | 同款同拍 |
| 参照窗 | 记事本 phys(1000,200) 1400x900 | 同款 |
| Win+D | phase-1a 无；phase-1b（`--wind`）两臂同款每 10s toggle | 同款 |

两臂**均无中性点击**：A 臂搜索激活期面板持焦点，任何外点击都会以 blur 抢走 off 沿、污染受控 on/off 语义；索性两臂同删，鼠标移动流（5Hz）是共主输入合成负载。A 臂驱动走**真实渲染层链路**（DOM click → dispatchKeyboardGate → IPC → 主进程 setFocusable+focus+pin），不走旁路注入——B1/B2 的原生激活路径是 H1 的被测对象本身。面板零代码改动（被测二进制 = 分支 HEAD 的原样构建；本实验 harness 全在控制器侧）。

面板以 `--panel-accept` 拉起（taskbar 电池先例）：CDP 通道必需（`--panel` 模式不读 DECK_CDP_PORT），代价是绕过单实例锁与外层守卫链——锁路径不在被测面（#111 审计未列），如实入账。

已知不对称（如实入账，不遮掩）：A 臂搜索浮层开合改变热区声明几何（declareHotZones 全窗热区期）与面板焦点持有期；B 臂无此面。鼠标合成（移动流）是两臂共主负载，键盘/点击合成刻意不用（避免「键落谁家」这个不可控变量）。

## 2. 轮数、时长、排程

- **每臂 ≥3 轮，交错排程 A,B,A,B,A,B**（机器状态漂移均摊到两臂）。
- 每轮：面板拉起（≤20s 窗口就位）+ 240s 驱动 + 收尾（≤30s）。单轮 ≈ 5 分钟，六轮 ≈ 30 分钟真机时间，逐轮经 guard hold（每轮一次独立持槽）。
- **early-stop（升档判据）**：某臂累计 ≥5 个停摆事件即停该臂剩余轮（签名已足）；两臂各跑满 2 轮仍 0 停摆 → 进 phase-1b（`--wind`，加 Win+D 共同负载）重排 3+3 轮；phase-1b 仍 0 停摆 → 结论记「本负载级不复现」，转 #127 形态（P9/cover 过渡）定向取证，不算 H1/H7 定嫌失败。
- **中止保险**：面板终末冻结（探针连续 6 拍超时）→ 本轮提前收场记一个停摆事件（冻结形态），有界清障（panel-control.stop）后视 gone 与否决定是否继续后续轮。

## 3. 观测栈（三方对读，与 #132 票面一致）

1. **harness 侧 WM_NULL 探针**：500ms 一拍，SendMessageTimeout(SMTO_ABORTIFHUNG, 2000ms)——与电池 panelLiveness 同款。连续超时段（间隔 <2s 合并、总时长 ≥2s）= 一个停摆事件，onset = 首拍超时的探测发起时刻。
2. **面板侧滞后哨兵**（既有，DECK_LAG_SENTINEL=1）：main-lag 事件（lagMs/liveLabels/lastEvents）+ spans sidecar（`.spans.jsonl`）——终末冻结时无 close 的 span-open = 卡点签名（#127 已用此法定位 cover 迁移路径）。
3. **面板侧渲染层哨兵**（既有）：renderer-stall 事件（quietMs≥5000），onset = t − quietMs。

harness 自记流水：每次输入合成/CDP eval/探针/捕获的时间戳 → `harness-log.jsonl`。轮产物落 `app/accept/evidence/stall-duel/r<N>-<arm>/`（panel-events.jsonl、spans、harness-log、summary.json）。

## 4. 判读标准（预登记，跑前定死）

设 rateA/rateB = 两臂每轮分钟停摆事件数；couplingWindow = 2000ms。

- **H1 主嫌**：A 臂停摆中 |onset − 最近 keyboard-mode 迁移沿| ≤ 2s 的占比 ≥ 0.5，**且** rateB < 0.5×rateA（或 B 臂 0 事件）；佐证：对应 main-lag 的 liveLabels 含 keyboard-mode-*/pin/hotzone-*。
- **H7 主嫌**：两臂事件各 ≥3 且 rateA/rateB ∈ [0.5, 2]，两臂 coupling 占比均 < 0.3，且次序签名跨轮漂移（renderer-first 与 main-first 在不同轮都出现）；佐证：liveLabels 分散、无单一标签主导。
- **H4（修正版）主嫌**（仅 phase-1b 可达）：两臂停摆中 |onset − 最近 Win+D| ≤ 2.5s 占比 ≥ 0.5，且 spans 终末无 close 的 span-open 为 cover-engage/cover-release。
- **盲区波标注**：无前置 renderer-stall 记录的停摆事件如实标「盲区波」，不冒充有观测窗样本（票面原文要求）。
- 判读产物：`duel-verdict.json` + 结论评论进 #132 证据链（三方数据互相引用：探针账 ↔ 排除窗账 ↔ spans）。

## 5. 边界与不做

- 不改面板代码、不改电池断言与清单（实验 harness 是控制器侧新增入口，不登记 manifest——它不是验收段，是取证工具）。
- 不与 #91（阈值调优）、#118/#119（独立取证）并案。
- 实验轮产物不作为合并门证据，只作为 #132 定嫌证据链。
