/**
 * The agent's markup questions on the desktop (`markup_ask`,
 * `docs/markup_questions_mcp_plan.md` P2): `usePdfMarkup` lists the target
 * tab's open ask for the file on `markup-mcp-changed` while the pane is on
 * screen, `PdfMarkupQuestions` renders it as the reader's question card, and an
 * answer goes out the Submit's way (`queuePromptForTab` + `holdPhonePrompt`).
 * A prompt that cannot be queued reopens the ask with the answer's receipt —
 * the card stays and a retry is taken. The pin placement is pure
 * (`lib/viewers/markupQuestions.ts`) and tested on text runs.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, () => void>(),
  queuePromptForTab: vi.fn(),
  holdPhonePrompt: vi.fn(),
  loadLayer: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: () => void) => {
    mocks.listeners.set(event, handler);
    return () => mocks.listeners.delete(event);
  }),
}));
vi.mock("../../stores/agents/agentPrompts", () => ({ queuePromptForTab: mocks.queuePromptForTab }));
vi.mock("../../lib/agents/phoneHolds", () => ({ holdPhonePrompt: mocks.holdPhonePrompt }));
vi.mock("../../../mobile-web/src/markup/store", async (original) => ({
  ...(await original<typeof import("../../../mobile-web/src/markup/store")>()),
  loadLayer: mocks.loadLayer,
  saveLayer: vi.fn(async () => true),
}));

import { PdfMarkupBar } from "../../components/embed/pdf/PdfMarkupBar";
import { ARRIVAL_GUARD_MS, PdfMarkupQuestions, PdfQuestionPins } from "../../components/embed/pdf/PdfMarkupQuestions";
import { usePdfMarkup } from "../../components/embed/pdf/usePdfMarkup";
import {
  answersOf,
  listMarkupTicks,
  NO_PICK,
  pagePins,
  quoteRects,
  splitRecommended,
  toggleOption,
  toggleOther,
  type MarkupAsk,
  type MarkupQuestion,
} from "../../lib/viewers/markupQuestions";
import type { TextItemBox } from "../../lib/viewers/tex/tex";
import { useActivityStore } from "../../stores/activity";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore, type TabEntry } from "../../stores/tabs";

const PATH = "/home/u/paper/paper.pdf";

const single: MarkupQuestion = {
  question: "Does the arrow move the paragraph or the figure?",
  header: "Arrow",
  options: [{ label: "The paragraph" }, { label: "The figure (Recommended)", description: "Figure 2 goes below it" }],
  multiSelect: false,
  page: 2,
  quote: "as shown in Figure 2",
};
const multi: MarkupQuestion = {
  question: "Which sections get the new term?",
  options: [{ label: "Intro" }, { label: "Methods" }, { label: "Results" }],
  multiSelect: true,
};

function ask(questions: MarkupQuestion[], id = "ask-1"): MarkupAsk {
  return { id, file: "paper/paper.pdf", fileName: "paper.pdf", createdAt: "2026-10-03T12:00:00+02:00", questions };
}

let open: MarkupAsk[] = [];

function agentTab(key: string, scheduleTargetId: string, label: string): TabEntry {
  return { key, label, cmd: "claude", cwd: "/home/u/paper", kind: "agent", scheduleTargetId } as TabEntry;
}

function Harness({ visible = true }: { visible?: boolean }) {
  const markup = usePdfMarkup({
    projectId: "p1",
    scope: "p1",
    path: PATH,
    active: true,
    visible,
    pageCount: 3,
    docSize: 9_000,
    docVersion: 0,
  });
  return (
    <>
      <PdfMarkupBar markup={markup} page={1} onReload={() => {}} onDone={() => {}} />
      <PdfMarkupQuestions questions={markup.questions} pinned={new Set(["ask-1:0"])} />
    </>
  );
}

const calls = (command: string) => mocks.invoke.mock.calls.filter(([name]) => name === command);
const ring = () => act(() => mocks.listeners.get("markup-mcp-changed")?.());

beforeEach(() => {
  open = [];
  mocks.listeners.clear();
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === "file_mtime") return 1_790_000_000;
    if (command === "markup_mcp_list") return open;
    if (command === "markup_mcp_answer") {
      const taken = open.find((entry) => entry.id === args.askId);
      if (!taken) throw "gone";
      open = open.filter((entry) => entry !== taken);
      return { prompt: "My answers to your markup questions on `paper/paper.pdf`:\n1. … → …", receipt: "r-1" };
    }
    if (command === "markup_mcp_dismiss") {
      open = open.filter((entry) => entry.id !== args.askId);
      return null;
    }
    return null;
  });
  mocks.queuePromptForTab.mockReset();
  mocks.queuePromptForTab.mockResolvedValue({ pruned: 0, id: "sched-1" });
  mocks.holdPhonePrompt.mockReset();
  mocks.loadLayer.mockReset();
  mocks.loadLayer.mockResolvedValue(null);
  useTabsStore.setState({ tabsByScope: { p1: [agentTab("t1", "s1", "Claude")] } });
  useActivityStore.setState({ busyByTab: {}, attentionByTab: {} });
  useSettingsStore.setState({ settings: null });
});
afterEach(() => cleanup());

/** A new card takes no clicks for `ARRIVAL_GUARD_MS`: `settle` moves the
 *  clock past that. */
