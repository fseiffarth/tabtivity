/**
 * Arranging a project's tabs by hand from the phone.
 *
 * The order being rearranged is the desktop's own tab order — the one the
 * catalog publishes and the "native" sort lists — so the drop is a bridge write
 * (`PUT /api/v1/tabs/{id}/order`) and not a phone-local preference. Two things
 * are worth pinning: the move is offered under the manual order alone (the
 * computed orders would spring back the next time an agent worked), and the
 * list rearranges on the gesture and then reconciles with what the desktop
 * answers — including putting the row back when the desktop refuses.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), emit: vi.fn() }));

import { MobileBridgeHost } from "../../components/mobile/MobileBridgeHost";
import { Project } from "../../../mobile-web/src/screens/Project";
import { applyServerOrder, dropSlot, placeBeside } from "../../../mobile-web/src/tabReorder";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import type { ProjectEntry, Settings } from "../../types";
import { BRAND, MOBILE_ACCESS_KEY, NAMES, storageKey } from "../../lib/brand";

const box = (id: string, top: number, bottom: number) => ({ id, top, bottom });

describe("Mobile tab reorder — where a drop lands", () => {
  const rows = [box("a", 0, 100), box("b", 100, 200), box("c", 200, 300)];

  it("reads the side off the row's midline", () => {
    expect(dropSlot(rows, "a", 120)).toEqual({ anchor: "b", place: "before" });
    expect(dropSlot(rows, "a", 180)).toEqual({ anchor: "b", place: "after" });
  });

  it("clamps a drop above the first row and below the last", () => {
    expect(dropSlot(rows, "c", -40)).toEqual({ anchor: "a", place: "before" });
    expect(dropSlot(rows, "a", 900)).toEqual({ anchor: "c", place: "after" });
  });

  it("has no slot over the dragged row itself, or with nothing listed", () => {
    expect(dropSlot(rows, "b", 150)).toBeNull();
    expect(dropSlot([], "b", 150)).toBeNull();
  });

  it("reads a wide screen's two columns left to right, the side off the card's middle", () => {
    const card = (id: string, top: number, left: number) => ({ id, top, bottom: top + 90, left, right: left + 400 });
    // a b / c d / e — the last line holds one card.
    const grid = [card("a", 0, 0), card("b", 0, 410), card("c", 100, 0), card("d", 100, 410), card("e", 200, 0)];
    expect(dropSlot(grid, "a", 40, 700)).toEqual({ anchor: "b", place: "after" });
    expect(dropSlot(grid, "a", 140, 450)).toEqual({ anchor: "d", place: "before" });
    expect(dropSlot(grid, "a", 140, 100)).toEqual({ anchor: "c", place: "before" });
    // In the gap between two lines, the line below; past the last card, after it.
    expect(dropSlot(grid, "a", 95, 300)).toEqual({ anchor: "c", place: "after" });
    expect(dropSlot(grid, "a", 900, 900)).toEqual({ anchor: "e", place: "after" });
    expect(dropSlot(grid, "d", 150, 600)).toBeNull();
  });
});

describe("Mobile tab reorder — the list surgery", () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const idOf = (row: { id: string }) => row.id;
  const ids = (list: { id: string }[]) => list.map(idOf);

  it("drops a row on either side of its anchor", () => {
    expect(ids(placeBeside(rows, idOf, "c", "a", "before"))).toEqual(["c", "a", "b"]);
    expect(ids(placeBeside(rows, idOf, "a", "c", "after"))).toEqual(["b", "c", "a"]);
  });

  it("leaves the list alone when either id is not in it", () => {
    expect(ids(placeBeside(rows, idOf, "a", "gone", "after"))).toEqual(["a", "b", "c"]);
    expect(ids(placeBeside(rows, idOf, "gone", "a", "after"))).toEqual(["a", "b", "c"]);
  });

  it("reconciles with the desktop's answer, keeping rows it does not mention", () => {
    expect(ids(applyServerOrder(rows, idOf, ["c", "b", "a"]))).toEqual(["c", "b", "a"]);
    // A tab opened on the desktop between the drop and the answer follows the
    // ones the answer places rather than disappearing from the screen.
    expect(ids(applyServerOrder([...rows, { id: "new" }], idOf, ["b", "a", "c"]))).toEqual(["b", "a", "c", "new"]);
    // An answer from a catalog that had not caught up leaves the list as the
    // finger left it.
    expect(ids(applyServerOrder(rows, idOf, []))).toEqual(["a", "b", "c"]);
  });
});

describe("Mobile project — arranging tabs by hand", () => {
  const tab = (id: string, label: string) => ({ id, label, kind: "agent", available: true, viewer_busy: false });
  /** The desktop's order, which the fake host rewrites as a move lands. */
  let order = ["t-a", "t-b", "t-c"];
  let moveStatus = 200;
  const moves: { url: string; body: unknown }[] = [];

  const detail = () => new Response(JSON.stringify({
    project: { id: "p1", label: "Alpha", status: "active" },
    desktop_available: true,
    agents: [],
    tabs: order.map((id) => tab(id, id.toUpperCase())),
  }), { status: 200 });

  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/order") && init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { anchor: string; place: "before" | "after" };
      moves.push({ url, body });
      if (moveStatus !== 200) return new Response(JSON.stringify({ error: "desktop_unavailable" }), { status: moveStatus });
      const key = url.slice("/api/v1/tabs/".length, -"/order".length);
      const next = order.filter((id) => id !== key);
      next.splice(next.indexOf(body.anchor) + (body.place === "before" ? 0 : 1), 0, key);
      order = next;
      return new Response(JSON.stringify({ tabs: order }), { status: 200 });
    }
    return detail();
  });

  const listed = (container: HTMLElement) => [...container.querySelectorAll(".tab-card strong")].map((node) => node.textContent);
  const manual = () => fireEvent.change(screen.getByLabelText("Sort tabs"), { target: { value: "native" } });

  beforeEach(() => {
    order = ["t-a", "t-b", "t-c"];
    moveStatus = 200;
    moves.length = 0;
    localStorage.clear();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    fetchMock.mockClear();
  });

  it("offers a grip under the manual order only, and remembers the choice", async () => {
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    await screen.findByText("T-A");
    // The default is the computed triage order, where a dropped row would not
    // stay put — so there is nothing to drag.
    expect(screen.queryByLabelText("Move T-A")).toBeNull();

    manual();
    expect(await screen.findByLabelText("Move T-A")).toBeTruthy();
    expect(localStorage.getItem(storageKey("mobile.projectTabsSort"))).toBe("native");
  });

  it("moves a tab one place from the grip's arrow keys and tells the desktop", async () => {
    const { container } = render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    await screen.findByText("T-A");
    manual();

    fireEvent.keyDown(await screen.findByLabelText("Move T-A"), { key: "ArrowDown" });
    await waitFor(() => expect(moves).toHaveLength(1));
    expect(moves[0].url).toBe("/api/v1/tabs/t-a/order");
    expect(moves[0].body).toEqual({ anchor: "t-b", place: "after" });
    await waitFor(() => expect(listed(container)).toEqual(["T-B", "T-A", "T-C"]));

    // The last row has nowhere below it: no request, and nothing moves.
    fireEvent.keyDown(screen.getByLabelText("Move T-C"), { key: "ArrowDown" });
    await waitFor(() => expect(listed(container)).toEqual(["T-B", "T-A", "T-C"]));
    expect(moves).toHaveLength(1);
  });

  it("puts the row back and says why when the desktop refuses the move", async () => {
    const { container } = render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    await screen.findByText("T-A");
    manual();
    moveStatus = 503;

    fireEvent.keyDown(await screen.findByLabelText("Move T-C"), { key: "ArrowUp" });
    expect(await screen.findByText(new RegExp(String.raw`Open desktop ${BRAND.display} to rearrange tabs`))).toBeTruthy();
    expect(listed(container)).toEqual(["T-A", "T-B", "T-C"]);
  });
});

