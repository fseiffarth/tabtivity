/**
 * Tab messaging's window surface (`services::tabs_mcp`,
 * `docs/tab_messaging_mcp_plan.md` step 6–7): the cockpit's Messages fold
 * shows agent-written text as plain text, Deliver queues exactly the host's
 * notice through the scheduler's idle gate, nothing is listed while the pane
 * is hidden, the hover card counts unread, and the Manage CLIs switch
 * round-trips.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn() }));
vi.mock("../../stores/agents/agentPrompts", () => ({
  queuePromptForTab: vi.fn(() => Promise.resolve({ pruned: 0, id: "q" })),
}));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { CockpitMessages } from "../../components/cockpit/CockpitMessages";
import { TabsMcpSettings } from "../../components/agents/TabsMcpSettings";
import { TabMessagesHost } from "../../components/layout/TabMessagesHost";
import { TabHoverCard } from "../../components/tabs/TabHoverCard";
import { buildRoster, type RosterOptions, type RosterRow } from "../../lib/cockpit/roster";
import { PaneVisibleContext } from "../../lib/files/fileAccess";
import type { TabMessage } from "../../lib/window/tabsMcp";
import { queuePromptForTab } from "../../stores/agents/agentPrompts";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { unreadFor, useTabMessagesStore } from "../../stores/tabMessages";
import { useTabsStore, type TabEntry } from "../../stores/tabs";

const NOTICE = "Other agent tabs of this project left you messages.";
const OPTS: RosterOptions = { stateFilter: "all", sort: "lastWorking", mode: "flat", query: "", boxFilter: null, scopeFilter: null };
const scope = { id: "p1", name: "P1", kind: "project" as const, boxIds: [] };
const tabA: TabEntry = { key: "ka", id: "tab-a", label: "Writer", cmd: "claude", cwd: "/p", kind: "agent", scheduleTargetId: "sched-a" };
const tabB: TabEntry = { key: "kb", id: "tab-b", label: "Reviewer", cmd: "codex", cwd: "/p", kind: "agent", scheduleTargetId: "sched-b" };
const rowOf = (tab: TabEntry, kind: "project" | "box" | "root" = "project"): RosterRow =>
  buildRoster([{ scope: { ...scope, kind }, tab, facts: { ptyId: `p1:${tab.key}`, state: "idle" } }], OPTS).rows[0];

const MARKUP = "<b>bold</b> [link](https://example.com) **not bold**";
let traffic: TabMessage[] = [];

function mockBackend(overrides: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
    const a = (args ?? {}) as Record<string, unknown>;
    if (overrides[cmd]) return overrides[cmd](a);
    if (cmd === "tabs_mcp_traffic") return traffic;
    if (cmd === "tabs_mcp_deliver") return { notice: NOTICE, scheduleTargetId: "sched-b" };
    if (cmd === "tabs_mcp_clear") return traffic.length;
    if (cmd === "tabs_mcp_wake_claim") return { notice: NOTICE, scheduleTargetIds: [] };
    return null;
  });
}

const flush = () => act(async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
});

beforeEach(() => {
  traffic = [
    { id: "m_1", fromTab: "tab-a", toTab: "tab-b", sentAt: "2026-11-14T10:00:00Z", text: MARKUP, read: false },
    { id: "m_2", fromTab: "tab-b", toTab: "tab-a", sentAt: "2026-11-14T10:05:00Z", text: "done", read: true },
  ];
  mockBackend();
  useTabMessagesStore.setState({ byScope: {} });
  useTabsStore.setState({ tabsByScope: { p1: [tabA, tabB] } });
  useProjectsStore.setState({ projects: [] });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the Messages fold", () => {
  it("renders agent text literally, names the other tab and counts unread", async () => {
    const { container } = render(<CockpitMessages row={rowOf(tabB)} />);
    await flush();
    expect(screen.getByText(MARKUP)).toBeTruthy();
    expect(container.querySelector("b, a")).toBeNull();
    expect(screen.getByText("from Writer")).toBeTruthy();
    expect(screen.getByText("to Writer")).toBeTruthy();
    expect(container.textContent).toContain("1 unread");
    expect(container.querySelector(".untested-tag")).not.toBeNull();
  });

  it("Deliver queues exactly the host's notice for the tab's schedule target", async () => {
    render(<CockpitMessages row={rowOf(tabB)} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Deliver" }));
    await flush();
    expect(invoke).toHaveBeenCalledWith("tabs_mcp_deliver", { scope: "p1", tabId: "tab-b" });
    expect(queuePromptForTab).toHaveBeenCalledTimes(1);
    expect(queuePromptForTab).toHaveBeenCalledWith("p1", "sched-b", NOTICE);
    expect(vi.mocked(queuePromptForTab).mock.calls[0][2]).not.toContain(MARKUP);
  });

  it("Deliver is off for a tab with nothing unread", async () => {
    render(<CockpitMessages row={rowOf(tabA)} />);
    await flush();
    expect((screen.getByRole("button", { name: "Deliver" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("lists nothing while the pane is hidden, and catches up on show", async () => {
    const { rerender } = render(
      <PaneVisibleContext.Provider value={false}>
        <CockpitMessages row={rowOf(tabB)} />
      </PaneVisibleContext.Provider>,
    );
    await flush();
    expect(invoke).not.toHaveBeenCalledWith("tabs_mcp_traffic", expect.anything());
    rerender(
      <PaneVisibleContext.Provider value={true}>
        <CockpitMessages row={rowOf(tabB)} />
      </PaneVisibleContext.Provider>,
    );
    await flush();
    expect(invoke).toHaveBeenCalledWith("tabs_mcp_traffic", { scope: "p1", tabId: null });
    expect(screen.getByText(MARKUP)).toBeTruthy();
  });

  it("is absent for a box or root row", async () => {
    const { container } = render(<CockpitMessages row={rowOf(tabB, "box")} />);
    await flush();
    expect(container.textContent).toBe("");
    expect(invoke).not.toHaveBeenCalledWith("tabs_mcp_traffic", expect.anything());
  });

  it("refetches the watched scope on tabs-mcp-changed", async () => {
    render(<CockpitMessages row={rowOf(tabB)} />);
    await flush();
    const handler = vi.mocked(listen).mock.calls.find(([event]) => event === "tabs-mcp-changed")?.[1];
    expect(handler).toBeTruthy();
    traffic = [...traffic, { id: "m_3", fromTab: "tab-a", toTab: "tab-b", sentAt: "2026-11-14T10:06:00Z", text: "again", read: false }];
    await act(async () => handler!({ event: "tabs-mcp-changed", id: 1, payload: null }));
    await flush();
    expect(screen.getByText("again")).toBeTruthy();
    expect(unreadFor(useTabMessagesStore.getState().byScope.p1 ?? [], "tab-b")).toBe(2);
  });
});

describe("the tab hover card", () => {
  const messagesRow = () =>
    [...document.querySelectorAll(".tab-popup .pill-popup-path-row")]
      .find((r) => r.querySelector(".pill-popup-path-label")?.textContent?.startsWith("messages"))
      ?.querySelector(".tab-popup-meta")?.textContent ?? null;

  it("counts the tab's unread and never shows their text", async () => {
    render(<TabHoverCard tab={tabB} scope="p1" anchorX={100} anchorY={20} />);
    await flush();
    expect(messagesRow()).toBe("1 unread");
    expect(document.body.textContent).not.toContain("bold");
  });

  it("has no line for a tab with nothing unread", async () => {
    render(<TabHoverCard tab={tabA} scope="p1" anchorX={100} anchorY={20} />);
    await flush();
    expect(messagesRow()).toBeNull();
  });
});

describe("the idle wake host", () => {
  it("claims only for opted-in projects and queues only the host's notice", async () => {
    mockBackend({ tabs_mcp_wake_claim: () => ({ notice: NOTICE, scheduleTargetIds: ["sched-b"] }) });
    useProjectsStore.setState({
      projects: [
        { id: "p1", name: "P1", status: "active", position: 0, local_file: "", tab_messages_wake: true },
        { id: "p2", name: "P2", status: "active", position: 1, local_file: "" },
      ] as never,
    });
    render(<TabMessagesHost />);
    await flush();
    expect(invoke).toHaveBeenCalledWith("tabs_mcp_wake_claim", { scope: "p1" });
    expect(invoke).not.toHaveBeenCalledWith("tabs_mcp_wake_claim", { scope: "p2" });
    expect(queuePromptForTab).toHaveBeenCalledWith("p1", "sched-b", NOTICE);
  });

  it("does nothing while no project opts in", async () => {
    render(<TabMessagesHost />);
    await flush();
    expect(invoke).not.toHaveBeenCalledWith("tabs_mcp_wake_claim", expect.anything());
    expect(listen).not.toHaveBeenCalled();
  });
});

describe("the Manage CLIs switch", () => {
  it("is on when absent and writes tabs_mcp", async () => {
    const updateSettings = vi.fn(() => Promise.resolve());
    useSettingsStore.setState({ settings: {} as never, updateSettings } as never);
    render(<TabsMcpSettings />);
    const toggle = screen.getByRole("checkbox", { name: /message each other/ }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(updateSettings).toHaveBeenCalledWith({ tabs_mcp: false });
  });
});
