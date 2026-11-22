"""Which Codex process holds a thread's rollout open, and whose environment it has.

    python3 scripts/verify-cli/codex/rollout_fd.py <label> <bin> <port> [variant…]
    → tmp/verify-cli/codex/<label>/rollout_fd/report.json, verdict lines on stdout

What the remote-host Chat (`services::remote_transcript::codex`) leans on: it
names a remote Codex tab's rollout without a hook by finding the process whose
`/proc/<pid>/environ` carries the tab's launch id and reading its open files
(`/proc/<pid>/fd/*` → `…/sessions/YYYY/MM/DD/rollout-…-<thread>.jsonl`).

Offline against `stub_openai.py`'s `/v1/responses`; two tabs share one private
`CODEX_HOME` (a host's `~/.codex`), each with its own made-up launch id, in a
work folder that is its own git root. Variants (default: all): `no-daemon`
(what a local tab gets), `default` (no flag: the shared app-server daemon),
`feature-off` (`-c features.daemon_auto_start=false`, what a remote tab gets —
a `-c` an older host build ignores, unlike the flag). At each step it records
every `codex` process with this run's `CODEX_HOME`: its parent, which tab's
launch id its environment carries, and the rollouts it holds open. Steps: each
tab idle, one answered turn per tab, 8 s later, tab 0 after `/new` (0.171.0
asks where the new chat runs: this worktree), its next turn. Daemons this run
started are killed at the end.

0.171.0: the rollout appears with the first turn and stays open while the TUI
runs, the old one too after `/new`. In-process (`no-daemon`, `feature-off`)
each TUI holds only its own tab's; under `default` the first tab's app-server
holds both tabs' with the first tab's environment.
"""
import glob
import os
import re
import signal
import subprocess
import sys
import time
import uuid

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import common  # noqa: E402

label, binp, port = sys.argv[1], common.binary(sys.argv[2]), int(sys.argv[3])
out = common.out_dir("codex", label, "rollout_fd")
VAR = common.ENV_PREFIX + "TAB_UID"
ROLLOUT = re.compile(r"/sessions/\d{4}/\d{2}/\d{2}/rollout-.*-([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$")


def environ(pid):
    try:
        with open(f"/proc/{pid}/environ", "rb") as f:
            return f.read().split(b"\0")
    except OSError:
        return []


def procs(codex_home, _unused):
    """Every codex process of this run (its CODEX_HOME in the environment)."""
    found = []
    mark = f"CODEX_HOME={codex_home}".encode()
    for d in glob.glob("/proc/[0-9]*"):
        pid = int(os.path.basename(d))
        try:
            exe = os.path.basename(os.readlink(f"{d}/exe"))
        except OSError:
            continue
        if not exe.startswith("codex"):
            continue
        env = environ(pid)
        if mark not in env:
            continue
        held = []
        for fd in glob.glob(f"{d}/fd/*"):
            try:
                target = os.readlink(fd)
            except OSError:
                continue
            m = ROLLOUT.search(target)
            if m:
                held.append(m.group(1))
        try:
            with open(f"{d}/stat") as f:
                ppid = int(f.read().rsplit(")", 1)[1].split()[1])
            with open(f"{d}/cmdline", "rb") as f:
                argv = [a.decode(errors="replace") for a in f.read().split(b"\0") if a]
        except OSError:
            continue
        ids = [v.split(b"=", 1)[1].decode() for v in env if v.startswith(f"{VAR}=".encode())]
        found.append({"pid": pid, "ppid": ppid, "exe": exe, "argv": argv[1:6], "env_ids": ids,
                      "rollouts_open": sorted(set(held))})
    return found


def rollouts(codex_home):
    return sorted(ROLLOUT.search(p).group(1) for p in
                  glob.glob(os.path.join(codex_home, "sessions", "*", "*", "*", "rollout-*.jsonl")))


def turn(t, text, secs=40):
    """Send one prompt and wait for the stub's answer to it (answers counted)."""
    before = t.plain().count("stub answer done")
    t.type(text)
    t.keys("Enter")
    t0 = time.time()
    while time.time() - t0 < secs and t.plain().count("stub answer done") <= before:
        time.sleep(0.25)
    time.sleep(2)


def new_thread(t, name):
    """`/new`, the frame after it saved: the screen must lose the earlier turn."""
    t.type("/new")
    time.sleep(0.8)
    t.cap(f"{name}-popup")
    t.keys("Enter")
    time.sleep(2)
    # 0.171.0 asks where the new conversation runs (this worktree or a new one).
    if "Where should the new conversation run?" in t.plain():
        t.cap(f"{name}-where")
        t.keys("Enter")
        time.sleep(2)
    t.cap(f"{name}-after")


