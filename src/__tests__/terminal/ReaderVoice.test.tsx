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
    natural: { offered: false, voices: [] },
    gpuBuilt: false,
    gpuCrashed: false,
    device: null,
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

  it("writes what it hears into the draft as it is said, and the final replaces it", async () => {
    const box = await composer(host);
    fireEvent.change(box, { target: { value: "please" } });
    await startMic();
    expect(screen.getByRole("button", { name: "Stop dictating" })).toBeTruthy();
    emit("voice:partial", { session: 11, segment: 1, text: "fix the" });
    expect(box.value).toBe("please fix the");
    // Each partial is the segment so far (or its last seconds): it replaces the last.
    emit("voice:partial", { session: 11, segment: 1, text: "fix the log in" });
    expect(box.value).toBe("please fix the log in");
    // The words are in the field, so no Heard line repeats them.
    expect(screen.queryByText(/^Heard:/)).toBeNull();
    emit("voice:final", { session: 11, segment: 1, text: "fix the login" });
    expect(box.value).toBe("please fix the login");
    // A dropped segment settles without touching the draft.
    emit("voice:partial", { session: 11, segment: 2, text: "uh" });
    expect(box.value).toBe("please fix the login uh");
    emit("voice:final", { session: 11, segment: 2, text: "" });
    expect(box.value).toBe("please fix the login");
    expect(sendSteeringPrompt).not.toHaveBeenCalled();
  });

  it("undoes a settled sentence as one step, never its partials", async () => {
    const box = await composer(host);
    await startMic();
    emit("voice:partial", { session: 11, segment: 1, text: "fix" });
    emit("voice:partial", { session: 11, segment: 1, text: "fix the login" });
    emit("voice:final", { session: 11, segment: 1, text: "Fix the login." });
    emit("voice:partial", { session: 11, segment: 2, text: "and the" });
    emit("voice:final", { session: 11, segment: 2, text: "And the logout." });
    expect(box.value).toBe("Fix the login. And the logout.");
    emit("voice:final", { session: 11, segment: 3, text: "Tabby, scratch that." });
    expect(box.value).toBe("Fix the login.");
    fireEvent.keyDown(box, { key: "z", code: "KeyZ", ctrlKey: true });
    expect(box.value).toBe("Fix the login. And the logout.");
    fireEvent.keyDown(box, { key: "z", code: "KeyZ", ctrlKey: true });
    expect(box.value).toBe("Fix the login.");
    fireEvent.keyDown(box, { key: "z", code: "KeyZ", ctrlKey: true });
    expect(box.value).toBe("");
  });

  it("keeps the words of a spoken edit out of the draft, on the Heard line instead", async () => {
    const box = await composer(host);
    fireEvent.change(box, { target: { value: "Fix the login." } });
    await startMic();
    emit("voice:partial", { session: 11, segment: 1, text: "Tabby" });
    expect(box.value).toBe("Fix the login.");
    expect(screen.getByText("Heard: Tabby")).toBeTruthy();
    emit("voice:partial", { session: 11, segment: 1, text: "Tabby, clear" });
    expect(box.value).toBe("Fix the login.");
    emit("voice:final", { session: 11, segment: 1, text: "Tabby, clear all." });
    expect(box.value).toBe("");
    expect(screen.queryByText(/^Heard:/)).toBeNull();
  });

  it("shows a spoken send's words nowhere, and sends without them", async () => {
    const box = await composer(host);
    await startMic();
    emit("voice:partial", { session: 11, segment: 1, text: "Fix the login. Go on" });
    expect(box.value).toBe("Fix the login.");
    await act(async () => {
      emit("voice:final", { session: 11, segment: 1, text: "Fix the login. Go on." });
    });
    expect(sendSteeringPrompt).toHaveBeenCalledWith(expect.objectContaining({ key: "agent-1" }), "Fix the login.");
    // A late partial never lands in the emptied draft.
    emit("voice:partial", { session: 11, segment: 2, text: "late" });
    expect(box.value).toBe("");
  });

  it("leaves what the user types meanwhile alone", async () => {
    const box = await composer(host);
    await startMic();
    emit("voice:partial", { session: 11, segment: 1, text: "fix the" });
    // Typed after the live words, then before them.
    fireEvent.change(box, { target: { value: "fix the (now)" } });
    emit("voice:partial", { session: 11, segment: 1, text: "fix the login" });
    expect(box.value).toBe("fix the login (now)");
    fireEvent.change(box, { target: { value: "Please, fix the login (now)" } });
    emit("voice:partial", { session: 11, segment: 1, text: "fix the login page" });
    expect(box.value).toBe("Please, fix the login page (now)");
    emit("voice:final", { session: 11, segment: 1, text: "Fix the login page." });
    // The final lands where the live words stood.
    expect(box.value).toBe("Please, Fix the login page. (now)");
  });

  it("takes an edit inside the live words as the user's own, and does not type the final again", async () => {
    const box = await composer(host);
    await startMic();
    emit("voice:partial", { session: 11, segment: 1, text: "fix the lock in" });
    fireEvent.change(box, { target: { value: "fix the login" } });
    emit("voice:partial", { session: 11, segment: 1, text: "fix the lock in page" });
    expect(box.value).toBe("fix the login");
    emit("voice:final", { session: 11, segment: 1, text: "Fix the login page." });
    expect(box.value).toBe("fix the login");
  });

  it("drops the open segment's live words when the mic is paused", async () => {
    const box = await composer(host);
    await startMic();
    emit("voice:vad", { session: 11, segment: 1, state: "start" });
    emit("voice:partial", { session: 11, segment: 1, text: "fix the" });
    expect(box.value).toBe("fix the");
    emit("voice:state", { session: 11, state: "paused" });
    expect(box.value).toBe("");
  });

  it("removes the live words of a segment that ended without a final text when the session ends", async () => {
    const box = await composer(host);
    await startMic();
    emit("voice:partial", { session: 11, segment: 1, text: "fix the" });
    expect(box.value).toBe("fix the");
    emit("voice:state", { session: 11, state: "stopped" });
    expect(box.value).toBe("");
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

  it("edits the draft on \"Tabby …\" instead of typing it, with a note on the line", async () => {
    const box = await composer(host);
    await startMic();
    emit("voice:final", { session: 11, segment: 1, text: "Fix the login." });
    emit("voice:final", { session: 11, segment: 2, text: "And the logout." });
    expect(box.value).toBe("Fix the login. And the logout.");
    emit("voice:final", { session: 11, segment: 3, text: "Tabby, scratch that." });
    expect(box.value).toBe("Fix the login.");
    expect(screen.getByText("Removed “And the logout.”")).toBeTruthy();
    emit("voice:final", { session: 11, segment: 4, text: "Tabby, replace login with sign-in." });
    expect(box.value).toBe("Fix the sign-in.");
    emit("voice:final", { session: 11, segment: 5, text: "Tabby plan." });
    expect(box.value).toBe("/plan Fix the sign-in.");
    expect(sendSteeringPrompt).not.toHaveBeenCalled();
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

  it("lets the install card pick another speech model", async () => {
    installed = false;
    await composer(host);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Speech model" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByText(/^Base · 60 MB/));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Install" }));
    });
    expect(invoke).toHaveBeenCalledWith("voice_model_install_script", { id: "base" });
    expect(invoke).toHaveBeenCalledWith("patch_settings", { patch: { voice_model: "base" } });
  });

  it("switches to an installed model from the card and dictates with it", async () => {
    installed = false;
    invoke.mockImplementation((command: string) => {
      if (command === "voice_status") {
        const s = status(false);
        s.models.push({ id: "base", kind: "whisper", installed: true, sizeBytes: 60_000_000 });
        return Promise.resolve(s);
      }
      if (command === "voice_listen_start") return Promise.resolve(11);
      if (command === "agent_tab_transcript") return Promise.resolve({ available: true, version: "v1", entries: [{ kind: "prompt", text: "fix the parser", at: "2026-09-30T08:00:00Z" }] });
      return Promise.resolve([]);
    });
    await composer(host);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Speech model" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByText(/^Base · 60 MB.*installed/));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Use this model" }));
    });
    expect(invoke).toHaveBeenCalledWith("voice_listen_start", expect.objectContaining({ model: "base" }));
    expect(runInstallInTab).not.toHaveBeenCalled();
  });

  it("shows the model it listens with and switches to another installed one in place", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "voice_status") {
        const s = status(true);
        s.models.push({ id: "base", kind: "whisper", installed: true, sizeBytes: 60_000_000 });
        return Promise.resolve(s);
      }
      if (command === "voice_listen_start") return Promise.resolve(11);
      if (command === "agent_tab_transcript") return Promise.resolve({ available: true, version: "v1", entries: [{ kind: "prompt", text: "fix the parser", at: "2026-09-30T08:00:00Z" }] });
      return Promise.resolve([]);
    });
    await composer(host);
    await startMic();
    const picker = screen.getByRole("button", { name: "Speech model" });
    expect(picker.textContent).toMatch(/^Small · 190 MB.*installed/);
    await act(async () => {
      fireEvent.click(picker);
    });
    await act(async () => {
      fireEvent.click(screen.getByText(/^Base · 60 MB.*installed/));
    });
    expect(invoke).toHaveBeenCalledWith("voice_listen_stop", { session: 11 });
    expect(invoke).toHaveBeenCalledWith("patch_settings", { patch: { voice_model: "base" } });
    expect(invoke).toHaveBeenLastCalledWith("voice_listen_start", expect.objectContaining({ model: "base" }));
    expect(runInstallInTab).not.toHaveBeenCalled();
  });

  it("stops the mic and opens the install card for a missing model picked while listening", async () => {
    await composer(host);
    await startMic();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Speech model" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByText(/^Large v3 turbo/));
    });
    expect(screen.getByRole("button", { name: "Dictate" })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Install" }));
    });
    expect(invoke).toHaveBeenCalledWith("voice_model_install_script", { id: "large-v3-turbo" });
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
