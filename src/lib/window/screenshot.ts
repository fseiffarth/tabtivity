/**
 * The global Screenshot app's in-app capture seam.
 *
 * Pressing the header's Screenshot button used to always spawn an OS
 * region-capture tool. But when the thing being captured is a PDF on screen,
 * the viewer can do strictly better than a screen grab: it rasterises the
 * selected region from the rendered page canvas (document-sharp, DPR-exact,
 * with pending blackouts burned in), which is what its old ✂ toolbar tool did.
 * That tool is now armed by the Screenshot button instead of a per-viewer
 * button, so there is ONE capture entry point rather than two.
 *
 * The handshake is a synchronous, claimable window event: the launcher
 * dispatches, a visible PDF viewer claims (`detail.claimed = true`), and the
 * launcher reads the flag back to decide whether the external tool still needs
 * to run. First visible viewer wins — the flag is checked before it is set, so
 * two viewers on screen never both arm.
 */
import { NAMES } from "../brand";

export const SCREENSHOT_CAPTURE_EVENT = "app:screenshot-capture";

export type ScreenshotCaptureDetail = { claimed: boolean };

/** Offer the screenshot request to any visible in-app claimant (currently the
 *  PDF viewer). Returns true when one claimed it — the caller must then NOT
 *  spawn the external capture tool. */
export function requestInAppCapture(): boolean {
  const detail: ScreenshotCaptureDetail = { claimed: false };
  window.dispatchEvent(new CustomEvent(SCREENSHOT_CAPTURE_EVENT, { detail }));
  return detail.claimed;
}

/** The project folder a saved screen grab lands in, mirroring the backend's
 *  `commands::projects::SCREENSHOTS_DIR`. `tabtivity-`prefixed on purpose: a repo
 *  may own a `screenshots/` of its own documentation images, and the scaffold
 *  ignores this folder — ignoring theirs would hide their files from git. */
export const APP_SCREENSHOTS_DIR = NAMES.screenshotsDir;

/** `Screenshot-YYYYMMDD-HHMMSS.png` in UTC — the exact shape the backend's
 *  `capture_project_screenshot` writes, so in-app shots sort beside tool shots
 *  in the same `tabtivity-screenshots/` folder. */
export function screenshotFilename(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `Screenshot-${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}.png`
  );
}

/**
 * How long Shift+click waits before the capture actually fires.
 *
 * A region tool takes an exclusive pointer/keyboard grab for the whole of its
 * selection, so Alt+Tab during the overlay goes to the overlay, not the window
 * manager — there is no way to bring another window forward once the tool is
 * up. The delay is that missing step: press, switch windows, *then* the overlay
 * appears over whatever is now on top.
 */
export const SCREENSHOT_DELAY_MS = 5000;

/** The pending countdown's interval id, or null when none is running. Module
 *  state rather than component state because the (since removed) header launcher
 *  unmounted the moment its hover menu closed — which is immediately after the click that starts the
 *  countdown. */
let countdownTimer: number | null = null;

/** Stop a running countdown (nothing is captured). Safe to call when idle;
 *  returns whether one was actually cancelled. */
export function cancelDelayedCapture(): boolean {
  if (countdownTimer === null) return false;
  window.clearInterval(countdownTimer);
  countdownTimer = null;
  return true;
}

/**
 * Count down `delayMs`, then fire `capture`.
 *
 * Driven off a wall-clock deadline rather than a single `setTimeout` because
 * the window is *meant* to lose focus during the wait (that is the whole
 * point), and an occluded WebKitGTK page has its timers throttled to ~1s
 * buckets: a deadline comparison re-checked often simply fires on the first
 * tick past the deadline instead of drifting. `tick` is called once per whole
 * second remaining, for the countdown toast.
 *
 * A second call replaces the first — pressing Screenshot again restarts the
 * countdown rather than queueing two captures.
 */
export function startDelayedCapture(opts: {
  delayMs: number;
  tick: (secondsLeft: number) => void;
  capture: () => void;
}): void {
  const { delayMs, tick, capture } = opts;
  cancelDelayedCapture();
  const deadline = Date.now() + delayMs;
  let shown = -1;
  const step = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      cancelDelayedCapture();
      capture();
      return;
    }
    const secs = Math.ceil(remaining / 1000);
    if (secs !== shown) {
      shown = secs;
      tick(secs);
    }
  };
  step();
  countdownTimer = window.setInterval(step, 200);
}
