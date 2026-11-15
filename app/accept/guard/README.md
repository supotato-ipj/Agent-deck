# accept-guard —— 真机验收调度协议

本机（win32 主机）有多个并行开发的检出共用同一套桌面资源做真机验收。任何真机 GUI 验收都独占桌面级资源：真鼠标/键盘注入、单实例锁（全量电池拉起的真面板子进程仍会抢锁）、共用的 userData（`%APPDATA%\agent-deck-panel`，摆位互相踩踏）、托盘注入探针、前景窗断言、截图前最小化一切无关顶层窗。**因此整机同一时刻只允许一个真机验收在跑——这台机器只有一把「验收槽」。**

## 住址与家目录（工单 #495 仓内化）

- **源码**住在本仓库 `app/accept/guard/`，与验收电池同仓演进、同 PR 评审（2026-11-15 起脱离「仓外工具跨仓改动」形态，见 ADR-0033）。
- **家目录**（租约 `guard.json`、相位 `status.json`、配置 `config.json`、互斥 `guard.lock` 的落点）固定在本机 `D:\test-folder\.accept-guard`，不随检出走——既有租约状态与生产 config 零迁移连续，运行态绝不写进 git 检出。环境变量 `ACCEPT_GUARD_HOME` 可重定向（selftest 沙箱/搬迁用）。

## 词汇表

| 词汇 | 含义 |
| --- | --- |
| 验收槽 | 整机唯一的真机验收互斥资源；同一时刻至多一个持有者 |
| 租约 | 对验收槽的持有记录（持锁方/用途/PID/心跳），持久化在 `guard.json` |
| 持锁方 | 当前持有租约、正在跑真机验收的 agent 或用户 |
| 相位 | 一方的工作阶段声明：`dev` 开发中 / `selftest` 日常自测 / `accept-sprint` 验收冲刺 / `human` 等人工 / `idle` 空闲 / `waiting` 排队中（机械） / `accepting` 验收中（机械） |
| 验收冲刺 | 要出验收证据的一轮（如 PR 前、工单闸门），排队优先级高于日常自测 |
| 日常自测 | 空挡随手跑的一轮验证，排队让位于验收冲刺 |
| 验收入口 | 所有 electron `--accept*` 模式：`npm run accept` / `accept:tray` / `accept:taskbar` |
| 挂死接管 | 持锁方心跳停止超过 TTL 后，等待方清掉残留进程并接管验收槽 |
| 任务栏还原兜底 | 拿槽/释放槽两侧各跑一次的 `restoreTaskbarCmd`：把电池强杀面板可能留下的 SW_HIDE 原生任务栏与 appbar 落盘账还原给系统（工单 #495） |

## 用法

### 发起真机验收（唯一合法方式）

```bash
node D:\test-folder\wallpaperengine-research\app\accept\guard\guard.mjs hold --as zcode --purpose accept-sprint -- npm run accept
```

一条命令完成全部生命周期：**排队 → 拿槽 → 清场（优雅径 WM_CLOSE → 有界等待 → 强杀兜底 → 任务栏还原兜底）→ 弹系统通知 → 托管验收命令并驻留心跳 → 命令退出前任务栏还原兜底 → 自动释放**（正常/异常退出都释放）。退出码透传验收命令的退出码。清场输出含 `kill-mode=graceful|forced`（graceful=面板自发退出/无残留；forced=优雅径后有残留被强杀，附残留 PID 清单）——工单 #429。

### 看状态（抢槽前必看）

```bash
node D:\test-folder\wallpaperengine-research\app\accept\guard\guard.mjs status
node D:\test-folder\wallpaperengine-research\app\accept\guard\guard.mjs status --json
```

输出持锁方（含心跳年龄、PID 存活）、等待队列、双方相位。

### 声明相位（让对方看见你的意图）

```bash
node D:\test-folder\wallpaperengine-research\app\accept\guard\guard.mjs phase accept-sprint --as zcode --note "出工单63验收证据"
```

相位值：`dev | selftest | accept-sprint | human | idle`。对方在决定「现在抢不抢槽」前应先看 `status`。

### 应急解锁（仅人工使用）

```bash
node D:\test-folder\wallpaperengine-research\app\accept\guard\guard.mjs release --force
```

只清租约不杀进程、不跑还原兜底（持锁方可能还活着，还原会与在跑面板打架）。正常路径一律由 hold 自动释放。

### 自证行为电池

```bash
node D:\test-folder\wallpaperengine-research\app\accept\guard\guard.mjs selftest
# 或 npm run guard:selftest（app/ 下）
```

在临时沙箱守卫目录上跑 10 项行为断言（互斥、排队优先、挂死接管、超时、释放、no-op 触达序等），永不碰真实租约与真实面板。改完 guard 必跑。

## 调度规则

