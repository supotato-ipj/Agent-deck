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
