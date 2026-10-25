'use strict';
const fs = require('fs');
const path = require('path');
const { validateScopeSegments } = require('./manifest-check');

const EVIDENCE_DIR = path.join(__dirname, '..', 'evidence');
if (!fs.existsSync(EVIDENCE_DIR)) fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

/** 段级清单（工单114：唯一登记处）。缺文件/坏 JSON → null（报告降级为无元数据，不炸）。 */
const MANIFEST_FILE = path.join(__dirname, '..', 'manifest.json');
let manifestCache; // undefined=未读；null=读不到；object=已加载
function loadManifest() {
  if (manifestCache === undefined) {
    try { manifestCache = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8')); } catch { manifestCache = null; }
  }
  return manifestCache;
}

/** 失效面标注文本：清单 surfaces 键 → 中文标签（键缺地图时原样回显枚举键） */
function surfaceLabels(manifest, surfaces) {
  const map = (manifest && manifest.surfaces) || {};
  return (surfaces || []).map((s) => map[s] || s).join('+');
}

/**
 * verdict 三态 → 进程退出码（工单110）：guard 与自动化编排按此分辨三种结局。
 * PASS(0) 干净跑完；FAIL-CODE(1) 存在未定责失败；FAIL-ENV(2) 全部失败已定责环境。
 */
const EXIT_CODES = { PASS: 0, 'FAIL-CODE': 1, 'FAIL-ENV': 2 };

/** 段号归一：保真字符串（P7S 这类带后缀的段标签合法），去重保序 */
function normalizeScope(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : (list ? [list] : [])) {
    for (const tok of String(raw).split(',')) {
      const seg = tok.trim();
      if (seg && !out.includes(seg)) out.push(seg);
    }
  }
  return out;
}

/**
 * --accept-scope 解析（纯函数）：`--accept-scope P6,P8` 或 `--accept-scope=P6,P8`，
 * 可重复出现，段号去重保序。段号以字符串保真，便于后续清单票（#114/#115）交叉校验。
 */
function parseAcceptScope(argv) {
  const out = [];
  const argvs = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < argvs.length; i++) {
    const a = argvs[i];
    if (a === '--accept-scope') {
      // 末尾裸旗标（无值）不炸：只收真实存在的下一个 token
      if (typeof argvs[i + 1] === 'string') out.push(argvs[i + 1]);
      i++;
    } else if (typeof a === 'string' && a.startsWith('--accept-scope=')) { out.push(a.slice('--accept-scope='.length)); }
  }
  return normalizeScope(out);
}

/**
 * 验收报告状态机（工单110 三态记账）：零界面依赖的纯状态机。
 *
 * 三路记账：passes（通过）/ fails（未定责失败）/ excluded（环境降责排除，条目附原因与归因）。
 * 排除窗：beginEnvWindow 开启（停摆检出）→ endEnvWindow 闭合（面板重启验证健康）；
 * 窗内 fail() 自动改记排除而非失败——环境噪声不再污染 verdict，窗外照常。
 * 段注册：beginSegment（段起笔报段号）——断言按当前段入账；元数据由段级清单供给
 * （工单114）。--accept-scope 声明的 spec 范围段在构造期对清单硬交叉校验（未知段号
 * 即抛，工单115），verdict 时再与轮内实跑段核对（范围段被打断 → 合并门裁决须重跑）。
 * verdict 判定：存在未定责失败 → FAIL-CODE；全部失败已定责环境 → FAIL-ENV；无失败 → PASS。
 * 显式传入 verdict 字符串的旧调用（五块副电池）保持原行文与原返回形状，零迁移成本。
 */
