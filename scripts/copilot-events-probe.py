#!/usr/bin/env python3
"""Check what Tabtivity reads of the Copilot CLI against the installed release.

Runs `copilot -p` three times in a throwaway HOME against a local stub model
(Copilot's BYOK mode, `COPILOT_PROVIDER_BASE_URL`), so no GitHub login, no
quota and none of the real `~/.copilot` is involved, and checks the records
`services::copilot_session`, `agent_changes` and the `agent_hint` session hook
depend on:

  * `--session-id <uuid>` creates the session on first use and resumes it after
    (`session.resume` appended to the same `events.jsonl`);
  * `sessionStart` hooks get `sessionId` and `source` (new, then resume);
  * `user.message` / `assistant.message` carry `content`;
  * the `create` + `edit` tools (Claude-family models) and the freeform
    `apply_patch` tool (GPT-family models) end in a `tool.execution_complete`
    whose `fileEdits` and `result.detailedContent` give one git-style diff
    section per file, in `fileEdits` order.

    python3 scripts/copilot-events-probe.py            # the installed release
    COPILOT_AUTO_UPDATE=true COPILOT_PROBE_DIR=/tmp/cp python3 scripts/copilot-events-probe.py
                                                       # a newer release: it is fetched in
                                                       # the background of the first run and
                                                       # used from the second, in the same
                                                       # (kept) directory
    COPILOT_BIN=/path/to/copilot python3 scripts/copilot-events-probe.py

Exit status is non-zero on any failed check. Notes: docs/third_party_update_checklist.md.
"""
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import uuid

BIN = os.environ.get("COPILOT_BIN", "copilot")
AUTO_UPDATE = os.environ.get("COPILOT_AUTO_UPDATE", "false")
failures = []


def check(ok, what):
    print(("ok   " if ok else "FAIL ") + what)
    if not ok:
        failures.append(what)


