"""Claude's TUI held at a permission prompt, captured at four widths.

    python3 scripts/verify-cli/claude/prompt.py <label> <claude-bin>
    → tmp/verify-cli/claude/<label>/prompt/{*.esc,dump/*.json}

Real HOME (needs the login), `--model haiku`, one small paid turn. Frames:
the prompt at 120 cols (just shown, then 9 s later), at 60 and 42 cols, after
Escape, the `/model` slash menu, and the exit. Replay them with
parsers/frames.probe.ts; the hook payloads feed claude/sedcheck.py.
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import common  # noqa: E402

label, binp = sys.argv[1], sys.argv[2]
out = common.out_dir("claude", label, "prompt")
os.makedirs(f"{out}/dump", exist_ok=True)
work = common.out_dir("claude", label, "prompt", "work")
hook = f"{out}/hook.sh"
with open(hook, "w") as f:
    f.write(f'#!/bin/sh\nf="{out}/dump/$(date +%s%N).json"; cat > "$f"\n')
os.chmod(hook, 0o755)
events = ["SessionStart", "Stop", "UserPromptSubmit", "PostToolUse", "Notification", "SessionEnd"]
common.write_json(f"{out}/settings.json",
                  {"hooks": {e: [{"hooks": [{"type": "command", "command": hook}]}] for e in events}})
argv = [binp, "--name", "probe-tui", "--settings", f"{out}/settings.json", "--permission-mode", "default",
        "--model", "haiku", 'Run exactly this Bash command and nothing else: python3 -c "print(1)"']
t = common.Tui(out, argv, work, size=(120, 40))
try:
    t0 = time.time()
    seen = trusted = False
    while time.time() - t0 < 90:
        p = t.plain()
        if "Do you want to proceed" in p:
            seen = True
            break
        if not trusted and "trust" in p.lower() and "Yes" in p:
            t.cap("trust")
            t.keys("Enter")
            trusted = True
        time.sleep(0.5)
    print(label, "prompt seen", seen, round(time.time() - t0, 1))
    t.cap("prompt_0")
    time.sleep(9)
    t.cap("prompt_9")
    t.size(60, 30)
    t.cap("prompt")
    t.size(42, 24)
    t.cap("prompt")
    t.size(120, 40)
    t.keys("Escape")
    time.sleep(3)
    t.cap("afteresc")
    t.type("/model")
    time.sleep(1)
    t.cap("slash")
    t.keys("C-u", "C-c")
    time.sleep(0.5)
    t.keys("C-c")
    time.sleep(2)
    t.cap("exit")
finally:
    t.close()
print(out, len(os.listdir(f"{out}/dump")), "hook payloads")