let skew = 0;
const settle = () => { skew += ARRIVAL_GUARD_MS; };
let clock: { mockRestore: () => void } | null = null;
beforeEach(() => {
  skew = 0;
  const real = Date.now.bind(Date);
  clock = vi.spyOn(Date, "now").mockImplementation(() => real() + skew);
});
afterEach(() => clock?.mockRestore());
/** Pick a row once the card has settled, and send it. */
async function answerWith(row: RegExp) {
  const button = await screen.findByRole("button", { name: row });
  settle();
  fireEvent.click(button);
  fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
}

describe("desktop markup questions card", () => {
  it("lists the target tab's ask for this file and renders it as the reader's question card", async () => {
    open = [ask([single])];
    render(<Harness />);
    expect(await screen.findByText(single.question)).toBeTruthy();
    expect(calls("markup_mcp_list")[0][1]).toEqual({ projectId: "p1", scheduleTargetId: "s1", path: PATH });
    expect(screen.getByText("The agent asks about paper.pdf")).toBeTruthy();
    expect(screen.getByText("Arrow")).toBeTruthy();
    // The Recommended mark is a tag beside the label, not part of it.
    const figure = screen.getByRole("button", { name: /The figure/ });
    expect(figure.textContent).toContain("Recommended");
    expect(figure.querySelector(".terminal-reader-recommended")).toBeTruthy();
    expect(screen.getByText("Figure 2 goes below it")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show on page 2" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Other…/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Answer in chat instead" })).toBeTruthy();
  });

  it("a click only picks, even for one single-select question; Send answers delivers it the Submit's way", async () => {
    open = [ask([single])];
    render(<Harness />);
    const figure = await screen.findByRole("button", { name: /The figure/ });
    // A stroke ending on the card as it turns up does nothing.
    fireEvent.click(figure);
    expect(figure.getAttribute("aria-pressed")).toBe("false");
    settle();
    fireEvent.click(figure);
    expect(figure.getAttribute("aria-pressed")).toBe("true");
    expect(calls("markup_mcp_answer")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
    await waitFor(() => expect(mocks.holdPhonePrompt).toHaveBeenCalledWith("sched-1"));
    expect(calls("markup_mcp_answer")[0][1]).toEqual({ projectId: "p1", scheduleTargetId: "s1", askId: "ask-1", answers: [{ options: [1] }] });
    expect(mocks.queuePromptForTab).toHaveBeenCalledWith("p1", "s1", expect.stringMatching(/^My answers to your markup questions/));
    expect(mocks.queuePromptForTab.mock.invocationCallOrder[0]).toBeLessThan(mocks.holdPhonePrompt.mock.invocationCallOrder[0]);
    await waitFor(() => expect(screen.queryByText(single.question)).toBeNull());
    // The answer is a round of its own: the pill follows it.
    expect(screen.getByText("Sent — waiting for the agent")).toBeTruthy();
    expect(calls("markup_mcp_reopen")).toHaveLength(0);
  });

  it("pages through the questions with ‹ › and collects every one before Send answers", async () => {
    open = [ask([single, multi])];
    render(<Harness />);
    const send = (await screen.findByRole("button", { name: "Send answers" })) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    // One question at a time.
    expect(screen.getByText("1 / 2")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Intro/ })).toBeNull();
    const previous = screen.getByRole("button", { name: "Previous question" }) as HTMLButtonElement;
    const next = screen.getByRole("button", { name: "Next question" }) as HTMLButtonElement;
    expect(previous.disabled).toBe(true);
    settle();
    fireEvent.click(screen.getByRole("button", { name: /The paragraph/ }));
    expect(mocks.invoke.mock.calls.some(([command]) => command === "markup_mcp_answer")).toBe(false);
    expect(send.disabled).toBe(true);
    fireEvent.click(next);
    expect(screen.getByText("2 / 2")).toBeTruthy();
    expect(next.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /The paragraph/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Results/ }));
    fireEvent.click(screen.getByRole("button", { name: /Intro/ }));
    expect(screen.getByRole("button", { name: /Intro/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Pick any that apply.")).toBeTruthy();
    // Back again: the first page kept its pick; single-select keeps one row.
    fireEvent.click(previous);
    expect(screen.getByRole("button", { name: /The paragraph/ }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /The figure/ }));
    expect(screen.getByRole("button", { name: /The paragraph/ }).getAttribute("aria-pressed")).toBe("false");
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(mocks.holdPhonePrompt).toHaveBeenCalled());
    expect(calls("markup_mcp_answer")[0][1]).toMatchObject({ answers: [{ options: [1] }, { options: [0, 2] }] });
  });

  it("sends a typed Other… answer", async () => {
    open = [ask([single])];
    render(<Harness />);
    const other = await screen.findByRole("button", { name: /Other…/ });
    settle();
    fireEvent.click(other);
    const field = screen.getByRole("textbox", { name: "Type your answer" });
    const send = screen.getByRole("button", { name: "Send answers" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(field, { target: { value: "  Both, figure first " } });
    fireEvent.click(send);
    await waitFor(() => expect(mocks.holdPhonePrompt).toHaveBeenCalled());
    expect(calls("markup_mcp_answer")[0][1]).toMatchObject({ answers: [{ options: [], other: "Both, figure first" }] });
  });

  it("dismisses with Answer in chat instead", async () => {
    open = [ask([single])];
    render(<Harness />);
    const inChat = await screen.findByRole("button", { name: "Answer in chat instead" });
    settle();
    fireEvent.click(inChat);
    await waitFor(() => expect(screen.queryByText(single.question)).toBeNull());
    expect(calls("markup_mcp_dismiss")[0][1]).toEqual({ projectId: "p1", scheduleTargetId: "s1", askId: "ask-1" });
    expect(mocks.queuePromptForTab).not.toHaveBeenCalled();
  });

  it("keeps the card when the answer cannot be queued: the ask is reopened and a retry is taken", async () => {
    open = [ask([single])];
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "markup_mcp_reopen") {
        open = [ask([single])];
        return null;
      }
      return original(command, args);
    });
    mocks.queuePromptForTab.mockRejectedValueOnce(new Error("Prompt scheduler is not ready"));
    render(<Harness />);
    await answerWith(/The paragraph/);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("The questions are still open");
    expect(calls("markup_mcp_reopen")[0][1]).toEqual({ projectId: "p1", scheduleTargetId: "s1", askId: "ask-1", receipt: "r-1" });
    expect(mocks.holdPhonePrompt).not.toHaveBeenCalled();
    ring();
    const retry = screen.getByRole("button", { name: "Send answers" }) as HTMLButtonElement;
    await waitFor(() => expect(retry.disabled).toBe(false));
    settle();
    fireEvent.click(retry);
    await waitFor(() => expect(mocks.holdPhonePrompt).toHaveBeenCalledWith("sched-1"));
    expect(calls("markup_mcp_answer")).toHaveLength(2);
  });

  it("shows the answer's text when it could neither be queued nor reopened", async () => {
    open = [ask([single])];
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "markup_mcp_reopen") throw "superseded";
      return original(command, args);
    });
    mocks.queuePromptForTab.mockRejectedValueOnce(new Error("Prompt scheduler is not ready"));
    render(<Harness />);
    await answerWith(/The paragraph/);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Paste it into the agent's tab");
    expect(alert.textContent).toContain("My answers to your markup questions");
    await waitFor(() => expect(screen.queryByText(single.question)).toBeNull());
  });

  it("refused answers say why and leave the card", async () => {
    open = [ask([single])];
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "markup_mcp_answer") throw "answered";
      return original(command, args);
    });
    render(<Harness />);
    await answerWith(/The paragraph/);
    expect((await screen.findByRole("alert")).textContent).toContain("they were already answered");
    expect(mocks.queuePromptForTab).not.toHaveBeenCalled();
  });

  it("reads only while the pane is on screen and catches up on show", async () => {
    const { rerender } = render(<Harness visible={false} />);
    await waitFor(() => expect(mocks.listeners.has("markup-mcp-changed")).toBe(true));
    open = [ask([single])];
    ring();
    await act(async () => {});
    expect(calls("markup_mcp_list")).toHaveLength(0);
    rerender(<Harness visible />);
    expect(await screen.findByText(single.question)).toBeTruthy();
    // Withdrawn by the agent: the event takes the card away.
    open = [];
    ring();
    await waitFor(() => expect(screen.queryByText(single.question)).toBeNull());
  });

  it("an open ask reads as the agent asking on the round's pill and holds back Make these changes", async () => {
    open = [ask([single])];
    mocks.loadLayer.mockResolvedValue(null);
    render(<Harness />);
    await screen.findByText(single.question);
    // A round follows an agent seen asking.
    await answerWith(/The paragraph/);
    await waitFor(() => expect(mocks.holdPhonePrompt).toHaveBeenCalled());
    // A round went out but the file did not change: nothing to reload.
    expect(screen.queryByRole("button", { name: "Reload PDF" })).toBeNull();
    open = [ask([single], "ask-2")];
    ring();
    expect(await screen.findByText("The agent asks about your marks — answer below")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Make these changes/ })).toBeNull();
  });
});

