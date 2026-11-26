"""Whether OpenCode takes a prompt typed the way the desktop Chat and the phone type it.

    python3 scripts/verify-cli/opencode/chat_send.py <label> <bin> <port> full|mini [case ...]
    → tmp/verify-cli/opencode/<label>/chat_send-<mode>/{<case>_*.esc,stub.jsonl,raw.log,result.json}

The Chat's composer never presses keys: `shared/agentComposer.ts`
(`agentInputWrites`) writes OpenCode's box reset (`openCodeBoxReset`), the words (one bracketed paste
where the pane has the mode on, else typed), then Enter — with a space in
front of the Enter when the last word opens OpenCode's `@` picker — 24 ms
apart with the Enter 200 ms after the rest (`scheduledAgentInput.ts`). This
replays those exact bytes (`tmux send-keys -H`, one write each) into a real
OpenCode against the stub model and reads the stub's log for whether each
Enter submitted (every case carries its own marker word).

Cases (default: all): `idle`, `multi` (two lines), `long` (over 256 code
points), `char` (one character, typed), `mention` (ends `@<file>`: the fix),
`mention_bare` (the same without the space, as before the fix), `mention_mid`
(`@<file>` then words), `mention_miss` (ends `@` a name matching no file),
`email` (ends `me@example.org`), `dialog` (the command palette up first,
closed by `openCodeDialogCloseKeys`' Esc), `busy` (sent while a turn runs:
OpenCode's queue), `stop` (the Chat's Stop, one Esc, on a running turn),
`new` (`/new`), `clear` (`/clear`, what the Chat's Clear types).
"""
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import oc  # noqa: E402
from oc import common  # noqa: E402

WRITE_GAP = 0.024
SUBMIT_GAP = 0.2
CHUNK = 256
# `openCodeBoxReset()`: every line of the box, from the cursor's up, then the
# line reset (`shared/agentComposer.ts`, 32 lines).
RESET = "\x05\x15\x7f" * 32 + "\x01\x0b"
PASTE = ("\x1b[200~", "\x1b[201~")
INBOX = os.path.join(f".{common.SLUG}", "inbox")
SHOT = f"{INBOX}/20261126-100000-shot.png"
# A 1×1 PNG.
PNG = bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000"
                    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082")


def writes(text, bracketed, mention_fix=True):
    """agentInputWrites(text, bracketed, "opencode")."""
    import re
    close = mention_fix and re.search(r"(?:^|\s)@\S*$", text)
    submit = [" ", "\r"] if close else ["\r"]
    if bracketed and len(text) > 1:
        return [RESET, PASTE[0] + text + PASTE[1], *submit]
    out = [RESET]
    for i, line in enumerate(text.split("\n")):
        if i:
            out.append("\n")
        out += [line[s:s + CHUNK] for s in range(0, len(line), CHUNK)]
    return out + submit


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


def prompts(log):
    return [x.get("prompt", "") for x in oc.reqs(log) if "prompt" in x]


def busy(t):
    p = t.plain()
    return "esc interrupt" in p or "esc stop" in p or "esc again" in p


def settle(t, secs=30):
    t0 = time.time()
    while time.time() - t0 < secs:
        p = t.plain()
        if "Allow once" in p:
            t.keys("Enter")
            time.sleep(0.6)
            continue
        if not busy(t):
            time.sleep(1.0)
            if not busy(t):
                return True
        time.sleep(0.3)
    return False


def submitted(log, marker, secs):
    t0 = time.time()
    while time.time() - t0 < secs:
        got = [p for p in prompts(log) if marker in p]
        if got:
            return got
        time.sleep(0.25)
    return []


label, binp, port, mode = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
cases = sys.argv[5:] or ["idle", "multi", "long", "char", "mention", "mention_bare", "mention_mid",
                         "mention_miss", "email", "dialog", "stop", "busy", "new", "clear"]
run = f"chat_send-{mode}"
out = common.out_dir("opencode", label, run)
home = common.out_dir("opencode", label, f"h-{run}")
work = common.out_dir("opencode", label, f"h-{run}", "work")
os.makedirs(os.path.join(work, INBOX), exist_ok=True)
with open(os.path.join(work, SHOT), "wb") as f:
    f.write(PNG)
env, _live = oc.home_env(home, oc.stub_config(port))
log = os.path.join(out, "stub.jsonl")
raw = os.path.join(out, "raw.log")
for f in (log, raw):
    if os.path.exists(f):
        os.remove(f)
