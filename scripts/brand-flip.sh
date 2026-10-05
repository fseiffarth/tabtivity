#!/usr/bin/env bash
# Give the app a new name: rewrite the flip points, and nothing else.
#
#   scripts/brand-flip.sh <Display> <slug>      e.g.  brand-flip.sh Newname newname
#
# A flip point is a place that has to spell the name itself because nothing can
# fill it in: the two brand modules, the package and bundle metadata, the static
# pages and manifests, files NAMED after the app, and the few literals no
# constant can reach (a serde key, an include path). Everything else reads the
# name from the brand modules and follows by itself.
#
# What it does NOT do, on purpose:
#   * prose — comments, docs, help texts (scripts/rename-codemods/prose-pass.sh);
#   * the name before this one: `legacy_*` in brand.rs and `LEGACY_BRAND` in
#     brand.ts stay, they are what the migrator and the dual reads look for;
#   * the release repository (`app_repo!`): it moves on its own schedule;
#   * anything frozen: fixtures, pinned ids, the scaffold history.
#
# It flips ONCE, from the name older builds wrote. A second rename would need
# the migrator to know two old names, which it does not: the script refuses.
#
# The upper form is derived (`<SLUG>` in capitals); the display form's
# lowercase must be the slug, as brand.rs's `the_forms_agree` test demands.
#
# Review the diff, then run the gates. Nothing is committed here.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$ROOT/scripts/lib/brand.sh"
cd "$ROOT"

[ "$#" -eq 2 ] || { echo "usage: brand-flip.sh <Display> <slug>" >&2; exit 2; }
NEW_DISPLAY="$1"
NEW_SLUG="$2"
NEW_UPPER="$(printf '%s' "$NEW_SLUG" | tr '[:lower:]' '[:upper:]')"
OLD_DISPLAY="$APP_DISPLAY"
OLD_SLUG="$APP_SLUG"
OLD_UPPER="$APP_UPPER"

case "$NEW_SLUG" in
  *[!a-z0-9]* | '') echo "brand-flip: the slug must be lowercase letters and digits" >&2; exit 2 ;;
esac
if [ "$(printf '%s' "$NEW_DISPLAY" | tr '[:upper:]' '[:lower:]')" != "$NEW_SLUG" ]; then
  echo "brand-flip: the slug must be the display name in lowercase" >&2
  exit 2
fi
if [ "$NEW_SLUG" = "$OLD_SLUG" ]; then
  echo "brand-flip: the app is already called $OLD_DISPLAY; nothing to do."
  exit 0
fi
if [ "$OLD_SLUG" != "$APP_LEGACY_SLUG" ]; then
  echo "brand-flip: the name was already changed once ($APP_LEGACY_SLUG -> $OLD_SLUG)." >&2
  echo "  The migrator knows one old name. Teach it a second before flipping again." >&2
  exit 1
fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "brand-flip: the tree has uncommitted changes; commit them first, so the flip is its own diff." >&2
  exit 1
fi

# The release repository's name carries the old name and stays (it moves in
# its own phase). It is hidden from every replacement below.
REPO_NAME="$(_brand_sh_macro app_repo)"
REPO_NAME="${REPO_NAME#*/}"
REPO_LOWER="$(printf '%s' "$REPO_NAME" | tr '[:upper:]' '[:lower:]')"

say() { printf 'brand-flip: %s\n' "$*"; }

# Replace the name's three forms in whole files, leaving the repository's
# name alone.
three_forms() {
  local file
  for file in "$@"; do
    [ -f "$file" ] || { echo "brand-flip: $file is missing" >&2; exit 1; }
    sed -i \
      -e "s/$REPO_NAME/\x01REPO\x01/g" -e "s/$REPO_LOWER/\x01REPOLOWER\x01/g" \
      -e "s/$OLD_DISPLAY/$NEW_DISPLAY/g" -e "s/$OLD_SLUG/$NEW_SLUG/g" -e "s/$OLD_UPPER/$NEW_UPPER/g" \
      -e "s/\x01REPO\x01/$REPO_NAME/g" -e "s/\x01REPOLOWER\x01/$REPO_LOWER/g" \
      "$file"
  done
}

# `git mv` a file whose name carries the old slug or display name; prints the
# new path.
renamed_path() {
  local path="$1" new
  new="$(dirname "$path")/$(basename "$path" | sed -e "s/$OLD_SLUG/$NEW_SLUG/g" -e "s/$OLD_DISPLAY/$NEW_DISPLAY/g")"
  new="${new#./}"
  git mv "$path" "$new"
  printf '%s\n' "$new"
}

