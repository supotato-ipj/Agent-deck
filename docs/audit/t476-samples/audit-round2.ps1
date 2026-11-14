# Ticket 476 real-machine audit round v2 (ASCII only).
# Same as v1 plus SPAWN ATTRIBUTION: for each nvidia-smi sighting, resolve its
# parent process exe path (immediate CIM lookup) and bucket it by worktree, so
# concurrent foreign panels (sibling tickets) can be told apart from ours.
# CPU samples record both our-path electron CPU and foreign electron CPU.
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
$mine = '*feat476-gpu-sample-30s*'

$panel = Start-Process -FilePath $electronExe -ArgumentList '.', '--panel' -WorkingDirectory $appDir -PassThru
Start-Sleep -Seconds $SettleSec

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$sightings = New-Object System.Collections.Generic.List[object]
$lastSighting = [datetime]::MinValue
$cpuSamples = New-Object System.Collections.Generic.List[object]
$pollMs = 110
while ($sw.Elapsed.TotalSeconds -lt $WindowSec) {
  $now = Get-Date
  $smit = Get-Process -Name 'nvidia-smi' -ErrorAction SilentlyContinue
  if ($smit) {
    if (($now - $lastSighting).TotalMilliseconds -gt 1500) {
      $t = [math]::Round($sw.Elapsed.TotalSeconds, 1)
      $parentPath = 'lookup-failed'
      $smiPids = (@($smit) | ForEach-Object { $_.Id }) -join ','
      try {
        $cim = Get-CimInstance Win32_Process -Filter "Name='nvidia-smi.exe'" -ErrorAction Stop | Select-Object -First 1
        if ($cim) {
          $ppid = $cim.ParentProcessId
          $par = Get-Process -Id $ppid -ErrorAction SilentlyContinue
          if ($par -and $par.Path) { $parentPath = $par.Path }
          else { $parentPath = 'parent-exited(ppid=' + $ppid + ')' }
        }
      } catch { $parentPath = 'cim-error' }
      $bucket = 'other'
      if ($parentPath -like $mine) { $bucket = 'ours' }
      elseif ($parentPath -like '*wallpaperengine-research*') { $bucket = 'sibling-checkout' }
      elseif ($parentPath -like '*parent-exited*' -or $parentPath -like '*lookup-failed*' -or $parentPath -like '*cim-error*') { $bucket = 'unattributed' }
      $sightings.Add([pscustomobject]@{ t = $t; wall = $now.ToString('HH:mm:ss.fff'); pids = $smiPids; bucket = $bucket; parent = $parentPath })
    }
    $lastSighting = $now
  }
  if (($sw.Elapsed.TotalMilliseconds % 5000) -lt $pollMs) {
    $allE = Get-Process -Name 'electron' -ErrorAction SilentlyContinue
    $mineE = @($allE | Where-Object { $_.Path -like $mine })
    $foreignE = @($allE | Where-Object { $_.Path -and $_.Path -notlike $mine })
    $sumMine = 0.0; foreach ($p in $mineE) { try { $sumMine += $p.TotalProcessorTime.TotalSeconds } catch {} }
    $sumForeign = 0.0; foreach ($p in $foreignE) { try { $sumForeign += $p.TotalProcessorTime.TotalSeconds } catch {} }
    $cpuSamples.Add([pscustomobject]@{ t = [math]::Round($sw.Elapsed.TotalSeconds, 1); mineProcs = $mineE.Count; mineCpuSec = [math]::Round($sumMine, 3); foreignProcs = $foreignE.Count; foreignCpuSec = [math]::Round($sumForeign, 3) })
  }
  Start-Sleep -Milliseconds $pollMs
}

Get-Process -Name 'electron' -ErrorAction SilentlyContinue | Where-Object { $_.Path -like $mine } | Stop-Process -Force -ErrorAction SilentlyContinue

$first = $cpuSamples[0]; $last = $cpuSamples[$cpuSamples.Count - 1]
$deltaSec = $last.t - $first.t
$cpuDelta = $last.mineCpuSec - $first.mineCpuSec
$pctMachine = if ($deltaSec -gt 0) { [math]::Round($cpuDelta / ($deltaSec * $cores) * 100, 3) } else { $null }
$s = @($cpuSamples | Where-Object { $_.t -ge 10 -and $_.t -le ($WindowSec - 10) })
$firstS = $s[0]; $lastS = $s[$s.Count - 1]
$deltaS = $lastS.t - $firstS.t
$cpuDeltaS = $lastS.mineCpuSec - $firstS.mineCpuSec
$pctS = if ($deltaS -gt 0) { [math]::Round($cpuDeltaS / ($deltaS * $cores) * 100, 3) } else { $null }
$fDeltaS = $lastS.foreignCpuSec - $firstS.foreignCpuSec
$pctForeignS = if ($deltaS -gt 0) { [math]::Round($fDeltaS / ($deltaS * $cores) * 100, 3) } else { $null }
$ours = @($sightings | Where-Object { $_.bucket -eq 'ours' })
$gaps = @()
for ($i = 1; $i -lt $ours.Count; $i++) { $gaps += [math]::Round($ours[$i].t - $ours[$i-1].t, 1) }
$bucketCounts = @{}
foreach ($x in $sightings) { $bucketCounts[$x.bucket] = 1 + ($(if ($bucketCounts.ContainsKey($x.bucket)) { $bucketCounts[$x.bucket] } else { 0 })) }
$result = [pscustomobject]@{
  label = $Label; windowSec = $WindowSec; settleSec = $SettleSec; cores = $cores
  spawnTotal = $sightings.Count
  spawnBuckets = $bucketCounts
  oursSpawnCount = $ours.Count
  oursSpawnTimes = @($ours | ForEach-Object { $_.t })
  oursSpawnGapsSec = $gaps
  sightings = $sightings
  cpuGroupPercentMachineSettled = $pctS
  cpuGroupPercentMachineWhole = $pctMachine
  cpuSettledDeltaSec = $deltaS
  cpuSettledMineCpuSec = [math]::Round($cpuDeltaS, 3)
  cpuSettledMineProcs = "$($firstS.mineProcs)->$($lastS.mineProcs)"
  foreignCpuPercentMachineSettled = $pctForeignS
  foreignProcsRange = "$($firstS.foreignProcs)->$($lastS.foreignProcs)"
  cpuSamples = $cpuSamples
  panelPid = $panel.Id
}
$result | ConvertTo-Json -Depth 4 | Set-Content -Path $OutFile -Encoding UTF8
Write-Output ("DONE label={0} total={1} ours={2} oursGaps={3} minePctSettled={4} foreignPctSettled={5}" -f $Label, $sightings.Count, $ours.Count, ($gaps -join '/'), $pctS, $pctForeignS)
