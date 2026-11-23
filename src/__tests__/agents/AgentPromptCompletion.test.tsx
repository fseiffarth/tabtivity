/**
 * The local model's completion of a prompt being typed
 * (`mobile-web/src/terminal/nextPrompt.ts` `usePromptCompletion`, desktop
 * `lib/agents/nextPrompt.ts` `usePromptComplete`, `PromptGhost`): when the
 * backend is asked, what stays shown while the draft moves, and what the
 * desktop sends. The backend command is mocked.
 */
import { createRef } from "react";
import { act, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import {
  NEXT_PROMPT_COMPLETE_BACKOFF_MS,
  NEXT_PROMPT_COMPLETE_MS,
  NEXT_PROMPT_MAX_COMPLETION_CHARS,
  NEXT_PROMPT_MAX_DRAFT_CHARS,
  cleanCompletion,
  completableDraft,
  usePromptCompletion,
  type NextPromptAnswer,
  type PromptCompletionInput,
} from "../../../mobile-web/src/terminal/nextPrompt";
import { usePromptComplete, type PromptCompleteInput } from "../../lib/agents/nextPrompt";
import { PromptGhost } from "../../components/terminal/PromptGhost";
import { useActivityStore } from "../../stores/activity";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore, type TabEntry } from "../../stores/tabs";

const invokeMock = vi.mocked(invoke);
const ok = (text: string | null, model = "qwen3:4b"): NextPromptAnswer => ({ text, status: "ok", model });

function setup(props: Partial<PromptCompletionInput> = {}, answer: (draft: string) => Promise<NextPromptAnswer | null> = () => Promise.resolve(ok(" update the changelog"))) {
  const complete = vi.fn(answer);
  const base: PromptCompletionInput = { enabled: true, draft: "", atEnd: true, complete, ...props };
  const hook = renderHook((input: PromptCompletionInput) => usePromptCompletion(input), { initialProps: base });
  const update = (next: Partial<PromptCompletionInput>) => {
    Object.assign(base, next);
    hook.rerender({ ...base });
  };
  return { complete, hook, update, drafts: () => complete.mock.calls.map(([draft]) => draft) };
}

const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.useFakeTimers();
  invokeMock.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("cleanCompletion / completableDraft", () => {
  it("keeps one inert line and the one space it opens with", () => {
    expect(cleanCompletion(" update the changelog\nand leak")).toBe(" update the changelog");
    expect(cleanCompletion("ate the changelog")).toBe("ate the changelog");
    expect(cleanCompletion("   two\u200b  words\u0007")).toBe(" two words");
    expect(cleanCompletion(" \u001b[31mred\u001b[0m\u202e now")).toBe(" red now");
    expect(cleanCompletion(" \n ")).toBe("");
    expect(cleanCompletion(null)).toBe("");
    expect(cleanCompletion(`x${"y".repeat(500)}`).length).toBe(NEXT_PROMPT_MAX_COMPLETION_CHARS);
  });

  it("completes a draft with a finished word, never a command or a blank last line", () => {
    expect(completableDraft("run the tests and")).toBe(true);
    expect(completableDraft("run ")).toBe(true);
    expect(completableDraft("first line\nsec")).toBe(true);
    expect(completableDraft("run")).toBe(false);
    expect(completableDraft("/model opus now")).toBe(false);
    expect(completableDraft("first line\n")).toBe(false);
    expect(completableDraft("")).toBe(false);
    expect(completableDraft(`a ${"b".repeat(NEXT_PROMPT_MAX_DRAFT_CHARS)}`)).toBe(false);
  });
});

