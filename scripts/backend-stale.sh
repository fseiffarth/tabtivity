#!/usr/bin/env bash
# Is the RUNNING Tabtivity older than the backend source on disk?
#
# `npm run tauri:dev` passes `--no-watch`, so a `src-tauri/` edit no longer
# rebuilds and relaunches the window out from under whoever is using it (open
# tabs, live terminals, and a frontend reloaded from whatever uncommitted WIP
# happens to be on disk — a surprise restart is indistinguishable from the app
# breaking). The cost of that is the opposite failure: a backend fix that is
# saved, compiles, and simply is not in the window, with nothing saying so.
#
# This is the thing that says so. It is deliberately a plain script rather than
# anything in-app — reporting "the backend is stale" from the backend would
# need the very rebuild it is reporting on. It never starts or stops anything
# (AGENTS.md "Running"); it prints and exits.
#
# Exit 0 = the running app matches the source (or nothing is running).
# Exit 1 = a rebuild/restart is needed to pick up the changes.
set -euo pipefail

# --mobile-only reports just the embedded-PWA seam. Backend staleness is
# EXPECTED here — `--no-watch` exists precisely so src-tauri edits pile up
# until the user restarts deliberately (AGENTS.md "Running") — so anything
# that fires on its own must not shout about it, or it becomes noise and gets
# ignored. The embedded mobile bundle is the seam nothing else announces.
mobile_only=0
if [ "${1:-}" = "--mobile-only" ]; then
  mobile_only=1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The app's names (scripts/lib/brand.sh): $APP_DISPLAY, $APP_SLUG, $APP_BIN_NAME, …
. "$ROOT/scripts/lib/brand.sh"
APP_DIR="$(app_env APP_DIR "$APP_SHARE_DIR")"
STATE_DIR="$(app_env STATE_DIR "$APP_DIR")"

# ---------------------------------------------------------------------------
# Which Tabtivity is running?
#
# The hot-reload dev binary is only one of the shapes this takes: `npm run
# package:dev` freezes the tree at tabtivity-dev and `npm run package` installs
# tabtivity[.AppImage]. Matching only target/debug made this script print "nothing
# to be stale against" and exit 0 — a false all-clear — for precisely the
# builds whose backend cannot hot-reload at all, and whose embedded mobile PWA
# is therefore the most likely thing in the window to be months behind.
#
# Order matters: `^$APP_DIR/tabtivity` prefix-matches the other two, so the
# specific paths are tried first.
# ---------------------------------------------------------------------------
# What the frozen dev build is called below (matched again where the advice is
# printed).
FROZEN_KIND="frozen \"$APP_DISPLAY (dev)\" build"
app_pid=""
app_kind=""
while IFS='|' read -r path kind; do
  [ -n "$path" ] || continue
  pid="$(pgrep -f "^$path" | head -n 1 || true)"
  if [ -n "$pid" ]; then
    app_pid="$pid"
    app_kind="$kind"
    break
  fi
done <<EOF
$ROOT/target/debug/$APP_BIN_NAME|hot-reload dev session
$ROOT/target/release/$APP_BIN_NAME|release binary from the checkout
$APP_DIR/$APP_DEV_BIN_NAME|$FROZEN_KIND
$APP_DIR/$APP_BIN_NAME.AppImage|packaged AppImage
$APP_DIR/$APP_BIN_NAME|packaged build
EOF

# An AppImage execs its payload out of a FUSE mount, so the process actually
# serving the sidecar has /tmp/.mount_*/usr/bin/tabtivity on its cmdline and
# matches none of the paths above.
if [ -z "$app_pid" ]; then
  app_pid="$(pgrep -f "^/tmp/\\.mount_[^/]*/usr/bin/$APP_BIN_NAME" | head -n 1 || true)"
  if [ -n "$app_pid" ]; then
    app_kind="running AppImage"
  fi
fi

