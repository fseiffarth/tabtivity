"""Antigravity (`agy`) probe helpers. Not run directly.

<bin> must be a copy in a read-only directory (`chmod a-w` the dir): agy
updates itself in place otherwise, and the baseline becomes the new version.
`prov=True` points it at stub_gemini.py with a dummy key, so turns run offline;
`prov=False` leaves it unconfigured, for the sign-in screens.
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import common  # noqa: E402


class Agy(common.Tui):
    def __init__(self, label, name, port, binp, args=(), size=(80, 24), prov=True, home=None):
        out = common.out_dir("antigravity", label, name)
        self.home = home or common.out_dir("antigravity", label, f"h-{name}")
        self.work = os.path.join(self.home, "work")
        os.makedirs(self.work, exist_ok=True)
        extra = {}
        self.stub = None
        if prov:
            cfg = os.path.join(self.home, ".gemini", "antigravity-cli")
            os.makedirs(cfg, exist_ok=True)
            if not os.path.exists(os.path.join(cfg, "settings.json")):
                common.write_json(os.path.join(cfg, "settings.json"), {"modelProvider": "gemini"})
            extra = {"GEMINI_API_KEY": "dummy", "GOOGLE_GEMINI_BASE_URL": f"http://127.0.0.1:{port}"}
            self.stub = common.start_stub("stub_gemini.py", port, os.path.join(out, "stub.jsonl"))
        self.env = common.scratch_env(self.home, extra)
        super().__init__(out, [binp, *args], self.work, self.env, size=size, keep=200)

    def first_run(self):
        """Walk theme → terms → trust to the idle prompt."""
        time.sleep(5)
        self.cap("fr_theme")
        self.keys("Enter")
        time.sleep(1.2)
        self.cap("fr_terms")
        self.keys("Space", "Down", "Right")
        time.sleep(0.5)
        self.cap("fr_terms_done")
        self.keys("Enter")
        time.sleep(1.5)
        self.cap("fr_trust")
        self.keys("Enter")

    def close(self):
        super().close()
        if self.stub:
            self.stub.terminate()

