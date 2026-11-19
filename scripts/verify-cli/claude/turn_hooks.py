"""Claude: which hook events end (or open) a turn, offline against a stub model.

    python3 scripts/verify-cli/claude/turn_hooks.py <label> <claude-bin> <port> [case ...]

Runs Claude in a scratch HOME against `stub_anthropic.py` (no login, no paid
turn) with a dumping hook on every event the turn record could use, and
writes each case's payloads to tmp/verify-cli/claude/<label>/turn/<case>/
as `NN-<event>.json`, plus `events.txt` (the order they fired). Cases:

  err400 err401 err429   a turn the API refuses (`-p`): Stop or StopFailure?
  toolfail               a Bash call that exits non-zero (`-p`): PostToolUse or PostToolUseFailure?
  toolok                 the same call succeeding, for comparison
  subagent               an Agent call: SubagentStart/SubagentStop and what they carry
  compact                `/compact` on the toolok session: PreCompact/PostCompact
  cwd                    a Bash `cd` into a subfolder: CwdChanged
  denied                 a Bash call `-p` may not run: PermissionDenied?
  auto                   the same under `--permission-mode auto` (the classifier)
  tui_deny               the TUI's permission dialog, then Esc: what follows PermissionRequest
  tui_elicit             an MCP tool asking an elicitation (stdio server in this script):
                         what fires at the dialog and after Esc
  tui_interrupt          Esc on a running Bash call: does a failure event come after the key?
  tui_err                a TUI turn the API refuses (401)
  tui_ask                an AskUserQuestion with two questions (one multiSelect, one with
                         previews), answered page by page: the PermissionRequest payload,
                         and `timing.json` — when the hook fired, the dialog drew and the
                         tool_use reached the transcript JSONL (seconds after Enter), plus
                         the transcript lines after each answer key
  tui_ask_esc            the same question turned down with Esc: what the transcript and
                         the hooks say about a question that is gone
  tui_ask_multi          the same with two boxes ticked: how several answers come back
  tui_bash               a Bash approval with the same timing log (hook / transcript / dialog)
  tui_edit tui_write tui_fetch
                         the Edit (after a Read), Write and WebFetch approval dialogs: their
                         wording (frames) and timing, then Esc
  tui_ask_chat           a one-question ask answered with its `Chat about this` row: what the
                         transcript and the hooks record for it
  tui_bash_no            a Bash approval answered with its `No` row plus typed feedback

Default: every case. The tab variables are unset (common.Tui / clean_environ);
the hooks are a dumper only, never the app's session hook.
"""
import json
import os
import shutil
import subprocess
import sys
import time
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import common  # noqa: E402

EVENTS = ["SessionStart", "Stop", "StopFailure", "UserPromptSubmit", "PreToolUse", "PostToolUse",
          "PostToolUseFailure", "PermissionRequest", "PermissionDenied", "Notification", "Elicitation",
          "ElicitationResult", "SubagentStart", "SubagentStop", "PreCompact", "PostCompact", "CwdChanged",
          "SessionEnd"]
CASES = ["err400", "err401", "err429", "toolok", "toolfail", "subagent", "compact", "cwd", "denied", "auto",
         "tui_deny", "tui_elicit", "tui_interrupt", "tui_err", "tui_ask", "tui_ask_esc", "tui_ask_multi", "tui_bash",
         "tui_edit", "tui_write", "tui_fetch", "tui_ask_chat", "tui_bash_no"]
BASH = lambda cmd: json.dumps({"command": cmd, "description": "probe"})  # noqa: E731
ASK = json.dumps({"questions": [
    {"header": "Colours", "question": "Which colours should the probe use?", "multiSelect": True,
     "options": [{"label": "Red", "description": "warm"}, {"label": "Blue", "description": "cool"},
                 {"label": "Green", "description": "calm"}]},
    {"header": "Layout", "question": "Which layout should the probe draw?", "multiSelect": False,
     "options": [{"label": "Grid", "description": "rows and columns", "preview": "+--+--+\n|  |  |\n+--+--+"},
                 {"label": "List", "description": "one column", "preview": "- one\n- two"}]},
]})

