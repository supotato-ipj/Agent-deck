# Spike: discover Listary 7 HTTP search API endpoint on this machine.
# Reads only structural config (port/host/enable flags); truncates any token
# values to length + 4-char prefix; never touches license or history files.

$ErrorActionPreference = 'Continue'

"=== processes ==="
Get-Process -Name Listary* -ErrorAction SilentlyContinue | ForEach-Object {
  $v = $null
  try { $v = $_.Path } catch {}
  $fv = ''
  if ($v) { $fv = (Get-Item $v).VersionInfo.ProductVersion }
  "pid={0} name={1} path={2} ver={3} title='{4}'" -f $_.Id, $_.ProcessName, $v, $fv, $_.MainWindowTitle
}

"=== install dirs ==="
foreach ($p in @("$env:ProgramFiles\Listary", "${env:ProgramFiles(x86)}\Listary", "$env:LOCALAPPDATA\Programs\Listary")) {
  if (Test-Path $p) { "EXISTS: $p"; Get-ChildItem $p -Filter *.exe | ForEach-Object { "  exe: " + $_.Name } }
}

"=== HTTP-ish keys in v7 config ==="
$pref = Join-Path $env:APPDATA 'Listary\UserProfile\Settings\Preferences.json'
if (Test-Path $pref) {
  $json = Get-Content $pref -Raw -Encoding UTF8 | ConvertFrom-Json
  function Walk($node, $path) {
    if ($null -eq $node) { return }
    if ($node -is [System.Management.Automation.PSCustomObject]) {
      foreach ($p in $node.PSObject.Properties) {
        $np = if ($path) { "$path.$($p.Name)" } else { $p.Name }
        if ($p.Name -match 'http|api|port|token|auth|server|listen|url') {
          $val = "$($p.Value)"
          if ($null -ne $p.Value -and $p.Value -isnot [System.Management.Automation.PSCustomObject] -and $p.Value -isnot [System.Array]) {
            $show = if ($val.Length -gt 8) { $val.Substring(0,4) + "...(len=$($val.Length))" } else { $val }
            "  $np = $show"
          } else {
            "  $np = <object/array>"
          }
        }
        Walk $p.Value $np
      }
    } elseif ($node -is [System.Array]) {
      for ($i = 0; $i -lt [Math]::Min($node.Count, 20); $i++) { Walk $node[$i] "$path[$i]" }
    }
  }
  Walk $json ''
  "(config file: $pref)"
} else {
  "no Preferences.json at $pref"
}

"=== other settings files (names only) ==="
Get-ChildItem (Join-Path $env:APPDATA 'Listary\UserProfile\Settings') -ErrorAction SilentlyContinue |
  ForEach-Object { "  " + $_.Name + " (" + $_.Length + "B)" }

"=== listening sockets of Listary processes ==="
$pids = (Get-Process -Name Listary* -ErrorAction SilentlyContinue).Id
if ($pids) {
  Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $pids -contains $_.OwningProcess } |
    ForEach-Object { "  {0}:{1} pid={2}" -f $_.LocalAddress, $_.LocalPort, $_.OwningProcess }
}
