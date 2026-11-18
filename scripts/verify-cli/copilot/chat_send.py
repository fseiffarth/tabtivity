"""Whether Copilot takes a prompt sent the way the desktop Chat and the phone send it.

    python3 scripts/verify-cli/copilot/chat_send.py <label> <copilot-bin> [port] [case ...]
    → tmp/verify-cli/copilot/<label>/chat_send/{<case>_*.esc,stub.jsonl,result.json}

The Chat's composer never presses keys: `shared/agentComposer.ts`
(`agentInputWrites`) writes Ctrl-A Ctrl-K, then the whole message inside
bracketed-paste markers as one write (Copilot's pane has the mode on), then
Enter 200 ms later (`scheduledAgentInput.ts`). This replays those exact bytes
(`tmux send-keys -H`, one write each) into a real Copilot and reads what
arrived: the stub model's request and the `user.message` record in
`events.jsonl`. A paste Copilot folds into a `[Paste #N - M lines]` label, or
an Enter it swallows as part of the paste, shows here as a wrong or missing
prompt.

Cases (default: all): `fresh` (sent as soon as the box is drawn), `idle` (one
line into a settled box), `multi` (two lines), `long` (one line over 256
code points), `busy` (sent while a `sleep` tool call runs: Copilot's queue).
Offline: BYOK against stub_openai.py, auto-update off, a fresh home per run,
`--allow-all-tools` so the `busy` case's shell call needs no approval.
"""
import glob
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import common  # noqa: E402

SUBMIT_GAP = 0.2
WRITE_GAP = 0.024
PASTE_START, PASTE_END = "\x1b[200~", "\x1b[201~"


def writes(text):
    """agentInputWrites(text, true): the bracketed path every non-Claude CLI gets."""
    return ["\x01\x0b", f"{PASTE_START}{text}{PASTE_END}", "\r"]


def send(t, text):
    ws = writes(text)
    for i, w in enumerate(ws):
        subprocess.run(t.T + ["send-keys", "-t", "p", "-H", *[f"{b:02x}" for b in w.encode()]])
        if i + 1 < len(ws):
            time.sleep(SUBMIT_GAP if i + 2 == len(ws) else WRITE_GAP)


def model_prompts(log):
    """The last user prompt of every model request the stub logged, in order."""
    out = []
    try:
        for line in open(log):
            rec = json.loads(line)
            if "prompt" in rec and rec.get("last_role") == "user":
                out.append(rec["prompt"])
    except (OSError, ValueError):
        pass
    return out


def user_messages(home):
    """Every `user.message` content in the home's session logs, in order."""
    out = []
    for path in sorted(glob.glob(os.path.join(home, ".copilot", "session-state", "*", "events.jsonl"))):
        for line in open(path):
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if rec.get("type") == "user.message":
                out.append((rec.get("data") or {}).get("content", ""))
    return out


def settled(t, secs=40):
    """The input box is drawn and the footer is the idle one."""
    t0 = time.time()
    while time.time() - t0 < secs:
        p = t.plain()
        if "❯" in p and "Interactive" in p and "esc" not in p.splitlines()[-1].lower():
            return True
        time.sleep(0.25)
    return False


args = sys.argv[1:]
if len(args) < 2:
    sys.exit(__doc__)
label, binp = args[0], args[1]
rest = args[2:]
port = int(rest.pop(0)) if rest and rest[0].isdigit() else 47440
cases = rest or ["fresh", "idle", "multi", "long", "busy"]
out = common.out_dir("copilot", label, "chat_send")
home = common.out_dir("copilot", label, f"h-chat_send-{int(time.time())}")
work = os.path.join(home, "work")
os.makedirs(work, exist_ok=True)
# Its own repository, or the trust question offers the enclosing one.
subprocess.run(["git", "init", "-q", work], check=False)
log = os.path.join(out, f"stub-{int(time.time())}.jsonl")
stub = common.start_stub("stub_openai.py", port, log)
if stub.poll() is not None:
    sys.exit(f"the stub did not start on port {port}")
env = common.scratch_env(home, {
    "COPILOT_HOME": f"{home}/.copilot", "COPILOT_AUTO_UPDATE": "false",
    "COPILOT_PROVIDER_BASE_URL": f"http://127.0.0.1:{port}/v1",
    "COPILOT_PROVIDER_API_KEY": "test", "COPILOT_MODEL": "stub",
})
prompts = {
    "fresh": "Reply with the single word FRESH.",
    "idle": "Reply with the single word IDLE.",
    "multi": "Reply with the single word MULTI.\nNothing else.",
    "long": ("Reply with the single word LONG. " + "padding " * 40).strip(),
    "busy": "Reply with the single word QUEUED.",
}
result = {}
t = common.Tui(out, [binp, "--disable-client-telemetry", "--allow-all-tools"], work, env, size=(110, 40))
try:
    t0 = time.time()
    while time.time() - t0 < 60:
        p = t.plain()
        if "trust" in p.lower() and "Yes" in p:
            t.cap("trust")
            t.keys("Enter")
            time.sleep(1)
        elif "❯" in p and "Interactive" in p:
            break
        time.sleep(0.2)
    flag = subprocess.run(t.T + ["display-message", "-p", "-t", "p", "#{bracket_paste_flag}"],
                          capture_output=True, text=True).stdout.strip()
    print(label, "pane bracketed-paste flag:", flag or "(tmux does not report it)", flush=True)
    for case in cases:
        if case != "fresh":
            settled(t)
            time.sleep(1.5)
        if case == "busy":
            send(t, 'STUB:CALL bash {"command": "sleep 8", "description": "wait"}')
            time.sleep(2.5)
            t.cap("busy_running")
        before_model, before_events = len(model_prompts(log)), len(user_messages(home))
        want = prompts[case]
        send(t, want)
        time.sleep(0.6)
        t.cap(f"{case}_after_enter")
        t1 = time.time()
        got = []
        while time.time() - t1 < (30 if case == "busy" else 10):
            got = [p for p in model_prompts(log)[before_model:] if p.strip().endswith(want.strip()[-200:])]
            if got:
                break
            time.sleep(0.25)
        time.sleep(1.0)
        events = user_messages(home)[before_events:]
        result[case] = {
            "submitted": bool(got),
            "secs": round(time.time() - t1, 1),
            "model_got": (model_prompts(log)[before_model:] or [""])[-1][-120:],
            "recorded": [e[-120:] for e in events],
            "recorded_exact": want in events,
        }
        t.cap(f"{case}_end")
        if not got:
            t.keys("C-u")  # leave a clean box for the next case
        print(label, case, json.dumps(result[case], ensure_ascii=False), flush=True)
        settled(t, 60)
    t.keys("C-c")
    time.sleep(0.5)
    t.keys("C-c")
finally:
    t.close()
    stub.terminate()
common.write_json(f"{out}/result.json", result)
sys.exit(0 if all(r["submitted"] and r["recorded_exact"] for r in result.values()) else 1)
