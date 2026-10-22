/**
 * A Tabby chat runs with its slash commands off, so the CLI's own `/model`
 * cannot switch it. The model is the chat's launch instead: a pick rewrites the
 * tab's `assistant` block, ends its tmux session, waits for the old CLI to exit
 * and respawns the same tab (the backend resumes the conversation on the new
 * `--model`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, waitFor } from "@testing-library/react";

const handlers = new Map<string, Array<(ev: { payload: unknown }) => void>>();
let saved: Record<string, unknown>[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) => {
    if (cmd === "workspace_snapshot") return Promise.resolve({ version: 3, tabLayout: saved });
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

import { invoke } from "@tauri-apps/api/core";
import { ASSISTANT_SCOPE, assistantModelChoices, type AssistantOptions } from "../../lib/assistant";
import { _resetSyncBaseForTest, useTabsStore } from "../../stores/tabs";
import { assistantTabs, ensureAssistantScopeHydrated, startAssistantChat, switchAssistantModel } from "../../stores/assistantScope";
import { useOverlayAgentStore } from "../../stores/overlayAgent";

const UID = "11111111-1111-4111-8111-111111111111";

function chatRecord(assistant: { cli: string; model?: string }, label: string) {
  return {
    key: "saved-a",
    id: "a",
    label,
    cmd: "claude",
    cwd: `/state/assistant/work/${UID}`,
    kind: "agent",
    sessionId: UID,
    tmuxSession: `tt-assistant--agent-${UID}`,
    assistant,
    createdVersion: 1,
  };
}

function emitExit(key: string) {
  act(() => {
    for (const h of handlers.get("terminal-exit") ?? []) h({ payload: { id: `${ASSISTANT_SCOPE}:${key}`, code: null } });
  });
}

async function hydrate(record: Record<string, unknown>) {
  saved = [record];
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
  await act(async () => {
    await ensureAssistantScopeHydrated();
  });
  return assistantTabs()[0];
}

/** Switch, answering the tmux kill with the old CLI's exit. */
async function switchTo(key: string, model: string): Promise<boolean> {
  const done = switchAssistantModel(key, model);
  await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith("local_tmux_kill", expect.anything()));
  emitExit(key);
  return act(() => done);
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  vi.mocked(invoke).mockClear();
  useOverlayAgentStore.setState({ assistantShownKeys: new Set(), assistantStartedKeys: new Set(), assistantEndedKeys: new Set() });
});
afterEach(() => cleanup());

describe("switchAssistantModel", () => {
  it("respawns the same chat on the new model after its old CLI exited, not marked ended", async () => {
    const tab = await hydrate(chatRecord({ cli: "claude" }, "Claude"));
    startAssistantChat(tab.key);
    expect(await switchTo(tab.key, "sonnet")).toBe(true);
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("local_tmux_kill", { session: tab.tmuxSession });
    const after = assistantTabs()[0];
    expect(after.key).toBe(tab.key);
    expect(after.assistant).toEqual({ cli: "claude", model: "sonnet" });
    expect(after.label).toBe("Claude");
    expect(after.relaunchSeq).toBe(1);
    expect(useOverlayAgentStore.getState().assistantEndedKeys.has(tab.key)).toBe(false);
  });

  it("renames a local chat after its new model", async () => {
    const tab = await hydrate(chatRecord({ cli: "claude_local", model: "qwen3:8b" }, "Claude · qwen3:8b"));
    expect(await switchTo(tab.key, "gemma3:4b")).toBe(true);
    expect(assistantTabs()[0].label).toBe("Claude · gemma3:4b");
    expect(assistantTabs()[0].assistant).toEqual({ cli: "claude_local", model: "gemma3:4b" });
  });

  it("does nothing for the model the chat already runs", async () => {
    const tab = await hydrate(chatRecord({ cli: "claude", model: "opus" }, "Claude"));
    expect(await switchAssistantModel(tab.key, "opus")).toBe(false);
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("local_tmux_kill", expect.anything());
    expect(assistantTabs()[0].relaunchSeq ?? 0).toBe(0);
  });
});

describe("assistantModelChoices", () => {
  const options = {
    clis: [],
    localModels: ["qwen3:8b"],
    ollamaReachable: true,
    defaultCli: null,
    defaultModel: null,
    search: { kind: null, searxngUrl: null, ollamaKeyStored: false, keyring: "unlocked", configured: false },
  } as AssistantOptions;
  const cli = (id: string, local: boolean, models?: string[]) =>
    ({ id, label: id, local, installed: true, signedIn: local ? null : true, ready: true, models });

  it("lists Ollama models for a local CLI, Claude's aliases, and Codex's catalog", () => {
    expect(assistantModelChoices(cli("opencode_local", true), options)).toEqual(["qwen3:8b"]);
    expect(assistantModelChoices(cli("claude", false), options)).toContain("opus");
    expect(assistantModelChoices(cli("codex", false, ["gpt-a"]), options)).toEqual(["gpt-a"]);
    expect(assistantModelChoices(cli("codex", false), options)).toEqual([]);
  });
});
