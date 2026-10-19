'use strict';
const fs = require('fs');
const path = require('path');

const EVIDENCE_DIR = path.join(__dirname, '..', 'evidence');
if (!fs.existsSync(EVIDENCE_DIR)) fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

class Report {
  constructor(name) {
    this.name = name;
    this.file = path.join(EVIDENCE_DIR, `${name}.log.txt`);
    fs.writeFileSync(this.file, `# probe01 ${name} — ${new Date().toISOString()}\n`);
    this.passes = 0;
    this.fails = 0;
  }

  log(msg) {
    const line = `[${new Date().toISOString().slice(11, 23)}] ${msg}`;
    console.log(line);
    fs.appendFileSync(this.file, line + '\n');
  }

  pass(msg) { this.passes++; this.log(`PASS  ${msg}`); }
  fail(msg) { this.fails++; this.log(`FAIL  ${msg}`); }
  note(msg) { this.log(`NOTE  ${msg}`); }

  verdict(v) {
    this.log(`===== ${this.name} VERDICT: ${v} (pass=${this.passes} fail=${this.fails}) =====`);
    return { verdict: v, passes: this.passes, fails: this.fails, file: this.file };
  }
}

module.exports = { Report, EVIDENCE_DIR };
