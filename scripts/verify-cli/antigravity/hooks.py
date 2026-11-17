"""Antigravity's user hooks and the app's conversation hook, offline.

    python3 scripts/verify-cli/antigravity/hooks.py events <label> <bin> <port>
    python3 scripts/verify-cli/antigravity/hooks.py turns  <label> <bin> <port>
    python3 scripts/verify-cli/antigravity/hooks.py tabs   <label> <bin> <port>
    python3 scripts/verify-cli/antigravity/hooks.py format <label> <bin> <port>
    → tmp/verify-cli/antigravity/<label>/hooks-<mode>/ (frames, hook.log, live_sessions/)

The app's hook script is rebuilt on every run from
src-tauri/src/services/agent/antigravity_session/hook.sh, filled in the way
`antigravity_session::posix_script_in` fills it (the send hint replaced by a
mark the stub logs), and registered in the scratch home's
`.gemini/config/hooks.json` on the events `EVENTS` names, the way
`register_in_home` does, beside a user hook of every event that dumps its
stdin to `hook.log` (the tool events inside a `matcher` group: flat, they
never run). The tab variables get made-up values (a probe uid,
`TAB_AGENT=agy`, a project dir); the records go to `<home>/live_sessions`,
never the app's. Every step prints the session record and the turn record.

`turns`: the permission prompts on — a plain turn, a `run_command` waiting on
its approval and then approved (Enter), a second one refused (Esc), a turn
the stub fails with HTTP 500 (`STUB:FAIL`), a slow one (`STUB:SLOW`)
cancelled with Esc, and Ctrl+C. Prints which events each fired and the marks
the model's requests carried (the dumping and the app's SessionStart
injections).

`events`: one tab — a turn, an `agy -p` its shell tool runs (forced through
stub_gemini.py's `STUB:CALL run_command`), a subagent (`define_subagent` then
`invoke_subagent`), `/clear` and a turn, a relaunch with `--conversation <first>`
and one with `--continue`, each with a turn. Prints which events fired for
which conversation and what the record held after each step.

`tabs`: two tabs in one folder and home, a different prompt each, then each
relaunched with `--conversation <its record>` (what the resolver does): each
must show its own prompt.

`format`: one turn and one `env` through the shell tool — whether this release
parses the file, runs `PreInvocation` and sets `ANTIGRAVITY_AGENT` for the
commands its tools run. Run it on every kept baseline.
"""
import json
import os
import re
import shutil
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from agy import Agy, common  # noqa: E402

AGENT_DIR = os.path.join(common.ROOT, "src-tauri", "src", "services", "agent")
UIDS = ["11111111-2222-4333-8444-555555555555", "66666666-7777-4888-9999-aaaaaaaaaaaa"]
EVENTS = ["SessionStart", "PreInvocation", "PostInvocation", "Stop", "PreToolUse", "PostToolUse"]
TOOL_EVENTS = ("PreToolUse", "PostToolUse")
# What the dumping SessionStart hook and the app's hint inject: the stub logs
# each mark it finds in a model request.
MARK = "STUBMARK-USER-SESSIONSTART"
HINT_MARK = "STUBMARK-APP-HINT"


def sh_quote(s):
    return "'" + s.replace("'", "'\\''") + "'"


def hook_script(live):
    """hook.sh filled in as `antigravity_session::fill` does."""
    src = open(os.path.join(AGENT_DIR, "antigravity_session.rs")).read()
    proof = re.search(r'pub const PROOF: &str = "([^"]+)";', src)
    name = re.search(r'const HOOK_NAME: &str = concat!\(crate::app_slug!\(\), "([^"]+)"\);', src)
    events = re.search(r'const EVENTS: &\[&str\] = &\[([^\]]+)\];', src)
    if not (proof and name and events):
        sys.exit("antigravity/hooks.py: antigravity_session.rs changed shape — update hook_script()")
    body = open(os.path.join(AGENT_DIR, "antigravity_session", "hook.sh")).read()
    body = (body.replace("@DISPLAY@", common.DISPLAY).replace("@ENV@", common.ENV_PREFIX)
            .replace("@LIVE_DIR@", sh_quote(live)).replace("@PROOF@", sh_quote(proof.group(1)))
            # The hint the app fills in from agent_hint::HOOK_HINT, as a mark the stub logs.
            .replace("@HINT@", sh_quote(json.dumps({"injectSteps": [{"systemMessage": {"systemMessage": HINT_MARK}}]}))))
    return body, common.SLUG + name.group(1), re.findall(r'"([A-Za-z]+)"', events.group(1)), proof.group(1)


