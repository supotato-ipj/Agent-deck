$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
$t = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
foreach ($mm in $t.GetMethods()) { Write-Host $mm.Name '->' $mm.ReturnType.ToString() }
