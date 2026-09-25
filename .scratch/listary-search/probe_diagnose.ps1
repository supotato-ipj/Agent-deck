# Ticket 01 排障：面板窗口是否可见、真实落位、以及截图里面板区域是否有内容。
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Drawing
Add-Type -MemberDefinition '
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
public delegate bool EnumProc(IntPtr h, IntPtr l);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
public struct RECT { public int L; public int T; public int R; public int B; }
' -Name U32 -Namespace W

"=== visible windows of python processes ==="
$targets = @(Get-Process python -ErrorAction SilentlyContinue).Id
"python pids: $($targets -join ',')"
$found = New-Object System.Collections.ArrayList
$cb = {
  param($h, $l)
  $procId = [uint32]0
  [W.U32]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
  if ($targets -contains [int]$procId -and [W.U32]::IsWindowVisible($h)) {
    $r = New-Object W.U32+RECT
    [W.U32]::GetWindowRect($h, [ref]$r) | Out-Null
    $sb = New-Object System.Text.StringBuilder 256
    [W.U32]::GetWindowText($h, $sb, 256) | Out-Null
    $null = $found.Add("hwnd=$h pid=$procId rect=$($r.L),$($r.T) -> $($r.R),$($r.B) size=$($r.R - $r.L)x$($r.B - $r.T) title='$($sb.ToString())'")
  }
  return $true
}
[W.U32]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
$found | ForEach-Object { Write-Output $_ }

"=== pixel content of panel rect in shot 01 (1982..2518 x 134..201, screen coords) ==="
$bmp = [System.Drawing.Bitmap]::FromFile("D:\test-folder\wallpaperengine-research--listary-search\.scratch\listary-search\evidence\01-idle-before-click.png")
# 截图原点是 (1930,100)，换算到截图内坐标
$minx = 1982 - 1930; $maxx = 2518 - 1930
$miny = 134 - 100;  $maxy = 201 - 100
$lit = 0; $samples = @{}
for ($y = $miny; $y -lt $maxy; $y++) {
  for ($x = $minx; $x -lt $maxx; $x++) {
    $c = $bmp.GetPixel($x, $y)
    if ($c.R -gt 24 -or $c.G -gt 24 -or $c.B -gt 24) { $lit++ }
  }
}
"non-black pixels in panel rect: $lit of $(($maxx-$minx) * ($maxy-$miny))"
$bmp.Dispose()

"=== same check for the whole right-column strip (spacer+sessions area, 1982..2518 x 110..400) ==="
$bmp = [System.Drawing.Bitmap]::FromFile("D:\test-folder\wallpaperengine-research--listary-search\.scratch\listary-search\evidence\01-idle-before-click.png")
$rows = @{}
for ($y = 10; $y -lt 300; $y += 10) {
  $cnt = 0
  for ($x = 52; $x -lt 588; $x++) {
    $c = $bmp.GetPixel($x, $y)
    if ($c.R -gt 24 -or $c.G -gt 24 -or $c.B -gt 24) { $cnt++ }
  }
  $rows["shotY=$($y+100)"] = $cnt
}
$rows.GetEnumerator() | Sort-Object Name | ForEach-Object { "  $($_.Name): $($_.Value) lit px" }
$bmp.Dispose()
