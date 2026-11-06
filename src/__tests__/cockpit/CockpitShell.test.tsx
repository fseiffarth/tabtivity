/**
 * The merged window's shell (`docs/cockpit_root_merge_plan.md`): one window, one
 * store, five views. It opens on a view, the strip of views is always there,
 * Escape and the backdrop close it, only the shown view mounts, `show()`
 * always means Root, and the header badge is derived from the stores.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn() }));
// The views themselves have their own suites; what is held here is WHICH one mounts.
const bodyMounts: string[] = [];
vi.mock("../../components/cockpit/CockpitViews", () => ({
  CockpitViewBody: ({ view }: { view: string }) => {
    bodyMounts.push(view);
    return <div data-testid="cockpit-body" data-view={view} />;
  },
}));
vi.mock("../../components/tabs/TabPane", () => ({ TabPane: () => null }));

import { RootOverlayHost } from "../../components/layout/RootOverlay";
import { CockpitIndicator } from "../../components/header/CockpitIndicator";
import { cockpitBadge } from "../../lib/cockpit/decisions";
import { useCockpitStore } from "../../stores/cockpit";
import { toggleRootConsole, useRootOverlayStore } from "../../stores/rootOverlay";
import { useActivityStore } from "../../stores/activity";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { useRootReviewStore } from "../../stores/rootReview";
import { ASSISTANT_SCOPE } from "../../lib/assistant";
import { useSettingsStore } from "../../stores/settings";

const agent = (key: string): TabEntry => ({ key, label: key, cmd: "claude", cwd: "/p", kind: "agent" });

beforeEach(() => {
  bodyMounts.length = 0;
  localStorage.clear();
  useRootOverlayStore.setState({ open: false, view: "root" });
  useCockpitStore.setState({ lastClosedAt: null });
  useRootReviewStore.setState({ proposals: [], imports: [], refresh: vi.fn(() => Promise.resolve()) });
  useActivityStore.setState({ busyByTab: {}, attentionByTab: {} });
  useTabsStore.setState({ tabsByScope: {}, layoutByScope: {}, focusedGroupByScope: {} });
});
afterEach(() => cleanup());

describe("cockpitBadge", () => {
  it("counts asking and interrupted agent tabs of every scope but the assistant's", () => {
    const badge = cockpitBadge({
      tabsByScope: {
        p1: [agent("a"), agent("b"), { ...agent("s"), kind: "shell" }],
        p2: [agent("c")],
        [ASSISTANT_SCOPE]: [agent("t")],
      },
      busyByTab: { "p1:b": true },
      attentionByTab: { "p1:a": "decision", "p1:b": "decision", "p2:c": "interrupted", "p1:s": "decision", [`${ASSISTANT_SCOPE}:t`]: "decision" },
      schedulesByTarget: {},
      approvals: 2,
    });
    expect(badge).toEqual({ asking: 1, interrupted: 1, proposals: 0, approvals: 2, total: 4 });
  });

  it("counts agent schedule proposals and known push requests", () => {
    const proposal = { id: "x", enabled: false, origin: { by: "agent", session: "s" } } as never;
    const badge = cockpitBadge({ tabsByScope: {}, busyByTab: {}, attentionByTab: {}, schedulesByTarget: { k: [proposal] }, approvals: 0, pushRequests: 1 });
    expect(badge.proposals).toBe(2);
    expect(badge.total).toBe(2);
  });
});

describe("the merged window", () => {
  it("renders nothing while shut", () => {
    const { container } = render(<RootOverlayHost />);
    expect(container.firstChild).toBeNull();
  });

  it("opens on a cockpit view: the strip, only that view mounted, Escape closes and stamps 'away since'", async () => {
    useSettingsStore.setState({ settings: { mail_client: true } as never });
    render(<RootOverlayHost />);
    await act(async () => useRootOverlayStore.getState().openView("now"));
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("Cockpit");
    const tabs = screen.getAllByRole("tab");
    // Now Projects Tonight │ Mail Calendar To-do │ Agents Models Machines │ Root
    expect(tabs).toHaveLength(10);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByTestId("cockpit-body")).toBeTruthy();
    fireEvent.mouseDown(tabs[2], { button: 0 });
    expect(useRootOverlayStore.getState().view).toBe("tonight");
    expect((await screen.findByTestId("cockpit-body")).getAttribute("data-view")).toBe("tonight");
    expect(screen.getAllByTestId("cockpit-body")).toHaveLength(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useRootOverlayStore.getState().open).toBe(false);
    expect(useCockpitStore.getState().lastClosedAt).not.toBeNull();
  });

  it("the Root tab shows the console; the cockpit body unmounts and the window stays up", async () => {
    render(<RootOverlayHost />);
    await act(async () => useRootOverlayStore.getState().openView("tonight"));
    expect(await screen.findByTestId("cockpit-body")).toBeTruthy();
    fireEvent.mouseDown(document.querySelector('[data-root-view="root"]')!, { button: 0 });
    expect(useRootOverlayStore.getState()).toMatchObject({ open: true, view: "root" });
    expect(screen.queryByTestId("cockpit-body")).toBeNull();
    expect(document.querySelector(".root-overlay-region")).toBeTruthy();
  });

  it("arrow keys move the focus along the strip, Enter chooses", async () => {
    render(<RootOverlayHost />);
    await act(async () => useRootOverlayStore.getState().openView("now"));
    const tabs = screen.getAllByRole("tab");
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[1]);
    expect(useRootOverlayStore.getState().view).toBe("now");
    fireEvent.keyDown(tabs[1], { key: "Enter" });
    expect(useRootOverlayStore.getState().view).toBe("projects");
  });

  it("closes on a press on the backdrop, not inside the frame", async () => {
    const { container } = render(<RootOverlayHost />);
    await act(async () => useRootOverlayStore.getState().openView("now"));
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(useRootOverlayStore.getState().open).toBe(true);
    fireEvent.mouseDown(container.firstChild as Element);
    expect(useRootOverlayStore.getState().open).toBe(false);
  });

  it("is the centred, wide window labelled Cockpit, on Root too", async () => {
    const { container } = render(<RootOverlayHost />);
    await act(async () => useRootOverlayStore.getState().show());
    expect((container.firstChild as Element).classList.contains("app-overlay-backdrop")).toBe(true);
    expect(screen.getByRole("dialog").classList.contains("root-overlay-wide")).toBe(true);
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("Cockpit");
  });

  it("show() always means Root, and keeps no cockpit view behind", async () => {
    render(<RootOverlayHost />);
    await act(async () => useRootOverlayStore.getState().openView("tonight"));
    await act(async () => useRootOverlayStore.getState().show());
    expect(useRootOverlayStore.getState().view).toBe("root");
  });

  it("Ctrl+Shift+R: closed -> Root, on another view -> Root, on Root -> closed", () => {
    toggleRootConsole();
    expect(useRootOverlayStore.getState()).toMatchObject({ open: true, view: "root" });
    toggleRootConsole();
    expect(useRootOverlayStore.getState().open).toBe(false);
    useRootOverlayStore.getState().openView("now");
    toggleRootConsole();
    expect(useRootOverlayStore.getState()).toMatchObject({ open: true, view: "root" });
  });

  it("a cockpit view never restores the root scope; closing off Root stamps, closing off Root's own session does not", async () => {
    render(<RootOverlayHost />);
    await act(async () => useRootOverlayStore.getState().openView("now"));
    expect(useTabsStore.getState().tabsByScope.root).toBeUndefined();
    await act(async () => useRootOverlayStore.getState().close());
    const stamped = useCockpitStore.getState().lastClosedAt;
    expect(stamped).not.toBeNull();
    useCockpitStore.setState({ lastClosedAt: null });
    await act(async () => useRootOverlayStore.getState().show());
    await act(async () => useRootOverlayStore.getState().close());
    expect(useCockpitStore.getState().lastClosedAt).toBeNull();
  });
});

describe("CockpitIndicator", () => {
  it("shows the derived count, opens Now, and closes only a cockpit view", () => {
    useTabsStore.setState({ tabsByScope: { p1: [agent("a")] } });
    useActivityStore.setState({ attentionByTab: { "p1:a": "decision" } });
    render(<CockpitIndicator />);
    const button = screen.getByRole("button", { name: /1 asking/ });
    expect(button.textContent).toContain("1");
    fireEvent.click(button);
    expect(useRootOverlayStore.getState()).toMatchObject({ open: true, view: "now" });
    fireEvent.click(button);
    expect(useRootOverlayStore.getState().open).toBe(false);
    // Up on Root, the gauge goes to Now rather than closing the console.
    act(() => useRootOverlayStore.getState().show());
    fireEvent.click(button);
    expect(useRootOverlayStore.getState()).toMatchObject({ open: true, view: "now" });
    // Answered: the badge falls with no acknowledgement.
    act(() => useActivityStore.setState({ attentionByTab: {} }));
    expect(button.querySelector(".cockpit-indicator-badge")).toBeNull();
  });
});
