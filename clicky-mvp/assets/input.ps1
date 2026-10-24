param(
  [string]$Action = 'move',
  [double]$X = -1,
  [double]$Y = -1,
  [string]$Name = '',
  [int]$Steps = 22,
  [int]$DelayMs = 6,
  [string]$Key = '',
  [switch]$Server
)

# Real Windows input with NO clipboard and NO external deps:
#   move / click / doubleclick  -> animate the OS cursor to (X,Y) then click
#   findName   -> UIA: report the clickable point of a control by name (no click)
#   clickName  -> UIA: find a control by name, glide the real cursor to it, click
#   typeName   -> UIA: focus a control by name, then type text into it
#   type       -> type text into the focused control (SendKeys, escaped)
#   key        -> SendKeys sequence (e.g. "{Enter}", "^s")
#   readValue  -> UIA: read the focused control's current text (for verify-after-act)
# Typing uses SendKeys (real VK key events -> proven to land in Word/apps) with
# the special chars escaped, so we never touch the clipboard (which antivirus
# flagged) and never rely on KEYEVENTF_UNICODE (which some apps drop silently).
# Coordinates are physical pixels.
#
# Two modes:
#   * one-shot (default): run a single action from the args, print one result, exit.
#   * -Server : stay alive and read ONE JSON command per stdin line, printing one
#     result line per command. This removes the ~400ms PowerShell cold-start + the
#     UIAutomation assembly load from every action (the biggest remaining latency).
# Result tokens (shared): "found <x> <y>" | "found" | "notfound" | "ok" | "value <text>" | "noread" | "err <msg>".

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase

