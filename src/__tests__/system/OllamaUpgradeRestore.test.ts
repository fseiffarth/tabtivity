/**
 * Putting the models back after an Ollama upgrade (`stores/agents/ollamaUpgrade`).
 *
 * The upgrade runs in a terminal tab, so there is no completion callback to
 * hang this on — the restart is *observed*, by polling the local version. That
 * makes three rules worth pinning, because each fails silently if it breaks:
 * a **changed** version is the only signal that starts the reload (an
 * unreadable one is the binary mid-replacement, not an answer), the wait is
 * **bounded** and running out is a reported state with a retry rather than a
 * silent give-up, and an upgrade with **nothing resident** loads nothing — this
 * restores what was there, it never invents a load. A server the upgrade left
 * running on the old version is restarted, but only once it has stayed stale
 * for two polls (an installer may still be restarting it), and a failed restart
 * is a reported state with a retry.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const versionStatus = vi.fn();
vi.mock("../../lib/agents/localDrivers", () => ({
  ollamaVersionStatus: (...a: unknown[]) => versionStatus(...a),
}));

import { useOllamaUpgradeStore, resetOllamaUpgrade } from "../../stores/agents/ollamaUpgrade";

const phase = () => useOllamaUpgradeStore.getState().phase;
const begin = (from: string, models: string[]) =>
  useOllamaUpgradeStore.getState().begin(from, models);

/** Model names passed to `load_ollama_model`, in call order. */
const loadedCalls = () =>
  invoke.mock.calls
    .filter(([cmd]) => cmd === "load_ollama_model")
    .map(([, args]) => (args as { model: string }).model);

/** What the local `ollama --version` read answers from now on. */
const reports = (current: string, server = current) =>
  versionStatus.mockResolvedValue({
    current,
    server,
    latest: "",
    update_available: false,
    install_cmd: "",
    shell_kind: "",
    error: null,
  });

/** Advance the poll by one tick and let its promise chain settle. */
async function tick(ms = 5_000) {
  await vi.advanceTimersByTimeAsync(ms);
  await vi.waitFor(() => Promise.resolve());
}

beforeEach(() => {
  resetOllamaUpgrade();
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  versionStatus.mockReset();
  reports("0.14.3");
  vi.useFakeTimers();
});

afterEach(() => {
  resetOllamaUpgrade();
  vi.useRealTimers();
});

describe("the snapshot", () => {
  it("loads nothing when nothing was resident, and says nothing if no restart was needed", async () => {
    begin("0.14.3", []);
    expect(phase()).toBe("waiting"); // the server may still need restarting
    reports("0.15.2");
    await tick();
    expect(phase()).toBe("idle");
    expect(loadedCalls()).toEqual([]);
    expect(invoke).not.toHaveBeenCalledWith("restart_ollama_server");
  });

  it("starts no watcher with nothing installed to compare against", async () => {
    begin("", ["a:7b"]);
    expect(phase()).toBe("idle");
    await tick();
    expect(versionStatus).not.toHaveBeenCalled();
  });

  it("waits, watching the local version, when something was", async () => {
    begin("0.14.3", ["a:7b"]);
    expect(phase()).toBe("waiting");
    await tick();
    expect(versionStatus).toHaveBeenCalledWith(false); // local read, no network
    expect(loadedCalls()).toEqual([]); // same version — the server has not changed
  });
});

describe("the restart signal", () => {
  it("loads the snapshot back, in order, once the version changes", async () => {
    begin("0.14.3", ["a:7b", "b:3b"]);
    await tick();
    expect(loadedCalls()).toEqual([]);

    reports("0.15.2");
    await tick();
    await vi.waitFor(() => expect(phase()).toBe("done"));
    expect(loadedCalls()).toEqual(["a:7b", "b:3b"]);
  });

  it("keeps waiting while the version cannot be read at all", async () => {
    begin("0.14.3", ["a:7b"]);
    reports(""); // the binary is being replaced under us
    await tick();
    await tick();
    expect(phase()).toBe("waiting");
    expect(loadedCalls()).toEqual([]);
  });

  it("keeps waiting when the version read fails outright", async () => {
    begin("0.14.3", ["a:7b"]);
    versionStatus.mockRejectedValue(new Error("no binary"));
    await tick();
    expect(phase()).toBe("waiting");
  });
});

