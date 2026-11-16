"""Which Muse hook events fire, offline (`--provider echo`), for the turn record.

Usage: turns.py events <label> <bin>
       turns.py shared <label> <bin>

`events`: registers a dumping hook on every event the binary names (each
event its own command: Muse refuses a reused hook source) and walks one tab:
a launch, a turn, a slow turn (`--echo-delay-ms`) interrupted with Esc, a `!`
shell escape, a `muse exec` run from it, `/compact`, `/clear` and a turn,
quitting, then `resume <id>` with a turn. The SessionStart dumper also prints
an `additionalContext` marker, and the session log is searched for it (the
send hint's way to the model). Prints, per step, which events
fired, with the payload fields the turn record would key on.

`shared`: one script registered for several events under the same command
string, as the app registers it — whether Muse runs it for each, or refuses
the reused source.

The dumping hooks write only into the scratch home (`hook.log`). The tab
variables are unset, as in every probe. The echo provider makes no tool calls,
so an approval wait and a model tool call are out of reach here.
"""
import json
import os
import re
import shlex
import shutil
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import common  # noqa: E402

# Every hook event the 1.4.15 binary names (its HookEventKind list, plus the
# two Claude-named ones it also dispatches).
EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse",
          "PostToolUseFailure", "ToolUseStart", "PostToolBatch", "PreLLMCall", "PostLLMCall",
          "PreCompact", "PostCompact", "SubagentStart", "SubagentStop", "Notification", "Stop",
          "StopFailure", "Interrupt", "SessionEnd", "SessionFork"]
MARK = "STUBMARK-SESSIONSTART-CONTEXT"
KEYS = ("session_id", "source", "reason", "post_stop", "notification_type", "agent_id", "stop_hook_active",
        "permission_mode", "trigger", "error", "tool_name")


def dumper(home, name, event, context=False):
    path = os.path.join(home, f"{name}.sh")
    ctx = ""
    if context:
        ctx = ('printf \'%s\\n\' \'{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"'
               + MARK + '"}}\'\n')
    # One file per run: Muse runs hooks concurrently, and appends to one log
    # interleave. Named by the clock, so a listing sorts by firing order.
    with open(path, "w") as f:
        f.write('#!/bin/sh\nd="$HOME/hooklog"; mkdir -p "$d"; f="$d/$(date +%s%N)-$$"\n'
                '{ printf "%s sid_env=%s\\n" "$1" "${MUSE_SESSION_ID-}"; cat; echo; } > "$f.tmp" && mv "$f.tmp" "$f"\n' + ctx)
    os.chmod(path, 0o755)
    return f"{shlex.quote(path)} {event}"


def settings(home, hooks):
    cfg = os.path.join(home, ".config", "muse")
    os.makedirs(cfg, exist_ok=True)
    common.write_json(os.path.join(cfg, "settings.json"), {"schema_version": 1, "hooks": hooks})


def read_events(home, start):
    """(head, payload) of every hook run after the `start`-th, in firing order."""
    d = os.path.join(home, "hooklog")
    names = sorted(n for n in os.listdir(d) if not n.endswith(".tmp")) if os.path.isdir(d) else []
    out = []
    for n in names[start:]:
        head, _, payload = open(os.path.join(d, n)).read().partition("\n")
        try:
            obj = json.loads(payload)
        except ValueError:
            obj = {"unparsed": payload[:200]}
        out.append((head, obj))
    return out, len(names)


def tail(sid):
    return sid[-6:] if isinstance(sid, str) else sid


def show(home, pos, what):
    evs, end = read_events(home, pos)
    print(f"--- {what}")
    lines = []
    for head, d in evs:
        event, _, env = head.partition(" ")
        # A reminder subagent's model calls carry its own session: noise here.
        if event in ("PreLLMCall", "PostLLMCall") and tail(d.get("session_id")) != tail(env.partition("=")[2]):
            continue
        fields = {k: (tail(d[k]) if k == "session_id" else d[k]) for k in KEYS if k in d}
        extra = sorted(k for k in d if k not in KEYS and k not in ("cwd", "hook_event_name", "transcript_path", "model",
                                                                    "turn_id", "messages", "tools", "options", "usage"))
        line = f"{event:<18} env={tail(env.partition('=')[2]) or '-':<7} {json.dumps(fields)} other={extra}"
        # Runs of the same line (a reminder subagent's model calls) fold into one.
        if lines and lines[-1][0] == line:
            lines[-1][1] += 1
        else:
            lines.append([line, 1])
    for line, n in lines:
        print(f"    {line}" + (f" x{n}" if n > 1 else ""))
    return end


def launch(label, name, home, work, binp, args, size=(110, 32)):
    env = common.scratch_env(home, {"MUSE_NO_AUTO_UPDATE": "1"})
    return common.Tui(common.out_dir("muse", label, "turns", name), [binp, "--provider", "echo", *args],
                      work, env, size=size, keep=30)


def settle(t, secs=90):
    """Wait until the TUI is back at rest: no "esc to interrupt" (a turn, or
    the reminder subagents' "Double checking" after it) on two looks running."""
    t0, calm = time.time(), 0
    while time.time() - t0 < secs:
        calm = calm + 1 if "esc to interrupt" not in t.plain() else 0
        if calm >= 3:
            return True
        time.sleep(1)
    return False


