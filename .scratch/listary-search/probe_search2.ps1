# Spike step 2: read the popped "File Search - Listary" window (hwnd from step 1)
# to see whether the query was PREFILLED, then close the window to clean up.
# Privacy: only looks for the probe string; prints nothing else from user data.

$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$h = 2232056
try {
  $el = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$h)
  "window name='" + $el.Current.Name + "'"
  $desc = $el.FindAll([System.Windows.Automation.TreeScope]::Descendants,
                      [System.Windows.Automation.Condition]::TrueCondition)
  "descendants: " + $desc.Count
  foreach ($e in $desc) {
    $v = $null
    try { $v = $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch {}
    $nm = $e.Current.Name
    $ct = $e.Current.ControlType.ProgrammaticName
    if ($null -ne $v -or $nm) { "ctrl type=$ct name='$nm' value='$v'" }
  }
  # cleanup: close the popped File Search window
  try {
    $el.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close()
    "cleanup: window closed via WindowPattern"
  } catch {
    $sig = '[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);'
    Add-Type -MemberDefinition $sig -Name U32 -Namespace W
    [W.U32]::PostMessage([IntPtr]$h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    "cleanup: window closed via WM_CLOSE"
  }
} catch {
  "window $h no longer accessible: " + $_.Exception.Message
}

# Corroboration without reading user data: does the probe string exist at all in
# Listary's search history? Boolean only.
$hist = Join-Path $env:APPDATA 'Listary\UserProfile\Settings\SearchHistory.json'
if (Test-Path $hist) {
  $hit = Select-String -Path $hist -Pattern 'zzz_probe' -Quiet
  "SearchHistory contains zzz_probe: $hit"
} else {
  "SearchHistory file not found: $hist"
}

Get-Process -Name Listary -ErrorAction SilentlyContinue | ForEach-Object {
  "proc: pid={0} hwnd={1} title='{2}'" -f $_.Id, $_.MainWindowHandle, $_.MainWindowTitle
}