# A build made before the app was renamed runs under the old binary names.
if [ -z "$app_pid" ]; then
  app_pid="$(app_legacy_pids "$ROOT" | head -n 1 || true)"
  if [ -n "$app_pid" ]; then
    app_kind="build from before the rename"
  fi
fi

started=0
if [ -n "$app_pid" ]; then
  # The proc entry's mtime is the process start time (Linux). Preferred over
  # parsing `ps -o lstart`, whose format follows the locale.
  started="$(stat -c %Y "/proc/$app_pid" 2>/dev/null || echo 0)"
fi

newest_ts() {
  find "$@" -type f -printf '%T@\n' 2>/dev/null | sort -nr | head -n 1 | cut -d. -f1
}

mobile_entry() {
  # The hashed entry script name is the bundle's identity.
  grep -o '/assets/index-[A-Za-z0-9_-]*\.js' "$1" 2>/dev/null | head -n 1
}

# ---------------------------------------------------------------------------
# The exact check: ask the running sidecar which bundle it is serving.
#
# The phone's PWA is EMBEDDED INTO THE BINARY at compile time (src-tauri/
# build.rs bakes mobile-dist/ in), so the sidecar serves the bundle as of its
# own build and no src-tauri mtime says so. Everything else here is an mtime
# proxy; this is ground truth, and it is the one seam where the proxy is wrong
# in both directions — a rebuilt-but-byte-identical bundle looks stale, and a
# binary built somewhere else entirely looks current.
# ---------------------------------------------------------------------------
served_entry=""
probe_note=""
port="$(node -e 'const fs=require("node:fs");let p=8742;try{p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))?.[process.argv[2]]?.port??8742}catch(e){}process.stdout.write(String(p))' \
  "$STATE_DIR/settings.json" "${APP_SLUG}_mobile_host" 2>/dev/null || echo 8742)"
if command -v curl >/dev/null 2>&1; then
  shell_html="$(curl -fsS --max-time 2 "http://127.0.0.1:$port/" 2>/dev/null || true)"
  if [ -n "$shell_html" ]; then
    served_entry="$(printf '%s' "$shell_html" | grep -o '/assets/index-[A-Za-z0-9_-]*\.js' | head -n 1)"
  else
    probe_note="  ($APP_DISPLAY Mobile is off or not listening on 127.0.0.1:$port, so the embedded
   bundle could only be checked by mtime.)"
  fi
else
  probe_note="  (curl is unavailable, so the embedded bundle could only be checked by mtime.)"
fi

built_entry="$(mobile_entry "$ROOT/mobile-dist/index.html")"

# The bundle a commit PUBLISHED for the running sidecar to pick up without a
# relaunch (scripts/package-dev.sh publish_live_pwa). When one is present it,
# not mobile-dist/, is what the phone should be on: the overlay wins over the
# bundle compiled into the binary.
live_entry=""
live_commit=""
live_built=""
live_stamp="$ROOT/target/mobile-pwa/.stamp"
if [ -r "$live_stamp" ]; then
  live_entry="$(sed -n 's/^entry=//p' "$live_stamp" | head -n 1)"
  live_commit="$(sed -n 's/^commit=//p' "$live_stamp" | head -n 1)"
  live_built="$(sed -n 's/^built=//p' "$live_stamp" | head -n 1)"
fi
expected_entry="${live_entry:-$built_entry}"

if [ -z "$app_pid" ] && [ -z "$served_entry" ]; then
  if [ "$mobile_only" = "0" ]; then
    echo "No $APP_DISPLAY is running — nothing to be stale against."
  fi
  exit 0
fi

stale=0
backend_msg=""
mobile_msg=""
ahead_msg=""

# --- backend sources vs. the running process -------------------------------
# Build outputs are excluded — target/ is written BY the build, so including it
# would make every run look fresh immediately after a compile.
newest=0
newest_file=""
while IFS=' ' read -r ts path; do
  ts="${ts%.*}"
  if [ "$ts" -gt "$newest" ]; then
    newest="$ts"
    newest_file="$path"
  fi
