'use strict';
// 工单119 取证分析器（纯函数）：uia-probe2.ps1 输出解析、轮次签名分型、臂级聚合与
// 判读表归行。判读规则在 docs/audit/2026-10-11-t119-uia-tray-empty-name.md 预登记
// ——单测测的是「规则按登记执行」，不是「规则对不对」（stall-duel-analyze 同款章法）。

/** probe JSONL → 结构化（坏行容忍：解析失败的行计数不中断） */
function parseProbeOutput(text) {
  const out = { hosts: [], dumps: [], steps: [], summary: null, badLines: 0 };
  for (const line of String(text || '').split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    let o;
    try { o = JSON.parse(s); } catch { out.badLines++; continue; }
    if (!o || typeof o !== 'object' || !o.kind) { out.badLines++; continue; }
    if (o.kind === 'host') out.hosts.push(o.host);
    else if (o.kind === 'dump') out.dumps.push(o);
    else if (o.kind === 'step') out.steps.push(o);
    else if (o.kind === 'summary') out.summary = o;
    else if (o.kind === 'fatal') out.fatal = o;
  }
  return out;
}

/** 步序列 → 三签名分型（勘误后口径，见票面勘误评论）：
 *  A-all-empty：每步焦点名全空（票面所述形态）
 *  B-frozen：非 A 且全程单一非空名（LEFT 未生效/焦点未落托盘——键盘注入面，只计数不归因）
 *  C-navigating：步名 ≥2 种（导航在走，含「有真托盘序列但无我方图标+夹空步」形态） */
function classifySteps(steps) {
  const names = steps.map((s) => (s.focus && s.focus.name) || '');
  const distinct = [...new Set(names)];
  if (names.length === 0) return { signature: 'no-steps', distinctNames: 0, frozenName: null };
  if (names.every((n) => n === '')) return { signature: 'A-all-empty', distinctNames: 1, frozenName: '' };
  if (distinct.length === 1) return { signature: 'B-frozen', distinctNames: 1, frozenName: distinct[0] };
  return { signature: 'C-navigating', distinctNames: distinct.length, frozenName: null };
}

/** 按钮级条目判定：空名口径只数按钮类条目（SystemTray 按钮/工具栏钮/开关钮）。
 *  结构性容器（TaskbarFrameAutomation/TrayNotifyWnd/Image/ReBarWindow32 等）
 *  天然无名——数它们会把 Windows 本底虚构成 100%（smoke 轮实证）。 */
function isButtonish(item) {
  const t = String((item && item.type) || '');
  const c = String((item && item.class) || '');
  return t.includes('Button') || c.startsWith('SystemTray') || c.startsWith('Toolbar');
}

/** dump → 托盘树观测摘要：按钮级空名项、我方图标登记在哪个宿主、末位空名按钮 */
function summarizeDump(dump, needle) {
  const items = Array.isArray(dump.items) ? dump.items : [];
  const names = items.map((it) => (it && typeof it.name === 'string') ? it.name : '');
  const lower = needle.toLowerCase();
  const agentDeckIdx = names.findIndex((n) => n.toLowerCase().includes(lower));
  const buttons = items.filter(isButtonish);
  const buttonNames = buttons.map((it) => (it && typeof it.name === 'string') ? it.name : '');
  return {
    when: dump.when,
    host: dump.host || null,
    hostClass: (dump.host && dump.host.class) || '',
    itemCount: items.length,
    truncated: !!dump.truncated,
    error: dump.error || null,
    emptyNames: buttonNames.filter((n) => n === '').length,
    emptyOtherNames: names.filter((n) => n === '').length - buttonNames.filter((n) => n === '').length,
    agentDeckPresent: agentDeckIdx >= 0,
    agentDeckName: agentDeckIdx >= 0 ? names[agentDeckIdx] : null,
    tailEmptyItem: buttons.length > 0 && buttonNames[buttonNames.length - 1] === '',
  };
}

/** 一轮 probe 输出 → 轮记录（签名 + 步级口径 + 双树口径） */
function classifyRound(parsed, needle = 'AGENT DECK') {
  const steps = parsed.steps;
  const stepInfo = classifySteps(steps);
  const emptySteps = steps.filter((s) => !(s.focus && s.focus.name)).length;
  const lower = needle.toLowerCase();
  const firstMatch = steps.findIndex((s) => s.focus && typeof s.focus.name === 'string' && s.focus.name.toLowerCase().includes(lower));
  const fgClasses = [...new Set(steps.map((s) => (s.fg && s.fg.class) || ''))];
  return {
    signature: stepInfo.signature,
    distinctNames: stepInfo.distinctNames,
    frozenName: stepInfo.frozenName,
    stepCount: steps.length,
    emptySteps,
    firstMatch: firstMatch >= 0 ? firstMatch : -1,
    fgClasses,
    fgOnTrayHost: fgClasses.includes('Shell_TrayWnd'),
    agentDeckInWalk: firstMatch >= 0,
    hostCount: parsed.hosts.length,
    hosts: parsed.hosts,
    trees: parsed.dumps.map((d) => summarizeDump(d, needle)),
    agentDeckHostClasses: parsed.dumps
      .filter((d) => summarizeDump(d, needle).agentDeckPresent)
      .map((d) => (d.host && d.host.class) || ''),
    probeSummary: parsed.summary || null,
    badLines: parsed.badLines,
    fatal: parsed.fatal || null,
  };
}

