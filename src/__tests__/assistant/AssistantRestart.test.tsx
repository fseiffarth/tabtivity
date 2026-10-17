/**
 * A Tabby chat's process ends with its CLI (the pane runs the pinned line and
 * no login shell after it, so the tmux session goes too). The window must see
 * that and start the chat again: the overlay's Restart, and the phone opening
 * the chat (`startAssistantChat` through `activate?tab=`), respawn the same
 * pane's PTY instead of leaving `[process exited]` up forever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const handlers = new Map<string, Array<(ev: { payload: unknown }) => void>>();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) => {
    if (cmd === "workspace_snapshot") return Promise.resolve({ version: 3, tabLayout: [chatRecord()] });
    if (cmd === "assistant_options") return Promise.resolve(options());
    return Promise.resolve(undefined);
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: (ev: { payload: unknown }) => void) => {
    handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    return Promise.resolve(() => {});
  }),
  emit: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    scaleFactor: () => Promise.resolve(1),
    innerPosition: () => Promise.resolve({ toLogical: () => ({ x: 0, y: 0 }) }),
    onMoved: () => Promise.resolve(() => {}),
    onResized: () => Promise.resolve(() => {}),
    onFocusChanged: () => Promise.resolve(() => {}),
  }),
}));
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
vi.mock("../../components/tabs/TabPane", () => ({
  TabPane: (props: { tab: { key: string }; attachOnly?: boolean }) => (
    <div data-testid={`pane-${props.attachOnly ? "attach" : "own"}-${props.tab.key}`} />
  ),
}));

import { ASSISTANT_SCOPE } from "../../lib/assistant";
import { AssistantOverlayHost } from "../../components/assistant/AssistantOverlay";
import { _resetSyncBaseForTest, useTabsStore, type SavedTabEntry } from "../../stores/tabs";
import { assistantTabs, ensureAssistantScopeHydrated, startAssistantChat } from "../../stores/assistantScope";
import { useAssistantOverlayStore } from "../../stores/assistantOverlay";
import { useOverlayAgentStore } from "../../stores/overlayAgent";
import { useSettingsStore } from "../../stores/settings";
import type { Settings } from "../../types";

const UID = "11111111-1111-4111-8111-111111111111";

function chatRecord(): SavedTabEntry {
  return {
    key: "saved-a",
    id: "a",
    label: "Chat",
    cmd: "claude",
    cwd: `/state/assistant/work/${UID}`,
    kind: "agent",
    sessionId: UID,
    assistant: { cli: "claude" },
    createdVersion: 1,
  } as SavedTabEntry;
}

function options() {
  return {
    clis: [{ id: "claude", label: "Claude", local: false, installed: true, signedIn: true, ready: true }],
    localModels: [],
    ollamaReachable: false,
    defaultCli: "claude",
    defaultModel: null,
    search: { kind: null, searxngUrl: null, ollamaKeyStored: false, keyring: "unlocked", configured: false },
  };
}

/** The backend's `terminal-exit` / `terminal-ready` for the chat's PTY. */
function emit(event: "terminal-exit" | "terminal-ready", key: string) {
  act(() => {
    for (const h of handlers.get(event) ?? []) h({ payload: { id: `${ASSISTANT_SCOPE}:${key}`, code: null } });
  });
}

const relaunchSeq = (key: string) => assistantTabs().find((t) => t.key === key)?.relaunchSeq ?? 0;

beforeEach(async () => {
  cleanup();
  localStorage.clear();
  _resetSyncBaseForTest();
  useTabsStore.setState({
    scope: "p1",
    tabs: [],
    tabsByScope: { p1: [] },
    layoutByScope: { p1: null },
    focusedGroupByScope: { p1: null },
    detachedGroupsByScope: {},
    hiddenGroupsByScope: {},
    pendingRespawnByScope: {},
    workspaceVersionByScope: {},
    fullscreenGroupId: null,
  });
  useOverlayAgentStore.setState({ assistantShownKeys: new Set(), assistantStartedKeys: new Set(), assistantEndedKeys: new Set() });
  useAssistantOverlayStore.setState({ open: false, selectedKey: null, composing: false });
  useSettingsStore.setState({ settings: { assistant: true } as unknown as Settings });
  await act(async () => {
    await ensureAssistantScopeHydrated();
  });
});
afterEach(() => cleanup());

describe("a chat whose CLI quit", () => {
  it("starts again when asked, on the pane that owns its PTY, and never while it runs", () => {
    const key = assistantTabs()[0].key;
    startAssistantChat(key);
    expect(useOverlayAgentStore.getState().assistantStartedKeys.has(key)).toBe(true);
    // Running: asking again changes nothing (the phone opening a live chat).
    startAssistantChat(key);
    expect(relaunchSeq(key)).toBe(0);

    emit("terminal-exit", key);
    expect(useOverlayAgentStore.getState().assistantEndedKeys.has(key)).toBe(true);
    startAssistantChat(key);
    expect(relaunchSeq(key)).toBe(1);
    expect(useOverlayAgentStore.getState().assistantEndedKeys.has(key)).toBe(false);

    // The respawn's `terminal-ready` clears the mark as well.
    emit("terminal-exit", key);
    emit("terminal-ready", key);
    startAssistantChat(key);
    expect(relaunchSeq(key)).toBe(1);
  });

  it("shows the overlay a note with a Restart button that respawns it", async () => {
    const key = assistantTabs()[0].key;
    useAssistantOverlayStore.getState().openOverlay(key);
    render(<AssistantOverlayHost />);
    await waitFor(() => expect(screen.getByTestId(`pane-attach-${key}`)).toBeTruthy());
    expect(screen.queryByText("Restart chat")).toBeNull();
    expect(useOverlayAgentStore.getState().assistantStartedKeys.has(key)).toBe(true);

    emit("terminal-exit", key);
    fireEvent.click(screen.getByText("Restart chat"));
    expect(relaunchSeq(key)).toBe(1);
    expect(screen.queryByText("Restart chat")).toBeNull();
  });
});
