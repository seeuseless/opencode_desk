# Native keyboard input for the desktop-control stack (shared by uia-host.ps1 and screen-mcp).
# MUST stay pure ASCII: Windows PowerShell 5.1 decodes a BOM-less .ps1 with the system ANSI
# code page, so any non-ASCII literal here would be mojibake. All Chinese lives in the Node shims.
#
# Why this file exists
# --------------------
# The upstream computer-use-mcp maps `{"action":"key","text":"ctrl+v"}` to
#   toKeys("ctrl+v") -> [Key.LeftControl, Key.V] -> keyboard.pressKey(LeftControl, V)
# and on Windows the modifier regularly fails to register, so the focused app receives a bare
# "v" / "f" keystroke. That is exactly the reported bug ("the paste sent a lone F"): the paste
# silently degraded into typing one character, and nothing in the stack noticed.
#
# SendInput with an explicit batch (all modifiers down -> main key down, commit; main key up ->
# modifiers up, commit) is deterministic and also stays correct when the target window belongs
# to an elevated process.
#
# Two ways to use this file
# -------------------------
#   1) dot-source it from the long-lived UIA host  -> you get the Qn* functions, nothing runs
#   2) run it standalone with QN_INPUT_B64 set     -> performs one action and prints one JSON line
#      payload: {"mode":"keys","keys":"ctrl+v"} | {"mode":"read"} | {"mode":"foreground"}

$ErrorActionPreference = 'Stop'

