# t329 PowerShell GSMTC read probe (Windows PowerShell 5.1 WinRT projection)
# Dumps all GSMTC sessions as JSON, with timing. Usage: powershell -NoProfile -File gsmtc-read.ps1
param()
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime

# WinRT IAsyncOperation -> Task helper (classic PS 5.1 pattern)
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function AwaitOp($WinRtOp, $ResultType) {
  $t = $asTaskGeneric.MakeGenericMethod($ResultType).Invoke($null, @($WinRtOp))
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $t.Wait(-1) | Out-Null
  $sw.Stop()
  return @{ Value = $t.Result; Ms = $sw.ElapsedMilliseconds }
}
$asTaskActionGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]
function AwaitAction($WinRtAction) {
  $t = $asTaskActionGeneric.Invoke($null, @($WinRtAction))
  $t.Wait(-1) | Out-Null
}

$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
$t0 = [System.Diagnostics.Stopwatch]::StartNew()
$mgr = (AwaitOp ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])).Value
$managerMs = $t0.ElapsedMilliseconds

function Get-Snapshot($mgr) {
  $out = [ordered] @{}
  $out.managerRequestMs = $managerMs
  $out.currentSessionId = if ($mgr.CurrentSession) { [string]$mgr.CurrentSession.SourceAppUserModelId } else { $null }
  $sessions = @()
  foreach ($s in $mgr.GetSessions()) {
    $snap = [ordered] @{}
    $snap.aumid = [string]$s.SourceAppUserModelId
    $snap.id = $s | Out-String
    $pb = $s.GetPlaybackInfo()
    $snap.playbackStatus = [string]$pb.PlaybackStatus
    $cap = $pb.Controls
    $snap.capabilities = [ordered] @{
      play = [bool]$cap.IsPlayEnabled; pause = [bool]$cap.IsPauseEnabled
      stop = [bool]$cap.IsStopEnabled; next = [bool]$cap.IsNextEnabled
      previous = [bool]$cap.IsPreviousEnabled
      channelUp = [bool]$cap.IsChannelUpEnabled; channelDown = [bool]$cap.IsChannelDownEnabled
      repeat = [bool]$cap.IsRepeatEnabled; shuffle = [bool]$cap.IsShuffleEnabled
      rewind = [bool]$cap.IsRewindEnabled; fastForward = [bool]$cap.IsFastForwardEnabled
      record = [bool]$cap.IsRecordEnabled
    }
    $snap.playbackRateSupported = if ($pb.PlaybackRate) { [bool]$pb.PlaybackRate.SupportsPlaybackRate } else { $null }
    try { $snap.repeatMode = [string]$pb.RepeatMode } catch { $snap.repeatMode = $null }
    try { $snap.autoRepeatMode = [string]$pb.AutoRepeatMode } catch { $snap.autoRepeatMode = $null }
    $tl = $s.GetTimelineProperties()
    $snap.timeline = [ordered] @{
      positionMs = $tl.Position.TotalMilliseconds
      endTimeMs = $tl.EndTime.TotalMilliseconds
      minSeekMs = $tl.MinSeekTime.TotalMilliseconds
      maxSeekMs = $tl.MaxSeekTime.TotalMilliseconds
      lastUpdatedTimeUtc = $tl.LastUpdatedTime.ToString('o')
      lastSampledNote = 'LastUpdatedTime + now() - sampledAt gives live position estimate'
      sampledAtUtc = (Get-Date).ToUniversalTime().ToString('o')
    }
    $mp = AwaitOp ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    $m = $mp.Value
    $snap.media = [ordered] @{
      title = [string]$m.Title; artist = [string]$m.Artist; albumTitle = [string]$m.AlbumTitle
      albumArtist = [string]$m.AlbumArtist; genres = @($m.Genres); playType = [string]$m.PlayType
      subtitle = [string]$m.Subtitle; trackCount = $m.AlbumTrackCount; trackNumber = $m.TrackNumber
      id = [string]$m.Id; getMediaPropsMs = $mp.Ms
    }
    # thumbnail: RandomAccessStreamReference -> bytes
    if ($m.Thumbnail) {
      try {
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $stream = AwaitOp ($m.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
        $size = $stream.Value.Size
        $contentType = [string]$stream.Value.ContentType
        $inputStream = $stream.Value -as [Windows.Storage.Streams.IInputStream]
        if (-not $inputStream) { $inputStream = [Windows.Storage.Streams.IInputStream]$stream.Value }
        if (-not $inputStream) { throw 'PS 5.1 cannot QI IRandomAccessStreamWithContentType to IInputStream (__ComObject)' }
        $reader = New-Object Windows.Storage.Streams.DataReader($inputStream)
        $loadOp = $reader.LoadAsync($size)
        $loaded = AwaitOp $loadOp ([System.UInt32])
        $bytes = New-Object byte[] $loaded.Value
        if ($bytes.Length -gt 0) { $reader.ReadBytes($bytes) }
        $sw.Stop()
        $snap.thumbnail = [ordered] @{
          contentType = $contentType; sizeBytes = $bytes.Length; openReadMs = $sw.ElapsedMilliseconds
          firstBytesHex = (($bytes[0..([Math]::Min(7, $bytes.Length-1))] | ForEach-Object { $_.ToString('x2') }) -join '')
        }
        $stream.Value.Dispose()
      } catch { $snap.thumbnail = @{ error = $_.Exception.ToString() } }
    } else {
      $snap.thumbnail = @{ present = $false }
    }
    $sessions += $snap
  }
  $out.sessions = $sessions
  return $out
}

$snap = Get-Snapshot $mgr
$full = [ordered] @{
  probe = 'gsmtc-read.ps1'
  psVersion = $PSVersionTable.PSVersion.ToString()
  osVersion = [System.Environment]::OSVersion.VersionString
  processIdentity = [ordered] @{ isElevated = ([System.Security.Principal.WindowsPrincipal][System.Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole('Administrators'); user = [System.Environment]::UserName; exe = $PSHome }
  snapshotMs = $t0.ElapsedMilliseconds
  snapshot = $snap
}
$full | ConvertTo-Json -Depth 8 -Compress
