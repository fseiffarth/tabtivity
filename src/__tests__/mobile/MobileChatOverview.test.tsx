/**
 * The session overview on the right of a landscape iPad's chat
 * (`ChatOverview`, mounted by `Terminal.tsx`; the split block of `style.css`):
 * open by default, its sections only when they hold something, the chips and
 * the header's queue and sent-files pills gone while it stands there, the
 * files library in the same pane (the tabs rail folding meanwhile), a shell's
 * pane the library alone, and a portrait iPad and a phone unchanged. The tier
 * is flipped at runtime as in `MobileTabletChat.test.tsx`.
 */
// @ts-expect-error node:fs has no type declarations in this project (no @types/node)
import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubTerminalSideChannels } from "../helpers/mobileTerminalHost";

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    modes = { bracketedPasteMode: false };
    textarea = document.createElement("textarea");
    buffer = { active: { length: 0, getLine: () => undefined } };
    loadAddon() {}
    open() {}
    write(_value: Uint8Array, callback?: () => void) { callback?.(); }
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
import { ChatOverview } from "../../../mobile-web/src/components/ChatOverview";
import { readFlag, readOverviewPane, writeFlag } from "../../../mobile-web/src/prefs";
import { RAIL_WIDE_QUERY } from "../../../mobile-web/src/chatRail";
import { SPLIT_QUERY, TABLET_QUERY } from "../../../mobile-web/src/useTier";
import type { OutboxFile, TabRow, TranscriptEntry } from "../../../mobile-web/src/api";
import { BRAND, storageKey } from "../../lib/brand";

const CSS: string = readFileSync("mobile-web/src/style.css", "utf8");
type Tier = "phone" | "tablet" | "split";

function stubWindow(start: Tier) {
  let tier = start;
  const listeners = new Set<() => void>();
  const matches = (query: string) => (query === TABLET_QUERY && tier !== "phone")
    || (query === SPLIT_QUERY && tier === "split")
    || (query === RAIL_WIDE_QUERY && tier === "split");
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

const secs = (iso: string) => Date.parse(iso) / 1000;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const TAB: TabRow = { id: "tab", label: "Claude", kind: "agent", agent_label: "Claude Code", available: true, viewer_busy: false };
const SHELL: TabRow = { id: "sh", label: "zsh", kind: "shell", available: true, viewer_busy: false };
const OTHER: TabRow = { id: "t-docs", label: "Docs pass", kind: "agent", agent_label: "Claude Code", available: true, viewer_busy: false };

const agent = (text: string, at: string, extra: Partial<TranscriptEntry> = {}): TranscriptEntry => ({ kind: "agent", role: "Explore", text, subagent: `sub-${text.length}${at.slice(-3, -1)}`, at, ...extra });
/** A busy session: one subagent at work in the background, four that reported
 * back, five files the agent sent from this tab and a link. */
const FULL = {
  available: true,
  version: "1:1",
  truncated: false,
  entries: [
    { kind: "prompt", text: "map the repo", at: "2026-10-04T10:00:00Z" },
    agent("Map the backend", "2026-10-04T10:00:01Z", { finished: true }),
    agent("Map the frontend", "2026-10-04T10:00:02Z", { finished: true }),
    agent("Map the docs", "2026-10-04T10:00:03Z", { finished: true }),
    agent("Map the tests", "2026-10-04T10:00:04Z", { finished: true }),
    agent("Watch the build", "2026-10-04T10:00:05Z", { running: true, background: true }),
    { kind: "answer", text: "Done. See [the plan](https://example.com/plan).", at: "2026-10-04T10:05:00Z" },
  ],
};
// Newest first, as the sidecar lists them.
const SENT: OutboxFile[] = [5, 4, 3, 2, 1].map((n) => ({ name: `plot-${n}.png`, kind: "image/png", size: 1_000 * n, modified: secs(`2026-10-04T10:0${n}:30Z`), from_tab: true }));
const EMPTY = { available: true, version: "1:1", truncated: false, entries: [{ kind: "prompt", text: "hello", at: "2026-10-04T10:00:00Z" }, { kind: "answer", text: "Hi.", at: "2026-10-04T10:00:05Z" }] };

let projectSeq = 0;
function host({ transcript = FULL, outbox = SENT, tabs = [TAB, OTHER], files = true }: { transcript?: unknown; outbox?: OutboxFile[]; tabs?: TabRow[]; files?: boolean } = {}) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (/^\/api\/v1\/projects\/[^/]+$/.test(url)) return json({ project: { id: "p", label: "Alpha", status: "active" }, desktop_available: true, agents: [], tabs, files });
    if (/^\/api\/v1\/projects\/[^/]+\/files$/.test(url)) return json({ entries: [{ token: "tok-src", name: "src", kind: "dir", size: 0, modified: 1_770_000_000 }], truncated: false });
    if (url.includes("/inbox?names=")) return json({ files: [] });
    if (url.endsWith("/outbox")) return json({ files: outbox });
    if (url.includes("/transcript")) return json({ transcript });
    return json({ error: "not_found" }, 404);
  });
}

