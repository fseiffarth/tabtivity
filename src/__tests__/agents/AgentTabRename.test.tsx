/**
 * Renaming an agent tab from the Agents view. The tab bar's own rename is
 * behind a right-click on the tab itself, which may not be in the group on
 * screen — and the Agents view is where several agents get told apart, so the
 * name is edited where it is read.
 *
 * The store half matters as much as the button: this view lists
 * `tabsByScope[scope]` for ITS scope, while `renameTab` writes to whichever
 * scope is active, so a rename from here has to name the scope out loud.
 */
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve([])),
}));

import { AgentSchedulesView } from "../../components/agents/AgentSchedulesView";
import { useAgentPromptsStore } from "../../stores/agents/agentPrompts";
import { useAgentSchedulesStore } from "../../stores/agents/agentSchedules";
import { useTabsStore, type TabEntry } from "../../stores/tabs";

const AGENT_TAB: TabEntry = {
  key: "agent-1",
  label: "Claude",
  cmd: "claude",
  cwd: "/project",
  kind: "agent",
  scope: "proj-1",
  scheduleTargetId: "target-1",
};

function seedTabs(activeScope: string) {
  useTabsStore.setState({
    scope: activeScope,
    tabsByScope: { "proj-1": [AGENT_TAB] },
    layoutByScope: { "proj-1": { type: "group", id: "g1", tabKeys: ["agent-1"], activeKey: "agent-1" } },
    focusedGroupByScope: {},
    tabs: activeScope === "proj-1" ? [AGENT_TAB] : [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
  });
}

beforeEach(() => {
  useAgentSchedulesStore.setState({ byTarget: {}, loading: {} });
  useAgentPromptsStore.setState({ byProject: {}, historyByProject: {} });
});

describe("renameTabInScope", () => {
  it("renames a tab in a scope that is not the active one", () => {
    seedTabs("other-scope");
    useTabsStore.getState().renameTabInScope("proj-1", "agent-1", "  Reviewer  ");
    expect(useTabsStore.getState().tabsByScope["proj-1"]?.[0].label).toBe("Reviewer");
    // The active scope is untouched — the old `renameTab` would have written there.
    expect(useTabsStore.getState().tabsByScope["other-scope"]).toBeUndefined();
  });

  it("ignores an empty name rather than leaving a nameless tab", () => {
    seedTabs("proj-1");
    useTabsStore.getState().renameTabInScope("proj-1", "agent-1", "   ");
    expect(useTabsStore.getState().tabsByScope["proj-1"]?.[0].label).toBe("Claude");
  });
});

describe("Agents view rename", () => {
  it("edits the tab's name in place and commits it to the store", async () => {
    seedTabs("proj-1");
    await act(async () => {
      render(<AgentSchedulesView scope="proj-1" active={true} />);
    });

    const user = userEvent.setup();
    // Rename is one of the row's actions: open the row first.
    await user.click(screen.getByRole("button", { name: "Show details of Claude" }));
    await user.click(screen.getByRole("button", { name: "Rename tab" }));
    const input = screen.getByRole("textbox", { name: "Rename tab" });
    await user.clear(input);
    await user.type(input, "Reviewer{Enter}");

    expect(useTabsStore.getState().tabsByScope["proj-1"]?.[0].label).toBe("Reviewer");
    expect(screen.queryByRole("textbox", { name: "Rename tab" })).toBeNull();
  });

  it("leaves the name alone when the edit is abandoned", async () => {
    seedTabs("proj-1");
    await act(async () => {
      render(<AgentSchedulesView scope="proj-1" active={true} />);
    });

    const user = userEvent.setup();
    // Rename is one of the row's actions: open the row first.
    await user.click(screen.getByRole("button", { name: "Show details of Claude" }));
    await user.click(screen.getByRole("button", { name: "Rename tab" }));
    await user.type(screen.getByRole("textbox", { name: "Rename tab" }), "Reviewer{Escape}");

    expect(useTabsStore.getState().tabsByScope["proj-1"]?.[0].label).toBe("Claude");
  });
});
