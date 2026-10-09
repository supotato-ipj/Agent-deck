# 工单118 取证报告：停摆遗留面板进程「内核级不可杀」之证伪与归因修正

- 日期：2026-10-09
- 取证人：zcode（工单118 认领会话）
- 实验工具：`app/accept/experiments/kill-forensics.js`（本 PR 合入；取证工具不进 manifest、不产 verdict）
- 证据目录：`D:\test-folder\.agent-notes\t118-kill-forensics\`（对账笔记 + 各轮 round 目录 + dump 分析脚本）

## 0. 结论速览

| # | 问题 | 结论 |
|---|---|---|
| C1 | 满管道写卡死（#132 根因形态）的进程，同完整性 taskkill 能否杀灭 | **能**：R1 `taskkill /F /T` 214ms 收尸（s1） |
| C2 | 读端死后，卡在管道写的写者能否自行解除 | **能**：proxy 死后 213ms 写者解除并退出（s2） |
| C3 | 卡在对挂死窗同步 SendMessage 的发送者能否被杀灭 | **能**：R1 205ms 收尸（s3） |
| C4 | 真面板不排空 stdout 复现停摆后，可杀性/读端死亡反应 | **当前机器态复现不出停摆**：干净桌面裸起+不排空 360s 全程健康（事件账零 main-lag）；健康面板全树 R1 `taskkill /F /T` **208ms 杀灭、零残留**。冻结形态的可杀性由 S1 等价论证承接（同 KERNELBASE 同步写等待点，t132 r3-bare 真面板 minidump 锚定） |
| C5 | 票面「管理员强杀仍不退」 | **未证实**：全档证据对账无一次管理员杀灭失败样本；唯一一次提权清扫成功 |
| C6 | 「仅重启可清」 | 现场成立（10-08 两僵尸驻留至 10-09 00:05 重启），但与 C1-C4 合并后归因修正为：**不存在「内核级不可杀」机理；僵尸=未被任何人杀过的高完整性/终止态孤儿**（见 §3 归因） |

**一句话**：在受控复现的三种内核等待卡死形态（含 #132 定案的满管道写）与真面板停摆形态上，**同完整性的普通 `taskkill /F` 都是毫秒级杀灭——「停摆进程内核级不可杀」不成立**；管理员 Stop-Process 从未失败过；历史僵尸的真实成因是「无人以足够权限出手」而非「杀不动」。

## 1. 证据对账（静态）

时间线与断言核对详见同目录 `reconciliation.md`。要点：

1. **唯一一次提权杀灭（10-07 19:34）成功**：`Stop-Process -Force` 杀 7 electron + cua-driver，2s 复查 ALL-CLEAR。票面「管理员强杀仍不退」找不到任何失败样本。
2. **final4 冻结面板生于清扫之后**（19:35 开跑），从未被提权杀过；其控制器死于 ShowWindow 12 分钟阻塞（观察者之死，非目标不可杀——t111 已证）。
3. **10-08 两僵尸只被非管理员杀过**（Access denied），管理员从未对它们出手；其 ExecutablePath 不可读与 64K 工作集同样兼容「终止态/高完整性对象拒开」的解释。

## 2. L1 合成实验（S1/S2/S3，普通完整性，2026-10-09 午）

每臂形态：被试卡死确认（PS 线程态 Wait + minidump 模块归属）→ 杀灭阶梯 R1 `taskkill /F /T` →（仅当存活）R2 koffi 直调 `TerminateProcess`，每档 60s 观察窗。

| 臂 | 卡死形态与验证 | 阶梯结果 |
|---|---|---|
| s1 | 写者 `fs.writeSync` 循环写不被读取的 stdout：主线程 Wait（forensics `Wait/Executive`），dump 主线程归属 node.exe+KERNELBASE+ntdll（同步写路径，t132 定案同款） | **R1 杀灭，deathMs=214ms**；preOpen 探针 `opened:true` |
| s2 | 同 s1 但读端经 proxy 持有；杀 proxy（204ms 死）后 | **写者 213ms 自行解除退出**（管道断→写失败→进程自灭）——无需任何人杀 |
| s3 | 发送者 `SendMessageW` 到永不泵消息的 message-only 窗：主线程 Wait、无 send-returned，dump 主线程归属 node.exe+KERNELBASE+ntdll（win32k 同步发送路径） | **R1 杀灭，deathMs=205ms** |

**判读**：

- 三种内核等待卡死形态全部被同完整性普通 taskkill 毫秒级收尸——`TerminateProcess`（taskkill /F 的底层原语）对滞留内核同步等待的用户线程**不存在「杀不动」**。Windows 文档语义（终止不要求线程配合用户态返回）与实测一致。
- S2 直接否定「管道写卡死的孤儿会无限滞留」：读端句柄一关，写者在 ~200ms 内解除。10-08 僵尸「父进程已死仍存活数小时」**不能**由 #132 停摆机理（stdout 管道写卡死）解释。

## 3. 归因修正（僵尸的真实成因）

C1-C3 与对账事实合并，10-08 两僵尸最自洽的解释链：

1. 出生：夜间会话中面板停摆（彼时 #132 根因未修）或其子进程未被收割 → 孤儿；
2. 「不可杀」表象：**唯一的杀灭尝试来自非管理员 shell**——对高完整性或已处于终止态的对象，`OpenProcess(PROCESS_TERMINATE)` 拒开，taskkill 报 Access is denied。这是**权限/对象状态的预期行为**，不是内核杀灭原语失效；
3. 「仅重启可清」：无人再用正确权限重试，重启顺理成章成了唯一被实际执行过的清障手段。

S4（高完整性孤儿拒杀）以文档引证带过：中完整性调用者对高完整性对象无 PROCESS_TERMINATE 权限，Access denied 属 ACL 预期，与内核等待无关。

## 4. L2 真面板实验（accept-guard 托管，selftest 相位）

两轮（round 目录 `panel-2026-10-09T*`）：

1. **首轮失败（流程教训）**：worktree 未 `npm run build` 即拉面板，25s 无窗退出；且失败路径泄漏 proxy 子进程钉住 harness 事件循环，guard 槽滞留 25 分钟（应急解锁自救）。harness 已修：失败路径清场 + 硬退出（`process.exit`），proxy stderr 落盘。**此事故本身复演了「无人杀的孤儿」形态**——被 TaskStop 连树收割，未留残留。
2. **二轮完整（build 后）**：真面板 `--panel-accept` + 不排空 stdout（proxy 持读端不读，复现 #132 前条件）+ taskbar off 对齐主电池跑法，360s WM_NULL 探针全程应答——**停摆未复现**。事件账佐证健康：boot/hotzones/插件 6 挂载/时钟走数，182 条 tray-competition，零 main-lag、零 renderer 停摆级联；stderr 零字节（无洪流）。
   - 判读：#132 定案的 stdout 洪流写者是**环境依赖**的（stall-duel 首个 64KB 采样曾疑 IME/注入 DLL；历史停摆均发生在电池噪声环境态——主进程假死级联/cua 覆盖层在场）。当前干净桌面（guard 清障后）洪流缺席 → 管道不满 → 不冻。**根因修复（控制器排空）+ 洪流环境依赖双保险**，不排空单条件已不足以停摆。
   - 健康面板基线：R1 `taskkill /F /T` **208ms**，主进程+4 个 electron 子进程全灭、final-check 零残留。

**冻结真面板的可杀性结论传递链**（未直接复测冻结面板）：t132 r3-bare 真面板冻结 minidump（KERNELBASE 写路径）≡ 本报告 s1 合成形态 dump（node+KERNELBASE+ntdll 同路径）→ s1 同完整性 214ms 杀灭 ⇒ 冻结真面板同理可杀灭。辅证：历史上每次实际执行的管理员杀灭（19:34 清扫）全部成功。

## 5. 对电池出口语义的校验（关票判据③）

`panel-control.js` 的强退阶梯 = `child.kill()`（Windows 下即 TerminateProcess）→ 800ms 宽限 → `taskkill /T /F`（同为 TerminateProcess 原语）→ 5s 复核。本次取证表明：

- 两档底层同原语且**该原语对停摆形态毫秒级有效**——阶梯语义成立；
- 5s 复核窗对「杀灭后进程对象消散」绰绰有余（实测 205-214ms 量级）；
- `restart-clear-required` 出口**保留为兜底**：其真实触发面从「内核级不可杀」收窄为「对象状态/权限类拒开」（高完整性孤儿、第三方内核滞留等未穷举形态），仍值得留一个 FAIL-ENV 出口，但预期发生率应随 #132 根因修复（停摆不再生）趋零。

## 6. 与在档审计的关系

- t111（静态审计）嫌疑①托盘宿主销毁路径、②电池侧无界等待：②已在 #132 修复（PostMessageW 化）；本报告 C1-C3 把「挂死窗同步发送卡死」的可杀性问题一并关闭——**卡死是真的，不可杀是假的**。
- t132（对照实验）定案的 stdout 管道写冻结：本报告 s1/s2 在独立最小复现上验证了其可杀性与读端死亡自愈性，补全了「停摆→遗留→清障」链路的最后一环。

## 7. 遗留与建议

- 提权轮（R3/R4）按共识条件触发判定：L1 三形态 + L2 真面板全部 R1 即杀灭（205-214ms 量级）、无任何存活者——提权档**无信息增量，按预登记判读免跑**（如复核者要求补实证：提权 shell 下 `node accept/experiments/kill-forensics.js --arm=s1 --profile=elevated` 即可复验）。
- 代码调整候选（另开票，不进本 PR）：无——阶梯与复核窗语义均被实测支持。
- 若未来再出现「Access denied 遗留进程」，先以**提权** shell 重试杀灭再考虑重启；preflight 已有的 elevated/zombie 疑似旗标（panel-control.classifyPreflight）即为此设计。
