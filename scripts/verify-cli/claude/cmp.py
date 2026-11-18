"""Compare two claude/hooks.sh runs: event counts and each event's key set.

    python3 scripts/verify-cli/claude/cmp.py <old-label> <new-label>

`<<<` marks an event whose count differs; DIFF lines name keys added or gone.
A new key is usually harmless; a gone or renamed one breaks the hook.
"""
import collections
import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import common  # noqa: E402


def load(label):
    d = os.path.join(common.OUT, "claude", label, "hooks", "dump")
    return [json.load(open(f)) for f in sorted(glob.glob(f"{d}/*.json"))]


def sig(d):
    return (d.get("hook_event_name"), d.get("source") or d.get("reason") or "", tuple(sorted(d.keys())))


a, b = load(sys.argv[1]), load(sys.argv[2])
ca, cb = collections.Counter(sig(d) for d in a), collections.Counter(sig(d) for d in b)
print("events", len(a), len(b))
for k in sorted(set(ca) | set(cb), key=str):
    flag = "" if ca[k] == cb[k] else " <<<"
    print(k[0], k[1], ca[k], cb[k], flag)
    if flag:
        print("   keys", k[2])
for e in sorted({k[0] for k in cb} | {k[0] for k in ca}, key=str):
    ka = set().union(*[set(d) for d in a if d.get("hook_event_name") == e] or [set()])
    kb = set().union(*[set(d) for d in b if d.get("hook_event_name") == e] or [set()])
    if ka != kb:
        print("DIFF", e, "added", sorted(kb - ka), "gone", sorted(ka - kb))
