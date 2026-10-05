# shellcheck shell=bash
# The app's names, for shell scripts. SOURCED, never run:
#
#   . "$ROOT/scripts/lib/brand.sh"
#
# No script spells the app's name itself. The name's forms are read from the
# backend's brand module (src-tauri/src/brand.rs, the one place they are
# written), and the built binary's name from src-tauri/Cargo.toml's `[[bin]]`,
# so a rename edits those two files and every script follows.
#
# Sets:
#   APP_DISPLAY       the name as shown to the user
#   APP_SLUG          lowercase form: file names, the state dir's leaf
#   APP_UPPER         uppercase form
#   APP_LEGACY_DISPLAY  the OLD name as it was shown to the user
#   APP_LEGACY_SLUG   lowercase form of the OLD name
#   APP_ENV_PREFIX    prefix of the app's environment variables
#   APP_LEGACY_ENV_PREFIX  the OLD prefix
#   APP_BIN_NAME      the built main binary: target/<profile>/$APP_BIN_NAME
#   APP_DEV_BIN_NAME  the frozen dev build's installed binary
#   APP_SHARE_DIR     see app_share_dir
# Functions:
#   app_share_dir         print the per-user dir the dev tooling installs into
#                         (the current name; the old one while only it exists)
#   app_env NAME [DFLT]   print the app's environment variable NAME — under
#                         the current prefix, else the old one — or DFLT
#   app_export NAME VALUE export the app's environment variable NAME
#   app_legacy_pids ROOT  print the pids of a running build that still carries
#                         the OLD name (checkout ROOT's, or an installed one)
#
# A name that cannot be read is an error, said out loud, and the `source`
# returns 1 — under `set -e` the caller stops there. Guessing a name instead
# would point a script at a binary or a folder that does not exist, and every
# one of these scripts fails silently when it does (a post-commit build that
# never installs, a guard that matches no process).
#
# `brand.rs` has a test (`the_shell_helper_reads_the_same_names`) that sources
# this file and holds every value to the Rust constants.

_brand_sh_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# The string literal a `macro_rules! <name>` in brand.rs expands to.
_brand_sh_macro() {
  awk -v start="macro_rules! $1 {" '
    index($0, start) == 1 { found = 1; next }
    found && /^[[:space:]]*"[^"]*"[[:space:]]*$/ {
      gsub(/^[[:space:]]*"|"[[:space:]]*$/, "")
      print
      exit
    }
    found && /^}/ { exit }
  ' "$_brand_sh_root/src-tauri/src/brand.rs" 2>/dev/null
}

