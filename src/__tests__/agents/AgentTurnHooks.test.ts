/**
 * The agent's own hooks as the authority for a tab's working / decision /
 * finished marks (`noteAgentTurn`, fed by the backend's `agent-turn` event),
 * and the byte heuristic that stays underneath them: for agents with no hooks,
 * and as the net under a verdict that outlived its turn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _clearPtyActivityForTest,
  agentDeliveryReady,
  attentionStateClass,
  agentDeliveryTurn,
  isInterruptInput,
  noteAgentResting,
  noteAgentSessionStart,
  noteAgentTurn,
  notePtyOutput,
  notePtySpawn,
  noteTurnCutOff,
  noteUserInput,
  useActivityStore,
} from "../../stores/activity";
import { useTabsStore } from "../../stores/tabs";

const PTY = "proj-a:agent-1";

function seedAgentTab(looked: boolean) {
  useTabsStore.setState({
    tabsByScope: { "proj-a": [{ key: "agent-1", label: "Codex", cmd: "codex", cwd: "/proj", kind: "agent" }] },
    scope: "proj-a",
    layoutByScope: looked
      ? { "proj-a": { type: "group", id: "g-a", tabKeys: ["agent-1"], activeKey: "agent-1" } }
      : {},
    detachedGroupsByScope: {},
  });
}

const state = () => useActivityStore.getState();
const busy = () => state().busyByTab[PTY] ?? false;
const attention = () => state().attentionByTab[PTY];

/** Codex 0.154 at work: a braille spinner cell every 150 ms, the terminal
 *  title on the same timer, and ONE digit of its "Working (12s)" timer once a
 *  second — the only visible text that changes while the model thinks. */
function codexWorks(ms: number) {
  for (let t = 0; t < ms; t += 150) {
    vi.advanceTimersByTime(150);
    notePtyOutput(PTY, "\x1b]0;⠋ Codex\x07\x1b[16;10H\x1b[38;2;90;90;90m⠉\x1b[0m");
    if (Math.round(t / 150) % 7 === 0) notePtyOutput(PTY, `\x1b[12;13H${Math.floor(t / 1000)}`);
  }
}

