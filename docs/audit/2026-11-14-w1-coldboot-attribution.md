# spec #472 观察项收割：W1 冷启动「进桌面→自启」142s 缺口归因 + W3 Progman 捕获时延补测

- 日期：2026-11-14 深夜（用户 23:24:29 自然重启后的收割轮）
- 票：spec #472（SLO 立法 ADR-0032：开机 = 进桌面→面板出现 ≤60s）；观察项 W1/W2/W3 中 W2 已有定数（面板链六相位、渲染层冻结 13444ms 自愈、freeze-alarm 一次——#479 设计内），本轮不重测
- 执行：收割执行者；两轮探针均经 accept-guard 托管（accept-sprint 档）；只读取证为主
- 生产面板形态：主检出 `app/`（master @ cfdb7c4 构建态），#475 事件化守望在役（boot 簇与常驻流 `taskbar-topmost-own-yield reason=win-event` 在场）

---

## 一、W1：142s「进桌面→自启项被拉起」缺口归因

### 1.1 口径锚点（多源对齐）

| 锚点 | 时刻 | 来源 |
| --- | --- | --- |
| Kernel-Boot（Secure System / boot type 0x0） | 23:24:29.566 / 23:24:30.0 | 进程快照 + System 事件 [27] |
| winlogon / dwm | 23:24:47.189 / 23:24:47.998 | 进程快照 |
| **explorer pid 7648 创建（进桌面）** | **23:24:55.339** | Win32_Process CreationDate |
| **守卫 electron.exe（AGENT DECK.lnk 目标）pid 26976 创建，ppid=7648** | **23:27:12.617** | 同上——explorer 直接子进程 |
| carry-boot 事件（pid 26976, mode=carry） | 23:27:17.195（t=1794670037195） | 生产 events.jsonl |
| --panel 子进程 5856 创建 | 23:27:17.362 | 进程快照 |
| bootT0（boot 事件, pid 5856） | 23:27:18.098（t=1794670038098） | 生产 events.jsonl |
| panel-visible（boot-phase, elapsedMs 14821） | 23:27:32.903（t=1794670052903） | 生产 events.jsonl |

**口径精细化**：任务口径「carry-boot 23:27:17 = 进桌面 +142s」是 **事件落日志** 时刻；守卫**进程本体**被 explorer 拉起在 23:27:12.617 = **+137.3s**（差值 4.58s = electron 冷启：进程创建→主进程跑起来）。两值同向，缺口主体都在 explorer 侧排队（见 §1.4/§1.5），守卫自身的 boot 事件间隔 0.90s 与当晚暖启（23:15:25 轮 +0.96s、23:20:51 轮 +1.13s）同量级——守卫/面板链本身无冷启动异常。

### 1.2 面板自启注册方式（全景枚举的结论之一）

- **用户 Startup 文件夹 `AGENT DECK.lnk`** → `electron.exe "<appDir>"`，WorkDir=`<appDir>`。这是面板唯一自启项：HKCU/HKLM Run、RunOnce（含 WOW6432Node）均无 agent-deck 条目。
- 面板自身维护该注册：boot 相位 `autostart-applied`（link [redacted], action=keep, reason=existing-matches, elapsedMs 6088）。
- `StartupApproved\StartupFolder` 无该 lnk 审批条目 = 默认启用。
- 注册形态即「shell 启动文件夹项」——处理顺序在 RunOnce/HKLM Run/HKCU Run 之后（§1.4 实录）。

### 1.3 本机自启项全景（入桌后 explorer/系统要跑的队列）

