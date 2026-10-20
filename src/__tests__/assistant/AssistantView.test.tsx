/**
 * Tabby's side-panel view (S4b, `docs/assistant_plan.md`; the rail icon that
 * opens it is in `shell/SidePanelEdgeRail.test.tsx`): polling only while
 * shown, the chat list newest first, a chat's CLI started when it is first shown (lazy spawn),
 * deleting a chat, the new-chat flow with the CLI/model picker, the sign-in and
 * search setup cards.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

type Call = [string, Record<string, unknown> | undefined];
const calls: Call[] = [];
let snapshot: Record<string, unknown> = {};
let options: Record<string, unknown> = {};
let newChat: { tabId: string; uid: string } | null = null;
let newChatRefusal: string | null = null;
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args?: Record<string, unknown>) => {
    calls.push([cmd, args]);
    if (cmd === "workspace_snapshot") return Promise.resolve(snapshot);
    if (cmd === "assistant_options") return Promise.resolve(options);
    if (cmd === "assistant_new_chat") {
      if (newChatRefusal) return Promise.reject(newChatRefusal);
      const made = newChat!;
      snapshot = {
        version: 9,
        tabLayout: [
          ...(snapshot.tabLayout as unknown[]),
          chat(made.tabId, made.uid, { createdVersion: 9, label: "Fresh" }),
        ],
      };
      return Promise.resolve({ ...made, scope: "assistant", version: 9 });
    }
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

type PaneProps = { tab: { key: string }; scope: string; visible: boolean; attachOnly?: boolean; readerAlways?: boolean };
vi.mock("../../components/tabs/TabPane", () => ({
  TabPane: (props: PaneProps) => (
    <div
      data-testid={`pane-${props.attachOnly ? "attach" : "own"}-${props.tab.key}`}
      data-reader-always={String(!!props.readerAlways)}
    />
  ),
}));
const runInstallInTab = vi.fn();
vi.mock("../../lib/installCommand", async (orig) => ({
  ...(await orig<typeof import("../../lib/installCommand")>()),
  runInstallInTab: (...args: unknown[]) => runInstallInTab(...args),
}));

import { ASSISTANT_SCOPE } from "../../lib/assistant";
import { AssistantView } from "../../components/assistant/AssistantView";
import { CenterPanel } from "../../components/layout/CenterPanel";
import { _resetSyncBaseForTest, useTabsStore, type SavedTabEntry } from "../../stores/tabs";
import { assistantTabs } from "../../stores/assistantScope";
import { useAssistantViewStore } from "../../stores/assistantView";
import { useOverlayAgentStore } from "../../stores/overlayAgent";
import { useProjectsStore } from "../../stores/projects";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { useSettingsStore } from "../../stores/settings";
import type { Settings } from "../../types";

const UID_A = "11111111-1111-4111-8111-111111111111";
const UID_B = "22222222-2222-4222-8222-222222222222";
const UID_C = "33333333-3333-4333-8333-333333333333";

function chat(id: string, uid: string, over: Partial<SavedTabEntry> = {}): SavedTabEntry {
  return {
    key: `saved-${id}`,
    id,
    label: id,
    cmd: "claude",
    cwd: `/state/assistant/work/${uid}`,
    kind: "agent",
    sessionId: uid,
    assistant: { cli: "claude" },
    createdVersion: 1,
    ...over,
  } as SavedTabEntry;
}

const SEARCH_OFF = { kind: null, searxngUrl: null, ollamaKeyStored: false, keyring: "unlocked", configured: false };
function baseOptions(over: Record<string, unknown> = {}) {
  return {
    clis: [
      { id: "claude", label: "Claude", local: false, installed: true, signedIn: true, ready: true },
      { id: "codex", label: "Codex", local: false, installed: true, signedIn: false, ready: false },
      { id: "opencode_local", label: "OpenCode (local model)", local: true, installed: true, signedIn: null, ready: true },
    ],
    localModels: ["qwen3:8b", "llama3.2"],
    ollamaReachable: true,
    defaultCli: "claude",
    defaultModel: null,
    search: SEARCH_OFF,
    ...over,
  };
}

function setFlag(on: boolean) {
  useSettingsStore.setState({ settings: { assistant: on, experimental_explicit: true } as Settings });
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
  useAssistantViewStore.setState({ selectedKey: null, composing: false });
  setFlag(true);
}

const optionCalls = () => calls.filter(([c]) => c === "assistant_options").length;
const own = (key: string) => document.querySelector(`[data-testid="pane-own-${key}"]`);
const attached = () => Array.from(document.querySelectorAll('[data-testid^="pane-attach-"]'));
const rowLabels = () => Array.from(document.querySelectorAll(".assistant-chat-label")).map((n) => n.textContent);

/** Show the view (the side panel mounts it only while it is on show),
 *  on `chatKey` when given. */
