"""What a remote-host Chat could read of a Muse tab over SFTP, offline.

    python3 -I scripts/verify-cli/muse/remote.py <label> <bin>
    → tmp/verify-cli/muse/<label>/remote/ (frames, remote.log)

The desktop Chat of a tab that runs on a remote project's host reads the
host's store over SFTP only (`services::remote::remote_transcript::muse`): it
never runs a command there and has no hook on the host. This runs two tabs
(made-up tab variables, as `ssh_exec::remote_command` exports them) in one
folder, `--provider echo`, and prints from `/proc` and the store — what SFTP
can read on a Linux host:

* the processes whose `environ` carries each tab's launch id, and the files
  of the Muse home they hold open (a held `session.jsonl` would name the
  session without a guess), and their `/proc/locks` entries;
* the `pid` in each session log's `route_facts` record against those pids,
  and the log's `workspace_root`;
* a session folder's files across a turn (is the log append-only, are there
  temp files, does the size ever shrink) and whether a copy taken while a
  turn writes parses (partial last line);
* a `/clear` (a new session in the same process) and a relaunch with
  `resume <id>` (a new process on an old session).

Copy `<bin>` into a read-only directory first. The scratch home and echo
provider are the harness's; nothing here touches the user's own Muse store.
"""
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import common  # noqa: E402

UID1 = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b01"
UID2 = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b02"


def pids_of(uid):
    marker = f"{common.ENV_PREFIX}TAB_UID={uid}".encode()
    out = []
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            with open(f"/proc/{pid}/environ", "rb") as f:
                if marker in f.read().split(b"\0"):
                    out.append(int(pid))
        except OSError:
            pass
    return sorted(out)


def cmd(pid):
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            return f.read().replace(b"\0", b" ").decode("utf8", "replace")[:70]
    except OSError:
        return "?"


def fds(pid, home):
    out = []
    try:
        for fd in sorted(os.listdir(f"/proc/{pid}/fd"), key=int):
            try:
                t = os.readlink(f"/proc/{pid}/fd/{fd}")
            except OSError:
                continue
            if t.startswith(home) and "/skills/" not in t:
                out.append(f"{fd}:{t[len(home):]}")
    except OSError:
        pass
    return out


def locks(pids):
    try:
        with open("/proc/locks") as f:
            return [ln.strip() for ln in f if any(f" {p} " in ln for p in pids)]
    except OSError:
        return []


def logs(home):
    root = os.path.join(home, ".local", "share", "muse", "sessions")
    out = []
    for d, _, files in os.walk(root):
        if "session.jsonl" in files:
            out.append(d)
    return sorted(out, key=lambda d: os.path.basename(d))


def route_facts(log):
    """(pid, cwd, workspace_root) from the head of a session log."""
    pid = cwd = root = None
    with open(os.path.join(log, "session.jsonl")) as f:
        for i, line in enumerate(f):
            if i > 60:
                break
            if '"route_facts"' in line:
                try:
                    rec = json.loads(line)["payload"]["record"]
                    pid, cwd = rec.get("pid"), rec.get("cwd")
                except (ValueError, KeyError):
                    pass
            if '"workspace_root"' in line:
                try:
                    root = json.loads(line)["payload"]["record"]["workspace_root"]
                except (ValueError, KeyError):
                    pass
    return pid, cwd, root


def listing(log):
    return sorted((n, os.path.getsize(os.path.join(log, n))) for n in os.listdir(log))


def main(label, binp):
    base = common.out_dir("muse", label, "remote")
    home = os.path.join(base, "home")
    work = os.path.join(home, "work")
    os.makedirs(work, exist_ok=True)
    log = open(os.path.join(base, "remote.log"), "w")

    def say(*a):
        line = " ".join(str(x) for x in a)
        print(line)
        log.write(line + "\n")
        log.flush()

    def launch(name, uid, args=()):
        env = common.scratch_env(home, {"MUSE_NO_AUTO_UPDATE": "1", common.ENV_PREFIX + "TAB_UID": uid,
                                        common.ENV_PREFIX + "TAB_AGENT": "muse"})
        out = common.out_dir("muse", label, "remote", name)
        return common.Tui(out, [binp, "--provider", "echo", "--disable-sandbox", *args], work, env, size=(110, 32), keep=60)

    def settle(t, secs=60):
        t0, calm = time.time(), 0
        while time.time() - t0 < secs:
            calm = calm + 1 if "esc to interrupt" not in t.plain() else 0
            if calm >= 3:
                return
            time.sleep(1)

    def turn(t, text):
        t.type(text)
        t.keys("Enter")
        time.sleep(2)
        settle(t)

    def report(what, uids):
        say(f"--- {what}")
        for i, uid in enumerate(uids, 1):
            pids = pids_of(uid)
            say(f"tab {i}: pids {pids}")
            for pid in pids:
                say("   ", pid, cmd(pid))
                say("    held:", fds(pid, home))
            say("    locks:", locks(pids))
        for d in logs(home):
            say("  session", os.path.basename(d), "route_facts/workspace", route_facts(d), listing(d))

    tabs = []
    try:
        t1 = launch("tab1", UID1)
        tabs.append(t1)
        time.sleep(6)
        t1.keys("Enter")  # the trust question
        time.sleep(6)
        report("tab 1 launched, no prompt", [UID1])
        turn(t1, "first prompt of tab one")
        report("tab 1, one turn", [UID1])
        t2 = launch("tab2", UID2)
        tabs.append(t2)
        time.sleep(8)
        turn(t2, "first prompt of tab two")
        report("tab 2 in the same folder, one turn", [UID1, UID2])
        # A copy taken while a turn writes: sample the log's size and tail.
        d1 = next(d for d in logs(home) if route_facts(d)[0] in pids_of(UID1))
        path = os.path.join(d1, "session.jsonl")
        t1.type("a second prompt of tab one")
        t1.keys("Enter")
        sizes, bad = [], 0
        t0 = time.time()
        while time.time() - t0 < 12:
            with open(path, "rb") as f:
                data = f.read()
            sizes.append(len(data))
            tail = data.rsplit(b"\n", 1)[-1]
            if tail:
                bad += 1
            time.sleep(0.05)
        say("log sizes while a turn ran: monotonic", sizes == sorted(sizes), "first", sizes[0], "last", sizes[-1],
            "reads ending mid-line", bad, "of", len(sizes))
        settle(t1)
        turn(t1, "/clear")
        turn(t1, "prompt after clear")
        report("tab 1 after /clear and a prompt", [UID1, UID2])
        sid = os.path.basename(d1)
        for t in tabs:
            t.close()
        tabs = []
        time.sleep(1)
        report("both quit", [UID1, UID2])
        t3 = launch("tab1r", UID1, ["resume", sid])
        tabs.append(t3)
        time.sleep(8)
        report("tab 1 relaunched with resume <first session>, no prompt", [UID1])
        turn(t3, "prompt after resume")
        report("tab 1 resumed, one turn", [UID1])
    finally:
        for t in tabs:
            t.close()


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], common.binary(sys.argv[2]))
