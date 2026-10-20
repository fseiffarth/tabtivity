/**
 * Tabby's side-panel view (the rail icon that opens it is in
 * `shell/SidePanelEdgeRail.test.tsx`): polling only while shown, one chat —
 * the newest, started when shown (lazy spawn) or made on the default CLI when
 * there is none — the head's CLI/model dropdown and Relaunch replacing it, the
 * sign-in and search setup cards.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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
          chat(made.tabId, made.uid, {
            createdVersion: 9,
            label: "Fresh",
            assistant: args?.model ? { cli: String(args.cli), model: String(args.model) } : { cli: String(args?.cli) },
          } as Partial<SavedTabEntry>),
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
  useAssistantViewStore.setState({ selectedKey: null });
  setFlag(true);
}

const optionCalls = () => calls.filter(([c]) => c === "assistant_options").length;
const own = (key: string) => document.querySelector(`[data-testid="pane-own-${key}"]`);
const attached = () => Array.from(document.querySelectorAll('[data-testid^="pane-attach-"]'));
const newChatCalls = () => calls.filter(([c]) => c === "assistant_new_chat").map(([, a]) => a);

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

  it("shows the newest chat alone, with its CLI in the head", async () => {
    await show();
    const newest = assistantTabs().find((t) => t.id === "b")!;
    // The attach-only view of the shown chat, Reader always on; no chat list.
    const views = attached();
    expect(views).toHaveLength(1);
    expect(views[0].getAttribute("data-testid")).toBe(`pane-attach-${newest.key}`);
    expect(views[0].getAttribute("data-reader-always")).toBe("true");
    expect(document.querySelector(".assistant-chat-row")).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "CLI" }).textContent).toContain("Codex"));
    // Showing Tabby is not a project switch, and a saved chat starts no new one.
    expect(useProjectsStore.getState().activeId).toBe("p1");
    expect(useTabsStore.getState().scope).toBe("p1");
    expect(newChatCalls()).toEqual([]);
  });

  it("opens on the chat a jump names", async () => {
    await act(async () => {
      const { ensureAssistantScopeHydrated } = await import("../../stores/assistantScope");
      await ensureAssistantScopeHydrated();
    });
    const old = assistantTabs().find((t) => t.id === "a")!;
    await show(old.key);
    expect(attached()[0].getAttribute("data-testid")).toBe(`pane-attach-${old.key}`);
  });
});

describe("lazy spawn", () => {
  it("starts only the shown chat's CLI", async () => {
    render(<CenterPanel />);
    await act(async () => {});
    // Tabby has not been shown: nothing hydrated, nothing spawned.
    expect(ASSISTANT_SCOPE in useTabsStore.getState().tabsByScope).toBe(false);

    await show();
    const [oldChat, newest] = [assistantTabs().find((t) => t.id === "a")!, assistantTabs().find((t) => t.id === "b")!];
    expect(assistantTabs()).toHaveLength(2);
    expect(own(newest.key)).not.toBeNull();
    expect(own(oldChat.key)).toBeNull();
  });
});

describe("with no chat", () => {
  beforeEach(() => {
    snapshot = { version: 4, tabLayout: [] };
  });

  it("starts one on the default CLI at once and shows it", async () => {
    await show();
    await waitFor(() => expect(assistantTabs().some((t) => t.id === "fresh")).toBe(true));
    expect(newChatCalls()).toEqual([{ cli: "claude", model: null }]);
    const fresh = assistantTabs().find((t) => t.id === "fresh")!;
    await waitFor(() => expect(attached()[0]?.getAttribute("data-testid")).toBe(`pane-attach-${fresh.key}`));
  });

  it("takes the user's default local CLI and model, and the chat offers the search setup", async () => {
    useSettingsStore.setState({
      settings: { assistant: true, experimental_explicit: true, assistant_settings: { default_cli: "opencode_local", default_model: "llama3.2" } } as Settings,
    });
    await show();
    await waitFor(() => expect(newChatCalls()).toEqual([{ cli: "opencode_local", model: "llama3.2" }]));
    await waitFor(() => expect(screen.getByText("Set up web search for local models")).toBeTruthy());
  });

  it("shows no search card once a backend is configured", async () => {
    options = baseOptions({ search: { ...SEARCH_OFF, kind: "searxng", searxngUrl: "https://s.example", configured: true } });
    useSettingsStore.setState({
      settings: { assistant: true, experimental_explicit: true, assistant_settings: { default_cli: "opencode_local" } } as Settings,
    });
    await show();
    await waitFor(() => expect(attached()).toHaveLength(1));
    expect(screen.queryByText("Set up web search for local models")).toBeNull();
  });

  it("waits on a signed-out default CLI behind its one-click sign-in, then starts", async () => {
    options = baseOptions({ defaultCli: "codex" });
    await show();
    await waitFor(() => expect(screen.getByText("Sign in to Codex", { selector: ".assistant-card-title" })).toBeTruthy());
    expect(newChatCalls()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Codex" }));
    expect(runInstallInTab).toHaveBeenCalledTimes(1);
    const [label, command, shell] = runInstallInTab.mock.calls[0];
    expect(label).toContain("Codex");
    expect(command).toBe("codex login --device-auth");
    expect(shell).toBe("default");
    // Signed in: Check again re-reads the options and the chat starts.
    const signedIn = baseOptions({ defaultCli: "codex" });
    (signedIn.clis[1] as Record<string, unknown>).signedIn = true;
    (signedIn.clis[1] as Record<string, unknown>).ready = true;
    options = signedIn;
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(newChatCalls()).toEqual([{ cli: "codex", model: null }]));
  });

  it("blocks a local CLI while Ollama is down", async () => {
    options = baseOptions({ ollamaReachable: false, localModels: [] });
    useSettingsStore.setState({
      settings: { assistant: true, experimental_explicit: true, assistant_settings: { default_cli: "opencode_local" } } as Settings,
    });
    await show();
    await waitFor(() => expect(screen.getByText("Ollama isn't running")).toBeTruthy());
    expect(newChatCalls()).toEqual([]);
  });

  it("reports a refusal, starts nothing, and Start tries again", async () => {
    newChatRefusal = "not_offered: that CLI isn't offered";
    await show();
    expect((await screen.findByRole("alert")).textContent).toContain("not_offered");
    expect(assistantTabs()).toHaveLength(0);
    expect(newChatCalls()).toHaveLength(1);
    newChatRefusal = null;
    fireEvent.click(screen.getByRole("button", { name: "Start chat" }));
    await waitFor(() => expect(assistantTabs().some((t) => t.id === "fresh")).toBe(true));
  });
});

describe("replacing the chat", () => {
  it("picking another CLI starts a chat on it and removes the others", async () => {
    await show();
    await waitFor(() => expect(screen.getByRole("button", { name: "CLI" }).textContent).toContain("Codex"));
    fireEvent.click(screen.getByRole("button", { name: "CLI" }));
    fireEvent.click(screen.getByRole("option", { name: "Claude" }));
    await waitFor(() => expect(assistantTabs().map((t) => t.id)).toEqual(["fresh"]));
    expect(newChatCalls()).toEqual([{ cli: "claude", model: null }]);
    const fresh = assistantTabs()[0];
    await waitFor(() => expect(attached()[0]?.getAttribute("data-testid")).toBe(`pane-attach-${fresh.key}`));
  });

  it("picking a local CLI asks for its model in the head", async () => {
    await show();
    await waitFor(() => expect(screen.getByRole("button", { name: "CLI" }).textContent).toContain("Codex"));
    fireEvent.click(screen.getByRole("button", { name: "CLI" }));
    fireEvent.click(screen.getByRole("option", { name: "OpenCode (local model)" }));
    await waitFor(() => expect(newChatCalls()).toEqual([{ cli: "opencode_local", model: "qwen3:8b" }]));
    await waitFor(() => expect(screen.getByRole("button", { name: "Local model" }).textContent).toContain("qwen3:8b"));
    fireEvent.click(screen.getByRole("button", { name: "Local model" }));
    newChat = { tabId: "fresh2", uid: UID_A };
    fireEvent.click(screen.getByRole("option", { name: "llama3.2" }));
    await waitFor(() => expect(newChatCalls()).toEqual([
      { cli: "opencode_local", model: "qwen3:8b" },
      { cli: "opencode_local", model: "llama3.2" },
    ]));
  });

  it("a signed-out pick shows its sign-in card and keeps the chat", async () => {
    await show(await assistantTabsKey("a"));
    fireEvent.click(screen.getByRole("button", { name: "CLI" }));
    fireEvent.click(screen.getByRole("option", { name: "Codex" }));
    expect(screen.getByText("Sign in to Codex", { selector: ".assistant-card-title" })).toBeTruthy();
    expect(newChatCalls()).toEqual([]);
    expect(assistantTabs()).toHaveLength(2);
    // Back to the chat's own CLI: the chat again, nothing started.
    fireEvent.click(screen.getByRole("button", { name: "CLI" }));
    fireEvent.click(screen.getByRole("option", { name: "Claude" }));
    expect(attached()).toHaveLength(1);
    expect(newChatCalls()).toEqual([]);
  });

  it("Relaunch starts a fresh session of the same CLI", async () => {
    await show(await assistantTabsKey("a"));
    fireEvent.click(screen.getByRole("button", { name: "Relaunch" }));
    await waitFor(() => expect(assistantTabs().map((t) => t.id)).toEqual(["fresh"]));
    expect(newChatCalls()).toEqual([{ cli: "claude", model: null }]);
  });
});

/** The key chat `id` restored under (hydrating the scope first). */
async function assistantTabsKey(id: string): Promise<string> {
  await act(async () => {
    const { ensureAssistantScopeHydrated } = await import("../../stores/assistantScope");
    await ensureAssistantScopeHydrated();
  });
  return assistantTabs().find((t) => t.id === id)!.key;
}

describe("a restored chat whose CLI is signed out", () => {
  it("shows the sign-in card above the chat", async () => {
    await show();
    // The newest chat ("b") is a Codex chat, and Codex is signed out.
    await waitFor(() => expect(screen.getByRole("button", { name: "Sign in to Codex" })).toBeTruthy());
    expect(attached()).toHaveLength(1);
  });
});
