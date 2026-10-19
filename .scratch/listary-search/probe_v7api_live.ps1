# Spike: verify the Listary 7 local HTTP API is live and capture real response shape.
# Port 38431 from the in-app API dialog (2026-09-25). Benign queries only.

$ErrorActionPreference = 'Continue'

function Probe([string]$q, [int]$limit) {
  "--- query='$q' limit=$limit ---"
  $body = @{ query = $q; limit = $limit } | ConvertTo-Json
  try {
    $r = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:38431/api/v1/search' `
         -ContentType 'application/json' -Body $body -TimeoutSec 10
    "ok=$($r.ok) total=$($r.data.total) count=$($r.data.count)"
    $i = 0
    foreach ($it in $r.data.results) {
      "  [$i] $($it.type) $($it.name)  score=$($it.score)  $($it.path)"
      $i++
    }
  } catch {
    "FAILED: " + $_.Exception.Message
  }
}

Probe 'zzz_probe' 5
Probe 'invoice' 3