describe("usePromptCompletion", () => {
  it("asks once the typing rests, and shows what the model appends", async () => {
    const { hook, update, drafts } = setup();
    update({ draft: "run the" });
    await advance(NEXT_PROMPT_COMPLETE_MS - 50);
    update({ draft: "run the tests and" });
    await advance(NEXT_PROMPT_COMPLETE_MS - 50);
    expect(drafts()).toEqual([]);
    await advance(50);
    expect(drafts()).toEqual(["run the tests and"]);
    expect(hook.result.current).toEqual({ text: " update the changelog", model: "qwen3:4b", local: true });
  });

  it("keeps the rest while the draft is typed along it, and asks again only once it is used up or left", async () => {
    const { hook, update, drafts } = setup();
    update({ draft: "run the tests and" });
    await advance(NEXT_PROMPT_COMPLETE_MS);
    update({ draft: "run the tests and upd" });
    expect(hook.result.current.text).toBe("ate the changelog");
    await advance(NEXT_PROMPT_COMPLETE_MS * 3);
    expect(drafts()).toHaveLength(1);
    // Taken whole: the next pause asks how it goes on from there.
    update({ draft: "run the tests and update the changelog" });
    expect(hook.result.current.text).toBe("");
    await advance(NEXT_PROMPT_COMPLETE_MS);
    expect(drafts()).toEqual(["run the tests and", "run the tests and update the changelog"]);
    // Left: nothing of the old line shows.
    update({ draft: "run the tests and then stop" });
    expect(hook.result.current.text).toBe("");
  });

  it("asks nothing for a draft not worth completing, a caret inside the text, or while disabled", async () => {
    const { hook, update, drafts } = setup();
    for (const draft of ["run", "/model opus now", "line\n"]) {
      update({ draft });
      await advance(NEXT_PROMPT_COMPLETE_MS * 2);
    }
    update({ draft: "run the tests and", atEnd: false });
    await advance(NEXT_PROMPT_COMPLETE_MS * 2);
    update({ atEnd: true, enabled: false });
    await advance(NEXT_PROMPT_COMPLETE_MS * 2);
    expect(drafts()).toEqual([]);
    // Shown again with the caret at the end: asked, and hidden when it leaves.
    update({ enabled: true });
    await advance(NEXT_PROMPT_COMPLETE_MS);
    expect(hook.result.current.text).toBe(" update the changelog");
    update({ atEnd: false });
    expect(hook.result.current.text).toBe("");
  });

  it("never asks twice about one draft, and an answer for an older draft does not show over a newer one", async () => {
    let resolve: (answer: NextPromptAnswer) => void = () => {};
    const { hook, update, drafts } = setup({}, () => new Promise((done) => { resolve = done; }));
    update({ draft: "run the" });
    await advance(NEXT_PROMPT_COMPLETE_MS);
    const first = resolve;
    update({ draft: "stop the" });
    await advance(NEXT_PROMPT_COMPLETE_MS);
    await act(async () => first(ok(" whole suite")));
    expect(hook.result.current.text).toBe("");
    await advance(NEXT_PROMPT_COMPLETE_MS * 3);
    expect(drafts()).toEqual(["run the", "stop the"]);
    await act(async () => resolve(ok(" server")));
    expect(hook.result.current.text).toBe(" server");
  });

  it("goes quiet for a while once completions are not to be had; a skipped answer does not", async () => {
    const answers: NextPromptAnswer[] = [{ text: null, status: "skipped" }, { text: null, status: "unavailable" }];
    const { update, drafts } = setup({}, () => Promise.resolve(answers.shift() ?? ok(" x")));
    update({ draft: "one two" });
    await advance(NEXT_PROMPT_COMPLETE_MS);
    update({ draft: "one two three" });
    await advance(NEXT_PROMPT_COMPLETE_MS);
    expect(drafts()).toHaveLength(2);
    update({ draft: "one two three four" });
    await advance(NEXT_PROMPT_COMPLETE_MS * 4);
    expect(drafts()).toHaveLength(2);
    await advance(NEXT_PROMPT_COMPLETE_BACKOFF_MS);
    update({ draft: "one two three four five" });
    await advance(NEXT_PROMPT_COMPLETE_MS);
    expect(drafts()).toHaveLength(3);
  });

  it("keeps the offered suggestion's rest while it is typed along, with no model run", async () => {
    const { hook, update, drafts } = setup({ seed: "run the tests", seedModel: "", seedLocal: false });
    // The offer itself goes at the first keystroke (a local one is dropped).
    update({ draft: "run", seed: "" });
    expect(hook.result.current).toEqual({ text: " the tests", model: "", local: false });
    update({ draft: "run the t" });
    expect(hook.result.current.text).toBe("ests");
    await advance(NEXT_PROMPT_COMPLETE_MS * 3);
    expect(drafts()).toEqual([]);
    // Leaving it asks the model.
    update({ draft: "run the server" });
    expect(hook.result.current.text).toBe("");
    await advance(NEXT_PROMPT_COMPLETE_MS);
    expect(drafts()).toEqual(["run the server"]);
  });
});

