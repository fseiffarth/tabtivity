/**
 * The side panel's always-present edge rail — VS Code's activity bar.
 *
 * Docked (the default) the rail never unmounts: clicking an icon opens the panel
 * on that view, clicking the icon of the view on show hides it, clicking another
 * switches, and the state is the persisted `side_panel_open` (with the legacy
 * `side_panel_pinned` as its fallback). Auto-hide (`side_panel_auto_hide`) keeps
 * the old overlay: a dwell on the rail opens the panel on the tab's view, a
 * hover-open the pointer walks away from closes again, and a click on the shown
 * view's icon commits a hover-open instead of closing it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";

const shared = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const store = {
    settings: {} as Record<string, unknown>,
    listeners,
    keyboard: null as null | { onToggleSidePanel?: () => void; onSidePanel?: (o: boolean) => void },
  };
  const updateSettings = vi.fn(async (patch: Record<string, unknown>) => {
    store.settings = { ...store.settings, ...patch };
    listeners.forEach((l) => l());
  }) as ReturnType<typeof vi.fn>;
  return { store, updateSettings };
});

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
vi.mock("../../stores/settings", async () => {
  const React = await import("react");
  const state = {
    load: vi.fn(),
    loaded: false,
    get settings() {
      return shared.store.settings;
    },
    updateSettings: shared.updateSettings,
  };
  const subscribe = (l: () => void) => {
    shared.store.listeners.add(l);
    return () => shared.store.listeners.delete(l);
  };
  return {
    useSettingsStore: Object.assign(
      (sel: (s: object) => unknown) =>
        React.useSyncExternalStore(subscribe, () => sel(state)),
      { getState: () => state, subscribe },
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
  SidePanel: (p: {
    open: boolean;
    overlay?: boolean;
    onResizeReset?: () => void;
    onResizeStart?: (e: never) => void;
    onResizeMove?: (e: never) => void;
    onResizeEnd?: (e: never) => void;
  }) =>
    p.open ? (
      <div data-testid="side-panel" className={`side-panel${p.overlay ? " overlay" : ""}`}>
        <div
          data-testid="sash"
          onDoubleClick={p.onResizeReset}
          onPointerDown={p.onResizeStart as never}
          onPointerMove={p.onResizeMove as never}
          onPointerUp={p.onResizeEnd as never}
        />
      </div>
    ) : null,
}));
// Project-scoped hosts that fetch on mount: with a project active they run
// against the blanket `invoke` mock above and have nothing to do with the rail.
vi.mock("../../components/common/LocalLossDialog", () => ({ LocalLossDialog: () => null }));
vi.mock("../../hooks/useKeyboard", () => ({
  useKeyboard: (opts: never) => {
    shared.store.keyboard = opts;
  },
}));

import { AppShell } from "../../components/layout/AppShell";
import { showAssistant, useAssistantViewStore } from "../../stores/assistantView";

async function mount() {
  await act(async () => {
    render(<AppShell />);
  });
}


const reset = (settings: Record<string, unknown> = {}) => {
  shared.updateSettings.mockClear();
  shared.store.settings = { side_panel_view_by_project: { other: "git" }, ...settings };
};
const viewPatches = () =>
  shared.updateSettings.mock.calls.filter(
    (c: unknown[]) => (c[0] as Record<string, unknown>).side_panel_view !== undefined,
  );
const click = (title: string) =>
  act(async () => {
    fireEvent.click(screen.getByTitle(title));
  });

describe("side panel rail — docked (default)", () => {
  beforeEach(() => reset());

  it("offers the chevron, one tab per panel view and the side switch, panel closed", async () => {
    await mount();
    expect(screen.getByTitle("Show the side panel")).toBeTruthy();
    for (const label of ["Files", "Git", "Apps", "Agents"]) {
      expect(screen.getByTitle(`Show the ${label} panel`)).toBeTruthy();
    }
    expect(screen.getByTitle("Move panel to the left edge")).toBeTruthy();
    expect(screen.queryByTestId("side-panel")).toBeNull();
  });

  it("a view icon opens the panel on that view, storing the view and the open state", async () => {
    await mount();
    await click("Show the Agents panel");
    expect(shared.updateSettings).toHaveBeenCalledWith({
      side_panel_view: "agents",
      side_panel_view_by_project: { other: "git", "proj-1": "agents" },
    });
    expect(shared.updateSettings).toHaveBeenCalledWith({ side_panel_open: true });
    expect(screen.getByTestId("side-panel")).toBeTruthy();
  });

  it("Apps maps to the panel's windows view", async () => {
    await mount();
    await click("Show the Apps panel");
    expect(shared.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ side_panel_view: "windows" }),
    );
  });

  it("keeps the rail mounted while the panel is open and marks the shown view", async () => {
    await mount();
    await click("Show the Agents panel");
    const agents = screen.getByTitle("Show the Agents panel");
    expect(agents.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTitle("Show the Git panel").getAttribute("aria-pressed")).toBe("false");
  });

  it("clicking the shown view's icon hides the panel and persists it", async () => {
    await mount();
    await click("Show the Agents panel");
    await click("Show the Agents panel");
    expect(shared.updateSettings).toHaveBeenLastCalledWith({ side_panel_open: false });
    expect(screen.queryByTestId("side-panel")).toBeNull();
  });

  it("another view's icon switches without closing", async () => {
    await mount();
    await click("Show the Agents panel");
    await click("Show the Git panel");
    expect(screen.getByTestId("side-panel")).toBeTruthy();
    expect(shared.store.settings.side_panel_open).toBe(true);
    expect(shared.store.settings.side_panel_view).toBe("git");
  });

  it("the chevron toggles on the remembered view, storing no view", async () => {
    await mount();
    await click("Show the side panel");
    expect(screen.getByTestId("side-panel")).toBeTruthy();
    expect(viewPatches()).toHaveLength(0);
    await click("Hide the side panel");
    expect(screen.queryByTestId("side-panel")).toBeNull();
  });

  it("offers no Tabby tab with the experimental switch off", async () => {
    await mount();
    expect(screen.queryByTitle("Show the Tabby panel")).toBeNull();
  });

  it("with the switch on, Tabby's tab opens the panel on its view", async () => {
    reset({ assistant: true, experimental_explicit: true });
    await mount();
    await click("Show the Tabby panel");
    expect(shared.updateSettings).toHaveBeenCalledWith({
      side_panel_view: "assistant",
      side_panel_view_by_project: { other: "git", "proj-1": "assistant" },
    });
    expect(screen.getByTestId("side-panel")).toBeTruthy();
    expect(screen.getByTitle("Show the Tabby panel").getAttribute("aria-pressed")).toBe("true");
  });

  it("a jump to a Tabby chat opens the panel on Tabby's view", async () => {
    reset({ assistant: true, experimental_explicit: true });
    await mount();
    await act(async () => showAssistant("saved-chat"));
    expect(useAssistantViewStore.getState().selectedKey).toBe("saved-chat");
    expect(shared.store.settings.side_panel_view).toBe("assistant");
    expect(screen.getByTestId("side-panel")).toBeTruthy();
  });

  it("grows the gutter to panel + rail when open and never overlays", async () => {
    await mount();
    const body = () => document.querySelector(".app-body") as HTMLElement;
    expect(body().className).toContain("rail-docked");
    expect(body().style.paddingRight).toBe("");
    await click("Show the Files panel");
    expect(body().className).toContain("right-docked");
    expect(body().style.paddingRight).toContain("280px");
    expect(body().style.paddingRight).toContain("--side-rail-w");
  });

  it("mirrors to the left edge", async () => {
    reset({ side_panel_edge: "left" });
    await mount();
    expect(document.querySelector(".app-body")!.className).toContain("rail-docked-left");
    expect(document.querySelector(".side-panel-reveal-rail.left")).toBeTruthy();
    await click("Show the Files panel");
    expect(
      (document.querySelector(".app-body") as HTMLElement).style.paddingLeft,
    ).toContain("280px");
  });

  it("migrates the legacy pin: pinned and no side_panel_open → open", async () => {
    reset({ side_panel_pinned: true });
    await mount();
    expect(screen.getByTestId("side-panel")).toBeTruthy();
    expect(document.querySelector(".app-body")!.className).toContain("right-docked");
  });

  it("an explicit side_panel_open wins over the legacy pin", async () => {
    reset({ side_panel_pinned: true, side_panel_open: false });
    await mount();
    expect(screen.queryByTestId("side-panel")).toBeNull();
  });

  it("opens nothing by hovering", async () => {
    vi.useFakeTimers();
    try {
      await mount();
      await act(async () => {
        fireEvent.mouseMove(screen.getByTitle("Show the Agents panel"));
        vi.advanceTimersByTime(5000);
      });
      expect(screen.queryByTestId("side-panel")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Ctrl+B (the keyboard hook) toggles the panel", async () => {
    await mount();
    await act(async () => shared.store.keyboard!.onToggleSidePanel!());
    expect(screen.getByTestId("side-panel")).toBeTruthy();
    await act(async () => shared.store.keyboard!.onToggleSidePanel!());
    expect(screen.queryByTestId("side-panel")).toBeNull();
  });

  it("double-clicking the sash resets the width to 280", async () => {
    reset({ side_panel_open: true, side_panel_width: 400 });
    await mount();
    await act(async () => {
      fireEvent.doubleClick(screen.getByTestId("sash"));
    });
    expect(shared.updateSettings).toHaveBeenCalledWith({ side_panel_width: 280 });
  });

  it("the side switch still commits on the press and moves the panel", async () => {
    await mount();
    await act(async () => {
      fireEvent.pointerDown(screen.getByTitle("Move panel to the left edge"), { button: 0 });
    });
    expect(shared.updateSettings).toHaveBeenCalledWith({ side_panel_edge: "left" });
    expect(screen.queryByTestId("side-panel")).toBeNull();
  });

  it("keeps the side switch at the top of the bar, outside the centred group", async () => {
    await mount();
    const rail = document.querySelector(".side-panel-reveal-rail")!;
    const sw = screen.getByTitle("Move panel to the left edge");
    expect(sw.closest(".srr-group")).toBeNull();
    expect(rail.firstElementChild).toBe(sw);
  });

  it("right-click on the rail turns Auto-hide on from its menu", async () => {
    await mount();
    await act(async () => {
      fireEvent.contextMenu(document.querySelector(".side-panel-reveal-rail")!);
    });
    await act(async () => {
      fireEvent.click(screen.getByText(/Auto-hide/));
    });
    expect(shared.updateSettings).toHaveBeenCalledWith({ side_panel_auto_hide: true });
  });
});

describe("side panel rail — auto-hide", () => {
  beforeEach(() => reset({ side_panel_auto_hide: true }));

  it("a click opens the panel as an overlay without storing the open state", async () => {
    await mount();
    await click("Show the Agents panel");
    expect(screen.getByTestId("side-panel").className).toContain("overlay");
    expect(shared.updateSettings).not.toHaveBeenCalledWith({ side_panel_open: true });
    // The overlay does not push the workspace.
    expect(document.querySelector(".app-body")!.className).not.toContain("right-docked");
    expect(document.querySelector(".app-body")!.className).toContain("rail-docked");
  });

  it("resting on a tab hover-opens the panel on that tab's view", async () => {
    vi.useFakeTimers();
    try {
      await mount();
      await act(async () => {
        fireEvent.mouseMove(screen.getByTitle("Show the Agents panel"));
      });
      expect(screen.queryByTestId("side-panel")).toBeNull();
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
      expect(screen.queryByTestId("side-panel")).toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(100);
      });
      expect(viewPatches().map((c) => (c[0] as { side_panel_view: string }).side_panel_view)).toEqual([
        "agents",
      ]);
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
      await act(async () => {
        fireEvent.mouseMove(document.body, { clientX: 10, clientY: 10 });
        vi.advanceTimersByTime(450);
      });
      expect(screen.queryByTestId("side-panel")).toBeNull();
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
        fireEvent.click(screen.getByTitle("Show the Agents panel"));
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

  it("a click on the shown icon of a hover-open commits it instead of closing it", async () => {
    vi.useFakeTimers();
    try {
      await mount();
      await act(async () => {
        fireEvent.mouseMove(screen.getByTitle("Show the Agents panel"));
        vi.advanceTimersByTime(400);
      });
      expect(screen.getByTestId("side-panel")).toBeTruthy();
      await act(async () => {
        fireEvent.click(screen.getByTitle("Show the Agents panel"));
      });
      expect(screen.getByTestId("side-panel")).toBeTruthy();
      // The guard is disarmed: walking away no longer closes it.
      await act(async () => {
        fireEvent.mouseMove(document.body, { clientX: 10, clientY: 10 });
        vi.advanceTimersByTime(5000);
      });
      expect(screen.getByTestId("side-panel")).toBeTruthy();
      // A second click closes it.
      await act(async () => {
        fireEvent.click(screen.getByTitle("Show the Agents panel"));
      });
      expect(screen.queryByTestId("side-panel")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
