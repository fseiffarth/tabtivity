#!/usr/bin/env bash
# Claude's hook payloads, headless: four `-p` turns (default and plan mode,
# each resumed once) plus `/usage`, every hook event dumped as one JSON file.
#
#   claude/hooks.sh <label> <claude-bin>
#   → tmp/verify-cli/claude/<label>/hooks/{dump/*.json,1-4.json,usage.json,id.*}
#
# Uses the real HOME (the turns need the login) and `--model haiku`: four
# small paid turns. Compare two labels with claude/cmp.py, check the hook's
# own field extraction with claude/sedcheck.py, the transcripts with meta.py.
set -uo pipefail
[ $# -eq 2 ] || { sed -n '2,10p' "$0"; exit 2; }
label=$1 bin=$2
# Absolute: the turns run from a scratch work dir.
case $bin in */*) bin="$(cd "$(dirname "$bin")" && pwd)/$(basename "$bin")" ;; esac
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
. "$ROOT/scripts/lib/brand.sh"
out="${VERIFY_OUT:-$ROOT/tmp/verify-cli}/claude/$label/hooks"
# A fresh dir per run; the path is built from fixed parts only.
[ -d "$out" ] && mv "$out" "$out.old-$(date +%s)"
mkdir -p "$out/work" "$out/dump"
cat > "$out/hook.sh" <<H
#!/bin/sh
f="$out/dump/\$(date +%s%N).json"; cat > "\$f"
H
chmod +x "$out/hook.sh"
ev() { printf '"%s":[{"hooks":[{"type":"command","command":"%s"}]}]' "$1" "$out/hook.sh"; }
echo "{\"hooks\":{$(ev SessionStart),$(ev Stop),$(ev UserPromptSubmit),$(ev PostToolUse),$(ev Notification),$(ev SessionEnd)}}" > "$out/settings.json"
cd "$out/work" || exit 1
echo hello > f.txt
A=$(cat /proc/sys/kernel/random/uuid) B=$(cat /proc/sys/kernel/random/uuid)
echo "$A" > "$out/id.default"; echo "$B" > "$out/id.plan"
run() {
  env -u "${APP_ENV_PREFIX}TAB_UID" -u "${APP_LEGACY_ENV_PREFIX}TAB_UID" \
      -u "${APP_ENV_PREFIX}TAB_AGENT" -u "${APP_LEGACY_ENV_PREFIX}TAB_AGENT" \
      "$bin" --settings "$out/settings.json" --model haiku "$@" </dev/null
}
run -p --session-id "$A" --allowedTools Bash --output-format json "Run the Bash command: echo probe-marker. Then reply with the single word ok." > "$out/1.json" 2>"$out/1.err"
run -p --resume "$A" --output-format json "Reply with the single word ok." > "$out/2.json" 2>"$out/2.err"
run -p --session-id "$B" --permission-mode plan --output-format json "Reply with the single word ok." > "$out/3.json" 2>"$out/3.err"
run -p --resume "$B" --output-format json "Reply with the single word ok." > "$out/4.json" 2>"$out/4.err"
run -p "/usage" --output-format json > "$out/usage.json" 2>"$out/usage.err"
"$bin" --help > "$out/help.txt" 2>&1
"$bin" --version > "$out/version.txt" 2>&1
echo "$out: $(ls "$out/dump" | wc -l) hook payloads"
