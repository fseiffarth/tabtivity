/**
 * The question an agent is waiting on, in Focus.
 *
 * The stored session cannot carry a choice the agent has not been given yet,
 * so Focus shows the live screen under it. It used to show it as *text* — the
 * dialog's rows as the TUI drew them, answerable only by walking a highlight
 * with the arrow keys, which the phone has no room for. The rows are now a
 * list: numbered as the dialog numbered them, and a tap sends the same keys.
 *
 * The screen below is the one claude-code paints for a permission prompt.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const terminalState = vi.hoisted(() => ({ lines: [] as string[], type: "normal" as "normal" | "alternate" }));

/** Marks a row a TUI painted on a card of its own — Codex draws its question
 * on a near-white one, bold and dark inside. The buffer then offers cells, the
 * way xterm does, and `readableScreen` reads the colours off them. */
const CARD = "\u0001";
/** The same colours, as the DOM reports them back. */
const CARD_BG = "rgb(244, 244, 244)";
const CARD_FG = "rgb(36, 41, 47)";

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    modes = { bracketedPasteMode: false };
    textarea = document.createElement("textarea");
    buffer = {
      active: {
        get type() { return terminalState.type; },
        get length() { return terminalState.lines.length; },
        getLine(row: number) {
          const value = terminalState.lines[row];
          if (value == null) return undefined;
          if (!value.startsWith("\u0001")) return { isWrapped: false, translateToString: () => value };
          const text = value.slice(1);
          const cell = (char: string) => ({
            getChars: () => char,
            getWidth: () => 1,
            isBold: () => 1,
            isItalic: () => 0,
            isDim: () => 0,
            isUnderline: () => 0,
            isStrikethrough: () => 0,
            isInverse: () => 0,
            isInvisible: () => 0,
            isFgDefault: () => false,
            isBgDefault: () => false,
            isFgPalette: () => false,
            isBgPalette: () => false,
            isFgRGB: () => true,
            isBgRGB: () => true,
            getFgColor: () => 0x24292f,
            getBgColor: () => 0xf4f4f4,
          });
          return {
            isWrapped: false,
            length: text.length,
            translateToString: () => text,
            getCell: (x: number) => (x < text.length ? cell(text[x]) : undefined),
          };
        },
      },
    };
    loadAddon() {}
    open() {}
    write(value: Uint8Array | string, callback?: () => void) {
      if (typeof value !== "string") terminalState.lines = new TextDecoder().decode(value).split("\n");
      callback?.();
    }
    onData() { return { dispose() {} }; }
    scrollLines() {}
    focus() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  static sent: string[] = [];
  readyState = FakeWebSocket.OPEN;
  binaryType = "";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor() {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  /** Keystrokes go out as bytes; the control frames (resize, attach) are JSON
   * strings and are not what this test reads. */
  send(data: unknown) {
    if (ArrayBuffer.isView(data)) FakeWebSocket.sent.push(new TextDecoder().decode(data as Uint8Array));
  }
  close() { this.readyState = 3; }
}

import { Terminal } from "../../../mobile-web/src/screens/Terminal";
import { BRAND } from "../../lib/brand";

const ESC = String.fromCharCode(27);
const DOWN = `${ESC}[B`;

const TAB = { id: "tab-q", label: "Claude", kind: "agent" as const, agent_label: "Claude Code", available: true, viewer_busy: false };

const STORED = {
  available: true,
  version: "1200:1",
  truncated: false,
  entries: [{ kind: "answer", text: "I'll add the clear button." }],
};

/** The permission prompt, as the reading view has it once the box frame is
 * stripped: the session it was drawn onto, what is asked, then the rows that
 * answer it. The banner stands for everything the dialog is *not* about — a
 * session that has not been prompted yet put its whole startup header here. */
const BANNER = [
  "> Claude Code v2.1.278",
  `  cwd: ~/${BRAND.slug}/projects/project${BRAND.slug}`,
  "",
  "Tip: run /doctor to check your setup",
];
const QUESTION = [
  ...BANNER,
  "",
  "Edit file",
  "  src/lib/i18n.ts",
  "",
  "Do you want to make this edit to i18n.ts?",
  "❯ 1. Yes",
  "  2. Yes, allow all edits during this session",
  "  3. No, and tell Claude what to do differently",
  "",
  "  esc to cancel",
].join("\n");

/** An agent's own question (`AskUserQuestion`): its message, the tab row
 * naming the question, the question — both wrapped by Claude Code itself at
 * the pane's width — and the options, each with its note, then the two rows
 * Claude Code adds to every such question. */
const AGENT_QUESTION = [
  "● My fix is ready and verified, but pushing develop now would also push four",
  "  other commits. I need your call before pushing.",
  "",
  "☐ Push scope",
  "",
  "Four other-session commits sit unpushed on develop. How should I land my",
  "Windows/CodeQL fix?",
  "",
  "❯ 1. Fix only (Recommended)",
  "     Put my fix directly on the pushed main.",
  "  2. Push everything",
  "     Push develop with all four commits.",
  "  3. Type something.",
  "  4. Chat about this",
  "",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
].join("\n");

