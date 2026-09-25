$startup = [Environment]::GetFolderPath('Startup')
$repo = Split-Path -Parent $PSScriptRoot
$pythonw = Join-Path $repo '.venv\Scripts\pythonw.exe'
if (-not (Test-Path $pythonw)) { throw "pythonw not found: $pythonw (create .venv first)" }
$watchdog = Join-Path $repo 'scripts\server_watchdog.pyw'
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut((Join-Path $startup 'qoder-deck-server-watchdog.lnk'))
$lnk.TargetPath = $pythonw
$lnk.Arguments = '"' + $watchdog + '"'
$lnk.WorkingDirectory = $PSScriptRoot
$lnk.Save()
Write-Output ('created: ' + $lnk.FullName)
