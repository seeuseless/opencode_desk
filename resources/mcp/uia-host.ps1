# UIA host: a long-lived PowerShell process that exposes the Windows UI Automation tree
# over stdin/stdout as one JSON object per line, so a plain text model can drive native
# desktop apps by element name instead of screenshots.
#
# Protocol
#   in : {"id":<any>,"method":"windows|tree|invoke|set_value|focus|focus_window|send_keys|paste|read_input|foreground|ping","params":{...}}
#   out: {"id":<any>,"ok":true|false,...}
#
# NOTE: this file MUST stay pure ASCII. Windows PowerShell 5.1 decodes a .ps1 without a BOM
# using the system ANSI code page, so any non-ASCII literal here would be mojibake.
# All user-facing Chinese lives in the Node shim (uia-mcp.mjs), never here.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Console I/O must be UTF-8: element names coming back from UIA are Chinese on this box,
# and text sent in (uia_set_text) can be Chinese too.
try {
  [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch {}

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class QnW32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  // Foreground stealing workarounds. A background process (this host runs as a child of the
  // kernel) has no foreground rights, so a plain SetForegroundWindow is often silently refused -
  // which is exactly how the agent ends up typing into the wrong window.
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool altTab);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  // Last-resort foreground grab: a real mouse click somewhere on the window. Windows grants
  // foreground rights to whoever owns the last input event, so clicking the window (we use its
  // title bar) is the one trick that always works, whereas the API calls above are best-effort.
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, IntPtr dwExtraInfo);
}
"@

# Native keyboard input (SendInput) + the self-window guard live in win-input.ps1 so that
# screen-mcp can drive the exact same code path. Dot-sourcing only defines functions - the
# one-shot runner inside it stays inert because QN_INPUT_B64 is not set here.
. (Join-Path $PSScriptRoot 'win-input.ps1')

$ctl = [System.Windows.Automation.TreeWalker]::ControlViewWalker

# ref -> AutomationElement for the most recent tree dump. Element references are only
# guaranteed for the dump they came from; a stale ref is answered with an explicit error
# so the model re-reads the tree instead of clicking blind.
$script:refs = @{}
$script:seq = 0

function Emit($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 8))
  [Console]::Out.Flush()
}

# UIA returns NaN/Infinity for the rect of minimized or Qt/custom-rendered windows.
# Round-tripping those into JSON would break the parser on the far side, so they become $null.
function NumOrNull($v) {
  $d = [double]$v
  if ([double]::IsNaN($d) -or [double]::IsInfinity($d)) { return $null }
  return [int]$d
}

function RectOf($el) {
  $r = $el.Current.BoundingRectangle
  return @{ x = (NumOrNull $r.X); y = (NumOrNull $r.Y); w = (NumOrNull $r.Width); h = (NumOrNull $r.Height) }
}

# UIA reports NativeWindowHandle as a signed 32-bit int; HWNDs are unsigned. Reinterpret
# through the unsigned range so high-bit handles do not come back negative and fail FromHandle.
function ToHwnd($v) {
  $u = ([int64]$v) -band 0xFFFFFFFF
  return [IntPtr][int64]$u
}

function ShortName($p) {
  try { return $p.ProgrammaticName -replace 'PatternIdentifiers\.Pattern$', '' } catch { return '' }
}

function Get-WindowList {
  $list = New-Object System.Collections.Generic.List[object]
  $fg = [int][QnW32]::GetForegroundWindow()
  $w = $null
  try { $w = $ctl.GetFirstChild([System.Windows.Automation.AutomationElement]::RootElement) } catch { return $list }
  while ($null -ne $w) {
    try {
      $c = $w.Current
      if ($c.Name -or $c.ClassName) {
        $pn = ''
        try { $pn = (Get-Process -Id $c.ProcessId -ErrorAction Stop).ProcessName } catch { $pn = '' }
        $list.Add(@{
          hwnd = [int]$c.NativeWindowHandle
          name = [string]$c.Name
          cls  = [string]$c.ClassName
          proc = [string]$pn
          pid  = [int]$c.ProcessId
          fg   = ([int]$c.NativeWindowHandle -eq $fg)
          # 最小化标记：min=true 的窗口依然"在运行"，uia_window_focus 会自动还原并提前台，
          # 千万不要因为它看不见就重启应用
          min  = [bool][QnW32]::IsIconic([IntPtr][int]$c.NativeWindowHandle)
          rect = (RectOf $w)
        })
      }
    } catch {}
    try { $w = $ctl.GetNextSibling($w) } catch { break }
  }
  return $list
}

