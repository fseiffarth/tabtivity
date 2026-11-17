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
         "tui_deny", "tui_elicit", "tui_interrupt", "tui_err"]
BASH = lambda cmd: json.dumps({"command": cmd, "description": "probe"})  # noqa: E731

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
            time.sleep(1)
            rows = summarize(out, dump)
            print(f"== {case}")
            print("\n".join(rows))
    finally:
        stub.terminate()


if __name__ == "__main__":
    main()
