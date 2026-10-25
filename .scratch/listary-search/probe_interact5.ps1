# Ticket 01 evidence v6: placeholder via QD_PANEL_AUTOACTIVATE (no mouse needed).
# NOTE: keep inline comments ASCII-only - PowerShell 5.1 reads BOM-less files as
# GBK and mojibake in CJK inline comments can swallow following lines.
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$ev = "D:\test-folder\wallpaperengine-research--listary-search\.scratch\listary-search\evidence"
function Shot([string]$name) {
  $r = New-Object System.Drawing.Rectangle(1930, 100, 630, 300)
  $bmp = New-Object System.Drawing.Bitmap($r.Width, $r.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.Location, [System.Drawing.Point]::Empty, $r.Size)
  $bmp.Save("$ev\$name", [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Output "shot: $name"
}

$shell = New-Object -ComObject Shell.Application
$shell.MinimizeAll()
Start-Sleep -Milliseconds 1500
Shot '07-idle-fresh.png'
Start-Sleep -Seconds 4  # cross the QD_PANEL_AUTOACTIVATE=6 point
Shot '08-active-placeholder.png'
$shell.UndoMinimizeALL()
Write-Output "windows restored"
