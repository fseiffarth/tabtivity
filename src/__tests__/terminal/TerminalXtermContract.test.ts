/**
 * What the app relies on from the REAL `@xterm/xterm` 6 (and addon-fit), run
 * against the shipped package instead of the stand-ins the other terminal tests
 * use. Each block names the code that depends on it; a future xterm that
 * changes one of these fails here, before a pane quietly misbehaves:
 *
 *  - the bytes a keystroke becomes (`terminalControl` Shift+Tab /
 *    `altArrowWordJump`, the phone's `shiftTabKey`);
 *  - the buffer, selection and link-provider API copy, keyboard select and
 *    path links read (`terminalSelection`, `keyboardSelect`,
 *    `terminalUrls.cellAt`, `pathLinkProvider`);
 *  - the wheel path keyboard scrolling drives (`terminalScroll`);
 *  - the parser hooks (OSC 52, write-parsed) and modes the pane reads;
 *  - xterm 6's own scrollbar (the DOM our CSS styles) and the gutter
 *    FitAddon 0.11 keeps for it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn(() => Promise.resolve()) }));

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { CELL_H, CELL_W, installXtermLayout, written } from "../helpers/realXterm";
import { readAppStylesheet } from "../helpers/cssCorpus";
import {
  CSI_U_SHIFT_TAB,
  LEGACY_SHIFT_TAB,
  altArrowWordJump,
  decodeOsc52Clipboard,
  shiftTabForAgent,
} from "../../lib/terminal/terminalControl";
import { shiftTabKey } from "../../../mobile-web/src/terminal/agentModes";
import { copyableSelection } from "../../lib/terminal/terminalSelection";
import { keySelectHighlight, keySelectRange, startKeySelect } from "../../lib/terminal/keyboardSelect";
import { cellAt } from "../../lib/terminal/terminalUrls";
import { registerPathLinkProvider } from "../../lib/terminal/pathLinkProvider";
import { clearPathLinkCache } from "../../lib/terminal/pathLinks";
import { registerTerminal, unregisterTerminal } from "../../lib/terminal/terminalRegistry";
import { scrollTerminal, scrollTerminalToLive } from "../../lib/terminal/terminalScroll";
// @ts-expect-error node:fs has no type declarations in this project (no @types/node)
import { readFileSync } from "node:fs";

const COLS = 40;
const ROWS = 10;

let restoreLayout: () => void;
beforeAll(() => {
  restoreLayout = installXtermLayout();
});
afterAll(() => restoreLayout());

/** A real terminal opened into a sized host on the page. */
function openTerm(opts: { cols?: number; rows?: number; scrollback?: number } = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const term = new Terminal({ cols: opts.cols ?? COLS, rows: opts.rows ?? ROWS, scrollback: opts.scrollback ?? 1000 });
  term.open(host);
  const sent: string[] = [];
  term.onData((d) => sent.push(d));
  const textarea = host.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")!;
  const press = (init: KeyboardEventInit) =>
    textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  const screen = host.querySelector<HTMLElement>(".xterm-screen")!;
  /** A mouse event over the middle of cell (x, y), both 0-based. */
  const mouse = (type: string, x: number, y: number) =>
    screen.dispatchEvent(new MouseEvent(type, { clientX: x * CELL_W + CELL_W / 2, clientY: y * CELL_H + CELL_H / 2, bubbles: true, button: 0 }));
  return { term, host, sent, press, screen, mouse };
}

const arrow = (key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown") => ({
  key,
  code: key,
  keyCode: { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 }[key],
});

