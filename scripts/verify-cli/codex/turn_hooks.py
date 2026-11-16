"""Codex: which hook events a turn fires, and what Codex does with a new one.

    python3 scripts/verify-cli/codex/turn_hooks.py <label> <bin> <port> [phase ...]

Offline: a private `CODEX_HOME`, a launch-only provider at `stub_openai.py`'s
Responses endpoint (`STUB:CALL <tool> <json>` forces the call no model would
make), a work folder that is its own git root and trusted in the config. Every
hook is a dumper (`NN-<event>.json` under each phase's `dump/`), never the
app's session hook. Output: tmp/verify-cli/codex/<label>/turn/<phase>/.

Phases (default: all, in this order):

  trusted   the five events the app registers today, trusted the way the
            app's `trust_codex_hooks` does (hashes from `codex_hook_hash`'s
            formula, reproduced here): one turn with an approval that is
            accepted. Proves the hashes, and is the baseline.
  added     the same home with a `PermissionRequest` block appended, untrusted:
            what the next start shows (a review menu?) and whether the new
            event fires.
  approve   `PermissionRequest` trusted too: an approval accepted, then one
            declined (Esc). What fires at the dialog, after each answer.
  extras    every event `--dangerously-bypass-hook-trust` (probe only): a
            subagent (`spawn_agent`, namespaced or not) and `/compact`, for what
            `SubagentStart`/`SubagentStop` and `PreCompact`/`PostCompact` carry.
  apierr    the same hooks, the provider pointed at a closed port, retries off:
            does a turn that fails on the API fire `Stop`?

The tab variables are unset (common.Tui).
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import common  # noqa: E402

CURRENT = ["SessionStart", "Stop", "UserPromptSubmit", "PostToolUse", "SessionEnd"]
EXTRA = ["PermissionRequest", "PreToolUse", "SubagentStart", "SubagentStop", "PreCompact", "PostCompact"]
# Codex's trust label per event, and whether a group's matcher is kept
# (agent_session::codex_event_label).
LABEL = {"SessionStart": ("session_start", True), "PostToolUse": ("post_tool_use", True),
         "SessionEnd": ("session_end", True), "UserPromptSubmit": ("user_prompt_submit", False),
         "Stop": ("stop", False), "PermissionRequest": ("permission_request", True)}
PHASES = ["trusted", "added", "approve", "extras", "apierr"]


def hook_hash(label, matcher, command, timeout):
    """agent_session::codex_hook_hash, in Python."""
    t = max(1, min(timeout or 1, 3)) if label == "session_end" else max(timeout or 600, 1)
    ident = {"event_name": label, "hooks": [{"async": False, "command": command, "timeout": t, "type": "command"}]}
    if matcher is not None:
        ident["matcher"] = matcher
    raw = json.dumps(ident, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "sha256:" + hashlib.sha256(raw.encode()).hexdigest()


def block(ev, cmd):
    matcher = "startup|resume|clear|compact" if ev == "SessionStart" else None
    timeout = 3 if ev == "SessionEnd" else 10
    m = f'matcher = "{matcher}"\n' if matcher else ""
    return f"[[hooks.{ev}]]\n{m}\n[[hooks.{ev}.hooks]]\ntype = \"command\"\ncommand = '{cmd}'\ntimeout = {timeout}\n\n", \
        (matcher, timeout)


def trust(config_path, ev, cmd, meta):
    label, keeps = LABEL[ev]
    matcher, timeout = meta
    h = hook_hash(label, matcher if keeps else None, cmd, timeout)
    return f'[hooks.state."{config_path}:{label}:0:0"]\ntrusted_hash = "{h}"\n\n'


class Home:
    def __init__(self, base, port):
        self.dir = os.path.join(base, "home")
        self.codex = os.path.join(self.dir, ".codex")
        self.work = os.path.join(self.dir, "work")
        if os.path.isdir(self.dir):
            shutil.rmtree(self.dir)
        os.makedirs(self.codex)
        os.makedirs(self.work)
        subprocess.run(["git", "init", "-q", self.work], check=True)
        self.config = os.path.join(self.codex, "config.toml")
        self.port = port

    def write(self, dump, events, trusted, port=None):
        os.makedirs(dump, exist_ok=True)
        hook = os.path.join(os.path.dirname(dump), "dump.sh")
        with open(hook, "w") as f:
            f.write(f"#!/bin/sh\nf=\"{dump}/$(date +%s%N).json\"; cat > \"$f\"\n")
        os.chmod(hook, 0o755)
        head = (f'model = "stub"\nmodel_provider = "stub"\napproval_policy = "on-request"\n'
                f'sandbox_mode = "read-only"\n\n'
                f'[model_providers.stub]\nname = "stub"\nbase_url = "http://127.0.0.1:{port or self.port}/v1"\n'
                f'env_key = "STUB_API_KEY"\nwire_api = "responses"\nrequires_openai_auth = false\n'
                f'supports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n\n'
                f'[projects."{self.work}"]\ntrust_level = "trusted"\n\n')
        body, state = "", ""
        for ev in events:
            text, meta = block(ev, hook)
            body += text
            if ev in trusted:
                state += trust(self.config, ev, hook, meta)
        with open(self.config, "w") as f:
            f.write(head + body + state)
        return hook

    def env(self):
        return common.scratch_env(self.dir, {"CODEX_HOME": self.codex, "STUB_API_KEY": "stub",
                                             "PATH": os.environ.get("PATH", "/usr/bin:/bin")})


def settle(t, secs=40):
    """Wait for the idle composer, answering what stands in the way, and
    return the screens met on the way."""
    seen = []
    t0 = time.time()
    while time.time() - t0 < secs:
        s = t.plain()
        if "Hooks need review" in s or "need review" in s.lower():
            seen.append("hooks-review")
            t.cap("hooks-review")
            return seen
        if "Trust this folder" in s or "Do you trust" in s:
            seen.append("folder-trust")
            t.keys("Enter")
        elif "? for shortcuts" in s or "for shortcuts" in s:
            return seen
        time.sleep(0.5)
    t.cap("settle-timeout")
    seen.append("timeout")
    return seen


def summarize(phase_dir, dump):
    rows = []
    for name in sorted(os.listdir(dump)):
        path = os.path.join(dump, name)
        try:
            v = json.load(open(path))
        except ValueError:
            continue
        ev = v.get("hook_event_name", "?")
        keys = sorted(k for k in v if k not in ("session_id", "transcript_path", "cwd", "hook_event_name"))
        extra = {k: v[k] for k in ("source", "reason", "tool_name", "trigger", "agent_type", "agent_id") if k in v}
        rows.append(f"{ev:18} sid={str(v.get('session_id'))[:8]} keys={keys} {json.dumps(extra)[:200]}")
        os.rename(path, os.path.join(dump, f"{len(rows):02d}-{ev}.json"))
    with open(os.path.join(phase_dir, "events.txt"), "w") as f:
        f.write("\n".join(rows) + "\n")
    return rows


def shell_call(tools, path):
    """A tool call that asks for an approval under `on-request`: the model
    asks to run it outside the sandbox."""
    esc = {"sandbox_permissions": "require_escalated", "justification": "probe"}
    if "exec_command" in tools:
        return f"STUB:CALL exec_command {json.dumps({'cmd': f'touch {path}', **esc})}"
    return f"STUB:CALL shell {json.dumps({'command': ['touch', path], **esc})}"


def offered(stub_log):
    tools = set()
    for line in open(stub_log):
        try:
            tools.update(t for t in json.loads(line).get("tools", []) if t)
        except ValueError:
            pass
    return tools


def turn(t, prompt, answers, wait=8):
    t.type(prompt)
    t.keys("Enter")
    time.sleep(wait)
    t.cap("dialog")
    for k in answers:
        t.keys(k)
        time.sleep(3)
    time.sleep(4)
    t.cap("after")


def main():
    if len(sys.argv) < 4:
        sys.exit(__doc__)
    label, binp, port = sys.argv[1], common.binary(sys.argv[2]), int(sys.argv[3])
    phases = sys.argv[4:] or PHASES
    base = common.out_dir("codex", label, "turn")
    log = os.path.join(base, "stub.jsonl")
    stub = common.start_stub("stub_openai.py", port, log)
    home = Home(base, port)
    argv = [binp, "--no-daemon"]
    try:
        # The tools Codex offers, from one plain turn (no hooks yet).
        home.write(os.path.join(base, "discover", "dump"), [], [])
        t = common.Tui(common.out_dir("codex", label, "turn", "discover"), argv, home.work, home.env(), size=(110, 36))
        try:
            settle(t)
            turn(t, "hello", [], wait=6)
        finally:
            t.close()
        tools = offered(log)
        print("tools:", sorted(tools))
        for phase in phases:
            pdir = common.out_dir("codex", label, "turn", phase)
            dump = os.path.join(pdir, "dump")
            if os.path.isdir(dump):
                shutil.rmtree(dump)
            args = list(argv)
            if phase == "trusted":
                home.write(dump, CURRENT, CURRENT)
            elif phase == "added":
                home.write(dump, CURRENT + ["PermissionRequest"], CURRENT)
            elif phase == "approve":
                home.write(dump, CURRENT + ["PermissionRequest"], CURRENT + ["PermissionRequest"])
            elif phase == "apierr":
                # Nothing listens on port 9: the turn's request fails.
                home.write(dump, CURRENT + EXTRA, [], port=9)
                args.append("--dangerously-bypass-hook-trust")
            else:
                home.write(dump, CURRENT + EXTRA, [])
                args.append("--dangerously-bypass-hook-trust")
            t = common.Tui(pdir, args, home.work, home.env(), size=(110, 36))
            try:
                seen = settle(t)
                # A review notice can draw a moment after the composer.
                time.sleep(4)
                t.cap("start")
                if "review" in t.plain().lower():
                    seen.append("hooks-review")
                print(f"== {phase}: start screens {seen}")
                if "hooks-review" in seen:
                    # Leave it unanswered (Esc), the way a user who ignores it would.
                    t.keys("Escape")
                    time.sleep(1.5)
                    t.cap("start-dismissed")
                    seen += settle(t)
                if phase == "apierr":
                    turn(t, "hello", [], wait=15)
                elif phase == "extras":
                    spawn = next((x for x in sorted(tools) if x.endswith("spawn_agent")), None)
                    if spawn:
                        arg = {"task_name": "probe", "message": "reply ok"}
                        turn(t, f"STUB:CALL {spawn} {json.dumps(arg)}", [], wait=15)
                    turn(t, "/compact", [], wait=10)
                else:
                    turn(t, shell_call(tools, f"{phase}-a.txt"), ["Enter"])
                    if phase == "approve":
                        turn(t, shell_call(tools, f"{phase}-b.txt"), ["Escape"])
                t.keys("C-c")
                time.sleep(0.5)
                t.keys("C-c")
                time.sleep(2)
            finally:
                t.close()
            for row in summarize(pdir, dump):
                print(row)
            shutil.copy(home.config, os.path.join(pdir, "config.after.toml"))
    finally:
        stub.terminate()


if __name__ == "__main__":
    main()
