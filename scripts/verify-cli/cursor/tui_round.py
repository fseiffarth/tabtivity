"""Every Cursor TUI screen the Chat reads, captured in one round.

    python3 scripts/verify-cli/cursor/tui_round.py <label> <bin> [--paid] [--only NAME ...]

`<bin>` is the app's own install, `.../cursor-agent/versions/<v>/cursor-agent`;
`<label>` the version under test (`tmp/verify-cli/cursor/<label>/`). Each
scenario is one launch (`tui_screens.run`), its frames saved as
`<name>/<frame>@<cols>x<rows>.esc` for the replay:

    VERIFY_CLI=cursor VERIFY_AGENT=cursor-agent VERIFY_NEW=<label> \\
      node_modules/.bin/vitest run --config scripts/verify-cli/parsers/vitest.config.mts

Without `--paid` nothing is sent to a model: the sign-in screens (a scratch HOME
with no token), the trust page, the idle box and its draft, the `/` menu, the
Shift+Tab modes, `/model`, the resume list, and the footer under `--model`,
`--force`, `--auto-review` and `--plan`. These need the user's login only to
get past the sign-in screen (`--auth shared`: `XDG_CONFIG_HOME` is the real
one, which holds `cursor/auth.json`; nothing is copied, and `~/.cursor` is
never read, `CURSOR_CONFIG_DIR` being a scratch one).

`--paid` adds the screens a turn is needed for, each a short turn on the
default model that bills the signed-in account (five turns in all, and the
dialogs are answered or abandoned): a shell command not on the allowlist (the
approval at 120, 60 and 42 columns, the highlight moved, then `y`: the busy row,
a prompt typed and sent while it runs — the follow-ups box — Ctrl+C), a write
outside the workspace (its approval at three widths, then `y`), Esc and Ctrl+C
on the shell approval (the field to tell the agent what to do instead), and a
two-line prompt sent with the Chat's own writes (Ctrl+A Ctrl+K, one bracketed
paste, Enter).

A home remembers the folders it trusted: the `trust` scenario shows its page
only in a label not run before (`--only trust` first, then the rest, which need
the folder trusted).

What each frame has to read as is `src/__tests__/mobile/CursorAgentLive.test.ts`
(frames in `src/__tests__/fixtures/cursorFrames.ts`).
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tui_screens  # noqa: E402

common = tui_screens.common

SIZES = ["size:60x30", "cap:{n}", "size:42x24", "cap:{n}", "size:120x40"]
READY = "wait:Plan, search, build anything:40"
SHELL = "Use the shell tool to run `sleep 40; echo hi`, then say done. Nothing else."
WRITE = "Write the single word hi into the file ../outside-hello.txt (one folder above the current one), using your edit/write tool, not the shell. Then say done. Nothing else."
TWO_LINES = "Reply with exactly the word ok.\nThis second line belongs to the same message, ignore it."


def at_sizes(name):
    """A frame at the three widths the app meets."""
    return [f"cap:{name}", *(s.format(n=name) for s in SIZES)]


def bracketed(text):
    return "\x1b[200~" + text + "\x1b[201~"


def free():
    """name -> (auth, args, steps, home): screens that cost nothing."""
    ready = ["sleep:2", "wait:Plan, search, build anything:40", "sleep:1"]
    return {
        "firstrun": ("none", [], ["sleep:8", "cap:start", "size:60x30", "cap:start", "size:42x24", "cap:start"], None),
        "login": ("none", ["login"], ["sleep:9", *at_sizes("login")], None),
        # A fresh home has trusted no folder: the page, then `a`.
        "trust": ("shared", [], ["sleep:8", *at_sizes("trust"), "key:Down", "cap:trust-down", "key:Up", "key:a", "sleep:5", "cap:idle"], "main"),
        "idle": ("shared", [], [*ready, *at_sizes("idle"), "type:hello", "cap:typed", "key:C-u", "key:C-j", "type:one", "key:C-j", "type:two", "cap:draft", "key:C-u,C-u"], "main"),
        "paste": ("shared", [], [*ready, f"type:{bracketed('line 1' + chr(10) + 'line 2' + chr(10) + 'line 3')}", "sleep:1", "cap:paste-ml", "size:60x30", "cap:paste-ml"], "main"),
        "menus": ("shared", [], [*ready, "type:/", "sleep:1", "cap:slash", "type:mod", "sleep:1", "cap:slash-mod", "key:C-u", "key:BTab", "sleep:1", "cap:mode1",
                                  "key:BTab", "sleep:1", "cap:mode2", "key:BTab", "sleep:1", "cap:mode3", "key:BTab", "sleep:1", "cap:mode4"], "main"),
        "model": ("shared", [], [*ready, "enter:/model", "wait:Available models:15", "sleep:1", *at_sizes("model"), "key:Down,Down", "cap:model-down2", "key:Escape", "sleep:1", "cap:model-esc"], "main"),
        "resume": ("shared", ["--resume"], ["sleep:7", *at_sizes("resume"), "key:Down", "cap:resume-down", "key:Escape", "sleep:1", "cap:resume-esc"], "main"),
        "force": ("shared", ["--force"], [*ready, "cap:footer"], "main"),
        "autoreview": ("shared", ["--auto-review"], [*ready, "cap:footer"], "main"),
        "plan": ("shared", ["--plan"], [*ready, "cap:footer"], "main"),
        "model-flag": ("shared", ["--model", "claude-sonnet-5-5"], [*ready, *at_sizes("footer")], "main"),
    }


def paid():
    """The screens a model turn is needed for: five short turns in all."""
    ready = ["wait:Plan, search, build anything:40", "sleep:1"]
    return {
        # Turn 1: the approval, three widths, the highlight walked, `y`, then
        # work: the busy row, a draft (the hint goes), a prompt sent while it
        # runs (the follow-ups box), Ctrl+C.
        "shell": ("shared", [], [*ready, f"enter:{SHELL}", "wait:Run this command?:40", "sleep:1", *at_sizes("dialog"),
                                  "key:Down,Down", "cap:dialog-down2", "key:Up,Up", "key:y", "sleep:4", *at_sizes("busy"),
                                  "type:and also say banana", "cap:busy-typed", "key:Enter", "sleep:2", "cap:busy-sent", "key:C-c", "sleep:2", "cap:ctrlc", "key:C-c", "sleep:1.5", "cap:ctrlc-idle"], "main"),
        # Turn 2: a write outside the workspace.
        "write": ("shared", [], [*ready, f"enter:{WRITE}", "wait:Write to this file?:60", "sleep:1", *at_sizes("edit-dialog"), "key:y", "sleep:8", "cap:after"], "main"),
        # Turn 3: Esc on the shell approval opens the field to tell the agent what to do.
        "tell": ("shared", [], [*ready, f"enter:{SHELL}", "wait:Run this command?:40", "key:Escape", "sleep:1.5", "cap:tell-field", "key:C-c", "sleep:2", "cap:tell-ctrlc"], "main"),
        # Turn 4: the Chat's own writes for a two-line prompt.
        "send": ("shared", [], [*ready, "type:\x01\x0b", f"type:{bracketed(TWO_LINES)}", "sleep:0.4", "cap:sent-pre", "key:Enter", "sleep:1", "cap:sent-busy",
                                 "wait:Add a follow-up:60", "sleep:2", *at_sizes("sent-done")], "main"),
    }


def main():
    ap = argparse.ArgumentParser(usage=__doc__)
    ap.add_argument("label")
    ap.add_argument("binary")
    ap.add_argument("--paid", action="store_true", help="also the screens that need a model turn")
    ap.add_argument("--only", nargs="*", default=[], help="scenario names")
    a = ap.parse_args()
    project = os.path.join(common.OUT, "cursor", "proj-tui")
    scenarios = {**free(), **(paid() if a.paid else {})}
    misses = 0
    for name, (auth, args, steps, home) in scenarios.items():
        if a.only and name not in a.only:
            continue
        print(f"== {name}", file=sys.stderr)
        misses += tui_screens.run(a.label, a.binary, name, steps, auth, project if home else None, home, args=[*args])
    sys.exit(1 if misses else 0)


if __name__ == "__main__":
    main()
