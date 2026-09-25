param([string]$Out = (Join-Path $PSScriptRoot "..\.scratch\desktop.png"))
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition @"
using System.Runtime.InteropServices;
public class DpiHelper {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[DpiHelper]::SetProcessDPIAware() | Out-Null
# 必须声明 DPI 感知：否则高缩放屏（如 2880x1800@200%）上 CopyFromScreen
# 只会抓到左上角的 1:1 物理裁切，右/下内容全部缺失。
$shell = New-Object -ComObject Shell.Application
$shell.MinimizeAll()
Start-Sleep -Seconds 6
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
$shell.UndoMinimizeAll()
Write-Output "saved: $Out ($($bounds.Width)x$($bounds.Height))"