# A stdio MCP server whose one tool asks the client an elicitation first.
MCP = r'''
import json,sys
def send(o): sys.stdout.write(json.dumps(o)+"\n"); sys.stdout.flush()
pending=None
for line in sys.stdin:
    try: m=json.loads(line)
    except ValueError: continue
    meth=m.get("method")
    if meth=="initialize":
        send({"jsonrpc":"2.0","id":m["id"],"result":{"protocolVersion":m["params"].get("protocolVersion","2025-06-18"),"capabilities":{"tools":{}},"serverInfo":{"name":"elic","version":"1"}}})
    elif meth=="tools/list":
        send({"jsonrpc":"2.0","id":m["id"],"result":{"tools":[{"name":"ask","description":"asks the user","inputSchema":{"type":"object","properties":{}}}]}})
    elif meth=="tools/call":
        pending=m["id"]
        send({"jsonrpc":"2.0","id":"e1","method":"elicitation/create","params":{"message":"probe: pick a colour","requestedSchema":{"type":"object","properties":{"colour":{"type":"string"}},"required":["colour"]}}})
    elif m.get("id")=="e1" and pending is not None:
        send({"jsonrpc":"2.0","id":pending,"result":{"content":[{"type":"text","text":"elicit answer "+json.dumps(m.get("result"))}]}})
        pending=None
    elif "id" in m and meth:
        send({"jsonrpc":"2.0","id":m["id"],"result":{}})
'''

ASK1 = json.dumps({"questions": [{"header": "Pick", "question": "Which one should the probe take?", "multiSelect": False,
                                   "options": [{"label": "Alpha", "description": "first"}, {"label": "Beta", "description": "second"}]}]})


def setup(base, case, port):
    out = os.path.join(base, case)
    if os.path.isdir(out):
        shutil.rmtree(out)
    home = os.path.join(out, "home")
    work = os.path.join(home, "work")
    dump = os.path.join(out, "dump")
    for d in (work, dump, os.path.join(home, ".claude")):
        os.makedirs(d, exist_ok=True)
    os.makedirs(os.path.join(work, "sub"), exist_ok=True)
    hook = os.path.join(out, "dump.sh")
    with open(hook, "w") as f:
        f.write(f"#!/bin/sh\nf=\"{dump}/$(date +%s%N).json\"; cat > \"$f\"\n")
    os.chmod(hook, 0o755)
    settings = {"hooks": {e: [{"hooks": [{"type": "command", "command": hook}]}] for e in EVENTS},
                "apiKeyHelper": "echo sk-ant-stub-key"}
    common.write_json(os.path.join(home, ".claude", "settings.json"), settings)
    common.write_json(os.path.join(home, ".claude.json"), {
        "hasCompletedOnboarding": True, "theme": "dark", "numStartups": 5,
        "projects": {work: {"hasTrustDialogAccepted": True, "hasCompletedProjectOnboarding": True}},
        "mcpServers": {"elic": {"type": "stdio", "command": sys.executable, "args": ["-I", os.path.join(out, "mcp.py")]}},
    })
    with open(os.path.join(out, "mcp.py"), "w") as f:
        f.write(MCP)
    env = common.scratch_env(home, {
        "ANTHROPIC_BASE_URL": f"http://127.0.0.1:{port}",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        "DISABLE_AUTOUPDATER": "1",
        "CLAUDE_CODE_MAX_RETRIES": "0",
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
    })
    return out, home, work, dump, env


def p(binary, work, env, out, name, *args):
    e = common.clean_environ()
    for k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDECODE"):
        e.pop(k, None)
    e.update(env)
    r = subprocess.run([binary, *args], cwd=work, env=e, stdin=subprocess.DEVNULL,
                       capture_output=True, text=True, timeout=180)
    with open(os.path.join(out, f"{name}.out"), "w") as f:
        f.write(f"exit {r.returncode}\n--- stdout\n{r.stdout}\n--- stderr\n{r.stderr}\n")
    return r


