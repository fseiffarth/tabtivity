/**
 * Sleeping tabs (performance plan §5.3): a deck tab sleeps when hidden long
 * enough, and sleeping unmounts `DeckView`. The presenter is portaled out of
 * the view (and may drive an audience window), so the tab can be hidden under
 * a running talk: presenting must hold the pane awake until the talk ends.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { emptyDeck, blankSlide } from "../../lib/viewers/deck/model";
import { PaneSleepHoldContext } from "../../lib/sleepWhenHidden";

const files = new Map<string, string>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    switch (cmd) {
    case "read_file_text": {
      const hit = files.get(String(args.path));
      if (hit === undefined) throw new Error("No such file or directory");
      return hit;
    }
    case "read_file_bytes":
      throw new Error("No such file or directory");
    case "file_mtime":
      return 1;
    case "synctex_page_lines":
      return [];
    case "tex_capability":
      return { available: false, engines: [], bibtex: false, latexmk: false };
    default:
      return null;
    }
  }),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFullscreen: () => Promise.resolve(true),
    isMaximized: () => Promise.resolve(true),
    setFullscreen: () => Promise.resolve(),
    maximize: () => Promise.resolve(),
    unmaximize: () => Promise.resolve(),
  }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));

vi.mock("../../components/embed/deck/deckBase", () => ({
  loadBase: vi.fn(async () => {
    throw new Error("no plate");
  }),
  renderPage: () => () => {},
  renderPdfPageToPng: vi.fn(async () => null),
}));

const DECK_PATH = "/p/talks/talk.eldeck.json";

beforeEach(() => {
  files.clear();
  // The presenter portals into the app's `#root`.
  if (!document.getElementById("root")) {
    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
  }
  const d = emptyDeck("talk.pdf");
  d.slides = [{ ...blankSlide(1), id: "s1", objects: [] }];
  files.set(DECK_PATH, `${JSON.stringify(d, null, 2)}\n`);
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetModules();
});

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("DeckView sleep hold", () => {
  it("holds the pane while presenting and releases it when the talk ends", async () => {
    const held = new Set<object>();
    const report = (token: object, on: boolean) => {
      if (on) held.add(token);
      else held.delete(token);
    };
    const { DeckView } = await import("../../components/embed/deck/DeckView");
    render(
      <PaneSleepHoldContext.Provider value={report}>
        <DeckView path={DECK_PATH} onOpenExternally={() => {}} />
      </PaneSleepHoldContext.Provider>,
    );
    await settle();
    expect(held.size).toBe(0);

    const present = [...document.querySelectorAll("button")].find((b) =>
      b.title.startsWith("Present fullscreen"),
    );
    expect(present).toBeTruthy();
    await act(async () => {
      present!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(held.size).toBe(1);
    expect(document.querySelector(".deck-presenter")).toBeTruthy();

    const exit = document.querySelector<HTMLButtonElement>('button[aria-label="Exit"]');
    expect(exit).toBeTruthy();
    await act(async () => {
      exit!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(document.querySelector(".deck-presenter")).toBeNull();
    expect(held.size).toBe(0);
  });
});
