"""What OpenCode does with prompts the Chat queues mid-turn (Ctrl+X Enter).

    python3 scripts/verify-cli/opencode/queue.py <label> <bin> <port> full|mini [case ...]
    → tmp/verify-cli/opencode/<label>/queue-<mode>/{<case>_*.esc,stub.jsonl,result.json}

`agentQueueWrites` (shared/agentComposer.ts) ends an OpenCode prompt with
Ctrl+X, Enter. A turn is held with a `sleep` tool call, two prompts are sent
that way (the second has two lines), and the cases read what `queuePull.ts`
relies on:

  `marks`    the full TUI's `N queued · <first prompt>` row / the mini's
             `ctrl+x q N pending` footer (a plain Enter, as the Chat sent
             before, shows neither in the full TUI);
  `panel`    `ctrl+x q`: the full TUI's `Search queued prompts` dialog (one
             row a prompt, its first line, `1 of 2` at the right) / the mini's
             `Pending prompts` panel;
  `delete`   ctrl+d twice takes both out; the full TUI's dialog closes itself;
  `stop`     Esc, Esc: the turn is interrupted and the queue STAYS, nothing
             runs (2.4.2; the mini kept it too);
  `release`  after that stop, `ctrl+x q` then Enter sends the top prompt and
             the second follows as a turn of its own (`finishSendNow`);
  `idle`     the chord on an idle OpenCode just submits the prompt.

`ctrl+x q` with nothing queued QUITS the full TUI: never pressed without a mark.
Run it from a tab that is not OpenCode, or with `OPENCODE*` and the app's
`*_OPENCODE_SESSION` unset (see chat_send.py).
"""
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import oc  # noqa: E402
from oc import common  # noqa: E402

RESET = "\x05\x15\x7f" * 32 + "\x01\x0b"
PASTE = ("\x1b[200~", "\x1b[201~")
HOLD = 'STUB:CALL bash {"command":"sleep 25","description":"hold"}'
CASES = ["idle", "marks", "panel", "delete", "stop", "release"]

label, binp, port, mode = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
cases = sys.argv[5:] or CASES
out = common.out_dir("opencode", label, f"queue-{mode}")


def prompts(log):
    return [p for p in (x.get("prompt", "") for x in oc.reqs(log)) if p and "Reply with only the title" not in p]


def run_case(case):
    home = common.out_dir("opencode", label, f"h-queue-{mode}-{case}")
    work = common.out_dir("opencode", label, f"h-queue-{mode}-{case}", "work")
    env, _live = oc.home_env(home, oc.stub_config(port))
    log = os.path.join(out, f"stub-{case}.jsonl")
    if os.path.exists(log):
        os.remove(log)
    stub = common.start_stub("stub_openai.py", port, log)
    args = ["--standalone"] if mode == "full" else ["mini", "--model", "ollama/stub", "--standalone"]
    t = common.Tui(out, [binp, *args], work, env)

    def send(text, chord=True):
        ws = [RESET, PASTE[0] + text + PASTE[1]] + (["\x18"] if chord else []) + ["\r"]
        for w in ws:
            subprocess.run(t.T + ["send-keys", "-t", "p", "-H", *[f"{b:02x}" for b in w.encode()]])
            time.sleep(0.25)

    result = {}
    try:
        t.wait("stub", 30)
        time.sleep(3)
        if case == "idle":
            send("Say IDLEQ.")
            time.sleep(4)
            result["submitted"] = "Say IDLEQ." in prompts(log)
            return result
        send(HOLD, chord=False)
        time.sleep(3)
        if "Allow once" in t.plain():
            t.keys("Enter")
        send("Say QA1.")
        time.sleep(0.5)
        send("Say QB2 line one.\nsecond line")
        time.sleep(0.8)
        t.cap("queued")
        screen = t.plain()
        result["marks"] = {"queued_row": " queued · " in screen, "pending_footer": " pending" in screen and "ctrl+x q" in screen}
        if case == "marks":
            return result
        t.keys("C-x", "q", pause=1.2)
        t.cap("panel")
        panel = t.plain()
        result["panel"] = {"full_dialog": "Search queued prompts" in panel, "mini_panel": "Pending prompts 2" in panel,
                           "rows": [l.strip() for l in panel.split("\n") if "QA1" in l or "QB2" in l]}
        if case == "panel":
            return result
        if case == "delete":
            t.keys("C-d", pause=1.0)
            t.cap("one_left")
            t.keys("C-d", pause=1.0)
            t.cap("none_left")
            after = t.plain()
            result["panel_gone"] = "Search queued prompts" not in after and "Pending prompts" not in after
            result["queue_gone"] = " queued · " not in after and " pending" not in after
            return result
        t.keys("Escape", pause=0.3)  # closes the panel
        t.keys("Escape", pause=0.7)
        t.keys("Escape", pause=2.0)
        t.cap("stopped")
        stopped = t.plain()
        result["stop"] = {"still_queued": " queued · " in stopped or " pending" in stopped, "ran": prompts(log)[-1:]}
        if case == "stop":
            return result
        t.keys("C-x", "q", pause=1.2)
        t.keys("Enter", pause=4.0)
        t.cap("released")
        result["release"] = {"prompts": [p[-40:] for p in prompts(log)]}
        return result
    finally:
        time.sleep(0.3)
        t.close()
        stub.terminate()


results = {case: run_case(case) for case in cases}
common.write_json(os.path.join(out, "result.json"), results)
print(json.dumps(results, indent=1))