describe("activity store — hook verdicts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _clearPtyActivityForTest();
    seedAgentTab(false);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps automation blocked when the display falls back from a silent working hook", () => {
    expect(agentDeliveryReady(PTY, 3000)).toBe(true);
    noteUserInput(PTY);
    noteAgentTurn(PTY, "working");
    vi.advanceTimersByTime(11 * 60_000);
    state().recompute();
    expect(agentDeliveryTurn(PTY)?.state).toBe("working");
    expect(agentDeliveryReady(PTY, 3000)).toBe(false);
    noteAgentTurn(PTY, "done");
    vi.advanceTimersByTime(2999);
    expect(agentDeliveryReady(PTY, 3000)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(agentDeliveryReady(PTY, 3000)).toBe(true);
    // Focus/read state cannot undo completion, but fresh human input must.
    noteUserInput(PTY);
    expect(agentDeliveryReady(PTY, 3000)).toBe(false);
    notePtySpawn(PTY);
    expect(agentDeliveryTurn(PTY)).toBeUndefined();
  });

  it("stops holding delivery on a keystroke the hooks never confirmed as a prompt", () => {
    // A finished turn, then the user types something and walks away: an
    // arrow key, a draft left in the composer, an Escape. No UserPromptSubmit
    // follows, so no Stop ever will — holding on it held forever, which is how
    // a prompt aimed at an idle tab sat "queued" until it read "missed".
    noteAgentTurn(PTY, "working");
    noteAgentTurn(PTY, "done");
    vi.advanceTimersByTime(5000);
    expect(agentDeliveryReady(PTY, 3000)).toBe(true);
    noteUserInput(PTY);
    expect(agentDeliveryReady(PTY, 3000)).toBe(false);
    vi.advanceTimersByTime(19_000);
    expect(agentDeliveryReady(PTY, 3000)).toBe(false);
    vi.advanceTimersByTime(2_000);
    expect(agentDeliveryReady(PTY, 3000)).toBe(true);
    // A keystroke the hooks DID confirm holds for the whole turn.
    noteUserInput(PTY);
    noteAgentTurn(PTY, "working");
    vi.advanceTimersByTime(5 * 60_000);
    expect(agentDeliveryReady(PTY, 3000)).toBe(false);
  });

  it("lets a hook-free tab be delivered to again once a keystroke's grace has passed", () => {
    // An agent with no hooks (Gemini, Qwen, a custom command) never reports
    // a Stop, so "wait for the agent's own completion" would mean never again
    // after the first keystroke. After the grace the bytes decide — the
    // scheduler's own busy / decision / settle checks.
    noteUserInput(PTY);
    vi.advanceTimersByTime(10_000);
    state().recompute();
    expect(agentDeliveryReady(PTY, 3000)).toBe(false);
    vi.advanceTimersByTime(60_000);
    state().recompute();
    expect(agentDeliveryReady(PTY, 3000)).toBe(true);
  });

  it("marks working on the agent's word alone, and done the moment it stops", () => {
    // No bytes needed: the hook fired UserPromptSubmit.
    noteAgentTurn(PTY, "working");
    expect(busy()).toBe(true);
    expect(attention()).toBeUndefined();
    // Nothing the screen shows in the meantime changes that — not a 100 ms
    // title timer, not a menu that is not quiet yet.
    vi.advanceTimersByTime(5000);
    notePtyOutput(PTY, "\x1b]0;[ . ] Codex\x07");
    state().recompute();
    expect(busy()).toBe(true);

    noteAgentTurn(PTY, "done");
    const doneAt = Date.now();
    expect(busy()).toBe(false);
    // Nobody is looking: the finish is unread.
    expect(attention()).toBe("done");
    expect(state().attentionByScope["proj-a"]).toBe("done");
    expect(state().lastDoneByTab[PTY]).toBe(doneAt);
    expect(state().lastWorkingByTab[PTY]).toBe(doneAt);
    // Silence afterwards books nothing new: a turn finishes once.
    vi.advanceTimersByTime(10_000);
    state().recompute();
    expect(state().lastDoneByTab[PTY]).toBe(doneAt);
  });

  it("holds no unread finish for a tab that is on screen, and none once it is looked at", () => {
    seedAgentTab(true);
    state().recompute(); // stamps "seen" for the visible tab
    vi.advanceTimersByTime(300);
    noteAgentTurn(PTY, "working");
    noteAgentTurn(PTY, "done");
    expect(attention()).toBeUndefined();
    expect(state().lastDoneByTab[PTY]).toBe(Date.now());

    // Finished while the user was away, then read.
    seedAgentTab(false);
    vi.advanceTimersByTime(300);
    noteAgentTurn(PTY, "working");
    noteAgentTurn(PTY, "done");
    expect(attention()).toBe("done");
    state().clearAttention(PTY);
    state().recompute();
    expect(attention()).toBeUndefined();
  });

  it("reads a permission notice as a decision, watched or not, until the user answers", () => {
    seedAgentTab(true);
    noteAgentTurn(PTY, "working");
    noteAgentTurn(PTY, "decision");
    expect(busy()).toBe(false);
    expect(attention()).toBe("decision");
    expect(state().lastDoneByTab[PTY]).toBe(Date.now());
    // Looking does not answer it.
    state().clearAttention(PTY);
    state().recompute();
    expect(attention()).toBe("decision");
    // Typing does: the verdict retires and the bytes speak until the next hook
    // (a finished tool, or Stop) — here the agent resumes and its tool ends.
    noteUserInput(PTY);
    state().recompute();
    expect(attention()).toBeUndefined();
    expect(busy()).toBe(false);
    noteAgentTurn(PTY, "working");
    expect(busy()).toBe(true);
  });

  it("lets a quiet approval menu on screen outrank a working verdict (Codex has no notice hook)", () => {
    noteAgentTurn(PTY, "working");
    notePtyOutput(
      PTY,
      "Would you like to run the following command?\r\n› 1. Yes, just this once\r\n  2. No, and tell Codex what to do\r\n",
    );
    vi.advanceTimersByTime(700); // past DECISION_QUIET_MS
    state().recompute();
    expect(attention()).toBe("decision");
    expect(busy()).toBe(false);
    expect(state().statusTabsByScope["proj-a"]).toEqual([{ key: "agent-1", state: "needs-decision" }]);
  });

  it("reads no question into a finished turn whose reply quotes a menu", () => {
    // The agent's last reply showed a diff of the classifier itself; Stop
    // then fired. The turn is over, so the quoted menu is prose, not a prompt.
    noteAgentTurn(PTY, "working");
    notePtyOutput(
      PTY,
      '  24 -  // "❯ Yes" / "❯ Allow" — a binary confirmation\r\n' +
        "The menu looks like:\r\n❯ 1. Yes\r\n  2. No, and tell Claude what to do differently\r\n",
    );
    noteAgentTurn(PTY, "done");
    vi.advanceTimersByTime(700); // past DECISION_QUIET_MS
    state().recompute();
    expect(attention()).toBe("done");
    expect(state().statusTabsByScope["proj-a"]).toEqual([{ key: "agent-1", state: "finished" }]);
  });

  it("retires a working verdict on an interrupt key, and on nothing else typed", () => {
    noteAgentTurn(PTY, "working");
    noteUserInput(PTY); // queuing the next prompt
    noteUserInput(PTY);
    state().recompute();
    expect(busy()).toBe(true);
    expect(isInterruptInput("\x1b[A")).toBe(false); // an arrow key is not bare
    expect(isInterruptInput("\x1b")).toBe(true);
    expect(isInterruptInput("\x03")).toBe(true);
    noteUserInput(PTY, true);
    state().recompute();
    // Back on the bytes, which show nothing sustained — and the cut-off turn
    // is marked as such rather than going quiet like a finished one.
    expect(busy()).toBe(false);
    expect(attention()).toBe("interrupted");
  });

  it("marks a turn cut off mid-work interrupted until the agent's next turn", () => {
    noteUserInput(PTY);
    noteAgentTurn(PTY, "working");
    noteUserInput(PTY, true);
    state().recompute();
    expect(attention()).toBe("interrupted");
    expect(state().statusTabsByScope["proj-a"]).toEqual([{ key: "agent-1", state: "interrupted" }]);
    expect(state().statusCountsByScope["proj-a"]).toEqual({ working: 0, decision: 0, done: 0, interrupted: 1 });
    // A state, not a call for attention: the project's rollup does not glow.
    expect(state().attentionByScope["proj-a"]).toBeUndefined();

    // Claude's idle notice a minute later is not a finished turn, typing a
    // draft is not a new one, and looking at the tab does not undo the cut.
    vi.advanceTimersByTime(60_000);
    noteAgentTurn(PTY, "done");
    noteUserInput(PTY);
    state().clearAttention(PTY);
    state().recompute();
    expect(attention()).toBe("interrupted");

    // The next prompt going in is.
    noteAgentTurn(PTY, "working");
    state().recompute();
    expect(attention()).toBeUndefined();
    expect(busy()).toBe(true);
  });

  it("marks an answer-by-Escape to a pending prompt interrupted, but not a cleared composer", () => {
    noteAgentTurn(PTY, "decision");
    noteUserInput(PTY, true);
    state().recompute();
    expect(attention()).toBe("interrupted");

    _clearPtyActivityForTest();
    noteUserInput(PTY);
    noteAgentTurn(PTY, "working");
    noteAgentTurn(PTY, "done");
    noteUserInput(PTY, true); // Ctrl+C on an idle composer clears the line
    state().recompute();
    expect(attention()).toBe("done");

    _clearPtyActivityForTest();
    noteUserInput(PTY, true); // no verdict and nothing on the wire
    state().recompute();
    expect(attention()).toBeUndefined();
  });

  it("drops the interrupted mark when the session ends", () => {
    noteAgentTurn(PTY, "working");
    noteUserInput(PTY, true);
    noteAgentTurn(PTY, "idle");
    state().recompute();
    expect(attention()).toBeUndefined();
  });

  it("starts a tab whose last run died mid-turn out interrupted", () => {
    notePtySpawn(PTY);
    noteTurnCutOff(PTY);
    // The resumed session replays its transcript: not work anybody asked for.
    notePtyOutput(PTY, "resumed conversation\r\n");
    vi.advanceTimersByTime(60_000);
    noteAgentTurn(PTY, "done"); // the idle notice
    state().recompute();
    expect(attention()).toBe("interrupted");
    noteAgentTurn(PTY, "working");
    state().recompute();
    expect(attention()).toBeUndefined();
    noteTurnCutOff("not-a-pty-id");
    expect(state().attentionByTab["not-a-pty-id"]).toBeUndefined();
  });

  it("names the interrupted state for the strips", () => {
    expect(attentionStateClass("interrupted")).toBe(" interrupted");
    expect(attentionStateClass("decision")).toBe(" needs-decision");
    expect(attentionStateClass("done")).toBe(" finished");
    expect(attentionStateClass(null)).toBe("");
  });

  it("drops a working verdict that outlived all paint, and a session's end retires any verdict", () => {
    noteAgentTurn(PTY, "working");
    vi.advanceTimersByTime(19_000);
    notePtyOutput(PTY, "\x1b]0;⠋\x07"); // still painting: the verdict stands
    state().recompute();
    expect(busy()).toBe(true);
    vi.advanceTimersByTime(20_500);
    state().recompute();
    expect(busy()).toBe(false);

    noteAgentTurn(PTY, "done");
    expect(attention()).toBe("done");
    noteAgentTurn(PTY, "idle");
    expect(attention()).toBeUndefined();

    // A respawned tab starts from nothing, whatever its predecessor said.
    noteAgentTurn(PTY, "working");
    expect(busy()).toBe(true);
    notePtySpawn(PTY);
    state().recompute();
    expect(busy()).toBe(false);
  });

  it("never brings back an answered question when a job flip re-reports it", () => {
    // A background shell is running; the agent asks, the user answers "No",
    // and the turn ends with no hook. The record still says `decision`, and
    // the job scan re-sends it when that shell exits.
    noteAgentTurn(PTY, "working", true);
    noteAgentTurn(PTY, "decision", true);
    noteUserInput(PTY);
    noteAgentTurn(PTY, "decision", false, true);
    state().recompute();
    expect(attention()).toBeUndefined();
    expect(agentDeliveryTurn(PTY)?.job).toBe(false);
    // Nor a working turn the user cut off.
    noteAgentTurn(PTY, "working");
    noteUserInput(PTY, true);
    noteAgentTurn(PTY, "working", true, true);
    state().recompute();
    expect(busy()).toBe(false);
    expect(attention()).toBe("interrupted");
    // A verdict that still stands takes the job flag as before.
    noteAgentTurn(PTY, "working");
    noteAgentTurn(PTY, "working", true, true);
    state().recompute();
    expect(state().busyKindByTab[PTY]).toBe("both");
  });

  it("reads no question off the conversation a resumed or reattached agent repaints", () => {
    // Claude's own prompt echo and a reply's numbered list, as a resume or a
    // tmux reattach paints them back onto an idle composer.
    const repaint =
      "❯ continue\r\n⏺ Next steps:\r\n  1. Run the gates\r\n  2. Skip the live check\r\n❯ \r\n";
    noteAgentSessionStart(PTY, "resume");
    notePtyOutput(PTY, repaint);
    vi.advanceTimersByTime(700);
    state().recompute();
    expect(attention()).toBeUndefined();

    _clearPtyActivityForTest();
    noteAgentResting(PTY); // `pty_spawn`: the last run finished its turn
    notePtyOutput(PTY, repaint);
    vi.advanceTimersByTime(700);
    state().recompute();
    expect(attention()).toBeUndefined();

    // A compaction can land mid-turn: it does not silence the screen.
    _clearPtyActivityForTest();
    noteAgentSessionStart(PTY, "compact");
    notePtyOutput(PTY, repaint);
    vi.advanceTimersByTime(700);
    state().recompute();
    expect(attention()).toBe("decision");

    // The next turn reads the screen again: a menu that stalls it is a question.
    _clearPtyActivityForTest();
    noteAgentSessionStart(PTY, "startup");
    noteAgentTurn(PTY, "working");
    notePtyOutput(PTY, "Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\n");
    vi.advanceTimersByTime(700);
    state().recompute();
    expect(attention()).toBe("decision");
  });

  it("reads no question off the screen between an answer and the agent's next hook", () => {
    noteAgentTurn(PTY, "working");
    noteAgentTurn(PTY, "decision");
    noteUserInput(PTY);
    // The screen settles on the conversation, prompt echoes and all.
    notePtyOutput(PTY, "❯ yes, go ahead\r\n⏺ Bash(npm test)\r\n");
    vi.advanceTimersByTime(700);
    state().recompute();
    expect(attention()).toBeUndefined();
    // The tool finished; the agent works on, its spinner painting.
    noteAgentTurn(PTY, "working");
    notePtyOutput(PTY, "✻ Thinking… (3s)");
    state().recompute();
    expect(busy()).toBe(true);
  });

  it("ignores a verdict for an id that is not a PTY, and in a popout", () => {
    noteAgentTurn("not-a-pty-id", "working");
    expect(state().busyByTab["not-a-pty-id"]).toBeUndefined();
  });
});

