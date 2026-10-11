# 工单156 验收探针：三扇垃圾形态窗（powershell.exe 宿主——exe 身份 ≠ 面板自身，
# 自家进程判拒测不出垃圾形态，必须第三方 exe 承载）：
#   窗1 可见空标题顶层窗（后台无窗口面进程的常态形态——缺陷截图里无图标空格的来源）
#   窗2 工具窗（WS_EX_TOOLWINDOW，带标题——特性窗/悬浮工具条形态）
#   窗3 有属主且无 WS_EX_APPWINDOW 的弹窗（owner=窗1——对话框/二级窗形态）
# 三扇均 WS_VISIBLE 在场。造完进消息泵保窗；宿主被 taskkill 即窗亡（电池清场路径）。
$ErrorActionPreference = 'Stop'
$src = @'
using System;
using System.Runtime.InteropServices;
public static class G {
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr CreateWindowExW(int exStyle, string cls, string name, int style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)]
  public static extern IntPtr GetModuleHandleW(string name);
  [StructLayout(LayoutKind.Sequential)]
  public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int ptX; public int ptY; }
  [DllImport("user32.dll")] public static extern int GetMessageW(ref MSG m, IntPtr h, uint a, uint b);
}
'@
Add-Type -TypeDefinition $src
$inst = [G]::GetModuleHandleW($null)
$WS_OVERLAPPEDWINDOW = 0x00CF0000
$WS_VISIBLE = 0x10000000
$WS_EX_TOOLWINDOW = 0x80
# 窗1：可见空标题（标题参数传 null）
$h1 = [G]::CreateWindowExW(0, 'Static', $null, $WS_OVERLAPPEDWINDOW -bor $WS_VISIBLE, 90, 90, 320, 200, [IntPtr]::Zero, [IntPtr]::Zero, $inst, [IntPtr]::Zero)
# 窗2：工具窗（WS_EX_TOOLWINDOW，带标题）
$h2 = [G]::CreateWindowExW($WS_EX_TOOLWINDOW, 'Static', 'Deck156ToolProbe', $WS_OVERLAPPEDWINDOW -bor $WS_VISIBLE, 130, 130, 320, 200, [IntPtr]::Zero, [IntPtr]::Zero, $inst, [IntPtr]::Zero)
# 窗3：有属主无 APPWINDOW 的弹窗（hWndParent=窗1 → GW_OWNER 非空）
$h3 = [G]::CreateWindowExW(0, 'Static', 'Deck156OwnedProbe', $WS_OVERLAPPEDWINDOW -bor $WS_VISIBLE, 170, 170, 320, 200, $h1, [IntPtr]::Zero, $inst, [IntPtr]::Zero)
if ($h1 -eq [IntPtr]::Zero -or $h2 -eq [IntPtr]::Zero -or $h3 -eq [IntPtr]::Zero) { exit 2 }
$m = New-Object G+MSG
while ([G]::GetMessageW([ref]$m, [IntPtr]::Zero, 0, 0) -gt 0) { }
