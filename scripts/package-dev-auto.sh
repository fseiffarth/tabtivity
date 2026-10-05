#!/usr/bin/env bash
# Move the frozen "Tabtivity (dev)" snapshot to the commit that was just made.
#
# The frozen window is where the day's real work happens, so it is only ever
# as good as the last time somebody remembered to re-freeze it. A commit is the
# honest moment to move it: it is the point where a change is finished, it is
# frequent, and it is local (never CI). And it freezes THE COMMIT — package-dev
# `--head` builds HEAD from a detached worktree — not the working tree around
# it: a tree freeze swept in whatever other edits happened to be dirty (another
# agent's half-done work, labelled "+local"), and an `npm run build` landing
# mid-compile could fail the finished binary's own check (2026-09-14). By hand,
# `npm run package:dev` still freezes the live tree, on purpose.
#
# Three properties make that safe to do automatically:
#
# * **It never delays the commit.** `--queue` returns at once and the build
#   runs detached, surviving the terminal that committed.
# * **It never stacks.** A second commit while a build is running leaves a
#   pending marker instead of a second build, and the running build is
#   CANCELLED for it (user, 2026-09-22): finishing a snapshot that is already
#   superseded only delays the one that matters by the 3-4 minutes it takes.
#   The loop then starts over on the newest commit, so ten commits (or a
#   rebase) cost one build and the binary ends up matching the LAST tree, not
#   an intermediate one. Only the compile is cancellable: once cargo is done
#   (package-dev.sh touches the INSTALLING mark) the pass runs to the end,
#   because killing an `install` halfway leaves a truncated binary installed.
#   Each pass also waits until no commit has landed for SETTLE_SECONDS, so a
#   burst of commits made seconds apart (a split commit series, a rebase) is
#   one build of the last one — without it the first commit started a build
#   at once and the rest queued a second (2026-09-17: five commits, two builds).
# * **It never wins a fight for the machine.** The build is nice'd, ionice'd
#   and put on SCHED_IDLE where available — the same posture heavy local jobs
#   take in this project, because a 3-4 minute release build at full tilt is
#   felt in every keystroke of the window it exists to serve.
#
# It builds and installs; it NEVER launches or stops Tabtivity (user, 2026-07-29).
# A running frozen instance keeps its old inode and picks the new snapshot up
# on its next launch, which is what the completion notification says.
#
# Off switch, in order of scope:
#   git config tabtivity.autoDevBuild false   # this clone, permanently
#   package-dev-auto.sh --pause            # until --resume (the dev-build chip's
#                                          # "Pause auto-builds"); also cancels a
#                                          # running compile to free the machine
#   package-dev-auto.sh --build-now        # while paused: one build of HEAD, if
#                                          # it is newer than the snapshot; stays
#                                          # paused (the chip's "Build now")
#   TABTIVITY_NO_AUTO_DEV_BUILD=1 git commit  # one commit
# Log: ~/.local/share/tabtivity/package-dev-auto.log (the last build's output).
set -uo pipefail

# A post-commit hook inherits git's own environment, and GIT_INDEX_FILE arrives
# RELATIVE (".git/index"). Every `git -C "$FREEZE_TREE" …` in package-dev.sh
# then resolves it against the worktree, where `.git` is a file, not a
# directory — so the freeze checkout died on "index.lock: Not a directory" and
# every commit's build failed at pass 1 while --status still read "idle"
# (2026-09-14). The build wants a clean git environment, not the committing
# one's.
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_PREFIX GIT_OBJECT_DIRECTORY

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The app's names (scripts/lib/brand.sh): $APP_DISPLAY, $APP_SLUG, $APP_BIN_NAME, …
. "$ROOT/scripts/lib/brand.sh" || exit 1
SELF="$ROOT/scripts/package-dev-auto.sh"
# Beside the binary package-dev.sh installs, and for the same reason it hardcodes
# that path: what is frozen here is per-user, not per-state-dir, so a sandbox
# session's TABTIVITY_STATE_DIR must not send these somewhere else.
APP_DIR="$APP_SHARE_DIR"
BINARY="$APP_DIR/$APP_DEV_BIN_NAME"
LOCK_DIR="$APP_DIR/package-dev-auto.lock"
PENDING="$APP_DIR/package-dev-auto.pending"
STAMP="$APP_DIR/package-dev-auto.stamp"
# The last pass that failed: "<commit> <status> <when>". Left where --status,
# backend-stale.sh and the launcher can read it, because the notification
# below has no session bus to reach from an agent tab, and a failure nobody
# sees is how the desktop icon stayed a day behind a green commit
# (2026-09-15: a mid-series commit that did not compile broke the pass, the
# loop stopped, and the commit that DID compile sat "queued" for good).
FAILED="$APP_DIR/package-dev-auto.failed"
LOG="$APP_DIR/package-dev-auto.log"
LOG_MAX_BYTES=$((4 * 1024 * 1024))
# Touched by package-dev.sh once the compile is finished: past it, a pass is
# no longer cancelled for a newer commit.
INSTALLING="$APP_DIR/package-dev-auto.installing"
# Present while auto-builds are paused (`--pause`, the dev-build chip's
# button): the machine's cores are wanted for something else. Nothing queues,
# and a running pass is cancelled like one superseded by a newer commit.
PAUSED="$APP_DIR/package-dev-auto.paused"
# Present while a `--build-now` pass runs despite the pause: the loop builds
# through it, and drops it after one pass. Never consulted by queue(), so a
# leftover one cannot make commits build while paused.
ONCE="$APP_DIR/package-dev-auto.once"
FREEZE_TREE="$ROOT/target/freeze-tree"
# The status build_once returns for a pass it cancelled (128 + SIGTERM).
CANCELLED=143
SETTLE_SECONDS="$(app_env DEV_BUILD_SETTLE 30)"

