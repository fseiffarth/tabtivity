"""Which OpenCode plugin hooks and bus events fire, and what the app's plugin
writes to the tab's turn record.

    python3 scripts/verify-cli/opencode/hooks.py events|turn <label> <bin> <port>
    → tmp/verify-cli/opencode/<label>/hooks-<mode>/{dump.jsonl,stub.jsonl,*.esc,result.json}

Lists a dumping plugin beside the app's session plugin (rebuilt from
`opencode_session.rs` by oc.py) in a tab-like scratch home, and walks one
full-TUI session (`--standalone`, shell and edit on `ask`): a plain prompt,
an approval allowed, one rejected, a failing tool, a model call that fails
(`STUB:FAIL 400`), a subagent, an `opencode run` from the session's own shell
tool and a quit. The dump has every bus event (V1: the `event` hook; V2:
`ctx.event.subscribe()`) and the V1 `chat.message` / `permission.ask` /
`tool.execute.*` and V2 `session` / `tool` hooks, each with the pid that ran
it and whether the tab variables and the plugin's claim were set. `turn`
also prints the tab's turn record after every step with PASS/FAIL for the
word each step must leave, and checks the nested run left it alone.

The tab variables are a made-up key (oc.home_env), so the plugin writes only
into this scratch home's record folder.
"""
import json
import os
import shutil
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import oc  # noqa: E402
from oc import common  # noqa: E402

DUMP_PLUGIN = r"""
import { appendFileSync } from "node:fs";
const LOG = %(log)s;
const UID_VAR = %(uid)s, CLAIM_VAR = %(claim)s;
const brief = (v) => { try { return JSON.stringify(v, (k, x) => (typeof x === "string" && x.length > 160 ? x.slice(0, 160) + "…" : x)).slice(0, 1500); } catch { return String(v); } };
const log = (kind, name, data) => {
  const p = data?.properties ?? data?.data ?? data ?? {};
  const info = p.info ?? {};
  appendFileSync(LOG, JSON.stringify({
    kind, name, t: Date.now() / 1000, pid: process.pid,
    tab: Boolean(process.env[UID_VAR]), claim: process.env[CLAIM_VAR] ?? null,
    sessionID: p.sessionID ?? info.sessionID ?? info.id ?? null, parentID: info.parentID ?? p.parentID ?? null,
    data: brief(data),
  }) + "\n");
};
const V1_HOOKS = ["chat.message", "permission.ask", "tool.execute.before", "tool.execute.after"];
export default {
  id: "probe.dump",
  server: async () => {
    log("v1", "server", {});
    const hooks = { event: async ({ event }) => log("event", event?.type, event) };
    for (const name of V1_HOOKS) hooks[name] = async (input, output) => log("v1hook", name, { input, output });
    // Whether a variable set here reaches the shell tool's commands.
    hooks["shell.env"] = async (input, output) => { log("v1hook", "shell.env", { input }); if (output?.env) output.env.PROBE_SHELL_MARK = "v1"; };
    return hooks;
  },
  async setup(ctx) {
    log("v2", "setup", { keys: Object.keys(ctx ?? {}) });
    try {
      await ctx.shell.hook("create.before", async (input) => {
        log("v2hook", "shell.create.before", { keys: Object.keys(input ?? {}), env: typeof input?.env, claim: input?.env?.[CLAIM_VAR] ?? null });
        if (input?.env) input.env.PROBE_SHELL_MARK = "v2";
      });
    } catch (e) { log("v2err", "shell.create.before", { e: String(e) }); }
    for (const name of ["prompt", "experimental.idle", "fork", "retry"]) {
      try { await ctx.session.hook(name, async (input) => log("v2hook", "session." + name, input)); }
      catch (e) { log("v2err", "session." + name, { e: String(e) }); }
    }
    for (const name of ["execute.before", "execute.after"]) {
      try { await ctx.tool.hook(name, async (input) => log("v2hook", "tool." + name, input)); }
      catch (e) { log("v2err", "tool." + name, { e: String(e) }); }
    }
    try {
      let sub = ctx.event.subscribe();
      log("v2", "subscribe", { type: typeof sub, then: typeof sub?.then, iter: typeof sub?.[Symbol.asyncIterator] });
      if (sub && typeof sub.then === "function") sub = await sub;
      if (sub && typeof sub[Symbol.asyncIterator] === "function") {
        (async () => { for await (const ev of sub) log("event", ev?.type, ev); })().catch((e) => log("v2err", "iterate", { e: String(e) }));
      } else {
        log("v2", "subscribed", { type: typeof sub, keys: sub && Object.keys(sub) });
      }
    } catch (e) { log("v2err", "subscribe", { e: String(e) }); }
  },
};
"""

