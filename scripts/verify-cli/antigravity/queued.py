"""Antigravity: the footer while prompts wait in agy's queue, at a phone's width.

    python3 scripts/verify-cli/antigravity/queued.py <label> <bin> <port> <cols> [rows]
    → tmp/verify-cli/antigravity/<label>/queued<cols>/*.esc

A fresh home on stub_gemini.py: first run, then a turn the stub holds
(`STUB:SLOW 60`), two prompts sent while it works (agy lists them `▸ …` and
puts `Press up to edit queued messages` beside the footer's model), and
`/model` opened over that queue. Frames: `busy`, `queued`, `queued_model`.
At 56 columns the hint and the model share the footer row; at 44 the hint
takes it alone. Replay two labels with `parsers/frames.probe.ts` for the
phone's footer reader (`antigravity.ts`, `statusLine.ts`).
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from agy import Agy  # noqa: E402


def main():
    if len(sys.argv) < 5:
        sys.exit(__doc__)
    label, binp, port, cols = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
    rows = int(sys.argv[5]) if len(sys.argv) > 5 else 30
    agy = Agy(label, f"queued{cols}", port, binp, size=(cols, rows))
    try:
        agy.first_run()
        time.sleep(3)
        agy.type("STUB:SLOW 60 first")
        agy.keys("Enter")
        time.sleep(2.5)
        agy.cap("busy")
        for prompt in ("second queued", "third queued"):
            agy.type(prompt)
            agy.keys("Enter")
            time.sleep(1.5)
        agy.cap("queued")
        print(f"{label} {cols} queue hint: {'queued messages' in agy.plain()}")
        agy.type("/model")
        agy.keys("Enter")
        time.sleep(2)
        agy.cap("queued_model")
        print(f"{label} {cols} hint under /model: {'queued messages' in agy.plain()}")
        agy.keys("Escape")
        time.sleep(0.5)
    finally:
        agy.close()


if __name__ == "__main__":
    main()
