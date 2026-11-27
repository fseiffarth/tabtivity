"""What OpenCode does with a prompt the Chat's Stop catches before its first token.

    python3 scripts/verify-cli/opencode/takeback.py <label> <bin> <port> full|mini [case ...]
    → tmp/verify-cli/opencode/<label>/takeback-<mode>-<box32|line>/{<case>_*.esc,stub.jsonl,result.json}

OpenCode 2.4.2: an Esc that stops a response before the model wrote anything
or called a tool removes the prompt from the session and puts it back in the
composer ("Esc takes back your last message"). The stub holds each prompt's
answer (`STUB:SLOW`), the probe types it with the Chat's exact writes
(`agentInputWrites`, chat_send.py's `writes`), presses the Chat's Stop (Esc,
a second one 600 ms on while the row asks `esc again`, `finishStop`), then
reads the composer, the session database (is the prompt still stored?), the
turn record the session plugin leaves, and what the Chat's next send (same
writes, its box reset first) gets to the model: its own words alone, or
the taken-back words in front of them.

Cases (default: all): `single` (one line), `multi` (two lines), `tall`
(twelve lines: more than a short reset empties), `late` (the
Stop after the answer started streaming: nothing should come back), `draft`
(three lines typed into the box by hand, then the Chat's send: what the
reset leaves of a draft, no Stop). `VERIFY_OC_RESET=line` swaps the box
reset for the line reset alone; `VERIFY_OC_RESET_LINES` sizes the box reset.
Run it outside an OpenCode tab (chat_send.py's note).
"""
import glob
import json
import os
import sqlite3
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import oc  # noqa: E402
from oc import common  # noqa: E402

WRITE_GAP = 0.024
SUBMIT_GAP = 0.2
ESC_GAP = 0.6
LINE_RESET = "\x01\x0b"
# What the app writes first (`openCodeBoxReset`): every logical line of the
# box emptied bottom-up (Ctrl-E Ctrl-U Backspace: OpenCode's `input_line_end`,
# `input_delete_to_line_start`, `input_backspace`), then the line reset.
# `VERIFY_OC_RESET=line` replays the line reset alone, as before 2026-11-26.
RESET_LINES = int(os.environ.get("VERIFY_OC_RESET_LINES", "32"))
BOX_RESET = "\x05\x15\x7f" * RESET_LINES + LINE_RESET
RESET = LINE_RESET if os.environ.get("VERIFY_OC_RESET") == "line" else BOX_RESET
PASTE = ("\x1b[200~", "\x1b[201~")


def writes(text, bracketed):
    """agentInputWrites(text, bracketed, "opencode") for text with no `@`."""
    if bracketed and len(text) > 1:
        return [RESET, PASTE[0] + text + PASTE[1], "\r"]
    out = [RESET]
    for i, line in enumerate(text.split("\n")):
        if i:
            out.append("\n")
        out.append(line)
    return out + ["\r"]


def send(t, ws):
    for i, w in enumerate(ws):
        subprocess.run(t.T + ["send-keys", "-t", "p", "-H", *[f"{b:02x}" for b in w.encode()]])
        if i + 1 < len(ws):
            time.sleep(SUBMIT_GAP if i + 2 == len(ws) else WRITE_GAP)


def bracketed_on(raw):
    try:
        data = open(raw, "rb").read()
    except FileNotFoundError:
        return False
    return data.rfind(b"\x1b[?2004h") > data.rfind(b"\x1b[?2004l")


def busy(t):
    p = t.plain()
    return "esc interrupt" in p or "esc stop" in p or "esc again" in p


def wait_until(pred, secs, step=0.2):
    t0 = time.time()
    while time.time() - t0 < secs:
        if pred():
            return True
        time.sleep(step)
    return False


def stored(home, marker):
    """Rows of the session database that carry `marker` (prompt text)."""
    hits = []
    for db in glob.glob(os.path.join(home, ".local", "share", "opencode", "*.db")):
        try:
            c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
            for table in ("session_message", "session_part", "message", "part"):
                try:
                    for (data,) in c.execute(f"select data from {table}"):
                        if data and marker in str(data):
                            hits.append(table)
                except sqlite3.Error:
                    pass
        except sqlite3.Error:
            pass
    return hits


def turn_words(live):
    out = {}
    for f in glob.glob(os.path.join(live, "*.turn")):
        out[os.path.basename(f)] = open(f).read().strip()[:80]
    return out


label, binp, port, mode = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
cases = sys.argv[5:] or ["single", "multi", "tall", "late", "draft"]
# One folder per reset: two runs at once must not share the stub's log.
run = f"takeback-{mode}-" + ("line" if RESET == LINE_RESET else f"box{RESET_LINES}")
out = common.out_dir("opencode", label, run)
home = common.out_dir("opencode", label, f"h-{run}-{int(time.time())}")
work = common.out_dir("opencode", label, os.path.basename(home), "work")
env, live = oc.home_env(home, oc.stub_config(port))
log = os.path.join(out, "stub.jsonl")
raw = os.path.join(out, "raw.log")
for f in (log, raw):
    if os.path.exists(f):
        os.remove(f)
