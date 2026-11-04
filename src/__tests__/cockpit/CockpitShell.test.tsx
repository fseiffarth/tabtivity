/**
 * The cockpit's shell (`docs/desktop_cockpit_plan.md` C1): the overlay opens
 * and closes, Escape and the backdrop close it, the view tabs switch, the
 * experiment gates it, and the header badge is derived from the stores.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn() }));

import { CockpitOverlayHost } from "../../components/cockpit/CockpitOverlay";
import { CockpitIndicator } from "../../components/header/CockpitIndicator";
import { cockpitBadge } from "../../lib/cockpit/decisions";
import { useCockpitStore } from "../../stores/cockpit";
import { useSettingsStore } from "../../stores/settings";
import { useActivityStore } from "../../stores/activity";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { useRootReviewStore } from "../../stores/rootReview";
import { ASSISTANT_SCOPE } from "../../lib/assistant";
import type { Settings } from "../../types";

const agent = (key: string): TabEntry => ({ key, label: key, cmd: "claude", cwd: "/p", kind: "agent" });

function setFlag(on: boolean) {
  useSettingsStore.setState({ settings: { cockpit: on, experimental_explicit: true } as Settings });
}

beforeEach(() => {
  setFlag(true);
  useCockpitStore.setState({ overlayOpen: false, view: "now", lastClosedAt: null });
  useRootReviewStore.setState({ proposals: [], imports: [], refresh: vi.fn(() => Promise.resolve()) });
  useActivityStore.setState({ busyByTab: {}, attentionByTab: {} });
  useTabsStore.setState({ tabsByScope: {} });
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

describe("CockpitOverlayHost", () => {
  it("renders nothing while shut, and nothing with the experiment off", () => {
    const { container, rerender } = render(<CockpitOverlayHost />);
    expect(container.firstChild).toBeNull();
    setFlag(false);
    act(() => useCockpitStore.getState().openOverlay());
    rerender(<CockpitOverlayHost />);
    expect(container.firstChild).toBeNull();
  });

  it("opens on the Now view, switches views, and Escape closes it", () => {
    render(<CockpitOverlayHost />);
    act(() => useCockpitStore.getState().openOverlay());
    expect(screen.getByRole("dialog")).toBeTruthy();
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(4);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.mouseDown(tabs[2], { button: 0 });
    expect(useCockpitStore.getState().view).toBe("tonight");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useCockpitStore.getState().overlayOpen).toBe(false);
    expect(useCockpitStore.getState().lastClosedAt).not.toBeNull();
  });

  it("closes on a press on the backdrop, not inside the frame", () => {
    const { container } = render(<CockpitOverlayHost />);
    act(() => useCockpitStore.getState().openOverlay());
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(useCockpitStore.getState().overlayOpen).toBe(true);
    fireEvent.mouseDown(container.firstChild as Element);
    expect(useCockpitStore.getState().overlayOpen).toBe(false);
  });
});

describe("CockpitIndicator", () => {
  it("is absent with the experiment off", () => {
    setFlag(false);
    const { container } = render(<CockpitIndicator />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the derived count and toggles the overlay", () => {
    useTabsStore.setState({ tabsByScope: { p1: [agent("a")] } });
    useActivityStore.setState({ attentionByTab: { "p1:a": "decision" } });
    render(<CockpitIndicator />);
    const button = screen.getByRole("button", { name: /1 asking/ });
    expect(button.textContent).toContain("1");
    fireEvent.click(button);
    expect(useCockpitStore.getState().overlayOpen).toBe(true);
    // Answered: the badge falls with no acknowledgement.
    act(() => useActivityStore.setState({ attentionByTab: {} }));
    expect(button.querySelector(".cockpit-indicator-badge")).toBeNull();
  });
});
