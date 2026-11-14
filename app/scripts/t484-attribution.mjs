#!/usr/bin/env node
/**
 * 工单484 余量归因探针（SLO 线1 可接受余量的结构性归因材料）：
 *   perpid  ：面板进程组逐 pid CPU 时间差分（60s）——main/GPU/renderer/utility 分账，
 *             撑「合成 vs 引擎 vs 业务逻辑」的归因面。
 *   control ：对照组 A/B——A=Electron 引擎空闲基线（零窗常驻），B=A+全屏透明置顶窗合成
 *             （面板同款结构）。各 30s 静置 + 120s 组采样（panel-cpu-sample.mjs 同口径）。
 * 用法：node t484-attribution.mjs --app <worktree>/app --out <证据目录> [--mode all]
 *   mode = perpid | bare | transp | all（all = perpid 需要 --pid；bare/transp 自带拉起）
 */
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const require = createRequire(import.meta.url)

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : def
}
const appDir = path.resolve(arg('app', ''))
const outDir = path.resolve(arg('out', ''))
const mode = arg('mode', 'all')
const pid = Number(arg('pid', '0'))
const electronExe = path.join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe')
const sampleScript = path.join(appDir, 'scripts', 'panel-cpu-sample.mjs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (m) => console.log(`[t484-attr] ${new Date().toISOString().slice(11, 23)} ${m}`)
fs.mkdirSync(outDir, { recursive: true })

const panelAlive = async (p) => { try { process.kill(p, 0); return true } catch { return false } }

async function sampleGroup(rootPid, label, settleMs, durationMs) {
  const out = path.join(outDir, `${label}.json`)
  const r = spawnSync(process.execPath, [
    sampleScript, '--pid', String(rootPid), '--duration-ms', String(durationMs),
    '--settle-ms', String(settleMs), '--label', label, '--out', out,
  ], { encoding: 'utf8', timeout: settleMs + durationMs + 180000 })
  console.log((r.stdout || '').trim())
  if (r.status !== 0) console.error((r.stderr || '').trim())
  try { return JSON.parse(fs.readFileSync(out, 'utf8')) } catch { return null }
}

/** 逐 pid 差分（组内 breakdown；PowerShell 单拍两次快照） */
async function perPid(rootPid, durationMs) {
  const snapshot = () => {
    const ps = `
$ErrorActionPreference='Stop'
$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId
$byParent = @{}
foreach ($p in $all) { if (-not $byParent.ContainsKey([int]$p.ParentProcessId)) { $byParent[[int]$p.ParentProcessId]=@() }; $byParent[[int]$p.ParentProcessId]+=[int]$p.ProcessId }
$out=@(); $queue=@(${rootPid}); $i=0
while ($i -lt $queue.Count) { $id=$queue[$i]; $i++; if ($out -contains $id) { continue }; $out+=$id; if ($byParent.ContainsKey($id)) { $queue+=$byParent[$id] } }
$procs = Get-Process -Id $out -ErrorAction SilentlyContinue | Select-Object Id,@{n='cpuMs';e={$_.TotalProcessorTime.TotalMilliseconds}}
[pscustomobject]@{ pids=@($procs | ForEach-Object { [pscustomobject]@{ id=[int]$_.Id; cpuMs=[double]$_.cpuMs } }) } | ConvertTo-Json -Depth 4 -Compress
`
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 60000 })
    if (r.status !== 0) throw new Error(`snapshot 失败: ${r.stderr}`)
    return { map: new Map(JSON.parse(r.stdout.trim()).pids.map((p) => [p.id, p.cpuMs])), at: Date.now() }
  }
  log(`per-pid 快照 t0（root=${rootPid}）`)
  const s0 = snapshot()
  await sleep(durationMs)
  const s1 = snapshot()
  const wall = s1.at - s0.at
  const cores = Number(process.env.NUMBER_OF_PROCESSORS)
  const rows = []
  for (const [id, cpu0] of s0.map) {
    const cpu1 = s1.map.get(id)
    if (cpu1 === undefined) continue
    rows.push({ pid: id, cpuMs: Number((cpu1 - cpu0).toFixed(1)), pctOfMachine: Number((((cpu1 - cpu0) / (wall * cores)) * 100).toFixed(3)) })
  }
  rows.sort((a, b) => b.cpuMs - a.cpuMs)
  // 每个进程的形态标签（主进程=root；GPU/renderer/utility 由命令行判别）
  const kinds = {}
  for (const row of rows) {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${row.pid}").CommandLine`], { encoding: 'utf8', timeout: 20000 })
    const cl = (r.stdout || '').trim()
    let kind = 'unknown'
    if (row.pid === rootPid) kind = 'main'
    else if (/--type=gpu-process/.test(cl)) kind = 'gpu'
    else if (/--type=utility/.test(cl)) kind = /SqlitePool|dataplane|data-plane/i.test(cl) ? 'utility-dataplane' : 'utility'
    else if (/--type=renderer/.test(cl)) kind = /taskbar\.html/i.test(cl) ? 'renderer-taskbar' : 'renderer'
    else if (/--type=/ .test(cl)) kind = cl.match(/--type=([\w-]+)/)?.[1] || 'child'
    kinds[row.pid] = { kind, cmdline: cl.slice(0, 240) }
  }
  const result = { rootPid, wallMs: wall, cores, durationMs, rows, kinds, measuredAt: new Date().toISOString() }
  const total = rows.reduce((a, b) => a + b.pctOfMachine, 0)
  log(`per-pid 完成：组合计=${total.toFixed(3)}%  top3=${rows.slice(0, 3).map((r) => `${kinds[r.pid].kind}(${r.pid})=${r.pctOfMachine}%`).join(' ')}`)
  fs.writeFileSync(path.join(outDir, 'perpid.json'), JSON.stringify(result, null, 2) + '\n')
  return result
}