if (-not ('ClickyIn' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ClickyIn {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
'@
}
[void][ClickyIn]::SetProcessDPIAware()

# Steps / DelayMs are script-scoped so the server can vary them per command.
$script:Steps = $Steps
$script:DelayMs = $DelayMs

function MoveTo([int]$tx, [int]$ty) {
  $start = [System.Windows.Forms.Cursor]::Position
  $sx = [int]$start.X; $sy = [int]$start.Y
  $n = [Math]::Max(1, $script:Steps)
  for ($i = 1; $i -le $n; $i++) {
    $f = $i / $n
    $cx = [int]($sx + ($tx - $sx) * $f)
    $cy = [int]($sy + ($ty - $sy) * $f)
    [void][ClickyIn]::SetCursorPos($cx, $cy)
    if ($script:DelayMs -gt 0) { Start-Sleep -Milliseconds $script:DelayMs }
  }
  [void][ClickyIn]::SetCursorPos($tx, $ty)
}

function LeftClick([bool]$double) {
  $LD = [uint32]0x02; $LU = [uint32]0x04; $Z = [uint32]0; $UP = [UIntPtr]::Zero
  [ClickyIn]::mouse_event($LD, $Z, $Z, $Z, $UP)
  [ClickyIn]::mouse_event($LU, $Z, $Z, $Z, $UP)
  if ($double) {
    Start-Sleep -Milliseconds 80
    [ClickyIn]::mouse_event($LD, $Z, $Z, $Z, $UP)
    [ClickyIn]::mouse_event($LU, $Z, $Z, $Z, $UP)
  }
}

# Escape SendKeys metacharacters so arbitrary text (essays, emails) types literally.
function ConvertTo-SendKeys([string]$s) {
  if ([string]::IsNullOrEmpty($s)) { return '' }
  $sb = New-Object System.Text.StringBuilder
  foreach ($ch in $s.ToCharArray()) {
    switch ($ch) {
      '+' { [void]$sb.Append('{+}') }
      '^' { [void]$sb.Append('{^}') }
      '%' { [void]$sb.Append('{%}') }
      '~' { [void]$sb.Append('{~}') }
      '(' { [void]$sb.Append('{(}') }
      ')' { [void]$sb.Append('{)}') }
      '{' { [void]$sb.Append('{{}') }
      '}' { [void]$sb.Append('{}}') }
      '[' { [void]$sb.Append('{[}') }
      ']' { [void]$sb.Append('{]}') }
      "`n" { [void]$sb.Append('{ENTER}') }
      "`r" { }
      "`t" { [void]$sb.Append('{TAB}') }
      default { [void]$sb.Append($ch) }
    }
  }
  return $sb.ToString()
}

function Send-Text([string]$t) {
  if ([string]::IsNullOrEmpty($t)) { return }
  # Send in chunks so very long text stays responsive and never overflows.
  $chunk = 240
  for ($i = 0; $i -lt $t.Length; $i += $chunk) {
    $len = [Math]::Min($chunk, $t.Length - $i)
    $part = $t.Substring($i, $len)
    [System.Windows.Forms.SendKeys]::SendWait((ConvertTo-SendKeys $part))
    Start-Sleep -Milliseconds 15
  }
}

function Find-ByName([string]$name) {
  if (-not $name) { return $null }
  $AE = [System.Windows.Automation.AutomationElement]
  $scope = $null
  try { $scope = $AE::FromHandle([ClickyIn]::GetForegroundWindow()) } catch {}
  if (-not $scope) { $scope = $AE::RootElement }
  try {
    $cond = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $name)
    $e = $scope.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
    if ($e) { return $e }
  } catch {}
  $want = $name.ToLower()
  $best = $null
  try {
    $all = $scope.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($e in $all) {
      $n = $null
      try { $n = $e.Current.Name } catch { continue }
      if (-not $n) { continue }
      $ln = $n.ToLower()
      if ($ln -eq $want) { return $e }
      if (-not $best -and $ln.Contains($want)) { $best = $e }
    }
  } catch {}
  return $best
}

function Get-ClickPoint($e) {
  try {
    $p = $e.GetClickablePoint()
    if (-not [double]::IsNaN($p.X) -and -not [double]::IsNaN($p.Y)) { return @([int]$p.X, [int]$p.Y) }
  } catch {}
  try {
    $r = $e.Current.BoundingRectangle
    if ($r -and $r.Width -gt 0 -and $r.Height -gt 0) { return @([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2)) }
  } catch {}
  return $null
}

# Perform one action and return its result token (no writing here, so both the
# one-shot and the server can decide how to emit).
function Invoke-Action($a, [double]$x, [double]$y, [string]$name, [string]$key, [string]$text) {
  switch ($a) {
    'move' { if ($x -ge 0) { MoveTo ([int]$x) ([int]$y) }; return 'ok' }
    'click' { if ($x -ge 0) { MoveTo ([int]$x) ([int]$y); Start-Sleep -Milliseconds 90 }; LeftClick $false; return 'ok' }
    'doubleclick' { if ($x -ge 0) { MoveTo ([int]$x) ([int]$y); Start-Sleep -Milliseconds 90 }; LeftClick $true; return 'ok' }

    'findName' {
      $e = Find-ByName $name
      $pt = if ($e) { Get-ClickPoint $e } else { $null }
      if ($pt) { return ("found {0} {1}" -f $pt[0], $pt[1]) } else { return 'notfound' }
    }
    'clickName' {
      $e = Find-ByName $name
      $pt = if ($e) { Get-ClickPoint $e } else { $null }
      if ($e -and $pt) {
        MoveTo $pt[0] $pt[1]
        Start-Sleep -Milliseconds 80
        # Prefer the UIA Invoke pattern (instant, coordinate-free). Fall back to a real click.
        $done = $false
        try {
          $pat = $null
          if ($e.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pat)) { $pat.Invoke(); $done = $true }
        } catch {}
        if (-not $done) { LeftClick $false }
        return ("found {0} {1}" -f $pt[0], $pt[1])
      } else { return 'notfound' }
    }
    'typeName' {
      $e = Find-ByName $name
      if ($e) {
        $pt = Get-ClickPoint $e
        if ($pt) { MoveTo $pt[0] $pt[1]; Start-Sleep -Milliseconds 60 }  # visible glide
        $t = if ($text) { $text } else { '' }
        # Prefer the UIA Value pattern (set the field directly). Fall back to focus + SendKeys.
        $done = $false
        try {
          $vp = $null
          if ($t -and $e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { $vp.SetValue($t); $done = $true }
        } catch {}
        if (-not $done) {
          try {
            $h = [IntPtr]$e.Current.NativeWindowHandle
            if ($h -ne [IntPtr]::Zero) { [void][ClickyIn]::SetForegroundWindow($h) }
          } catch {}
          try { $e.SetFocus() } catch {}
          Start-Sleep -Milliseconds 150
          Send-Text $t
        }
        return 'found'
      } else { return 'notfound' }
    }
    'type' { Send-Text $text; return 'ok' }
    'key' { if ($key) { [System.Windows.Forms.SendKeys]::SendWait($key) }; return 'ok' }
    'readValue' {
      # Read the currently focused element's text so the caller can confirm typed
      # text actually landed. Return 'value <text>' ONLY when a real Value/Text
      # pattern exists (native fields). If neither pattern is present (web content,
      # custom controls where UIA is blind) return 'noread' so the caller skips the
      # check instead of falsely treating an unreadable field as empty.
      $AE = [System.Windows.Automation.AutomationElement]
      $e = $null
      try { $e = $AE::FocusedElement } catch {}
      if (-not $e) { try { $e = $AE::FromHandle([ClickyIn]::GetForegroundWindow()) } catch {} }
      if (-not $e) { return 'noread' }
      $val = $null
      try {
        $vp = $null
        if ($e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { $val = [string]$vp.Current.Value }
      } catch {}
      if ($null -eq $val) {
        try {
          $tp = $null
          if ($e.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) { $val = [string]$tp.DocumentRange.GetText(200) }
        } catch {}
      }
      if ($null -eq $val) { return 'noread' }
      $clean = ($val -replace '[\r\n\t]+', ' ')
      $clean = ($clean -replace '\s+', ' ')
      if ($clean.Length -gt 200) { $clean = $clean.Substring(0, 200) }
      return ('value ' + $clean)
    }
    default { return 'ok' }
  }
}

if ($Server) {
  $reader = [Console]::In
  while ($true) {
    $line = $reader.ReadLine()
    if ($null -eq $line) { break }        # stdin closed -> parent exited
    $line = $line.Trim()
    if (-not $line) { continue }
    try {
      $c = $line | ConvertFrom-Json
      $script:Steps = if ($c.steps) { [int]$c.steps } else { 22 }
      $script:DelayMs = if ($c.delayMs) { [int]$c.delayMs } else { 6 }
      $out = Invoke-Action $c.action ([double]$c.x) ([double]$c.y) ([string]$c.name) ([string]$c.key) ([string]$c.text)
    } catch {
      $out = 'err ' + ($_.Exception.Message -replace '\s+', ' ')
    }
    [Console]::Out.WriteLine($out)
    [Console]::Out.Flush()
  }
  exit 0
}

# --- one-shot mode (backward compatible) ---
$oneText = if ($env:CLICKY_TEXT) { $env:CLICKY_TEXT } else { '' }
$result = Invoke-Action $Action $X $Y $Name $Key $oneText
Write-Output $result
