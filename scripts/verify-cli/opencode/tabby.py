"""The assistant's (Tabby's) pinned OpenCode tool set, against the stub.

    python3 scripts/verify-cli/opencode/tabby.py <label> <bin> <port>

Rebuilds the tools/MCP pin the assistant scope uses (only the web lane and the
help docs) and forces calls to tools that must stay refused: bash, shell,
subagent — then one allowed web call. Expect `markers []` (nothing ran on the
host) and the offered-tools list to hold only the web and help tools.
The tool lists are read from services/agent/assistant.rs
(OPENCODE_TOOLS_OFF, OPENCODE_LANE_TOOLS), so the probe pins what the app pins.
"""
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import oc  # noqa: E402
from oc import common  # noqa: E402

label, binp, port = sys.argv[1], sys.argv[2], int(sys.argv[3])
src = open(os.path.join(oc.AGENT_DIR, "assistant.rs")).read()
m = re.search(r"const OPENCODE_TOOLS_OFF: \[&str; \d+\] = \[(.*?)\];", src, re.S)
lane = re.search(r'const OPENCODE_LANE_TOOLS: &str = "([^"]+)";', src)
if not (m and lane):
    sys.exit("opencode/tabby.py: assistant.rs's OpenCode tool constants moved — update the probe")
off = re.findall(r'"([^"]+)"', m.group(1))
# The order is load-bearing (last match wins): wildcard, the named ones, then the lanes.
tools = {"*": False, **{x: False for x in off}, lane.group(1): True, f"help_{common.SLUG}_help_*": True}
auth = "Bearer {env:" + common.ENV_PREFIX + "%s_MCP_TOKEN}"
mcp = {name: {"type": "remote", "url": f"http://127.0.0.1:{port}/mcp/{name}",
              "headers": {"Authorization": auth % name.upper()}} for name in ("web", "help")}
cfg = oc.stub_config(port, tools=tools, mcp=mcp, agent={"build": {"prompt": "You are Tabby."}})
cfg.pop("model")
out = common.out_dir("opencode", label, "tabby")
home = common.out_dir("opencode", label, "h-tabby")
work = common.out_dir("opencode", label, "h-tabby", "work")
env, _ = oc.home_env(home, cfg, tab=False)
log = os.path.join(out, "stub.jsonl")
stub = common.start_stub("stub_openai.py", port, log)
t = common.Tui(out, [binp, "mini", "--model", "ollama/stub", "--standalone"], work, env)
try:
    print(label, "ready", t.wait("Ask anything", 30))
    time.sleep(3)
    t.cap("start")
    cases = [("bash", {"command": f"touch {work}/marker_bash", "description": "m"}),
             ("shell", {"command": f"touch {work}/marker_shell", "description": "m"}),
             ("subagent", {"prompt": "x", "description": "y"}),
             ("web_web_search", {"query": "q"})]
    for name, a in cases:
        t.type(f"STUB:CALL {name} {json.dumps(a)}")
        t.keys("Enter")
        time.sleep(7)
        t.cap(f"after_{name}")
        if "Allow once" in t.plain():
            print(label, name, "PERMISSION PROMPT")
            t.cap(f"perm_{name}")
            t.keys("Escape")
    print(label, "markers", sorted(f for f in os.listdir(work) if f.startswith("marker")))
    rq = [x for x in oc.reqs(log) if "tools" in x]
    print(label, "offered", rq[-1]["tools"] if rq else None)
    for x in rq:
        if x["tool_results"]:
            print(label, "RES", x["prompt"][:30], "=>", [r[:260] for r in x["tool_results"]])
finally:
    t.close()
    stub.terminate()
