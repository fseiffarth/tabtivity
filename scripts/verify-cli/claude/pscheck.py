"""The Windows session hook's regex field reads against a real JSON parse.

    python3 scripts/verify-cli/claude/pscheck.py <label> [<label> ...]

On Windows the app registers the PowerShell twin of the session hook
(`powershell_hook_script_body` in services/agent/agent_session.rs), which
reads each payload field with `[regex]::Match` instead of sed. This lifts
those patterns straight out of the source, runs each on every payload
claude/hooks.sh dumped, and reports where its answer differs from the
field's real value. `transcript_path` is compared after the hook's own
`\\\\` → `\\` unescape. The sed twin is claude/sedcheck.py; on Windows its
`transcript_path` reads differ by design (JSON-escaped backslashes).
"""
import glob
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import common  # noqa: E402

SRC = os.path.join(common.ROOT, "src-tauri", "src", "services", "agent", "agent_session.rs")
MATCH = re.compile(r"\$m\w? = \[regex\]::Match\(\$payload, '(.*?)'\)")
BS = "\\"
# Read only on a Codex async question or a background task: not top-level here.
SKIP = {"tool_use_id", "backgroundTaskId"}


def unrust(s):
    # The script is a Rust format! string: undo its escapes.
    return s.replace(BS + BS, "\x00").replace(BS + '"', '"').replace("\x00", BS)


def patterns():
    src = open(SRC, encoding="utf-8").read()
    body = src[src.index("fn powershell_hook_script_body"):]
    body = body[:body.index("\nfn ", 10)]
    out = {}
    for raw in MATCH.findall(body):
        p = unrust(raw)
        key = re.search(r'"(\w+)"', p).group(1)
        if key not in SKIP:
            out.setdefault(key, re.compile(p))
    return out


def expected(d, key):
    v = d.get(key)
    if isinstance(v, bool):
        return "true" if v else "false"
    return None if v is None else str(v)


pats = patterns()
print(f"{len(pats)} regex reads from {os.path.relpath(SRC, common.ROOT)}: {', '.join(sorted(pats))}")
bad_total = 0
for label in sys.argv[1:]:
    files = sorted(glob.glob(os.path.join(common.OUT, "claude", label, "hooks", "dump", "*.json")))
    bad = 0
    for f in files:
        text = open(f, encoding="utf-8").read()
        d = json.loads(text)
        for key, p in pats.items():
            m = p.search(text)
            got = m.group(1) if m else None
            if key == "transcript_path" and got:
                got = got.replace(BS + BS, BS)
            want = expected(d, key)
            if got != want:
                bad += 1
                print(f"MISMATCH {label} {os.path.basename(f)} {key}: regex=[{str(got)[:80]}] json=[{str(want)[:80]}]")
    print(f"{label}: payloads={len(files)} mismatches={bad}")
    bad_total += bad
sys.exit(1 if bad_total else 0)
