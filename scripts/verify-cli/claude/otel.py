"""Claude: what its OpenTelemetry trace export carries, offline against a stub model.

    python3 scripts/verify-cli/claude/otel.py <label> <claude-bin> <stub-port> <otlp-port> [case ...]

Runs one `-p` turn per case in a scratch HOME against `stub_anthropic.py` (no
login, no paid turn) with Claude's trace export pointed at a loopback OTLP/HTTP
receiver started here (`Receiver`, bound to 127.0.0.1 only). Everything that
arrives is written to tmp/verify-cli/claude/<label>/otel/<case>/ as
`NN-<signal>.json` (the request body, one file per POST) plus `requests.txt`
(path, content type, content encoding, size) and `spans.txt` (one line per span:
name, then its attributes). The stub answers with cache tokens (read 7, write 5,
input 100, output 10), so the counts can be told apart in what arrives. Cases:

  json        OTEL_EXPORTER_OTLP_PROTOCOL=http/json, the plain opt-in
              (CLAUDE_CODE_ENABLE_TELEMETRY=1, CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1,
              OTEL_TRACES_EXPORTER=otlp): the receiver parses it, so spans.txt is filled
  protobuf    http/protobuf instead: the bodies stay raw bytes (no protobuf reader here)
  nobeta      the same as `json` without CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: no spans expected
  tools       `json` with a Bash tool call, for the `claude_code.tool` span and the trace tree
  content     `json` plus every OTEL_LOG_* content opt-in: what the spans add once prompt,
              response and tool text are allowed (never turn these on in the app)
  twosess     two `-p` turns with their own --session-id: how a span names its session
  subagent    an Agent tool call: what a subagent's llm_request span says about session and agent
  app         the exact environment the app injects (docs/claude_otel_tokens_plan.md): the
              per-signal TRACES_* variables and a bearer header, and the request headers that arrive
  dead        the same with nothing listening (an agent a restart left behind): `run.out`
              and `elapsed.txt` say whether the turn is slower or noisier

Default: json, protobuf, nobeta, tools, content, twosess, subagent, app, dead. The tab variables are
unset (common.clean_environ); the receiver answers 200 with an empty partial-success
body, which is all the exporter looks at.
"""
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import common  # noqa: E402

CASES = ["json", "protobuf", "nobeta", "tools", "content", "twosess", "subagent", "app", "dead"]
STUB_TOKEN = "stub-token-0123"
BASH = json.dumps({"command": "echo probe-ok", "description": "probe"})


def attr_value(v):
    """An OTLP AnyValue ({"stringValue": ...}, {"intValue": "7"}, arrays) as a plain value."""
    if not isinstance(v, dict):
        return v
    for k in ("stringValue", "boolValue", "doubleValue"):
        if k in v:
            return v[k]
    if "intValue" in v:
        return int(v["intValue"])
    if "arrayValue" in v:
        return [attr_value(x) for x in v["arrayValue"].get("values", [])]
    if "kvlistValue" in v:
        return {kv["key"]: attr_value(kv["value"]) for kv in v["kvlistValue"].get("values", [])}
    return v


def attrs(kvs):
    return {kv["key"]: attr_value(kv.get("value")) for kv in kvs or []}


def spans_of(doc):
    """(span name, attributes, span dict, resource attributes) of an OTLP/JSON traces body."""
    for rs in doc.get("resourceSpans", []):
        res = attrs(rs.get("resource", {}).get("attributes"))
        for ss in rs.get("scopeSpans", []):
            for sp in ss.get("spans", []):
                yield sp.get("name"), attrs(sp.get("attributes")), sp, res


class Receiver:
    """Loopback OTLP/HTTP receiver: every POST is saved under `out`, JSON bodies are summarised."""

    def __init__(self, port, out):
        self.out, self.n, self.lock = out, 0, threading.Lock()
        os.makedirs(out, exist_ok=True)
        recv = self

        class H(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *a):
                pass

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("content-length", 0)) or 0)
                recv.save(self.path, self.headers, body)
                reply = b"{}"
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(reply)))
                self.end_headers()
                self.wfile.write(reply)

        # 127.0.0.1 only: the one rule the app's own receiver keeps.
        self.server = ThreadingHTTPServer(("127.0.0.1", port), H)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def start(self):
        self.thread.start()

    def stop(self):
        self.server.shutdown()
        self.server.server_close()

    def save(self, path, headers, body):
        signal = path.rstrip("/").rsplit("/", 1)[-1]
        ctype = headers.get("content-type", "")
        enc = headers.get("content-encoding", "")
        with self.lock:
            self.n += 1
            n = self.n
            ext = "json" if "json" in ctype and not enc else "bin"
            with open(os.path.join(self.out, f"{n:02d}-{signal}.{ext}"), "wb") as f:
                f.write(body)
            with open(os.path.join(self.out, "requests.txt"), "a") as f:
                seen = {h: headers.get(h) for h in ("authorization", "host", "user-agent", "accept-encoding") if headers.get(h)}
                f.write(f"{n:02d} POST {path} content-type={ctype} content-encoding={enc or '-'} bytes={len(body)} headers={json.dumps(seen)}\n")
            if signal == "traces" and ext == "json":
                try:
                    doc = json.loads(body)
                except ValueError:
                    return
                with open(os.path.join(self.out, "spans.txt"), "a") as f:
                    for name, a, sp, res in spans_of(doc):
                        f.write(json.dumps({"name": name, "trace": sp.get("traceId"), "span": sp.get("spanId"),
                                            "parent": sp.get("parentSpanId"), "attributes": a,
                                            "resource": res}, sort_keys=True) + "\n")


