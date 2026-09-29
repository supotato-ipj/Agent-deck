param(
  [string]$BeforeCsv = "$PSScriptRoot\cpu-samples.csv",
  [string]$AfterCsv = "$PSScriptRoot\cpu-samples-after.csv"
)
function Summarize([string]$csv, [string]$label) {
  if (-not (Test-Path $csv)) { Write-Output "$label : MISSING ($csv)"; return }
  $rows = Import-Csv $csv
  $rows | Group-Object type | ForEach-Object {
    $vals = @($_.Group | ForEach-Object { [double]$_.cpuPctCore })
    $sorted = $vals | Sort-Object
    $avg = [math]::Round(($vals | Measure-Object -Average).Average, 2)
    $max = [math]::Round(($vals | Measure-Object -Maximum).Maximum, 1)
    $p95 = [math]::Round($sorted[[int][math]::Floor($sorted.Count * 0.95)], 1)
    $spikes = @($vals | Where-Object { $_ -ge 10 }).Count
    Write-Output ('{0,-7} {1,-9} avg={2,6}%  p95={3,5}%  max={4,5}%  spikes>=10%core: {5}' -f $label, $_.Name, $avg, $p95, $max, $spikes)
  }
}
Summarize $BeforeCsv 'BEFORE'
Summarize $AfterCsv 'AFTER '
