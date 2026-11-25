/**
 * The project's tabs beside a tablet's chat (`ChatTabsRail`, mounted by
 * `Terminal.tsx`; the `Tablet tiers` block of `style.css`): a rail on the left
 * in landscape, open or folded, a strip of chips upright, nothing on a phone.
 * The tier is flipped at runtime as in `MobileTabletChat.test.tsx`, and the
 * chat's own nodes and its one socket must survive that with the rail there.
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
import { readFlag, writeFlag } from "../../../mobile-web/src/prefs";
import { RAIL_WIDE_QUERY, railLayout, railOffered, sameRailTabs } from "../../../mobile-web/src/chatRail";
import { SPLIT_QUERY, TABLET_QUERY } from "../../../mobile-web/src/useTier";
import type { TabRow } from "../../../mobile-web/src/api";
import { BRAND, storageKey } from "../../lib/brand";

const CSS: string = readFileSync("mobile-web/src/style.css", "utf8");
type Tier = "phone" | "tablet" | "split";

/** A window of a tier (and, in landscape, a width over or under 1120 px)
 * whose answers the test changes; listeners hear every change. */
function stubWindow(start: Tier, wide = true) {
  let tier = start;
  let wideNow = wide;
  const listeners = new Set<() => void>();
  const matches = (query: string) => (query === TABLET_QUERY && tier !== "phone")
    || (query === SPLIT_QUERY && tier === "split")
    || (query === RAIL_WIDE_QUERY && tier === "split" && wideNow);
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() { return matches(query); },
    media: query,
    addEventListener: (_type: string, listener: () => void) => { listeners.add(listener); },
    removeEventListener: (_type: string, listener: () => void) => { listeners.delete(listener); },
  }));
  const fire = () => act(() => { [...listeners].forEach((listener) => listener()); });
  return {
    set(next: Tier) { tier = next; fire(); },
    width(next: boolean) { wideNow = next; fire(); },
  };
}

const row = (id: string, label: string, extra: Partial<TabRow> = {}): TabRow => ({ id, label, kind: "agent", available: true, viewer_busy: false, ...extra });
const TABS: TabRow[] = [
  row("t-docs", "Docs pass", { agent_model: "Opus", agent_label: "Claude Code", agent_status: "working", color: "blue" }),
  row("tab", "Claude", { agent_model: "Sonnet", agent_label: "Claude Code" }),
  row("t-ask", "Review", { agent_label: "Codex", agent_status: "question" }),
  row("t-gone", "Old run", { available: false }),
  row("t-sh", "zsh", { kind: "shell" }),
];

let detailTabs: TabRow[] = TABS;
let detailReads = 0;
function host() {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("/api/v1/projects/") && url.split("/").length === 5) {
      detailReads += 1;
      return new Response(JSON.stringify({ project: { id: "p", label: "Alpha", status: "active" }, desktop_available: true, agents: [], tabs: detailTabs, files: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
  });
}

let projectSeq = 0;
/** A fresh project id per mount: the rail remembers the last list per project. */
const freshProject = () => `p${++projectSeq}`;

/** `project: null`: a tab outside any project. */
async function openChat(openTab = vi.fn(), project: string | null = freshProject()) {
  render(<Terminal tab={TABS[1]} project={project ?? undefined} back={() => {}} openTab={openTab} />);
  await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 50)); });
  return openTab;
}

const main = () => document.querySelector("main.terminal-screen") as HTMLElement;
const rail = () => screen.queryByRole("navigation", { name: "Tabs of this project" });

