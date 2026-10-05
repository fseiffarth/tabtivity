#!/usr/bin/env bash
# The rename's gate before the name changes: run the migrator's launch steps
# against a COPY of this user's real install, without starting the app.
#
#   scripts/brand-copy-run.sh [NewName] [--keep]
#
# Run it from a terminal of your own (not an agent tab: a fenced tab sees an
# empty stand-in for the state dir). It
#   1. copies the state dir, the webview's data dir and the archive entries
#      into a private temp home (mode 0700), skipping files over
#      $BRAND_COPY_RUN_MAX_SIZE (default 200m: VM disks, models);
#   2. re-points the absolute paths stored in the copy at the copy, so the
#      steps meet the paths a real launch would;
#   3. runs the ignored test `brand_migration::copy_run` over it, under the
#      name given (an invented one when none is), and
#   4. deletes the copy — it holds your credentials — unless --keep is given.
#
# The real install is only read. The phone host, the keyring, Docker and tmux
# are not touched: the driver records what it would have asked of them.
# The report lands in the git dir (never committed) and its path is printed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/brand.sh
. "$ROOT/scripts/lib/brand.sh"

name=""
keep=0
for arg in "$@"; do
  case "$arg" in
    --keep) keep=1 ;;
    -h | --help)
      sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*)
      echo "brand-copy-run: unknown option $arg" >&2
      exit 2
      ;;
    *) name="$arg" ;;
  esac
done

command -v rsync >/dev/null || { echo "brand-copy-run: rsync is needed for the copy" >&2; exit 1; }
command -v perl >/dev/null || { echo "brand-copy-run: perl is needed to re-point the stored paths" >&2; exit 1; }
[ -x "$HOME/.cargo/bin/cargo" ] && PATH="$HOME/.cargo/bin:$PATH"
command -v cargo >/dev/null || { echo "brand-copy-run: cargo is not on PATH" >&2; exit 1; }

share="$HOME/.local/share"
state="$share/$APP_LEGACY_SLUG"
webview="$share/io.github.fseiffarth.$APP_LEGACY_SLUG"
tree="$HOME/$APP_LEGACY_SLUG"

if [ ! -d "$state" ] || [ -L "$state" ]; then
  echo "brand-copy-run: $state is not a folder — no install under the old name to copy" >&2
  exit 1
fi
if [ ! -e "$state/projects.json" ]; then
  echo "brand-copy-run: $state holds no projects.json. From an agent tab the state dir is a stand-in; run this from your own terminal." >&2
  exit 1
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/brand-copy-run.XXXXXX")"
work="$(cd "$work" && pwd -P)"
chmod 700 "$work"
fake="$work/home"
cleanup() {
  if [ "$keep" -eq 1 ]; then
    echo "brand-copy-run: the copy is kept at $work (it holds your credentials; remove it with: rm -rf '$work')"
  else
    rm -rf "$work"
  fi
}
trap cleanup EXIT

max_size="${BRAND_COPY_RUN_MAX_SIZE:-200m}"
copy() { # copy <from dir> <to dir>
  mkdir -p "$2"
  rsync -a --no-specials --no-devices --max-size="$max_size" "$1/" "$2/"
}

echo "brand-copy-run: copying $state ($(du -sh "$state" 2>/dev/null | cut -f1)) …"
copy "$state" "$fake/.local/share/$APP_LEGACY_SLUG"
if [ -d "$webview" ]; then
  echo "brand-copy-run: copying $webview …"
  copy "$webview" "$fake/.local/share/io.github.fseiffarth.$APP_LEGACY_SLUG"
fi
mkdir -p "$fake/$APP_LEGACY_SLUG"
if [ -d "$tree/archive" ]; then
  # The archive's entries only: they hold paths into the state dir.
  rsync -a --prune-empty-dirs --include='*/' --include='entry.json' --exclude='*' \
    "$tree/archive/" "$fake/$APP_LEGACY_SLUG/archive/"
fi

echo "brand-copy-run: re-pointing stored paths at the copy …"
# Text files only (-I); a path inside a database stays as it is.
{ grep -rlIZ -F -- "$HOME/" "$fake" 2>/dev/null || true; } |
  FROM="$HOME/" TO="$fake/" xargs -0 -r perl -pi -e 's/\Q$ENV{FROM}\E/$ENV{TO}/g'

report="$(git -C "$ROOT" rev-parse --absolute-git-dir)/brand-copy-run-report.txt"
echo "brand-copy-run: running the launch steps over the copy …"
status=0
BRAND_COPY_RUN_HOME="$fake" BRAND_COPY_RUN_NAME="$name" \
  cargo test --manifest-path "$ROOT/src-tauri/Cargo.toml" --lib -- \
  --ignored --exact services::brand_migration::copy_run::copy_run --nocapture 2>&1 |
  tee "$report" || status=$?

echo
echo "brand-copy-run: report written to $report"
exit "$status"
