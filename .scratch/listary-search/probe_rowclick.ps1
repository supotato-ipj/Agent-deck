# Ticket 03 evidence: mouse click on result row == Enter (opens item).
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -MemberDefinition '
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
public delegate bool EnumProc(IntPtr h, IntPtr l);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
' -Name U32 -Namespace W

$ev = "D:\test-folder\wallpaperengine-research--listary-search\.scratch\listary-search\evidence"
function ExplorerWins() {
  $out = New-Object System.Collections.ArrayList
  $cb = {
    param($h, $l)
    $cn = New-Object System.Text.StringBuilder 256
    [W.U32]::GetClassName($h, $cn, 256) | Out-Null
    if ($cn.ToString() -eq 'CabinetWClass' -and [W.U32]::IsWindowVisible($h)) {
      $t = New-Object System.Text.StringBuilder 256
      [W.U32]::GetWindowText($h, $t, 256) | Out-Null
      $null = $out.Add(@{h = $h; t = $t.ToString()})
    }
    return $true
  }
  [W.U32]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
  return $out
}

$dir = Join-Path $env:TEMP 'zzdeck03dir'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Set-Content -Path (Join-Path $dir 'zzdeck03alpha.txt') -Value 'probe a'

$shell = New-Object -ComObject Shell.Application
$shell.MinimizeAll()
Start-Sleep -Milliseconds 1500
Set-Clipboard -Value 'zzdeck03dir'

# activate panel and paste
[W.U32]::SetCursorPos(2250, 183) | Out-Null
Start-Sleep -Milliseconds 200
[W.U32]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
[W.U32]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 400
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Seconds 2

# real mouse click on result row 0 (screen y ~219)
[W.U32]::SetCursorPos(2250, 219) | Out-Null
Start-Sleep -Milliseconds 200
[W.U32]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
[W.U32]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Seconds 2

$wins = ExplorerWins
Write-Output ("explorer windows: " + (($wins | ForEach-Object { $_.t }) -join ' | '))
$r = New-Object System.Drawing.Rectangle(1930, 100, 630, 520)
$bmp = New-Object System.Drawing.Bitmap($r.Width, $r.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Location, [System.Drawing.Point]::Empty, $r.Size)
$bmp.Save("$ev\19-rowclick-open.png", [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "shot: 19-rowclick-open.png"

foreach ($w in $wins) { if ($w.t -like '*zzdeck03*') { [W.U32]::PostMessage($w.h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null } }
$shell.UndoMinimizeALL()
Remove-Item -Recurse -Force $dir
Write-Output "cleaned"