function Get-WindowByMatch($needle) {
  if (-not $needle) { return $null }
  $n = ([string]$needle).Trim().ToLower()
  $exact = $null
  $partial = $null
  foreach ($w in Get-WindowList) {
    $nm = ([string]$w.name).ToLower()
    $pr = ([string]$w.proc).ToLower()
    if (-not $nm -and -not $pr) { continue }
    if ($nm -eq $n -or $pr -eq $n) { $exact = $w; break }
    if (-not $partial) {
      if (($nm -and $nm.Contains($n)) -or ($pr -and $pr.Contains($n))) { $partial = $w }
    }
  }
  if ($exact) { return $exact }
  return $partial
}

function Resolve-Target($params) {
  if ($null -ne $params -and $null -ne $params.hwnd -and [string]$params.hwnd -ne '') {
    return [System.Windows.Automation.AutomationElement]::FromHandle((ToHwnd $params.hwnd))
  }
  if ($null -ne $params -and $params.match) {
    $w = Get-WindowByMatch $params.match
    if ($null -eq $w) { return $null }
    return [System.Windows.Automation.AutomationElement]::FromHandle((ToHwnd $w.hwnd))
  }
  return [System.Windows.Automation.AutomationElement]::FromHandle([QnW32]::GetForegroundWindow())
}

# Breadth-first dump. Non-interactive containers are skipped in the output but still
# traversed, otherwise the useful leaves hiding under generic Panes would be lost.
function Dump-Tree($rootEl, $maxDepth, $maxNodes, $interactiveOnly) {
  $script:refs = @{}
  $script:seq = 0
  $out = New-Object System.Collections.Generic.List[object]
  $q = New-Object System.Collections.Queue
  $q.Enqueue(@($rootEl, 0))
  while ($q.Count -gt 0) {
    $it = $q.Dequeue()
    $nd = $it[0]
    $d = [int]$it[1]
    if ($d -ge $maxDepth) { continue }
    $ch = $null
    try { $ch = $ctl.GetFirstChild($nd) } catch { continue }
    while ($null -ne $ch) {
      if ($script:seq -ge $maxNodes) { return $out }
      try {
        $c = $ch.Current
        $pats = @()
        try { $pats = @($ch.GetSupportedPatterns() | ForEach-Object { ShortName $_ } | Where-Object { $_ }) } catch {}
        $nm = [string]$c.Name
        $named = ($nm -and $nm.Trim().Length -gt 0)
        $actable = ($pats -contains 'Invoke') -or ($pats -contains 'SelectionItem') -or
                   ($pats -contains 'Toggle') -or ($pats -contains 'ExpandCollapse') -or
                   ($pats -contains 'Value') -or ($pats -contains 'Text') -or ($pats -contains 'ScrollItem')
        $keep = (-not $interactiveOnly) -or ($named -and $actable)
        if ($keep) {
          $script:seq++
          $ref = $script:seq
          $script:refs[$ref] = $ch
          $out.Add(@{
            ref = $ref
            type = [string](($c.ControlType.ProgrammaticName) -replace '^ControlType\.', '')
            name = $nm
            aid = [string]$c.AutomationId
            cls = [string]$c.ClassName
            enabled = [bool]$c.IsEnabled
            offscreen = [bool]$c.IsOffscreen
            patterns = $pats
            rect = (RectOf $ch)
          })
        }
      } catch {}
      $q.Enqueue(@($ch, $d + 1))
      try { $ch = $ctl.GetNextSibling($ch) } catch { break }
    }
  }
  return $out
}

function Get-Ref($ref) {
  if ($null -eq $ref) { return $null }
  $k = [int]$ref
  if ($script:refs.ContainsKey($k)) { return $script:refs[$k] }
  return $null
}

function Focus-WindowOf($el) {
  try {
    $cur = $el
    for ($i = 0; $i -lt 12; $i++) {
      if ($null -eq $cur) { break }
      if ($cur.Current.ControlType.ProgrammaticName -eq 'ControlType.Window') {
        $h = ToHwnd $cur.Current.NativeWindowHandle
        if ([int]$h -ne 0) {
          [void][QnW32]::ShowWindow($h, 9)
          [void][QnW32]::SetForegroundWindow($h)
        }
        return
      }
      $cur = $ctl.GetParent($cur)
    }
  } catch {}
}

