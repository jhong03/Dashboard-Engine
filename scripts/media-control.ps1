# One-shot media transport control for the CURRENT media session (Spotify, a
# browser, any player), via the Windows System Media Transport Controls.
# Invoked by main with a fixed argv (CLAUDE.md shell rule): the action is passed
# as $Action, never interpolated into a command line.
#
#   powershell ... -File scripts\media-control.ps1 -Action playpause|next|previous
#
# Emits one JSON line: { ok:true } or { ok:false, error }.

param([string]$Action = '', [string]$Exclude = '')

$ErrorActionPreference = 'Stop'
function Emit($obj) { $obj | ConvertTo-Json -Compress }

# Same session choice as the watcher: skip our own audio, prefer a playing one.
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

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
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
  $mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
  $mgr = Await ($mgrType::RequestAsync()) $mgrType
  $session = PickSession $mgr $Exclude
  if (-not $session) { Emit ([pscustomobject]@{ ok = $false; error = 'No active media session.' }); return }

  $boolType = [bool]
  switch ($Action) {
    'playpause' { Await ($session.TryTogglePlayPauseAsync()) $boolType | Out-Null }
    'next'      { Await ($session.TrySkipNextAsync()) $boolType | Out-Null }
    'previous'  { Await ($session.TrySkipPreviousAsync()) $boolType | Out-Null }
    default     { Emit ([pscustomobject]@{ ok = $false; error = "Unknown action." }); return }
  }
  Emit ([pscustomobject]@{ ok = $true })
}
catch {
  Emit ([pscustomobject]@{ ok = $false; error = "$($_.Exception.Message)" })
}
