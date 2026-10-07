'use strict';
/**
 * 清单校验器（工单115，spec #109 seam③）——章法的牙齿：测试集任何增删改在 CI 被账本拦下。
 * 静态分析，零 Electron 零真机依赖，以 vitest 测试形态进现有 CI 流水线（test.yml 的 npm test）。
 *
 * 三件套（spec #109）：
 *   ① 段号字集 ↔ 清单条目集双向比对——新段未登记、删段不清账一律判红；
 *   ② 字段完备校验——清单条目缺段号/工单号/失效面/估计时长判红；
 *   ③ 分电池时长预算——估计时长求和 ≤ 该电池预算，超预算判红。
 * 另供 --accept-scope 的硬交叉校验（工单110 告警不阻断的升级）：声明未知段号即错。
 */

/** 电池源码里的段起笔字集：六电池全部单引号字面量、无模板串、无变量段号（工单114 交接） */
const SEGMENT_CALL_RE = /rep\.beginSegment\(\s*'([^']+)'/g;

/** 从电池源码提取段号字集（保序去重——同段重复起笔幂等，字集只记一次） */
function extractCodeSegments(source) {
  const out = [];
  const re = new RegExp(SEGMENT_CALL_RE.source, 'g');
  let m;
  while ((m = re.exec(String(source || ''))) !== null) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * 清单 ↔ 源码双向校验。
 * @param {{manifest: object, sources: Record<string, string>}} req
 *   manifest：清单对象（report.loadManifest() 的产物或夹具）；sources：batteryId → 源码全文。
 *   sources 缺某电池 = 该电池「清单在账、源码缺席」——判红（登记处指向的电池必须真实存在）。
 * @returns {{ok: boolean, errors: string[]}}
 */
function validateManifest(req = {}) {
  const manifest = req.manifest;
  const sources = req.sources || {};
  const errors = [];
  if (!manifest || !Array.isArray(manifest.batteries) || !manifest.batteries.length) {
    return { ok: false, errors: ['清单缺 batteries 数组（或清单缺位）'] };
  }
  if (!manifest.surfaces || typeof manifest.surfaces !== 'object') {
    errors.push('清单缺 surfaces 五枚举映射');
  }
  const legalSurfaces = new Set(Object.keys((manifest && manifest.surfaces) || {}));
  const seenIds = new Set();
  for (const b of manifest.batteries) {
    const where = `电池[${b && b.id}]`;
    if (!b || typeof b !== 'object') { errors.push('清单出现非对象电池条目'); continue; }
    if (!b.id) errors.push(`${where} 缺 id`);
    else if (seenIds.has(b.id)) errors.push(`${where} id 重复`);
    else seenIds.add(b.id);
    if (!b.entry) errors.push(`${where} 缺 entry（源码路径）`);
    if (!b.script) errors.push(`${where} 缺 script（npm run 别名）`);
    if (!Number.isFinite(b.budgetSeconds) || b.budgetSeconds <= 0) errors.push(`${where} 缺正数 budgetSeconds`);

    const segs = Array.isArray(b.segments) ? b.segments : [];
    if (!segs.length) errors.push(`${where} 段条目为空（电池无段=登记处与代码脱节）`);
    const manifestSegs = [];
    let estSum = 0;
    const seenSeg = new Set();
    for (const s of segs) {
      if (!s || typeof s !== 'object') { errors.push(`${where} 出现非对象段条目`); continue; }
      const tag = `${where} 段[${s.seg}]`;
      if (!s.seg) errors.push(`${tag} 缺段号`);
      else if (seenSeg.has(s.seg)) errors.push(`${tag} 段号电池内重复（撞号）`);
      else seenSeg.add(s.seg);
      if (!Number.isFinite(s.ticket)) errors.push(`${tag} 缺工单号 ticket（一段绑定一工单）`);
      if (!Array.isArray(s.surfaces) || !s.surfaces.length) errors.push(`${tag} 缺失效面 surfaces`);
      else for (const sf of s.surfaces) {
        if (!legalSurfaces.has(sf)) errors.push(`${tag} 失效面 "${sf}" 不在五枚举内`);
      }
      if (!Number.isFinite(s.estSeconds) || s.estSeconds <= 0) errors.push(`${tag} 缺正数估计时长 estSeconds`);
      else estSum += s.estSeconds;
      manifestSegs.push(s.seg);
    }
    if (Number.isFinite(b.budgetSeconds) && estSum > b.budgetSeconds) {
      errors.push(`${where} 估计时长总和 ${estSum}s 超预算 ${b.budgetSeconds}s（时长预算纪律）`);
    }
    // 双向比对①：清单有、代码无（删段不清账）
    const codeSegs = sources[b.id] !== undefined ? extractCodeSegments(sources[b.id]) : null;
    if (codeSegs === null) {
      errors.push(`${where} 源码未提供（entry=${b.entry}）——清单指向的电池必须可扫描`);
    } else {
      const codeSet = new Set(codeSegs);
      for (const seg of manifestSegs) {
        if (!codeSet.has(String(seg))) errors.push(`${where} 段 ${seg} 在清单登记但源码无 beginSegment（删段不清账）`);
      }
      // 双向比对②：代码有、清单无（新段未登记）
      const manifestSet = new Set(manifestSegs.map(String));
      for (const seg of codeSegs) {
        if (!manifestSet.has(seg)) errors.push(`${where} 段 ${seg} 在源码起笔但未入清单（新段未登记）`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * --accept-scope 硬交叉校验（工单115 升级）：声明的段号必须在本电池清单条目内。
 * @returns {{ok: boolean, unknown: string[]}}
 */
function validateScopeSegments(scope, manifest, batteryId) {
  const declared = Array.isArray(scope) ? scope.map(String) : [];
  if (!declared.length) return { ok: true, unknown: [] };
  const battery = (manifest && Array.isArray(manifest.batteries))
    ? manifest.batteries.find((b) => b && b.id === batteryId) : null;
  if (!battery || !Array.isArray(battery.segments)) {
    return { ok: false, unknown: declared.slice() }; // 清单缺位＝无从核对，视同全未知（调用方决定报错或降级告警）
  }
  const known = new Set(battery.segments.map((s) => String(s && s.seg)));
  return { ok: declared.every((s) => known.has(s)), unknown: declared.filter((s) => !known.has(s)) };
}

module.exports = { extractCodeSegments, validateManifest, validateScopeSegments, SEGMENT_CALL_RE };
