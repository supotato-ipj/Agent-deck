'use strict';
/**
 * 事件磁带 EventTape（工单205，spec #201 B 分支合刀批1 的前置模块票）——
 * 验收电池的观测总线收口模块：把「读事件 JSONL → 等某事件」从 8 块电池各一份的
 * 逐字拷贝收成一份正典实现（正典口径取 app/accept/battery.js）。
 *
 * 头注（母票决策12）：**新脚本一律用磁带与句柄**——事件观测走本模块（磁带），
 * 窗口观测走面板句柄（PanelHandle，由面板句柄模块票落地，本模块不造句柄）。
 * 存量 app/accept/experiments/ 取证脚本保留原状可考古，不迁。
 *
 * 语义逐字复刻既有实现（母票决策9/11：零行为修正）：
 *   - 半行自愈：事件文件正在被写时可能读到写了一半的行，解析失败的行静默滤过、
 *     下一拍自愈（不抛错、不算失败）。
 *   - 超时返回 null 不抛错（与既有 waitEvent 同形）。
 *   - 时间门由 since 参数统一承担（t0 语义：只认 e.t >= since 的拍），
 *     调用点不再手写 e.t >= t0。
 *   - wait 取「首个」匹配拍（既有 waitEvent 的 find 口径）；latest 取「最新一拍」
 *     （既有 readEvents().filter(...).pop() 口径）；all 裸读全量。
 *   - 两档默认超时由构造配置保真：主电池与 tray-spike 传 6000、taskbar 族传 8000；
 *     显式传参可覆盖构造默认。既有两档差异不「顺手统一」（母票决策8）。
 */

const fs = require('fs');

// wait 轮询间隔（与既有 waitEvent 的 sleep(60) 同款）
const POLL_INTERVAL_MS = 60;

// waitStable 轮询间隔（与既有 waitStable 的 sleep(250) 同款）
const STABLE_POLL_INTERVAL_MS = 250;

// waitStable 安静判据默认（与既有 waitStable 的 quietMs=2000 / timeoutMs=12000 同款）
const DEFAULT_QUIET_MS = 2000;
const DEFAULT_STABLE_TIMEOUT_MS = 12000;

// 构造未给 defaultTimeoutMs 时的兜底档（主电池档 6000；既有两档由调用方显式传，不在此统一）
const FALLBACK_DEFAULT_TIMEOUT_MS = 6000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 建一条绑定指定事件文件的磁带。
 * @param {string} eventsFile 事件 JSONL 绝对路径（面板经 DECK_EVENT_LOG 落的那个文件）
 * @param {{ defaultTimeoutMs?: number }} [options] 构造配置：默认超时档（毫秒）
 */
function createEventTape(eventsFile, options) {
  const opts = options || {};
  const defaultTimeoutMs = typeof opts.defaultTimeoutMs === 'number' && Number.isFinite(opts.defaultTimeoutMs)
    ? opts.defaultTimeoutMs
    : FALLBACK_DEFAULT_TIMEOUT_MS;

  /** 解析缓存：{ size, mtimeMs, events }——文件没变不重复解析 */
  let cache = null;

  /**
   * 读全量事件：逐行 JSON.parse，解析不了的行（写了一半的行）静默滤过。
   * 与既有 readEvents() 同口径——文件缺位/读不出 → 空数组，不抛错。
   *
   * 解析缓存（母票决策9）：以 (size, mtime) 为键，文件没变不重复解析；
   * 字节游标增量读不做（事件文件实测 36KB–412KB，性能无感，留作 interface
   * 不变的内部优化）。缓存只影响「读不读盘」；同 size 且同 mtime 的整体改写
   * 会读陈数据（面板只追加不触发——追加必改 size）。
   */
  function readAll() {
    let stat;
    try {
      stat = fs.statSync(eventsFile);
    } catch {
      cache = null; // 文件缺位：缓存作废，免得文件日后回来时拿陈数据充数
      return [];
    }
    if (cache && cache.size === stat.size && cache.mtimeMs === stat.mtimeMs) {
      return cache.events;
    }
    let text;
    try {
      text = fs.readFileSync(eventsFile, 'utf8');
    } catch {
      return [];
    }
    const events = text.split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
    cache = { size: stat.size, mtimeMs: stat.mtimeMs, events };
    return events;
  }

  /** 命中判据：type 过滤 + since 时间门（e.t >= since）+ 调用方谓词 */
  function hit(e, type, pred, since) {
    if (type !== undefined && e.type !== type) return false;
    if (since !== undefined && !(e.t >= since)) return false;
    if (pred && !pred(e)) return false;
    return true;
  }

  return {
    /**
     * 等某类事件：命中即返回「首个」匹配拍；超时返回 null（不抛错）。
     * @param {string} type 事件类型
     * @param {(e: any) => boolean} [pred] 附加谓词（null 视为无谓词——正典 8 处调用点显式传 null）
     * @param {{ since?: number, timeoutMs?: number }} [waitOptions] since=时间门；timeoutMs 覆盖构造默认
     */
    async wait(type, pred, waitOptions) {
      const o = waitOptions || {};
      const timeoutMs = typeof o.timeoutMs === 'number' ? o.timeoutMs : defaultTimeoutMs;
      const since = o.since;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = readAll().find((e) => hit(e, type, pred, since));
        if (found) return found;
        await sleep(POLL_INTERVAL_MS);
      }
      return null;
    },

    /**
     * 等「最后一拍距今安静」：某类型最后一拍距今已静默 quietMs 即交出那一拍；
     * 一直没安静则超时返回 null（不抛错）。沿用旧名 waitStable。
     * @param {string} type 事件类型
     * @param {number} [quietMs] 安静判据（毫秒），默认 2000
     * @param {number} [timeoutMs] 超时（毫秒），默认 12000
     */
    async waitStable(type, quietMs, timeoutMs) {
      const quiet = typeof quietMs === 'number' ? quietMs : DEFAULT_QUIET_MS;
      const limit = typeof timeoutMs === 'number' ? timeoutMs : DEFAULT_STABLE_TIMEOUT_MS;
      const deadline = Date.now() + limit;
      while (Date.now() < deadline) {
        const evts = readAll().filter((e) => e.type === type);
        const last = evts.length ? evts[evts.length - 1] : null;
        if (last && Date.now() - last.t >= quiet) return last;
        await sleep(STABLE_POLL_INTERVAL_MS);
      }
      return null;
    },

    /**
     * 现取最新一拍（既有 readEvents().filter(...).pop() 口径）；无匹配拍返回 null。
     * @param {string} type 事件类型
     * @param {(e: any) => boolean} [pred] 附加谓词（null 视为无谓词）
     * @param {{ since?: number }} [queryOptions] since=时间门
     */
    latest(type, pred, queryOptions) {
      const o = queryOptions || {};
      const hits = readAll().filter((e) => hit(e, type, pred, o.since));
      return hits.length ? hits[hits.length - 1] : null;
    },

    /**
     * 裸读全量（可按 type / 谓词 / since 过滤）。
     * @param {string} [type] 事件类型；省略 = 不按类型过滤
     * @param {(e: any) => boolean} [pred] 附加谓词（null 视为无谓词）
     * @param {{ since?: number }} [queryOptions] since=时间门
     */
    all(type, pred, queryOptions) {
      const o = queryOptions || {};
      return readAll().filter((e) => hit(e, type, pred, o.since));
    },
  };
}

module.exports = { createEventTape };
