"""OpenCode resume and warm-up, on the session a turns.py run left behind.

    python3 scripts/verify-cli/opencode/resume.py <label> <bin> <port> [run]

`run` is the turns.py run whose home to reuse (default `pfull`). Opens the
session the plugin recorded with `--session`, then `--continue`, each in the
full TUI and `mini`, and prints whether the history came back or a session
picker opened instead (a picker hangs a restore). Last, the warm-up's
one-shot `opencode run` must exit on its own.
"""
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import oc  # noqa: E402
from oc import common  # noqa: E402

label, binp, port = sys.argv[1], common.binary(sys.argv[2]), int(sys.argv[3])
run = sys.argv[4] if len(sys.argv) > 4 else "pfull"
home = common.out_dir("opencode", label, f"h-{run}")
work = os.path.join(home, "work")
rec = os.path.join(home, "live_sessions", oc.UID)
if not os.path.exists(rec):
    sys.exit(f"no session recorded in {rec}: run turns.py for {label} first (run {run})")
sid = open(rec).read().strip()
env, _ = oc.home_env(home, oc.stub_config(port))
log = os.path.join(common.out_dir("opencode", label, run), "stub.jsonl")
stub = common.start_stub("stub_openai.py", port, log)
out = common.out_dir("opencode", label, f"resume-{run}")
try:
    for tag, args in (("session", ["--session", sid, "--standalone"]),
                      ("cont", ["--continue", "--standalone"]),
                      ("minises", ["mini", "--session", sid, "--standalone"]),
                      ("minicont", ["mini", "--continue", "--standalone", "--model", "ollama/stub"])):
        t = common.Tui(out, [binp, *args], work, env)
        time.sleep(7)
        t.cap(f"resume_{tag}")
        p = t.plain()
        print(label, tag, "history shown:", "STUB:CALL" in p or "stub answer done" in p,
              "| picker?", "Select session" in p)
        t.close()
        time.sleep(0.7)
    e = common.clean_environ(env)
    t0 = time.time()
    p = subprocess.run([binp, "run", "hello", "--standalone"], cwd=work, env=e, capture_output=True, text=True,
                       timeout=60, stdin=subprocess.DEVNULL)
    print(label, "warm-up run exit", p.returncode, round(time.time() - t0, 1), repr(p.stdout[-60:]),
          repr(p.stderr[-120:]))
finally:
    stub.terminate()