class Report {
  /**
   * @param {string} name 报告名（即证据日志文件名主体；同时是清单 battery.id 的匹配键）
   * @param {{file?: string|null, scope?: string[], manifest?: object|null}} [opts]
   *   file：string=显式路径，null=纯内存运行（单测夹具），缺省=证据目录；
   *   scope：--accept-scope 声明的 spec 范围段；
   *   manifest：段级清单对象（工单114）。undefined=读缺省清单文件（缓存）；null=显式无清单。
   */
  constructor(name, opts = {}) {
    this.name = name;
    this.file = opts.file === undefined ? path.join(EVIDENCE_DIR, `${name}.log.txt`) : opts.file;
    if (this.file) fs.writeFileSync(this.file, `# accept ${name} — ${new Date().toISOString()}\n`);
    this.passes = 0;
    this.fails = 0;
    this.excluded = 0;
    /** 排除账目：{ msg, reason, attribution, inWindow } */
    this.exclusions = [];
    /** 排除窗：null=关闭；开启期间 fail() 改记环境降责排除 */
    this.envWindow = null;
    /** --accept-scope 声明的 spec 范围段（段号字符串，去重保序） */
    this.declaredScope = normalizeScope(opts.scope);
    /** 段级清单（工单114）：undefined 入参 → 读缺省清单文件；报告启动加载，段注册时按名取元数据 */
    const manifest = opts.manifest === undefined ? loadManifest() : opts.manifest;
    this.manifest = manifest || null;
    /** 本报告名对应的清单电池条目（无登记 = null，副电池逐块归账后即有） */
    this.manifestBattery = (this.manifest && Array.isArray(this.manifest.batteries))
      ? this.manifest.batteries.find((b) => b && b.id === name) || null
      : null;
    // --accept-scope 硬交叉校验（工单115）：清单在位时声明的段号必须已登记，未知段号
    // 启动即错（烧完 7 分钟才发现声明打错的事不再发生）；清单缺位（fixture/未归账电池）
    // 保持工单110 的告警不阻断形态。规则单点在 manifest-check.validateScopeSegments。
    if (this.declaredScope.length && this.manifestBattery) {
      const { unknown } = validateScopeSegments(this.declaredScope, this.manifest, name);
      if (unknown.length) {
        throw new Error(`--accept-scope 声明的段号未在清单登记：${unknown.join(', ')}（电池 ${name}，工单115 硬交叉校验）`);
      }
    }
    /** 段注册账：beginSegment 依序登记的 { seg, title, ticket, surfaces, passes, fails, excluded, startedAt, durationMs } */
    this.segments = [];
    /** 当前段（beginSegment 起笔后的入账归属） */
    this.currentSegment = null;
  }

  log(msg) {
    const line = `[${new Date().toISOString().slice(11, 23)}] ${msg}`;
    console.log(line);
    if (this.file) fs.appendFileSync(this.file, line + '\n');
  }

  /** 仅落盘不进控制台（verdict 后的账目明细用，控制台保持判决一行+WARN） */
  _fileOnly(msg) {
    if (this.file) fs.appendFileSync(this.file, `${msg}\n`);
  }

  /** 当前断言按段入账（无段起笔时为轮级计数，段账目空） */
  _tally(key) { if (this.currentSegment) this.currentSegment[key]++; }

  pass(msg) { this.passes++; this._tally('passes'); this.log(`PASS  ${msg}`); }
  fail(msg) {
    // 排除窗内：失败断言记环境降责排除而非失败（窗内排除/窗外照常）
    if (this.envWindow) { this.exclude(msg, this.envWindow.reason, this.envWindow.attribution); return; }
    this.fails++;
    this._tally('fails');
    this.log(`FAIL  ${msg}`);
  }
  note(msg) { this.log(`NOTE  ${msg}`); }

  /**
   * 记一条环境降责排除：环境噪声打断的断言/事件进排除账而非失败账。
   * @param {string} msg 断言或事件描述
   * @param {string} reason 环境根因（可读证据）
   * @param {string} attribution 归因标记（机制侧来源，如 panel-stall / preflight-overlay）
   */
  exclude(msg, reason, attribution) {
    const entry = {
      msg,
      reason: reason || (this.envWindow && this.envWindow.reason) || '环境扰动',
      attribution: attribution || (this.envWindow && this.envWindow.attribution) || 'unattributed',
      inWindow: Boolean(this.envWindow),
    };
    this.excluded++;
    this._tally('excluded');
    this.exclusions.push(entry);
    this.log(`EXENV ${entry.msg}（原因=${entry.reason}｜归因=${entry.attribution}${entry.inWindow ? '｜排除窗内' : ''}）`);
  }

  /**
   * 开启排除窗（停摆检出时）：窗内失败断言自动记环境降责排除，直至 endEnvWindow。
   * 已开启时并入当前窗（后续停摆事件各记一条排除条目，不重置窗口）。
   */
  beginEnvWindow(reason, attribution) {
    if (this.envWindow) {
      this.note(`排除窗已开启（${this.envWindow.reason}），本次事件并入当前窗`);
      return;
    }
    this.envWindow = {
      reason: reason || '环境扰动',
      attribution: attribution || 'env',
      openedAt: Date.now(),
      openedIndex: this.exclusions.length,
    };
    this.note(`排除窗开启：${this.envWindow.reason}（归因=${this.envWindow.attribution}）——窗内失败断言记环境降责，不计失败`);
  }

