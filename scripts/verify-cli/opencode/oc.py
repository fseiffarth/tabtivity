"""OpenCode probe helpers: a scratch home wired like a tab's, against the stub.

Not run directly; turns.py, tabby.py and resume.py import it.

The session plugin is rebuilt from `plugin_body` in
services/agent/opencode_session.rs on every run, so the probe always loads
what the app writes today. If that function changes shape, `plugin_body()`
below fails loudly instead of loading a stale copy.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import common  # noqa: E402

AGENT_DIR = os.path.join(common.ROOT, "src-tauri", "src", "services", "agent")
UID = "11111111-2222-4333-8444-555555555555"


def _consts():
    text = "".join(open(os.path.join(AGENT_DIR, f)).read() for f in ("opencode_session.rs", "agent_session.rs"))
    return dict(re.findall(r"const (\w+)\s*:\s*&str\s*=\s*(.*?);", text, re.S)), text


def _resolve(expr, consts, live):
    expr = expr.strip()
    if expr == "live_dir":
        return live
    m = re.fullmatch(r'crate::app_env!\("(\w+)"\)', expr)
    if m:
        return common.ENV_PREFIX + m.group(1)
    m = re.fullmatch(r'concat!\(crate::app_slug!\(\),\s*"([^"]*)"\)', expr)
    if m:
        return common.SLUG + m.group(1)
    if expr in consts:
        return _resolve(consts[expr], consts, live)
    sys.exit(f"opencode/oc.py: cannot resolve `{expr}` in plugin_body's arguments — update _resolve")


def plugin_body(live):
    consts, text = _consts()
    m = re.search(r'fn plugin_body\(live_dir: &str\) -> String \{.*?format!\(\s*"(.*?)",\s*\n(.*?)\n\s*\)\s*\n\}', text, re.S)
    if not m:
        sys.exit("opencode/oc.py: plugin_body's shape changed — update plugin_body()")
    body = re.sub(r"\\\n\s*", "", m.group(1))  # Rust line continuations
    body = body.replace("\\x20", " ").replace("\\n", "\n").replace('\\"', '"').replace("\\\\", "\\")
    args = dict(re.findall(r"^\s*(\w+)\s*=\s*lit\((.*)\),\s*$", m.group(2), re.M))
    out = []
    for piece in re.split(r"(\{\{|\}\}|\{\w+\})", body):
        if piece == "{{":
            out.append("{")
        elif piece == "}}":
            out.append("}")
        elif re.fullmatch(r"\{\w+\}", piece):
            name = piece[1:-1]
            out.append(common.DISPLAY if name == "DISPLAY" else json.dumps(_resolve(args[name], consts, live)))
        else:
            out.append(piece)
    return "".join(out)


def stub_config(port, **more):
    cfg = {"model": "ollama/stub", "provider": {"ollama": {
        "npm": "@ai-sdk/openai-compatible", "name": "Ollama (local)",
        "options": {"baseURL": f"http://127.0.0.1:{port}/v1"},
        "models": {"stub": {"name": "stub"}}, "whitelist": ["stub"]}}}
    cfg.update(more)
    return cfg


def home_env(home, cfg, tab=True):
    """The env a tab's OpenCode gets: scratch HOME, config via env, the plugin listed."""
    live = os.path.join(home, "live_sessions")
    plug = os.path.join(home, "plugins", f"{common.SLUG}_opencode_session")
    os.makedirs(plug, exist_ok=True)
    os.makedirs(os.path.join(home, ".config", "opencode"), exist_ok=True)
    with open(os.path.join(plug, "index.js"), "w") as f:
        f.write(plugin_body(live))
    common.write_json(os.path.join(home, ".config", "opencode", "opencode.json"), {"plugins": [f"file://{plug}"]})
    extra = {"OPENCODE_DISABLE_AUTOUPDATE": "1", "OPENCODE_CONFIG_CONTENT": json.dumps(cfg),
             common.ENV_PREFIX + "WEB_MCP_TOKEN": "t", common.ENV_PREFIX + "HELP_MCP_TOKEN": "t"}
    if tab:
        extra.update({common.ENV_PREFIX + "TAB_UID": UID, common.ENV_PREFIX + "TAB_AGENT": "opencode"})
    return common.scratch_env(home, extra), live


def reqs(log):
    try:
        return [json.loads(line) for line in open(log)]
    except FileNotFoundError:
        return []
