"""What a Copilot tab leaves on a remote host that the desktop Reader can read over SFTP.

    python3 scripts/verify-cli/copilot/remote_store.py <label> <copilot-bin> [port] [case ...]
    → tmp/verify-cli/copilot/<label>/remote-store/{result.json,tree-*.txt,stub.jsonl}

A remote tab's Copilot runs on the host with the tab's launch id in its
environment (`TAB_UID`, exported by `ssh_exec::remote_command`) and, when the
launch pins it, `--session-id <launch id>`. The app never runs a command on
the host: it can list and read files over SFTP, and read `/proc/<pid>/environ`.
This walks one pinned session and answers, for
`services/remote/remote_transcript/copilot.rs`:

  * what the session store holds, before and after the first prompt, and which
    files the CLI holds open in it (the app copies only `events.jsonl`);
  * whether `events.jsonl` only ever grows (the bytes an earlier read copied
    stay the same through a second prompt, `/compact` and `/new`): the
    incremental copy depends on it;
  * what `/new` does to the pinned id (a second folder, the first one kept);
  * where an unpinned launch writes (a fresh uuid the tab cannot name) and
    which process environment carries the tab's id;
  * where the store lands with no `COPILOT_HOME`, with `HOME` changed
    (`agent_home`) and with `XDG_*` pointing elsewhere;
  * that a second launch with the same pin resumes the same folder;
  * a `copilot -p` run from the session's own shell tool (`nested`): it
    inherits the tab's id, gets a session folder and lock of its own, and
    is told apart by `COPILOT_AGENT_SESSION_ID` in its environment.

Offline: BYOK against stub_openai.py, auto-update off, a scratch home per
case. The tab variable is set to a made-up id; nothing here touches a real
home or tab.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import common  # noqa: E402

UID = "cccccccc-1111-4222-8333-dddddddddddd"

if len(sys.argv) < 3:
    sys.exit(__doc__)
label, binp = sys.argv[1], common.binary(sys.argv[2])
rest = sys.argv[3:]
port = int(rest.pop(0)) if rest and rest[0].isdigit() else 18612
cases = set(rest) or {"pinned", "unpinned", "homeonly", "nested", "resume"}  # homeonly also runs xdg
out = common.out_dir("copilot", label, "remote-store")
os.makedirs(out, exist_ok=True)
log = os.path.join(out, "stub.jsonl")
stub = common.start_stub("stub_openai.py", port, log)
if stub.poll() is not None:
    sys.exit(f"the stub did not start on port {port}")
result = {}


def tree(root):
    """Every file below `root` with its size, sorted."""
    rows = []
    for d, dirs, files in os.walk(root):
        dirs.sort()
        for f in sorted(files):
            p = os.path.join(d, f)
            rows.append((os.path.relpath(p, root), os.path.getsize(p)))
    return rows


def digest(path, n):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read(n)).hexdigest()


def tab_pids(uid):
    """Processes whose environment carries `TAB_UID=<uid>`, with their command line."""
    mark = f"{common.ENV_PREFIX}TAB_UID={uid}".encode()
    found = []
    for pid in filter(str.isdigit, os.listdir("/proc")):
        try:
            env = open(f"/proc/{pid}/environ", "rb").read()
            cmd = open(f"/proc/{pid}/cmdline", "rb").read().replace(b"\0", b" ").decode(errors="replace")
        except OSError:
            continue
        if mark in env.split(b"\0"):
            found.append({"pid": int(pid), "cmd": cmd[:160],
                          "COPILOT_AGENT_SESSION_ID": b"COPILOT_AGENT_SESSION_ID=" in env})
    return found


def open_files(pid, under):
    """Files process `pid` holds open below `under`."""
    rows = []
    try:
        for fd in os.listdir(f"/proc/{pid}/fd"):
            try:
                target = os.readlink(f"/proc/{pid}/fd/{fd}")
            except OSError:
                continue
            if target.startswith(under):
                rows.append(os.path.relpath(target, under))
    except OSError:
        pass
    return sorted(rows)


def wait_ready(t):
    t0 = time.time()
    while time.time() - t0 < 60:
        p = t.plain()
        if "trust" in p.lower() and "Yes" in p:
            t.keys("Enter")
            time.sleep(1)
        elif "❯" in p and "Interactive" in p:
            break
        time.sleep(0.3)
    time.sleep(2)


def start(case, extra_env=None, args=None, tab=True, copilot_home=True, keep_home=False):
    home = os.path.join(out, f"h-{case}")
    if not keep_home:
        shutil.rmtree(home, ignore_errors=True)
    work = os.path.join(home, "work")
    os.makedirs(work, exist_ok=True)
    subprocess.run(["git", "init", "-q", work], check=False)
    env = common.scratch_env(home, {
        "COPILOT_AUTO_UPDATE": "false",
        "COPILOT_PROVIDER_BASE_URL": f"http://127.0.0.1:{port}/v1",
        "COPILOT_PROVIDER_API_KEY": "test", "COPILOT_MODEL": "stub",
        **(extra_env or {}),
    })
    if copilot_home:
        env["COPILOT_HOME"] = f"{home}/.copilot"
    if tab:
        env[common.ENV_PREFIX + "TAB_UID"] = UID
    t = common.Tui(out, [binp, "--disable-client-telemetry", *(args or [])], work, env, size=(110, 40), keep=20)
    wait_ready(t)
    return t, home


def say(t, text):
    t.type(text)
    t.keys("Enter")
    time.sleep(0.5)
    t0 = time.time()
    while time.time() - t0 < 40:
        p = t.plain()
        if "esc" not in (p.splitlines() or [""])[-1].lower() and "❯" in p:
            break
        time.sleep(0.4)
    time.sleep(1.5)


def dump(name, root):
    rows = tree(root)
    with open(os.path.join(out, f"tree-{name}.txt"), "w") as f:
        f.write("\n".join(f"{n}\t{s}" for n, s in rows) + "\n")
    return rows


def folders(store):
    return sorted(d for d in os.listdir(store) if not d.startswith("."))


# 1. A pinned tab: the layout, what is open, and whether events.jsonl only grows.
def case_pinned():
    t, home = start("pinned", args=["--session-id", UID])
    store = os.path.join(home, ".copilot", "session-state")
    ev = os.path.join(store, UID, "events.jsonl")
    try:
        r = result["pinned"] = {}
        r["before_prompt"] = dump("pinned-0", store) if os.path.isdir(store) else None
        say(t, "Reply with the word ONE.")
        r["after_one"] = dump("pinned-1", store)
        stages = [("one", os.path.getsize(ev))]
        stages_digest = {"one": digest(ev, stages[0][1])}
        r["procs"] = tab_pids(UID)
        r["open_files"] = {str(p["pid"]): open_files(p["pid"], store) for p in r["procs"]}
        for name, action in (("two", "Reply with the word TWO."), ("compact", "/compact"), ("new", "/new"),
                             ("three", "Reply with the word THREE.")):
            say(t, action)
            size = os.path.getsize(ev)
            # Every earlier stage's bytes are still the file's prefix: append-only.
            kept = all(digest(ev, n) == stages_digest[s] for s, n in stages)
            r[f"after_{name}"] = {"size": size, "grew": size > stages[-1][1], "earlier_prefixes_kept": kept}
            stages.append((name, size))
            stages_digest[name] = digest(ev, size)
        r["folders_after_new"] = folders(store)
        for d in r["folders_after_new"]:
            try:
                first = json.loads(open(os.path.join(store, d, "events.jsonl")).readline())
                r.setdefault("session_start", {})[d] = {"type": first.get("type"), "id": (first.get("data") or {}).get("sessionId"),
                                                      "alreadyInUse": (first.get("data") or {}).get("alreadyInUse")}
            except OSError:
                pass
        r["after_new_tree"] = dump("pinned-2", store)
        r["procs_after_new"] = tab_pids(UID)
        r["workspace_yaml"] = open(os.path.join(store, UID, "workspace.yaml")).read()
        # The marker of a live CLI: `inuse.<pid>.lock` holds the pid.
        r["lock_contents"] = {os.path.relpath(os.path.join(d, f), store): open(os.path.join(d, f)).read()
                              for d, _, fs in os.walk(store) for f in fs if f.endswith(".lock") and f.startswith("inuse.")}
        cdir = os.path.join(home, ".copilot")
        r["open_sessions_state_live"] = json.load(open(os.path.join(cdir, "open-sessions-state.json")))
        say(t, "/exit")
        time.sleep(2)
        r["after_exit_tree"] = [n for n, _ in tree(store) if "inuse" in n]
        try:
            r["open_sessions_state_after_exit"] = json.load(open(os.path.join(cdir, "open-sessions-state.json")))
        except (OSError, ValueError) as e:
            r["open_sessions_state_after_exit"] = str(e)
    finally:
        t.close()
    print("pinned:", json.dumps({k: v for k, v in result["pinned"].items() if k != "workspace_yaml"}, indent=1)[:4000], flush=True)



# 2. An unpinned launch: the folder is a fresh uuid; the environment still names the tab.
def case_unpinned():
    t, home = start("unpinned")
    try:
        store = os.path.join(home, ".copilot", "session-state")
        say(t, "Reply with the word ONE.")
        r = result["unpinned"] = {"folders": folders(store), "procs": tab_pids(UID)}
        r["has_uid_folder"] = UID in r["folders"]
    finally:
        t.close()
    print("unpinned:", json.dumps(result["unpinned"]), flush=True)



# 3. Where the store lands without COPILOT_HOME: HOME changed (the host's agent_home), and with
# XDG_CONFIG_HOME / XDG_STATE_HOME pointing at folders of their own.
def case_homeonly():
    for case, xdg in (("homeonly", None), ("xdg", os.path.join(out, "xdg"))):
        extra = {} if xdg is None else {f"XDG_{k}_HOME": os.path.join(xdg, k.lower()) for k in ("CONFIG", "STATE", "DATA", "CACHE")}
        for d in extra.values():
            os.makedirs(d, exist_ok=True)
        t, home = start(case, args=["--session-id", UID], copilot_home=False, extra_env=extra)
        try:
            say(t, "Reply with the word ONE.")
            cdir = os.path.join(home, ".copilot")
            found = [os.path.relpath(os.path.join(d, f), out) for root in (home, xdg or home)
                     for d, _, fs in os.walk(root) for f in fs if f == "events.jsonl"]
            result[case] = {"under_HOME/.copilot": os.path.isfile(os.path.join(cdir, "session-state", UID, "events.jsonl")),
                            "events_found": sorted(set(found))}
        finally:
            t.close()
        print(case + ":", json.dumps(result[case]), flush=True)


# 4. A second launch with the same pin resumes the same folder.
def case_nested():
    t, home = start("nested", args=["--session-id", UID, "--allow-all-tools"])
    store = os.path.join(home, ".copilot", "session-state")
    try:
        byok = f"COPILOT_PROVIDER_BASE_URL=http://127.0.0.1:{port}/v1 COPILOT_PROVIDER_API_KEY=test COPILOT_MODEL=stub"
        cmd = f"env > shellenv.txt; env {byok} '{binp}' -p 'nested hi' --allow-all-tools --disable-client-telemetry; sleep 12"
        t.type("STUB:CALL bash " + json.dumps({"command": cmd, "description": "nested"}))
        t.keys("Enter")
        seen = None
        t0 = time.time()
        while time.time() - t0 < 40:
            if "Do you want to allow" in t.plain():
                t.keys("Enter")
            procs = tab_pids(UID)
            if len(procs) >= 2 and len(folders(store)) >= 2 or os.path.isfile(os.path.join(home, "work", "shellenv.txt")) and time.time() - t0 > 15:
                seen = procs
                break
            time.sleep(0.3)
        t.cap("nested")
        r = result["nested"] = {"procs": seen or tab_pids(UID), "folders": folders(store)}
        try:
            env = open(os.path.join(home, "work", "shellenv.txt")).read().splitlines()
            r["shell_env_names"] = sorted(l.split("=", 1)[0] for l in env if l.split("=", 1)[0].startswith(("COPILOT", common.ENV_PREFIX)))
        except OSError:
            r["shell_env_names"] = None
        r["locks"] = sorted(os.path.relpath(os.path.join(d, f), store) for d, _, fs in os.walk(store)
                            for f in fs if f.startswith("inuse.") and f.endswith(".lock"))
        try:
            r["open_sessions_state"] = json.load(open(os.path.join(home, ".copilot", "open-sessions-state.json")))
        except (OSError, ValueError) as e:
            r["open_sessions_state"] = str(e)
    finally:
        t.close()
    print("nested:", json.dumps(result["nested"], indent=1), flush=True)


def case_resume():
    t, home = start("resume", args=["--session-id", UID])
    store = os.path.join(home, ".copilot", "session-state")
    ev = os.path.join(store, UID, "events.jsonl")
    try:
        say(t, "Reply with the word ONE.")
        n1 = os.path.getsize(ev)
        h1 = digest(ev, n1)
    finally:
        t.close()
    time.sleep(1)
    t2, home = start("resume", args=["--session-id", UID], keep_home=True)
    try:
        say(t2, "Reply with the word TWO.")
        result["resume"] = {"folders": folders(store), "grew": os.path.getsize(ev) > n1, "prefix_kept": digest(ev, n1) == h1}
    finally:
        t2.close()
    print("resume:", json.dumps(result["resume"]), flush=True)


try:
    for name in ("pinned", "unpinned", "homeonly", "nested", "resume"):
        if name in cases:
            globals()[f"case_{name}"]()
finally:
    stub.terminate()
    common.write_json(os.path.join(out, "result.json"), result)