  /** 闭合排除窗（面板重启验证健康时）。未开启时是 no-op。 */
  endEnvWindow(how) {
    if (!this.envWindow) return false;
    const swept = this.exclusions.length - this.envWindow.openedIndex;
    this.note(`排除窗闭合（${how || '扰动解除'}）：窗内排除 ${swept} 条`);
    this.envWindow = null;
    return true;
  }

  /** 清单段条目查找（本报告电池名下；无清单/无条目返回 null） */
  _manifestSegment_(seg) {
    if (!this.manifestBattery || !Array.isArray(this.manifestBattery.segments)) return null;
    return this.manifestBattery.segments.find((s) => s && String(s.seg) === seg) || null;
  }

  /** 闭合当前段的实测墙钟（下一笔起笔或 verdict 时调用） */
  _closeSegment_(now) {
    if (this.currentSegment && this.currentSegment.durationMs == null) {
      this.currentSegment.durationMs = Math.max(0, now - this.currentSegment.startedAt);
    }
  }

  /**
   * 段注册（段起笔报段号）：断言自此按段入账，直至下一笔起笔。同段重复起笔幂等。
   * 工单114：命中清单条目时 SEG 行带工单号与失效面标注（清单是唯一登记处，代码只报段号）；
   * 段条目同时记 startedAt，闭合（下一笔起笔/verdict）时得实测墙钟时长。
   * @param {string|number} seg 段号（清单票落地后与段级清单交叉校验）
   * @param {string} [title] 段标题（可选；显式传入优先于清单标题）
   */
  beginSegment(seg, title) {
    const id = String(seg);
    if (this.currentSegment && this.currentSegment.seg === id) return this.currentSegment;
    this._closeSegment_(Date.now());
    const entry = this._manifestSegment_(id);
    const label = title || (entry && entry.title) || '';
    this.currentSegment = {
      seg: id, title: label,
      ticket: entry ? entry.ticket : null,
      surfaces: entry ? (entry.surfaces || []).slice() : [],
      passes: 0, fails: 0, excluded: 0,
      startedAt: Date.now(), durationMs: null,
    };
    this.segments.push(this.currentSegment);
    const ann = entry ? `｜工单${entry.ticket}｜失效面=${surfaceLabels(this.manifest, entry.surfaces)}` : '';
    this.log(`SEG   ▶ ${id}${label ? ` ${label}` : ''}${ann}`);
    if (!entry) this.note(`段 ${id} 未在清单登记（清单↔代码双向同步由 CI 校验器拦截，工单115）`);
    return this.currentSegment;
  }

  /** 三态判定（不落盘）：verdict 字符串 + 退出码 */
  triVerdict() {
    // 未定责失败在场 → FAIL-CODE（哪怕同时有排除账）；否则有排除账 → FAIL-ENV；干净 → PASS
    const verdict = this.fails > 0 ? 'FAIL-CODE' : (this.excluded > 0 ? 'FAIL-ENV' : 'PASS');
    return { verdict, exitCode: EXIT_CODES[verdict] };
  }

