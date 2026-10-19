# Ticket 02 evidence: real engine results, click-activated (OS-level focus), clipboard paste.
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -MemberDefinition '
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
' -Name U32 -Namespace W

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
$offline = $args[1] -eq "offline"
Set-Clipboard -Value $word
$shell = New-Object -ComObject Shell.Application
$shell.MinimizeAll()
Start-Sleep -Milliseconds 1500
[W.U32]::SetCursorPos(2250, 183) | Out-Null
Start-Sleep -Milliseconds 250
[W.U32]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
[W.U32]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 450
[System.Windows.Forms.SendKeys]::SendWait('^v')
if ($offline) { Start-Sleep -Seconds 7 } else { Start-Sleep -Seconds 2 }
Shot "11-results-$word.png"
[System.Windows.Forms.SendKeys]::SendWait('{ESC}')
Start-Sleep -Milliseconds 500
Shot "12-collapsed-$word.png"
$shell.UndoMinimizeALL()
Write-Output "windows restored"
