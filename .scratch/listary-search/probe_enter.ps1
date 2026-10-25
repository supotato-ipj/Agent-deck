# Ticket 03 smoke: Enter through the rewired engine.decide_action dispatch.
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

$dir = Join-Path $env:TEMP 'zzdeck03dir'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Set-Content -Path (Join-Path $dir 'zzdeck03alpha.txt') -Value 'probe'

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

$shell = New-Object -ComObject Shell.Application
$shell.MinimizeAll()
Start-Sleep -Milliseconds 1500
Set-Clipboard -Value 'zzdeck03dir'
[W.U32]::SetCursorPos(2250, 183) | Out-Null
Start-Sleep -Milliseconds 200
[W.U32]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
[W.U32]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 400
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Seconds 2
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Start-Sleep -Seconds 2
$wins = ExplorerWins
Write-Output ("explorer: " + (($wins | ForEach-Object { $_.t }) -join ' | '))
foreach ($w in $wins) { if ($w.t -like '*zzdeck03*') { [W.U32]::PostMessage($w.h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null } }
$shell.UndoMinimizeALL()
Remove-Item -Recurse -Force $dir
Write-Output "cleaned"
