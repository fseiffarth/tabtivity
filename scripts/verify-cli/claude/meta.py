"""Transcripts and permission modes of claude/hooks.sh runs.

    python3 scripts/verify-cli/claude/meta.py <label> [<label> ...]

Per run: the record types in each session's transcript under
~/.claude/projects, whether the project folder name is still encoded the way
the app expects, and each hook payload's (event, source, permission_mode,
session id ours?).
"""
import collections
import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import common  # noqa: E402

projects = os.path.expanduser("~/.claude/projects")
for label in sys.argv[1:]:
    v = os.path.join(common.OUT, "claude", label, "hooks")
    print("==", label)
    ids = {n: open(f"{v}/id.{n}").read().strip() for n in ("default", "plan")}
    for name, sid in ids.items():
        p = glob.glob(f"{projects}/*/{sid}.jsonl")
        if not p:
            print(name, "NO TRANSCRIPT for", sid)
            continue
        recs = [json.loads(line) for line in open(p[0])]
        print(name, len(recs), sorted(collections.Counter(r.get("type") for r in recs).items(), key=str))
        print("  folder", "encoded ok" if p[0].split("/")[-2].endswith("-work") else p[0])
    for f in sorted(glob.glob(f"{v}/dump/*.json")):
        d = json.load(open(f))
        print("  ", (d.get("hook_event_name"), d.get("source") or d.get("reason") or "",
                     d.get("permission_mode"), d.get("session_id") in ids.values()))
