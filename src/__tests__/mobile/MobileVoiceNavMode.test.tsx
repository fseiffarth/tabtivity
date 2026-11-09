import { StrictMode } from "react";
import { act, cleanup as cleanupScreen, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { MobileSpeechRecognitionResultEvent } from "../../../mobile-web/src/voiceInput";

const terminalModes = vi.hoisted(() => ({ bracketedPasteMode: false }));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    modes = terminalModes;
    loadAddon() {}
    open() {}
    write() {}
    onData() { return { dispose() {} }; }
    scrollLines() {}
    focus() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
const chime = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../../lib/voice/chime", () => ({ playChime: () => { chime.calls += 1; } }));

class FakeRecognition {
  static instances: FakeRecognition[] = [];
  continuous = false;
  interimResults = false;
  lang = "";
  maxAlternatives = 0;
  onstart: (() => void) | null = null;
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  aborted = false;
  constructor() { FakeRecognition.instances.push(this); }
  start() { this.onstart?.(); }
  stop() { this.onend?.(); }
  abort() { this.aborted = true; this.onend?.(); }
}

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  binaryType = "";
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor() {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(value: unknown) { this.sent.push(value); }
  close() { this.readyState = 3; this.onclose?.(); }
}

class FakeUtterance {
  lang = "";
  rate = 1;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {}
}

import { Terminal } from "../../../mobile-web/src/screens/Terminal";
import type { ActivityTab, TabRow } from "../../../mobile-web/src/api";
import { forgetReadings } from "../../../mobile-web/src/speechOutput";
import { readSeenDone } from "../../../mobile-web/src/seenDone";
import { leaveLanding, resetNavCursors, takeLanding } from "../../../mobile-web/src/voiceNav";
import { BRAND, storageKey } from "../../lib/brand";

const T = BRAND.assistant;

function agent(id: string, extra: Partial<TabRow> = {}): TabRow {
  return { id, label: id, kind: "agent", agent_label: "Claude Code", available: true, viewer_busy: false, ...extra };
}
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const HERE = agent("tab-1", { label: "Fix login" });
/** What the phone's routes answer in these tests. */
const host = {
  projects: [] as unknown[],
  details: {} as Record<string, unknown>,
  activity: { tabs: [] as ActivityTab[], desktop_available: true } as { tabs: ActivityTab[]; desktop_available: boolean },
  transcript: { available: true, version: "1:1", truncated: false, entries: [] as unknown[] } as unknown,
  /** Answer the transcript read only once released. */
  transcriptHeld: null as null | Promise<void>,
};

function resetHost() {
  host.projects = [
    { id: "p1", label: "Alpha", status: "ok", live_sessions: 0 },
    { id: "p2", label: "Beta", status: "ok", live_sessions: 0 },
    { id: "p3", label: "Gamma", status: "ok", live_sessions: 0 },
    { id: "bx", label: "Boxy", status: "ok", kind: "box", live_sessions: 0 },
  ];
  const agents = [{ id: "claude", label: "Claude Code", modes: [] }, { id: "codex", label: "Codex", modes: [] }];
  host.details = {
    p1: {
      project: host.projects[0], desktop_available: true, agents,
      tabs: [HERE, agent("tab-2", { label: "Docs", agent_label: "Codex" }), { id: "sh-1", label: "Shell", kind: "shell", available: true, viewer_busy: false }],
    },
    p2: {
      project: host.projects[1], desktop_available: true, agents,
      tabs: [agent("b-1", { label: "Old chat", last_activity: 5 }), agent("b-2", { label: "New chat", last_activity: 9 })],
    },
    p3: {
      project: host.projects[2], desktop_available: true, agents,
      tabs: [{ id: "sh-3", label: "Shell", kind: "shell", available: true, viewer_busy: false }],
    },
  };
  host.activity = { tabs: [], desktop_available: true };
  host.transcript = { available: true, version: "1:1", truncated: false, entries: [] };
  host.transcriptHeld = null;
}

function sidecarFetch() {
  return vi.fn(async (url: string) => {
    if (url.startsWith("/api/v1/projects?")) return json(200, { projects: host.projects });
    const detail = /^\/api\/v1\/projects\/([^/?]+)$/.exec(url);
    if (detail) return host.details[detail[1]] ? json(200, host.details[detail[1]]) : json(404, { error: "project_not_found" });
    if (url === "/api/v1/activity") return json(200, host.activity);
    if (url.endsWith("/outbox")) return json(200, { files: [] });
    if (url.includes("/transcript")) {
      if (host.transcriptHeld) await host.transcriptHeld;
      return json(200, { transcript: host.transcript });
    }
    return json(404, { error: "not_found" });
  });
}

/** One recognizer's whole result list, as Chrome hands it over each time. */
function reading(...items: [string, boolean][]): MobileSpeechRecognitionResultEvent {
  const results: Record<number, unknown> & { length: number } = { length: items.length };
  items.forEach(([transcript, isFinal], index) => { results[index] = { 0: { transcript }, isFinal, length: 1 }; });
  return { resultIndex: 0, results } as unknown as MobileSpeechRecognitionResultEvent;
}

describe(`${BRAND.display} Mobile spoken navigation`, () => {
  let spoken: FakeUtterance[];
  let ended: number;
  let openTab: Mock<(tab: TabRow, opts?: { project?: string }) => void>;
  let openProject: Mock<(id: string) => void>;

  beforeEach(() => {
    localStorage.clear();
    resetHost();
    resetNavCursors();
    takeLanding("nothing");
    chime.calls = 0;
    FakeRecognition.instances = [];
    FakeWebSocket.instances = [];
    spoken = [];
    ended = 0;
    openTab = vi.fn<(tab: TabRow, opts?: { project?: string }) => void>();
    openProject = vi.fn<(id: string) => void>();
    forgetReadings();
    Object.defineProperty(window, "webkitSpeechRecognition", { configurable: true, value: FakeRecognition });
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    vi.stubGlobal("speechSynthesis", {
      speak: (utterance: FakeUtterance) => { spoken.push(utterance); },
      cancel: () => { ended = spoken.length; },
    });
    vi.stubGlobal("fetch", sidecarFetch());
    localStorage.setItem(storageKey("mobile.view.claude-code"), "focus");
    localStorage.setItem(storageKey("mobile.focusHandsFree"), "1");
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as Window & { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
    vi.unstubAllGlobals();
  });

  const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
  const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  const box = () => screen.getByRole("textbox", { name: "Message agent" }) as HTMLTextAreaElement;
  const said = () => spoken.filter((utterance) => utterance.text !== "").map((utterance) => utterance.text);
  /** The phone finishes whatever it is saying (every queued chunk). */
  const finishSpeech = async () => {
    while (ended < spoken.length) {
      const utterance = spoken[ended];
      ended += 1;
      act(() => { utterance.onend?.(); });
      await settle();
    }
  };
  const mic = () => FakeRecognition.instances[FakeRecognition.instances.length - 1];
  const micOpen = () => FakeRecognition.instances.length > 0 && !mic().aborted;

  async function start(tab: TabRow = HERE) {
    render(<Terminal tab={tab} project="p1" back={() => {}} openTab={openTab} openProject={openProject} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await settle();
  }
  /** What each recognizer has heard so far: Chrome hands over the whole list each time. */
  const heard = new Map<FakeRecognition, [string, boolean][]>();
  /** One utterance: heard final, then quiet long enough to settle. */
  const hear = async (text: string) => {
    const list = [...(heard.get(mic()) ?? []), [text, true] as [string, boolean]];
    heard.set(mic(), list);
    act(() => mic().onresult?.(reading(...list)));
    await advance(1_000);
  };
  /** A jump replaces the screen, and the new one opens a fresh mic: so does this. */
  const reopen = async () => {
    fireEvent.click(screen.getByRole("button", { name: "Stop dictation" }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await settle();
  };
  /** The phone's line has been said, the voice fell quiet, the mic is open again. */
  const lineSaid = async () => {
    await finishSpeech();
    await advance(400);
  };

  it("opens on the navigate phrase: a chime, a line, nothing typed, the draft untouched", async () => {
    await start();
    fireEvent.change(box(), { target: { value: "half a thought" } });
    await hear(`${T} navigate`);
    expect(chime.calls).toBe(1);
    expect(screen.getByText(/^Navigation: say a project/)).toBeTruthy();
    expect(box().value).toBe("half a thought");
    // The pause that would send the draft does not run in the mode.
    await advance(5_000);
    expect(box().value).toBe("half a thought");
    expect(FakeWebSocket.instances[0].sent.filter((value) => ArrayBuffer.isView(value as ArrayBufferView))).toHaveLength(0);
  });

  it("shows nothing of a past mic's guess when a fresh mic is stopped before it hears anything", async () => {
    await start();
    act(() => mic().onresult?.(reading(["half a wor", false])));
    fireEvent.click(screen.getByRole("button", { name: "Stop dictation" }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Stop dictation" }));
    await settle();
    expect(screen.queryByText(/half a wor/)).toBeNull();
  });

  it("settles nothing for a mic a send ended, when its quiet runs out", async () => {
    await start();
    fireEvent.change(box(), { target: { value: "a typed line" } });
    act(() => mic().onresult?.(reading(["half a wor", false])));
    expect(screen.getByText(/half a wor/)).toBeTruthy();
    // The send ends the dictation (an abort: no onend) before the quiet does.
    fireEvent.keyDown(box(), { key: "Enter" });
    await settle();
    expect(micOpen()).toBe(false);
    expect(screen.queryByText(/half a wor/)).toBeNull();
    await advance(2_000);
    expect(screen.queryByText(/half a wor/)).toBeNull();
  });

  it("ignores the navigate phrase with hands-free off", async () => {
    localStorage.setItem(storageKey("mobile.focusHandsFree"), "0");
    await start();
    await hear(`${T} navigate`);
    expect(screen.queryByText(/^Navigation:/)).toBeNull();
    expect(box().value).toBe(`${T} navigate`);
  });

  describe("a project", () => {
    it("asks back, hears yes, and lands on the project's most recently active agent tab", async () => {
      await start();
      await hear(`${T} navigate`);
      await hear("go to project Beta");
      await advance(0);
      // The mic closes while the phone asks.
      expect(said()).toEqual(["Project Beta?"]);
      expect(micOpen()).toBe(false);
      await lineSaid();
      expect(micOpen()).toBe(true);
      expect(openTab).not.toHaveBeenCalled();
      await hear("yes");
      expect(openTab).toHaveBeenCalledTimes(1);
      expect(openTab.mock.calls[0][0].id).toBe("b-2");
      expect(openTab.mock.calls[0][1]).toEqual({ project: "p2" });
      expect(takeLanding("b-2")).toMatchObject({ where: "Claude Code in Beta" });
    });

    it("works in one breath", async () => {
      await start();
      await hear(`${T} navigate go to project Beta`);
      await advance(0);
      expect(said()).toEqual(["Project Beta?"]);
    });

    it("stays open after a no, for another try", async () => {
      await start();
      await hear(`${T} navigate`);
      await hear("go to project Beta");
      await lineSaid();
      await hear("no");
      expect(openTab).not.toHaveBeenCalled();
      expect(screen.getByText(/^Navigation:/)).toBeTruthy();
      await hear("go to project Gamma");
      await advance(0);
      expect(said()).toEqual(["Project Beta?", "Project Gamma?"]);
    });

    it("names no box and no unknown project", async () => {
      await start();
      await hear(`${T} navigate`);
      await hear("go to project Boxy");
      await advance(0);
      expect(said()).toEqual(["Didn't catch that."]);
    });

    it("opens the project screen, after saying so, when it has no agent tab", async () => {
      await start();
      await hear(`${T} navigate`);
      await hear("go to project Gamma");
      await lineSaid();
      await hear("yes");
      await advance(0);
      expect(said().slice(-1)).toEqual(["No agent tab in Gamma"]);
      expect(openProject).not.toHaveBeenCalled();
      await lineSaid();
      expect(openProject).toHaveBeenCalledWith("p3");
      expect(openTab).not.toHaveBeenCalled();
    });

    it("asks again between two close names", async () => {
      host.projects = [
        ...host.projects,
        { id: "p4", label: "North Pole", status: "ok", live_sessions: 0 },
        { id: "p5", label: "North Peak", status: "ok", live_sessions: 0 },
      ];
      await start();
      await hear(`${T} navigate`);
      await hear("go to project North");
      await advance(0);
      expect(said()).toEqual(["North Pole or North Peak?"]);
      await lineSaid();
      await hear("two");
      await advance(0);
      expect(said().slice(-1)).toEqual(["Project North Peak?"]);
    });
  });

  describe("the working, done and waiting tab", () => {
    const row = (id: string, project: string, extra: Partial<ActivityTab>): ActivityTab => ({
      ...agent(id, { label: id }), project_id: project, project_label: project === "p2" ? "Beta" : "Alpha", ...extra,
    });

    it("jumps across projects and goes on to the next one when said again", async () => {
      host.activity.tabs = [
        row("w-1", "p2", { agent_status: "working" }),
        row("w-2", "p1", { agent_status: "working" }),
      ];
      await start();
      await hear(`${T} navigate go to the working tab`);
      expect(openTab).toHaveBeenCalledTimes(1);
      expect(openTab.mock.calls[0][0].id).toBe("w-1");
      expect(openTab.mock.calls[0][1]).toEqual({ project: "p2" });
      await reopen();
      await hear(`${T} navigate go to the working tab`);
      expect(openTab.mock.calls[1][0].id).toBe("w-2");
      await reopen();
      await hear(`${T} navigate go to the working tab`);
      expect(openTab.mock.calls[2][0].id).toBe("w-1");
    });

    it("walks the done tabs, marking each seen so it is not reached twice", async () => {
      host.activity.tabs = [
        row("d-old", "p2", { agent_status: "done", done_at: 10 }),
        row("d-new", "p1", { agent_status: "done", done_at: 90 }),
      ];
      await start();
      await hear(`${T} navigate go to the done tab`);
      expect(openTab.mock.calls[0][0].id).toBe("d-new");
      expect(readSeenDone().map(([id]) => id)).toContain("d-new");
      await reopen();
      await hear(`${T} navigate go to the done tab`);
      expect(openTab.mock.calls[1][0].id).toBe("d-old");
      await reopen();
      await hear(`${T} navigate go to the done tab`);
      await advance(0);
      expect(openTab).toHaveBeenCalledTimes(2);
      expect(said().slice(-1)).toEqual(["Nothing new is done"]);
    });

    it("jumps to a waiting tab, a question first", async () => {
      host.activity.tabs = [
        row("cut", "p1", { agent_status: "interrupted", working_at: 99 }),
        row("ask", "p2", { agent_status: "question", working_at: 5 }),
      ];
      await start();
      await hear(`${T} navigate go to the waiting tab`);
      expect(openTab.mock.calls[0][0].id).toBe("ask");
    });

    it("says so when nothing is there, and stays open", async () => {
      await start();
      await hear(`${T} navigate go to the working tab`);
      await advance(0);
      expect(said()).toEqual(["Nothing is working"]);
      await lineSaid();
      await hear("go to the waiting tab");
      await advance(0);
      expect(said().slice(-1)).toEqual(["Nothing is waiting"]);
      expect(openTab).not.toHaveBeenCalled();
    });

    it("says so when the desktop is not available", async () => {
      host.activity = { tabs: [], desktop_available: false };
      await start();
      await hear(`${T} navigate go to the done tab`);
      await advance(0);
      expect(said()).toEqual(["The desktop is not available"]);
    });

    it("never jumps to the tab it is on", async () => {
      host.activity.tabs = [row("tab-1", "p1", { agent_status: "working" })];
      await start();
      await hear(`${T} navigate go to the working tab`);
      await advance(0);
      expect(openTab).not.toHaveBeenCalled();
      expect(said()).toEqual(["Nothing is working"]);
    });
  });

  describe("a tab of this project", () => {
    it("goes to a tab by its name, its number or its agent", async () => {
      await start();
      await hear(`${T} navigate go to docs`);
      expect(openTab.mock.calls[0][0].id).toBe("tab-2");
      expect(openTab.mock.calls[0][1]).toEqual({ project: "p1" });
      await reopen();
      await hear(`${T} navigate tab 3`);
      // A shell tab: opened, no note for the next screen to read.
      expect(openTab.mock.calls[1][0].id).toBe("sh-1");
      expect(takeLanding("sh-1")).toBeNull();
      await reopen();
      await hear(`${T} navigate codex tab`);
      expect(openTab.mock.calls[2][0].id).toBe("tab-2");
    });

    it("says where it is when the tab is the one it is on", async () => {
      await start();
      await hear(`${T} navigate tab 1`);
      await advance(0);
      expect(openTab).not.toHaveBeenCalled();
      expect(said()).toEqual(["Claude Code in Alpha"]);
      await lineSaid();
      expect(screen.queryByText(/^Navigation:/)).toBeNull();
    });

    it("says there is no such tab", async () => {
      await start();
      await hear(`${T} navigate tab 9`);
      await advance(0);
      expect(said()).toEqual(["No such tab"]);
    });
  });

  describe("what it does not do, and how it ends", () => {
    it("keeps the mode for a command it does not navigate by, and for words it did not catch", async () => {
      await start();
      await hear(`${T} navigate`);
      await hear("open mail");
      await advance(0);
      expect(said()).toEqual(["Not in navigation yet"]);
      await lineSaid();
      await hear("banana smoothie");
      await advance(0);
      expect(said().slice(-1)).toEqual(["Didn't catch that."]);
      expect(box().value).toBe("");
    });

    it("leaves on stop, back to dictation with the start-word gate on", async () => {
      await start();
      await hear(`${T} navigate`);
      await hear("never mind");
      expect(screen.getByText("Navigation closed")).toBeTruthy();
      expect(micOpen()).toBe(true);
      await hear("talk that is not for the agent");
      expect(box().value).toBe("");
      await hear(`${T} add a test`);
      expect(box().value).toBe("add a test");
    });

    it("closes after ten quiet seconds", async () => {
      await start();
      await hear(`${T} navigate`);
      await advance(9_000);
      expect(screen.getByText(/^Navigation:/)).toBeTruthy();
      await advance(1_500);
      expect(screen.getByText("Navigation closed")).toBeTruthy();
      expect(micOpen()).toBe(true);
    });

    it("does not close on a command begun inside the ten seconds, however long it takes to settle", async () => {
      await start();
      await hear(`${T} navigate`);
      await advance(9_500);
      // Said at 9.5 s; the utterance settles 0.8 s later, past the ten.
      await hear("go to project Beta");
      await advance(0);
      expect(screen.queryByText("Navigation closed")).toBeNull();
      expect(said()).toEqual(["Project Beta?"]);
    });

    it("does not count the ten seconds while the phone is speaking", async () => {
      await start();
      await hear(`${T} navigate`);
      await hear("go to project Beta");
      await advance(30_000);
      // Still saying it: the voice has not fallen quiet.
      expect(screen.getByText("Project Beta?")).toBeTruthy();
      await lineSaid();
      await advance(9_000);
      expect(screen.getByText("Project Beta?")).toBeTruthy();
      await advance(1_500);
      expect(screen.getByText("Navigation closed")).toBeTruthy();
    });

    it("ends on a tap of the mic", async () => {
      await start();
      await hear(`${T} navigate`);
      fireEvent.click(screen.getByRole("button", { name: "Stop dictation" }));
      await settle();
      expect(screen.queryByText(/^Navigation:/)).toBeNull();
      expect(screen.getByRole("button", { name: "Dictate" })).toBeTruthy();
    });

    it("shows the lines only, with the mic left open, where the browser cannot speak", async () => {
      vi.stubGlobal("speechSynthesis", undefined);
      Reflect.deleteProperty(window, "speechSynthesis");
      Reflect.deleteProperty(window, "SpeechSynthesisUtterance");
      await start();
      await hear(`${T} navigate`);
      await hear("go to project Beta");
      await advance(0);
      expect(screen.getByText("Project Beta?")).toBeTruthy();
      expect(micOpen()).toBe(true);
      await hear("yes");
      expect(openTab).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps hands-free from reading the held answer or closing the mic while the mode is open", async () => {
    localStorage.setItem(storageKey("mobile.focusReadAloud"), "1");
    await start();
    const first = mic();
    // Sent with "go on": the hands-free wait for this turn begins.
    await hear("fix the login go on");
    expect(box().value).toBe("");
    await hear(`${T} navigate`);
    // The answer lands (the next transcript poll) while the mode is open.
    host.transcript = {
      available: true, version: "2:1", truncated: false,
      entries: [{ kind: "prompt", text: "fix the login", at: "2026-11-09T10:00:00.000Z" }, { kind: "answer", text: "Fixed it.", at: "2026-11-09T10:00:05.000Z" }],
    };
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await settle();
    // Past the turn's settle time: hands-free would close the mic and read by now.
    await advance(2_000);
    expect(screen.getByText("Fixed it.")).toBeTruthy();
    expect(said()).toEqual([]);
    expect(first.aborted).toBe(false);
    expect(screen.getByText(/^Navigation:/)).toBeTruthy();
  });

  it("reads the held answer once navigation ends", async () => {
    localStorage.setItem(storageKey("mobile.focusReadAloud"), "1");
    await start();
    await hear("fix the login go on");
    await hear(`${T} navigate`);
    host.transcript = {
      available: true, version: "2:1", truncated: false,
      entries: [{ kind: "prompt", text: "fix the login", at: "2026-11-09T10:00:00.000Z" }, { kind: "answer", text: "Fixed it.", at: "2026-11-09T10:00:05.000Z" }],
    };
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await settle();
    await advance(2_000);
    expect(said()).toEqual([]);
    await hear("stop");
    await advance(3_000);
    expect(said()).toEqual(["Fixed it."]);
  });

  describe("the landing on the screen a jump opened", () => {
    const entries = (...list: [string, string][]) => list.map(([kind, text], index) => ({ kind, text, at: `2026-11-09T10:00:0${index}.000Z` }));
    const session = (...list: [string, string][]) => ({ available: true, version: "1:1", truncated: false, entries: entries(...list) });
    const land = (where = "Claude Code in Alpha", id = HERE.id) => leaveLanding({ tabId: id, where });
    const mount = async (tab: TabRow = HERE) => {
      render(<Terminal tab={tab} project="p1" back={() => {}} openTab={openTab} openProject={openProject} />);
      await settle();
      await advance(100);
    };

    it("reads the last prompt and the answer to it, then opens the mic with the start-word gate on", async () => {
      host.transcript = session(
        ["prompt", "old question"], ["answer", "Old answer."],
        ["prompt", "Add a clear button. Then test it. And ship it."], ["answer", "Done: the clear button exists."],
      );
      land();
      await mount();
      expect(said()).toEqual(["You asked: Add a clear button. Then test it."]);
      expect(screen.getByText("You asked: Add a clear button. Then test it.")).toBeTruthy();
      // The mic stays closed while the phone talks.
      expect(FakeRecognition.instances).toHaveLength(0);
      await finishSpeech();
      expect(said()).toEqual(["You asked: Add a clear button. Then test it.", "Done: the clear button exists."]);
      expect(FakeRecognition.instances).toHaveLength(0);
      await advance(400);
      expect(FakeRecognition.instances).toHaveLength(1);
      // Dictation, the gate on: talk without the start word is dropped.
      await hear("so about something else");
      expect(box().value).toBe("");
      await hear(`${T} and add a changelog line`);
      expect(box().value).toBe("and add a changelog line");
    });

    it("is read all the same when the screen is mounted twice (a development remount)", async () => {
      host.transcript = session(["prompt", "q"], ["answer", "a"]);
      land();
      render(<StrictMode><Terminal tab={HERE} project="p1" back={() => {}} openTab={openTab} openProject={openProject} /></StrictMode>);
      await settle();
      await advance(100);
      expect(said()).toEqual(["You asked: q"]);
      await finishSpeech();
      await advance(400);
      expect(FakeRecognition.instances).toHaveLength(1);
    });

    it("says there is no answer yet when the tab is still working on the prompt", async () => {
      host.transcript = session(["prompt", "old"], ["answer", "Old answer."], ["prompt", "new one"]);
      land();
      await mount();
      await finishSpeech();
      expect(said()).toEqual(["You asked: new one", "No answer yet"]);
    });

    it("reads every answer after the prompt, up to the last three", async () => {
      host.transcript = session(["prompt", "q"], ["answer", "One."], ["answer", "Two."], ["answer", "Three."], ["answer", "Four."]);
      land();
      await mount();
      await finishSpeech();
      expect(said()).toEqual(["You asked: q", "Two.", "Three.", "Four."]);
    });

    it("lets a spoken \"repeat\" move the reading, as it does on any reading", async () => {
      host.transcript = session(["prompt", "q"], ["answer", "The answer."]);
      land();
      await mount();
      await finishSpeech();
      await advance(400);
      await hear("repeat");
      expect(said().slice(-1)).toEqual(["The answer."]);
    });

    it("says only where it landed with no prompt or without a stored session", async () => {
      host.transcript = session(["answer", "orphan"]);
      land();
      await mount();
      await finishSpeech();
      expect(said()).toEqual(["Claude Code in Alpha"]);
      expect(FakeRecognition.instances).toHaveLength(0);
      await advance(400);
      expect(FakeRecognition.instances).toHaveLength(1);
    });

    it("says only where it landed in the Terminal view", async () => {
      localStorage.setItem(storageKey("mobile.view.claude-code"), "terminal");
      land();
      await mount();
      await finishSpeech();
      expect(said()).toEqual(["Claude Code in Alpha"]);
    });

    it("waits for the transcript, then falls back to the tab's last prompt with no answer to read", async () => {
      let release = () => {};
      host.transcriptHeld = new Promise<void>((resolve) => { release = resolve; });
      land();
      await mount(agent("tab-1", { label: "Fix login", prompts: [{ text: "older" }, { text: "the fallback prompt" }] }));
      await advance(5_000);
      expect(said()).toEqual([]);
      await advance(1_500);
      expect(said()).toEqual(["You asked: the fallback prompt"]);
      await finishSpeech();
      expect(said()).toEqual(["You asked: the fallback prompt", "No answer to read"]);
      await act(async () => { release(); });
    });

    it("drops a landing that is stale, or for another tab", async () => {
      host.transcript = session(["prompt", "q"], ["answer", "a"]);
      leaveLanding({ tabId: HERE.id, where: "x" }, Date.now() - 31_000);
      await mount();
      expect(said()).toEqual([]);
      expect(FakeRecognition.instances).toHaveLength(0);
      land("x", "somewhere-else");
      expect(takeLanding(HERE.id)).toBeNull();
    });

    it("takes the note and does nothing with hands-free off", async () => {
      localStorage.setItem(storageKey("mobile.focusHandsFree"), "0");
      host.transcript = session(["prompt", "q"], ["answer", "a"]);
      land();
      await mount();
      expect(said()).toEqual([]);
      expect(FakeRecognition.instances).toHaveLength(0);
      expect(takeLanding(HERE.id)).toBeNull();
    });

    it("opens the mic as the voice line is tapped, stopping the voice", async () => {
      host.transcript = session(["prompt", "q"], ["answer", "a"]);
      land();
      await mount();
      fireEvent.click(screen.getByRole("button", { name: /^You asked: q/ }));
      await advance(400);
      expect(FakeRecognition.instances).toHaveLength(1);
    });

    it("only shows the lines, and opens the mic, where the browser cannot speak", async () => {
      Reflect.deleteProperty(window, "speechSynthesis");
      Reflect.deleteProperty(window, "SpeechSynthesisUtterance");
      host.transcript = session(["prompt", "q"], ["answer", "a"]);
      land();
      await mount();
      await advance(400);
      expect(FakeRecognition.instances).toHaveLength(1);
    });

    it("keeps a half-dictated draft with the tab it was dictated in", async () => {
      await start();
      await hear("the first half of a prompt");
      expect(box().value).toBe("the first half of a prompt");
      await hear(`${T} navigate go to docs`);
      expect(openTab.mock.calls[0][0].id).toBe("tab-2");
      // The screen is replaced: its draft is flushed to the store under its own tab id.
      cleanupScreen();
      expect(JSON.stringify(Object.values(localStorage))).toContain("the first half of a prompt");
    });
  });
});
