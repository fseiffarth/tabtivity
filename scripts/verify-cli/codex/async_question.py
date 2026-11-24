"""Codex: an async question (`request_user_input_async`) — what the screen,
the rollout and the hooks show while it waits and once it is answered.

    python3 scripts/verify-cli/codex/async_question.py <label> <bin> <port> [model]
    python3 scripts/verify-cli/codex/async_question.py <label> <bin> <port> [model] long [case...]

Offline, as `turn_hooks.py`: a private `CODEX_HOME`, the stub provider, every
hook a dumper (`--dangerously-bypass-hook-trust`). `model` (default
`gpt-6.1-sol`) is the model name Codex is told it talks to: the tool set it
offers follows the model's family, and `stub` may not get the async tool.
The stub calls the tool, then `clock.sleep`, which keeps the turn working
while the question waits; the probe opens the question (shift+←), captures
it and answers the first option; then one skipped (^]), and one left waiting\nas the turn ends, answered after.
Output: tmp/verify-cli/codex/<label>/async_question/.

`long` is the variant for choices taller than the picker's area (0.172.0:
PageUp/PageDown page through them): one question per case at a short terminal
(`many` 12 options at 80x12, `tall` multi-line options at 60x16; default both),
cut down to the case's size, opened (shift+left), then answered three ways on a fresh Codex each: the app's
walk (Down per row, Enter: `selectKeys`), the row's digits, and after paging
PageDown/PageUp. It picks the last real option, which starts off-screen. Frames
land in `async_question_long/<case>-<way>-<step>@CxR.esc`, what Codex got back
in `answers.txt`.
"""
import glob
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import common  # noqa: E402
from turn_hooks import CURRENT, EXTRA, Home, offered, settle, summarize  # noqa: E402

QUESTION = {"questions": [{"title": "Which window shows the bug?", "options": ["Main window", "Popped-out window", "Phone"]}]}


def long_question(case):
    if case == "many":
        return (80, 12), {"questions": [{"title": "Which of the twelve builds broke?",
                                         "options": [f"Build {n:02d}" for n in range(1, 13)]}]}
    options = [f"Plan {c}: first, second, third\n"
               + "\n".join(f"  line {n} of plan {c}, long enough to wrap in a narrow pane" for n in range(1, 4))
               for c in "ABCDE"]
    return (60, 16), {"questions": [{"title": "Which of these plans should the agent follow?", "options": options}]}


def long_main(label, binp, port, model, cases):
    """Per case and per way of answering (`arrows`, `digit`, `paged`), a fresh
    Codex: ask, open, page, answer the last real option, which starts off-screen."""
    base = common.out_dir("codex", label, "async_question_long")
    log = os.path.join(base, "stub.jsonl")
    if os.path.exists(log):
        os.remove(log)
    stub = common.start_stub("stub_openai.py", port, log)
    answers = []
    try:
        for case in cases:
            size, question = long_question(case)
            n = len(question["questions"][0]["options"])
            for how in ("arrows", "digit", "paged"):
                home = Home(base, port)
                dump = os.path.join(base, "dump")
                home.write(dump, CURRENT + EXTRA + ["PermissionRequest"], [])
                with open(home.config) as f:
                    cfg = f.read().replace('model = "stub"', f'model = "{model}"', 1)
                with open(home.config, "w") as f:
                    f.write(cfg)
                argv = [binp, "--no-daemon", "--dangerously-bypass-hook-trust"]
                t = common.Tui(base, argv, home.work, home.env(), size=(110, 36))
                tag = f"{case}-{how}"
                try:
                    settle(t)
                    t.type("hello")
                    t.keys("Enter")
                    name = None
                    for _ in range(20):
                        time.sleep(1)
                        name = next((x for x in sorted(offered(log)) if x.endswith("request_user_input_async")), None)
                        if name:
                            break
                    t.wait("stub answer done", 20)
                    time.sleep(1)
                    if not name:
                        t.cap(f"{tag}-no-tool")
                        answers.append(f"{tag}: request_user_input_async not offered to {model}")
                        continue
                    t.type(f"STUB:SEQ {name} {json.dumps(question)} ;; clock.sleep {json.dumps({'duration_ms': 40000})}")
                    t.keys("Enter")
                    for _ in range(3):
                        # A fast paste can leave the Enter as a newline: send it again.
                        if t.wait("Queued follow-up inputs", 8):
                            break
                        t.keys("Enter")
                    time.sleep(1)
                    t.cap(f"{tag}-waiting")
                    # The prompt is typed in a roomy window, then the pane is cut down.
                    t.size(*size)
                    t.cap(f"{tag}-waiting-small")
                    t.keys("S-Left")
                    time.sleep(2)
                    t.cap(f"{tag}-opened")
                    if how == "paged":
                        # One page down, one back up, then pages down until the
                        # footer says the last row (`Other`) is the highlight,
                        # and one row up: the last real option.
                        for i, key in enumerate(["PageDown", "PageUp"]):
                            t.keys(key)
                            time.sleep(1)
                            t.cap(f"{tag}-{i + 1}-{key.lower()}")
                        for i in range(2, 12):
                            if f"option {n + 1}/{n + 1}" in t.plain():
                                break
                            t.keys("PageDown")
                            time.sleep(1)
                            t.cap(f"{tag}-{i + 1}-pagedown")
                        t.keys("Up")
                        time.sleep(1)
                    elif how == "arrows":
                        # What the app sends (`selectKeys`): the walk, then Enter.
                        for _ in range(n - 1):
                            t.keys("Down", pause=0.1)
                    else:
                        t.keys(*str(n), pause=0.1)
                    time.sleep(1)
                    t.cap(f"{tag}-selected")
                    t.keys("Enter")
                    time.sleep(4)
                    t.cap(f"{tag}-answered")
                    time.sleep(2)
                    t.keys("C-c")
                    time.sleep(0.5)
                    t.keys("C-c")
                    time.sleep(2)
                finally:
                    t.close()
                reply = None
                for path in glob.glob(os.path.join(home.codex, "sessions", "**", "*.jsonl"), recursive=True):
                    with open(path) as src:
                        text = src.read()
                    with open(os.path.join(base, f"{tag}.rollout.jsonl"), "w") as dst:
                        dst.write(text)
                    for line in text.splitlines():
                        if "send_user_message_question_reply" in line and '"role":"user"' in line:
                            reply = line
                want = question["questions"][0]["options"][-1]
                got = None
                if reply:
                    m = re.search(r'"answer\\":\\"(.*?)\\",\\"question', reply)
                    got = m.group(1) if m else reply[:300]
                answers.append(f"{tag}: want {want!r}\n    got  {got}")
    finally:
        stub.terminate()
    with open(os.path.join(base, "answers.txt"), "w") as f:
        f.write("\n".join(answers) + "\n")
    print("\n".join(answers))


def main():
    if len(sys.argv) < 4:
        sys.exit(__doc__)
    if "long" in sys.argv[4:]:
        rest = sys.argv[4:]
        model = rest[0] if rest[0] != "long" else "gpt-6.1-sol"
        cases = rest[rest.index("long") + 1:] or ["many", "tall"]
        return long_main(sys.argv[1], common.binary(sys.argv[2]), int(sys.argv[3]), model, cases)
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
