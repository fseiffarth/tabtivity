"""OpenCode tool turns forced through the stub model, in a tab-like home.

    python3 scripts/verify-cli/opencode/turns.py <label> <bin> <port> full|mini [ask|allow|deny]
    → tmp/verify-cli/opencode/<label>/<run>/{*.esc,stub.jsonl}

`full` is the plain `opencode` TUI, `mini` is `opencode mini`. Without a
permission argument it runs the whole tool set (bash alias, shell, write,
edit, failing edit/read, subagent, question form, model palette); with one,
only shell/edit/write under `"permission": {shell, edit: <arg>}`. Each turn
prints the tool result the stub got back and whether a permission chip
showed; permission chips are captured at 200/100/60/50 columns. The session
plugin records into <home>/live_sessions, as in a tab — resume.py reads it.
Get <bin> without installing: `npm pack @opencode/cli-linux-x64@<v>`, unpack,
`package/bin/opencode`.
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import oc  # noqa: E402
from oc import common  # noqa: E402

label, binp, port, mode = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
perm = sys.argv[5] if len(sys.argv) > 5 else None
run = f"{perm or 'p'}{mode}"
out = common.out_dir("opencode", label, run)
home = common.out_dir("opencode", label, f"h-{run}")
work = common.out_dir("opencode", label, f"h-{run}", "work")
cfg = oc.stub_config(port, **({"permission": {"shell": perm, "edit": perm}} if perm else {}))
env, live = oc.home_env(home, cfg)
log = os.path.join(out, "stub.jsonl")
stub = common.start_stub("stub_openai.py", port, log)
args = ["--standalone"] if mode == "full" else ["mini", "--model", "ollama/stub", "--standalone"]
t = common.Tui(out, [binp, *args], work, env)


def calls():
    return [x for x in oc.reqs(log) if "tools" in x]


def turn(tag, tool, a, widths=False):
    n0 = len(calls())
    t.type(f"STUB:CALL {tool} {json.dumps(a)}")
    t.keys("Enter")
    t0 = time.time()
    seen = False
    while time.time() - t0 < 25:
        if "Allow once" in t.plain():
            if not seen:
                seen = True
                time.sleep(0.6)
                t.cap(f"perm_{tag}")
                if widths:
                    for w, h in ((200, 50), (100, 30), (60, 30), (50, 30)):
                        t.size(w, h)
                        t.cap(f"perm_{tag}")
                    t.size(120, 40)
            t.keys("Enter")
            time.sleep(0.8)
            continue
        q = calls()[n0:]
        if len(q) >= 2 and q[-1].get("tool_results"):
            break
        time.sleep(0.3)
    time.sleep(1.5)
    t.cap(f"after_{tag}")
    # The call that carried the tool's result, not simply the last call: from
    # 2.3.0 a subagent answers at once and its report comes back as a later
    # turn of its own, with no tool result in it.
    q = [x for x in calls()[n0:] if x.get("tool_results")]
    res = q[-1]["tool_results"] if q else None
    print(label, run, tag, "perm" if seen else "noperm", "->", json.dumps(res)[:330])


try:
    print(label, run, "ready", t.wait("stub", 30))
    time.sleep(3)
    t.cap("start")
    turn("alias", "bash", {"command": "touch alias.txt", "description": "alias probe"}, widths=True)
    turn("shell", "shell", {"command": "touch shell.txt", "description": "shell probe"})
    turn("write", "write", {"path": "w.txt", "content": "one\ntwo\n"})
    if not perm:
        turn("edit", "edit", {"path": "w.txt", "oldString": "one", "newString": "three"})
        turn("editmiss", "edit", {"path": "w.txt", "oldString": "tree\ntwo", "newString": "x"})
        turn("readmiss", "read", {"path": "nofolder/sub/x.txt"})
        turn("sub", "subagent", {"description": "child", "prompt": "say hi", "agent": "general"})
        q = {"questions": [{"question": "Pick one?", "header": "Pick", "options": [
            {"label": "Alpha", "description": "first"}, {"label": "Beta", "description": "second"}]}]}
        t.type("STUB:CALL question " + json.dumps(q))
        t.keys("Enter")
        time.sleep(4)
        t.cap("question")
        for w, h in ((60, 30), (50, 30)):
            t.size(w, h)
            t.cap("question")
        t.size(120, 40)
        t.keys("Escape", pause=2)
        t.keys("Escape", pause=2)
        t.keys("C-p", pause=1.5)
        t.cap("palette")
        t.type("model")
        time.sleep(0.8)
        t.cap("palette_filter")
        t.keys("Enter", pause=2)
        t.cap("picker")
        t.keys("Escape", pause=1)
        t.keys("Escape")
    print(label, run, "files", sorted(os.listdir(work)))
    rec = os.path.join(live, oc.UID)
    print(label, run, "live record", open(rec).read().strip() if os.path.exists(rec) else None)
finally:
    t.close()
    stub.terminate()
