#!/usr/bin/env bash
# The app's name is spelled in ONE place per language — src-tauri/src/brand.rs,
# src/lib/brand.ts, and the scripts read it through scripts/lib/brand.sh. This
# fails when a tracked file outside the allowlist below spells it itself, so a
# hard-coded name cannot creep back in between the rename's phases.
#
#   scripts/brand-check.sh            # check; exit 1 and list every hit
#   scripts/brand-check.sh --list     # also print how many hits each allowlist
#                                     # entry is still covering (what is left
#                                     # for the flip), and entries covering none
#
# What is checked: every tracked text file's content, and every tracked path,
# case-insensitively, for the name's lowercase form — the current one and the
# old one (`app_slug!` / `legacy_slug!` in brand.rs).
#
# What is let through:
#   * a path on the ALLOW list below. Each entry says why it is there and which
#     phase of docs/rename_plan.md removes it;
#   * a line carrying `brand-check: allow` (with the reason), or the line right
#     after one. For the few spellings no constant can reach — a serde key, an
#     `include_bytes!` path;
#   * the current name in a comment: comments are prose, like the docs. The
#     OLD name in a comment is reported (see COMMENTS_ARE_PROSE).
#
# Runs in CI next to privacy-check.sh, and by hand with the other gates.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The app's names (scripts/lib/brand.sh): $APP_SLUG, $APP_LEGACY_SLUG, …
. "$ROOT/scripts/lib/brand.sh"
cd "$ROOT"

# 0 since the rename's prose pass rewrote the comments: a comment may name the
# app (comments are prose, like the docs), but one that still names the OLD
# brand fails like any other line. 1 lets comments say anything.
COMMENTS_ARE_PROSE=0

# ---------------------------------------------------------------------------
# The allowlist. One bash `case` pattern per entry (`*` also matches `/`),
# matched against the path from the repo root. Keep every entry explained, and
# keep it as narrow as the reason: a whole directory only where every file in
# it has the same reason.
#
# Since the flip (release A) the entries fall in two kinds: places that MUST
# spell the current name themselves (they stay for good), and places that
# still spell the OLD name on purpose — marked "until release B", the cleanup
# release that deletes the old-name lookups.
# ---------------------------------------------------------------------------
ALLOW=(
  # --- The brand modules: the one place per language the name is written. ---
  # Stays. They hold the current name and the LEGACY_* old one.
  'src-tauri/src/brand.rs'
  'src/lib/brand.ts'

  # --- Prose: documentation and notes. Stays. -------------------------------
  # `*.md` covers README, DOCUMENTATION, AGENTS, todo/, docs/help, …; the
  # history they tell ("formerly …", the rename's handoffs, the frozen
  # file-map rationale) keeps the old name. It also covers the frozen scaffold
  # texts in src-tauri/src/commands/scaffold_history/, which stay
  # byte-identical for good (they recognise an unedited copy in a project).
  '*.md'
  # The docs folder's non-markdown files: sample launchers and desktop entries.
  'docs/*'
  'LICENSE-MIT'
  'LICENSE-APACHE'
  # Translatable prose in a registry that scripts/untested.mjs parses as text.
  'src/lib/untested.ts'

  # --- Frozen texts: must stay byte-identical, whatever the app is called. ---
  # Signed-release test fixtures (checksums over asset names). Stays.
  'src-tauri/src/services/app_update.rs'
  # Recorded state and inputs older builds wrote, for round-trip tests. Stays
  # (the migrator's tests read old-shaped data on purpose).
  'test-fixtures/*'
  'src/__tests__/fixtures/*'
  'src-tauri/tests/fixtures/*'

  # --- Flip points: package and bundle metadata (scripts/brand-flip.sh). -----
  # They spell the current name because nothing can fill it in. Stays.
  # tauri.conf.json also names the OLD deb package it replaces (until
  # release B).
  'Cargo.toml'
  'Cargo.lock'
  'src-tauri/Cargo.toml'
  'package.json'
  'package-lock.json'
  'src-tauri/tauri.conf.json'
  'src-tauri/tauri.macos.conf.json'
  'src-tauri/capabilities/*'
  'src-tauri/gen/*'
  'src-tauri/entitlements.plist'
  # Static pages and manifests no module can fill in. BrandMirror.test.ts
  # holds each to the brand module. Stays. index.html also reads the storage
  # keys an older build wrote, before any module runs (until release B).
  'index.html'
  'mobile-web/index.html'
  'mobile-web/terminal-preview.html'
  'mobile-web/public/manifest.webmanifest'
  'mobile-web/public/sw.js'
  # Artwork: the name in <title>/aria-label and the wordmark. Stays.
  '*.svg'
  # Blob ids of reviewed binaries, with what was seen in each. A record: the
  # old entries keep the old name. Stays.
  'scripts/privacy-reviewed-binaries.txt'

  # --- Files NAMED after the app. --------------------------------------------
  # The launchers, the Windows dev launcher and the send command's static
  # scripts (embedded with `include_bytes!`, so they run with no repo around
  # them and spell the names themselves). Stays.
  "start-$APP_SLUG-*.sh"
  "scripts/$APP_SLUG-dev.cmd"
  "scripts/$APP_SLUG-send.sh"
  "scripts/$APP_SLUG-send.ps1"
  "scripts/$APP_SLUG-send.cmd"
  # Their forwarding stubs under the old name, for desktop entries and habits
  # that still point there. Until release B.
  # Spelled with the helper's old-name variable: this script is checked too.
  "start-$APP_LEGACY_SLUG-*.sh"
  "scripts/$APP_LEGACY_SLUG-dev.cmd"
  # The README's picture of the window. Not renamed: a binary under a new path
  # needs a fresh privacy review, and the picture shows the old name anyway.
  # Until it is retaken.
  "screenshots/$APP_LEGACY_SLUG-current.png"

  # --- Tooling that cannot source the brand helper. --------------------------
  # Git hooks: run in any state of the tree, so they stay self-contained, and
  # read their switches under both names (the old one until release B).
  '.githooks/*'
  # CI: artifact names, the dmg name and release-note text. Stays.
  '.github/*'
  # The sandbox image's build context: runs inside `docker build`, away from
  # the repo. Stays.
  'docker/*'
  # Ignore lists name the app's folders literally, under both names (the old
  # ones until release B).
  '.gitignore'
  'eslint.config.js'
  # Standalone scripts that spell the name, the state dir or a persisted key
  # themselves: the phone-install scripts are embedded and written into the
  # state dir; the others are run by hand with no need for the helper. Stays.
  'scripts/install_phone.sh'
  'scripts/install_phone.ps1'
  'scripts/take-screenshot.sh'
  'scripts/copilot-probe.py'
  'scripts/parse-qa.mjs'
  # The privacy scan's per-user config dir (current name; the old one carries
  # an allow marker).
  'scripts/privacy-check.sh'

  # --- The rename's own tooling. Removed when the rename is finished. --------
  # The codemods search for the name by design.
  'scripts/rename-codemods/*'
)

