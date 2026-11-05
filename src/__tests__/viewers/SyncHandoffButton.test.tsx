/**
 * "Hand to an agent": gated on the connection, exports through the backend, then
 * offers one click to open an agent tab, queue the prompt at an open local agent
 * tab (never a host tab), or copy it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { mockInvoke, queuePrompt, addTabToScope } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  queuePrompt: vi.fn((..._args: unknown[]) => Promise.resolve({ pruned: 0, id: "x" })),
  addTabToScope: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("../../stores/agents/agentPrompts", () => ({ queuePromptForTab: queuePrompt }));
vi.mock("../../stores/projects", () => {
  const state = {
    projects: [{ id: "p1", name: "Proj", directory: "/state/p1", remote: { remote_path: "/data/p" } }],
    activeId: "p1",
  };
  return {
    useProjectsStore: Object.assign((sel?: (s: typeof state) => unknown) => (sel ? sel(state) : state), {
      getState: () => state,
    }),
  };
});
vi.mock("../../stores/settings", () => {
  const state = { settings: { default_agent_cmd: "claude" } };
  return {
    useSettingsStore: Object.assign((sel?: (s: typeof state) => unknown) => (sel ? sel(state) : state), {
      getState: () => state,
    }),
  };
});
vi.mock("../../stores/tabs", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  const tab = (key: string, kind: string, location?: string) => ({
    key,
    kind,
    label: key,
    scheduleTargetId: `target-${key}`,
    cmd: "claude",
    location,
  });
  const state = {
    tabsByScope: {
      p1: [tab("local-agent", "agent"), tab("host-agent", "agent", "remote"), { key: "sh", kind: "shell", label: "sh" }],
    },
    addTabToScope,
  };
  return {
    ...actual,
    useTabsStore: Object.assign((sel?: (s: typeof state) => unknown) => (sel ? sel(state) : state), {
      getState: () => state,
    }),
  };
});

import { SyncHandoffButton } from "../../components/embed/SyncHandoffButton";

const file = { relPath: "a.py", localText: "l", remoteText: "r", localMtime: 1, remoteMtime: 2, newer: null, newerBasis: null, changes: [] };

function setup(connected = true) {
  const collect = vi.fn(() => Promise.resolve({ files: [file], skipped: 0 }));
  render(
    <SyncHandoffButton
      projectId="p1"
      connected={connected}
      collect={collect}
      label="Hand to an agent"
      title="tip"
    />,
  );
  return collect;
}

describe("SyncHandoffButton", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    queuePrompt.mockClear();
    addTabToScope.mockClear();
    mockInvoke.mockResolvedValue({ id: "conflicts-1", agentDir: "~/handoff/conflicts-1", fileCount: 1 });
  });

  it("is disabled while the host is not connected", () => {
    setup(false);
    expect((screen.getByRole("button", { name: /Hand to an agent/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("exports through the backend and offers the folder in the prompt", async () => {
    const collect = setup();
    fireEvent.click(screen.getByRole("button", { name: /Hand to an agent/ }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(collect).toHaveBeenCalled();
    expect(mockInvoke).toHaveBeenCalledWith("sync_handoff_export", { projectId: "p1", files: [file] });
    expect((screen.getByRole("dialog").querySelector("textarea") as HTMLTextAreaElement).value).toContain("~/handoff/conflicts-1/CONFLICTS.md");
  });

  it("queues the prompt at an open local agent tab, and lists no host tab", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /Hand to an agent/ }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(screen.queryByText(/host-agent/)).toBeNull();
    fireEvent.click(screen.getByText(/local-agent/));
    await waitFor(() => expect(queuePrompt).toHaveBeenCalled());
    expect(queuePrompt).toHaveBeenCalledWith("p1", "target-local-agent", expect.stringContaining("~/handoff/conflicts-1"));
  });

  it("opens a new agent tab with the prompt queued", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /Hand to an agent/ }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    fireEvent.click(screen.getByText("Open a new agent tab with this prompt"));
    await waitFor(() => expect(addTabToScope).toHaveBeenCalled());
    await waitFor(() => expect(queuePrompt).toHaveBeenCalled());
    expect(queuePrompt.mock.calls[0][0]).toBe("p1");
  });

  it("says why when the export fails", async () => {
    mockInvoke.mockRejectedValue("not a remote project");
    setup();
    fireEvent.click(screen.getByRole("button", { name: /Hand to an agent/ }));
    await waitFor(() => expect(screen.getByText(/Could not hand over: not a remote project/)).toBeTruthy());
  });
});
