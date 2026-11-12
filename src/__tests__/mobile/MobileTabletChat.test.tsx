/**
 * The agent chat on a tablet (`Terminal.tsx`, the `Tablet tiers` block of
 * `style.css`). The thing that must not break: a turn of the iPad (or a Split
 * View resize) and the files pane must not remount the screen, the transcript
 * or the composer, nor reconnect the socket. So the tier is flipped here at
 * runtime — the stubbed `matchMedia` fires `change` — and the very same DOM
 * nodes, the draft and the one socket are expected afterwards.
 */
// @ts-expect-error node:fs has no type declarations in this project (no @types/node)
import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubTerminalSideChannels } from "../helpers/mobileTerminalHost";

const terminalState = vi.hoisted(() => ({ lines: [] as string[] }));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    modes = { bracketedPasteMode: false };
    textarea = document.createElement("textarea");
    buffer = {
      active: {
        get length() { return terminalState.lines.length; },
        getLine(row: number) {
          const value = terminalState.lines[row];
          return value == null ? undefined : { isWrapped: false, translateToString: () => value };
        },
      },
    };
    loadAddon() {}
    open() {}
    write(value: Uint8Array, callback?: () => void) {
      terminalState.lines = new TextDecoder().decode(value).split("\n");
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
  readyState = FakeWebSocket.OPEN;
  binaryType = "";
  closed = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor() {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send() {}
  close() { this.readyState = 3; this.closed += 1; }
}

import { Terminal } from "../../../mobile-web/src/screens/Terminal";
import { readFlag, writeFlag } from "../../../mobile-web/src/prefs";
import { SPLIT_QUERY, TABLET_QUERY } from "../../../mobile-web/src/useTier";
import { BRAND, storageKey } from "../../lib/brand";

const CSS: string = readFileSync("mobile-web/src/style.css", "utf8");
type Tier = "phone" | "tablet" | "split";

/** A window whose tier the test turns: `matchMedia` answers the two tier
 * queries and tells its listeners when the answer changes. */
function stubTierWindow(start: Tier) {
  let tier = start;
  const listeners = new Set<() => void>();
  const matches = (query: string) => (query === TABLET_QUERY && tier !== "phone") || (query === SPLIT_QUERY && tier === "split");
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() { return matches(query); },
    media: query,
    addEventListener: (_type: string, listener: () => void) => { listeners.add(listener); },
    removeEventListener: (_type: string, listener: () => void) => { listeners.delete(listener); },
  }));
  return {
    set(next: Tier) {
      tier = next;
      act(() => { [...listeners].forEach((listener) => listener()); });
    },
  };
}

const STATUS_ROW = `~/${BRAND.slug}/projects/demo (develop) · Opus · 42% context`;
const CLAUDE_SCREEN = [
  "> fix the failing test",
  "",
  "⏺ Reading the test first.",
  "",
  "╭──────────────────────────────────────╮",
  "│ >                                    │",
  "╰──────────────────────────────────────╯",
  STATUS_ROW,
].join("\n");

function host() {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "/api/v1/projects/p1") {
      return new Response(JSON.stringify({ project: { id: "p1", label: "Alpha", status: "active" }, desktop_available: true, agents: [], tabs: [], files: true }), { status: 200 });
    }
    if (url === "/api/v1/projects/p1/files") {
      return new Response(JSON.stringify({ entries: [{ token: "tok-src", name: "src", kind: "dir", size: 0, modified: 1_770_000_000 }], truncated: false }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
  });
}

async function openChat() {
  const view = render(<Terminal tab={{ id: "tab", label: "Claude", kind: "agent", available: true, viewer_busy: false }} project="p1" back={() => {}} />);
  await act(async () => {});
  const bytes = new TextEncoder().encode(CLAUDE_SCREEN);
  const payload = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(payload).set(bytes);
  act(() => FakeWebSocket.instances[0].onmessage?.({ data: payload } as MessageEvent));
  await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 200)); });
  return view;
}

const main = () => document.querySelector("main.terminal-screen") as HTMLElement;
const header = () => main().querySelector("header") as HTMLElement;
const composer = () => main().querySelector(".prompt-composer textarea") as HTMLTextAreaElement;

