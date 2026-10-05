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
import { SubagentsSheet } from "../../../mobile-web/src/screens/SubagentsSheet";
import type { TranscriptEntry } from "../../../mobile-web/src/api";
import { compactTokens, openSubagent, openSubagentRunning, siblingPosition, stepSibling, subagentAtWork, subagentsIn, workingElapsed, workingModelName } from "../../../mobile-web/src/terminal/subagents";
import { BRAND, storageKey } from "../../lib/brand";

const TAB = { id: "tab-7", label: "Claude", kind: "agent" as const, agent_label: "Claude Code", available: true, viewer_busy: false };

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const settle = () => act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });


const MAIN = {
  available: true,
  version: "main:1",
  truncated: false,
  entries: [
    { kind: "prompt", text: "look around", at: "2026-09-24T10:00:00Z" },
    { kind: "answer", text: "Sending two scouts.", at: "2026-09-24T10:00:01Z" },
    { kind: "agent", text: "Map the backend", role: "Explore", subagent: "00000000000000a1", at: "2026-09-24T10:00:02Z", finished: true },
    { kind: "agent", text: "Find the tests", role: "general-purpose", subagent: "00000000000000b2", at: "2026-09-24T10:00:03Z" },
    { kind: "agent", text: "Still starting", role: "Plan", at: "2026-09-24T10:00:04Z" },
    { kind: "answer", text: "Both reported.", at: "2026-09-24T10:05:00Z" },
  ],
};

const SUBAGENTS: Record<string, unknown> = {
  "00000000000000a1": {
    available: true, version: "a1:1", truncated: false,
    entries: [
      { kind: "prompt", text: "Map every backend module", at: "2026-09-24T10:00:02Z" },
      { kind: "agent", text: "Dig into sync", role: "Explore", subagent: "00000000000000c3", at: "2026-09-24T10:00:10Z" },
      { kind: "answer", text: "The backend is in src-tauri.", at: "2026-09-24T10:01:00Z" },
    ],
  },
  "00000000000000b2": {
    available: true, version: "b2:1", truncated: false,
    entries: [{ kind: "answer", text: "Tests live beside the code.", at: "2026-09-24T10:02:00Z" }],
  },
  "00000000000000c3": { available: false, reason: "no_subagent", entries: [], truncated: false },
};

/** A fetch answering the session with MAIN and a subagent read with its own. */
function subagentFetch() {
  return vi.fn((url: string) => {
    if (url.endsWith("/outbox")) return Promise.resolve(jsonResponse(200, { files: [] }));
    if (url.includes("/transcript")) {
      const token = new URL(url, "http://phone").searchParams.get("subagent");
      return Promise.resolve(jsonResponse(200, { transcript: token ? SUBAGENTS[token] : MAIN }));
    }
    return Promise.resolve(jsonResponse(404, { error: "not_found" }));
  });
}

