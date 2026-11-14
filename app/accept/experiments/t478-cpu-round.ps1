# 工单478 guard 大轮脚本（accept-sprint 槽内执行）：
#   A. 集成形态（worktree dist，含 #473-#477 优化）面板 CPU 对照采样（「优化中」口径）
#   B. 案3 工具图标慢启动双形计量探针（MiniMax Code / Qoder CN Launcher 真拉起）
#   C. 生产形态（主检出 master dist，无优化基线代码）面板 CPU 对照采样
#   D. 恢复：生产面板常驻拉回（与 13:10 形态一致：electron.exe <app> --panel）
# 纪律：DECK_RESIDENT_EVENT_LOG 隔离取证落点；CPU 采样标注负载状态；轮末恢复核对留证。
# CPU 采样脚本复用既有 C:\Users\An W\AppData\Local\Temp\deck-cpu-sample.ps1（20s 窗）。
$ErrorActionPreference = 'Continue'
$worktreeApp = 'D:\test-folder\wallpaperengine-research--feat478-forensics\app'
$prodApp     = 'D:\test-folder\wallpaperengine-research\app'
$electron    = Join-Path $worktreeApp 'node_modules\electron\dist\electron.exe'
$prodElectron= Join-Path $prodApp 'node_modules\electron\dist\electron.exe'
$evidenceDir = Join-Path $worktreeApp 'accept\evidence'
$cpuScript   = 'C:\Users\An W\AppData\Local\Temp\deck-cpu-sample.ps1'
New-Item -ItemType Directory -Force -Path $evidenceDir | Out-Null
$summary = [ordered]@{}

function Wait-ElectronGone {
  param([int]$Seconds = 30)
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    $p = Get-Process -Name 'electron' -ErrorAction SilentlyContinue
    if (-not $p) { return $true }
    Start-Sleep -Seconds 2
  }
  return $false
}

function Stop-Panel {
  # 优雅径优先（信使），30s 不退再 taskkill（验收槽内临时面板，无用户态）
  param([string]$AppDir)
  Start-Process -FilePath $electron -ArgumentList ('"{0}" --panel-quit' -f $AppDir) -WindowStyle Hidden
  Start-Sleep -Seconds 6
  if (-not (Wait-ElectronGone -Seconds 24)) {
    Get-Process -Name 'electron' -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 3
  }
}

function Sample-PanelCpu {
  param([string]$Label)
  $rows = @()
  for ($i = 1; $i -le 3; $i++) {
    $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $cpuScript 2>&1 | Out-String
    $rows += ("round{0}: {1}" -f $i, ($out -replace '\r?\n', ' | '))
    Start-Sleep -Seconds 5
  }
  return $rows
}

# ==== 开场：确认清场（guard 应已清；双保险再走一次优雅径）====
'== T478 round start ==' | Out-File (Join-Path $evidenceDir 't478-round.log.txt') -Encoding utf8
Stop-Panel -AppDir $worktreeApp
$summary.preCleaned = Wait-ElectronGone -Seconds 10

# ==== A. 集成形态 CPU 对照 ====
$env:DECK_RESIDENT_EVENT_LOG = Join-Path $evidenceDir 't478-int-events.jsonl'
Start-Process -FilePath $electron -ArgumentList ('"{0}" --panel' -f $worktreeApp) -WorkingDirectory $worktreeApp -WindowStyle Hidden
Start-Sleep -Seconds 60   # 预热：数据面首拍/扫描器降频窗稳定
$summary.integratedCpu = Sample-PanelCpu -Label 'integrated(optimized)'
Copy-Item (Join-Path $evidenceDir 't478-int-events.jsonl') (Join-Path $evidenceDir 't478-int-events.copy.jsonl') -ErrorAction SilentlyContinue
Stop-Panel -AppDir $worktreeApp
$summary.integratedShutdown = Wait-ElectronGone -Seconds 20

# ==== B. 案3 工具双形计量 ====
$env:T478_KOFFI_PATH = Join-Path $worktreeApp 'node_modules\koffi'
$env:T478_LAYOUT_PATH = Join-Path $env:APPDATA 'agent-deck-panel\taskbar-layout.json'
$env:T478_EVIDENCE_PATH = Join-Path $evidenceDir 't478-tool-launch-evidence.json'
Remove-Item Env:DECK_RESIDENT_EVENT_LOG -ErrorAction SilentlyContinue
$toolOut = & $electron (Join-Path $worktreeApp 'accept\experiments\t478-tool-launch-probe.js') 2>&1 | Out-String
$summary.toolProbeTail = $toolOut.Substring([math]::Max(0, $toolOut.Length - 1500))

# ==== C. 生产形态 CPU 对照 ====
$env:DECK_RESIDENT_EVENT_LOG = Join-Path $evidenceDir 't478-prod-events.jsonl'
Start-Process -FilePath $prodElectron -ArgumentList ('"{0}" --panel' -f $prodApp) -WorkingDirectory $prodApp -WindowStyle Hidden
Start-Sleep -Seconds 60
$summary.productionCpu = Sample-PanelCpu -Label 'production(baseline)'
Stop-Panel -AppDir $prodApp
$summary.productionShutdown = Wait-ElectronGone -Seconds 20
Remove-Item Env:DECK_RESIDENT_EVENT_LOG -ErrorAction SilentlyContinue

# ==== D. 恢复生产面板常驻（与 13:10 形态一致）====
Start-Process -FilePath $prodElectron -ArgumentList ('"{0}" --panel' -f $prodApp) -WorkingDirectory $prodApp -WindowStyle Hidden
Start-Sleep -Seconds 20
$restored = Get-Process -Name 'electron' -ErrorAction SilentlyContinue
$summary.restoreProcessCount = ($restored | Measure-Object).Count
$summary.restorePids = ($restored | Select-Object -ExpandProperty Id) -join ','
# 恢复核对：生产面板主窗（Chrome_WidgetWin_1，electron 进程）可见性
$summary.restoreWindowSeen = ($restored | Where-Object { $_.MainWindowTitle -ne '' } | Measure-Object).Count -gt 0

$summary.finishedAt = (Get-Date).ToString('s')
$summary | ConvertTo-Json -Depth 4 | Out-File (Join-Path $evidenceDir 't478-round-summary.json') -Encoding utf8
$summary | ConvertTo-Json -Depth 4
'== T478 round end =='