def home_for(variant):
    home = common.out_dir("codex", label, f"h-fd-{variant}-{int(time.time())}")
    work, codex_home = os.path.join(home, "work"), os.path.join(home, ".codex")
    os.makedirs(work, exist_ok=True)
    os.makedirs(codex_home, exist_ok=True)
    subprocess.run(["git", "init", "-q", work], check=True)
    subprocess.run(["git", "-C", work, "commit", "-q", "--allow-empty", "-m", "probe"], check=True,
                   env={**os.environ, "GIT_AUTHOR_NAME": "p", "GIT_AUTHOR_EMAIL": "p@p", "GIT_COMMITTER_NAME": "p",
                        "GIT_COMMITTER_EMAIL": "p@p"})
    with open(os.path.join(codex_home, "config.toml"), "w") as f:
        f.write(f'model = "stub"\nmodel_provider = "stub"\napproval_policy = "never"\nsandbox_mode = "read-only"\n\n'
                f'[model_providers.stub]\nname = "stub"\nbase_url = "http://127.0.0.1:{port}/v1"\n'
                f'env_key = "STUB_API_KEY"\nwire_api = "responses"\nrequires_openai_auth = false\n'
                f'supports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n\n'
                f'[projects."{work}"]\ntrust_level = "trusted"\n')
    return home, work, codex_home


def tab(home, work, codex_home, args, name):
    launch_id = str(uuid.uuid4())
    env = common.scratch_env(home, {"CODEX_HOME": codex_home, "STUB_API_KEY": "stub", VAR: launch_id,
                                    "PATH": os.environ.get("PATH", "/usr/bin:/bin")})
    t = common.Tui(out, [binp, *args], work, env, size=(110, 36))
    t.wait("? for shortcuts", 40)
    time.sleep(2)
    return t, launch_id


def run(variant, args, tabs):
    """`tabs` CLIs on one CODEX_HOME (a host's shared `~/.codex`)."""
    home, work, codex_home = home_for(variant)
    steps, open_tabs = [], []

    def snap(name):
        found = procs(codex_home, None)
        for p in found:
            p["tab"] = [n for n, (_, lid) in enumerate(open_tabs) if p["env_ids"] and lid in p["env_ids"]]
            del p["env_ids"]
        steps.append({"step": name, "on_disk": rollouts(codex_home), "procs": found})

    try:
        for n in range(tabs):
            open_tabs.append(tab(home, work, codex_home, args, variant))
            snap(f"tab{n}-idle")
        for n, (t, _) in enumerate(open_tabs):
            turn(t, f"say hi tab{n}")
            snap(f"tab{n}-turn")
        time.sleep(6)
        snap("+8s")
        t0 = open_tabs[0][0]
        new_thread(t0, f"{variant}-new")
        snap("tab0-after-new")
        turn(t0, "say hi again")
        snap("tab0-turn-after-new")
        for n, (t, _) in enumerate(open_tabs):
            t.cap(f"{variant}-tab{n}-end")
    finally:
        for t, _ in open_tabs:
            t.close()
        time.sleep(1.5)
        # A daemon outlives its TUI by design: this run's ones go now.
        for p in procs(codex_home, None):
            try:
                os.kill(p["pid"], signal.SIGTERM)
            except OSError:
                pass
    return {"variant": variant, "args": args, "launch_ids": [lid for _, lid in open_tabs], "steps": steps}


stub = common.start_stub("stub_openai.py", port, os.path.join(out, "stub.jsonl"))
try:
    variants = {"no-daemon": ["--no-daemon"], "default": [],
                "feature-off": ["-c", "features.daemon_auto_start=false"]}
    wanted = sys.argv[4:] or list(variants)
    report = [run(v, variants[v], 2) for v in wanted]
finally:
    stub.terminate()
common.write_json(os.path.join(out, "report.json"), report)
for r in report:
    for s in r["steps"]:
        holders = [f'{p["pid"]}(ppid {p["ppid"]}, env of tab {p["tab"]}, '
                   f'argv={" ".join(p["argv"][:3])}) open={[x[-6:] for x in p["rollouts_open"]]}' for p in s["procs"]]
        print(f'{r["variant"]:9} {s["step"]:10} disk={[x[-6:] for x in s["on_disk"]]} ' + "; ".join(holders))