async function show(chatKey?: string) {
  if (chatKey) useAssistantViewStore.getState().select(chatKey);
  const view = render(<AssistantView />);
  await act(async () => {});
  await act(async () => {});
  return view;
}

beforeEach(() => {
  cleanup();
  calls.length = 0;
  runInstallInTab.mockClear();
  localStorage.clear();
  snapshot = { version: 4, tabLayout: [chat("a", UID_A, { label: "Old chat" }), chat("b", UID_B, { label: "Newer chat", assistant: { cli: "codex" }, cmd: "codex" })] };
  options = baseOptions();
  newChat = { tabId: "fresh", uid: UID_C };
  newChatRefusal = null;
  resetStores();
});
afterEach(() => cleanup());

describe("the view", () => {
  it("reads the options once it is shown, and no more after it is gone", async () => {
    const view = await show();
    await waitFor(() => expect(optionCalls()).toBe(1));
    view.unmount();
    expect(optionCalls()).toBe(1);
  });

  it("lists the chats newest first and shows the newest one", async () => {
    await show();
    expect(rowLabels()).toEqual(["Newer chat", "Old chat"]);
    const newest = assistantTabs().find((t) => t.id === "b")!;
    expect(document.querySelector(".assistant-chat-row.active")?.textContent).toContain("Newer chat");
    // The attach-only view of the shown chat, Reader always on.
    const views = attached();
    expect(views).toHaveLength(1);
    expect(views[0].getAttribute("data-testid")).toBe(`pane-attach-${newest.key}`);
    expect(views[0].getAttribute("data-reader-always")).toBe("true");
    // Showing Tabby is not a project switch.
    expect(useProjectsStore.getState().activeId).toBe("p1");
    expect(useTabsStore.getState().scope).toBe("p1");
  });

  it("opens on the chat a jump names", async () => {
    await act(async () => {
      const { ensureAssistantScopeHydrated } = await import("../../stores/assistantScope");
      await ensureAssistantScopeHydrated();
    });
    const old = assistantTabs().find((t) => t.id === "a")!;
    await show(old.key);
    expect(document.querySelector(".assistant-chat-row.active")?.textContent).toContain("Old chat");
    expect(attached()[0].getAttribute("data-testid")).toBe(`pane-attach-${old.key}`);
  });

});

describe("lazy spawn", () => {
  it("starts a restored chat's CLI only when it is first shown", async () => {
    render(<CenterPanel />);
    await act(async () => {});
    // Tabby has not been shown: nothing hydrated, nothing spawned.
    expect(ASSISTANT_SCOPE in useTabsStore.getState().tabsByScope).toBe(false);

    await show();
    const [oldChat, newest] = [assistantTabs().find((t) => t.id === "a")!, assistantTabs().find((t) => t.id === "b")!];
    // Two chats were restored; only the one shown owns a pane (= a PTY).
    expect(assistantTabs()).toHaveLength(2);
    expect(own(newest.key)).not.toBeNull();
    expect(own(oldChat.key)).toBeNull();

    // Picking the other one starts it; the first keeps running.
    fireEvent.click(screen.getByText("Old chat"));
    await act(async () => {});
    expect(own(oldChat.key)).not.toBeNull();
    expect(own(newest.key)).not.toBeNull();
  });
});

describe("deleting a chat", () => {
  it("removes the tab from the scope and falls back to the next chat", async () => {
    await show();
    const newest = assistantTabs().find((t) => t.id === "b")!;
    const row = document.querySelector(".assistant-chat-row.active") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Delete this chat" }));
    await act(async () => {});
    expect(assistantTabs().map((t) => t.id)).toEqual(["a"]);
    expect(assistantTabs().some((t) => t.key === newest.key)).toBe(false);
    expect(rowLabels()).toEqual(["Old chat"]);
    expect(document.querySelector(".assistant-chat-row.active")?.textContent).toContain("Old chat");
  });
});

