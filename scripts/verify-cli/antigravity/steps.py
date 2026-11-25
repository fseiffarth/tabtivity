"""Antigravity's step checklist (1.5.16+) as the TUI draws it, offline.

    python3 scripts/verify-cli/antigravity/steps.py <label> <bin> <port> [cols] [args-json]
    → tmp/verify-cli/antigravity/<label>/steps[<cols>]/*.esc, decls.json

A first turn writes the tool declarations the CLI offers to `decls.json`
(`STUB_DECLS`) and prints `update_steps`'s. A second turn makes the stub call
`update_steps` with `args-json` (default: three steps, one done, one running)
and holds the answer (`STUB:HOLD`), so the `N/M steps` line and its open
checklist above the prompt are captured mid-turn (`held`), then after the turn
ends (`after`). parsers/frames.probe.ts replays the frames: the checklist rows
must not read as a question, a picker or the footer's model.
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from agy import Agy, common  # noqa: E402

label, binp, port = sys.argv[1], sys.argv[2], int(sys.argv[3])
cols = int(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4].isdigit() else None
given = sys.argv[-1] if len(sys.argv) > 4 and sys.argv[-1].startswith("{") else None
name = f"steps{cols}" if cols else "steps"

# The stub reads STUB_DECLS from its environment, which Agy's Popen inherits.
decls_path = os.path.join(common.out_dir("antigravity", label, name), "decls.json")
os.environ["STUB_DECLS"] = decls_path
r = Agy(label, name, port, common.binary(binp), size=(cols or 100, 32))
try:
    r.first_run()
    r.wait("? for shortcuts")
    time.sleep(2)
    r.type("hello")
    r.keys("Enter")
    r.wait("stub answer done", 15)
    time.sleep(1)
    decl = None
    try:
        for tool in json.load(open(decls_path)):
            for d in tool.get("functionDeclarations") or tool.get("function_declarations") or []:
                if d.get("name") == "update_steps":
                    decl = d
    except (OSError, ValueError):
        pass
    print(label, "update_steps declaration:", json.dumps(decl, indent=1) if decl else None)
    if given:
        args = json.loads(given)
    else:
        args = {"steps": [
            {"title": "Read the config", "status": "done"},
            {"title": "Patch the reader", "status": "in_progress"},
            {"title": "Run the tests", "status": "pending"},
        ]}
    r.type(f"STUB:HOLD 8 STUB:CALL update_steps {json.dumps(args)}")
    r.keys("Enter")
    time.sleep(3)
    r.cap("held")
    time.sleep(2)
    r.cap("held2")
    # The first turn's answer is still on screen, so wait out the hold instead.
    time.sleep(7)
    r.cap("after")
    print(label, "tool calls:", [json.loads(l).get("call") for l in open(os.path.join(r.out, "stub.jsonl")) if '"call": {' in l])
finally:
    r.close()
