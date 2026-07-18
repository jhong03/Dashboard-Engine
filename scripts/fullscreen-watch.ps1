# Emits "FULLSCREEN" / "NORMAL" on stdout whenever the state changes. FULLSCREEN
# means: a real app window is currently COVERING the primary monitor (where the
# wallpaper lives) — so the wallpaper is actually hidden and worth pausing.
#
# This deliberately uses the foreground window's geometry, NOT
# SHQueryUserNotificationState: that API reports "busy" for any full-screen app
# that is merely RUNNING (e.g. a game sitting in the background), which would
# freeze the wallpaper even while you're looking at your desktop. Foreground
# geometry pauses only when something truly covers the wallpaper, and resumes
# the moment you're back on the desktop — and it also catches borderless
# full-screen (which the notification-state signal missed).
#
# One long-lived process: the P/Invoke type compiles ONCE, then each poll is a
# few cheap calls. Any failure prints NORMAL and keeps going, so the wallpaper
# never wrongly freezes. Main (lib/presence.js) reads the lines and kills this
# on quit.

$ErrorActionPreference = 'SilentlyContinue'

try {
  Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Fs {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, int flags);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern bool GetMonitorInfo(IntPtr h, ref MONITORINFO mi);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr h, StringBuilder s, int max);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public int dwFlags; }
}
"@
} catch { }

function Get-State {
  try {
    $h = [Fs]::GetForegroundWindow()
    if ($h -eq [IntPtr]::Zero) { return 'NORMAL' }

    # Skip our own reparented wallpaper window: SetParent makes it a child
    # window (WS_CHILD = 0x40000000), which a normal app window never is.
    $style = [Fs]::GetWindowLong($h, -16)  # GWL_STYLE
    if ($style -band 0x40000000) { return 'NORMAL' }

    # Skip the shell/desktop itself (Progman / WorkerW cover the whole screen).
    $sb = New-Object System.Text.StringBuilder 260
    [void][Fs]::GetClassName($h, $sb, 260)
    $cls = $sb.ToString()
    if ($cls -eq '' -or $cls -eq 'Progman' -or $cls -eq 'WorkerW' -or $cls -eq 'Shell_TrayWnd' -or $cls -eq 'Shell_SecondaryTrayWnd') { return 'NORMAL' }

    $wr = New-Object Fs+RECT
    if (-not [Fs]::GetWindowRect($h, [ref]$wr)) { return 'NORMAL' }
    $mon = [Fs]::MonitorFromWindow($h, 2)  # MONITOR_DEFAULTTONEAREST
    $mi = New-Object Fs+MONITORINFO
    $mi.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($mi)
    if (-not [Fs]::GetMonitorInfo($mon, [ref]$mi)) { return 'NORMAL' }

    # Only the PRIMARY monitor hosts the wallpaper — a full-screen app on a
    # second monitor leaves the wallpaper visible, so don't pause for it.
    if (-not ($mi.dwFlags -band 1)) { return 'NORMAL' }  # MONITORINFOF_PRIMARY

    $covers = ($wr.left -le $mi.rcMonitor.left) -and ($wr.top -le $mi.rcMonitor.top) -and `
              ($wr.right -ge $mi.rcMonitor.right) -and ($wr.bottom -ge $mi.rcMonitor.bottom)
    if ($covers) { return 'FULLSCREEN' }
    return 'NORMAL'
  } catch { return 'NORMAL' }
}

$last = ''
while ($true) {
  $fs = Get-State
  if ($fs -ne $last) {
    $last = $fs
    Write-Output $fs
    [Console]::Out.Flush()
  }
  Start-Sleep -Seconds 3
}
