"""Exercise the detached gate launcher without running Cargo/npm."""
import pathlib
import shutil
import subprocess
import tempfile
import time
import unittest


class GateJobTests(unittest.TestCase):
    def setUp(self):
        self.fixture = tempfile.TemporaryDirectory(prefix="gate-job-test.")
        self.addCleanup(self.fixture.cleanup)
        scripts = pathlib.Path(self.fixture.name) / "scripts"
        scripts.mkdir()
        shutil.copyfile(pathlib.Path(__file__).with_name("gates-job.sh"), scripts / "gates-job.sh")
        self.runner = ["bash", str(scripts / "gates-job.sh")]
        self.gates = scripts / "gates.sh"

    def start(self, body, *args):
        self.gates.write_text(body)
        result = subprocess.run([*self.runner, "start", *args], capture_output=True, text=True, check=True)
        job = pathlib.Path(result.stdout.splitlines()[0].removeprefix("Gate job: "))
        self.addCleanup(shutil.rmtree, job)
        return job

    def status(self, job):
        return subprocess.run([*self.runner, "status", str(job)], capture_output=True, text=True)

    def finish(self, job):
        deadline = time.monotonic() + 5
        while not (job / "exit-code").exists():
            self.assertLess(time.monotonic(), deadline, "job did not finish")
            time.sleep(0.02)
        return self.status(job)

    def test_detached_run_and_compact_result(self):
        job = self.start('echo noisy-progress\nsleep 0.3\nprintf "== gates ==\\nPASS %s\\n" "$1"\n', "argument with spaces")
        pending = self.status(job)
        self.assertEqual(pending.returncode, 0)
        self.assertIn("running", pending.stdout)
        result = self.finish(job)
        self.assertEqual(result.returncode, 0)
        self.assertIn("PASS argument with spaces", result.stdout)
        self.assertNotIn("noisy-progress", result.stdout)
        self.assertEqual((job / "exit-code").read_text().strip(), "0")

    def test_original_failure_and_diagnostic(self):
        job = self.start("echo useful-diagnostic\nexit 7\n")
        result = self.finish(job)
        self.assertEqual(result.returncode, 7)
        self.assertIn("useful-diagnostic", result.stdout)

    def test_every_failed_gates_tail_survives_a_long_log(self):
        body = (
            'for i in $(seq 200); do echo "progress $i"; done\n'
            'echo "--- clippy failed; last lines of /x/clippy.log:"\n'
            'for i in $(seq 60); do echo "clippy-line $i"; done\n'
            'echo "--- vitest failed; last lines of /x/vitest.log:"\n'
            'for i in $(seq 60); do echo "vitest-line $i"; done\n'
            'printf "== gates ==\\nFAILED: clippy\\n"\nexit 1\n'
        )
        result = self.finish(self.start(body))
        self.assertEqual(result.returncode, 1)
        self.assertIn("clippy-line 1\n", result.stdout)
        self.assertIn("vitest-line 60", result.stdout)
        self.assertNotIn("progress 200", result.stdout)

    def wait(self, job, *args):
        return subprocess.run([*self.runner, "wait", str(job), *args], capture_output=True, text=True, timeout=30)

    def test_wait_blocks_until_the_result(self):
        job = self.start('sleep 0.5\nprintf "== gates ==\\nPASS waited\\n"\n')
        result = self.wait(job, "--timeout", "10")
        self.assertEqual(result.returncode, 0, result)
        self.assertIn("PASS waited", result.stdout)

    def test_wait_past_its_timeout_says_still_running(self):
        job = self.start('echo "gates: another session\'s run holds the gate lock; waiting for it"\nsleep 5\n')
        result = self.wait(job, "--timeout", "1")
        self.assertEqual(result.returncode, 3, result)
        self.assertIn("waiting for it", result.stdout)

    def test_wait_on_a_dead_worker_is_not_a_pass(self):
        job = pathlib.Path(self.fixture.name) / "dead"
        job.mkdir()
        child = subprocess.Popen(["true"])
        child.wait()
        (job / "pid").write_text(f"{child.pid}\n")
        t0 = time.monotonic()
        result = self.wait(job, "--timeout", "20")
        self.assertEqual(result.returncode, 2)
        self.assertLess(time.monotonic() - t0, 5)

    def test_missing_job_is_not_a_pass(self):
        result = self.status(pathlib.Path(self.fixture.name) / "missing")
        self.assertEqual(result.returncode, 2)

    def test_stopped_worker_is_not_a_pass(self):
        job = pathlib.Path(self.fixture.name) / "stopped"
        job.mkdir()
        # A reaped child PID cannot still identify a live worker.
        child = subprocess.Popen(["true"])
        child.wait()
        (job / "pid").write_text(f"{child.pid}\n")
        result = self.status(job)
        self.assertEqual(result.returncode, 2)
        self.assertIn("NOT verified", result.stderr)


if __name__ == "__main__":
    unittest.main()
