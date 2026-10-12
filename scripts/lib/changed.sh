# shellcheck shell=bash
# Which parts of the tree a change touches. SOURCED, never run, by
# scripts/ci-local.sh (--fast) and scripts/gates.sh:
#
#   . "$ROOT/scripts/lib/changed.sh"
#   changed_areas BASE
#
# The change is `git diff BASE` (the working tree against BASE, so staged and
# unstaged edits) plus untracked files. Sets:
#   CHANGED     the changed paths, one per line
#   A_FE        1: the frontend (any file outside the crates, docs/, todo/,
#               scripts/, .github/, .githooks/ and *.md)
#   A_CORE A_GATEWAY A_TAURI A_SERVERD
#               1: that crate (src-core, src-gateway, src-tauri, src-serverd)
#   A_ALL       1: Cargo.toml, Cargo.lock or rust-toolchain.toml, i.e. every crate
# Also a crate whose tests read a file outside it (CROSS_READS below): its
# test fails when that file changes, so the file counts for the crate too.
#
# Crate graph (who links whom): src-tauri links src-core and src-gateway;
# src-serverd links src-tauri. A crate's change reaches the ones linking it:
# changed_reach turns the A_* flags into R_* ("must be rebuilt and tested").

# path glob | crate flag. Files outside a crate that the crate's code or tests
# read: include_str!/include_bytes! or a CARGO_MANIFEST_DIR join.
CROSS_READS=(
  "scripts/lib/brand.sh|A_CORE"
  "scripts/*-send.*|A_TAURI"
  "mobile-web/src/markupInstruction.ts|A_TAURI"
  "src/components/mobile/MobileBridgeHost.tsx|A_TAURI"
  "src/lib/transport/commandClasses.ts|A_TAURI"
  "src/__tests__/fixtures/*|A_TAURI"
)

changed_areas() {
  local base="$1" f rec glob flag
  CHANGED="$( { git diff --name-only "$base" --; git ls-files --others --exclude-standard; } | sort -u)"
  A_FE=0 A_CORE=0 A_GATEWAY=0 A_TAURI=0 A_SERVERD=0 A_ALL=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$f" in
      src-core/*) A_CORE=1 ;;
      src-gateway/*) A_GATEWAY=1 ;;
      src-tauri/*) A_TAURI=1 ;;
      src-serverd/*) A_SERVERD=1 ;;
      Cargo.toml|Cargo.lock|rust-toolchain.toml) A_ALL=1 ;;
      docs/*|todo/*|scripts/*|.github/*|.githooks/*|*.md) ;;
      *) A_FE=1 ;;
    esac
    for rec in "${CROSS_READS[@]}"; do
      glob="${rec%|*}" flag="${rec#*|}"
      # shellcheck disable=SC2053 # the glob is meant to match
      if [[ "$f" == $glob ]]; then printf -v "$flag" 1; fi
    done
  done <<<"$CHANGED"
}

# " frontend src-core …", or empty: the areas changed_areas found.
changed_area_names() {
  local s=""
  [ "$A_FE" = 1 ] && s+=" frontend"
  [ "$A_CORE" = 1 ] && s+=" src-core"
  [ "$A_GATEWAY" = 1 ] && s+=" src-gateway"
  [ "$A_TAURI" = 1 ] && s+=" src-tauri"
  [ "$A_SERVERD" = 1 ] && s+=" src-serverd"
  [ "$A_ALL" = 1 ] && s+=" cargo-workspace"
  printf '%s' "$s"
}

# R_CORE R_GATEWAY R_TAURI R_SERVERD: 1 when the change reaches that crate
# (it changed, or a crate it links did, or the workspace files did).
changed_reach() {
  R_CORE=$((A_CORE | A_ALL))
  R_GATEWAY=$((A_GATEWAY | A_ALL))
  R_TAURI=$((A_TAURI | R_CORE | R_GATEWAY))
  R_SERVERD=$((A_SERVERD | R_TAURI))
}
