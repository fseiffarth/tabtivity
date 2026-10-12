/**
 * The deck's TeX-figure poll re-rasters a figure's PNG with no click whenever
 * the PDF beside its `texSrc` changes. The deck JSON names both paths, and
 * anyone who can write the project can write that JSON — so the poll writes
 * only a `.png` directly in the deck's own `<deck>.tex-figures` folder
 * (decision D3, threat recheck gap 23). A hostile deck gets a notice, once, and
 * no write anywhere.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { emptyDeck, blankSlide } from "../../lib/viewers/deck/model";
import { NAMES } from "../../lib/brand";
import { translate } from "../../lib/i18n";
import { NO_FOLDER_LINK_HEADER } from "../../components/embed/fileAccess";

const files = new Map<string, string>();
const writes: string[] = [];
/** The writes that asked for the own-folder rule (`x-no-folder-link`). */
const strictWrites: string[] = [];
/** Paths `file_mtime` answers "missing" for. */
const absent = new Set<string>();
/** Paths that exist but do not read as text (non-UTF-8, over the cap). */
const unreadable = new Set<string>();
let texAvailable = false;
/** The mtime a figure PDF's `file_mtime` answers; a change is a recompile. */
let mtime = 1;

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
        if (unreadable.has(String(arg("path")))) throw new Error("stream did not contain valid UTF-8");
        const hit = files.get(String(arg("path")));
        if (hit === undefined) throw new Error("No such file or directory");
        return hit;
      }
      case "write_file_bytes":
        writes.push(decodeURIComponent(options?.headers?.[NAMES.filePathHeader] ?? ""));
        if (options?.headers?.[NO_FOLDER_LINK_HEADER] === "1") strictWrites.push(writes[writes.length - 1]);
        return null;
      case "read_file_bytes":
        if (String(arg("path")).endsWith(".pdf")) return new Uint8Array([37, 80, 68, 70]).buffer;
        throw new Error("No such file or directory");
      case "file_mtime":
        if (absent.has(String(arg("path")))) throw new Error("No such file or directory");
        // Only the figures' PDFs change; the sidecar itself stays put.
        return String(arg("path")).endsWith(".pdf") ? mtime : 1;
      case "synctex_page_lines":
        return [];
      case "tex_capability":
        return { available: texAvailable, engines: [], bibtex: false, latexmk: false };
      case "compile_tex":
        return { success: false, log: "", pdf_path: null };
      default:
        return null;
      }
    },
  ),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));

vi.mock("../../components/embed/deck/deckBase", () => ({
  loadBase: vi.fn(async () => {
    throw new Error("no plate");
  }),
  renderPage: () => () => {},
  renderPdfPageToPng: vi.fn(async () => ({ png: new Uint8Array([1, 2, 3]), width: 10, height: 10 })),
}));

const DECK_PATH = "/p/talks/talk.eldeck.json";

function figure(id: string, src: string, texSrc: string) {
  return { id, kind: "image", src, texSrc, fit: "contain", x: 0, y: 0, w: 0.2, h: 0.2, rot: 0, opacity: 1 };
}

function seedDeck(objects: unknown[]): string {
  const d = emptyDeck("talk.pdf");
  d.slides = [{ ...blankSlide(1), id: "s1", objects: objects as never }];
  return `${JSON.stringify(d, null, 2)}\n`;
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

/** Mount the deck, let the poll take its baseline, then "recompile" (a new
 *  PDF mtime) and let it run twice more. */
async function mountAndRecompile() {
  const { DeckView } = await import("../../components/embed/deck/DeckView");
  render(<DeckView path={DECK_PATH} onOpenExternally={() => {}} />);
  await settle();
  for (const next of [1, 2, 3]) {
    mtime = next;
    await act(async () => {
      vi.advanceTimersByTime(1600);
    });
    await settle();
  }
}

beforeEach(() => {
  files.clear();
  writes.length = 0;
  strictWrites.length = 0;
  absent.clear();
  unreadable.clear();
  texAvailable = false;
  mtime = 1;
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetModules();
});

describe("the deck's TeX-figure poll (gap 23, D3)", () => {
  it("re-rasters a figure that lives in the deck's own figure folder", async () => {
    files.set(DECK_PATH, seedDeck([figure("f1", "talk.tex-figures/f1.png", "talk.tex-figures/f1.tex")]));
    await mountAndRecompile();
    expect(writes).toContain("/p/talks/talk.tex-figures/f1.png");
    expect(writes.every((w) => w === "/p/talks/talk.tex-figures/f1.png")).toBe(true);
    // Every figure write asks the backend to refuse a linked figure folder
    // (gap 23 review, 0b).
    expect(strictWrites).toEqual(writes);
  });

  it("writes nothing for a deck whose figures point anywhere else, and says so once", async () => {
    files.set(
      DECK_PATH,
      seedDeck([
        figure("a", "/home/u/.config/autostart/x.png", "talk.tex-figures/a.tex"),
        figure("b", "../sibling/fig.png", "talk.tex-figures/b.tex"),
        figure("c", "talk.tex-figures/c.png", "/elsewhere/c.tex"),
        figure("d", "talk.tex-figures/d.svg", "talk.tex-figures/d.tex"),
        figure("e", "talk.tex-figures/sub/e.png", "talk.tex-figures/e.tex"),
      ]),
    );
    await mountAndRecompile();
    expect(writes).toEqual([]);
    expect(screen.getAllByText(translate("en", "deckView.figureOutside"))).toHaveLength(1);
  });
});

// The sibling data-loss bug: "Create a starter .tex" decided "no .tex yet" from
// a failed read, which also fails for a source that is not UTF-8 or over the
// read cap — and then overwrote the author's file with the starter.
describe("the deck's starter .tex (generateBase)", () => {
  const TEX = "/p/talks/talk.tex";

  async function pressCreateStarter() {
    texAvailable = true;
    files.set(DECK_PATH, `${JSON.stringify(emptyDeck("talk.pdf"), null, 2)}\n`);
    const { DeckView } = await import("../../components/embed/deck/DeckView");
    render(<DeckView path={DECK_PATH} onOpenExternally={() => {}} />);
    await settle();
    fireEvent.click(screen.getByText(translate("en", "deckView.createStarterBtn")));
    await settle();
  }

  it("never overwrites an existing .tex that does not read as text", async () => {
    unreadable.add(TEX);
    await pressCreateStarter();
    expect(writes).not.toContain(TEX);
  });

  it("still writes the starter when there is no .tex", async () => {
    absent.add(TEX);
    await pressCreateStarter();
    expect(writes).toContain(TEX);
  });
});
