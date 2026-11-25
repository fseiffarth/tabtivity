"""Mistral Vibe: the app's session hook and per-tab resume, offline.

Usage: resume.py <label> <vibe-bin> <port>

Runs the app's own hook (`posix_hook_script_body` and the `hooks.toml` block
`agent_session` registers, written by the ignored test
`writes_the_vibe_hook_for_a_probe`, so the probe always loads what the app
writes today) in a scratch `VIBE_HOME` whose provider is `stub_openai.py`.
Two tabs of one folder each take a prompt; each must record its own session,
the store must hold `logs/session/unified/<id>/CURRENT` for it (what
`vibe_session_exists` checks before a resume), and a relaunch with
`--resume <id>` must come back in that tab's own conversation. A `vibe -p`
run from the tab's bash tool must move neither record, a `/clear` moves the
record at its next prompt, and the turn record reads `done` after a turn and
`idle` once the window closed (`session_end`).
Also: `VIBE_ACTIVE_MODEL` picks the model the request names (how a tab's model
choice reaches Vibe), and the user-level `.vibe/AGENTS.md` (`agent_hint`'s
instructions file) reaches the model. Prints PASS/FAIL per check.

The tab variables are set to made-up keys for these launches (every other
probe unsets them): the hook writes only into the scratch home's record
folder, never the app's.
"""
import json
import os
import shutil
import subprocess
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import common  # noqa: E402

if len(sys.argv) != 4:
    sys.exit(__doc__)
label, binp, port = sys.argv[1], common.binary(sys.argv[2]), int(sys.argv[3])
base = common.out_dir("vibe", label, "resume")
shutil.rmtree(base, ignore_errors=True)
# A fresh home per run: Vibe leaves read-only files in its plugin cache.
home = common.out_dir("vibe", label, "resume", "home")
vibe, work, live = os.path.join(home, ".vibe"), os.path.join(home, "work"), os.path.join(home, "live")
for d in (vibe, work, live):
    os.makedirs(d, exist_ok=True)
script = os.path.join(home, "hooks dir", f"{common.SLUG}_hook.sh")
os.makedirs(os.path.dirname(script), exist_ok=True)

with open(os.path.join(vibe, "config.toml"), "w") as f:
    f.write(f'active_model = "stub"\n\n[[providers]]\nname = "stub"\napi_base = "http://127.0.0.1:{port}/v1"\n'
            'api_key_env_var = ""\napi_style = "openai"\nbackend = "generic"\n')
    for name in ("stub", "stub-two"):
        f.write(f'\n[[models]]\nname = "{name}"\nprovider = "stub"\nalias = "{name}"\ntemperature = 0.2\n'
                'input_price = 0.0\noutput_price = 0.0\n')
with open(os.path.join(vibe, "AGENTS.md"), "w") as f:
    f.write("STUBMARK-VIBEHINT: a user-level instruction.\n")

r = subprocess.run(
    ["cargo", "test", "-q", "-p", common.SLUG, "--no-default-features", "--lib", "writes_the_vibe_hook_for_a_probe",
     "--", "--ignored"],
    cwd=common.ROOT, capture_output=True, text=True,
    env=common.clean_environ({"VIBE_PROBE_SCRIPT": script, "VIBE_PROBE_LIVE": live, "VIBE_PROBE_HOME": vibe}))
if r.returncode != 0 or not os.path.exists(script):
    sys.exit("could not write the hook:\n" + r.stdout[-2000:] + r.stderr[-2000:])

UID_VAR, AGENT_VAR = common.ENV_PREFIX + "TAB_UID", common.ENV_PREFIX + "TAB_AGENT"
# The turn word each tab's record held at the end of its last launch's steps,
# before the window closed (closing fires `session_end`, which writes `idle`).
at_end = {}
TABS = {k: f"{n}0000000-0000-4000-8000-00000000000{n}" for n, k in enumerate("AB", 1)}
stub_log = os.path.join(base, "stub.jsonl")
stub = common.start_stub("stub_openai.py", port, stub_log)
results = []


def check(name, ok, detail=""):
    results.append((name, ok))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail else ""))


def record(tab):
    try:
        return open(os.path.join(live, TABS[tab])).read().strip()
    except OSError:
        return None


def turn_word(tab):
    try:
        return open(os.path.join(live, TABS[tab] + ".turn")).read().split()[0]
    except (OSError, IndexError):
        return None