def app_entry(script, events):
    """The app's entry in hooks.json, as `antigravity_session::hook_entry` builds
    it: the event's name is the script's argument (1.5.2 and 1.5.3 send none)."""
    def handler(e):
        return {"type": "command", "command": f"{sh_quote(script)} {e}"}
    return {e: ([{"matcher": "*", "hooks": [handler(e)]}] if e in TOOL_EVENTS else [handler(e)]) for e in events}


def prepare(home):
    """The scratch home's hooks.json: the app's hook plus a dumping user hook."""
    live = os.path.join(home, "live_sessions")
    cfg = os.path.join(home, ".gemini", "config")
    os.makedirs(cfg, exist_ok=True)
    body, name, events, proof = hook_script(live)
    script = os.path.join(home, "app_agy_session.sh")
    with open(script, "w") as f:
        f.write(body)
    os.chmod(script, 0o755)
    dump = os.path.join(home, "dump.sh")
    with open(dump, "w") as f:
        f.write('#!/bin/sh\n{ printf "=== %s agent=%s\\n" "$1" "${ANTIGRAVITY_AGENT-}"; cat; echo; } >> "$HOME/hook.log"\n'
                # What a SessionStart hook injects: the stub logs the mark if it reaches the model.
                f'[ "$1" = SessionStart ] && printf \'%s\\n\' \'{{"injectSteps":[{{"systemMessage":{{"systemMessage":"{MARK}"}}}}]}}\'\n'
                'exit 0\n')
    os.chmod(dump, 0o755)
    # The tool events take handlers only inside a `matcher` group; flat ones
    # are ignored, which is why the first probes saw them "never fire".
    probe = {e: ([{"matcher": "*", "hooks": [{"type": "command", "command": f"{dump} {e}"}]}] if e in TOOL_EVENTS
                 else [{"type": "command", "command": f"{dump} {e}"}]) for e in EVENTS}
    hooks = {"userprobe": probe, name: app_entry(script, events)}
    common.write_json(os.path.join(cfg, "hooks.json"), hooks)
    return live, proof


class TabAgy(Agy):
    """Agy with the made-up tab variables of tab `uid` in its environment."""

    def __init__(self, label, name, port, binp, uid, args=(), home=None, ask=False):
        """`ask`: leave the permission prompts on (an approval wait to probe)."""
        self._uid = uid
        skip = [] if ask else ["--dangerously-skip-permissions"]
        super().__init__(label, name, port, binp, args=[*skip, *args], home=home, size=(100, 30))

    def __setattr__(self, key, value):
        if key == "env" and isinstance(value, dict):
            # A project tab: the app's SessionStart prints its hint (a mark here).
            value = {**value, common.ENV_PREFIX + "TAB_UID": self._uid, common.ENV_PREFIX + "TAB_AGENT": "agy",
                     common.ENV_PREFIX + "PROJECT_DIR": os.path.join(value.get("HOME", ""), "work")}
        super().__setattr__(key, value)

    def turn(self, text, secs=30):
        self.type(text)
        self.keys("Enter")
        ok = self.wait("stub answer done", secs)
        time.sleep(2)
        return ok


def record(live, uid):
    try:
        return open(os.path.join(live, uid)).read()
    except FileNotFoundError:
        return None


def events_since(home, start):
    """(event, conversation, has empty lastUserInput, ANTIGRAVITY_AGENT) from hook.log after byte `start`."""
    out = []
    try:
        text = open(os.path.join(home, "hook.log")).read()[start:]
    except FileNotFoundError:
        return out, 0
    for head, payload in re.findall(r"=== (\S+ agent=\S*)\n(\{.*?\})\n", text):
        try:
            d = json.loads(payload)
        except ValueError:
            continue
        extra = {k: (str(d[k])[:60] if k == "error" else d[k]) for k in ("terminationReason", "fullyIdle", "error") if k in d}
        if isinstance(d.get("toolCall"), dict):
            extra["tool"] = d["toolCall"].get("name")
        out.append((head, d.get("conversationId", "?")[:8], d.get("lastUserInput") == "", d.get("parentConversationId"),
                     json.dumps(extra, sort_keys=True)))
    return out, len(text)


def log_size(home):
    try:
        return os.path.getsize(os.path.join(home, "hook.log"))
    except FileNotFoundError:
        return 0