def setup(base, case, stub_port):
    out = os.path.join(base, case)
    if os.path.isdir(out):
        shutil.rmtree(out)
    home = os.path.join(out, "home")
    work = os.path.join(home, "work")
    for d in (work, os.path.join(home, ".claude")):
        os.makedirs(d, exist_ok=True)
    common.write_json(os.path.join(home, ".claude", "settings.json"), {"apiKeyHelper": "echo sk-ant-stub-key"})
    common.write_json(os.path.join(home, ".claude.json"), {
        "hasCompletedOnboarding": True, "theme": "dark", "numStartups": 5,
        "projects": {work: {"hasTrustDialogAccepted": True, "hasCompletedProjectOnboarding": True}}})
    env = common.scratch_env(home, {
        "ANTHROPIC_BASE_URL": f"http://127.0.0.1:{stub_port}",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        "DISABLE_AUTOUPDATER": "1",
        "CLAUDE_CODE_MAX_RETRIES": "0",
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
    })
    return out, home, work, env


def otel_env(case, otlp_port):
    if case in ("app", "dead"):
        return {
            "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
            "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA": "1",
            "OTEL_TRACES_EXPORTER": "otlp",
            "OTEL_METRICS_EXPORTER": "none",
            "OTEL_LOGS_EXPORTER": "none",
            "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL": "http/json",
            "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT": f"http://127.0.0.1:{otlp_port}/v1/traces",
            "OTEL_EXPORTER_OTLP_TRACES_HEADERS": f"Authorization=Bearer%20{STUB_TOKEN}",
        }
    e = {
        "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
        "OTEL_TRACES_EXPORTER": "otlp",
        "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf" if case == "protobuf" else "http/json",
        "OTEL_EXPORTER_OTLP_ENDPOINT": f"http://127.0.0.1:{otlp_port}",
        # Flush at once instead of every 5 s, and at exit.
        "OTEL_TRACES_EXPORT_INTERVAL": "500",
    }
    if case != "nobeta":
        e["CLAUDE_CODE_ENHANCED_TELEMETRY_BETA"] = "1"
    if case == "content":
        e.update({"OTEL_LOG_USER_PROMPTS": "1", "OTEL_LOG_TOOL_DETAILS": "1", "OTEL_LOG_TOOL_CONTENT": "1",
                  "OTEL_LOG_ASSISTANT_RESPONSES": "1"})
    return e


def run(binary, work, env, out, name, *args):
    e = common.clean_environ()
    for k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDECODE"):
        e.pop(k, None)
    for k in [k for k in e if k.startswith("OTEL_") or k.startswith("CLAUDE_CODE_")]:
        e.pop(k)
    e.update(env)
    t0 = time.time()
    r = subprocess.run([binary, *args], cwd=work, env=e, stdin=subprocess.DEVNULL,
                       capture_output=True, text=True, timeout=180)
    with open(os.path.join(out, f"{name}.out"), "w") as f:
        f.write(f"exit {r.returncode}\n--- stdout\n{r.stdout}\n--- stderr\n{r.stderr}\n")
    with open(os.path.join(out, "elapsed.txt"), "a") as f:
        f.write(f"{name} {time.time() - t0:.2f}s\n")
    return r


def main():
    if len(sys.argv) < 5:
        sys.exit(__doc__)
    label, binary = sys.argv[1], common.binary(sys.argv[2])
    stub_port, otlp_port = int(sys.argv[3]), int(sys.argv[4])
    cases = sys.argv[5:] or CASES
    base = common.out_dir("claude", label, "otel")
    os.environ.update({"STUB_CACHE_READ": "7", "STUB_CACHE_WRITE": "5"})
    stub = common.start_stub("stub_anthropic.py", stub_port, os.path.join(base, "stub.jsonl"))
    try:
        for case in cases:
            out, home, work, env = setup(base, case, stub_port)
            recv = Receiver(otlp_port, os.path.join(out, "otel"))
            recv.start()
            if case == "dead":
                recv.stop()  # nothing listens: an agent a restart left behind
            try:
                env.update(otel_env(case, otlp_port))
                args = ["-p", "--model", "claude-stub"]
                if case == "tools":
                    run(binary, work, env, out, "run", *args, "--session-id", str(uuid.uuid4()),
                        f"STUB:CALL Bash {BASH}", "--allowedTools", "Bash")
                elif case == "subagent":
                    arg = json.dumps({"description": "probe", "prompt": "reply with ok", "subagent_type": "general-purpose"})
                    run(binary, work, env, out, "run", *args, "--session-id", str(uuid.uuid4()), f"STUB:CALL Agent {arg}")
                elif case == "twosess":
                    for i in (1, 2):
                        run(binary, work, env, out, f"run{i}", *args, "--session-id", str(uuid.uuid4()), "say hi")
                else:
                    run(binary, work, env, out, "run", *args, "--session-id", str(uuid.uuid4()), "say hi")
            finally:
                recv.stop()
            print(case, "->", os.path.join(out, "otel"))
    finally:
        stub.terminate()


if __name__ == "__main__":
    main()