# ── 1. The brand modules ────────────────────────────────────────────────────
# brand.rs: the literal inside `app_name!`, `app_slug!`, `app_upper!`. The
# `legacy_*` macros keep the old name.
say "brand modules"
flip_macro() { # macro, old literal, new literal
  awk -v start="macro_rules! $1 {" -v old="\"$2\"" -v new="\"$3\"" '
    index($0, start) == 1 { inside = 1 }
    inside && index($0, old) { sub(old, new); done = 1; inside = 0 }
    inside && /^}/ { inside = 0 }
    { print }
    END { if (!done) exit 3 }
  ' src-tauri/src/brand.rs > src-tauri/src/brand.rs.flip || { rm -f src-tauri/src/brand.rs.flip; echo "brand-flip: $1 not found in brand.rs" >&2; exit 1; }
  mv src-tauri/src/brand.rs.flip src-tauri/src/brand.rs
}
flip_macro app_name "$OLD_DISPLAY" "$NEW_DISPLAY"
flip_macro app_slug "$OLD_SLUG" "$NEW_SLUG"
flip_macro app_upper "$OLD_UPPER" "$NEW_UPPER"

# brand.ts: the `BRAND` object. `LEGACY_BRAND` keeps the old name.
awk -v od="\"$OLD_DISPLAY\"" -v nd="\"$NEW_DISPLAY\"" -v os="\"$OLD_SLUG\"" -v ns="\"$NEW_SLUG\"" \
    -v ou="\"$OLD_UPPER\"" -v nu="\"$NEW_UPPER\"" -v oe="\"${OLD_UPPER}_\"" -v ne="\"${NEW_UPPER}_\"" '
  /^export const BRAND = \{/ { inside = 1 }
  inside && /display:/ { n += sub(od, nd) }
  inside && /slug:/ { n += sub(os, ns) }
  inside && /upper:/ { n += sub(ou, nu) }
  inside && /envPrefix:/ { n += sub(oe, ne) }
  inside && /^\}/ { inside = 0 }
  { print }
  END { if (n != 4) exit 3 }
' src/lib/brand.ts > src/lib/brand.ts.flip || { rm -f src/lib/brand.ts.flip; echo "brand-flip: BRAND not found in brand.ts" >&2; exit 1; }
mv src/lib/brand.ts.flip src/lib/brand.ts

# ── 2. Package names ────────────────────────────────────────────────────────
# The crate, its default binary and the `[[bin]]` (the library keeps its
# brand-neutral name), the app's own block in Cargo.lock, the npm package.
# scripts/bump-version.sh finds the Cargo.lock block through the manifest's
# package name, so it follows.
say "package names"
sed -i -e "s/^name = \"$OLD_SLUG\"\$/name = \"$NEW_SLUG\"/" -e "s/^default-run = \"$OLD_SLUG\"\$/default-run = \"$NEW_SLUG\"/" src-tauri/Cargo.toml
sed -i -e "s/^name = \"$OLD_SLUG\"\$/name = \"$NEW_SLUG\"/" Cargo.lock
sed -i -e "s/^  \"name\": \"$OLD_SLUG\",\$/  \"name\": \"$NEW_SLUG\",/" package.json
sed -i -e "1,10s/^\(  \|      \)\"name\": \"$OLD_SLUG\",\$/\1\"name\": \"$NEW_SLUG\",/" package-lock.json

# ── 3. Bundle metadata, static pages, manifests ─────────────────────────────
# productName, window title and identifier; the capability description; the
# window's and the phone's static pages (BrandMirror.test.ts holds each to
# the brand module); the sandbox image's build context; CI's artifact names,
# dmg name and release-note text.
say "bundle metadata and static pages"
three_forms \
  src-tauri/tauri.conf.json \
  src-tauri/tauri.macos.conf.json \
  src-tauri/capabilities/default.json \
  src-tauri/gen/schemas/capabilities.json \
  src-tauri/entitlements.plist \
  index.html \
  mobile-web/index.html \
  mobile-web/terminal-preview.html \
  mobile-web/public/manifest.webmanifest \
  mobile-web/public/sw.js \
  docker/agent-sandbox/Dockerfile \
  .github/workflows/ci-cd.yml