def step(home, live, uid, start, what):
    evs, _ = events_since(home, start)
    rec = record(live, uid)
    turn_rec = record(live, uid + ".turn")
    print(f"--- {what}: record={rec[:8] if rec else None} turn={turn_rec.split()[0] if turn_rec else None}")
    runs = []
    for e in evs:
        if runs and runs[-1][0] == e:
            runs[-1][1] += 1
        else:
            runs.append([e, 1])
    for (head, conv, empty, parent, extra), n in runs:
        print(f"    {head:<26} conv={conv} emptyInput={empty} parent={parent} {extra}" + (f" x{n}" if n > 1 else ""))
    return log_size(home), rec


def main_events(label, binp, port):
    shutil.rmtree(common.out_dir("antigravity", label, "hooks-events"), ignore_errors=True)
    home = common.out_dir("antigravity", label, "hooks-events", "h")
    live, proof = prepare(home)
    uid = UIDS[0]
    r = TabAgy(label, "hooks-events", port, binp, uid, home=home)
    pos = 0
    try:
        r.first_run()
        r.wait("? for shortcuts")
        time.sleep(2)
        print("turn", r.turn("first conversation turn"))
        pos, first = step(home, live, uid, pos, "fresh TUI, one turn")
        cmd = json.dumps({"CommandLine": f"{binp} -p 'nested hello' > nested.out 2>&1; echo rc=$?",
                          "toolSummary": "Nested run", "WaitMsBeforeAsync": 10000})
        print("turn", r.turn(f"STUB:CALL run_command {cmd}", 60))
        pos, _ = step(home, live, uid, pos, "agy -p from the shell tool")
        d = json.dumps({"Name": "probe", "Description": "Probe helper", "SystemPrompt": "Say hi."})
        print("turn", r.turn(f"STUB:CALL define_subagent {d}"))
        s = json.dumps({"TypeName": "probe", "Role": "Probe helper", "Prompt": "say hi"})
        r.type(f"STUB:CALL invoke_subagent {s}")
        r.keys("Enter")
        time.sleep(20)
        r.cap("after_subagent")
        pos, _ = step(home, live, uid, pos, "a subagent")
        r.type("/clear")
        r.keys("Enter")
        time.sleep(2)
        print("turn", r.turn("second conversation turn"))
        pos, second = step(home, live, uid, pos, "/clear, one turn")
    finally:
        r.close()
    time.sleep(1)
    for tag, args in (("--conversation <first>", ["--conversation", first or "none"]), ("--continue", ["--continue"])):
        x = TabAgy(label, "hooks-events-r", port + 1, binp, uid, args=args, home=home)
        try:
            time.sleep(6)
            print("turn", x.turn(f"relaunch turn {tag}"))
            pos, _ = step(home, live, uid, pos, f"relaunch {tag}, one turn")
        finally:
            x.close()
        time.sleep(1)
    print("proof", os.path.isfile(os.path.join(live, proof)), "| first", first, "| second", second)
    print("files in live_sessions", sorted(os.listdir(live)) if os.path.isdir(live) else None)


def stub_marks(r):
    """The marks the stub saw in model requests (what hooks injected)."""
    try:
        lines = [json.loads(ln) for ln in open(os.path.join(r.out, "stub.jsonl")) if ln.startswith("{")]
    except FileNotFoundError:
        return []
    return sorted({m for ln in lines for m in ln.get("marks", [])})


