# Attach a window to the Windows desktop layer — the Wallpaper Engine trick.
#
# Reparents the given HWND under the desktop's WorkerW (behind the icons),
# so the dashboard renders as the wallpaper. Invoked by the main process
# with a FIXED argv (the hwnd is program-generated, never user text):
#
#   powershell -File desktop-attach.ps1 <hwnd-decimal> [<monitor-index>]
#
# Two desktop architectures are handled:
#   - classic (pre-24H2): SHELLDLL_DefView lives under a WorkerW; the render
#     target is the NEXT top-level WorkerW after that one
#   - 24H2+: SHELLDLL_DefView lives directly under Progman; parenting to
#     Progman itself puts the window behind the icons
#
# Multi-monitor: after reparenting, the child's coordinates are relative to the
# wallpaper layer (which spans the whole virtual desktop). When a monitor index
# is given (>= 0), we move the child to exactly cover that monitor using PHYSICAL
# pixel rects from Win32 — DPI-safe, unlike Electron's DIP bounds. The index is
# the monitor's rank sorted by (Left, Top); the main process ranks Electron's
# display list the same way so the two line up. Index -1 = leave Electron's
# bounds untouched (the primary/default path, unchanged from before).
#
# Exit code 0 + "attached:<target>" on success; non-zero means the caller
# should fall back to a plain window.

param(
    [Parameter(Mandatory = $true)][uint64]$Hwnd,
    [int]$Monitor = -1
)

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class DesktopLayer {
    [DllImport("user32.dll")] static extern IntPtr FindWindow(string cls, string title);
    [DllImport("user32.dll")] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
    [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, UIntPtr w, IntPtr l, uint flags, uint timeout, out UIntPtr result);
    [DllImport("user32.dll")] static extern IntPtr SetParent(IntPtr child, IntPtr parent);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
    [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc cb, IntPtr data);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO mi);

    delegate bool EnumProc(IntPtr h, IntPtr l);
    delegate bool MonitorEnumProc(IntPtr hMon, IntPtr hdc, ref RECT r, IntPtr data);

    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }

    static IntPtr workerAfterDefView = IntPtr.Zero;
    static List<RECT> monitors;

    static bool Scan(IntPtr h, IntPtr l) {
        if (FindWindowEx(h, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero) {
            workerAfterDefView = FindWindowEx(IntPtr.Zero, h, "WorkerW", null);
        }
        return true;
    }

    static bool CollectMonitor(IntPtr hMon, IntPtr hdc, ref RECT r, IntPtr data) {
        MONITORINFO mi = new MONITORINFO();
        mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
        if (GetMonitorInfo(hMon, ref mi)) monitors.Add(mi.rcMonitor);
        return true;
    }

    // Move the reparented child to cover the given monitor exactly. The wallpaper
    // layer's window origin is the virtual-desktop top-left (can be negative), so
    // the child's parent-relative position is monitor-origin minus layer-origin.
    static void PositionOnMonitor(IntPtr child, IntPtr layer, int monitor) {
        monitors = new List<RECT>();
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, CollectMonitor, IntPtr.Zero);
        monitors.Sort(delegate(RECT a, RECT b) {
            if (a.Left != b.Left) return a.Left.CompareTo(b.Left);
            return a.Top.CompareTo(b.Top);
        });
        if (monitor < 0 || monitor >= monitors.Count) return;
        RECT m = monitors[monitor];
        RECT origin;
        if (!GetWindowRect(layer, out origin)) return;
        MoveWindow(child, m.Left - origin.Left, m.Top - origin.Top, m.Right - m.Left, m.Bottom - m.Top, true);
    }

    public static long Attach(long hwnd, int monitor) {
        IntPtr progman = FindWindow("Progman", null);
        if (progman == IntPtr.Zero) return 0;

        // Ask Progman to spawn the wallpaper WorkerW (no-op if already there).
        UIntPtr ignored;
        SendMessageTimeout(progman, 0x052C, UIntPtr.Zero, IntPtr.Zero, 0, 1000, out ignored);

        IntPtr target = IntPtr.Zero;
        if (FindWindowEx(progman, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero) {
            target = progman; // 24H2+: icons live under Progman itself
        } else {
            workerAfterDefView = IntPtr.Zero;
            EnumWindows(Scan, IntPtr.Zero);
            target = workerAfterDefView;
        }
        if (target == IntPtr.Zero) return 0;

        IntPtr child = new IntPtr(hwnd);
        if (SetParent(child, target) == IntPtr.Zero) return 0;
        if (monitor >= 0) PositionOnMonitor(child, target, monitor);
        return target.ToInt64();
    }
}
"@

$target = [DesktopLayer]::Attach([long]$Hwnd, $Monitor)
if ($target -eq 0) {
    Write-Output "attach-failed"
    exit 1
}
Write-Output "attached:$target"
exit 0
