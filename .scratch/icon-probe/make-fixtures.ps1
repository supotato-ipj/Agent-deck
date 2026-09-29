$ErrorActionPreference = 'Stop'
$tmp = Join-Path $env:TEMP 'iconprobe2'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
Copy-Item "$env:USERPROFILE\Desktop\Kimi.lnk" (Join-Path $tmp 'Kimi-copy.lnk') -Force
Copy-Item "$env:PUBLIC\Desktop\WeChat.lnk" (Join-Path $tmp 'WeChat-copy.lnk') -Force
$s = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $tmp 'fresh-notepad.lnk'))
$s.TargetPath = "$env:SystemRoot\notepad.exe"
$s.Save()
Get-ChildItem $tmp | Select-Object Name, Length | Format-Table -AutoSize
