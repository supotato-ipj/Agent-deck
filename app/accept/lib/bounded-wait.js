'use strict';
// 有界 settle 等待 helper（工单123，spec #125 Phase 0）——电池读侧时序共通件。
// 两条硬原则（票面）：等待必须有界（无界重试会把「元素真丢失」的真回归糊成绿）；
// 超界失败由调用方抓现场证据（本 helper 只回报未收敛事实：ok=false + attempts/elapsedMs）。
// 轮询与时钟可注入（sleep/now），vitest 在纯函数缝打外部契约（battery-config helper 同款）。

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 轮询 probe 直到产出非空值（非 null/undefined）或有界超时。
 * probe 抛错按未命中处置（瞬态抖动界内重试）；超界返回 ok=false，不抛、不无界。
 * @param {() => Promise<*> | *} probe 每次探测（如 CDP 读 DOM）；null/undefined 视为未命中
 * @param {{timeoutMs: number, intervalMs?: number, sleep?: (ms: number) => Promise<void>, now?: () => number}} opts
 * @returns {Promise<{ok: boolean, value: *, attempts: number, elapsedMs: number}>}
 */
async function waitForProbe(probe, { timeoutMs, intervalMs = 150, sleep = defaultSleep, now = Date.now } = {}) {
  const start = now();
  let attempts = 0;
  let value;
  while (now() - start < timeoutMs) {
    attempts += 1;
    try {
      value = await probe();
    } catch {
      value = null; // probe 抛错（如 CDP 瞬态失败）= 未命中，界内重试
    }
    if (value !== null && value !== undefined) {
      return { ok: true, value, attempts, elapsedMs: now() - start };
    }
    await sleep(intervalMs);
  }
  return { ok: false, value: value ?? null, attempts, elapsedMs: now() - start };
}

module.exports = { waitForProbe };
