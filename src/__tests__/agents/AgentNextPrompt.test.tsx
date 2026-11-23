/**
 * The local model's next-prompt suggestion (`mobile-web/src/terminal/nextPrompt.ts`,
 * desktop `lib/agents/nextPrompt.ts`): when to warm, when to ask for the final
 * text, and what drops it. The backend command and the phone route are mocked:
 * this is the clients' half of the contract in `docs/next_prompt_plan.md`.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import {
  NEXT_PROMPT_CLAUDE_SETTLE_MS,
  NEXT_PROMPT_FINAL_RETRIES,
  NEXT_PROMPT_RETRY_MS,
  NEXT_PROMPT_SETTLE_MS,
  NEXT_PROMPT_WARM_MS,
  cleanNextPrompt,
  useNextPrompt,
  type NextPromptAnswer,
  type NextPromptInput,
  type NextPromptPhase,
} from "../../../mobile-web/src/terminal/nextPrompt";
import { endedTurnKey, localAgentWorking, nextPromptArgs, useLocalNextPrompt, type LocalNextPromptInput } from "../../lib/agents/nextPrompt";
import { useActivityStore } from "../../stores/activity";
import { useTabsStore, type TabEntry } from "../../stores/tabs";

const invokeMock = vi.mocked(invoke);

const ok = (text: string | null): NextPromptAnswer => ({ text, status: "ok", turnKey: "e1" });

/** `useNextPrompt` with `ask` recorded; `props` overrides the idle defaults. */
function setup(props: Partial<NextPromptInput> = {}, answer: (phase: NextPromptPhase) => Promise<NextPromptAnswer | null> = () => Promise.resolve(ok("run the tests"))) {
  const ask = vi.fn(answer);
  const base: NextPromptInput = {
    enabled: true,
    working: false,
    turnKey: "turn-1",
    progress: 0,
    canWarm: () => true,
    settleMs: NEXT_PROMPT_SETTLE_MS,
    screenSuggestion: "",
    composerEmpty: true,
    ask,
    ...props,
  };
  const hook = renderHook((input: NextPromptInput) => useNextPrompt(input), { initialProps: base });
  const update = (next: Partial<NextPromptInput>) => {
    Object.assign(base, next);
    hook.rerender({ ...base });
  };
  return { ask, hook, update, phases: () => ask.mock.calls.map(([phase]) => phase) };
}

