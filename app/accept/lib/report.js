'use strict';
const fs = require('fs');
const path = require('path');

const EVIDENCE_DIR = path.join(__dirname, '..', 'evidence');
if (!fs.existsSync(EVIDENCE_DIR)) fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

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
 * 段注册：beginSegment（段起笔报段号）——断言按当前段入账；--accept-scope 声明的
 * spec 范围段在 verdict 时与轮内注册段核对，未知段号告警不阻断（清单落地后由
 * #115 升级为硬校验；存量埋点归 #114）。
 * verdict 判定：存在未定责失败 → FAIL-CODE；全部失败已定责环境 → FAIL-ENV；无失败 → PASS。
 * 显式传入 verdict 字符串的旧调用（五块副电池）保持原行文与原返回形状，零迁移成本。
 */
class Report {
  /**
   * @param {string} name 报告名（即证据日志文件名主体）
   * @param {{file?: string|null, scope?: string[]}} [opts]
   *   file：string=显式路径，null=纯内存运行（单测夹具），缺省=证据目录；
   *   scope：--accept-scope 声明的 spec 范围段
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
    /** 段注册账：beginSegment 依序登记的 { seg, title, passes, fails, excluded } */
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

  /**
   * 段注册（段起笔报段号）：断言自此按段入账，直至下一笔起笔。同段重复起笔幂等。
   * 工单110 只落 API；存量段的起笔埋点由归账票 #114 补齐。
   * @param {string|number} seg 段号（清单票落地后与段级清单交叉校验）
   * @param {string} [title] 段标题（可选，仅入账展示）
   */
  beginSegment(seg, title) {
    const id = String(seg);
    if (this.currentSegment && this.currentSegment.seg === id) return this.currentSegment;
    this.currentSegment = { seg: id, title: title || '', passes: 0, fails: 0, excluded: 0 };
    this.segments.push(this.currentSegment);
    this.log(`SEG   ▶ ${id}${title ? ` ${title}` : ''}`);
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
    const tri = this.triVerdict();
    const label = explicit || tri.verdict;
    const exitCode = explicit ? (EXIT_CODES[explicit] ?? 1) : tri.exitCode;
    const scopePart = this.declaredScope.length ? ` scope=${this.declaredScope.join(',')}` : '';
    if (explicit) {
      this.log(`===== ${this.name} VERDICT: ${label} (pass=${this.passes} fail=${this.fails}) =====`);
    } else {
      this.log(`===== ${this.name} VERDICT: ${label} (pass=${this.passes} fail=${this.fails} excluded=${this.excluded}${scopePart}) =====`);
    }

    // --accept-scope 核对：与轮内注册段（beginSegment 账）比对。未知段号告警不阻断；
    // 注册表（段级清单）缺位时同样只告警——硬交叉校验归清单校验器票 #115。
    const registered = new Set(this.segments.map((s) => s.seg));
    const scopeUnknown = this.declaredScope.filter((s) => !registered.has(s));
    if (this.declaredScope.length) {
      if (!this.segments.length) {
        this.log(`WARN  段注册表未填充（存量段起笔埋点归 #114）：声明范围段 ${this.declaredScope.join(', ')} 未能与本轮实跑段核对，告警不阻断`);
      } else if (scopeUnknown.length) {
        this.log(`WARN  声明范围段未在本轮注册：${scopeUnknown.join(', ')}（告警不阻断；对段级清单的硬交叉校验归 #115）`);
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
      this._fileOnly('段账目：');
      for (const s of this.segments) {
        this._fileOnly(`  ${s.seg}${s.title ? ` ${s.title}` : ''} pass=${s.passes} fail=${s.fails} excl=${s.excluded}`);
      }
    } else if (this.declaredScope.length) {
      this._fileOnly('段账目：（空——段注册表未填充，存量段起笔埋点归 #114）');
    }
  }
}

module.exports = { Report, EVIDENCE_DIR, EXIT_CODES, parseAcceptScope, normalizeScope };
