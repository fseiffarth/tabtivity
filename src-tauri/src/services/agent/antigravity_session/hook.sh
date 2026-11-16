#!/bin/sh
# @DISPLAY@: records which Antigravity conversation this tab is in, so the tab
# is restored into it (`--conversation <id>`) rather than the folder's newest
# one, and the tab's turn state (working / done), which lights its working and
# finished marks. Antigravity runs it from .gemini/config/hooks.json in the
# tab's agent home, with the event's name as its argument (1.5.2 and 1.5.3 put
# no hookEventName in the payload) and the event as JSON on stdin: before
# each model call (PreInvocation: the record, and working), at the end of
# each turn (Stop: done, whatever ended it), and at a new conversation's first
# prompt (SessionStart: the send hint, printed for the model). Managed by
# @DISPLAY@; do not edit. Prints only the hint, always exits 0.
#
# Only the tab's own conversation moves the records: @ENV@TAB_AGENT names
# Antigravity (set at the spawn, so one under another CLI's tab stays out);
# ANTIGRAVITY_AGENT, which Antigravity sets for the commands its tools run,
# marks an `agy -p` the tab's agent started; a subagent's event carries no
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
case ${1-} in
  SessionStart)
    # The model takes a SessionStart's injected system message into the
    # conversation (probed 1.5.9); outside a project tab there is no hint.
    [ -z "${@ENV@PROJECT_DIR-}" ] || printf '%s\n' @HINT@
    exit 0 ;;
  PreInvocation) turn=working ;;
  # NO_TOOL_CALL, ERROR (a failed model call), MAX_INVOCATIONS, …: the turn
  # is over. A cancelled turn fires none (the window reads the Esc).
  Stop) turn=done ;;
  *) exit 0 ;;
esac
mkdir -p "$dir" 2>/dev/null || exit 0
if [ "$turn" = working ]; then
  [ -f "$dir/$proof" ] || : > "$dir/$proof" 2>/dev/null
  tmp="$dir/.$uid.agy.$$"
  if printf '%s' "$id" > "$tmp" 2>/dev/null; then
    mv -f "$tmp" "$dir/$uid" 2>/dev/null || rm -f "$tmp"
  fi
else
  # A turn ends in the conversation its model calls went to.
  [ "$(cat "$dir/$uid" 2>/dev/null)" = "$id" ] || exit 0
fi
printf '%s %s' "$turn" "$(date +%s)" > "$dir/$uid.turn" 2>/dev/null
exit 0
