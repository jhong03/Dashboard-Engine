# Emits "FULLSCREEN" / "NORMAL" on stdout whenever the state changes. FULLSCREEN
# means: a real app window is currently COVERING THE MONITOR THE WALLPAPER IS ON
# — so the wallpaper is actually hidden and worth pausing.
#
#   powershell -File fullscreen-watch.ps1 [-Monitor <index>]
#
# -Monitor is the wallpaper's monitor, ranked by (Left, Top) — the SAME index the
# main process computes (rankedDisplays) and desktop-attach.ps1 uses, so the two
# always agree on which physical screen the dashboard lives on. -1 / out of range
# falls back to the PRIMARY monitor (the long-proven single-monitor behaviour).
# Keying off the dashboard's OWN monitor is the point: a full-screen movie on a
# DIFFERENT screen must not freeze the wallpaper (the app's whole reason to exist
# is looking good), so we only pause when something covers the wallpaper itself.
#
# This deliberately uses the foreground window's geometry, NOT
# SHQueryUserNotificationState: that API reports "busy" for any full-screen app
# that is merely RUNNING (e.g. a game sitting in the background), which would
# freeze the wallpaper even while you're looking at your desktop. Foreground
# geometry pauses only when something truly covers the wallpaper, and resumes the
# moment you're back on the desktop — and it also catches borderless full-screen.
#
# One long-lived process: the P/Invoke type compiles ONCE, then each poll is a
# few cheap calls. Any failure prints NORMAL and keeps going, so the wallpaper
# never wrongly freezes. Main (lib/presence.js) reads the lines, respawns this
# with a new -Monitor when the dashboard's screen changes, and kills it on quit.

param([int]$Monitor = -1)

$ErrorActionPreference = 'SilentlyContinue'

try {
  Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class Fs {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc cb, IntPtr data);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] static extern bool GetMonitorInfo(IntPtr h, ref MONITORINFO mi);
  delegate bool MonitorEnumProc(IntPtr hMon, IntPtr hdc, ref RECT r, IntPtr data);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public int dwFlags; }

  static List<MONITORINFO> _mons;
  static bool Collect(IntPtr hMon, IntPtr hdc, ref RECT r, IntPtr data) {
    MONITORINFO mi = new MONITORINFO();
    mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
    if (GetMonitorInfo(hMon, ref mi)) _mons.Add(mi);
    return true;
  }

  // The wallpaper's monitor rect: the Nth monitor by (Left, Top) rank (matching
  // desktop-attach.ps1 + the main process), or the PRIMARY if index < 0 / out of
  // range. Re-enumerated each poll so a plug/unplug can't strand a stale rect.
  public static bool GetTargetRect(int index, ref RECT outRect) {
    _mons = new List<MONITORINFO>();
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, Collect, IntPtr.Zero);
    if (_mons.Count == 0) return false;
    _mons.Sort(delegate(MONITORINFO a, MONITORINFO b) {
      if (a.rcMonitor.left != b.rcMonitor.left) return a.rcMonitor.left.CompareTo(b.rcMonitor.left);
      return a.rcMonitor.top.CompareTo(b.rcMonitor.top);
    });
    if (index >= 0 && index < _mons.Count) { outRect = _mons[index].rcMonitor; return true; }
    foreach (MONITORINFO mi in _mons) { if ((mi.dwFlags & 1) != 0) { outRect = mi.rcMonitor; return true; } } // MONITORINFOF_PRIMARY
    outRect = _mons[0].rcMonitor;
    return true;
  }
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

    # The monitor the wallpaper is on (by rank; -1/out-of-range → primary).
    $dash = New-Object Fs+RECT
    if (-not [Fs]::GetTargetRect($Monitor, [ref]$dash)) { return 'NORMAL' }

    # Full-screen ON the wallpaper's monitor = a window covering that whole
    # monitor. A merely MAXIMISED window stops at the work area (taskbar), so its
    # bottom is short of rcMonitor — it does NOT count, exactly as before.
    $covers = ($wr.left -le $dash.left) -and ($wr.top -le $dash.top) -and `
              ($wr.right -ge $dash.right) -and ($wr.bottom -ge $dash.bottom)
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
