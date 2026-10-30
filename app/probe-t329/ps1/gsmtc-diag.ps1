$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function AwaitOp($o, $t) { $tt = $asTaskGeneric.MakeGenericMethod($t).Invoke($null, @($o)); $tt.Wait(-1) | Out-Null; $tt.Result }
$mgr = AwaitOp ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$ss = $mgr.GetSessions()
Write-Host ("sessions: " + $ss.Count)
if ($ss.Count -gt 0) {
  $s = $ss[0]
  Write-Host ("type: " + $s.GetType().FullName)
  Write-Host "--- methods ---"
  $s | Get-Member -MemberType Method | ForEach-Object { Write-Host $_.Name }
  Write-Host "--- properties ---"
  $s | Get-Member -MemberType Property | ForEach-Object { Write-Host $_.Name }
  Write-Host ("direct call try: " + $s.GetType().GetMethod('GetMediaPropertiesAsync'))
}