describe("the pure path through subagents", () => {
  const entries = MAIN.entries as TranscriptEntry[];
  it("lists only the subagents that can be opened, and steps among them", () => {
    expect(subagentsIn(entries).map((ref) => ref.token)).toEqual(["00000000000000a1", "00000000000000b2"]);
    const path = openSubagent([], { token: "00000000000000a1", task: "Map the backend", role: "Explore" }, entries, 240);
    expect(siblingPosition(path[0])).toEqual({ index: 0, count: 2 });
    // Opened, it carries the time its entry says it was spawned.
    expect(path[0].at).toBe("2026-09-24T10:00:02Z");
    const next = stepSibling(path, 1);
    expect(next[0]).toMatchObject({ token: "00000000000000b2", task: "Find the tests", scrollTop: 240, at: "2026-09-24T10:00:03Z" });
    // Past either end the path stays as it is.
    expect(stepSibling(next, 1)).toBe(next);
    expect(stepSibling(path, -1)).toBe(path);
    expect(stepSibling([], 1)).toEqual([]);
  });

  it("knows an open subagent at work by the session's live entries", () => {
    const live = entries.map((entry) => (entry.subagent === "00000000000000a1" ? { ...entry, running: true } : entry));
    const ref = { token: "00000000000000a1", task: "Map the backend" };
    const path = openSubagent([], ref, live, 0);
    expect(openSubagentRunning(path, live, true)).toBe(true);
    // A subagent the session waits on is not at work once the session is not.
    expect(openSubagentRunning(path, live, false)).toBe(false);
    // It reported back since it was opened.
    expect(openSubagentRunning(path, entries, true)).toBe(false);
    // A nested one runs only while its outermost does and it did when opened.
    const nested = openSubagent(path, { token: "c3", task: "Dig", running: true }, [], 0);
    expect(openSubagentRunning(nested, live, true)).toBe(true);
    expect(openSubagentRunning(openSubagent(path, { token: "c3", task: "Dig" }, [], 0), live, true)).toBe(false);
    expect(openSubagentRunning([], live, true)).toBe(false);
  });

  it("keeps a background subagent at work after the session's turn ends", () => {
    const live = entries.map((entry) => (entry.subagent === "00000000000000a1" ? { ...entry, running: true, background: true } : entry));
    const path = openSubagent([], { token: "00000000000000a1", task: "Map the backend" }, live, 0);
    expect(openSubagentRunning(path, live, false)).toBe(true);
    expect(subagentsIn(live)[0]).toMatchObject({ running: true, background: true });
    expect(subagentAtWork({ running: true, background: true }, false)).toBe(true);
    expect(subagentAtWork({ running: true }, false)).toBe(false);
    expect(subagentAtWork({ background: true }, true)).toBe(false);
  });

  it("names a working model by its family", () => {
    expect(workingModelName("claude-haiku-4-5-20251001")).toBe("Haiku");
    expect(workingModelName("claude-opus-4-1-20250805")).toBe("Opus");
    expect(workingModelName("gpt-5-codex")).toBe("gpt-5-codex");
  });

  it("says a subagent's elapsed time and tokens as a spinner does", () => {
    const start = "2026-09-24T10:00:00Z";
    const at = (seconds: number) => Date.parse(start) + seconds * 1000;
    expect(workingElapsed(start, at(45))).toBe("45s");
    expect(workingElapsed(start, at(65))).toBe("1m 5s");
    expect(workingElapsed(start, at(3720))).toBe("1h 2m");
    expect(workingElapsed(start, at(-5))).toBeUndefined();
    expect(workingElapsed(undefined, at(5))).toBeUndefined();
    expect(workingElapsed("not a time", at(5))).toBeUndefined();
    expect(compactTokens(950)).toBe("950");
    expect(compactTokens(12_342)).toBe("12.3k");
    expect(compactTokens(40_000)).toBe("40k");
    expect(compactTokens(1_250_000)).toBe("1.3M");
    expect(compactTokens(0)).toBeUndefined();
    expect(compactTokens(undefined)).toBeUndefined();
    expect(workingModelName(" ")).toBeUndefined();
    expect(workingModelName(undefined)).toBeUndefined();
  });
});

