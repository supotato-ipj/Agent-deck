# Ticket 476 real-machine audit round (ASCII only for PS5.1 no-BOM safety).
# Launches the panel from the given worktree app dir with the ACTIVE dist,
# samples for a fixed window:
#   (1) nvidia-smi process sightings (high-freq poll; gap > 1.5s counts as a new spawn)
#   (2) panel process-group CPU seconds (matched by exe path; machine-percent over
#       window delta, logical-core denominator = 16)
# Kills the panel tree it launched at the end, writes JSON, exits.
# Run under accept-guard hold.
param(
  [int]$WindowSec = 300,
  [int]$SettleSec = 30,
  [string]$OutFile = "D:\test-folder\.476-audit\round.json",
  [string]$Label = "round"
)
$ErrorActionPreference = 'Continue'
$appDir = 'D:\test-folder\wallpaperengine-research--feat476-gpu-sample-30s\app'
$electronExe = Join-Path $appDir 'node_modules\electron\dist\electron.exe'
$cores = [Environment]::ProcessorCount

$panel = Start-Process -FilePath $electronExe -ArgumentList '.', '--panel' -WorkingDirectory $appDir -PassThru
Start-Sleep -Seconds $SettleSec

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$sightings = New-Object System.Collections.Generic.List[object]
$lastSighting = [datetime]::MinValue
$cpuSamples = New-Object System.Collections.Generic.List[object]
$pollMs = 120
while ($sw.Elapsed.TotalSeconds -lt $WindowSec) {
  $now = Get-Date
  $smit = Get-Process -Name 'nvidia-smi' -ErrorAction SilentlyContinue
  if ($smit) {
    if (($now - $lastSighting).TotalMilliseconds -gt 1500) {
      $sightings.Add([pscustomobject]@{ t = [math]::Round($sw.Elapsed.TotalSeconds, 1); wall = $now.ToString('HH:mm:ss.fff') })
    }
    $lastSighting = $now
  }
  if (($sw.Elapsed.TotalMilliseconds % 5000) -lt $pollMs) {
    $procs = Get-Process -Name 'electron' -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*feat476-gpu-sample-30s*' }
    $sum = 0.0
    foreach ($p in $procs) { try { $sum += $p.TotalProcessorTime.TotalSeconds } catch {} }
    $cpuSamples.Add([pscustomobject]@{ t = [math]::Round($sw.Elapsed.TotalSeconds, 1); procs = @($procs).Count; cpuSec = [math]::Round($sum, 3) })
  }
  Start-Sleep -Milliseconds $pollMs
}

Get-Process -Name 'electron' -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*feat476-gpu-sample-30s*' } | Stop-Process -Force -ErrorAction SilentlyContinue

$first = $cpuSamples[0]; $last = $cpuSamples[$cpuSamples.Count - 1]
$deltaSec = $last.t - $first.t
$cpuDelta = $last.cpuSec - $first.cpuSec
$pctMachine = if ($deltaSec -gt 0) { [math]::Round($cpuDelta / ($deltaSec * $cores) * 100, 3) } else { $null }
$s = @($cpuSamples | Where-Object { $_.t -ge 10 -and $_.t -le ($WindowSec - 10) })
$firstS = $s[0]; $lastS = $s[$s.Count - 1]
$deltaS = $lastS.t - $firstS.t
$cpuDeltaS = $lastS.cpuSec - $firstS.cpuSec
$pctS = if ($deltaS -gt 0) { [math]::Round($cpuDeltaS / ($deltaS * $cores) * 100, 3) } else { $null }
$gaps = @()
for ($i = 1; $i -lt $sightings.Count; $i++) { $gaps += [math]::Round($sightings[$i].t - $sightings[$i-1].t, 1) }
$result = [pscustomobject]@{
  label = $Label; windowSec = $WindowSec; settleSec = $SettleSec; cores = $cores
  spawnCount = $sightings.Count
  spawnTimes = $sightings
  spawnGapsSec = $gaps
  cpuGroupPercentMachineWhole = $pctMachine
  cpuGroupPercentMachineSettled = $pctS
  cpuSettledDeltaSec = $deltaS
  cpuSettledCpuSec = [math]::Round($cpuDeltaS, 3)
  cpuSettledProcs = "$($firstS.procs)->$($lastS.procs)"
  cpuSamples = $cpuSamples
  panelPid = $panel.Id
}
$result | ConvertTo-Json -Depth 4 | Set-Content -Path $OutFile -Encoding UTF8
Write-Output ("DONE label={0} spawns={1} cpuPctSettled={2} cpuPctWhole={3}" -f $Label, $sightings.Count, $pctS, $pctMachine)