describe("keys as xterm 6 encodes them", () => {
  it("sends Shift+Tab as the legacy backtab both the desktop and the phone send", () => {
    const { press, sent } = openTerm();
    press({ key: "Tab", code: "Tab", keyCode: 9, shiftKey: true });
    expect(sent).toEqual([LEGACY_SHIFT_TAB]);
    expect(LEGACY_SHIFT_TAB).toBe("\x1b[Z");
    // What a non-Codex agent is sent from either side is what xterm itself sends.
    expect(shiftTabForAgent("claude")).toBe(sent[0]);
    expect(shiftTabKey("Claude")).toBe(sent[0]);
    expect(shiftTabKey("Codex")).toBe(CSI_U_SHIFT_TAB);
  });

  it("never switches to CSI-u itself, whatever keyboard protocol the program asks for", async () => {
    // Codex probes for the kitty keyboard protocol and modifyOtherKeys. xterm 6
    // implements neither, so its Shift+Tab stays the backtab — which is why a
    // Codex pane re-encodes it (terminalControl.shiftTabForAgent). An xterm that
    // starts answering these must make that re-encoding revisited.
    const { term, press, sent } = openTerm();
    await written(term, "\x1b[>1u\x1b[=1;1u\x1b[>4;2m");
    press({ key: "Tab", code: "Tab", keyCode: 9, shiftKey: true });
    press({ key: "Tab", code: "Tab", keyCode: 9 });
    expect(sent).toEqual([LEGACY_SHIFT_TAB, "\t"]);
    expect(sent).not.toContain(CSI_U_SHIFT_TAB);
  });

  it("sends Alt+arrow as the plain Alt form, not a word jump — what altArrowWordJump restores", () => {
    const { press, sent } = openTerm();
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"] as const) press({ ...arrow(key), altKey: true });
    expect(sent).toEqual(["\x1b[1;3D", "\x1b[1;3C", "\x1b[1;3A", "\x1b[1;3B"]);
  });

  it("sends Ctrl+arrow as exactly the word jump altArrowWordJump puts on Alt+arrow off macOS", () => {
    const { press, sent } = openTerm();
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"] as const) {
      press({ ...arrow(key), ctrlKey: true });
      expect(sent.pop()).toBe(altArrowWordJump({ key, altKey: true, ctrlKey: false, shiftKey: false, metaKey: false }, false));
    }
  });

  it("delivers `term.input` through onData, the path the word jump is sent on", () => {
    const { term, sent } = openTerm();
    term.input("\x1b[1;5D", true);
    term.input("\x1bb", true);
    expect(sent).toEqual(["\x1b[1;5D", "\x1bb"]);
  });
});

describe("buffer and selection, as copy and keyboard select read them", () => {
  it("reports a selection as an end-exclusive range of 0-based cells", async () => {
    const { term } = openTerm();
    await written(term, "alpha beta gamma");
    term.select(6, 0, 4);
    expect(term.getSelection()).toBe("beta");
    // keyboardSelect.startKeySelect relies on the end being exclusive.
    expect(term.getSelectionPosition()).toEqual({ start: { x: 6, y: 0 }, end: { x: 10, y: 0 } });
    const state = startKeySelect({ x: 0, y: 0 }, term.getSelectionPosition(), term.cols);
    expect(state.cursor).toEqual({ x: 9, y: 0 });
    // …and what it draws back with `term.select` is that same span.
    const { column, row, length } = keySelectHighlight(state, term.cols);
    term.select(column, row, length);
    expect(term.getSelection()).toBe("beta");
    expect(term.getSelectionPosition()).toEqual(keySelectRange(state, term.cols));
    term.clearSelection();
    expect(term.getSelectionPosition()).toBeUndefined();
  });

  it("places the cursor at baseY + cursorY, where keyboard select starts", async () => {
    const { term } = openTerm({ rows: 3 });
    await written(term, "one\r\ntwo\r\nthree\r\nfour\r\nfive");
    const buf = term.buffer.active;
    expect(buf.baseY).toBe(2);
    expect(buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true)).toBe("five");
    expect(buf.cursorX).toBe(4);
  });

  it("copies a soft-wrapped line whole and keeps a real line break", async () => {
    const { term } = openTerm();
    const long = "x".repeat(COLS) + "yz";
    await written(term, `${long}\r\nnext`);
    const buf = term.buffer.active;
    expect(buf.getLine(1)?.isWrapped).toBe(true);
    expect(buf.getLine(2)?.isWrapped).toBe(false);
    term.selectLines(0, 2);
    expect(copyableSelection(term, false)).toBe(`${long}\nnext`);
  });

  it("gives a wide glyph two cells — an empty one after it — so cellAt counts past it", async () => {
    const { term } = openTerm();
    await written(term, "中 src/a.ts");
    const line = term.buffer.active.getLine(0)!;
    expect(line.getCell(0)?.getChars()).toBe("中");
    expect(line.getCell(0)?.getWidth()).toBe(2);
    expect(line.getCell(1)?.getChars()).toBe("");
    expect(line.getCell(1)?.getWidth()).toBe(0);
    const text = line.translateToString(true);
    expect(text).toBe("中 src/a.ts");
    expect(cellAt(line, term.cols, text.indexOf("src"))).toBe(3);
  });
});