def requests():
    try:
        return [json.loads(line) for line in open(stub_log) if line.startswith("{\"path\"")]
    except OSError:
        return []


def launch(tab, args, steps, name=None, extra=None):
    """One launch of `tab`: `steps` are prompts, `key:K` or `sleep:N`. Returns the last screen."""
    env = common.scratch_env(home, {"VIBE_HOME": vibe, UID_VAR: TABS[tab], AGENT_VAR: "vibe",
                                    common.ENV_PREFIX + "PROJECT_DIR": work,
                                    "PATH": os.environ.get("PATH", "/usr/bin:/bin"), **(extra or {})})
    t = common.Tui(common.out_dir("vibe", label, "resume", name or tab), [binp, *args], work, env,
                   size=(110, 36), keep=40)
    try:
        for _ in range(120):
            s = t.plain()
            if "trust" in s.lower() and ("folder" in s.lower() or "directory" in s.lower()):
                t.keys("Enter")
            time.sleep(0.5)
            if (">" in s and "─" in s and "trust" not in s.lower()
                    and "Initializing…" not in s and "Resuming session…" not in s):
                break
        time.sleep(2)
        t.cap("start")
        for s in steps:
            if s.startswith("wait:"):
                t.wait(s[5:], 60)
            elif s.startswith("sleep:"):
                time.sleep(float(s[6:]))
            elif s.startswith("key:"):
                t.keys(s[4:])
                time.sleep(3)
            else:
                t.type(s)
                t.wait(s, 2)
                t.keys("Enter")
                time.sleep(7)
        t.cap("end")
        at_end[tab] = turn_word(tab)
        return t.plain()
    finally:
        t.close()
        time.sleep(1)


try:
    launch("A", [], ["alpha one"])
    launch("B", [], ["beta one"])
    a, b = record("A"), record("B")
    check("each tab records its own session", bool(a and b and a != b), f"A={a} B={b}")
    unified = os.path.join(vibe, "logs", "session", "unified")
    check("the store holds unified/<id>/CURRENT for both",
          all(os.path.isfile(os.path.join(unified, i or "-", "CURRENT")) for i in (a, b)),
          ", ".join(sorted(os.listdir(unified))) if os.path.isdir(unified) else "no unified store")
    check("a finished turn leaves done", at_end.get("A") == "done" and at_end.get("B") == "done",
          f"A={at_end.get('A')} B={at_end.get('B')}")
    check("closing the window leaves idle", turn_word("A") == "idle" and turn_word("B") == "idle",
          f"A={turn_word('A')} B={turn_word('B')}")
    hinted = [q for q in requests() if "STUBMARK-VIBEHINT" in q.get("marks", [])]
    check("the user-level .vibe/AGENTS.md reaches the model", bool(hinted), f"{len(hinted)} of {len(requests())}")

    screen = launch("A", ["--resume", a or "-"], ["alpha two"], name="A2")
    check("tab A comes back in its own session", "alpha one" in screen and "beta one" not in screen)
    check("a prompt in the resumed session keeps the record", record("A") == a, f"now {record('A')}")
    screen = launch("B", ["--resume", b or "-"], ["sleep:1"], name="B2")
    check("tab B comes back in its own session", "beta one" in screen and "alpha one" not in screen)

    before = (record("A"), record("B"))
    bash = json.dumps({"command": f"{binp} -p 'nested hi'"})
    launch("A", ["--resume", a or "-"], [f"STUB:CALL bash {bash}", "key:Enter", "sleep:12"], name="A3")
    check("a vibe -p from the tab's bash tool moves no record", (record("A"), record("B")) == before,
          f"A={record('A')}")

    launch("A", ["--resume", a or "-"], ["/clear", "after clear"], name="A4")
    check("a /clear moves the record at its next prompt", bool(record("A")) and record("A") != a,
          f"{a} -> {record('A')}")

    n = len(requests())
    launch("B", [], ["model check", "wait:stub answer done"], name="B3", extra={"VIBE_ACTIVE_MODEL": "stub-two"})
    models = sorted({q.get("model") for q in requests()[n:]} - {None})
    check("VIBE_ACTIVE_MODEL picks the model the request names", models == ["stub-two"], f"{models}")
finally:
    stub.terminate()

print(f"{sum(ok for _, ok in results)}/{len(results)} passed")
sys.exit(0 if all(ok for _, ok in results) else 1)
