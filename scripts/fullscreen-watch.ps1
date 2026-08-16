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
# EVENT-DRIVEN, not polled. A 3-second poll used to add up to ~3 s of ragged,
# inconsistent lag on every freeze/resume. Instead we hook Windows' own window
# events (SetWinEventHook: foreground-changed, minimize/restore, and the foreground
# window moving/resizing) and re-run the SAME geometry check only when something
# actually changes — so transitions are near-instant AND idle cost is ~zero (no
# work between events). A 150 ms debounce coalesces bursts (e.g. a splash handing
# off to a main window) so we never flap freeze<->resume; a slow 15 s backstop
# timer catches any event Windows might drop under load.
#
# This deliberately uses the foreground window's geometry, NOT
# SHQueryUserNotificationState: that API reports "busy" for any full-screen app
# that is merely RUNNING (e.g. a game sitting in the background), which would
# freeze the wallpaper even while you're looking at your desktop. Foreground
# geometry pauses only when something truly covers the wallpaper, and resumes the
# moment you're back on the desktop — and it also catches borderless full-screen.
#
# One long-lived process: the P/Invoke type compiles ONCE, then it pumps messages.
# Any failure degrades softly (poll, or report NORMAL) so the wallpaper never
# wrongly freezes. Main (lib/presence.js) reads the lines, respawns this with a new
# -Monitor when the dashboard's screen changes, and kills it on quit.

param([int]$Monitor = -1)

$ErrorActionPreference = 'SilentlyContinue'

