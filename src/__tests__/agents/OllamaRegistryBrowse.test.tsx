/**
 * Settings → Ollama → Browse the Ollama registry: filters and sort go to
 * ollama.com (`search_ollama_registry`), scrolling appends the next page until
 * the last one, community uploads are marked, and an answer for a superseded
 * request never lands.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

interface SearchArgs {
  query: string;
  capabilities: string[];
  size: string;
  sort: string;
  page: number;
}

const h = vi.hoisted(() => ({
  searches: [] as SearchArgs[],
  // Answers a search; a test swaps it to hold one back.
  answer: (_args: SearchArgs): Promise<unknown> => Promise.resolve(null),
  observer: null as null | ((entries: { isIntersecting: boolean }[]) => void),
  // The sentinel sits in view: observing reports it at once, as a browser does.
  sentinelVisible: false,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: unknown) => {
    if (cmd === "ollama_is_installed") return true;
    if (cmd === "list_ollama_models_detailed") return [];
    if (cmd === "list_pending_ollama_pulls") return [];
    if (cmd === "list_orphan_partial_blobs") return [];
    if (cmd === "search_ollama_registry") {
      h.searches.push(args as SearchArgs);
      return h.answer(args as SearchArgs);
    }
    return null;
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));

import { OllamaPanel } from "../../components/layout/SettingsSubPanels";
import { __resetOllamaActivityForTests } from "../../stores/agents/ollamaActivity";

const last = () => h.searches[h.searches.length - 1];
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

const row = (name: string, community = false) => ({
  name,
  community,
  description: `${name} description`,
  capabilities: ["tools"],
  sizes: ["8b"],
  pulls: "1K",
  updated: "1 week ago",
});

beforeEach(() => {
  h.searches = [];
  h.observer = null;
  h.sentinelVisible = false;
  h.answer = ({ page }) =>
    Promise.resolve(
      page === 1
        ? { models: [row("gemma4"), row("someone/gemma4-coder", true)], hasMore: true }
        : { models: [row("someone/gemma4-tiny", true)], hasMore: false },
    );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      cb: (entries: { isIntersecting: boolean }[]) => void;
      constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
        this.cb = cb;
        h.observer = cb;
      }
      observe() {
        if (h.sentinelVisible) queueMicrotask(() => this.cb([{ isIntersecting: true }]));
      }
      disconnect() {}
      unobserve() {}
    },
  );
  __resetOllamaActivityForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  __resetOllamaActivityForTests();
});

describe("Ollama registry browser", () => {
  it("marks community uploads and loads the next page on scroll until the last", async () => {
    render(<OllamaPanel onBack={() => {}} onClose={() => {}} />);
    await flush();
    expect(h.searches).toEqual([{ query: "", capabilities: [], size: "", sort: "popular", page: 1 }]);
    expect(screen.getByText("gemma4")).toBeTruthy();
    expect(screen.getByText("someone/gemma4-coder")).toBeTruthy();
    const chips = screen.getAllByText("community");
    expect(chips).toHaveLength(1);
    expect(chips[0].getAttribute("title")).toContain("someone");

    await act(async () => h.observer!([{ isIntersecting: true }]));
    await flush();
    expect(last()).toMatchObject({ page: 2, sort: "popular" });
    expect(screen.getByText("someone/gemma4-tiny")).toBeTruthy();
    expect(screen.getByText("gemma4")).toBeTruthy();
    expect(screen.getByText("End of results")).toBeTruthy();

    // The last page reached: scrolling asks for nothing more.
    const asked = h.searches.length;
    await act(async () => h.observer?.([{ isIntersecting: true }]));
    await flush();
    expect(h.searches).toHaveLength(asked);
  });

  it("keeps loading while a short page leaves the sentinel in view", async () => {
    h.sentinelVisible = true;
    h.answer = ({ page }) =>
      Promise.resolve({ models: [row(`model-${page}`)], hasMore: page < 3 });
    render(<OllamaPanel onBack={() => {}} onClose={() => {}} />);
    for (let i = 0; i < 6; i++) await flush();
    expect(h.searches.map((s) => s.page)).toEqual([1, 2, 3]);
    expect(screen.getByText("model-3")).toBeTruthy();
  });

  it("sends the filters and the sort to ollama.com, from page 1 again", async () => {
    render(<OllamaPanel onBack={() => {}} onClose={() => {}} />);
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "vision" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Cloud" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "≤ 16 GB" }));
    await flush();
    expect(last()).toEqual({
      query: "",
      capabilities: ["vision", "cloud"],
      size: "16",
      sort: "popular",
      page: 1,
    });

    // A second click on the active Download chip clears it.
    fireEvent.click(screen.getByRole("button", { name: "≤ 16 GB" }));
    await flush();
    expect(last()).toMatchObject({ size: "", page: 1 });
  });

  it("drops an answer for a request a newer one replaced", async () => {
    let releaseFirst: (v: unknown) => void = () => {};
    h.answer = () => new Promise((r) => (releaseFirst = r));
    render(<OllamaPanel onBack={() => {}} onClose={() => {}} />);
    await flush();
    const first = releaseFirst;

    h.answer = () => Promise.resolve({ models: [row("vision-model")], hasMore: false });
    fireEvent.click(screen.getByRole("button", { name: "vision" }));
    await flush();
    expect(screen.getByText("vision-model")).toBeTruthy();

    await act(async () => first({ models: [row("stale-model")], hasMore: true }));
    await flush();
    expect(screen.queryByText("stale-model")).toBeNull();
    expect(screen.getByText("vision-model")).toBeTruthy();
  });
});
