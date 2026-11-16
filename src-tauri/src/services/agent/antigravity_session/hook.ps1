# @DISPLAY@: records which Antigravity conversation this tab is in - see the
# POSIX twin (hook.sh) for the rule. Managed by @DISPLAY@; do not edit.
$dir = @LIVE_DIR@
$proof = @PROOF@
if ($env:@ENV@TAB_AGENT -ne 'agy' -or $env:ANTIGRAVITY_AGENT) { exit 0 }
$uuid = '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'
$uid = [string]$env:@ENV@TAB_UID
if ($uid -notmatch $uuid) { exit 0 }
try { $call = [Console]::In.ReadToEnd() | ConvertFrom-Json } catch { exit 0 }
if ($null -eq $call) { exit 0 }
if ($call.PSObject.Properties['lastUserInput'] -and [string]$call.lastUserInput -eq '') { exit 0 }
if ([string]$call.parentConversationId -ne '') { exit 0 }
$id = [string]$call.conversationId
if ($id -notmatch $uuid) { exit 0 }
try {
  [void](New-Item -ItemType Directory -Force -Path $dir -ErrorAction Stop)
  $p = Join-Path $dir $proof
  if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { [IO.File]::WriteAllText($p, '') }
  $tmp = Join-Path $dir ".$uid.agy.$PID"
  [IO.File]::WriteAllText($tmp, $id)
  Move-Item -LiteralPath $tmp -Destination (Join-Path $dir $uid) -Force
} catch {}
exit 0