# Paused, unless the user asked for this one pass (`--build-now`).
paused() { [ -f "$PAUSED" ] && [ ! -f "$ONCE" ]; }

note() { printf '%s %s\n' "$(date -Is)" "$*"; }

notify() { # urgency, title, body
  command -v notify-send >/dev/null 2>&1 || return 0
  notify-send -u "$1" -a "$APP_DISPLAY" "$2" "$3" 2>/dev/null || true
}

# Every reason not to touch the frozen build, cheapest first. `declined once`
# is `--build-now`'s check: the user's click outranks only the pause.
declined() {
  [ "$(app_env NO_AUTO_DEV_BUILD)" = "1" ] && { echo "disabled for this commit"; return 0; }
  [ -n "${CI:-}" ] && { echo "running in CI"; return 0; }
  [ "${1:-}" != once ] && [ -f "$PAUSED" ] && { echo "paused (resume from the dev-build menu, or --resume)"; return 0; }
  # An agent tab's commit runs this hook inside the agent fence, whose $HOME is
  # the agent's own: the lock, stamp and install would all land in a throwaway
  # copy while the real snapshot never moves (2026-09-25: 27 commits behind).
  # The window runs on the host and queues it from the dev-build chip's poll
  # (services::dev_build::queue_if_behind).
  [ -n "$(app_env AGENT_FENCE)" ] && { echo "inside an agent fence — the $APP_DISPLAY window queues it"; return 0; }
  # Under the current name, and under the old one: a clone switched off
  # before the app was renamed stays off.
  local key
  for key in "$APP_SLUG.autoDevBuild" "$APP_LEGACY_SLUG.autoDevBuild"; do
    case "$(git -C "$ROOT" config --bool --get "$key" 2>/dev/null)" in
      false) echo "disabled by git config $key"; return 0 ;;
    esac
  done
  # A linked worktree is somebody else's tree — an agent's, usually. Freezing
  # THAT over the user's dev binary is exactly the surprise this must not be.
  local git_dir common_dir
  git_dir="$(git -C "$ROOT" rev-parse --absolute-git-dir 2>/dev/null)" || { echo "not a git checkout"; return 0; }
  # `--git-common-dir` answers relative to the repo, not to whatever cwd a hook
  # happened to inherit.
  common_dir="$(cd "$ROOT" && cd "$(git rev-parse --git-common-dir 2>/dev/null)" && pwd)" || common_dir=""
  [ "$git_dir" != "$common_dir" ] && { echo "a linked worktree, not the main checkout"; return 0; }
  [ -x "$ROOT/scripts/package-dev.sh" ] || { echo "scripts/package-dev.sh is not executable"; return 0; }
  return 1
}

# What the frozen build would be built FROM: the commit, exactly — the
# --head freeze reads nothing from the working tree.
tree_signature() {
  git -C "$ROOT" rev-parse HEAD 2>/dev/null
}

queue() {
  if declined >/dev/null; then
    return 0
  fi
  mkdir -p "$APP_DIR" || return 0
  : >"$PENDING"
  # Detached from the committing shell: `git commit` returns now, and closing
  # the terminal (or the editor that ran it) does not take the build with it.
  setsid nohup "$SELF" --run </dev/null >/dev/null 2>&1 &
  disown 2>/dev/null || true
  printf '%s (dev): rebuilding the frozen snapshot in the background (%s)\n' "$APP_DISPLAY" "$LOG"
}