def main_turns(label, binp, port):
    """Each turn ending and the approval wait, with the permission prompts on."""
    shutil.rmtree(common.out_dir("antigravity", label, "hooks-turns"), ignore_errors=True)
    home = common.out_dir("antigravity", label, "hooks-turns", "h")
    live, _ = prepare(home)
    uid = UIDS[0]
    r = TabAgy(label, "hooks-turns", port, binp, uid, home=home, ask=True)
    pos = 0
    try:
        r.first_run()
        r.wait("? for shortcuts")
        time.sleep(2)
        print("turn", r.turn("plain turn"))
        pos, _ = step(home, live, uid, pos, "a turn, no tool")
        cmd = json.dumps({"CommandLine": "echo approved > approved.out", "toolSummary": "Approval probe",
                          "WaitMsBeforeAsync": 5000})
        r.type(f"STUB:CALL run_command {cmd}")
        r.keys("Enter")
        time.sleep(8)
        r.cap("approval")
        print(r.plain())
        pos, _ = step(home, live, uid, pos, "a run_command waiting on its approval")
        r.keys("Enter")
        r.wait("stub answer done", 30)
        time.sleep(3)
        r.cap("approved")
        print("approved command ran:", os.path.exists(os.path.join(r.work, "approved.out")))
        pos, _ = step(home, live, uid, pos, "the approval answered (Enter)")
        cmd = json.dumps({"CommandLine": "echo denied > denied.out", "toolSummary": "Denial probe",
                          "WaitMsBeforeAsync": 5000})
        r.type(f"STUB:CALL run_command {cmd}")
        r.keys("Enter")
        time.sleep(8)
        pos, _ = step(home, live, uid, pos, "a second approval wait")
        r.keys("Escape")
        time.sleep(6)
        r.cap("denied")
        print("denied command ran:", os.path.exists(os.path.join(r.work, "denied.out")))
        pos, _ = step(home, live, uid, pos, "the approval refused (Esc)")
        r.type("STUB:FAIL turn")
        r.keys("Enter")
        time.sleep(30)
        r.cap("failed")
        pos, _ = step(home, live, uid, pos, "a turn the model endpoint fails (HTTP 500)")
        r.type("STUB:SLOW 25 turn")
        r.keys("Enter")
        time.sleep(5)
        r.keys("Escape")
        time.sleep(6)
        r.cap("canceled")
        pos, _ = step(home, live, uid, pos, "a slow turn canceled with Esc")
        r.keys("C-c")
        time.sleep(1)
        r.keys("C-c")
        time.sleep(4)
        r.cap("quit")
        pos, _ = step(home, live, uid, pos, "Ctrl+C twice")
    finally:
        r.close()
    print("marks the model saw:", stub_marks(r))


def main_tabs(label, binp, port):
    home = common.out_dir("antigravity", label, "hooks-tabs", "h")
    live, _ = prepare(home)
    for i, uid in enumerate(UIDS):
        t = TabAgy(label, f"hooks-tab{i}", port + i, binp, uid, home=home)
        try:
            if i == 0:
                t.first_run()
            t.wait("? for shortcuts")
            time.sleep(2)
            print(f"tab {i} turn", t.turn(f"prompt of tab {i}"))
        finally:
            t.close()
        time.sleep(1)
    recs = [record(live, uid) for uid in UIDS]
    print("records", recs, "distinct", len(set(recs)) == len(recs) and None not in recs)
    for i, uid in enumerate(UIDS):
        t = TabAgy(label, f"hooks-tab{i}-back", port + 10 + i, binp, uid, args=["--conversation", recs[i] or "none"], home=home)
        try:
            time.sleep(6)
            t.cap("back")
            p = t.plain()
            print(f"tab {i} back on its own:", f"prompt of tab {i}" in p, "| sibling's shown:", f"prompt of tab {1 - i}" in p)
        finally:
            t.close()
        time.sleep(1)


def main_format(label, binp, port):
    shutil.rmtree(common.out_dir("antigravity", label, "hooks-format"), ignore_errors=True)
    home = common.out_dir("antigravity", label, "hooks-format", "h")
    live, proof = prepare(home)
    uid = UIDS[0]
    r = TabAgy(label, "hooks-format", port, binp, uid, home=home)
    try:
        r.first_run()
        r.wait("? for shortcuts")
        time.sleep(2)
        print("turn", r.turn("format turn"))
        cmd = json.dumps({"CommandLine": "env > tool.env", "toolSummary": "Env dump", "WaitMsBeforeAsync": 5000})
        print("tool turn", r.turn(f"STUB:CALL run_command {cmd}", 40))
        r.cap("after")
    finally:
        r.close()
    evs, _ = events_since(home, 0)
    names = sorted({e[0].split()[0] for e in evs})
    tool_env = os.path.join(r.work, "tool.env")
    marker = None
    if os.path.exists(tool_env):
        marker = [ln.strip() for ln in open(tool_env) if ln.startswith("ANTIGRAVITY_AGENT=")]
    print(label, "events", names, "| record", record(live, uid), "| turn", record(live, uid + ".turn"),
          "| proof", os.path.isfile(os.path.join(live, proof)), "| tool ANTIGRAVITY_AGENT", marker,
          "| marks", stub_marks(r))


if __name__ == "__main__":
    mode, label, binp, port = sys.argv[1], sys.argv[2], common.binary(sys.argv[3]), int(sys.argv[4])
    {"events": main_events, "turns": main_turns, "tabs": main_tabs, "format": main_format}[mode](label, binp, port)