const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.useFakeTimers();
  invokeMock.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("cleanNextPrompt", () => {
  it("keeps one inert line: first line, escapes and control characters cut, quotes trimmed, capped", () => {
    expect(cleanNextPrompt("\"run the tests\"\nand then deploy")).toBe("run the tests");
    expect(cleanNextPrompt("\n\n  \u001b[31mrm -rf /\u001b[0m now\u0007")).toBe("rm -rf / now");
    expect(cleanNextPrompt("abc‮def")).toBe("abcdef");
    expect(cleanNextPrompt("NONE")).toBe("");
    expect(cleanNextPrompt("none.")).toBe("");
    expect(cleanNextPrompt(null)).toBe("");
    const long = cleanNextPrompt("x".repeat(500));
    expect(long.length).toBe(200);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("useNextPrompt — final", () => {
  it("asks once per ended turn after the settle, and shows the text", async () => {
    const { hook, phases, update } = setup();
    expect(hook.result.current).toBe("");
    await advance(NEXT_PROMPT_SETTLE_MS - 1);
    expect(phases()).toEqual([]);
    await advance(1);
    expect(phases()).toEqual(["final"]);
    expect(hook.result.current).toBe("run the tests");
    // A re-render of the same turn asks nothing more.
    update({ progress: 1 });
    await advance(5_000);
    expect(phases()).toEqual(["final"]);
    // The next turn is asked again.
    update({ working: true, turnKey: null });
    expect(hook.result.current).toBe("");
    update({ working: false, turnKey: "turn-2" });
    await advance(NEXT_PROMPT_SETTLE_MS);
    expect(phases().filter((phase) => phase === "final")).toHaveLength(2);
  });

  it("shows nothing for a status other than ok, or a NONE", async () => {
    const { hook } = setup({}, () => Promise.resolve({ text: null, status: "not_running" }));
    await advance(NEXT_PROMPT_SETTLE_MS);
    expect(hook.result.current).toBe("");
    const none = setup({}, () => Promise.resolve(ok("NONE")));
    await advance(NEXT_PROMPT_SETTLE_MS);
    expect(none.hook.result.current).toBe("");
    const failed = setup({}, () => Promise.reject(new Error("no command")));
    await advance(NEXT_PROMPT_SETTLE_MS);
    expect(failed.hook.result.current).toBe("");
  });

  it("asks a skipped final again, a few times, for a transcript that had not caught up with the turn's end", async () => {
    const answers: NextPromptAnswer[] = [{ text: null, status: "skipped" }, { text: null, status: "skipped" }, ok("commit it")];
    const { hook, phases } = setup({}, () => Promise.resolve(answers.shift() ?? ok("commit it")));
    await advance(NEXT_PROMPT_SETTLE_MS);
    expect(phases()).toEqual(["final"]);
    expect(hook.result.current).toBe("");
    await advance(NEXT_PROMPT_RETRY_MS * 2);
    expect(phases()).toEqual(["final", "final", "final"]);
    expect(hook.result.current).toBe("commit it");
    // Never more than the bound, however often it is skipped.
    const skipped = setup({}, () => Promise.resolve({ text: null, status: "skipped" }));
    await advance(NEXT_PROMPT_SETTLE_MS + NEXT_PROMPT_RETRY_MS * (NEXT_PROMPT_FINAL_RETRIES + 3));
    expect(skipped.phases()).toHaveLength(NEXT_PROMPT_FINAL_RETRIES + 1);
  });

  it("on Claude, waits out the settle with no screen suggestion, and its own suggestion replaces it later", async () => {
    const { hook, phases, update } = setup({ settleMs: NEXT_PROMPT_CLAUDE_SETTLE_MS });
    await advance(NEXT_PROMPT_CLAUDE_SETTLE_MS - 100);
    expect(phases()).toEqual([]);
    await advance(100);
    expect(hook.result.current).toBe("run the tests");
    update({ screenSuggestion: "commit this" });
    expect(hook.result.current).toBe("");
    // Gone again, the turn stays dropped: Claude's own won it.
    update({ screenSuggestion: "" });
    await advance(5_000);
    expect(hook.result.current).toBe("");
    expect(phases()).toEqual(["final"]);
  });

  it("never asks when Claude draws its own within the settle", async () => {
    const { phases, update } = setup({ settleMs: NEXT_PROMPT_CLAUDE_SETTLE_MS });
    await advance(800);
    update({ screenSuggestion: "commit this" });
    await advance(5_000);
    expect(phases()).toEqual([]);
  });

  it("drops on the first keystroke and does not come back for that turn", async () => {
    const { hook, phases, update } = setup();
    await advance(NEXT_PROMPT_SETTLE_MS);
    expect(hook.result.current).toBe("run the tests");
    update({ composerEmpty: false });
    expect(hook.result.current).toBe("");
    update({ composerEmpty: true });
    await advance(5_000);
    expect(hook.result.current).toBe("");
    expect(phases()).toEqual(["final"]);
  });

  it("asks nothing for a turn that ends with a draft in the box", async () => {
    const { phases, update } = setup({ composerEmpty: false });
    await advance(5_000);
    update({ composerEmpty: true });
    await advance(5_000);
    expect(phases()).toEqual([]);
  });

  it("drops an answer that lands after a new turn began", async () => {
    let resolve: (answer: NextPromptAnswer) => void = () => {};
    const { hook, update } = setup({}, () => new Promise((done) => { resolve = done; }));
    await advance(NEXT_PROMPT_SETTLE_MS);
    update({ working: true, turnKey: null });
    await act(async () => resolve(ok("stale")));
    update({ working: false, turnKey: "turn-2" });
    expect(hook.result.current).toBe("");
  });

  it("a hidden pane asks nothing, and hiding drops what is shown", async () => {
    const hidden = setup({ enabled: false });
    await advance(10_000);
    hidden.update({ working: true, turnKey: null, progress: 1 });
    await advance(10_000);
    expect(hidden.phases()).toEqual([]);

    const { hook, update } = setup();
    await advance(NEXT_PROMPT_SETTLE_MS);
    expect(hook.result.current).toBe("run the tests");
    update({ enabled: false });
    expect(hook.result.current).toBe("");
  });
});

describe("useNextPrompt — warm", () => {
  it("warms at most every 3 s while the agent works, one in flight, and stops when it is done", async () => {
    let finish: () => void = () => {};
    const { phases, update } = setup({ working: true, turnKey: null }, (phase) =>
      phase === "warm" ? new Promise((done) => { finish = () => done({ text: null, status: "warmed" }); }) : Promise.resolve(ok("x")));
    // A steady stream of changes still warms on the clock, not never.
    for (let i = 1; i <= 6; i += 1) {
      update({ progress: i });
      await advance(500);
    }
    expect(phases()).toEqual(["warm"]);
    // Still in flight: a due warm-up is skipped.
    update({ progress: 6 });
    await advance(NEXT_PROMPT_WARM_MS);
    expect(phases()).toEqual(["warm"]);
    await act(async () => finish());
    update({ progress: 7 });
    await advance(NEXT_PROMPT_WARM_MS);
    expect(phases()).toEqual(["warm", "warm"]);
    await act(async () => finish());
    // Nothing changes: nothing is warmed.
    await advance(NEXT_PROMPT_WARM_MS * 3);
    expect(phases()).toEqual(["warm", "warm"]);
    // The turn ends: a warm-up due is let go.
    update({ progress: 8 });
    update({ working: false, turnKey: "turn-1" });
    await advance(NEXT_PROMPT_WARM_MS);
    expect(phases()).toEqual(["warm", "warm", "final"]);
  });

  it("skips warm-ups where canWarm says no (a local model holds the GPU)", async () => {
    const { phases, update } = setup({ working: true, turnKey: null, canWarm: () => false });
    update({ progress: 1 });
    await advance(NEXT_PROMPT_WARM_MS * 2);
    expect(phases()).toEqual([]);
  });

  it("skips warming a Claude tab whose last turn drew its own suggestion", async () => {
    const { phases, update } = setup({ settleMs: NEXT_PROMPT_CLAUDE_SETTLE_MS, screenSuggestion: "commit this" });
    await advance(NEXT_PROMPT_CLAUDE_SETTLE_MS);
    update({ screenSuggestion: "", working: true, turnKey: null, progress: 1 });
    await advance(NEXT_PROMPT_WARM_MS * 2);
    expect(phases()).toEqual([]);
  });

  it("does not warm a hidden pane", async () => {
    const { phases, update } = setup({ enabled: false, working: true, turnKey: null });
    update({ progress: 1 });
    await advance(NEXT_PROMPT_WARM_MS * 2);
    expect(phases()).toEqual([]);
  });
});

describe("desktop: lib/agents/nextPrompt", () => {
  const codex = { key: "t1", label: "Codex", cmd: "codex", cwd: "/p", kind: "agent", sessionId: "s-1" } as TabEntry;
  const local = { key: "t2", label: "Local", cmd: "opencode", cwd: "/p", kind: "local_agent", localDriver: "opencode" } as TabEntry;

  beforeEach(() => {
    useTabsStore.setState({ tabsByScope: { p: [codex, local] } });
    useActivityStore.setState({ busyByTab: {} });
  });

  it("names a turn by its last prompt and the answer it ends on", () => {
    const prompt = { kind: "prompt" as const, text: "fix it", at: "1" };
    expect(endedTurnKey([])).toBeNull();
    expect(endedTurnKey([prompt])).toBeNull();
    const ended = endedTurnKey([prompt, { kind: "answer", text: "done", at: "2" }]);
    expect(ended).not.toBeNull();
    expect(endedTurnKey([prompt, { kind: "answer", text: "done!", at: "3" }])).not.toBe(ended);
    expect(endedTurnKey([prompt, { kind: "answer", text: "?", blocking: true }])).toBeNull();
  });

  it("asks with the tab's transcript identity and the phase, never a model", () => {
    expect(nextPromptArgs("p", codex, undefined, null, "final")).toEqual({
      agent: "codex", projectId: "p", tabDir: "/p", since: null, sessionId: "s-1", localModel: false, remoteHost: null, phase: "final",
    });
  });

  it("sees a local-model tab at work in any scope", () => {
    expect(localAgentWorking()).toBe(false);
    useActivityStore.setState({ busyByTab: { "p:t1": true } });
    expect(localAgentWorking()).toBe(false);
    useActivityStore.setState({ busyByTab: { "p:t2": true } });
    expect(localAgentWorking()).toBe(true);
  });

  const desktop = (props: Partial<LocalNextPromptInput>) => {
    const base: LocalNextPromptInput = { scope: "p", tab: codex, visible: true, working: true, turnKey: null, progress: 0, screenSuggestion: "", composerEmpty: true, ...props };
    const hook = renderHook((input: LocalNextPromptInput) => useLocalNextPrompt(input), { initialProps: base });
    const update = (next: Partial<LocalNextPromptInput>) => {
      Object.assign(base, next);
      hook.rerender({ ...base });
    };
    return { hook, update };
  };
  const phases = () => invokeMock.mock.calls.filter(([command]) => command === "agent_next_prompt").map(([, args]) => (args as { phase: string }).phase);

  it("warms through agent_next_prompt, then asks the final once", async () => {
    invokeMock.mockImplementation(((_command: string, args: { phase: string }) =>
      Promise.resolve(args.phase === "warm" ? { text: null, status: "warmed" } : ok("run the tests"))) as never);
    const { hook, update } = desktop({});
    update({ progress: 1 });
    await advance(NEXT_PROMPT_WARM_MS);
    expect(phases()).toEqual(["warm"]);
    update({ working: false, turnKey: "turn-1" });
    await advance(NEXT_PROMPT_SETTLE_MS);
    expect(phases()).toEqual(["warm", "final"]);
    expect(hook.result.current).toBe("run the tests");
  });

  it("does not warm while any local-model tab works, nor for a local-model tab itself", async () => {
    invokeMock.mockResolvedValue({ text: null, status: "warmed" });
    useActivityStore.setState({ busyByTab: { "p:t2": true } });
    const other = desktop({});
    other.update({ progress: 1 });
    await advance(NEXT_PROMPT_WARM_MS);
    expect(phases()).toEqual([]);
    other.hook.unmount();

    useActivityStore.setState({ busyByTab: {} });
    const own = desktop({ tab: local });
    own.update({ progress: 1 });
    await advance(NEXT_PROMPT_WARM_MS);
    expect(phases()).toEqual([]);
    // Its turn's end still gets the one cold run.
    invokeMock.mockResolvedValue(ok("go on"));
    own.update({ working: false, turnKey: "turn-1" });
    await advance(NEXT_PROMPT_SETTLE_MS);
    expect(phases()).toEqual(["final"]);
  });

  it("asks nothing for a hidden pane or a tab whose transcript is not read", async () => {
    invokeMock.mockResolvedValue(ok("x"));
    desktop({ visible: false, working: false, turnKey: "turn-1" });
    desktop({ tab: { ...codex, cmd: "bash", kind: "shell" } as TabEntry, working: false, turnKey: "turn-1" });
    await advance(5_000);
    expect(phases()).toEqual([]);
  });
});
