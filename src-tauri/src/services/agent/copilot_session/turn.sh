#!/bin/sh
# @DISPLAY@: the turn of the Copilot session a tab is in (working / decision /
# done / idle), for the tab's marks. Copilot runs it on the events in
# .copilot/hooks/@TURN_FILE@ in the tab's agent home, the event name as $1 and
# the event as JSON on stdin. Managed by @DISPLAY@; do not edit. Prints
# nothing, always exits 0.
#
# Only the tab's own conversation moves the record: @ENV@TAB_AGENT names
# Copilot (set at the spawn, so one under another CLI's tab stays out);
# COPILOT_AGENT_SESSION_ID, which Copilot sets for the commands its tools run,
# marks a `copilot -p` the tab's agent started; and the event's sessionId must
# be the session the tab is pinned to (its record, which the sessionStart hook
# moves on /new, else its key) — a subagent's events carry the subagent's id.
dir=@LIVE_DIR@
[ "${@ENV@TAB_AGENT-}" = copilot ] || exit 0
[ -z "${COPILOT_AGENT_SESSION_ID-}" ] || exit 0
uid=${@ENV@TAB_UID-}
h='[0-9a-fA-F]'
uuid="$h$h$h$h$h$h$h$h-$h$h$h$h-$h$h$h$h-$h$h$h$h-$h$h$h$h$h$h$h$h$h$h$h$h"
case $uid in $uuid) ;; *) exit 0 ;; esac
payload=$(cat | tr '\n\r' '  ')
# The first sessionId is the event's own (Copilot writes it before any tool
# arguments); a key matches only where it is one, since every quote inside a
# JSON string is escaped.
sid=$(printf '%s' "$payload" | grep -o '"sessionId"[[:space:]]*:[[:space:]]*"[^"\\]*"' | head -n 1 |
  sed 's/.*"\([^"]*\)"$/\1/')
# The record is the agent's to write inside the fence: a regular file only (a
# FIFO there would hold every hook to its timeout), and only its start read.
own=
if [ -f "$dir/$uid" ] && [ ! -h "$dir/$uid" ]; then own=$(head -c 64 "$dir/$uid" 2>/dev/null); fi
case $own in $uuid) ;; *) own=$uid ;; esac
[ "$sid" = "$own" ] || exit 0
turn=
case $1 in
  userPromptSubmitted|postToolUse|postToolUseFailure) turn=working ;;
  # Fires only for a dialog actually shown (an approval, an ask_user form).
  notification)
    if printf '%s' "$payload" | grep -Eq '"notification_type"[[:space:]]*:[[:space:]]*"(permission_prompt|elicitation_dialog)"'; then
      turn=decision
    fi ;;
  agentStop) turn=done ;;
  # A model call that failed ends the turn without agentStop.
  errorOccurred)
    if printf '%s' "$payload" | grep -q '"errorContext"[[:space:]]*:[[:space:]]*"model_call"'; then turn=done; fi ;;
  sessionEnd) turn=idle ;;
esac
[ -n "$turn" ] || exit 0
mkdir -p "$dir" 2>/dev/null || exit 0
tmp="$dir/.$uid.copilot-turn.$$"
if printf '%s %s' "$turn" "$(date +%s)" > "$tmp" 2>/dev/null; then
  mv -f "$tmp" "$dir/$uid.turn" 2>/dev/null || rm -f "$tmp"
fi
exit 0
