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
