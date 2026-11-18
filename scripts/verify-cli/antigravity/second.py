"""Two Antigravity windows on one conversation: the second must warn.

    python3 scripts/verify-cli/antigravity/second.py <label> <bin> <port>

Reuses main.py's home (run it first). Starts `--continue` twice; prints
whether the second shows the "Conversation already open" notice and the
history, and the warning lines themselves.
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from agy import Agy, common  # noqa: E402

label, binp, port = sys.argv[1], sys.argv[2], int(sys.argv[3])
home = os.path.join(common.OUT, "antigravity", label, "h-main")
if not os.path.isdir(home):
    sys.exit(f"{home} missing: run antigravity/main.py {label} … first")
a = Agy(label, "sec1", port, binp, args=["--continue"], home=home)
time.sleep(5)
b = Agy(label, "sec2", port + 1, binp, args=["--continue"], home=home)
time.sleep(5)
b.cap("frame")
p = b.plain()
print(label, "notice", "Conversation already open" in p, "history", "probe turn" in p)
print([ln.strip()[:76] for ln in p.splitlines() if "already open" in ln or "⚠" in ln])
b.close()
a.close()
