# Enumerate the user's open top-level windows (the taskbar view of the world)
# as JSON for the launcher component's "running" section. Read-only. Invoked
# by main with a fixed argv (CLAUDE.md shell rule) — no arguments accepted.

# Write a JSON string as PURE ASCII (non-ASCII → \uXXXX) so CJK window/app names
# survive any stdout codepage instead of becoming "?". See media-nowplaying.ps1.
function EmitAscii($s) {
  $sb = [System.Text.StringBuilder]::new([int]$s.Length)
  foreach ($ch in $s.ToCharArray()) {
    $code = [int][char]$ch
    if ($code -gt 127) { [void]$sb.AppendFormat('\u{0:x4}', $code) } else { [void]$sb.Append($ch) }
  }
  [Console]::Out.WriteLine($sb.ToString())
}

$src = @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class WindowList {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hWnd, int index);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  const int GWL_EXSTYLE = -20;
  const int WS_EX_TOOLWINDOW = 0x80;
  const uint GW_OWNER = 4;

  public class Entry { public long Hwnd; public uint Pid; public string Title; }

  public static List<Entry> Snapshot() {
    var list = new List<Entry>();
    EnumWindows((hWnd, lParam) => {
      if (!IsWindowVisible(hWnd)) return true;
      if (GetWindow(hWnd, GW_OWNER) != IntPtr.Zero) return true;            // owned popups
      if ((GetWindowLong(hWnd, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) != 0) return true;
      int len = GetWindowTextLength(hWnd);
      if (len == 0) return true;
      var sb = new StringBuilder(len + 1);
      GetWindowText(hWnd, sb, sb.Capacity);
      uint pid; GetWindowThreadProcessId(hWnd, out pid);
      list.Add(new Entry { Hwnd = hWnd.ToInt64(), Pid = pid, Title = sb.ToString() });
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@
Add-Type -TypeDefinition $src -Language CSharp

$out = @()
foreach ($w in [WindowList]::Snapshot()) {
  $proc = $null
  try { $proc = Get-Process -Id $w.Pid -ErrorAction Stop } catch { continue }
  $exe = $null
  try { $exe = $proc.MainModule.FileName } catch { $exe = $null }  # elevated processes refuse
  $out += [pscustomobject]@{
    hwnd  = $w.Hwnd
    pid   = $w.Pid
    title = $w.Title
    exe   = $exe
    name  = $proc.ProcessName
  }
}
# -InputObject (not pipeline) so PS 5.1 serializes the ARRAY itself — piping
# unrolls it and re-wraps as {value, Count}. Empty must still be valid JSON.
EmitAscii $(if ($out.Count -eq 0) { '[]' } else { ConvertTo-Json -InputObject $out -Compress })