# One build attempt. Prints into the (already redirected) log; returns the
# build's own status.
build_once() {
  local signature
  signature="$(tree_signature)"
  if [ -f "$STAMP" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$signature" ] && [ -x "$BINARY" ]; then
    note "tree unchanged since the installed snapshot ($signature) — nothing to build"
    return 0
  fi
  note "building $ROOT @ $(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null)"
  local -a low=()
  command -v chrt >/dev/null 2>&1 && low+=(chrt --idle 0)
  command -v ionice >/dev/null 2>&1 && low+=(ionice -c 3)
  low+=(nice -n 19)
  # A hook inherits whatever environment the committing shell had, and a GUI
  # git client's has no ~/.cargo/bin at all.
  rm -f "$INSTALLING"
  # Its own process group (setsid in a non-leader child sets it up in place,
  # so the pid is the group id), so a cancel reaches npm, cargo and every
  # rustc under them rather than just the npm at the top.
  PACKAGE_DEV_INSTALLING_MARK="$INSTALLING" PATH="$HOME/.cargo/bin:$PATH" \
    setsid "${low[@]}" npm --prefix "$ROOT" run package:dev -- --head &
  local build=$!
  while kill -0 "$build" 2>/dev/null; do
    if paused && [ ! -f "$INSTALLING" ]; then
      note "auto-builds paused — cancelling this build"
      cancel_build "$build"
      return "$CANCELLED"
    fi
    if [ -f "$PENDING" ] && [ ! -f "$INSTALLING" ]; then
      note "a newer commit landed — cancelling this build"
      cancel_build "$build"
      return "$CANCELLED"
    fi
    sleep 2
  done
  wait "$build"
  local status=$?
  rm -f "$INSTALLING"
  if [ "$status" -eq 0 ]; then
    # Stamped from HEAD as it was BEFORE the build, so a commit made while the
    # build ran is not mistaken for something already frozen.
    printf '%s\n' "$signature" >"$STAMP"
  fi
  return "$status"
}

# Stop a build_once build and clear what a kill can leave half-done.
cancel_build() { # pid (= process group id)
  local pid="$1" waited=0
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 20 ]; do
    sleep 0.5
    waited=$((waited + 1))
  done
  kill -KILL -- "-$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null
  # A checkout killed mid-way leaves the freeze tree's index.lock, and every
  # later `git checkout` there refuses to start. The tree is this build's own.
  local git_dir
  if git_dir="$(git -C "$FREEZE_TREE" rev-parse --absolute-git-dir 2>/dev/null)"; then
    rm -f "$git_dir/index.lock"
  fi
  # A phone-bundle publish killed before its swap leaves its staging copy.
  rm -rf "$ROOT/target/mobile-pwa.tmp."*
}

run() {
  mkdir -p "$APP_DIR" || return 0
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    # Held — by a live build, whose loop will pick our marker up, or by a
    # crashed one whose lock nobody removed.
    local holder
    holder="$(cat "$LOCK_DIR/pid" 2>/dev/null || echo 0)"
    if [ "$holder" -gt 0 ] 2>/dev/null && kill -0 "$holder" 2>/dev/null; then
      return 0
    fi
    rm -rf "$LOCK_DIR"
    mkdir "$LOCK_DIR" 2>/dev/null || return 0
  fi
  printf '%s\n' "$$" >"$LOCK_DIR/pid"
  trap 'rm -rf "$LOCK_DIR" "$ONCE"' EXIT

  if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG" 2>/dev/null || echo 0)" -gt "$LOG_MAX_BYTES" ]; then
    mv -f "$LOG" "$LOG.1"
  fi
  exec >>"$LOG" 2>&1
  printf '\n=== PACKAGE:DEV (auto) %s ===\n' "$(date -Is)"

  local status=0 passes=0 built=""
  while [ -f "$PENDING" ]; do
    # Every queue() rewrites the marker, so its mtime is the last commit's time.
    local age
    while [ -f "$PENDING" ] \
      && age=$(( $(date +%s) - $(stat -c %Y "$PENDING" 2>/dev/null || echo 0) )) \
      && [ "$age" -lt "$SETTLE_SECONDS" ]; do
      sleep $(( SETTLE_SECONDS - age ))
    done
    [ -f "$PENDING" ] || break
    if paused; then
      rm -f "$PENDING"
      break
    fi
    # Cleared BEFORE the build: a commit landing mid-build re-creates it and
    # earns the next pass, rather than being swallowed by this one.
    rm -f "$PENDING"
    passes=$((passes + 1))
    built="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo '?')"
    build_once
    status=$?
    # A `--build-now` is one pass; whatever comes next waits for a resume.
    rm -f "$ONCE"
    if [ "$status" -eq "$CANCELLED" ] && [ -f "$PENDING" ]; then
      # Not a failure: nothing was wrong with the commit, it was just no
      # longer the newest. The FAILED record keeps whatever it said.
      note "pass $passes ($built) cancelled for a newer commit, finished with status $status"
      continue
    fi
    if [ "$status" -eq "$CANCELLED" ] && paused; then
      # Not a failure either: the user wanted the machine back.
      note "pass $passes ($built) cancelled — auto-builds paused"
      rm -f "$PENDING"
      return 0
    fi
    note "pass $passes ($built) finished with status $status"
    if [ "$status" -eq 0 ]; then
      rm -f "$FAILED"
    else
      printf '%s %s %s\n' "$built" "$status" "$(date -Is)" >"$FAILED"
      # A failed pass is not the end of the queue: a commit that landed
      # meanwhile is a different tree, and usually the one that fixes it
      # (a commit split across two `git commit`s compiles only as a pair).
      # Stopping here left the compiling commit queued and never built.
      [ -f "$PENDING" ] && note "a newer commit is queued — building it despite the failure"
    fi
  done

  # Paused while settling: nothing was built, nothing to announce.
  [ "$passes" -eq 0 ] && paused && return 0

  local version commit
  version="$(node -p "require('$ROOT/package.json').version" 2>/dev/null || echo '?')"
  commit="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo '?')"
  if [ "$status" -eq 0 ]; then
    notify low "$APP_DISPLAY (dev) rebuilt" "$version @ $commit — relaunch $APP_DISPLAY (dev) to pick it up."
  else
    notify critical "$APP_DISPLAY (dev) build failed" "$version @ $commit — see $LOG"
  fi
  return "$status"
}

