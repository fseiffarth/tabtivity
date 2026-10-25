/**
 * `stores/agents/ollamaActivity`: the local-model facts the header dropdown and
 * the Models & agents overlay share. The event subscription is ref-counted so
 * both surfaces (and StrictMode's double mount) can ask for it without
 * registering the global listeners twice or dropping them early.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  listens: [] as string[],
  unlistens: [] as string[],
  handlers: new Map<string, (e: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) =>
    cmd === "list_ollama_models_detailed"
      ? Promise.resolve([{ name: "qwen:7b", running: true }])
      : Promise.resolve(null),
  ),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, cb: (e: { payload: unknown }) => void) => {
    h.listens.push(name);
    h.handlers.set(name, cb);
    return Promise.resolve(() => {
      h.unlistens.push(name);
      h.handlers.delete(name);
    });
  }),
  emit: vi.fn(() => Promise.resolve()),
}));

import {
  __resetOllamaActivityForTests,
  initLocalModelEvents,
  useOllamaActivityStore,
} from "../../stores/agents/ollamaActivity";

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  h.listens.length = 0;
  h.unlistens.length = 0;
  h.handlers.clear();
  __resetOllamaActivityForTests();
});

describe("ollamaActivity", () => {
  it("registers the two listeners once however many surfaces ask", async () => {
    const a = initLocalModelEvents();
    const b = initLocalModelEvents();
    await flush();
    expect(h.listens.sort()).toEqual(["ollama-load-progress", "ollama-pull-progress"]);
    a();
    await flush();
    expect(h.unlistens).toEqual([]);
    // A second call of the same disposer must not count twice.
    a();
    await flush();
    expect(h.unlistens).toEqual([]);
    b();
    await flush();
    expect(h.unlistens.sort()).toEqual(["ollama-load-progress", "ollama-pull-progress"]);
  });

  it("keeps downloads, pauses and loads in the store", async () => {
    const dispose = initLocalModelEvents();
    await flush();
    const pull = h.handlers.get("ollama-pull-progress")!;
    pull({ payload: { model: "m", status: "pulling", completed: 1, total: 4 } });
    expect(useOllamaActivityStore.getState().downloads).toEqual({ m: { pct: 25, status: "pulling" } });
    pull({ payload: { model: "m", status: "paused", completed: 1, total: 4 } });
    expect(useOllamaActivityStore.getState().downloads).toEqual({});
    expect(useOllamaActivityStore.getState().paused).toEqual(["m"]);
    useOllamaActivityStore.getState().clearPaused("m");
    expect(useOllamaActivityStore.getState().paused).toEqual([]);

    h.handlers.get("ollama-load-progress")!({ payload: { model: "qwen:7b", status: "loading" } });
    expect(useOllamaActivityStore.getState().loads).toEqual({ "qwen:7b": "loading" });
    h.handlers.get("ollama-load-progress")!({ payload: { model: "qwen:7b", status: "success" } });
    expect(useOllamaActivityStore.getState().loads).toEqual({});
    await flush();
    // A finished load re-reads the model list.
    expect(useOllamaActivityStore.getState().models.map((m) => m.name)).toEqual(["qwen:7b"]);
    dispose();
  });

  it("notifies no one for a progress line that doesn't move the whole percent", async () => {
    const dispose = initLocalModelEvents();
    await flush();
    const pull = h.handlers.get("ollama-pull-progress")!;
    pull({ payload: { model: "m", status: "pulling", completed: 250, total: 1000 } });
    const before = useOllamaActivityStore.getState().downloads;
    const notified = vi.fn();
    const unsub = useOllamaActivityStore.subscribe(notified);
    // 25.0% → 25.9%: the same shown percent, the same state.
    pull({ payload: { model: "m", status: "pulling", completed: 259, total: 1000 } });
    expect(useOllamaActivityStore.getState().downloads).toBe(before);
    expect(notified).not.toHaveBeenCalled();
    // An unknown total stays null the same way.
    pull({ payload: { model: "n", status: "pulling", completed: 1, total: 0 } });
    const withN = useOllamaActivityStore.getState().downloads;
    expect(withN).toEqual({ m: { pct: 25, status: "pulling" }, n: { pct: null, status: "pulling" } });
    pull({ payload: { model: "n", status: "pulling", completed: 2, total: 0 } });
    expect(useOllamaActivityStore.getState().downloads).toBe(withN);
    // 26%: a real step, a new object.
    pull({ payload: { model: "m", status: "pulling", completed: 260, total: 1000 } });
    expect(useOllamaActivityStore.getState().downloads).toEqual({ m: { pct: 26, status: "pulling" }, n: { pct: null, status: "pulling" } });
    unsub();
    dispose();
  });

  it("drops a stale upgrade verdict when the installed version moves", () => {
    const s = useOllamaActivityStore.getState();
    const base = { install_cmd: "x", shell_kind: "", error: null };
    s.setVersion({ current: "0.14.0", latest: "0.15.0", update_available: true, ...base });
    s.mergeInstalledVersion({ current: "0.14.0", latest: "", update_available: false, ...base });
    expect(useOllamaActivityStore.getState().version).toMatchObject({ latest: "0.15.0", update_available: true });
    s.mergeInstalledVersion({ current: "0.15.0", latest: "", update_available: false, ...base });
    expect(useOllamaActivityStore.getState().version).toMatchObject({ latest: "0.15.0", update_available: false });
  });

  it("resets for tests", async () => {
    initLocalModelEvents();
    useOllamaActivityStore.setState({ installed: true, paused: ["x"], downloads: { y: { pct: 1, status: "pulling" } } });
    __resetOllamaActivityForTests();
    const s = useOllamaActivityStore.getState();
    expect(s.installed).toBe(false);
    expect(s.paused).toEqual([]);
    expect(s.downloads).toEqual({});
    // The count starts over: the next init registers afresh.
    h.listens.length = 0;
    initLocalModelEvents();
    await flush();
    expect(h.listens).toHaveLength(2);
  });
});
