/**
 * Loading a local (Ollama) model at Tabtivity start (`stores/agents/ollamaAutoload`).
 *
 * The rules worth pinning are the ones a user would experience as a bug if they
 * broke silently: Energy Saver **suppresses** the launch load and says so
 * (rather than loading anyway, or skipping invisibly), the suppression has an
 * explicit opt-out, models are warmed **one at a time** (two at once contend for
 * the same VRAM), and "the server isn't up yet" is waited out rather than
 * reported as a failure — at launch we are usually its first caller.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { useOllamaAutoloadStore, resetOllamaAutoload } from "../../stores/agents/ollamaAutoload";
import { useSettingsStore } from "../../stores/settings";
import { usePowerStore } from "../../stores/power";
import type { Settings } from "../../types";

/** Seat the two stores the launch decision reads. */
function given(settings: Partial<Settings>, onBattery = false) {
  useSettingsStore.setState({ settings: settings as Settings });
  usePowerStore.setState({ onBattery, supported: true, percentage: 50, ready: true });
}

/** Model names passed to `load_ollama_model`, in call order. */
const loadedCalls = () =>
  invoke.mock.calls
    .filter(([cmd]) => cmd === "load_ollama_model")
    .map(([, args]) => (args as { model: string }).model);

/** Every command the store invoked, in order. */
const calledCommands = () => invoke.mock.calls.map(([cmd]) => cmd as string);

/** Answer the residency read with these models already in Ollama's memory. */
function resident(names: string[]) {
  invoke.mockImplementation((cmd: string) =>
    cmd === "list_ollama_models_detailed"
      ? Promise.resolve(names.map((name) => ({ name, running: true })))
      : Promise.resolve(),
  );
}

beforeEach(() => {
  resetOllamaAutoload();
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  vi.useRealTimers();
});

