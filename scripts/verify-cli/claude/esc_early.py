"""Claude: what an Esc does to a turn that has not answered yet.

    python3 scripts/verify-cli/claude/esc_early.py <label> <claude-bin> [queued|alone|pull]

A `UserPromptSubmit` hook that sleeps holds the first prompt's turn busy with
nothing written back, the moment a Chat bubble's Send now (Esc) or an Esc in
the composer lands on. `queued` (the default) types a second prompt behind it
first, as the Chat does while a turn runs; `alone` presses Esc with no queue;
`pull` presses ↑ on the queue hint instead (Cancel and edit). Frames go to
tmp/verify-cli/claude/<label>/esc-<mode>/, with `records.txt`: the
transcript's prompt records and the parent each hangs from. A prompt Claude
took back hangs from the same parent as the one after it (a dead branch).

Uses the real login (`--model haiku`, one or two small paid turns), the tab
variables unset.
"""
import json
import os
import sys
import time
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import common  # noqa: E402

FIRST = "esc probe first prompt: reply with the single word one"
SECOND = "esc probe second prompt: reply with the single word two"


def records(path):
    rows = []
    for line in open(path, encoding="utf-8"):
        try:
            v = json.loads(line)
        except ValueError:
            continue
        kind = v.get("type")
        if kind not in ("user", "assistant", "attachment", "system"):
            continue
        content = (v.get("message") or {}).get("content")
        text = content if isinstance(content, str) else " | ".join(
            str(b.get("text") or b.get("type")) for b in content or [] if isinstance(b, dict))
        sub = (v.get("attachment") or {}).get("type") or v.get("subtype") or ""
        rows.append(f"{v.get('timestamp', '')} {kind} {sub} uuid={str(v.get('uuid'))[:8]} "
                    f"parent={str(v.get('parentUuid'))[:8]} {text[:90]!r}")
    return rows


def main():
    if len(sys.argv) not in (3, 4):
        sys.exit(__doc__)
    label, binary = sys.argv[1], common.binary(sys.argv[2])
    mode = sys.argv[3] if len(sys.argv) == 4 else "queued"
    out = common.out_dir("claude", label, f"esc-{mode}")
    work = os.path.join(out, "work")
    os.makedirs(work, exist_ok=True)
    hook = os.path.join(out, "hold.sh")
    with open(hook, "w") as f:
        f.write("#!/bin/sh\ncat >/dev/null\ngrep -q first \"$0.flag\" 2>/dev/null || { echo first > \"$0.flag\"; sleep 12; }\n")
    os.chmod(hook, 0o755)
    if os.path.exists(hook + ".flag"):
        os.remove(hook + ".flag")
    settings = os.path.join(out, "settings.json")
    common.write_json(settings, {"hooks": {"UserPromptSubmit": [{"hooks": [{"type": "command", "command": hook}]}]}})
    session = str(uuid.uuid4())
    env = {k: os.environ[k] for k in ("HOME", "PATH", "USER", "LANG") if k in os.environ}
    env.update({"TERM": "xterm-256color", "COLORTERM": "truecolor"})
    t = common.Tui(out, [binary, "--settings", settings, "--model", "haiku", "--session-id", session],
                   work, env, size=(100, 34))
    try:
        for _ in range(40):
            screen = t.plain()
            if "trust" in screen.lower() and "folder" in screen.lower():
                t.keys("Enter")
            if "❯" in screen and "─" in screen and "trust" not in screen.lower():
                break
            time.sleep(0.5)
        t.cap("ready")
        t.type(FIRST)
        t.keys("Enter")
        time.sleep(2.0)
        t.cap("busy")
        if mode != "alone":
            t.type(SECOND)
            t.keys("Enter")
            time.sleep(1.0)
            t.cap("queued")
        t.keys("Up" if mode == "pull" else "Escape")
        time.sleep(1.5)
        t.cap("after-key")
        time.sleep(16)
        t.cap("settled")
    finally:
        t.close()
    slug = "".join(c if c.isalnum() else "-" for c in os.path.realpath(work))
    path = os.path.join(os.environ["HOME"], ".claude", "projects", slug, f"{session}.jsonl")
    rows = records(path) if os.path.exists(path) else [f"no transcript at {path}"]
    with open(os.path.join(out, "records.txt"), "w") as f:
        f.write("\n".join(rows) + "\n")
    print(out)
    print("\n".join(r for r in rows if " user " in r or " assistant " in r or "queued" in r))


if __name__ == "__main__":
    main()
