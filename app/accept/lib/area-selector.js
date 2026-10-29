'use strict';
/**
 * 定向验收轮选择器（工单207，spec #201 A 分支决策4/5）——纯函数核心。
 *
 * 变更文件集 → 命中域 → 运行计划：哪几块电池整块跑、主电池内哪些段按 --accept-scope 跑。
 * 纯函数：只吃入参（变更文件集 + 段级清单），不碰文件系统、不碰真机、不占验收槽——
 * CLI 只打印计划与拼好的 accept-guard hold 命令行，执行仍走 accept-guard 调度协议。
 *
 * 判据来源（工单204 登记处）：域标签封闭词表（manifest.areas）、path→area 映射表
 * （manifest.pathAreas）、段级/电池级 areas、公共底座域（manifest.wideAreas）。
 */

const { matchPathArea, normalizeRepoPath, deriveScriptName } = require('./manifest-check');

/** 验收域标签：app/accept 下的电池代码不是面板域，而是「谁接线」的线索 */
const ACCEPT_AREA = 'accept';
/** 跨域阈值：命中这么多域即视为「跨域大改」，给保守计划（多跑不少跑） */
const CROSS_DOMAIN_THRESHOLD = 3;

/**
 * 段/电池的有效域标签：段级优先，缺则取电池级（电池级覆盖口径：域数不限，可单域可多域，工单204）
 * @param {{areas?: string[]}} battery
 * @param {{areas?: string[]}} segment
 * @returns {string[]}
 */
function effectiveAreas(battery, segment) {
  const seg = segment && Array.isArray(segment.areas) ? segment.areas : [];
  if (seg.length) return seg.slice();
  const bat = battery && Array.isArray(battery.areas) ? battery.areas : [];
  return bat.slice();
}

/**
 * 选段：变更文件集 → 运行计划（纯函数，零 I/O）
 * @param {{changedFiles?: string[], manifest?: object|null}} req
 * @returns {{
 *   areas: string[], conservative: boolean, reasons: string[],
 *   batteries: {id: string, title: string, script: string, mode: 'full'|'scoped', segments: string[], reason: string}[],
 *   unmapped: string[], ignored: string[], changedFiles: string[],
 * }}
 */