describe(`${BRAND.display} Mobile Reader opens the subagents an agent spawned`, () => {
  beforeEach(() => {
    terminalState.lines = [];
    terminalState.alternate = false;
    FakeWebSocket.instances = [];
    localStorage.clear();
    localStorage.setItem(storageKey("mobile.view.claude-code"), "focus");
    vi.stubGlobal("WebSocket", FakeWebSocket);
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("draws a spawn as a card that opens its conversation, and the bar goes back up", async () => {
    const fetch = subagentFetch();
    vi.stubGlobal("fetch", fetch);
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    const session = screen.getByTestId("session-transcript");
    const card = within(session).getByRole("button", { name: "Subagent: Explore · Map the backend" });
    // One whose CLI has not said where it lives yet is there, but shut.
    const starting = within(session).getByRole("button", { name: "Subagent: Plan · Still starting" }) as HTMLButtonElement;
    expect(starting.disabled).toBe(true);
    // Each says when it started; the one that has reported back wears the ✓.
    expect(card.querySelector(".transcript-time")).not.toBeNull();
    expect(card.querySelector(".agent-status.done")?.textContent).toContain("✓");
    expect(starting.querySelector(".agent-status")).toBeNull();

    fireEvent.click(card);
    await settle();
    expect(fetch.mock.calls.some(([url]) => String(url).includes("subagent=00000000000000a1"))).toBe(true);
    const sub = screen.getByTestId("subagent-transcript");
    within(sub).getByText("Map every backend module");
    within(sub).getByText("The backend is in src-tauri.");
    // Its task reads as the prompt the conversation was given.
    expect(within(sub).getByRole("group", { name: "Its task" }).textContent).toContain("Map every backend module");
    const bar = screen.getByRole("navigation", { name: "Subagent" });
    within(bar).getByText("Map the backend");
    within(bar).getByText("1 of 2");
    expect(screen.queryByTestId("session-transcript")).toBeNull();

    fireEvent.click(within(bar).getByRole("button", { name: "Back to the main conversation" }));
    await settle();
    screen.getByTestId("session-transcript");
    expect(screen.queryByRole("navigation", { name: "Subagent" })).toBeNull();
  });

  it("names an open subagent's own model while it is still at work", async () => {
    const main = { ...MAIN, entries: MAIN.entries.map((entry) => (entry.subagent === "00000000000000a1" ? { ...entry, running: true } : entry)) };
    const own: Record<string, unknown> = { ...SUBAGENTS, "00000000000000a1": { ...(SUBAGENTS["00000000000000a1"] as object), model: "claude-haiku-4-5-20251001", tokens: 12_342 } };
    // 65 s after its spawn entry's stamp.
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-24T10:01:07Z"));
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.endsWith("/outbox")) return Promise.resolve(jsonResponse(200, { files: [] }));
      if (url.includes("/transcript")) {
        const token = new URL(url, "http://phone").searchParams.get("subagent");
        return Promise.resolve(jsonResponse(200, { transcript: token ? own[token] : main }));
      }
      return Promise.resolve(jsonResponse(404, { error: "not_found" }));
    }));
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    // The session at work, as its screen paints it.
    const bytes = new TextEncoder().encode("> look around\n\n✻ Thinking… (9s · esc to interrupt)\n\n> ");
    const payload = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(payload).set(bytes);
    act(() => { FakeWebSocket.instances[0].onmessage?.({ data: payload } as MessageEvent); });
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 200)); });

    fireEvent.click(screen.getByRole("button", { name: "Subagent: Explore · Map the backend" }));
    await settle();
    expect(screen.getByTestId("subagent-working").textContent).toContain("Haiku is working…");
    // How long it has worked and its tokens, as the session's own row says them.
    expect(screen.getByTestId("subagent-working").textContent).toContain("1m 5s · 12.3k tokens");
    // A sibling that has reported back is not at work.
    fireEvent.click(within(screen.getByRole("navigation", { name: "Subagent" })).getByRole("button", { name: "Next subagent" }));
    await settle();
    within(screen.getByTestId("subagent-transcript")).getByText("Tests live beside the code.");
    expect(screen.queryByTestId("subagent-working")).toBeNull();
  });

  it("hides the main conversation's pinned prompt while reading a subagent", async () => {
    vi.stubGlobal("fetch", subagentFetch());
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("readable-output")) return new DOMRect(0, 100, 400, 600);
      return new DOMRect(0, this.dataset.prompt === "look around" ? 20 : 200, 300, 40);
    });
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    const label = "Your prompt for this answer — show it";
    expect(screen.getByRole("button", { name: label }).textContent).toContain("look around");

    fireEvent.click(screen.getByRole("button", { name: "Subagent: Explore · Map the backend" }));
    await settle();
    screen.getByTestId("subagent-transcript");
    expect(screen.queryByRole("button", { name: label })).toBeNull();

    fireEvent.click(within(screen.getByRole("navigation", { name: "Subagent" })).getByRole("button", { name: "Back to the main conversation" }));
    await settle();
    expect(screen.getByRole("button", { name: label }).textContent).toContain("look around");
  });

  it("pins the prompt under the subagent index, which hides what scrolls behind it", async () => {
    vi.stubGlobal("fetch", subagentFetch());
    // The output's top edge at 100; the index sticks over it, 50 tall shut
    // and 300 open. The prompt's bubble is wholly behind the shut index.
    let indexHeight = 50;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("readable-output")) return new DOMRect(0, 100, 400, 600);
      if (this.classList.contains("chat-index")) return new DOMRect(0, 100, 400, indexHeight);
      return new DOMRect(0, this.dataset.prompt === "look around" ? 110 : 500, 300, 40);
    });
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    const pin = screen.getByRole("button", { name: "Your prompt for this answer — show it" });
    expect(pin.textContent).toContain("look around");
    expect(pin.style.top).toBe("56px");

    indexHeight = 300;
    fireEvent.click(within(screen.getByRole("navigation", { name: "Subagents in this conversation" })).getByRole("button", { name: /^Subagents \(3\)/ }));
    expect(screen.getByRole("button", { name: "Your prompt for this answer — show it" }).style.top).toBe("306px");
  });

  it("keeps the session's subagents reachable from the chat header", async () => {
    vi.stubGlobal("fetch", subagentFetch());
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    const index = screen.getByRole("navigation", { name: "Subagents in this conversation" });
    const toggle = within(index).getByRole("button", { name: /^Subagents \(3\)/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect((within(index).getByRole("button", { name: "Plan · Still starting" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(index).getByRole("button", { name: "general-purpose · Find the tests" }));
    await settle();
    within(screen.getByTestId("subagent-transcript")).getByText("Tests live beside the code.");
    expect(screen.queryByRole("navigation", { name: "Subagents in this conversation" })).toBeNull();
    fireEvent.click(within(screen.getByRole("navigation", { name: "Subagent" })).getByRole("button", { name: "Back to the main conversation" }));
    await settle();
    expect(within(screen.getByRole("navigation", { name: "Subagents in this conversation" })).getByRole("button", { name: /^Subagents \(3\)/ }).getAttribute("aria-expanded")).toBe("true");
  });

  it("can fetch older turns from the list when the visible tail has no subagents", async () => {
    const fetch = vi.fn((url: string) => {
      if (url.endsWith("/outbox")) return Promise.resolve(jsonResponse(200, { files: [] }));
      if (url.includes("/transcript")) {
        const expanded = new URL(url, "http://phone").searchParams.get("limit") === "240";
        return Promise.resolve(jsonResponse(200, { transcript: {
          available: true, version: expanded ? "older:2" : "older:1", truncated: !expanded, agentsEarlier: !expanded,
          entries: expanded ? MAIN.entries : MAIN.entries.filter((entry) => entry.kind !== "agent"),
        } }));
      }
      return Promise.resolve(jsonResponse(404, { error: "not_found" }));
    });
    vi.stubGlobal("fetch", fetch);
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    const index = screen.getByRole("navigation", { name: "Subagents in this conversation" });
    fireEvent.click(within(index).getByRole("button", { name: /^Subagents \(0\+\)/ }));
    fireEvent.click(within(index).getByRole("button", { name: "Find subagents in earlier turns" }));
    await settle();
    within(index).getByRole("button", { name: "Explore · Map the backend" });
    expect(fetch.mock.calls.some(([url]) => String(url).includes("limit=240"))).toBe(true);
  });

  it("shows no index for a long session that never spawned a subagent", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.endsWith("/outbox")) return Promise.resolve(jsonResponse(200, { files: [] }));
      if (url.includes("/transcript")) {
        return Promise.resolve(jsonResponse(200, { transcript: {
          available: true, version: "long:1", truncated: true,
          entries: MAIN.entries.filter((entry) => entry.kind !== "agent"),
        } }));
      }
      return Promise.resolve(jsonResponse(404, { error: "not_found" }));
    }));
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    expect(screen.queryByRole("navigation", { name: "Subagents in this conversation" })).toBeNull();
  });

  it("steps to the next subagent without going back, and walks into a subagent's own", async () => {
    vi.stubGlobal("fetch", subagentFetch());
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Subagent: Explore · Map the backend" }));
    await settle();
    const bar = () => screen.getByRole("navigation", { name: "Subagent" });
    expect((within(bar()).getByRole("button", { name: "Previous subagent" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(bar()).getByRole("button", { name: "Next subagent" }));
    await settle();
    within(bar()).getByText("Find the tests");
    within(bar()).getByText("2 of 2");
    within(screen.getByTestId("subagent-transcript")).getByText("Tests live beside the code.");
    fireEvent.click(within(bar()).getByRole("button", { name: "Previous subagent" }));
    await settle();

    // A subagent's own subagent opens one level deeper; the way back names
    // the conversation it came from. One that cannot be read says so.
    fireEvent.click(screen.getByRole("button", { name: "Subagent: Explore · Dig into sync" }));
    await settle();
    within(bar()).getByText("Dig into sync");
    screen.getByText("This subagent’s conversation can’t be read");
    fireEvent.click(within(bar()).getByRole("button", { name: "Back to Map the backend" }));
    await settle();
    within(bar()).getByText("Map the backend");
  });

  it("sends a Claude subagent's words to it alone, and keeps them when its list is not on screen", async () => {
    vi.stubGlobal("fetch", subagentFetch());
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Subagent: Explore · Map the backend" }));
    await settle();
    const field = screen.getByRole("textbox", { name: /message/i });
    expect(field.getAttribute("placeholder")).toBe("Message this subagent…");
    const typed = FakeWebSocket.instances.flatMap((socket) => socket.sent).length;
    fireEvent.change(field, { target: { value: "and the frontend?" } });
    fireEvent.click(screen.getByRole("button", { name: /^send/i }));
    await settle();
    await settle();
    // No Claude agent list on this screen: nothing is typed, the Reader
    // stays on the subagent, and the words come back with the reason.
    expect(FakeWebSocket.instances.flatMap((socket) => socket.sent).length).toBe(typed);
    screen.getByRole("navigation", { name: "Subagent" });
    expect((field as HTMLTextAreaElement).value).toBe("and the frontend?");
    screen.getByText(/Not sent — Claude's agent list did not open this subagent/);
    expect(within(screen.getByTestId("subagent-transcript")).queryByText("and the frontend?")).toBeNull();
  });

  it("goes back to the session when a prompt is sent from a subagent's conversation on another CLI", async () => {
    vi.stubGlobal("fetch", subagentFetch());
    render(<Terminal tab={{ ...TAB, label: "Codex", agent_label: "Codex" }} back={() => {}} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Subagent: Explore · Map the backend" }));
    await settle();
    screen.getByTestId("subagent-transcript");
    const field = screen.getByRole("textbox", { name: /message/i });
    fireEvent.change(field, { target: { value: "and the frontend?" } });
    fireEvent.click(screen.getByRole("button", { name: /^send/i }));
    await settle();
    expect(screen.queryByRole("navigation", { name: "Subagent" })).toBeNull();
    within(screen.getByTestId("session-transcript")).getByText("and the frontend?");
  });
});

describe("a tab card's subagent pill opens a subagent directly", () => {
  beforeEach(() => {
    terminalState.lines = [];
    terminalState.alternate = false;
    FakeWebSocket.instances = [];
    localStorage.clear();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("lists the session's subagents newest first and hands back the one picked", async () => {
    const main = { ...MAIN, entries: MAIN.entries.map((entry) => (entry.subagent === "00000000000000b2" ? { ...entry, running: true } : entry)) };
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(200, { transcript: main }))));
    const onOpen = vi.fn();
    render(<SubagentsSheet tab={{ ...TAB, agent_status: "working", agent_subagents: 1 }} onClose={() => {}} onOpen={onOpen} />);
    await settle();
    const dialog = screen.getByRole("dialog", { name: "Subagents of Claude" });
    // Only the openable ones, newest first; the one at work says so.
    const rows = within(dialog).getAllByRole("button").filter((button) => button.getAttribute("aria-label")?.includes(" · "));
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual(["general-purpose · Find the tests", "Explore · Map the backend"]);
    expect(rows[0].textContent).toContain("at work");
    expect(rows[1].textContent).not.toContain("at work");
    fireEvent.click(rows[1]);
    expect(onOpen).toHaveBeenCalledTimes(1);
    const step = onOpen.mock.calls[0][0];
    expect(step).toMatchObject({ token: "00000000000000a1", task: "Map the backend", role: "Explore", scrollTop: -1, at: "2026-09-24T10:00:02Z" });
    expect(siblingPosition(step)).toEqual({ index: 0, count: 2 });
  });

  it("opens the session in Focus on that subagent, and back lands on the main chat", async () => {
    // The reader's own choice is Terminal; the pick still reads in Focus and
    // leaves that choice alone.
    localStorage.setItem(storageKey("mobile.view.claude-code"), "terminal");
    vi.stubGlobal("fetch", subagentFetch());
    const step = openSubagent([], { token: "00000000000000b2", task: "Find the tests", role: "general-purpose" }, MAIN.entries as TranscriptEntry[], -1)[0];
    render(<Terminal tab={TAB} back={() => {}} subagent={step} />);
    await settle();
    within(screen.getByTestId("subagent-transcript")).getByText("Tests live beside the code.");
    const bar = screen.getByRole("navigation", { name: "Subagent" });
    within(bar).getByText("2 of 2");
    fireEvent.click(within(bar).getByRole("button", { name: "Back to the main conversation" }));
    await settle();
    screen.getByTestId("session-transcript");
    expect(localStorage.getItem(storageKey("mobile.view.claude-code"))).toBe("terminal");
  });
});
