/**
 * The window's grouped view strip (`layout/RootViewStrip`): the groups and
 * their order, the three width bands, the feature gates that hide a view (and
 * `openView` refusing it), and the fall-back to Now when a shown view's gate
 * goes off.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn() }));
vi.mock("../../components/cockpit/CockpitViews", () => ({
  CockpitViewBody: ({ view }: { view: string }) => <div data-testid="cockpit-body" data-view={view} />,
}));
vi.mock("../../components/tabs/TabPane", () => ({ TabPane: () => null }));

import { RootOverlayHost } from "../../components/layout/RootOverlay";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore } from "../../stores/tabs";
import { useRootReviewStore } from "../../stores/rootReview";
import { VIEW_GROUPS } from "../../lib/cockpit/views";
import type { Settings } from "../../types";

const ALL = ["now", "projects", "tonight", "mail", "calendar", "todo", "agents", "models", "machines", "root"];
const strip = () => Array.from(document.querySelectorAll<HTMLElement>("[data-root-view]")).map((el) => el.dataset.rootView);
const settings = (patch: Partial<Settings> = {}) =>
  useSettingsStore.setState({ settings: { mail_client: true, ...patch } as Settings });

function frameWidth(px: number) {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(px);
}

beforeEach(() => {
  localStorage.clear();
  settings();
  useRootOverlayStore.setState({ open: false, view: "root" });
  useRootReviewStore.setState({ proposals: [], imports: [], refresh: vi.fn(() => Promise.resolve()) });
  useTabsStore.setState({ tabsByScope: {}, layoutByScope: {}, focusedGroupByScope: {} });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the grouped view strip", () => {
  it("lists the views in the groups' order, a divider between the groups", async () => {
    render(<RootOverlayHost />);
    await act(async () => useRootOverlayStore.getState().openView("now"));
    expect(VIEW_GROUPS.flat()).toEqual(ALL);
    expect(strip()).toEqual(ALL);
    expect(document.querySelectorAll(".root-view-divider")).toHaveLength(3);
    // Wide: icon and label on every tab.
    expect(document.querySelectorAll(".root-view-tab .root-view-icon, .root-view-tab .root-view-star").length).toBe(10);
    expect(screen.getByRole("tab", { name: "Machines" })).toBeTruthy();
  });

  it("a feature switch that is off takes its view out of the strip, and a group left empty its divider", async () => {
    settings({ mail_client: false, calendar_global_app: false, todo_board: false, machines_enabled: false });
    render(<RootOverlayHost />);
    await act(async () => useRootOverlayStore.getState().openView("now"));
    expect(strip()).toEqual(["now", "projects", "tonight", "agents", "models", "root"]);
    expect(document.querySelectorAll(".root-view-divider")).toHaveLength(2);
  });

  it("openView refuses a gated view, and a shown view whose gate goes off falls back to Now", async () => {
    settings({ todo_board: false });
    render(<RootOverlayHost />);
    await act(async () => useRootOverlayStore.getState().openView("todo"));
    expect(useRootOverlayStore.getState().open).toBe(false);

    await act(async () => useRootOverlayStore.getState().openView("calendar"));
    expect(useRootOverlayStore.getState()).toMatchObject({ open: true, view: "calendar" });
    await act(async () => settings({ calendar_global_app: false }));
    expect(useRootOverlayStore.getState()).toMatchObject({ open: true, view: "now" });
  });

  it("Mid band: the window is marked mid and every tab keeps its name for the tooltip", async () => {
    frameWidth(1000);
    render(<RootOverlayHost />);
    await act(async () => useRootOverlayStore.getState().openView("now"));
    expect(document.querySelector(".root-overlay")?.getAttribute("data-band")).toBe("mid");
    expect(strip()).toEqual(ALL);
    expect(screen.getByRole("tab", { name: "Agents" }).getAttribute("title")).toBe("Agents");
  });

  it("Narrow band: the current view's tab and a ▾ that opens the others", async () => {
    frameWidth(700);
    render(<RootOverlayHost />);
    await act(async () => useRootOverlayStore.getState().openView("projects"));
    expect(document.querySelector(".root-overlay")?.getAttribute("data-band")).toBe("narrow");
    expect(strip()).toEqual(["projects"]);
    fireEvent.click(screen.getByRole("button", { name: "More views" }));
    const items = screen.getAllByRole("menuitem").map((el) => el.textContent);
    expect(items).toEqual(["Now", "Projects", "Tonight", "Mail", "Calendar", "To-do", "Agents", "Models", "Machines", "Root"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Machines" }));
    expect(useRootOverlayStore.getState().view).toBe("machines");
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
