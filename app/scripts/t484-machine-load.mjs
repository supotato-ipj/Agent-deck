#!/usr/bin/env node
// t484 背景负载采样器（工单484 环境标注）：单个 PowerShell 进程内循环采样整机 CPU/内存
// 与 top 进程 CPU%，逐行 JSONL 追加 --out。目的：给空闲 CPU 长测窗提供「当时机器有多吵」
// 的量化标注（#478 教训：环境因子可以大于形态差异，必须同窗标注才可判读）。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : def
}

const out = arg('out', path.join(process.cwd(), 'machine-load.jsonl'))
const forSec = Number(arg('for-sec', '900'))
const intervalSec = Number(arg('interval-sec', '10'))

fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })

const ps = `
$ErrorActionPreference='Continue'
$deadline = (Get-Date).AddSeconds(${forSec})
while ((Get-Date) -lt $deadline) {
  $total = (Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor | Where-Object { $_.Name -eq '_Total' }).PercentProcessorTime
  $os = Get-CimInstance Win32_OperatingSystem
  $freeMB = [math]::Round($os.FreePhysicalMemory / 1024)
  $tops = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process |
    Where-Object { $_.Name -notin @('Idle','_Total') -and $_.PercentProcessorTime -gt 0 } |
    Sort-Object PercentProcessorTime -Descending | Select-Object -First 8 |
    ForEach-Object { @{ n = $_.Name; cpu = $_.PercentProcessorTime; pid = $_.IDProcess } }
  [pscustomobject]@{
    t = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
    cpuTotalPct = [int]$total
    freeMemMB = $freeMB
    top = @($tops)
  } | ConvertTo-Json -Depth 4 -Compress | Add-Content -LiteralPath '${out.replace(/'/g, "''")}'
  Start-Sleep -Seconds ${intervalSec}
}
`

const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
  stdio: 'ignore',
  detached: true,
})
child.unref()
console.log(`[load] 背景采样器已启动 pid=${child.pid} for=${forSec}s interval=${intervalSec}s -> ${out}`)
