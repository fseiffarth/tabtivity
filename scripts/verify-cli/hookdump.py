"""A hook command that records what it was given, for the hook probes.

    python3 -I hookdump.py <log.jsonl> <event>

Appends one JSON line: the event name, the hook's pid and parent pid, the
names of every variable in its environment, the values of the tab, Copilot
and hook-depth variables, and the payload read from stdin (parsed when it is
JSON). Prints nothing, so a CLI that parses hook stdout reads "no output".
Not run directly: copilot/hooks.py registers it for every event.
"""
import json
import os
import sys
import time

log, event = sys.argv[1], sys.argv[2]
raw = sys.stdin.read() if not sys.stdin.isatty() else ""
try:
    payload = json.loads(raw) if raw.strip() else None
except ValueError:
    payload = raw[:2000]
keep = ("TAB_UID", "TAB_AGENT", "PROJECT_DIR", "OPENCODE_SESSION")
env = {k: v for k, v in os.environ.items()
       if k.endswith(keep) or k.startswith(("COPILOT_HOOK", "COPILOT_AGENT", "COPILOT_SESSION", "COPILOT_DETACHED"))}
rec = {"event": event, "t": round(time.time(), 3), "pid": os.getpid(), "ppid": os.getppid(),
       "env": env, "env_names": sorted(os.environ), "input": payload}
with open(log, "a") as f:
    f.write(json.dumps(rec) + "\n")
