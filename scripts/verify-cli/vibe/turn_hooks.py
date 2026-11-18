"""Mistral Vibe: which of its hook types the TUI fires, and what they carry.

    python3 scripts/verify-cli/vibe/turn_hooks.py <label> <vibe-bin> <port> [apierr]

Offline: a scratch HOME whose `~/.vibe` (`VIBE_HOME`) holds a provider at
`stub_openai.py`'s chat completions (`STUB:CALL <tool> <json>` forces a tool
call) and a `hooks.toml` with a dumping hook of every type Vibe 3.1 knows
(`post_agent`, `pre_agent`, `pre_tool`, `post_tool`, `notification`,
`session_start`, `session_end`; from 3.1.3 also `pre_llm`, `post_llm`). One TUI session: a plain prompt, a prompt
whose bash call waits on an approval (accepted), the same declined (Esc), then
`/clear` and one more prompt, a `vibe -p` run from the bash tool (accepted),
then `/exit`. Payloads go to
tmp/verify-cli/vibe/<label>/turn/dump/ as `NN-<type>.json` with the `cap`
frames beside them, and each hook's `VIBE*` environment as `NN-<type>.env`;
`events.txt` lists the order with the step each came in.

`apierr` points the provider at a closed port and sends one prompt: does a
turn the API refuses fire `post_agent`?

The tab variables are unset (common.Tui); the hooks are a dumper only, never
the app's session hook.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import common  # noqa: E402

TYPES = ["post_agent", "pre_agent", "pre_tool", "post_tool", "notification", "session_start", "session_end"]
# Since 3.1.3: before each model call and after each response (tool calls included).
LLM_TYPES = ["pre_llm", "post_llm"]


def hook_types(binp, home):
    """Every type the binary knows: an older one is not handed the 3.1.3 types."""
    out = subprocess.run([binp, "--version"], env=common.clean_environ(common.scratch_env(home)), capture_output=True, text=True).stdout
    found = re.search(r"(\d+)\.(\d+)\.(\d+)", out)
    return TYPES + LLM_TYPES if found and tuple(map(int, found.groups())) >= (3, 1, 3) else TYPES


def main():
    if len(sys.argv) not in (4, 5):
        sys.exit(__doc__)
    label, binp, port = sys.argv[1], common.binary(sys.argv[2]), int(sys.argv[3])
    apierr = sys.argv[4:] == ["apierr"]
    out = common.out_dir("vibe", label, "turn")
    if os.path.isdir(os.path.join(out, "dump")):
        shutil.rmtree(os.path.join(out, "dump"))
    # A fresh home per run: Vibe leaves read-only files in its plugin cache.
    home, dump = os.path.join(out, f"home-{int(time.time())}"), os.path.join(out, "dump")
    vibe, work = os.path.join(home, ".vibe"), os.path.join(home, "work")
    for d in (vibe, work, dump):
        os.makedirs(d)
    step = os.path.join(out, "step")
    hook = os.path.join(out, "dump.sh")
    with open(hook, "w") as f:
        # The payload, named by time and the probe step it came in.
        f.write(f"#!/bin/sh\nf=\"{dump}/$(date +%s%N)-$(cat {step} 2>/dev/null)\"; cat > \"$f.json\"\n"
                "env | grep -E '^VIBE' | sort > \"$f.env\"\n")
    os.chmod(hook, 0o755)
    with open(os.path.join(vibe, "config.toml"), "w") as f:
        f.write(f'active_model = "stub"\n\n[[providers]]\nname = "stub"\napi_base = "http://127.0.0.1:{9 if apierr else port}/v1"\n'
                'api_key_env_var = ""\napi_style = "openai"\nbackend = "generic"\n\n'
                '[[models]]\nname = "stub"\nprovider = "stub"\nalias = "stub"\ntemperature = 0.2\n'
                'input_price = 0.0\noutput_price = 0.0\n')
    with open(os.path.join(vibe, "hooks.toml"), "w") as f:
        for t in hook_types(binp, home):
            f.write(f'[[hooks]]\nname = "dump-{t}"\ntype = "{t}"\ncommand = "{hook}"\ntimeout = 10.0\n\n')
    env = common.scratch_env(home, {"VIBE_HOME": vibe, "PATH": os.environ.get("PATH", "/usr/bin:/bin")})
    stub = common.start_stub("stub_openai.py", port, os.path.join(out, "stub.jsonl"))
    t = common.Tui(out, [binp], work, env, size=(110, 36))

    def mark(name):
        with open(step, "w") as f:
            f.write(name)

    def prompt(name, text, answers=(), wait=8):
        mark(name)
        t.type(text)
        t.keys("Enter")
        time.sleep(wait)
        t.cap(f"{name}-open")
        for k in answers:
            t.keys(k)
            time.sleep(3)
        time.sleep(3)
        t.cap(f"{name}-after")

    try:
        mark("start")
        for _ in range(60):
            s = t.plain()
            if "trust" in s.lower() and ("folder" in s.lower() or "directory" in s.lower()):
                t.keys("Enter")
            time.sleep(0.5)
            if ">" in s and "─" in s and "trust" not in s.lower():
                break
        time.sleep(3)
        t.cap("start")
        prompt("plain", "say hi", wait=20 if apierr else 8)
        if not apierr:
            bash = lambda c: f"STUB:CALL bash {json.dumps({'command': c})}"  # noqa: E731
            prompt("approve", bash("touch approved.txt"), ["Enter"])
            prompt("decline", bash("touch declined.txt"), ["Escape"])
            prompt("clear", "/clear", wait=4)
            prompt("after-clear", "say hi again")
            # A Vibe the tab's own Vibe runs from its bash tool: what tells its
            # hooks apart from the tab's (the `.env` beside each payload).
            prompt("nested", bash(f"{binp} -p 'nested hi'"), ["Enter"], wait=8)
            time.sleep(10)
            t.cap("nested-done")
            prompt("quit", "/exit", wait=4)
    finally:
        t.close()
        stub.terminate()
    rows = []
    for name in sorted(os.listdir(dump)):
        if not name.endswith(".json"):
            continue
        path = os.path.join(dump, name)
        try:
            v = json.load(open(path))
        except ValueError:
            continue
        kind = v.get("hook_event_name") or v.get("type") or "?"
        where = name.rsplit(".", 1)[0].split("-", 1)[-1]
        keys = sorted(v)
        extra = {k: v[k] for k in ("session_id", "parent_session_id", "tool_name", "notification_type", "reason",
                                   "source") if k in v}
        envf = path[:-len(".json")] + ".env"
        venv = open(envf).read().split() if os.path.exists(envf) else []
        rows.append(f"{where:12} {kind:14} keys={keys} {json.dumps(extra)[:240]} env={venv}")
        os.rename(path, os.path.join(dump, f"{len(rows):02d}-{kind}.json"))
        if os.path.exists(envf):
            os.rename(envf, os.path.join(dump, f"{len(rows):02d}-{kind}.env"))
    with open(os.path.join(out, "events.txt"), "w") as f:
        f.write("\n".join(rows) + "\n")
    print(out)
    print("\n".join(rows))


if __name__ == "__main__":
    main()
