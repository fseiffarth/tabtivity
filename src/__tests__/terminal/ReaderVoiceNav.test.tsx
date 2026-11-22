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
const chime = vi.fn();
vi.mock("../../lib/voice/chime", () => ({ playChime: () => chime() }));
const jumpToTab = vi.fn((_scope: string, _key: string) => "main");
vi.mock("../../lib/shortcuts/tabJump", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/shortcuts/tabJump")>()),
  jumpToTab: (scope: string, key: string) => jumpToTab(scope, key),
}));
let detached = false;
vi.mock("../../stores/detachedContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../stores/detachedContext")>()),
  isDetachedWindow: () => detached,
}));

import { TerminalReaderView } from "../../components/terminal/TerminalReaderView";
import { useAgentReaderStore } from "../../stores/agents/agentReader";
import { useActivityStore } from "../../stores/activity";
import { useBoxesStore } from "../../stores/boxes";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { setReaderDraft } from "../../lib/agents/readerDrafts";
import { clearDesktopLanding, leaveDesktopLanding, takeDesktopLanding } from "../../lib/voice/desktopNav";
import type { VoiceStatus } from "../../lib/voice/desktopVoice";
import type { Settings } from "../../types";

const one: TabEntry = { key: "agent-1", label: "Claude", cmd: "claude", cwd: "/p", kind: "agent", sessionId: "launch-1", launchedAt: 1000 };
const two: TabEntry = { key: "agent-2", label: "Claude 2", cmd: "claude", cwd: "/p", kind: "agent", sessionId: "launch-2", launchedAt: 1000 };
const shell: TabEntry = { key: "shell-1", label: "Shell", cmd: "bash", cwd: "/p", kind: "shell" };

const PROMPT = { kind: "prompt", text: "fix the parser", at: "2026-09-30T08:00:00Z" };
const ANSWER = { kind: "answer", text: "Fixed the parser.", at: "2026-09-30T08:01:00Z" };

function emit(event: string, payload: unknown) {
  act(() => {
    for (const handler of handlers.get(event) ?? []) handler({ payload });
  });
}

const wait = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

/** No voice on this machine unless a test says so: the mode's lines are only shown. */
function status(speak: boolean): VoiceStatus {
  return {
    cpu: true,
    models: [
      { id: "small", kind: "whisper", installed: true, sizeBytes: 190_000_000 },
      { id: "silero-vad", kind: "vad", installed: true, sizeBytes: 900_000 },
    ],
    defaultModel: "small",
    natural: { offered: false, voices: [] },
    gpuBuilt: false,
    gpuCrashed: false,
    device: null,
    listen: null,
    speak: speak ? null : "not-built",
    session: null,
  };
}

