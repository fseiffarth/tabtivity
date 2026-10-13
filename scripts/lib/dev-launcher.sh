# shellcheck shell=bash
# What the frozen dev build trusts, shared by scripts/package-dev.sh (which
# writes it) and start-<slug>-dev-build.sh (which reads it). SOURCED after
# scripts/lib/brand.sh, never run.
#
# The checkout is writable by every agent fence that binds the project, so the
# launcher must not trust what it finds there (threat recheck 2026-10-08, gap
# 20). Two things live in the per-user app dir instead, written only by a
# package-dev.sh that runs on the host (`dev_on_host`) — inside a fence $HOME
# is the agent's own home, so a write there never reaches the real ones:
#
#   <app_dir>/dev-builds/verified   one line per build this host made,
#                                   "<sha256> <commit> <version> <built>",
#                                   newest last, the last DEV_VERIFIED_KEEP
#                                   kept. The launcher adopts
#                                   target/release/<bin> only when its hash is
#                                   here, and takes the label from here too.
#   <app_dir>/dev-launcher/         a copy of the launcher and everything it
#                                   sources or runs (`dev_launcher_files`), plus
#                                   `source-root` naming the checkout. The
#                                   desktop entry runs this copy, so an
#                                   uncommitted edit to the checkout's launcher
#                                   never runs on the next click.
#
# Functions:
#   dev_on_host APP_DIR             0 outside an agent fence (no fence variable,
#                                   APP_DIR not a tmpfs), 1 inside one
#   dev_verified_list APP_DIR       print the verified list's path
#   dev_verified_add LIST SHA COMMIT VERSION BUILT
#                                   record a build (fields sanitised)
#   dev_verified_lookup LIST SHA    print "<commit> <version> <built>" of SHA,
#                                   or return 1 (missing, unknown, or a list
#                                   that is a link, someone else's, or writable
#                                   by group/other)
#   dev_launcher_files              the launcher's files, relative to a checkout
#   dev_launcher_dir APP_DIR        print the installed copy's directory
#   dev_launcher_install SRC DEST ROOT
#                                   copy the launcher files from checkout SRC
#                                   into DEST (swapped in whole), recording ROOT
#   dev_desktop_exec FILE EXEC      point desktop entry FILE's Exec= at EXEC

DEV_VERIFIED_KEEP=20

dev_on_host() {
  [ -z "$(app_env AGENT_FENCE)" ] &&
    [ "$(stat -f -c %T "$1" 2>/dev/null || echo unknown)" != "tmpfs" ]
}

dev_verified_list() {
  printf '%s\n' "$1/dev-builds/verified"
}

# Only characters that are safe in a file name, a sed replacement and a
# notification: a record's fields end up in all three.
_dev_field() {
  local value="${1//[^A-Za-z0-9.+:_-]/}"
  printf '%s' "${value:-?}"
}

_dev_is_sha256() {
  [ "${#1}" -eq 64 ] && [ -n "$1" ] && [ -z "${1//[0-9a-f]/}" ]
}

dev_verified_add() {
  local list="$1" sha="$2" commit version built tmp
  _dev_is_sha256 "$sha" || { echo "dev-launcher: not a sha256: '$sha'" >&2; return 1; }
  commit="$(_dev_field "$3")"
  version="$(_dev_field "$4")"
  built="$(_dev_field "$5")"
  mkdir -p "$(dirname "$list")" || return 1
  tmp="$list.tmp.$$"
  {
    if [ -f "$list" ] && [ ! -L "$list" ]; then
      awk -v sha="$sha" '$1 != sha' "$list" || true
    fi
    printf '%s %s %s %s\n' "$sha" "$commit" "$version" "$built"
  } | tail -n "$DEV_VERIFIED_KEEP" >"$tmp" &&
    chmod 600 "$tmp" &&
    mv -f "$tmp" "$list"
}

dev_verified_lookup() {
  local list="$1" sha="$2" owner mode
  _dev_is_sha256 "$sha" || return 1
  [ -f "$list" ] && [ ! -L "$list" ] || return 1
  read -r owner mode < <(stat -c '%u %a' "$list" 2>/dev/null) || return 1
  [ "$owner" = "$(id -u)" ] || return 1
  # No write bit for group or other (octal digits 2, 3, 6, 7 in either place).
  case "$mode" in *[2367]?|*[2367]) return 1 ;; esac
  awk -v sha="$sha" '
    $1 == sha && NF == 4 { found = $2 " " $3 " " $4 }
    END { if (found == "") exit 1; print found }
  ' "$list"
}

dev_launcher_files() {
  printf '%s\n' \
    "start-$APP_SLUG-dev-build.sh" \
    scripts/lib/brand.sh \
    scripts/lib/dev-launcher.sh \
    scripts/retain-dev-build.sh \
    src-core/src/brand.rs \
    src-tauri/Cargo.toml
}

dev_launcher_dir() {
  printf '%s\n' "$1/dev-launcher"
}

dev_launcher_install() {
  local src="$1" dest="$2" root="$3" tmp file
  tmp="$dest.tmp.$$"
  rm -rf "$tmp"
  mkdir -p "$tmp" || return 1
  while IFS= read -r file; do
    if [ ! -f "$src/$file" ] || [ -L "$src/$file" ]; then
      echo "dev-launcher: $src/$file is missing or a link; the launcher copy was not updated" >&2
      rm -rf "$tmp"
      return 1
    fi
    mkdir -p "$tmp/$(dirname "$file")" && cp "$src/$file" "$tmp/$file" || { rm -rf "$tmp"; return 1; }
  done < <(dev_launcher_files)
  printf '%s\n' "$root" >"$tmp/source-root"
  chmod -R u+rwX,go-w "$tmp"
  chmod 755 "$tmp/start-$APP_SLUG-dev-build.sh" "$tmp/scripts/retain-dev-build.sh"
  # Swapped in whole: a launcher started mid-install reads one copy or the
  # other, never half of each.
  rm -rf "$dest.old"
  if [ -e "$dest" ]; then mv "$dest" "$dest.old" || { rm -rf "$tmp"; return 1; }; fi
  mv "$tmp" "$dest" || return 1
  rm -rf "$dest.old"
}

dev_desktop_exec() {
  local file="$1" exec="$2" tmp
  [ -f "$file" ] || return 0
  tmp="$file.tmp.$$"
  EXEC="$exec" awk '/^Exec=/ { print "Exec=" ENVIRON["EXEC"]; next } { print }' "$file" >"$tmp" &&
    chmod 755 "$tmp" &&
    mv -f "$tmp" "$file"
}
