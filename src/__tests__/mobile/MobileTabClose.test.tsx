/**
 * Closing a tab from the phone — agent or shell.
 *
 * Three things have to hold at once. The close must land in the project the
 * PHONE is looking at, which need not be the one the desktop window is showing
 * (`removeTab` writes to the active scope, so a phone close would otherwise
 * drop a tab out of the project on the user's screen). It must reach disk:
 * CenterPanel persists the active scope alone, and the phone's own catalog is
 * read back out of that session file, so an unpersisted close comes back on the
 * next poll. And it must serve a shell tab, which the neighbouring rename and
 * schedule routes deliberately refuse.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

/** Hand the bridge one desktop request and give back what it answered. Matched
 *  by request id rather than "the last answer", because these tests read the
 *  invoke log across several asks (the persist below) instead of clearing it. */
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

describe("removeTabInScope", () => {
  it("closes a tab in a scope that is not the active one, leaving the active scope alone", () => {
    seed("other-scope");
    useTabsStore.getState().removeTabInScope(project.id, "shell-1");
    expect(useTabsStore.getState().tabsByScope[project.id]?.map((t) => t.key)).toEqual(["agent-1"]);
    // The old `removeTab` would have written to whatever was on screen.
    expect(useTabsStore.getState().tabsByScope["other-scope"]).toBeUndefined();
    // The layout follows the payload, so nothing is left naming a dropped tab.
    expect(useTabsStore.getState().layoutByScope[project.id]).toMatchObject({
      tabKeys: ["agent-1"],
      activeKey: "agent-1",
    });
  });

  it("ignores a key the scope does not hold", () => {
    seed("other-scope");
    useTabsStore.getState().removeTabInScope(project.id, "nope");
    expect(useTabsStore.getState().tabsByScope[project.id]).toHaveLength(2);
  });
});

describe("Mobile bridge — closing a tab", () => {
  beforeEach(async () => {
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === "list_agents") return Promise.resolve([]);
      if (command === "agent_schedules_list") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    vi.mocked(listen).mockResolvedValue(() => {});
    useProjectsStore.setState({ projects: [project], activeId: project.id, loaded: true });
    useSettingsStore.setState({ settings: {} as Settings, loaded: true });
    // The desktop is showing a different scope: the phone's project is one the
    // user is not looking at, which is the case the scope argument exists for.
    seed("root");
    render(<MobileBridgeHost />);
    await vi.waitFor(() => expect(vi.mocked(listen).mock.calls.length).toBeGreaterThan(0));
  });

  afterEach(() => {
    cleanup();
    vi.mocked(invoke).mockReset();
    vi.mocked(listen).mockReset();
  });

  it("closes an agent tab and writes the scope's layout back to disk", async () => {
    expect(await ask({ type: "close_tab", request_id: "r1", project_id: project.id, tmux_session: AGENT_TMUX }))
      .toEqual({ status: "closed" });
    expect(useTabsStore.getState().tabsByScope[project.id]?.map((t) => t.key)).toEqual(["shell-1"]);

    const saves = vi.mocked(invoke).mock.calls.filter(([command]) => command === "workspace_sync");
    const saved = saves[saves.length - 1];
    expect(saved).toBeTruthy();
    const payload = saved![1] as { projectId: string; tabs: { label: string }[] };
    expect(payload.projectId).toBe(project.id);
    expect(payload.tabs.map((tab) => tab.label)).toEqual(["Shell"]);
  });

  it("ends a resumable agent's local session, and leaves an attach tab's session alone", async () => {
    useTabsStore.setState((state) => ({
      tabsByScope: {
        ...state.tabsByScope,
        [project.id]: [
          { ...TABS[0], sessionId: "s-1" },
          { ...TABS[1], tmuxSession: undefined, tmuxAttach: SHELL_TMUX },
        ],
      },
    }));
    await ask({ type: "close_tab", request_id: "r5", project_id: project.id, tmux_session: AGENT_TMUX });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("local_tmux_kill", { session: AGENT_TMUX });
    // Opened from the Sessions view onto a session it did not create.
    await ask({ type: "close_tab", request_id: "r6", project_id: project.id, tmux_session: SHELL_TMUX });
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("local_tmux_kill", { session: SHELL_TMUX });
  });

  it("closes a shell tab too — the kind the rename and schedule routes refuse", async () => {
    expect(await ask({ type: "close_tab", request_id: "r2", project_id: project.id, tmux_session: SHELL_TMUX }))
      .toEqual({ status: "closed" });
    expect(useTabsStore.getState().tabsByScope[project.id]?.map((t) => t.key)).toEqual(["agent-1"]);
    // The session the tab minted ends with it, as the desktop's × ends it.
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("local_tmux_kill", { session: SHELL_TMUX });
  });

  it("refuses a tmux name this scope does not hold, and a project with Mobile off", async () => {
    expect(await ask({ type: "close_tab", request_id: "r3", project_id: project.id, tmux_session: `${BRAND.slug}-elsewhere--agent-9` }))
      .toMatchObject({ status: "error", code: "tab_not_found" });

    useProjectsStore.setState({ projects: [{ ...project, [MOBILE_ACCESS_KEY]: false }] });
    expect(await ask({ type: "close_tab", request_id: "r4", project_id: project.id, tmux_session: AGENT_TMUX }))
      .toMatchObject({ status: "error", code: "project_ineligible" });
    expect(useTabsStore.getState().tabsByScope[project.id]).toHaveLength(2);
  });
});

