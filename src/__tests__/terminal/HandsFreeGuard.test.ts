import { describe, expect, it } from "vitest";
import { createSendGuard, type GuardClock, type GuardPhase } from "../../../shared/handsFree";

/** A clock the test moves by hand. */
function fakeClock() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const clock: GuardClock = {
    set: (run, ms) => {
      const id = next++;
      timers.set(id, { at: now + ms, run });
      return id;
    },
    clear: (handle) => { timers.delete(handle as number); },
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].run();
    }
    now = until;
  };
  return { clock, advance };
}

function setup(pauseMs = 1000) {
  const { clock, advance } = fakeClock();
  const log: string[] = [];
  const phases: GuardPhase[] = [];
  let draft = "";
  const guard = createSendGuard(pauseMs, {
    hasDraft: () => draft.trim() !== "",
    onWindow: () => log.push("chime"),
    onSend: () => { log.push(`send:${draft}`); draft = ""; },
    onCancel: () => log.push("cancel"),
    onPhase: (phase) => phases.push(phase),
  }, clock, 1500);
  /** What a composer does with a settled segment. */
  const hear = (text: string) => {
    guard.speechStarted();
    if (guard.settled(text) && text) draft = `${draft} ${text}`.trim();
  };
  return { guard, advance, log, phases, hear, draft: () => draft, setDraft: (d: string) => { draft = d; } };
}

describe("the hands-free send guard", () => {
  it("sends only after the pause and the cancel window", () => {
    const s = setup();
    s.hear("fix the login");
    s.advance(999);
    expect(s.log).toEqual([]);
    s.advance(1);
    expect(s.log).toEqual(["chime"]);
    expect(s.guard.phase()).toBe("window");
    s.advance(1499);
    expect(s.log).toEqual(["chime"]);
    s.advance(1);
    expect(s.log).toEqual(["chime", "send:fix the login"]);
    expect(s.guard.phase()).toBe("idle");
  });

  it("opens the window at once at 0 ms, once the text is in the draft", () => {
    const s = setup(0);
    s.hear("first words");
    s.advance(0);
    expect(s.log).toEqual(["chime"]);
    s.advance(1500);
    expect(s.log).toEqual(["chime", "send:first words"]);
  });

  it("never sends an empty draft", () => {
    const s = setup();
    s.guard.speechStarted();
    s.guard.settled("");
    s.advance(10_000);
    expect(s.log).toEqual([]);
  });

  it("holds no pause while speech is open", () => {
    const s = setup();
    s.hear("one");
    s.advance(500);
    s.guard.speechStarted();
    s.advance(5000);
    expect(s.log).toEqual([]);
    s.guard.settled("two");
    s.advance(1000);
    expect(s.log).toEqual(["chime"]);
  });

  it("cancels on a spoken stop inside the window, keeping the draft", () => {
    const s = setup();
    s.hear("deploy it");
    s.advance(1000);
    s.guard.speechStarted();
    expect(s.guard.phase()).toBe("holding");
    // Whisper takes longer than the window to settle "stop": it still counts.
    s.advance(3000);
    expect(s.log).toEqual(["chime"]);
    expect(s.guard.settled("Stop!")).toBe(false);
    expect(s.log).toEqual(["chime", "cancel"]);
    expect(s.draft()).toBe("deploy it");
    s.advance(10_000);
    expect(s.log).toEqual(["chime", "cancel"]);
  });

  it("lets other words said in the window join the draft and start the pause again", () => {
    const s = setup();
    s.hear("deploy it");
    s.advance(1000);
    s.hear("to staging");
    expect(s.guard.phase()).toBe("pausing");
    s.advance(1000);
    s.advance(1500);
    expect(s.log).toEqual(["chime", "chime", "send:deploy it to staging"]);
  });

  it("goes on with the window, without a second chime, after noise", () => {
    const s = setup();
    s.hear("deploy it");
    s.advance(1000);
    s.guard.speechStarted();
    s.guard.settled("");
    expect(s.guard.phase()).toBe("window");
    s.advance(1500);
    expect(s.log).toEqual(["chime", "send:deploy it"]);
  });

  it("drops a stop word said outside the window, and starts no pause", () => {
    const s = setup();
    s.hear("deploy it");
    s.advance(500);
    s.hear("stop");
    expect(s.draft()).toBe("deploy it");
    s.advance(10_000);
    expect(s.log).toEqual([]);
  });

  it("is cancelled by the key or a tap", () => {
    const s = setup();
    s.hear("deploy it");
    s.advance(1000);
    s.guard.cancel();
    s.advance(10_000);
    expect(s.log).toEqual(["chime", "cancel"]);
  });

  it("goes quiet on reset", () => {
    const s = setup();
    s.hear("deploy it go on");
    s.guard.reset();
    s.advance(10_000);
    expect(s.log).toEqual([]);
    expect(s.phases[s.phases.length - 1]).toBe("idle");
  });

  it("sends nothing when the draft was emptied meanwhile", () => {
    const s = setup();
    s.hear("deploy it");
    s.advance(1000);
    s.setDraft("");
    s.advance(1500);
    expect(s.log).toEqual(["chime"]);
  });
});
