#!/usr/bin/env bash
# The local mirror of .github/workflows/ci-cd.yml: before a push, run what its
# Linux jobs run (privacy, brand, secrets, lint, test-ubuntu), fail-fast, plus the
# Windows and macOS cross-checks AGENTS.md asks for — the jobs on those
# runners cannot run here, but their compile errors can be caught.
#
#   scripts/ci-local.sh                 every step, stopping at the first failure
#   scripts/ci-local.sh --fast          the cheap checks and the whole lint job,
#                                       but only the tests of what changed (below)
#   scripts/ci-local.sh --from <step>   resume at a step (its id or number)
#   scripts/ci-local.sh --list          the steps, and what is not run locally and why
#   scripts/ci-local.sh --check-drift   fail unless this file mirrors ci-cd.yml
#                                       (ci-cd.yml's lint job runs it too)
#
# Why it cannot drift. Every step of a Linux job in ci-cd.yml is, by its exact
# `name:`, either
#   * run here: STEPS below names it. Kind `ci` executes ci-cd.yml's own
#     `run:` text, read from the workflow at run time (with the workflow-level
#     `env:`, and the shell options GitHub uses), so a changed command is
#     picked up by itself. Kind `sub:<fn>` does the same through one textual
#     substitution (sub_<fn>; the guard fails once it no longer applies).
#     Kind `local:<fn>@<fingerprint>` runs a local stand-in, run_<fn>, for a
#     step that cannot run as written here (it needs CI's event context, or
#     would reinstall node_modules under whoever else uses this tree); the
#     fingerprint is a cksum of ci-cd.yml's step, so editing that step fails
#     the guard until the stand-in is looked at and the fingerprint updated
#     (the guard prints the new one);
#   * or on the ALLOW list, with the reason it does not apply locally.
# --check-drift fails on a step that is neither, on a STEPS or ALLOW entry
# naming a step ci-cd.yml no longer has, and on a fingerprint that is stale.
# A step that is local only (the cross-checks) has the job `local`.
#
# --fast: everything except tests whose code did not change since the merge
# base with the upstream branch (else origin/<branch>, else origin/develop),
# counting uncommitted and untracked files too. src-core reaches every Rust
# test step, src-gateway its own tests and the app's (the app links it),
# src-tauri the app's and the daemon build's; any Rust change runs the daemon
# check and the cross-checks; Cargo.toml/Cargo.lock/rust-toolchain.toml count
# as every crate. Any other file outside docs/, todo/, scripts/, .github/,
# .githooks/ and *.md counts as frontend: the frontend build, and vitest's
# `--changed <base>` (tests related to changed files) instead of the full suite.
# The areas come from scripts/lib/changed.sh (shared with scripts/gates.sh),
# which also counts a file outside a crate that the crate's tests read.
#
# The test steps run with a CI runner's environment (ci_like_env below:
# symlinked TMPDIR, no global git config); CI_LOCAL_HOST_ENV=1 opts out.
#
# Failed tests are remembered as in CI (scripts/ci-failed-first.sh), in the
# git dir: the next run re-runs them first. CARGO_TARGET_DIR is honoured.
# CI_LOCAL_WORKFLOW points the script at another workflow file (for testing
# the guard on a copy).
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"
workflow="${CI_LOCAL_WORKFLOW:-$repo/.github/workflows/ci-cd.yml}"
# The change's areas (--fast), shared with scripts/gates.sh.
. "$repo/scripts/lib/changed.sh"
# SCHED_IDLE + nice 19, so a gate run never makes the window lag (the file says why).
. "$repo/scripts/lib/low_priority.sh"
low_priority_reexec "$repo/scripts/ci-local.sh" "$@"