class Stub(http.server.BaseHTTPRequestHandler):
    """A chat-completions endpoint that scripts tool calls by the request's model."""

    work = ""

    def log_message(self, *args):
        pass

    def do_GET(self):
        self._send({"object": "list", "data": [{"id": "stub", "object": "model"}]})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        done = sum(1 for m in body.get("messages", []) if m.get("role") == "tool")
        w = self.work
        calls = None
        if body.get("model") == "stub":  # `edit` / `create`
            if done == 0:
                calls = [{"id": "c1", "type": "function", "function": {"name": "create", "arguments": json.dumps({"path": w + "/e.txt", "file_text": "one\ntwo\n"})}}]
            elif done == 1:
                calls = [{"id": "c2", "type": "function", "function": {"name": "edit", "arguments": json.dumps({"path": w + "/e.txt", "old_str": "two", "new_str": "three"})}}]
        else:  # GPT family: the freeform `apply_patch`
            patches = [
                "*** Begin Patch\n*** Add File: %s/a.txt\n+alpha\n+beta\n*** Add File: %s/b.txt\n+bee\n*** End Patch\n" % (w, w),
                "*** Begin Patch\n*** Update File: %s/a.txt\n@@\n alpha\n-beta\n+gamma\n*** Delete File: %s/b.txt\n*** End Patch\n" % (w, w),
            ]
            if done < 2:
                calls = [{"id": "p%d" % done, "type": "custom", "custom": {"name": "apply_patch", "input": patches[done]}}]
        message = {"role": "assistant", "content": None, "tool_calls": calls} if calls else {"role": "assistant", "content": "Done."}
        self._send({"id": "x", "object": "chat.completion", "created": 0, "model": body.get("model", "stub"),
                    "choices": [{"index": 0, "message": message, "finish_reason": "tool_calls" if calls else "stop"}],
                    "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}})

    def _send(self, payload):
        data = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def events(home, sid):
    path = os.path.join(home, ".copilot", "session-state", sid, "events.jsonl")
    with open(path, encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def main():
    keep = os.environ.get("COPILOT_PROBE_DIR")
    root = keep or tempfile.mkdtemp(prefix="copilot-probe-")
    home, work, hooks_out = (os.path.join(root, n) for n in ("home", "work", "hooks"))
    shutil.rmtree(hooks_out, ignore_errors=True)
    for d in (home, work, hooks_out, os.path.join(home, ".copilot", "hooks")):
        os.makedirs(d, exist_ok=True)
    dump = os.path.join(root, "hook.sh")
    with open(dump, "w") as handle:
        handle.write("#!/bin/sh\ncat > %s/in.$$.json\nprintf '{}'\n" % hooks_out)
    os.chmod(dump, 0o755)
    with open(os.path.join(home, ".copilot", "hooks", "probe.json"), "w") as handle:
        json.dump({"version": 1, "hooks": {"sessionStart": [{"type": "command", "bash": dump, "timeoutSec": 10}]}}, handle)
    with open(os.path.join(home, ".copilot", "config.json"), "w") as handle:
        json.dump({"trustedFolders": [work]}, handle)
    Stub.work = work
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Stub)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    env = {k: v for k, v in os.environ.items() if not k.endswith("_TAB_UID")}
    env.update(HOME=home, COPILOT_HOME=os.path.join(home, ".copilot"), COPILOT_AUTO_UPDATE=AUTO_UPDATE,
               COPILOT_PROVIDER_BASE_URL="http://127.0.0.1:%d/v1" % server.server_address[1], COPILOT_PROVIDER_API_KEY="test")

    def run(prompt, sid, model):
        env["COPILOT_MODEL"] = model
        subprocess.run([BIN, "-p", prompt, "--session-id", sid, "--stream", "off", "--allow-all-tools", "--allow-all-paths",
                        "--disable-client-telemetry"], cwd=work, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)

    try:
        sid = str(uuid.uuid4())
        run("make e.txt", sid, "stub")
        ev = events(home, sid)
        types = [e["type"] for e in ev]
        print("copilot", ev[0]["data"].get("copilotVersion"))
        check(types[:1] == ["session.start"] and ev[0]["data"]["sessionId"] == sid, "--session-id pins a new session's id")
        users = [e for e in ev if e["type"] == "user.message"]
        check(len(users) == 1 and users[0]["data"]["content"] == "make e.txt", "user.message data.content is the typed prompt")
        answers = [e for e in ev if e["type"] == "assistant.message" and e["data"].get("content")]
        check(len(answers) == 1 and answers[0]["data"]["content"] == "Done." and answers[0]["data"].get("model"), "assistant.message data.content and data.model")
        done = [e["data"] for e in ev if e["type"] == "tool.execution_complete"]
        check([d["fileEdits"][0]["kind"] for d in done] == ["create", "edit"], "create, then edit, in fileEdits")
        check(all(d["success"] and "diff --git" in d["result"]["detailedContent"] and "\n@@" in d["result"]["detailedContent"] for d in done), "detailedContent is a git-style diff with hunks")
        check(os.path.isfile(os.path.join(home, ".copilot", "session-state", sid, "workspace.yaml")), "workspace.yaml beside events.jsonl")
        with open(os.path.join(home, ".copilot", "session-state", sid, "workspace.yaml")) as handle:
            check(any(line.strip() == "cwd: " + work for line in handle), "workspace.yaml names the cwd as `cwd: <path>`")

        run("again", sid, "stub")
        ev = events(home, sid)
        check("session.resume" in [e["type"] for e in ev] and len([e for e in ev if e["type"] == "user.message"]) == 2, "the same --session-id resumes into the same log")

        pid = str(uuid.uuid4())
        run("patch it", pid, "gpt-5.4")
        done = [e["data"] for e in events(home, pid) if e["type"] == "tool.execution_complete"]
        check(len(done) == 2 and [[f["kind"] for f in d["fileEdits"]] for d in done] == [["create", "create"], ["edit", "delete"]], "apply_patch: fileEdits per file")
        for d in done:
            sections = [s for s in d["result"]["detailedContent"].split("diff --git ")[1:]]
            check(len(sections) == len(d["fileEdits"]) and all(("a/" + f["path"].lstrip("/")) in s.split("\n", 1)[0] for s, f in zip(sections, d["fileEdits"])),
                  "apply_patch: one diff section per file, headers name the paths")

        hooks = [json.load(open(os.path.join(hooks_out, n))) for n in sorted(os.listdir(hooks_out))]
        check(len(hooks) >= 3 and all(h.get("sessionId") for h in hooks), "sessionStart hook payload carries sessionId")
        check({h["source"] for h in hooks} == {"new", "resume"}, "sessionStart source is new, then resume")
    finally:
        server.shutdown()
        if not keep:
            shutil.rmtree(root, ignore_errors=True)
    print("%d check(s) failed" % len(failures) if failures else "all checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
