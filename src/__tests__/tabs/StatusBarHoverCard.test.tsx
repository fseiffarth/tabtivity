/**
 * A project pill's status bar opens its tab's own hover card: the state the
 * bar stands for in words (working / asking / finished), the last prompt, and
 * what a click does — and tells the pill, so the project card steps aside
 * while it is up. Leaving the bar closes the card again.
 */
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { PillStatusBars } from "../../components/projects/PillStatusBars";
import { _clearKnownFeaturesForTest } from "../../components/tabs/TabHoverCard";
import { useActivityStore, type StatusTab } from "../../stores/activity";
import { useAgentModelsStore } from "../../stores/agents/agentModels";
import { useTabsStore, type TabEntry } from "../../stores/tabs";

const TAB = { key: "agent-1", label: "Claude", cmd: "claude", cwd: "/p", kind: "agent" } as TabEntry;

function seed(state: StatusTab["state"]) {
  useTabsStore.setState({ tabsByScope: { p1: [TAB] } });
  useActivityStore.setState({
    busyByTab: state === "working" ? { "p1:agent-1": true } : {},
    attentionByTab: state === "needs-decision" ? { "p1:agent-1": "decision" } : {},
    statusTabsByScope: { p1: [{ key: TAB.key, state }] },
  });
  useAgentModelsStore.setState({ promptByTab: { "p1:agent-1": "verify the new CLIs" } });
}

const card = () => document.querySelector<HTMLElement>(".tab-popup");
const bar = () => document.querySelector<HTMLElement>(".pill-status-bar")!;

beforeEach(() => _clearKnownFeaturesForTest());
afterEach(() => {
  cleanup();
  useTabsStore.setState({ tabsByScope: {} });
  useActivityStore.setState({ busyByTab: {}, attentionByTab: {}, statusTabsByScope: {} });
  useAgentModelsStore.setState({ promptByTab: {} });
});

describe("status bar hover card", () => {
  it("shows the tab's state, last prompt and the click hint, and tells the pill", async () => {
    seed("working");
    const onBarHover = vi.fn();
    render(<PillStatusBars scope="p1" onBarHover={onBarHover} />);
    expect(bar().title).toBe("");
    fireEvent.mouseEnter(bar());
    expect(onBarHover).toHaveBeenLastCalledWith(true);
    await waitFor(() => expect(card()?.style.visibility).toBe("visible"));
    expect(card()!.querySelector(".tab-popup-label")?.textContent).toBe("Claude");
    const activity = card()!.querySelector(".tab-popup-meta.working")?.textContent ?? "";
    expect(activity.startsWith("Working")).toBe(true);
    expect(card()!.querySelector(".tab-popup-prompt")?.textContent).toBe("verify the new CLIs");
    expect(card()!.textContent).toContain("click to open this tab");

    fireEvent.mouseLeave(bar());
    expect(card()).toBeNull();
    expect(onBarHover).toHaveBeenLastCalledWith(false);
  });

  it("names a question as asking", async () => {
    seed("needs-decision");
    render(<PillStatusBars scope="p1" />);
    fireEvent.mouseEnter(bar());
    await waitFor(() => expect(card()?.style.visibility).toBe("visible"));
    expect(card()!.querySelector(".tab-popup-meta.asking")?.textContent).toBe("Asking");
  });

  it("drops the card when its bar goes away under the pointer", async () => {
    seed("working");
    const onBarHover = vi.fn();
    render(<PillStatusBars scope="p1" onBarHover={onBarHover} />);
    fireEvent.mouseEnter(bar());
    await waitFor(() => expect(card()).not.toBeNull());
    act(() => useActivityStore.setState({ busyByTab: {}, statusTabsByScope: {} }));
    expect(card()).toBeNull();
    expect(onBarHover).toHaveBeenLastCalledWith(false);
  });
});