describe("link providers on xterm's own linkifier", () => {
  beforeEach(() => {
    clearPathLinkCache();
    invoke.mockReset();
  });

  it("asks the path provider for the hovered row and underlines the file there", async () => {
    const { term, mouse } = openTerm();
    await written(term, "中 edit src/a.ts:3 or gone.md");
    invoke.mockImplementation((cmd: string) =>
      cmd === "resolve_text_paths"
        ? Promise.resolve([{ name: "a.ts", path: "/p/src/a.ts", is_dir: false, size: 1, extension: ".ts", mime: null }, null])
        : Promise.resolve(undefined),
    );
    // Whether the pointer is on a link, as the handlers hear it. (xterm may
    // re-ask a row and replace its link, so counting calls would be brittle.)
    let on: string | null = null;
    const hover = vi.fn((_e: MouseEvent, _entry: unknown, _at: unknown, text: string) => {
      on = text;
    });
    const activate = vi.fn();
    registerPathLinkProvider(term, () => ({ bases: ["/p"], projectDir: "/p" }), { activate, hover, leave: () => (on = null) });
    // "中" covers cells 0–1, so "src" starts in cell 8 (0-based).
    mouse("mousemove", 8, 0);
    await vi.waitFor(() => expect(on).toBe("src/a.ts:3"));
    expect(invoke).toHaveBeenCalledWith("resolve_text_paths", { bases: ["/p"], candidates: ["src/a.ts", "gone.md"] });
    expect(hover).toHaveBeenLastCalledWith(expect.any(MouseEvent), expect.objectContaining({ path: "/p/src/a.ts" }), expect.objectContaining({ line: 3 }), "src/a.ts:3");
    // The cells either side of "src/a.ts:3" (7 and 18) are no link…
    mouse("mousemove", 18, 0);
    expect(on).toBeNull();
    mouse("mousemove", 7, 0);
    expect(on).toBeNull();
    // …and its last cell ("3", cell 17) is: xterm treats the range's end as
    // inclusive. A click there activates it.
    mouse("mousemove", 17, 0);
    expect(on).toBe("src/a.ts:3");
    mouse("mousedown", 17, 0);
    mouse("mouseup", 17, 0);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledWith(expect.any(MouseEvent), expect.objectContaining({ path: "/p/src/a.ts" }), expect.objectContaining({ line: 3 }));
  });
});

