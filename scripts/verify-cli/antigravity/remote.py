"""What a remote-host Chat could read of an Antigravity tab over SFTP, offline.

    python3 -I scripts/verify-cli/antigravity/remote.py <label> <bin> <port>
    → tmp/verify-cli/antigravity/<label>/remote-store/ (frames, remote.log)

The desktop Chat of a tab that runs on a remote project's host reads the
host's store over SFTP only (`services::remote::remote_transcript::agy`): it
never runs a command there and has no hook on the host. This runs one tab
(made-up tab variables, as `ssh_exec::remote_command` exports them) and a
second one in the same folder, and prints, from `/proc` and the store — what
SFTP can read on a Linux host:

* which processes carry the tab's launch id in `environ`, their `cwd`, their
  open files in the store, and which of them hold `/proc/locks` entries;
* the store's files (`presence/<id>.lock`, `cache/last_conversations.json`,
  the conversation's `.db`, `-wal`, `-shm`) at idle, mid-turn and after each
  turn: sizes and whether a checkpoint folded the WAL back;
* whether `db` + `-wal` copied one after the other (no `-shm`) opens and
  reads the same prompts as the live store — the copy a mirror would make —
  while a turn writes, and the WAL header salts across the copy (what a
  mirror compares to notice a checkpoint that restarted the WAL).

Copy `<bin>` into a read-only directory first (agy updates itself in place);
the scratch home and stub are the harness's (`agy.py`). Nothing here touches
the user's own agy store.
"""
import os
import shutil
import sqlite3
import struct
import sys
import tempfile
import json
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hooks import TabAgy  # noqa: E402
from agy import common  # noqa: E402

UID1 = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a01"
UID2 = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a02"


def pids_of(uid):
    marker = f"{common.ENV_PREFIX}TAB_UID={uid}".encode()
    out = []
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            with open(f"/proc/{pid}/environ", "rb") as f:
                env = f.read()
        except OSError:
            continue
        if marker in env.split(b"\0"):
            out.append(int(pid))
    return sorted(out)


def describe(pid, store):
    def link(p):
        try:
            return os.readlink(p)
        except OSError:
            return None
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            cmd = f.read().replace(b"\0", b" ").decode("utf8", "replace")[:80]
        with open(f"/proc/{pid}/stat") as f:
            ppid = f.read().rsplit(")", 1)[1].split()[1]
    except OSError:
        return f"{pid} gone"
    fds = []
    try:
        for fd in sorted(os.listdir(f"/proc/{pid}/fd"), key=int):
            target = link(f"/proc/{pid}/fd/{fd}")
            if target and store in target:
                fds.append(f"{fd}:{target.split(store)[1]}")
    except OSError:
        pass
    return f"pid {pid} ppid {ppid} cwd {link(f'/proc/{pid}/cwd')} cmd {cmd!r}\n      store fds: {fds}"


def locks_of(pids):
    try:
        with open("/proc/locks") as f:
            return [ln.strip() for ln in f if any(f" {p} " in ln for p in pids)]
    except OSError:
        return ["(no /proc/locks)"]


def held(uid, store):
    """The conversation ids the tab's processes hold a presence lock or a database open on."""
    out = {"presence": [], "db": []}
    for pid in pids_of(uid):
        try:
            for fd in os.listdir(f"/proc/{pid}/fd"):
                try:
                    target = os.readlink(f"/proc/{pid}/fd/{fd}")
                except OSError:
                    continue
                if target.startswith(store + "/presence/") and target.endswith(".lock"):
                    out["presence"].append(os.path.basename(target)[:-5])
                elif target.startswith(store + "/conversations/") and target.endswith(".db"):
                    out["db"].append(os.path.basename(target)[:-3])
        except OSError:
            pass
    return out


def summaries(store):
    c = sqlite3.connect(f"file:{store}/conversation_summaries.db?mode=ro", uri=True)
    try:
        return c.execute("SELECT conversation_id, parent_conversation_id FROM conversation_summaries").fetchall()
    finally:
        c.close()


def stat(path):
    try:
        s = os.stat(path)
        return f"{s.st_size}b mtime {s.st_mtime:.3f}"
    except OSError:
        return "-"


def wal_salts(path):
    try:
        with open(path, "rb") as f:
            head = f.read(32)
        if len(head) < 32:
            return None
        return struct.unpack(">II", head[16:24])
    except OSError:
        return None


def prompts(db):
    c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        return c.execute("SELECT count(*) FROM steps WHERE step_type IN (14, 15) AND status = 3").fetchone()[0]
    finally:
        c.close()


def copy_check(conv, tmp):
    """Copy db then wal, one after the other, and read the copy."""
    salts0 = wal_salts(conv + "-wal")
    d = os.path.join(tmp, "x.db")
    for ext in ("", "-wal", "-shm"):
        try:
            os.remove(d + ext)
        except OSError:
            pass
    shutil.copyfile(conv, d)
    salts1 = wal_salts(conv + "-wal")
    try:
        shutil.copyfile(conv + "-wal", d + "-wal")
    except OSError:
        pass
    salts2 = wal_salts(conv + "-wal")
    try:
        n = prompts(d)
    except sqlite3.Error as e:
        n = f"ERR {e}"
    return n, (salts0, salts1, salts2)


