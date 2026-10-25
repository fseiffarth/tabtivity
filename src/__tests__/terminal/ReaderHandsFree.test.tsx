import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

type Handler = (event: { payload: unknown }) => void;
const handlers = new Map<string, Set<Handler>>();
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: Handler) => {
    const set = handlers.get(event) ?? new Set<Handler>();
    set.add(handler);
    handlers.set(event, set);
    return Promise.resolve(() => set.delete(handler));
  },
  emit: vi.fn(() => Promise.resolve()),
}));
const sendSteeringPrompt = vi.fn();
vi.mock("../../lib/shortcuts/steeringAgent", () => ({
  sendSteeringPrompt: (...args: unknown[]) => sendSteeringPrompt(...args),
  clearAgentTab: () => Promise.resolve(true),
}));
vi.mock("../../lib/terminal/terminalInput", () => ({ writePtyInput: () => Promise.resolve() }));
vi.mock("../../lib/installCommand", () => ({ runInstallInTab: vi.fn() }));
// No Web Audio in jsdom; the chime is only counted.
const chime = vi.fn();
vi.mock("../../lib/voice/chime", () => ({ playChime: () => chime() }));

import { TerminalReaderView } from "../../components/terminal/TerminalReaderView";
import { useAgentReaderStore } from "../../stores/agents/agentReader";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
import { noteAgentTurn } from "../../stores/activity";
import { setReaderDraft } from "../../lib/agents/readerDrafts";
import type { VoiceStatus } from "../../lib/voice/desktopVoice";
import type { Settings } from "../../types";

const tab: TabEntry = { key: "agent-1", label: "Claude", cmd: "claude", cwd: "/p", kind: "agent", sessionId: "launch-1", launchedAt: 1000 };
const PROMPT = { kind: "prompt", text: "fix the parser", at: "2026-09-30T08:00:00Z" };

function emit(event: string, payload: unknown) {
  act(() => {
    for (const handler of handlers.get(event) ?? []) handler({ payload });
  });
}

const wait = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

const status: VoiceStatus = {
  cpu: true,
  models: [{ id: "small", kind: "whisper", installed: true, sizeBytes: 190_000_000 }],
  defaultModel: "small",
  listen: null,
  speak: null,
  session: null,
};