describe("autorun — the launch decision", () => {
  it("loads the armed models, in order, one after another", async () => {
    given({ ollama_autoload_models: ["a:7b", "b:3b"] });
    // Each load resolves only when released, so an overlap would be visible as
    // two in-flight calls at once.
    const releases: Array<() => void> = [];
    invoke.mockImplementation((cmd: string) =>
      cmd === "load_ollama_model"
        ? new Promise<void>((r) => releases.push(() => r()))
        : Promise.resolve(),
    );

    const run = useOllamaAutoloadStore.getState().autorun();
    await Promise.resolve();
    await Promise.resolve();
    expect(loadedCalls()).toEqual(["a:7b"]); // the second has NOT started
    releases[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(loadedCalls()).toEqual(["a:7b", "b:3b"]);
    releases[1]();
    await run;

    expect(useOllamaAutoloadStore.getState().phase).toBe("done");
    expect(useOllamaAutoloadStore.getState().loaded).toEqual(["a:7b", "b:3b"]);
  });

  it("starts the server first — a model cannot be resident in a server that is down", async () => {
    given({ ollama_autoload_models: ["a:7b"] });
    await useOllamaAutoloadStore.getState().autorun();
    expect(invoke.mock.calls[0][0]).toBe("ensure_ollama_running");
  });

  it("does nothing, quietly, when no model is armed", async () => {
    given({});
    await useOllamaAutoloadStore.getState().autorun();
    expect(invoke).not.toHaveBeenCalled();
    expect(useOllamaAutoloadStore.getState().phase).toBe("idle");
  });

  it("runs exactly once — a second call is a no-op", async () => {
    given({ ollama_autoload_models: ["a:7b"] });
    await useOllamaAutoloadStore.getState().autorun();
    await useOllamaAutoloadStore.getState().autorun();
    expect(loadedCalls()).toEqual(["a:7b"]);
  });
});

describe("Energy Saver", () => {
  it("suppresses the load and reports the skip rather than doing it silently", async () => {
    given({ ollama_autoload_models: ["a:7b"], energy_saver: "battery" }, true);
    await useOllamaAutoloadStore.getState().autorun();
    // Nothing was *started*: no server, no load. The one call it does make is a
    // read of what is already in memory (below).
    expect(calledCommands()).not.toContain("ensure_ollama_running");
    expect(loadedCalls()).toEqual([]);
    const s = useOllamaAutoloadStore.getState();
    expect(s.phase).toBe("skipped");
    // The menu's notice needs the names, so the skip carries what it skipped.
    expect(s.models).toEqual(["a:7b"]);
    expect(s.pending).toEqual(["a:7b"]);
    expect(s.dismissed).toBe(false);
  });

  it("says nothing about a model the server already holds — the notice must not contradict the menu's own loaded row", async () => {
    given({ ollama_autoload_models: ["a:7b"], energy_saver: "battery" }, true);
    resident(["a:7b"]);
    await useOllamaAutoloadStore.getState().autorun();
    const s = useOllamaAutoloadStore.getState();
    // The skip is still what happened — it is what there is to *report* that
    // changed, and an empty `pending` is the menu's cue to stay quiet.
    expect(s.phase).toBe("skipped");
    expect(s.pending).toEqual([]);
  });

  it("names only the armed models that are actually missing", async () => {
    given({ ollama_autoload_models: ["a:7b", "b:3b"], energy_saver: "battery" }, true);
    resident(["b:3b"]);
    await useOllamaAutoloadStore.getState().autorun();
    expect(useOllamaAutoloadStore.getState().pending).toEqual(["a:7b"]);
  });

  it("a residency read that fails reports the whole armed list — unreachable means nothing is resident", async () => {
    given({ ollama_autoload_models: ["a:7b"], energy_saver: "battery" }, true);
    invoke.mockImplementation((cmd: string) =>
      cmd === "list_ollama_models_detailed" ? Promise.reject("not_running") : Promise.resolve(),
    );
    await useOllamaAutoloadStore.getState().autorun();
    expect(useOllamaAutoloadStore.getState().pending).toEqual(["a:7b"]);
  });

  it("honours the explicit opt-out", async () => {
    given(
      {
        ollama_autoload_models: ["a:7b"],
        energy_saver: "battery",
        ollama_autoload_in_energy_saver: true,
      },
      true,
    );
    await useOllamaAutoloadStore.getState().autorun();
    expect(loadedCalls()).toEqual(["a:7b"]);
  });

  it("is Energy Saver's own rule, not just the battery — mode `always` skips on AC too", async () => {
    given({ ollama_autoload_models: ["a:7b"], energy_saver: "always" }, false);
    await useOllamaAutoloadStore.getState().autorun();
    expect(useOllamaAutoloadStore.getState().phase).toBe("skipped");
  });

  it("mode `off` loads on battery — the user turned the throttling off", async () => {
    given({ ollama_autoload_models: ["a:7b"], energy_saver: "off" }, true);
    await useOllamaAutoloadStore.getState().autorun();
    expect(loadedCalls()).toEqual(["a:7b"]);
  });

  it("`loadNow` is the way out of a skip (the notice's button)", async () => {
    given({ ollama_autoload_models: ["a:7b"], energy_saver: "battery" }, true);
    await useOllamaAutoloadStore.getState().autorun();
    expect(loadedCalls()).toEqual([]);
    await useOllamaAutoloadStore.getState().loadNow();
    expect(loadedCalls()).toEqual(["a:7b"]);
    expect(useOllamaAutoloadStore.getState().phase).toBe("done");
  });
});

describe("noteResident — the notice outlives the launch it describes", () => {
  it("drops a skipped model the user has since loaded by hand", async () => {
    given({ ollama_autoload_models: ["a:7b", "b:3b"], energy_saver: "battery" }, true);
    await useOllamaAutoloadStore.getState().autorun();
    expect(useOllamaAutoloadStore.getState().pending).toEqual(["a:7b", "b:3b"]);
    useOllamaAutoloadStore.getState().noteResident(["b:3b"]);
    expect(useOllamaAutoloadStore.getState().pending).toEqual(["a:7b"]);
    useOllamaAutoloadStore.getState().noteResident(["a:7b"]);
    expect(useOllamaAutoloadStore.getState().pending).toEqual([]);
  });

  it("clears a failure that has since been resolved, and the phase with it", async () => {
    given({ ollama_autoload_models: ["gone:7b"] });
    invoke.mockImplementation((cmd: string) =>
      cmd === "load_ollama_model" ? Promise.reject("model not found") : Promise.resolve(),
    );
    await useOllamaAutoloadStore.getState().autorun();
    expect(useOllamaAutoloadStore.getState().phase).toBe("error");
    useOllamaAutoloadStore.getState().noteResident(["gone:7b"]);
    const s = useOllamaAutoloadStore.getState();
    expect(s.failed).toEqual({});
    expect(s.pending).toEqual([]);
    expect(s.phase).toBe("done");
  });

  it("is a no-op when nothing moved — it runs on every model-list read", async () => {
    given({ ollama_autoload_models: ["a:7b"], energy_saver: "battery" }, true);
    await useOllamaAutoloadStore.getState().autorun();
    const before = useOllamaAutoloadStore.getState();
    useOllamaAutoloadStore.getState().noteResident(["something:else"]);
    useOllamaAutoloadStore.getState().noteResident([]);
    // Same object identities, so no subscriber re-renders.
    expect(useOllamaAutoloadStore.getState().pending).toBe(before.pending);
    expect(useOllamaAutoloadStore.getState().failed).toBe(before.failed);
  });
});

describe("failures", () => {
  it("waits out `not_running` — the server may still be coming up at launch", async () => {
    vi.useFakeTimers();
    given({ ollama_autoload_models: ["a:7b"] });
    let attempt = 0;
    invoke.mockImplementation((cmd: string) => {
      if (cmd !== "load_ollama_model") return Promise.resolve();
      attempt += 1;
      return attempt < 3 ? Promise.reject("not_running") : Promise.resolve();
    });

    const run = useOllamaAutoloadStore.getState().autorun();
    await vi.advanceTimersByTimeAsync(20_000);
    await run;

    expect(attempt).toBe(3);
    expect(useOllamaAutoloadStore.getState().phase).toBe("done");
  });

  it("does not retry a failure that would fail identically — and keeps going", async () => {
    given({ ollama_autoload_models: ["gone:7b", "ok:3b"] });
    invoke.mockImplementation((cmd: string, args?: { model: string }) =>
      cmd === "load_ollama_model" && args?.model === "gone:7b"
        ? Promise.reject("model not found")
        : Promise.resolve(),
    );

    await useOllamaAutoloadStore.getState().autorun();
    const s = useOllamaAutoloadStore.getState();
    // One attempt for the doomed model, and the next model still ran.
    expect(loadedCalls()).toEqual(["gone:7b", "ok:3b"]);
    expect(s.failed).toEqual({ "gone:7b": "model not found" });
    expect(s.loaded).toEqual(["ok:3b"]);
    expect(s.phase).toBe("error");
  });

  it("a server that cannot be started is not fatal — the load still reports the real reason", async () => {
    given({ ollama_autoload_models: ["a:7b"] });
    invoke.mockImplementation((cmd: string) =>
      cmd === "ensure_ollama_running" ? Promise.reject("no systemd") : Promise.resolve(),
    );
    await useOllamaAutoloadStore.getState().autorun();
    expect(loadedCalls()).toEqual(["a:7b"]);
    expect(useOllamaAutoloadStore.getState().phase).toBe("done");
  });
});