stub = common.start_stub("stub_openai.py", port, log)
args = ["--standalone"] if mode == "full" else ["mini", "--model", "ollama/stub", "--standalone"]
t = common.Tui(out, [binp, *args], work, env)
subprocess.run(t.T + ["pipe-pane", "-t", "p", "-o", f"cat >> {raw}"])
result = {}
try:
    print(label, mode, "ready", t.wait("stub", 30), flush=True)
    time.sleep(3)
    br = bracketed_on(raw)
    result["bracketed"] = br
    for case in cases:
        wait_until(lambda: not busy(t), 20)
        time.sleep(1.0)
        mark = case.upper() + "MARK"
        if case == "draft":
            # Typed, not pasted: a paste becomes one `[Pasted ~3 lines]` part.
            send(t, ["Draft one DRAFTMARK.", "\n", "Draft two TWOMARK.", "\n", "Draft three."])
            time.sleep(1.0)
            t.cap("draft_typed")
            nxt = f"Say NEXT{mark}."
            n1 = len(oc.reqs(log))
            send(t, writes(nxt, br))
            arrived = wait_until(lambda: any(f"NEXT{mark}" in x.get("prompt", "") for x in oc.reqs(log)[n1:]), 10)
            sent = [x.get("prompt", "") for x in oc.reqs(log)[n1:] if f"NEXT{mark}" in x.get("prompt", "")
                    and "Reply with only the title" not in x.get("prompt", "")]
            wait_until(lambda: not busy(t), 15)
            t.cap("draft_next")
            result[case] = r = {"next_arrived": arrived, "next_prompt": sent[:1],
                                "next_carries_draft": any("Draft one" in p or "TWOMARK" in p or "Draft three" in p for p in sent)}
            print(case, json.dumps(r), flush=True)
            continue
        hold = 2 if case == "late" else 12
        text = f"STUB:SLOW {hold} Say {mark}." + ("\nSecond line TWOMARK." if case == "multi" else "")
        if case == "tall":
            text += "".join(f"\nLine {n} of the tall one." for n in range(2, 12)) + "\nLast line TWOMARK."
        n0 = len(oc.reqs(log))
        send(t, writes(text, br))
        got = wait_until(lambda: any(mark in x.get("prompt", "") for x in oc.reqs(log)[n0:]), 10)
        if case == "late":
            # The answer streams after 2 s and the turn ends: Stop then lands
            # on an idle box, as the Chat's would on a turn just done.
            wait_until(lambda: not busy(t), 15)
        else:
            time.sleep(1.5)
        t.cap(f"{case}_before_stop")
        was_busy = busy(t)
        before_db = stored(home, mark)
        send(t, ["\x1b"])
        time.sleep(ESC_GAP)
        again = "esc again" in t.plain()
        if again:
            send(t, ["\x1b"])
        time.sleep(2.0)
        t.cap(f"{case}_after_stop")
        screen = t.plain()
        tail = "\n".join(screen.split("\n")[-10:])
        r = {"reached_model": got, "busy_at_stop": was_busy, "esc_again_asked": again,
             "busy_after_stop": busy(t), "stored_before": before_db, "stored_after": stored(home, mark),
             "box_holds_prompt": mark in tail, "box_holds_line2": "TWOMARK" in tail,
             "turn_after_stop": turn_words(live)}
        # The Chat's next send: Ctrl-A Ctrl-K, its words, Enter.
        nxt = f"Say NEXT{mark}."
        n1 = len(oc.reqs(log))
        send(t, writes(nxt, br))
        arrived = wait_until(lambda: any(f"NEXT{mark}" in x.get("prompt", "") for x in oc.reqs(log)[n1:]), 10)
        sent = [x.get("prompt", "") for x in oc.reqs(log)[n1:] if f"NEXT{mark}" in x.get("prompt", "")
                and "Reply with only the title" not in x.get("prompt", "")]
        wait_until(lambda: not busy(t), 15)
        t.cap(f"{case}_next")
        r.update({"next_arrived": arrived, "next_prompt": sent[:1],
                  "next_carries_taken_back": any(mark in p.replace(f"NEXT{mark}", "") for p in sent),
                  "next_carries_line2": any("TWOMARK" in p or "tall one" in p for p in sent),
                  "turn_after_next": turn_words(live)})
        result[case] = r
        print(case, json.dumps(r), flush=True)
finally:
    with open(os.path.join(out, "result.json"), "w") as f:
        json.dump(result, f, indent=1)
    t.close()
    stub.terminate()
print(json.dumps(result, indent=1))