# Stop auto-building until resume(): drop what is queued, and let a running
# pass cancel itself (build_once watches for the mark, and leaves an install
# already under way to finish).
pause() {
  mkdir -p "$APP_DIR" || return 1
  : >"$PAUSED"
  rm -f "$PENDING" "$ONCE"
  echo "$APP_DISPLAY (dev): auto-builds paused"
}

# Undo pause() and catch up: queue HEAD when the installed snapshot is behind
# it, since the commits made while paused queued nothing.
resume() {
  rm -f "$PAUSED"
  echo "$APP_DISPLAY (dev): auto-builds resumed"
  local head
  head="$(tree_signature)" || return 0
  [ -f "$STAMP" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$head" ] && return 0
  queue
}

# While paused: build HEAD once, now (no settle wait), when the installed
# snapshot is not already HEAD — and stay paused. Pausing again cancels it like
# any other pass. Not paused, it is a plain queue().
build_now() {
  paused || { queue; return 0; }
  local head reason
  head="$(tree_signature)" || { echo "not a git checkout" >&2; return 1; }
  if [ -f "$STAMP" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$head" ] && [ -x "$BINARY" ]; then
    echo "$APP_DISPLAY (dev): the installed snapshot is HEAD — nothing newer to build"
    return 0
  fi
  if reason="$(declined once)"; then
    echo "$APP_DISPLAY (dev): not building — $reason" >&2
    return 1
  fi
  mkdir -p "$APP_DIR" || return 1
  : >"$ONCE"
  : >"$PENDING"
  # Aged past the settle window: the user asked for now.
  touch -d "@$(( $(date +%s) - SETTLE_SECONDS ))" "$PENDING" 2>/dev/null || true
  setsid nohup "$SELF" --run </dev/null >/dev/null 2>&1 &
  disown 2>/dev/null || true
  printf '%s (dev): building HEAD once while paused (%s)\n' "$APP_DISPLAY" "$LOG"
}

case "${1:---queue}" in
  --queue) queue ;;
  --run) run ;;
  --pause) pause ;;
  --resume) resume ;;
  --build-now) build_now || exit 1 ;;
  --status)
    if [ -d "$LOCK_DIR" ]; then echo "building (pid $(cat "$LOCK_DIR/pid" 2>/dev/null || echo '?'))"; else echo "idle"; fi
    [ -f "$PENDING" ] && echo "a rebuild is queued"
    [ -f "$STAMP" ] && echo "installed snapshot signature: $(cat "$STAMP")"
    if [ -f "$FAILED" ]; then
      read -r fcommit fstatus fwhen <"$FAILED"
      echo "LAST BUILD FAILED: commit $fcommit, status $fstatus, $fwhen — see $LOG"
    fi
    if [ -f "$STAMP" ] && head_sha="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)" && [ "$head_sha" != "$(cat "$STAMP")" ]; then
      behind="$(git -C "$ROOT" rev-list --count "$(cat "$STAMP")..HEAD" 2>/dev/null || echo '?')"
      echo "installed snapshot is $behind commit(s) behind HEAD"
    fi
    if reason="$(declined)"; then echo "auto-build declined: $reason"; else echo "auto-build enabled"; fi
    ;;
  *) echo "usage: $(basename "$0") [--queue|--run|--status|--pause|--resume|--build-now]" >&2; exit 2 ;;
esac
exit 0