# Click strategy matches how a sighted user is emulated best-effort without pixels:
# prefer the semantic pattern (works on hidden/unfocused controls), fall back to a real
# mouse click at the element centre only when the control offers no pattern at all.
function Do-Invoke($ref) {
  $el = Get-Ref $ref
  if ($null -eq $el) { return @{ ok = $false; error = 'stale_ref' } }
  Focus-WindowOf $el
  try {
    $p = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $p.Invoke()
    return @{ ok = $true; via = 'Invoke' }
  } catch {}
  try {
    $p = $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
    $p.Select()
    return @{ ok = $true; via = 'SelectionItem' }
  } catch {}
  try {
    $p = $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
    $p.Toggle()
    return @{ ok = $true; via = 'Toggle' }
  } catch {}
  try {
    $p = $el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
    $p.Expand()
    return @{ ok = $true; via = 'ExpandCollapse' }
  } catch {}
  $r = $el.Current.BoundingRectangle
  $x = NumOrNull $r.X
  $y = NumOrNull $r.Y
  $w = NumOrNull $r.Width
  $h = NumOrNull $r.Height
  if ($null -eq $x -or $null -eq $y -or $null -eq $w -or $null -eq $h -or $w -le 0 -or $h -le 0) {
    return @{ ok = $false; error = 'no_pattern_no_geometry' }
  }
  $cx = [int]($x + $w / 2)
  $cy = [int]($y + $h / 2)
  # A minimized/background window reports its rect at a large negative virtual position.
  # Clicking there would land outside any screen and could hit something unintended.
  if ($cx -le 0 -or $cy -le 0) { return @{ ok = $false; error = 'offscreen_geometry' } }
  [void][QnW32]::SetCursorPos($cx, $cy)
  Start-Sleep -Milliseconds 60
  [QnW32]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
  [QnW32]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
  return @{ ok = $true; via = 'mouse'; x = $cx; y = $cy }
}

function Do-SetValue($ref, $text) {
  $el = Get-Ref $ref
  if ($null -eq $el) { return @{ ok = $false; error = 'stale_ref' } }
  Focus-WindowOf $el
  try { $el.SetFocus() } catch {}
  try {
    $p = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $p.SetValue([string]$text)
    return @{ ok = $true; via = 'Value' }
  } catch {}
  return @{ ok = $false; error = 'no_value_pattern' }
}

function Do-Focus($ref) {
  $el = Get-Ref $ref
  if ($null -eq $el) { return @{ ok = $false; error = 'stale_ref' } }
  Focus-WindowOf $el
  try {
    $el.SetFocus()
    return @{ ok = $true }
  } catch {
    return @{ ok = $false; error = 'focus_failed' }
  }
}