describe(`${BRAND.display} Mobile chat on a tablet`, () => {
  beforeEach(() => {
    terminalState.lines = [];
    FakeWebSocket.instances = [];
    localStorage.clear();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    stubTerminalSideChannels();
    vi.stubGlobal("fetch", host());
    localStorage.setItem(storageKey("mobile.view.agent"), "focus");
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps the screen, the composer, the draft and the one socket across every tier change and the files pane", async () => {
    const window_ = stubTierWindow("phone");
    await openChat();
    await screen.findByRole("button", { name: "Project menu" });
    fireEvent.change(composer(), { target: { value: "half a thought" } });

    const nodes = { main: main(), header: header(), field: composer(), output: screen.getByRole("region", { name: "Session output" }), controls: main().querySelector(".terminal-controls") };
    const same = () => {
      expect(main()).toBe(nodes.main);
      expect(header()).toBe(nodes.header);
      expect(composer()).toBe(nodes.field);
      expect(screen.getByRole("region", { name: "Session output" })).toBe(nodes.output);
      expect(main().querySelector(".terminal-controls")).toBe(nodes.controls);
      expect(composer().value).toBe("half a thought");
      expect(FakeWebSocket.instances.length).toBe(1);
      expect(FakeWebSocket.instances[0].closed).toBe(0);
    };

    for (const next of ["tablet", "split", "tablet", "phone", "split", "phone"] as Tier[]) {
      window_.set(next);
      same();
    }

    // The pane: docking and undocking it is a change of attributes only.
    window_.set("split");
    fireEvent.click(screen.getByRole("button", { name: "Show or hide files" }));
    same();
    expect(main().hasAttribute("data-files-docked")).toBe(true);
    expect(screen.getByRole("button", { name: "Show or hide files" }).getAttribute("aria-pressed")).toBe("true");
    const pane = screen.getByRole("dialog", { name: "Files" });
    expect(pane.getAttribute("aria-modal")).toBe("false");
    expect(await within(pane).findByRole("button", { name: "Open the folder src" })).toBeTruthy();
    expect(readFlag("chatFilesPane")).toBe(true);

    // Turning the screen upright puts the pane away without touching the chat…
    window_.set("tablet");
    same();
    expect(screen.queryByRole("dialog", { name: "Files" })).toBeNull();
    expect(main().hasAttribute("data-files-docked")).toBe(false);
    // …and landscape brings it back as this device left it.
    window_.set("split");
    same();
    expect(screen.getByRole("dialog", { name: "Files" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Show or hide files" }));
    same();
    expect(screen.queryByRole("dialog", { name: "Files" })).toBeNull();
    expect(readFlag("chatFilesPane")).toBe(false);
  });

  it("opens the pane at once where this device left it open, in landscape only", async () => {
    writeFlag("chatFilesPane", true);
    stubTierWindow("tablet");
    await openChat();
    await screen.findByRole("button", { name: "Project menu" });
    expect(screen.queryByRole("dialog", { name: "Files" })).toBeNull();
    cleanup();

    stubTierWindow("split");
    await openChat();
    expect(await screen.findByRole("dialog", { name: "Files" })).toBeTruthy();
    expect(main().hasAttribute("data-files-docked")).toBe(true);
  });

  it("leaves the chat's keys to the chat while the pane is docked: Escape and the arrows act in the pane only with the focus in it", async () => {
    writeFlag("chatFilesPane", true);
    stubTierWindow("split");
    await openChat();
    const pane = await screen.findByRole("dialog", { name: "Files" });
    expect(pane.hasAttribute("data-docked")).toBe(true);
    const folder = await within(pane).findByRole("button", { name: "Open the folder src" });

    // Escape in the composer is not the pane's: it stays, and so does the preference.
    composer().focus();
    fireEvent.keyDown(composer(), { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Files" })).toBe(pane);
    expect(readFlag("chatFilesPane")).toBe(true);
    // Nothing focused (a tap on the transcript): ↓ does not walk into the pane.
    composer().blur();
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(pane.contains(document.activeElement)).toBe(false);

    // With the focus in the pane its keys are its own.
    folder.focus();
    fireEvent.keyDown(folder, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Files" })).toBeNull();
    expect(readFlag("chatFilesPane")).toBe(false);
  });

  it("gives the chat its whole width while a markup view is tucked away, which hides the pane with it", async () => {
    writeFlag("chatFilesPane", true);
    stubTierWindow("split");
    const file = { name: "20261001-120000-plot.png", original: "plot.png", kind: "image/png", size: 4_000, modified: 1_790_000_000 };
    render(<Terminal tab={{ id: "tab", label: "Claude", kind: "agent", available: true, viewer_busy: false }} project="p1" back={() => {}} markupBack={{ scope: { tab: "tab" }, file }} />);
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 200)); });
    expect(document.querySelector(".markup-away-notice")).toBeTruthy();
    // The pane is open (and hidden with the tucked-away view), but leaves no empty strip.
    expect(document.querySelector(".markup-host.away .files-library")).toBeTruthy();
    expect(main().hasAttribute("data-files-docked")).toBe(false);
  });

  it("keeps the files open through a turn out of landscape while a markup view hangs on them", async () => {
    writeFlag("chatFilesPane", true);
    const window_ = stubTierWindow("split");
    const file = { name: "20261001-120000-plot.png", original: "plot.png", kind: "image/png", size: 4_000, modified: 1_790_000_000 };
    render(<Terminal tab={{ id: "tab", label: "Claude", kind: "agent", available: true, viewer_busy: false }} project="p1" back={() => {}} markupBack={{ scope: { tab: "tab" }, file }} />);
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 200)); });
    expect(document.querySelector(".markup-host.away .files-library")).toBeTruthy();
    // Upright, the bare pane would be put away; this one holds the view the
    // "back to markup" notice returns to.
    window_.set("tablet");
    expect(document.querySelector(".markup-away-notice")).toBeTruthy();
    expect(document.querySelector(".markup-host.away .files-library")).toBeTruthy();
    expect(readFlag("chatFilesPane")).toBe(true);
  });

  it("opens today's drawer from the files button on a portrait tablet and a phone, and a pane toggle only in landscape", async () => {
    const window_ = stubTierWindow("tablet");
    await openChat();
    const button = await screen.findByRole("button", { name: "Project menu" });
    expect(button.getAttribute("aria-pressed")).toBeNull();
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    fireEvent.click(button);
    expect(screen.getByRole("dialog", { name: "Files" }).getAttribute("aria-modal")).toBe("true");
    expect(main().hasAttribute("data-files-docked")).toBe(false);
    expect(readFlag("chatFilesPane")).toBe(false);
    window_.set("split");
    // Open as a drawer, landscape docks it where it stands.
    expect(screen.getByRole("button", { name: "Show or hide files" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("gives a tablet the header's model pill, queue pill and Chat | Terminal switch; a phone has none of them", async () => {
    const window_ = stubTierWindow("phone");
    await openChat();
    await screen.findByRole("button", { name: "Project menu" });
    expect(header().querySelector(".header-model, .header-queue, .view-seg")).toBeNull();
    expect(header().querySelector(".untested")).toBeNull();
    expect(header().querySelector(".view-pill")?.textContent).toBe("Chat");
    // A phone's model is the facts row's chip.
    const modelSpots = () => [...document.querySelectorAll('[data-phone-hint="model"]')];
    expect(modelSpots().map((node) => node.className)).toEqual(["fact-action"]);

    window_.set("tablet");
    const model = header().querySelector(".header-model") as HTMLElement;
    // The model stands once: the pill takes the chip's place (and its hint's anchor).
    expect(modelSpots()).toEqual([model]);
    expect(model.getAttribute("aria-haspopup")).toBe("dialog");
    expect(model.textContent).toContain("Opus");
    const queue = within(header()).getByRole("button", { name: "Prompt queue" });
    expect(queue.querySelector(".header-count")).toBeNull();
    fireEvent.click(queue);
    expect(screen.getByRole("dialog", { name: "Prompt queue" }).textContent).toContain("Nothing is queued");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    const group = within(header()).getByRole("group", { name: "Output view" });
    const chat = within(group).getByRole("button", { name: "Chat" });
    const terminal = within(group).getByRole("button", { name: "Terminal" });
    expect(chat.getAttribute("aria-pressed")).toBe("true");
    expect(main().getAttribute("data-view")).toBe("focus");
    fireEvent.click(terminal);
    expect(main().getAttribute("data-view")).toBe("terminal");
    expect(terminal.getAttribute("aria-pressed")).toBe("true");
    expect(chat.getAttribute("aria-pressed")).toBe("false");
    // The pill keeps the list's other rows reachable.
    fireEvent.click(within(group).getByRole("button", { name: "Output view" }));
    expect(screen.getByRole("menuitemradio", { name: "Chat" })).toBeTruthy();
    // The project's name stands over the tab's.
    expect(header().querySelector(".terminal-title small")?.textContent).toBe("Alpha");
  });
});

describe(`${BRAND.display} Mobile tablet queue pill`, () => {
  /** A socket that also takes JSON control frames and prints screens (as `MobileSendNow.test.tsx`). */
  class QueueSocket extends FakeWebSocket {
    event(frame: object) { this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent); }
    output(text: string) {
      const bytes = new TextEncoder().encode(text);
      const data = new ArrayBuffer(bytes.length);
      new Uint8Array(data).set(bytes);
      this.onmessage?.({ data } as MessageEvent);
    }
  }
  const RULE = "─".repeat(60);
  const frame = (spinner: string, box = "") => ["❯ fix it", "", spinner, RULE, `❯ ${box}`, RULE, "  ⏵⏵ auto mode on (shift+tab to cycle)"].join("\n");
  const WORKING = frame("✻ Pondering… (12s · ↓ 2.0k tokens)");
  const THINKING = frame("✻ Pondering… (9s · ↓ 1.2k tokens · thinking with high effort)", "Press up to edit queued messages");
  const tick = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  const socket = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1] as QueueSocket;
  const paint = async (text: string) => { act(() => socket().output(text)); await tick(300); };

  beforeEach(() => {
    vi.useFakeTimers();
    terminalState.lines = [];
    FakeWebSocket.instances = [];
    localStorage.clear();
    localStorage.setItem(storageKey("mobile.view.claude-code"), "focus");
    vi.stubGlobal("WebSocket", QueueSocket);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/outbox")) return json({ files: [] });
      if (url.includes("/transcript")) return json({ transcript: { available: true, version: "1:1", truncated: false, entries: [{ kind: "prompt", text: "fix it", at: "2026-10-25T10:00:00Z" }] } });
      if (url.endsWith("/held")) return json({ id: "held-1" });
      return json({});
    }));
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("offers the queue's moves only where the queued bubbles carry them: the session chat, not the Terminal view", async () => {
    stubTierWindow("tablet");
    render(<Terminal tab={{ id: "tab-7", label: "Claude", kind: "agent", agent_label: "Claude Code", available: true, viewer_busy: false }} back={() => {}} />);
    await tick(50);
    act(() => socket().event({ type: "features", visibility: true, send_now: true }));
    await paint(WORKING);
    fireEvent.change(screen.getByRole("textbox", { name: "Message agent" }), { target: { value: "also the docs" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await tick(50);
    await paint(THINKING);
    // The chat: the bubble carries the pair, and the header's pill offers the same two.
    expect(screen.getAllByRole("button", { name: "Cancel and edit" })).toHaveLength(1);
    fireEvent.click(within(header()).getByRole("button", { name: "Prompt queue: 1 queued" }));
    const sheet = screen.getByRole("dialog", { name: "Prompt queue" });
    expect(within(sheet).getByRole("button", { name: /Send now/ })).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: /Cancel and edit/ })).toBeTruthy();
    // The phone's Send now never stops the turn: no desktop "Stop the agent's turn (Esc)" here.
    expect(sheet.textContent).not.toContain("Stop the agent");
    fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));

    // The Terminal view draws no bubbles, so the pill moves nothing either.
    fireEvent.click(within(within(header()).getByRole("group", { name: "Output view" })).getByRole("button", { name: "Terminal" }));
    expect(screen.queryByRole("button", { name: "Cancel and edit" })).toBeNull();
    fireEvent.click(within(header()).getByRole("button", { name: "Prompt queue: 1 queued" }));
    const idle = screen.getByRole("dialog", { name: "Prompt queue" });
    expect(idle.textContent).toContain("Nothing is queued");
    expect(within(idle).queryByRole("button", { name: /Cancel and edit/ })).toBeNull();
  });
});