| 类别 | 启用项 | 禁用项 |
| --- | --- | --- |
| HKCU Run | OneDrive(/background)、ctfmon、Listary(--startup)、Steam(-silent)、msedge AutoLaunch ×2(--no-startup-window --win-session-start)、BaiduYunDetect、Seafile、v2rayN | com.qoder.work（approval=03） |
| HKLM Run | SecurityHealth、RtkAudUService(-background)、HipsTray（火绒） | — |
| HKLM RunOnce | msedge_cleanup（Edge 升级残留 setup.exe --delete-old-versions，RunOnce 用后即焚） | — |
| 用户启动文件夹 | **AGENT DECK.lnk**、滴答清单.lnk | 发送至 OneNote.lnk |
| 公共启动文件夹 | SpyderUtility.lnk | — |
| 登录触发计划任务（Ready/启用） | cua-driver-serve、OneDrive Startup Task（**PT10M delay**）、PowerToys（**PT3S**）、WpsUpdate（PT28M）、Office 族（PT5M/PT10M/PT15M）、Device User（PT2M）、DXGIAdapterCache（PT1M）、Hotpatch、语言同步（PT30S）等 + MS 内部族 | StartAUEP/StartCN/StartDVR 等（Disabled） |
| UWP/商店启动任务 | Snipaste、1Password | — |

（另有 StartupApproved 中 HUAWEI Cloud/LenovoOneLite/LGHUB/1Password/Feishu/KWpsBox/doubao/QyClient/QyMiniClient/AMDNoiseSuppression/Docker Desktop 等残留/禁用审批条目，对应项已不在 Run 键，不入队。）

### 1.4 explorer 串行启动队列实录（直接证据）

`Microsoft-Windows-Shell-Core/Operational` 在重启窗口共 214 事件；其命令族 ID（9703-9708 = RunOnce/Run 枚举执行；62408/62409 = 商店启动任务族）**逐命令记录了「Started/Finished execution of command X (PID Y)」**。「Finished」事件的 PID 与进程快照中仍存活进程一致（Listary 24100、steam 11348、msedge 24592、YunDetect 24260、seafile 22976、v2rayN 2556、Snipaste 23680、1Password 15984）——即 **shell 对每个自启项等待其初始化完成后才启动下一个：串行排队，非并发**。逐段账目：

| 段 | 起止 | 耗时 | 内容（命令: 初始化耗时 s） |
| --- | --- | --- | --- |
| RunOnce | 23:24:55.906→23:25:18.427 | **22.52** | setup.exe --msedgewebview --delete-old-versions（Edge 升级残留，PID 8128） |
| 队列空档 | 23:25:18.4→23:25:31.7 | 13.28 | shell 相位推进（23:25:01.6 已达 `DesktopStartupApps` 相位标记，Run 枚举实际 30s 后才开始） |
| HKLM Run | 23:25:31.7→23:25:43.6 | 11.88 | SecurityHealth 3.65 → RtkAudUService 1.17 → HipsTray 7.06 |
| HKCU Run | 23:25:43.6→23:26:44.8 | **61.16** | ctfmon 0.76 → Listary **10.02** → steam 5.20 → msedge#1 **7.94** → YunDetect 0.62 → seafile 1.89 → v2rayN **33.66** → msedge#2 1.08 |
| 商店启动任务族 | 23:26:44.9→23:27:00.0 | 15.11 | utility.exe 2.65 → Snipaste 0.95 → 1Password **11.51** |
| 启动文件夹批次（无逐命令日志，以进程快照为据） | 23:27:00.1→23:27:26.3 | — | SpyderUtility 23:27:00.118 → **AGENT DECK 23:27:12.617（+12.50）** → TickTick 23:27:26.318（+13.70） |

反例旁证：HKCU Run 的 OneDrive 条目未出现在命令日志（其启动走 PT10M 计划任务径），com.qoder.work（禁用）未出现——枚举/审批行为与账目自洽。

### 1.5 缺口拆解（进桌面 → 守卫进程 137.28s）

