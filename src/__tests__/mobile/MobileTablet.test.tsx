/**
 * The iPad layout (`mobile-web/src/useTier.ts`): a tablet tier from 700px and a
 * split tier for landscape. A phone matches neither and must keep every screen
 * it had, so most of what is pinned here is what a tablet adds and that a
 * phone does not get it.
 */
// @ts-expect-error node:fs has no type declarations in this project (no @types/node)
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Project } from "../../../mobile-web/src/screens/Project";
import { Home } from "../../../mobile-web/src/screens/Home";
import { SPLIT_QUERY, TABLET_QUERY, useTier } from "../../../mobile-web/src/useTier";
import { capPrompts } from "../../../mobile-web/src/agentPrompts";
import { effectiveLayout, readChosenLayout, writeLayout } from "../../../mobile-web/src/homeLayout";
import { writeChoice } from "../../../mobile-web/src/prefs";
import { openFileTab } from "../../../mobile-web/src/filesPlace";
import { resetTips } from "../../../mobile-web/src/components/HintMessage";
import { storageKey } from "../../lib/brand";

const CSS: string = readFileSync("mobile-web/src/style.css", "utf8");

type Tier = "phone" | "tablet" | "split";
/** A window of that tier: `matchMedia` answers the tier's own queries. */
function stubTier(tier: Tier) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: (query === TABLET_QUERY && tier !== "phone") || (query === SPLIT_QUERY && tier === "split"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

function TierProbe() {
  return <p>{useTier()}</p>;
}

describe("the tier hook", () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it.each<Tier>(["phone", "tablet", "split"])("reads %s from the two queries", (tier) => {
    stubTier(tier);
    render(<TierProbe />);
    expect(screen.getByText(tier)).toBeTruthy();
  });

  it("is a phone where the browser has no matchMedia", () => {
    vi.stubGlobal("matchMedia", undefined);
    render(<TierProbe />);
    expect(screen.getByText("phone")).toBeTruthy();
  });

  it("keeps its queries and the stylesheet's in step, so a rotated iPad and a phone on its side land where intended", () => {
    expect(CSS).toContain(`@media ${TABLET_QUERY} {`);
    expect(CSS).toContain(`@media ${SPLIT_QUERY} {`);
    // A phone turned on its side (844x390) is no tablet: both tiers need a height.
    expect(TABLET_QUERY).toMatch(/min-height:600px/);
    expect(SPLIT_QUERY).toMatch(/min-height:600px/);
    expect(SPLIT_QUERY).toMatch(/orientation:landscape/);
  });
});

