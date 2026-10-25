'use strict';
/**
 * stall-duel 离线分析（工单132 第一阶段）：探针账合并、耦合统计、次序分类、预登记判读。
 * 纯函数零依赖——真机轮产出的 summary/harness-log/panel-events 喂进来，判读规则按
 * docs/audit/2026-10-09-t132-stall-duel-experiment.md §4 预登记执行，不事后挑数据。
 * 直测见 tests/accept/stall-duel-analyze.spec.ts。
 */

/** WM_NULL 探针样本 → 停摆事件：连续超时拍（发起间隔 ≤ mergeGapMs）合并为一段，
 * 段时长 = 末拍发起 − 首拍发起 + timeoutMs（首拍自身要吃满超时才落账）。
 * 时长 ≥ minDurationMs 才成事件（缺省 timeoutMs=2000 下单拍即 2000ms 恰达阈——与电池 WM_NULL 2s 口径一致，
 * 不存在会消失的形态；仅当自定义更小 timeoutMs 时短段不成事件，属调用方自选口径）。末拍后无恢复拍 = 终末段。 */
function dedupeProbeStalls(samples, opts = {}) {
  const mergeGapMs = opts.mergeGapMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 2000;
  const minDurationMs = opts.minDurationMs ?? 2000;
  const list = (samples || []).filter((s) => s && Number.isFinite(s.t)).slice().sort((a, b) => a.t - b.t);
  const events = [];
  let run = [];
  const flush = () => {
    if (!run.length) return;
    const onsetMs = run[0].t;
    const endMs = run[run.length - 1].t + timeoutMs;
    if (endMs - onsetMs >= minDurationMs) {
      events.push({ onsetMs, endMs, durationMs: endMs - onsetMs, terminal: false, probes: run.length });
    }
    run = [];
  };
  for (const s of list) {
    if (s.ok) { flush(); continue; }
    if (run.length && s.t - run[run.length - 1].t > mergeGapMs) flush();
    run.push(s);
  }
  flush();
  if (events.length && run.length === 0) {
    // 末段之后没有任何恢复拍：整轮以冻结收场（terminal 由调用方复核，这里以「样本流结尾即超时段结尾」判）
    const last = list[list.length - 1];
    if (last && !last.ok && events.length && events[events.length - 1].endMs === last.t + timeoutMs) {
      events[events.length - 1].terminal = true;
    }
  }
  return events;
}

/** t 到最近触发点的绝对时差（ms）；无触发点返回 null */
function nearestDeltaMs(t, triggerTimes) {
  let best = null;
  for (const x of triggerTimes || []) {
    const d = Math.abs(t - x);
    if (best === null || d < best) best = d;
  }
  return best;
}

/** 停摆事件对触发点的耦合统计：|onset − 触发| ≤ windowMs 计在窗 */
function couplingStats(stallOnsets, triggerTimes, opts = {}) {
  const windowMs = opts.windowMs ?? 2000;
  const deltas = (stallOnsets || []).map((t) => nearestDeltaMs(t, triggerTimes || []));
  const known = deltas.filter((d) => d !== null);
  const within = known.filter((d) => d <= windowMs);
  return {
    total: stallOnsets ? stallOnsets.length : 0,
    withinWindow: within.length,
    fraction: known.length ? within.length / known.length : 0,
    medianAbsDeltaMs: known.length ? known.slice().sort((a, b) => a - b)[Math.floor(known.length / 2)] : null,
  };
}

/** 每个主停摆事件的次序分类：±windowMs 内有 renderer 静默起点则按先后分类，否则 isolated */
function classifyOrder(mainStallOnsets, rendererQuietOnsets, opts = {}) {
  const windowMs = opts.windowMs ?? 20000;
  return (mainStallOnsets || []).map((onset) => {
    let best = null;
    for (const r of rendererQuietOnsets || []) {
      const d = r - onset;
      if (Math.abs(d) <= windowMs && (best === null || Math.abs(d) < Math.abs(best))) best = d;
    }
    if (best === null) return { onset, order: 'isolated', deltaMs: null };
    return { onset, order: best < 0 ? 'renderer-first' : 'main-first', deltaMs: best };
  });
}

