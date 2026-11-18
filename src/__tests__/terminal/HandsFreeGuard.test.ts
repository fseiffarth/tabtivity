import { describe, expect, it } from "vitest";
import { createPickStage, createSendGuard, type GuardClock, type GuardPhase, type VoicePick } from "../../../shared/handsFree";

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

describe("a spoken pick rides the same guard (gap 80)", () => {
  /** A composer as ReaderVoice/useHandsFree wire it: a staged pick counts as
   * the draft, and is applied only when the window closes. */
  function picking() {
    const { clock, advance } = fakeClock();
    const stage = createPickStage<VoicePick>();
    const log: string[] = [];
    const guard = createSendGuard(1000, {
      hasDraft: () => stage.pending() !== null,
      onWindow: () => log.push("chime"),
      onSend: () => {
        const pick = stage.take();
        if (pick) log.push(`answer:${pick.index}`);
      },
      onCancel: () => stage.clear(),
    }, clock, 1500);
    const pick: VoicePick = { key: "dialog-1", index: 1, heard: "2. Blue" };
    /** What a settled utterance does: the pick path, as the callers run it. */
    const hear = (text: string, picks: boolean) => {
      guard.speechStarted();
      stage.heard();
      if (picks) {
        stage.stage(pick);
        guard.settled(text);
        return;
      }
      guard.settled(text);
    };
    return { guard, advance, log, stage, hear };
  }

  it("answers nothing at once: the chime comes first, the answer when the window closes", () => {
    const { advance, log, stage, hear } = picking();
    hear("two", true);
    expect(log).toEqual([]);
    expect(stage.pending()?.heard).toBe("2. Blue");
    advance(1000);
    expect(log).toEqual(["chime"]);
    advance(1499);
    expect(log).toEqual(["chime"]);
    advance(1);
    expect(log).toEqual(["chime", "answer:1"]);
    expect(stage.pending()).toBeNull();
  });

  it("keeps the dialog unanswered when the user says stop in the window", () => {
    const { advance, log, stage, hear } = picking();
    hear("two", true);
    advance(1000);
    hear("stop", false);
    advance(5000);
    expect(log).toEqual(["chime"]);
    expect(stage.pending()).toBeNull();
  });

  it("a stop heard before the chime cancels it, and the stop key does too", () => {
    const a = picking();
    a.hear("two", true);
    a.hear("stop", false);
    a.advance(5000);
    expect(a.log).toEqual([]);
    const b = picking();
    b.hear("two", true);
    b.advance(1000);
    b.stage.clear();
    b.guard.cancel();
    b.advance(5000);
    expect(b.log).toEqual(["chime"]);
  });

  it("other words supersede the pick: nothing is answered", () => {
    const { advance, log, stage, hear } = picking();
    hear("two", true);
    hear("actually something else", false);
    advance(5000);
    expect(log).toEqual([]);
    expect(stage.pending()).toBeNull();
  });
});
