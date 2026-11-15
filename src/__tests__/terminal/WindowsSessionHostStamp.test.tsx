/**
 * On Windows the session host's wrap is stamped once per slot (`PaneSlot`):
 * a settings change reaches new tabs only and never respawns a live agent;
 * an agent's pane waits for settings to load; turning the flag OFF asks, and a
 * yes ends the host's sessions BEFORE the flag is saved
 * (`WindowsSessionHostToggle`), and so does turning Persistent local sessions
 * off while the host is on (`PersistLocalSessionsToggle`): saving first would
 * let the next load resume the agent in-process beside the host's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../lib/platform", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../lib/platform")>();
  return { ...real, HOST_OS: "windows", IS_HOST_WINDOWS: true, IS_HOST_LINUX: false, IS_HOST_MAC: false };
});

const lastProps = new Map<string, Record<string, unknown>>();
vi.mock("../../components/tabs/TabPane", () => ({
  TabPane: (props: { tab: { key: string } }) => {
    lastProps.set(props.tab.key, props as unknown as Record<string, unknown>);
    return <div data-testid={`pane-${props.tab.key}`} />;
  },
}));

import { PaneSlot } from "../../components/layout/PaneSlot";
import { PersistLocalSessionsToggle, WindowsSessionHostToggle } from "../../components/layout/WindowsSessionHostToggle";
import { useSettingsStore } from "../../stores/settings";
import type { TabEntry } from "../../stores/tabs";
import type { Settings } from "../../types";

const agent = (key: string): TabEntry =>
  ({
    key,
    kind: "agent",
    cmd: "claude",
    label: "claude",
    cwd: "/p1",
    sessionId: "11111111-2222-3333-4444-555555555555",
    tmuxSession: `s-${key}`,
  }) as TabEntry;

function slot(tab: TabEntry, stamps: Map<string, boolean>) {
  return (
    <PaneSlot
      tab={tab}
      scopeKey="p1"
      groupId="g1"
      visible
      focused={false}
      paneProject={{ id: "p1", name: "p1", status: "active", position: 0, local_file: "/p1" } as never}
      paneBox={undefined}
      projectSsh={undefined}
      hostSsh={undefined}
      localPersistEnabled
      onConnect={() => {}}
      mobileAgentTmuxReady={stamps}
      sleepAfterMs={null}
      inPopout={false}
      drawnElsewhere={false}
    />
  );
}

function setSettings(settings: Partial<Settings> | null, loaded = true) {
  act(() => {
    useSettingsStore.setState({ settings: settings as Settings | null, loaded });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  lastProps.clear();
  mockInvoke.mockResolvedValue(null);
});
afterEach(() => cleanup());

describe("the Windows session host stamp (PaneSlot)", () => {
  it("holds an agent's pane until settings load, then wraps it once the host is on", () => {
    const stamps = new Map<string, boolean>();
    setSettings(null, false);
    const view = render(slot(agent("a1"), stamps));
    expect(lastProps.has("a1")).toBe(false);
    expect(stamps.size).toBe(0);
    setSettings({ windows_session_host: true });
    view.rerender(slot(agent("a1"), stamps));
    expect(lastProps.get("a1")?.tmuxSession).toBe("s-a1");
  });

  it("does not respawn a live agent when the flag changes: only new tabs follow it", () => {
    const stamps = new Map<string, boolean>();
    setSettings({ windows_session_host: true });
    const view = render(slot(agent("a1"), stamps));
    expect(lastProps.get("a1")?.tmuxSession).toBe("s-a1");
    // Off (or persistent sessions off): the drawn tab keeps its wrap...
    setSettings({ windows_session_host: false });
    view.rerender(slot(agent("a1"), stamps));
    expect(lastProps.get("a1")?.tmuxSession).toBe("s-a1");
    // ...and a new one runs in the window.
    render(slot(agent("a2"), stamps));
    expect(lastProps.get("a2")?.tmuxSession).toBeUndefined();
    // On again: the in-window tab stays in the window.
    setSettings({ windows_session_host: true });
    render(slot(agent("a2"), stamps));
    expect(lastProps.get("a2")?.tmuxSession).toBeUndefined();
  });

  it("never wraps a shell", () => {
    setSettings({ windows_session_host: true });
    render(slot({ ...agent("s1"), kind: "shell", cmd: "" } as TabEntry, new Map()));
    expect(lastProps.get("s1")?.tmuxSession).toBeUndefined();
  });
});

describe("turning the Windows session host off", () => {
  beforeEach(() => {
    const updateSettings = vi.fn(async (patch: Partial<Settings>) => {
      useSettingsStore.setState((s) => ({ settings: { ...(s.settings as Settings), ...patch } }));
    });
    useSettingsStore.setState({ settings: { windows_session_host: true } as Settings, loaded: true, updateSettings });
  });

  it("asks, and a yes ends the host's sessions before the flag is saved", async () => {
    const order: string[] = [];
    mockInvoke.mockImplementation((cmd: string) => {
      order.push(cmd);
      return Promise.resolve(null);
    });
    const save = useSettingsStore.getState().updateSettings as ReturnType<typeof vi.fn>;
    save.mockImplementation(async (patch: Partial<Settings>) => {
      order.push("save");
      useSettingsStore.setState((s) => ({ settings: { ...(s.settings as Settings), ...patch } }));
    });
    render(<WindowsSessionHostToggle />);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(await screen.findByRole("button", { name: "End them and turn off" }));
    await waitFor(() => expect(useSettingsStore.getState().settings?.windows_session_host).toBe(false));
    expect(order).toEqual(["local_tmux_kill_app_sessions", "save"]);
  });

  it("keeps it on when the user says no", async () => {
    render(<WindowsSessionHostToggle />);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await act(async () => {});
    expect(mockInvoke).not.toHaveBeenCalledWith("local_tmux_kill_app_sessions");
    expect(useSettingsStore.getState().settings?.windows_session_host).toBe(true);
  });

  it("keeps it on when the sessions could not be ended", async () => {
    mockInvoke.mockRejectedValue(new Error("pipe busy"));
    render(<WindowsSessionHostToggle />);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(await screen.findByRole("button", { name: "End them and turn off" }));
    await act(async () => {});
    expect(useSettingsStore.getState().settings?.windows_session_host).toBe(true);
  });

  it("turns on without asking", async () => {
    useSettingsStore.setState({ settings: {} as Settings });
    render(<WindowsSessionHostToggle />);
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(useSettingsStore.getState().settings?.windows_session_host).toBe(true));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("turning Persistent local sessions off on Windows", () => {
  function seedSettings(settings: Partial<Settings>) {
    const order: string[] = [];
    mockInvoke.mockImplementation((cmd: string) => {
      order.push(cmd);
      return Promise.resolve(null);
    });
    const updateSettings = vi.fn(async (patch: Partial<Settings>) => {
      order.push("save");
      useSettingsStore.setState((s) => ({ settings: { ...(s.settings as Settings), ...patch } }));
    });
    useSettingsStore.setState({ settings: settings as Settings, loaded: true, updateSettings });
    return order;
  }

  it("with the host on, asks and ends the host's sessions before saving", async () => {
    const order = seedSettings({ windows_session_host: true });
    render(<PersistLocalSessionsToggle />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(await screen.findByText("Turn off persistent local sessions?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "End them and turn off" }));
    await waitFor(() => expect(useSettingsStore.getState().settings?.persist_local_sessions).toBe(false));
    expect(order).toEqual(["local_tmux_kill_app_sessions", "save"]);
  });

  it("with the host on, a no saves nothing", async () => {
    const order = seedSettings({ windows_session_host: true });
    render(<PersistLocalSessionsToggle />);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await act(async () => {});
    expect(order).toEqual([]);
    expect(useSettingsStore.getState().settings?.persist_local_sessions).toBeUndefined();
  });

  it("with the host on, a failed end saves nothing and says so", async () => {
    seedSettings({ windows_session_host: true });
    mockInvoke.mockRejectedValue(new Error("pipe busy"));
    render(<PersistLocalSessionsToggle />);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(await screen.findByRole("button", { name: "End them and turn off" }));
    await waitFor(() => expect(document.body.textContent).toContain("pipe busy"));
    expect(useSettingsStore.getState().settings?.persist_local_sessions).toBeUndefined();
  });

  it("turning it back on only saves", async () => {
    const order = seedSettings({ windows_session_host: true, persist_local_sessions: false });
    render(<PersistLocalSessionsToggle />);
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(useSettingsStore.getState().settings?.persist_local_sessions).toBe(true));
    expect(order).toEqual(["save"]);
  });
});