describe("Mobile project screen — the row's ✕", () => {
  const rows = [
    { id: "t-agent", label: "Claude", kind: "agent", available: true, viewer_busy: false },
    { id: "t-shell", label: "Shell", kind: "shell", available: true, viewer_busy: false },
  ];
  let closed: string[] = [];
  /** Rows the catalog grows between polls, so a test can tell a load that has
   *  landed from one that has not yet been asked for. */
  let extra: Record<string, unknown>[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "DELETE") {
      closed.push(url);
      return new Response(JSON.stringify({ closed: true }), { status: 200 });
    }
    if (url.endsWith("/prompts") || url.endsWith("/schedules")) {
      return new Response(JSON.stringify({ prompts: [], schedules: [], time_zone: "", next_runs: {} }), { status: 200 });
    }
    return new Response(JSON.stringify({
      project: { id: "p1", label: "Alpha", status: "active" },
      desktop_available: true,
      agents: [],
      // The desktop persists asynchronously, so the poll deliberately keeps
      // answering with the tab that was just closed.
      tabs: [...rows, ...extra],
    }), { status: 200 });
  });

  /** One poll, driven the way the screen's own visibility handler drives it,
   *  and awaited through a row the catalog only grew after the close — an
   *  assertion about a row that is gone cannot tell "the load landed and it
   *  stayed gone" from "the load has not happened yet". */
  async function poll() {
    extra = [{ id: "t-late", label: "Codex", kind: "agent", available: true, viewer_busy: false }];
    document.dispatchEvent(new Event("visibilitychange"));
    await screen.findByRole("button", { name: "Close Codex" });
  }

  beforeEach(() => {
    closed = [];
    extra = [];
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    fetchMock.mockClear();
  });

  it("closes either kind of tab through its opaque id and drops the row", async () => {
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);

    // One tap, as on the desktop's × — no sheet asks first.
    fireEvent.click(await screen.findByRole("button", { name: "Close Shell" }));
    await waitFor(() => expect(closed).toEqual(["/api/v1/tabs/t-shell"]));
    // Dropped locally rather than re-read: the next poll still lists it.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Close Shell" })).toBeNull());
    expect(screen.queryByRole("dialog")).toBeNull();

    await waitFor(() => expect((screen.getByRole("button", { name: "Close Claude" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Close Claude" }));
    await waitFor(() => expect(closed).toEqual(["/api/v1/tabs/t-shell", "/api/v1/tabs/t-agent"]));
  });

  it("keeps the closed row gone when the next poll is still carrying it", async () => {
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Close Shell" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Close Shell" })).toBeNull());

    // The poll that was already in flight when the ✕ was pressed answers with
    // the pre-close list; the row used to spring back under the reader's thumb.
    await poll();
    expect(screen.queryByRole("button", { name: "Close Shell" })).toBeNull();
    expect(screen.getByRole("button", { name: "Close Claude" })).toBeTruthy();
  });

  it("shows the row again once a close the desktop never carried out is past waiting for", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<Project id="p1" back={() => {}} terminal={() => {}} />);
      fireEvent.click(await screen.findByRole("button", { name: "Close Shell" }));
      await waitFor(() => expect(screen.queryByRole("button", { name: "Close Shell" })).toBeNull());

      // Half a minute on, the catalog still lists it: the close plainly did not
      // take, and a row nobody can see is worse than one that came back.
      await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
      await poll();
      expect(screen.getByRole("button", { name: "Close Shell" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says the desktop is needed rather than 'request failed'", async () => {
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({
      project: { id: "p1", label: "Alpha", status: "active" },
      desktop_available: true, agents: [], tabs: rows,
    }), { status: 200 }));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    const button = await screen.findByRole("button", { name: "Close Claude" });
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ error: "desktop_unavailable" }), { status: 503 }));
    fireEvent.click(button);
    expect(await screen.findByText(`Open desktop ${BRAND.display} to close a tab.`)).toBeTruthy();
    // The tab is still listed, and its ✕ works again.
    await waitFor(() => expect((screen.getByRole("button", { name: "Close Claude" }) as HTMLButtonElement).disabled).toBe(false));
  });
});