describe("activity store — the bytes under the verdicts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _clearPtyActivityForTest();
    seedAgentTab(false);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("still reads a menu off a hook-free agent's screen, restored or not", () => {
    // Nothing ever says such an agent is at its composer, so its screen is all
    // there is — the hook-trust menu of a Codex whose hooks are untrusted.
    notePtyOutput(PTY, "Hooks need review\r\n› 1. Review hooks\r\n  2. Trust all and continue\r\n");
    vi.advanceTimersByTime(700);
    state().recompute();
    expect(attention()).toBe("decision");
  });

  it("reads a working Codex — one timer digit a second between spinner frames — as working", () => {
    noteUserInput(PTY);
    vi.advanceTimersByTime(200);
    notePtyOutput(PTY, "› fix the tests\r\n• Working (0s • esc to interrupt)\r\n");
    codexWorks(4050);
    state().recompute();
    expect(busy()).toBe(true);
    // …and as finished once the digits stop, while the idle field keeps painting.
    notePtyOutput(PTY, "Done. Fixed 3 tests.\r\n");
    for (let t = 0; t < 3000; t += 150) {
      vi.advanceTimersByTime(150);
      notePtyOutput(PTY, "\x1b[16;10H⠁\x1b[16;40H⠈⢀");
    }
    state().recompute();
    expect(busy()).toBe(false);
    expect(attention()).toBe("done");
  });

  it("marks a hook-free agent interrupted on Escape mid-work, until it works again", () => {
    noteUserInput(PTY);
    vi.advanceTimersByTime(200);
    notePtyOutput(PTY, "› fix the tests\r\n• Working (0s • esc to interrupt)\r\n");
    codexWorks(4050);
    state().recompute();
    expect(busy()).toBe(true);
    noteUserInput(PTY, true);
    vi.advanceTimersByTime(3000);
    state().recompute();
    expect(busy()).toBe(false);
    expect(attention()).toBe("interrupted");
    // The next prompt's work retires it.
    noteUserInput(PTY);
    vi.advanceTimersByTime(200);
    notePtyOutput(PTY, "› go on\r\n• Working (0s • esc to interrupt)\r\n");
    codexWorks(4050);
    state().recompute();
    expect(busy()).toBe(true);
    expect(attention()).toBeUndefined();
  });

  it("never lights working for the user typing a prompt, however long", () => {
    // Each keystroke's echo lands right behind it; the composer repaints.
    for (let i = 0; i < 40; i += 1) {
      noteUserInput(PTY);
      vi.advanceTimersByTime(30);
      notePtyOutput(PTY, `\x1b[20;${3 + i}Hx`);
      vi.advanceTimersByTime(70);
    }
    state().recompute();
    expect(busy()).toBe(false);
    // The agent answering afterwards still counts as work.
    vi.advanceTimersByTime(200);
    for (let t = 0; t < 1800; t += 300) {
      notePtyOutput(PTY, "✻ Thinking…\r\n");
      vi.advanceTimersByTime(300);
    }
    state().recompute();
    expect(busy()).toBe(true);
  });

  it("bridges a once-a-second text cadence but not a real pause", () => {
    noteUserInput(PTY);
    vi.advanceTimersByTime(200);
    for (let t = 0; t < 3000; t += 1000) {
      notePtyOutput(PTY, `${t / 1000}s`);
      vi.advanceTimersByTime(1000);
      notePtyOutput(PTY, "\x1b]0;spin\x07"); // paint between the digits
      vi.advanceTimersByTime(0);
    }
    notePtyOutput(PTY, "3s");
    state().recompute();
    expect(busy()).toBe(true);
    vi.advanceTimersByTime(1600); // past TEXT_GAP_MS with nothing said
    notePtyOutput(PTY, "\x1b]0;spin\x07"); // painting alone is not working
    state().recompute();
    expect(busy()).toBe(false);
  });
});
