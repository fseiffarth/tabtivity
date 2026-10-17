#!/usr/bin/env python3
"""Exercise emitted guest scripts without starting QEMU or touching a VM."""
import base64
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("fresh-vm.sh").read_text()


def emit(name):
    definitions = []
    for function in ("boot_hook", "desktop_setup", "install_script", "user_data", "guest_repair"):
        match = re.search(rf"^{function}\(\) \{{\n.*?^EOF\n\}}", SCRIPT, re.M | re.S)
        if match is None:
            raise AssertionError(f"missing function: {function}")
        definitions.append(match[0])
    return subprocess.run(
        ["bash", "-c", "\n".join(definitions) + f"\nPKG_LABEL=FRESHPKG\n{name}"],
        check=True, capture_output=True, text=True,
    ).stdout


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

    def run_guest(self, script, *args):
        # Redirect guest filesystem paths into a disposable fixture. The
        # emitted shell and its control flow otherwise run unchanged.
        for prefix in ("/tmp/", "/usr/sbin/", "/usr/bin/", "/etc/", "/var/lib/", "/dev/"):
            script = script.replace(prefix, str(self.root) + prefix)
        (self.root / "dev").mkdir(exist_ok=True)
        (self.root / "tmp").mkdir(exist_ok=True)
        return subprocess.run(["sh", "-c", script, "guest", *args],
                              env=self.env, capture_output=True, text=True)

    def test_same_package_repairs_desktop_before_stamp_shortcut(self):
        package = self.root / "disc"
        package.mkdir()
        (package / "example.deb").touch()
        state = self.root / "var/lib/fresh-vm"
        state.mkdir(parents=True)
        (state / "installed").write_text("example.deb")
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
        (state / "installed").write_text("example.deb")
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
        self.assertIn("-o Dpkg::Options::=--force-confold", install)
        self.assertFalse((self.root / "usr/sbin/policy-rc.d").exists())
        self.assertEqual((self.root / "var/lib/fresh-vm/installed").read_text(), "example.deb")

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


if __name__ == "__main__":
    unittest.main()
