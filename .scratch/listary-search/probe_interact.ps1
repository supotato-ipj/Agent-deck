# Ticket 01 交互验收驱动：真鼠标点击激活 + SendKeys 打字 + ESC 退待机，截图存证。
# 坐标来自 search_panel.PANEL（1982,134,536,~67），框体中心 ≈ (2250,183)。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -MemberDefinition '
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
' -Name U32 -Namespace W

$ev = "D:\test-folder\wallpaperengine-research--listary-search\.scratch\listary-search\evidence"
New-Item -ItemType Directory -Force -Path $ev | Out-Null

function Shot([string]$name) {
  $r = New-Object System.Drawing.Rectangle(1930, 100, 630, 300)
  $bmp = New-Object System.Drawing.Bitmap($r.Width, $r.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.Location, [System.Drawing.Point]::Empty, $r.Size)
  $bmp.Save("$ev\$name", [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Output "shot: $name"
}

Start-Sleep -Milliseconds 1500
Shot '01-idle-before-click.png'

# 真实点击框体中心 → 应转活动态并获焦
[W.U32]::SetCursorPos(2250, 183) | Out-Null
Start-Sleep -Milliseconds 200
[W.U32]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)   # LEFTDOWN
[W.U32]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)   # LEFTUP
Start-Sleep -Milliseconds 400

# 打字（发送到当前焦点窗口 = 面板输入行）
[System.Windows.Forms.SendKeys]::SendWait('deck01')
Start-Sleep -Milliseconds 500
Shot '02-active-typed.png'

# ESC → 应回待机态并清空
[System.Windows.Forms.SendKeys]::SendWait('{ESC}')
Start-Sleep -Milliseconds 400
Shot '03-idle-after-esc.png'
Write-Output "done -> $ev"
