# Ticket 01 取证 v4：剪贴板粘贴绕开 IME 合成（SendKeys 裸键会被中文输入法
# 的合成框吞掉 KeyPress；Ctrl+V 不经过合成）。
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -MemberDefinition '
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
' -Name U32 -Namespace W

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

Set-Clipboard -Value 'ok'
$shell = New-Object -ComObject Shell.Application
$shell.MinimizeAll()
Start-Sleep -Milliseconds 1500
Shot '07-idle-fresh.png'

[W.U32]::SetCursorPos(2250, 183) | Out-Null
Start-Sleep -Milliseconds 250
[W.U32]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
[W.U32]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 500
Shot '08-active-placeholder.png'

[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 400
Shot '09-active-pasted-ok.png'

[System.Windows.Forms.SendKeys]::SendWait('{ESC}')
Start-Sleep -Milliseconds 400
Shot '10-idle-after-esc.png'

$shell.UndoMinimizeALL()
Set-Clipboard -Value ''
Write-Output "windows restored"