const CODEX_TAB = { ...TAB, id: "tab-codex", label: "Codex", agent_label: "Codex" };

/** codex 0.155.1, captured off a live pane: the startup banner, the line that
 * says why it is asking, then the question — which Codex paints on its own
 * light card (`CARD`) — and the rows. */
const CODEX_QUESTION = [
  ">_ OpenAI Codex (v0.155.1)",
  "model:     gpt-6-astra high   /model to change",
  `directory: ~/${BRAND.slug}/projects/project${BRAND.slug}`,
  "",
  "⚠ clamping SessionEnd hook timeout to 3s in /home/user/.codex/config.toml",
  "",
  // Carries the card too, though Codex draws this line plain: it is what says
  // the palette is dropped for the question alone, not for the screen.
  `${CARD}• Automatically switched to Luna Reserve high due to usage limits.`,
  "",
  `${CARD}  You’re now using Luna, a faster model for simpler tasks.`,
  `${CARD}  Add credits or upgrade to continue using the most advanced models.`,
  "",
  "› 1. Upgrade",
  "  2. Add Credits",
  "  3. Continue with Luna Reserve",
  "",
  "  Press enter to confirm or esc to continue working",
].join("\n");

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const sidecarFetch = () => vi.fn((url: string) => {
  if (url.endsWith("/outbox")) return Promise.resolve(jsonResponse(200, { files: [] }));
  if (url.includes("/transcript")) return Promise.resolve(jsonResponse(200, { transcript: STORED }));
  return Promise.resolve(jsonResponse(404, { error: "not_found" }));
});

const paint = async (text: string) => {
  const bytes = new TextEncoder().encode(text);
  const payload = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(payload).set(bytes);
  act(() => FakeWebSocket.instances[0].onmessage?.({ data: payload } as MessageEvent));
  await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 200)); });
};

const settle = async (ms: number) => {
  await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, ms)); });
};

const question = () => screen.getByRole("group", { name: "Waiting for your answer" });
const rows = () => Array.from(question().querySelectorAll(".option-list button"), (row) => row.textContent ?? "");

