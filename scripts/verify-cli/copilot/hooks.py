"""Which Copilot hooks fire, with what, and what the app's turn hook writes.

    python3 scripts/verify-cli/copilot/hooks.py events|turn <label> <bin> [port]
    → tmp/verify-cli/copilot/<label>/hooks-<mode>/{dump.jsonl,stub.jsonl,*.esc,result.json}

Registers `hookdump.py` on every hook event Copilot documents, in a scratch
`COPILOT_HOME`, and walks one interactive session pinned with
`--session-id`, as a tab's is: a plain prompt, an approval answered yes, one
answered with Esc, a failing tool, a model call that fails (`STUB:FAIL 400`),
a subagent (`task`), a `copilot -p` run from the session's own shell tool,
`/compact`, `/new` and `/exit`. `events` stops there: read dump.jsonl.
`turn` also registers the app's own hooks (written by the ignored test
`writes_the_copilot_hooks_for_a_probe`, so the probe loads what the app
writes today) and prints the tab's turn record after every step, with
PASS/FAIL for the word each step must leave and for the nested run leaving
the record alone.

The tab variables are set to a made-up key for this launch (every other
probe unsets them): the app's hook writes only into this scratch home's own
record folder. Offline: BYOK against stub_openai.py, auto-update off.
"""
import json
import os
import shutil
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import common  # noqa: E402

EVENTS = ["sessionStart", "sessionEnd", "userPromptSubmitted", "userPromptTransformed", "preToolUse",
          "postToolUse", "postToolUseFailure", "permissionRequest", "notification", "agentStop",
          "subagentStart", "subagentStop", "preCompact", "errorOccurred"]
UID = "aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb"

if len(sys.argv) < 4 or sys.argv[1] not in ("events", "turn"):
    sys.exit(__doc__)
mode, label, binp = sys.argv[1], sys.argv[2], common.binary(sys.argv[3])
port = int(sys.argv[4]) if len(sys.argv) > 4 else 47460
out = common.out_dir("copilot", label, f"hooks-{mode}")
shutil.rmtree(out, ignore_errors=True)
out = common.out_dir("copilot", label, f"hooks-{mode}")
home = common.out_dir("copilot", label, f"hooks-{mode}", "home")
work = os.path.join(home, "work")
live = os.path.join(home, "live")
hooks_dir = os.path.join(home, ".copilot", "hooks")
for d in (work, live, hooks_dir):
    os.makedirs(d, exist_ok=True)
subprocess.run(["git", "init", "-q", work], check=False)
dump = os.path.join(out, "dump.jsonl")
dumper = os.path.join(common.HERE, "hookdump.py")


def hook(cmd):
    return {"type": "command", "bash": cmd, "timeoutSec": 10}


common.write_json(os.path.join(hooks_dir, "probe-dump.json"), {"version": 1, "hooks": {
    e: [hook(f"python3 -I '{dumper}' '{dump}' {e}")] for e in EVENTS}})

if mode == "turn":
    r = subprocess.run(
        ["cargo", "test", "-q", "-p", common.SLUG, "--no-default-features", "--lib",
         "writes_the_copilot_hooks_for_a_probe", "--", "--ignored"],
        cwd=os.path.join(common.ROOT, "src-tauri"), capture_output=True, text=True,
        env=common.clean_environ({"COPILOT_PROBE_HOME": home, "COPILOT_PROBE_LIVE": live,
                                  "COPILOT_PROBE_HOOKS": os.path.join(home, "app hooks")}))
    if r.returncode != 0:
        sys.exit("could not write the app's hooks:\n" + r.stdout[-2000:] + r.stderr[-2000:])
    print("app hooks:", sorted(os.listdir(hooks_dir)))

log = os.path.join(out, "stub.jsonl")
stub = common.start_stub("stub_openai.py", port, log)
env = common.scratch_env(home, {
    "COPILOT_HOME": f"{home}/.copilot", "COPILOT_AUTO_UPDATE": "false",
    "COPILOT_PROVIDER_BASE_URL": f"http://127.0.0.1:{port}/v1",
    "COPILOT_PROVIDER_API_KEY": "test", "COPILOT_MODEL": "stub",
    common.ENV_PREFIX + "TAB_UID": UID, common.ENV_PREFIX + "TAB_AGENT": "copilot",
    common.ENV_PREFIX + "PROJECT_DIR": work,
})
results = {}
checks = []


def events():
    try:
        return [json.loads(line) for line in open(dump)]
    except OSError:
        return []


def turn_word():
    try:
        return open(os.path.join(live, f"{UID}.turn")).read().split()[0]
    except (OSError, IndexError):
        return None


def is_nested(e):
    """A hook of a Copilot started by a Copilot tool (its shell sets this)."""
    return "COPILOT_AGENT_SESSION_ID" in e.get("env", {})


def mine(e):
    """An event of the session's own conversation: not a nested run's, not a
    subagent's (its events carry the subagent's id), the tab's pinned id or
    one a later start of this Copilot introduced (`/new`)."""
    if is_nested(e) or not isinstance(e.get("input"), dict):
        return False
    starts = {x["input"].get("sessionId") for x in events()
              if x["event"] == "sessionStart" and not is_nested(x) and isinstance(x.get("input"), dict)}
    return e["input"].get("sessionId") in starts | {UID}


