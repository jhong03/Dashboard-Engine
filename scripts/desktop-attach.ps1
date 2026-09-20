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
# should fall back to a plain window. -Detach is used by that fallback to
# restore a genuinely top-level window after a partial/ambiguous attach.

param(
    [Parameter(Mandatory = $true)][uint64]$Hwnd,
    [int]$Monitor = -1,
    [switch]$Detach
)

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class DesktopLayer {
    [DllImport("user32.dll")] static extern IntPtr FindWindow(string cls, string title);
    [DllImport("user32.dll")] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
    [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, UIntPtr w, IntPtr l, uint flags, uint timeout, out UIntPtr result);
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SetParent(IntPtr child, IntPtr parent);
    [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr child);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder name, int max);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr child, uint flags);
    [DllImport("user32.dll")] static extern IntPtr GetDesktopWindow();
    // Use the exported Unicode entry points explicitly. The Win32 headers
    // expose these names as macros, but there is no reliable undecorated
    // Get/SetWindowLongPtr export for a C# P/Invoke lookup.
    [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW", SetLastError=true)] static extern IntPtr GetWindowLongPtr64(IntPtr h, int index);
    [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW", SetLastError=true)] static extern IntPtr SetWindowLongPtr64(IntPtr h, int index, IntPtr value);
    [DllImport("user32.dll", EntryPoint="GetWindowLongW", SetLastError=true)] static extern int GetWindowLong32(IntPtr h, int index);
    [DllImport("user32.dll", EntryPoint="SetWindowLongW", SetLastError=true)] static extern int SetWindowLong32(IntPtr h, int index, int value);
    [DllImport("user32.dll", SetLastError=true)] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int ht, uint flags);
    [DllImport("user32.dll", SetLastError=true)] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
    [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc cb, IntPtr data);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO mi);

    delegate bool EnumProc(IntPtr h, IntPtr l);
    delegate bool MonitorEnumProc(IntPtr hMon, IntPtr hdc, ref RECT r, IntPtr data);

    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }

    const int GWL_STYLE = -16;
    const long WS_CHILD = 0x40000000L;
    const long WS_POPUP = 0x80000000L;
    const uint SWP_NOSIZE = 0x0001;
    const uint SWP_NOMOVE = 0x0002;
    const uint SWP_NOZORDER = 0x0004;
    const uint SWP_NOACTIVATE = 0x0010;
    const uint SWP_FRAMECHANGED = 0x0020;
    static readonly IntPtr DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = new IntPtr(-4);

    static IntPtr StyleValue(long value) {
        return IntPtr.Size == 8 ? new IntPtr(value) : new IntPtr(unchecked((int)value));
    }

    static IntPtr GetStyle(IntPtr h) {
        long value = IntPtr.Size == 8 ? GetWindowLongPtr64(h, GWL_STYLE).ToInt64() : GetWindowLong32(h, GWL_STYLE);
        // GWL_STYLE is a 32-bit value even when LONG_PTR is 64-bit. Normalize
        // it before bit operations so WS_POPUP is never sign-extended on x64.
        return StyleValue(value & 0xFFFFFFFFL);
    }

    static bool SetStyle(IntPtr h, IntPtr style) {
        if (IntPtr.Size == 8) SetWindowLongPtr64(h, GWL_STYLE, style);
        else SetWindowLong32(h, GWL_STYLE, style.ToInt32());
        return GetStyle(h) == style;
    }

    static void FrameChanged(IntPtr h) {
        SetWindowPos(h, IntPtr.Zero, 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
    }

    static void Restore(IntPtr child, IntPtr parent, IntPtr style, RECT oldRect, bool hadRect) {
        if (IsWindow(child)) {
            if (GetParent(child) != parent) SetParent(child, parent);
            SetStyle(child, style);
            if (hadRect) SetWindowPos(child, IntPtr.Zero, oldRect.Left, oldRect.Top,
                oldRect.Right - oldRect.Left, oldRect.Bottom - oldRect.Top,
                SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
            else FrameChanged(child);
        }
    }

    static IntPtr workerAfterDefView = IntPtr.Zero;
    static List<RECT> monitors;
    public static string LastStatus = "not-started";

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
    static bool PositionOnMonitor(IntPtr child, IntPtr layer, int monitor) {
        if (monitor < 0) return true;
        monitors = new List<RECT>();
        if (!EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, CollectMonitor, IntPtr.Zero)) return false;
        monitors.Sort(delegate(RECT a, RECT b) {
            if (a.Left != b.Left) return a.Left.CompareTo(b.Left);
            return a.Top.CompareTo(b.Top);
        });
        if (monitor >= monitors.Count) return false;
        RECT m = monitors[monitor];
        RECT origin;
        if (!GetWindowRect(layer, out origin)) return false;
        if (!MoveWindow(child, m.Left - origin.Left, m.Top - origin.Top,
            m.Right - m.Left, m.Bottom - m.Top, true)) return false;
        RECT placed;
        if (!GetWindowRect(child, out placed)) return false;
        // GetWindowRect is authoritative for the child after MoveWindow. A
        // mismatch means DPI virtualization or a shell race changed the
        // geometry; report failure so the caller can restore a usable window.
        return placed.Left == m.Left && placed.Top == m.Top
            && placed.Right == m.Right && placed.Bottom == m.Bottom;
    }

    static string ClassName(IntPtr h) {
        StringBuilder name = new StringBuilder(128);
        return h != IntPtr.Zero && GetClassName(h, name, name.Capacity) > 0 ? name.ToString() : "?";
    }

    static IntPtr ActualParent(IntPtr child) {
        // GetParent reports the OWNER for WS_POPUP windows. Build 13 keeps
        // Electron's popup style for keyboard input, so use the actual tree.
        return GetAncestor(child, 1); // GA_PARENT
    }

    static string State(IntPtr child) {
        IntPtr parent = ActualParent(child);
        RECT rect;
        GetWindowRect(child, out rect);
        return String.Format("hwnd={0} parent={1} class={2} visible={3} parentVisible={4} enabled={5} getParent={6} rect={7},{8},{9},{10}",
            child.ToInt64(),
            parent.ToInt64(), ClassName(parent), IsWindowVisible(child),
            parent != IntPtr.Zero && IsWindowVisible(parent), IsWindowEnabled(child), GetParent(child).ToInt64(),
            rect.Left, rect.Top, rect.Right, rect.Bottom);
    }

    public static string Inspect(long hwnd) { return State(new IntPtr(hwnd)); }

    public static string Verify(long hwnd) {
        IntPtr child = new IntPtr(hwnd);
        if (!IsWindow(child)) return "verify-failed invalid-window";
        IntPtr parent = ActualParent(child);
        if (parent == IntPtr.Zero || parent == GetDesktopWindow() || !IsWindow(parent)) return "verify-failed parent-missing " + State(child);
        string cls = ClassName(parent);
        if (cls != "Progman" && cls != "WorkerW") return "verify-failed unexpected-parent " + State(child);
        if (!IsWindowVisible(child)) return "verify-failed child-hidden";
        if (!IsWindowVisible(parent)) return "verify-failed parent-hidden";
        if (!IsWindowEnabled(child)) return "verify-failed child-disabled";
        return "verified " + State(child);
    }

    public static long Attach(long hwnd, int monitor) {
        // The helper uses physical monitor rectangles. Opt into per-monitor V2
        // before querying or moving windows so mixed-DPI displays do not turn
        // an otherwise valid attach into a falsely scaled geometry.
        try { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2); } catch { }
        IntPtr child = new IntPtr(hwnd);
        if (!IsWindow(child)) { LastStatus = "invalid-window"; return 0; }
        IntPtr progman = FindWindow("Progman", null);
        if (progman == IntPtr.Zero) { LastStatus = "progman-not-found"; return 0; }

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
        if (target == IntPtr.Zero) { LastStatus = "wallpaper-target-not-found"; return 0; }
        if (!IsWindow(target)) { LastStatus = "wallpaper-target-invalid"; return 0; }

        IntPtr oldParent = ActualParent(child);
        IntPtr oldStyle = GetStyle(child);
        RECT oldRect;
        bool hadRect = GetWindowRect(child, out oldRect);
        if (oldStyle == IntPtr.Zero) { LastStatus = "style-read-failed"; return 0; }

        // Keep Electron's WS_POPUP style. SetParent changes the desktop ownership
        // relationship, while the popup style is what lets Chromium activate the
        // window and route mouse/keyboard focus into HTML controls. A WS_CHILD
        // conversion renders behind the shell but cannot reliably activate from
        // the desktop on every Windows 11 shell build.
        IntPtr previous = SetParent(child, target);
        int setParentError = Marshal.GetLastWin32Error();
        IntPtr resultingParent = ActualParent(child);
        if (resultingParent != target) {
            LastStatus = String.Format("setparent-failed previous={0} error={1}", previous.ToInt64(), setParentError);
            Restore(child, oldParent, oldStyle, oldRect, hadRect);
            return 0;
        }
        IntPtr resultingStyle = GetStyle(child);
        if ((resultingStyle.ToInt64() & WS_POPUP) == 0) {
            LastStatus = "post-attach-style-invalid";
            Restore(child, oldParent, oldStyle, oldRect, hadRect);
            return 0;
        }
        if (!PositionOnMonitor(child, target, monitor)) {
            LastStatus = "monitor-position-failed";
            Restore(child, oldParent, oldStyle, oldRect, hadRect);
            return 0;
        }
        LastStatus = State(child);
        return target.ToInt64();
    }

    public static bool Detach(long hwnd) {
        IntPtr child = new IntPtr(hwnd);
        if (!IsWindow(child)) { LastStatus = "invalid-window"; return false; }
        IntPtr parent = GetParent(child);
        IntPtr style = GetStyle(child);
        if (style == IntPtr.Zero) { LastStatus = "style-read-failed"; return false; }
        IntPtr result = SetParent(child, IntPtr.Zero);
        int setParentError = Marshal.GetLastWin32Error();
        // A NULL previous parent is valid; the resulting relationship is the
        // authoritative check. If it was already top-level, this is idempotent.
        IntPtr resultingParent = GetParent(child);
        if (resultingParent != IntPtr.Zero) {
            LastStatus = String.Format("detach-failed previous={0} error={1}", result.ToInt64(), setParentError);
            return false;
        }
        long topStyle = (style.ToInt64() & 0xFFFFFFFFL & ~WS_CHILD) | WS_POPUP;
        if (!SetStyle(child, StyleValue(topStyle))) {
            LastStatus = "top-level-style-update-failed";
            return false;
        }
        FrameChanged(child);
        LastStatus = State(child);
        return true;
    }
}
"@

$hwndLong = [long]$Hwnd
if ($Detach) {
    if (-not [DesktopLayer]::Detach($hwndLong)) {
        Write-Output ("detach-failed " + [DesktopLayer]::LastStatus)
        exit 1
    }
    Write-Output ("detached " + [DesktopLayer]::LastStatus)
    exit 0
}
$target = [DesktopLayer]::Attach($hwndLong, $Monitor)
if ($target -eq 0) {
    Write-Output ("attach-failed " + [DesktopLayer]::LastStatus)
    exit 1
}
Write-Output ("attached:$target " + [DesktopLayer]::LastStatus)
exit 0
