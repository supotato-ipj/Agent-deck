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
 *
 * 工单204（spec #201 A1）增两道硬校验，与既有失效面五枚举治理同执行力：
 *   ④ 段级 areas 域标签——取值必须落在清单 areas 封闭词表内；段级缺省时取电池级
 *      （副电池单域覆盖口径），两处皆缺即判红（每段都必须有归属域）；
 *   ⑤ path→area 映射表完备性——源码目录须逐个登记、源码文件须被某条规则覆盖，
 *      且规则自身的域必须在封闭词表内（新目录不先定域＝耦合表有洞）。
 *
 * 工单214（spec #203 决策 1/2/5/6）增电池接入表接线校验（validateRegistry）：
 *   ⑥ flag 唯一——控制器身份旗标全表唯一（撞号＝两电池抢同一身份）；
 *   ⑦ entry 存在——登记处指向的电池模块必须真实在场；
 *   ⑧ script 派生一致——script 名不存表，由 flag 派生，package.json 必须有同形态 script；
 *   ⑨ cdpPort 唯一——CDP 端口全表唯一（撞号在 CI 即红，不等真机轮里连错页）；
 *   ⑩ experiment 条目豁免段级校验——取证工具（kind='experiment'）入表即获全套接线，
 *      但不冒充电池：不要求段/域标签/预算/Report 名绑定。
 *   ⑪ 双向完备——表内每电池接线五字段齐备；接线字段无孤儿（package.json 里出现
 *      的控制器旗标必须有表项、accept 目录在场电池脚本必须入表）。
 *
 * 工单220（spec #201 A 链 P1 机制补强）增文件级例外规则白名单校验（validateRequiredFileRules）：
 *   ⑫ 文件级例外规则不得被静默删/改域——目录级规则会兜住任何文件级规则，
 *      删掉一条（或把它的域改掉）耦合表照样"结构性完备"，选段就悄悄漏报。
 *      清单 requiredFileRules 登记全部文件级例外规则（path + 域），
 *      校验器据此判：白名单条目在映射表在场且域一致、映射表里的文件级规则都登记在案。
 */

