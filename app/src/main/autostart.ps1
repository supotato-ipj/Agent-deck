# Startup-folder shortcut reader / writer (ticket 11 autostart chain).
# Deletion is deliberately NOT here: removeShortcut deletes the file directly via
# fs, and an unused COM delete branch is a shape that rots.
#
# Standalone script rather than an inline -Command: the argument values (the app
# directory routinely contains spaces) would be re-parsed by cmd on the way in, and
# quoting through that path is a well-known source of silent breakage. Same call
# shape as accept/lib/capture.ps1 and uia-focus.ps1 -- arguments go through -File.
#
# KEEP THIS FILE ASCII-ONLY. Windows PowerShell 5.1 reads a BOM-less script using
# the system ANSI code page (GBK on this machine), so UTF-8 comments turn into
# mojibake that breaks parsing outright. The rationale for every decision lives in
# src/main/autostart.ts instead; this file stays boring on purpose.
#
# Output is always a single line of JSON for the Node caller to parse. Failures
# exit non-zero so the caller reports a real failure rather than treating it as
# "shortcut does not exist".
param(
  [ValidateSet('read', 'write')]
  [string]$Mode = 'read',
  [Parameter(Mandatory = $true)]
  [string]$Link,
  [string]$Target = '',
  # Deliberately not $Args: $args is a PowerShell automatic variable and silently
  # swallows the bound value if used as a parameter name.
  [string]$LinkArgs = '',
  [string]$WorkDir = ''
)

$ErrorActionPreference = 'Stop'

if ($Mode -eq 'write') {
  $ws = New-Object -ComObject WScript.Shell
  $lnk = $ws.CreateShortcut($Link)
  $lnk.TargetPath = $Target
  $lnk.Arguments = $LinkArgs
  if ($WorkDir) { $lnk.WorkingDirectory = $WorkDir }
  $lnk.Save()
  Write-Output '{"written":true}'
  exit 0
}

# Only read mode reports absence. Write must be allowed to create a link that
# does not exist yet, so this check lives after the write branch on purpose.
if (-not (Test-Path -LiteralPath $Link)) {
  Write-Output '{"exists":false}'
  exit 0
}

$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($Link)

Write-Output ([pscustomobject]@{
  exists  = $true
  target  = $lnk.TargetPath
  args    = $lnk.Arguments
  workDir = $lnk.WorkingDirectory
} | ConvertTo-Json -Compress)
