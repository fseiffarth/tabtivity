import { beforeEach, describe, expect, it, vi } from "vitest";

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
}));

import {
  VOICE_ERROR_KEYS,
  startDesktopDictation,
  voiceDeviceLabel,
  voiceDeviceWhy,
  voiceErrorKey,
  voiceLangTag,
  type DesktopDictationHandlers,
} from "../../lib/voice/desktopVoice";
import { en } from "../../lib/i18n";

function emit(event: string, payload: unknown) {
  for (const handler of handlers.get(event) ?? []) handler({ payload });
}

function recorder() {
  const calls: string[] = [];
  const handlers: DesktopDictationHandlers = {
    onPreparing: () => calls.push("preparing"),
    onDevice: (device) => calls.push(`device ${device.kind}`),
    onStart: () => calls.push("start"),
    onSegment: (open, segment) => calls.push(`segment ${segment} ${open ? "open" : "end"}`),
    onPartial: (text) => calls.push(`partial ${text}`),
    onFinal: (text, segment) => calls.push(`final ${segment} ${text}`),
    onLevel: () => {},
    onPaused: (paused) => calls.push(paused ? "paused" : "resumed"),
    onError: (key) => calls.push(`error ${key}`),
    onEnd: () => calls.push("end"),
  };
  return { calls, handlers };
}

const options = { tabKey: "agent-1", model: "small", lang: "de", mode: "dictate" as const, pauseMs: 1500, headset: false, gpu: true };

describe("where whisper runs, as the user reads it", () => {
  const t = (key: string, vars?: Record<string, string | number>) => (vars ? `${key} ${vars.name}` : key);

  it("names the card when ggml gave one", () => {
    expect(voiceDeviceLabel({ kind: "gpu", name: "Radeon" }, t)).toBe("terminal.reader.voice.deviceGpu Radeon");
    expect(voiceDeviceLabel({ kind: "gpu", name: null }, t)).toBe("terminal.reader.voice.deviceGpuNoName");
    expect(voiceDeviceWhy({ kind: "gpu", name: "Radeon" }, t)).toBeUndefined();
  });

  it("says why it is the CPU", () => {
    const crashed = { kind: "cpu", reason: "crashed" } as const;
    expect(voiceDeviceLabel(crashed, t)).toBe("terminal.reader.voice.deviceCpu");
    expect(voiceDeviceWhy(crashed, t)).toBe("terminal.reader.voice.cpu.crashed");
  });
});

describe("the desktop dictation session", () => {
  beforeEach(() => {
    handlers.clear();
    invoke.mockReset();
  });

  it("asks for the calling tab's session with the frontend's camelCase keys", async () => {
    invoke.mockResolvedValue(4);
    const { handlers: h } = recorder();
    await startDesktopDictation(options, h);
    expect(invoke).toHaveBeenCalledWith("voice_listen_start", {
      tabKey: "agent-1", model: "small", lang: "de", mode: "dictate", pauseMs: 1500, headset: false, gpu: true,
    });
  });

  it("says where the model landed, from the state event that first carries it", async () => {
    invoke.mockResolvedValue(4);
    const { calls, handlers: h } = recorder();
    await startDesktopDictation(options, h);
    emit("voice:state", { session: 4, state: "preparing" });
    emit("voice:state", { session: 4, state: "listening", device: { kind: "gpu", name: "Radeon" } });
    expect(calls).toEqual(["preparing", "device gpu", "resumed", "start"]);
  });

  it("keeps its own session's events, including those that came before its id", async () => {
    invoke.mockImplementation((command: string) => {
      if (command !== "voice_listen_start") return Promise.resolve();
      // The session thread speaks before the command has answered.
      emit("voice:state", { session: 4, state: "preparing" });
      return Promise.resolve(4);
    });
    const { calls, handlers: h } = recorder();
    await startDesktopDictation(options, h);
    emit("voice:state", { session: 4, state: "listening" });
    emit("voice:vad", { session: 4, segment: 1, state: "start" });
    emit("voice:partial", { session: 4, segment: 1, text: "fix the" });
    // A session this one replaced still sends its last final: not ours.
    emit("voice:final", { session: 3, segment: 9, text: "old words" });
    emit("voice:final", { session: 4, segment: 1, text: "fix the login" });
    emit("voice:state", { session: 4, state: "stopped" });
    emit("voice:final", { session: 4, segment: 2, text: "too late" });
    expect(calls).toEqual([
      "preparing",
      "resumed",
      "start",
      "segment 1 open",
      "partial fix the",
      "final 1 fix the login",
      "end",
    ]);
  });

  it("says why a session stopped", async () => {
    invoke.mockResolvedValue(7);
    const { calls, handlers: h } = recorder();
    await startDesktopDictation(options, h);
    emit("voice:state", { session: 7, state: "stopped", reason: "no-device" });
    expect(calls).toEqual([`error ${VOICE_ERROR_KEYS["no-device"]}`, "end"]);
  });

  it("drops what is still on its way once aborted", async () => {
    invoke.mockResolvedValue(2);
    const { calls, handlers: h } = recorder();
    const dictation = await startDesktopDictation(options, h);
    dictation.abort();
    emit("voice:final", { session: 2, segment: 1, text: "into the emptied draft" });
    expect(calls).toEqual(["end"]);
    expect(invoke).toHaveBeenCalledWith("voice_listen_stop", { session: 2 });
  });

  it("a refused start stops listening and rejects with the backend's code", async () => {
    invoke.mockRejectedValue("permission-denied");
    const { handlers: h } = recorder();
    await expect(startDesktopDictation(options, h)).rejects.toBe("permission-denied");
    expect([...handlers.values()].every((set) => set.size === 0)).toBe(true);
  });

  it("pauses and resumes through its own session", async () => {
    invoke.mockResolvedValue(5);
    const { handlers: h } = recorder();
    const dictation = await startDesktopDictation(options, h);
    dictation.pause(true);
    expect(invoke).toHaveBeenCalledWith("voice_listen_pause", { session: 5, paused: true });
  });
});

describe("voice settings and messages", () => {
  it("listens in the UI language unless told otherwise", () => {
    expect(voiceLangTag(undefined, "de")).toBe("de");
    expect(voiceLangTag("auto", "fr")).toBe("fr");
    expect(voiceLangTag("en", "de")).toBe("en");
    expect(voiceLangTag("detect", "de")).toBe("auto");
  });

  it("says every backend code, and something for an unknown one", () => {
    for (const key of Object.values(VOICE_ERROR_KEYS)) expect(en[key]).toBeTruthy();
    expect(voiceErrorKey("cpu-unsupported")).toBe("terminal.reader.voice.err.cpu");
    expect(voiceErrorKey(new Error("device-busy"))).toBe("terminal.reader.voice.err.busy");
    expect(voiceErrorKey("something new")).toBe("terminal.reader.voice.err.failed");
  });
});
