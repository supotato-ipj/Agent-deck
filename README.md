# desktop-deck（AGENT DECK）

本地常驻的 AI 工作台数据服务与桌面作战面板：壁纸层实时显示多个 AI 工具（Qoder、kimi work、kimi code、zcode、hermes）的会话与任务状态（HUD 观感、随 Wallpaper Engine 常驻桌面），桌面图标按分区编排，使常用应用与文档各归其位。核心（数据服务/分区编排）不依赖 WE，仅界面用 WE 做渲染器。

## 目录

- `server.py` — 本地数据服务（127.0.0.1:5000）：`/performance`（硬件指标 + qoder 摘要）、`/deck`（多工具会话 + 历史曲线）
- `agent_sessions.py` — 五工具会话采集（唯一接缝 `collect_sessions`）：qoder / hermes / zcode / kimi code / kimi work
- `wallpaper/` — AGENT DECK 壁纸源码（web 类型，WE 以 junction 指向此处加载，改动即时生效）
- `scripts/server_watchdog.pyw` — 看门狗：端口空闲即拉起服务，服务崩溃后 15 秒内自动复活（启动文件夹快捷方式 `desktop-deck-server-watchdog.lnk`）
- `scripts/create_startup_shortcut.ps1` — 重建上述快捷方式（路径动态解析，换目录/换 Python 后重跑即可）
- `scripts/capture_desktop.ps1` / `capture_wallpaper.ps1` — 桌面截图（后者先最小化所有窗口）
- `.scratch/<feature>/` — 各功能的 spec 与票据
- `CONTEXT.md` — 领域词汇表

## 壁纸部署（WE 加载本仓库的 wallpaper/）

以 junction 把 WE 的自有项目目录指到仓库（管理员权限不需要；换机器重跑一次即可）：

```
cmd /c mklink /J "<WE目录>\projects\myprojects\desktop-deck" "D:\GIThub\desktop-deck\wallpaper"
```

加载 / 切换：

```
"<WE目录>\wallpaper64.exe" -control openWallpaper -file "<WE目录>\projects\myprojects\desktop-deck\project.json"
```

壁纸属性里只有一个开关：`perspective`（HUD 座舱环抱/仪表俯倾，默认开）。

## 手动启动数据服务（无看门狗时）

```
python server.py
```

## 多工具会话展示（/deck 的 sessions）

会话列表混排五个工具的活跃会话（10 分钟活跃窗、90 秒内判 RUN、行首两字母标签 QD/HM/ZC/KC/KW）。每项含 title（zcode/hermes/kimicode 有真实标题）、preview/preview_role（qoder 全支持、kimicode 宽容解析，无消息存储的工具为空）、tasks 任务清单（qoder/zcode）与 current_task（qoder）。数据源全部只读：

| 工具 | 数据源 | 备注 |
|---|---|---|
| qoder | `~/.qoder-cn/projects/*/*.jsonl` + `tasks/` | 四态含 CONFIRM |
| hermes | `%LOCALAPPDATA%\hermes\state.db` + `runtime\active_sessions.json` | 租约交叉判 RUN |
| zcode | `~/.zcode/cli/db/db.sqlite`（session+todo） | subagent 会话不入列 |
| kimi code | `~/.kimi-code/sessions/**/state.json` + `wire.jsonl` mtime | 旧会话落 DONE |
| kimi work | `%APPDATA%\kimi-desktop\kimi-agent\conversation-statuses.json` + `conversation-context-usage.json` | **降级：无标题/项目**（正文锁在上游私有存储），行内只有标签+状态 |

任一工具数据源缺失/损坏时静默跳过（仅服务端 stdout 日志），其余工具照常；SQLite 一律只读 URI 打开。

## 桌面分区管理

数据服务内的看门狗线程监控两个桌面目录，新增/删除文件时增量编排图标：
应用区（6×2 栏位，手钉优先、推荐按使用频次填空位）、文档区（按类型分列、新在上）、
回收站固定左下。只移动图标坐标，**从不移动/重命名/删除磁盘文件**。

手钉清单（显示名有序数组，改完下次编排生效）：

```
pinned.json（仓库根目录）
```

常用命令（均在仓库根目录跑）：

```
python zones_orchestrate.py            # dry-run：只打印计划
python zones_orchestrate.py --apply    # 落位（与看门狗互斥锁串行；注意：这是一次全量重置，
                                           # 会把你手动摆过的应用区图标也归位；看门狗不会）
python desktop_layout.py restore factory   # 回到出厂态
python desktop_layout.py restore last      # 回到最近一次运行前态
python desktop_layout.py list              # 看有哪些快照
python scripts/accept_zones.py         # 实机验收电池（观感与重启两项需人工）
```

运行时数据（不在仓库内）：`%LOCALAPPDATA%\qoder-deck\` 下
`layout\`（出厂/运行前快照）、`usage\`（使用日志，仅 ts+exe，90 天滚动）、
`watcher.log`（看门狗日志）、`arrange.lock`（编排互斥锁目录）。

### 不工作时的排查顺序

0. 桌面壁纸纯黑无 HUD → 多为 WE 加载 web 壁纸的偶发竞态（本页代码无 WE 专属 API）：
   先重下发一次加载命令（见上节 openWallpaper），仍黑则 `taskkill /F /IM wallpaper64.exe /T`
   后重新执行 openWallpaper；连续出现时重启 WE（Steam 里验证一次完整性更稳）。
1. `python -c "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:5000/deck').status)"`
   不通 → 服务没跑：看门狗随登录自启，注销重登或手动 `python server.py`；
   也可重跑 `powershell -File scripts/create_startup_shortcut.ps1` 重建快捷方式后重启。
2. 服务在但桌面不动 → 看 `%LOCALAPPDATA%\qoder-deck\watcher.log`：
   有 `编排锁被占用` → 有另一个编排者卡住（正常几秒内释放）；
   有 `编排失败` 堆栈 → 按堆栈报障；日志完全不动 → 看门狗线程死了，重启服务。
3. 落位错乱 → `python desktop_layout.py restore factory` 先回出厂态，再 `--apply`。
4. 怀疑锁孤儿（进程被杀在持锁时）→ 锁自带陈旧检测（pid 死亡或超 60s 自动打破），
   一般无需手动删 `arrange.lock`。

### 已知限制

- 依赖 explorer 未文档化的桌面图标控件结构；Windows 更新可能使其失效，
  失效时用 `restore factory` 回退并停用编排。
- explorer 的视图刷新与位置应用有秒级且波动的延迟，所有读回断言都轮询等待。
- 系统缩放非 100% 时界面分区标签会与图标晶格错位（装饰性，不影响功能）。
- 同轮"一增一删"视为疑似重命名，应用区该轮不动，留给下次全量编排。
