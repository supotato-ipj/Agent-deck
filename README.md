# AGENT DECK 独立面板

常驻桌面的作战面板：以卡片网格与底部 dock 呈现五个 AI 工具（Qoder、kimi work、kimi code、zcode、hermes）的会话列表与硬件指标，并**自绘承载桌面项**。

一个独立 Electron 常驻窗口浮于桌面壁纸之上，背景透明、默认鼠标穿透，仅在交互热区内接收点击。隐藏原生桌面图标并接管其承载职责，壁纸退为背景层。

底座决策见 [ADR-0004](docs/adr/0004-electron-cordis-standalone-panel.md)：Electron 窗口宿主 + cordis 插件内核 + 原生 ESM 前端（tsc 直出，无打包器），TypeScript 全栈。

> Python 数据服务、看门狗、Tk 搜索窗与 zones Win32 挪真图标链路均已退役（工单11），本仓库不再向 Python 侧添加任何功能。

## 快速开始

本应用仍以**本机仓库运行**（不做打包安装器，见 spec 的 Out of Scope）。

```
cd app
npm install
npm run dev          # 构建并启动（默认入口：外层守卫 → 隐藏原生图标 → 拉起面板）
```

首次运行会在 `app/config.json` 落盘一份按当前屏幕几何生成的默认配置（可直接编辑）。

## 目录

```
app/
  src/
    main/        Electron 主进程：cordis 内核、面板窗口、Win32 层（穿透/钉扎）、搜索、
                 桌面组件宿主；四个采集服务（会话/硬件/使用日志/桌面承载）跑在
                 utilityProcess 数据面子进程（dataplane.ts 入口，见 ADR-0005）
    preload/     上下文桥
    renderer/    面板前端（原生 ESM）；cards/ 为五个内置桌面组件
    shared/      内核↔渲染层契约（contract.ts）
  tests/         vitest 离线测试（纯逻辑缝 + 内核契约缝）
  accept/        真机验收电池与证据截图
  samples/       桌面组件样例插件
  scripts/       构建期资产复制
docs/adr/        架构决策记录
archive/         只读封存资产（壁纸）
GLOSSARY.md      领域词汇表
```

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 构建并启动面板 |
| `npm run dev:panel` | 只拉面板子进程（跳过外层守卫，调试用） |
| `npm test` | 离线测试全量（vitest） |
| `npm run typecheck` | 类型检查（不产出） |
| `npm run build` | 构建（tsc 主进程 + 渲染层 + 资产复制） |
| `npm run accept` | **真机验收电池**：一键端到端 + 截图存证 |

运行期参数：`--panel`（面板子进程）、`--accept`（验收电池）、`--icon-restore`（确保原生桌面图标可见的清场/自救入口）。

## 配置

`app/config.json` 是用户可编辑的生产值副本，首运行按当前屏幕几何生成：

| 段 | 管什么 |
|---|---|
| `panel` | 面板几何（坐标与尺寸） |
| `desktop` | 桌面承载几何（文档区原点与宽度、dock 最大宽度） |
| `weather` | 天气卡取数坐标 |
| `search` | Listary 本地 API 端口（host 恒为 127.0.0.1，不进配置） |
| `appearance` | 信息卡底色透明度滑杆值 |
| `tools` | 工具→exe 映射（会话行直达的启动与窗口发现依据；换机只改这里） |
| `plugins` | 桌面组件安装目录（空串 = `userData/plugins`） |
| `autostart` | 开机自启：`enabled` 开关 + `appDir`（声明本机生产安装位置，空串 = 本次运行不接管） |

非法字段回退默认并告警，不静默吞掉笔误。运行态数据（摆位 `layout.json`、使用日志 `usage/`）住在 Electron `userData`，不进代码目录。

## 开机自启

面板在 Startup 文件夹维护一个 `AGENT DECK.lnk`。四条约定：

- **只有声明过的生产安装位置才有权新建/接管**——`config.autostart.appDir` 填本机生产位置（如 `D:\local_works\agent-deck\app`）。留空（默认）表示本次运行不接管：在开发 worktree 里跑面板不会把机器的开机自启指向自己（worktree 收尾即删，自启项随之指向空气）。
- **活链不追改**——指向别处但目标仍在时保持不动。开发运行既不劫持生产自启项，也不接管指向别处的死链。
- **自启项是机器级部署记录**，不是每次运行的安装记录，因此不随运行位置漂移。
- **旧链自启项无条件清除**——Python 看门狗链的 `qoder-deck-server-watchdog.lnk` 每次启动都被删，退役不靠人记得手删。
- **关闭自启**：`config.autostart.enabled=false`，面板每次启动都会删掉该快捷方式（这条不需要生产身份，开发运行也照删）。