# ---------------------------------------------------------------------------

list=0
case "${1:-}" in
  --list) list=1 ;;
  '') ;;
  *) echo "usage: brand-check.sh [--list]" >&2; exit 2 ;;
esac

# The words to look for, lowercase, as one ERE alternation.
needle="$APP_LEGACY_SLUG"
if [ "$APP_SLUG" != "$APP_LEGACY_SLUG" ]; then
  needle="$APP_LEGACY_SLUG|$APP_SLUG"
fi

# Index of the ALLOW entry covering a path, or nothing.
allow_index() {
  local i
  for i in "${!ALLOW[@]}"; do
    # shellcheck disable=SC2254  # the entry IS a pattern
    case "$1" in ${ALLOW[$i]}) printf '%s\n' "$i"; return 0 ;; esac
  done
  return 1
}

declare -a covered=()
for i in "${!ALLOW[@]}"; do covered[i]=0; done
declare -a scan=()
bad=0

# Paths that carry the name.
while IFS= read -r path; do
  [ -n "$path" ] || continue
  if i="$(allow_index "$path")"; then
    covered[i]=$((covered[i] + 1))
  else
    printf '%s: the path itself names the app\n' "$path"
    bad=$((bad + 1))
  fi
done < <(git ls-files | grep -iE -- "$needle" || true)

# Text files whose content carries it (-I: binaries are not text to read).
while IFS= read -r path; do
  [ -n "$path" ] || continue
  if i="$(allow_index "$path")"; then
    covered[i]=$((covered[i] + 1))
  else
    scan+=("$path")
  fi
done < <(git grep -I -i -l -E -e "$needle" || true)