describe(`${BRAND.display} Mobile Focus — the question an agent is waiting on`, () => {
  beforeEach(() => {
    terminalState.lines = [];
    terminalState.type = "normal";
    FakeWebSocket.instances = [];
    FakeWebSocket.sent = [];
    localStorage.clear();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("fetch", sidecarFetch());
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("lists the dialog's rows by their own numbers, and answers the one tapped", async () => {
    render(<Terminal tab={TAB} back={() => {}} />);
    await act(async () => {});
    screen.getByTestId("session-transcript");

    await paint(QUESTION);
    // What the rows answer is still shown — the question, and the block above
    // it that says what the answer applies to…
    within(question()).getByText(/Do you want to make this edit/);
    within(question()).getByText(/src\/lib\/i18n.ts/);
    // …but not the session above that: the conversation is already the view
    // behind this block, and a startup banner is not a question.
    expect(within(question()).queryByText(/Claude Code v2/)).toBeNull();
    expect(within(question()).queryByText(/run \/doctor/)).toBeNull();
    // …and the rows themselves are a list, in the dialog's own order.
    expect(rows()).toHaveLength(3);
    expect(rows()[0]).toContain("Yes");
    expect(rows()[2]).toContain("No, and tell Claude what to do differently");
    // Not twice: the rows are the list, not the list and the text behind it.
    expect(within(question()).queryByText(/2\. Yes, allow all edits/)).toBeNull();

    FakeWebSocket.sent = [];
    fireEvent.click(within(question()).getByText("Yes, allow all edits during this session"));
    // One row down from the highlight, then Enter — the arrow row's own keys.
    await settle(400);
    expect(FakeWebSocket.sent).toEqual([DOWN, "\r"]);

    // The same row cannot be sent twice while the session catches up.
    FakeWebSocket.sent = [];
    fireEvent.click(within(question()).getByText("No, and tell Claude what to do differently"));
    await settle(400);
    expect(FakeWebSocket.sent).toEqual([]);
  });

  it("reads the question off a fullscreen agent's own frame", async () => {
    // Claude Code under `"tui": "fullscreen"` draws its whole session on the
    // alternate screen. There is no scrollback there for the reading view to
    // grow from — Focus reads the stored session instead — but the choice the
    // agent is waiting on is on that frame and nowhere else, so the frame is
    // read for it.
    terminalState.type = "alternate";
    render(<Terminal tab={TAB} back={() => {}} />);
    await act(async () => {});
    await paint(QUESTION);

    within(question()).getByText(/Do you want to make this edit/);
    expect(rows()).toHaveLength(3);
    FakeWebSocket.sent = [];
    fireEvent.click(within(question()).getByText("Yes, allow all edits during this session"));
    await settle(400);
    expect(FakeWebSocket.sent).toEqual([DOWN, "\r"]);
  });

  it("shows a Codex question in the reading view's own type, without its card", async () => {
    render(<Terminal tab={CODEX_TAB} back={() => {}} />);
    await act(async () => {});
    await paint(CODEX_QUESTION);

    const ask = question().querySelector(".question-ask")!;
    expect(ask.textContent).toContain("You’re now using Luna");
    expect(ask.textContent).toContain("Add credits or upgrade");
    // The dialog's rows are the list, and the line that says why it is asking
    // is context; the banner above it is neither.
    expect(within(question()).getByText(/Automatically switched to Luna Reserve/)).toBeTruthy();
    expect(within(question()).queryByText(/OpenAI Codex \(v0/)).toBeNull();
    expect(rows()).toEqual(["Upgrade", "Add Credits", "Continue with Luna Reserve"]);
    // Codex paints that question on a near-white card. Dropped into this dark
    // view it was a white slab: the emphasis survives, the palette does not.
    const painted = Array.from(ask.querySelectorAll("span"));
    expect(painted.length).toBeGreaterThan(0);
    for (const span of painted) {
      expect(span.style.background).toBe("");
      expect(span.style.color).toBe("");
      expect(span.className).toContain("b");
    }
    // …while the screen around it still reads as the session painted it.
    const context = within(question()).getByText(/Automatically switched to Luna Reserve/);
    expect(context.style.background).toBe(CARD_BG);
    expect(context.style.color).toBe(CARD_FG);
  });

  it("shows an agent's own question as prose, its header as a title, its rows as a sheet's", async () => {
    render(<Terminal tab={TAB} back={() => {}} />);
    await act(async () => {});
    await paint(AGENT_QUESTION);

    // The tab row is the question's title, not a line of the agent's message.
    expect(question().querySelector(".question-tabs")?.textContent).toBe("Push scope");
    expect(within(question()).queryByText(/☐/)).toBeNull();
    // The question and the message above it read as paragraphs, not as the
    // pane's width in hard breaks.
    const ask = Array.from(question().querySelectorAll(".question-ask .readable-line"), (line) => line.textContent);
    expect(ask).toEqual(["Four other-session commits sit unpushed on develop. How should I land my Windows/CodeQL fix?"]);
    const message = Array.from(question().querySelectorAll(".readable-turn .readable-line"), (line) => line.textContent ?? "");
    expect(message.filter((line) => line.includes("would also push four other commits."))).toHaveLength(1);
    // The recommendation is a tag beside the label, the notes are notes.
    const first = question().querySelectorAll(".option-list button")[0];
    expect(first.querySelector("strong")?.firstChild?.textContent).toBe("Fix only");
    expect(first.querySelector(".question-recommended")?.textContent).toBe("Recommended");
    expect(first.querySelector("small")?.textContent).toBe("Put my fix directly on the pushed main.");
    // The rows are the model sheet's: label and note, no number beside them.
    expect(rows()).toEqual([
      "Fix onlyRecommendedPut my fix directly on the pushed main.",
      "Push everythingPush develop with all four commits.",
      "Type something.",
      "Chat about this",
    ]);
  });

  it("answers the free-text row with words typed under it, not a bare Enter", async () => {
    render(<Terminal tab={TAB} back={() => {}} />);
    await act(async () => {});
    await paint(AGENT_QUESTION);

    FakeWebSocket.sent = [];
    // A tap opens the row's field instead of pressing Enter on an empty one.
    fireEvent.click(within(question()).getByText("Type something."));
    await settle(400);
    expect(FakeWebSocket.sent).toEqual([]);
    const field = within(question()).getByRole("textbox", { name: "Your answer…" });
    // Nothing to send yet.
    expect(within(question()).getByRole("button", { name: "Send" })).toHaveProperty("disabled", true);
    fireEvent.change(field, { target: { value: "  Push only   my fix " } });
    fireEvent.click(within(question()).getByRole("button", { name: "Send" }));
    await settle(600);
    // Two rows down onto the field, the words as one line, then Enter.
    expect(FakeWebSocket.sent).toEqual([DOWN, DOWN, "Push only my fix", "\r"]);
  });

  it("gives the list back when the answer never lands", async () => {
    render(<Terminal tab={TAB} back={() => {}} />);
    await act(async () => {});
    await paint(QUESTION);

    fireEvent.click(within(question()).getByText("Yes"));
    await settle(400);
    FakeWebSocket.sent = [];
    // The session never moved off the question: rather than leave a block that
    // can no longer be answered, the rows go live again.
    await settle(6_500);
    fireEvent.click(within(question()).getByText("Yes"));
    await settle(400);
    expect(FakeWebSocket.sent).toEqual(["\r"]);
  });
});
