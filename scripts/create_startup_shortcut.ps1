$startup = [Environment]::GetFolderPath('Startup')
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut((Join-Path $startup 'qoder-deck-server-watchdog.lnk'))
$lnk.TargetPath = 'C:\Python314\pythonw.exe'
$lnk.Arguments = '"D:\test-folder\wallpaperengine-research\scripts\server_watchdog.pyw"'
$lnk.WorkingDirectory = 'D:\test-folder\wallpaperengine-research\scripts'
$lnk.Save()
Write-Output ('created: ' + $lnk.FullName)
