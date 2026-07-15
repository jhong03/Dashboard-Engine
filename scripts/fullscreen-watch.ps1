# Emits "FULLSCREEN" / "NORMAL" on stdout whenever the full-screen state
# changes. Uses SHQueryUserNotificationState — the same signal Windows uses to
# silence toast notifications during games/presentations — so it catches
# exclusive AND borderless full-screen apps without any window heuristics.
#
# One long-lived process: the P/Invoke type compiles ONCE, then each poll is a
# single cheap call. Any failure prints NORMAL and keeps going, so the wallpaper
# never wrongly pauses. Main (lib/presence.js) reads the lines and kills this on
# quit.

$ErrorActionPreference = 'SilentlyContinue'

try {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Presence {
  [DllImport("shell32.dll")]
  public static extern int SHQueryUserNotificationState(out int state);
}
"@
} catch { }

$last = ''
while ($true) {
  $fs = 'NORMAL'
  try {
    $state = 0
    [void][Presence]::SHQueryUserNotificationState([ref]$state)
    # 2 = QUNS_BUSY (a full-screen application is running / presentation mode)
    # 3 = QUNS_RUNNING_D3D_FULL_SCREEN (exclusive full-screen Direct3D)
    if ($state -eq 2 -or $state -eq 3) { $fs = 'FULLSCREEN' }
  } catch { $fs = 'NORMAL' }

  if ($fs -ne $last) {
    $last = $fs
    Write-Output $fs
    [Console]::Out.Flush()
  }
  Start-Sleep -Seconds 4
}
