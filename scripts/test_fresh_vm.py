#!/usr/bin/env python3
"""Exercise emitted guest scripts without starting QEMU or touching a VM."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import threading
import time
import unittest


SCRIPT = Path(__file__).with_name("fresh-vm.sh").read_text()


def emit(name):
    definitions = []
    for function in ("boot_hook", "desktop_setup", "install_script", "user_data", "guest_repair",
                     "guest_live_update"):
        match = re.search(rf"^{function}\(\) \{{\n.*?^EOF\n\}}", SCRIPT, re.M | re.S)
        if match is None:
            raise AssertionError(f"missing function: {function}")
        definitions.append(match[0])
    return subprocess.run(
        ["bash", "-c", "\n".join(definitions) + f"\nPKG_LABEL=FRESHPKG\n{name}"],
        check=True, capture_output=True, text=True,
    ).stdout


def stamp_of(name, content=b""):
    """The package stamp: file name and the head of its SHA-256."""
    return f"{name} {hashlib.sha256(content).hexdigest()[:12]}"


class GuestDesktopTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="fresh-vm-test-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.log = self.root / "commands.log"
        self.unit = self.root / "gdm3.service"
        self.unit.write_text("[Service]\nExecStart=/usr/sbin/gdm3\n")
        self.env = dict(os.environ, FRESH_VM_TEST_LOG=str(self.log),
                        FRESH_VM_TEST_UNIT=str(self.unit),
                        FRESH_VM_TEST_LOAD="loaded", FRESH_VM_TEST_TARGET="graphical.target")
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.env["PATH"] = str(self.bin) + os.pathsep + os.environ["PATH"]
        self.program("systemctl", '''printf '%s\\n' "$*" >> "$FRESH_VM_TEST_LOG"
case "$*" in
  'show gdm3.service --property=FragmentPath --value') printf '%s\\n' "$FRESH_VM_TEST_UNIT" ;;
  'show display-manager.service --property=LoadState --value') printf '%s\\n' "$FRESH_VM_TEST_LOAD" ;;
  get-default) printf '%s\\n' "$FRESH_VM_TEST_TARGET" ;;
  'show fresh-vm-install.service --property=ActiveState --value') printf '%s\\n' "${FRESH_VM_TEST_INSTALL_STATE:-failed}" ;;
  'start display-manager.service') exit "${FRESH_VM_TEST_GDM_RC:-0}" ;;
esac''')
        self.program("journalctl", "printf 'fixture desktop failure\\n'")
        self.program("debconf-set-selections", "cat >/dev/null")
        self.program("dpkg-query", "printf '%s' \"${FRESH_VM_TEST_PACKAGE_STATUS:-ii }\"")
        self.program("dpkg", ":")
        self.program("dpkg-deb", "printf 'fixture-package'")
        self.program("apt-get", '''printf 'apt: %s\\n' "$*" >> "$FRESH_VM_TEST_LOG"
if [ "$1" = install ]; then
  [ "$DEBIAN_FRONTEND" = noninteractive ] || exit 91
  grep -qx 'exit 101' "$(dirname "$0")/../usr/sbin/policy-rc.d" || exit 92
  case " $* " in *' -o Dpkg::Options::=--force-confdef '*) ;; *) exit 93 ;; esac
  case " $* " in *' -o Dpkg::Options::=--force-confold '*) ;; *) exit 94 ;; esac
  exit "${FRESH_VM_TEST_APT_RC:-0}"
fi''')
        for path in ("usr/sbin/gdm3", "usr/bin/gnome-shell", "usr/sbin/qemu-ga"):
            executable = self.root / path
            executable.parent.mkdir(parents=True, exist_ok=True)
            executable.touch()
            executable.chmod(0o755)
        conf = self.root / "etc/gdm3/custom.conf"
        conf.parent.mkdir(parents=True)
        conf.write_text("AutomaticLogin=tester\n")

    def program(self, name, body):
        executable = self.bin / name
        executable.write_text("#!/bin/sh\nset -eu\n" + body + "\n")
        executable.chmod(0o755)

    def redirect(self, script):
        # Redirect guest filesystem paths into a disposable fixture. The
        # emitted shell and its control flow otherwise run unchanged.
        for prefix in ("/tmp/", "/usr/sbin/", "/usr/bin/", "/etc/", "/var/lib/", "/dev/"):
            script = script.replace(prefix, str(self.root) + prefix)
        (self.root / "dev").mkdir(exist_ok=True)
        (self.root / "tmp").mkdir(exist_ok=True)
        return script

    def run_guest(self, script, *args):
        return subprocess.run(["sh", "-c", self.redirect(script), "guest", *args],
                              env=self.env, capture_output=True, text=True)

    def test_same_package_repairs_desktop_before_stamp_shortcut(self):
        package = self.root / "disc"
        package.mkdir()
        (package / "example.deb").touch()
        state = self.root / "var/lib/fresh-vm"
        state.mkdir(parents=True)
        (state / "installed").write_text(stamp_of("example.deb"))
        result = self.run_guest(emit("install_script"), str(package))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / "etc/systemd/system/display-manager.service").resolve(), self.unit)
        self.assertEqual((self.root / "etc/X11/default-display-manager").read_text(),
                         str(self.root) + "/usr/sbin/gdm3\n")
        commands = self.log.read_text().splitlines()
        self.assertIn("set-default graphical.target", commands)
        self.assertIn("--no-block start display-manager.service", commands)
        self.assertNotIn("start display-manager.service", commands)

    def test_unconfigured_desktop_is_repaired_even_if_package_stamp_matches(self):
        self.env["FRESH_VM_TEST_PACKAGE_STATUS"] = "iF "
        policy = self.root / "usr/sbin/policy-rc.d"
        original = self.root / "original-policy"
        original.write_text("#!/bin/sh\nexit 0\n")
        original.chmod(0o750)
        policy.symlink_to(original)
        package = self.root / "disc"
        package.mkdir()
        (package / "example.deb").touch()
        state = self.root / "var/lib/fresh-vm"
        state.mkdir(parents=True)
        (state / "installed").write_text(stamp_of("example.deb"))
        result = self.run_guest(emit("install_script"), str(package))
        self.assertEqual(result.returncode, 0, result.stderr)
        commands = self.log.read_text().splitlines()
        repair = next(c for c in commands if c.startswith("apt: install"))
        self.assertIn("--fix-broken ubuntu-desktop-minimal qemu-guest-agent", repair)
        self.assertLess(commands.index(repair), commands.index("daemon-reload"))
        self.assertTrue(policy.is_symlink())
        self.assertEqual(policy.resolve(), original)
        self.assertEqual(original.read_text(), "#!/bin/sh\nexit 0\n")
        self.assertEqual(original.stat().st_mode & 0o777, 0o750)

    def test_failed_desktop_repair_restores_policy_and_does_not_queue_gdm(self):
        self.env.update(FRESH_VM_TEST_PACKAGE_STATUS="iF ", FRESH_VM_TEST_APT_RC="100")
        result = self.run_guest(emit("install_script"), str(self.root))
        self.assertEqual(result.returncode, 100, result.stderr)
        self.assertFalse((self.root / "usr/sbin/policy-rc.d").exists())
        self.assertNotIn("--no-block start", self.log.read_text())
        self.assertFalse((self.root / "var/lib/fresh-vm/installed").exists())

    def test_deb_install_preserves_preconfigured_files_and_restores_policy(self):
        package = self.root / "disc"
        package.mkdir()
        (package / "example.deb").touch()
        result = self.run_guest(emit("install_script"), str(package))
        self.assertEqual(result.returncode, 0, result.stderr)
        commands = self.log.read_text().splitlines()
        install = next(c for c in commands if c.startswith("apt: install"))
        self.assertIn("--allow-downgrades", install)
        self.assertIn("--reinstall", install)
        self.assertIn("-o Dpkg::Options::=--force-confold", install)
        self.assertFalse((self.root / "usr/sbin/policy-rc.d").exists())
        self.assertEqual((self.root / "var/lib/fresh-vm/installed").read_text(), stamp_of("example.deb"))

    def test_same_name_with_new_content_is_installed_again(self):
        package = self.root / "disc"
        package.mkdir()
        (package / "example.deb").write_bytes(b"rebuilt at the same version")
        state = self.root / "var/lib/fresh-vm"
        state.mkdir(parents=True)
        (state / "installed").write_text(stamp_of("example.deb", b"the first build"))
        result = self.run_guest(emit("install_script"), str(package))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(any(c.startswith("apt: install") for c in self.log.read_text().splitlines()))
        self.assertEqual((state / "installed").read_text(), stamp_of("example.deb", b"rebuilt at the same version"))

    def test_the_very_same_file_is_not_installed_twice(self):
        package = self.root / "disc"
        package.mkdir()
        (package / "example.deb").write_bytes(b"same bytes")
        state = self.root / "var/lib/fresh-vm"
        state.mkdir(parents=True)
        (state / "installed").write_text(stamp_of("example.deb", b"same bytes"))
        result = self.run_guest(emit("install_script"), str(package))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(any(c.startswith("apt: install") for c in self.log.read_text().splitlines()))

    def live_fixture(self, app_pid=None):
        """A copied-in live folder (install.sh + pkg/) and the previous install's entry."""
        live = self.root / "var-tmp-live"
        (live / "pkg").mkdir(parents=True)
        (live / "install.sh").write_text(self.redirect(emit("install_script")))
        (live / "pkg" / "example.deb").write_bytes(b"new build")
        state = self.root / "var/lib/fresh-vm"
        state.mkdir(parents=True)
        entry = self.root / "usr/share/applications/fixture.desktop"
        entry.parent.mkdir(parents=True, exist_ok=True)
        entry.write_text("[Desktop Entry]\nExec=fixture-app --flag %U\n")
        (state / "entry").write_text(str(entry))
        self.program("pgrep", """printf 'pgrep %s\\n' "$*" >> "$FRESH_VM_TEST_LOG"
printf '%s\\n' "${FRESH_VM_TEST_PIDS:-}" """)
        if app_pid:
            self.env["FRESH_VM_TEST_PIDS"] = str(app_pid)
        return live

    def test_live_update_installs_then_quits_the_old_app(self):
        app = subprocess.Popen(["sleep", "60"])
        reaper = threading.Thread(target=app.wait, daemon=True)
        reaper.start()
        self.addCleanup(lambda: app.poll() is None and app.kill())
        live = self.live_fixture(app.pid)
        started = time.monotonic()
        result = self.run_guest(emit("guest_live_update"), str(live))
        self.assertEqual(result.returncode, 0, result.stderr)
        reaper.join(5)
        self.assertIsNotNone(app.poll(), "the old app is still running")
        self.assertLess(time.monotonic() - started, 15)
        commands = self.log.read_text().splitlines()
        install = next(i for i, c in enumerate(commands) if c.startswith("apt: install"))
        self.assertLess(install, commands.index("pgrep -u tester -x -- fixture-app"))
        self.assertIn("quitting the running app", result.stdout)
        self.assertIn(stamp_of("example.deb", b"new build"), result.stdout)
        self.assertFalse(live.exists(), "the copied package is left behind")

    def test_live_update_with_no_running_app_still_installs(self):
        live = self.live_fixture()
        result = self.run_guest(emit("guest_live_update"), str(live))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("quitting", result.stdout)
        self.assertEqual((self.root / "var/lib/fresh-vm/installed").read_text(),
                         stamp_of("example.deb", b"new build"))

    def test_failed_live_install_leaves_the_app_running(self):
        app = subprocess.Popen(["sleep", "60"])
        self.addCleanup(lambda: (app.kill(), app.wait()))
        live = self.live_fixture(app.pid)
        self.env["FRESH_VM_TEST_APT_RC"] = "100"
        result = self.run_guest(emit("guest_live_update"), str(live))
        self.assertEqual(result.returncode, 100, result.stderr)
        self.assertIsNone(app.poll())
        self.assertNotIn("pgrep", self.log.read_text())
        self.assertFalse(live.exists())

    def test_live_update_does_not_compete_with_the_boot_installer(self):
        live = self.live_fixture()
        self.env["FRESH_VM_TEST_INSTALL_STATE"] = "activating"
        result = self.run_guest(emit("guest_live_update"), str(live))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("boot installer is still running", result.stderr)
        self.assertNotIn("apt:", self.log.read_text())

    def test_desktop_setup_enables_and_recovers_the_guest_agent(self):
        channel = self.root / "dev/virtio-ports/org.qemu.guest_agent.0"
        channel.parent.mkdir(parents=True)
        channel.touch()
        result = self.run_guest(emit("desktop_setup"))
        self.assertEqual(result.returncode, 0, result.stderr)
        commands = self.log.read_text().splitlines()
        self.assertIn("add-wants multi-user.target qemu-guest-agent.service", commands)
        self.assertIn("reset-failed qemu-guest-agent.service", commands)
        self.assertIn("--no-block start qemu-guest-agent.service", commands)

    def test_host_repair_finishes_packages_before_starting_gdm(self):
        self.env["FRESH_VM_TEST_PACKAGE_STATUS"] = "iF "
        result = self.run_guest(emit("guest_repair"))
        self.assertEqual(result.returncode, 0, result.stderr)
        commands = self.log.read_text().splitlines()
        install = next(c for c in commands if c.startswith("apt: install"))
        self.assertLess(commands.index(install), commands.index("start display-manager.service"))
        self.assertIn("reset-failed display-manager.service", commands)

    def test_host_repair_does_not_compete_with_the_boot_installer(self):
        self.env.update(FRESH_VM_TEST_PACKAGE_STATUS="iF ", FRESH_VM_TEST_INSTALL_STATE="activating")
        result = self.run_guest(emit("guest_repair"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("boot installer is still running", result.stderr)
        self.assertNotIn("apt:", self.log.read_text())
        self.assertNotIn("start display-manager.service", self.log.read_text())

    def test_host_repair_returns_desktop_failure_details(self):
        self.env["FRESH_VM_TEST_GDM_RC"] = "1"
        result = self.run_guest(emit("guest_repair"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("fixture desktop failure", result.stdout)

    def test_missing_gdm_unit_refuses_instead_of_creating_a_broken_alias(self):
        self.unit.unlink()
        result = self.run_guest(emit("desktop_setup"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no GDM service unit", result.stderr)
        self.assertFalse((self.root / "etc/systemd/system/display-manager.service").exists())

    def test_bake_rejects_missing_display_manager_and_text_boot_target(self):
        data = emit("user_data")
        # This runcmd is a YAML single-quoted scalar; unescape YAML's doubled
        # quotes before executing the actual acceptance check from the recipe.
        line = next(line for line in data.splitlines() if line.startswith("  - '[ -x"))
        check = line[len("  - '"):-1].replace("''", "'")
        for load, target, accepted in (("not-found", "graphical.target", False),
                                       ("loaded", "multi-user.target", False),
                                       ("loaded", "graphical.target", True)):
            with self.subTest(load=load, target=target):
                self.env.update(FRESH_VM_TEST_LOAD=load, FRESH_VM_TEST_TARGET=target)
                result = self.run_guest(check)
                self.assertEqual(result.returncode == 0, accepted, result.stderr)


class GuestAgentTests(unittest.TestCase):
    def test_unavailable_agent_reports_no_command_was_submitted(self):
        function = re.search(r"^qga_exec\(\) \{\n.*?^PY_QGA\n\}", SCRIPT, re.M | re.S)
        self.assertIsNotNone(function)
        with tempfile.TemporaryDirectory(prefix="vm-qga-") as tmp:
            address = str(Path(tmp) / "qga.sock")
            with socket.socket(socket.AF_UNIX) as server:
                server.bind(address)
                server.listen(1)
                server.settimeout(5)
                proc = subprocess.Popen(
                    ["bash", "-c", function[0] + "\nqga_exec /bin/true"],
                    env=dict(os.environ, QGA_SOCK=address),
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                )
                try:
                    with server.accept()[0] as client:
                        client.settimeout(5)
                        request = json.loads(client.recv(4096))
                        self.assertEqual(request["execute"], "guest-sync")
                        client.shutdown(socket.SHUT_RDWR)
                    stdout, stderr = proc.communicate(timeout=5)
                    self.assertEqual(proc.returncode, 69, stderr)
                    self.assertEqual(stdout, "")
                    self.assertIn("no command was submitted", stderr)
                finally:
                    if proc.poll() is None:
                        proc.kill()
                        proc.communicate()

    def test_default_and_extended_timeout_preserve_guest_argv_output_and_status(self):
        function = re.search(r"^qga_exec\(\) \{\n.*?^PY_QGA\n\}", SCRIPT, re.M | re.S)
        self.assertIsNotNone(function)
        for options in ("", "--timeout 900"):
            with self.subTest(options=options), tempfile.TemporaryDirectory(prefix="vm-qga-") as tmp:
                address = str(Path(tmp) / "qga.sock")
                with socket.socket(socket.AF_UNIX) as server:
                    server.bind(address)
                    server.listen(1)
                    server.settimeout(5)
                    env = dict(os.environ, QGA_SOCK=address)
                    proc = subprocess.Popen(
                        ["bash", "-c", function[0] + f"\nqga_exec {options} /bin/sh -c 'echo fixture'"],
                        env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                    )
                    try:
                        with server.accept()[0] as client:
                            client.settimeout(5)
                            stream = client.makefile("rwb")
                            for expected in ("guest-sync", "guest-exec", "guest-exec-status"):
                                request = json.loads(stream.readline())
                                self.assertEqual(request["execute"], expected)
                                if expected == "guest-sync":
                                    reply = request["arguments"]["id"]
                                elif expected == "guest-exec":
                                    self.assertEqual(request["arguments"]["path"], "/bin/sh")
                                    self.assertEqual(request["arguments"]["arg"], ["-c", "echo fixture"])
                                    reply = {"pid": 42}
                                else:
                                    reply = {"exited": True, "exitcode": 7,
                                             "out-data": base64.b64encode(b"fixture output\n").decode()}
                                stream.write(json.dumps({"return": reply}).encode() + b"\n")
                                stream.flush()
                        stdout, stderr = proc.communicate(timeout=5)
                        self.assertEqual(proc.returncode, 7, stderr)
                        self.assertEqual(stdout, "fixture output\n")
                    finally:
                        if proc.poll() is None:
                            proc.kill()
                            proc.communicate()


class FakeAgent:
    """A QEMU guest agent on a unix socket: records what the host runs and
    copies, and answers the way a guest would for the few commands used."""

    def __init__(self, path, installed=b"", mute=False):
        self.path, self.installed, self.mute = path, installed, mute
        self.files, self.execs, self.results = {}, [], {}
        self.server = socket.socket(socket.AF_UNIX)
        self.server.bind(path)
        self.server.listen(8)
        self.server.settimeout(0.2)
        self.stop = False
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()

    def close(self):
        self.stop = True
        self.thread.join(5)
        self.server.close()

    def serve(self):
        while not self.stop:
            try:
                client, _ = self.server.accept()
            except (socket.timeout, OSError):
                continue
            with client:
                if not self.mute:
                    self.talk(client)

    def talk(self, client):
        stream = client.makefile("rwb")
        while True:
            line = stream.readline()
            if not line:
                return
            request = json.loads(line)
            args = request["arguments"]
            if request["execute"] == "guest-sync":
                reply = args["id"]
            elif request["execute"] == "guest-exec":
                reply = {"pid": len(self.execs) + 1}
                data = base64.b64decode(args["input-data"]) if "input-data" in args else None
                self.execs.append((args["arg"], data))
                self.results[reply["pid"]] = self.answer(args["arg"], data)
            else:
                out = self.results[args["pid"]]
                reply = {"exited": True, "exitcode": 0,
                         "out-data": base64.b64encode(out).decode()}
            stream.write(json.dumps({"return": reply}).encode() + b"\n")
            stream.flush()

    def answer(self, arg, data):
        script = arg[1] if len(arg) > 1 else ""
        if "cat /var/lib/fresh-vm/installed" in script:
            return self.installed
        if ': > "$1"' in script:
            self.files[arg[3]] = b""
        elif 'cat >> "$1"' in script:
            self.files[arg[3]] += data
        elif "sha256sum" in script and len(arg) > 3:
            return hashlib.sha256(self.files[arg[3]]).hexdigest().encode() + b"  " + arg[3].encode()
        return b""

    def scripts(self):
        return [a[1] if len(a) > 1 else "" for a, _ in self.execs]


class QgaPutTests(unittest.TestCase):
    def test_put_copies_a_file_in_chunks_and_reports_a_failure(self):
        function = re.search(r"^qga_exec\(\) \{\n.*?^PY_QGA\n\}", SCRIPT, re.M | re.S)
        with tempfile.TemporaryDirectory(prefix="vm-qga-") as tmp:
            source = Path(tmp) / "package.deb"
            content = os.urandom(2_500_000)
            source.write_bytes(content)
            agent = FakeAgent(str(Path(tmp) / "qga.sock"))
            try:
                result = subprocess.run(
                    ["bash", "-c", function[0] + f"\nqga_exec --timeout 20 --put '{source}' /var/tmp/x/pkg/package.deb"],
                    env=dict(os.environ, QGA_SOCK=agent.path), capture_output=True, text=True, timeout=30)
            finally:
                agent.close()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(agent.files["/var/tmp/x/pkg/package.deb"], content)
            self.assertEqual(len([e for e in agent.execs if e[1]]), 3)  # 1 MiB chunks
            self.assertNotIn("copied", result.stderr)  # progress lines only for big packages

    def test_put_of_a_missing_file_fails_before_touching_the_guest(self):
        function = re.search(r"^qga_exec\(\) \{\n.*?^PY_QGA\n\}", SCRIPT, re.M | re.S)
        with tempfile.TemporaryDirectory(prefix="vm-qga-") as tmp:
            agent = FakeAgent(str(Path(tmp) / "qga.sock"))
            try:
                result = subprocess.run(
                    ["bash", "-c", function[0] + "\nqga_exec --put /nonexistent/file /x"],
                    env=dict(os.environ, QGA_SOCK=agent.path), capture_output=True, text=True, timeout=30)
            finally:
                agent.close()
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("cannot read", result.stderr)
            self.assertEqual(agent.execs, [])


class LocalPackageTests(unittest.TestCase):
    def pick(self, root, launcher="/nonexistent-launcher"):
        function = re.search(r"^local_package\(\) \{\n.*?^\}\n", SCRIPT, re.M | re.S)
        self.assertIsNotNone(function)
        prelude = ('die() { printf "fresh-vm: %s\\n" "$*" >&2; exit 1; }\n'
                   'say() { printf "==> %s\\n" "$*"; }\ndev_git() { return 1; }\n'
                   f"ROOT='{root}'\nLAUNCHER='{launcher}'\n")
        return subprocess.run(["bash", "-c", prelude + function[0] + "\nlocal_package"],
                              capture_output=True, text=True)

    def test_the_newest_built_package_wins_and_is_described(self):
        with tempfile.TemporaryDirectory(prefix="vm-local-") as tmp:
            bundle = Path(tmp) / "target/release/bundle"
            files = {"deb/app_0.1.0_amd64.deb": 1000, "appimage/app_0.1.0_amd64.AppImage": 3000,
                     "deb/app_0.2.0_amd64.deb": 2000, "server/app-server_0.2.0_amd64.deb": 9000}
            for name, mtime in files.items():
                path = bundle / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(name)
                os.utime(path, (mtime, mtime))
            result = self.pick(tmp)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), str(bundle / "appimage/app_0.1.0_amd64.AppImage"))
            self.assertIn("current build: " + str(bundle / "appimage/app_0.1.0_amd64.AppImage"), result.stderr)
            self.assertIn("built 1970-01-01", result.stderr)

    def test_no_package_says_how_to_build_one(self):
        with tempfile.TemporaryDirectory(prefix="vm-local-") as tmp:
            result = self.pick(tmp, launcher=tmp)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("npm run tauri:bundle", result.stderr)
            self.assertIn("never starts a build", result.stderr)
            self.assertIn("from the checkout", result.stderr)


BRAND = subprocess.run(
    ["bash", "-c", f". '{Path(__file__).parent}/lib/brand.sh'; printf '%s' \"$APP_ENV_PREFIX\""],
    capture_output=True, text=True).stdout


class HostRunTests(unittest.TestCase):
    """The real script against a fake running VM: pgrep says it runs, a fake
    guest agent answers on the socket. No QEMU is installed on PATH, so any
    attempt to start one fails the run."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="fresh-vm-host-")
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.dir = root / "vm"
        self.dir.mkdir()
        (self.dir / "base.qcow2").write_bytes(b"base")
        (self.dir / "vm.qcow2").write_bytes(b"vm")
        (self.dir / "installed").write_text("old.deb 000000000000\n")
        bin_dir = root / "bin"
        bin_dir.mkdir()
        pgrep = bin_dir / "pgrep"
        pgrep.write_text("#!/bin/sh\nexit 0\n")
        pgrep.chmod(0o755)
        (root / "home").mkdir()
        self.package = root / "app_9.9.9_amd64.deb"
        self.content = os.urandom(1_200_000)
        self.package.write_bytes(self.content)
        self.env = dict(os.environ, HOME=str(root / "home"), PATH=f"{bin_dir}:{os.environ['PATH']}",
                        **{BRAND + "FRESH_VM_DIR": str(self.dir)})
        self.env.pop("DISPLAY", None)

    def agent(self, **kw):
        agent = FakeAgent(str(self.dir / "qga.sock"), **kw)
        self.addCleanup(agent.close)
        return agent

    def run_script(self, *args):
        return subprocess.run(["bash", str(Path(__file__).with_name("fresh-vm.sh")), *args],
                              env=self.env, capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL)

    def test_running_vm_is_updated_in_place_without_a_question(self):
        agent = self.agent(installed=b"old.deb 000000000000")
        result = self.run_script(str(self.package))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        name = self.package.name
        self.assertEqual(agent.files[f"/var/tmp/fresh-vm-live/pkg/{name}"], self.content)
        self.assertIn("present()", agent.files["/var/tmp/fresh-vm-live/install.sh"].decode())
        scripts = agent.scripts()
        install = next(i for i, c in enumerate(scripts) if "install.sh" in c and "app_pids" in c)
        launch = next(i for i, c in enumerate(scripts) if "systemd-run" in c)
        self.assertLess(install, launch)
        self.assertIn("-> " + stamp_of(name, self.content), result.stdout)
        self.assertEqual((self.dir / "installed").read_text().strip(), stamp_of(name, self.content))
        self.assertTrue((self.dir / "vm.qcow2").exists())

    def test_same_file_is_not_copied_again_but_the_app_is_started(self):
        agent = self.agent(installed=stamp_of(self.package.name, self.content).encode())
        result = self.run_script(str(self.package))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(agent.files, {})
        self.assertIn("already installed", result.stdout)
        self.assertTrue(any("systemd-run" in c for c in agent.scripts()))

    def test_same_name_rebuilt_is_copied_and_installed(self):
        agent = self.agent(installed=stamp_of(self.package.name, b"the older build").encode())
        result = self.run_script(str(self.package))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(agent.files[f"/var/tmp/fresh-vm-live/pkg/{self.package.name}"], self.content)

    def test_silent_agent_is_reported_not_hung_and_nothing_is_copied(self):
        agent = self.agent(mute=True)
        started = time.monotonic()
        result = self.run_script(str(self.package))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("guest agent does not answer", result.stderr)
        self.assertIn("Nothing was changed", result.stderr)
        self.assertEqual(agent.execs, [])
        self.assertLess(time.monotonic() - started, 40)

    def test_status_asks_the_running_vm_and_reports_a_silent_agent(self):
        self.agent(installed=b"live.deb abcdef012345")
        result = self.run_script("status")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("state      running", result.stdout)
        self.assertIn("installed  live.deb abcdef012345 (asked of the running VM)", result.stdout)

    def test_status_with_a_silent_agent_falls_back_to_the_recorded_stamp(self):
        self.agent(mute=True)
        result = self.run_script("status")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("old.deb 000000000000 (last recorded by the host; the VM is running but its guest agent does not answer", result.stdout)


if __name__ == "__main__":
    unittest.main()
