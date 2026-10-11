# Ticket 156 acceptance probe: three garbage-shaped windows hosted by
# powershell.exe (exe identity != panel's own process, so the self-exe reject
# branch cannot mask the garbage-shape branches under test):
#   W1 visible top-level window with empty title (the common shape of faceless
#      background processes - the blank-icon entries from the defect screenshots)
#   W2 tool window (WS_EX_TOOLWINDOW, with title - floaters/tool palettes)
#   W3 owned popup without WS_EX_APPWINDOW (owner = W1 - dialogs/secondary windows)
# All three are WS_VISIBLE. Keep-alive is a Sleep loop (windows die with the
# host when the battery taskkills it - cleanup path).
# NOTE: comments must stay ASCII/English. This file is UTF-8 without BOM, and
# PowerShell 5.1 reads BOM-less files as ANSI/GBK: multi-byte UTF-8 sequences
# in Chinese comments corrupt the parse (probed calls silently returned $null
# across three red rounds; BOM-prefixed byte-identical copy passed, English-
# comment trace script passed - encoding forensics on file, keep it ASCII).
# Diagnostics: writes creation results to $env:DECK_PROBE_DIAG when set
# (stdio is ignored by the spawner; the diag file is the only red-round
# accountability outlet).
$ErrorActionPreference = 'Stop'
function Write-Diag([string]$text) {
  $p = $env:DECK_PROBE_DIAG
  if ($p) { try { Set-Content -Path $p -Value $text -Encoding UTF8 } catch { } }
}
try {
  $src = @'
using System;
using System.Runtime.InteropServices;
public static class G3 {
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr CreateWindowExW(int exStyle, string cls, string name, int style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
}
'@
  Add-Type -TypeDefinition $src
  $WS_OVERLAPPEDWINDOW = 0x00CF0000
  $WS_VISIBLE = 0x10000000
  $WS_EX_TOOLWINDOW = 0x80
  # Style goes into a variable first (empirically stable form; inline `-bor`
  # expressions at argument position are brittle in PS method-call parsing).
  $style = $WS_OVERLAPPEDWINDOW -bor $WS_VISIBLE
  $exTool = $WS_EX_TOOLWINDOW
  $zero = [IntPtr]::Zero
  # W1: visible, empty title (null window name)
  $h1 = [G3]::CreateWindowExW(0, 'Static', $null, $style, 90, 90, 320, 200, $zero, $zero, $zero, $zero)
  # W2: tool window (WS_EX_TOOLWINDOW, titled)
  $h2 = [G3]::CreateWindowExW($exTool, 'Static', 'Deck156ToolProbe', $style, 130, 130, 320, 200, $zero, $zero, $zero, $zero)
  # W3: owned popup without APPWINDOW (hWndParent = W1 -> GW_OWNER non-null)
  $h3 = [G3]::CreateWindowExW(0, 'Static', 'Deck156OwnedProbe', $style, 170, 170, 320, 200, $h1, $zero, $zero, $zero)
  if ($null -eq $h1 -or $null -eq $h2 -or $null -eq $h3 -or "$h1" -eq '0' -or "$h2" -eq '0' -or "$h3" -eq '0') {
    Write-Diag "create-fail style=[$style] h1=[$h1] h2=[$h2] h3=[$h3] lasterr=$([Runtime.InteropServices.Marshal]::GetLastWin32Error()) psver=$($PSVersionTable.PSVersion)"
    exit 2
  }
  Write-Diag "ok h1=$($h1.ToString()) h2=$($h2.ToString()) h3=$($h3.ToString()) pid=$PID psver=$($PSVersionTable.PSVersion)"
  while ($true) { Start-Sleep -Seconds 5 }
} catch {
  Write-Diag "err: $($_.Exception.Message) at $($_.InvocationInfo.PositionMessage)"
  exit 1
}
