Add-Type -AssemblyName System.Windows.Forms
foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
    Write-Output ("{0} {1}x{2} primary={3}" -f $s.DeviceName, $s.Bounds.Width, $s.Bounds.Height, $s.Primary)
}
