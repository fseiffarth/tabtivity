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
const runInstallInTab = vi.fn();
vi.mock("../../lib/installCommand", () => ({ runInstallInTab: (...args: unknown[]) => runInstallInTab(...args) }));

import { TerminalReaderView } from "../../components/terminal/TerminalReaderView";
import { useAgentReaderStore } from "../../stores/agents/agentReader";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { setReaderDraft } from "../../lib/agents/readerDrafts";
import type { VoiceStatus } from "../../lib/voice/desktopVoice";

const tab: TabEntry = { key: "agent-1", label: "Claude", cmd: "claude", cwd: "/p", kind: "agent", sessionId: "launch-1", launchedAt: 1000 };

function emit(event: string, payload: unknown) {
  act(() => {
    for (const handler of handlers.get(event) ?? []) handler({ payload });
  });
}

function status(installed: boolean): VoiceStatus {
  return {
    cpu: true,
    models: [
      { id: "small", kind: "whisper", installed, sizeBytes: 190_000_000 },
      { id: "silero-vad", kind: "vad", installed, sizeBytes: 900_000 },
    ],
    defaultModel: "small",
    listen: null,
    speak: "not-built",
    session: null,
  };
}

async function composer(host: HTMLElement): Promise<HTMLTextAreaElement> {
  render(<TerminalReaderView host={host} ptyId="p:agent-1" scope="p" tabKey="agent-1" cwd="/p" visible focused />);
  await screen.findByText("fix the parser");
  return screen.getByRole("textbox") as HTMLTextAreaElement;
}

describe("dictating into the Chat's composer", () => {
  let host: HTMLElement;
  let installed = true;
  beforeEach(() => {
    localStorage.clear();
    handlers.clear();
    installed = true;
    invoke.mockReset();
    runInstallInTab.mockReset();
    sendSteeringPrompt.mockReset();
    sendSteeringPrompt.mockResolvedValue(undefined);
    invoke.mockImplementation((command: string) => {
      if (command === "agent_tab_transcript") {
        return Promise.resolve({ available: true, version: "v1", entries: [{ kind: "prompt", text: "fix the parser", at: "2026-09-30T08:00:00Z" }] });
      }
      if (command === "voice_status") return Promise.resolve(status(installed));
      if (command === "voice_listen_start") return Promise.resolve(11);
      if (command === "voice_model_install_script") return Promise.resolve("bash '/s/voice/fetch-model.sh'");
      return Promise.resolve([]);
    });
    useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [tab] } }));
    useAgentReaderStore.setState({ byAgent: {} });
    setReaderDraft("p", "agent-1", "");
    host = document.createElement("div");
    document.body.appendChild(host);
  });
  afterEach(() => host.remove());

  async function startMic() {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    });
    expect(invoke).toHaveBeenCalledWith("voice_listen_start", expect.objectContaining({ tabKey: "agent-1", model: "small", mode: "dictate" }));
    emit("voice:state", { session: 11, state: "listening" });
  }

  it("puts each settled sentence into the draft and shows what it hears meanwhile", async () => {
    const box = await composer(host);
    fireEvent.change(box, { target: { value: "please" } });
    await startMic();
    expect(screen.getByRole("button", { name: "Stop dictating" })).toBeTruthy();
    emit("voice:partial", { session: 11, segment: 1, text: "fix the" });
    expect(screen.getByText("Heard: fix the")).toBeTruthy();
    emit("voice:final", { session: 11, segment: 1, text: "fix the login" });
    expect(box.value).toBe("please fix the login");
    // A dropped segment settles without touching the draft.
    emit("voice:final", { session: 11, segment: 2, text: "" });
    expect(box.value).toBe("please fix the login");
    expect(sendSteeringPrompt).not.toHaveBeenCalled();
  });

  it("sends on a spoken \"go on\", without those words, and ends the dictation", async () => {
    await composer(host);
    await startMic();
    await act(async () => {
      emit("voice:final", { session: 11, segment: 1, text: "Fix the login. Go on." });
    });
    expect(sendSteeringPrompt).toHaveBeenCalledWith(expect.objectContaining({ key: "agent-1" }), "Fix the login.");
    expect(invoke).toHaveBeenCalledWith("voice_listen_stop", { session: 11 });
    expect(screen.getByRole("button", { name: "Dictate" })).toBeTruthy();
  });

  it("offers the install tab when the speech model is missing", async () => {
    installed = false;
    await composer(host);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    });
    expect(invoke).not.toHaveBeenCalledWith("voice_listen_start", expect.anything());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Install" }));
    });
    expect(invoke).toHaveBeenCalledWith("voice_model_install_script", { id: "small" });
    expect(runInstallInTab).toHaveBeenCalledWith("Speech model", "bash '/s/voice/fetch-model.sh'", expect.any(String));
  });


  it("warns about a muted mic, and drops the warning when sound returns", async () => {
    await composer(host);
    await startMic();
    emit("voice:error", { session: 11, code: "mic-silent" });
    expect(screen.getByRole("alert").textContent).toContain("seems to be muted");
    emit("voice:state", { session: 11, state: "listening" });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Stop dictating" })).toBeTruthy();
  });
  it("says why the mic would not open", async () => {
    invoke.mockImplementation((command: string) => command === "voice_listen_start"
      ? Promise.reject("no-device")
      : command === "voice_status" ? Promise.resolve(status(true))
      : command === "agent_tab_transcript" ? Promise.resolve({ available: true, version: "v1", entries: [{ kind: "prompt", text: "fix the parser", at: "2026-09-30T08:00:00Z" }] })
      : Promise.resolve([]));
    await composer(host);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    });
    expect(screen.getByRole("alert").textContent).toContain("No microphone found.");
  });

  it("toggles with its shortcut from the text box", async () => {
    const box = await composer(host);
    await act(async () => {
      fireEvent.keyDown(box, { key: "D", code: "KeyD", ctrlKey: true, shiftKey: true });
    });
    expect(invoke).toHaveBeenCalledWith("voice_listen_start", expect.anything());
  });
});
