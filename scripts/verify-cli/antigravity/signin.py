"""Antigravity's sign-in screens at one width, unconfigured (no stub, no key).

    python3 scripts/verify-cli/antigravity/signin.py <label> <bin> <cols> <rows>
    → tmp/verify-cli/antigravity/<label>/si<cols>/*.esc

Walks first run to the sign-in menu, picks the second entry, opens the link
page, then pages it down with Shift+Down (`link_paged`). The phone's sign-in
reader has to rebuild the whole URL from those frames; replay them with
parsers/frames.probe.ts. Run at 80x24 and 42x24 at least. No real sign-in
happens: the probe stops at the link.
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from agy import Agy  # noqa: E402

label, binp, w, h = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
r = Agy(label, f"si{w}", 0, binp, prov=False, size=(w, h))


def frame(tag):
    r.cap(tag)
    rows = [ln.rstrip() for ln in r.plain().splitlines() if ln.strip()]
    print(f"--- {label} {w} {tag}")
    print("\n".join(ln[:78] for ln in rows[-9:]))


try:
    r.first_run()
    time.sleep(3)
    frame("menu")
    r.keys("Down")
    time.sleep(0.5)
    frame("menu_down")
    r.keys("Enter")
    time.sleep(1.5)
    frame("sub")
    r.keys("Enter")
    time.sleep(3)
    frame("link")
    for _ in range(30):
        r.keys("S-Down", pause=0.12)
    time.sleep(0.5)
    frame("link_paged")
finally:
    r.close()
