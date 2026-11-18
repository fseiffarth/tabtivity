"""Whether Claude takes a prompt typed the way the desktop Chat and the phone type it.

    python3 scripts/verify-cli/claude/chat_send.py <label> <claude-bin> [case ...]
    → tmp/verify-cli/claude/<label>/chat_send/{<case>_*.esc,dump/*.json,result.json}

The Chat's composer never presses keys: `shared/agentComposer.ts`
(`agentInputWrites`) writes Ctrl-A Ctrl-K, the words in pieces of at most 256
code points (a newline as its own Ctrl-J write), then Enter, 24 ms apart with
the Enter 200 ms after the last piece (`scheduledAgentInput.ts`). This replays
those exact bytes (`tmux send-keys -H`, one write each) into a real Claude and
reads the `UserPromptSubmit` hook to see whether the Enter submitted.

Cases (default: all): `fresh` (sent as soon as the box is drawn), `idle`
(a one-line prompt into a settled box), `multi` (two lines), `long` (one line
over 256 code points), `busy` (sent while a turn runs: Claude's queue).
Real HOME (needs the login), `--model haiku`: small paid turns.
"""
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import common  # noqa: E402

WRITE_GAP = 0.024
SUBMIT_GAP = 0.2
CHUNK = 256


def writes(text):
    """agentInputWrites(text, false): the Claude path (never bracketed)."""
    out = ["\x01\x0b"]
    for i, line in enumerate(text.split("\n")):
        if i:
            out.append("\n")
        chars = list(line)
        out += ["".join(chars[s:s + CHUNK]) for s in range(0, len(chars), CHUNK)]
    out.append("\r")
    return out


def send(t, text):
    ws = writes(text)
    for i, w in enumerate(ws):
        hexes = [f"{b:02x}" for b in w.encode()]
        subprocess.run(t.T + ["send-keys", "-t", "p", "-H", *hexes])
        if i + 1 < len(ws):
            time.sleep(SUBMIT_GAP if i + 2 == len(ws) else WRITE_GAP)


def submits(dump):
    n = []
    for f in sorted(os.listdir(dump)):
        try:
            d = json.load(open(os.path.join(dump, f)))
        except (OSError, ValueError):
            continue
        if d.get("hook_event_name") == "UserPromptSubmit":
            n.append(d.get("prompt", ""))
    return n


def idle(t, secs=60):
    """The box is drawn and no turn runs (no `esc to interrupt`)."""
    t0 = time.time()
    while time.time() - t0 < secs:
        p = t.plain()
        if "❯" in p and "esc to interrupt" not in p and "Do you want" not in p:
            return True
        time.sleep(0.25)
    return False


label, binp = sys.argv[1], sys.argv[2]
cases = sys.argv[3:] or ["fresh", "idle", "multi", "long", "busy"]
out = common.out_dir("claude", label, "chat_send")
dump = f"{out}/dump"
os.makedirs(dump, exist_ok=True)
for f in os.listdir(dump):
    os.remove(os.path.join(dump, f))
work = common.out_dir("claude", label, "chat_send", "work")
hook = f"{out}/hook.sh"
with open(hook, "w") as f:
    f.write(f'#!/bin/sh\nf="{dump}/$(date +%s%N).json"; cat > "$f"\n')
os.chmod(hook, 0o755)
common.write_json(f"{out}/settings.json", {"hooks": {e: [{"hooks": [{"type": "command", "command": hook}]}]
                                                     for e in ["SessionStart", "UserPromptSubmit", "Stop"]}})
argv = [binp, "--settings", f"{out}/settings.json", "--model", "haiku"]
prompts = {
    "fresh": "Reply with the single word FRESH.",
    "idle": "Reply with the single word IDLE.",
    "multi": "Reply with the single word MULTI.\nNothing else.",
    "long": "Reply with the single word LONG. " + "padding " * 40,
    "busy": "Reply with the single word QUEUED.",
}
result = {}
t = common.Tui(out, argv, work, size=(120, 40))
try:
    t0 = time.time()
    while time.time() - t0 < 60:
        p = t.plain()
        if "trust" in p.lower() and "Yes" in p:
            t.cap("trust")
            t.keys("Enter")
            time.sleep(1)
        elif "❯" in p:
            break
        time.sleep(0.2)
    for case in cases:
        if case != "fresh":
            idle(t)
            time.sleep(1.5)
        before = len(submits(dump))
        if case == "busy":
            send(t, "Write the numbers from 1 to 300, one per line, nothing else.")
            time.sleep(1.5)
            t.cap("busy_running")
            before = len(submits(dump))
        send(t, prompts[case])
        time.sleep(0.6)
        t.cap(f"{case}_after_enter")
        t1 = time.time()
        while time.time() - t1 < (25 if case == "busy" else 8) and len(submits(dump)) <= before:
            time.sleep(0.25)
        got = submits(dump)[before:]
        result[case] = {"submitted": bool(got), "prompt": got[:1], "secs": round(time.time() - t1, 1)}
        t.cap(f"{case}_end")
        if not got:
            # leave a clean box for the next case
            t.keys("C-u")
        print(label, case, result[case], flush=True)
        idle(t, 60)
    t.keys("C-c")
    time.sleep(0.5)
    t.keys("C-c")
finally:
    t.close()
common.write_json(f"{out}/result.json", result)