describe("an ask waiting while marking is off", () => {
  let seen: ReturnType<typeof usePdfMarkup> | null = null;
  function Idle({ active = false, visible = true }: { active?: boolean; visible?: boolean }) {
    seen = usePdfMarkup({ projectId: "p1", scope: "p1", path: PATH, active, visible, pageCount: 3, docSize: 9_000, docVersion: 0 });
    return null;
  }
  beforeEach(() => {
    seen = null;
    useTabsStore.setState({ tabsByScope: { p1: [agentTab("t1", "s1", "Claude"), agentTab("t2", "s2", "Codex")] } });
    mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "markup_mcp_list") return args.scheduleTargetId === "s2" ? open : [];
      return null;
    });
  });

  it("names the asking tab of the project, whichever is chosen, and only while the pane shows", async () => {
    open = [ask([single])];
    const { rerender } = render(<Idle visible={false} />);
    await waitFor(() => expect(mocks.listeners.has("markup-mcp-changed")).toBe(true));
    await act(async () => {});
    expect(calls("markup_mcp_list")).toHaveLength(0);
    rerender(<Idle />);
    await waitFor(() => expect(seen?.askWaiting).toBe("s2"));
    expect(calls("markup_mcp_list").map(([, args]) => args)).toEqual(
      expect.arrayContaining([
        { projectId: "p1", scheduleTargetId: "s1", path: PATH },
        { projectId: "p1", scheduleTargetId: "s2", path: PATH },
      ]),
    );
    // Answered elsewhere: the event takes the hint away.
    open = [];
    ring();
    await waitFor(() => expect(seen?.askWaiting).toBeNull());
  });

  it("is not read again when the project's tabs change but its agent tabs stay", async () => {
    open = [ask([single])];
    render(<Idle />);
    await waitFor(() => expect(seen?.askWaiting).toBe("s2"));
    const before = calls("markup_mcp_list").length;
    // A relabel (or any other tab's change) hands the hook a new tab list.
    act(() => useTabsStore.setState({ tabsByScope: { p1: [agentTab("t1", "s1", "Claude ✳"), agentTab("t2", "s2", "Codex")] } }));
    await act(async () => {});
    expect(calls("markup_mcp_list")).toHaveLength(before);
    expect(seen?.askWaiting).toBe("s2");
  });

  it("names another tab that asks while marking for the chosen one, and switches to it", async () => {
    open = [ask([single])];
    render(<Idle active />);
    await waitFor(() => expect(seen?.askElsewhere?.scheduleTargetId).toBe("s2"));
    expect(seen?.target?.scheduleTargetId).toBe("s1");
    expect(seen?.askWaiting).toBeNull();
    expect(seen?.questions.asks).toEqual([]);
    act(() => seen?.chooseTarget("s2"));
    await waitFor(() => expect(seen?.questions.asks).toHaveLength(1));
    // Now the chosen tab: no other one asks.
    await waitFor(() => expect(seen?.askElsewhere).toBeNull());
  });
});