function Do-FocusWindow($params) {
  $w = $null
  if ($null -ne $params -and $null -ne $params.hwnd -and [string]$params.hwnd -ne '') {
    foreach ($x in Get-WindowList) {
      if ([int]$x.hwnd -eq [int]$params.hwnd) { $w = $x; break }
    }
  }
  if ($null -eq $w) { $w = Get-WindowByMatch ([string]$params.match) }
  if ($null -eq $w) { return @{ ok = $false; error = 'window_not_found' } }
  $h = ToHwnd $w.hwnd
  $target = [int]$w.hwnd
  [void][QnW32]::ShowWindow($h, 9)
  $sent = [QnW32]::SetForegroundWindow($h)
  Start-Sleep -Milliseconds 200
  $fg = [int][QnW32]::GetForegroundWindow()
  $via = 'SetForegroundWindow'
  if ($fg -ne $target) {
    # Round 1: join our input queue to the current foreground thread, then take the foreground.
    try {
      $fgThread = [QnW32]::GetWindowThreadProcessId([IntPtr]$fg, [IntPtr]::Zero)
      $me = [QnW32]::GetCurrentThreadId()
      [void][QnW32]::AttachThreadInput($me, $fgThread, $true)
      [void][QnW32]::BringWindowToTop($h)
      [void][QnW32]::SetForegroundWindow($h)
      [void][QnW32]::AttachThreadInput($me, $fgThread, $false)
    } catch {}
    Start-Sleep -Milliseconds 150
    $fg = [int][QnW32]::GetForegroundWindow()
    $via = 'AttachThreadInput'
  }
  if ($fg -ne $target) {
    # Round 2: minimize + restore resets the foreground ladder, then SwitchToThisWindow
    # (the API built for exactly this case) usually lands it.
    [void][QnW32]::ShowWindow($h, 6)
    Start-Sleep -Milliseconds 120
    [void][QnW32]::ShowWindow($h, 9)
    try { [QnW32]::SwitchToThisWindow($h, $true) } catch {}
    Start-Sleep -Milliseconds 250
    $fg = [int][QnW32]::GetForegroundWindow()
    $via = 'SwitchToThisWindow'
  }
  if ($fg -ne $target) {
    # Round 3: tap ALT first. Windows releases the foreground lock for a process that has just
    # received keyboard input, which makes the SetForegroundWindow that follows succeed.
    try {
      [QnW32]::keybd_event(0x12, 0, 0, [IntPtr]::Zero)
      [QnW32]::keybd_event(0x12, 0, 2, [IntPtr]::Zero)
      [void][QnW32]::SetForegroundWindow($h)
    } catch {}
    Start-Sleep -Milliseconds 200
    $fg = [int][QnW32]::GetForegroundWindow()
    $via = 'alt-key'
  }
  $clicked = $false
  if ($fg -ne $target) {
    # Round 4: click the window's title bar. Input events are what actually grant foreground
    # rights, so this almost always lands - and it beats making the model guess screen
    # coordinates (which is how it used to end up clicking random spots on the desktop).
    try {
      $r = New-Object QnW32+RECT
      if ([QnW32]::GetWindowRect($h, [ref]$r)) {
        if ($r.Right -gt $r.Left -and $r.Bottom -gt $r.Top) {
          $cx = [int](($r.Left + $r.Right) / 2)
          $cy = [int]$r.Top + 10
          if ($cx -gt 0 -and $cy -gt 0) {
            [void][QnW32]::SetCursorPos($cx, $cy)
            Start-Sleep -Milliseconds 60
            [QnW32]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
            [QnW32]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
            $clicked = $true
            Start-Sleep -Milliseconds 300
            $fg = [int][QnW32]::GetForegroundWindow()
            $via = 'titlebar-click'
          }
        }
      }
    } catch {}
  }
  return @{
    ok = $true
    name = [string]$w.name
    proc = [string]$w.proc
    hwnd = $target
    raised = $sent
    foreground = ($fg -eq $target)
    via = $via
    clicked = $clicked
  }
}

# ---------------------------------------------------------------- keyboard input
# Everything below routes through QnInput (SendInput) instead of the upstream nut-js path, which
# on Windows drops the modifier of a combination often enough that "ctrl+v" lands as a bare "v".
#
# Two gates protect every keystroke:
#   1) an optional target window (match / hwnd) is focused first, and if the foreground still is
#      not that window we refuse rather than type into whatever happens to be in front;
#   2) the foreground must not be one of our own windows (QN_SELF_PIDS / QN_SELF_HWNDS).
# Gate 2 exists because the agent's keystrokes used to end up in QingNiao's own composer while
# the user was reading the conversation.

function Resolve-InputTarget($params) {
  # returns @{ ok = $true; fg = <info> } or @{ ok = $false; ... } (refusal)
  if ($null -ne $params -and (($null -ne $params.match -and [string]$params.match -ne '') -or ($null -ne $params.hwnd -and [string]$params.hwnd -ne ''))) {
    $f = Do-FocusWindow $params
    if ($f.ok -eq $false) { return $f }
    if (-not $f.foreground) {
      return @{
        ok = $false
        error = 'focus_refused'
        name = [string]$f.name
        proc = [string]$f.proc
        hwnd = [int]$f.hwnd
        via = [string]$f.via
      }
    }
  }
  $guard = QnAssert-SafeForeground
  if ($null -ne $guard) { return $guard }
  return @{ ok = $true; fg = (QnGet-ForegroundInfo) }
}

function Do-SendKeys($params) {
  $keys = [string]$params.keys
  if (-not $keys) { return @{ ok = $false; error = 'missing_keys' } }
  $t = Resolve-InputTarget $params
  if ($t.ok -eq $false) { return $t }
  try {
    [QnInput]::SendCombo($keys)
  } catch {
    return @{ ok = $false; error = 'send_failed'; message = $_.Exception.Message }
  }
  $fg = QnGet-ForegroundInfo
  return @{ ok = $true; keys = $keys; fg_title = [string]$fg.title; fg_proc = [string]$fg.proc }
}

