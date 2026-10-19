param([string]$Needle, [int]$MaxSteps = 12, [int]$DumpCap = 150, [string]$DumpHwnds = '')
# Tray keyboard navigation after Win+B: read UIA focused element, LEFT if not
# matching, return MATCH when found. Contract lines consumed by battery.js P10
# are frozen: "STEP <i>: <name>", "MATCH", "NOT-FOUND", exit codes 0/1. All
# diagnostics ride on "DETAIL <json>" prefixed lines (ticket 143, fields lifted
# from the 90-round-verified uia-probe2.ps1): per-step focus element fields,
# owning process, and foreground top-level window; -DumpHwnds additionally
# dumps each requested tray host subtree pre/post walk (decimal hwnds, comma
# separated, harness-supplied because PS FindWindowExW enumeration misses the
# hidden competing window; empty = own Shell_TrayWnd enumeration fallback).
# ASCII-only on purpose: PS 5.1 misparses BOM-less UTF-8 Chinese comments as
# ANSI and breaks Add-Type (03 iteration 7). ConvertTo-Json escapes non-ASCII
# names to \uXXXX so DETAIL lines stay ASCII-safe.
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName System.Windows.Forms
Add-Type -Namespace P2 -Name Native -MemberDefinition @'
[DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="FindWindowExW")]
public static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string cls, string title);
[DllImport("user32.dll")]
public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="GetClassNameW")]
public static extern int GetClassNameW(IntPtr h, System.Text.StringBuilder sb, int max);
[DllImport("user32.dll")]
public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
'@

$script:procCache = @{}
function Get-ProcNameById([int]$procId) {
  if ($procId -le 0) { return '' }
  if ($script:procCache.ContainsKey($procId)) { return $script:procCache[$procId] }
  $n = 'gone'
  try { $n = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}
  $script:procCache[$procId] = $n
  return $n
}

function Describe-Hwnd([IntPtr]$h) {
  if ($h -eq [IntPtr]::Zero) { return @{ hwnd = 0; class = ''; pid = 0; exe = '' } }
  $sb = New-Object System.Text.StringBuilder 256
  [void][P2.Native]::GetClassNameW($h, $sb, 256)
  $procId = [uint32]0
  [void][P2.Native]::GetWindowThreadProcessId($h, [ref]$procId)
  return @{ hwnd = [int64]$h; class = $sb.ToString(); pid = $procId; exe = (Get-ProcNameById $procId) }
}

function Describe-Element($e) {
  try {
    $c = $e.Current
    $ct = ''
    try { $ct = [string]$c.ControlType.ProgrammaticName } catch {}
    return @{
      name  = [string]$c.Name
      aid   = [string]$c.AutomationId
      class = [string]$c.ClassName
      type  = $ct
      hwnd  = $c.NativeWindowHandle
      pid   = $c.ProcessId
      exe   = (Get-ProcNameById $c.ProcessId)
    }
  } catch {
    return @{ name = '<unavailable>'; error = ($_.Exception.Message -replace '\s+', ' ') }
  }
}

function Write-Detail($obj) {
  Write-Output ("DETAIL {0}" -f (ConvertTo-Json -Compress -Depth 6 $obj))
}

function Dump-HostTree([IntPtr]$h, [string]$when) {
  $items = New-Object System.Collections.ArrayList
  $truncated = $false
  $err = $null
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    for ($i = 0; $i -lt $all.Count; $i++) {
      if ($items.Count -ge $DumpCap) { $truncated = $true; break }
      [void]$items.Add((Describe-Element $all.Item($i)))
    }
  } catch { $err = ($_.Exception.Message -replace '\s+', ' ') }
  Write-Detail @{
    kind = 'dump'; when = $when; host = (Describe-Hwnd $h)
    itemCount = $items.Count; truncated = $truncated; error = $err; items = $items
  }
}

try {
  # Optional host dumps (-DumpHwnds explicit list, else own Shell_TrayWnd
  # enumeration). P10 never passes -DumpHwnds; reserved for forensics reuse.
  if ($DumpHwnds -ne '' -or $PSBoundParameters.ContainsKey('DumpHwnds')) {
    $targets = New-Object System.Collections.ArrayList
    if ($DumpHwnds -ne '') {
      foreach ($part in $DumpHwnds.Split(',')) {
        $n = 0
        if ([int64]::TryParse($part.Trim(), [ref]$n) -and $n -gt 0) { [void]$targets.Add([IntPtr]$n) }
      }
    }
    if ($targets.Count -eq 0) {
      $after = [IntPtr]::Zero
      while ($true) {
        $h = [P2.Native]::FindWindowExW([IntPtr]::Zero, $after, 'Shell_TrayWnd', $null)
        if ($h -eq [IntPtr]::Zero) { break }
        [void]$targets.Add($h)
        $after = $h
      }
    }
    foreach ($h in $targets) { Write-Detail @{ kind = 'host'; host = (Describe-Hwnd $h) } }
    foreach ($h in $targets) { Dump-HostTree $h 'pre' }
  }

  for ($i = 0; $i -lt $MaxSteps; $i++) {
    $fe = [System.Windows.Automation.AutomationElement]::FocusedElement
    $name = if ($fe) { $fe.Current.Name } else { '' }
    Write-Output ("STEP {0}: {1}" -f $i, $name)
    Write-Detail @{
      kind = 'step'; i = $i
      focus = if ($fe) { Describe-Element $fe } else { @{ name = ''; note = 'no-focused-element' } }
      fg = (Describe-Hwnd ([P2.Native]::GetForegroundWindow()))
    }
    if ($name -like "*$Needle*") { Write-Output 'MATCH'; exit 0 }
    [System.Windows.Forms.SendKeys]::SendWait('{LEFT}')
    Start-Sleep -Milliseconds 500
  }

  if ($DumpHwnds -ne '') {
    foreach ($h in $targets) { Dump-HostTree $h 'post' }
  }
  Write-Output 'NOT-FOUND'
  exit 1
} catch {
  Write-Detail @{ kind = 'fatal'; message = ($_.Exception.Message -replace '\s+', ' ') }
  Write-Output 'NOT-FOUND'
  exit 1
}
