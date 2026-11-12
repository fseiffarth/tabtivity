"""Claude: Send now by Esc against Claude's own `chat:sendNow` (Ctrl+X Ctrl+S).

    python3 scripts/verify-cli/claude/send_now.py <label> <claude-bin> <case> <key>

<case> is the turn state the key lands on:
  early   the first prompt's turn held unanswered by a sleeping
          `UserPromptSubmit` hook, a second prompt queued behind it (Enter)
  tool    the first turn running `sleep 20` through Bash, a second prompt
          queued behind it (Enter), as the Chat sends while a turn works
  typed   the same running turn, the second prompt typed into the box
          without Enter
  stream  the first turn writing a long answer (no tool), a second prompt
          queued behind it (Enter)
<key> is `esc` (Send now before 2.1.322), `chord` (Ctrl+X Ctrl+S as two
`send-keys` calls) or `chord1` (both in one call, one write, as the app
sends them).

Frames go to tmp/verify-cli/claude/<label>/send-now-<case>-<key>/, with
`records.txt`: the transcript's prompt records and the parent each hangs
from (a prompt Claude took back hangs from the same parent as the one after
it). The summary prints when the second prompt was recorded, against the
moment the key went in, and whether it ended up back in the box.

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

FIRST_EARLY = "send-now probe first prompt: reply with the single word one"
FIRST_TOOL = ("send-now probe first prompt: run the Bash command `sleep 20` (no other tool), "
              "then reply with the single word one")
FIRST_STREAM = ("send-now probe first prompt: without using any tool, write the numbers from 1 to 3000 "
                "as digits, one per line")
SECOND = "send-now probe second prompt: reply with the single word two"
# Each inner list is one `send-keys` call.
KEYS = {"esc": [["Escape"]], "chord": [["C-x"], ["C-s"]], "chord1": [["C-x", "C-s"]]}


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


def box_holds(screen, text):
    """Whether the input box (the rows between the last two rules) holds `text`."""
    lines = screen.splitlines()
    rules = [i for i, line in enumerate(lines) if line.strip().startswith("─") and len(line.strip()) > 20]
    if len(rules) < 2:
        return False
    return text[:30] in "\n".join(lines[rules[-2]:rules[-1]])


def main():
    if len(sys.argv) != 5 or sys.argv[3] not in ("early", "tool", "typed", "stream") or sys.argv[4] not in KEYS:
        sys.exit(__doc__)
    label, binary, case, key = sys.argv[1], common.binary(sys.argv[2]), sys.argv[3], sys.argv[4]
    out = common.out_dir("claude", label, f"send-now-{case}-{key}")
    work = os.path.join(out, "work-" + uuid.uuid4().hex[:8])
    os.makedirs(work, exist_ok=True)
    settings = os.path.join(out, "settings.json")
    hooks = {}
    if case == "early":
        hook = os.path.join(work, "hold.sh")
        with open(hook, "w") as f:
            f.write("#!/bin/sh\ncat >/dev/null\ngrep -q first \"$0.flag\" 2>/dev/null || "
                    "{ echo first > \"$0.flag\"; sleep 12; }\n")
        os.chmod(hook, 0o755)
        hooks = {"UserPromptSubmit": [{"hooks": [{"type": "command", "command": hook}]}]}
    common.write_json(settings, {"hooks": hooks})
    session = str(uuid.uuid4())
    env = {k: os.environ[k] for k in ("HOME", "PATH", "USER", "LANG") if k in os.environ}
    env.update({"TERM": "xterm-256color", "COLORTERM": "truecolor"})
    argv = [binary, "--settings", settings, "--model", "haiku", "--session-id", session,
            "--allowedTools", "Bash(sleep:*)"]
    t = common.Tui(out, argv, work, env, size=(100, 34))
    log = []
    try:
        for _ in range(40):
            screen = t.plain()
            if "trust" in screen.lower() and "folder" in screen.lower():
                t.keys("Enter")
            if "❯" in screen and "─" in screen and "trust" not in screen.lower():
                break
            time.sleep(0.5)
        t.cap("ready")
        t.type({"early": FIRST_EARLY, "stream": FIRST_STREAM}.get(case, FIRST_TOOL))
        t.keys("Enter")
        if case == "early":
            time.sleep(2.0)
        elif case == "stream":
            time.sleep(3.0)
        else:
            ran = t.wait("sleep 20", 40)
            log.append(f"tool shown: {ran}")
            time.sleep(2.0)
        t.cap("busy")
        t.type(SECOND)
        if case != "typed":
            t.keys("Enter")
        time.sleep(1.0)
        t.cap("before-key")
        log.append(f"queue hint before key: {'queued messages' in t.plain()}")
        log.append(f"key at {time.strftime('%H:%M:%S', time.gmtime())}Z")
        for call in KEYS[key]:
            t.send_keys(*call)
            time.sleep(0.1)
        for i, wait in enumerate((0.5, 1.5, 3.0)):
            time.sleep(wait)
            t.cap(f"after-{i}")
        screen = t.plain()
        log.append(f"second prompt in the box 5 s after key: {box_holds(screen, SECOND)}")
        log.append(f"queue hint 5 s after key: {'queued messages' in screen}")
        time.sleep(25)
        t.cap("settled")
        log.append(f"second prompt in the box at the end: {box_holds(t.plain(), SECOND)}")
    finally:
        t.close()
    slug = "".join(c if c.isalnum() else "-" for c in os.path.realpath(work))
    path = os.path.join(os.environ["HOME"], ".claude", "projects", slug, f"{session}.jsonl")
    rows = records(path) if os.path.exists(path) else [f"no transcript at {path}"]
    with open(os.path.join(out, "records.txt"), "w") as f:
        f.write("\n".join(rows) + "\n")
    print(out)
    print("\n".join(log))
    print("\n".join(r for r in rows if " user " in r or " assistant " in r or "queued" in r or "no transcript" in r))


if __name__ == "__main__":
    main()
