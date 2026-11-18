"""Drive any CLI's TUI in a private tmux and save its frames.

    python3 scripts/verify-cli/tui.py <cli> <label> <name> -- <bin> [args...]
        [--home DIR] [--env K=V ...] [--stub openai|gemini --port N]
        [--step STEP ...]

Frames land in tmp/verify-cli/<cli>/<label>/<name>/ as `<frame>@<cols>x<rows>.esc`;
parsers/frames.probe.ts replays them through the app's parsers. HOME is
tmp/verify-cli/<cli>/<label>/h-<name> unless --home names one (reuse a home to
test resume against the session a first run left there).

Steps run in order (default: `sleep:5 cap:start size:60x30 cap:start size:42x24 cap:start`):
    sleep:SECS   wait:TEXT[:SECS]   cap:NAME   key:KEY[,KEY...]   type:TEXT
    size:COLSxROWS   enter:TEXT (type TEXT, press Enter)
`wait` captures `timeout-<n>` and goes on when TEXT never shows, so one missing
screen does not hide the rest. Key names are tmux's (Enter, Escape, C-c, Down, S-Down).
"""
import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402

STUBS = {"openai": "stub_openai.py", "gemini": "stub_gemini.py"}


def main():
    argv = sys.argv[1:]
    cmd = argv[argv.index("--") + 1:] if "--" in argv else []
    head = argv[:argv.index("--")] if "--" in argv else argv
    ap = argparse.ArgumentParser(usage=__doc__)
    ap.add_argument("cli")
    ap.add_argument("label")
    ap.add_argument("name")
    ap.add_argument("--home")
    ap.add_argument("--env", action="append", default=[])
    ap.add_argument("--stub", choices=sorted(STUBS))
    ap.add_argument("--port", type=int, default=47400)
    ap.add_argument("--step", action="append")
    ap.add_argument("--size", default="120x40")
    a = ap.parse_args(head)
    if not cmd:
        ap.error("give the binary after --")
    out = common.out_dir(a.cli, a.label, a.name)
    home = a.home or common.out_dir(a.cli, a.label, f"h-{a.name}")
    work = os.path.join(home, "work")
    os.makedirs(work, exist_ok=True)
    env = common.scratch_env(home, dict(kv.split("=", 1) for kv in a.env))
    stub = common.start_stub(STUBS[a.stub], a.port, os.path.join(out, "stub.jsonl")) if a.stub else None
    cols, rows = (int(x) for x in a.size.split("x"))
    t = common.Tui(out, cmd, work, env, size=(cols, rows))
    steps = a.step or ["sleep:5", "cap:start", "size:60x30", "cap:start", "size:42x24", "cap:start"]
    misses = 0
    try:
        for s in steps:
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
        print("\n".join(t.plain().rstrip().splitlines()[-12:]))
    finally:
        t.close()
        if stub:
            stub.terminate()
    sys.exit(1 if misses else 0)


if __name__ == "__main__":
    main()
