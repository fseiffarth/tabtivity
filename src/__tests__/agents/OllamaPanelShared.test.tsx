/**
 * Settings → Ollama follows the same activity store as the 🧠 menu: a pull
 * paused from the menu offers Resume here, and a pull shows its live percent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  handlers: new Map<string, (e: { payload: unknown }) => void>(),
  orphans: [] as { digest: string; size: number; path: string }[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "ollama_is_installed") return true;
    if (cmd === "list_ollama_models_detailed") return [];
    if (cmd === "list_pending_ollama_pulls") return [];
    if (cmd === "list_orphan_partial_blobs") return h.orphans;
    return null;
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, cb: (e: { payload: unknown }) => void) => {
    h.handlers.set(name, cb);
    return Promise.resolve(() => h.handlers.delete(name));
  }),
  emit: vi.fn(() => Promise.resolve()),
}));

import { OllamaPanel } from "../../components/settings/OllamaPanel";
import { __resetOllamaActivityForTests, useOllamaActivityStore } from "../../stores/agents/ollamaActivity";

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

beforeEach(() => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  h.handlers.clear();
  h.orphans = [];
  __resetOllamaActivityForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  __resetOllamaActivityForTests();
});

describe("Settings Ollama panel", () => {
  it("offers Resume for a pull paused from the header menu, and follows live progress", async () => {
    render(<OllamaPanel onBack={() => {}} onClose={() => {}} />);
    await flush();
    const pull = h.handlers.get("ollama-pull-progress")!;
    expect(pull).toBeTruthy();
    act(() => pull({ payload: { model: "qwen:7b", status: "pulling layer", completed: 1, total: 4 } }));
    expect(screen.getByText("25%")).toBeTruthy();
    expect(screen.getByText("pulling layer")).toBeTruthy();
    act(() => pull({ payload: { model: "qwen:7b", status: "paused", completed: 1, total: 4 } }));
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
    expect(screen.queryByText("25%")).toBeNull();
  });

  it("shows a pull that was paused before Settings was opened", async () => {
    // Paused from the 🧠 menu while this panel was not mounted: only the store knows.
    useOllamaActivityStore.setState({ paused: ["qwen:7b"] });
    render(<OllamaPanel onBack={() => {}} onClose={() => {}} />);
    await flush();
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
    act(() => screen.getByRole("button", { name: "Resume" }).click());
    expect(useOllamaActivityStore.getState().paused).toEqual([]);
  });

  it("does not list a live pull's layer as an orphan", async () => {
    h.orphans = [
      { digest: "5c19f6282f4f", size: 2, path: "/b/sha256-5c19f6282f4f-partial" },
      { digest: "aaaaaaaaaaaa", size: 1, path: "/b/sha256-aaaaaaaaaaaa-partial" },
    ];
    render(<OllamaPanel onBack={() => {}} onClose={() => {}} />);
    await flush();
    expect(screen.getByText("layer 5c19f6282f4f…")).toBeTruthy();
    const pull = h.handlers.get("ollama-pull-progress")!;
    act(() => pull({ payload: { model: "qwen:7b", status: "pulling 5c19f6282f4f", completed: 1, total: 4 } }));
    await flush();
    expect(screen.queryByText("layer 5c19f6282f4f…")).toBeNull();
    expect(screen.getByText("layer aaaaaaaaaaaa…")).toBeTruthy();
  });
});