describe("the tablet stylesheet block", () => {
  const start = CSS.indexOf(`@media ${TABLET_QUERY} {`);
  const block = CSS.slice(start);
  const outside = CSS.slice(0, start);

  it("is the last block and invents no colour: every hex it uses is already authored above it, so each theme recolours it", () => {
    expect(start).toBeGreaterThan(0);
    const hexes = [...new Set(block.replace(/\/\*[\s\S]*?\*\//g, "").match(/#[0-9a-fA-F]{6}\b/g) ?? [])];
    expect(hexes.length).toBeGreaterThan(0);
    for (const hex of hexes) expect(outside.toLowerCase(), hex).toContain(hex.toLowerCase());
  });

  it("hides the split tray under every full-window layer the list panel can open, since the panel's z-index 7 sits below the tray's 8", () => {
    // Favorites, in the panel, opens the files library and the file viewer.
    const favorites = readFileSync("mobile-web/src/components/FavoritesPage.tsx", "utf8");
    expect(favorites).toMatch(/<FilesLibrary\b/);
    expect(favorites).toMatch(/<OutboxViewer\b/);
    const hide = /\.tabbed\.split:has\(([^)]*)\) > \.mobile-tabbar \{ visibility:hidden; \}/.exec(block);
    expect(hide).not.toBeNull();
    for (const layer of [".sheet-backdrop", ".files-library", ".outbox-viewer"]) expect(hide?.[1].split(","), layer).toContain(layer);
  });

  it("animates nothing and names no box-shadow transition", () => {
    const code = block.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/@keyframes|animation\s*:|transition\s*:/);
  });
});

describe("Home layout choice", () => {
  beforeEach(() => localStorage.clear());

  it("tells never chosen from chosen list", () => {
    expect(readChosenLayout()).toBeNull();
    writeLayout("list");
    expect(readChosenLayout()).toBe("list");
    writeLayout("grid");
    expect(readChosenLayout()).toBe("grid");
    writeLayout("boxes");
    expect(readChosenLayout()).toBe("boxes");
  });

  it("makes the grid the portrait tablet's default only, never overriding a choice, and the split column a list", () => {
    expect(effectiveLayout(null, "phone")).toBe("list");
    expect(effectiveLayout(null, "tablet")).toBe("grid");
    expect(effectiveLayout(null, "split")).toBe("list");
    expect(effectiveLayout("list", "tablet")).toBe("list");
    expect(effectiveLayout("boxes", "tablet")).toBe("boxes");
    expect(effectiveLayout("grid", "phone")).toBe("grid");
    expect(effectiveLayout("grid", "split")).toBe("list");
  });
});

describe("the prompt cap", () => {
  it("keeps the newest prompt and two older ones on a tablet, the rest behind a control", () => {
    expect(capPrompts(5, { capped: true, hasDraft: false, expanded: false })).toEqual({ shown: 3, hidden: 2 });
    expect(capPrompts(3, { capped: true, hasDraft: false, expanded: false })).toEqual({ shown: 3, hidden: 0 });
    expect(capPrompts(1, { capped: true, hasDraft: false, expanded: false })).toEqual({ shown: 1, hidden: 0 });
  });

  it("counts an unsent draft as the newest entry", () => {
    expect(capPrompts(5, { capped: true, hasDraft: true, expanded: false })).toEqual({ shown: 2, hidden: 3 });
  });

  it("shows everything on a phone or once expanded", () => {
    expect(capPrompts(5, { capped: false, hasDraft: false, expanded: false })).toEqual({ shown: 5, hidden: 0 });
    expect(capPrompts(5, { capped: true, hasDraft: false, expanded: true })).toEqual({ shown: 5, hidden: 0 });
  });
});

const fetchMock = vi.fn();
const prompt = (text: string, minute: number) => ({ text, at: `2026-11-03T22:${String(minute).padStart(2, "0")}:00Z` });
const agent = (id: string, label: string, prompts: { text: string; at: string }[] = []) => ({ id, label, kind: "agent", available: true, viewer_busy: false, prompts });

function serve(tabs: unknown[]) {
  fetchMock.mockImplementation(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/outbox")) return new Response(JSON.stringify({ files: [] }), { status: 200 });
    return new Response(JSON.stringify({
      project: { id: "p1", label: "Alpha", status: "active", live_sessions: tabs.length },
      desktop_available: true,
      tabs,
      agents: [],
    }), { status: 200 });
  });
}

describe("the project screen on a tablet", () => {
  beforeEach(() => {
    localStorage.clear();
    resetTips();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  const openOutboxFile = () => openFileTab("p1", { token: "plan.pdf", name: "plan.pdf", kind: "application/pdf", size: 10, modified: 1, place: "", from: "outbox" });

  it("lists agents, then files, each under a headline with its count; a phone keeps one flat list", async () => {
    openOutboxFile();
    serve([agent("a", "claude 1"), agent("b", "claude 2")]);
    stubTier("tablet");
    const tablet = render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    await screen.findByText("claude 1");
    const heads = [...tablet.container.querySelectorAll("h2.project-group-head")].map((head) => head.textContent);
    expect(heads).toEqual(["Agents2", "Files1"]);
    const order = [...tablet.container.querySelectorAll(".project-group .tab-card")].map((card) => card.classList.contains("file-tab-card") ? "file" : "agent");
    expect(order).toEqual(["agent", "agent", "file"]);
    // The files sit in one group, apart from the agents' grid.
    expect(tablet.container.querySelector(".project-files .file-tab-card")).toBeTruthy();
    expect(tablet.container.querySelector(".project-agents .file-tab-card")).toBeNull();
    tablet.unmount();

    stubTier("phone");
    const phone = render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    await screen.findByText("claude 1");
    expect(phone.container.querySelector(".project-group")).toBeNull();
    expect([...phone.container.querySelectorAll("section.cards > .tab-card")].map((card) => card.classList.contains("file-tab-card") ? "file" : "agent"))
      .toEqual(["agent", "agent", "file"]);
  });

  it("keeps the tabs in their given order within the agents section, grips included", async () => {
    // Grips are drawn under the manual order only.
    writeChoice("projectTabsSort", "native");
    serve([agent("a", "claude 1"), agent("b", "claude 2"), agent("c", "claude 3")]);
    stubTier("tablet");
    const { container } = render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    await screen.findByText("claude 1");
    const labels = [...container.querySelectorAll(".project-agents .tab-card-title strong")].map((node) => node.textContent);
    expect(labels).toEqual(["claude 1", "claude 2", "claude 3"]);
    expect(container.querySelectorAll(".project-agents .tab-card-grip").length).toBe(3);
  });

  it("moves Collected prompts and New tab into the header, with no floating button or row under the cards", async () => {
    serve([agent("a", "claude 1")]);
    stubTier("tablet");
    const { container } = render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    await screen.findByText("claude 1");
    const header = container.querySelector("header") as HTMLElement;
    const newTab = within(header).getByRole("button", { name: "New tab" });
    expect(newTab.classList.contains("primary")).toBe(true);
    expect(container.querySelector(".fab")).toBeNull();
    const prompts = within(header).getByRole("button", { name: "Collected prompts" });
    expect(container.querySelector(".project-foot")).toBeNull();
    fireEvent.click(newTab);
    expect(await screen.findByRole("dialog", { name: "New tab" })).toBeTruthy();
    fireEvent.click(prompts);
    expect(await screen.findByRole("dialog", { name: "Collected prompts" })).toBeTruthy();
  });

  it("keeps the back button except beside Home's list", async () => {
    serve([agent("a", "claude 1")]);
    stubTier("tablet");
    const portrait = render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    await screen.findByText("claude 1");
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    portrait.unmount();
    stubTier("split");
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    await screen.findByText("claude 1");
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });

  it("caps a card's prompts at the newest and two older ones until the earlier ones are asked for", async () => {
    serve([agent("a", "claude 1", [1, 2, 3, 4, 5].map((n) => prompt(`ask ${n}`, n)))]);
    stubTier("tablet");
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    await screen.findByText("claude 1");
    expect(screen.getByText("ask 5")).toBeTruthy();
    expect(screen.getByText("ask 3")).toBeTruthy();
    expect(screen.queryByText("ask 2")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "2 earlier prompts" }));
    expect(screen.getByText("ask 2")).toBeTruthy();
    expect(screen.getByText("ask 1")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /earlier prompt/ })).toBeNull();
  });

  it("lists every prompt on a phone, as before", async () => {
    serve([agent("a", "claude 1", [1, 2, 3, 4, 5].map((n) => prompt(`ask ${n}`, n)))]);
    stubTier("phone");
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    await screen.findByText("claude 1");
    expect(screen.getByText("ask 1")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /earlier prompt/ })).toBeNull();
  });
});

