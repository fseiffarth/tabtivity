/**
 * The split tier (`App.tsx`, landscape tablet): Home's list stays mounted on
 * the left while the chosen project fills the right. Pinned here: the route is
 * the same `projectView` (selecting keeps Home and marks the row), the project
 * screen has no way back of its own, the Back gesture (and steering's Back)
 * deselects it, tapping Projects again deselects, a portrait tablet and a phone still swap
 * Home for the project, and keyboard steering walks the pane it is on.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasPairedDevice, resumeAuth } from "../../../mobile-web/src/auth";
import { hasLocalUnlock } from "../../../mobile-web/src/localLock";

vi.mock("../../../mobile-web/src/auth", () => ({
  hasPairedDevice: vi.fn(async () => true),
  resumeAuth: vi.fn(),
  logoutAuth: vi.fn(async () => undefined),
  pair: vi.fn(),
  finishOidcReturn: vi.fn(async () => null),
}));
vi.mock("../../../mobile-web/src/localLock", () => ({ hasLocalUnlock: vi.fn(async () => true) }));
vi.mock("../../../mobile-web/src/screens/LocalUnlock", () => ({ LocalUnlock: () => <div>lock</div> }));
vi.mock("../../../mobile-web/src/screens/Terminal", () => ({ Terminal: () => <div>terminal</div> }));
vi.mock("../../../mobile-web/src/screens/Pair", () => ({ noteOidcOutcome: () => undefined, Pair: () => <div>pair</div> }));

import { App } from "../../../mobile-web/src/App";
import { BackNest, canGoBack } from "../../../mobile-web/src/backStack";
import { Home } from "../../../mobile-web/src/screens/Home";
import { Project } from "../../../mobile-web/src/screens/Project";
import { getSteering } from "../../../mobile-web/src/steering/steeringState";
import { usePhoneSteering, type SteeringBase } from "../../../mobile-web/src/steering/usePhoneSteering";
import { SPLIT_QUERY, TABLET_QUERY } from "../../../mobile-web/src/useTier";
import { press as fire, resetSteering, stubLayout } from "../helpers/mobileSteering";
import { storageKey } from "../../lib/brand";

const fetchMock = vi.fn();
const projects = [{ id: "p1", label: "Alpha", status: "active", live_sessions: 1 }, { id: "p2", label: "Beta", status: "active", live_sessions: 0 }];
const tabRow = (id: string) => ({ id, label: id, kind: "agent", available: true, viewer_busy: false });

function serve() {
  fetchMock.mockImplementation(async (input: string | URL | Request) => {
    const url = String(input);
    const detail = /^\/api\/v1\/projects\/(p\d)$/.exec(url);
    if (detail) {
      const project = projects.find((row) => row.id === detail[1]);
      return new Response(JSON.stringify({ project, desktop_available: true, tabs: [tabRow(`${detail[1]}-a`), tabRow(`${detail[1]}-b`)], agents: [] }), { status: 200 });
    }
    if (url.endsWith("/outbox")) return new Response(JSON.stringify({ files: [] }), { status: 200 });
    if (url.startsWith("/api/v1/projects")) return new Response(JSON.stringify({ projects }), { status: 200 });
    if (url.startsWith("/api/v1/alerts")) return new Response(JSON.stringify({ alerts: { enabled: false, items: [] } }), { status: 200 });
    if (url.startsWith("/api/v1/activity")) return new Response(JSON.stringify({ tabs: [], desktop_available: true }), { status: 200 });
    return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
  });
}

function stubTier(tier: "phone" | "tablet" | "split") {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: (query === TABLET_QUERY && tier !== "phone") || (query === SPLIT_QUERY && tier === "split"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  serve();
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(resumeAuth).mockReset();
  vi.mocked(resumeAuth).mockResolvedValue({ kind: "paired" });
  vi.mocked(hasPairedDevice).mockResolvedValue(true);
  vi.mocked(hasLocalUnlock).mockResolvedValue(true);
  // A reload moments after an unlock carries on without asking again.
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([{ type: "reload" } as PerformanceNavigationTiming]);
  sessionStorage.setItem(storageKey("mobile.reloadGrace"), String(Date.now() - 1_000));
  vi.spyOn(window.history, "pushState").mockImplementation(() => {});
  // What a browser does on Back: pops the guard entry and tells the page.
  vi.spyOn(window.history, "back").mockImplementation(() => { queueMicrotask(() => window.dispatchEvent(new PopStateEvent("popstate"))); });
});

afterEach(() => {
  cleanup();
  resetSteering();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The Back gesture: the browser pops an entry and tells the page. */