def brief(e):
    i = e.get("input") if isinstance(e.get("input"), dict) else {}
    extra = i.get("notification_type") or i.get("reason") or i.get("source") or i.get("toolName") \
        or i.get("stopReason") or (f"recoverable={i.get('recoverable')}" if "recoverable" in i else "")
    return [e["event"], (i.get("sessionId") or "")[:8], "nested" if is_nested(e) else "", extra or ""]


def step(tag, text=None, until="agentStop", approve=None, secs=40, expect=None, dialog="Do you want"):
    """Type `text` (if any), answer every dialog showing `dialog` with
    `approve` ('yes' | 'esc'), wait for the event `until`; record the events
    and the turn word seen."""
    n0 = len(events())
    words = []
    if text is not None:
        t.type(text)
        t.keys("Enter")
    t0 = time.time()
    asked = 0
    while time.time() - t0 < secs:
        w = turn_word()
        if not words or words[-1] != w:
            words.append(w)
        if approve and asked < 4 and dialog in t.plain():
            asked += 1
            time.sleep(2.5)  # the hooks of an open dialog, the word it leaves
            w = turn_word()
            if words[-1] != w:
                words.append(w)
            t.cap(f"{tag}_dialog{asked}")
            t.keys("Enter" if approve == "yes" else "Escape")
            time.sleep(1.5)
            continue
        if until and any(e["event"] == until and mine(e) for e in events()[n0:]):
            break
        time.sleep(0.3)
    time.sleep(2)
    w = turn_word()
    if words[-1] != w:
        words.append(w)
    t.cap(f"{tag}_end")
    got = [brief(e) for e in events()[n0:]]
    results[tag] = {"events": got, "words": words}
    print(tag, "words:", words, flush=True)
    for g in got:
        print("   ", " ".join(x for x in g if x), flush=True)
    if mode == "turn" and expect is not None:
        ok = words[-1] == expect
        checks.append((tag, ok))
        print(f"{'PASS' if ok else 'FAIL'}  {tag} leaves {expect!r} (saw {words})", flush=True)


t = common.Tui(out, [binp, "--disable-client-telemetry", "--session-id", UID], work, env, size=(110, 40), keep=30)
try:
    t0 = time.time()
    while time.time() - t0 < 60:
        p = t.plain()
        if "trust" in p.lower() and "Yes" in p:
            t.cap("trust")
            t.keys("Enter")
            time.sleep(1)
        elif "❯" in p:
            break
        time.sleep(0.3)
    time.sleep(3)
    step("start", until=None, secs=1)
    step("prompt", "Reply with the word ONE.", expect="done")
    step("approve", 'STUB:CALL create {"path": "a.txt", "file_text": "hi\\n"}', approve="yes", expect="done")
    # Esc on the approval ends the turn without a hook (1.0.112): the record
    # keeps `decision` until the next prompt; the window retires it on the key.
    step("deny", 'STUB:CALL create {"path": "b.txt", "file_text": "hi\\n"}', approve="esc", secs=20,
         expect="decision")
    step("toolfail", 'STUB:CALL view {"path": "missing/nothing.txt"}', approve="yes", expect="done")
    step("modelfail", "STUB:FAIL 400", until="errorOccurred", secs=40, expect="done")
    # A status Copilot retries: does every attempt fire errorOccurred, and
    # does the last one say so (`recoverable`)?
    step("modelretry", "STUB:FAIL 500", until=None, secs=60, expect="done")
    ask = {"message": "Pick one?", "requestedSchema": {"type": "object", "properties": {
        "choice": {"type": "string", "enum": ["Alpha", "Beta"]}}, "required": ["choice"]}}
    step("ask", "STUB:CALL ask_user " + json.dumps(ask), approve="yes", dialog="Pick one?", secs=40, expect="done")
    step("subagent", 'STUB:CALL task ' + json.dumps({"name": "child", "description": "child", "prompt": "say hi",
                                                    "agent_type": "explore"}),
         approve="yes", secs=60, expect="done")
    # Copilot keeps the BYOK variables from its shell tool: the nested run
    # gets them on its own command line. The sleep keeps the session's own
    # turn running after the nested run ended: a `done` the nested run wrote
    # would show before the last word.
    byok = f"COPILOT_PROVIDER_BASE_URL=http://127.0.0.1:{port}/v1 COPILOT_PROVIDER_API_KEY=test COPILOT_MODEL=stub"
    nested = (f"env {byok} '{binp}' -p 'nested hi' --allow-all-tools --disable-client-telemetry; sleep 4; "
              "env > shellenv.txt")
    step("nested", "STUB:CALL bash " + json.dumps({"command": nested, "description": "nested"}),
         approve="yes", secs=120, expect="done")
    rec_after_nested = None
    try:
        rec_after_nested = open(os.path.join(live, UID)).read().strip()
    except OSError:
        pass
    print("session record after the nested run:", rec_after_nested)
    if mode == "turn":
        words = results["nested"]["words"]
        cut = words.index("working") if "working" in words else len(words)
        ok = rec_after_nested in (None, UID) and "done" not in words[cut:-1]
        checks.append(("nested", ok))
        print(f"{'PASS' if ok else 'FAIL'}  the nested run moves neither record ({rec_after_nested}, {words})")
    step("compact", "/compact", until="preCompact", secs=30)
    step("new", "/new", until="sessionStart", secs=20)
    step("after_new", "Reply with the word TWO.", expect="done")
    step("exit", "/exit", until="sessionEnd", secs=20, expect="idle")
finally:
    t.close()
    stub.terminate()
common.write_json(os.path.join(out, "result.json"), results)
if mode == "turn":
    sys.exit(0 if checks and all(ok for _, ok in checks) else 1)
