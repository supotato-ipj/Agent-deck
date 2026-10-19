param(
  [int]$MainPid = 0,
  [int]$Seconds = 150,
  [string]$OutCsv = "$PSScriptRoot\cpu-samples.csv"
)
# CPU sampler: records panel process tree CPU usage every 500ms.
# ASCII-only on purpose: PS 5.1 misparses BOM-less UTF-8 scripts with CJK comments.
if ($MainPid -eq 0) {
  $m = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like '*--inspect=9229*' } | Select-Object -First 1
  if (-not $m) { throw 'panel main process not found' }
  $MainPid = $m.ProcessId
}

function Get-Descendants([int]$ParentId) {
  $kids = Get-CimInstance Win32_Process -Filter "ParentProcessId=$ParentId" -ErrorAction SilentlyContinue
  foreach ($k in $kids) { $k; Get-Descendants $k.ProcessId }
}

$procs = @(Get-CimInstance Win32_Process -Filter "ProcessId=$MainPid")
$procs += Get-Descendants $MainPid
$ids = @{}
foreach ($p in $procs) {
  $type = 'main'
  if ($p.CommandLine -match '--type=renderer') { $type = 'renderer' }
  elseif ($p.CommandLine -match '--type=gpu-process') { $type = 'gpu' }
  elseif ($p.CommandLine -match '--type=utility') { $type = 'utility' }
  $ids[[int]$p.ProcessId] = $type
}
"ts,pid,type,cpuPctCore,cpuPctTotal" | Out-File -FilePath $OutCsv -Encoding utf8
$cores = [Environment]::ProcessorCount

$prev = @{}
foreach ($id in $ids.Keys) {
  try { $prev[$id] = (Get-Process -Id $id -ErrorAction Stop).CPU } catch { $prev[$id] = $null }
}
$sw = [Diagnostics.Stopwatch]::StartNew()
while ($sw.Elapsed.TotalSeconds -lt $Seconds) {
  Start-Sleep -Milliseconds 500
  $now = Get-Date -Format 'HH:mm:ss.fff'
  foreach ($id in $ids.Keys) {
    try {
      $c = (Get-Process -Id $id -ErrorAction Stop).CPU
      if ($null -ne $c -and $null -ne $prev[$id]) {
        $core = [math]::Round((($c - $prev[$id]) / 0.5) * 100, 1)
        $total = [math]::Round($core / $cores, 2)
        "$now,$id,$($ids[$id]),$core,$total" | Out-File -FilePath $OutCsv -Append -Encoding utf8
      }
      if ($null -ne $c) { $prev[$id] = $c }
    } catch {}
  }
}