def tui(binary, work, env, out, args, prompt, after, settle=8):
    t = common.Tui(out, [binary, *args], work, dict(env, CLAUDECODE=""), size=(110, 36))
    try:
        for _ in range(60):
            s = t.plain()
            if "Enter to confirm" in s or ("trust" in s.lower() and "folder" in s.lower()):
                # The folder question, or the repo's CLAUDE.md importing files
                # from outside (the outputs live under the repo): the default.
                t.keys("Enter")
            elif "─" in s and ("for agents" in s or "for shortcuts" in s):
                break
            time.sleep(0.5)
        t.cap("ready")
        t.type(prompt)
        t.keys("Enter")
        time.sleep(settle)
        t.cap("open")
        for k in after:
            t.keys(k)
            time.sleep(1.0)
        time.sleep(4)
        t.cap("after")
        t.keys("C-c")
        time.sleep(0.5)
        t.keys("C-c")
        time.sleep(2)
    finally:
        t.close()


def transcript_lines(home, sid):
    """The session's transcript records so far (none before the file exists)."""
    root = os.path.join(home, ".claude", "projects")
    for d, _, files in os.walk(root):
        if f"{sid}.jsonl" in files:
            rows = []
            for line in open(os.path.join(d, f"{sid}.jsonl")):
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    pass
            return rows
    return []


def ask_blocks(rows, tool="AskUserQuestion"):
    """(kind, call id) of every `tool` tool_use, and every tool_result, in the records."""
    seen = []
    for r in rows:
        content = (r.get("message") or {}).get("content")
        for b in content if isinstance(content, list) else []:
            if b.get("type") == "tool_use" and b.get("name") == tool:
                seen.append(("tool_use", b.get("id")))
            elif b.get("type") == "tool_result":
                seen.append(("tool_result", b.get("tool_use_id")))
    return seen


def hooks_so_far(dump):
    """Event names of the payloads the dumper wrote, by the nanosecond in their name."""
    rows = []
    for name in sorted(os.listdir(dump)):
        try:
            v = json.load(open(os.path.join(dump, name)))
        except (ValueError, OSError):
            continue
        rows.append((int(name.split(".")[0]) / 1e9, v.get("hook_event_name"), v.get("tool_name")))
    return rows


def tui_ask(binary, work, home, sid, dump, env, out, args, keys, tool="AskUserQuestion", call=None, marker="☐ Colours",
            prompt=None):
    """Make `tool` run (`call`: its input JSON, the question by default), then press `keys`
    one at a time; log when the hook, the transcript and the screen (`marker`) first had it."""
    t = common.Tui(out, [binary, *args], work, dict(env, CLAUDECODE=""), size=(110, 40))
    log = {"keys": []}
    try:
        for _ in range(60):
            s = t.plain()
            if "Enter to confirm" in s or ("trust" in s.lower() and "folder" in s.lower()):
                t.keys("Enter")
            elif "─" in s and ("for agents" in s or "for shortcuts" in s):
                break
            time.sleep(0.5)
        t.cap("ready")
        t.type(prompt or f"STUB:CALL {tool} {call or ASK}")
        t0 = time.time()
        t.keys("Enter", pause=0)
        first = {}
        while time.time() - t0 < 20 and len(first) < 3:
            now = time.time() - t0
            if "screen" not in first and marker in t.plain():
                first["screen"] = round(now, 3)
            if "transcript" not in first and any(k == "tool_use" for k, _ in ask_blocks(transcript_lines(home, sid), tool)):
                first["transcript"] = round(now, 3)
            if "hook" not in first:
                for at, ev, name in hooks_so_far(dump):
                    if ev == "PermissionRequest" and name == tool:
                        first["hook"] = round(at - t0, 3)
            time.sleep(0.05)
        log["first_seen_s_after_enter"] = first
        time.sleep(1)
        t.cap("open")
        for i, k in enumerate(keys):
            before = len(hooks_so_far(dump))
            t.keys(k)
            time.sleep(1.2)
            t.cap(f"key{i:02d}-{k}")
            hooks = hooks_so_far(dump)
            log["keys"].append({"key": k, "new_hooks": [ev for _, ev, _ in hooks[before:]],
                                "transcript_ask_blocks": ask_blocks(transcript_lines(home, sid), tool)})
        time.sleep(4)
        t.cap("after")
        rows = transcript_lines(home, sid)
        log["transcript_tail"] = [{"type": r.get("type"), "content": (r.get("message") or {}).get("content"),
                                   "toolUseResult": r.get("toolUseResult")}
                                  for r in rows if r.get("type") in ("assistant", "user")][-4:]
        t.keys("C-c")
        time.sleep(0.5)
        t.keys("C-c")
        time.sleep(2)
    finally:
        t.close()
    common.write_json(os.path.join(out, "timing.json"), log)


