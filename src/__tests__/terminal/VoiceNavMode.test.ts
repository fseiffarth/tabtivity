import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNavMode, NAV_IDLE_MS, type NavLine, type NavModePorts } from "../../../shared/voiceNavMode";
import type { VoiceLists } from "../../lib/voice/voiceCommands";

type Data = { lists: VoiceLists };
type Target = { id: string };

/** The controller over fake ports: lines said are recorded, and each says
 * itself out at once unless `holdSpeech` keeps it going. */
function harness(over: Partial<NavModePorts<Data, Target>> = {}) {
  const lines: (NavLine | null)[] = [];
  const said: string[] = [];
  const events: string[] = [];
  let pending: (() => void) | null = null;
  let holdSpeech = false;
  const ports: NavModePorts<Data, Target> = {
    lang: () => "en",
    timers: { set: (run, ms) => window.setTimeout(run, ms), clear: (id) => window.clearTimeout(id) },
    showLine: (line) => lines.push(line),
    chime: () => events.push("chime"),
    speechOutput: () => true,
    speak: (text, _turn, done) => {
      said.push(text);
      if (holdSpeech) pending = done;
      else queueMicrotask(done);
      return { finish: () => done(), cancel: () => { pending = null; } };
    },
    stopSpeaking: () => events.push("stopSpeaking"),
    onOpen: (open) => events.push(open ? "open" : "closed"),
    listen: () => events.push("listen"),
    leaveToDictation: () => events.push("dictation"),
    dictationHelp: () => {
      events.push("helpReady");
      return () => events.push("helpResume");
    },
    help: { untested: "help.row" },
    load: () => Promise.resolve({
      lists: { projects: [{ id: "p1", name: "Alpha" }, { id: "p2", name: "Beta" }], tabs: [{ id: "t1", name: "Notes" }] },
    }),
    resolve: (command, _data, ctx) => {
      events.push(`resolve:${command.id}`);
      if (command.id === "openProject") ctx.apply({ confirm: { id: command.args.project.id }, say: `Project ${command.args.project.name}?` });
      else if (command.id === "goToTab") ctx.apply({ jump: () => events.push(`jump:${command.args.tab.id}`) });
      else ctx.apply({ say: "Not in navigation yet" });
    },
    confirmed: (target, _data, ctx) => {
      events.push(`confirmed:${target.id}`);
      ctx.apply({ say: "No agent tab in Alpha", then: (nav) => { nav.exit(); events.push("opened"); } });
    },
    ...over,
  };
  const mode = createNavMode(() => ports);
  return {
    mode, lines, said, events,
    hold: () => { holdSpeech = true; },
    release: () => { const done = pending; pending = null; done?.(); },
    line: () => lines[lines.length - 1] ?? null,
  };
}

/** Lets the controller's chain and microtasks run. */
const settle = () => vi.advanceTimersByTimeAsync(0);

