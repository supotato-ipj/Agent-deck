# 02: 硬件指标垂直切片

**What to build:** 本地数据服务上线并驱动壁纸右栏显示实时硬件指标：启动服务后，壁纸右栏中下部（天气信息之下、滚动日志之上）出现 4 行硬件数据——CPU 使用率、内存（使用率+容量）、GPU（使用率+温度+显存）、网络（上下行速度）——每秒刷新；左栏原性能区块位置留空并自动重排。

**Blocked by:** 01 备份与补丁基础设施

**Status:** ready-for-agent

- [x] 服务监听 127.0.0.1:5000，`GET /performance` 返回契约字段：psutil 对象含 cpu、memory、memory_gb、gpu_usage、gpu_temp、vram_usage、download_speed、upload_speed
- [x] GPU 三项来自 nvidia-smi；nvidia-smi 失败时相应字段缺省而非整个响应失败
- [x] 壁纸性能容器已移至右栏天气区块之后、日志区块之前
- [x] 用户级布局覆盖文件被壁纸优先加载，渲染精简 4 行硬件区块（无磁盘行、无 CPU 温度）
- [x] curl 断言 JSON 结构通过；浏览器打开壁纸主文件可见右栏实时硬件数据
- [x] 定制后的壁纸文件已同步进补丁目录（供票 01 的重放脚本使用）

## Comments

- 2026-09-20: 修复 psutil 7.x 线程本地状态 bug（cpu_percent(interval=None) 在 ThreadingHTTPServer 每请求新线程下恒为 0.0），改为单一后台采样线程。
- 2026-09-20: 发现 WE 桌面实例不热重载文件改动；用 `wallpaper64.exe -control openWallpaper -file <project.json>` 可强制重载（官方 CLI 文档确认）。
- 2026-09-20: 实测 WE 在被窗口遮挡时暂停壁纸页定时器（无轮询），桌面可见时恢复每秒轮询——行为可接受。
- 2026-09-20: 桌面截图验证：右栏中下部出现 CPU/RAM/GPU+VRAM/NET 四行实时数据，日志行 "Custom layout loaded (performance.layout.user.js)" 与 "Metrics received (port=5000 psutil=8)" 确认管线打通。
