/*
 * Windows a project opens -- a pygame game, a Tk tool, a Qt app -- shown
 * inside the Run workspace instead of as a window of their own.
 *
 * Win32 does the work: the process tree started by the runner is walked
 * (Toolhelp32), its visible top-level windows are found (EnumWindows), and
 * the one being previewed is made a borderless child of the app's window
 * (SetParent) and moved over the preview panel. "Pop out" undoes it.
 *
 * No native module to build: one PowerShell process compiles a small C#
 * class once and then answers line by line on stdin/stdout.
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CS = String.raw`
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public static class RunnerWin {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr SetParent(IntPtr c, IntPtr p);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] static extern IntPtr GetWL(IntPtr h, int i);
  [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW")] static extern IntPtr SetWL(IntPtr h, int i, IntPtr v);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint f);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr SetFocus(IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint f, uint p);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32FirstW(IntPtr s, ref PE e);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32NextW(IntPtr s, ref PE e);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct PE {
    public uint dwSize; public uint cntUsage; public uint th32ProcessID; public IntPtr th32DefaultHeapID;
    public uint th32ModuleID; public uint cntThreads; public uint th32ParentProcessID; public int pcPriClassBase;
    public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string szExeFile; }
  const long WS_CHILD = 0x40000000L, WS_POPUP = 0x80000000L, WS_CAPTION = 0xC00000L, WS_THICKFRAME = 0x40000L,
    WS_SYSMENU = 0x80000L, WS_MINBOX = 0x20000L, WS_MAXBOX = 0x10000L;
  static Dictionary<long, long> saved = new Dictionary<long, long>();

  static HashSet<uint> Tree(uint root) {
    var parent = new Dictionary<uint, uint>();
    IntPtr snap = CreateToolhelp32Snapshot(2, 0);
    var e = new PE(); e.dwSize = (uint)Marshal.SizeOf(typeof(PE));
    if (Process32FirstW(snap, ref e)) { do { parent[e.th32ProcessID] = e.th32ParentProcessID; } while (Process32NextW(snap, ref e)); }
    CloseHandle(snap);
    var tree = new HashSet<uint> { root };
    bool grew = true;
    while (grew) { grew = false; foreach (var kv in parent) if (!tree.Contains(kv.Key) && tree.Contains(kv.Value) && kv.Key != kv.Value) { tree.Add(kv.Key); grew = true; } }
    return tree;
  }
  static string Clean(string s) { return s.Replace("\t", " ").Replace("\n", " ").Replace("\r", " "); }
  static string Describe(IntPtr h, uint pid) {
    var sb = new StringBuilder(256); GetWindowTextW(h, sb, 256);
    RECT r; GetClientRect(h, out r);
    return h.ToInt64() + "\t" + pid + "\t" + (r.R - r.L) + "\t" + (r.B - r.T) + "\t" + Clean(sb.ToString());
  }
  // Visible, unowned windows of the tree, and those already taken in (no longer top-level) that still exist.
  public static string Scan(uint root, string keep) {
    var tree = Tree(root);
    var outp = new List<string>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (!tree.Contains(pid) || !IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero) return true;
      RECT r; GetClientRect(h, out r);
      if (r.R - r.L < 64 || r.B - r.T < 48) return true;
      outp.Add(Describe(h, pid));
      return true;
    }, IntPtr.Zero);
    if (keep.Length > 0) foreach (var s in keep.Split(',')) {
      long v; if (!long.TryParse(s, out v)) continue;
      var h = new IntPtr(v);
      if (!IsWindow(h)) continue;
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (!tree.Contains(pid)) continue;
      string d = Describe(h, pid);
      if (!outp.Contains(d)) outp.Add(d);
    }
    return string.Join("\u001e", outp);
  }
  public static string Embed(long hw, long parent) {
    var h = new IntPtr(hw);
    if (!IsWindow(h)) return "gone";
    if (!saved.ContainsKey(hw)) {
      long style = GetWL(h, -16).ToInt64();
      saved[hw] = style;
      long next = (style & ~(WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINBOX | WS_MAXBOX)) | WS_CHILD;
      SetWL(h, -16, new IntPtr(next));
      SetParent(h, new IntPtr(parent));
      SetWindowPos(h, IntPtr.Zero, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0004 | 0x0010 | 0x0020);
    }
    return "ok";
  }
  [DllImport("gdi32.dll")] static extern IntPtr CreateRectRgn(int l, int t, int r, int b);
  [DllImport("gdi32.dll")] static extern int CombineRgn(IntPtr dst, IntPtr a, IntPtr b, int mode);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
  [DllImport("user32.dll")] static extern int SetWindowRgn(IntPtr h, IntPtr region, bool redraw);
  public static string Place(long hw, int x, int y, int w, int hh, string regions) {
    var h = new IntPtr(hw);
    if (!IsWindow(h)) return "gone";
    IntPtr region = CreateRectRgn(0, 0, w, hh);
    int index = 0;
    foreach (string part in regions.Split(';')) {
      string[] v = part.Split(',');
      if (v.Length != 4) continue;
      IntPtr cut = CreateRectRgn(int.Parse(v[0]), int.Parse(v[1]), int.Parse(v[2]), int.Parse(v[3]));
      CombineRgn(region, region, cut, index++ == 0 ? 1 : 4);
      DeleteObject(cut);
    }
    if (SetWindowRgn(h, region, true) == 0) DeleteObject(region);
    SetWindowPos(h, IntPtr.Zero, x, y, w, hh, 0x0040 | 0x0010);
    Wake(h);
    return "ok";
  }
  /* Out of sight without being hidden. A window hidden while it was still
     starting told its WebView2 it was not visible, and the page inside never
     came back (Luna Avatar stayed blank). Moved far outside the app's client
     area instead: clipped away, but as far as it knows, shown. */
  public static string Hide(long hw) {
    var h = new IntPtr(hw);
    if (IsWindow(h)) SetWindowPos(h, IntPtr.Zero, -32000, -32000, 0, 0, 0x0001 | 0x0004 | 0x0010 | 0x0040);
    return "ok";
  }
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc f, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  // A browser surface inside it that was left hidden is shown again.
  static void Wake(IntPtr h) {
    EnumChildWindows(h, (c, l) => {
      var cls = new StringBuilder(128); GetClassNameW(c, cls, 128);
      string n = cls.ToString();
      if (!IsWindowVisible(c) && (n.StartsWith("Chrome_WidgetWin") || n == "Chrome_RenderWidgetHostHWND" || n.Contains("WebView"))) ShowWindow(c, 8);
      return true;
    }, IntPtr.Zero);
  }
  public static string Focus(long hw) { var h = new IntPtr(hw); if (IsWindow(h)) SetFocus(h); return "ok"; }
  /* ---- Job objects: a run and everything it starts, as one thing ----
     Every process created inside a job stays in it, even when the process
     that started it exits (start.bat -> python -> pythonw). Terminating the
     job ends them all; and the job is set to kill-on-close, so if this
     helper -- or the app -- dies, nothing it ran is left behind. */
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr a, string n);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr j, int c, ref JOBX info, uint len);
  [DllImport("kernel32.dll")] static extern bool QueryInformationJobObject(IntPtr j, int c, ref JOBACC info, uint len, IntPtr ret);
  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr j, uint code);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint a, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr p, uint code);
  [StructLayout(LayoutKind.Sequential)] struct JOBB { public long a, b; public uint LimitFlags; public UIntPtr c, d; public uint e; public UIntPtr f; public uint g, h; }
  [StructLayout(LayoutKind.Sequential)] struct IOC { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] struct JOBX { public JOBB Basic; public IOC Io; public UIntPtr p1, p2, p3, p4; }
  [StructLayout(LayoutKind.Sequential)] struct JOBACC { public long a, b, c, d; public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses; }
  static Dictionary<uint, IntPtr> jobs = new Dictionary<uint, IntPtr>();
  public static string Job(uint pid) {
    IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
    if (job == IntPtr.Zero) return "!job";
    var info = new JOBX(); info.Basic.LimitFlags = 0x2000; // KILL_ON_JOB_CLOSE
    if (!SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(typeof(JOBX)))) { CloseHandle(job); return "!limits"; }
    IntPtr proc = OpenProcess(0x0100 | 0x0001, false, pid); // SET_QUOTA | TERMINATE
    if (proc == IntPtr.Zero || !AssignProcessToJobObject(job, proc)) { if (proc != IntPtr.Zero) CloseHandle(proc); CloseHandle(job); return "!assign"; }
    CloseHandle(proc);
    jobs[pid] = job;
    return "ok";
  }
  // How many of the run's processes are still alive.
  public static string Alive(uint pid) {
    IntPtr job; if (!jobs.TryGetValue(pid, out job)) return "-1";
    var acc = new JOBACC();
    if (!QueryInformationJobObject(job, 1, ref acc, (uint)Marshal.SizeOf(typeof(JOBACC)), IntPtr.Zero)) return "-1";
    return acc.ActiveProcesses.ToString();
  }
  // Keep the job handle until Windows confirms every member has exited.
  // Never terminate remembered PIDs: Windows can reuse them for unrelated apps.
  public static string Kill(uint pid, string extra) {
    IntPtr job;
    if (!jobs.TryGetValue(pid, out job)) return "!missing-job";
    if (!TerminateJobObject(job, 1)) return "!terminate";
    for (int i = 0; i < 100; i++) {
      if (Alive(pid) == "0") return "ok";
      System.Threading.Thread.Sleep(50);
    }
    return "!termination-timeout";
  }
  // Every process under root right now, to be remembered by the runner.
  public static string Pids(uint root) { var t = Tree(root); var l = new List<string>(); foreach (var x in t) l.Add(x.ToString()); return string.Join(",", l); }

  public static string Release(long hw) {
    var h = new IntPtr(hw);
    if (!IsWindow(h)) { saved.Remove(hw); return "gone"; }
    SetWindowRgn(h, IntPtr.Zero, true);
    // The style first: a window still marked WS_CHILD does not become top-level again.
    long style; if (saved.TryGetValue(hw, out style)) { SetWL(h, -16, new IntPtr(style)); saved.Remove(hw); }
    SetParent(h, IntPtr.Zero);
    SetWindowPos(h, IntPtr.Zero, 120, 120, 0, 0, 0x0001 | 0x0004 | 0x0020 | 0x0040);
    ShowWindow(h, 5); SetForegroundWindow(h);
    return "ok";
  }
}`;

const PS = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition (Get-Content -Raw -LiteralPath $args[0])
[Console]::Out.WriteLine('READY')
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $p = $line.Split(' ')
  try {
    switch ($p[1]) {
      'scan'    { $r = [RunnerWin]::Scan([uint32]$p[2], $(if ($p.Length -gt 3) { $p[3] } else { '' })) }
      'embed'   { $r = [RunnerWin]::Embed([long]$p[2], [long]$p[3]) }
      'place'   { $r = [RunnerWin]::Place([long]$p[2], [int]$p[3], [int]$p[4], [int]$p[5], [int]$p[6], $p[7]) }
      'hide'    { $r = [RunnerWin]::Hide([long]$p[2]) }
      'focus'   { $r = [RunnerWin]::Focus([long]$p[2]) }
      'release' { $r = [RunnerWin]::Release([long]$p[2]) }
      'job'     { $r = [RunnerWin]::Job([uint32]$p[2]) }
      'alive'   { $r = [RunnerWin]::Alive([uint32]$p[2]) }
      'kill'    { $r = [RunnerWin]::Kill([uint32]$p[2], $(if ($p.Length -gt 3) { $p[3] } else { '' })) }
      'pids'    { $r = [RunnerWin]::Pids([uint32]$p[2]) }
      default   { $r = '!unknown' }
    }
    [Console]::Out.WriteLine($p[0] + ' ' + $r)
  } catch { [Console]::Out.WriteLine($p[0] + ' !' + ($_.Exception.Message -replace '\\s+', ' ')) }
}
`;

