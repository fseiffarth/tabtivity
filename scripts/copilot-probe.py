#!/usr/bin/env python3
"""Standalone, synthetic-document CLS probe; never starts Tabtivity.

Usage: python3 scripts/copilot-probe.py /absolute/path/to/copilot-language-server
No credentials are read from other editors. Sign-in is deliberately not part of
this unauthenticated probe: the 1.547.0 default auth repository is plaintext.
Protocol payloads and server logs are not printed.
"""

import json
import os
from pathlib import Path
import queue
import signal
import subprocess
import sys
import tempfile
import threading
import time


def probe(executable):
    with tempfile.TemporaryDirectory(prefix="tabtivity-cls-probe-") as directory:
        root = Path(directory)
        project = root / "synthetic-project"
        project.mkdir()
        config = root / "config"
        # A directory at the database filename forces the inspected server's
        # in-memory fallback. No credential database may be written on disk.
        (config / "github-copilot" / "auth.db").mkdir(parents=True)
        env = {key: value for key, value in os.environ.items()
               if key in ("PATH", "SYSTEMROOT", "WINDIR", "LANG", "LC_ALL")}
        env.update(XDG_CONFIG_HOME=str(config), XDG_CACHE_HOME=str(root / "cache"),
                   XDG_STATE_HOME=str(root / "state"), COPILOT_HOME=str(root / "copilot"))
        process = subprocess.Popen([executable, "--stdio"], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   cwd=project, env=env, start_new_session=True)
        incoming = queue.Queue()
        methods = set()
        statuses = set()

        def read():
            try:
                while True:
                    headers = {}
                    while True:
                        line = process.stdout.readline(8192)
                        if not line:
                            raise EOFError()
                        if line == b"\r\n":
                            break
                        key, value = line.decode("ascii").split(":", 1)
                        headers[key.lower()] = value.strip()
                    length = int(headers["content-length"])
                    if not 0 < length <= 8 * 1024 * 1024:
                        raise ValueError("invalid frame")
                    data = bytearray()
                    while len(data) < length:
                        chunk = process.stdout.read(length - len(data))
                        if not chunk:
                            raise EOFError()
                        data.extend(chunk)
                    incoming.put(json.loads(data))
            except (OSError, ValueError, EOFError) as error:
                incoming.put(error)

        threading.Thread(target=read, daemon=True).start()

        def send(message):
            data = json.dumps({"jsonrpc": "2.0", **message}).encode()
            process.stdin.write(f"Content-Length: {len(data)}\r\n\r\n".encode() + data)
            process.stdin.flush()

        def result(request_id):
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                message = incoming.get(timeout=max(0.01, deadline - time.monotonic()))
                if isinstance(message, Exception):
                    raise RuntimeError("server framing/exit failure") from message
                method = message.get("method")
                if method:
                    methods.add(method)
                    if method == "didChangeStatus":
                        statuses.add(message.get("params", {}).get("kind", "unknown"))
                    if "id" in message:
                        if method == "workspace/configuration":
                            reply = [None] * len(message.get("params", {}).get("items", []))
                        elif method == "window/showDocument":
                            reply = {"success": False}
                        else:
                            reply = None
                        send({"id": message["id"], "result": reply})
                elif message.get("id") == request_id:
                    return message
            raise TimeoutError("server request timed out")

        def notify(method, params):
            send({"method": method, "params": params})

        try:
            send({"id": 1, "method": "initialize", "params": {
                "processId": os.getpid(), "workspaceFolders": [{"uri": project.as_uri(), "name": "probe"}],
                "capabilities": {"workspace": {"workspaceFolders": True}, "window": {"showDocument": {"support": True}}},
                "initializationOptions": {"editorInfo": {"name": "Tabtivity", "version": "0.1"},
                                          "editorPluginInfo": {"name": "Tabtivity probe", "version": "0.1"}},
            }})
            initialized = result(1)
            if "error" in initialized:
                raise RuntimeError("initialize failed")
            print("initialize:", json.dumps(initialized["result"].get("serverInfo", {})))
            print("textDocumentSync:", json.dumps(initialized["result"].get("capabilities", {}).get("textDocumentSync")))
            notify("initialized", {})
            notify("workspace/didChangeConfiguration", {"settings": {"telemetry": {"telemetryLevel": "off"}}})
            uri = (project / "example.py").as_uri()
            notify("textDocument/didOpen", {"textDocument": {
                "uri": uri, "languageId": "python", "version": 1, "text": "def square(x):\n    "}})
            notify("textDocument/didChange", {"textDocument": {"uri": uri, "version": 2}, "contentChanges": [{
                "range": {"start": {"line": 1, "character": 4}, "end": {"line": 1, "character": 4}}, "text": "return "}]})
            notify("textDocument/didFocus", {"textDocument": {"uri": uri}})
            params = {"textDocument": {"uri": uri, "version": 2}, "position": {"line": 1, "character": 11},
                      "context": {"triggerKind": 1}, "formattingOptions": {"tabSize": 4, "insertSpaces": True}}
            send({"id": 2, "method": "textDocument/inlineCompletion", "params": params})
            response = result(2)
            print("unauthenticated completion error code:", response.get("error", {}).get("code"))
            send({"id": 3, "method": "textDocument/inlineCompletion", "params": params})
            notify("$/cancelRequest", {"id": 3})
            response = result(3)
            print("cancelled completion error code:", response.get("error", {}).get("code"))
            notify("textDocument/didClose", {"textDocument": {"uri": uri}})
            notify("textDocument/didFocus", {})
            send({"id": 4, "method": "shutdown", "params": {}})
            result(4)
            notify("exit", {})
            print("server methods:", ", ".join(sorted(methods)))
            print("status kinds:", ", ".join(sorted(statuses)))
            print("auth database blocked:", (config / "github-copilot" / "auth.db").is_dir())
        finally:
            if process.poll() is None:
                if os.name == "posix":
                    os.killpg(process.pid, signal.SIGKILL)
                else:
                    process.kill()
            process.wait(timeout=10)


if __name__ == "__main__":
    if len(sys.argv) != 2 or not Path(sys.argv[1]).is_absolute():
        sys.exit("Provide the absolute path to an installed Copilot language server.")
    probe(sys.argv[1])
