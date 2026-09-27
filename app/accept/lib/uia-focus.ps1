param([string]$Needle, [int]$MaxSteps = 12)
# Tray keyboard navigation after Win+B: read UIA focused element, LEFT if not
# matching, return MATCH when found. ASCII-only on purpose: PS 5.1 misparses
# BOM-less UTF-8 Chinese comments as ANSI and breaks Add-Type (03 iteration 7).
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName System.Windows.Forms
for ($i = 0; $i -lt $MaxSteps; $i++) {
  $fe = [System.Windows.Automation.AutomationElement]::FocusedElement
  $name = if ($fe) { $fe.Current.Name } else { '' }
  Write-Output ("STEP {0}: {1}" -f $i, $name)
  if ($name -like "*$Needle*") { Write-Output 'MATCH'; exit 0 }
  [System.Windows.Forms.SendKeys]::SendWait('{LEFT}')
  Start-Sleep -Milliseconds 500
}
Write-Output 'NOT-FOUND'
exit 1