const settle = () => act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 50)); });
async function openChat(tab: TabRow = TAB, openTab = vi.fn()) {
  render(<Terminal tab={tab} project={`p${++projectSeq}`} back={() => {}} openTab={openTab} />);
  await settle();
  await settle();
}

const main = () => document.querySelector("main.terminal-screen") as HTMLElement;
const header = () => main().querySelector("header") as HTMLElement;
const overview = () => screen.queryByRole("complementary", { name: "Session overview" });
const paneButton = () => header().querySelector(".drawer-open") as HTMLButtonElement;
const sectionTitles = () => [...(overview() as HTMLElement).querySelectorAll(".chat-overview-section")].map((section) => section.getAttribute("aria-label"));

describe(`${BRAND.display} Mobile session overview beside the iPad chat`, () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    localStorage.clear();
    localStorage.setItem(storageKey("mobile.view.claude-code"), "focus");
    vi.stubGlobal("WebSocket", FakeWebSocket);
    stubTerminalSideChannels();
    vi.stubGlobal("fetch", host());
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("opens beside a landscape chat by default, under the header, with the sections that hold something", async () => {
    stubWindow("split");
    await openChat();
    const pane = overview() as HTMLElement;
    expect(pane).toBeTruthy();
    expect(pane.parentElement).toBe(main());
    expect(main().getAttribute("data-overview")).toBe("overview");
    expect(paneButton().getAttribute("aria-pressed")).toBe("true");
    expect(pane.querySelector(".untested")).toBeTruthy();
    // No queue: no Prompt queue section.
    expect(sectionTitles()).toEqual(["Subagents (5)", "Files (5)", "Files from the agent (5)", "Links (1)"]);

    // Running first, then the newest three finished, with a Show all.
    const agents = within(pane).getByRole("region", { name: "Subagents (5)" });
    expect(within(agents).getByRole("region", { name: "Running (1)" }).textContent).toContain("Watch the build");
    const finished = within(agents).getByRole("region", { name: "Finished (4)" });
    const finishedRows = () => [...finished.querySelectorAll("button.has-status > small + span")].map((span) => span.textContent);
    expect(finishedRows()).toEqual(["Map the frontend", "Map the docs", "Map the tests"]);
    fireEvent.click(within(finished).getByRole("button", { name: "Show all (4)" }));
    expect(finishedRows()).toEqual(["Map the backend", "Map the frontend", "Map the docs", "Map the tests"]);

    // Files: the newest four, then all of them in place.
    const files = within(pane).getByRole("region", { name: "Files (5)" });
    expect(files.querySelectorAll(".sent-index-list li")).toHaveLength(4);
    fireEvent.click(within(files).getByRole("button", { name: "Show all (5)" }));
    expect(files.querySelectorAll(".sent-index-list li")).toHaveLength(5);
    expect(within(files).getByRole("button", { name: "Project files" })).toBeTruthy();

    // Sent: three gallery tiles; Show all is the gallery itself.
    const sent = within(pane).getByRole("region", { name: "Files from the agent (5)" });
    expect(sent.querySelectorAll(".outbox-gallery-grid .outbox-entry")).toHaveLength(3);
    expect(within(sent).getByRole("button", { name: "Open plot-5.png" })).toBeTruthy();
    fireEvent.click(within(sent).getByRole("button", { name: "Show all (5)" }));
    expect(screen.getByRole("dialog", { name: "Files from the agent" }).classList.contains("outbox-gallery")).toBe(true);
  });

  it("opens a file row in the chat's own viewer", async () => {
    stubWindow("split");
    await openChat();
    const files = within(overview() as HTMLElement).getByRole("region", { name: "Files (5)" });
    fireEvent.click(within(files).getByRole("button", { name: "Open plot-5.png · From the agent" }));
    expect(screen.getByRole("dialog", { name: "plot-5.png" }).classList.contains("outbox-viewer")).toBe(true);
  });

  it("hides the transcript's chips while it is open and gives them back when it closes, counting the running subagents on its button", async () => {
    stubWindow("split");
    await openChat();
    expect(main().querySelector(".chat-index")).toBeNull();
    // The landscape header keeps the model and Chat | Terminal, not the queue or the sent files.
    expect(header().querySelector(".header-queue")).toBeNull();
    expect(header().querySelector(".terminal-gallery")).toBeNull();
    expect(header().querySelector(".header-model")).toBeTruthy();
    expect(within(header()).getByRole("group", { name: "Output view" })).toBeTruthy();
    expect(paneButton().querySelector(".header-count")).toBeNull();

    fireEvent.click(paneButton());
    expect(overview()).toBeNull();
    expect(main().hasAttribute("data-overview")).toBe(false);
    expect(readFlag("chatOverviewPane")).toBe(false);
    expect(main().querySelector(".chat-index")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Subagents in this conversation" })).toBeTruthy();
    // Still no pills: the pane's button stands for them, with the work in progress.
    expect(header().querySelector(".header-queue, .terminal-gallery")).toBeNull();
    expect(paneButton().getAttribute("aria-pressed")).toBe("false");
    expect(paneButton().querySelector(".header-count")?.textContent).toBe("1");
    expect(paneButton().getAttribute("aria-label")).toBe("Show or hide the session overview (1 subagents running)");

    fireEvent.click(paneButton());
    expect(overview()).toBeTruthy();
    expect(readFlag("chatOverviewPane")).toBe(true);
  });

  it("says so in one line when the session holds nothing, and keeps the way into the project files", async () => {
    vi.stubGlobal("fetch", host({ transcript: EMPTY, outbox: [] }));
    stubWindow("split");
    await openChat();
    const pane = overview() as HTMLElement;
    expect(pane.querySelectorAll(".chat-overview-section")).toHaveLength(0);
    expect(pane.querySelector(".chat-overview-empty")?.textContent).toBe("Nothing in this session yet: no subagents, files or links.");
    expect(within(pane).getByRole("button", { name: "Project files" })).toBeTruthy();
    cleanup();

    // Without the desktop's "Project files on the phone" switch there is no way in.
    vi.stubGlobal("fetch", host({ transcript: EMPTY, outbox: [], files: false }));
    await openChat();
    expect(within(overview() as HTMLElement).queryByRole("button", { name: "Project files" })).toBeNull();
  });

  it("switches to the library and back, the tabs rail folding meanwhile without writing its preference", async () => {
    stubWindow("split");
    await openChat();
    expect(main().getAttribute("data-rail")).toBe("open");
    fireEvent.click(within(overview() as HTMLElement).getByRole("button", { name: "Project files" }));
    expect(main().getAttribute("data-overview")).toBe("library");
    const library = await screen.findByRole("dialog", { name: "Files" });
    expect(library.getAttribute("aria-modal")).toBe("false");
    expect(await within(library).findByRole("button", { name: "Open the folder src" })).toBeTruthy();
    // The pane is only its way back now; the rail is tiles, with no fold button.
    const pane = overview() as HTMLElement;
    expect(pane.querySelector(".chat-overview-body")).toBeNull();
    expect(main().getAttribute("data-rail")).toBe("folded");
    const rail = screen.getByRole("navigation", { name: "Tabs of this project" });
    expect(rail.classList.contains("folded")).toBe(true);
    expect(within(rail).queryByRole("button", { name: "Fold the tab list" })).toBeNull();
    expect(localStorage.getItem(storageKey("mobile.chatRailFolded"))).toBeNull();

    fireEvent.click(within(pane).getByRole("button", { name: "Back to the session overview" }));
    expect(screen.queryByRole("dialog", { name: "Files" })).toBeNull();
    expect(main().getAttribute("data-overview")).toBe("overview");
    expect(main().getAttribute("data-rail")).toBe("open");
    expect(readFlag("chatRailFolded")).toBe(false);
  });

  it("gives a shell tab the library alone behind the same button", async () => {
    vi.stubGlobal("fetch", host({ tabs: [SHELL, TAB] }));
    stubWindow("split");
    await openChat(SHELL);
    expect(overview()).toBeNull();
    expect(main().getAttribute("data-overview")).toBe("library");
    const button = within(header()).getByRole("button", { name: "Show or hide files" });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.querySelector("svg rect")).toBeTruthy();
    expect(await screen.findByRole("dialog", { name: "Files" })).toBeTruthy();
    fireEvent.click(button);
    expect(screen.queryByRole("dialog", { name: "Files" })).toBeNull();
    expect(main().hasAttribute("data-overview")).toBe(false);
    expect(readFlag("chatOverviewPane")).toBe(false);
  });

  it("keeps the portrait iPad's and the phone's header, chips and drawer as they were, and the chat's socket and draft through every turn", async () => {
    const window_ = stubWindow("tablet");
    await openChat();
    const field = screen.getByRole("textbox", { name: "Message agent" }) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "half a thought" } });
    const nodes = { main: main(), field, output: screen.getByRole("region", { name: "Session output" }) };
    const same = () => {
      expect(main()).toBe(nodes.main);
      expect(screen.getByRole("textbox", { name: "Message agent" })).toBe(nodes.field);
      expect(nodes.field.value).toBe("half a thought");
      expect(screen.getByRole("region", { name: "Session output" })).toBe(nodes.output);
      expect(FakeWebSocket.instances.length).toBe(1);
      expect(FakeWebSocket.instances[0].closed).toBe(0);
    };
    const portraitHeader = () => {
      expect(overview()).toBeNull();
      expect(main().hasAttribute("data-overview")).toBe(false);
      expect(main().querySelector(".chat-index")).toBeTruthy();
      expect(header().querySelector(".terminal-gallery")).toBeTruthy();
      expect(within(header()).getByRole("button", { name: "Project menu" }).getAttribute("aria-haspopup")).toBe("dialog");
    };
    portraitHeader();
    expect(header().querySelector(".header-queue")).toBeTruthy();

    for (const next of ["split", "tablet", "phone", "split", "phone"] as Tier[]) {
      window_.set(next);
      same();
      if (next === "split") expect(overview()).toBeTruthy();
      else portraitHeader();
    }
    // A phone has no header pills at all.
    expect(header().querySelector(".header-queue, .header-model")).toBeNull();
  });
});

