# Attach a window to the Windows desktop layer — the Wallpaper Engine trick.
#
# Reparents the given HWND under the desktop's WorkerW (behind the icons),
# so the dashboard renders as the wallpaper. Invoked by the main process
# with a FIXED argv (the hwnd is program-generated, never user text):
#
#   powershell -File desktop-attach.ps1 <hwnd-decimal>
#
# Two desktop architectures are handled:
#   - classic (pre-24H2): SHELLDLL_DefView lives under a WorkerW; the render
#     target is the NEXT top-level WorkerW after that one
#   - 24H2+: SHELLDLL_DefView lives directly under Progman; parenting to
#     Progman itself puts the window behind the icons
#
# Exit code 0 + "attached:<target>" on success; non-zero means the caller
# should fall back to a plain window.

param([Parameter(Mandatory = $true)][uint64]$Hwnd)

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class DesktopLayer {
    [DllImport("user32.dll")] static extern IntPtr FindWindow(string cls, string title);
    [DllImport("user32.dll")] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
    [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, UIntPtr w, IntPtr l, uint flags, uint timeout, out UIntPtr result);
    [DllImport("user32.dll")] static extern IntPtr SetParent(IntPtr child, IntPtr parent);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    delegate bool EnumProc(IntPtr h, IntPtr l);

    static IntPtr workerAfterDefView = IntPtr.Zero;

    static bool Scan(IntPtr h, IntPtr l) {
        if (FindWindowEx(h, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero) {
            workerAfterDefView = FindWindowEx(IntPtr.Zero, h, "WorkerW", null);
        }
        return true;
    }

    public static long Attach(long hwnd) {
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

        if (SetParent(new IntPtr(hwnd), target) == IntPtr.Zero) return 0;
        return target.ToInt64();
    }
}
"@

$target = [DesktopLayer]::Attach([long]$Hwnd)
if ($target -eq 0) {
    Write-Output "attach-failed"
    exit 1
}
Write-Output "attached:$target"
exit 0