1. **互斥**：整机一把锁。vitest / typecheck / build / 证据推送不占槽，随意并行。
2. **排队**：FCFS 为基础；同队等待时 `accept-sprint` 优先于 `selftest`，同类按入队时间。槽空闲但队列非空时，新来者必须入队，不得越过队头。
3. **不抢占**：正常运行的验收绝不被打断。仅当心跳停止超过 TTL（默认 3 分钟，心跳 30 秒）才判挂死接管；接管时自动清残留 electron 进程。
4. **等待上限**：默认 30 分钟，超时以退出码 3 结束并输出裁决指引——等待方应转做不占主机的活，或请用户裁决。
5. **知情与净桌**：拿槽时四步——先优雅径（对枚举面板进程发 WM_CLOSE / `--panel-quit` 信使，走既有退出链注销托盘图标后自行退出）、有界等待（默认 5s 硬预算、500ms 轮询、PID 全消失提前出）、残留者强杀兜底、**任务栏还原兜底**（工单 #495）——再弹系统通知。释放槽时（验收命令退出后、清租约前）**再兜一次任务栏还原**。验收期间用户手动拉起的普通面板会被电池面板子进程的单实例锁自然弹退（`--panel-accept` 等绕锁模式除外，勿在他人持锁期间使用）。

## 为什么需要任务栏还原兜底（工单 #495）

电池收尾对面板是拔电式强杀（`handle.stop()` → taskkill /T /F），面板来不及还原原生任务栏；`--panel-accept` 电池面板又不带外层守卫/还原守护链。主电池与 taskbar 族电池在自己 finally 里有 `--icon-restore` 自救，但 **placement / conversation / tiling 族六块电池没有**——每跑一次就把「任务栏压死、鼠标触底无响应」的桌面留给用户。guard 在拿槽（治愈 guard-dead 接管残局）与释放槽（交还机器）两侧各跑一次 `restoreTaskbarCmd`（默认 = 主检出的 electron `--icon-restore`：桌面图标还原 → appbar 落盘账复原 → 原生任务栏 SW_SHOW，幂等、不抢单实例锁），从调度层兜住全部电池的退出面。

## 配置（config.json）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `heartbeatMs` | 30000 | hold 驻留进程心跳间隔 |
| `ttlMs` | 180000 | 心跳停止多久判挂死（= 6 次失联） |
| `maxWaitMs` | 1800000 | 排队最长等待，超时退出码 3 |
| `pollMs` | 3000 | 排队轮询间隔 |
| `panelPathPattern` | `D:\test-folder\wallpaperengine-research*` | 面板进程识别的可执行路径模式 |
| `gracefulPanelsCmd` | PowerShell 枚举 + taskkill（不带 /F，发 WM_CLOSE） | 清场第一步的优雅径命令，`{pattern}` 注入路径模式（工单 #429；本机 config.json 已换 `--panel-quit` 信使径，工单 #431） |
| `gracefulWaitMs` | 5000 | 优雅径后的有界等待硬预算（毫秒），枚举 PID 全消失即提前出，轮询步长固定 500ms（工单 #429） |
| `clearPanelsCmd` | PowerShell 枚举 + Stop-Process -Force | 清场第二步的强杀兜底命令（最后一级、不可拆除），`{pattern}` 注入路径模式 |
| `restoreTaskbarCmd` | 主检出 electron `--icon-restore` | 任务栏还原兜底命令，拿槽/释放槽双侧各跑一次（工单 #495）；置空字符串即禁用 |
| `notifyCmd` | PowerShell WinRT toast | 拿槽后的系统通知，`{holder}`/`{purpose}` 注入 |

既有家目录 config.json 无需手工迁移：`loadConfig` 以 `{...DEFAULT_CONFIG, ...文件内容}` 浅合并，新增键自动取默认值。

## 设计要点（给改这块的人）

- 零 npm 依赖（Node 内置模块），guard 不得依赖任一检出的 `node_modules`（默认 restoreTaskbarCmd 是命令模板调用主检出产物，不是依赖）。
- 家目录与源码位置分离：源码在仓库，家目录固定 `D:\test-folder\.accept-guard`；selftest 子进程拉 `SCRIPT_PATH`（`import.meta.url`），不再从家目录找 guard.mjs。
- 租约读改写用独占创建的 `guard.lock` 哨兵串行化，哨兵超 10s 视为崩溃残留自愈；状态文件 tmp-rename 原子写。
- 挂死判定只看心跳时间戳，不做基于 PID 的抢先判定（PID 复用风险）。
- 唯一测试接缝 = CLI 边界；主机效果（优雅径/强杀清场/任务栏还原/通知）命令化，沙箱配置替换为写标记文件的 no-op（优雅等待预算设短值防真等）。
- 规格见 Agent-deck#63（调度）、Agent-deck#495（仓内化 + 还原兜底）。