function Do-Paste($params) {
  $t = Resolve-InputTarget $params
  if ($t.ok -eq $false) { return $t }
  $enter = $true
  if ($null -ne $params -and $null -ne $params.enter) { $enter = [bool]$params.enter }
  try {
    # Select-all first, then paste: pasting into a field that already holds something (a leftover
    # draft, a previous search query, the model's own earlier attempt) would otherwise APPEND to it
    # and send a mix of old + new. Ctrl+A makes the paste a replace, so this step is idempotent -
    # that is the "the content was wrong and it just sent it anyway" complaint.
    [QnInput]::SendCombo('ctrl+a')
    Start-Sleep -Milliseconds 90
    [QnInput]::SendCombo('ctrl+v')
    # Give the app time to ingest the clipboard before the send key arrives; a real paste in
    # a self-drawn IM window is not instantaneous.
    Start-Sleep -Milliseconds 220
    if ($enter) {
      [QnInput]::SendCombo('return')
      Start-Sleep -Milliseconds 120
    }
  } catch {
    return @{ ok = $false; error = 'send_failed'; message = $_.Exception.Message }
  }
  $fg = QnGet-ForegroundInfo
  return @{ ok = $true; pasted = $true; entered = $enter; fg_title = [string]$fg.title; fg_proc = [string]$fg.proc }
}

function Do-ReadInput($params) {
  # Select-all + copy pushes the control's current text through the system clipboard, which works
  # even in a self-drawn UI where the accessibility tree is empty. This is the only way for the
  # agent to verify what it actually typed/pasted before committing to send.
  $t = Resolve-InputTarget $params
  if ($t.ok -eq $false) { return $t }
  try {
    [QnInput]::SendCombo('ctrl+a')
    Start-Sleep -Milliseconds 130
    [QnInput]::SendCombo('ctrl+c')
    Start-Sleep -Milliseconds 220
    # Collapse the selection again, otherwise the next keystroke would wipe the field.
    [QnInput]::SendCombo('right')
    Start-Sleep -Milliseconds 60
  } catch {
    return @{ ok = $false; error = 'send_failed'; message = $_.Exception.Message }
  }
  $text = QnGet-ClipboardText
  return @{ ok = $true; text = $text; length = $text.Length }
}

# ---------------------------------------------------------------- main loop
while ($true) {
  $line = $null
  try { $line = [Console]::In.ReadLine() } catch { break }
  if ($null -eq $line) { break }
  if (-not $line.Trim()) { continue }

  $req = $null
  try { $req = $line | ConvertFrom-Json } catch { continue }
  if ($null -eq $req) { continue }

  $id = $req.id
  $method = [string]$req.method
  $params = $req.params
  $res = $null

  try {
    switch ($method) {
      'ping' { $res = @{ ok = $true; host = 'qn-uia'; ps = $PSVersionTable.PSVersion.ToString() } }
      'windows' { $res = @{ ok = $true; windows = @(Get-WindowList) } }
      'tree' {
        $depth = 6
        $max = 120
        $interactiveOnly = $true
        if ($null -ne $params) {
          if ($null -ne $params.depth -and [string]$params.depth -ne '') { $depth = [int]$params.depth }
          if ($null -ne $params.max -and [string]$params.max -ne '') { $max = [int]$params.max }
          if ($null -ne $params.interactiveOnly) { $interactiveOnly = [bool]$params.interactiveOnly }
        }
        $target = Resolve-Target $params
        if ($null -eq $target) { $res = @{ ok = $false; error = 'window_not_found' } }
        else {
          $c = $target.Current
          $nodes = @(Dump-Tree $target $depth $max $interactiveOnly)
          $res = @{
            ok = $true
            window = @{
              name = [string]$c.Name
              cls = [string]$c.ClassName
              pid = [int]$c.ProcessId
              hwnd = [int]$c.NativeWindowHandle
            }
            truncated = ($script:seq -ge $max)
            count = $nodes.Count
            elements = $nodes
          }
        }
      }
      'invoke' { $res = Do-Invoke $params.ref }
      'set_value' { $res = Do-SetValue $params.ref ([string]$params.text) }
      'focus' { $res = Do-Focus $params.ref }
      'focus_window' { $res = Do-FocusWindow $params }
      'send_keys' { $res = Do-SendKeys $params }
      'paste' { $res = Do-Paste $params }
      'read_input' { $res = Do-ReadInput $params }
      'foreground' { $res = QnGet-ForegroundInfo }
      default { $res = @{ ok = $false; error = 'unknown_method' } }
    }
  } catch {
    $res = @{ ok = $false; error = 'exception'; message = $_.Exception.Message }
  }

  if ($null -eq $res) { $res = @{ ok = $false; error = 'no_result' } }
  if ($null -ne $id) { $res.id = $id }
  Emit $res
}
