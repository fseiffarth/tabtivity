import { invoke } from "@tauri-apps/api/core";
import { currentWindowLabel } from "./crossWindow";

/** How long to wait for the two frames before asking anyway: a renderer whose
 *  frames are not being presented may not run `requestAnimationFrame` at all. */
const FRAME_WAIT_MAX_MS = 250;

/**
 * Ask the backend for a popout's ±1px size nudge (`detached_first_paint`) once
 * what was just drawn has had a frame: two rAFs — one to reach the next frame,
 * one so that frame has been presented — or {@link FRAME_WAIT_MAX_MS}, whichever
 * comes first. WebKitGTK can leave a popout's surface showing nothing (or stale
 * pixels) until a genuine resize; the backend's own nudge runs on a timer at
 * creation, which content drawn later (a seeded group, a PDF's first page)
 * misses. A no-op outside a popout window. Returns a cancel for an unmount.
 */
export function askPopoutRepaint(): () => void {
  if (!currentWindowLabel().startsWith("detached-")) return () => {};
  let raf = 0;
  let done = false;
  const ask = () => {
    if (done) return;
    done = true;
    if (raf) cancelAnimationFrame(raf);
    window.clearTimeout(timer);
    void invoke("detached_first_paint").catch(() => {});
  };
  const timer = window.setTimeout(ask, FRAME_WAIT_MAX_MS);
  raf = requestAnimationFrame(() => {
    raf = requestAnimationFrame(() => {
      raf = 0;
      ask();
    });
  });
  return () => {
    done = true;
    if (raf) cancelAnimationFrame(raf);
    window.clearTimeout(timer);
  };
}
