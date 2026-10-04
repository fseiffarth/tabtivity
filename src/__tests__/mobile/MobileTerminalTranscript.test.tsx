import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const terminalState = vi.hoisted(() => ({ lines: [] as string[], alternate: false }));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    modes = { bracketedPasteMode: false };
    textarea = document.createElement("textarea");
    buffer = {
      active: {
        get type() { return terminalState.alternate ? "alternate" : "normal"; },
        get length() { return terminalState.lines.length; },
        getLine(row: number) {
          const value = terminalState.lines[row];
          return value == null ? undefined : { isWrapped: false, translateToString: () => value };
        },
      },
    };
    loadAddon() {}
    open() {}
    write(value: Uint8Array | string, callback?: () => void) {
      // A reconnect notice arrives as a string; session bytes as an array.
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
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  binaryType = "";
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor() {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(value: unknown) { this.sent.push(typeof value === "string" ? value : "<bytes>"); }
  close() { this.readyState = FakeWebSocket.CLOSED; this.onclose?.(); }
}

import { Terminal } from "../../../mobile-web/src/screens/Terminal";
import { BRAND, storageKey } from "../../lib/brand";

/** A bubble's words, without the time a messenger puts in its corner. */
function said(bubble: Element | null | undefined): string | null {
  if (!bubble) return null;
  const copy = bubble.cloneNode(true) as Element;
  copy.querySelectorAll(".transcript-time").forEach((time) => time.remove());
  return copy.textContent;
}


const TAB = { id: "tab-7", label: "Claude", kind: "agent" as const, agent_label: "Claude Code", available: true, viewer_busy: false };

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const settle = () => act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });

/** A fetch answering the outbox (empty) and the transcript with whatever
 * `transcript` holds at the time of the call. */
function sidecarFetch(transcript: () => unknown) {
  return vi.fn((url: string) => {
    if (url.endsWith("/outbox")) return Promise.resolve(jsonResponse(200, { files: [] }));
    if (url.includes("/transcript")) return Promise.resolve(jsonResponse(200, { transcript: transcript() }));
    return Promise.resolve(jsonResponse(404, { error: "not_found" }));
  });
}

const STORED = {
  available: true,
  version: "1200:1",
  truncated: false,
  entries: [
    { kind: "prompt", text: "add a clear button", at: "2026-09-15T05:49:39.013Z" },
    { kind: "answer", text: "Looking at the composer." },
    { kind: "answer", text: "Done: the **✕** empties the draft. See [the docs](https://example.com)." },
  ],
};