if len(sys.argv) != 5 or sys.argv[1] not in ("events", "turn"):
    sys.exit(__doc__)
mode, label, binp, port = sys.argv[1], sys.argv[2], common.binary(sys.argv[3]), int(sys.argv[4])
out = common.out_dir("opencode", label, f"hooks-{mode}")
shutil.rmtree(out, ignore_errors=True)
out = common.out_dir("opencode", label, f"hooks-{mode}")
home = common.out_dir("opencode", label, f"hooks-{mode}", "home")
work = common.out_dir("opencode", label, f"hooks-{mode}", "home", "work")
dump = os.path.join(out, "dump.jsonl")
# 1.x: the plugin's entry file under `plugin`, `bash` for the shell tool, no
# `--standalone`, `task` for a subagent.
v1 = label.startswith("1.")
SHELL = "bash" if v1 else "shell"
cfg = oc.stub_config(port, permission={SHELL: "ask", "edit": "ask"})
env, live = oc.home_env(home, cfg, v1=v1)
plug = os.path.join(home, "plugins", "probe_dump")
os.makedirs(plug, exist_ok=True)
with open(os.path.join(plug, "index.js"), "w") as f:
    f.write(DUMP_PLUGIN % {"log": json.dumps(dump), "uid": json.dumps(common.ENV_PREFIX + "TAB_UID"),
                           "claim": json.dumps(common.ENV_PREFIX + "OPENCODE_SESSION")})
conf = os.path.join(home, ".config", "opencode", "opencode.json")
listed = json.load(open(conf))
listed["plugin" if v1 else "plugins"].append(f"file://{plug}/index.js" if v1 else f"file://{plug}")
common.write_json(conf, listed)
# As the app does for every home: a private server per launch, nested runs too.
common.write_json(os.path.join(home, ".config", "opencode", "service.json"), {"disabled": True})
log = os.path.join(out, "stub.jsonl")
stub = common.start_stub("stub_openai.py", port, log)
results = {}
checks = []


def events():
    try:
        return [json.loads(line) for line in open(dump)]
    except OSError:
        return []


def turn_word():
    try:
        return open(os.path.join(live, f"{oc.UID}.turn")).read().split()[0]
    except (OSError, IndexError):
        return None


def read_record():
    try:
        return open(os.path.join(live, oc.UID)).read().strip()
    except OSError:
        return None


def done_after(n0):
    """The turn is over: an idle status (V1, or V2's compat event) or V2's
    execution end, for the session the first prompt went to, after event
    `n0`."""
    evs = events()
    main = next((e.get("sessionID") for e in evs if e["name"] in ("chat.message", "session.prompt")), None)
    for e in evs[n0:]:
        if e["kind"] != "event" or e.get("sessionID") != main:
            continue
        if e["name"] in ("session.idle", "session.execution.succeeded", "session.execution.failed",
                         "session.execution.interrupted"):
            return True
    return False