const pressBack = () => { act(() => { window.dispatchEvent(new PopStateEvent("popstate")); }); };
const projectScreen = () => document.querySelector("main.project-screen");
const homeRow = (name: string) => screen.getByText(name, { selector: "strong" }).closest("button") as HTMLButtonElement;

describe("split routing", () => {
  it("keeps Home on the left and marks the chosen project, with a quiet empty state before any", async () => {
    stubTier("split");
    render(<App />);
    await screen.findByText("Alpha", { selector: "strong" });
    expect(screen.getByText("Choose a project")).toBeTruthy();
    expect(projectScreen()).toBeNull();
    expect(document.querySelector(".tabbed")?.classList.contains("split")).toBe(true);

    fireEvent.click(homeRow("Alpha"));
    await waitFor(() => expect(projectScreen()).toBeTruthy());
    expect(screen.queryByText("Choose a project")).toBeNull();
    expect(homeRow("Alpha").getAttribute("aria-current")).toBe("true");
    expect(homeRow("Beta").hasAttribute("aria-current")).toBe(false);
    // The project screen has no back button of its own here.
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();

    // Another project replaces the pane, not a stale copy of the first.
    fireEvent.click(homeRow("Beta"));
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Beta" })).toBeTruthy());
    expect(homeRow("Beta").getAttribute("aria-current")).toBe("true");
    expect(homeRow("Alpha").hasAttribute("aria-current")).toBe(false);
    expect(await screen.findByText("p2-a")).toBeTruthy();
  });

  it("offers no Back of its own for the chosen project, but the Back gesture deselects it; Projects in the tray does too", async () => {
    stubTier("split");
    render(<App />);
    await screen.findByText("Alpha", { selector: "strong" });
    // No project chosen: Back is Home's, which leaves the app.
    expect(canGoBack()).toBe(false);
    fireEvent.click(homeRow("Alpha"));
    await waitFor(() => expect(projectScreen()).toBeTruthy());
    expect(canGoBack()).toBe(true);
    pressBack();
    await waitFor(() => expect(projectScreen()).toBeNull());
    expect(screen.getByText("Choose a project")).toBeTruthy();
    expect(homeRow("Alpha").hasAttribute("aria-current")).toBe(false);
    expect(canGoBack()).toBe(false);

    fireEvent.click(homeRow("Alpha"));
    await waitFor(() => expect(projectScreen()).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Projects" }));
    await waitFor(() => expect(projectScreen()).toBeNull());
    expect(screen.getByText("Choose a project")).toBeTruthy();
    expect(homeRow("Alpha").hasAttribute("aria-current")).toBe(false);
  });

  it("Back closes a sheet first and keeps the project; the next Back deselects it", async () => {
    stubTier("split");
    render(<App />);
    await screen.findByText("Alpha", { selector: "strong" });
    fireEvent.click(homeRow("Alpha"));
    await waitFor(() => expect(projectScreen()).toBeTruthy());
    fireEvent.click(await screen.findByRole("button", { name: "New tab" }));
    expect(await screen.findByRole("dialog", { name: "New tab" })).toBeTruthy();
    pressBack();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New tab" })).toBeNull());
    expect(projectScreen()).toBeTruthy();
    expect(homeRow("Alpha").getAttribute("aria-current")).toBe("true");
    pressBack();
    await waitFor(() => expect(projectScreen()).toBeNull());
  });

  it("leaves the split for the other sections: they take the whole window", async () => {
    stubTier("split");
    render(<App />);
    await screen.findByText("Alpha", { selector: "strong" });
    fireEvent.click(screen.getByRole("button", { name: "To-do" }));
    await waitFor(() => expect(document.querySelector(".home-screen")).toBeNull());
    expect(document.querySelector(".tabbed")?.classList.contains("split")).toBe(false);
    expect(canGoBack()).toBe(true);
  });

  it.each(["tablet", "phone"] as const)("on a %s the project still replaces Home and has its Back", async (tier) => {
    stubTier(tier);
    render(<App />);
    await screen.findByText("Alpha", { selector: "strong" });
    expect(screen.queryByText("Choose a project")).toBeNull();
    fireEvent.click(homeRow("Alpha"));
    await waitFor(() => expect(projectScreen()).toBeTruthy());
    expect(document.querySelector(".home-screen")).toBeNull();
    expect(document.querySelector(".tabbed")?.classList.contains("split")).toBe(false);
    expect(canGoBack()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByText("Alpha", { selector: "strong" });
    expect(projectScreen()).toBeNull();
  });
});

describe("split keyboard steering", () => {
  let layout: ReturnType<typeof stubLayout>;
  beforeEach(() => {
    layout = stubLayout();
    stubTier("split");
  });
  afterEach(() => layout.restore());

  function Harness({ base }: { base: SteeringBase }) {
    usePhoneSteering({
      enabled: true,
      base,
      sectionLabel: null,
      place: { kind: "list", section: "projects", projectId: base === "tabs" ? "p1" : null },
      openTab: () => {},
      openSection: () => {},
      restore: () => {},
      findProject: () => {},
    });
    return null;
  }

  async function mountSplit(base: SteeringBase) {
    const view = render(<div className="tabbed split">
      <BackNest>
        <Home open={() => {}} openTab={() => {}} tabby={() => {}} todo={() => {}} mail={() => {}} selectedId="p1" />
        <Project id="p1" back={() => {}} terminal={() => {}} />
      </BackNest>
      <Harness base={base} />
    </div>);
    await screen.findByText("p1-b");
    await screen.findByText("Beta", { selector: "strong" });
    return view;
  }
  const press = (key: string, mods: { shift?: boolean } = {}) => act(() => { fire(null, key, mods); });
  const stepRows = () => [...document.querySelectorAll<HTMLElement>(".home-project-card [data-steer-row]")];
  const tabRows = () => [...document.querySelectorAll<HTMLElement>(".tab-card-open")];

  it("walks the open project's cards, not the project list, at the tabs level", async () => {
    await mountSplit("tabs");
    press(" ", { shift: true });
    expect(getSteering().active).toBe(true);
    expect(document.activeElement).toBe(tabRows()[0]);
    press("ArrowDown");
    expect(document.activeElement).toBe(tabRows()[1]);
    press("ArrowDown");
    expect(document.activeElement).toBe(tabRows()[0]);
  });

  it("N at the tabs level opens the project's New tab, not Home's New project beside it", async () => {
    await mountSplit("tabs");
    press(" ", { shift: true });
    press("n");
    expect(await screen.findByRole("dialog", { name: "New tab" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "New project" })).toBeNull();
  });

  /** A tab of the open project that also stands in Home's Needs you: the same
   * row id in both panes. */
  function serveNeedsYou(tabId: string) {
    const base = fetchMock.getMockImplementation() as (input: string | URL | Request) => Promise<Response>;
    fetchMock.mockImplementation(async (input: string | URL | Request) => String(input).startsWith("/api/v1/activity")
      ? new Response(JSON.stringify({ tabs: [{ ...tabRow(tabId), project_id: "p1", project_label: "Alpha", agent_status: "question" }], desktop_available: true }), { status: 200 })
      : base(input));
  }
  const needsRow = (id: string) => document.querySelector<HTMLElement>(`[data-steer-pane='list'] [data-steer-row='${id}']`);

  it("keeps the remembered card in the project pane when the same tab stands in Needs you", async () => {
    serveNeedsYou("p1-b");
    await mountSplit("tabs");
    await waitFor(() => expect(needsRow("p1-b")).toBeTruthy());
    press(" ", { shift: true });
    press("ArrowDown");
    expect(document.activeElement).toBe(tabRows()[1]);
    // Leave, let focus drop to the page, come back: the cursor returns to the card.
    press(" ", { shift: true });
    act(() => { (document.activeElement as HTMLElement).blur(); });
    press(" ", { shift: true });
    expect(document.activeElement).toBe(tabRows()[1]);
  });

  it("the menu key opens the menu of the card the cursor is on, though Needs you holds the same tab", async () => {
    serveNeedsYou("p1-b");
    await mountSplit("tabs");
    await waitFor(() => expect(needsRow("p1-b")).toBeTruthy());
    press(" ", { shift: true });
    press("ArrowDown");
    expect(document.activeElement).toBe(tabRows()[1]);
    press(".");
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("walks the project list at the projects level, leaving the cards alone", async () => {
    await mountSplit("projects");
    press(" ", { shift: true });
    expect(stepRows().length).toBe(2);
    expect(document.activeElement).toBe(stepRows()[0]);
    press("ArrowDown");
    expect(document.activeElement).toBe(stepRows()[1]);
    press("ArrowDown");
    expect(document.activeElement).toBe(stepRows()[0]);
  });
});

describe("split Back with keyboard steering", () => {
  let layout: ReturnType<typeof stubLayout>;
  beforeEach(() => { layout = stubLayout(); stubTier("split"); });
  afterEach(() => layout.restore());

  it("steering's Back from the tabs level empties the project pane and lands the cursor on the project just left", async () => {
    render(<App />);
    await screen.findByText("Alpha", { selector: "strong" });
    fireEvent.click(homeRow("Beta"));
    await screen.findByText("p2-a");
    act(() => { fire(null, " ", { shift: true }); });
    expect(getSteering().active).toBe(true);
    act(() => { fire(null, "ArrowLeft"); });
    await waitFor(() => expect(projectScreen()).toBeNull());
    expect(screen.getByText("Choose a project")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(homeRow("Beta")));
    // Now at the projects level, the cursor walks the list.
    act(() => { fire(null, "ArrowUp"); });
    expect(document.activeElement).toBe(homeRow("Alpha"));
  });
});

/** A window whose tier the test turns: `matchMedia` answers the two queries
 * and tells its listeners when the answer changes. */
function tierWindow(start: "phone" | "tablet" | "split") {
  let tier = start;
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() { return (query === TABLET_QUERY && tier !== "phone") || (query === SPLIT_QUERY && tier === "split"); },
    media: query,
    addEventListener: (_type: string, listener: () => void) => { listeners.add(listener); },
    removeEventListener: (_type: string, listener: () => void) => { listeners.delete(listener); },
  }));
  return { set(next: "phone" | "tablet" | "split") { tier = next; act(() => { [...listeners].forEach((listener) => listener()); }); } };
}

describe("a turn of the iPad does not remount Home or the project", () => {
  const homeMain = () => document.querySelector("main.home-screen");

  it("keeps Home while no project is chosen, in every tier", async () => {
    const win = tierWindow("phone");
    render(<App />);
    await screen.findByText("Alpha", { selector: "strong" });
    const home = homeMain();
    expect(home).toBeTruthy();
    for (const next of ["tablet", "split", "tablet", "phone", "split", "phone"] as const) {
      win.set(next);
      expect(homeMain()).toBe(home);
    }
  });

  it("keeps the chosen project, with its open sheet, as Home comes and goes beside it", async () => {
    const win = tierWindow("phone");
    render(<App />);
    await screen.findByText("Alpha", { selector: "strong" });
    fireEvent.click(homeRow("Alpha"));
    await waitFor(() => expect(projectScreen()).toBeTruthy());
    expect(homeMain()).toBeNull();
    const project = projectScreen();
    await screen.findByText("p1-a");
    fireEvent.click(await screen.findByRole("button", { name: "New tab" }));
    const sheet = await screen.findByRole("dialog", { name: "New tab" });

    win.set("split");
    expect(projectScreen()).toBe(project);
    expect(screen.getByRole("dialog", { name: "New tab" })).toBe(sheet);
    expect(homeMain()).toBeTruthy();
    expect(document.querySelector(".split-detail")).toBeNull();

    win.set("tablet");
    expect(projectScreen()).toBe(project);
    expect(screen.getByRole("dialog", { name: "New tab" })).toBe(sheet);
    expect(homeMain()).toBeNull();

    win.set("split");
    expect(projectScreen()).toBe(project);
    expect(homeMain()).toBeTruthy();
    win.set("phone");
    expect(projectScreen()).toBe(project);
    expect(screen.getByRole("dialog", { name: "New tab" })).toBe(sheet);
    expect(homeMain()).toBeNull();
  });
});
