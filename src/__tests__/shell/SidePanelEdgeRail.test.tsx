/**
 * The closed side panel's edge rail (#267).
 *
 * With the panel closed the edge is the only way in, and it used to lead to one
 * place: Files. These pin the rail's contract — one tab per view the panel's own
 * switcher offers, and an activation that both *stores* that view (so the panel
 * paints it, per #252) and opens the panel. The hover-open is here too (#268):
 * the bar covers the window edge for its whole height, so resting on it opens
 * the panel only after a dwell. Resting on a tab opens the panel on THAT view
 * after the same dwell (#270) — never on some other view, which is what used to
 * unmount the rail out from under a click that had not landed yet.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";

const shared = vi.hoisted(() => ({
  updateSettings: vi.fn().mockResolvedValue(undefined) as ReturnType<typeof vi.fn>,
  settings: { side_panel_view_by_project: { other: "git" } } as Record<string, unknown>,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setFullscreen: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    onCloseRequested: vi.fn().mockResolvedValue(() => {}),
    onResized: vi.fn().mockResolvedValue(() => {}),
    onScaleChanged: vi.fn().mockResolvedValue(() => {}),
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: vi.fn().mockResolvedValue(undefined) }));

vi.mock("../../stores/projects", () => {
  const state = {
    load: vi.fn(),
    loaded: true,
    // A project is active, so the panel has a target and the edge rail mounts.
    activeId: "proj-1",
    rootDir: "/home/u/app/root",
    switchToast: null,
    clearSwitchToast: vi.fn(),
    connToast: null,
    clearConnToast: vi.fn(),
    projects: [],
  };
  return {
    useProjectsStore: Object.assign(
      vi.fn((sel: (s: object) => unknown) => sel(state)),
      { getState: () => state },
    ),
    listenProjectRuntimeSwitched: vi.fn().mockResolvedValue(() => {}),
  };
});
vi.mock("../../stores/settings", () => {
  const state = {
    load: vi.fn(),
    loaded: false,
    get settings() {
      return shared.settings;
    },
    updateSettings: shared.updateSettings,
  };
  return {
    useSettingsStore: Object.assign(
      vi.fn((sel: (s: object) => unknown) => sel(state)),
      { getState: () => state, subscribe: () => () => {} },
    ),
    whenSettingsLoaded: () => Promise.resolve(),
    listenSettingsChanged: () => Promise.resolve(() => {}),
  };
});
vi.mock("../../stores/boxes", () => ({
  useBoxesStore: vi.fn((sel: (s: object) => unknown) =>
    sel({ load: vi.fn().mockResolvedValue(undefined) }),
  ),
  BOX_SCOPE_PREFIX: "box:",
  // The app overlays' docked-agent hook reads the root "+" menu's data.
  boxMembersOfScope: () => [],
}));
vi.mock("../../stores/timer", () => ({
  useTimerStore: vi.fn((sel: (s: object) => unknown) =>
    sel({ init: vi.fn().mockResolvedValue(undefined), flush: vi.fn().mockResolvedValue(undefined) }),
  ),
}));

// The panel itself is not under test here — only the rail that opens it.
vi.mock("../../components/layout/HeaderBar", () => ({ HeaderBar: () => null }));
vi.mock("../../components/layout/CenterPanel", () => ({ CenterPanel: () => null }));
vi.mock("../../components/layout/SidePanel", () => ({
  SidePanel: ({ open }: { open: boolean }) =>
    open ? <div data-testid="side-panel" className="side-panel" /> : null,
}));
// Project-scoped hosts that fetch on mount: with a project active they run
// against the blanket `invoke` mock above and have nothing to do with the rail.
vi.mock("../../components/common/LocalLossDialog", () => ({ LocalLossDialog: () => null }));
vi.mock("../../hooks/useKeyboard", () => ({ useKeyboard: vi.fn() }));

import { AppShell } from "../../components/layout/AppShell";

async function mount() {
  await act(async () => {
    render(<AppShell />);
  });
}

describe("side panel edge rail", () => {
  beforeEach(() => {
    shared.updateSettings.mockClear();
    shared.settings = { side_panel_view_by_project: { other: "git" } };
  });

  it("offers the chevron, one tab per panel view and the side switch while closed", async () => {
    await mount();
    expect(screen.getByTitle("Show the side panel")).toBeTruthy();
    for (const label of ["Files", "Git", "Apps", "Agents"]) {
      expect(screen.getByTitle(`Show the ${label} panel`)).toBeTruthy();
    }
    expect(screen.getByTitle("Move panel to the left edge")).toBeTruthy();
    expect(screen.queryByTestId("side-panel")).toBeNull();
  });

  it("Apps maps to the panel's windows view, not a view of its own", async () => {
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByTitle("Show the Apps panel"));
    });
    expect(shared.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ side_panel_view: "windows" }),
    );
  });

  it("stores the clicked view and opens the panel on it", async () => {
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByTitle("Show the Agents panel"));
    });

    // Both keys: this project's own entry (untouched siblings preserved) and the
    // seed a scope with no entry of its own opens on.
    expect(shared.updateSettings).toHaveBeenCalledWith({
      side_panel_view: "agents",
      side_panel_view_by_project: { other: "git", "proj-1": "agents" },
    });
    expect(screen.getByTestId("side-panel")).toBeTruthy();
    // Opening the panel takes the rail with it, so it can never overlap.
    expect(screen.queryByTitle("Show the Agents panel")).toBeNull();
  });

  it("the chevron opens the panel on its remembered view, storing nothing", async () => {
    await mount();
    await act(async () => {
      fireEvent.pointerDown(screen.getByTitle("Show the side panel"), { button: 0 });
    });
    expect(screen.getByTestId("side-panel")).toBeTruthy();
    const patches = shared.updateSettings.mock.calls.filter(
      (c: unknown[]) => (c[0] as Record<string, unknown>).side_panel_view !== undefined,
    );
    expect(patches).toHaveLength(0);
  });

  it("the side switch moves the panel to the other edge without opening it", async () => {
    await mount();
    await act(async () => {
      fireEvent.pointerDown(screen.getByTitle("Move panel to the left edge"), { button: 0 });
    });
    expect(shared.updateSettings).toHaveBeenCalledWith({ side_panel_edge: "left" });
    expect(screen.queryByTestId("side-panel")).toBeNull();
  });

  it("reserves a gutter of its own instead of overlaying the workspace", async () => {
    await mount();
    const body = document.querySelector(".app-body")!;
    expect(body.className).toContain("rail-docked");
  });

  it("keeps the gutter while the unpinned panel is open, so nothing reflows", async () => {
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByTitle("Show the Agents panel"));
    });
    // The rail itself is gone (the panel covers its strip) but the space it
    // occupies is not released: giving it back would resize every terminal
    // underneath on each hover-open and again on each close.
    expect(screen.queryByTitle("Show the Agents panel")).toBeNull();
    expect(document.querySelector(".app-body")!.className).toContain("rail-docked");
  });

  it("mirrors the gutter to the left edge when the panel docks there", async () => {
    shared.settings = { ...shared.settings, side_panel_edge: "left" };
    await mount();
    const body = document.querySelector(".app-body")!;
    expect(body.className).toContain("rail-docked-left");
    expect(document.querySelector(".side-panel-reveal-rail.left")).toBeTruthy();
  });

  it("resting on a tab hover-opens the panel on that tab's view", async () => {
    vi.useFakeTimers();
    try {
      await mount();
      await act(async () => {
        fireEvent.mouseMove(screen.getByTitle("Show the Agents panel"));
      });
      // Same dwell as the bar: a press that comes first still wins, and both
      // land on the same view, so neither can rob the other.
      expect(screen.queryByTestId("side-panel")).toBeNull();
      expect(shared.updateSettings).not.toHaveBeenCalledWith(
        expect.objectContaining({ side_panel_view: "agents" }),
      );
      await act(async () => {
        vi.advanceTimersByTime(400);
      });
      expect(shared.updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ side_panel_view: "agents" }),
      );
      expect(screen.getByTestId("side-panel")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("crossing one tab on the way to another opens the one the pointer settles on", async () => {
    vi.useFakeTimers();
    try {
      await mount();
      await act(async () => {
        fireEvent.mouseMove(screen.getByTitle("Show the Git panel"));
        vi.advanceTimersByTime(300);
        fireEvent.mouseMove(screen.getByTitle("Show the Agents panel"));
        vi.advanceTimersByTime(300);
      });
      // Git's dwell was restarted for Agents, not left to fire at 400ms.
      expect(screen.queryByTestId("side-panel")).toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(100);
      });
      expect(shared.updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ side_panel_view: "agents" }),
      );
      expect(shared.updateSettings).not.toHaveBeenCalledWith(
        expect.objectContaining({ side_panel_view: "git" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("resting on the side switch neither opens the panel nor moves it", async () => {
    vi.useFakeTimers();
    try {
      await mount();
      await act(async () => {
        fireEvent.mouseMove(screen.getByTitle("Move panel to the left edge"));
        vi.advanceTimersByTime(5000);
      });
      expect(screen.queryByTestId("side-panel")).toBeNull();
      expect(shared.updateSettings).not.toHaveBeenCalledWith(
        expect.objectContaining({ side_panel_edge: "left" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the side switch at the top of the bar, outside the centred group", async () => {
    await mount();
    const rail = document.querySelector(".side-panel-reveal-rail")!;
    const sw = screen.getByTitle("Move panel to the left edge");
    expect(sw.closest(".srr-group")).toBeNull();
    expect(rail.firstElementChild).toBe(sw);
  });

  it("hover-opens once the pointer rests on the bar's empty run", async () => {
    vi.useFakeTimers();
    try {
      await mount();
      const rail = document.querySelector(".side-panel-reveal-rail")!;
      await act(async () => {
        fireEvent.mouseMove(rail);
      });
      // Deliberate, not instant — the dwell is what keeps the tabs clickable.
      expect(screen.queryByTestId("side-panel")).toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(400);
      });
      expect(screen.getByTestId("side-panel")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a pending dwell when the pointer leaves the bar", async () => {
    vi.useFakeTimers();
    try {
      await mount();
      const rail = document.querySelector(".side-panel-reveal-rail")!;
      await act(async () => {
        fireEvent.mouseMove(rail);
        fireEvent.mouseLeave(rail);
        vi.advanceTimersByTime(5000);
      });
      expect(screen.queryByTestId("side-panel")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes a hover-open the pointer walked away from", async () => {
    vi.useFakeTimers();
    try {
      await mount();
      await act(async () => {
        fireEvent.mouseMove(document.querySelector(".side-panel-reveal-rail")!);
        vi.advanceTimersByTime(400);
      });
      expect(screen.getByTestId("side-panel")).toBeTruthy();
      // The pointer left while the panel was still sliding in: it never enters
      // the panel, so the panel's own mouseleave can never close it.
      await act(async () => {
        fireEvent.mouseMove(document.body, { clientX: 10, clientY: 10 });
        vi.advanceTimersByTime(450);
      });
      expect(screen.queryByTestId("side-panel")).toBeNull();
      // And the rail is back for the next approach.
      expect(screen.getByTitle("Show the side panel")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands a hover-open the pointer settled into over to the panel's own enter/leave", async () => {
    vi.useFakeTimers();
    try {
      await mount();
      await act(async () => {
        fireEvent.mouseMove(document.querySelector(".side-panel-reveal-rail")!);
        vi.advanceTimersByTime(400);
      });
      await act(async () => {
        fireEvent.mouseMove(screen.getByTestId("side-panel"), { clientX: 900, clientY: 300 });
        // From here on only the panel's mouseleave closes it — a move elsewhere
        // (a portaled menu opened from the panel lands there too) does not.
        fireEvent.mouseMove(document.body, { clientX: 10, clientY: 10 });
        vi.advanceTimersByTime(5000);
      });
      expect(screen.getByTestId("side-panel")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a click-open alone: it was opened to be looked at", async () => {
    vi.useFakeTimers();
    try {
      await mount();
      await act(async () => {
        fireEvent.pointerDown(screen.getByTitle("Show the Agents panel"), { button: 0 });
      });
      await act(async () => {
        fireEvent.mouseMove(document.body, { clientX: 10, clientY: 10 });
        vi.advanceTimersByTime(5000);
      });
      expect(screen.getByTestId("side-panel")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("commits on the press, so an unmount before the click cannot eat it", async () => {
    await mount();
    // pointerdown alone — no click follows, exactly as when the reveal takes the
    // button away between press and release.
    await act(async () => {
      fireEvent.pointerDown(screen.getByTitle("Show the Agents panel"), { button: 0 });
    });
    expect(shared.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ side_panel_view: "agents" }),
    );
    expect(screen.getByTestId("side-panel")).toBeTruthy();
  });

  it("does not act twice when a press is followed by its own click", async () => {
    await mount();
    const tab = screen.getByTitle("Show the Agents panel");
    await act(async () => {
      fireEvent.pointerDown(tab, { button: 0 });
      fireEvent.click(tab);
    });
    // The hints store writes `hints_seen` through the same mock, so count the
    // view patches rather than every settings write.
    const patches = shared.updateSettings.mock.calls.filter(
      (c: unknown[]) => (c[0] as Record<string, unknown>).side_panel_view !== undefined,
    );
    expect(patches).toHaveLength(1);
  });
});