describe("the shared navigation mode", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("passes dictation by and opens on the navigate phrase", async () => {
    const h = harness();
    expect(h.mode.route("fix the parser")).toBe(false);
    expect(h.mode.route("Tabby navigate")).toBe(true);
    expect(h.mode.isOpen()).toBe(true);
    expect(h.events).toEqual(["open", "chime"]);
    expect(h.line()?.text).toMatch(/^Navigation: say a project/);
  });

  it("takes a command said in the same breath", async () => {
    const h = harness();
    h.mode.route("Tabby navigate, go to Notes");
    await settle();
    expect(h.events).toContain("resolve:goToTab");
    expect(h.events).toContain("jump:t1");
    // The jump ends the mode first.
    expect(h.events.indexOf("closed")).toBeLessThan(h.events.indexOf("jump:t1"));
    expect(h.mode.isOpen()).toBe(false);
  });

  it("asks a project back and hands a yes to the host", async () => {
    const h = harness();
    h.mode.route("Tabby navigate");
    h.mode.route("project Alpha");
    await settle();
    expect(h.said).toEqual(["Project Alpha?"]);
    expect(h.events).toContain("listen");
    h.mode.route("yes");
    await settle();
    expect(h.events).toContain("confirmed:p1");
    expect(h.said).toEqual(["Project Alpha?", "No agent tab in Alpha"]);
    expect(h.events[h.events.length - 1]).toBe("opened");
    expect(h.mode.isOpen()).toBe(false);
  });

  it("goes back to the open line on a no", async () => {
    const h = harness();
    h.mode.route("Tabby navigate");
    h.mode.route("project Beta");
    await settle();
    h.mode.route("no");
    await settle();
    expect(h.events).not.toContain("confirmed:p2");
    expect(h.line()?.text).toMatch(/^Navigation: say a project/);
    expect(h.mode.isOpen()).toBe(true);
  });

  it("says it did not catch an unknown name and listens again", async () => {
    const h = harness();
    h.mode.route("Tabby navigate");
    h.mode.route("project Zebra");
    await settle();
    expect(h.said).toEqual(["Didn't catch that."]);
    expect(h.mode.isOpen()).toBe(true);
  });

  it("leaves on a stop word, with the closed line, back to dictation", async () => {
    const h = harness();
    h.mode.route("Tabby navigate");
    h.mode.route("stop");
    await settle();
    expect(h.mode.isOpen()).toBe(false);
    expect(h.line()?.text).toBe("Navigation closed");
    expect(h.events.slice(-2)).toEqual(["closed", "dictation"]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.line()).toBeNull();
  });

  it("closes after ten quiet seconds, and words being said restart them", async () => {
    const h = harness();
    h.mode.route("Tabby navigate");
    await vi.advanceTimersByTimeAsync(NAV_IDLE_MS - 1_000);
    h.mode.activity();
    await vi.advanceTimersByTimeAsync(NAV_IDLE_MS - 1_000);
    expect(h.mode.isOpen()).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.mode.isOpen()).toBe(false);
    expect(h.events).toContain("dictation");
  });

  it("holds the quiet timer while a line is spoken", async () => {
    const h = harness();
    h.hold();
    h.mode.route("Tabby navigate");
    h.mode.route("project Zebra");
    await settle();
    await vi.advanceTimersByTimeAsync(NAV_IDLE_MS * 2);
    expect(h.mode.isOpen()).toBe(true);
    h.release();
    await vi.advanceTimersByTimeAsync(NAV_IDLE_MS);
    expect(h.mode.isOpen()).toBe(false);
  });

  it("a click on the line skips the voice", async () => {
    const h = harness();
    h.hold();
    h.mode.route("Tabby navigate");
    h.mode.route("project Zebra");
    await settle();
    const line = h.line();
    expect(line?.text).toBe("Didn't catch that.");
    line?.run?.();
    expect(h.events).toContain("stopSpeaking");
    expect(h.events[h.events.length - 1]).toBe("listen");
  });

  it("drops a continuation once the mode ended", async () => {
    const h = harness();
    h.hold();
    h.mode.route("Tabby navigate");
    h.mode.route("project Zebra");
    await settle();
    expect(h.mode.end()).toBe(true);
    h.release();
    expect(h.events).not.toContain("listen");
    expect(h.mode.end()).toBe(false);
  });

  it("says the help: the dictation commands outside the mode, the navigation ones in it", async () => {
    const h = harness();
    expect(h.mode.route("Tabby help")).toBe(true);
    await settle();
    expect(h.said[0]).toMatch(/End with “go Tabby” to send/);
    expect(h.events).toEqual(["helpReady", "helpResume"]);
    expect(h.line()?.untested).toBe("help.row");
    h.mode.route("Tabby navigate");
    h.mode.route("help");
    await settle();
    expect(h.said[1]).toMatch(/^Say a project/);
    expect(h.mode.isOpen()).toBe(true);
  });

  it("does not open where the host says it cannot", async () => {
    const h = harness({ canOpen: () => false, notHere: "voice.nav.mainOnly" });
    expect(h.mode.route("Tabby navigate")).toBe(true);
    expect(h.mode.isOpen()).toBe(false);
    expect(h.line()?.text).toBe("Navigation works in the main window");
    expect(h.events).not.toContain("chime");
  });

  it("with no speech output only shows a line and goes straight on", async () => {
    const h = harness({ speechOutput: () => false });
    h.mode.route("Tabby navigate");
    h.mode.route("project Zebra");
    await settle();
    expect(h.said).toEqual([]);
    expect(h.line()?.text).toBe("Didn't catch that.");
    expect(h.events[h.events.length - 1]).toBe("listen");
  });

  it("ignores an outcome a host hands back after the mode ended", async () => {
    let late: ((said: string) => void) | null = null;
    const h = harness({
      resolve: (_command, _data, ctx) => new Promise<void>((resolve) => {
        // A host that forgets to check `stale()`: the outcome is dropped anyway.
        late = (said) => { ctx.apply({ say: said }); resolve(); };
      }),
    });
    h.mode.route("Tabby navigate");
    h.mode.route("go to Notes");
    await settle();
    h.mode.end();
    late!("too late");
    await settle();
    expect(h.said).toEqual([]);
  });
});