describe(`${BRAND.display} Mobile Focus reads the stored session`, () => {
  beforeEach(() => {
    terminalState.lines = [];
    terminalState.alternate = false;
    FakeWebSocket.instances = [];
    localStorage.clear();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("opens an agent tab on its stored session, and remembers Terminal for the agent once chosen", async () => {
    vi.stubGlobal("fetch", sidecarFetch(() => STORED));
    const { unmount } = render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    expect(screen.getByRole("button", { name: "Chat" }).getAttribute("aria-pressed")).toBe("true");
    screen.getByTestId("session-transcript");
    // The default is not written down as the reader's choice.
    expect(localStorage.getItem(storageKey("mobile.view.claude-code"))).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    await settle();
    expect(localStorage.getItem(storageKey("mobile.view.claude-code"))).toBe("terminal");
    unmount();

    // Another Claude tab opens where this one was left.
    render(<Terminal tab={{ ...TAB, id: "tab-8" }} back={() => {}} />);
    await settle();
    expect(screen.getByRole("button", { name: "Terminal" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByTestId("session-transcript")).toBeNull();
  });

  it("opens on Terminal when no stored session reads and Focus was never chosen", async () => {
    vi.stubGlobal("fetch", sidecarFetch(() => ({ available: false, reason: "unsupported", entries: [], truncated: false })));
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    expect(screen.getByRole("button", { name: "Terminal" }).getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem(storageKey("mobile.view.claude-code"))).toBeNull();
  });

  it("stays in the Reader for a tab with no session id yet, and paints the session once it reads", async () => {
    // A tab the phone just created: the bridge answers `no_session` until the
    // agent's hook records one. The Reader reads the screen meanwhile and
    // never hands over to Terminal — nothing would bring it back.
    let stored: unknown = { available: false, reason: "no_session", entries: [], truncated: false };
    vi.stubGlobal("fetch", sidecarFetch(() => stored));
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    expect(screen.getByRole("button", { name: "Chat" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByTestId("session-transcript")).toBeNull();
    expect(localStorage.getItem(storageKey("mobile.view.claude-code"))).toBeNull();

    stored = STORED;
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await settle();
    expect(screen.getByRole("button", { name: "Chat" }).getAttribute("aria-pressed")).toBe("true");
    screen.getByTestId("session-transcript");
  });

  it("shows a fresh tab's chat loading while its CLI starts, never the CLI's banner", async () => {
    let stored: unknown = { available: false, reason: "no_transcript", entries: [], truncated: false };
    vi.stubGlobal("fetch", sidecarFetch(() => stored));
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    const paint = async (text: string) => {
      const bytes = new TextEncoder().encode(text);
      const payload = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(payload).set(bytes);
      act(() => { FakeWebSocket.instances[0].onmessage?.({ data: payload } as MessageEvent); });
      await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 200)); });
    };
    // Before anything is drawn, and while the banner is all there is.
    expect(screen.getByTestId("session-starting").textContent).toContain("Starting Claude Code…");
    await paint("╭──────────────────────────╮\r\n│ ✻ Welcome to the agent!  │\r\n╰──────────────────────────╯\r\n");
    expect(screen.getByTestId("session-starting")).toBeTruthy();
    expect(screen.queryByText(/Welcome to the agent/)).toBeNull();

    // Its input box drawn, the CLI waits for a first prompt: the empty chat.
    await paint("\r\n────────────────────────────\r\n> \r\n────────────────────────────\r\n  ? for shortcuts\r\n");
    expect(screen.queryByTestId("session-starting")).toBeNull();
    expect(screen.getByText("No turns yet")).toBeTruthy();
    expect(screen.queryByText(/Welcome to the agent/)).toBeNull();

    // A recorded session takes over as ever.
    stored = STORED;
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await settle();
    screen.getByTestId("session-transcript");
  });

  it("puts the starting screen one tap away", async () => {
    vi.stubGlobal("fetch", sidecarFetch(() => ({ available: false, reason: "no_session", entries: [], truncated: false })));
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    const bytes = new TextEncoder().encode("Error: could not reach the model\r\n");
    const payload = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(payload).set(bytes);
    act(() => { FakeWebSocket.instances[0].onmessage?.({ data: payload } as MessageEvent); });
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 200)); });
    expect(screen.queryByText(/could not reach the model/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show the screen" }));
    expect(screen.queryByTestId("session-starting")).toBeNull();
    expect(screen.getByText(/could not reach the model/)).toBeTruthy();
  });

  it("keeps the chat while the composer has focus, even when a read answers the session unavailable", async () => {
    // Under full load the desktop misses the transcript call's deadline and
    // the host answers from the tab record — the chat dropped to the screen
    // (or handed over to Terminal) under the reader's thumbs.
    let stored: unknown = STORED;
    const fetchMock = sidecarFetch(() => stored);
    vi.stubGlobal("fetch", fetchMock);
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    screen.getByTestId("session-transcript");
    const composer = screen.getByRole("textbox", { name: "Message agent" });
    act(() => { composer.focus(); });
    fireEvent.change(composer, { target: { value: "half a" } });

    stored = { available: false, reason: "unsupported", entries: [], truncated: false };
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await settle();
    expect(screen.getByRole("button", { name: "Chat" }).getAttribute("aria-pressed")).toBe("true");
    screen.getByTestId("session-transcript");
    expect(composer).toBe(document.activeElement);

    // Letting go reads the session afresh, and that answer stands.
    const reads = () => fetchMock.mock.calls.filter(([url]) => (url as string).includes("/transcript")).length;
    const before = reads();
    act(() => { composer.blur(); });
    await settle();
    expect(reads()).toBe(before + 1);
    expect(screen.getByRole("button", { name: "Terminal" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByTestId("session-transcript")).toBeNull();
  });

  it("opens a shell tab on Terminal", async () => {
    vi.stubGlobal("fetch", sidecarFetch(() => STORED));
    render(<Terminal tab={{ ...TAB, id: "tab-9", kind: "shell", agent_label: undefined }} back={() => {}} />);
    await settle();
    expect(screen.getByRole("button", { name: "Terminal" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("lays the stored prompts and answers out as a chat and polls with the last version", async () => {
    localStorage.setItem(storageKey("mobile.view.claude-code"), "focus");
    const fetchMock = sidecarFetch(() => STORED);
    vi.stubGlobal("fetch", fetchMock);
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();

    const calls = fetchMock.mock.calls.map(([url]) => url as string);
    expect(calls.find((url) => url.includes("/transcript"))).toBe("/api/v1/tabs/tab-7/transcript?limit=120");
    const chat = screen.getByTestId("session-transcript");
    const prompt = screen.getByRole("group", { name: "Your prompt" });
    expect(said(prompt)).toBe("add a clear button");
    expect(prompt.className).toBe("readable-turn user");
    // One bubble per message the agent wrote, its Markdown formatted, its
    // link only a label.
    const answers = chat.querySelectorAll(".readable-turn.agent.answer");
    expect([...answers].map((bubble) => said(bubble))).toEqual(["Looking at the composer.", "Done: the ✕ empties the draft. See the docs."]);
    expect(answers[1].querySelector("strong")?.textContent).toBe("✕");
    expect(chat.querySelector("a")).toBeNull();
    // The next read names the version it holds, so an unmoved file answers small.
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await settle();
    const again = fetchMock.mock.calls.map(([url]) => url as string).filter((url) => url.includes("/transcript"));
    expect(again[again.length - 1]).toBe("/api/v1/tabs/tab-7/transcript?version=1200%3A1&limit=120");

    // A click-hold on a message opens its menu, and the menu copies that one
    // message as the agent wrote it; there is no copy-everything button over
    // the chat, and none on the bubbles either.
    expect(screen.queryByRole("button", { name: "Copy the session text" })).toBeNull();
    fireEvent.contextMenu(answers[1] as HTMLElement);
    const sheet = () => within(screen.getByRole("dialog", { name: "Message" }));
    fireEvent.click(sheet().getByRole("button", { name: "Copy message" }));
    await settle();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("Done: the **✕** empties the draft. See [the docs](https://example.com).");
    sheet().getByText("Copied");
    fireEvent.click(sheet().getByRole("button", { name: "Close" }));
    fireEvent.contextMenu(prompt);
    fireEvent.click(sheet().getByRole("button", { name: "Copy message" }));
    await settle();
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith("add a clear button");
  });

  it("sets a plan put up for approval apart from the answers around it", async () => {
    localStorage.setItem(storageKey("mobile.view.claude-code"), "focus");
    vi.stubGlobal("fetch", sidecarFetch(() => ({
      ...STORED,
      entries: [
        { kind: "prompt", text: "plan the merge", at: "2026-09-27T10:00:00Z" },
        { kind: "answer", text: "Here is the plan.", at: "2026-09-27T10:00:01Z" },
        { kind: "answer", text: "# Merge\n\n1. Move the search", plan: true, at: "2026-09-27T10:00:02Z" },
      ],
    })));
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();

    const chat = screen.getByTestId("session-transcript");
    const answers = [...chat.querySelectorAll(".readable-turn.agent.answer")];
    expect(answers.map((bubble) => bubble.classList.contains("plan"))).toEqual([false, true]);
    const plan = screen.getByRole("group", { name: "Plan" });
    expect(plan).toBe(answers[1]);
    expect(plan.querySelector(".transcript-plan-head")?.textContent).toMatch(/^Plan/);
    expect(plan.querySelector("h1")?.textContent).toBe("Merge");
  });

  it("keeps a question the agent asked in the chat with its answer", async () => {
    localStorage.setItem(storageKey("mobile.view.claude-code"), "focus");
    vi.stubGlobal("fetch", sidecarFetch(() => ({
      ...STORED,
      entries: [
        { kind: "prompt", text: "ask me", at: "2026-09-27T10:00:00Z" },
        {
          kind: "answer",
          text: "Which colour?\n→ Red",
          at: "2026-09-27T10:00:01Z",
          questions: [
            { header: "Colour", question: "Which colour?", answer: "Red", options: [{ label: "Red (Recommended)", chosen: false }, { label: "Red", description: "Warm", chosen: true }, { label: "Blue" }] },
            { question: "Which season?", answer: "Late autumn", options: [{ label: "Spring" }] },
            { question: "Which day?", options: [{ label: "Monday" }] },
          ],
        },
      ],
    })));
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();

    const card = screen.getByRole("group", { name: "Question" });
    expect(card.querySelector(".question-tabs")?.textContent).toBe("Colour");
    const rows = [...card.querySelectorAll(".asked-list li")];
    expect(rows.map((row) => [row.querySelector("strong")?.textContent, row.classList.contains("chosen")])).toEqual([
      ["RedRecommended", false],
      ["Red", true],
      ["Blue", false],
      ["Spring", false],
      // Typed, not picked: a row of its own.
      ["Late autumn", true],
      ["Monday", false],
    ]);
    expect(card.querySelectorAll("button")).toHaveLength(0);
    // Turned down: says so.
    expect(card.querySelectorAll(".asked-none")).toHaveLength(1);
    expect(card.querySelector(".asked-none")?.textContent).toBe("Not answered");
  });

  it("lets a message's text be selected in part and copies only what is marked", async () => {
    localStorage.setItem(storageKey("mobile.view.claude-code"), "focus");
    vi.stubGlobal("fetch", sidecarFetch(() => STORED));
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();

    const answers = screen.getByTestId("session-transcript").querySelectorAll(".readable-turn.agent.answer");
    fireEvent.contextMenu(answers[1] as HTMLElement);
    const sheet = () => within(screen.getByRole("dialog", { name: "Message" }));
    fireEvent.click(sheet().getByRole("button", { name: /^Select text/ }));
    const text = screen.getByTestId("message-select-text");
    expect(text.textContent).toBe("Done: the **✕** empties the draft. See [the docs](https://example.com).");
    // Nothing marked yet: Copy still takes the whole message.
    sheet().getByRole("button", { name: "Copy message" });

    const range = document.createRange();
    range.setStart(text.firstChild as Text, 6);
    range.setEnd(text.firstChild as Text, 9);
    act(() => {
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    fireEvent.click(sheet().getByRole("button", { name: "Copy selection" }));
    await settle();
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith("the");
    window.getSelection()?.removeAllRanges();
  });

  it("pins the prompt the scroll position is reading the answer to, and a tap returns to it", async () => {
    localStorage.setItem(storageKey("mobile.view.claude-code"), "focus");
    vi.stubGlobal("fetch", sidecarFetch(() => ({
      ...STORED,
      entries: [{ kind: "prompt", text: "an older question", at: "2026-09-15T05:40:00.000Z" }, { kind: "answer", text: "An older answer." }, ...STORED.entries],
    })));
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    // The output's top edge sits at 100; each prompt bubble is 40 tall and
    // placed by its top edge.
    const tops: Record<string, number> = { "an older question": 110, "add a clear button": 300 };
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("readable-output")) return new DOMRect(0, 100, 400, 600);
      const top = this.dataset.prompt === undefined ? undefined : tops[this.dataset.prompt];
      return new DOMRect(0, top ?? 0, 300, 40);
    });
    const label = "Your prompt for this answer — show it";
    const pinnedText = () => screen.queryByRole("button", { name: label })?.querySelector(".readable-pinned-prompt-text")?.textContent ?? null;
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    const output = document.querySelector(".readable-output") as HTMLElement;
    // Both bubbles in view: nothing to pin.
    expect(pinnedText()).toBeNull();

    // Scrolled into the older answer, the newer prompt in view below it: a
    // prompt is on screen, so the older one does not pin.
    tops["an older question"] = 20;
    tops["add a clear button"] = 400;
    fireEvent.scroll(output);
    expect(pinnedText()).toBeNull();

    // The newer prompt below the view's bottom edge (700): the older prompt
    // pins, not the newest.
    tops["add a clear button"] = 720;
    fireEvent.scroll(output);
    expect(pinnedText()).toBe("an older question");

    // The newer bubble half off the top is still in view: nothing pins.
    tops["add a clear button"] = 80;
    fireEvent.scroll(output);
    expect(pinnedText()).toBeNull();

    // Scrolled past the newer bubble: it pins, and a tap returns to it.
    tops["add a clear button"] = 20;
    tops["an older question"] = -200;
    fireEvent.scroll(output);
    expect(pinnedText()).toBe("add a clear button");
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "smooth" });
    const prompts = screen.getAllByRole("group", { name: "Your prompt" });
    expect(scrollIntoView.mock.contexts[0]).toBe(prompts[prompts.length - 1]);
  });

  it("falls back to the screen when the session is unavailable, and can be switched to it", async () => {
    localStorage.setItem(storageKey("mobile.view.claude-code"), "focus");
    let stored: unknown = { available: false, reason: "no_session", entries: [], truncated: false };
    vi.stubGlobal("fetch", sidecarFetch(() => stored));
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    // The session as it paints: the echo, the answer, the live input box last.
    const bytes = new TextEncoder().encode("> hello\n\n⏺ Hi there.\n\n> ");
    const payload = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(payload).set(bytes);
    act(() => { FakeWebSocket.instances[0].onmessage?.({ data: payload } as MessageEvent); });
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 200)); });
    expect(screen.queryByTestId("session-transcript")).toBeNull();
    expect(screen.getByText("Hi there.").closest(".readable-turn")?.className).toBe("readable-turn agent answer");
    // The choice is a list under the Focus button; Session is there, dimmed,
    // saying why, and a tap on it does not switch.
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    const dimmed = screen.getByRole("menuitemradio", { name: /Session/ });
    expect(dimmed.getAttribute("aria-disabled")).toBe("true");
    expect(dimmed.textContent).toContain("No session id for this tab yet");
    expect(screen.getByRole("menuitemradio", { name: /Screen/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(dimmed);
    expect(screen.queryByTestId("session-transcript")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(screen.queryByRole("menu")).toBeNull();

    stored = STORED;
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await settle();
    screen.getByTestId("session-transcript");
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Screen/ }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByTestId("session-transcript")).toBeNull();
    expect(screen.getByText("Hi there.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Session/ }));
    screen.getByTestId("session-transcript");
  });

  it("reads a full-screen agent's stored session in Focus instead of the full-screen notice", async () => {
    const openCode = { ...TAB, id: "tab-oc", label: "OpenCode", agent_label: "OpenCode" };
    localStorage.setItem(storageKey("mobile.view.opencode"), "focus");
    let stored: unknown = STORED;
    vi.stubGlobal("fetch", sidecarFetch(() => stored));
    render(<Terminal tab={openCode} back={() => {}} />);
    await settle();
    // OpenCode's TUI draws on the alternate screen.
    terminalState.alternate = true;
    const bytes = new TextEncoder().encode("┃ Build  grok-4.5\n┃ > 1. Yes\n┃   2. No");
    const payload = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(payload).set(bytes);
    act(() => { FakeWebSocket.instances[0].onmessage?.({ data: payload } as MessageEvent); });
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 200)); });
    screen.getByTestId("session-transcript");
    expect(screen.queryByText("Full-screen program")).toBeNull();
    // The frame is read for the one thing the stored session cannot carry: the
    // choice the agent is waiting on. A fullscreen agent draws it there and
    // nowhere else — no scrollback holds it — and it has to pass the same
    // shape check as a dialog on a scrolling screen.
    within(screen.getByRole("group", { name: "Waiting for your answer" })).getByText("Yes");

    // Switched to the screen, the full-screen program says so, as before.
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Screen/ }));
    screen.getByText("Full-screen program");
    expect(screen.queryByTestId("session-transcript")).toBeNull();

    // The notice leads back to the stored session; with none, it is only the notice.
    fireEvent.click(screen.getByRole("button", { name: "Read the agent's stored conversation" }));
    screen.getByTestId("session-transcript");
    stored = { available: false, reason: "unsupported", entries: [], truncated: false };
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await settle();
    screen.getByText("Full-screen program");
    expect(screen.queryByRole("button", { name: "Read the agent's stored conversation" })).toBeNull();
  });

  it("shows a sent prompt as the reader's bubble at once, and never changes it", async () => {
    localStorage.setItem(storageKey("mobile.view.claude-code"), "focus");
    let stored = STORED;
    const fetchMock = sidecarFetch(() => stored);
    vi.stubGlobal("fetch", fetchMock);
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    fireEvent.change(screen.getByRole("textbox", { name: "Message agent" }), { target: { value: "also the tests" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await settle();
    // The desktop is told the words, for the tab's prompt history.
    const report = fetchMock.mock.calls.find(([url]) => (url as string).endsWith(`/tabs/${TAB.id}/prompt`)) as unknown[] | undefined;
    expect(report?.[1]).toMatchObject({ method: "POST", body: JSON.stringify({ message: "also the tests" }) });
    // In the chat at once, as any prompt, not a "Sent" strip under it.
    const chat = screen.getByTestId("session-transcript");
    const prompts = () => [...chat.querySelectorAll(".readable-turn.user")];
    const bubble = prompts()[1];
    expect(said(bubble)).toBe("also the tests");
    expect(bubble.className).toBe("readable-turn user");
    expect(document.querySelector(".last-sent")).toBeNull();

    // The agent answered, then took the prompt in: the record lands after
    // that answer in the file, the bubble stays where it was, as it was.
    stored = { ...STORED, version: "1300:2", entries: [
      ...STORED.entries,
      { kind: "answer", text: "Still on the button.", at: "2026-09-15T05:51:00.000Z" },
      { kind: "prompt", text: "also the tests", at: "2026-09-15T05:52:00.000Z" },
    ] };
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await settle();
    expect(prompts()).toHaveLength(2);
    expect(prompts()[1]).toBe(bubble);
    expect(said(bubble)).toBe("also the tests");
    expect(said(bubble.nextElementSibling)).toBe("Still on the button.");
  });

  it("keeps a sent prompt in Reader while Codex is binding its rollout", async () => {
    const codex = { ...TAB, id: "tab-codex", label: "Codex", agent_label: "Codex" };
    localStorage.setItem(storageKey("mobile.view.codex"), "focus");
    let stored: unknown = { available: true, version: "new:codex", truncated: false, entries: [] };
    vi.stubGlobal("fetch", sidecarFetch(() => stored));
    render(<Terminal tab={codex} back={() => {}} />);
    await settle();

    fireEvent.change(screen.getByRole("textbox", { name: "Message agent" }), { target: { value: "keep this visible" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await settle();
    expect(said(screen.getByRole("group", { name: "Your prompt" }))).toBe("keep this visible");

    // Current Codex releases can announce the live session before a readable
    // rollout exists. The reader must retain the phone's just-sent prompt
    // through that temporary `no_transcript` response.
    stored = { available: false, reason: "no_transcript", entries: [], truncated: false };
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await settle();
    screen.getByTestId("session-transcript");
    expect(said(screen.getByRole("group", { name: "Your prompt" }))).toBe("keep this visible");

    stored = { available: true, version: "answer:codex", entries: [
      { kind: "answer", text: "Here is the answer." },
    ], truncated: false };
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await settle();
    expect([...screen.getByTestId("session-transcript").querySelectorAll(".readable-turn")]
      .map((bubble) => said(bubble))).toEqual(["keep this visible", "Here is the answer."]);
  });

  it("shows Codex's next unstamped answer below the prompt sent from this phone", async () => {
    const codex = { ...TAB, id: "tab-codex", label: "Codex", agent_label: "Codex" };
    localStorage.setItem(storageKey("mobile.view.codex"), "focus");
    let stored: unknown = { available: true, version: "one", truncated: false, entries: [
      { kind: "prompt", text: "first", at: "2026-09-18T10:00:00Z" },
      { kind: "answer", text: "First reply" },
    ] };
    vi.stubGlobal("fetch", sidecarFetch(() => stored));
    render(<Terminal tab={codex} back={() => {}} />);
    await settle();

    fireEvent.change(screen.getByRole("textbox", { name: "Message agent" }), { target: { value: "follow up" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await settle();
    stored = { available: true, version: "two", truncated: false, entries: [
      { kind: "prompt", text: "first", at: "2026-09-18T10:00:00Z" },
      { kind: "answer", text: "First reply" },
      { kind: "answer", text: "Reply to follow up" },
    ] };
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await settle();

    const bubbles = screen.getByTestId("session-transcript").querySelectorAll(".readable-turn");
    expect([...bubbles].map((bubble) => said(bubble))).toEqual([
      "first", "First reply", "follow up", "Reply to follow up",
    ]);
  });

  it("starts Reader on an empty chat after a Codex /clear, until the new session is read", async () => {
    const codex = { ...TAB, id: "tab-codex", label: "Codex", agent_label: "Codex" };
    localStorage.setItem(storageKey("mobile.view.codex"), "focus");
    let stored: unknown = { ...STORED, usage: { contextLeft: 12 } };
    vi.stubGlobal("fetch", sidecarFetch(() => stored));
    render(<Terminal tab={codex} back={() => {}} />);
    await settle();
    expect(screen.getByText("add a clear button")).toBeTruthy();

    // Codex writes no rollout — and reports no new id — until the first
    // prompt, so the desktop still answers with the cleared conversation.
    fireEvent.click(screen.getByRole("button", { name: "Start a new conversation" }));
    await settle();
    expect(screen.queryByText("add a clear button")).toBeNull();
    expect(screen.queryByText("12%")).toBeNull();
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await settle();
    expect(screen.queryByText("add a clear button")).toBeNull();

    fireEvent.change(screen.getByRole("textbox", { name: "Message agent" }), { target: { value: "fresh start" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await settle();
    expect([...screen.getByTestId("session-transcript").querySelectorAll(".readable-turn")]
      .map((bubble) => said(bubble))).toEqual(["fresh start"]);

    // The new rollout is bound: its records are the chat.
    stored = { available: true, version: "new-rollout", truncated: false, entries: [
      { kind: "prompt", text: "fresh start", at: "2026-09-24T08:00:00Z" },
      { kind: "answer", text: "Starting fresh." },
    ] };
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await settle();
    expect([...screen.getByTestId("session-transcript").querySelectorAll(".readable-turn")]
      .map((bubble) => said(bubble))).toEqual(["fresh start", "Starting fresh."]);
  });

  it("does not send /clear to a working Codex, and says why on the phone", async () => {
    const codex = { ...TAB, id: "tab-codex", label: "Codex", agent_label: "Codex" };
    localStorage.setItem(storageKey("mobile.view.codex"), "focus");
    vi.stubGlobal("fetch", sidecarFetch(() => STORED));
    render(<Terminal tab={codex} back={() => {}} />);
    await settle();
    const working = new TextEncoder().encode("• Working (6s • esc to interrupt)\n› ");
    const payload = new ArrayBuffer(working.byteLength);
    new Uint8Array(payload).set(working);
    act(() => { FakeWebSocket.instances[0].onmessage?.({ data: payload } as MessageEvent); });
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 200)); });
    const before = FakeWebSocket.instances[0].sent.length;

    fireEvent.click(screen.getByRole("button", { name: "Start a new conversation" }));
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 350)); });
    expect(FakeWebSocket.instances[0].sent.length).toBe(before);
    expect(screen.getByText(/Codex is still working/)).toBeTruthy();
    // The conversation goes on, and so does the chat.
    expect(screen.getByText("add a clear button")).toBeTruthy();
  });

  it("offers Undo after a Claude clear: the desktop resumes the cleared chat and the Reader shows it again", async () => {
    localStorage.setItem(storageKey("mobile.view.claude"), "focus");
    const undoCalls: string[] = [];
    let answerUndo = () => {};
    const sidecar = sidecarFetch(() => STORED);
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith("/undo-clear")) {
        undoCalls.push(init?.method ?? "GET");
        return new Promise((resolve) => { answerUndo = () => resolve(jsonResponse(200, { undone: true })); });
      }
      return sidecar(url);
    }));
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    expect(screen.getByText("add a clear button")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Start a new conversation" }));
    await settle();
    expect(screen.queryByText("add a clear button")).toBeNull();
    const undo = screen.getByRole("button", { name: "Bring back the conversation you just cleared" });
    expect(undo.textContent).toBe("Undo");

    fireEvent.click(undo);
    await settle();
    expect(undoCalls).toEqual(["POST"]);
    // Until the desktop answers and the conversation is read back, the chip
    // and the empty chat say the Undo is under way.
    const undoing = screen.getByRole("button", { name: "Undoing…" });
    expect(undoing.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("Bringing the conversation back…")).toBeTruthy();
    answerUndo();
    await settle();
    expect(screen.queryByRole("button", { name: "Undoing…" })).toBeNull();
    expect(screen.getByText("add a clear button")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start a new conversation" }).textContent).toBe("Clear");
  });

  it("keeps the chat while a /clear sent mid-turn waits behind the turn, and starts over when it ends", async () => {
    localStorage.setItem(storageKey("mobile.view.claude"), "focus");
    vi.stubGlobal("fetch", sidecarFetch(() => STORED));
    const working = { ...TAB, agent_status: "working" } as typeof TAB;
    const { rerender } = render(<Terminal tab={working} back={() => {}} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Start a new conversation" }));
    await settle();
    // Claude queues it: the conversation is not cleared yet, so nothing is
    // hidden and there is nothing to undo — an Undo now resumed an older chat.
    expect(screen.getByText("add a clear button")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Bring back the conversation you just cleared" })).toBeNull();

    rerender(<Terminal tab={{ ...TAB, agent_status: "idle" } as typeof TAB} back={() => {}} />);
    await settle();
    expect(screen.queryByText("add a clear button")).toBeNull();
    expect(screen.getByRole("button", { name: "Bring back the conversation you just cleared" })).toBeTruthy();
  });

  it("takes Undo away once the new chat is given a prompt, and offers it on Codex but not Aider", async () => {
    localStorage.setItem(storageKey("mobile.view.claude"), "focus");
    vi.stubGlobal("fetch", sidecarFetch(() => STORED));
    const { unmount } = render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Start a new conversation" }));
    await settle();
    expect(screen.getByRole("button", { name: "Bring back the conversation you just cleared" })).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Message agent" }), { target: { value: "fresh start" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await settle();
    expect(screen.queryByRole("button", { name: "Bring back the conversation you just cleared" })).toBeNull();
    expect(screen.getByRole("button", { name: "Start a new conversation" })).toBeTruthy();
    unmount();

    const codex = { ...TAB, id: "tab-codex", label: "Codex", agent_label: "Codex" };
    localStorage.setItem(storageKey("mobile.view.codex"), "focus");
    const codexView = render(<Terminal tab={codex} back={() => {}} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Start a new conversation" }));
    await settle();
    expect(screen.getByRole("button", { name: "Bring back the conversation you just cleared" })).toBeTruthy();
    codexView.unmount();

    // Aider resumes nothing, so its clear is final.
    const aider = { ...TAB, id: "tab-aider", label: "Aider", agent_label: "Aider" };
    render(<Terminal tab={aider} back={() => {}} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Start a new conversation" }));
    await settle();
    expect(screen.queryByRole("button", { name: "Bring back the conversation you just cleared" })).toBeNull();
  });

  it("reloads the Reader after an Undo, reading the session afresh", async () => {
    localStorage.setItem(storageKey("mobile.view.claude"), "focus");
    const transcriptUrls: string[] = [];
    const sidecar = sidecarFetch(() => STORED);
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.endsWith("/undo-clear")) return Promise.resolve(jsonResponse(200, { undone: true }));
      if (url.includes("/transcript")) transcriptUrls.push(url);
      return sidecar(url);
    }));
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Start a new conversation" }));
    await settle();
    const before = transcriptUrls.length;
    fireEvent.click(screen.getByRole("button", { name: "Bring back the conversation you just cleared" }));
    await settle();
    await settle();
    const reads = transcriptUrls.slice(before);
    expect(reads.length).toBeGreaterThan(0);
    // No version: the whole session comes back, not an "unchanged".
    expect(reads.some((url) => !url.includes("version="))).toBe(true);
  });

  it("clears the draft with the composer's ✕", async () => {
    vi.stubGlobal("fetch", sidecarFetch(() => STORED));
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    expect(screen.queryByRole("button", { name: "Clear the message" })).toBeNull();
    const input = screen.getByRole("textbox", { name: "Message agent" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "a long dictated draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear the message" }));
    expect(input.value).toBe("");
    expect(screen.queryByRole("button", { name: "Clear the message" })).toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it("asks a socket that came back with the page to prove itself, and reconnects when it does not", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", sidecarFetch(() => STORED));
    render(<Terminal tab={TAB} back={() => {}} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const first = FakeWebSocket.instances[0];
    expect(first.sent.some((frame) => frame.includes("\"ready\""))).toBe(true);
    const before = first.sent.length;
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(first.sent.slice(before).some((frame) => frame.includes("\"ping\""))).toBe(true);
    // No pong within the resume grace: the socket is closed, and a new one opened.
    await act(async () => { await vi.advanceTimersByTimeAsync(4_100); });
    expect(first.readyState).toBe(FakeWebSocket.CLOSED);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_100); });
    expect(FakeWebSocket.instances.length).toBe(2);
    vi.useRealTimers();
  });
});
