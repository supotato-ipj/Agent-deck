param([string]$Needle = '', [int]$MaxSteps = 20, [int]$DumpCap = 150, [string]$DumpHwnds = '')
# Issue 119 forensics probe (uia-focus.ps1 sibling, battery untouched).
# Full-walk tray keyboard navigation: per-step focused-element UIA fields plus
# foreground window, and a subtree dump for EVERY requested tray window before
# and after the walk. Dump targets come from the harness (-DumpHwnds, decimal
# comma-separated: explorer tray + TrayHost competing window + overflow flyout)
# because PS-side FindWindowExW enumeration misses the hidden competing window
# while the harness-side koffi enumeration sees it (A/B verified 2026-10-11);
# with no -DumpHwnds the probe falls back to its own enumeration.
# Never early-exits; first MATCH step is recorded instead (superset of the
# production probe behavior). Output = one JSON object per line on stdout;
# ConvertTo-Json escapes non-ASCII names to \uXXXX so the stream stays ASCII.
# ASCII-only comments on purpose: PS 5.1 misparses BOM-less UTF-8 Chinese
# comments as ANSI and breaks Add-Type (uia-focus.ps1, 03 iteration 7).
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
  Write-Output (ConvertTo-Json -Compress -Depth 6 @{
    kind = 'dump'; when = $when; host = (Describe-Hwnd $h)
    itemCount = $items.Count; truncated = $truncated; error = $err; items = $items
  })
}

try {
  # Dump targets: explicit hwnd list from the harness, else own enumeration.
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
  foreach ($h in $targets) {
    Write-Output (ConvertTo-Json -Compress -Depth 6 @{ kind = 'host'; host = (Describe-Hwnd $h) })
  }
  foreach ($h in $targets) { Dump-HostTree $h 'pre' }

  $firstMatch = -1
  $emptySteps = 0
  $names = New-Object System.Collections.ArrayList
  for ($i = 0; $i -lt $MaxSteps; $i++) {
    $fe = [System.Windows.Automation.AutomationElement]::FocusedElement
    $focus = if ($fe) { Describe-Element $fe } else { @{ name = ''; note = 'no-focused-element' } }
    if ($focus.name -eq '') { $emptySteps++ }
    [void]$names.Add($focus.name)
    if ($firstMatch -lt 0 -and $Needle -ne '' -and $focus.name -like "*$Needle*") { $firstMatch = $i }
    Write-Output (ConvertTo-Json -Compress -Depth 6 @{
      kind = 'step'; i = $i; focus = $focus; fg = (Describe-Hwnd ([P2.Native]::GetForegroundWindow()))
    })
    [System.Windows.Forms.SendKeys]::SendWait('{LEFT}')
    Start-Sleep -Milliseconds 500
  }

  foreach ($h in $targets) { Dump-HostTree $h 'post' }

  $distinct = @($names | Sort-Object -Unique)
  Write-Output (ConvertTo-Json -Compress -Depth 6 @{
    kind = 'summary'; steps = $MaxSteps; firstMatch = $firstMatch; emptySteps = $emptySteps
    distinctNames = $distinct.Count; allEmpty = ($emptySteps -eq $MaxSteps)
    frozenName = $(if ($distinct.Count -eq 1) { $distinct[0] } else { $null })
  })
  exit 0
} catch {
  Write-Output (ConvertTo-Json -Compress -Depth 4 @{ kind = 'fatal'; message = ($_.Exception.Message -replace '\s+', ' ') })
  exit 2
}