# ---------------------------------------------------------------------------
# The steps, in run order: cheap checks first, then the lint job, the test
# job, and the cross-checks.
#   id | ci-cd job(s) | ci-cd step name (exact) | kind | --fast areas[:fn]
# --fast areas: always, fe, core, gateway, backend (core, gateway or
# src-tauri), rs (any Rust). `:fn` runs fast_<fn> in place of the step.
# ---------------------------------------------------------------------------
STEPS=(
  "brand|brand|Check that only the brand modules spell the app's name|ci|always"
  "toolchain|lint|CI's Rust is the pinned one|ci|always"
  "drift|lint|ci-local.sh mirrors this workflow|ci|always"
  "privacy|privacy|Scan pushed changes for secrets / personal data|local:privacy@4197511463-1112|always"
  "gitleaks|secrets|Scan history for secrets|local:gitleaks@2296324494-115|always"
  "npm-deps|lint,test-ubuntu,package,package-server|Install frontend dependencies|local:npm_deps@4016385107-81|always"
  "lint-frontend|lint|Lint frontend|ci|always"
  "lint-backend|lint|Lint backend|ci|always"
  "lint-core|lint|Lint core crate|ci|always"
  "lint-gateway|lint|Lint gateway crate|ci|always"
  "lint-daemon-lib|lint|Lint the daemon's build of the library|ci|always"
  "lint-daemon|lint|Lint daemon crate|ci|always"
  "failed-first|test-ubuntu|Re-run the last run's failed tests first|ci|always"
  "build-frontend|test-ubuntu|Build frontend|ci|fe"
  "test-frontend|test-ubuntu|Run frontend tests|ci|fe:vitest_changed"
  "test-backend|test-ubuntu|Run backend tests|ci|backend"
  "test-core|test-ubuntu|Run core crate tests|ci|core"
  "test-gateway|test-ubuntu|Run gateway crate tests|ci|gateway"
  "test-daemon-lib|test-ubuntu|Run the daemon build's library tests|ci|backend"
  "daemon-ldd|test-ubuntu|Daemon links no desktop libraries|sub:target_dir|rs"
  "windows-clippy|local|Windows cross-check: clippy (src-tauri, all targets)|local:windows_clippy|rs"
  "windows-check|local|Windows cross-check: cargo check (workspace, all targets)|local:windows_check|rs"
  "macos-check|local|macOS cross-check: cargo check (workspace, all targets)|local:macos_check|rs"
)

# Steps of ci-cd.yml's Linux jobs that are not run here.
#   job (* = any) | ci-cd step name (exact) | why
ALLOW=(
  "*|Checkout|the working tree is the checkout"
  "*|Install Linux dependencies|apt packages: without them nothing here builds"
  "*|Setup Node|the host's Node (a major differing from ci-cd.yml's is noted)"
  "*|Setup Rust|rust-toolchain.toml selects the same pinned Rust"
  "*|Rust cache|CI's target-dir cache; the local target dir persists"
  "secrets|Install gitleaks|an installed gitleaks is used, else the scan is SKIPPED"
  "test-ubuntu|Restore the last run's failed tests|the list persists in the git dir"
  "test-ubuntu|Save this run's failed tests|the list persists in the git dir"
  "package|Build release bundles|release packaging (npm run tauri:bundle), not a code gate"
  "package|Upload AppImage|artifact upload"
  "package|Upload DEB|artifact upload"
  "package-server|Build server package|release packaging (scripts/package-server-deb.sh), not a code gate"
  "package-server|Upload server DEB|artifact upload"
)

# ---------------------------------------------------------------------------
# Local stand-ins (run_<fn>), skip conditions (skip_<fn> prints a reason to
# skip), substitutions (sub_<fn>), --fast replacements (fast_<fn>).
# ---------------------------------------------------------------------------

# CI scans the pushed range from its event payload; here, as .githooks/pre-push
# does: the commits a push of this branch would send.
run_privacy() {
  local head base up oldest empty_tree=4b825dc642cb6eb9a060e54bf8d69288fbee4904
  head="$(git rev-parse HEAD)"
  if up="$(git rev-parse -q --verify '@{upstream}^{commit}' 2>/dev/null)"; then
    if [ "$(git rev-list --count "$up..$head")" -eq 0 ]; then
      echo "Nothing unpushed: HEAD is on its upstream."
      return 0
    fi
    base="$up"
  else
    oldest="$(git rev-list "$head" --not --remotes | tail -1)"
    if [ -z "$oldest" ]; then
      echo "Nothing unpushed: every commit is on a remote."
      return 0
    fi
    base="$(git rev-parse -q --verify "$oldest^" 2>/dev/null || echo "$empty_tree")"
  fi
  echo "Scanning ${base}..${head} (what a push sends; uncommitted changes are pre-commit's)"
  scripts/privacy-check.sh "$base" "$head"
}

