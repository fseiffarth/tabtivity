#!/usr/bin/env bash
# Open the live HTML QA runner (the "Tabtivity QA Runner" Artifact) in a browser.
#
# The runner holds the open 🖐️ Manual items parsed out of todo/group-*.md and
# stores its verdicts in the page itself, so it is a live document, not a
# checked-in file. This repo is public, so the page's URL is NOT hardcoded
# here — it is read from, in order:
#
#   1. the first argument            ./docs/start-qa-runner.sh <url>
#   2. $TABTIVITY_QA_URL
#   3. ~/.local/share/tabtivity/qa-runner-url   (one line, the URL)
#
# First run: save the URL once, then just run the script from then on.
#
#   echo '<artifact url>' > ~/.local/share/tabtivity/qa-runner-url
#   ./docs/start-qa-runner.sh
set -euo pipefail

URL_FILE="${TABTIVITY_QA_URL_FILE:-$HOME/.local/share/tabtivity/qa-runner-url}"

url="${1-}"
if [[ -z "$url" ]]; then
  url="${TABTIVITY_QA_URL-}"
fi
if [[ -z "$url" && -r "$URL_FILE" ]]; then
  url="$(sed -e 's/[[:space:]]*$//' -e '/^[[:space:]]*$/d' -e 's/^[[:space:]]*//' "$URL_FILE" | head -n 1)"
fi

if [[ -z "$url" ]]; then
  printf '%s\n' \
    "No QA runner URL." \
    "Pass it as an argument, set \$TABTIVITY_QA_URL, or save it once:" \
    "  mkdir -p \"$(dirname "$URL_FILE")\" && echo '<artifact url>' > \"$URL_FILE\"" >&2
  exit 1
fi

if [[ "$url" != http://* && "$url" != https://* ]]; then
  printf 'Not an http(s) URL: %s\n' "$url" >&2
  exit 1
fi

open_url() {
  case "$(uname -s)" in
    Darwin) exec open "$1" ;;
    MINGW*|MSYS*|CYGWIN*) exec cmd.exe /c start "" "$1" ;;
    *)
      if command -v xdg-open >/dev/null 2>&1; then
        exec xdg-open "$1"
      elif command -v gio >/dev/null 2>&1; then
        exec gio open "$1"
      fi
      ;;
  esac
  printf '%s\n' "No browser opener found. Open this yourself:" "$1" >&2
  exit 1
}

printf 'Opening QA runner: %s\n' "$url"
open_url "$url"