describe("spoken navigation in the Chat's mic", () => {
  let host: HTMLElement;
  let entries: unknown[];
  let speakable: boolean;
  beforeEach(() => {
    localStorage.clear();
    handlers.clear();
    chime.mockReset();
    jumpToTab.mockClear();
    detached = false;
    speakable = false;
    entries = [PROMPT];
    clearDesktopLanding();
    invoke.mockReset();
    sendSteeringPrompt.mockReset();
    sendSteeringPrompt.mockResolvedValue(undefined);
    invoke.mockImplementation((command: string) => {
      if (command === "agent_tab_transcript") return Promise.resolve({ available: true, version: `v${entries.length}`, entries });
      if (command === "voice_status") return Promise.resolve(status(speakable));
      if (command === "voice_listen_start") return Promise.resolve(11);
      return Promise.resolve(null);
    });
    useTabsStore.setState((state) => ({ ...state, scope: "p", activeKey: "agent-1", tabsByScope: { p: [one, two, shell] } }));
    useAgentReaderStore.setState({ byAgent: { claude: true } });
    useActivityStore.setState({ attentionByTab: {}, busyByTab: {}, lastWorkingByTab: {}, lastDoneByTab: {} });
    useKeyboardSteeringStore.setState({ jumpBack: null });
    setReaderDraft("p", "agent-1", "");
    setReaderDraft("p", "agent-2", "");
    host = document.createElement("div");
    document.body.appendChild(host);
  });
  afterEach(() => host.remove());

  async function open(settings: Partial<Settings> = {}, tabKey = "agent-1") {
    useSettingsStore.setState({ settings: { experimental_explicit: true, ...settings } as Settings, loaded: true });
    render(<TerminalReaderView host={host} ptyId={`p:${tabKey}`} scope="p" tabKey={tabKey} cwd="/p" visible focused />);
    await screen.findByText("fix the parser");
    return screen.getByRole("textbox") as HTMLTextAreaElement;
  }

  async function startMic(mode: "dictate" | "handsFree" = "dictate") {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    });
    expect(invoke).toHaveBeenCalledWith("voice_listen_start", expect.objectContaining({ mode }));
    emit("voice:state", { session: 11, state: "listening" });
  }

  /** A whole utterance: the final, then the mode's async steps. */
  async function say(segment: number, text: string) {
    emit("voice:vad", { session: 11, segment, state: "start" });
    emit("voice:final", { session: 11, segment, text });
    await wait(0);
  }

  it("opens on \"Tabby navigate\", never typed, and holds it back while it is said", async () => {
    const box = await open();
    await startMic();
    emit("voice:vad", { session: 11, segment: 1, state: "start" });
    emit("voice:partial", { session: 11, segment: 1, text: "Tabby navi" });
    expect(box.value).toBe("");
    expect(screen.getByText(/Heard: Tabby navi/)).toBeTruthy();
    emit("voice:final", { session: 11, segment: 1, text: "Tabby navigate" });
    await wait(0);
    expect(box.value).toBe("");
    expect(screen.getByText(/Navigation: say a project/)).toBeTruthy();
    expect(chime).toHaveBeenCalledTimes(1);
    // In the mode, nothing heard is typed.
    emit("voice:vad", { session: 11, segment: 2, state: "start" });
    emit("voice:partial", { session: 11, segment: 2, text: "tab" });
    expect(box.value).toBe("");
  });

  it("jumps to a tab by number, writes the Back record and leaves a plain-mic note", async () => {
    await open();
    await startMic();
    await say(1, "Tabby navigate");
    await say(2, "tab two");
    expect(jumpToTab).toHaveBeenCalledWith("p", "agent-2");
    // The tab left drops its session.
    expect(invoke).toHaveBeenCalledWith("voice_listen_stop", { session: 11 });
    expect(useKeyboardSteeringStore.getState().jumpBack).toEqual({ origin: { scope: "p", key: "agent-1" }, landed: { scope: "p", key: "agent-2" } });
    expect(takeDesktopLanding("p:agent-2")).toEqual(expect.objectContaining({ ptyId: "p:agent-2", handsFree: false }));
  });

  it("says where a tab with no Chat is before the jump, and listens nowhere", async () => {
    speakable = true;
    await open();
    await startMic();
    await say(1, "Tabby navigate");
    await say(2, "tab three");
    expect(screen.getByText("Shell in p")).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("voice_speak", expect.objectContaining({ id: "p:agent-1#nav:2", chunks: ["Shell in p"] }));
    expect(jumpToTab).not.toHaveBeenCalled();
    emit("voice:speaking", { readId: "p:agent-1#nav:2", state: "done" });
    await wait(0);
    expect(jumpToTab).toHaveBeenCalledWith("p", "shell-1");
    expect(invoke).toHaveBeenCalledWith("voice_listen_stop", { session: 11 });
    expect(takeDesktopLanding("p:shell-1")).toBeNull();
  });

  it("asks a box back, then lands on its agent tab", async () => {
    useBoxesStore.setState({ boxes: [{ id: "b1", name: "Papers", member_ids: [], position: 0 }] });
    useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [one, two], "box:b1": [shell, { ...two, key: "box-agent" }] } }));
    const box = await open();
    await startMic();
    await say(1, "Tabby navigate");
    await say(2, "box Papers");
    expect(screen.getByText("Box Papers?")).toBeTruthy();
    expect(jumpToTab).not.toHaveBeenCalled();
    await say(3, "yes");
    await wait(0);
    expect(jumpToTab).toHaveBeenCalledWith("box:b1", "box-agent");
    expect(takeDesktopLanding("box:b1:box-agent")).toEqual(expect.objectContaining({ handsFree: false, where: "Claude in Papers" }));
    expect(box.value).toBe("");
  });

  it("keeps the Back record on the tab left when a box not open yet is opened first", async () => {
    useBoxesStore.setState({
      boxes: [{ id: "b2", name: "Drafts", member_ids: [], position: 0 }],
      openBox: async () => {
        useTabsStore.setState((state) => ({
          ...state, scope: "box:b2", activeKey: "box-shell",
          tabsByScope: { ...state.tabsByScope, "box:b2": [{ ...shell, key: "box-shell" }, { ...two, key: "box-agent" }] },
        }));
      },
    });
    await open();
    await startMic();
    await say(1, "Tabby navigate");
    await say(2, "box Drafts");
    await say(3, "yes");
    await wait(0);
    expect(jumpToTab).toHaveBeenCalledWith("box:b2", "box-agent");
    expect(useKeyboardSteeringStore.getState().jumpBack).toEqual({ origin: { scope: "p", key: "agent-1" }, landed: { scope: "box:b2", key: "box-agent" } });
  });

  it("walks the done tabs as the status keys do, never a root or Tabby tab", async () => {
    useTabsStore.setState((state) => ({
      ...state,
      tabsByScope: { p: [one, two, shell], root: [{ ...one, key: "root-agent" }], assistant: [{ ...one, key: "tabby-1" }] },
    }));
    useActivityStore.setState({ attentionByTab: { "root:root-agent": "done", "assistant:tabby-1": "done", "p:agent-2": "done" } });
    await open();
    await startMic();
    await say(1, "Tabby navigate, the done tab");
    expect(jumpToTab).toHaveBeenCalledTimes(1);
    expect(jumpToTab).toHaveBeenCalledWith("p", "agent-2");
  });

  it("says there is nothing when the only waiting tab is a root one", async () => {
    useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [one, two], root: [{ ...one, key: "root-agent" }] } }));
    useActivityStore.setState({ attentionByTab: { "root:root-agent": "decision" } });
    await open();
    await startMic();
    await say(1, "Tabby navigate");
    await say(2, "the waiting tab");
    expect(jumpToTab).not.toHaveBeenCalled();
    expect(screen.getByText("Nothing is waiting")).toBeTruthy();
  });

  it("answers \"Tabby help\" with the dictation commands, typing nothing", async () => {
    const box = await open();
    await startMic();
    await say(1, "Tabby help");
    expect(box.value).toBe("");
    expect(screen.getByText(/End with “go Tabby” to send/)).toBeTruthy();
  });

  it("in a popout says navigation is the main window's, and types nothing", async () => {
    detached = true;
    const box = await open();
    await startMic();
    await say(1, "Tabby navigate");
    expect(box.value).toBe("");
    expect(screen.getByText("Navigation works in the main window")).toBeTruthy();
    expect(chime).not.toHaveBeenCalled();
  });

  it("speaks its lines under the tab's read id and listens on once the voice is done", async () => {
    speakable = true;
    await open();
    await startMic();
    await say(1, "Tabby navigate");
    await say(2, "the working tab");
    await wait(0);
    expect(invoke).toHaveBeenCalledWith("voice_speak", expect.objectContaining({ id: "p:agent-1#nav:2", chunks: ["Nothing is working"] }));
    // The mic was never stopped to speak.
    expect(invoke).not.toHaveBeenCalledWith("voice_listen_stop", expect.anything());
    emit("voice:speaking", { readId: "p:agent-1#nav:2", state: "done" });
    await say(3, "stop");
    expect(screen.getByText("Navigation closed")).toBeTruthy();
    expect(invoke).not.toHaveBeenCalledWith("voice_listen_stop", expect.anything());
  });

  describe("the Tabby gate (Hands-free)", () => {
    const handsFree = { voice_hands_free: true, voice_hands_free_on: true };

    async function sendOne(box: HTMLTextAreaElement) {
      await startMic("handsFree");
      await say(1, "fix the login");
      expect(box.value).toBe("fix the login");
      await wait(1700);
      expect(sendSteeringPrompt).toHaveBeenCalledTimes(1);
    }

    it("queues a second prompt said after the start word, while the turn runs", async () => {
      const box = await open(handsFree);
      await sendOne(box);
      await say(2, "Tabby, and add a test, go Tabby");
      await wait(1700);
      expect(sendSteeringPrompt).toHaveBeenCalledTimes(2);
      expect(sendSteeringPrompt).toHaveBeenLastCalledWith(expect.objectContaining({ key: "agent-1" }), "and add a test");
    }, 15_000);

    it("keeps a spoken edit whole behind the gate", async () => {
      const box = await open(handsFree);
      await sendOne(box);
      await say(2, "Tabby add a test");
      expect(box.value).toBe("add a test");
      await say(3, "Tabby scratch that");
      expect(box.value).toBe("");
    }, 15_000);

    it("opens navigation while the agent works", async () => {
      const box = await open(handsFree);
      await sendOne(box);
      await say(2, "Tabby navigate");
      expect(screen.getByText(/Navigation: say a project/)).toBeTruthy();
      await say(3, "tab two");
      expect(jumpToTab).toHaveBeenCalledWith("p", "agent-2");
      expect(takeDesktopLanding("p:agent-2")).toEqual(expect.objectContaining({ handsFree: true }));
      expect(box.value).toBe("");
      // The tab left waits for its turn no more: coming back opens no mic by itself.
      expect(screen.getByRole("button", { name: "Dictate" })).toBeTruthy();
    }, 15_000);

    it("is off after a click on the mic", async () => {
      const box = await open(handsFree);
      await sendOne(box);
      expect(screen.getByText(/say Tabby for your next prompt/)).toBeTruthy();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Stop dictating" }));
      });
      expect(screen.queryByText(/say Tabby for your next prompt/)).toBeNull();
    }, 15_000);
  });

  describe("the landing", () => {
    it("reads the prompt and the answer, then opens the mic gated (Hands-free)", async () => {
      entries = [PROMPT, ANSWER];
      leaveDesktopLanding({ ptyId: "p:agent-2", handsFree: true, where: "Claude in p" });
      await open({ voice_hands_free: true, voice_hands_free_on: true }, "agent-2");
      await wait(0);
      expect(invoke).toHaveBeenCalledWith("voice_speak", expect.objectContaining({ id: "p:agent-2#landing:0", chunks: ["You asked: fix the parser"] }));
      expect(screen.getByText("You asked: fix the parser")).toBeTruthy();
      emit("voice:speaking", { readId: "p:agent-2#landing:0", state: "done" });
      await wait(0);
      expect(invoke).toHaveBeenCalledWith("voice_speak", expect.objectContaining({ id: "p:agent-2#landing:1", chunks: ["Fixed the parser."] }));
      expect(invoke).not.toHaveBeenCalledWith("voice_listen_start", expect.anything());
      emit("voice:speaking", { readId: "p:agent-2#landing:1", state: "done" });
      await wait(0);
      expect(invoke).toHaveBeenCalledWith("voice_listen_start", expect.objectContaining({ tabKey: "agent-2", mode: "handsFree" }));
      emit("voice:state", { session: 11, state: "listening" });
      expect(screen.getByText(/say Tabby for your next prompt/)).toBeTruthy();
    });

    it("reads the conversation as it is now, not as the hidden pane last held it", async () => {
      useSettingsStore.setState({ settings: { experimental_explicit: true, voice_hands_free: true, voice_hands_free_on: true } as Settings, loaded: true });
      const view = (visible: boolean) => <TerminalReaderView host={host} ptyId="p:agent-2" scope="p" tabKey="agent-2" cwd="/p" visible={visible} focused />;
      const { rerender } = render(view(true));
      await screen.findByText("fix the parser");
      rerender(view(false));
      entries = [PROMPT, ANSWER, { kind: "prompt", text: "now the tests", at: "2026-09-30T08:02:00Z" }];
      leaveDesktopLanding({ ptyId: "p:agent-2", handsFree: true, where: "Claude in p" });
      rerender(view(true));
      await wait(20);
      expect(invoke).toHaveBeenCalledWith("voice_speak", expect.objectContaining({ id: "p:agent-2#landing:0", chunks: ["You asked: now the tests"] }));
      expect(invoke).not.toHaveBeenCalledWith("voice_speak", expect.objectContaining({ chunks: ["You asked: fix the parser"] }));
    });

    it("is taken by a Chat already on screen", async () => {
      await open({}, "agent-2");
      await wait(0);
      expect(invoke).not.toHaveBeenCalledWith("voice_listen_start", expect.anything());
      act(() => leaveDesktopLanding({ ptyId: "p:agent-2", handsFree: false, where: "Claude in p" }));
      await wait(0);
      expect(invoke).toHaveBeenCalledWith("voice_listen_start", expect.objectContaining({ tabKey: "agent-2", mode: "dictate" }));
    });

    it("opens the mic ungated when the box holds a draft", async () => {
      setReaderDraft("p", "agent-2", "half a thought");
      leaveDesktopLanding({ ptyId: "p:agent-2", handsFree: true, where: "Claude in p" });
      await open({ voice_hands_free: true, voice_hands_free_on: true }, "agent-2");
      await wait(0);
      emit("voice:speaking", { readId: "p:agent-2#landing:0", state: "done" });
      await wait(0);
      emit("voice:speaking", { readId: "p:agent-2#landing:1", state: "done" });
      await wait(0);
      expect(invoke).toHaveBeenCalledWith("voice_listen_start", expect.objectContaining({ mode: "handsFree" }));
      emit("voice:state", { session: 11, state: "listening" });
      expect(screen.queryByText(/say Tabby for your next prompt/)).toBeNull();
    });

    it("does nothing for a stale note", async () => {
      leaveDesktopLanding({ ptyId: "p:agent-2", handsFree: true, where: "Claude in p" }, Date.now() - 31_000);
      await open({ voice_hands_free: true, voice_hands_free_on: true }, "agent-2");
      await wait(20);
      expect(invoke).not.toHaveBeenCalledWith("voice_speak", expect.anything());
      expect(invoke).not.toHaveBeenCalledWith("voice_listen_start", expect.anything());
    });

    it("reads nothing for a plain-mic note and opens the mic to dictate, ungated", async () => {
      leaveDesktopLanding({ ptyId: "p:agent-2", handsFree: false, where: "Claude in p" });
      const box = await open({}, "agent-2");
      await wait(0);
      expect(invoke).not.toHaveBeenCalledWith("voice_speak", expect.anything());
      expect(invoke).toHaveBeenCalledWith("voice_listen_start", expect.objectContaining({ tabKey: "agent-2", mode: "dictate" }));
      emit("voice:state", { session: 11, state: "listening" });
      await say(1, "and the tests");
      expect(box.value).toBe("and the tests");
    });
  });
});