async function control(which) {
  const ctlDir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), `control-${which}`)
  const child = spawn(electronExe, [ctlDir], { cwd: ctlDir, stdio: 'ignore', detached: true })
  child.unref()
  log(`对照 ${which} 拉起 pid=${child.pid}`)
  const sample = await sampleGroup(child.pid, `control-${which}`, 30000, 120000)
  // 优雅收场：无窗 electron 不认 --panel-quit（那是面板信使）——直接 taskkill（对照进程无状态）
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  await sleep(1500)
  const gone = !(await panelAlive(child.pid))
  log(`对照 ${which} 完成：${sample ? sample.percentOfMachine + '%' : '失败'} 收场 gone=${gone}`)
  return { which, pid: child.pid, gone, sample }
}

async function main() {
  const out = {}
  const mainCheckoutApp = 'D:\\test-folder\\wallpaperengine-research\\app'
  let panelChild = null
  if ((mode === 'perpid' || mode === 'all') && pid) {
    out.perpid = await perPid(pid, 60000)
  } else if (mode === 'panel' || mode === 'all') {
    // 自带拉起：--panel + 隔离事件落点 → 静置 30s → perpid 60s → 优雅退
    const evFile = path.join(outDir, 'panel-events.jsonl')
    fs.rmSync(evFile, { force: true })
    const env = { ...process.env, DECK_RESIDENT_EVENT_LOG: evFile }
    panelChild = spawn(electronExe, [appDir, '--panel'], { cwd: appDir, env, stdio: 'ignore', detached: true })
    panelChild.unref()
    log(`面板拉起 pid=${panelChild.pid}，静置 30s 后 perpid 60s`)
    await sleep(30000)
    out.perpid = await perPid(panelChild.pid, 60000)
    const quitter = spawn(electronExe, [appDir, '--panel-quit'], { cwd: appDir, stdio: 'ignore', detached: true })
    quitter.unref()
    const qDeadline = Date.now() + 20000
    while (Date.now() < qDeadline && (await panelAlive(panelChild.pid))) await sleep(400)
    const gone = !(await panelAlive(panelChild.pid))
    if (!gone) { spawnSync('taskkill', ['/PID', String(panelChild.pid), '/T', '/F'], { stdio: 'ignore' }); }
    log(`面板退场 gone=${gone}（兜底=${!gone}）`)
    await sleep(5000)
  }
  if (mode === 'bare' || mode === 'all' || mode === 'controls' || mode === 'panel') out.controlBare = await control('bare')
  if (mode === 'transp' || mode === 'all' || mode === 'controls' || mode === 'panel') out.controlTransp = await control('transp')
  // 生产面板恢复（主检出 --panel 链）——归因轮同样以恢复在场收尾（窗口级判据）
  log('恢复生产面板（主检出 electron --panel）')
  const win32 = require(path.join(appDir, 'accept', 'lib', 'win32.js'))
  const user32 = win32.koffi.load('user32.dll')
  const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(uintptr_t hWnd, uint16 *buf, int nMax)')
  const titleOf = (h) => { const buf = Buffer.alloc(1024); const n = GetWindowTextW(h, buf, 512); let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(buf.readUInt16LE(i * 2)); return s }
  const prod = spawn(path.join(mainCheckoutApp, 'node_modules', 'electron', 'dist', 'electron.exe'),
    [mainCheckoutApp, '--panel'], { cwd: mainCheckoutApp, stdio: 'ignore', detached: true })
  prod.unref()
  const rDeadline = Date.now() + 40000
  let restored = null
  while (Date.now() < rDeadline && !restored) {
    await sleep(800)
    restored = win32.topLevelWindows().find((h) => titleOf(h) === 'AGENT DECK') || null
  }
  out.productionRestored = !!restored
  out.productionPanelPid = restored ? win32.threadIdOf(restored).pid : prod.pid
  log(`生产面板恢复=${out.productionRestored} pid=${out.productionPanelPid}`)
  fs.writeFileSync(path.join(outDir, `attribution-${mode}.json`), JSON.stringify(out, null, 2) + '\n')
  log(`归因探针完成（mode=${mode}）`)
}

main().catch((e) => { console.error(e); process.exit(1) })
