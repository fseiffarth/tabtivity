#!/usr/bin/env bash
# The prose pass of the rename: after scripts/brand-flip.sh has rewritten the
# flip points, rewrite the old name in everything that merely TALKS about the
# app — comments, docs, help texts, TODO lists, licence lines.
#
#   scripts/rename-codemods/prose-pass.sh          # rewrite
#   scripts/rename-codemods/prose-pass.sh --dry    # list the files it would touch
#
# The old and the new name come from scripts/lib/brand.sh (legacy_* and app_*
# in brand.rs), so it runs after the flip and needs no arguments.
#
# Code outside comments holds no spelled-out name (scripts/brand-check.sh has
# kept it so), so in a source file this only ever touches comments.
#
# Left alone, on purpose:
#   * the brand modules and the rename's own tooling;
#   * frozen texts: fixtures, the updater's signed-release fixtures, the
#     scaffold history, the frozen file-map rationale, the earlier phases'
#     handoffs, the blob review notes;
#   * files that spell the OLD name deliberately (old-name fallbacks, the
#     forwarding stubs, the deb's replaces list) — edited by hand;
#   * a line carrying `brand-check: allow`, and the line after it;
#   * the release repository's name, which moves in its own phase;
#   * a path that keeps its old name (the README's screenshot, the fixtures).
#
# Also renames the docs whose FILE name carries the old name.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
. "$ROOT/scripts/lib/brand.sh"
cd "$ROOT"

dry=0
[ "${1:-}" = "--dry" ] && dry=1

OLD_DISPLAY="$APP_LEGACY_DISPLAY"
OLD_SLUG="$APP_LEGACY_SLUG"
OLD_UPPER="$APP_LEGACY_UPPER"
if [ "$OLD_SLUG" = "$APP_SLUG" ]; then
  echo "prose-pass: the name is unchanged; run scripts/brand-flip.sh first." >&2
  exit 1
fi

REPO_NAME="$(_brand_sh_macro app_repo)"
REPO_NAME="${REPO_NAME#*/}"
REPO_LOWER="$(printf '%s' "$REPO_NAME" | tr '[:upper:]' '[:lower:]')"

skip() {
  case "$1" in
    src-tauri/src/brand.rs | src/lib/brand.ts) return 0 ;;
    scripts/rename-codemods/* | scripts/brand-flip.sh | scripts/brand-check.sh | scripts/lib/brand.sh) return 0 ;;
    src-tauri/src/services/app_update.rs) return 0 ;;
    test-fixtures/* | src/__tests__/fixtures/* | src-tauri/tests/fixtures/*) return 0 ;;
    src-tauri/src/commands/scaffold_history/* | docs/filemap_rationale/*) return 0 ;;
    docs/rename_phase*_handoff.md | docs/rename_plan.md | docs/context/brand_migration.md) return 0 ;;
    scripts/privacy-reviewed-binaries.txt | Cargo.lock | package-lock.json | src-tauri/gen/*) return 0 ;;
    .githooks/* | .gitignore | eslint.config.js | index.html | src-tauri/tauri.conf.json) return 0 ;;
    scripts/privacy-check.sh) return 0 ;;
    "start-$OLD_SLUG-"*.sh | "scripts/$OLD_SLUG-dev.cmd") return 0 ;;
  esac
  return 1
}

# Docs named after the app.
while IFS= read -r path; do
  [ -n "$path" ] || continue
  skip "$path" && continue
  case "$path" in
    *.md) ;;
    *) continue ;;
  esac
  new="$(dirname "$path")/$(basename "$path" | sed -e "s/$OLD_SLUG/$APP_SLUG/g" -e "s/$OLD_DISPLAY/$APP_DISPLAY/g")"
  new="${new#./}"
  if [ "$dry" = 1 ]; then echo "rename $path -> $new"; else git mv "$path" "$new"; fi
done < <(git ls-files | grep -i -- "$OLD_SLUG" || true)

count=0
while IFS= read -r path; do
  [ -n "$path" ] || continue
  skip "$path" && continue
  count=$((count + 1))
  if [ "$dry" = 1 ]; then echo "$path"; continue; fi
  awk -v od="$OLD_DISPLAY" -v nd="$APP_DISPLAY" -v os="$OLD_SLUG" -v ns="$APP_SLUG" \
      -v ou="$OLD_UPPER" -v nu="$APP_UPPER" -v repo="$REPO_NAME" -v repol="$REPO_LOWER" '
    function keep(s, word, tag,   out, i) {
      out = ""
      while ((i = index(s, word)) > 0) { out = out substr(s, 1, i - 1) tag; s = substr(s, i + length(word)) }
      return out s
    }
    function swap(s, from, to,   out, i) {
      out = ""
      while ((i = index(s, from)) > 0) { out = out substr(s, 1, i - 1) to; s = substr(s, i + length(from)) }
      return out s
    }
    {
      mark = index($0, "brand-check: allow") > 0
      line = $0
      if (!mark && !marked) {
        line = keep(line, repo, "\001R\001")
        line = keep(line, repol, "\001r\001")
        line = keep(line, "screenshots/" os "-current.png", "\001S\001")
        line = keep(line, "test-fixtures/" os "_", "\001F\001")
        line = swap(line, od, nd)
        line = swap(line, os, ns)
        line = swap(line, ou, nu)
        line = swap(line, "\001R\001", repo)
        line = swap(line, "\001r\001", repol)
        line = swap(line, "\001S\001", "screenshots/" os "-current.png")
        line = swap(line, "\001F\001", "test-fixtures/" os "_")
      }
      marked = mark
      print line
    }
  ' "$path" > "$path.prose-pass"
  # Keep the file mode.
  cat "$path.prose-pass" > "$path"
  rm -f "$path.prose-pass"
done < <(git grep -I -i -l -e "$OLD_SLUG" || true)

echo "prose-pass: $count file(s) $([ "$dry" = 1 ] && echo 'would be rewritten' || echo rewritten): $OLD_DISPLAY -> $APP_DISPLAY."
echo "  Now read the diff of anything that tells HISTORY (it may want the old name back),"
echo "  check the German genitives in the dictionaries, and run scripts/brand-check.sh."
