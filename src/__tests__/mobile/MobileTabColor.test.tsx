/**
 * Colouring a tab from the phone (#264) — agent or shell.
 *
 * The same three things the neighbouring close has to get right, for the same
 * reasons: the write lands in the project the PHONE is looking at rather than
 * the one the desktop window is showing; it reaches disk, because the catalog
 * the phone re-reads is that session file and `CenterPanel` persists only the
 * active scope; and it serves a shell tab, which the rename and schedule routes
 * deliberately refuse — five look-alike shells is exactly the row a colour is
 * assigned to tell apart.
 *
 * Plus one of its own: only a palette id may be stored. The bridge is reachable
 * without the sidecar route that already validates, and the stored id is
 * substituted straight into the desktop's `--tab-accent`.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), emit: vi.fn() }));

import { MobileBridgeHost } from "../../components/mobile/MobileBridgeHost";
import { Project } from "../../../mobile-web/src/screens/Project";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import type { ProjectEntry, Settings } from "../../types";
import { BRAND, MOBILE_ACCESS_KEY, NAMES } from "../../lib/brand";

const project: ProjectEntry = {
  id: "p-mobile",
  name: "Alpha",
  status: "active",
  position: 1,
  local_file: "/projects/alpha/project.json",
  [MOBILE_ACCESS_KEY]: true,
};

const AGENT_TMUX = `${BRAND.slug}-p-mobile--agent-123456789`;
const SHELL_TMUX = `${BRAND.slug}-p-mobile--shell-123456789`;

const TABS: TabEntry[] = [
  { key: "agent-1", label: "Claude", kind: "agent", cmd: "claude", cwd: "/projects/alpha", tmuxSession: AGENT_TMUX },
  { key: "shell-1", label: "Shell", kind: "shell", cmd: "bash", cwd: "/projects/alpha", tmuxSession: SHELL_TMUX },
];

async function ask(request: Record<string, unknown>) {
  const listener = vi.mocked(listen).mock.calls.find(([name]) => name === NAMES.mobileDesktopEvent);
  const deliver = listener![1] as (event: { payload: unknown }) => void;
  const answer = () => vi.mocked(invoke).mock.calls.find(([command, args]) =>
    command === "mobile_desktop_respond"
    && (args as { requestId: string }).requestId === request.request_id);
  deliver({ payload: request });
  await vi.waitFor(() => expect(answer()).toBeTruthy());
  return (answer()![1] as { response: { status: string } }).response;
}

function seed(activeScope: string) {
  useTabsStore.setState({
    scope: activeScope,
    tabsByScope: { [project.id]: [...TABS] },
    layoutByScope: {
      [project.id]: { type: "group", id: "g1", tabKeys: ["agent-1", "shell-1"], activeKey: "agent-1" },
    },
    focusedGroupByScope: {},
    detachedGroupsByScope: {},
    tabs: activeScope === project.id ? [...TABS] : [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
  });
}

const colorOf = (key: string) =>
  useTabsStore.getState().tabsByScope[project.id]?.find((t) => t.key === key)?.color;

describe("Mobile bridge — colouring a tab", () => {
  beforeEach(async () => {
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === "list_agents") return Promise.resolve([]);
      if (command === "agent_schedules_list") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    vi.mocked(listen).mockResolvedValue(() => {});
    useProjectsStore.setState({ projects: [project], activeId: project.id, loaded: true });
    useSettingsStore.setState({ settings: {} as Settings, loaded: true });
    // The desktop is showing a different scope, which is the case the scoped
    // write exists for.
    seed("root");
    render(<MobileBridgeHost />);
    await vi.waitFor(() => expect(vi.mocked(listen).mock.calls.length).toBeGreaterThan(0));
  });

  afterEach(() => {
    cleanup();
    vi.mocked(invoke).mockReset();
    vi.mocked(listen).mockReset();
  });

  it("paints a tab of a scope the desktop is not showing", async () => {
    expect(await ask({ type: "color_tab", request_id: "c1", project_id: project.id, tmux_session: AGENT_TMUX, color: "teal" }))
      .toEqual({ status: "colored", color: "teal" });
    expect(colorOf("agent-1")).toBe("teal");
    // The scope on screen is untouched — a plain `setTabColor` would have
    // written there.
    expect(useTabsStore.getState().tabsByScope.root).toBeUndefined();
  });

  it("paints a shell tab — the kind the rename route refuses — and writes it to disk", async () => {
    expect(await ask({ type: "color_tab", request_id: "c2", project_id: project.id, tmux_session: SHELL_TMUX, color: "red" }))
      .toEqual({ status: "colored", color: "red" });
    expect(colorOf("shell-1")).toBe("red");

    const saves = vi.mocked(invoke).mock.calls.filter(([command]) => command === "workspace_sync");
    const payload = saves[saves.length - 1]![1] as { projectId: string; tabs: { label: string; color?: string }[] };
    expect(payload.projectId).toBe(project.id);
    // Persisted, or the catalog the phone re-reads (out of this same session
    // file) would keep publishing the old colour and a relaunch would undo it.
    // The shell is the tab to read it off: the agent here carries no sessionId,
    // so it is not a restorable tab and never reaches the file at all.
    expect(payload.tabs.find((tab) => tab.label === "Shell")?.color).toBe("red");
  });

  it("a rename, too, reaches disk before the phone is answered", async () => {
    // A restorable agent tab (a sessionId), so it is in the file at all.
    useTabsStore.setState((s) => ({
      tabsByScope: { ...s.tabsByScope, [project.id]: s.tabsByScope[project.id].map((t) => (t.key === "agent-1" ? { ...t, sessionId: "uid-1" } : t)) },
    }));
    expect(await ask({ type: "rename_tab", request_id: "r1", project_id: project.id, tmux_session: AGENT_TMUX, label: "Renamed" }))
      .toEqual({ status: "renamed", label: "Renamed" });
    // The sidecar answers the phone out of the session file: a save after the
    // answer left the phone showing the old label until the next poll.
    const calls = vi.mocked(invoke).mock.calls;
    const saved = calls.findIndex(([command, args]) =>
      command === "workspace_sync"
      && (args as { tabs: { label: string }[] }).tabs.some((tab) => tab.label === "Renamed"));
    const answered = calls.findIndex(([command, args]) =>
      command === "mobile_desktop_respond" && (args as { requestId: string }).requestId === "r1");
    expect(saved).toBeGreaterThanOrEqual(0);
    expect(saved).toBeLessThan(answered);
  });

  it("clears a colour on a null or absent field", async () => {
    await ask({ type: "color_tab", request_id: "c3", project_id: project.id, tmux_session: AGENT_TMUX, color: "green" });
    expect(await ask({ type: "color_tab", request_id: "c4", project_id: project.id, tmux_session: AGENT_TMUX, color: null }))
      .toEqual({ status: "colored", color: null });
    expect(colorOf("agent-1")).toBeUndefined();

    await ask({ type: "color_tab", request_id: "c5", project_id: project.id, tmux_session: AGENT_TMUX, color: "green" });
    expect(await ask({ type: "color_tab", request_id: "c6", project_id: project.id, tmux_session: AGENT_TMUX }))
      .toEqual({ status: "colored", color: null });
    expect(colorOf("agent-1")).toBeUndefined();
  });

  it("refuses an id outside the palette rather than storing it or clearing", async () => {
    await ask({ type: "color_tab", request_id: "c7", project_id: project.id, tmux_session: AGENT_TMUX, color: "teal" });
    for (const color of ["chartreuse", "#ff0000", "red; background:url(x)", "Red"]) {
      expect(await ask({ type: "color_tab", request_id: `bad-${color}`, project_id: project.id, tmux_session: AGENT_TMUX, color }))
        .toMatchObject({ status: "error", code: "invalid_color" });
    }
    // The colour it already had is still there — a refusal is not a clear.
    expect(colorOf("agent-1")).toBe("teal");
  });

  it("refuses a tmux name this scope does not hold, and a project with Mobile off", async () => {
    expect(await ask({ type: "color_tab", request_id: "c8", project_id: project.id, tmux_session: `${BRAND.slug}-elsewhere--agent-9`, color: "blue" }))
      .toMatchObject({ status: "error", code: "tab_not_found" });

    useProjectsStore.setState({ projects: [{ ...project, [MOBILE_ACCESS_KEY]: false }] });
    expect(await ask({ type: "color_tab", request_id: "c9", project_id: project.id, tmux_session: AGENT_TMUX, color: "blue" }))
      .toMatchObject({ status: "error", code: "project_ineligible" });
    expect(colorOf("agent-1")).toBeUndefined();
  });
});

describe("Mobile project screen — the row's colour dot", () => {
  const rows = [
    { id: "t-agent", label: "Claude", kind: "agent", available: true, viewer_busy: false },
    { id: "t-shell", label: "Shell", kind: "shell", available: true, viewer_busy: false, color: "red" },
  ];
  let sent: { url: string; body: unknown }[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "PUT" && url.endsWith("/color")) {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ color: JSON.parse(String(init.body)).color }), { status: 200 });
    }
    if (url.endsWith("/prompts") || url.endsWith("/schedules")) {
      return new Response(JSON.stringify({ prompts: [], schedules: [], time_zone: "", next_runs: {} }), { status: 200 });
    }
    return new Response(JSON.stringify({
      project: { id: "p1", label: "Alpha", status: "active" },
      desktop_available: true,
      agents: [],
      // As with the close, the poll keeps answering the pre-write state: the
      // desktop persists asynchronously, so the screen must not depend on it.
      tabs: rows,
    }), { status: 200 });
  });

  beforeEach(() => {
    sent = [];
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    fetchMock.mockClear();
  });

  it("is offered on either kind of tab, and a published colour marks the card", async () => {
    const { container } = render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    expect(await screen.findByRole("button", { name: "Colour Claude" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Colour Shell" })).toBeTruthy();
    const cards = container.querySelectorAll(".tab-card");
    // Only the tab the catalog published a colour for.
    expect(cards[0].classList.contains("has-tab-color")).toBe(false);
    expect(cards[1].classList.contains("has-tab-color")).toBe(true);
    expect(cards[1].getAttribute("style")).toContain("#d9556b");
  });

  it("sends the palette id, marks the chip, and paints the card without a reload", async () => {
    const { container } = render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Colour Claude" }));
    fireEvent.click(screen.getByRole("button", { name: "Teal" }));

    await waitFor(() => expect(sent).toEqual([{ url: "/api/v1/tabs/t-agent/color", body: { color: "teal" } }]));
    // The sheet stays open on the colour it landed on, so a second hue is one
    // more tap rather than another trip through the card's actions.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Teal" }).getAttribute("aria-pressed")).toBe("true"));
    expect(screen.getByRole("dialog", { name: "Colour Claude" })).toBeTruthy();
    // Patched locally: the poll still answers with the uncoloured row.
    await waitFor(() =>
      expect(container.querySelectorAll(".tab-card")[0].classList.contains("has-tab-color")).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "None" }));
    await waitFor(() => expect(sent[1]).toEqual({ url: "/api/v1/tabs/t-agent/color", body: { color: null } }));
    await waitFor(() =>
      expect(container.querySelectorAll(".tab-card")[0].classList.contains("has-tab-color")).toBe(false));
  });

  it("says the desktop is needed rather than 'request failed'", async () => {
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Colour Claude" }));
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ error: "desktop_unavailable" }), { status: 503 }));
    fireEvent.click(screen.getByRole("button", { name: "Blue" }));
    expect((await screen.findByRole("alert")).textContent).toBe(`Open desktop ${BRAND.display} to colour a tab.`);
    // The sheet stays up, still showing the colour the tab actually has.
    expect(screen.getByRole("button", { name: "None" }).getAttribute("aria-pressed")).toBe("true");
  });
});