done < <(
  find "$ROOT/src-tauri" \
    -path "$ROOT/src-tauri/target" -prune -o \
    -type f \( -name '*.rs' -o -name 'Cargo.toml' -o -name 'Cargo.lock' -o -name '*.conf.json' \) \
    -printf '%T@ %p\n'
)

if [ "$mobile_only" = "0" ] && [ "$started" != "0" ] && [ "$newest" -gt "$started" ]; then
  stale=1
  rel="${newest_file#"$ROOT"/}"
  backend_msg="BACKEND IS STALE — the running window predates your backend changes.
  running pid : $app_pid ($app_kind, started $(date -d "@$started" '+%F %T'))
  newest edit : $rel ($(date -d "@$newest" '+%F %T'))"
fi

# --- the two mobile seams --------------------------------------------------
# They go stale independently: mobile-web sources newer than the built bundle
# (the bundle needs `npm run mobile:build` — `beforeDevCommand` is `npm run
# dev`, which does NOT build it), and a built bundle the running process was
# compiled before (a rebuild re-embeds it). Both showed up as "the phone is
# missing a feature that is plainly in the code".
mobile_src="$(newest_ts "$ROOT/mobile-web/src" "$ROOT/mobile-web/public" "$ROOT/vite.mobile.config.ts" "$ROOT/tsconfig.mobile.json")"
mobile_dist="$(newest_ts "$ROOT/mobile-dist")"
if [ -n "$mobile_src" ] && [ -n "$mobile_dist" ] && [ "$mobile_src" -gt "$mobile_dist" ]; then
  stale=1
  mobile_msg="MOBILE BUNDLE IS STALE — mobile-web/ sources are newer than mobile-dist/.
  Run 'npm run mobile:build', then rebuild the backend to re-embed it."
elif [ -n "$served_entry" ] && [ -n "$expected_entry" ] && [ "$served_entry" != "$expected_entry" ]; then
  # Ground truth beat the mtimes: the sidecar named a different bundle.
  stale=1
  if [ -n "$live_entry" ]; then
    # A bundle was published FOR this sidecar and it is not serving it. Either
    # the running window predates the overlay support (it is compiled in, so the
    # first pickup costs exactly one relaunch) or it refused the publish as not
    # newer than its own embedded copy.
    mobile_msg="MOBILE PWA IS STALE — a bundle is published for the running sidecar on
  127.0.0.1:$port, and it is serving a different one. Either this window was built
  before the live-overlay support, or it refused the publish as older than its own.
  serving   : $served_entry
  published : $live_entry ($live_commit)
  One relaunch of the window picks the overlay up; after that, commits reach the
  phone on their own and a pull-to-refresh is the whole update path."
  else
    mobile_msg="EMBEDDED MOBILE PWA IS STALE — the sidecar on 127.0.0.1:$port is serving a
  different bundle than the one built in mobile-dist/. The phone is on the old one.
  serving : $served_entry
  built   : $built_entry"
  fi
elif [ -n "$served_entry" ] && [ -n "$live_entry" ] && [ "$served_entry" = "$live_entry" ] \
     && [ -n "$live_built" ] && [ "$started" != "0" ] && [ "$live_built" -gt "$started" ]; then
  # Not stale — the opposite. Worth one line anyway: the overlay moves the PWA
  # and nothing else, so the phone is running a bundle newer than the HTTP API
  # answering it, and a mobile feature whose backend half landed after this
  # window started will render and then fail its request.
  mobile_msg="THE PHONE IS AHEAD OF THE RUNNING BACKEND — it is serving the published
  bundle ($live_commit, $(date -d "@$live_built" '+%F %T')), which is newer than this window
  (started $(date -d "@$started" '+%F %T')). The overlay carries the PWA only, not the
  sidecar's API, so a mobile feature whose backend half is not in this window will
  render and fail until you relaunch. Nothing to do if the phone looks right."
