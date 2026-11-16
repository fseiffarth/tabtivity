"""Muse's session hook and per-tab resume, offline (`--provider echo`).

Usage: resume.py <label> <bin>

Runs the app's own hook (`services/agent/muse_session/hook.rs`, written and
registered through the ignored test `writes_the_hook_for_a_probe`, so the
probe always loads what the app writes today) in a scratch home, and plays
two tabs of one folder: each takes a prompt, is relaunched on the session its
record names and must come back in its own; then a `muse exec` run from a
tab's `!` shell escape, a tab of another CLI, a `/clear` and a launch with no
prompt. Prints PASS/FAIL per check.

The tab variables are set to made-up keys for these launches (every other
probe unsets them): the hook here writes only to the scratch home's own
record folder, never the app's. The hook script sits in a folder with a space
in its name, to check the settings command's quoting.
"""
import os
import re
import shlex
import shutil
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import common  # noqa: E402

if len(sys.argv) != 3:
    sys.exit(__doc__)
label, binp = sys.argv[1], common.binary(sys.argv[2])
base = common.out_dir("muse", label, "resume")
shutil.rmtree(base, ignore_errors=True)
home = common.out_dir("muse", label, "resume", "home")
work = os.path.join(home, "work")
live = os.path.join(home, "live")
hooks = os.path.join(home, "hooks dir")
for d in (work, live, hooks):
    os.makedirs(d, exist_ok=True)
script = os.path.join(hooks, f"{common.SLUG}_muse_session.sh")

r = subprocess.run(
    ["cargo", "test", "-q", "-p", common.SLUG, "--no-default-features", "--lib", "writes_the_hook_for_a_probe", "--", "--ignored"],
    cwd=common.ROOT, capture_output=True, text=True,
    env=common.clean_environ({"MUSE_PROBE_SCRIPT": script, "MUSE_PROBE_LIVE": live, "MUSE_PROBE_HOME": home}))
if r.returncode != 0 or not os.path.exists(script):
    sys.exit("could not write the hook:\n" + r.stdout[-2000:] + r.stderr[-2000:])

UID_VAR, AGENT_VAR = common.ENV_PREFIX + "TAB_UID", common.ENV_PREFIX + "TAB_AGENT"
TABS = {k: f"{n}0000000-0000-4000-8000-00000000000{n}" for n, k in enumerate("ABCD", 1)}
results = []


def check(name, ok, detail=""):
    results.append((name, ok))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail else ""))


def record(tab):
    try:
        return open(os.path.join(live, TABS[tab])).read().strip()
    except OSError:
        return None


def launch(tab, args, steps, agent="muse", name=None):
    """One launch of `tab`; `steps` are prompts, or `sleep:N`. Returns the last screen."""
    env = common.scratch_env(home, {UID_VAR: TABS[tab], AGENT_VAR: agent, "MUSE_NO_AUTO_UPDATE": "1"})
    t = common.Tui(common.out_dir("muse", label, "resume", name or tab), [binp, "--provider", "echo", *args],
                   work, env, size=(110, 32), keep=20)
    try:
        time.sleep(6)
        t.keys("Enter")  # the trust question on a first launch; an empty prompt after
        time.sleep(3)
        for s in steps:
            if s.startswith("sleep:"):
                time.sleep(float(s[6:]))
            else:
                t.type(s)
                t.keys("Enter")
                time.sleep(5)
        return t.plain()
    finally:
        t.close()
        time.sleep(1)


launch("A", [], ["alpha one"])
launch("B", [], ["beta one"])
a, b = record("A"), record("B")
check("each tab records its own session", bool(a and b and a != b), f"A={a} B={b}")
check("the hook leaves its proof", os.path.exists(os.path.join(live, "muse.hook")))

screen = launch("A", ["resume", a or "-"], ["alpha two"], name="A2")
check("tab A comes back in its own session", "alpha one" in screen and "beta one" not in screen)
check("a prompt in the same session keeps the record", record("A") == a)
screen = launch("B", ["resume", b or "-"], ["sleep:1"], name="B2")
check("tab B comes back in its own session", "beta one" in screen and "alpha one" not in screen)

nested = f"!{shlex.quote(binp)} exec --provider echo --disable-sandbox nested-run"
screen = launch("A", ["--disable-sandbox", "resume", a or "-"], [nested, "sleep:6"], name="A-nested")
check("a muse exec run in the tab ran", "nested-run" in screen)
check("a muse exec run in the tab does not move the record", record("A") == a, f"A={record('A')}")

launch("C", [], ["gamma one"], agent="claude")
check("a Muse in another CLI's tab records nothing", record("C") is None)
launch("D", [], ["sleep:4"])
check("a launch with no prompt records nothing", record("D") is None)

launch("A", ["resume", a or "-"], ["/clear", "sleep:2", "alpha after clear"], name="A-clear")
after = record("A")
check("a /clear's new session is the tab's at its first prompt", bool(after and after != a and re.fullmatch(r"[0-9a-f-]{36}", after)), f"A={after}")

print(f"\n{sum(ok for _, ok in results)}/{len(results)} passed; home {home}")
sys.exit(0 if all(ok for _, ok in results) else 1)
