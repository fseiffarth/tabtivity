/**
 * The Tabby scope in the tabs store and the pane layer (S4a,
 * `docs/assistant_plan.md`): the chats are agent tabs of `tabsByScope.assistant`,
 * restored lazily from `sessions/assistant/`, persisted with no project file,
 * mounted when the backend makes one (`workspace:patch` `created`), spawned from
 * their `assistant` launch alone, and never the panel's scope or a project.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

type Call = [string, Record<string, unknown> | undefined];
const calls: Call[] = [];
let snapshot: Record<string, unknown> = {};
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args?: Record<string, unknown>) => {
    calls.push([cmd, args]);
    if (cmd === "workspace_snapshot") return Promise.resolve(snapshot);
    return Promise.resolve(undefined);
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
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

const panes: Array<{ tab: { key: string }; scope: string; visible: boolean; attachOnly?: boolean; readerAlways?: boolean }> = [];
vi.mock("../../components/tabs/TabPane", () => ({
  TabPane: (props: { tab: { key: string }; scope: string; visible: boolean; attachOnly?: boolean; readerAlways?: boolean }) => {
    panes.push(props);
    return <div data-testid={`pane-${props.scope}-${props.tab.key}-${props.attachOnly ? "attach" : "own"}`} data-visible={String(props.visible)} />;
  },
}));

import { envName } from "../../lib/brand";
import { ASSISTANT_SCOPE } from "../../lib/assistant";
import { tabTerminalSpawn } from "../../lib/terminal/terminalSpawn";
import { jumpToTab } from "../../lib/shortcuts/tabJump";
import {
  _resetSyncBaseForTest,
  applyWorkspacePatch,
  useTabsStore,
  type SavedTabEntry,
  type TabEntry,
} from "../../stores/tabs";
import {
  addTabToAssistant,
  assistantTabs,
  ensureAssistantScopeHydrated,
  mountAssistantChat,
  startAssistantChat,
} from "../../stores/assistantScope";
import { useProjectsStore } from "../../stores/projects";
import { useOverlayAgentStore } from "../../stores/overlayAgent";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { CenterPanel } from "../../components/layout/CenterPanel";
import { OverlayAgentColumn } from "../../components/layout/OverlayAgentColumn";
import { AssistantScopeHost } from "../../components/layout/AssistantScopeHost";

const UID_A = "11111111-1111-4111-8111-111111111111";
const UID_B = "22222222-2222-4222-8222-222222222222";

function chat(id: string, uid: string, over: Partial<SavedTabEntry> = {}): SavedTabEntry {
  return {
    key: `saved-${id}`,
    id,
    label: "Chat",
    cmd: "claude",
    cwd: `/state/assistant/work/${uid}`,
    kind: "agent",
    sessionId: uid,
    assistant: { cli: "claude" },
    createdVersion: 1,
    ...over,
  } as SavedTabEntry;
}

function resetStores() {
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
  useProjectsStore.setState({ projects: [], activeId: "p1", rootDir: "/r" });
  useOverlayAgentStore.setState({ shownKeys: new Set(), assistantShownKeys: new Set(), assistantStartedKeys: new Set() });
  useRootOverlayStore.setState({ open: false, installTabs: {} });
}

beforeEach(() => {
  cleanup();
  calls.length = 0;
  panes.length = 0;
  snapshot = {};
  localStorage.clear();
  resetStores();
});
afterEach(() => cleanup());

describe("restoring the scope", () => {
  it("restores the saved chats lazily, without touching the active project or the store's scope", async () => {
    snapshot = {
      version: 4,
      tabLayout: [chat("a", UID_A), chat("b", UID_B, { assistant: { cli: "codex" }, cmd: "codex" })],
      tabGroups: null,
    };
    expect(ASSISTANT_SCOPE in useTabsStore.getState().tabsByScope).toBe(false);

    await act(async () => {
      expect(await ensureAssistantScopeHydrated()).toBe(true);
    });

    const chats = assistantTabs();
    expect(chats.map((t) => [t.id, t.assistant?.cli, t.sessionId])).toEqual([
      ["a", "claude", UID_A],
      ["b", "codex", UID_B],
    ]);
    // Opening Tabby is not a project switch.
    expect(useProjectsStore.getState().activeId).toBe("p1");
    expect(useTabsStore.getState().scope).toBe("p1");
    expect(useTabsStore.getState().workspaceVersionByScope[ASSISTANT_SCOPE]).toBe(4);
    // The record is a chat: the saved cwd is kept (the backend rewrites it), the
    // uid reaches the spawn through the session id, and no schedule is minted.
    expect(chats[0].cwd).toBe(`/state/assistant/work/${UID_A}`);
    expect(chats[0].scheduleTargetId).toBeUndefined();
    expect(chats[0].env?.[envName("TAB_UID")]).toBe(UID_A);
    expect(chats[0].hostSession).toBeUndefined();
    // Hydrating again reads nothing.
    const reads = calls.filter(([c]) => c === "workspace_snapshot").length;
    await ensureAssistantScopeHydrated();
    expect(calls.filter(([c]) => c === "workspace_snapshot").length).toBe(reads);
  });

  it("drops a saved tab without a readable launch, and an empty scope still counts as hydrated", async () => {
    snapshot = { version: 2, tabLayout: [chat("x", UID_A, { assistant: undefined }), chat("y", UID_B, { assistant: { cli: 7 } as never })] };
    await act(async () => {
      expect(await ensureAssistantScopeHydrated()).toBe(true);
    });
    expect(assistantTabs()).toEqual([]);
    expect(ASSISTANT_SCOPE in useTabsStore.getState().tabsByScope).toBe(true);
  });

  it("keeps the launch only in the assistant scope: a project's layout file cannot plant one", async () => {
    snapshot = { version: 1, tabLayout: [chat("p", UID_A)] };
    await useTabsStore.getState().loadFromLayout([chat("p", UID_A)], "/proj", "p1");
    const planted = useTabsStore.getState().tabsByScope.p1[0];
    expect(planted.assistant).toBeUndefined();
  });

  it("persists with no project file and restores the same chats after a restart", async () => {
    snapshot = { version: 4, tabLayout: [chat("a", UID_A)] };
    vi.useFakeTimers();
    try {
      render(<AssistantScopeHost />);
      await act(async () => {
        await ensureAssistantScopeHydrated();
      });
      calls.length = 0;
      // The user adds a second chat in the window.
      await act(async () => {
        addTabToAssistant({
          label: "Chat 2",
          cmd: "opencode",
          cwd: `/state/assistant/work/${UID_B}`,
          kind: "agent",
          sessionId: UID_B,
          assistant: { cli: "opencode_local", model: "qwen3:8b" },
        });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
    } finally {
      vi.useRealTimers();
    }
    const sync = calls.filter(([c]) => c === "workspace_sync").pop();
    expect(sync).toBeTruthy();
    const payload = sync![1] as { projectId: string; localFile: string; tabs: SavedTabEntry[] };
    expect(payload.projectId).toBe(ASSISTANT_SCOPE);
    expect(payload.localFile).toBe("");
    expect(payload.tabs.map((t) => t.assistant)).toEqual([{ cli: "claude" }, { cli: "opencode_local", model: "qwen3:8b" }]);

    // A restart: nothing in memory, the stored set is what was sent.
    cleanup();
    resetStores();
    snapshot = { version: 5, tabLayout: payload.tabs.map((t, i) => ({ ...t, id: `id-${i}` })) };
    await act(async () => {
      await ensureAssistantScopeHydrated();
    });
    expect(assistantTabs().map((t) => [t.assistant, t.sessionId])).toEqual([
      [{ cli: "claude" }, UID_A],
      [{ cli: "opencode_local", model: "qwen3:8b" }, UID_B],
    ]);
  });

  it("writes nothing before the scope was restored (an absent key is not an empty scope)", async () => {
    vi.useFakeTimers();
    try {
      render(<AssistantScopeHost />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    } finally {
      vi.useRealTimers();
    }
    expect(calls.filter(([c]) => c === "workspace_sync")).toEqual([]);
  });
});

describe("a chat the backend made", () => {
  it("is mounted from the created patch of a hydrated scope, without becoming active anywhere", async () => {
    snapshot = { version: 4, tabLayout: [] };
    await act(async () => {
      await ensureAssistantScopeHydrated();
    });
    // assistant_new_chat stored a chat at version 5 and emitted the patch.
    snapshot = { version: 5, tabLayout: [chat("new", UID_A, { createdVersion: 5, key: "owner-key" })] };
    await act(async () => {
      await applyWorkspacePatch({ scope: ASSISTANT_SCOPE, version: 5, ops: [{ op: "created", id: "new" }] });
    });
    const chats = assistantTabs();
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({ id: "new", scope: ASSISTANT_SCOPE, assistant: { cli: "claude" }, sessionId: UID_A });
    expect(chats[0].key).not.toBe("owner-key");
    expect(chats[0].tmuxSession).toBeTruthy();
    expect(useProjectsStore.getState().activeId).toBe("p1");
    expect(useTabsStore.getState().scope).toBe("p1");
  });

  it("mountAssistantChat hydrates first, finds the tab by its id, and mounts it once however it arrives", async () => {
    snapshot = { version: 5, tabLayout: [chat("new", UID_A, { createdVersion: 5 })] };
    const result: { tab: TabEntry | null } = { tab: null };
    await act(async () => {
      // The patch and the explicit mount race: whichever lands second finds it held.
      const mounted = mountAssistantChat("new");
      await applyWorkspacePatch({ scope: ASSISTANT_SCOPE, version: 5, ops: [{ op: "created", id: "new" }] });
      result.tab = await mounted;
    });
    expect(result.tab?.id).toBe("new");
    expect(assistantTabs()).toHaveLength(1);
  });

  it("mountAssistantChat re-reads the stored set when the scope was already hydrated", async () => {
    snapshot = { version: 4, tabLayout: [] };
    await act(async () => {
      await ensureAssistantScopeHydrated();
    });
    snapshot = { version: 6, tabLayout: [chat("late", UID_B, { createdVersion: 6 })] };
    const result: { tab: TabEntry | null } = { tab: null };
    await act(async () => {
      result.tab = await mountAssistantChat("late");
    });
    expect(result.tab?.sessionId).toBe(UID_B);
    expect(await mountAssistantChat("missing")).toBeNull();
  });
});

describe("the spawn of a chat", () => {
  it("carries the launch and the uid and nothing else the record says", async () => {
    snapshot = { version: 1, tabLayout: [chat("a", UID_A, { env: { EVIL: "1" }, scheduleTargetId: "s", hostSession: true } as Partial<SavedTabEntry>)] };
    await act(async () => {
      await ensureAssistantScopeHydrated();
    });
    const tab = { ...assistantTabs()[0], args: ["--dangerously-skip-permissions"], env: { EVIL: "1" } };
    const spawn = tabTerminalSpawn(tab, ASSISTANT_SCOPE, { terminalCwd: tab.cwd });
    expect(spawn).toMatchObject({
      id: `assistant:${tab.key}`,
      cmd: "claude",
      args: [],
      env: { [envName("TAB_UID")]: UID_A },
      projectId: ASSISTANT_SCOPE,
      assistant: { cli: "claude" },
      hostSession: false,
      remoteHostId: null,
      tmuxAttach: null,
    });
    expect(spawn.scheduleTargetId).toBeUndefined();
  });

  it("sends no launch for a tab of any other scope", () => {
    const tab = { key: "k", label: "c", cmd: "claude", cwd: "/p", kind: "agent" as const, assistant: { cli: "claude" }, env: { A: "1" } };
    const spawn = tabTerminalSpawn(tab, "p1", { terminalCwd: "/p" });
    expect(spawn.assistant).toBeNull();
    expect(spawn.env).toEqual({ A: "1" });
  });
});

describe("the pane layer", () => {
  async function withOneChat() {
    snapshot = { version: 1, tabLayout: [chat("a", UID_A)] };
    await act(async () => {
      await ensureAssistantScopeHydrated();
    });
    // A restored chat runs only once it was shown (or made): the overlay does
    // this for the chat it shows.
    act(() => startAssistantChat(assistantTabs()[0].key));
    return assistantTabs()[0];
  }

  it("mounts the chat's own pane once, hidden in the panel, and the overlay's attach-only view beside it", async () => {
    const chatTab = await withOneChat();
    const { unmount } = render(<CenterPanel />);
    await act(async () => {});
    const own = document.querySelectorAll(`[data-testid="pane-${ASSISTANT_SCOPE}-${chatTab.key}-own"]`);
    expect(own).toHaveLength(1);
    // The panel never shows the Tabby scope, whatever the store's scope is.
    expect(own[0].getAttribute("data-visible")).toBe("false");
    unmount();

    // The overlay's host: one attach-only view, marked shown under its scope.
    const view = render(
      <OverlayAgentColumn app="calendar" scope={ASSISTANT_SCOPE} readerAlways tab={chatTab} hint={null} />,
    );
    await act(async () => {});
    useOverlayAgentStore.setState((s) => ({ docks: { ...s.docks, calendar: { key: chatTab.key, open: true } } }));
    view.rerender(<OverlayAgentColumn app="calendar" scope={ASSISTANT_SCOPE} readerAlways tab={chatTab} hint={null} />);
    await act(async () => {});
    const last = panes[panes.length - 1];
    expect(last).toMatchObject({ scope: ASSISTANT_SCOPE, attachOnly: true, visible: true, readerAlways: true });
    expect(useOverlayAgentStore.getState().assistantShownKeys.has(chatTab.key)).toBe(true);
    expect(useOverlayAgentStore.getState().shownKeys.has(chatTab.key)).toBe(false);
    // Neither the root rights badge nor the open-in-console button belong to it.
    expect(document.querySelector(".root-overlay-rights")).toBeNull();
    expect(document.querySelector('button[aria-label="Open in the root console"]')).toBeNull();
    expect(calls.filter(([c]) => c === "root_mcp_status")).toEqual([]);
    view.unmount();
    expect(useOverlayAgentStore.getState().assistantShownKeys.has(chatTab.key)).toBe(false);
  });

  it("spawns none of the saved chats at hydrate, and each one when it is first shown", async () => {
    const ids = ["a", "b", "c"];
    snapshot = {
      version: 3,
      tabLayout: ids.map((id, i) => chat(id, `${i}${i}${i}${i}${i}${i}${i}${i}-1111-4111-8111-111111111111`)),
    };
    await act(async () => {
      await ensureAssistantScopeHydrated();
    });
    render(<CenterPanel />);
    await act(async () => {});
    const chats = assistantTabs();
    expect(chats).toHaveLength(3);
    // Three saved chats, three records: not one pane, so not one PTY.
    expect(document.querySelectorAll('[data-testid^="pane-assistant-"]')).toHaveLength(0);
    expect(panes.filter((p) => p.scope === ASSISTANT_SCOPE)).toEqual([]);

    // Showing one starts that one.
    await act(async () => {
      startAssistantChat(chats[1].key);
    });
    const owned = Array.from(document.querySelectorAll('[data-testid^="pane-assistant-"]'));
    expect(owned.map((n) => n.getAttribute("data-testid"))).toEqual([`pane-${ASSISTANT_SCOPE}-${chats[1].key}-own`]);

    // A chat the backend just made (or the phone opened) mounts started.
    snapshot = { version: 4, tabLayout: [...(snapshot.tabLayout as SavedTabEntry[]), chat("d", UID_B, { createdVersion: 4 })] };
    await act(async () => {
      await mountAssistantChat("d");
    });
    expect(document.querySelectorAll('[data-testid^="pane-assistant-"]')).toHaveLength(2);
  });

  it("never treats the Tabby scope as the current one, even when the store's scope says so", async () => {
    const chatTab = await withOneChat();
    useTabsStore.setState({ scope: ASSISTANT_SCOPE });
    render(<CenterPanel />);
    await act(async () => {});
    const own = document.querySelector(`[data-testid="pane-${ASSISTANT_SCOPE}-${chatTab.key}-own"]`);
    expect(own?.getAttribute("data-visible")).toBe("false");
  });
});

describe("jumping to a chat", () => {
  it("reveals the tab and never activates a project named like the scope", async () => {
    snapshot = { version: 1, tabLayout: [chat("a", UID_A)] };
    await act(async () => {
      await ensureAssistantScopeHydrated();
    });
    const setActive = vi.fn(() => Promise.resolve());
    const original = useProjectsStore.getState().setActive;
    useProjectsStore.setState({ setActive: setActive as never });
    try {
      jumpToTab(ASSISTANT_SCOPE, assistantTabs()[0].key);
      await act(async () => {});
    } finally {
      useProjectsStore.setState({ setActive: original });
    }
    expect(setActive).not.toHaveBeenCalled();
    expect(useProjectsStore.getState().activeId).toBe("p1");
  });
});