const project: ProjectEntry = {
  id: "p-mobile",
  name: "Alpha",
  status: "active",
  position: 1,
  local_file: "/projects/alpha/project.json",
  [MOBILE_ACCESS_KEY]: true,
};

const TMUX = (name: string) => `${BRAND.slug}-p-mobile--agent-${name}`;
// Resumable agent tabs: an agent with no `sessionId` is not restorable, so it
// would be dropped by the layout write this test reads back.
const TABS: TabEntry[] = ["one", "two", "three"].map((name, index) => ({
  key: `agent-${index}`,
  label: name,
  kind: "agent",
  cmd: "claude",
  cwd: "/projects/alpha",
  sessionId: `session-${name}`,
  tmuxSession: TMUX(name),
}));

/** Hand the bridge one desktop request and give back what it answered, matched
 *  by request id (the invoke log is read across several asks). */
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

describe("Mobile bridge — moving a tab", () => {
  beforeEach(async () => {
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === "list_agents") return Promise.resolve([]);
      if (command === "agent_schedules_list") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    vi.mocked(listen).mockResolvedValue(() => {});
    useProjectsStore.setState({ projects: [project], activeId: project.id, loaded: true });
    useSettingsStore.setState({ settings: {} as Settings, loaded: true });
    useTabsStore.setState({
      // The desktop is showing another scope: the phone arranges the project it
      // is looking at, not the one on the user's screen.
      scope: "root",
      tabsByScope: { [project.id]: [...TABS] },
      layoutByScope: {
        [project.id]: { type: "group", id: "g1", tabKeys: TABS.map((tab) => tab.key), activeKey: "agent-0" },
      },
      focusedGroupByScope: {},
      detachedGroupsByScope: {},
      tabs: [],
      layout: null,
      focusedGroupId: null,
      activeKey: null,
    });
    render(<MobileBridgeHost />);
    await vi.waitFor(() => expect(vi.mocked(listen).mock.calls.length).toBeGreaterThan(0));
  });

  afterEach(() => {
    cleanup();
    vi.mocked(invoke).mockReset();
    vi.mocked(listen).mockReset();
  });

  const order = () => useTabsStore.getState().tabsByScope[project.id]?.map((tab) => tab.label);

  it("permutes the scope's order and the tab bar with it, and writes it to disk", async () => {
    expect(await ask({
      type: "reorder_tab",
      request_id: "r1",
      project_id: project.id,
      tmux_session: TMUX("three"),
      anchor_tmux_session: TMUX("one"),
      place: "before",
    })).toEqual({ status: "reordered" });
    expect(order()).toEqual(["three", "one", "two"]);
    // Both tabs are in one layout group, so the desktop's tab bar tells the
    // same story rather than drifting from the list the phone reordered.
    expect(useTabsStore.getState().layoutByScope[project.id]).toMatchObject({
      tabKeys: ["agent-2", "agent-0", "agent-1"],
    });
    // The route reads the new order back out of the session file, so the move
    // has to reach it before the answer does.
    const saves = vi.mocked(invoke).mock.calls.filter(([command]) => command === "workspace_sync");
    const payload = saves[saves.length - 1]![1] as { projectId: string; tabs: { label: string }[] };
    expect(payload.projectId).toBe(project.id);
    expect(payload.tabs.map((tab) => tab.label)).toEqual(["three", "one", "two"]);
  });

  it("refuses a tmux name this scope does not hold, and a project with Mobile off", async () => {
    expect(await ask({
      type: "reorder_tab",
      request_id: "r2",
      project_id: project.id,
      tmux_session: TMUX("one"),
      anchor_tmux_session: `${BRAND.slug}-elsewhere--agent-9`,
      place: "after",
    })).toMatchObject({ status: "error", code: "tab_not_found" });
    expect(order()).toEqual(["one", "two", "three"]);

    useProjectsStore.setState({ projects: [{ ...project, [MOBILE_ACCESS_KEY]: false }] });
    expect(await ask({
      type: "reorder_tab",
      request_id: "r3",
      project_id: project.id,
      tmux_session: TMUX("one"),
      anchor_tmux_session: TMUX("two"),
      place: "after",
    })).toMatchObject({ status: "error", code: "project_ineligible" });
    expect(order()).toEqual(["one", "two", "three"]);
  });
});
