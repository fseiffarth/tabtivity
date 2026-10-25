#!/usr/bin/env bash
# spd_wait_probe.sh -- how late is `spd-say --wait -e` relative to the sound?
#
# Records the default sink's monitor (what actually goes to the speakers),
# speaks a few chunks through `spd-say --wait -e -l <lang>` (text on stdin,
# stdout discarded), and prints for each chunk:
#
#   tail_ms = (time the sink went silent) - (time spd-say exited)
#
#   > 0  spd-say returned while audio was still playing (the mute gate's
#        tail must cover at least this much)
#   ~ 0  spd-say returned when the audio ended
#   < 0  spd-say returned after the audio ended (the synth's trailing
#        silence is still "playing" though the room is already quiet)
#
# Then it kills an spd-say child mid-sentence and reports whether the voice
# keeps talking (does killing the child stop the speech?).
#
# Needs: spd-say (speech-dispatcher), parec (pulseaudio-utils; talks to
# pipewire-pulse on a PipeWire desktop), python3. Run it in your normal
# desktop session, outside any sandbox, with the speakers on (volume can be
# low: the monitor taps the digital signal before the volume knob of the
# device). Keep other sounds (music, videos, notifications) off while it runs.
#
# Usage: ./spd_wait_probe.sh [-o output-module] [-r rate]
set -euo pipefail

MODULE=""
RATE=""
while getopts "o:r:h" opt; do
    case "$opt" in
        o) MODULE="$OPTARG" ;;
        r) RATE="$OPTARG" ;;
        *) sed -n '2,25p' "$0"; exit 0 ;;
    esac
done

for bin in spd-say parec python3; do
    if ! command -v "$bin" >/dev/null 2>&1; then
        echo "MISSING: $bin (spd-say: speech-dispatcher; parec: pulseaudio-utils)" >&2
        exit 2
    fi
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/spdprobe.XXXXXX")"
REC_PID=""
cleanup() {
    if [ -n "$REC_PID" ]; then kill "$REC_PID" 2>/dev/null || true; fi
    rm -rf "$WORK"
}
trap cleanup EXIT

now_ns() { date +%s%N; }

# --- the meter: reads raw s16le mono 16 kHz from stdin, writes
#     "<end-of-window wall-clock ns> <rms 0..1>" per 10 ms window.
cat >"$WORK/meter.py" <<'PY'
import os, sys, time, math, struct
RATE = 16000
WIN = 160                      # 10 ms
fd = sys.stdin.fileno()
out = open(sys.argv[1], "w", buffering=1)
pending = b""
while True:
    chunk = os.read(fd, 65536)
    if not chunk:
        break
    t_read = time.time_ns()
    pending += chunk
    nwin = len(pending) // (2 * WIN)
    if nwin == 0:
        continue
    body, pending = pending[: nwin * 2 * WIN], pending[nwin * 2 * WIN:]
    # samples still unread in `pending` were captured after the last window
    tail_after = len(pending) // 2
    for k in range(nwin):
        s = struct.unpack_from("<%dh" % WIN, body, k * 2 * WIN)
        rms = math.sqrt(sum(x * x for x in s) / WIN) / 32768.0
        samples_after = (nwin - 1 - k) * WIN + tail_after
        t_end = t_read - samples_after * 1_000_000_000 // RATE
        out.write("%d %.6f\n" % (t_end, rms))
PY

# --- the analysis: per event, onset and silence relative to spd-say's exit.
cat >"$WORK/analyze.py" <<'PY'
import sys, statistics
meter_path, events_path = sys.argv[1], sys.argv[2]
rows = []
with open(meter_path) as f:
    for line in f:
        p = line.split()
        if len(p) == 2:
            rows.append((int(p[0]), float(p[1])))
if not rows:
    print("ERROR: no audio frames recorded from the monitor (is parec working?)")
    sys.exit(3)