skip_gitleaks() {
  command -v gitleaks >/dev/null 2>&1 \
    || echo "gitleaks is not installed (CI's secrets job runs it over the whole history)"
}
run_gitleaks() { gitleaks git . --redact --no-banner --verbose; }

# CI runs `npm ci --ignore-scripts`, which would delete and reinstall
# node_modules under everything else using this tree. Check what npm ci would
# refuse or change.
run_npm_deps() {
  echo "+ npm ls --package-lock-only --depth=0   # the lock satisfies package.json (npm ci refuses otherwise)"
  npm ls --package-lock-only --depth=0 >/dev/null
  echo "+ npm ls --depth=0                       # node_modules matches it (else: npm install)"
  npm ls --depth=0 >/dev/null
}

# CI's daemon lands in target/; here it is wherever CARGO_TARGET_DIR says.
sub_target_dir() { sed 's#target/debug/#"${CARGO_TARGET_DIR:-target}"/debug/#g'; }

fast_vitest_changed() {
  echo "+ npx vitest run --changed $FAST_BASE"
  npx vitest run --changed "$FAST_BASE"
}

target_installed() { rustup target list --installed 2>/dev/null | grep -qx "$1"; }
# The msvc stand-ins AGENTS.md names, in ~/.local/bin (or CI_LOCAL_MSVC_RC/_LIB).
msvc_shim() {
  local f
  for f in "$HOME"/.local/bin/*-msvc-"$1"-shim; do
    [ -x "$f" ] && { printf '%s\n' "$f"; return 0; }
  done
  return 1
}
skip_windows() {
  command -v rustup >/dev/null 2>&1 || { echo "rustup not found"; return 0; }
  target_installed x86_64-pc-windows-msvc \
    || { echo "target x86_64-pc-windows-msvc not installed (rustup target add, outside the fence)"; return 0; }
  [ -n "${CI_LOCAL_MSVC_RC:-}" ] || msvc_shim rc >/dev/null \
    || { echo "no msvc rc shim in ~/.local/bin (*-msvc-rc-shim) and CI_LOCAL_MSVC_RC unset"; return 0; }
  [ -n "${CI_LOCAL_MSVC_LIB:-}" ] || msvc_shim lib >/dev/null \
    || { echo "no msvc lib shim in ~/.local/bin (*-msvc-lib-shim) and CI_LOCAL_MSVC_LIB unset"; return 0; }
}
windows_cargo() {
  local rc lib
  rc="${CI_LOCAL_MSVC_RC:-$(msvc_shim rc)}"
  lib="${CI_LOCAL_MSVC_LIB:-$(msvc_shim lib)}"
  echo "+ RC=$rc AR_x86_64_pc_windows_msvc=$lib cargo $*"
  RC="$rc" AR_x86_64_pc_windows_msvc="$lib" cargo "$@"
}
skip_windows_clippy() { skip_windows; }
run_windows_clippy() {
  windows_cargo clippy --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc --all-targets -- -D warnings
}
skip_windows_check() { skip_windows; }
run_windows_check() { windows_cargo check --workspace --all-targets --target x86_64-pc-windows-msvc; }

skip_macos_check() {
  command -v rustup >/dev/null 2>&1 || { echo "rustup not found"; return 0; }
  target_installed aarch64-apple-darwin \
    || echo "target aarch64-apple-darwin not installed (rustup target add, outside the fence)"
}
# No macOS SDK here: check-only cc/ar stand-ins let build scripts (ring,
# objc2-exception-helper) finish. `cargo check` never links, so their objects
# and archives only have to exist. Type and borrow checking only.
run_macos_check() {
  local shims
  shims="$(mktemp -d)"
  # Expanded now: the trap fires when the step's subshell exits, after this
  # function's local is gone (set -u).
  # shellcheck disable=SC2064
  trap "rm -rf '$shims'" EXIT
  cat >"$shims/cc" <<'EOF'
#!/bin/sh
out=; prev=
for a in "$@"; do
  [ "$prev" = -o ] && out=$a
  case $a in -o?*) out=${a#-o} ;; esac
  prev=$a
done
[ -z "$out" ] || : >"$out"
EOF
  cat >"$shims/ar" <<'EOF'
#!/bin/sh
for a in "$@"; do case $a in *.a) : >"$a"; exit 0 ;; esac; done
EOF
  chmod +x "$shims/cc" "$shims/ar"
  echo "+ CC/AR_aarch64_apple_darwin=<check-only stand-ins> cargo check --workspace --all-targets --target aarch64-apple-darwin"
  CC_aarch64_apple_darwin="$shims/cc" AR_aarch64_apple_darwin="$shims/ar" \
    cargo check --workspace --all-targets --target aarch64-apple-darwin
}

# ---------------------------------------------------------------------------
# Reading ci-cd.yml. A small reader for the subset this workflow uses (POSIX
# awk: CI's ubuntu runs mawk): jobs, their runs-on and steps, a step's name,
# run (plain, quoted, or a `|` block), and which other keys it sets.
#   wf steps            job<TAB>runs-on<TAB>name<TAB>flags per step
#   wf run JOB NAME     that step's run text        (exit 3: no such step)
#   wf raw JOB NAME     that step's YAML, comments and blank lines dropped
#   wf env              the workflow-level env as KEY=VALUE lines
# ---------------------------------------------------------------------------
wf() {
  awk -v q="'" -v mode="$1" -v wjob="${2:-}" -v wname="${3:-}" '
    function ind(s) { match(s, /^ */); return RLENGTH }
    function quoted(v, c) { return length(v) >= 2 && substr(v, 1, 1) == c && substr(v, length(v), 1) == c }
    function unq(v) {
      if (quoted(v, q)) { v = substr(v, 2, length(v) - 2); gsub(q q, q, v); return v }
      if (quoted(v, "\"")) { v = substr(v, 2, length(v) - 2); gsub(/\\"/, "\"", v); return v }
      sub(/[ \t]+#.*$/, "", v)
      return v
    }
    function flush() {
      if (!instep) return
      if (mode == "steps") printf "%s\t%s\t%s\t%s\n", job, runs_on, name, flags
      else if (job == wjob && name == wname) {
        found = 1
        if (mode == "run") printf "%s", run
        else if (mode == "raw") printf "%s", raw
      }
      instep = 0
    }
    {
      sub(/\r$/, "")
      line = $0
      if (inblk) {
        if (line ~ /^[ \t]*$/) { pend = pend "\n"; next }
        i = ind(line)
        if (bi < 0) { if (i > 8) bi = i; else inblk = 0 }
        if (inblk && i >= bi) {
          run = run pend substr(line, bi + 1) "\n"; pend = ""
          if (line !~ /^ *#/) raw = raw line "\n"
          next
        }
        inblk = 0; pend = ""
      }
      if (line ~ /^ *#/ || line ~ /^[ \t]*$/) next
      i = ind(line)
      if (i == 0) {
        flush(); injobs = 0; inenv = 0; insteps = 0
        if (line ~ /^jobs:/) injobs = 1
        else if (line ~ /^env:/) inenv = 1
        next
      }
      if (inenv && i == 2) {
        if (mode == "env") {
          kv = substr(line, 3); k = kv; sub(/:.*$/, "", k)
          v = kv; sub(/^[^:]*:[ ]*/, "", v)
          print k "=" unq(v)
        }
        next
      }
      if (!injobs) next
      if (i == 2) {
        flush(); job = substr(line, 3); sub(/:.*$/, "", job)
        runs_on = ""; insteps = 0
        next
      }
      if (i == 4) {
        flush(); insteps = 0
        if (line ~ /^    runs-on:/) { v = line; sub(/^    runs-on:[ ]*/, "", v); runs_on = unq(v) }
        else if (line ~ /^    steps:/) insteps = 1
        next
      }
      if (!insteps) next
      if (i == 6 && substr(line, 7, 2) == "- ") {
        flush(); instep = 1; name = ""; flags = ""; run = ""; raw = ""
        line = "        " substr(line, 9); i = 8
      }
      if (!instep) next
      raw = raw line "\n"
      if (i != 8) next
      kv = substr(line, 9); k = kv; sub(/:.*$/, "", k)
      v = ""
      if (index(kv, ":")) { v = kv; sub(/^[^:]*:[ ]*/, "", v) }
      if (k == "name") name = unq(v)
      else if (k == "run") {
        flags = flags " run"
        if (v ~ /^\|[-+]?$/) { inblk = 1; bi = -1; pend = "" }
        else if (v ~ /^>/) flags = flags " folded"
        else run = unq(v) "\n"
      }
      else if (k == "uses") flags = flags " uses"
      else if (k == "shell") flags = flags " shell=" unq(v)
      else if (k == "env") flags = flags " env"
      else if (k == "if") flags = flags " if"
      else if (k == "continue-on-error") flags = flags " continue-on-error"
      else if (k == "working-directory") flags = flags " working-directory"
    }
    END {
      flush()
      if ((mode == "run" || mode == "raw") && !found) exit 3
    }
  ' "$workflow"
}

fingerprint() { cksum | awk '{ print $1 "-" $2 }'; }

die() { echo "ci-local: $*" >&2; exit 2; }

# Fields of a STEPS record into id/jobs/name/kind/fast.
parse_step() { IFS='|' read -r id jobs name kind fast <<<"$1"; }

# ---------------------------------------------------------------------------
# --check-drift
# ---------------------------------------------------------------------------
check_drift() {
  [ -f "$workflow" ] || die "no workflow at $workflow"
  local errs=() rec id jobs name kind fast j key job runs flags fn fp want got text first f
  local -A mapped=() allowed=() allow_used=() seen=() ci_text=()
  local js=() nsteps=0 nrun=0 nallow=0

  for rec in "${STEPS[@]}"; do
    parse_step "$rec"
    case "$kind" in
      ci) ;;
      sub:*) declare -F "sub_${kind#sub:}" >/dev/null || errs+=("STEPS $id: no function sub_${kind#sub:}") ;;
      local:*) fn="${kind#local:}"; fn="${fn%@*}"
        declare -F "run_$fn" >/dev/null || errs+=("STEPS $id: no function run_$fn") ;;
      *) errs+=("STEPS $id: unknown kind '$kind'") ;;
    esac
    case "$fast" in *:*) declare -F "fast_${fast#*:}" >/dev/null || errs+=("STEPS $id: no function fast_${fast#*:}") ;; esac
    [ "$jobs" = local ] && continue
    IFS=, read -ra js <<<"$jobs"
    for j in "${js[@]}"; do mapped["$j|$name"]="$rec"; done
  done
  for rec in "${ALLOW[@]}"; do
    IFS='|' read -r j name _ <<<"$rec"
    allowed["$j|$name"]=1
  done

  local tsv
  tsv="$(wf steps)" || die "could not read $workflow"
  while IFS=$'\t' read -r job runs name flags; do
    [ -n "$job" ] || continue
    case "$runs" in
      *'${{'*) errs+=("job $job: runs-on '$runs' is an expression; cannot tell whether it is a Linux job"); continue ;;
      ubuntu*) ;;
      *) continue ;;
    esac
    nsteps=$((nsteps + 1))
    if [ -z "$name" ]; then
      errs+=("job $job: a step has no name; give it one so ci-local.sh can name it")
      continue
    fi
    key="$job|$name"
    if [ -n "${seen[$key]:-}" ]; then
      errs+=("job $job: two steps are named '$name'")
      continue
    fi
    seen[$key]=1
    if [ -n "${mapped[$key]:-}" ]; then
      parse_step "${mapped[$key]}"
      nrun=$((nrun + 1))
      case "$kind" in
        ci|sub:*)
          case " $flags " in
            *" run "*) ;;
            *) errs+=("$job / '$name': has no run: to execute; it is kind $kind in STEPS"); continue ;;
          esac
          for f in env if continue-on-error working-directory folded; do
            case " $flags " in *" $f "*)
              errs+=("$job / '$name': sets '$f', which kind $kind cannot reproduce; give it a local stand-in (kind local:)") ;;
            esac
          done
          text="$(wf run "$job" "$name")"
          if [ "${kind%%:*}" = sub ] && [ "$(printf '%s\n' "$text" | "sub_${kind#sub:}")" = "$text" ]; then
            errs+=("$job / '$name': sub_${kind#sub:} no longer changes its run: text; update or drop it")
          fi
          first="${ci_text[$id]:-}"
          if [ -n "$first" ] && [ "$first" != "$text" ]; then
            errs+=("'$name': its run: text differs between the jobs STEPS $id mirrors")
          fi
          ci_text[$id]="$text"
          ;;
        local:*)
          want="${kind#local:}"
          fp=""
          case "$want" in *@*) fp="${want#*@}" ;; esac
          got="$(wf raw "$job" "$name" | fingerprint)"
          if [ "$fp" != "$got" ]; then
            errs+=("$job / '$name': ci-cd.yml's step changed since run_${want%@*} was written (fingerprint ${fp:-none}, now $got); bring the stand-in in line, then set @$got in STEPS")
          fi
          ;;
      esac
    elif [ -n "${allowed[$key]:-}" ]; then
      allow_used[$key]=1; nallow=$((nallow + 1))
    elif [ -n "${allowed["*|$name"]:-}" ]; then
      allow_used["*|$name"]=1; nallow=$((nallow + 1))
    else
      errs+=("$job / '$name': neither run by scripts/ci-local.sh (STEPS) nor on its ALLOW list")
    fi
  done <<<"$tsv"

  [ "$nsteps" -gt 0 ] || errs+=("found no steps of a Linux job in $workflow; the reader no longer understands it")
  for key in "${!mapped[@]}"; do
    [ -n "${seen[$key]:-}" ] \
      || errs+=("STEPS runs '${key#*|}' of job ${key%%|*}, which ci-cd.yml's Linux jobs no longer have")
  done
  for key in "${!allowed[@]}"; do
    [ -n "${allow_used[$key]:-}" ] \
      || errs+=("ALLOW lists '${key#*|}' for job ${key%%|*}, which no Linux job of ci-cd.yml has")
  done

  if [ "${#errs[@]}" -gt 0 ]; then
    echo "ci-local.sh does not mirror ${workflow#"$repo"/}:" >&2
    printf '  - %s\n' "${errs[@]}" >&2
    return 1
  fi
  echo "ci-local.sh mirrors ${workflow#"$repo"/}: $nrun Linux-job steps run, $nallow allowlisted, $nsteps in all."
}

