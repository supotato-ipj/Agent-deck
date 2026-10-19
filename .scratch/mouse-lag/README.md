# 鼠标卡顿工单：测量证据与探针工具

工单目标：定位并消除 agent-deck 运行期的全系统鼠标卡顿（间歇阵发、退出面板即恢复、143Hz 屏感知明显）。结论与决策见 [ADR-0005](../../docs/adr/0005-no-input-hooks-dataplane-utility-process.md)。

## 根因（静态审计 + 实测双重确认）

1. **钩子**：`setIgnoreMouseEvents(true, { forward: true })`（panel-window.ts 创建时 + hotzone.ts 每次离开热区恢复时）令 Electron 44.4.3 在主进程线程装全局 `WH_MOUSE_LL` 低级鼠标钩子——系统每个鼠标事件串行等它返回。
2. **阻塞源**：同一条主进程线程上，每 1s 会话扫描（含两个 SQLite `DatabaseSync` 全表查询，`busy_timeout=500` 锁库时最坏堵 500ms）+ 桌面重扫 + 每 2s 全系统进程枚举（EnumProcesses + 逐 pid 3 次同步 FFI，300+ 进程 ≈ 900+ 次/轮）。
3. **放大器**：面板为整屏窗口，钩子对屏幕任意位置的光标移动都成立——全屏每次鼠标移动都被复制一份 WM_MOUSEMOVE 进 Chromium 管线做 `:hover` 重算（渲染层无任何 mousemove 消费者）。

## 基线测量（修复前，2026-09-29 14:58，本机 --panel 模式 140s）

主进程 50ms 心跳探针（经 `--inspect=9229` 注入，loop-probe.mjs）：

| 指标 | 值 |
|---|---|
| 心跳间隙 p50 / p90 | 62 / 108 ms |
| p99 / max | **367 / 2302 ms** |
| ≥150ms 停顿 | **139 次**，时间戳间隔 ≈1.0s——与 bridge tick 1Hz 精确同相 |
| 主进程 CPU（150s 采样） | 平均 35.29% 单核，p95=68.8%，max=128%，≥10% 尖峰 205 次 |

即：主进程每秒被阻塞约 300ms，钩子把这 300ms 直接变成全系统鼠标冻结。

## 修复后测量（2026-09-29 15:22，同法同机 140s）

| 指标 | 基线 | 修复后 |
|---|---|---|
| 心跳 p99 / max | 367 / 2302 ms | **64 / 68 ms** |
| ≥150ms 停顿 | 139 次 | **0 次** |
| 主进程 CPU 平均 | 35.29% 单核 | **1.82%**（16 核整机折算 0.11%），≥10% 尖峰 205 → 8 |
| utility（数据面子进程）CPU | 0.07%（Electron 内部件） | 3.78%（采集负载整体迁入） |
| GPU 进程 max | 46.9% | 9.4%（nvidia-smi TTL 3s→5s） |

## 工具

- `loop-probe.mjs` — 主进程事件循环心跳探针（`node loop-probe.mjs --seconds 140`，需面板以 `--inspect=9229` 启动）
- `cpu-sample.ps1` — 面板进程树 500ms 间隔 CPU 采样（纯 ASCII：PS 5.1 不认无 BOM UTF-8 中文注释）
- `cpu-analyze.ps1` — 两轮 CSV 按 main/gpu/renderer/utility 分组统计
- `cpu-samples.csv` / `cpu-samples-after.csv` — 原始采样数据
- `events-after.jsonl` — 修复后运行的事件存证（dataplane-spawn ×1，无 dataplane-exit）

## 复测方法（回归用）

```bash
cd app
node_modules/electron/dist/electron.exe --inspect=9229 . --panel &   # 生产等价：面板子进程模式
node ../.scratch/mouse-lag/loop-probe.mjs --seconds 140             # 期望：≥150ms 停顿 0 次
```
