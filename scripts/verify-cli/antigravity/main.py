"""Antigravity's TUI end to end, offline against the stub.

    python3 scripts/verify-cli/antigravity/main.py <label> <bin> <port> [cols]
    → tmp/verify-cli/antigravity/<label>/main[<cols>]/*.esc

First run (theme, terms, trust), the `/model` picker and its gauge, `/effort`,
three turns (frames mid-turn and after), then — on the same home — a second
`--continue` beside the first (the "Conversation already open" notice), and
fresh launches with `--continue`, `--conversation <id>` and `--model/--effort`
flags, each asked whether the history came back. Last, `agy models`.
With `cols` (e.g. 42) only the first run and picker run, at that width.
"""
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from agy import Agy, common  # noqa: E402

label, binp, port = sys.argv[1], common.binary(sys.argv[2]), int(sys.argv[3])
cols = int(sys.argv[4]) if len(sys.argv) > 4 else None
name = f"main{cols}" if cols else "main"
r = Agy(label, name, port, binp, size=(cols or 80, 24))
try:
    r.first_run()
    r.wait("? for shortcuts")
    time.sleep(2.5)
    r.cap("idle")
    r.type("/model")
    time.sleep(0.6)
    r.cap("slash")
    r.keys("Enter")
    r.wait("Switch Model", 6)
    time.sleep(1)
    r.cap("model_open")
    r.keys("Right")
    time.sleep(0.5)
    r.cap("model_gauge_right")
    if cols:
        r.keys("Enter")
        time.sleep(2)
        r.cap("model_applied")
        sys.exit(0)
    r.keys("Down")
    time.sleep(0.5)
    r.cap("model_down")
    r.keys("Down")
    time.sleep(0.5)
    r.cap("model_down2")
    r.keys("Right")
    time.sleep(0.5)
    r.cap("model_down2_right")
    r.keys("Enter")
    time.sleep(2)
    r.cap("model_applied")
    r.type("/effort")
    r.keys("Enter")
    time.sleep(1.2)
    r.cap("effort")
    r.keys("Escape")
    time.sleep(0.8)
    for i in range(3):
        r.type(f"probe turn {i}")
        r.keys("Enter")
        r.cap(f"mid{i}")
        r.wait("stub answer done", 12)
        time.sleep(1.5)
    r.cap("after_turns")
    print(label, "history rows", r.history())
    r2 = Agy(label, "second", port + 50, binp, args=["--continue"], home=r.home, prov=False)
    time.sleep(5)
    r2.cap("second_continue")
    print(label, "second --continue shows the already-open notice:", "Conversation already open" in r2.plain())
    r2.close()
finally:
    r.close()
time.sleep(1)
db = os.path.join(r.home, ".gemini", "antigravity-cli")
conv = os.path.join(db, "conversations")
print(label, "store", sorted(os.listdir(db)), sorted(os.listdir(conv)) if os.path.isdir(conv) else None)
ids = [f[:-3] for f in os.listdir(conv) if f.endswith(".db")] if os.path.isdir(conv) else []
launches = [("cont", ["--continue"]), ("flags", ["--model", "gemini-3.1-pro-high", "--effort", "high"])]
if ids:
    launches.insert(1, ("conv", ["--conversation", ids[0]]))
for tag, a in launches:
    x = Agy(label, "r" + tag, port + 60, binp, args=a, home=r.home)
    time.sleep(5)
    x.cap("frame")
    p = x.plain()
    print(label, tag, "history", "probe turn" in p, "|", [ln.strip() for ln in p.splitlines() if "for shortcuts" in ln])
    x.close()
    time.sleep(0.5)
stub = common.start_stub("stub_gemini.py", port + 60, os.path.join(r.out, "models-stub.jsonl"))
m = subprocess.run([binp, "models"], cwd=r.work, env=common.clean_environ({**r.env}), capture_output=True,
                   text=True, timeout=30, stdin=subprocess.DEVNULL)
stub.terminate()
with open(os.path.join(r.out, "models.txt"), "w") as f:
    f.write(m.stdout + m.stderr)
print(label, "models exit", m.returncode)