function selectPlan(req = {}) {
  const manifest = req.manifest || null;
  // 工单214：experiment 条目（取证工具）不是电池——无段、不进电池轮计划（它自带参数与轮次账）
  const batteries = ((manifest && Array.isArray(manifest.batteries)) ? manifest.batteries : [])
    .filter((b) => b && b.kind !== 'experiment');
  const pathAreas = (manifest && Array.isArray(manifest.pathAreas)) ? manifest.pathAreas : [];
  const wideAreas = new Set((manifest && Array.isArray(manifest.wideAreas)) ? manifest.wideAreas : []);
  const sourceRoots = (manifest && Array.isArray(manifest.sourceRoots) && manifest.sourceRoots.length)
    ? manifest.sourceRoots : ['app/src'];

  const files = [];
  for (const raw of (Array.isArray(req.changedFiles) ? req.changedFiles : [])) {
    const p = normalizeRepoPath(raw);
    if (p && !files.includes(p)) files.push(p);
  }

  const areas = [];
  const reasons = [];
  const unmapped = [];
  const ignored = [];
  const wired = new Map(); // batteryId → 接线理由
  let sharedAccept = false;

  const addArea = (a) => { if (a && !areas.includes(a)) areas.push(a); };

  for (const f of files) {
    const rule = matchPathArea(f, pathAreas);
    const inSource = sourceRoots.some((r) => f === r || f.startsWith(r + '/'));
    if (inSource) {
      // 面板源码：改哪片代码 → 命中哪个域
      if (!rule) {
        unmapped.push(f);
        reasons.push(`源码文件 ${f} 未被 path→area 映射表覆盖（映射表有洞 → 波及面说不清）`);
        continue;
      }
      addArea(rule.area);
      continue;
    }
    if (f.startsWith('app/accept/')) {
      // 验收域：电池自身代码也会坏——把接线它的电池算进计划
      addArea(ACCEPT_AREA);
      if (rule && rule.wires === '*') {
        sharedAccept = true;
        reasons.push(`共享验收基建 ${f} 改动 → 全部电池接线受牵连`);
        continue;
      }
      const owner = batteries.find((b) => b && normalizeRepoPath(b.entry) === f);
      if (owner) wired.set(owner.id, `电池代码 ${f} 改动 → 接线它的电池 ${owner.id} 受牵连（整块跑）`);
      continue;
    }
    ignored.push(f); // 文档等非面板域改动：不进验收计划
  }

  const panelAreas = areas.filter((a) => a !== ACCEPT_AREA);
  const wideHit = panelAreas.filter((a) => wideAreas.has(a));
  if (wideHit.length) reasons.push(`命中公共底座域 ${wideHit.join(', ')}（波及面未知）→ 保守计划`);
  if (panelAreas.length >= CROSS_DOMAIN_THRESHOLD) {
    reasons.push(`改动命中 ${panelAreas.length} 个域（跨域大改）→ 保守计划`);
  }
  const conservativeTrigger = !!(unmapped.length || sharedAccept || wideHit.length
    || panelAreas.length >= CROSS_DOMAIN_THRESHOLD);

  const out = [];
  const pushBattery = (b, mode, segments, reason) => {
    out.push({
      id: b.id,
      title: b.title || b.id,
      // npm run 别名由 flag 派生（工单214 决策 2：script 名不存电池接入表）
      script: b.flag ? deriveScriptName(b.flag) : '',
      mode,
      segments: segments || [],
      reason: reason || '',
    });
  };

  if (conservativeTrigger) {
    for (const b of batteries) pushBattery(b, 'full', [], '保守计划：全部电池整块跑');
  } else {
    for (const b of batteries) {
      const segs = Array.isArray(b.segments) ? b.segments : [];
      const hitSegs = segs.filter((s) => effectiveAreas(b, s).some((a) => areas.includes(a)));
      if (!hitSegs.length) continue;
      const hitAreas = [...new Set(hitSegs.flatMap((s) => effectiveAreas(b, s).filter((a) => areas.includes(a))))];
      const reason = `命中域 ${hitAreas.join(', ')}`;
      // scope 能力且命中段是全部段的真子集 → 按段声明范围段；否则整块跑
      if (b.scope === true && hitSegs.length < segs.length) {
        pushBattery(b, 'scoped', hitSegs.map((s) => String(s.seg)), reason);
      } else {
        pushBattery(b, 'full', [], reason);
      }
    }
  }

  // 纯 accept 改动：接线它的电池整块跑（不漏「电池代码也会坏」这条线）
  for (const [id, reason] of wired) {
    const ex = out.find((x) => x.id === id);
    if (ex) {
      ex.mode = 'full';
      ex.segments = [];
      ex.reason = reason;
    } else {
      const b = batteries.find((x) => x.id === id);
      if (b) pushBattery(b, 'full', [], reason);
    }
  }

  const conservative = conservativeTrigger || !!(batteries.length && out.length === batteries.length);
  return { areas, conservative, reasons, batteries: out, unmapped, ignored, changedFiles: files };
}

/**
 * 拼 accept-guard hold 命令行（只拼不跑——多检出并行安全，不占验收槽）
 * @param {{batteries: {script: string, mode: string, segments: string[]}[]}} plan
 * @param {{guard?: string, holder?: string, purpose?: string}} [opts]
 * @returns {string[]}
 */
function buildGuardCommands(plan, opts = {}) {
  const guard = opts.guard || 'node guard.mjs';
  const holder = opts.holder || 'agent';
  const purpose = opts.purpose || 'selftest';
  const cmds = [];
  const list = plan && Array.isArray(plan.batteries) ? plan.batteries : [];
  for (const b of list) {
    const scopeArg = (b.mode === 'scoped' && Array.isArray(b.segments) && b.segments.length)
      ? ` -- --accept-scope ${b.segments.join(',')}` : '';
    cmds.push(`${guard} hold --as ${holder} --purpose ${purpose} -- npm run ${b.script}${scopeArg}`);
  }
  return cmds;
}

module.exports = {
  selectPlan,
  buildGuardCommands,
  effectiveAreas,
  ACCEPT_AREA,
  CROSS_DOMAIN_THRESHOLD,
};
