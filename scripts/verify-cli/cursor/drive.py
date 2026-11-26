"""Drive Cursor's TUI in a private tmux against the user's real login.

    python3 scripts/verify-cli/cursor/drive.py <label> <bin> <name> <work-dir>
        [--step STEP ...] [--env K=V ...] [--size COLSxROWS] [-- extra args]

Cursor has no stub backend, so a signed-in turn needs the real `$HOME` (its
`~/.cursor` holds the login and the chat store). Never point `<work-dir>` at a
folder a real tab uses: the chats land in `~/.cursor/chats/<md5 of the
folder>/`. Make a scratch folder (`git init` it) with a project-level
`.cursor/hooks.json` that runs `hookdump.py` for the events to read
(`hooks_json.py` writes one). Every step is a real billed turn once a prompt
is entered: budget them.

Steps (as `tui.py`): `sleep:SECS`, `wait:TEXT[:SECS]`, `cap:NAME`,
`key:KEY[,KEY...]`, `type:TEXT`, `enter:TEXT`, `size:COLSxROWS`. Frames land in
`tmp/verify-cli/cursor/<label>/<name>/`. The binary runs as the app starts it,
`--disable-auto-update` first (`agent_install.rs`); never update or reinstall
the user's build. The tab-identity variables are unset (`common.Tui`).
"""
import argparse
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import common  # noqa: E402


def main():
    argv = sys.argv[1:]
    extra = argv[argv.index("--") + 1:] if "--" in argv else []
    head = argv[:argv.index("--")] if "--" in argv else argv
    ap = argparse.ArgumentParser(usage=__doc__)
    ap.add_argument("label")
    ap.add_argument("bin")
    ap.add_argument("name")
    ap.add_argument("work")
    ap.add_argument("--step", action="append", default=[])
    ap.add_argument("--env", action="append", default=[])
    ap.add_argument("--size", default="120x40")
    a = ap.parse_args(head)
    out = common.out_dir("cursor", a.label, a.name)
    cols, rows = (int(x) for x in a.size.split("x"))
    env = dict(kv.split("=", 1) for kv in a.env)
    t = common.Tui(out, [a.bin, "--disable-auto-update", *extra], os.path.abspath(a.work), env, size=(cols, rows))
    misses = 0
    try:
        for s in a.step or ["sleep:6", "cap:start"]:
            op, _, arg = s.partition(":")
            if op == "sleep":
                time.sleep(float(arg))
            elif op == "wait":
                text, _, secs = arg.rpartition(":") if arg.rsplit(":", 1)[-1].isdigit() else (arg, "", "30")
                if not t.wait(text, int(secs)):
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
            else:
                ap.error(f"unknown step {s!r}")
        print(out)
    finally:
        t.close()


main()
