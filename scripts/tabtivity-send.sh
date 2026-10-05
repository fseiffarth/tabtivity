#!/bin/sh
# Tabtivity-owned, dependency-free project → phone transport.
set -eu
export LC_ALL=C
fail() { printf 'tabtivity-send: %s\n' "$2" >&2; exit "$1"; }
usage() { printf '%s\n' 'tabtivity-send FILE...' 'command | tabtivity-send -n NAME' 'tabtivity-send --clear' 'tabtivity-send --help'; }
[ "$#" -gt 0 ] || { usage; exit 2; }
[ "$1" != --help ] || { usage; exit 0; }
mode=files
case "$1" in
    --clear) [ "$#" -eq 1 ] || fail 2 'Use --clear alone.'; mode=clear ;;
    -n) [ "$#" -eq 2 ] || fail 2 'Use -n NAME for stdin.'; mode=stdin; label=$2 ;;
    --) shift; [ "$#" -gt 0 ] || fail 2 'Name at least one file.' ;;
    -*) fail 2 'Unknown option; use --help.' ;;
esac
root=${TABTIVITY_PROJECT_DIR:-}
[ -n "$root" ] || root=$(git rev-parse --show-toplevel 2>/dev/null) || fail 3 'Set TABTIVITY_PROJECT_DIR or run inside a git project.'
root=$(cd "$root" 2>/dev/null && pwd -P) || fail 3 'The project directory is unavailable.'
# Refuse redirected outboxes, especially before --clear.
[ ! -L "$root/.tabtivity" ] && [ ! -L "$root/.tabtivity/outbox" ] || fail 3 'The outbox must not be a symlink.'
outbox=$root/.tabtivity/outbox
# The agent tab sending (its `TABTIVITY_TAB_UID`): that tab's phone chat shows
# the file; every gallery lists it. No tab (a plain shell): gallery only.
tab=${TABTIVITY_TAB_UID:-}
case "$tab" in *[!A-Za-z0-9-]*) tab= ;; esac
[ "${#tab}" -le 64 ] || tab=
mkdir -p "$outbox" || fail 3 'Cannot create the project outbox.'
lock=$outbox/.send-lock
mkdir "$lock" 2>/dev/null || fail 5 'Another send or clear is in progress; retry shortly.'
stage=
cleanup() {
    if [ -n "$stage" ]; then rm -f "$stage/data" "$stage/tab" "$stage/src"; rmdir "$stage"; fi
    rmdir "$lock"
}
trap cleanup 0
trap 'exit 4' HUP INT TERM
if [ "$mode" = clear ]; then
    for item in "$outbox"/* "$outbox"/.[!.]* "$outbox"/..?*; do
        [ -f "$item" ] && [ ! -L "$item" ] || continue
        rm -f "$item"
    done
    printf '%s\n' 'tabtivity-send: outbox cleared.'
    exit 0
fi
if ! git -C "$root" check-ignore -q .tabtivity/ 2>/dev/null; then
    printf '%s\n' 'tabtivity-send: warning: .tabtivity/ is not git-ignored; ignore it before committing.' >&2
fi
# Stage a bounded copy in a private directory. Only complete files become
# visible; hard-link publication never overwrites, including concurrent sends.
stage=$(mktemp -d "$outbox/.send-XXXXXXXX") || fail 3 'Cannot stage the file.'
nl='
'
# Where a sent file lives in the project, root-relative, for its origin
# marker: the phone then opens the project file itself, and its marks are the
# files drawer's. Empty for a file outside the project, an outbox file sent
# again, or a path the marker could not hold.
origin_of() {
    origin_dir=$(CDPATH= cd -- "$(dirname -- "$1")" 2>/dev/null && pwd -P) || return 0
    case "$origin_dir/" in "$root"/*) ;; *) return 0 ;; esac
    origin_rel=${origin_dir#"$root"}
    origin_rel=${origin_rel#/}
    origin_rel=${origin_rel:+$origin_rel/}${1##*/}
    case "$origin_rel" in .tabtivity/*|*"$nl"*) return 0 ;; esac
    printf '%s' "$origin_rel"
}
send_one() {
    name=$(printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_' | sed 's/^\.*//')
    [ -n "$name" ] || name=file
    ext=
    case "$name" in *.*) ext=.${name##*.} ;; esac
    ext=$(printf '%s' "$ext" | cut -c1-16)
    stem=${name%.*}
    [ -n "$stem" ] || stem=file
    name=$(printf '%s' "$stem" | cut -c1-$((80 - ${#ext})))$ext
    size=$(wc -c < "$stage/data" | tr -d ' ')
    [ "$size" -gt 0 ] && [ "$size" -le 25165824 ] || fail 4 'Files must be nonempty and at most 24 MiB.'
    total=0
    for item in "$outbox"/* "$outbox"/.[!.]* "$outbox"/..?*; do
        [ -f "$item" ] && [ ! -L "$item" ] || continue
        bytes=$(wc -c < "$item" | tr -d ' ')
        total=$((total + bytes))
    done
    [ "$((total + size))" -le 1073741824 ] || fail 5 'The outbox is full (1 GiB); use --clear.'
    stamp=$(date +%Y%m%d-%H%M%S)
    leaf=$stamp-$name
    n=0
    # A leaf with neither a file nor a sender or origin marker. The lock keeps
    # other sends out, so the markers below are ours; they land before the
    # file does, so the phone never lists this file unclaimed.
    while [ -e "$outbox/$leaf" ] || [ -L "$outbox/$leaf" ] \
        || [ -e "$outbox/.$leaf.tab" ] || [ -L "$outbox/.$leaf.tab" ] \
        || [ -e "$outbox/.$leaf.src" ] || [ -L "$outbox/.$leaf.src" ]; do
        n=$((n + 1))
        leaf=$stamp-${name%"$ext"}-$n$ext
    done
    marker=
    if [ -n "$tab" ]; then
        marker=$outbox/.$leaf.tab
        printf '%s' "$tab" > "$stage/tab" && mv "$stage/tab" "$marker" || fail 4 'Cannot publish the file.'
    fi
    # The project file this is a copy of (`origin_of`): `.<leaf>.src`.
    origin=
    if [ -n "${2:-}" ]; then
        origin=$outbox/.$leaf.src
        if ! { printf '%s' "$2" > "$stage/src" && mv "$stage/src" "$origin"; }; then
            [ -z "$marker" ] || rm -f "$marker"
            fail 4 'Cannot publish the file.'
        fi
    fi
    if ! link "$stage/data" "$outbox/$leaf" 2>/dev/null; then
        [ -z "$marker" ] || rm -f "$marker"
        [ -z "$origin" ] || rm -f "$origin"
        fail 4 'Cannot publish the file.'
    fi
    magic=$(od -An -tx1 -N12 "$stage/data" | tr -d ' \n')
    case "$magic" in
        89504e470d0a1a0a*|ffd8ff*|474946383761*|474946383961*|52494646????????57454250*) report='shown as an image' ;;
        255044462d*) report='opens as a PDF' ;;
        *) if head -c 4096 "$stage/data" | od -An -v -tu1 | awk '
            BEGIN { valid=1; need=0; low=128; high=191; n=0 }
            { for (i=1; i<=NF; i++) {
                b=$i; n++
                if (need) {
                    if (b<low || b>high) valid=0
                    need--; low=128; high=191
                } else if (b==0) valid=0
                else if (b<128) continue
                else if (b>=194 && b<=223) need=1
                else if (b>=224 && b<=239) {
                    need=2
                    if (b==224) low=160
                    if (b==237) high=159
                } else if (b>=240 && b<=244) {
                    need=3
                    if (b==240) low=144
                    if (b==244) high=143
                } else valid=0
            } }
            END { exit (!valid || (need && n<4096)) ? 1 : 0 }
        '; then report='shown as text'; else report='offered as a download'; fi ;;

    esac
    printf '→ phone: %s (%s KB) — %s\n' "$leaf" "$(((size + 1023) / 1024))" "$report"
    rm -f "$stage/data"
}
if [ "$mode" = stdin ]; then
    head -c 25165825 > "$stage/data"
    send_one "$label"
else
    for source in "$@"; do
        [ -f "$source" ] || fail 4 'Only regular files can be sent.'
        head -c 25165825 < "$source" > "$stage/data" || fail 4 'Cannot read the file.'
        send_one "${source##*/}" "$(origin_of "$source")"
    done
fi