describe("a new chat", () => {
  async function openForm() {
    await show();
    fireEvent.click(screen.getByRole("button", { name: /\+ New chat/ }));
    await act(async () => {});
  }

  it("starts with the default CLI, mounts the chat the backend made and shows it", async () => {
    await openForm();
    expect(screen.getByRole("button", { name: "CLI" }).textContent).toContain("Claude");
    fireEvent.click(screen.getByRole("button", { name: "Start chat" }));
    await waitFor(() => expect(assistantTabs().some((t) => t.id === "fresh")).toBe(true));
    expect(calls.filter(([c]) => c === "assistant_new_chat")).toEqual([["assistant_new_chat", { cli: "claude", model: null }]]);
    const fresh = assistantTabs().find((t) => t.id === "fresh")!;
    await waitFor(() => expect(attached()[0]?.getAttribute("data-testid")).toBe(`pane-attach-${fresh.key}`));
    expect(document.querySelector(".assistant-chat-row.active")?.textContent).toContain("Fresh");
    // The scope was hydrated before the chat was made (the restored ones are kept).
    expect(assistantTabs()).toHaveLength(3);
  });

  it("asks for a model with a local CLI, preselecting the user's default, and offers the search setup", async () => {
    useSettingsStore.setState({
      settings: { assistant: true, experimental_explicit: true, assistant_settings: { default_cli: "opencode_local", default_model: "llama3.2" } } as Settings,
    });
    await openForm();
    expect(screen.getByRole("button", { name: "CLI" }).textContent).toContain("OpenCode");
    expect(screen.getByRole("button", { name: "Local model" }).textContent).toContain("llama3.2");
    // No search backend: the card says so and offers the form.
    expect(screen.getByText("Set up web search for local models")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Local model" }));
    fireEvent.click(screen.getByRole("option", { name: "qwen3:8b" }));
    fireEvent.click(screen.getByRole("button", { name: "Start chat" }));
    await waitFor(() => expect(calls.some(([c]) => c === "assistant_new_chat")).toBe(true));
    expect(calls.find(([c]) => c === "assistant_new_chat")![1]).toEqual({ cli: "opencode_local", model: "qwen3:8b" });
  });

  it("shows no search card once a backend is configured", async () => {
    options = baseOptions({ search: { ...SEARCH_OFF, kind: "searxng", searxngUrl: "https://s.example", configured: true } });
    useSettingsStore.setState({
      settings: { assistant: true, experimental_explicit: true, assistant_settings: { default_cli: "opencode_local" } } as Settings,
    });
    await openForm();
    expect(screen.queryByText("Set up web search for local models")).toBeNull();
  });

  it("says why it can't start: a CLI that is not signed in gets the one-click sign-in", async () => {
    await openForm();
    fireEvent.click(screen.getByRole("button", { name: "CLI" }));
    fireEvent.click(screen.getByRole("option", { name: "Codex" }));
    expect(screen.getByText("Sign in to Codex", { selector: ".assistant-card-title" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Start chat" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Codex" }));
    expect(runInstallInTab).toHaveBeenCalledTimes(1);
    const [label, command, shell] = runInstallInTab.mock.calls[0];
    expect(label).toContain("Codex");
    expect(command).toBe("codex login --device-auth");
    expect(shell).toBe("default");
    // Check again re-reads the options.
    const before = optionCalls();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(optionCalls()).toBe(before + 1));
  });

  it("blocks a local CLI while Ollama is down", async () => {
    options = baseOptions({ ollamaReachable: false, localModels: [] });
    useSettingsStore.setState({
      settings: { assistant: true, experimental_explicit: true, assistant_settings: { default_cli: "opencode_local" } } as Settings,
    });
    await openForm();
    expect(screen.getByText("Ollama isn't running")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Start chat" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("reports a refusal from the backend and starts nothing", async () => {
    newChatRefusal = "not_offered: that CLI isn't offered";
    await openForm();
    fireEvent.click(screen.getByRole("button", { name: "Start chat" }));
    expect((await screen.findByRole("alert")).textContent).toContain("not_offered");
    expect(assistantTabs()).toHaveLength(2);
  });
});

describe("a restored chat whose CLI is signed out", () => {
  it("shows the sign-in card above the chat", async () => {
    await show();
    // The newest chat ("b") is a Codex chat, and Codex is signed out.
    await waitFor(() => expect(screen.getByRole("button", { name: "Sign in to Codex" })).toBeTruthy());
    expect(attached()).toHaveLength(1);
  });
});
