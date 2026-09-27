'use strict';
// 工单04 验收第 2 条：真机会话数据与旧数据服务（Python agent_sessions）输出逐字段对照。
// 用法：node scripts/compare-sessions.mjs（需已 npm run build；本机装有 Python 3）
// 同一真实数据根上分别跑两套扫描器，按 tool+id 对齐后逐字段断言：
// project/state/running/tasks_done/tasks_total 全等；age 允许 ±2s 墙钟取整误差。
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const { defaultSessionRoots, collectSessions } = require('../dist/main/scanners/index.js')

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const PY_SCRIPT = [
  'import json, time, agent_sessions',
  'roots = {',
  '    "qoder": __import__("pathlib").Path.home() / ".qoder-cn",',
  '    "hermes": __import__("pathlib").Path.home() / "AppData" / "Local" / "hermes",',
  '    "zcode": __import__("pathlib").Path.home() / ".zcode",',
  '    "kimicode": __import__("pathlib").Path.home() / ".kimi-code",',
  '    "kimiwork": __import__("pathlib").Path.home() / "AppData" / "Roaming" / "kimi-desktop" / "kimi-agent",',
  '}',
  'print(json.dumps(agent_sessions.collect_sessions(roots, time.time()), ensure_ascii=False))',
].join('\n')

const FIELDS = ['project', 'state', 'running', 'tasks_done', 'tasks_total']
const AGE_TOL = 2

function runPython() {
  const out = execFileSync('python', ['-c', PY_SCRIPT], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 30000,
  })
  return JSON.parse(out)
}

function main() {
  const py = runPython()
  const ts = collectSessions(defaultSessionRoots(), Date.now() / 1000)
  const key = (s) => `${s.tool}+${s.id}`
  const pyMap = new Map(py.map((s) => [key(s), s]))
  const tsMap = new Map(ts.map((s) => [key(s), s]))

  const problems = []
  const seen = new Set()
  for (const [k, p] of pyMap) {
    seen.add(k)
    const t = tsMap.get(k)
    if (!t) {
      problems.push(`仅 Python 有: ${k}`)
      continue
    }
    for (const f of FIELDS) {
      if (String(p[f]) !== String(t[f])) problems.push(`${k}.${f}: python=${JSON.stringify(p[f])} ts=${JSON.stringify(t[f])}`)
    }
    if (Math.abs(p.age - t.age) > AGE_TOL) problems.push(`${k}.age: python=${p.age} ts=${t.age}（超 ±${AGE_TOL}s）`)
  }
  for (const k of tsMap.keys()) {
    if (!seen.has(k)) problems.push(`仅 TS 有: ${k}`)
  }

  const orderPy = py.map(key).join('|')
  const orderTs = ts.map(key).join('|')
  if (orderPy !== orderTs) problems.push(`排序不一致:\n  python: ${orderPy}\n  ts:     ${orderTs}`)

  console.log(`python 会话 ${py.length} 条 / ts 会话 ${ts.length} 条`)
  for (const s of ts) console.log(`  [${s.tool}] ${s.id} ${s.state} ${s.project} tasks=${s.tasks_done}/${s.tasks_total} age=${s.age}`)
  if (problems.length) {
    console.error(`\n对照失败 ${problems.length} 处:`)
    for (const p of problems) console.error(`  - ${p}`)
    process.exitCode = 1
  } else {
    console.log('\n逐字段对照一致（project/state/running/tasks/排序 全等，age ±2s 内）')
  }
}

main()