| 构成 | 贡献 |
| --- | --- |
| RunOnce Edge 升级残留阻塞 | 22.52s |
| RunOnce→Run 队列空档（shell 相位） | 13.28s |
| HKLM Run 三项初始化 | 11.88s |
| HKCU Run 八项初始化（v2rayN 33.66s 为最大单项） | 61.16s |
| 商店启动任务族三项 | 15.11s |
| 启动文件夹批次内排位等待（SpyderUtility 在前） | 12.50s |
| （守卫进程→carry-boot 事件：electron 冷启，面板侧但量小） | (+4.58s) |
| **合计（进程口径）** | **137.3s**；至 carry-boot 事件 +141.9s ≈ 任务口径 142s |

账目闭合，无未解释残差。

### 1.6 判定

1. **OS 节流：无证据**。`Microsoft-Windows-StartupAppTask/Operational` 日志在本机**不存在**（Win11 启动应用节流机制未启用/无事件可查）；`Winlogon/Operational` 窗口内只有常规通知订阅记录；`TaskScheduler/Operational` 窗口内 0 事件（历史未启用）。无「系统主动推迟面板」类事件。
2. **其他自启项串行排队：成立，主因（面板无责）**。explorer 对 RunOnce/Run/商店启动任务逐项等待初始化完成（§1.4 实录），队列总长 ≈124s 才轮到启动文件夹批次，AGENT DECK 又排在批次内第二位。最大单项贡献：v2rayN 33.66s、RunOnce Edge 升级残留 22.52s、1Password 11.51s、Listary 10.02s、msedge#1 7.94s、HipsTray 7.06s + 三处空档/排位 13.28+12.50(+13.70) s。
3. **注册方式可优化：是（仅建议，不动码）**。
   - 现状（启动文件夹 .lnk）位于串行队列**末段**（文件夹项最后处理 + 批次内排序）。换成 HKCU Run 键（Electron `setLoginItemSettings` 默认形态）只是排位前移，仍在串行队列内，收益不可控（本轮样本可省文件夹批次排位 ~12.5s）。
   - **建议方案：登录触发计划任务（LogonTrigger，Delay=PT5S~PT10S）替代 .lnk**——任务调度器与 shell 启动队列**并行**，不被 explorer 串行化，预期把「进桌面→拉起」压到秒级（参照本机 PowerToys PT3S：explorer 启动后 3s 即拉起）。代价：注册/更新/卸载语义复杂化（面板已有 `autostart-applied` 维护相位可承载决策）+ 需与 SLO 测量口径对齐。属产品改动，另立票裁决。
   - 关键旁证：面板链本身各晚启动无异常（§1.1），慢的只是「轮到它」。
4. **SLO 判定**（唯一口径 ADR-0032）：
   - 面板链 14.8s（bootT0→panel-visible）≤60s → **达标**；
   - 端到端「进桌面→面板出现」= 23:24:55.3→23:27:32.9 = **157.6s > 60s → 未达标**；缺口归因 **X = explorer 自启串行队列（其他自启项初始化排队 + RunOnce 升级残留）**，面板无责。

---

## 二、W3：Progman 捕获时延补测（t475 §六 移交项）

### 2.1 触发条件验证：shell show desktop 已随重启恢复

guard accept-sprint 轮 #1（脚本 `D:\test-folder\deck475-probe\w3-harvest-probe.mjs`）：牺牲窗 `DECK-W3-VICTIM` 经 SendInput Win+D → `minimized=True`；再 Win+D → `restored=True`；Progman 在场 visible=True。**t475 §九.2「重启/重新登录可能恢复」实测成立。**

### 2.2 合成 z 抬顶径仍堵死（对 t475 §六.3 预判的更正）

同轮内跑 t475 `cover-latency-probe.mjs` v2（隔离 --panel-accept 面板 + SetWindowPos Progman→HWND_TOP，三轮）：`up=OK` 但 1.2s 后 `progmanAbovePanel=False` ×3，engage/release 全空（与昨日 15 轮同形）。**shell 恢复后合成抬顶依然被即时压回**——t475 §六.3「shell 坏态即时压回」的解读需更正：压回是 shell 桌面 z 维护机制的**常态行为**，t475 §六.4「健康 shell 下合成径可直接构造刺激」的预判实测**不成立**；唯一有效刺激是真 show desktop。（t475 文档按只读收割纪律不改动，以本报告为准。）