# ── 4. Literals no constant can reach ───────────────────────────────────────
# A serde key. No `alias` for the old key, on purpose: with one, a file that
# holds BOTH keys (an older build wrote it after this one did) fails to parse
# as a whole, and the readers fall back to an empty default — and an old key
# left behind would switch the phone's access on behind a UI that reads the
# current key only. The migrator's `persisted-names` step renames the keys in
# the state files before anything reads them.
say "serde keys and include paths"
for file in \
  src-tauri/src/schema/settings.rs \
  src-tauri/src/schema/boxes.rs \
  src-tauri/src/services/mobile_control/config.rs \
  src-tauri/src/services/mobile_control/discovery.rs; do
  sed -i -E "s/rename = \"${OLD_SLUG}(_mobile_[a-z]+)\"/rename = \"${NEW_SLUG}\1\"/" "$file"
done

# ── 5. Files named after the app ────────────────────────────────────────────
say "files named after the app"
# The send command's static scripts, embedded by path (agent_bin.rs).
for path in "scripts/$OLD_SLUG-send.sh" "scripts/$OLD_SLUG-send.ps1" "scripts/$OLD_SLUG-send.cmd"; do
  three_forms "$(renamed_path "$path")"
done
sed -i -e "s|scripts/$OLD_SLUG-send\.|scripts/$NEW_SLUG-send.|g" src-tauri/src/services/agent_bin.rs

# The launchers: renamed, with a forwarding stub under the old name for the
# desktop entries and habits that still point there.
stub_sh() { # old path, new path
  cat > "$1" <<STUB
#!/usr/bin/env bash
# The old name of $(basename "$2"), kept until the old name's cleanup release
# for desktop entries that still point here.
exec "\$(dirname "\${BASH_SOURCE[0]}")/$(basename "$2")" "\$@"
STUB
  chmod +x "$1"
  git add "$1"
}
for path in "start-$OLD_SLUG-dev-build.sh" "start-$OLD_SLUG-dev-sandbox.sh" "start-$OLD_SLUG-tauri-hotreload.sh"; do
  new="$(renamed_path "$path")"
  three_forms "$new"
  stub_sh "$path" "$new"
done
new="$(renamed_path "scripts/$OLD_SLUG-dev.cmd")"
three_forms "$new"
printf '@echo off\r\nrem The old name of %s, kept until the cleanup release.\r\ncall "%%~dp0%s" %%*\r\n' \
  "$(basename "$new")" "$(basename "$new")" > "scripts/$OLD_SLUG-dev.cmd"
git add "scripts/$OLD_SLUG-dev.cmd"

# Sample desktop entries and launchers in docs/, and the README's pictures.
for path in \
  "docs/$OLD_DISPLAY.desktop" "docs/${OLD_DISPLAY}Dev.desktop" "docs/${OLD_DISPLAY}HotReload.desktop" \
  "docs/start-$OLD_SLUG-tauri.sh" "docs/start-$OLD_SLUG-tauri-hotreload.sh" \
  "screenshots/$OLD_SLUG-functionality.svg"; do
  three_forms "$(renamed_path "$path")"
done
# screenshots/$OLD_SLUG-current.png is NOT renamed: a binary under a new path
# has to be opened and reviewed again (scripts/privacy-reviewed-binaries.txt),
# and a picture of the old window is retaken, not renamed.

# ── 6. Ignore lists ─────────────────────────────────────────────────────────
# They name the app's folders literally. The old-named lines stay: a checkout
# or a project that has not been opened since the rename still has them.
say "ignore lists"
awk -v old="$OLD_SLUG" -v new="$NEW_SLUG" -v pinned=".${OLD_SLUG}_colors.json" '
  { print }
  index($0, old) && !index($0, pinned) && $0 !~ /^[[:space:]]*(#|\/\/)/ { line = $0; gsub(old, new, line); print line }
' .gitignore > .gitignore.flip && mv .gitignore.flip .gitignore
awk -v old="$OLD_SLUG" -v new="$NEW_SLUG" '
  { print }
  index($0, old) && $0 !~ /^[[:space:]]*(#|\/\/)/ { line = $0; gsub(old, new, line); print line }
' eslint.config.js > eslint.config.js.flip && mv eslint.config.js.flip eslint.config.js

say "done: $OLD_DISPLAY -> $NEW_DISPLAY. Review \`git status\` and \`git diff\`, then:"
say "  scripts/rename-codemods/prose-pass.sh   (comments, docs, help texts)"
say "  the gates in AGENTS.md, scripts/brand-check.sh"
