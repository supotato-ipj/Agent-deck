// 面板进程组 CPU 采样（工单475 入仓，spec #472 SLO 口径的采样工具）：
// 任务管理器进程页同口径（GetProcessTimes 族=TotalProcessorTime 差分）× 整机百分比
// （除以逻辑核数）。供性能族工单（#475/#476/#478/#484）优化前后对照采样与终验长测。
//
// 口径（ADR-0032 / 母票 #472 Implementation Decisions）：面板**进程组**（electron 主进程
// 全树含 GPU/renderer/utility 子进程）CPU 时间差分 ÷（墙钟 × 逻辑核数）×100 = 整机%。
// 静置 30 秒后采样（#484 终验口径）；采样期进程树按父子归并，起止两拍按集合交集记账，
// 途中生灭的短命子进程不进账（空闲稳态下树应稳定——churn 报进 JSON 供异常判读）。
//
// 用法（面板生命周期由调用方编排——本工具只采样，不拉起不回收）：
//   node scripts/panel-cpu-sample.mjs --pid <面板主进程 pid> [--duration-ms 90000]
//        [--settle-ms 0] [--label <标签>] [--out <json 路径>]
// 配套编排（拉起→settle→采样→--panel-quit 优雅退）见工单475 验收记录
// docs/audit/2026-11-14-t475-window-enum-family.md 的对照采样小节。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

function argOf(name, dflt) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : dflt
}
function num(name, dflt) {
  return Number(argOf(name, dflt))
}

const rootPid = num('pid', 0)
if (!rootPid) {
  console.error('用法：node scripts/panel-cpu-sample.mjs --pid <面板主进程 pid> [--duration-ms 90000] [--settle-ms 0] [--label <标签>] [--out <json>]')
  process.exit(2)
}
const durationMs = num('duration-ms', 90_000)
const settleMs = num('settle-ms', 0)
const label = argOf('label', '')
const outArg = argOf('out', '')
const cores = Number(process.env.NUMBER_OF_PROCESSORS || 0)
if (!cores) {
  console.error('NUMBER_OF_PROCESSORS 不可读（非 Windows 环境？）——整机口径无从计算')
  process.exit(2)
}

/** 进程树采集 + TotalProcessorTime 快照（PowerShell 单次调用，JSON 回读） */
function snapshot(rootPid) {
  const ps = `
$ErrorActionPreference='Stop'
$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId
$byParent = @{}
foreach ($p in $all) { if (-not $byParent.ContainsKey([int]$p.ParentProcessId)) { $byParent[[int]$p.ParentProcessId]=@() }; $byParent[[int]$p.ParentProcessId]+=[int]$p.ProcessId }
$out=@(); $stack=@(${rootPid})
while ($stack.Count -gt 0) { $id=$stack.Pop(); if ($out -contains $id) { continue }; $out+=$id; if ($byParent.ContainsKey($id)) { foreach($c in $byParent[$id]){ $stack+=$c } } }
$procs = Get-Process -Id $out -ErrorAction SilentlyContinue | Select-Object Id,@{n='cpuMs';e={$_.TotalProcessorTime.TotalMilliseconds}}
[pscustomobject]@{ pids=@($procs | ForEach-Object { [pscustomobject]@{ id=[int]$_.Id; cpuMs=[double]$_.cpuMs } }) } | ConvertTo-Json -Depth 4 -Compress
`
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8',
    timeout: 60_000,
  })
  if (r.status !== 0) throw new Error(`PowerShell 采样失败（status=${r.status}）：${r.stderr}`)
  const parsed = JSON.parse(r.stdout.trim())
  return new Map(parsed.pids.map((p) => [p.id, p.cpuMs]))
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

if (settleMs > 0) {
  console.log(`[sample] settle ${settleMs}ms（静置口径——不采启动期）`)
  await sleep(settleMs)
}

console.log(`[sample] t0 snapshot（root=${rootPid}）`)
const s0 = snapshot(rootPid)
const t0 = Date.now()
if (s0.size === 0) throw new Error(`根进程 ${rootPid} 不可见——pid 已退出？`)

console.log(`[sample] 采样 ${durationMs}ms（树规模 ${s0.size}）`)
await sleep(durationMs)

const s1raw = snapshot(rootPid)
const t1 = Date.now()
if (s1raw.size === 0) throw new Error(`采样终点根进程 ${rootPid} 不可见——采样期面板退出？`)

// 起止交集记账：途中生灭的短命子进程不进账（其累计时间无法差分）
const common = [...s0.keys()].filter((id) => s1raw.has(id))
let cpuMsDelta = 0
for (const id of common) cpuMsDelta += s1raw.get(id) - s0.get(id)
const wallMs = t1 - t0
const percentOfMachine = (cpuMsDelta / (wallMs * cores)) * 100
const churned = [...s0.keys()].filter((id) => !s1raw.has(id)).concat([...s1raw.keys()].filter((id) => !s0.has(id)))

const result = {
  label,
  rootPid,
  coreCount: cores,
  settleMs,
  durationMs,
  wallMs,
  cpuMsDelta: Number(cpuMsDelta.toFixed(1)),
  percentOfMachine: Number(percentOfMachine.toFixed(3)),
  treeAtStart: [...s0.keys()].sort((a, b) => a - b),
  treeAtEnd: [...s1raw.keys()].sort((a, b) => a - b),
  churnedPids: churned.sort((a, b) => a - b),
  measuredAt: new Date().toISOString(),
}
const report = `label=${result.label} tree=${common.length} pids 整机CPU=${result.percentOfMachine}% （Δcpu=${result.cpuMsDelta}ms / ${wallMs}ms × ${cores} 核）churn=${churned.length}`
console.log(`[sample] ${report}`)
if (outArg) {
  fs.mkdirSync(path.dirname(path.resolve(outArg)), { recursive: true })
  fs.writeFileSync(outArg, JSON.stringify(result, null, 2) + '\n')
  console.log(`[sample] 已写 ${outArg}`)
}