### 2.3 真实刺激 × 生产面板出证（W3 实测值）

guard accept-sprint 轮 #2（`D:\test-folder\deck475-probe\w3-production-probe.mjs`）：guard 清场后在轮内拉起生产链（守卫默认入口→--panel；暖启 panel-visible 2207ms），稳态 6s 后以真 Win+D 往返，读生产常驻日志：

| 读数 | 值 |
| --- | --- |
| **cover-engaged** | **trigger=win-event，osEventAgeMs=109**（t=1794671565168） |
| **cover-released** | **trigger=win-event，osEventAgeMs=265，pinned=true**（t=1794671569662） |
| 牺牲窗 | minimized=True / restored=True |
| ZREAD（show 期 ×2） | progmanFound/Visible=True, panelVisible=True, panelTopmost=True, progmanAbovePanel=False |
| ZREAD（复原后） | panelTopmost=False（keepalive 事件闸门静默期不重申的预期形态，非缺陷） |
| 事件泵旁证 | 窗口内 `taskbar-topmost-own-yield(reason=win-event)` ×13 |

### 2.4 判读

- 实测落在 t475 §六.4 有界论证带内：OS 事件投递（消息循环即时）+ 60ms 防抖尾沿 + 单次 z 序走查 + SetWindowPos 单调用 → engage 径 **109ms** ≪ 旧 150ms 拍距；release 径 265ms 含 pinned 重申。与 51 电池 r2 同族口径（退出全屏恢复 146ms/217ms）同量级。
- **W3 关闭：实测值 engage 109ms / release 265ms（真 shell 刺激 × 生产面板 × 事件化守望）。**
- 备注：真实 show desktop 期 `progmanAbovePanel=False` 而 cover 仍以 win-event 触发 engage——engage 判据在真实 shell 语义下的输入组合与合成径读数不同（show desktop 流程中面板让位/重申时序所致；ZREAD 三读均未落在让位窗口）。不阻塞出证，输入组合细节留 T12 全量校准轮复核。

---

## 三、生产面板复原与扰动留痕

- 轮 #1：guard 清场（优雅径触达今晚自然重启的生产链 16 pid → 优雅等待后残留强杀兜底）；探针面板残留由轮内清理步骤杀净（8 pid，排除 icon-restore-watch）。
- 轮 #2：清场后**轮内拉起生产链复原**（守卫 5436 / 面板 30544），轮后核验：面板窗 `AGENT DECK` visible=True、守卫进程树在场。**面板冷启动未做任何测量断言**（遵守收割纪律「今晚不再打扰」）。
- Win+D 往返共 4 次（每轮 2 次），牺牲窗均为脚本自建窗；用户窗随第二次 Win+D 复原。探针脚本与结果 JSON 落 `D:\test-folder\deck475-probe\`（非仓内，t475 同址）。

## 四、遗留

1. W1 建议方案（LogonTrigger 计划任务替代启动文件夹 .lnk）为产品改动，另立票裁决（注册/更新/卸载语义 + SLO 口径对齐）。
2. t475 §六.3/§六.4 关于合成径的两处预判被本轮证伪/更正（§2.2），t475 文档不回改。
3. cover-engaged 输入组合之谜（§2.4 备注）留 T12。
4. `utility.exe`（62408 族首命令，PID 5044 已退出）身份未定；不影响账目。
5. 本报告原始取证（进程快照 / 事件窗口 dump）为会话临时文件不长期留存；承载性证据已全部内联上文。生产常驻日志 `C:\Users\An W\AppData\Roaming\agent-deck-panel\events.jsonl`（boot 簇 t≈1794670037195 起）与探针结果 JSON 为可回查件。