describe("hands-free and read-aloud in the Chat", () => {
  let host: HTMLElement;
  let entries: unknown[];
  beforeEach(() => {
    localStorage.clear();
    handlers.clear();
    chime.mockReset();
    entries = [PROMPT];
    invoke.mockReset();
    sendSteeringPrompt.mockReset();
    sendSteeringPrompt.mockResolvedValue(undefined);
    invoke.mockImplementation((command: string) => {
      if (command === "agent_tab_transcript") return Promise.resolve({ available: true, version: `v${entries.length}`, entries });
      if (command === "voice_status") return Promise.resolve(status);
      if (command === "voice_listen_start") return Promise.resolve(11);
      return Promise.resolve(null);
    });
    useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [tab] } }));
    useAgentReaderStore.setState({ byAgent: {} });
    setReaderDraft("p", "agent-1", "");
    host = document.createElement("div");
    document.body.appendChild(host);
  });
  afterEach(() => host.remove());

  async function open(settings: Partial<Settings>) {
    useSettingsStore.setState({ settings: { experimental_explicit: true, ...settings } as Settings, loaded: true });
    render(<TerminalReaderView host={host} ptyId="p:agent-1" scope="p" tabKey="agent-1" cwd="/p" visible focused />);
    await screen.findByText("fix the parser");
    return screen.getByRole("textbox") as HTMLTextAreaElement;
  }

  async function startHandsFree() {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    });
    expect(invoke).toHaveBeenCalledWith("voice_listen_start", expect.objectContaining({ mode: "handsFree", pauseMs: 1500 }));
    emit("voice:state", { session: 11, state: "listening" });
  }

  it("offers the Hands-free chip only behind its experimental flag", async () => {
    await open({});
    expect(screen.getByRole("button", { name: /Read aloud/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Hands-free/ })).toBeNull();
  });

  it("sends after the chime and the cancel window, then pauses the mic for the turn", async () => {
    const box = await open({ voice_hands_free: true, voice_hands_free_on: true });
    await startHandsFree();
    emit("voice:vad", { session: 11, segment: 1, state: "start" });
    emit("voice:final", { session: 11, segment: 1, text: "fix the login" });
    expect(box.value).toBe("fix the login");
    await wait(20);
    expect(chime).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /Sending/ })).toBeTruthy();
    expect(sendSteeringPrompt).not.toHaveBeenCalled();
    await wait(1600);
    expect(sendSteeringPrompt).toHaveBeenCalledWith(expect.objectContaining({ key: "agent-1" }), "fix the login");
    expect(invoke).toHaveBeenCalledWith("voice_listen_pause", { session: 11, paused: true });
    expect(invoke).not.toHaveBeenCalledWith("voice_listen_stop", expect.anything());
    expect(screen.getByText(/Waiting for the agent/)).toBeTruthy();
  }, 15_000);

  it("listens again only once the turn it sent is over", async () => {
    await open({ voice_hands_free: true, voice_hands_free_on: true });
    await startHandsFree();
    emit("voice:final", { session: 11, segment: 1, text: "fix the login" });
    await wait(1700);
    expect(sendSteeringPrompt).toHaveBeenCalledTimes(1);
    noteAgentTurn("p:agent-1", "working");
    // An answer mid-turn, the agent still running tools: the mic stays paused.
    entries = [PROMPT, { kind: "answer", text: "Looking.", at: "2026-09-30T08:01:00Z" }];
    await wait(2600);
    expect(invoke).not.toHaveBeenCalledWith("voice_listen_pause", { session: 11, paused: false });
    noteAgentTurn("p:agent-1", "done");
    await wait(1500);
    expect(invoke).toHaveBeenCalledWith("voice_listen_pause", { session: 11, paused: false });
  }, 15_000);

  it("keeps the draft unsent on a spoken stop in the window, however late it settles", async () => {
    const box = await open({ voice_hands_free: true, voice_hands_free_on: true });
    await startHandsFree();
    emit("voice:vad", { session: 11, segment: 1, state: "start" });
    emit("voice:final", { session: 11, segment: 1, text: "deploy it" });
    await wait(20);
    emit("voice:vad", { session: 11, segment: 2, state: "start" });
    await wait(2000);
    expect(sendSteeringPrompt).not.toHaveBeenCalled();
    emit("voice:final", { session: 11, segment: 2, text: "Stop!" });
    await wait(1700);
    expect(sendSteeringPrompt).not.toHaveBeenCalled();
    expect(box.value).toBe("deploy it");
  }, 15_000);

  it("cancels the window with a click on its line", async () => {
    await open({ voice_hands_free: true, voice_hands_free_on: true });
    await startHandsFree();
    emit("voice:final", { session: 11, segment: 1, text: "deploy it" });
    await wait(20);
    fireEvent.click(screen.getByRole("button", { name: /Sending/ }));
    await wait(1700);
    expect(sendSteeringPrompt).not.toHaveBeenCalled();
  }, 15_000);

  it("reads the new answer once the turn ends, and the stop key stops the voice", async () => {
    const box = await open({ voice_read_aloud: true });
    noteAgentTurn("p:agent-1", "working");
    await wait(500);
    entries = [PROMPT, { kind: "answer", text: "Fixed it.\n```ts\nx()\n```\nDone.", at: "2026-09-30T08:01:00Z" }];
    noteAgentTurn("p:agent-1", "done");
    await wait(2600);
    const speak = invoke.mock.calls.find(([command]) => command === "voice_speak");
    expect(speak?.[1]).toEqual(expect.objectContaining({ chunks: ["Fixed it. code block. Done."], replace: false }));
    emit("voice:speaking", { readId: (speak?.[1] as { id: string }).id, state: "started" });
    fireEvent.keyDown(box, { key: "Q", code: "KeyQ", ctrlKey: true, shiftKey: true });
    expect(invoke).toHaveBeenCalledWith("voice_speak_stop");
  }, 15_000);
});