def turn(t, text, secs=2):
    t.type(text)
    t.keys("Enter")
    time.sleep(secs)
    return settle(t)


def main_events(label, binp):
    base = common.out_dir("muse", label, "turns")
    shutil.rmtree(base, ignore_errors=True)
    home = common.out_dir("muse", label, "turns", "home")
    work = os.path.join(home, "work")
    os.makedirs(work, exist_ok=True)
    # Muse admits `Interrupt` and `ToolUseStart` handlers only with `async: true`.
    hooks = {e: [{"hooks": [{"type": "command", "command": dumper(home, f"dump_{e}", e, e == "SessionStart"),
                             **({"async": True} if e in ("Interrupt", "ToolUseStart") else {})}]}]
             for e in EVENTS}
    settings(home, hooks)
    pos = 0
    t = launch(label, "main", home, work, binp, ["--disable-sandbox"])
    try:
        time.sleep(6)
        t.keys("Enter")  # the trust question
        time.sleep(6)
        t.cap("start")
        pos = show(home, pos, "launch, no prompt")
        print("settled", turn(t, "first turn"))
        t.cap("turn")
        pos = show(home, pos, "a turn")
        print("settled", turn(t, "!echo shell-escape-ran"))
        t.cap("shell")
        pos = show(home, pos, "a ! shell escape")
        nested = f"!{shlex.quote(binp)} exec --provider echo --disable-sandbox nested-run"
        print("settled", turn(t, nested, 8))
        t.cap("nested")
        pos = show(home, pos, "muse exec from the ! escape")
        print("settled", turn(t, "/compact", 6))
        t.cap("compact")
        pos = show(home, pos, "/compact")
        print("settled", turn(t, "/clear", 4))
        t.cap("clear")
        pos = show(home, pos, "/clear")
        print("settled", turn(t, "after clear"))
        t.cap("after_clear")
        pos = show(home, pos, "a turn after /clear")
        turn(t, "/exit", 4)
        t.cap("exit")
        pos = show(home, pos, "/exit")
    finally:
        t.close()
    time.sleep(1)
    evs, _ = read_events(home, 0)
    sid = next((d.get("session_id") for h, d in reversed(evs) if h.startswith("UserPromptSubmit")), None)
    t = launch(label, "resume", home, work, binp, ["--echo-delay-ms", "15000", "resume", sid or "-"])
    try:
        time.sleep(8)
        t.cap("resumed")
        pos = show(home, pos, "resume <id>, no prompt")
        t.type("slow turn")
        t.keys("Enter")
        time.sleep(4)
        t.keys("Escape")
        time.sleep(3)
        t.cap("interrupted")
        settle(t)
        pos = show(home, pos, "a 15 s turn interrupted with Esc after 4 s")
        t.keys("C-c")
        time.sleep(1)
        t.keys("C-c")
        time.sleep(5)
        t.cap("ctrl_c")
        pos = show(home, pos, "Ctrl+C twice")
    finally:
        t.close()
    time.sleep(1)
    t = launch(label, "untrusted", home, work, binp, ["--approval-mode", "untrusted"])
    try:
        time.sleep(8)
        print("settled", turn(t, "!touch approval-probe"))
        t.cap("approval")
        pos = show(home, pos, "a ! command under --approval-mode untrusted")
        turn(t, "/exit", 4)
        pos = show(home, pos, "/exit")
    finally:
        t.close()
    hits = []
    for root, _, files in os.walk(os.path.join(home, ".local", "share", "muse", "sessions")):
        for f in files:
            p = os.path.join(root, f)
            try:
                if MARK in open(p, errors="replace").read():
                    hits.append(os.path.relpath(p, home))
            except OSError:
                pass
    print("SessionStart additionalContext in the session logs:", hits or "nowhere")
    print("home", home)


def main_shared(label, binp):
    base = common.out_dir("muse", label, "shared")
    shutil.rmtree(base, ignore_errors=True)
    home = common.out_dir("muse", label, "shared", "home")
    work = os.path.join(home, "work")
    os.makedirs(work, exist_ok=True)
    cmd = dumper(home, "one", "shared").rsplit(" ", 1)[0]
    # The app's registration: one command on each of its events, `Interrupt`
    # async (Muse admits it no other way).
    settings(home, {e: [{"hooks": [{"type": "command", "command": cmd, **({"async": True} if e == "Interrupt" else {})}]}]
                    for e in ("SessionStart", "UserPromptSubmit", "Stop", "Interrupt", "SessionEnd")})
    t = launch(label, "shared", home, work, binp, ["--echo-delay-ms", "6000"])
    try:
        time.sleep(6)
        t.keys("Enter")
        time.sleep(6)
        t.cap("start")
        print(t.plain())
        print("settled", turn(t, "shared turn"))
        t.cap("turn")
        t.type("interrupted turn")
        t.keys("Enter")
        time.sleep(3)
        t.keys("Escape")
        time.sleep(3)
        settle(t)
        t.cap("interrupted")
        turn(t, "/exit", 4)
    finally:
        t.close()
    evs, _ = read_events(home, 0)
    print("events run through the one command:", [d.get("hook_event_name") for _, d in evs])


if __name__ == "__main__":
    if len(sys.argv) != 4 or sys.argv[1] not in ("events", "shared"):
        sys.exit(__doc__)
    {"events": main_events, "shared": main_shared}[sys.argv[1]](sys.argv[2], common.binary(sys.argv[3]))