# ---------------------------------------------------------------------------
# --list
# ---------------------------------------------------------------------------
list_steps() {
  local n=0 rec id jobs name kind fast how fn j why
  printf '%3s  %-16s %-18s %-18s %s\n' '#' step 'ci-cd job' fast 'ci-cd step / how'
  for rec in "${STEPS[@]}"; do
    parse_step "$rec"
    n=$((n + 1))
    case "$kind" in
      ci) how="ci-cd.yml's run:" ;;
      sub:*) how="ci-cd.yml's run: via sub_${kind#sub:}" ;;
      local:*) fn="${kind#local:}"; how="local stand-in run_${fn%@*}" ;;
    esac
    printf '%3d  %-16s %-18s %-18s %s  [%s]\n' "$n" "$id" "$jobs" "$fast" "$name" "$how"
  done
  echo
  echo "Not run locally (ALLOW):"
  for rec in "${ALLOW[@]}"; do
    IFS='|' read -r j name why <<<"$rec"
    printf '  %-8s %-40s %s\n' "$j" "$name" "$why"
  done
}

# ---------------------------------------------------------------------------
# Running
# ---------------------------------------------------------------------------
fmt_time() { local s="$1"; if [ "$s" -ge 60 ]; then printf '%dm%02ds' $((s / 60)) $((s % 60)); else printf '%ds' "$s"; fi; }