def main(label, binp, port):
    r = TabAgy(label, "remote-store", port, binp, UID1)
    store = os.path.join(r.home, ".gemini", "antigravity-cli")
    log = open(os.path.join(r.out, "remote.log"), "w")
    tmp = tempfile.mkdtemp(prefix="agy-remote-", dir=r.out)

    def say(*a):
        line = " ".join(str(x) for x in a)
        print(line)
        log.write(line + "\n")
        log.flush()

    try:
        r.first_run()
        r.wait("? for shortcuts")
        time.sleep(2.5)
        say("idle: processes of tab 1:")
        for pid in pids_of(UID1):
            say("  ", describe(pid, "antigravity-cli/"))
        say("idle: locks", locks_of(pids_of(UID1)))
        conv_dir = os.path.join(store, "conversations")
        say("idle: conversations", sorted(os.listdir(conv_dir)) if os.path.isdir(conv_dir) else None)
        r.turn("first probe turn")
        ids = [f[:-3] for f in os.listdir(conv_dir) if f.endswith(".db")]
        say("after turn 1: ids", ids)
        conv = os.path.join(conv_dir, ids[0] + ".db")
        for pid in pids_of(UID1):
            say("  ", describe(pid, "antigravity-cli/"))
        say("locks", locks_of(pids_of(UID1)))
        say("presence", sorted(os.listdir(os.path.join(store, "presence"))))
        with open(os.path.join(store, "cache", "last_conversations.json")) as f:
            say("last_conversations", f.read().replace("\n", " "))
        # Sample the files and the copy while a turn writes.
        stop = threading.Event()
        samples = []

        def sampler():
            while not stop.is_set():
                samples.append((time.time(), stat(conv), stat(conv + "-wal"), wal_salts(conv + "-wal")))
                time.sleep(0.05)

        t = threading.Thread(target=sampler)
        t.start()
        r.type("second probe turn")
        r.keys("Enter")
        checks = []
        t0 = time.time()
        while time.time() - t0 < 15:
            checks.append(copy_check(conv, tmp))
            time.sleep(0.2)
        time.sleep(3)
        stop.set()
        t.join()
        distinct = []
        for _, db, wal, salts in samples:
            row = (db, wal, salts)
            if not distinct or distinct[-1] != row:
                distinct.append(row)
        say("file states while the second turn ran (distinct, in order):")
        for row in distinct:
            say("  db", row[0], "| wal", row[1], "| salts", row[2])
        say("copies read prompts+answers:", sorted(set(str(c[0]) for c in checks)))
        say("copies where the wal salts moved during the copy:", sum(1 for c in checks if len(set(c[1])) > 1))
        say("final live count", prompts(conv))
        say("final locks", locks_of(pids_of(UID1)))

        # A subagent and /clear: which conversations does the process hold?
        say("held before subagent", held(UID1, store))
        d = json.dumps({"Name": "probe", "Description": "Probe helper", "SystemPrompt": "Say hi."})
        r.turn("STUB:CALL define_subagent " + d)
        sa = json.dumps({"TypeName": "probe", "Role": "Probe helper", "Prompt": "say hi"})
        r.type("STUB:CALL invoke_subagent " + sa)
        r.keys("Enter")
        for _ in range(8):
            time.sleep(2.5)
            say("held while subagent", held(UID1, store))
        say("summaries", summaries(store))
        r.type("/clear")
        r.keys("Enter")
        time.sleep(2)
        say("held after /clear", held(UID1, store))
        r.turn("after clear turn")
        say("held after /clear + turn", held(UID1, store))
        say("summaries", summaries(store))
        say("presence", sorted(os.listdir(os.path.join(store, "presence"))))
        say("db/wal sizes after clear turn", [(f, stat(os.path.join(conv_dir, f))) for f in sorted(os.listdir(conv_dir))])

        # A second tab, same folder: environ tells them apart.
        r2 = TabAgy(label, "remote-store-2", port + 1, binp, UID2, home=r.home)
        try:
            r2.first_run()
            r2.wait("? for shortcuts", 20)
            time.sleep(2)
            r2.turn("other tab turn")
            say("tab 1 pids", pids_of(UID1), "tab 2 pids", pids_of(UID2))
            say("presence", sorted(os.listdir(os.path.join(store, "presence"))))
            with open(os.path.join(store, "cache", "last_conversations.json")) as f:
                say("last_conversations", f.read().replace("\n", " "))
            for uid in (UID1, UID2):
                for pid in pids_of(uid):
                    say(uid[-2:], describe(pid, "antigravity-cli/"))
            say("locks", locks_of(pids_of(UID1) + pids_of(UID2)))
        finally:
            r2.close()
        time.sleep(1)
        say("after quit: tab 1 pids", pids_of(UID1), "presence", sorted(os.listdir(os.path.join(store, "presence"))))
        say("db/wal/shm after quit", stat(conv), stat(conv + "-wal"), stat(conv + "-shm"))
    finally:
        r.close()
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(sys.argv[1], common.binary(sys.argv[2]), int(sys.argv[3]))
