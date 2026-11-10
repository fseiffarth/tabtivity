"""Claude's `/model` picker walked top to bottom, at 120x40 and 80x24.

    python3 scripts/verify-cli/claude/model.py <label> <claude-bin> [expand]
    → tmp/verify-cli/claude/<label>/model/*.esc   (expand: model-expand/)

Real HOME (the login is needed for the account's model list), no turn, so
nothing is paid. Only arrow keys and Escape reach the picker: a digit or
Enter commits a pick, and a pick rewrites the user's default model in
`~/.claude/settings.json`. Frames: the picker as opened, one per Down press
(30, wrapping), then the same at 80x24 (what a phone attach leaves).
`expand` instead walks to the `More models` row (2.1.321+: unnumbered,
`▸`), opens it with Enter only while the footer says `Enter to expand` (the
row is an expander, not a model; Right does nothing), and walks the opened
list. Back up
`~/.claude/settings.json` before it and compare after. Replay the frames
with parsers/frames.probe.ts; the phone's model sheet reads these rows
(`mobile-web/src/terminal/selectPrompt.ts`).
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import common  # noqa: E402

label, binp = sys.argv[1], sys.argv[2]
expand = sys.argv[3:] == ["expand"]
name = "model-expand" if expand else "model"
out = common.out_dir("claude", label, name)
work = common.out_dir("claude", label, name, "work")


def highlighted(t):
    """The highlighted row's text, or ''."""
    return next((ln for ln in t.plain().splitlines() if ln.lstrip().startswith("❯ ") and "/model" not in ln), "")


def open_more(t, tag):
    """Walk to `More models`, open it, and walk the opened list."""
    t.type("/model")
    t.keys("Enter")
    time.sleep(2)
    for _ in range(12):
        if "More models" in highlighted(t):
            break
        t.keys("Down", pause=0.6)
    t.cap(f"{tag}_on_more")
    # 2.1.322's footer on that row: `Enter to expand · Esc to cancel`. Any
    # other footer means the highlight is on a model: stop, never Enter.
    if "Enter to expand" not in t.plain():
        print("not on the expander row; nothing pressed", file=sys.stderr)
        return
    t.keys("Enter", pause=1.5)
    t.cap(f"{tag}_enter")
    for i in range(1, 16):
        t.keys("Down", pause=0.6)
        t.cap(f"{tag}_{i:02d}")
    t.keys("Escape")
    time.sleep(1.5)
    t.cap(f"{tag}_esc")


def walk(t, tag, most=30):
    """Open `/model`, capture it, press Down until the screen stops changing."""
    t.type("/model")
    t.keys("Enter")
    time.sleep(2)
    t.cap(f"{tag}_00")
    last = t.plain()
    for i in range(1, most):
        t.keys("Down", pause=0.6)
        now = t.plain()
        t.cap(f"{tag}_{i:02d}")
        if now == last:
            break
        last = now
    t.keys("Escape")
    time.sleep(1.5)


t = common.Tui(out, [binp, "--name", "probe-model"], work, size=(120, 40))
try:
    t0 = time.time()
    trusted = False
    while time.time() - t0 < 90:
        p = t.plain()
        if not trusted and "trust" in p.lower() and "Yes" in p:
            t.keys("Enter")
            trusted = True
        elif "for shortcuts" in p or "mode on" in p:
            break
        time.sleep(0.5)
    time.sleep(3)
    t.cap("idle")
    print(label, "ready after", round(time.time() - t0, 1), "s")
    if expand:
        open_more(t, "x120")
    else:
        walk(t, "w120")
        t.size(80, 24)
        walk(t, "w80")
    t.keys("C-c")
    time.sleep(0.5)
    t.keys("C-c")
    time.sleep(2)
    t.cap("exit")
finally:
    t.close()
print(out, len([f for f in os.listdir(out) if f.endswith(".esc")]), "frames")
