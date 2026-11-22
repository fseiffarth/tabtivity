"""What a remote host's OpenCode leaves that the app can read over SFTP alone.

    python3 scripts/verify-cli/opencode/remote_store.py <label> <bin> <port> [turns]
    → tmp/verify-cli/opencode/<label>/remote-store/{report.txt,home/}

The desktop Reader of an OpenCode tab on a remote project's host
(`services::remote::remote_transcript::opencode`) has no hook there and runs
no command: it lists `/proc`, reads files, and copies the SQLite store
(`opencode.db` + `opencode.db-wal`). This runs one tab-like OpenCode (a made-up
launch id in its environment, no session plugin, as on a host) against the
stub model and prints what that reader depends on:

- which processes carry the launch id in `/proc/<pid>/environ`, their command
  lines, and which of them hold `opencode.db` open;
- the process start moment on the host's clock (`/proc/<pid>/stat` field 22 +
  `/proc/stat` btime) against the session's `time_created`;
- the store while turns are written: db size and mtime, the WAL's size and
  header salts (a WAL restart changes them and rewrites the file in place, so
  its size is not its valid length), the valid frames and commits;
- the app's snapshot protocol (salts + db stat before, db then WAL copied,
  both checked after; retried on a change) copied while a turn is being
  written, opened read-only without a `-shm`, and compared with the live row
  counts and `PRAGMA quick_check`.

Get <bin> without installing: see opencode/turns.py's docstring, or use the
agent install's `.opencode/bin/opencode`. Run it only through this harness.
"""
import json
import os
import shutil
import sqlite3
import struct
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import oc  # noqa: E402
from oc import common  # noqa: E402

label, binp, port = sys.argv[1], common.binary(sys.argv[2]), int(sys.argv[3])
turns = int(sys.argv[4]) if len(sys.argv) > 4 else 6
UID = "33333333-4444-4555-8666-777777777777"
out = common.out_dir("opencode", label, "remote-store")
home = os.path.join(out, "home")
shutil.rmtree(home, ignore_errors=True)
work = os.path.join(home, "work")
os.makedirs(work)
store = os.path.join(home, ".local", "share", "opencode")
db = os.path.join(store, "opencode.db")
lines = []


def say(*a):
    s = " ".join(str(x) for x in a)
    print(s)
    lines.append(s)


def wal_header(path):
    try:
        with open(path, "rb") as f:
            h = f.read(32)
    except FileNotFoundError:
        return None
    if len(h) < 32:
        return ("short", len(h))
    magic, ver, page, seq, s1, s2, c1, c2 = struct.unpack(">8I", h)
    return (hex(magic), page, seq, s1, s2)