# noise floor from the first 0.8 s, recorded before anything is spoken
t0 = rows[0][0]
floor = [r for t, r in rows if t - t0 < 800_000_000] or [0.0]
thr = max(0.003, 4 * statistics.median(floor))
print("monitor noise floor %.5f, threshold %.5f" % (statistics.median(floor), thr))
print()
tails = []
with open(events_path) as f:
    for line in f:
        kind, label, t_start, t_ret, t_win_end = line.rstrip("\n").split("\t")
        t_start, t_ret, t_win_end = int(t_start), int(t_ret), int(t_win_end)
        loud = [t for t, r in rows if t_start <= t <= t_win_end and r >= thr]
        if not loud:
            print("%-6s %-28s NO SOUND detected on the monitor" % (kind, label))
            continue
        onset = (loud[0] - 10_000_000 - t_start) / 1e6   # window start
        silent = loud[-1]                                 # end of last loud window
        tail = (silent - t_ret) / 1e6
        if kind == "speak":
            tails.append(tail)
            print("%-6s %-28s onset %6.0f ms after start, spd-say ran %6.0f ms, "
                  "tail_ms = %+6.0f" % (kind, label, onset, (t_ret - t_start) / 1e6, tail))
        else:
            print("%-6s %-28s killed at +%.0f ms; sound continued %+.0f ms after the kill"
                  % (kind, label, (t_ret - t_start) / 1e6, tail))
            print("       -> %s" % ("KILLING spd-say DOES NOT STOP THE VOICE" if tail > 300
                                    else "killing spd-say stopped the voice"))
if tails:
    print()
    print("RESULT tail_ms: median %+.0f, max %+.0f, min %+.0f  (n=%d)"
          % (statistics.median(tails), max(tails), min(tails), len(tails)))
PY

echo "speech-dispatcher: $(spd-say -v 2>/dev/null | head -n1)"
echo "default sink:      $(pactl get-default-sink 2>/dev/null || echo '?')"
echo "sound server:      $(pactl info 2>/dev/null | sed -n 's/^Server Name: //p')"
echo "recording @DEFAULT_MONITOR@ ..."

parec -d @DEFAULT_MONITOR@ --raw --format=s16le --channels=1 --rate=16000 \
      --latency-msec=10 2>"$WORK/parec.err" \
    | python3 -u "$WORK/meter.py" "$WORK/meter.log" &
REC_PID=$!
for _ in $(seq 50); do            # wait up to 5 s for the first frames
    [ -s "$WORK/meter.log" ] && break
    sleep 0.1
done
sleep 1                           # then 1 s of noise floor
if [ ! -s "$WORK/meter.log" ]; then
    echo "ERROR: parec delivered nothing:" >&2
    cat "$WORK/parec.err" >&2
    exit 3
fi

SPD_ARGS=(--wait -e)
[ -n "$MODULE" ] && SPD_ARGS+=(-o "$MODULE")
[ -n "$RATE" ] && SPD_ARGS+=(-r "$RATE")

# one chunk per line: <lang> TAB <label> TAB <text>
CHUNKS="$WORK/chunks.tsv"
cat >"$CHUNKS" <<'EOF'
de	de short	Hallo.
de	de sentence	Das ist ein kurzer Test der Sprachausgabe.
de	de dash-first	- Erstens, eine Zeile, die mit einem Bindestrich beginnt.
en	en short	Okay.
en	en sentence	This is a short test of the speech output.
en	en dash-first	-v --help is not an option here, just text.
en	en two sentences	The build finished. All tests passed without warnings.
EOF

: >"$WORK/events.tsv"
while IFS=$'\t' read -r lang label text; do
    t_start=$(now_ns)
    printf '%s\n' "$text" | spd-say "${SPD_ARGS[@]}" -l "$lang" >/dev/null
    t_ret=$(now_ns)
    sleep 1.5          # let any remaining audio play out and be recorded
    printf 'speak\t%s\t%s\t%s\t%s\n' "$label" "$t_start" "$t_ret" "$(now_ns)" >>"$WORK/events.tsv"
done <"$CHUNKS"

# kill test: does killing the child stop the speech?
t_start=$(now_ns)
printf '%s\n' "Dieser Satz ist absichtlich recht lang, damit er noch läuft, wenn der Prozess nach einer Sekunde beendet wird, und wir hören, ob die Stimme weiterspricht." \
    | spd-say "${SPD_ARGS[@]}" -l de >/dev/null &
SPD_PID=$!
sleep 1.0
kill "$SPD_PID" 2>/dev/null || true
wait "$SPD_PID" 2>/dev/null || true
t_kill=$(now_ns)
sleep 8
printf 'kill\t%s\t%s\t%s\t%s\n' "de long, killed at 1s" "$t_start" "$t_kill" "$(now_ns)" >>"$WORK/events.tsv"
# silence anything left over. Not `spd-say -S`: on 0.12.0~rc2 it spun at
# 100% CPU and never exited when nothing was speaking.
timeout 5 spd-say -C >/dev/null 2>&1 || true

kill "$REC_PID" 2>/dev/null || true
wait "$REC_PID" 2>/dev/null || true
REC_PID=""
echo
python3 "$WORK/analyze.py" "$WORK/meter.log" "$WORK/events.tsv"
