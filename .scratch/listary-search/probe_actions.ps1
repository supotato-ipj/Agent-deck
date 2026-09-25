# Ticket 03 evidence: arrow selection + Ctrl+Enter reveal + Enter open.
# ASCII-only inline comments (PS5.1 GBK hazard).
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
function Shot([string]$name) {
  $r = New-Object System.Drawing.Rectangle(1930, 100, 630, 520)
  $bmp = New-Object System.Drawing.Bitmap($r.Width, $r.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.Location, [System.Drawing.Point]::Empty, $r.Size)
  $bmp.Save("$ev\$name", [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Output "shot: $name"
}
function ExplorerWindows() {
  $out = New-Object System.Collections.ArrayList
  $cb = {
    param($h, $l)
    $cn = New-Object System.Text.StringBuilder 256
    [W.U32]::GetClassName($h, $cn, 256) | Out-Null
    if ($cn.ToString() -eq 'CabinetWClass' -and [W.U32]::IsWindowVisible($h)) {
      $t = New-Object System.Text.StringBuilder 256
      [W.U32]::GetWindowText($h, $t, 256) | Out-Null
      $null = $out.Add("hwnd=$h title='$($t.ToString())'")
    }
    return $true
  }
  [W.U32]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
  return $out
}
function CloseByTitle([string]$needle) {
  $wins = ExplorerWindows
  $closed = 0
  foreach ($w in $wins) {
    if ($w -like "*$needle*") {
      $h = [IntPtr]($w -replace 'hwnd=(\d+).*', '$1')
      [W.U32]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
      $closed++
    }
  }
  return $closed
}

# --- probe artifacts ---
$dir = Join-Path $env:TEMP 'zzdeck03dir'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Set-Content -Path (Join-Path $dir 'zzdeck03alpha.txt') -Value 'probe a'
Set-Content -Path (Join-Path $dir 'zzdeck03beta.txt') -Value 'probe b'
Write-Output "probes ready: $dir"

$shell = New-Object -ComObject Shell.Application
$shell.MinimizeAll()
Start-Sleep -Milliseconds 1500
Write-Output ("explorer before: " + (ExplorerWindows) + " (count " + @(ExplorerWindows).Count + ")")

function ActivateBox() {
  [W.U32]::SetCursorPos(2250, 183) | Out-Null
  Start-Sleep -Milliseconds 200
  [W.U32]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
  [W.U32]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 350
}

# --- phase 1: selection + reveal (Ctrl+Enter on row 2) ---
Set-Clipboard -Value 'zzdeck03'
ActivateBox
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Seconds 2
Shot '15-sel-row0.png'
[System.Windows.Forms.SendKeys]::SendWait('{DOWN}')
Start-Sleep -Milliseconds 400
Shot '16-sel-row1.png'
[System.Windows.Forms.SendKeys]::SendWait('^{ENTER}')
Start-Sleep -Seconds 2
$after = ExplorerWindows
Write-Output ("explorer after reveal: " + $after)
Shot '17-reveal-explorer.png'
Write-Output ("closed reveal windows: " + (CloseByTitle 'zzdeck03dir'))

# --- phase 2: Enter opens the folder result ---
Start-Sleep -Milliseconds 800
Set-Clipboard -Value 'zzdeck03dir'
ActivateBox
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Seconds 2
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Start-Sleep -Seconds 2
$after2 = ExplorerWindows
Write-Output ("explorer after open: " + $after2)
Shot '18-open-folder.png'
Write-Output ("closed open windows: " + (CloseByTitle 'zzdeck03dir'))

$shell.UndoMinimizeALL()
Remove-Item -Recurse -Force $dir
Write-Output "windows restored, probes cleaned"