if [ "${#scan[@]}" -gt 0 ]; then
  # One pass over the remaining files: drop what is a comment in that file's
  # language, honour the allow marker, report what is left.
  #
  # The comment rules are deliberately narrow, so that they err towards
  # reporting: `//` and `#` open a comment only at the start of a line or
  # after whitespace (not the `//` of a URL in a string, not `$#`), and `/*`
  # only there or after `{` / `(` (not the `/*` of a glob like `**/*.ts`).
  hits="$(awk -v needle="$needle" -v legacy="$APP_LEGACY_SLUG" -v prose="$COMMENTS_ARE_PROSE" '
    function style_of(name,   base, ext) {
      base = name; sub(/^.*\//, "", base)
      if (base !~ /\./ || base ~ /^\.[^.]*$/ || base == "Dockerfile") return "hash"
      ext = base; sub(/^.*\./, "", ext)
      if (ext ~ /^(rs|ts|tsx|js|jsx|mjs|cjs|css)$/) return "c"
      if (ext ~ /^(sh|bash|py|yml|yaml|toml|ps1|conf|desktop)$/) return "hash"
      if (ext ~ /^(html|htm|xml|plist)$/) return "xml"
      if (ext ~ /^(cmd|bat)$/) return "cmd"
      return "none"
    }
    # Remove the comments of a C-like line; `inblock` carries a `/* … */`
    # across lines.
    function strip_c(s,   out, lc, bc, end) {
      out = ""
      while (1) {
        if (inblock) {
          end = index(s, "*/")
          if (!end) return out
          s = substr(s, end + 2); inblock = 0
          continue
        }
        lc = match(s, /(^|[ \t])\/\//) ? RSTART : 0
        bc = match(s, /(^|[ \t{(])\/\*/) ? RSTART : 0
        if (!lc && !bc) return out s
        if (lc && (!bc || lc <= bc)) return out substr(s, 1, lc - 1)
        out = out substr(s, 1, bc)
        s = substr(s, bc + 1)
        sub(/^[^\/]*\/\*/, "", s)
        inblock = 1
      }
    }
    function strip_xml(s,   out, start, end) {
      out = ""
      while (1) {
        if (inblock) {
          end = index(s, "-->")
          if (!end) return out
          s = substr(s, end + 3); inblock = 0
          continue
        }
        start = index(s, "<!--")
        if (!start) return out s
        out = out substr(s, 1, start - 1)
        s = substr(s, start + 4); inblock = 1
      }
    }
    function strip(s) {
      if (style == "c") return strip_c(s)
      if (style == "xml") return strip_xml(s)
      if (style == "hash") { if (match(s, /(^|[ \t])#/)) return substr(s, 1, RSTART - 1); return s }
      if (style == "cmd") { if (s ~ /^[ \t]*(@?[Rr][Ee][Mm]([ \t]|$)|::)/) return ""; return s }
      return s
    }
    FNR == 1 { inblock = 0; marked = 0; style = style_of(FILENAME) }
    {
      mark = index($0, "brand-check: allow") > 0
      code = tolower(strip($0))
      whole = tolower($0)
      # Code may spell neither name; a comment may not spell the old one.
      if (!mark && !marked && (code ~ needle || (!prose && whole ~ legacy))) printf "%s:%d: %s\n", FILENAME, FNR, $0
      marked = mark
    }
  ' "${scan[@]}")"
  if [ -n "$hits" ]; then
    printf '%s\n' "$hits"
    bad=$((bad + $(printf '%s\n' "$hits" | wc -l)))
  fi
fi

if [ "$list" = 1 ]; then
  echo
  echo "Allowlist coverage (paths and files with a hit, per entry):"
  for i in "${!ALLOW[@]}"; do
    if [ "${covered[i]}" -eq 0 ]; then
      printf '  %5s  %s   <- covers nothing; delete the entry\n' 0 "${ALLOW[$i]}"
    else
      printf '  %5d  %s\n' "${covered[i]}" "${ALLOW[$i]}"
    fi
  done
fi

if [ "$bad" -gt 0 ]; then
  cat >&2 <<MSG

brand-check: $bad place(s) spell the app's name outside the brand modules.
  Rust: use a constant or macro from src-tauri/src/brand.rs (crate::brand::…).
  TypeScript: use BRAND / NAMES / storageKey(…) from src/lib/brand.ts.
  Shell: source scripts/lib/brand.sh and use \$APP_DISPLAY, \$APP_SLUG, ….
  Where no constant can reach (a serde key, an include path), put
  "brand-check: allow — <why>" on the line or the line above it.
MSG
  exit 1
fi
echo "brand-check: the app's name is spelled only in the brand modules and the allowlist (${#ALLOW[@]} entries)."