# The test steps run as on a CI runner, not as on this machine: TMPDIR behind
# a symlink with macOS's path lengths (FSEvents and /proc report real paths;
# 53/61 characters leave Unix sockets the room macOS's 49/57 leave under its
# 104-byte limit), and git without the developer's global config or identity
# (a runner has none). CI_LOCAL_HOST_ENV=1 runs them in the shell's own env.
ci_like_env() {
  [ "${CI_LOCAL_HOST_ENV:-0}" = 1 ] && return 0
  local real=/tmp/private/tt link=/tmp/tt leaf=folders/zz/zyxvpxvq6csfxvn_n0000000000000gn/T
  mkdir -p "$real/$leaf"
  [ -L "$link" ] || ln -sfn "$real" "$link"
  export TMPDIR="$link/$leaf"
  printf '[user]\n\tuseConfigOnly = true\n' >"$real/ci.gitconfig"
  export GIT_CONFIG_GLOBAL="$real/ci.gitconfig" GIT_CONFIG_NOSYSTEM=1
  unset GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL EMAIL
}

# Executes ci-cd.yml's run: text of a step the way GitHub does on Linux:
# `bash -e`, plus `-o pipefail` under `shell: bash`; workflow env exported.
run_ci_text() {
  local job="$1" name="$2" sub="$3" text flags script opts=(-e)
  text="$(wf run "$job" "$name")" || die "ci-cd.yml has no step '$name' in job $job (run --check-drift)"
  [ -z "$sub" ] || text="$(printf '%s\n' "$text" | "sub_$sub")"
  flags="$(wf steps | awk -F '\t' -v j="$job" -v n="$name" '$1 == j && $3 == n { print $4 }')"
  case " $flags " in *" shell=bash "*) opts=(-eo pipefail) ;; esac
  script="$(mktemp)"
  printf '%s\n' "$text" >"$script"
  printf '%s\n' "$text" | sed 's/^/+ /'
  local -a envs=()
  mapfile -t envs < <(wf env)
  local rc=0
  env "${envs[@]}" bash --noprofile --norc "${opts[@]}" "$script" || rc=$?
  rm -f "$script"
  return "$rc"
}