# `name` of the first `[[bin]]` table in src-tauri/Cargo.toml.
_brand_sh_bin_name() {
  awk '
    /^\[\[bin\]\]/ { found = 1; next }
    /^\[/ { if (found) exit }
    found && /^name[[:space:]]*=[[:space:]]*"[^"]*"/ {
      sub(/^name[[:space:]]*=[[:space:]]*"/, "")
      sub(/".*$/, "")
      print
      exit
    }
  ' "$_brand_sh_root/src-tauri/Cargo.toml" 2>/dev/null
}

APP_DISPLAY="$(_brand_sh_macro app_name)"
APP_SLUG="$(_brand_sh_macro app_slug)"
APP_UPPER="$(_brand_sh_macro app_upper)"
APP_LEGACY_DISPLAY="$(_brand_sh_macro legacy_name)"
APP_LEGACY_SLUG="$(_brand_sh_macro legacy_slug)"
APP_LEGACY_UPPER="$(_brand_sh_macro legacy_upper)"
# The GitHub repository releases are published from, `<owner>/<name>`.
APP_REPO="$(_brand_sh_macro app_repo)"
APP_BIN_NAME="$(_brand_sh_bin_name)"

if [ -z "$APP_DISPLAY" ] || [ -z "$APP_SLUG" ] || [ -z "$APP_UPPER" ] || [ -z "$APP_LEGACY_DISPLAY" ] || [ -z "$APP_LEGACY_SLUG" ] || [ -z "$APP_LEGACY_UPPER" ]; then
  echo "scripts/lib/brand.sh: could not read the app's name from $_brand_sh_root/src-tauri/src/brand.rs" >&2
  return 1
fi
if [ -z "$APP_BIN_NAME" ]; then
  echo "scripts/lib/brand.sh: could not read the [[bin]] name from $_brand_sh_root/src-tauri/Cargo.toml" >&2
  return 1
fi

APP_ENV_PREFIX="${APP_UPPER}_"
APP_LEGACY_ENV_PREFIX="${APP_LEGACY_UPPER}_"
APP_DEV_BIN_NAME="$APP_SLUG-dev"

# The per-user directory the dev tooling installs into and logs to:
# ~/.local/share/<slug>. On Linux that is also the default state dir, but this
# deliberately ignores the state-dir override — what is frozen or installed
# here is per user, so a sandboxed session must not send it somewhere else
# (the backend's `storage::home_share_dir()` is the same path).
#
# The same resolution as the backend's: the current name if it exists, else
# the old name while only that exists (a machine the app has not been started
# on since the rename), else the current name.
app_share_dir() {
  local current="$HOME/.local/share/$APP_SLUG" old="$HOME/.local/share/$APP_LEGACY_SLUG"
  if [ "$APP_SLUG" != "$APP_LEGACY_SLUG" ] && [ ! -e "$current" ] && [ -e "$old" ]; then
    printf '%s\n' "$old"
  else
    printf '%s\n' "$current"
  fi
}
APP_SHARE_DIR="$(app_share_dir)"

# The pids of a running build made before the app was renamed, from checkout
# ROOT or installed: its binaries carry the old name, so the one-at-a-time
# guards — which look for the current names — would not see it, and two
# instances on one state corrupt it. Prints nothing when the name is unchanged
# or no such build runs.
#
# Also a CURRENT build that was started from the old-named per-user folder:
# the first launch after the rename moves that folder, and the process keeps
# the old path on its command line for as long as it runs.
app_legacy_pids() {
  [ "$APP_SLUG" != "$APP_LEGACY_SLUG" ] || return 0
  local root="$1" share="$HOME/.local/share/$APP_LEGACY_SLUG" path
  for path in \
    "$root/target/debug/$APP_LEGACY_SLUG" \
    "$root/target/release/$APP_LEGACY_SLUG" \
    "$share/$APP_LEGACY_SLUG-dev" \
    "$share/$APP_LEGACY_SLUG.AppImage" \
    "$share/$APP_LEGACY_SLUG" \
    "$share/$APP_DEV_BIN_NAME" \
    "$share/$APP_BIN_NAME.AppImage" \
    "$share/$APP_BIN_NAME" \
    "/usr/bin/$APP_LEGACY_SLUG"; do
    pgrep -f "^$path( |\$)" || true
  done
  pgrep -f "^/tmp/\\.mount_[^/]*/usr/bin/$APP_LEGACY_SLUG( |\$)" || true
}

# The value of the app's environment variable NAME (`<PREFIX>NAME`), or DFLT
# when it is unset or empty — `${<PREFIX>NAME:-DFLT}`.
#
# Read under the current prefix first, then under the old one (a shell that
# still exports the old names), as the backend's `brand::env` does.
app_env() {
  local var="${APP_ENV_PREFIX}$1" old="${APP_LEGACY_ENV_PREFIX}$1"
  if [ -z "${!var:-}" ] && [ "$var" != "$old" ] && [ -n "${!old:-}" ]; then
    printf '%s' "${!old}"
  else
    printf '%s' "${!var:-${2:-}}"
  fi
}

# Export the app's environment variable NAME with VALUE.
app_export() {
  export "${APP_ENV_PREFIX}$1=$2"
}
