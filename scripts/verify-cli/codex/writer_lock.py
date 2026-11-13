"""Codex's resume writer lock: a second writer is refused, a killed one releases.

    python3 scripts/verify-cli/codex/writer_lock.py <label> <bin> [model]
    → tmp/verify-cli/codex/<label>/lock/*.esc, verdict lines on stdout

Offline against the local Ollama (`model_provider="ollama"`, default model
`nemotron-3.5-bolt:e4b`; any pulled one works), private `CODEX_HOME`, a work
folder that is its own git root. Window A starts a thread with one prompt (the
turn need not succeed: the rollout is what matters). Window B runs
`codex resume <id>` beside it and must show the lock screen. Then A's
`codex` is SIGKILLed and window C resumes the same id, which must open without
that report. Checklist §1.2 (the binder's duplicate guard leans on this).
"""
import glob
import os
import re
import signal
import subprocess
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import common  # noqa: E402

label, binp = sys.argv[1], common.binary(sys.argv[2])
model = sys.argv[3] if len(sys.argv) > 3 else "nemotron-3.5-bolt:e4b"
out = common.out_dir("codex", label, "lock")
home = common.out_dir("codex", label, f"h-lock-{int(time.time())}")
work = os.path.join(home, "work")
codex_home = os.path.join(home, ".codex")
os.makedirs(codex_home, exist_ok=True)
os.makedirs(work, exist_ok=True)
subprocess.run(["git", "init", "-q", work], check=True)
env = common.scratch_env(home, {"CODEX_HOME": codex_home})
base = [binp, "--no-daemon", "-c", 'model_provider="ollama"', "-m", model]
# 0.167.x draws a lock screen: "🔒 This conversation is open in another app …
# r retry  f fork"; older builds printed "active writer".
WRITER = re.compile(r"open in another app|active writer", re.I)


def codex_pids(tui):
    """The `codex` processes under one tui's tmux pane (pane bash → subshell → codex)."""
    pane = subprocess.run(tui.T + ["display", "-p", "-t", "p", "#{pane_pid}"],
                          capture_output=True, text=True).stdout.strip()
    todo, found = [pane], []
    while todo:
        pid = todo.pop()
        for task in glob.glob(f"/proc/{pid}/task/*/children"):
            with open(task) as f:
                todo += f.read().split()
        try:
            exe = os.path.basename(os.readlink(f"/proc/{pid}/exe"))
        except OSError:
            continue
        if exe == "codex":
            found.append(int(pid))
    return found


def rollout_id(secs=90):
    t0 = time.time()
    while time.time() - t0 < secs:
        hits = glob.glob(os.path.join(codex_home, "sessions", "*", "*", "*", "rollout-*.jsonl"))
        if hits:
            m = re.search(r"([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$", hits[0])
            if m:
                return m.group(1)
        time.sleep(0.5)
    return None


a = b = c = None
try:
    a = common.Tui(out, base, work, env, size=(100, 40))
    if a.wait("Trust this folder", 30):
        a.keys("Enter")
    a.wait("? for shortcuts", 30)
    time.sleep(2)
    a.type("say hi")
    a.keys("Enter")
    sid = rollout_id()
    print(label, "thread", sid)
    if not sid:
        a.cap("a_no_rollout")
        sys.exit(1)
    time.sleep(3)
    a.cap("a_writer")

    b = common.Tui(out, [*base, "resume", sid], work, env, size=(100, 40))
    time.sleep(8)
    shot = b.cap("b_second")
    refused = bool(WRITER.search(shot))
    print(label, "second writer refused:", refused, "|",
          [line.strip() for line in b.plain().splitlines() if WRITER.search(line)][:3])
    b.close()
    b = None

    pids = codex_pids(a)
    for pid in pids:
        os.kill(pid, signal.SIGKILL)
    print(label, "SIGKILLed", pids)
    time.sleep(2)

    c = common.Tui(out, [*base, "resume", sid], work, env, size=(100, 40))
    time.sleep(8)
    shot = c.cap("c_after_kill")
    print(label, "resume after kill refused:", bool(WRITER.search(shot)),
          "| shows the prompt:", "say hi" in c.plain())
finally:
    for t in (a, b, c):
        if t:
            t.close()
