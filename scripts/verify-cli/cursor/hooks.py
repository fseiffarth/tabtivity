"""Cursor's session hook and per-tab resume, against the real login.

Usage: hooks.py <label> <bin>

Cursor has no stub backend, so this makes two small real turns (two billed
prompts on the default Auto model). It runs the app's own hook
(`services/agent/cursor_session/hook.rs`, written and registered through the
ignored test `writes_the_cursor_hook_for_a_probe`, so the probe always loads what the
app writes today) from a project-level `.cursor/hooks.json` in a scratch project
folder, beside a `hookdump.py` on `sessionStart` and `beforeSubmitPrompt`, and
plays two tabs of that one folder with made-up tab keys: each takes a prompt
and must record the chat its own prompt went into (the `conversation_id`
`hookdump.py` saw); a launch with no prompt, `--resume <id>` and
`--continue` must record nothing; each tab relaunched on `--resume <its id>`
must show its own prompt and not the other's.

`--trust` skips the new folder's trust question (a screen the app answers itself).
The real `$HOME` is used (it holds the login and the `.cursor` chat store;
never copy `~/.config/cursor/auth.json`). The chats land in
`~/.cursor/chats/<md5 of the scratch folder>/`, which no real tab reads. The
tab variables are made-up keys: the hook writes only into the scratch record
folder. The hook script sits in a folder with a space in its name, to check
the hooks command's quoting. Prints PASS/FAIL per check; frames and the hook
log are under `tmp/verify-cli/cursor/<label>/hooks/`.
"""
import json
import os
import shutil
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import common  # noqa: E402

if len(sys.argv) != 3:
    sys.exit(__doc__)
label, binp = sys.argv[1], common.binary(sys.argv[2])
base = common.out_dir("cursor", label, "hooks")
shutil.rmtree(base, ignore_errors=True)
base = common.out_dir("cursor", label, "hooks")
proj = os.path.join(base, "proj")
live = os.path.join(base, "live")
hooks = os.path.join(base, "hooks dir")
for d in (proj, live, hooks):
    os.makedirs(d, exist_ok=True)
subprocess.run(["git", "init", "-q", proj], check=True)
script = os.path.join(hooks, f"{common.SLUG}_cursor_session.sh")
log = os.path.join(base, "hooks.jsonl")

r = subprocess.run(
    ["cargo", "test", "-q", "-p", common.SLUG, "--no-default-features", "--lib", "writes_the_cursor_hook_for_a_probe", "--", "--ignored"],
    cwd=common.ROOT, capture_output=True, text=True,
    env=common.clean_environ({"CURSOR_PROBE_SCRIPT": script, "CURSOR_PROBE_LIVE": live, "CURSOR_PROBE_HOME": proj}))
if r.returncode != 0 or not os.path.exists(script):
    sys.exit("could not write the hook:\n" + r.stdout[-2000:] + r.stderr[-2000:])
# Beside the app's hook: a dump of every start and prompt, for the chat ids.
path = os.path.join(proj, ".cursor", "hooks.json")
cfg = json.load(open(path))
dump = os.path.join(common.HERE, "hookdump.py")
for event in ("sessionStart", "beforeSubmitPrompt"):
    cfg["hooks"].setdefault(event, []).append({"command": f"python3 -I {dump} {log} {event}"})
json.dump(cfg, open(path, "w"), indent=1)

UID_VAR, AGENT_VAR = common.ENV_PREFIX + "TAB_UID", common.ENV_PREFIX + "TAB_AGENT"
TABS = {"A": "a0000000-0000-4000-8000-00000000000a", "B": "b0000000-0000-4000-8000-00000000000b"}
WORDS = {"A": "PELICAN", "B": "WALRUS"}
results = []


def check(name, ok, detail=""):
    results.append((name, ok))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail else ""))


def record(tab):
    try:
        return open(os.path.join(live, TABS[tab])).read().strip()
    except OSError:
        return None


def dumped(event):
    out = []
    try:
        for line in open(log):
            rec = json.loads(line)
            if rec["event"] == event:
                out.append(rec["input"] or {})
    except OSError:
        pass
    return out


def launch(tab, args, steps, name):
    t = common.Tui(base, [binp, "--disable-auto-update", "--trust", *args], proj, {UID_VAR: TABS[tab], AGENT_VAR: "cursor-agent"})
    try:
        time.sleep(8)
        for step in steps:
            op, _, arg = step.partition(":")
            if op == "enter":
                t.type(arg)
                t.keys("Enter")
            elif op == "sleep":
                time.sleep(float(arg))
        t.cap(name)
        return t.plain()
    finally:
        t.close()


# A launch with no prompt: sessionStart fires, the record stays empty.
launch("A", [], [], "idle")
check("a launch with no prompt records nothing", record("A") is None and not os.path.exists(os.path.join(live, "cursor.hook")))
check("sessionStart fired at the launch", len(dumped("sessionStart")) == 1)

# Two tabs of the folder, one prompt each.
for tab in "AB":
    launch(tab, [], [f"enter:Reply with the single word {WORDS[tab]} and nothing else.", "sleep:25"], f"tab-{tab}")
prompts = dumped("beforeSubmitPrompt")
ids = {}
for p in prompts:
    for tab, word in WORDS.items():
        if word in p.get("prompt", ""):
            ids[tab] = p["conversation_id"]
check("each tab's prompt reached the hook", set(ids) == {"A", "B"} and ids["A"] != ids["B"], str(ids))
check("each tab recorded the chat of its own prompt", all(record(t) == ids.get(t) for t in "AB"), f"{record('A')} {record('B')}")
check("the hook left its proof", os.path.exists(os.path.join(live, "cursor.hook")))

# Relaunch each tab on its own chat: `--resume <id>` shows its prompt, not the other's.
for tab, other in (("A", "B"), ("B", "A")):
    screen = launch(tab, ["--resume", record(tab) or "none"], [], f"resume-{tab}")
    check(f"tab {tab} resumed by id shows its own prompt and not tab {other}'s", WORDS[tab] in screen and WORDS[other] not in screen)
n = len(dumped("sessionStart"))
check("--resume fired no sessionStart (only a fresh launch does)", n == 3, f"{n} starts after 3 fresh launches")
before = record("A")
launch("A", ["--continue"], [], "continue")
check("--continue recorded nothing new", record("A") == before)

# The folder's chats: the one the launches made empty, the two prompted ones.
chats = os.path.expanduser("~/.cursor/chats")
print(f"chat store: {chats} (the scratch folder's key is the md5 of {proj})")
print(f"{sum(ok for _, ok in results)}/{len(results)} passed")
sys.exit(0 if all(ok for _, ok in results) else 1)
