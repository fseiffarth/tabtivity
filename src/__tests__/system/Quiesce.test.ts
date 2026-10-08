/**
 * Window-blur quiescence (`stores/power`, typing-latency plan step 3).
 *
 * The renderer never reaching idle is what forfeits the scheduler's
 * interactive fast path, so a blurred window must engage the same throttles
 * Energy Saver does: `startFocusTracking` mirrors this window's focus into the
 * store AND onto the document root (`data-blurred`, where themes.css pauses
 * every animation), and `quiesceActive` reads "throttle now?" as saver OR
 * blurred. The rules worth pinning: blur engages, focus disengages, teardown
 * stops listening, and the blur half never leaks into the *battery* reading
 * (`energySaverActive`), which decisions about power — model autoload — stay on.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import {
  usePowerStore,
  startFocusTracking,
  quiesceActive,
  energySaverActive,
  saverInterval,
} from "../../stores/power";
import { useSettingsStore } from "../../stores/settings";
import type { Settings } from "../../types";

beforeEach(() => {
  usePowerStore.setState({ onBattery: false, blurred: false });
  useSettingsStore.setState({
    settings: { energy_saver: "battery" } as unknown as Settings,
  });
  delete document.documentElement.dataset.blurred;
});

/** A window blur, decided one task later (focus has landed by then). */
async function blur() {
  window.dispatchEvent(new Event("blur"));
  await new Promise((r) => setTimeout(r, 0));
}

afterEach(() => {
  vi.restoreAllMocks();
  document.querySelectorAll("iframe").forEach((f) => f.remove());
});

describe("startFocusTracking", () => {
  it("blur engages quiesce and marks the root; focus disengages both", async () => {
    const stop = startFocusTracking();
    // Tracking seeds from document.hasFocus() (false in jsdom); a focus event
    // settles it, which is also what a real window fires as it comes forward.
    window.dispatchEvent(new Event("focus"));
    expect(usePowerStore.getState().blurred).toBe(false);
    expect(quiesceActive()).toBe(false);

    await blur();
    expect(usePowerStore.getState().blurred).toBe(true);
    expect(quiesceActive()).toBe(true);
    expect(document.documentElement.dataset.blurred).toBe("on");

    window.dispatchEvent(new Event("focus"));
    expect(usePowerStore.getState().blurred).toBe(false);
    expect(quiesceActive()).toBe(false);
    expect(document.documentElement.dataset.blurred).toBeUndefined();
    stop();
  });

  it("stops listening after teardown", async () => {
    const stop = startFocusTracking();
    window.dispatchEvent(new Event("focus"));
    stop();
    await blur();
    expect(usePowerStore.getState().blurred).toBe(false);
    expect(document.documentElement.dataset.blurred).toBeUndefined();
  });
});

describe("startFocusTracking with an iframe", () => {
  it("focus moving into an iframe of this window is not a blur", async () => {
    const stop = startFocusTracking();
    window.dispatchEvent(new Event("focus"));
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    // What a click into a mail body / reader view does: the frame becomes the
    // active element and the window fires `blur`, while the window keeps focus.
    vi.spyOn(document, "activeElement", "get").mockReturnValue(frame);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    await blur();
    expect(usePowerStore.getState().blurred).toBe(false);
    expect(document.documentElement.dataset.blurred).toBeUndefined();

    // Leaving the window from inside a (same-origin) frame: its blur says so…
    vi.mocked(document.hasFocus).mockReturnValue(false);
    frame.contentWindow!.dispatchEvent(new Event("blur"));
    await new Promise((r) => setTimeout(r, 0));
    expect(usePowerStore.getState().blurred).toBe(true);
    // …and coming back into it, its focus.
    frame.contentWindow!.dispatchEvent(new Event("focus"));
    expect(usePowerStore.getState().blurred).toBe(false);
    stop();
  });

  it("focus that leaves for another app is still a blur", async () => {
    const stop = startFocusTracking();
    window.dispatchEvent(new Event("focus"));
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    await blur();
    expect(usePowerStore.getState().blurred).toBe(true);
    stop();
  });

  it("a blur answered by a focus within the same task never engages", async () => {
    const stop = startFocusTracking();
    window.dispatchEvent(new Event("focus"));
    const seen: boolean[] = [];
    const unsub = usePowerStore.subscribe((s) => seen.push(s.blurred));
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).not.toContain(true);
    unsub();
    stop();
  });
});

describe("quiesce vs energy saver", () => {
  it("blur throttles timers without pretending to be on battery", () => {
    usePowerStore.setState({ blurred: true });
    // The timer sites widen…
    expect(quiesceActive()).toBe(true);
    expect(saverInterval(1000, quiesceActive())).toBe(3000);
    // …but the battery reading (model autoload's gate) is untouched.
    expect(energySaverActive()).toBe(false);
  });

  it("energy saver alone also quiesces", () => {
    useSettingsStore.setState({
      settings: { energy_saver: "always" } as unknown as Settings,
    });
    expect(quiesceActive()).toBe(true);
  });
});