describe(`${BRAND.display} Mobile tabs rail beside the chat`, () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    localStorage.clear();
    detailTabs = TABS;
    detailReads = 0;
    vi.stubGlobal("WebSocket", FakeWebSocket);
    stubTerminalSideChannels();
    vi.stubGlobal("fetch", host());
    localStorage.setItem(storageKey("mobile.view.agent"), "focus");
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("lists the project's tabs in the desktop's order beside a landscape chat, the current one marked", async () => {
    stubWindow("split");
    await openChat();
    const nav = rail() as HTMLElement;
    expect(nav.classList.contains("chat-rail")).toBe(true);
    expect(main().getAttribute("data-rail")).toBe("open");
    // A sibling of the chat's body, under the header.
    expect(nav.parentElement).toBe(main());
    expect(main().querySelector("header")?.nextElementSibling).toBe(nav);
    expect(within(nav).getByRole("heading").textContent).toBe("Tabs · 5");
    const rows = within(nav).getAllByRole("button").filter((button) => button.classList.contains("chat-rail-row"));
    expect(rows.map((button) => button.querySelector(".chat-rail-label")?.textContent)).toEqual(["Docs pass", "Claude", "Review", "Old run", "zsh"]);
    expect(rows[1].getAttribute("aria-current")).toBe("true");
    expect(rows.filter((button) => button.hasAttribute("aria-current"))).toHaveLength(1);
    expect(rows[1].classList.contains("is-current")).toBe(true);
    // The line under the name: the model (else the CLI) and the state in the card's words.
    expect(rows[0].querySelector(".chat-rail-sub")?.textContent).toBe("Opusworking");
    expect(rows[0].querySelector(".tab-card-status.working")).toBeTruthy();
    expect(rows[0].classList.contains("has-tab-color")).toBe(true);
    expect(rows[0].style.getPropertyValue("--tab-color")).not.toBe("");
    // A question carries the asking pill; a shell is a shell session.
    expect(rows[2].querySelector(".chat-rail-sub .agent-status.question")?.textContent).toContain("question");
    expect(rows[4].querySelector(".chat-rail-sub")?.textContent).toBe("Shell session");
    expect(nav.querySelector(".untested")).toBeTruthy();
  });

  it("opens another tab on a tap, does nothing on the current one, and leaves an unavailable one dimmed and untappable", async () => {
    stubWindow("split");
    const openTab = await openChat();
    const nav = rail() as HTMLElement;
    const rowOf = (label: string) => within(nav).getByText(label).closest("button") as HTMLButtonElement;
    fireEvent.click(rowOf("Claude"));
    expect(openTab).not.toHaveBeenCalled();
    expect(rowOf("Old run").disabled).toBe(true);
    fireEvent.click(rowOf("Old run"));
    expect(openTab).not.toHaveBeenCalled();
    fireEvent.click(rowOf("Review"));
    expect(openTab).toHaveBeenCalledTimes(1);
    expect(openTab.mock.calls[0][0]).toMatchObject({ id: "t-ask", label: "Review" });
  });

  it("folds to tiles and back with the fold button, remembering it on this device", async () => {
    stubWindow("split");
    await openChat();
    const fold = within(rail() as HTMLElement).getByRole("button", { name: "Fold the tab list" });
    expect(fold.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(fold);
    expect(readFlag("chatRailFolded")).toBe(true);
    expect(main().getAttribute("data-rail")).toBe("folded");
    const nav = rail() as HTMLElement;
    expect(nav.classList.contains("folded")).toBe(true);
    expect(within(nav).queryByRole("heading")).toBeNull();
    // A tile names the tab and its state; a question tints the tile.
    expect(within(nav).getByRole("button", { name: "Docs pass · working" }).querySelector(".chat-rail-tile")?.textContent).toBe("D");
    expect(within(nav).getByRole("button", { name: "Review · question" }).querySelector(".chat-rail-tile.asking")).toBeTruthy();
    expect(within(nav).getByRole("button", { name: "Claude" }).getAttribute("aria-current")).toBe("true");
    expect(within(nav).getByRole("button", { name: "zsh" }).querySelector(".chat-rail-tile svg")).toBeTruthy();
    fireEvent.click(within(nav).getByRole("button", { name: "Fold the tab list" }));
    expect(readFlag("chatRailFolded")).toBe(false);
    expect(main().getAttribute("data-rail")).toBe("open");
    cleanup();

    // A new chat opens folded where this device left it folded.
    writeFlag("chatRailFolded", true);
    await openChat();
    expect(main().getAttribute("data-rail")).toBe("folded");
    expect(within(rail() as HTMLElement).getByRole("button", { name: "Fold the tab list" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("is always folded under 1120 px, without the fold button and without writing the preference", async () => {
    const window_ = stubWindow("split", false);
    await openChat();
    expect(main().getAttribute("data-rail")).toBe("folded");
    expect(within(rail() as HTMLElement).queryByRole("button", { name: "Fold the tab list" })).toBeNull();
    expect(localStorage.getItem(`${storageKey("mobile.")}chatRailFolded`)).toBeNull();
    window_.width(true);
    expect(main().getAttribute("data-rail")).toBe("open");
  });

  it("is a strip of chips under the header on a portrait tablet, the current chip scrolled into view", async () => {
    stubWindow("tablet");
    await openChat();
    const nav = rail() as HTMLElement;
    expect(nav.classList.contains("chat-strip")).toBe(true);
    expect(main().getAttribute("data-rail")).toBe("strip");
    expect(main().querySelector("header")?.nextElementSibling).toBe(nav);
    const chips = [...nav.querySelectorAll<HTMLButtonElement>(".chat-strip-chip")];
    expect(chips.map((chip) => chip.querySelector(".chat-strip-label")?.textContent)).toEqual(["Docs pass", "Claude", "Review", "Old run", "zsh"]);
    expect(chips[1].getAttribute("aria-current")).toBe("true");
    expect(chips[2].querySelector(".agent-status.question")).toBeTruthy();
    expect(chips[3].disabled).toBe(true);
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
    expect((HTMLElement.prototype.scrollIntoView as ReturnType<typeof vi.fn>).mock.contexts[0]).toBe(chips[1]);
    expect(nav.querySelector(".chat-rail-fold")).toBeNull();
  });

  it("shows nothing on a phone, with one tab, or outside a project", async () => {
    const window_ = stubWindow("phone");
    await openChat();
    expect(rail()).toBeNull();
    expect(main().hasAttribute("data-rail")).toBe(false);
    window_.set("split");
    expect(rail()).toBeTruthy();
    cleanup();

    detailTabs = [TABS[1]];
    await openChat();
    expect(rail()).toBeNull();
    expect(main().hasAttribute("data-rail")).toBe(false);
    cleanup();

    detailTabs = TABS;
    await openChat(vi.fn(), null);
    expect(rail()).toBeNull();
  });

  it("keeps the chat's nodes, the draft and the one socket while the rail comes, folds and turns into the strip", async () => {
    const window_ = stubWindow("phone");
    await openChat();
    const composer = () => main().querySelector(".prompt-composer textarea") as HTMLTextAreaElement;
    fireEvent.change(composer(), { target: { value: "half a thought" } });
    const nodes = { main: main(), header: main().querySelector("header"), body: main().querySelector(".terminal-body"), controls: main().querySelector(".terminal-controls"), field: composer() };
    const same = () => {
      expect(main()).toBe(nodes.main);
      expect(main().querySelector("header")).toBe(nodes.header);
      expect(main().querySelector(".terminal-body")).toBe(nodes.body);
      expect(main().querySelector(".terminal-controls")).toBe(nodes.controls);
      expect(composer()).toBe(nodes.field);
      expect(composer().value).toBe("half a thought");
      expect(FakeWebSocket.instances.length).toBe(1);
      expect(FakeWebSocket.instances[0].closed).toBe(0);
    };
    for (const next of ["split", "tablet", "phone", "tablet", "split"] as Tier[]) {
      window_.set(next);
      same();
    }
    fireEvent.click(within(rail() as HTMLElement).getByRole("button", { name: "Fold the tab list" }));
    same();
    window_.set("tablet");
    same();
  });

  it("keeps the other tabs' states current at the project screen's cadence while the rail shows, and reads nothing more on a phone", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const window_ = stubWindow("split");
    await openChat();
    const reads = detailReads;
    detailTabs = TABS.map((tab) => tab.id === "t-docs" ? { ...tab, agent_status: "question" as const } : tab);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(detailReads).toBe(reads + 1);
    expect(within(rail() as HTMLElement).getByText("Docs pass").closest("button")?.querySelector(".chat-rail-sub .agent-status.question")).toBeTruthy();

    window_.set("phone");
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(detailReads).toBe(reads + 1);
  });
});

describe("the tabs rail's helpers", () => {
  it("offers the rail inside a project from two tabs on, and lays it out per tier", () => {
    expect(railOffered(undefined, TABS)).toBe(false);
    expect(railOffered("p", [TABS[0]])).toBe(false);
    expect(railOffered("p", null)).toBe(false);
    expect(railOffered("p", TABS.slice(0, 2))).toBe(true);
    expect(railLayout("phone", true, false)).toBeUndefined();
    expect(railLayout("tablet", true, true)).toBe("strip");
    expect(railLayout("split", true, false)).toBe("open");
    expect(railLayout("split", true, true)).toBe("folded");
    expect(railLayout("split", false, false)).toBeUndefined();
  });

  it("calls two lists the same only when every drawn field matches", () => {
    expect(sameRailTabs(TABS, TABS.map((tab) => ({ ...tab, prompts: [{ text: "new" }] })))).toBe(true);
    expect(sameRailTabs(TABS, TABS.map((tab, index) => index === 0 ? { ...tab, agent_status: "done" as const } : tab))).toBe(false);
    expect(sameRailTabs(TABS, TABS.slice(1))).toBe(false);
    expect(sameRailTabs(null, TABS)).toBe(false);
  });
});

describe("the tabs rail stylesheet", () => {
  const tabletAt = CSS.indexOf(`@media ${TABLET_QUERY} {`);
  const splitAt = CSS.indexOf(`@media ${SPLIT_QUERY} {`);
  const tablet = CSS.slice(tabletAt, splitAt);
  const split = CSS.slice(splitAt, CSS.indexOf("\n}\n", splitAt));

  it("gives the landscape rail its column under a header across both, 220 px open and 76 px folded, and the strip its own row upright", () => {
    expect(split).toContain('.terminal-screen[data-rail="open"] { grid-template-columns:220px minmax(0,1fr); }');
    expect(split).toContain('.terminal-screen[data-rail="folded"] { grid-template-columns:76px minmax(0,1fr); }');
    expect(split).toContain(".terminal-screen[data-rail] > header { grid-column:1 / -1; grid-row:1; }");
    expect(split).toMatch(/\.terminal-screen\[data-rail\] > \.chat-rail \{ grid-column:1; grid-row:2 \/ span 2; \}/);
    expect(split).toMatch(/\.terminal-screen\[data-rail\] > \.terminal-body \{ grid-column:2;/);
    expect(tablet).toContain('.terminal-screen[data-rail="strip"] { grid-template-rows:auto auto minmax(0,1fr) auto; }');
    // Nothing of the rail outside the two tiers: a phone has none.
    expect(CSS.slice(0, tabletAt)).not.toMatch(/data-rail|chat-rail|chat-strip/);
    expect(tablet).not.toMatch(/data-rail="(open|folded)"/);
  });

  it("draws the rail as the tier's floating panel and its rows with the split list's current background", () => {
    const panel = /\n {2}\.chat-rail \{([^}]*)\}/.exec(split)?.[1] ?? "";
    expect(panel).toContain("border-radius:var(--r-panel)");
    expect(panel).toContain("background:#1a1d2b");
    expect(panel).toContain("box-shadow:var(--soft)");
    expect(panel).toContain("margin:0 0 12px 12px");
    expect(split).toContain(".chat-rail-row.is-current { background:#2e2b48; }");
    expect(split).toContain(".tabbed.split .home-projects > .tab-card.is-current { background:#2e2b48; }");
    expect(split).toMatch(/\.chat-rail-tile \{[^}]*width:48px; height:48px;/);
  });
});