describe("keyboard scrolling through xterm's wheel path", () => {
  const ID = "p:scroll";
  let term: Terminal;
  let sent: string[];
  beforeEach(async () => {
    ({ term, sent } = openTerm({ rows: ROWS }));
    registerTerminal(ID, term);
    return () => {
      scrollTerminalToLive(ID);
      unregisterTerminal(ID, term);
    };
  });

  it("moves a plain terminal's own scrollback and comes back to live", async () => {
    await written(term, Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\r\n"));
    const live = term.buffer.active.baseY;
    expect(term.buffer.active.viewportY).toBe(live);
    expect(scrollTerminal(ID, -1)).toBe(true);
    expect(term.buffer.active.viewportY).toBe(live - ROWS);
    scrollTerminalToLive(ID);
    expect(term.buffer.active.viewportY).toBe(live);
    expect(sent).toEqual([]);
  });

  it("turns a scroll into wheel reports while the program tracks the mouse, and takes them back", async () => {
    await written(term, "\x1b[?1000h\x1b[?1006h");
    // Two screens of 10 rows = 20 lines = 4 notches of 5.
    expect(scrollTerminal(ID, -2)).toBe(true);
    expect(sent).toHaveLength(4);
    for (const report of sent) expect(report).toMatch(/^\x1b\[<64;\d+;\d+M$/);
    sent.length = 0;
    scrollTerminalToLive(ID);
    expect(sent).toHaveLength(4);
    for (const report of sent) expect(report).toMatch(/^\x1b\[<65;\d+;\d+M$/);
  });

  it("leaves an alternate screen that tracks nothing alone", async () => {
    await written(term, "\x1b[?1049h");
    expect(term.buffer.active.type).toBe("alternate");
    expect(scrollTerminal(ID, -1)).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe("parser hooks and modes the pane reads", () => {
  it("hands an OSC 52 clipboard write to the registered handler, decodable", async () => {
    const { term } = openTerm();
    const seen: string[] = [];
    term.parser.registerOscHandler(52, (data) => {
      seen.push(data);
      return true;
    });
    await written(term, `\x1b]52;c;${btoa("copied text")}\x07`);
    expect(seen).toHaveLength(1);
    expect(decodeOsc52Clipboard(seen[0])).toBe("copied text");
  });

  it("reports parsed writes and bracketed paste mode", async () => {
    const { term } = openTerm();
    const parsed = vi.fn();
    term.onWriteParsed(parsed);
    expect(term.modes.bracketedPasteMode).toBe(false);
    await written(term, "\x1b[?2004h");
    expect(parsed).toHaveBeenCalled();
    expect(term.modes.bracketedPasteMode).toBe(true);
  });
});

describe("xterm 6's own scrollbar, as the stylesheets and FitAddon see it", () => {
  /** Every selector in `css` that names one of xterm's classes. */
  function xtermSelectors(css: string): string[] {
    const out: string[] = [];
    for (const [, prelude] of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}@;]+)\{/g)) {
      for (const sel of splitTopLevel(prelude)) if (/\.xterm\b|\.xterm-/.test(sel)) out.push(sel.trim());
    }
    return out;
  }

  /** A selector list split on its own commas, not those inside `:is(…)`. */
  function splitTopLevel(list: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < list.length; i++) {
      if (list[i] === "(") depth++;
      else if (list[i] === ")") depth--;
      else if (list[i] === "," && depth === 0) {
        parts.push(list.slice(start, i));
        start = i + 1;
      }
    }
    parts.push(list.slice(start));
    return parts;
  }

  /** `sel` as it matches a pane at rest: state-only parts (hover, a drag's
   *  `.active`, focus) and the app's root attributes dropped. */
  function atRest(sel: string): string {
    return sel
      .replace(/:root\[[^\]]*\]\s*/g, "")
      .replace(/:(hover|focus-visible|focus)\b/g, "")
      .replace(/\.slider\.active/g, ".slider")
      .replace(/^textarea:not\((\.xterm-[\w-]+)\)$/, "textarea$1");
  }

  it("draws the slider our stylesheets style, in the 14px gutter FitAddon keeps", async () => {
    const { term, host } = openTerm({ rows: 10 });
    const bar = host.querySelector<HTMLElement>(".xterm .xterm-scrollable-element > .scrollbar.vertical");
    expect(bar).not.toBeNull();
    expect(bar!.querySelector(".slider")).not.toBeNull();
    expect(bar!.style.width).toBe("14px");
    // The scrollbar, not `.xterm-viewport`, is what moves with the scrollback.
    await written(term, Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\r\n"));
    const slider = bar!.querySelector<HTMLElement>(".slider")!;
    const atBottom = slider.style.top;
    term.scrollLines(-25);
    expect(slider.style.top).not.toBe(atBottom);
    expect(host.querySelector(".xterm-viewport")?.children).toHaveLength(0);
  });

  it("matches every xterm selector of the app's and the phone's stylesheets", () => {
    const { host } = openTerm();
    // The phone mounts its terminal inside a `.terminal` box.
    const phone = document.createElement("div");
    phone.className = "terminal";
    phone.appendChild(host);
    document.body.appendChild(phone);
    const selectors = [
      ...xtermSelectors(readAppStylesheet()),
      ...xtermSelectors(readFileSync("mobile-web/src/style.css", "utf8") as string),
    ];
    expect(selectors.some((s) => s.includes(".xterm-scrollable-element"))).toBe(true);
    const missing = selectors.filter((sel) => !document.querySelector(atRest(sel)));
    expect(missing).toEqual([]);
  });

  it("fits the pane less the 14px gutter, and all of it without scrollback", () => {
    for (const [scrollback, gutter] of [[1000, 14], [0, 0]]) {
      const parent = document.createElement("div");
      parent.style.width = "805px";
      parent.style.height = "430px";
      document.body.appendChild(parent);
      const term = new Terminal({ cols: 20, rows: 5, scrollback });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(parent);
      expect(fit.proposeDimensions()).toEqual({ cols: Math.floor((805 - gutter) / CELL_W), rows: Math.floor(430 / CELL_H) });
      fit.fit();
      expect([term.cols, term.rows]).toEqual([Math.floor((805 - gutter) / CELL_W), Math.floor(430 / CELL_H)]);
    }
  });
});