/** main-lag 事件的 liveLabels 展平计数（降序） */
function labelDistribution(mainLagEvents) {
  const counts = new Map();
  for (const e of mainLagEvents || []) {
    for (const l of (e && e.liveLabels) || []) counts.set(l, (counts.get(l) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || (a.label < b.label ? -1 : 1));
}

function orderDrifts(orderClasses) {
  const set = new Set(orderClasses || []);
  return set.has('renderer-first') && set.has('main-first');
}

/**
 * 预登记判读（spec §4）。臂事实字段：
 *   stallCount / activeMinutes / couplingWithin / couplingTotal（对各自臂的定向触发：
 *   A 臂=keyboard-mode 迁移沿；B 臂=同拍 CDP 空eval——控制「有节奏活动」的零假设）/ labels
 *   phase-1b 追加：windCouplingWithin / windCouplingTotal（对 Win+D toggle 的耦合）。
 * verdict ∈ H1 | H7 | H4 | inconclusive | ambiguous；reasons 逐条给判据读数。
 */
function duelVerdict(input) {
  const { a, b, orderClasses = [], terminalSpanLabels = [], wind = false } = input;
  const reasons = [];
  const rateA = a.activeMinutes > 0 ? a.stallCount / a.activeMinutes : 0;
  const rateB = b.activeMinutes > 0 ? b.stallCount / b.activeMinutes : 0;
  const total = a.stallCount + b.stallCount;
  const fracA = a.couplingTotal > 0 ? a.couplingWithin / a.couplingTotal : 0;
  const fracB = b.couplingTotal > 0 ? b.couplingWithin / b.couplingTotal : 0;
  reasons.push(`A 臂 ${a.stallCount} 事件/${a.activeMinutes.toFixed(1)}min（${rateA.toFixed(2)}/min），B 臂 ${b.stallCount}/${b.activeMinutes.toFixed(1)}min（${rateB.toFixed(2)}/min）；A 耦合占比 ${(fracA * 100).toFixed(0)}%，B ${(fracB * 100).toFixed(0)}%`);

  if (total < 3) {
    return { verdict: 'inconclusive', reasons: [...reasons, '两臂合计停摆 <3：样本不足，按 spec §2 走 early-stop 升档或转 #127 形态定向取证'] };
  }
  if (wind) {
    const wfA = a.windCouplingTotal > 0 ? a.windCouplingWithin / a.windCouplingTotal : 0;
    const wfB = b.windCouplingTotal > 0 ? b.windCouplingWithin / b.windCouplingTotal : 0;
    const coverTerminal = terminalSpanLabels.length > 0 && terminalSpanLabels.every((l) => String(l).startsWith('cover-'));
    if (wfA >= 0.5 && wfB >= 0.5 && coverTerminal) {
      return { verdict: 'H4', reasons: [...reasons, `phase-1b：两臂 Win+D 耦合 ${(wfA * 100).toFixed(0)}%/${(wfB * 100).toFixed(0)}%（均 ≥50%）且终末 span 无 close 落在 cover-*（${terminalSpanLabels.join(', ')}）——遮罩守望状态迁移路径主嫌（#127 修正版 H4）`] };
    }
  }
  const bNearZero = b.stallCount === 0 || (rateA > 0 && rateB < 0.5 * rateA);
  if (fracA >= 0.5 && bNearZero) {
    return { verdict: 'H1', reasons: [...reasons, `A 臂停摆对 keyboard-mode 迁移沿耦合 ${(fracA * 100).toFixed(0)}% ≥50% 且 B 臂率不足 A 的一半——键盘模式三连主嫌（H1）；liveLabels 佐证：${(a.labels || []).join(', ') || '（无）'}`] };
  }
  const ratesClose = rateA > 0 && rateB > 0 && rateA / rateB >= 0.5 && rateA / rateB <= 2;
  if (a.stallCount >= 3 && b.stallCount >= 3 && ratesClose && fracA < 0.3 && fracB < 0.3 && orderDrifts(orderClasses)) {
    return { verdict: 'H7', reasons: [...reasons, `两臂率相当（比值 ${(rateA / rateB).toFixed(2)} ∈ [0.5,2]）、耦合均 <30%、次序跨轮漂移（${[...new Set(orderClasses)].join(' + ')}）——系统级输入管线竞争主嫌（H7）`] };
  }
  return {
    verdict: 'ambiguous',
    reasons: [...reasons, `判据组合未命中预登记任一主嫌规则：H1 需 A 耦合 ≥50% 且 B 率减半；H7 需两臂各 ≥3、率比 [0.5,2]、耦合 <30% 且次序漂移。次序分类在场：${[...new Set(orderClasses)].join(' + ') || '（无 renderer 观测窗）'}——按盲区波惯例如实标注，不冒充定嫌`],
  };
}

module.exports = {
  dedupeProbeStalls, nearestDeltaMs, couplingStats, classifyOrder, labelDistribution, duelVerdict,
};
