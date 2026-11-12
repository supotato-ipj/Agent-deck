/**
 * 独立执行上下文的资源预算（工单341，spec #326 收口）——**实测标定**，不是拍脑袋：
 *
 * 每个投放包 = 独立 `webContents` + 独立 session + 包页渲染进程（ADR-0025 为隔离付的代价）。
 * 真机 C10 段在 0/1/5/10 包下读面板全进程工作集（`app.getAppMetrics()` 汇总）：
 * **实测每包边际 102-113MB**（Chromium 渲染进程基线本来就 ~100MB，包页在其上很薄），
 * 据此取 **每包 128MB** 为预算上限（约 1.2x 实测余量，给不同机器/字体/DPR 的漂移留空间），
 * 同时在场包数上限取 **16**（16 × 102MB ≈ 1.7GB 边际工作集，整机约 2.8GB 封顶；
 * 超出即显式拒绝。首版曾按 24 包/80MB 起笔，C10 实测后按数据修正）。
 *
 * **超限行为 = 显式拒绝，不静默退化**：达到上限后的新包 `status=error`、
 * 事件 `dropped-package-budget-exceeded`（错误码 `package_budget_exceeded` 登记在契约目录）——
 * 用户看得到为什么没起来；不会出现「装上了但没渲染」的静默降级。
 */
export const MAX_LIVE_DROPPED_PACKAGES = 16

/** 每包边际内存预算（字节；C10 实测 102-113MB，取 128MB 为硬上限） */
export const PACKAGE_MARGINAL_MEMORY_BUDGET_BYTES = 128 * 1024 * 1024

/** 预算摘要（契约目录 resourceLimits 投影用） */
export const DROPPED_PACKAGE_BUDGET = Object.freeze({
  maxLiveDroppedPackages: MAX_LIVE_DROPPED_PACKAGES,
  marginalMemoryBytes: PACKAGE_MARGINAL_MEMORY_BUDGET_BYTES,
})

// —— 内存半边的运行时闸门（工单344，ADR-0027 增补段）——数量半边有硬门（第 17 个包
// 当场拒绝），内存半边由哨兵按下列参数把「挂在墙上的尺」变成「闸门」。参数即契约。

/** 哨兵采样节奏：每 10 秒一轮，仅在有在场投放包时跑（无包停表，开销有界） */
export const MEMORY_SENTINEL_INTERVAL_MS = 10_000

/** 连续超预算确认窗轮数：10s×3 ≈ 30 秒滞回——滤掉瞬时尖峰，不误杀正常包 */
export const MEMORY_SENTINEL_CONFIRM_ROUNDS = 3

/**
 * 哨兵判据尺（工单452，口径切换 2026-11-13：工作集 → 私有提交内存）。读数改取同一次
 * `getAppMetrics()` 的 `memory.privateBytes`（win32 现成字段，KB→bytes）——私有提交内存
 * 不受 Windows 工作集修剪扫击/深压配额夹死影响（#452 定谳：全形态稳态波动<10%，工作集
 * 口径一拍塌方 165MB→2MB、深压夹死线下漏报）。标定依据：包渲染进程私有基线实测
 * ~37-40MB，15 块 hog（60MB 堆）私有读数 88-99MB 全形态稳态，取 80MB ≈ 基线×2 为告警线
 * （余量 43MB 相对旧工作集口径 23MB 更宽，不收紧正常包）。
 * **与容量尺双尺并存、不换算**：本尺回答「这个包失控了吗」（哨兵判账，只经事件载荷
 * thresholdBytes 透出，不进契约目录）；上面 PACKAGE_MARGINAL_MEMORY_BUDGET_BYTES
 * （128MB 工作集口径）回答「这台机器还能装几个包」（resourceLimits/C10 系列继续用之）。
 */
export const PACKAGE_SENTINEL_PRIVATE_MEMORY_BUDGET_BYTES = 80 * 1024 * 1024
