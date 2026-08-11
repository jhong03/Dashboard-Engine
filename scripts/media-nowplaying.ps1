# Long-lived "now playing" watcher via the Windows System Media Transport
# Controls (GlobalSystemMediaTransportControlsSessionManager). Reports what the
# CURRENT media app (Spotify, a browser, any player) is playing, for the
# `nowplaying` component. Read-only telemetry; control is a separate one-shot.
#
# Emits ONE compact JSON line whenever the state changes (and a position resync
# every few seconds so the progress bar stays honest). Poll-based (every ~1 s)
# to avoid fragile WinRT event subscriptions. Fail-soft: any error emits an
# {ok:false} line and keeps going, so the wallpaper never breaks.
#
# Line shape:
#   { ok:true, has:false }                                  # nothing playing
#   { ok:true, has:true, title, artist, album, status,      # status: playing|paused|stopped
#     posMs, durMs, updated (unix ms), art (base64 jpg|null),
#     canNext, canPrev, canPause }
#
# Run standalone to diagnose:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\media-nowplaying.ps1
#
# -Exclude <AppUserModelId>: skip a media session by source app (used to ignore
# OUR OWN background-music <audio>, which registers with Windows too).

param([string]$Exclude = '')

$ErrorActionPreference = 'Stop'

# Emit one JSON line as PURE ASCII — every non-ASCII char escaped to \uXXXX — so
# CJK / accented / emoji titles survive ANY stdout codepage. Otherwise PowerShell
# renders the line under the console's default (often non-UTF-8) codepage and turns
# Japanese/Chinese titles into literal "?" before Node ever reads them. Node's
# JSON.parse decodes the \uXXXX escapes straight back to the real characters.
function Emit($obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 3
  $sb = [System.Text.StringBuilder]::new($json.Length)
  foreach ($ch in $json.ToCharArray()) {
    $code = [int][char]$ch
    if ($code -gt 127) { [void]$sb.AppendFormat('\u{0:x4}', $code) } else { [void]$sb.Append($ch) }
  }
  [Console]::Out.WriteLine($sb.ToString())
  [Console]::Out.Flush()
}

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime

  # WinRT IAsyncOperation<T> → wait synchronously via AsTask + reflection.
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  function Await($op, $resultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
    $task = $asTask.Invoke($null, @($op))
    $task.Wait(5000) | Out-Null
    $task.Result
  }

  [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime] | Out-Null
  [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType=WindowsRuntime] | Out-Null

  $mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
  $mgr = Await ($mgrType::RequestAsync()) $mgrType

  # PlaybackStatus enum → string.
  function StatusName($v) {
    switch ([int]$v) { 4 { 'playing' } 3 { 'paused' } 2 { 'stopped' } default { 'stopped' } }
  }

  # Pick the session to show: the system's current one unless it's the excluded
  # app (our own audio), in which case the best OTHER session (a playing one
  # first). Returns $null when the only thing playing is us.
  function PickSession($manager, $exclude) {
    try {
      $cur = $manager.GetCurrentSession()
      if ($cur -and ($exclude -eq '' -or $cur.SourceAppUserModelId -ne $exclude)) { return $cur }
      $others = @(@($manager.GetSessions()) | Where-Object { $exclude -eq '' -or $_.SourceAppUserModelId -ne $exclude })
      if ($others.Count -eq 0) { return $null }
      foreach ($s in $others) {
        try { if ([int]$s.GetPlaybackInfo().PlaybackStatus -eq 4) { return $s } } catch { }
      }
      return $others[0]
    } catch { return $null }
  }

  # Best-effort album art (thumbnail stream → base64). Only called on a track
  # change; any failure returns $null and the component shows a placeholder.
  # Best-effort: some players (e.g. the Store Spotify app) open an empty
  # thumbnail stream — we return $null and the component shows a placeholder.
  function ReadArt($props) {
    try {
      if (-not $props.Thumbnail) { return $null }
      $stream = Await ($props.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
      if (-not $stream) { return $null }
      $size = [int]$stream.Size
      if ($size -le 0 -or $size -gt 5000000) { return $null }
      # DataReader with explicit int sizes — no extension-method binding (which
      # PowerShell couldn't resolve for the WinRT stream type).
      $reader = [Windows.Storage.Streams.DataReader]::new($stream)
      Await ($reader.LoadAsync([uint32]$size)) ([uint32]) | Out-Null
      $buffer = New-Object 'byte[]' $size
      $reader.ReadBytes($buffer)
      return [Convert]::ToBase64String($buffer)
    } catch { return $null }
  }

  $lastKey = '__init__'
  $lastArtKey = ''
  $art = $null
  $ticks = 0

  while ($true) {
    try {
      $session = PickSession $mgr $Exclude
      if (-not $session) {
        if ($lastKey -ne '__none__') { $lastKey = '__none__'; Emit ([pscustomobject]@{ ok = $true; has = $false }) }
      } else {
        $info = $session.GetPlaybackInfo()
        $status = StatusName $info.PlaybackStatus
        $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
        $timeline = $session.GetTimelineProperties()
        $title = "$($props.Title)"
        $artist = "$($props.Artist)"
        $album = "$($props.AlbumTitle)"
        $posMs = [int64]$timeline.Position.TotalMilliseconds
        $durMs = [int64]$timeline.EndTime.TotalMilliseconds
        $canNext = [bool]$info.Controls.IsNextEnabled
        $canPrev = [bool]$info.Controls.IsPreviousEnabled
        $canPause = [bool]$info.Controls.IsPauseEnabled -or [bool]$info.Controls.IsPlayEnabled

        # Re-read art only when the track identity changes.
        $artKey = "$title|$artist|$album"
        if ($artKey -ne $lastArtKey) { $art = ReadArt $props; $lastArtKey = $artKey }

        # Emit on any meaningful change, plus a periodic resync for the position.
        $key = "$title|$artist|$status|$durMs"
        $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        if ($key -ne $lastKey -or ($now - $ticks) -ge 4000) {
          $lastKey = $key; $ticks = $now
          Emit ([pscustomobject]@{
            ok = $true; has = $true; title = $title; artist = $artist; album = $album;
            status = $status; posMs = $posMs; durMs = $durMs; updated = $now; art = $art;
            canNext = $canNext; canPrev = $canPrev; canPause = $canPause
          })
        }
      }
    } catch {
      Emit ([pscustomobject]@{ ok = $false; error = "$($_.Exception.Message)" })
    }
    Start-Sleep -Milliseconds 1000
  }
}
catch {
  Emit ([pscustomobject]@{ ok = $false; error = "$($_.Exception.Message)" })
}
