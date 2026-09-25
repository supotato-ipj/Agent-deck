# Ticket 02 evidence: real engine results via auto-activate + clipboard paste.
# ASCII-only inline comments (PS5.1 GBK hazard).
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$ev = "D:\test-folder\wallpaperengine-research--listary-search\.scratch\listary-search\evidence"

function Shot([string]$name) {
  $r = New-Object System.Drawing.Rectangle(1930, 100, 630, 520)
  $bmp = New-Object System.Drawing.Bitmap($r.Width, $r.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.Location, [System.Drawing.Point]::Empty, $r.Size)
  $bmp.Save("$ev\$name", [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Output "shot: $name"
}

$word = $args[0]
Set-Clipboard -Value $word
$shell = New-Object -ComObject Shell.Application
$shell.MinimizeAll()
Start-Sleep -Milliseconds 1500
Start-Sleep -Seconds 4      # cross QD_PANEL_AUTOACTIVATE=6 point (panel focused)
[System.Windows.Forms.SendKeys]::SendWait('^v')   # paste bypasses IME composition
Start-Sleep -Seconds 2      # debounce + http + render
Shot "11-results-$word.png"
[System.Windows.Forms.SendKeys]::SendWait('{ESC}')
Start-Sleep -Milliseconds 500
Shot "12-collapsed-$word.png"
$shell.UndoMinimizeALL()
Set-Clipboard -Value $word  # Set-Clipboard rejects empty string
Write-Output "windows restored"
