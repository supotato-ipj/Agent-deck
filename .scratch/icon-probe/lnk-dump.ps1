$sh = New-Object -ComObject WScript.Shell
$dirs = @("$env:USERPROFILE\Desktop", "$env:PUBLIC\Desktop")
foreach ($d in $dirs) {
  Get-ChildItem -Path (Join-Path $d '*.lnk') | ForEach-Object {
    $lnk = $sh.CreateShortcut($_.FullName)
    "{0}`n  dir={1}`n  attrs={2}`n  target={3}`n  icon={4}" -f $_.Name, $d, $_.Attributes, $lnk.TargetPath, $lnk.IconLocation
  }
}
