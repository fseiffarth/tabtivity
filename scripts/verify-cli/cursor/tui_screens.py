"""Drive Cursor's TUI (`cursor-agent`) through scripted steps and save its frames.

    python3 scripts/verify-cli/cursor/tui_screens.py <label> <bin> <name>
        [--auth shared|none] [--cwd DIR] [--home NAME] [--size COLSxROWS] [--env K=V ...]
        [--arg ARG ...] --step STEP ...

Steps are tui.py's (`sleep:S wait:TEXT[:S] cap:NAME key:K[,K] type:TEXT
enter:TEXT size:CxR`) plus `show` (print the pane as plain text).
Frames land in tmp/verify-cli/cursor/<label>/<name>/ as `<frame>@<cols>x<rows>.esc`,
the layout parsers/frames.probe.ts replays (`VERIFY_CLI=cursor`,
`VERIFY_AGENT=cursor-agent`).

The binary is launched as the app does, `--disable-auto-update` first in argv.
It always runs in a scratch HOME, with `CURSOR_CONFIG_DIR` inside it, so the
user's `~/.cursor` (its `cli-config.json`, `hooks.json`) is never read or
written. `--auth`:

  shared  the signed-in screens: only `XDG_CONFIG_HOME` points at the real
          config dir, which is where the CLI looks for `cursor/auth.json`. Nothing
          is copied, so a token refresh lands in the one file the user's own
          CLI reads. A turn made here bills that account: keep them few.
  none    a fresh scratch HOME with no token (the first-run and sign-in screens).

`--arg=--resume` for an argument that starts with dashes. `--cwd` is the folder the CLI starts in (default: `<home>/work`, a fresh git
repo); `--home NAME` reuses the scratch home `h-NAME` of an earlier run (its
trusted folders, its sessions); `--env`/`--arg` add environment and argv. Never run the binary bare:
the tab-identity variables must be unset, and `common.Tui` does that.
"""
import argparse
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import common  # noqa: E402

CLI = "cursor"
AUTO_UPDATE_OFF = "--disable-auto-update"


def git_init(path):
    os.makedirs(path, exist_ok=True)
    if not os.path.isdir(os.path.join(path, ".git")):
        subprocess.run(["git", "init", "-q", path], check=True)
        with open(os.path.join(path, "README.md"), "w") as f:
            f.write("# scratch\n")


def run(label, binary, name, steps, auth="none", cwd=None, home_name=None, size="120x40", env=None, args=()):
    """One launch of the TUI through `steps`; frames under <out>/<label>/<name>/.

    Returns how many `wait:` steps missed their text (frames `timeout-N` hold
    the screen at that moment)."""
    out = common.out_dir(CLI, label, name)
    home = common.out_dir(CLI, label, f"h-{home_name or name}")
    cwd = cwd or os.path.join(home, "work")
    git_init(cwd)
    extra = {"CURSOR_CONFIG_DIR": os.path.join(home, ".cursor"), "NO_OPEN_BROWSER": "1"}
    if auth == "shared":
        extra["XDG_CONFIG_HOME"] = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    extra.update(env or {})
    cols, rows = (int(x) for x in size.split("x"))
    t = common.Tui(out, [binary, AUTO_UPDATE_OFF, *args], cwd, common.scratch_env(home, extra), size=(cols, rows))
    misses = 0
    try:
        for s in steps or ["sleep:6", "cap:start"]:
            op, _, arg = s.partition(":")
            if op == "sleep":
                time.sleep(float(arg))
            elif op == "wait":
                secs = arg.rsplit(":", 1)[-1]
                text, secs = (arg.rsplit(":", 1)[0], int(secs)) if secs.isdigit() else (arg, 30)
                if not t.wait(text, secs):
                    misses += 1
                    t.cap(f"timeout-{misses}")
                    print(f"wait missed: {text!r}", file=sys.stderr)
            elif op == "cap":
                t.cap(arg)
            elif op == "key":
                t.keys(*arg.split(","))
            elif op == "type":
                t.type(arg)
            elif op == "enter":
                t.type(arg)
                t.keys("Enter")
            elif op == "size":
                t.size(*(int(x) for x in arg.split("x")))
            elif op == "show":
                print(f"--- {t.cols}x{t.rows} ---")
                print(t.plain().rstrip())
            else:
                raise SystemExit(f"unknown step {s!r}")
        print(out)
    finally:
        t.close()
    return misses


def main():
    ap = argparse.ArgumentParser(usage=__doc__)
    ap.add_argument("label")
    ap.add_argument("binary")
    ap.add_argument("name")
    ap.add_argument("--auth", choices=("shared", "none"), default="none")
    ap.add_argument("--cwd")
    ap.add_argument("--home", help="reuse the scratch home of another run (its trusted folders, its history)")
    ap.add_argument("--size", default="120x40")
    ap.add_argument("--env", action="append", default=[])
    ap.add_argument("--arg", action="append", default=[])
    ap.add_argument("--step", action="append", default=[])
    a = ap.parse_args()
    misses = run(a.label, a.binary, a.name, a.step, a.auth, a.cwd, a.home, a.size,
                 dict(kv.split("=", 1) for kv in a.env), a.arg)
    sys.exit(1 if misses else 0)


if __name__ == "__main__":
    main()