compute_fast() {
  local up branch
  if ! up="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null)"; then
    branch="$(git branch --show-current)"
    up="origin/${branch:-develop}"
  fi
  git rev-parse -q --verify "$up^{commit}" >/dev/null || up=origin/develop
  FAST_BASE="$(git merge-base "$up" HEAD)" || die "--fast: no merge base with $up"
  changed_areas "$FAST_BASE"
  local areas
  areas="$(changed_area_names)"
  echo "--fast: $(grep -c . <<<"$CHANGED" || true) files changed since $(git rev-parse --short "$FAST_BASE") ($up):${areas:- nothing that runs tests}"
}

# 0 when --fast should run a step with these areas.
fast_area_hit() {
  local a
  local -a as
  IFS=, read -ra as <<<"$1"
  for a in "${as[@]}"; do
    case "$a" in
      always) return 0 ;;
      fe) [ "$A_FE" = 1 ] && return 0 ;;
      core) [ $((A_CORE | A_ALL)) = 1 ] && return 0 ;;
      gateway) [ $((A_GATEWAY | A_ALL)) = 1 ] && return 0 ;;
      backend) [ $((A_CORE | A_GATEWAY | A_TAURI | A_ALL)) = 1 ] && return 0 ;;
      rs) [ $((A_CORE | A_GATEWAY | A_TAURI | A_SERVERD | A_ALL)) = 1 ] && return 0 ;;
    esac
  done
  return 1
}