def step(tag, text, answer=None, secs=40, expect=None, dialog="Allow once"):
    n0 = len(events())
    words = []
    t.type(text)
    t.keys("Enter")
    t0 = time.time()
    answered = False
    while time.time() - t0 < secs:
        w = turn_word()
        if not words or words[-1] != w:
            words.append(w)
        p = t.plain()
        if dialog in p:
            if not answered:
                time.sleep(2)
                w = turn_word()
                if words[-1] != w:
                    words.append(w)
                t.cap(f"{tag}_dialog")
                answered = True
            if answer == "reject":
                t.keys("Right", "Right", "Enter")
            else:
                t.keys("Enter")
            time.sleep(1)
            continue
        if time.time() - t0 > 3 and done_after(n0):
            break
        time.sleep(0.3)
    time.sleep(2.5)
    w = turn_word()
    if words[-1] != w:
        words.append(w)
    t.cap(f"{tag}_end")
    got = [(e["kind"], e["name"], e.get("sessionID"), e.get("parentID"), e["pid"], e["claim"]) for e in events()[n0:]
           if not (e["kind"] == "event" and str(e["name"]).endswith((".delta", ".part.updated", "message.updated")))]
    results[tag] = {"events": got, "words": words}
    print(tag, "words:", words, flush=True)
    for g in got:
        print("   ", g, flush=True)
    if mode == "turn" and expect is not None:
        ok = words[-1] == expect
        checks.append((tag, ok))
        print(f"{'PASS' if ok else 'FAIL'}  {tag} leaves {expect!r} (saw {words})", flush=True)


t = common.Tui(out, [binp] if v1 else [binp, "--standalone"], work, env, keep=30)
try:
    print(label, mode, "ready", t.wait("stub", 40), flush=True)
    time.sleep(3)
    t.cap("start")
    print("start:", [(e["kind"], e["name"], e["pid"], e["claim"]) for e in events()], flush=True)
    step("prompt", "Reply with the word ONE.", expect="done")
    step("approve", f'STUB:CALL {SHELL} {{"command": "touch a.txt", "description": "approve"}}', expect="done")
    step("reject", f'STUB:CALL {SHELL} {{"command": "touch b.txt", "description": "reject"}}', answer="reject",
         secs=25, expect="done")
    step("toolfail", "STUB:CALL read " + json.dumps({"filePath" if v1 else "path": "missing/nothing.txt"}),
         expect="done")
    step("modelfail", "STUB:FAIL 400", secs=30, expect="done")
    q = {"questions": [{"question": "Pick one?", "header": "Pick", "options": [
        {"label": "Alpha", "description": "first"}, {"label": "Beta", "description": "second"}]}]}
    step("question", "STUB:CALL question " + json.dumps(q), dialog="enter submit", secs=30, expect="done")
    sub = (("task", {"description": "child", "prompt": "say hi", "subagent_type": "general"}) if v1 else
           ("subagent", {"description": "child", "prompt": "say hi", "agent": "general"}))
    step("subagent", f"STUB:CALL {sub[0]} {json.dumps(sub[1])}", secs=60, expect="done")
    record_before = read_record()
    # The sleep keeps the session's own turn running after the nested run
    # ended: a `done` the nested run wrote would show before the last word.
    nested = f"'{binp}' run 'nested hi'; sleep 4; env > shellenv.txt"
    step("nested", f"STUB:CALL {SHELL} " + json.dumps({"command": nested, "description": "nested"}), secs=90,
         expect="done")
    record_after = read_record()
    shell_env = {}
    try:
        for line in open(os.path.join(work, "shellenv.txt")):
            k, _, v = line.rstrip("\n").partition("=")
            if k.endswith(("OPENCODE_SESSION", "TAB_UID", "TAB_AGENT")) or k == "PROBE_SHELL_MARK":
                shell_env[k] = v
    except OSError:
        pass
    print("nested: session record", record_before, "->", record_after, "| shell env", shell_env, flush=True)
    if mode == "turn":
        words = results["nested"]["words"]
        cut = words.index("working") if "working" in words else len(words)
        ok = record_before == record_after and "done" not in words[cut:-1]
        checks.append(("nested", ok))
        print(f"{'PASS' if ok else 'FAIL'}  the nested run moves neither record ({words})", flush=True)
    t.keys("C-c", pause=1)
    t.keys("C-c", pause=3)
    n0 = len(events())
    t.cap("exit")
    results["exit"] = {"words": [turn_word()]}
    print("exit word:", turn_word(), flush=True)
finally:
    t.close()
    stub.terminate()
common.write_json(os.path.join(out, "result.json"), results)
rec = os.path.join(live, oc.UID)
print("session record:", open(rec).read().strip() if os.path.exists(rec) else None)
if mode == "turn":
    sys.exit(0 if checks and all(ok for _, ok in checks) else 1)
