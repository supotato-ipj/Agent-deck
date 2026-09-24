# wallpaperengine-research

Wallpaper Engine 桌面状态屏改造工作目录：TERMINAL 02 定制（Qoder 状态块 + HUD 静态透视）与自建壁纸 QODER DECK。

## 目录

- `server.py` — 本地数据服务（127.0.0.1:5000）：`/performance`（TERMINAL 02 用）、`/deck`（QODER DECK 用）
- `scripts/server_watchdog.pyw` — 看门狗：WE 运行且端口空闲时自动拉起服务（启动文件夹快捷方式 `qoder-deck-server-watchdog.lnk`）
- `scripts/create_startup_shortcut.ps1` — 重建上述快捷方式
- `scripts/apply_patch.py` / `restore_original.py` — TERMINAL 02 补丁重放 / 恢复原始（patched/ 与 backup/original/）
- `scripts/capture_wallpaper.ps1` — 桌面截图（最小化→截图→还原）
- `.scratch/terminal02-qoder-status/`、`.scratch/qoder-deck/` — spec 与票据
- `CONTEXT.md` — 领域词汇表

## 壁纸切换命令

QODER DECK（自建，myprojects）：

```
"D:\Steam\steamapps\common\wallpaper_engine\wallpaper64.exe" -control openWallpaper -file "D:\Steam\steamapps\common\wallpaper_engine\projects\myprojects\qoder-deck\project.json"
```

TERMINAL 02（创意工坊定制版）：

```
"D:\Steam\steamapps\common\wallpaper_engine\wallpaper64.exe" -control openWallpaper -file "D:\Steam\steamapps\workshop\content\431960\3639973107\project.json"
```

## 手动启动数据服务（无看门狗时）

```
python D:\test-folder\wallpaperengine-research\server.py
```

## 桌面分区管理

数据服务内的看门狗线程监控两个桌面目录，新增/删除文件时增量编排图标：
应用区（6×2 栏位，手钉优先、推荐按使用频次填空位）、文档区（按类型分列、新在上）、
回收站固定左下。只移动图标坐标，**从不移动/重命名/删除磁盘文件**。

手钉清单（显示名有序数组，改完下次编排生效）：

```
D:\test-folder\wallpaperengine-research\pinned.json
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

1. `python -c "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:5000/deck').status)"`
   不通 → 服务没跑：看门狗只在 Wallpaper Engine 运行时拉起服务，先确认 WE 开着；
   或手动 `python server.py`。
2. 服务在但桌面不动 → 看 `%LOCALAPPDATA%\qoder-deck\watcher.log`：
   有 `编排锁被占用` → 有另一个编排者卡住（正常几秒内释放）；
   有 `编排失败` 堆栈 → 按堆栈报障；日志完全不动 → 看门狗线程死了，重启服务。
3. 落位错乱 → `python desktop_layout.py restore factory` 先回出厂态，再 `--apply`。
4. 怀疑锁孤儿（进程被杀在持锁时）→ 锁自带陈旧检测（pid 死亡或超 60s 自动打破），
   一般无需手动删 `arrange.lock`。

### 已知限制

- Wallpaper Engine 未运行期间分区不工作（服务由看门狗随 WE 拉起）。
- 依赖 explorer 未文档化的桌面图标控件结构；Windows 更新可能使其失效，
  失效时用 `restore factory` 回退并停用编排。
- explorer 的视图刷新与位置应用有秒级且波动的延迟，所有读回断言都轮询等待。
- 系统缩放非 100% 时壁纸标签会与图标晶格错位（装饰性，不影响功能）。
- 同轮"一增一删"视为疑似重命名，应用区该轮不动，留给下次全量编排。