elif [ -z "$served_entry" ] && [ -n "$mobile_dist" ] && [ "$started" != "0" ] && [ "$mobile_dist" -gt "$started" ]; then
  stale=1
  mobile_msg="EMBEDDED MOBILE PWA IS STALE — the running app was built before the current
  mobile-dist/ bundle ($(date -d "@$mobile_dist" '+%F %T')); the phone is being served the old one.
$probe_note"
fi

# --- the sidecar's own copy of the backend ---------------------------------
# The phone's HTTP API is not this window's process. `mobile_host_apply` copies
# the running image to bin/<version>/tabtivity-mobile-host and the service manager
# runs that copy — and the directory is keyed by the version ALONE, so every
# build between two pushes shares one, and the copy answering the phone is
# whichever of them installed first. Nothing said so, in either direction: the
# version strings matched, so Settings → Mobile did not offer the update either,
# while a route added after that copy 404s with its code plainly in the window.
# That is how the project screen's outbox shelf stayed invisible (2026-09-20) —
# and why this seam is reported even in --mobile-only: it is not the expected
# pile-up of unbuilt src-tauri edits, it is two installed artifacts disagreeing.
sidecar_msg=""
host_pid="$(pgrep -f -- '--mobile-host' | head -n 1 || true)"
if [ -n "$host_pid" ] && [ -n "$app_pid" ]; then
  # Both images are measured THROUGH `/proc/<pid>/exe` with `stat -L`, never
  # through the path that link resolves to. `readlink -f` answers
  # "…/tabtivity-dev (deleted)" the moment a rebuild unlinks the file under the
  # running window — unreadable, so this check used to skip in silence in the
  # very shape it exists for (2026-09-21: the sidecar was nine hours behind the
  # window and nothing said so). And when the path does still exist it is the
  # wrong file: what an install would copy is the image the window is RUNNING,
  # not whatever now sits at its old name. `-L` follows the magic link to the
  # live inode either way; the resolved path is kept for the report alone.
  host_exe="$(readlink "/proc/$host_pid/exe" 2>/dev/null | sed 's/ (deleted)$//' || true)"
  app_exe="$(readlink "/proc/$app_pid/exe" 2>/dev/null | sed 's/ (deleted)$//' || true)"
  host_size="$(stat -Lc %s "/proc/$host_pid/exe" 2>/dev/null || echo 0)"
  app_size="$(stat -Lc %s "/proc/$app_pid/exe" 2>/dev/null || echo 0)"
  host_built="$(stat -Lc %Y "/proc/$host_pid/exe" 2>/dev/null || echo 0)"
  app_built="$(stat -Lc %Y "/proc/$app_pid/exe" 2>/dev/null || echo 0)"
  if [ "$host_size" != "0" ] && [ "$app_size" != "0" ] \
     && { [ "$host_size" != "$app_size" ] || [ "$host_built" -lt "$app_built" ]; }; then
    stale=1
    sidecar_msg="THE PHONE'S API IS STALE — the sidecar answering the phone is an older copy of
  the backend than the window itself, so a mobile feature whose backend half is
  newer than that copy renders and then 404s.
  window  : ${app_exe:-pid $app_pid} ($(date -d "@$app_built" '+%F %T'), $app_size bytes)
  sidecar : ${host_exe:-pid $host_pid} ($(date -d "@$host_built" '+%F %T'), $host_size bytes)
  The header's Mobile menu -> \"Reconnect\" reinstalls the sidecar from this window
  and restarts it alone — so does Settings -> Mobile -> \"Update mobile host\" where
  the window is new enough to offer it. The window keeps its tabs, and the phone
  needs only a pull-to-refresh afterwards."
  fi
fi