describe("question pins", () => {
  const run = (str: string, x: number, y: number, eol = false): TextItemBox => ({ str, x, y, w: str.length * 5, h: 10, ...(eol ? { eol: true } : {}) });
  const items = [run("The results, as shown in", 72, 100, true), run("Figure 2, hold.", 72, 112)];

  it("finds the quote across a line break, else its first words, else nothing", () => {
    const rects = quoteRects(items, 2, "as shown in  Figure 2");
    expect(rects.length).toBe(2);
    expect(rects[0]).toMatchObject({ page: 2, y: 100 });
    expect(quoteRects(items, 2, "The results, as shown in Figure 2, hold firmly and beyond doubt")).not.toEqual([]);
    expect(quoteRects(items, 2, "nowhere on this page")).toEqual([]);
    expect(quoteRects(items, 2, "   ")).toEqual([]);
  });

  it("pins each question of a page at its words or in the top margin", () => {
    const asks = [ask([single, { ...multi, page: 2 }, { ...multi, page: 3, quote: "x" }])];
    const pins = pagePins(asks, 2, items);
    expect(pins.map((pin) => [pin.index, pin.rects.length > 0, pin.slot])).toEqual([[0, true, 0], [1, false, 0]]);
    // Text not read yet: every pin waits in the margin, side by side.
    expect(pagePins(asks, 2, null).map((pin) => pin.slot)).toEqual([0, 1]);
    expect(pagePins(asks, 1, items)).toEqual([]);
  });

  it("a pin click shows its question; the focused one lights its words", () => {
    const onPick = vi.fn();
    const pins = pagePins([ask([single])], 2, items);
    const { container } = render(
      <PdfQuestionPins pins={pins} scale={2} focus={{ askId: "ask-1", index: 0, on: "page", nonce: 1 }} onPick={onPick} />,
    );
    const pin = screen.getByRole("button", { name: "Question 1 — show it in the card" });
    expect(pin.textContent).toBe("?1");
    expect(pin.className).toContain("is-focus");
    expect(container.querySelectorAll(".file-viewer-pdf-search-hit.current").length).toBe(2);
    fireEvent.click(pin);
    expect(onPick).toHaveBeenCalledWith(pins[0]);
  });

  it("a pin's question turns the card to its page", () => {
    const questions = {
      asks: [ask([single, multi])],
      answering: null,
      failure: null,
      dismissFailure: vi.fn(),
      answer: vi.fn(),
      dismiss: vi.fn(),
      focus: null,
      show: vi.fn(),
    };
    const { rerender } = render(<PdfMarkupQuestions questions={questions} pinned={new Set()} />);
    expect(screen.getByText(single.question)).toBeTruthy();
    rerender(
      <PdfMarkupQuestions questions={{ ...questions, focus: { askId: "ask-1", index: 1, on: "card", nonce: 1 } }} pinned={new Set()} />,
    );
    expect(screen.getByText(multi.question)).toBeTruthy();
    expect(screen.queryByText(single.question)).toBeNull();
    expect(screen.getByText("2 / 2")).toBeTruthy();
  });
});