/** The helper, started on first use. Every call resolves (with '' on failure). */
export function createWinEmbed() {
  if (process.platform !== 'win32') return null;
  let child = null, seq = 0, buffer = '', ready = null;
  const waiting = new Map();
  const start = () => {
    if (ready) return ready;
    const dir = path.join(os.tmpdir(), 'ollama-webui-runner');
    mkdirSync(dir, { recursive: true });
    const cs = path.join(dir, 'RunnerWin.cs'), ps = path.join(dir, 'winembed.ps1');
    writeFileSync(cs, CS); writeFileSync(ps, '﻿' + PS);
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps, cs], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    ready = new Promise((resolve) => {
      const fail = () => { resolve(false); for (const r of waiting.values()) r(''); waiting.clear(); child = null; ready = null; };
      child.on('error', fail);
      child.on('exit', fail);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (text) => {
        buffer += text;
        let i;
        while ((i = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, i).replace(/\r$/, ''); buffer = buffer.slice(i + 1);
          if (line === 'READY') { resolve(true); continue; }
          const sp = line.indexOf(' ');
          const id = line.slice(0, sp), value = line.slice(sp + 1);
          const r = waiting.get(id); if (r) { waiting.delete(id); r(value.startsWith('!') ? '' : value); }
        }
      });
      child.stderr.on('data', () => {});
    });
    return ready;
  };
  const call = async (...parts) => {
    if (!(await start()) || !child) return '';
    const id = String(++seq);
    return new Promise((resolve) => {
      waiting.set(id, resolve);
      child.stdin.write(`${id} ${parts.join(' ')}\n`);
      setTimeout(() => { if (waiting.delete(id)) resolve(''); }, 8000);
    });
  };
  return {
    /** [{ hwnd, pid, w, h, title }] for the tree under `pid`, plus `keep` still alive. */
    async scan(pid, keep = []) {
      const out = await call('scan', pid, keep.join(','));
      if (!out) return [];
      return out.split('\u001e').filter(Boolean).map((row) => {
        const [hwnd, wpid, w, h, ...title] = row.split('\t');
        return { hwnd: String(hwnd), pid: Number(wpid), w: Number(w), h: Number(h), title: title.join(' ').trim() };
      });
    },
    embed: (hwnd, parent) => call('embed', hwnd, parent),
    place: (hwnd, x, y, w, h, regions = `0,0,${w},${h}`) => call('place', hwnd, x, y, w, h, regions),
    hide: (hwnd) => call('hide', hwnd),
    focus: (hwnd) => call('focus', hwnd),
    release: (hwnd) => call('release', hwnd),
    /** Puts `pid` (and all it will start) in a kill-on-close job. */
    job: async (pid) => (await call('job', pid)) === 'ok',
    /** Live processes in the run's job; -1 when it has none. */
    alive: async (pid) => { const raw = await call('alive', pid); return /^\d+$/.test(raw) ? Number(raw) : -1; },
    /** Ends the job and every pid in `extra` that is still there. */
    kill: async (pid) => (await call('kill', pid)) === 'ok',
    /** The pids under `pid` right now. */
    pids: async (pid) => (await call('pids', pid)).split(',').filter(Boolean),
    warm: () => start(),
    close() { try { child?.kill(); } catch { /* gone */ } },
  };
}