describe("usePromptComplete — the desktop's ask", () => {
  const tab: TabEntry = { key: "agent-1", label: "Codex", cmd: "codex", cwd: "/p", kind: "agent", sessionId: "launch-1", launchedAt: 1000 };
  const input = (props: Partial<PromptCompleteInput> = {}): PromptCompleteInput => ({ scope: "p", tab, cwd: "/p", visible: true, draft: "run the tests and", atEnd: true, ...props });
  const asks = () => invokeMock.mock.calls.filter(([command]) => command === "agent_next_prompt");

  beforeEach(() => {
    invokeMock.mockResolvedValue(ok(" update the changelog"));
    useSettingsStore.setState({ settings: null });
    useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [tab] } }));
    useActivityStore.setState({ busyByTab: {} });
  });

  it("sends the tab's identity, the phase and the draft — never a model", async () => {
    const hook = renderHook((props: PromptCompleteInput) => usePromptComplete(props), { initialProps: input() });
    await advance(NEXT_PROMPT_COMPLETE_MS);
    expect(asks()).toHaveLength(1);
    expect(asks()[0][1]).toEqual(expect.objectContaining({ agent: "codex", sessionId: "launch-1", phase: "complete", draft: "run the tests and" }));
    expect(asks()[0][1]).not.toHaveProperty("model");
    expect(hook.result.current.text).toBe(" update the changelog");
  });

  it("asks nothing with the switch off, a hidden composer, or a local-model agent tab at work", async () => {
    useSettingsStore.setState({ settings: { prompt_autocomplete: false } as never });
    renderHook(() => usePromptComplete(input()));
    renderHook(() => usePromptComplete(input({ visible: false })));
    await advance(NEXT_PROMPT_COMPLETE_MS * 2);
    expect(asks()).toHaveLength(0);

    const local: TabEntry = { key: "local-1", label: "Local", cmd: "opencode", cwd: "/p", kind: "local_agent" };
    act(() => {
      useSettingsStore.setState({ settings: null });
      useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [tab, local] } }));
      useActivityStore.setState({ busyByTab: { "p:local-1": true } });
    });
    const hook = renderHook(() => usePromptComplete(input()));
    await advance(NEXT_PROMPT_COMPLETE_MS * 2);
    expect(asks()).toHaveLength(0);
    expect(hook.result.current.text).toBe("");
  });
});

describe("PromptGhost", () => {
  it("repeats the typed text unseen and draws the rest after it, out of the reader's way", () => {
    const box = createRef<HTMLTextAreaElement>();
    const { container } = render(<div><textarea ref={box} defaultValue="run the" /><PromptGhost box={box} typed="run the" rest=" tests" /></div>);
    const layer = container.querySelector(".prompt-ghost");
    expect(layer?.getAttribute("aria-hidden")).toBe("true");
    expect(layer?.querySelector(".prompt-ghost-typed")?.textContent).toBe("run the");
    expect(layer?.querySelector(".prompt-ghost-rest")?.textContent).toBe(" tests");
  });
});