describe("when the restart never comes", () => {
  it("gives up out loud after the window, leaving something to click", async () => {
    begin("0.14.3", ["a:7b"]);
    await vi.advanceTimersByTimeAsync(16 * 60_000);
    expect(phase()).toBe("timeout");
    expect(loadedCalls()).toEqual([]);

    // …and the retry loads exactly the snapshot, restart or no restart.
    await useOllamaUpgradeStore.getState().reloadNow();
    expect(loadedCalls()).toEqual(["a:7b"]);
    expect(phase()).toBe("done");
  });

  it("stops watching when the user cancels, and forgets the snapshot", async () => {
    begin("0.14.3", ["a:7b"]);
    useOllamaUpgradeStore.getState().cancel();
    expect(phase()).toBe("idle");
    reports("0.15.2");
    await tick();
    await tick();
    expect(loadedCalls()).toEqual([]);
  });
});

describe("a model that will not come back", () => {
  it("is reported as an error, naming it, with the rest still loaded", async () => {
    invoke.mockImplementation((cmd: string, args?: unknown) =>
      cmd === "load_ollama_model" && (args as { model: string }).model === "b:3b"
        ? Promise.reject("model not found")
        : Promise.resolve(),
    );
    begin("0.14.3", ["a:7b", "b:3b"]);
    reports("0.15.2");
    await tick();
    await vi.waitFor(() => expect(phase()).toBe("error"));
    const s = useOllamaUpgradeStore.getState();
    expect(s.loaded).toEqual(["a:7b"]);
    expect(s.failed).toEqual({ "b:3b": "model not found" });
  });
});

const restarts = () => invoke.mock.calls.filter(([cmd]) => cmd === "restart_ollama_server").length;

describe("a server the upgrade left running", () => {
  it("is restarted once it stays on the old version, then the models come back", async () => {
    begin("0.14.3", ["a:7b"]);
    reports("0.15.2", "0.14.3");
    await tick();
    // One stale reading may be an installer about to restart it itself.
    expect(restarts()).toBe(0);
    expect(phase()).toBe("waiting");
    await tick();
    await vi.waitFor(() => expect(phase()).toBe("done"));
    expect(restarts()).toBe(1);
    expect(loadedCalls()).toEqual(["a:7b"]);
    expect(useOllamaUpgradeStore.getState().to).toBe("0.15.2");
  });

  it("is restarted with nothing resident, and the note says it was", async () => {
    begin("0.14.3", []);
    reports("0.15.2", "0.14.3");
    await tick();
    await tick();
    await vi.waitFor(() => expect(phase()).toBe("done"));
    expect(restarts()).toBe(1);
    expect(loadedCalls()).toEqual([]);
  });

  it("is left alone when the installer restarted it itself", async () => {
    begin("0.14.3", ["a:7b"]);
    reports("0.15.2", "0.14.3");
    await tick();
    reports("0.15.2"); // the installer's own restart landed in between
    await tick();
    await vi.waitFor(() => expect(phase()).toBe("done"));
    expect(restarts()).toBe(0);
  });

  it("is not restarted when no server is running at all", async () => {
    begin("0.14.3", ["a:7b"]);
    reports("0.15.2", "");
    await tick();
    await vi.waitFor(() => expect(phase()).toBe("done"));
    expect(restarts()).toBe(0);
  });

  it("reports a failed restart, loads nothing, and retries on the click", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === "restart_ollama_server" ? Promise.reject("ollama_still_running") : Promise.resolve(),
    );
    begin("0.14.3", ["a:7b"]);
    reports("0.15.2", "0.14.3");
    await tick();
    await tick();
    await vi.waitFor(() => expect(phase()).toBe("restart_failed"));
    expect(useOllamaUpgradeStore.getState().restartError).toBe("ollama_still_running");
    expect(loadedCalls()).toEqual([]);

    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    await useOllamaUpgradeStore.getState().restartNow();
    expect(restarts()).toBe(1);
    expect(phase()).toBe("done");
    expect(loadedCalls()).toEqual(["a:7b"]);
  });
});