### 历史使用日志的去向

Python 数据服务时代的使用日志在 `%LOCALAPPDATA%\qoder-deck\usage\`，面板**首次启动时自动复制**进 `userData/usage\`，随后的使用频次打分即刻把这段历史算进去（两侧格式逐字段相同，都是只含 `ts` 与 `exe` 的按天 JSONL——见 ADR-0002）。

- **是复制不是移动**：旧目录原样保留，确认新面板读数正常后可自行删除。
- **幂等**：逐文件记账 + 按行去重，中途被杀后重跑既不会漏搬也不会翻倍（翻倍会歪掉 dock 的频次排序）。
- **只搬保留期内的**：超过 90 天的按天文件不搬——搬进去也只会立刻被滚动清理删掉。
- 旧目录不存在时视为无历史可搬，照样记账，不再每次启动都去扫。

## 桌面组件（插件）

信息卡本身就是第一批可热插拔的桌面组件，与用户插件同一套契约：`manifest`（`plugin.json`）声明 id/入口/能力/排序，前端资产经 `deck-plugin://` 协议提供给渲染层动态加载。

- 安装位：`userData/plugins`（`config.plugins.dir` 可改），放入即被识别，支持运行时装载/卸载/重载。
- 样例：`samples/hello-plugin/`。
- 协议寻址以插件 id 作主机名，**插件目录之外的兄弟文件不可达**——跨目录相对导入必 404（真机实证）。
- 呈现工具（补零、转义等）经宿主 `PluginHost.util` 转交，而非让插件各自实现。

## 验收

`npm run accept` 跑真机验收电池：透明与穿透的 Win32 探针、热区点击、底部钉扎 z 序、桌面项与磁盘扫描一致性、双击启动探针 lnk、拖拽摆位落盘、原生图标隐藏与崩溃还原、Win+D 防抖恢复、单实例守卫、设置浮层、会话行直达、桌面组件热插拔。截图与运行态事件日志存证于 `app/accept/evidence/`。

界面视觉对齐不设自动化缝，沿用截图人工核验。**自启的真重启复验**需人工重启后核对 Startup 快捷方式与开机行为（工单11 验收项）。

## 决策记录

| ADR | 状态 |
|---|---|
| [0001 Win32 操控真实桌面图标](docs/adr/0001-win32-icon-manipulation.md) | 已被 0004 取代 |
| [0002 使用日志不记窗口标题](docs/adr/0002-no-window-titles-in-usage-log.md) | 有效 |
| [0003 多工具统一会话模型](docs/adr/0003-multi-tool-unified-session-model.md) | 有效 |
| [0003 搜索面板为数据服务窗口](docs/adr/0003-search-panel-service-window.md) | 已被 0004 取代 |
| [0004 Electron + cordis 独立面板](docs/adr/0004-electron-cordis-standalone-panel.md) | 有效 |
| [0005 主进程不持有输入钩子；采集移入数据面子进程](docs/adr/0005-no-input-hooks-dataplane-utility-process.md) | 有效 |

领域词汇以 [GLOSSARY.md](GLOSSARY.md) 为准（含「已退役词汇」一节）。

## 排查

1. **面板没起来** → 看托盘图标；面板默认不夺焦，可能已在壁纸之上被其他窗口盖住。托盘点击唤回。
2. **桌面图标没还原**（面板被强杀） → `npx electron . --icon-restore`，或直接重启面板（守卫退出时自会还原，另有还原守护兜底控制台信号同杀的场景）。
3. **搜索显示 ENGINE OFFLINE** → Listary 未运行或端口不对（`config.search.port`）。查询词只发往本机 Listary API，不进使用日志。
4. **卡片数据不对** → 会话扫描只读文件系统/SQLite，任一工具数据源损坏会静默跳过该工具，其余照常。采集整体跑在数据面子进程（ADR-0005）：子进程崩溃按退避自动重启（存证日志记 `dataplane-exit`，重启后一拍内补齐），控制台 `deck-*` 告警经 stdio 直通自子进程。
5. **自启项不对** → 删掉 Startup 里的 `AGENT DECK.lnk` 再启动一次面板即重建；指向别处且目标仍在时不追改（见上）。