  /**
   * 判决并落账。缺省按三态规则自判（主电池用法）；显式传字符串为旧二态用法
   * （副电池 `rep.verdict(rep.fails === 0 ? 'PASS' : 'FAIL')`），行文与退出码保持原语义。
   */
  verdict(explicit) {
    this._closeSegment_(Date.now()); // 末段实测墙钟在判决时闭合（User Story 22）
    const tri = this.triVerdict();
    const label = explicit || tri.verdict;
    const exitCode = explicit ? (EXIT_CODES[explicit] ?? 1) : tri.exitCode;
    const scopePart = this.declaredScope.length ? ` scope=${this.declaredScope.join(',')}` : '';
    if (explicit) {
      this.log(`===== ${this.name} VERDICT: ${label} (pass=${this.passes} fail=${this.fails}) =====`);
    } else {
      this.log(`===== ${this.name} VERDICT: ${label} (pass=${this.passes} fail=${this.fails} excluded=${this.excluded}${scopePart}) =====`);
    }

    // 清单范围段标注（工单114）：声明了 --accept-scope 且清单可解析时，逐段给出
    // 工单号与失效面——验收者一眼看清「这轮在验谁的什么面」。
    if (this.declaredScope.length && this.manifestBattery) {
      for (const s of this.declaredScope) {
        const e = this._manifestSegment_(s);
        if (e) this.log(`NOTE  清单范围段 ${s}：${(e.title || '')}｜工单${e.ticket}｜失效面=${surfaceLabels(this.manifest, e.surfaces)}｜估计 ${e.estSeconds}s`);
        else this.note(`清单范围段 ${s} 缺条目（构造期硬校验已在场——防御路径，不应到达）`);
      }
    }

    // --accept-scope 与轮内实跑段核对：构造期已保证声明的段号都在清单里（工单115），
    // 这里查的是「在清单但本轮没跑到」——合并门按「范围段被打断」裁决（须重跑），只告警不阻断。
    const registered = new Set(this.segments.map((s) => s.seg));
    const scopeUnknown = this.declaredScope.filter((s) => !registered.has(s));
    if (this.declaredScope.length) {
      if (!this.segments.length) {
        this.log(`WARN  本轮未实跑任何段（面板早亡等）：声明范围段 ${this.declaredScope.join(', ')} 未能核对——合并门按「范围段被打断」裁决`);
      } else if (scopeUnknown.length) {
        this.log(`WARN  声明范围段未在本轮实跑：${scopeUnknown.join(', ')}（清单在位但段未注册——合并门按「范围段被打断」裁决，须重跑）`);
      }
    }
    // 排除窗未闭合即判终局：重启从未验证健康，其后的失败已全数环境降责——账目里必须可读
    if (this.envWindow) {
      this.log(`WARN  轮末排除窗仍开启（${this.envWindow.reason}）：面板重启未验证健康，期间失败已全数环境降责`);
    }

    // 账目段仅落证据文件（控制台保持判决一行 + WARN）。副电池旧用法不产生三态账目，跳过。
    if (!explicit && (this.exclusions.length || this.segments.length || this.declaredScope.length || this.envWindow)) {
      this._writeLedger_(scopeUnknown);
    }

    return {
      verdict: label,
      exitCode,
      passes: this.passes,
      fails: this.fails,
      excluded: this.excluded,
      exclusions: this.exclusions.slice(),
      envWindowOpen: Boolean(this.envWindow),
      scope: this.declaredScope.slice(),
      scopeUnknown,
      file: this.file,
    };
  }

  /** 账目段（工单110）：三路计数、排除条目、段账目、scope 核对结论，供合并门取证据 */
  _writeLedger_(scopeUnknown) {
    const tri = this.triVerdict();
    this._fileOnly('===== 账目（三态记账，工单110） =====');
    this._fileOnly(`三路计数：pass=${this.passes} fail=${this.fails} excluded=${this.excluded} ｜ ${tri.verdict} → 退出码 ${tri.exitCode}`);
    this._fileOnly(`排除窗：轮末${this.envWindow ? '仍开启（重启未验证健康）' : '已全部闭合'}`);
    if (this.exclusions.length) {
      this._fileOnly('排除条目（环境降责）：');
      this.exclusions.forEach((e, i) => {
        this._fileOnly(`  #${i + 1}${e.inWindow ? '[窗内]' : ''} ${e.msg} ｜原因=${e.reason}｜归因=${e.attribution}`);
      });
    }
    if (this.declaredScope.length) {
      this._fileOnly(`声明 spec 范围段：${this.declaredScope.join(', ')}${scopeUnknown.length ? `（未在本轮注册：${scopeUnknown.join(', ')}）` : '（均已注册）'}`);
    }
    if (this.segments.length) {
      this._fileOnly('段账目（took=段实测墙钟；工单/失效面标注自清单，工单114）：');
      for (const s of this.segments) {
        const took = s.durationMs != null ? `${(s.durationMs / 1000).toFixed(1)}s` : '?';
        const ann = s.ticket != null ? `｜工单${s.ticket}｜失效面=${surfaceLabels(this.manifest, s.surfaces)}` : '';
        this._fileOnly(`  ${s.seg}${s.title ? ` ${s.title}` : ''} pass=${s.passes} fail=${s.fails} excl=${s.excluded} took=${took}${ann}`);
      }
    } else if (this.declaredScope.length) {
      this._fileOnly('段账目：（空——本轮未实跑任何段）');
    }
  }
}

module.exports = { Report, EVIDENCE_DIR, EXIT_CODES, parseAcceptScope, normalizeScope, loadManifest, MANIFEST_FILE };