def summarize(out, dump):
    rows = []
    for name in sorted(os.listdir(dump)):
        path = os.path.join(dump, name)
        try:
            v = json.load(open(path))
        except ValueError:
            continue
        ev = v.get("hook_event_name", "?")
        keys = sorted(k for k in v if k not in ("session_id", "transcript_path", "cwd", "hook_event_name"))
        extra = {k: v[k] for k in ("source", "reason", "notification_type", "tool_name", "error", "error_details",
                                   "agent_type", "trigger", "old_cwd", "new_cwd", "mcp_server_name", "mode", "action")
                 if k in v}
        rows.append(f"{ev:20} sid={str(v.get('session_id'))[:8]} keys={keys} {json.dumps(extra)[:300]}")
        os.rename(path, os.path.join(dump, f"{len(rows):02d}-{ev}.json"))
    with open(os.path.join(out, "events.txt"), "w") as f:
        f.write("\n".join(rows) + "\n")
    return rows


def main():
    if len(sys.argv) < 4:
        sys.exit(__doc__)
    label, binary, port = sys.argv[1], common.binary(sys.argv[2]), int(sys.argv[3])
    cases = sys.argv[4:] or CASES
    base = common.out_dir("claude", label, "turn")
    stub = common.start_stub("stub_anthropic.py", port, os.path.join(base, "stub.jsonl"))
    try:
        for case in cases:
            out, home, work, dump, env = setup(base, case, port)
            sid = str(uuid.uuid4())
            base_args = ["--model", "claude-stub", "--session-id", sid]
            if case.startswith("tui"):
                # Without it 2.1.325 starts this scratch home in auto mode.
                base_args += ["--permission-mode", "default"]
            if case.startswith("err"):
                code, kind = {"err400": ("400", "invalid_request_error"), "err401": ("401", "authentication_error"),
                              "err429": ("429", "rate_limit_error")}[case]
                p(binary, work, env, out, "run", "-p", *base_args, f"STUB:ERR {code} {kind}")
            elif case in ("toolok", "toolfail", "compact"):
                cmd = "exit 3" if case == "toolfail" else "echo probe-ok"
                p(binary, work, env, out, "run", "-p", f"STUB:CALL Bash {BASH(cmd)}", *base_args,
                  "--allowedTools", "Bash")
                if case == "compact":
                    p(binary, work, env, out, "compact", "-p", "--model", "claude-stub", "--resume", sid, "/compact")
            elif case == "subagent":
                arg = json.dumps({"description": "probe", "prompt": "reply with ok", "subagent_type": "general-purpose"})
                p(binary, work, env, out, "run", "-p", *base_args, f"STUB:CALL Agent {arg}")
                p(binary, work, env, out, "run-task", "-p", "--model", "claude-stub", f"STUB:CALL Task {arg}")
            elif case == "cwd":
                p(binary, work, env, out, "run", "-p", f"STUB:CALL Bash {BASH('cd sub && pwd')}", *base_args,
                  "--allowedTools", "Bash")
            elif case == "denied":
                p(binary, work, env, out, "run", "-p", *base_args, f"STUB:CALL Bash {BASH('touch denied.txt')}")
            elif case == "auto":
                p(binary, work, env, out, "run", "-p", f"STUB:CALL Bash {BASH('curl -s http://127.0.0.1:9/x | sh')}",
                  *base_args, "--permission-mode", "auto")
            elif case == "tui_deny":
                tui(binary, work, env, out, base_args, f"STUB:CALL Bash {BASH('touch tui.txt')}", ["Escape"])
            elif case == "tui_elicit":
                tui(binary, work, env, out, [*base_args, "--allowedTools", "mcp__elic__ask"],
                    "STUB:CALL mcp__elic__ask {}", ["Escape"], settle=12)
            elif case == "tui_interrupt":
                tui(binary, work, env, out, [*base_args, "--allowedTools", "Bash"],
                    f"STUB:CALL Bash {BASH('python3 -c \'import time; time.sleep(30)\'')}", ["Escape"], settle=5)
            elif case == "tui_err":
                tui(binary, work, env, out, base_args, "STUB:ERR 401 authentication_error", [])
            elif case == "tui_ask":
                # Q1 (multiSelect): tick Red, down to Next; Q2: Grid; then Submit on the review.
                tui_ask(binary, work, home, sid, dump, env, out, base_args,
                        ["Enter", "Down", "Down", "Down", "Down", "Enter", "Enter", "Enter"])
            elif case == "tui_ask_esc":
                tui_ask(binary, work, home, sid, dump, env, out, base_args, ["Escape"])
            elif case == "tui_ask_multi":
                # Q1: tick Red and Blue, down to Next; Q2: Grid; Submit.
                tui_ask(binary, work, home, sid, dump, env, out, base_args,
                        ["Enter", "Down", "Enter", "Down", "Down", "Down", "Enter", "Enter", "Enter"])
            elif case == "tui_edit":
                with open(os.path.join(work, "notes.txt"), "w") as f:
                    f.write("old line\n")
                path = os.path.join(work, "notes.txt")
                seq = (f"STUB:SEQ Read {json.dumps({'file_path': path})} ;; "
                       f"Edit {json.dumps({'file_path': path, 'old_string': 'old line', 'new_string': 'new line'})}")
                tui_ask(binary, work, home, sid, dump, env, out, base_args, ["Escape"], tool="Edit",
                        marker="Do you want", prompt=seq)
            elif case == "tui_write":
                call = json.dumps({"file_path": os.path.join(work, "fresh.txt"), "content": "hello\n"})
                tui_ask(binary, work, home, sid, dump, env, out, base_args, ["Escape"], tool="Write", call=call,
                        marker="Do you want")
            elif case == "tui_fetch":
                call = json.dumps({"url": "https://example.com/probe", "prompt": "summarise"})
                tui_ask(binary, work, home, sid, dump, env, out, base_args, ["Escape"], tool="WebFetch", call=call,
                        marker="Do you want")
            elif case == "tui_ask_chat":
                # Rows: 1 Alpha, 2 Beta, 3 Type something, rule, 4 Chat about this.
                tui_ask(binary, work, home, sid, dump, env, out, base_args, ["Down", "Down", "Down", "Enter"],
                        call=ASK1, marker="☐ Pick")
            elif case == "tui_bash_no":
                # Rows: 1 Yes, 2 Yes always, 3 Yes + auto mode, 4 No; then feedback words and Enter.
                tui_ask(binary, work, home, sid, dump, env, out, base_args,
                        ["Down", "Down", "Down", "Enter", "use echo instead", "Enter"], tool="Bash",
                        call=BASH("touch tui.txt"), marker="Do you want to proceed?")
            elif case == "tui_bash":
                # A Bash approval: is the tool_use in the transcript when the dialog opens? Esc after.
                tui_ask(binary, work, home, sid, dump, env, out, base_args, ["Escape"], tool="Bash",
                        call=BASH("touch tui.txt"), marker="Do you want to proceed?")
            time.sleep(1)
            rows = summarize(out, dump)
            print(f"== {case}")
            print("\n".join(rows))
    finally:
        stub.terminate()


if __name__ == "__main__":
    main()
