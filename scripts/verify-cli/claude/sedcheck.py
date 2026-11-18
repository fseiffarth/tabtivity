"""The session hook's own `sed` field extraction against a real JSON parse.

    python3 scripts/verify-cli/claude/sedcheck.py <label> [<label> ...]

The hook script is POSIX sh, so it reads each payload field with a `sed -n`
expression instead of a JSON parser. This lifts those expressions straight
out of services/agent/agent_session.rs (no copy to go stale), runs each on
every payload claude/hooks.sh and claude/prompt.py dumped, and reports where
sed's answer differs from the field's real value — a field that moved,
changed type, or now also appears nested further down the payload.
"""
import glob
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import common  # noqa: E402

SRC = os.path.join(common.ROOT, "src-tauri", "src", "services", "agent", "agent_session.rs")
LINE = re.compile(r"""(\w+)=\$\(printf '%s' \\"\$input\\" \| sed -n '(.*?)'\)""")


def unrust(s):
    # The script is a Rust format! string: undo its escapes.
    return s.replace('\\\\', '\x00').replace('\\"', '"').replace('\x00', '\\').replace('}}', '}').replace('{{', '{')


def exprs():
    out = []
    for var, raw in LINE.findall(open(SRC).read()):
        e = unrust(raw)
        m = re.search(r'"(\w+)"', e)
        if not m or "\\(" not in e:
            continue  # a literal match (`null/p`), not a field read
        quoted = '"\\(' in e  # capture sits inside the quotes: a string field
        out.append((var, m.group(1), e, quoted))
    return out


def expected(d, key, quoted):
    if key not in d or d[key] is None:
        return "" if quoted else ("null" if key in d else "")
    v = d[key]
    if isinstance(v, bool):
        return "true" if v else "false"
    if quoted or not isinstance(v, str):
        return str(v)
    return json.dumps(v)


checks = exprs()
print(f"{len(checks)} extractions read from {os.path.relpath(SRC, common.ROOT)}")
bad_total = 0
for label in sys.argv[1:]:
    base = os.path.join(common.OUT, "claude", label)
    files = sorted(glob.glob(f"{base}/hooks/dump/*.json") + glob.glob(f"{base}/prompt/dump/*.json"))
    bad = 0
    for f in files:
        text = open(f).read()
        d = json.loads(text)
        for var, key, e, quoted in checks:
            got = subprocess.run(["sed", "-n", e], input=text, capture_output=True, text=True).stdout.rstrip("\n")
            want = expected(d, key, quoted)
            if got != want:
                bad += 1
                print(f"MISMATCH {label} {os.path.basename(f)} {var} ({key}): sed=[{got[:80]}] json=[{want[:80]}]")
    print(f"{label}: payloads={len(files)} mismatches={bad}")
    bad_total += bad
sys.exit(1 if bad_total else 0)
