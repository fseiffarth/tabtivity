param([string]$Event = '')
# @DISPLAY@: the turn of the Copilot session a tab is in - see the POSIX twin.
# Managed by @DISPLAY@; do not edit. Prints nothing, always exits 0.
$dir = @LIVE_DIR@
if ($env:@ENV@TAB_AGENT -ne 'copilot') { exit 0 }
if ($env:COPILOT_AGENT_SESSION_ID) { exit 0 }
$uuid = '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'
$uid = $env:@ENV@TAB_UID
if ($uid -notmatch $uuid) { exit 0 }
$payload = [Console]::In.ReadToEnd()
$m = [regex]::Match($payload, '"sessionId"\s*:\s*"([^"\\]*)"')
if (-not $m.Success) { exit 0 }
$own = ''
try {
  $rec = Get-Item -LiteralPath (Join-Path $dir $uid) -ErrorAction Stop
  if (-not $rec.PSIsContainer -and $rec.Length -le 256 -and -not ($rec.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    $own = ([IO.File]::ReadAllText($rec.FullName)).Trim()
  }
} catch { }
if ($own -notmatch $uuid) { $own = $uid }
if ($m.Groups[1].Value -ne $own) { exit 0 }
$turn = ''
switch ($Event) {
  { $_ -in 'userPromptSubmitted', 'postToolUse', 'postToolUseFailure' } { $turn = 'working' }
  'notification' { if ($payload -match '"notification_type"\s*:\s*"(permission_prompt|elicitation_dialog)"') { $turn = 'decision' } }
  'agentStop' { $turn = 'done' }
  'errorOccurred' { if ($payload -match '"errorContext"\s*:\s*"model_call"') { $turn = 'done' } }
  'sessionEnd' { $turn = 'idle' }
}
if ($turn -eq '') { exit 0 }
try {
  [void](New-Item -ItemType Directory -Force -Path $dir -ErrorAction Stop)
  $tmp = Join-Path $dir ('.' + $uid + '.copilot-turn.' + $PID)
  [IO.File]::WriteAllText($tmp, ($turn + ' ' + [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()))
  Move-Item -Force -LiteralPath $tmp -Destination (Join-Path $dir ($uid + '.turn'))
} catch { }
exit 0
