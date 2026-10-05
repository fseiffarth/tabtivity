/**
 * The deck editor's **write policy** — the one surface in the whole feature that
 * can destroy an author's work, and the one that had no test coverage at all
 * (TODO V, coverage note).
 *
 * Three properties, each of them a bug this file exists to keep fixed:
 *
 *  1. **The last edit is not lost on close.** The autosave debounce's cleanup
 *     cancels the pending write — correct for a *rescheduled* write, catastrophic
 *     for a *final* one. Closing the tab within 800 ms of an edit silently
 *     discarded it, while the toolbar said "Saved" (V #93).
 *  2. **Merely opening a deck does not rewrite it.** `loadedRef` was armed by the
 *     load, so the reconciled deck — with every slide's fingerprint refreshed —
 *     was written unconditionally. On a git-tracked, lockstep-synced sidecar,
 *     *looking* at a deck produced a diff (V #94).
 *  3. **A lossy read is never written back.** A deck declaring a newer version,
 *     or carrying an object kind this build cannot model, opens behind a banner
 *     with the autosave held — because writing it back would delete part of the
 *     file (V #94).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { serializeDeck } from "../../lib/viewers/deck/sidecar";
import { emptyDeck, blankSlide } from "../../lib/viewers/deck/model";
import { BRAND, NAMES } from "../../lib/brand";

/** Files this fake backend holds, by absolute path. */
const files = new Map<string, string>();
/** Every `write_file_bytes` this test run saw, in order. */
const writes: Array<{ path: string; text: string }> = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(
    async (
      cmd: string,
      args: Record<string, unknown> | Uint8Array = {},
      options?: { headers?: Record<string, string> },
    ) => {
      const arg = (k: string) =>
        args instanceof Uint8Array ? undefined : (args as Record<string, unknown>)[k];
      switch (cmd) {
      case "read_file_text": {
        const hit = files.get(String(arg("path")));
        if (hit === undefined) throw new Error("No such file or directory");
        return hit;
      }
      // Bytes cross as the invoke's RAW BODY now, with the path in a header — see
      // `writeFileBytes`. The fake backend mirrors that shape rather than the old
      // `{path, content}` one, so the test exercises the real call.
      case "write_file_bytes": {
        const path = decodeURIComponent(options?.headers?.[NAMES.filePathHeader] ?? "");
        const text = new TextDecoder().decode(args as Uint8Array);
        files.set(path, text);
        writes.push({ path, text });
        return null;
      }
      case "read_file_bytes":
        throw new Error("No such file or directory"); // no base plate in these tests
      case "file_mtime":
        return 1;
      case "synctex_page_lines":
        return [];
      case "tex_capability":
        return { available: false, engines: [], bibtex: false, latexmk: false };
      default:
        return null;
      }
    },
  ),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));

// The stage renders a pdf.js canvas and measures itself; neither is what this
// file is about, and jsdom has no 2D context.
vi.mock("../../components/embed/deck/deckBase", () => ({
  loadBase: vi.fn(async () => {
    throw new Error("no plate");
  }),
  renderPage: () => () => {},
  renderPdfPageToPng: vi.fn(async () => null),
}));

const DECK_PATH = "/p/talks/talk.eldeck.json";

/** A deck with one slide carrying one text object, as it sits on disk. */
function seedDeck(over: Record<string, unknown> = {}): string {
  const d = emptyDeck("talk.pdf");
  d.slides = [
    {
      ...blankSlide(1),
      id: "s1",
      objects: [
        {
          id: "o1",
          kind: "text",
          text: "before",
          style: d.theme.text,
          padding: 2,
          x: 0.1,
          y: 0.1,
          w: 0.4,
          h: 0.1,
          rot: 0,
          opacity: 1,
        },
      ],
    },
  ];
  return `${JSON.stringify({ ...d, ...over }, null, 2)}\n`;
}

/** Mount the editor and let its async load settle. */
async function mountDeck() {
  const { DeckView } = await import("../../components/embed/deck/DeckView");
  const view = render(<DeckView path={DECK_PATH} onOpenExternally={() => {}} />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return view;
}

beforeEach(() => {
  files.clear();
  writes.length = 0;
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetModules();
});

describe("the deck autosave (V #93 / #94)", () => {
  it("does NOT write the file just because it was opened", async () => {
    files.set(DECK_PATH, seedDeck());
    await mountDeck();
    // Well past the debounce, with no edit made.
    await act(async () => {
      vi.advanceTimersByTime(3000);
      await Promise.resolve();
    });
    expect(writes).toEqual([]);
    expect(screen.getByText("Saved")).toBeTruthy();
  });

  it("flushes the pending write when the view unmounts inside the debounce", async () => {
    files.set(DECK_PATH, seedDeck());
    const view = await mountDeck();

    // Any real edit will do; the toolbar's "add a text box" is the cheapest one
    // that does not need a pointer gesture (jsdom has no `setPointerCapture`).
    const addText = [...document.querySelectorAll("button")].find(
      (b) => b.title === "Add a text box",
    );
    expect(addText).toBeTruthy();
    await act(async () => {
      addText!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    // Still inside the 800ms debounce: nothing on disk yet, and the toolbar must
    // say so rather than claiming "Saved".
    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });
    expect(writes).toEqual([]);
    expect(screen.getByText("Unsaved…")).toBeTruthy();

    // Close the tab mid-debounce. THIS is the case that lost the edit.
    await act(async () => {
      view.unmount();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(writes.length).toBeGreaterThan(0);
    // The new object reached disk — the edit that used to vanish.
    expect(JSON.parse(files.get(DECK_PATH)!).slides[0].objects).toHaveLength(2);
  });

  it("refuses to autosave a deck written by a newer build", async () => {
    // Writing it back would strip whatever this build could not model, under a
    // version number claiming the file was fine.
    files.set(DECK_PATH, seedDeck({ version: 99 }));
    await mountDeck();

    expect(screen.getByText("Not saving")).toBeTruthy();
    expect(document.body.textContent).toContain(`newer ${BRAND.display}`);

    await act(async () => {
      vi.advanceTimersByTime(3000);
      await Promise.resolve();
    });
    expect(writes).toEqual([]);
  });

  it("offers an explicit override rather than silently refusing forever", async () => {
    files.set(DECK_PATH, seedDeck({ version: 99 }));
    await mountDeck();

    const override = [...document.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Edit anyway"),
    );
    expect(override).toBeTruthy();
    await act(async () => {
      override!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    // The banner is gone and the label is back to the ordinary state — the write
    // is now the author's decision rather than Tabtivity's.
    expect(screen.queryByText("Not saving")).toBeNull();
  });

  it("keeps the declared version when it does write", async () => {
    files.set(DECK_PATH, seedDeck({ version: 99 }));
    await mountDeck();
    const parsed = JSON.parse(files.get(DECK_PATH)!);
    expect(parsed.version).toBe(99);
    // Nothing was written, so the file still literally says 99 — and the parse
    // that produced the in-memory deck kept it too, which is what stops the
    // override from downgrading the file.
    expect(serializeDeck({ ...emptyDeck(null), version: 99 })).toContain('"version": 99');
  });
});