$compiled = $false
try {
  Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class FsWatch {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc cb, IntPtr data);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] static extern bool GetMonitorInfo(IntPtr h, ref MONITORINFO mi);
  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint eMin, uint eMax, IntPtr hmod, WinEventDelegate cb, uint pid, uint tid, uint flags);
  [DllImport("user32.dll")] static extern IntPtr SetTimer(IntPtr hWnd, IntPtr nIDEvent, uint uElapse, IntPtr lpTimerFunc);
  [DllImport("user32.dll")] static extern bool KillTimer(IntPtr hWnd, IntPtr uIDEvent);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG msg, IntPtr hWnd, uint min, uint max);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG msg);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG msg);

  delegate bool MonitorEnumProc(IntPtr hMon, IntPtr hdc, ref RECT r, IntPtr data);
  delegate void WinEventDelegate(IntPtr hook, uint ev, IntPtr hwnd, int idObj, int idChild, uint tid, uint time);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public int dwFlags; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x, y; }
  [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public POINT pt; }

  static List<MONITORINFO> _mons;
  static bool Collect(IntPtr hMon, IntPtr hdc, ref RECT r, IntPtr data) {
    MONITORINFO mi = new MONITORINFO();
    mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
    if (GetMonitorInfo(hMon, ref mi)) _mons.Add(mi);
    return true;
  }

  // The wallpaper's monitor rect: the Nth monitor by (Left, Top) rank (matching
  // desktop-attach.ps1 + the main process), or the PRIMARY if index < 0 / out of
  // range. Re-enumerated each check so a plug/unplug can't strand a stale rect.
  static bool GetTargetRect(int index, ref RECT outRect) {
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

  // The state right now: is the foreground window covering the wallpaper's monitor?
  public static string GetState(int monitor) {
    try {
      IntPtr h = GetForegroundWindow();
      if (h == IntPtr.Zero) return "NORMAL";
      // Skip our own reparented wallpaper window: SetParent makes it a child window
      // (WS_CHILD = 0x40000000), which a normal app window never is.
      int style = GetWindowLong(h, -16); // GWL_STYLE
      if ((style & 0x40000000) != 0) return "NORMAL";
      // Skip the shell/desktop itself (Progman / WorkerW / the taskbar).
      StringBuilder sb = new StringBuilder(260);
      GetClassName(h, sb, 260);
      string cls = sb.ToString();
      if (cls == "" || cls == "Progman" || cls == "WorkerW" || cls == "Shell_TrayWnd" || cls == "Shell_SecondaryTrayWnd") return "NORMAL";
      RECT wr;
      if (!GetWindowRect(h, out wr)) return "NORMAL";
      RECT dash = new RECT();
      if (!GetTargetRect(monitor, ref dash)) return "NORMAL";
      // Full-screen ON the wallpaper's monitor = a window covering that whole
      // monitor. A merely MAXIMISED window stops at the work area (taskbar), so its
      // bottom is short of rcMonitor — it does NOT count, exactly as before.
      bool covers = wr.left <= dash.left && wr.top <= dash.top && wr.right >= dash.right && wr.bottom >= dash.bottom;
      return covers ? "FULLSCREEN" : "NORMAL";
    } catch { return "NORMAL"; }
  }

  static int _monitor;
  static string _last = null;
  static WinEventDelegate _cb; // held so the GC can't collect the callback
  static IntPtr _debTimer = IntPtr.Zero;
  static IntPtr _backTimer = IntPtr.Zero;
  const uint WM_TIMER = 0x0113;

  static void Emit() {
    string s = GetState(_monitor);
    if (s != _last) { _last = s; Console.Out.WriteLine(s); Console.Out.Flush(); }
  }

  static void OnEvent(IntPtr hook, uint ev, IntPtr hwnd, int idObj, int idChild, uint tid, uint time) {
    // A window moving/resizing (0x800B EVENT_OBJECT_LOCATIONCHANGE) fires constantly
    // for every window; only the FOREGROUND window's own geometry can change the
    // answer (e.g. a game switching to borderless full-screen), so ignore the rest.
    if (ev == 0x800B) {
      if (idObj != 0) return;                    // OBJID_WINDOW only, not child controls
      if (hwnd != GetForegroundWindow()) return; // only the active window matters
    }
    // Coalesce a burst of events into ONE check 150 ms after the last one. Re-arm by
    // killing the pending timer and setting a fresh one (no timer leak).
    if (_debTimer != IntPtr.Zero) KillTimer(IntPtr.Zero, _debTimer);
    _debTimer = SetTimer(IntPtr.Zero, IntPtr.Zero, 150, IntPtr.Zero);
  }

  // Register the hooks and pump messages forever. Returns only on GetMessage error.
  public static void Run(int monitor) {
    _monitor = monitor;
    Emit(); // report the state at startup (e.g. a game already covering the screen)
    _cb = new WinEventDelegate(OnEvent);
    SetWinEventHook(0x0003, 0x0003, IntPtr.Zero, _cb, 0, 0, 0); // EVENT_SYSTEM_FOREGROUND
    SetWinEventHook(0x0016, 0x0017, IntPtr.Zero, _cb, 0, 0, 0); // MINIMIZESTART..MINIMIZEEND
    SetWinEventHook(0x800B, 0x800B, IntPtr.Zero, _cb, 0, 0, 0); // EVENT_OBJECT_LOCATIONCHANGE (filtered above)
    _backTimer = SetTimer(IntPtr.Zero, IntPtr.Zero, 15000, IntPtr.Zero); // slow safety net
    MSG msg;
    int r;
    while ((r = GetMessage(out msg, IntPtr.Zero, 0, 0)) != 0) {
      if (r == -1) break; // GetMessage error → let the caller degrade to polling
      if (msg.message == WM_TIMER) {
        if (msg.wParam == _debTimer) { KillTimer(IntPtr.Zero, _debTimer); _debTimer = IntPtr.Zero; Emit(); continue; }
        if (msg.wParam == _backTimer) { Emit(); continue; }
      }
      TranslateMessage(ref msg);
      DispatchMessage(ref msg);
    }
  }
}
"@
  $compiled = $true
} catch { $compiled = $false }

if ($compiled) {
  try {
    [FsWatch]::Run($Monitor) # blocks, emitting on every real change
  } catch {
    # Runtime hook/pump failure (rare) → degrade to the old cheap poll. GetState still
    # exists because the type compiled, so we keep the exact same behaviour, just slower.
    $last = ''
    while ($true) {
      $s = [FsWatch]::GetState($Monitor)
      if ($s -ne $last) { $last = $s; [Console]::Out.WriteLine($s); [Console]::Out.Flush() }
      Start-Sleep -Seconds 3
    }
  }
} else {
  # Compile failed (should never happen — standard P/Invoke). Fail SAFE: report NORMAL
  # so the wallpaper keeps running and is never wrongly frozen, then idle.
  [Console]::Out.WriteLine('NORMAL'); [Console]::Out.Flush()
  while ($true) { Start-Sleep -Seconds 3600 }
}