def wal_frames(path):
    """(restart count, valid frames, commit frames) of a WAL: the frames whose salts
    and checksum chain match the header. The file's size says nothing — a restarted
    WAL is rewritten in place over the old, longer one."""
    try:
        b = open(path, "rb").read()
    except FileNotFoundError:
        return None
    if len(b) < 32:
        return None
    magic, _, page, seq, s1, s2, c1, c2 = struct.unpack(">8I", b[:32])
    word = "<%dI" if magic & 1 == 0 else ">%dI"

    def ck(data, x, y):
        w = struct.unpack(word % (len(data) // 4), data)
        for i in range(0, len(w), 2):
            x = (x + w[i] + y) & 0xFFFFFFFF
            y = (y + w[i + 1] + x) & 0xFFFFFFFF
        return x, y

    acc, off, frames, commits = ck(b[:24], 0, 0), 32, 0, 0
    if acc != (c1, c2):
        return None
    while off + 24 + page <= len(b):
        _, size, a, c, k1, k2 = struct.unpack(">6I", b[off:off + 24])
        nxt = ck(b[off + 24:off + 24 + page], *ck(b[off:off + 8], *acc))
        if (a, c) != (s1, s2) or nxt != (k1, k2):
            break
        acc, off, frames, commits = nxt, off + 24 + page, frames + 1, commits + (size != 0)
    return (seq, frames, commits)


def stat(path):
    try:
        st = os.stat(path)
        return (st.st_size, int(st.st_mtime))
    except FileNotFoundError:
        return None


def procs():
    """(pid, ppid, cmdline, holds the db, environ has the launch id) of own processes."""
    found = []
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        try:
            env = open(f"/proc/{name}/environ", "rb").read()
        except OSError:
            continue
        if f"{common.ENV_PREFIX}TAB_UID={UID}".encode() not in env.split(b"\0"):
            continue
        try:
            cmd = open(f"/proc/{name}/cmdline", "rb").read().replace(b"\0", b" ").decode(errors="replace")
            stat_line = open(f"/proc/{name}/stat").read()
            ppid = int(stat_line.rsplit(")", 1)[1].split()[1])
            start_ticks = int(stat_line.rsplit(")", 1)[1].split()[19])
            fds = []
            for fd in os.listdir(f"/proc/{name}/fd"):
                try:
                    fds.append(os.readlink(f"/proc/{name}/fd/{fd}"))
                except OSError:
                    pass
        except OSError:
            continue
        found.append((int(name), ppid, cmd[:110], any(f.endswith("opencode.db") for f in fds),
                      start_ticks, sorted({os.path.basename(f) for f in fds if store in f})))
    return found


def btime():
    for line in open("/proc/stat"):
        if line.startswith("btime"):
            return int(line.split()[1])


def snapshot(dest):
    """The app's protocol, on local files: the copy is `db` then `db-wal`, accepted
    only if the db stat and the WAL header are what they were before the copy."""
    os.makedirs(dest, exist_ok=True)
    for attempt in range(1, 6):
        before = (stat(db), wal_header(db + "-wal"))
        shutil.copyfile(db, os.path.join(dest, "opencode.db"))
        if os.path.exists(db + "-wal"):
            shutil.copyfile(db + "-wal", os.path.join(dest, "opencode.db-wal"))
        elif os.path.exists(os.path.join(dest, "opencode.db-wal")):
            os.remove(os.path.join(dest, "opencode.db-wal"))
        after = (stat(db), wal_header(db + "-wal"))
        if before == after:
            return attempt
    return None


def counts(path, uri_extra="mode=ro"):
    c = sqlite3.connect(f"file:{path}?{uri_extra}", uri=True)
    res = {t: c.execute(f"select count(*) from {t}").fetchone()[0] for t in ("session_v2", "session_message")}
    qc = c.execute("pragma quick_check").fetchone()[0]
    c.close()
    return res, qc


cfg = oc.stub_config(port)
env = common.scratch_env(home, {
    "OPENCODE_DISABLE_AUTOUPDATE": "1", "OPENCODE_CONFIG_CONTENT": json.dumps(cfg),
    common.ENV_PREFIX + "TAB_UID": UID, common.ENV_PREFIX + "TAB_AGENT": "opencode",
})
log = os.path.join(out, "stub.jsonl")
stub = common.start_stub("stub_openai.py", port, log)
t = common.Tui(out, [binp, "--standalone"], work, env)
try:
    say(label, "ready", t.wait("stub", 40))
    time.sleep(3)
    say("== processes carrying the launch id (pid ppid holds-db cmdline fds-in-store)")
    boot = btime()
    for p in procs():
        say(" ", p[0], p[1], p[3], p[2], p[5])
    # Creation moment on the host's clock, from the process (skew-free), against the db.
    say("== samples: t db(size,mtime) wal(size,mtime) wal-header(salts) ")
    for i in range(turns):
        t.type(f"turn {i}")
        t.keys("Enter")
        t0 = time.time()
        while time.time() - t0 < 25 and len([x for x in oc.reqs(log) if "tools" in x]) < i + 1:
            time.sleep(0.3)
        time.sleep(1.0)
        say(" ", i, stat(db), stat(db + "-wal"), wal_header(db + "-wal"), "restarts/frames/commits", wal_frames(db + "-wal"))
        time.sleep(0.5)
    c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    rows = c.execute("select id, directory, time_created from session_v2 where parent_id is null").fetchall()
    c.close()
    hold = [p for p in procs() if p[3]]
    if rows and hold:
        pid, ticks = hold[0][0], hold[0][4]
        start_ms = (boot + ticks / os.sysconf("SC_CLK_TCK")) * 1000
        say("== session", rows[0][0], "created", rows[0][2], "- process", pid, "start (host clock, ms)", int(start_ms),
            "-> created - start =", int(rows[0][2] - start_ms), "ms")
    say("== snapshot while a turn is written")
    t.type("snapshot turn")
    t.keys("Enter")
    ok = bad = 0
    for i in range(12):
        dest = os.path.join(out, "snap")
        shutil.rmtree(dest, ignore_errors=True)
        attempt = snapshot(dest)
        if attempt is None:
            bad += 1
            say(" ", i, "no stable copy in 5 attempts")
            continue
        try:
            got, qc = counts(os.path.join(dest, "opencode.db"))
            live, _ = counts(db)
            ok += qc == "ok"
            say(" ", i, "attempt", attempt, "snapshot", got, "live", live, "quick_check", qc,
                "shm made:", os.path.exists(os.path.join(dest, "opencode.db-shm")))
        except sqlite3.Error as e:
            bad += 1
            say(" ", i, "snapshot unreadable:", e)
        time.sleep(0.3)
    say("== snapshots ok", ok, "bad", bad)
    say("== final store files", {f: stat(os.path.join(store, f)) for f in sorted(os.listdir(store)) if f.startswith("opencode.db")})
finally:
    t.close()
    stub.terminate()
    with open(os.path.join(out, "report.txt"), "w") as f:
        f.write("\n".join(lines) + "\n")
