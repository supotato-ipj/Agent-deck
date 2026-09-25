# UI helper for the search-panel acceptance battery (accept_search.py).
# One action per invocation so Python keeps all sequencing and assertions.
# NOTE: keep inline comments ASCII-only - PowerShell 5.1 reads BOM-less files as
# GBK and mojibake in CJK inline comments can swallow following lines.
param(
  [Parameter(Mandatory = $true)][string]$Action,
  [string]$Text = '',
  [string]$Path = '',
  [int]$X = 1930, [int]$Y = 100, [int]$W = 630, [int]$H = 560
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
# Physical-pixel screen coords under DPI scaling (e.g. 200%): without this,
# CopyFromScreen captures the virtualized (logical) desktop instead.
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();' -Name U32 -Namespace W
[W.U32]::SetProcessDPIAware() | Out-Null

switch ($Action) {
  'sendkeys' {
    [System.Windows.Forms.SendKeys]::SendWait($Text)
  }
  'clip-set' {
    Set-Clipboard -Value $Text
  }
  'clip-get' {
    # non-text clipboard content yields empty output; caller treats that as ''
    $v = Get-Clipboard -ErrorAction SilentlyContinue
    if ($null -ne $v) { Write-Output $v }
  }
  'shot' {
    $r = New-Object System.Drawing.Rectangle($X, $Y, $W, $H)
    $bmp = New-Object System.Drawing.Bitmap($r.Width, $r.Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($r.Location, [System.Drawing.Point]::Empty, $r.Size)
    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Write-Output "shot: $Path"
  }
  default { Write-Error "unknown action: $Action"; exit 2 }
}