/** 电池源码里的段起笔字集：六电池全部单引号字面量、无模板串、无变量段号（工单114 交接） */
const SEGMENT_CALL_RE = /rep\.beginSegment\(\s*'([^']+)'/g;
/** tripwire 宽匹配（评审 P2）：任何形态的起笔调用都该被字集正则认出，认不出的判红 */
const SEGMENT_CALL_LOOSE_RE = /beginSegment\s*\(/g;

/** 剥注释后的源码（tripwire 计数用）：块注释清空、行注释按「// 前不是冒号」剔除（保 http://） */
function stripJsComments(src) {
  return String(src || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1');
}

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
 * 仓库相对路径归一（工单204）：反斜杠转正斜杠、去 './' 前缀、去尾部斜杠。
 * 映射表与源码树两侧同一把尺，Windows 路径与 POSIX 写法都能命中。
 */
function normalizeRepoPath(p) {
  return String(p == null ? '' : p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * path→area 映射命中（工单204）：最长前缀命中——同目录内更细的规则覆盖更粗的目录规则
 * （例：app/src/renderer/taskbar-menu 覆盖 app/src/renderer/taskbar 下的菜单族文件）。
 * @param {string} path 仓库相对路径
 * @param {Array<{path: string, area: string, wires?: string}>} pathAreas 映射表
 * @returns {{path: string, area: string, wires?: string}|null}
 */
function matchPathArea(path, pathAreas) {
  const p = normalizeRepoPath(path);
  if (!p) return null;
  let best = null;
  let bestLen = -1;
  for (const rule of Array.isArray(pathAreas) ? pathAreas : []) {
    if (!rule || typeof rule.path !== 'string') continue;
    const rp = normalizeRepoPath(rule.path);
    if (!rp) continue;
    if (p !== rp && !p.startsWith(rp)) continue;
    if (rp.length > bestLen) { best = rule; bestLen = rp.length; }
  }
  return best;
}

/**
 * 域标签封闭词表（工单204）：清单 areas 键集——词表与映射表同处维护，取值越表即判红 */
function areaVocabulary(manifest) {
  return new Set(Object.keys((manifest && manifest.areas) || {}));
}

/**
 * 文件级例外规则识别（工单220）：path 末段带扩展名＝文件级规则（目录级规则的末段无扩展名）。
 * 与清单里 34 条文件级例外规则一一对应——它们正是"目录规则兜不住、必须单独立一条"的那批路径。
 * @param {string} path 仓库相对路径
 * @returns {boolean}
 */
function isFileLevelRulePath(path) {
  const p = normalizeRepoPath(path);
  if (!p) return false;
  const last = p.split('/').pop() || '';
  return last.includes('.');
}

/**
 * 文件级例外规则白名单校验（工单220，spec #201 A 链 P1 机制补强）——三道：
 *   ⑫a 白名单条目必须在 path→area 映射表在场（删一条即判红）；
 *   ⑫b 在场条目的域必须与白名单登记一致（改一域即判红）；
 *   ⑫c 映射表里的文件级规则必须都登记在白名单（白名单须是全量台账）。
 * 另：映射表有文件级规则而清单缺白名单 → 判红（白名单不得被整份删掉）。
 *
 * 纯函数：只吃清单，零 I/O。
 * @param {object} manifest 段级清单
 * @returns {string[]} 错误列表（空数组＝判绿）
 */
function validateRequiredFileRules(manifest) {
  const errors = [];
  const pathAreas = Array.isArray(manifest && manifest.pathAreas) ? manifest.pathAreas : [];
  const required = Array.isArray(manifest && manifest.requiredFileRules) ? manifest.requiredFileRules : [];
  const fileRules = pathAreas.filter((r) => r && typeof r.path === 'string' && isFileLevelRulePath(r.path));

  if (!required.length) {
    if (fileRules.length) {
      errors.push(`path→area 映射表有 ${fileRules.length} 条文件级例外规则，但清单缺 requiredFileRules 白名单（工单220：文件级规则不得被静默删/改域）`);
    }
    return errors;
  }

  // ⑫a ⑫b：白名单条目 → 映射表在场且域一致
  for (const req of required) {
    if (!req || typeof req !== 'object' || typeof req.path !== 'string' || !req.path) {
      errors.push('requiredFileRules 白名单出现非法条目（缺 path）');
      continue;
    }
    const rp = normalizeRepoPath(req.path);
    const hit = pathAreas.find((r) => r && typeof r.path === 'string' && normalizeRepoPath(r.path) === rp);
    if (!hit) {
      errors.push(`必需的文件级例外规则 "${rp}" 已从 path→area 映射表删除（工单220：文件级规则不得被静默删——删了它域归属就退回父目录规则）`);
      continue;
    }
    if (hit.area !== req.area) {
      errors.push(`必需的文件级例外规则 "${rp}" 的域被改（登记 ${req.area} → 现状 ${hit.area}）（工单220：文件级规则的域归属不得被静默改）`);
    }
    if (req.wires !== undefined && hit.wires !== req.wires) {
      errors.push(`必需的文件级例外规则 "${rp}" 的 wires 被改（登记 ${req.wires} → 现状 ${hit.wires}）（工单220：共享验收基建的接线面不得被静默改）`);
    }
  }

  // ⑫c：映射表里的文件级规则必须都在白名单登记
  for (const r of fileRules) {
    const rp = normalizeRepoPath(r.path);
    if (!required.some((q) => q && typeof q.path === 'string' && normalizeRepoPath(q.path) === rp)) {
      errors.push(`文件级例外规则 "${rp}" 未在 requiredFileRules 白名单登记（工单220：文件级规则必须登记在案，删/改域才判得出）`);
    }
  }

  return errors;
}

/**
 * 清单 ↔ 源码双向校验。
 * @param {{manifest: object, sources: Record<string, string>, presentEntries?: string[], sourceTree?: {dirs: string[], files: string[]}}} req
 *   manifest：清单对象（report.loadManifest() 的产物或夹具）；sources：batteryId → 源码全文。
 *   sources 缺某电池 = 该电池「清单在账、源码缺席」——判红（登记处指向的电池必须真实存在）。
 *   presentEntries：accept 目录下实际在场的电池脚本路径表（评审 P2 反向核对——新电池脚本
 *   不入清单则整块逃逸治理）；给出时，清单外的在场脚本判红。
 *   sourceTree：源码树枚举（工单204）——目录与文件，仓库相对路径；给出时核 path→area 完备性。
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
  // 域标签封闭词表（工单204）：词表缺位＝治理缺位——与失效面五枚举同款执行力
  if (!manifest.areas || typeof manifest.areas !== 'object' || !Object.keys(manifest.areas).length) {
    errors.push('清单缺 areas 域标签封闭词表（工单204）');
  }
  const legalSurfaces = new Set(Object.keys((manifest && manifest.surfaces) || {}));
  const legalAreas = areaVocabulary(manifest);
  // path→area 映射表（工单204）：规则先过词表，再核源码目录完备性
  const pathAreas = Array.isArray(manifest.pathAreas) ? manifest.pathAreas : [];
  if (!pathAreas.length) errors.push('清单缺 path→area 映射表（工单204：源码目录 → 域标签）');
  for (const r of pathAreas) {
    if (!r || typeof r !== 'object') { errors.push('path→area 映射表出现非对象规则'); continue; }
    const rp = typeof r.path === 'string' ? r.path : '';
    if (!rp) errors.push('path→area 映射规则缺 path');
    if (typeof r.area !== 'string' || !r.area) errors.push(`path→area 映射规则 "${rp || '?'}" 缺 area（域标签）`);
    else if (!legalAreas.has(r.area)) errors.push(`path→area 映射规则 "${rp}" 的域 "${r.area}" 不在域标签封闭词表内`);
    if (r.wires !== undefined && r.wires !== '*') {
      errors.push(`path→area 映射规则 "${rp || '?'}" 的 wires 只接受 "*"（共享验收基建）或缺省`);
    }
  }
  // 文件级例外规则白名单（工单220）：目录规则会兜住任何文件级规则——删一条或改一域，
  // 耦合表照样"结构性完备"，选段却悄悄漏报。白名单是这块的牙齿。
  errors.push(...validateRequiredFileRules(manifest));
  const seenIds = new Set();
  const knownEntries = new Set();
  for (const b of manifest.batteries) {
    const where = `电池[${b && b.id}]`;
    if (!b || typeof b !== 'object') { errors.push('清单出现非对象电池条目'); continue; }
    if (!b.id) errors.push(`${where} 缺 id`);
    else if (seenIds.has(b.id)) errors.push(`${where} id 重复`);
    else seenIds.add(b.id);
    if (!b.entry) errors.push(`${where} 缺 entry（源码路径）`);
    else knownEntries.add(b.entry);

    // 工单214：experiment 条目（取证工具）豁免段级治理——入表即获全套接线，
    // 但段/域标签/预算/Report 名绑定一概不适用（它不是电池，不冒充电池）。
    if (b.kind === 'experiment') continue;

    if (!Number.isFinite(b.budgetSeconds) || b.budgetSeconds <= 0) errors.push(`${where} 缺正数 budgetSeconds`);
    // 电池级域标签（工单204）：副电池单域覆盖用——取值同样必须在封闭词表内
    const batteryAreas = Array.isArray(b.areas) ? b.areas : [];
    for (const a of batteryAreas) {
      if (!legalAreas.has(a)) errors.push(`${where} 电池级域标签 "${a}" 不在域标签封闭词表内`);
    }

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
      // 段级域标签（工单204）：段级优先，缺则取电池级覆盖（副电池单域口径）；两处皆缺判红
      const segAreas = Array.isArray(s.areas) ? s.areas : [];
      for (const a of segAreas) {
        if (!legalAreas.has(a)) errors.push(`${tag} 域标签 "${a}" 不在域标签封闭词表内`);
      }
      const effAreas = segAreas.length ? segAreas : batteryAreas;
      if (!effAreas.length) errors.push(`${tag} 缺域标签 areas（段级与电池级至少一处登记，工单204）`);
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
      // tripwire（评审 P2）：宽匹配计数 > 字集正则认出的调用数 = 存在校验器读不懂的
      // 起笔形态（双引号/模板串/变量段号）——「新段未登记」会静默漏判，判红逼其回归字面量。
      const loose = (stripJsComments(sources[b.id]).match(SEGMENT_CALL_LOOSE_RE) || []).length;
      if (loose > codeSegs.length) {
        errors.push(`${where} 存在 ${loose - codeSegs.length} 处非单引号字面量形态的 beginSegment 起笔，校验器无法识别（章法：段起笔一律 rep.beginSegment('<seg>')）`);
      }
      // Report 名绑定（评审 P2）：运行期元数据与 scope 硬校验都按 Report 名对清单取数，
      // 名字对不上 = 校验器全绿但机制静默失效——源码必须出现 new Report('<id>')。
      if (!(new RegExp(`new\\s+Report\\(\\s*'${b.id}'`)).test(sources[b.id])) {
        errors.push(`${where} 源码未见 new Report('${b.id}')——Report 名与清单 id 不对应，元数据与 scope 硬校验会静默失效`);
      }
    }
  }
  // 反向核对（评审 P2）：accept 目录在场电池脚本必须全部入清单，否则整块逃逸治理
  for (const p of Array.isArray(req.presentEntries) ? req.presentEntries : []) {
    if (!knownEntries.has(p)) errors.push(`电池脚本 ${p} 在场但未入清单（新电池整块逃逸治理）`);
  }
  // path→area 映射表完备性（工单204）：源码目录逐个登记（新目录不先定域＝耦合表有洞），
  // 源码文件须被某条规则覆盖（否则改动落到哪个域说不清，选段就无从推理）
  if (req.sourceTree) {
    const exactPaths = new Set(pathAreas
      .filter((r) => r && typeof r.path === 'string' && r.path)
      .map((r) => normalizeRepoPath(r.path)));
    const rulePaths = [...exactPaths];
    for (const d of Array.isArray(req.sourceTree.dirs) ? req.sourceTree.dirs : []) {
      const key = normalizeRepoPath(d);
      if (!exactPaths.has(key)) errors.push(`源码目录 ${key} 未在 path→area 映射表登记（新目录必须先定域）`);
    }
    for (const f of Array.isArray(req.sourceTree.files) ? req.sourceTree.files : []) {
      const key = normalizeRepoPath(f);
      if (!rulePaths.some((rp) => key === rp || key.startsWith(rp))) {
        errors.push(`源码文件 ${key} 未被 path→area 映射表覆盖`);
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

/**
 * 电池接入表接线五字段（工单214，spec #203 决策 2）：flag/entry/hintBar/cdpPort/kind。
 * 段级管段、电池级管接线——新电池的登记面就这五个字段 ＋ 一个 npm script。
 */
const REGISTRY_FIELDS = ['flag', 'entry', 'hintBar', 'cdpPort', 'kind'];

/**
 * npm script 名由 flag 派生（工单214 决策 2：script 名不存表，避免两处登记漂移）。
 * --accept → accept；--accept-tray → accept:tray；--accept-taskbar-right-group → accept:taskbar-right-group。
 * @param {string} flag 控制器身份旗标
 * @returns {string} npm run 别名
 */
function deriveScriptName(flag) {
  return String(flag == null ? '' : flag).replace(/^--/, '').replace('-', ':');
}

/** package.json 的 script 命令行里出现的控制器旗标（--accept-scope 是段范围旗标，不算身份） */
function scriptFlags(cmd) {
  const out = [];
  for (const m of String(cmd || '').matchAll(/--[a-z][a-z0-9-]*/g)) {
    const flag = m[0];
    if (flag === '--accept-scope') continue;
    if (flag.startsWith('--accept')) out.push(flag);
  }
  return out;
}

/**
 * 电池接入表校验（工单214，spec #203 决策 2/5/6）——接线面的牙齿，六项：
 *   ① flag 唯一；② entry 文件存在；③ script 派生一致；④ cdpPort 唯一；
 *   ⑤ experiment 条目豁免段级校验（落在 validateManifest 内）；
 *   ⑥ 双向完备（表内每电池接线五字段齐备；接线字段无孤儿）。
 *
 * 纯函数：登记处事实由调用方注入（accept 目录在场文件、顶层电池脚本、package.json scripts），
 * 与既有 manifest-check 同款——静态分析、零 Electron 零真机依赖。
 *
 * @param {{manifest: object, acceptFiles?: string[], presentEntries?: string[], scripts?: Record<string,string>}} req
 *   acceptFiles：accept 目录递归枚举的在场文件（仓库根相对路径）——entry 存在性事实。
 *   presentEntries：顶层电池脚本全集（仓库根相对路径）——「在场必入表」事实。
 *   scripts：package.json 的 scripts 对象——script 派生一致与孤儿旗标事实。
 * @returns {{ok: boolean, errors: string[]}}
 */
function validateRegistry(req = {}) {
  const manifest = req.manifest;
  const errors = [];
  if (!manifest || !Array.isArray(manifest.batteries) || !manifest.batteries.length) {
    return { ok: false, errors: ['清单缺 batteries 数组（或清单缺位）'] };
  }
  const hasFileFacts = Array.isArray(req.acceptFiles);
  const acceptFiles = new Set((Array.isArray(req.acceptFiles) ? req.acceptFiles : []).map(normalizeRepoPath));
  const presentEntries = (Array.isArray(req.presentEntries) ? req.presentEntries : []).map(normalizeRepoPath);
  const scripts = (req.scripts && typeof req.scripts === 'object') ? req.scripts : {};

  const seenFlags = new Map(); // flag → 电池 id（① 撞号即红）
  const seenPorts = new Map(); // cdpPort → 电池 id（④ 撞号即红）
  const knownEntries = new Set();
  for (const b of manifest.batteries) {
    const where = `电池[${b && b.id}]`;
    if (!b || typeof b !== 'object') { errors.push('清单出现非对象电池条目'); continue; }
    // ⑥ 正向：接线五字段齐备（缺一即登记不完整）
    for (const f of REGISTRY_FIELDS) {
      if (!(f in b)) errors.push(`${where} 缺接线字段 ${f}（电池接入表五字段须齐备）`);
    }
    // ① flag 唯一
    const flag = b.flag;
    if (typeof flag !== 'string' || !flag) {
      errors.push(`${where} 缺 flag（控制器身份旗标）`);
    } else if (!flag.startsWith('--')) {
      errors.push(`${where} flag "${flag}" 形态非法（控制器身份旗标须以 -- 开头）`);
    } else if (seenFlags.has(flag)) {
      errors.push(`${where} flag "${flag}" 与电池[${seenFlags.get(flag)}] 重复（flag 全表唯一）`);
    } else {
      seenFlags.set(flag, b.id);
    }
    // ② entry 文件存在
    const entry = b.entry;
    if (typeof entry !== 'string' || !entry) {
      errors.push(`${where} 缺 entry（电池模块路径）`);
    } else {
      knownEntries.add(normalizeRepoPath(entry));
      if (hasFileFacts && !acceptFiles.has(normalizeRepoPath(entry))) {
        errors.push(`${where} entry "${entry}" 指向的文件不存在（登记处与实际电池脚本脱节）`);
      }
    }
    // ③ script 派生一致（script 名不存表，由 flag 派生）
    if (typeof flag === 'string' && flag) {
      const script = deriveScriptName(flag);
      if (!Object.prototype.hasOwnProperty.call(scripts, script)) {
        errors.push(`${where} flag "${flag}" 派生的 npm script "${script}" 在 package.json 不存在（script 名由 flag 派生，不另存表）`);
      }
    }
    // ④ cdpPort 唯一（可空：无端口的电池留空）
    const port = b.cdpPort;
    if (port === undefined || port === null) {
      // 留空合法
    } else if (!Number.isInteger(port) || port <= 0) {
      errors.push(`${where} cdpPort "${port}" 形态非法（可空数字，取正整数端口）`);
    } else if (seenPorts.has(port)) {
      errors.push(`${where} cdpPort ${port} 与电池[${seenPorts.get(port)}] 重复（CDP 端口全表唯一）`);
    } else {
      seenPorts.set(port, b.id);
    }
    if (b.hintBar !== undefined && typeof b.hintBar !== 'boolean') {
      errors.push(`${where} hintBar 非布尔（挂条条件由表派生）`);
    }
    if (b.kind !== undefined && b.kind !== null && typeof b.kind !== 'string') {
      errors.push(`${where} kind 非法（可空字符串；'experiment' 为取证工具）`);
    }
  }
  // ⑥ 反向：accept 目录在场电池脚本必须全部入表（否则整块逃逸接线治理）
  for (const p of presentEntries) {
    if (!knownEntries.has(p)) errors.push(`电池脚本 ${p} 在场但未入电池接入表（新电池整块逃逸接线治理）`);
  }
  // ⑥ 反向：package.json 里出现的控制器旗标必须有表项（接线字段无孤儿）
  for (const [name, cmd] of Object.entries(scripts)) {
    for (const flag of scriptFlags(cmd)) {
      if (!seenFlags.has(flag)) {
        errors.push(`package.json 的 script "${name}" 引用旗标 ${flag} 但电池接入表无此条目（接线字段有孤儿）`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  extractCodeSegments,
  validateManifest,
  validateScopeSegments,
  validateRegistry,
  validateRequiredFileRules,
  deriveScriptName,
  matchPathArea,
  areaVocabulary,
  normalizeRepoPath,
  isFileLevelRulePath,
  SEGMENT_CALL_RE,
  REGISTRY_FIELDS,
};
