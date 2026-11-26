"""gates.sh's lanes, batched reuse and failure naming, on a throwaway repo
with stub cargo/npm/npx (nothing real is built)."""
import os
import pathlib
import shutil
import subprocess
import tempfile
import time
import unittest

HERE = pathlib.Path(__file__).resolve().parent

STUB = r"""#!/usr/bin/env bash
tool=$(basename "$0")
echo "start $tool $* $EPOCHREALTIME" >>"$STUB_LOG"
# Another session editing while the gates run.
[ -n "${STUB_TOUCH:-}" ] && [ "$tool" = cargo ] && echo "$EPOCHREALTIME" >>"$STUB_TOUCH"
# A process left behind holding stdout/stderr (a test's server, a tmux).
[ -n "${STUB_LEAK:-}" ] && [ "$tool" = cargo ] && { sleep "$STUB_LEAK" & }
# A test reading stdin: the gate must give it EOF, not the caller's terminal.
[ -n "${STUB_READ:-}" ] && [ "$tool" = npx ] && read -r _
case " $* " in *" ${STUB_HANG:-@@} "*) sleep 60 ;; esac
sleep "${STUB_SLEEP:-0}"
echo "end $tool $* $EPOCHREALTIME" >>"$STUB_LOG"
case " $* " in *" ${STUB_FAIL:-@@} "*)
  echo "error[E0308]: mismatched types"; echo "  --> src-tauri/src/lib.rs:1:1"; exit 1 ;;
esac
exit 0
"""


class GatesTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix="gates-test.")
        self.addCleanup(tmp.cleanup)
        root = pathlib.Path(tmp.name)
        self.repo = root / "repo"
        lib = self.repo / "scripts" / "lib"
        lib.mkdir(parents=True)
        shutil.copyfile(HERE / "gates.sh", self.repo / "scripts" / "gates.sh")
        for name in ("changed.sh", "low_priority.sh", "gate_lock.sh"):
            shutil.copyfile(HERE / "lib" / name, lib / name)
        brand = self.repo / "scripts" / "brand-check.sh"
        brand.write_text("#!/usr/bin/env bash\nexit 0\n")
        brand.chmod(0o755)
        for crate in ("src-core", "src-gateway", "src-tauri", "src-serverd"):
            (self.repo / crate / "src").mkdir(parents=True)
            (self.repo / crate / "Cargo.toml").write_text(f'[package]\nname = "{crate}-pkg"\n')
            (self.repo / crate / "src" / "lib.rs").write_text("\n")
        (self.repo / "src").mkdir()
        (self.repo / "src" / "a.ts").write_text("export {};\n")
        (self.repo / "docs").mkdir()
        git = ["git", "-C", str(self.repo), "-c", "user.name=t", "-c", "user.email=t@example.invalid"]
        subprocess.run([*git, "init", "-q"], check=True)
        subprocess.run([*git, "add", "-A"], check=True)
        subprocess.run([*git, "commit", "-qm", "init"], check=True)
        stubs = root / "bin"
        stubs.mkdir()
        for tool in ("cargo", "npm", "npx"):
            (stubs / tool).write_text(STUB)
            (stubs / tool).chmod(0o755)
        (root / "tmp").mkdir()
        self.stub_log = root / "stub.log"
        self.env = {
            **os.environ,
            "PATH": f"{stubs}{os.pathsep}{os.environ['PATH']}",
            "TMPDIR": str(root / "tmp"),
            "STUB_LOG": str(self.stub_log),
            "GATES_FULL_PRIORITY": "1",
        }
        for var in ("GATES_FRESH", "GATES_SERIAL", "GATES_NO_LOCK", "GATES_LOCK_HELD"):
            self.env.pop(var, None)
        # A frontend and a src-tauri change: both lanes run.
        (self.repo / "src" / "a.ts").write_text("export const a = 1;\n")
        (self.repo / "src-tauri" / "src" / "lib.rs").write_text("pub fn a() {}\n")

    def gates(self, *args, **env):
        return subprocess.Popen(
            ["bash", str(self.repo / "scripts" / "gates.sh"), *args],
            cwd=self.repo, env={**self.env, **env},
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )

    def finish(self, proc):
        out, _ = proc.communicate(timeout=60)
        return proc.returncode, out

    def stub_calls(self, prefix):
        if not self.stub_log.exists():
            return []
        return [l for l in self.stub_log.read_text().splitlines() if l.startswith(prefix)]

    def test_frontend_and_rust_lanes_overlap(self):
        rc, out = self.finish(self.gates(STUB_SLEEP="0.4"))
        self.assertEqual(rc, 0, out)
        self.assertIn("All selected gates passed.", out)
        times = {}
        for line in self.stub_log.read_text().splitlines():
            kind, tool, *_, t = line.split()
            times.setdefault(tool, {}).setdefault(kind, []).append(float(t))
        # npm ran while cargo did, not after it.
        self.assertLess(min(times["npm"]["start"]), max(times["cargo"]["end"]))
        self.assertLess(min(times["cargo"]["start"]), max(times["npm"]["end"]))

    def test_serial_switch_runs_one_lane_after_the_other(self):
        rc, out = self.finish(self.gates(STUB_SLEEP="0.1", GATES_SERIAL="1"))
        self.assertEqual(rc, 0, out)
        lines = self.stub_log.read_text().splitlines()
        last_fe = max(i for i, l in enumerate(lines) if l.split()[1] in ("npm", "npx"))
        first_rust = min(i for i, l in enumerate(lines) if l.split()[1] == "cargo")
        self.assertLess(last_fe, first_rust)

    def test_sessions_queued_behind_a_run_share_the_next_one(self):
        touch = self.repo / "docs" / "edits.md"
        first = self.gates(STUB_SLEEP="0.5", STUB_TOUCH=str(touch))
        deadline = time.monotonic() + 20
        while not touch.exists():  # the first run is in its cargo gates
            self.assertLess(time.monotonic(), deadline, "first run never reached cargo")
            time.sleep(0.02)
        waiting = [self.gates(STUB_SLEEP="0.5", STUB_TOUCH=str(touch)) for _ in range(3)]
        results = [self.finish(p) for p in [first, *waiting]]
        for rc, out in results:
            self.assertEqual(rc, 0, out)
        # The first run, then one run for all three that queued behind it.
        self.assertEqual(len(self.stub_calls("start cargo test -p src-tauri-pkg -p src-serverd-pkg")), 2, results)
        reused = [out for _, out in results if "after you asked passed every gate" in out]
        self.assertEqual(len(reused), 2, results)

    def test_a_run_without_rust_does_not_cover_a_rust_change(self):
        (self.repo / "src-tauri" / "src" / "lib.rs").write_text("\n")
        rc, out = self.finish(self.gates())
        self.assertEqual(rc, 0, out)
        self.assertEqual(self.stub_calls("start cargo"), [])
        (self.repo / "src-tauri" / "src" / "lib.rs").write_text("pub fn b() {}\n")
        rc, out = self.finish(self.gates())
        self.assertEqual(rc, 0, out)
        self.assertTrue(self.stub_calls("start cargo test"), out)

    def test_failure_names_the_changed_file_and_the_other_lane_finishes(self):
        rc, out = self.finish(self.gates(STUB_FAIL="clippy"))
        self.assertEqual(rc, 1, out)
        self.assertIn("FAILED: clippy", out)
        self.assertIn("it names changed files: src-tauri/src/lib.rs", out)
        self.assertRegex(out, r"-\s+test\s+not run: clippy failed")
        self.assertRegex(out, r"PASS\s+vitest")
        self.assertIn("another session's work in progress", out)

    def test_a_left_behind_process_holds_neither_the_gate_nor_the_lock(self):
        t0 = time.monotonic()
        rc, out = self.finish(self.gates(STUB_LEAK="40"))
        self.assertEqual(rc, 0, out)
        (self.repo / "src" / "a.ts").write_text("export const a = 2;\n")
        rc, out = self.finish(self.gates())
        self.assertEqual(rc, 0, out)
        # The helper lets go within 2 s of the first run's exit; the leftover
        # sleeps 40 s, so a lock it held would show as a far longer wait.
        self.assertLess(time.monotonic() - t0, 30, out)

    def test_a_gate_reading_stdin_gets_eof(self):
        proc = subprocess.Popen(
            ["bash", str(self.repo / "scripts" / "gates.sh")], cwd=self.repo,
            env={**self.env, "STUB_READ": "1"}, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        try:
            out = proc.stdout.read()  # stdin stays open: only EOF from /dev/null ends the read
            proc.wait(timeout=30)
        finally:
            proc.stdin.close()
        self.assertEqual(proc.returncode, 0, out)

    def test_a_hung_gate_times_out(self):
        rc, out = self.finish(self.gates(STUB_HANG="vitest", GATES_TIMEOUT="1"))
        self.assertEqual(rc, 1, out)
        self.assertIn("FAILED: vitest", out)
        self.assertIn("vitest timed out after 1s", out)

    def test_a_wait_past_the_limit_is_not_a_pass(self):
        lock = self.repo / ".git" / "gates.run.lock"
        holder = subprocess.Popen(["flock", str(lock), "sleep", "30"])
        self.addCleanup(holder.kill)
        deadline = time.monotonic() + 5
        while subprocess.run(["flock", "-n", str(lock), "true"]).returncode == 0:
            self.assertLess(time.monotonic(), deadline, "holder never took the lock")
            time.sleep(0.05)
        rc, out = self.finish(self.gates(GATES_MAX_WAIT="1"))
        self.assertEqual(rc, 2, out)
        self.assertIn("NOT verified", out)

    def test_unchanged_tree_reuses_the_last_result(self):
        rc, _ = self.finish(self.gates())
        self.assertEqual(rc, 0)
        calls = len(self.stub_calls("start"))
        rc, out = self.finish(self.gates())
        self.assertEqual(rc, 0, out)
        self.assertIn("the tree is unchanged since a run", out)
        self.assertEqual(len(self.stub_calls("start")), calls)


if __name__ == "__main__":
    unittest.main()
