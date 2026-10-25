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
import { ASSISTANT_DEFAULT_MODEL, ASSISTANT_SCOPE, assistantModelRows, claudeModelId, claudeModelRows, type AssistantOptions } from "../../lib/assistant";
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

  it("switches a Claude chat to its default by dropping the model", async () => {
    const tab = await hydrate(chatRecord({ cli: "claude", model: "claude-opus-5-5" }, "Claude"));
    expect(await switchTo(tab.key, ASSISTANT_DEFAULT_MODEL)).toBe(true);
    expect(assistantTabs()[0].assistant).toEqual({ cli: "claude" });
  });

  it("does nothing for the default on a chat that runs it", async () => {
    const tab = await hydrate(chatRecord({ cli: "claude" }, "Claude"));
    expect(await switchAssistantModel(tab.key, ASSISTANT_DEFAULT_MODEL)).toBe(false);
  });

  it("does nothing for the model the chat already runs", async () => {
    const tab = await hydrate(chatRecord({ cli: "claude", model: "opus" }, "Claude"));
    expect(await switchAssistantModel(tab.key, "opus")).toBe(false);
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("local_tmux_kill", expect.anything());
    expect(assistantTabs()[0].relaunchSeq ?? 0).toBe(0);
  });
});

// Claude Code 2.1.310's `/model` in a 160x50 tmux pane, as the probe captures
// it: the first screen (the highlight on the home's default, ten rows drawn)
// and the one after the walk reached the last row.
const PICKER_HEAD = [
  "   Select model",
  "   Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names, specify with --model.",
  "",
];
const PICKER_FOOT = [
  "",
  "   \u25cf High effort \u2190/\u2192 to adjust",
  "",
  "   Enter to set as default \u00b7 s to use this session only \u00b7 Esc to cancel",
];
const FIRST_SCREEN = [
  ...PICKER_HEAD,
  "     1.  Default (recommended)  Sonnet 5.5 \u00b7 Efficient for routine tasks",
  "     2.  Opus 5.5               For complex work and everyday tasks",
  "     3.  Fable 5.1              For your toughest challenges",
  "   \u276f 4.  Sonnet 5.5 \u2714           Most efficient for simpler tasks",
  "     5.  Haiku 5.5              Fastest for quick answers",
  "     6.  Haiku 4.5              Fastest for quick answers",
  "     7.  Sonnet 5               Efficient for routine tasks",
  "     8.  Opus 5                 Best for everyday, complex tasks",
  "     9.  Fable 5                Most capable for your hardest and longest-running tasks",
  "   \u2193 10. Opus 4.8               Best for everyday, complex tasks",
  "      \u2026 +3 models",
  ...PICKER_FOOT,
];
const LAST_SCREEN = [
  ...PICKER_HEAD,
  "   \u2191 4.  Sonnet 5.5 \u2714           Most efficient for simpler tasks",
  "     5.  Haiku 5.5              Fastest for quick answers",
  "     6.  Haiku 4.5              Fastest for quick answers",
  "     7.  Sonnet 5               Efficient for routine tasks",
  "     8.  Opus 5                 Best for everyday, complex tasks",
  "     9.  Fable 5                Most capable for your hardest and longest-running tasks",
  "     10. Opus 4.8               Best for everyday, complex tasks",
  "     11. Opus 4.7               Best for everyday, complex tasks",
  "     12. Opus 4.6               Best for everyday, complex tasks",
  "   \u276f 13. Sonnet 4.6             Efficient for routine tasks",
  ...PICKER_FOOT,
];

describe("claudeModelRows", () => {
  it("pieces Claude's own rows together from the walked screens, in its words", () => {
    const rows = claudeModelRows([FIRST_SCREEN, LAST_SCREEN]);
    expect(rows.map((row) => row.label)).toEqual([
      "Default (recommended)", "Opus 5.5", "Fable 5.1", "Sonnet 5.5", "Haiku 5.5", "Haiku 4.5",
      "Sonnet 5", "Opus 5", "Fable 5", "Opus 4.8", "Opus 4.7", "Opus 4.6", "Sonnet 4.6",
    ]);
    expect(rows[0]).toEqual({ id: ASSISTANT_DEFAULT_MODEL, label: "Default (recommended)", description: "Sonnet 5.5 \u00b7 Efficient for routine tasks" });
    // The home's ✔ is not the chat's.
    expect(rows[3]).toEqual({ id: "claude-sonnet-5-5", label: "Sonnet 5.5", description: "Most efficient for simpler tasks" });
    expect(rows.find((row) => row.label === "Haiku 4.5")?.id).toBe("claude-haiku-4-5");
    expect(rows.find((row) => row.label === "Opus 5")?.id).toBe("claude-opus-5");
  });

  it("reads nothing off a screen with no picker", () => {
    expect(claudeModelRows([["\u276f Try \"fix typecheck errors\"", "  ? for shortcuts"]])).toEqual([]);
    expect(claudeModelRows([])).toEqual([]);
  });

  it("names a row by the model a chat can be launched with", () => {
    expect(claudeModelId("Default (recommended)")).toBe(ASSISTANT_DEFAULT_MODEL);
    expect(claudeModelId("Opus 5.5 \u2714")).toBe("claude-opus-5-5");
    // Older pickers name the family and put the version in the note.
    expect(claudeModelId("Fable")).toBe("fable");
    expect(claudeModelId("Opus (1M context)")).toBeNull();
  });
});

describe("assistantModelRows", () => {
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
  const ids = async (from: Promise<{ id: string }[]>) => (await from).map((row) => row.id);

  it("lists Ollama models for a local CLI and Codex's catalog, by name", async () => {
    expect(await assistantModelRows(cli("opencode_local", true), options)).toEqual([{ id: "qwen3:8b", label: "qwen3:8b" }]);
    expect(await ids(assistantModelRows(cli("codex", false, ["gpt-a"]), options))).toEqual(["gpt-a"]);
    expect(await ids(assistantModelRows(cli("codex", false), options))).toEqual([]);
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("assistant_claude_models");
  });

  it("lists Claude's own picker rows from the probe", async () => {
    vi.mocked(invoke).mockImplementationOnce(() => Promise.resolve([FIRST_SCREEN, LAST_SCREEN]));
    const rows = await assistantModelRows(cli("claude", false), options);
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("assistant_claude_models");
    expect(rows).toHaveLength(13);
    expect(rows[1]).toEqual({ id: "claude-opus-5-5", label: "Opus 5.5", description: "For complex work and everyday tasks" });
  });

  it("falls back to Claude's aliases when the probe fails", async () => {
    vi.mocked(invoke).mockImplementationOnce(() => Promise.reject(new Error("model_probe_timeout")));
    expect(await ids(assistantModelRows(cli("claude", false), options))).toContain("opus");
  });
});