describe("the tablet chat stylesheet", () => {
  const block = CSS.slice(CSS.indexOf(`@media ${TABLET_QUERY} {`));

  it("centres only the Chat view at 660px, caps the prompt bubble at 520px and leaves the colours to the theme rules", () => {
    expect(block).toContain('.terminal-screen.agent-tab[data-view="focus"] .readable-output { padding-inline:max(14px,calc((100% - 660px) / 2)); }');
    expect(block).toContain('.terminal-screen.agent-tab[data-view="focus"] .terminal-controls { padding-inline:max(0px,calc((100% - 660px) / 2)); }');
    const bubble = /\.readable-turn\.user:not\(\.with-files\) \{([^}]*)\}/.exec(block)?.[1] ?? "";
    expect(bubble).toContain("max-width:min(88%,520px)");
    expect(bubble).not.toMatch(/background|border:|box-shadow|color/);
  });

  it("docks the library as a 400px rounded panel only in landscape, and not once a file is open", () => {
    const split = CSS.slice(CSS.indexOf(`@media ${SPLIT_QUERY} {`));
    expect(split).toMatch(/\[data-files-docked\] \.files-library:not\(\.files-split\) \{[^}]*width:400px/);
    expect(split).toMatch(/\[data-files-docked\] \{ padding-right:424px; \}/);
    expect(block.slice(0, block.indexOf(`@media ${SPLIT_QUERY} {`))).not.toContain("data-files-docked");
  });
});