describe("card picks", () => {
  it("builds one answer per question, refusing blanks", () => {
    expect(splitRecommended("Yes (Recommended)")).toEqual({ label: "Yes", recommended: true });
    expect(splitRecommended("Yes")).toEqual({ label: "Yes", recommended: false });
    let pick = toggleOption(multi, NO_PICK, 2);
    pick = toggleOption(multi, pick, 0);
    expect(pick.options).toEqual([0, 2]);
    expect(toggleOption(multi, pick, 2).options).toEqual([0]);
    const other = toggleOther(single, toggleOption(single, NO_PICK, 1));
    expect(other).toEqual({ options: [], other: "" });
    expect(answersOf([single], [other])).toBeNull();
    expect(answersOf([single], [{ ...other, other: " x " }])).toEqual([{ options: [], other: "x" }]);
    expect(answersOf([single, multi], [toggleOption(single, NO_PICK, 0)])).toBeNull();
    expect(answersOf([multi], [{ options: [1], other: "also" }])).toEqual([{ options: [1], other: "also" }]);
  });
});

describe("markup ticks", () => {
  it("lists the target's ticks for a file, keeping only well-formed rows", async () => {
    mocks.invoke.mockImplementationOnce(async () => [
      { round: "k3x9a0b1", page: 2, mark: 1 },
      { round: "k3x9a0b1", page: 0, mark: 1 },
      { round: "k3x9a0b1", page: 1, mark: 1.5 },
      { round: 7, page: 1, mark: 1 },
      null,
      { round: "k3x9a0b1", page: 3, mark: 4, file: "docs/draft.pdf" },
    ]);
    expect(await listMarkupTicks("p1", "s1", PATH)).toEqual([{ round: "k3x9a0b1", page: 2, mark: 1 }, { round: "k3x9a0b1", page: 3, mark: 4 }]);
    expect(mocks.invoke).toHaveBeenLastCalledWith("markup_mcp_ticks", { projectId: "p1", scheduleTargetId: "s1", path: PATH });
    mocks.invoke.mockImplementationOnce(async () => null);
    expect(await listMarkupTicks("p1", "s1")).toEqual([]);
    mocks.invoke.mockImplementationOnce(async () => { throw "Command markup_mcp_ticks not found"; });
    await expect(listMarkupTicks("p1", "s1")).rejects.toBe("Command markup_mcp_ticks not found");
  });
});