run_all() {
  local fastmode="$1" from="$2" total="${#STEPS[@]}" n=0 start_at=1 rec id jobs name kind fast
  local -a r_id=() r_status=() r_time=() r_note=()

  if [ -n "$from" ]; then
    start_at=0
    for rec in "${STEPS[@]}"; do
      parse_step "$rec"; n=$((n + 1))
      if [ "$from" = "$id" ] || [ "$from" = "$n" ]; then start_at=$n; break; fi
    done
    [ "$start_at" -gt 0 ] || die "--from: no step '$from' (see --list)"
    n=0
  fi

  if [ "$fastmode" = 1 ]; then compute_fast; fi

  # CI's Node, pinned in .nvmrc (setup-node reads it); a different major is
  # worth knowing about.
  local ci_node here_node
  ci_node="$(sed -nE 's/^v?([0-9]+).*/\1/p' .nvmrc 2>/dev/null | head -1)"
  here_node="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo none)"
  if [ -n "$ci_node" ] && [ "$ci_node" != "$here_node" ]; then
    echo "NOTE: ci-cd.yml runs Node $ci_node; this shell has Node $here_node."
  fi

  CI_FAILED_DIR="${CI_FAILED_DIR:-$(git rev-parse --absolute-git-dir)/ci-local-failed}"
  export CI_FAILED_DIR

  local failed="" t0 rc reason fn alt
  for rec in "${STEPS[@]}"; do
    parse_step "$rec"
    n=$((n + 1))
    r_id+=("$id"); r_time+=(""); r_note+=("")
    if [ "$n" -lt "$start_at" ]; then r_status+=("-"); r_note[$((n - 1))]="before --from"; continue; fi
    if [ -n "$failed" ]; then r_status+=("not run"); continue; fi
    echo
    echo "==> [$n/$total] $id — ${jobs}: $name"
    reason=""; alt=""
    if [ "$fastmode" = 1 ]; then
      if fast_area_hit "${fast%%:*}"; then
        case "$fast" in *:*) alt="${fast#*:}" ;; esac
      else
        reason="--fast: nothing it tests changed"
      fi
    fi
    if [ -z "$reason" ] && [ "${kind%%:*}" = local ]; then
      fn="${kind#local:}"; fn="${fn%@*}"
      if declare -F "skip_$fn" >/dev/null; then reason="$("skip_$fn")"; fi
    fi
    if [ -n "$reason" ]; then
      echo "SKIPPED: $reason"
      r_status+=("SKIPPED"); r_note[$((n - 1))]="$reason"
      continue
    fi
    t0=$SECONDS
    set +e
    (
      set -euo pipefail
      case "$id" in failed-first | test-*) ci_like_env ;; esac
      if [ -n "$alt" ]; then
        "fast_$alt"
      else
        case "$kind" in
          ci) run_ci_text "${jobs%%,*}" "$name" "" ;;
          sub:*) run_ci_text "${jobs%%,*}" "$name" "${kind#sub:}" ;;
          local:*) "run_$fn" ;;
        esac
      fi
    )
    rc=$?
    set -e
    r_time[$((n - 1))]="$(fmt_time $((SECONDS - t0)))"
    [ -z "$alt" ] || r_note[$((n - 1))]="--fast: fast_$alt"
    if [ "$rc" -eq 0 ]; then
      r_status+=("ok")
    else
      r_status+=("FAILED"); r_note[$((n - 1))]="exit $rc"
      failed="$id"
    fi
  done

  echo
  echo "== ci-local summary =="
  local i
  for i in "${!r_id[@]}"; do
    printf '%3d  %-16s %-8s %7s  %s\n' $((i + 1)) "${r_id[$i]}" "${r_status[$i]}" "${r_time[$i]}" "${r_note[$i]}"
  done
  if [ -n "$failed" ]; then
    echo
    echo "FAILED at $failed. Fix it, then resume: scripts/ci-local.sh$([ "$fastmode" = 1 ] && echo ' --fast') --from $failed"
    return 1
  fi
  echo
  echo "All steps passed or were skipped (see SKIPPED lines above)."
}

usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//'; }

fastmode=0 from="" action=run
while [ $# -gt 0 ]; do
  case "$1" in
    --fast) fastmode=1 ;;
    --from) [ $# -ge 2 ] || die "--from needs a step"; from="$2"; shift ;;
    --from=*) from="${1#--from=}" ;;
    --list) action=list ;;
    --check-drift) action=drift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option '$1' (see --help)" ;;
  esac
  shift
done

case "$action" in
  list) list_steps ;;
  drift) check_drift ;;
  run) run_all "$fastmode" "$from" ;;
esac
