"""Shared pieces of the CLI verification harness (scripts/verify-cli/README.md).

Every probe runs a CLI binary *outside* the app: a private tmux server, a
scratch HOME, the tab-identity variables stripped. Nothing here touches the
user's own install, config or running window.

Imported by the probes after `sys.path.insert(0, <this dir>)`.
"""
import itertools
import json
import os
import shlex
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
# Run outputs and baselines: gitignored, under the repo so the user can open them.
OUT = os.environ.get("VERIFY_OUT") or os.path.join(ROOT, "tmp", "verify-cli")


def _brand():
    """The app's names, read through scripts/lib/brand.sh (the one source)."""
    sh = os.path.join(ROOT, "scripts", "lib", "brand.sh")
    r = subprocess.run(
        ["bash", "-c", f'. {shlex.quote(sh)} && printf "%s\\n" "$APP_SLUG" "$APP_ENV_PREFIX" "$APP_LEGACY_ENV_PREFIX" "$APP_DISPLAY"'],
        capture_output=True, text=True, check=True)
    slug, prefix, legacy, display = r.stdout.split("\n")[:4]
    return slug, prefix, legacy, display


SLUG, ENV_PREFIX, LEGACY_ENV_PREFIX, DISPLAY = _brand()
_SOCKETS = itertools.count()
# The variables that tie a process to an app tab. A probe that inherits them
# writes its session into this tab's record, so every launch unsets them.
TAB_VARS = [p + v for p in (ENV_PREFIX, LEGACY_ENV_PREFIX) for v in ("TAB_UID", "TAB_AGENT")]


def binary(path):
    """A binary named by path, made absolute: every probe runs it from a scratch work dir."""
    return os.path.abspath(path) if os.sep in path else path


def out_dir(cli, label, *sub):
    d = os.path.join(OUT, cli, label, *sub)
    os.makedirs(d, exist_ok=True)
    return d


def scratch_env(home, extra=None):
    """HOME and every XDG dir inside `home`, so the CLI finds no real config."""
    env = {
        "HOME": home,
        "XDG_CONFIG_HOME": f"{home}/.config",
        "XDG_DATA_HOME": f"{home}/.local/share",
        "XDG_STATE_HOME": f"{home}/.local/state",
        "XDG_CACHE_HOME": f"{home}/.cache",
        "TERM": "xterm-256color",
        "COLORTERM": "truecolor",
    }
    env.update(extra or {})
    return env


def clean_environ(extra=None):
    """os.environ without the tab variables, plus `extra` (for non-tmux runs)."""
    e = {k: v for k, v in os.environ.items() if k not in TAB_VARS}
    e.update(extra or {})
    return e


def start_stub(script, port, log):
    """Start one of the stub model servers on loopback; returns the Popen."""
    p = subprocess.Popen([sys.executable, "-I", os.path.join(HERE, script), str(port), log],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.5)
    return p


class Tui:
    """One CLI in its own tmux server (`tmux -L`), never the user's.

    Frames are saved as `<name>@<cols>x<rows>.esc` (`capture-pane -e`), the
    geometry in the name so parsers/frames.probe.ts can replay them.
    """

    def __init__(self, out, argv, cwd, env=None, size=(120, 40), sock=None, keep=300):
        self.out = out
        self.cols, self.rows = size
        self.sock = sock or f"vc{os.getpid()}_{next(_SOCKETS)}"
        self.T = ["tmux", "-L", self.sock, "-f", "/dev/null"]
        unset = " ".join(f"-u {v}" for v in TAB_VARS)
        envs = " ".join(f"{k}={shlex.quote(str(v))}" for k, v in (env or {}).items())
        argv = [binary(argv[0]), *argv[1:]]
        cmd = f"cd {shlex.quote(cwd)} && exec env {unset} {envs} {' '.join(shlex.quote(a) for a in argv)}"
        # The pane outlives the CLI, so its last frame and exit code stay readable.
        subprocess.run(self.T + ["new-session", "-d", "-x", str(self.cols), "-y", str(self.rows), "-s", "p",
                                 "bash", "-c", f"({cmd}); echo EXITED $?; sleep {keep}"], check=True)

    def plain(self):
        return subprocess.run(self.T + ["capture-pane", "-p", "-t", "p"], capture_output=True, text=True).stdout

    def cap(self, name):
        r = subprocess.run(self.T + ["capture-pane", "-pe", "-t", "p"], capture_output=True, text=True).stdout
        with open(os.path.join(self.out, f"{name}@{self.cols}x{self.rows}.esc"), "w") as f:
            f.write(r)
        return r

    def wait(self, text, secs=30):
        t0 = time.time()
        while time.time() - t0 < secs:
            if text in self.plain():
                return True
            time.sleep(0.25)
        return False

    def keys(self, *k, pause=0.25):
        for x in k:
            subprocess.run(self.T + ["send-keys", "-t", "p", x])
            time.sleep(pause)

    def type(self, text):
        subprocess.run(self.T + ["send-keys", "-t", "p", "-l", text])
        time.sleep(0.4)

    def size(self, cols, rows):
        subprocess.run(self.T + ["resize-window", "-t", "p", "-x", str(cols), "-y", str(rows)])
        self.cols, self.rows = cols, rows
        time.sleep(1.2)

    def history(self):
        return subprocess.run(self.T + ["display-message", "-p", "-t", "p", "#{history_size}"],
                              capture_output=True, text=True).stdout.strip()

    def close(self):
        subprocess.run(self.T + ["kill-server"], stderr=subprocess.DEVNULL)


def write_json(path, obj):
    with open(path, "w") as f:
        json.dump(obj, f)