describe("Home on a tablet", () => {
  const projects = [{ id: "p1", label: "Alpha", status: "active", live_sessions: 1 }, { id: "p2", label: "Beta", status: "active", live_sessions: 0 }];
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("/api/v1/alerts")) return new Response(JSON.stringify({ alerts: { enabled: false, items: [] } }), { status: 200 });
      if (url.startsWith("/api/v1/activity")) return new Response(JSON.stringify({ tabs: [], desktop_available: true }), { status: 200 });
      return new Response(JSON.stringify({ projects }), { status: 200 });
    }));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

  const homeProps = { open: () => {}, openTab: () => {}, tabby: () => {}, todo: () => {}, mail: () => {} };

  it("draws the grid by default in portrait without writing a choice, and the list on a phone", async () => {
    stubTier("tablet");
    const tablet = render(<Home {...homeProps} />);
    await screen.findByText("Alpha");
    expect(tablet.container.querySelector(".home-projects-grid")).toBeTruthy();
    expect(localStorage.getItem(storageKey("mobile.projectsGrid"))).toBeNull();
    tablet.unmount();
    stubTier("phone");
    const phone = render(<Home {...homeProps} />);
    await screen.findByText("Alpha");
    expect(phone.container.querySelector(".home-projects-grid")).toBeNull();
  });

  it("never overrides a stored list choice", async () => {
    writeLayout("list");
    stubTier("tablet");
    const { container } = render(<Home {...homeProps} />);
    await screen.findByText("Alpha");
    expect(container.querySelector(".home-projects-grid")).toBeNull();
  });

  it("is a plain list in the split tier whatever was chosen, with no layout button, and marks the chosen project", async () => {
    writeLayout("grid");
    stubTier("split");
    const { container } = render(<Home {...homeProps} selectedId="p2" />);
    await screen.findByText("Alpha");
    expect(container.querySelector(".home-projects-grid")).toBeNull();
    expect(screen.queryByRole("button", { name: "Project list layout" })).toBeNull();
    const current = container.querySelectorAll("[aria-current]");
    expect(current.length).toBe(1);
    expect(current[0].textContent).toContain("Beta");
    expect(container.querySelector(".is-current")).toBeTruthy();
    expect(container.querySelector("main")?.getAttribute("data-steer-pane")).toBe("list");
    await waitFor(() => expect(readChosenLayout()).toBe("grid"));
  });
});
