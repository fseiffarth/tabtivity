/**
 * Closing a deck tab mid-talk must take the audience window with it: the
 * presenter is portaled out of `DeckView`, so the tab can be closed (or slept,
 * performance plan §5.3 — held off while presenting) under a running talk, and
 * a slide left on the projector is the failure this guards. Also covers the
 * open still in flight at unmount: the window that lands afterwards is closed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { emptyDeck, blankSlide } from "../../lib/viewers/deck/model";
import { PaneSleepHoldContext } from "../../lib/sleepWhenHidden";

const files = new Map<string, string>();
const calls: { cmd: string; args: Record<string, unknown> }[] = [];
let openGate: Promise<void> | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push({ cmd, args });
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
    case "open_presenter_window":
      if (openGate) await openGate;
      return null;
    default:
      return null;
    }
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFullscreen: () => Promise.resolve(true),
    isMaximized: () => Promise.resolve(true),
    setFullscreen: () => Promise.resolve(),
    maximize: () => Promise.resolve(),
    unmaximize: () => Promise.resolve(),
    setFocus: () => Promise.resolve(),
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
  calls.length = 0;
  openGate = null;
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
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

async function click(el: Element | null) {
  expect(el).toBeTruthy();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

async function startTalk() {
  const { DeckView } = await import("../../components/embed/deck/DeckView");
  const view = render(
    <PaneSleepHoldContext.Provider value={() => {}}>
      <DeckView path={DECK_PATH} onOpenExternally={() => {}} />
    </PaneSleepHoldContext.Provider>,
  );
  await settle();
  await click(
    [...document.querySelectorAll("button")].find((b) => b.title.startsWith("Present fullscreen")) ?? null,
  );
  expect(document.querySelector(".deck-presenter")).toBeTruthy();
  return view;
}

const closes = () => calls.filter((c) => c.cmd === "close_presenter_window");

describe("DeckPresenter audience window on unmount", () => {
  it("closes the audience window when the deck tab goes away mid-talk", async () => {
    const view = await startTalk();
    await click(document.querySelector('button[aria-label="Second display"]'));
    await settle();
    const opened = calls.find((c) => c.cmd === "open_presenter_window");
    expect(opened).toBeTruthy();
    expect(closes()).toHaveLength(0);

    view.unmount();
    await settle();
    expect(closes().map((c) => c.args.label)).toEqual([opened!.args.label]);
  });

  it("closes a window whose open was still in flight at unmount", async () => {
    let release!: () => void;
    openGate = new Promise<void>((r) => {
      release = r;
    });
    const view = await startTalk();
    await click(document.querySelector('button[aria-label="Second display"]'));
    const opened = calls.find((c) => c.cmd === "open_presenter_window");
    expect(opened).toBeTruthy();

    view.unmount();
    await settle();
    await act(async () => {
      release();
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });
    expect(closes().map((c) => c.args.label)).toEqual([opened!.args.label]);
  });
});

describe("DeckPresenter audience window after a rename mid-talk", () => {
  async function presentAt(path: string) {
    const { DeckPresenter } = await import("../../components/embed/deck/DeckPresenter");
    const d = emptyDeck("talk.pdf");
    d.slides = [{ ...blankSlide(1), id: "s1", objects: [] }];
    const props = {
      deck: d,
      doc: null,
      metrics: null,
      assets: new Map<string, string>(),
      gifs: new Map(),
      scope: null,
      onClose: () => {},
    };
    const view = render(<DeckPresenter {...props} path={path} />);
    await settle();
    await click(document.querySelector('button[aria-label="Second display"]'));
    await settle();
    const opened = calls.find((c) => c.cmd === "open_presenter_window");
    expect(opened).toBeTruthy();
    // The deck file is renamed: the presenter now carries the new path.
    view.rerender(<DeckPresenter {...props} path="/p/talks/renamed.eldeck.json" />);
    await settle();
    return { view, label: opened!.args.label };
  }

  it("the second-display toggle closes the window that was opened", async () => {
    const { label } = await presentAt(DECK_PATH);
    await click(document.querySelector('button[aria-label="Second display"]'));
    await settle();
    expect(closes().map((c) => c.args.label)).toEqual([label]);
  });

  it("D closes the window that was opened", async () => {
    const { label } = await presentAt(DECK_PATH);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "D" }));
      await Promise.resolve();
    });
    await settle();
    expect(closes().map((c) => c.args.label)).toEqual([label]);
  });
});
