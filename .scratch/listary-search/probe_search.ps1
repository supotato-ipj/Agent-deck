# Spike: does Listary 6.3.5 (installed at C:\Program Files\Listary) honor an
# undocumented `-search <query>` command line, i.e. can we summon its search
# window with a prefilled query?
# Side effects: pops a Listary window once on the desktop; the benign probe
# query "zzz_probe" may land in Listary's SearchHistory.json.
# Dismiss manually with Esc (the launcher also hides on focus loss).

$ErrorActionPreference = 'Continue'

function Snap([string]$tag) {
  Get-Process -Name Listary -ErrorAction SilentlyContinue | ForEach-Object {
    "{0}: pid={1} hwnd={2} title='{3}'" -f $tag, $_.Id, $_.MainWindowHandle, $_.MainWindowTitle
  }
}

Snap 'BEFORE'
Start-Process 'C:\Program Files\Listary\Listary.exe' -ArgumentList '-search','zzz_probe'
Start-Sleep -Seconds 3
Snap 'AFTER'

# Read what actually opened: enumerate Listary top-level windows and any
# control exposing a value (WPF TextBox supports ValuePattern), so we can
# tell "window appeared" from "window appeared WITH the query prefilled".
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ProcessNameProperty, 'Listary')
$wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
"UIA top-level Listary windows: " + $wins.Count
foreach ($w in $wins) {
  "WINDOW handle={0} class='{1}' name='{2}' offscreen={3}" -f `
    $w.Current.NativeWindowHandle, $w.Current.ClassName, $w.Current.Name, $w.Current.IsOffscreen
  foreach ($e in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants,
                            [System.Windows.Automation.Condition]::TrueCondition)) {
    $v = $null
    try {
      $p = $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      $v = $p.Current.Value
    } catch {}
    if ($v -or $e.Current.Name) {
      "  ctrl type={0} name='{1}' value='{2}'" -f `
        $e.Current.ControlType.ProgrammaticName, $e.Current.Name, $v
    }
  }
}
