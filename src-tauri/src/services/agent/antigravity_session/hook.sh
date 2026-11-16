#!/bin/sh
# @DISPLAY@: records which Antigravity conversation this tab is in, so the tab
# is restored into it (`--conversation <id>`) rather than the folder's newest
# one. Antigravity runs it before each model call (PreInvocation, from
# .gemini/config/hooks.json in the tab's agent home), with the call as JSON on
# stdin. Managed by @DISPLAY@; do not edit. Prints nothing, always exits 0.
#
# Only the tab's own conversation moves the record: @ENV@TAB_AGENT names
# Antigravity (set at the spawn, so one under another CLI's tab stays out);
# ANTIGRAVITY_AGENT, which Antigravity sets for the commands its tools run,
# marks an `agy -p` the tab's agent started; a subagent's call carries no
# prompt of its own (an empty lastUserInput) or names its parent.
dir=@LIVE_DIR@
proof=@PROOF@
[ "${@ENV@TAB_AGENT-}" = agy ] || exit 0
[ -z "${ANTIGRAVITY_AGENT-}" ] || exit 0
uid=${@ENV@TAB_UID-}
h='[0-9a-fA-F]'
uuid="$h$h$h$h$h$h$h$h-$h$h$h$h-$h$h$h$h-$h$h$h$h-$h$h$h$h$h$h$h$h$h$h$h$h"
case $uid in $uuid) ;; *) exit 0 ;; esac
payload=$(cat | tr '\n\r' '  ')
# A key matches only where it is one: inside a JSON string every quote is
# escaped. The ids are plain strings (no escapes).
field() {
  printf '%s' "$payload" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\\([^\"\\\\]*\\)\".*/\\1/p"
}
if printf '%s' "$payload" | grep -q '"lastUserInput"[[:space:]]*:[[:space:]]*""'; then exit 0; fi
[ -z "$(field parentConversationId)" ] || exit 0
id=$(field conversationId)
case $id in $uuid) ;; *) exit 0 ;; esac
mkdir -p "$dir" 2>/dev/null || exit 0
[ -f "$dir/$proof" ] || : > "$dir/$proof" 2>/dev/null
tmp="$dir/.$uid.agy.$$"
if printf '%s' "$id" > "$tmp" 2>/dev/null; then
  mv -f "$tmp" "$dir/$uid" 2>/dev/null || rm -f "$tmp"
fi
exit 0
