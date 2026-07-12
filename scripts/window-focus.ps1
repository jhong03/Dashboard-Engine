# Bring one window to the foreground (launcher "running" tile click). The
# hwnd argument is validated in main against its own last enumeration —
# never renderer-supplied — and must parse as an integer here regardless.
param([Parameter(Mandatory = $true)][long]$TargetHwnd)

$src = @"
using System;
using System.Runtime.InteropServices;

public static class WindowFocus {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
}
"@
Add-Type -TypeDefinition $src -Language CSharp

$hwnd = [IntPtr]$TargetHwnd
if ([WindowFocus]::IsIconic($hwnd)) { [WindowFocus]::ShowWindow($hwnd, 9) | Out-Null } # SW_RESTORE
if ([WindowFocus]::SetForegroundWindow($hwnd)) { 'focused' } else { 'refused' }
