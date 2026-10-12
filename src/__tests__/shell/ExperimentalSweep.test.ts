/**
 * Withdrawing an experiment that owns a tab (`lib/experimentalSweep`). Pinned:
 * unknown is not off (a null settings store closes nothing — it would take the
 * user's restored tabs in the window before settings arrive), "off" closes the
 * open browser tabs AND the live browser windows, an explicit or debug-inherited
 * "on" closes nothing, and the installer re-runs only when the settings object
 * itself changes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { initExperimentalSweep, sweepWithdrawnExperiments } from "../../lib/experimentalSweep";
import { useBrowserStore } from "../../stores/browser";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore } from "../../stores/tabs";

const closeTabsOfKinds = vi.fn();
const closeLive = vi.fn(async () => {});
const live = [{ label: "browser-1" }, { label: "browser-2" }] as never;

beforeEach(() => {
  vi.clearAllMocks();
  useTabsStore.setState({ closeTabsOfKinds });
  useBrowserStore.setState({ live, closeLive });
  useSettingsStore.setState({ settings: null, loaded: false });
});

describe("sweepWithdrawnExperiments", () => {
  it("closes nothing while settings are unknown", () => {
    sweepWithdrawnExperiments();
    expect(closeTabsOfKinds).not.toHaveBeenCalled();
    expect(closeLive).not.toHaveBeenCalled();
  });

  it("closes browser tabs and every live browser window once the flag is off", () => {
    useSettingsStore.setState({ settings: { web_browser: false, debug: true }, loaded: true });
    sweepWithdrawnExperiments();
    expect(closeTabsOfKinds).toHaveBeenCalledWith(["browser"]);
    expect(closeLive).toHaveBeenCalledTimes(2);
    expect(closeLive).toHaveBeenCalledWith("browser-1");
    expect(closeLive).toHaveBeenCalledWith("browser-2");
  });

  it("treats an unset flag as off outside debug mode, and as on inside it while unmarked", () => {
    useSettingsStore.setState({ settings: {}, loaded: true });
    sweepWithdrawnExperiments();
    expect(closeTabsOfKinds).toHaveBeenCalledWith(["browser"]);
    closeTabsOfKinds.mockClear();
    closeLive.mockClear();
    useSettingsStore.setState({ settings: { debug: true }, loaded: true });
    sweepWithdrawnExperiments();
    expect(closeTabsOfKinds).not.toHaveBeenCalled();
    useSettingsStore.setState({ settings: { web_browser: true }, loaded: true });
    sweepWithdrawnExperiments();
    expect(closeTabsOfKinds).not.toHaveBeenCalled();
    expect(closeLive).not.toHaveBeenCalled();
  });

  it("treats an unset flag as off inside debug mode too once the profile is marked", () => {
    useSettingsStore.setState({
      settings: { debug: true, experimental_explicit: true },
      loaded: true,
    });
    sweepWithdrawnExperiments();
    expect(closeTabsOfKinds).toHaveBeenCalledWith(["browser"]);
    closeTabsOfKinds.mockClear();
    // The migration's own result: the browser ticked explicitly, nothing closes.
    useSettingsStore.setState({
      settings: { debug: true, experimental_explicit: true, web_browser: true },
      loaded: true,
    });
    sweepWithdrawnExperiments();
    expect(closeTabsOfKinds).not.toHaveBeenCalled();
  });
});

describe("initExperimentalSweep", () => {
  it("sweeps now, again on each new settings object, and stops after unsubscribe", () => {
    useSettingsStore.setState({ settings: {}, loaded: true });
    const stop = initExperimentalSweep();
    expect(closeTabsOfKinds).toHaveBeenCalledTimes(1);
    // A store write that leaves `settings` alone is not a settings change.
    useSettingsStore.setState({ loaded: true });
    expect(closeTabsOfKinds).toHaveBeenCalledTimes(1);
    useSettingsStore.setState({ settings: { web_browser: false } });
    expect(closeTabsOfKinds).toHaveBeenCalledTimes(2);
    stop();
    useSettingsStore.setState({ settings: { web_browser: false, debug: false } });
    expect(closeTabsOfKinds).toHaveBeenCalledTimes(2);
  });
});