# --- the desktop frontend seam ---------------------------------------------
# Only the hot-reload session gets `src/` for free: vite serves it and HMR pushes
# every edit into the window. Every other shape — the frozen "Tabtivity (dev)"
# build, the packaged one, the AppImage — has the frontend COMPILED IN, so it
# goes stale exactly like the backend does, and nothing said so. The symptom is
# not an error: the window simply renders an older UI than the hot-reload one
# and looks like a bug in the feature you are staring at (2026-09-04).
#
# Ground truth first, same as the sidecar probe above: vite renames the entry
# bundle on every rebuild, so the key baked into the running executable either
# is the one dist/index.html names or the window is on an older build. Read from
# /proc/<pid>/exe, which resolves an AppImage's payload inside its own mount too.
desktop_msg=""
if [ "$mobile_only" = "0" ] && [ -n "$app_pid" ] && [ "$app_kind" != "hot-reload dev session" ]; then
  desktop_built="$(grep -o '/assets/[A-Za-z0-9_.-]*\.js' "$ROOT/dist/index.html" 2>/dev/null | head -n 1)"
  exe="$(readlink -f "/proc/$app_pid/exe" 2>/dev/null || true)"
  if [ -n "$desktop_built" ] && [ -n "$exe" ] && [ -r "$exe" ] \
     && ! grep -qaF -- "$desktop_built" "$exe"; then
    stale=1
    # The binary also carries the phone's bundle; naming that as the desktop
    # frontend would send the reader after the wrong seam. The one to drop is
    # the bundle this very binary's sidecar is SERVING — its own mobile entry,
    # not the one currently built in mobile-dist/, which is a different key
    # precisely because the binary is stale.
    embedded="$(grep -aoE '/assets/index-[A-Za-z0-9_-]+\.js' "$exe" 2>/dev/null \
      | sort -u \
      | grep -vxF -- "${served_entry:-/dev/null}" \
      | grep -vxF -- "${built_entry:-/dev/null}" | tr '\n' ' ')"
    desktop_msg="EMBEDDED FRONTEND IS STALE — the running $app_kind was built against an older
  dist/ than the one on disk, so the window is showing an older UI than the
  hot-reload one would.
  running : ${embedded:-(no bundle key found)}
  built   : $desktop_built"
  elif [ "$started" != "0" ]; then
    src_ts="$(newest_ts "$ROOT/src" "$ROOT/index.html" "$ROOT/vite.config.ts")"
    if [ -n "$src_ts" ] && [ "$src_ts" -gt "$started" ]; then
      stale=1
      desktop_msg="FRONTEND MAY BE STALE — src/ has changes ($(date -d "@$src_ts" '+%F %T')) newer than the
  running $app_kind, which compiled its frontend in. Nothing hot-reloads here."
    fi
  fi
elif [ "$mobile_only" = "0" ] && [ -n "$served_entry" ] && [ -n "$built_entry" ] \
     && [ "$served_entry" != "$built_entry" ] && [ "$served_entry" != "${live_entry:-}" ]; then
  # No pid — pgrep saw nothing, which also happens when this runs from inside an
  # agent tab, where the sandbox hides the host's processes. The sidecar still
  # answered over loopback, and it answered with an OLDER bundle than the one
  # just built: whatever window is open was launched from an older binary, and
  # its desktop UI is that old too, not just the phone's.
  stale=1
  desktop_msg="THE OPEN WINDOW PREDATES THE CURRENT BUILD — the sidecar is serving a bundle
  built before the one in mobile-dist/, so the window's compiled-in frontend is
  behind your tree as well. It is not only the phone that is on the old code."
  # `package:dev` installs but never relaunches (AGENTS.md "Running"), and a
  # running frozen instance keeps its old inode — so the usual shape of this is
  # a fresh snapshot sitting on disk that simply nobody has relaunched into.
  desktop_built="${desktop_built:-$(grep -o '/assets/[A-Za-z0-9_.-]*\.js' "$ROOT/dist/index.html" 2>/dev/null | head -n 1)}"
  for snapshot in "$APP_DIR/$APP_DEV_BIN_NAME" "$APP_DIR/$APP_BIN_NAME" "$APP_DIR/$APP_BIN_NAME.AppImage"; do
    [ -r "$snapshot" ] || continue
    [ -n "$desktop_built" ] || continue
    if grep -qaF -- "$desktop_built" "$snapshot"; then
      desktop_msg="$desktop_msg
  A CURRENT snapshot is already installed at $snapshot — quit the open
  window and relaunch it; that alone picks the new build up."
      break
    fi
  done
