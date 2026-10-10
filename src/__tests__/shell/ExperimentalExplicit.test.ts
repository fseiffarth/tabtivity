/**
 * The one-shot move onto explicit experimental flags (tab cost plan step 3).
 *
 * Debug mode used to turn every unset experiment on. Now an unset flag is off —
 * but a profile that had Debug mode on keeps what it was showing: the first main
 * window load writes those experiments as explicit ticks plus the
 * `experimental_explicit` marker. Pinned here: what the patch holds (never
 * `terminal_webgl`, never over an explicit value), that it runs once, that a
 * failed write leaves the profile unmarked so it retries, and that no moment in
 * between shows a debug user's flags as off.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import {
  EXPERIMENTAL_FLAGS,
  experimentalEnabled,
  explicitExperimentalPatch,
  migrateExperimentalOnce,
} from "../../lib/experimental";
import { useSettingsStore } from "../../stores/settings";
import type { Settings } from "../../types";

const s = (o: Partial<Settings>): Settings => o as Settings;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A backend that merges each patch into `disk`, as `patch_settings` does. */
function mergingBackend(disk: Settings) {
  invoke.mockImplementation((cmd: string, args?: { patch?: Partial<Settings> }) => {
    if (cmd === "patch_settings") {
      Object.assign(disk, args?.patch ?? {});
      return Promise.resolve({ ...disk });
    }
    return Promise.resolve(undefined);
  });
}

const patchCalls = () => invoke.mock.calls.filter(([cmd]) => cmd === "patch_settings");

describe("explicitExperimentalPatch", () => {
  it("ticks every unset flag Debug mode carried, never the WebGL renderer, plus the marker", () => {
    const patch = explicitExperimentalPatch(s({ debug: true }));
    const expected: Partial<Settings> = { experimental_explicit: true };
    for (const flag of EXPERIMENTAL_FLAGS) if (flag !== "terminal_webgl") expected[flag] = true;
    expect(patch).toEqual(expected);
    expect(patch).not.toHaveProperty("terminal_webgl");
  });

  it("writes the marker alone outside Debug mode", () => {
    expect(explicitExperimentalPatch(s({}))).toEqual({ experimental_explicit: true });
    expect(explicitExperimentalPatch(s({ debug: false, web_browser: true }))).toEqual({
      experimental_explicit: true,
    });
  });

  it("is null once the profile is marked", () => {
    expect(explicitExperimentalPatch(s({ experimental_explicit: true }))).toBeNull();
    expect(explicitExperimentalPatch(s({ debug: true, experimental_explicit: true }))).toBeNull();
  });

  it("never overwrites an explicit value", () => {
    const patch = explicitExperimentalPatch(
      s({ debug: true, mail_client: false, web_browser: true, terminal_webgl: true }),
    );
    expect(patch).not.toHaveProperty("mail_client");
    expect(patch).not.toHaveProperty("web_browser");
    expect(patch).not.toHaveProperty("terminal_webgl");
    expect(patch?.python_run_debug).toBe(true);
  });

  it("changes nothing a debug profile shows", () => {
    const before = s({ debug: true, md_graph: false });
    const after = s({ ...before, ...explicitExperimentalPatch(before) });
    for (const flag of EXPERIMENTAL_FLAGS) {
      expect(experimentalEnabled(after, flag)).toBe(experimentalEnabled(before, flag));
    }
    expect(after.experimental_explicit).toBe(true);
  });
});

describe("migrateExperimentalOnce", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("writes once, and a second load writes nothing", async () => {
    const disk = s({ debug: true });
    mergingBackend(disk);
    useSettingsStore.setState({ settings: { ...disk }, loaded: true });

    await migrateExperimentalOnce();
    expect(patchCalls()).toHaveLength(1);
    const settings = useSettingsStore.getState().settings;
    expect(settings?.experimental_explicit).toBe(true);
    expect(settings?.web_browser).toBe(true);
    expect(settings?.terminal_webgl).toBeUndefined();

    // The next launch reads the marked file.
    useSettingsStore.setState({ settings: { ...disk }, loaded: true });
    await migrateExperimentalOnce();
    expect(patchCalls()).toHaveLength(1);
  });

  it("never shows a debug user's flags as off while the write is in flight", async () => {
    const write = deferred<Settings>();
    invoke.mockImplementation((cmd: string) =>
      cmd === "patch_settings" ? write.promise : Promise.resolve(undefined),
    );
    useSettingsStore.setState({ settings: s({ debug: true }), loaded: true });
    const seen: boolean[] = [];
    const stop = useSettingsStore.subscribe((st) =>
      seen.push(experimentalEnabled(st.settings, "web_browser")),
    );

    const pending = migrateExperimentalOnce();
    expect(experimentalEnabled(useSettingsStore.getState().settings, "web_browser")).toBe(true);
    write.resolve(s({ ...useSettingsStore.getState().settings }));
    await pending;
    stop();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);
  });

  it("leaves the profile unmarked when the write fails, and retries on the next call", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === "patch_settings" ? Promise.reject(new Error("disk full")) : Promise.resolve(undefined),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    useSettingsStore.setState({ settings: s({ debug: true }), loaded: true });

    await migrateExperimentalOnce();
    const settings = useSettingsStore.getState().settings;
    expect(settings?.experimental_explicit).toBeUndefined();
    // Unmarked, so the old rule still holds: nothing went off.
    expect(experimentalEnabled(settings, "web_browser")).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();

    mergingBackend(s({ debug: true }));
    await migrateExperimentalOnce();
    expect(useSettingsStore.getState().settings?.experimental_explicit).toBe(true);
  });

  it("writes nothing onto a store that has not loaded", async () => {
    mergingBackend(s({}));
    useSettingsStore.setState({ settings: null, loaded: false });
    await migrateExperimentalOnce();
    useSettingsStore.setState({ settings: s({ debug: true }), loaded: false });
    await migrateExperimentalOnce();
    expect(patchCalls()).toHaveLength(0);
  });

  it("shares one write between concurrent calls", async () => {
    const write = deferred<Settings>();
    invoke.mockImplementation((cmd: string) =>
      cmd === "patch_settings" ? write.promise : Promise.resolve(undefined),
    );
    useSettingsStore.setState({ settings: s({}), loaded: true });
    const a = migrateExperimentalOnce();
    // A stale snapshot lands meanwhile (StrictMode's second load).
    useSettingsStore.setState({ settings: s({}), loaded: true });
    const b = migrateExperimentalOnce();
    write.resolve(s({ experimental_explicit: true }));
    await Promise.all([a, b]);
    expect(patchCalls()).toHaveLength(1);
  });
});
