"""Codex: an async question (`request_user_input_async`) — what the screen,
the rollout and the hooks show while it waits and once it is answered.

    python3 scripts/verify-cli/codex/async_question.py <label> <bin> <port> [model]

Offline, as `turn_hooks.py`: a private `CODEX_HOME`, the stub provider, every
hook a dumper (`--dangerously-bypass-hook-trust`). `model` (default
`gpt-6.1-sol`) is the model name Codex is told it talks to: the tool set it
offers follows the model's family, and `stub` may not get the async tool.
The stub calls the tool, then `clock.sleep`, which keeps the turn working
while the question waits; the probe opens the question (shift+←), captures
it and answers the first option; then one skipped (^]), and one left waiting\nas the turn ends, answered after.
Output: tmp/verify-cli/codex/<label>/async_question/.
"""
import glob
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import common  # noqa: E402
from turn_hooks import CURRENT, EXTRA, Home, offered, settle, summarize  # noqa: E402

QUESTION = {"questions": [{"title": "Which window shows the bug?", "options": ["Main window", "Popped-out window", "Phone"]}]}


def main():
    if len(sys.argv) < 4:
        sys.exit(__doc__)
    label, binp, port = sys.argv[1], common.binary(sys.argv[2]), int(sys.argv[3])
    model = sys.argv[4] if len(sys.argv) > 4 else "gpt-6.1-sol"
    base = common.out_dir("codex", label, "async_question")
    log = os.path.join(base, "stub.jsonl")
    if os.path.exists(log):
        os.remove(log)
    stub = common.start_stub("stub_openai.py", port, log)
    home = Home(base, port)
    dump = os.path.join(base, "dump")
    home.write(dump, CURRENT + EXTRA + ["PermissionRequest"], [])
    with open(home.config) as f:
        cfg = f.read().replace('model = "stub"', f'model = "{model}"', 1)
    with open(home.config, "w") as f:
        f.write(cfg)
    argv = [binp, "--no-daemon", "--dangerously-bypass-hook-trust"]
    t = common.Tui(base, argv, home.work, home.env(), size=(110, 36))
    try:
        print("start:", settle(t))
        t.type("hello")
        t.keys("Enter")
        time.sleep(6)
        tools = offered(log)
        name = next((x for x in sorted(tools) if x.endswith("request_user_input_async")), None)
        print("offered:", sorted(tools))
        if not name:
            print("request_user_input_async not offered to model", model)
            t.cap("no-tool")
            return
        # Answered while the turn works: `clock.sleep` (GPT-6 family) keeps
        # it working and ends early on the reply.
        t.type(f"STUB:SEQ {name} {json.dumps(QUESTION)} ;; clock.sleep {json.dumps({'duration_ms': 25000})}")
        t.keys("Enter")
        time.sleep(6)
        t.cap("waiting")
        t.keys("S-Left")
        time.sleep(2)
        t.cap("opened")
        t.keys("Enter")
        time.sleep(2)
        t.cap("answered")
        time.sleep(25)
        t.cap("after")
        # Skipped (^]) while the turn works.
        t.type(f"STUB:SEQ {name} {json.dumps(QUESTION)} ;; clock.sleep {json.dumps({'duration_ms': 12000})}")
        t.keys("Enter")
        time.sleep(5)
        t.keys("S-Left")
        time.sleep(2)
        t.keys("C-]")
        time.sleep(2)
        t.cap("skipped")
        time.sleep(14)
        t.cap("skipped-after")
        # Left waiting while the turn ends; answered from the next idle prompt.
        t.type(f"STUB:CALL {name} {json.dumps(QUESTION)}")
        t.keys("Enter")
        time.sleep(6)
        t.cap("ended-waiting")
        t.keys("S-Left")
        time.sleep(2)
        t.cap("ended-opened")
        t.keys("Down")
        t.keys("Enter")
        time.sleep(6)
        t.cap("ended-answered")
        t.keys("C-c")
        time.sleep(0.5)
        t.keys("C-c")
        time.sleep(2)
    finally:
        t.close()
        stub.terminate()
    for row in summarize(base, dump):
        print(row)
    for path in glob.glob(os.path.join(home.codex, "sessions", "**", "*.jsonl"), recursive=True):
        out = os.path.join(base, "rollout." + os.path.basename(path))
        with open(path) as src, open(out, "w") as dst:
            dst.write(src.read())
        print("rollout:", out)


if __name__ == "__main__":
    main()