describe("the session overview's own lists", () => {
  afterEach(cleanup);
  const base = {
    mode: "overview" as const, onBack: () => {}, tabId: "tab", project: "p", agents: [], earlierAgents: 0, agentsEarlier: false, busy: false,
    onOpenAgent: () => {}, onEarlier: () => {}, queued: 0, queueOpen: false, onQueue: () => {}, files: [], filesMore: false,
    onOpenFile: () => {}, onRemoveFile: async () => {}, sent: [], sentScope: { tab: "tab" }, onOpenSent: () => {}, onSentDetails: () => {},
    onGallery: () => {}, links: [], onOpenLink: () => {},
  };

  it("shows the queue only with queued prompts, a row that opens its sheet", () => {
    const onQueue = vi.fn();
    const { rerender } = render(<ChatOverview {...base} onQueue={onQueue} />);
    expect(screen.queryByRole("region", { name: "Prompt queue" })).toBeNull();
    rerender(<ChatOverview {...base} queued={2} onQueue={onQueue} />);
    const row = within(screen.getByRole("region", { name: "Prompt queue" })).getByRole("button", { name: "Prompt queue: 2 queued" });
    expect(row.textContent).toBe("2 queued");
    expect(row.getAttribute("aria-haspopup")).toBe("dialog");
    fireEvent.click(row);
    expect(onQueue).toHaveBeenCalledTimes(1);
  });

  it("lists the newest four links and the rest in place, each opening through the chat's link sheet", () => {
    const onOpenLink = vi.fn();
    const links = [1, 2, 3, 4, 5, 6].map((n) => ({ url: `https://example.com/${n}`, host: "example.com", rest: `/${n}`, from: "agent" as const }));
    render(<ChatOverview {...base} links={links} onOpenLink={onOpenLink} />);
    const section = screen.getByRole("region", { name: "Links (6)" });
    expect(section.querySelectorAll(".chat-link-index-list li")).toHaveLength(4);
    fireEvent.click(within(section).getByRole("button", { name: "Show all (6)" }));
    expect(section.querySelectorAll(".chat-link-index-list li")).toHaveLength(6);
    fireEvent.click(within(section).getByText("example.com/1").closest("button") as HTMLButtonElement);
    expect(onOpenLink).toHaveBeenCalledWith("https://example.com/1");
  });

  it("is only its way back over the library or a file", () => {
    const onBack = vi.fn();
    render(<ChatOverview {...base} mode="library" onBack={onBack} queued={3} />);
    const pane = screen.getByRole("complementary", { name: "Session overview" });
    expect(pane.querySelector(".chat-overview-section")).toBeNull();
    fireEvent.click(within(pane).getByRole("button", { name: "Back to the session overview" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe("the session overview stylesheet", () => {
  const split = CSS.slice(CSS.indexOf(`@media ${SPLIT_QUERY} {`));
  const portrait = CSS.slice(CSS.indexOf(`@media ${TABLET_QUERY} {`), CSS.indexOf(`@media ${SPLIT_QUERY} {`));

  it("gives the pane a third column under the header in landscape only: 308px panels for the overview, 400px for the library, 480px for a file, 12px off the edge", () => {
    expect(split).toContain(".terminal-screen[data-overview] { --overview-col:320px;");
    expect(split).toContain('.terminal-screen[data-overview="library"] { --overview-col:412px; }');
    expect(split).toContain('.terminal-screen[data-overview="file"] { --overview-col:492px; }');
    expect(split).toContain('.terminal-screen[data-rail="open"][data-overview] { grid-template-columns:220px minmax(0,1fr) var(--overview-col); }');
    expect(split).toContain('.terminal-screen[data-rail="folded"][data-overview] { grid-template-columns:76px minmax(0,1fr) var(--overview-col); }');
    expect(split).toContain(".terminal-screen[data-overview] > header { grid-column:1 / -1; grid-row:1; }");
    expect(split).toContain(".terminal-screen[data-overview] > .chat-overview { grid-column:-2 / -1; grid-row:2 / span 2; }");
    expect(split).toMatch(/\.chat-overview \{[^}]*margin:0 12px 12px 0;[^}]*border-radius:var\(--r-panel\);[^}]*background:#1a1d2b;[^}]*box-shadow:var\(--soft\)/);
    expect(portrait).not.toContain("chat-overview");
    expect(portrait).not.toContain("data-overview");
  });

  it("animates no shadow in the pane", () => {
    const rules = split.split("\n").filter((line) => line.includes("chat-overview"));
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) expect(rule).not.toMatch(/transition|animation/);
  });
});

// The flag the pane reads: unset it is open; the retired files pane's choice
// is read once in its place.
describe("the pane's flag", () => {
  beforeEach(() => localStorage.clear());
  it("reads chatOverviewPane, on unset, with chatFilesPane as its one-time fallback", () => {
    expect(readOverviewPane()).toBe(true);
    expect(readFlag("chatOverviewPane")).toBe(true);
    localStorage.clear();
    writeFlag("chatFilesPane", false);
    expect(readOverviewPane()).toBe(false);
    expect(readFlag("chatOverviewPane", true)).toBe(false);
    // From then on the new flag answers alone.
    writeFlag("chatFilesPane", true);
    expect(readOverviewPane()).toBe(false);
  });
});