# stdout carries Chinese (window titles, clipboard text) and is read by a Node process that
# decodes UTF-8. Without this, the one-shot runner answers in the system ANSI code page and
# every CJK string comes back as mojibake. The UIA host does the same on its own side.
try {
  [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch {}

if (-not ('QnInput' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class QnInput
{
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public INPUTUNION u; }

    const uint INPUT_KEYBOARD = 1;
    const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    const uint KEYEVENTF_KEYUP = 0x0002;

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    // Keys that need the extended-key flag, otherwise some apps never see them
    // (arrows, navigation cluster, Win key, right-hand modifiers).
    static readonly HashSet<ushort> Extended = new HashSet<ushort> {
        0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28,
        0x2D, 0x2E, 0x5B, 0x5C, 0x6F, 0xA3, 0xA5
    };

    static bool IsModifier(ushort vk)
    {
        return vk == 0x10 || vk == 0x11 || vk == 0x12 || vk == 0x5B || vk == 0x5C ||
               vk == 0xA0 || vk == 0xA1 || vk == 0xA2 || vk == 0xA3 || vk == 0xA4 || vk == 0xA5;
    }

    public static ushort ToVk(string raw)
    {
        string k = raw.Trim().ToLowerInvariant();
        if (k.Length == 1)
        {
            char c = k[0];
            if (c >= 'a' && c <= 'z') return (ushort)(0x41 + (c - 'a'));
            if (c >= '0' && c <= '9') return (ushort)(0x30 + (c - '0'));
        }
        if (k.Length >= 2 && k[0] == 'f')
        {
            int n;
            if (int.TryParse(k.Substring(1), out n) && n >= 1 && n <= 24) return (ushort)(0x70 + n - 1);
        }
        switch (k)
        {
            case "ctrl": case "control": return 0x11;
            case "shift": return 0x10;
            case "alt": case "menu": return 0x12;
            case "win": case "lwin": case "meta": case "super": case "cmd": return 0x5B;
            case "rwin": return 0x5C;
            case "enter": case "return": return 0x0D;
            case "esc": case "escape": return 0x1B;
            case "tab": return 0x09;
            case "space": case "spacebar": return 0x20;
            case "backspace": case "bksp": case "back": return 0x08;
            case "delete": case "del": return 0x2E;
            case "insert": case "ins": return 0x2D;
            case "home": return 0x24;
            case "end": return 0x23;
            case "pageup": case "pgup": case "prior": return 0x21;
            case "pagedown": case "pgdn": case "next": return 0x22;
            case "up": case "arrowup": return 0x26;
            case "down": case "arrowdown": return 0x28;
            case "left": case "arrowleft": return 0x25;
            case "right": case "arrowright": return 0x27;
            case "clear": return 0x0C;
            case "pause": return 0x13;
            case "capslock": case "caps": return 0x14;
            case "numlock": case "num": return 0x90;
            case "scrolllock": case "scroll": return 0x91;
            case "printscreen": case "prtsc": return 0x2C;
            case "apps": return 0x5D;
            case "minus": case "-": return 0xBD;
            case "equal": case "=": return 0xBB;
            case "comma": case ",": return 0xBC;
            case "period": case ".": return 0xBE;
            case "slash": case "/": return 0xBF;
            case "semicolon": case ";": return 0xBA;
            case "quote": case "'": return 0xDE;
            case "grave": case "`": return 0xC0;
            case "backslash": case "\\": return 0xDC;
            case "leftbracket": case "[": return 0xDB;
            case "rightbracket": case "]": return 0xDD;
        }
        return 0;
    }

    static INPUT MakeKey(ushort vk, bool up)
    {
        KEYBDINPUT k = new KEYBDINPUT();
        k.wVk = vk;
        k.wScan = 0;
        uint f = 0;
        if (up) f |= KEYEVENTF_KEYUP;
        if (Extended.Contains(vk)) f |= KEYEVENTF_EXTENDEDKEY;
        k.dwFlags = f;
        k.time = 0;
        k.dwExtraInfo = IntPtr.Zero;
        INPUTUNION un = new INPUTUNION();
        un.ki = k;
        INPUT i = new INPUT();
        i.type = INPUT_KEYBOARD;
        i.u = un;
        return i;
    }

    static void Submit(INPUT[] arr)
    {
        int size = Marshal.SizeOf(typeof(INPUT));
        uint sent = SendInput((uint)arr.Length, arr, size);
        if (sent != (uint)arr.Length)
        {
            int err = Marshal.GetLastWin32Error();
            // 0 here means the input was swallowed by UIPI (the focused window belongs to an
            // elevated process). Surface it instead of pretending the keystroke landed.
            throw new InvalidOperationException("SendInput delivered " + sent + "/" + arr.Length + " events (win32=" + err + ")");
        }
    }

    /// Press a key combination, e.g. "ctrl+v", "ctrl+shift+a", "return", "f24".
    /// Modifiers are held down for the whole combination and released afterwards, in reverse.
    public static void SendCombo(string combo)
    {
        string[] parts = combo.Split('+');
        List<ushort> keys = new List<ushort>();
        foreach (string p in parts)
        {
            string s = p.Trim();
            if (s.Length == 0) continue;
            ushort vk = ToVk(s);
            if (vk == 0) throw new InvalidOperationException("unknown_key:" + s);
            keys.Add(vk);
        }
        if (keys.Count == 0) throw new InvalidOperationException("empty_keys");

        List<ushort> mods = new List<ushort>();
        ushort main = 0;
        for (int i = 0; i < keys.Count; i++)
        {
            if (IsModifier(keys[i]) && i < keys.Count - 1) mods.Add(keys[i]);
            else main = keys[i];
        }

        List<INPUT> down = new List<INPUT>();
        foreach (ushort m in mods) down.Add(MakeKey(m, false));
        down.Add(MakeKey(main, false));
        Submit(down.ToArray());

        // A short hold makes the combination land even in apps that poll the keyboard state
        // (Qt self-drawn UIs such as WeChat 4.x are the ones that used to miss it).
        System.Threading.Thread.Sleep(30);

        List<INPUT> up = new List<INPUT>();
        up.Add(MakeKey(main, true));
        for (int m = mods.Count - 1; m >= 0; m--) up.Add(MakeKey(mods[m], true));
        Submit(up.ToArray());
    }

    public static string WindowTitle(IntPtr h)
    {
        int len = GetWindowTextLength(h);
        if (len <= 0) return "";
        StringBuilder sb = new StringBuilder(len + 2);
        GetWindowText(h, sb, sb.Capacity);
        return sb.ToString();
    }

    public static IntPtr Foreground()
    {
        return GetForegroundWindow();
    }
}
'@
}

# ---------------------------------------------------------------------------- self-window guard
# The main process injects its own pid / hwnd / window-title prefix here. Anything typed while one
# of those windows is focused lands in QingNiao's own composer - the user watches their prompt box
# get hijacked by the agent's keystrokes. So every input is gated on "is the foreground one of ours?".
#
# Three overlapping judgements on purpose. The pid list is the precise one, but on Windows an
# Electron top-level window does not always report the browser-process pid (renderer-owned and
# additional windows show up under a different pid), so the title prefix is the backstop that
# covers every window the app will ever open - including ones created after this env was written.
$script:qnnSelf = $null

function QnGet-SelfRefs {
  if ($null -ne $script:qnnSelf) { return $script:qnnSelf }
  $pids = New-Object System.Collections.Generic.List[int]
  $hwnds = New-Object System.Collections.Generic.List[int]
  $titles = New-Object System.Collections.Generic.List[string]
  if ($env:QN_SELF_PIDS) {
    foreach ($x in ([string]$env:QN_SELF_PIDS).Split(',')) {
      $t = $x.Trim()
      if ($t) { try { [void]$pids.Add([int]$t) } catch {} }
    }
  }
  if ($env:QN_SELF_HWNDS) {
    foreach ($x in ([string]$env:QN_SELF_HWNDS).Split(',')) {
      $t = $x.Trim()
      if ($t) { try { [void]$hwnds.Add([int]$t) } catch {} }
    }
  }
  if ($env:QN_SELF_TITLES) {
    foreach ($x in ([string]$env:QN_SELF_TITLES).Split(',')) {
      $t = $x.Trim()
      if ($t) { [void]$titles.Add($t) }
    }
  }
  $script:qnnSelf = @{ pids = $pids; hwnds = $hwnds; titles = $titles }
  return $script:qnnSelf
}

function QnGet-ForegroundInfo {
  $h = [QnInput]::Foreground()
  $hv = [int64]$h
  $title = ''
  $pn = ''
  $procId = 0
  if ($hv -ne 0) {
    try { $title = [QnInput]::WindowTitle($h) } catch { $title = '' }
    try { $tid = [QnInput]::GetWindowThreadProcessId($h, [ref]$procId) } catch { $procId = 0 }
    if ($procId -gt 0) {
      # .NET instead of Get-Process: the cmdlet's first call pulls in the Management module and
      # dumps a CLIXML "preparing modules for first use" record onto stderr.
      try { $pn = [System.Diagnostics.Process]::GetProcessById($procId).ProcessName } catch { $pn = '' }
    }
  }
  $self = $false
  $r = QnGet-SelfRefs
  if ($procId -gt 0 -and $r.pids.Contains([int]$procId)) { $self = $true }
  if ($hv -ne 0 -and $r.hwnds.Contains([int]$hv)) { $self = $true }
  if (-not $self -and $title) {
    foreach ($p in $r.titles) {
      # -like is case-insensitive for strings in PowerShell; a 'prefix*' match also covers the
      # "Main Title - session name" variants the renderer sets on the fly.
      if ($title -like "$p*") { $self = $true; break }
    }
  }
  return @{
    ok = $true
    hwnd = [int]$hv
    pid = [int]$procId
    proc = [string]$pn
    title = [string]$title
    self = $self
  }
}

# Returns $null when it is safe to type, or a structured refusal when the focused window is ours.
function QnAssert-SafeForeground {
  $fg = QnGet-ForegroundInfo
  if ($fg.self) {
    return @{
      ok = $false
      error = 'self_window'
      blocked = $true
      title = $fg.title
      proc = $fg.proc
      pid = $fg.pid
    }
  }
  return $null
}

function QnGet-ClipboardText {
  # Get-Clipboard needs an STA thread; powershell.exe is STA by default, but a host started with
  # -MTA would throw here, so fall back to a one-shot STA child rather than failing the call.
  try {
    $t = Get-Clipboard -Raw -ErrorAction Stop
    if ($null -eq $t) { return '' }
    return [string]$t
  } catch {
    try {
      $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes('Get-Clipboard -Raw'))
      $out = & powershell.exe -NoProfile -NonInteractive -STA -EncodedCommand $enc 2>$null
      if ($null -eq $out) { return '' }
      return ([string]::Join("`n", @($out)))
    } catch {
      return ''
    }
  }
}

# ---------------------------------------------------------------------------- one-shot runner
# Called by screen-mcp (which is a Node process and cannot dot-source PowerShell).
function QnInvoke-Once($payload) {
  $mode = [string]$payload.mode
  if ($mode -eq 'foreground') {
    return (QnGet-ForegroundInfo)
  }
  if ($mode -eq 'read') {
    $t = QnGet-ClipboardText
    return @{ ok = $true; mode = 'read'; text = $t; length = $t.Length }
  }
  if ($mode -eq 'keys') {
    $guard = QnAssert-SafeForeground
    if ($null -ne $guard) { return $guard }
    $keys = [string]$payload.keys
    if (-not $keys) { return @{ ok = $false; error = 'missing_keys' } }
    [QnInput]::SendCombo($keys)
    return @{ ok = $true; mode = 'keys'; keys = $keys }
  }
  return @{ ok = $false; error = 'unknown_mode' }
}

if ($env:QN_INPUT_B64) {
  $res = $null
  try {
    $j = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:QN_INPUT_B64)) | ConvertFrom-Json
    $res = QnInvoke-Once $j
  } catch {
    $res = @{ ok = $false; error = 'exception'; message = $_.Exception.Message }
  }
  if ($null -eq $res) { $res = @{ ok = $false; error = 'no_result' } }
  [Console]::Out.WriteLine(($res | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
  exit 0
}