/** 空名观测口径（判读表输入）：步级空名 或 树里按钮级空名项/末位空名按钮。
 *  签名 B 不算空名观测（它没有空名步，也不看树——树口径对所有签名一致采集，
 *  但 B 的机理是键盘注入面，归因时另行登记）。 */
function roundHasEmptyNameObservation(round) {
  if (round.emptySteps > 0) return true;
  return round.trees.some((t) => t.emptyNames > 0 || t.tailEmptyItem);
}

/** 轮次数组 → 臂级聚合 */
function aggregateRounds(rounds) {
  const by = (k) => rounds.reduce((m, r) => { m[r[k]] = (m[r[k]] || 0) + 1; return m; }, {});
  const sig = {};
  for (const r of rounds) sig[r.signature] = (sig[r.signature] || 0) + 1;
  const stepsTotal = rounds.reduce((a, r) => a + r.stepCount, 0);
  const emptyStepsTotal = rounds.reduce((a, r) => a + r.emptySteps, 0);
  const roundsWithEmptyStep = rounds.filter((r) => r.emptySteps > 0).length;
  const emptyObsRounds = rounds.filter(roundHasEmptyNameObservation).length;
  const matched = rounds.filter((r) => r.firstMatch >= 0).length;
  const walkAgentDeck = rounds.filter((r) => r.agentDeckInWalk).length;
  const treeAgentDeck = rounds.filter((r) => r.trees.some((t) => t.agentDeckPresent)).length;
  const treeTailEmpty = rounds.filter((r) => r.trees.some((t) => t.tailEmptyItem)).length;
  const agentDeckByHost = rounds.flatMap((r) => r.agentDeckHostClasses || [])
    .reduce((m, c) => { m[c] = (m[c] || 0) + 1; return m; }, {});
  return {
    rounds: rounds.length,
    signatureCounts: sig,
    frozenNames: by('frozenName'),
    stepsTotal,
    stepEmptyRate: stepsTotal ? +(emptyStepsTotal / stepsTotal).toFixed(4) : null,
    roundEmptyStepRate: rounds.length ? +(roundsWithEmptyStep / rounds.length).toFixed(4) : null,
    emptyObsRoundRate: rounds.length ? +(emptyObsRounds / rounds.length).toFixed(4) : null,
    matchRate: rounds.length ? +(matched / rounds.length).toFixed(4) : null,
    walkAgentDeckRate: rounds.length ? +(walkAgentDeck / rounds.length).toFixed(4) : null,
    treeAgentDeckRate: rounds.length ? +(treeAgentDeck / rounds.length).toFixed(4) : null,
    treeTailEmptyRate: rounds.length ? +(treeTailEmpty / rounds.length).toFixed(4) : null,
    agentDeckByHost,
    hostCountHistogram: by('hostCount'),
    fgClassHistogram: rounds.flatMap((r) => r.fgClasses).reduce((m, c) => { m[c] = (m[c] || 0) + 1; return m; }, {}),
  };
}

/** 判读表归行（docs/audit §预登记，Q13 共识版）。statsByArm 键：baseline/idle/broadcast/relaunch。
 *  返回每行命中布尔 + 归行结论；结论互斥优先级自上而下。 */
function verdictRows(statsByArm) {
  const has = (arm) => {
    const s = statsByArm[arm];
    return !!(s && s.rounds > 0 && (s.emptyObsRoundRate > 0 || s.stepEmptyRate > 0 || s.treeTailEmptyRate > 0));
  };
  const baseline = has('baseline');
  const idle = has('idle');
  const broadcast = has('broadcast');
  const relaunch = has('relaunch');
  const allZero = !baseline && !idle && !broadcast && !relaunch;
  let row;
  if (allZero) row = 'R5-no-repro-fallback'; // 不直接关票：回 #119 议系统变量轮
  else if (baseline) row = 'R1-windows-floor'; // 裸托盘也有空名 → Windows/UIA 本底
  else if (idle) row = 'R2-independent-of-stall'; // 静置复现 → 空名独立于停摆成立
  else if (broadcast) row = 'R3-migration-window-linked'; // 仅扰动轮复现 → 收编迁移窗口强相关
  else row = 'R4-relaunch-only'; // 仅重启轮复现（重启专属混杂，需复核）
  return {
    observations: { baseline, idle, broadcast, relaunch, allZero },
    batteryPathConfirmed: broadcast && relaunch, // 臂3a+3b 同征 → P8 重启→P10 导航解释链闭合
    row,
  };
}

module.exports = { parseProbeOutput, classifySteps, summarizeDump, classifyRound, roundHasEmptyNameObservation, aggregateRounds, verdictRows };
