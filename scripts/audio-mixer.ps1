# Per-app volume mixer daemon (Windows Core Audio / WASAPI). ONE long-lived
# process: the COM interop type compiles ONCE, then it answers commands on stdin
# and prints snapshots on stdout. Main (lib/audiomixer.js) drives the poll cadence
# (sends LIST) so it can pause enumeration while the wallpaper is frozen.
#
#   stdin commands (one per line):
#     LIST                 -> print "SESSIONS <json>"
#     SET  <id> <0-100>    -> set volume for a session (id = PID, or "master")
#     MUTE <id> <0|1>      -> mute/unmute
#     QUIT                 -> exit
#
# <json> = { "ok":true, "master":{"volume":N,"muted":B},
#            "sessions":[ {"id":"1234","name":"...","path":"...","volume":N,"muted":B,"system":B}, ... ] }
# Sessions are grouped by process (like the Windows Volume Mixer) and exclude
# EXPIRED sessions. A set applies to EVERY session of that process.
#
# PERSONAL data (running apps): only DISPLAYED on the wallpaper, never written to
# a pack. Fail-soft (CLAUDE.md): if COM init fails, LIST returns {"ok":false} and
# the component shows "unavailable" — the wallpaper never breaks.

$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$script:Ready = $false
try {
  Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class Mix {
  // ── Core Audio COM interfaces (only the vtable slots we call are typed; the
  // rest are stubs that just hold their slot so the offsets stay correct). ──
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator {}

  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int mask, out IntPtr devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice dev);
  }

  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, uint cls, IntPtr act, [MarshalAs(UnmanagedType.IUnknown)] out object o);
  }

  [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionManager2 {
    [PreserveSig] int GetAudioSessionControl(IntPtr a, uint b, out IntPtr c);
    [PreserveSig] int GetSimpleAudioVolume(IntPtr a, uint b, out IntPtr c);
    [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator e);
  }

  [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionEnumerator {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetSession(int index, [MarshalAs(UnmanagedType.IUnknown)] out object session);
  }

  [ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl2 {
    [PreserveSig] int GetState(out int state);
    [PreserveSig] int r2(); [PreserveSig] int r3(); [PreserveSig] int r4(); [PreserveSig] int r5();
    [PreserveSig] int r6(); [PreserveSig] int r7(); [PreserveSig] int r8(); [PreserveSig] int r9();
    [PreserveSig] int r10(); [PreserveSig] int r11();
    [PreserveSig] int GetProcessId(out uint pid);
    [PreserveSig] int IsSystemSoundsSession();
  }

  [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ISimpleAudioVolume {
    [PreserveSig] int SetMasterVolume(float level, IntPtr ev);
    [PreserveSig] int GetMasterVolume(out float level);
    [PreserveSig] int SetMute(int mute, IntPtr ev);
    [PreserveSig] int GetMute(out int mute);
  }

  [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioEndpointVolume {
    [PreserveSig] int r1(); [PreserveSig] int r2(); [PreserveSig] int r3(); [PreserveSig] int r4();
    [PreserveSig] int SetMasterVolumeLevelScalar(float level, IntPtr ev);
    [PreserveSig] int r6();
    [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
    [PreserveSig] int r8(); [PreserveSig] int r9(); [PreserveSig] int r10(); [PreserveSig] int r11();
    [PreserveSig] int SetMute(int mute, IntPtr ev);
    [PreserveSig] int GetMute(out int mute);
  }

  static Guid IID_ASM2 = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
  static Guid IID_AEV  = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
  const uint CLSCTX_ALL = 23;

  static IMMDevice DefaultDevice() {
    IMMDeviceEnumerator e = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
    IMMDevice dev;
    if (e.GetDefaultAudioEndpoint(0, 0, out dev) != 0) return null; // eRender, eConsole
    return dev;
  }

  static IAudioEndpointVolume Endpoint(IMMDevice dev) {
    object o; Guid iid = IID_AEV;
    if (dev.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out o) != 0 || o == null) return null;
    return (IAudioEndpointVolume)o;
  }

  static IAudioSessionEnumerator Sessions(IMMDevice dev) {
    object o; Guid iid = IID_ASM2;
    if (dev.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out o) != 0 || o == null) return null;
    IAudioSessionEnumerator en;
    if (((IAudioSessionManager2)o).GetSessionEnumerator(out en) != 0) return null;
    return en;
  }

  static string Esc(string s) {
    if (s == null) return "";
    StringBuilder b = new StringBuilder();
    foreach (char c in s) {
      if (c == '"' || c == '\\') { b.Append('\\'); b.Append(c); }
      else if (c == '\n') b.Append("\\n");
      else if (c == '\r') b.Append("\\r");
      else if (c == '\t') b.Append("\\t");
      else if (c < 32) b.Append("\\u").Append(((int)c).ToString("x4"));
      else b.Append(c);
    }
    return b.ToString();
  }

  static int Pct(float f) {
    int v = (int)Math.Round(f * 100.0f);
    return v < 0 ? 0 : (v > 100 ? 100 : v);
  }

  // Friendly name + exe path for a process id (best effort — protected/elevated
  // processes deny module access, so we fall back to the bare process name).
  static void ProcInfo(uint pid, out string name, out string path) {
    name = "App " + pid; path = "";
    try {
      Process p = Process.GetProcessById((int)pid);
      name = p.ProcessName;
      try {
        path = p.MainModule.FileName;
        string desc = p.MainModule.FileVersionInfo.FileDescription;
        if (!string.IsNullOrEmpty(desc)) name = desc;
      } catch { }
    } catch { }
  }

  public static string Snapshot() {
    try {
      IMMDevice dev = DefaultDevice();
      if (dev == null) return "{\"ok\":false}";

      StringBuilder j = new StringBuilder();
      j.Append("{\"ok\":true,\"master\":");
      IAudioEndpointVolume epv = Endpoint(dev);
      if (epv != null) {
        float mv; int mm;
        epv.GetMasterVolumeLevelScalar(out mv); epv.GetMute(out mm);
        j.Append("{\"volume\":").Append(Pct(mv)).Append(",\"muted\":").Append(mm != 0 ? "true" : "false").Append("}");
      } else { j.Append("{\"volume\":100,\"muted\":false}"); }

      j.Append(",\"sessions\":[");
      IAudioSessionEnumerator en = Sessions(dev);
      bool first = true;
      Dictionary<uint, bool> seen = new Dictionary<uint, bool>();
      if (en != null) {
        int count; en.GetCount(out count);
        for (int i = 0; i < count && i < 128; i++) {
          object so;
          if (en.GetSession(i, out so) != 0 || so == null) continue;
          IAudioSessionControl2 c2 = so as IAudioSessionControl2;
          ISimpleAudioVolume vol = so as ISimpleAudioVolume;
          if (c2 == null || vol == null) continue;
          int state; c2.GetState(out state);
          if (state == 2) continue; // AudioSessionStateExpired
          uint pid; c2.GetProcessId(out pid);
          bool system = (c2.IsSystemSoundsSession() == 0); // S_OK == system sounds
          uint key = system ? 0u : pid;
          if (seen.ContainsKey(key)) continue; // one row per process (grouped)
          seen[key] = true;
          float v; int m; vol.GetMasterVolume(out v); vol.GetMute(out m);
          string name, path;
          if (system) { name = "System sounds"; path = ""; }
          else { ProcInfo(pid, out name, out path); }
          if (!first) j.Append(",");
          first = false;
          j.Append("{\"id\":\"").Append(system ? "system" : pid.ToString()).Append("\"");
          j.Append(",\"name\":\"").Append(Esc(name)).Append("\"");
          j.Append(",\"path\":\"").Append(Esc(path)).Append("\"");
          j.Append(",\"volume\":").Append(Pct(v));
          j.Append(",\"muted\":").Append(m != 0 ? "true" : "false");
          j.Append(",\"system\":").Append(system ? "true" : "false").Append("}");
        }
      }
      j.Append("]}");
      return j.ToString();
    } catch {
      return "{\"ok\":false}";
    }
  }

  // Apply an action to a target: "master", "system", or a decimal PID. A PID
  // target hits EVERY session of that process; unknown targets are a no-op.
  static void Apply(string id, float? volume, int? mute) {
    try {
      IMMDevice dev = DefaultDevice();
      if (dev == null) return;
      if (id == "master") {
        IAudioEndpointVolume epv = Endpoint(dev);
        if (epv == null) return;
        if (volume.HasValue) epv.SetMasterVolumeLevelScalar(volume.Value, IntPtr.Zero);
        if (mute.HasValue) epv.SetMute(mute.Value, IntPtr.Zero);
        return;
      }
      bool wantSystem = (id == "system");
      uint wantPid = 0;
      if (!wantSystem && !uint.TryParse(id, out wantPid)) return;
      IAudioSessionEnumerator en = Sessions(dev);
      if (en == null) return;
      int count; en.GetCount(out count);
      for (int i = 0; i < count && i < 128; i++) {
        object so;
        if (en.GetSession(i, out so) != 0 || so == null) continue;
        IAudioSessionControl2 c2 = so as IAudioSessionControl2;
        ISimpleAudioVolume vol = so as ISimpleAudioVolume;
        if (c2 == null || vol == null) continue;
        bool system = (c2.IsSystemSoundsSession() == 0);
        uint pid; c2.GetProcessId(out pid);
        bool match = wantSystem ? system : (!system && pid == wantPid);
        if (!match) continue;
        if (volume.HasValue) vol.SetMasterVolume(volume.Value, IntPtr.Zero);
        if (mute.HasValue) vol.SetMute(mute.Value, IntPtr.Zero);
      }
    } catch { }
  }

  public static void SetVolume(string id, int pct) {
    float f = pct < 0 ? 0f : (pct > 100 ? 1f : pct / 100.0f);
    Apply(id, f, null);
  }
  public static void SetMute(string id, int m) { Apply(id, null, m != 0 ? 1 : 0); }
}
"@
  $script:Ready = $true
} catch { $script:Ready = $false }

function Emit-Snapshot {
  if ($script:Ready) { $snap = [Mix]::Snapshot() } else { $snap = '{"ok":false}' }
  [Console]::Out.WriteLine('SESSIONS ' + $snap)
  [Console]::Out.Flush()
}

# Command loop. One try/catch per line so a bad command can never kill the daemon.
while (($line = [Console]::In.ReadLine()) -ne $null) {
  try {
    $parts = $line.Trim().Split(' ')
    switch ($parts[0]) {
      'LIST' { Emit-Snapshot }
      'SET'  { if ($script:Ready -and $parts.Count -ge 3) { [Mix]::SetVolume($parts[1], [int]$parts[2]) } }
      'MUTE' { if ($script:Ready -and $parts.Count -ge 3) { [Mix]::SetMute($parts[1], [int]$parts[2]) } }
      'QUIT' { break }
      default { }
    }
  } catch { }
}
