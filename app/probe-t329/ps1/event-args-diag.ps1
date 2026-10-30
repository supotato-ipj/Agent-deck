$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
$t = [Windows.Media.Control.GlobalSystemMediaTransportControlsSession]
Write-Host "=== session events ==="
foreach ($e in $t.GetEvents()) { Write-Host $e.Name '->' $e.EventHandlerType.ToString() }
$m = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
Write-Host "=== manager events ==="
foreach ($e in $m.GetEvents()) { Write-Host $e.Name '->' $e.EventHandlerType.ToString() }
Write-Host "=== methods on session (async) ==="
foreach ($mm in $t.GetMethods() | Where-Object { $_.Name -like '*Try*' -or $_.Name -like '*Get*' }) { Write-Host $mm.Name }