fi

if [ "$stale" = "0" ]; then
  if [ "$mobile_only" = "1" ]; then
    if [ -n "$ahead_msg" ]; then printf '%s\n' "$ahead_msg"; fi
    exit 0
  fi
  if [ -n "$app_pid" ]; then
    echo "Backend is current: running pid $app_pid ($app_kind) started after the newest"
    if [ -n "$live_entry" ] && [ "$served_entry" = "$live_entry" ]; then
      echo "src-tauri change, and the phone is on the published bundle ($live_commit)."
    else
      echo "src-tauri change, and its embedded mobile PWA matches mobile-dist/."
    fi
    if [ "$app_kind" != "hot-reload dev session" ]; then
      echo "Its compiled-in frontend matches dist/ too."
    fi
  else
    echo "No $APP_DISPLAY process was identified, but the sidecar on 127.0.0.1:$port is serving"
    echo "$served_entry — the bundle built in mobile-dist/. The Rust side could not be checked."
  fi
  exit 0
fi

first=1
for msg in "$backend_msg" "$mobile_msg" "$sidecar_msg" "$ahead_msg" "$desktop_msg"; do
  [ -n "$msg" ] || continue
  [ "$first" = "1" ] || echo
  echo "$msg"
  first=0
done
echo
case "$app_kind" in
  "hot-reload dev session")
    echo "Frontend (src/) changes are already live via vite HMR; only src-tauri/ (and the"
    echo "embedded mobile bundle) need this. Pick them up yourself when it suits you:"
    ;;
  "")
    echo "Pick the changes up yourself when it suits you:"
    ;;
  *)
    echo "Nothing hot-reloads in this shape — src/, src-tauri/ and both bundles are all"
    echo "compiled in. Pick the changes up yourself when it suits you:"
    ;;
esac
case "$app_kind" in
  "hot-reload dev session")
    echo "  pkill -f '$ROOT/node_modules/.bin/tauri'; pkill -f '$ROOT/target/debug/$APP_BIN_NAME'"
    echo "  ./start-$APP_SLUG-tauri-hotreload.sh"
    ;;
  "$FROZEN_KIND")
    # The commit hook refreezes on its own; when it could not, say so here —
    # its notification has no session bus to reach from an agent tab.
    if [ -f "$APP_DIR/package-dev-auto.failed" ]; then
      read -r fcommit fstatus fwhen <"$APP_DIR/package-dev-auto.failed"
      echo "  The post-commit auto-freeze FAILED at commit $fcommit ($fwhen, status $fstatus):"
      echo "  see $APP_DIR/package-dev-auto.log. Fix the build, or freeze by hand:"
    fi
    echo "  npm run package:dev   # refreezes the tree, mobile bundle included"
    echo "  then quit and relaunch the \"$APP_DISPLAY (dev)\" entry"
    ;;
  "packaged AppImage"|"packaged build"|"running AppImage")
    echo "  npm run package       # rebuilds and reinstalls, mobile bundle included"
    echo "  then quit and relaunch $APP_DISPLAY"
    ;;
  *)
    echo "  rebuild whichever $APP_DISPLAY you are running, then relaunch it"
    ;;
esac
exit 1