stub = common.start_stub("stub_openai.py", port, log)
args = ["--standalone"] if mode == "full" else ["mini", "--model", "ollama/stub", "--standalone"]
t = common.Tui(out, [binp, *args], work, env)
subprocess.run(t.T + ["pipe-pane", "-t", "p", "-o", f"cat >> {raw}"])
texts = {
    "idle": "Say IDLEMARK.",
    "multi": "Say MULTIMARK.\nNothing else.",
    # The stub logs a prompt's last 300 characters: the marker goes last.
    "long": "Say this. " + "padding " * 40 + "LONGMARK",
    "mention": f"Say MENTIONMARK about @{SHOT}",
    "mention_bare": f"Say BAREMARK about @{SHOT}",
    "mention_mid": f"Say MIDMARK about @{SHOT} please",
    "mention_miss": "Say MISSMARK about @nosuchfilehere",
    "email": "Say EMAILMARK to me@example.org",
    "dialog": "Say DIALOGMARK.",
    "busy": "Say QUEUEMARK.",
}
result = {}
try:
    print(label, mode, "ready", t.wait("stub", 30), flush=True)
    time.sleep(3)
    br = bracketed_on(raw)
    print(label, mode, "bracketed paste", br, flush=True)
    result["bracketed"] = br
    t.cap("start")
    for case in cases:
        settle(t)
        time.sleep(1.0)
        if case == "char":
            n0 = len(prompts(log))
            send(t, writes("k", br))
            time.sleep(4)
            got = prompts(log)[n0:]
            result[case] = {"submitted": bool(got), "prompt": got[:1]}
        elif case in ("busy", "stop"):
            secs = 8 if case == "busy" else 9
            send(t, writes(f'STUB:CALL bash {{"command":"sleep {secs}","description":"hold the turn"}}', br))
            t0 = time.time()
            while time.time() - t0 < 10 and not busy(t):
                if "Allow once" in t.plain():
                    t.keys("Enter")
                time.sleep(0.2)
            time.sleep(1.0)
            t.cap(f"{case}_running")
            if case == "busy":
                send(t, writes(texts["busy"], br))
                time.sleep(0.8)
                t.cap("busy_queued")
                got = submitted(log, "QUEUEMARK", 30)
                result[case] = {"submitted": bool(got), "prompt": got[:1]}
            else:
                n0 = len(oc.reqs(log))
                result["stop_was_busy"] = busy(t)
                # The Chat's Stop: Esc, then a second one 600 ms on while the
                # row asks for it (`finishStop` in queuePull.ts).
                send(t, ["\x1b"])
                time.sleep(0.6)
                t.cap("stop_after_one_esc")
                again = "esc again" in t.plain()
                one = busy(t)
                send(t, ["\x1b"])
                time.sleep(1.5)
                t.cap("stop_after_two_esc")
                result[case] = {"busy_after_one_esc": one, "again_hint_at_600ms": again,
                                "busy_after_two_esc": busy(t), "requests_since": len(oc.reqs(log)) - n0}
        elif case in ("new", "clear"):
            n0 = len(oc.reqs(log))
            before = t.plain()
            send(t, writes(f"/{case}", br))
            time.sleep(2.5)
            t.cap(f"{case}_after")
            after = t.plain()
            # Then a prompt: a new session's first answer asks for a title.
            send(t, writes(f"Say {case.upper()}MARK.", br))
            got = submitted(log, f"{case.upper()}MARK", 8)
            reqs = oc.reqs(log)[n0:]
            result[case] = {"screen_changed": before != after,
                            "box_still_holds": f"/{case}" in "\n".join(after.split("\n")[-8:]),
                            "went_to_model": any(f"/{case}" in x.get("prompt", "") for x in reqs),
                            "next_prompt_new_session": any("Reply with only the title" in x.get("prompt", "")
                                                           and f"{case.upper()}MARK" in x.get("prompt", "") for x in reqs),
                            "next_submitted": bool(got)}
        else:
            marker = {"mention_bare": "BAREMARK", "mention_mid": "MIDMARK", "mention_miss": "MISSMARK"}.get(
                case, case.upper() + "MARK")
            if case == "dialog":
                t.keys("C-p", pause=1.5)
                t.cap("dialog_open")
                send(t, ["\x1b"])  # openCodeDialogCloseKeys' DIALOG_CLOSE (checked below)
                time.sleep(WRITE_GAP)
            send(t, writes(texts[case], br, mention_fix=case != "mention_bare"))
            time.sleep(0.8)
            t.cap(f"{case}_after_enter")
            got = submitted(log, marker, 8)
            result[case] = {"submitted": bool(got), "prompt": got[:1]}
            if not got:
                t.cap(f"{case}_stuck")
                send(t, ["\x1b", RESET])
        print(label, mode, case, json.dumps(result[case])[:300], flush=True)
finally:
    t.close()
    stub.terminate()
common.write_json(os.path.join(out, "result.json"), result)
# What the store keeps of a mention prompt: the Chat's sending bubble is matched against it.
import glob  # noqa: E402
import sqlite3  # noqa: E402
for db in glob.glob(os.path.join(home, ".local", "share", "opencode", "*.db")):
    c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    for (data,) in c.execute("select data from session_message where data like '%MENTIONMARK%' or data like '%MIDMARK%'"):
        print(label, mode, "stored", data[:600])
